import { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cliCommand, cursorModel, effortFor, readCursorStream, resolveExecutable, runProcess } from '../llm/cli.js';
import { AgentProvider, CliAgent, ResearchAgent } from './agent.js';
import { Effort, Freshness, NativeAgentSpec } from './profile.js';
import { McpEndpoint, RunWorkspace } from './workspace.js';

/**
 * Launch recipes: how each coding-agent CLI is started for a research job.
 * Every recipe follows the same contract — cwd is the run workspace, the
 * brief is the prompt, the knode MCP endpoint is attached, the data dir's
 * read roots are mounted read-only, and the agent has no write or shell tool
 * (pages travel back through `knode_write`). Kept in one place because CLI
 * flags drift between releases; `GET /api/config/cli-tools` reports what is
 * installed.
 *
 * The built-in agent is not a process, so its recipe lives in `deepagents.ts`
 * and is loaded lazily; `launchSession` dispatches on the agent kind. Both
 * kinds honour the same contract, including the transcript and cancellation.
 */

/** The provider vocabulary lives in `agent.ts`; re-exported here for the callers that grew up importing it from the launcher. */
export { AGENT_PROVIDERS, BUILTIN_AGENT } from './agent.js';
export type { AgentProvider, BuiltinAgent, CliAgent, ResearchAgent } from './agent.js';

export interface LaunchInput {
  agent: ResearchAgent;
  maxTurns: number;
  timeoutMs: number;
  ws: RunWorkspace;
  mcp: McpEndpoint;
  /** Absolute directories the agent may read. */
  readDirs: string[];
  jobId: string;
  /** Web tools allowed (review.external): claude keeps WebSearch / WebFetch, codex enables web_search. */
  allowNetwork?: boolean;
  /** Reasoning effort (profile): claude --effort, codex model_reasoning_effort, cursor model[effort=…]. */
  effort?: Effort;
  /** codex web_search freshness when web tools are on. */
  webFreshness?: Freshness;
  /** Native sub-agents for the orchestrator session (pipeline = native). */
  agents?: NativeAgentSpec[];
}

export interface LaunchResult {
  exitCode: number;
  turns: number | null;
  costUsd: number | null;
  /** The agent's final message (informational — the page itself arrives through MCP). */
  resultText: string;
  error: string | null;
  transcriptPath: string;
}

/**
 * A session that can be stopped: a spawned CLI process, or an in-process agent
 * loop behind an AbortController. One registry for both, so `activeSessions`
 * cannot undercount and serve shutdown cannot miss a kind.
 */
export interface RunningSession {
  stop(): boolean;
}

/** Live sessions per job id (a research job id, or `chat:<conversation>`). */
const byJob = new Map<string, Set<RunningSession>>();
/** Jobs whose sessions were killed: nothing more is launched for them until the runner clears the flag. */
const cancelledJobs = new Set<string>();

export class JobCancelledError extends Error {
  constructor(public readonly jobId: string) {
    super(`job ${jobId} was cancelled`);
    this.name = 'JobCancelledError';
  }
}

export function processSession(child: ChildProcess): RunningSession {
  return {
    stop() {
      try {
        child.kill('SIGKILL');
        return true;
      } catch {
        return false; /* already gone */
      }
    },
  };
}

export function abortSession(controller: AbortController): RunningSession {
  return {
    stop() {
      if (controller.signal.aborted) return false; // already stopped; counts once, like a dead process
      controller.abort();
      return true;
    },
  };
}

/** Register a running session so it can be cancelled; the returned function unregisters it. */
export function registerSession(jobId: string, session: RunningSession): () => void {
  let set = byJob.get(jobId);
  if (!set) byJob.set(jobId, (set = new Set()));
  set.add(session);
  return () => {
    const current = byJob.get(jobId);
    current?.delete(session);
    if (current && current.size === 0) byJob.delete(jobId);
  };
}

/** Kill every agent this process launched (serve shutdown). */
export function killActiveAgents(): number {
  let n = 0;
  for (const set of byJob.values()) for (const session of set) if (session.stop()) n++;
  byJob.clear();
  return n;
}

/**
 * Cancel one job: kill its running sessions and refuse to launch more until
 * `clearCancelled`. A killed session resolves like any other exit, so
 * `launchSession` re-checks the flag and throws `JobCancelledError` — the
 * pipeline stops instead of carrying an error into the next phase.
 */
