import crypto from 'node:crypto';
import { AppContext } from '../context.js';
import { ask } from '../search/ask.js';
import { loadQaSet, mapLimit, mdTable, QaItem, summarizeLatency, writeReport } from './util.js';

/**
 * `bench answer` — end-to-end RAG quality: run `ask` over a sample of the QA
 * set and grade each answer with an LLM judge against the reference answer.
 * Also measures citation validity: did the answer cite the document the
 * question was generated from?
 */

const JUDGE_SYSTEM = `你是问答评测裁判。给定问题、参考答案和被测系统的回答，给回答打分。

评分标准（correctness，0-2 整数）：
- 2 = 回答包含参考答案的关键信息，无实质性错误
- 1 = 部分正确：包含部分关键信息，或有轻微错误/遗漏
- 0 = 错误、答非所问、或声称无法回答（而参考答案表明可以回答）

只输出 JSON：{"correctness": 0|1|2, "reason": "一句话理由"}`;

export interface AnswerBenchItem {
  qaId: string;
  question: string;
  correctness: number;
  citedGoldDoc: boolean;
  citations: number;
  gaps: number;
  latencyMs: number;
  reason: string;
}

export interface AnswerBenchReport {
  startedAt: string;
  n: number;
  failed: number;
  avgCorrectness: number;
  scoreDist: Record<string, number>;
  goldCitationRate: number;
  avgCitations: number;
  latency: { avg: number; p50: number; p95: number };
  items: AnswerBenchItem[];
  reportPaths?: { jsonPath: string; mdPath: string };
}

export async function benchAnswer(
  ctx: AppContext,
  opts: { n?: number; concurrency?: number; judgeModel?: string; onProgress?: (msg: string) => void } = {},
): Promise<AnswerBenchReport> {
  const progress = opts.onProgress ?? (() => {});
  if (!ctx.llm.enabled) throw new Error('bench answer needs a configured LLM');
  const qa = loadQaSet(ctx.dataDir);
  const n = Math.min(opts.n ?? 20, qa.length);
  const sample = [...qa]
    .sort((a, b) => shuffleKey(a.id).localeCompare(shuffleKey(b.id)))
    .slice(0, n);

  let failed = 0;
  const results = await mapLimit(sample, opts.concurrency ?? 4, async (item: QaItem, i) => {
    const t = Date.now();
    const res = await ask(ctx.store, ctx.config, ctx.embedder, ctx.llm, item.question);
    const latencyMs = Date.now() - t;

    const judge = await ctx.llm.completeJson<{ correctness?: number; reason?: string }>([
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: `问题：${item.question}\n\n参考答案：${item.answer}\n\n被测回答：${res.answer.slice(0, 3000)}` },
    ], { maxTokens: 300, model: opts.judgeModel });

    const correctness = Math.max(0, Math.min(2, Math.round(Number(judge.correctness ?? 0))));
    const citedGoldDoc = res.citations.some((c) => c.path === item.path);
    progress(`[${i + 1}/${n}] score=${correctness} goldCited=${citedGoldDoc} ${item.question.slice(0, 40)}…`);
    return {
      qaId: item.id,
      question: item.question,
      correctness,
      citedGoldDoc,
      citations: res.citations.length,
      gaps: res.gaps.length,
      latencyMs,
      reason: (judge.reason ?? '').slice(0, 200),
    } satisfies AnswerBenchItem;
  }, (err, item) => {
    failed++;
    progress(`failed: ${item.question.slice(0, 40)}… (${err instanceof Error ? err.message : err})`);
  });

  const items = results.filter((r): r is AnswerBenchItem => r !== undefined);
  const dist: Record<string, number> = { '0': 0, '1': 0, '2': 0 };
  for (const it of items) dist[String(it.correctness)]++;
  const report: AnswerBenchReport = {
    startedAt: new Date().toISOString(),
    n: items.length,
    failed,
    avgCorrectness: items.length ? Math.round((items.reduce((s, i) => s + i.correctness, 0) / items.length) * 100) / 100 : 0,
    scoreDist: dist,
    goldCitationRate: items.length ? Math.round((items.filter((i) => i.citedGoldDoc).length / items.length) * 1000) / 1000 : 0,
    avgCitations: items.length ? Math.round((items.reduce((s, i) => s + i.citations, 0) / items.length) * 10) / 10 : 0,
    latency: summarizeLatency(items.map((i) => i.latencyMs)),
    items,
  };
  report.reportPaths = writeReport(ctx.dataDir, 'answer', report, renderMarkdown(report));
  return report;
}

function shuffleKey(id: string): string {
  return crypto.createHash('md5').update('knode-answer-' + id).digest('hex');
}

function renderMarkdown(r: AnswerBenchReport): string {
  const rows = r.items.map((i) => [
    i.question.slice(0, 50).replace(/\|/g, '\\|'),
    i.correctness,
    i.citedGoldDoc ? 'yes' : 'no',
    i.citations,
    `${i.latencyMs}ms`,
    i.reason.slice(0, 60).replace(/\|/g, '\\|'),
  ]);
  return `# Answer benchmark — ${r.startedAt}

- questions: ${r.n} (failed: ${r.failed})
- avg correctness (0-2): **${r.avgCorrectness}** — dist 2/1/0 = ${r.scoreDist['2']}/${r.scoreDist['1']}/${r.scoreDist['0']}
- gold-doc citation rate: **${r.goldCitationRate}**
- avg citations per answer: ${r.avgCitations}
- latency p50/p95: ${r.latency.p50}/${r.latency.p95}ms

${mdTable(['question', 'score', 'gold cited', 'citations', 'latency', 'judge reason'], rows)}
`;
}
