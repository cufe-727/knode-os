import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { effortFor, renderCliPrompt, speedFor } from '../llm/cli.js';
import { jsonFromReply, LlmClient } from '../llm/client.js';
import type { ChatMessage } from '../llm/client.js';
import type { CallUsage } from '../llm/usage.js';
import { readCodexEvents } from '../llm/usage.js';
import { MCP_TOKEN_FILE } from '../server/mcp-http.js';
import crypto from 'node:crypto';
import type { WorkerIdentity } from '../labeling/scheduler.js';
import { WorkBroker } from '../work/broker.js';
import type { EvalAgent, WorkTask } from '../work/broker.js';
import { packFolder } from '../work/eval-archive.js';
import { EVAL_FAMILIES, EvalSource, machineOf } from '../work/eval.js';
import type { EvalCallSpec, EvalEligible, EvalFamily, EvalOutcome, EvalRunStatus, EvalSessionAnswer, EvalSessionSpec, EvalSlotSeen, EvalSourceOptions, EvalSpec } from '../work/eval.js';
import type { EvalKind } from '../work/kinds.js';
import type { AgentRunOptions, AgentRunResult } from './agent.js';
import { AgentTrace } from './agent.js';
import type { LoadedPack } from './pack.js';
import { currentPieceTag, notePlacement } from './placement.js';
import type { PieceTag } from './placement.js';
import type { QuotaGuard } from './quota.js';
import type { ChatBackend, ChatRequest, ChatResult } from './shim.js';

/**
 * An evaluation run's model work as published work (docs/design/32, on the
 * lease protocol of docs/design/27 §8).
 *
 * The run only publishes. Every model call of a system (the shim's backend,
 * `PublishedChatBackend`), every judge call (`remoteJudgeClient`) and every
 * agent session (`runAgent`, src/eval/agent.ts) becomes a piece in a queue,
 * and slots that lease from that queue do the work:
 *
 *   - the queue is `serve`'s broker when the run reaches it on this machine
 *     (`--remote`, over the loopback producer channel, src/remote/eval-producer.ts),
 *     and otherwise one the run starts in its own process (`RemoteEval.own`);
 *   - remote workers lease from `serve`'s like any other kind of work;
 *   - the run's own slots (`--local codex:6,claude:1`) lease from either like a
 *     worker, and run a piece with the run's own backends (its stand-ins,
 *     chains, connections and agent routing), found by the piece's key.
 *
 * A piece that may not leave this machine (a pack with a `private:` source,
 * a model the run does not name, a backend only the run has, a session that
 * writes) is published `eligible: local`: only a slot on this machine takes
 * it. With no slot for a piece, it waits.
 */

export type RemoteOutcome = EvalOutcome | { outcome: 'unreachable'; error: string };

/** A run's own slot as the queue knows it: its name, its CLI, its run, its pool. */
export interface LocalSlotIdentity {
  name: string;
  family: EvalFamily;
  run: string;
  pool: string;
}

export type LocalOutcome = { ok: true } | { ok: false; error: string };

interface QueueStatus {
  /** Whether `serve` offers eval work to remote workers at all. */
  offered: boolean;
  slots: Record<EvalKind, EvalSlotSeen[]>;
  run: EvalRunStatus;
}

/** Where a run publishes: `serve`'s broker or its own. One code path either way. */
export interface EvalQueue {
  readonly where: 'serve' | 'own';
  readonly origin: string | null;
  publish(spec: EvalSpec, signal: AbortSignal): Promise<RemoteOutcome>;
  status(run: string): Promise<QueueStatus>;
  /** The slots online now, where the queue can say without a request (the run's own broker). */
  slotsNow?(): Record<EvalKind, EvalSlotSeen[]>;
  /** A folder a worker's session reads: only `serve` hands archives to workers. */
  archive(dir: string, signal: AbortSignal): Promise<{ sha256: string; bytes: number } | null>;
  lease(who: LocalSlotIdentity, kinds: EvalKind[]): Promise<WorkTask[]>;
  complete(who: LocalSlotIdentity, id: string, outcome: LocalOutcome): Promise<void>;
  renew(who: LocalSlotIdentity, ids: string[]): Promise<void>;
  release(who: LocalSlotIdentity, ids: string[]): Promise<void>;
  cancelRun(run: string): Promise<void>;
  close(): void;
}

const localWho = (who: LocalSlotIdentity): WorkerIdentity => ({ worker: `local/${who.run}/${who.name}`, backend: who.family, remote: false, run: who.run, pool: who.pool });

/** The run's own broker, in its own process: no remote worker can reach it, the run's own slots lease from it. */
export class OwnQueue implements EvalQueue {
  readonly where = 'own' as const;
  readonly origin = null;
  readonly calls: EvalSource;
  readonly sessions: EvalSource;
  private readonly broker: WorkBroker;

  constructor(opts: EvalSourceOptions = {}) {
    this.calls = new EvalSource('eval-call', opts);
    this.sessions = new EvalSource('eval-session', opts);
    this.broker = new WorkBroker([this.calls, this.sessions]);
  }