export function killAgentsFor(jobId: string): number {
  cancelledJobs.add(jobId);
  let n = 0;
  const set = byJob.get(jobId);
  if (set) {
    for (const session of set) if (session.stop()) n++;
    byJob.delete(jobId);
  }
  return n;
}

export function clearCancelled(jobId: string): void {
  cancelledJobs.delete(jobId);
}

export function isCancelled(jobId: string): boolean {
  return cancelledJobs.has(jobId);
}

/** Sessions currently running for a job (0 when none). */
export function activeSessions(jobId: string): number {
  return byJob.get(jobId)?.size ?? 0;
}

/** URL-only clients (codex) get the workspace fields in the query string. */
export function mcpUrlWithWorkspace(mcp: McpEndpoint): string {
  const u = new URL(mcp.url);
  const map: Record<string, string> = { 'x-knode-user': 'user', 'x-knode-workspace-kind': 'kind', 'x-knode-workspace-id': 'id', 'x-knode-workspace-name': 'name' };
  for (const [header, param] of Object.entries(map)) {
    const v = mcp.headers[header];
    if (v) u.searchParams.set(param, v);
  }
  return u.toString();
}

/** knode tools a read-only session may call (claude enforces the list; other CLIs are told in the prompt). */
export const READ_TOOLS = [
  'knode_search', 'knode_graph_search', 'knode_ask', 'knode_ls', 'knode_read', 'knode_grep', 'knode_context_pack', 'knode_claims',
  'knode_resolve', 'knode_plan', 'knode_feedback', 'knode_lineage', 'knode_history', 'knode_graph_insights', 'knode_suggestions',
  'knode_absences', 'knode_disputes', 'knode_capabilities', 'knode_datasources', 'knode_query', 'knode_worksets', 'knode_okf_validate',
  'knode_survey',
].map((t) => `mcp__knode-os__${t}`);

export interface SessionInput {
  agent: ResearchAgent;
  maxTurns: number;
  timeoutMs: number;
  /** Run workspace (cwd): holds .mcp.json / .cursor/mcp.json and the schema files. */
  cwd: string;
  prompt: string;
  mcp: McpEndpoint;
  readDirs: string[];
  jobId: string;
  outputPath: string;
  worksetId: string;
  allowNetwork?: boolean;
  /** 'read' = no knode_write / knode_commit / knode_checkout; 'write' = the full tool set. */
  tools: 'read' | 'write';
  /** Read / Grep / Glob over the add-dirs (default true; only claude can actually withhold them). */
  files?: boolean;
  /** Reasoning effort; 'default' / undefined leaves the CLI's own setting alone. */
  effort?: Effort;
  /** codex `web_search` freshness when web tools are on (default live). */
  webFreshness?: Freshness;
  /** Native sub-agents registered with the CLI (claude --agents, codex agents.<id>). */
  agents?: NativeAgentSpec[];
  /** Names the transcript file: transcript.jsonl for 'agent', transcript-<label>.jsonl otherwise. */
  label: string;
}

export interface SessionResult {
  /** The session's final message. */
  text: string;
  turns: number | null;
  costUsd: number | null;
  error: string | null;
  exitCode: number;
  transcriptPath: string;
}

export function sessionEnv(input: { mcp: McpEndpoint; jobId: string; outputPath: string; worksetId: string }): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KNODE_MCP_URL: input.mcp.url,
    KNODE_MCP_URL_WS: mcpUrlWithWorkspace(input.mcp),
    KNODE_MCP_TOKEN: input.mcp.token,
    KNODE_JOB_ID: input.jobId,
    KNODE_OUTPUT_PATH: input.outputPath,
    KNODE_WORKSET: input.worksetId,
    KNODE_WS_USER: input.mcp.headers['x-knode-user'] ?? '',
    KNODE_WS_KIND: input.mcp.headers['x-knode-workspace-kind'] ?? '',
    KNODE_WS_ID: input.mcp.headers['x-knode-workspace-id'] ?? '',
    KNODE_WS_NAME: input.mcp.headers['x-knode-workspace-name'] ?? '',
  };
}

export function agentEnv(input: LaunchInput): NodeJS.ProcessEnv {
  return sessionEnv({ mcp: input.mcp, jobId: input.jobId, outputPath: input.ws.outputPath, worksetId: input.ws.worksetId });
}

