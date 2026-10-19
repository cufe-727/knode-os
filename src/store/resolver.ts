import { normalizePrefixes } from '../lineage/declared.js';
import { normalizeDateExpr } from './dates.js';
import { Queryable } from './migrations.js';
import { Params, TimeInput, toIso } from './temporal.js';

/**
 * Temporal Resolver + scope filters: the one place that turns loosely typed
 * agent input into an explicit query envelope.
 *
 * Three times are kept apart on purpose — conflating them is the classic way
 * an agent reads a stale number and calls it current:
 *
 *   tx time    (`as_of`)                what the knowledge base believed then
 *   valid time (`valid_at`/`valid_range`)  when the asserted fact holds in the world
 *   freshness  (`freshness`)            how old a live/federated read may be
 *
 * `as_of` narrows history, `valid_at` narrows the world, `freshness` bounds
 * the future: a claim can be believed today (tx) about last quarter (valid)
 * while the live table behind it was read five minutes ago (freshness).
 */

export class TemporalError extends Error {}

export interface ValidRangeInput {
  from?: TimeInput;
  to?: TimeInput;
}

export interface TemporalRequest {
  /** System time: answer from what the knowledge base contained at this instant. */
  asOf?: TimeInput;
  /** World time, a single instant. */
  validAt?: TimeInput;
  /** World time, an interval. Object, `[from, to]`, `"2026-01-01..2026-06-30"`, `"2026-08"`, `"2026"`. */
  validRange?: ValidRangeInput | [TimeInput, TimeInput] | string | null;
  /** Max acceptable age of live/federated reads: seconds, or `30s` / `15m` / `2h` / `7d` / `1w`. */
  freshness?: string | number | null;
}

export interface ResolvedTemporal {
  /** Transaction time, or null for "current belief". */
  txTime: string | null;
  /** World-time lower bound, inclusive; null = unbounded. */
  validFrom: string | null;
  /** World-time upper bound, inclusive; null = unbounded. */
  validTo: string | null;
  /** The world-time constraint was a single instant rather than an interval. */
  validPoint: boolean;
  /** Max age for live reads in seconds; null = the source's own default. */
  freshnessSeconds: number | null;
  /** One line per constraint in effect, echoed back so agents can see what was applied. */
  notes: string[];
}

export const NO_TEMPORAL: ResolvedTemporal = {
  txTime: null, validFrom: null, validTo: null, validPoint: false, freshnessSeconds: null, notes: [],
};

const DURATION = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)$/i;
const DURATION_UNIT: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

/** `15m` / `2h` / `90` → seconds. */
export function parseDuration(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new TemporalError(`freshness must be a non-negative duration (got ${input})`);
    return Math.round(input);
  }
  const raw = input.trim();
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw));
  const m = DURATION.exec(raw);
  if (!m) throw new TemporalError(`unparsable duration "${input}" — use seconds or 30s / 15m / 2h / 7d / 1w`);
  return Math.round(Number(m[1]) * DURATION_UNIT[m[2][0].toLowerCase()]);
}

function requireIso(t: TimeInput, label: string): string {
  const iso = toIso(t);
  if (!iso) throw new TemporalError(`${label} is not a valid ISO-8601 instant: ${JSON.stringify(t)}`);
  return iso;
}

/**
 * Calendar shorthand: `2026` → that year, `2026-08` → that month, `2026-08-10`
 * → that day. Anything else is treated as an instant (both ends the same).
 */
function calendarSpan(token: string): { from: string; to: string } | null {
  const t = token.trim();
  let m = /^(\d{4})$/.exec(t);
  if (m) return { from: `${m[1]}-01-01T00:00:00.000Z`, to: `${m[1]}-12-31T23:59:59.999Z` };
  m = /^(\d{4})-(\d{2})$/.exec(t);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month < 1 || month > 12) throw new TemporalError(`month out of range in "${token}"`);
    const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
    return { from: `${m[1]}-${m[2]}-01T00:00:00.000Z`, to: end.toISOString() };
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return { from: `${t}T00:00:00.000Z`, to: `${t}T23:59:59.999Z` };
  // quarters, halves, fiscal years and Chinese forms (2026Q2, 2026年上半年, FY2025 …)
  const span = normalizeDateExpr(t);
  if (span && span.precision !== 'instant' && span.from && span.to) return { from: span.from, to: span.to };
  return null;
}