  private source(kind: EvalKind): EvalSource {
    return kind === 'eval-call' ? this.calls : this.sessions;
  }

  publish(spec: EvalSpec, signal: AbortSignal): Promise<RemoteOutcome> {
    return this.source(spec.kind).offer(spec, { signal }).result;
  }

  slotsNow(): Record<EvalKind, EvalSlotSeen[]> {
    return { 'eval-call': this.calls.slotsOnline(), 'eval-session': this.sessions.slotsOnline() };
  }

  async status(run: string): Promise<QueueStatus> {
    const a = this.calls.runStatus(run);
    const b = this.sessions.runStatus(run);
    return {
      offered: false,
      slots: { 'eval-call': this.calls.slotsOnline(), 'eval-session': this.sessions.slotsOnline() },
      run: { waiting: a.waiting + b.waiting, leased: a.leased + b.leased },
    };
  }

  async archive(): Promise<null> {
    return null;
  }

  lease(who: LocalSlotIdentity, kinds: EvalKind[]): Promise<WorkTask[]> {
    return this.broker.lease(localWho(who), kinds, 1);
  }

  async complete(who: LocalSlotIdentity, id: string, outcome: LocalOutcome): Promise<void> {
    await this.broker.complete(id, localWho(who), outcome.ok ? { ok: true, text: '' } : { ok: false, error: outcome.error, kind: 'model' });
  }

  async renew(who: LocalSlotIdentity, ids: string[]): Promise<void> {
    this.broker.renew(ids, localWho(who));
  }

  async release(who: LocalSlotIdentity, ids: string[]): Promise<void> {
    await this.broker.release(ids, localWho(who));
  }

  async cancelRun(run: string): Promise<void> {
    this.calls.cancelRun(run);
    this.sessions.cancelRun(run);
  }

  close(): void {
    this.calls.close();
    this.sessions.close();
  }
}

/** `serve`'s broker, over the loopback producer channel and the data root's MCP token. */
export class ServeQueue implements EvalQueue {
  readonly where = 'serve' as const;

  constructor(private readonly serveUrl: string, private readonly token: string) {}

  get origin(): string {
    return this.serveUrl;
  }

