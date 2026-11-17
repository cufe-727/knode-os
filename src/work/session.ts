import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FailureKind } from '../labeling/failures.js';
import { CompleteResult, SessionAnswer, TaskOutcome, WorkerIdentity } from '../labeling/scheduler.js';
import { noFailures, SessionWorkTask, SourceStatus, WorkSource, WorkTask } from './broker.js';
import { tokenMatches } from '../digest.js';

/**
 * Research agent sessions as leased work (docs/design/27).
 *
 * A research job stays in `serve`; only its sessions — the multi-turn CLI
 * runs `launchSession` starts — may go to a remote worker that runs them on
 * its own Codex or Claude account. The research side (src/research/remote.ts)
 * offers a session here and waits for its outcome, as a review waits for its
 * judge calls (src/work/judge.ts). A remote slot that takes the session's CLI
 * leases it, gets a token of the session's own, and runs the CLI against
 * `/remote/v1/w/<owner>/<workspace>/sessions/<id>/mcp`. While it runs, each
 * renewal brings the stdout since the last, which goes into the run folder's
 * transcript, so the live activity view works as for a session run here; the
 * answer brings the rest, the exit code and stderr's tail.
 *
 * A worker that could not serve the session — its usage or rate limit, a lost
 * login, a missing CLI, a lease that lapsed — puts it back in line, the job's
 * attempt untouched (D11); `strikes` counts those, and the research side stops
 * waiting for workers after three in a row. Whether an answer is such a
 * failure is the research side's to say (`classify`), since only it parses a
 * CLI's output.
 *
 * Leases are short (120 s) and renewed every 30 s, so a cancelled session
 * stops within half a minute; cancelling also drops the session's token at
 * once, so the agent's next tool call is refused before the worker hears.
 */

export type SessionFamily = 'codex' | 'claude';
export const SESSION_FAMILIES: readonly SessionFamily[] = ['codex', 'claude'];

/** What a worker needs to run one session: the fields it builds the command from (D9). */
export interface SessionSpec {
  job: string;
  /** The phase label: agent, plan, research-2, collect-3 … */
  label: string;
  /** For logs and Tasks: what the job is about. */
  title: string;
  family: SessionFamily;
  /** '' = the CLI's own default on the worker. */
  model: string;
  /** In the CLI's own terms (effortFor / speedFor), null = leave the CLI's setting. */
  effort: string | null;
  speed: string | null;
  maxTurns: number;
  timeoutMs: number;
  tools: 'read' | 'write';
  web: boolean;
  webFreshness: string | null;
  schema: string;
  prompt: string;
}

/** What the session's MCP route lets the agent do (D6, §4). */
export interface SessionBinding {
  job: string;
  label: string;
  tools: 'read' | 'write';
  /** The only paths knode_write takes: the job's output page and its companions. */
  writePaths: string[];
  /** The only workset knode_commit takes. */
  workset: string;
  /** The worker holding the lease, for the audit log. */
  worker: string;
}

/** Where a session's output lands on this machine. */
export interface SessionFiles {
  transcriptPath: string;
  stderrPath: string;
}

export type SessionOutcome =
  | { kind: 'answered'; answer: SessionAnswer; worker: string; backend: string }
  | { kind: 'withdrawn' }
  | { kind: 'cancelled' }
  | { kind: 'stopped' };

/** A worker could not serve the session (its account, its CLI): back in line, and that backend rests. */
export interface SessionFailure {
  kind: 'transient' | 'fatal';
  message: string;
}

/** An offered session, as the research side sees it while it waits. */
export interface SessionOffer {
  readonly id: string;
  readonly result: Promise<SessionOutcome>;
  /** A worker holds it now. */
  readonly leased: boolean;
  /** Worker failures (and lapsed leases) in a row. */
  readonly strikes: number;
  readonly lastError: string;
  /** Take it back while nobody holds it (to run it here, or to give up): false when a worker holds it. */
  withdraw(): boolean;
  /** Stop it wherever it is: the worker's next renewal is refused and its token dropped now. */
  cancel(): void;
}

export interface SessionSourceOptions {
  /** How long a lease lasts before it lapses unless renewed (default 120 s). */
  leaseMs?: number;
  /** Wait before a session goes out again after a worker failed it (default 15 s). */
  retryMs?: number;
  /** What a session's answer says about the worker: null when it is a result, however poor. */
  classify?: (spec: SessionSpec, answer: SessionAnswer, transcript: string) => SessionFailure | null;
  log?: (msg: string) => void;
}

