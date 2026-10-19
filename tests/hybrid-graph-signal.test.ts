import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import { search } from '../src/search/search.js';
import { Store } from '../src/store/db.js';

/**
 * The graph signal of hybrid search: chunks that mention an entity whose name
 * matches the query. RRF scores a chunk by its rank in each signal's list, so
 * that list must be ordered on purpose, hold each chunk once, and — under
 * `asOf` — count only entities the knowledge base held at that time.
 *
 * No chunk text contains the query and no chunk has a vector, so the graph
 * signal is the only one that answers: rank r scores exactly 0.6 / (61 + r).
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-graph-signal-'));

class FixtureEmbedder implements EmbeddingProvider {
  readonly model = 'fixture-v1';
  readonly dimensions = 4;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0, 0, 0]);
  }
}

const embedder = new FixtureEmbedder();
let store: Store;

const SOURCES_APPLIED = '2026-01-01T00:00:00.000Z';
/** The time the as_of searches ask about. */
const AS_OF = '2026-03-01T00:00:00.000Z';
const NEST_LEARNED = '2026-06-01T00:00:00.000Z';
const OLD_RETIRED = '2026-05-01T00:00:00.000Z';

async function addChunk(id: string): Promise<void> {
  const doc = `d-${id}`;
  const key = `raw/docs/${doc}.md`;
  await store.query(
    `INSERT INTO documents (id, path, root, title, sha256, bytes, status) VALUES ($1, $2, 'docs', $1, $3, 10, 'indexed')`,
    [doc, key, `sha-${doc}`],
  );
  await store.query(
    `INSERT INTO chunks (id, document_id, seq, content, token_count, tsv) VALUES ($1, $2, 0, $3, 3, to_tsvector('simple', $3))`,
    [id, doc, `Field notes ${id}.`],
  );
  await store.query(
    `INSERT INTO scopes (id, kind, key, sha, status, applied_at) VALUES ($1, 'doc', $2, $3, 'active', $4)`,
    [`scope-${doc}`, key, `sha-${doc}`, SOURCES_APPLIED],
  );
}

/** An entity with a corpus-wide mention count, the chunks it is mentioned in, and its evidence window. */
async function addEntity(
  id: string,
  name: string,
  mentionCount: number,
  chunks: string[],
  window: { from: string; to?: string },
): Promise<void> {
  await store.query(
    `INSERT INTO entities (id, name, type, mention_count, tx_from, tx_to) VALUES ($1, $2, 'concept', $3, $4, $5)`,
    [id, name, mentionCount, window.from, window.to ?? null],
  );
  for (const chunk of chunks) {
    await store.query(`INSERT INTO entity_mentions (entity_id, chunk_id, document_id) VALUES ($1, $2, $3)`, [id, chunk, `d-${chunk}`]);
  }
  await store.query(
    `INSERT INTO evidence (kind, target_id, scope_id, extractor, tx_from, tx_to) VALUES ('entity', $1, $2, 'test', $3, $4)`,
    [id, `scope-d-${chunks[0]}`, window.from, window.to ?? null],
  );
}

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, '.knode'), { recursive: true });
  store = await Store.open(tmp, embedder.dimensions);
  // inserted against the order they rank in
  for (const id of ['c6', 'c5', 'c4', 'c3', 'c2', 'c1']) await addChunk(id);
  await addEntity('e-owl', 'Kestrel Owl', 2, ['c6'], { from: SOURCES_APPLIED });
  await addEntity('e-labs', 'Kestrel Labs', 2, ['c3', 'c2'], { from: SOURCES_APPLIED });
  await addEntity('e-kestrel', 'Kestrel', 9, ['c2', 'c1'], { from: SOURCES_APPLIED });
  // learned after AS_OF: matches now, not then
  await addEntity('e-nest', 'Kestrel Nest', 4, ['c4'], { from: NEST_LEARNED });
  // retired after AS_OF: matched then, not now
  await addEntity('e-old', 'Old Kestrel', 4, ['c5'], { from: SOURCES_APPLIED, to: OLD_RETIRED });
});

afterAll(async () => {
  if (store) await store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the hybrid graph signal', () => {
  it('ranks chunks by matching entities, then their mention counts, then id, and counts each chunk once', async () => {
    const results = await search(store, embedder, 'Kestrel', { k: 10, track: false });
    // c2 mentions two matching entities (9 + 2 mentions); c1, c4, c3 and c6 one
    // each (9, 4, 2, 2 — the tie between c3 and c6 goes by id)
    expect(results.map((r) => [r.chunkId, r.signals])).toEqual([
      ['c2', { graph: 2 }],
      ['c1', { graph: 1 }],
      ['c4', { graph: 1 }],
      ['c3', { graph: 1 }],
      ['c6', { graph: 1 }],
    ]);
    results.forEach((r, rank) => expect(r.score).toBeCloseTo(0.6 / (61 + rank), 12));
  });

  it('counts the entities that were live at asOf, not the ones live now', async () => {
    const results = await search(store, embedder, 'Kestrel', { k: 10, track: false, asOf: AS_OF });
    // Kestrel Nest was not known yet; Old Kestrel still was
    expect(results.map((r) => r.chunkId)).toEqual(['c2', 'c1', 'c5', 'c3', 'c6']);
    results.forEach((r, rank) => expect(r.score).toBeCloseTo(0.6 / (61 + rank), 12));
  });
});
