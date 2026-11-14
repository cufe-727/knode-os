import fs from 'node:fs';
import path from 'node:path';
import { mdTable } from '../bench/util.js';
import { chartBlock } from '../research/chart.js';
import { bootstrapMean, holm, mean, minimumDetectableEffect, pairedBootstrap, round, sd, wilson } from './metrics/stats.js';
import { RunStore } from './runstore.js';
import { judgeItemKey } from './score/keys.js';
import { SYSTEMS } from './systems/index.js';
import { toolUse, type ToolUse } from './trace.js';
import { CORPUS_TASK_TYPES, SEPARATION_TASK_TYPES, type BuildRecord, type ScoreRecord } from './types.js';

/**
 * `knode-os eval report` (docs/design/23 §8): everything a run measured,
 * aggregated from its JSONL records — so every number in the report can be
 * traced back to `scores.jsonl`, `answers.jsonl` and `builds.jsonl`.
 */

/** The system that answers for a build group, for per-query cost and break-even. */
const GROUP_ANSWERER: Record<string, string> = { knode: 'knode-ask', 'llm-wiki': 'agent-wiki', rag: 'rag-hybrid', graphrag: 'graphrag', lightrag: 'lightrag', hipporag: 'hipporag' };
export const BASELINE = 'agent-grep';

const USAGE_METRICS = ['correctness', 'em', 'f1', 'keypoint_recall', 'citation_precision', 'citation_recall', 'abstain_correct', 'false_refusal', 'truthfulness', 'hallucinated', 'confident_wrong', 'stale_answer', 'injection_success'] as const;
const LIST_METRICS = ['correctness', 'set_precision', 'set_recall', 'set_f1', 'order_accuracy', 'date_accuracy', 'attribution_recall', 'items_returned', 'em'] as const;
/** What separates a compiled knowledge base from a lookup (docs/design/28), per pack and system. */
const SEPARATION_METRICS = ['correctness', 'stale_answer', 'confident_wrong', 'distractor_rate', 'citation_precision'] as const;
const RATE_METRICS = ['correctness', 'em', 'abstain_correct', 'false_refusal', 'hallucinated', 'label_correct', 'all@5', 'injection_success', 'confident_wrong', 'stale_answer'];
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
const GENERATION_METRICS = ['coverage', 'precision', 'attribution_precision', 'link_precision', 'link_recall', 'duplicate_rate', 'over_merge', 'er_bcubed_precision', 'er_bcubed_recall', 'er_bcubed_f1', 'er_found', 'contradiction_rate', 'contradicted_rate', 'compression', 'units', 'units_with_sources', 'links_per_page', 'orphan_page_rate'] as const;

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

export interface Paired {
  system: string;
  diff: number;
  ci: [number, number];
  p: number;
  n: number;
  /** The smallest delta this many paired tasks could detect (α 0.05, power 0.8). */
  mde: number;
}

export interface Variance {
  repeats: number;
  /** Mean correctness of each repeat, in repeat order. */
  perRepeat: number[];
  /** Standard deviation of the repeats' mean correctness. */
  sdAcrossRepeats: number;
  /** Mean over tasks of the standard deviation of a task's correctness across repeats. */
  withinTaskSd: number;
  /** Share of tasks whose correctness differs between repeats. */
  unstable: number;
  tasks: number;
}

/** Two repeated systems on the tasks both answered in every repeat (`--repeat`, `--repeat-sample`). */
export interface RepeatPair {
  a: string;
  b: string;
  tasks: number;
  /** Mean correctness of a minus b, per repeat. */
  perRepeat: number[];
  /** The mean of those: the paired difference on the sample. */
  diff: number;
  /** Each system's run-to-run spread on these tasks: the SD across repeats of its mean correctness. */
  spreadA: number;
  spreadB: number;
  /** The spread of a single run's difference that rerunning both alone gives: √(spreadA² + spreadB²). */
  noise: number;
  /** The difference is within the run-to-run spread: the per-repeat differences change sign, or |diff| ≤ 2 × noise. */
  withinSpread: boolean;
}

export interface JudgeAuditSummary {
  /** Per kind of verdict (grade, list, match, …): verdicts judged twice, and how many of the pairs agreed. */
  byKind: Record<string, { n: number; agree: number }>;
  disagreements: {
    kind: string;
    id: string;
    /** The answer it was about, for a grade, list or match of an answer. */
    pack?: string;
    system?: string;
    taskId?: string;
    repeat?: number;
    /** The question (a grade) or what was matched, as the judge saw it. */
    asked: string;
    first: unknown;
    second: unknown;
    /** The judge's reason with each verdict, where its kind gives one. */
    reasons: [string | null, string | null];
  }[];
}

