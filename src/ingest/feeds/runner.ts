import { activityOf } from '../../activity.js';
import type { LlmConfig } from '../../config.js';
import { pluginRegistry } from '../../plugins/registry.js';
import type { SyncContext } from '../sync.js';
import { feedDest, feedProblem, loadFeed, loadFeeds, parseDuration } from './definitions.js';
import { FeedLedger, FeedState } from './ledger.js';
import { FeedRunOptions, FeedRunResult, pushToFeed, runFeed } from './run.js';
import type { FeedDefinition } from './types.js';

/**
 * What `serve` runs per workspace for its feeds (docs/design/25 §7): a look
 * every minute at which feeds are due — by `schedule.every`, by
 * `schedule.at` (and at startup when one of those times passed while knode-os
 * was down), or soon again when a connector said more is waiting — and one
 * feed at a time is run. A feed that failed waits longer each time
 * (5 min, 10, 20 … up to 6 h). Run now and pushes go through the same queue
 * per feed (src/ingest/feeds/run.ts), so runs of one feed never overlap.
 */

export interface FeedRunnerOptions {
  log?: (msg: string) => void;
  track?: <T>(job: Promise<T>) => Promise<T>;
  /** Why a model stage must wait now (the quota floor), or null. */
  hold?: (llm: LlmConfig) => Promise<string | null>;
  limiter?: FeedRunOptions['limiter'];
  /** Seconds after start before the first look (the startup sync goes first). */
  firstCheckSeconds?: number;
}

export interface FeedStatus {
  id: string;
  title: string;
  description: string;
  connector: string;
  connectorLabel: string;
  /** Items only arrive by push: there is nothing to run. */
  pushOnly: boolean;
  enabled: boolean;
  schedule: FeedDefinition['schedule'];
  dest: string;
  problem: string | null;
  running: boolean;
  nextRunAt: string | null;
  state: FeedState;
  items: number;
}

const MORE_AGAIN_MS = 2 * 60_000;
const MAX_BACKOFF_MS = 6 * 3_600_000;

/** The last of a feed's daily times that has passed by `now`, as a Date (local time). */
function lastAtTime(times: string[], now: Date): Date | null {
  let best: Date | null = null;
  for (const t of times) {
    const [h, m] = t.split(':').map(Number);
    const today = new Date(now);
    today.setHours(h, m, 0, 0);
    const at = today.getTime() <= now.getTime() ? today : new Date(today.getTime() - 86_400_000);
    if (!best || at > best) best = at;
  }
  return best;
}

function nextAtTime(times: string[], now: Date): Date | null {
  let best: Date | null = null;
  for (const t of times) {
    const [h, m] = t.split(':').map(Number);
    const today = new Date(now);
    today.setHours(h, m, 0, 0);
    const at = today.getTime() > now.getTime() ? today : new Date(today.getTime() + 86_400_000);
    if (!best || at < best) best = at;
  }
  return best;
}

/** When a feed should run next, given how its runs went; null when only a person or a push runs it. */
export function nextRunFor(feed: FeedDefinition, state: FeedState, now = new Date()): Date | null {
  if (!feed.enabled) return null;
  const connector = pluginRegistry().feedConnector(feed.connector);
  if (!connector || connector.pushOnly) return null;
  const every = parseDuration(feed.schedule.every);
  // a feed without a schedule runs when a person or a push asks — a failure does not schedule a retry
  if (!every && !feed.schedule.at?.length) return null;
  const last = state.lastRunAt ? Date.parse(state.lastRunAt) : 0;
  const floor = last + (connector.minIntervalMinutes ?? 0) * 60_000;
  if ((state.failures ?? 0) > 0) {
    const wait = Math.min(MAX_BACKOFF_MS, 5 * 60_000 * 2 ** Math.min(10, (state.failures ?? 1) - 1));
    return new Date(Math.max(floor, last + wait));
  }
  if (state.more && last) return new Date(Math.max(floor, last + MORE_AGAIN_MS));
  const candidates: number[] = [];
  if (every) candidates.push(last ? last + every : now.getTime());
  if (feed.schedule.at?.length) {
    const passed = lastAtTime(feed.schedule.at, now);
    // a time that passed since the last run (or while knode-os was down) is owed now
    if (passed && passed.getTime() > last) candidates.push(passed.getTime());
    else candidates.push(nextAtTime(feed.schedule.at, now)!.getTime());
  }
  if (!candidates.length) return null;
  return new Date(Math.max(floor, Math.min(...candidates)));
}

export class FeedRunner {
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private stopped = false;
  private loop: Promise<void> | null = null;
  private readonly running = new Set<string>();
  private readonly abort = new AbortController();
  private readonly log: (msg: string) => void;
  private readonly track: <T>(job: Promise<T>) => Promise<T>;

