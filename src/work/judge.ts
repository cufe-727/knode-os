import crypto from 'node:crypto';
import { KnodeConfig } from '../config.js';
import { classifyFailure, FailureKind } from '../labeling/failures.js';
import { CompleteResult, TaskOutcome, WorkerIdentity } from '../labeling/scheduler.js';
import { renderCliPrompt } from '../llm/cli.js';
import { ChatMessage, jsonFromReply, LlmClient } from '../llm/client.js';
import { noFailures, SourceStatus, WorkSource, WorkTask } from './broker.js';

/**
 * The Judge stage's review calls (docs/design/11 §3.2).
 *
 * A review — the duplicate-entity and duplicate-claim audits — builds all its
 * judge prompts first and hands them to a `JudgeRunner` at once, then reads
 * the verdicts. Two runners:
 *
 *   - `directJudge` calls the Judge route itself, one call at a time: the
 *     nightly pass, the CLI and an initialization, which run whether or not
 *     `serve`'s slots do;
 *   - `JudgeSource` offers the calls as leased work through the work broker
 *     (src/work/broker.ts): `serve`'s own judge slots take them, several at a
 *     time (`review.concurrency`), and so do remote workers where the
 *     workspace offers them (`server.remote.offer.judge`). Each call waits at
 *     most `server.remote.callDeadlineMinutes`; one nobody answered fails, and
 *     the review treats it as it treats any failed call.
 *
 * Every answer says which model gave it, "remote:…" from another machine.
 * A remote verdict merges or rejects nothing by itself unless its model is in
 * `server.remote.judgeModels` (`verdictMayDecide`): the review files it as a
 * suggestion, with the verdict attached, for a person to decide.
 */

/** One call to the Judge stage: the prompt, and how long its answer may be. */
export interface JudgeCall {
  /** What it is about, for a worker's log: the pair, or the batch. */
  label: string;
  messages: ChatMessage[];
  maxTokens: number;
}

/** The answer to one call: the raw reply (a JSON object) and the model that gave it. */
export type JudgeAnswer = { ok: true; text: string; model: string } | { ok: false; error: string };

/** What a review hands its judge calls to. */
export interface JudgeRunner {
  /** Whether anyone may answer: without a judge, a review files its candidates unjudged. */
  readonly enabled: boolean;
  /** Every call's answer, in the order given. */
  run(calls: JudgeCall[]): Promise<JudgeAnswer[]>;
}

/** The Judge route called directly, `concurrency` calls at a time. */
export function directJudge(llm: LlmClient, concurrency = 1): JudgeRunner {
  return {
    get enabled() {
      return llm.enabled;
    },
    async run(calls) {
      const out = new Array<JudgeAnswer>(calls.length);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), calls.length) }, async () => {
        for (let i = next++; i < calls.length; i = next++) {
          try {
            out[i] = { ok: true, text: await llm.complete(calls[i].messages, { json: true, maxTokens: calls[i].maxTokens }), model: llm.label };
          } catch (err) {
            out[i] = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
      }));
      return out;
    },
  };
}

/**
 * Whether a verdict may merge or reject without a person: always one from
 * this machine, a remote one only when `server.remote.judgeModels` names its
 * model — exactly, or by a prefix ending in "*".
 */
export function verdictMayDecide(config: Pick<KnodeConfig, 'server'>, model: string): boolean {
  if (!model.startsWith('remote:')) return true;
  const label = model.slice('remote:'.length);
  return (config.server.remote?.judgeModels ?? []).some((entry) => {
    const pattern = String(entry).trim().replace(/^remote:/, '');
    if (!pattern) return false;
    return pattern.endsWith('*') ? label.startsWith(pattern.slice(0, -1)) : label === pattern;
  });
}

/* ------------------------------ the source ------------------------------ */

export interface JudgeSourceHooks {
  /** Whether a call can be answered now: this machine has judge slots, or a remote worker takes judge calls. */
  enabled: () => boolean;
  /** Longest a call waits for its answer, read on every run (default 20 min). */
  deadlineMs?: () => number;
  log?: (msg: string) => void;
}

export interface JudgeSourceOptions {
  /** How long a worker may hold a call before it goes back in line (renewable). */
  leaseMs?: number;
  /** Wait before a call goes out again after a bad answer (× its attempts so far). */
  modelRetryMs?: number;
  /** Wait before a call goes out again after a transient failure. */
  transientRetryMs?: number;
}

export interface JudgeStatus extends SourceStatus {
  /** Calls a review is waiting on that nobody holds right now. */
  waiting: number;
  leases: { id: string; worker: string; backend: string; remote: boolean; call: string; ageSeconds: number; expiresInSeconds: number }[];
  totals: { calls: number; ok: number; failed: Record<FailureKind, number>; leasesExpired: number; unanswered: number };
  lastHour: { calls: number };
}

