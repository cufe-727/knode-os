/**
 * Read-only SQL guard for agent-issued native queries. Defense in depth:
 * the demo compose files also provision read-only DB users, but the guard
 * keeps embedded engines (DuckDB) and misconfigured sources safe too.
 */

const ALLOWED_FIRST = new Set(['select', 'show', 'describe', 'desc', 'explain', 'with', 'table', 'values']);

const BANNED = new Set([
  'insert', 'update', 'delete', 'merge', 'replace', 'upsert',
  'create', 'alter', 'drop', 'truncate', 'rename',
  'grant', 'revoke', 'set', 'reset', 'use',
  'call', 'do', 'execute', 'prepare', 'deallocate',
  'copy', 'load', 'install', 'attach', 'detach', 'export', 'import',
  'vacuum', 'analyze', 'pragma', 'checkpoint',
  'lock', 'unlock', 'begin', 'commit', 'rollback', 'start',
]);

/** Strip string literals, quoted identifiers and comments so keyword scanning cannot be fooled. */
export function stripSqlLiterals(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
      out += ' ';
    } else if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === '\\' && quote !== '`') i += 2;
        else if (sql[i] === quote && sql[i + 1] === quote) i += 2; // '' escape
        else if (sql[i] === quote) { i++; break; }
        else i++;
      }
      out += quote === '`' || quote === '"' ? ' id ' : ' ?str? ';
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** Throw unless `sql` is a single read-only statement. */
export function assertReadOnlySql(sql: string): void {
  const stripped = stripSqlLiterals(sql).trim().replace(/;\s*$/, '');
  if (!stripped) throw new Error('empty SQL statement');
  if (stripped.includes(';')) throw new Error('multiple SQL statements are not allowed');

  const first = stripped.match(/[a-zA-Z_]+/)?.[0]?.toLowerCase();
  if (!first || !ALLOWED_FIRST.has(first)) {
    throw new Error(`read-only guard: statement must start with SELECT/SHOW/DESCRIBE/EXPLAIN/WITH (got "${first ?? '?'}")`);
  }
  for (const m of stripped.matchAll(/[a-zA-Z_]+/g)) {
    const word = m[0].toLowerCase();
    if (BANNED.has(word)) {
      throw new Error(`read-only guard: keyword "${word.toUpperCase()}" is not allowed`);
    }
  }
}

/**
 * Escape a value for inlining as a SQL string literal (probe templating).
 * Backslashes are dropped instead of escaped — MySQL and Postgres disagree on
 * their meaning, and no legitimate entity name/ticker contains one.
 */
export function sqlStringLiteral(value: string): string {
  return `'${value.replace(/\\/g, '').replace(/'/g, "''")}'`;
}
