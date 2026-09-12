import crypto from 'node:crypto';
import fs from 'node:fs';
import { KnodeConfig } from '../config.js';
import { AppContext } from '../context.js';
import { appendLog } from '../fs/datadir.js';
import { safePath, walkFiles } from '../fs/files.js';
import { applyDocScope } from '../ingest/apply.js';
import { createEmbeddingProvider, EmbeddingProvider } from '../ingest/embeddings.js';
import { applyScope } from '../lineage/scope.js';
import { LlmClient } from '../llm/client.js';
import { Store } from '../store/db.js';
import { optimizePacks } from '../pack/learn.js';
import { distillRecipes, staleOrphanedRecipeSuggestions } from '../compiler/distill.js';
import { evaluatePacks, writeEvalReport } from '../compiler/evaluate.js';
import { writeRankerReport } from '../compiler/ranker.js';
import { syncTraces } from '../traces/sync.js';
import { SuggestionRow, TraceRow } from '../types.js';

/**
 * The dream cycle (gbrain's overnight maintenance + knode-os's trace-driven
 * optimization loop, scaled down to a laptop):
 *
 *   1. Collect recent agent traces (Claude Code + Codex sessions).
 *   2. Digest them: what was asked, which tools ran, what failed, what repeated.
 *   3. Ask the LLM (or heuristics when offline) where skills / memory / the
 *      knowledge base should improve.
 *   4. Write a dream report to wiki/dreams/YYYY-MM-DD.md and queue suggestions
 *      for review in the UI / MCP.
 *
 * Each day's dream is one scope keyed by the date and fingerprinted by the
 * traces it saw: re-running with the same traces is a no-op, new traces
 * dispose the previous report and its pending suggestions before re-applying.
 */

export interface SessionDigest {
  source: 'claude' | 'codex';
  path: string;
  project: string | null;
  startedAt: string | null;
  userRequests: string[];
  toolCounts: Record<string, number>;
  errorCounts: Record<string, number>;
  errorSamples: string[];
  messageCount: number;
}

export interface DreamResult {
  reportPath: string;
  sessions: number;
  suggestions: SuggestionRow[];
}

