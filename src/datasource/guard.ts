import type { DataSourceKind } from '../config.js';

/**
 * Read-only SQL guard for agent-issued native queries: one statement, starting
 * with a read keyword, naming no write keyword.
 *
 * It is the early, explainable layer, not the only one. Each SQL connector
 * also has the database refuse what the guard refuses — the statement runs
 * alone, in a read-only transaction that is always rolled back, under a
 * timeout (timescale.ts, mysql.ts, duckdb.ts) — so a statement the guard
 * misreads still cannot write. To keep the guard's own errors accurate, it
 * reads a statement by the rules of the database that will run it:
 * PostgreSQL's for TimescaleDB, DuckDB (whose parser is PostgreSQL's) and the
 * catalog; MySQL's for MySQL. Read by one neutral set of rules, a `$$…$$`
 * string, a backslash in a standard '…' string, a nested comment or a
 * `#` comment can hide a `;` or a keyword that the database then runs.
 */

/** Whose lexical rules a statement is read by. */
export type SqlDialect = 'postgres' | 'mysql';

/** The lexical rules a source of this kind is spoken to in. */
export function sqlDialectForKind(kind: DataSourceKind | string): SqlDialect {
  return kind === 'mysql' ? 'mysql' : 'postgres';
}

const ALLOWED_FIRST = new Set(['select', 'show', 'describe', 'desc', 'explain', 'with', 'table', 'values']);

const BANNED = new Set([
  'insert', 'update', 'delete', 'merge', 'replace', 'upsert',
  'create', 'alter', 'drop', 'truncate', 'rename',
  'grant', 'revoke', 'set', 'reset', 'use',
  'call', 'do', 'execute', 'prepare', 'deallocate',
  'copy', 'load', 'install', 'attach', 'detach', 'export', 'import',
  'vacuum', 'analyze', 'analyse', 'pragma', 'checkpoint',
  'lock', 'unlock', 'begin', 'commit', 'rollback', 'start',
  // SELECT … INTO makes a table (PostgreSQL) or writes a file on the server
  // (MySQL's INTO OUTFILE / DUMPFILE), which a read-only transaction allows
  'into',
]);

export interface SqlToken {
  /**
   * `word`: an unquoted name or keyword, lower-cased the way both databases
   * fold keywords (ASCII only); `quoted`: a quoted name, unescaped; `string`:
   * a string literal, dollar-quoted ones included; `number`: a number or `$n`;
   * `punct`: one character of punctuation or an operator.
   */
  kind: 'word' | 'quoted' | 'string' | 'number' | 'punct';
  text: string;
  /** `sql.slice(start, end)` is the token as written. */
  start: number;
  end: number;
}

export interface LexedSql {
  tokens: SqlToken[];
  /** What the statement left open — a string, a quoted name, a comment — if it ends inside one. */
  unterminated?: string;
}

const SPACE = /[ \t\n\r\f\v]/;
const NUMBER = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

