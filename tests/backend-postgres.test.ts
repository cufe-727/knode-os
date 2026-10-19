import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultConfig, type DatabaseConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { rebuild } from '../src/lineage/rebuild.js';
import { resolveWorkspaceScope, WorkspaceContextRegistry } from '../src/server/workspaces.js';
import { dropBackend, schemaNameFor } from '../src/store/backend.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../src/store/db.js';

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
});
