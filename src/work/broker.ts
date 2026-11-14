import { CallLedger, isRefusal } from '../estimate/ledger.js';
import { ChatMessage } from '../llm/client.js';
import { estimateTokens } from '../llm/tokens.js';
import { FailureKind } from '../labeling/failures.js';
import { CompleteResult, TaskOutcome, WorkerIdentity } from '../labeling/scheduler.js';
import { classOf, isEvalKind, isSharedKind, LlmKind, SHARED_KINDS, SharedKind, WorkClass, WORK_KINDS, WorkKind } from './kinds.js';

/**
 * The work broker — every kind of leased work behind one lease protocol
 * (docs/design/12).
 *
 * One per workspace in `serve`. Each kind has a source that makes its tasks
 * and knows what an answer means: the labeling scheduler for extraction
 * segments (src/labeling/scheduler.ts), the summary source for summary pages
 * (src/work/summarize.ts), the judge source for a review's judge calls
 * (src/work/judge.ts), the embed source for batches of texts to embed
 * (src/work/embed.ts). A slot — one of `serve`'s own (src/labeling/local.ts)
 * or one on a remote worker (src/remote) — asks for the kinds it takes, and
 * the broker picks which source serves it. Answers, renewals and releases go
 * back to the source that issued the lease.
 *
 * Judge calls go first: a review is waiting on them, and a round has only a
 * bounded number. Embed batches are taken only by embed slots, which ask for
 * nothing else. A slot that takes several of the other kinds gets them by
 * weight (`server.remote.shares`, extraction 3 : summaries 1 by default): each
 * kind's count of tasks handed out, divided by its weight, decides who is
 * next. A kind that had nothing to give banks no credit for it — when it has
 * work again it starts level with the others instead of taking everything
 * until it has caught up. That keeps summaries moving while an import's
 * extraction backlog is out, and extraction moving while summaries pile up.
 *
 * Every answer is also measured into the workspace's call ledger
 * (src/estimate/ledger.ts) — how long the lease took, how big the prompt and
 * the reply were, what the provider said it used — whoever answered it, so an
 * estimate learns from remote workers' calls as well as this machine's.
 */

/** What every task carries, whatever its kind. */
interface TaskBase {
  id: string;
  kind: WorkKind;
  /** What the task is about, for a worker's log: a document's path, with the part for a segment. */
  label: string;
  leaseExpiresAt: string;
  /** `kb` or `eval` (docs/design/32 §2); the broker sets it on every task it hands out. */
  class?: WorkClass;
  /** The CLI, model, effort and speed the task must run on; null for a kind that runs on a slot's own route. */
  requires?: EvalAgent | null;
  /** Only a slot of this pool may take it; absent or null: any slot that meets `requires`. */
  pool?: string | null;
  /** `local`: only a slot on this machine may take it. */
  eligible?: 'any' | 'local';
}

/** A model call: extraction, a summary, a judge call, a translation. */
export interface LlmWorkTask extends TaskBase {
  kind: LlmKind;
  messages: ChatMessage[];
  /** The same messages flattened the way a one-shot CLI takes them. */
  prompt: string;
  /** The answer must be a JSON object. */
  json: boolean;
  maxTokens: number;
  /** Extraction segments only: the document and part, as `/labeling/*` has always sent it. */
  document?: { path: string; title: string; part: number; parts: number };
}

/** A batch of texts to embed (src/work/embed.ts): the answer is one raw vector per input. */
export interface EmbedWorkTask extends TaskBase {
  kind: 'embed';
  /** The vector space the answer must belong to: the workspace's embedding identity at lease time. */
  vectorModel: string;
  dimensions: number;
  /** A lent key and its reservation (docs/design/12 §4.2); null on this machine's slots and on an own endpoint. */
  credential: { id: string; reservation: string } | null;
  inputs: string[];
}

/**
 * A research agent session (src/work/session.ts, docs/design/27): what the
 * worker needs to build the CLI's command itself — never argv, environment or
 * a config layer — and the token the session reaches knode with, at
 * `…/sessions/<id>/mcp` on the server the worker already talks to.
 */
export interface SessionWorkTask extends TaskBase {
  kind: 'session';
  /** The research job the session belongs to. */
  job: string;
  agent: { family: 'codex' | 'claude'; model: string; effort: string | null; speed: string | null };
  maxTurns: number;
  timeoutMs: number;
  /** `read`: knode's read tools; `write`: also knode_write / knode_commit for the job's own page. */
  tools: 'read' | 'write';
  web: boolean;
  webFreshness: string | null;
  /** Written as AGENTS.md and CLAUDE.md in the session's folder. */
  schema: string;
  prompt: string;
  /** The session's own token for its MCP route, valid while the lease lives. */
  mcpToken: string;
}

