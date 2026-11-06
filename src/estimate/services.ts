import { KnodeConfig, LlmConfig } from '../config.js';

/**
 * The services a model call is paid from (docs/design/18): a coding-agent
 * CLI's plan — Codex on a ChatGPT login, Claude Code on an Anthropic one,
 * Cursor's — or an API key's bill, and what each adds to a call.
 */

export type ServiceId = 'codex' | 'claude' | 'cursor' | 'api' | 'other';

export const SERVICE_LABELS: Record<ServiceId, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  cursor: 'Cursor',
  api: 'API',
  other: 'Other',
};

/** The service behind a config: the CLI it runs, or the endpoint it calls. */
export function serviceOfLlm(llm: Pick<LlmConfig, 'provider'>): ServiceId {
  if (llm.provider === 'codex-cli') return 'codex';
  if (llm.provider === 'claude-cli') return 'claude';
  if (llm.provider === 'cursor-cli') return 'cursor';
  // OpenCode has no plan of its own: it bills the key of the connection it runs on
  if (llm.provider === 'openai' || llm.provider === 'opencode-cli' || !llm.provider) return 'api';
  return 'other';
}

/**
 * The service behind a route's label: this machine's slots say
 * `codex-cli:gpt-6.1-sol`, a remote worker's `codex:gpt-6.1-sol` (or
 * `api:…`), an endpoint just its model, the deepagents loop `deepagents:…`.
 */
export function serviceOfLabel(label: string): ServiceId {
  // a sidecar records a remote worker's answers as `remote:codex:…`
  const head = label.replace(/^remote:/, '').split(':')[0];
  if (head === 'codex' || head === 'codex-cli') return 'codex';
  if (head === 'claude' || head === 'claude-cli') return 'claude';
  if (head === 'cursor' || head === 'cursor-cli') return 'cursor';
  if (head === 'command') return 'other';
  return 'api';
}

/** The model a label names, without its service: '' for a CLI's own default. */
export function modelOfLabel(label: string): string {
  const bare = label.replace(/^remote:/, '');
  const i = bare.indexOf(':');
  if (i < 0) return serviceOfLabel(bare) === 'api' ? bare : '';
  const model = bare.slice(i + 1);
  return model === 'default' || model === '?' ? '' : model;
}

/**
 * What a service adds to every call before any measured call of a route says
 * otherwise (src/estimate/ledger.ts):
 *
 * - `promptTokens` / `cachedTokens`: the CLI's own instructions and tools,
 *   sent with every prompt, mostly read back from the prompt cache. Codex
 *   0.161 read 15,428 input tokens (12,032 cached) and Cursor 2026.10.22 wrote
 *   15,144 to its cache for a one-word prompt (both measured 2026-10-28);
 *   Claude Code is assumed alike until a call is measured.
 * - `startupSeconds` / `tokensPerSecond`: how long a call takes, as starting
 *   the CLI and then writing at that rate.
 * - `bytesUp` / `bytesDown`: a one-shot call's traffic beyond the prompt and
 *   the answer. A Codex one-shot (plugins, apps and analytics off, the model
 *   catalog read from knode's copy) moved ↓58 KB ↑37 KB for a one-word
 *   prompt, Codex's own instructions and the answer's framing; before the
 *   copy it moved ↓1.2–1.7 MB (measured 2026-11-06 and 10-28).
 * - `catalogBytes`: what a call adds when it has no copy of Codex's model
 *   catalog (src/llm/codex-catalog.ts) and downloads it: the first calls of a
 *   day on a model, one per slot starting before the first has made the copy
 *   (that call moved ↓706 KB).
 * - `session`: an agent session's (a research run) instead: as it starts, and
 *   per model request beyond what the request sends (the conversation, costed
 *   per input token) and writes. A Codex research session with plugins, apps
 *   and analytics off and the copy moved ↓43 KB ↑41 KB for one request and
 *   ↓160 KB ↑111 KB for four: ↓20 KB ↑10 KB to start and ↓34 KB a request,
 *   the response events echoing Codex's instructions (2026-11-06). With them
 *   on, as research sessions ran until then, it downloaded the plugin catalog
 *   for as long as it ran (11–15 MB in 30 s) and uploaded 0.7–1.3 MB of
 *   analytics.
 *
 * Cursor's and Claude Code's are not measured, an HTTP call's are its headers.
 */
