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
  queryTimeoutMs,
  TableSchema,
} from './types.js';

/** The server has no such variable — MariaDB names its statement timeout differently. */
const ER_UNKNOWN_SYSTEM_VARIABLE = 1193;
/** How much longer than the server's own timeout the driver waits before giving up on a statement. */
const DRIVER_GRACE_MS = 1_000;

export class MysqlConnector implements DataSourceConnector {
  readonly kind = 'mysql' as const;
  readonly dialect = 'sql' as const;
  private pool: mysql.Pool;
  /** The server is MariaDB, whose statement timeout is max_statement_time, in seconds. Learned on first use. */
  private mariadb = false;

  constructor(readonly config: DataSourceConfig) {
    this.pool = mysql.createPool({
      host: config.host ?? '127.0.0.1',
      port: config.port ?? 3306,
      user: config.user ?? 'root',
      password: resolveSecret(config.password ?? ''),
      database: config.database,
      connectionLimit: 4,
      connectTimeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      // never negotiate CLIENT_MULTI_STATEMENTS, so the server itself refuses `SELECT 1; DROP …`
      multipleStatements: false,
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
    const t0 = Date.now();
    const [rows, fields] = await this.readOnly(sql, queryTimeoutMs(opts, this.config));
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

  /**
   * Run one statement the way the server keeps it read-only, whatever the
   * database user may do: alone (no multi-statement support), inside START
   * TRANSACTION READ ONLY in a session whose every transaction is read-only,
   * under the server's statement timeout. The session matters because DDL
   * commits the transaction it finds and runs in a new one: with only the
   * transaction read-only, MariaDB runs `TRUNCATE` or `DROP TABLE`. Afterwards
   * the transaction is rolled back and the session reset (COM_RESET_CONNECTION):
   * MySQL does not roll back a SET, a user variable or a named lock, so
   * without the reset they would reach the next call on this connection.
   *
   * One gap is MariaDB's own: `SET STATEMENT transaction_read_only=0 FOR …` and
   * compound statements (`BEGIN NOT ATOMIC … END`, `IF … END IF`) can lift the
   * read-only mode within a single statement. None of them begins with a read
   * keyword, so the guard refuses them; a read-only database user closes it.
   */
  private async readOnly(sql: string, timeoutMs: number): Promise<[mysql.RowDataPacket[], mysql.FieldPacket[]]> {
    const conn = await this.pool.getConnection();
    let reusable = true;
    try {
      await this.limitStatementTime(conn, timeoutMs);
      await conn.query('SET SESSION TRANSACTION READ ONLY');
      await conn.query('START TRANSACTION READ ONLY');
      try {
        // the driver's timer backs up the server's, which times only SELECTs (capped where Node's timers stop counting)
        return await conn.query<mysql.RowDataPacket[]>({ sql, timeout: Math.min(timeoutMs + DRIVER_GRACE_MS, 2_147_483_647) });
      } catch (err) {
        // the driver gave up, the server may still be running it: close the connection rather than queue behind it
        if ((err as { code?: string }).code === 'PROTOCOL_SEQUENCE_TIMEOUT') reusable = false;
        throw err;
      } finally {
        if (reusable) {
          await conn
            .query('ROLLBACK')
            .then(() => conn.reset())
            .catch(() => {
              reusable = false;
            });
        }
      }
    } finally {
      if (reusable) conn.release();
      else conn.destroy();
    }
  }

  /** Bound the statement on the server: MySQL's max_execution_time, else MariaDB's max_statement_time. */
  private async limitStatementTime(conn: mysql.PoolConnection, ms: number): Promise<void> {
    if (!this.mariadb) {
      try {
        await conn.query(`SET SESSION max_execution_time = ${ms}`);
        return;
      } catch (err) {
        if ((err as { errno?: number }).errno !== ER_UNKNOWN_SYSTEM_VARIABLE) throw err;
        this.mariadb = true;
      }
    }
    await conn.query(`SET SESSION max_statement_time = ${ms / 1000}`);
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
