import { KnodeConfig } from '../config.js';
import { CATALOG_SOURCE, CatalogResult, catalogRowCap, catalogViewNames, validateCatalogSql } from '../store/catalog.js';
import { Store } from '../store/db.js';

/**
 * Read-only SQL for remote callers, over the same catalog views `knode_query`
 * exposes — with the database enforcing what the text guard only checks.
 *
 * The guard in src/store/catalog.ts reads the statement: one SELECT over v_*
 * views, no write keywords. It does not stop a function call in the select
 * list, and the service's own connection is a superuser one. So a remote query
 * also runs
 *
 *   - in a READ ONLY transaction that is always rolled back, so neither a
 *     write nor a changed setting (`set_config`) survives the statement;
 *   - under a statement timeout;
 *   - on Postgres, as `knode_remote_reader`: a role that cannot log in and may
 *     only SELECT the catalog views, so server-side file reads, backend
 *     signals and the rest of what a superuser may call are refused.
 */

export const REMOTE_SQL_ROLE = 'knode_remote_reader';
const DEFAULT_TIMEOUT_MS = 15_000;

class RolledBack extends Error {
  constructor(readonly rows: Record<string, unknown>[]) {
    super('rolled back');
  }
}

const ensuredSchemas = new Set<string>();

/** Create the reader role (once per cluster) and grant it this schema's catalog views. */
async function ensureReaderRole(store: Store): Promise<void> {
  const [{ schema }] = await store.query<{ schema: string }>(`SELECT current_schema() AS schema`);
  if (ensuredSchemas.has(schema)) return;
  const [role] = await store.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1`, [REMOTE_SQL_ROLE]);
  if (!role?.n) {
    try {
      await store.exec(`CREATE ROLE ${REMOTE_SQL_ROLE} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    } catch (err) {
      // a concurrent creator, or a database user that may not create roles
      if (!/already exists/i.test(err instanceof Error ? err.message : String(err))) throw err;
    }
  }
  const quoted = `"${schema.replace(/"/g, '""')}"`;
  await store.exec(`GRANT USAGE ON SCHEMA ${quoted} TO ${REMOTE_SQL_ROLE}`);
  for (const view of catalogViewNames()) {
    await store.exec(`GRANT SELECT ON ${quoted}."${view.replace(/"/g, '""')}" TO ${REMOTE_SQL_ROLE}`);
  }
  ensuredSchemas.add(schema);
}

export async function remoteCatalogQuery(
  store: Store,
  config: Pick<KnodeConfig, 'database'>,
  sql: string,
  opts: { maxRows?: number; timeoutMs?: number } = {},
): Promise<CatalogResult> {
  const statement = validateCatalogSql(sql);
  const maxRows = catalogRowCap(opts.maxRows);
  const timeoutMs = Math.min(Math.max(1_000, Math.floor(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)), 60_000);
  const postgres = config.database?.kind !== 'pglite';
  if (postgres) await ensureReaderRole(store);
  const started = Date.now();
  let rows: Record<string, unknown>[] = [];
  try {
    await store.tx(async (q) => {
      await q.query('SET TRANSACTION READ ONLY');
      await q.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
      if (postgres) await q.query(`SET LOCAL ROLE ${REMOTE_SQL_ROLE}`);
      const result = await q.query<Record<string, unknown>>(`SELECT * FROM (${statement}) AS catalog_query LIMIT $1`, [maxRows + 1]);
      throw new RolledBack(result);
    });
  } catch (err) {
    if (!(err instanceof RolledBack)) throw err;
    rows = err.rows;
  }
  return {
    source: CATALOG_SOURCE,
    asOf: new Date().toISOString(),
    rowCount: Math.min(rows.length, maxRows),
    truncated: rows.length > maxRows,
    rows: rows.slice(0, maxRows),
    elapsedMs: Date.now() - started,
  };
}
