import { ensureCorpusPages } from '../wiki/corpus.js';
import { ensureEntityStubs, PagesContext, refreshSummaryClaims } from '../wiki/pages.js';
import { supersedeForClaims } from '../wiki/refine.js';

/** What an extraction round wrote: the input of everything that follows it. */
export interface Extracted {
  entityIds: string[];
  claimIds: string[];
  /** Paths of the documents extracted. */
  documents: string[];
}

export interface AfterExtractionStats {
  /** Supersession marks changed among the subjects the round wrote claims of. */
  superseded: number;
  /** Summary pages written by `summarize`; empty when the caller gave none. */
  summaries: string[];
  /** Entity pages created for the entities the round wrote. */
  entityPages: string[];
  /** Pages across documents (mentions, timelines, disagreements) written for what the round wrote. */
  corpusPages: string[];
}

export interface AfterExtractionOptions {
  onProgress?: (msg: string) => void;
  /**
   * The Summarize step of a pass that writes summary pages itself, run in its
   * place: after supersession, before the pages that list claims. `serve`
   * gives none — its summaries are leased work (src/work/summarize.ts).
   */
  summarize?: () => Promise<string[]>;
}

/** Entity pages one round creates at most: each is a file the next sync indexes and embeds. */
const ENTITY_PAGES_PER_ROUND = 30;

/**
 * What follows an extraction round once the duplicate audits have run, for
 * what the round wrote and with no model call of its own. One list of steps
 * for both ways extraction runs — a pass (`runDocumentPass`: `knode-os
 * extract`, an initialization, an evaluation build) and `serve`'s continuous
 * slots (src/labeling/followup.ts) — so that a step added here is run by both.
 * Until 2026-11-17 `serve` ran none of them: a new report's value stood as
 * current beside the ones before it until the nightly refine reached its
 * subject, and entity pages and pages across documents appeared only when
 * `wiki generate` or an initialization made them.
 *
 * 1. Supersession over the series of the subjects the new claims are about
 *    (src/wiki/refine.ts `supersedeForClaims`, docs/design/29 §2.1). After the
 *    merges: a claim merged into another takes no part in a series.
 * 2. `summarize`, when the caller writes summary pages itself.
 * 3. The new claims on their documents' existing summary pages, re-rendered
 *    from the cached summaries (a page written in step 2 is already current).
 * 4. A page for each entity the round wrote that claims from two documents or
 *    more now speak of. Only those: a page per entity of every new document
 *    would grow without end.
 * 5. Pages across documents — mentions, timelines, disagreements — that what
 *    the round wrote belongs on.
 *
 * A step that fails is reported through `onProgress` and the rest still run.
 */
export async function afterExtraction(ctx: PagesContext, written: Extracted, opts: AfterExtractionOptions = {}): Promise<AfterExtractionStats> {
  const progress = opts.onProgress ?? (() => {});
  const failed = (step: string, err: unknown) => progress(`${step} failed: ${err instanceof Error ? err.message : err}`);
  const stats: AfterExtractionStats = { superseded: 0, summaries: [], entityPages: [], corpusPages: [] };

  if (written.claimIds.length > 0) {
    try {
      const marks = await supersedeForClaims(ctx.store, written.claimIds);
      stats.superseded = marks.superseded;
      if (marks.superseded) progress(`supersession: ${marks.superseded} marks updated over ${marks.subjects} subjects`);
    } catch (err) {
      failed('supersession', err);
    }
  }

  if (opts.summarize) {
    try {
      stats.summaries = await opts.summarize();
    } catch (err) {
      failed('summaries', err);
    }
  }

  try {
    await refreshSummaryClaims(ctx, written.documents, { actor: 'summarize' });
  } catch (err) {
    failed('summary claims', err);
  }

  if (written.entityIds.length > 0) {
    try {
      stats.entityPages = await ensureEntityStubs(ctx, { focus: written.entityIds, minClaims: null, minMentions: null, max: ENTITY_PAGES_PER_ROUND, actor: 'entities' });
    } catch (err) {
      failed('entity pages', err);
    }
  }

  if (written.entityIds.length > 0 || written.claimIds.length > 0) {
    try {
      stats.corpusPages = await ensureCorpusPages(ctx, { focus: { entities: written.entityIds, claims: written.claimIds }, actor: 'corpus' });
    } catch (err) {
      failed('corpus pages', err);
    }
  }

  return stats;
}
