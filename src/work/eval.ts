import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { classifyFailure, FailureKind } from '../labeling/failures.js';
import { CompleteResult, SessionAnswer, TaskOutcome, WorkerIdentity } from '../labeling/scheduler.js';
import type { CallUsage } from '../llm/usage.js';
import { readCodexEvents } from '../llm/usage.js';
import { EvalAgent, EvalCallWorkTask, EvalSessionWorkTask, noFailures, SourceStatus, WorkSource, WorkTask } from './broker.js';
import { isArchiveId } from './eval-archive.js';
import type { EvalKind } from './kinds.js';

/**
 * An evaluation run's model work as leased work (docs/design/27 §8).
 *
 * `knode-os eval run` stays a process of its own on this machine: it keeps
 * the run directory, the keyed records, resume, the quota guard and the
 * report. Only its model work leaves, and only through `serve`: the run offers
 * a piece over the loopback producer channel (src/remote/eval-producer.ts),
 * `serve` leases it to a worker through the same lease protocol, tokens and
 * audit as every other kind, and the outcome goes back to the run, which
 * meters and parses it as it would its own.
 *
 *   eval-call     one model call: the prompt as the CLI takes it on stdin, the
 *                 CLI family and model the run names, an optional output schema;
 *   eval-session  one agent session (`runAgent`, src/eval/agent.ts): the fields
 *                 the worker builds `codex exec` from, never argv (D9); a file
 *                 agent's folder as a content-addressed archive, an MCP agent's
 *                 tools through `…/eval-sessions/<id>/mcp` on a token of the
 *                 lease's own, proxied to the run's MCP bridge on this machine.
 *
 * The work is the server's, not a workspace's: one source per kind serves
 * every workspace's broker, and a worker leases it through whichever
 * workspace its token names (with the `eval` scope).
 *
 * The run only publishes (docs/design/32): a piece waits until a slot that
 * takes it leases it — a remote worker's, or one of the run's own on this
 * machine — and never comes back for the run to do itself. A worker's failure
 * is the worker's (D11): a usage limit, a lost login, a missing CLI, a lapsed
 * lease puts the piece back in line. A model's own error on a call (an answer
 * that is no answer) is the call's, and goes back as `error`, as the run's own
 * backend would throw it.
 */

export type EvalFamily = 'codex' | 'claude';
export const EVAL_FAMILIES: readonly EvalFamily[] = ['codex', 'claude'];

/** Where a piece may run (docs/design/32 §2): any slot that meets it, or only a slot on this machine. */
export type EvalEligible = 'any' | 'local';

export interface EvalCallSpec {
  kind: 'eval-call';
  /** The run's id, for cancelling and for Tasks. */
  run: string;
  /** The run's own key for the piece: its local slots find the piece's work by it. */
  key: string;
  /** `local`: leased only to a slot on this machine (a pack with private sources, a backend only the run has). */
  eligible: EvalEligible;
  /** Only a slot of this pool takes it (`eval run --pool`); null: any slot that meets `agent`. */
  pool: string | null;
  label: string;
  agent: EvalAgent;
  prompt: string;
  schema: unknown;
  timeoutMs: number;
}

export interface EvalSessionSpec {
  kind: 'eval-session';
  run: string;
  key: string;
  eligible: EvalEligible;
  pool: string | null;
  label: string;
  agent: EvalAgent;
  /** Only a read-only session may go to another machine; a run's own slots also run the llm-wiki builder's. */
  sandbox: 'read-only' | 'workspace-write';
  maxSteps: number;
  timeoutMs: number;
  prompt: string;
  archive: { sha256: string; bytes: number } | null;
  /** The run's MCP bridge on this machine (never sent to a worker) and the tools it may call. */
  mcp: { url: string; secret: string; tools: string[] } | null;
}

export type EvalSpec = EvalCallSpec | EvalSessionSpec;

/** What a session hands back: its whole stdout (every renewal's and the last), parsed by the run. */
export interface EvalSessionAnswer {
  exitCode: number;
  stdout: string;
  stderr: string;
  lastMessage: string | null;
  capped: boolean;
  /** The worker's folder and home, for the leak audit. */
  cwd: string;
  home: string;
}

