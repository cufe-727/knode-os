import type { DatabaseConfig, EmbeddingConfig, IngestConfig, LlmConfig } from '../config.js';
import type { ExtractRequest, ExtractResult } from '../graph/llm-extract.js';
import type { ChunkPiece } from '../ingest/chunker.js';
import type { ConversionResult, VisionModel } from '../ingest/converters/shared.js';
import type { EmbeddingProvider } from '../ingest/embeddings.js';
import type { ChatMessage, CompletionOptions } from '../llm/client.js';
import type { ModelListResult } from '../llm/models.js';
import type { Backend } from '../store/backend.js';
import type { DocRoot } from '../types.js';

/**
 * The plugin API — what a plugin module may add to knode-os (docs/design/11):
 *
 *   - LLM providers: what a stage's `provider` may name beyond the built-in
 *     OpenAI-compatible endpoint and the coding-agent CLIs;
 *   - embedding providers: the same for the Index stage;
 *   - storage backends: what `database.kind` may name beyond pglite / postgres;
 *   - document converters: file types the Convert stage turns into Markdown;
 *   - pipeline hooks: user-defined functions at the processing stages.
 *
 * Every built-in is registered through this same API (src/plugins/builtin.ts),
 * so a plugin can do anything the built-ins do, including replacing one.
 * This module holds types only; the registry is src/plugins/registry.ts.
 */

/** The fields of an `LlmConfig` a provider reads, so a settings form knows what to show. */
export type LlmProviderField = 'baseUrl' | 'apiKey' | 'protocol' | 'model' | 'cliPath' | 'effort' | 'speed' | 'cliTimeoutMs';

/** What a provider hands back for one configuration: the thing `LlmClient` talks to. */
export interface LlmBackend {
  /** False when this configuration cannot answer (no model, no executable); callers fall back to heuristics. */
  readonly enabled: boolean;
  /** Display identity, e.g. "gpt-4.1-mini", "codex-cli:gpt-5", "command:my-model.py". */
  readonly label: string;
  complete(messages: ChatMessage[], opts: CompletionOptions): Promise<string>;
}

export interface LlmProviderPlugin {
  /** The value of `provider` in a connection, a route or an agent file. Lower-case, stable. */
  id: string;
  label: string;
  /**
   * 'api' = an HTTP endpoint (baseUrl / apiKey); 'cli' = a local executable
   * (cliPath / effort); 'custom' = anything else. Settings groups providers by it.
   */
  kind: 'api' | 'cli' | 'custom';
  /** Which config fields matter; absent = decided by `kind`. */
  fields?: LlmProviderField[];
  /** One or two sentences a settings screen shows under the provider. */
  note?: string;
  create(config: LlmConfig): LlmBackend;
  /** Models this configuration can run, for the model picker. Absent: the field is free text. */
  listModels?(config: LlmConfig): Promise<ModelListResult>;
}

export type EmbeddingProviderField = 'baseUrl' | 'apiKey' | 'model' | 'dimensions' | 'batchSize' | 'sendDimensions';

export interface EmbeddingProviderPlugin {
  id: string;
  label: string;
  kind: 'api' | 'local' | 'custom';
  fields?: EmbeddingProviderField[];
  note?: string;
  create(config: EmbeddingConfig): EmbeddingProvider;
  listModels?(config: EmbeddingConfig): Promise<ModelListResult>;
}

/**
 * Where a workspace's derived index lives. The store speaks PostgreSQL with
 * pgvector to whatever `open` returns, so a backend is a way of reaching such
 * a database — a managed service, a Unix socket, a connection proxy, an
 * embedded engine — not a different query language.
 */
export interface StorageBackendPlugin {
  /** The value of `database.kind`. */
  id: string;
  label: string;
  note?: string;
  open(dataDir: string, config: DatabaseConfig): Promise<Backend>;
}

export interface ConverterInput {
  /** The original, as a path on disk. */
  absPath: string;
  /** Its source key, e.g. raw/docs/report.pdf. */
  rel: string;
  /** The Convert stage's vision model, when one is configured and enabled. */
  vision?: VisionModel;
  maxPdfPages?: number;
  maxImageDimension?: number;
}

/**
 * A file type the Convert stage turns into Markdown. The result is cached in
 * the source's sidecar under a key that carries the converter's id and version
 * (and the vision model's label when `usesVision`), so a converter upgrade
 * re-converts what it owns and nothing else.
 */
export interface DocumentConverterPlugin {
  id: string;
  label?: string;
  /** Lower-case extensions including the dot, e.g. ['.docx']. */
  extensions: string[];
  /** Bump to re-convert existing sources on upgrade. */
  version?: string | number;
  /** The conversion depends on the Convert stage's vision model. */
  usesVision?: boolean;
  convert(input: ConverterInput): Promise<ConversionResult>;
}

