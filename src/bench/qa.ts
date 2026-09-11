import crypto from 'node:crypto';
import { AppContext } from '../context.js';
import { search, SearchMode } from '../search/search.js';
import { graphSearch } from '../graph/query.js';
import { loadQaSet, mapLimit, mdTable, platformOfPath, QaItem, saveQaSet, summarizeLatency, writeReport } from './util.js';

/**
 * `bench qa-gen` — build a QA evaluation set: stratified chunk sampling per
 * platform, one LLM-generated question per chunk, grounded to that chunk as
 * the retrieval ground truth. The set is persisted to eval/qa.jsonl and reused
 * across runs so retrieval metrics stay comparable.
 *
 * `bench retrieval` — replay the QA set against vector / keyword / hybrid /
 * SAG / graph retrieval and report recall@k, MRR and NDCG@10 at chunk and document
 * granularity.
 */

const QA_SYSTEM = `你是检索评测集构造器。给定一段来自投资社区的内容片段，构造一个可以且只能由这段内容回答的问题。

规则：
- 问题必须具体（涉及片段中的公司/行业/观点/数据/事件），像一个投研人员真实会问的问题。
- 不要出"这段话说了什么"之类的元问题；不要在问题里引用"该片段/作者"字样，问题要独立成立。
- answer 用片段原文信息作答，1-3 句。
- 若片段内容太琐碎（纯寒暄、纯表情、无信息量），输出 {"skip": true}。
只输出 JSON：{"question": "...", "answer": "..."} 或 {"skip": true}`;

export interface QaGenOptions {
  n?: number;
  minChunkChars?: number;
  concurrency?: number;
  onProgress?: (msg: string) => void;
}

