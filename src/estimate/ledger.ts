import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CallUsage } from '../llm/usage.js';

/**
 * What this workspace's model calls have cost so far — the measured side of
 * an estimate (docs/design/18).
 *
 * The work broker records every answered lease here (src/work/broker.ts):
 * which kind of work, on which route — the backend's label,
 * `codex-cli:gpt-6.1-sol` for this machine's slots, `codex:gpt-6.1-sol` for a
 * remote worker's — how long it took from lease to answer, how big the
 * prompt and the reply were, and what the provider said the call used when
 * it said anything. An estimate reads it back as per-call averages and
 * percentiles, which replace its defaults route by route as calls come in.
 *
 * Kept per workspace in `.knode/usage.json` and written a few seconds after a
 * change. Losing it loses only the averages: an estimate goes back to its
 * defaults and learns again.
 */

export interface MeasuredTotals {
  /** Calls whose provider reported usage, and the estimate of their prompts (to learn what the provider adds). */
  calls: number;
  promptTokens: number;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  /** What providers priced the calls at themselves (Claude Code), over the calls that did. */
  costUsd: number;
  costCalls: number;
}

export interface RouteStats {
  kind: string;
  route: string;
  remote: boolean;
  calls: number;
  ok: number;
  failed: number;
  /** Failures that were the service turning the call away — a rate or usage limit — and the latest. */
  refused: number;
  lastRefusal: { at: string; error: string } | null;
  /** Answered calls: their summed duration, and the latest durations for percentiles. */
  msSum: number;
  ms: number[];
  /** Estimated tokens (src/llm/tokens.ts) of what answered calls sent and got back. */
  promptTokens: number;
  replyTokens: number;
  measured: MeasuredTotals;
  /** Bodies the backend sent and received itself (an HTTP endpoint), over the calls that counted them. */
  bytes: { calls: number; up: number; down: number };
  firstAt: string;
  lastAt: string;
}

export interface CallSample {
  kind: string;
  route: string;
  remote: boolean;
  ok: boolean;
  ms: number;
  promptTokens: number;
  replyTokens: number;
  usage?: CallUsage | null;
  /** The service said no: a rate or usage limit (src/labeling/failures.ts calls it transient). */
  refused?: boolean;
  error?: string;
  at?: number;
}

interface LedgerFile {
  version: 1;
  routes: Record<string, RouteStats>;
}

/** Durations kept per route for percentiles. */
const MS_SAMPLES = 200;
/** A refusal is a rate or usage limit, not a network blip: what an estimate warns about. */
const REFUSAL = /rate.?limit|usage limit|out of usage|quota|too many requests|\b429\b|limit reached|credits/i;

export function isRefusal(error: string): boolean {
  return REFUSAL.test(error);
}

const keyOf = (kind: string, route: string) => `${kind}\u0000${route}`;

function emptyStats(kind: string, route: string, remote: boolean, at: string): RouteStats {
  return {
    kind, route, remote, calls: 0, ok: 0, failed: 0, refused: 0, lastRefusal: null, msSum: 0, ms: [],
    promptTokens: 0, replyTokens: 0,
    measured: { calls: 0, promptTokens: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0, costCalls: 0 },
    bytes: { calls: 0, up: 0, down: 0 },
    firstAt: at, lastAt: at,
  };
}

export function usageLedgerPath(dataDir: string): string {
  return path.join(dataDir, '.knode', 'usage.json');
}

export class CallLedger {
  private routes = new Map<string, RouteStats>();
  private timer: NodeJS.Timeout | null = null;
  private loaded = false;

  constructor(readonly file: string, private readonly opts: { flushMs?: number; log?: (msg: string) => void } = {}) {}

  static forWorkspace(dataDir: string, opts: { flushMs?: number; log?: (msg: string) => void } = {}): CallLedger {
    return new CallLedger(usageLedgerPath(dataDir), opts);
  }

  record(sample: CallSample): void {
    this.load();
    const at = new Date(sample.at ?? Date.now()).toISOString();
    const key = keyOf(sample.kind, sample.route);
    const s = this.routes.get(key) ?? emptyStats(sample.kind, sample.route, sample.remote, at);
    this.routes.set(key, s);
    s.calls++;
    s.lastAt = at;
    s.remote = sample.remote;
    if (sample.ok) {
      s.ok++;
      const ms = Math.max(0, Math.round(sample.ms));
      s.msSum += ms;
      s.ms.push(ms);
      if (s.ms.length > MS_SAMPLES) s.ms.splice(0, s.ms.length - MS_SAMPLES);
      s.promptTokens += sample.promptTokens;
      s.replyTokens += sample.replyTokens;
    } else {
      s.failed++;
      if (sample.refused ?? (sample.error !== undefined && isRefusal(sample.error))) {
        s.refused++;
        s.lastRefusal = { at, error: (sample.error ?? 'refused').slice(0, 300) };
      }
    }
    // a failed call's usage counts too — the provider charged for it — but only
    // an answered one says how big a prompt was against what the provider read
    const u = sample.usage;
    if (u && sample.ok) {
      const m = s.measured;
      m.calls++;
      m.promptTokens += sample.promptTokens;
      m.input += u.inputTokens;
      m.cached += u.cachedInputTokens;
      m.cacheWrite += u.cacheWriteTokens;
      m.output += u.outputTokens;
      m.reasoning += u.reasoningTokens;
      if (u.costUsd) {
        m.costUsd += u.costUsd;
        m.costCalls++;
      }
      if (u.bytesUp !== undefined || u.bytesDown !== undefined) {
        s.bytes.calls++;
        s.bytes.up += u.bytesUp ?? 0;
        s.bytes.down += u.bytesDown ?? 0;
      }
    }
    this.schedule();
  }

  /** Every route's totals, latest first. */
  stats(): RouteStats[] {
    this.load();
    return [...this.routes.values()].map((s) => structuredClone(s)).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }

  /** One route's totals for one kind of work, or null when it has run none. */
  route(kind: string, route: string): RouteStats | null {
    this.load();
    const s = this.routes.get(keyOf(kind, route));
    return s ? structuredClone(s) : null;
  }

  /** Write now: on shutdown, and in tests. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.loaded) return;
    const body: LedgerFile = { version: 1, routes: Object.fromEntries(this.routes) };
    const temp = `${this.file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(body));
      fs.renameSync(temp, this.file);
    } catch (err) {
      this.opts.log?.(`usage ledger: could not write ${this.file}: ${err instanceof Error ? err.message : err}`);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.opts.flushMs ?? 5_000);
    this.timer.unref?.();
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<LedgerFile>;
      if (parsed?.version !== 1 || !parsed.routes || typeof parsed.routes !== 'object') return;
      for (const s of Object.values(parsed.routes)) {
        if (!s || typeof s.kind !== 'string' || typeof s.route !== 'string') continue;
        const fresh = emptyStats(s.kind, s.route, Boolean(s.remote), s.firstAt ?? new Date().toISOString());
        this.routes.set(keyOf(s.kind, s.route), {
          ...fresh, ...s,
          ms: Array.isArray(s.ms) ? s.ms.filter((n) => Number.isFinite(n)).slice(-MS_SAMPLES) : [],
          measured: { ...fresh.measured, ...s.measured },
          bytes: { ...fresh.bytes, ...s.bytes },
        });
      }
    } catch {
      // no ledger yet, or an unreadable one: start again — it only holds averages
    }
  }
}
