import fs from 'node:fs';
import path from 'node:path';
import { mdTable } from '../bench/util.js';
import { chartBlock } from '../research/chart.js';
import { bootstrapMean, holm, mean, pairedBootstrap, round, wilson } from './metrics/stats.js';
import { RunStore } from './runstore.js';
import { SYSTEMS } from './systems/index.js';
import { CORPUS_TASK_TYPES, type BuildRecord, type ScoreRecord } from './types.js';

/**
 * `knode-os eval report` (docs/design/23 §8): everything a run measured,
 * aggregated from its JSONL records — so every number in the report can be
 * traced back to `scores.jsonl`, `answers.jsonl` and `builds.jsonl`.
 */

/** The system that answers for a build group, for per-query cost and break-even. */
const GROUP_ANSWERER: Record<string, string> = { knode: 'knode-ask', 'llm-wiki': 'agent-wiki', rag: 'rag-hybrid', graphrag: 'graphrag', lightrag: 'lightrag', hipporag: 'hipporag' };
export const BASELINE = 'agent-grep';

const USAGE_METRICS = ['correctness', 'em', 'f1', 'keypoint_recall', 'citation_precision', 'citation_recall', 'abstain_correct', 'false_refusal', 'truthfulness', 'hallucinated', 'injection_success'] as const;
const LIST_METRICS = ['correctness', 'set_precision', 'set_recall', 'set_f1', 'order_accuracy', 'date_accuracy', 'attribution_recall', 'items_returned', 'em'] as const;
/** Queries a build is amortized over in the cost-normalized table. */
export const AMORTIZE_AT = [100, 1000] as const;

/** The build group a system answers from (its build's cost is its own), or none. */
export function groupOf(system: string): string | null {
  try {
    return SYSTEMS[system]?.().group ?? null;
  } catch {
    return null;
  }
}
const RETRIEVAL_METRICS = ['recall@2', 'recall@5', 'all@5', 'mrr@10', 'ndcg@10'] as const;
const EMERGENCE_METRICS = ['label_correct', 'set_recall', 'set_precision', 'set_f1', 'set_recall_latent', 'terms_precision_at_10', 'grounded_share', 'brier'] as const;
const GENERATION_METRICS = ['coverage', 'precision', 'attribution_precision', 'link_precision', 'link_recall', 'duplicate_rate', 'over_merge', 'contradiction_rate', 'contradicted_rate', 'compression', 'units', 'units_with_sources', 'links_per_page', 'orphan_page_rate'] as const;

export interface Cell {
  value: number | null;
  n: number;
  ci?: [number, number];
}

export interface Efficiency {
  correctness: number | null;
  /** Mean weighted tokens per query over the system's own answers. */
  queryTokens: number;
  per1k: number | null;
  buildTokens: number;
  /** null: the build never pays back (the system costs as much per query as agent-grep, or more). */
  breakEven: number | null;
  amortized: Record<string, number | null>;
  n: number;
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
  /** Corpus-level list tasks (aggregate, timeline, contradiction, profile) per pack and system. */
  lists: Record<string, Record<string, Record<string, Cell>>>;
  /**
   * Correctness for what it costs, per pack and system: correctness per 1k
   * query weighted tokens, the build's weighted tokens, the queries after
   * which the build has paid for itself against agent-grep, and correctness
   * per 1k tokens with the build spread over 100 and 1000 queries.
   */
  efficiency: Record<string, Record<string, Efficiency>>;
  /** Update batches: what each group's incremental build cost, and how each system answered after it. */
  updates: Record<string, { batch: string; builds: { group: string; ok: boolean; ms: number; weightedTokens: number; embeddingTokens: number; calls: number }[]; correctness: Record<string, Cell> }[]>;
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

  const corpusTypes = new Set<string>(CORPUS_TASK_TYPES);
  const lists = grouped(scores, LIST_METRICS, (s) => s.suite === 'usage' && Boolean(s.taskType && corpusTypes.has(s.taskType)));
  const efficiency = efficiencyOf(usage, perQuery, builds);
  const updates = updatesOf(builds, answers, scores);

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
  return { run: store.meta(), packs, systems, usage, retrieval, emergence, generation, perQuery, builds, breakEven, lists, efficiency, updates, pooled, byType, judgeUsage: { calls: judgeEvents, weightedTokens: 0, costUsd: 0 } };
}

