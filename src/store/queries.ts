import { appendLedger, nextLedgerSeq } from '../lineage/ledger.js';
import { DatasetRow, DocumentRow, EntityRow, SuggestionRow, TraceRow } from '../types.js';
import { Store } from './db.js';

/**
 * Read/update queries shared by the interface layers (HTTP API, MCP, CLI), so
 * routes stay free of inline SQL and the same capability behaves identically
 * everywhere. Reads see the current state (`tx_to IS NULL`); history is
 * available through the lineage helpers.
 */

export interface KnowledgeStats {
  documents: number;
  chunks: number;
  embeddings: number;
  entities: number;
  relations: number;
  claims: number;
  traces: number;
  pending_suggestions: number;
  extraction_queue: number;
  /** Extraction calls still to make for the queued documents (a long document counts its segments). */
  extraction_segments: number;
  scopes: number;
  disposed_scopes: number;
  pages: number;
}

export async function knowledgeStats(store: Store): Promise<KnowledgeStats> {
  const [row] = await store.query<KnowledgeStats>(`
    SELECT (SELECT count(*)::int FROM documents WHERE root != 'traces' AND status <> 'disposed') AS documents,
           (SELECT count(*)::int FROM chunks) AS chunks,
           (SELECT count(*)::int FROM embeddings) AS embeddings,
           (SELECT count(*)::int FROM entities WHERE tx_to IS NULL) AS entities,
           (SELECT count(*)::int FROM relations WHERE tx_to IS NULL AND type <> 'co_occurs') AS relations,
           (SELECT count(*)::int FROM claims WHERE tx_to IS NULL AND canonical_id IS NULL) AS claims,
           (SELECT count(*)::int FROM traces) AS traces,
           (SELECT count(*)::int FROM suggestions WHERE status = 'pending') AS pending_suggestions,
           (SELECT count(*)::int FROM extraction_queue) AS extraction_queue,
           (SELECT COALESCE(sum(GREATEST(segments_total - segments_done, 1)), 0)::int FROM extraction_queue) AS extraction_segments,
           (SELECT count(*)::int FROM scopes WHERE status = 'active') AS scopes,
           (SELECT count(*)::int FROM scopes WHERE status = 'disposed') AS disposed_scopes,
           (SELECT count(*)::int FROM pages WHERE status <> 'archived') AS pages`);
  return row;
}

/** Mark every document pending (legacy helper; `sync` re-applies whatever changed). */
export async function markAllDocumentsPending(store: Store): Promise<void> {
  await store.query(`UPDATE documents SET status = 'pending' WHERE status = 'indexed'`);
}

export async function listEntities(store: Store, q?: string): Promise<EntityRow[]> {
  if (q) {
    return store.query<EntityRow>(
      `SELECT * FROM entities WHERE tx_to IS NULL AND (name ILIKE $1 OR aliases::text ILIKE $1) ORDER BY mention_count DESC LIMIT 100`,
      [`%${q}%`],
    );
  }
  return store.query<EntityRow>(`SELECT * FROM entities WHERE tx_to IS NULL ORDER BY mention_count DESC LIMIT 200`);
}

export async function listDocuments(store: Store): Promise<DocumentRow[]> {
  return store.query<DocumentRow>(
    `SELECT * FROM documents WHERE root != 'traces' AND status <> 'disposed' ORDER BY updated_at DESC LIMIT 500`,
  );
}

export async function listTraces(store: Store): Promise<TraceRow[]> {
  return store.query<TraceRow>(`SELECT * FROM traces ORDER BY started_at DESC NULLS LAST LIMIT 300`);
}

export async function listSuggestions(store: Store, opts: { status?: string; limit?: number } = {}): Promise<SuggestionRow[]> {
  const limit = opts.limit ?? 200;
  if (opts.status) {
    return store.query<SuggestionRow>(
      `SELECT * FROM suggestions WHERE status = $1 ORDER BY created_at DESC LIMIT $2`,
      [opts.status, limit],
    );
  }
  return store.query<SuggestionRow>(`SELECT * FROM suggestions ORDER BY created_at DESC LIMIT $1`, [limit]);
}

export async function setSuggestionStatus(
  store: Store,
  id: string,
  status: 'pending' | 'accepted' | 'rejected' | 'stale',
  actor = 'user',
): Promise<void> {
  await store.query(`UPDATE suggestions SET status = $2 WHERE id = $1`, [id, status]);
  // human decisions are machine truth too: recorded so a rebuild replays them
  const seq = await nextLedgerSeq(store);
  appendLedger(store.dataDir, { seq, ts: new Date().toISOString(), ev: 'feedback', actor, kind: 'suggestion.status', id, payload: { status } });
}

export async function getSuggestion(store: Store, id: string): Promise<SuggestionRow | undefined> {
  const rows = await store.query<SuggestionRow>(`SELECT * FROM suggestions WHERE id = $1`, [id]);
  return rows[0];
}

/** Registered external live tables (schema metadata only). */
export async function listDatasets(store: Store): Promise<DatasetRow[]> {
  return store.query<DatasetRow>(`SELECT * FROM datasets WHERE tx_to IS NULL ORDER BY source_id, table_name`);
}

/** Live tables an entity appears in (via sampled `appears_in` graph edges). */
export async function datasetsForEntity(store: Store, entityId: string): Promise<(DatasetRow & { link_description: string })[]> {
  return store.query<DatasetRow & { link_description: string }>(
    `SELECT ds.*, r.description AS link_description
     FROM relations r JOIN datasets ds ON ds.id = r.target_id
     WHERE r.source_id = $1 AND r.type = 'appears_in' AND r.tx_to IS NULL AND ds.tx_to IS NULL
     ORDER BY ds.source_id, ds.table_name`,
    [entityId],
  );
}