export async function runDream(
  store: Store,
  config: KnodeConfig,
  llm: LlmClient,
  opts: { lookbackDays?: number; onProgress?: (msg: string) => void; embedder?: EmbeddingProvider } = {},
): Promise<DreamResult> {
  const progress = opts.onProgress ?? (() => {});
  const lookback = opts.lookbackDays ?? config.dream.lookbackDays;
  const since = new Date(Date.now() - lookback * 24 * 3600 * 1000).toISOString();

  // Pull in the latest traces first so every trigger path (CLI, HTTP, nightly
  // scheduler) dreams over the same up-to-date session set.
  try {
    const ts = await syncTraces(store, config);
    if (ts.copied || ts.skills) progress(`trace sync: ${ts.copied} traces, ${ts.skills} skill files`);
  } catch (err) {
    progress(`trace sync failed (continuing with existing traces): ${err instanceof Error ? err.message : err}`);
  }

  const traces = await store.query<TraceRow>(
    `SELECT * FROM traces WHERE started_at >= $1 ORDER BY started_at DESC LIMIT 200`,
    [since],
  );
  progress(`dreaming over ${traces.length} sessions since ${since.slice(0, 10)}`);

  const digests: SessionDigest[] = [];
  for (const t of traces) {
    try {
      digests.push(digestTrace(store.dataDir, t));
    } catch {
      /* unreadable trace */
    }
  }

  const aggregate = aggregateDigests(digests);
  const skillsOnDisk = listSkills(store.dataDir);

  let suggestions: Omit<SuggestionRow, 'id' | 'status' | 'created_at' | 'report_path'>[] = [];
  let analysisNote = '';
  if (llm.enabled && digests.length > 0) {
    try {
      suggestions = await llmSuggestions(llm, config, aggregate, digests, skillsOnDisk);
      analysisNote = `LLM analysis via ${llm.label}.`;
    } catch (err) {
      analysisNote = `LLM analysis failed (${err instanceof Error ? err.message : err}); heuristic fallback used.`;
      suggestions = heuristicSuggestions(aggregate, skillsOnDisk);
    }
  } else {
    analysisNote = digests.length === 0 ? 'No traces in window.' : 'No LLM configured; heuristic analysis only.';
    suggestions = heuristicSuggestions(aggregate, skillsOnDisk);
  }

  const today = new Date().toISOString().slice(0, 10);
  const reportPath = `wiki/dreams/${today}.md`;
  const report = renderReport(today, since, digests, aggregate, suggestions, analysisNote, traces.map((t) => t.id));
  const inputsSha = crypto.createHash('sha256')
    .update(JSON.stringify(traces.map((t) => [t.id, t.sha256]).sort()))
    .digest('hex').slice(0, 24);

  const rows: SuggestionRow[] = [];
  const res = await applyScope(store, { kind: 'dream', key: today }, inputsSha, { actor: 'dream', meta: { sessions: digests.length } }, async (w) => {
    await w.writeFile(reportPath, report);
    await w.page({
      path: reportPath,
      kind: 'dream',
      generator: 'dream@2',
      inputs_sha: inputsSha,
      file_sha: crypto.createHash('sha256').update(report).digest('hex'),
      regions: [],
    });
    await w.deps({ kind: 'page', id: reportPath }, traces.map((t) => ({ kind: 'trace' as const, id: t.id })));
    for (const s of suggestions) {
      const id = await w.suggestion({ kind: s.kind, title: s.title, body: s.body, evidence: s.evidence ?? [], reportPath });
      rows.push({ id, status: 'pending', created_at: new Date().toISOString(), report_path: reportPath, ...s });
    }
  });
  if (res.outcome === 'unchanged') {
    rows.push(...await store.query<SuggestionRow>(`SELECT * FROM suggestions WHERE report_path = $1 ORDER BY created_at DESC`, [reportPath]));
  } else if (fs.existsSync(safePath(store.dataDir, reportPath))) {
    // search projection of the report (indexed as a view)
    const embedder = opts.embedder ?? createEmbeddingProvider(config.embedding);
    await applyDocScope({ store, config, embedder }, reportPath, 'wiki', { queueTier1: false, actor: 'dream' });
  }

  if (traces.length > 0) {
    const ids = traces.map((t) => t.id);
    const ph = ids.map((_, i) => `$${i + 1}`).join(',');
    await store.query(`UPDATE traces SET analyzed_at = now() WHERE id IN (${ph})`, ids);
  }

  // context-pack learning: turn recent pack_events into playbook revisions
  try {
    const packOpt = await optimizePacks(store, config, llm, { lookbackDays: lookback, onProgress: progress });
    rows.push(...packOpt.suggestions);
  } catch (err) {
    progress(`pack optimization failed: ${err instanceof Error ? err.message : err}`);
  }

  // the learning loop proper: rank capabilities from receipts, propose recipes
  // for the plan shapes that keep working, and publish both as readable pages
  try {
    const ranking = await writeRankerReport(store);
    progress(`ranker: ${ranking.rows.length} (slot, capability) pairs → ${ranking.path}`);
    const evaluation = await evaluatePacks(store, { lookbackDays: lookback });
    const evalPath = writeEvalReport(store.dataDir, evaluation);
    progress(`evaluation: precision ${(evaluation.totals.precision * 100).toFixed(0)}% over ${evaluation.totals.reported} reported resolves → ${evalPath}`);
    const distilled = await distillRecipes(store, { lookbackDays: lookback, onProgress: progress });
    rows.push(...distilled.suggestions);
    await staleOrphanedRecipeSuggestions(store);
  } catch (err) {
    progress(`learning loop failed: ${err instanceof Error ? err.message : err}`);
  }

  await store.setMeta('last_dream', { at: new Date().toISOString(), report: reportPath, sessions: digests.length });
  appendLog(store.dataDir, 'dream', `${digests.length} sessions analyzed, ${rows.length} suggestions → ${reportPath}`);
  progress(`dream complete: ${rows.length} suggestions → ${reportPath}`);
  return { reportPath, sessions: digests.length, suggestions: rows };
}

