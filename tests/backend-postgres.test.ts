import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { defaultConfig, type DatabaseConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { auditDuplicateClaims, claimPairId } from '../src/graph/claim-dedupe.js';
import { createEmbeddingProvider } from '../src/ingest/embeddings.js';
import { rebuild } from '../src/lineage/rebuild.js';
import { applyScope, disposeScope, findLiveScope } from '../src/lineage/scope.js';
import type { LlmClient } from '../src/llm/client.js';
import { resolveWorkspaceScope, WorkspaceContextRegistry } from '../src/server/workspaces.js';
import { dropBackend, schemaNameFor } from '../src/store/backend.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../src/store/db.js';
import { catalogQuery, catalogReaderRole } from '../src/store/catalog.js';

/**
 * Exercises the external-Postgres backend against a real server. Skipped
 * wholesale when no Postgres is reachable, so the suite still runs on a machine
 * (or CI box) that only has the embedded PGlite path.
 */

/**
 * One throwaway database per run, never a fixed name. Two runs can overlap on
 * the same server — a second `vitest run` started while the first is finishing,
 * a watcher, a second checkout or worktree — and a shared name makes them share
 * state: one run's `DROP DATABASE ... WITH (FORCE)` lands while the other is
 * still opening stores, and that run fails with `database "..." does not exist`.
 * The seconds stamp in the name is what lets a later run tell an abandoned
 * database from a live one (see the sweep below).
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

/** Reachable *and* carrying pgvector — both are required for this backend. */
async function postgresReady(): Promise<boolean> {
  const pool = adminPool();
  try {
    const { rows } = await pool.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`);
    return rows.length > 0;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
}

const ready = await postgresReady();
const dirs: string[] = [];

/** Whether this run's database still has the schema a workspace directory maps to. */
async function schemaExists(dir: string): Promise<boolean> {
  const pool = adminPool(dbConfig.database);
  try {
    const { rows } = await pool.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [schemaNameFor(dir, dbConfig.schemaPrefix)]);
    return rows.length > 0;
  } finally {
    await pool.end().catch(() => {});
  }
}

function workspaceDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-pgtest-'));
  dirs.push(dir);
  return dir;
}

/** A run interrupted before its afterAll leaves its database behind; clear those out. */
const STALE_AFTER_SECONDS = 3600;

async function dropAbandonedDatabases(pool: pg.Pool): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - STALE_AFTER_SECONDS;
  // Nobody connected is not enough on its own: a live run sits with zero
  // connections between two `Store.open` calls. The age is what makes this
  // safe, since a run still going carries a name minutes old at most.
  const { rows } = await pool.query<{ datname: string }>(
    `SELECT d.datname FROM pg_database d
      WHERE NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)`,
  );
  for (const { datname } of rows) {
    if (!datname.startsWith(DB_PREFIX)) continue;
    const stamp = Number(datname.slice(DB_PREFIX.length).split('_')[0]);
    if (!Number.isFinite(stamp) || stamp > cutoff) continue;
    // A leftover another user owns is not ours to drop; skip it quietly.
    await pool.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`).catch(() => {});
  }
}

/** Transactions Store.tx ran again, by the warning it logs for each. */
function retries(warn: { mock: { calls: unknown[][] } }): number {
  return warn.mock.calls.filter(([message]) => String(message).includes('transaction rolled back')).length;
}

afterAll(async () => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  if (!ready) return;
  // Every workspace lived in one throwaway database; dropping it takes the
  // schemas with it.
  const pool = adminPool();
  try {
    await pool.query(`DROP DATABASE IF EXISTS "${dbConfig.database}" WITH (FORCE)`);
    await dropAbandonedDatabases(pool);
  } finally {
    await pool.end().catch(() => {});
  }
});

