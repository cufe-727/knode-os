import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { entityKeyKinds } from '../src/graph/normalize.js';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import type { ChatMessage, LlmClient } from '../src/llm/client.js';
import { ask } from '../src/search/ask.js';
import { excerptOf, excerptsForQuestion, isListQuestion, quotedTerms } from '../src/search/excerpts.js';
import { factsForQuestion } from '../src/search/facts.js';
import { search } from '../src/search/search.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../src/store/db.js';

/**
 * The facts `ask` lists beside its chunks (src/search/facts.ts): the claims
 * about what the question names, from every document, ranked by how well they
 * match it and spread over their sources — not any eight claims about any
 * entity a retrieved chunk happens to mention.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-ask-facts-'));

class FixtureEmbedder implements EmbeddingProvider {
  readonly model = 'fixture-v1';
  readonly dimensions = 4;
  calls = 0;

  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    return texts.map(() => [1, 0, 0, 0]);
  }
}

const embedder = new FixtureEmbedder();
let store: Store;

async function addDoc(id: string, content: string): Promise<void> {
  await store.query(`INSERT INTO documents (id, path, root, title, sha256, bytes, status) VALUES ($1, $2, 'docs', $1, $3, 10, 'indexed')`, [id, `raw/docs/${id}.md`, `sha-${id}`]);
  await store.query(`INSERT INTO chunks (id, document_id, seq, content, token_count, tsv) VALUES ($1, $2, 0, $3, 3, to_tsvector('simple', $3))`, [`c-${id}`, id, content]);
  await store.query(`INSERT INTO embeddings (chunk_id, model, embedding) VALUES ($1, $2, $3::${VECTOR_TYPE})`, [`c-${id}`, embedder.model, toVectorLiteral([1, 0, 0, 0])]);
  await store.query(`INSERT INTO scopes (id, kind, key, sha, status, applied_at) VALUES ($1, 'doc', $2, $3, 'active', now())`, [`s-${id}`, `raw/docs/${id}.md`, `sha-${id}`]);
}

async function addEntity(id: string, name: string, type = 'organization'): Promise<void> {
  await store.query(`INSERT INTO entities (id, name, type, mention_count, aliases, description) VALUES ($1, $2, $3, 5, '[]'::jsonb, '')`, [id, name, type]);
  for (const key of entityKeyKinds(name).keys()) {
    await store.query(`INSERT INTO entity_alias_keys (entity_id, alias_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, key]);
  }
}

async function addClaim(id: string, subject: string, statement: string, doc: string, extra: { object?: string; status?: string; kind?: string; eventAt?: string; vector?: number[]; chunk?: boolean } = {}): Promise<void> {
  await store.query(
    `INSERT INTO claims (id, subject_id, object_id, type, statement, status, kind, event_at, chunk_id, primary_scope_id, tx_from)
     VALUES ($1, $2, $3, 'event', $4, $5, $6, $7, $8, $9, now())`,
    [id, subject, extra.object ?? null, statement, extra.status ?? 'fact', extra.kind ?? 'fact', extra.eventAt ?? null, extra.chunk === false ? null : `c-${doc}`, `s-${doc}`],
  );
  if (extra.vector) await store.query(`INSERT INTO claim_embeddings (claim_id, model, embedding) VALUES ($1, $2, $3::${VECTOR_TYPE})`, [id, embedder.model, toVectorLiteral(extra.vector)]);
}

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, '.knode'), { recursive: true });
  store = await Store.open(tmp, embedder.dimensions);
  await store.indexing;
  await addEntity('acme', 'Acme Robotics');
  await addEntity('borealis', 'Borealis Logistics');
  await addEntity('weather', 'Monsoon', 'event');
  // twelve documents, each reporting one Acme incident; one about the weather
  for (let i = 1; i <= 12; i++) {
    const doc = `report-${String(i).padStart(2, '0')}`;
    await addDoc(doc, `Weekly report ${i}. Acme Robotics had a warehouse outage in week ${i}. Routine work, meetings and plans for next week.`);
    await addClaim(`inc-${i}`, 'acme', `Acme Robotics had a warehouse outage in week ${i}`, doc, { eventAt: `2026-01-${String(i).padStart(2, '0')}T12:00:00Z` });
    await addClaim(`misc-${i}`, 'acme', `Acme Robotics held its planning meeting in week ${i}`, doc);
  }
  await addDoc('weather', 'The monsoon arrived early this year.');
  await addClaim('rain', 'weather', 'The monsoon arrived early', 'weather');
  // a partner named only as the object of its claims
  await addDoc('contract', 'Borealis Logistics signed a contract.');
  await addClaim('deal', 'borealis', 'Borealis Logistics signed a supply contract with Acme Robotics', 'contract', { object: 'acme' });
  await addClaim('doubt', 'borealis', 'Borealis Logistics may miss its delivery date', 'contract', { status: 'suspected', kind: 'prediction' });
});

afterAll(async () => {
  if (store) await store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('factsForQuestion', () => {
  it('lists the claims about what the question names, from documents the search did not return', async () => {
    const contexts = await search(store, embedder, 'monsoon', { mode: 'keyword', k: 2, track: false });
    expect(contexts.map((c) => c.path)).toEqual(['raw/docs/weather.md']);
    const facts = await factsForQuestion(store, 'Which weeks did Acme Robotics have a warehouse outage?', contexts, { limit: 12 });
    // the outages, one per report, before the meetings that only share the name
    expect(facts.map((f) => f.id).sort()).toEqual(Array.from({ length: 12 }, (_, i) => `inc-${i + 1}`).sort());
    expect(new Set(facts.map((f) => f.path)).size).toBe(12);
    expect(facts[0]).toMatchObject({ subject: 'Acme Robotics', path: expect.stringMatching(/^raw\/docs\/report-\d\d\.md$/), chunkId: expect.stringMatching(/^c-report-/) });
    expect(facts.find((f) => f.id === 'inc-3')?.eventDate).toBe('2026-01-03');
  });

  it('reaches an entity named as the object of a claim', async () => {
    const facts = await factsForQuestion(store, 'Who signed a contract with Acme Robotics?', [], { limit: 3 });
    expect(facts[0].id).toBe('deal');
  });

  it('spreads its picks over the sources before taking more from one', async () => {
    const facts = await factsForQuestion(store, 'What is known about Acme Robotics?', [], { limit: 24 });
    const perSource = new Map<string, number>();
    for (const f of facts) perSource.set(f.path!, (perSource.get(f.path!) ?? 0) + 1);
    expect(perSource.size).toBe(13);
    expect(Math.max(...perSource.values())).toBeLessThanOrEqual(3);
  });

  it('leaves out a plain fact read off a retrieved chunk, and keeps a hedged one', async () => {
    const contexts = await search(store, embedder, 'Borealis contract', { mode: 'keyword', k: 2, track: false });
    expect(contexts.map((c) => c.chunkId)).toContain('c-contract');
    const ids = (await factsForQuestion(store, 'Borealis Logistics contract delivery', contexts, { limit: 30 })).map((f) => f.id);
    expect(ids).toContain('doubt');
    expect(ids).not.toContain('deal');
  });

  it('ranks by the question\'s embedding where claims have one', async () => {
    await addDoc('vectors', 'Notes.');
    await addClaim('near', 'weather', 'Rainfall totals rose', 'vectors', { vector: [0, 1, 0, 0] });
    await addClaim('far', 'weather', 'Flood defences were inspected', 'vectors', { vector: [0, 0, 1, 0] });
    const facts = await factsForQuestion(store, 'Monsoon', [], { limit: 2, queryVector: [0, 1, 0, 0], model: embedder.model });
    expect(facts[0].id).toBe('near');
  });

  it('has nothing to say when the question names nothing and nothing was retrieved', async () => {
    expect(await factsForQuestion(store, 'What is the capital of nowhere?', [])).toEqual([]);
  });
});

describe('list questions', () => {
  beforeAll(async () => {
    // a paper that cites Acme Robotics in passing: no claim is about it
    await addDoc('related-work', 'Related work.\nPrior planners (Acme Robotics, 2025) were tested in depots.\nWe propose a new planner for drones.');
    // a variant of Acme Robotics, and a supplier one relation away, each with a claim
    await addEntity('acme-mk2', 'Acme Robotics Mk2', 'product');
    await addDoc('mk2', 'Mk2 notes.');
    await addClaim('mk2-upgrade', 'acme-mk2', 'Acme Robotics Mk2 shipped with a lidar upgrade', 'mk2');
    await addEntity('vexa', 'Vexa Sensors');
    await addDoc('vexa', 'Vexa notes.');
    await addClaim('vexa-upgrade', 'vexa', 'Vexa Sensors released a lidar upgrade for robot arms', 'vexa');
    await addClaim('vexa-office', 'vexa', 'Vexa Sensors moved its office', 'vexa');
    await store.query(`INSERT INTO relations (id, source_id, target_id, type, description) VALUES ('r-vexa', 'vexa', 'acme', 'supplies', 'Vexa Sensors supplies the lidar of every Acme Robotics product.')`);
    // a relation's evidence sits on the tier-1 scope of the document it was read from
    await store.query(`INSERT INTO scopes (id, kind, key, sha, status, applied_at) VALUES ('t1-vexa', 'tier1', 'raw/docs/vexa.md', 'sha-vexa', 'active', now())`);
    await store.query(`INSERT INTO evidence (kind, target_id, scope_id, extractor, tx_from) VALUES ('relation', 'r-vexa', 't1-vexa', 'test', now())`);
    // a statute: which of its articles mention 注册资本; another law says it too
    await addEntity('company-law', '公司法', 'other');
    await addDoc('statute', '第一条　为了规范公司的组织和行为，制定本法。\n\n第二条　公司章程应当载明下列事项：\n\n（一）公司名称；\n\n（二）公司注册资本；\n\n第三条　公司应当依法纳税。');
    await store.query(`INSERT INTO entity_mentions (entity_id, chunk_id, document_id, scope_id) VALUES ('company-law', 'c-statute', 'statute', 's-statute')`);
    await addDoc('other-law', '第九条　合伙企业的注册资本由合伙人约定。');
  });

  it('tells a question asking for every case from one asking for an answer', () => {
    for (const q of [
      'Which papers build their method on retrieval-augmented generation?',
      'What do these documents say about OpenAI? List every distinct fact.',
      'Which documents disagree about GPT?',
      'How many papers evaluate GPT-5?',
      '在收录的《中华人民共和国公司法》条文中，哪些条文提到了“注册资本”？',
      '提到“担保”的条文一共有几条？',
      '这些材料里关于“证券交易所”都说了些什么？逐条列出每个不同的事实。',
      '按最近一次通过、修正或修订的时间从早到晚，列出收录的这些法律。',
    ]) expect(isListQuestion(q), q).toBe(true);
    for (const q of [
      'Which GitHub repository hosts the FoldAct code?',
      'What three roles do the three LLMs in the T3LLM framework play?',
      '《中华人民共和国证券法》自何时起施行？',
      '陈悦在新公司向谁汇报？',
    ]) expect(isListQuestion(q), q).toBe(false);
    expect(quotedTerms('哪些条文提到了“注册资本”？以及"GitHub"')).toEqual(['注册资本', 'GitHub']);
  });

  it('cuts a chunk to the lines holding the term, a list item behind the line that introduces it', () => {
    const law = '第二条　公司章程应当载明下列事项：\n\n（一）公司名称；\n\n（二）公司注册资本；\n\n第三条　公司应当依法纳税。';
    expect(excerptOf(law, ['注册资本'])).toEqual(['第二条　公司章程应当载明下列事项： … （二）公司注册资本；']);
    const long = `${'Background sentence. '.repeat(30)}We compare against Gemini on every task. ${'More text follows here. '.repeat(30)}`;
    const [w] = excerptOf(long, ['gemini']);
    expect(w).toContain('We compare against Gemini on every task.');
    expect(w.length).toBeLessThan(370);
    expect(w.startsWith('…') && w.endsWith('…')).toBe(true);
    // a name inside another word is not a hit (search's rule, termCount)
    expect(excerptOf('The BiGemini model was visible.', ['gemini'])).toEqual([]);
  });

  it('gives the lines of documents that only cite what the question names', async () => {
    const ex = await excerptsForQuestion(store, 'Which papers compare against Acme Robotics?', [], { names: ['Acme Robotics'] });
    const related = ex.find((e) => e.path === 'raw/docs/related-work.md')!;
    expect(related).toMatchObject({ chunkId: 'c-related-work', excerpt: true });
    expect(related.content).toBe('Prior planners (Acme Robotics, 2025) were tested in depots.');
    // the chunks the search returned are not repeated
    const again = await excerptsForQuestion(store, 'Which papers compare against Acme Robotics?', [related], { names: ['Acme Robotics'] });
    expect(again.map((e) => e.chunkId)).not.toContain('c-related-work');
  });

  it('looks for a quoted term in the documents of the entity the question names', async () => {
    const ex = await excerptsForQuestion(store, '在《公司法》条文中，哪些条文提到了“注册资本”？', [], { names: ['公司法'], namedDocs: ['statute'] });
    expect(ex.map((e) => e.path)).toEqual(['raw/docs/statute.md']);
    expect(ex[0].content).toBe('第二条　公司章程应当载明下列事项： … （二）公司注册资本；');
    // without the named entity's documents, every law that says it
    const all = await excerptsForQuestion(store, '哪些条文提到了“注册资本”？', [], { names: [] });
    expect(all.map((e) => e.path).sort()).toEqual(['raw/docs/other-law.md', 'raw/docs/statute.md']);
  });

  it('keeps to its budget, one document at a time', async () => {
    const ex = await excerptsForQuestion(store, 'Which weeks did Acme Robotics have an outage?', [], { names: ['Acme Robotics'], budget: 200 });
    expect(ex.length).toBeGreaterThanOrEqual(2);
    expect(ex.reduce((n, e) => n + e.content.length, 0)).toBeLessThanOrEqual(200);
    expect(new Set(ex.map((e) => e.path)).size).toBe(ex.length);
    expect(await excerptsForQuestion(store, 'Which weeks?', [], { names: ['Acme Robotics'], budget: 0 })).toEqual([]);
  });

  it('adds relations, variants and neighbours of what a list question names to its facts', async () => {
    const q = 'List every Acme Robotics product upgrade.';
    const facts = await factsForQuestion(store, q, [], { limit: 40, list: true });
    const ids = facts.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['mk2-upgrade', 'vexa-upgrade', 'relation:r-vexa']));
    // a neighbour's claim that says nothing of the question stays out
    expect(ids).not.toContain('vexa-office');
    expect(facts.find((f) => f.id === 'relation:r-vexa')).toMatchObject({
      statement: 'Vexa Sensors supplies Acme Robotics: Vexa Sensors supplies the lidar of every Acme Robotics product.',
      path: 'raw/docs/vexa.md',
      chunkId: null,
    });
    // any other question keeps to the claims about what it names
    const plain = (await factsForQuestion(store, q, [], { limit: 40 })).map((f) => f.id);
    expect(plain).not.toContain('mk2-upgrade');
    expect(plain).not.toContain('relation:r-vexa');
  });
});

describe('ask', () => {
  function recordingLlm(reply: (prompt: string) => string): { llm: LlmClient; prompts: string[] } {
    const prompts: string[] = [];
    const llm = {
      enabled: true,
      complete: async (messages: ChatMessage[]) => {
        const prompt = messages.map((m) => m.content).join('\n');
        prompts.push(prompt);
        return reply(prompt);
      },
    } as unknown as LlmClient;
    return { llm, prompts };
  }

  it('numbers the facts on from the chunks, with their date and source, and cites them by that number', async () => {
    let week = 0;
    const { llm, prompts } = recordingLlm((prompt) => {
      // the first outage listed as a fact: one whose report the search did not return
      const m = /\[(\d+)\] \[fact\] Acme Robotics had a warehouse outage in week (\d+) /.exec(prompt)!;
      week = Number(m[2]);
      return `Week ${week} [${m[1]}].\n{"citations":[${m[1]}],"gaps":[]}`;
    });
    const before = embedder.calls;
    const res = await ask(store, defaultConfig(), embedder, llm, 'Which weeks did Acme Robotics have a warehouse outage?');
    // one embedding serves the search and the facts
    expect(embedder.calls).toBe(before + 1);
    const report = `report-${String(week).padStart(2, '0')}`;
    expect(prompts[0]).toContain(`[fact] Acme Robotics had a warehouse outage in week ${week} (2026-01-${String(week).padStart(2, '0')}) — raw/docs/${report}.md`);
    // the search did not return that report; a list question gets its line as an excerpt
    expect(res.contexts.filter((c) => !c.excerpt).map((c) => c.path)).not.toContain(`raw/docs/${report}.md`);
    expect(prompts[0]).toMatch(/\(raw\/docs\/report-\d\d\.md, excerpt\)\nWeekly report \d+\. Acme Robotics had a warehouse outage/);
    expect(res.answer).toBe(`Week ${week} [${res.citations[0].ref}].`);
    expect(res.citations).toEqual([{ ref: expect.any(Number), path: `raw/docs/${report}.md`, chunkId: `c-${report}` }]);
    expect(res.citations[0].ref).toBeGreaterThan(res.contexts.length);
  });
});
