import crypto from 'node:crypto';
import { foldTouched } from '../lineage/fold.js';
import { lockLedger } from '../lineage/ledger.js';
import { foldOptions } from '../lineage/scope.js';
import { emptyTouched } from '../lineage/types.js';
import { Store } from '../store/db.js';
import { Queryable } from '../store/migrations.js';
import { claimPairId } from './claim-dedupe.js';
import { applyClaimMerge, unmergeClaim } from './claim-merge.js';
import { claimId, isoWeekOf, readingWeek, speaksOfAWeek, WEEK_WORD_HINTS } from './store.js';

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

interface MoveRow { old_id: string; new_id: string; week: string | null; whole: boolean; plan: CarryPlan | null }

/** The links a carry undoes and redoes, kept on the moves so a carry cut short redoes them. */
interface CarryPlan {
  unlink: string[];
  relinks: { claimId: string; canonicalId: string; actor: string; reason: string; kind: string; confidence: number | null }[];
  listed: number;
}

/**
 * What a claim is now: the claims it moved to with their weeks (`single` when
 * it moved whole to one), itself while it lives and never moved, nothing when
 * it is gone.
 */
async function currentOf(q: Queryable, id: string): Promise<{ claims: { id: string; week: string | null }[]; single: boolean }> {
  const moved = await q.query<{ new_id: string; week: string | null; whole: boolean }>(`SELECT new_id, week, whole FROM claim_rekey_moves WHERE old_id = $1`, [id]);
  const [self] = await q.query<{ tx_to: string | null }>(`SELECT tx_to FROM claims WHERE id = $1`, [id]);
  const alive = Boolean(self && !self.tx_to);
  const claims = moved.map((m) => ({ id: m.new_id, week: m.week }));
  if (alive) claims.push({ id, week: null });
  return { claims, single: claims.length === 1 && (moved.length === 0 || (moved[0].whole && !alive)) };
}

/** The ISO weeks a claim's own dates cover (its window, else its event or document date), at most 60. */
async function weeksOfClaim(q: Queryable, id: string): Promise<Set<string>> {
  const [c] = await q.query<{ valid_from: Date | string | null; valid_to: Date | string | null; event_at: Date | string | null; observed_at: Date | string | null }>(
    `SELECT valid_from, valid_to, event_at, observed_at FROM claims WHERE id = $1`, [id],
  );
  const out = new Set<string>();
  if (!c) return out;
  const t = (v: Date | string | null) => (v === null ? null : new Date(v).getTime());
  const from = t(c.valid_from) ?? t(c.event_at) ?? t(c.observed_at);
  if (from === null) return out;
  const to = c.valid_from !== null ? t(c.valid_to) ?? from : from;
  for (let d = from, n = 0; d <= to && n < 60; d += 7 * 86_400_000, n++) out.add(isoWeekOf(d));
  out.add(isoWeekOf(to));
  return out;
}

type SuggestionRow = { id: string; kind: string; title: string; body: string; evidence: unknown; status: string; payload: Record<string, unknown> };

