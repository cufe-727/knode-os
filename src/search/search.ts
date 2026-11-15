import { HeatConfig, RerankConfig, SagSearchConfig, defaultConfig } from '../config.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../store/db.js';
import { gramQuery, MATCH_INDEXES, matchIndexReady, termGrams } from '../store/grams.js';
import { NO_FILTER, ResolvedScopeFilter, documentFilterSql, isEmptyFilter } from '../store/resolver.js';
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
  /**
   * Chunks a side of the vector channel may hold and still be ranked by
   * reading its vectors, over `sideBudget`; 0 walks the index for every
   * side. For measuring, and for tests of the walk on a small index.
   */
  exactSide?: number;
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
  /** Of a generated page (`SideSql.generated`), not of a source. */
  generated?: boolean;
}

/**
 * The part of a search's results that chunks of generated pages may take:
 * a quarter, 2 of the 8 chunks an answer is written from.
 *
 * A generated page (`SideSql.generated`: an entity page, a timeline, a
 * disagreements page, a summary) restates what sources say, and a knowledge
 * base grows several chunks of them per source document. Ranked as one list
 * they take the places: on the 2026-11 separation benchmark's 10× index (8,016
 * chunks: 1,540 of source documents, 6,476 of wiki pages) the top 8 held 14%
 * source chunks, none at all for 156 of 297 questions, and the keyword
 * channel's candidates were pages before any source. The rule, in three parts:
 *
 * 1. Lists of where to look are not answers. A mentions page and a
 *    navigation list (`SideSql.listing`) are not searched at all unless the
 *    search asks for the wiki's pages (`wantsListings`): before, they took
 *    263 of the 549 places pages had in those 297 searches.
 * 2. Every recall channel lists its best chunks of sources and of generated
 *    pages separately, ranks the two lists together by its own score, and
 *    the cut gives pages this share of the places (`cutWithSources`); the
 *    reranker's candidates and a walk's routes are chosen the same way.
 * 3. A page that is the best candidate of all keeps one place where the
 *    share rounds to none (`generatedPlaces`): a search for one result
 *    returns the entity page of the name asked about, not the best source
 *    behind it. Of the 297 questions' searches for one result, 181 return a
 *    page (152 an entity page), 116 a source.
 *
 * Replayed on a copy of that index (scripts/replay-retrieval.mts: the 297
 * questions the run asked that have gold documents; questions with a gold
 * source document in the top 5 / top 8 of a search for 8), with part 1 in
 * place:
 *
 *   one list (main)         16 /  29
 *   separate lists, 1       74 /  91    sources reach the candidates, pages still take places
 *   0.5                     79 /  98
 *   0.375                   84 /  99
 *   0.25                    93 / 102
 *   0.125                   95 / 108
 *   0                       97 / 113
 *
 * A quarter reaches 102 of the 113 questions sources alone would, and keeps
 * the two best pages in an answer's context: an entity page is where the
 * claims about a name are gathered, and what an agent navigates by. Pages
 * rank where the channels put them, so the first results may be pages. A
 * search that asks for pages (`kinds: ['view']`), or finds fewer sources than
 * it has places, is filled with pages as before; an index without generated
 * pages ranks as before.
 *
 * A constant, not a setting: the share is a property of how pages restate
 * sources, measured here, not a taste a workspace has. `generatedShare` in
 * `SearchOptions` exists to measure it.
 */
export const GENERATED_SHARE = 0.25;

/**
 * How many of `k` results generated pages may take at `share`: the share of
 * `k`, rounded down — the share is the most pages get, and rounded to the
 * nearest it gave them 3 of 10 and 2 of 6 — and one at least when the best
 * candidate of all is a page (`topIsPage`): the page a question about a name
 * is answered from keeps its place in a search for one to three results,
 * where a quarter is less than a place.
 *
 * The places pages do not take go to sources however low they rank: there is
 * no floor a source must clear. A fused score is a sum of reciprocal ranks,
 * not a measure of relevance, so there is no score to draw the line at that
 * means the same thing in two corpora or two channels; and what the replay
 * shows of the last places is that they earn their keep — given all 8 places
 * instead of 6, sources hold a gold document for 113 questions instead of
 * 102 (the table above), so the seventh and eighth source answer 11
 * questions the first six do not. A source that should not be there costs a
 * place in the context; a source left out costs the answer. Where a reranker
 * is configured its score is a relevance one, and a floor could be drawn on
 * it: not done, for want of a measurement with one.
 */