  private headers(json = true): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...(json ? { 'content-type': 'application/json' } : {}) };
  }

  private async post<T>(route: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.serveUrl}/eval/v1/${route}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(30_000) });
    const text = (await res.text()).trim();
    const parsed = text ? JSON.parse(text) as T & { error?: string } : null;
    if (!parsed || (!res.ok && res.status !== 409)) throw new Error(`${route}: ${res.status} ${parsed?.error ?? text.slice(0, 200)}`);
    return parsed;
  }

  async publish(spec: EvalSpec, signal: AbortSignal): Promise<RemoteOutcome> {
    try {
      const res = await fetch(`${this.serveUrl}/eval/v1/offer`, {
        method: 'POST', headers: this.headers(), body: JSON.stringify({ spec }), signal,
      });
      const text = (await res.text()).trim();
      const body = text ? JSON.parse(text) as RemoteOutcome & { error?: string } : null;
      if (!res.ok || !body || !('outcome' in body)) throw new Error(`${res.status}: ${body?.error ?? text.slice(0, 200)}`);
      return body;
    } catch (err) {
      if (signal.aborted) return { outcome: 'cancelled' };
      return { outcome: 'unreachable', error: err instanceof Error ? err.message : String(err) };
    }
  }

  async status(run: string, first = false): Promise<QueueStatus> {
    const res = await fetch(`${this.serveUrl}/eval/v1/status?run=${encodeURIComponent(run)}`, { headers: this.headers(false), signal: AbortSignal.timeout(first ? 5_000 : 10_000) });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = await res.json() as Partial<QueueStatus>;
    return { offered: Boolean(body.offered), slots: { 'eval-call': body.slots?.['eval-call'] ?? [], 'eval-session': body.slots?.['eval-session'] ?? [] }, run: body.run ?? { waiting: 0, leased: 0 } };
  }

  /** Packed, and uploaded unless `serve` holds it already: a folder every question reads goes up once. */
  async archive(dir: string, signal: AbortSignal): Promise<{ sha256: string; bytes: number }> {
    const packed = packFolder(dir);
    const head = await fetch(`${this.serveUrl}/eval/v1/archives/${packed.sha256}`, { method: 'HEAD', headers: this.headers(false), signal });
    if (head.ok) return { sha256: packed.sha256, bytes: packed.bytes };
    const res = await fetch(`${this.serveUrl}/eval/v1/archives/${packed.sha256}`, {
      method: 'PUT', headers: { ...this.headers(false), 'content-type': 'application/gzip' }, body: packed.gzip(), signal,
    });
    if (!res.ok) throw new Error(`archive upload refused: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return { sha256: packed.sha256, bytes: packed.bytes };
  }

  async lease(who: LocalSlotIdentity, kinds: EvalKind[]): Promise<WorkTask[]> {
    const r = await this.post<{ tasks?: WorkTask[] }>('slots/lease', { worker: who.name, family: who.family, run: who.run, pool: who.pool, kinds });
    return r.tasks ?? [];
  }

  async complete(who: LocalSlotIdentity, id: string, outcome: LocalOutcome): Promise<void> {
    await this.post('slots/complete', { worker: who.name, family: who.family, run: who.run, pool: who.pool, id, ...(outcome.ok ? { ok: true, text: '' } : { ok: false, error: outcome.error, kind: 'model' }) });
  }

  async renew(who: LocalSlotIdentity, ids: string[]): Promise<void> {
    await this.post('slots/renew', { worker: who.name, family: who.family, run: who.run, pool: who.pool, ids });
  }

  async release(who: LocalSlotIdentity, ids: string[]): Promise<void> {
    await this.post('slots/release', { worker: who.name, family: who.family, run: who.run, pool: who.pool, ids });
  }

  async cancelRun(run: string): Promise<void> {
    await fetch(`${this.serveUrl}/eval/v1/runs/${encodeURIComponent(run)}/cancel`, { method: 'POST', headers: this.headers(false), signal: AbortSignal.timeout(5_000) }).catch(() => {});
  }

  close(): void {}
}

export interface RemoteEvalOptions {
  /** The run's id: pieces carry it, and cancelling the run withdraws them. */
  run: string;
  /** The run's quota guard: a run's own Codex slot waits for this machine's plan before it runs a piece. */
  quota?: QuotaGuard | null;
  /** How often the slots online are read again from `serve` (default 15 s). */
  refreshMs?: number;
  /** How often a run's own slot renews the lease of a piece it runs (default 20 s). */
  renewMs?: number;
  /**
   * The pool every piece of the run requires (`eval run --pool`, docs/design/32
   * §2); the run's own slots are in it too. Absent: pieces take any slot that
   * meets them, and the run's own slots are pool `local`.
   */
  pool?: string | null;
  /**
   * How long a piece may wait while no slot online meets its requirements
   * before the run stops (default 30; 0: no limit). Fractions are minutes too.
   */
  waitMinutes?: number;
  /** How often waiting is checked (default 5 s) and logged (default once a minute). */
  checkMs?: number;
  logEveryMs?: number;
  /** The wait limit passed: the run stops, cleanly. */
  onStop?: (why: WaitLimitError) => void;
  /** A piece three different workers could not serve (for the run's events). */
  onStuck?: (piece: StuckPiece) => void;
  log?: (msg: string) => void;
}

/** What a waiting piece requires, as the run's wait and its log say it. */
interface Requirement {
  kind: EvalKind;
  family: EvalFamily;
  model: string;
  eligible: EvalEligible;
  pool: string | null;
}

const requirementKey = (r: Requirement) => `${r.kind}|${r.family}|${r.model}|${r.eligible}|${r.pool ?? ''}`;

/** A requirement in words: what a run waits for. */
export function describeRequirement(r: Pick<Requirement, 'family' | 'model' | 'eligible' | 'pool'> & { kind?: EvalKind }): string {
  const what = r.kind === 'eval-session' ? 'an agent session' : r.kind === 'eval-call' ? 'a model call' : 'work';
  return `${what} on ${r.family}${r.model ? ` ${r.model}` : ''} in ${r.pool ? `pool ${r.pool}` : 'any pool'}${r.eligible === 'local' ? ", on this machine's slots only" : ''}`;
}

/** A piece three different workers could not serve, as the run reports it. */
export interface StuckPiece {
  kind: EvalKind;
  label: string;
  family: EvalFamily;
  model: string;
  eligible: EvalEligible;
  pool: string | null;
  /** The system and task it was for (a build's: no task; the judge's: `__judge__`). */
  system: string | null;
  task: string | null;
  workers: string[];
  lastError: string;
  at: string;
}

/** A piece left unanswered because three different workers could not serve it: the answer or build it was for is not recorded. */
export class PieceStuckError extends Error {
  constructor(readonly piece: StuckPiece) {
    super(`stuck: ${piece.workers.length} workers could not serve ${piece.label} (${piece.workers.join(', ')}): ${piece.lastError.slice(0, 300)}`);
  }
}

/** The run waited `--wait-minutes` for a slot that meets a piece's requirements, and stopped. */
export class WaitLimitError extends Error {
  /** The run directory to resume (set by the run). */
  runDir?: string;

  constructor(readonly requirement: Requirement, readonly minutes: number) {
    super(`waited ${minutes} min for a slot that takes ${describeRequirement(requirement)}, and none came online: the run stopped, with nothing recorded for the pieces still waiting — start a worker (or pass --local) and resume with --run-dir`);
  }
}

/** Whether a pack's work may leave this machine: none of its sources is private. */
export function packMayLeave(pack: Pick<LoadedPack, 'manifest'>): boolean {
  return !pack.manifest.sources.some((s) => s.license.trim().toLowerCase().startsWith('private:'));
}

/** `serve`'s origin and token for this machine's data root (`--serve-url` overrides the origin). */
export function localServe(dataRoot: string, serveUrl?: string): { serveUrl: string; token: string } {
  const tokenFile = path.join(dataRoot, MCP_TOKEN_FILE);
  if (!fs.existsSync(tokenFile)) throw new Error(`--remote: no ${MCP_TOKEN_FILE} under ${dataRoot} — start \`knode-os serve\` once, or pass --data`);
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  if (serveUrl) return { serveUrl: serveUrl.replace(/\/+$/, ''), token };
  const config = loadConfig(dataRoot);
  const host = !config.server.host || config.server.host === '0.0.0.0' || config.server.host === '::' ? '127.0.0.1' : config.server.host;
  return { serveUrl: `http://${host}:${config.server.port}`, token };
}