/** Copy a suggestion with its claims renamed (`rename`), status and all; the copy's id follows its pair, as the audit keys it. */
async function copySuggestion(q: Queryable, s: SuggestionRow, rename: Map<string, string>): Promise<void> {
  const p = { ...s.payload };
  for (const k of ['claimId', 'canonicalId', 'a', 'b']) if (typeof p[k] === 'string' && rename.has(p[k] as string)) p[k] = rename.get(p[k] as string);
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
     SELECT d.artifact_kind, $2, d.input_kind, COALESCE(r.new_id, d.input_id), d.required
     FROM deps d LEFT JOIN unnest($3::text[], $4::text[]) AS r(old_id, new_id) ON d.input_kind = 'claim' AND d.input_id = r.old_id
     WHERE d.artifact_kind = 'suggestion' AND d.artifact_id = $1 ON CONFLICT DO NOTHING`,
    [s.id, id, [...rename.keys()], [...rename.values()]],
  );
}

/**
 * Carry over what was decided about the old claims whose moves are not
 * carried yet, in batches through the indexes migration 21 adds.
 *
 * A pair names two claims, and both may have moved: each side is read as
 * what it is now (currentOf). Between two claims that each became one claim,
 * everything is carried; where either split, what holds for every week (a
 * person's refusal, the judge's unrelated / different_time) is carried to
 * every pair of their claims. The rows and the plan for the links are
 * written in one transaction; the links, scopes of their own, are then undone
 * and redone from the plan, each step a no-op once done, and only then are
 * the moves marked carried — a carry cut short anywhere redoes what is left.
 */
export async function drainCarry(
  store: Store,
  opts: { actor?: string; batch?: number; onProgress?: (msg: string) => void; /** For tests: stop between undoing and redoing links. */ interruptAfterUnlink?: boolean } = {},
): Promise<{ carried: number; listed: number }> {
  const actor = opts.actor ?? 'claim-rekey';
  const out = { carried: 0, listed: 0 };
  const failed = new Set<string>();
  for (;;) {
    const rows = await store.query<MoveRow>(
      `SELECT old_id, new_id, week, whole, plan FROM claim_rekey_moves
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
      let plan = moves.find((m) => m.plan)?.plan ?? null;
      if (!plan) {
        plan = await store.tx(async (q) => {
          await lockLedger(q);
          const mine = await currentOf(q, old);
          const refusal = (relation: string) => relation === 'unrelated' || relation === 'different_time';
          // judged pairs, both sides as they are now
          for (const v of verdicts.filter((v) => v.a_id === old || v.b_id === old)) {
            const other = await currentOf(q, v.a_id === old ? v.b_id : v.a_id);
            if (!(mine.single && other.single) && !refusal(v.relation)) continue;
            for (const a of mine.claims) for (const b of other.claims) {
              if (a.id === b.id) continue;
              const [x, y] = v.a_id === old ? [a.id, b.id] : [b.id, a.id];
              await q.query(
                `INSERT INTO claim_pair_verdicts (pair_id, a_id, b_id, relation, confidence, reason, model, judged_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz) ON CONFLICT (pair_id) DO NOTHING`,
                [claimPairId(x, y), x, y, v.relation, v.confidence, v.reason, v.model, v.judged_at],
              );
            }
          }
          // suggestions: everything between two single claims; a refusal to every pair of their claims
          for (const s of suggestions.filter((s) => [s.payload.claimId, s.payload.canonicalId, s.payload.a, s.payload.b].includes(old))) {
            const otherId = [s.payload.claimId, s.payload.canonicalId, s.payload.a, s.payload.b].find((x) => typeof x === 'string' && x !== old) as string | undefined;
            if (!otherId) continue;
            const other = await currentOf(q, otherId);
            if (!(mine.single && other.single) && s.status !== 'rejected') continue;
            for (const a of mine.claims) for (const b of other.claims) await copySuggestion(q, s, new Map([[old, a.id], [otherId, b.id]]));
          }
          if (mine.single) {
            await q.query(`UPDATE disputes SET claim_id = $2 WHERE claim_id = $1`, [old, mine.claims[0].id]);
            await q.query(`UPDATE disputes SET against_id = $2 WHERE against_id = $1`, [old, mine.claims[0].id]);
          }
          // the merge group, link by link from its member's side
          const p: CarryPlan = { unlink: [], relinks: [], listed: 0 };
          const lists: { member: string; rep: string; link: (typeof links)[number] }[] = [];
          for (const l of links.filter((l) => l.claim_id === old || l.canonical_id === old)) {
            // a member that moved itself is carried when its own moves are
            if (l.canonical_id === old && (await q.query(`SELECT 1 FROM claim_rekey_moves WHERE old_id = $1 LIMIT 1`, [l.claim_id])).length) continue;
            const person = !MACHINES.has(l.actor ?? '');
            const members = l.claim_id === old ? mine : await currentOf(q, l.claim_id);
            const reps = l.canonical_id === old ? mine : await currentOf(q, l.canonical_id);
            const carry = (claimId: string, canonicalId: string) => p.relinks.push({ claimId, canonicalId, actor: l.actor ?? actor, reason: l.reason, kind: l.kind, confidence: l.confidence });
            p.unlink.push(l.claim_id);
            if (members.single && reps.single) {
              carry(members.claims[0].id, reps.claims[0].id);
              continue;
            }
            // a merge the audit made is the audit's to make again, week by week
            if (!person) continue;
            // a person's merge stays where the two meet: week by week where both are weeks, else on the
            // week the other claim's own dates fall in; every other week of the member is listed, once
            const memberWeeks = members.claims.length === 1 && members.claims[0].week === null ? await weeksOfClaim(q, members.claims[0].id) : null;
            for (const m of members.claims) {
              let match = reps.claims.find((r) => r.week !== null && r.week === m.week);
              if (!match && m.week !== null && reps.claims.length === 1 && reps.claims[0].week === null && (await weeksOfClaim(q, reps.claims[0].id)).has(m.week)) match = reps.claims[0];
              if (!match && memberWeeks) {
                const inMine = reps.claims.filter((r) => r.week !== null && memberWeeks.has(r.week));
                if (inMine.length === 1) match = inMine[0];
              }
              if (match) carry(m.id, match.id);
              else for (const r of members.claims.length === 1 ? reps.claims : [reps.claims.find((r) => r.week === null) ?? reps.claims[0]]) if (r) lists.push({ member: m.id, rep: r.id, link: l });
            }
          }
          for (const x of lists) {
            const reason = `${x.link.actor ?? '有人'}曾接受将这两条断言合并（${x.link.claim_id} → ${x.link.canonical_id}）；按周拆分后这一周与另一方的日期不相交，请确认是否仍合并`;
            await q.query(
              `INSERT INTO suggestions (id, kind, title, body, evidence, status, payload) VALUES ($1, 'claim-merge', $2, $3, '[]'::jsonb, 'pending', $4::jsonb) ON CONFLICT (id) DO NOTHING`,
              [claimPairId(x.member, x.rep), '合并重复断言（来自已接受的合并，按周拆分后待确认）', reason,
                JSON.stringify({ claimId: x.member, canonicalId: x.rep, kind: 'same_as', reason, carriedFrom: { claimId: x.link.claim_id, canonicalId: x.link.canonical_id, actor: x.link.actor, accepted: true } })],
            );
          }
          p.listed = lists.length;
          if (lists.length) opts.onProgress?.(`claims: ${lists.length} week(s) of an accepted merge (${old}) meet no week of the other claim: listed as suggestions ${lists.map((x) => `${x.member} → ${x.rep}`).join(', ')}`);
          await q.query(`UPDATE claim_rekey_moves SET plan = $2::jsonb WHERE old_id = $1`, [old, JSON.stringify(p)]);
          return p;
        });
      }
      // the links, from the plan: each a no-op once done
      try {
        for (const id of new Set(plan.unlink)) {
          const relinked = plan.relinks.find((r) => r.claimId === id);
          const [cur] = await store.query<{ canonical_id: string | null }>(`SELECT canonical_id FROM claims WHERE id = $1`, [id]);
          if (cur?.canonical_id && cur.canonical_id !== relinked?.canonicalId) await unmergeClaim(store, id, { actor });
        }
        if (opts.interruptAfterUnlink) throw new Error('interrupted after unlink (test)');
        for (const r of plan.relinks) {
          const [cur] = await store.query<{ canonical_id: string | null; tx_to: string | null }>(`SELECT canonical_id, tx_to FROM claims WHERE id = $1`, [r.claimId]);
          if (!cur || cur.tx_to || cur.canonical_id === r.canonicalId) continue;
          await applyClaimMerge(store, { ...r, kind: r.kind === 'contains' ? 'contains' : 'same_as', reason: `${r.reason}（carried over from ${old}: weekly reading identity）` });
        }
      } catch (err) {
        if (opts.interruptAfterUnlink) throw err;
        failed.add(old);
        opts.onProgress?.(`claims: carrying the group of ${old} failed: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      await store.query(`UPDATE claim_rekey_moves SET carried = true WHERE old_id = $1`, [old]);
      out.carried++;
      out.listed += plan.listed;
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
    // a later move (a document re-dated) after the migration ended leaves nothing behind either
    if ((await rekeyState(store)).done) await store.query(`DELETE FROM claim_rekey_moves WHERE carried`);
  }
  return stats;
}

/** One bounded step: at most `limit` claims from the cursor on, with their group mates. */
export async function rekeyWeeklyReadings(store: Store, opts: { limit?: number; actor?: string; onProgress?: (msg: string) => void; carry?: boolean } = {}): Promise<RekeyStats> {
  const limit = Math.max(1, opts.limit ?? 2000);
  const read = await store.getMeta<RekeyState>(META_KEY);
  const state = read ?? { cursor: null, done: false };
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
  // written only over the state this step read: a reset (or another step) since then stands
  const written = await store.tx(async (q) => {
    await lockLedger(q);
    const [cur] = await q.query<{ value: unknown }>(`SELECT value FROM meta WHERE key = $1`, [META_KEY]);
    if (JSON.stringify(cur?.value ?? null) !== JSON.stringify(read ?? null)) return false;
    await q.query(`INSERT INTO meta (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [META_KEY, JSON.stringify(next)]);
    // once done, the moves whose decisions were carried have served
    if (next.done) await q.query(`DELETE FROM claim_rekey_moves WHERE carried`);
    return true;
  });
  stats.done = written ? next.done : (await rekeyState(store)).done;
  if (stats.rekeyed || stats.unmoved) {
    opts.onProgress?.(`claims: ${stats.rekeyed} claims moved to weekly-reading identity (${stats.created} readings${stats.unmoved ? `, ${stats.unmoved} too old to tell, left whole` : ''}${stats.listed ? `, ${stats.listed} merges listed for a person` : ''})${next.done ? '; done' : ''}`);
  }
  return stats;
}
