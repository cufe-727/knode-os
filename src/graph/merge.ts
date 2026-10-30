import crypto from 'node:crypto';
import { foldTouched } from '../lineage/fold.js';
import { appendLedger, lockLedger, nextLedgerSeq } from '../lineage/ledger.js';
import { applyScope, disposeScope, findLiveScope, foldOptions } from '../lineage/scope.js';
import { emptyTouched } from '../lineage/types.js';
import { Store } from '../store/db.js';
import { invalidateTier0Known } from './concepts.js';
import { EntityCorrection, readEntityCorrections, writeEntityCorrections } from './corrections.js';
import { nameKey } from './normalize.js';
import { entityTypeIds, loadOntology } from './ontology.js';
import { slugify } from './store.js';

/**
 * Merging two entities never rewrites evidence. It records a link — "A is the
 * same as B" — owned by a `merge` scope, sets `entities.canonical_id`, and lets
 * every read path redirect through it. Disposing that scope (unmerge) reverts
 * the link exactly like removing a source reverts its facts. The decision is
 * also written to the ledger as feedback, so `rebuild` replays it.
 *
 * Correcting one entity (correctEntity) does not rewrite evidence either: the
 * correction is a playbook entry the fold applies (src/graph/corrections.ts),
 * so a rebuild keeps it with the files.
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

export interface CorrectionInput {
  /** The entity's id, or the name it goes by (its own, not an alias). */
  entity: string;
  /** The type it is; null takes a corrected type back. */
  type?: string | null;
  /** Spellings it does not answer to, added to those it already refuses. */
  notAliases?: string[];
  /** Spellings taken off that list again. */
  allowAliases?: string[];
  /** Take the whole correction back. */
  clear?: boolean;
  reason?: string;
  actor?: string;
}

export interface CorrectionResult {
  id: string;
  name: string;
  /** Set when the entity is merged into another: reads show that one, so correct it for what they show. */
  mergedInto: string | null;
  correction: EntityCorrection | null;
  before: { type: string; aliases: string[] };
  after: { type: string; aliases: string[] };
}

interface CorrectedRow {
  id: string;
  name: string;
  type: string;
  aliases: string[];
  canonical_id: string | null;
}

async function correctedRow(store: Store, id: string): Promise<CorrectedRow | null> {
  const [row] = await store.query<CorrectedRow>(`SELECT id, name, type, aliases, canonical_id FROM entities WHERE id = $1 AND tx_to IS NULL`, [id]);
  return row ?? null;
}

/**
 * Record a person's correction of one entity — its type, spellings it does not
 * answer to — in playbooks/entities/corrections.yaml, log it as feedback, and
 * refold the entity so its row, aliases and lookup keys show it at once.
 */
export async function correctEntity(store: Store, input: CorrectionInput): Promise<CorrectionResult> {
  const actor = input.actor ?? 'user';
  const [found] = await store.query<{ id: string }>(
    `SELECT id FROM entities WHERE (id = $1 OR id = $2 OR name = $1) AND tx_to IS NULL
     ORDER BY (id = $1) DESC, (id = $2) DESC, mention_count DESC, id LIMIT 1`,
    [input.entity.trim(), slugify(input.entity)],
  );
  const before = found ? await correctedRow(store, found.id) : null;
  if (!before) throw new Error(`no live entity "${input.entity}"`);

  const entries = new Map(readEntityCorrections(store.dataDir));
  let next: EntityCorrection | null = null;
  if (!input.clear) {
    const fix: EntityCorrection = { ...entries.get(before.id) };
    if (input.type === null) delete fix.type;
    else if (input.type !== undefined) {
      const types = entityTypeIds(loadOntology(store.dataDir));
      if (!types.has(input.type)) throw new Error(`unknown entity type "${input.type}" (the ontology has ${[...types].join(', ')})`);
      fix.type = input.type;
    }
    const own = nameKey(before.name);
    const refused = new Map((fix.notAliases ?? []).map((s) => [nameKey(s).key, s] as const));
    for (const raw of input.notAliases ?? []) {
      const s = raw.trim();
      const { key } = nameKey(s);
      if (!key) continue;
      if (key === own.key || key === own.bare) throw new Error(`"${s}" is ${before.name}'s own name`);
      if (!refused.has(key)) refused.set(key, s);
    }
    for (const s of input.allowAliases ?? []) refused.delete(nameKey(s).key);
    if (refused.size > 0) fix.notAliases = [...refused.values()];
    else delete fix.notAliases;
    if (fix.type || fix.notAliases) {
      next = { ...fix, name: before.name, by: actor, at: new Date().toISOString() };
      if (input.reason) next.reason = input.reason;
    }
  }
  if (next) entries.set(before.id, next);
  else entries.delete(before.id);
  writeEntityCorrections(store.dataDir, entries);
  appendLedger(store.dataDir, {
    seq: await nextLedgerSeq(store), ts: new Date().toISOString(), ev: 'feedback', actor, kind: 'entity.correct', id: before.id,
    payload: next ? { type: next.type ?? null, notAliases: next.notAliases ?? [], reason: next.reason ?? '' } : { cleared: true },
  });

  const txTime = new Date().toISOString();
  await store.tx(async (q) => {
    // folds the entity row: queue on the ledger lock like every scope transaction
    await lockLedger(q);
    const touched = emptyTouched();
    touched.entities.add(before.id);
    await foldTouched(q, touched, txTime, foldOptions(store.dataDir));
  });
  invalidateTier0Known(store.dataDir);
  const after = (await correctedRow(store, before.id)) ?? before;
  return {
    id: before.id,
    name: after.name,
    mergedInto: after.canonical_id,
    correction: next,
    before: { type: before.type, aliases: before.aliases },
    after: { type: after.type, aliases: after.aliases },
  };
}