/** Correctness per 1k query tokens, and with the build counted: break-even against agent-grep and amortized over 100 / 1000 queries. */
export function efficiencyOf(
  usage: ReportData['usage'], perQuery: ReportData['perQuery'], builds: BuildRecord[],
): ReportData['efficiency'] {
  const out: ReportData['efficiency'] = {};
  for (const [pack, bySystem] of Object.entries(perQuery)) {
    const grep = bySystem[BASELINE]?.weightedTokens;
    for (const [system, p] of Object.entries(bySystem)) {
      const correctness = usage[pack]?.[system]?.correctness?.value ?? null;
      const group = groupOf(system);
      const build = group ? builds.find((b) => b.pack === pack && b.system === group && b.ok) : undefined;
      const buildTokens = build?.usage.weightedTokens ?? 0;
      const per1k = (tokens: number) => (correctness === null || tokens <= 0 ? null : correctness / (tokens / 1000));
      const breakEven = grep === undefined || system === BASELINE ? null : p.weightedTokens < grep ? buildTokens / (grep - p.weightedTokens) : null;
      (out[pack] ??= {})[system] = {
        correctness, queryTokens: p.weightedTokens, per1k: per1k(p.weightedTokens), buildTokens,
        breakEven: system === BASELINE ? 0 : breakEven,
        amortized: Object.fromEntries(AMORTIZE_AT.map((q) => [String(q), per1k(p.weightedTokens + buildTokens / q)])),
        n: p.n,
      };
    }
  }
  return out;
}

