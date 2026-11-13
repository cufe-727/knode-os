import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { LlmEffort } from '../config.js';
import { cliCommand, CODEX_SERVICES_OFF, effortFor, resolveExecutable, runProcess } from '../llm/cli.js';
import { catalogArgs, exitFailure, withCodexCatalog } from '../llm/codex-catalog.js';
import { CallUsage, readCodexEvents } from '../llm/usage.js';
import { EVAL_HOME } from './pack.js';
import { currentRemote } from './placement.js';
import { remoteAgent, RemoteEval } from './remote.js';
import { evalTempDir } from './tmp.js';

/**
 * One Codex agent session over a folder (docs/design/23 §3): the grep
 * baseline, the agents that read a generated wiki, the agent with knode's
 * MCP tools, and the llm-wiki builder are all this one runner with a
 * different folder, sandbox and tool set — so the comparison is between
 * knowledge sources, not between agent harnesses.
 *
 * `codex exec` has no turn limit; the runner counts the session's command
 * and tool events as they stream and stops it at the cap. Codex's read-only
 * sandbox blocks writes, not reads, so every command line is also audited:
 * a path outside the session's folder that leads into the benchmark's own
 * files (packs, runs — the gold) voids the answer.
 */

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Only these tools are offered (Codex `enabled_tools`). */
  enabledTools?: string[];
}

/**
 * Where agent sessions run (docs/design/23 D18): a model chain's API links
 * become a Codex model provider billed to the key, a CLI link the Codex login.
 * Set once per run by `runEval`; absent, every session uses the login.
 */
export interface AgentRouting {
  pick(): { name: string; api?: { baseUrl: string; apiKey: string; model: string } } | null;
  charge(name: string, model: string, usage: CallUsage | null): void;
  exhaust(name: string, why: string): void;
}

let routing: AgentRouting | null = null;

export function setAgentRouting(r: AgentRouting | null): void {
  routing = r;
}

/** The env var a session reads its API key from: never on the command line, where `ps` would show it. */
export const AGENT_KEY_ENV = 'KNODE_EVAL_AGENT_API_KEY';

/** Codex arguments that send a session to an OpenAI-compatible API (Responses) instead of the login. */
export function apiProviderArgs(baseUrl: string): string[] {
  return [
    '-c', 'model_provider="knode_eval_api"',
    '-c', `model_providers.knode_eval_api={ name = "knode eval API", base_url = ${JSON.stringify(baseUrl.replace(/\/$/, ''))}, env_key = "${AGENT_KEY_ENV}", wire_api = "responses" }`,
  ];
}

export interface AgentRunOptions {
  cwd: string;
  prompt: string;
  sandbox: 'read-only' | 'workspace-write';
  model?: string;
  effort?: LlmEffort;
  /** Command and tool events before the session is stopped (default 25). */
  maxSteps?: number;
  timeoutMs?: number;
  command?: string;
  mcp?: McpServerSpec;
  /** Extra roots a command may touch without voiding the answer. */
  allowRoots?: string[];
  /** What the session is for, for a remote worker's log and Tasks (a system and task). */
  label?: string;
}

export interface AgentRunResult {
  text: string;
  usage: CallUsage | null;
  /** Command lines the agent ran, in order. */
  commands: string[];
  toolCalls: number;
  capped: boolean;
  /** Paths outside the folder that lead into benchmark files. */
  leaked: string[];
  /** Corpus files the agent's commands named, relative to cwd. */
  filesTouched: string[];
  ms: number;
  error?: string;
  /** The remote worker that ran it (docs/design/27 §8); absent = this machine. */
  worker?: string;
  /** The CLI and model it ran on, `codex-cli:<model>` (or the API link's name). */
  backend?: string;
}

const toml = (v: unknown) => JSON.stringify(v);

/**
 * The session's `codex exec` arguments: the one-shot call's (src/llm/cli.ts
 * `codexExecArgs`) — user config, plugins, apps and analytics off, the model
 * catalog from a local copy when `catalog` names one — with the sandbox, the
 * folder and knode's MCP server where the session has it.
 */
