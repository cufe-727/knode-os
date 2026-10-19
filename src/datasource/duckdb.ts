import fs from 'node:fs';
import path from 'node:path';
import { DuckDBConnection, DuckDBInstance, DuckDBPreparedStatement, StatementType } from '@duckdb/node-api';
import { DataSourceConfig } from '../config.js';
import { lexSql } from './guard.js';
import {
  assertIdentifier,
  DataSourceConnector,
  DEFAULT_MAX_ROWS,
  normalizeRows,
  QueryOptions,
  QueryResult,
  queryTimeoutMs,
  TableSchema,
} from './types.js';

/**
 * DuckDB over a directory of parquet / CSV files — the MVP stand-in for an
 * HDFS / data-lake table. Each <name>.parquet or <name>.csv (also .tsv, and
 * gzip-compressed variants) becomes a queryable view <name>; when both a
 * parquet and a CSV share a stem the parquet wins.
 *
 * The database is in memory and holds only those views, and it reaches no
 * file but the ones behind them: once they are created, external access is
 * switched off except for those paths, and the configuration is locked. So a
 * statement cannot read the rest of the disk, fetch a URL or load an
 * extension. Those data files themselves stay writable to DuckDB (COPY …
 * TO one of them, with USE_TMP_FILE false, would overwrite it), which is
 * why `query` lets DuckDB's own parser decide whether a statement only reads
 * before it runs.
 */

interface DataFile {
  file: string;
  view: string;
  reader: 'read_parquet' | 'read_csv_auto';
}

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export class DuckdbConnector implements DataSourceConnector {
  readonly kind = 'duckdb' as const;
  readonly dialect = 'sql' as const;
  private db: Promise<DuckDBInstance> | null = null;

  constructor(readonly config: DataSourceConfig, private readonly dataDir: string) {}

  get id(): string {
    return this.config.id;
  }

  private get dir(): string {
    const p = this.config.path ?? '.';
    return path.isAbsolute(p) ? p : path.resolve(this.dataDir, p);
  }

  private instance(): Promise<DuckDBInstance> {
    if (!this.db) {
      this.db = (async () => {
        const instance = await DuckDBInstance.create(':memory:');
        const setup = await instance.connect();
        try {
          const files = this.dataFiles();
          for (const { file, view, reader } of files) {
            await setup.run(`CREATE OR REPLACE VIEW "${view}" AS SELECT * FROM ${reader}(${quote(file)})`);
          }
          // from here on the instance reads its data files and nothing else; locked, so no statement can undo it
          if (files.length) await setup.run(`SET allowed_paths = [${files.map((f) => quote(f.file)).join(', ')}]`);
          await setup.run('SET enable_external_access = false');
          await setup.run('SET lock_configuration = true');
        } finally {
          setup.closeSync();
        }
        return instance;
      })();
    }
    return this.db;
  }

  /** A connection of its own per call, so one call's transaction, interrupt or failure cannot touch another's. */
  private async withConnection<T>(fn: (conn: DuckDBConnection) => Promise<T>): Promise<T> {
    const conn = await (await this.instance()).connect();
    try {
      return await fn(conn);
    } finally {
      conn.closeSync();
    }
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
    return this.withConnection(async (conn) => {
      const out: TableSchema[] = [];
      for (const { view } of this.dataFiles()) {
        const desc = await conn.runAndReadAll(`DESCRIBE "${view}"`);
        const cols = desc.getRowObjectsJson().map((r) => ({ name: String(r.column_name), type: String(r.column_type) }));
        const count = await conn.runAndReadAll(`SELECT count(*) AS n FROM "${view}"`);
        const n = Number(count.getRowObjectsJson()[0]?.n ?? 0);
        out.push({ name: view, columns: cols, rowCount: n });
      }
      return out;
    });
  }

  /**
   * Run one statement that DuckDB itself has judged read-only: its parser
   * must find exactly one statement, of a type that only reads, and it runs
   * in a READ ONLY transaction that is always rolled back, interrupted at the
   * timeout.
   */
  async query(sql: string, opts: QueryOptions = {}): Promise<QueryResult> {
    const maxRows = opts.maxRows ?? this.config.maxRows ?? DEFAULT_MAX_ROWS;
    return this.withConnection(async (conn) => {
      const timer = setTimeout(() => conn.interrupt(), queryTimeoutMs(opts, this.config));
      const t0 = Date.now();
      try {
        // preparing only binds; nothing runs before the statement is known to read
        const prepared = await readingStatement(conn, sql);
        try {
          await conn.run('BEGIN TRANSACTION READ ONLY');
          try {
            const reader = await prepared.runAndReadAll();
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
          } finally {
            // closing the connection discards the transaction too, so a failed rollback cannot hide the statement's error
            await conn.run('ROLLBACK').catch(() => {});
          }
        } finally {
          prepared.destroySync();
        }
      } finally {
        clearTimeout(timer);
      }
    });
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
    if (this.db) {
      const db = this.db;
      this.db = null;
      (await db).closeSync();
    }
  }
}

/**
 * `sql` prepared, if DuckDB's parser finds it to be one statement that only
 * reads: a query (SELECT, and what DuckDB rewrites into one — DESCRIBE, SHOW,
 * SUMMARIZE), or an EXPLAIN of one. EXPLAIN is a type of its own, and
 * EXPLAIN ANALYZE runs what it explains, so the explained statement is
 * prepared on its own and has to be a query too.
 */
async function readingStatement(conn: DuckDBConnection, sql: string): Promise<DuckDBPreparedStatement> {
  const statements = await conn.extractStatements(sql);
  if (statements.count !== 1) throw new Error('multiple SQL statements are not allowed');
  const prepared = await statements.prepare(0);
  try {
    const type = prepared.statementType;
    if (type === StatementType.SELECT) return prepared;
    if (type !== StatementType.EXPLAIN) throw new Error(`read-only: DuckDB runs only queries here, not ${StatementType[type] ?? type} statements`);
    if (await explainsQuery(conn, sql)) return prepared;
    throw new Error('read-only: an EXPLAIN here must explain a query (EXPLAIN ANALYZE runs what it explains)');
  } catch (err) {
    prepared.destroySync();
    throw err;
  }
}

/** Whether the statement an EXPLAIN explains — after ANALYZE and an option list like `(FORMAT json)` — is a query. */
async function explainsQuery(conn: DuckDBConnection, sql: string): Promise<boolean> {
  const toks = lexSql(sql, 'postgres').tokens;
  const word = (i: number, ...texts: string[]) => toks[i]?.kind === 'word' && texts.includes(toks[i].text);
  const punct = (i: number, text: string) => toks[i]?.kind === 'punct' && toks[i].text === text;
  if (!word(0, 'explain')) return false;
  let i = 1;
  if (word(i, 'analyze', 'analyse')) i++;
  // an option list, not a parenthesized query: `(` followed by an option name
  if (punct(i, '(') && !punct(i + 1, '(') && !word(i + 1, 'select', 'with', 'values', 'table', 'from')) {
    for (let depth = 0; i < toks.length; i++) {
      if (punct(i, '(')) depth++;
      else if (punct(i, ')') && --depth === 0) break;
    }
    i++;
  }
  if (!toks[i]) return false;
  try {
    const inner = await conn.prepare(sql.slice(toks[i].start));
    try {
      return inner.statementType === StatementType.SELECT;
    } finally {
      inner.destroySync();
    }
  } catch {
    return false;
  }
}