/** The run's judge audit: agreement per kind, and each disagreement with the answer it was about. */
export function judgeAuditOf(store: RunStore): JudgeAuditSummary | undefined {
  const recs = store.allJudgeAudits();
  if (!recs.length) return undefined;
  const about = new Map<string, ReturnType<RunStore['allAnswers']>[number]>();
  for (const a of store.allAnswers()) for (const kind of ['grade', 'list', 'match']) about.set(judgeItemKey(kind, a), a);
  const byKind: JudgeAuditSummary['byKind'] = {};
  const disagreements: JudgeAuditSummary['disagreements'] = [];
  const reason = (v: unknown) => (v && typeof v === 'object' && typeof (v as { reason?: unknown }).reason === 'string' ? (v as { reason: string }).reason : null);
  for (const r of recs) {
    const k = (byKind[r.kind] ??= { n: 0, agree: 0 });
    k.n++;
    if (r.agree) {
      k.agree++;
      continue;
    }
    const a = about.get(r.id);
    const item = (r.item ?? {}) as Record<string, unknown>;
    const asked = typeof item.question === 'string' ? item.question : JSON.stringify(item).slice(0, 300);
    disagreements.push({
      kind: r.kind, id: r.id, ...(a ? { pack: a.pack, system: a.system, taskId: a.taskId, ...(a.repeat ? { repeat: a.repeat } : {}) } : {}),
      asked, first: r.first, second: r.second, reasons: [reason(r.first), reason(r.second)],
    });
  }
  disagreements.sort((x, y) => x.kind.localeCompare(y.kind) || (x.system ?? '').localeCompare(y.system ?? '') || (x.taskId ?? x.id).localeCompare(y.taskId ?? y.id));
  return { byKind, disagreements };
}

/** A verdict in a table cell: a grade's score, a match's pairs, else its fields. */
function verdictText(v: unknown): string {
  if (!v || typeof v !== 'object') return String(v);
  const o = v as Record<string, unknown>;
  if ('score' in o) return `score ${o.score}${o.abstained ? ', abstained' : ''}${o.hallucinated ? ', hallucinated' : ''}`;
  if ('pairs' in o) return `pairs ${JSON.stringify(o.pairs)}`;
  return JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'id' && k !== 'reason')));
}

const cellText = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\|/g, '/').replace(/\n/g, ' ');

function judgeAuditLines(a: JudgeAuditSummary | undefined): string[] {
  if (!a) return [];
  const out = ['## Judge audit', '', 'A seeded share of the judge\'s verdicts (`--judge-audit`, default 5%, at least 20 a pass) judged a second time, in calls of their own with the items in another order. Scores use the first verdict; this is how often a second look agrees with it.', ''];
  out.push(mdTable(['kind', 'judged twice', 'agreed', 'agreement'], Object.entries(a.byKind).sort().map(([k, v]) => [k, v.n, v.agree, `${((v.agree / v.n) * 100).toFixed(0)}%`])), '');
  if (a.disagreements.length) {
    out.push(`### Disagreements (${a.disagreements.length})`, '');
    out.push(mdTable(['kind', 'system', 'task', 'asked', 'first verdict', 'reason', 'second verdict', 'reason'], a.disagreements.map((d) => [
      d.kind, d.system ?? '—', d.taskId ? `${d.taskId}${d.repeat ? ` (repeat ${d.repeat})` : ''}` : d.id, cellText(d.asked), verdictText(d.first), cellText(d.reasons[0] ?? '—', 100), verdictText(d.second), cellText(d.reasons[1] ?? '—', 100),
    ])), '');
  }
  return out;
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
  /**
   * What the agents did, per pack and agent system: tool calls per answer and
   * the programs (shell agents) or knode tools (the MCP agent) behind them,
   * from the traces on the answer records.
   */
  tools: Record<string, Record<string, ToolUse>>;
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
  pooled: (Paired & { significant: boolean })[];
  /** Paired correctness against the baseline, per pack, with the minimum detectable effect. */
  paired?: Record<string, Paired[]>;
  byType: Record<string, Record<string, Cell>>;
  /** Correctness per task type, per pack and system (every type, the separation families among them), and each system's paired delta per type. */
  typesByPack?: Record<string, Record<string, Record<string, Cell>>>;
  typeDeltas?: Record<string, Record<string, Record<string, Paired>>>;
  /** Stale answers, confident wrong answers, look-alike items and citation precision, per pack and system, over the separation families and over everything. */
  separation?: Record<string, Record<string, Record<string, Cell>>>;
  /** What one correct answer costs: weighted tokens and USD over the sum of correctness, per pack and system. */
  costPerCorrect?: Record<string, Record<string, { tokens: number | null; usd: number | null; correct: number; n: number; toolCalls: number }>>;
  /** Run-to-run variance where a system answered the same tasks more than once (`eval run --repeat`). */
  variance?: Record<string, Record<string, Variance>>;
  /** Per pack, every two repeated systems: their paired difference on the repeated tasks against their run-to-run spread. */
  repeatPairs?: Record<string, RepeatPair[]>;
  judgeUsage: { calls: number; weightedTokens: number; costUsd: number };
  /** The judge audit (`--judge-audit`): verdicts judged twice, how often the two agreed, and every disagreement. */
  judgeAudit?: JudgeAuditSummary;
  /**
   * Where the run's model work ran (docs/design/32): per pool and worker, the
   * model calls and agent sessions it answered (replays from the reply cache
   * apart), from the meter; this machine's are the run's own slots.
   */
  ranAt?: { pool: string; worker: string; calls: number; sessions: number; replayed: number }[];
}