export function generatedPlaces(k: number, share: number, topIsPage = false): number {
  const places = Math.floor(k * Math.min(1, Math.max(0, share)) + 1e-9);
  return Math.min(k, Math.max(0, places, topIsPage && share > 0 ? 1 : 0));
}

/**
 * How a search tells the documents of one index apart, as SQL over a
 * `documents` alias:
 *
 * `generated`  a generated page — a view of the index (`kind = 'view'`: an
 *              entity page, a mentions page, a timeline) or a navigation
 *              list the generator keeps (below). A wiki page a person or an
 *              agent wrote is a source.
 * `listing`    a generated list of where to look, not something to answer
 *              from: a mentions page (a view under wiki/mentions/: the
 *              documents that name an entity, a line each) or a navigation
 *              list.
 *
 * A navigation list is an index.md or log.md of the wiki in which the
 * generator keeps a region: `pages` holds `<file>#<region>` with a kind ending
 * in _index or _shelf, or wiki_contents. Ingest files every index.md as a
 * source the graph does not read, whoever wrote it, so the name alone does
 * not say: an index.md a person wrote, with no such region, is a source like
 * any page of theirs.
 *
 * Which it is, is asked of `pages`, without a lookup in the channels' own
 * statements (`sidesOf`, once a minute per store):
 *
 * - No index.md of the wiki is a person's (the usual case): the name decides.
 * - A few are (`AUTHORED_LISTS_INLINE` at most): their paths, in order, are
 *   named in the condition as the exceptions.
 * - More are: the condition leaves every file of that name with the sources,
 *   and `withoutLists` asks `pages` which of a search's candidates are the
 *   generator's lists, once the channels have answered. Exact however many
 *   there are, at the price of the places a list took among a channel's
 *   candidates.
 *
 * Two earlier forms, and why not. The person-written files looked up and all
 * written into every statement: the lookup took the first 500 in no order,
 * so past 500 which pages counted as lists was chance, and the statement
 * grew with them. Then a subquery on `pages` in the condition itself, by the
 * file's key or as one list of files: exact and bounded, and free on
 * PostgreSQL, but the embedded database keeps no statistics and planned a
 * join around it that took 11 to 37 s for one vector search of 8,016 chunks.
 */
export interface SideSql {
  generated(alias: string): string;
  listing(alias: string): string;
  /** The names are not decided in SQL: `withoutLists` decides them for a search's candidates. */
  listsUndecided: boolean;
}

const NAMED_AS_LIST = `~ '(^|/)(index|log)[.]md$'`;
/** SQL: the files the generator keeps a list region in, from the `<file>#<region>` rows of `pages`. */
const LIST_FILES = `SELECT split_part(kept.path, '#', 1) FROM pages kept
       WHERE kept.tx_to IS NULL AND kept.status <> 'archived' AND position('#' in kept.path) > 0
         AND (kept.kind ~ '(_index|_shelf)$' OR kept.kind = 'wiki_contents')`;
/** Person-written index.md pages a condition names at most; past it they are told from lists after recall. */
export const AUTHORED_LISTS_INLINE = 50;

/** `authored`: the wiki's index.md and log.md files that are not the generator's, in order; null when there are more than are named, or no `pages` to ask. */
function sideSql(authored: string[] | null, undecided: boolean): SideSql {
  const named = (a: string) => `${a}.root = 'wiki' AND ${a}.path ${NAMED_AS_LIST}`;
  const list = (a: string) => {
    if (undecided) return 'FALSE';
    if (!authored || authored.length === 0) return `(${named(a)})`;
    return `(${named(a)} AND NOT (${a}.path = ANY(ARRAY[${authored.map((x) => `'${x.replace(/'/g, "''")}'`).join(', ')}]::text[])))`;
  };
  return {
    generated: (a) => `(${a}.kind = 'view' OR ${list(a)})`,
    listing: (a) => `((${a}.kind = 'view' AND ${a}.path LIKE 'wiki/mentions/%') OR ${list(a)})`,
    listsUndecided: undecided,
  };
}

const sideSqls = new WeakMap<object, { sql: SideSql; at: number }>();

/**
 * The side SQL of a store. Which index.md and log.md files of its wiki a
 * person wrote — the ones the generator keeps no list region in — is asked
 * at most once a minute: the first `AUTHORED_LISTS_INLINE` + 1 by path, which
 * says whether they can be named or must be decided per search.
 */
