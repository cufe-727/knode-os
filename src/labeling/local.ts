import os from 'node:os';
import { KnodeConfig, LlmConfig, resolveRoutedLlmConfig, routeTargets } from '../config.js';
import { LlmClient } from '../llm/client.js';
import { BackendHealth, classifyFailure, newBackendHealth, recordBackendOutcome } from './failures.js';
import { LabelingScheduler, LabelingTask, TaskOutcome, WorkerIdentity } from './scheduler.js';

/**
 * `serve`'s own labeling workers: slots per backend that take segments from
 * the scheduler and run them on this machine — a Codex agent and a Cursor
 * agent side by side, say (`extraction.workers`). Each backend keeps its own
 * health: a rate limit pauses it, a run of bad answers rests it, a missing CLI
 * or expired login parks it for half an hour and then tries again
 * (src/labeling/failures.ts). Settings saves are picked up within a minute.
 *
 * The slots run only between `start()` and `stop()`, as often as someone
 * starts and stops them (src/labeling/processing.ts): `serve` never starts
 * them on its own.
 */

export interface LocalWorkerSpec {
  /** The route target the slots run on ('extract' for the Extract stage's own route). */
  id: string;
  slots: number;
  llm: LlmConfig;
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
    return [{ id: route.use || 'extract', slots: Math.max(1, Math.min(16, Math.floor(config.extraction.concurrency || 1))), llm }];
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
    out.push({ id, slots: Math.min(16, Math.floor(w.slots)), llm });
  }
  return out;
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
}

interface Backend {
  id: string;
  client: LlmClient;
  slots: number;
  busy: number;
  health: BackendHealth;
}

export interface LocalWorkersOptions {
  /** Wait between polls of an empty queue. */
  idleMs?: number;
  /** How often the config is checked for changed workers. */
  reconfigureMs?: number;
  log?: (msg: string) => void;
}

export class LocalLabelingWorkers {
  private backends: Backend[] = [];
  private signature = '';
  private generation = 0;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly sleepers = new Set<() => void>();
  private readonly log: (msg: string) => void;

  constructor(
    private readonly scheduler: LabelingScheduler,
    private readonly config: () => KnodeConfig,
    private readonly opts: LocalWorkersOptions = {},
  ) {
    this.log = opts.log ?? (() => {});
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
  }

  status(): LocalBackendStatus[] {
    const now = Date.now();
    return this.backends.map((b) => ({
      id: b.id,
      label: b.client.label,
      slots: b.slots,
      busy: b.busy,
      calls: b.health.calls,
      ok: b.health.ok,
      failed: { ...b.health.failed },
      pausedUntil: b.health.pausedUntil > now ? new Date(b.health.pausedUntil).toISOString() : null,
      pauseReason: b.health.pausedUntil > now ? b.health.pauseReason : null,
      lastError: b.health.lastError,
    }));
  }

  /** Rebuild the slots when the configured workers changed; old slots finish their call and stop. */
  reconfigure(): void {
    if (this.stopped) return;
    const specs = localWorkerSpecs(this.config(), this.log).map((s) => ({ ...s, client: new LlmClient(s.llm) })).filter((s) => s.client.enabled);
    const signature = JSON.stringify(specs.map((s) => [s.id, s.slots, s.llm.provider, s.llm.model, s.llm.effort, s.llm.speed, s.llm.cliTimeoutMs, s.llm.baseUrl]));
    if (signature === this.signature) return;
    this.signature = signature;
    const generation = ++this.generation;
    this.backends = specs.map((s) => ({ id: s.id, client: s.client, slots: s.slots, busy: 0, health: newBackendHealth() }));
    for (const backend of this.backends) {
      for (let n = 1; n <= backend.slots; n++) void this.slot(backend, n, generation);
    }
    this.log(this.backends.length
      ? `labeling: local workers ${this.backends.map((b) => `${b.id} (${b.client.label}) × ${b.slots}`).join(', ')}`
      : 'labeling: no local workers (the Extract stage has no model) — remote workers can still take segments');
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

  private async slot(backend: Backend, n: number, generation: number): Promise<void> {
    const who: WorkerIdentity = { worker: `${os.hostname()}/${backend.id}#${n}`, backend: backend.client.label, remote: false };
    const idleMs = this.opts.idleMs ?? 20_000;
    while (this.live(generation)) {
      const pause = backend.health.pausedUntil - Date.now();
      if (pause > 0) {
        await this.sleep(Math.min(pause, 15_000));
        continue;
      }
      let task: LabelingTask | undefined;
      try {
        [task] = await this.scheduler.lease(who, 1);
      } catch (err) {
        this.log(`labeling: ${who.worker} could not take work: ${err instanceof Error ? err.message : err}`);
        await this.sleep(30_000);
        continue;
      }
      if (!task) {
        // jittered, so slots do not poll in lockstep
        await this.sleep(Math.round(idleMs * (0.75 + Math.random() * 0.5)));
        continue;
      }
      const outcome = await this.run(backend, task, who);
      try {
        await this.scheduler.complete(task.id, who, outcome);
      } catch (err) {
        this.log(`labeling: ${who.worker} could not hand back ${task.document.path}: ${err instanceof Error ? err.message : err}`);
      }
      const rest = recordBackendOutcome(backend.health, outcome.ok ? { ok: true } : { ok: false, kind: outcome.kind ?? 'model', error: outcome.error });
      if (rest > 0) this.log(`labeling: ${backend.id} rests ${Math.ceil(rest / 60_000)} min after ${backend.health.pauseReason}: ${backend.health.lastError ?? ''}`);
    }
  }

  private async run(backend: Backend, task: LabelingTask, who: WorkerIdentity): Promise<TaskOutcome> {
    backend.busy++;
    // keep the lease while the call runs; a CLI call may take minutes
    const renew = setInterval(() => this.scheduler.renew([task.id], who), Math.max(5_000, Math.floor(this.scheduler.leaseDurationMs / 3)));
    renew.unref?.();
    try {
      this.log(`tier1 extract ${task.document.path}${task.document.parts > 1 ? ` [${task.document.part}/${task.document.parts}]` : ''} · ${backend.id}`);
      const text = await backend.client.complete(task.messages, { json: true, maxTokens: task.maxTokens });
      return { ok: true, text, model: backend.client.label };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { ok: false, error, kind: classifyFailure(error), model: backend.client.label };
    } finally {
      clearInterval(renew);
      backend.busy--;
    }
  }
}