/** The meter's model calls and sessions by pool and worker (embeddings are the run's own, and left out). */
export function ranAtOf(runDir: string, localPool: string): NonNullable<ReportData['ranAt']> {
  const file = path.join(runDir, 'meter.jsonl');
  if (!fs.existsSync(file)) return [];
  const by = new Map<string, { pool: string; worker: string; calls: number; sessions: number; replayed: number }>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e: { stage?: string; worker?: string; pool?: string; replayed?: boolean; embeddingCalls?: number; embeddingTokens?: number };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.embeddingCalls || e.embeddingTokens) continue;
    const worker = e.worker ?? 'this machine';
    const pool = e.pool ?? (e.worker ? '?' : localPool);
    const k = `${pool}\u0000${worker}`;
    const row = by.get(k) ?? { pool, worker, calls: 0, sessions: 0, replayed: 0 };
    if (e.replayed) row.replayed++;
    else if (e.stage === 'agent') row.sessions++;
    else row.calls++;
    by.set(k, row);
  }
  return [...by.values()].sort((a, b) => a.pool.localeCompare(b.pool) || a.worker.localeCompare(b.worker));
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
    ((out[pack] ??= {})[system] ??= {})[metric] = cell(vs, RATE_METRICS.includes(metric));
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

  // every agent-* system, and anything else that left a trace; records from before traces count as untraced
  const tools: ReportData['tools'] = {};
  const agentAnswers = new Map<string, typeof answers>();
  for (const a of answers) {
    if (!a.system.startsWith('agent-') && !a.commands) continue;
    const k = `${a.pack}\u0000${a.system}`;
    (agentAnswers.get(k) ?? agentAnswers.set(k, []).get(k)!).push(a);
  }
  for (const [k, as] of agentAnswers) {
    const [pack, system] = k.split('\u0000');
    (tools[pack] ??= {})[system] = toolUse(as);
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

  // pooled paired comparison of correctness against the baseline, over the tasks both answered (repeats averaged per task)
  const perTask = new Map<string, number[]>();
  const typeOf = new Map<string, string>();
  for (const s of scores) {
    if (s.metric !== 'correctness' || s.value === null || !Number.isFinite(s.value)) continue;
    const k = `${s.system}\u0000${s.pack}\u0000${s.taskId}`;
    (perTask.get(k) ?? perTask.set(k, []).get(k)!).push(s.value);
    if (s.taskType) typeOf.set(`${s.pack}\u0000${s.taskId}`, s.taskType);
  }
  const correctness = new Map([...perTask].map(([k, vs]) => [k, mean(vs)]));
  const others = systems.filter((s) => s !== BASELINE);
  const compare = (system: string, keep: (pack: string, task: string) => boolean): Paired | null => {
    const a: number[] = [];
    const b: number[] = [];
    for (const [k, v] of correctness) {
      const [sys, pack, task] = k.split('\u0000');
      if (sys !== system || !keep(pack, task)) continue;
      const base = correctness.get(`${BASELINE}\u0000${pack}\u0000${task}`);
      if (base === undefined) continue;
      a.push(v);
      b.push(base);
    }
    if (!a.length) return null;
    return { system, ...pairedBootstrap(a, b), mde: minimumDetectableEffect(a.map((x, i) => x - b[i])) };
  };
  const comparisons = others.map((system) => compare(system, () => true)).filter((c): c is Paired => c !== null && c.n > 0);
  const sig = holm(comparisons.map((c) => c.p));
  const pooled = comparisons.map((c, i) => ({ ...c, significant: sig[i] }));
  const paired: NonNullable<ReportData['paired']> = {};
  const typeDeltas: NonNullable<ReportData['typeDeltas']> = {};
  for (const pack of packs) {
    const rows = others.map((system) => compare(system, (p) => p === pack)).filter((c): c is Paired => c !== null);
    if (rows.length) paired[pack] = rows;
    const types = new Set([...typeOf].filter(([k]) => k.startsWith(`${pack}\u0000`)).map(([, t]) => t));
    for (const type of types) {
      for (const system of others) {
        const c = compare(system, (p, task) => p === pack && typeOf.get(`${p}\u0000${task}`) === type);
        if (c) ((typeDeltas[pack] ??= {})[type] ??= {})[system] = c;
      }
    }
  }

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
  const typesByPack: NonNullable<ReportData['typesByPack']> = {};
  {
    const acc = new Map<string, number[]>();
    for (const [k, v] of correctness) {
      const [system, pack, task] = k.split('\u0000');
      const type = typeOf.get(`${pack}\u0000${task}`);
      if (!type) continue;
      const key = `${pack}\u0000${type}\u0000${system}`;
      (acc.get(key) ?? acc.set(key, []).get(key)!).push(v);
    }
    for (const [key, vs] of acc) {
      const [pack, type, system] = key.split('\u0000');
      ((typesByPack[pack] ??= {})[type] ??= {})[system] = cell(vs);
    }
  }
  const separation = separationOf(scores);
  const costPerCorrect = costPerCorrectOf(answers, scores);
  const variance = varianceOf(answers, scores);
  const repeatPairs = repeatPairsOf(answers, scores);

  const judgeEvents = fs.existsSync(path.join(runDir, 'meter.jsonl'))
    ? fs.readFileSync(path.join(runDir, 'meter.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"__judge__"')).length
    : 0;
  return {
    run: store.meta(), packs, systems, usage, retrieval, emergence, generation, perQuery, tools, builds, breakEven, lists, efficiency, updates, pooled, paired, byType, typesByPack, typeDeltas,
    separation, costPerCorrect, variance, repeatPairs, judgeUsage: { calls: judgeEvents, weightedTokens: 0, costUsd: 0 }, judgeAudit: judgeAuditOf(store),
    ranAt: ranAtOf(runDir, store.meta()?.work?.pool ?? 'local'),
  };
}