export async function sidesOf(store: Store): Promise<SideSql> {
  const hit = sideSqls.get(store);
  if (hit && Date.now() - hit.at < 60_000) return hit.sql;
  let sql = sideSql(null, false);
  try {
    const authored = (await store.query<{ path: string }>(
      `SELECT d.path FROM documents d
       WHERE d.root = 'wiki' AND d.path ${NAMED_AS_LIST} AND d.path NOT IN (${LIST_FILES})
       ORDER BY d.path COLLATE "C" LIMIT ${AUTHORED_LISTS_INLINE + 1}`,
    )).map((r) => r.path);
    sql = authored.length > AUTHORED_LISTS_INLINE ? sideSql(null, true) : sideSql(authored, false);
  } catch {
    // a store without the pages table (an old schema): every index.md is taken for a list, as its name says
  }
  sideSqls.set(store, { sql, at: Date.now() });
  return sql;
}

/**
 * The fused candidates of a search without the generator's lists, where the
 * side SQL left the names undecided (`SideSql.listsUndecided`): the
 * candidates named index.md or log.md are looked up in `pages`, and the
 * lists among them are dropped — or, in a search that asks for the wiki's
 * pages, kept and counted as generated pages. One small statement, and only
 * when a candidate has such a name.
 */
async function withoutLists(store: Store, candidates: SearchResult[], generated: Set<string>, keep: boolean): Promise<SearchResult[]> {
  const named = candidates.filter((r) => r.path.startsWith('wiki/') && /(^|\/)(index|log)[.]md$/.test(r.path));
  if (named.length === 0) return candidates;
  const rows = await store.query<{ id: string }>(
    `SELECT d.id FROM documents d WHERE d.id = ANY($1::text[]) AND d.path IN (${LIST_FILES})`,
    [[...new Set(named.map((r) => r.documentId))]],
  );
  const lists = new Set(rows.map((r) => r.id));
  if (lists.size === 0) return candidates;
  if (!keep) return candidates.filter((r) => !lists.has(r.documentId));
  for (const r of candidates) {
    if (!lists.has(r.documentId)) continue;
    r.generated = true;
    generated.add(r.chunkId);
  }
  return candidates;
}

/** True when a search asked for the wiki's own pages: kind `view` or `wiki`, or a source prefix inside wiki/. */
export function wantsListings(filter: ResolvedScopeFilter): boolean {
  if (filter.kinds?.some((kind) => kind === 'view' || kind === 'wiki')) return true;
  return Boolean(filter.sources?.some((s) => s === 'wiki' || s.startsWith('wiki/')));
}

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

/**
 * `docLiveAt` for the recall channels of a search: as well, not a list of
 * where to look (`SideSql.listing`: a mentions page, a navigation list)
 * unless the search asks for the wiki's pages. Those are browsed, and found
 * by a search that names them, as code is. Only the three channels here use
 * it: the graph routes, the walk's expansion, context packs and excerpts go
 * through `docLiveAt` and read what they read before.
 */
function searchable(alias: string, p: Params, sides: SideSql, asOf?: TimeInput, filter: ResolvedScopeFilter = NO_FILTER): string {
  const live = docLiveAt(alias, p, asOf, filter);
  return wantsListings(filter) ? live : `${live} AND NOT ${sides.listing(alias)}`;
}

/** True when a search asked for code: kind `code`, or a source prefix inside raw/codebase. */
export function wantsCode(filter: ResolvedScopeFilter): boolean {
  if (filter.kinds?.includes('code')) return true;
  return Boolean(filter.sources?.some((s) => s === RAW_CODEBASE || s.startsWith(`${RAW_CODEBASE}/`)));
}

/** How a store's vector index can be walked, and what the catalog says of the extension. */
export interface VectorScan {
  /** The pgvector library walks its index on past the first rows (`hnsw.iterative_scan`, 0.8.0 on). */
  iterative: boolean;
  /** `pg_extension.extversion`: the version the catalog was last brought to, which may be behind the library. */
  catalog: string | null;
}

const vectorScans = new WeakMap<object, Promise<VectorScan>>();

/**
 * What the store's pgvector can do, asked once per store. The test is of the
 * library the server has loaded, not of the catalog: the setting exists when
 * the library defines it. `pg_extension.extversion` says only which version
 * `CREATE` or `ALTER EXTENSION … UPDATE` last recorded, and a server whose
 * library was upgraded without that still reports the old one — gated on the
 * catalog, it kept the one-walk behaviour with nothing said. (The cast loads
 * the library into a connection that has not used it yet; before that the
 * setting is unknown to it whatever the version.)
 */
