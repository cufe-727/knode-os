import type { ResearchAgent } from './agent.js';

/**
 * Why a research session failed, as far as what happens next goes
 * (docs/design/22):
 *
 *   - quota:     the plan's usage is spent — Claude's 5-hour or weekly limit,
 *                Codex's usage limit, Cursor's "out of usage", an API's
 *                insufficient_quota. Nothing on that agent runs until it
 *                resets, so the job and every job queued on the same agent
 *                wait until then: the time the message names, else a backoff.
 *   - transient: the call could not be served right now — a rate limit, an
 *                overloaded API, the network. The job waits a short backoff.
 *   - setup:     the agent cannot run until someone fixes it — the CLI is
 *                missing, the login expired, the key is wrong. Its jobs wait
 *                a long backoff, so a re-login resumes them on its own.
 *   - other:     the agent ran and did not do the work (its turns ran out, the
 *                page was refused): an attempt spent, as before.
 *
 * Only the first three pause, each up to `PAUSE.limit` times in a row; a
 * paused job keeps its attempts. The patterns
 * read the agents' own messages, never a validator's, whose paths could name
 * any topic ("rate-limits.md").
 */
export type FailureKind = 'quota' | 'transient' | 'setup' | 'other';

export interface RunFailure {
  kind: FailureKind;
  message: string;
  /** When the message says the limit lifts (quota and transient only). */
  resetAt: Date | null;
}

/** Why a job is waiting instead of running: kept in its payload (`payload.pause`) until it runs to an end. */
export interface RunPause {
  kind: Exclude<FailureKind, 'other'>;
  /** The agent's message, cut short. */
  reason: string;
  /** The first pause of this streak, and the time the job may be claimed again. */
  since: string;
  until: string;
  /** Pauses of this kind in a row: the backoff doubles with each. */
  count: number;
  /** The account the limit belongs to (`agentKey`): the jobs that wait with it. */
  agent: string;
  /** `until` is the reset time the message named, not a guess. */
  resetKnown: boolean;
}

export const PAUSE = {
  /** After a named reset: the provider lifts it on its own clock, not this machine's. */
  marginMs: 2 * 60_000,
  /** A spent quota whose reset nobody named: try again after this, doubling. */
  quotaBaseMs: 30 * 60_000,
  quotaMaxMs: 6 * 3_600_000,
  transientBaseMs: 60_000,
  transientMaxMs: 15 * 60_000,
  setupBaseMs: 30 * 60_000,
  setupMaxMs: 6 * 3_600_000,
  /** A reset further out than this is a misread (weekly limits reset within 7 days). */
  maxWaitMs: 8 * 86_400_000,
  /**
   * Pauses of one kind in a row before the run counts as an ordinary failure:
   * a message read as a limit that is none (a CLI that quotes the model) must
   * not keep a job waiting for ever.
   */
  limit: { quota: 12, transient: 6, setup: 8 },
} as const;

