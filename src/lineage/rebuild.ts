import fs from 'node:fs';
import path from 'node:path';
import { AppContext } from '../context.js';
import { Sidecar } from '../fs/sidecar.js';
import { applyExtraction } from '../graph/llm-extract.js';
import { applyClaimMerge, unmergeClaim } from '../graph/claim-merge.js';
import { applyMerge, unmergeEntity } from '../graph/merge.js';
import { PageContext } from '../graph/store.js';
import { documentIdFor } from '../ingest/apply.js';
import { sync, SyncStats } from '../ingest/sync.js';
import { pgliteDir } from '../store/backend.js';
import { Store } from '../store/db.js';
import { readAtticSidecar } from './attic.js';
import { appendLedger, ledgerTimeline, nextLedgerSeq, readLedger, seedLedgerSeq } from './ledger.js';
import { applyScope, disposeScope } from './scope.js';
import { ScopeKind } from './types.js';

/**
 * `knode-os rebuild` — drop the derived database and reconstruct it from the
 * files plus the ledger. Sources that are unchanged since their last logged
 * apply keep their original `tx_from`; with `--history`, sources that were
 * removed but whose sidecars survive in the attic are re-applied and
 * re-disposed at their original times, so graph-layer `as_of` queries answer
 * the same way they did before the rebuild.
 */

export interface RebuildReport {
  sync: SyncStats;
  feedbackReplayed: number;
  historyReplayed: number;
}

