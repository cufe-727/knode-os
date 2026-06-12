import { LlmConfig, resolveSecret } from '../config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Minimal OpenAI-compatible chat client. LLM features (entity extraction,
 * source summaries, dream analysis) are optional — when no model is
 * configured, callers fall back to heuristics.
 */
export class LlmClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  readonly model: string;

  constructor(cfg: LlmConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.apiKey = resolveSecret(cfg.apiKey);
    this.model = cfg.model;
  }

  get enabled(): boolean {
    return Boolean(this.model);
  }

  async complete(messages: ChatMessage[], opts: { json?: boolean; maxTokens?: number } = {}): Promise<string> {
    if (!this.enabled) throw new Error('LLM is not configured (set llm.model in knode.config.json)');
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        messages,
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
  async completeJson<T>(messages: ChatMessage[], opts: { maxTokens?: number } = {}): Promise<T> {
    const raw = await this.complete(messages, { json: true, ...opts });
    const stripped = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    const body = start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped;
    return JSON.parse(body) as T;
  }
}
