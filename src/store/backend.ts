import crypto from 'node:crypto';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import pg from 'pg';
import { DatabaseConfig, resolveSecret } from '../config.js';
import { DB_DIR } from '../fs/datadir.js';

/**
 * The database surface the Store needs, so an external Postgres server can
 * stand in for the embedded PGlite one. Modelled on PGlite's own shape —
 * `query` returns `{ rows }`, `exec` runs multi-statement DDL scripts — so the
 * embedded backend satisfies it without a wrapper.
 */
export interface Backend {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: BackendTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface BackendTx {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
}

/**
 * One workspace's schema name inside the shared database.
 *
 * Workspaces are isolated by schema rather than by database: a schema costs
 * nothing (a database carries its own ~8 MB system catalog), one connection
 * pool serves them all, and — unlike folding every workspace into shared tables
 * keyed by a workspace column — each schema keeps its own HNSW index. That
 * matters: HNSW walks a neighbour graph ordered by vector distance, so a
 * `WHERE workspace_id = …` predicate cannot be pushed into the walk and the
 * planner falls back to a sequential scan.
 *
 * The readable half comes from the workspace directory so `\dn` stays
 * navigable; the hash of the absolute path keeps two workspaces that share a
 * basename (a personal and a team "default", say) from colliding. Postgres caps
 * identifiers at 63 bytes, hence the truncation.
 */
export function schemaNameFor(dataDir: string, prefix: string): string {
  const resolved = path.resolve(dataDir);
  const slug =
    path.basename(resolved).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'ws';
  const hash = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 8);
  const head = `${prefix}_${slug}`.slice(0, 54);
  return `${head}_${hash}`;
}

/** Connection settings shared by the admin and per-workspace pools. */
function connectionOptions(cfg: DatabaseConfig): pg.PoolConfig {
  const password = resolveSecret(cfg.password);
  return {
    host: cfg.host,
    port: cfg.port,
    user: cfg.user || undefined,
    ...(password ? { password } : {}),
  };
}

/** Double-quote an identifier we generated ourselves; belt-and-braces. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Create the shared database if it is not there yet. `CREATE DATABASE` cannot
 * run inside a transaction and has no IF NOT EXISTS, so this connects to the
 * maintenance database and checks first. A concurrent creator racing us raises
 * 42P04, which is success as far as the caller is concerned.
 */
async function ensureDatabase(cfg: DatabaseConfig, name: string): Promise<void> {
  const admin = new pg.Pool({ ...connectionOptions(cfg), database: 'postgres', max: 1 });
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (rows.length > 0) return;
    await admin.query(`CREATE DATABASE ${quoteIdent(name)}`);
  } catch (err) {
    if ((err as { code?: string }).code !== '42P04') throw err;
  } finally {
    await admin.end();
  }
}

/**
 * Create the workspace's schema and make sure pgvector is installed. The
 * extension lives in `public` so every workspace schema shares one copy; that
 * is also why `search_path` must keep `public` on it — without it `halfvec`
 * and the `<=>` operator do not resolve.
 */
async function ensureSchema(cfg: DatabaseConfig, database: string, schema: string): Promise<void> {
  const pool = new pg.Pool({ ...connectionOptions(cfg), database, max: 1 });
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector SCHEMA public');
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
  } finally {
    await pool.end();
  }
}

/** External Postgres backend, scoped to one schema by the pool's search_path. */
class PostgresBackend implements Backend {
  constructor(private readonly pool: pg.Pool) {}

  async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    const res = await this.pool.query(sql, params as unknown[]);
    return { rows: res.rows as T[] };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: BackendTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn({
        query: async <T2,>(sql: string, params?: unknown[]) => ({
          rows: (await client.query(sql, params as unknown[])).rows as T2[],
        }),
        exec: async (sql: string) => {
          await client.query(sql);
        },
      });
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Open the backend for one workspace: PostgreSQL when the config says so
 * (the default since 2026-09), the embedded PGlite database otherwise — an
 * absent `database` block still opens PGlite so old data dirs keep working.
 */
export async function openBackend(dataDir: string, cfg?: DatabaseConfig): Promise<Backend> {
  if (cfg?.kind === 'postgres') {
    const database = cfg.database || 'knode';
    const schema = schemaNameFor(dataDir, cfg.schemaPrefix || 'ws');
    try {
      await ensureDatabase(cfg, database);
    } catch (err) {
      const e = err as { code?: string; errors?: { code?: string }[]; message?: string };
      const code = e.code ?? e.errors?.[0]?.code ?? '';
      if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ECONNRESET/.test(code) || /ECONNREFUSED|connect/i.test(String(e.message))) {
        throw new Error(
          `cannot reach PostgreSQL at ${cfg.host}:${cfg.port} — database.kind is "postgres" by default. Start the server, fix database.host/port/user/password in knode.config.json, or set database.kind to "pglite" for an embedded index (${e.message ?? code})`,
        );
      }
      throw err;
    }
    await ensureSchema(cfg, database, schema);
    // Set on the connection itself so every pooled client starts in the right
    // schema — no per-checkout SET, and no race with `pool.on('connect')`.
    const pool = new pg.Pool({
      ...connectionOptions(cfg),
      database,
      options: `-c search_path=${schema},public`,
    });
    return new PostgresBackend(pool);
  }
  return (await PGlite.create(path.join(dataDir, DB_DIR), { extensions: { vector } })) as unknown as Backend;
}