export function vectorScan(store: Store): Promise<VectorScan> {
  let known = vectorScans.get(store);
  if (!known) {
    known = store
      .query<{ mode: string | null; catalog: string | null }>(
        `SELECT '[1]'::vector AS loaded, current_setting('hnsw.iterative_scan', true) AS mode,
                (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS catalog`,
      )
      .then(([row]) => ({ iterative: row?.mode != null, catalog: row?.catalog ?? null }))
      .catch(() => ({ iterative: false, catalog: null }));
    vectorScans.set(store, known);
  }
  return known;
}

const versionBefore = (version: string | null, major: number, minor: number) => {
  const [a, b] = (version ?? '').split('.').map(Number);
  return Number.isFinite(a) && Number.isFinite(b) && (a < major || (a === major && b < minor));
};

/**
 * One line for the log of a server that opens a workspace: which way its
 * vector searches are answered, why, and what an operator can do about it.
 * knode-os never alters the extension itself.
 */
export async function describeVectorScan(store: Store): Promise<string> {
  const scan = await vectorScan(store);
  const catalog = scan.catalog ? `pgvector ${scan.catalog} in the catalog` : 'no pgvector version in the catalog';
  if (!scan.iterative) {
    return `vector search: one walk of the index per search (${catalog}; the library on this server has no hnsw.iterative_scan, which pgvector has from 0.8.0). `
      + 'A search with a filter, or for the sources among nearer generated pages, gets what the nearest 40 rows hold. '
      + 'To change it: install pgvector 0.8.0 or later on the database server, restart it, then run ALTER EXTENSION vector UPDATE in the database.';
  }
  const behind = versionBefore(scan.catalog, 0, 8)
    ? ' The catalog is behind the library: ALTER EXTENSION vector UPDATE, run in the database by its owner, brings it in line; search does not wait for it.'
    : '';
  return `vector search: the index is walked on until each side of a search has its candidates (${catalog}; the library has hnsw.iterative_scan).${behind}`;
}

function scansIteratively(store: Store): Promise<boolean> {
  return vectorScan(store).then((scan) => scan.iterative);
}

/**
 * The rows a side of the vector channel may cost: a side with this many
 * searchable chunks at most is ranked by reading its vectors, and a larger
 * one by walking the vector index for this many rows at most.
 *
 * Walking the index for a side that holds few chunks, or none near the
 * question, reads on to the scan's limit. Measured on 200,400 chunks
 * (PostgreSQL 17, pgvector 0.8.7), a search asked for wiki pages that are
 * not views — 5,850 chunks, none of them near a question — took 231 ms at
 * the median where main, which stops at the nearest 40 rows whatever they
 * are, took 2 ms and found nothing. A walk costs about 10 µs a row of its
 * limit (pgvector's own 20,000: 200 ms; 10,000: 100 ms; 5,000: 52 ms and
 * still 24 rows there; 2,000: 2 rows) and reading a side's vectors about
 * 10 µs a chunk (5,850 chunks: 50 ms).
 *
 * Reading is the cheaper while the side is smaller than the walk would be
 * long. A side that is the fraction f of an index of N chunks, lying as near
 * the question as any other, gives up `k` rows in k / f rows walked — so it
 * is read while its size is under √(k · N), and a side whose chunks lie far
 * from the question takes a walk several times that. The budget is
 * √(8 · k · N): eight times the room a side at the boundary needs, and the
 * most either way of ranking a side reads (6,200 rows at 200,400 chunks and
 * the 24 a default search asks a channel for, about 60 ms at the worst). It
 * is held between 2,000, under which reading costs nothing worth counting,
 * and pgvector's own limit.
 */
export function sideBudget(k: number, chunks: number): number {
  return Math.min(20_000, Math.max(2000, Math.round(Math.sqrt(8 * Math.max(1, k) * Math.max(0, chunks)))));
}

interface SideSizes {
  /** Searchable chunks of sources, counted as far as the cap. */
  sources: number;
  generated: number;
}

/** The most a side is ever counted to: the ceiling of `sideBudget`. */
const SIDE_COUNT_MAX = 20_000;

const wholeSides = new WeakMap<object, SideSizes & { at: number }>();

