import crypto from 'node:crypto';
import { foldTouched } from '../lineage/fold.js';
import { foldOptions } from '../lineage/scope.js';
import { emptyTouched } from '../lineage/types.js';
import { Store } from '../store/db.js';
import { Queryable } from '../store/migrations.js';
import { claimPairId } from './claim-dedupe.js';
import { applyClaimMerge, unmergeClaim } from './claim-merge.js';
import { claimId, readingWeek, speaksOfAWeek, WEEK_WORD_HINTS } from './store.js';

/**
 * The move of a workspace's claims to weekly-reading identity (claimId's
 * `at`, readingWeek in src/graph/store.ts), in bounded steps.
 *
 * Claims written before it hold every week a statement was repeated in: one
 * claim, MIN..MAX of the weeks. A step takes the next claims by id whose
 * statement speaks of a week relative to its report's and moves each piece of their live evidence
 * onto the id the writer gives it now — the old evidence row is closed and an
 * equal one opened under the same scope, so history keeps both — and refolds
 * old and new. Nothing is read again from a sidecar and no model is called.
 *
 * Where a claim's evidence all goes to one new claim, what was decided about
 * the old one goes with it: its judged pairs (claim_pair_verdicts), its
 * merge and contradiction suggestions with their status (a person's accept or
 * reject included), its disputes and its place in a merge group. Where it
 * splits into several weeks, a decision about the whole is no decision about
 * one week: the group links are undone, so the audit decides each week anew,
 * and decided suggestions stay on the old id (counted in `leftDecisions`).
 * Claim vectors embed "subject：statement", the same for every week: they are
 * copied to each new claim, so no embedding is paid twice.
 *
 * Progress is a cursor over claim ids in `meta` (META_KEY). Until it has
 * passed a claim, the duplicate-claim audit leaves that claim alone
 * (pendingRekey): a new weekly reading must never be merged into an old claim
 * that still holds its week. A step is bounded by `limit` claims, so a large
 * workspace moves over many audits; `knode-os claim rekey` runs it to the end.
 */

export const META_KEY = 'claim_identity';

export interface RekeyState {
  /** Claim ids up to here are done. */
  cursor: string | null;
  done: boolean;
}

export interface RekeyStats {
  /** Claims looked at this step. */
  scanned: number;
  /** Of those, claims whose evidence moved. */
  rekeyed: number;
  /** Claims the moved evidence landed on (new, or already there). */
  created: number;
  /** Rekeyed claims that went to one new claim, with what was decided about them. */
  carried: number;
  /** Accepted or rejected suggestions about a claim that split into several weeks: left on the old id. */
  leftDecisions: number;
  done: boolean;
}

const RELATIVE_WEEK_SQL = `(${WEEK_WORD_HINTS.map((w) => `lower(c.statement) LIKE '%${w}%'`).join(' OR ')})`;

export async function rekeyState(store: Store): Promise<RekeyState> {
  return (await store.getMeta<RekeyState>(META_KEY)) ?? { cursor: null, done: false };
}

/**
 * The claim may still change id: its statement speaks of a week relative to its report's, the
 * cursor has not passed it and it is not a weekly reading already. The
 * duplicate-claim audit leaves such a claim alone.
 */
export function pendingRekey(state: RekeyState, c: { id: string; statement: string }, keyed: boolean): boolean {
  if (state.done || keyed) return false;
  if (state.cursor !== null && c.id <= state.cursor) return false;
  return speaksOfAWeek(c.statement);
}