export { machineOf };

/** What a piece came back as: run by one of the run's own slots (its value or what it threw), or by a worker. */
export type Published<T> =
  | { local: true; value: T }
  | { local: true; error: unknown }
  | { local: false; outcome: Extract<EvalOutcome, { outcome: 'answered' | 'error' }> };

interface Entry {
  exec: () => Promise<unknown>;
  done?: { value: unknown } | { error: unknown };
}

const randomKey = () => crypto.randomBytes(9).toString('base64url');
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(t);
    resolve();
  }, { once: true });
});

/** The kinds a run's own slot of a CLI takes: agent sessions run on Codex only. */
const LOCAL_KINDS: Record<EvalFamily, EvalKind[]> = { codex: ['eval-call', 'eval-session'], claude: ['eval-call'] };

export class RemoteEval {
  private status: QueueStatus | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly abort = new AbortController();
  private readonly log: (msg: string) => void;
  private cancelling: Promise<void> | null = null;
  private closed = false;
  private readonly entries = new Map<string, Entry>();
  private readonly local: Record<EvalFamily, number> = { codex: 0, claude: 0 };
  private readonly loops: Promise<void>[] = [];
  private wake: (() => void) | null = null;
  private wakeAt: Promise<void> | null = null;
  private unreachableSaid = false;
  private readonly outstanding = new Map<string, { requirement: Requirement; n: number }>();
  private readonly unmetSince = new Map<string, number>();
  private waitTimer: NodeJS.Timeout | null = null;
  private lastWaitLog = 0;
  /** Set when the wait limit stopped the run. */
  stopped: WaitLimitError | null = null;
  /** Pieces three different workers could not serve, in the order they stuck. */
  readonly stuck: StuckPiece[] = [];
  /** Pieces published, and who served them, for the run's log. */
  readonly counts = { published: 0, workers: 0, local: 0 };

  private constructor(readonly queue: EvalQueue, private readonly opts: RemoteEvalOptions) {
    this.log = opts.log ?? (() => {});
    this.waitTimer = setInterval(() => this.checkWaiting(), Math.max(50, opts.checkMs ?? 5_000));
    this.waitTimer.unref?.();
  }