export interface ServiceProfile {
  promptTokens: number;
  cachedTokens: number;
  startupSeconds: number;
  tokensPerSecond: number;
  bytesUp: number;
  bytesDown: number;
  catalogBytes: number;
  session: { bytesUp: number; bytesDown: number; requestBytesDown: number };
  /** Whether the transfer figures were measured, or are a floor. */
  transferMeasured: boolean;
}

export const SERVICE_PROFILES: Record<ServiceId, ServiceProfile> = {
  codex: {
    promptTokens: 15_400, cachedTokens: 12_000, startupSeconds: 8, tokensPerSecond: 60,
    bytesUp: 37_000, bytesDown: 58_000, catalogBytes: 650_000,
    session: { bytesUp: 10_000, bytesDown: 20_000, requestBytesDown: 34_000 },
    transferMeasured: true,
  },
  cursor: {
    promptTokens: 15_150, cachedTokens: 15_000, startupSeconds: 6, tokensPerSecond: 70,
    bytesUp: 20_000, bytesDown: 50_000, catalogBytes: 0, session: { bytesUp: 20_000, bytesDown: 50_000, requestBytesDown: 0 }, transferMeasured: false,
  },
  claude: {
    promptTokens: 15_000, cachedTokens: 14_000, startupSeconds: 6, tokensPerSecond: 60,
    bytesUp: 20_000, bytesDown: 50_000, catalogBytes: 0, session: { bytesUp: 20_000, bytesDown: 50_000, requestBytesDown: 0 }, transferMeasured: false,
  },
  api: {
    promptTokens: 0, cachedTokens: 0, startupSeconds: 2, tokensPerSecond: 60,
    bytesUp: 2_000, bytesDown: 2_000, catalogBytes: 0, session: { bytesUp: 0, bytesDown: 0, requestBytesDown: 2_000 }, transferMeasured: true,
  },
  other: {
    promptTokens: 0, cachedTokens: 0, startupSeconds: 2, tokensPerSecond: 60,
    bytesUp: 2_000, bytesDown: 2_000, catalogBytes: 0, session: { bytesUp: 0, bytesDown: 0, requestBytesDown: 2_000 }, transferMeasured: false,
  },
};

/* -------------------------------- prices -------------------------------- */

/** US dollars per million tokens. `cacheWrite` defaults to `input` (OpenAI charges no more for it). */
export interface ModelPrice {
  input: number;
  cachedInput: number;
  cacheWrite?: number;
  output: number;
}

/**
 * Published API prices, matched by prefix on the model name (longest first).
 * Anthropic's from its model table of 2026-10-06; OpenAI's from its 2025
 * price list, and gpt-6.1-sol's (standard tier, prompts up to 272K tokens,
 * a 30-minute cache write) from its pricing page of 2026-11-06. A model not
 * here — most Codex and Cursor models of late 2026 among them — has no price
 * until `usage.prices` gives one, and an estimate says so instead of guessing.
 */
