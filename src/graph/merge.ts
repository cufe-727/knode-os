import crypto from 'node:crypto';
import { appendLedger, nextLedgerSeq } from '../lineage/ledger.js';
import { applyScope, disposeScope, findLiveScope } from '../lineage/scope.js';
import { Store } from '../store/db.js';

/**
 * Merging two entities never rewrites evidence. It records a link — "A is the
 * same as B" — owned by a `merge` scope, sets `entities.canonical_id`, and lets
 * every read path redirect through it. Disposing that scope (unmerge) reverts
 * the link exactly like removing a source reverts its facts. The decision is
 * also written to the ledger as feedback, so `rebuild` replays it.
 */

export interface MergeInput {
  /** The entity being folded into another. */
  entityId: string;
  /** The survivor. */
  canonicalId: string;
  reason?: string;
  actor?: string;
  /** Write the ledger feedback line (default true; rebuild passes false). */
  log?: boolean;
}

export interface MergeResult {
  entityId: string;
  canonicalId: string;
  outcome: 'merged' | 'unchanged';
  scopeId: string;
}

interface EntityLite {
  id: string;
  name: string;
  canonical_id: string | null;
  tx_to: string | null;
}

async function entity(store: Store, id: string): Promise<EntityLite | null> {
  const [row] = await store.query<EntityLite>(`SELECT id, name, canonical_id, tx_to FROM entities WHERE id = $1`, [id]);
  return row ?? null;
}

export async function applyMerge(store: Store, input: MergeInput): Promise<MergeResult> {
  const actor = input.actor ?? 'user';
  const from = await entity(store, input.entityId);
  if (!from || from.tx_to) throw new Error(`entity "${input.entityId}" is not live`);
  let into = await entity(store, input.canonicalId);
  if (!into || into.tx_to) throw new Error(`entity "${input.canonicalId}" is not live`);
  // merging into an entity that was itself merged lands on the survivor of that merge
  if (into.canonical_id) {
    const survivor = await entity(store, into.canonical_id);
    if (survivor && !survivor.tx_to) into = survivor;
  }
  if (from.id === into.id) throw new Error('an entity cannot be merged into itself');
  if (into.canonical_id === from.id) throw new Error(`"${into.id}" is already merged into "${from.id}"`);

  const res = await applyScope(
    store,
    { kind: 'merge', key: from.id },
    crypto.createHash('sha256').update(into.id).digest('hex').slice(0, 24),
    { actor, meta: { entityId: from.id, canonicalId: into.id, reason: input.reason ?? '' }, log: input.log },
    async (w) => {
      await w.linkEntity({ entityId: from.id, canonicalId: into.id, reason: input.reason, actor });
    },
  );
  if (res.outcome === 'applied' && (input.log ?? true)) {
    const seq = await nextLedgerSeq(store);
    appendLedger(store.dataDir, {
      seq, ts: new Date().toISOString(), ev: 'feedback', actor, kind: 'entity.merge', id: from.id,
      payload: { canonicalId: into.id, reason: input.reason ?? '' },
    });
  }
  return { entityId: from.id, canonicalId: into.id, outcome: res.outcome === 'applied' ? 'merged' : 'unchanged', scopeId: res.scope.id };
}

export async function unmergeEntity(store: Store, entityId: string, opts: { actor?: string; log?: boolean } = {}): Promise<boolean> {
  const scope = await findLiveScope(store, 'merge', entityId);
  if (!scope) return false;
  await disposeScope(store, scope.id, { actor: opts.actor ?? 'user', reason: 'removed', log: opts.log });
  if (opts.log ?? true) {
    const seq = await nextLedgerSeq(store);
    appendLedger(store.dataDir, { seq, ts: new Date().toISOString(), ev: 'feedback', actor: opts.actor ?? 'user', kind: 'entity.unmerge', id: entityId });
  }
  return true;
}

export interface MergeRow {
  id: string;
  entityId: string;
  entityName: string;
  canonicalId: string;
  canonicalName: string;
  actor: string | null;
  reason: string;
  createdAt: string;
}

export async function listMerges(store: Store, limit = 200): Promise<MergeRow[]> {
  const rows = await store.query<{ id: string; entity_id: string; entity_name: string; canonical_id: string; canonical_name: string; actor: string | null; reason: string; created_at: string | Date }>(
    `SELECT l.id, l.entity_id, e.name AS entity_name, l.canonical_id, c.name AS canonical_name, l.actor, l.reason, l.created_at
     FROM entity_links l
     JOIN entities e ON e.id = l.entity_id
     JOIN entities c ON c.id = l.canonical_id
     WHERE l.tx_to IS NULL ORDER BY l.created_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id, entityId: r.entity_id, entityName: r.entity_name, canonicalId: r.canonical_id, canonicalName: r.canonical_name,
    actor: r.actor, reason: r.reason, createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}
