import { keyOf } from '../graph/normalize.js';
import { Queryable } from './migrations.js';

/**
 * Bitemporal helpers. Every graph row carries a system-time window
 * (`tx_from`, `tx_to`): `tx_to IS NULL` means "currently believed". Claims
 * additionally carry a world-time window (`valid_from`, `valid_to`).
 *
 *   as_of    = system time: what did the knowledge base contain at T?
 *   valid_at = world time:  which facts were true (asserted to hold) at T?
 *
 * Current-state queries read the materialized aggregate columns; `as_of`
 * queries recompute from the evidence table (see relationsAsOf / entitiesAsOf).
 */

export type TimeInput = string | Date | null | undefined;

export interface Temporal {
  asOf?: TimeInput;
  validAt?: TimeInput;
}

/** Positional parameter accumulator for hand-built SQL. */
export class Params {
  readonly list: unknown[] = [];
  constructor(initial: unknown[] = []) {
    this.list.push(...initial);
  }
  add(value: unknown): string {
    this.list.push(value);
    return `$${this.list.length}`;
  }
}

export function toIso(t: TimeInput): string | null {
  if (t === null || t === undefined || t === '') return null;
  const d = t instanceof Date ? t : new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Date-only projection (YYYY-MM-DD) for claim validity columns shown to humans/agents. */
export function toDateString(t: TimeInput): string | null {
  const iso = toIso(t);
  return iso ? iso.slice(0, 10) : null;
}

/** System-time predicate: `a.tx_to IS NULL`, or the window containing `asOf`. */
export function live(alias: string, p: Params, asOf?: TimeInput): string {
  const iso = toIso(asOf);
  if (!iso) return `${alias}.tx_to IS NULL`;
  const ph = p.add(iso);
  return `(${alias}.tx_from <= ${ph}::timestamptz AND (${alias}.tx_to IS NULL OR ${alias}.tx_to > ${ph}::timestamptz))`;
}

/** World-time predicate for claims: the validity window contains `at` (open ends match). */
export function validAt(alias: string, p: Params, at?: TimeInput): string {
  const iso = toIso(at);
  if (!iso) return 'TRUE';
  const ph = p.add(iso);
  return `((${alias}.valid_from IS NULL OR ${alias}.valid_from <= ${ph}::timestamptz) AND (${alias}.valid_to IS NULL OR ${alias}.valid_to >= ${ph}::timestamptz))`;
}

/**
 * Liveness of a graph row at a system time. Without `asOf` this is the
 * aggregate column (`tx_to IS NULL`); with one it asks whether any evidence
 * supported the row then, because the aggregates only hold the current state.
 */
export function rowLiveAt(alias: string, kind: 'entity' | 'relation' | 'claim', p: Params, asOf?: TimeInput): string {
  const iso = toIso(asOf);
  if (!iso) return live(alias, p);
  const ph = p.add(iso);
  return `EXISTS (
    SELECT 1 FROM evidence lv
    WHERE lv.kind = ${p.add(kind)} AND lv.target_id = ${alias}.id
      AND lv.tx_from <= ${ph}::timestamptz AND (lv.tx_to IS NULL OR lv.tx_to > ${ph}::timestamptz))`;
}

export interface EvidenceAtRow {
  kind: string;
  target_id: string;
  scope_id: string;
  segment_id: string | null;
  weight: number;
  extractor: string;
  attrs: Record<string, unknown>;
  tx_from: string;
}

/**
 * Evidence rows that were live at `asOf` for the given targets. The ids go to
 * the database as one array parameter: an `as_of` read folds every row it
 * matched, often more than one statement can bind (65,535 parameters).
 */
export async function evidenceAsOf(q: Queryable, kind: string, ids: string[], asOf: string): Promise<EvidenceAtRow[]> {
  if (ids.length === 0) return [];
  return q.query<EvidenceAtRow>(
    `SELECT kind, target_id, scope_id, segment_id, weight, extractor, attrs, tx_from
     FROM evidence
     WHERE kind = $1 AND target_id = ANY($3::text[])
       AND tx_from <= $2::timestamptz AND (tx_to IS NULL OR tx_to > $2::timestamptz)`,
    [kind, asOf, ids],
  );
}

export interface EntityAsOf {
  id: string;
  name: string;
  type: string;
  description: string;
  aliases: string[];
  wiki_path: string | null;
  mention_count: number;
  evidence_count: number;
}

export const TYPE_PRECEDENCE = ['person', 'organization', 'product', 'project', 'component', 'technology', 'event', 'location', 'datasource', 'dataset', 'other', 'concept'];

/**
 * Fold entity evidence into the row shape (shared by current-state folds and
 * as_of reads). `aliasStop` names the words an alias may not be (the stop
 * lists, by normalized key): an extractor's "other spelling" that is an
 * ordinary word stays in the evidence but out of the row.
 */
export function foldEntityEvidence(
  id: string,
  rows: EvidenceAtRow[],
  mentionCount: number,
  fallback?: { name: string; type: string; description: string; aliases: string[] },
  precedence: readonly string[] = TYPE_PRECEDENCE,
  aliasStop?: ReadonlySet<string>,
): EntityAsOf | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) =>
    b.weight - a.weight
    || new Date(a.tx_from).getTime() - new Date(b.tx_from).getTime()
    || String(a.attrs.name ?? '').localeCompare(String(b.attrs.name ?? '')));
  const name = sorted.map((r) => str(r.attrs.name)).find(Boolean) ?? fallback?.name ?? id;
  const typeVotes = new Map<string, number>();
  for (const r of rows) {
    const t = str(r.attrs.type);
    if (t) typeVotes.set(t, (typeVotes.get(t) ?? 0) + 1);
  }
  let type = fallback?.type ?? 'concept';
  if (typeVotes.size > 0) {
    type = [...typeVotes.entries()].sort((a, b) => {
      const pa = precedence.indexOf(a[0]);
      const pb = precedence.indexOf(b[0]);
      return (pa === -1 ? precedence.length : pa) - (pb === -1 ? precedence.length : pb) || b[1] - a[1] || a[0].localeCompare(b[0]);
    })[0][0];
  }
  let description = '';
  for (const r of rows) {
    const d = str(r.attrs.description) ?? '';
    if (d.length > description.length || (d.length === description.length && d < description)) description = d;
  }
  const aliasSet = new Map<string, string>();
  for (const r of rows) {
    const list = Array.isArray(r.attrs.aliases) ? r.attrs.aliases : [];
    for (const a of list) {
      const s = String(a).trim();
      if (!s || aliasStop?.has(keyOf(s))) continue;
      const k = s.toLowerCase();
      if (!aliasSet.has(k)) aliasSet.set(k, s);
    }
  }
  const aliases = [...aliasSet.values()].sort((a, b) => a.localeCompare(b));
  return { id, name, type, description, aliases, wiki_path: null, mention_count: mentionCount, evidence_count: rows.length };
}

