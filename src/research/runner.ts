import fs from 'node:fs';
import path from 'node:path';
import { KnodeConfig } from '../config.js';
import { closeWorkset } from '../compiler/workset.js';
import { AppContext } from '../context.js';
import { appendLog } from '../fs/datadir.js';
import { safePath } from '../fs/files.js';
import { sync } from '../ingest/sync.js';
import { agentForSpec, agentWebCapable, ResearchAgent, resolveResearchAgent } from './agent.js';
import { finalizeInit, prepareInit, topicsFrom } from './init.js';
import { activePause, AgentUnavailableError, agentKey, PAUSE, pauseFor, pausingFailure, RunPause } from './failure.js';
import type { QuotaHold } from '../labeling/plan-quota.js';
import { clearCancelled, isCancelled, JobCancelledError, JobInterruptedError, launchAgent, LaunchResult, SessionDispatch } from './launch.js';
import { PhaseRecord, runNativePipeline, runTeamPipeline } from './pipeline.js';
import { getJob, listJobs, ResearchJob, setJobPause, updateJob } from './jobs.js';
import { activeProfile, effectivePipeline, ResearchProfile, webAllowed } from './profile.js';
import { renderSurvey } from './survey.js';
import { ResearchTemplate, templateFor } from './templates.js';
import { validateCompanions, validateResearchPage } from './validate.js';
import { McpEndpoint, prepareRunWorkspace, pruneRuns, runsRoot, RunWorkspace } from './workspace.js';
import { markStudyReport, runStudyCollect, studyAgent, studyBriefLines, studyMcpServers, studyPayload, studyProfile } from './study.js';
import { webSearchEnabled } from './web.js';
import { ensureRecentResearch } from '../wiki/pages.js';
import { fileMergeCandidate } from '../graph/dedupe.js';
import { readEntityCorrections } from '../graph/corrections.js';
import { resolveEntityId } from '../graph/resolve.js';
import { wikilinkName } from '../graph/frontmatter.js';

/**
 * One research job, start to finish:
 *
 *   template + protocol → run workspace (brief, schema, MCP config)
 *   → launch the configured CLI, headless, read-only, MCP attached
 *   → validate the page it wrote through knode_write (retry once with the
 *     reasons in the brief) → sync that one path (it lands as a quarantined
 *     Source: aliases, relations and claims enter the graph, disputes open
 *     where it contradicts trusted facts) → log it.
 */

export type { ResearchAgent } from './agent.js';
export { resolveResearchAgent } from './agent.js';

export interface RunOptions {
  mcp: McpEndpoint;
  /** Remote workers that may run the job's sessions (src/research/remote.ts, docs/design/27). */
  sessions?: SessionDispatch;
  log?: (msg: string) => void;
  /** Override the agent (tests point it at a fake CLI). */
  agent?: ResearchAgent;
  /** Override the profile (tests); default = research.profile. */
  profile?: ResearchProfile;
}

const MAX_ATTEMPTS = 2;

/** True when the row was cancelled (by this process or another) while the job ran. */
async function wasCancelled(ctx: AppContext, jobId: string): Promise<boolean> {
  if (isCancelled(jobId)) return true;
  return (await getJob(ctx.store, jobId))?.status === 'cancelled';
}

async function markCancelled(ctx: AppContext, jobId: string, log: (m: string) => void): Promise<ResearchJob> {
  log(`research ${jobId}: cancelled`);
  const row = (await updateJob(ctx.store, jobId, { status: 'cancelled', finishedAt: new Date().toISOString() }))!;
  clearCancelled(jobId);
  return row;
}

/** A run a restart stopped goes back in line, with the attempt its claim charged handed back. */
async function markInterrupted(ctx: AppContext, jobId: string, log: (m: string) => void): Promise<ResearchJob> {
  log(`research ${jobId}: interrupted by a restart — queued again`);
  const now = await getJob(ctx.store, jobId);
  const row = (await updateJob(ctx.store, jobId, { status: 'queued', attempts: Math.max(0, (now?.attempts ?? 1) - 1) }))!;
  clearCancelled(jobId);
  return row;
}

