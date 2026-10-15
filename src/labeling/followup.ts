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
 * never write the same page at once. Neither holds up extraction.
 */

const SUMMARY_IDLE_MS = 2 * 60_000;
/** Longest nap while the summary model cannot be reached; the nap doubles from SUMMARY_IDLE_MS. */
const SUMMARY_BACKOFF_MAX_MS = 30 * 60_000;
const RECENT_LIMIT = 500;

export interface FollowUpOptions {
  log?: (msg: string) => void;
  track?: <T>(job: Promise<T>) => Promise<T>;
}

export interface FollowUp {
  stop(): void;
}

export function startFollowUp(ctx: AppContext, scheduler: LabelingScheduler, opts: FollowUpOptions = {}): FollowUp {
  const log = opts.log ?? (() => {});
  const track = opts.track ?? (<T>(job: Promise<T>) => job);
  let stopped = false;
  let chain: Promise<unknown> = Promise.resolve();
  const turn = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
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

  const intervalMs = Math.max(1, ctx.config.extraction.intervalMinutes) * 60_000;
  const timer = setInterval(() => {
    if (stopped) return;
    void track(turn(review).catch((err) => log(`document review failed: ${err instanceof Error ? err.message : err}`)));
  }, intervalMs);
  timer.unref?.();

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
        }));
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
      clearInterval(timer);
      (wake as (() => void) | null)?.();
    },
  };
}
