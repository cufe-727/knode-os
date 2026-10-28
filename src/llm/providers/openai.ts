import fs from 'node:fs';
import path from 'node:path';
import { LlmConfig, LlmProtocol, resolveSecret } from '../../config.js';
import type { LlmBackend, LlmProviderPlugin } from '../../plugins/types.js';
import type { ChatMessage, CompletionOptions, ImageAttachment } from '../client.js';
import { demoteToChat, negotiateProtocol } from '../protocol.js';
import { usageFromOpenAi } from '../usage.js';

/**
 * The built-in `openai` provider: a minimal client for any OpenAI-compatible
 * endpoint (OpenAI, Azure, Ollama, vLLM, SiliconFlow, a relay, …), speaking
 * either the Responses API or Chat Completions as `protocol` says — or, with
 * `loop: 'deepagents'`, the deepagents loop on that endpoint, the way a
 * pipeline stage runs a deepagents agent (see `routeTargets`).
 */
export class OpenAiCompatibleBackend implements LlmBackend {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  readonly model: string;

  constructor(private readonly cfg: LlmConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.apiKey = resolveSecret(cfg.apiKey);
    this.model = cfg.model;
  }

  /** An empty model turns the general LLM features off; the deterministic pipeline keeps running. */
  get enabled(): boolean {
    return Boolean(this.model);
  }

  /** "gpt-4.1-mini", or "deepagents:gpt-4.1-mini" when the loop runs on it. */
  get label(): string {
    return this.cfg.loop ? `${this.cfg.loop}:${this.model}` : this.model;
  }

  get protocol(): LlmProtocol {
    return this.cfg.protocol ?? 'auto';
  }