// "out of usage" is Cursor's refusal once a plan's included usage is spent (2026-10)
const QUOTA = /usage limit|(?:5|five)-hour limit|weekly limit|session limit|hit your (?:\w+ )?limit|out of usage|usage (?:cap|exhausted)|insufficient_quota|quota (?:exceeded|exhausted|reached)|exceeded your (?:current )?quota|credit balance is too low|out of credits|billing hard limit/i;
const SETUP = /cli not found|\benoent\b|not logged in|logged out|login required|please (?:log|sign) ?in|please run \/login|run `?[\w-]+ (?:auth )?login|invalid api key|incorrect api key|invalid x-api-key|authentication(?:_error| failed| required)|unauthori[sz]ed|oauth token (?:has )?expired|subscription (?:has )?expired/i;
const TRANSIENT = /rate.?limit|too many requests|\b429\b|overloaded|\b529\b|over capacity|temporarily unavailable|service unavailable|bad gateway|gateway time-?out|\b50[234]\b|econnreset|econnrefused|etimedout|enotfound|eai_again|socket hang up|fetch failed|network error|stream (?:disconnected|error)|connection (?:reset|closed|refused|error)|transport channel closed|error sending request|try again later/i;

export function classifyFailure(message: string, now = new Date()): RunFailure {
  const kind: FailureKind = QUOTA.test(message) ? 'quota' : SETUP.test(message) ? 'setup' : TRANSIENT.test(message) ? 'transient' : 'other';
  return { kind, message, resetAt: kind === 'quota' || kind === 'transient' ? resetTimeFrom(message, now) : null };
}

/** The first of a run's session errors that should pause it rather than spend an attempt, or null. */
export function pausingFailure(errors: (string | null | undefined)[], now = new Date()): RunFailure | null {
  for (const e of errors) {
    if (!e) continue;
    const f = classifyFailure(e, now);
    if (f.kind !== 'other') return f;
  }
  return null;
}

/** The account a usage limit belongs to: every model of one CLI login shares it. */
export function agentKey(agent: ResearchAgent): string {
  if (agent.kind === 'builtin') return `builtin:${agent.baseUrl.replace(/\/+$/, '')}`;
  // OpenCode has no login: its limit is the endpoint's, shared with the built-in agent on it
  if (agent.endpoint) return `builtin:${agent.endpoint.baseUrl.replace(/\/+$/, '')}`;
  return agent.cliPath?.trim() ? `${agent.provider}:${agent.cliPath.trim()}` : agent.provider;
}

/**
 * How long a job waits after `failure`, given the pause it already had (the
 * streak doubles the backoff). Null when it should not wait: an ordinary
 * failure, or a transient one that has come back too often to be one.
 */
export function pauseFor(failure: RunFailure, prev: RunPause | null, agent: string, now = new Date()): RunPause | null {
  if (failure.kind === 'other') return null;
  const count = prev && prev.kind === failure.kind ? prev.count + 1 : 1;
  if (count > PAUSE.limit[failure.kind]) return null;
  const backoff = (base: number, max: number) => Math.min(max, base * 2 ** (count - 1));
  const t = now.getTime();
  const named = failure.resetAt && failure.resetAt.getTime() > t && failure.resetAt.getTime() - t < PAUSE.maxWaitMs ? failure.resetAt.getTime() + PAUSE.marginMs : null;
  const until = named
    ?? t + (failure.kind === 'quota' ? backoff(PAUSE.quotaBaseMs, PAUSE.quotaMaxMs)
      : failure.kind === 'setup' ? backoff(PAUSE.setupBaseMs, PAUSE.setupMaxMs)
        : backoff(PAUSE.transientBaseMs, PAUSE.transientMaxMs));
  return {
    kind: failure.kind,
    reason: failure.message.replace(/\s+/g, ' ').trim().slice(0, 300),
    since: prev && prev.kind === failure.kind ? prev.since : now.toISOString(),
    until: new Date(until).toISOString(),
    count,
    agent,
    resetKnown: named !== null,
  };
}

/** What a stage throws when its sessions were refused for a reason that pauses the job (a study's collectors). */
export class AgentUnavailableError extends Error {
  constructor(public readonly failure: RunFailure, message: string) {
    super(message);
    this.name = 'AgentUnavailableError';
  }
}

/** A job's pause, when it has one that has not run out yet. */
export function activePause(payload: Record<string, unknown>, now = Date.now()): RunPause | null {
  const p = payload.pause as RunPause | undefined;
  return p && typeof p.until === 'string' && Date.parse(p.until) > now ? p : null;
}

/* ------------------------------------------------------- reset times */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * When a limit lifts, read from the agent's message:
 *
 *   Claude Code  "You've hit your 5-hour limit · resets 1:30am (Asia/Shanghai)",
 *                "… weekly limit · resets Nov 7, 9am (America/Los_Angeles)",
 *                and before mid-2025 "Claude AI usage limit reached|1735689600"
 *   Codex        "… or try again in 2 days 3 hours 5 minutes", "try again at 3:04 PM"
 *   APIs         "retry after 30 seconds", "Retry-After: 30"
 *
 * A clock time without a zone is this machine's (Codex prints local times);
 * without a date it is the next time the clock shows it. Null when the
 * message names no time.
 */
export function resetTimeFrom(message: string, now = new Date(), localZone = Intl.DateTimeFormat().resolvedOptions().timeZone): Date | null {
  const epoch = /limit reached\|(\d{10,13})/i.exec(message);
  if (epoch) {
    const n = Number(epoch[1]);
    return new Date(n < 1e12 ? n * 1000 : n);
  }
  const after = /retry-after:\s*(\d+)/i.exec(message);
  if (after) return new Date(now.getTime() + Number(after[1]) * 1000);
  const dur = /(?:try again|retry|resets?|available)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i.exec(message);
  if (dur) {
    const unit: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
    let ms = 0;
    for (const [, n, u] of dur[1].matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) ms += Number(n) * (unit[u[0].toLowerCase()] ?? 0);
    if (ms > 0) return new Date(now.getTime() + ms);
  }
  const clock = /(?:resets?|try again|available again)\s+(?:at\s+|on\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(?:(\d{4}),?\s*)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)\))?/i.exec(message);
  if (!clock) return null;
  const [, mon, day, year, hh, mm, ampm, zone] = clock;
  if (mm === undefined && !ampm) return null; // "resets 5" is no time of day
  let hour = Number(hh);
  if (ampm) {
    const pm = ampm[0].toLowerCase() === 'p';
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
  }
  if (hour > 23 || Number(mm ?? 0) > 59) return null;
  const tz = zone && validZone(zone) ? zone : localZone;
  const today = zonedParts(now.getTime(), tz);
  if (mon) {
    const month = MONTHS.indexOf(mon.toLowerCase());
    let t = zonedToUtc(year ? Number(year) : today.year, month, Number(day), hour, Number(mm ?? 0), tz);
    if (!year && t < now.getTime() - 86_400_000) t = zonedToUtc(today.year + 1, month, Number(day), hour, Number(mm ?? 0), tz);
    return new Date(t);
  }
  let t = zonedToUtc(today.year, today.month, today.day, hour, Number(mm ?? 0), tz);
  if (t <= now.getTime()) t = zonedToUtc(today.year, today.month, today.day + 1, hour, Number(mm ?? 0), tz);
  return new Date(t);
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The wall clock of `tz` at an instant (month 0-based). */
function zonedParts(at: number, tz: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month) - 1, day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second) };
}

/** The instant `tz`'s clock shows the given wall time (Date.UTC carries a day past the month's end). */
function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const wall = Date.UTC(year, month, day, hour, minute);
  const offset = (at: number) => {
    const p = zonedParts(at, tz);
    return Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
  };
  const first = wall - offset(wall);
  // once more at the guess: a daylight-saving change between the two moves the offset
  return wall - offset(first);
}