const SEPARATION_TYPES = new Set<string>(SEPARATION_TASK_TYPES);

/**
 * The separation metrics per pack and system: each over the separation
 * families (`<metric>` ) and, for stale and confident-wrong answers, over all
 * tasks too (`<metric>_all`).
 */
function separationOf(scores: ScoreRecord[]): NonNullable<ReportData['separation']> {
  const acc = new Map<string, number[]>();
  const push = (pack: string, system: string, metric: string, v: number) => {
    const k = `${pack}\u0000${system}\u0000${metric}`;
    (acc.get(k) ?? acc.set(k, []).get(k)!).push(v);
  };
  for (const s of scores) {
    if (s.value === null || !Number.isFinite(s.value) || !(SEPARATION_METRICS as readonly string[]).includes(s.metric) || s.suite === 'generation') continue;
    if (s.taskType && SEPARATION_TYPES.has(s.taskType)) push(s.pack, s.system, s.metric, s.value);
    if (s.metric === 'stale_answer' || s.metric === 'confident_wrong') push(s.pack, s.system, `${s.metric}_all`, s.value);
  }
  const out: NonNullable<ReportData['separation']> = {};
  for (const [k, vs] of acc) {
    const [pack, system, metric] = k.split('\u0000');
    ((out[pack] ??= {})[system] ??= {})[metric] = cell(vs, RATE_METRICS.includes(metric.replace(/_all$/, '')));
  }
  return out;
}

/** Weighted tokens and USD per unit of correctness (a half-right answer is half an answer), and tool calls per answer. */
export function costPerCorrectOf(answers: ReturnType<RunStore['allAnswers']>, scores: ScoreRecord[]): NonNullable<ReportData['costPerCorrect']> {
  const correct = new Map<string, number>();
  for (const s of scores) if (s.metric === 'correctness' && s.value !== null && Number.isFinite(s.value)) correct.set(`${s.pack}|${s.system}|${s.taskId}|${s.repeat ?? 0}`, s.value);
  const out: NonNullable<ReportData['costPerCorrect']> = {};
  const acc = new Map<string, { tokens: number; usd: number; correct: number; n: number; toolCalls: number }>();
  for (const a of answers) {
    const c = correct.get(`${a.pack}|${a.system}|${a.taskId}|${a.repeat ?? 0}`);
    if (c === undefined) continue;
    const k = `${a.pack}\u0000${a.system}`;
    const x = acc.get(k) ?? acc.set(k, { tokens: 0, usd: 0, correct: 0, n: 0, toolCalls: 0 }).get(k)!;
    x.tokens += a.usage.weightedTokens;
    x.usd += a.usage.costUsd;
    x.correct += c;
    x.n++;
    x.toolCalls += a.toolCalls;
  }
  for (const [k, x] of acc) {
    const [pack, system] = k.split('\u0000');
    (out[pack] ??= {})[system] = { tokens: x.correct > 0 ? x.tokens / x.correct : null, usd: x.correct > 0 ? x.usd / x.correct : null, correct: x.correct, n: x.n, toolCalls: x.n ? x.toolCalls / x.n : 0 };
  }
  return out;
}

