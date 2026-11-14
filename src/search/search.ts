import { HeatConfig, RerankConfig, SagSearchConfig, defaultConfig } from '../config.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../store/db.js';
import { gramQuery, MATCH_INDEXES, matchIndexReady, termGrams } from '../store/grams.js';
import { NO_FILTER, ResolvedScopeFilter, documentFilterSql } from '../store/resolver.js';
import { RAW_CODEBASE } from '../fs/layout.js';
import { Params, TimeInput, rowLiveAt, toIso, toDateString } from '../store/temporal.js';
import { EmbeddingProvider } from '../ingest/embeddings.js';
import { boostByHeat, recordChunkHits } from '../stats/heat.js';
import { SearchResult } from '../types.js';
import { longestSpans, spellingSpans, weakSpelling } from '../graph/normalize.js';
import { attachCurrent } from './current.js';
import { rerankEnabled, rerankResults } from './rerank.js';

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
  /** Fusion weight per recall channel, over `FUSION_WEIGHTS`; 0 leaves a channel out of the ranking. For measuring a channel's worth. */
  weights?: Partial<Record<SearchChannelName, number>>;
  /**
   * The optional cross-encoder stage (`retrieval.rerank`, src/search/rerank.ts):
   * reorders the fused head before the cut to `k`. Off unless `enabled` and a `url`.
   */
  rerank?: Partial<RerankConfig>;
  /**
   * Attach to each hit the claims that replaced claims read off it
   * (`SearchResult.current`, src/search/current.ts). Default on; one query.
   */
  current?: boolean;
  /**
   * The part of the results generated pages may take, over `GENERATED_SHARE`;
   * 1 ranks them with the sources as one list. For measuring the share's worth.
   */
  generatedShare?: number;
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
  /** The channels that ran: all three in hybrid mode, one in vector or keyword mode, none for SAG; `rerank` when that stage ran. */
  channels: Partial<Record<SearchChannelName | 'rerank', SearchChannel>>;
}

interface RankedChunk {
  doc_date?: string | Date | null;
  chunk_id: string;
  document_id: string;
  path: string;
  title: string | null;
  content: string;
  raw: number;
  /** Of a generated page (`isGeneratedSql`), not of a source. */
  generated?: boolean;
}

/**
 * The part of a search's results that chunks of generated pages may take:
 * a quarter, 2 of the 8 chunks an answer is written from.
 *
 * A generated page (`isGeneratedSql`: an entity page, a mentions page, a
 * timeline, a navigation list) restates what sources say, and a knowledge
 * base grows several chunks of them per source document. Ranked as one list
 * they take the places: on the 2026-11 separation benchmark's 10× index (8,016
 * chunks: 1,540 of source documents, 6,469 of wiki pages) the top 8 held 14%
 * source chunks, none at all for 156 of 297 questions, and the keyword
 * channel's candidates were pages before any source. So every recall channel
 * lists its best chunks of sources and of generated pages separately, ranks
 * the two lists together by its own score, and the cut gives pages this
 * share. Replayed on a copy of that index (the 297 questions the run asked
 * that have gold documents; questions with a gold source document in the top
 * 5 / top 8 of a search for 8):
 *
 *   one list (before)       16 /  29
 *   separate lists, 1       48 /  63    sources reach the candidates, pages still take the places
 *   0.5                     67 /  96
 *   0.375                   77 / 102
 *   0.25                    87 / 104
 *   0.125                   94 / 106
 *   0                      101 / 108
 *
 * A quarter reaches 104 of the 108 questions sources alone would, and keeps
 * the two best pages in an answer's context: an entity page is where the
 * claims about a name are gathered, and what an agent navigates by. Pages
 * rank where the channels put them, so the first results may be pages (top 5:
 * 87, against 101 without them). A search that asks for pages
 * (`kinds: ['view']`), or finds fewer sources than it has places, is filled
 * with pages as before; an index without generated pages ranks as before.
 */
export const GENERATED_SHARE = 0.25;

/** How many of `k` results generated pages may take at `share`. */
export function generatedPlaces(k: number, share: number): number {
  return Math.min(k, Math.max(0, Math.round(k * Math.min(1, Math.max(0, share)))));
}

/**
 * SQL: the document at `alias` is a generated page — a view of the index
 * (`kind = 'view'`: an entity page, a mentions page, a timeline) or one of the
 * wiki's navigation lists (`isReservedWikiFile`: every folder's index.md),
 * which ingest files as sources that the graph does not read. A wiki page a
 * person or an agent wrote is a source.
 */
const isGeneratedSql = (alias: string) => `(${alias}.kind = 'view' OR (${alias}.root = 'wiki' AND ${alias}.path ~ '(^|/)(index|log)[.]md$'))`;

/** The best `k` of the sources and the best `k` of the generated pages in `ranked`, in its order. */
function bestOfEachSide(ranked: RankedChunk[], k: number): RankedChunk[] {
  const taken = [0, 0];
  return ranked.filter((r) => taken[r.generated ? 1 : 0]++ < k);
}

/** Two lists a channel ranked by the same score, as one: best first, a source before a page of equal score. */
function mergeSides(sources: RankedChunk[], generated: RankedChunk[]): RankedChunk[] {
  const out: RankedChunk[] = [];
  let i = 0;
  let j = 0;
  while (i < sources.length || j < generated.length) {
    if (j >= generated.length || (i < sources.length && sources[i].raw >= generated[j].raw)) out.push(sources[i++]);
    else out.push(generated[j++]);
  }
  return out;
}

const CJK_QUERY_STOP = new Set([
  '什么', '哪些', '如何', '怎么', '怎样', '为何', '为什么', '多少', '是否', '哪个', '哪里',
  '分别', '相关', '关于', '对于', '通过', '以及', '或者', '还是', '及其', '其中', '此次',
  '进行', '具有', '可以', '需要', '影响', '情况', '问题', '内容', '方面', '包括', '主要',
]);

