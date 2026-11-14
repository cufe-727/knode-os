import crypto from 'node:crypto';
import { foldTouched } from '../lineage/fold.js';
import { lockLedger } from '../lineage/ledger.js';
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
 * statement names a week relative to its report's, and the claims in a merge
 * group with them, and moves each piece of their live evidence onto the id
 * the writer gives it now. The identity is read off the statement and the
 * evidence's own dates (valid_from, valid_to, event_at, observed_at), which
 * evidence has held since 2026-09; evidence from before event_at was recorded
 * (2026-09-16), of a claim no window dates, cannot say whether an event made it
 * a reading: such a claim is left whole and counted (`unmoved`).
 *
 * A move runs in one transaction under the ledger lock every scope apply and
 * dispose takes, re-reads the claim and its evidence there, closes a row only
 * while it is open and copies it under the same scope, so two steps, or a
 * step and an ingest pass, never both move one row, and no copy outlives a
 * disposed scope. The new claim keeps the old one's tx_from. Each move is
 * recorded in claim_rekey_moves until what was decided about the old claim
 * has been carried over (drainCarry, run before and after every step, so a
 * step cut short resumes):
 *   - a claim that moved whole to one claim carries everything: judged pairs,
 *     merge and contradiction suggestions with their status, disputes, and its
 *     merge group;
 *   - a claim that split into weeks (or kept some evidence) carries to every
 *     week what holds for every week: a person's rejected merge or
 *     contradiction, and the judge's "unrelated" and "different_time"; a merge
 *     a person made is carried week by week where the other side split into the
 *     same weeks, and filed as a pending suggestion for each of the member's
 *     weeks it does not meet (`listed`); a merge the audit made is undone, for it
 *     to decide each week anew;
 *   - claim vectors embed "subject：statement", the same for every week: they
 *     are copied to each new claim.
 *
 * Progress is a cursor over claim ids in `meta` (META_KEY). Until it has
 * passed a claim, the duplicate-claim audit leaves that claim alone
 * (pendingRekey): a new weekly reading must never be merged into an old claim
 * that still holds its week. A database migrate() creates starts done.
 * `knode-os claim rekey` runs the steps to the end; rekeyClaims moves given
 * claims again (after a document's date changed, for instance).
 */

export const META_KEY = 'claim_identity';

export interface RekeyState {
  /** Claim ids up to here are done. */
  cursor: string | null;
  done: boolean;
  /** Claims left whole because their evidence cannot say whether they are readings. */
  unmoved?: number;
}

export interface RekeyStats {
  /** Claims looked at this step (group mates included). */
  scanned: number;
  /** Of those, claims whose evidence moved. */
  rekeyed: number;
  /** Claims the moved evidence landed on (new, or already there). */
  created: number;
  /** Claims left whole: evidence too old to say whether they are readings. */
  unmoved: number;
  /** Old claims whose decisions were carried over (whole or week by week). */
  carried: number;
  /** A person's merges of a split claim filed as suggestions, one per week the other side does not meet. */
  listed: number;
  done: boolean;
}

const WEEK_SQL = `(${WEEK_WORD_HINTS.map((w) => `lower(c.statement) LIKE '%${w}%'`).join(' OR ')})`;
/** Who decides for the audit; anyone else is a person. */
const MACHINES = new Set(['claim-dedupe', 'llm-judge', 'claim-rekey', 'rule', 'system', 'refine']);

export async function rekeyState(store: Store): Promise<RekeyState> {
  return (await store.getMeta<RekeyState>(META_KEY)) ?? { cursor: null, done: false };
}

/**
 * The claim may still change id: its statement names a relative week, the
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

/** The id the writer gives a piece of evidence of `c` now, or undefined when the evidence cannot say. */
function newIdOf(c: { subject_id: string; statement: string }, attrs: Record<string, unknown>): string | undefined {
  const input = { statement: c.statement, eventAt: str(attrs.event_at), validFrom: str(attrs.valid_from), validTo: str(attrs.valid_to), observedAt: str(attrs.observed_at) };
  // written before event and document dates were recorded, and with no window: an event the
  // stored extraction gives could make it a reading on a re-apply, so it is left as it is
  if (!input.validFrom && !('event_at' in attrs) && readingWeek({ ...input, observedAt: '2000-01-05T00:00:00.000Z' })) return undefined;
  return claimId(c.subject_id, c.statement, readingWeek(input));
}

interface Moved {
  targets: string[];
  /** Its merge-group mates before the move, which the step moves too. */
  mates: string[];
}

/** Move one claim's evidence, in one transaction under the ledger lock. */
async function moveClaim(store: Store, id: string): Promise<Moved | 'unmoved' | null> {
  const fold = foldOptions(store.dataDir);
  return store.tx(async (q) => {
    await lockLedger(q);
    const [c] = await q.query<{ id: string; subject_id: string; statement: string; tx_from: string; tx_to: string | null; canonical_id: string | null }>(
      `SELECT id, subject_id, statement, tx_from, tx_to, canonical_id FROM claims WHERE id = $1`, [id],
    );
    if (!c || c.tx_to) return null;
    const evidence = await q.query<EvidenceRow>(
      `SELECT e.id, e.scope_id, e.segment_id, e.weight, e.extractor, e.attrs, e.trust FROM evidence e
       JOIN scopes s ON s.id = e.scope_id AND s.status = 'active'
       WHERE e.kind = 'claim' AND e.target_id = $1 AND e.tx_to IS NULL`,
      [id],
    );
    const ids = evidence.map((e) => newIdOf(c, e.attrs ?? {}));
    if (ids.some((t) => t === undefined)) return 'unmoved';
    const moves = evidence.map((e, i) => ({ e, to: ids[i]! })).filter((m) => m.to !== id);
    if (moves.length === 0) return null;
    const at = new Date().toISOString();
    const targets = new Set<string>();
    for (const { e, to } of moves) {
      const closed = await q.query(`UPDATE evidence SET tx_to = $2::timestamptz WHERE id = $1 AND tx_to IS NULL RETURNING id`, [e.id, at]);
      if (closed.length === 0) continue;
      const a = e.attrs ?? {};
      await q.query(
        `INSERT INTO claims (id, subject_id, object_id, type, statement, status, kind, valid_from, valid_to, tx_from)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz) ON CONFLICT (id) DO NOTHING`,
        [to, c.subject_id, str(a.type) ?? 'other', c.statement, str(a.status) ?? 'fact', str(a.kind) ?? 'fact', str(a.valid_from), str(a.valid_to), c.tx_from],
      );
      await q.query(
        `INSERT INTO evidence (kind, target_id, scope_id, segment_id, weight, extractor, attrs, tx_from, trust)
         VALUES ('claim', $1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz, $8)`,
        [to, e.scope_id, e.segment_id, e.weight, e.extractor, JSON.stringify(a), at, e.trust],
      );
      targets.add(to);
    }
    if (targets.size === 0) return null;
    const whole = moves.length === evidence.length;
    for (const to of targets) {
      const sample = moves.find((m) => m.to === to)!.e.attrs ?? {};
      const week = readingWeek({ statement: c.statement, eventAt: str(sample.event_at), validFrom: str(sample.valid_from), validTo: str(sample.valid_to), observedAt: str(sample.observed_at) });
      await q.query(
        `INSERT INTO claim_rekey_moves (old_id, new_id, week, whole) VALUES ($1, $2, $3, $4)
         ON CONFLICT (old_id, new_id) DO UPDATE SET whole = EXCLUDED.whole, carried = false`,
        [id, to, week, whole],
      );
      await q.query(`INSERT INTO claim_embeddings (claim_id, model, embedding) SELECT $2, model, embedding FROM claim_embeddings WHERE claim_id = $1 ON CONFLICT DO NOTHING`, [id, to]);
    }
    const touched = emptyTouched();
    for (const t of [id, ...targets]) touched.claims.add(t);
    await foldTouched(q, touched, at, fold);
    // the claim is as old as the claim it came from (a fold that reopens a row dates it now)
    await q.query(`UPDATE claims SET tx_from = LEAST(tx_from, $2::timestamptz) WHERE id = ANY($1::text[])`, [[...targets], c.tx_from]);
    const mates = (await q.query<{ id: string }>(`SELECT id FROM claims WHERE canonical_id = $1 AND tx_to IS NULL`, [id])).map((r) => r.id);
    if (c.canonical_id) mates.push(c.canonical_id);
    return { targets: [...targets], mates };
  });
}

interface MoveRow { old_id: string; new_id: string; week: string | null; whole: boolean }

/** What a claim of a moved old claim is now: its successors with their weeks, and itself while it lives. */
async function successorsOf(q: Queryable, id: string): Promise<{ id: string; week: string | null }[]> {
  const moved = await q.query<{ new_id: string; week: string | null }>(`SELECT new_id, week FROM claim_rekey_moves WHERE old_id = $1`, [id]);
  const [self] = await q.query<{ tx_to: string | null }>(`SELECT tx_to FROM claims WHERE id = $1`, [id]);
  const out = moved.map((m) => ({ id: m.new_id, week: m.week }));
  if (self && !self.tx_to) out.push({ id, week: null });
  return out;
}

type SuggestionRow = { id: string; kind: string; title: string; body: string; evidence: unknown; status: string; payload: Record<string, unknown> };

/** Copy a suggestion naming `from` for `to`, status and all; the copy's id follows its pair, as the audit keys it. */
async function copySuggestion(q: Queryable, s: SuggestionRow, from: string, to: string): Promise<void> {
  const p = { ...s.payload };
  for (const k of ['claimId', 'canonicalId', 'a', 'b']) if (p[k] === from) p[k] = to;
  const conflict = p.kind === 'claim-conflict';
  const [x, y] = conflict ? [String(p.a), String(p.b)] : [String(p.claimId), String(p.canonicalId)];
  if (x === y) return;
  const pair = claimPairId(x, y);
  const id = conflict ? crypto.createHash('sha256').update(`claim-conflict|${pair}`).digest('hex').slice(0, 16) : pair;
  await q.query(
    `INSERT INTO suggestions (id, kind, title, body, evidence, status, payload) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb) ON CONFLICT (id) DO NOTHING`,
    [id, s.kind, s.title, s.body, JSON.stringify(s.evidence ?? []), s.status, JSON.stringify(p)],
  );
  await q.query(
    `INSERT INTO deps (artifact_kind, artifact_id, input_kind, input_id, required)
     SELECT artifact_kind, $2, input_kind, CASE WHEN input_kind = 'claim' AND input_id = $3 THEN $4 ELSE input_id END, required
     FROM deps WHERE artifact_kind = 'suggestion' AND artifact_id = $1 ON CONFLICT DO NOTHING`,
    [s.id, id, from, to],
  );
}

/**
 * Carry over what was decided about the old claims whose moves are not
 * carried yet: in batches, through the indexes migration 21 adds, each piece
 * idempotent, so a drain cut short does it again.
 */
export async function drainCarry(store: Store, opts: { actor?: string; batch?: number; onProgress?: (msg: string) => void } = {}): Promise<{ carried: number; listed: number }> {
  const actor = opts.actor ?? 'claim-rekey';
  const out = { carried: 0, listed: 0 };
  const failed = new Set<string>();
  for (;;) {
    const rows = await store.query<MoveRow>(
      `SELECT old_id, new_id, week, whole FROM claim_rekey_moves
       WHERE old_id IN (SELECT DISTINCT old_id FROM claim_rekey_moves WHERE NOT carried AND NOT (old_id = ANY($2::text[])) ORDER BY old_id LIMIT $1)`,
      [opts.batch ?? 500, [...failed]],
    );
    if (rows.length === 0) return out;
    const byOld = new Map<string, MoveRow[]>();
    for (const r of rows) (byOld.get(r.old_id) ?? byOld.set(r.old_id, []).get(r.old_id)!).push(r);
    const olds = [...byOld.keys()];
    const verdicts = await store.query<{ a_id: string; b_id: string; relation: string; confidence: number; reason: string; model: string | null; judged_at: string }>(
      `SELECT a_id, b_id, relation, confidence, reason, model, judged_at FROM claim_pair_verdicts WHERE a_id = ANY($1::text[]) OR b_id = ANY($1::text[])`, [olds],
    );
    const suggestions = await store.query<SuggestionRow>(
      `SELECT id, kind, title, body, evidence, status, payload FROM suggestions
       WHERE (kind = 'claim-merge' AND (payload->>'claimId' = ANY($1::text[]) OR payload->>'canonicalId' = ANY($1::text[])))
          OR (kind = 'knowledge' AND (payload->>'a' = ANY($1::text[]) OR payload->>'b' = ANY($1::text[])))`,
      [olds],
    );
    const links = await store.query<{ claim_id: string; canonical_id: string; actor: string | null; reason: string; kind: string; confidence: number | null }>(
      `SELECT claim_id, canonical_id, actor, reason, kind, confidence FROM claim_links WHERE tx_to IS NULL AND (claim_id = ANY($1::text[]) OR canonical_id = ANY($1::text[]))`, [olds],
    );
    for (const [old, moves] of byOld) {
      const one = moves.length === 1 && moves[0].whole ? moves[0].new_id : null;
      const mine = moves.map((m) => ({ id: m.new_id, week: m.week }));
      const relinks: { claimId: string; canonicalId: string; actor: string; reason: string; kind: string; confidence: number | null }[] = [];
      const unlink = new Set<string>();
      const listed: { member: string; rep: string; reason: string }[] = [];
      await store.tx(async (q) => {
        await lockLedger(q);
        // judged pairs: all of them for a claim that moved whole; for one that split, what holds for every week
        for (const v of verdicts.filter((v) => v.a_id === old || v.b_id === old)) {
          if (!one && v.relation !== 'unrelated' && v.relation !== 'different_time') continue;
          for (const t of one ? [one] : mine.map((m) => m.id)) {
            const a = v.a_id === old ? t : v.a_id;
            const b = v.b_id === old ? t : v.b_id;
            if (a === b) continue;
            await q.query(
              `INSERT INTO claim_pair_verdicts (pair_id, a_id, b_id, relation, confidence, reason, model, judged_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz) ON CONFLICT (pair_id) DO NOTHING`,
              [claimPairId(a, b), a, b, v.relation, v.confidence, v.reason, v.model, v.judged_at],
            );
          }
        }
        // suggestions: all for a whole move; a refusal goes to every week of a split one
        for (const s of suggestions.filter((s) => [s.payload.claimId, s.payload.canonicalId, s.payload.a, s.payload.b].includes(old))) {
          if (one) await copySuggestion(q, s, old, one);
          else if (s.status === 'rejected') for (const m of mine) await copySuggestion(q, s, old, m.id);
        }
        if (one) {
          await q.query(`UPDATE disputes SET claim_id = $2 WHERE claim_id = $1`, [old, one]);
          await q.query(`UPDATE disputes SET against_id = $2 WHERE against_id = $1`, [old, one]);
        }
        // the merge group, link by link from its member's side: each of the member's weeks joins the
        // representative's same week. A member that moved itself is carried when its own moves are.
        for (const l of links.filter((l) => l.claim_id === old || l.canonical_id === old)) {
          if (l.canonical_id === old && (await q.query(`SELECT 1 FROM claim_rekey_moves WHERE old_id = $1 LIMIT 1`, [l.claim_id])).length) continue;
          const person = !MACHINES.has(l.actor ?? '');
          const members = l.claim_id === old ? mine : await successorsOf(q, l.claim_id);
          const reps = l.canonical_id === old ? mine : await successorsOf(q, l.canonical_id);
          const carry = (claimId: string, canonicalId: string) => relinks.push({ claimId, canonicalId, actor: l.actor ?? actor, reason: l.reason, kind: l.kind, confidence: l.confidence });
          unlink.add(l.claim_id);
          if (members.length === 1 && reps.length === 1) {
            carry(members[0].id, reps[0].id);
            continue;
          }
          if (!person) continue; // the audit decides each week anew
          for (const m of members) {
            const match = reps.find((r) => r.week !== null && r.week === m.week);
            if (match) carry(m.id, match.id);
            else if (reps.length) {
              listed.push({ member: m.id, rep: reps[0].id, reason: `${l.actor ?? '有人'}曾将这两条断言合并（${l.claim_id} → ${l.canonical_id}）；按周拆分后 ${m.week ?? '它'} 在另一方没有同一周，请确认是否仍合并` });
            }
          }
        }
        for (const x of listed) {
          await q.query(
            `INSERT INTO suggestions (id, kind, title, body, evidence, status, payload) VALUES ($1, 'claim-merge', $2, $3, '[]'::jsonb, 'pending', $4::jsonb) ON CONFLICT (id) DO NOTHING`,
            [claimPairId(x.member, x.rep), '合并重复断言（按周拆分后待确认）', x.reason, JSON.stringify({ claimId: x.member, canonicalId: x.rep, kind: 'same_as', reason: x.reason })],
          );
        }
      });
      // links are scopes of their own: after the rows above, before the moves are marked carried,
      // and each a no-op when it is already so — a drain cut short here runs them again
      try {
        for (const id of unlink) {
          const relinked = relinks.find((r) => r.claimId === id);
          const [cur] = await store.query<{ canonical_id: string | null }>(`SELECT canonical_id FROM claims WHERE id = $1`, [id]);
          if (cur?.canonical_id && cur.canonical_id !== relinked?.canonicalId) await unmergeClaim(store, id, { actor });
        }
        for (const r of relinks) {
          const [cur] = await store.query<{ canonical_id: string | null; tx_to: string | null }>(`SELECT canonical_id, tx_to FROM claims WHERE id = $1`, [r.claimId]);
          if (!cur || cur.tx_to || cur.canonical_id === r.canonicalId) continue;
          await applyClaimMerge(store, { ...r, kind: r.kind === 'contains' ? 'contains' : 'same_as', reason: `${r.reason}（carried over from ${old}: weekly reading identity）` });
        }
      } catch (err) {
        failed.add(old);
        opts.onProgress?.(`claims: carrying the group of ${old} failed: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      await store.query(`UPDATE claim_rekey_moves SET carried = true WHERE old_id = $1`, [old]);
      out.carried++;
      out.listed += listed.length;
    }
  }
}

/** Move these claims (and their group mates) and carry what was decided about them. */
export async function rekeyClaims(store: Store, ids: string[], opts: { actor?: string; onProgress?: (msg: string) => void; carry?: boolean } = {}): Promise<Omit<RekeyStats, 'done'>> {
  const stats = { scanned: 0, rekeyed: 0, created: 0, unmoved: 0, carried: 0, listed: 0 };
  const queue = [...ids];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    stats.scanned++;
    const moved = await moveClaim(store, id);
    if (moved === 'unmoved') stats.unmoved++;
    else if (moved) {
      stats.rekeyed++;
      stats.created += moved.targets.length;
      // the other side of a merge moves in the same step, so its weeks are there when the group is carried
      for (const m of moved.mates) if (!seen.has(m)) queue.push(m);
    }
  }
  if (opts.carry !== false) {
    const drained = await drainCarry(store, opts);
    stats.carried += drained.carried;
    stats.listed += drained.listed;
  }
  return stats;
}

/** One bounded step: at most `limit` claims from the cursor on, with their group mates. */
export async function rekeyWeeklyReadings(store: Store, opts: { limit?: number; actor?: string; onProgress?: (msg: string) => void; carry?: boolean } = {}): Promise<RekeyStats> {
  const limit = Math.max(1, opts.limit ?? 2000);
  const state = await rekeyState(store);
  // a step cut short left moves whose decisions were not carried yet
  const resumed = opts.carry === false ? { carried: 0, listed: 0 } : await drainCarry(store, opts);
  const stats: RekeyStats = { scanned: 0, rekeyed: 0, created: 0, unmoved: 0, carried: resumed.carried, listed: resumed.listed, done: state.done };
  if (state.done) return stats;
  const candidates = await store.query<{ id: string }>(
    `SELECT c.id FROM claims c WHERE c.tx_to IS NULL AND ${WEEK_SQL} ${state.cursor !== null ? 'AND c.id > $2' : ''} ORDER BY c.id LIMIT $1`,
    state.cursor !== null ? [limit, state.cursor] : [limit],
  );
  const step = await rekeyClaims(store, candidates.map((c) => c.id), opts);
  for (const k of ['scanned', 'rekeyed', 'created', 'unmoved', 'carried', 'listed'] as const) stats[k] += step[k];
  const next: RekeyState = {
    cursor: candidates.length ? candidates[candidates.length - 1].id : state.cursor,
    done: candidates.length < limit,
    unmoved: (state.unmoved ?? 0) + step.unmoved,
  };
  await store.setMeta(META_KEY, next);
  stats.done = next.done;
  if (stats.rekeyed || stats.unmoved) {
    opts.onProgress?.(`claims: ${stats.rekeyed} claims moved to weekly-reading identity (${stats.created} readings${stats.unmoved ? `, ${stats.unmoved} too old to tell, left whole` : ''}${stats.listed ? `, ${stats.listed} merges listed for a person` : ''})${next.done ? '; done' : ''}`);
  }
  return stats;
}