interface EvidenceRow {
  id: number | string;
  scope_id: string;
  segment_id: string | null;
  weight: number;
  extractor: string;
  attrs: Record<string, unknown>;
  trust: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The id the writer gives a piece of evidence of `c` now. */
function newIdOf(c: { subject_id: string; statement: string }, attrs: Record<string, unknown>): string {
  const week = readingWeek({
    statement: c.statement,
    eventAt: str(attrs.event_at),
    validFrom: str(attrs.valid_from),
    validTo: str(attrs.valid_to),
    observedAt: str(attrs.observed_at),
  });
  return claimId(c.subject_id, c.statement, week);
}

/** Carry the table rows that name `from` over to `to`, inside the step's transaction. */
async function carry(q: Queryable, from: string, to: string): Promise<void> {
  for (const v of await q.query<{ a_id: string; b_id: string; relation: string; confidence: number; reason: string; model: string | null; judged_at: string }>(
    `SELECT a_id, b_id, relation, confidence, reason, model, judged_at FROM claim_pair_verdicts WHERE a_id = $1 OR b_id = $1`, [from],
  )) {
    const a = v.a_id === from ? to : v.a_id;
    const b = v.b_id === from ? to : v.b_id;
    if (a === b) continue;
    await q.query(
      `INSERT INTO claim_pair_verdicts (pair_id, a_id, b_id, relation, confidence, reason, model, judged_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz) ON CONFLICT (pair_id) DO NOTHING`,
      [claimPairId(a, b), a, b, v.relation, v.confidence, v.reason, v.model, v.judged_at],
    );
  }
  // a merge suggestion is keyed by its pair, a contradiction by its pair too: same status, new ids
  for (const s of await q.query<{ id: string; kind: string; title: string; body: string; evidence: unknown; status: string; payload: Record<string, unknown> }>(
    `SELECT id, kind, title, body, evidence, status, payload FROM suggestions
     WHERE payload->>'claimId' = $1 OR payload->>'canonicalId' = $1 OR (payload->>'kind' = 'claim-conflict' AND (payload->>'a' = $1 OR payload->>'b' = $1))`,
    [from],
  )) {
    const p = { ...s.payload };
    for (const k of ['claimId', 'canonicalId', 'a', 'b']) if (p[k] === from) p[k] = to;
    const conflict = p.kind === 'claim-conflict';
    const [x, y] = conflict ? [String(p.a), String(p.b)] : [String(p.claimId), String(p.canonicalId)];
    if (x === y) continue;
    const pair = claimPairId(x, y);
    const id = conflict ? crypto.createHash('sha256').update(`claim-conflict|${pair}`).digest('hex').slice(0, 16) : pair;
    await q.query(
      `INSERT INTO suggestions (id, kind, title, body, evidence, status, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb) ON CONFLICT (id) DO NOTHING`,
      [id, s.kind, s.title, s.body, JSON.stringify(s.evidence ?? []), s.status, JSON.stringify(p)],
    );
    await q.query(
      `INSERT INTO deps (artifact_kind, artifact_id, input_kind, input_id, required)
       SELECT artifact_kind, $2, input_kind, CASE WHEN input_kind = 'claim' AND input_id = $3 THEN $4 ELSE input_id END, required
       FROM deps WHERE artifact_kind = 'suggestion' AND artifact_id = $1 ON CONFLICT DO NOTHING`,
      [s.id, id, from, to],
    );
  }
  await q.query(`UPDATE disputes SET claim_id = $2 WHERE claim_id = $1`, [from, to]);
  await q.query(`UPDATE disputes SET against_id = $2 WHERE against_id = $1`, [from, to]);
}

/**
 * The live claim `id` is now: itself, or — when a step moved it whole — the
 * one claim its evidence went to (the open copies of its closed rows); null
 * when it split or is gone.
 */
async function successorOf(store: Store, id: string): Promise<string | null> {
  const [self] = await store.query<{ tx_to: string | null }>(`SELECT tx_to FROM claims WHERE id = $1`, [id]);
  if (self && !self.tx_to) return id;
  const next = await store.query<{ id: string }>(
    `SELECT DISTINCT n.target_id AS id FROM evidence o
     JOIN evidence n ON n.kind = 'claim' AND n.scope_id = o.scope_id AND n.attrs = o.attrs AND n.tx_to IS NULL AND n.target_id <> o.target_id
     JOIN claims c ON c.id = n.target_id AND c.tx_to IS NULL
     WHERE o.kind = 'claim' AND o.target_id = $1 AND o.tx_to IS NOT NULL`,
    [id],
  );
  return next.length === 1 ? next[0].id : null;
}

/** One bounded step: at most `limit` claims, from the cursor on. */
export async function rekeyWeeklyReadings(store: Store, opts: { limit?: number; actor?: string; onProgress?: (msg: string) => void } = {}): Promise<RekeyStats> {
  const limit = Math.max(1, opts.limit ?? 2000);
  const actor = opts.actor ?? 'claim-rekey';
  const state = await rekeyState(store);
  const stats: RekeyStats = { scanned: 0, rekeyed: 0, created: 0, carried: 0, leftDecisions: 0, done: state.done };
  if (state.done) return stats;
  const candidates = await store.query<{ id: string; subject_id: string; statement: string }>(
    `SELECT c.id, c.subject_id, c.statement FROM claims c
     WHERE c.tx_to IS NULL AND ${RELATIVE_WEEK_SQL} ${state.cursor !== null ? 'AND c.id > $2' : ''}
     ORDER BY c.id LIMIT $1`,
    state.cursor !== null ? [limit, state.cursor] : [limit],
  );
  stats.scanned = candidates.length;
  const fold = foldOptions(store.dataDir);
  for (const row of candidates) {
    // read now: a claim moved earlier in this step may have moved this one's group
    const [now] = await store.query<{ canonical_id: string | null; tx_to: string | null }>(`SELECT canonical_id, tx_to FROM claims WHERE id = $1`, [row.id]);
    if (!now || now.tx_to) continue;
    const linked = now.canonical_id !== null;
    const c = { ...row, canonical_id: now.canonical_id ? await successorOf(store, now.canonical_id) : null };
    const evidence = await store.query<EvidenceRow>(
      `SELECT id, scope_id, segment_id, weight, extractor, attrs, trust FROM evidence WHERE kind = 'claim' AND target_id = $1 AND tx_to IS NULL`,
      [c.id],
    );
    const moves = evidence.map((e) => ({ e, to: newIdOf(c, e.attrs ?? {}) })).filter((m) => m.to !== c.id);
    if (moves.length === 0) continue;
    const targets = [...new Set(moves.map((m) => m.to))];
    const emptied = moves.length === evidence.length;
    const oneToOne = emptied && targets.length === 1;
    const members = (await store.query<{ id: string }>(`SELECT id FROM claims WHERE canonical_id = $1 AND tx_to IS NULL`, [c.id])).map((r) => r.id);
    await store.tx(async (q) => {
      const at = new Date().toISOString();
      for (const { e, to } of moves) {
        const a = e.attrs ?? {};
        await q.query(
          `INSERT INTO claims (id, subject_id, object_id, type, statement, status, kind, valid_from, valid_to, tx_from)
           VALUES ($1, $2, NULL, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz) ON CONFLICT (id) DO NOTHING`,
          [to, c.subject_id, str(a.type) ?? 'other', c.statement, str(a.status) ?? 'fact', str(a.kind) ?? 'fact', str(a.valid_from), str(a.valid_to), at],
        );
        await q.query(`UPDATE evidence SET tx_to = $2::timestamptz WHERE id = $1`, [e.id, at]);
        await q.query(
          `INSERT INTO evidence (kind, target_id, scope_id, segment_id, weight, extractor, attrs, tx_from, trust)
           VALUES ('claim', $1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz, $8)`,
          [to, e.scope_id, e.segment_id, e.weight, e.extractor, JSON.stringify(a), at, e.trust],
        );
      }
      for (const to of targets) {
        await q.query(
          `INSERT INTO claim_embeddings (claim_id, model, embedding) SELECT $2, model, embedding FROM claim_embeddings WHERE claim_id = $1 ON CONFLICT DO NOTHING`,
          [c.id, to],
        );
      }
      if (oneToOne) await carry(q, c.id, targets[0]);
      else if (emptied) {
        const [{ n }] = await q.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM suggestions WHERE status IN ('accepted', 'rejected')
             AND (payload->>'claimId' = $1 OR payload->>'canonicalId' = $1 OR payload->>'a' = $1 OR payload->>'b' = $1)`,
          [c.id],
        );
        stats.leftDecisions += n;
      }
      const touched = emptyTouched();
      for (const id of [c.id, ...targets]) touched.claims.add(id);
      await foldTouched(q, touched, at, fold);
    });
    stats.rekeyed++;
    stats.created += targets.length;
    // the merge group, after the transaction: links are scopes of their own
    if (emptied) {
      try {
        for (const m of members) await unmergeClaim(store, m, { actor });
        if (linked) await unmergeClaim(store, c.id, { actor });
        if (oneToOne) {
          const to = targets[0];
          if (c.canonical_id && c.canonical_id !== to) await applyClaimMerge(store, { claimId: to, canonicalId: c.canonical_id, reason: `carried over from ${c.id} (weekly reading identity)`, actor });
          for (const m of members) if (m !== to) await applyClaimMerge(store, { claimId: m, canonicalId: to, reason: `carried over from ${c.id} (weekly reading identity)`, actor });
          stats.carried++;
        }
      } catch (err) {
        opts.onProgress?.(`claims: carrying the group of ${c.id} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  const next: RekeyState = { cursor: candidates.length ? candidates[candidates.length - 1].id : state.cursor, done: candidates.length < limit };
  await store.setMeta(META_KEY, next);
  stats.done = next.done;
  if (stats.rekeyed) opts.onProgress?.(`claims: ${stats.rekeyed} claims moved to weekly-reading identity (${stats.created} readings${stats.leftDecisions ? `, ${stats.leftDecisions} decisions left on split claims` : ''})${next.done ? '; done' : ''}`);
  return stats;
}
