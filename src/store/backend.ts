import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { threadId } from 'node:worker_threads';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import pg from 'pg';
import { DatabaseConfig, resolveSecret } from '../config.js';
import { DB_DIR } from '../fs/datadir.js';
import { pluginRegistry } from '../plugins/registry.js';
import type { StorageBackendPlugin } from '../plugins/types.js';

/**
 * The database surface the Store needs, met alike by a PostgreSQL server (the
 * default) and by embedded PGlite. Modelled on PGlite's own shape —
 * `query` returns `{ rows }`, `exec` runs multi-statement DDL scripts — so the
 * embedded backend satisfies it without a wrapper.
 *
 * Which backend opens is decided by `database.kind` through the plugin
 * registry: `pglite` and `postgres` are built in (below), and a storage plugin
 * may add another way of reaching a Postgres with pgvector (docs/design/11).
 * Dropping a workspace's whole index (clearing the workspace, `knode-os
 * rebuild`) goes through the same registry, as `dropBackend`: only the backend
 * knows where that index lives.
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
export function quoteIdent(name: string): string {
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

/** The schema a `postgres` config gives one workspace. */
function workspaceSchema(dataDir: string, cfg: DatabaseConfig): string {
  return schemaNameFor(dataDir, cfg.schemaPrefix || 'ws');
}

/**
 * The built-in `postgres` backend: one shared database (created on first
 * open), one schema per workspace, reached through `url` or the
 * host/port/user/password fields.
 */