/* ------------------------------------------------------------------ adapters */

// Both adapters live with the CLI runners, so a one-shot completion and a
// research session ask for the same level in the same way.
export { cursorModel, effortFor };

function agentToolNames(a: NativeAgentSpec): string[] {
  return [
    ...(a.write ? ['mcp__knode-os__*'] : READ_TOOLS),
    ...(a.files ? ['Read', 'Grep', 'Glob'] : []),
    ...(a.web ? ['WebSearch', 'WebFetch'] : []),
  ];
}

/** The `--agents` JSON claude takes: one definition per native role. */
export function claudeAgentsJson(agents: NativeAgentSpec[]): string {
  const out: Record<string, { description: string; prompt: string; tools: string[]; model?: string }> = {};
  for (const a of agents) {
    out[a.id] = { description: a.description || a.title || a.id, prompt: a.prompt, tools: agentToolNames(a), ...(a.model ? { model: a.model } : {}) };
  }
  return JSON.stringify(out);
}

function tomlString(v: string): string {
  return JSON.stringify(v);
}

const TOML_LITERAL_FENCE = "'''";

/** One TOML config layer per native role (`agents.<id>.config_file`); the role prompt rides as developer_instructions. */
export function codexAgentLayer(a: NativeAgentSpec, freshness: Freshness | undefined): string {
  const lines = [`# knode-os research role: ${a.title || a.id}`];
  if (a.model) lines.push(`model = ${tomlString(a.model)}`);
  const effort = effortFor('codex-cli', a.effort);
  if (effort) lines.push(`model_reasoning_effort = ${tomlString(effort)}`);
  lines.push(`web_search = ${tomlString(a.web ? freshness ?? 'live' : 'disabled')}`);
  const prompt = a.prompt.split(TOML_LITERAL_FENCE).join("'' '");
  lines.push(`developer_instructions = ${TOML_LITERAL_FENCE}\n${prompt}\n${TOML_LITERAL_FENCE}`);
  return lines.join('\n') + '\n';
}

export function codexAgentLayerPath(cwd: string, id: string): string {
  return path.join(cwd, 'agents', `${id}.toml`);
}

/** Materialize the codex agent layers a session's argv points at. */
export function writeCodexAgentLayers(cwd: string, agents: NativeAgentSpec[], freshness: Freshness | undefined): string[] {
  const written: string[] = [];
  for (const a of agents) {
    const file = codexAgentLayerPath(cwd, a.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, codexAgentLayer(a, freshness));
    written.push(file);
  }
  return written;
}

/** A session that is going to be spawned as a process — the only kind `sessionArgs` can describe. */
export type CliSessionInput = Omit<SessionInput, 'agent'> & { agent: CliAgent };