/**
 * How many chunks each side of this search can return, counted as far as
 * `cap` + 1: what the search's own conditions leave (`searchable`), so a
 * side its filter empties, or the index holds nothing answerable of, counts
 * none. A filtered search is counted for itself, as far as its own cap (a
 * side past the cap costs 3 to 8 ms on 200,400 chunks, a small one 1 ms).
 *
 * A search without a filter counts the whole index, which is the same
 * whatever the search asks for: it is counted as far as the largest budget
 * there is and kept a minute per store, for every cap. Kept under the cap it
 * was made for, it was counted again whenever the budget changed — a search
 * for 8 and a walk's direct route for 12 have different budgets on a large
 * index, and take turns.
 */
async function sideSizes(store: Store, sides: SideSql, cap: number, asOf?: TimeInput, filter: ResolvedScopeFilter = NO_FILTER): Promise<SideSizes> {
  const whole = !toIso(asOf) && isEmptyFilter(filter);
  const hit = whole ? wholeSides.get(store) : undefined;
  if (hit && Date.now() - hit.at < 60_000) return hit;
  const p = new Params();
  const cond = searchable('d', p, sides, asOf, filter);
  const most = p.add((whole ? SIDE_COUNT_MAX : cap) + 1);
  const side = (generated: boolean) => `(SELECT count(*)::int FROM (
       SELECT 1 FROM documents d JOIN chunks c ON c.document_id = d.id
       WHERE ${cond} AND ${generated ? '' : 'NOT '}${sides.generated('d')} LIMIT ${most}) held)`;
  const [row] = await store.query<SideSizes>(`SELECT ${side(false)} AS sources, ${side(true)} AS generated`, p.list);
  const sizes = { sources: row?.sources ?? 0, generated: row?.generated ?? 0 };
  if (whole) wholeSides.set(store, { ...sizes, at: Date.now() });
  return sizes;
}

/**
 * Vector recall: cosine distance over pgvector, the nearest `k` chunks of
 * sources and the nearest `k` of generated pages, as one list by similarity.
 * A side is a branch of one statement: a large side an ordered scan with its
 * own limit, which the vector index serves, a small one (`sideBudget`) its
 * own vectors read and sorted; a window over both sides would read every
 * vector.
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
 * scans run with `hnsw.iterative_scan = relaxed_order`: the index is walked
 * on until `k` rows pass the filter (or `sideBudget` rows are read). That
 * scan may hand rows over a little out of order, so they are sorted here.
 *
 * The setting is made by the statement itself, for the statement: a CTE
 * calls `set_config(…, true)`, which lasts to the end of the transaction —
 * here the statement's own — and each branch reads the CTE in a condition
 * that holds no column, which the executor tests once, before it starts the
 * branch's scan. It was a transaction a side at first (BEGIN, SET LOCAL,
 * SELECT, COMMIT, on a pooled connection each): eight statements where main
 * sends one, on every search. tests/search-generated-pages-postgres.test.ts
 * holds that the one statement does walk on.
 */
