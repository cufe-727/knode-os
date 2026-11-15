import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseConfig } from '../src/config.js';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import { search, sideBudget } from '../src/search/search.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../src/store/db.js';
import { resolveScopeFilter } from '../src/store/resolver.js';

/**
 * The vector channel's two sides (sources, generated pages) on PostgreSQL,
 * where the vector query is served by the HNSW index: a filter is tested
 * after the index is walked, and one walk ends at `hnsw.ef_search` rows, so
 * where pages are the nearest vectors a search for sources came back with
 * the few sources among the nearest 40 — none here. PGlite scans every
 * vector and cannot show it; this suite needs a real server and is skipped
 * without one, like tests/backend-postgres.test.ts (KNODE_TEST_PG_HOST /
 * _PORT / _USER / _PASSWORD point it at one).
 */

const DB_PREFIX = 'knode_backend_test_';
const runDatabase = `${DB_PREFIX}${Math.floor(Date.now() / 1000)}_${crypto.randomBytes(4).toString('hex')}`;

const dbConfig: DatabaseConfig = {
  kind: 'postgres',
  host: process.env.KNODE_TEST_PG_HOST ?? '127.0.0.1',
  port: Number(process.env.KNODE_TEST_PG_PORT ?? 5432),
  user: process.env.KNODE_TEST_PG_USER ?? os.userInfo().username,
  password: process.env.KNODE_TEST_PG_PASSWORD ?? '',
  database: runDatabase,
  schemaPrefix: 'ws_test',
};

function adminPool(database = 'postgres'): pg.Pool {
  return new pg.Pool({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user || undefined,
    ...(dbConfig.password ? { password: dbConfig.password } : {}),
    database,
    max: 1,
    connectionTimeoutMillis: 2000,
  });
}

async function postgresReady(): Promise<boolean> {
  const pool = adminPool();
  try {
    const { rows } = await pool.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector' AND split_part(default_version, '.', 2)::int >= 8`);
    return rows.length > 0;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
}

const ready = await postgresReady();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-pgtest-pages-'));

class FixtureEmbedder implements EmbeddingProvider {
  readonly model = 'fixture-v1';
  readonly dimensions = 4;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0, 0, 0]);
  }
}

/** Enough of each side that the planner walks the vector index for either. */
const SOURCES = 1500;
const PAGES = 6000;