/** The argv a session is launched with (exported so tests and `research export` can print it). */
export function sessionArgs(input: CliSessionInput): { cmd: string; args: string[]; stdin: string; outFile?: string } {
  const { provider, cliPath, model } = input.agent;
  const cmd = cliCommand(provider, cliPath);
  const files = input.files !== false;
  const web = Boolean(input.allowNetwork);
  const agents = input.agents?.length ? input.agents : null;
  const effort = effortFor(provider, input.effort);
  if (provider === 'claude-cli') {
    const allowed = [
      ...(input.tools === 'write' ? ['mcp__knode-os__*'] : READ_TOOLS),
      ...(files ? ['Read', 'Grep', 'Glob'] : []),
      ...(web ? ['WebSearch', 'WebFetch'] : []),
      ...(agents ? ['Agent', 'Task'] : []),
    ];
    const disallowed = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', ...(files ? [] : ['Read', 'Grep', 'Glob']), ...(web ? [] : ['WebFetch', 'WebSearch'])];
    return {
      cmd,
      args: [
        '-p', '--output-format', 'stream-json', '--verbose',
        '--max-turns', String(input.maxTurns),
        '--mcp-config', '.mcp.json', '--strict-mcp-config',
        '--allowedTools', ...allowed,
        '--disallowedTools', ...disallowed,
        '--permission-mode', 'dontAsk', '--no-session-persistence',
        ...(effort ? ['--effort', effort] : []),
        ...(agents ? ['--agents', claudeAgentsJson(agents)] : []),
        ...input.readDirs.flatMap((d) => ['--add-dir', d]),
        ...(model ? ['--model', model] : []),
      ],
      stdin: input.prompt,
    };
  }
  if (provider === 'codex-cli') {
    const outFile = path.join(input.cwd, `result-${input.label}.txt`);
    const agentArgs = agents
      ? [
        '-c', 'agents.enabled=true',
        '-c', `agents.max_concurrent_threads_per_session=${Math.max(1, Math.min(16, agents.length * 2))}`,
        ...(effort ? ['-c', `agents.default_subagent_reasoning_effort=${tomlString(effort)}`] : []),
        ...agents.flatMap((a) => [
          '-c', `agents.${a.id}.description=${tomlString(a.description || a.title || a.id)}`,
          '-c', `agents.${a.id}.config_file=${tomlString(codexAgentLayerPath(input.cwd, a.id))}`,
        ]),
      ]
      : [];
    return {
      cmd,
      args: [
        'exec', '-', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', input.cwd,
        '-c', `mcp_servers.knode-os.url=${JSON.stringify(mcpUrlWithWorkspace(input.mcp))}`,
        '-c', 'mcp_servers.knode-os.bearer_token_env_var="KNODE_MCP_TOKEN"',
        '-c', `web_search=${tomlString(web ? input.webFreshness ?? 'live' : 'disabled')}`,
        ...(effort ? ['-c', `model_reasoning_effort=${tomlString(effort)}`] : []),
        ...agentArgs,
        '--output-last-message', outFile,
        ...(model ? ['-m', model] : []),
      ],
      stdin: input.prompt,
      outFile,
    };
  }
  if (provider === 'cursor-cli') {
    const withEffort = cursorModel(model, input.effort);
    return {
      cmd,
      args: [
        '-p', '--output-format', 'stream-json', '--trust', '--approve-mcps',
        '--workspace', input.cwd,
        ...input.readDirs.flatMap((d) => ['--add-dir', d]),
        ...(withEffort ? ['--model', withEffort] : []),
        input.prompt,
      ],
      stdin: '',
    };
  }
  // every CLI is spelled out above, so a new one is a compile error rather than a cursor session
  throw new Error(`no launch recipe for ${String(provider satisfies never)}`);
}

/** Transcript and stderr paths for a session — shared so the executors and the chat poller cannot drift. */
export function transcriptPathFor(cwd: string, label: string): string {
  return path.join(cwd, label === 'agent' ? 'transcript.jsonl' : `transcript-${label}.jsonl`);
}

export function stderrPathFor(cwd: string, label: string): string {
  return path.join(cwd, label === 'agent' ? 'stderr.log' : `stderr-${label}.log`);
}

/**
 * One session: prompt in, final message out, transcript on disk. Dispatches on
 * the agent kind — a CLI is spawned as a process, the built-in agent runs an
 * agent loop in this process.
 */
export async function launchSession(input: SessionInput): Promise<SessionResult> {
  if (cancelledJobs.has(input.jobId)) throw new JobCancelledError(input.jobId);
  if (input.agent.kind === 'builtin') {
    const { runBuiltinSession } = await loadBuiltin();
    return runBuiltinSession({ ...input, agent: input.agent });
  }
  return launchCliSession({ ...input, agent: input.agent });
}

/**
 * The LangChain stack is loaded only when a built-in session actually runs, so
 * a CLI-only install never pays for it at startup. It is a regular dependency,
 * so a failure here means a pruned or broken install — say which module and
 * what to do, rather than surfacing a bare module specifier.
 */
async function loadBuiltin(): Promise<typeof import('./deepagents.js')> {
  try {
    return await import('./deepagents.js');
  } catch (err) {
    const missing = /Cannot find (?:package|module) '([^']+)'/.exec(err instanceof Error ? err.message : '')?.[1];
    throw new Error(
      `the built-in research agent is unavailable${missing ? ` — ${missing} is not installed` : ''}: reinstall dependencies, or pick a CLI agent in Settings → Providers & Agents`,
    );
  }
}

/** Whether the built-in executor can run here (its packages are installed). */
export async function builtinAvailable(): Promise<boolean> {
  if (builtinOk === null) builtinOk = loadBuiltin().then(() => true, () => false);
  return builtinOk;
}

let builtinOk: Promise<boolean> | null = null;

