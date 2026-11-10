import fs from 'node:fs';
import path from 'node:path';
import { safePath } from '../../fs/files.js';
import { pluginRegistry } from '../../plugins/registry.js';
import { holdDest } from '../folders.js';
import { sync, SyncContext, SyncStats } from '../sync.js';
import { deleteFeedFile, feedDest, loadFeed } from './definitions.js';
import { DedupeIndex, FeedLedger } from './ledger.js';
import { connectorContext } from './run.js';
import type { FeedDefinition, UnitDecision } from './types.js';

/** What the API and the CLI need around feeds besides running them. */

/** The connectors and user-defined stages this process can run, for a form and `knode-os feeds connectors`. */
export function feedConnectorCatalog() {
  const registry = pluginRegistry();
  const owner = new Map<string, string>();
  for (const p of registry.describe()) {
    for (const id of p.feedConnectors) owner.set(`c:${id}`, p.name);
    for (const id of p.feedStages) owner.set(`s:${id}`, p.name);
  }
  return {
    connectors: registry.feedConnectors().map((c) => ({
      id: c.id,
      label: c.label,
      note: c.note ?? '',
      platform: c.platform ?? c.id,
      pushOnly: Boolean(c.pushOnly),
      params: c.params,
      defaults: c.defaults ?? {},
      minIntervalMinutes: c.minIntervalMinutes ?? 0,
      plugin: owner.get(`c:${c.id}`) ?? 'builtin',
    })),
    stages: registry.feedStages().map((s) => ({ id: s.id, label: s.label ?? s.id, kind: s.kind, version: s.version ?? null, plugin: owner.get(`s:${s.id}`) ?? 'api' })),
  };
}

export interface FeedItemView {
  unit: string;
  status: UnitDecision['status'];
  by: string;
  reason?: string;
  score?: number;
  tags?: string[];
  publishedAt: string;
  decidedAt: string;
  title: string;
  author: string | null;
  url: string | null;
  excerpt: string;
}

/** The feed's units as decided, newest first: what was kept, dropped and is waiting, and why. */
export function feedItems(dataDir: string, feed: FeedDefinition, opts: { status?: UnitDecision['status']; limit?: number } = {}): FeedItemView[] {
  const ledger = new FeedLedger(dataDir, feed.id);
  const list = ledger
    .allDecisions()
    .filter((d) => !opts.status || d.status === opts.status)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, opts.limit ?? 50);
  return list.map((d) => {
    const item = ledger.find(d.unit);
    const text = (d.output?.markdown ?? item?.text ?? '').replace(/\s+/g, ' ').trim();
    return {
      unit: d.unit,
      status: d.status,
      by: d.by,
      ...(d.reason ? { reason: d.reason } : {}),
      ...(d.score !== undefined ? { score: d.score } : {}),
      ...(d.tags?.length ? { tags: d.tags } : {}),
      publishedAt: d.publishedAt,
      decidedAt: d.at,
      title: d.output?.title ?? item?.title ?? '',
      author: item?.author?.name ?? null,
      url: item?.url ?? null,
      excerpt: text.length > 300 ? `${text.slice(0, 300)}…` : text,
    };
  });
}

/** Can the feed reach its source? Connectors without a check are tried with a preview-less answer. */
export async function checkFeed(ctx: SyncContext, feed: FeedDefinition): Promise<{ ok: boolean; message: string }> {
  const connector = pluginRegistry().feedConnector(feed.connector);
  if (!connector) return { ok: false, message: `unknown connector "${feed.connector}"` };
  if (connector.pushOnly) return { ok: true, message: 'this feed takes pushed items; there is nothing to reach' };
  if (!connector.check) return { ok: true, message: `${connector.label} has no check of its own — preview the feed to try it` };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 120_000);
  try {
    return await connector.check(connectorContext(ctx, feed, undefined, null, () => {}, abort.signal));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Delete a feed's definition. Its documents stay unless `removeFiles`
 * (then the feed's folder is removed and synced away); its ledger stays
 * unless `forgetLedger` — a feed made again under the same id then picks up
 * where it was.
 */
export async function deleteFeed(ctx: SyncContext, id: string, opts: { removeFiles?: boolean; forgetLedger?: boolean; onProgress?: (m: string) => void } = {}): Promise<{ id: string; removedFiles: string | null; forgotLedger: boolean; sync: SyncStats | null }> {
  const feed = loadFeed(ctx.dataDir, id);
  if (!feed) throw new Error(`no feed "${id}"`);
  deleteFeedFile(ctx.dataDir, id);
  let removedFiles: string | null = null;
  let stats: SyncStats | null = null;
  if (opts.removeFiles) {
    const dest = feedDest(feed);
    const abs = safePath(ctx.dataDir, dest);
    if (fs.existsSync(abs)) {
      const release = holdDest(ctx.dataDir, dest);
      try {
        fs.rmSync(abs, { recursive: true, force: true });
        removedFiles = dest;
        stats = await sync(ctx, { only: [dest], onProgress: opts.onProgress });
      } finally {
        release();
      }
    }
  }
  if (opts.forgetLedger) {
    fs.rmSync(new FeedLedger(ctx.dataDir, id).dir, { recursive: true, force: true });
    const dedupe = new DedupeIndex(ctx.dataDir);
    dedupe.release(id);
    dedupe.save();
  } else if (opts.removeFiles) {
    // the documents are gone: what the ledger says was written is stale
    fs.rmSync(path.join(new FeedLedger(ctx.dataDir, id).dir, 'docs.json'), { force: true });
  }
  return { id, removedFiles, forgotLedger: Boolean(opts.forgetLedger), sync: stats };
}
