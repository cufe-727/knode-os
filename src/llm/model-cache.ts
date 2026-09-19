import { createHash } from 'node:crypto';
import { EmbeddingConfig, KnodeConfig, LlmConfig, resolveSecret } from '../config.js';
import { cliToolStatus, listChatModels, listEmbeddingModels, ModelListResult } from './models.js';

/**
 * How often knode asks a provider what models it has.
 *
 * `models.ts` answers "what does this endpoint offer"; this answers "how often
 * is it worth asking". Without it the settings screen paid the full cost on
 * every dropdown: an OpenAI-compatible endpoint is a 20-second-ceiling round
 * trip, and `cursor-agent --list-models` / `claude --help` fork a subprocess
 * with a 60-second ceiling — once per field, and the screen has eight of them.
 *
 * The key is the resolved endpoint, not the route that asked. Several stages
 * pointing at one connection therefore share one answer, and editing an
 * endpoint is automatically a different key — which is why nothing has to
 * invalidate this cache on save. The only explicit bust is `refresh`.
 */

export interface CachedModelList extends ModelListResult {
  /** True when this answer came from the cache rather than the provider. */
  cached: boolean;
  /** When the underlying list was fetched. */
  cachedAt: string;
}

/** A vendor's catalog moves on the order of weeks. */
const TTL_API_MS = 5 * 60_000;
/** Only changes when the CLI is upgraded, and a miss costs a subprocess. */
const TTL_CLI_MS = 10 * 60_000;
/** Read off a config file or help text; cheap to redo, and a person editing it expects to see it. */
const TTL_BUILTIN_MS = 60_000;
/**
 * How long a failure is remembered, at least. A corrected key should take
 * effect quickly, so this is short — but see `ttlFor`: a failure that took a
 * long time to arrive is remembered for longer, because re-incurring a
 * 60-second CLI timeout every fifteen seconds is worse than the stale answer.
 */
const TTL_ERROR_MS = 15_000;
/** The ceiling on that back-off, so nothing stays broken for long. */
const TTL_ERROR_MAX_MS = 3 * 60_000;
/** PATH is probed per CLI; the desktop app augments it after launch. */
const TTL_PATH_MS = 30_000;
/**
 * A person typing in a Base URL field mints a new key per keystroke, so the
 * map is bounded and evicts the oldest entry rather than growing without end.
 */
const MAX_ENTRIES = 64;

interface Entry {
  result: ModelListResult;
  fetchedAt: number;
  expires: number;
}

const entries = new Map<string, Entry>();
/** Two dropdowns opening at once share one upstream call. */
const inFlight = new Map<string, Promise<ModelListResult>>();

/**
 * What makes two configurations the same endpoint. The key is hashed so a
 * resolved API key can never surface in a log or a debug dump, and the secret
 * is resolved first so two rows both saying `env:OPENAI_API_KEY` share one
 * entry — and so rotating that variable busts it.
 */
function endpointKey(kind: 'chat' | 'embedding', cfg: LlmConfig | EmbeddingConfig): string {
  const cliPath = 'cliPath' in cfg ? cfg.cliPath : '';
  const parts = [kind, cfg.provider, cfg.baseUrl.replace(/\/+$/, ''), resolveSecret(cfg.apiKey), cliPath];
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
}

function ttlFor(result: ModelListResult, elapsedMs: number): number {
  // Back off in proportion to what the failure cost: an instantly-rejected URL
  // can be retried at once, a CLI that hit its 60-second ceiling should not be.
  if (!result.ok) return Math.min(TTL_ERROR_MAX_MS, Math.max(TTL_ERROR_MS, elapsedMs * 3));
  switch (result.source) {
    case 'api': return TTL_API_MS;
    case 'cli': return TTL_CLI_MS;
    default: return TTL_BUILTIN_MS;
  }
}

function remember(key: string, result: ModelListResult, elapsedMs: number): Entry {
  const entry: Entry = { result, fetchedAt: Date.now(), expires: Date.now() + ttlFor(result, elapsedMs) };
  entries.set(key, entry);
  if (entries.size > MAX_ENTRIES) {
    const oldest = [...entries.entries()].reduce((a, b) => (a[1].fetchedAt <= b[1].fetchedAt ? a : b));
    entries.delete(oldest[0]);
  }
  return entry;
}

/**
 * One entry point for both kinds, because the cache does not care which it is
 * beyond the key and which lister to call. The union is narrowed at the one
 * call below rather than through overloads, which cannot express "the config
 * matches the kind" without a cast anyway.
 */
export async function listModelsCached(
  kind: 'chat' | 'embedding',
  cfg: LlmConfig | EmbeddingConfig,
  opts: { refresh?: boolean } = {},
): Promise<CachedModelList> {
  const key = endpointKey(kind, cfg);
  const hit = entries.get(key);
  if (!opts.refresh && hit && hit.expires > Date.now()) {
    return { ...hit.result, cached: true, cachedAt: new Date(hit.fetchedAt).toISOString() };
  }

  const startedAt = Date.now();
  let pending = opts.refresh ? undefined : inFlight.get(key);
  if (!pending) {
    pending = (kind === 'chat'
      ? listChatModels(cfg as LlmConfig)
      : listEmbeddingModels(cfg as EmbeddingConfig)
    ).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  const entry = remember(key, await pending, Date.now() - startedAt);
  return { ...entry.result, cached: false, cachedAt: new Date(entry.fetchedAt).toISOString() };
}

let paths: { at: number; tools: ReturnType<typeof cliToolStatus> } | null = null;

/** PATH resolution, cached: `cliToolStatus` walks $PATH once per CLI, per call. */
export function cachedCliToolStatus(opts: { refresh?: boolean } = {}): ReturnType<typeof cliToolStatus> {
  if (!opts.refresh && paths && Date.now() - paths.at < TTL_PATH_MS) return paths.tools;
  paths = { at: Date.now(), tools: cliToolStatus() };
  return paths.tools;
}

/**
 * Warm what a settings screen is about to ask for, off the critical path.
 *
 * Deliberately only the endpoints that answer over the network: warming the
 * CLIs would fork three subprocesses every time someone opens Settings, which
 * costs more than the one slow dropdown it would save.
 */
export function warmModelCache(config: KnodeConfig): void {
  const chat = [config.llm, ...(config.connections ?? [])].filter((c) => c.provider === 'openai');
  const embedding = (config.embeddingProviders ?? []).filter((e) => e.provider !== 'local');
  for (const cfg of chat) void listModelsCached('chat', cfg).catch(() => {});
  for (const cfg of embedding) void listModelsCached('embedding', cfg).catch(() => {});
  cachedCliToolStatus();
}

/** Tests, and anything that needs a clean slate. */
export function clearModelCache(): void {
  entries.clear();
  inFlight.clear();
  paths = null;
}
