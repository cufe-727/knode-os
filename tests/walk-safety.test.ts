import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { entityKeyKinds } from '../src/graph/normalize.js';
import type { EmbeddingProvider } from '../src/ingest/embeddings.js';
import type { LlmClient } from '../src/llm/client.js';
import { ask } from '../src/search/ask.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../src/store/db.js';

/**
 * The relation walk is safe on questions it cannot help, on a store it cannot
 * embed for, on hubs, and when it orders (docs/design/30 §3, §3.1): the
 * review of the walk as merged in main 7a299bf.
 */

const MODEL = 'fixture-safety-v1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-walk-safety-'));
let store: Store;
let n = 0;
const noLlm = { enabled: false } as unknown as LlmClient;
const config = defaultConfig();

async function entity(id: string, name: string, type = 'organization', vector?: number[]): Promise<void> {
  await store.query(`INSERT INTO entities (id, name, type, mention_count, aliases, description) VALUES ($1, $2, $3, 5, '[]'::jsonb, '')`, [id, name, type]);
  for (const key of entityKeyKinds(name).keys()) await store.query(`INSERT INTO entity_alias_keys (entity_id, alias_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, key]);
  if (vector) await store.query(`INSERT INTO entity_embeddings (entity_id, fold_sha, model, embedding) VALUES ($1, '', $2, $3::${VECTOR_TYPE})`, [id, MODEL, toVectorLiteral(vector)]);
}

/** A dated document of one chunk mentioning `mentions`, with claims [subject, statement, date, type?]. Returns its document and chunk ids. */
async function doc(content: string, mentions: string[], date: string | null = null, claims: [string, string, string | null, string?][] = []): Promise<{ doc: string; chunk: string }> {
  const id = `o${++n}`;
  await store.query(`INSERT INTO documents (id, path, root, title, sha256, bytes, status, doc_date) VALUES ($1, $2, 'docs', $1, $1, 10, 'indexed', $3)`, [`d-${id}`, `raw/docs/${id}.md`, date]);
  await store.query(`INSERT INTO chunks (id, document_id, seq, content, token_count, tsv) VALUES ($1, $2, 0, $3, 3, to_tsvector('simple', $3))`, [`c-${id}`, `d-${id}`, content]);
  await store.query(`INSERT INTO embeddings (chunk_id, model, embedding) VALUES ($1, $2, $3::${VECTOR_TYPE})`, [`c-${id}`, MODEL, toVectorLiteral([1, 0, 0, 0])]);
  await store.query(`INSERT INTO scopes (id, kind, key, sha, status, applied_at) VALUES ($1, 'doc', $2, $1, 'active', now())`, [`s-${id}`, `raw/docs/${id}.md`]);
  for (const e of mentions) await store.query(`INSERT INTO entity_mentions (entity_id, chunk_id, document_id, scope_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [e, `c-${id}`, `d-${id}`, `s-${id}`]);
  for (const [subject, statement, d, type] of claims) {
    await store.query(
      `INSERT INTO claims (id, subject_id, type, statement, status, kind, event_at, chunk_id, primary_scope_id, evidence_count, tx_from) VALUES ($1, $2, $3, $4, 'fact', 'fact', $5, $6, $7, 1, now())`,
      [`cl-${id}-${subject}`, subject, type ?? 'event', statement, d ? `${d}T00:00:00Z` : null, `c-${id}`, `s-${id}`],
    );
  }
  return { doc: `d-${id}`, chunk: `c-${id}` };
}

async function relate(source: string, target: string, description: string, at: { doc: string; chunk: string }, weight = 1, type = 'related_to', validFrom: string | null = null): Promise<void> {
  await store.query(
    `INSERT INTO relations (id, source_id, target_id, type, description, weight, document_id, chunk_id, valid_from) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`r${++n}`, source, target, type, description, weight, at.doc, at.chunk, validFrom ? `${validFrom}T00:00:00Z` : null],
  );
}

class DownEmbedder implements EmbeddingProvider {
  readonly model = MODEL;
  readonly dimensions = 4;
  calls = 0;
  async embed(): Promise<number[][]> {
    this.calls++;
    throw new Error('embedder unavailable');
  }
}

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, '.knode'), { recursive: true });
  store = await Store.open(tmp, 4);
  await store.indexing;
  // a group, two incidents and who fixed them
  await entity('plat', '二部平台组');
  await entity('qian', '钱勇', 'person');
  for (const [id, name, date] of [['i1', 'INC-001-D2T1', '2026-02-03'], ['i2', 'INC-002-D2T1', '2026-04-28']] as const) {
    await entity(id, name, 'event');
    const at = await doc(`${name}是二部平台组报告的事故。`, [id, 'plat'], date, [[id, `${name}发生`, date]]);
    await relate(id, 'plat', `${name}是二部平台组报告的事故。`, at);
    await relate('qian', id, `钱勇修复了${name}。`, await doc(`钱勇修复了${name}。`, ['qian', id], date));
  }
  // a company with heavy competitor relations and five yearly values: a question the walk cannot help
  await entity('catl', '宁德时代');
  for (let i = 0; i < 8; i++) {
    await entity(`peer${i}`, `电池同行${i}号`);
    await relate('catl', `peer${i}`, `宁德时代与电池同行${i}号存在竞争。`, await doc(`宁德时代与电池同行${i}号竞争`, ['catl', `peer${i}`], '2019-01-01'), 9, 'competes_with');
  }
  for (let y = 2021; y <= 2025; y++) {
    await doc(`宁德时代${y}年人均产值为${300 + y - 2021}万元。`, ['catl'], `${y + 1}-03-01`, [['catl', `宁德时代${y}年人均产值为${300 + y - 2021}万元`, `${y}-12-31`, 'metric']]);
  }
});

afterAll(async () => {
  await store?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a multi-hop answer without the embedder', () => {
  it('falls back to the keyword and graph channels, as the lookup route does', async () => {
    const down = new DownEmbedder();
    for (const mode of [undefined, 'keyword'] as const) {
      const res = await ask(store, config, down, noLlm, '二部平台组的事故是谁修复的？他还修复过哪些事故', mode ? { mode } : {});
      expect(res.route.kind).toBe('multihop');
      expect(res.contexts.length).toBeGreaterThan(0);
      expect(res.facts.some((f) => f.statement.includes('钱勇'))).toBe(true);
    }
  });
});

describe('a question the walk cannot help', () => {
  it('adds no relation that matches nothing, and keeps what the ordinary route would have found', async () => {
    const embedder = { model: MODEL, dimensions: 4, embed: async (t: string[]) => t.map(() => [1, 0, 0, 0]) } as EmbeddingProvider;
    const q = '宁德时代的人均产值是多少，它在行业里排第几';
    const chained = await ask(store, config, embedder, noLlm, q, { route: 'multihop' });
    const lookup = await ask(store, config, embedder, noLlm, q, { route: 'lookup' });
    expect(chained.route.walked).toMatchObject({ relations: 0 });
    expect(chained.facts.filter((f) => f.statement.includes('competes with'))).toEqual([]);
    const have = new Set(chained.facts.map((f) => f.id));
    expect(lookup.facts.map((f) => f.id).filter((id) => !have.has(id))).toEqual([]);
    expect(chained.facts.filter((f) => f.statement.includes('人均产值')).length).toBeGreaterThanOrEqual(lookup.facts.filter((f) => f.statement.includes('人均产值')).length);
  });
});

