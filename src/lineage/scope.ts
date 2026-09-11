import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { safePath } from '../fs/files.js';
import { Store } from '../store/db.js';
import { Queryable } from '../store/migrations.js';
import { moveSidecarToAttic, readBlob, removeAtticSidecar, removeBlob } from './attic.js';
import { emptyPropagation, Propagation, propagate, writeDeps } from './deps.js';
import { FoldResult, foldTouched } from './fold.js';
import { appendLedger, LedgerScopeRef, nextLedgerSeq } from './ledger.js';
import { TrustTier, tierForActor } from './trust.js';
import { DisposeReason, emptyTouched, InverseSpec, ScopeKind, ScopeRow, TouchedSet, WriterStats } from './types.js';
import { runFsOps, ScopeWriter } from './writer.js';
import { replaceRegion } from '../wiki/regions.js';

/**
 * Scope runtime — temporal composability for the knowledge base.
 *
 *   applyScope    open a scope for (kind, key, sha), run the body through a
 *                 ScopeWriter, fold the touched aggregates, propagate to
 *                 dependents, commit, then run file effects and log the event.
 *                 Same (kind, key, sha) → `unchanged` before any write.
 *   disposeScope  children first, then close this scope's evidence, drop its
 *                 mentions / projection, replay explicit inverses in reverse
 *                 order, fold, propagate, tombstone.
 *   purgeScope    physically erase a disposed scope (evidence history, attic).
 */

export interface ApplyOptions {
  parentId?: string | null;
  actor?: string;
  /** Transaction time (ISO). Defaults to now; rebuild passes the original apply time. */
  at?: string;
  meta?: Record<string, unknown>;
  /** Dispose a live scope with a different sha before applying (default true). */
  replace?: boolean;
  /** Re-apply even when the sha matches (e.g. embedding model changed). */
  force?: boolean;
  /**
   * When replacing a document scope, keep chunks/embeddings in place so the
   * new apply can reuse unchanged content-addressed chunks (default: true for
   * kind 'doc').
   */
  keepProjectionOnReplace?: boolean;
  /** Write the ledger line (default true; rebuild's historical replays pass false). */
  log?: boolean;
  /**
   * Trust tier for everything this scope writes. Defaults to the actor's tier,
   * so an agent's own write is quarantined without every call site having to
   * remember to say so.
   */
  trust?: TrustTier;
  /** Actors allowed to read what this scope produced; empty = unrestricted. */
  acl?: string[];
}

export interface ApplyResult {
  scope: ScopeRow;
  outcome: 'applied' | 'unchanged';
  touched: TouchedSet;
  fold: FoldResult | null;
  propagation: Propagation;
  stats: WriterStats;
}

export interface DisposeOptions {
  actor?: string;
  reason: DisposeReason;
  at?: string;
  /** Leave chunks/embeddings for the replacing apply to reconcile. */
  keepProjection?: boolean;
  /** Write the ledger line (default true). */
  log?: boolean;
}

export interface DisposeResult {
  scope: ScopeRow;
  touched: TouchedSet;
  fold: FoldResult;
  propagation: Propagation;
  children: string[];
}

export function scopeRef(s: ScopeRow): LedgerScopeRef {
  return { id: s.id, kind: s.kind, key: s.key, sha: s.sha, parent: s.parent_id };
}

export async function findLiveScope(q: Queryable, kind: ScopeKind, key: string): Promise<ScopeRow | null> {
  const rows = await q.query<ScopeRow>(`SELECT * FROM scopes WHERE kind = $1 AND key = $2 AND status <> 'disposed' LIMIT 1`, [kind, key]);
  return rows[0] ? normalizeScope(rows[0]) : null;
}

export async function scopeById(q: Queryable, id: string): Promise<ScopeRow | null> {
  const rows = await q.query<ScopeRow>(`SELECT * FROM scopes WHERE id = $1`, [id]);
  return rows[0] ? normalizeScope(rows[0]) : null;
}

export async function liveChildren(q: Queryable, parentId: string): Promise<ScopeRow[]> {
  const rows = await q.query<ScopeRow>(
    `SELECT * FROM scopes WHERE parent_id = $1 AND status <> 'disposed' ORDER BY applied_at DESC, id DESC`,
    [parentId],
  );
  return rows.map(normalizeScope);
}

