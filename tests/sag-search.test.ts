import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import { search } from '../src/search/search.js';
import { Store, toVectorLiteral } from '../src/store/db.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-sag-'));

class FixtureEmbedder implements EmbeddingProvider {
  readonly model = 'fixture-v1';
  readonly dimensions = 4;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0, 0, 0]);
  }
}

const embedder = new FixtureEmbedder();
let store: Store;

async function addChunk(
  id: string,
  documentId: string,
  content: string,
  vector: number[],
): Promise<void> {
  await store.query(
    `INSERT INTO documents (id, path, root, title, sha256, bytes, status)
     VALUES ($1, $2, 'docs', $3, $4, $5, 'indexed')`,
    [documentId, `raw/docs/${documentId}.md`, documentId, `sha-${documentId}`, content.length],
  );
  await store.query(
    `INSERT INTO chunks (id, document_id, seq, content, token_count, tsv)
     VALUES ($1, $2, 0, $3, 10, to_tsvector('simple', $3))`,
    [id, documentId, content],
  );
  await store.query(
    `INSERT INTO embeddings (chunk_id, model, embedding) VALUES ($1, $2, $3::vector)`,
    [id, embedder.model, toVectorLiteral(vector)],
  );
}

async function addEntity(id: string, name: string, mentions: string[]): Promise<void> {
  await store.query(
    `INSERT INTO entities (id, name, type, mention_count) VALUES ($1, $2, 'concept', $3)`,
    [id, name, mentions.length],
  );
  for (const chunkId of mentions) {
    const [chunk] = await store.query<{ document_id: string }>(
      `SELECT document_id FROM chunks WHERE id = $1`,
      [chunkId],
    );
    await store.query(
      `INSERT INTO entity_mentions (entity_id, chunk_id, document_id) VALUES ($1, $2, $3)`,
      [id, chunkId, chunk.document_id],
    );
  }
}

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, '.knode'), { recursive: true });
  store = await Store.open(tmp, embedder.dimensions);
  await addChunk('c0', 'd0', 'Beta was acquired by Acme.', [1, 0, 0, 0]);
  await addChunk('c1', 'd1', 'Alice is the CTO of Acme.', [0, 1, 0, 0]);
  await addChunk('c2', 'd2', 'Alice later joined Project Orion.', [0, 0, 1, 0]);
  await addChunk('c3', 'd3', 'A completely unrelated cooking note.', [-1, 0, 0, 0]);
  await addEntity('e-beta', 'Beta', ['c0']);
  await addEntity('e-acme', 'Acme', ['c0', 'c1']);
  await addEntity('e-alice', 'Alice', ['c1', 'c2']);
  await addEntity('e-orion', 'Project Orion', ['c2']);
});

afterAll(async () => {
  if (store) await store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('SAG query-time event expansion', () => {
  it('reaches a chunk through two entity bridges and exposes the path', async () => {
    const results = await search(store, embedder, 'What happened to Beta?', {
      mode: 'sag',
      k: 2,
      track: false,
      sag: {
        seedChunks: 1,
        entityFrontier: 8,
        maxEventsPerEntity: 8,
        candidatePool: 16,
        maxHops: 2,
        directRatio: 0,
      },
    });

    const twoHop = results.find((result) => result.chunkId === 'c2');
    expect(twoHop).toBeDefined();
    expect(twoHop?.signals.structural).toBeGreaterThan(0);
    expect(twoHop?.trace).toMatchObject({
      route: 'sag',
      hop: 2,
      seedChunkId: 'c0',
      bridgeEntities: ['Acme', 'Alice'],
    });
  });

  it('keeps a direct route when structural candidates are unavailable', async () => {
    const results = await search(store, embedder, 'unrelated cooking', {
      mode: 'sag',
      k: 1,
      track: false,
      sag: { seedChunks: 1, directRatio: 0 },
    });

    expect(results).toHaveLength(1);
    expect(results[0].chunkId).toBe('c3');
    expect(results[0].trace?.route).toBe('direct');
  });
});
