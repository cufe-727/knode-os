import { readClaudeLimits } from '../estimate/claude-limits.js';
import { CodexAccount, readCodexAccount, readRememberedAccount } from '../estimate/codex.js';

/**
 * What is left of the plan a CLI runs on, for the quota floor
 * (`processing.minQuotaPercent`): a stage running on a plan-metered CLI takes
 * no new work on this machine while any window of its plan has less than the
 * floor left, so that processing leaves the last of a plan to the person who
 * pays for it.
 *
 * - Codex (`codex-cli`): `codex app-server` says how far each window is used,
 *   with no model call (src/estimate/codex.ts), at most once a minute. When
 *   the read fails, the last read that succeeded stands in.
 * - Claude (`claude-cli`): what the CLI said in its last call here
 *   (src/estimate/claude-limits.ts). There is no read that spends no call;
 *   use only grows within a window, so an old reading errs towards more left.
 *
 * Other providers have no reading: a Cursor plan says its tier and nothing of
 * its use, and an API key has no windows. They take work as before, and a
 * refused call rests them as before (src/labeling/failures.ts).
 *
 * A window whose reset has passed since its reading says nothing more: it
 * counts as fresh until a new reading says otherwise.
 */

export interface PlanWindow {
  /** "five-hour", "weekly", … */
  name: string;
  /** Percent of the window left, 0–100. */
  leftPercent: number;
  resetsAt: string | null;
}

export interface PlanQuota {
  /** "Codex", "Claude": for a person to read. */
  plan: string;
  windows: PlanWindow[];
  /** Set while the provider says requests are refused already. */
  limitReached: string | null;
  /** When that limit lifts, where the provider says. */
  limitResetsAt?: string | null;
  readAt: string;
}

/** Reads a provider's plan through the CLI at `command`; null when there is nothing to go by. */
export type PlanQuotaReader = (provider: string, command: string) => Promise<PlanQuota | null>;

/** The providers whose plans have a reading. */
export function meteredPlan(provider: string): boolean {
  return provider === 'codex-cli' || provider === 'claude-cli';
}

export async function readPlanQuota(provider: string, command: string, now = Date.now()): Promise<PlanQuota | null> {
  if (provider === 'codex-cli') {
    let account: CodexAccount | null;
    try {
      account = await readCodexAccount(command);
    } catch {
      account = readRememberedAccount();
    }
    return account ? codexQuota(account, now) : null;
  }
  if (provider === 'claude-cli') {
    const limits = readClaudeLimits();
    if (!limits) return null;
    const windows = limits.windows
      .filter((w) => w.resetsAt * 1000 > now)
      .map((w) => ({ name: CLAUDE_WINDOWS[w.name] ?? w.name.replace(/_/g, ' '), leftPercent: clampPercent((1 - w.utilization) * 100), resetsAt: new Date(w.resetsAt * 1000).toISOString() }));
    const refused = limits.status === 'rejected' && (limits.resetsAt === null || limits.resetsAt * 1000 > now);
    return {
      plan: 'Claude',
      windows,
      limitReached: refused ? (CLAUDE_WINDOWS[limits.limitingWindow ?? ''] ?? limits.limitingWindow ?? 'rejected') : null,
      limitResetsAt: refused && limits.resetsAt !== null ? new Date(limits.resetsAt * 1000).toISOString() : null,
      readAt: limits.readAt,
    };
  }
  return null;
}

const CLAUDE_WINDOWS: Record<string, string> = {
  five_hour: 'five-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly Opus',
  seven_day_sonnet: 'weekly Sonnet',
  seven_day_overage_included: 'weekly (overage included)',
};

export function codexQuota(account: CodexAccount, now = Date.now()): PlanQuota {
  const windows = account.windows
    .filter((w) => !w.resetsAt || Date.parse(w.resetsAt) > now)
    .map((w) => ({ name: w.minutes <= 300 ? 'five-hour' : w.minutes >= 10_080 ? 'weekly' : `${w.minutes}-minute`, leftPercent: clampPercent(100 - w.usedPercent), resetsAt: w.resetsAt }));
  // a limit reached in a reading whose windows have all reset since is over
  const over = account.limitReached && account.windows.length > 0 && windows.length === 0;
  return { plan: 'Codex', windows, limitReached: over ? null : account.limitReached, readAt: account.readAt };
}