export async function openPostgres(dataDir: string, cfg: DatabaseConfig): Promise<Backend> {
  const database = postgresDatabaseName(cfg);
  const schema = workspaceSchema(dataDir, cfg);
  if (cfg.readOnly) return openPostgresReadOnly(cfg, database, schema);
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

/**
 * A workspace's schema opened for reading only (docs/design/35 §4): nothing
 * is created — a missing database or schema is an error, not an empty index —
 * and every connection of the pool starts with `default_transaction_read_only`
 * on, so a statement that would write fails instead.
 */
async function openPostgresReadOnly(cfg: DatabaseConfig, database: string, schema: string): Promise<Backend> {
  const pool = new pg.Pool({
    ...postgresPoolConfig(cfg, { database }),
    options: `-c search_path=${schema},public -c default_transaction_read_only=on`,
  });
  try {
    const { rows } = await pool.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
    if (!rows.length) throw new Error(`no schema ${schema} in ${describePostgres(cfg)}/${database}: this workspace's index is not there`);
  } catch (err) {
    await pool.end().catch(() => undefined);
    throw err;
  }
  return new PostgresBackend(pool);
}

/** How long a drop waits for another connection's locks on the schema before it gives up. */
const DROP_LOCK_TIMEOUT = '30s';

/**
 * Drop one workspace's schema, every table in it included; the next
 * `openPostgres` creates it again, empty. The schema is named after the
 * workspace path, so deleting the directory alone hands a recreated workspace
 * its old tables back.
 *
 * A schema holding an extension is refused: CASCADE would drop the extension,
 * and with it every column of its types in every other workspace. pgvector
 * belongs in `public` (ensureSchema puts it there).
 */
export async function dropPostgres(dataDir: string, cfg: DatabaseConfig): Promise<void> {
  const schema = workspaceSchema(dataDir, cfg);
  const pool = new pg.Pool({
    ...postgresPoolConfig(cfg, { database: postgresDatabaseName(cfg), max: 1 }),
    options: `-c lock_timeout=${DROP_LOCK_TIMEOUT}`,
  });
  try {
    const { rows } = await pool.query<{ extname: string }>(
      `SELECT e.extname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE n.nspname = $1`,
      [schema],
    );
    if (rows.length > 0) {
      const names = rows.map((r) => r.extname).join(', ');
      throw new Error(`schema ${schema} holds the extension ${names}, which dropping it would remove from every workspace — move it to public first (ALTER EXTENSION ${rows[0].extname} SET SCHEMA public)`);
    }
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
  } catch (err) {
    const code = (err as { code?: string }).code;
    // no database yet: nothing was ever stored here
    if (code === '3D000') return;
    if (code === '55P03') throw new Error(`schema ${schema} is in use by another connection (another knode-os process on this workspace?) — stop it and try again`);
    throw err;
  } finally {
    await pool.end();
  }
}

/* -------------------------------- PGlite -------------------------------- */

/** Where a workspace's embedded database lives: `database.path` (relative to the workspace, or absolute), default `.knode/db`. */
export function pgliteDir(dataDir: string, cfg?: Pick<DatabaseConfig, 'path'>): string {
  const configured = cfg?.path?.trim();
  if (!configured) return path.join(dataDir, DB_DIR);
  return path.isAbsolute(configured) ? configured : path.join(dataDir, configured);
}

/*
 * One open per embedded database.
 *
 * PGlite takes no lock on its data directory: every `PGlite.create` on one
 * directory is an independent single-user Postgres with its own buffers over
 * the same files, and nothing reports the second. Once one of them writes, the
 * others read pages it has not flushed and rows of transactions only it can
 * finish; an instance that meets such a row waits for that transaction in a
 * busy sleep on the main thread (inside WASM), forever (docs/design/31, F2:
 * three instances opened on one directory in 0.5 s without an error, and the
 * evaluation harness stalled at 97 % CPU in `PostgresMainLoopOnce → … →
 * pg_usleep`). So the backend enforces what the docs always said:
 *
 * - In this process, a registry of open directories by real path (on
 *   `globalThis`, so two copies of this module — a test runner's isolation, a
 *   plugin's own import — still share it). A second open throws at once.
 * - Across processes, a lock file beside the database directory
 *   (`<dir>.lock`, never inside PGlite's own files), holding the pid, when that
 *   process started and what it is. It is created atomically (hard link of a
 *   complete file, else `wx`), removed on close and on a normal exit. A lock
 *   whose process is gone is reclaimed silently; one whose process is alive
 *   makes the open throw, naming the pid and command. The lock names the
 *   directory it locks, so one copied along with a workspace (a backup, a
 *   reused evaluation build) is ignored at its new place.
 *
 * A process killed outright (SIGKILL, or a signal nothing handles) leaves its
 * lock behind; the next open finds the pid gone and reclaims it. Against pid
 * reuse the lock records when it was taken: a live process at that pid that
 * started after that moment cannot be the holder, and its lock is reclaimed
 * too (`ps -o lstart`, one-second resolution; on a system without `ps` a live
 * pid is taken at its word). Worker threads of one process have registries of
 * their own; a lock held by another thread of this process is refused, and
 * stays until that thread closes the store or the process exits.
 */

interface PgliteLockHolder {
  pid: number;
  /** The database directory (real path) it locks: a lock copied along with a workspace locks nothing. */
  dir: string;
  /** Worker thread id, 0 for the main thread. */
  thread: number;
  /** When the holding process started (epoch ms, from its uptime). */
  started: number;
  /** When the lock was taken (epoch ms). */
  at: number;
  /** What opened it: the program and its subcommand words, never flag values. */
  command: string;
  /** Unique per open, so a close removes its own lock and nobody else's. */
  token: string;
}

interface OpenPglite {
  lock: string;
  token: string;
}

const OPEN_PGLITE = Symbol.for('knode-os.pglite.open-dirs');

/** Directories open in this process (this thread), by real path. */
function openPgliteDirs(): Map<string, OpenPglite> {
  const g = globalThis as unknown as Record<symbol, Map<string, OpenPglite> | undefined>;
  let dirs = g[OPEN_PGLITE];
  if (!dirs) {
    dirs = new Map();
    g[OPEN_PGLITE] = dirs;
    // a normal exit takes its locks with it; one killed outright leaves them for the next open to reclaim
    process.once('exit', () => {
      for (const open of dirs!.values()) removeOwnLock(open);
      dirs!.clear();
    });
  }
  return dirs;
}

/** The directory's real path, resolving through the part that exists: two spellings of one directory are one key. */
function canonicalDir(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    const parent = path.dirname(resolved);
    return parent === resolved ? resolved : path.join(canonicalDir(parent), path.basename(resolved));
  }
}