/** Widen a bare date/month/year to the span it denotes; `open` sides stay null. */
function boundary(t: TimeInput, side: 'from' | 'to', label: string): string | null {
  if (t === null || t === undefined || t === '' || t === '*') return null;
  if (typeof t === 'string') {
    const span = calendarSpan(t);
    if (span) return side === 'from' ? span.from : span.to;
  }
  return requireIso(t, label);
}

function parseRange(input: NonNullable<TemporalRequest['validRange']>): { from: string | null; to: string | null } {
  if (Array.isArray(input)) {
    if (input.length !== 2) throw new TemporalError('valid_range tuple must be [from, to]');
    return { from: boundary(input[0], 'from', 'valid_range.from'), to: boundary(input[1], 'to', 'valid_range.to') };
  }
  if (typeof input === 'string') {
    const raw = input.trim();
    if (!raw) return { from: null, to: null };
    const sep = raw.includes('..') ? '..' : raw.slice(1).includes('/') ? '/' : null;
    if (sep) {
      const at = sep === '..' ? raw.indexOf('..') : raw.indexOf('/', 1);
      const lhs = raw.slice(0, at);
      const rhs = raw.slice(at + sep.length);
      return { from: boundary(lhs, 'from', 'valid_range.from'), to: boundary(rhs, 'to', 'valid_range.to') };
    }
    const span = calendarSpan(raw);
    if (span) return { from: span.from, to: span.to };
    const iso = requireIso(raw, 'valid_range');
    return { from: iso, to: iso };
  }
  return { from: boundary(input.from, 'from', 'valid_range.from'), to: boundary(input.to, 'to', 'valid_range.to') };
}

/** Normalize `{as_of, valid_at, valid_range, freshness}` into explicit, validated axes. */
export function resolveTemporal(req: TemporalRequest = {}): ResolvedTemporal {
  const notes: string[] = [];
  const txTime = req.asOf === null || req.asOf === undefined || req.asOf === ''
    ? null
    : requireIso(req.asOf, 'as_of');
  if (txTime) notes.push(`as_of ${txTime} — as the knowledge base stood then`);

  const hasPoint = req.validAt !== null && req.validAt !== undefined && req.validAt !== '';
  const hasRange = req.validRange !== null && req.validRange !== undefined && req.validRange !== '';
  if (hasPoint && hasRange) {
    throw new TemporalError('pass either valid_at (an instant) or valid_range (an interval), not both');
  }

  let validFrom: string | null = null;
  let validTo: string | null = null;
  let validPoint = false;
  if (hasPoint) {
    validFrom = validTo = requireIso(req.validAt, 'valid_at');
    validPoint = true;
    notes.push(`valid_at ${validFrom} — only facts asserted to hold then`);
  } else if (hasRange) {
    const r = parseRange(req.validRange!);
    validFrom = r.from;
    validTo = r.to;
    if (validFrom && validTo && validFrom > validTo) {
      throw new TemporalError(`valid_range is inverted: ${validFrom} > ${validTo}`);
    }
    if (validFrom || validTo) {
      notes.push(`valid_range ${validFrom ?? '-∞'} … ${validTo ?? '+∞'} — facts whose validity overlaps the window`);
    }
  }

  const freshnessSeconds = req.freshness === null || req.freshness === undefined || req.freshness === ''
    ? null
    : parseDuration(req.freshness);
  if (freshnessSeconds !== null) notes.push(`freshness ≤ ${freshnessSeconds}s for live reads`);

  return { txTime, validFrom, validTo, validPoint, freshnessSeconds, notes };
}

/**
 * World-time predicate for claims: the claim's validity window overlaps the
 * requested window (open ends are ±∞). A point request reduces to "the window
 * contains that instant".
 */
export function validOverlap(alias: string, p: Params, r: ResolvedTemporal): string {
  const parts: string[] = [];
  if (r.validTo) parts.push(`(${alias}.valid_from IS NULL OR ${alias}.valid_from <= ${p.add(r.validTo)}::timestamptz)`);
  if (r.validFrom) parts.push(`(${alias}.valid_to IS NULL OR ${alias}.valid_to >= ${p.add(r.validFrom)}::timestamptz)`);
  return parts.length === 0 ? 'TRUE' : `(${parts.join(' AND ')})`;
}

/** In-memory twin of `validOverlap`, for the as_of path that folds from evidence. */
export function overlapsValidWindow(claim: { valid_from: string | null; valid_to: string | null }, r: ResolvedTemporal): boolean {
  if (r.validTo && claim.valid_from && claim.valid_from > r.validTo) return false;
  if (r.validFrom && claim.valid_to && claim.valid_to < r.validFrom) return false;
  return true;
}