const clampPercent = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export interface QuotaHold {
  /** Why: the window and how much of it is left, for the Tasks view and the log. */
  reason: string;
  /** When the windows that hold it reset, or null when the reading does not say. */
  until: string | null;
}

/**
 * Whether a plan is under the floor: a reached limit, or a window with less
 * than `minPercent` left. The hold lasts until every such window resets.
 * Null when the plan may take work (or the floor is off).
 */
export function quotaHold(quota: PlanQuota | null, minPercent: number): QuotaHold | null {
  if (!quota || !(minPercent > 0)) return null;
  const short = quota.windows.filter((w) => w.leftPercent < minPercent);
  // every short window must reset before the plan is over the floor again
  const resets = short.map((w) => w.resetsAt).filter((t): t is string => Boolean(t));
  const latest = resets.length ? resets.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : null;
  if (quota.limitReached) {
    return { reason: `${quota.plan} limit reached (${quota.limitReached})`, until: quota.limitResetsAt ?? latest };
  }
  if (short.length === 0) return null;
  const tightest = short.reduce((a, b) => (a.leftPercent <= b.leftPercent ? a : b));
  return { reason: `${quota.plan} ${tightest.name} window has ${tightest.leftPercent}% left, under the ${minPercent}% floor`, until: latest };
}

/**
 * A reading as it stands at `now`: a window whose reset has passed since says
 * nothing more, and a reached limit whose reset has passed is over.
 */
export function quotaAt(quota: PlanQuota | null, now = Date.now()): PlanQuota | null {
  if (!quota) return null;
  const live = (t: string | null | undefined) => !t || !(Date.parse(t) <= now);
  const windows = quota.windows.filter((w) => live(w.resetsAt));
  const lifted = quota.limitReached && quota.limitResetsAt && !live(quota.limitResetsAt);
  return { ...quota, windows, limitReached: lifted ? null : quota.limitReached };
}

/**
 * The plan readings this machine shares (`serve` holds one for every
 * workspace): each plan — a provider and the CLI it is read through — is read
 * at most every `checkMs`, however many slots, workspaces and nightly passes
 * ask, and the last reading that succeeded stands in while a read fails.
 * What a reading holds depends on the floor each caller asks with.
 */
export class PlanReadings {
  readonly checkMs: number;
  private readonly read: PlanQuotaReader;
  private readonly log: (msg: string) => void;
  private readonly plans = new Map<string, { reading: PlanQuota | null; checkedAt: number; pending: Promise<PlanQuota | null> | null }>();

  constructor(opts: { read?: PlanQuotaReader; checkMs?: number; log?: (msg: string) => void } = {}) {
    this.read = opts.read ?? ((provider, command) => readPlanQuota(provider, command));
    this.checkMs = opts.checkMs ?? 120_000;
    this.log = opts.log ?? (() => {});
  }

  /**
   * The hold on the plan `provider` runs on under `minPercent`, or null: off
   * (0), a provider with no reading, or a plan over the floor. Never throws.
   */
  async hold(provider: string, command: string, minPercent: number): Promise<QuotaHold | null> {
    if (!(minPercent > 0) || !meteredPlan(provider)) return null;
    return quotaHold(quotaAt(await this.reading(provider, command)), minPercent);
  }

  /** When the plan was last read (0: never), for how long a hold without a reset time shows. */
  checkedAt(provider: string, command: string): number {
    return this.plans.get(`${provider}\u0000${command}`)?.checkedAt ?? 0;
  }

  private async reading(provider: string, command: string): Promise<PlanQuota | null> {
    const key = `${provider}\u0000${command}`;
    let plan = this.plans.get(key);
    if (!plan) {
      plan = { reading: null, checkedAt: 0, pending: null };
      this.plans.set(key, plan);
    }
    if (plan.pending) return plan.pending;
    if (plan.checkedAt > 0 && Date.now() - plan.checkedAt < this.checkMs) return plan.reading;
    const entry = plan;
    entry.pending = (async () => {
      try {
        entry.reading = await this.read(provider, command);
      } catch (err) {
        // what it knew stands until a read succeeds
        this.log(`could not read the ${provider} plan: ${err instanceof Error ? err.message : err}`);
      }
      entry.checkedAt = Date.now();
      return entry.reading;
    })();
    try {
      return await entry.pending;
    } finally {
      entry.pending = null;
    }
  }
}
