import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseConfig } from '../src/config.js';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import { NEAREST_OF_ALL, nearestFor, scopedRows, search, searchExplained, SIDE_ROWS_MAX } from '../src/search/search.js';
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
 * around a third, two folders that lie opposite all of them (`far`, 2,500
 * chunks; `deep`, 3,500), and a pair of which one lies in front of the other
 * from where the first is (`front`, 2,150; `behind`, 3,200).
 *
 * It runs on the embedded index, and on a PostgreSQL server as well when one
 * is named (KNODE_TEST_PG_HOST / _PORT / _USER / _PASSWORD, as for
 * tests/search-generated-pages-postgres.test.ts).
 */

const pgConfig: DatabaseConfig = {
  kind: 'postgres',
  host: process.env.KNODE_TEST_PG_HOST ?? '127.0.0.1',
  port: Number(process.env.KNODE_TEST_PG_PORT ?? 5432),
  user: process.env.KNODE_TEST_PG_USER ?? os.userInfo().username,
  password: process.env.KNODE_TEST_PG_PASSWORD ?? '',
  database: `knode_backend_test_${Math.floor(Date.now() / 1000)}_${crypto.randomBytes(4).toString('hex')}`,
  schemaPrefix: 'ws_test',
};

const adminPool = (): pg.Pool => new pg.Pool({
  host: pgConfig.host,
  port: pgConfig.port,
  user: pgConfig.user || undefined,
  ...(pgConfig.password ? { password: pgConfig.password } : {}),
  database: 'postgres',
  max: 1,
  connectionTimeoutMillis: 2000,
});

async function postgresReady(): Promise<boolean> {
  if (!process.env.KNODE_TEST_PG_HOST) return false;
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

const BACKENDS: ('pglite' | 'postgres')[] = (await postgresReady()) ? ['pglite', 'postgres'] : ['pglite'];

class FixtureEmbedder implements EmbeddingProvider {
  readonly model = 'fixture-v1';
  readonly dimensions = 4;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0, 0, 0]);
  }
}

const embedder = new FixtureEmbedder();

/** Folder, documents, the direction its vectors scatter around. */
const FOLDERS: { id: string; dir: string; root: string; kind: 'source' | 'view'; n: number; around: [number, number, number, number] }[] = [
  { id: 'p', dir: 'wiki/entities', root: 'wiki', kind: 'view', n: 3000, around: [1, 0, 0, 0] },
  { id: 'm', dir: 'raw/docs/main', root: 'docs', kind: 'source', n: 31000, around: [1, 1, 0, 0] },
  { id: 'n', dir: 'raw/docs/near', root: 'docs', kind: 'source', n: 500, around: [0, 0, 1, 0] },
  { id: 'f', dir: 'raw/docs/far', root: 'docs', kind: 'source', n: 2500, around: [-1, -1, -1, 0.5] },
  { id: 'e', dir: 'raw/docs/deep', root: 'docs', kind: 'source', n: 3500, around: [-1, -1, -1, -0.5] },
  { id: 'r', dir: 'raw/docs/front', root: 'docs', kind: 'source', n: 2150, around: [0, 0, 0, 1] },
  { id: 'b', dir: 'raw/docs/behind', root: 'docs', kind: 'source', n: 3200, around: [0, 1, 0, 1] },
];
const AMONG_PAGES = [1, 0, 0, 0];
const AMONG_REPORTS = [1, 1, 0, 0];
const AMONG_NEAR = [0, 0, 1, 0];
const AMONG_FRONT = [0, 0, 0, 1];