const PRICES: Record<string, ModelPrice> = {
  'gpt-6.1-sol': { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 },
  'claude-fable-5-1': { input: 10, cachedInput: 0.25, cacheWrite: 12.5, output: 50 },
  'claude-fable-5': { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 },
  'claude-opus-5-5': { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 },
  'claude-opus-5': { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
  'claude-opus-4': { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
  'claude-sonnet-5-5': { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
  'claude-sonnet-5': { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
  'claude-sonnet-4': { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 },
  'claude-haiku-5-5': { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
  'claude-haiku-4-5': { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 },
  'gpt-4.1-nano': { input: 0.1, cachedInput: 0.025, output: 0.4 },
  'gpt-4.1-mini': { input: 0.4, cachedInput: 0.1, output: 1.6 },
  'gpt-4.1': { input: 2, cachedInput: 0.5, output: 8 },
  'gpt-4o-mini': { input: 0.15, cachedInput: 0.075, output: 0.6 },
  'gpt-4o': { input: 2.5, cachedInput: 1.25, output: 10 },
  'gpt-5-nano': { input: 0.05, cachedInput: 0.005, output: 0.4 },
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2 },
  'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10 },
  'o4-mini': { input: 1.1, cachedInput: 0.275, output: 4.4 },
  'o3': { input: 2, cachedInput: 0.5, output: 8 },
};

/** Claude Code's aliases, as the CLI resolves them now. */
const ALIASES: Record<string, string> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
  fable: 'claude-fable-5-1',
};

/**
 * The price of a model: `usage.prices` first (exact name, or a prefix ending
 * in `*`), then the table above by prefix. A Cursor or Claude Code model name
 * may carry options in brackets (`claude-opus-4-8[effort=high]`), which do
 * not change its price.
 */
export function priceOf(model: string, config?: Pick<KnodeConfig, 'usage'>): { price: ModelPrice; source: 'config' | 'published' } | null {
  const name = (ALIASES[model.trim().toLowerCase()] ?? model).trim().toLowerCase().replace(/\[.*\]$/, '');
  if (!name) return null;
  const own = config?.usage?.prices ?? {};
  for (const [key, price] of Object.entries(own)) {
    const k = key.trim().toLowerCase();
    const match = k.endsWith('*') ? name.startsWith(k.slice(0, -1)) : name === k;
    if (match && validPrice(price)) return { price, source: 'config' };
  }
  // `gpt-5-codex` is priced as `gpt-5`, but a new minor version (`gpt-5.2`) need not be
  const key = Object.keys(PRICES).filter((k) => name === k || name.startsWith(`${k}-`)).sort((a, b) => b.length - a.length)[0];
  return key ? { price: PRICES[key], source: 'published' } : null;
}

function validPrice(p: unknown): p is ModelPrice {
  const v = p as ModelPrice;
  return Boolean(v) && [v.input, v.cachedInput, v.output].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
}

/** What some tokens cost at a price: fresh input, cache reads, cache writes and output each at theirs. */
export function costOf(price: ModelPrice, t: { input: number; cached: number; cacheWrite?: number; output: number }): number {
  const written = t.cacheWrite ?? 0;
  const fresh = Math.max(0, t.input - t.cached - written);
  return (fresh * price.input + t.cached * price.cachedInput + written * (price.cacheWrite ?? price.input) + t.output * price.output) / 1e6;
}

/* ------------------------------ allowances ------------------------------ */

/**
 * What Cursor's plans include each month, in usage at API prices — its
 * published plans as of mid-2025; `usage.allowances.cursor.monthlyUsd` says
 * otherwise for an account whose plan differs.
 */
const CURSOR_PLANS: Record<string, number> = { pro: 20, 'pro+': 70, ultra: 400 };

export interface Allowance {
  window: 'monthly' | 'weekly' | '5h';
  usd: number;
  source: 'config' | 'published';
}

/** The allowances a service's plan gives, in API-priced dollars, for a service that does not report its own use. */
export function allowancesOf(service: ServiceId, config: Pick<KnodeConfig, 'usage'>, plan: string | null): Allowance[] {
  const set = config.usage?.allowances;
  const out: Allowance[] = [];
  const add = (window: Allowance['window'], usd: unknown, source: Allowance['source']) => {
    if (typeof usd === 'number' && Number.isFinite(usd) && usd > 0) out.push({ window, usd, source });
  };
  if (service === 'cursor') {
    if (set?.cursor?.monthlyUsd) add('monthly', set.cursor.monthlyUsd, 'config');
    else if (plan) add('monthly', CURSOR_PLANS[plan.trim().toLowerCase()], 'published');
  } else if (service === 'claude') {
    add('5h', set?.claude?.fiveHourUsd, 'config');
    add('weekly', set?.claude?.weeklyUsd, 'config');
  }
  return out;
}
