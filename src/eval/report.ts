import fs from 'node:fs';
import path from 'node:path';
import { mdTable } from '../bench/util.js';
import { chartBlock } from '../research/chart.js';
import { bootstrapMean, holm, mean, pairedBootstrap, round, wilson } from './metrics/stats.js';
import { RunStore } from './runstore.js';
import type { BuildRecord, ScoreRecord } from './types.js';

/**
 * `knode-os eval report` (docs/design/23 §8): everything a run measured,
 * aggregated from its JSONL records — so every number in the report can be
 * traced back to `scores.jsonl`, `answers.jsonl` and `builds.jsonl`.
 */

/** The system that answers for a build group, for per-query cost and break-even. */
const GROUP_ANSWERER: Record<string, string> = { knode: 'knode-ask', 'llm-wiki': 'agent-wiki', rag: 'rag-hybrid', graphrag: 'graphrag', lightrag: 'lightrag', hipporag: 'hipporag' };
export const BASELINE = 'agent-grep';

const USAGE_METRICS = ['correctness', 'em', 'f1', 'keypoint_recall', 'citation_precision', 'citation_recall', 'abstain_correct', 'false_refusal', 'truthfulness', 'hallucinated', 'injection_success'] as const;
const RETRIEVAL_METRICS = ['recall@2', 'recall@5', 'all@5', 'mrr@10', 'ndcg@10'] as const;
const EMERGENCE_METRICS = ['label_correct', 'set_recall', 'set_precision', 'set_f1', 'set_recall_latent', 'terms_precision_at_10', 'grounded_share', 'brier'] as const;
const GENERATION_METRICS = ['coverage', 'precision', 'attribution_precision', 'link_precision', 'link_recall', 'duplicate_rate', 'over_merge', 'contradiction_rate', 'contradicted_rate', 'compression', 'units', 'units_with_sources', 'links_per_page', 'orphan_page_rate'] as const;

export interface Cell {
  value: number | null;
  n: number;
  ci?: [number, number];
}

export interface ReportData {
  run: ReturnType<RunStore['meta']>;
  packs: string[];
  systems: string[];
  usage: Record<string, Record<string, Record<string, Cell>>>;
  retrieval: Record<string, Record<string, Record<string, Cell>>>;
  emergence: Record<string, Record<string, Record<string, Cell>>>;
  generation: Record<string, Record<string, Record<string, Cell>>>;
  perQuery: Record<string, Record<string, { latencyP50: number; toolCalls: number; weightedTokens: number; costUsd: number; n: number; capped: number; leaked: number; errors: number }>>;
  builds: BuildRecord[];
  breakEven: Record<string, Record<string, number | null>>;
  pooled: { system: string; diff: number; ci: [number, number]; p: number; n: number; significant: boolean }[];
  byType: Record<string, Record<string, Cell>>;
  judgeUsage: { calls: number; weightedTokens: number; costUsd: number };
}

function cell(values: number[], rate = false): Cell {
  if (!values.length) return { value: null, n: 0 };
  const m = mean(values);
  if (rate && values.every((v) => v === 0 || v === 1)) return { value: m, n: values.length, ci: wilson(values.filter((v) => v === 1).length, values.length) };
  return { value: m, n: values.length, ci: values.length > 1 ? bootstrapMean(values) : undefined };
}

function grouped(scores: ScoreRecord[], metrics: readonly string[], filter: (s: ScoreRecord) => boolean = () => true): Record<string, Record<string, Record<string, Cell>>> {
  const acc = new Map<string, number[]>();
  for (const s of scores) {
    if (!metrics.includes(s.metric) || s.value === null || !Number.isFinite(s.value) || !filter(s)) continue;
    const k = `${s.pack}\u0000${s.system}\u0000${s.metric}`;
    (acc.get(k) ?? acc.set(k, []).get(k)!).push(s.value);
  }
  const out: Record<string, Record<string, Record<string, Cell>>> = {};
  for (const [k, vs] of acc) {
    const [pack, system, metric] = k.split('\u0000');
    ((out[pack] ??= {})[system] ??= {})[metric] = cell(vs, ['correctness', 'em', 'abstain_correct', 'false_refusal', 'hallucinated', 'label_correct', 'all@5', 'injection_success'].includes(metric));
  }
  return out;
}

