import { breather } from '../pool.js';
import { Store } from '../store/db.js';
import { EvidenceAtRow, foldClaimEvidence, groupBy, toDateString, toIso } from '../store/temporal.js';
import { CLAIM_STATE_VERSION, sameValue, unifyAttributeKeys } from './claim-state.js';

/**
 * Claim state in the store (docs/design/29): the lazy backfill that reads
 * claims written before schema v19, the per-subject attribute keys, and
 * supersession by attribute. Refine runs all three, in that order, before the
 * duplicate-claim audit — whose pre-filter reads the attributes — and the
 * claim audit, which marks what is current.
 */

/** Claims read per refine run at most: on finance's 236k claims the backfill takes a few nights, a few seconds each. */
export const CLAIM_STATE_BACKFILL_LIMIT = 50_000;
const BATCH = 2000;

/**
 * Read the state of live claims folded before claim state existed, or by an
 * older reader (state_v): attribute, value, unit, the effective date of the
 * newest supporter and its scope, the correction mark. Only these columns are
 * written — no refold, so fold_sha and everything downstream stay as they are
 * until the claim's next fold. Returns the claims read.
 */
export async function backfillClaimState(store: Store, opts: { limit?: number } = {}): Promise<number> {
  const limit = Math.max(1, opts.limit ?? CLAIM_STATE_BACKFILL_LIMIT);
  const pending = await store.query<{ id: string; subject_id: string; statement: string; name: string }>(
    `SELECT c.id, c.subject_id, c.statement, e.name FROM claims c JOIN entities e ON e.id = c.subject_id
     WHERE c.tx_to IS NULL AND (c.state_v IS NULL OR c.state_v < $1) LIMIT $2`,
    [CLAIM_STATE_VERSION, limit],
  );
  const pause = breather();
  let read = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    await pause();
    const batch = pending.slice(i, i + BATCH);
    const ids = batch.map((c) => c.id);
    // a representative is dated by its whole group, as the fold dates it
    const members = await store.query<{ id: string; canonical_id: string }>(`SELECT id, canonical_id FROM claims WHERE canonical_id = ANY($1::text[])`, [ids]);
    const evidence = groupBy(
      await store.query<EvidenceAtRow>(
        `SELECT kind, target_id, scope_id, segment_id, weight, extractor, attrs, tx_from FROM evidence
         WHERE kind = 'claim' AND target_id = ANY($1::text[]) AND tx_to IS NULL`,
        [[...ids, ...members.map((m) => m.id)]],
      ),
      (r) => r.target_id,
    );
    const byRep = groupBy(members, (m) => m.canonical_id);
    const cols = { id: [] as string[], attribute: [] as (string | null)[], num: [] as (number | null)[], text: [] as (string | null)[], unit: [] as (string | null)[], eff: [] as (string | null)[], src: [] as (string | null)[], scope: [] as (string | null)[], corr: [] as boolean[] };
    for (const c of batch) {
      const rows = [...(evidence.get(c.id) ?? []), ...(byRep.get(c.id) ?? []).flatMap((m) => evidence.get(m.id) ?? [])];
      const f = foldClaimEvidence(c, rows, c.name);
      cols.id.push(c.id);
      cols.attribute.push(f?.attribute ?? null);
      cols.num.push(f?.value_num ?? null);
      cols.text.push(f?.value_text ?? null);
      cols.unit.push(f?.unit ?? null);
      cols.eff.push(f?.effective_at ?? null);
      cols.src.push(f?.date_source ?? null);
      cols.scope.push(f?.effective_scope_id ?? null);
      cols.corr.push(f?.correction ?? false);
    }
    await store.query(
      `UPDATE claims c SET attribute = x.attribute, value_num = x.num, value_text = x.text, unit = x.unit,
              effective_at = x.eff, date_source = x.src, effective_scope_id = x.scope, correction = x.corr, state_v = $10
       FROM unnest($1::text[], $2::text[], $3::float8[], $4::text[], $5::text[], $6::timestamptz[], $7::text[], $8::text[], $9::boolean[])
            AS x(id, attribute, num, text, unit, eff, src, scope, corr)
       WHERE c.id = x.id`,
      [cols.id, cols.attribute, cols.num, cols.text, cols.unit, cols.eff, cols.src, cols.scope, cols.corr, CLAIM_STATE_VERSION],
    );
    read += batch.length;
  }
  return read;
}

