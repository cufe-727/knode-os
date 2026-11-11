import fs from 'node:fs';
import path from 'node:path';
import { safePath } from '../fs/files.js';
import { disposeScope, findLiveScope } from '../lineage/scope.js';
import {
  entitiesTree, layoutTree, pageDirs, pagesTree, SHELF_REGION, sourcesTree, TreeSpec, treeRows, withTreeRows,
} from './nav-views.js';
import { archivePage, PagesContext, RegenerateOutcome, regeneratePage } from './pages.js';

/**
 * Keeping the wiki's navigation current (the views are in ./nav-views.ts):
 * the sources and entities trees, a tree per other wiki folder, the contents
 * of `wiki/index.md` and the overview's account of what the base holds.
 *
 * New documents and new summary pages are inputs no page has a dep on yet,
 * so nothing marks the indexes dirty when they arrive: the callers that run
 * anyway refresh them — `wiki generate`, the nightly refine, an
 * initialization, `knode-os extract`'s document pass and `serve`'s follow-up
 * review. A refresh reads each tree's rows once (one query over the
 * documents, one over the summary pages, one over the entity pages' claims),
 * re-plans every page of the trees from those rows in memory, and writes
 * only the pages whose text changed; `refreshNavigationIfChanged` first
 * compares a few counts and skips the whole refresh when none moved.
 */

export interface NavigationStats {
  written: string[];
  archived: string[];
  /** The refresh was skipped: nothing it counts changed since the last one. */
  skipped?: boolean;
}

/** Remove a paged file an archived view left empty, its folders if they are empty too, and its search projection. */
async function removeIfEmpty(ctx: PagesContext, file: string, actor: string): Promise<void> {
  const abs = safePath(ctx.dataDir, file);
  if (!fs.existsSync(abs) || fs.readFileSync(abs, 'utf8').trim() !== '') return;
  fs.unlinkSync(abs);
  const doc = await findLiveScope(ctx.store, 'doc', file);
  if (doc) await disposeScope(ctx.store, doc.id, { actor, reason: 'removed' });
  const wiki = safePath(ctx.dataDir, 'wiki');
  for (let dir = path.dirname(abs); dir.startsWith(wiki) && dir !== wiki; dir = path.dirname(dir)) {
    try {
      fs.rmdirSync(dir);
    } catch {
      break; // not empty
    }
  }
}

/** Refresh one tree: its hub, every paged file it has now, and the archiving of those it no longer has. Returns the hub's outcome. */
export function refreshTree(ctx: PagesContext, spec: TreeSpec, opts: { actor?: string; stats?: NavigationStats } = {}): Promise<RegenerateOutcome> {
  return withTreeRows(ctx.store, () => refreshTreeIn(ctx, spec, opts));
}

async function refreshTreeIn(ctx: PagesContext, spec: TreeSpec, opts: { actor?: string; stats?: NavigationStats }): Promise<RegenerateOutcome> {
  const actor = opts.actor ?? 'wiki';
  const stats = opts.stats ?? { written: [], archived: [] };
  const rows = await treeRows(ctx, spec);
  const layout = layoutTree(spec, rows);
  const hub = await regeneratePage(ctx, `${spec.hubFile}#${spec.hubRegion}`, spec.hubKind, { actor });
  if (hub === 'regenerated') stats.written.push(spec.hubFile);
  for (const file of layout.shelves.keys()) {
    const r = await regeneratePage(ctx, `${file}#${SHELF_REGION}`, spec.shelfKind, { actor });
    if (r === 'regenerated') stats.written.push(file);
  }
  // pages of the list this tree had and has no more: a shrunk folder, a re-paged one, a whole tree back inline
  const prefix = `${spec.base}/`;
  const old = await ctx.store.query<{ path: string; status: string }>(
    `SELECT path, status FROM pages WHERE kind = $1 AND starts_with(path, $2)`,
    [spec.shelfKind, prefix],
  );
  for (const p of old) {
    const file = p.path.split('#', 1)[0];
    if (layout.shelves.has(file)) continue;
    if (p.status !== 'archived') {
      await archivePage(ctx, p.path, actor);
      stats.archived.push(file);
    }
    await removeIfEmpty(ctx, file, actor);
  }
  return hub;
}

export const refreshSourcesTree = (ctx: PagesContext, opts: { actor?: string } = {}) => refreshTree(ctx, sourcesTree, opts);
export const refreshEntitiesTree = (ctx: PagesContext, opts: { actor?: string } = {}) => refreshTree(ctx, entitiesTree, opts);

/** Everything `wiki/index.md` leads to: the trees, the contents and the overview's holdings. */
export function ensureNavigation(ctx: PagesContext, opts: { actor?: string } = {}): Promise<NavigationStats> {
  return withTreeRows(ctx.store, () => ensureNavigationIn(ctx, opts));
}

async function ensureNavigationIn(ctx: PagesContext, opts: { actor?: string }): Promise<NavigationStats> {
  const actor = opts.actor ?? 'wiki';
  const stats: NavigationStats = { written: [], archived: [] };
  await refreshTree(ctx, sourcesTree, { actor, stats });
  await refreshTree(ctx, entitiesTree, { actor, stats });
  for (const { dir } of await pageDirs(ctx.store)) await refreshTree(ctx, pagesTree(dir), { actor, stats });
  for (const [pagePath, kind] of [['wiki/index.md#contents', 'wiki_contents'], ['wiki/overview.md#holdings', 'overview_holdings']] as const) {
    const r = await regeneratePage(ctx, pagePath, kind, { actor });
    if (r === 'regenerated') stats.written.push(pagePath.split('#', 1)[0]);
  }
  lastStamp.set(ctx.dataDir, await navigationStamp(ctx));
  return stats;
}

/**
 * What the navigation counts, in a few aggregates: the documents, the pages
 * (summaries and entity pages appear here), the entity pages and the claims.
 * A refresh whose stamp is unchanged would write nothing.
 */
async function navigationStamp(ctx: PagesContext): Promise<string> {
  const [row] = await ctx.store.query<Record<string, string | number | null>>(
    `SELECT (SELECT count(*)::int FROM documents WHERE status = 'indexed') AS docs,
            (SELECT max(updated_at)::text FROM documents WHERE status = 'indexed') AS docs_at,
            (SELECT count(*)::int FROM pages WHERE status <> 'archived') AS pages,
            (SELECT count(*)::int FROM entities WHERE wiki_path IS NOT NULL AND tx_to IS NULL AND canonical_id IS NULL) AS entity_pages,
            (SELECT count(*)::int FROM claims WHERE tx_to IS NULL AND canonical_id IS NULL) AS claims,
            (SELECT count(*)::int FROM extraction_queue) AS queued`,
  );
  return JSON.stringify(row);
}

const lastStamp = new Map<string, string>();

/** `ensureNavigation`, unless nothing it counts changed since the last refresh in this process. */
export async function refreshNavigationIfChanged(ctx: PagesContext, opts: { actor?: string } = {}): Promise<NavigationStats> {
  const stamp = await navigationStamp(ctx);
  if (lastStamp.get(ctx.dataDir) === stamp) return { written: [], archived: [], skipped: true };
  return ensureNavigation(ctx, opts);
}
