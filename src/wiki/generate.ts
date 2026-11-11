import { KnodeConfig, defaultConfig } from '../config.js';
import { DataSourceRegistry } from '../datasource/registry.js';
import { appendLog } from '../fs/datadir.js';
import { createEmbeddingProvider, EmbeddingProvider } from '../ingest/embeddings.js';
import { LlmClient } from '../llm/client.js';
import { Store } from '../store/db.js';
import { ensureNavigation } from './navigation.js';
import { ensureEntitiesIndex, ensureEntityStubs, ensureSourceSummaries, ensureSourcesIndex, PagesContext, reconcileViews } from './pages.js';

/**
 * Wiki generation (llm_wiki's two-step ingest, generation half) on top of
 * the page-view runtime:
 * - summary pages under wiki/sources/ for documents still missing one, up to
 *   `limit` — the background document pass writes them as documents arrive
 *   (docs/design/09); this fills gaps by hand
 * - a page per live entity worth one under wiki/entities/ (several documents
 *   speak of it, or it holds a few claims), listed in wiki/entities/index.md
 * - a managed "sources" region in wiki/sources/index.md listing every document,
 *   paged by folder past 200 (./nav-views.ts), the contents of wiki/index.md
 *   and the overview's account of what the base holds
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
  // on the Summarize stage's own route, which says whether it can run
  created.push(...await ensureSourceSummaries(ctx, { limit: opts.limit ?? 20, actor: 'wiki', onProgress: progress }));
  created.push(...await ensureEntityStubs(ctx, { actor: 'wiki' }));
  await ensureSourcesIndex(ctx, { actor: 'wiki' });
  const rec = await reconcileViews(ctx, { actor: 'wiki', llm: true, onProgress: progress });
  // after the pages are in their current form: the index lists what each one now holds
  await ensureEntitiesIndex(ctx, { actor: 'wiki' });
  // the contents of index.md, the other folders' lists and the overview's holdings
  await ensureNavigation(ctx, { actor: 'wiki' });
  if (created.length > 0 || rec.regenerated > 0) {
    appendLog(store.dataDir, 'wiki', `${created.length} pages created, ${rec.regenerated} regenerated, ${rec.archived} archived`);
  }
  return created;
}

export { ensureEntityStubs as generateEntityStubs } from './pages.js';