/** Where the lock of an embedded database lives: beside its directory, outside PGlite's own files. */
export function pgliteLockPath(dataDir: string, cfg?: Pick<DatabaseConfig, 'path'>): string {
  return `${canonicalDir(pgliteDir(dataDir, cfg))}.lock`;
}

const processStarted = (): number => Math.round(Date.now() - process.uptime() * 1000);

/**
 * What this process is, short: the script's name (`knode-os` for the CLI) and
 * the bare words after it that look like subcommands. A word that follows a
 * flag may be its value — a path, a URL, a token — and is left out.
 */
function processCommand(): string {
  const [, script, ...args] = process.argv;
  let name = script ? path.basename(script).replace(/\.[cm]?[jt]s$/, '') : process.title;
  if (name === 'cli') name = 'knode-os';
  const words: string[] = [];
  let prev = '';
  for (const arg of args) {
    if (words.length >= 4) break;
    if (!arg.startsWith('-') && !prev.startsWith('-') && /^[a-z][a-z0-9-]{0,23}$/.test(arg)) words.push(arg);
    prev = arg;
  }
  return [name || 'node', ...words].join(' ');
}

function readLock(lock: string): { raw: string; holder: PgliteLockHolder | null } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(lock, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const h = JSON.parse(raw) as PgliteLockHolder;
    return { raw, holder: Number.isInteger(h?.pid) && h.pid > 0 ? h : null };
  } catch {
    return { raw, holder: null };
  }
}

