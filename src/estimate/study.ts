import fs from 'node:fs';
import path from 'node:path';
import { KnodeConfig } from '../config.js';
import { safePath } from '../fs/files.js';
import { agentForSpec, ResearchAgent, resolveResearchAgent } from '../research/agent.js';
import { studyFolder } from '../research/capture.js';
import { ResearchJob } from '../research/jobs.js';
import { studyPayload } from '../research/study.js';
import { Store } from '../store/db.js';
import { toIso } from '../store/temporal.js';
import { RunTotals } from './codex.js';
import { EstimateLine, inputAt, PerCall, range, Range, serviceShares, TaskEstimate, totalsOf } from './estimate.js';
import { QuotaSources } from './quota.js';
import { priceOf, SERVICE_PROFILES, serviceOfLlm, ServiceId, costOf } from './services.js';

/**
 * What a research study will take before it starts (docs/design/15, 18): a
 * collector per page gathering sources (`research.study.collectors` at once),
 * then a writing job per page (`research.concurrency` at once), then the
 * report — each an agent session of many turns rather than one call.
 *
 * An agent session's size is not knowable from its prompt, so this reads what
 * the studies before it here took: how long each phase ran (the jobs' times,
 * the collectors' own), what Codex logged per run folder (`.runs/<job>`), what
 * Claude Code priced its runs at, how much the captured sources weighed. A
 * workspace with no study yet gets defaults, and says so.
 */

export interface StudyEstimateInput {
  store: Store;
  config: KnodeConfig;
  job: ResearchJob;
  quota: QuotaSources;
  showBalance?: boolean;
  now?: number;
}

/** Until a study has run here: a session's length and size. */
const DEFAULTS = {
  collectSeconds: 600,
  pageSeconds: 480,
  reportSeconds: 360,
  /** An agent session re-reads its growing conversation every turn: mostly cache. */
  sessionInput: 3_000_000,
  sessionCachedShare: 0.94,
  sessionOutput: 15_000,
  capturedBytesPerPage: 3_000_000,
};
/** Each turn sends its conversation again; compressed on the wire, by an unknown amount. */
const BYTES_PER_INPUT_TOKEN = { low: 0.6, expected: 1.5, high: 4 };

interface Phase {
  seconds: number[];
  tokens: RunTotals[];
  costs: number[];
}

