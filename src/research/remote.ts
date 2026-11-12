import fs from 'node:fs';
import path from 'node:path';
import { KnodeConfig } from '../config.js';
import type { BackgroundHold } from '../labeling/background-floor.js';
import type { QuotaHold } from '../labeling/plan-quota.js';
import { SessionAnswer } from '../labeling/scheduler.js';
import { effortFor, speedFor } from '../llm/cli.js';
import { SessionFailure, SessionFamily, SessionSource, SessionSpec } from '../work/session.js';
import { CliAgent, ResearchAgent } from './agent.js';
import { classifyFailure } from './failure.js';
import {
  isCancelled, JobCancelledError, JobInterruptedError, registerSession,
  SessionDispatch, SessionInput, SessionResult, sessionResultFrom, stderrPathFor, transcriptPathFor,
} from './launch.js';

/**
 * Where a research session runs (docs/design/27): on a remote worker that
 * runs its CLI on its own account, or here, as before.
 *
 * With `server.remote.offer.session` on, a session that may leave (a Codex or
 * Claude CLI session with no sub-agents and no study MCP sources, D8) goes to
 * a remote slot that takes its CLI and asked in the last two minutes; it
 * waits up to `server.remote.sessionOfferSeconds` for one, then runs here
 * (D3). It does not run here while this machine's plan is under the floor or
 * `research.localSessions` is reached: then it keeps waiting for a worker up
 * to `server.remote.sessionWaitMinutes`, and ends as a failure the runner
 * reads as design 22 says — a quota hold for the floor, a transient pause
 * otherwise (D4, D5). Three worker failures in a row and it stops waiting for
 * workers if it may run here (D11).
 *
 * A remote session reads no files: its brief says so and points to knode's
 * read tools (D7). Its answer is the CLI's raw output, read with the same
 * code a session run here uses (`sessionResultFrom`, D10).
 */

const POLL_MS = 1_000;
/** Worker failures in a row after which a session stops waiting for workers, if it may run here. */
const WORKER_STRIKES = 3;

const FAMILY: Partial<Record<CliAgent['provider'], SessionFamily>> = { 'codex-cli': 'codex', 'claude-cli': 'claude' };

/** The CLI family a remote worker would run this agent's sessions on, or null when they stay here. */
export function sessionFamily(agent: ResearchAgent): SessionFamily | null {
  return agent.kind === 'cli' ? FAMILY[agent.provider] ?? null : null;
}

/** Whether a session may leave this machine at all (D8): a Codex or Claude CLI, no sub-agents, no study MCP sources. */
export function remotable(input: Pick<SessionInput, 'agent' | 'agents' | 'extraMcp'>): SessionFamily | null {
  if (input.agents?.length || input.extraMcp?.length) return null;
  return sessionFamily(input.agent);
}

const READ_DIRS_LINE = /^- 只读资料目录：.*$/m;
const REMOTE_READ_LINE = '- 只读资料目录：无（本会话在另一台机器上运行：读取知识库一律用 knode_ls / knode_read / knode_grep）';
const REMOTE_NOTE = '（本会话在另一台机器上运行，没有本地资料目录：读取知识库一律用 knode_ls / knode_read / knode_grep。This session runs on another machine with no local data folders: read the knowledge base through knode_ls / knode_read / knode_grep.）';

/** The brief as a remote session gets it: no local folders to read (D7). */
export function remotePrompt(prompt: string): string {
  return READ_DIRS_LINE.test(prompt) ? prompt.replace(READ_DIRS_LINE, REMOTE_READ_LINE) : `${prompt.trimEnd()}\n\n${REMOTE_NOTE}\n`;
}

/** The schema file a run folder holds (AGENTS.md, as codex reads it; CLAUDE.md is the same text). */
function schemaOf(cwd: string): string {
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    try {
      return fs.readFileSync(path.join(cwd, name), 'utf8');
    } catch {
      // the other one
    }
  }
  return '';
}