/** The agent an evaluation task names: the CLI family and model the run names, nothing the worker picks (docs/design/27 §8). */
export interface EvalAgent {
  family: 'codex' | 'claude';
  /** Never empty: a run offers only work whose model it names. */
  model: string;
  /** In the CLI's own terms (effortFor / speedFor), null = the CLI's setting. */
  effort: string | null;
  speed: string | null;
}

/** One model call of an evaluation run (src/work/eval.ts): the prompt as the CLI takes it on stdin. */
export interface EvalCallWorkTask extends TaskBase {
  kind: 'eval-call';
  run: string;
  /** The run's own key for the piece (docs/design/32 §2): opaque to a worker. */
  key: string;
  agent: EvalAgent;
  prompt: string;
  /** A strict JSON schema for the reply (Codex `--output-schema`), or null. */
  schema: unknown;
  timeoutMs: number;
}

/**
 * One agent session of an evaluation run: the fields `runAgent` builds its
 * `codex exec` from (src/eval/agent.ts), never argv or environment. A file
 * agent's folder comes as a content-addressed archive (`eval-archives/<sha256>`);
 * an MCP agent reaches the run's knode tools at `…/eval-sessions/<id>/mcp`
 * with its own token, filtered to `mcp.tools`.
 */
export interface EvalSessionWorkTask extends TaskBase {
  kind: 'eval-session';
  run: string;
  key: string;
  agent: EvalAgent;
  sandbox: 'read-only' | 'workspace-write';
  maxSteps: number;
  timeoutMs: number;
  prompt: string;
  archive: { sha256: string; bytes: number } | null;
  mcp: { token: string; tools: string[] } | null;
}

export type WorkTask = LlmWorkTask | EmbedWorkTask | SessionWorkTask | EvalCallWorkTask | EvalSessionWorkTask;

/** What a slot says about itself beyond its identity, for the kinds that need it (embed: src/work/embed.ts). */
export interface LeaseRequest {
  /** The calibration an own embedding endpoint passed (docs/design/12 §4.3). */
  calibration?: string;
  /** The slot embeds on lent keys, and its token may hold them (§4.2). */
  lentKeys?: boolean;
}

/** What every source reports about its leases; the rest of its status is its own. */
export interface SourceStatus {
  leases: { worker: string }[];
}

/** One kind of work: what the broker needs from its source. */
export interface WorkSource {
  readonly kind: WorkKind;
  readonly leaseDurationMs: number;
  lease(who: WorkerIdentity, max: number, request?: LeaseRequest): Promise<WorkTask[]>;
  complete(taskId: string, who: WorkerIdentity, outcome: TaskOutcome): Promise<CompleteResult>;
  renew(taskIds: string[], who: WorkerIdentity): { renewed: string[]; lost: string[] };
  release(taskIds: string[], who: WorkerIdentity): Promise<number>;
  /** Whether a task id is one of this source's leases, live or lately expired. */
  holds(taskId: string): boolean;
  status(): Promise<SourceStatus>;
  stop(): Promise<void>;
}

export const DEFAULT_SHARES: Record<SharedKind, number> = { extract: 3, summarize: 1, translate: 1 };

export interface BrokerOptions {
  /** Read on every lease: a settings save may change them. */
  shares?: () => Partial<Record<SharedKind, number>> | undefined;
  /** Where answered calls are measured (src/estimate/ledger.ts). */
  ledger?: CallLedger | null;
}

/** A lease handed out, until its answer comes back: what the ledger needs of it. */
interface Issued {
  kind: WorkKind;
  at: number;
  promptTokens: number;
}

/** A lease nobody answered or released is forgotten after this long (a lapsed one is re-issued under a new id). */
const ISSUED_TTL_MS = 6 * 3_600_000;

