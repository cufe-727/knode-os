/**
 * What a failed labeling call means for the work and for whoever made it.
 *
 *   - model:     this answer failed (bad JSON, a refusal). It costs the
 *                segment one of its attempts; a run of them rests the backend.
 *   - transient: the backend could not take the call right now (a rate or usage
 *                limit, the network, a call that ran out of time, the process
 *                table). The segment keeps its attempts and goes back in line;
 *                the backend pauses. Codex reports a dead connection as a
 *                timeout or a closed transport, so those count here too — an
 *                outage must not use up the attempts of every segment it touches.
 *   - fatal:     the backend cannot work at all until someone fixes it (the CLI
 *                is missing, the login expired). It pauses for a long while and
 *                is tried again then, so a re-login brings it back on its own.
 *
 * The same rules run in `serve`'s local workers and, as a copy, in the remote
 * worker script (worker/knode-worker.mjs), which also reports its own reading.
 */
export type FailureKind = 'model' | 'transient' | 'fatal';

const FATAL = /cli not found|\benoent\b|not logged in|login required|please (log|sign) ?in|unauthori[sz]ed|authentication (failed|required)|invalid api key|incorrect api key|\b401\b|\b403\b|forbidden|subscription (has )?expired/;
const TRANSIENT = /rate.?limit|usage limit|quota|too many requests|\b429\b|overloaded|over capacity|try again (later|in)|\b50[234]\b|econnreset|econnrefused|etimedout|enotfound|eai_again|socket hang up|network|fetch failed|timed? ?out|reconnecting|transport channel closed|error sending request|http\/request failed|stream (disconnected|error)|connection (reset|closed|refused|error)|failed to refresh available models|\bebadf\b|\bemfile\b|\benfile\b|spawn \S+ e[a-z]+/;

export function classifyFailure(message: string): FailureKind {
  const m = message.toLowerCase();
  if (FATAL.test(m)) return 'fatal';
  if (TRANSIENT.test(m)) return 'transient';
  return 'model';
}

/** Backoff for one backend — the policy rookie-trade's review runner settled on. */
export const BACKOFF = {
  /** First pause after a transient failure; doubles per failure in a row. */
  pauseBaseMs: 60_000,
  pauseMaxMs: 10 * 60_000,
  /** Model failures in a row that rest a backend. */
  modelFailureLimit: 5,
  cooldownBaseMs: 30 * 60_000,
  cooldownMaxMs: 4 * 3_600_000,
  /** A fatal failure: rest this long (doubling), then try again. */
  fatalBaseMs: 30 * 60_000,
  fatalMaxMs: 6 * 3_600_000,
} as const;

export interface BackendHealth {
  calls: number;
  ok: number;
  failed: Record<FailureKind, number>;
  transientStreak: number;
  modelStreak: number;
  cooldowns: number;
  fatalStreak: number;
  pausedUntil: number;
  pauseReason: string | null;
  lastError: string | null;
}

export function newBackendHealth(): BackendHealth {
  return { calls: 0, ok: 0, failed: { model: 0, transient: 0, fatal: 0 }, transientStreak: 0, modelStreak: 0, cooldowns: 0, fatalStreak: 0, pausedUntil: 0, pauseReason: null, lastError: null };
}

/** Record a call's outcome on a backend; returns how long it now rests (0 = keep going). */
export function recordBackendOutcome(health: BackendHealth, outcome: { ok: true } | { ok: false; kind: FailureKind; error: string }, now = Date.now()): number {
  health.calls++;
  if (outcome.ok) {
    health.ok++;
    health.transientStreak = 0;
    health.modelStreak = 0;
    health.fatalStreak = 0;
    health.pauseReason = null;
    return 0;
  }
  health.failed[outcome.kind]++;
  health.lastError = outcome.error.slice(0, 300);
  let rest = 0;
  if (outcome.kind === 'transient') {
    health.transientStreak++;
    rest = Math.min(BACKOFF.pauseMaxMs, BACKOFF.pauseBaseMs * 2 ** (health.transientStreak - 1));
    health.pauseReason = 'transient failure';
  } else if (outcome.kind === 'fatal') {
    health.fatalStreak++;
    rest = Math.min(BACKOFF.fatalMaxMs, BACKOFF.fatalBaseMs * 2 ** (health.fatalStreak - 1));
    health.pauseReason = 'fatal failure';
  } else {
    health.modelStreak++;
    if (health.modelStreak >= BACKOFF.modelFailureLimit) {
      health.cooldowns++;
      health.modelStreak = 0;
      rest = Math.min(BACKOFF.cooldownMaxMs, BACKOFF.cooldownBaseMs * 2 ** (health.cooldowns - 1));
      health.pauseReason = `${BACKOFF.modelFailureLimit} model failures in a row`;
    }
  }
  if (rest > 0) health.pausedUntil = Math.max(health.pausedUntil, now + rest);
  return rest;
}