describe.skipIf(!ready)('postgres backend: the vector channel lists sources where pages are nearer', () => {
  const embedder = new FixtureEmbedder();
  let store: Store;

  beforeAll(async () => {
    const admin = adminPool();
    try {
      await admin.query(`CREATE DATABASE "${runDatabase}"`);
    } finally {
      await admin.end().catch(() => {});
    }
    store = await Store.open(dir, embedder.dimensions, dbConfig);
    await store.indexing;
    // every page nearer the question than any source, as on the 10× separation index
    await store.query(
      `INSERT INTO documents (id, path, root, kind, title, sha256, bytes, status)
       SELECT 'd-p' || i, 'wiki/entities/p' || i || '.md', 'wiki', 'view', 'p' || i, 'sha-p' || i, 10, 'indexed' FROM generate_series(1, $1::int) i
       UNION ALL
       SELECT 'd-s' || i, 'raw/docs/s' || i || '.md', 'docs', 'source', 's' || i, 'sha-s' || i, 10, 'indexed' FROM generate_series(1, $2::int) i`,
      [PAGES, SOURCES],
    );
    await store.query(
      `INSERT INTO chunks (id, document_id, seq, content, token_count, tsv)
       SELECT substr(id, 3), id, 0, 'chunk ' || id, 2, to_tsvector('simple', 'chunk') FROM documents`,
    );
    // the pages scattered close around the question's direction, the sources around one 45° off it
    // (scattered: vectors in a line or on a circle make a graph the index cannot walk on through)
    const scatter = (salt: string) => `(hashtext('${salt}' || i) % 1000) / 3333.0`;
    await store.query(
      `INSERT INTO embeddings (chunk_id, model, embedding)
       SELECT 'p' || i, 'fixture-v1', ('[1,' || ${scatter('a')} || ',' || ${scatter('b')} || ',' || ${scatter('c')} || ']')::${VECTOR_TYPE} FROM generate_series(1, $1::int) i
       UNION ALL
       SELECT 's' || i, 'fixture-v1', ('[1,' || 1 + ${scatter('a')} || ',' || ${scatter('b')} || ',' || ${scatter('c')} || ']')::${VECTOR_TYPE} FROM generate_series(1, $2::int) i`,
      [PAGES, SOURCES],
    );
    await store.query(`ANALYZE`);
  });

  afterAll(async () => {
    if (store) await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    const pool = adminPool();
    try {
      await pool.query(`DROP DATABASE IF EXISTS "${dbConfig.database}" WITH (FORCE)`);
    } finally {
      await pool.end().catch(() => {});
    }
  });

  const sideQuery = `SELECT c.id FROM embeddings e JOIN chunks c ON c.id = e.chunk_id JOIN documents d ON d.id = c.document_id
     WHERE e.model = 'fixture-v1' AND d.kind <> 'view' ORDER BY e.embedding <=> $1::${VECTOR_TYPE} LIMIT 24`;
  const question = toVectorLiteral([1, 0, 0, 0]);

  it('one walk of the index finds no source: the premise', async () => {
    const plan = await store.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sideQuery}`, [question]);
    expect(plan.map((r) => r['QUERY PLAN']).join('\n')).toContain('embeddings_hnsw_idx');
    expect(await store.query(sideQuery, [question])).toHaveLength(0);
  });

  it('returns sources for three quarters of a vector search: a side this small is read, and exactly', async () => {
    // the nearest sources by a scan of every vector
    const exact = (await store.tx(async (q) => {
      await q.query(`SET LOCAL enable_indexscan = off`);
      return q.query<{ id: string }>(sideQuery, [question]);
    })).map((r) => r.id);
    expect(exact).toHaveLength(24);
    // 1,500 chunks of sources in an index of 7,500: under the budget, so their vectors are read
    expect(sideBudget(24, SOURCES + PAGES)).toBe(2000);

    const results = await search(store, embedder, 'anything', { k: 8, mode: 'vector', track: false, current: false });
    const found = results.map((r) => r.chunkId);
    expect(found.filter((id) => id.startsWith('p'))).toHaveLength(2);
    expect(found.filter((id) => id.startsWith('s'))).toEqual(exact.slice(0, 6));
    expect(results.map((r) => r.signals.vector!)).toEqual(results.map((r) => r.signals.vector!).sort((a, b) => b - a));
    // a search for 20 gets its fifteen: the source list is as long as asked for, not what 40 rows of the index held
    const wide = await search(store, embedder, 'anything', { k: 20, mode: 'vector', track: false, current: false });
    expect(wide.filter((r) => r.chunkId.startsWith('s')).map((r) => r.chunkId)).toEqual(exact.slice(0, 15));
  });

  it('walks the index on for a side, in the one statement a search sends', async () => {
    // a question near the sources, and every side walked: the pages lie behind all 1,500 sources,
    // 1,460 rows past the 40 one walk reads
    const sent: string[] = [];
    const query = store.query.bind(store);
    store.query = ((sql: string, params?: unknown[]) => {
      sent.push(sql);
      return query(sql, params);
    }) as typeof store.query;
    try {
      const both = await search(store, embedder, 'anything', { k: 8, mode: 'vector', track: false, current: false, exactSide: 0, queryVector: [1, 1, 0, 0] });
      // the sources are the nearest: they fill the search, and one walk would have done for them
      expect(both.every((r) => r.chunkId.startsWith('s'))).toBe(true);
      // asked for pages alone, the walk goes on past the sources for them
      const pages = await search(store, embedder, 'anything', { k: 8, mode: 'vector', track: false, current: false, exactSide: 0, queryVector: [1, 1, 0, 0], filter: resolveScopeFilter({ kinds: ['view'] }) });
      expect(pages).toHaveLength(8);
      expect(pages.every((r) => r.chunkId.startsWith('p'))).toBe(true);
    } finally {
      store.query = query;
    }
    // a search sent one statement for its vectors, with both sides and the setting in it; the setting ended with it
    const vector = sent.filter((sql) => sql.includes('<=>'));
    expect(vector).toHaveLength(2);
    expect(vector[0]).toContain(`set_config('hnsw.iterative_scan', 'relaxed_order', true)`);
    expect(vector[0]).toContain('UNION ALL');
    expect(vector[1]).not.toContain('UNION ALL');
    expect(await store.query(`SHOW hnsw.iterative_scan`)).toEqual([{ 'hnsw.iterative_scan': 'off' }]);
  });

  it('reads a side a filter leaves a handful of chunks, however far from the question they lie', async () => {
    // three reports, behind all 6,000 pages and most sources: a walk would read to its limit for them
    const far = ['s11', 's222', 's1333'];
    const filter = resolveScopeFilter({ sources: far.map((id) => `raw/docs/${id}.md`) });
    const results = await search(store, embedder, 'anything', { k: 8, mode: 'vector', track: false, current: false, filter });
    expect(results.map((r) => r.chunkId).sort()).toEqual([...far].sort());
    expect(results.map((r) => r.signals.vector!)).toEqual(results.map((r) => r.signals.vector!).sort((a, b) => b - a));
  });
});
