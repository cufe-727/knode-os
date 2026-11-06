import { AppContext } from '../context.js';
import { auditDuplicateClaims } from '../graph/claim-dedupe.js';
import { auditDuplicateEntities } from '../graph/dedupe.js';
import { EmbeddingProvider } from '../ingest/embeddings.js';
import { reconcileViews } from '../wiki/pages.js';
import { JudgeRunner } from '../work/judge.js';
import { LabelingScheduler } from './scheduler.js';

/**
 * What follows extraction in `serve`, now that extraction runs continuously
 * (src/labeling/scheduler.ts) instead of in passes: every
 * `extraction.intervalMinutes`, the duplicate-entity and duplicate-claim
 * audits over what was written since the last round, then the views that
 * depend on it — the Resolve and Merge-claims steps of the old pass
 * (docs/design/09, 10). A review offers all its judge calls at once (`judge`,
 * src/work/judge.ts), so `serve`'s judge slots and remote workers answer them
 * side by side instead of one after another.
 *
 * Summary pages are leased work of their own (src/work/summarize.ts): `serve`'s
 * summary slots and remote workers write them as they come, and their pages
 * are written in turn with the reviews (`serialize`), so a review and a
 * summary page never write at once. Only one review waits in line at a time,
 * and the next comes `intervalMinutes` after the last one ended: a review can
 * take longer than the interval (an LLM judge over many pairs), and reviews
 * queued on a clock used to pile up until nothing else got a turn
 * (2026-10-15: no summary for nine hours). A page write waits for at most
 * the review in progress.
 *
 * Reviews are model calls, so they run only while the workspace's processing
 * is started (`setActive`, src/labeling/processing.ts). Page writes run either
 * way: a remote worker may write a summary while processing is stopped.
 */

export interface FollowUpOptions {
  log?: (msg: string) => void;
  track?: <T>(job: Promise<T>) => Promise<T>;
  /** Run from the start (default true); `setActive` switches it later. */
  active?: boolean;
  /** Between the end of one review and the start of the next (default `extraction.intervalMinutes`). */
  reviewIntervalMs?: number;
  /**
   * Where a review's judge calls go: the judge source, so `serve`'s judge
   * slots and remote workers answer them side by side (src/work/judge.ts).
   * Absent, the Judge route one call at a time.
   */
  judge?: JudgeRunner;
  /** Called when the reviews are paused — the judge source gives up the calls nobody has taken. */
  onPause?: () => void;
  /**
   * What the audits embed entities and claims with: in deferred mode the
   * embed queue, so `serve`'s embed slots and remote workers make those
   * vectors too (src/work/embed.ts). Absent, `ctx.embedder`.
   */
  embedder?: EmbeddingProvider;
}

export interface FollowUp {
  stop(): void;
  /** Run or pause the reviews. A review already running finishes. */
  setActive(active: boolean): void;
  readonly active: boolean;
  /**
   * Run `fn` in turn with the reviews — never while one writes — whether or
   * not they are active. Once stopped, `fn` is skipped.
   */
  serialize(fn: () => Promise<void>): Promise<void>;
}

export function startFollowUp(ctx: AppContext, scheduler: LabelingScheduler, opts: FollowUpOptions = {}): FollowUp {
  const log = opts.log ?? (() => {});
  const track = opts.track ?? (<T>(job: Promise<T>) => job);
  let stopped = false;
  let active = opts.active ?? true;
  let chain: Promise<unknown> = Promise.resolve();
  /** Run `fn` after whatever is in line; skipped once stopped, and also while paused unless `always`. */
  const turn = (fn: () => Promise<void>, always: boolean): Promise<void> => {
    const run = chain.then(() => (stopped || (!always && !active) ? undefined : fn()));
    chain = run.catch(() => {});
    return run;
  };

  const review = async () => {
    const batch = scheduler.takeFinished();
    if (batch.written === 0 && batch.failed === 0) return;
    const parts = [`${batch.written} written${batch.failed ? `, ${batch.failed} given up` : ''}`];
    const reviewCtx = { store: ctx.store, embedder: opts.embedder ?? ctx.embedder, config: ctx.config, llm: ctx.llm, judge: opts.judge };
    if (batch.entityIds.length) {
      try {
        const r = await auditDuplicateEntities(reviewCtx, { focus: [...new Set(batch.entityIds)], onProgress: log });
        if (r.suggested || r.autoMerged || r.llmRejected) parts.push(`resolve: ${r.suggested} merge suggestions${r.autoMerged ? `, ${r.autoMerged} merged` : ''}${r.llmRejected ? `, ${r.llmRejected} rejected` : ''}${r.leftToPerson ? `, ${r.leftToPerson} remote verdicts left to a person` : ''}`);
      } catch (err) {
        log(`resolve failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (batch.claimIds.length) {
      try {
        const r = await auditDuplicateClaims(reviewCtx, { focus: [...new Set(batch.claimIds)], onProgress: log });
        if (r.merged || r.suggested || r.conflicts) parts.push(`claims: ${r.merged} merged, ${r.suggested} suggestions, ${r.conflicts} contradictions${r.leftToPerson ? ` (${r.leftToPerson} remote verdicts left to a person)` : ''}`);
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
      void track(turn(review, false)
        .catch((err) => log(`document review failed: ${err instanceof Error ? err.message : err}`))
        .finally(scheduleReview));
    }, intervalMs);
    reviewTimer.unref?.();
  };
  scheduleReview();

  return {
    stop: () => {
      stopped = true;
      if (reviewTimer) clearTimeout(reviewTimer);
    },
    setActive: (on: boolean) => {
      const pausing = active && !on;
      active = on;
      if (pausing) opts.onPause?.();
    },
    get active() {
      return active;
    },
    serialize: (fn) => track(turn(fn, true)),
  };
}