  constructor(private readonly ctx: SyncContext, private readonly opts: FeedRunnerOptions = {}) {
    this.log = opts.log ?? (() => {});
    this.track = opts.track ?? ((job) => job);
  }

  start(): void {
    const tick = () => {
      if (!this.stopped && !this.loop) {
        this.loop = this.runDue().finally(() => {
          this.loop = null;
        });
        void this.track(this.loop);
      }
    };
    this.first = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, 60_000);
      this.timer.unref?.();
    }, (this.opts.firstCheckSeconds ?? 45) * 1000);
    this.first.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
    await this.loop?.catch(() => {});
  }

  /** The feeds due now, run one after another. */
  private async runDue(): Promise<void> {
    const now = new Date();
    for (const feed of loadFeeds(this.ctx.dataDir)) {
      if (this.stopped) return;
      if (this.running.has(feed.id) || feedProblem(feed)) continue;
      const next = nextRunFor(feed, new FeedLedger(this.ctx.dataDir, feed.id).state(), now);
      if (!next || next.getTime() > now.getTime()) continue;
      await this.run(feed, {}, 'scheduled').catch(() => {});
    }
  }

  private options(extra: FeedRunOptions): FeedRunOptions {
    return { hold: this.opts.hold, limiter: this.opts.limiter, signal: this.abort.signal, onProgress: (m) => this.log(m), ...extra };
  }

  private async run(feed: FeedDefinition, extra: FeedRunOptions, why: 'scheduled' | 'now' | 'push'): Promise<FeedRunResult> {
    this.running.add(feed.id);
    try {
      const label = why === 'push' ? `${feed.title}: items pushed in` : `${feed.title}: ${why === 'now' ? 'run now' : 'checking for new items'}`;
      return await activityOf(this.ctx.dataDir).run(
        'feeds',
        label,
        async (progress) => {
          const result = await runFeed(this.ctx, feed, this.options({ ...extra, onProgress: (m) => { this.log(m); progress(m); } }));
          if (result.error) this.log(`feed ${feed.id}: ${result.error}`);
          return result;
        },
        (r) => `${r.pulled + r.pushed} item(s), ${r.changed} new or changed, ${r.kept} kept, ${r.dropped} dropped${r.pending ? `, ${r.pending} pending` : ''}; ${r.documents.filter((d) => d.written).length} document(s) written${r.error ? ` — ${r.error}` : ''}`,
      );
    } catch (err) {
      this.log(`feed ${feed.id}: run failed: ${err instanceof Error ? err.message : err}`);
      throw err;
    } finally {
      this.running.delete(feed.id);
    }
  }

  /** Run a feed now; with `wait` false, in the background (false: it is running already). */
  runNow(id: string, extra: FeedRunOptions = {}, wait = false): Promise<FeedRunResult> | boolean {
    const feed = loadFeed(this.ctx.dataDir, id);
    if (!feed) throw new Error(`no feed "${id}"`);
    if (wait) return this.run(feed, extra, 'now');
    if (this.running.has(id)) return false;
    void this.track(this.run(feed, extra, 'now').catch(() => {}));
    return true;
  }

  /** Items pushed in: kept at once, decided and written in this call. */
  push(id: string, items: unknown[], extra: FeedRunOptions = {}): Promise<FeedRunResult> {
    const feed = loadFeed(this.ctx.dataDir, id);
    if (!feed) throw new Error(`no feed "${id}"`);
    return this.track(this.run(feed, { ...extra, items, pull: false }, 'push'));
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  status(): FeedStatus[] {
    return describeFeeds(this.ctx.dataDir, this.running);
  }
}

/** Every feed with how its runs went; `running` names those under way (none without serve). */
export function describeFeeds(dataDir: string, running: ReadonlySet<string> = new Set()): FeedStatus[] {
  const now = new Date();
  return loadFeeds(dataDir).map((feed) => {
    const ledger = new FeedLedger(dataDir, feed.id);
    const state = ledger.state();
    const connector = pluginRegistry().feedConnector(feed.connector);
    let dest = '';
    try {
      dest = feedDest(feed);
    } catch {
      // feedProblem says why
    }
    const next = nextRunFor(feed, state, now);
    return {
      id: feed.id,
      title: feed.title,
      description: feed.description,
      connector: feed.connector,
      connectorLabel: connector?.label ?? feed.connector,
      pushOnly: Boolean(connector?.pushOnly),
      enabled: feed.enabled,
      schedule: feed.schedule,
      dest,
      problem: feedProblem(feed),
      running: running.has(feed.id),
      nextRunAt: next ? next.toISOString() : null,
      state: { ...state, cursor: undefined },
      items: ledger.size,
    };
  });
}

export { pushToFeed, runFeed };