export function agentArgs(opts: AgentRunOptions, outFile: string, catalog: string | null = null): string[] {
  const args = [
    'exec', '--ignore-user-config', '--ephemeral', ...CODEX_SERVICES_OFF, ...catalogArgs(catalog),
    '-c', 'web_search="disabled"', '--skip-git-repo-check', '--sandbox', opts.sandbox, '--cd', opts.cwd,
    '--output-last-message', outFile, '--json',
  ];
  if (opts.model) args.push('--model', opts.model);
  const effort = effortFor('codex-cli', opts.effort);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  if (opts.mcp) {
    const key = `mcp_servers.${opts.mcp.name}`;
    args.push('-c', `${key}.command=${toml(opts.mcp.command)}`, '-c', `${key}.args=${toml(opts.mcp.args)}`);
    if (opts.mcp.env && Object.keys(opts.mcp.env).length) {
      args.push('-c', `${key}.env={${Object.entries(opts.mcp.env).map(([k, v]) => `${k}=${toml(v)}`).join(',')}}`);
    }
    if (opts.mcp.enabledTools?.length) args.push('-c', `${key}.enabled_tools=${toml(opts.mcp.enabledTools)}`);
    args.push('-c', `${key}.default_tools_approval_mode="approve"`, '-c', `${key}.tool_timeout_sec=300`);
  }
  args.push('-');
  return args;
}

