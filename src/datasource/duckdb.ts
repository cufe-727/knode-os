import fs from 'node:fs';
import path from 'node:path';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { DataSourceConfig } from '../config.js';
import {
  assertIdentifier,
  DataSourceConnector,
  DEFAULT_MAX_ROWS,
  normalizeRows,
  QueryOptions,
  QueryResult,
  TableSchema,
} from './types.js';

/**
 * DuckDB over a directory of parquet / CSV files — the MVP stand-in for an
 * HDFS / data-lake table. Each <name>.parquet or <name>.csv (also .tsv, and
 * gzip-compressed variants) becomes a queryable view <name>; when both a
 * parquet and a CSV share a stem the parquet wins.
 */

interface DataFile {
  file: string;
  view: string;
  reader: 'read_parquet' | 'read_csv_auto';
}
export class DuckdbConnector implements DataSourceConnector {
  readonly kind = 'duckdb' as const;
  readonly dialect = 'sql' as const;
  private conn: Promise<DuckDBConnection> | null = null;

  constructor(readonly config: DataSourceConfig, private readonly dataDir: string) {}

  get id(): string {
    return this.config.id;
  }

  private get dir(): string {
    const p = this.config.path ?? '.';
    return path.isAbsolute(p) ? p : path.resolve(this.dataDir, p);
  }

  private async connect(): Promise<DuckDBConnection> {
    if (!this.conn) {
      this.conn = (async () => {
        const instance = await DuckDBInstance.create(':memory:');
        const conn = await instance.connect();
        for (const { file, view, reader } of this.dataFiles()) {
          await conn.run(`CREATE OR REPLACE VIEW "${view}" AS SELECT * FROM ${reader}('${file.replace(/'/g, "''")}')`);
        }
        return conn;
      })();
    }
    return this.conn;
  }

  private dataFiles(): DataFile[] {
    if (!fs.existsSync(this.dir)) return [];
    const byView = new Map<string, DataFile>();
    for (const f of fs.readdirSync(this.dir).sort()) {
      const lower = f.toLowerCase();
      let reader: DataFile['reader'] | null = null;
      if (/\.parquet$/.test(lower)) reader = 'read_parquet';
      else if (/\.(csv|tsv)(\.gz)?$/.test(lower)) reader = 'read_csv_auto';
      if (!reader) continue;
      const stem = f.replace(/\.(parquet|csv|tsv)(\.gz)?$/i, '');
      const view = stem.replace(/[^a-zA-Z0-9_]/g, '_');
      const existing = byView.get(view);
      if (existing && existing.reader === 'read_parquet') continue; // parquet beats csv for the same stem
      byView.set(view, { file: path.join(this.dir, f), view, reader });
    }
    return [...byView.values()];
  }

  async introspect(): Promise<TableSchema[]> {
    const conn = await this.connect();
    const out: TableSchema[] = [];
    for (const { view } of this.dataFiles()) {
      const desc = await conn.runAndReadAll(`DESCRIBE "${view}"`);
      const cols = desc.getRowObjectsJson().map((r) => ({ name: String(r.column_name), type: String(r.column_type) }));
      const count = await conn.runAndReadAll(`SELECT count(*) AS n FROM "${view}"`);
      const n = Number(count.getRowObjectsJson()[0]?.n ?? 0);
      out.push({ name: view, columns: cols, rowCount: n });
    }
    return out;
  }

  async query(sql: string, opts: QueryOptions = {}): Promise<QueryResult> {
    const maxRows = opts.maxRows ?? this.config.maxRows ?? DEFAULT_MAX_ROWS;
    const conn = await this.connect();
    const t0 = Date.now();
    const reader = await conn.runAndReadAll(sql);
    const { rows, truncated } = normalizeRows(reader.getRowObjectsJson() as Record<string, unknown>[], maxRows);
    return {
      source: this.id,
      columns: reader.columnNames(),
      rows,
      rowCount: rows.length,
      truncated,
      asOf: new Date().toISOString(),
      elapsedMs: Date.now() - t0,
    };
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
    if (this.conn) {
      const conn = await this.conn;
      conn.disconnectSync();
      this.conn = null;
    }
  }
}
