import { ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LlmConfig, LlmEffort, LlmSpeed } from '../config.js';
import { lastRateLimitInfo, recordClaudeLimits } from '../estimate/claude-limits.js';
import type { ChatMessage } from './client.js';
import { catalogArgs, exitFailure, withCodexCatalog } from './codex-catalog.js';
import { externalDirs, opencodeConfig, opencodeEffort, opencodeEnv, OpencodeRule, opencodeRunArgs, readOpencodeStream } from './opencode.js';
import { CallUsage, readCodexEvents, usageFromClaudeResult, usageFromCursorResult } from './usage.js';

/**
 * Chat-completion backends that shell out to a locally installed coding-agent
 * CLI instead of an HTTP API. They reuse the CLI's own login (ChatGPT plan /
 * Anthropic account), so no API key is configured in knode — except OpenCode,
 * which has no login and runs on a connection's endpoint and key (src/llm/opencode.ts).
 *
 * All run in non-interactive one-shot mode with the OS temp dir as cwd so
 * the CLIs don't pick up repo instructions (AGENTS.md / CLAUDE.md) or try to
 * touch the workspace:
 *   - codex:  `codex exec --ignore-user-config --ephemeral -c features.plugins=false -c features.apps=false
 *             -c analytics.enabled=false [-c model_catalog_json=<copy>] --sandbox read-only
 *             --output-last-message <f> --json -`
 *   - claude: `claude -p --output-format stream-json --verbose --max-turns 1 --tools ""
 *             --strict-mcp-config` (the answer is its `result` event; its `rate_limit_event` is kept for
 *             the quota floor; no tools, so the one turn is the answer)
 *   - cursor: `cursor-agent -p --output-format json --trust <prompt>` (`--trust` answers the
 *             workspace-trust prompt newer CLIs raise for the temp cwd; the model still
 *             gets no tool grants beyond that directory)
 *   - opencode: `opencode run --format json --model knode/<model> --title knode` with the
 *             prompt on stdin and a generated config in the environment that denies
 *             every tool (but `read`, on the images' folders, when there are images)
 *
 * Images reach each one differently: codex takes `--image`, while claude and
 * cursor have no such flag and instead read the paths listed in the prompt with
 * their own file tools. A configured reasoning effort and speed ride along too,
 * each CLI in its own syntax — see `effortFor` and `speedFor`.
 *
 * Each also says what the call used (src/llm/usage.ts): codex in the
 * `turn.completed` event `--json` prints, claude in its result wrapper, cursor
 * in its stream's `result` event.
 */

const DEFAULT_TIMEOUT_MS = 300_000;

/** Executable each CLI provider runs when no explicit `cliPath` is configured. */
export const CLI_COMMANDS: Record<string, string> = {
  'codex-cli': 'codex',
  'claude-cli': 'claude',
  'cursor-cli': 'cursor-agent',
  'opencode-cli': 'opencode',
};

/** The command a CLI provider spawns: an explicit `cliPath`, else the default name looked up on PATH. */
export function cliCommand(provider: string, cliPath = ''): string {
  return cliPath.trim() || CLI_COMMANDS[provider] || '';
}

/**
 * Absolute path of `command`, or null when nothing executable answers to that
 * name. A bare name is searched on PATH — which for the desktop app is the
 * augmented one its launcher sets, not the shell's.
 */
export function resolveExecutable(command: string): string | null {
  if (!command) return null;
  const candidates = command.includes('/')
    ? [path.resolve(command)]
    : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, command));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * The level a CLI is actually told to think at, or null to leave its own
 * setting alone. codex takes the whole ladder, `ultra` included; claude stops
 * at `max`; cursor's bracket syntax is only documented as far as `high`.
 */
export function effortFor(provider: string, effort: LlmEffort | undefined): string | null {
  if (!effort || effort === 'default') return null;
  if (provider === 'cursor-cli') return effort === 'max' || effort === 'xhigh' || effort === 'ultra' ? 'high' : effort;
  if (provider === 'opencode-cli') return opencodeEffort(effort);
  if (provider === 'claude-cli' && effort === 'ultra') return 'max';
  return effort;
}

