import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { entityKeyKinds } from '../src/graph/normalize.js';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import type { LlmClient } from '../src/llm/client.js';
import { ask } from '../src/search/ask.js';
import { missingTerms, SECOND_CHUNKS, secondRound } from '../src/search/second.js';
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

async function addDoc(id: string, content: string, mentions: string[]): Promise<void> {
  await store.query(`INSERT INTO documents (id, path, root, title, sha256, bytes, status) VALUES ($1, $2, 'docs', $1, $3, 10, 'indexed')`, [id, `raw/docs/${id}.md`, `sha-${id}`]);
  await store.query(`INSERT INTO chunks (id, document_id, seq, content, token_count, tsv) VALUES ($1, $2, 0, $3, 3, to_tsvector('simple', $3))`, [`c-${id}`, id, content]);
  await store.query(`INSERT INTO embeddings (chunk_id, model, embedding) VALUES ($1, $2, $3::${VECTOR_TYPE})`, [`c-${id}`, embedder.model, toVectorLiteral([1, 0, 0, 0])]);
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
  // a project mentioned in two documents only
  await addDoc('orion-1', 'Orion reached its first milestone; Atlas waits on it.', ['orion', 'atlas']);
  await addDoc('orion-2', 'Orion launched in week 32.', ['orion']);
  // a person three documents mention: any passage of theirs is a step further
  await addEntity('r-07', 'R-07', 'other');
  await addEntity('liwei', 'Li Wei', 'person');
  await addDoc('raised7', 'Li Wei raised risk R-07 on the payment gateway.', ['liwei', 'r-07']);
  await addDoc('liwei-move', 'Li Wei moved over to the Growth group.', ['liwei']);
  await addDoc('liwei-duty', 'Li Wei is on call.', ['liwei']);
  for (const [id, subject, object, statement, doc] of [
    ['cl-raised', 'r-03', 'fang', 'R-03 was raised by Fang Jie', 'raised'],
    ['cl-raised7', 'r-07', 'liwei', 'R-07 was raised by Li Wei', 'raised7'],
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
    const missing = missingTerms('提出风险R-03的人后来调到了哪个组？', ['R-03'], '方杰提出风险R-03');
    expect(missing).toContain('调到');
    expect(missing).not.toContain('的人');
    expect(missing).not.toContain('提出');
    expect(missingTerms('Which team did Fang Jie transfer to?', ['Fang Jie'], 'Fang Jie raised R-03')).toEqual(expect.arrayContaining(['team', 'transfer']));
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

  it('looks for a named entity nothing came back about, within its budget', async () => {
    const r = await secondRound(store, 'What happened to Orion?', { named: ['orion'], contexts: [], facts: [], chain: false });
    expect(r?.reason.uncoveredNamed).toEqual(['Orion']);
    expect(r?.chunks.map((c) => c.path).sort()).toEqual(['raw/docs/orion-1.md', 'raw/docs/orion-2.md']);
    expect(r!.chunks.length).toBeLessThanOrEqual(SECOND_CHUNKS);
  });

  it('does not run when the first round holds what the question asks about', async () => {
    const r = await secondRound(store, 'When did Orion launch?', {
      named: ['orion'], contexts: [result('orion-2', 'Orion launched in week 32.')], facts: [], chain: false,
    });
    expect(r).toBeNull();
  });
});

describe('ask with a second round', () => {
  const llm = { enabled: false } as unknown as LlmClient;
  it('adds what the second round found to the contexts and says why it ran; off when asked', async () => {
    const q = 'Who raised risk R-07, and where is that person now?';
    const res = await ask(store, defaultConfig(), embedder, llm, q, { queryVector: [1, 0, 0, 0], k: 1 });
    expect(res.route.kind).toBe('multihop');
    expect(res.route.second).toMatchObject({ from: ['Li Wei'] });
    expect(res.route.second!.chunks).toBeGreaterThan(0);
    expect(res.contexts.map((c) => c.path)).toContain('raw/docs/liwei-move.md');
    const off = await ask(store, defaultConfig(), embedder, llm, q, { queryVector: [1, 0, 0, 0], k: 1, second: false });
    expect(off.route.second).toBeUndefined();
    // the workspace's switch, and the call over it
    const config = defaultConfig();
    config.retrieval.router = { ...config.retrieval.router!, secondRound: false };
    expect((await ask(store, config, embedder, llm, q, { queryVector: [1, 0, 0, 0], k: 1 })).route.second).toBeUndefined();
    expect((await ask(store, config, embedder, llm, q, { queryVector: [1, 0, 0, 0], k: 1, second: true })).route.second).toBeDefined();
    expect(off.contexts.map((c) => c.path)).not.toContain('raw/docs/liwei-move.md');
  });
});
