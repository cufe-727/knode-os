import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseConfig } from '../src/config.js';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import { NEAREST_OF_ALL, nearestFor, SCOPED_ROWS_MAX, scopedReadRows, scopedRows, search, searchExplained, SIDE_ROWS_MAX } from '../src/search/search.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../src/store/db.js';
import { resolveScopeFilter } from '../src/store/resolver.js';

/**
 * A search its caller scoped — to the wiki, to a folder, to pages — gets its
 * candidates from the vector channel, wherever the scope's chunks lie from
 * the question.
 *
 * The index here is large enough that no side of it is read whole without a
 * filter, and its vector index is walked: 3,000 generated pages around one
 * direction (and 600 more, timelines, off on their own), 30,400 reports around
 * another, a small folder (`near`, 500)
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
  { id: 'g', dir: 'wiki/timelines', root: 'wiki', kind: 'view', n: 600, around: [0, -1, 0, 0] },
  { id: 'm', dir: 'raw/docs/main', root: 'docs', kind: 'source', n: 30400, around: [1, 1, 0, 0] },
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
    // raw/docs/far is the one folder a tracked import brought in, in 2020: a search as of 2021 sees it alone,
    // and so does a search for trusted sources
    await store.query(
      `INSERT INTO scopes (id, kind, key, sha, status, applied_at, trust)
       SELECT 'sc-' || id, 'doc', path, 'x', 'applied', '2020-01-01T00:00:00Z', 'trusted' FROM documents WHERE path LIKE 'raw/docs/far/%'`,
    );
    await store.query(`UPDATE documents SET scope_id = 'sc-' || id WHERE path LIKE 'raw/docs/far/%'`);
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

  /** `walked`: no side is read (`exactSide: 0`), so each gets the statement a side too large to read gets. */
  const found = async (opts: { sources?: string[]; kinds?: string[]; queryVector?: number[]; k?: number; mode?: 'vector' | 'hybrid'; on?: Store; walked?: boolean }) =>
    (await search(opts.on ?? store, embedder, 'chunk', {
      k: opts.k ?? 8, mode: opts.mode ?? 'vector', track: false, current: false, queryVector: opts.queryVector ?? AMONG_PAGES,
      ...(opts.walked ? { exactSide: 0 } : {}),
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

  /**
   * A store on which a walk of the index comes back with nothing, whatever index it walked (which rows a
   * walk reaches within its limit depends on how the index was built): the statements that walk the index
   * return no row, every other statement is the store's own. `sent` lists the vector statements.
   */
  const walksFindNothing = (): { on: Store; sent: string[] } => {
    const sent: string[] = [];
    const on = Object.create(store) as Store;
    on.query = ((sql: string, params?: unknown[]) => {
      if (!sql.includes('<=>')) return store.query(sql, params);
      sent.push(sql);
      return sql.includes('ORDER BY e.embedding <=>') ? Promise.resolve([]) : store.query(sql, params);
    }) as typeof store.query;
    return { on, sent };
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
      // the question among the 500 reports of raw/docs/near: the nearest forty chunks of all hold no page.
      // Either search, of pages too many to read (here they are read, and the walk is asked for), sends the
      // walk for the pages alone, with the narrowed search's rows to walk (how many pages a walk comes on
      // within them depends on how the index was built: 3,600 lie among 45,850)
      const sent: string[] = [];
      const watched = Object.create(store) as Store;
      watched.query = ((sql: string, params?: unknown[]) => {
        if (sql.includes('<=>')) sent.push(sql);
        return store.query(sql, params);
      }) as typeof store.query;
      const byKind = await found({ kinds: ['view'], queryVector: AMONG_NEAR, on: watched, walked: true });
      const bySource = await found({ sources: ['wiki'], queryVector: AMONG_NEAR, on: watched, walked: true });
      expect(sent).toHaveLength(2);
      for (const sql of sent) {
        expect(sql).toContain('true AS generated, true AS walked');
        expect(sql).toContain(`set_config('hnsw.max_scan_tuples', '2967', true)`);
        expect(sql).not.toContain('UNION ALL');
      }
      expect(bySource).toEqual(byKind);
      expect(bySource.every((id) => /^[pg]/.test(id))).toBe(true);
      // And what the search returns, which the statement alone does not hold (an empty answer passes every
      // line above): asked as any caller asks, the pages are read, and the eight are the nearest pages by a
      // scan of every vector — none of them among the nearest forty chunks of all, which are reports.
      const nearest = await exact('wiki', AMONG_NEAR, 8);
      expect(nearest).toHaveLength(8);
      expect((await exact('raw/docs/near', AMONG_NEAR, 40)).length).toBe(40);
      for (const scope of [{ kinds: ['view'] }, { sources: ['wiki'] }, { sources: ['wiki/entities', 'wiki/timelines'] }]) {
        const { results, channels } = await searchExplained(store, embedder, 'chunk', {
          k: 8, mode: 'vector', track: false, current: false, queryVector: AMONG_NEAR, filter: resolveScopeFilter(scope),
        });
        expect(results.map((r) => r.chunkId)).toEqual(nearest);
        expect(results.map((r) => r.signals.vector!)).toEqual(results.map((r) => r.signals.vector!).sort((a, b) => b - a));
        expect(channels.vector).toEqual({ hits: 24, ms: expect.any(Number) });
      }
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

    it('reads a side half as large again as the rows of its walk, rather than walk for it', async () => {
      // a walk has 2,967 rows on this index and a side of 4,451 chunks at the most is read: a folder a little
      // over the walk's rows and away from the question was walked for to the last row and came back short,
      // where reading it costs little more and returns its nearest
      expect(scopedReadRows(24, 45_850)).toBe(4451);
      expect(scopedReadRows(24, 566_914)).toBe(15_000);
      for (const [dir, n] of [['raw/docs/behind', 3200], ['raw/docs/deep', 3500]] as const) {
        expect(n).toBeGreaterThan(scopedRows(24, 45_850));
        const sent = await sentBy(async () => {
          expect(await found({ sources: [dir] })).toEqual(await exact(dir, AMONG_PAGES, 8));
        });
        expect(sent).toHaveLength(1);
        expect(sent[0]).not.toContain('set_config');
      }
      // the pages, 3,600 of them, by kind and by place: the same eight, the nearest
      const pages = await exact('wiki', AMONG_NEAR, 8);
      expect(await found({ kinds: ['view'], queryVector: AMONG_NEAR })).toEqual(pages);
      expect(await found({ sources: ['wiki'], queryVector: AMONG_NEAR })).toEqual(pages);
    });

    it('returns what the walk found of a side too large to read, and says the channel is partial', async () => {
      const partialOf = async (on: Store, scope: { sources?: string[]; kinds?: string[] }, queryVector: number[], mode: 'vector' | 'hybrid' = 'vector') =>
        searchExplained(on, embedder, 'chunk', { k: 8, mode, track: false, current: false, queryVector, filter: resolveScopeFilter(scope) });
      const { on: unreached, sent: vectorStatements } = walksFindNothing();
      // A folder too large for a narrowed search to read, 30,400 chunks. Nothing is read after the walk: the
      // first so-many chunks of a folder are not its nearest, and a search answered from them looked as well
      // ranked as any other.
      for (const [dir, n] of [['raw/docs/main', 30400]] as const) {
        expect(n).toBeGreaterThan(scopedReadRows(24, 45_850));
        vectorStatements.length = 0;
        const { results, channels } = await partialOf(unreached, { sources: [dir] }, AMONG_PAGES);
        expect(vectorStatements).toHaveLength(1);
        expect(results).toEqual([]);
        expect(channels.vector).toMatchObject({ hits: 0, partial: expect.stringMatching(/ended at its limit of 2967 rows with 0 of the 24 sources asked for/) });
      }
      // a hybrid search goes on with its other channels, and carries the mark
      const hybrid = await partialOf(unreached, { sources: ['raw/docs/main'] }, AMONG_PAGES, 'hybrid');
      expect(hybrid.results).toHaveLength(8);
      expect(hybrid.results.every((r) => r.chunkId.startsWith('m'))).toBe(true);
      expect(hybrid.channels.vector?.partial).toBeDefined();
      // On the index itself, with a library that walks on or one that does not: whatever the walk returns is
      // the folder's, in one statement, and short of what was asked the channel says so. A side that is read,
      // or a walk that found what was asked for, is not partial.
      for (const on of [store, withoutIterativeScan()]) {
        for (const [dir, letter] of [['raw/docs/deep', 'e'], ['raw/docs/main', 'm']] as const) {
          const sent = await sentBy(async () => {
            const { results, channels } = await partialOf(on, { sources: [dir] }, AMONG_PAGES);
            expect(results.every((r) => r.chunkId.startsWith(letter))).toBe(true);
            expect(channels.vector?.partial === undefined).toBe((channels.vector?.hits ?? 0) >= 24);
          });
          expect(sent).toHaveLength(1);
        }
        expect((await partialOf(on, { sources: ['raw/docs/far'] }, AMONG_PAGES)).channels.vector).toMatchObject({ hits: 24 });
        expect((await partialOf(on, { sources: ['raw/docs/far'] }, AMONG_PAGES)).channels.vector?.partial).toBeUndefined();
      }
      expect((await partialOf(store, { sources: ['raw/docs/main'] }, AMONG_REPORTS)).channels.vector?.partial).toBeUndefined();
    });

    it('costs a search as of a date, for a trust tier or for an actor as it costs one narrowed to a folder', async () => {
      // each leaves raw/docs/far alone, 2,500 chunks away from the question: more than a search of everything
      // spends on a side, within what a narrowed one reads
      const nearest = await exact('raw/docs/far', AMONG_PAGES, 8);
      const base = { k: 8, track: false, current: false, queryVector: AMONG_PAGES };
      for (const narrowing of [{ asOf: '2021-01-01T00:00:00Z' }, { filter: resolveScopeFilter({ trust: 'trusted' }) }, { filter: resolveScopeFilter({ actor: 'reader' }) }]) {
        const results = await search(store, embedder, 'chunk', { ...base, mode: 'vector', ...narrowing });
        expect(results.map((r) => r.chunkId)).toEqual(nearest);
        // a hybrid search has its vector channel's 24 beside the others'
        const hybrid = await searchExplained(store, embedder, 'chunk', { ...base, mode: 'hybrid', ...narrowing });
        expect(hybrid.channels.vector).toMatchObject({ hits: 24 });
        expect(hybrid.results).toHaveLength(8);
      }
    });

    it('holds a walk to the rows of a narrowed search, and two walks to half of them each', async () => {
      // the rows: as before on an index this size, and 10,000 at the most on any
      expect(scopedRows(24, 45_850)).toBe(2967);
      expect([24, 60].map((k) => scopedRows(k, 566_914))).toEqual([SCOPED_ROWS_MAX, SCOPED_ROWS_MAX]);
      expect(SCOPED_ROWS_MAX).toBe(10_000);
      const limitOf = (sql: string) => Number(/set_config\('hnsw.max_scan_tuples', '(\d+)'/.exec(sql)?.[1]);
      // both sides walked for (30,400 reports, and the pages as if they were too many to read): two walks, half each
      let sent = await sentBy(() => found({ sources: ['raw/docs/main', 'wiki'], queryVector: AMONG_REPORTS, walked: true }));
      expect(sent).toHaveLength(1);
      expect(limitOf(sent[0])).toBe(Math.floor(2967 / 2));
      // one side walked alone has them all
      sent = await sentBy(() => found({ sources: ['raw/docs/main'], queryVector: AMONG_REPORTS }));
      expect(limitOf(sent[0])).toBe(2967);
    });

    it('walks the index for a side too large to read, whatever the planner makes of the filter', async () => {
      // 3,200 chunks of 45,850: a filter the planner may judge narrow enough to rank without the index, which
      // is a read of the side — on the finance copy it read 34,000 chunks of four folders that way. The walk
      // is a step of its own, 2,967 rows of the index at the most, and the statement can do no more.
      const sent: { sql: string; params?: unknown[] }[] = [];
      const watched = Object.create(store) as Store;
      watched.query = ((sql: string, params?: unknown[]) => {
        if (sql.includes('<=>')) sent.push({ sql, params });
        return store.query(sql, params);
      }) as typeof store.query;
      for (const dir of ['raw/docs/behind', 'raw/docs/deep', 'raw/docs/main']) {
        sent.length = 0;
        await found({ sources: [dir], on: watched, walked: true });
        expect(sent).toHaveLength(1);
        const plan = (await store.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) ${sent[0].sql}`, sent[0].params)).map((r) => r['QUERY PLAN']);
        const walk = plan.filter((line) => line.includes('Index Scan using embeddings_hnsw_idx'));
        expect(walk).toHaveLength(1);
        expect(Number(/actual rows=(\d+)/.exec(walk[0])![1])).toBeLessThanOrEqual(2967);
        // and nothing reads the side's vectors another way: only those of the rows returned, 24 at the most
        expect(plan.some((line) => line.includes('Seq Scan on embeddings'))).toBe(false);
        const byKey = plan.filter((line) => line.includes('embeddings_pkey'));
        expect(byKey).toHaveLength(1);
        expect(Number(/loops=(\d+)/.exec(byKey[0])?.[1] ?? 0)).toBeLessThanOrEqual(24);
      }
    });

    it('does not count again, within the minute, a side it found too large to read or empty', async () => {
      const counts: string[] = [];
      const counting = Object.create(store) as Store;
      counting.query = ((sql: string, params?: unknown[]) => {
        if (/SELECT count\(\*\)::int FROM \(\s*SELECT 1 FROM documents d/.test(sql)) counts.push(sql);
        return store.query(sql, params);
      }) as typeof store.query;
      const filter = resolveScopeFilter({ sources: ['raw/docs/main'] });
      for (let i = 0; i < 3; i++) await search(counting, embedder, 'chunk', { k: 8, mode: 'vector', track: false, current: false, queryVector: AMONG_FRONT, filter });
      // 30,400 chunks of sources, past the 4,451 a narrowed search reads, and no page: both counted by the
      // first search, in one statement, and by no other
      expect(counts).toHaveLength(1);
      expect(counts[0]).toContain(' AS n1');
      // a folder small enough to read is counted by each search, its documents and then their chunks: what
      // it holds decides what is read. Its pages, of which there are none, are counted by the first alone.
      counts.length = 0;
      for (let i = 0; i < 2; i++) await search(counting, embedder, 'chunk', { k: 8, mode: 'vector', track: false, current: false, queryVector: AMONG_FRONT, filter: resolveScopeFilter({ sources: ['raw/docs/near'] }) });
      expect(counts).toHaveLength(4);
      expect(counts.map((sql) => sql.includes(' AS n1'))).toEqual([true, false, false, false]);
    });

    it('gives each side of a scoped search its candidates', async () => {
      // a folder of 2,500 chunks and the 3,600 pages: each is read, and the eight are the folder's nearest six
      // and the pages' nearest two — a quarter of the places, whichever lies nearer the question
      for (const question of [AMONG_PAGES, AMONG_REPORTS, AMONG_FRONT]) {
        const { results, channels } = await searchExplained(store, embedder, 'chunk', {
          k: 8, mode: 'vector', track: false, current: false, queryVector: question, filter: resolveScopeFilter({ sources: ['raw/docs/far', 'wiki'] }),
        });
        expect(channels.vector).toEqual({ hits: 48, ms: expect.any(Number) });
        const ids = results.map((r) => r.chunkId);
        expect(ids).toHaveLength(8);
        const folder = await exact('raw/docs/far', question, 8);
        const pages = await exact('wiki', question, 8);
        const places = ids.filter((id) => /^[pg]/.test(id)).length;
        // the pages take two places where they are the nearer, and none past their quarter
        expect(places).toBeLessThanOrEqual(2);
        expect(ids.filter((id) => /^[pg]/.test(id))).toEqual(pages.slice(0, places));
        expect(ids.filter((id) => id.startsWith('f'))).toEqual(folder.slice(0, 8 - places));
      }
      // among the pages they are the nearer: two of them, six of the folder
      expect((await found({ sources: ['raw/docs/far', 'wiki'] })).filter((id) => id.startsWith('p'))).toEqual((await exact('wiki', AMONG_PAGES, 8)).slice(0, 2));
    });

    it('leaves a search of everything as it was: 2,000 rows a side at most', async () => {
      const sent = await sentBy(() => found({ queryVector: AMONG_PAGES }));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain(`set_config('hnsw.max_scan_tuples', '${SIDE_ROWS_MAX}', true)`);
    });
  });

  describe('the two sides of a narrowed search', () => {
    const explained = (on: Store, sources: string[], queryVector: number[]) =>
      searchExplained(on, embedder, 'chunk', { k: 8, mode: 'vector', track: false, current: false, queryVector, filter: resolveScopeFilter({ sources }) });

    it('reads each side that is small enough to read, whatever the other side took', async () => {
      // 2,500 chunks of a folder and 600 of timelines: each within the 2,967 a narrowed search reads of a side,
      // 3,100 together. Read one after the other out of one budget, the timelines left the folder 2,367 rows
      // to be walked for, and from among the reports the walk found none of it.
      const { results, channels } = await explained(store, ['raw/docs/far', 'wiki/timelines'], AMONG_REPORTS);
      expect(channels.vector).toEqual({ hits: 48, ms: expect.any(Number) });
      const ids = results.map((r) => r.chunkId);
      expect(ids.filter((id) => id.startsWith('f'))).toEqual((await exact('raw/docs/far', AMONG_REPORTS, 8)).slice(0, 6));
      expect(ids.filter((id) => id.startsWith('g'))).toEqual((await exact('wiki/timelines', AMONG_REPORTS, 8)).slice(0, 2));
    });

    it('gives a walk its rows whatever was read beside it', async () => {
      // the timelines are read; the reports, 30,400 of them, are walked for with the walk's own 2,967 rows
      const sent: string[] = [];
      const watched = Object.create(store) as Store;
      watched.query = ((sql: string, params?: unknown[]) => {
        if (sql.includes('<=>')) sent.push(sql);
        return store.query(sql, params);
      }) as typeof store.query;
      const { results, channels } = await explained(watched, ['raw/docs/main', 'wiki/timelines'], AMONG_REPORTS);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain(`set_config('hnsw.max_scan_tuples', '2967', true)`);
      expect(sent[0]).toContain('LIMIT 2967');
      // 24 of each side: the reports the walk found (they are the nearest, and take the 8) and the timelines read
      expect(channels.vector).toEqual({ hits: 48, ms: expect.any(Number) });
      expect(results.map((r) => r.chunkId)).toHaveLength(8);
      expect(results.every((r) => r.chunkId.startsWith('m'))).toBe(true);
    });

    it('says so when the walk that looks for pages beside the sources ran out', async () => {
      // sources and pages both too many to read (here they are not, and no side is read): the pages are those
      // among the nearest forty chunks the filter leaves, and a walk that ends before it has forty has not
      // shown there are none
      const { on, sent } = walksFindNothing();
      const { channels } = await searchExplained(on, embedder, 'chunk', {
        k: 8, mode: 'vector', track: false, current: false, queryVector: AMONG_REPORTS, exactSide: 0, filter: resolveScopeFilter({ sources: ['raw/docs/far', 'wiki'] }),
      });
      expect(sent).toHaveLength(1);
      expect(channels.vector?.partial).toMatch(/ended at its limit of 1483 rows with 0 of the 24 sources asked for and 0 of the 24 pages asked for/);
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

  // last in the file: it adds documents to the index, and takes them away again
  describe('what a search remembers of its sides', () => {
    /** Statements sent past the store, as another process writing the same database sends them. */
    const elsewhere = (sql: string, params?: unknown[]) =>
      (store as unknown as { db: { query(sql: string, params?: unknown[]): Promise<unknown> } }).db.query(sql, params);
    const countsOf = () => {
      const counts: string[] = [];
      const on = Object.create(store) as Store;
      on.query = ((sql: string, params?: unknown[]) => {
        if (/SELECT count\(\*\)::int FROM \(\s*SELECT 1 FROM documents d/.test(sql)) counts.push(sql);
        return store.query(sql, params);
      }) as typeof store.query;
      return { on, counts };
    };

    it('does not answer nothing from a count it remembers', async () => {
      // a folder with nothing in it: no result, and its sides remembered as empty
      expect(await found({ sources: ['raw/docs/fresh'] })).toEqual([]);
      expect(await found({ sources: ['raw/docs/fresh'] })).toEqual([]);
      try {
        // fifty documents arrive, written by another process: nothing this store sent says so
        await elsewhere(
          `INSERT INTO documents (id, path, root, kind, title, sha256, bytes, status)
           SELECT 'd-x' || i, 'raw/docs/fresh/x' || i || '.md', 'docs', 'source', 'x' || i, 'sha-x' || i, 10, 'indexed' FROM generate_series(1, 50) i`,
        );
        await elsewhere(
          `INSERT INTO chunks (id, document_id, seq, content, token_count, tsv)
           SELECT 'x' || i, 'd-x' || i, 0, 'chunk x' || i, 2, to_tsvector('simple', 'chunk') FROM generate_series(1, 50) i`,
        );
        await elsewhere(
          `INSERT INTO embeddings (chunk_id, model, embedding)
           SELECT 'x' || i, 'fixture-v1', ('[1,' || i / 100.0 || ',0,0]')::${VECTOR_TYPE} FROM generate_series(1, 50) i`,
        );
        // the next search of the folder, at once: its eight nearest, not the nothing that was remembered
        const { results, channels } = await searchExplained(store, embedder, 'chunk', {
          k: 8, mode: 'vector', track: false, current: false, queryVector: AMONG_PAGES, filter: resolveScopeFilter({ sources: ['raw/docs/fresh'] }),
        });
        expect(results.map((r) => r.chunkId)).toEqual(['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8']);
        expect(channels.vector).toEqual({ hits: 24, ms: expect.any(Number) });
      } finally {
        await elsewhere(`DELETE FROM embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id LIKE 'd-x%')`);
        await elsewhere(`DELETE FROM chunks WHERE document_id LIKE 'd-x%'`);
        await elsewhere(`DELETE FROM documents WHERE id LIKE 'd-x%'`);
      }
    });

    it('counts a side again once the store has written documents or chunks', async () => {
      const { on, counts } = countsOf();
      const narrowed = { k: 8, mode: 'vector' as const, track: false, current: false, queryVector: AMONG_REPORTS, filter: resolveScopeFilter({ sources: ['raw/docs/main'] }) };
      await search(on, embedder, 'chunk', narrowed);
      counts.length = 0;
      // remembered: the folder is past what is read, and has no pages
      for (let i = 0; i < 2; i++) await search(on, embedder, 'chunk', narrowed);
      expect(counts).toHaveLength(0);
      // a document is written through the store (here, to no effect): what was remembered was counted before it
      await store.query(`UPDATE documents SET title = title WHERE id = 'd-m1'`);
      await search(on, embedder, 'chunk', narrowed);
      expect(counts).toHaveLength(1);
      await search(on, embedder, 'chunk', narrowed);
      expect(counts).toHaveLength(1);
      // the sides of the whole index are kept the same way
      const everything = { k: 8, mode: 'vector' as const, track: false, current: false, queryVector: AMONG_REPORTS };
      await search(on, embedder, 'chunk', everything);
      counts.length = 0;
      await search(on, embedder, 'chunk', everything);
      expect(counts).toHaveLength(0);
      await store.tx(async (q) => q.query(`UPDATE chunks SET token_count = token_count WHERE id = 'm1'`));
      await search(on, embedder, 'chunk', everything);
      expect(counts).toHaveLength(1);
      // a write to anything else leaves them
      await store.setMeta('scoped-sides-test', { at: 1 });
      await search(on, embedder, 'chunk', everything);
      await search(on, embedder, 'chunk', narrowed);
      expect(counts).toHaveLength(2);
    });
  });
});