/** Path-like tokens of a command line: absolute, home-relative, or climbing out with `..`. */
export function pathTokens(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/(?:^|[\s'"=(:])((?:\/|~\/|\.\.(?:\/|$))[^\s'"|;&<>()]*)/g)) out.push(m[1]);
  return out;
}

const SYSTEM_PREFIXES = ['/usr/', '/bin/', '/sbin/', '/opt/homebrew/', '/dev/', '/System/', '/Library/', '/private/etc/', '/etc/'];

/**
 * Which of a command's paths reach benchmark files: anything under the eval
 * home (packs, runs, sources) or the person's home outside the folder.
 * System binaries and devices are fine; so is the folder itself.
 */
export function leakedPaths(command: string, cwd: string, allowRoots: string[] = [], home = os.homedir()): string[] {
  const root = path.resolve(cwd);
  const leaks: string[] = [];
  for (const tok of pathTokens(command)) {
    const expanded = tok.startsWith('~/') ? path.join(home, tok.slice(2)) : tok;
    const abs = path.resolve(root, expanded);
    if (abs === root || abs.startsWith(root + path.sep)) continue;
    if (allowRoots.some((r) => abs === r || abs.startsWith(r + path.sep))) continue;
    if (SYSTEM_PREFIXES.some((p) => abs.startsWith(p))) continue;
    // the staged folder's parent holds nothing but the folder, so climbing one level is harmless
    if (abs === path.dirname(root)) continue;
    if (abs.startsWith(EVAL_HOME) || abs.startsWith(home) || abs.includes('knode-eval')) leaks.push(tok);
  }
  return leaks;
}

/** Corpus-relative files a command names (rg/grep/cat/sed/head arguments that exist under cwd). */
export function touchedFiles(command: string, cwd: string): string[] {
  const out = new Set<string>();
  for (const tok of command.split(/[\s'"|;&<>()]+/)) {
    if (!tok || tok.startsWith('-')) continue;
    const abs = path.resolve(cwd, tok);
    if (!abs.startsWith(path.resolve(cwd) + path.sep)) continue;
    try {
      if (fs.statSync(abs).isFile()) out.add(path.relative(cwd, abs).split(path.sep).join('/'));
    } catch {
      /* not a file */
    }
  }
  return [...out];
}

interface CodexItem {
  type?: string;
  command?: string;
  server?: string;
  tool?: string;
  arguments?: unknown;
}

/**
 * A session's `codex exec --json` events as they stream: its trace (command
 * lines and MCP calls), the step cap, and the leak audit. One reader for a
 * session run here and one a remote worker ran (src/eval/remote.ts), whose
 * folder paths are read as this machine's copy (`rewrite`) and whose home is
 * the worker's.
 */
export class AgentTrace {
  readonly commands: string[] = [];
  readonly leaked: string[] = [];
  readonly touched = new Set<string>();
  steps = 0;
  capped = false;

  constructor(private readonly opts: { cwd: string; maxSteps: number; allowRoots?: string[]; home?: string; rewrite?: (command: string) => string; onCap?: () => void }) {}

  line(line: string): void {
    if (!line.startsWith('{')) return;
    let ev: { type?: string; item?: CodexItem };
    try {
      ev = JSON.parse(line) as { type?: string; item?: CodexItem };
    } catch {
      return;
    }
    if (ev.type !== 'item.started' || !ev.item) return;
    const item = ev.item;
    if (item.type === 'command_execution' && typeof item.command === 'string') {
      this.steps++;
      this.commands.push(item.command);
      const command = this.opts.rewrite ? this.opts.rewrite(item.command) : item.command;
      this.leaked.push(...leakedPaths(command, this.opts.cwd, this.opts.allowRoots, this.opts.home));
      for (const f of touchedFiles(command, this.opts.cwd)) this.touched.add(f);
    } else if (item.type === 'mcp_tool_call') {
      this.steps++;
      this.commands.push(`mcp:${item.server ?? ''}.${item.tool ?? ''} ${JSON.stringify(item.arguments ?? {}).slice(0, 300)}`);
    }
    if (this.steps > this.opts.maxSteps && !this.capped) {
      this.capped = true;
      this.opts.onCap?.();
    }
  }
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  // on a remote worker when the run offers its sessions and one takes this one (docs/design/27 §8); a run
  // routed over an agent chain stays here, since its links are this machine's keys and logins
  const remote = routing ? null : currentRemote<RemoteEval>();
  if (remote) {
    const r = await remoteAgent(remote, opts);
    if (r) return r;
    remote.counts.here++;
    await remote.localGate();
  }
  // down the chain: an API link until its budget or credit is gone, then the next
  for (;;) {
    const link = routing?.pick() ?? null;
    if (routing && !link) throw new Error('agent sessions: every model in the chain is spent');
    const r = await runAgentOnce(opts, link?.api);
    const model = link?.api?.model ?? opts.model ?? '';
    r.backend = link?.api ? `${link.name}:${model || 'default'}` : `codex-cli:${model || 'default'}`;
    if (link) routing!.charge(link.name, model, r.usage);
    if (link && r.error && /insufficient_quota|exceeded your current quota|credit balance is too low|billing|payment required|\b402\b/i.test(r.error)) {
      routing!.exhaust(link.name, r.error.slice(0, 120));
      continue;
    }
    return r;
  }
}

async function runAgentOnce(opts: AgentRunOptions, api?: { baseUrl: string; apiKey: string; model: string }): Promise<AgentRunResult> {
  const out = evalTempDir('agent-out');
  const outDir = out.root;
  const outFile = path.join(outDir, 'answer.txt');
  const maxSteps = opts.maxSteps ?? 25;
  let child: ChildProcess | null = null;
  let buffer = '';
  const t0 = Date.now();
  const newTrace = () => new AgentTrace({ cwd: opts.cwd, maxSteps, allowRoots: opts.allowRoots, onCap: () => child?.kill('SIGTERM') });
  let trace = newTrace();

  try {
    let stdout = '';
    let error: string | undefined;
    try {
      const cmd = cliCommand('codex-cli', opts.command ?? '');
      const r = await withCodexCatalog(resolveExecutable(cmd), opts.model, (catalog) => {
        // a repeat (Codex could not read the catalog copy) starts from nothing, as the first try did
        trace = newTrace();
        buffer = '';
        const args = agentArgs(api ? { ...opts, model: api.model || opts.model } : opts, outFile, catalog);
        if (api) args.splice(args.length - 1, 0, ...apiProviderArgs(api.baseUrl));
        return runProcess(cmd, args, opts.prompt, opts.timeoutMs ?? 15 * 60_000, {
          cwd: opts.cwd,
          ...(api ? { env: { ...process.env, [AGENT_KEY_ENV]: api.apiKey } } : {}),
          onSpawn: (c) => (child = c),
          onStdout: (chunk) => {
            buffer += chunk;
            let nl: number;
            while ((nl = buffer.indexOf('\n')) >= 0) {
              trace.line(buffer.slice(0, nl));
              buffer = buffer.slice(nl + 1);
            }
          },
        });
      }, exitFailure);
      stdout = r.stdout;
      if (r.code !== 0 && !trace.capped) error = `codex exec exited with ${r.code}: ${readCodexEvents(r.stdout).error ?? r.stderr.slice(-300)}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const events = readCodexEvents(stdout);
    const text = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim() : '';
    return {
      text,
      usage: events.usage,
      commands: trace.commands,
      toolCalls: trace.steps,
      capped: trace.capped,
      leaked: [...new Set(trace.leaked)],
      filesTouched: [...trace.touched],
      ms: Date.now() - t0,
      ...(error && !text ? { error } : {}),
    };
  } finally {
    out.cleanup();
  }
}

/** A copy of `src` in a fresh temp directory with nothing beside it, for an agent to read. */
export function isolatedCopy(src: string, name = 'kb'): { dir: string; cleanup: () => void } {
  const { root, cleanup } = evalTempDir('ro');
  const dir = path.join(root, name);
  fs.cpSync(src, dir, { recursive: true });
  return { dir, cleanup };
}