/**
 * Unify each subject's near-synonym attribute keys (claim-state.ts
 * unifyAttributeKeys) into claim_attribute_keys, which v_claims, supersession,
 * the duplicate audit and the entity page read. Rewritten whole each run:
 * returns the mappings added or changed, and those dropped.
 */
export async function refreshAttributeKeys(store: Store): Promise<{ mapped: number; dropped: number }> {
  const uses = await store.query<{ subject_id: string; attribute: string; n: number; units: string[] }>(
    `SELECT subject_id, attribute, count(*)::int AS n, array_agg(DISTINCT COALESCE(unit, '')) AS units
     FROM claims WHERE tx_to IS NULL AND attribute IS NOT NULL
     GROUP BY subject_id, attribute`,
  );
  const desired = new Map<string, { subject: string; attribute: string; canonical: string; reason: string }>();
  for (const [subject, list] of groupBy(uses, (u) => u.subject_id)) {
    if (list.length < 2) continue;
    for (const [attribute, m] of unifyAttributeKeys(list.map((u) => ({ attribute: u.attribute, count: u.n, units: u.units })))) {
      desired.set(`${subject}\u0000${attribute}`, { subject, attribute, ...m });
    }
  }
  const current = await store.query<{ subject_id: string; attribute: string; canonical: string }>(`SELECT subject_id, attribute, canonical FROM claim_attribute_keys`);
  const have = new Map(current.map((r) => [`${r.subject_id}\u0000${r.attribute}`, r.canonical]));
  const stale = current.filter((r) => !desired.has(`${r.subject_id}\u0000${r.attribute}`));
  if (stale.length > 0) {
    await store.query(
      `DELETE FROM claim_attribute_keys k USING unnest($1::text[], $2::text[]) AS x(s, a) WHERE k.subject_id = x.s AND k.attribute = x.a`,
      [stale.map((r) => r.subject_id), stale.map((r) => r.attribute)],
    );
  }
  const changed = [...desired.entries()].filter(([k, v]) => have.get(k) !== v.canonical).map(([, v]) => v);
  if (changed.length > 0) {
    await store.query(
      `INSERT INTO claim_attribute_keys (subject_id, attribute, canonical, reason, updated_at)
       SELECT s, a, c, r, now() FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS x(s, a, c, r)
       ON CONFLICT (subject_id, attribute) DO UPDATE SET canonical = EXCLUDED.canonical, reason = EXCLUDED.reason, updated_at = now()`,
      [changed.map((v) => v.subject), changed.map((v) => v.attribute), changed.map((v) => v.canonical), changed.map((v) => v.reason)],
    );
  }
  return { mapped: changed.length, dropped: stale.length };
}

export interface StateRow {
  id: string;
  subject: string;
  attribute: string;
  object_id: string | null;
  kind: string;
  value_num: number | null;
  value_text: string | null;
  unit: string | null;
  eff: string | Date | null;
  valid_to: string | Date | null;
  correction: boolean;
  superseded_by: string | null;
  tx_from: string | Date;
}

/**
 * Which claim supersedes which within one (subject, attribute, object, kind)
 * series, oldest effective date first: each claim by the claims of the next
 * later day (the first of them), unless its own stated window still covers
 * that day; claims of one day with different values supersede none of each
 * other (a disagreement stays visible). A correction supersedes the newest
 * claim up to its date whose value differs from its own — the report it
 * corrects — whatever the order says. Exported for tests.
 */
