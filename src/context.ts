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
   * The Judge stage (`judgeLlmClient`), not the default model. Rebuilt
   * whenever the config, or an agent its route may name, changes.
   */
  llm: LlmClient;
  /** Lazily-connected external live data sources (mysql / timescale / duckdb). */
  datasources: DataSourceRegistry;
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

export async function createContext(dataDir: string): Promise<AppContext> {
  initDataDir(dataDir);
  const config = loadConfig(dataDir);
  const store = await Store.open(dataDir, config.embedding.dimensions, config.database);
  const embedder = createEmbeddingProvider(config.embedding);
  const llm = judgeLlmClient(config);
  const datasources = new DataSourceRegistry(dataDir, config.datasources);
  return { dataDir, config, store, embedder, llm, datasources };
}
