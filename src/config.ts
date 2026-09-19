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
 * One named embedding provider. Structurally the mirror of `LlmConnection`:
 * the endpoint lives here once, and `embedding.use` points at it.
 *
 * Only one can be active at a time. Vectors are comparable only within one
 * model, and the embeddings table has a single column width per workspace, so
 * switching re-embeds the corpus rather than letting two sets coexist.
 */
export interface EmbeddingConnection extends EmbeddingConfig {
  /** Stable key `embedding.use` references. Never reused for a different endpoint. */
  id: string;
  label: string;
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

/**
 * Reasoning effort a CLI provider runs at. `default` leaves the CLI's own
 * setting alone; everything else is passed through (see `effortFor` for the
 * one CLI that cannot take the whole ladder). Research profiles read the same
 * list as `EFFORTS`, so a level means one thing everywhere.
 */
export const LLM_EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type LlmEffort = (typeof LLM_EFFORTS)[number];

/**
 * Which wire an OpenAI-compatible endpoint is spoken to on.
 *
 * 'auto'      = prefer `/responses`, fall back to `/chat/completions` when the
 *               endpoint has no such route. Reasoning models return their
 *               thinking as a first-class output item on the Responses API and
 *               as a non-standard `message.reasoning_content` on Chat
 *               Completions, so preferring Responses loses less.
 * 'responses' = pin the Responses API; a missing route is an error, not a
 *               silent downgrade.
 * 'chat'      = pin Chat Completions, for an endpoint that answers `/responses`
 *               with a lossy shim, or to skip the one-request probe.
 *
 * CLI providers ignore it: they are processes, not endpoints.
 */
export const LLM_PROTOCOLS = ['auto', 'responses', 'chat'] as const;
export type LlmProtocol = (typeof LLM_PROTOCOLS)[number];

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
   * Which wire to speak to an OpenAI-compatible endpoint on. Absent = 'auto'.
   * Ignored by CLI providers.
   */
  protocol?: LlmProtocol;
  /**
   * openai: empty model disables LLM features (graph falls back to heuristics).
   * CLI providers: empty = the CLI's own default model; otherwise passed as --model.
   */
  model: string;
  /** Override the CLI executable (path or name). Empty = provider default from PATH. */
  cliPath: string;
  /**
   * How hard a CLI provider thinks: claude `--effort`, codex
   * `model_reasoning_effort`, cursor `model[effort=…]`. Absent or 'default'
   * leaves the CLI's own setting alone. OpenAI-compatible endpoints ignore it.
   */
  effort?: LlmEffort;
  /** Kill a CLI completion after this long. */
  cliTimeoutMs: number;
  /** Shown in the UI. Empty = llmProviderLabel(provider). */
  label?: string;
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

export interface IngestConfig {
  chunkSize: number;
  chunkOverlap: number;
  /** Re-sync automatically when files under the data dir change. */
  watch: boolean;
  /** Parallel documents in flight during the index pass; embedding round-trips dominate. */
  concurrency?: number;
  /**
   * Parallel document conversions in the prepare pass. Each conversion is one
   * or more vision calls, so this is the Convert stage's rate against the
   * document model. Pages inside one PDF stay sequential — two limits that
   * multiplied would blow a rate limit on a single scanned book.
   */
  convertConcurrency?: number;
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

/**
 * MCP over Streamable HTTP, hosted by `serve` at `path`. Agents share the
 * running index through it instead of opening a second (PGlite: exclusive)
 * copy of the workspace.
 */
export interface McpServerConfig {
  enabled: boolean;
  path: string;
}

/**
 * How deep-research jobs are run. A job launches the configured agent with the
 * knode MCP endpoint attached — either a coding-agent CLI headlessly, or the
 * built-in agent loop on an OpenAI-compatible connection — and the agent
 * researches a topic and writes the wiki page back through `knode_write`.
 */
export interface ResearchConfig {
  /**
   * Which agent runs jobs: a connection id from `connections`, a CLI provider
   * name ('claude-cli' | 'codex-cli' | 'cursor-cli'), or 'default' for the
   * section-01 connection. An OpenAI-compatible connection runs the built-in
   * agent. Empty = not configured, and research is disabled — there is no
   * fallback, because one that only worked when the default provider happened
   * to be a CLI made the same config silently have research or not.
   */
  agent: string;
  /** Model for the agent. Empty = the CLI's own default / the connection's model. */
  model: string;
  /** Turn cap per job (claude --max-turns; advisory for CLIs without one). */
  maxTurns: number;
  /** Kill a job after this long. */
  timeoutMs: number;
  /** Concurrent CLI runs per workspace. */
  concurrency: number;
  /** Where run workspaces live, relative to the data dir. */
  runsDir: string;
  /** Finished run directories kept before the oldest are pruned. */
  keepRuns: number;
  /** Data-dir subtrees exposed read-only to the agent (add-dir). Writes never go through the filesystem. */
  readDirs: string[];
  /** Accept the top recommendations automatically, up to `dailyJobs` per day. */
  auto: { enabled: boolean; dailyJobs: number };
  /**
   * 'single': one agent session does everything. 'team': a plan session
   * outlines the page, parallel researcher sessions each take one section,
   * a synthesis session writes the page, a review session critiques it and a
   * revision session fixes what it found (deep-research pipeline). 'native':
   * one orchestrator session with the profile's native roles registered as
   * the CLI's own sub-agents (claude --agents, codex agents.enabled). The
   * active profile may override this.
   */
  pipeline: 'single' | 'team' | 'native';
  /**
   * Research profile under playbooks/research/profiles/<name>.yaml: reasoning
   * effort, web search freshness, verification bar and the sub-agent roles
   * (each with its own CLI, model, tools and prompt). Built-ins: default,
   * quick, thorough, native.
   */
  profile: string;
  /** Parallel researcher sessions in 'team' mode. */
  researchers: number;
  /** Critique → revise rounds in 'team' mode before the page is accepted or rejected. */
  reviewRounds: number;
  /** Knowledge-base initialization (kind = init): what the pre-flight does and how many topic pages it queues. */
  init: ResearchInitConfig;
}

export interface ResearchInitConfig {
  /** Topic pages (from the plan) queued as follow-up research jobs after an initialization. */
  followUps: number;
  /** 'drain': run tier-1 extraction to the end of the queue / budget before the agent starts; 'skip': leave the queue to the background loop. */
  extraction: 'drain' | 'skip';
  /** Cap on the pre-flight extraction time. */
  extractionMaxMs: number;
}

/**
 * Ask: a person talks to the configured agent, which answers from the
 * knowledge base over MCP and may write what it is taught (quarantined notes
 * under raw/docs/notes/). Every turn is a fresh session that replays recent
 * history — no CLI session persistence (see docs/design/07).
 *
 * *How* that agent runs — effort, tool grants, turn cap, timeout, extra
 * prompt — belongs to the agent, in `playbooks/agents/<name>.yaml`. This block
 * used to keep a second copy of all of it that nothing read; what is left is
 * the three things that are properties of the conversation rather than of who
 * answers it.
 */
export interface ChatConfig {
  /** Agent name, connection id or provider; '' falls back to research.agent, then the default connection. */
  agent: string;
  /** Model override ('' = the agent's own). */
  model: string;
  /** Messages replayed into each turn's prompt (user + assistant, most recent). */
  historyTurns: number;
  /** Conversations kept per workspace; older ones are pruned. One conversation per question fills this faster than turns do. */
  keep: number;
}

export interface GraphConfig {
  /** Ontology packs under playbooks/ontology/<pack>.yaml, merged in order; later packs may extend earlier ones. */
  ontologyPacks: string[];
}

export type ReviewResolution = 'exact' | 'suffix';
export type ReviewLlmMode = 'off' | 'suggest' | 'auto';
export type ReviewExternal = 'off' | 'verify' | 'research';

/**
 * How much checking sits between extraction and the graph. Three layers, each
 * with its own knob, so a workspace can be strict (nothing merges without a
 * person) or hands-off (the LLM judge merges what it is sure about).
 */
export interface ReviewConfig {
  /**
   * Write-time auto-merge rule. 'exact': a mention merges into a known entity
   * only when its spelling equals a known name or alias (after NFKC / width /
   * case folding). 'suffix': names that differ only by a corporate suffix
   * (股份有限公司, Inc., Co., Ltd. …) merge too. Anything fuzzier is always a
   * suggestion a person accepts.
   */
  resolution: ReviewResolution;
  /** LLM judge over duplicate-entity candidates: off / annotate suggestions with a verdict / also merge above autoMergeMinConfidence. */
  llmJudge: ReviewLlmMode;
  /** Candidates the judge rejects with at least this confidence are dropped (and remembered) instead of filed. */
  llmMinConfidence: number;
  /** 'auto' merges without a person at or above this confidence. */
  autoMergeMinConfidence: number;
  /** Candidates judged per nightly run (one LLM call each, within the daily token budget). */
  maxJudgedPerRun: number;
  /** LLM review of disputed / suspected claims, filed as knowledge suggestions with a verdict. */
  claims: 'off' | 'suggest';
  /** External (web) verification by research agents: off / only `verify` jobs get web tools / every research job may use them. */
  external: ReviewExternal;
}

export interface KnodeConfig {
  /**
   * The active embedding provider, flattened. Derived from `embeddingProviders`
   * on every load and every save, never edited on its own, so that every reader
   * — the store's vector width, `ctx.embedder`, wiki, dream, the dedupe audit —
   * keeps taking one plain endpoint and never has to know the library exists.
   */
  embedding: EmbeddingConfig;
  /** Every configured embedding provider. The Index stage runs on exactly one. */
  embeddingProviders: EmbeddingConnection[];
  /** Which `embeddingProviders` entry the Index stage runs on. */
  embeddingUse: string;
  database: DatabaseConfig;
  /**
   * A mirror of the connection `llmUse` names, flattened by `syncActiveLlm`.
   *
   * Everything that needs "the default model" — `ctx.llm`, a route that names
   * no connection, `agentForSpec('default')` — reads this, so the default can
   * become an ordinary row without touching any of them.
   */
  llm: LlmConfig;
  /** Every configured LLM connection, including whichever one is the default. */
  connections: LlmConnection[];
  /** Which `connections` entry is the default. */
  llmUse: string;
  server: { port: number; host: string; mcp: McpServerConfig };
  ingest: IngestConfig;
  extraction: ExtractionConfig;
  retrieval: { sag: SagSearchConfig };
  heat: HeatConfig;
  datasources: DataSourceConfig[];
  pack: PackConfig;
  /** Deep-research jobs run by an external coding-agent CLI (see src/research). */
  research: ResearchConfig;
  /** Knowledge-graph vocabulary: which ontology packs define entity and relation types. */
  graph: GraphConfig;
  /** Review strength between extraction and the graph (entity merges, claims, external verification). */
  review: ReviewConfig;
  /** The chat entry (see src/chat). */
  chat: ChatConfig;
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
    // Empty, not a seeded row: `deepMerge` keeps a default the saved file does
    // not mention, so a seeded row would survive the merge of a pre-library
    // config and then overwrite that config's real embedding settings.
    embeddingProviders: [],
    embeddingUse: '',
    database: {
      // PostgreSQL by default: one shared database, one schema per workspace. The
      // embedded PGlite index stays available for offline / zero-setup use and
      // is what the test suite runs on — set database.kind to "pglite", or
      // KNODE_DATABASE_KIND=pglite before the config file exists.
      kind: process.env.KNODE_DATABASE_KIND === 'pglite' ? 'pglite' : 'postgres',
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
      protocol: 'auto',
      model: '',
      cliPath: '',
      effort: 'default',
      cliTimeoutMs: 300_000,
    },
    // seeded empty, like `embeddingProviders`: a row here would survive
    // `deepMerge` and clobber a real saved list. `migrateDefaultLlm` mints the
    // default's row on load instead.
    connections: [],
    llmUse: '',
    server: { port: 9100, host: '127.0.0.1', mcp: { enabled: true, path: '/mcp' } },
    ingest: { chunkSize: 1200, chunkOverlap: 150, watch: true, concurrency: 4, convertConcurrency: 2 },
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
    research: {
      agent: '',
      model: '',
      maxTurns: 40,
      timeoutMs: 1_200_000,
      concurrency: 1,
      runsDir: '.runs',
      keepRuns: 20,
      readDirs: ['raw/docs', 'wiki', '.sidecar'],
      auto: { enabled: false, dailyJobs: 3 },
      pipeline: 'team',
      profile: 'default',
      researchers: 3,
      reviewRounds: 1,
      init: { followUps: 6, extraction: 'drain', extractionMaxMs: 900_000 },
    },
    graph: { ontologyPacks: ['core', 'organization'] },
    review: {
      resolution: 'exact',
      llmJudge: 'suggest',
      llmMinConfidence: 0.6,
      autoMergeMinConfidence: 0.95,
      maxJudgedPerRun: 30,
      claims: 'suggest',
      external: 'verify',
    },
    chat: { agent: 'default', model: '', historyTurns: 12, keep: 200 },
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
    protocol: 'auto',
    model: '',
    cliPath: '',
    effort: 'default',
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
      // the wire belongs to the endpoint, so a route rides the connection's
      // choice rather than overriding it
      protocol: connection.protocol,
      model: route.model || connection.model,
      cliPath: connection.cliPath,
      effort: routeEffort(route.effort) ?? connection.effort,
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
    // a route that brings its own endpoint brings its own wire; one that
    // inherits the endpoint inherits the wire with it
    protocol: (route.baseUrl ? route.protocol : undefined) ?? base.protocol,
    model: route.model || legacyModel || (inheritedProvider ? base.model : ''),
    cliPath: route.cliPath || (provider === base.provider ? base.cliPath : ''),
    effort: routeEffort(route.effort) ?? base.effort,
    cliTimeoutMs: route.cliTimeoutMs || base.cliTimeoutMs,
  };
}

/** A route only overrides the effort when it names a real level, the way an empty `model` inherits. */
function routeEffort(effort: LlmEffort | undefined): LlmEffort | undefined {
  return effort && effort !== 'default' ? effort : undefined;
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
  if (!fs.existsSync(file)) return migrateEmbeddingProviders(migrateDefaultLlm(base));
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<KnodeConfig>;
  // routes first: it may already have minted a connection for this endpoint,
  // and the default must reuse that row rather than add a twin
  return migrateEmbeddingProviders(migrateDefaultLlm(migrateRouteConnections(migrateChatConfig(deepMerge(base, raw)))));
}

/**
 * Drop the `chat.*` keys the agent definition now owns.
 *
 * `deepMerge` keeps unknown keys, so without this a file written before the
 * move would carry them forever, looking like settings. Anything that was not
 * the old default is announced once: `chat.maxTurns: 100` vanishing in silence
 * is the kind of thing that becomes a bug report.
 */
const MOVED_CHAT_KEYS: Record<string, unknown> = { effort: 'default', maxTurns: 30, timeoutMs: 600_000, web: 'inherit' };

export function migrateChatConfig(config: KnodeConfig): KnodeConfig {
  const chat = config.chat as unknown as Record<string, unknown> | undefined;
  if (!chat) return config;
  const carried: string[] = [];
  for (const [key, wasDefault] of Object.entries(MOVED_CHAT_KEYS)) {
    if (!(key in chat)) continue;
    if (chat[key] !== wasDefault) carried.push(`${key}=${JSON.stringify(chat[key])}`);
    delete chat[key];
  }
  if (carried.length > 0) {
    console.warn(`knode: chat.${carried.join(', chat.')} no longer applies — how an agent runs now lives in playbooks/agents/<name>.yaml (Settings → Providers & Agents)`);
  }
  return config;
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

/**
 * Put the default LLM in `connections` as an ordinary row and point `llmUse`
 * at it, the way `embeddingUse` has always pointed into `embeddingProviders`.
 *
 * `config.llm` used to be the default *itself*: a field beside the list, which
 * meant two row builders in one table, and meant that making an existing
 * connection the default was retyping its endpoint and key rather than
 * clicking it. It is now a mirror of the named row.
 *
 * Routes keep `use: ''` / `'default'`, which still means "whatever is the
 * default" — rewriting them to the new id would freeze them to one endpoint
 * and break the propagation that named connections exist for.
 */
export function migrateDefaultLlm(config: KnodeConfig): KnodeConfig {
  const connections = [...(config.connections ?? [])];
  if (!connections.some((c) => c.id === config.llmUse)) {
    const existing = connections.find((c) => sameEndpoint(c, config.llm) && c.model === config.llm.model);
    if (existing) {
      config.llmUse = existing.id;
    } else {
      const id = uniqueConnectionId(config.llm.provider, connections);
      connections.unshift({ ...config.llm, id, label: config.llm.label?.trim() || llmProviderLabel(config.llm.provider) });
      config.llmUse = id;
    }
  }
  return syncActiveLlm({ ...config, connections });
}

/**
 * The connection the default points at. A dangling `llmUse` falls back to the
 * first rather than failing — deleting the default demotes it, it does not
 * leave the workspace without a model.
 */
export function activeLlm(config: Pick<KnodeConfig, 'llm' | 'connections' | 'llmUse'>): LlmConnection {
  const connections = config.connections ?? [];
  return (
    connections.find((c) => c.id === config.llmUse) ??
    connections[0] ?? {
      ...config.llm,
      id: config.llmUse || 'default-1',
      label: config.llm.label?.trim() || llmProviderLabel(config.llm.provider),
    }
  );
}

/** Rewrite the `llm` mirror from the active row, repairing a dangling `llmUse`. */
export function syncActiveLlm(config: KnodeConfig): KnodeConfig {
  const { id, ...endpoint } = activeLlm(config);
  config.llm = endpoint;
  config.llmUse = id;
  return config;
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

/**
 * Lift the single `embedding` block into the named library, in memory, so the
 * UI only has to understand a list. A config written before the library had
 * exactly one embedding provider; it becomes the first entry and stays active,
 * which is why nothing re-embeds on the upgrade.
 *
 * A `use` naming an entry that no longer exists falls back to the first one
 * rather than failing: deleting a provider degrades the workspace the way an
 * unknown route id does, it does not break indexing.
 */
export function migrateEmbeddingProviders(config: KnodeConfig): KnodeConfig {
  if (!config.embeddingProviders?.length) {
    const id = uniqueEmbeddingId(config.embedding.provider, []);
    config.embeddingProviders = [{ ...config.embedding, id, label: embeddingProviderLabel(config.embedding.provider) }];
    config.embeddingUse = id;
  }
  return syncActiveEmbedding(config);
}

/**
 * The entry the Index stage runs on. Unlike an LLM route there is no `inherit`
 * case — one entry simply is the active one. A `use` naming an entry that no
 * longer exists falls back to the first rather than failing an ingest pass:
 * deleting the active provider re-embeds on the next save, it does not break.
 */
export function activeEmbedding(
  config: Pick<KnodeConfig, 'embedding' | 'embeddingProviders' | 'embeddingUse'>,
): EmbeddingConnection {
  const providers = config.embeddingProviders ?? [];
  return (
    providers.find((e) => e.id === config.embeddingUse) ??
    providers[0] ?? {
      ...config.embedding,
      id: config.embeddingUse || uniqueEmbeddingId(config.embedding.provider, []),
      label: embeddingProviderLabel(config.embedding.provider),
    }
  );
}

/**
 * Rewrite the `embedding` mirror from the active entry, repairing a dangling
 * `embeddingUse` on the way. The save path calls this before the re-embed diff
 * runs, so that diff keeps comparing two plain endpoints.
 */
export function syncActiveEmbedding(config: KnodeConfig): KnodeConfig {
  const { id, label, ...endpoint } = activeEmbedding(config);
  config.embedding = endpoint;
  config.embeddingUse = id;
  return config;
}

/**
 * What makes two embedding configurations produce comparable vectors: every
 * field that changes the vector space and nothing that does not, so rotating a
 * key or widening a batch never costs a re-embed — and repointing one model
 * name at a different vendor does.
 */
export function embeddingIdentity(cfg: EmbeddingConfig): string {
  // the local hashing embedder reads nothing but the dimension, so its unused
  // endpoint fields must not be able to trigger a re-embed
  if (cfg.provider === 'local') return `local|${cfg.dimensions}`;
  return [cfg.provider, cfg.baseUrl.replace(/\/+$/, ''), cfg.model, cfg.dimensions, cfg.sendDimensions].join('|');
}

function uniqueEmbeddingId(provider: EmbeddingConfig['provider'], providers: EmbeddingConnection[]): string {
  for (let n = 1; ; n++) {
    const id = `${provider}-${n}`;
    if (!providers.some((e) => e.id === id)) return id;
  }
}

export function embeddingProviderLabel(provider: EmbeddingConfig['provider']): string {
  switch (provider) {
    case 'openai': return 'OpenAI-compatible API';
    case 'ark-multimodal': return 'Volcengine Ark · multimodal';
    case 'local': return 'Local hashing · offline';
    default: return provider;
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
  const secretHolders = [
    clone.embedding,
    clone.llm,
    clone.extraction.entityLlm,
    clone.extraction.conceptLlm,
    clone.extraction.documentLlm,
    ...(clone.connections ?? []),
    ...(clone.embeddingProviders ?? []),
  ];
  for (const c of secretHolders) {
    if (c.apiKey && !c.apiKey.startsWith('env:')) c.apiKey = '***';
  }
  for (const ds of clone.datasources ?? []) {
    if (ds.password && !ds.password.startsWith('env:')) ds.password = '***';
  }
  if (clone.database?.password && !clone.database.password.startsWith('env:')) clone.database.password = '***';
  return clone;
}