export type EvalOutcome =
  | { outcome: 'answered'; worker: string; backend: string; pool?: string | null; text: string; usage: CallUsage | null; model: string; session?: EvalSessionAnswer }
  | { outcome: 'error'; worker: string; backend: string; pool?: string | null; error: string; usage: CallUsage | null }
  /** Three different machines could not serve it (docs/design/32 §3): it is left unanswered, never answered another way. */
  | { outcome: 'stuck'; workers: string[]; lastError: string }
  | { outcome: 'cancelled' }
  | { outcome: 'stopped' };

/** What the MCP route may do for a session's token, while its lease lives. */
export interface EvalSessionBinding {
  run: string;
  label: string;
  worker: string;
  mcp: { url: string; secret: string; tools: string[] };
}

export interface EvalLeaseStatus {
  id: string;
  kind: EvalKind;
  class: 'eval';
  /** The pool the piece requires (null: any) and the one its slot is in. */
  pool: string | null;
  workerPool: string | null;
  worker: string;
  backend: string;
  remote: boolean;
  run: string;
  label: string;
  model: string;
  ageSeconds: number;
  expiresInSeconds: number;
}

/** A slot that asked for this kind lately, as a run reads it to know what could take its pieces. */
export interface EvalSlotSeen {
  worker: string;
  family: EvalFamily;
  /** On this machine: `serve`'s own or a run's (never a worker over /remote/v1). */
  local: boolean;
  /** A run's own slot takes only that run's pieces. */
  run: string | null;
  /** The pool its worker declared; null for a slot that declared none. */
  pool: string | null;
}

/** One run's pieces as the source holds them. */
export interface EvalRunStatus {
  waiting: number;
  leased: number;
}

export interface EvalStatus extends SourceStatus {
  /** Published and waiting for a slot. */
  waiting: number;
  leases: EvalLeaseStatus[];
  totals: { offered: number; answered: number; stuck: number; failed: Record<FailureKind, number>; leasesExpired: number };
}

interface Pending {
  id: string;
  spec: EvalSpec;
  settle: (outcome: EvalOutcome) => void;
  done: boolean;
  lease: string | null;
  strikes: number;
  /** The machines that could not serve it (`<token>/<worker>`, not their slots), and how often each. */
  failedBy: Map<string, number>;
  lastError: string;
  notBefore: number;
}

interface EvalLease {
  id: string;
  token: string | null;
  pending: Pending;
  who: WorkerIdentity;
  issuedAt: number;
  expiresAt: number;
  deadline: number;
  output: string[];
  outputBytes: number;
}

export interface EvalSourceOptions {
  leaseMs?: number;
  retryMs?: number;
  /** Different machines that could not serve a piece before it is `stuck`, and failures by each machine online that make it so (default 3). */
  maxStrikes?: number;
  /** How long a slot that asked counts as online (default 2 min). */
  onlineMs?: number;
  log?: (msg: string) => void;
}

const DEFAULT_LEASE_MS = 120_000;
const RETRY_MS = 5_000;
const DEADLINE_GRACE_MS = 5 * 60_000;
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const ONLINE_MS = 2 * 60_000;
/** Failures of one piece, on any machines, after which it is stuck whatever is online. */
const MAX_ATTEMPTS = 10;

/**
 * Whether a slot may take a piece (docs/design/32 §2): its CLI (the model,
 * effort and speed the slot runs as the piece says, and a reply from another
 * model is the slot's failure), the piece's pool, a piece that must stay on
 * this machine only to a slot here, and a run's own slot only its run's pieces.
 */
export function takes(who: WorkerIdentity, family: EvalFamily, spec: EvalSpec): boolean {
  if (spec.agent.family !== family) return false;
  if (spec.pool && spec.pool !== who.pool) return false;
  if (spec.eligible === 'local' && who.remote) return false;
  if (who.run && spec.run !== who.run) return false;
  return true;
}

