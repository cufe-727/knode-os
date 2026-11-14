import { CodexAccount, readCodexAccount } from '../estimate/codex.js';
import { isRefusal } from '../estimate/ledger.js';
import type { LlmClient } from '../llm/client.js';

/**
 * Keeps a long benchmark run inside the person's plans (docs/design/23 §4).
 *
 * Before each batch the runner asks `wait()`: Codex's five-hour and weekly
 * windows are read through `codex app-server` (no model call), and while
 * either is above its threshold — or a limit is already reached — the run
 * sleeps until the window resets, then goes on where it stopped. The judge
 * (Claude) has no such reading, so a refused call pauses it instead.
 */

export interface QuotaPolicy {
  /** Highest five-hour window use, in percent, at which a batch may still start. */
  fiveHourMax: number;
  /** Highest weekly window use, in percent. */
  weeklyMax: number;
  /** How long to sleep between readings while paused. */
  pollMs: number;
  /** Give up waiting after this long (default: never). */
  maxWaitMs: number;
}

export const DEFAULT_QUOTA: QuotaPolicy = { fiveHourMax: 92, weeklyMax: 90, pollMs: 5 * 60_000, maxWaitMs: Infinity };

export interface QuotaGuardOptions {
  policy?: Partial<QuotaPolicy>;
  read?: () => Promise<CodexAccount>;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string, detail?: Record<string, unknown>) => void;
  /** Off: never read or wait (tests, and runs on a backend with no plan window). */
  enabled?: boolean;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class QuotaGuard {
  readonly policy: QuotaPolicy;
  private readonly read: () => Promise<CodexAccount>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string, detail?: Record<string, unknown>) => void;
  private readonly enabled: boolean;
  /** Total time spent paused, for the report. */
  pausedMs = 0;
  /**
   * While this says so, `wait()` lets a batch start whatever this machine's
   * plan says: its work goes to remote workers on their own accounts
   * (docs/design/27 §8), and a piece that falls back here waits in
   * `waitLocal()` first.
   */
  private bypass: (() => boolean) | null = null;
  private lastReading: { at: number; account: CodexAccount } | null = null;

  constructor(opts: QuotaGuardOptions = {}) {
    this.policy = { ...DEFAULT_QUOTA, ...opts.policy };
    this.read = opts.read ?? (() => readCodexAccount());
    this.sleep = opts.sleep ?? realSleep;
    this.log = opts.log ?? (() => {});
    this.enabled = opts.enabled ?? true;
  }

  /** Why a batch may not start now, or null when it may. */
  blocked(account: CodexAccount): string | null {
    if (account.limitReached) return `codex limit reached: ${account.limitReached}`;
    for (const w of account.windows) {
      const max = w.minutes <= 300 ? this.policy.fiveHourMax : this.policy.weeklyMax;
      if (w.usedPercent >= max) return `codex ${w.minutes <= 300 ? 'five-hour' : 'weekly'} window at ${w.usedPercent}% (limit ${max}%)`;
    }
    return null;
  }

  /** The soonest reset among the windows that block, as a delay. */
  private untilReset(account: CodexAccount): number {
    const resets = account.windows.map((w) => (w.resetsAt ? Date.parse(w.resetsAt) - Date.now() : NaN)).filter((n) => Number.isFinite(n) && n > 0);
    return resets.length ? Math.min(...resets) + 30_000 : this.policy.pollMs;
  }

  setBypass(bypass: (() => boolean) | null): void {
    this.bypass = bypass;
  }

  async wait(): Promise<void> {
    if (!this.enabled || this.bypass?.()) return;
    return this.waitLocal();
  }

  /** Wait for this machine's plan, whatever remote workers there are; `cacheMs` reuses a reading that recent. */
  async waitLocal(opts: { cacheMs?: number } = {}): Promise<void> {
    if (!this.enabled) return;
    const started = Date.now();
    for (let first = true; ; first = false) {
      let account: CodexAccount;
      try {
        const cached = first && opts.cacheMs && this.lastReading && Date.now() - this.lastReading.at < opts.cacheMs ? this.lastReading.account : null;
        account = cached ?? await this.read();
        this.lastReading = { at: Date.now(), account };
      } catch (err) {
        // a failed reading must not stop the run; the next call will tell if the limit is real
        this.log('quota reading failed', { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const why = this.blocked(account);
      if (!why) return;
      if (Date.now() - started > this.policy.maxWaitMs) throw new Error(`quota guard gave up after ${Math.round((Date.now() - started) / 60_000)} min: ${why}`);
      const delay = Math.min(this.untilReset(account), this.policy.pollMs * 6);
      this.log('paused for quota', { why, sleepMs: delay });
      const t0 = Date.now();
      await this.sleep(delay);
      this.pausedMs += Date.now() - t0;
    }
  }

  /**
   * Run a call that may be refused for a rate or usage limit (the judge's
   * Claude CLI): on a refusal, sleep and try again, up to `tries` times.
   */
  async retryRefused<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // a piece the run left stuck, or a run that stopped, is final whatever its message quotes (docs/design/32 §3)
        if ((err as { final?: boolean } | null)?.final) throw err;
        if (!isRefusal(msg) || i + 1 >= tries) throw err;
        this.log('judge refused, pausing', { error: msg.slice(0, 200) });
        const t0 = Date.now();
        await this.sleep(this.policy.pollMs);
        this.pausedMs += Date.now() - t0;
      }
    }
  }
}