/* ---------------------------------- digest --------------------------------- */

function digestTrace(dataDir: string, t: TraceRow): SessionDigest {
  const abs = safePath(dataDir, t.path);
  const text = fs.readFileSync(abs, 'utf8');
  const d: SessionDigest = {
    source: t.source, path: t.path, project: t.project, startedAt: t.started_at,
    userRequests: [], toolCounts: {}, errorCounts: {}, errorSamples: [], messageCount: 0,
  };
  let lastTool = '';
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    d.messageCount++;

    // Claude Code transcript shape: { type, message: { role, content: [...] } }
    const msg = obj.message ?? obj;
    const content = Array.isArray(msg?.content) ? msg.content : [];
    if (msg?.role === 'user' || obj.type === 'user') {
      for (const part of content) {
        if (part?.type === 'text' && typeof part.text === 'string') addRequest(d, part.text);
        if (part?.type === 'tool_result' && part?.is_error) {
          bump(d.errorCounts, lastTool || 'unknown');
          addErrorSample(d, part);
        }
      }
      if (typeof msg?.content === 'string') addRequest(d, msg.content);
    }
    for (const part of content) {
      if (part?.type === 'tool_use' && typeof part.name === 'string') {
        bump(d.toolCounts, part.name);
        lastTool = part.name;
      }
    }

    // Codex rollout shape: { type, payload: {...} }
    const p = obj.payload;
    if (p && typeof p === 'object') {
      if (p.type === 'function_call' && typeof p.name === 'string') {
        bump(d.toolCounts, p.name);
        lastTool = p.name;
      }
      if (p.type === 'function_call_output' && typeof p.output === 'string' && /error|failed|exit code [1-9]/i.test(p.output.slice(0, 400))) {
        bump(d.errorCounts, lastTool || 'unknown');
        if (d.errorSamples.length < 5) d.errorSamples.push(p.output.slice(0, 240));
      }
      if (p.type === 'message' && p.role === 'user' && Array.isArray(p.content)) {
        for (const c of p.content) {
          if ((c?.type === 'input_text' || c?.type === 'text') && typeof c.text === 'string') addRequest(d, c.text);
        }
      }
    }
  }
  return d;
}

function addRequest(d: SessionDigest, text: string): void {
  const t = text.trim();
  if (!t || t.startsWith('<') || t.startsWith('{')) return; // skip injected/meta content
  if (d.userRequests.length < 10) d.userRequests.push(t.slice(0, 300));
}

function addErrorSample(d: SessionDigest, part: any): void {
  if (d.errorSamples.length >= 5) return;
  const c = part.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => x?.text ?? '').join(' ') : '';
  if (text.trim()) d.errorSamples.push(text.trim().slice(0, 240));
}

function bump(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] ?? 0) + 1;
}

export interface Aggregate {
  sessions: number;
  bySource: Record<string, number>;
  byProject: Record<string, number>;
  toolCounts: Record<string, number>;
  errorCounts: Record<string, number>;
  topRequests: string[];
  errorSamples: string[];
}

function aggregateDigests(digests: SessionDigest[]): Aggregate {
  const agg: Aggregate = { sessions: digests.length, bySource: {}, byProject: {}, toolCounts: {}, errorCounts: {}, topRequests: [], errorSamples: [] };
  for (const d of digests) {
    bump(agg.bySource, d.source);
    if (d.project) bump(agg.byProject, d.project);
    for (const [k, v] of Object.entries(d.toolCounts)) agg.toolCounts[k] = (agg.toolCounts[k] ?? 0) + v;
    for (const [k, v] of Object.entries(d.errorCounts)) agg.errorCounts[k] = (agg.errorCounts[k] ?? 0) + v;
    agg.topRequests.push(...d.userRequests.slice(0, 3));
    agg.errorSamples.push(...d.errorSamples);
  }
  agg.topRequests = agg.topRequests.slice(0, 40);
  agg.errorSamples = agg.errorSamples.slice(0, 15);
  return agg;
}

