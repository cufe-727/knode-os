import { Store, toVectorLiteral } from '../store/db.js';
import { EmbeddingProvider } from '../ingest/embeddings.js';
import { SearchResult } from '../types.js';

export type SearchMode = 'hybrid' | 'vector' | 'keyword';

interface RankedChunk {
  chunk_id: string;
  document_id: string;
  path: string;
  title: string | null;
  content: string;
  raw: number;
}

/** Pure vector recall: cosine distance over pgvector. */
export async function vectorSearch(store: Store, embedder: EmbeddingProvider, query: string, k = 10): Promise<RankedChunk[]> {
  const [qv] = await embedder.embed([query]);
  return store.query<RankedChunk>(
    `SELECT c.id AS chunk_id, c.document_id, d.path, d.title, c.content,
            1 - (e.embedding <=> $1::vector) AS raw
     FROM embeddings e
     JOIN chunks c ON c.id = e.chunk_id
     JOIN documents d ON d.id = c.document_id
     ORDER BY e.embedding <=> $1::vector
     LIMIT $2`,
    [toVectorLiteral(qv), k],
  );
}

/** Keyword recall: Postgres FTS, with an ILIKE fallback that covers CJK queries. */
export async function keywordSearch(store: Store, query: string, k = 10): Promise<RankedChunk[]> {
  const fts = await store.query<RankedChunk>(
    `SELECT c.id AS chunk_id, c.document_id, d.path, d.title, c.content,
            ts_rank(c.tsv, websearch_to_tsquery('simple', $1)) AS raw
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     WHERE c.tsv @@ websearch_to_tsquery('simple', $1)
     ORDER BY raw DESC
     LIMIT $2`,
    [query, k],
  );
  if (fts.length >= Math.min(3, k)) return fts;

  // CJK or rare terms: substring fallback
  const terms = query.split(/\s+/).filter(Boolean).slice(0, 5);
  if (terms.length === 0) return fts;
  const conds = terms.map((_, i) => `c.content ILIKE $${i + 1}`).join(' OR ');
  const params: unknown[] = terms.map((t) => `%${t}%`);
  params.push(k);
  const like = await store.query<RankedChunk>(
    `SELECT c.id AS chunk_id, c.document_id, d.path, d.title, c.content, 0.01 AS raw
     FROM chunks c JOIN documents d ON d.id = c.document_id
     WHERE ${conds} LIMIT $${terms.length + 1}`,
    params,
  );
  const seen = new Set(fts.map((r) => r.chunk_id));
  return [...fts, ...like.filter((r) => !seen.has(r.chunk_id))].slice(0, k);
}

/** Chunks mentioning entities whose name/alias matches the query (graph signal). */
async function graphSignal(store: Store, query: string, k = 20): Promise<RankedChunk[]> {
  const terms = query.split(/\s+/).filter((t) => t.length >= 2).slice(0, 5);
  if (terms.length === 0) return [];
  const conds = terms.map((_, i) => `(e.name ILIKE $${i + 1} OR e.aliases::text ILIKE $${i + 1})`).join(' OR ');
  const params: unknown[] = terms.map((t) => `%${t}%`);
  params.push(k);
  return store.query<RankedChunk>(
    `SELECT DISTINCT c.id AS chunk_id, c.document_id, d.path, d.title, c.content,
            e.mention_count::float AS raw
     FROM entities e
     JOIN entity_mentions m ON m.entity_id = e.id
     JOIN chunks c ON c.id = m.chunk_id
     JOIN documents d ON d.id = c.document_id
     WHERE ${conds}
     LIMIT $${terms.length + 1}`,
    params,
  );
}

/**
 * Hybrid search: reciprocal-rank fusion of vector + keyword + graph-mention
 * signals (RRF, k=60 — the same shape gbrain and most hybrid retrievers use).
 */
export async function search(
  store: Store,
  embedder: EmbeddingProvider,
  query: string,
  opts: { k?: number; mode?: SearchMode } = {},
): Promise<SearchResult[]> {
  const k = opts.k ?? 8;
  const mode = opts.mode ?? 'hybrid';
  const fetchK = Math.max(k * 3, 24);

  const [vec, kw, gr] = await Promise.all([
    mode !== 'keyword' ? vectorSearch(store, embedder, query, fetchK) : Promise.resolve([]),
    mode !== 'vector' ? keywordSearch(store, query, fetchK) : Promise.resolve([]),
    mode === 'hybrid' ? graphSignal(store, query, fetchK) : Promise.resolve([]),
  ]);

  const RRF_K = 60;
  const weights = { vector: 1.0, keyword: 1.0, graph: 0.6 };
  const fused = new Map<string, SearchResult>();

  const fold = (list: RankedChunk[], signal: 'vector' | 'keyword' | 'graph') => {
    list.forEach((r, rank) => {
      const score = weights[signal] / (RRF_K + rank + 1);
      const prev = fused.get(r.chunk_id);
      if (prev) {
        prev.score += score;
        prev.signals[signal] = r.raw;
      } else {
        fused.set(r.chunk_id, {
          chunkId: r.chunk_id,
          documentId: r.document_id,
          path: r.path,
          title: r.title,
          content: r.content,
          score,
          signals: { [signal]: r.raw },
        });
      }
    });
  };
  fold(vec, 'vector');
  fold(kw, 'keyword');
  fold(gr, 'graph');

  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, k);
}
