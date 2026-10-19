import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSourceConfig } from '../src/config.js';
import { DuckdbConnector } from '../src/datasource/duckdb.js';
import { runSourceQuery } from '../src/datasource/execute.js';
import { assertReadOnlySql, sqlDialectForKind, stripSqlLiterals } from '../src/datasource/guard.js';
import { MysqlConnector } from '../src/datasource/mysql.js';
import { DataSourceRegistry } from '../src/datasource/registry.js';
import { TimescaleConnector } from '../src/datasource/timescale.js';
import { CLIENT_MULTI_STATEMENTS, startFakeMysql, type FakeMysql } from './helpers/fake-mysql.js';
import { startPgliteWire, type PgliteWire } from './helpers/pglite-wire.js';

/**
 * Agent SQL against a live source must not be able to write. The guard reads
 * the statement by its database's lexical rules; each connector then has the
 * database refuse writes and second statements itself. Connector tests call
 * `connector.query` directly, skipping the guard, so what they show is the
 * database's own refusal.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-dsro-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('SQL guard: read by the rules of the database that runs the statement', () => {
  const pg = (sql: string) => () => assertReadOnlySql(sql, 'postgres');
  const my = (sql: string) => () => assertReadOnlySql(sql, 'mysql');

  it('reads MySQL sources by MySQL rules, the rest by PostgreSQL rules', () => {
    expect(sqlDialectForKind('mysql')).toBe('mysql');
    expect(sqlDialectForKind('timescale')).toBe('postgres');
    expect(sqlDialectForKind('duckdb')).toBe('postgres');
  });

  it('sees the DELETE that PostgreSQL would run after a $$ string, a backslash or a carriage return', () => {
    // one harmless SELECT to a dialect-neutral reading; a SELECT and a DELETE to PostgreSQL and DuckDB
    expect(pg("SELECT $$'$$; DELETE FROM t; --'")).toThrow(/multiple/);
    expect(pg("SELECT '\\'; DELETE FROM t; --'")).toThrow(/multiple/);
    expect(pg('SELECT 1 -- note\r; DELETE FROM t')).toThrow(/multiple/);
    // PostgreSQL continues a string across a newline in the first part's escape mode
    expect(pg("SELECT E'a'\n'\\'' ; DELETE FROM t ; -- '")).toThrow(/multiple/);
  });

  it('passes what PostgreSQL reads as one read, which a neutral reading refused', () => {
    expect(pg('SELECT $$a;b$$ AS s, $tag$ drop; delete $tag$ AS t')).not.toThrow();
    expect(pg('SELECT 1 /* outer /* inner */ still the comment; delete */')).not.toThrow();
    expect(pg("SELECT 'it''s' AS s, E'tab\\there' AS e, 'a'\n'b; delete' AS continued")).not.toThrow();
    expect(pg('SELECT q1delete FROM t')).not.toThrow(); // one name, not "q1" and "delete"
  });

  it('sees the statement MySQL would run after # and --x, and inside an executable comment', () => {
    expect(my('SELECT 1 #\n; DELETE FROM t')).toThrow(/multiple/);
    expect(my('SELECT 1 --1; DELETE FROM t')).toThrow(/multiple/); // `--1` is minus minus one to MySQL
    expect(my("SELECT * FROM t /*!50000 INTO OUTFILE '/tmp/x' */")).toThrow(/INTO/);
    expect(my('SELECT 1 /* a /* b */ ; DELETE FROM t')).toThrow(/multiple/); // MySQL comments do not nest
    // the same texts read by PostgreSQL's rules
    expect(pg('SELECT 1 # 2; DELETE FROM t')).toThrow(/multiple/); // `#` is an operator there
    expect(pg('SELECT 1 --1; DELETE FROM t')).not.toThrow();
  });

  it("refuses MariaDB's statements that can lift read-only for themselves", () => {
    // the server runs these even in a read-only session; none begins with a read keyword
    expect(my('SET STATEMENT transaction_read_only=0 FOR TRUNCATE t')).toThrow(/must start with/);
    expect(my('BEGIN NOT ATOMIC SET SESSION TRANSACTION READ WRITE; COMMIT; DELETE FROM t; END')).toThrow(/multiple|must start with/);
    expect(my('IF 1 THEN DELETE FROM t; END IF')).toThrow(/multiple|must start with/);
    expect(my('/*M!100100 SET STATEMENT transaction_read_only=0 FOR */ TRUNCATE t')).toThrow(/must start with/);
  });

  it('passes what MySQL reads as one read', () => {
    expect(my('SELECT 1 # ; DELETE FROM t')).not.toThrow();
    expect(my("SELECT 'it\\'s; delete' AS s, \"x\\\"; drop\" AS d, `delete;x` FROM t")).not.toThrow();
    expect(my('SELECT /*+ MAX_EXECUTION_TIME(1000) */ * FROM t')).not.toThrow();
  });

  it('refuses SELECT … INTO, EXPLAIN ANALYSE and statements it cannot finish reading', () => {
    expect(pg('SELECT * INTO copied FROM t')).toThrow(/INTO/);
    expect(my("SELECT * FROM t INTO OUTFILE '/tmp/x'")).toThrow(/INTO/);
    expect(pg('EXPLAIN ANALYSE SELECT 1')).toThrow(/ANALYSE/);
    expect(pg("SELECT 'abc")).toThrow(/unterminated string literal/);
    expect(pg('SELECT 1 /* abc')).toThrow(/unterminated comment/);
    expect(pg('SELECT $q$ abc')).toThrow(/unterminated dollar-quoted string/);
    expect(my('SELECT `abc')).toThrow(/unterminated quoted identifier/);
    expect(my('SELECT 1 /*! abc')).toThrow(/unterminated comment/);
  });

  it('strips literals and comments to the same placeholders as before', () => {
    const stripped = stripSqlLiterals(`SELECT a FROM t WHERE b = 'x;y' AND "c" = $$z$$ -- d\n/* e */`);
    expect(stripped.replace(/\s+/g, ' ').trim()).toBe('SELECT a FROM t WHERE b = ?str? AND id = ?str?');
    expect(stripSqlLiterals('SELECT 1 # x', 'mysql').trim()).toBe('SELECT 1');
  });
});

