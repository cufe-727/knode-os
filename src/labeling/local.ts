import os from 'node:os';
import { KnodeConfig, LlmConfig, processingSettings, resolveRoutedLlmConfig, routeTargets } from '../config.js';
import { contentLanguages } from '../lang/languages.js';
import { cliCommand } from '../llm/cli.js';
import { LlmClient } from '../llm/client.js';
import type { CallUsage } from '../llm/usage.js';
import { WorkTask } from '../work/broker.js';
import { WorkKind } from '../work/kinds.js';
import { BackendHealth, classifyFailure, newBackendHealth, recordBackendOutcome } from './failures.js';
import { meteredPlan, PlanQuotaReader, PlanReadings, QuotaHold } from './plan-quota.js';
import { TaskOutcome, WorkerIdentity } from './scheduler.js';

/**
 * `serve`'s own worker slots: slots per backend that take work from the work
 * broker (src/work/broker.ts) and run it on this machine — extraction on a
 * Codex agent and a Cursor agent side by side, say (`extraction.workers`),
 * summary pages on the Summarize stage's route (`summaryConcurrency`), a
 * review's judge calls on the Judge stage's route (`review.concurrency`) and
 * translations on the Translate stage's (`translateConcurrency`).
 * Each backend keeps its own health: a rate limit pauses it, a run of bad
 * answers rests it, a missing CLI or expired login parks it for half an hour
 * and then tries again (src/labeling/failures.ts). Settings saves are picked
 * up within a minute.
 *
 * Two limits sit over every backend (`processing`, one setting for the
 * whole server): at most `maxLocalCalls` calls run at once on this machine,
 * every workspace's slots and every stage together — `serve` hands each
 * workspace's slots the same `CallLimiter`; a review's judge calls are first
 * in line for a free one, since a review waits on them, the rest by turns —
 * and a backend on a plan-metered CLI (Codex, Claude) takes no new work while
 * its plan has less than `minQuotaPercent` left in any window
 * (src/labeling/plan-quota.ts; the readings are shared too). It takes work
 * again once the window resets above the floor; the Tasks view shows it
 * resting until then.
 *
 * The slots run between `start()` and `stop()`: `serve` starts them with the
 * service in every workspace, and the Processing button stops and starts
 * them again until the next restart (src/labeling/processing.ts).
 */

export interface LocalWorkerSpec {
  /** The route target the slots run on ('extract' for the Extract stage's own route, 'summarize' for the Summarize stage's). */
  id: string;
  /** The kinds of work they take. */
  kinds: WorkKind[];
  slots: number;
  llm: LlmConfig;
}

/** What the slots take their work from: the work broker. */
export interface WorkLeaser {
  lease(who: WorkerIdentity, kinds: readonly WorkKind[], max?: number): Promise<WorkTask[]>;
  complete(taskId: string, who: WorkerIdentity, outcome: TaskOutcome): Promise<unknown>;
  renew(taskIds: string[], who: WorkerIdentity): unknown;
}

/**
 * The slots `serve` should run, from the config: `extraction.workers`, else
 * the Extract stage's route × `concurrency`. Workers listed with 0 slots turn
 * this machine's slots off — it then only hands out work to remote workers.
 */
export function localWorkerSpecs(config: KnodeConfig, warn: (msg: string) => void = () => {}): LocalWorkerSpec[] {
  const route = config.extraction.entityLlm;
  const targets = routeTargets(config);
  const listed = (config.extraction.workers ?? []).filter((w) => w && typeof w.use === 'string' && w.use.trim());
  const workers = listed.filter((w) => Number(w.slots) > 0);
  if (listed.length > 0 && workers.length === 0) return [];
  if (workers.length === 0) {
    const llm = resolveRoutedLlmConfig(config.llm, route, targets, config.extraction.tier1Model);
    return [{ id: route.use || 'extract', kinds: ['extract'], slots: Math.max(1, Math.min(16, Math.floor(config.extraction.concurrency || 1))), llm }];
  }
  const out: LocalWorkerSpec[] = [];
  for (const w of workers) {
    const id = w.use.trim();
    if (!targets.some((t) => t.id === id)) {
      warn(`labeling: extraction.workers names "${id}", which is no connection or agent — skipped`);
      continue;
    }
    const llm = resolveRoutedLlmConfig(config.llm, {
      ...route,
      use: id,
      model: w.model ?? '',
      effort: w.effort ?? 'default',
      speed: w.speed ?? 'default',
      cliTimeoutMs: w.cliTimeoutMs ?? route.cliTimeoutMs,
    }, targets);
    out.push({ id, kinds: ['extract'], slots: Math.min(16, Math.floor(w.slots)), llm });
  }
  return out;
}

