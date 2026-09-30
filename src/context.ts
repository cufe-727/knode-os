import { KnodeConfig, loadConfig, resolveRoutedLlmConfig, routeTargets } from './config.js';
import { DataSourceRegistry } from './datasource/registry.js';
import { initDataDir } from './fs/datadir.js';
import { createEmbeddingProvider, EmbeddingProvider } from './ingest/embeddings.js';
import { LlmClient } from './llm/client.js';
import { Store } from './store/db.js';

/** Everything a command needs, wired from a data directory. */
export interface AppContext {
  dataDir: string;
  config: KnodeConfig;
  store: Store;
  embedder: EmbeddingProvider;
  /**
   * The Summarize stage (`summaryLlmClient`), not the default model. Rebuilt
   * whenever the config, or an agent its route may name, changes.
   */
  llm: LlmClient;
  /** Lazily-connected external live data sources (mysql / timescale / duckdb). */
  datasources: DataSourceRegistry;
}

/**
 * What `ctx.llm` runs on: the Summarize stage's route. Document summaries,
 * Dream, the nightly merge and claim reviews and knode_ask all take `ctx.llm`
 * rather than resolving a stage of their own, so that is the whole stage —
 * they ran on the default LLM before it had a route.
 */
export function summaryLlmClient(config: KnodeConfig): LlmClient {
  return new LlmClient(resolveRoutedLlmConfig(config.llm, config.extraction.summaryLlm, routeTargets(config)));
}

export async function createContext(dataDir: string): Promise<AppContext> {
  initDataDir(dataDir);
  const config = loadConfig(dataDir);
  const store = await Store.open(dataDir, config.embedding.dimensions, config.database);
  const embedder = createEmbeddingProvider(config.embedding);
  const llm = summaryLlmClient(config);
  const datasources = new DataSourceRegistry(dataDir, config.datasources);
  return { dataDir, config, store, embedder, llm, datasources };
}
