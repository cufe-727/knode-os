import crypto from 'node:crypto';
import { Store } from '../store/db.js';
import { toIso } from '../store/temporal.js';
import { ResearchKind } from './templates.js';

/**
 * The research job queue: one row per page an external agent is asked to
 * write. Persisted in the index (research_jobs) so a queued job survives a
 * restart of `serve`; the run directory under `.runs/<id>/` keeps the brief,
 * transcript and result so a failed run can be inspected or re-run by hand.
 */

export type ResearchStatus = 'queued' | 'running' | 'validating' | 'done' | 'failed' | 'cancelled';

export interface ResearchJob {
  id: string;
  kind: ResearchKind;
  target: string | null;
  query: string | null;
  template: string;
  status: ResearchStatus;
  agent: string | null;
  model: string | null;
  worksetId: string | null;
  outputPath: string | null;
  error: string | null;
  attempts: number;
  turns: number | null;
  costUsd: number | null;
  payload: Record<string, unknown>;
  requestedBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface Row {
  id: string; kind: string; target: string | null; query: string | null; template: string; status: string;
  agent: string | null; model: string | null; workset_id: string | null; output_path: string | null; error: string | null;
  attempts: number; turns: number | null; cost_usd: number | null; payload: Record<string, unknown> | null; requested_by: string | null;
  created_at: string | Date; started_at: string | Date | null; finished_at: string | Date | null;
}

function project(r: Row): ResearchJob {
  return {
    id: r.id,
    kind: r.kind as ResearchKind,
    target: r.target,
    query: r.query,
    template: r.template,
    status: r.status as ResearchStatus,
    agent: r.agent,
    model: r.model,
    worksetId: r.workset_id,
    outputPath: r.output_path,
    error: r.error,
    attempts: r.attempts,
    turns: r.turns,
    costUsd: r.cost_usd,
    payload: r.payload ?? {},
    requestedBy: r.requested_by,
    createdAt: toIso(r.created_at)!,
    startedAt: toIso(r.started_at),
    finishedAt: toIso(r.finished_at),
  };
}

const COLS = 'id, kind, target, query, template, status, agent, model, workset_id, output_path, error, attempts, turns, cost_usd, payload, requested_by, created_at, started_at, finished_at';

export interface QueueJobInput {
  kind: ResearchKind;
  target?: string | null;
  query?: string | null;
  template?: string | null;
  requestedBy?: string | null;
  payload?: Record<string, unknown>;
}

/** Queue a job; an identical job already queued or running is returned instead of duplicated. */
export async function queueJob(store: Store, input: QueueJobInput): Promise<{ job: ResearchJob; created: boolean }> {
  const target = input.target?.trim() || null;
  const query = input.query?.trim() || null;
  if (!target && !query) throw new Error('a research job needs a target (entity / concept / page) or a query');
  const template = input.template?.trim() || input.kind;
  const [dup] = await store.query<Row>(
    `SELECT ${COLS} FROM research_jobs
     WHERE kind = $1 AND COALESCE(target, '') = $2 AND COALESCE(query, '') = $3 AND status IN ('queued', 'running', 'validating')
     ORDER BY created_at LIMIT 1`,
    [input.kind, target ?? '', query ?? ''],
  );
  if (dup) return { job: project(dup), created: false };
  const id = `r_${crypto.randomBytes(5).toString('hex')}`;
  const [row] = await store.query<Row>(
    `INSERT INTO research_jobs (id, kind, target, query, template, status, payload, requested_by)
     VALUES ($1, $2, $3, $4, $5, 'queued', $6::jsonb, $7) RETURNING ${COLS}`,
    [id, input.kind, target, query, template, JSON.stringify(input.payload ?? {}), input.requestedBy ?? null],
  );
  return { job: project(row), created: true };
}

export async function getJob(store: Store, id: string): Promise<ResearchJob | null> {
  const [row] = await store.query<Row>(`SELECT ${COLS} FROM research_jobs WHERE id = $1`, [id]);
  return row ? project(row) : null;
}

export async function listJobs(store: Store, opts: { status?: ResearchStatus | ResearchStatus[]; limit?: number } = {}): Promise<ResearchJob[]> {
  const statuses = opts.status ? (Array.isArray(opts.status) ? opts.status : [opts.status]) : null;
  const params: unknown[] = [];
  let where = '';
  if (statuses?.length) {
    where = `WHERE status IN (${statuses.map((s) => { params.push(s); return `$${params.length}`; }).join(',')})`;
  }
  params.push(opts.limit ?? 100);
  const rows = await store.query<Row>(`SELECT ${COLS} FROM research_jobs ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
  return rows.map(project);
}

export async function updateJob(store: Store, id: string, patch: Partial<{
  status: ResearchStatus; agent: string | null; model: string | null; worksetId: string | null; outputPath: string | null;
  error: string | null; attempts: number; turns: number | null; costUsd: number | null; payload: Record<string, unknown>;
  startedAt: string | null; finishedAt: string | null;
}>): Promise<ResearchJob | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const set = (col: string, value: unknown, cast = '') => {
    params.push(value);
    sets.push(`${col} = $${params.length}${cast}`);
  };
  if (patch.status !== undefined) set('status', patch.status);
  if (patch.agent !== undefined) set('agent', patch.agent);
  if (patch.model !== undefined) set('model', patch.model);
  if (patch.worksetId !== undefined) set('workset_id', patch.worksetId);
  if (patch.outputPath !== undefined) set('output_path', patch.outputPath);
  if (patch.error !== undefined) set('error', patch.error);
  if (patch.attempts !== undefined) set('attempts', patch.attempts);
  if (patch.turns !== undefined) set('turns', patch.turns);
  if (patch.costUsd !== undefined) set('cost_usd', patch.costUsd);
  if (patch.payload !== undefined) set('payload', JSON.stringify(patch.payload), '::jsonb');
  if (patch.startedAt !== undefined) set('started_at', patch.startedAt, '::timestamptz');
  if (patch.finishedAt !== undefined) set('finished_at', patch.finishedAt, '::timestamptz');
  if (sets.length === 0) return getJob(store, id);
  const [row] = await store.query<Row>(`UPDATE research_jobs SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLS}`, params);
  return row ? project(row) : null;
}

/** Atomically take the oldest queued job (null when the queue is empty). */
export async function claimNextJob(store: Store): Promise<ResearchJob | null> {
  const [row] = await store.query<Row>(
    `UPDATE research_jobs SET status = 'running', started_at = now(), attempts = attempts + 1
     WHERE id = (SELECT id FROM research_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1)
     RETURNING ${COLS}`,
  );
  return row ? project(row) : null;
}

export async function cancelJob(store: Store, id: string): Promise<boolean> {
  const rows = await store.query<{ id: string }>(
    `UPDATE research_jobs SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status IN ('queued', 'running', 'validating') RETURNING id`,
    [id],
  );
  return rows.length > 0;
}

/** Put a failed / cancelled job back in the queue. */
export async function retryJob(store: Store, id: string): Promise<ResearchJob | null> {
  const [row] = await store.query<Row>(
    `UPDATE research_jobs SET status = 'queued', error = NULL, finished_at = NULL WHERE id = $1 AND status IN ('failed', 'cancelled', 'done') RETURNING ${COLS}`,
    [id],
  );
  return row ? project(row) : null;
}

/** Jobs left 'running' by a crashed serve are queued again on startup. */
export async function requeueStale(store: Store): Promise<number> {
  const rows = await store.query<{ id: string }>(
    `UPDATE research_jobs SET status = 'queued' WHERE status IN ('running', 'validating') RETURNING id`,
  );
  return rows.length;
}