describe.skipIf(!ready)('postgres backend', () => {
  it('names one schema per workspace, distinguishing equal basenames', () => {
    const a = schemaNameFor('/tmp/users/alice/workspaces/default', 'ws');
    const b = schemaNameFor('/tmp/users/bob/workspaces/default', 'ws');
    expect(a).not.toEqual(b);
    expect(a.startsWith('ws_default_')).toBe(true);
    // Postgres truncates identifiers past 63 bytes; names must fit as-is.
    expect(schemaNameFor('/tmp/' + 'x'.repeat(200), 'ws').length).toBeLessThanOrEqual(63);
  });

  it('creates the schema, migrates it, and indexes halfvec embeddings', async () => {
    const dir = workspaceDir();
    const store = await Store.open(dir, 2048, dbConfig);
    try {
      expect(store.migration.to).toBeGreaterThan(0);

      // The pool's search_path must land us in this workspace's own schema.
      const [{ schema }] = await store.query<{ schema: string }>(`SELECT current_schema() AS schema`);
      expect(schema).toBe(schemaNameFor(dir, dbConfig.schemaPrefix));

      const [col] = await store.query<{ type: string }>(
        `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
         WHERE attrelid = 'embeddings'::regclass AND attname = 'embedding'`,
      );
      expect(col.type).toBe(`${VECTOR_TYPE}(2048)`);

      // 2048 dims would exceed pgvector's 2000-dim index cap for `vector`;
      // halfvec is what keeps this index reachable. Scope the lookup to this
      // schema — sibling workspaces carry an identically named table.
      const idx = await store.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
         WHERE schemaname = current_schema() AND indexname = 'embeddings_hnsw_idx'`,
      );
      expect(idx).toHaveLength(1);
      expect(idx[0].indexdef).toContain(`hnsw (embedding ${VECTOR_TYPE}_cosine_ops)`);
    } finally {
      await store.close();
    }
  });

  it('round-trips a vector and rolls transactions back', async () => {
    const store = await Store.open(workspaceDir(), 2048, dbConfig);
    try {
      const vec = Array.from({ length: 2048 }, (_, i) => Math.sin(i) / 40);
      await store.tx(async (q) => {
        await q.query(
          `INSERT INTO documents (id, path, root, title, sha256, bytes, status)
           VALUES ('d1', '/tmp/a.md', 'raw', 'A', 'sha', 1, 'indexed')`,
        );
        await q.query(
          `INSERT INTO chunks (id, document_id, seq, content, token_count, tsv)
           VALUES ('c1', 'd1', 0, 'hello', 1, to_tsvector('simple', 'hello'))`,
        );
        await q.query(
          `INSERT INTO embeddings (chunk_id, model, embedding) VALUES ($1, $2, $3::${VECTOR_TYPE})`,
          ['c1', 'test-model', toVectorLiteral(vec)],
        );
      });

      const [hit] = await store.query<{ chunk_id: string; score: number }>(
        `SELECT chunk_id, 1 - (embedding <=> $1::${VECTOR_TYPE}) AS score
         FROM embeddings ORDER BY embedding <=> $1::${VECTOR_TYPE} LIMIT 1`,
        [toVectorLiteral(vec)],
      );
      expect(hit.chunk_id).toBe('c1');
      expect(Number(hit.score)).toBeCloseTo(1, 2);

      await expect(
        store.tx(async (q) => {
          await q.query(
            `INSERT INTO documents (id, path, root, sha256, bytes) VALUES ('d2', '/tmp/b.md', 'raw', 's', 1)`,
          );
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      const [{ count }] = await store.query<{ count: string }>(`SELECT count(*)::text AS count FROM documents`);
      expect(count).toBe('1');
    } finally {
      await store.close();
    }
  });

  it('keeps workspaces isolated inside the shared database', async () => {
    const a = await Store.open(workspaceDir(), 2048, dbConfig);
    const b = await Store.open(workspaceDir(), 2048, dbConfig);
    try {
      await a.query(
        `INSERT INTO documents (id, path, root, sha256, bytes) VALUES ('only-in-a', '/tmp/a.md', 'raw', 's', 1)`,
      );
      // Same table name, same database, different schema: B must not see it.
      expect(await b.query(`SELECT id FROM documents`)).toEqual([]);
      expect(await a.query<{ id: string }>(`SELECT id FROM documents`)).toEqual([{ id: 'only-in-a' }]);

      const [{ count }] = await b.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_tables WHERE tablename = 'documents'`,
      );
      expect(Number(count)).toBeGreaterThanOrEqual(2);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('drops one workspace schema whole, leaves the others, and the next open starts empty', async () => {
    const dir = workspaceDir();
    const a = await Store.open(dir, 2048, dbConfig);
    const b = await Store.open(workspaceDir(), 2048, dbConfig);
    try {
      await a.query(`INSERT INTO documents (id, path, root, sha256, bytes) VALUES ('stale', '/tmp/a.md', 'raw', 's', 1)`);
      await b.query(`INSERT INTO documents (id, path, root, sha256, bytes) VALUES ('kept', '/tmp/b.md', 'raw', 's', 1)`);
      await a.close();

      // B's pool stays open throughout: idle connections to another schema do not hold the drop up
      await dropBackend(dir, dbConfig);
      expect(await schemaExists(dir)).toBe(false);

      const reopened = await Store.open(dir, 2048, dbConfig);
      try {
        expect(reopened.migration.from).toBe(0);
        expect(await reopened.query(`SELECT id FROM documents`)).toEqual([]);
      } finally {
        await reopened.close();
      }
      expect(await b.query<{ id: string }>(`SELECT id FROM documents`)).toEqual([{ id: 'kept' }]);
    } finally {
      await b.close();
    }
  });

  it('treats a schema or a database that was never created as nothing to drop', async () => {
    const dir = workspaceDir();
    await dropBackend(dir, dbConfig);
    expect(await schemaExists(dir)).toBe(false);

    const absent = `${runDatabase}_absent`;
    await dropBackend(dir, { ...dbConfig, database: absent });
    const pool = adminPool();
    try {
      // and dropping does not create it
      expect((await pool.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [absent])).rows).toEqual([]);
    } finally {
      await pool.end().catch(() => {});
    }
  });

  it('clears a workspace down to a new schema, not an emptied directory over the old one', async () => {
    const templateConfig = defaultConfig();
    templateConfig.database = { ...dbConfig };
    const registry = new WorkspaceContextRegistry(workspaceDir(), { templateConfig });
    const scope = resolveWorkspaceScope({ user: 'alice', kind: 'personal', id: 'default', name: 'Default' });
    try {
      const ctx = await registry.get(scope);
      // a row no file reproduces, like a chat or a research job
      await ctx.store.query(`INSERT INTO suggestions (id, kind, title, body) VALUES ('stale', 'skill', 'stale', 'stale')`);
      await registry.reset(scope);
      const fresh = await registry.get(scope);
      expect(await fresh.store.query(`SELECT id FROM suggestions`)).toEqual([]);
    } finally {
      await registry.closeAll();
    }
  });

  it('rebuilds into a new schema, so rows no file reproduces are gone', async () => {
    const dir = workspaceDir();
    fs.writeFileSync(path.join(dir, 'knode.config.json'), JSON.stringify({ database: dbConfig }));
    const ctx = await createContext(dir);
    try {
      await ctx.store.query(`INSERT INTO suggestions (id, kind, title, body) VALUES ('stale', 'skill', 'stale', 'stale')`);
      await rebuild(ctx);
      expect(await ctx.store.query(`SELECT id FROM suggestions`)).toEqual([]);
      expect(await schemaExists(dir)).toBe(true);
    } finally {
      await ctx.store.close();
    }
  });

  it('refuses to drop a schema an extension lives in', async (t) => {
    const dir = workspaceDir();
    await (await Store.open(dir, 2048, dbConfig)).close();
    const schema = schemaNameFor(dir, dbConfig.schemaPrefix);
    const pool = adminPool(dbConfig.database);
    try {
      // CASCADE would take the extension, and its types in every other workspace, with it
      try {
        await pool.query(`CREATE EXTENSION citext SCHEMA "${schema}"`);
      } catch {
        t.skip();
      }
      await expect(dropBackend(dir, dbConfig)).rejects.toThrow(/holds the extension citext/);
      expect(await schemaExists(dir)).toBe(true);
    } finally {
      await pool.query(`DROP EXTENSION IF EXISTS citext`).catch(() => {});
      await pool.end().catch(() => {});
    }
  });

  it('runs the nightly claim audit over more candidate pairs than one statement can bind', async () => {
    const store = await Store.open(workspaceDir(), 2048, dbConfig);
    try {
      // one subject, n claims sharing a number: every one of the n(n-1)/2 pairs is a candidate
      const n = 370;
      await store.query(`INSERT INTO entities (id, name, type) VALUES ('jia', '甲公司', 'organization')`);
      await store.query(
        `INSERT INTO claims (id, subject_id, statement)
         SELECT 'claim-' || g, 'jia', '第' || g || '项业务收入同比增长20%' FROM generate_series(1, $1::int) AS g`,
        [n],
      );
      const pairs: string[] = [];
      for (let i = 1; i <= n; i++) for (let j = i + 1; j <= n; j++) pairs.push(claimPairId(`claim-${i}`, `claim-${j}`));
      expect(pairs.length).toBeGreaterThan(65_535);
      // every pair but the first already has a remembered verdict
      await store.query(
        `INSERT INTO claim_pair_verdicts (pair_id, a_id, b_id, relation) SELECT id, '', '', 'unrelated' FROM unnest($1::text[]) AS id`,
        [pairs.slice(1)],
      );

      const judged: number[] = [];
      // the audit's judge calls go through complete(), whose reply is read as JSON (src/work/judge.ts)
      const llm = {
        enabled: true,
        label: 'stub',
        complete: async (messages: { role: string; content: string }[]) => {
          judged.push([...(messages.at(-1)?.content ?? '').matchAll(/^Pair \d+ — /gm)].length);
          return JSON.stringify({ verdicts: [] });
        },
      } as unknown as LlmClient;
      const config = defaultConfig();
      const stats = await auditDuplicateClaims({ store, embedder: createEmbeddingProvider(config.embedding), config, llm });
      expect(stats.candidates).toBe(pairs.length);
      expect(judged).toEqual([1]);
    } finally {
      await store.close();
    }
  });

  it('runs a transaction again when Postgres picks it as a deadlock victim', async () => {
    const store = await Store.open(workspaceDir(), 2048, dbConfig);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await store.exec(`CREATE TABLE deadlock_probe (id INT PRIMARY KEY, n INT NOT NULL); INSERT INTO deadlock_probe VALUES (1, 0), (2, 0);`);
      // each transaction holds one row before either asks for the other's
      const runs = [0, 0];
      let holding = 0;
      let bothHold!: () => void;
      const crossed = new Promise<void>((resolve) => (bothHold = resolve));
      const cross = (i: number, first: number, second: number) =>
        store.tx(async (q) => {
          runs[i]++;
          await q.query(`UPDATE deadlock_probe SET n = n + 1 WHERE id = $1`, [first]);
          if (runs[i] === 1) {
            if (++holding === 2) bothHold();
            await crossed;
          }
          await q.query(`UPDATE deadlock_probe SET n = n + 1 WHERE id = $1`, [second]);
        });
      await Promise.all([cross(0, 1, 2), cross(1, 2, 1)]);
      // Postgres aborted one of them (40P01), which ran again once the other committed
      expect([...runs].sort()).toEqual([1, 2]);
      expect(retries(warn)).toBe(1);
      expect(await store.query(`SELECT n FROM deadlock_probe ORDER BY id`)).toEqual([{ n: 2 }, { n: 2 }]);
    } finally {
      warn.mockRestore();
      await store.close();
    }
  });

  it('queues concurrent scope transactions on the ledger instead of deadlocking them', async () => {
    const store = await Store.open(workspaceDir(), 2048, dbConfig);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // documents that all name one hub entity, like a sync's re-indexes and remote tier-1 writes
      const apply = (key: string, sha: string) =>
        applyScope(store, { kind: 'doc', key }, sha, { actor: 'test' }, async (w) => {
          await w.entity({ name: '宁德时代', type: 'organization' }, { extractor: 'test' });
          await w.entity({ name: `${key} ${sha}`, type: 'concept' }, { extractor: 'test' });
        });
      const keys = Array.from({ length: 12 }, (_, i) => `raw/docs/${i}.md`);
      for (const key of keys) await apply(key, 'v1');
      const scopes = await Promise.all(keys.map((key) => findLiveScope(store, 'doc', key)));

      // half of them change while the other half are removed, all at once: a
      // dispose used to lock the hub in its fold and only then the ledger,
      // while an apply held the ledger and waited for the hub
      await Promise.all(keys.map((key, i) => (i % 2 ? apply(key, 'v2') : disposeScope(store, scopes[i]!.id, { actor: 'test', reason: 'removed' }))));
      expect(retries(warn)).toBe(0);
      expect(await store.query(`SELECT count(*)::int AS n FROM scopes WHERE status = 'active'`)).toEqual([{ n: keys.length / 2 }]);
      expect(await store.query(`SELECT (tx_to IS NULL) AS live, evidence_count FROM entities WHERE id = '宁德时代'`)).toEqual([{ live: true, evidence_count: keys.length / 2 }]);
    } finally {
      warn.mockRestore();
      await store.close();
    }
  });

  it('reopens an existing schema without re-migrating', async () => {
    const dir = workspaceDir();
    const first = await Store.open(dir, 2048, dbConfig);
    const version = first.migration.to;
    await first.close();

    const second = await Store.open(dir, 2048, dbConfig);
    try {
      expect(second.migration).toEqual({ from: version, to: version });
    } finally {
      await second.close();
    }
  });

  it("runs each workspace's catalog SQL as its own reader, blind to the other workspaces", async () => {
    const a = await Store.open(workspaceDir(), 2048, dbConfig);
    const b = await Store.open(workspaceDir(), 2048, dbConfig);
    const schemas: string[] = [];
    try {
      for (const store of [a, b]) {
        schemas.push((await store.query<{ schema: string }>(`SELECT current_schema() AS schema`))[0].schema);
      }
      const [, schemaB] = schemas;
      const countB = `SELECT query_to_xml('select count(*) from ${schemaB}.v_documents', true, true, '') AS x`;
      expect(catalogReaderRole(schemas[0])).not.toBe(catalogReaderRole(schemaB));
      // each reader reads its own workspace's views, through a function call too
      expect((await catalogQuery(a, `SELECT count(*)::int AS n FROM v_documents`)).rows).toEqual([{ n: 0 }]);
      expect((await catalogQuery(b, countB)).rowCount).toBe(1);
      // the service's own connection may read B's schema; A's reader may not, nor B's a base table
      await expect(catalogQuery(a, countB)).rejects.toThrow(/permission denied for schema/);
      await expect(catalogQuery(b, `SELECT query_to_xml('select * from documents', true, true, '') AS x`))
        .rejects.toThrow(/permission denied for table documents/);
    } finally {
      await a.close();
      await b.close();
      // readers are cluster-wide: drop this run's with their grants (the database goes in afterAll)
      const pool = adminPool(dbConfig.database);
      try {
        for (const role of schemas.map(catalogReaderRole)) {
          if (!(await pool.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role])).rows.length) continue;
          await pool.query(`DROP OWNED BY ${role}`);
          await pool.query(`DROP ROLE ${role}`);
        }
      } finally {
        await pool.end().catch(() => {});
      }
    }
  });
});