const PAUSE_WORDS: Record<RunPause['kind'], string> = {
  quota: 'the agent\'s usage limit is spent',
  transient: 'the agent could not serve the run',
  setup: 'the agent cannot run until it is set up again',
};

/** The payload a run that ended leaves: its pause, if it had one, is over. */
function withoutPause(payload: Record<string, unknown>): Record<string, unknown> {
  const out = { ...payload };
  delete out.pause;
  return out;
}

/**
 * A run that ended without its page. When the agent could not serve it — a
 * spent usage limit, a rate limit, a lost login (failure.ts; `agentErrors` are
 * the sessions' own messages, the only ones read for that) — the job waits
 * instead, its attempts and its brief untouched, and so does everything queued
 * on the same account. Otherwise it goes again with the reason in its brief,
 * once, or fails.
 */
async function failRun(ctx: AppContext, job: ResearchJob, input: { error: string; retry: boolean; agent: ResearchAgent; agentErrors: (string | null | undefined)[]; log: (m: string) => void }): Promise<ResearchJob> {
  const { log } = input;
  if (await wasCancelled(ctx, job.id)) return markCancelled(ctx, job.id, log);
  const failure = pausingFailure(input.agentErrors);
  const pause = failure ? pauseFor(failure, (job.payload.pause as RunPause | undefined) ?? null, agentKey(input.agent)) : null;
  if (failure && pause) {
    log(`research ${job.id}: ${PAUSE_WORDS[pause.kind]} (${pause.reason.slice(0, 160)}) — waits until ${pause.until}`);
    const row = (await updateJob(ctx.store, job.id, { status: 'queued', error: failure.message, attempts: Math.max(0, job.attempts - 1), payload: { ...job.payload, pause } }))!;
    if (pause.kind !== 'transient') {
      const n = await pauseAgentQueue(ctx, pause, job.id).catch(() => 0);
      if (n) log(`research: ${n} more queued job(s) on ${pause.agent} wait with it`);
    }
    return row;
  }
  const rejections = [...(Array.isArray(job.payload.rejections) ? (job.payload.rejections as string[]) : []), input.error];
  if (input.retry && job.attempts < MAX_ATTEMPTS) {
    log(`research ${job.id}: rejected (${input.error.slice(0, 160)}) — requeued for one more attempt`);
    return (await updateJob(ctx.store, job.id, { status: 'queued', error: input.error, payload: { ...withoutPause(job.payload), rejections } }))!;
  }
  log(`research ${job.id}: failed — ${input.error.slice(0, 200)}`);
  return (await updateJob(ctx.store, job.id, { status: 'failed', error: input.error, finishedAt: new Date().toISOString(), payload: { ...withoutPause(job.payload), rejections } }))!;
}

/**
 * Every other queued job on the account whose quota ran out (or whose login
 * lapsed) waits with it: claimed now, it would only fail the same way, one
 * after another. A job already waiting longer keeps its own pause.
 */
async function pauseAgentQueue(ctx: AppContext, pause: RunPause, except: string): Promise<number> {
  let n = 0;
  for (const j of await listJobs(ctx.store, { status: 'queued', limit: 500 })) {
    if (j.id === except) continue;
    const current = activePause(j.payload);
    if (current && Date.parse(current.until) >= Date.parse(pause.until)) continue;
    let agent: ResearchAgent | null = null;
    try {
      agent = agentForJob(ctx, j);
    } catch {
      continue;
    }
    if (!agent || agentKey(agent) !== pause.agent) continue;
    if (await setJobPause(ctx.store, j.id, { ...pause }, { onlyQueued: true })) n++;
  }
  return n;
}

/** How long a job held by the quota floor waits when the plan's reading names no reset: then it looks again. */
const FLOOR_RECHECK_MS = 10 * 60_000;

