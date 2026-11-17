import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { DatabaseConfig, defaultConfig, resolveSecret } from '../config.js';
import { dropBackend, postgresDatabaseName, postgresPoolConfig, schemaNameFor } from '../store/backend.js';
import { Store } from '../store/db.js';

/**
 * Where an evaluation keeps its knode indexes (docs/design/31 D1): on the
 * product's backend, never in the database the live workspaces use.
 *
 * - PGlite (`KNODE_DATABASE_KIND=pglite`, or a `--config-from` workspace on
 *   it): an embedded database inside each build's workspace, as before.
 * - PostgreSQL: the database `knode_eval` on the server the run's config
 *   names, or the server and database `--database-url` /
 *   `KNODE_EVAL_DATABASE_URL` names; one schema per build, named from the
 *   build's workspace directory with the prefix `eval` (`schemaNameFor`), so
 *   every run, pack and group has its own. Each schema carries a comment
 *   naming that directory: what `eval drop --orphaned` and the stale listing
 *   go by, since the name's hash cannot be read back.
 *
 * A config written into an evaluation workspace never holds a credential: a
 * password, or a connection string carrying one, goes into this process's
 * environment and the file names the variable (`env:…`).
 */

export const EVAL_DATABASE = 'knode_eval';
export const EVAL_SCHEMA_PREFIX = 'eval';
/** `--database-url`'s environment variable. */
export const EVAL_DATABASE_URL_ENV = 'KNODE_EVAL_DATABASE_URL';
/** Connections in an evaluation workspace's pool at most. */
export const EVAL_POOL_MAX = 16;
/** Where a run's own credentials wait for its workspaces' configs to name them. */
const RUN_URL_ENV = 'KNODE_EVAL_RUN_DATABASE_URL';
const RUN_PASSWORD_ENV = 'KNODE_EVAL_RUN_DATABASE_PASSWORD';
const SCHEMA_COMMENT = 'knode-eval workspace ';

