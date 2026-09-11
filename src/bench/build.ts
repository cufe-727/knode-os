import { AppContext } from '../context.js';
import { readSidecar, replayableTier1 } from '../fs/sidecar.js';
import { enqueueTier1, runTier1Pass, Tier1Stats } from '../graph/tier1.js';
import { runIngest } from '../ingest/pipeline.js';
import { generateWiki } from '../wiki/generate.js';
import { refineWiki } from '../wiki/refine.js';
import { IngestStats } from '../types.js';
import { fmtDuration, mdTable, writeReport } from './util.js';

/**
 * `bench build` — run the full construction pipeline (tier-0 ingest → tier-1
 * extraction until the queue drains → wiki generate → tier-2 refine) with
 * per-stage timing and throughput, and write a report to eval/reports/.
 */

export interface BuildBenchOptions {
  /** Skip wiki generation/refinement stages. */
  skipWiki?: boolean;
  /** Stop tier-1 after this many passes (default: drain the queue). */
  maxTier1Passes?: number;
  onProgress?: (msg: string) => void;
}

export interface BuildBenchReport {
  startedAt: string;
  totalMs: number;
  corpus: { documents: number; chunks: number; entities: number; relations: number; claims: number };
  stages: {
    ingest: { ms: number; stats: IngestStats; docsPerMin: number; chunksPerMin: number };
    tier1: { ms: number; passes: number; processed: number; failed: number; entities: number; relations: number; tokensUsed: number; docsPerMin: number; queuedLeft: number };
    wikiGenerate?: { ms: number; pages: number };
    wikiRefine?: { ms: number; result: unknown };
  };
  reportPaths?: { jsonPath: string; mdPath: string };
}

export async function benchBuild(ctx: AppContext, opts: BuildBenchOptions = {}): Promise<BuildBenchReport> {
  const progress = opts.onProgress ?? (() => {});
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  progress('stage 1/4: tier-0 ingest (cook + chunk + embed + tier-0 graph)');
  const tIngest = Date.now();
  const ingest = await runIngest(ctx.store, ctx.config, ctx.embedder, ctx.llm, { onProgress: progress });
  const ingestMs = Date.now() - tIngest;

  // re-enqueue docs whose extraction failed or is missing (ingest only queues
  // *changed* docs, so an interrupted/failed earlier run would otherwise stall)
  const requeued = await requeueMissingTier1(ctx);
  if (requeued > 0) progress(`re-enqueued ${requeued} docs without a successful tier-1 extraction`);

  progress('stage 2/4: tier-1 LLM extraction (drain queue)');
  const tTier1 = Date.now();
  const tier1Total = { passes: 0, processed: 0, failed: 0, entities: 0, relations: 0, tokensUsed: 0, queuedLeft: 0 };
  for (;;) {
    if (opts.maxTier1Passes && tier1Total.passes >= opts.maxTier1Passes) break;
    const pass: Tier1Stats = await runTier1Pass(ctx.store, ctx.config, ctx.llm, { onProgress: progress });
    tier1Total.passes++;
    tier1Total.processed += pass.processed;
    tier1Total.failed += pass.failed;
    tier1Total.entities += pass.entities;
    tier1Total.relations += pass.relations;
    tier1Total.tokensUsed += pass.tokensUsed;
    tier1Total.queuedLeft = pass.queued;
    progress(`tier1 pass ${tier1Total.passes}: processed=${pass.processed} failed=${pass.failed} tokens=${pass.tokensUsed} queued=${pass.queued} budgetLeft=${pass.budgetLeft}`);
    if (pass.queued === 0 || (pass.processed === 0 && pass.failed === 0)) break;
  }
  const tier1Ms = Date.now() - tTier1;

  let wikiGenerate: BuildBenchReport['stages']['wikiGenerate'];
  let wikiRefine: BuildBenchReport['stages']['wikiRefine'];
  if (!opts.skipWiki) {
    progress('stage 3/4: wiki generate (source pages + entity stubs)');
    const tWiki = Date.now();
    const created = await generateWiki(ctx.store, ctx.llm, { config: ctx.config, onProgress: progress });
    wikiGenerate = { ms: Date.now() - tWiki, pages: created.length };

    progress('stage 4/4: tier-2 wiki refine (hot communities)');
    const tRefine = Date.now();
    const refined = await refineWiki(ctx.store, ctx.config, ctx.llm, { onProgress: progress });
    wikiRefine = { ms: Date.now() - tRefine, result: refined };
  }

  const [corpus] = await ctx.store.query<{ documents: number; chunks: number; entities: number; relations: number; claims: number }>(
    `SELECT
       (SELECT count(*)::int FROM documents WHERE status = 'indexed') AS documents,
       (SELECT count(*)::int FROM chunks) AS chunks,
       (SELECT count(*)::int FROM entities) AS entities,
       (SELECT count(*)::int FROM relations) AS relations,
       (SELECT count(*)::int FROM claims) AS claims`,
  );

  const perMin = (n: number, ms: number) => (ms > 0 ? Math.round((n / ms) * 60_000 * 10) / 10 : 0);
  const report: BuildBenchReport = {
    startedAt,
    totalMs: Date.now() - t0,
    corpus,
    stages: {
      ingest: { ms: ingestMs, stats: ingest, docsPerMin: perMin(ingest.indexed, ingestMs), chunksPerMin: perMin(ingest.chunks, ingestMs) },
      tier1: { ms: tier1Ms, ...tier1Total, docsPerMin: perMin(tier1Total.processed, tier1Ms) },
      ...(wikiGenerate ? { wikiGenerate } : {}),
      ...(wikiRefine ? { wikiRefine } : {}),
    },
  };
  report.reportPaths = writeReport(ctx.dataDir, 'build', report, renderMarkdown(report));
  return report;
}

