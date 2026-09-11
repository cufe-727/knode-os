import crypto from 'node:crypto';
import { Queryable } from '../store/migrations.js';
import {
  EvidenceAtRow,
  foldClaimEvidence,
  foldEntityEvidence,
  foldRelationEvidence,
  groupBy,
  Params,
} from '../store/temporal.js';
import { emptyTouched, TouchedSet } from './types.js';

/**
 * The fold: recompute the visible aggregate columns of entities / relations /
 * claims from their *live* evidence, for exactly the ids an apply or dispose
 * touched, inside that same transaction.
 *
 * Rules are order-independent so a rebuild reproduces the same rows:
 *   entity   name = highest-weight evidence (ties: earliest, then lexicographic),
 *            type by fixed precedence, longest description, alias union,
 *            mention_count = distinct chunks mentioning it
 *   relation weight = SUM(evidence.weight), longest description
 *   claim    status: all-absent > disputed > fact > suspected; valid_from = MIN;
 *            valid_to = NULL if any evidence is open-ended else MAX
 * A row with zero live evidence (or a dead endpoint / subject) is tombstoned
 * (tx_to set); one that regains evidence reopens with a fresh tx_from.
 */

export interface FoldResult {
  /** Rows whose fold changed or whose liveness flipped. */
  changed: TouchedSet;
  tombstoned: TouchedSet;
  reopened: TouchedSet;
}

export async function foldTouched(q: Queryable, touched: TouchedSet, txTime: string): Promise<FoldResult> {
  const result: FoldResult = { changed: emptyTouched(), tombstoned: emptyTouched(), reopened: emptyTouched() };
  const relationIds = new Set(touched.relations);
  const claimIds = new Set(touched.claims);

  await foldEntities(q, [...touched.entities], txTime, result);

  // liveness flips cascade to the edges and claims that hang off the entity
  const flipped = [...result.tombstoned.entities, ...result.reopened.entities];
  if (flipped.length > 0) {
    const p = new Params();
    const ph = flipped.map((id) => p.add(id)).join(',');
    const rels = await q.query<{ id: string }>(`SELECT id FROM relations WHERE source_id IN (${ph}) OR target_id IN (${ph})`, p.list);
    for (const r of rels) relationIds.add(r.id);
    const p2 = new Params();
    const ph2 = flipped.map((id) => p2.add(id)).join(',');
    const cls = await q.query<{ id: string }>(`SELECT id FROM claims WHERE subject_id IN (${ph2})`, p2.list);
    for (const c of cls) claimIds.add(c.id);
  }

  await foldRelations(q, [...relationIds], txTime, result);
  await foldClaims(q, [...claimIds], txTime, result);

  for (const d of touched.documents) result.changed.documents.add(d);
  for (const d of touched.datasets) result.changed.datasets.add(d);
  return result;
}

