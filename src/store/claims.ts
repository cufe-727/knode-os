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
  /** Path of the scope that first supported the claim. */
  sourcePath: string | null;
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
  source_path: string | null;
  evidence_count: number;
  tx_from: string | null;
}

/** Entity-reference predicate: id, exact name/alias, else a name substring. */
function entityRefSql(column: string, p: Params, ref: string): string {
  const exact = p.add(ref);
  const like = p.add(`%${ref}%`);
  return `${column} IN (
    SELECT er.id FROM entities er
    WHERE er.id = ${exact} OR lower(er.name) = lower(${exact})
       OR er.aliases::text ILIKE ${like} OR er.name ILIKE ${like})`;
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

  // `as_of` reads fold from evidence, so the tx window and the scope filter are
  // applied after the candidate scan rather than inside it.
  const scan = t.txTime
    ? where
    : [...where, live('cl', p), validOverlap('cl', p, t), evidenceFilterSql('cl.id', 'claim', p, f, null)];

  const rows = await store.query<Row>(
    `SELECT cl.id, cl.subject_id, se.name AS subject, cl.object_id, oe.name AS object,
            cl.type, cl.statement, cl.status, cl.valid_from, cl.valid_to,
            s.key AS source_path, cl.evidence_count, cl.tx_from
     FROM claims cl
     JOIN entities se ON se.id = cl.subject_id
     LEFT JOIN entities oe ON oe.id = cl.object_id
     LEFT JOIN scopes s ON s.id = cl.primary_scope_id
     ${scan.length ? `WHERE ${scan.join(' AND ')}` : ''}
     ORDER BY cl.valid_from DESC NULLS LAST, cl.tx_from DESC`,
    p.list,
  );

  const projected = t.txTime ? await foldAsOf(store, rows, t, f) : rows;
  return {
    claims: projected.slice(0, limit).map((r) => project(r, now)),
    matched: projected.length,
    applied: applied(t, f),
  };
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

function project(r: Row, now: string): ClaimRecord {
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
    sourcePath: r.source_path,
    evidenceCount: r.evidence_count,
    txFrom: r.tx_from,
  };
}

function applied(t: ResolvedTemporal, f: ResolvedScopeFilter): string[] {
  return [...t.notes, ...f.notes];
}
