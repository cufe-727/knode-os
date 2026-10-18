import { LlmConfig, LlmProtocol } from '../config.js';
import { pluginRegistry } from '../plugins/registry.js';
import type { LlmBackend } from '../plugins/types.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ImageAttachment {
  path: string;
  mimeType?: string;
}

export interface CompletionOptions {
  json?: boolean;
  maxTokens?: number;
  model?: string;
  images?: ImageAttachment[];
}

/**
 * Chat client used by all LLM features (entity extraction, ask, wiki
 * summaries, dream analysis). The provider named by the config is looked up
 * in the plugin registry (src/plugins): built in are
 * - 'openai': any OpenAI-compatible HTTP endpoint, or — with `loop:
 *   'deepagents'` — the deepagents loop on that endpoint;
 * - 'codex-cli' / 'claude-cli' / 'cursor-cli': one turn of a local agent CLI;
 * - 'command': any executable, JSON request on stdin, reply on stdout;
 * and a plugin may add its own (docs/design/11).
 *
 * LLM features are optional — when a client is not enabled, callers fall back
 * to heuristics. A provider nobody registered is a disabled client too, with
 * an error that names the provider when something does try to call it:
 * a workspace whose plugin went missing degrades, it does not crash on open.
 */
export class LlmClient {
  private readonly cfg: LlmConfig;
  private readonly backend: LlmBackend | null;
  readonly model: string;

  constructor(cfg: LlmConfig) {
    this.cfg = cfg;
    this.model = cfg.model;
    const plugin = pluginRegistry().llmProvider(this.provider);
    this.backend = plugin ? plugin.create(cfg) : null;
  }

  get provider(): string {
    return this.cfg.provider || 'openai';
  }

  /** CLI providers work without an explicit model (the CLI's default is used); an unknown provider never does. */
  get enabled(): boolean {
    return this.backend?.enabled ?? false;
  }

  /** Display identity, e.g. "gpt-4.1-mini", "deepagents:gpt-4.1-mini", "codex-cli" or "claude-cli:opus". */
  get label(): string {
    return this.backend?.label ?? this.provider;
  }

  /** Which wire an OpenAI-compatible endpoint is spoken on. Absent config prefers Responses. */
  get protocol(): LlmProtocol {
    return this.cfg.protocol ?? 'auto';
  }

  async complete(messages: ChatMessage[], opts: CompletionOptions = {}): Promise<string> {
    if (!this.backend) {
      const known = pluginRegistry().llmProviders().map((p) => p.id).join(', ');
      throw new Error(`unknown LLM provider "${this.provider}" (registered: ${known}) — a plugin that provides it must be listed under "plugins" in knode.config.json`);
    }
    if (!this.backend.enabled) throw new Error('LLM is not configured (set llm.model in knode.config.json)');
    return this.backend.complete(messages, opts);
  }

  /** Complete and parse a JSON object, tolerating markdown code fences. */
  async completeJson<T>(messages: ChatMessage[], opts: { maxTokens?: number; model?: string } = {}): Promise<T> {
    return jsonFromReply<T>(await this.complete(messages, { json: true, ...opts }));
  }
}

/**
 * The JSON object in a model's reply: code fences stripped, anything before
 * the first `{` or after the last `}` dropped. Throws when no object parses —
 * shared by `completeJson` and the labeling workers, which hand back the raw
 * reply a remote machine got.
 */
export function jsonFromReply<T = unknown>(raw: string): T {
  const stripped = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  const body = start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped;
  return JSON.parse(body) as T;
}

export { withOpenAiImages } from './providers/openai.js';