export function buildReportData(runDir: string): ReportData {
  const store = new RunStore(runDir);
  const scores = store.allScores();
  const answers = store.allAnswers();
  const builds = store.allBuilds();
  const packs = [...new Set([...answers.map((a) => a.pack), ...builds.map((b) => b.pack)])].sort();
  const systems = [...new Set(answers.map((a) => a.system).concat(scores.map((s) => s.system)))].filter((s) => s !== '__judge__').sort();

  const usage = grouped(scores, USAGE_METRICS, (s) => s.suite !== 'emergence');
  const retrieval = grouped(scores, RETRIEVAL_METRICS);
  const emergence = grouped(scores, EMERGENCE_METRICS, (s) => s.suite === 'emergence');
  const generation: ReportData['generation'] = {};
  for (const s of scores.filter((x) => x.suite === 'generation' && GENERATION_METRICS.includes(x.metric as (typeof GENERATION_METRICS)[number]))) {
    ((generation[s.pack] ??= {})[s.system] ??= {})[s.metric] = { value: s.value, n: s.n ?? 0, ci: s.ci };
  }

  const perQuery: ReportData['perQuery'] = {};
  for (const a of answers) {
    const p = ((perQuery[a.pack] ??= {})[a.system] ??= { latencyP50: 0, toolCalls: 0, weightedTokens: 0, costUsd: 0, n: 0, capped: 0, leaked: 0, errors: 0 });
    p.n++;
    p.toolCalls += a.toolCalls;
    p.weightedTokens += a.usage.weightedTokens;
    p.costUsd += a.usage.costUsd;
    if (a.capped) p.capped++;
    if (a.leaked?.length) p.leaked++;
    if (a.error) p.errors++;
  }
  for (const [pack, bySystem] of Object.entries(perQuery)) {
    for (const [system, p] of Object.entries(bySystem)) {
      const lat = answers.filter((a) => a.pack === pack && a.system === system).map((a) => a.ms).sort((x, y) => x - y);
      p.latencyP50 = lat[Math.floor(lat.length / 2)] ?? 0;
      p.toolCalls /= p.n;
      p.weightedTokens /= p.n;
      p.costUsd /= p.n;
    }
  }

  // queries after which a build has paid for itself against the grep agent's per-query cost
  const breakEven: ReportData['breakEven'] = {};
  for (const b of builds.filter((x) => x.ok && !x.system.includes('@'))) {
    const answerer = GROUP_ANSWERER[b.system];
    const grep = perQuery[b.pack]?.[BASELINE]?.weightedTokens;
    const own = answerer ? perQuery[b.pack]?.[answerer]?.weightedTokens : undefined;
    if (grep === undefined || own === undefined) continue;
    (breakEven[b.pack] ??= {})[b.system] = grep > own ? b.usage.weightedTokens / (grep - own) : null;
  }

  // pooled paired comparison of correctness against the baseline, over the tasks both answered
  const correctness = new Map<string, number>();
  for (const s of scores) if (s.metric === 'correctness' && s.value !== null) correctness.set(`${s.system}|${s.pack}|${s.taskId}`, s.value);
  const others = systems.filter((s) => s !== BASELINE);
  const comparisons = others.map((system) => {
    const a: number[] = [];
    const b: number[] = [];
    for (const [k, v] of correctness) {
      const [sys, pack, task] = k.split('|');
      if (sys !== system) continue;
      const base = correctness.get(`${BASELINE}|${pack}|${task}`);
      if (base === undefined) continue;
      a.push(v);
      b.push(base);
    }
    return { system, ...pairedBootstrap(a, b) };
  }).filter((c) => c.n > 0);
  const sig = holm(comparisons.map((c) => c.p));
  const pooled = comparisons.map((c, i) => ({ ...c, significant: sig[i] }));

  const byType: ReportData['byType'] = {};
  const typeAcc = new Map<string, number[]>();
  for (const s of scores) {
    if (s.metric !== 'correctness' || s.value === null || !s.taskType) continue;
    const k = `${s.system}\u0000${s.taskType}`;
    (typeAcc.get(k) ?? typeAcc.set(k, []).get(k)!).push(s.value);
  }
  for (const [k, vs] of typeAcc) {
    const [system, type] = k.split('\u0000');
    (byType[system] ??= {})[type] = cell(vs);
  }

  const judgeEvents = fs.existsSync(path.join(runDir, 'meter.jsonl'))
    ? fs.readFileSync(path.join(runDir, 'meter.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"__judge__"')).length
    : 0;
  return { run: store.meta(), packs, systems, usage, retrieval, emergence, generation, perQuery, builds, breakEven, pooled, byType, judgeUsage: { calls: judgeEvents, weightedTokens: 0, costUsd: 0 } };
}