export async function rebuild(ctx: AppContext, opts: { history?: boolean; onProgress?: (msg: string) => void } = {}): Promise<RebuildReport> {
  const progress = opts.onProgress ?? (() => {});
  const dataDir = ctx.dataDir;
  await ctx.store.close();
  // the embedded database's directory; on a server backend there is nothing on disk to drop
  fs.rmSync(pgliteDir(dataDir, ctx.config.database), { recursive: true, force: true });
  ctx.store = await Store.open(dataDir, ctx.config.embedding.dimensions, ctx.config.database);
  const store = ctx.store;
  await seedLedgerSeq(store, dataDir);

  const timeline = ledgerTimeline(dataDir);
  const at = (kind: ScopeKind, key: string, sha?: string): string | undefined => {
    const t = timeline.get(`${kind}:${key}`);
    if (!t?.apply || t.dispose) return undefined;
    if (sha !== undefined && t.apply.scope.sha !== sha) return undefined;
    return t.apply.ts;
  };
  progress('rebuild: re-applying declared sources');
  const stats = await sync(ctx, { actor: 'rebuild', at, onProgress: progress });

  // human decisions recorded as feedback
  let feedbackReplayed = 0;
  for (const ev of readLedger(dataDir)) {
    if (ev.ev !== 'feedback') continue;
    if (ev.kind === 'suggestion.status') {
      const status = (ev.payload as { status?: string } | undefined)?.status;
      if (!status) continue;
      const r = await store.query<{ id: string }>(`UPDATE suggestions SET status = $2 WHERE id = $1 RETURNING id`, [ev.id, status]);
      if (r.length) feedbackReplayed++;
    } else if (ev.kind === 'entity.merge') {
      // entity merges are decisions, not derivations: replayed in ledger order
      const p = ev.payload as { canonicalId?: string; reason?: string } | undefined;
      if (!p?.canonicalId) continue;
      try {
        await applyMerge(store, { entityId: ev.id, canonicalId: p.canonicalId, reason: p.reason, actor: ev.actor, log: false });
        feedbackReplayed++;
      } catch (err) {
        progress(`merge replay skipped for ${ev.id}: ${err instanceof Error ? err.message : err}`);
      }
    } else if (ev.kind === 'entity.unmerge') {
      if (await unmergeEntity(store, ev.id, { actor: ev.actor, log: false })) feedbackReplayed++;
    } else if (ev.kind === 'claim.merge') {
      // claim merges too (docs/design/10): a merge of claims that no longer exist is skipped
      const p = ev.payload as { canonicalId?: string; kind?: 'same_as' | 'contains'; reason?: string; confidence?: number | null } | undefined;
      if (!p?.canonicalId) continue;
      try {
        await applyClaimMerge(store, { claimId: ev.id, canonicalId: p.canonicalId, kind: p.kind, reason: p.reason, confidence: p.confidence ?? null, actor: ev.actor, log: false });
        feedbackReplayed++;
      } catch (err) {
        progress(`claim merge replay skipped for ${ev.id}: ${err instanceof Error ? err.message : err}`);
      }
    } else if (ev.kind === 'claim.unmerge') {
      if (await unmergeClaim(store, ev.id, { actor: ev.actor, log: false })) feedbackReplayed++;
    }
  }

  // removed sources with an attic sidecar: replay their graph contribution on the original timeline
  let historyReplayed = 0;
  if (opts.history) {
    for (const [k, t] of timeline) {
      if (!t.apply || !t.dispose || !k.startsWith('doc:')) continue;
      const attic = t.dispose.attic;
      if (!attic) continue;
      const sidecar = readAtticSidecar(dataDir, attic);
      if (!sidecar) continue;
      const key = t.apply.scope.key;
      try {
        const scope = await applyAtticScope(store, key, sidecar, { at: t.apply.ts });
        if (scope) {
          await disposeScope(store, scope, { actor: 'rebuild', reason: 'removed', at: t.dispose.ts, log: false });
          historyReplayed++;
        }
      } catch (err) {
        progress(`history replay failed for ${key}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  await store.query(`DELETE FROM meta WHERE key = 'lineage_rebuild'`);
  const seq = await nextLedgerSeq(store);
  appendLedger(dataDir, { seq, ts: new Date().toISOString(), ev: 'rebuild', actor: 'rebuild', note: opts.history ? 'with history' : undefined });
  return { sync: stats, feedbackReplayed, historyReplayed };
}

/** Graph-only re-apply of a removed document from its attic sidecar (no chunks, no mentions). */
async function applyAtticScope(store: Store, key: string, sidecar: Sidecar, opts: { at: string }): Promise<string | null> {
  const docId = documentIdFor(key);
  const page: PageContext = { documentId: docId, path: key, title: sidecar.meta.title ?? path.posix.basename(key), chunkIds: [] };
  const res = await applyScope(
    store,
    { kind: 'doc', key },
    sidecar.meta.contentSha256,
    { actor: 'rebuild', at: opts.at, log: false, replace: false, meta: { documentId: docId, historical: true, embedModel: '' } },
    async (w) => {
      for (const term of sidecar.extraction.tier0?.concepts ?? []) {
        await w.entity({ name: term, type: 'concept' }, { extractor: 'tier0.concept' });
      }
      const linked: string[] = [];
      for (const target of sidecar.extraction.tier0?.wikilinks ?? []) {
        const name = path.posix.basename(target.replace(/\.md$/i, ''));
        if (name) linked.push(await w.entity({ name, type: 'concept' }, { extractor: 'tier0.wikilink' }));
      }
      await w.coOccurrence(linked, { weight: 0.3, window: 12, extractor: 'tier0.wikilink' });
      const declared = sidecar.extraction.tier0?.declared;
      const docDate = sidecar.meta.docDate ?? null;
      if (declared) await applyExtraction(w, page, declared.entities, declared.relations ?? [], declared.claims, 'tier0.frontmatter', { docDate });
      const t1 = sidecar.extraction.tier1;
      if (t1 && t1.status === 'done' && t1.contentSha === sidecar.meta.contentSha256) {
        await applyExtraction(w, page, t1.entities, t1.relations, t1.claims ?? [], `tier1.llm:${t1.model}`, { docDate });
      }
    },
  );
  return res.outcome === 'applied' ? res.scope.id : null;
}
