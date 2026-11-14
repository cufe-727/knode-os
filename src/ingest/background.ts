import { AppContext } from '../context.js';
import { auditDuplicateClaims, ClaimDedupeStats } from '../graph/claim-dedupe.js';
import { auditDuplicateEntities, DedupeStats } from '../graph/dedupe.js';
import { runTier1Pass, Tier1Stats } from '../graph/tier1.js';
import { ensureCorpusPages } from '../wiki/corpus.js';
import { refreshNavigationIfChanged } from '../wiki/navigation.js';
import { ensureEntityStubs, ensureSourceSummaries, refreshSummaryClaims } from '../wiki/pages.js';
import { supersedeForClaims } from '../wiki/refine.js';

/** A tier-1 pass's stats, plus what the resolve and summary steps did. */
export interface DocumentPassStats extends Tier1Stats {
  /** The audit over the entities this pass wrote; null when it wrote none or the audit failed. */
  resolve: DedupeStats | null;
  /** The duplicate-claim audit over the claims this pass wrote; null when it wrote none or the audit failed. */
  claims: ClaimDedupeStats | null;
  /** Supersession marks changed among the subjects this pass wrote claims of. */
  superseded: number;
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
 *    wrote, in `review.claimMerge`'s mode (docs/design/10). Then
 *    supersession over the series of the subjects those claims are about
 *    (src/wiki/refine.ts supersedeForClaims): a new report's value becomes
 *    the current one now, not at the next refine. No model, and no setting:
 *    it is part of a pass that writes claims, whether or not the nightly
 *    pass is scheduled (docs/design/29 §2.1 says what that changes for a
 *    workspace that exists already).
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
 * 7. Navigation — the indexes, the contents of wiki/index.md and the
 *    overview's holdings (src/wiki/navigation.ts), when the pass wrote
 *    anything and what they count has changed.
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

  // after the merges: a claim merged into another takes no part in a series
  let superseded = 0;
  if (extracted.touchedClaims.length > 0) {
    try {
      const marks = await supersedeForClaims(ctx.store, extracted.touchedClaims);
      superseded = marks.superseded;
      if (superseded) progress(`supersession: ${superseded} marks updated over ${marks.subjects} subjects`);
    } catch (err) {
      progress(`supersession failed: ${err instanceof Error ? err.message : err}`);
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
  try {
    // the claims just extracted go on their documents' existing summary pages, from the cached summaries
    // (a page written above is already current: its regeneration is 'unchanged')
    await refreshSummaryClaims({ ...ctx, config }, extracted.documents, { actor: 'summarize' });
  } catch (err) {
    progress(`summary claims failed: ${err instanceof Error ? err.message : err}`);
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

  if (extracted.processed || summaries.length || entityPages.length || corpusPages.length) {
    try {
      const nav = await refreshNavigationIfChanged({ ...ctx, config }, { actor: 'entities' });
      if (nav.written.length || nav.archived.length) progress(`navigation: ${nav.written.length} index pages written, ${nav.archived.length} archived`);
    } catch (err) {
      progress(`navigation failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  return { ...extracted, resolve, claims, superseded, summaries, entityPages, corpusPages };
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
  if (s.superseded) parts.push(`${s.superseded} supersession marks`);
  if (s.summaries.length) parts.push(`${s.summaries.length} summaries`);
  if (s.entityPages.length) parts.push(`${s.entityPages.length} entity pages`);
  if (s.corpusPages?.length) parts.push(`${s.corpusPages.length} cross-document pages`);
  return parts.length ? `document pass: ${parts.join('; ')}` : null;
}
