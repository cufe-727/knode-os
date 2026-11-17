import { KnodeConfig, loadConfig, resolveRoutedLlmConfig, routeTargets } from './config.js';
import { DataSourceRegistry } from './datasource/registry.js';
import { initDataDir } from './fs/datadir.js';
import { EmbeddingProvider } from './ingest/embeddings.js';
import { createConfiguredEmbeddingProvider } from './ingest/embedding-router.js';
import { LlmClient } from './llm/client.js';
import { loadPlugins } from './plugins/loader.js';
import { Store } from './store/db.js';

/** Everything a command needs, wired from a data directory. */
export interface AppContext {
  dataDir: string;
  config: KnodeConfig;
  store: Store;
  embedder: EmbeddingProvider;
  /**
   * The Judge stage (`judgeLlmClient`), not the default model. Rebuilt
   * whenever the config, or an agent its route may name, changes.
   */
  llm: LlmClient;
  /** Lazily-connected external live data sources (mysql / timescale / duckdb). */
  datasources: DataSourceRegistry;
  /**
   * Set by `serve`: documents are applied without waiting for their vectors,
   * and this embeds whatever is missing in the background
   * (src/ingest/embed-backfill.ts). Absent — the CLI, tests — a document's
   * vectors are computed while it is applied.
   */
  embeddings?: DeferredEmbeddings;
}

/** Where an apply leaves the vectors it did not compute. */
export interface DeferredEmbeddings {
  /** New chunks are waiting for vectors. */
  kick(): void;
}

/**
 * What `ctx.llm` runs on: the Judge stage's route. knode_ask, Dream, the
 * duplicate-entity review and the disputed-claim review all take `ctx.llm`
 * rather than resolving a stage of their own, so that is the whole stage.
 * They ran on the Summarize stage until it kept only document summaries
 * (docs/design/09), and on the default LLM before that.
 */
export function judgeLlmClient(config: KnodeConfig): LlmClient {
  return new LlmClient(resolveRoutedLlmConfig(config.llm, config.extraction.judgeLlm, routeTargets(config)));
}

/** The Summarize stage: one summary page per document, written in the background document pass. */
export function summaryLlmClient(config: KnodeConfig): LlmClient {
  return new LlmClient(resolveRoutedLlmConfig(config.llm, config.extraction.summaryLlm, routeTargets(config)));
}

export interface CreateContextOptions {
  /**
   * Where a relative plugin path in this workspace's config is also looked
   * for: the root data directory whose config the workspace copied (set by
   * the workspace registry under `serve`).
   */
  pluginRoots?: string[];
  /**
   * Open the workspace without changing it (docs/design/35 §4): no folder or
   * starter file made, its config read but not upgraded or saved, its index
   * opened read-only (`Store.open`'s `readOnly`).
   */
  readOnly?: boolean;
}

export async function createContext(dataDir: string, opts: CreateContextOptions = {}): Promise<AppContext> {
  if (!opts.readOnly) initDataDir(dataDir);
  const config = loadConfig(dataDir, { readOnly: opts.readOnly });
  // plugins before anything that resolves a provider: the store may open on a
  // backend one of them adds, the embedder and the stages on providers they add
  await loadPlugins(dataDir, config.plugins, { log: (msg) => console.log(`[knode-os] ${msg}`), roots: opts.pluginRoots });
  const store = await Store.open(dataDir, config.embedding.dimensions, config.database, { readOnly: opts.readOnly });
  const embedder = createConfiguredEmbeddingProvider(config);
  const llm = judgeLlmClient(config);
  const datasources = new DataSourceRegistry(dataDir, config.datasources);
  return { dataDir, config, store, embedder, llm, datasources };
}