/**
 * The service tier a CLI is asked for, or null to leave its own setting
 * alone. Only codex has one per call (`service_tier`), named the way its
 * catalog's `additional_speed_tiers` names it; a tier the model does not
 * advertise is dropped by codex itself, with a warning. claude and cursor
 * have no such switch — cursor lists its fast variants as models of their own.
 */
export function speedFor(provider: string, speed: LlmSpeed | undefined): string | null {
  if (!speed || speed === 'default') return null;
  return provider === 'codex-cli' ? speed : null;
}

/** cursor takes effort inside the model name: `claude-opus-4-8[context=1m,effort=high]`. */
export function cursorModel(model: string, effort: LlmEffort | undefined): string {
  const level = effortFor('cursor-cli', effort);
  if (!model || !level) return model;
  if (/\[.*\]$/.test(model)) {
    if (/effort=/.test(model)) return model.replace(/effort=[a-z]+/, `effort=${level}`);
    return model.replace(/\]$/, `,effort=${level}]`);
  }
  return `${model}[effort=${level}]`;
}

/**
 * What every knode Codex process turns off: ChatGPT's plugins and apps
 * (connectors), and analytics. Each costs a download or an upload per process
 * that no knode call uses (see `codexExecArgs`). Research sessions, which keep
 * the rest of the person's config, turn them off too (src/research/launch.ts).
 */
export const CODEX_SERVICES_OFF = ['-c', 'features.plugins=false', '-c', 'features.apps=false', '-c', 'analytics.enabled=false'];

/** What a JSON request adds to the prompt where the wire has no JSON mode: an agent's loop. */
export const JSON_DIRECTIVE = 'Respond with a single JSON object only — no prose, no markdown code fences.';

/** Flatten chat messages into a single prompt for one-shot CLI runs. */
export function renderCliPrompt(messages: ChatMessage[], json: boolean): string {
  const nonSystem = messages.filter((m) => m.role !== 'system');
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === 'system' || nonSystem.length === 1) parts.push(m.content);
    else parts.push(`[${m.role}]\n${m.content}`);
  }
  let prompt = parts.join('\n\n');
  if (json) prompt += `\n\n${JSON_DIRECTIVE}`;
  return prompt;
}

export async function completeViaCli(
  cfg: LlmConfig,
  messages: ChatMessage[],
  opts: { json?: boolean; model?: string; images?: string[]; onUsage?: (usage: CallUsage) => void } = {},
): Promise<string> {
  const images = opts.images ?? [];
  let prompt = renderCliPrompt(messages, Boolean(opts.json));
  const model = opts.model || cfg.model || undefined;
  const report = opts.onUsage ?? (() => {});
  if (cfg.provider === 'codex-cli') return runCodex(cfg, prompt, model, images, report);
  if (cfg.provider === 'claude-cli') {
    if (images.length) {
      prompt += `\n\nUse the Read tool to inspect these image files before answering:\n${images.map((image) => `- ${image}`).join('\n')}`;
    }
    return runClaude(cfg, prompt, model, images, report);
  }
  if (cfg.provider === 'cursor-cli') {
    if (images.length) {
      prompt += `\n\nRead these image files before answering:\n${images.map((image) => `- ${image}`).join('\n')}`;
    }
    return runCursor(cfg, prompt, model, report);
  }
  if (cfg.provider === 'opencode-cli') {
    if (images.length) {
      prompt += `\n\nUse the read tool to inspect these image files before answering:\n${images.map((image) => `- ${image}`).join('\n')}`;
    }
    return runOpencode(cfg, prompt, model, images, report);
  }
  throw new Error(`not a CLI provider: ${cfg.provider}`);
}