/** What a worker runs, from a session as `launchSession` got it. */
export function sessionSpec(input: SessionInput, family: SessionFamily, title: string): SessionSpec {
  const provider = input.agent.provider;
  return {
    job: input.jobId,
    label: input.label,
    title,
    family,
    model: input.agent.model ?? '',
    effort: effortFor(provider, input.effort),
    speed: speedFor(provider, input.speed),
    maxTurns: input.maxTurns,
    timeoutMs: input.timeoutMs,
    tools: input.tools,
    web: Boolean(input.allowNetwork),
    webFreshness: input.allowNetwork ? input.webFreshness ?? 'live' : null,
    schema: schemaOf(input.cwd),
    prompt: remotePrompt(input.prompt),
  };
}

/**
 * Whether a worker's answer says the worker could not serve the session — its
 * account's limit, a lost login, a missing CLI — rather than the agent
 * running and failing at the work: then the session goes back in line, and
 * that backend rests (D11).
 */
export function classifySessionAnswer(spec: SessionSpec, answer: SessionAnswer, transcript: string): SessionFailure | null {
  const provider = spec.family === 'codex' ? 'codex-cli' : 'claude-cli';
  const result = sessionResultFrom(provider, { code: answer.exitCode, stdout: transcript, stderr: answer.stderr }, answer.lastMessage, '');
  if (result.text.trim() || !result.error) return null;
  const failure = classifyFailure(result.error);
  if (failure.kind === 'other') return null;
  return { kind: failure.kind === 'transient' ? 'transient' : 'fatal', message: result.error };
}

export interface RemoteSessionsOptions {
  source: SessionSource;
  config: () => KnodeConfig;
  /** The quota floor over this machine's plans (src/labeling/background-floor.ts). */
  hold?: BackgroundHold;
  log?: (msg: string) => void;
}

type HereVerdict = { ok: true } | { ok: false; reason: string; floor: QuotaHold | null };