export async function benchQaGen(ctx: AppContext, opts: QaGenOptions = {}): Promise<{ file: string; items: QaItem[]; sampled: number; skipped: number; failed: number }> {
  const progress = opts.onProgress ?? (() => {});
  const target = opts.n ?? 100;
  const minChars = opts.minChunkChars ?? 200;
  if (!ctx.llm.enabled) throw new Error('qa-gen needs a configured LLM (llm.model)');

  const chunks = await ctx.store.query<{ id: string; document_id: string; path: string; content: string }>(
    `SELECT c.id, c.document_id, d.path, c.content
     FROM chunks c JOIN documents d ON d.id = c.document_id
     WHERE d.root = 'docs' AND length(c.content) >= $1`,
    [minChars],
  );
  if (chunks.length === 0) throw new Error('no chunks to sample — run ingest first');

  // stratified proportional sampling per platform, deterministic order
  const byPlatform = new Map<string, typeof chunks>();
  for (const c of chunks) {
    const p = platformOfPath(c.path);
    if (!byPlatform.has(p)) byPlatform.set(p, []);
    byPlatform.get(p)!.push(c);
  }
  const sampled: typeof chunks = [];
  // oversample: some candidates get skipped by the LLM as low-information
  const wanted = Math.min(chunks.length, Math.ceil(target * 1.5));
  for (const [, list] of [...byPlatform.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const quota = Math.max(1, Math.round((list.length / chunks.length) * wanted));
    const shuffled = [...list].sort((a, b) => shuffleKey(a.id).localeCompare(shuffleKey(b.id)));
    sampled.push(...shuffled.slice(0, quota));
  }
  progress(`sampling ${sampled.length} candidate chunks across ${byPlatform.size} platforms (target ${target} QA)`);

  let skipped = 0;
  let failed = 0;
  const items: QaItem[] = [];
  await mapLimit(sampled, opts.concurrency ?? 8, async (c) => {
    if (items.length >= target) return;
    const res = await ctx.llm.completeJson<{ question?: string; answer?: string; skip?: boolean }>([
      { role: 'system', content: QA_SYSTEM },
      { role: 'user', content: `内容片段（来源 ${c.path}）：\n\n${c.content.slice(0, 2500)}` },
    ], { maxTokens: 500 });
    if (res.skip || !res.question || !res.answer) {
      skipped++;
      return;
    }
    if (items.length >= target) return;
    items.push({
      id: crypto.createHash('sha256').update(c.id).digest('hex').slice(0, 12),
      question: res.question.trim(),
      answer: res.answer.trim(),
      chunkId: c.id,
      documentId: c.document_id,
      path: c.path,
      platform: platformOfPath(c.path),
    });
    if (items.length % 10 === 0) progress(`generated ${items.length}/${target}`);
  }, () => { failed++; });

  const file = saveQaSet(ctx.dataDir, items.slice(0, target));
  progress(`QA set: ${Math.min(items.length, target)} items → ${file} (skipped ${skipped}, failed ${failed})`);
  return { file, items: items.slice(0, target), sampled: sampled.length, skipped, failed };
}

/** Deterministic pseudo-shuffle key so sampling is stable across runs. */
function shuffleKey(id: string): string {
  return crypto.createHash('md5').update('knode-qa-' + id).digest('hex');
}

export type RetrievalMode = SearchMode | 'graph';

export interface RetrievalMetrics {
  mode: string;
  n: number;
  recallChunk: Record<string, number>;
  recallDoc: Record<string, number>;
  mrrChunk: number;
  mrrDoc: number;
  ndcgChunk10: number;
  latency: { avg: number; p50: number; p95: number };
}

export interface RetrievalReport {
  startedAt: string;
  qaCount: number;
  ks: number[];
  modes: RetrievalMetrics[];
  perPlatformHybridRecall: Record<string, { n: number; recallDoc: number }>;
  reportPaths?: { jsonPath: string; mdPath: string };
}

export async function benchRetrieval(
  ctx: AppContext,
  opts: { ks?: number[]; modes?: RetrievalMode[]; onProgress?: (msg: string) => void } = {},
): Promise<RetrievalReport> {
  const progress = opts.onProgress ?? (() => {});
  const qa = loadQaSet(ctx.dataDir);
  const ks = opts.ks ?? [5, 10];
  const maxK = Math.max(...ks, 10);
  const modes = opts.modes ?? (['vector', 'keyword', 'hybrid', 'sag', 'graph'] as RetrievalMode[]);

  const report: RetrievalReport = {
    startedAt: new Date().toISOString(),
    qaCount: qa.length,
    ks,
    modes: [],
    perPlatformHybridRecall: {},
  };

  for (const mode of modes) {
    progress(`mode ${mode}: ${qa.length} queries`);
    const latencies: number[] = [];
    const chunkRanks: (number | null)[] = [];
    const docRanks: (number | null)[] = [];
    const hybridDocHit: { platform: string; hit: boolean }[] = [];

    for (const item of qa) {
      const t = Date.now();
      let ranked: { chunkId: string; documentId: string }[];
      if (mode === 'graph') {
        const g = await graphSearch(ctx.store, item.question, { depth: 2, chunkLimit: maxK, heat: ctx.config.heat, track: false });
        ranked = g.chunks.map((c) => ({ chunkId: c.chunkId, documentId: c.documentId }));
      } else {
        ranked = await search(ctx.store, ctx.embedder, item.question, {
          k: maxK,
          mode,
          heat: ctx.config.heat,
          sag: ctx.config.retrieval.sag,
          track: false,
        });
      }
      latencies.push(Date.now() - t);

      const cRank = ranked.findIndex((r) => r.chunkId === item.chunkId);
      const dRank = ranked.findIndex((r) => r.documentId === item.documentId);
      chunkRanks.push(cRank >= 0 ? cRank + 1 : null);
      docRanks.push(dRank >= 0 ? dRank + 1 : null);
      if (mode === 'hybrid') hybridDocHit.push({ platform: item.platform, hit: dRank >= 0 && dRank < 10 });
    }

    const recallAt = (ranks: (number | null)[], k: number) =>
      Math.round((ranks.filter((r) => r !== null && r <= k).length / ranks.length) * 1000) / 1000;
    const mrr = (ranks: (number | null)[]) =>
      Math.round((ranks.reduce<number>((s, r) => s + (r ? 1 / r : 0), 0) / ranks.length) * 1000) / 1000;
    // single relevant item per query → NDCG@10 = 1/log2(rank+1) averaged
    const ndcg10 = (ranks: (number | null)[]) =>
      Math.round((ranks.reduce<number>((s, r) => s + (r && r <= 10 ? 1 / Math.log2(r + 1) : 0), 0) / ranks.length) * 1000) / 1000;

    report.modes.push({
      mode,
      n: qa.length,
      recallChunk: Object.fromEntries(ks.map((k) => [`@${k}`, recallAt(chunkRanks, k)])),
      recallDoc: Object.fromEntries(ks.map((k) => [`@${k}`, recallAt(docRanks, k)])),
      mrrChunk: mrr(chunkRanks),
      mrrDoc: mrr(docRanks),
      ndcgChunk10: ndcg10(chunkRanks),
      latency: summarizeLatency(latencies),
    });

    if (mode === 'hybrid') {
      const byP = new Map<string, { n: number; hits: number }>();
      for (const h of hybridDocHit) {
        const cur = byP.get(h.platform) ?? { n: 0, hits: 0 };
        cur.n++;
        if (h.hit) cur.hits++;
        byP.set(h.platform, cur);
      }
      report.perPlatformHybridRecall = Object.fromEntries(
        [...byP.entries()].map(([p, v]) => [p, { n: v.n, recallDoc: Math.round((v.hits / v.n) * 1000) / 1000 }]),
      );
    }
  }

  report.reportPaths = writeReport(ctx.dataDir, 'retrieval', report, renderRetrievalMarkdown(report));
  return report;
}

function renderRetrievalMarkdown(r: RetrievalReport): string {
  const rows = r.modes.map((m) => [
    m.mode,
    ...r.ks.map((k) => m.recallChunk[`@${k}`]),
    ...r.ks.map((k) => m.recallDoc[`@${k}`]),
    m.mrrChunk,
    m.mrrDoc,
    m.ndcgChunk10,
    `${m.latency.p50}/${m.latency.p95}ms`,
  ]);
  const headers = [
    'mode',
    ...r.ks.map((k) => `chunk R@${k}`),
    ...r.ks.map((k) => `doc R@${k}`),
    'chunk MRR',
    'doc MRR',
    'chunk NDCG@10',
    'p50/p95',
  ];
  const platRows = Object.entries(r.perPlatformHybridRecall).map(([p, v]) => [p, v.n, v.recallDoc]);
  return `# Retrieval benchmark — ${r.startedAt}

QA set: ${r.qaCount} questions (ground truth = the chunk each question was generated from)

${mdTable(headers, rows)}

## Hybrid doc recall@10 per platform

${mdTable(['platform', 'questions', 'doc R@10'], platRows)}
`;
}
