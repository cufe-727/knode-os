import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface EmbeddingConfig {
  /**
   * 'openai'         = any OpenAI-compatible /v1/embeddings endpoint;
   * 'ark-multimodal' = Volcengine Ark's /embeddings/multimodal endpoint
   *                    (doubao-embedding-vision-*), which fuses one input into
   *                    a single vector and therefore embeds one text per call;
   * 'local'          = built-in hashing embedder (offline, no key needed).
   */
  provider: 'openai' | 'ark-multimodal' | 'local';
  baseUrl: string;
  /** Plain key, or "env:VAR_NAME" to read from the environment. */
  apiKey: string;
  model: string;
  dimensions: number;
  /** openai: texts per request. ark-multimodal: parallel single-text requests. */
  batchSize: number;
  /**
   * Send the `dimensions` request param (OpenAI text-embedding-3+, and Ark's
   * multimodal endpoint). Many OpenAI-compatible routers (litellm, Ollama, …)
   * reject unknown params — leave false unless your endpoint truncates via
   * `dimensions`. When false, `dimensions` must match the model's native
   * output size.
   */
  sendDimensions: boolean;
}

/**
 * Where the derived index lives.
 *
 * 'pglite' keeps the zero-setup default: an embedded Postgres per workspace
 * under `<workspace>/.knode/db`, nothing to install or run. 'postgres' points
 * the same schema at an external server — worth it once a workspace outgrows
 * PGlite's single-process 32-bit WASM build (roughly a million chunks), or when
 * several processes must read one index concurrently. There, all workspaces
 * share one database and are isolated by schema: a schema is free where a
 * database carries its own ~8 MB catalog, one pool serves every workspace, and
 * each schema keeps a private HNSW index (a shared table keyed by workspace
 * could not — HNSW walks a distance-ordered graph, so an equality predicate on
 * a scalar column cannot be pushed into the walk).
 */
export interface DatabaseConfig {
  kind: 'pglite' | 'postgres';
  host: string;
  port: number;
  user: string;
  /** Plain key, or "env:VAR_NAME". Empty when the server uses trust/peer auth. */
  password: string;
  /** The single database every workspace shares. Created on first open. */
  database: string;
  /** Schemas are named `<prefix>_<workspace slug>_<hash of the data dir>`. */
  schemaPrefix: string;
}

export type LlmProvider = 'openai' | 'codex-cli' | 'claude-cli' | 'cursor-cli';

export interface LlmConfig {
  /**
   * 'openai'     = any OpenAI-compatible /v1/chat/completions endpoint (needs baseUrl/apiKey);
   * 'codex-cli'  = shell out to the local `codex exec` CLI (reuses its login, no key);
   * 'claude-cli' = shell out to the local `claude -p` CLI (reuses its login, no key);
   * 'cursor-cli' = shell out to the local `cursor-agent -p` CLI (reuses its login, no key).
   */
  provider: LlmProvider;
  /** OpenAI-compatible endpoint. Ignored by CLI providers. */
  baseUrl: string;
  /** Ignored by CLI providers. */
  apiKey: string;
  /**
   * openai: empty model disables LLM features (graph falls back to heuristics).
   * CLI providers: empty = the CLI's own default model; otherwise passed as --model.
   */
  model: string;
  /** Override the CLI executable (path or name). Empty = provider default from PATH. */
  cliPath: string;
  /** Kill a CLI completion after this long. */
  cliTimeoutMs: number;
}

/** Per-job LLM routing. `inherit` keeps using the default `llm` connection. */
export interface RoutedLlmConfig extends Omit<LlmConfig, 'provider'> {
  /**
   * Legacy per-route provider. Kept so configs written before named
   * connections keep resolving; `loadConfig` migrates these into `use`.
   */
  provider: 'inherit' | LlmProvider;
  /**
   * Which connection runs this route: '' or 'default' for the default LLM
   * provider, otherwise an `LlmConnection.id`. `model` still overrides the
   * connection's own model, so one endpoint can serve several routes at
   * different price points.
   */
  use: string;
}

