import pg from 'pg';
import { DataSourceConfig, resolveSecret } from '../config.js';
import {
  assertIdentifier,
  DataSourceConnector,
  DEFAULT_MAX_ROWS,
  DEFAULT_TIMEOUT_MS,
  normalizeRows,
  QueryOptions,
  QueryResult,
  queryTimeoutMs,
  TableSchema,
} from './types.js';

/**
 * The extended query protocol: its Parse message holds exactly one statement,
 * so the server itself refuses `SELECT 1; DELETE …`. (node-postgres has the
 * switch; its typings do not.)
 */
const extendedProtocol = (text: string) => ({ text, queryMode: 'extended' }) as pg.QueryConfig;

/** TimescaleDB (plain Postgres wire protocol) connector for time-series tables. */
export class TimescaleConnector implements DataSourceConnector {
  readonly kind = 'timescale' as const;
  readonly dialect = 'sql' as const;
  private pool: pg.Pool;

  constructor(readonly config: DataSourceConfig) {
    this.pool = new pg.Pool({
      host: config.host ?? '127.0.0.1',
      port: config.port ?? 5432,
      user: config.user ?? 'postgres',
      password: resolveSecret(config.password ?? ''),
      database: config.database,
      max: 4,
      connectionTimeoutMillis: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      statement_timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  }

  get id(): string {
    return this.config.id;
  }

  async introspect(): Promise<TableSchema[]> {
    const cols = await this.pool.query(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
       ORDER BY table_name, ordinal_position`,
    );
    const tabs = await this.pool.query(
      `SELECT c.relname AS table_name, c.reltuples::bigint AS approx_rows
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`,
    );
    const rowCounts = new Map<string, number | null>(
      tabs.rows.map((t: { table_name: string; approx_rows: string | number }) => [
        String(t.table_name),
        Number(t.approx_rows) < 0 ? null : Number(t.approx_rows),
      ]),
    );
    const byTable = new Map<string, TableSchema>();
    for (const c of cols.rows as { table_name: string; column_name: string; data_type: string }[]) {
      if (!rowCounts.has(c.table_name)) continue; // skip views / hypertable chunks
      if (!byTable.has(c.table_name)) byTable.set(c.table_name, { name: c.table_name, columns: [], rowCount: rowCounts.get(c.table_name) ?? null });
      byTable.get(c.table_name)!.columns.push({ name: c.column_name, type: c.data_type });
    }
    return [...byTable.values()];
  }

  async query(sql: string, opts: QueryOptions = {}): Promise<QueryResult> {
    const maxRows = opts.maxRows ?? this.config.maxRows ?? DEFAULT_MAX_ROWS;
    const t0 = Date.now();
    const res = await this.readOnly(sql, queryTimeoutMs(opts, this.config));
    const { rows, truncated } = normalizeRows(res.rows as Record<string, unknown>[], maxRows);
    return {
      source: this.id,
      columns: res.fields?.map((f) => f.name) ?? Object.keys(rows[0] ?? {}),
      rows,
      rowCount: rows.length,
      truncated,
      asOf: new Date().toISOString(),
      elapsedMs: Date.now() - t0,
    };
  }

  /**
   * Run one statement the way the server keeps it read-only, whatever the
   * database user may do: alone (extended protocol), inside a READ ONLY
   * transaction that is always rolled back, under a statement timeout. Then
   * DISCARD ALL drops what a rollback leaves in the session — an advisory
   * lock, a prepared statement. So no write, setting or lock outlives the
   * call, even when the guard has misread the statement.
   */
  private async readOnly(sql: string, timeoutMs: number): Promise<pg.QueryResult> {
    const client = await this.pool.connect();
    let unusable: Error | undefined;
    try {
      await client.query('BEGIN TRANSACTION READ ONLY');
      try {
        await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
        return await client.query(extendedProtocol(sql));
      } finally {
        await client
          .query('ROLLBACK')
          .then(() => client.query('DISCARD ALL'))
          .catch((err: Error) => {
            unusable = err;
          });
      }
    } finally {
      // a connection that could not roll back is closed, not handed to the next call
      client.release(unusable);
    }
  }

  async sampleColumn(table: string, column: string, aliasColumns: string[], limit: number): Promise<{ value: string; aliases: string[] }[]> {
    const t = assertIdentifier(table);
    const c = assertIdentifier(column);
    const extras = aliasColumns.map(assertIdentifier);
    const select = [`"${c}" AS v`, ...extras.map((a, i) => `"${a}" AS a${i}`)].join(', ');
    const res = await this.query(
      `SELECT DISTINCT ${select} FROM "${t}" WHERE "${c}" IS NOT NULL LIMIT ${Math.floor(limit)}`,
      { maxRows: limit },
    );
    return res.rows
      .filter((r) => r.v !== null && r.v !== undefined && String(r.v).trim() !== '')
      .map((r) => ({
        value: String(r.v).trim(),
        aliases: extras.map((_, i) => r[`a${i}`]).filter((a) => a !== null && a !== undefined).map((a) => String(a).trim()),
      }));
  }

  async sampleRows(table: string, limit: number): Promise<QueryResult> {
    const t = assertIdentifier(table);
    return this.query(`SELECT * FROM "${t}" LIMIT ${Math.floor(limit)}`, { maxRows: limit });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
