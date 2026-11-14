import { isCorrectionStatement, normalizeAttribute, parseMeasure } from '../graph/claim-state.js';
import { keyOf } from '../graph/normalize.js';
import { normalizeClaimType } from '../graph/store.js';
import { documentPeriod, DocumentPeriod, DocumentPeriodScale, normalizeDateExpr, PERIOD_MAX_DAYS } from './dates.js';
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

/** The document a scope read (its `meta.documentId`, when that document exists) and that document's date now. */
export interface ScopeDocument {
  documentId: string;
  docDate: string | null;
}

/**
 * The documents behind evidence scopes: a document's scope and its tier-1
 * child name it in `meta.documentId`; other scopes (merges, research, a
 * person's edits) read no document and are left out. The date is the
 * document's `doc_date` as it is now, so a date found after the evidence was
 * written (a dateline reader, a backfill) reaches the next fold.
 */
export async function scopeDocuments(q: Queryable, scopeIds: Iterable<string>): Promise<Map<string, ScopeDocument>> {
  const ids = [...new Set(scopeIds)];
  const out = new Map<string, ScopeDocument>();
  if (ids.length === 0) return out;
  const rows = await q.query<{ id: string; document_id: string; doc_date: string | Date | null }>(
    `SELECT s.id, d.id AS document_id, d.doc_date
     FROM scopes s JOIN documents d ON d.id = s.meta->>'documentId'
     WHERE s.id = ANY($1::text[])`,
    [ids],
  );
  for (const r of rows) out.set(r.id, { documentId: r.document_id, docDate: toIso(r.doc_date) });
  return out;
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
 *
 * The type is the one most evidence rows read, among the types `precedence`
 * lists other than `concept`; the declared order only breaks a tie. `concept`
 * is the fallback tier-0 links, mind maps and mined terms write without
 * reading the entity, so it counts only when nothing typed was read, and a
 * type the ontology no longer has counts after it. Precedence first let one
 * stray reading decide: in finance (2026-10-30) 14 `organization` readings
 * outranked 1,090 `theme` ones for 人工智能, and one `product` reading 363
 * `market` ones for 创业板.
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
  // the name the heaviest reading gives, the earliest of equal weight: one pass,
  // not a sort of every row with two dates made per comparison — a hub entity
  // folds tens of thousands of rows each time a document names it
  let named: { weight: number; at: number; name: string } | null = null;
  for (const r of rows) {
    const n = str(r.attrs.name);
    if (!n) continue;
    const at = new Date(r.tx_from).getTime();
    if (!named || (named.weight - r.weight || at - named.at || n.localeCompare(named.name)) < 0) named = { weight: r.weight, at, name: n };
  }
  const name = named?.name ?? fallback?.name ?? id;
  const typeVotes = new Map<string, number>();
  for (const r of rows) {
    const t = str(r.attrs.type);
    if (t) typeVotes.set(t, (typeVotes.get(t) ?? 0) + 1);
  }
  let type = fallback?.type ?? 'concept';
  if (typeVotes.size > 0) {
    const place = (t: string) => (precedence.includes(t) ? precedence.indexOf(t) : precedence.length);
    const typed = (t: string) => (t === 'concept' ? 1 : precedence.includes(t) ? 0 : 2);
    type = [...typeVotes.entries()].sort((a, b) =>
      typed(a[0]) - typed(b[0]) || b[1] - a[1] || place(a[0]) - place(b[0]) || a[0].localeCompare(b[0]))[0][0];
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
  /** fact | opinion | prediction | rumor (highest-weight supporter's reading). */
  kind: string;
  valid_from: string | null;
  valid_to: string | null;
  /** When the event happened (highest-weight supporter's statement). */
  event_at: string | null;
  /** Earliest source date among supporters. */
  observed_at: string | null;
  primary_scope_id: string | null;
  segment_id: string | null;
  evidence_count: number;
  /**
   * The state the claim gives (docs/design/29): the attribute of its subject
   * and the value, from the extractor's reading, else the statement's
   * (src/graph/claim-state.ts). Null for a claim that is no measure.
   */
  attribute: string | null;
  value_num: number | null;
  value_text: string | null;
  unit: string | null;
  /**
   * The date the claim speaks of: of each supporter, the date it states
   * (event, else start of window), else its document's; of all supporters,
   * the newest — a value a later report repeats is dated by that report.
   */
  effective_at: string | null;
  /** `stated` or `document`: where effective_at came from. */
  date_source: string | null;
  /** The scope of the supporter effective_at came from, so the date and the source shown agree. */
  effective_scope_id: string | null;
  correction: boolean;
}

/**
 * A supporter's document date: what its evidence recorded when it was written,
 * else its document's `doc_date` now (`docs`, from scopeDocuments) — evidence
 * written while the document had no date takes one found later.
 */
function supporterObserved(r: EvidenceAtRow, docs?: ReadonlyMap<string, ScopeDocument>): string | null {
  return toIso(str(r.attrs.observed_at)) ?? docs?.get(r.scope_id)?.docDate ?? null;
}

/**
 * One supporter's own date: the date it states (its event, else the start of
 * its window — `windowFrom` when the fold worked one out, see
 * supporterPeriodWindow), else its document's (marked `document`: inferred, not stated).
 */
function supporterDate(
  r: EvidenceAtRow,
  docs?: ReadonlyMap<string, ScopeDocument>,
  windowFrom: string | null = toIso(str(r.attrs.valid_from)),
): { at: string | null; source: 'stated' | 'document' | null } {
  const stated = toIso(str(r.attrs.event_at)) ?? windowFrom;
  if (stated) return { at: stated, source: 'stated' };
  const observed = supporterObserved(r, docs);
  return observed ? { at: observed, source: 'document' } : { at: null, source: null };
}

/** MIN start, MAX end unless any supporter leaves the end open. */
function unionWindow(rows: EvidenceAtRow[]): { from: string | null; to: string | null } {
  const froms = rows.map((r) => toIso(str(r.attrs.valid_from))).filter((x): x is string => Boolean(x)).sort();
  const openEnded = rows.some((r) => !toIso(str(r.attrs.valid_to)));
  const tos = rows.map((r) => toIso(str(r.attrs.valid_to))).filter((x): x is string => Boolean(x)).sort();
  return { from: froms[0] ?? null, to: openEnded ? null : tos[tos.length - 1] ?? null };
}

/** Periods short enough that a statement naming one is read as its document's: a day, a week, a month. */
const RESOLVED_SCALES: ReadonlySet<DocumentPeriodScale> = new Set(['day', 'week', 'month']);

/**
 * One supporter's window for a statement naming its document's period: the
 * window it stated, unless it stated none or one longer than the period can
 * be — then, for a day, week or month, the period word resolved on the
 * supporter's document date ("本周" in a report dated 2025-09-05 is
 * 2025-09-01 … 09-07). A quarter or a year word is often a comparison
 * ("比去年同期") rather than the claim's own period, so only a stated window counts for it.
 * A period the statement names is a date it states, as a `startDate: 本周`
 * resolved on the document's date is (src/graph/llm-extract.ts).
 */
function supporterPeriodWindow(r: EvidenceAtRow, period: DocumentPeriod, docs?: ReadonlyMap<string, ScopeDocument>): { from: string | null; to: string | null } {
  const from = toIso(str(r.attrs.valid_from));
  const to = toIso(str(r.attrs.valid_to));
  const tooLong = Boolean(from && to && (Date.parse(to) - Date.parse(from)) / 86_400_000 > PERIOD_MAX_DAYS[period.scale]);
  if ((from || to) && !tooLong) return { from, to };
  if (!RESOLVED_SCALES.has(period.scale)) return { from, to };
  const ref = supporterObserved(r, docs);
  const span = ref ? normalizeDateExpr(period.word, ref) : null;
  return span ? { from: span.from, to: span.to } : { from, to };
}

function finiteOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * `subjectName` lets the statement be read for a measure when no supporter
 * carries one (evidence written before claim state, frontmatter claims);
 * without it only the supporters' own readings count. `docs` (scopeDocuments
 * of the supporters' scopes) dates a supporter whose evidence carries no date
 * by its document's `doc_date`; without it only the evidence's own dates count.
 */
export function foldClaimEvidence(
  row: { id: string; subject_id: string; statement: string },
  rows: EvidenceAtRow[],
  subjectName?: string | null,
  docs?: ReadonlyMap<string, ScopeDocument>,
): ClaimAsOf | null {
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
  // evidence written before the closed list carries the extractor's own label (市场表现, 盈利预测 …)
  const type = normalizeClaimType(byWeight.map((r) => str(r.attrs.type)).find(Boolean));
  const kind = byWeight.map((r) => str(r.attrs.kind)).find(Boolean) ?? 'fact';
  // each supporter's window: for a statement about its document's period (本周, 上月 …), that period
  const period = documentPeriod(row.statement);
  const own = new Map(rows.map((r) => [r, period
    ? supporterPeriodWindow(r, period, docs)
    : { from: toIso(str(r.attrs.valid_from)), to: toIso(str(r.attrs.valid_to)) }]));
  const objectId = byWeight.map((r) => str(r.attrs.object_id)).find(Boolean) ?? null;
  const eventAt = byWeight.map((r) => toIso(str(r.attrs.event_at))).find(Boolean) ?? null;
  const observed = rows.map((r) => supporterObserved(r, docs)).filter((x): x is string => Boolean(x)).sort();
  // the newest supporter by its own date (ties: the later write, then the scope id)
  const dated = rows.map((r) => ({ r, ...supporterDate(r, docs, own.get(r)!.from) }));
  const newest = dated
    .filter((d) => d.at)
    .sort((a, b) => b.at!.localeCompare(a.at!) || new Date(b.r.tx_from).getTime() - new Date(a.r.tx_from).getTime() || a.r.scope_id.localeCompare(b.r.scope_id))[0];
  // a statement about its document's period holds for the newest supporter's period: report after report
  // repeating "支付组本周在岗7人" says so of one week each, not of the months between the first and the last
  // (those weeks stay in the evidence); any other claim's window spans its supporters'
  const window = !period ? unionWindow(rows) : newest ? own.get(newest.r)! : { from: null, to: null };
  // the reading of the newest supporter that gives one, else the statement's
  const measured = [...dated]
    .filter((d) => str(d.r.attrs.attribute))
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '') || b.r.weight - a.r.weight)[0]?.r;
  let measure: { attribute: string; valueNum: number | null; valueText: string | null; unit: string | null } | null = null;
  if (measured) {
    const attribute = normalizeAttribute(measured.attrs.attribute) ?? str(measured.attrs.attribute)!;
    measure = { attribute, valueNum: finiteOrNull(measured.attrs.value_num), valueText: str(measured.attrs.value_text) ?? null, unit: str(measured.attrs.unit) ?? null };
  } else if (subjectName) {
    measure = parseMeasure(row.statement, subjectName);
  }
  const correction = rows.some((r) => r.attrs.correction === true) || isCorrectionStatement(row.statement);
  return {
    id: row.id,
    subject_id: row.subject_id,
    object_id: objectId,
    type,
    statement: row.statement,
    status,
    kind,
    valid_from: window.from,
    valid_to: window.to,
    event_at: eventAt,
    observed_at: observed[0] ?? null,
    primary_scope_id: earliest.scope_id,
    segment_id: earliest.segment_id,
    evidence_count: rows.length,
    attribute: measure?.attribute ?? null,
    value_num: measure?.valueNum ?? null,
    value_text: measure?.valueText ?? null,
    unit: measure?.unit ?? null,
    effective_at: newest?.at ?? null,
    date_source: newest?.source ?? null,
    effective_scope_id: newest?.r.scope_id ?? null,
    correction,
  };
}

/**
 * Entities as they were at `asOf`, recomputed from evidence (mention counts are
 * current). `precedence` is the workspace ontology's type order
 * (graph/ontology.ts typePrecedence), without which a type no core pack
 * declares counts only after `concept`.
 */
export async function entitiesAsOf(q: Queryable, ids: string[], asOf: string, precedence?: readonly string[]): Promise<EntityAsOf[]> {
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
    const folded = foldEntityEvidence(id, grouped.get(id) ?? [], cur?.mention_count ?? 0, cur ?? undefined, precedence);
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
  const docs = await scopeDocuments(q, rows.map((r) => r.scope_id));
  const out: ClaimAsOf[] = [];
  for (const c of candidates) {
    const folded = foldClaimEvidence(c, grouped.get(c.id) ?? [], undefined, docs);
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