function listSkills(dataDir: string): string[] {
  try {
    return walkFiles(dataDir, 'raw/skills')
      .filter((f) => /skill\.md$/i.test(f) || f.endsWith('.md'))
      .slice(0, 100);
  } catch {
    return [];
  }
}

/* -------------------------------- suggestions ------------------------------ */

type NewSuggestion = Omit<SuggestionRow, 'id' | 'status' | 'created_at' | 'report_path'>;

const DREAM_SYSTEM = `You are the nightly "dream" of a personal knowledge OS used by coding agents (Claude Code, Codex CLI).
You receive a digest of recent agent sessions: user requests, tool usage, failures, plus the list of skills already installed.

Propose concrete improvements. Each suggestion has:
- kind: "skill" (a new/updated reusable skill or prompt for repetitive workflows), "memory" (a durable fact/preference the agents should remember), or "knowledge" (a gap in the wiki/docs worth documenting).
- title: short imperative.
- body: 2-6 sentences in markdown explaining what to do and why, grounded in the digest. Write in the dominant language of the user requests.
- evidence: short quotes/stats from the digest backing it.

Quality over quantity: 3-8 suggestions, only ones genuinely supported by the data.
Respond JSON only: {"suggestions":[{"kind","title","body","evidence":["..."]}]}`;

async function llmSuggestions(
  llm: LlmClient,
  config: KnodeConfig,
  agg: Aggregate,
  digests: SessionDigest[],
  skills: string[],
): Promise<NewSuggestion[]> {
  const budget = config.dream.maxContextChars;
  let excerpt = '';
  for (const d of digests) {
    const part = `\n--- session ${d.path} (${d.source}, project=${d.project ?? '-'})\nrequests: ${d.userRequests.slice(0, 3).join(' | ')}\ntools: ${topEntries(d.toolCounts, 8)}\nerrors: ${topEntries(d.errorCounts, 5)}\n${d.errorSamples.slice(0, 2).map((s) => 'err: ' + s).join('\n')}`;
    if (excerpt.length + part.length > budget) break;
    excerpt += part;
  }
  const user = `# Aggregate
sessions: ${agg.sessions} (${JSON.stringify(agg.bySource)})
projects: ${topEntries(agg.byProject, 10)}
tool usage: ${topEntries(agg.toolCounts, 15)}
tool errors: ${topEntries(agg.errorCounts, 10)}

# Installed skills (paths)
${skills.slice(0, 50).join('\n') || '(none)'}

# Recent user requests (sample)
${agg.topRequests.map((r) => '- ' + r.replace(/\n/g, ' ')).join('\n')}

# Session excerpts
${excerpt}`;

  const res = await llm.completeJson<{ suggestions?: NewSuggestion[] }>([
    { role: 'system', content: DREAM_SYSTEM },
    { role: 'user', content: user },
  ], { maxTokens: 3000 });
  return (res.suggestions ?? [])
    .filter((s) => s && s.title && s.body)
    .map((s) => ({
      kind: (['skill', 'memory', 'knowledge'] as string[]).includes(s.kind) ? s.kind : 'knowledge',
      title: String(s.title).slice(0, 200),
      body: String(s.body),
      evidence: Array.isArray(s.evidence) ? s.evidence.map(String).slice(0, 6) : [],
    }));
}