describe('TimescaleDB / PostgreSQL connector: the server keeps agent SQL read-only', () => {
  let db: PGlite;
  let wire: PgliteWire;
  let source: TimescaleConnector;
  const config = (port: number): DataSourceConfig => ({
    id: 'ts', kind: 'timescale', host: '127.0.0.1', port, user: 'agent', database: 'postgres', timeoutMs: 1500,
  });
  const quotesLeft = async () => (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM quotes')).rows[0].n;
  /** PGlite is one session shared with the wire: outside a call, no transaction may be left open. */
  const sessionReadOnly = async () => (await db.query<{ ro: string }>(`SELECT current_setting('transaction_read_only') AS ro`)).rows[0].ro;

  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`CREATE TABLE quotes (symbol text PRIMARY KEY, close numeric);
                   INSERT INTO quotes VALUES ('300750', 182.5), ('600519', 1520);`);
    wire = await startPgliteWire(db);
    source = new TimescaleConnector(config(wire.port));
  });
  afterAll(async () => {
    await source?.close();
    await wire?.close();
    await db?.close();
  });

  it('reads inside a READ ONLY transaction under the statement timeout, then rolls back', async () => {
    const res = await source.query(
      `SELECT current_setting('transaction_read_only') AS ro, current_setting('statement_timeout') AS timeout, count(*)::int AS n FROM quotes`,
    );
    expect(res.rows).toEqual([{ ro: 'on', timeout: '1500ms', n: 2 }]);
    expect(await sessionReadOnly()).toBe('off');
  });

  it('has the server refuse a second statement, however it is hidden', async () => {
    for (const sql of [
      'SELECT 1; DELETE FROM quotes',
      "SELECT $$'$$; DELETE FROM quotes; --'",
      "SELECT '\\'; DELETE FROM quotes; --'",
      'SELECT 1 -- note\r; DELETE FROM quotes',
      "SELECT E'a'\n'\\'' ; DELETE FROM quotes ; -- '",
    ]) {
      await expect(source.query(sql), JSON.stringify(sql)).rejects.toThrow(/cannot insert multiple commands into a prepared statement/);
    }
    expect(await quotesLeft()).toBe(2);
    expect(await sessionReadOnly()).toBe('off');
  });

  it('has the server refuse writes, DDL and data-modifying CTEs', async () => {
    for (const sql of [
      "INSERT INTO quotes VALUES ('000001', 1)",
      'UPDATE quotes SET close = 0',
      'DELETE FROM quotes',
      'TRUNCATE quotes',
      'CREATE TABLE stolen (x int)',
      'SELECT * INTO copied FROM quotes',
      'WITH gone AS (DELETE FROM quotes RETURNING *) SELECT count(*) FROM gone',
    ]) {
      await expect(source.query(sql), sql).rejects.toThrow(/read-only transaction/);
    }
    expect(await quotesLeft()).toBe(2);
    expect(await sessionReadOnly()).toBe('off');
  });

  it('lets nothing a statement changed reach the next call', async () => {
    await source.query(`SELECT set_config('knode.leak', 'x', false)`);
    const after = await source.query(`SELECT current_setting('knode.leak', true) AS v`);
    expect(after.rows[0].v ?? '').toBe('');
    // a session-level advisory lock survives a rollback; the session is discarded after it
    await source.query('SELECT pg_advisory_lock(4242)');
    const locks = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`);
    expect(locks.rows[0].n).toBe(0);
  });

  it('answers through runSourceQuery, whose guard now reads PostgreSQL rules', async () => {
    const registry = new DataSourceRegistry(tmp, [config(wire.port)]);
    try {
      await expect(runSourceQuery(registry, 'ts', 'SELECT 1 -- note\r; DELETE FROM quotes')).rejects.toThrow(/multiple SQL statements/);
      // a neutral reading saw a `;` here and refused a harmless query
      expect((await runSourceQuery(registry, 'ts', 'SELECT $$a;b$$ AS s')).rows).toEqual([{ s: 'a;b' }]);
    } finally {
      await registry.closeAll();
    }
  });
});

describe('MySQL connector: what it asks of the server', () => {
  let server: FakeMysql;
  let mariadb = false;

  beforeAll(async () => {
    server = await startFakeMysql((sql) => {
      if (mariadb && /^SET SESSION max_execution_time/.test(sql)) {
        return { error: { code: 1193, message: "Unknown system variable 'max_execution_time'" } };
      }
      if (/SLEEP\(/.test(sql)) return 'hang';
      if (/FROM quotes/.test(sql) && !/^INSERT/.test(sql)) return { rows: [{ symbol: '300750', close: '182.5' }] };
      return undefined;
    });
  });
  afterAll(async () => {
    await server?.close();
  });

  const connector = (timeoutMs: number) =>
    new MysqlConnector({ id: 'm', kind: 'mysql', host: '127.0.0.1', port: server.port, user: 'agent', database: 'fake', timeoutMs });
  /** Everything the connector's connections sent, from the session at index `from` on. */
  const sentSince = (from: number) => server.sessions.slice(from).flatMap((s) => s.received);

  it('never asks for multi-statement support, so the server refuses a second statement', async () => {
    const from = server.sessions.length;
    const source = connector(2000);
    try {
      await expect(source.query('SELECT 1; DROP TABLE quotes')).rejects.toThrow(/SQL syntax/);
      expect(server.sessions.length).toBe(from + 1);
      expect(server.sessions[from].clientFlags & CLIENT_MULTI_STATEMENTS).toBe(0);
      expect(sentSince(from)).toContain('ROLLBACK');
    } finally {
      await source.close();
    }
  });

  it('would have seen the flag had the pool asked for it', async () => {
    const from = server.sessions.length;
    const pool = mysql.createPool({ host: '127.0.0.1', port: server.port, user: 'agent', database: 'fake', multipleStatements: true });
    try {
      await pool.query('SELECT 1');
      expect(server.sessions[from].clientFlags & CLIENT_MULTI_STATEMENTS).not.toBe(0);
    } finally {
      await pool.end();
    }
  });

  it('runs each statement in a READ ONLY transaction, then rolls back and resets the session', async () => {
    const from = server.sessions.length;
    const source = connector(2000);
    try {
      expect((await source.query('SELECT * FROM quotes')).rows).toEqual([{ symbol: '300750', close: '182.5' }]);
      await expect(source.query("INSERT INTO quotes VALUES ('x', 1)")).rejects.toThrow(/READ ONLY transaction/);
      await source.query('SELECT * FROM quotes');
      const call = (sql: string) => [
        'SET SESSION max_execution_time = 2000', 'SET SESSION TRANSACTION READ ONLY', 'START TRANSACTION READ ONLY', sql, 'ROLLBACK', 'RESET',
      ];
      expect(sentSince(from)).toEqual([
        ...call('SELECT * FROM quotes'),
        ...call("INSERT INTO quotes VALUES ('x', 1)"),
        ...call('SELECT * FROM quotes'),
      ]);
      // a refused statement does not cost the connection
      expect(server.sessions.length).toBe(from + 1);
    } finally {
      await source.close();
    }
  });

  it("times statements with MariaDB's max_statement_time when the server has no max_execution_time", async () => {
    const from = server.sessions.length;
    const source = connector(1500);
    mariadb = true;
    try {
      await source.query('SELECT * FROM quotes');
      await source.query('SELECT * FROM quotes');
      expect(sentSince(from).filter((sql) => /^SET SESSION max_/.test(sql))).toEqual([
        'SET SESSION max_execution_time = 1500',
        'SET SESSION max_statement_time = 1.5',
        'SET SESSION max_statement_time = 1.5',
      ]);
    } finally {
      mariadb = false;
      await source.close();
    }
  });

  it('closes a connection whose statement outlived the timeout instead of queueing behind it', async () => {
    const from = server.sessions.length;
    const source = connector(200);
    try {
      await expect(source.query('SELECT SLEEP(60)')).rejects.toThrow(/timeout/i);
      await expect.poll(() => server.sessions[from].closed, { timeout: 2000 }).toBe(true);
      expect(server.sessions[from].received).not.toContain('ROLLBACK');
      expect((await source.query('SELECT * FROM quotes')).rows).toHaveLength(1);
      expect(server.sessions.length).toBe(from + 2);
    } finally {
      await source.close();
    }
  });
});

/**
 * Opt-in: a real MySQL or MariaDB, named by KNODE_TEST_MYSQL_HOST (with
 * _PORT, _USER, _PASSWORD). The user needs CREATE and DROP on databases; the
 * test makes one throwaway database and drops it again.
 */
const realMysql = process.env.KNODE_TEST_MYSQL_HOST;

describe.skipIf(!realMysql)('MySQL connector against a real server', () => {
  const database = `knode_ds_test_${Math.floor(Date.now() / 1000)}_${crypto.randomBytes(4).toString('hex')}`;
  const access = {
    host: realMysql ?? '127.0.0.1',
    port: Number(process.env.KNODE_TEST_MYSQL_PORT ?? 3306),
    user: process.env.KNODE_TEST_MYSQL_USER ?? 'root',
    password: process.env.KNODE_TEST_MYSQL_PASSWORD ?? '',
  };
  let admin: mysql.Connection;
  let source: MysqlConnector;
  const quotesLeft = async () => {
    const [rows] = await admin.query<mysql.RowDataPacket[]>(`SELECT count(*) AS n FROM \`${database}\`.quotes`);
    return Number(rows[0].n);
  };

  beforeAll(async () => {
    admin = await mysql.createConnection(access);
    await admin.query(`CREATE DATABASE \`${database}\``);
    await admin.query(`CREATE TABLE \`${database}\`.quotes (symbol VARCHAR(16) PRIMARY KEY, close DECIMAL(12, 2))`);
    await admin.query(`INSERT INTO \`${database}\`.quotes VALUES ('300750', 182.5), ('600519', 1520)`);
    source = new MysqlConnector({ id: 'm', kind: 'mysql', ...access, database, timeoutMs: 2000 });
  });
  afterAll(async () => {
    await source?.close();
    await admin?.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin?.end();
  });

  it('refuses writes, and DDL despite its implicit commit', async () => {
    for (const sql of [
      "INSERT INTO quotes VALUES ('000001', 1)",
      'UPDATE quotes SET close = 0',
      'DELETE FROM quotes',
      'TRUNCATE quotes',
      'CREATE TABLE stolen (x INT)',
      'ALTER TABLE quotes ADD COLUMN z INT',
      'RENAME TABLE quotes TO moved',
      'DROP TABLE quotes',
    ]) {
      await expect(source.query(sql), sql).rejects.toMatchObject({ errno: 1792 });
    }
    expect(await quotesLeft()).toBe(2);
  });

  it('stops a statement at the timeout', async () => {
    const started = Date.now();
    // MySQL ends a lone SLEEP early and returns 1; MariaDB raises max_statement_time
    await source.query('SELECT SLEEP(5) AS slept', { timeoutMs: 500 }).catch(() => null);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('refuses a second statement', async () => {
    await expect(source.query('SELECT 1; DELETE FROM quotes')).rejects.toMatchObject({ errno: 1064 });
    expect(await quotesLeft()).toBe(2);
  });

  it('leaves no session state for the next call', async () => {
    await source.query('SELECT @knode_leak := 1 AS v');
    expect((await source.query('SELECT @knode_leak AS v')).rows).toEqual([{ v: null }]);
  });
});

