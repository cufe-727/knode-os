import { KnodeConfig, defaultConfig } from '../config.js';
import { DataSourceRegistry } from '../datasource/registry.js';
import { appendLog } from '../fs/datadir.js';
import { createEmbeddingProvider, EmbeddingProvider } from '../ingest/embeddings.js';
import { LlmClient } from '../llm/client.js';
import { Store } from '../store/db.js';
import { ensureEntityStubs, ensureSourceSummaries, ensureSourcesIndex, PagesContext, reconcileViews } from './pages.js';

/**
 * Wiki generation (llm_wiki's two-step ingest, generation half) on top of
 * the page-view runtime:
 * - one summary page per hot/fresh document under wiki/sources/
 * - one stub page per live extracted entity under wiki/entities/
 * - a managed "sources" region in wiki/sources/index.md listing every document
 * Every page declares its inputs; later syncs regenerate or archive it as the
 * graph changes. Returns the paths generated in this run.
 */
export async function generateWiki(
  store: Store,
  llm: LlmClient,
  opts: {
    limit?: number;
    config?: KnodeConfig;
    onProgress?: (msg: string) => void;
    embedder?: EmbeddingProvider;
    datasources?: DataSourceRegistry;
  } = {},
): Promise<string[]> {
  const progress = opts.onProgress ?? (() => {});
  const config = opts.config ?? defaultConfig();
  const ctx: PagesContext = {
    store,
    dataDir: store.dataDir,
    config,
    llm,
    embedder: opts.embedder ?? createEmbeddingProvider(config.embedding),
    datasources: opts.datasources,
  };
  const created: string[] = [];
  if (llm.enabled) {
    created.push(...await ensureSourceSummaries(ctx, { limit: opts.limit ?? 20, actor: 'wiki', onProgress: progress }));
  }
  created.push(...await ensureEntityStubs(ctx, { actor: 'wiki' }));
  await ensureSourcesIndex(ctx, { actor: 'wiki' });
  const rec = await reconcileViews(ctx, { actor: 'wiki', llm: true, onProgress: progress });
  if (created.length > 0 || rec.regenerated > 0) {
    appendLog(store.dataDir, 'wiki', `${created.length} pages created, ${rec.regenerated} regenerated, ${rec.archived} archived`);
  }
  return created;
}

export { ensureEntityStubs as generateEntityStubs } from './pages.js';
