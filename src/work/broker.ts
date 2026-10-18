import { ChatMessage } from '../llm/client.js';
import { FailureKind } from '../labeling/failures.js';
import { CompleteResult, TaskOutcome, WorkerIdentity } from '../labeling/scheduler.js';
import { isSharedKind, SHARED_KINDS, SharedKind, WORK_KINDS, WorkKind } from './kinds.js';

/**
 * The work broker — every kind of leased work behind one lease protocol
 * (docs/design/11).
 *
 * One per workspace in `serve`. Each kind has a source that makes its tasks
 * and knows what an answer means: the labeling scheduler for extraction
 * segments (src/labeling/scheduler.ts), the summary source for summary pages
 * (src/work/summarize.ts), the judge source for a review's judge calls
 * (src/work/judge.ts). A slot — one of `serve`'s own (src/labeling/local.ts)
 * or one on a remote worker (src/remote) — asks for the kinds it takes, and
 * the broker picks which source serves it. Answers, renewals and releases go
 * back to the source that issued the lease.
 *
 * Judge calls go first: a review is waiting on them, and a round has only a
 * bounded number. A slot that takes several of the other kinds gets them by
 * weight (`server.remote.shares`, extraction 3 : summaries 1 by default): each
 * kind's count of tasks handed out, divided by its weight, decides who is
 * next. A kind that had nothing to give banks no credit for it — when it has
 * work again it starts level with the others instead of taking everything
 * until it has caught up. That keeps summaries moving while an import's
 * extraction backlog is out, and extraction moving while summaries pile up.
 */

export interface WorkTask {
  id: string;
  kind: WorkKind;
  /** What the task is about, for a worker's log: a document's path, with the part for a segment. */
  label: string;
  messages: ChatMessage[];
  /** The same messages flattened the way a one-shot CLI takes them. */
  prompt: string;
  /** The answer must be a JSON object. */
  json: boolean;
  maxTokens: number;
  leaseExpiresAt: string;
  /** Extraction segments only: the document and part, as `/labeling/*` has always sent it. */
  document?: { path: string; title: string; part: number; parts: number };
}

/** What every source reports about its leases; the rest of its status is its own. */
export interface SourceStatus {
  leases: { worker: string }[];
}

/** One kind of work: what the broker needs from its source. */
export interface WorkSource {
  readonly kind: WorkKind;
  readonly leaseDurationMs: number;
  lease(who: WorkerIdentity, max: number): Promise<WorkTask[]>;
  complete(taskId: string, who: WorkerIdentity, outcome: TaskOutcome): Promise<CompleteResult>;
  renew(taskIds: string[], who: WorkerIdentity): { renewed: string[]; lost: string[] };
  release(taskIds: string[], who: WorkerIdentity): Promise<number>;
  /** Whether a task id is one of this source's leases, live or lately expired. */
  holds(taskId: string): boolean;
  status(): Promise<SourceStatus>;
  stop(): Promise<void>;
}

export const DEFAULT_SHARES: Record<SharedKind, number> = { extract: 3, summarize: 1 };

export interface BrokerOptions {
  /** Read on every lease: a settings save may change them. */
  shares?: () => Partial<Record<SharedKind, number>> | undefined;
}

export interface WorkerStatus {
  worker: string;
  backend: string;
  remote: boolean;
  /** The kinds it asked for last. */
  kinds: WorkKind[];
  lastSeen: string;
  /** Leases it holds now, every kind together. */
  leased: number;
  ok: number;
  failed: number;
}

export interface WorkStatus {
  shares: Record<SharedKind, number>;
  kinds: Partial<Record<WorkKind, SourceStatus>>;
  workers: WorkerStatus[];
}

interface WorkerRecord {
  backend: string;
  remote: boolean;
  kinds: WorkKind[];
  lastSeen: number;
  ok: number;
  failed: number;
}

export class WorkBroker {
  private readonly sources = new Map<WorkKind, WorkSource>();
  /** Tasks handed out per kind, each divided by its kind's weight: the lowest goes next. */
  private readonly pass = new Map<WorkKind, number>();
  private readonly workers = new Map<string, WorkerRecord>();

  constructor(sources: WorkSource[], private readonly opts: BrokerOptions = {}) {
    for (const source of sources) this.sources.set(source.kind, source);
  }

  /** The kinds this broker has a source for, in WORK_KINDS order. */
  get kinds(): WorkKind[] {
    return WORK_KINDS.filter((k) => this.sources.has(k));
  }

  source(kind: WorkKind): WorkSource | undefined {
    return this.sources.get(kind);
  }

  /** How long a lease of this kind lasts before it goes back in line (renewable). */
  leaseDurationMs(kind: WorkKind = 'extract'): number {
    return (this.sources.get(kind) ?? [...this.sources.values()][0])?.leaseDurationMs ?? 15 * 60_000;
  }

  /** The weight of each shared kind, from the config, a missing or unusable one at its default. */
  shares(): Record<SharedKind, number> {
    const configured = this.opts.shares?.() ?? {};
    const out = { ...DEFAULT_SHARES };
    for (const kind of SHARED_KINDS) {
      const w = Number(configured[kind]);
      if (Number.isFinite(w) && w > 0) out[kind] = w;
    }
    return out;
  }

