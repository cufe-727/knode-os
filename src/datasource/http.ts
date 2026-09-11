import { DataSourceConfig, HttpEndpointConfig, resolveSecret } from '../config.js';
import {
  DataSourceConnector,
  DEFAULT_MAX_ROWS,
  DEFAULT_TIMEOUT_MS,
  normalizeRows,
  QueryOptions,
  QueryResult,
  TableSchema,
} from './types.js';

/**
 * JSON-over-HTTP source. The declared endpoints are an **allowlist**, not a
 * template: a request naming an endpoint that is not in the config, or passing
 * a parameter the endpoint does not declare, is refused. That is what keeps a
 * configured HTTP source from turning into an open proxy an agent (or anything
 * that reached an agent's context) can point at an arbitrary host.
 *
 * Statements are written `<endpoint>?a=1&b=2`, or as JSON
 * `{"endpoint":"quote","params":{"symbol":"300750"}}`.
 */
export class HttpJsonConnector implements DataSourceConnector {
  readonly kind = 'http-json' as const;
  readonly dialect = 'http' as const;

  constructor(readonly config: DataSourceConfig) {
    if (!config.baseUrl) throw new Error(`datasource ${config.id}: http-json requires baseUrl`);
  }

  get id(): string {
    return this.config.id;
  }

  private get endpoints(): HttpEndpointConfig[] {
    return this.config.endpoints ?? [];
  }

  async introspect(): Promise<TableSchema[]> {
    return this.endpoints.map((e) => ({
      name: e.name,
      columns: (e.fields ?? []).map((f) => ({ name: f.name, type: f.type })),
      rowCount: null,
    }));
  }

  async query(statement: string, opts: QueryOptions = {}): Promise<QueryResult> {
    const { endpoint, params } = parseStatement(statement);
    const decl = this.endpoints.find((e) => e.name === endpoint);
    if (!decl) {
      throw new Error(
        `http source ${this.id}: unknown endpoint "${endpoint}" — declared: ${this.endpoints.map((e) => e.name).join(', ') || 'none'}`,
      );
    }
    const declared = new Set((decl.params ?? []).map((p) => p.name));
    for (const key of Object.keys(params)) {
      if (!declared.has(key)) {
        throw new Error(`http source ${this.id}: endpoint "${endpoint}" does not accept parameter "${key}"`);
      }
    }
    for (const p of decl.params ?? []) {
      if (p.required && params[p.name] === undefined) throw new Error(`http source ${this.id}: "${p.name}" is required by endpoint "${endpoint}"`);
    }

    const maxRows = opts.maxRows ?? this.config.maxRows ?? DEFAULT_MAX_ROWS;
    const timeout = opts.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const url = this.buildUrl(decl, params);
    const t0 = Date.now();
    const res = await fetch(url, {
      method: 'GET',
      headers: this.headers(),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`http source ${this.id}: ${endpoint} returned ${res.status} ${res.statusText}`);
    const body = await res.json();
    const records = extractRecords(body, decl.resultPath);
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

  private buildUrl(decl: HttpEndpointConfig, params: Record<string, string>): string {
    let path = decl.path;
    const query = new URLSearchParams();
    for (const p of decl.params ?? []) {
      const value = params[p.name];
      if (value === undefined) continue;
      if (p.in === 'path') path = path.replace(new RegExp(`\\{${p.name}\\}`, 'g'), encodeURIComponent(value));
      else query.set(p.name, value);
    }
    const base = this.config.baseUrl!.replace(/\/+$/, '');
    const rel = path.replace(/^\/+/, '');
    const qs = query.toString();
    return `${base}/${rel}${qs ? `?${qs}` : ''}`;
  }

  private headers(): Record<string, string> {
    const out: Record<string, string> = { accept: 'application/json' };
    for (const [k, v] of Object.entries(this.config.headers ?? {})) out[k] = resolveSecret(v);
    return out;
  }

  async sampleColumn(endpoint: string, param: string, aliasColumns: string[], limit: number): Promise<{ value: string; aliases: string[] }[]> {
    // A live endpoint has no column to enumerate without calling it; entity
    // linking for HTTP sources comes from the locators the config declares.
    void endpoint; void param; void aliasColumns; void limit;
    return [];
  }

  async sampleRows(endpoint: string, limit: number): Promise<QueryResult> {
    return this.query(endpoint, { maxRows: limit });
  }

  async close(): Promise<void> {
    /* fetch keeps no pool */
  }
}

/** `name?a=1&b=2` or `{"endpoint":"name","params":{…}}`. */
export function parseStatement(statement: string): { endpoint: string; params: Record<string, string> } {
  const raw = statement.trim();
  if (raw.startsWith('{')) {
    const parsed = JSON.parse(raw) as { endpoint?: string; params?: Record<string, unknown> };
    if (!parsed.endpoint) throw new Error('http statement JSON must carry an "endpoint"');
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.params ?? {})) params[k] = String(v);
    return { endpoint: parsed.endpoint, params };
  }
  const at = raw.indexOf('?');
  if (at === -1) return { endpoint: raw, params: {} };
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw.slice(at + 1))) params[k] = v;
  return { endpoint: raw.slice(0, at), params };
}

/** Follow a dotted path to the records array; fall back to the body itself. */
export function extractRecords(body: unknown, resultPath?: string): Record<string, unknown>[] {
  let node: unknown = body;
  if (resultPath) {
    for (const part of resultPath.split('.')) {
      if (node && typeof node === 'object') node = (node as Record<string, unknown>)[part];
      else return [];
    }
  }
  if (Array.isArray(node)) return node.map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : { value: r }));
  if (node && typeof node === 'object') return [node as Record<string, unknown>];
  return node === undefined || node === null ? [] : [{ value: node }];
}
