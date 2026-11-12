import { activityOf, ActivityItem } from '../activity.js';
import { AppContext } from '../context.js';
import { nightlySchedule } from '../dream/dream.js';
import { pendingEmbeddings } from '../ingest/embed-backfill.js';
import { codebaseCheckTime, codebaseLinks, lastCodebaseCheck } from '../ingest/codebase/codebases.js';
import { conversationCheckMinutes, conversationLinks } from '../ingest/conversations/follow.js';
import { feishuCheckTime, feishuLinks, lastFeishuCheck } from '../ingest/feishu/docs.js';
import { linkedFolders } from '../ingest/folders.js';
import { describeFeeds } from '../ingest/feeds/runner.js';
import { FailureKind } from '../labeling/failures.js';
import { activePause } from '../research/failure.js';
import { LIVE_STATUSES } from '../research/jobs.js';
import { WorkKind } from '../work/kinds.js';
import type { WorkspaceServices } from './app.js';

/**
 * Tasks → Queue (GET /api/tasks): everything a workspace has under way or
 * waiting, in one read — the document pipeline stage by stage, the model
 * calls out right now and who holds them, this machine's slots and the remote
 * workers, research and Ask jobs, background syncs, and what runs on a clock
 * (docs/design/20). It only reports: starting and stopping stays with
 * /api/labeling/start|stop, the jobs' own routes and Dream's.
 *
 * Outside `serve` there is no broker and no processing: the stages report what
 * the database says, and the rest is empty.
 */

export type TaskStageId = 'index' | 'embed' | 'extract' | 'summarize' | 'translate' | 'review';

export interface TaskStage {
  id: TaskStageId;
  /** Whether the workspace runs this stage at all: translation off, or no judge to review with, leave it out. */
  enabled: boolean;
  /** Work waiting, counted in `unit`. */
  waiting: number;
  unit: 'documents' | 'chunks' | 'translations' | 'calls';
  /** Model calls out right now. */
  inFlight: number;
  /** Done in the last hour: documents written, pages written, vectors… in the stage's own unit. */
  doneLastHour: number | null;
  callsLastHour: number | null;
  /** Failed calls since the service started (or, for Index, documents that failed to convert). */
  failed: number;
  /** What holds it up, when something does. */
  note: string | null;
}

export interface InFlightTask {
  id: string;
  kind: WorkKind;
  /** The document (or, for a judge call, what it decides). */
  subject: string;
  /** Which part: "part 2 of 5", a summary step, a language. */
  detail: string | null;
  worker: string;
  backend: string;
  remote: boolean;
  ageSeconds: number;
  expiresInSeconds: number;
}

export interface TaskWorker {
  id: string;
  label: string;
  remote: boolean;
  /** Kinds of work it takes; empty for a local backend until it has asked. */
  kinds: WorkKind[];
  /** Local backends only: parallel calls it may make. */
  slots: number | null;
  /** Calls it holds now. */
  busy: number;
  ok: number;
  failed: number;
  lastSeen: string | null;
  /** Asked for work in the last two minutes (a local backend: while processing runs). */
  online: boolean;
  pausedUntil: string | null;
  pauseReason: string | null;
  lastError: string | null;
}

export interface TaskJob {
  id: string;
  kind: 'study' | 'research' | 'init' | 'ask';
  title: string;
  status: string;
  /** A study's stage, a page job's template. */
  stage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  outputPath: string | null;
  /** A queued job waiting out a pause (a spent usage limit, docs/design/22): until when, and why. */
  pausedUntil?: string | null;
  pauseReason?: string | null;
}

export interface ScheduledTask {
  id: 'dream' | 'tier2' | 'traces' | 'datasources' | 'feishu' | 'conversations' | 'codebases';
  /** "03:00" for a daily run, else the interval in minutes. */
  at: string | null;
  everyMinutes: number | null;
  /** The next start, when the clock says; null while it cannot run. */
  next: string | null;
  /** When it last ran, for a task that keeps that across restarts (Feishu, followed repositories) or knows it (followed conversations); null otherwise. */
  last: string | null;
  enabled: boolean;
  running: boolean;
}

export interface LinkedFolderRuntime {
  dest: string;
  source: string;
  watching: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  lastChange: { copied: number; removed: number; at: string } | null;
}

export interface FeedRow {
  id: string;
  title: string;
  connector: string;
  pushOnly: boolean;
  enabled: boolean;
  schedule: string;
  dest: string;
  items: number;
  running: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  problem: string | null;
}

