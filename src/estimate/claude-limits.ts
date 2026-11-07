import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * How far the Claude plan's windows are used, as the Claude CLI last said.
 *
 * Claude has no read that spends no model call, the way Codex's app-server
 * has (src/estimate/codex.ts). What it has is a `rate_limit_event` in its
 * `stream-json` output: on a subscription login, every call says how far its
 * five-hour and weekly windows are used (`unifiedWindows`, a fraction each,
 * with its reset in Unix seconds). knode's one-shot calls (src/llm/cli.ts)
 * keep the last one they saw here, per machine like the Codex readings,
 * since the plan is the machine's login and not a workspace's.
 *
 * A reading only grows stale in one direction: within a window, use only
 * goes up, so an old reading may say more is left than is, never less. Once
 * a window's reset has passed, its reading says nothing more.
 */

export interface ClaudeWindow {
  /** `five_hour`, `seven_day`, `seven_day_opus`, … as the CLI names it. */
  name: string;
  /** Fraction of the window used: 0–1, past 1 when use runs over the cap. */
  utilization: number;
  /** Unix seconds. */
  resetsAt: number;
  status: string | null;
}

export interface ClaudeLimits {
  readAt: string;
  /** The top-level status: `rejected` while requests are refused. */
  status: string | null;
  /** The window the top-level status is about, and when it resets (Unix seconds). */
  limitingWindow: string | null;
  resetsAt: number | null;
  windows: ClaudeWindow[];
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** A `rate_limit_info` as the CLI prints it, or null when it carries nothing to go by. */
export function claudeLimitsFrom(info: unknown, now = Date.now()): ClaudeLimits | null {
  const i = obj(info);
  const windows: ClaudeWindow[] = [];
  for (const [name, raw] of Object.entries(obj(i.unifiedWindows))) {
    const w = obj(raw);
    const utilization = finite(w.utilization);
    const resetsAt = finite(w.resetsAt);
    if (utilization === null || resetsAt === null) continue;
    windows.push({ name, utilization, resetsAt, status: text(w.status) });
  }
  const limitingWindow = text(i.rateLimitType);
  const resetsAt = finite(i.resetsAt);
  // an older CLI says only how far the limiting window is used
  const utilization = finite(i.utilization);
  if (!windows.length && limitingWindow && utilization !== null && resetsAt !== null) {
    windows.push({ name: limitingWindow, utilization, resetsAt, status: text(i.status) });
  }
  const status = text(i.status);
  if (!windows.length && status !== 'rejected') return null;
  return { readAt: new Date(now).toISOString(), status, limitingWindow, resetsAt, windows };
}

/** The last `rate_limit_event` in a stream-json transcript, or null when it has none. */
export function lastRateLimitInfo(stdout: string): unknown | null {
  let last: unknown = null;
  for (const line of stdout.split('\n')) {
    if (!line.includes('rate_limit_event')) continue;
    try {
      const event = JSON.parse(line) as Json;
      if (event.type === 'rate_limit_event' && event.rate_limit_info) last = event.rate_limit_info;
    } catch {
      // not a whole event
    }
  }
  return last;
}

/** Where the last reading is kept. */
export function claudeLimitsPath(): string {
  return process.env.KNODE_CLAUDE_LIMITS_FILE || path.join(os.homedir(), '.knode-os', 'claude-limits.json');
}

/** Keep a reading, when it says anything; a failure to write costs only the reading. */
export function recordClaudeLimits(info: unknown, file = claudeLimitsPath(), now = Date.now()): ClaudeLimits | null {
  const limits = claudeLimitsFrom(info, now);
  if (!limits) return null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, last: limits }), { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch {
    // the next call says it again
  }
  return limits;
}

/** The last reading kept, or null when no call has said one yet. */
export function readClaudeLimits(file = claudeLimitsPath()): ClaudeLimits | null {
  try {
    const last = obj(obj(JSON.parse(fs.readFileSync(file, 'utf8'))).last);
    if (typeof last.readAt !== 'string' || !Array.isArray(last.windows)) return null;
    return last as unknown as ClaudeLimits;
  } catch {
    return null;
  }
}
