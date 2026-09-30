import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentFileNames, isValidAgentName, readAgentFile, renameProfileAgents, upgradeAgentFiles, writeAgentFile } from './research/agent-file.js';

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

/** The coding-agent CLIs: agents that bring their own loop, kept in `playbooks/agents/`. */
export const CLI_PROVIDERS = ['claude-cli', 'codex-cli', 'cursor-cli'] as const;
export type CliProvider = (typeof CLI_PROVIDERS)[number];

export function isCliProvider(provider: unknown): provider is CliProvider {
  return (CLI_PROVIDERS as readonly unknown[]).includes(provider);
}

/**
 * Reasoning effort a CLI provider runs at. `default` leaves the CLI's own
 * setting alone; everything else is passed through (see `effortFor` for the
 * CLIs that cannot take the whole ladder). Research profiles read the same
 * list as `EFFORTS`, so a level means one thing everywhere. `ultra` is the
 * rung codex lists above `max`: maximum reasoning that delegates on its own.
 */
export const LLM_EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type LlmEffort = (typeof LLM_EFFORTS)[number];

/**
 * How fast a CLI provider answers. `default` leaves the CLI's own setting
 * alone; `fast` asks for the priority tier the codex catalog lists as "Fast"
 * (quicker, at higher usage). The other CLIs have no such switch and ignore
 * it — see `speedFor`.
 */
export const LLM_SPEEDS = ['default', 'fast'] as const;
export type LlmSpeed = (typeof LLM_SPEEDS)[number];

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
  /** How fast, see `LLM_SPEEDS`. Absent or 'default' leaves the CLI's own tier alone. */
  speed?: LlmSpeed;
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
   * What runs this route, by id: a model endpoint or an agent (see
   * `routeTargets`). `model` still overrides that target's own model, so one
   * endpoint can serve several routes at different price points.
   *
   * '' and 'default' followed the default LLM. A stage no longer does —
   * `pinRoutes` writes them down as the default they were running on.
   */
  use: string;
}

/**
 * A named LLM connection. Endpoint and credentials live here once; routes
 * point at one by id instead of repeating them.
 *
 * In `connections` this is a model endpoint. The same shape also carries an
 * agent to the places that call it one-shot (see `llmTargets` and
 * `routeTargets`), which is why `provider` still admits the CLIs.
 */
export interface LlmConnection extends LlmConfig {
  /** Stable key routes reference. Never reused for a different endpoint. */
  id: string;
  /** Shown in the UI. */
  label: string;
}

export interface ExtractionConfig {
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
  /** 'drain': run tier-1 extraction to the end of the queue before the agent starts; 'skip': leave the queue to the background loop. */
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
  /** Candidates judged per nightly run (one LLM call each). */
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
  /**
   * Every configured model endpoint, including whichever one is the default.
   * Coding-agent CLIs are agents and live in `playbooks/agents/` —
   * `migrateCliConnections` moves any left here.
   */
  connections: LlmConnection[];
  /**
   * What the default is: a `connections` entry, or — on a machine with no model
   * endpoint — a CLI agent's name.
   */
  llmUse: string;
  /**
   * The CLI agents under `playbooks/agents/`, as the one-shot LLMs a pipeline
   * route or the default can run on. Read from the files on load and whenever
   * an agent is saved; never written to the config file.
   */
  agentLlms?: LlmConnection[];
  /**
   * The deepagents agents under `playbooks/agents/`, which a pipeline route —
   * not the default, which they may follow — can run on one-shot. Read and
   * kept like `agentLlms`.
   */
  modelAgents?: ModelAgent[];
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
    speed: 'default',
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
      speed: routeSpeed(route.speed) ?? connection.speed,
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
    speed: routeSpeed(route.speed) ?? base.speed,
    cliTimeoutMs: route.cliTimeoutMs || base.cliTimeoutMs,
  };
}

/** A route only overrides the effort when it names a real level, the way an empty `model` inherits. */
function routeEffort(effort: LlmEffort | undefined): LlmEffort | undefined {
  return effort && effort !== 'default' ? effort : undefined;
}

