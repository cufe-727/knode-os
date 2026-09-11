import { assertReadOnlySql, stripSqlLiterals } from '../datasource/guard.js';
import { Store } from './db.js';

/**
 * The projection database as a queryable source. `knode_query` routes
 * `source: "catalog"` here, so an agent that needs a shape the fixed tools do
 * not expose — "claims per source this month", "entities with one lone
 * supporting document" — can ask SQL instead of paging a tool.
 *
 * Only the `v_*` views are reachable. They exclude fold bookkeeping and
 * default to currently-believed rows, so no query can accidentally read
 * tombstoned knowledge as if it were current, and no schema change to the
 * base tables leaks into agent-written SQL.
 */

export const CATALOG_SOURCE = 'catalog';

export const CATALOG_VIEWS: { name: string; description: string }[] = [
  { name: 'v_documents', description: 'indexed sources: path, root (docs/skills/wiki), kind (source/view), sha, status' },
  { name: 'v_entities', description: 'currently believed entities with mention and evidence counts' },
  { name: 'v_relations', description: 'currently believed typed edges with folded weight' },
  { name: 'v_claims', description: 'currently believed claims with their world-time window and source path' },
  { name: 'v_scopes', description: 'every apply of a source, including disposed ones (applied_at / disposed_at)' },
  { name: 'v_evidence', description: 'per-source support behind each graph row, with its system-time window' },
  { name: 'v_pages', description: 'materialized wiki views and their input signatures' },
  { name: 'v_datasets', description: 'registered live tables and their schemas' },
  { name: 'v_mentions', description: 'entity ↔ chunk ↔ document grounding' },
  { name: 'v_capabilities', description: 'what can be asked of which source, with schema, cost and freshness' },
  { name: 'v_locators', description: 'how to reach an entity through a capability: parameter and value to bind' },
  { name: 'v_capability_notes', description: 'the written semantic layer: metric definitions, joins, pitfalls' },
  { name: 'v_receipts', description: 'one row per resolve: plan handed out, calls made, ids used' },
  { name: 'v_capability_stats', description: 'per (intent, slot, capability): attempts, successes, usage, latency' },
  { name: 'v_disputes', description: 'open contradictions between claims, and how they were resolved' },
  { name: 'v_worksets', description: 'pinned views for long-running tasks' },
];

const VIEW_NAMES = new Set(CATALOG_VIEWS.map((v) => v.name));
const DEFAULT_MAX_ROWS = 200;
const HARD_MAX_ROWS = 1000;

/** Names bound by `WITH x AS (…)`, which may legitimately appear after FROM/JOIN. */
function cteNames(stripped: string): Set<string> {
  const out = new Set<string>();
  for (const m of stripped.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s+as\s*\(/gi)) out.add(m[1].toLowerCase());
  return out;
}

/** Throw unless every relation the statement reads is one of the catalog views. */
export function assertCatalogTables(sql: string): void {
  const stripped = stripSqlLiterals(sql);
  const ctes = cteNames(stripped);
  for (const m of stripped.matchAll(/\b(?:from|join)\s+([a-zA-Z_][a-zA-Z0-9_.$]*)/gi)) {
    const name = m[1].toLowerCase();
    if (ctes.has(name) || VIEW_NAMES.has(name)) continue;
    throw new Error(
      `catalog: "${m[1]}" is not readable — the catalog exposes only ${[...VIEW_NAMES].join(', ')}`,
    );
  }
}

export interface CatalogResult {
  source: typeof CATALOG_SOURCE;
  /** System time the rows were read at — the catalog is always read live. */
  asOf: string;
  rowCount: number;
  /** The row cap was reached; narrow the query rather than assuming this is everything. */
  truncated: boolean;
  rows: Record<string, unknown>[];
  elapsedMs: number;
}

/**
 * Run one read-only SELECT against the catalog views. The statement is wrapped
 * in an outer LIMIT, so a query without one cannot return the whole graph.
 */
export async function catalogQuery(store: Store, sql: string, opts: { maxRows?: number } = {}): Promise<CatalogResult> {
  assertReadOnlySql(sql);
  const trimmed = sql.trim().replace(/;\s*$/, '');
  const first = stripSqlLiterals(trimmed).trim().match(/[a-zA-Z_]+/)?.[0]?.toLowerCase();
  if (first !== 'select' && first !== 'with') {
    throw new Error(`catalog: only SELECT / WITH statements are supported (got "${first ?? '?'}")`);
  }
  assertCatalogTables(trimmed);

  const maxRows = Math.min(Math.max(opts.maxRows ?? DEFAULT_MAX_ROWS, 1), HARD_MAX_ROWS);
  const started = Date.now();
  const rows = await store.query<Record<string, unknown>>(
    `SELECT * FROM (${trimmed}) AS catalog_query LIMIT $1`,
    [maxRows + 1],
  );
  const truncated = rows.length > maxRows;
  return {
    source: CATALOG_SOURCE,
    asOf: new Date().toISOString(),
    rowCount: Math.min(rows.length, maxRows),
    truncated,
    rows: rows.slice(0, maxRows),
    elapsedMs: Date.now() - started,
  };
}
