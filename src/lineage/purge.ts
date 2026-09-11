import fs from 'node:fs';
import path from 'node:path';
import { rawToCookedPath } from '../ingest/cook.js';
import { sync, SyncContext } from '../ingest/sync.js';
import { safePath } from '../fs/files.js';
import { Store } from '../store/db.js';
import { gcOrphanRows, purgeScope, PurgeResult, scopesForKey } from './scope.js';
import { ScopeRow } from './types.js';

/**
 * Forgetting. A plain delete is a *dispose*: history stays queryable with
 * `as_of`. `forget` additionally purges the disposed scopes (evidence history,
 * attic sidecar, previous file versions), which is what "remove every trace of
 * this source" means. `purge` compacts old history in bulk.
 */

export interface ForgetResult {
  key: string;
  removedFile: boolean;
  disposed: number;
  purged: string[];
}

/** Delete a source file, dispose it, then purge its history. */
export async function forgetSource(ctx: SyncContext, target: string): Promise<ForgetResult> {
  const rel = target.replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = safePath(ctx.dataDir, rel);
  let removedFile = false;
  if (fs.existsSync(abs)) {
    fs.rmSync(abs, { recursive: true, force: true });
    removedFile = true;
  }
  const key = rel.startsWith('raw/docs/') ? rawToCookedPath(rel) : rel;
  const stats = await sync(ctx, { only: [rel], actor: 'forget' });
  const purged: string[] = [];
  for (const s of await scopesForKey(ctx.store, 'doc', key)) {
    if (s.status !== 'disposed') continue;
    const res = await purgeScope(ctx.store, s.id, { actor: 'forget' });
    purged.push(...res.purged);
  }
  return { key, removedFile, disposed: stats.disposed, purged };
}

export interface PurgeSummary extends PurgeResult {
  scopes: number;
  evidenceCompacted: number;
}

/** Purge every disposed root scope (optionally only those disposed before `before`) and compact closed evidence. */
export async function purgeDisposed(store: Store, opts: { before?: string; actor?: string } = {}): Promise<PurgeSummary> {
  const rows = opts.before
    ? await store.query<ScopeRow>(`SELECT * FROM scopes WHERE status = 'disposed' AND parent_id IS NULL AND disposed_at < $1::timestamptz ORDER BY disposed_at`, [opts.before])
    : await store.query<ScopeRow>(`SELECT * FROM scopes WHERE status = 'disposed' AND parent_id IS NULL ORDER BY disposed_at`);
  const summary: PurgeSummary = { purged: [], orphansRemoved: { claims: 0, relations: 0, entities: 0 }, scopes: 0, evidenceCompacted: 0 };
  for (const s of rows) {
    // a disposed root whose children are still live cannot happen (children dispose first); skip defensively
    const liveChildren = await store.query<{ id: string }>(`SELECT id FROM scopes WHERE parent_id = $1 AND status <> 'disposed'`, [s.id]);
    if (liveChildren.length) continue;
    const res = await purgeScope(store, s.id, { actor: opts.actor });
    summary.purged.push(...res.purged);
    summary.scopes++;
    summary.orphansRemoved.claims += res.orphansRemoved.claims;
    summary.orphansRemoved.relations += res.orphansRemoved.relations;
    summary.orphansRemoved.entities += res.orphansRemoved.entities;
  }
  if (opts.before) {
    const compacted = await store.tx(async (q) => {
      const r = await q.query<{ id: number }>(`DELETE FROM evidence WHERE tx_to IS NOT NULL AND tx_to < $1::timestamptz RETURNING id`, [opts.before]);
      const gc = await gcOrphanRows(q);
      summary.orphansRemoved.claims += gc.claims;
      summary.orphansRemoved.relations += gc.relations;
      summary.orphansRemoved.entities += gc.entities;
      return r.length;
    });
    summary.evidenceCompacted = compacted;
  }
  return summary;
}

/** Delete archived wiki pages (wiki/.archive/**). Returns the number of files removed. */
export function purgeArchived(dataDir: string): number {
  const root = path.join(dataDir, 'wiki', '.archive');
  if (!fs.existsSync(root)) return 0;
  let n = 0;
  const visit = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) visit(p);
      else {
        fs.rmSync(p, { force: true });
        n++;
      }
    }
  };
  visit(root);
  fs.rmSync(root, { recursive: true, force: true });
  return n;
}
