import fs from 'node:fs';
import path from 'node:path';
import { AppContext } from '../context.js';
import { safePath } from '../fs/files.js';
import { pool } from '../pool.js';
import { ResearchAgent, withModel } from './agent.js';
import { getJob, ResearchJob } from './jobs.js';
import { isCancelled, JobCancelledError, LaunchResult, launchSession, SessionResult } from './launch.js';
import { effectiveEffort, effectiveSpeed, NativeAgentSpec, requiredSections, ResearchProfile, ResearchRole, revisionRounds, rolePrompt, rolesFor, webAllowed } from './profile.js';
import { loadPhasePrompt, PhaseName, ResearchTemplate, researchSlug, subjectOf } from './templates.js';
import type { ExtraMcpServer } from './sources.js';
import { McpEndpoint, RunWorkspace } from './workspace.js';
import { validateCompanions, validateResearchPage } from './validate.js';

/**
 * The team pipeline (pipeline = "team") — deep research as a small
 * organisation rather than one long session, driven by the profile's roles:
 *
 *   plan        a `plan` role reads the brief, scouts the index, returns an outline (JSON)
 *   research    `research` roles take the sections in parallel (round-robin when
 *               there are several), each returns findings
 *   synthesize  the `synthesize` role turns the findings into the page (knode_write)
 *   review      every `review` role critiques the page (JSON verdict); the
 *               deterministic validator runs alongside
 *   revise      the `revise` role fixes what review + validation found; rounds
 *               come from the reviser, else research.reviewRounds
 *
 * A disabled role skips its phase (no planner → the template's sections; no
 * researcher → the synthesizer researches itself; no critic → validator only).
 * Every role can run on its own CLI / model / effort / tool scope, with its
 * own prompt file. The harness carries state between sessions as files under
 * the run directory (plan.json, findings/*.md, phases.json).
 *
 * The native pipeline (pipeline = "native") is one orchestrator session that
 * gets the roles marked `native` as the CLI's own sub-agents (claude --agents,
 * codex agents.<id>) and does the delegation itself.
 */

export interface PhaseRecord {
  name: PhaseName;
  label: string;
  role: string;
  agent: string;
  turns: number | null;
  costUsd: number | null;
  error: string | null;
  ms: number;
}

export interface PipelineResult extends LaunchResult {
  phases: PhaseRecord[];
  sections: string[];
  reviewRounds: number;
  /** The planner's raw reply (an init job's topics are read from it). */
  planText: string;
}

export interface PipelineInput {
  job: ResearchJob;
  template: ResearchTemplate;
  ws: RunWorkspace;
  /** The job's agent; roles without an `agent` of their own run on it. */
  agent: ResearchAgent;
  mcp: McpEndpoint;
  readDirs: string[];
  profile: ResearchProfile;
  /** Resolve a role's own agent spec (connection id or provider); null = unknown, fall back to `agent`. */
  agentFor: (spec: string, model: string) => ResearchAgent | null;
  /** review.external — the master switch for web tools. */
  webGate: 'off' | 'verify' | 'research';
  /** knode's own web search is configured (research.web.search): the built-in agent can search too. */
  webSearch?: boolean;
  /** A study's research sources: MCP servers attached to every session. */
  extraMcp?: ExtraMcpServer[];
  log: (m: string) => void;
}

interface OutlineSection {
  title: string;
  questions: string[];
  queries: string[];
  entities: string[];
}