  /** Whether a worker asked for this kind of work within the last `withinMs`. */
  askedLately(kind: WorkKind, withinMs: number): boolean {
    const since = Date.now() - withinMs;
    for (const w of this.workers.values()) if (w.lastSeen >= since && w.kinds.includes(kind)) return true;
    return false;
  }

  /** Up to `max` tasks of one of `kinds` for `who` — judge calls first, then a shared kind by share; empty when none has work. */
  async lease(who: WorkerIdentity, kinds: readonly WorkKind[], max = 1): Promise<WorkTask[]> {
    const wanted = WORK_KINDS.filter((k) => kinds.includes(k) && this.sources.has(k));
    this.seen(who, wanted);
    if (wanted.length === 0) return [];
    for (const kind of wanted.filter((k) => !isSharedKind(k))) {
      const tasks = await this.sources.get(kind)!.lease(who, max);
      if (tasks.length) return tasks;
    }
    const shares = this.shares();
    // passes are sums of 1/weight, so a tie may differ in the last bits: within a hair, WORK_KINDS order decides
    const order = wanted.filter(isSharedKind).sort((a, b) => {
      const d = (this.pass.get(a) ?? 0) - (this.pass.get(b) ?? 0);
      return Math.abs(d) > 1e-9 ? d : WORK_KINDS.indexOf(a) - WORK_KINDS.indexOf(b);
    });
    const idle: SharedKind[] = [];
    for (const kind of order) {
      const tasks = await this.sources.get(kind)!.lease(who, max);
      if (tasks.length === 0) {
        idle.push(kind);
        continue;
      }
      const at = this.pass.get(kind) ?? 0;
      // a kind that had nothing to give starts level with the one served, never behind it
      for (const k of idle) this.pass.set(k, Math.max(this.pass.get(k) ?? 0, at));
      this.pass.set(kind, at + tasks.length / shares[kind]);
      return tasks;
    }
    return [];
  }

  /** Hand back a task's outcome to the source that issued it. */
  async complete(taskId: string, who: WorkerIdentity, outcome: TaskOutcome): Promise<CompleteResult> {
    const source = this.owner(taskId);
    if (!source) return { accepted: false, reason: 'unknown or long-expired lease' };
    const result = await source.complete(taskId, who, outcome);
    const record = this.workers.get(who.worker);
    if (record && result.accepted) {
      if (outcome.ok) record.ok++;
      else record.failed++;
    }
    this.touch(who);
    return result;
  }

  /** Extend `who`'s leases, whatever their kinds; returns the ones it still holds. */
  renew(taskIds: string[], who: WorkerIdentity): { renewed: string[]; lost: string[] } {
    const renewed: string[] = [];
    const lost: string[] = [];
    for (const [source, ids] of this.bySource(taskIds, lost)) {
      const r = source.renew(ids, who);
      renewed.push(...r.renewed);
      lost.push(...r.lost);
    }
    if (renewed.length) this.touch(who);
    return { renewed, lost };
  }

  /** Give leases back unanswered: each goes straight back in line. */
  async release(taskIds: string[], who: WorkerIdentity): Promise<number> {
    let n = 0;
    for (const [source, ids] of this.bySource(taskIds, [])) n += await source.release(ids, who);
    return n;
  }

  async status(): Promise<WorkStatus> {
    const kinds: Partial<Record<WorkKind, SourceStatus>> = {};
    const leased = new Map<string, number>();
    for (const [kind, source] of this.sources) {
      const s = await source.status();
      kinds[kind] = s;
      for (const l of s.leases) leased.set(l.worker, (leased.get(l.worker) ?? 0) + 1);
    }
    return {
      shares: this.shares(),
      kinds,
      workers: [...this.workers.entries()].map(([worker, w]) => ({
        worker, backend: w.backend, remote: w.remote, kinds: [...w.kinds], lastSeen: new Date(w.lastSeen).toISOString(),
        leased: leased.get(worker) ?? 0, ok: w.ok, failed: w.failed,
      })),
    };
  }

  /** Stop every source: no new leases, writes in flight finish. */
  async stop(): Promise<void> {
    await Promise.all([...this.sources.values()].map((s) => s.stop()));
  }

  /* ------------------------------ internals ------------------------------ */

  private owner(taskId: string): WorkSource | undefined {
    for (const source of this.sources.values()) if (source.holds(taskId)) return source;
    return undefined;
  }

  private bySource(taskIds: string[], unknown: string[]): Map<WorkSource, string[]> {
    const out = new Map<WorkSource, string[]>();
    for (const id of taskIds) {
      const source = this.owner(id);
      if (!source) {
        unknown.push(id);
        continue;
      }
      out.set(source, [...(out.get(source) ?? []), id]);
    }
    return out;
  }

  private seen(who: WorkerIdentity, kinds: WorkKind[]): void {
    const record = this.workers.get(who.worker) ?? { backend: who.backend, remote: who.remote, kinds, lastSeen: 0, ok: 0, failed: 0 };
    record.kinds = kinds;
    this.workers.set(who.worker, record);
    this.touch(who);
  }

  private touch(who: WorkerIdentity): void {
    const record = this.workers.get(who.worker);
    if (!record) return;
    record.backend = who.backend;
    record.remote = who.remote;
    record.lastSeen = Date.now();
  }
}

/** Every failure kind at zero, for a source's totals. */
export function noFailures(): Record<FailureKind, number> {
  return { model: 0, transient: 0, fatal: 0 };
}
