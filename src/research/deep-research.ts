import { LlmConnection, resolveSecret, ResearchWebConfig } from '../config.js';
import { guardedFetch } from './fetch.js';
import { abortSession, registerSession } from './launch.js';

/**
 * Deep-research mode: one long call to a model that researches on its own —
 * OpenAI's deep-research models (`o3-deep-research`, `o4-mini-deep-research`)
 * on the Responses API with its web search tool, run in the background and
 * polled; or any OpenAI-compatible endpoint whose chat model searches by
 * itself and returns its citations (Perplexity's `sonar-deep-research`
 * answers with `citations` / `search_results`).
 *
 * Such a model cannot reach knode's MCP endpoint, so in a study it only
 * *collects*: its report is kept as a source of its own, every URL it cites is
 * captured by knode (the bytes, not the model's paraphrase), and an agent that
 * can write pages turns the material into the study's pages.
 */

export interface DeepResearchInput {
  connection: Pick<LlmConnection, 'baseUrl' | 'apiKey' | 'protocol' | 'label' | 'id'>;
  model: string;
  prompt: string;
  web: ResearchWebConfig;
  /** Overall limit; deep research takes minutes to an hour. */
  timeoutMs: number;
  /** For cancellation: the session is registered under this job. */
  jobId: string;
  log?: (msg: string) => void;
  /** Poll interval (tests shorten it). */
  pollMs?: number;
}

export interface DeepResearchCitation {
  url: string;
  title: string | null;
}

export interface DeepResearchResult {
  text: string;
  citations: DeepResearchCitation[];
  model: string;
  /** 'responses' or 'chat'. */
  wire: string;
  responseId: string | null;
}

function trimBase(base: string): string {
  return base.trim().replace(/\/+$/, '');
}

function citationsFrom(list: unknown): DeepResearchCitation[] {
  const out: DeepResearchCitation[] = [];
  for (const c of Array.isArray(list) ? list : []) {
    const o = (typeof c === 'string' ? { url: c } : c) as Record<string, unknown>;
    const url = typeof o?.url === 'string' ? o.url : '';
    if (/^https?:\/\//i.test(url) && !out.some((x) => x.url === url)) out.push({ url, title: typeof o.title === 'string' ? o.title : null });
  }
  return out;
}

/** The text and url_citation annotations of a Responses API answer. */
export function readResponse(body: Record<string, unknown>): { text: string; citations: DeepResearchCitation[] } {
  const parts: string[] = [];
  const cites: DeepResearchCitation[] = [];
  for (const item of Array.isArray(body.output) ? body.output : []) {
    const o = item as Record<string, unknown>;
    if (o.type !== 'message') continue;
    for (const c of Array.isArray(o.content) ? o.content : []) {
      const cc = c as Record<string, unknown>;
      if (cc.type !== 'output_text' || typeof cc.text !== 'string') continue;
      parts.push(cc.text);
      for (const a of Array.isArray(cc.annotations) ? cc.annotations : []) {
        const aa = a as Record<string, unknown>;
        if (aa.type === 'url_citation' && typeof aa.url === 'string') cites.push({ url: aa.url, title: typeof aa.title === 'string' ? aa.title : null });
      }
    }
  }
  if (parts.length === 0 && typeof body.output_text === 'string') parts.push(body.output_text);
  return { text: parts.join('\n\n').trim(), citations: citationsFrom(cites) };
}

async function postJson(url: string, key: string, payload: unknown, web: ResearchWebConfig, timeoutMs: number): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  const res = await guardedFetch(url, web, {
    method: 'POST', trusted: true, allowErrorStatus: true, timeoutMs, maxBytes: 32 * 1024 * 1024, accept: 'application/json',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(payload),
  });
  const text = res.body.toString('utf8');
  try {
    return { status: res.status, json: JSON.parse(text) as Record<string, unknown>, text };
  } catch {
    return { status: res.status, json: null, text };
  }
}

