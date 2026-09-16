import fs from 'node:fs';
import path from 'node:path';
import { KnodeConfig } from '../config.js';
import { closeWorkset } from '../compiler/workset.js';
import { AppContext } from '../context.js';
import { appendLog } from '../fs/datadir.js';
import { safePath } from '../fs/files.js';
import { sync } from '../ingest/sync.js';
import { agentForSpec, ResearchAgent, resolveResearchAgent } from './agent.js';
import { launchAgent, LaunchResult } from './launch.js';
import { runNativePipeline, runTeamPipeline } from './pipeline.js';
import { getJob, ResearchJob, updateJob } from './jobs.js';
import { activeProfile, effectivePipeline, ResearchProfile, webAllowed } from './profile.js';
import { ResearchTemplate, templateFor } from './templates.js';
import { validateResearchPage } from './validate.js';
import { McpEndpoint, prepareRunWorkspace, pruneRuns, runsRoot, RunWorkspace } from './workspace.js';
import { ensureRecentResearch } from '../wiki/pages.js';
import { fileMergeCandidate } from '../graph/dedupe.js';
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
  log?: (msg: string) => void;
  /** Override the agent (tests point it at a fake CLI). */
  agent?: ResearchAgent;
  /** Override the profile (tests); default = research.profile. */
  profile?: ResearchProfile;
}

const MAX_ATTEMPTS = 2;

export async function runResearchJob(ctx: AppContext, jobIn: ResearchJob, opts: RunOptions): Promise<ResearchJob> {
  const log = opts.log ?? (() => {});
  const research = ctx.config.research;
  const agent = opts.agent ?? resolveResearchAgent(ctx.config);
  if (!agent) throw new Error('no research agent configured: set research.agent to claude-cli / codex-cli / cursor-cli (or a connection id)');
  let job = (await updateJob(ctx.store, jobIn.id, {
    status: 'running',
    agent: agent.provider,
    model: agent.model || null,
    startedAt: jobIn.startedAt ?? new Date().toISOString(),
    attempts: jobIn.status === 'running' ? jobIn.attempts : jobIn.attempts + 1,
  }))!;
  const template = templateFor(ctx.dataDir, job.kind, job.template);
  const readDirs = (research?.readDirs ?? ['raw/docs', 'wiki', '.sidecar'])
    .map((d) => safePath(ctx.dataDir, d))
    .filter((d) => fs.existsSync(d));

  const fail = async (error: string, retry: boolean): Promise<ResearchJob> => {
    const rejections = [...(Array.isArray(job.payload.rejections) ? (job.payload.rejections as string[]) : []), error];
    if (retry && job.attempts < MAX_ATTEMPTS) {
      log(`research ${job.id}: rejected (${error.slice(0, 160)}) — requeued for one more attempt`);
      return (await updateJob(ctx.store, job.id, { status: 'queued', error, payload: { ...job.payload, rejections } }))!;
    }
    log(`research ${job.id}: failed — ${error.slice(0, 200)}`);
    return (await updateJob(ctx.store, job.id, { status: 'failed', error, finishedAt: new Date().toISOString(), payload: { ...job.payload, rejections } }))!;
  };

  const profile = opts.profile ?? activeProfile(ctx.dataDir, ctx.config);
  const webGate = ctx.config.review?.external ?? 'verify';
  const allowNetwork = webAllowed({ gate: webGate, kind: job.kind, profile });
  const pipeline = effectivePipeline(profile, ctx.config);
  let ws;
  try {
    ws = await prepareRunWorkspace(ctx, job, template, { runsDir: research?.runsDir ?? '.runs', provider: agent.provider, mcp: opts.mcp, readDirs, allowNetwork, profile });
    job = (await updateJob(ctx.store, job.id, {
      worksetId: ws.worksetId,
      outputPath: ws.outputPath,
      payload: { ...job.payload, actor: ws.actor, research: ws.research, humanParagraphs: ws.humanParagraphs, profile: profile.name, pipeline },
    }))!;
  } catch (err) {
    return fail(`workspace: ${err instanceof Error ? err.message : err}`, false);
  }

  log(`research ${job.id}: ${agent.provider} → ${ws.outputPath} (${job.kind} ${job.target ?? job.query ?? ''}; ${pipeline} pipeline, profile ${profile.name})`);
  let launched: LaunchResult;
  try {
    if (pipeline === 'team' || pipeline === 'native') {
      const pipelineInput = { job, template, ws, agent, mcp: opts.mcp, readDirs, profile, webGate, log, agentFor: (spec: string, model: string) => agentForSpec(ctx.config, spec, model) };
      const team = pipeline === 'team' ? await runTeamPipeline(ctx, pipelineInput) : await runNativePipeline(ctx, pipelineInput);
      launched = team;
      job = (await updateJob(ctx.store, job.id, { payload: { ...job.payload, phases: team.phases, sections: team.sections, reviewRounds: team.reviewRounds } }))!;
    } else {
      launched = await launchAgent({
        provider: agent.provider,
        cliPath: agent.cliPath,
        model: agent.model,
        maxTurns: template.maxTurns ?? research?.maxTurns ?? 40,
        timeoutMs: research?.timeoutMs ?? 1_200_000,
        ws,
        mcp: opts.mcp,
        readDirs,
        jobId: job.id,
        allowNetwork,
        effort: profile.reasoning.effort,
        webFreshness: profile.search.freshness,
      });
    }
  } catch (err) {
    return fail(`launch: ${err instanceof Error ? err.message : err}`, false);
  }
  return finalizeResearchJob(ctx, job, ws, launched, { ...opts, agent, template, profile });
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
  const fail = async (error: string, retry: boolean): Promise<ResearchJob> => {
    const rejections = [...(Array.isArray(job.payload.rejections) ? (job.payload.rejections as string[]) : []), error];
    if (retry && job.attempts < MAX_ATTEMPTS) {
      log(`research ${job.id}: rejected (${error.slice(0, 160)}) — requeued for one more attempt`);
      return (await updateJob(ctx.store, job.id, { status: 'queued', error, payload: { ...job.payload, rejections } }))!;
    }
    log(`research ${job.id}: failed — ${error.slice(0, 200)}`);
    return (await updateJob(ctx.store, job.id, { status: 'failed', error, finishedAt: new Date().toISOString(), payload: { ...job.payload, rejections } }))!;
  };

  const usage = { turns: launched.turns, costUsd: launched.costUsd };
  job = (await updateJob(ctx.store, job.id, { status: 'validating', ...usage }))!;
  if (fs.existsSync(ws.dir)) fs.writeFileSync(path.join(ws.dir, 'result.json'), JSON.stringify({ ...launched, usage }, null, 2) + '\n');

  const report = await validateResearchPage(ctx, { job, template, ws, profile });
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
    const reason = [launched.error, ...report.errors].filter(Boolean).join('; ');
    return fail(reason || 'validation failed', true);
  }

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
  appendLog(ctx.dataDir, 'research', `${job.kind} ${job.target ?? job.query ?? ''} → ${ws.outputPath} (${opts.agent.provider}${usage.turns ? `, ${usage.turns} turns` : ''}${report.warnings.length ? `, ${report.warnings.length} warnings` : ''})`);
  const done = (await updateJob(ctx.store, job.id, {
    status: 'done',
    error: launched.error,
    finishedAt: new Date().toISOString(),
    payload: { ...job.payload, warnings: report.warnings, resultText: launched.resultText.slice(0, 2000) },
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
    const r = await resolveEntityId(ctx.store, { name }, undefined, { mode: 'suffix' });
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
  };
}
