import { Store } from './db.js';
import {
  NO_FILTER,
  NO_TEMPORAL,
  ResolvedScopeFilter,
  ResolvedTemporal,
  evidenceFilterSql,
  idsPassingFilter,
  overlapsValidWindow,
  validOverlap,
} from './resolver.js';
import {
  Params,
  evidenceAsOf,
  foldClaimEvidence,
  groupBy,
  live,
  toDateString,
  toIso,
} from './temporal.js';

/**
 * Structured claim access — the query surface behind `knode_claims`.
 *
 * Search returns prose an agent has to read and trust; this returns the
 * assertions themselves, each with its validity window, its status among
 * conflicting sources, and the scope that supports it. An agent that needs
 * "what do we hold about X, and since when" should ask here rather than
 * re-derive it from retrieved chunks.
 */

export interface ClaimQuery {
  /** Entity id, exact name, or alias — matched case-insensitively, substring as a fallback. */
  subject?: string;
  /** Same matching as `subject`, applied to the claim's object entity. */
  object?: string;
  /** Claim types (free-form; `earnings`, `guidance`, … as the extractor emitted them). */
  types?: string[];
  /** fact | suspected | disputed */
  statuses?: string[];
  /** Substring of the statement text. */
  text?: string;
  /** Only claims whose event time falls in this window (ISO instants; open sides null). */
  eventRange?: { from?: string | null; to?: string | null };
  /** Also return facts a newer fact of the same subject and type replaced (default: hidden). */
  includeSuperseded?: boolean;
  /** `timeline` orders by event time (then validity start) ascending; default is newest belief first. */
  order?: 'recent' | 'timeline';
  limit?: number;
  temporal?: ResolvedTemporal;
  filter?: ResolvedScopeFilter;
}

export interface ClaimRecord {
  id: string;
  subject: string;
  subjectId: string;
  object: string | null;
  objectId: string | null;
  type: string;
  statement: string;
  status: string;
  /** World time the assertion starts holding; null = open. */
  validFrom: string | null;
  /** World time it stops holding; null = still open. */
  validTo: string | null;
  /** The validity window closed before `now` — do not quote it as current. */
  stale: boolean;
  /** When the asserted event happened (date-only), if the source said. */
  eventAt: string | null;
  /** Date of the earliest source reporting it. */
  observedAt: string | null;
  /** A newer fact of the same subject and type replaced this one (kept for history, hidden by default). */
  supersededBy: string | null;
  superseded: boolean;
  /** Path of the scope that first supported the claim. */
  sourcePath: string | null;
  /**
   * Every source that states it — in its own words or, for a merged group, in
   * the words of a claim merged into it (docs/design/10).
   */
  sources: string[];
  evidenceCount: number;
  /** System time the knowledge base started believing this version. */
  txFrom: string | null;
}

export interface ClaimQueryResult {
  claims: ClaimRecord[];
  /** Matches before `limit` was applied. */
  matched: number;
  /** What the resolver actually applied — echoed so agents can see the envelope. */
  applied: string[];
}

const STATUSES = new Set(['fact', 'suspected', 'disputed']);

interface Row {
  id: string;
  subject_id: string;
  subject: string;
  object_id: string | null;
  object: string | null;
  type: string;
  statement: string;
  status: string;
  // the driver hands back Date objects for timestamptz; normalize before comparing
  valid_from: string | Date | null;
  valid_to: string | Date | null;
  event_at?: string | Date | null;
  observed_at?: string | Date | null;
  superseded_by?: string | null;
  source_path: string | null;
  evidence_count: number;
  tx_from: string | null;
}

/** Entity-reference predicate: id, exact name/alias, else a name substring. */
function entityRefSql(column: string, p: Params, ref: string): string {
  const match = () => {
    const exact = p.add(ref);
    const like = p.add(`%${ref}%`);
    return `(er.id = ${exact} OR lower(er.name) = lower(${exact}) OR er.aliases::text ILIKE ${like} OR er.name ILIKE ${like})`;
  };
  // an entity merged into the referenced one answers as well
  return `${column} IN (
    SELECT er.id FROM entities er WHERE ${match()}
    UNION
    SELECT em.id FROM entities em WHERE em.canonical_id IN (SELECT er.id FROM entities er WHERE ${match()}))`;
}