describe('DuckDB connector: DuckDB itself keeps agent SQL read-only', () => {
  const root = path.join(tmp, 'duck');
  const lake = path.join(root, 'lake');
  const bars = path.join(lake, 'bars.csv');
  const original = 'symbol,close\n300750,182.5\n600519,1520\n';
  let source: DuckdbConnector;

  beforeAll(() => {
    fs.mkdirSync(lake, { recursive: true });
    fs.writeFileSync(bars, original);
    fs.writeFileSync(path.join(lake, 'notes.txt'), 'not a table\n');
    fs.writeFileSync(path.join(root, 'secret.txt'), 'outside the source\n');
    source = new DuckdbConnector({ id: 'lake', kind: 'duckdb', path: 'lake', timeoutMs: 5000 }, root);
  });
  afterAll(async () => {
    await source?.close();
  });

  const untouched = () => {
    expect(fs.readFileSync(bars, 'utf8')).toBe(original);
    expect(fs.readdirSync(lake).sort()).toEqual(['bars.csv', 'notes.txt']);
  };

  it('reads its views, and what DuckDB rewrites into queries', async () => {
    expect(Number((await source.query('SELECT count(*) AS n FROM bars')).rows[0].n)).toBe(2);
    for (const sql of ['DESCRIBE bars', 'SHOW TABLES', 'SUMMARIZE bars', 'EXPLAIN SELECT * FROM bars', 'EXPLAIN ANALYZE SELECT * FROM bars', 'EXPLAIN (FORMAT json) SELECT 1']) {
      await expect(source.query(sql), sql).resolves.toBeTruthy();
    }
  });

  it('has DuckDB refuse a second statement the guard never saw', async () => {
    // DuckDB reads '\' as a string holding a backslash, so this is three statements to it
    await expect(source.query(`SELECT '\\' ; COPY (SELECT 1 AS x) TO '${path.join(lake, 'evil.csv')}' ; --'`)).rejects.toThrow(
      /multiple SQL statements/,
    );
    untouched();
  });

  it('runs only queries: COPY, CREATE, ATTACH, SET, INSTALL and the rest are refused before they run', async () => {
    for (const sql of [
      // the sandbox lets DuckDB write the files behind its views, so this one is stopped by its type alone
      `COPY (SELECT 'pwned' AS symbol) TO '${bars}' (USE_TMP_FILE false)`,
      `ATTACH '${path.join(lake, 'x.db')}' AS x`,
      'CREATE TABLE t AS SELECT 1',
      'DROP VIEW bars',
      'SET threads = 1',
      'INSTALL httpfs',
      'LOAD httpfs',
      'CHECKPOINT',
      'BEGIN TRANSACTION',
      'PREPARE p AS SELECT 1',
    ]) {
      await expect(source.query(sql), sql).rejects.toThrow(/read-only: DuckDB runs only queries/);
    }
    // a new file is outside the sandbox: DuckDB refuses these while binding them
    for (const sql of [`COPY (SELECT 1 AS x) TO '${path.join(lake, 'evil.csv')}'`, `EXPORT DATABASE '${path.join(lake, 'dump')}'`]) {
      await expect(source.query(sql), sql).rejects.toThrow(/Permission Error/);
    }
    untouched();
  });

  it('refuses an EXPLAIN ANALYZE of anything but a query, however ANALYZE is written', async () => {
    for (const sql of [
      `EXPLAIN ANALYZE COPY (SELECT 'pwned' AS symbol) TO '${bars}' (USE_TMP_FILE false)`,
      `EXPLAIN ("analyze") COPY (SELECT 'pwned' AS symbol) TO '${bars}' (USE_TMP_FILE false)`,
      `EXPLAIN (FORMAT json, ANALYSE) COPY (SELECT 'pwned' AS symbol) TO '${bars}' (USE_TMP_FILE false)`,
      'EXPLAIN ANALYZE CREATE TABLE t AS SELECT 1',
    ]) {
      await expect(source.query(sql), sql).rejects.toThrow(/read-only: an EXPLAIN here must explain a query/);
    }
    untouched();
  });

  it('reads no file but the ones behind its views', async () => {
    for (const sql of [
      `SELECT * FROM read_text('${path.join(root, 'secret.txt')}')`,
      `SELECT * FROM read_csv_auto('${path.join(lake, 'notes.txt')}')`,
      `SELECT * FROM read_text('${path.join(lake, '..', 'secret.txt')}')`,
      `SELECT * FROM glob('${root}/*')`,
      "SELECT * FROM read_text('/etc/hosts')",
      "SELECT * FROM read_csv('http://127.0.0.1:1/x.csv')",
    ]) {
      await expect(source.query(sql), sql).rejects.toThrow(/Permission Error/);
    }
  });

  it('interrupts a statement at the timeout and keeps answering', async () => {
    const started = Date.now();
    await expect(source.query('SELECT sum(a.range * b.range) FROM range(200000) a, range(200000) b', { timeoutMs: 200 })).rejects.toThrow(
      /interrupt/i,
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(Number((await source.query('SELECT count(*) AS n FROM bars')).rows[0].n)).toBe(2);
  });

  it('answers through runSourceQuery, whose guard reads DuckDB by PostgreSQL rules', async () => {
    const registry = new DataSourceRegistry(root, [{ id: 'lake', kind: 'duckdb', path: 'lake' }]);
    try {
      await expect(runSourceQuery(registry, 'lake', "SELECT '\\' ; DROP VIEW bars ; --'")).rejects.toThrow(/multiple SQL statements/);
      expect((await runSourceQuery(registry, 'lake', 'SELECT $$a;b$$ AS s')).rows).toEqual([{ s: 'a;b' }]);
    } finally {
      await registry.closeAll();
    }
    untouched();
  });
});