export async function scopesForKey(q: Queryable, kind: ScopeKind, key: string): Promise<ScopeRow[]> {
  const rows = await q.query<ScopeRow>(`SELECT * FROM scopes WHERE kind = $1 AND key = $2 ORDER BY applied_at DESC`, [kind, key]);
  return rows.map(normalizeScope);
}

function normalizeScope(row: ScopeRow): ScopeRow {
  return {
    ...row,
    applied_at: isoOf(row.applied_at),
    disposed_at: row.disposed_at ? isoOf(row.disposed_at) : null,
    meta: row.meta ?? {},
  };
}

function isoOf(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

/** Apply a source. See module doc. */
export async function applyScope(
  store: Store,
  key: { kind: ScopeKind; key: string },
  sha: string,
  opts: ApplyOptions,
  body: (w: ScopeWriter) => Promise<void>,
): Promise<ApplyResult> {
  const actor = opts.actor ?? 'system';
  const live = await findLiveScope(store, key.kind, key.key);
  if (live && live.sha === sha && !opts.force) {
    return { scope: live, outcome: 'unchanged', touched: emptyTouched(), fold: null, propagation: emptyPropagation(), stats: zeroStats() };
  }
  if (live && (opts.replace ?? true)) {
    await disposeScope(store, live.id, {
      actor,
      reason: 'replaced',
      at: opts.at,
      keepProjection: opts.keepProjectionOnReplace ?? key.kind === 'doc',
      log: opts.log,
    });
  }

  const txTime = opts.at ?? new Date().toISOString();
  const id = crypto.createHash('sha256').update(`${key.kind}|${key.key}|${sha}|${txTime}|${opts.parentId ?? ''}`).digest('hex').slice(0, 24);
  const scope: ScopeRow = {
    id,
    kind: key.kind,
    key: key.key,
    sha,
    parent_id: opts.parentId ?? null,
    status: 'applying',
    actor,
    applied_at: txTime,
    disposed_at: null,
    meta: opts.meta ?? {},
  };
  const trust = opts.trust ?? tierForActor(actor);
  const acl = opts.acl ?? [];

  let writer!: ScopeWriter;
  let seq = 0;
  let result!: ApplyResult;
  await store.tx(async (q) => {
    await q.query(
      `INSERT INTO scopes (id, kind, key, sha, parent_id, status, actor, applied_at, meta, trust, acl)
       VALUES ($1, $2, $3, $4, $5, 'applying', $6, $7::timestamptz, $8::jsonb, $9, $10::jsonb)`,
      [id, scope.kind, scope.key, sha, scope.parent_id, actor, txTime, JSON.stringify(scope.meta), trust, JSON.stringify(acl)],
    );
    seq = await nextLedgerSeq(q);
    writer = new ScopeWriter(q, scope, txTime, store.dataDir, trust);
    await body(writer);
    const fold = await foldTouched(q, writer.touched, txTime);
    const propagation = await propagate(q, fold.changed, fold.tombstoned, txTime);
    await q.query(`UPDATE scopes SET status = 'active' WHERE id = $1`, [id]);
    scope.status = 'active';
    result = { scope, outcome: 'applied', touched: writer.touched, fold, propagation, stats: writer.stats };
  });

  runFsOps(store.dataDir, writer.fsOps);
  if (opts.log ?? true) {
    appendLedger(store.dataDir, {
      seq,
      ts: txTime,
      ev: 'apply',
      actor,
      scope: scopeRef(scope),
      stats: { evidence: writer.stats.entities + writer.stats.relations + writer.stats.claims, effects: writer.stats.effects, chunks: writer.stats.chunks },
    });
  }
  return result;
}

/** Dispose a scope: revert everything it produced (children first). */
export async function disposeScope(store: Store, scopeId: string, opts: DisposeOptions): Promise<DisposeResult | null> {
  const scope = await scopeById(store, scopeId);
  if (!scope || scope.status === 'disposed') return null;
  const actor = opts.actor ?? 'system';
  const children = await liveChildren(store, scopeId);
  for (const child of children) {
    await disposeScope(store, child.id, { actor, reason: opts.reason, at: opts.at, keepProjection: false, log: opts.log });
  }

  const txTime = opts.at ?? new Date().toISOString();
  const fsInverses: InverseSpec[] = [];
  let seq = 0;
  let result!: DisposeResult;
  const documentId = typeof scope.meta.documentId === 'string' ? scope.meta.documentId : null;

  await store.tx(async (q) => {
    const touched = emptyTouched();
    const tombstoned = emptyTouched();

    const ev = await q.query<{ kind: string; target_id: string }>(
      `UPDATE evidence SET tx_to = $2::timestamptz WHERE scope_id = $1 AND tx_to IS NULL RETURNING kind, target_id`,
      [scopeId, txTime],
    );
    for (const r of ev) {
      if (r.kind === 'entity') touched.entities.add(r.target_id);
      else if (r.kind === 'relation') touched.relations.add(r.target_id);
      else if (r.kind === 'claim') touched.claims.add(r.target_id);
    }
    const mentions = await q.query<{ entity_id: string }>(`DELETE FROM entity_mentions WHERE scope_id = $1 RETURNING entity_id`, [scopeId]);
    for (const m of mentions) touched.entities.add(m.entity_id);

    // capabilities, their locators and their notes are scope-owned: closing
    // them here is what retires a source's query surface along with the source
    for (const table of ['capabilities', 'capability_notes', 'locators']) {
      await q.query(`UPDATE ${table} SET tx_to = $2::timestamptz WHERE scope_id = $1 AND tx_to IS NULL`, [scopeId, txTime]);
    }

    if (documentId && !opts.keepProjection) {
      await q.query(`DELETE FROM chunks WHERE document_id = $1`, [documentId]);
      await q.query(`UPDATE documents SET status = 'disposed', scope_id = NULL, updated_at = now() WHERE id = $1`, [documentId]);
      touched.documents.add(scope.key);
      tombstoned.documents.add(scope.key);
    }

    const effects = await q.query<{ seq: number; kind: string; target: string; inverse: InverseSpec }>(
      `SELECT seq, kind, target, inverse FROM effects WHERE scope_id = $1 AND reverted_at IS NULL ORDER BY seq DESC`,
      [scopeId],
    );
    for (const e of effects) {
      await revertEffect(q, e.inverse, opts.reason, txTime, touched, tombstoned, fsInverses);
      await q.query(`UPDATE effects SET reverted_at = $2::timestamptz WHERE seq = $1`, [e.seq, txTime]);
    }

    const fold = await foldTouched(q, touched, txTime);
    for (const d of tombstoned.documents) fold.tombstoned.documents.add(d);
    for (const d of tombstoned.datasets) fold.tombstoned.datasets.add(d);
    for (const d of touched.documents) fold.changed.documents.add(d);
    for (const d of touched.datasets) fold.changed.datasets.add(d);
    const propagation = await propagate(q, fold.changed, fold.tombstoned, txTime, { archive: opts.reason !== 'replaced' });

    await q.query(
      `UPDATE scopes SET status = 'disposed', disposed_at = $2::timestamptz, meta = meta || $3::jsonb WHERE id = $1`,
      [scopeId, txTime, JSON.stringify({ reason: opts.reason })],
    );
    seq = await nextLedgerSeq(q);
    result = { scope: { ...scope, status: 'disposed', disposed_at: txTime }, touched, fold, propagation, children: children.map((c) => c.id) };
  });

  runInverseFsOps(store.dataDir, fsInverses, opts.reason);
  let attic: string | null = null;
  if (scope.kind === 'doc' && opts.reason === 'removed' && scope.key.startsWith('cooked/docs/')) {
    const abs = safePath(store.dataDir, scope.key);
    if (fs.existsSync(abs)) fs.rmSync(abs, { force: true });
    if (moveSidecarToAttic(store.dataDir, scope.key, scopeId)) attic = scopeId;
  }
  if (opts.log ?? true) {
    appendLedger(store.dataDir, { seq, ts: txTime, ev: 'dispose', actor, scope: scopeRef(scope), reason: opts.reason, attic });
  }
  return result;
}

async function revertEffect(
  q: Queryable,
  inv: InverseSpec,
  reason: DisposeReason,
  txTime: string,
  touched: TouchedSet,
  tombstoned: TouchedSet,
  fsInverses: InverseSpec[],
): Promise<void> {
  switch (inv.op) {
    case 'wiki_path.restore':
      await q.query(`UPDATE entities SET wiki_path = $2 WHERE id = $1`, [inv.entityId, inv.prev]);
      return;
    case 'row.restore': {
      if (inv.prev) {
        const p = inv.prev;
        await q.query(
          `UPDATE datasets SET source_id = $2, table_name = $3, kind = $4, columns = $5::jsonb, row_count = $6, schema_sha = $7,
                  description = $8, entity_count = $9, refreshed_at = $10, scope_id = $11, tx_from = $12::timestamptz, tx_to = $13
           WHERE id = $1`,
          [inv.id, p.source_id, p.table_name, p.kind, JSON.stringify(p.columns ?? []), p.row_count ?? null, p.schema_sha ?? '',
            p.description ?? '', p.entity_count ?? 0, p.refreshed_at ?? null, p.scope_id ?? null, p.tx_from ?? txTime, p.tx_to ?? null],
        );
        if (p.tx_to) tombstoned.datasets.add(inv.id);
      } else {
        await q.query(`UPDATE datasets SET tx_to = COALESCE(tx_to, $2::timestamptz), scope_id = NULL WHERE id = $1`, [inv.id, txTime]);
        tombstoned.datasets.add(inv.id);
      }
      touched.datasets.add(inv.id);
      return;
    }
    case 'queue.remove':
      await q.query(`DELETE FROM extraction_queue WHERE document_id = $1`, [inv.documentId]);
      return;
    case 'suggestion.retract':
      await q.query(`DELETE FROM suggestions WHERE id = $1 AND status = 'pending'`, [inv.id]);
      await q.query(`UPDATE suggestions SET status = 'stale' WHERE id = $1 AND status <> 'stale'`, [inv.id]);
      return;
    case 'deps.restore':
      await writeDeps(q, { kind: inv.artifactKind, id: inv.artifactId }, inv.prev);
      return;
    case 'page.restore': {
      if (reason === 'archived' || !inv.prev) {
        await q.query(
          `UPDATE pages SET status = 'archived', scope_id = NULL, tx_to = COALESCE(tx_to, $2::timestamptz) WHERE path = $1`,
          [inv.path, txTime],
        );
      } else {
        const p = inv.prev;
        await q.query(
          `UPDATE pages SET kind = $2, scope_id = $3, generator = $4, inputs_sha = $5, file_sha = $6, regions = $7::jsonb,
                  status = $8, dirty_reason = $9::jsonb, tx_from = $10::timestamptz, tx_to = $11
           WHERE path = $1`,
          [inv.path, p.kind, p.scope_id ?? null, p.generator, p.inputs_sha, p.file_sha ?? null, JSON.stringify(p.regions ?? []),
            p.status ?? 'active', p.dirty_reason ? JSON.stringify(p.dirty_reason) : null, p.tx_from ?? txTime, p.tx_to ?? null],
        );
      }
      return;
    }
    case 'file.delete':
    case 'file.restore':
    case 'region.restore':
      if (reason !== 'replaced') fsInverses.push(inv);
      return;
    default:
      return;
  }
}

/** Archive location for a page file: wiki/x.md → wiki/.archive/x.md. */
export function archivedPath(rel: string): string {
  if (rel.startsWith('wiki/')) return `wiki/.archive/${rel.slice('wiki/'.length)}`;
  const dir = path.posix.dirname(rel);
  return `${dir === '.' ? '' : dir + '/'}.archive/${path.posix.basename(rel)}`;
}

function runInverseFsOps(dataDir: string, inverses: InverseSpec[], reason: DisposeReason): void {
  for (const inv of inverses) {
    if (inv.op === 'file.delete') {
      const abs = safePath(dataDir, inv.path);
      if (!fs.existsSync(abs)) continue;
      if (reason === 'archived') {
        const dst = safePath(dataDir, archivedPath(inv.path));
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(abs, dst);
      } else {
        fs.rmSync(abs, { force: true });
      }
    } else if (inv.op === 'file.restore') {
      const content = readBlob(dataDir, inv.blob);
      const abs = safePath(dataDir, inv.path);
      if (reason === 'archived') {
        if (fs.existsSync(abs)) {
          const dst = safePath(dataDir, archivedPath(inv.path));
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.renameSync(abs, dst);
        }
        if (content !== null) {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, content);
        }
      } else if (content !== null) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      }
    } else if (inv.op === 'region.restore') {
      const abs = safePath(dataDir, inv.path);
      if (!fs.existsSync(abs)) continue;
      const current = fs.readFileSync(abs, 'utf8');
      fs.writeFileSync(abs, replaceRegion(current, inv.region, inv.prev));
    }
  }
}