export interface TasksSnapshot {
  at: string;
  /** False outside `serve`: no processing switch, no broker, no slots. */
  serving: boolean;
  processing: { running: boolean; since: string | null; by: string | null } | null;
  stages: TaskStage[];
  inFlight: InFlightTask[];
  workers: TaskWorker[];
  jobs: TaskJob[];
  activity: { running: ActivityItem[]; recent: ActivityItem[] };
  scheduled: ScheduledTask[];
  folders: LinkedFolderRuntime[];
  /** The workspace's feeds (src/ingest/feeds): when each runs next and how its last run went. */
  feeds: FeedRow[];
  dream: { pendingSuggestions: number; lastSuggestionAt: string | null; lookbackDays: number };
  /** Documents that failed to convert or index, newest first (a few). */
  documentErrors: { path: string; error: string | null }[];
}

const ONLINE_MS = 2 * 60_000;
/** The pending-vector count reads every chunk: a polling page shares one count a while. */
const EMBED_COUNT_TTL_MS = 20_000;
const embedCounts = new Map<string, { model: string; n: number; at: number }>();

async function pendingVectors(ctx: AppContext): Promise<number> {
  const cached = embedCounts.get(ctx.dataDir);
  const model = ctx.embedder.model;
  if (cached && cached.model === model && Date.now() - cached.at < EMBED_COUNT_TTL_MS) return cached.n;
  const n = await pendingEmbeddings(ctx.store, model);
  embedCounts.set(ctx.dataDir, { model, n, at: Date.now() });
  return n;
}

const sumFailed = (failed: Record<FailureKind, number> | undefined) => (failed ? failed.model + failed.transient + failed.fatal : 0);