export interface RelationAsOf {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  description: string;
  weight: number;
  /** World-time window (folded like a claim's: MIN start, MAX end unless any supporter leaves it open). */
  valid_from: string | null;
  valid_to: string | null;
  evidence_count: number;
}

export function foldRelationEvidence(row: { id: string; source_id: string; target_id: string; type: string }, rows: EvidenceAtRow[]): RelationAsOf | null {
  if (rows.length === 0) return null;
  let description = '';
  let weight = 0;
  for (const r of rows) {
    weight += Number(r.weight) || 0;
    const d = str(r.attrs.description) ?? '';
    if (d.length > description.length || (d.length === description.length && d < description)) description = d;
  }
  const froms = rows.map((r) => toIso(str(r.attrs.valid_from))).filter((x): x is string => Boolean(x)).sort();
  const openEnded = rows.some((r) => !toIso(str(r.attrs.valid_to)));
  const tos = rows.map((r) => toIso(str(r.attrs.valid_to))).filter((x): x is string => Boolean(x)).sort();
  return {
    ...row,
    description,
    weight: Number(weight.toFixed(4)),
    valid_from: froms[0] ?? null,
    valid_to: openEnded ? null : tos[tos.length - 1] ?? null,
    evidence_count: rows.length,
  };
}

export interface ClaimAsOf {
  id: string;
  subject_id: string;
  object_id: string | null;
  type: string;
  statement: string;
  status: string;
  valid_from: string | null;
  valid_to: string | null;
  /** When the event happened (highest-weight supporter's statement). */
  event_at: string | null;
  /** Earliest source date among supporters. */
  observed_at: string | null;
  primary_scope_id: string | null;
  segment_id: string | null;
  evidence_count: number;
}

