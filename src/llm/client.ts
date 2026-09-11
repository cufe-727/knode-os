import { LlmConfig, LlmProvider, resolveSecret } from '../config.js';
import { completeViaCli } from './cli.js';
import fs from 'node:fs';
import path from 'node:path';

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
 * summaries, dream analysis). Providers:
 * - 'openai': minimal OpenAI-compatible HTTP client
 * - 'codex-cli' / 'claude-cli' / 'cursor-cli': shell out to a local agent CLI
 * LLM features are optional — when not enabled, callers fall back to
 * heuristics.
 */
export class LlmClient {
  private readonly cfg: LlmConfig;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  readonly model: string;

  constructor(cfg: LlmConfig) {
    this.cfg = cfg;
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.apiKey = resolveSecret(cfg.apiKey);
    this.model = cfg.model;
  }

  get provider(): LlmProvider {
    return this.cfg.provider ?? 'openai';
  }

  /** CLI providers work without an explicit model (the CLI's default is used). */
  get enabled(): boolean {
    return this.provider === 'openai' ? Boolean(this.model) : true;
  }

  /** Display identity, e.g. "gpt-4.1-mini", "codex-cli" or "claude-cli:opus". */
  get label(): string {
    if (this.provider === 'openai') return this.model;
    return this.model ? `${this.provider}:${this.model}` : this.provider;
  }

  async complete(messages: ChatMessage[], opts: CompletionOptions = {}): Promise<string> {
    if (!this.enabled) throw new Error('LLM is not configured (set llm.model in knode.config.json)');
    if (this.provider !== 'openai') {
      // maxTokens is not controllable through the CLIs; the prompts already bound output size
      return completeViaCli(this.cfg, messages, { json: opts.json, model: opts.model, images: opts.images?.map((image) => image.path) });
    }
    const requestMessages = withOpenAiImages(messages, opts.images ?? []);
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: opts.model || this.model,
        messages: requestMessages,
        temperature: 0.2,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`chat request failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    return json.choices[0]?.message?.content ?? '';
  }

  /** Complete and parse a JSON object, tolerating markdown code fences. */
  async completeJson<T>(messages: ChatMessage[], opts: { maxTokens?: number; model?: string } = {}): Promise<T> {
    const raw = await this.complete(messages, { json: true, ...opts });
    const stripped = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    const body = start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped;
    return JSON.parse(body) as T;
  }
}

function withOpenAiImages(messages: ChatMessage[], images: ImageAttachment[]): unknown[] {
  if (images.length === 0) return messages;
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'user') {
      lastUser = index;
      break;
    }
  }
  if (lastUser < 0) throw new Error('image completion requires a user message');
  return messages.map((message, index) => {
    if (index !== lastUser) return message;
    return {
      ...message,
      content: [
        { type: 'text', text: message.content },
        ...images.map((image) => ({
          type: 'image_url',
          image_url: { url: `data:${image.mimeType || mimeForImage(image.path)};base64,${fs.readFileSync(image.path).toString('base64')}` },
        })),
      ],
    };
  });
}

function mimeForImage(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const mime: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  const found = mime[ext];
  if (!found) throw new Error(`unsupported image type for vision request: ${ext || '(none)'}`);
  return found;
}