  /** The wait limit, in minutes (0: none). */
  get waitMinutes(): number {
    const n = Number(this.opts.waitMinutes ?? 30);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** `serve`'s broker on this machine; null (and a log line) when it is not answering. */
  static async connect(opts: RemoteEvalOptions & { serveUrl: string; token: string }): Promise<RemoteEval | null> {
    const queue = new ServeQueue(opts.serveUrl, opts.token);
    const r = new RemoteEval(queue, opts);
    try {
      r.status = await queue.status(opts.run, true);
    } catch (err) {
      r.log(`remote: ${opts.serveUrl} is not answering (${err instanceof Error ? err.message : err})`);
      return null;
    }
    if (!r.status.offered) r.log('remote: serve does not offer evaluation work to remote workers (server.remote.offer.eval is off): only this run\'s own slots will take its pieces');
    r.timer = setInterval(() => void r.refresh(), Math.max(200, opts.refreshMs ?? 15_000));
    r.timer.unref?.();
    return r;
  }

  /** A broker in the run's own process: only the run's own slots lease from it. */
  static own(opts: RemoteEvalOptions & { source?: EvalSourceOptions }): RemoteEval {
    const r = new RemoteEval(new OwnQueue({ retryMs: 1_000, ...opts.source }), opts);
    r.timer = setInterval(() => void r.refresh(), Math.max(200, Math.min(opts.refreshMs ?? 1_000, 1_000)));
    r.timer.unref?.();
    void r.refresh();
    return r;
  }

  get run(): string {
    return this.opts.run;
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  get where(): 'serve' | 'own' {
    return this.queue.where;
  }

  /** The run's own slots, by CLI. */
  get localSlots(): Record<EvalFamily, number> {
    return { ...this.local };
  }

  hasLocal(family: EvalFamily): boolean {
    return this.local[family] > 0;
  }

  /**
   * Slots online that could take a piece of this kind, CLI and eligibility
   * from this run: the run's own (always), and the ones `serve` saw ask lately.
   */
  width(kind: EvalKind, family: EvalFamily, eligible: EvalEligible): number {
    if (this.abort.signal.aborted) return 0;
    const own = LOCAL_KINDS[family].includes(kind) ? this.local[family] : 0;
    const slots = this.queue.slotsNow?.() ?? this.status?.slots;
    const pool = this.pool;
    const others = (slots?.[kind] ?? []).filter((s) => s.family === family && !s.run && (!pool || s.pool === pool) && (eligible === 'any' || s.local));
    return own + others.length;
  }

  /** The pool every piece of the run requires, or null. */
  get pool(): string | null {
    return this.opts.pool || null;
  }

  /** The pool the run's own slots are in. */
  get localPool(): string {
    return this.opts.pool || 'local';
  }

  /** Start the run's own slots: they lease from the queue like a worker's, and run a piece with the run's backends. */
  startLocal(slots: Partial<Record<EvalFamily, number>>): void {
    for (const family of EVAL_FAMILIES) {
      const n = Math.max(0, Math.trunc(slots[family] ?? 0));
      for (let i = 1; i <= n; i++) {
        this.local[family]++;
        this.loops.push(this.slot({ name: `eval-${family}#${this.local[family]}`, family, run: this.run, pool: this.localPool }));
      }
    }
  }

  /**
   * Publish one piece and wait for what becomes of it. `exec` is how the
   * run's own slot does it; a worker does it from the spec.
   */
  async publish<T>(spec: Omit<EvalCallSpec, 'run' | 'key' | 'pool'> | Omit<EvalSessionSpec, 'run' | 'key' | 'pool'>, exec: () => Promise<T>, tag: PieceTag | null = currentPieceTag()): Promise<Published<T>> {
    if (this.abort.signal.aborted) throw new RunCancelledError();
    const key = randomKey();
    const entry: Entry = { exec };
    this.entries.set(key, entry);
    this.counts.published++;
    const full = { ...spec, run: this.opts.run, key, pool: this.pool } as EvalSpec;
    const requirement: Requirement = { kind: spec.kind, family: spec.agent.family, model: spec.agent.model, eligible: spec.eligible, pool: this.pool };
    const rk = requirementKey(requirement);
    const held = this.outstanding.get(rk) ?? { requirement, n: 0 };
    held.n++;
    this.outstanding.set(rk, held);
    try {
      for (let backoff = 1_000; ;) {
        this.poke();
        const o = await this.queue.publish(full, this.abort.signal);
        if (entry.done) {
          // one of the run's own slots did it (perhaps before serve went away): its result is the piece's
          this.counts.local++;
          return 'error' in entry.done ? { local: true, error: entry.done.error } : { local: true, value: entry.done.value as T };
        }
        if (o.outcome === 'answered' || o.outcome === 'error') {
          this.counts.workers++;
          // records name the machine, not the slot on it: `<token>/<worker>`
          return { local: false, outcome: { ...o, worker: machineOf(o.worker) } };
        }
        if (o.outcome === 'cancelled' || o.outcome === 'stopped' || this.abort.signal.aborted) throw new RunCancelledError();
        if (o.outcome === 'unreachable') {
          // serve went away: the piece waits for it as it would for a slot, and is published again
          if (!this.unreachableSaid) this.log(`remote: publishing to serve failed (${o.error}): pieces wait and are published again when it answers`);
          this.unreachableSaid = true;
          await sleep(backoff, this.abort.signal);
          backoff = Math.min(15_000, backoff * 2);
          continue;
        }
        this.unreachableSaid = false;
        // three different workers could not serve it: reported, left unanswered, and the run goes on with the rest
        const piece: StuckPiece = {
          kind: spec.kind, label: spec.label, family: spec.agent.family, model: spec.agent.model, eligible: spec.eligible, pool: this.pool,
          system: tag?.system ?? null, task: tag?.task ?? null, workers: o.workers, lastError: o.lastError, at: new Date().toISOString(),
        };
        this.stuck.push(piece);
        const error = new PieceStuckError(piece);
        this.log(error.message);
        this.opts.onStuck?.(piece);
        throw error;
      }
    } finally {
      this.entries.delete(key);
      if (--held.n <= 0) {
        this.outstanding.delete(rk);
        this.unmetSince.delete(rk);
      }
    }
  }

  /** Pieces stuck since `since` (an index into `stuck`) for this system (and task, when given). */
  stuckFor(since: number, system: string, task?: string): StuckPiece[] {
    return this.stuck.slice(since).filter((p) => p.system === system && (task === undefined || p.task === task));
  }

  /** The run's own slots finish what they are doing (at most `ms`). */
  async drained(ms = 10_000): Promise<void> {
    await Promise.race([Promise.allSettled(this.loops), sleep(ms)]);
  }

  /** A folder a worker's session reads, as an archive `serve` holds; null on the run's own broker. */
  archive(dir: string): Promise<{ sha256: string; bytes: number } | null> {
    return this.queue.archive(dir, this.abort.signal);
  }

  /**
   * The run is cancelled: what is published or out is withdrawn, and session tokens die at once. Every call
   * waits for the one withdrawal, so a run that ends on its cancellation ends after the tokens are revoked.
   */
  cancel(): Promise<void> {
    this.cancelling ??= (async () => {
      this.abort.abort();
      await this.queue.cancelRun(this.opts.run).catch(() => {});
      this.close();
    })();
    return this.cancelling;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.waitTimer) clearInterval(this.waitTimer);
    this.waitTimer = null;
    this.poke();
    this.queue.close();
  }

  /* ------------------------------ internals ------------------------------ */

  private async refresh(): Promise<void> {
    try {
      this.status = await this.queue.status(this.opts.run);
    } catch {
      // serve is not answering: nothing is known to be online but the run's own slots
      if (this.status) this.status = { ...this.status, slots: { 'eval-call': [], 'eval-session': [] } };
    }
  }

  /**
   * Waiting (docs/design/32 §3): a piece whose requirements no slot online
   * meets is logged once a minute with what it waits for; past the wait limit
   * the run stops cleanly. A piece some slot online could take waits for it
   * however long, as any work behind a busy slot does.
   */
  private checkWaiting(): void {
    if (this.abort.signal.aborted || !this.outstanding.size) return;
    const now = Date.now();
    const unmet: { requirement: Requirement; n: number; since: number }[] = [];
    for (const [rk, { requirement, n }] of this.outstanding) {
      if (this.width(requirement.kind, requirement.family, requirement.eligible) > 0) {
        this.unmetSince.delete(rk);
        continue;
      }
      const since = this.unmetSince.get(rk) ?? now;
      this.unmetSince.set(rk, since);
      unmet.push({ requirement, n, since });
    }
    if (unmet.length && now - this.lastWaitLog >= (this.opts.logEveryMs ?? 60_000)) {
      this.lastWaitLog = now;
      const limit = this.waitMinutes ? `; the run stops after ${this.waitMinutes} min` : '';
      for (const u of unmet) this.log(`waiting: ${u.n} piece(s) for ${describeRequirement(u.requirement)} — no slot online takes them (for ${Math.round((now - u.since) / 60_000)} min${limit})`);
    }
    const limitMs = this.waitMinutes * 60_000;
    const over = limitMs ? unmet.find((u) => now - u.since >= limitMs) : undefined;
    if (!over) return;
    this.stopped = new WaitLimitError(over.requirement, this.waitMinutes);
    this.log(this.stopped.message);
    this.opts.onStop?.(this.stopped);
    void this.cancel();
  }

  /** Wake the run's own slots: a piece was published. */
  private poke(): void {
    this.wake?.();
    this.wake = null;
    this.wakeAt = null;
  }

  private idle(ms: number): Promise<void> {
    this.wakeAt ??= new Promise<void>((resolve) => (this.wake = resolve));
    return Promise.race([this.wakeAt, sleep(ms)]);
  }

  /** One of the run's own slots: lease, find the piece's work by its key, do it, hand back. */
  private async slot(who: LocalSlotIdentity): Promise<void> {
    const kinds = LOCAL_KINDS[who.family];
    while (!this.closed) {
      let task: WorkTask | undefined;
      try {
        task = (await this.queue.lease(who, kinds))[0];
      } catch {
        await this.idle(2_000);
        continue;
      }
      if (!task) {
        await this.idle(this.queue.where === 'own' ? 1_000 : 500);
        continue;
      }
      const key = 'key' in task ? task.key : '';
      const entry = this.entries.get(key);
      if (!entry) {
        // not one of this run's pieces any more (it settled meanwhile)
        await this.queue.release(who, [task.id]).catch(() => {});
        continue;
      }
      const renew = setInterval(() => void this.queue.renew(who, [task!.id]).catch(() => {}), Math.max(200, this.opts.renewMs ?? 20_000));
      renew.unref?.();
      try {
        if (!entry.done) {
          // this machine's plan: a Codex piece run here waits for it, as the run did before it ran anything here
          if (who.family === 'codex') await this.opts.quota?.waitLocal({ cacheMs: 60_000 });
          try {
            entry.done = { value: await entry.exec() };
          } catch (error) {
            entry.done = { error };
          }
        }
        if (this.abort.signal.aborted) continue;
        const done = entry.done;
        const outcome: LocalOutcome = 'error' in done && task.kind === 'eval-call'
          ? { ok: false, error: done.error instanceof Error ? done.error.message : String(done.error) }
          : { ok: true };
        await this.queue.complete(who, task.id, outcome).catch(() => {});
      } finally {
        clearInterval(renew);
      }
    }
  }
}

/** A pack's placement, carried along its async calls (src/eval/placement.ts): the queue, and whether its work may leave. */
export class PackScope {
  constructor(readonly remote: RemoteEval, readonly leaves: boolean, readonly calls: EvalEligible) {}