async function requeueMissingTier1(ctx: AppContext): Promise<number> {
  if (!ctx.llm.enabled) return 0;
  const docs = await ctx.store.query<{ id: string; path: string; sha256: string }>(
    `SELECT d.id, d.path, d.sha256 FROM documents d
     WHERE d.root = 'docs' AND d.status = 'indexed'
       AND NOT EXISTS (SELECT 1 FROM extraction_queue q WHERE q.document_id = d.id)`,
  );
  let requeued = 0;
  for (const doc of docs) {
    const done = replayableTier1(readSidecar(ctx.dataDir, doc.path), doc.sha256);
    if (done) continue;
    await enqueueTier1(ctx.store, doc.id);
    requeued++;
  }
  return requeued;
}

function renderMarkdown(r: BuildBenchReport): string {
  const s = r.stages;
  const rows: (string | number)[][] = [
    ['tier-0 ingest', fmtDuration(s.ingest.ms), `${s.ingest.stats.indexed} docs, ${s.ingest.stats.chunks} chunks`, `${s.ingest.docsPerMin} docs/min, ${s.ingest.chunksPerMin} chunks/min`],
    ['tier-1 extract', fmtDuration(s.tier1.ms), `${s.tier1.processed} docs (${s.tier1.failed} failed), ${s.tier1.entities} entities, ${s.tier1.relations} relations, ~${s.tier1.tokensUsed} tokens`, `${s.tier1.docsPerMin} docs/min`],
  ];
  if (s.wikiGenerate) rows.push(['wiki generate', fmtDuration(s.wikiGenerate.ms), `${s.wikiGenerate.pages} pages`, '']);
  if (s.wikiRefine) rows.push(['wiki refine (tier-2)', fmtDuration(s.wikiRefine.ms), JSON.stringify(s.wikiRefine.result), '']);
  return `# Build benchmark — ${r.startedAt}

Total: **${fmtDuration(r.totalMs)}**

${mdTable(['stage', 'duration', 'output', 'throughput'], rows)}

## Corpus after build

${mdTable(['documents', 'chunks', 'entities', 'relations', 'claims'],
  [[r.corpus.documents, r.corpus.chunks, r.corpus.entities, r.corpus.relations, r.corpus.claims]])}

Tier-1 queue left: ${s.tier1.queuedLeft} (0 = fully drained; >0 = budget/passes exhausted)
`;
}