export interface SessionStatus extends SourceStatus {
  /** Sessions offered that no worker holds now. */
  waiting: number;
  leases: { id: string; worker: string; backend: string; remote: boolean; job: string; label: string; title: string; ageSeconds: number; expiresInSeconds: number }[];
  totals: { sessions: number; answered: number; failed: Record<FailureKind, number>; leasesExpired: number };
}

interface Pending {
  id: string;
  spec: SessionSpec;
  writePaths: string[];
  workset: string;
  files: SessionFiles;
  settle: (outcome: SessionOutcome) => void;
  done: boolean;
  lease: string | null;
  strikes: number;
  lastError: string;
  notBefore: number;
}

interface SessionLease {
  id: string;
  token: string;
  pending: Pending;
  who: WorkerIdentity;
  issuedAt: number;
  expiresAt: number;
  /** Past this the session has outrun its own timeout: no renewal, and it lapses. */
  deadline: number;
}

const DEFAULT_LEASE_MS = 120_000;
const RETRY_MS = 15_000;
/** Beyond the session's own timeout, how long a worker may still be finishing it. */
const DEADLINE_GRACE_MS = 5 * 60_000;
/** One renewal's output, and a whole transcript, at most. */
const MAX_CHUNK_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

/** The CLI family a worker's backend names ("codex", "codex:gpt-…"). */
export function familyOf(backend: string): SessionFamily | null {
  const family = backend.split(':')[0].trim().toLowerCase();
  return (SESSION_FAMILIES as readonly string[]).includes(family) ? (family as SessionFamily) : null;
}