export function foldClaimEvidence(row: { id: string; subject_id: string; statement: string }, rows: EvidenceAtRow[]): ClaimAsOf | null {
  if (rows.length === 0) return null;
  const byWeight = [...rows].sort((a, b) => b.weight - a.weight || new Date(a.tx_from).getTime() - new Date(b.tx_from).getTime());
  const earliest = [...rows].sort((a, b) => new Date(a.tx_from).getTime() - new Date(b.tx_from).getTime() || a.scope_id.localeCompare(b.scope_id))[0];
  const statuses = rows.map((r) => str(r.attrs.status) ?? 'fact');
  // `absent` is not a weak `fact` — it is the assertion that nothing is there,
  // and it only holds while no source asserts otherwise. Folding it into
  // 'suspected' would quietly erase every recorded absence.
  const allAbsent = statuses.length > 0 && statuses.every((s) => s === 'absent');
  const status = allAbsent
    ? 'absent'
    : statuses.includes('disputed') ? 'disputed' : statuses.includes('fact') ? 'fact' : 'suspected';
  const type = byWeight.map((r) => str(r.attrs.type)).find(Boolean) ?? 'fact';
  const froms = rows.map((r) => toIso(str(r.attrs.valid_from))).filter((x): x is string => Boolean(x)).sort();
  const openEnded = rows.some((r) => !toIso(str(r.attrs.valid_to)));
  const tos = rows.map((r) => toIso(str(r.attrs.valid_to))).filter((x): x is string => Boolean(x)).sort();
  const objectId = byWeight.map((r) => str(r.attrs.object_id)).find(Boolean) ?? null;
  const eventAt = byWeight.map((r) => toIso(str(r.attrs.event_at))).find(Boolean) ?? null;
  const observed = rows.map((r) => toIso(str(r.attrs.observed_at))).filter((x): x is string => Boolean(x)).sort();
  return {
    id: row.id,
    subject_id: row.subject_id,
    object_id: objectId,
    type,
    statement: row.statement,
    status,
    valid_from: froms[0] ?? null,
    valid_to: openEnded ? null : tos[tos.length - 1] ?? null,
    event_at: eventAt,
    observed_at: observed[0] ?? null,
    primary_scope_id: earliest.scope_id,
    segment_id: earliest.segment_id,
    evidence_count: rows.length,
  };
}

/** Entities as they were at `asOf`, recomputed from evidence (mention counts are current). */
export async function entitiesAsOf(q: Queryable, ids: string[], asOf: string): Promise<EntityAsOf[]> {
  if (ids.length === 0) return [];
  const rows = await evidenceAsOf(q, 'entity', ids, asOf);
  const grouped = groupBy(rows, (r) => r.target_id);
  const current = await q.query<{ id: string; name: string; type: string; description: string; aliases: string[]; wiki_path: string | null; mention_count: number }>(
    `SELECT id, name, type, description, aliases, wiki_path, mention_count FROM entities WHERE id = ANY($1::text[])`,
    [ids],
  );
  const byId = new Map(current.map((c) => [c.id, c]));
  const out: EntityAsOf[] = [];
  for (const id of ids) {
    const cur = byId.get(id);
    const folded = foldEntityEvidence(id, grouped.get(id) ?? [], cur?.mention_count ?? 0, cur ?? undefined);
    if (folded) out.push({ ...folded, wiki_path: cur?.wiki_path ?? null });
  }
  return out;
}

/** Relations touching `entityIds` that were live at `asOf`, recomputed from evidence. */
export async function relationsAsOf(q: Queryable, entityIds: string[], asOf: string): Promise<RelationAsOf[]> {
  if (entityIds.length === 0) return [];
  // past the seeds a graph search's frontier holds every neighbour it reached: one array parameter
  const candidates = await q.query<{ id: string; source_id: string; target_id: string; type: string }>(
    `SELECT id, source_id, target_id, type FROM relations WHERE source_id = ANY($1::text[]) OR target_id = ANY($1::text[])`,
    [entityIds],
  );
  if (candidates.length === 0) return [];
  const rows = await evidenceAsOf(q, 'relation', candidates.map((c) => c.id), asOf);
  const grouped = groupBy(rows, (r) => r.target_id);
  const out: RelationAsOf[] = [];
  for (const c of candidates) {
    const folded = foldRelationEvidence(c, grouped.get(c.id) ?? []);
    if (folded) out.push(folded);
  }
  return out;
}

/** Claims about `subjectIds` that were live at `asOf`, recomputed from evidence. */
export async function claimsAsOf(q: Queryable, subjectIds: string[], asOf: string): Promise<ClaimAsOf[]> {
  if (subjectIds.length === 0) return [];
  const candidates = await q.query<{ id: string; subject_id: string; statement: string }>(
    `SELECT id, subject_id, statement FROM claims WHERE subject_id = ANY($1::text[])`,
    [subjectIds],
  );
  if (candidates.length === 0) return [];
  const rows = await evidenceAsOf(q, 'claim', candidates.map((c) => c.id), asOf);
  const grouped = groupBy(rows, (r) => r.target_id);
  const out: ClaimAsOf[] = [];
  for (const c of candidates) {
    const folded = foldClaimEvidence(c, grouped.get(c.id) ?? []);
    if (folded) out.push(folded);
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

export function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    (out.get(k) ?? out.set(k, []).get(k)!).push(r);
  }
  return out;
}
