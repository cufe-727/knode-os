import { KnodeConfig, loadConfig } from './config.js';
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
  llm: LlmClient;
}

export async function createContext(dataDir: string): Promise<AppContext> {
  initDataDir(dataDir);
  const config = loadConfig(dataDir);
  const store = await Store.open(dataDir, config.embedding.dimensions);
  const embedder = createEmbeddingProvider(config.embedding);
  const llm = new LlmClient(config.llm);
  return { dataDir, config, store, embedder, llm };
}