/**
 * Keeps a run's embeddings inside a daily budget on a shared pool (docs/design/23 §4).
 *
 * The bge-m3 pool serves the live service too, and its free accounts reset
 * at 00:00 UTC. The budget counts the run's embedding tokens per UTC day (from
 * the meter, so a restart keeps the day's count). Over the budget — or when
 * the pool itself turns a call down — an embedding is refused at once, and a
 * pack that was cut short waits in `wait()` until the budget opens again.
 */
export class EmbeddingBudget {
  /** Refusals so far, by the budget or the pool: a pack compares it before and after to tell it was cut short. */
  refusals = 0;
  private closedUntil = 0;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly opts: { dailyTokens?: number; usedToday: (day: string) => number; sleep?: (ms: number) => Promise<void>; now?: () => number; log?: (msg: string, detail?: Record<string, unknown>) => void }) {
    this.sleep = opts.sleep ?? realSleep;
    this.now = opts.now ?? Date.now;
  }

  /** Why `tokens` more may not be embedded now, or null when they may. */
  check(tokens: number): string | null {
    if (this.now() < this.closedUntil) return `embedding budget closed until ${new Date(this.closedUntil).toISOString()}`;
    const cap = this.opts.dailyTokens ?? Infinity;
    const used = this.opts.usedToday(utcDay(this.now()));
    return used + tokens > cap ? `embedding daily budget reached (${used} of ${cap} tokens today, UTC)` : null;
  }

  /** Turn an embedding down: the budget stays closed until the next UTC day. */
  refuse(why: string): Error {
    this.refusals++;
    this.closedUntil = Math.max(this.closedUntil, nextUtcDay(this.now()));
    return new Error(why);
  }

  /** The pool turned a call down: a spent daily quota closes the budget until the next UTC day, anything else for ten minutes. */
  poolRefused(message: string): void {
    this.refusals++;
    this.closedUntil = Math.max(this.closedUntil, /daily quota/i.test(message) ? nextUtcDay(this.now()) : this.now() + 10 * 60_000);
  }

  /** Sleep until the budget opens again. */
  async wait(): Promise<void> {
    while (this.now() < this.closedUntil) {
      this.opts.log?.('paused for embedding budget', { until: new Date(this.closedUntil).toISOString() });
      await this.sleep(this.closedUntil - this.now());
    }
  }
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Five minutes past the next 00:00 UTC, when the pool's daily quotas have reset. */
const nextUtcDay = (ms: number) => Date.parse(`${utcDay(ms)}T00:00:00Z`) + 86_400_000 + 5 * 60_000;

/**
 * A client whose calls wait out a refused call (a plan's rate or usage
 * limit) instead of failing — for the pack author and anything else that
 * talks to a plan-limited CLI for hours.
 */
export function withRefusalRetry(client: LlmClient, guard: QuotaGuard, tries = 72): LlmClient {
  const complete = client.complete.bind(client);
  const completeJson = client.completeJson.bind(client);
  return Object.assign(Object.create(client) as LlmClient, {
    complete: (messages: Parameters<LlmClient['complete']>[0], opts?: Parameters<LlmClient['complete']>[1]) => guard.retryRefused(() => complete(messages, opts), tries),
    completeJson: <T>(messages: Parameters<LlmClient['completeJson']>[0], opts?: Parameters<LlmClient['completeJson']>[1]) => guard.retryRefused(() => completeJson<T>(messages, opts), tries),
  });
}