/**
 * A named LLM connection. Endpoint and credentials live here once; routes
 * point at one by id instead of repeating them.
 */
export interface LlmConnection extends LlmConfig {
  /** Stable key routes reference. Never reused for a different endpoint. */
  id: string;
  /** Shown in the UI. */
  label: string;
}

export interface ExtractionConfig {
  /** Daily LLM token budget shared by tier-1 extraction and tier-2 refinement. */
  dailyTokenBudget: number;
  /** Also extract time-bound claims (GraphRAG covariates) in the tier-1 call. */
  claims: boolean;
  /** Model for tier-1 entity/relation extraction. Empty = use llm.model. */
  tier1Model: string;
  /** Model for tier-2 community summaries / wiki pages. Empty = use llm.model. */
  tier2Model: string;
  /** Provider and model used for tier-1 entity / relation / claim extraction. */
  entityLlm: RoutedLlmConfig;
  /** Provider and model used for tier-2 concept synthesis / wiki refinement. */
  conceptLlm: RoutedLlmConfig;
  /** Vision-capable provider used to convert images and scanned PDF pages to Markdown. */
  documentLlm: RoutedLlmConfig;
  /** New documents get a priority boost that decays over this many days. */
  freshnessBoostDays: number;
  /** Static per-root priority weights for the extraction queue. */
  importance: Record<string, number>;
  /** How many queued documents one tier-1 pass may process. */
  batchSize: number;
  /** Parallel LLM extraction calls within one tier-1 pass. */
  concurrency: number;
  /** Minutes between background tier-1 queue passes while `serve` runs. */
  intervalMinutes: number;
}

export interface HeatConfig {
  /** Half-life (days) of the exponentially-decayed access score. */
  halfLifeDays: number;
  /** Minutes between flushing usage stats from the DB back to sidecars. */
  flushIntervalMinutes: number;
  /** RRF score multiplier: score *= 1 + searchWeight * heat. */
  searchWeight: number;
  /** Documents below this heat are treated as cold in wiki generation. */
  coldThreshold: number;
}

/** Query-time event expansion inspired by SAG (chunk = event in phase one). */
export interface SagSearchConfig {
  /** Number of direct hybrid hits used as event seeds. */
  seedChunks: number;
  /** Maximum entity nodes expanded at each hop. */
  entityFrontier: number;
  /** Per-entity cap when expanding back to event chunks. */
  maxEventsPerEntity: number;
  /** Maximum structurally discovered chunks sent to vector coarse ranking. */
  candidatePool: number;
  /** Number of chunk -> entity -> chunk expansion rounds. */
  maxHops: number;
  /** Reserved share of final results for the direct retrieval route. */
  directRatio: number;
}

export type DataSourceKind = 'mysql' | 'timescale' | 'duckdb' | 'http-json' | 'prometheus' | 'object';

/** How a request against a source is written. Only `sql` goes through the SQL guard. */
export type SourceDialect = 'sql' | 'http' | 'promql' | 'object';

/**
 * One declared HTTP endpoint. Endpoints are an allowlist, never a template an
 * agent can fill with an arbitrary URL: the connector refuses anything not
 * named here, so opening an HTTP source cannot become an open proxy.
 */
export interface HttpEndpointConfig {
  name: string;
  /** Path appended to the source's baseUrl; `{param}` placeholders are filled from the request. */
  path: string;
  description?: string;
  /** Query/path parameters this endpoint accepts. Anything else is rejected. */
  params?: { name: string; in?: 'query' | 'path'; type?: string; required?: boolean }[];
  /** Dotted path to the array of records inside the JSON response (e.g. "data.items"). */
  resultPath?: string;
  /** Documented result fields, used for the capability schema. */
  fields?: { name: string; type: string }[];
  /** Parameter whose values are graph entities (entity linking, same idea as entityColumns). */
  entityParams?: EntityColumnConfig[];
}

/** One declared Prometheus metric. */
export interface PrometheusMetricConfig {
  name: string;
  description?: string;
  /** Labels worth showing in the capability schema. */
  labels?: string[];
  /** Label whose values are graph entities (e.g. `service`, `instance`). */
  entityLabels?: EntityColumnConfig[];
}