/** When a live process started (epoch ms), or undefined when that cannot be told. */
function processStartTime(pid: number): number | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    const t = Date.parse(out);
    return Number.isFinite(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the process a lock names still holds it: alive, and the same process that took it. */
function lockHeld(h: PgliteLockHolder, dir: string): boolean {
  // copied with the workspace (a backup, a reused evaluation build): its holder has the original open, not this one
  if (typeof h.dir === 'string' && h.dir !== dir) return false;
  // `ps` and the uptime clock truncate to the second; a process that started this much after the lock cannot hold it
  const SLACK_MS = 1500;
  if (h.pid === process.pid) {
    // this pid: an earlier process's lock, or another thread of this one (this thread's own opens are in the registry)
    return !(typeof h.at === 'number' && processStarted() > h.at + SLACK_MS);
  }
  try {
    process.kill(h.pid, 0);
  } catch (err) {
    // EPERM: alive, someone else's
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
  }
  if (typeof h.at === 'number') {
    const started = processStartTime(h.pid);
    if (started !== undefined && started > h.at + SLACK_MS) return false; // the pid was reused
  }
  return true;
}

function describeHolder(h: PgliteLockHolder): string {
  const thread = h.thread ? ` (worker thread ${h.thread})` : '';
  const since = typeof h.at === 'number' ? `, since ${new Date(h.at).toISOString()}` : '';
  return `process ${h.pid}${thread}: ${h.command || 'unknown command'}${since}`;
}

function lockedError(message: string, holder?: PgliteLockHolder): Error {
  return Object.assign(new Error(message), { code: 'KNODE_PGLITE_OPEN', ...(holder ? { holder } : {}) });
}

/** Create the lock file whole, or fail with EEXIST: a hard link of a complete file is atomic; `wx` where links are not supported. */
function createLock(lock: string, content: string): void {
  const tmp = `${lock}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content, { flag: 'wx' });
  try {
    fs.linkSync(tmp, lock);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw err;
    // a filesystem without hard links: an exclusive create, written straight after
    fs.writeFileSync(lock, content, { flag: 'wx' });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Take the cross-process lock of one database directory, reclaiming a stale
 * one; throw, naming the holder, while a live process has it.
 */
function acquireLock(dir: string, lock: string): OpenPglite {
  const holder: PgliteLockHolder = {
    pid: process.pid,
    dir,
    thread: threadId,
    started: processStarted(),
    at: Date.now(),
    command: processCommand(),
    token: crypto.randomBytes(8).toString('hex'),
  };
  const content = JSON.stringify(holder) + '\n';
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      createLock(lock, content);
      return { lock, token: holder.token };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const found = readLock(lock);
    if (!found) continue; // released meanwhile
    if (found.holder && lockHeld(found.holder, dir)) {
      const h = found.holder;
      const where = h.pid === process.pid ? 'another thread of this process' : 'another process';
      throw lockedError(
        `the embedded PGlite index ${dir} is open in ${describeHolder(h)} — PGlite allows one process at a time on a database (${where} holds ${lock}). ` +
          `Stop it, or reach the workspace through it (a running \`knode-os serve\` answers the CLI and serves MCP over HTTP). Remove the lock by hand only if that process is not using this index.`,
        h,
      );
    }
    // stale: move it aside, and delete it only if it is still the lock just judged — another opener may have reclaimed it meanwhile
    const aside = `${lock}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.stale`;
    try {
      fs.renameSync(lock, aside);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    let moved = '';
    try {
      moved = fs.readFileSync(aside, 'utf8');
    } catch {
      // gone; nothing to put back
    }
    if (moved && moved !== found.raw) {
      // a fresh lock taken between the read and the rename: put it back, and judge it on the next pass
      try {
        fs.linkSync(aside, lock);
      } catch {
        // yet another opener has created one; the next pass judges that
      }
    }
    fs.rmSync(aside, { force: true });
  }
  throw lockedError(`could not take the lock ${lock} of the embedded PGlite index ${dir}: other processes kept replacing it`);
}

/** Remove a lock this open took, and only if it is still that one. */
function removeOwnLock(open: OpenPglite): void {
  try {
    const found = readLock(open.lock);
    if (found?.holder?.token === open.token) fs.rmSync(open.lock, { force: true });
  } catch {
    // unreadable: leave it; a dead pid's lock is reclaimed by the next open
  }
}

/** Claim a database directory for this open: the in-process registry, then the lock file. */
function claimPgliteDir(dir: string): { key: string; release: () => void } {
  const key = canonicalDir(dir);
  const dirs = openPgliteDirs();
  if (dirs.has(key)) {
    throw lockedError(
      `the embedded PGlite index ${key} is already open in this process (pid ${process.pid}) — PGlite allows one open at a time on a database; share the open store, or close it before opening the directory again`,
    );
  }
  const open = acquireLock(key, `${key}.lock`);
  dirs.set(key, open);
  let released = false;
  return {
    key,
    release: () => {
      if (released) return;
      released = true;
      if (dirs.get(key) === open) dirs.delete(key);
      removeOwnLock(open);
    },
  };
}

/** Whether this process has the embedded database of a workspace open (for tests and diagnostics). */
export function pgliteOpenInProcess(dataDir: string, cfg?: Pick<DatabaseConfig, 'path'>): boolean {
  return openPgliteDirs().has(canonicalDir(pgliteDir(dataDir, cfg)));
}

/**
 * The built-in `pglite` backend: Postgres + pgvector embedded in the process,
 * nothing to install or run. One open per database directory, across
 * processes (see above): a second open throws, naming who has it.
 */
