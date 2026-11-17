import crypto from 'node:crypto';
import { AppContext } from '../context.js';
import { loadSourceText } from '../ingest/source.js';
import { LlmProvider } from '../config.js';
import { llmExtract } from '../graph/llm-extract.js';
import { LlmClient } from '../llm/client.js';
import { mapLimit, mdTable, summarizeLatency, writeReport } from './util.js';

/**
 * `bench extract-compare` — run tier-1 extraction over the same document
 * sample with multiple LLM backends (openai router model vs codex-cli vs
 * claude-cli vs cursor-cli) and compare latency, output volume, failure rate and judged
 * quality (LLM judge scores coverage + precision per extraction).
 */

const JUDGE_SYSTEM = `你是知识图谱抽取质量裁判。给定原文档和一次实体/关系/断言抽取结果，从两个维度打分（1-5 整数）：
- coverage：文档中重要的实体/关系/观点被抽取的完整程度（5=关键信息基本无遗漏）
- precision：抽取结果的准确性（5=无编造、类型正确、描述忠实原文）
只输出 JSON：{"coverage": 1-5, "precision": 1-5, "comment": "一句话"}`;

export interface BackendSpec {
  name: string;
  provider: LlmProvider;
  model?: string;
}

export interface BackendResult {
  name: string;
  docs: number;
  failed: number;
  latency: { avg: number; p50: number; p95: number };
  avgEntities: number;
  avgRelations: number;
  avgClaims: number;
  avgCoverage: number;
  avgPrecision: number;
  samples: { path: string; ms: number; entities: number; relations: number; claims: number; coverage: number; precision: number; comment: string; error?: string }[];
}

export interface ExtractCompareReport {
  startedAt: string;
  docCount: number;
  backends: BackendResult[];
  reportPaths?: { jsonPath: string; mdPath: string };
}

export async function benchExtractCompare(
  ctx: AppContext,
  opts: { n?: number; backends?: BackendSpec[]; concurrency?: number; onProgress?: (msg: string) => void } = {},
): Promise<ExtractCompareReport> {
  const progress = opts.onProgress ?? (() => {});
  const n = opts.n ?? 20;
  const backends = opts.backends ?? defaultBackends(ctx);
  if (!ctx.llm.enabled) throw new Error('extract-compare needs a configured LLM (also used as judge)');

  const docs = await ctx.store.query<{ id: string; path: string; title: string | null }>(
    `SELECT id, path, title FROM documents
     WHERE root = 'docs' AND status = 'indexed'`,
  );
  const sample = docs
    .sort((a, b) => shuffleKey(a.id).localeCompare(shuffleKey(b.id)))
    .slice(0, Math.min(n, docs.length))
    .map((d) => ({ ...d, content: loadSourceText(ctx.dataDir, d.path, 'docs')?.text ?? '' }))
    .filter((d) => d.content);
  progress(`comparing ${backends.map((b) => b.name).join(' vs ')} on ${sample.length} documents`);

  const report: ExtractCompareReport = { startedAt: new Date().toISOString(), docCount: sample.length, backends: [] };

  for (const spec of backends) {
    const client = spec.provider === 'openai' && (!spec.model || spec.model === ctx.config.llm.model)
      ? ctx.llm
      : new LlmClient({ ...ctx.config.llm, provider: spec.provider, model: spec.model ?? '' });
    // CLI backends are serial one-shot processes; API backends can fan out
    const concurrency = spec.provider === 'openai' ? (opts.concurrency ?? 4) : 1;
    progress(`backend ${spec.name} (concurrency ${concurrency})…`);

    const samples: BackendResult['samples'] = [];
    await mapLimit(sample, concurrency, async (doc) => {
      const t = Date.now();
      try {
        const ext = await llmExtract(client, { path: doc.path, title: doc.title ?? doc.path }, doc.content, { claims: true });
        const ms = Date.now() - t;
        const judge = await ctx.llm.completeJson<{ coverage?: number; precision?: number; comment?: string }>([
          { role: 'system', content: JUDGE_SYSTEM },
          { role: 'user', content: `# 原文档（截断）\n${doc.content.slice(0, 6000)}\n\n# 抽取结果\n${JSON.stringify(ext, null, 1).slice(0, 4000)}` },
        ], { maxTokens: 300 });
        samples.push({
          path: doc.path,
          ms,
          entities: ext.entities.length,
          relations: ext.relations.length,
          claims: ext.claims.length,
          coverage: clamp15(judge.coverage),
          precision: clamp15(judge.precision),
          comment: (judge.comment ?? '').slice(0, 120),
        });
        progress(`  ${spec.name} ${doc.path}: ${ext.entities.length}e/${ext.relations.length}r/${ext.claims.length}c in ${ms}ms`);
      } catch (err) {
        samples.push({
          path: doc.path, ms: Date.now() - t, entities: 0, relations: 0, claims: 0,
          coverage: 0, precision: 0, comment: '', error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
        });
        progress(`  ${spec.name} ${doc.path}: FAILED`);
      }
    });

    const ok = samples.filter((s) => !s.error);
    const avg = (f: (s: (typeof ok)[number]) => number) =>
      ok.length ? Math.round((ok.reduce((sum, s) => sum + f(s), 0) / ok.length) * 10) / 10 : 0;
    report.backends.push({
      name: spec.name,
      docs: samples.length,
      failed: samples.length - ok.length,
      latency: summarizeLatency(ok.map((s) => s.ms)),
      avgEntities: avg((s) => s.entities),
      avgRelations: avg((s) => s.relations),
      avgClaims: avg((s) => s.claims),
      avgCoverage: avg((s) => s.coverage),
      avgPrecision: avg((s) => s.precision),
      samples,
    });
  }

  report.reportPaths = writeReport(ctx.dataDir, 'extract-compare', report, renderMarkdown(report));
  return report;
}

function defaultBackends(ctx: AppContext): BackendSpec[] {
  return [
    { name: `openai:${ctx.config.llm.model}`, provider: 'openai', model: ctx.config.llm.model },
    { name: 'codex-cli', provider: 'codex-cli' },
    { name: 'claude-cli', provider: 'claude-cli' },
  ];
}

function clamp15(v: unknown): number {
  const num = Math.round(Number(v ?? 0));
  return Math.max(1, Math.min(5, Number.isFinite(num) ? num : 1));
}

function shuffleKey(id: string): string {
  return crypto.createHash('md5').update('knode-extract-' + id).digest('hex');
}

function renderMarkdown(r: ExtractCompareReport): string {
  const rows = r.backends.map((b) => [
    b.name,
    `${b.docs - b.failed}/${b.docs}`,
    `${b.latency.p50}/${b.latency.p95}ms`,
    b.avgEntities,
    b.avgRelations,
    b.avgClaims,
    b.avgCoverage,
    b.avgPrecision,
  ]);
  return `# Extraction backend comparison — ${r.startedAt}

Sample: ${r.docCount} documents, judged by the configured router model (coverage/precision 1-5).

${mdTable(['backend', 'ok', 'latency p50/p95', 'avg entities', 'avg relations', 'avg claims', 'coverage', 'precision'], rows)}
`;
}