/** The next local time a "HH:MM" comes round. */
export function nextDaily(hhmm: string, now = new Date()): string {
  const [h, m] = hhmm.split(':').map(Number);
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

function jobTitle(kind: string, target: string | null, query: string | null, payload: Record<string, unknown>): string {
  if (kind === 'init') return 'Initialize the knowledge base';
  if (kind === 'study') {
    const brief = payload.brief as { title?: unknown } | undefined;
    if (typeof brief?.title === 'string' && brief.title) return brief.title;
    if (typeof payload.topic === 'string') return payload.topic.slice(0, 160);
  }
  return target || query || kind;
}

export async function tasksSnapshot(ctx: AppContext, services: WorkspaceServices | null): Promise<TasksSnapshot> {
  const now = Date.now();
  const config = ctx.config;
  const activity = activityOf(ctx.dataDir).snapshot();
  const busy = (...kinds: ActivityItem['kind'][]) => activity.running.some((a) => kinds.includes(a.kind));

  const [labeling, work, vectors, docRows, documentErrors, jobRows, chatRows, suggestionRow] = await Promise.all([
    services?.labeling?.status() ?? null,
    services?.work?.status() ?? null,
    pendingVectors(ctx).catch(() => 0),
    ctx.store.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM documents WHERE status IN ('pending', 'error') GROUP BY status`),
    ctx.store.query<{ path: string; error: string | null }>(`SELECT path, error FROM documents WHERE status = 'error' ORDER BY updated_at DESC LIMIT 5`),
    ctx.store.query<{
      id: string; kind: string; target: string | null; query: string | null; template: string; status: string; error: string | null;
      output_path: string | null; payload: Record<string, unknown> | null; created_at: string | Date; started_at: string | Date | null; finished_at: string | Date | null;
    }>(
      `(SELECT * FROM research_jobs WHERE status = ANY($1::text[]) ORDER BY created_at DESC LIMIT 40)
       UNION ALL
       (SELECT * FROM research_jobs WHERE status IN ('done', 'failed', 'cancelled') AND finished_at > now() - interval '24 hours' AND NOT (payload ? 'archivedAt') ORDER BY finished_at DESC LIMIT 10)`,
      [LIVE_STATUSES],
    ),
    ctx.store.query<{ id: string; title: string; created_at: string | Date; updated_at: string | Date }>(
      `SELECT id, title, created_at, updated_at FROM chat_conversations WHERE status = 'running' ORDER BY updated_at DESC LIMIT 20`,
    ),
    ctx.store.query<{ n: number; last: string | Date | null }>(`SELECT count(*) FILTER (WHERE status = 'pending')::int AS n, max(created_at) AS last FROM suggestions`),
  ]);
  const iso = (t: string | Date | null) => (t === null ? null : new Date(t).toISOString());
  const docCount = (status: string) => docRows.find((r) => r.status === status)?.n ?? 0;

  const processing = services?.processing?.state() ?? null;
  const running = processing?.running === true;
  const stopped = services?.processing ? (running ? null : 'waits for processing to start') : null;
  // summaries and translations are counted when a slot first asks for one: until then 0 means "not looked yet"
  const uncounted = 'not counted until processing starts';
  // a stage whose every slot here rests for its plan's quota (src/labeling/plan-quota.ts) says so before anything else
  const resting = (kind: WorkKind): string | null => {
    const hold = running ? services?.localWorkers?.quotaHoldFor(kind) ?? null : null;
    return hold ? `this machine's slots rest: ${hold.reason}` : null;
  };
  const summaries = work?.kinds.summarize as import('../work/summarize.js').SummaryStatus | undefined;
  const translations = work?.kinds.translate as import('../work/translate.js').TranslateStatus | undefined;
  const judge = work?.kinds.judge as import('../work/judge.js').JudgeStatus | undefined;
  // research sessions out on remote workers (docs/design/27)
  const sessionWork = work?.kinds.session as import('../work/session.js').SessionStatus | undefined;
  const backfill = services?.embeddings?.status() ?? null;
  // deferred mode: vectors as leased work, made by this machine's embed slots and remote workers
  const embedWork = work?.kinds.embed as import('../work/embed.js').EmbedStatus | undefined;
  const deferred = embedWork?.mode === 'deferred';
  const embedSlots = services?.embedSlots?.status() ?? null;

  const stages: TaskStage[] = [
    {
      id: 'index', enabled: true, unit: 'documents', waiting: docCount('pending'), inFlight: 0, doneLastHour: null, callsLastHour: null,
      failed: docCount('error'),
      note: busy('sync', 'ingest', 'upload', 'folder') ? 'syncing now' : null,
    },
    deferred && embedWork ? {
      id: 'embed', enabled: true, unit: 'chunks', waiting: vectors, inFlight: embedWork.leases.length,
      doneLastHour: embedWork.lastHour.vectors, callsLastHour: embedWork.lastHour.batches, failed: sumFailed(embedWork.totals.failed),
      note: embedSlots?.pausedUntil ? `local embed slots rest until ${embedSlots.pausedUntil}: ${embedSlots.lastError ?? ''}`
        : embedWork.parked.length ? `${embedWork.parked.map((p) => p.worker).join(', ')} parked: ${embedWork.parked[0].reason}`
          : vectors > 0 && (embedSlots?.slots ?? 0) === 0 && embedWork.endpoints.length === 0 ? 'no embed slots here and no calibrated worker' : null,
    } : {
      id: 'embed', enabled: true, unit: 'chunks', waiting: vectors, inFlight: 0, doneLastHour: null, callsLastHour: null, failed: 0,
      note: backfill?.retryAt ? `the provider could not serve: retrying at ${backfill.retryAt}` : backfill?.lastError ? backfill.lastError : null,
    },
    {
      id: 'extract', enabled: true, unit: 'documents', waiting: labeling?.queued ?? 0, inFlight: labeling?.leases.length ?? 0,
      doneLastHour: labeling?.lastHour.documentsWritten ?? null, callsLastHour: labeling?.lastHour.calls ?? null,
      failed: sumFailed(labeling?.totals.failed), note: resting('extract') ?? (labeling && labeling.queued > 0 ? stopped : null),
    },
    {
      id: 'summarize', enabled: Boolean(summaries), unit: 'documents', waiting: summaries?.due ?? 0, inFlight: summaries?.leases.length ?? 0,
      doneLastHour: summaries?.lastHour.pagesWritten ?? null, callsLastHour: summaries?.lastHour.calls ?? null,
      failed: sumFailed(summaries?.totals.failed),
      note: resting('summarize') ?? (summaries && summaries.scannedAt === null ? uncounted : summaries && summaries.due > 0 ? stopped : null),
    },
    {
      id: 'translate', enabled: translations?.enabled === true, unit: 'translations', waiting: translations?.due ?? 0, inFlight: translations?.leases.length ?? 0,
      doneLastHour: translations?.lastHour.documents ?? null, callsLastHour: translations?.lastHour.calls ?? null,
      failed: sumFailed(translations?.totals.failed),
      note: (translations?.enabled ? resting('translate') : null) ?? (translations?.enabled && translations.scannedAt === null ? uncounted : translations?.enabled && translations.due > 0 ? stopped : null),
    },
    {
      id: 'review', enabled: Boolean(judge), unit: 'calls', waiting: judge?.waiting ?? 0, inFlight: judge?.leases.length ?? 0,
      doneLastHour: null, callsLastHour: judge?.lastHour.calls ?? null,
      failed: sumFailed(judge?.totals.failed), note: resting('judge'),
    },
  ];

  const inFlight: InFlightTask[] = [
    ...(labeling?.leases ?? []).map((l) => ({
      id: l.id, kind: 'extract' as const, subject: l.document, detail: l.parts > 1 ? `part ${l.part} of ${l.parts}` : null,
      worker: l.worker, backend: l.backend, remote: l.remote, ageSeconds: l.ageSeconds, expiresInSeconds: l.expiresInSeconds,
    })),
    ...(summaries?.leases ?? []).map((l) => ({
      id: l.id, kind: 'summarize' as const, subject: l.document, detail: l.label || null,
      worker: l.worker, backend: l.backend, remote: l.remote, ageSeconds: l.ageSeconds, expiresInSeconds: l.expiresInSeconds,
    })),
    ...(translations?.leases ?? []).map((l) => ({
      id: l.id, kind: 'translate' as const, subject: l.document, detail: [l.language, l.label].filter(Boolean).join(' · ') || null,
      worker: l.worker, backend: l.backend, remote: l.remote, ageSeconds: l.ageSeconds, expiresInSeconds: l.expiresInSeconds,
    })),
    ...(judge?.leases ?? []).map((l) => ({
      id: l.id, kind: 'judge' as const, subject: l.call, detail: null,
      worker: l.worker, backend: l.backend, remote: l.remote, ageSeconds: l.ageSeconds, expiresInSeconds: l.expiresInSeconds,
    })),
    ...(embedWork?.leases ?? []).map((l) => ({
      id: l.id, kind: 'embed' as const, subject: l.label, detail: null,
      worker: l.worker, backend: l.backend, remote: l.remote, ageSeconds: l.ageSeconds, expiresInSeconds: l.expiresInSeconds,
    })),
    ...(sessionWork?.leases ?? []).map((l) => ({
      id: l.id, kind: 'session' as const, subject: l.title, detail: `${l.job} · ${l.label}`,
      worker: l.worker, backend: l.backend, remote: l.remote, ageSeconds: l.ageSeconds, expiresInSeconds: l.expiresInSeconds,
    })),
  ].sort((a, b) => b.ageSeconds - a.ageSeconds);

  // this machine's backends, one row each with its slots; remote workers as the broker last saw them
  const workers: TaskWorker[] = [
    ...(services?.localWorkers?.status() ?? []).map((b) => ({
      id: b.id, label: b.label, remote: false, kinds: [] as WorkKind[], slots: b.slots, busy: b.busy, ok: b.ok, failed: sumFailed(b.failed),
      lastSeen: null, online: running, pausedUntil: b.pausedUntil, pauseReason: b.pauseReason, lastError: b.lastError,
    })),
    // this machine's embed slots run whether or not processing does
    ...(embedSlots && embedSlots.slots > 0 ? [{
      id: 'embed', label: embedSlots.endpoint?.calibrated ? `embed:${embedSlots.endpoint.model} at ${embedSlots.endpoint.baseUrl}` : `embed:${ctx.embedder.model}`, remote: false, kinds: ['embed'] as WorkKind[], slots: embedSlots.slots, busy: embedSlots.busy,
      ok: embedSlots.batches, failed: embedSlots.failed, lastSeen: null, online: true, pausedUntil: embedSlots.pausedUntil,
      pauseReason: embedSlots.pausedUntil ? 'the embedder could not serve' : null, lastError: embedSlots.lastError,
    }] : []),
    ...(work?.workers ?? []).filter((w) => w.remote).map((w) => ({
      id: w.worker, label: w.backend, remote: true, kinds: w.kinds, slots: null, busy: w.leased, ok: w.ok, failed: w.failed,
      lastSeen: w.lastSeen, online: now - Date.parse(w.lastSeen) < ONLINE_MS, pausedUntil: null, pauseReason: null, lastError: null,
    })),
  ];

  const jobs: TaskJob[] = [
    ...chatRows.map((c) => ({
      id: c.id, kind: 'ask' as const, title: c.title || 'Untitled question', status: 'running', stage: null,
      createdAt: iso(c.created_at)!, startedAt: iso(c.updated_at), finishedAt: null, error: null, outputPath: null,
    })),
    ...jobRows.filter((j) => j.status !== 'draft').map((j) => {
      const payload = j.payload ?? {};
      const pause = j.status === 'queued' ? activePause(payload) : null;
      return {
        id: j.id,
        kind: j.kind === 'study' ? 'study' as const : j.kind === 'init' ? 'init' as const : 'research' as const,
        title: jobTitle(j.kind, j.target, j.query, payload),
        status: j.status,
        stage: j.kind === 'study' ? (typeof payload.stage === 'string' ? payload.stage : null) : j.kind,
        createdAt: iso(j.created_at)!,
        startedAt: iso(j.started_at),
        finishedAt: iso(j.finished_at),
        error: j.error,
        outputPath: j.output_path,
        pausedUntil: pause?.until ?? null,
        pauseReason: pause?.reason ?? null,
      };
    }),
  ];

  const nightly = nightlySchedule(config);
  const traceEvery = Math.max(1, config.trace.syncIntervalMinutes);
  const feishuAt = feishuCheckTime(config);
  const feishuLinked = feishuLinks(config).length > 0;
  const codebaseAt = codebaseCheckTime(config);
  const codebasesFollowed = codebaseLinks(config).some((l) => l.follow);
  const scheduled: ScheduledTask[] = [
    { id: 'dream', at: nightly?.dream ?? null, everyMinutes: null, next: services && nightly ? nextDaily(nightly.dream) : null, last: null, enabled: Boolean(nightly), running: busy('dream') },
    { id: 'tier2', at: nightly?.tier2 ?? null, everyMinutes: null, next: services && nightly ? nextDaily(nightly.tier2) : null, last: null, enabled: Boolean(nightly), running: busy('tier2') },
    { id: 'traces', at: null, everyMinutes: traceEvery, next: null, last: null, enabled: Boolean(services), running: busy('traces') },
    { id: 'datasources', at: null, everyMinutes: 30, next: null, last: null, enabled: Boolean(services) && config.datasources.length > 0, running: busy('datasources') },
    {
      id: 'feishu',
      at: feishuAt,
      everyMinutes: null,
      next: services?.feishu ? services.feishu.nextCheck() : null,
      last: lastFeishuCheck(ctx.dataDir),
      enabled: Boolean(services) && Boolean(feishuAt) && feishuLinked,
      running: busy('feishu'),
    },
    {
      id: 'conversations',
      at: null,
      everyMinutes: conversationCheckMinutes(config),
      next: services?.conversations ? services.conversations.nextCheck() : null,
      last: services?.conversations?.lastCheck() ?? null,
      enabled: Boolean(services) && conversationLinks(config).length > 0,
      running: busy('conversations'),
    },
    {
      // followed code repositories, fetched again daily (src/ingest/codebase, docs/design/25 D8); an add,
      // update or removal holds the same one-at-a-time slot, so it shows as running too
      id: 'codebases',
      at: codebaseAt,
      everyMinutes: null,
      next: services?.codebases ? services.codebases.nextCheck() : null,
      last: lastCodebaseCheck(config),
      enabled: Boolean(services?.codebases) && Boolean(codebaseAt) && codebasesFollowed,
      running: (services?.codebases?.busy ?? false) || busy('codebase'),
    },
  ];

  const runtime = services?.folders?.runtimeStatus() ?? new Map();
  const folders: LinkedFolderRuntime[] = linkedFolders(config).map((link) => {
    const r = runtime.get(link.dest);
    return {
      dest: link.dest, source: link.source, watching: r?.watching ?? false,
      lastSyncAt: r?.lastSyncAt ?? null, lastError: r?.lastError ?? null, lastChange: r?.lastChange ?? null,
    };
  });

  const feeds: FeedRow[] = (services?.feeds ? services.feeds.status() : describeFeeds(ctx.dataDir)).map((f) => ({
    id: f.id,
    title: f.title,
    connector: f.connectorLabel,
    pushOnly: f.pushOnly,
    enabled: f.enabled,
    schedule: f.pushOnly ? 'takes pushed items' : f.schedule.every ? `every ${f.schedule.every}` : f.schedule.at?.length ? `daily at ${f.schedule.at.join(', ')}` : 'by hand or push',
    dest: f.dest,
    items: f.items,
    running: f.running,
    nextRunAt: services?.feeds ? f.nextRunAt : null,
    lastRunAt: f.state.lastRunAt ?? null,
    lastError: f.state.lastError ?? null,
    problem: f.problem,
  }));

  return {
    at: new Date(now).toISOString(),
    serving: Boolean(services?.work),
    processing,
    stages,
    inFlight,
    workers,
    jobs,
    activity,
    scheduled,
    folders,
    feeds,
    dream: { pendingSuggestions: suggestionRow[0]?.n ?? 0, lastSuggestionAt: iso(suggestionRow[0]?.last ?? null), lookbackDays: config.dream.lookbackDays },
    documentErrors,
  };
}