/**
 * A claimed job whose agent's plan is under the quota floor
 * (`processing.minQuotaPercent`, src/labeling/background-floor.ts): it goes
 * back in line with its attempt handed back, paused (a `quota` pause, as a
 * spent limit would leave) until the window resets, and so does every job
 * queued on the same account. Once the pause runs out it is claimed again,
 * and runs if the plan is over the floor by then.
 */
export async function holdJobForQuota(ctx: AppContext, job: ResearchJob, agent: ResearchAgent, hold: QuotaHold, log: (m: string) => void = () => {}): Promise<ResearchJob> {
  const now = Date.now();
  const reset = hold.until ? Date.parse(hold.until) : NaN;
  const until = Number.isFinite(reset) && reset > now ? Math.min(reset + PAUSE.marginMs, now + PAUSE.maxWaitMs) : now + FLOOR_RECHECK_MS;
  const prev = activePause(job.payload, 0);
  const pause: RunPause = {
    kind: 'quota',
    reason: `${hold.reason} (processing.minQuotaPercent)`,
    since: prev?.kind === 'quota' ? prev.since : new Date(now).toISOString(),
    until: new Date(until).toISOString(),
    // the floor is no failure: it never counts towards giving the job up
    count: prev?.kind === 'quota' ? prev.count : 0,
    agent: agentKey(agent),
    resetKnown: Number.isFinite(reset) && reset > now,
  };
  log(`research ${job.id}: waits until ${pause.until}: ${pause.reason}`);
  const row = (await updateJob(ctx.store, job.id, { status: 'queued', attempts: Math.max(0, job.attempts - 1), payload: { ...job.payload, pause } }))!;
  const n = await pauseAgentQueue(ctx, pause, job.id).catch(() => 0);
  if (n) log(`research: ${n} more queued job(s) on ${pause.agent} wait with it`);
  return row;
}

/** A study and its pages carry their own runner; every other job runs on research.agent. */
function isStudyJob(job: ResearchJob): boolean {
  return job.kind === 'study' || job.kind === 'section';
}

/** The agent a job runs on: the test's override, a study's own runner, else research.agent. */
export function agentForJob(ctx: AppContext, job: ResearchJob): ResearchAgent | null {
  return isStudyJob(job) ? studyAgent(ctx, job) : resolveResearchAgent(ctx.config, ctx.dataDir);
}