function sha16(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

async function liveEvidence(q: Queryable, kind: string, ids: string[]): Promise<Map<string, EvidenceAtRow[]>> {
  if (ids.length === 0) return new Map();
  const p = new Params([kind]);
  const ph = ids.map((id) => p.add(id)).join(',');
  const rows = await q.query<EvidenceAtRow>(
    `SELECT kind, target_id, scope_id, segment_id, weight, extractor, attrs, tx_from
     FROM evidence WHERE kind = $1 AND target_id IN (${ph}) AND tx_to IS NULL`,
    p.list,
  );
  return groupBy(rows, (r) => r.target_id);
}

async function foldEntities(q: Queryable, ids: string[], txTime: string, result: FoldResult): Promise<void> {
  if (ids.length === 0) return;
  const evidence = await liveEvidence(q, 'entity', ids);
  const p = new Params();
  const ph = ids.map((id) => p.add(id)).join(',');
  const mentionRows = await q.query<{ entity_id: string; n: number }>(
    `SELECT entity_id, count(DISTINCT chunk_id)::int AS n FROM entity_mentions WHERE entity_id IN (${ph}) GROUP BY entity_id`,
    p.list,
  );
  const mentions = new Map(mentionRows.map((r) => [r.entity_id, r.n]));
  const p2 = new Params();
  const ph2 = ids.map((id) => p2.add(id)).join(',');
  const current = await q.query<{
    id: string; name: string; type: string; description: string; aliases: string[];
    mention_count: number; evidence_count: number; fold_sha: string; tx_to: string | null;
  }>(`SELECT id, name, type, description, aliases, mention_count, evidence_count, fold_sha, tx_to FROM entities WHERE id IN (${ph2})`, p2.list);

  for (const cur of current) {
    const rows = evidence.get(cur.id) ?? [];
    const mentionCount = mentions.get(cur.id) ?? 0;
    const wasLive = cur.tx_to === null;
    const folded = foldEntityEvidence(cur.id, rows, mentionCount, cur);
    if (!folded) {
      if (wasLive) {
        await q.query(
          `UPDATE entities SET tx_to = $2, evidence_count = 0, mention_count = $3, fold_sha = '', updated_at = now() WHERE id = $1`,
          [cur.id, txTime, mentionCount],
        );
        result.tombstoned.entities.add(cur.id);
        result.changed.entities.add(cur.id);
      } else if (mentionCount !== cur.mention_count) {
        await q.query(`UPDATE entities SET mention_count = $2 WHERE id = $1`, [cur.id, mentionCount]);
      }
      continue;
    }
    const foldSha = sha16([folded.name, folded.type, folded.description, folded.aliases, folded.mention_count]);
    if (!wasLive) result.reopened.entities.add(cur.id);
    if (!wasLive || foldSha !== cur.fold_sha) result.changed.entities.add(cur.id);
    await q.query(
      `UPDATE entities SET name = $2, type = $3, description = $4, aliases = $5::jsonb, mention_count = $6,
              evidence_count = $7, fold_sha = $8,
              tx_from = CASE WHEN tx_to IS NOT NULL THEN $9::timestamptz ELSE tx_from END, tx_to = NULL,
              updated_at = now()
       WHERE id = $1`,
      [cur.id, folded.name, folded.type, folded.description, JSON.stringify(folded.aliases), mentionCount, folded.evidence_count, foldSha, txTime],
    );
  }
}

async function entityLiveness(q: Queryable, ids: string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (ids.length === 0) return out;
  const p = new Params();
  const ph = ids.map((id) => p.add(id)).join(',');
  const rows = await q.query<{ id: string; tx_to: string | null }>(`SELECT id, tx_to FROM entities WHERE id IN (${ph})`, p.list);
  for (const r of rows) out.set(r.id, r.tx_to === null);
  return out;
}

async function foldRelations(q: Queryable, ids: string[], txTime: string, result: FoldResult): Promise<void> {
  if (ids.length === 0) return;
  const evidence = await liveEvidence(q, 'relation', ids);
  const p = new Params();
  const ph = ids.map((id) => p.add(id)).join(',');
  const current = await q.query<{
    id: string; source_id: string; target_id: string; type: string; description: string; weight: number;
    evidence_count: number; fold_sha: string; tx_to: string | null;
  }>(`SELECT id, source_id, target_id, type, description, weight, evidence_count, fold_sha, tx_to FROM relations WHERE id IN (${ph})`, p.list);
  const endpoints = [...new Set(current.flatMap((r) => [r.source_id, r.target_id]))];
  const alive = await entityLiveness(q, endpoints);

  for (const cur of current) {
    const rows = evidence.get(cur.id) ?? [];
    const wasLive = cur.tx_to === null;
    const folded = foldRelationEvidence(cur, rows);
    const live = Boolean(folded) && alive.get(cur.source_id) === true && alive.get(cur.target_id) === true;
    if (!live) {
      if (wasLive) {
        await q.query(`UPDATE relations SET tx_to = $2, evidence_count = $3, fold_sha = '' WHERE id = $1`, [cur.id, txTime, rows.length]);
        result.tombstoned.relations.add(cur.id);
        result.changed.relations.add(cur.id);
      }
      continue;
    }
    const foldSha = sha16([Number(folded!.weight.toFixed(3)), folded!.description]);
    if (!wasLive) result.reopened.relations.add(cur.id);
    if (!wasLive || foldSha !== cur.fold_sha) result.changed.relations.add(cur.id);
    await q.query(
      `UPDATE relations SET weight = $2, description = $3, evidence_count = $4, fold_sha = $5,
              tx_from = CASE WHEN tx_to IS NOT NULL THEN $6::timestamptz ELSE tx_from END, tx_to = NULL
       WHERE id = $1`,
      [cur.id, folded!.weight, folded!.description, folded!.evidence_count, foldSha, txTime],
    );
  }
}

async function foldClaims(q: Queryable, ids: string[], txTime: string, result: FoldResult): Promise<void> {
  if (ids.length === 0) return;
  const evidence = await liveEvidence(q, 'claim', ids);
  const p = new Params();
  const ph = ids.map((id) => p.add(id)).join(',');
  const current = await q.query<{
    id: string; subject_id: string; statement: string; fold_sha: string; tx_to: string | null;
  }>(`SELECT id, subject_id, statement, fold_sha, tx_to FROM claims WHERE id IN (${ph})`, p.list);
  const alive = await entityLiveness(q, [...new Set(current.map((c) => c.subject_id))]);

  for (const cur of current) {
    const rows = evidence.get(cur.id) ?? [];
    const wasLive = cur.tx_to === null;
    const folded = foldClaimEvidence(cur, rows);
    const live = Boolean(folded) && alive.get(cur.subject_id) === true;
    if (!live) {
      if (wasLive) {
        await q.query(`UPDATE claims SET tx_to = $2, evidence_count = $3, fold_sha = '' WHERE id = $1`, [cur.id, txTime, rows.length]);
        result.tombstoned.claims.add(cur.id);
        result.changed.claims.add(cur.id);
      }
      continue;
    }
    const f = folded!;
    const foldSha = sha16([f.status, f.type, f.valid_from, f.valid_to, f.object_id, f.primary_scope_id]);
    if (!wasLive) result.reopened.claims.add(cur.id);
    if (!wasLive || foldSha !== cur.fold_sha) result.changed.claims.add(cur.id);
    await q.query(
      `UPDATE claims SET status = $2, type = $3, valid_from = $4::timestamptz, valid_to = $5::timestamptz,
              primary_scope_id = $6,
              object_id = (SELECT id FROM entities WHERE id = $7),
              chunk_id = (SELECT id FROM chunks WHERE id = $8),
              evidence_count = $9, fold_sha = $10,
              tx_from = CASE WHEN tx_to IS NOT NULL THEN $11::timestamptz ELSE tx_from END, tx_to = NULL
       WHERE id = $1`,
      [
        cur.id, f.status, f.type, f.valid_from, f.valid_to,
        f.primary_scope_id, f.object_id, f.segment_id, f.evidence_count, foldSha, txTime,
      ],
    );
  }
}

/** Full recompute (verification / repair). Returns how many rows changed. */
export async function recountAll(q: Queryable, txTime = new Date().toISOString()): Promise<{ entities: number; relations: number; claims: number; changed: number }> {
  const touched = emptyTouched();
  for (const r of await q.query<{ id: string }>(`SELECT id FROM entities`)) touched.entities.add(r.id);
  for (const r of await q.query<{ id: string }>(`SELECT id FROM relations`)) touched.relations.add(r.id);
  for (const r of await q.query<{ id: string }>(`SELECT id FROM claims`)) touched.claims.add(r.id);
  const res = await foldTouched(q, touched, txTime);
  return {
    entities: touched.entities.size,
    relations: touched.relations.size,
    claims: touched.claims.size,
    changed: res.changed.entities.size + res.changed.relations.size + res.changed.claims.size,
  };
}