/**
 * The arguments of a one-shot `codex exec`. `--ignore-user-config` keeps the
 * person's ~/.codex/config.toml out of a pipeline call — its MCP servers would
 * start for every call and its memory and multi-agent instructions would ride
 * along with every document (tens of thousands of characters each time) — and
 * `--ephemeral` keeps tens of thousands of extraction sessions out of
 * ~/.codex/sessions, where trace sync would read them back as agent traces.
 * Model, effort and speed are passed explicitly instead.
 *
 * Plugins are turned off too. They are on by default, `--ignore-user-config`
 * or not, and with them every start downloads ChatGPT's whole plugin catalog
 * (about 15 MB in Codex 0.161, ten times the call itself) and starts the MCP
 * servers of the plugins installed on the account, none of which a one-shot
 * call uses. ChatGPT apps (connectors) off drops the apps listing each start
 * fetches (0.6–1 MB in Codex 0.166). Analytics off drops the usage metrics
 * (about 0.65 MB) each process uploads as it exits. All three go through `-c`:
 * a Codex without the setting ignores it there, while `--disable <feature>`
 * would fail the call.
 *
 * `catalog` pins a local copy of Codex's model catalog (src/llm/codex-catalog.ts),
 * which every start would otherwise download: 650 KB, once or twice per call.
 *
 * `--json` prints the run as events, the last turn's token usage among them;
 * the answer still comes from `--output-last-message`, and a failure's reason
 * from the `error` / `turn.failed` event instead of a banner and the echoed
 * prompt on stderr.
 */
export function codexExecArgs(opts: {
  outFile: string; cwd: string; model?: string; effort?: LlmEffort; speed?: LlmSpeed; images?: string[]; catalog?: string | null;
}): string[] {
  // --output-last-message gives the bare final message without parsing JSONL events
  const args = [
    'exec', '--ignore-user-config', '--ephemeral', ...CODEX_SERVICES_OFF, ...catalogArgs(opts.catalog ?? null),
    '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', opts.cwd, '--output-last-message', opts.outFile, '--json',
  ];
  if (opts.model) args.push('--model', opts.model);
  const effort = effortFor('codex-cli', opts.effort);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  const tier = speedFor('codex-cli', opts.speed);
  if (tier) args.push('-c', `service_tier="${tier}"`);
  for (const image of opts.images ?? []) args.push('--image', image);
  args.push('-'); // read the prompt from stdin
  return args;
}

/**
 * What a failed CLI said, for the error message. Its tail, not its head:
 * codex prints a banner and echoes the whole prompt before it gets to the
 * reason (a usage limit, an expired login), and a head cut kept only those.
 */
export function cliFailureText(stderr: string, stdout: string, max = 400): string {
  const text = (stderr || stdout).trim();
  return text.length > max ? `…${text.slice(-max)}` : text;
}