/**
 * The summary slots `serve` runs: the Summarize stage's route with
 * `summaryConcurrency` slots (default `concurrency`). 0 turns them off — then
 * only remote workers write summaries.
 */
export function localSummarySpec(config: KnodeConfig): LocalWorkerSpec | null {
  const slots = Math.floor(Number(config.extraction.summaryConcurrency ?? config.extraction.concurrency ?? 1));
  if (!(slots > 0)) return null;
  const llm = resolveRoutedLlmConfig(config.llm, config.extraction.summaryLlm, routeTargets(config));
  return { id: 'summarize', kinds: ['summarize'], slots: Math.min(16, slots), llm };
}

/**
 * The judge slots `serve` runs: the Judge stage's route with
 * `review.concurrency` slots (default 2), taking the calls a review waits on
 * (src/work/judge.ts). 0 turns them off — then only remote workers judge.
 */
export function localJudgeSpec(config: KnodeConfig): LocalWorkerSpec | null {
  const slots = Math.floor(Number(config.review?.concurrency ?? 2));
  if (!(slots > 0)) return null;
  const llm = resolveRoutedLlmConfig(config.llm, config.extraction.judgeLlm, routeTargets(config));
  return { id: 'judge', kinds: ['judge'], slots: Math.min(16, slots), llm };
}

/**
 * The translation slots `serve` runs: the Translate stage's route with
 * `translateConcurrency` slots (default `concurrency`), while the workspace
 * has content languages on (docs/design/17). 0 turns them off — then only
 * remote workers translate.
 */
export function localTranslateSpec(config: KnodeConfig): LocalWorkerSpec | null {
  if (!contentLanguages(config).on) return null;
  const slots = Math.floor(Number(config.extraction.translateConcurrency ?? config.extraction.concurrency ?? 1));
  if (!(slots > 0)) return null;
  const llm = resolveRoutedLlmConfig(config.llm, config.extraction.translateLlm, routeTargets(config));
  return { id: 'translate', kinds: ['translate'], slots: Math.min(16, slots), llm };
}

/** Whether this machine can answer judge calls itself: judge slots on a Judge route with a model. */
export function judgesHere(config: KnodeConfig): boolean {
  const spec = localJudgeSpec(config);
  return spec !== null && new LlmClient(spec.llm).enabled;
}

export interface LocalBackendStatus {
  id: string;
  label: string;
  slots: number;
  busy: number;
  calls: number;
  ok: number;
  failed: BackendHealth['failed'];
  pausedUntil: string | null;
  pauseReason: string | null;
  lastError: string | null;
  /** Set while its plan is under the quota floor (also shown as its pause). */
  quotaHold: QuotaHold | null;
}

interface Backend {
  id: string;
  kinds: WorkKind[];
  client: LlmClient;
  slots: number;
  busy: number;
  health: BackendHealth;
  /** The CLI provider and the executable its plan is read through. */
  provider: string;
  command: string;
  quota: { checkedAt: number; hold: QuotaHold | null };
}

export interface LocalWorkersOptions {
  /** Wait between polls of an empty queue. */
  idleMs?: number;
  /** How often the config is checked for changed workers. */
  reconfigureMs?: number;
  log?: (msg: string) => void;
  /**
   * The calls at once this machine allows, shared by every workspace's slots
   * (`serve` makes one). Without it the slots have a limiter of their own.
   */
  limiter?: CallLimiter;
  /** The plan readings this machine shares; without them the slots read plans themselves (`readQuota`, `quotaCheckMs`). */
  plans?: PlanReadings;
  /** How a backend's plan is read for the quota floor (tests hand their own). */
  readQuota?: PlanQuotaReader;
  /** How often a backend's plan is read again, held or not (default 2 minutes). */
  quotaCheckMs?: number;
}

/**
 * At most `capacity` calls at once (0: no cap, only counted), for whoever
 * shares it — under `serve`, every workspace's slots. Whoever waits for a free
 * call is served in turn, except that urgent ones — a review's judge calls —
 * go ahead of the rest. Each call is held by an owner (a workspace's slots),
 * so one owner stopping turns away its own waiters and nobody else's.
 */