export interface PurgeResult {
  purged: string[];
  orphansRemoved: { claims: number; relations: number; entities: number };
}

/** Physically erase a disposed scope (and its disposed children). Live scopes are refused. */
export async function purgeScope(store: Store, scopeId: string, opts: { actor?: string } = {}): Promise<PurgeResult> {
  const scope = await scopeById(store, scopeId);
  if (!scope) throw new Error(`unknown scope ${scopeId}`);
  if (scope.status !== 'disposed') throw new Error(`scope ${scopeId} is live — remove the source and sync before purging`);
  const purged: string[] = [];
  const children = await store.query<ScopeRow>(`SELECT * FROM scopes WHERE parent_id = $1`, [scopeId]);
  for (const child of children) {
    if (child.status !== 'disposed') throw new Error(`child scope ${child.id} is live`);
    const res = await purgeScope(store, child.id, opts);
    purged.push(...res.purged);
  }
  const blobs = await store.query<{ inverse: InverseSpec }>(`SELECT inverse FROM effects WHERE scope_id = $1`, [scopeId]);
  let seq = 0;
  let orphans = { claims: 0, relations: 0, entities: 0 };
  await store.tx(async (q) => {
    await q.query(`DELETE FROM evidence WHERE scope_id = $1`, [scopeId]);
    await q.query(`DELETE FROM effects WHERE scope_id = $1`, [scopeId]);
    await q.query(`DELETE FROM entity_mentions WHERE scope_id = $1`, [scopeId]);
    await q.query(`DELETE FROM scopes WHERE id = $1`, [scopeId]);
    orphans = await gcOrphanRows(q);
    seq = await nextLedgerSeq(q);
  });
  for (const b of blobs) {
    if (b.inverse.op === 'file.restore') removeBlob(store.dataDir, b.inverse.blob);
  }
  removeAtticSidecar(store.dataDir, scopeId);
  appendLedger(store.dataDir, { seq, ts: new Date().toISOString(), ev: 'purge', actor: opts.actor ?? 'system', scope: scopeRef(scope) });
  purged.push(scopeId);
  return { purged, orphansRemoved: orphans };
}