export async function estimateStudy(input: StudyEstimateInput): Promise<TaskEstimate> {
  const { store, config, job } = input;
  const now = input.now ?? Date.now();
  const p = studyPayload(job);
  const pages = Math.max(1, p.brief.pages.length);
  const notes: string[] = [];
  const agent: ResearchAgent | null = p.runner.agent
    ? agentForSpec(config, p.runner.agent, p.runner.model, store.dataDir)
    : resolveResearchAgent(config, store.dataDir);
  const service: ServiceId = agent?.kind === 'cli' ? serviceOfLlm({ provider: agent.provider }) : 'api';
  const model = agent?.model ?? '';
  const route = agent ? (agent.kind === 'cli' ? `${agent.provider}${model ? `:${model}` : ''}` : `deep-agents:${model}`) : 'not configured';
  if (!agent) notes.push('No research agent is configured: the study cannot start until one is (Settings → Research).');

  const codex = service === 'codex' ? await input.quota.codex() : null;
  const history = await studyHistory(store, config, agent?.provider ?? null, codex?.runs ?? new Map());
  const collectors = Math.max(1, config.research.study.collectors);
  const writers = Math.max(1, config.research.concurrency ?? 1);
  const deep = p.runner.mode === 'deep-research';

  const lines: EstimateLine[] = [];
  const phase = (kind: string, label: string, calls: number, slots: number, h: Phase, defaultSeconds: number, extraDown: Range = range(0, 0, 0)) => {
    const measuredTime = h.seconds.length >= 2;
    const s = measuredTime ? stats(h.seconds) : range(defaultSeconds * 0.5, defaultSeconds, defaultSeconds * 2);
    const measuredTokens = h.tokens.length >= 1;
    const per = measuredTokens
      ? h.tokens.reduce((a, t) => ({ input: a.input + t.input / h.tokens.length, cached: a.cached + t.cached / h.tokens.length, output: a.output + t.output / h.tokens.length }), { input: 0, cached: 0, output: 0 })
      : { input: DEFAULTS.sessionInput, cached: DEFAULTS.sessionInput * DEFAULTS.sessionCachedShare, output: DEFAULTS.sessionOutput };
    const spread = measuredTokens ? [0.6, 1.8] : [0.3, 3];
    const input = range(per.input * calls * spread[0], per.input * calls, per.input * calls * spread[1]);
    const output = range(per.output * calls * spread[0], per.output * calls, per.output * calls * spread[1]);
    const profile = SERVICE_PROFILES[service];
    const up = range(input.low * BYTES_PER_INPUT_TOKEN.low, input.expected * BYTES_PER_INPUT_TOKEN.expected, input.high * BYTES_PER_INPUT_TOKEN.high);
    const downBase = calls * profile.bytesDown + per.output * calls * 4;
    const down = range(downBase * 0.6 + extraDown.low, downBase + extraDown.expected, downBase * 2 + extraDown.high);
    let costUsd: Range | null = null;
    let priceSource: EstimateLine['priceSource'] = null;
    if (h.costs.length >= 1) {
      const c = h.costs.reduce((a, b) => a + b, 0) / h.costs.length;
      costUsd = range(c * calls * 0.5, c * calls, c * calls * 2);
      priceSource = 'measured';
    } else {
      const price = priceOf(model, config);
      if (price) {
        const at = (k: keyof Range) => costOf(price.price, { ...inputAt({ tokens: { input, cached: per.cached * calls, cacheWrite: 0 } }, k), output: output[k] });
        costUsd = range(at('low'), at('expected'), at('high'));
        priceSource = price.source;
      }
    }
    const perCall: PerCall = {
      input: per.input, cached: per.cached, cacheWrite: 0, output: per.output, seconds: s,
      bytesUp: up.expected / calls, bytesDown: down.expected / calls, costUsd: h.costs.length ? costUsd!.expected / calls : null,
      basis: { tokens: measuredTokens ? 'measured' : 'estimated', time: measuredTime ? 'measured' : 'default', transfer: 'assumed', measuredCalls: h.tokens.length },
    };
    lines.push({
      kind, label, route, service, model, remote: false, slots, calls, perCall,
      tokens: { input, cached: per.cached * calls, cacheWrite: 0, output },
      seconds: { low: s.low * Math.ceil(calls / slots), expected: s.expected * Math.ceil(calls / slots), high: s.high * Math.ceil(calls / slots) },
      bytes: { up, down }, relayBytes: { up: 0, down: 0 }, costUsd, priceSource,
    });
  };

  const captured = history.capturedBytesPerPage ?? DEFAULTS.capturedBytesPerPage;
  const sources = p.sources.web ? range(captured * pages * 0.3, captured * pages, captured * pages * 3) : range(0, 0, 0);
  if (deep) {
    notes.push(`The sources are collected by one deep-research call on ${p.runner.deepResearch?.model || 'its model'}; its size is not estimated.`);
  } else {
    phase('collect', 'Collect sources', pages, collectors, history.collect, DEFAULTS.collectSeconds, sources);
  }
  phase('pages', 'Write pages', pages, writers, history.pages, DEFAULTS.pageSeconds);
  phase('report', 'Report', 1, 1, history.report, DEFAULTS.reportSeconds);

  const totals = totalsOf(lines);
  // the phases follow one another
  totals.seconds = lines.reduce<Range>((t, l) => (l.seconds ? { low: t.low + l.seconds.low, expected: t.expected + l.seconds.expected, high: t.high + l.seconds.high } : t), range(0, 0, 0));
  if (!history.studies) notes.push('No study has run in this workspace yet: the times and sizes are defaults, and the next estimate learns from this one.');
  else notes.push(`From the ${history.studies} stud${history.studies === 1 ? 'y' : 'ies'} and ${history.pages.seconds.length} page job${history.pages.seconds.length === 1 ? '' : 's'} run here before${service === 'codex' && history.pages.tokens.length ? ', with the tokens Codex logged for their runs' : ''}.`);
  if (service === 'cursor' || (service === 'api' && agent?.kind === 'builtin')) notes.push(`${service === 'cursor' ? 'Cursor' : 'The built-in agent'} keeps no per-run token log here, so the tokens are defaults until runs are measured.`);
  notes.push('An agent session sends its conversation again every turn; the upload range spans how much the wire compresses it.');

  const cursorPlan = service === 'cursor' ? await input.quota.cursorPlan() : null;
  return {
    task: 'study',
    title: p.brief.title || 'Research study',
    at: new Date(now).toISOString(),
    work: [
      { label: 'Pages', detail: `${pages} page${pages === 1 ? '' : 's'} and a report, ${p.brief.questions.length} question${p.brief.questions.length === 1 ? '' : 's'}` },
      { label: 'Runs on', detail: agent ? `${route}${deep ? `, sources by deep research (${p.runner.deepResearch?.model || '?'})` : ''}` : 'no agent configured' },
      { label: 'Sources', detail: p.sources.web ? `the web${p.sources.ids.length ? ` and ${p.sources.ids.length} configured source${p.sources.ids.length === 1 ? '' : 's'}` : ''}; up to ${config.research.study.maxCaptures} captured` : p.sources.ids.length ? `${p.sources.ids.length} configured source${p.sources.ids.length === 1 ? '' : 's'}, no web` : 'the knowledge base only' },
    ],
    lines,
    totals,
    services: serviceShares(lines, { config, codex, cursorPlan, stats: [], showBalance: input.showBalance ?? false }),
    notes,
  };
}

function stats(seconds: number[]): Range {
  const sorted = [...seconds].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return range(at(0.1), sorted.reduce((a, b) => a + b, 0) / sorted.length, at(0.9) * 1.25);
}