/** A column whose values are graph entities (e.g. company names in a quotes table). */
export interface EntityColumnConfig {
  column: string;
  /** Entity type for sampled values (usually 'organization'). */
  entityType: string;
  /** Extra columns whose values become aliases of the entity (e.g. ticker symbol). */
  aliasColumns?: string[];
}

export interface DataSourceTableConfig {
  name: string;
  description?: string;
  entityColumns?: EntityColumnConfig[];
}

/**
 * An external live data source. Row data is never materialized into the
 * index — only schemas and entity↔table links are, so the graph can answer
 * "which tables contain company A" while the rows stay fresh at query time.
 */
export interface DataSourceConfig {
  id: string;
  kind: DataSourceKind;
  description?: string;
  /** mysql / timescale connection. Password supports the "env:VAR" convention. */
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  /** duckdb / object: directory of files (absolute, or relative to the data dir). */
  path?: string;
  /** http-json / prometheus: base URL of the service. */
  baseUrl?: string;
  /** http-json / prometheus: request headers; values support the "env:VAR" convention. */
  headers?: Record<string, string>;
  /** http-json: the endpoints this source exposes. Requests outside this list are refused. */
  endpoints?: HttpEndpointConfig[];
  /** prometheus: the metrics this source exposes. Empty = discover from the server. */
  metrics?: PrometheusMetricConfig[];
  /** object: file extensions to catalog (default: everything). */
  extensions?: string[];
  /** Typical staleness of this source's answers, e.g. "30s" — seeds capability freshness. */
  freshness?: string | number;
  /** Relative expense of one call against this source (planner utility). Default 1. */
  cost?: number;
  /** Tables to introspect + link. Empty = introspect all, link nothing. */
  tables?: DataSourceTableConfig[];
  /** Hard cap on rows returned by native queries against this source. */
  maxRows?: number;
  timeoutMs?: number;
}

export interface PackConfig {
  /** Max entities matched from one utterance. */
  maxEntities: number;
  /** Doc chunks per pack. */
  maxDocs: number;
  /** Claims per pack. */
  maxClaims: number;
  /** Live probe queries per pack (across all matched entities). */
  maxProbes: number;
  /** Rows kept per probe result. */
  probeRows: number;
  /** In-memory TTL for probe results (they are never persisted). */
  liveTtlSeconds: number;
  /** Without fresher news than this many days, the pack flags a freshness gap. */
  staleNewsDays: number;
}

export interface KnodeConfig {
  embedding: EmbeddingConfig;
  database: DatabaseConfig;
  /** The default connection every route inherits unless it names another. */
  llm: LlmConfig;
  /** Extra named connections routes can be pointed at. */
  connections: LlmConnection[];
  server: { port: number; host: string };
  ingest: { chunkSize: number; chunkOverlap: number; watch: boolean; concurrency?: number };
  extraction: ExtractionConfig;
  retrieval: { sag: SagSearchConfig };
  heat: HeatConfig;
  datasources: DataSourceConfig[];
  pack: PackConfig;
  trace: {
    /** Where Claude Code stores session transcripts. */
    claudeProjectsDir: string;
    /** Where Codex CLI stores session rollouts. */
    codexSessionsDir: string;
    /** Extra skill source dirs to mirror into raw/skills. */
    skillDirs: string[];
    syncIntervalMinutes: number;
    /**
     * Prepare synced transcripts as searchable episodes (Markdown in their sidecars).
     * Off by default: a machine with months of agent history would otherwise
     * turn one sync into thousands of embedding calls.
     */
    episodes?: boolean;
  };
  dream: {
    /** Local time "HH:MM" at which the nightly dream runs while `serve` is up. */
    schedule: string;
    lookbackDays: number;
    /** Max trace excerpt characters fed to the LLM per dream run. */
    maxContextChars: number;
  };
}

export const CONFIG_FILE = 'knode.config.json';

