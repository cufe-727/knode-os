import { HeatConfig, SagSearchConfig, defaultConfig } from '../config.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../store/db.js';
import { gramQuery, MATCH_INDEXES, matchIndexReady, termGrams } from '../store/grams.js';
import { NO_FILTER, ResolvedScopeFilter, documentFilterSql } from '../store/resolver.js';
import { Params, TimeInput, rowLiveAt, toIso, toDateString } from '../store/temporal.js';
import { EmbeddingProvider } from '../ingest/embeddings.js';
import { boostByHeat, recordChunkHits } from '../stats/heat.js';
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
  // only vectors of the query's own space: while a new model's vectors are still coming in
  // (a re-embed, or the deferred backlog) the table holds two (docs/design/12 §3.3)
  const model = p.add(embedder.model);
  const cond = docLiveAt('d', p, asOf, filter);
  const lim = p.add(k);
  return store.query<RankedChunk>(
    `SELECT c.id AS chunk_id, c.document_id, d.path, d.title, d.doc_date, c.content,
            1 - (e.embedding <=> $1::${VECTOR_TYPE}) AS raw
     FROM embeddings e
     JOIN chunks c ON c.id = e.chunk_id
     JOIN documents d ON d.id = c.document_id
     WHERE e.model = ${model} AND ${cond}
     ORDER BY e.embedding <=> $1::${VECTOR_TYPE}
     LIMIT ${lim}`,
    p.list,
  );
}

/**
 * The query as `websearch_to_tsquery` should read it. A `-` that starts a word
 * excludes the word there, and every other `-` still takes a place on the
 * parser's operator stack, which holds 32: a question quoting a passage under
 * a rule of hyphens failed with "tsquery stack too small", and a table's
 * `|---|` excluded the word after it. Only a `-` starting a word stays.
 */
export function websearchText(query: string): string {
  return query.replace(/-{2,}|-(?![\p{L}\p{N}])/gu, ' ');
}

/** Keyword recall: Postgres FTS, with a substring fallback that covers CJK queries. */
async function keywordSearch(store: Store, query: string, k = 10, asOf?: TimeInput, filter?: ResolvedScopeFilter): Promise<RankedChunk[]> {
  const p = new Params([websearchText(query)]);
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
  const like = await substringSearch(store, terms, k, asOf, filter);
  const seen = new Set(fts.map((r) => r.chunk_id));
  return [...fts, ...like.filter((r) => !seen.has(r.chunk_id))].slice(0, k);
}

/**
 * The `k` chunks holding the most of `terms` as case-insensitive substrings,
 * `raw` = how many they hold, ordered by it and then by id.
 *
 * Through the gram index (store/grams.ts) this asks for the chunks holding
 * all n terms, then at least n-1, and so on, each tier one index scan with
 * LIMIT k under a UNION ALL that stops as soon as k rows are in: a tier only
 * runs while the tiers above it had fewer than k rows between them, so it
 * returns no row they hold, and none returns more than k. A query whose
 * common terms hold a quarter of all chunks ("2026", "AI") no longer reads
 * them: on a copy of finance (374k chunks) the 43 agent queries of a benchmark
 * that reach this took 10.7 s at the median and 12.6 s at worst as one ILIKE
 * scan, 42 ms and 237 ms this way. Of the chunks tying at the last tier, the
 * index's order picks which come in, where the scan's planner order did. Until
 * the index is ready, one scan counts every chunk's terms (5–6.5 s there).
 */
async function substringSearch(store: Store, terms: string[], k: number, asOf?: TimeInput, filter?: ResolvedScopeFilter): Promise<RankedChunk[]> {
  const grams = terms.map(termGrams);
  const p = new Params([terms.map((t) => t.toLowerCase())]);
  // lower() once per chunk, then one strpos per term: the ILIKE this replaces lowercased the text once per term
  const hits = `(SELECT count(*) FROM (SELECT lower(c.content) AS l OFFSET 0) x, unnest($1::text[]) t WHERE strpos(x.l, t) > 0)`;
  const cond = docLiveAt('d', p, asOf, filter);
  const lim = p.add(k);
  const columns = `c.id AS chunk_id, c.document_id, d.path, d.title, d.doc_date, c.content`;
  if (!matchIndexReady(store, 'chunks') || grams.some((g) => g.length === 0)) {
    return store.query<RankedChunk>(
      `SELECT * FROM (
         SELECT ${columns}, ${hits}::float AS raw
         FROM chunks c JOIN documents d ON d.id = c.document_id
         WHERE ${cond}
         OFFSET 0
       ) scored
       WHERE raw > 0
       ORDER BY raw DESC, chunk_id
       LIMIT ${lim}`,
      p.list,
    );
  }
  const tiers: string[] = [];
  for (let m = terms.length; m >= 1; m--) {
    const q = p.add(gramQuery(grams, m));
    tiers.push(
      `(SELECT ${columns}, ${m}::float AS raw
        FROM chunks c JOIN documents d ON d.id = c.document_id
        WHERE ${MATCH_INDEXES.chunks.expr('c')} @@ ${q}::tsquery AND ${hits} = ${m} AND ${cond}
        LIMIT ${lim})`,
    );
  }
  return store.query<RankedChunk>(
    `SELECT * FROM (SELECT * FROM (${tiers.join(' UNION ALL ')}) tiers LIMIT ${lim}) top
     ORDER BY raw DESC, chunk_id`,
    p.list,
  );
}

