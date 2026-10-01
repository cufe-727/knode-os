import { AppContext } from '../context.js';
import { auditDuplicateEntities, DedupeStats } from '../graph/dedupe.js';
import { runTier1Pass, Tier1Stats } from '../graph/tier1.js';
import { ensureSourceSummaries } from '../wiki/pages.js';

/** A tier-1 pass's stats, plus what the resolve and summary steps did. */
export interface DocumentPassStats extends Tier1Stats {
  /** The audit over the entities this pass wrote; null when it wrote none or the audit failed. */
  resolve: DedupeStats | null;
  /** Summary pages written. */
  summaries: string[];
}

export interface DocumentPassOptions {
  onProgress?: (msg: string) => void;
  /** Documents extracted — and summaries written — this pass; default `extraction.batchSize`. */
  batchSize?: number;
  /** Parallel model calls; default `extraction.concurrency`. */
  concurrency?: number;
}

// One pass at a time per data dir: serve's timer, `knode-os extract` and an
// initialization must not audit the same entities or summarize the same
// document twice. `runTier1Pass` keeps a chain of its own as well.
const passChains = new Map<string, Promise<unknown>>();

/**
 * The background document pass: everything that happens to a document after
 * sync has converted and indexed it, one batch at a time (docs/design/09).
 *
 * 1. Extract — a tier-1 pass drains up to `extraction.batchSize` documents
 *    from the priority queue.
 * 2. Resolve — the duplicate-entity audit, focused on the entities that pass
 *    wrote, judged by the Judge stage (`ctx.llm`) in `review.llmJudge`'s mode.
 *    What it produces are merge suggestions, or reversible merges in `auto`;
 *    write-time resolution stays exact.
 * 3. Summarize — a summary page for up to the same number of documents, the
 *    ones this pass extracted first, on the Summarize stage's route.
 *
 * Serve runs it every `extraction.intervalMinutes`, `knode-os extract` runs it
 * once, and an initialization runs it until the extraction queue is empty.
 */
export function runDocumentPass(ctx: AppContext, opts: DocumentPassOptions = {}): Promise<DocumentPassStats> {
  const previous = passChains.get(ctx.dataDir) ?? Promise.resolve();
  const run = previous.then(() => runDocumentPassUnlocked(ctx, opts));
  passChains.set(ctx.dataDir, run.catch(() => {}));
  return run;
}

async function runDocumentPassUnlocked(ctx: AppContext, opts: DocumentPassOptions): Promise<DocumentPassStats> {
  const progress = opts.onProgress ?? (() => {});
  // read once: a save may swap `ctx.config` while the pass runs
  const config = ctx.config;
  const batchSize = opts.batchSize ?? config.extraction.batchSize;
  const concurrency = opts.concurrency ?? config.extraction.concurrency;

  const extracted = await runTier1Pass(ctx.store, config, ctx.llm, { onProgress: progress, batchSize, concurrency });

  let resolve: DedupeStats | null = null;
  if (extracted.touched.length > 0) {
    try {
      resolve = await auditDuplicateEntities(
        { store: ctx.store, embedder: ctx.embedder, config, llm: ctx.llm },
        { focus: extracted.touched, onProgress: progress },
      );
    } catch (err) {
      progress(`resolve failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  let summaries: string[] = [];
  try {
    summaries = await ensureSourceSummaries(
      { ...ctx, config },
      { limit: batchSize, prefer: extracted.documents, concurrency, actor: 'summarize', onProgress: progress },
    );
  } catch (err) {
    progress(`summaries failed: ${err instanceof Error ? err.message : err}`);
  }

  return { ...extracted, resolve, summaries };
}

/** One log line for a pass, or null when it did nothing worth a line. */
export function describeDocumentPass(s: DocumentPassStats): string | null {
  const parts: string[] = [];
  if (s.processed || s.failed) parts.push(`${s.processed} extracted, ${s.failed} failed, ${s.queued} queued`);
  if (s.resolve && (s.resolve.suggested || s.resolve.autoMerged || s.resolve.llmRejected)) {
    parts.push(`resolve: ${s.resolve.suggested} merge suggestions${s.resolve.autoMerged ? `, ${s.resolve.autoMerged} merged` : ''}${s.resolve.llmRejected ? `, ${s.resolve.llmRejected} rejected` : ''}`);
  }
  if (s.summaries.length) parts.push(`${s.summaries.length} summaries`);
  return parts.length ? `document pass: ${parts.join('; ')}` : null;
}