async function runCodex(cfg: LlmConfig, prompt: string, model: string | undefined, images: string[], report: (usage: CallUsage) => void): Promise<string> {
  const cmd = cliCommand('codex-cli', cfg.cliPath);
  const outFile = path.join(os.tmpdir(), `knode-codex-${crypto.randomUUID()}.txt`);
  try {
    const r = await withCodexCatalog(resolveExecutable(cmd), model, (catalog) => {
      const args = codexExecArgs({ outFile, cwd: os.tmpdir(), model, effort: cfg.effort, speed: cfg.speed, images, catalog });
      return runProcess(cmd, args, prompt, cfg.cliTimeoutMs);
    }, exitFailure);
    const events = readCodexEvents(r.stdout);
    // a failed turn used tokens too, and they count against the plan all the same
    if (events.usage) report(events.usage);
    if (r.code !== 0) throw new Error(`codex exec exited with code ${r.code}: ${events.error ?? cliFailureText(r.stderr, r.stdout)}`);
    const out = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim() : '';
    if (!out) throw new Error(`codex exec finished but produced no message${events.error ? `: ${events.error}` : ''}`);
    return out;
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}

/**
 * The result wrapper of a claude run: the last `result` event of its
 * stream-json output, or — from a CLI that printed one JSON document — that
 * document. Null when stdout holds neither.
 */
export function claudeResultOf(stdout: string): Record<string, unknown> | null {
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event && typeof event === 'object' && 'result' in event && (event.type === 'result' || event.type === undefined)) return event;
    } catch {
      // a partial line
    }
  }
  try {
    const whole = JSON.parse(stdout) as unknown;
    return whole && typeof whole === 'object' && 'result' in whole ? (whole as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * What keeps a text completion to its one turn: no built-in tools and no MCP
 * servers (the user's own, or a plugin's). With tools on offer the model now
 * and then spends that turn calling one, and `--max-turns 1` fails the call
 * with "Reached maximum number of turns (1)" (it stopped an evaluation's
 * scoring on 2026-11-13). The prompt is smaller without their descriptions,
 * too.
 */
const CLAUDE_NO_TOOLS = ['--tools', '', '--strict-mcp-config'];
/** Claude CLIs (by command) too old to know those flags: run without them from then on. */
const claudeWithoutNoTools = new Set<string>();
const rejectsNoTools = (stderr: string): boolean => /unknown option/i.test(stderr) && /--tools|--strict-mcp-config/.test(stderr);

async function runClaude(cfg: LlmConfig, prompt: string, model: string | undefined, images: string[], report: (usage: CallUsage) => void): Promise<string> {
  const cmd = cliCommand('claude-cli', cfg.cliPath);
  // one turn to read each picture (or all of them at once) and one to answer;
  // stream-json (which needs --verbose in print mode) because its
  // rate_limit_event says how far the plan's windows are used, which the
  // quota floor reads (src/estimate/claude-limits.ts); the answer is the same
  // result event `--output-format json` prints alone
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--max-turns', images.length ? String(Math.max(3, images.length + 2)) : '1'];
  if (model) args.push('--model', model);
  const effort = effortFor('claude-cli', cfg.effort);
  if (effort) args.push('--effort', effort);
  if (images.length) {
    args.push('--tools', 'Read', '--permission-mode', 'dontAsk', '--no-session-persistence');
    const dirs = [...new Set(images.map((image) => path.dirname(path.resolve(image))))];
    args.push('--add-dir', ...dirs);
  }
  // a picture is read with the Read tool; a text completion gets no tools at all
  const noTools = images.length === 0 && !claudeWithoutNoTools.has(cmd);
  let ran = await runProcess(cmd, noTools ? [...args, ...CLAUDE_NO_TOOLS] : args, prompt, cfg.cliTimeoutMs);
  if (noTools && ran.code !== 0 && rejectsNoTools(ran.stderr)) {
    claudeWithoutNoTools.add(cmd);
    ran = await runProcess(cmd, args, prompt, cfg.cliTimeoutMs);
  }
  const { code, stdout, stderr } = ran;
  const limits = lastRateLimitInfo(stdout);
  if (limits) recordClaudeLimits(limits);
  // even on failure claude prints a result wrapper — prefer its message over raw output
  const wrapper = claudeResultOf(stdout);
  if (wrapper) {
    const w = wrapper as { result?: unknown; is_error?: boolean };
    const usage = usageFromClaudeResult(wrapper);
    if (usage) report(usage);
    if (w.is_error || code !== 0) throw new Error(`claude CLI error: ${String(w.result ?? 'unknown').slice(0, 300)}`);
    return String(w.result ?? '').trim();
  }
  if (code !== 0) throw new Error(`claude exited with code ${code}: ${cliFailureText(stderr, stdout)}`);
  return stdout.trim(); // older CLI or plain-text output
}

async function runCursor(cfg: LlmConfig, prompt: string, model: string | undefined, report: (usage: CallUsage) => void): Promise<string> {
  const cmd = cliCommand('cursor-cli', cfg.cliPath);
  // --trust: since the 2026.09 CLI, print mode refuses to run in a directory
  // the user has not trusted interactively; the cwd here is the OS temp dir
  const args = ['-p', '--output-format', 'stream-json', '--trust'];
  // cursor has no effort flag, and no way to set one without naming a model
  const named = cursorModel(model ?? '', cfg.effort);
  if (named) args.push('--model', named);
  args.push(prompt);
  const { code, stdout, stderr } = await runProcess(cmd, args, '', cfg.cliTimeoutMs);
  const { text, error, usage } = readCursorStream(stdout);
  if (usage) report(usage);
  if (error || code !== 0) {
    throw new Error(`cursor CLI error: ${error ? error.trim().slice(0, 400) : cliFailureText(stderr, stdout)}`);
  }
  if (!text) throw new Error('cursor-agent finished but produced no message');
  return text;
}

/**
 * One `opencode run` on the connection the agent names. Every tool is denied,
 * the way the other CLIs get none: a stage sends its prompt and wants one
 * answer. Images are the exception — OpenCode attaches local files as text,
 * so the model reads them with its `read` tool, allowed on their folders only.
 */
async function runOpencode(cfg: LlmConfig, prompt: string, model: string | undefined, images: string[], report: (usage: CallUsage) => void): Promise<string> {
  if (!cfg.baseUrl) throw new Error('opencode CLI error: this OpenCode agent names no model connection — pick one for it (Settings → Providers & Agents)');
  if (!model) throw new Error('opencode CLI error: no model — set one on the agent or on its connection');
  const cmd = cliCommand('opencode-cli', cfg.cliPath);
  const dirs = [...new Set(images.map((image) => path.dirname(path.resolve(image))))];
  const permission: Record<string, OpencodeRule> = dirs.length ? { '*': 'deny', read: 'allow', external_directory: externalDirs(dirs) } : { '*': 'deny' };
  const config = opencodeConfig({ endpoint: cfg, model, label: cfg.label, effort: cfg.effort, images: images.length > 0, permission });
  const { code, stdout, stderr } = await runProcess(cmd, opencodeRunArgs(model, 'knode'), prompt, cfg.cliTimeoutMs, {
    env: { ...process.env, ...opencodeEnv(config, cfg, { oneShot: true }) },
  });
  const { text, error, usage } = readOpencodeStream(stdout);
  if (usage) report(usage);
  if (error || code !== 0) throw new Error(`opencode CLI error: ${error ? error.slice(0, 400) : cliFailureText(stderr, stdout)}`);
  if (!text) throw new Error('opencode finished but produced no message');
  return text;
}

/**
 * Pull the answer out of cursor-agent's NDJSON stream.
 *
 * The CLI narrates what it is about to do in assistant messages of its own
 * ("I'll read the file first, then…"), and `--output-format json` hands all of
 * that back glued to the answer — commentary that would land in a converted
 * document or break a JSON route's parse. The stream keeps the messages apart,
 * so the answer is what it says after its last tool call, or its last message
 * when it used no tools. The `result` event also carries the call's usage.
 */
export function readCursorStream(stdout: string): { text: string; error?: string; usage?: CallUsage } {
  const chunks: string[] = [];
  let result = '';
  let error: string | undefined;
  let usage: CallUsage | undefined;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let event: { type?: string; subtype?: string; is_error?: boolean; result?: unknown; message?: { content?: unknown } };
    try {
      event = JSON.parse(line);
    } catch {
      continue; // the CLI also prints plain progress lines
    }
    if (event.type === 'assistant') {
      const parts = Array.isArray(event.message?.content) ? event.message.content : [];
      const text = parts.map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text?: unknown }).text ?? '') : '')).join('');
      if (text.trim()) chunks.push(text);
    } else if (event.type === 'tool_call' && event.subtype === 'started') {
      chunks.length = 0; // anything said before a tool call was narration
    } else if (event.type === 'result') {
      if (event.is_error || event.subtype === 'error') error = String(event.result ?? 'unknown');
      else result = String(event.result ?? '');
      usage = usageFromCursorResult(event) ?? usage;
    }
  }
  const text = chunks.join('\n').trim() || result.trim();
  return usage ? { text, error, usage } : { text, error };
}