async function launchCliSession(input: CliSessionInput): Promise<SessionResult> {
  const { provider } = input.agent;
  const { cmd, args, stdin, outFile } = sessionArgs(input);
  if (!resolveExecutable(cmd)) throw new Error(`${cmd} CLI not found — install it or set cliPath for the research agent`);
  if (provider === 'codex-cli' && input.agents?.length) writeCodexAgentLayers(input.cwd, input.agents, input.webFreshness);
  const transcriptPath = transcriptPathFor(input.cwd, input.label);
  const stderrPath = stderrPathFor(input.cwd, input.label);
  const out = fs.openSync(transcriptPath, 'w');
  const errOut = fs.openSync(stderrPath, 'w');
  // a no-op default: the assignment happens inside onSpawn, which TS's flow analysis cannot see
  let unregister = () => {};
  let res: { code: number; stdout: string; stderr: string };
  try {
    res = await runProcess(cmd, args, stdin, input.timeoutMs, {
      cwd: input.cwd,
      env: sessionEnv(input),
      onStdout: (chunk) => fs.writeSync(out, chunk),
      onStderr: (chunk) => fs.writeSync(errOut, chunk),
      onSpawn: (c) => {
        unregister = registerSession(input.jobId, processSession(c));
      },
    });
  } finally {
    fs.closeSync(out);
    fs.closeSync(errOut);
    unregister();
  }
  // a killed session exits like any other; the flag says why
  if (cancelledJobs.has(input.jobId)) throw new JobCancelledError(input.jobId);

  const result: SessionResult = { text: '', turns: null, costUsd: null, error: null, exitCode: res.code, transcriptPath };
  if (provider === 'claude-cli') {
    for (const line of res.stdout.split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as { type?: string; is_error?: boolean; result?: unknown; num_turns?: number; total_cost_usd?: number; subtype?: string };
        if (ev.type === 'result') {
          result.turns = typeof ev.num_turns === 'number' ? ev.num_turns : result.turns;
          result.costUsd = typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : result.costUsd;
          result.text = typeof ev.result === 'string' ? ev.result : result.text;
          if (ev.is_error) result.error = `claude: ${String(ev.result ?? ev.subtype ?? 'error').slice(0, 300)}`;
        }
      } catch {
        // progress lines
      }
    }
    if (res.code !== 0 && !result.error) result.error = `claude exited with code ${res.code}: ${(res.stderr || res.stdout).trim().slice(0, 300)}`;
  } else if (provider === 'codex-cli') {
    result.text = outFile && fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim() : '';
    if (res.code !== 0) result.error = `codex exec exited with code ${res.code}: ${(res.stderr || res.stdout).trim().slice(0, 300)}`;
  } else {
    const parsed = readCursorStream(res.stdout);
    result.text = parsed.text;
    if (parsed.error || res.code !== 0) result.error = `cursor: ${(parsed.error || res.stderr || res.stdout).trim().slice(0, 300)}`;
  }
  return result;
}

/** The argv of the single-session run (kept for `research export`). */
export function launchArgs(input: LaunchInput & { agent: CliAgent }): { cmd: string; args: string[]; stdin: string; outFile?: string } {
  return sessionArgs({ ...sessionFrom(input), agent: input.agent, prompt: fs.readFileSync(input.ws.briefPath, 'utf8') });
}

function sessionFrom(input: LaunchInput): Omit<SessionInput, 'prompt'> {
  return {
    agent: input.agent, maxTurns: input.maxTurns, timeoutMs: input.timeoutMs,
    cwd: input.ws.dir, mcp: input.mcp, readDirs: input.readDirs, jobId: input.jobId, outputPath: input.ws.outputPath,
    worksetId: input.ws.worksetId, allowNetwork: input.allowNetwork, tools: 'write', label: 'agent',
    effort: input.effort, webFreshness: input.webFreshness, agents: input.agents,
  };
}

/** Single-session mode: the brief is the whole prompt and the agent does everything itself. */
export async function launchAgent(input: LaunchInput): Promise<LaunchResult> {
  const r = await launchSession({ ...sessionFrom(input), prompt: fs.readFileSync(input.ws.briefPath, 'utf8') });
  return { exitCode: r.exitCode, turns: r.turns, costUsd: r.costUsd, resultText: r.text, error: r.error, transcriptPath: r.transcriptPath };
}