/** A connection string's database, or '' when it names none. */
function databaseInUrl(url: string): string {
  try {
    return decodeURIComponent(new URL(resolveSecret(url)).pathname.replace(/^\/+/, ''));
  } catch {
    return '';
  }
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

/**
 * The evaluation's database config from the run's (`--config-from`'s, else
 * the default): PGlite stays PGlite, in each workspace; PostgreSQL moves to
 * `knode_eval` on the same server, unless a URL names another server and
 * database. The pool follows the run's answer concurrency, at most 16.
 */
export function evalDatabase(source: DatabaseConfig, opts: { url?: string; poolSize?: number } = {}): DatabaseConfig {
  const url = (opts.url ?? process.env[EVAL_DATABASE_URL_ENV] ?? '').trim();
  const poolSize = Math.min(EVAL_POOL_MAX, Math.max(1, Math.trunc(opts.poolSize ?? 4)));
  if (url) {
    const resolved = resolveSecret(url);
    const named = databaseInUrl(resolved);
    return { kind: 'postgres', host: '', port: 0, user: '', password: '', database: named || EVAL_DATABASE, schemaPrefix: EVAL_SCHEMA_PREFIX, url: named ? resolved : withDatabase(resolved, EVAL_DATABASE), poolSize };
  }
  // the default's fields, not the source's: a live workspace's PGlite path or password has no business in a run's workspace
  if (source.kind === 'pglite') return { ...defaultConfig().database, kind: 'pglite' };
  if (source.kind === 'postgres') {
    const sourceUrl = resolveSecret(source.url ?? '');
    const { path: _path, options: _options, url: _url, ...rest } = source;
    return { ...rest, database: EVAL_DATABASE, schemaPrefix: EVAL_SCHEMA_PREFIX, poolSize, ...(sourceUrl ? { url: withDatabase(sourceUrl, EVAL_DATABASE) } : {}) };
  }
  throw new Error(`an evaluation keeps its indexes on pglite or postgres; the run's config names database.kind "${source.kind}"`);
}

/** The config as an evaluation workspace's file holds it: credentials only as `env:` references to this process's environment. */
export function storableDatabase(cfg: DatabaseConfig): DatabaseConfig {
  const out = { ...cfg };
  if (out.url && !out.url.startsWith('env:')) {
    let secret = false;
    try {
      secret = Boolean(new URL(out.url).password);
    } catch {
      secret = true;
    }
    if (secret) {
      process.env[RUN_URL_ENV] = out.url;
      out.url = `env:${RUN_URL_ENV}`;
    }
  }
  if (out.password && !out.password.startsWith('env:')) {
    process.env[RUN_PASSWORD_ENV] = out.password;
    out.password = `env:${RUN_PASSWORD_ENV}`;
  }
  return out;
}

/** Server and database, for comparing two configs. */
function endpoint(cfg: DatabaseConfig): { host: string; port: number; database: string } {
  let host = cfg.host;
  let port = cfg.port;
  const url = resolveSecret(cfg.url ?? '');
  if (url) {
    try {
      const u = new URL(url);
      host = u.hostname;
      port = Number(u.port) || 5432;
    } catch {
      // pg reports it
    }
  }
  const h = (host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return { host: !h || h === 'localhost' || h === '::1' ? '127.0.0.1' : h, port: port || 5432, database: postgresDatabaseName(cfg) };
}

/** Whether two configs reach the same PostgreSQL database (PGlite never shares one). */
export function sameDatabase(a: DatabaseConfig, b: DatabaseConfig): boolean {
  if (a.kind !== 'postgres' || b.kind !== 'postgres') return false;
  const x = endpoint(a);
  const y = endpoint(b);
  return x.host === y.host && x.port === y.port && x.database === y.database;
}

/** Where a config points, never with credentials: `pglite`, or `postgres <host>:<port>/<database>`. */
export function describeDatabase(cfg: DatabaseConfig): string {
  if (cfg.kind !== 'postgres') return cfg.kind;
  const e = endpoint(cfg);
  return `postgres ${e.host}:${e.port}/${e.database}`;
}

/** The schema a build's workspace gets on PostgreSQL. */
export function evalSchema(ws: string, cfg: DatabaseConfig): string {
  return schemaNameFor(ws, cfg.schemaPrefix || 'ws');
}

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function withPool<T>(cfg: DatabaseConfig, fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = new pg.Pool(postgresPoolConfig(cfg, { database: postgresDatabaseName(cfg), max: 1 }));
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

/** Label a build's schema with its workspace directory (the orphan listing reads it back). */
export async function markSchema(cfg: DatabaseConfig, ws: string): Promise<string> {
  const schema = evalSchema(ws, cfg);
  await withPool(cfg, (pool) => pool.query(`COMMENT ON SCHEMA ${quote(schema)} IS ${pg.escapeLiteral(SCHEMA_COMMENT + path.resolve(ws))}`));
  return schema;
}

/** An evaluation schema: the eval prefix, so a drop can never reach a live workspace's (`ws_…`). */
function isEvalSchema(schema: string): boolean {
  return schema.startsWith(`${EVAL_SCHEMA_PREFIX}_`);
}

/**
 * Copy another build's schema into this workspace's (`--reuse-builds-from`
 * on PostgreSQL): the work directory was copied, but update batches change an
 * index in place, so the new run must not share the old one's. The target is
 * created by the store's own migrations, then filled table by table (parents
 * before children, sequences set after). Throws — and the run builds afresh —
 * when the source is gone or its tables differ from what this code creates.
 */
export async function cloneSchema(cfg: DatabaseConfig, from: string, ws: string, dimensions: number): Promise<{ schema: string; tables: number; rows: number }> {
  const to = evalSchema(ws, cfg);
  if (!isEvalSchema(from) || !isEvalSchema(to)) throw new Error(`not evaluation schemas: ${from} → ${to}`);
  if (from === to) throw new Error(`the reused build's schema ${from} is this workspace's own`);
  const exists = await withPool(cfg, async (pool) => {
    const { rows } = await pool.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [from]);
    if (rows.length) await pool.query(`DROP SCHEMA IF EXISTS ${quote(to)} CASCADE`);
    return rows.length > 0;
  });
  if (!exists) throw new Error(`the reused build's schema ${from} is not in ${describeDatabase(cfg)}`);
  // the target as this code creates it: tables, indexes, functions
  await (await Store.open(ws, dimensions, cfg)).close();
  const pool = new pg.Pool(postgresPoolConfig(cfg, { database: postgresDatabaseName(cfg), max: 1 }));
  const client = await pool.connect();
  try {
    const tablesOf = async (schema: string) => (await client.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY 1`, [schema],
    )).rows.map((r) => r.name);
    const [mine, theirs] = [await tablesOf(to), await tablesOf(from)];
    if (mine.join() !== theirs.join()) {
      const missing = theirs.filter((t) => !mine.includes(t));
      const extra = mine.filter((t) => !theirs.includes(t));
      throw new Error(`the reused build's tables differ from this version's (${[...missing.map((t) => `only there: ${t}`), ...extra.map((t) => `only here: ${t}`)].join(', ')})`);
    }
    // parents first; a table that refers to itself is filled in one statement, which its own checks wait for
    const edges = (await client.query<{ child: string; parent: string }>(
      `SELECT c.relname AS child, p.relname AS parent FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE k.contype = 'f' AND n.nspname = $1 AND c.oid <> p.oid`, [to],
    )).rows;
    const order: string[] = [];
    const left = new Set(mine);
    while (left.size) {
      const ready = [...left].filter((t) => !edges.some((e) => e.child === t && left.has(e.parent)));
      if (!ready.length) throw new Error(`foreign keys form a cycle among ${[...left].join(', ')}`);
      for (const t of ready) {
        order.push(t);
        left.delete(t);
      }
    }
    let rows = 0;
    await client.query('BEGIN');
    await client.query(`TRUNCATE ${mine.map((t) => `${quote(to)}.${quote(t)}`).join(', ')}`);
    for (const t of order) {
      const cols = (await client.query<{ name: string; identity: string }>(
        `SELECT a.attname AS name, a.attidentity AS identity FROM pg_attribute a
         WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '' ORDER BY a.attnum`,
        [`${quote(to)}.${quote(t)}`],
      )).rows;
      const list = cols.map((c) => quote(c.name)).join(', ');
      const overriding = cols.some((c) => c.identity === 'a') ? ' OVERRIDING SYSTEM VALUE' : '';
      const r = await client.query(`INSERT INTO ${quote(to)}.${quote(t)} (${list})${overriding} SELECT ${list} FROM ${quote(from)}.${quote(t)}`);
      rows += r.rowCount ?? 0;
    }
    for (const { name } of (await client.query<{ name: string }>(`SELECT sequencename AS name FROM pg_sequences WHERE schemaname = $1`, [from])).rows) {
      const [s] = (await client.query<{ last_value: string | null; is_called: boolean }>(`SELECT last_value, is_called FROM ${quote(from)}.${quote(name)}`)).rows;
      if (s?.last_value != null) await client.query('SELECT setval($1::regclass, $2, $3)', [`${quote(to)}.${quote(name)}`, s.last_value, s.is_called]);
    }
    await client.query(`COMMENT ON SCHEMA ${quote(to)} IS ${pg.escapeLiteral(SCHEMA_COMMENT + path.resolve(ws))}`);
    await client.query('COMMIT');
    return { schema: to, tables: order.length, rows };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

/** An evaluation schema in a database, and the workspace directory its comment names. */
export interface EvalSchema {
  schema: string;
  workspace: string | null;
}

/** Every evaluation schema in the database `cfg` names (the eval prefix only). */
export async function listEvalSchemas(cfg: DatabaseConfig): Promise<EvalSchema[]> {
  if (cfg.kind !== 'postgres') return [];
  return withPool(cfg, async (pool) => (await pool.query<{ schema: string; comment: string | null }>(
    `SELECT n.nspname AS schema, obj_description(n.oid, 'pg_namespace') AS comment FROM pg_namespace n
     WHERE n.nspname LIKE $1 ORDER BY 1`, [`${EVAL_SCHEMA_PREFIX}\\_%`],
  )).rows.map((r) => ({ schema: r.schema, workspace: r.comment?.startsWith(SCHEMA_COMMENT) ? r.comment.slice(SCHEMA_COMMENT.length) : null })));
}

/** Evaluation schemas whose workspace directory is gone: a run deleted without `eval drop`. Unlabelled ones are left alone. */
export async function orphanedEvalSchemas(cfg: DatabaseConfig): Promise<EvalSchema[]> {
  return (await listEvalSchemas(cfg)).filter((s) => s.workspace && !fs.existsSync(s.workspace));
}

/** Drop one evaluation schema by name, refusing any other. */
export async function dropEvalSchema(cfg: DatabaseConfig, schema: string): Promise<void> {
  if (!isEvalSchema(schema)) throw new Error(`refusing to drop ${schema}: not an evaluation schema`);
  await withPool(cfg, (pool) => pool.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`));
}

/**
 * Drop a build workspace's index wherever its config keeps it (`dropBackend`),
 * on PostgreSQL only when it is an evaluation schema: what `eval drop` runs
 * for each build of a run.
 */
export async function dropEvalWorkspace(ws: string, cfg: DatabaseConfig): Promise<string> {
  if (cfg.kind === 'postgres') {
    const schema = evalSchema(ws, cfg);
    if (!isEvalSchema(schema)) throw new Error(`refusing to drop ${schema}: ${ws} is not an evaluation workspace (schema prefix "${cfg.schemaPrefix}")`);
    await dropBackend(ws, cfg);
    return schema;
  }
  await dropBackend(ws, cfg);
  return cfg.kind;
}

/**
 * `knode-os eval drop <run-dir>`: every knode build the run left. A build in
 * the evaluation root (docs/design/35 §3, `work/<pack>/<group>/workspace.json`)
 * goes whole — its index, then its folder — and never one whose manifest
 * names another run, nor one a live process holds. A build of a run made
 * before roots (`work/<pack>/<group>/ws`) loses its index, as it always did:
 * its schema in the evaluation database, or its embedded database. The
 * records, answers and scores stay; a dropped build is no longer reusable.
 * `url` overrides the database the workspaces' configs name (needed when
 * theirs carried a password: it lived only in the run's process).
 */
export async function dropRun(runDir: string, opts: { url?: string; log?: (m: string) => void } = {}): Promise<string[]> {
  const { loadConfig } = await import('../config.js');
  const { liveWriter, readEvalManifest, readWorkspacePointer, WORKSPACE_POINTER } = await import('./root.js');
  const run = path.resolve(runDir);
  const work = path.join(run, 'work');
  const dropped: string[] = [];
  if (!fs.existsSync(work)) return dropped;
  const configOf = (ws: string) => {
    const own = loadConfig(ws, { readOnly: true }).database;
    const cfg = opts.url ? evalDatabase(own, { url: opts.url }) : own;
    if (cfg.kind === 'postgres' && cfg.url?.startsWith('env:') && !process.env[cfg.url.slice(4)]) {
      throw new Error(`${ws}: its database URL was in the run's environment (${cfg.url.slice(4)}), not in its config — pass --database-url`);
    }
    return cfg;
  };
  const said = (what: string, cfg: DatabaseConfig) => (what === cfg.kind ? `its ${what} index` : `schema ${what} in ${describeDatabase(cfg)}`);
  for (const pack of fs.readdirSync(work)) {
    for (const group of fs.readdirSync(path.join(work, pack))) {
      const workDir = path.join(work, pack, group);
      const pointer = readWorkspacePointer(workDir);
      if (pointer) {
        const ws = pointer.dir;
        if (!fs.existsSync(ws)) {
          opts.log?.(`${pack}/${group}: ${ws} is gone already`);
          fs.rmSync(path.join(workDir, WORKSPACE_POINTER), { force: true });
          continue;
        }
        const manifest = readEvalManifest(ws);
        if (!manifest || path.resolve(manifest.evaluation.run) !== run) {
          opts.log?.(`${pack}/${group}: left ${ws} alone — its manifest names ${manifest ? manifest.evaluation.run : 'no run'}, not this one`);
          continue;
        }
        const writer = liveWriter(manifest.evaluation);
        if (writer && writer.pid !== process.pid) throw new Error(`${ws} is held by process ${writer.pid} (since ${writer.since}): stop that run first`);
        const cfg = configOf(ws);
        const what = await dropEvalWorkspace(ws, cfg);
        fs.rmSync(ws, { recursive: true, force: true });
        fs.rmSync(path.join(workDir, WORKSPACE_POINTER), { force: true });
        opts.log?.(`${pack}/${group}: dropped the workspace ${manifest.id} and ${said(what, cfg)}`);
        dropped.push(what);
        continue;
      }
      const ws = path.join(workDir, 'ws');
      if (!fs.existsSync(path.join(ws, 'knode.config.json'))) continue;
      const cfg = configOf(ws);
      const what = await dropEvalWorkspace(ws, cfg);
      opts.log?.(`${pack}/${group}: dropped ${said(what, cfg)}`);
      dropped.push(what);
    }
  }
  return dropped;
}