export function defaultConfig(): KnodeConfig {
  const home = os.homedir();
  return {
    embedding: {
      provider: 'local',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'env:OPENAI_API_KEY',
      model: 'text-embedding-3-small',
      dimensions: 384,
      batchSize: 32,
      sendDimensions: false,
    },
    database: {
      kind: 'pglite',
      host: '127.0.0.1',
      port: 5432,
      user: '',
      password: '',
      database: 'knode',
      schemaPrefix: 'ws',
    },
    llm: {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'env:OPENAI_API_KEY',
      model: '',
      cliPath: '',
      cliTimeoutMs: 300_000,
    },
    connections: [],
    server: { port: 9100, host: '127.0.0.1' },
    ingest: { chunkSize: 1200, chunkOverlap: 150, watch: true, concurrency: 4 },
    extraction: {
      dailyTokenBudget: 2_000_000,
      claims: true,
      tier1Model: '',
      tier2Model: '',
      entityLlm: defaultRoutedLlmConfig(),
      conceptLlm: defaultRoutedLlmConfig(),
      documentLlm: defaultRoutedLlmConfig(),
      freshnessBoostDays: 3,
      importance: { docs: 1.0, skills: 0.6 },
      batchSize: 8,
      concurrency: 1,
      intervalMinutes: 5,
    },
    retrieval: {
      sag: {
        seedChunks: 12,
        entityFrontier: 24,
        maxEventsPerEntity: 12,
        candidatePool: 120,
        maxHops: 2,
        directRatio: 0.5,
      },
    },
    heat: {
      halfLifeDays: 14,
      flushIntervalMinutes: 60,
      searchWeight: 0.1,
      coldThreshold: 0.05,
    },
    datasources: [],
    pack: {
      maxEntities: 4,
      maxDocs: 6,
      maxClaims: 12,
      maxProbes: 6,
      probeRows: 10,
      liveTtlSeconds: 30,
      staleNewsDays: 7,
    },
    trace: {
      claudeProjectsDir: path.join(home, '.claude', 'projects'),
      codexSessionsDir: path.join(home, '.codex', 'sessions'),
      skillDirs: [path.join(home, '.claude', 'skills'), path.join(home, '.codex', 'prompts')],
      syncIntervalMinutes: 10,
    },
    dream: { schedule: '03:00', lookbackDays: 7, maxContextChars: 60_000 },
  };
}

export function defaultRoutedLlmConfig(): RoutedLlmConfig {
  return {
    use: '',
    provider: 'inherit',
    baseUrl: '',
    apiKey: '',
    model: '',
    cliPath: '',
    cliTimeoutMs: 300_000,
  };
}

/**
 * Resolve a per-job route into a concrete client configuration.
 *
 * A route that names a connection takes that connection whole, with its own
 * `model` as an override. Anything else falls back to the pre-connections
 * behaviour: inherit the default provider, or use the fields the route carries
 * itself. An unknown id resolves to the default rather than failing a pipeline
 * pass — deleting a connection degrades a route, it does not break it.
 */
export function resolveRoutedLlmConfig(
  base: LlmConfig,
  route: RoutedLlmConfig,
  connections: LlmConnection[],
  legacyModel = '',
): LlmConfig {
  const connection = route.use && route.use !== 'default' ? connections.find((c) => c.id === route.use) : undefined;
  if (connection) {
    return {
      provider: connection.provider,
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
      model: route.model || connection.model,
      cliPath: connection.cliPath,
      cliTimeoutMs: route.cliTimeoutMs || connection.cliTimeoutMs,
    };
  }
  if (route.use) {
    return { ...base, model: route.model || legacyModel || base.model };
  }
  const provider = route.provider === 'inherit' ? base.provider : route.provider;
  const inheritedProvider = route.provider === 'inherit';
  return {
    provider,
    baseUrl: route.baseUrl || base.baseUrl,
    apiKey: route.apiKey || base.apiKey,
    model: route.model || legacyModel || (inheritedProvider ? base.model : ''),
    cliPath: route.cliPath || (provider === base.provider ? base.cliPath : ''),
    cliTimeoutMs: route.cliTimeoutMs || base.cliTimeoutMs,
  };
}

