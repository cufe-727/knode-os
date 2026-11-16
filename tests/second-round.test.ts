import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { entityKeyKinds } from '../src/graph/normalize.js';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import type { LlmClient } from '../src/llm/client.js';
import { ask } from '../src/search/ask.js';
import { missingTerms, questionWords, SECOND_CHUNKS, secondRound } from '../src/search/second.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../src/store/db.js';

/**
 * docs/design/34 §2: one more retrieval round, from what the first found and
 * without a model call, when the first is thin — a chain question, a named
 * entity nothing came back about, or half the question's words nowhere.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-second-round-'));
let store: Store;

class FixtureEmbedder implements EmbeddingProvider {
  readonly model = 'fixture-v1';
  readonly dimensions = 4;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0, 0, 0]);
  }
}
const embedder = new FixtureEmbedder();

async function addEntity(id: string, name: string, type: string): Promise<void> {
  await store.query(`INSERT INTO entities (id, name, type, mention_count, aliases, description) VALUES ($1, $2, $3, 5, '[]'::jsonb, '')`, [id, name, type]);
  for (const key of entityKeyKinds(name).keys()) {
    await store.query(`INSERT INTO entity_alias_keys (entity_id, alias_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, key]);
  }
}

async function addDoc(id: string, content: string, mentions: string[], vector = [1, 0, 0, 0]): Promise<void> {
  await store.query(`INSERT INTO documents (id, path, root, title, sha256, bytes, status) VALUES ($1, $2, 'docs', $1, $3, 10, 'indexed')`, [id, `raw/docs/${id}.md`, `sha-${id}`]);
  await store.query(`INSERT INTO chunks (id, document_id, seq, content, token_count, tsv) VALUES ($1, $2, 0, $3, 3, to_tsvector('simple', $3))`, [`c-${id}`, id, content]);
  await store.query(`INSERT INTO embeddings (chunk_id, model, embedding) VALUES ($1, $2, $3::${VECTOR_TYPE})`, [`c-${id}`, embedder.model, toVectorLiteral(vector)]);
  await store.query(`INSERT INTO scopes (id, kind, key, sha, status, applied_at) VALUES ($1, 'doc', $2, $3, 'active', now())`, [`s-${id}`, `raw/docs/${id}.md`, `sha-${id}`]);
  for (const e of mentions) {
    await store.query(`INSERT INTO entity_mentions (entity_id, chunk_id, document_id, scope_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [e, `c-${id}`, id, `s-${id}`]);
  }
}

const result = (id: string, content: string) => ({ chunkId: `c-${id}`, documentId: id, path: `raw/docs/${id}.md`, title: id, content, score: 1, signals: {} });

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, '.knode'), { recursive: true });
  store = await Store.open(tmp, embedder.dimensions);
  await store.indexing;
  await addEntity('r-03', 'R-03', 'other');
  await addEntity('fang', 'Fang Jie', 'person');
  await addEntity('orion', 'Orion', 'project');
  await addEntity('atlas', 'Atlas', 'project');
  // a person every weekly report lists: looked further from only through a passage holding a missing word
  for (let i = 1; i <= 20; i++) await addDoc(`week-${i}`, `Weekly report ${i}. Fang Jie reviewed tickets and joined the stand-up.`, ['fang']);
  await addDoc('raised', 'Fang Jie raised risk R-03 about the load-test environment.', ['fang', 'r-03']);
  await addDoc('moved', 'Fang Jie transferred to the Growth team this week.', ['fang']);
  // a spelling merged into Atlas, mentioned nowhere
  await store.query(`INSERT INTO entities (id, name, type, mention_count, aliases, description, canonical_id) VALUES ('atlas-v', 'ATLAS-X', 'project', 1, '[]'::jsonb, '', 'atlas')`);
  // a hub: three hundred documents mention Helios; one says what it decided on the recall, one is nearest the question
  await addEntity('helios', 'Helios', 'organization');
  for (let i = 0; i < 300; i++) await addDoc(`helios-${String(i).padStart(3, '0')}`, `Helios weekly note ${i}: shipments as planned.`, ['helios']);
  await addDoc('helios-zz-recall', 'Helios decided to recall the battery packs of the first batch.', ['helios']);
  await addDoc('helios-zz-near', 'Helios board minutes.', ['helios'], [0, 1, 0, 0]);
  // a project mentioned in two documents only
  await addDoc('orion-1', 'Orion reached its first milestone; Atlas waits on it.', ['orion', 'atlas']);
  await addDoc('orion-2', 'Orion launched in week 32.', ['orion']);
  // a chain's step known only from the passage and claim that lead to it, and a document of its own
  await addEntity('fangjie', '方杰', 'person');
  await addDoc('raised-cn', '方杰提出了R-03。', ['fangjie', 'r-03']);
  await addDoc('fj-move', '方杰本周调到了增长组。', ['fangjie']);
  // another project's budget: the word a lookup about Orion misses, held by a passage that is not Orion's
  await addDoc('atlas-budget', 'The Atlas budget was cut by a fifth.', ['atlas']);
  // a person three documents mention: any passage of theirs is a step further
  await addEntity('r-07', 'R-07', 'other');
  await addEntity('liwei', 'Li Wei', 'person');
  await addDoc('raised7', 'Li Wei raised risk R-07 on the payment gateway.', ['liwei', 'r-07']);
  await addDoc('liwei-move', 'Li Wei moved over to the Growth group.', ['liwei']);
  await addDoc('liwei-duty', 'Li Wei is on call.', ['liwei']);
  // a step known only from a claim: the passage naming R-11 does not name who raised it, the review that does names
  // no entity a mention records, and nothing relates them — no search or graph of the first round reaches Zhao Min
  await addEntity('r-11', 'R-11', 'other');
  await addEntity('zhao', 'Zhao Min', 'person');
  await addDoc('risk11', 'Risk R-11 on the settlement queue was opened at the quarterly review.', ['r-11']);
  await addDoc('review11', 'Minutes of the quarterly review.', []);
  await addDoc('zhao-move', 'Zhao Min moved over to the Billing group.', ['zhao']);
  await addDoc('zhao-duty', 'Zhao Min is on call.', ['zhao']);
  for (const [id, subject, object, statement, doc] of [
    ['cl-raised', 'r-03', 'fang', 'R-03 was raised by Fang Jie', 'raised'],
    ['cl-raised7', 'r-07', 'liwei', 'R-07 was raised by Li Wei', 'raised7'],
    ['cl-raised11', 'r-11', 'zhao', 'R-11 was raised by Zhao Min', 'review11'],
  ]) {
    await store.query(
      `INSERT INTO claims (id, subject_id, object_id, type, statement, status, kind, chunk_id, primary_scope_id, evidence_count, tx_from)
       VALUES ($1, $2, $3, 'risk', $4, 'fact', 'fact', $5, $6, 1, now())`,
      [id, subject, object, statement, `c-${doc}`, `s-${doc}`],
    );
  }
});

afterAll(async () => {
  await store?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the missing words', () => {
  it('are the question\'s words no passage or fact holds, never a piece of grammar or a name it gives', () => {
    const missing = missingTerms('提出风险R-03的人后来负责哪个项目的验收？', ['R-03'], '方杰提出风险R-03');
    expect(missing).toEqual(expect.arrayContaining(['负责', '验收']));
    // grammar, a word held, a back-pointer, what 哪个 asks for
    for (const w of ['的人', '提出', '后来', '项目']) expect(missing).not.toContain(w);
    expect(missingTerms('Which team did Fang Jie transfer to?', ['Fang Jie'], 'Fang Jie raised R-03')).toContain('transfer');
  });

  it('are words the segmenter cuts, not pairs of characters across a word boundary; what an interrogative asks for is no missing word', () => {
    // "度毛" and "家公" straddle two words; 公司 is what 哪家 asks for; 哪里 / 多少 / now / where ask, they are not asked about
    expect(missingTerms('宁德时代三季度毛利率是多少？', ['宁德时代'], '宁德时代第三季度的毛利率为24%')).toEqual([]);
    expect(missingTerms('曾毓群是哪家公司的董事长？', ['曾毓群'], '曾毓群任宁德时代董事长')).toEqual([]);
    expect(missingTerms('CATL的海外工厂在哪里？', ['CATL'], 'CATL的海外工厂位于匈牙利')).toEqual([]);
    expect(missingTerms('Who raised risk R-07, and where is that person now?', ['R-07'], 'Li Wei raised risk R-07')).toEqual([]);
    // counting words, dates and numbers are not what is asked about
    expect(questionWords('宁德时代一共有几个客户？')).toEqual(['宁德', '时代', '客户']);
    expect(questionWords('宁德时代2025年三季度毛利率是多少？')).toEqual(['宁德', '时代', '毛利率']);
  });
});

describe('the second round', () => {
  it('follows a chain from the entity its first round reached, through a passage holding what was missing', async () => {
    const first = [result('raised', 'Fang Jie raised risk R-03 about the load-test environment.')];
    const r = await secondRound(store, 'Who raised risk R-03, and which team did that person transfer to?', {
      named: ['r-03'], contexts: first, facts: [{ subject: 'R-03', object: 'Fang Jie', statement: 'R-03 was raised by Fang Jie' }], chain: true,
    });
    expect(r?.reason.from).toEqual(['Fang Jie']);
    // twenty reports name Fang Jie; only the one that says where he went is taken
    expect(r?.chunks.map((c) => c.path)).toEqual(['raw/docs/moved.md']);
    expect(r?.statements).toBeGreaterThan(0);
  });

  it('looks for a named entity nothing came back about', async () => {
    const r = await secondRound(store, 'What happened to Orion?', { named: ['orion'], contexts: [], facts: [], chain: false });
    expect(r?.reason.uncoveredNamed).toEqual(['Orion']);
    expect(r?.chunks.map((c) => c.path).sort()).toEqual(['raw/docs/orion-1.md', 'raw/docs/orion-2.md']);
    expect(r!.chunks.length).toBeLessThanOrEqual(SECOND_CHUNKS);
  });

  it('takes a named entity as covered when any of its spellings is: a merged spelling absent from the passages is no gap', async () => {
    const r = await secondRound(store, 'Atlas waits on what?', {
      named: ['atlas', 'atlas-v'], contexts: [result('orion-1', 'Orion reached its first milestone; Atlas waits on it.')], facts: [], chain: false,
    });
    expect(r).toBeNull();
  });

  it('gives a chain no second round when its passages and facts hold every word it asks and its step a passage of its own', async () => {
    const r = await secondRound(store, 'Who raised risk R-07, and is that person on call?', {
      named: ['r-07'], contexts: [result('raised7', 'Li Wei raised risk R-07 on the payment gateway.'), result('liwei-duty', 'Li Wei is on call.')],
      facts: [{ subject: 'R-07', object: 'Li Wei', statement: 'R-07 was raised by Li Wei' }], chain: true,
    });
    expect(r).toBeNull();
  });

  it('reads a hub entity\'s passages nearest the question first, or those holding its missing words, within its budget', async () => {
    const nearest = await secondRound(store, 'What did Helios decide about the battery recall?', {
      named: ['helios'], contexts: [], facts: [], chain: false, queryVector: [0, 1, 0, 0], model: embedder.model,
    });
    expect(nearest!.chunks).toHaveLength(SECOND_CHUNKS);
    expect(nearest!.chunks[0].path).toBe('raw/docs/helios-zz-near.md');
    const worded = await secondRound(store, 'What did Helios decide about the battery recall?', { named: ['helios'], contexts: [], facts: [], chain: false });
    expect(worded!.chunks[0].path).toBe('raw/docs/helios-zz-recall.md');
    expect(worded!.chunks.length).toBeLessThanOrEqual(SECOND_CHUNKS);
  });

  it('reads a lookup further only from what it names, and only what holds the word it missed', async () => {
    // Orion is covered; "budget" is held only by an Atlas passage: the round reads Orion's alone, and Orion has none
    const r = await secondRound(store, 'What was the budget of Orion?', {
      named: ['orion'], contexts: [result('orion-2', 'Orion launched in week 32.')], facts: [], chain: false,
    });
    expect(r?.reason.from ?? []).toEqual(['Orion']);
    expect(r?.reason.missingTerms).toEqual(['budget']);
    expect(r?.chunks ?? []).toEqual([]);
    expect(r?.facts ?? []).toEqual([]);
  });

  it('counts no word the knowledge base holds nowhere as missing: the question\'s own framing is no gap', async () => {
    const r = await secondRound(store, 'List the overall gist of what Orion did, roughly.', {
      named: ['orion'], contexts: [result('orion-2', 'Orion launched in week 32.')], facts: [], chain: false,
    });
    expect(r).toBeNull();
  });

  it('gives an ordinary lookup whose passages hold its words no round, however its words split into pairs', async () => {
    const r = await secondRound(store, 'Orion三季度毛利率是多少？', {
      named: ['orion'], contexts: [result('orion-2', 'Orion第三季度的毛利率为24%')], facts: [], chain: false,
    });
    expect(r).toBeNull();
  });

  it('takes neither the passage nor the claim that led to a chain\'s step for the step\'s own, however the claim is worded', async () => {
    for (const fact of [
      { subject: '方杰', object: 'R-03', statement: '方杰提出R-03' },
      { subject: 'R-03', object: '方杰', statement: 'R-03由方杰提出' },
    ]) {
      const r = await secondRound(store, 'R-03是谁提出的？此人现在在哪个组？', {
        named: ['r-03'], contexts: [result('raised-cn', '方杰提出了R-03。')], facts: [fact], chain: true,
      });
      expect(r, fact.statement).not.toBeNull();
      expect(r!.chunks.map((c) => c.path), fact.statement).toContain('raw/docs/fj-move.md');
    }
  });

  it('gives a chain no round when its first round already holds the step\'s own passages and no word is missing', async () => {
    const r = await secondRound(store, 'Who raised risk R-07, and where is that person now?', {
      named: ['r-07'],
      contexts: [result('raised7', 'Li Wei raised risk R-07 on the payment gateway.'), result('liwei-move', 'Li Wei moved over to the Growth group.')],
      facts: [{ subject: 'R-07', object: 'Li Wei', statement: 'R-07 was raised by Li Wei' }], chain: true,
    });
    expect(r).toBeNull();
  });

  it('does not run when the first round holds what the question asks about', async () => {
    const r = await secondRound(store, 'When did Orion launch?', {
      named: ['orion'], contexts: [result('orion-2', 'Orion launched in week 32.')], facts: [], chain: false,
    });
    expect(r).toBeNull();
  });
});

describe('a hub larger than the mention pool', () => {
  beforeAll(async () => {
    // 2,500 passages mention Vega before the two that matter: one nearest the question, one naming its chairman
    await addEntity('vega', 'Vega', 'organization');
    await store.query(`INSERT INTO documents (id, path, root, title, sha256, bytes, status) SELECT 'vega-' || i, 'raw/docs/vega-' || i || '.md', 'docs', 'vega-' || i, 'sha-vega-' || i, 10, 'indexed' FROM generate_series(1, 2500) i`);
    await store.query(`INSERT INTO chunks (id, document_id, seq, content, token_count, tsv) SELECT 'c-vega-' || i, 'vega-' || i, 0, 'Vega weekly note ' || i || ': shipments as planned.', 3, to_tsvector('simple', 'vega weekly note') FROM generate_series(1, 2500) i`);
    await store.query(`INSERT INTO embeddings (chunk_id, model, embedding) SELECT 'c-vega-' || i, $1, $2::${VECTOR_TYPE} FROM generate_series(1, 2500) i`, [embedder.model, toVectorLiteral([1, 0, 0, 0])]);
    await store.query(`INSERT INTO scopes (id, kind, key, sha, status, applied_at) SELECT 's-vega-' || i, 'doc', 'raw/docs/vega-' || i || '.md', 'sha-vega-' || i, 'active', now() FROM generate_series(1, 2500) i`);
    await store.query(`INSERT INTO entity_mentions (entity_id, chunk_id, document_id, scope_id) SELECT 'vega', 'c-vega-' || i, 'vega-' || i, 's-vega-' || i FROM generate_series(1, 2500) i`);
    await addDoc('vega-zz-near', 'Vega board minutes.', ['vega'], [0, 0, 1, 0]);
    await addDoc('vega-zz-chair', 'The chairman of Vega is Lin Qiao.', ['vega']);
  });

  it('ranks the hub\'s passages by the question before cutting: the nearest, else the one holding its missing word', async () => {
    const nearest = await secondRound(store, 'Who is the chairman of Vega?', { named: ['vega'], contexts: [], facts: [], chain: false, queryVector: [0, 0, 1, 0], model: embedder.model });
    expect(nearest!.chunks[0].path).toBe('raw/docs/vega-zz-near.md');
    const worded = await secondRound(store, 'Who is the chairman of Vega?', { named: ['vega'], contexts: [], facts: [], chain: false });
    expect(worded!.chunks.map((c) => c.path)).toContain('raw/docs/vega-zz-chair.md');
  });
});

describe('ask with a second round', () => {
  const llm = { enabled: false } as unknown as LlmClient;
  it('runs no second round for a walked chain whose first round already reached the step', async () => {
    const q = 'Who raised risk R-07, and where is that person now?';
    // routed to the walk, the first round runs the lookup route's graph search as well (docs/design/30 §3), which
    // reaches Li Wei's passages on its own: nothing is missing, so no round, and turning it off changes nothing
    const res = await ask(store, defaultConfig(), embedder, llm, q, { queryVector: [1, 0, 0, 0], k: 1 });
    expect(res.route.kind).toBe('multihop');
    expect(res.contexts.map((c) => c.path)).toContain('raw/docs/liwei-move.md');
    expect(res.route.second).toBeUndefined();
    const off = await ask(store, defaultConfig(), embedder, llm, q, { queryVector: [1, 0, 0, 0], k: 1, second: false });
    expect(off.contexts.map((c) => c.path)).toEqual(res.contexts.map((c) => c.path));
  });

  it('adds a passage the first round lacks, from a step only a claim knew; the workspace switch and the call over it', async () => {
    const q = 'Who raised risk R-11, and where is that person now?';
    const res = await ask(store, defaultConfig(), embedder, llm, q, { queryVector: [1, 0, 0, 0], k: 1 });
    expect(res.route.kind).toBe('multihop');
    expect(res.route.second).toMatchObject({ from: expect.arrayContaining(['Zhao Min']) });
    expect(res.route.second!.chunks).toBeGreaterThan(0);
    expect(res.contexts.map((c) => c.path)).toContain('raw/docs/zhao-move.md');
    const off = await ask(store, defaultConfig(), embedder, llm, q, { queryVector: [1, 0, 0, 0], k: 1, second: false });
    expect(off.route.second).toBeUndefined();
    // the first round alone does not reach it, and what the round added is what turning it off loses
    expect(off.contexts.map((c) => c.path)).not.toContain('raw/docs/zhao-move.md');
    expect(res.contexts.length - off.contexts.length).toBe(res.route.second!.chunks);
    // the workspace's switch, and the call over it
    const config = defaultConfig();
    config.retrieval.router = { ...config.retrieval.router!, secondRound: false };
    expect((await ask(store, config, embedder, llm, q, { queryVector: [1, 0, 0, 0], k: 1 })).route.second).toBeUndefined();
    expect((await ask(store, config, embedder, llm, q, { queryVector: [1, 0, 0, 0], k: 1, second: true })).route.second).toMatchObject({ from: expect.arrayContaining(['Zhao Min']) });
  });
});