export function seriesSupersession(series: StateRow[]): Map<string, string | null> {
  const day = (r: StateRow) => toDateString(r.eff) ?? '';
  const sorted = [...series].sort((a, b) => day(a).localeCompare(day(b)) || String(toIso(a.tx_from)).localeCompare(String(toIso(b.tx_from))) || a.id.localeCompare(b.id));
  const out = new Map<string, string | null>(sorted.map((r) => [r.id, null]));
  for (let i = 0; i < sorted.length; i++) {
    const older = sorted[i];
    const d = day(older);
    if (!d) continue;
    const next = sorted.slice(i + 1).find((r) => day(r) > d);
    if (!next) continue;
    const to = toDateString(older.valid_to);
    if (to && to >= day(next)) continue;
    out.set(older.id, next.id);
  }
  for (const c of sorted.filter((r) => r.correction)) {
    const target = sorted
      .filter((r) => r.id !== c.id && !r.correction && day(r) <= day(c) && !sameValue(
        { valueNum: r.value_num, valueText: r.value_text, unit: r.unit },
        { valueNum: c.value_num, valueText: c.value_text, unit: c.unit },
      ))
      .at(-1);
    if (target) out.set(target.id, c.id);
  }
  return out;
}

/**
 * Supersession by attribute, in every domain: the series of a subject's
 * attribute (its canonical key, per object, facts and forecasts apart) runs
 * by effective date, and only the newest is current (seriesSupersession).
 * Disputed, absent, opinion and rumour claims take no part. Returns the
 * claims whose mark changed.
 */
export async function supersedeByAttribute(store: Store): Promise<number> {
  const rows = await store.query<StateRow>(
    `SELECT c.id, COALESCE(se.canonical_id, c.subject_id) AS subject, COALESCE(ak.canonical, c.attribute) AS attribute,
            COALESCE(oe.canonical_id, c.object_id) AS object_id, c.kind, c.value_num, c.value_text, c.unit,
            COALESCE(c.effective_at, c.event_at, c.valid_from, c.observed_at) AS eff, c.valid_to, c.correction, c.superseded_by, c.tx_from
     FROM claims c
     JOIN entities se ON se.id = c.subject_id
     LEFT JOIN entities oe ON oe.id = c.object_id
     LEFT JOIN claim_attribute_keys ak ON ak.subject_id = c.subject_id AND ak.attribute = c.attribute
     WHERE c.tx_to IS NULL AND c.canonical_id IS NULL AND c.attribute IS NOT NULL
       AND c.status IN ('fact', 'suspected') AND c.kind IN ('fact', 'prediction')`,
  );
  const pause = breather();
  const ids: string[] = [];
  const marks: (string | null)[] = [];
  for (const series of groupBy(rows, (r) => `${r.subject}\u0000${r.attribute}\u0000${r.object_id ?? ''}\u0000${r.kind}`).values()) {
    await pause();
    const want = seriesSupersession(series);
    for (const r of series) {
      const w = want.get(r.id) ?? null;
      if (w !== r.superseded_by) {
        ids.push(r.id);
        marks.push(w);
      }
    }
  }
  for (let i = 0; i < ids.length; i += 5000) {
    await store.query(
      `UPDATE claims c SET superseded_by = x.s FROM unnest($1::text[], $2::text[]) AS x(id, s) WHERE c.id = x.id`,
      [ids.slice(i, i + 5000), marks.slice(i, i + 5000)],
    );
  }
  return ids.length;
}

/** Refine's claim-state step: read what is unread, unify keys, then mark supersession. */
export async function refreshClaimState(store: Store, opts: { limit?: number } = {}): Promise<{ read: number; keys: number; superseded: number }> {
  const read = await backfillClaimState(store, opts);
  const keys = await refreshAttributeKeys(store);
  const superseded = await supersedeByAttribute(store);
  return { read, keys: keys.mapped + keys.dropped, superseded };
}
