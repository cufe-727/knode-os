import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import { FUSION_WEIGHTS, search } from '../src/search/search.js';
import { Store } from '../src/store/db.js';

/**
 * The graph signal of hybrid search: chunks that mention the entities the
 * query names, the rarer ones weighing more. RRF scores a chunk by its rank in
 * each signal's list, so that list must be ordered on purpose, hold each chunk
 * once, and — under `asOf` — count only entities the knowledge base held at
 * that time.
 *
 * No chunk text contains the query and no chunk has a vector, so the graph
 * signal is the only one that answers: rank r scores exactly FUSION_WEIGHTS.graph / (61 + r).
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

/** An entity with a corpus-wide mention count, the chunks it is mentioned in, its evidence window, and — while live — its lookup key. */
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
  // a retired entity's keys are dropped (src/lineage/fold.ts)
  if (!window.to) await store.query(`INSERT INTO entity_alias_keys (entity_id, alias_key) VALUES ($1, $2)`, [id, name.toLowerCase().replace(/\s+/g, '')]);
}

/** The rank-ordered chunk ids and the graph signal (summed IDF) of a hybrid search. */
async function ranking(query: string, asOf?: string): Promise<{ ids: string[]; raw: number[] }> {
  const results = await search(store, embedder, query, { k: 10, track: false, asOf });
  results.forEach((r, rank) => expect(r.score).toBeCloseTo(FUSION_WEIGHTS.graph / (61 + rank), 12));
  return { ids: results.map((r) => r.chunkId), raw: results.map((r) => r.signals.graph!) };
}

/** The IDF the channel gives an entity mentioned in `df` of the fixture's eight chunks. */
const idf = (df: number) => Math.log(1 + (8 - df + 0.5) / (df + 0.5));

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, '.knode'), { recursive: true });
  store = await Store.open(tmp, embedder.dimensions);
  // inserted against the order they rank in
  for (const id of ['c8', 'c7', 'c6', 'c5', 'c4', 'c3', 'c2', 'c1']) await addChunk(id);
  await addEntity('e-owl', 'Kestrel Owl', 2, ['c6'], { from: SOURCES_APPLIED });
  await addEntity('e-labs', 'Kestrel Labs', 2, ['c3', 'c2'], { from: SOURCES_APPLIED });
  // the most mentioned, in the most chunks: the least telling
  await addEntity('e-kestrel', 'Kestrel', 90, ['c8', 'c7', 'c2', 'c1'], { from: SOURCES_APPLIED });
  // learned after AS_OF: named now, not then
  await addEntity('e-nest', 'Kestrel Nest', 4, ['c4'], { from: NEST_LEARNED });
  // retired after AS_OF: live then, not now
  await addEntity('e-old', 'Old Kestrel', 4, ['c5'], { from: SOURCES_APPLIED, to: OLD_RETIRED });
});

afterAll(async () => {
  if (store) await store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the hybrid graph signal', () => {
  it('ranks chunks by the summed rarity of the entities the query names, then by how many, then by id', async () => {
    // "Kestrel Labs" names the Labs, not Kestrel inside it; "the Kestrel" names Kestrel; Kestrel Owl is not named.
    // c2 mentions both; c3 the Labs (in two chunks) alone; c1, c7, c8 Kestrel (in four) alone, by id
    const { ids, raw } = await ranking('What did Kestrel Labs say about the Kestrel?');
    expect(ids).toEqual(['c2', 'c3', 'c1', 'c7', 'c8']);
    expect(raw[0]).toBeCloseTo(idf(2) + idf(4), 12);
    expect(raw[1]).toBeCloseTo(idf(2), 12);
    for (const r of raw.slice(2)) expect(r).toBeCloseTo(idf(4), 12);
  });

  it('matches a query that names no entity by the entities holding its terms', async () => {
    // "Kestr" is no entity's spelling; every live entity holding it counts, the rarest first
    const { ids } = await ranking('Kestr');
    expect(ids).toEqual(['c2', 'c4', 'c6', 'c3', 'c1', 'c7', 'c8']);
  });

  it('answers a query quoting a passage under a rule of hyphens', async () => {
    // websearch_to_tsquery read each hyphen as an operator and overflowed its stack
    const results = await search(store, embedder, `Kestrel\n${'-'.repeat(62)}\n- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -`, { k: 10, track: false, mode: 'keyword' });
    expect(Array.isArray(results)).toBe(true);
  });

  it('counts the entities that were live at asOf, not the ones live now', async () => {
    // now "Kestrel Nest" names the Nest; at AS_OF it named nothing yet, and the Kestrel inside it counts
    expect((await ranking('Kestrel Nest')).ids).toEqual(['c4']);
    expect((await ranking('Kestrel Nest', AS_OF)).ids).toEqual(['c1', 'c2', 'c7', 'c8']);
    // Old Kestrel's keys went with it; the term match still finds it at AS_OF, and not now
    expect((await ranking('Kestr', AS_OF)).ids).toEqual(['c2', 'c5', 'c6', 'c3', 'c1', 'c7', 'c8']);
  });
});