interface History {
  studies: number;
  collect: Phase;
  pages: Phase;
  report: Phase;
  capturedBytesPerPage: number | null;
}

/**
 * What finished studies here took, by phase: each collector's time (recorded
 * on the study), each page job's, the report's (from the last page to the
 * study's end); per run folder what Codex logged; Claude Code's own prices;
 * and the captured sources' size per page. Runs on another agent than this
 * study's are left out once there are enough on the same one.
 */
async function studyHistory(store: Store, config: KnodeConfig, provider: string | null, runs: Map<string, RunTotals>): Promise<History> {
  const studies = await store.query<{ id: string; agent: string | null; target: string | null; payload: Record<string, unknown>; finished_at: string | Date | null; cost_usd: number | null }>(
    `SELECT id, agent, target, payload, finished_at, cost_usd FROM research_jobs WHERE kind = 'study' AND status = 'done' ORDER BY finished_at DESC LIMIT 20`,
  );
  const sections = await store.query<{ id: string; agent: string | null; started_at: string | Date | null; finished_at: string | Date | null; cost_usd: number | null }>(
    `SELECT id, agent, started_at, finished_at, cost_usd FROM research_jobs WHERE kind = 'section' AND status = 'done' AND started_at IS NOT NULL ORDER BY finished_at DESC LIMIT 100`,
  );
  const same = <T extends { agent: string | null }>(rows: T[]) => {
    const mine = provider ? rows.filter((r) => r.agent === provider) : [];
    return mine.length >= 2 ? mine : rows;
  };
  const runsDir = path.join(store.dataDir, config.research.runsDir || '.runs');
  const runOf = (id: string): RunTotals | undefined => runs.get(path.join(runsDir, id));
  const ms = (a: string | Date | null, b: string | Date | null) => {
    const x = Date.parse(toIso(a) ?? '');
    const y = Date.parse(toIso(b) ?? '');
    return Number.isFinite(x) && Number.isFinite(y) && y > x ? (y - x) / 1000 : null;
  };

  const out: History = { studies: 0, collect: { seconds: [], tokens: [], costs: [] }, pages: { seconds: [], tokens: [], costs: [] }, report: { seconds: [], tokens: [], costs: [] }, capturedBytesPerPage: null };
  const sectionsById = new Map(sections.map((s) => [s.id, s]));
  for (const s of same(sections)) {
    const sec = ms(s.started_at, s.finished_at);
    if (sec) out.pages.seconds.push(sec);
    const run = runOf(s.id);
    if (run) out.pages.tokens.push(run);
    if (s.cost_usd) out.pages.costs.push(s.cost_usd);
  }
  let capturedBytes = 0;
  let capturedPages = 0;
  for (const st of same(studies)) {
    out.studies++;
    const payload = st.payload ?? {};
    const collect = Array.isArray(payload.collect) ? (payload.collect as { role?: string; ms?: number; costUsd?: number | null }[]) : [];
    for (const c of collect.filter((c) => c.role === 'collector')) {
      if (typeof c.ms === 'number' && c.ms > 0) out.collect.seconds.push(c.ms / 1000);
      if (typeof c.costUsd === 'number' && c.costUsd > 0) out.collect.costs.push(c.costUsd);
    }
    const collectRun = runOf(`${st.id}-collect`);
    if (collectRun && collectRun.sessions > 0) {
      for (let i = 0; i < collectRun.sessions; i++) {
        out.collect.tokens.push({ ...collectRun, input: collectRun.input / collectRun.sessions, cached: collectRun.cached / collectRun.sessions, output: collectRun.output / collectRun.sessions, sessions: 1 });
      }
    }
    // the report runs after the last page: from its end to the study's
    const children = Array.isArray(payload.children) ? (payload.children as string[]) : [];
    const lastPage = children.map((id) => sectionsById.get(id)?.finished_at).filter(Boolean).map((t) => toIso(t!)!).sort().pop() ?? null;
    const report = lastPage ? ms(lastPage, st.finished_at) : null;
    if (report) out.report.seconds.push(report);
    const reportRun = runOf(st.id);
    if (reportRun) out.report.tokens.push(reportRun);
    if (st.cost_usd) out.report.costs.push(st.cost_usd);
    if (st.target) {
      const pagesOf = Array.isArray((payload.brief as { pages?: unknown[] } | undefined)?.pages) ? ((payload.brief as { pages: unknown[] }).pages.length) : children.length;
      const size = folderBytes(store.dataDir, studyFolder(st.target));
      if (size > 0 && pagesOf > 0) {
        capturedBytes += size;
        capturedPages += pagesOf;
      }
    }
  }
  if (capturedPages > 0) out.capturedBytesPerPage = capturedBytes / capturedPages;
  return out;
}

/** Bytes under a folder of the workspace, its sidecars not included. */
function folderBytes(dataDir: string, rel: string): number {
  let total = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          total += fs.statSync(p).size;
        } catch {
          // gone meanwhile
        }
      }
    }
  };
  try {
    walk(safePath(dataDir, rel));
  } catch {
    return 0;
  }
  return total;
}
