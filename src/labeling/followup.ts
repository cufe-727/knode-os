import { AppContext } from '../context.js';
import { auditDuplicateClaims } from '../graph/claim-dedupe.js';
import { auditDuplicateEntities } from '../graph/dedupe.js';
import { ensureSourceSummaries, reconcileViews } from '../wiki/pages.js';
import { LabelingScheduler } from './scheduler.js';

/**
 * What follows extraction in `serve`, now that extraction runs continuously
 * (src/labeling/scheduler.ts) instead of in passes:
 *
 *   - every `extraction.intervalMinutes`, the duplicate-entity and
 *     duplicate-claim audits over what was written since the last round, then
 *     the views that depend on it — the Resolve and Merge-claims steps of the
 *     old pass (docs/design/09, 10);
 *   - a summary loop that writes the summary page of every document whose
 *     extraction is done, the most recently extracted first, with
 *     `extraction.summaryConcurrency` calls at a time.
 *
 * The two take turns, as they did inside one pass, so a review and a summary
 * never write the same page at once. Neither holds up extraction. Only one
 * review waits in line at a time, and the next comes `intervalMinutes` after
 * the last one ended: a review can take longer than the interval (an LLM
 * judge over many pairs), and reviews queued on a clock used to pile up
 * behind it until the summary loop never got a turn (2026-10-15: no summary
 * for nine hours).
 *
 * Both are model calls, so both run only while the workspace's processing
 * is started (`setActive`, src/labeling/processing.ts).
 */

const SUMMARY_IDLE_MS = 2 * 60_000;
/** Longest nap while the summary model cannot be reached; the nap doubles from SUMMARY_IDLE_MS. */
const SUMMARY_BACKOFF_MAX_MS = 30 * 60_000;
const RECENT_LIMIT = 500;

export interface FollowUpOptions {
  log?: (msg: string) => void;
  track?: <T>(job: Promise<T>) => Promise<T>;
  /** Run from the start (default true); `setActive` switches it later. */
  active?: boolean;
  /** Between the end of one review and the start of the next (default `extraction.intervalMinutes`). */
  reviewIntervalMs?: number;
}

export interface FollowUp {
  stop(): void;
  /** Run or pause the reviews and summaries. A review or summary batch already running finishes. */
  setActive(active: boolean): void;
  readonly active: boolean;
}

export function startFollowUp(ctx: AppContext, scheduler: LabelingScheduler, opts: FollowUpOptions = {}): FollowUp {
  const log = opts.log ?? (() => {});
  const track = opts.track ?? (<T>(job: Promise<T>) => job);
  let stopped = false;
  let active = opts.active ?? true;
  let chain: Promise<unknown> = Promise.resolve();
  /** Run `fn` after whatever is in line; a turn that comes up once stopped or paused is skipped (`idle`). */
  const turn = <T>(fn: () => Promise<T>, idle: T): Promise<T> => {
    const run = chain.then(() => (stopped || !active ? idle : fn()));
    chain = run.catch(() => {});
    return run;
  };
  /** Documents written lately, newest last: the summary loop takes these first. */
  const recent: string[] = [];

  const review = async () => {
    const batch = scheduler.takeFinished();
    if (batch.written === 0 && batch.failed === 0) return;
    recent.push(...batch.documents);
    if (recent.length > RECENT_LIMIT) recent.splice(0, recent.length - RECENT_LIMIT);
    const parts = [`${batch.written} written${batch.failed ? `, ${batch.failed} given up` : ''}`];
    const reviewCtx = { store: ctx.store, embedder: ctx.embedder, config: ctx.config, llm: ctx.llm };
    if (batch.entityIds.length) {
      try {
        const r = await auditDuplicateEntities(reviewCtx, { focus: [...new Set(batch.entityIds)], onProgress: log });
        if (r.suggested || r.autoMerged || r.llmRejected) parts.push(`resolve: ${r.suggested} merge suggestions${r.autoMerged ? `, ${r.autoMerged} merged` : ''}${r.llmRejected ? `, ${r.llmRejected} rejected` : ''}`);
      } catch (err) {
        log(`resolve failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (batch.claimIds.length) {
      try {
        const r = await auditDuplicateClaims(reviewCtx, { focus: [...new Set(batch.claimIds)], onProgress: log });
        if (r.merged || r.suggested || r.conflicts) parts.push(`claims: ${r.merged} merged, ${r.suggested} suggestions, ${r.conflicts} contradictions`);
      } catch (err) {
        log(`claim merge failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    log(`document pass: ${parts.join('; ')}`);
    const views = await reconcileViews(ctx, { actor: 'tier1', llm: false, onProgress: log });
    if (views.regenerated || views.archived) log(`views: ${views.regenerated} regenerated, ${views.archived} archived`);
  };

  // one review at a time, the next one an interval after the last ended
  const intervalMs = opts.reviewIntervalMs ?? Math.max(1, ctx.config.extraction.intervalMinutes) * 60_000;
  let reviewTimer: NodeJS.Timeout | null = null;
  const scheduleReview = () => {
    if (stopped) return;
    reviewTimer = setTimeout(() => {
      reviewTimer = null;
      if (stopped) return;
      if (!active) {
        scheduleReview();
        return;
      }
      void track(turn(review, undefined)
        .catch((err) => log(`document review failed: ${err instanceof Error ? err.message : err}`))
        .finally(scheduleReview));
    }, intervalMs);
    reviewTimer.unref?.();
  };
  scheduleReview();

  // the summary loop: back to back while pages are due, then a nap
  let wake: (() => void) | null = null;
  const nap = (ms: number) => new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    t.unref?.();
    wake = () => {
      clearTimeout(t);
      wake = null;
      resolve();
    };
  });
  void track((async () => {
    let unreachable = 0;
    while (!stopped) {
      if (!active) {
        unreachable = 0;
        await nap(SUMMARY_IDLE_MS);
        continue;
      }
      let written: string[] = [];
      const stats = { deferred: 0 };
      try {
        const config = ctx.config;
        const slots = Math.max(1, Math.min(16, Math.floor(config.extraction.summaryConcurrency ?? config.extraction.concurrency ?? 1)));
        written = await turn(() => ensureSourceSummaries({ ...ctx, config }, {
          limit: slots * 2,
          prefer: [...recent].reverse(),
          concurrency: slots,
          actor: 'summarize',
          skipQueued: true,
          onProgress: log,
          stats,
        }), [] as string[]);
        if (written.length) log(`summaries: ${written.length} written`);
      } catch (err) {
        log(`summaries failed: ${err instanceof Error ? err.message : err}`);
      }
      // nothing written because the model was out of reach: back off, doubling, until it answers again
      unreachable = written.length === 0 && stats.deferred > 0 ? unreachable + 1 : 0;
      if (unreachable > 0) {
        const wait = Math.min(SUMMARY_BACKOFF_MAX_MS, SUMMARY_IDLE_MS * 2 ** (unreachable - 1));
        log(`summaries: the summary model cannot be reached — next try in ${Math.round(wait / 60_000)} min`);
        if (!stopped) await nap(wait);
      } else if (!stopped && written.length === 0) {
        await nap(SUMMARY_IDLE_MS);
      }
    }
  })());

  return {
    stop: () => {
      stopped = true;
      if (reviewTimer) clearTimeout(reviewTimer);
      (wake as (() => void) | null)?.();
    },
    setActive: (on: boolean) => {
      active = on;
      // a nap ends at once, so a start is felt now rather than in two minutes
      if (on) (wake as (() => void) | null)?.();
    },
    get active() {
      return active;
    },
  };
}
