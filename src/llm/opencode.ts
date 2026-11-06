import path from 'node:path';
import { LlmEffort, LlmProtocol, resolveSecret } from '../config.js';
import { CallUsage } from './usage.js';

/**
 * OpenCode (`opencode run`), the open-source coding-agent CLI, as an
 * executor. Unlike the other CLIs it has no login of its own: it is a loop,
 * and the model it loops on is one of knode's connections. So every OpenCode
 * process gets one generated configuration, passed in `OPENCODE_CONFIG_CONTENT`
 * — the layer that overrides the person's own OpenCode files and any
 * `opencode.json` above the working directory:
 *
 *   - one provider, `knode`, on the connection's endpoint: `@ai-sdk/openai`
 *     (the Responses API) or `@ai-sdk/openai-compatible` (Chat Completions),
 *     both bundled with OpenCode, so nothing is installed at run time;
 *   - its key as `{env:KNODE_OPENCODE_API_KEY}`, and the key itself in the
 *     process environment — never in argv or in a file;
 *   - `enabled_providers: ["knode"]`, so no other provider loads (or bills);
 *   - permissions, MCP servers and agents, which a research session sets and
 *     a one-shot call leaves at "deny everything".
 *
 * Written against OpenCode 1.19.4's source and run against that release
 * (2026-11-06, docs/design/06 open item 8): `run --format json` prints
 * one JSON event per line — `step_start`, `text` (a finished text part),
 * `tool_use` (a finished tool call), `step_finish` (that step's tokens and
 * cost), `reasoning`, `error` — and exits 1 when the session errored. A
 * permission that would ask is rejected in `run` mode, so a denied tool fails
 * the call instead of hanging. Piped stdin is appended to the message, which
 * is how the prompt travels. Only the main session's events are printed, so
 * a sub-agent's steps and tokens never reach knode.
 */

/** The provider id the generated config defines; models are `knode/<model>`. */
export const OPENCODE_PROVIDER = 'knode';

/** The environment variable the generated config reads the connection's key from. */
export const OPENCODE_KEY_VAR = 'KNODE_OPENCODE_API_KEY';

/** What `effort` OpenCode passes on as `reasoningEffort`: the levels every OpenAI-compatible endpoint knows. */
export function opencodeEffort(effort: LlmEffort | undefined): 'low' | 'medium' | 'high' | null {
  if (!effort || effort === 'default') return null;
  return effort === 'low' || effort === 'medium' ? effort : 'high';
}

export interface OpencodeEndpoint {
  baseUrl: string;
  apiKey: string;
  protocol?: LlmProtocol;
}

/**
 * Which AI SDK package speaks to the endpoint. A connection pinned to a wire
 * keeps it; 'auto' means the Responses API on OpenAI itself, where knode's own
 * client would land too, and Chat Completions everywhere else — OpenCode
 * cannot fall back the way knode's client does, and nearly every
 * OpenAI-compatible endpoint (Anthropic's included) has Chat Completions.
 */
export function opencodeProviderNpm(endpoint: Pick<OpencodeEndpoint, 'baseUrl' | 'protocol'>): '@ai-sdk/openai' | '@ai-sdk/openai-compatible' {
  if (endpoint.protocol === 'responses') return '@ai-sdk/openai';
  if (endpoint.protocol === 'chat') return '@ai-sdk/openai-compatible';
  let host = '';
  try {
    host = new URL(endpoint.baseUrl).hostname;
  } catch {
    host = '';
  }
  return host === 'api.openai.com' ? '@ai-sdk/openai' : '@ai-sdk/openai-compatible';
}

/** `knode/<model>`, what `--model` and the config name a model by. */
export function opencodeModelRef(model: string): string {
  return `${OPENCODE_PROVIDER}/${model}`;
}

/** An OpenCode permission rule: one action, or patterns to actions (the last match wins). */
export type OpencodeRule = 'allow' | 'ask' | 'deny' | Record<string, 'allow' | 'ask' | 'deny'>;

/**
 * The `external_directory` rule that lets a session reach these folders and
 * what is under them, and nothing else outside its working directory. A
 * pattern's `*` crosses `/` in OpenCode's matcher, so `<dir>/*` covers the tree.
 */
export function externalDirs(dirs: string[]): OpencodeRule {
  const rule: Record<string, 'allow' | 'deny'> = { '*': 'deny' };
  for (const dir of dirs) {
    rule[dir] = 'allow';
    rule[path.join(dir, '*')] = 'allow';
  }
  return rule;
}

export interface OpencodeAgentConfig {
  description?: string;
  mode?: 'primary' | 'subagent' | 'all';
  model?: string;
  prompt?: string;
  steps?: number;
  permission?: Record<string, OpencodeRule>;
  reasoningEffort?: string;
}

export interface OpencodeConfigInput {
  endpoint: OpencodeEndpoint;
  /** The model the session runs; also every other model a sub-agent names, on the same connection. */
  model: string;
  extraModels?: string[];
  /** The connection's name, shown by OpenCode. */
  label?: string;
  effort?: LlmEffort;
  /** Images a one-shot call reads with the read tool: the model is declared to take them. */
  images?: boolean;
  permission: Record<string, OpencodeRule>;
  mcp?: Record<string, unknown>;
  agent?: Record<string, OpencodeAgentConfig>;
}