/** A slot's identity as a record keeps it: the machine (`<token>/<worker>`), not its slot (`…/eval-codex#2`). */
export function machineOf(worker: string): string {
  return worker.replace(/\/[^/]*#\d+$/, '');
}

/** The CLI family a worker's backend names ("codex", "claude:…"). */
export function evalFamilyOf(backend: string): EvalFamily | null {
  const family = backend.split(':')[0].trim().toLowerCase();
  return (EVAL_FAMILIES as readonly string[]).includes(family) ? (family as EvalFamily) : null;
}

/** The backend a piece ran on, as records keep it: the CLI and the model, whoever's account. */
export function evalBackend(agent: Pick<EvalAgent, 'family' | 'model'>): string {
  return `${agent.family}-cli:${agent.model || 'default'}`;
}

function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Why a session's answer is the worker's failure (D11), or null when it is a result, however poor. */
export function evalSessionFailure(answer: Pick<EvalSessionAnswer, 'exitCode' | 'stdout' | 'stderr' | 'capped'>): { kind: 'transient' | 'fatal'; message: string } | null {
  if (answer.capped || answer.exitCode === 0) return null;
  const message = readCodexEvents(answer.stdout).error ?? answer.stderr.trim().split('\n').slice(-3).join(' ').slice(-400);
  const kind = classifyFailure(message);
  return kind === 'model' ? null : { kind, message: message || `exit ${answer.exitCode}` };
}

export class EvalSource implements WorkSource {
  private readonly pending: Pending[] = [];
  private readonly leases = new Map<string, EvalLease>();
  /** Who asked for this kind lately: slot → what it is and when. */
  private readonly asked = new Map<string, EvalSlotSeen & { at: number }>();
  private readonly totals: EvalStatus['totals'] = { offered: 0, answered: 0, stuck: 0, failed: noFailures(), leasesExpired: 0 };
  private readonly leaseMs: number;
  private readonly retryMs: number;
  private readonly maxStrikes: number;
  private readonly onlineMs: number;
  private readonly log: (msg: string) => void;
  private sweeper: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(readonly kind: EvalKind, opts: EvalSourceOptions = {}) {
    this.leaseMs = Math.max(1_000, opts.leaseMs ?? DEFAULT_LEASE_MS);
    this.retryMs = opts.retryMs ?? RETRY_MS;
    this.maxStrikes = Math.max(1, opts.maxStrikes ?? 3);
    this.onlineMs = Math.max(1, opts.onlineMs ?? ONLINE_MS);
    this.log = opts.log ?? (() => {});
  }

  get leaseDurationMs(): number {
    return this.leaseMs;
  }

  holds(taskId: string): boolean {
    return this.leases.has(taskId);
  }

  /** Slots of this CLI that asked for this kind within `withinMs`. */
  online(family: EvalFamily, withinMs = this.onlineMs): number {
    return this.slotsOnline(withinMs).filter((s) => s.family === family).length;
  }

  /** Every slot that asked for this kind within `withinMs`, or holds one of its leases now (a slot at work asks nothing). */
  slotsOnline(withinMs = this.onlineMs): EvalSlotSeen[] {
    const since = Date.now() - withinMs;
    const busy = new Set([...this.leases.values()].filter((l) => !l.pending.done).map((l) => l.who.worker));
    return [...this.asked.values()].filter((s) => s.at >= since || busy.has(s.worker)).map(({ at: _at, ...s }) => s);
  }

  /** A run's pieces here: waiting for a slot, or out with one. */
  runStatus(run: string): EvalRunStatus {
    const mine = this.pending.filter((p) => !p.done && p.spec.run === run);
    return { waiting: mine.filter((p) => p.lease === null).length, leased: mine.filter((p) => p.lease !== null).length };
  }

  /**
   * Publish a piece. It waits until a slot that takes it leases it (docs/design/32
   * D3): there is no window after which it comes back unserved. The returned
   * promise settles with what became of it; `signal` (the run went away)
   * cancels it wherever it is.
   */
  offer(spec: EvalSpec, opts: { signal?: AbortSignal } = {}): { id: string; result: Promise<EvalOutcome>; cancel: () => void } {
    const id = `e_${crypto.randomBytes(6).toString('hex')}`;
    let resolve: (o: EvalOutcome) => void = () => {};
    const result = new Promise<EvalOutcome>((r) => (resolve = r));
    const p: Pending = {
      id, spec, done: false, lease: null, strikes: 0, failedBy: new Map(), lastError: '', notBefore: 0,
      settle: () => {},
    };
    p.settle = (outcome) => {
      if (p.done) return;
      p.done = true;
      const at = this.pending.indexOf(p);
      if (at !== -1) this.pending.splice(at, 1);
      if (p.lease) this.leases.delete(p.lease);
      p.lease = null;
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = () => p.settle({ outcome: 'cancelled' });
    if (this.closed) p.settle({ outcome: 'stopped' });
    else if (opts.signal?.aborted) p.settle({ outcome: 'cancelled' });
    else {
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.push(p);
      this.totals.offered++;
      this.startSweeper();
    }
    return { id, result, cancel: () => p.settle({ outcome: 'cancelled' }) };
  }

  /** Cancel every piece of a run: its leases end at the next renewal and its session tokens now. */
  cancelRun(run: string): number {
    let n = 0;
    for (const p of [...this.pending]) {
      if (p.spec.run !== run) continue;
      p.settle({ outcome: 'cancelled' });
      n++;
    }
    return n;
  }

  /** Whether an archive belongs to a session offered or out now: only those may be downloaded. */
  wantsArchive(sha256: string): boolean {
    return this.pending.some((p) => !p.done && p.spec.kind === 'eval-session' && p.spec.archive?.sha256 === sha256);
  }

  async lease(who: WorkerIdentity, max = 1): Promise<WorkTask[]> {
    if (this.closed || max < 1) return [];
    const family = evalFamilyOf(who.backend);
    if (!family) return [];
    this.asked.set(who.worker, { worker: who.worker, family, local: !who.remote, run: who.run ?? null, pool: who.pool ?? null, at: Date.now() });
    this.sweep();
    const now = Date.now();
    // a machine that could not serve a piece gets it again only when nothing else waits for it
    const open = this.pending.filter((x) => !x.done && x.lease === null && x.notBefore <= now && takes(who, family, x.spec));
    const machine = machineOf(who.worker);
    const p = open.find((x) => !x.failedBy.has(machine)) ?? open[0];
    if (!p) return [];
    const lease: EvalLease = {
      id: crypto.randomUUID(),
      token: p.spec.kind === 'eval-session' && p.spec.mcp ? `kes_${crypto.randomBytes(24).toString('base64url')}` : null,
      pending: p, who, issuedAt: now, expiresAt: now + this.leaseMs,
      deadline: now + p.spec.timeoutMs + DEADLINE_GRACE_MS,
      output: [], outputBytes: 0,
    };
    this.leases.set(lease.id, lease);
    p.lease = lease.id;
    this.log(`eval ${p.spec.kind === 'eval-call' ? 'call' : 'session'} ${p.spec.run} ${p.spec.label} → ${who.worker} (${evalBackend(p.spec.agent)})`);
    const base = {
      id: lease.id, label: `${p.spec.run} · ${p.spec.label}`.slice(0, 200), leaseExpiresAt: new Date(lease.expiresAt).toISOString(), run: p.spec.run, key: p.spec.key,
      agent: { ...p.spec.agent }, class: 'eval' as const, requires: { ...p.spec.agent }, pool: p.spec.pool, eligible: p.spec.eligible,
    };
    if (p.spec.kind === 'eval-call') {
      const task: EvalCallWorkTask = { ...base, kind: 'eval-call', prompt: p.spec.prompt, schema: p.spec.schema ?? null, timeoutMs: p.spec.timeoutMs };
      return [task];
    }
    const task: EvalSessionWorkTask = {
      ...base, kind: 'eval-session', sandbox: p.spec.sandbox, maxSteps: p.spec.maxSteps, timeoutMs: p.spec.timeoutMs, prompt: p.spec.prompt,
      archive: p.spec.archive ? { ...p.spec.archive } : null,
      mcp: p.spec.mcp && lease.token ? { token: lease.token, tools: [...p.spec.mcp.tools] } : null,
    };
    return [task];
  }

  /** What a presented session token opens, while its lease lives; null otherwise. */
  authorize(taskId: string, presented: string | null): EvalSessionBinding | null {
    if (!presented) return null;
    this.sweep();
    const lease = this.leases.get(taskId);
    if (!lease || !lease.token || lease.pending.done || lease.pending.lease !== lease.id) return null;
    if (!tokenMatches(presented, lease.token)) return null;
    const spec = lease.pending.spec;
    if (spec.kind !== 'eval-session' || !spec.mcp) return null;
    return { run: spec.run, label: spec.label, worker: lease.who.worker, mcp: { ...spec.mcp, tools: [...spec.mcp.tools] } };
  }

  /** Stdout a worker sent with a renewal, kept for the answer. */
  output(taskId: string, who: WorkerIdentity, text: string): boolean {
    const lease = this.leases.get(taskId);
    if (!lease || lease.who.worker !== who.worker || lease.pending.done || lease.pending.lease !== lease.id) return false;
    this.keep(lease, text);
    return true;
  }

  async complete(taskId: string, who: WorkerIdentity, outcome: TaskOutcome): Promise<CompleteResult & { failure?: 'transient' | 'fatal' }> {
    const lease = this.leases.get(taskId);
    if (!lease) return { accepted: false, reason: 'unknown or expired lease' };
    if (lease.who.worker !== who.worker) return { accepted: false, reason: 'the lease belongs to another worker' };
    this.leases.delete(taskId);
    const p = lease.pending;
    if (p.done) return { accepted: false, reason: 'the run no longer wants it' };
    if (p.lease !== lease.id) return { accepted: false, reason: 'it moved on' };
    p.lease = null;
    const now = Date.now();
    const backend = evalBackend(p.spec.agent);
    if (!outcome.ok) {
      // a worker that could not run the CLI at all, or whose account refused: back in line (D11)
      const kind = outcome.kind === 'transient' ? 'transient' : outcome.kind === 'fatal' || p.spec.kind === 'eval-session' ? 'fatal' : null;
      if (kind) {
        this.strike(p, kind, outcome.error || 'failed without a message', who.worker, now);
        return { accepted: true, failure: kind };
      }
      // the model's own failure on a call: the call's, as the run's own backend would throw it
      this.totals.answered++;
      p.settle({ outcome: 'error', worker: who.worker, backend, pool: who.pool ?? null, error: outcome.error || 'failed without a message', usage: outcome.usage ?? null });
      return { accepted: true };
    }
    if (outcome.model && outcome.model !== `${p.spec.agent.family}:${p.spec.agent.model}`) {
      // a worker that ran another model would mix backends silently
      this.strike(p, 'fatal', `${who.worker} ran ${outcome.model}, not ${p.spec.agent.family}:${p.spec.agent.model}`, who.worker, now);
      return { accepted: true, failure: 'fatal' };
    }
    if (p.spec.kind === 'eval-call') {
      this.totals.answered++;
      p.settle({ outcome: 'answered', worker: who.worker, backend, pool: who.pool ?? null, text: outcome.text, usage: outcome.usage ?? null, model: p.spec.agent.model });
      return { accepted: true };
    }
    const s: SessionAnswer = outcome.session ?? { exitCode: 0, output: outcome.text ?? '', stderr: '', lastMessage: null };
    this.keep(lease, s.output);
    const answer: EvalSessionAnswer = {
      exitCode: s.exitCode, stdout: lease.output.join(''), stderr: s.stderr, lastMessage: s.lastMessage,
      capped: s.capped === true, cwd: s.cwd ?? '', home: s.home ?? '',
    };
    const failure = evalSessionFailure(answer);
    if (failure) {
      this.strike(p, failure.kind, failure.message, who.worker, now);
      return { accepted: true, failure: failure.kind };
    }
    this.totals.answered++;
    p.settle({ outcome: 'answered', worker: who.worker, backend, pool: who.pool ?? null, text: answer.lastMessage ?? '', usage: outcome.usage ?? readCodexEvents(answer.stdout).usage, model: p.spec.agent.model, session: answer });
    return { accepted: true };
  }

  renew(taskIds: string[], who: WorkerIdentity): { renewed: string[]; lost: string[] } {
    this.sweep();
    const renewed: string[] = [];
    const lost: string[] = [];
    const now = Date.now();
    for (const id of taskIds) {
      const lease = this.leases.get(id);
      if (lease && !lease.pending.done && lease.pending.lease === id && lease.who.worker === who.worker && now < lease.deadline) {
        lease.expiresAt = now + this.leaseMs;
        renewed.push(id);
      } else lost.push(id);
    }
    return { renewed, lost };
  }

  /** A worker shutting down hands its pieces back: straight back in line, no strike. */
  async release(taskIds: string[], who: WorkerIdentity): Promise<number> {
    let n = 0;
    for (const id of taskIds) {
      const lease = this.leases.get(id);
      if (!lease || lease.who.worker !== who.worker) continue;
      this.leases.delete(id);
      if (lease.pending.lease === id) lease.pending.lease = null;
      n++;
    }
    return n;
  }

  async status(): Promise<EvalStatus> {
    this.sweep();
    const now = Date.now();
    return {
      waiting: this.pending.filter((p) => p.lease === null).length,
      leases: [...this.leases.values()].map((l) => ({
        id: l.id, kind: this.kind, class: 'eval' as const, pool: l.pending.spec.pool, workerPool: l.who.pool ?? null, worker: l.who.worker, backend: l.who.backend, remote: l.who.remote,
        run: l.pending.spec.run, label: l.pending.spec.label, model: evalBackend(l.pending.spec.agent),
        ageSeconds: Math.round((now - l.issuedAt) / 1000), expiresInSeconds: Math.round((l.expiresAt - now) / 1000),
      })),
      totals: { ...this.totals, failed: { ...this.totals.failed } },
    };
  }

  /** A workspace's broker stopping does not stop the server's eval work: `close` does, when `serve` stops. */
  async stop(): Promise<void> {}

  /** No new leases; every offer ends `stopped` and every token is dropped. */
  close(): void {
    this.closed = true;
    for (const p of [...this.pending]) p.settle({ outcome: 'stopped' });
    this.leases.clear();
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  /* ------------------------------ internals ------------------------------ */

  private keep(lease: EvalLease, text: string): void {
    if (!text || lease.outputBytes >= MAX_STDOUT_BYTES) return;
    lease.output.push(text);
    lease.outputBytes += Buffer.byteLength(text);
  }

  private strike(p: Pending, kind: 'transient' | 'fatal', error: string, worker: string, now: number): void {
    this.totals.failed[kind]++;
    p.strikes++;
    p.lastError = error;
    const machine = machineOf(worker);
    p.failedBy.set(machine, (p.failedBy.get(machine) ?? 0) + 1);
    this.log(`eval ${p.spec.run} ${p.spec.label}: ${worker} could not serve it (${kind}; ${p.strikes} failure(s) on ${p.failedBy.size} machine(s)): ${error.slice(0, 240)}`);
    if (this.isStuck(p)) {
      // left for the run to report, never answered another way
      this.totals.stuck++;
      p.settle({ outcome: 'stuck', workers: [...p.failedBy.keys()], lastError: error });
      return;
    }
    p.notBefore = now + this.retryMs;
  }

  /**
   * When a piece is stuck (docs/design/32 §3): three different machines could
   * not serve it; or every machine online that takes it has failed it three
   * times (two judge workers, one machine with ten slots); or it failed ten
   * times in all, however the machines online came and went.
   */
  private isStuck(p: Pending): boolean {
    if (p.failedBy.size >= this.maxStrikes) return true;
    if (p.strikes >= MAX_ATTEMPTS) return true;
    const able = new Set(this.slotsOnline()
      .filter((s) => takes({ worker: s.worker, backend: s.family, remote: !s.local, run: s.run ?? undefined, pool: s.pool ?? undefined }, s.family, p.spec))
      .map((s) => machineOf(s.worker)));
    return able.size > 0 && [...able].every((m) => (p.failedBy.get(m) ?? 0) >= this.maxStrikes);
  }

  /** Lapsed leases go back in line with a strike. */
  private sweep(): void {
    const now = Date.now();
    for (const lease of [...this.leases.values()]) {
      if (lease.expiresAt > now && lease.deadline > now) continue;
      this.leases.delete(lease.id);
      this.totals.leasesExpired++;
      const p = lease.pending;
      if (p.done || p.lease !== lease.id) continue;
      p.lease = null;
      // a run's own slot is the run's backend, not a worker: its lapse is no strike against the piece
      if (lease.who.run) continue;
      this.strike(p, 'transient', `${lease.who.worker} ${lease.deadline <= now ? 'outran its timeout' : 'stopped renewing its lease'}`, lease.who.worker, now);
    }
    if (this.pending.length === 0 && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }

  private startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), 500);
    this.sweeper.unref?.();
  }
}

/**
 * The archives eval sessions read (src/work/eval-archive.ts), kept by id in
 * `<data root>/.knode/eval-archives/`. A run uploads one before it offers the
 * session that needs it; a worker downloads it only while such a session is
 * offered or out. Archives no session has needed for a day are removed.
 */
export class EvalArchives {
  readonly dir: string;
  private readonly used = new Map<string, number>();

  constructor(rootDataDir: string, private readonly keepMs = 24 * 3_600_000) {
    this.dir = path.join(rootDataDir, '.knode', 'eval-archives');
  }

  file(sha256: string): string | null {
    if (!isArchiveId(sha256)) return null;
    const f = path.join(this.dir, `${sha256}.kpa`);
    return fs.existsSync(f) ? f : null;
  }

  touch(sha256: string): void {
    this.used.set(sha256, Date.now());
  }

  /** Store an upload, checked against its id; old ones go. */
  async put(sha256: string, gzip: Buffer, check: (gzip: Buffer, sha256: string) => unknown): Promise<void> {
    if (!isArchiveId(sha256)) throw new Error('an archive id is a SHA-256 in hex');
    check(gzip, sha256);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(this.dir, `.${sha256}.${process.pid}.${crypto.randomUUID()}.part`);
    fs.writeFileSync(tmp, gzip, { mode: 0o600 });
    fs.renameSync(tmp, path.join(this.dir, `${sha256}.kpa`));
    this.touch(sha256);
    this.prune();
  }

  prune(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    const now = Date.now();
    for (const name of names) {
      const f = path.join(this.dir, name);
      try {
        const sha = name.replace(/\.kpa$/, '');
        const last = Math.max(this.used.get(sha) ?? 0, fs.statSync(f).mtimeMs);
        if (now - last > this.keepMs) fs.rmSync(f, { force: true });
      } catch {
        // gone already
      }
    }
  }
}

/** `serve`'s evaluation work: one source per kind for every workspace's broker, and the archives. */
export class EvalWork {
  readonly calls: EvalSource;
  readonly sessions: EvalSource;
  readonly archives: EvalArchives;

  constructor(rootDataDir: string, opts: EvalSourceOptions & { sessionLeaseMs?: number } = {}) {
    this.calls = new EvalSource('eval-call', opts);
    this.sessions = new EvalSource('eval-session', { ...opts, leaseMs: opts.sessionLeaseMs ?? opts.leaseMs });
    this.archives = new EvalArchives(rootDataDir);
  }

  get sources(): EvalSource[] {
    return [this.calls, this.sessions];
  }

  source(kind: EvalKind): EvalSource {
    return kind === 'eval-call' ? this.calls : this.sessions;
  }

  close(): void {
    this.calls.close();
    this.sessions.close();
  }
}