export async function openPglite(dataDir: string, cfg?: Pick<DatabaseConfig, 'path' | 'readOnly'>): Promise<Backend> {
  const dir = pgliteDir(dataDir, cfg);
  // read-only: an index that is not there is not made (PGlite would create an empty one)
  if (cfg?.readOnly && !fs.existsSync(path.join(dir, 'PG_VERSION'))) throw new Error(`no embedded index at ${dir}`);
  const claim = claimPgliteDir(dir);
  let db: PGlite;
  try {
    db = await PGlite.create(dir, { extensions: { vector } });
    // the session's transactions read only: a statement that would write fails (docs/design/35 §4)
    if (cfg?.readOnly) await db.exec('SET default_transaction_read_only = on');
  } catch (err) {
    claim.release();
    throw err;
  }
  const close = db.close.bind(db);
  // the claim goes with the instance, even when closing it fails part-way
  Object.defineProperty(db, 'close', {
    configurable: true,
    writable: true,
    value: async (): Promise<void> => {
      try {
        await close();
      } finally {
        claim.release();
      }
    },
  });
  return db as unknown as Backend;
}

/**
 * Delete a workspace's embedded database directory; the next `openPglite`
 * creates an empty one. Refused while the database is open — in this process,
 * or in a live one holding its lock — rather than deleting files under a
 * running instance; the lock is held for the deletion itself.
 */
export async function dropPglite(dataDir: string, cfg?: Pick<DatabaseConfig, 'path'>): Promise<void> {
  const dir = pgliteDir(dataDir, cfg);
  const key = canonicalDir(dir);
  if (openPgliteDirs().has(key)) {
    throw lockedError(`cannot drop the embedded PGlite index ${key}: it is open in this process (pid ${process.pid}); close its store first`);
  }
  const claim = claimPgliteDir(dir);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    claim.release();
  }
}

/* -------------------------------- entry --------------------------------- */

/** The registered backend `database.kind` names (an absent config is PGlite), and the config to hand it. */
function storageBackendFor(cfg?: DatabaseConfig): { backend: StorageBackendPlugin; config: DatabaseConfig } {
  const kind = cfg?.kind || 'pglite';
  const backend = pluginRegistry().storageBackend(kind);
  if (!backend) {
    const known = pluginRegistry().storageBackends().map((b) => b.id).join(', ');
    throw new Error(`unknown database.kind "${kind}" (registered: ${known}) — a plugin that provides it must be listed under "plugins" in knode.config.json`);
  }
  return { backend, config: cfg ?? { kind, host: '', port: 0, user: '', password: '', database: '', schemaPrefix: 'ws' } };
}

/**
 * Open the backend for one workspace, by `database.kind`: a PostgreSQL server
 * by default (since 2026-09), the embedded PGlite database for "pglite", and
 * any other kind from a storage plugin. Called without a config at all, it
 * opens PGlite.
 */
export async function openBackend(dataDir: string, cfg?: DatabaseConfig): Promise<Backend> {
  const { backend, config } = storageBackendFor(cfg);
  return backend.open(dataDir, config);
}

/**
 * Throw unless `database.kind` names a backend that can drop a workspace's
 * index. Callers check this before closing anything, so a backend without
 * `drop` leaves the workspace as it was rather than half cleared.
 */
export function assertBackendDroppable(cfg?: DatabaseConfig): void {
  const { backend } = storageBackendFor(cfg);
  if (typeof backend.drop !== 'function') {
    throw new Error(`storage backend "${backend.id}" (database.kind) cannot drop a workspace's index: it has no drop(dataDir, config), and clearing the files alone would leave the old index for the next open. Add drop() to the plugin that provides it, or delete the index by hand.`);
  }
}

/**
 * Drop one workspace's whole index, wherever its backend keeps it: the
 * embedded database's directory, the workspace's schema on a server, or
 * whatever a plugin backend's `drop` removes. The store must be closed first;
 * the next open starts empty.
 */
export async function dropBackend(dataDir: string, cfg?: DatabaseConfig): Promise<void> {
  assertBackendDroppable(cfg);
  const { backend, config } = storageBackendFor(cfg);
  await backend.drop!(dataDir, config);
}
