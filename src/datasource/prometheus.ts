import { DataSourceConfig, PrometheusMetricConfig, resolveSecret } from '../config.js';
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
 * Prometheus source. Statements are PromQL, run through the instant-query
 * endpoint (`/api/v1/query`) — which cannot mutate anything, so no write guard
 * is needed. An optional `@ <rfc3339|unix>` suffix asks for a past instant,
 * which is how a plan's `as_of` reaches a metric source.
 *
 *     up{job="api"}
 *     rate(http_requests_total[5m]) @ 2026-09-01T00:00:00Z
 *
 * Results are flattened to one row per series: its labels plus `value` and
 * `timestamp`, so a metric reads like any other table.
 */
export class PrometheusConnector implements DataSourceConnector {
  readonly kind = 'prometheus' as const;
  readonly dialect = 'promql' as const;

  constructor(readonly config: DataSourceConfig) {
    if (!config.baseUrl) throw new Error(`datasource ${config.id}: prometheus requires baseUrl`);
  }

  get id(): string {
    return this.config.id;
  }

  async introspect(): Promise<TableSchema[]> {
    const declared = this.config.metrics ?? [];
    if (declared.length > 0) return declared.map((m) => schemaOf(m));
    // no declared list: ask the server what it has
    const names = await this.fetchJson<{ data?: string[] }>('/api/v1/label/__name__/values');
    return (names.data ?? []).slice(0, 500).map((name) => schemaOf({ name }));
  }

  async query(statement: string, opts: QueryOptions = {}): Promise<QueryResult> {
    const { expr, time } = splitInstant(statement);
    if (!expr) throw new Error(`prometheus source ${this.id}: empty PromQL expression`);
    const maxRows = opts.maxRows ?? this.config.maxRows ?? DEFAULT_MAX_ROWS;
    const params = new URLSearchParams({ query: expr });
    if (time) params.set('time', time);
    const t0 = Date.now();
    const body = await this.fetchJson<PromResponse>(`/api/v1/query?${params}`, opts.timeoutMs);
    if (body.status !== 'success') throw new Error(`prometheus source ${this.id}: ${body.error ?? 'query failed'}`);
    const { rows, truncated } = normalizeRows(flatten(body), maxRows);
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

  private async fetchJson<T>(rel: string, timeoutMs?: number): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    for (const [k, v] of Object.entries(this.config.headers ?? {})) headers[k] = resolveSecret(v);
    const res = await fetch(`${this.config.baseUrl!.replace(/\/+$/, '')}${rel}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`prometheus source ${this.id}: ${res.status} ${res.statusText}`);
    return res.json() as Promise<T>;
  }

  /** Distinct label values — the metric equivalent of sampling a column. */
  async sampleColumn(metric: string, label: string, aliasColumns: string[], limit: number): Promise<{ value: string; aliases: string[] }[]> {
    void aliasColumns;
    const params = new URLSearchParams({ 'match[]': metric });
    const body = await this.fetchJson<{ data?: string[] }>(`/api/v1/label/${encodeURIComponent(label)}/values?${params}`);
    return (body.data ?? []).slice(0, limit).filter((v) => v.trim()).map((value) => ({ value, aliases: [] }));
  }

  async sampleRows(metric: string, limit: number): Promise<QueryResult> {
    return this.query(metric, { maxRows: limit });
  }

  async close(): Promise<void> {
    /* stateless */
  }
}

function schemaOf(m: PrometheusMetricConfig): TableSchema {
  return {
    name: m.name,
    columns: [
      ...(m.labels ?? []).map((l) => ({ name: l, type: 'label' })),
      { name: 'value', type: 'float' },
      { name: 'timestamp', type: 'timestamp' },
    ],
    rowCount: null,
  };
}

interface PromResponse {
  status: string;
  error?: string;
  data?: { resultType?: string; result?: { metric?: Record<string, string>; value?: [number, string]; values?: [number, string][] }[] };
}

/** `expr @ time` — the instant to evaluate at, when the caller asked for one. */
export function splitInstant(statement: string): { expr: string; time: string | null } {
  const raw = statement.trim();
  const m = /\s@\s*([^\s@]+)\s*$/.exec(raw);
  if (!m) return { expr: raw, time: null };
  const value = m[1];
  const iso = /^\d+(\.\d+)?$/.test(value) ? value : String(Date.parse(value) / 1000);
  return { expr: raw.slice(0, m.index).trim(), time: Number.isNaN(Number(iso)) ? null : iso };
}

/** One row per series: labels + value + timestamp. */
function flatten(body: PromResponse): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const series of body.data?.result ?? []) {
    const labels = series.metric ?? {};
    const points = series.values ?? (series.value ? [series.value] : []);
    for (const [ts, value] of points) {
      out.push({ ...labels, timestamp: new Date(ts * 1000).toISOString(), value: Number(value) });
    }
  }
  return out;
}
