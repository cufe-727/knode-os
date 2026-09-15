import { HeatConfig, defaultConfig } from '../config.js';
import { hasSidecar, SidecarUsage, updateSidecarPart } from '../fs/sidecar.js';
import { Store } from '../store/db.js';

/**
 * Usage accounting & heat. Retrieval hits are recorded in the DB (hot path —
 * never touches files); heat is an exponentially-decayed hit count with a
 * configurable half-life. A background task periodically flushes usage back
 * into the sidecars so a DB rebuild never loses history.
 *
 * Heat feeds three places: search ranking (mild RRF boost), the tier-1
 * extraction queue priority, and wiki generation (hot topics / cold demotion).
 */

const MS_PER_DAY = 24 * 3600 * 1000;

function decayFactor(halfLifeDays: number, dtMs: number): number {
  if (dtMs <= 0) return 1;
  return Math.pow(0.5, dtMs / (halfLifeDays * MS_PER_DAY));
}

export interface ChunkHit {
  chunkId: string;
  documentId: string;
}

/** Record retrieval hits (called from search/ask/graph with the results actually returned). */
export async function recordChunkHits(store: Store, hits: ChunkHit[], heatCfg?: HeatConfig): Promise<void> {
  if (hits.length === 0) return;
  const cfg = heatCfg ?? defaultConfig().heat;
  const now = new Date();

  const byDoc = new Map<string, number>();
  const byChunk = new Map<string, number>();
  for (const h of hits) {
    byDoc.set(h.documentId, (byDoc.get(h.documentId) ?? 0) + 1);
    byChunk.set(h.chunkId, (byChunk.get(h.chunkId) ?? 0) + 1);
  }

  for (const [chunkId, n] of byChunk) {
    await store.query(
      `INSERT INTO chunk_stats (chunk_id, hit_count, last_hit_at) VALUES ($1, $2, $3)
       ON CONFLICT (chunk_id) DO UPDATE SET
         hit_count = chunk_stats.hit_count + $2, last_hit_at = $3`,
      [chunkId, n, now.toISOString()],
    );
  }

  for (const [docId, n] of byDoc) {
    const [row] = await store.query<{ heat: number; heat_updated: string | null }>(
      `SELECT heat, heat_updated FROM doc_stats WHERE document_id = $1`,
      [docId],
    );
    const prevHeat = row?.heat ?? 0;
    const dt = row?.heat_updated ? now.getTime() - new Date(row.heat_updated).getTime() : 0;
    const heat = prevHeat * decayFactor(cfg.halfLifeDays, dt) + n;
    await store.query(
      `INSERT INTO doc_stats (document_id, hit_count, last_hit_at, heat, heat_updated)
       VALUES ($1, $2, $3, $4, $3)
       ON CONFLICT (document_id) DO UPDATE SET
         hit_count = doc_stats.hit_count + $2, last_hit_at = $3, heat = $4, heat_updated = $3`,
      [docId, n, now.toISOString(), heat],
    );
  }
}

/** Current (decay-adjusted) heat for a set of documents. */
export async function getDocHeat(store: Store, docIds: string[], heatCfg?: HeatConfig): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (docIds.length === 0) return out;
  const cfg = heatCfg ?? defaultConfig().heat;
  const ph = docIds.map((_, i) => `$${i + 1}`).join(',');
  const rows = await store.query<{ document_id: string; heat: number; heat_updated: string | null }>(
    `SELECT document_id, heat, heat_updated FROM doc_stats WHERE document_id IN (${ph})`,
    docIds,
  );
  const now = Date.now();
  for (const r of rows) {
    const dt = r.heat_updated ? now - new Date(r.heat_updated).getTime() : 0;
    out.set(r.document_id, r.heat * decayFactor(cfg.halfLifeDays, dt));
  }
  return out;
}

/** Seed DB stats from a sidecar's usage snapshot (DB rebuild path). */
export async function restoreUsageFromSidecar(store: Store, docId: string, usage: SidecarUsage | null | undefined): Promise<void> {
  const u = usage;
  if (!u || (u.accessCount === 0 && u.heat === 0)) return;
  const [existing] = await store.query<{ document_id: string }>(
    `SELECT document_id FROM doc_stats WHERE document_id = $1`,
    [docId],
  );
  if (existing) return; // live ledger wins

  await store.query(
    `INSERT INTO doc_stats (document_id, hit_count, last_hit_at, heat, heat_updated)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (document_id) DO NOTHING`,
    [docId, u.accessCount, u.lastAccessedAt, u.heat, u.flushedAt ?? u.lastAccessedAt],
  );
  for (const [chunkId, hit] of Object.entries(u.chunkHits ?? {})) {
    // only chunks that still exist (content may have changed since the snapshot)
    await store.query(
      `INSERT INTO chunk_stats (chunk_id, hit_count, last_hit_at)
       SELECT id, $2, $3 FROM chunks WHERE id = $1
       ON CONFLICT (chunk_id) DO NOTHING`,
      [chunkId, hit.count, hit.lastAt],
    );
  }
}

/** Flush DB usage stats back into the sidecars of raw/docs sources. */
export async function flushUsageToSidecars(store: Store, heatCfg?: HeatConfig): Promise<number> {
  const cfg = heatCfg ?? defaultConfig().heat;
  const rows = await store.query<{
    document_id: string; path: string; hit_count: number; last_hit_at: string | null;
    heat: number; heat_updated: string | null;
  }>(
    `SELECT s.document_id, d.path, s.hit_count, s.last_hit_at, s.heat, s.heat_updated
     FROM doc_stats s JOIN documents d ON d.id = s.document_id
     WHERE d.root = 'docs'`,
  );
  let flushed = 0;
  const now = new Date().toISOString();
  for (const r of rows) {
    if (!hasSidecar(store.dataDir, r.path)) continue;
    const chunkRows = await store.query<{ chunk_id: string; hit_count: number; last_hit_at: string }>(
      `SELECT cs.chunk_id, cs.hit_count, cs.last_hit_at
       FROM chunk_stats cs JOIN chunks c ON c.id = cs.chunk_id
       WHERE c.document_id = $1`,
      [r.document_id],
    );
    const dt = r.heat_updated ? Date.now() - new Date(r.heat_updated).getTime() : 0;
    // only usage.json is rewritten — extraction results and cached views are untouched
    const updated = updateSidecarPart(store.dataDir, r.path, 'usage', (cur) => ({
      firstSeenAt: cur?.firstSeenAt ?? now,
      lastAccessedAt: r.last_hit_at,
      accessCount: r.hit_count,
      heat: Number((r.heat * decayFactor(cfg.halfLifeDays, dt)).toFixed(4)),
      chunkHits: Object.fromEntries(chunkRows.map((c) => [c.chunk_id, { count: c.hit_count, lastAt: c.last_hit_at }])),
      flushedAt: now,
    }));
    if (updated) flushed++;
  }
  return flushed;
}
