import { HeatConfig, SagSearchConfig, defaultConfig } from '../config.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../store/db.js';
import { gramQuery, MATCH_INDEXES, matchIndexReady, termGrams } from '../store/grams.js';
import { NO_FILTER, ResolvedScopeFilter, documentFilterSql } from '../store/resolver.js';
import { RAW_CODEBASE } from '../fs/layout.js';
import { Params, TimeInput, rowLiveAt, toIso, toDateString } from '../store/temporal.js';
import { EmbeddingProvider } from '../ingest/embeddings.js';
import { boostByHeat, recordChunkHits } from '../stats/heat.js';
import { SearchResult } from '../types.js';
import { longestSpans, spellingSpans, weakSpelling } from '../graph/normalize.js';

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
 * Keyword recall: BM25 over the chunks that hold the query's terms.
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
 * search matched in front, in its order. Until the gram index is ready, one
 * scan finds the candidates and the terms are weighted by how rare they are
 * among those.
 */
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

  const terms = keywordTerms(query);
  if (terms.length === 0) return fts;
  const size = Math.max(k * 4, 120);
  let weighted: { term: string; idf: number | null }[];
  let like: RankedChunk[];
  if (matchIndexReady(store, 'chunks') && terms.every((t) => termGrams(t).length > 0)) {
    const total = await chunkTotal(store);
    const lists = await termLists(store, terms, asOf, filter);
    // a term no chunk holds finds nothing and weighs nothing
    weighted = terms.map((term, i) => ({ term, idf: lists.df[i] > 0 ? idfOf(lists.df[i] >= KEYWORD_DF_CAP ? Math.max(KEYWORD_DF_CAP, Math.round(Math.sqrt(KEYWORD_DF_CAP * Math.max(total, KEYWORD_DF_CAP)))) : lists.df[i], total) : 0 }));
    like = await listedCandidates(store, terms, weighted.map((t) => t.idf ?? 0), lists, size, asOf, filter);
    weighted = weighted.filter((t) => t.idf !== 0);
  } else {
    weighted = terms.map((term) => ({ term, idf: null }));
    like = await scannedCandidates(store, terms.slice(0, KEYWORD_FETCH_TERMS), size, asOf, filter);
  }

  const seen = new Set(fts.map((r) => r.chunk_id));
  const pool = [...fts, ...like.filter((r) => !seen.has(r.chunk_id))];
  // uncounted terms take their weight from the candidates themselves: rare among them, rare enough
  const lowered = weighted.some((t) => t.idf === null) ? pool.map((r) => r.content.toLowerCase()) : [];
  const scoredTerms = weighted.map((t) => ({
    term: t.term,
    idf: t.idf ?? idfOf(lowered.filter((text) => termCount(text, t.term) > 0).length, pool.length),
  }));
  const ranked = rankBm25(pool, scoredTerms);
  if (!hasSearchOperators(query)) return ranked.slice(0, k);
  return [...fts, ...ranked.filter((r) => !seen.has(r.chunk_id))].slice(0, k);
}

const CANDIDATE_COLUMNS = `c.id AS chunk_id, c.document_id, d.path, d.title, d.doc_date, c.content`;

interface TermLists {
  /** Chunks holding each term, counted up to `KEYWORD_DF_CAP`. */
  df: number[];
  /** The live chunks of the `KEYWORD_FETCH_TERMS` rarest terms: term index, chunk id. */
  listed: { i: number; id: string }[];
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
  const rows = await store.query<{ i: number; id: string | null; df: number | null }>(
    `WITH hit AS MATERIALIZED (${lists.join(' UNION ALL ')}),
          n AS MATERIALIZED (SELECT i, count(*)::int AS df FROM hit GROUP BY i),
          pick AS MATERIALIZED (SELECT i FROM n ORDER BY df, i LIMIT ${fetch})
     SELECT n.i, NULL::text AS id, n.df FROM n
     UNION ALL
     SELECT h.i, h.id, NULL::int AS df
     FROM hit h JOIN pick ON pick.i = h.i JOIN documents d ON d.id = h.document_id
     WHERE ${cond}`,
    p.list,
  );
  const df = terms.map(() => 0);
  const listed: { i: number; id: string }[] = [];
  for (const r of rows) {
    if (r.id === null) df[r.i] = r.df ?? 0;
    else listed.push({ i: r.i, id: r.id });
  }
  const picked = df.map((n, i) => ({ n, i })).filter((x) => x.n > 0).sort((a, b) => a.n - b.n || a.i - b.i).slice(0, KEYWORD_FETCH_TERMS).map((x) => x.i);
  return { df, listed, picked };
}

