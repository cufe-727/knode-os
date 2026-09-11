import fs from 'node:fs';
import path from 'node:path';
import { DataSourceConfig } from '../config.js';
import { safePath } from '../fs/files.js';
import {
  DataSourceConnector,
  DEFAULT_MAX_ROWS,
  normalizeRows,
  QueryOptions,
  QueryResult,
  TableSchema,
} from './types.js';

/**
 * Object store over a directory of binary files — the "we have 40k PDFs but
 * only care about six of them" case. Nothing is copied into the index: the
 * catalog holds metadata (key, size, modified, type) and the bytes stay put
 * until something asks for them.
 *
 * Statements:
 *
 *     list <prefix>       objects under a prefix (default: everything)
 *     stat <key>          one object's metadata
 *     head <key>          first bytes of a text-ish object, as a preview
 *
 * The root is opened read-only and every key is resolved through `safePath`,
 * so `..` cannot walk out of the configured directory.
 */
export class ObjectConnector implements DataSourceConnector {
  readonly kind = 'object' as const;
  readonly dialect = 'object' as const;
  private readonly root: string;

  constructor(readonly config: DataSourceConfig, dataDir: string) {
    if (!config.path) throw new Error(`datasource ${config.id}: object requires path`);
    this.root = path.isAbsolute(config.path) ? config.path : path.join(dataDir, config.path);
  }

  get id(): string {
    return this.config.id;
  }

  /** One "table" per top-level prefix, so each folder becomes its own capability. */
  async introspect(): Promise<TableSchema[]> {
    if (!fs.existsSync(this.root)) return [];
    const columns = [
      { name: 'key', type: 'text' },
      { name: 'bytes', type: 'bigint' },
      { name: 'modified', type: 'timestamp' },
      { name: 'ext', type: 'text' },
    ];
    const entries = fs.readdirSync(this.root, { withFileTypes: true });
    const prefixes = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    const objects = this.walk('');
    const out: TableSchema[] = prefixes.map((name) => ({
      name,
      columns,
      rowCount: objects.filter((o) => o.key.startsWith(`${name}/`)).length,
    }));
    const loose = objects.filter((o) => !o.key.includes('/')).length;
    if (loose > 0 || out.length === 0) out.unshift({ name: 'root', columns, rowCount: loose });
    return out;
  }

  async query(statement: string, opts: QueryOptions = {}): Promise<QueryResult> {
    const maxRows = opts.maxRows ?? this.config.maxRows ?? DEFAULT_MAX_ROWS;
    const t0 = Date.now();
    const trimmed = statement.trim();
    const [verbRaw, ...rest] = trimmed.split(/\s+/);
    const verb = verbRaw?.toLowerCase();
    const arg = rest.join(' ').trim();

    let records: Record<string, unknown>[];
    if (!verb || verb === 'list') {
      records = this.walk(verb === 'list' ? arg : trimmed);
    } else if (verb === 'stat') {
      const one = this.walk(arg).find((o) => o.key === arg);
      records = one ? [one] : [];
    } else if (verb === 'head') {
      records = [this.head(arg)];
    } else {
      throw new Error(`object source ${this.id}: unknown verb "${verbRaw}" — use list / stat / head`);
    }

    const { rows, truncated } = normalizeRows(records, maxRows);
    return {
      source: this.id,
      columns: Object.keys(rows[0] ?? {}),
      rows,
      rowCount: rows.length,
      truncated,
      asOf: new Date().toISOString(),
      elapsedMs: Date.now() - t0,
    };
  }

  private walk(prefix: string): { key: string; bytes: number; modified: string; ext: string }[] {
    if (!fs.existsSync(this.root)) return [];
    const wanted = this.config.extensions?.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase());
    const out: { key: string; bytes: number; modified: string; ext: string }[] = [];
    const clean = prefix.replace(/^\/+|\/+$/g, '');
    const walk = (rel: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(path.join(this.root, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const key = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          walk(key);
          continue;
        }
        if (!e.isFile()) continue;
        if (clean && !key.startsWith(clean)) continue;
        const ext = path.extname(e.name).toLowerCase();
        if (wanted && !wanted.includes(ext)) continue;
        const stat = fs.statSync(path.join(this.root, key));
        out.push({ key, bytes: stat.size, modified: stat.mtime.toISOString(), ext });
      }
    };
    walk('');
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  private head(key: string): Record<string, unknown> {
    const abs = safePath(this.root, key);
    const stat = fs.statSync(abs);
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(Math.min(2048, stat.size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      // a zero byte up front means binary: show a hex prefix instead of mojibake
      const binary = buf.includes(0);
      return {
        key,
        bytes: stat.size,
        binary,
        preview: binary ? buf.subarray(0, 64).toString('hex') : buf.toString('utf8'),
      };
    } finally {
      fs.closeSync(fd);
    }
  }

  async sampleColumn(prefix: string, column: string, aliasColumns: string[], limit: number): Promise<{ value: string; aliases: string[] }[]> {
    void aliasColumns;
    if (column !== 'key' && column !== 'ext') return [];
    const objects = this.walk(prefix === 'root' ? '' : prefix);
    const values = [...new Set(objects.map((o) => (column === 'ext' ? o.ext : o.key)))];
    return values.slice(0, limit).filter(Boolean).map((value) => ({ value, aliases: [] }));
  }

  async sampleRows(prefix: string, limit: number): Promise<QueryResult> {
    return this.query(`list ${prefix === 'root' ? '' : prefix}`, { maxRows: limit });
  }

  async close(): Promise<void> {
    /* nothing held open */
  }
}