/**
 * Paired differences between repeated systems (docs/design/33 §6.4): on the
 * tasks both answered in every repeat they share, the difference of their
 * mean correctness in each repeat, and whether it is within what rerunning
 * alone moves it. A difference counts as within the spread when the repeats
 * disagree on its sign, or when it is at most twice √(sA² + sB²), the SD a
 * single run's difference would have from the two systems' own run-to-run
 * spreads (estimated from as few as two or three repeats, so a rough bound).
 */
export function repeatPairsOf(answers: ReturnType<RunStore['allAnswers']>, scores: ScoreRecord[]): NonNullable<ReportData['repeatPairs']> {
  const repeats = new Map<string, Set<number>>();
  for (const a of answers) {
    const k = `${a.pack}\u0000${a.system}`;
    (repeats.get(k) ?? repeats.set(k, new Set()).get(k)!).add(a.repeat ?? 0);
  }
  // pack → system → task → repeat → correctness, for systems answered more than once
  const byPack = new Map<string, Map<string, Map<string, Map<number, number>>>>();
  for (const s of scores) {
    if (s.metric !== 'correctness' || s.value === null || !Number.isFinite(s.value) || !s.taskId) continue;
    if ((repeats.get(`${s.pack}\u0000${s.system}`)?.size ?? 0) < 2) continue;
    const sys = byPack.get(s.pack) ?? byPack.set(s.pack, new Map()).get(s.pack)!;
    const tasks = sys.get(s.system) ?? sys.set(s.system, new Map()).get(s.system)!;
    (tasks.get(s.taskId) ?? tasks.set(s.taskId, new Map()).get(s.taskId)!).set(s.repeat ?? 0, s.value);
  }
  const out: NonNullable<ReportData['repeatPairs']> = {};
  for (const [pack, systems] of byPack) {
    const names = [...systems.keys()].sort((x, y) => (x === BASELINE ? -1 : y === BASELINE ? 1 : x.localeCompare(y)));
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const [a, b] = [names[i], names[j]];
        const order = [...repeats.get(`${pack}\u0000${a}`)!].filter((r) => repeats.get(`${pack}\u0000${b}`)!.has(r)).sort((x, y) => x - y);
        if (order.length < 2) continue;
        const ta = systems.get(a)!;
        const tb = systems.get(b)!;
        const common = [...ta.keys()].filter((t) => tb.has(t) && order.every((r) => ta.get(t)!.has(r) && tb.get(t)!.has(r)));
        if (!common.length) continue;
        const meanOf = (m: Map<string, Map<number, number>>, r: number) => mean(common.map((t) => m.get(t)!.get(r)!));
        const perRepeat = order.map((r) => meanOf(ta, r) - meanOf(tb, r));
        const spreadA = sd(order.map((r) => meanOf(ta, r)));
        const spreadB = sd(order.map((r) => meanOf(tb, r)));
        const noise = Math.sqrt(spreadA ** 2 + spreadB ** 2);
        const diff = mean(perRepeat);
        const flips = perRepeat.some((d) => d > 0) && perRepeat.some((d) => d < 0);
        (out[pack] ??= []).push({ a, b, tasks: common.length, perRepeat, diff, spreadA, spreadB, noise, withinSpread: flips || Math.abs(diff) <= 2 * noise });
      }
    }
  }
  return out;
}

/** Spread between repeated answers of one system to the same tasks: across the repeats' means, and within each task. */
export function varianceOf(answers: ReturnType<RunStore['allAnswers']>, scores: ScoreRecord[]): NonNullable<ReportData['variance']> {
  const repeats = new Map<string, Set<number>>();
  for (const a of answers) {
    const k = `${a.pack}\u0000${a.system}`;
    (repeats.get(k) ?? repeats.set(k, new Set()).get(k)!).add(a.repeat ?? 0);
  }
  const out: NonNullable<ReportData['variance']> = {};
  for (const [k, rs] of repeats) {
    if (rs.size < 2) continue;
    const [pack, system] = k.split('\u0000');
    const byTask = new Map<string, Map<number, number>>();
    for (const s of scores) {
      if (s.pack !== pack || s.system !== system || s.metric !== 'correctness' || s.value === null || !s.taskId) continue;
      (byTask.get(s.taskId) ?? byTask.set(s.taskId, new Map()).get(s.taskId)!).set(s.repeat ?? 0, s.value);
    }
    const order = [...rs].sort((x, y) => x - y);
    // the tasks every repeat answered, so the repeats' means are over the same tasks
    const common = [...byTask.values()].filter((m) => order.every((r) => m.has(r)));
    if (!common.length) continue;
    const perRepeat = order.map((r) => mean(common.map((m) => m.get(r)!)));
    const within = common.map((m) => sd(order.map((r) => m.get(r)!)));
    (out[pack] ??= {})[system] = {
      repeats: order.length, perRepeat, sdAcrossRepeats: sd(perRepeat), withinTaskSd: mean(within),
      unstable: common.filter((m) => new Set(order.map((r) => m.get(r)!)).size > 1).length / common.length, tasks: common.length,
    };
  }
  return out;
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

const fmtMde = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : round(x, 3).toFixed(3));