const PG_WORD = /[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*/y;
const PG_DOLLAR_QUOTE = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y;
const PG_PARAM = /\$\d+/y;
/** E'…' escapes with backslashes; U&'…', B'…', X'…' and N'…' quote like '…'. */
const PG_STRING_PREFIX = /(?:[eE]|[uU]&|[bBxXnN])'/y;
const PG_QUOTED_PREFIX = /[uU]&"/y;
/**
 * Whitespace holding a newline, then a quote: PostgreSQL continues the string
 * literal before it there, in that literal's escape mode — `E'a'⏎'\''` is one
 * E-string, a vertical tab before the newline included. (One character or one
 * whole comment line per repetition, so a failed match cannot backtrack
 * exponentially.)
 */
const PG_QUOTE_CONTINUE = /[ \t\f\v]*(?:--[^\n\r]*)?[\n\r](?:[ \t\n\r\f\v]|--[^\n\r]*[\n\r])*'/y;

const MYSQL_WORD = /[A-Za-z_$\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*/y;
/** An executable comment's opening — `/*!`, `/*!80013`, MariaDB's `/*M!100100` — whose text MySQL runs as SQL. */
const MYSQL_EXECUTABLE = /\/\*M?!(?:\d{5,6})?/y;

function match(re: RegExp, sql: string, at: number): string | undefined {
  re.lastIndex = at;
  return re.exec(sql)?.[0];
}

/** ASCII-only lower-casing, which is how both databases fold unquoted keywords. */
const fold = (word: string) => word.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * The index just past the quote closing the literal that opens at `open`, or
 * -1 if the statement ends first. A doubled quote stands for itself; with
 * `backslash`, a backslash escapes the character after it.
 */
function closeQuote(sql: string, open: number, backslash: boolean): number {
  const quote = sql[open];
  let i = open + 1;
  while (i < sql.length) {
    if (backslash && sql[i] === '\\') i += 2;
    else if (sql[i] !== quote) i++;
    else if (sql[i + 1] === quote) i += 2;
    else return i + 1;
  }
  return -1;
}

/** Where a line comment starting at `from` stops: before the first of `ends`, or at the end. */
function lineEnd(sql: string, from: number, ends: string): number {
  let i = from;
  while (i < sql.length && !ends.includes(sql[i])) i++;
  return i;
}

/** The tokens `sql` holds, read by `dialect`'s lexical rules. Comments and whitespace are dropped. */
export function lexSql(sql: string, dialect: SqlDialect = 'postgres'): LexedSql {
  return dialect === 'mysql' ? lexMysql(sql) : lexPostgres(sql);
}

/**
 * PostgreSQL's rules (DuckDB shares them): a backslash is an ordinary character
 * in '…' and escapes only in E'…'; $tag$…$tag$ quotes a string; block comments
 * nest; a -- comment ends at a newline or a carriage return; `#` and backticks
 * are operators.
 */
function lexPostgres(sql: string): LexedSql {
  const tokens: SqlToken[] = [];
  let i = 0;
  while (i < sql.length) {
    const start = i;
    const ch = sql[i];
    let m: string | undefined;
    if (SPACE.test(ch)) {
      i++;
    } else if (sql.startsWith('--', i)) {
      i = lineEnd(sql, i, '\n\r');
    } else if (sql.startsWith('/*', i)) {
      let depth = 0;
      do {
        if (sql.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else {
          i++;
        }
      } while (depth > 0 && i < sql.length);
      if (depth > 0) return { tokens, unterminated: 'comment' };
    } else if (ch === "'" || (m = match(PG_STRING_PREFIX, sql, i))) {
      const backslash = m !== undefined && (m[0] === 'e' || m[0] === 'E');
      let end = closeQuote(sql, i + (m ? m.length - 1 : 0), backslash);
      let more: string | undefined;
      while (end !== -1 && (more = match(PG_QUOTE_CONTINUE, sql, end))) end = closeQuote(sql, end + more.length - 1, backslash);
      if (end === -1) return { tokens, unterminated: 'string literal' };
      tokens.push({ kind: 'string', text: sql.slice(start, end), start, end });
      i = end;
    } else if (ch === '"' || (m = match(PG_QUOTED_PREFIX, sql, i))) {
      const open = i + (m ? m.length - 1 : 0);
      const end = closeQuote(sql, open, false);
      if (end === -1) return { tokens, unterminated: 'quoted identifier' };
      tokens.push({ kind: 'quoted', text: sql.slice(open + 1, end - 1).replace(/""/g, '"'), start, end });
      i = end;
    } else if ((m = match(PG_DOLLAR_QUOTE, sql, i))) {
      const close = sql.indexOf(m, i + m.length);
      if (close === -1) return { tokens, unterminated: 'dollar-quoted string' };
      i = close + m.length;
      tokens.push({ kind: 'string', text: sql.slice(start, i), start, end: i });
    } else if ((m = match(PG_PARAM, sql, i) ?? match(NUMBER, sql, i))) {
      i += m.length;
      tokens.push({ kind: 'number', text: m, start, end: i });
    } else if ((m = match(PG_WORD, sql, i))) {
      i += m.length;
      tokens.push({ kind: 'word', text: fold(m), start, end: i });
    } else {
      i++;
      tokens.push({ kind: 'punct', text: ch, start, end: i });
    }
  }
  return { tokens };
}

/**
 * MySQL's rules, in its default sql_mode: '…' and "…" are strings in which a
 * backslash escapes; `…` quotes a name; `#` starts a comment, and so does `--`
 * followed by a space or a control character (`--x` is two minus signs);
 * block comments do not nest; and an executable comment (`/*! … *\/`) is SQL
 * the server runs, so its text is read as code.
 */
function lexMysql(sql: string): LexedSql {
  const tokens: SqlToken[] = [];
  let executable = false;
  let i = 0;
  while (i < sql.length) {
    const start = i;
    const ch = sql[i];
    let m: string | undefined;
    if (SPACE.test(ch)) {
      i++;
    } else if (ch === '#' || (sql.startsWith('--', i) && (i + 2 >= sql.length || sql.charCodeAt(i + 2) <= 0x20 || sql.charCodeAt(i + 2) === 0x7f))) {
      i = lineEnd(sql, i, '\n\0');
    } else if ((m = match(MYSQL_EXECUTABLE, sql, i))) {
      executable = true;
      i += m.length;
    } else if (executable && sql.startsWith('*/', i)) {
      executable = false;
      i += 2;
    } else if (sql.startsWith('/*', i)) {
      const close = sql.indexOf('*/', i + 2);
      if (close === -1) return { tokens, unterminated: 'comment' };
      i = close + 2;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const end = closeQuote(sql, i, ch !== '`');
      if (end === -1) return { tokens, unterminated: ch === '`' ? 'quoted identifier' : 'string literal' };
      if (ch === '`') tokens.push({ kind: 'quoted', text: sql.slice(i + 1, end - 1).replace(/``/g, '`'), start, end });
      else tokens.push({ kind: 'string', text: sql.slice(start, end), start, end });
      i = end;
    } else if ((m = match(NUMBER, sql, i))) {
      i += m.length;
      tokens.push({ kind: 'number', text: m, start, end: i });
    } else if ((m = match(MYSQL_WORD, sql, i))) {
      i += m.length;
      tokens.push({ kind: 'word', text: fold(m), start, end: i });
    } else {
      i++;
      tokens.push({ kind: 'punct', text: ch, start, end: i });
    }
  }
  return executable ? { tokens, unterminated: 'comment' } : { tokens };
}

/**
 * `sql` with every string literal, quoted identifier and comment replaced by a
 * placeholder, read by `dialect`'s rules — so a keyword scan over the result
 * sees only what the database parses as SQL.
 */
export function stripSqlLiterals(sql: string, dialect: SqlDialect = 'postgres'): string {
  const { tokens } = lexSql(sql, dialect);
  let out = '';
  let at = 0;
  for (const t of tokens) {
    if (t.start > at) out += ' '; // whitespace or a comment
    out += t.kind === 'string' ? ' ?str? ' : t.kind === 'quoted' ? ' id ' : sql.slice(t.start, t.end);
    at = t.end;
  }
  return out;
}

const isSemicolon = (t: SqlToken | undefined) => t?.kind === 'punct' && t.text === ';';

/** Throw unless `sql` is a single read-only statement, read by `dialect`'s lexical rules. */
export function assertReadOnlySql(sql: string, dialect: SqlDialect = 'postgres'): void {
  const { tokens, unterminated } = lexSql(sql, dialect);
  if (unterminated) throw new Error(`read-only guard: unterminated ${unterminated}`);
  const body = isSemicolon(tokens[tokens.length - 1]) ? tokens.slice(0, -1) : tokens;
  if (!body.length) throw new Error('empty SQL statement');
  if (body.some(isSemicolon)) throw new Error('multiple SQL statements are not allowed');

  const first = body.find((t) => t.kind === 'word')?.text;
  if (!first || !ALLOWED_FIRST.has(first)) {
    throw new Error(`read-only guard: statement must start with SELECT/SHOW/DESCRIBE/EXPLAIN/WITH (got "${first ?? '?'}")`);
  }
  const banned = body.find((t) => t.kind === 'word' && BANNED.has(t.text));
  if (banned) throw new Error(`read-only guard: keyword "${banned.text.toUpperCase()}" is not allowed`);
}

/**
 * Escape a value for inlining as a SQL string literal (probe templating).
 * Backslashes are dropped instead of escaped — MySQL and Postgres disagree on
 * their meaning, and no legitimate entity name/ticker contains one.
 */
export function sqlStringLiteral(value: string): string {
  return `'${value.replace(/\\/g, '').replace(/'/g, "''")}'`;
}