/** First `{…}` object in a model's reply, tolerating code fences and prose around it. */
export function extractJson<T>(text: string): T | null {
  const stripped = text.replace(/```(?:json)?/gi, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

function strings(v: unknown, max = 8): string[] {
  return (Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean).slice(0, max);
}

function heading(title: string): string {
  return title.replace(/^#+\s*/, '').trim();
}

/** Sections the synthesizer fills from the findings rather than a researcher: sources and the evidence table. */
function synthesizerOwned(title: string): boolean {
  return /来源|sources|证据表|evidence/i.test(heading(title));
}

export function outlineFrom(text: string, required: string[], subject: string, maxSections = 8): OutlineSection[] {
  const parsed = text ? extractJson<{ sections?: unknown }>(text) : null;
  const sections: OutlineSection[] = [];
  for (const raw of Array.isArray(parsed?.sections) ? parsed!.sections : []) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    if (!title || synthesizerOwned(title)) continue;
    sections.push({ title: title.startsWith('#') ? title : `## ${title}`, questions: strings(o.questions), queries: strings(o.queries), entities: strings(o.entities) });
  }
  // every required section is researched even when the planner forgot it
  for (const req of required) {
    const norm = heading(req);
    if (synthesizerOwned(req)) continue;
    if (!sections.some((s) => heading(s.title).startsWith(norm))) {
      sections.push({ title: req, questions: [`${subject} 的${norm}是什么？有哪些依据？`], queries: [subject, `${subject} ${norm}`], entities: [subject] });
    }
  }
  return sections.slice(0, Math.max(1, maxSections));
}

/** A cancelled job (in this process, or by another process flipping the row) launches nothing more. */
async function assertNotCancelled(ctx: AppContext, jobId: string): Promise<void> {
  if (isCancelled(jobId)) throw new JobCancelledError(jobId);
  const row = await getJob(ctx.store, jobId);
  if (row?.status === 'cancelled') throw new JobCancelledError(jobId);
}

/** The template's companion files (an init job's guide), for a critic's or reviser's prompt. */
function companionsText(ctx: AppContext, ws: RunWorkspace, cap = 20_000): string {
  const parts: string[] = [];
  for (const c of ws.companions ?? []) {
    const abs = safePath(ctx.dataDir, c.path);
    const text = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    parts.push(`# 当前附加输出（${c.path}）\n\n${text ? text.slice(0, cap) : `（尚未写入 ${c.path}）`}`);
  }
  return parts.join('\n\n');
}

/** The CLI a role runs on: its own `agent` (connection id / provider) when resolvable, else the job's. */
export function roleAgent(role: ResearchRole, input: Pick<PipelineInput, 'agent' | 'agentFor' | 'log' | 'job'>): ResearchAgent {
  const own = role.agent ? input.agentFor(role.agent, role.model) : null;
  if (role.agent && !own) input.log(`research ${input.job.id}: role ${role.id} names unknown agent "${role.agent}" — using ${input.agent.provider}`);
  return withModel(own ?? input.agent, role.model);
}

interface Sessions {
  run: (role: ResearchRole, name: PhaseName, label: string, prompt: string, opts?: { turns?: number; agents?: NativeAgentSpec[] }) => Promise<SessionResult>;
  phases: PhaseRecord[];
  totals: { turns: number; cost: number };
  defaultTurns: number;
}

function sessions(ctx: AppContext, input: PipelineInput): Sessions {
  const { job, ws, profile, template, log } = input;
  const research = ctx.config.research;
  const defaultTurns = template.maxTurns ?? research?.maxTurns ?? 40;
  const phases: PhaseRecord[] = [];
  const totals = { turns: 0, cost: 0 };
  const run: Sessions['run'] = async (role, name, label, prompt, opts = {}) => {
    await assertNotCancelled(ctx, job.id);
    const agent = roleAgent(role, input);
    const turns = opts.turns ?? (role.maxTurns || defaultTurns);
    const t0 = Date.now();
    log(`research ${job.id}: ${label} (${role.id} on ${agent.provider}${agent.model ? ` ${agent.model}` : ''}, ≤${turns} turns)`);
    const r = await launchSession({
      agent,
      maxTurns: turns,
      timeoutMs: research?.timeoutMs ?? 1_200_000,
      cwd: ws.dir,
      prompt,
      mcp: input.mcp,
      readDirs: input.readDirs,
      jobId: job.id,
      outputPath: ws.outputPath,
      worksetId: ws.worksetId,
      allowNetwork: webAllowed({ gate: input.webGate, kind: job.kind, profile, role, agent, search: input.webSearch }),
      tools: role.tools.write ? 'write' : 'read',
      files: role.tools.files,
      effort: effectiveEffort(profile, role),
      speed: effectiveSpeed(profile, role),
      webFreshness: profile.search.freshness,
      agents: opts.agents,
      extraMcp: input.extraMcp,
      label,
    });
    phases.push({ name, label, role: role.id, agent: agent.provider, turns: r.turns, costUsd: r.costUsd, error: r.error, ms: Date.now() - t0 });
    totals.turns += r.turns ?? 0;
    totals.cost += r.costUsd ?? 0;
    fs.writeFileSync(path.join(ws.dir, 'phases.json'), JSON.stringify(phases, null, 2) + '\n');
    return r;
  };
  return { run, phases, totals, defaultTurns };
}