export class CallLimiter {
  private capacity = 0;
  private held = 0;
  private readonly heldBy = new Map<unknown, number>();
  private readonly waiting: { urgent: boolean; owner: unknown; grant: (ok: boolean) => void }[] = [];

  /** Calls held now, by everyone. */
  get inUse(): number {
    return this.held;
  }

  get limit(): number {
    return this.capacity;
  }

  /** Calls `owner` holds now. */
  inUseBy(owner: unknown): number {
    return this.heldBy.get(owner) ?? 0;
  }

  setCapacity(n: number): void {
    this.capacity = Math.max(0, Math.floor(n));
    this.drain();
  }

  /** Resolves true once a call may start, false when the wait was called off. */
  acquire(urgent = false, owner: unknown = null): Promise<boolean> {
    if (this.waiting.length === 0 && (this.capacity === 0 || this.held < this.capacity)) {
      this.take(owner);
      return Promise.resolve(true);
    }
    return new Promise((grant) => {
      const entry = { urgent, owner, grant };
      const after = urgent ? this.waiting.findIndex((w) => !w.urgent) : -1;
      if (after >= 0) this.waiting.splice(after, 0, entry);
      else this.waiting.push(entry);
    });
  }

  release(owner: unknown = null): void {
    if (this.held > 0) this.held--;
    const n = this.heldBy.get(owner) ?? 0;
    if (n > 1) this.heldBy.set(owner, n - 1);
    else this.heldBy.delete(owner);
    this.drain();
  }

  /** Turn away `owner`'s waiters (its slots are stopping); with no owner given, everyone's. */
  cancel(...owner: [unknown?]): void {
    const all = owner.length === 0;
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      if (!all && this.waiting[i].owner !== owner[0]) continue;
      const [w] = this.waiting.splice(i, 1);
      w.grant(false);
    }
  }

  private take(owner: unknown): void {
    this.held++;
    this.heldBy.set(owner, (this.heldBy.get(owner) ?? 0) + 1);
  }

  private drain(): void {
    while (this.waiting.length > 0 && (this.capacity === 0 || this.held < this.capacity)) {
      const w = this.waiting.shift()!;
      this.take(w.owner);
      w.grant(true);
    }
  }
}

export class LocalLabelingWorkers {
  private backends: Backend[] = [];
  private signature = '';
  private generation = 0;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly sleepers = new Set<() => void>();
  private readonly log: (msg: string) => void;
  private readonly limiter: CallLimiter;
  private readonly plans: PlanReadings;
  private readonly quotaCheckMs: number;

  constructor(
    private readonly work: WorkLeaser,
    private readonly config: () => KnodeConfig,
    private readonly opts: LocalWorkersOptions = {},
  ) {
    this.log = opts.log ?? (() => {});
    this.limiter = opts.limiter ?? new CallLimiter();
    this.plans = opts.plans ?? new PlanReadings({ read: opts.readQuota, checkMs: opts.quotaCheckMs, log: (m) => this.log(`labeling: ${m}`) });
    this.quotaCheckMs = this.plans.checkMs;
  }

  /**
   * Calls this machine's slots run now, every workspace's together, and the
   * most they may (0: no cap beyond each stage's slots); `workspace`: this
   * workspace's own share of them.
   */
  calls(): { inFlight: number; max: number; workspace: number } {
    // the configured cap, before the first start has applied it too
    return { inFlight: this.limiter.inUse, max: processingSettings(this.config()).maxLocalCalls, workspace: this.limiter.inUseBy(this) };
  }

  /** The backends whose plans are under the quota floor now. */
  quotaHolds(): { id: string; label: string; reason: string; until: string | null }[] {
    return this.backends.filter((b) => b.quota.hold).map((b) => ({ id: b.id, label: b.client.label, reason: b.quota.hold!.reason, until: b.quota.hold!.until }));
  }

  /** Whether every backend here that takes `kind` is held by the quota floor (false when none takes it). */
  heldForQuota(kind: WorkKind): boolean {
    return this.quotaHoldFor(kind) !== null;
  }

  /** The hold on `kind` when every backend here that takes it is held, else null. */
  quotaHoldFor(kind: WorkKind): QuotaHold | null {
    const taking = this.backends.filter((b) => b.kinds.includes(kind));
    return taking.length > 0 && taking.every((b) => b.quota.hold !== null) ? taking[0].quota.hold : null;
  }