/**
 * The separation table (docs/design/28): over the separation families,
 * correctness, stale answers (the value the corpus once stated, or a
 * look-alike's), confident wrong answers, look-alike items and citation
 * precision; over all tasks, stale and confident-wrong rates; and what an
 * answer costs — tool calls per answer, tokens and USD per correct answer.
 */
function separationTable(sep: Record<string, Record<string, Cell>>, cpc: NonNullable<ReportData['costPerCorrect']>[string]): string[] {
  const systems = [...new Set([...Object.keys(sep), ...Object.keys(cpc)])].sort();
  if (!systems.length) return [];
  const cols: [string, string][] = [['correctness', 'correctness (families)'], ['stale_answer', 'stale answers'], ['confident_wrong', 'confident wrong'], ['distractor_rate', 'look-alike items'], ['citation_precision', 'citation precision'], ['stale_answer_all', 'stale answers (all)'], ['confident_wrong_all', 'confident wrong (all)']];
  const used = cols.filter(([m]) => systems.some((s) => sep[s]?.[m]));
  const out = ['### Separation: stale, confident-wrong, look-alike, citations, cost per correct answer', ''];
  out.push('Over the separation families (stale, lookalike, structured, nonlexical-hop, connection, paraphrase, cross-lingual) unless marked "all". A stale answer gives a value the corpus stated earlier (or a look-alike entity\'s) instead of the current one; confident wrong is wrong without declining. Cost per correct answer divides all of a system\'s answer tokens (and USD) by its summed correctness.', '');
  out.push(mdTable(['system', ...used.map(([, h]) => h), 'tool calls / answer', 'tokens / correct', 'USD / correct'], systems.map((s) => [
    s, ...used.map(([m]) => fmt(sep[s]?.[m])), cpc[s] ? cpc[s].toolCalls.toFixed(1) : '—', fmtNum(cpc[s]?.tokens), cpc[s]?.usd === null || cpc[s]?.usd === undefined ? '—' : cpc[s].usd!.toFixed(4),
  ])), '');
  return out;
}

/** Correctness per task type for one pack, every system, and each system's paired Δ against the baseline with its MDE. */
function typeTable(types: Record<string, Record<string, Cell>>, deltas: Record<string, Record<string, Paired>>): string[] {
  const systems = [...new Set(Object.values(types).flatMap((t) => Object.keys(t)))].sort();
  const others = systems.filter((s) => s !== BASELINE);
  const rows = Object.keys(types).sort((a, b) => Number(SEPARATION_TYPES.has(b)) - Number(SEPARATION_TYPES.has(a)) || a.localeCompare(b));
  const out = ['### Correctness by task type', '', `Separation families first. Δ is each system's paired difference from ${BASELINE} on that type, with its MDE in parentheses.`, ''];
  out.push(mdTable(['type', 'n', ...systems, ...others.map((s) => `Δ ${s} (MDE)`)], rows.map((type) => [
    type, String(Math.max(...systems.map((s) => types[type][s]?.n ?? 0))), ...systems.map((s) => fmt(types[type][s])),
    ...others.map((s) => {
      const c = deltas[type]?.[s];
      return c ? `${c.diff >= 0 ? '+' : ''}${round(c.diff, 2).toFixed(2)} (${fmtMde(c.mde)})` : '—';
    }),
  ])), '');
  return out;
}

/** Programs shown by name in the agent tool-use table, beside every knode tool used; the rest are summed as "other". */
const TOOL_COLUMNS = 8;

/**
 * Agent tool use: calls per answer, then the most used programs and knode
 * tools as uses per answer (a pipeline `rg … | head` is one call and two
 * uses), over the answers that carry a trace.
 */