/** What a hook sees of the document it runs on. */
export interface DocumentHookContext {
  /** Source key, e.g. raw/docs/notes/a.md. */
  path: string;
  root: DocRoot;
  dataDir: string;
}

export interface SegmentHookContext {
  /** Where this call sits in a long document; absent for a single-call document. */
  segment?: { index: number; total: number; heading: string | null };
}

export interface DocumentAppliedEvent extends DocumentHookContext {
  outcome: 'applied';
  chunks: number;
  entities: number;
  relations: number;
  scopeId: string | null;
}

/**
 * The hook points, in processing order. Filters take a value and hand back the
 * value the stage goes on with; several plugins chain in registration order.
 * `document.applied` is a notification and returns nothing.
 *
 * `source.text` is synchronous: it runs wherever a source's text is read,
 * including code paths that cannot await.
 */
export interface PipelineHooks {
  /** The indexed text of a source, before it is hashed and chunked. Changing it changes the document's identity. */
  'source.text': (text: string, ctx: DocumentHookContext) => string;
  /** The chunks a document is indexed as, after the built-in splitter. */
  chunk: (pieces: ChunkPiece[], ctx: DocumentHookContext & { text: string; config: Pick<IngestConfig, 'chunkSize' | 'chunkOverlap'> }) => ChunkPiece[] | Promise<ChunkPiece[]>;
  /** The tier-0 concept terms mined from a raw/docs source, before they become concept entities. */
  'tier0.concepts': (concepts: string[], ctx: DocumentHookContext & { text: string; frontmatter: Record<string, unknown> }) => string[] | Promise<string[]>;
  /** One tier-1 extraction call, before it is sent (or leased to a worker): its messages and token budget. */
  'extract.request': (request: ExtractRequest, ctx: DocumentHookContext & SegmentHookContext & { title: string }) => ExtractRequest | Promise<ExtractRequest>;
  /** One extraction call's checked result, before it is kept in the sidecar and written to the graph. */
  'extract.result': (result: ExtractResult, ctx: DocumentHookContext & SegmentHookContext & { title: string; model: string }) => ExtractResult | Promise<ExtractResult>;
  /** The Summarize stage's prompt for one document. */
  'summary.request': (messages: ChatMessage[], ctx: DocumentHookContext & { title: string; text: string }) => ChatMessage[] | Promise<ChatMessage[]>;
  /** A document was applied as a scope: chunks, keyword index and tier-0 graph are in. */
  'document.applied': (event: DocumentAppliedEvent) => void | Promise<void>;
}

export type HookName = keyof PipelineHooks;

export const HOOK_NAMES: HookName[] = ['source.text', 'chunk', 'tier0.concepts', 'extract.request', 'extract.result', 'summary.request', 'document.applied'];

/** The hooks whose handlers must return synchronously. */
export const SYNC_HOOKS: ReadonlySet<HookName> = new Set<HookName>(['source.text']);

/** What `setup(api, options)` is handed. */
export interface PluginApi {
  registerLlmProvider(plugin: LlmProviderPlugin): void;
  registerEmbeddingProvider(plugin: EmbeddingProviderPlugin): void;
  registerStorageBackend(plugin: StorageBackendPlugin): void;
  registerConverter(plugin: DocumentConverterPlugin): void;
  on<K extends HookName>(hook: K, handler: PipelineHooks[K]): void;
  /** A line in the service log, prefixed with the plugin's name. */
  log(message: string): void;
}

/**
 * A plugin module's default export. Everything is optional: a plugin may be a
 * single hook, or a provider library. Declared members are registered first,
 * then `setup` runs with the options from the config.
 */
export interface KnodePlugin {
  name: string;
  version?: string;
  description?: string;
  llmProviders?: LlmProviderPlugin[];
  embeddingProviders?: EmbeddingProviderPlugin[];
  storageBackends?: StorageBackendPlugin[];
  converters?: DocumentConverterPlugin[];
  hooks?: Partial<PipelineHooks>;
  setup?(api: PluginApi, options: Record<string, unknown>): void | Promise<void>;
}

/** One entry of `plugins` in knode.config.json. */
export interface PluginSpec {
  /**
   * What to import: a path relative to the data directory (`./plugins/x.mjs`),
   * an absolute path, or a package name resolved from the data directory's
   * node_modules and then from knode-os's own.
   */
  module: string;
  /** Passed to the plugin's `setup`. */
  options?: Record<string, unknown>;
  /** false keeps the entry without loading it. */
  enabled?: boolean;
}

/** What was registered, by whom — the answer of `knode-os plugins` and GET /api/plugins. */
export interface PluginSummary {
  name: string;
  version?: string;
  description?: string;
  /** 'builtin', the module spec it was loaded from, or 'api' for in-process registration. */
  source: string;
  llmProviders: string[];
  embeddingProviders: string[];
  storageBackends: string[];
  converters: string[];
  hooks: HookName[];
}