  /** Slots online for a build's or a system's model calls: what a knode build's passes may fill. */
  callSlots(): number {
    return this.remote.width('eval-call', 'codex', this.calls);
  }

  sessionSlots(eligible: EvalEligible): number {
    return this.remote.width('eval-session', 'codex', eligible);
  }
}

/** Every call of this piece of work stopped because the run was cancelled. */
export class RunCancelledError extends Error {
  constructor() {
    super('the run was cancelled');
  }
}

/**
 * The shim's backend as published work: every model call is a piece, done by
 * a slot that leases it — the run's own (with `local`, the run's backend) or,
 * when the run names its model on its own Codex, a worker running exactly that
 * model, so the records stay on one backend (`codex-cli:<model>`).
 */
export class PublishedChatBackend implements ChatBackend {
  readonly selfLimiting = true;

  constructor(
    private readonly local: ChatBackend,
    private readonly remote: RemoteEval,
    private readonly agent: { model: string; speed?: string | null; eligible: EvalEligible },
  ) {}

  get label(): string {
    return this.local.label;
  }

  async complete(req: ChatRequest): Promise<ChatResult> {
    const tag = req.tag;
    const leaves = this.agent.eligible === 'any';
    const p = await this.remote.publish({
      kind: 'eval-call',
      eligible: this.agent.eligible,
      label: tag ? [tag.system, tag.stage, tag.task].filter(Boolean).join(' · ') : 'call',
      agent: { family: 'codex', model: this.agent.model, effort: effortFor('codex-cli', req.effort) ?? null, speed: this.agent.speed ?? null },
      // a piece only the run's own slots take carries nothing a worker would run
      prompt: leaves ? renderCliPrompt(req.messages, req.json) : '',
      schema: leaves ? req.schema ?? null : null,
      timeoutMs: 900_000,
    }, () => this.local.complete(req), tag ? { system: tag.system, ...(tag.task ? { task: tag.task } : {}) } : null);
    if (p.local) {
      if ('error' in p) throw p.error;
      return p.value;
    }
    const o = p.outcome;
    if (o.outcome === 'answered') return { text: o.text.trim(), usage: o.usage, model: o.model, worker: o.worker, backend: o.backend, ...(o.pool ? { pool: o.pool } : {}) };
    throw Object.assign(new Error(`codex exec failed on ${o.worker}: ${o.error}`), { usage: o.usage });
  }
}

/**
 * The judge's client as published work: its calls go to a slot of the judge's
 * CLI. Who answered is noted for the judge's meter (src/eval/placement.ts).
 */
export function remoteJudgeClient(client: LlmClient, remote: RemoteEval, judge: { family: EvalFamily; model: string; effort: string | null; eligible: EvalEligible; backend: string | null }): LlmClient {
  const publish = async <T>(messages: ChatMessage[], opts: { json?: boolean; onUsage?: (u: CallUsage) => void }, here: () => Promise<T>, fromText: (text: string) => T): Promise<T> => {
    const leaves = judge.eligible === 'any';
    const p = await remote.publish({
      kind: 'eval-call', eligible: judge.eligible, label: 'judge', agent: { family: judge.family, model: judge.model, effort: judge.effort, speed: null },
      prompt: leaves ? renderCliPrompt(messages, Boolean(opts.json)) : '', schema: null, timeoutMs: 600_000,
    }, here, { system: '__judge__' });
    if (p.local) {
      if (judge.backend) notePlacement({ backend: judge.backend });
      if ('error' in p) throw p.error;
      return p.value;
    }
    const o = p.outcome;
    if (o.usage) opts.onUsage?.(o.usage);
    notePlacement({ worker: o.worker, backend: o.backend, ...(o.pool ? { pool: o.pool } : {}) });
    if (o.outcome === 'answered') return fromText(o.text);
    throw new Error(`${judge.family} CLI error on ${o.worker}: ${o.error}`);
  };
  const wrapped = Object.create(client) as LlmClient;
  // a real client's completeJson goes through complete; a stand-in that has only completeJson is published as it is
  if (typeof client.complete === 'function') {
    wrapped.complete = (messages, opts = {}) => publish(messages, opts, () => client.complete(messages, opts), (t) => t.trim());
  }
  if (typeof client.completeJson === 'function' && client.completeJson !== LlmClient.prototype.completeJson) {
    wrapped.completeJson = (<T>(messages: ChatMessage[], opts: Parameters<LlmClient['completeJson']>[1] = {}) =>
      publish<T>(messages, { ...opts, json: true }, () => client.completeJson<T>(messages, opts), (t) => jsonFromReply<T>(t))) as LlmClient['completeJson'];
  }
  return wrapped;
}

/** The CLI family a judge provider runs on, for its pieces' requirements: a chain or a stand-in is the run's own (Claude's slots). */
export function judgeFamily(provider: string): EvalFamily {
  return provider === 'codex-cli' ? 'codex' : 'claude';
}

/** The judge's family and model as a remote worker would run them, or null when its calls stay here. */
export function judgeAgent(provider: string, model: string, effort?: string): { family: EvalFamily; model: string; effort: string | null } | null {
  const family: EvalFamily | null = provider === 'claude-cli' ? 'claude' : provider === 'codex-cli' ? 'codex' : null;
  if (!family || !model.trim()) return null;
  return { family, model: model.trim(), effort: effortFor(provider, effort as never) ?? null };
}

/* ------------------------------ agent sessions ----------------------------- */

/**
 * One `runAgent` session as a published piece. It may go to a worker only
 * when its pack may leave, the run names its model, it reads (a session that
 * writes, the llm-wiki build, stays), its knode tools are the build's tool
 * host (a URL with its tools named) and it is not routed over an agent chain
 * (`leaves` false: those links are this machine's keys and logins); otherwise
 * it is published for this machine's slots only. `here` is how the run's own
 * slot runs it.
 */
export async function publishAgent(scope: PackScope, opts: AgentRunOptions, here: () => Promise<AgentRunResult>, leaves: boolean): Promise<AgentRunResult> {
  const remote = scope.remote;
  const toolsLeave = !opts.mcp || ('url' in opts.mcp && Boolean(opts.mcp.enabledTools?.length));
  const eligible: EvalEligible = leaves && scope.leaves && opts.sandbox === 'read-only' && Boolean(opts.model) && toolsLeave ? 'any' : 'local';
  const t0 = Date.now();
  let archive: { sha256: string; bytes: number } | null = null;
  let mcp: EvalSessionSpec['mcp'] = null;
  if (eligible === 'any') {
    const hasFiles = fs.existsSync(opts.cwd) && fs.readdirSync(opts.cwd).length > 0;
    archive = hasFiles ? await remote.archive(opts.cwd) : null;
    mcp = opts.mcp && 'url' in opts.mcp ? { url: opts.mcp.url, secret: opts.mcp.token, tools: [...(opts.mcp.enabledTools ?? [])] } : null;
  }
  const p = await remote.publish({
    kind: 'eval-session',
    eligible,
    label: `agent${opts.label ? ` · ${opts.label}` : ''}`,
    agent: { family: 'codex', model: opts.model ?? '', effort: effortFor('codex-cli', opts.effort) ?? null, speed: null },
    sandbox: opts.sandbox,
    maxSteps: opts.maxSteps ?? 25,
    timeoutMs: opts.timeoutMs ?? 15 * 60_000,
    prompt: eligible === 'any' ? opts.prompt : '',
    archive,
    mcp,
  }, here);
  if (p.local) {
    if ('error' in p) throw p.error;
    return p.value;
  }
  const o = p.outcome;
  if (o.outcome !== 'answered' || !o.session) throw new Error(`the session failed on ${o.worker}: ${o.outcome === 'error' ? o.error : 'no session came back'}`);
  return { ...agentResultOf(o.session, opts, { worker: o.worker, backend: o.backend, usage: o.usage, ms: Date.now() - t0 }), ...(o.pool ? { pool: o.pool } : {}) };
}

/** A worker's session parsed as `runAgentOnce` parses its own: the trace, the step cap, the leak audit (with the worker's folder and home). */
export function agentResultOf(s: EvalSessionAnswer, opts: AgentRunOptions, at: { worker: string; backend: string; usage: CallUsage | null; ms: number }): AgentRunResult {
  // the worker's folder stands for this one: its paths are read as the local copy's, everything else as the worker's home
  const rewrite = s.cwd ? (cmd: string) => cmd.split(s.cwd).join(opts.cwd) : (cmd: string) => cmd;
  const trace = new AgentTrace({ cwd: opts.cwd, maxSteps: opts.maxSteps ?? 25, allowRoots: opts.allowRoots, home: s.home || os.homedir(), rewrite });
  for (const line of s.stdout.split('\n')) trace.line(line);
  const capped = trace.capped || s.capped;
  const text = (s.lastMessage ?? '').trim();
  // a worker's session that ended on a signal (no exit code: -1; or 128 + the signal) with nothing to show: cancelled, asked again on resume
  const killed = !capped && !text && (s.exitCode === -1 || s.exitCode === 130 || s.exitCode === 137 || s.exitCode === 143);
  const error = killed ? `cancelled: the session on ${at.worker} was killed (exit ${s.exitCode})`
    : s.exitCode !== 0 && !capped ? `codex exec exited with ${s.exitCode} on ${at.worker}: ${readCodexEvents(s.stdout).error ?? s.stderr.slice(-300)}` : undefined;
  return {
    text,
    usage: at.usage ?? readCodexEvents(s.stdout).usage,
    commands: trace.commands,
    toolCalls: trace.steps,
    capped,
    leaked: [...new Set(trace.leaked)],
    filesTouched: [...trace.touched],
    ms: at.ms,
    worker: at.worker,
    backend: at.backend,
    ...(error && !text ? { error } : {}),
    ...(killed ? { cancelled: true } : {}),
  };
}

export type { EvalAgent };