export class SessionSource implements WorkSource {
  readonly kind = 'session' as const;
  private readonly pending: Pending[] = [];
  private readonly leases = new Map<string, SessionLease>();
  /** When a slot of each CLI last asked for a session. */
  private readonly asked = new Map<SessionFamily, number>();
  private readonly transcriptBytes = new Map<string, number>();
  private stopped = false;
  private readonly totals: SessionStatus['totals'] = { sessions: 0, answered: 0, failed: noFailures(), leasesExpired: 0 };
  private readonly leaseMs: number;
  private readonly retryMs: number;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: SessionSourceOptions = {}) {
    this.leaseMs = Math.max(1_000, opts.leaseMs ?? DEFAULT_LEASE_MS);
    this.retryMs = opts.retryMs ?? RETRY_MS;
    this.log = opts.log ?? (() => {});
  }

  get leaseDurationMs(): number {
    return this.leaseMs;
  }

  /** Whether a remote slot that takes this CLI asked for a session within `withinMs` (default two minutes). */
  online(family: SessionFamily, withinMs = 2 * 60_000): boolean {
    return Date.now() - (this.asked.get(family) ?? 0) < withinMs;
  }

  holds(taskId: string): boolean {
    return this.leases.has(taskId);
  }

  /** Offer a session to the workers; the research side waits on the returned offer. */
  offer(spec: SessionSpec, binding: { writePaths: string[]; workset: string }, files: SessionFiles): SessionOffer {
    const id = `s_${crypto.randomBytes(6).toString('hex')}`;
    let settle: (outcome: SessionOutcome) => void = () => {};
    const result = new Promise<SessionOutcome>((resolve) => (settle = resolve));
    const p: Pending = {
      id, spec, writePaths: binding.writePaths, workset: binding.workset, files,
      settle: () => {}, done: false, lease: null, strikes: 0, lastError: '', notBefore: 0,
    };
    p.settle = (outcome) => {
      if (p.done) return;
      p.done = true;
      const at = this.pending.indexOf(p);
      if (at !== -1) this.pending.splice(at, 1);
      if (p.lease) this.leases.delete(p.lease);
      p.lease = null;
      settle(outcome);
    };
    if (this.stopped) p.settle({ kind: 'stopped' });
    else this.pending.push(p);
    const source = this;
    return {
      id,
      result,
      get leased() {
        source.expireLeases();
        return p.lease !== null;
      },
      get strikes() {
        return p.strikes;
      },
      get lastError() {
        return p.lastError;
      },
      withdraw() {
        source.expireLeases();
        if (p.done) return true;
        if (p.lease !== null) return false;
        p.settle({ kind: 'withdrawn' });
        return true;
      },
      cancel() {
        p.settle({ kind: 'cancelled' });
      },
    };
  }

  async lease(who: WorkerIdentity, max = 1): Promise<WorkTask[]> {
    if (this.stopped || max < 1) return [];
    const family = familyOf(who.backend);
    if (!family) return [];
    this.asked.set(family, Date.now());
    this.expireLeases();
    const now = Date.now();
    const p = this.pending.find((x) => !x.done && x.lease === null && x.notBefore <= now && x.spec.family === family);
    if (!p) return [];
    const lease: SessionLease = {
      id: crypto.randomUUID(),
      token: `kms_${crypto.randomBytes(24).toString('base64url')}`,
      pending: p, who, issuedAt: now, expiresAt: now + this.leaseMs,
      deadline: now + p.spec.timeoutMs + DEADLINE_GRACE_MS,
    };
    this.leases.set(lease.id, lease);
    p.lease = lease.id;
    this.totals.sessions++;
    // a session that goes out again starts its transcript anew, as a local run does
    this.startTranscript(p);
    this.log(`session ${p.spec.job} ${p.spec.label} → ${who.worker} (${p.spec.family}${p.spec.model ? ` ${p.spec.model}` : ''})`);
    const task: SessionWorkTask = {
      id: lease.id,
      kind: 'session',
      label: `${p.spec.job} ${p.spec.label} · ${p.spec.title}`.slice(0, 200),
      leaseExpiresAt: new Date(lease.expiresAt).toISOString(),
      job: p.spec.job,
      agent: { family: p.spec.family, model: p.spec.model, effort: p.spec.effort, speed: p.spec.speed },
      maxTurns: p.spec.maxTurns,
      timeoutMs: p.spec.timeoutMs,
      tools: p.spec.tools,
      web: p.spec.web,
      webFreshness: p.spec.webFreshness,
      schema: p.spec.schema,
      prompt: p.spec.prompt,
      mcpToken: lease.token,
    };
    return [task];
  }

  /** The session a presented token opens, while its lease lives (the MCP route, §4); null otherwise. */
  authorize(taskId: string, presented: string | null): SessionBinding | null {
    if (!presented) return null;
    this.expireLeases();
    const lease = this.leases.get(taskId);
    if (!lease || lease.pending.done || lease.pending.lease !== lease.id) return null;
    if (!tokenMatches(presented, lease.token)) return null;
    const p = lease.pending;
    return { job: p.spec.job, label: p.spec.label, tools: p.spec.tools, writePaths: [...p.writePaths], workset: p.workset, worker: lease.who.worker };
  }

  /** Stdout a worker sent with a renewal: appended to the session's transcript. */
  output(taskId: string, who: WorkerIdentity, text: string): boolean {
    const lease = this.leases.get(taskId);
    if (!lease || lease.who.worker !== who.worker || lease.pending.done || lease.pending.lease !== lease.id) return false;
    this.appendTranscript(lease.pending, text);
    return true;
  }

  async complete(taskId: string, who: WorkerIdentity, outcome: TaskOutcome): Promise<CompleteResult & { failure?: SessionFailure['kind'] }> {
    const lease = this.leases.get(taskId);
    if (!lease) return { accepted: false, reason: 'unknown or expired lease' };
    if (lease.who.worker !== who.worker) return { accepted: false, reason: 'the lease belongs to another worker' };
    this.leases.delete(taskId);
    const p = lease.pending;
    if (p.done) return { accepted: false, reason: 'the session is no longer wanted' };
    if (p.lease !== lease.id) return { accepted: false, reason: 'the session moved on' };
    p.lease = null;
    const now = Date.now();
    if (!outcome.ok) {
      const kind: SessionFailure['kind'] = outcome.kind === 'fatal' ? 'fatal' : 'transient';
      this.strike(p, kind, outcome.error || 'failed without a message', who.worker, now);
      return { accepted: true, failure: kind };
    }
    const answer: SessionAnswer = outcome.session ?? { exitCode: 0, output: outcome.text ?? '', stderr: '', lastMessage: null };
    this.appendTranscript(p, answer.output);
    this.writeStderr(p, answer.stderr);
    const transcript = this.readTranscript(p);
    const failure = this.opts.classify?.(p.spec, answer, transcript) ?? null;
    if (failure) {
      this.strike(p, failure.kind, failure.message, who.worker, now);
      return { accepted: true, failure: failure.kind };
    }
    this.totals.answered++;
    this.log(`session ${p.spec.job} ${p.spec.label} answered by ${who.worker} (exit ${answer.exitCode})`);
    p.settle({ kind: 'answered', answer, worker: who.worker, backend: who.backend });
    return { accepted: true };
  }

  renew(taskIds: string[], who: WorkerIdentity): { renewed: string[]; lost: string[] } {
    this.expireLeases();
    const renewed: string[] = [];
    const lost: string[] = [];
    const now = Date.now();
    for (const id of taskIds) {
      const lease = this.leases.get(id);
      if (lease && !lease.pending.done && lease.pending.lease === id && lease.who.worker === who.worker && now < lease.deadline) {
        lease.expiresAt = now + this.leaseMs;
        renewed.push(id);
      } else {
        lost.push(id);
      }
    }
    return { renewed, lost };
  }

  /** A worker shutting down hands its sessions back: they go straight back in line, no strike. */
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

  async status(): Promise<SessionStatus> {
    this.expireLeases();
    const now = Date.now();
    return {
      waiting: this.pending.filter((p) => p.lease === null).length,
      leases: [...this.leases.values()].map((l) => ({
        id: l.id, worker: l.who.worker, backend: l.who.backend, remote: l.who.remote,
        job: l.pending.spec.job, label: l.pending.spec.label, title: l.pending.spec.title,
        ageSeconds: Math.round((now - l.issuedAt) / 1000), expiresInSeconds: Math.round((l.expiresAt - now) / 1000),
      })),
      totals: { ...this.totals, failed: { ...this.totals.failed } },
    };
  }

  /** Stop: no new leases; every session waiting here ends `stopped`, and every token is dropped. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const p of [...this.pending]) p.settle({ kind: 'stopped' });
    this.leases.clear();
  }

  /* ------------------------------ internals ------------------------------ */

  /** A worker could not serve it: back in line after a short wait, the job's attempt untouched (D11). */
  private strike(p: Pending, kind: FailureKind, error: string, worker: string, now: number): void {
    this.totals.failed[kind]++;
    p.strikes++;
    p.lastError = error;
    p.notBefore = now + this.retryMs;
    this.log(`session ${p.spec.job} ${p.spec.label}: ${worker} could not serve it (${kind}, ${p.strikes} in a row): ${error.slice(0, 240)}`);
  }

  private expireLeases(): void {
    const now = Date.now();
    for (const lease of [...this.leases.values()]) {
      if (lease.expiresAt > now && lease.deadline > now) continue;
      this.leases.delete(lease.id);
      this.totals.leasesExpired++;
      const p = lease.pending;
      if (p.done || p.lease !== lease.id) continue;
      p.lease = null;
      const why = lease.deadline <= now ? 'outran its timeout' : 'stopped renewing its lease';
      this.strike(p, 'transient', `${lease.who.worker} ${why}`, lease.who.worker, now);
    }
  }

  private startTranscript(p: Pending): void {
    try {
      fs.mkdirSync(path.dirname(p.files.transcriptPath), { recursive: true });
      fs.writeFileSync(p.files.transcriptPath, '');
      this.transcriptBytes.set(p.id, 0);
    } catch (err) {
      this.log(`session ${p.spec.job} ${p.spec.label}: transcript not writable: ${err instanceof Error ? err.message : err}`);
    }
  }

  private appendTranscript(p: Pending, text: string): void {
    if (!text) return;
    const written = this.transcriptBytes.get(p.id) ?? 0;
    if (written >= MAX_TRANSCRIPT_BYTES) return;
    let chunk = text;
    if (Buffer.byteLength(chunk) > MAX_CHUNK_BYTES) {
      // the start of a long chunk is dropped, never its end: a claude run's result line comes last
      chunk = `${JSON.stringify({ type: 'system', subtype: 'gap', note: 'output dropped: more than 256 KB in one renewal' })}\n${Buffer.from(chunk).subarray(-MAX_CHUNK_BYTES).toString('utf8').replace(/^[^\n]*\n/, '')}`;
    }
    try {
      fs.appendFileSync(p.files.transcriptPath, chunk);
      this.transcriptBytes.set(p.id, written + Buffer.byteLength(chunk));
    } catch {
      // the transcript is a record, not the result: a session goes on without it
    }
  }

  private writeStderr(p: Pending, stderr: string): void {
    try {
      fs.writeFileSync(p.files.stderrPath, Buffer.from(stderr ?? '').subarray(-MAX_STDERR_BYTES));
    } catch {
      // as above
    }
  }

  private readTranscript(p: Pending): string {
    try {
      return fs.readFileSync(p.files.transcriptPath, 'utf8');
    } catch {
      return '';
    }
  }
}