export async function runResearchJob(ctx: AppContext, jobIn: ResearchJob, opts: RunOptions): Promise<ResearchJob> {
  const log = opts.log ?? (() => {});
  const research = ctx.config.research;
  const agent = opts.agent ?? agentForJob(ctx, jobIn);
  if (!agent) throw new Error(`no research agent configured: set research.agent to a CLI (claude-cli / codex-cli / cursor-cli), a connection id, or 'default' to run the built-in agent on the default LLM connection (Settings → Providers & Agents)`);
  clearCancelled(jobIn.id); // a job that starts (or restarts) is not cancelled, whatever an earlier attempt was
  let job = (await updateJob(ctx.store, jobIn.id, {
    status: 'running',
    agent: agent.provider,
    model: agent.model || null,
    startedAt: jobIn.startedAt ?? new Date().toISOString(),
    attempts: jobIn.status === 'running' ? jobIn.attempts : jobIn.attempts + 1,
  }))!;
  const template = templateFor(ctx.dataDir, job.kind, job.template);
  // a repository is source material like a document: wherever raw/docs is readable, so is raw/codebase (docs/design/25)
  const declaredDirs = research?.readDirs ?? ['raw/docs', 'raw/codebase', 'wiki', '.sidecar'];
  const readDirs = (declaredDirs.includes('raw/docs') && !declaredDirs.includes('raw/codebase') ? [...declaredDirs, 'raw/codebase'] : declaredDirs)
    .map((d) => safePath(ctx.dataDir, d))
    .filter((d) => fs.existsSync(d));

  // `agentErrors`: what the agent said, when it is the agent that failed (a pause may follow)
  const fail = (error: string, retry: boolean, agentErrors: (string | null | undefined)[] = []) => failRun(ctx, job, { error, retry, agent, agentErrors, log });

  const profile = opts.profile ?? (isStudyJob(job) ? studyProfile(ctx, job) : activeProfile(ctx.dataDir, ctx.config));
  const webGate = ctx.config.review?.external ?? 'verify';
  const webSearch = webSearchEnabled(research?.web);
  const allowNetwork = webAllowed({ gate: webGate, kind: job.kind, profile, agent, search: webSearch });
  // a study's report reads the pages it links: one session is enough, and quicker than a team
  const pipeline = job.kind === 'study' ? 'single' : effectivePipeline(profile, ctx.config);
  const extraMcp = isStudyJob(job) ? studyMcpServers(ctx, job) : [];

  // a study's first stage gathers material and queues its pages; only its report is a page of its own
  if (job.kind === 'study' && studyPayload(job).stage !== 'report') {
    try {
      return await runStudyCollect(ctx, job, { mcp: opts.mcp, agent, profile, readDirs, log, sessions: opts.sessions });
    } catch (err) {
      if (err instanceof JobCancelledError) return markCancelled(ctx, job.id, log);
      if (err instanceof JobInterruptedError) return markInterrupted(ctx, job.id, log);
      // collect saved its steps as it went: fail on top of them, not on the payload it started from
      job = (await getJob(ctx.store, job.id)) ?? job;
      return fail(`study: ${err instanceof Error ? err.message : err}`, false, err instanceof AgentUnavailableError ? [err.failure.message] : []);
    }
  }

  // an initialization first brings the base up to date and surveys it; the survey replaces the resolve seed in the brief
  let seed: string | undefined;
  if (job.kind === 'init') {
    try {
      const prep = await prepareInit(ctx, job, { log });
      job = prep.job;
      seed = renderSurvey(prep.survey);
    } catch (err) {
      return fail(`init: ${err instanceof Error ? err.message : err}`, false);
    }
  }

  let ws;
  try {
    ws = await prepareRunWorkspace(ctx, job, template, {
      runsDir: research?.runsDir ?? '.runs', provider: agent.provider, mcp: opts.mcp, readDirs, allowNetwork, profile,
      seed, guide: job.kind === 'init' ? null : undefined,
      extraBrief: isStudyJob(job) ? await studyBriefLines(ctx, job, { allowNetwork }) : undefined,
      extraMcp,
    });
    job = (await updateJob(ctx.store, job.id, {
      worksetId: ws.worksetId,
      outputPath: ws.outputPath,
      payload: { ...job.payload, actor: ws.actor, research: ws.research, humanParagraphs: ws.humanParagraphs, profile: profile.name, pipeline, companions: ws.companions.map((c) => c.path) },
    }))!;
  } catch (err) {
    return fail(`workspace: ${err instanceof Error ? err.message : err}`, false);
  }

  log(`research ${job.id}: ${agent.provider} → ${ws.outputPath} (${job.kind} ${job.target ?? job.query ?? ''}; ${pipeline} pipeline, profile ${profile.name})`);
  let launched: LaunchResult;
  try {
    if (pipeline === 'team' || pipeline === 'native') {
      const pipelineInput = { job, template, ws, agent, mcp: opts.mcp, readDirs, profile, webGate, webSearch, extraMcp, log, sessions: opts.sessions, agentFor: (spec: string, model: string) => agentForSpec(ctx.config, spec, model, ctx.dataDir) };
      const team = pipeline === 'team' ? await runTeamPipeline(ctx, pipelineInput) : await runNativePipeline(ctx, pipelineInput);
      launched = team;
      const topics = job.kind === 'init' ? topicsFrom(team.planText || team.resultText) : undefined;
      job = (await updateJob(ctx.store, job.id, { payload: { ...job.payload, phases: team.phases, sections: team.sections, reviewRounds: team.reviewRounds, ...(topics ? { topics } : {}) } }))!;
    } else {
      launched = await launchAgent({
        agent,
        maxTurns: template.maxTurns ?? research?.maxTurns ?? 40,
        timeoutMs: research?.timeoutMs ?? 1_200_000,
        ws,
        mcp: opts.mcp,
        readDirs,
        jobId: job.id,
        allowNetwork,
        effort: profile.reasoning.effort,
        speed: profile.reasoning.speed,
        webFreshness: profile.search.freshness,
        extraMcp,
        sessions: opts.sessions,
      });
      // where the single session ran, when a remote worker ran it
      if (launched.worker) job = (await updateJob(ctx.store, job.id, { payload: { ...job.payload, worker: launched.worker } }))!;
      if (job.kind === 'init') job = (await updateJob(ctx.store, job.id, { payload: { ...job.payload, topics: topicsFrom(launched.resultText) } }))!;
    }
  } catch (err) {
    if (err instanceof JobCancelledError) return markCancelled(ctx, job.id, log);
    if (err instanceof JobInterruptedError) return markInterrupted(ctx, job.id, log);
    // what failed to start the agent ("claude CLI not found", a spawn error) is the agent's failure
    const message = err instanceof Error ? err.message : String(err);
    return fail(`launch: ${message}`, false, [message]);
  }
  const done = await finalizeResearchJob(ctx, job, ws, launched, { ...opts, agent, template, profile });
  clearCancelled(job.id);
  if (done.kind === 'study') await markStudyReport(ctx, done).catch(() => {});
  return (await getJob(ctx.store, done.id)) ?? done;
}

