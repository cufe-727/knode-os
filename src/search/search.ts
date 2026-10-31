import { HeatConfig, SagSearchConfig, defaultConfig } from '../config.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../store/db.js';
import { NO_FILTER, ResolvedScopeFilter, documentFilterSql } from '../store/resolver.js';
import { Params, TimeInput, rowLiveAt, toIso, toDateString } from '../store/temporal.js';
import { EmbeddingProvider } from '../ingest/embeddings.js';
import { getDocHeat, recordChunkHits } from '../stats/heat.js';
import { SearchResult } from '../types.js';

export type SearchMode = 'hybrid' | 'vector' | 'keyword' | 'sag';

export interface SearchOptions {
  k?: number;
  mode?: SearchMode;
  heat?: HeatConfig;
  track?: boolean;
  sag?: Partial<SagSearchConfig>;
  /** Internal escape hatch so SAG does not embed the same query twice. */
  queryVector?: number[];
  /**
   * System time: only documents whose scope was live at this instant. Chunk
   * text is always the current version (removed documents keep no chunks).
   */
  asOf?: TimeInput;
  /** Restrict recall to certain source kinds / path prefixes. */
  filter?: ResolvedScopeFilter;
  /** Give every result its rank in each recall channel (`SearchResult.ranks`), for a view that shows why it matched. */
  explain?: boolean;
}

/** What one recall channel of a hybrid search found, and how long it took. */
export interface SearchChannel {
  /** Chunks it returned, before fusion. */
  hits: number;
  ms: number;
  /** Set when the channel could not answer (an embedding provider out of quota); hybrid search goes on without it. */
  error?: string;
}

export type SearchChannelName = 'vector' | 'keyword' | 'graph';

export interface ExplainedSearch {
  results: SearchResult[];
  /** The channels that ran: all three in hybrid mode, one in vector or keyword mode, none for SAG. */
  channels: Partial<Record<SearchChannelName, SearchChannel>>;
}

interface RankedChunk {
  doc_date?: string | Date | null;
  chunk_id: string;
  document_id: string;
  path: string;
  title: string | null;
  content: string;
  raw: number;
}

const CJK_QUERY_STOP = new Set([
  '什么', '哪些', '如何', '怎么', '怎样', '为何', '为什么', '多少', '是否', '哪个', '哪里',
  '分别', '相关', '关于', '对于', '通过', '以及', '或者', '还是', '及其', '其中', '此次',
  '进行', '具有', '可以', '需要', '影响', '情况', '问题', '内容', '方面', '包括', '主要',
]);

/**
 * Terms for substring-based recall (keyword ILIKE fallback + graph entity
 * matching). Whitespace tokens cover Latin; CJK runs — which carry no spaces,
 * so a natural-language question would never match as a whole — are broken
 * into overlapping bigrams with question-word stopwords removed.
 */
export function queryTerms(query: string, max = 8): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    const k = t.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      terms.push(t);
    }
  };

  for (const m of query.matchAll(/[a-zA-Z0-9_.$-]{2,}/g)) push(m[0]);

  const bigrams = new Map<string, number>();
  for (const run of query.matchAll(/[一-鿿㐀-䶿]{2,}/g)) {
    const s = run[0];
    if (s.length <= 4 && !CJK_QUERY_STOP.has(s)) push(s); // short runs are usually one salient term
    for (let i = 0; i + 2 <= s.length; i++) {
      const b = s.slice(i, i + 2);
      if (!CJK_QUERY_STOP.has(b)) bigrams.set(b, (bigrams.get(b) ?? 0) + 1);
    }
  }
  for (const [b] of [...bigrams.entries()].sort((a, z) => z[1] - a[1])) {
    if (terms.length >= max) break;
    push(b);
  }
  return terms.slice(0, max);
}

/**
 * Document predicate for search joins: indexed now, live at `asOf` when one is
 * given, and inside the requested kind / source scope. Every recall route goes
 * through this, so a filter can never be silently dropped by one of them.
 */
export function docLiveAt(alias: string, p: Params, asOf?: TimeInput, filter: ResolvedScopeFilter = NO_FILTER): string {
  const parts = [`${alias}.status = 'indexed'`];
  const iso = toIso(asOf);
  if (iso) {
    const ph = p.add(iso);
    parts.push(`EXISTS (
      SELECT 1 FROM scopes s WHERE s.kind = 'doc' AND s.key = ${alias}.path
        AND s.applied_at <= ${ph}::timestamptz AND (s.disposed_at IS NULL OR s.disposed_at > ${ph}::timestamptz))`);
  }
  const scoped = documentFilterSql(alias, p, filter);
  if (scoped !== 'TRUE') parts.push(scoped);
  return parts.join(' AND ');
}