async function getJson(url: string, key: string, web: ResearchWebConfig): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  const res = await guardedFetch(url, web, { trusted: true, allowErrorStatus: true, timeoutMs: 60_000, maxBytes: 32 * 1024 * 1024, accept: 'application/json', headers: key ? { Authorization: `Bearer ${key}` } : {} });
  const text = res.body.toString('utf8');
  try {
    return { status: res.status, json: JSON.parse(text) as Record<string, unknown>, text };
  } catch {
    return { status: res.status, json: null, text };
  }
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => {
    clearTimeout(t);
    reject(new Error('cancelled'));
  }, { once: true });
});

export async function runDeepResearch(input: DeepResearchInput): Promise<DeepResearchResult> {
  const base = trimBase(input.connection.baseUrl);
  if (!base) throw new Error(`connection ${input.connection.label || input.connection.id} has no base URL`);
  const key = resolveSecret(input.connection.apiKey ?? '');
  const log = input.log ?? (() => {});
  const controller = new AbortController();
  const unregister = registerSession(input.jobId, abortSession(controller));
  const deadline = Date.now() + input.timeoutMs;
  try {
    if (input.connection.protocol !== 'chat') {
      // the Responses API, in the background: a deep-research run outlives any one HTTP request
      const started = await postJson(`${base}/responses`, key, {
        model: input.model,
        input: input.prompt,
        tools: [{ type: 'web_search_preview' }],
        background: true,
        reasoning: { summary: 'auto' },
      }, input.web, 120_000);
      if (started.status < 400 && started.json) {
        let body = started.json;
        const id = typeof body.id === 'string' ? body.id : null;
        log(`deep research: ${input.model} started${id ? ` (${id})` : ''}`);
        while (id && (body.status === 'queued' || body.status === 'in_progress')) {
          if (Date.now() > deadline) {
            await postJson(`${base}/responses/${id}/cancel`, key, {}, input.web, 30_000).catch(() => null);
            throw new Error(`deep research did not finish within ${Math.round(input.timeoutMs / 60_000)} min`);
          }
          await sleep(input.pollMs ?? 15_000, controller.signal);
          const polled = await getJson(`${base}/responses/${id}`, key, input.web);
          if (polled.json) body = polled.json;
        }
        if (controller.signal.aborted) throw new Error('cancelled');
        if (body.status && body.status !== 'completed') {
          const why = (body.error as Record<string, unknown> | undefined)?.message ?? (body.incomplete_details as Record<string, unknown> | undefined)?.reason ?? body.status;
          throw new Error(`deep research ended ${String(body.status)}: ${String(why)}`);
        }
        const { text, citations } = readResponse(body);
        if (!text) throw new Error('deep research returned no report text');
        return { text, citations, model: typeof body.model === 'string' ? body.model : input.model, wire: 'responses', responseId: id };
      }
      // an endpoint without /responses (or this model on it): fall through to chat completions
      if (input.connection.protocol === 'responses') throw new Error(`/responses answered ${started.status}: ${started.text.slice(0, 300)}`);
      log(`deep research: /responses answered ${started.status} — trying chat completions`);
    }
    const remaining = Math.max(60_000, deadline - Date.now());
    const chat = await postJson(`${base}/chat/completions`, key, { model: input.model, messages: [{ role: 'user', content: input.prompt }] }, input.web, remaining);
    if (chat.status >= 400 || !chat.json) throw new Error(`chat completions answered ${chat.status}: ${chat.text.slice(0, 300)}`);
    const choice = (Array.isArray(chat.json.choices) ? chat.json.choices[0] : null) as Record<string, unknown> | null;
    const message = (choice?.message ?? {}) as Record<string, unknown>;
    const text = typeof message.content === 'string' ? message.content.trim() : '';
    if (!text) throw new Error('deep research returned no report text');
    // Perplexity: `citations` (URLs) and `search_results` ({ url, title }); others: annotations on the message
    const citations = citationsFrom([
      ...(Array.isArray(chat.json.search_results) ? chat.json.search_results : []),
      ...(Array.isArray(chat.json.citations) ? chat.json.citations : []),
      ...(Array.isArray(message.annotations) ? (message.annotations as Record<string, unknown>[]).map((a) => (a.url_citation ?? a) as Record<string, unknown>) : []),
    ]);
    return { text, citations, model: typeof chat.json.model === 'string' ? chat.json.model : input.model, wire: 'chat', responseId: typeof chat.json.id === 'string' ? chat.json.id : null };
  } finally {
    unregister();
  }
}