/**
 * SQL holding when one of `terms` is a case-insensitive substring of one of the
 * entity's `fields` (as `field ILIKE '%term%'` did), through the entity gram
 * index once it is ready. The terms become parameters of `p`.
 */
export function entityMatchSql(
  store: Store,
  alias: string,
  terms: string[],
  p: Params,
  fields: ('name' | 'aliases' | 'description')[] = ['name', 'aliases'],
): string {
  const columns = fields.map((f) => (f === 'aliases' ? `lower(${alias}.aliases::text)` : `lower(${alias}.${f})`));
  const exact = terms
    .map((t) => {
      const ph = p.add(t.toLowerCase());
      return columns.map((col) => `strpos(${col}, ${ph}) > 0`).join(' OR ');
    })
    .join(' OR ');
  const grams = terms.map(termGrams);
  if (!matchIndexReady(store, 'entities') || grams.some((g) => g.length === 0)) return `(${exact})`;
  return `(${MATCH_INDEXES.entities.expr(alias)} @@ ${p.add(gramQuery(grams, 1))}::tsquery AND (${exact}))`;
}

/**
 * Chunks mentioning entities whose name/alias matches the query (graph
 * signal): one row per chunk, ranked by how many matching entities it
 * mentions, then by how often those entities are mentioned overall, then by
 * id — RRF reads the rank, so the order must not be the planner's. An entity
 * counts when it was live at `asOf` (the evidence test the other graph routes
 * use), not merely now. `raw` is the matching-entity count, as in graphSearch.
 *
 * "How often" sums each matching entity's mention_count once per mention row
 * it has in the chunk. A query term as common as "存储" or "AI" matches
 * entities with hundreds of thousands of mention rows between them, so the
 * rows are counted per entity, off its own index, and the live documents
 * joined by hash, before any chunk text is read: over 47 agent queries on a
 * copy of finance, 832 ms → 186 ms at the median, 3.0 s → 1.1 s at worst, the
 * same rankings.
 */
async function graphSignal(store: Store, query: string, k = 20, asOf?: TimeInput, filter?: ResolvedScopeFilter): Promise<RankedChunk[]> {
  const terms = queryTerms(query, 5);
  if (terms.length === 0) return [];
  const p = new Params();
  const named = entityMatchSql(store, 'e', terms, p);
  const entityLive = rowLiveAt('e', 'entity', p, asOf);
  const cond = docLiveAt('d', p, asOf, filter);
  const lim = p.add(k);
  return store.query<RankedChunk>(
    `WITH matched AS MATERIALIZED (
       SELECT e.id, e.mention_count FROM entities e WHERE ${named} AND ${entityLive}
     ), docs AS MATERIALIZED (
       SELECT d.id FROM documents d WHERE ${cond}
     ), per_chunk AS (
       SELECT x.chunk_id, min(x.document_id) AS document_id,
              count(*) AS matches, sum(e.mention_count * x.mentions) AS weight
       FROM matched e
       CROSS JOIN LATERAL (
         SELECT m.chunk_id, min(m.document_id) AS document_id, count(*) AS mentions
         FROM entity_mentions m WHERE m.entity_id = e.id
         GROUP BY m.chunk_id
       ) x
       GROUP BY x.chunk_id
     ), ranked AS (
       SELECT pc.chunk_id, pc.matches, pc.weight
       FROM per_chunk pc JOIN docs ON docs.id = pc.document_id
       ORDER BY pc.matches DESC, pc.weight DESC, pc.chunk_id
       LIMIT ${lim}
     )
     SELECT c.id AS chunk_id, c.document_id, d.path, d.title, d.doc_date, c.content, r.matches::float AS raw
     FROM ranked r
     JOIN chunks c ON c.id = r.chunk_id
     JOIN documents d ON d.id = c.document_id
     ORDER BY r.matches DESC, r.weight DESC, c.id`,
    p.list,
  );
}

/**
 * Hybrid search: reciprocal-rank fusion of vector + keyword + graph-mention
 * signals (RRF, k=60 — the same shape gbrain and most hybrid retrievers use).
 * Fused scores get a bounded heat boost (at most `heat.searchWeight`, a
 * tie-break, never dominant), and returned hits are recorded into the usage
 * ledger.
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

  // heat adds at most heat.searchWeight to a score: it breaks near-ties, it
  // never lifts a result above one the channels clearly prefer
  const heatCfg = opts.heat ?? defaultConfig().heat;
  const candidates = [...fused.values()];
  await boostByHeat(store, candidates, heatCfg);

  const results = candidates.sort((a, b) => b.score - a.score).slice(0, k);
  if (opts.track !== false) {
    await recordChunkHits(store, results.map((r) => ({ chunkId: r.chunkId, documentId: r.documentId })), heatCfg);
  }
  return { results, channels };
}
