import mysql from 'mysql2/promise';
import { DataSourceConfig, resolveSecret } from '../config.js';
import {
  assertIdentifier,
  DataSourceConnector,
  DEFAULT_MAX_ROWS,
  DEFAULT_TIMEOUT_MS,
  normalizeRows,
  QueryOptions,
  QueryResult,
  TableSchema,
} from './types.js';

export class MysqlConnector implements DataSourceConnector {
  readonly kind = 'mysql' as const;
  readonly dialect = 'sql' as const;
  private pool: mysql.Pool;

  constructor(readonly config: DataSourceConfig) {
    this.pool = mysql.createPool({
      host: config.host ?? '127.0.0.1',
      port: config.port ?? 3306,
      user: config.user ?? 'root',
      password: resolveSecret(config.password ?? ''),
      database: config.database,
      connectionLimit: 4,
      connectTimeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  }

  get id(): string {
    return this.config.id;
  }

  async introspect(): Promise<TableSchema[]> {
    const [cols] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, COLUMN_TYPE AS column_type, ORDINAL_POSITION AS pos
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [this.config.database],
    );
    const [tabs] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT TABLE_NAME AS table_name, TABLE_ROWS AS table_rows
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`,
      [this.config.database],
    );
    const rowCounts = new Map<string, number | null>(tabs.map((t) => [String(t.table_name), t.table_rows === null ? null : Number(t.table_rows)]));
    const byTable = new Map<string, TableSchema>();
    for (const c of cols) {
      const table = String(c.table_name);
      if (!rowCounts.has(table)) continue;
      if (!byTable.has(table)) byTable.set(table, { name: table, columns: [], rowCount: rowCounts.get(table) ?? null });
      byTable.get(table)!.columns.push({ name: String(c.column_name), type: String(c.column_type) });
    }
    return [...byTable.values()];
  }

  async query(sql: string, opts: QueryOptions = {}): Promise<QueryResult> {
    const maxRows = opts.maxRows ?? this.config.maxRows ?? DEFAULT_MAX_ROWS;
    const timeout = opts.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const t0 = Date.now();
    const [rows, fields] = await this.pool.query<mysql.RowDataPacket[]>({ sql, timeout });
    const list = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    const { rows: normalized, truncated } = normalizeRows(list, maxRows);
    return {
      source: this.id,
      columns: fields?.map((f) => f.name) ?? Object.keys(normalized[0] ?? {}),
      rows: normalized,
      rowCount: normalized.length,
      truncated,
      asOf: new Date().toISOString(),
      elapsedMs: Date.now() - t0,
    };
  }

  async sampleColumn(table: string, column: string, aliasColumns: string[], limit: number): Promise<{ value: string; aliases: string[] }[]> {
    const t = assertIdentifier(table);
    const c = assertIdentifier(column);
    const extras = aliasColumns.map(assertIdentifier);
    const select = [`\`${c}\` AS v`, ...extras.map((a, i) => `\`${a}\` AS a${i}`)].join(', ');
    const res = await this.query(
      `SELECT DISTINCT ${select} FROM \`${t}\` WHERE \`${c}\` IS NOT NULL LIMIT ${Math.floor(limit)}`,
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
    return this.query(`SELECT * FROM \`${t}\` LIMIT ${Math.floor(limit)}`, { maxRows: limit });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
