import { AppContext } from '../context.js';
import { auditDuplicateClaims, ClaimDedupeStats } from '../graph/claim-dedupe.js';
import { auditDuplicateEntities, DedupeStats } from '../graph/dedupe.js';
import { runTier1Pass, Tier1Stats } from '../graph/tier1.js';
import { ensureCorpusPages } from '../wiki/corpus.js';
import { ensureEntityStubs, ensureSourceSummaries } from '../wiki/pages.js';

/** A tier-1 pass's stats, plus what the resolve and summary steps did. */
export interface DocumentPassStats extends Tier1Stats {
  /** The audit over the entities this pass wrote; null when it wrote none or the audit failed. */
  resolve: DedupeStats | null;
  /** The duplicate-claim audit over the claims this pass wrote; null when it wrote none or the audit failed. */
  claims: ClaimDedupeStats | null;
  /** Summary pages written. */
  summaries: string[];
  /** Entity pages created for the entities this pass wrote. */
  entityPages: string[];
  /** Pages across documents (mentions, timelines, disagreements) written for what this pass wrote. */
  corpusPages: string[];
}

export interface DocumentPassOptions {
  onProgress?: (msg: string) => void;
  /** Extraction calls — and summaries written — this pass; default `extraction.batchSize`. */
  batchSize?: number;
  /** Parallel model calls; default `extraction.concurrency`. */
  concurrency?: number;
}

/** Entity pages one pass creates at most: each is a file the next sync indexes and embeds. */
const ENTITY_PAGES_PER_PASS = 30;

// One pass at a time per data dir: serve's timer, `knode-os extract` and an
// initialization must not audit the same entities or summarize the same
// document twice. `runTier1Pass` keeps a chain of its own as well.
const passChains = new Map<string, Promise<unknown>>();

/**
 * The background document pass: everything that happens to a document after
 * sync has converted and indexed it, one batch at a time (docs/design/09).
 *
 * 1. Extract — a tier-1 pass makes up to `extraction.batchSize` extraction
 *    calls from the priority queue; a long document is read in segments over
 *    as many passes as it needs and written once all are in (docs/design/10).
 * 2. Resolve — the duplicate-entity audit, focused on the entities that pass
 *    wrote, judged by the Judge stage (`ctx.llm`) in `review.llmJudge`'s mode.
 *    What it produces are merge suggestions, or reversible merges in `auto`;
 *    write-time resolution stays exact.
 * 3. Merge claims — the duplicate-claim audit over the claims that pass
 *    wrote, in `review.claimMerge`'s mode (docs/design/10).
 * 4. Summarize — a summary page for up to `batchSize` documents, the ones
 *    this pass extracted first, on the Summarize stage's route.
 * 5. Entity pages — a page for each entity this pass wrote that claims from
 *    two documents or more now speak of: what no single document holds. No
 *    model: the page lists the entity's claims with their sources. Existing
 *    pages are brought up to date by the next sync, as any view is.
 * 6. Pages across documents — the mention pages of the families its
 *    entities belong to (created for those three documents or more name),
 *    the timeline periods its dated claims fall in, and the disagreement
 *    pages when one of its claims is in a conflict or disputed. No model.
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

  let claims: ClaimDedupeStats | null = null;
  if (extracted.touchedClaims.length > 0) {
    try {
      claims = await auditDuplicateClaims(
        { store: ctx.store, embedder: ctx.embedder, config, llm: ctx.llm },
        { focus: extracted.touchedClaims, onProgress: progress },
      );
    } catch (err) {
      progress(`claim merge failed: ${err instanceof Error ? err.message : err}`);
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

  let entityPages: string[] = [];
  if (extracted.touched.length > 0) {
    try {
      // only what a second document now speaks of: a page per entity of every new document would grow without end
      entityPages = await ensureEntityStubs({ ...ctx, config }, { focus: extracted.touched, minClaims: null, minMentions: null, max: ENTITY_PAGES_PER_PASS, actor: 'entities' });
    } catch (err) {
      progress(`entity pages failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  let corpusPages: string[] = [];
  if (extracted.touched.length > 0 || extracted.touchedClaims.length > 0) {
    try {
      corpusPages = await ensureCorpusPages({ ...ctx, config }, { focus: { entities: extracted.touched, claims: extracted.touchedClaims }, actor: 'corpus' });
    } catch (err) {
      progress(`corpus pages failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  return { ...extracted, resolve, claims, summaries, entityPages, corpusPages };
}

/** One log line for a pass, or null when it did nothing worth a line. */
export function describeDocumentPass(s: DocumentPassStats): string | null {
  const parts: string[] = [];
  if (s.processed || s.failed || s.calls) {
    parts.push(`${s.processed} written, ${s.failed} failed, ${s.calls} calls${s.callsFailed ? ` (${s.callsFailed} failed)` : ''}, ${s.queued} queued (${s.segmentsLeft} segments)`);
  }
  if (s.resolve && (s.resolve.suggested || s.resolve.autoMerged || s.resolve.llmRejected)) {
    parts.push(`resolve: ${s.resolve.suggested} merge suggestions${s.resolve.autoMerged ? `, ${s.resolve.autoMerged} merged` : ''}${s.resolve.llmRejected ? `, ${s.resolve.llmRejected} rejected` : ''}`);
  }
  if (s.claims && (s.claims.merged || s.claims.suggested || s.claims.conflicts)) {
    parts.push(`claims: ${s.claims.merged} merged, ${s.claims.suggested} suggestions, ${s.claims.conflicts} contradictions`);
  }
  if (s.summaries.length) parts.push(`${s.summaries.length} summaries`);
  if (s.entityPages.length) parts.push(`${s.entityPages.length} entity pages`);
  if (s.corpusPages?.length) parts.push(`${s.corpusPages.length} cross-document pages`);
  return parts.length ? `document pass: ${parts.join('; ')}` : null;
}