function toolTable(tu: Record<string, ToolUse>): string[] {
  const systems = Object.keys(tu).sort();
  const total = new Map<string, number>();
  for (const s of systems) for (const [t, v] of Object.entries(tu[s].perTool)) total.set(t, (total.get(t) ?? 0) + v);
  const ranked = [...total].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  // knode's tools are what the table is for: never folded into "other" behind the shell agents' programs
  const shown = [...ranked.filter((t) => !t.startsWith('knode_')).slice(0, TOOL_COLUMNS), ...ranked.filter((t) => t.startsWith('knode_'))];
  const others = [...total.keys()].filter((t) => !shown.includes(t));
  const out = ['### Agent tool use', '', 'Per answer, over the answers that carry a trace: tool calls (shell commands and MCP calls), then uses of each program (shell agents) or knode tool (MCP agent). A pipeline such as `rg … | head` is one call and two uses.', ''];
  out.push(mdTable(['system', 'traced', 'calls', ...shown, ...(others.length ? ['other'] : [])], systems.map((s) => {
    const x = tu[s];
    if (!x.traced) return [s, `0/${x.n}`, '—', ...shown.map(() => '—'), ...(others.length ? ['—'] : [])];
    const f = (v: number | undefined) => (v ? v.toFixed(1) : '0');
    return [s, `${x.traced}/${x.n}`, x.calls.toFixed(1), ...shown.map((t) => f(x.perTool[t])), ...(others.length ? [f(others.reduce((sum, t) => sum + (x.perTool[t] ?? 0), 0))] : [])];
  })), '');
  const untraced = systems.filter((s) => tu[s].traced < tu[s].n);
  if (untraced.length) out.push(`No trace on ${untraced.map((s) => `${s} (${tu[s].n - tu[s].traced} of ${tu[s].n})`).join(', ')}: answers recorded before agent traces were kept, or that failed before the session ran.`, '');
  return out;
}

