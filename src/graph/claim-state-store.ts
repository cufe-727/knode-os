import { breather } from '../pool.js';
import { Store } from '../store/db.js';
import { EvidenceAtRow, foldClaimEvidence, groupBy, toDateString, toIso } from '../store/temporal.js';
import { CLAIM_STATE_VERSION, sameValue, seriesObject, statementObject, subjectSpellingsOf, unifyAttributeKeys } from './claim-state.js';
import { packSubjectBatches } from './subject-batches.js';

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
 * Claims supersession reads at once: whole subjects (a series never leaves its subject). Every
 * claim with an attribute used to be read in one query, which grows with the backfill: all of
 * finance's claims once it has read them.
 */
export const SERIES_CLAIMS_PER_BATCH = 50_000;

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
 * unifyAttributeKeys), over the entities merged with it and with their
 * spellings, into claim_attribute_keys, which v_claims, supersession,
 * the duplicate audit and the entity page read. Rewritten whole each run, or
 * for `subjects` alone (a subject's keys depend on no other subject):
 * returns the mappings added or changed, and those dropped.
 */
export async function refreshAttributeKeys(store: Store, opts: { subjects?: string[] } = {}): Promise<{ mapped: number; dropped: number }> {
  const only = opts.subjects ? [opts.subjects] : [];
  // keys are unified over a merged group (its series spans the group), with the spellings of its entities
  const uses = await store.query<{ subject_id: string; root: string; attribute: string; n: number; units: string[] }>(
    `SELECT c.subject_id, COALESCE(se.canonical_id, c.subject_id) AS root, c.attribute, count(*)::int AS n, array_agg(DISTINCT COALESCE(c.unit, '')) AS units
     FROM claims c JOIN entities se ON se.id = c.subject_id
     WHERE c.tx_to IS NULL AND c.attribute IS NOT NULL${opts.subjects ? ' AND c.subject_id = ANY($1::text[])' : ''}
     GROUP BY 1, 2, 3`,
    only,
  );
  const roots = [...new Set(uses.map((u) => u.root))];
  const names = roots.length === 0 ? [] : await store.query<{ root: string; name: string; aliases: string[] | null }>(
    `SELECT COALESCE(canonical_id, id) AS root, name, aliases FROM entities
     WHERE tx_to IS NULL AND (id = ANY($1::text[]) OR canonical_id = ANY($1::text[]))`,
    [roots],
  );
  const spellings = new Map<string, string[]>();
  for (const [root, list] of groupBy(names, (r) => r.root)) spellings.set(root, list.flatMap((r) => subjectSpellingsOf(r.name, r.aliases ?? [])));
  const current = await store.query<{ subject_id: string; attribute: string; canonical: string }>(
    `SELECT subject_id, attribute, canonical FROM claim_attribute_keys${opts.subjects ? ' WHERE subject_id = ANY($1::text[])' : ''}`,
    only,
  );
  // the names groups are stored under, so that a tie keeps its name
  const storedBySubject = groupBy(current, (r) => r.subject_id);
  const desired = new Map<string, { subject: string; attribute: string; canonical: string; reason: string }>();
  for (const [root, list] of groupBy(uses, (u) => u.root)) {
    const keys = [...groupBy(list, (u) => u.attribute).entries()].map(([attribute, rows]) => ({
      attribute, count: rows.reduce((n, r) => n + r.n, 0), units: [...new Set(rows.flatMap((r) => r.units))],
    }));
    const stored = new Set([...new Set(list.map((u) => u.subject_id))].flatMap((id) => (storedBySubject.get(id) ?? []).map((r) => r.canonical)));
    const map = unifyAttributeKeys(keys, spellings.get(root) ?? [], stored);
    for (const u of list) {
      const m = map.get(u.attribute);
      if (m) desired.set(`${u.subject_id}\u0000${u.attribute}`, { subject: u.subject_id, attribute: u.attribute, ...m });
    }
  }
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
  /** The object's name and type, which say whether it is the value or who handles a state (seriesObject). */
  object_name?: string | null;
  object_type?: string | null;
  /** The statement, read for what an owner or state claim with no object is about (statementObject). */
  statement?: string;
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
    // a claim whose stated window still covers a later reading stands beside it; the first
    // reading after its window replaces it. It used to look at the next reading only and,
    // when the window covered that one, at none: a weekly reading (window to the Saturday)
    // with a recap dated inside its week ("一个月前…" read as a day of that week) stayed
    // current for ever (61 of 164 series with several current values on the 10× benchmark).
    const to = toDateString(older.valid_to);
    const after = to && to > d ? to : d;
    const next = sorted.slice(i + 1).find((r) => day(r) > after);
    if (!next) continue;
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

/** The object part of a claim's series: its object (seriesObject), else what its owner or state statement is about. */
export function seriesKeyObject(r: Pick<StateRow, 'attribute' | 'object_id' | 'object_name' | 'object_type' | 'value_text' | 'statement'>, spellings: readonly string[]): string {
  const object = seriesObject(r.attribute, { id: r.object_id, name: r.object_name, type: r.object_type }, r.value_text);
  if (object) return object;
  const about = statementObject(r.statement ?? '', r.attribute, spellings, r.value_text);
  return about ? `~${about}` : '';
}

/**
 * Supersession by attribute, in every domain: the series of a subject's
 * attribute (its canonical key, per object — seriesObject says when an
 * object is the value or who handles a state —, facts and forecasts apart) runs
 * by effective date, and only the newest is current (seriesSupersession).
 * Disputed, absent, opinion and rumour claims take no part. Returns the
 * claims whose mark changed.
 *
 * With `subjects`, only their series: a series spans the entities merged
 * into one, so the list must hold whole merged groups (`seriesSubjects`).
 */
export async function supersedeByAttribute(store: Store, opts: { claimsPerBatch?: number; subjects?: string[] } = {}): Promise<number> {
  const taking = `c.tx_to IS NULL AND c.canonical_id IS NULL AND c.attribute IS NOT NULL
       AND c.status IN ('fact', 'suspected') AND c.kind IN ('fact', 'prediction')`;
  // a series lies within one canonical subject: whole subjects, a batch at a time (SERIES_CLAIMS_PER_BATCH)
  const batches = packSubjectBatches(
    await store.query<{ subject_id: string; subject: string; n: number }>(
      `SELECT c.subject_id, COALESCE(se.canonical_id, c.subject_id) AS subject, count(*)::int AS n
       FROM claims c JOIN entities se ON se.id = c.subject_id
       WHERE ${taking}${opts.subjects ? ' AND c.subject_id = ANY($1::text[])' : ''}
       GROUP BY 1, 2`,
      opts.subjects ? [opts.subjects] : [],
    ),
    opts.claimsPerBatch ?? SERIES_CLAIMS_PER_BATCH,
  );
  const pause = breather();
  let changed = 0;
  for (const batch of batches) {
    await pause();
    const rows = await store.query<StateRow>(
      `SELECT c.id, COALESCE(se.canonical_id, c.subject_id) AS subject, COALESCE(ak.canonical, c.attribute) AS attribute,
              COALESCE(oe.canonical_id, c.object_id) AS object_id, oe.name AS object_name, oe.type AS object_type, c.statement, c.kind, c.value_num, c.value_text, c.unit,
              COALESCE(c.effective_at, c.event_at, c.valid_from, c.observed_at) AS eff, c.valid_to, c.correction, c.superseded_by, c.tx_from
       FROM claims c
       JOIN entities se ON se.id = c.subject_id
       LEFT JOIN entities oe ON oe.id = c.object_id
       LEFT JOIN claim_attribute_keys ak ON ak.subject_id = c.subject_id AND ak.attribute = c.attribute
       WHERE ${taking} AND c.subject_id = ANY($1::text[])`,
      [batch.subjectIds],
    );
    const ids: string[] = [];
    const marks: (string | null)[] = [];
    // the spellings of each subject group: what an owner or state statement with no object is about is read against them
    const names = await store.query<{ root: string; name: string; aliases: string[] | null }>(
      `SELECT COALESCE(canonical_id, id) AS root, name, aliases FROM entities WHERE COALESCE(canonical_id, id) = ANY($1::text[])`,
      [[...new Set(rows.map((r) => r.subject))]],
    );
    const spellings = new Map<string, string[]>();
    for (const n of names) (spellings.get(n.root) ?? spellings.set(n.root, []).get(n.root)!).push(n.name, ...(n.aliases ?? []));
    for (const series of groupBy(rows, (r) => `${r.subject}\u0000${r.attribute}\u0000${seriesKeyObject(r, spellings.get(r.subject) ?? [])}\u0000${r.kind}`).values()) {
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
    changed += ids.length;
  }
  return changed;
}

/**
 * The subjects of `claims`, each with every entity merged with it: the
 * subjects whose series those claims are part of.
 */
export async function seriesSubjects(store: Store, claims: string[]): Promise<string[]> {
  if (claims.length === 0) return [];
  const rows = await store.query<{ id: string }>(
    `WITH canon AS MATERIALIZED (
       SELECT DISTINCT COALESCE(se.canonical_id, c.subject_id) AS id
       FROM claims c JOIN entities se ON se.id = c.subject_id
       WHERE c.id = ANY($1::text[])
     )
     SELECT id FROM canon
     UNION
     SELECT e.id FROM entities e WHERE e.canonical_id IN (SELECT id FROM canon)`,
    [claims],
  );
  return rows.map((r) => r.id);
}

/** Keyed claims one refine re-reads keys and supersession for (refreshClaimStateStep). */
export const CLAIM_STATE_STEP_CLAIMS = 200_000;
const STEP_META = 'claim_state_pass';

/**
 * One bounded slice of what refine keeps current about claim state: the
 * attribute keys (refreshAttributeKeys) and supersession by attribute
 * (supersedeByAttribute) of the next subjects — whole merged groups, in
 * code-point order of their canonical id after the cursor in meta
 * 'claim_state_pass' — up to `budget` keyed claims. A pass over every subject
 * takes as many refines as the workspace has budgets of keyed claims (finance:
 * about six), then starts again. What an ingest pass touched is kept current
 * at once, apart from this (supersedeForClaims). Returns what the slice did
 * and whether it ended a pass.
 */
export async function refreshClaimStateStep(store: Store, opts: { budget?: number } = {}): Promise<{ subjects: number; claims: number; keys: number; superseded: number; passDone: boolean }> {
  const budget = Math.max(1, opts.budget ?? CLAIM_STATE_STEP_CLAIMS);
  const after = (await store.getMeta<{ after?: string }>(STEP_META))?.after;
  const roots = await store.query<{ root: string; n: number }>(
    `SELECT COALESCE(se.canonical_id, c.subject_id) AS root, count(*)::int AS n
     FROM claims c JOIN entities se ON se.id = c.subject_id
     WHERE c.tx_to IS NULL AND c.attribute IS NOT NULL${after ? ' AND COALESCE(se.canonical_id, c.subject_id) COLLATE "C" > $1 COLLATE "C"' : ''}
     GROUP BY 1 ORDER BY COALESCE(se.canonical_id, c.subject_id) COLLATE "C"`,
    after ? [after] : [],
  );
  const take: string[] = [];
  let claims = 0;
  for (const r of roots) {
    if (take.length > 0 && claims + r.n > budget) break;
    take.push(r.root);
    claims += r.n;
  }
  const passDone = take.length === roots.length;
  let keys = 0;
  let superseded = 0;
  if (take.length > 0) {
    const members = await store.query<{ id: string }>(
      `SELECT id FROM entities WHERE id = ANY($1::text[]) OR canonical_id = ANY($1::text[])`,
      [take],
    );
    const subjects = [...new Set([...take, ...members.map((m) => m.id)])];
    const k = await refreshAttributeKeys(store, { subjects });
    keys = k.mapped + k.dropped;
    superseded = await supersedeByAttribute(store, { subjects });
  }
  await store.setMeta(STEP_META, passDone ? {} : { after: take.at(-1) });
  return { subjects: take.length, claims, keys, superseded, passDone };
}

/** Refine's claim-state step: read what is unread, unify keys, then mark supersession. */
export async function refreshClaimState(store: Store, opts: { limit?: number } = {}): Promise<{ read: number; keys: number; superseded: number }> {
  const read = await backfillClaimState(store, opts);
  const keys = await refreshAttributeKeys(store);
  const superseded = await supersedeByAttribute(store);
  return { read, keys: keys.mapped + keys.dropped, superseded };
}