/**
 * The configuration an OpenCode process runs on. It holds no secret: the key
 * and the MCP token are `{env:…}` references OpenCode substitutes as it loads.
 */
export function opencodeConfig(input: OpencodeConfigInput): Record<string, unknown> {
  const effort = opencodeEffort(input.effort);
  const model = (id: string) => ({
    name: id,
    tool_call: true,
    ...(input.images ? { attachment: true, modalities: { input: ['text', 'image'], output: ['text'] } } : {}),
    ...(effort ? { options: { reasoningEffort: effort } } : {}),
  });
  const models = [...new Set([input.model, ...(input.extraModels ?? [])].filter(Boolean))];
  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    snapshot: false,
    share: 'disabled',
    enabled_providers: [OPENCODE_PROVIDER],
    model: opencodeModelRef(input.model),
    small_model: opencodeModelRef(input.model),
    provider: {
      [OPENCODE_PROVIDER]: {
        npm: opencodeProviderNpm(input.endpoint),
        name: input.label || 'knode',
        options: { baseURL: input.endpoint.baseUrl.replace(/\/+$/, ''), apiKey: `{env:${OPENCODE_KEY_VAR}}` },
        models: Object.fromEntries(models.map((id) => [id, model(id)])),
      },
    },
    permission: input.permission,
    ...(input.mcp && Object.keys(input.mcp).length ? { mcp: input.mcp } : {}),
    ...(input.agent && Object.keys(input.agent).length ? { agent: input.agent } : {}),
  };
}

/**
 * The environment every OpenCode process knode starts gets on top of its own:
 * the generated config, the key, and nothing fetched or read that a call does
 * not use — no update check, no model catalog download (the provider is
 * defined in full), no LSP downloads, and none of Claude Code's files
 * (`~/.claude/CLAUDE.md` and its skills), which are another tool's
 * instructions. `oneShot` also drops project config and instruction files:
 * a pipeline call runs in the OS temp dir and wants no AGENTS.md from it,
 * while a research session wants the one its run workspace holds.
 */
export function opencodeEnv(config: Record<string, unknown>, endpoint: OpencodeEndpoint, opts: { oneShot?: boolean } = {}): Record<string, string> {
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    [OPENCODE_KEY_VAR]: resolveSecret(endpoint.apiKey),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_TERMINAL_TITLE: '1',
    ...(opts.oneShot ? { OPENCODE_DISABLE_PROJECT_CONFIG: '1' } : {}),
  };
}

/** The flags every `opencode run` gets: JSON events, the model, and a title so no extra call names the session. */
export function opencodeRunArgs(model: string, title: string): string[] {
  return ['run', '--format', 'json', '--model', opencodeModelRef(model), '--title', title];
}

export interface OpencodeStream {
  /** The final answer: what the model said after its last tool call, or all it said when it used none. */
  text: string;
  error?: string;
  usage?: CallUsage;
  /** Model steps taken (one per `step_finish`): the turns. */
  steps: number;
  /** OpenCode's own price of the run; 0 for a model it has no price for, which is every knode model. */
  costUsd: number;
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);
const obj = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** An `error` event's message: OpenCode's named errors carry it in `data.message`. */
function errorText(error: unknown): string {
  const e = obj(error);
  const message = obj(e.data).message;
  if (typeof message === 'string' && message.trim()) return message.trim();
  if (typeof e.message === 'string' && e.message.trim()) return e.message.trim();
  return typeof e.name === 'string' && e.name ? e.name : 'unknown error';
}

/**
 * Read `opencode run --format json`. OpenCode counts a step's `input` without
 * the cache's reads and writes and its `output` without the reasoning, so
 * they are added back here to the way `CallUsage` counts (src/llm/usage.ts).
 * Narration before a tool call ("I'll search the base first") is dropped, as
 * for cursor: the answer is what came after the last tool call.
 */
export function readOpencodeStream(stdout: string): OpencodeStream {
  const chunks: string[] = [];
  const errors: string[] = [];
  const usage: CallUsage = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  let steps = 0;
  let costUsd = 0;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const part = obj(event.part);
    if (event.type === 'text') {
      if (part.synthetic === true || part.ignored === true) continue;
      const text = typeof part.text === 'string' ? part.text : '';
      if (text.trim()) chunks.push(text);
    } else if (event.type === 'tool_use') {
      chunks.length = 0;
    } else if (event.type === 'step_finish') {
      steps++;
      costUsd += num(part.cost);
      const tokens = obj(part.tokens);
      const cache = obj(tokens.cache);
      const read = num(cache.read);
      const written = num(cache.write);
      const reasoning = num(tokens.reasoning);
      usage.inputTokens += num(tokens.input) + read + written;
      usage.cachedInputTokens += read;
      usage.cacheWriteTokens += written;
      usage.outputTokens += num(tokens.output) + reasoning;
      usage.reasoningTokens += reasoning;
    } else if (event.type === 'error') {
      errors.push(errorText(event.error));
    }
  }
  const out: OpencodeStream = { text: chunks.join('\n').trim(), steps, costUsd };
  if (errors.length) out.error = errors.join('; ');
  if (usage.inputTokens > 0 || usage.outputTokens > 0) {
    if (costUsd > 0) usage.costUsd = costUsd;
    out.usage = usage;
  }
  return out;
}
