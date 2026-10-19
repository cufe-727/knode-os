import { DataSourceConfig, DataSourceKind, SourceDialect } from '../config.js';

/**
 * Connector abstraction over external live data sources (MySQL, TimescaleDB,
 * parquet-via-DuckDB, …). knode-os deliberately does NOT copy their rows into
 * its own index — it introspects schemas, links entity values into the graph,
 * and passes native queries through at request time. "One logical database,
 * many physical systems."
 */

export interface ColumnSchema {
  name: string;
  type: string;
}

export interface TableSchema {
  name: string;
  columns: ColumnSchema[];
  rowCount: number | null;
}

export interface QueryResult {
  source: string;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  /** When the rows were read from the live system. Live data is never persisted. */
  asOf: string;
  elapsedMs: number;
}

export interface QueryOptions {
  maxRows?: number;
  timeoutMs?: number;
}

export interface DataSourceConnector {
  readonly id: string;
  readonly kind: DataSourceKind;
  /**
   * How `query`'s statement is written. Only `sql` is passed through the SQL
   * guard; the other dialects are read-only by construction — an HTTP source
   * can reach nothing but its declared endpoints, PromQL cannot write, and the
   * object store is opened read-only.
   */
  readonly dialect: SourceDialect;
  readonly config: DataSourceConfig;
  /** List the queryable units — tables, endpoints or metrics — with their fields. */
  introspect(): Promise<TableSchema[]>;
  /**
   * Run one read-only request in this source's dialect. A SQL connector has its
   * database enforce that — one statement, in a read-only transaction that is
   * always rolled back, under a timeout — and callers still pass the statement
   * through the SQL guard first (`runSourceQuery`), for an early, readable refusal.
   */
  query(statement: string, opts?: QueryOptions): Promise<QueryResult>;
  /** Distinct values of one column (entity linking); optional alias columns ride along. */
  sampleColumn(table: string, column: string, aliasColumns: string[], limit: number): Promise<{ value: string; aliases: string[] }[]>;
  /** A few example rows for the wiki dataset page. */
  sampleRows(table: string, limit: number): Promise<QueryResult>;
  close(): Promise<void>;
}

export const DEFAULT_MAX_ROWS = 200;
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * How long one call may run, in milliseconds: the call's own limit, else the
 * source's, else the default. Never 0, which PostgreSQL and MySQL read as "no
 * limit", and never past what their timeout settings accept.
 */
export function queryTimeoutMs(opts: QueryOptions, config: DataSourceConfig): number {
  for (const ms of [opts.timeoutMs, config.timeoutMs]) {
    if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 1) return Math.min(Math.floor(ms), 2_147_483_647);
  }
  return DEFAULT_TIMEOUT_MS;
}

/** Clamp + JSON-sanitize driver rows (BigInt, Date, Buffer → JSON-safe). */
export function normalizeRows(rows: Record<string, unknown>[], maxRows: number): { rows: Record<string, unknown>[]; truncated: boolean } {
  const truncated = rows.length > maxRows;
  const out = rows.slice(0, maxRows).map((r) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) o[k] = jsonSafe(v);
    return o;
  });
  return { rows: out, truncated };
}

function jsonSafe(v: unknown): unknown {
  if (typeof v === 'bigint') return v >= Number.MIN_SAFE_INTEGER && v <= Number.MAX_SAFE_INTEGER ? Number(v) : v.toString();
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  return v;
}

/** Guard table/column identifiers interpolated into introspection SQL. */
export function assertIdentifier(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(name)) throw new Error(`invalid identifier: ${name}`);
  return name;
}