async function vectorSearch(
  store: Store,
  embedder: EmbeddingProvider,
  query: string,
  k: number,
  queryVector: number[] | undefined,
  sides: SideSql,
  asOf?: TimeInput,
  filter?: ResolvedScopeFilter,
  exactSide?: number,
): Promise<RankedChunk[]> {
  const qv = queryVector ?? (await embedder.embed([query]))[0];
  // a search for certain kinds reads the sides they are on, and no side that holds nothing it can return
  const kinds = filter?.kinds;
  const budget = sideBudget(k, await chunkTotal(store));
  const exactMax = exactSide ?? budget;
  const held = await sideSizes(store, sides, exactMax, asOf, filter);
  const wanted = [false, true].filter((generated) => (generated
    ? held.generated > 0 && (!kinds || kinds.includes('view'))
    : held.sources > 0 && (!kinds || kinds.some((kind) => kind !== 'view'))));
  if (wanted.length === 0) return [];
  const walked = wanted.filter((generated) => (generated ? held.generated : held.sources) > exactMax);
  const iterative = walked.length > 0 && (await scansIteratively(store));

  const p = new Params([toVectorLiteral(qv)]);
  // only vectors of the query's own space: while a new model's vectors are still coming in
  // (a re-embed, or the deferred backlog) the table holds two (docs/design/12 §3.3)
  const model = p.add(embedder.model);
  const cond = searchable('d', p, sides, asOf, filter);
  const lim = p.add(k);
  const onSide = (generated: boolean) => `${generated ? '' : 'NOT '}${sides.generated('d')}`;
  // a large side: the index, walked on
  const walk = (generated: boolean) => `(SELECT c.id AS chunk_id, c.document_id, d.path, d.title, d.doc_date, c.content,
            1 - (e.embedding <=> $1::${VECTOR_TYPE}) AS raw, ${generated} AS generated
     FROM embeddings e
     JOIN chunks c ON c.id = e.chunk_id
     JOIN documents d ON d.id = c.document_id
     WHERE e.model = ${model} AND ${cond} AND ${onSide(generated)}${iterative ? ' AND (SELECT mode FROM scan) IS NOT NULL' : ''}
     ORDER BY e.embedding <=> $1::${VECTOR_TYPE}
     LIMIT ${lim})`;
  // a small side: its own vectors, read from its documents. The inner query has no order (and OFFSET 0
  // keeps it a step of its own), so the planner has no use for the vector index there
  const read = (generated: boolean) => `(SELECT c.id AS chunk_id, c.document_id, d.path, d.title, d.doc_date, c.content,
            1 - nearest.far AS raw, ${generated} AS generated
     FROM (
       SELECT held.chunk_id, held.far FROM (
         SELECT c.id AS chunk_id, e.embedding <=> $1::${VECTOR_TYPE} AS far
         FROM documents d
         JOIN chunks c ON c.document_id = d.id
         JOIN embeddings e ON e.chunk_id = c.id AND e.model = ${model}
         WHERE ${cond} AND ${onSide(generated)}
         OFFSET 0
       ) held
       ORDER BY held.far
       LIMIT ${lim}
     ) nearest
     JOIN chunks c ON c.id = nearest.chunk_id
     JOIN documents d ON d.id = c.document_id)`;
  const scan = iterative
    ? `WITH scan AS MATERIALIZED (
       SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true) AS mode, set_config('hnsw.max_scan_tuples', '${budget}', true) AS most)\n     `
    : '';
  const rows = await store.query<RankedChunk>(
    `${scan}${wanted.map((generated) => (walked.includes(generated) ? walk(generated) : read(generated))).join('\n     UNION ALL\n     ')}`,
    p.list,
  );
  const of = (generated: boolean) => rows.filter((r) => Boolean(r.generated) === generated).sort((x, y) => y.raw - x.raw);
  return mergeSides(of(false), of(true));
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
async function keywordSearch(store: Store, query: string, k: number, sides: SideSql, asOf?: TimeInput, filter?: ResolvedScopeFilter): Promise<RankedChunk[]> {
  const p = new Params([websearchText(query)]);
  const cond = searchable('d', p, sides, asOf, filter);
  const lim = p.add(k);
  // The chunks holding every word, best first. A query with a quoted phrase or an excluded word is the
  // asker's own filter and its matches lead the answer, so each side gets its best `k` of them, a branch
  // and a top-k sort each. Any other query adds them to the candidates as one list, as it always did: the
  // lists below already put forward each side's chunks, and one common word matches a third of a large
  // index — measured on 200,400 chunks (PostgreSQL 17, "进展", 25,850 matches): one list 112 ms, a branch
  // per side 189 ms (the matches are read twice), a window over the sides 126 ms with every match and
  // its text sorted on disk.
  const matching = (side: string) => `SELECT ${candidateColumns(sides)}, ts_rank(c.tsv, websearch_to_tsquery('simple', $1)) AS raw
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE c.tsv @@ websearch_to_tsquery('simple', $1) AND ${cond}${side}
       ORDER BY raw DESC
       LIMIT ${lim}`;
  const fts = hasSearchOperators(query)
    ? (await store.query<RankedChunk>(`(${matching(` AND NOT ${sides.generated('d')}`)}) UNION ALL (${matching(` AND ${sides.generated('d')}`)})`, p.list)).sort((x, y) => y.raw - x.raw)
    : await store.query<RankedChunk>(matching(''), p.list);

  const terms = keywordTerms(query);
  if (terms.length === 0) return fts;
  const size = Math.max(k * 4, 120);
  const total = await chunkTotal(store);
  const lists = matchIndexReady(store, 'chunks') && terms.every((t) => termGrams(t).length > 0) ? await termLists(store, terms, sides, asOf, filter) : null;
  const df = lists?.df ?? (await scannedFrequencies(store, terms));
  const idf = termIdf(df, total);
  const like = lists
    ? await listedCandidates(store, terms, idf, lists, size, sides, asOf, filter)
    : await scannedCandidates(store, terms, idf, rarestTerms(df), size, sides, asOf, filter);

  const seen = new Set(fts.map((r) => r.chunk_id));
  const pool = [...fts, ...like.filter((r) => !seen.has(r.chunk_id))];
  // a term no chunk holds finds nothing and weighs nothing
  const scoredTerms = terms.map((term, i) => ({ term, idf: idf[i] })).filter((t) => t.idf > 0);
  const ranked = rankBm25(pool, scoredTerms);
  if (!hasSearchOperators(query)) return bestOfEachSide(ranked, k);
  return bestOfEachSide([...fts, ...ranked.filter((r) => !seen.has(r.chunk_id))], k);
}

const candidateColumns = (sides: SideSql) => `c.id AS chunk_id, c.document_id, d.path, d.title, d.doc_date, c.content, ${sides.generated('d')} AS generated`;

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
async function termLists(store: Store, terms: string[], sides: SideSql, asOf?: TimeInput, filter?: ResolvedScopeFilter): Promise<TermLists> {
  const p = new Params();
  const expr = MATCH_INDEXES.chunks.expr('c');
  const cap = p.add(KEYWORD_DF_CAP);
  const lists = terms.map((t, i) => `(SELECT ${i} AS i, c.id, c.document_id FROM chunks c WHERE ${expr} @@ ${p.add(gramQuery([termGrams(t)], 1))}::tsquery LIMIT ${cap})`);
  const fetch = p.add(KEYWORD_FETCH_TERMS);
  const cond = searchable('d', p, sides, asOf, filter);
  const rows = await store.query<{ i: number; id: string | null; df: number | null; generated: boolean | null }>(
    `WITH hit AS MATERIALIZED (${lists.join(' UNION ALL ')}),
          n AS MATERIALIZED (SELECT i, count(*)::int AS df FROM hit GROUP BY i),
          pick AS MATERIALIZED (SELECT i FROM n ORDER BY df, i LIMIT ${fetch})
     SELECT n.i, NULL::text AS id, n.df, NULL::boolean AS generated FROM n
     UNION ALL
     SELECT h.i, h.id, NULL::int AS df, ${sides.generated('d')} AS generated
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
  sides: SideSql,
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
    const cond = searchable('d', p, sides, asOf, filter);
    const rows = await store.query<{ id: string; generated: boolean }>(
      `WITH hit AS MATERIALIZED (SELECT c.id, c.document_id FROM chunks c WHERE ${MATCH_INDEXES.chunks.expr('c')} @@ $1::tsquery LIMIT ${lim})
       SELECT h.id, ${sides.generated('d')} AS generated FROM hit h JOIN documents d ON d.id = h.document_id WHERE ${cond}`,
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
    `SELECT ${candidateColumns(sides)}, 0::float AS raw
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
 *
 * The scan keeps a chunk's id and the terms it holds, each side takes its
 * `pool` by a top-k sort of those, and only the chunks picked are read again
 * for their text.
 */
async function scannedCandidates(
  store: Store,
  terms: string[],
  idf: number[],
  picked: number[],
  pool: number,
  sides: SideSql,
  asOf?: TimeInput,
  filter?: ResolvedScopeFilter,
): Promise<RankedChunk[]> {
  if (picked.length === 0) return [];
  const weights = Array.from({ length: (1 << picked.length) - 1 }, (_, m) => pickedWeight(m + 1, picked, idf));
  const distinct = [...new Set(weights)].sort((a, b) => b - a);
  const p = new Params([weights.map((w) => distinct.indexOf(w))]);
  const mask = picked.map((i, j) => `CASE WHEN ${holdsGramsSql('x.l', terms[i], p)} THEN ${1 << j} ELSE 0 END`).join(' + ');
  const cond = searchable('d', p, sides, asOf, filter);
  const lim = p.add(pool);
  // lower() once per chunk, then strpos per gram
  return store.query<RankedChunk>(
    `WITH held AS MATERIALIZED (
       SELECT chunk_id, mask, generated FROM (
         SELECT c.id AS chunk_id, ${sides.generated('d')} AS generated, ${mask} AS mask
         FROM chunks c JOIN documents d ON d.id = c.document_id, LATERAL (SELECT lower(c.content) AS l OFFSET 0) x
         WHERE ${cond}
         OFFSET 0
       ) scanned
       WHERE mask > 0
     ), picked AS (
       (SELECT chunk_id FROM held WHERE NOT generated ORDER BY ($1::int[])[mask], chunk_id COLLATE "C" LIMIT ${lim})
       UNION ALL
       (SELECT chunk_id FROM held WHERE generated ORDER BY ($1::int[])[mask], chunk_id COLLATE "C" LIMIT ${lim})
     )
     SELECT ${candidateColumns(sides)}, 0::float AS raw
     FROM picked JOIN chunks c ON c.id = picked.chunk_id JOIN documents d ON d.id = c.document_id`,
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
async function graphSignal(store: Store, query: string, k: number, sides: SideSql, asOf?: TimeInput, filter?: ResolvedScopeFilter): Promise<RankedChunk[]> {
  let seeds = await namedInQuery(store, query, asOf);
  if (seeds.length === 0) seeds = await entitiesHoldingTerms(store, query, asOf);
  if (seeds.length === 0) return [];
  const p = new Params([seeds]);
  const cond = searchable('d', p, sides, asOf, filter);
  const total = p.add(await chunkTotal(store));
  const lim = p.add(k);
  return store.query<RankedChunk>(
    `WITH seeds AS MATERIALIZED (
       SELECT DISTINCT unnest($1::text[]) AS id
     ), docs AS MATERIALIZED (
       SELECT d.id, ${sides.generated('d')} AS generated FROM documents d WHERE ${cond}
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
     ), live AS MATERIALIZED (
       SELECT pc.chunk_id, pc.matches, pc.weight, docs.generated
       FROM per_chunk pc JOIN docs ON docs.id = pc.document_id
     ), ranked AS (
       (SELECT * FROM live WHERE NOT generated ORDER BY weight DESC, matches DESC, chunk_id LIMIT ${lim})
       UNION ALL
       (SELECT * FROM live WHERE generated ORDER BY weight DESC, matches DESC, chunk_id LIMIT ${lim})
     )
     SELECT c.id AS chunk_id, c.document_id, d.path, d.title, d.doc_date, c.content, r.weight AS raw, r.generated
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
    // a walk's results say which of them are pages (the direct route's hits and the expansion's rows both do)
    const results = await finish(store, query, walked, k, opts, channels, new Set(walked.filter((r) => r.generated).map((r) => r.chunkId)));
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
  const sides = await sidesOf(store);
  const vectorRecall = () => vectorSearch(store, embedder, query, fetchK, opts.queryVector, sides, opts.asOf, opts.filter, opts.exactSide);
  const [vec, kw, gr] = await Promise.all([
    mode === 'hybrid' || mode === 'vector' ? timed('vector', vectorRecall, mode === 'hybrid') : Promise.resolve([]),
    mode !== 'vector' ? timed('keyword', () => keywordSearch(store, query, fetchK, sides, opts.asOf, opts.filter)) : Promise.resolve([]),
    mode === 'hybrid' ? timed('graph', () => graphSignal(store, query, fetchK, sides, opts.asOf, opts.filter)) : Promise.resolve([]),
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
          ...(r.generated ? { generated: true as const } : {}),
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
  const candidates = sides.listsUndecided
    ? await withoutLists(store, [...fused.values()], generated, wantsListings(opts.filter ?? NO_FILTER))
    : [...fused.values()];
  await boostByHeat(store, candidates, heatCfg);

  const ranked = candidates.sort((a, b) => b.score - a.score);
  const results = await finish(store, query, ranked, k, opts, channels, generated);
  if (opts.track !== false) {
    await recordChunkHits(store, results.map((r) => ({ chunkId: r.chunkId, documentId: r.documentId })), heatCfg);
  }
  return { results, channels };
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
 * hit rests on. `generated` is the chunks of generated pages among `ranked`.
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
  generated: Set<string>,
): Promise<SearchResult[]> {
  const share = opts.generatedShare ?? GENERATED_SHARE;
  const pages = generatedPlaces(k, share) < k && generated.size > 0 ? generated : null;
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
  const results = pages ? cutWithSources(ordered, k, generatedPlaces(k, share, isPage(ordered[0])), isPage) : ordered.slice(0, k);
  if (opts.current === false || results.length === 0) return results;
  try {
    return await attachCurrent(store, results);
  } catch {
    // a store without the supersession column (an old schema) answers without it
    return results;
  }
}
