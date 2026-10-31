import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SagSearchConfig } from '../src/config.js';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import { search } from '../src/search/search.js';
import { Store, toVectorLiteral } from '../src/store/db.js';

/**
 * Which chunks SAG expands an entity to when it has more than
 * `maxEventsPerEntity`. Only s1 has a vector and nothing names the query, so
 * s1 is the single seed, its entities Corvid, Tromso and Fjord are the first
 * frontier, and every other chunk can only be reached through them.
 *
 *   s1  Corvid Tromso Fjord   the seed
 *   b1  Corvid Tromso         2026-03
 *   t1         Tromso         2026-02
 *   n1  Corvid                2026-06
 *   h1  Corvid                2026-01, by far the hottest document
 *   o1  Corvid                2025-06
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-sag-expansion-'));

class FixtureEmbedder implements EmbeddingProvider {
  readonly model = 'fixture-v1';
  readonly dimensions = 4;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0, 0, 0]);
  }
}

const embedder = new FixtureEmbedder();
let store: Store;

async function addChunk(id: string, content: string, docDate: string | null, vector?: number[]): Promise<void> {
  const documentId = `d-${id}`;
  await store.query(
    `INSERT INTO documents (id, path, root, title, sha256, bytes, status, doc_date)
     VALUES ($1, $2, 'docs', $1, $3, $4, 'indexed', $5)`,
    [documentId, `raw/docs/${documentId}.md`, `sha-${documentId}`, content.length, docDate],
  );
  await store.query(
    `INSERT INTO chunks (id, document_id, seq, content, token_count, tsv)
     VALUES ($1, $2, 0, $3, 10, to_tsvector('simple', $3))`,
    [id, documentId, content],
  );
  if (vector) {
    await store.query(
      `INSERT INTO embeddings (chunk_id, model, embedding) VALUES ($1, $2, $3::vector)`,
      [id, embedder.model, toVectorLiteral(vector)],
    );
  }
}

async function addEntity(id: string, name: string, mentions: string[]): Promise<void> {
  await store.query(
    `INSERT INTO entities (id, name, type, mention_count) VALUES ($1, $2, 'concept', $3)`,
    [id, name, mentions.length],
  );
  for (const chunkId of mentions) {
    await store.query(
      `INSERT INTO entity_mentions (entity_id, chunk_id, document_id) VALUES ($1, $2, $3)`,
      [id, chunkId, `d-${chunkId}`],
    );
  }
}

const sag = (maxEventsPerEntity: number): Partial<SagSearchConfig> => ({
  seedChunks: 1,
  entityFrontier: 8,
  maxEventsPerEntity,
  candidatePool: 16,
  maxHops: 2,
  directRatio: 0.5,
});

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, '.knode'), { recursive: true });
  store = await Store.open(tmp, embedder.dimensions);
  await addChunk('s1', 'Field report from the coast.', '2026-04-01', [1, 0, 0, 0]);
  await addChunk('b1', 'The northern office hired twelve engineers.', '2026-03-01');
  await addChunk('t1', 'Ferry timetables changed for the winter.', '2026-02-01');
  await addChunk('n1', 'A new partnership was announced.', '2026-06-01');
  await addChunk('h1', 'Quarterly figures, page one.', '2026-01-01');
  await addChunk('o1', 'An old press release.', '2025-06-01');
  await addEntity('e-corvid', 'Corvid', ['s1', 'b1', 'n1', 'h1', 'o1']);
  await addEntity('e-tromso', 'Tromso', ['s1', 'b1', 't1']);
  await addEntity('e-fjord', 'Fjord', ['s1']);
  await store.query(
    `INSERT INTO doc_stats (document_id, hit_count, last_hit_at, heat, heat_updated) VALUES ('d-h1', 500, now(), 1e6, now())`,
  );
});

afterAll(async () => {
  if (store) await store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('SAG expansion past the per-entity cap', () => {
  it('keeps the chunks where the frontier entities meet, newest first among equals, whatever their heat', async () => {
    const results = await search(store, embedder, 'plover', { mode: 'sag', k: 8, track: false, sag: sag(2) });
    // Corvid keeps b1 (Tromso is there too) and then the newest of n1, h1 and o1; Tromso keeps b1 and t1
    expect(results.map((r) => r.chunkId).sort()).toEqual(['b1', 'n1', 's1', 't1']);
    const meet = results.find((r) => r.chunkId === 'b1')!;
    expect(meet.trace).toMatchObject({ route: 'sag', hop: 1, seedChunkId: 's1', bridgeEntities: ['Tromso'] });
    // reached through both entities, so it scores as both
    for (const id of ['n1', 't1']) {
      expect(meet.signals.structural).toBeGreaterThan(results.find((r) => r.chunkId === id)!.signals.structural!);
    }
  });

  it('gives no place to a chunk already reached', async () => {
    // s1 mentions all three entities, so it would come first for each of them, but it is the seed
    const results = await search(store, embedder, 'plover', { mode: 'sag', k: 8, track: false, sag: sag(1) });
    expect(results.map((r) => r.chunkId).sort()).toEqual(['b1', 's1']);
  });
});