export interface WorkerStatus {
  worker: string;
  backend: string;
  remote: boolean;
  /** The pool its worker declared (docs/design/32 §2), null for `serve`'s own slots. */
  pool: string | null;
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
  pool: string | null;
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
  private readonly issued = new Map<string, Issued>();

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
  async lease(who: WorkerIdentity, kinds: readonly WorkKind[], max = 1, request?: LeaseRequest): Promise<WorkTask[]> {
    const wanted = WORK_KINDS.filter((k) => kinds.includes(k) && this.sources.has(k));
    this.seen(who, wanted);
    if (wanted.length === 0) return [];
    for (const kind of wanted.filter((k) => !isSharedKind(k))) {
      const tasks = await this.sources.get(kind)!.lease(who, max, request);
      if (tasks.length) return this.issue(tasks);
    }
    const shares = this.shares();
    // passes are sums of 1/weight, so a tie may differ in the last bits: within a hair, WORK_KINDS order decides
    const order = wanted.filter(isSharedKind).sort((a, b) => {
      const d = (this.pass.get(a) ?? 0) - (this.pass.get(b) ?? 0);
      return Math.abs(d) > 1e-9 ? d : WORK_KINDS.indexOf(a) - WORK_KINDS.indexOf(b);
    });
    const idle: SharedKind[] = [];
    for (const kind of order) {
      const tasks = await this.sources.get(kind)!.lease(who, max, request);
      if (tasks.length === 0) {
        idle.push(kind);
        continue;
      }
      const at = this.pass.get(kind) ?? 0;
      // a kind that had nothing to give starts level with the one served, never behind it
      for (const k of idle) this.pass.set(k, Math.max(this.pass.get(k) ?? 0, at));
      this.pass.set(kind, at + tasks.length / shares[kind]);
      return this.issue(tasks);
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
    this.measure(taskId, who, outcome);
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
    for (const id of taskIds) this.issued.delete(id);
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
        worker, backend: w.backend, remote: w.remote, pool: w.pool, kinds: [...w.kinds], lastSeen: new Date(w.lastSeen).toISOString(),
        leased: leased.get(worker) ?? 0, ok: w.ok, failed: w.failed,
      })),
    };
  }

  /** Stop every source: no new leases, writes in flight finish. */
  async stop(): Promise<void> {
    await Promise.all([...this.sources.values()].map((s) => s.stop()));
  }

  /* ------------------------------ internals ------------------------------ */

  /** Note when each task went out, and how big its prompt was, for the ledger; every task says its class, requirements and eligibility. */
  private issue(issued: WorkTask[]): WorkTask[] {
    const tasks = issued.map((t) => ({ class: classOf(t.kind), requires: null, eligible: 'any' as const, ...t }) as WorkTask);
    if (!this.opts.ledger) return tasks;
    const now = Date.now();
    for (const [id, i] of this.issued) if (now - i.at > ISSUED_TTL_MS) this.issued.delete(id);
    // the ledger measures this workspace's model calls; a batch of vectors, an agent session or an evaluation run's work is none it estimates
    for (const task of tasks) if (task.kind !== 'embed' && task.kind !== 'session' && !isEvalKind(task.kind)) this.issued.set(task.id, { kind: task.kind, at: now, promptTokens: estimateTokens(task.prompt) });
    return tasks;
  }

  /** Record an answer in the ledger: lease to answer, prompt and reply sizes, the provider's own count. */
  private measure(taskId: string, who: WorkerIdentity, outcome: TaskOutcome): void {
    const issued = this.issued.get(taskId);
    if (!issued || !this.opts.ledger) return;
    this.issued.delete(taskId);
    this.opts.ledger.record({
      kind: issued.kind,
      route: outcome.model || who.backend,
      remote: who.remote,
      ok: outcome.ok,
      ms: Date.now() - issued.at,
      promptTokens: issued.promptTokens,
      replyTokens: outcome.ok ? estimateTokens(outcome.text) : 0,
      usage: outcome.usage ?? null,
      // a limit is what a worker reports as transient; a bad answer that merely mentions one is not
      refused: !outcome.ok && outcome.kind !== 'model' && isRefusal(outcome.error),
      error: outcome.ok ? undefined : outcome.error,
    });
  }

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
    const record = this.workers.get(who.worker) ?? { backend: who.backend, remote: who.remote, pool: who.pool ?? null, kinds, lastSeen: 0, ok: 0, failed: 0 };
    record.kinds = kinds;
    this.workers.set(who.worker, record);
    this.touch(who);
  }

  private touch(who: WorkerIdentity): void {
    const record = this.workers.get(who.worker);
    if (!record) return;
    record.backend = who.backend;
    record.remote = who.remote;
    record.pool = who.pool ?? null;
    record.lastSeen = Date.now();
  }
}

/** Every failure kind at zero, for a source's totals. */
export function noFailures(): Record<FailureKind, number> {
  return { model: 0, transient: 0, fatal: 0 };
}