/**
 * English function and question words: in a natural-language question they
 * are most of the tokens, hold nothing to look for, and as substrings ("is",
 * "on", "the") sit in nearly every chunk and many entity names. A token
 * written in capitals stays (US, IT, WHO are names).
 */
const LATIN_QUERY_STOP = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'from', 'by', 'with', 'about', 'as', 'into', 'than', 'between', 'during',
  'and', 'or', 'but', 'not', 'no', 'nor', 'if', 'then', 'so', 'such', 'also', 'both', 'either', 'each', 'any', 'all', 'some',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'done', 'has', 'have', 'had', 'having',
  'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must', 'shall',
  'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their', 'he', 'she', 'his', 'her', 'him', 'we', 'us', 'our', 'you', 'your', 'my', 'me',
  'who', 'whom', 'whose', 'what', 'which', 'when', 'where', 'why', 'how', 'there', 'here',
]);

/**
 * The Latin tokens of a query worth looking for: runs of [a-zA-Z0-9_.$-]
 * without the punctuation a sentence leaves at their ends ("show." would only
 * match before a full stop), stopwords dropped, each spelling once. A word the
 * query excludes (`-word`) is not one to look for.
 */
function latinTokens(query: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of query.matchAll(/[a-zA-Z0-9_.$-]{2,}/g)) {
    if (/^-[a-zA-Z0-9]/.test(m[0]) && (m.index === 0 || /\s/.test(query[m.index - 1]))) continue;
    const t = m[0].replace(/^[._-]+|[._$-]+$/g, '');
    if (t.length < 2) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    if (LATIN_QUERY_STOP.has(k) && t !== t.toUpperCase()) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * Terms for substring-based recall (graph entity matching, SAG, explore).
 * Whitespace tokens cover Latin; CJK runs — which carry no spaces, so a
 * natural-language question would never match as a whole — are broken into
 * overlapping bigrams with question-word stopwords removed.
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

  for (const t of latinTokens(query)) push(t);

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

/** Terms the keyword channel scores at most: a pasted paragraph is read by its first ones. */
const KEYWORD_TERMS_MAX = 24;

/**
 * Every term the keyword channel scores a chunk by, lowercased: the Latin
 * tokens, and each CJK run as its bigrams (a run of up to four characters
 * also whole, so the chunk that spells the name outranks one holding its
 * halves apart). Unlike `queryTerms` it keeps them all, in query order: which
 * of them matter is decided by how rare each is in the corpus.
 */
export function keywordTerms(query: string, max = KEYWORD_TERMS_MAX): string[] {
  const terms = new Set<string>();
  for (const t of latinTokens(query)) terms.add(t.toLowerCase());
  for (const run of query.matchAll(/[一-鿿㐀-䶿]{2,}/g)) {
    const s = run[0];
    if (s.length <= 4 && !CJK_QUERY_STOP.has(s)) terms.add(s);
    for (let i = 0; i + 2 <= s.length; i++) {
      const b = s.slice(i, i + 2);
      if (!CJK_QUERY_STOP.has(b)) terms.add(b);
    }
  }
  return [...terms].slice(0, max);
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
  // a repository is thousands of chunks of code: it answers when asked for (kind
  // `code`, or a source under raw/codebase), never by outnumbering the prose
  if (!wantsCode(filter)) parts.push(`${alias}.root <> 'codebase'`);
  return parts.join(' AND ');
}

/** True when a search asked for code: kind `code`, or a source prefix inside raw/codebase. */
export function wantsCode(filter: ResolvedScopeFilter): boolean {
  if (filter.kinds?.includes('code')) return true;
  return Boolean(filter.sources?.some((s) => s === RAW_CODEBASE || s.startsWith(`${RAW_CODEBASE}/`)));
}

const iterativeScans = new WeakMap<object, Promise<boolean>>();

/**
 * Whether the store's pgvector scans its index iteratively (0.8.0 on): asked
 * once per store. Without it a filtered search is left to what one walk of
 * the index finds.
 */
function scansIteratively(store: Store): Promise<boolean> {
  let known = iterativeScans.get(store);
  if (!known) {
    known = store
      .query<{ v: string }>(`SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'`)
      .then(([row]) => {
        const [major, minor] = (row?.v ?? '0.0').split('.').map(Number);
        return major > 0 || minor >= 8;
      })
      .catch(() => false);
    iterativeScans.set(store, known);
  }
  return known;
}

const sidesHeld = new WeakMap<object, { sources: boolean; generated: boolean; at: number }>();

/** Which sides the index holds documents of, asked at most once a minute per store: a side without any is not searched. */
async function sidesOfIndex(store: Store): Promise<{ sources: boolean; generated: boolean }> {
  const hit = sidesHeld.get(store);
  if (hit && Date.now() - hit.at < 60_000) return hit;
  const [row] = await store.query<{ sources: boolean; generated: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM documents d WHERE NOT ${isGeneratedSql('d')}) AS sources,
            EXISTS (SELECT 1 FROM documents d WHERE ${isGeneratedSql('d')}) AS generated`,
  );
  const held = { sources: row?.sources !== false, generated: row?.generated !== false, at: Date.now() };
  sidesHeld.set(store, held);
  return held;
}

/**
 * Pure vector recall: cosine distance over pgvector, the nearest `k` chunks of
 * sources or of generated pages. One side a query, each an ordered scan the
 * vector index can serve; a window over both sides would read every vector.
 *
 * The side, like any filter here, is tested after the index is walked, and
 * one walk of an HNSW index ends at `hnsw.ef_search` (40) rows: where pages
 * are the nearest, the nearest 40 hold a handful of sources, and both sides
 * read the same 40. On a copy of the 10× separation index in PostgreSQL 17
 * (pgvector 0.8.7), over 200 question vectors asked for 24 sources:
 *
 *   one walk                   3.9 rows, 197 queries short, 0.16 of the exact 24, 1.8 ms
 *   iterative, strict_order   24 rows,     0 short,          0.90,                 6.2 ms
 *   iterative, relaxed_order  24 rows,     0 short,          0.96,                 6.2 ms
 *
 * and the replay found a gold document in the top 8 for 79 of 297 questions
 * where the same index in PGlite, which scans every vector, found 104. So the
 * query runs with `hnsw.iterative_scan = relaxed_order`: the index is walked
 * on until `k` rows pass the filter (or `hnsw.max_scan_tuples`, 20,000, are
 * read). That scan may hand rows over a little out of order, so they are
 * sorted here. The setting is local to a transaction of the one query; a
 * pgvector before 0.8.0 has no such scan and answers as before.
 */
async function vectorSide(
  store: Store,
  embedder: EmbeddingProvider,
  qv: number[],
  k: number,
  generated: boolean,
  asOf?: TimeInput,
  filter?: ResolvedScopeFilter,
): Promise<RankedChunk[]> {
  const p = new Params([toVectorLiteral(qv)]);
  // only vectors of the query's own space: while a new model's vectors are still coming in
  // (a re-embed, or the deferred backlog) the table holds two (docs/design/12 §3.3)
  const model = p.add(embedder.model);
  const cond = docLiveAt('d', p, asOf, filter);
  const lim = p.add(k);
  const sql = `SELECT c.id AS chunk_id, c.document_id, d.path, d.title, d.doc_date, c.content,
            1 - (e.embedding <=> $1::${VECTOR_TYPE}) AS raw, ${generated} AS generated
     FROM embeddings e
     JOIN chunks c ON c.id = e.chunk_id
     JOIN documents d ON d.id = c.document_id
     WHERE e.model = ${model} AND ${cond} AND ${generated ? '' : 'NOT '}${isGeneratedSql('d')}
     ORDER BY e.embedding <=> $1::${VECTOR_TYPE}
     LIMIT ${lim}`;
  if (!(await scansIteratively(store))) return store.query<RankedChunk>(sql, p.list);
  const rows = await store.tx(async (q) => {
    await q.query(`SET LOCAL hnsw.iterative_scan = relaxed_order`);
    return q.query<RankedChunk>(sql, p.list);
  });
  return rows.sort((a, b) => b.raw - a.raw);
}

/** Vector recall: the nearest `k` chunks of sources and the nearest `k` of generated pages, as one list by similarity. */
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
  // a search for certain kinds reads the sides they are on, and no side the index holds nothing of:
  // an iterative scan for rows that are not there walks the index to its limit
  const kinds = filter?.kinds;
  const held = await sidesOfIndex(store);
  const [sources, generated] = await Promise.all([
    held.sources && (!kinds || kinds.some((kind) => kind !== 'view')) ? vectorSide(store, embedder, qv, k, false, asOf, filter) : [],
    held.generated && (!kinds || kinds.includes('view')) ? vectorSide(store, embedder, qv, k, true, asOf, filter) : [],
  ]);
  return mergeSides(sources, generated);
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

/** Terms whose chunks are listed as candidates: the rarest ones. */
const KEYWORD_FETCH_TERMS = 8;
/** A term found in this many chunks is counted, and listed, no further. */
const KEYWORD_DF_CAP = 1000;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

const chunkTotals = new WeakMap<object, { n: number; at: number }>();

/** How many chunks the index holds, counted at most once a minute per store. */
async function chunkTotal(store: Store): Promise<number> {
  const hit = chunkTotals.get(store);
  if (hit && Date.now() - hit.at < 60_000) return hit.n;
  const [row] = await store.query<{ n: number }>(`SELECT count(*)::int AS n FROM chunks`);
  const n = row?.n ?? 0;
  chunkTotals.set(store, { n, at: Date.now() });
  return n;
}

const isAlnum = (ch: string | undefined) => ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9'));

/**
 * How often `term` occurs in lowercased `text`. A CJK term counts wherever it
 * stands. A Latin one must start a word, and end one too when it is short or
 * a number ("ai" is not in "aim", "2026" not in "20261"); a longer word also
 * counts with an ending on it (limit: limits, limited).
 */
export function termCount(text: string, term: string): number {
  const cjk = term.charCodeAt(0) >= 0x3400;
  const whole = !cjk && (term.length < 4 || /^[\d.,_-]+$/.test(term));
  let n = 0;
  for (let i = text.indexOf(term); i >= 0; i = text.indexOf(term, i + term.length)) {
    if (cjk) n++;
    else if (!(isAlnum(term[0]) && isAlnum(text[i - 1])) && !(whole && isAlnum(term[term.length - 1]) && isAlnum(text[i + term.length]))) n++;
  }
  return n;
}

const idfOf = (df: number, total: number) => Math.log(1 + (Math.max(total, df) - df + 0.5) / (df + 0.5));

/**
 * Each term's weight from how many chunks hold it, out of `total`: zero for a
 * term none holds, and a count stopped at `KEYWORD_DF_CAP` (all a lookup reads
 * of a common term) taken as the geometric mean of the cap and the corpus.
 */
function termIdf(df: number[], total: number): number[] {
  const common = Math.max(KEYWORD_DF_CAP, Math.round(Math.sqrt(KEYWORD_DF_CAP * Math.max(total, KEYWORD_DF_CAP))));
  return df.map((n) => (n > 0 ? idfOf(n >= KEYWORD_DF_CAP ? common : n, total) : 0));
}

/** The terms whose chunks are candidates: the `KEYWORD_FETCH_TERMS` rarest that some chunk holds, ties in query order. */
function rarestTerms(df: number[]): number[] {
  return df.map((n, i) => ({ n, i })).filter((x) => x.n > 0).sort((a, b) => a.n - b.n || a.i - b.i).slice(0, KEYWORD_FETCH_TERMS).map((x) => x.i);
}

/**
 * What a candidate holding the picked terms in `mask` (bit j for `picked[j]`)
 * is put forward by: their summed weight, added in one order, so the lookup
 * and the scan weigh a chunk to the same last bit.
 */
function pickedWeight(mask: number, picked: number[], idf: number[]): number {
  let w = 0;
  for (let j = 0; j < picked.length; j++) if (mask & (1 << j)) w += idf[picked[j]];
  return w;
}

/**
 * BM25 over `rows` for weighted `terms`, best first, ties by id; rows holding
 * none of the terms are left out. Length is in characters against the rows'
 * own average: the chunker keeps chunks near one size, so what this corrects
 * is the short tail of a document against a full chunk.
 */
function rankBm25(rows: RankedChunk[], terms: { term: string; idf: number }[]): RankedChunk[] {
  if (rows.length === 0) return rows;
  const avg = rows.reduce((sum, r) => sum + r.content.length, 0) / rows.length || 1;
  const scored: RankedChunk[] = [];
  for (const r of rows) {
    const text = r.content.toLowerCase();
    const norm = BM25_K1 * (1 - BM25_B + (BM25_B * r.content.length) / avg);
    let score = 0;
    for (const t of terms) {
      const tf = termCount(text, t.term);
      if (tf > 0) score += (t.idf * tf * (BM25_K1 + 1)) / (tf + norm);
    }
    if (score > 0) scored.push({ ...r, raw: score });
  }
  return scored.sort((a, b) => b.raw - a.raw || (a.chunk_id < b.chunk_id ? -1 : a.chunk_id > b.chunk_id ? 1 : 0));
}

/** A quoted phrase or an excluded word: the asker's own filter, which full-text search applies and BM25 does not. */
const hasSearchOperators = (query: string) => /"[^"]+"|(^|\s)-[\p{L}\p{N}]/u.test(query);

/**
 * Keyword recall: BM25 over the chunks that hold the query's terms, the best
 * `k` of sources and the best `k` of generated pages as one list. Candidates
 * are listed for each side on its own: a name is on its entity page, its
 * mentions page and every page that links it, and one list of candidates
 * held little else.
 *
 * The terms are the query's words and CJK bigrams without stopwords
 * (`keywordTerms`), each weighted by how rare it is in the corpus. Candidates
 * come from two index lookups: full-text search for the chunks holding every
 * word, and `listedCandidates` for the chunks holding the rarest terms. BM25
 * then orders them, so a chunk with the one rare name the question turns on
 * outranks chunks that repeat its common words — which counting matched
 * terms, with ties by id, could not do: on the benchmark's English multi-hop
 * questions (MuSiQue, on the workspace the 2026-11 pilot built) this channel
 * alone found 8% of the gold documents in its top five where BM25 over the
 * same text finds 36%; it now finds 39%.
 *
 * A query with a quoted phrase or an excluded word keeps what full-text
 * search matched in front, in its order. Until the gram index is ready (and
 * for a term no gram index serves), scans stand in for the two lookups and
 * reproduce them: each term counted over every chunk, the candidates weighed
 * by the same terms, so a search ranks alike before and after the index is
 * there (`scannedFrequencies`, `scannedCandidates`).
 */
async function keywordSearch(store: Store, query: string, k = 10, asOf?: TimeInput, filter?: ResolvedScopeFilter): Promise<RankedChunk[]> {
  const p = new Params([websearchText(query)]);
  const cond = docLiveAt('d', p, asOf, filter);
  const lim = p.add(k);
  const fts = await store.query<RankedChunk>(
    `SELECT chunk_id, document_id, path, title, doc_date, content, raw, generated FROM (
       SELECT ${CANDIDATE_COLUMNS}, ts_rank(c.tsv, websearch_to_tsquery('simple', $1)) AS raw,
              row_number() OVER (PARTITION BY ${isGeneratedSql('d')} ORDER BY ts_rank(c.tsv, websearch_to_tsquery('simple', $1)) DESC) AS place
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE c.tsv @@ websearch_to_tsquery('simple', $1) AND ${cond}
     ) matched
     WHERE place <= ${lim}
     ORDER BY raw DESC`,
    p.list,
  );

  const terms = keywordTerms(query);
  if (terms.length === 0) return fts;
  const size = Math.max(k * 4, 120);
  const total = await chunkTotal(store);
  const lists = matchIndexReady(store, 'chunks') && terms.every((t) => termGrams(t).length > 0) ? await termLists(store, terms, asOf, filter) : null;
  const df = lists?.df ?? (await scannedFrequencies(store, terms));
  const idf = termIdf(df, total);
  const like = lists
    ? await listedCandidates(store, terms, idf, lists, size, asOf, filter)
    : await scannedCandidates(store, terms, idf, rarestTerms(df), size, asOf, filter);

  const seen = new Set(fts.map((r) => r.chunk_id));
  const pool = [...fts, ...like.filter((r) => !seen.has(r.chunk_id))];
  // a term no chunk holds finds nothing and weighs nothing
  const scoredTerms = terms.map((term, i) => ({ term, idf: idf[i] })).filter((t) => t.idf > 0);
  const ranked = rankBm25(pool, scoredTerms);
  if (!hasSearchOperators(query)) return bestOfEachSide(ranked, k);
  return bestOfEachSide([...fts, ...ranked.filter((r) => !seen.has(r.chunk_id))], k);
}

const CANDIDATE_COLUMNS = `c.id AS chunk_id, c.document_id, d.path, d.title, d.doc_date, c.content, ${isGeneratedSql('d')} AS generated`;

interface TermLists {
  /** Chunks holding each term, counted up to `KEYWORD_DF_CAP`. */
  df: number[];
  /** The live chunks of the `KEYWORD_FETCH_TERMS` rarest terms: term index, chunk id, whether a generated page's. */
  listed: { i: number; id: string; generated: boolean }[];
  /** The terms whose chunks are in `listed`. */
  picked: number[];
}

/**
 * Each term's chunks, read off the gram index (store/grams.ts) once, at most
 * `KEYWORD_DF_CAP` per term: how many there are (a count stopped at the cap
 * means "common"), and for the rarest terms which they are, among documents
 * live and in scope. The index holds a superset of the substring matches (a
 * Latin term's trigrams can sit in different words), near enough for a weight
 * and corrected when the text is scored.
 *
 * The index lookups run in a materialized CTE, away from the join with
 * `documents`. Joined directly, a planner without statistics (PGlite never
 * analyzes) starts from `documents` and evaluates `match_grams` on every
 * chunk as a filter: 1,050 ms for a lookup the index answers in 3 ms on 1,759
 * chunks.
 */
async function termLists(store: Store, terms: string[], asOf?: TimeInput, filter?: ResolvedScopeFilter): Promise<TermLists> {
  const p = new Params();
  const expr = MATCH_INDEXES.chunks.expr('c');
  const cap = p.add(KEYWORD_DF_CAP);
  const lists = terms.map((t, i) => `(SELECT ${i} AS i, c.id, c.document_id FROM chunks c WHERE ${expr} @@ ${p.add(gramQuery([termGrams(t)], 1))}::tsquery LIMIT ${cap})`);
  const fetch = p.add(KEYWORD_FETCH_TERMS);
  const cond = docLiveAt('d', p, asOf, filter);
  const rows = await store.query<{ i: number; id: string | null; df: number | null; generated: boolean | null }>(
    `WITH hit AS MATERIALIZED (${lists.join(' UNION ALL ')}),
          n AS MATERIALIZED (SELECT i, count(*)::int AS df FROM hit GROUP BY i),
          pick AS MATERIALIZED (SELECT i FROM n ORDER BY df, i LIMIT ${fetch})
     SELECT n.i, NULL::text AS id, n.df, NULL::boolean AS generated FROM n
     UNION ALL
     SELECT h.i, h.id, NULL::int AS df, ${isGeneratedSql('d')} AS generated
     FROM hit h JOIN pick ON pick.i = h.i JOIN documents d ON d.id = h.document_id
     WHERE ${cond}`,
    p.list,
  );
  const df = terms.map(() => 0);
  const listed: TermLists['listed'] = [];
  for (const r of rows) {
    if (r.id === null) df[r.i] = r.df ?? 0;
    else listed.push({ i: r.i, id: r.id, generated: r.generated === true });
  }
  return { df, listed, picked: rarestTerms(df) };
}

/**
 * About `pool` chunks of sources and `pool` of generated pages worth scoring:
 * on each side, the ones the listed terms weigh the most in together. A chunk
 * is put forward by the summed weight of the terms whose
 * lists hold it — BM25 with every count taken as one, which is what an
 * inverted index can say before any text is read — and the text of each
 * side's best `pool` is fetched for the caller to score exactly.
 *
 * A list cut at the cap holds some of its term's chunks, so two such terms
 * would meet in a chunk only by chance: when one of the picked terms is that
 * common, the chunks holding all of them are asked for as well.
 */
async function listedCandidates(
  store: Store,
  terms: string[],
  idf: number[],
  lists: TermLists,
  pool: number,
  asOf?: TimeInput,
  filter?: ResolvedScopeFilter,
): Promise<RankedChunk[]> {
  const { picked } = lists;
  const held = new Map<string, number>();
  const generated = new Set<string>();
  for (const r of lists.listed) {
    const j = picked.indexOf(r.i);
    if (j < 0) continue;
    held.set(r.id, (held.get(r.id) ?? 0) | (1 << j));
    if (r.generated) generated.add(r.id);
  }
  if (picked.length > 1 && picked.some((i) => lists.df[i] >= KEYWORD_DF_CAP)) {
    const p = new Params([gramQuery(picked.map((i) => termGrams(terms[i])), picked.length)]);
    const lim = p.add(pool);
    const cond = docLiveAt('d', p, asOf, filter);
    const rows = await store.query<{ id: string; generated: boolean }>(
      `WITH hit AS MATERIALIZED (SELECT c.id, c.document_id FROM chunks c WHERE ${MATCH_INDEXES.chunks.expr('c')} @@ $1::tsquery LIMIT ${lim})
       SELECT h.id, ${isGeneratedSql('d')} AS generated FROM hit h JOIN documents d ON d.id = h.document_id WHERE ${cond}`,
      p.list,
    );
    for (const r of rows) {
      held.set(r.id, (1 << picked.length) - 1);
      if (r.generated) generated.add(r.id);
    }
  }
  const weighed = [...held.entries()]
    .map(([id, mask]) => [id, pickedWeight(mask, picked, idf)] as const)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const ids = [false, true].flatMap((side) => weighed.filter(([id]) => generated.has(id) === side).slice(0, pool).map(([id]) => id));
  if (ids.length === 0) return [];
  return store.query<RankedChunk>(
    `SELECT ${CANDIDATE_COLUMNS}, 0::float AS raw
     FROM chunks c JOIN documents d ON d.id = c.document_id
     WHERE c.id = ANY($1::text[])`,
    [ids],
  );
}

/**
 * SQL holding when lowercased text `l` holds every gram of `term` that the
 * gram index would look up (`termGrams`; the term itself when it has none):
 * a gram's characters are all of one class `match_grams` takes runs of, so
 * the text holds it as a substring exactly when `match_grams` lists it.
 */
function holdsGramsSql(l: string, term: string, p: Params): string {
  const grams = termGrams(term);
  return (grams.length > 0 ? grams : [term]).map((g) => `strpos(${l}, ${p.add(g)}) > 0`).join(' AND ');
}

/**
 * How many chunks hold each term, by one scan of every chunk, counted as
 * `termLists` counts them off the gram index: what answers while that index
 * is being built.
 */
async function scannedFrequencies(store: Store, terms: string[]): Promise<number[]> {
  const p = new Params();
  // lower() once per chunk, then strpos per gram
  const counts = terms.map((t, i) => `count(*) FILTER (WHERE ${holdsGramsSql('x.l', t, p)})::int AS d${i}`);
  const [row] = await store.query<Record<string, number>>(`SELECT ${counts.join(', ')} FROM (SELECT lower(c.content) AS l FROM chunks c OFFSET 0) x`, p.list);
  return terms.map((_, i) => Math.min(row?.[`d${i}`] ?? 0, KEYWORD_DF_CAP));
}

/**
 * On each side (sources, generated pages) the `pool` live chunks the `picked`
 * terms weigh the most in together, by one scan, ordered as
 * `listedCandidates` orders the chunks of its lists: by the
 * summed weight of the picked terms each holds, then by id. The weights of
 * the possible sets of picked terms are ranked here, so the database sorts by
 * a set's rank and the sums are the ones the lookup makes. Where a picked term
 * is in more chunks than a lookup lists (`KEYWORD_DF_CAP`), the lookup reads
 * some of them and this all of them, and the two can put forward different
 * chunks; below the cap they put forward the same.
 */
async function scannedCandidates(
  store: Store,
  terms: string[],
  idf: number[],
  picked: number[],
  pool: number,
  asOf?: TimeInput,
  filter?: ResolvedScopeFilter,
): Promise<RankedChunk[]> {
  if (picked.length === 0) return [];
  const weights = Array.from({ length: (1 << picked.length) - 1 }, (_, m) => pickedWeight(m + 1, picked, idf));
  const distinct = [...new Set(weights)].sort((a, b) => b - a);
  const p = new Params([weights.map((w) => distinct.indexOf(w))]);
  const mask = picked.map((i, j) => `CASE WHEN ${holdsGramsSql('x.l', terms[i], p)} THEN ${1 << j} ELSE 0 END`).join(' + ');
  const cond = docLiveAt('d', p, asOf, filter);
  const lim = p.add(pool);
  // lower() once per chunk, then strpos per gram
  return store.query<RankedChunk>(
    `SELECT chunk_id, document_id, path, title, doc_date, content, 0::float AS raw, generated FROM (
       SELECT held.*, row_number() OVER (PARTITION BY generated ORDER BY ($1::int[])[mask], chunk_id COLLATE "C") AS place FROM (
         SELECT ${CANDIDATE_COLUMNS}, ${mask} AS mask
         FROM chunks c JOIN documents d ON d.id = c.document_id, LATERAL (SELECT lower(c.content) AS l OFFSET 0) x
         WHERE ${cond}
         OFFSET 0
       ) held
       WHERE mask > 0
     ) placed
     WHERE place <= ${lim}
     ORDER BY generated, place`,
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

/** Units of a query read for the entities it names: a pasted paragraph is read by its start. */
const NAMED_UNITS_MAX = 120;

/**
 * The entities a query names, live at `asOf`: every run of its words (or of
 * its CJK characters) that is one of an entity's spellings, looked up by the
 * normalized keys entity resolution keeps (`entity_alias_keys`, on its
 * index), with the entities merged into them. The rules are `findLinks`':
 * a Latin spelling matches whole words, a CJK one anywhere in a run, a
 * number of fewer than five digits or a Latin spelling of fewer than three
 * letters names nothing, and where two spellings overlap the longer wins
 * ("Large Language Models", not "Language Models" beside it). Unlike the link
 * index it reads every type of entity: law-cn's statutes and its 本法 are
 * concepts.
 *
 * Keys are kept for live entities only, so an entity retired since `asOf`
 * is not found here; the term match the channel falls back on still finds it.
 */
async function namedInQuery(store: Store, query: string, asOf?: TimeInput): Promise<string[]> {
  const spans = spellingSpans(query, NAMED_UNITS_MAX).filter((s) => !weakSpelling(s.key));
  if (spans.length === 0) return [];
  const p = new Params([[...new Set(spans.map((s) => s.key))]]);
  const entityLive = rowLiveAt('e', 'entity', p, asOf);
  const rows = await store.query<{ alias_key: string; id: string }>(
    `SELECT k.alias_key, e.id FROM entity_alias_keys k JOIN entities e ON e.id = k.entity_id
     WHERE k.alias_key = ANY($1::text[]) AND ${entityLive}`,
    p.list,
  );
  const byKey = new Map<string, string[]>();
  for (const r of rows) byKey.set(r.alias_key, [...(byKey.get(r.alias_key) ?? []), r.id]);
  const ids = new Set(longestSpans(spans.filter((s) => byKey.has(s.key))).flatMap((s) => byKey.get(s.key)!));
  if (ids.size === 0) return [];
  // a merged entity's mentions may still be filed under its own id
  const q = new Params([[...ids]]);
  const memberLive = rowLiveAt('e', 'entity', q, asOf);
  for (const r of await store.query<{ id: string }>(`SELECT e.id FROM entities e WHERE e.canonical_id = ANY($1::text[]) AND ${memberLive}`, q.list)) ids.add(r.id);
  return [...ids];
}

/** Live entities (at `asOf`) whose name or alias holds one of the query's terms: what the graph channel matched before it read names. */
async function entitiesHoldingTerms(store: Store, query: string, asOf?: TimeInput): Promise<string[]> {
  const terms = queryTerms(query, 5);
  if (terms.length === 0) return [];
  const p = new Params();
  const holding = entityMatchSql(store, 'e', terms, p);
  const entityLive = rowLiveAt('e', 'entity', p, asOf);
  return (await store.query<{ id: string }>(`SELECT e.id FROM entities e WHERE ${holding} AND ${entityLive}`, p.list)).map((r) => r.id);
}

/**
 * Chunks mentioning the entities the query names (graph signal), the best `k`
 * of sources and the best `k` of generated pages: one row per chunk, ranked
 * by the summed rarity of the named entities it mentions — each
 * weighted by the BM25 IDF of the chunks it is mentioned in, as the keyword
 * channel weighs a term — then by how many it mentions, then by id: RRF reads
 * the rank, so the order must not be the planner's. A query that names no
 * entity is matched as before, by the entities whose name or alias holds one
 * of its terms. An entity counts when it was live at `asOf` (the evidence
 * test the other graph routes use), not merely now. `raw` is the summed IDF.
 *
 * It used to match every entity holding a query term as a substring and rank
 * by how many such entities a chunk mentions, then by their summed mention
 * counts: fragments of the question's words, and a preference for the chunks
 * about the most popular entities. On copies of the 2026-11 pilot's five
 * public packs (180 questions, recall@5 of gold documents among the channel's
 * own hits) that put 0.28 in the top five; naming plus rarity puts 0.51
 * there (public-musique 0.21 → 0.40, research-ai 0.40 → 0.74, medicine-us
 * 0.20 → 0.68, synthetic-life-zh 0.17 → 0.30, law-cn 0.40 → 0.44); names
 * alone, without the fallback, 0.49. Measured and left out, each costing
 * hybrid recall somewhere against this channel: normalising by how many
 * entities a chunk mentions (0.50 alone; synthetic-life-zh and medicine-us
 * lower), letting overlapping spellings all count (0.55; public-musique
 * lower), the term match beside the names at a tenth of their weight (0.54;
 * law-cn lower), one hop through relations to the named entities'
 * neighbours at 0.1 or 0.3 of their weight (0.55 and 0.54;
 * synthetic-life-zh and public-musique lower), and letting chunks of equal
 * score share one rank (synthetic-life-zh lower).
 *
 * The mention rows are read per entity, off its own index, and the live
 * documents joined by hash, before any chunk text is read: a hub such as
 * "AI" has hundreds of thousands of mention rows (over 47 agent queries on a
 * copy of finance, that shape took the old query from 832 ms to 186 ms at the
 * median). The same rows give each entity's chunk count for its IDF.
 */
async function graphSignal(store: Store, query: string, k = 20, asOf?: TimeInput, filter?: ResolvedScopeFilter): Promise<RankedChunk[]> {
  let seeds = await namedInQuery(store, query, asOf);
  if (seeds.length === 0) seeds = await entitiesHoldingTerms(store, query, asOf);
  if (seeds.length === 0) return [];
  const p = new Params([seeds]);
  const cond = docLiveAt('d', p, asOf, filter);
  const total = p.add(await chunkTotal(store));
  const lim = p.add(k);
  return store.query<RankedChunk>(
    `WITH seeds AS MATERIALIZED (
       SELECT DISTINCT unnest($1::text[]) AS id
     ), docs AS MATERIALIZED (
       SELECT d.id, ${isGeneratedSql('d')} AS generated FROM documents d WHERE ${cond}
     ), hits AS MATERIALIZED (
       SELECT s.id AS entity_id, x.chunk_id, x.document_id, count(*) OVER (PARTITION BY s.id)::float AS df
       FROM seeds s
       CROSS JOIN LATERAL (
         SELECT m.chunk_id, min(m.document_id) AS document_id
         FROM entity_mentions m WHERE m.entity_id = s.id
         GROUP BY m.chunk_id
       ) x
     ), per_chunk AS (
       SELECT h.chunk_id, min(h.document_id) AS document_id, count(*) AS matches,
              sum(ln(1 + (greatest(${total}::float, h.df) - h.df + 0.5) / (h.df + 0.5))) AS weight
       FROM hits h
       GROUP BY h.chunk_id
     ), ranked AS (
       SELECT pc.chunk_id, pc.matches, pc.weight, docs.generated,
              row_number() OVER (PARTITION BY docs.generated ORDER BY pc.weight DESC, pc.matches DESC, pc.chunk_id) AS place
       FROM per_chunk pc JOIN docs ON docs.id = pc.document_id
     )
     SELECT c.id AS chunk_id, c.document_id, d.path, d.title, d.doc_date, c.content, r.weight AS raw, r.generated
     FROM ranked r
     JOIN chunks c ON c.id = r.chunk_id
     JOIN documents d ON d.id = c.document_id
     WHERE r.place <= ${lim}
     ORDER BY r.weight DESC, r.matches DESC, c.id`,
    p.list,
  );
}


/**
 * What a rank in each recall channel is worth in the fusion.
 *
 * The graph channel ranks chunks by the entities they mention, not by what
 * they say. Measured on copies of the 2026-11 pilot's workspaces for five
 * public packs (180 questions, recall@5 of gold source documents): vectors
 * alone 0.79, keywords alone 0.75, the graph channel alone 0.51 (0.28 when it
 * matched entities by fragments of the query's terms). Hybrid recall by graph
 * weight, mean over the packs (synthetic-life-zh / research-ai / law-cn /
 * medicine-us / public-musique):
 *
 *   0    0.793  (0.717 / 0.966 / 0.897 / 0.845 / 0.540)
 *   0.1  0.801  (0.742 / 0.966 / 0.889 / 0.869 / 0.540)
 *   0.2  0.802  (0.742 / 0.966 / 0.890 / 0.869 / 0.540)
 *   0.3  0.800  (0.742 / 0.966 / 0.887 / 0.873 / 0.530)
 *   0.4  0.802  (0.742 / 0.966 / 0.887 / 0.873 / 0.540)
 *   0.6  0.795  (0.742 / 0.966 / 0.867 / 0.861 / 0.540)
 *   1.0  0.798  (0.755 / 0.961 / 0.867 / 0.856 / 0.550)
 *
 * The old channel gave 0.787 at 0.2 (0.717 / 0.966 / 0.890 / 0.822 / 0.540)
 * and 0.773 at 0.4. At 0.2 no pack is below that; from 0.3 on law-cn is,
 * where the statute a question names is in fifty chunks and the article it
 * asks about in one. What the channel adds is mostly medicine-us and
 * synthetic-life-zh: a question naming a trial or a person gets the chunks
 * about it lifted over chunks that only resemble it.
 */
export const FUSION_WEIGHTS: Record<SearchChannelName, number> = { vector: 1.0, keyword: 1.0, graph: 0.2 };

/**
 * Hybrid search: reciprocal-rank fusion of vector + keyword + graph-mention
 * signals (RRF, k=60 — the same shape gbrain and most hybrid retrievers use),
 * each weighted by `FUSION_WEIGHTS`. Each channel lists its best chunks of
 * sources and of generated pages, ranked together by its own score, and the
 * results give generated pages at most `GENERATED_SHARE` of the places.
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
    // the walk's own direct route is not reranked: its final order is, below
    const walked = await sagSearch(store, embedder, query, { ...opts, rerank: undefined, current: false });
    const channels: ExplainedSearch['channels'] = {};
    const results = await finish(store, query, walked, k, opts, channels);
    return { results, channels };
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
  const weights = { ...FUSION_WEIGHTS, ...opts.weights };
  const fused = new Map<string, SearchResult>();
  const generated = new Set<string>();

  const fold = (list: RankedChunk[], signal: SearchChannelName) => {
    list.forEach((r, rank) => {
      if (r.generated) generated.add(r.chunk_id);
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

  const ranked = candidates.sort((a, b) => b.score - a.score);
  const results = await finish(store, query, ranked, k, opts, channels, generated);
  if (opts.track !== false) {
    await recordChunkHits(store, results.map((r) => ({ chunkId: r.chunkId, documentId: r.documentId })), heatCfg);
  }
  return { results, channels };
}

/** The chunks among `results` that are of generated pages. */
export async function generatedAmong(store: Store, results: SearchResult[]): Promise<Set<string>> {
  if (results.length === 0) return new Set();
  const rows = await store.query<{ id: string }>(`SELECT d.id FROM documents d WHERE d.id = ANY($1::text[]) AND ${isGeneratedSql('d')}`, [[...new Set(results.map((r) => r.documentId))]]);
  const docs = new Set(rows.map((r) => r.id));
  return new Set(results.filter((r) => docs.has(r.documentId)).map((r) => r.chunkId));
}

/**
 * The first `k` of `ordered`, with chunks of generated pages in at most
 * `places` of them: a page past its places is passed over for the next
 * source, and taken after all when the sources run out before `k`.
 */
export function cutWithSources<T>(ordered: T[], k: number, places: number, isGenerated: (item: T) => boolean): T[] {
  const taken: number[] = [];
  const passed: number[] = [];
  let pages = 0;
  for (let i = 0; i < ordered.length && taken.length < k; i++) {
    if (!isGenerated(ordered[i])) taken.push(i);
    else if (pages < places) {
      taken.push(i);
      pages++;
    } else passed.push(i);
  }
  const all = [...taken, ...passed.slice(0, k - taken.length)].sort((a, b) => a - b);
  return all.map((i) => ordered[i]);
}

/**
 * The stages after fusion: the optional rerank, the cut to `k` that keeps
 * generated pages to their share, and the current state of the claims each
 * hit rests on. `generated` is the chunks of generated pages among `ranked`,
 * looked up when the caller does not know them.
 *
 * The reranker reads the candidates the cut can take: its `candidates` are
 * chosen as the cut chooses, pages in their share of them and sources for the
 * rest. Sent the fused head as it stood, it read thirty pages where pages
 * lead, and the cut then kept two of them and filled the places with sources
 * no reranker had read.
 */
async function finish(
  store: Store,
  query: string,
  ranked: SearchResult[],
  k: number,
  opts: SearchOptions,
  channels: ExplainedSearch['channels'],
  generated?: Set<string>,
): Promise<SearchResult[]> {
  const share = opts.generatedShare ?? GENERATED_SHARE;
  const places = generatedPlaces(k, share);
  const known = places >= k || ranked.length === 0 ? null : generated ?? (await generatedAmong(store, ranked).catch(() => null));
  const pages = known && known.size > 0 ? known : null;
  const isPage = (r: SearchResult) => pages!.has(r.chunkId);
  let ordered = ranked;
  if (rerankEnabled(opts.rerank)) {
    let candidates = ranked;
    if (pages) {
      const n = Math.max(1, Math.floor(opts.rerank.candidates || 30));
      const head = new Set(cutWithSources(ranked, n, generatedPlaces(n, share), isPage));
      candidates = [...ranked.filter((r) => head.has(r)), ...ranked.filter((r) => !head.has(r))];
    }
    const r = await rerankResults(opts.rerank, query, candidates);
    channels.rerank = { hits: r.sent, ms: r.ms, ...(r.error ? { error: r.error } : {}) };
    ordered = r.results;
  }
  const results = pages ? cutWithSources(ordered, k, places, isPage) : ordered.slice(0, k);
  if (opts.current === false || results.length === 0) return results;
  try {
    return await attachCurrent(store, results);
  } catch {
    // a store without the supersession column (an old schema) answers without it
    return results;
  }
}