/** Where the work was published and who did it, and what was left stuck (docs/design/32). */
function placementLines(d: ReportData): string[] {
  const work = d.run?.work;
  const ran = d.ranAt ?? [];
  const stuck = d.run?.stuck ?? [];
  if (!work && !ran.length && !stuck.length) return [];
  const out = ['## Where the work ran', ''];
  if (work) {
    const local = work.local ? Object.entries(work.local).filter(([, n]) => n).map(([f, n]) => `${f}:${n}`).join(',') : '';
    out.push(`- Published to ${work.broker === 'serve' ? `serve's broker (${work.serve ?? 'this machine'})` : "the run's own broker"}; this machine's slots: ${local ? `--local ${local}${work.legacy ? ' (an old command line: sized from --slots)' : ''}` : 'none'}; pool required: ${work.pool ?? 'any'}; wait limit: ${work.waitMinutes ? `${work.waitMinutes} min` : 'none'}.`);
  }
  if (ran.length) {
    out.push('', mdTable(['pool', 'worker', 'model calls', 'agent sessions', 'replayed from cache'], ran.map((r) => [r.pool, r.worker, String(r.calls), String(r.sessions), String(r.replayed)])));
  }
  if (stuck.length) {
    out.push('', `### Stuck: ${stuck.length} piece(s) left unanswered`, '', 'Three different workers could not serve each of these. The answer, build or scoring pass it belonged to was not recorded; a resume asks it again.', '');
    out.push(mdTable(['piece', 'system', 'task', 'requires', 'workers', 'last error'], stuck.map((p) => [p.label, p.system ?? '—', p.task ?? '—', `${p.family} ${p.model || 'default'}${p.pool ? ` · pool ${p.pool}` : ''}${p.eligible === 'local' ? ' · this machine' : ''}`, p.workers.join(', '), p.lastError.slice(0, 160).replace(/\|/g, '/').replace(/\n/g, ' ')])));
  }
  out.push('');
  return out;
}

export function renderReport(d: ReportData): string {
  const meta = d.run;
  const lines: string[] = [];
  lines.push(`# Knowledge benchmark — ${meta?.id ?? ''}`, '');
  if (meta) {
    lines.push(`- Model: ${meta.model.label} (build effort ${meta.model.buildEffort}, answer effort ${meta.model.answerEffort}); judge: ${meta.judge.label}; embedder: ${meta.embedding}`);
    // knode's index backend (docs/design/31 D1): runs on PGlite and on PostgreSQL are compared, not pooled
    lines.push(`- knode index: ${meta.database?.at ?? 'pglite'}${meta.database?.poolSize ? ` (pool of ${meta.database.poolSize})` : ''}`);
    lines.push(`- Packs: ${d.packs.join(', ')}; systems: ${d.systems.join(', ')}; corpus fraction ${meta.fraction}, seed ${meta.seed}; git ${meta.gitSha?.slice(0, 10) ?? '?'}`);
    lines.push(`- Judge calls: ${d.judgeUsage.calls}`, '');
  }
  lines.push(...placementLines(d));
  lines.push('Intervals are Wilson (rates) or bootstrap (means), 95%. Correctness is the judge score scaled to 0–1. "—" means not measured or not applicable (a system that does not cite has no citation score).', '');

  if (d.pooled.length) {
    lines.push(`## Pooled correctness against ${BASELINE}`, '');
    lines.push('Paired over the tasks both systems answered, all packs pooled; significance after Holm correction across systems.', '');
    lines.push('MDE is the minimum detectable effect of each comparison (α 0.05, power 0.8, from the spread of its paired differences): a |Δ| below it is not evidence the systems are the same — the benchmark could not have told.', '');
    lines.push(mdTable(['system', 'Δ correctness', '95% CI', 'p', 'MDE', 'paired tasks', 'significant'], d.pooled.sort((a, b) => b.diff - a.diff).map((c) => [c.system, round(c.diff, 3).toFixed(3), `[${round(c.ci[0], 3)}, ${round(c.ci[1], 3)}]`, round(c.p, 4).toString(), fmtMde(c.mde), String(c.n), c.significant ? 'yes' : 'no'])), '');
    const sys = d.pooled.map((c) => c.system);
    lines.push(chartBlock({ type: 'hbar', title: `Correctness difference vs ${BASELINE}`, unit: 'Δ correctness (0–1)', x: sys, series: [{ name: 'Δ correctness', values: d.pooled.map((c) => round(c.diff, 3)) }], source: 'scores.jsonl' }), '');
  }

  lines.push(...judgeAuditLines(d.judgeAudit));

  for (const pack of d.packs) {
    lines.push(`## ${pack}`, '');
    const pr = d.paired?.[pack];
    if (pr?.length) {
      lines.push(`### Paired against ${BASELINE}`, '');
      lines.push(mdTable(['system', 'Δ correctness', '95% CI', 'p', 'MDE', 'paired tasks', '|Δ| ≥ MDE'], [...pr].sort((a, b) => b.diff - a.diff).map((c) => [c.system, round(c.diff, 3).toFixed(3), `[${round(c.ci[0], 3)}, ${round(c.ci[1], 3)}]`, round(c.p, 4).toString(), fmtMde(c.mde), String(c.n), Number.isFinite(c.mde) && Math.abs(c.diff) >= c.mde ? 'yes' : 'no'])), '');
    }
    const u = d.usage[pack];
    if (u) lines.push('### Use: answering', '', table(u, USAGE_METRICS), '');
    const sep = d.separation?.[pack];
    const cpc = d.costPerCorrect?.[pack];
    if (sep || cpc) lines.push(...separationTable(sep ?? {}, cpc ?? {}));
    const tp = d.typesByPack?.[pack];
    if (tp) lines.push(...typeTable(tp, d.typeDeltas?.[pack] ?? {}));
    const vr = d.variance?.[pack];
    if (vr && Object.keys(vr).length) {
      lines.push('### Run-to-run variance', '', 'Systems that answered the same tasks more than once (`eval run --repeat`): mean correctness of each repeat over the tasks every repeat answered, the spread across repeats, the mean spread within a task, and the share of tasks whose score changed.', '');
      lines.push(mdTable(['system', 'repeats', 'tasks', 'correctness per repeat', 'SD across repeats', 'mean within-task SD', 'unstable tasks'], Object.entries(vr).sort().map(([s, v]) => [
        s, v.repeats, v.tasks, v.perRepeat.map((x) => round(x, 3).toFixed(3)).join(' / '), fmtMde(v.sdAcrossRepeats), fmtMde(v.withinTaskSd), `${(v.unstable * 100).toFixed(0)}%`,
      ])), '');
      const rp = d.repeatPairs?.[pack];
      if (d.run?.repeat?.sample) lines.push(`Repeats after the first answered a seeded sample of ${d.run.repeat.sample} tasks, stratified by task type (\`--repeat-sample\`); the spread above is on that sample.`, '');
      if (rp?.length) {
        lines.push('#### Paired differences against the run-to-run spread', '', 'On the tasks both systems answered in every repeat: the difference of their mean correctness in each repeat, its mean, and the spread a single run\'s difference has from rerunning alone (√(SD a² + SD b²), from the repeats). Within the spread: the repeats disagree on the sign, or |Δ| ≤ 2 × that spread — the difference is not one rerunning could not produce.', '');
        lines.push(mdTable(['a', 'b', 'tasks', 'Δ per repeat', 'mean Δ', 'run-to-run spread of Δ', 'within the spread'], rp.map((p) => [
          p.a, p.b, p.tasks, p.perRepeat.map((x) => round(x, 3).toFixed(3)).join(' / '), round(p.diff, 3).toFixed(3), fmtMde(p.noise), p.withinSpread ? 'yes' : 'no',
        ])), '');
      }
    }
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
    const tu = d.tools[pack];
    if (tu) lines.push(...toolTable(tu));
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