/** Pure vector recall: cosine distance over pgvector. */
async function vectorSearch(
  store: Store,
  embedder: EmbeddingProvider,
  query: string,
  k = 10,
  queryVector?: number[],
  asOf?: TimeInput,
  filter?: ResolvedScopeFilter,
): Promise<RankedChunk[]> {
  const qv = queryVector ?? (await embedder.embed([query]))[0];
  const p = new Params([toVectorLiteral(qv)]);
  const cond = docLiveAt('d', p, asOf, filter);
  const lim = p.add(k);
  return store.query<RankedChunk>(
    `SELECT c.id AS chunk_id, c.document_id, d.path, d.title, d.doc_date, c.content,
            1 - (e.embedding <=> $1::${VECTOR_TYPE}) AS raw
     FROM embeddings e
     JOIN chunks c ON c.id = e.chunk_id
     JOIN documents d ON d.id = c.document_id
     WHERE ${cond}
     ORDER BY e.embedding <=> $1::${VECTOR_TYPE}
     LIMIT ${lim}`,
    p.list,
  );
}

/** Keyword recall: Postgres FTS, with an ILIKE fallback that covers CJK queries. */
async function keywordSearch(store: Store, query: string, k = 10, asOf?: TimeInput, filter?: ResolvedScopeFilter): Promise<RankedChunk[]> {
  const p = new Params([query]);
  const cond = docLiveAt('d', p, asOf, filter);
  const lim = p.add(k);
  const fts = await store.query<RankedChunk>(
    `SELECT c.id AS chunk_id, c.document_id, d.path, d.title, d.doc_date, c.content,
            ts_rank(c.tsv, websearch_to_tsquery('simple', $1)) AS raw
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     WHERE c.tsv @@ websearch_to_tsquery('simple', $1) AND ${cond}
     ORDER BY raw DESC
     LIMIT ${lim}`,
    p.list,
  );
  if (fts.length >= Math.min(3, k)) return fts;

  // CJK or rare terms: substring fallback, ranked by how many query terms hit
  const terms = queryTerms(query);
  if (terms.length === 0) return fts;
  const lp = new Params();
  const placeholders = terms.map((t) => lp.add(`%${t}%`));
  const conds = placeholders.map((ph) => `c.content ILIKE ${ph}`).join(' OR ');
  const hitCount = placeholders.map((ph) => `(c.content ILIKE ${ph})::int`).join(' + ');
  const lcond = docLiveAt('d', lp, asOf, filter);
  const llim = lp.add(k);
  const like = await store.query<RankedChunk>(
    `SELECT c.id AS chunk_id, c.document_id, d.path, d.title, d.doc_date, c.content, (${hitCount})::float AS raw
     FROM chunks c JOIN documents d ON d.id = c.document_id
     WHERE (${conds}) AND ${lcond}
     ORDER BY raw DESC
     LIMIT ${llim}`,
    lp.list,
  );
  const seen = new Set(fts.map((r) => r.chunk_id));
  return [...fts, ...like.filter((r) => !seen.has(r.chunk_id))].slice(0, k);
}

/**
 * Chunks mentioning entities whose name/alias matches the query (graph
 * signal): one row per chunk, ranked by how many matching entities it
 * mentions, then by how often those entities are mentioned overall, then by
 * id — RRF reads the rank, so the order must not be the planner's. An entity
 * counts when it was live at `asOf` (the evidence test the other graph routes
 * use), not merely now. `raw` is the matching-entity count, as in graphSearch.
 */
async function graphSignal(store: Store, query: string, k = 20, asOf?: TimeInput, filter?: ResolvedScopeFilter): Promise<RankedChunk[]> {
  const terms = queryTerms(query, 5);
  if (terms.length === 0) return [];
  const p = new Params();
  const conds = terms.map((t) => {
    const ph = p.add(`%${t}%`);
    return `(e.name ILIKE ${ph} OR e.aliases::text ILIKE ${ph})`;
  }).join(' OR ');
  const entityLive = rowLiveAt('e', 'entity', p, asOf);
  const cond = docLiveAt('d', p, asOf, filter);
  const lim = p.add(k);
  return store.query<RankedChunk>(
    `SELECT c.id AS chunk_id, c.document_id, d.path, d.title, d.doc_date, c.content,
            count(DISTINCT e.id)::float AS raw
     FROM entities e
     JOIN entity_mentions m ON m.entity_id = e.id
     JOIN chunks c ON c.id = m.chunk_id
     JOIN documents d ON d.id = c.document_id
     WHERE (${conds}) AND ${entityLive} AND ${cond}
     GROUP BY c.id, d.id
     ORDER BY count(DISTINCT e.id) DESC, sum(e.mention_count) DESC, c.id
     LIMIT ${lim}`,
    p.list,
  );
}