/**
 * Validate what the agent wrote and, if it passes, make it a source: the
 * second half of a run, also used by `research reclaim` for jobs a person ran
 * by hand from an exported workspace.
 */
export async function finalizeResearchJob(
  ctx: AppContext,
  jobIn: ResearchJob,
  ws: RunWorkspace,
  launched: LaunchResult,
  opts: RunOptions & { agent: ResearchAgent; template?: ResearchTemplate },
): Promise<ResearchJob> {
  const log = opts.log ?? (() => {});
  const research = ctx.config.research;
  const template = opts.template ?? templateFor(ctx.dataDir, jobIn.kind, jobIn.template);
  const profile = opts.profile ?? activeProfile(ctx.dataDir, ctx.config);
  let job = jobIn;
  const fail = (error: string, retry: boolean, agentErrors: (string | null | undefined)[] = []) => failRun(ctx, job, { error, retry, agent: opts.agent, agentErrors, log });
  // the sessions' own errors: a team's phases each, else the one session's (a team's summary error
  // quotes its critics, who may write about rate limits; it is no word from the agent)
  const phases = (launched as { phases?: PhaseRecord[] }).phases;
  const agentErrors = phases ? phases.map((ph) => ph.error) : [launched.error];

  if (await wasCancelled(ctx, job.id)) return markCancelled(ctx, job.id, log);
  const usage = { turns: launched.turns, costUsd: launched.costUsd };
  job = (await updateJob(ctx.store, job.id, { status: 'validating', ...usage }))!;
  if (fs.existsSync(ws.dir)) fs.writeFileSync(path.join(ws.dir, 'result.json'), JSON.stringify({ ...launched, usage }, null, 2) + '\n');

  const report = await validateResearchPage(ctx, { job, template, ws, profile });
  const companions = validateCompanions(ctx, ws);
  report.errors.push(...companions.errors);
  report.warnings.push(...companions.warnings);
  report.ok = report.errors.length === 0;
  if (job.kind === 'verify' && !agentWebCapable(opts.agent, webSearchEnabled(research?.web))) {
    report.warnings.push('the built-in agent has no web tool — this verification checked the knowledge base only, not external sources');
  }
  if (fs.existsSync(ws.dir)) fs.writeFileSync(path.join(ws.dir, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
  if (!report.ok) {
    const abs = safePath(ctx.dataDir, ws.outputPath);
    if (fs.existsSync(abs) && fs.existsSync(ws.dir)) {
      // keep the rejected draft for inspection; the wiki never sees it
      fs.renameSync(abs, path.join(ws.dir, 'rejected.md'));
    } else if (fs.existsSync(abs)) {
      fs.rmSync(abs);
    }
    // the page that was there before the agent overwrote it comes back
    const backup = path.join(ws.dir, 'existing.md');
    if (fs.existsSync(backup)) fs.copyFileSync(backup, abs);
    // companion files likewise: the previous version returns, a first draft is kept for inspection only
    for (const c of ws.companions ?? []) {
      const absC = safePath(ctx.dataDir, c.path);
      if (fs.existsSync(absC) && fs.existsSync(ws.dir)) fs.renameSync(absC, path.join(ws.dir, `rejected-${path.posix.basename(c.path)}`));
      else if (fs.existsSync(absC)) fs.rmSync(absC);
      if (c.backupPath && fs.existsSync(c.backupPath)) fs.copyFileSync(c.backupPath, absC);
    }
    const reason = [launched.error, ...report.errors].filter(Boolean).join('; ');
    return fail(reason || 'validation failed', true, agentErrors);
  }

  if (await wasCancelled(ctx, job.id)) return markCancelled(ctx, job.id, log);
  try {
    const stats = await sync(ctx, { only: [ws.outputPath], actor: 'research', onProgress: log });
    log(`research ${job.id}: synced ${ws.outputPath} (${stats.indexed} applied)`);
  } catch (err) {
    return fail(`sync: ${err instanceof Error ? err.message : err}`, false);
  }
  await closeWorkset(ctx.store, ws.worksetId);
  try {
    await applyIdentityVerdicts(ctx, ws, report.frontmatter, log);
  } catch (err) {
    log(`research ${job.id}: identity verdicts failed: ${err instanceof Error ? err.message : err}`);
  }
  try {
    await ensureRecentResearch(ctx, { actor: 'research' });
  } catch (err) {
    log(`research index region failed: ${err instanceof Error ? err.message : err}`);
  }
  // a cancel that landed while the page was being validated and synced still wins:
  // the page stays, but nothing is logged as done and no follow-up work is queued
  if (await wasCancelled(ctx, job.id)) return markCancelled(ctx, job.id, log);
  let initPayload: Record<string, unknown> = {};
  if (job.kind === 'init') {
    try {
      const fresh = (await getJob(ctx.store, job.id)) ?? job;
      const r = await finalizeInit(ctx, fresh, ws, { agent: opts.agent.provider, log });
      initPayload = { topics: r.topics, followUps: r.queued };
      log(`init ${job.id}: guide written, ${r.queued.length} follow-up page(s) queued`);
      appendLog(ctx.dataDir, 'init', `overview → ${ws.outputPath}, guide → AGENTS.md / CLAUDE.md, ${r.queued.length} follow-up job(s) queued (${opts.agent.provider})`);
    } catch (err) {
      log(`init ${job.id}: finalize failed: ${err instanceof Error ? err.message : err}`);
      report.warnings.push(`finalize: ${err instanceof Error ? err.message : err}`);
    }
  } else {
    appendLog(ctx.dataDir, 'research', `${job.kind} ${job.target ?? job.query ?? ''} → ${ws.outputPath} (${opts.agent.provider}${usage.turns ? `, ${usage.turns} turns` : ''}${report.warnings.length ? `, ${report.warnings.length} warnings` : ''})`);
  }
  const finished = withoutPause(job.payload);
  delete finished.interruptions;
  const done = (await updateJob(ctx.store, job.id, {
    status: 'done',
    error: launched.error,
    finishedAt: new Date().toISOString(),
    payload: { ...finished, ...initPayload, warnings: report.warnings, resultText: launched.resultText.slice(0, 2000) },
  }))!;
  try {
    pruneRuns(ctx.dataDir, research?.runsDir ?? '.runs', research?.keepRuns ?? 20);
  } catch {
    /* housekeeping only */
  }
  return (await getJob(ctx.store, done.id)) ?? done;
}

/** review.external (and the active profile) decide which jobs may use the agent's web tools. */
export function networkAllowed(config: KnodeConfig, kind: string, profile?: ResearchProfile): boolean {
  const gate = config.review?.external ?? 'verify';
  if (!profile) {
    if (gate === 'research') return true;
    if (gate === 'verify') return kind === 'verify';
    return false;
  }
  return webAllowed({ gate, kind, profile });
}

/**
 * A page's identity verdicts (`sameAs` / `notSameAs` in its frontmatter, as a
 * verify job writes them) become merge suggestions or remembered rejections —
 * decisions for a person, never silent graph edits.
 */
export async function applyIdentityVerdicts(ctx: AppContext, ws: RunWorkspace, fm: Record<string, unknown>, log: (m: string) => void): Promise<void> {
  const names = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).map((x) => wikilinkName(x)).filter(Boolean);
  const same = names(fm.sameAs ?? fm.same_as);
  const different = names(fm.notSameAs ?? fm.not_same_as);
  if (same.length === 0 && different.length === 0) return;
  const title = typeof fm.title === 'string' ? fm.title.replace(/^核实[:：]\s*/, '') : '';
  const subjectName = typeof fm.subject === 'string' ? fm.subject : title;
  if (!subjectName) return;
  const lite = async (name: string) => {
    const r = await resolveEntityId(ctx.store, { name }, undefined, { mode: 'suffix', corrections: readEntityCorrections(ctx.dataDir) });
    const [row] = await ctx.store.query<{ id: string; name: string; type: string; mention_count: number; evidence_count: number }>(
      `SELECT id, name, type, mention_count, evidence_count FROM entities WHERE id = $1 AND tx_to IS NULL`, [r.id],
    );
    return row ?? null;
  };
  const self = await lite(subjectName);
  if (!self) return;
  for (const other of same) {
    const target = await lite(other);
    if (!target || target.id === self.id) continue;
    await fileMergeCandidate(ctx.store, self, target, `核实页判定为同一实体`, { evidencePath: ws.outputPath, actor: ws.actor });
    log(`research: merge candidate filed from ${ws.outputPath}: ${self.name} ↔ ${target.name}`);
  }
  for (const other of different) {
    const target = await lite(other);
    if (!target || target.id === self.id) continue;
    await fileMergeCandidate(ctx.store, self, target, `核实页判定为不同实体`, { evidencePath: ws.outputPath, decision: 'rejected', actor: ws.actor });
  }
}

/** Rebuild the workspace record of a prepared job from what the runner persisted on it (for reclaim). */
export function workspaceFromJob(ctx: AppContext, job: ResearchJob, agent: ResearchAgent): RunWorkspace {
  if (!job.outputPath || !job.worksetId) throw new Error(`job ${job.id} has no prepared workspace to reclaim`);
  const research = (job.payload.research as Record<string, unknown> | undefined) ?? { job: job.id, kind: job.kind, template: job.template, agent: agent.provider, workset: job.worksetId };
  const dir = path.join(runsRoot(ctx.dataDir, ctx.config.research?.runsDir ?? '.runs'), job.id);
  return {
    dir,
    briefPath: path.join(dir, 'brief.md'),
    outputPath: job.outputPath,
    actor: typeof job.payload.actor === 'string' ? job.payload.actor : `agent/${agent.provider}`,
    research,
    worksetId: job.worksetId,
    existingPage: null,
    humanParagraphs: Array.isArray(job.payload.humanParagraphs) ? (job.payload.humanParagraphs as string[]) : [],
    companions: [],
  };
}