/** Delete graph rows that no evidence (live or historical) supports any more. */
export async function gcOrphanRows(q: Queryable): Promise<{ claims: number; relations: number; entities: number }> {
  const claims = await q.query<{ id: string }>(
    `DELETE FROM claims c WHERE NOT EXISTS (SELECT 1 FROM evidence e WHERE e.kind = 'claim' AND e.target_id = c.id) RETURNING id`,
  );
  const relations = await q.query<{ id: string }>(
    `DELETE FROM relations r WHERE NOT EXISTS (SELECT 1 FROM evidence e WHERE e.kind = 'relation' AND e.target_id = r.id) RETURNING id`,
  );
  const entities = await q.query<{ id: string }>(
    `DELETE FROM entities x
     WHERE NOT EXISTS (SELECT 1 FROM evidence e WHERE e.kind = 'entity' AND e.target_id = x.id)
       AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.source_id = x.id OR r.target_id = x.id)
       AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.subject_id = x.id OR c.object_id = x.id)
       AND NOT EXISTS (SELECT 1 FROM entity_mentions m WHERE m.entity_id = x.id)
     RETURNING id`,
  );
  return { claims: claims.length, relations: relations.length, entities: entities.length };
}

function zeroStats(): WriterStats {
  return { entities: 0, relations: 0, claims: 0, mentions: 0, chunks: 0, effects: 0, capabilities: 0, locators: 0 };
}