/**
 * Hybrid search: reciprocal-rank fusion of vector + keyword + graph-mention
 * signals (RRF, k=60 — the same shape gbrain and most hybrid retrievers use).
 * Fused scores get a mild heat boost (tie-break level, never dominant), and
 * returned hits are recorded into the usage ledger.
 */
export async function search(
  store: Store,
  embedder: EmbeddingProvider,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResult[]> {
  return (await searchExplained(store, embedder, query, opts)).results;
}

/**
 * `search`, with what each recall channel contributed: how many chunks it
 * found, how long it took, and whether it failed. With `explain`, every
 * result also carries its rank in each channel that found it.
 */
export async function searchExplained(
  store: Store,
  embedder: EmbeddingProvider,
  query: string,
  opts: SearchOptions = {},
): Promise<ExplainedSearch> {
  const k = opts.k ?? 8;
  const mode = opts.mode ?? 'hybrid';
  if (mode === 'sag') {
    const { sagSearch } = await import('./sag.js');
    return { results: await sagSearch(store, embedder, query, opts), channels: {} };
  }
  const fetchK = Math.max(k * 3, 24);
  const channels: ExplainedSearch['channels'] = {};
  const timed = async (name: SearchChannelName, run: () => Promise<RankedChunk[]>, tolerate = false): Promise<RankedChunk[]> => {
    const started = Date.now();
    try {
      const rows = await run();
      channels[name] = { hits: rows.length, ms: Date.now() - started };
      return rows;
    } catch (err) {
      channels[name] = { hits: 0, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
      if (tolerate) return [];
      throw err;
    }
  };

  // hybrid recall outlives an embedding provider that cannot serve the query
  // (a spent daily quota): keyword and graph still answer; vector mode says so
  const vectorRecall = () => vectorSearch(store, embedder, query, fetchK, opts.queryVector, opts.asOf, opts.filter);
  const [vec, kw, gr] = await Promise.all([
    mode === 'hybrid' || mode === 'vector' ? timed('vector', vectorRecall, mode === 'hybrid') : Promise.resolve([]),
    mode !== 'vector' ? timed('keyword', () => keywordSearch(store, query, fetchK, opts.asOf, opts.filter)) : Promise.resolve([]),
    mode === 'hybrid' ? timed('graph', () => graphSignal(store, query, fetchK, opts.asOf, opts.filter)) : Promise.resolve([]),
  ]);

  const RRF_K = 60;
  const weights = { vector: 1.0, keyword: 1.0, graph: 0.6 };
  const fused = new Map<string, SearchResult>();

  const fold = (list: RankedChunk[], signal: SearchChannelName) => {
    list.forEach((r, rank) => {
      const score = weights[signal] / (RRF_K + rank + 1);
      const prev = fused.get(r.chunk_id);
      if (prev) {
        prev.score += score;
        prev.signals[signal] = r.raw;
        if (prev.ranks) prev.ranks[signal] = rank + 1;
      } else {
        fused.set(r.chunk_id, {
          chunkId: r.chunk_id,
          documentId: r.document_id,
          path: r.path,
          title: r.title,
          content: r.content,
          docDate: toDateString(r.doc_date ?? null),
          score,
          signals: { [signal]: r.raw },
          ...(opts.explain ? { ranks: { [signal]: rank + 1 } } : {}),
        });
      }
    });
  };
  fold(vec, 'vector');
  fold(kw, 'keyword');
  fold(gr, 'graph');

  // heat boost: score *= 1 + w * heat (w is small — heat breaks ties, it
  // never overrides relevance)
  const heatCfg = opts.heat ?? defaultConfig().heat;
  const candidates = [...fused.values()];
  const heat = await getDocHeat(store, [...new Set(candidates.map((c) => c.documentId))], heatCfg);
  for (const c of candidates) {
    const h = heat.get(c.documentId);
    if (h) c.score *= 1 + heatCfg.searchWeight * h;
  }

  const results = candidates.sort((a, b) => b.score - a.score).slice(0, k);
  if (opts.track !== false) {
    await recordChunkHits(store, results.map((r) => ({ chunkId: r.chunkId, documentId: r.documentId })), heatCfg);
  }
  return { results, channels };
}
