import { applyScope } from '../lineage/scope.js';
import { Store } from '../store/db.js';
import { Params, live, toIso } from '../store/temporal.js';

/**
 * Negative knowledge: "we looked there and there was nothing".
 *
 * Without it an agent re-runs the same empty query every session, pays for it
 * every time, and never accumulates the one thing the failure taught it. An
 * absence is recorded as a claim like any other — subject, statement,
 * validity window — with `status: absent`, so it is citable, expires on its
 * own, and disappears when the source that produced it is removed.
 *
 * The validity window is the important part. "No filings for this company" is
 * true of a moment, not forever; recording it without an expiry would turn one
 * empty result into a permanent blind spot.
 */

export interface AbsenceInput {
  capabilityId: string;
  /** Entity the lookup was about; the claim's subject. */
  entityId: string;
  param: string;
  value: string;
  /** How long this absence should be believed, in seconds. */
  ttlSeconds?: number;
  /** When the lookup happened (defaults to now). */
  at?: string;
  actor?: string;
}

/** A day is long enough to stop a session re-asking, short enough to re-check. */
const DEFAULT_TTL_SECONDS = 86_400;

export function absenceKey(capabilityId: string, param: string, value: string): string {
  return `${capabilityId}:${param}=${value}`;
}

/**
 * Record one empty lookup. The scope is keyed by the exact binding that came
 * back empty, so re-observing it later replaces the old record rather than
 * piling up, and disposing the datasource takes every absence it produced with
 * it — a "we checked and found nothing" about a source that no longer exists
 * is not knowledge, it is litter.
 */
export async function recordAbsence(store: Store, input: AbsenceInput): Promise<string> {
  const at = toIso(input.at) ?? new Date().toISOString();
  const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const until = new Date(new Date(at).getTime() + ttl * 1000).toISOString();
  const key = absenceKey(input.capabilityId, input.param, input.value);
  const statement = `${input.capabilityId} returned nothing for ${input.param} = ${input.value}`;

  const res = await applyScope(
    store,
    { kind: 'absence', key },
    // the sha covers the observation window, so a later check supersedes an
    // earlier one instead of accumulating alongside it
    `${at}|${until}`,
    { actor: input.actor ?? 'agent', meta: { capabilityId: input.capabilityId, param: input.param, value: input.value } },
    async (w) => {
      await w.entity({ name: input.entityId, type: 'concept' }, { extractor: 'probe.absence', weight: 0.1, id: input.entityId });
      await w.claim(input.entityId, {
        type: 'absence',
        statement,
        status: 'absent',
        validFrom: at,
        validTo: until,
        extractor: 'probe.absence',
        weight: 0.5,
      });
    },
  );
  return res.scope.id;
}

export interface AbsenceRecord {
  capabilityId: string;
  entityId: string;
  param: string;
  value: string;
  validFrom: string | null;
  validTo: string | null;
  statement: string;
}

/**
 * Absences still believed at `at`, for the given entities. The planner uses
 * this to stop proposing a call that came back empty an hour ago — and, just
 * as importantly, to start proposing it again once the window closes.
 */
export async function liveAbsences(store: Store, entityIds: string[], at?: string): Promise<AbsenceRecord[]> {
  if (entityIds.length === 0) return [];
  const now = toIso(at) ?? new Date().toISOString();
  const p = new Params();
  const ph = entityIds.map((id) => p.add(id)).join(',');
  const nowPh = p.add(now);
  const rows = await store.query<{
    subject_id: string; statement: string; valid_from: string | null; valid_to: string | null;
    key: string; meta: { capabilityId?: string; param?: string; value?: string };
  }>(
    `SELECT cl.subject_id, cl.statement, cl.valid_from, cl.valid_to, s.key, s.meta
     FROM claims cl
     JOIN scopes s ON s.id = cl.primary_scope_id
     WHERE cl.subject_id IN (${ph}) AND cl.status = 'absent' AND ${live('cl', p)}
       AND (cl.valid_to IS NULL OR cl.valid_to > ${nowPh}::timestamptz)`,
    p.list,
  );
  return rows.map((r) => ({
    capabilityId: String(r.meta?.capabilityId ?? r.key.split(':')[0]),
    entityId: r.subject_id,
    param: String(r.meta?.param ?? ''),
    value: String(r.meta?.value ?? ''),
    validFrom: toIso(r.valid_from),
    validTo: toIso(r.valid_to),
    statement: r.statement,
  }));
}

/**
 * Turn a feedback report into absences. A node that succeeded and returned
 * zero rows is the signal — an *error* is not: a source that was down tells
 * you nothing about whether the data exists, and recording it as absence
 * would suppress the retry that would have found it.
 */
export async function recordAbsencesFromFeedback(
  store: Store,
  calls: { nodeId?: string; capability?: string; ok?: boolean; rows?: number }[],
  bindings: Map<string, { entityId: string; param: string; value: string }>,
  opts: { ttlSeconds?: number; actor?: string } = {},
): Promise<AbsenceRecord[]> {
  const out: AbsenceRecord[] = [];
  for (const call of calls) {
    if (call.ok === false || call.rows !== 0 || !call.capability) continue;
    const binding = bindings.get(call.nodeId ?? '');
    if (!binding) continue;
    await recordAbsence(store, {
      capabilityId: call.capability,
      entityId: binding.entityId,
      param: binding.param,
      value: binding.value,
      ttlSeconds: opts.ttlSeconds,
      actor: opts.actor,
    });
    out.push({
      capabilityId: call.capability,
      entityId: binding.entityId,
      param: binding.param,
      value: binding.value,
      validFrom: null,
      validTo: null,
      statement: `${call.capability} returned nothing for ${binding.param} = ${binding.value}`,
    });
  }
  return out;
}