describe.each(BACKENDS)('scoped searches on %s', (backend) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-scoped-sides-'));
  let store: Store;

  beforeAll(async () => {
    fs.mkdirSync(path.join(tmp, '.knode'), { recursive: true });
    if (backend === 'postgres') {
      const admin = adminPool();
      try {
        await admin.query(`CREATE DATABASE "${pgConfig.database}"`);
      } finally {
        await admin.end().catch(() => {});
      }
    }
    store = await Store.open(tmp, embedder.dimensions, backend === 'postgres' ? pgConfig : undefined);
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
    if (backend === 'postgres') {
      const admin = adminPool();
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${pgConfig.database}" WITH (FORCE)`);
      } finally {
        await admin.end().catch(() => {});
      }
    }
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

  const found = async (opts: { sources?: string[]; kinds?: string[]; queryVector?: number[]; k?: number; mode?: 'vector' | 'hybrid'; on?: Store }) =>
    (await search(opts.on ?? store, embedder, 'chunk', {
      k: opts.k ?? 8, mode: opts.mode ?? 'vector', track: false, current: false, queryVector: opts.queryVector ?? AMONG_PAGES,
      filter: opts.sources || opts.kinds ? resolveScopeFilter({ sources: opts.sources, kinds: opts.kinds }) : undefined,
    })).map((r) => r.chunkId);

  /** The store as a library without the iterative scan would answer for it: asked afresh, it says it has none. */
  const withoutIterativeScan = (): Store => {
    const old = Object.create(store) as Store;
    old.query = ((sql: string, params?: unknown[]) => (sql.includes(`current_setting('hnsw.iterative_scan'`)
      ? Promise.resolve([{ mode: null, catalog: '0.7.4' }])
      : store.query(sql, params))) as typeof store.query;
    return old;
  };

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

  describe('a search scoped to a folder that lies away from the question', () => {
    /** The vector statements a search sends. */
    const sentBy = async (run: () => Promise<unknown>): Promise<string[]> => {
      const sent: string[] = [];
      const query = store.query.bind(store);
      store.query = ((sql: string, params?: unknown[]) => {
        if (sql.includes('<=>')) sent.push(sql);
        return query(sql, params);
      }) as typeof store.query;
      try {
        await run();
      } finally {
        store.query = query;
      }
      return sent;
    };

    it('reads the folder when that costs less than walking to it: 2,500 chunks of 45,850', async () => {
      // √(8 · 24 · 45,850) = 2,967 chunks are read sooner than walked for; the walk ended at 2,000 rows with nothing
      expect(scopedRows(24, 45_850)).toBe(2967);
      const nearest = await exact('raw/docs/far', AMONG_PAGES, 8);
      expect(await found({ sources: ['raw/docs/far'] })).toEqual(nearest);
      expect(await found({ sources: ['raw/docs/far'], mode: 'hybrid' })).toHaveLength(8);
      // one statement: the folder's vectors, without the index
      const sent = await sentBy(() => found({ sources: ['raw/docs/far'] }));
      expect(sent).toHaveLength(1);
      expect(sent[0]).not.toContain('set_config');
    });

    it('walks further for a scoped side than a search of everything walks on', async () => {
      // from among the 2,150 of raw/docs/front, the 3,200 of raw/docs/behind lie past them: beyond the 2,000 rows
      // a search of everything walks on for its sources, within the 2,967 a scoped one may
      const sent = await sentBy(async () => {
        const ids = await found({ sources: ['raw/docs/behind'], queryVector: AMONG_FRONT });
        expect(ids).toHaveLength(8);
        expect(ids.every((id) => id.startsWith('b'))).toBe(true);
      });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain(`set_config('hnsw.max_scan_tuples', '2967', true)`);
    });

    it('reads a side the walk found nothing of, rather than answer with nothing', async () => {
      // 3,500 chunks, more than are read at once, behind every other chunk of the index. Whether the walk comes
      // on any of them within its limit depends on how the index was built; the search has its 8 either way
      for (const mode of ['vector', 'hybrid'] as const) {
        const ids = await found({ sources: ['raw/docs/deep'], mode });
        expect(ids).toHaveLength(8);
        expect(ids.every((id) => id.startsWith('e'))).toBe(true);
      }
      // On a library that walks no further than its first rows the walk finds none of them, every time: the
      // nearest forty of the index are pages. The folder is read in a second statement, as far as four times
      // the walk's limit, and the answer is the folder's nearest.
      const old = withoutIterativeScan();
      const sent = await sentBy(async () => {
        expect(await found({ sources: ['raw/docs/deep'], on: old })).toEqual(await exact('raw/docs/deep', AMONG_PAGES, 8));
      });
      expect(sent).toHaveLength(2);
      expect(sent[0]).not.toContain('hnsw.iterative_scan');
      expect(sent[1]).toContain(`LIMIT ${4 * 2967}`);
      // and the pages, asked for by kind from among the reports: 3,000 of them behind 31,000 reports
      expect(await found({ kinds: ['view'], queryVector: AMONG_REPORTS, on: old })).toEqual(await exact('wiki/entities', AMONG_REPORTS, 8));
      expect(await found({ kinds: ['view'], queryVector: AMONG_REPORTS })).toHaveLength(8);
    });

    it('gives each side of a scoped search its candidates', async () => {
      // the folder is read; the pages are the ones among the nearest chunks the filter leaves
      const ids = await found({ sources: ['raw/docs/far', 'wiki'] });
      expect(ids.filter((id) => id.startsWith('f'))).toEqual((await exact('raw/docs/far', AMONG_PAGES, 8)).slice(0, 6));
      expect(ids.filter((id) => id.startsWith('p'))).toHaveLength(2);
    });

    it('leaves a search of everything as it was: 2,000 rows a side at most', async () => {
      const sent = await sentBy(() => found({ queryVector: AMONG_PAGES }));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain(`set_config('hnsw.max_scan_tuples', '${SIDE_ROWS_MAX}', true)`);
    });
  });

  describe('a search of everything for more than a few results', () => {
    /** The vector statement a search sends, run under EXPLAIN: its walks of the index, one line each. */
    const walksOf = async (k: number, queryVector: number[], on: Store = store): Promise<{ ids: string[]; sql: string; params?: unknown[]; walks: string[] }> => {
      const sent: { sql: string; params?: unknown[] }[] = [];
      const query = store.query.bind(store);
      store.query = ((sql: string, params?: unknown[]) => {
        if (sql.includes('<=>')) sent.push({ sql, params });
        return query(sql, params);
      }) as typeof store.query;
      let ids: string[];
      try {
        ids = (await search(on, embedder, 'chunk', { k, mode: 'vector', track: false, current: false, queryVector })).map((r) => r.chunkId);
      } finally {
        store.query = query;
      }
      expect(sent).toHaveLength(1);
      const plan = (await store.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) ${sent[0].sql}`, sent[0].params)).map((r) => r['QUERY PLAN']);
      return { ids, sql: sent[0].sql, params: sent[0].params, walks: plan.filter((line) => line.includes('Index Scan using embeddings_hnsw_idx')) };
    };
    const rowsOf = (line: string) => Number(/actual rows=(\d+)/.exec(line)![1]);

    it('reads as many of the nearest chunks as the search needs candidates, and five thirds of that', () => {
      // a search for 8 asks each channel for 24, for 20 it asks for 60, the evaluation's 24 for 72
      expect([24, 60, 72].map(nearestFor)).toEqual([NEAREST_OF_ALL, 100, 120]);
      expect(nearestFor(1)).toBe(NEAREST_OF_ALL);
      // no wider than the index can be asked to search
      expect(nearestFor(5000)).toBe(1000);
    });

    it('walks on for the sources only when the nearest hold too few, for 20 results as for 8', async () => {
      // among the reports the nearest chunks are all sources: one walk, and the walk on never starts
      for (const k of [8, 20, 24]) {
        const { ids, walks } = await walksOf(k, AMONG_REPORTS);
        expect(ids).toHaveLength(k);
        expect(ids.every((id) => id.startsWith('m'))).toBe(true);
        expect(walks).toHaveLength(2);
        expect(rowsOf(walks[0])).toBe(nearestFor(Math.max(k * 3, 24)));
        expect(walks[1]).toContain('never executed');
      }
      // among the pages they hold no source, and the walk goes on: the mechanism is still there
      const { walks } = await walksOf(20, AMONG_PAGES);
      expect(walks[1]).not.toContain('never executed');
    });

    it('gives the pages those among the nearest forty, however wide the walk', async () => {
      // among the pages every one of the nearest hundred is a page. Forty are the pages' side, as in a search
      // for 8, not the sixty of them a search for 20 asks a channel for: the wider walk is for the sources'
      // count, not a way for more pages to stand before them
      const { sql, params, walks } = await walksOf(20, AMONG_PAGES);
      expect(rowsOf(walks[0])).toBe(100);
      const rows = await store.query<{ chunk_id: string; generated: boolean }>(sql, params);
      const pages = rows.filter((r) => r.generated);
      expect(pages).toHaveLength(NEAREST_OF_ALL);
      expect(pages.every((r) => r.chunk_id.startsWith('p'))).toBe(true);
    });

    it('widens the one walk a library without the iterative scan makes, too', async () => {
      const { ids, sql, walks } = await walksOf(20, AMONG_REPORTS, withoutIterativeScan());
      expect(sql).not.toContain('hnsw.iterative_scan');
      expect(sql).toContain(`'hnsw.ef_search'`);
      // one walk ends at `hnsw.ef_search` rows: forty would leave a search for 20 with 40 candidates of the 60
      expect(rowsOf(walks[0])).toBe(100);
      expect(ids).toHaveLength(20);
      expect(await store.query(`SHOW hnsw.ef_search`)).toEqual([{ 'hnsw.ef_search': '40' }]);
    });
  });
});
