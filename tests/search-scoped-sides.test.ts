import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import { search, searchExplained } from '../src/search/search.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../src/store/db.js';
import { resolveScopeFilter } from '../src/store/resolver.js';

/**
 * A search its caller scoped — to the wiki, to a folder, to pages — gets its
 * candidates from the vector channel, wherever the scope's chunks lie from
 * the question.
 *
 * The index here is large enough that no side of it is read whole without a
 * filter, and its vector index is walked: 3,000 generated pages around one
 * direction, 31,000 reports around another, a small folder (`near`, 500)
 * around a third, and two folders that lie opposite all of them (`far`,
 * 2,500 chunks; `deep`, 3,500).
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-scoped-sides-'));

class FixtureEmbedder implements EmbeddingProvider {
  readonly model = 'fixture-v1';
  readonly dimensions = 4;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0, 0, 0]);
  }
}

const embedder = new FixtureEmbedder();
let store: Store;

/** Folder, documents, the direction its vectors scatter around. */
const FOLDERS: { id: string; dir: string; root: string; kind: 'source' | 'view'; n: number; around: [number, number, number, number] }[] = [
  { id: 'p', dir: 'wiki/entities', root: 'wiki', kind: 'view', n: 3000, around: [1, 0, 0, 0] },
  { id: 'm', dir: 'raw/docs/main', root: 'docs', kind: 'source', n: 31000, around: [1, 1, 0, 0] },
  { id: 'n', dir: 'raw/docs/near', root: 'docs', kind: 'source', n: 500, around: [0, 0, 1, 0] },
  { id: 'f', dir: 'raw/docs/far', root: 'docs', kind: 'source', n: 2500, around: [-1, -1, -1, 0.5] },
  { id: 'e', dir: 'raw/docs/deep', root: 'docs', kind: 'source', n: 3500, around: [-1, -1, -1, -0.5] },
];
const AMONG_PAGES = [1, 0, 0, 0];
const AMONG_REPORTS = [1, 1, 0, 0];
const AMONG_NEAR = [0, 0, 1, 0];

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, '.knode'), { recursive: true });
  store = await Store.open(tmp, embedder.dimensions);
  await store.indexing;
  // the vector index is built once over the rows, as a restore builds it: row by row it takes a minute here
  const [{ indexdef }] = await store.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'embeddings_hnsw_idx'`);
  await store.query(`DROP INDEX embeddings_hnsw_idx`);
  for (const f of FOLDERS) {
    await store.query(
      `INSERT INTO documents (id, path, root, kind, title, sha256, bytes, status)
       SELECT 'd-${f.id}' || i, '${f.dir}/${f.id}' || i || '.md', '${f.root}', '${f.kind}', '${f.id}' || i, 'sha-${f.id}' || i, 10, 'indexed' FROM generate_series(1, ${f.n}) i`,
    );
    await store.query(
      `INSERT INTO chunks (id, document_id, seq, content, token_count, tsv)
       SELECT '${f.id}' || i, 'd-${f.id}' || i, 0, 'chunk ${f.id}' || i, 2, to_tsvector('simple', 'chunk') FROM generate_series(1, ${f.n}) i`,
    );
    // scattered (vectors in a line or on a circle make a graph the index cannot walk on through)
    const at = (base: number, salt: string) => `(${base} + (hashtext('${f.id}${salt}' || i) % 1000) / 3333.0)`;
    await store.query(
      `INSERT INTO embeddings (chunk_id, model, embedding)
       SELECT '${f.id}' || i, 'fixture-v1', ('[' || ${at(f.around[0], 'a')} || ',' || ${at(f.around[1], 'b')} || ',' || ${at(f.around[2], 'c')} || ',' || ${at(f.around[3], 'd')} || ']')::${VECTOR_TYPE}
       FROM generate_series(1, ${f.n}) i`,
    );
  }
  await store.query(indexdef);
  await store.query(`ANALYZE`);
}, 240_000);

afterAll(async () => {
  if (store) await store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The nearest chunks of a folder by a scan of every vector. */
async function exact(prefix: string, question: number[], k: number): Promise<string[]> {
  const rows = await store.tx(async (q) => {
    await q.query(`SET LOCAL enable_indexscan = off`);
    return q.query<{ id: string }>(
      `SELECT c.id FROM embeddings e JOIN chunks c ON c.id = e.chunk_id JOIN documents d ON d.id = c.document_id
       WHERE d.path LIKE $2 ORDER BY e.embedding <=> $1::${VECTOR_TYPE}, c.id LIMIT ${k}`,
      [toVectorLiteral(question), `${prefix}/%`],
    );
  });
  return rows.map((r) => r.id);
}

const found = async (opts: { sources?: string[]; kinds?: string[]; queryVector?: number[]; k?: number; mode?: 'vector' | 'hybrid' }) =>
  (await search(store, embedder, 'chunk', {
    k: opts.k ?? 8, mode: opts.mode ?? 'vector', track: false, current: false, queryVector: opts.queryVector ?? AMONG_PAGES,
    filter: opts.sources || opts.kinds ? resolveScopeFilter({ sources: opts.sources, kinds: opts.kinds }) : undefined,
  })).map((r) => r.chunkId);

describe('a search scoped to the wiki', () => {
  it('is answered by the vector channel: the statement it sends is one the server takes', async () => {
    for (const sources of [['wiki'], ['wiki/entities']]) {
      const ids = await found({ sources });
      expect(ids).toHaveLength(8);
      expect(ids.every((id) => id.startsWith('p'))).toBe(true);
    }
    // and a hybrid search has its vector channel: the failure was swallowed there, and the search answered without it
    const { channels } = await searchExplained(store, embedder, 'chunk', {
      k: 8, mode: 'hybrid', track: false, current: false, queryVector: AMONG_PAGES, filter: resolveScopeFilter({ sources: ['wiki'] }),
    });
    expect(channels.vector?.error).toBeUndefined();
    expect(channels.vector?.hits).toBe(24);
  });

  it('walks on for its pages past nearer sources, as a search for the kind does', async () => {
    // the question among the 500 reports of raw/docs/near: the nearest forty chunks of all hold no page
    const byKind = await found({ kinds: ['view'], queryVector: AMONG_NEAR });
    expect(byKind).toHaveLength(8);
    const bySource = await found({ sources: ['wiki'], queryVector: AMONG_NEAR });
    expect(bySource).toEqual(byKind);
    expect(bySource.every((id) => id.startsWith('p'))).toBe(true);
  });
});
