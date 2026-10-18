import crypto from 'node:crypto';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import pg from 'pg';
import { DatabaseConfig, resolveSecret } from '../config.js';
import { DB_DIR } from '../fs/datadir.js';
import { pluginRegistry } from '../plugins/registry.js';

/**
 * The database surface the Store needs, so an external Postgres server can
 * stand in for the embedded PGlite one. Modelled on PGlite's own shape —
 * `query` returns `{ rows }`, `exec` runs multi-statement DDL scripts — so the
 * embedded backend satisfies it without a wrapper.
 *
 * Which backend opens is decided by `database.kind` through the plugin
 * registry: `pglite` and `postgres` are built in (below), and a storage plugin
 * may add another way of reaching a Postgres with pgvector (docs/design/11).
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

/* ------------------------------ PostgreSQL ------------------------------ */

/**
 * The database a `postgres` config names: the connection string's, when it
 * has one (`url` names the server *and* the database), else `database`, else
 * `knode`.
 */
export function postgresDatabaseName(cfg: DatabaseConfig): string {
  const url = resolveSecret(cfg.url ?? '');
  if (url) {
    try {
      const name = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ''));
      if (name) return name;
    } catch {
      // not a URL pg can parse either; the pool reports that
    }
  }
  return cfg.database || 'knode';
}

/** A connection string with its database swapped — the maintenance database for CREATE DATABASE, the real one afterwards. */
function withDatabase(url: string, database: string): string {
  try {
    const parsed = new URL(url);
    parsed.pathname = `/${encodeURIComponent(database)}`;
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * `pg` pool settings for a database config: either the connection string
 * (`url`, "env:VAR" resolved) or the host/port/user/password fields, plus TLS
 * (`ssl`: true / 'require' verify the server certificate, 'no-verify'
 * encrypts without verifying) and the pool size. `database` picks which
 * database the pool connects to; `max` caps its connections.
 */
export function postgresPoolConfig(cfg: DatabaseConfig, opts: { database?: string; max?: number } = {}): pg.PoolConfig {
  const url = resolveSecret(cfg.url ?? '');
  const password = resolveSecret(cfg.password ?? '');
  const ssl = cfg.ssl === 'no-verify' ? { rejectUnauthorized: false } : cfg.ssl === true || cfg.ssl === 'require' ? true : undefined;
  const base: pg.PoolConfig = url
    ? { connectionString: opts.database ? withDatabase(url, opts.database) : url }
    : {
      host: cfg.host,
      port: cfg.port,
      user: cfg.user || undefined,
      ...(password ? { password } : {}),
      ...(opts.database ? { database: opts.database } : {}),
    };
  const max = opts.max ?? (Number.isInteger(cfg.poolSize) && cfg.poolSize! > 0 ? cfg.poolSize : undefined);
  return { ...base, ...(ssl !== undefined ? { ssl } : {}), ...(max ? { max } : {}) };
}

/** Where a postgres config points, for error messages (never the password). */
function describePostgres(cfg: DatabaseConfig): string {
  const url = resolveSecret(cfg.url ?? '');
  if (url) {
    try {
      const parsed = new URL(url);
      return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
    } catch {
      return 'the configured database.url';
    }
  }
  return `${cfg.host}:${cfg.port}`;
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
  const admin = new pg.Pool(postgresPoolConfig(cfg, { database: 'postgres', max: 1 }));
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
  const pool = new pg.Pool(postgresPoolConfig(cfg, { database, max: 1 }));
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
 * The built-in `postgres` backend: one shared database (created on first
 * open), one schema per workspace, reached through `url` or the
 * host/port/user/password fields.
 */
export async function openPostgres(dataDir: string, cfg: DatabaseConfig): Promise<Backend> {
  const database = postgresDatabaseName(cfg);
  const schema = schemaNameFor(dataDir, cfg.schemaPrefix || 'ws');
  try {
    await ensureDatabase(cfg, database);
  } catch (err) {
    const e = err as { code?: string; errors?: { code?: string }[]; message?: string };
    const code = e.code ?? e.errors?.[0]?.code ?? '';
    if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ECONNRESET/.test(code) || /ECONNREFUSED|connect/i.test(String(e.message))) {
      throw new Error(
        `cannot reach PostgreSQL at ${describePostgres(cfg)} — database.kind is "postgres" by default. Start the server, fix database.url or database.host/port/user/password in knode.config.json, or set database.kind to "pglite" for an embedded index (${e.message ?? code})`,
      );
    }
    throw err;
  }
  await ensureSchema(cfg, database, schema);
  // Set on the connection itself so every pooled client starts in the right
  // schema — no per-checkout SET, and no race with `pool.on('connect')`.
  const pool = new pg.Pool({
    ...postgresPoolConfig(cfg, { database }),
    options: `-c search_path=${schema},public`,
  });
  return new PostgresBackend(pool);
}

/* -------------------------------- PGlite -------------------------------- */

/** Where a workspace's embedded database lives: `database.path` (relative to the workspace, or absolute), default `.knode/db`. */
export function pgliteDir(dataDir: string, cfg?: Pick<DatabaseConfig, 'path'>): string {
  const configured = cfg?.path?.trim();
  if (!configured) return path.join(dataDir, DB_DIR);
  return path.isAbsolute(configured) ? configured : path.join(dataDir, configured);
}

/** The built-in `pglite` backend: Postgres + pgvector embedded in the process, nothing to install or run. */
export async function openPglite(dataDir: string, cfg?: Pick<DatabaseConfig, 'path'>): Promise<Backend> {
  return (await PGlite.create(pgliteDir(dataDir, cfg), { extensions: { vector } })) as unknown as Backend;
}

/* -------------------------------- entry --------------------------------- */

/**
 * Open the backend for one workspace, by `database.kind`: PostgreSQL when the
 * config says so (the default since 2026-09), the embedded PGlite database
 * otherwise — an absent `database` block still opens PGlite so old data dirs
 * keep working. Any other kind must come from a storage plugin.
 */
export async function openBackend(dataDir: string, cfg?: DatabaseConfig): Promise<Backend> {
  const kind = cfg?.kind || 'pglite';
  const backend = pluginRegistry().storageBackend(kind);
  if (!backend) {
    const known = pluginRegistry().storageBackends().map((b) => b.id).join(', ');
    throw new Error(`unknown database.kind "${kind}" (registered: ${known}) — a plugin that provides it must be listed under "plugins" in knode.config.json`);
  }
  return backend.open(dataDir, cfg ?? { kind, host: '', port: 0, user: '', password: '', database: '', schemaPrefix: 'ws' });
}