interface PendingCall {
  call: JudgeCall;
  settle: (answer: JudgeAnswer) => void;
  done: boolean;
  /** The lease that holds it, if any. */
  lease: string | null;
  /** Bad answers so far. */
  attempts: number;
  /** Transient failures and lapsed leases since its last counted attempt. */
  strikes: number;
  notBefore: number;
  lastError: string;
}

interface JudgeLease {
  id: string;
  pending: PendingCall;
  who: WorkerIdentity;
  issuedAt: number;
  expiresAt: number;
  /** Kept a while after expiry so a late answer can still land when nobody else took the call. */
  expired: boolean;
}

const DEFAULT_LEASE_MS = 15 * 60_000;
const DEFAULT_DEADLINE_MS = 20 * 60_000;
const MODEL_RETRY_MS = 5_000;
const TRANSIENT_RETRY_MS = 15_000;
const EXPIRED_GRACE_MS = 10 * 60_000;
/** Bad answers to one call before it fails. */
const MAX_ATTEMPTS = 3;
/** Transient failures (or lapsed leases) of one call that count as one bad answer. */
const STRIKE_LIMIT = 5;

export class JudgeSource implements WorkSource, JudgeRunner {
  readonly kind = 'judge' as const;
  /** Calls a review waits on, oldest first. */
  private readonly pending: PendingCall[] = [];
  private readonly leases = new Map<string, JudgeLease>();
  private stopped = false;
  private readonly totals: JudgeStatus['totals'] = { calls: 0, ok: 0, failed: noFailures(), leasesExpired: 0, unanswered: 0 };
  private readonly recentCalls: number[] = [];
  private readonly leaseMs: number;
  private readonly modelRetryMs: number;
  private readonly transientRetryMs: number;
  private readonly log: (msg: string) => void;

  constructor(private readonly hooks: JudgeSourceHooks, opts: JudgeSourceOptions = {}) {
    this.leaseMs = Math.max(1_000, opts.leaseMs ?? DEFAULT_LEASE_MS);
    this.modelRetryMs = opts.modelRetryMs ?? MODEL_RETRY_MS;
    this.transientRetryMs = opts.transientRetryMs ?? TRANSIENT_RETRY_MS;
    this.log = hooks.log ?? (() => {});
  }

  get enabled(): boolean {
    return !this.stopped && this.hooks.enabled();
  }

  get leaseDurationMs(): number {
    return this.leaseMs;
  }

  holds(taskId: string): boolean {
    return this.leases.has(taskId);
  }

  /** Offer every call at once; each answer comes back in its place, a failure for one nobody answered in time. */
  run(calls: JudgeCall[]): Promise<JudgeAnswer[]> {
    if (this.stopped) return Promise.resolve(calls.map(() => ({ ok: false as const, error: 'the judge is stopped' })));
    const deadlineMs = Math.max(1_000, this.hooks.deadlineMs?.() ?? DEFAULT_DEADLINE_MS);
    const within = deadlineMs >= 60_000 ? `${Math.round(deadlineMs / 60_000)} min` : `${Math.round(deadlineMs / 1000)} s`;
    return Promise.all(calls.map((call) => new Promise<JudgeAnswer>((resolve) => {
      const p: PendingCall = { call, settle: () => {}, done: false, lease: null, attempts: 0, strikes: 0, notBefore: 0, lastError: '' };
      const timer = setTimeout(() => {
        if (p.done) return;
        this.totals.unanswered++;
        p.settle({ ok: false, error: `no answer within ${within}${p.lastError ? ` (last: ${p.lastError.slice(0, 200)})` : ''}` });
      }, deadlineMs);
      timer.unref?.();
      p.settle = (answer) => {
        if (p.done) return;
        p.done = true;
        clearTimeout(timer);
        const at = this.pending.indexOf(p);
        if (at !== -1) this.pending.splice(at, 1);
        resolve(answer);
      };
      this.pending.push(p);
    })));
  }

  /** Give up on the calls nobody holds yet (processing stopped): the review goes on with what it has. Calls held finish. */
  cancelWaiting(reason: string): number {
    const waiting = this.pending.filter((p) => p.lease === null);
    for (const p of waiting) p.settle({ ok: false, error: reason });
    if (waiting.length) this.log(`judge: ${waiting.length} waiting call(s) given up: ${reason}`);
    return waiting.length;
  }

  async lease(who: WorkerIdentity, max = 1): Promise<WorkTask[]> {
    if (this.stopped) return [];
    this.expireLeases();
    const want = Math.max(1, Math.min(8, Math.floor(max)));
    const now = Date.now();
    const out: WorkTask[] = [];
    for (const p of this.pending) {
      if (out.length >= want) break;
      if (p.done || p.lease !== null || p.notBefore > now) continue;
      const lease: JudgeLease = { id: crypto.randomUUID(), pending: p, who, issuedAt: now, expiresAt: now + this.leaseMs, expired: false };
      this.leases.set(lease.id, lease);
      p.lease = lease.id;
      out.push({
        id: lease.id,
        kind: 'judge',
        label: p.call.label,
        messages: p.call.messages,
        prompt: renderCliPrompt(p.call.messages, true),
        json: true,
        maxTokens: p.call.maxTokens,
        leaseExpiresAt: new Date(lease.expiresAt).toISOString(),
      });
    }
    return out;
  }

