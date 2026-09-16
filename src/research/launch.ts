import { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cliCommand, readCursorStream, resolveExecutable, runProcess } from '../llm/cli.js';
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
 */

export type AgentProvider = 'claude-cli' | 'codex-cli' | 'cursor-cli';

export const AGENT_PROVIDERS: AgentProvider[] = ['claude-cli', 'codex-cli', 'cursor-cli'];

export interface LaunchInput {
  provider: AgentProvider;
  cliPath: string;
  model: string;
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

const active = new Set<ChildProcess>();

/** Kill every agent this process launched (serve shutdown). */
export function killActiveAgents(): number {
  let n = 0;
  for (const child of active) {
    try {
      child.kill('SIGKILL');
      n++;
    } catch {
      /* already gone */
    }
  }
  active.clear();
  return n;
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
].map((t) => `mcp__knode-os__${t}`);

export interface SessionInput {
  provider: AgentProvider;
  cliPath: string;
  model: string;
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

/** codex has no `max`; cursor's bracket syntax is documented up to `high`. */
export function effortFor(provider: AgentProvider, effort: Effort | undefined): string | null {
  if (!effort || effort === 'default') return null;
  if (provider === 'codex-cli') return effort === 'max' ? 'xhigh' : effort;
  if (provider === 'cursor-cli') return effort === 'max' || effort === 'xhigh' ? 'high' : effort;
  return effort;
}

/** cursor takes effort inside the model name: `claude-opus-4-8[context=1m,effort=high]`. */
export function cursorModel(model: string, effort: Effort | undefined): string {
  const level = effortFor('cursor-cli', effort);
  if (!model || !level) return model;
  if (/\[.*\]$/.test(model)) {
    if (/effort=/.test(model)) return model.replace(/effort=[a-z]+/, `effort=${level}`);
    return model.replace(/\]$/, `,effort=${level}]`);
  }
  return `${model}[effort=${level}]`;
}

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

/** The argv a session is launched with (exported so tests and `research export` can print it). */
export function sessionArgs(input: SessionInput): { cmd: string; args: string[]; stdin: string; outFile?: string } {
  const cmd = cliCommand(input.provider, input.cliPath);
  const files = input.files !== false;
  const web = Boolean(input.allowNetwork);
  const agents = input.agents?.length ? input.agents : null;
  const effort = effortFor(input.provider, input.effort);
  if (input.provider === 'claude-cli') {
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
        ...(input.model ? ['--model', input.model] : []),
      ],
      stdin: input.prompt,
    };
  }
  if (input.provider === 'codex-cli') {
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
        ...(input.model ? ['-m', input.model] : []),
      ],
      stdin: input.prompt,
      outFile,
    };
  }
  const model = cursorModel(input.model, input.effort);
  return {
    cmd,
    args: [
      '-p', '--output-format', 'stream-json', '--trust', '--approve-mcps',
      '--workspace', input.cwd,
      ...input.readDirs.flatMap((d) => ['--add-dir', d]),
      ...(model ? ['--model', model] : []),
      input.prompt,
    ],
    stdin: '',
  };
}

/** One CLI session: prompt in, final message out, transcript on disk. */
export async function launchSession(input: SessionInput): Promise<SessionResult> {
  const { cmd, args, stdin, outFile } = sessionArgs(input);
  if (!resolveExecutable(cmd)) throw new Error(`${cmd} CLI not found — install it or set cliPath for the research agent`);
  if (input.provider === 'codex-cli' && input.agents?.length) writeCodexAgentLayers(input.cwd, input.agents, input.webFreshness);
  const transcriptPath = path.join(input.cwd, input.label === 'agent' ? 'transcript.jsonl' : `transcript-${input.label}.jsonl`);
  const stderrPath = path.join(input.cwd, input.label === 'agent' ? 'stderr.log' : `stderr-${input.label}.log`);
  const out = fs.openSync(transcriptPath, 'w');
  const errOut = fs.openSync(stderrPath, 'w');
  let child: ChildProcess | null = null;
  let res: { code: number; stdout: string; stderr: string };
  try {
    res = await runProcess(cmd, args, stdin, input.timeoutMs, {
      cwd: input.cwd,
      env: sessionEnv(input),
      onStdout: (chunk) => fs.writeSync(out, chunk),
      onStderr: (chunk) => fs.writeSync(errOut, chunk),
      onSpawn: (c) => {
        child = c;
        active.add(c);
      },
    });
  } finally {
    fs.closeSync(out);
    fs.closeSync(errOut);
    if (child) active.delete(child);
  }

  const result: SessionResult = { text: '', turns: null, costUsd: null, error: null, exitCode: res.code, transcriptPath };
  if (input.provider === 'claude-cli') {
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
  } else if (input.provider === 'codex-cli') {
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
export function launchArgs(input: LaunchInput): { cmd: string; args: string[]; stdin: string; outFile?: string } {
  return sessionArgs({ ...sessionFrom(input), prompt: fs.readFileSync(input.ws.briefPath, 'utf8') });
}

function sessionFrom(input: LaunchInput): Omit<SessionInput, 'prompt'> {
  return {
    provider: input.provider, cliPath: input.cliPath, model: input.model, maxTurns: input.maxTurns, timeoutMs: input.timeoutMs,
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