function baseVars(input: PipelineInput, defaultTurns: number): Record<string, string> {
  const { job, ws, profile } = input;
  return {
    output: ws.outputPath,
    workset: ws.worksetId,
    target: subjectOf(job),
    maxTurns: String(Math.min(12, defaultTurns)),
    searchRounds: String(profile.search.maxRounds),
    maxSections: String(profile.stop.maxSections),
  };
}

export async function runTeamPipeline(ctx: AppContext, input: PipelineInput): Promise<PipelineResult> {
  const { job, template, ws, profile, log } = input;
  const research = ctx.config.research;
  const brief = fs.readFileSync(ws.briefPath, 'utf8');
  const subject = subjectOf(job);
  const S = sessions(ctx, input);
  const vars = baseVars(input, S.defaultTurns);
  const required = requiredSections(template, profile, job);
  const phasePrompt = template.phases ?? {};

  /* ---- 1. plan ---- */
  const planner = rolesFor(profile, 'plan')[0] ?? null;
  let planText = '';
  if (planner) {
    const plan = await S.run(planner, 'plan', 'plan', `${rolePrompt(ctx.dataDir, planner, vars, phasePrompt.plan)}\n\n---\n\n${brief}`, { turns: planner.maxTurns || Math.min(12, S.defaultTurns) });
    planText = plan.text;
  } else {
    log(`research ${job.id}: no planner role in profile "${profile.name}" — outline is the template's required sections`);
  }
  const sections = outlineFrom(planText, required, subject, profile.stop.maxSections);
  fs.writeFileSync(path.join(ws.dir, 'plan.json'), JSON.stringify({ planner: planner?.id ?? null, raw: planText.slice(0, 20_000), sections }, null, 2) + '\n');

  /* ---- 2. research, in parallel ---- */
  const researchers = rolesFor(profile, 'research');
  const findingsDir = path.join(ws.dir, 'findings');
  fs.mkdirSync(findingsDir, { recursive: true });
  let findings: { section: OutlineSection; text: string; role: string }[] = [];
  if (researchers.length) {
    const concurrency = Math.max(1, ...researchers.map((r) => r.parallel || research?.researchers || 3));
    findings = await pool(sections, concurrency, async (section, i) => {
      const researcher = researchers[i % researchers.length];
      const prompt = rolePrompt(ctx.dataDir, researcher, {
        ...vars,
        section: heading(section.title),
        questions: section.questions.map((q) => `- ${q}`).join('\n') || '- （按章节标题自行确定）',
        queries: section.queries.join('、') || subject,
      }, phasePrompt.research);
      const r = await S.run(researcher, 'research', `research-${i + 1}`, `${prompt}\n\n---\n\n## 任务简报（供参考）\n\n${brief}`);
      const text = r.text.trim() || `（研究员 ${i + 1} 没有返回内容${r.error ? `：${r.error}` : ''}）`;
      const file = path.join(findingsDir, `${String(i + 1).padStart(2, '0')}-${researchSlug(heading(section.title)) || 'section'}.md`);
      fs.writeFileSync(file, `# ${heading(section.title)}\n\n${text}\n`);
      return { section, text, role: researcher.id };
    });
  } else {
    log(`research ${job.id}: no researcher role in profile "${profile.name}" — the synthesizer researches on its own`);
  }

  /* ---- 3. synthesize ---- */
  const synth = rolesFor(profile, 'synthesize')[0];
  if (!synth) throw new Error(`profile "${profile.name}" has no enabled synthesize role — nothing would write the page`);
  const budget = 80_000;
  let findingsText = findings.length
    ? findings.map((f) => `### 研究员发现（${f.role}）：${heading(f.section.title)}\n\n${f.text}`).join('\n\n')
    : `（本 profile 没有研究员：请自行用 knode_search / knode_graph_search / knode_claims 逐节取证——章节：${sections.map((s) => heading(s.title)).join('、')}——然后写页）`;
  if (findingsText.length > budget) findingsText = findingsText.slice(0, budget) + '\n\n（发现过长，已截断）';
  const synthRes = await S.run(synth, 'synthesize', 'synthesize', `${rolePrompt(ctx.dataDir, synth, vars, phasePrompt.synthesize)}\n\n---\n\n${brief}\n\n---\n\n# 研究员发现\n\n${findingsText}`);
  let lastError = synthRes.error;

  /* ---- 4/5. review → revise ---- */
  const critics = rolesFor(profile, 'review');
  const revisers = rolesFor(profile, 'revise');
  const rounds = revisionRounds(critics, revisers, research?.reviewRounds ?? 1);
  let reviewRounds = 0;
  let summary = synthRes.text;
  for (let round = 0; round <= rounds; round++) {
    const abs = safePath(ctx.dataDir, ws.outputPath);
    const pageText = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    const report = await validateResearchPage(ctx, { job, template, ws, profile });
    const companionReport = validateCompanions(ctx, ws);
    const issues: string[] = [...report.errors, ...companionReport.errors];
    const extra = (ws.companions ?? []).length ? `\n\n---\n\n${companionsText(ctx, ws)}` : '';
    if (pageText) {
      for (const critic of critics) {
        const label = critics.length > 1 ? `review-${round + 1}-${critic.id}` : `review-${round + 1}`;
        const review = await S.run(critic, 'review', label, `${rolePrompt(ctx.dataDir, critic, vars, phasePrompt.review)}\n\n---\n\n${brief}\n\n---\n\n# 当前页面\n\n${pageText.slice(0, 40_000)}${extra}`, {
          turns: critic.maxTurns || Math.min(12, S.defaultTurns),
        });
        const verdict = extractJson<{ pass?: unknown; issues?: unknown; summary?: unknown }>(review.text);
        if (typeof verdict?.summary === 'string') summary = verdict.summary;
        const found = (Array.isArray(verdict?.issues) ? verdict!.issues : []).map((i) => {
          const o = (i ?? {}) as Record<string, unknown>;
          return [o.where, o.problem, o.fix].filter(Boolean).map(String).join(' — ');
        }).filter(Boolean);
        if (verdict && verdict.pass !== true) issues.push(...found);
        else if (found.length) log(`research ${job.id}: ${critic.id} passed the page with ${found.length} minor notes`);
      }
    } else {
      issues.push(`no page at ${ws.outputPath} — the synthesizer must write it with knode_write`);
    }
    if (issues.length === 0) break;
    reviewRounds++;
    if (round >= rounds || revisers.length === 0) {
      lastError = `review found ${issues.length} issue(s) after ${round} revision round(s): ${issues.slice(0, 3).join('; ')}`;
      break;
    }
    const reviser = revisers[0];
    const companionNote = (ws.companions ?? []).length
      ? `\n\n本任务还有附加输出文件：${ws.companions.map((c) => `\`${c.path}\``).join('、')}（用 knode_read 读取当前内容；涉及它们的问题同样用 knode_write 写回同一路径）。`
      : '';
    const revise = await S.run(reviser, 'revise', `revise-${round + 1}`, `${rolePrompt(ctx.dataDir, reviser, { ...vars, issues: issues.map((x) => `- ${x}`).join('\n') }, phasePrompt.revise)}${companionNote}\n\n---\n\n${brief}`);
    if (revise.error) lastError = revise.error;
  }

  return {
    exitCode: S.phases.some((p) => p.error) ? 1 : 0,
    turns: S.totals.turns || null,
    costUsd: S.totals.cost || null,
    resultText: summary,
    error: lastError,
    transcriptPath: path.join(ws.dir, 'transcript-synthesize.jsonl'),
    phases: S.phases,
    sections: sections.map((s) => s.title),
    reviewRounds,
    planText,
  };
}

/** The sub-agent definitions handed to the CLI in native mode: enabled roles marked `native`, never the writer itself. */
export function nativeAgentSpecs(ctx: AppContext, input: PipelineInput, vars: Record<string, string>): NativeAgentSpec[] {
  const { profile, template } = input;
  const delegated = '（由主管在任务中给出）';
  return profile.roles
    .filter((r) => r.enabled && r.native && r.phase !== 'synthesize' && r.phase !== 'revise')
    .map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description || r.title,
      prompt: rolePrompt(ctx.dataDir, r, { ...vars, section: delegated, questions: delegated, queries: delegated, issues: delegated }, template.phases?.[r.phase]),
      write: false,
      files: r.tools.files,
      web: webAllowed({ gate: input.webGate, kind: input.job.kind, profile, role: r, agent: input.agent, search: input.webSearch }),
      model: r.model,
      effort: effectiveEffort(profile, r),
      speed: effectiveSpeed(profile, r),
    }));
}

export async function runNativePipeline(ctx: AppContext, input: PipelineInput): Promise<PipelineResult> {
  const { job, ws, profile, log } = input;
  const S = sessions(ctx, input);
  const vars = baseVars(input, S.defaultTurns);
  const brief = fs.readFileSync(ws.briefPath, 'utf8');
  const writer = rolesFor(profile, 'synthesize')[0];
  const orchestrator: ResearchRole = {
    ...(writer ?? { id: 'orchestrator', title: '主管', phase: 'synthesize', enabled: true, agent: '', model: '', effort: 'default', speed: 'default', parallel: 0, rounds: 0, maxTurns: 0, prompt: '', native: false, description: '' }),
    tools: { write: true, files: writer?.tools.files ?? true, web: writer?.tools.web ?? 'inherit' },
  };
  const agent = roleAgent(orchestrator, input);
  let agents = nativeAgentSpecs(ctx, input, vars);
  let prompt = brief;
  if (agent.kind === 'cli' && agent.provider === 'cursor-cli') {
    log(`research ${job.id}: cursor-agent has no sub-agent definitions — running one session`);
    agents = [];
  } else if (agents.length === 0) {
    log(`research ${job.id}: profile "${profile.name}" marks no role as native — running one session`);
  } else {
    const list = agents.map((a) => `- ${a.id}（${a.title}）：${a.description}${a.web ? '；可联网' : ''}`).join('\n');
    prompt = `${loadPhasePrompt(ctx.dataDir, 'orchestrate', { ...vars, agents: list })}\n\n---\n\n${brief}`;
  }
  const r = await S.run(orchestrator, 'orchestrate', 'agent', prompt, { agents: agents.length ? agents : undefined, turns: orchestrator.maxTurns || S.defaultTurns });
  return {
    exitCode: r.error ? 1 : 0,
    turns: S.totals.turns || null,
    costUsd: S.totals.cost || null,
    resultText: r.text,
    error: r.error,
    transcriptPath: r.transcriptPath,
    phases: S.phases,
    sections: [],
    reviewRounds: 0,
    planText: '',
  };
}