function heuristicSuggestions(agg: Aggregate, skills: string[]): NewSuggestion[] {
  const out: NewSuggestion[] = [];
  const errors = Object.entries(agg.errorCounts).sort((a, b) => b[1] - a[1]);
  if (errors.length > 0 && errors[0][1] >= 3) {
    const [tool, n] = errors[0];
    out.push({
      kind: 'skill',
      title: `Reduce repeated ${tool} failures`,
      body: `Tool \`${tool}\` failed ${n} times across recent sessions. Review the error samples in the dream report; if the failures share a cause, encode the fix as a skill or a checklist so agents stop rediscovering it.`,
      evidence: agg.errorSamples.slice(0, 3),
    });
  }
  const tools = Object.entries(agg.toolCounts).sort((a, b) => b[1] - a[1]);
  if (tools.length > 0 && tools[0][1] >= 20) {
    const [tool, n] = tools[0];
    out.push({
      kind: 'memory',
      title: `Capture conventions around heavy ${tool} usage`,
      body: `\`${tool}\` was invoked ${n} times in the window. Frequently repeated invocations usually hide an implicit convention (build commands, directory layout, test runner flags). Write it down once as agent memory / project docs so sessions start warmer.`,
      evidence: [`${tool}: ${n} calls in ${agg.sessions} sessions`],
    });
  }
  if (agg.sessions > 0 && skills.length === 0) {
    out.push({
      kind: 'skill',
      title: 'No skills collected yet — seed raw/skills',
      body: 'Agent sessions exist but no skills were found under raw/skills. Run `knode-os trace sync` (or wait for the scheduled sync) so used skills are mirrored, then dream again to get skill-level analysis.',
      evidence: [`${agg.sessions} sessions, 0 skill files`],
    });
  }
  if (agg.topRequests.length >= 5) {
    out.push({
      kind: 'knowledge',
      title: 'Document the recurring request themes in the wiki',
      body: 'Several user requests in the window look related (see report sample). Topics agents are asked about repeatedly belong in wiki/concepts so future sessions can search instead of re-deriving.',
      evidence: agg.topRequests.slice(0, 3),
    });
  }
  return out;
}

/* ---------------------------------- report --------------------------------- */

function topEntries(rec: Record<string, number>, n: number): string {
  return Object.entries(rec).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)';
}

function renderReport(
  today: string,
  since: string,
  digests: SessionDigest[],
  agg: Aggregate,
  suggestions: NewSuggestion[],
  note: string,
  traceIds: string[] = [],
): string {
  const lines = [
    '---',
    `title: Dream ${today}`,
    'type: dream',
    `description: Agent trace analysis and knowledge-maintenance suggestions for ${today}.`,
    `generated: { by: "knode-os/dream", at: "${new Date().toISOString()}" }`,
    `knode: ${JSON.stringify({ view: 'dream', inputs: { traces: traceIds.slice(0, 200) } })}`,
    '---',
    '',
    `# Dream report — ${today}`,
    '',
    `> Window: since ${since.slice(0, 10)} · ${agg.sessions} sessions · ${note}`,
    '',
    '## Activity',
    '',
    `- sources: ${topEntries(agg.bySource, 5)}`,
    `- projects: ${topEntries(agg.byProject, 10)}`,
    `- tool usage: ${topEntries(agg.toolCounts, 15)}`,
    `- tool errors: ${topEntries(agg.errorCounts, 10)}`,
    '',
    '## Suggestions',
    '',
  ];
  if (suggestions.length === 0) lines.push('_No suggestions this time._');
  for (const s of suggestions) {
    lines.push(`### [${s.kind}] ${s.title}`, '', s.body, '');
    if (s.evidence?.length) {
      lines.push(...s.evidence.map((e) => `> ${(typeof e === 'string' ? e : e.text ?? e.path ?? e.id ?? '').replace(/\n/g, ' ')}`), '');
    }
  }
  lines.push('## Sessions', '');
  for (const d of digests.slice(0, 30)) {
    lines.push(`- \`${d.path}\` — ${d.userRequests[0]?.replace(/\n/g, ' ').slice(0, 120) ?? '(no user text)'}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Minute-resolution scheduler: fires runDream once per day at the configured
 * time. Reads `ctx.config`/`ctx.llm` on every tick so runtime config changes
 * (e.g. from the Settings UI) take effect without a restart.
 */
export function startDreamScheduler(ctx: AppContext, log: (msg: string) => void): NodeJS.Timeout {
  let lastRun = '';
  const tick = async () => {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const today = now.toISOString().slice(0, 10);
    if (hhmm === ctx.config.dream.schedule && lastRun !== today) {
      lastRun = today;
      try {
        const res = await runDream(ctx.store, ctx.config, ctx.llm, { onProgress: log });
        log(`nightly dream done: ${res.suggestions.length} suggestions`);
      } catch (err) {
        log(`nightly dream failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  };
  const timer = setInterval(tick, 30 * 1000);
  timer.unref?.();
  return timer;
}