const fmt = (c: Cell | undefined, digits = 2) => {
  if (!c || c.value === null || !Number.isFinite(c.value)) return '—';
  const v = round(c.value, digits).toFixed(digits);
  return c.ci && Number.isFinite(c.ci[0]) ? `${v} [${round(c.ci[0], digits).toFixed(digits)}, ${round(c.ci[1], digits).toFixed(digits)}]` : v;
};
const fmtNum = (n: number | null | undefined, digits = 0) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(digits));
const fmtMs = (ms: number) => (ms >= 3600_000 ? `${(ms / 3600_000).toFixed(1)} h` : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`);

function table(rows: Record<string, Record<string, Cell>>, metrics: readonly string[], digits = 2): string {
  const systems = Object.keys(rows).sort();
  const used = metrics.filter((m) => systems.some((s) => rows[s][m]));
  if (!used.length) return '';
  return mdTable(['system', ...used, 'n'], systems.map((s) => [s, ...used.map((m) => fmt(rows[s][m], digits)), String(Math.max(...used.map((m) => rows[s][m]?.n ?? 0)))]));
}

export function renderReport(d: ReportData): string {
  const meta = d.run;
  const lines: string[] = [];
  lines.push(`# Knowledge benchmark — ${meta?.id ?? ''}`, '');
  if (meta) {
    lines.push(`- Model: ${meta.model.label} (build effort ${meta.model.buildEffort}, answer effort ${meta.model.answerEffort}); judge: ${meta.judge.label}; embedder: ${meta.embedding}`);
    lines.push(`- Packs: ${d.packs.join(', ')}; systems: ${d.systems.join(', ')}; corpus fraction ${meta.fraction}, seed ${meta.seed}; git ${meta.gitSha?.slice(0, 10) ?? '?'}`);
    lines.push(`- Judge calls: ${d.judgeUsage.calls}`, '');
  }
  lines.push('Intervals are Wilson (rates) or bootstrap (means), 95%. Correctness is the judge score scaled to 0–1. "—" means not measured or not applicable (a system that does not cite has no citation score).', '');

  if (d.pooled.length) {
    lines.push(`## Pooled correctness against ${BASELINE}`, '');
    lines.push('Paired over the tasks both systems answered, all packs pooled; significance after Holm correction across systems.', '');
    lines.push(mdTable(['system', 'Δ correctness', '95% CI', 'p', 'paired tasks', 'significant'], d.pooled.sort((a, b) => b.diff - a.diff).map((c) => [c.system, round(c.diff, 3).toFixed(3), `[${round(c.ci[0], 3)}, ${round(c.ci[1], 3)}]`, round(c.p, 4).toString(), String(c.n), c.significant ? 'yes' : 'no'])), '');
    const sys = d.pooled.map((c) => c.system);
    lines.push(chartBlock({ type: 'hbar', title: `Correctness difference vs ${BASELINE}`, unit: 'Δ correctness (0–1)', x: sys, series: [{ name: 'Δ correctness', values: d.pooled.map((c) => round(c.diff, 3)) }], source: 'scores.jsonl' }), '');
  }

  for (const pack of d.packs) {
    lines.push(`## ${pack}`, '');
    const u = d.usage[pack];
    if (u) lines.push('### Use: answering', '', table(u, USAGE_METRICS), '');
    const r = d.retrieval[pack];
    if (r) lines.push('### Use: retrieval', '', table(r, RETRIEVAL_METRICS), '');
    const pq = d.perQuery[pack];
    if (pq) {
      lines.push('### Per-query cost', '');
      lines.push(mdTable(['system', 'answers', 'p50 latency', 'tool calls', 'weighted tokens', 'USD (API prices)', 'capped', 'leaked', 'errors'],
        Object.entries(pq).sort().map(([s, p]) => [s, p.n, fmtMs(p.latencyP50), p.toolCalls.toFixed(1), fmtNum(p.weightedTokens), p.costUsd.toFixed(4), p.capped, p.leaked, p.errors])), '');
      const pts = Object.entries(pq).filter(([s]) => u?.[s]?.correctness);
      if (pts.length >= 2) {
        lines.push(chartBlock({ type: 'scatter', title: `${pack}: correctness vs cost per query`, x: pts.map(([s]) => s), series: [
          { name: 'weighted tokens per query', values: pts.map(([, p]) => Math.round(p.weightedTokens)) },
          { name: 'correctness', values: pts.map(([s]) => round(u![s].correctness.value ?? 0, 3)) },
        ], source: 'answers.jsonl, scores.jsonl' }), '');
      }
    }
    const e = d.emergence[pack];
    if (e) lines.push('### Emergence', '', table(e, EMERGENCE_METRICS), '');
    const g = d.generation[pack];
    if (g) lines.push('### Knowledge generation', '', table(g, GENERATION_METRICS), '');
    const b = d.builds.filter((x) => x.pack === pack);
    if (b.length) {
      lines.push('### Build cost', '');
      lines.push(mdTable(['build', 'ok', 'wall', 'LLM time', 'calls', 'input', 'cached', 'output', 'weighted tokens', 'embedding tokens', 'USD (API prices)', 'disk', 'peak RSS', 'break-even queries'],
        b.map((x) => [
          x.system, x.ok ? 'yes' : `no: ${(x.error ?? '').slice(0, 40)}`, fmtMs(x.ms), fmtMs(x.usage.llmMs), x.usage.calls, fmtNum(x.usage.inputTokens), fmtNum(x.usage.cachedInputTokens), fmtNum(x.usage.outputTokens),
          fmtNum(x.usage.weightedTokens), fmtNum(x.usage.embeddingTokens), x.usage.costUsd.toFixed(3), `${(x.bytes / 1e6).toFixed(1)} MB`, x.peakRssBytes ? `${(x.peakRssBytes / 1e6).toFixed(0)} MB` : '—',
          d.breakEven[pack]?.[x.system] === undefined ? '—' : d.breakEven[pack][x.system] === null ? 'never' : fmtNum(d.breakEven[pack][x.system]),
        ])), '');
      const stages = b.filter((x) => Object.keys(x.stages).length);
      for (const x of stages) {
        lines.push(`<details><summary>${x.system}: usage by stage</summary>`, '', mdTable(['stage', 'calls', 'weighted tokens', 'LLM time', 'embedding tokens'], Object.entries(x.stages).map(([st, us]) => [st, us.calls, fmtNum(us.weightedTokens), fmtMs(us.llmMs), fmtNum(us.embeddingTokens)])), '', '</details>', '');
      }
    }
  }

  const types = [...new Set(Object.values(d.byType).flatMap((t) => Object.keys(t)))].sort();
  if (types.length) {
    lines.push('## Correctness by task type (all packs, descriptive)', '');
    lines.push(mdTable(['system', ...types], Object.entries(d.byType).sort().map(([s, t]) => [s, ...types.map((ty) => fmt(t[ty]))])), '');
  }
  return lines.join('\n');
}

export function writeReport(runDir: string): { md: string; json: string; data: ReportData } {
  const data = buildReportData(runDir);
  const md = path.join(runDir, 'report.md');
  const json = path.join(runDir, 'report.json');
  fs.writeFileSync(md, renderReport(data));
  fs.writeFileSync(json, JSON.stringify(data, null, 2));
  return { md, json, data };
}