/** Per update batch: the incremental build of every group, and correctness of the answers given after it. */
function updatesOf(builds: BuildRecord[], answers: ReturnType<RunStore['allAnswers']>, scores: ScoreRecord[]): ReportData['updates'] {
  const out: ReportData['updates'] = {};
  const batchOf = new Map<string, string>();
  for (const a of answers) if (a.batch) batchOf.set(`${a.pack}|${a.system}|${a.taskId}`, a.batch);
  const packs = new Set([...builds.filter((b) => b.system.includes('@')).map((b) => b.pack), ...answers.filter((a) => a.batch).map((a) => a.pack)]);
  for (const pack of packs) {
    const batches = [...new Set([...builds.filter((b) => b.pack === pack && b.system.includes('@')).map((b) => b.system.split('@')[1]), ...answers.filter((a) => a.pack === pack && a.batch).map((a) => a.batch!)])].sort();
    out[pack] = batches.map((batch) => {
      const acc = new Map<string, number[]>();
      for (const s of scores) {
        if (s.pack !== pack || s.metric !== 'correctness' || s.value === null || batchOf.get(`${s.pack}|${s.system}|${s.taskId}`) !== batch) continue;
        (acc.get(s.system) ?? acc.set(s.system, []).get(s.system)!).push(s.value);
      }
      return {
        batch,
        builds: builds.filter((b) => b.pack === pack && b.system.endsWith(`@${batch}`)).map((b) => ({
          group: b.system.split('@')[0], ok: b.ok, ms: b.ms, weightedTokens: b.usage.weightedTokens, embeddingTokens: b.usage.embeddingTokens, calls: b.usage.calls,
        })),
        correctness: Object.fromEntries([...acc].map(([sys, vs]) => [sys, cell(vs)])),
      };
    });
  }
  return out;
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
    const l = d.lists[pack];
    if (l) lines.push('### Use: corpus-level lists (aggregate, timeline, contradiction, profile)', '', 'Correctness here is set F1 (recall where the gold is a sample), times order accuracy for a timeline; em is a count\'s exact number.', '', table(l, LIST_METRICS), '');
    const eff = d.efficiency[pack];
    if (eff && Object.values(eff).some((x) => x.correctness !== null)) {
      lines.push('### Correctness for its cost', '');
      lines.push(`Per 1k weighted query tokens; "with build @ N" spreads the build's weighted tokens over N queries; break-even is the queries after which the build has cost less than answering with ${BASELINE}.`, '');
      lines.push(mdTable(['system', 'correctness', 'tokens / query', 'per 1k tokens', 'build tokens', ...AMORTIZE_AT.map((q) => `with build @ ${q}`), 'break-even queries'],
        Object.entries(eff).sort().map(([s, x]) => [
          s, x.correctness === null ? '—' : round(x.correctness, 3).toFixed(3), fmtNum(x.queryTokens), x.per1k === null ? '—' : round(x.per1k, 4).toFixed(4), fmtNum(x.buildTokens),
          ...AMORTIZE_AT.map((q) => (x.amortized[String(q)] === null ? '—' : round(x.amortized[String(q)]!, 4).toFixed(4))),
          s === BASELINE ? '—' : x.breakEven === null ? 'never' : fmtNum(x.breakEven),
        ])), '');
    }
    const ups = d.updates[pack];
    if (ups?.length) {
      lines.push('### Update stream', '');
      const sys = [...new Set(ups.flatMap((u) => Object.keys(u.correctness)))].sort();
      const groups = [...new Set(ups.flatMap((u) => u.builds.map((b) => b.group)))].sort();
      lines.push(mdTable(['batch', ...groups.map((g) => `${g} weighted tokens`), ...sys.map((x) => `${x} correctness`)], ups.map((u) => [
        u.batch,
        ...groups.map((g) => {
          const b = u.builds.find((x) => x.group === g);
          return b ? (b.ok ? fmtNum(b.weightedTokens) : 'failed') : '—';
        }),
        ...sys.map((x) => fmt(u.correctness[x])),
      ])), '');
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

/* -------------------------------- scale curves -------------------------------- */

export interface ScalePoint {
  run: string;
  fraction: number;
  documents: number | null;
  chars: number | null;
  correctness: Cell;
  /** Correctness on the corpus-level lists alone. */
  listCorrectness: Cell;
  queryTokens: number | null;
  buildTokens: number | null;
  capped: number;
  n: number;
}

/**
 * Scale curves (docs/design/23 §4): the same packs and systems run at several
 * `--fraction`s (1, 3, 10 — padding above 1), one run directory each, read
 * side by side — where agent-grep and long-context degrade, and whether a
 * wiki holds.
 */
export function buildScaleData(runDirs: string[]): Record<string, Record<string, ScalePoint[]>> {
  const out: Record<string, Record<string, ScalePoint[]>> = {};
  for (const dir of runDirs) {
    const d = buildReportData(dir);
    const fraction = Number(d.run?.fraction ?? 1);
    for (const pack of d.packs) {
      const staged = d.run?.staged?.[pack];
      const systems = new Set([...Object.keys(d.usage[pack] ?? {}), ...Object.keys(d.perQuery[pack] ?? {})]);
      for (const system of systems) {
        const pq = d.perQuery[pack]?.[system];
        ((out[pack] ??= {})[system] ??= []).push({
          run: d.run?.id ?? path.basename(dir), fraction, documents: staged?.documents ?? null, chars: staged?.chars ?? null,
          correctness: d.usage[pack]?.[system]?.correctness ?? { value: null, n: 0 },
          listCorrectness: d.lists[pack]?.[system]?.correctness ?? { value: null, n: 0 },
          queryTokens: pq?.weightedTokens ?? null, buildTokens: d.efficiency[pack]?.[system]?.buildTokens ?? null,
          capped: pq?.capped ?? 0, n: pq?.n ?? 0,
        });
      }
    }
  }
  for (const bySystem of Object.values(out)) for (const pts of Object.values(bySystem)) pts.sort((a, b) => a.fraction - b.fraction);
  return out;
}

export function renderScale(data: Record<string, Record<string, ScalePoint[]>>): string {
  const lines: string[] = ['# Knowledge benchmark — scale curves', ''];
  lines.push('One run per corpus size (`--fraction`; above 1 the pack\'s padding is added). Correctness over all usage tasks, and over the corpus-level lists alone; weighted tokens per query; the build\'s weighted tokens. A system missing at a size was not applicable there (long-context past its window) or its build failed.', '');
  for (const [pack, bySystem] of Object.entries(data).sort()) {
    const fractions = [...new Set(Object.values(bySystem).flatMap((p) => p.map((x) => x.fraction)))].sort((a, b) => a - b);
    const sizeOf = (f: number) => Object.values(bySystem).flatMap((p) => p).find((x) => x.fraction === f && x.documents !== null);
    lines.push(`## ${pack}`, '');
    lines.push(fractions.map((f) => {
      const s = sizeOf(f);
      return `- ${f}×: ${s ? `${s.documents} documents, ${fmtNum(s.chars)} characters` : 'size not recorded'}`;
    }).join('\n'), '');
    const at = (system: string, f: number) => bySystem[system].find((x) => x.fraction === f);
    const systems = Object.keys(bySystem).sort();
    lines.push(mdTable(['system', ...fractions.map((f) => `correctness @${f}×`), ...fractions.map((f) => `lists @${f}×`), ...fractions.map((f) => `tokens/query @${f}×`), ...fractions.map((f) => `build tokens @${f}×`)],
      systems.map((sys) => [
        sys,
        ...fractions.map((f) => fmt(at(sys, f)?.correctness)),
        ...fractions.map((f) => fmt(at(sys, f)?.listCorrectness)),
        ...fractions.map((f) => fmtNum(at(sys, f)?.queryTokens)),
        ...fractions.map((f) => fmtNum(at(sys, f)?.buildTokens || null)),
      ])), '');
    if (fractions.length >= 2) {
      const plotted = systems.filter((sys) => bySystem[sys].some((x) => x.correctness.value !== null)).slice(0, 8);
      lines.push(chartBlock({
        type: fractions.length >= 3 ? 'line' : 'bar', title: `${pack}: correctness by corpus size`, unit: 'correctness (0–1)', x: fractions.map((f) => `${f}×`),
        series: plotted.map((sys) => ({ name: sys, values: fractions.map((f) => (at(sys, f)?.correctness.value === null || at(sys, f) === undefined ? null : round(at(sys, f)!.correctness.value!, 3))) })),
        source: 'scores.jsonl of each run',
      }), '');
    }
  }
  return lines.join('\n');
}