/* ------------------------------ scope filters ----------------------------- */

/**
 * What a retrieved row came from. `wiki` is human-authored wiki prose, `view`
 * is a generated page — they live in the same directory but only one of them
 * is a knowledge source. `trace` only ever matches when `trace.episodes` is on:
 * without it synced transcripts are never prepared into searchable episodes.
 */
export const SOURCE_KINDS = ['doc', 'wiki', 'view', 'skill', 'trace'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface ScopeFilterRequest {
  /** Restrict to these source kinds. */
  kinds?: string[] | null;
  /** Restrict to these path prefixes, e.g. `raw/docs/reports`. */
  sources?: string[] | null;
  /** `trusted` hides quarantined agent writes; `any` includes them (default). */
  trust?: string | null;
  /** Who is asking — restricted sources answer only to actors on their ACL. */
  actor?: string | null;
}

export interface ResolvedScopeFilter {
  kinds: SourceKind[] | null;
  sources: string[] | null;
  trust: 'trusted' | 'quarantined' | null;
  actor: string | null;
  notes: string[];
}

export const NO_FILTER: ResolvedScopeFilter = { kinds: null, sources: null, trust: null, actor: null, notes: [] };

export function resolveScopeFilter(req: ScopeFilterRequest = {}): ResolvedScopeFilter {
  const notes: string[] = [];
  let kinds: SourceKind[] | null = null;
  if (req.kinds && req.kinds.length > 0) {
    const seen = new Set<SourceKind>();
    for (const raw of req.kinds) {
      const k = String(raw).trim().toLowerCase();
      const norm = k === 'docs' ? 'doc' : k === 'skills' ? 'skill' : k === 'views' ? 'view' : k;
      if (!(SOURCE_KINDS as readonly string[]).includes(norm)) {
        throw new TemporalError(`unknown source kind "${raw}" — expected one of ${SOURCE_KINDS.join(', ')}`);
      }
      seen.add(norm as SourceKind);
    }
    kinds = [...seen];
    notes.push(`kinds ${kinds.join(', ')}`);
  }

  const sources = req.sources && req.sources.length > 0 ? normalizePrefixes(req.sources) ?? null : null;
  if (sources) notes.push(`sources under ${sources.join(', ')}`);

  let trust: ResolvedScopeFilter['trust'] = null;
  if (req.trust && req.trust !== 'any') {
    const t = String(req.trust).trim().toLowerCase();
    if (t !== 'trusted' && t !== 'quarantined') {
      throw new TemporalError(`unknown trust tier "${req.trust}" — expected trusted, quarantined or any`);
    }
    trust = t;
    notes.push(`trust ${t} only`);
  }

  const actor = req.actor?.trim() || null;
  if (actor) notes.push(`as actor ${actor}`);

  return { kinds, sources, trust, actor, notes };
}

export function isEmptyFilter(f: ResolvedScopeFilter): boolean {
  return !f.kinds && !f.sources && !f.trust && !f.actor;
}

/**
 * Trust and access predicates over a `scopes` alias.
 *
 * An empty ACL means unrestricted, so it has to pass for every actor — and a
 * restricted scope has to fail when no actor was given, because "who is
 * asking" being unknown is not the same as "anyone may read this".
 */
export function scopeAccessSql(alias: string, p: Params, f: ResolvedScopeFilter): string {
  const parts: string[] = [];
  if (f.trust) parts.push(`${alias}.trust = ${p.add(f.trust)}`);
  if (f.actor) {
    const actor = p.add(f.actor);
    parts.push(`(jsonb_array_length(${alias}.acl) = 0 OR ${alias}.acl ? ${actor} OR ${alias}.acl ? '*')`);
  }
  return parts.length === 0 ? 'TRUE' : `(${parts.join(' AND ')})`;
}

const KIND_SQL: Record<SourceKind, (a: string) => string> = {
  doc: (a) => `${a}.root = 'docs'`,
  wiki: (a) => `(${a}.root = 'wiki' AND ${a}.kind <> 'view')`,
  view: (a) => `${a}.kind = 'view'`,
  skill: (a) => `${a}.root = 'skills'`,
  trace: (a) => `${a}.root = 'traces'`,
};

/** Path-prefix predicate over any column holding a source path (document path or scope key). */
export function pathPrefixSql(expr: string, p: Params, prefixes: string[]): string {
  const parts = prefixes.map((prefix) => {
    const exact = p.add(prefix);
    const under = p.add(`${prefix}/%`);
    return `(${expr} = ${exact} OR ${expr} LIKE ${under})`;
  });
  return `(${parts.join(' OR ')})`;
}

/** Kind + source predicate over a `documents` alias. */
export function documentFilterSql(alias: string, p: Params, f: ResolvedScopeFilter): string {
  const parts: string[] = [];
  if (f.kinds) parts.push(`(${f.kinds.map((k) => KIND_SQL[k](alias)).join(' OR ')})`);
  if (f.sources) parts.push(pathPrefixSql(`${alias}.path`, p, f.sources));
  if (f.trust || f.actor) {
    // trust and ACL live on the scope that produced the document, so they have
    // to be reached through it rather than duplicated onto every row
    parts.push(`EXISTS (SELECT 1 FROM scopes ds WHERE ds.id = ${alias}.scope_id AND ${scopeAccessSql('ds', p, f)})`);
  }
  return parts.length === 0 ? 'TRUE' : `(${parts.join(' AND ')})`;
}

/**
 * Graph-row predicate: the row is supported by evidence from a scope that
 * passes the filter. `kind` is the evidence kind (entity / relation / claim).
 * Evidence liveness follows the same tx window as the surrounding query, so a
 * filtered `as_of` read only sees support that existed then.
 */
export function evidenceFilterSql(
  idExpr: string,
  kind: 'entity' | 'relation' | 'claim',
  p: Params,
  f: ResolvedScopeFilter,
  txTime: string | null,
): string {
  if (isEmptyFilter(f)) return 'TRUE';
  const parts: string[] = [];
  if (f.kinds) parts.push(`(${f.kinds.map((k) => KIND_SQL[k]('fd')).join(' OR ')})`);
  if (f.sources) parts.push(pathPrefixSql('fs.key', p, f.sources));
  const access = scopeAccessSql('fs', p, f);
  if (access !== 'TRUE') parts.push(access);
  const tx = txTime
    ? `fe.tx_from <= ${p.add(txTime)}::timestamptz AND (fe.tx_to IS NULL OR fe.tx_to > ${p.add(txTime)}::timestamptz)`
    : 'fe.tx_to IS NULL';
  return `EXISTS (
    SELECT 1 FROM evidence fe
      JOIN scopes fs ON fs.id = fe.scope_id
      LEFT JOIN documents fd ON fd.path = fs.key
    WHERE fe.kind = ${p.add(kind)} AND fe.target_id = ${idExpr} AND ${tx} AND ${parts.join(' AND ')})`;
}

/**
 * Subset of `ids` whose rows have supporting evidence from a scope that passes
 * the filter. Used by the `as_of` read paths, which fold from evidence in
 * memory and so cannot carry the predicate in their own SQL.
 */
export async function idsPassingFilter(
  q: Queryable,
  kind: 'entity' | 'relation' | 'claim',
  ids: string[],
  f: ResolvedScopeFilter,
  txTime: string | null,
): Promise<Set<string>> {
  if (ids.length === 0 || isEmptyFilter(f)) return new Set(ids);
  const p = new Params();
  // one array parameter: an as_of read checks every row it matched, often more than a statement can bind
  const list = p.add(ids);
  const parts: string[] = [];
  if (f.kinds) parts.push(`(${f.kinds.map((k) => KIND_SQL[k]('fd')).join(' OR ')})`);
  if (f.sources) parts.push(pathPrefixSql('fs.key', p, f.sources));
  const access = scopeAccessSql('fs', p, f);
  if (access !== 'TRUE') parts.push(access);
  const tx = txTime
    ? `fe.tx_from <= ${p.add(txTime)}::timestamptz AND (fe.tx_to IS NULL OR fe.tx_to > ${p.add(txTime)}::timestamptz)`
    : 'fe.tx_to IS NULL';
  const rows = await q.query<{ target_id: string }>(
    `SELECT DISTINCT fe.target_id FROM evidence fe
       JOIN scopes fs ON fs.id = fe.scope_id
       LEFT JOIN documents fd ON fd.path = fs.key
     WHERE fe.kind = ${p.add(kind)} AND fe.target_id = ANY(${list}::text[]) AND ${tx} AND ${parts.join(' AND ')}`,
    p.list,
  );
  return new Set(rows.map((r) => r.target_id));
}