  /** Whether the slots are taking work. */
  get running(): boolean {
    return this.timer !== null;
  }

  /** Take work from the scheduler, with fresh slots built from the current config. */
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.signature = '';
    this.reconfigure();
    this.timer = setInterval(() => this.reconfigure(), this.opts.reconfigureMs ?? 60_000);
    this.timer.unref?.();
  }

  /**
   * Stop taking work. A call in flight finishes and hands its answer back
   * (dropped only once the scheduler itself has stopped); `start()` again
   * builds new slots.
   */
  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const wake of this.sleepers) wake();
    this.sleepers.clear();
    // only this workspace's waiters: the other workspaces' slots share the limiter
    this.limiter.cancel(this);
  }

  status(): LocalBackendStatus[] {
    const now = Date.now();
    return this.backends.map((b) => {
      const resting = b.health.pausedUntil > now;
      const hold = b.quota.hold;
      // a quota hold shows as a rest until the window resets (or the next reading, where none says when)
      const holdUntil = hold ? hold.until ?? new Date(b.quota.checkedAt + this.quotaCheckMs).toISOString() : null;
      return {
        id: b.id,
        label: b.client.label,
        slots: b.slots,
        busy: b.busy,
        calls: b.health.calls,
        ok: b.health.ok,
        failed: { ...b.health.failed },
        pausedUntil: resting ? new Date(b.health.pausedUntil).toISOString() : holdUntil,
        pauseReason: resting ? b.health.pauseReason : hold?.reason ?? null,
        lastError: b.health.lastError,
        quotaHold: hold,
      };
    });
  }

  /** Rebuild the slots when the configured workers changed; old slots finish their call and stop. */
  reconfigure(): void {
    if (this.stopped) return;
    const config = this.config();
    this.limiter.setCapacity(processingSettings(config).maxLocalCalls);
    const stages = [localSummarySpec(config), localJudgeSpec(config), localTranslateSpec(config)].filter((s): s is LocalWorkerSpec => s !== null);
    const specs = [...localWorkerSpecs(config, this.log), ...stages]
      .map((s) => ({ ...s, client: new LlmClient(s.llm) }))
      .filter((s) => s.client.enabled);
    const signature = JSON.stringify(specs.map((s) => [s.id, s.kinds, s.slots, s.llm.provider, s.llm.model, s.llm.effort, s.llm.speed, s.llm.cliTimeoutMs, s.llm.baseUrl]));
    if (signature === this.signature) return;
    this.signature = signature;
    const generation = ++this.generation;
    this.backends = specs.map((s) => ({
      id: s.id, kinds: s.kinds, client: s.client, slots: s.slots, busy: 0, health: newBackendHealth(),
      provider: s.llm.provider, command: cliCommand(s.llm.provider, s.llm.cliPath ?? ''),
      quota: { checkedAt: 0, hold: null },
    }));
    for (const backend of this.backends) {
      for (let n = 1; n <= backend.slots; n++) void this.slot(backend, n, generation);
    }
    const limits = processingSettings(config);
    const shared = this.opts.limiter ? ' on this machine, every workspace together' : '';
    this.log(this.backends.length
      ? `labeling: local workers ${this.backends.map((b) => `${b.id} (${b.client.label}) × ${b.slots}`).join(', ')}`
        + `${limits.maxLocalCalls > 0 ? `; at most ${limits.maxLocalCalls} calls at once${shared}` : ''}`
        + `${limits.minQuotaPercent > 0 && this.backends.some((b) => meteredPlan(b.provider)) ? `; a Codex or Claude plan under ${limits.minQuotaPercent}% left holds its stages` : ''}`
      : 'labeling: no local workers (no stage has a model here) — remote workers can still take work');
  }

  private sleep(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.sleepers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      this.sleepers.add(done);
    });
  }

  private live(generation: number): boolean {
    return !this.stopped && generation === this.generation;
  }

  /**
   * Whether a backend's plan is under the quota floor, read at most every
   * `quotaCheckMs` however many slots — of this workspace or another — ask
   * (`PlanReadings`). A backend with no plan reading (an API key, Cursor) is
   * never held; nor is one whose read failed with nothing remembered — a
   * refused call still rests it (src/labeling/failures.ts).
   */
  private async quotaHoldOf(backend: Backend): Promise<QuotaHold | null> {
    const floor = processingSettings(this.config()).minQuotaPercent;
    const hold = await this.plans.hold(backend.provider, backend.command, floor);
    backend.quota.checkedAt = this.plans.checkedAt(backend.provider, backend.command);
    this.noteHold(backend, hold);
    return hold;
  }

  private noteHold(backend: Backend, hold: QuotaHold | null): void {
    const was = backend.quota.hold;
    backend.quota.hold = hold;
    if (hold && !was) this.log(`labeling: ${backend.id} (${backend.client.label}) takes no new work: ${hold.reason}${hold.until ? `, until ${hold.until}` : ''}`);
    else if (!hold && was) this.log(`labeling: ${backend.id} (${backend.client.label}) takes work again: its plan is over the quota floor`);
  }

  private async slot(backend: Backend, n: number, generation: number): Promise<void> {
    const who: WorkerIdentity = { worker: `${os.hostname()}/${backend.id}#${n}`, backend: backend.client.label, remote: false };
    const idleMs = this.opts.idleMs ?? 20_000;
    const urgent = backend.kinds.includes('judge');
    const owner = this;
    while (this.live(generation)) {
      const pause = backend.health.pausedUntil - Date.now();
      if (pause > 0) {
        await this.sleep(Math.min(pause, 15_000));
        continue;
      }
      // the plan before a call: a held backend waits without taking one of the calls
      if (await this.quotaHoldOf(backend)) {
        await this.sleep(this.quotaCheckMs);
        continue;
      }
      if (!(await this.limiter.acquire(urgent, owner))) break;
      if (!this.live(generation)) {
        this.limiter.release(owner);
        break;
      }
      let task: WorkTask | undefined;
      try {
        [task] = await this.work.lease(who, backend.kinds, 1);
      } catch (err) {
        this.limiter.release(owner);
        this.log(`labeling: ${who.worker} could not take work: ${err instanceof Error ? err.message : err}`);
        await this.sleep(30_000);
        continue;
      }
      if (!task) {
        this.limiter.release(owner);
        // jittered, so slots do not poll in lockstep
        await this.sleep(Math.round(idleMs * (0.75 + Math.random() * 0.5)));
        continue;
      }
      let outcome: TaskOutcome;
      try {
        outcome = await this.run(backend, task, who);
      } finally {
        this.limiter.release(owner);
      }
      try {
        await this.work.complete(task.id, who, outcome);
      } catch (err) {
        this.log(`labeling: ${who.worker} could not hand back ${task.label}: ${err instanceof Error ? err.message : err}`);
      }
      const rest = recordBackendOutcome(backend.health, outcome.ok ? { ok: true } : { ok: false, kind: outcome.kind ?? 'model', error: outcome.error });
      if (rest > 0) this.log(`labeling: ${backend.id} rests ${Math.ceil(rest / 60_000)} min after ${backend.health.pauseReason}: ${backend.health.lastError ?? ''}`);
    }
  }

  private async run(backend: Backend, task: WorkTask, who: WorkerIdentity): Promise<TaskOutcome> {
    // embed batches go to the embed slots (src/work/embed.ts), which these never ask for
    if (task.kind === 'embed') return { ok: false, error: 'an LLM slot cannot embed', kind: 'fatal', model: backend.client.label };
    // research sessions go to remote session slots (src/work/session.ts), which these never ask for either
    if (task.kind === 'session') return { ok: false, error: 'an LLM slot cannot run a research session', kind: 'fatal', model: backend.client.label };
    backend.busy++;
    // keep the lease while the call runs; a CLI call may take minutes
    const leaseMs = Date.parse(task.leaseExpiresAt) - Date.now();
    const renew = setInterval(() => this.work.renew([task.id], who), Math.max(5_000, Math.floor((Number.isFinite(leaseMs) ? leaseMs : 60_000) / 3)));
    renew.unref?.();
    // what the provider says the call used, for the estimates' ledger (src/estimate/ledger.ts)
    let usage: CallUsage | undefined;
    const onUsage = (u: CallUsage) => { usage = u; };
    try {
      this.log(`${task.kind === 'extract' ? 'tier1 extract' : task.kind} ${task.label} · ${backend.id}`);
      const text = await backend.client.complete(task.messages, { json: task.json, maxTokens: task.maxTokens, onUsage });
      return { ok: true, text, model: backend.client.label, ...(usage ? { usage } : {}) };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { ok: false, error, kind: classifyFailure(error), model: backend.client.label, ...(usage ? { usage } : {}) };
    } finally {
      clearInterval(renew);
      backend.busy--;
    }
  }
}