  /** Hand back a call's answer. A reply that is no JSON object is a bad answer, which another try may fix. */
  async complete(taskId: string, who: WorkerIdentity, outcome: TaskOutcome): Promise<CompleteResult> {
    const lease = this.leases.get(taskId);
    if (!lease) return { accepted: false, reason: 'unknown or long-expired lease' };
    if (lease.who.worker !== who.worker) return { accepted: false, reason: 'the lease belongs to another worker' };
    this.leases.delete(taskId);
    const p = lease.pending;
    if (p.done) return { accepted: false, reason: 'the review no longer waits for this call' };
    if (lease.expired ? p.lease !== null : p.lease !== lease.id) {
      return { accepted: false, reason: lease.expired ? 'lease expired and the call moved on' : 'call no longer leased to this worker' };
    }
    p.lease = null;
    const now = Date.now();
    this.totals.calls++;
    this.recentCalls.push(now);
    const model = who.remote ? `remote:${outcome.model || who.backend}` : outcome.model || who.backend;
    if (outcome.ok) {
      try {
        jsonFromReply(outcome.text);
        this.totals.ok++;
        p.settle({ ok: true, text: outcome.text, model });
        return { accepted: true };
      } catch (err) {
        this.fail(p, 'model', `unusable reply: ${err instanceof Error ? err.message : String(err)}`, who.worker, now);
        return { accepted: true };
      }
    }
    this.fail(p, outcome.kind ?? classifyFailure(outcome.error), outcome.error || 'failed without a message', who.worker, now);
    return { accepted: true };
  }

  renew(taskIds: string[], who: WorkerIdentity): { renewed: string[]; lost: string[] } {
    const renewed: string[] = [];
    const lost: string[] = [];
    const now = Date.now();
    for (const id of taskIds) {
      const lease = this.leases.get(id);
      if (lease && !lease.expired && !lease.pending.done && lease.who.worker === who.worker) {
        lease.expiresAt = now + this.leaseMs;
        renewed.push(id);
      } else {
        lost.push(id);
      }
    }
    return { renewed, lost };
  }

  /** Give leases back unanswered (a worker shutting down): the calls go straight back in line. */
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

  async status(): Promise<JudgeStatus> {
    const now = Date.now();
    while (this.recentCalls.length && this.recentCalls[0] < now - 3_600_000) this.recentCalls.shift();
    return {
      waiting: this.pending.filter((p) => p.lease === null).length,
      leases: [...this.leases.values()].filter((l) => !l.expired).map((l) => ({
        id: l.id, worker: l.who.worker, backend: l.who.backend, remote: l.who.remote, call: l.pending.call.label,
        ageSeconds: Math.round((now - l.issuedAt) / 1000), expiresInSeconds: Math.round((l.expiresAt - now) / 1000),
      })),
      totals: { ...this.totals, failed: { ...this.totals.failed } },
      lastHour: { calls: this.recentCalls.length },
    };
  }

  /** Stop: no new leases, and every review waiting on a call gets its failure at once. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const p of [...this.pending]) p.settle({ ok: false, error: 'the judge stopped' });
    this.leases.clear();
  }

  /* ------------------------------ internals ------------------------------ */

  /** A failed call: a bad answer uses an attempt, five busy or broken backends in a row count as one; three and it fails. */
  private fail(p: PendingCall, kind: FailureKind, error: string, worker: string, now: number): void {
    this.totals.failed[kind]++;
    p.lastError = error;
    const strikes = p.strikes + 1;
    if (kind === 'model' || strikes >= STRIKE_LIMIT) {
      p.attempts++;
      p.strikes = 0;
      if (p.attempts >= MAX_ATTEMPTS) {
        this.log(`judge: ${p.call.label} failed ${MAX_ATTEMPTS} times, last on ${worker}: ${error.slice(0, 240)}`);
        p.settle({ ok: false, error });
        return;
      }
      p.notBefore = now + this.modelRetryMs * p.attempts;
    } else {
      p.strikes = strikes;
      p.notBefore = now + this.transientRetryMs;
    }
    this.log(`judge: ${p.call.label} failed on ${worker} (${kind}): ${error.slice(0, 240)}`);
  }

  private expireLeases(): void {
    const now = Date.now();
    for (const lease of [...this.leases.values()]) {
      if (lease.expired) {
        if (now - lease.expiresAt > EXPIRED_GRACE_MS) this.leases.delete(lease.id);
        continue;
      }
      if (lease.expiresAt > now) continue;
      lease.expired = true;
      this.totals.leasesExpired++;
      const p = lease.pending;
      if (p.done || p.lease !== lease.id) continue;
      p.lease = null;
      this.fail(p, 'transient', `no answer from ${lease.who.worker} before its lease ran out`, lease.who.worker, now);
    }
  }
}
