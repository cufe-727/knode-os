import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { entityKeyKinds } from '../src/graph/normalize.js';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import type { ChatMessage, LlmClient } from '../src/llm/client.js';
import { ask } from '../src/search/ask.js';
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
    expect(res.contexts.map((c) => c.path)).not.toContain(`raw/docs/${report}.md`);
    expect(res.answer).toBe(`Week ${week} [${res.citations[0].ref}].`);
    expect(res.citations).toEqual([{ ref: expect.any(Number), path: `raw/docs/${report}.md`, chunkId: `c-${report}` }]);
    expect(res.citations[0].ref).toBeGreaterThan(res.contexts.length);
  });
});