export async function queryClaims(store: Store, q: ClaimQuery = {}): Promise<ClaimQueryResult> {
  const t = q.temporal ?? NO_TEMPORAL;
  const f = q.filter ?? NO_FILTER;
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
  const now = new Date().toISOString();

  const p = new Params();
  const where: string[] = [];
  if (q.subject) where.push(entityRefSql('cl.subject_id', p, q.subject));
  if (q.object) where.push(entityRefSql('cl.object_id', p, q.object));
  if (q.types?.length) where.push(`cl.type IN (${q.types.map((x) => p.add(x)).join(',')})`);
  if (q.statuses?.length) {
    const valid = q.statuses.filter((s) => STATUSES.has(s.toLowerCase()));
    if (valid.length === 0) return { claims: [], matched: 0, applied: applied(t, f) };
    where.push(`cl.status IN (${valid.map((x) => p.add(x.toLowerCase())).join(',')})`);
  }
  if (q.text) where.push(`cl.statement ILIKE ${p.add(`%${q.text}%`)}`);
  if (!q.includeSuperseded) where.push('cl.superseded_by IS NULL');
  // a merged group answers once, as its representative
  where.push('cl.canonical_id IS NULL');
  if (q.eventRange?.from) where.push(`cl.event_at >= ${p.add(q.eventRange.from)}::timestamptz`);
  if (q.eventRange?.to) where.push(`cl.event_at <= ${p.add(q.eventRange.to)}::timestamptz`);

  // `as_of` reads fold from evidence, so the tx window and the scope filter are
  // applied after the candidate scan rather than inside it.
  const scan = t.txTime
    ? where
    : [...where, live('cl', p), validOverlap('cl', p, t), evidenceFilterSql('cl.id', 'claim', p, f, null)];

  const rows = await store.query<Row>(
    `SELECT cl.id, cl.subject_id, se.name AS subject, cl.object_id, oe.name AS object,
            cl.type, cl.statement, cl.status, cl.valid_from, cl.valid_to,
            cl.event_at, cl.observed_at, cl.superseded_by,
            s.key AS source_path, cl.evidence_count, cl.tx_from
     FROM claims cl
     JOIN entities se ON se.id = cl.subject_id
     LEFT JOIN entities oe ON oe.id = cl.object_id
     LEFT JOIN scopes s ON s.id = cl.primary_scope_id
     ${scan.length ? `WHERE ${scan.join(' AND ')}` : ''}
     ORDER BY ${q.order === 'timeline' ? 'COALESCE(cl.event_at, cl.valid_from) ASC NULLS LAST, cl.tx_from ASC' : 'cl.valid_from DESC NULLS LAST, cl.tx_from DESC'}`,
    p.list,
  );

  const projected = t.txTime ? await foldAsOf(store, rows, t, f) : rows;
  const page = projected.slice(0, limit);
  const sources = await sourcesOf(store, page.map((r) => r.id));
  return {
    claims: page.map((r) => project(r, now, sources.get(r.id))),
    matched: projected.length,
    applied: applied(t, f),
  };
}

/** Claim id → the paths of every live source behind it and the claims merged into it. */
export async function sourcesOf(store: Store, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const p = new Params();
  const ph = ids.map((id) => p.add(id)).join(',');
  const rows = await store.query<{ rep: string; key: string }>(
    `SELECT DISTINCT COALESCE(c.canonical_id, c.id) AS rep, s.key
     FROM claims c
     JOIN evidence e ON e.kind = 'claim' AND e.target_id = c.id AND e.tx_to IS NULL
     JOIN scopes s ON s.id = e.scope_id
     WHERE c.id IN (${ph}) OR c.canonical_id IN (${ph})
     ORDER BY s.key`,
    p.list,
  );
  for (const r of rows) (out.get(r.rep) ?? out.set(r.rep, []).get(r.rep)!).push(r.key);
  return out;
}

/** Rebuild the candidate rows from the evidence that was live at `txTime`. */
async function foldAsOf(store: Store, rows: Row[], t: ResolvedTemporal, f: ResolvedScopeFilter): Promise<Row[]> {
  if (rows.length === 0) return rows;
  const asOf = t.txTime!;
  const evidence = await evidenceAsOf(store, 'claim', rows.map((r) => r.id), asOf);
  const grouped = groupBy(evidence, (e) => e.target_id);
  const allowed = await idsPassingFilter(store, 'claim', rows.map((r) => r.id), f, asOf);

  const scopeIds = new Set<string>();
  const folded: { row: Row; scopeId: string | null }[] = [];
  for (const row of rows) {
    if (!allowed.has(row.id)) continue;
    const fold = foldClaimEvidence(row, grouped.get(row.id) ?? []);
    if (!fold || !overlapsValidWindow(fold, t)) continue;
    if (fold.primary_scope_id) scopeIds.add(fold.primary_scope_id);
    folded.push({
      row: {
        ...row,
        type: fold.type,
        status: fold.status,
        object_id: fold.object_id,
        valid_from: fold.valid_from,
        valid_to: fold.valid_to,
        event_at: fold.event_at,
        observed_at: fold.observed_at,
        evidence_count: fold.evidence_count,
        tx_from: (grouped.get(row.id) ?? []).map((e) => e.tx_from).sort()[0] ?? row.tx_from,
      },
      scopeId: fold.primary_scope_id,
    });
  }

  // the supporting scope at that time is not necessarily today's primary one
  const keys = new Map<string, string>();
  if (scopeIds.size > 0) {
    const sp = new Params();
    const ph = [...scopeIds].map((id) => sp.add(id)).join(',');
    for (const s of await store.query<{ id: string; key: string }>(`SELECT id, key FROM scopes WHERE id IN (${ph})`, sp.list)) {
      keys.set(s.id, s.key);
    }
  }
  return folded.map(({ row, scopeId }) => ({ ...row, source_path: scopeId ? keys.get(scopeId) ?? null : null }));
}

function project(r: Row, now: string, sources?: string[]): ClaimRecord {
  const validTo = toIso(r.valid_to);
  return {
    id: r.id,
    subject: r.subject,
    subjectId: r.subject_id,
    object: r.object,
    objectId: r.object_id,
    type: r.type,
    statement: r.statement,
    status: r.status,
    validFrom: toDateString(r.valid_from),
    validTo: toDateString(validTo),
    stale: Boolean(validTo && validTo < now),
    eventAt: toDateString(r.event_at ?? null),
    observedAt: toDateString(r.observed_at ?? null),
    supersededBy: r.superseded_by ?? null,
    superseded: Boolean(r.superseded_by),
    sourcePath: r.source_path,
    sources: sources ?? (r.source_path ? [r.source_path] : []),
    evidenceCount: r.evidence_count,
    txFrom: r.tx_from,
  };
}

function applied(t: ResolvedTemporal, f: ResolvedScopeFilter): string[] {
  return [...t.notes, ...f.notes];
}