export interface RunProcessOptions {
  /** Working directory (default: the OS temp dir, so repo instructions are not picked up). */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Streaming taps — the research runner writes a transcript while the agent runs. */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Called with the child so a caller can kill it on shutdown. */
  onSpawn?: (child: ChildProcess) => void;
}

export function runProcess(cmd: string, args: string[], stdin: string, timeoutMs: number, opts: RunProcessOptions = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const limit = timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd ?? os.tmpdir(), env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    opts.onSpawn?.(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    // reject on timeout without waiting for 'close' — grandchildren of the CLI
    // may hold the stdio pipes open even after the CLI itself is killed
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(`${cmd} timed out after ${Math.round(limit / 1000)}s`)));
    }, limit);

    child.stdout.on('data', (d: Buffer) => {
      const text = d.toString('utf8');
      stdout += text;
      opts.onStdout?.(text);
    });
    child.stderr.on('data', (d: Buffer) => {
      const text = d.toString('utf8');
      stderr += text;
      opts.onStderr?.(text);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(() => {
        if (err.code === 'ENOENT') reject(new Error(`${cmd} CLI not found — install it or set a CLI path in knode.config.json`));
        else reject(err);
      });
    });
    child.on('close', (code) => {
      finish(() => resolve({ code: code ?? -1, stdout, stderr }));
    });

    child.stdin.on('error', () => {}); // CLI may exit before consuming stdin
    child.stdin.write(stdin);
    child.stdin.end();
  });
}