/**
 * About `pool` chunks worth scoring: the ones the listed terms weigh the most
 * in together. A chunk is put forward by the summed weight of the terms whose
 * lists hold it — BM25 with every count taken as one, which is what an
 * inverted index can say before any text is read — and the text of the best
 * `pool` is fetched for the caller to score exactly.
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
  const weight = new Map<string, number>();
  for (const r of lists.listed) weight.set(r.id, (weight.get(r.id) ?? 0) + idf[r.i]);
  if (lists.picked.length > 1 && lists.picked.some((i) => lists.df[i] >= KEYWORD_DF_CAP)) {
    const p = new Params([gramQuery(lists.picked.map((i) => termGrams(terms[i])), lists.picked.length)]);
    const lim = p.add(pool);
    const cond = docLiveAt('d', p, asOf, filter);
    const all = lists.picked.reduce((sum, i) => sum + idf[i], 0);
    const rows = await store.query<{ id: string }>(
      `WITH hit AS MATERIALIZED (SELECT c.id, c.document_id FROM chunks c WHERE ${MATCH_INDEXES.chunks.expr('c')} @@ $1::tsquery LIMIT ${lim})
       SELECT h.id FROM hit h JOIN documents d ON d.id = h.document_id WHERE ${cond}`,
      p.list,
    );
    for (const r of rows) weight.set(r.id, all);
  }
  const ids = [...weight.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, pool).map(([id]) => id);
  if (ids.length === 0) return [];
  return store.query<RankedChunk>(
    `SELECT ${CANDIDATE_COLUMNS}, 0::float AS raw
     FROM chunks c JOIN documents d ON d.id = c.document_id
     WHERE c.id = ANY($1::text[])`,
    [ids],
  );
}

/** The `pool` chunks holding the most of `terms` as substrings, by one scan: what answers while the gram index is being built. */
async function scannedCandidates(store: Store, terms: string[], pool: number, asOf?: TimeInput, filter?: ResolvedScopeFilter): Promise<RankedChunk[]> {
  const p = new Params([terms.map((t) => t.toLowerCase())]);
  // lower() once per chunk, then one strpos per term
  const hits = `(SELECT count(*) FROM (SELECT lower(c.content) AS l OFFSET 0) x, unnest($1::text[]) t WHERE strpos(x.l, t) > 0)`;
  const cond = docLiveAt('d', p, asOf, filter);
  const lim = p.add(pool);
  return store.query<RankedChunk>(
    `SELECT * FROM (
       SELECT ${CANDIDATE_COLUMNS}, ${hits}::float AS raw
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
 * Chunks mentioning the entities the query names (graph signal): one row per
 * chunk, ranked by the summed rarity of the named entities it mentions — each
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
 * own hits) that put 0.29 in the top five; naming plus rarity puts 0.51
 * there (public-musique 0.21 → 0.40, research-ai 0.44 → 0.74, medicine-us
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
       SELECT d.id FROM documents d WHERE ${cond}
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
       SELECT pc.chunk_id, pc.matches, pc.weight
       FROM per_chunk pc JOIN docs ON docs.id = pc.document_id
       ORDER BY pc.weight DESC, pc.matches DESC, pc.chunk_id
       LIMIT ${lim}
     )
     SELECT c.id AS chunk_id, c.document_id, d.path, d.title, d.doc_date, c.content, r.weight AS raw
     FROM ranked r
     JOIN chunks c ON c.id = r.chunk_id
     JOIN documents d ON d.id = c.document_id
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
 * alone 0.79, keywords alone 0.75, the graph channel alone 0.51 (0.29 when it
 * matched entities by fragments of the query's terms). Hybrid recall by graph
 * weight, mean over the packs (synthetic-life-zh / research-ai / law-cn /
 * medicine-us / public-musique):
 *
 *   0    0.793  (0.717 / 0.966 / 0.897 / 0.845 / 0.540)
 *   0.2  0.802  (0.742 / 0.966 / 0.890 / 0.869 / 0.540)
 *   0.4  0.802  (0.742 / 0.966 / 0.887 / 0.873 / 0.540)
 *
 * and with names alone (no term fallback) 0.801 at 0.3, 0.797 at 0.6, 0.795
 * at 1.0, law-cn falling to 0.867. The old channel gave 0.787 at 0.2 and
 * 0.775 at 0.4. At 0.2 no pack is below the old channel's hybrid recall; at
 * 0.4 law-cn is, where the statute a question names is in fifty chunks and
 * the article it asks about in one. What the channel adds is mostly
 * medicine-us and synthetic-life-zh: a question naming a trial or a person
 * gets the chunks about it lifted over chunks that only resemble it.
 */
export const FUSION_WEIGHTS: Record<SearchChannelName, number> = { vector: 1.0, keyword: 1.0, graph: 0.2 };

/**
 * Hybrid search: reciprocal-rank fusion of vector + keyword + graph-mention
 * signals (RRF, k=60 — the same shape gbrain and most hybrid retrievers use),
 * each weighted by `FUSION_WEIGHTS`.
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
  const weights = { ...FUSION_WEIGHTS, ...opts.weights };
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