export class RemoteSessions implements SessionDispatch {
  /** Research sessions running here now, this workspace's (for `research.localSessions`). */
  private local = 0;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: RemoteSessionsOptions) {
    this.log = opts.log ?? (() => {});
  }

  private offered(): boolean {
    return this.opts.config().server.remote?.offer?.session === true;
  }

  covers(agent: ResearchAgent): boolean {
    const family = sessionFamily(agent);
    return Boolean(family && this.offered() && this.opts.source.online(family));
  }

  /** Sessions running here now (Tasks). */
  get runningHere(): number {
    return this.local;
  }

  async run(input: SessionInput, here: () => Promise<SessionResult>): Promise<SessionResult> {
    if (!this.offered()) return this.runHere(here);
    const family = remotable(input);
    if (!family) {
      // the claim left the floor to the session when a worker was online (D4): a session that may not
      // leave checks it here, as the claim would have
      const verdict = await this.mayRunHere(input.agent, false);
      return verdict.ok ? this.runHere(here) : this.unplaced(input, verdict, 0);
    }
    const source = this.opts.source;
    if (!source.online(family)) {
      const verdict = await this.mayRunHere(input.agent);
      if (verdict.ok) return this.runHere(here);
    }
    const config = this.opts.config();
    const offerSeconds = Number(config.server.remote?.sessionOfferSeconds ?? 30);
    const waitMinutes = Number(config.server.remote?.sessionWaitMinutes ?? 30);
    const offerMs = (Number.isFinite(offerSeconds) && offerSeconds >= 0 ? offerSeconds : 30) * 1000;
    const waitMs = (Number.isFinite(waitMinutes) && waitMinutes > 0 ? waitMinutes : 30) * 60_000;
    const transcriptPath = transcriptPathFor(input.cwd, input.label);
    const offer = source.offer(
      sessionSpec(input, family, titleOf(input)),
      { writePaths: input.tools === 'write' ? [input.outputPath, ...(input.companions ?? [])].filter(Boolean) : [], workset: input.worksetId },
      { transcriptPath, stderrPath: stderrPathFor(input.cwd, input.label) },
    );
    // cancelling the job (or stopping serve) stops the offer wherever it is
    const unregister = registerSession(input.jobId, { stop: () => (offer.cancel(), true) });
    const started = Date.now();
    let last: HereVerdict | null = null;
    try {
      for (;;) {
        const settled = await Promise.race([offer.result, sleep(POLL_MS).then(() => null)]);
        if (settled) {
          if (settled.kind === 'answered') {
            const stdout = readText(transcriptPath);
            const result = sessionResultFrom(family === 'codex' ? 'codex-cli' : 'claude-cli', { code: settled.answer.exitCode, stdout, stderr: settled.answer.stderr }, settled.answer.lastMessage, transcriptPath);
            return { ...result, worker: settled.worker };
          }
          if (settled.kind === 'withdrawn') {
            // only this loop withdraws, and returns as it does; a stray one runs here
            return this.runHere(here);
          }
          if (isCancelled(input.jobId)) throw new JobCancelledError(input.jobId);
          throw new JobInterruptedError(input.jobId);
        }
        if (offer.leased) continue;
        const elapsed = Date.now() - started;
        const due = !source.online(family) || elapsed >= offerMs || offer.strikes >= WORKER_STRIKES;
        if (!due) continue;
        last = await this.mayRunHere(input.agent);
        if (last.ok) {
          if (offer.withdraw()) return this.runHere(here);
          continue;
        }
        if (elapsed >= waitMs && offer.withdraw()) return this.unplaced(input, last, waitMs, offer.lastError);
      }
    } finally {
      unregister();
      // nothing is left offered once this returns, whatever ended it
      offer.cancel();
    }
  }

  private async runHere(here: () => Promise<SessionResult>): Promise<SessionResult> {
    this.local++;
    try {
      return await here();
    } finally {
      this.local--;
    }
  }

  /** Whether this machine may run the session now: within `research.localSessions`, and its plan over the floor. */
  private async mayRunHere(agent: ResearchAgent, countLocal = true): Promise<HereVerdict> {
    const max = this.opts.config().research?.localSessions;
    if (countLocal && typeof max === 'number' && max >= 0 && this.local >= max) {
      return { ok: false, reason: max === 0 ? 'this machine runs no research sessions (research.localSessions: 0)' : `${this.local} research session(s) already run here (research.localSessions: ${max})`, floor: null };
    }
    if (agent.kind === 'cli' && this.opts.hold) {
      const held = await this.opts.hold({ provider: agent.provider, cliPath: agent.cliPath }).catch(() => null);
      if (held) return { ok: false, reason: held.reason, floor: held };
    }
    return { ok: true };
  }

  /**
   * A session that could run nowhere (D5): a failure the runner reads as
   * design 22 says — a spent usage limit for the floor, so the job waits for
   * the reset with its account's queue; a service that is temporarily
   * unavailable otherwise, a short pause.
   */
  private unplaced(input: SessionInput, verdict: Extract<HereVerdict, { ok: false }>, waitedMs: number, lastError = ''): SessionResult {
    const waited = waitedMs ? `no remote worker took the session in ${waitedMs >= 60_000 ? `${Math.round(waitedMs / 60_000)} min` : `${Math.round(waitedMs / 1000)} s`}, and ` : '';
    const error = verdict.floor
      ? `usage limit: ${waited}this machine's plan is under the floor (${verdict.reason}; processing.minQuotaPercent)${verdict.floor.until ? ` — resets ${verdict.floor.until}` : ''}`
      : `${waited}${verdict.reason} — temporarily unavailable${lastError ? ` (last worker error: ${lastError.slice(0, 200)})` : ''}`;
    this.log(`research ${input.jobId}: ${input.label} could run nowhere: ${error}`);
    return { text: '', turns: null, costUsd: null, error, exitCode: -1, transcriptPath: transcriptPathFor(input.cwd, input.label) };
  }
}

function titleOf(input: SessionInput): string {
  return input.outputPath ? path.posix.basename(input.outputPath, '.md') : input.label;
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