/** The same for speed: a route's 'default' is its target's own. */
function routeSpeed(speed: LlmSpeed | undefined): LlmSpeed | undefined {
  return speed && speed !== 'default' ? speed : undefined;
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
  // the agent files before anything reads them: a retired built-in leaves
  // here, and what named it follows its replacement below, before `pinRoutes`
  // resolves a single stage
  const retired = upgradeAgentFiles(dataDir);
  const base = defaultConfig();
  // before the default is resolved: it may name a CLI agent
  base.agentLlms = readAgentLlms(dataDir);
  base.modelAgents = readModelAgents(dataDir);
  if (!fs.existsSync(file)) {
    const fresh = migrateEmbeddingProviders(migrateCliConnections(migrateDefaultLlm(base), dataDir));
    renameRetiredAgents(fresh, dataDir, retired);
    pinRoutes(fresh);
    return fresh;
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<KnodeConfig>;
  const merged = migrateChatConfig(deepMerge(base, raw));
  const unbudgeted = dropTokenBudget(merged);
  merged.agentLlms = base.agentLlms;
  merged.modelAgents = base.modelAgents;
  const renamed = renameRetiredAgents(merged, dataDir, retired);
  // routes first: it may already have minted a connection for this endpoint,
  // and the default must reuse that row rather than add a twin; CLI rows move
  // out last, once both have had their say about which rows exist
  const routed = migrateDefaultLlm(migrateRouteConnections(merged));
  const movesCli = routed.connections.some((c) => isCliProvider(c.provider));
  const config = migrateEmbeddingProviders(migrateCliConnections(routed, dataDir));
  // stages last, once the default and every target are where they will stay
  const pinned = pinRoutes(config);
  // the move wrote agent files, so the config that no longer names those rows
  // is written too — otherwise every load would move them again; a pinned
  // stage, a spec renamed off a retired agent and a dropped token budget are
  // written for the same reason
  if (movesCli || pinned || renamed || unbudgeted) saveConfig(dataDir, config);
  return config;
}

/**
 * Point what named a retired built-in agent (`upgradeAgentFiles`) at its
 * replacement: research, Ask, the pipeline stages, and the profile roles that
 * pin one. Returns whether the config changed; the profiles are files of
 * their own and are written as they change.
 */
export function renameRetiredAgents(config: KnodeConfig, dataDir: string, renamed: Map<string, string>): boolean {
  if (renamed.size === 0) return false;
  renameProfileAgents(dataDir, renamed);
  let changed = false;
  for (const key of ['research', 'chat'] as const) {
    const to = renamed.get(config[key]?.agent?.trim() ?? '');
    if (!to) continue;
    config[key].agent = to;
    changed = true;
  }
  for (const key of ROUTE_KEYS) {
    const to = renamed.get(config.extraction[key]?.use?.trim() ?? '');
    if (!to) continue;
    config.extraction[key] = { ...config.extraction[key], use: to };
    changed = true;
  }
  return changed;
}

/**
 * Drop the `chat.*` keys that left chat: effort and web access went to the
 * agent definition, and Ask's turn cap and timeout are fixed now.
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
    console.warn(`knode: chat.${carried.join(', chat.')} no longer applies — Ask runs every agent with the same turn cap and timeout; an agent's effort and web access live in playbooks/agents/<name>.yaml (Settings → Providers & Agents)`);
  }
  return config;
}

/**
 * Drop `extraction.dailyTokenBudget`. Nothing caps background LLM work by a
 * daily token count any more — tier-1 extraction is paced by its batch size
 * and interval — and `deepMerge` keeps unknown keys, so a file written before
 * would otherwise carry it forever, looking like a setting. Returns whether
 * there was one to drop.
 */
export function dropTokenBudget(config: KnodeConfig): boolean {
  const extraction = config.extraction as unknown as Record<string, unknown> | undefined;
  if (!extraction || !('dailyTokenBudget' in extraction)) return false;
  delete extraction.dailyTokenBudget;
  return true;
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
 * Routes are left alone here; `pinRoutes` writes an inheriting one down as
 * this default once every target is known.
 */
export function migrateDefaultLlm(config: KnodeConfig): KnodeConfig {
  const connections = [...(config.connections ?? [])];
  const targets = llmTargets({ ...config, connections });
  if (!targets.some((c) => c.id === config.llmUse)) {
    const existing = targets.find((c) => sameEndpoint(c, config.llm) && c.model === config.llm.model);
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
 * first model endpoint, then the first CLI agent, rather than failing —
 * deleting the default demotes it, it does not leave the workspace without a
 * model.
 */
export function activeLlm(config: Pick<KnodeConfig, 'llm' | 'connections' | 'llmUse' | 'agentLlms'>): LlmConnection {
  const targets = llmTargets(config);
  return (
    targets.find((c) => c.id === config.llmUse) ??
    targets[0] ?? {
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

/**
 * Everything the default can run on: the model endpoints, then the CLI
 * agents, called one-shot. An endpoint wins an id clash, since it is what the
 * config itself names. A pipeline route can run on more — see `routeTargets`.
 */
export function llmTargets(config: Pick<KnodeConfig, 'connections' | 'agentLlms'>): LlmConnection[] {
  const connections = config.connections ?? [];
  const agents = (config.agentLlms ?? []).filter((a) => !connections.some((c) => c.id === a.id));
  return [...connections, ...agents];
}

/**
 * Everything a pipeline route can run on: `llmTargets`, then the deepagents
 * agents that pin a model of their own, as that model on their endpoint.
 *
 * A stage sends its own prompt and wants one answer back, so an agent is
 * called one-shot either way: a CLI agent brings its path and model, a
 * deepagents agent its endpoint and model; neither brings its loop, tools or
 * prompt. A deepagents agent with no model of its own would therefore be its
 * endpoint's row again under another name — the stage picker listed each
 * such agent beside the model it is — so it is left out, and `pinRoutes`
 * moves a stage on one to that endpoint. The default cannot be one of these,
 * since they may follow it — so they stay out of `llmTargets`. One following
 * a default that is a CLI agent does not run at all (see `resolveAgentSpec`),
 * so it is no target either.
 */
export function routeTargets(
  config: Pick<KnodeConfig, 'llm' | 'connections' | 'llmUse' | 'agentLlms' | 'modelAgents'>,
): LlmConnection[] {
  const targets = llmTargets(config);
  const connections = config.connections ?? [];
  const agents: LlmConnection[] = [];
  for (const agent of config.modelAgents ?? []) {
    if (!agent.model || targets.some((t) => t.id === agent.id)) continue;
    const endpoint = agent.runsOn === 'default' ? activeLlm(config) : connections.find((c) => c.id === agent.runsOn);
    if (!endpoint || isCliProvider(endpoint.provider)) continue;
    agents.push({ ...endpoint, id: agent.id, label: agent.label, model: agent.model });
  }
  return [...targets, ...agents];
}

const LEGACY_ROUTE_MODELS = { entityLlm: 'tier1Model', conceptLlm: 'tier2Model' } as const;

/**
 * Write down what each pipeline stage runs on, by id.
 *
 * A stage could name nothing and follow the default, which its picker offered
 * beside the default's own row — two entries for one endpoint that only came
 * apart later, when the default moved. A stage now names what it runs on, so
 * a route that names nothing — or something since deleted, which resolved to
 * the default anyway — is pinned to what the default is now, with the legacy
 * tier model it was using. Moving the default later moves no stage.
 *
 * Returns whether any route moved. Leaves them alone when the default itself
 * names nothing that can run, since there is nothing to pin to.
 */
export function pinRoutes(config: KnodeConfig): boolean {
  const targets = routeTargets(config);
  if (!targets.some((t) => t.id === config.llmUse)) return false;
  let moved = false;
  for (const key of ROUTE_KEYS) {
    const route = config.extraction[key];
    // 'default' is what `resolveRoutedLlmConfig` reads as the default, even
    // when an agent happens to have that name
    if (route.use && route.use !== 'default' && targets.some((t) => t.id === route.use)) continue;
    // a deepagents agent with no model of its own is no target (`routeTargets`),
    // but its endpoint is the very call it made, so the stage moves there
    // rather than to the default
    const agent = route.use && route.use !== 'default' ? config.modelAgents?.find((a) => a.id === route.use && !a.model) : undefined;
    const endpoint = agent ? (agent.runsOn === 'default' ? config.llmUse : agent.runsOn) : '';
    if (endpoint && targets.some((t) => t.id === endpoint)) {
      config.extraction[key] = { ...route, use: endpoint };
      moved = true;
      continue;
    }
    const legacy = key === 'documentLlm' ? null : LEGACY_ROUTE_MODELS[key];
    config.extraction[key] = { ...route, use: config.llmUse, model: route.model || (legacy ? config.extraction[legacy] : '') };
    if (legacy) config.extraction[legacy] = '';
    moved = true;
  }
  return moved;
}

/** How long a CLI agent's one-shot call may take; agent files carry no timeout of their own for it. */
const CLI_ONE_SHOT_TIMEOUT_MS = 300_000;

/** The CLI agents under `playbooks/agents/`, shaped as the connections `llmTargets` hands on. */
export function readAgentLlms(dataDir: string): LlmConnection[] {
  const out: LlmConnection[] = [];
  for (const name of agentFileNames(dataDir)) {
    const raw = readAgentFile(dataDir, name);
    const executor = typeof raw?.executor === 'string' ? raw.executor.trim() : '';
    if (!raw || !isCliProvider(executor)) continue;
    const text = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string).trim() : '');
    out.push({
      id: name,
      label: text('title') || name,
      provider: executor,
      baseUrl: '',
      apiKey: '',
      model: text('model'),
      cliPath: text('cliPath'),
      effort: LLM_EFFORTS.includes(raw.effort as LlmEffort) ? (raw.effort as LlmEffort) : 'default',
      speed: LLM_SPEEDS.includes(raw.speed as LlmSpeed) ? (raw.speed as LlmSpeed) : 'default',
      cliTimeoutMs: CLI_ONE_SHOT_TIMEOUT_MS,
    });
  }
  return out;
}

/** A deepagents agent as a pipeline route sees it: which model it runs on. */
export interface ModelAgent {
  id: string;
  label: string;
  /** Its `executor`: 'default' follows the default LLM, anything else names a connection. */
  runsOn: string;
  /** Empty = the model of the endpoint it runs on. */
  model: string;
}

/**
 * The deepagents agents under `playbooks/agents/`, left for `routeTargets` to
 * resolve against the connections. An agent file with no executor follows the
 * default, the way `normalizeAgent` reads it.
 */
export function readModelAgents(dataDir: string): ModelAgent[] {
  const out: ModelAgent[] = [];
  for (const name of agentFileNames(dataDir)) {
    const raw = readAgentFile(dataDir, name);
    if (!raw) continue;
    const executor = typeof raw.executor === 'string' ? raw.executor.trim() : 'default';
    if (isCliProvider(executor)) continue;
    const text = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string).trim() : '');
    out.push({ id: name, label: text('title') || name, runsOn: executor, model: text('model') });
  }
  return out;
}

/**
 * Move coding-agent CLIs out of `connections` and into `playbooks/agents/`.
 *
 * A CLI is an agent that brings its own loop, not a model endpoint. Keeping it
 * among the models made "cursor" the default *LLM*, and made the built-in deep
 * agent — which follows the default — quietly run Cursor instead of deepagents.
 *
 * Each row becomes an agent file under its own id, so every route, `llmUse`,
 * research role and agent spec that named it keeps resolving; `llmTargets`
 * hands CLI agents back to the pipeline as one-shot LLMs. Agents that ran on a
 * row — by its id, or as a bare CLI name borrowing its model — take its path
 * and model into their own file, and a bare `research.agent` / `chat.agent`
 * becomes the agent it was borrowing from, so nothing runs differently.
 *
 * The one deliberate change: a default that was a CLI moves to the first model
 * endpoint that has a model, because deepagents follows the default and
 * cannot run on a CLI. A workspace with no such endpoint keeps the CLI.
 *
 * Idempotent: once the rows are gone there is nothing left to move.
 */
export function migrateCliConnections(config: KnodeConfig, dataDir: string): KnodeConfig {
  const cli = (config.connections ?? []).filter((c) => isCliProvider(c.provider));
  if (cli.length === 0) return config;

  const before = new Set(agentFileNames(dataDir));
  const names = new Map<string, string>();
  for (const connection of cli) {
    const existing = readAgentFile(dataDir, connection.id);
    // a rerun finds its own file; a different agent under that name keeps it
    const reuse = isValidAgentName(connection.id) && (!existing || existing.executor === connection.provider);
    const name = reuse ? connection.id : uniqueAgentName(dataDir, connection.id, connection.provider);
    if (!readAgentFile(dataDir, name)) {
      writeAgentFile(dataDir, name, {
        name,
        title: connection.label?.trim() || llmProviderLabel(connection.provider),
        description: '',
        executor: connection.provider,
        cliPath: connection.cliPath ?? '',
        model: connection.model ?? '',
        effort: connection.effort ?? 'default',
        // what a bare spec used to launch with, so Ask on it behaves the same
        tools: { write: true, files: true, web: 'inherit' },
        maxTurns: 0,
        timeoutMs: 0,
        prompt: '',
      });
    }
    names.set(connection.id, name);
  }

  // the row a bare CLI name borrowed its path and model from: the default's
  // when it runs that CLI, else the first that does (see `bareAgentFor`)
  const lender = (provider: string) =>
    cli.find((c) => c.id === config.llmUse && c.provider === provider) ?? cli.find((c) => c.provider === provider);

  const created = new Set(names.values());
  for (const name of before) {
    if (created.has(name)) continue;
    const raw = readAgentFile(dataDir, name);
    const executor = typeof raw?.executor === 'string' ? raw.executor.trim() : '';
    if (!raw || !executor) continue;
    const source = cli.find((c) => c.id === executor) ?? (isCliProvider(executor) && !raw.model && !raw.cliPath ? lender(executor) : undefined);
    if (!source) continue;
    writeAgentFile(dataDir, name, {
      ...raw,
      executor: source.provider,
      cliPath: (typeof raw.cliPath === 'string' && raw.cliPath.trim()) || source.cliPath || '',
      model: (typeof raw.model === 'string' && raw.model.trim()) || source.model || '',
    });
  }

  for (const key of ROUTE_KEYS) {
    const route = config.extraction[key];
    if (route?.use && names.has(route.use)) route.use = names.get(route.use)!;
  }
  for (const key of ['research', 'chat'] as const) {
    const spec = config[key]?.agent?.trim();
    if (!spec) continue;
    const source = names.has(spec) ? cli.find((c) => c.id === spec) : isCliProvider(spec) ? lender(spec) : undefined;
    if (source) config[key].agent = names.get(source.id)!;
  }

  config.connections = config.connections.filter((c) => !isCliProvider(c.provider));
  if (names.has(config.llmUse)) {
    const model = config.connections.find((c) => c.model && c.baseUrl);
    config.llmUse = model?.id ?? names.get(config.llmUse)!;
  }
  config.agentLlms = readAgentLlms(dataDir);
  config.modelAgents = readModelAgents(dataDir);
  console.warn(`knode: ${[...names.values()].join(', ')} moved from connections to playbooks/agents/ — a coding-agent CLI is an agent now (Settings → Providers & Agents)`);
  return syncActiveLlm(config);
}

function uniqueAgentName(dataDir: string, id: string, provider: string): string {
  const base = isValidAgentName(`${id}-agent`) ? `${id}-agent` : provider;
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!readAgentFile(dataDir, name)) return name;
  }
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
  // derived from the agent files; writing them would make two copies to disagree
  const { agentLlms: _derived, modelAgents: _alsoDerived, ...persisted } = config;
  fs.writeFileSync(file, JSON.stringify(persisted, null, 2) + '\n');
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
  // clients read agents from /api/agents; these copies are the service's own
  delete clone.agentLlms;
  delete clone.modelAgents;
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