function deepMerge<T>(base: T, override: Partial<T>): T {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return (override as T) ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    const cur = out[k];
    if (cur && typeof cur === 'object' && !Array.isArray(cur) && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(cur, v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

export function loadConfig(dataDir: string): KnodeConfig {
  const file = path.join(dataDir, CONFIG_FILE);
  const base = defaultConfig();
  if (!fs.existsSync(file)) return base;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<KnodeConfig>;
  return migrateRouteConnections(deepMerge(base, raw));
}

const ROUTE_KEYS = ['entityLlm', 'conceptLlm', 'documentLlm'] as const;

/**
 * Lift pre-connections route overrides into named connections, in memory, so
 * everything downstream only has to understand `use`. A route whose resolved
 * endpoint matches the default just points at the default; the rest get a
 * connection each, deduplicated so routes sharing an endpoint share one. The
 * route keeps its own `model`, which stays an override on top.
 */
export function migrateRouteConnections(config: KnodeConfig): KnodeConfig {
  const connections = [...(config.connections ?? [])];
  for (const key of ROUTE_KEYS) {
    const route = config.extraction[key];
    if (!route || route.use || route.provider === 'inherit') continue;
    const resolved = resolveRoutedLlmConfig(config.llm, route, []);
    if (sameEndpoint(resolved, config.llm)) {
      config.extraction[key] = { ...route, use: 'default' };
      continue;
    }
    const existing = connections.find((c) => sameEndpoint(c, resolved));
    const connection = existing ?? {
      ...resolved,
      model: '',
      id: uniqueConnectionId(resolved.provider, connections),
      label: llmProviderLabel(resolved.provider),
    };
    if (!existing) connections.push(connection);
    config.extraction[key] = { ...route, use: connection.id };
  }
  return { ...config, connections };
}

function sameEndpoint(a: LlmConfig, b: LlmConfig): boolean {
  return a.provider === b.provider && a.baseUrl === b.baseUrl && a.apiKey === b.apiKey && a.cliPath === b.cliPath;
}

function uniqueConnectionId(provider: LlmProvider, connections: LlmConnection[]): string {
  for (let n = 1; ; n++) {
    const id = `${provider}-${n}`;
    if (!connections.some((c) => c.id === id)) return id;
  }
}

export function llmProviderLabel(provider: LlmProvider): string {
  switch (provider) {
    case 'openai': return 'OpenAI-compatible API';
    case 'codex-cli': return 'Codex CLI';
    case 'claude-cli': return 'Claude Code CLI';
    case 'cursor-cli': return 'Cursor Agent CLI';
    default: return provider;
  }
}

export function saveConfig(dataDir: string, config: KnodeConfig): void {
  const file = path.join(dataDir, CONFIG_FILE);
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
}

/** Resolve "env:VAR" indirection in API keys. */
export function resolveSecret(value: string): string {
  if (value.startsWith('env:')) return process.env[value.slice(4)] ?? '';
  return value;
}

/** Resolve the data directory from CLI flag > env > default ~/.knode-os. */
export function resolveDataDir(flag?: string): string {
  const dir = flag || process.env.KNODE_OS_DATA || path.join(os.homedir(), '.knode-os');
  return path.resolve(dir);
}

/** Redact secrets for API exposure. */
export function redactConfig(config: KnodeConfig): KnodeConfig {
  const clone = JSON.parse(JSON.stringify(config)) as KnodeConfig;
  const secretHolders = [clone.embedding, clone.llm, clone.extraction.entityLlm, clone.extraction.conceptLlm, clone.extraction.documentLlm, ...(clone.connections ?? [])];
  for (const c of secretHolders) {
    if (c.apiKey && !c.apiKey.startsWith('env:')) c.apiKey = '***';
  }
  for (const ds of clone.datasources ?? []) {
    if (ds.password && !ds.password.startsWith('env:')) ds.password = '***';
  }
  if (clone.database?.password && !clone.database.password.startsWith('env:')) clone.database.password = '***';
  return clone;
}