  async complete(messages: ChatMessage[], opts: CompletionOptions = {}): Promise<string> {
    if (this.cfg.loop === 'deepagents') {
      // loaded on first use, as a built-in session does (see `loadBuiltin`):
      // an install that never runs the loop never pays for LangChain
      const { completeViaDeepagents } = await import('../../research/deepagents.js');
      return completeViaDeepagents(this.cfg, messages, { json: opts.json, model: opts.model, images: opts.images });
    }
    const model = opts.model || this.model;
    const wire = await negotiateProtocol({ baseUrl: this.baseUrl, apiKey: this.apiKey, model }, this.protocol);
    if (wire === 'responses') {
      const text = await this.viaResponses(messages, opts, model);
      // null means the route was there at probe time and is not there now;
      // remember that before falling back, so the next call pays no round-trip
      if (text !== null) return text;
      demoteToChat(this.baseUrl);
    }
    return this.viaChatCompletions(messages, opts, model);
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  /** The Responses wire. `null` = no such route here; the caller falls back. */
  private async viaResponses(messages: ChatMessage[], opts: CompletionOptions, model: string): Promise<string | null> {
    const request = JSON.stringify({
      model,
      input: withResponsesImages(messages, opts.images ?? []),
      temperature: 0.2,
      ...(opts.maxTokens ? { max_output_tokens: opts.maxTokens + REASONING_ALLOWANCE } : {}),
      ...(opts.json ? { text: { format: { type: 'json_object' } } } : {}),
    });
    const res = await fetch(`${this.baseUrl}/responses`, { method: 'POST', headers: this.headers(), body: request });
    if (ROUTE_MISSING.has(res.status)) {
      await res.text().catch(() => '');
      // a pinned wire reports the missing route instead of quietly changing wires
      if (this.protocol === 'responses') throw new Error(`responses request failed (${res.status}): no /responses route at ${this.baseUrl}`);
      return null;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`responses request failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const body = await res.text();
    const json = JSON.parse(body) as unknown;
    reportUsage(opts, json, request, body);
    return textFromResponses(json);
  }

  /** The Chat Completions wire: what most "OpenAI-compatible" endpoints mean. */
  private async viaChatCompletions(messages: ChatMessage[], opts: CompletionOptions, model: string): Promise<string> {
    const request = JSON.stringify({
      model,
      messages: withOpenAiImages(messages, opts.images ?? []),
      temperature: 0.2,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    });
    const res = await fetch(`${this.baseUrl}/chat/completions`, { method: 'POST', headers: this.headers(), body: request });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`chat request failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const body = await res.text();
    const json = JSON.parse(body) as { choices: { message: { content: string } }[] };
    reportUsage(opts, json, request, body);
    return json.choices[0]?.message?.content ?? '';
  }
}

/** Tell the caller what a call used: the endpoint's own count, and the bodies that went each way. */
function reportUsage(opts: CompletionOptions, json: unknown, request: string, response: string): void {
  if (!opts.onUsage) return;
  const usage = usageFromOpenAi(json);
  if (usage) opts.onUsage({ ...usage, bytesUp: Buffer.byteLength(request), bytesDown: Buffer.byteLength(response) });
}

export function openAiProvider(): LlmProviderPlugin {
  return {
    id: 'openai',
    label: 'OpenAI-compatible API',
    kind: 'api',
    fields: ['baseUrl', 'apiKey', 'protocol', 'model'],
    note: 'Any OpenAI-compatible endpoint. `protocol` picks the Responses API or Chat Completions; `auto` probes once and prefers Responses.',
    create: (cfg) => new OpenAiCompatibleBackend(cfg),
  };
}

/** Statuses that mean "this endpoint has no such route", as opposed to "your request was wrong". */
const ROUTE_MISSING = new Set([404, 405, 501]);

/**
 * Chat Completions' `max_tokens` bounds the visible answer; Responses'
 * `max_output_tokens` bounds the reasoning *and* the visible answer. Handing a
 * caller's budget straight to the second would let a reasoning model spend all
 * of it thinking and return an empty string — the connection ping asks for 8
 * tokens. So the Responses wire carries the caller's budget plus an allowance
 * for thinking the caller never had to account for.
 */
const REASONING_ALLOWANCE = 2048;

/**
 * The assistant's text from a Responses payload.
 *
 * `output` is a list of items, not a single message: reasoning models put their
 * thinking in a `reasoning` item that must not be mistaken for the answer. The
 * convenience `output_text` field is an SDK nicety that many relays omit, so it
 * is used when present and reconstructed when not.
 */
function textFromResponses(payload: unknown): string {
  const body = payload as { output_text?: unknown; output?: unknown[] };
  if (typeof body?.output_text === 'string') return body.output_text;
  const parts: string[] = [];
  for (const item of Array.isArray(body?.output) ? body.output : []) {
    const entry = item as { type?: string; content?: unknown[] };
    if (entry?.type !== 'message') continue;
    for (const part of Array.isArray(entry.content) ? entry.content : []) {
      const piece = part as { type?: string; text?: unknown };
      if (piece?.type === 'output_text' && typeof piece.text === 'string') parts.push(piece.text);
    }
  }
  return parts.join('');
}

/**
 * Messages as Responses input. Plain text rides as a string; an image turns the
 * last user message into the API's own parts, which are spelled `input_text` /
 * `input_image` rather than Chat Completions' `text` / `image_url`.
 */
function withResponsesImages(messages: ChatMessage[], images: ImageAttachment[]): unknown[] {
  const plain = messages.map((message) => ({ role: message.role, content: message.content }));
  if (images.length === 0) return plain;
  const lastUser = lastUserIndex(messages);
  if (lastUser < 0) throw new Error('image completion requires a user message');
  return plain.map((message, index) => {
    if (index !== lastUser) return message;
    return {
      role: message.role,
      content: [
        { type: 'input_text', text: message.content },
        ...images.map((image) => ({ type: 'input_image', image_url: dataUrlFor(image) })),
      ],
    };
  });
}

/** The data URL an image travels as; both wires inline rather than upload. */
function dataUrlFor(image: ImageAttachment): string {
  return `data:${image.mimeType || mimeForImage(image.path)};base64,${fs.readFileSync(image.path).toString('base64')}`;
}

function lastUserIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'user') return index;
  }
  return -1;
}

/** Chat Completions messages with the images attached to the last user turn. Shared with the deepagents loop. */
export function withOpenAiImages(messages: ChatMessage[], images: ImageAttachment[]): unknown[] {
  if (images.length === 0) return messages;
  const lastUser = lastUserIndex(messages);
  if (lastUser < 0) throw new Error('image completion requires a user message');
  return messages.map((message, index) => {
    if (index !== lastUser) return message;
    return {
      ...message,
      content: [
        { type: 'text', text: message.content },
        ...images.map((image) => ({ type: 'image_url', image_url: { url: dataUrlFor(image) } })),
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
