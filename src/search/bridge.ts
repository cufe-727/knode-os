import { Store } from '../store/db.js';
import { ResolvedScopeFilter } from '../store/resolver.js';
import { TimeInput } from '../store/temporal.js';
import { CJK_QUERY_STOP, LATIN_QUERY_STOP, RankedChunk, chunksForTerms, keywordTerms, termCount, termStats } from './search.js';

/**
 * Bridge terms: the second way a SAG walk leaves its seed passages.
 *
 * The walk of sag.ts crosses from a passage to another through an entity both
 * mention, so it can only follow links extraction made. A chain whose next
 * passage shares a name, a code or a rare word with the seed, and no
 * extracted entity, stops there (docs/design/30 §3: six of the eight chains
 * the relation walk still missed lacked a link in the index). SAG2
 * (arXiv:2610.22588) crosses on the words themselves: the terms of the best
 * passages that are rare in the corpus and stand in a sentence with the
 * question's own words are searched for, and what they find joins the
 * candidates. No model reads anything, and nothing is built at index time.
 *
 * What is taken from SAG2 and what is not. The term score is theirs:
 * `(1 + ln tf) · idf · (1 + context) · weight`, with `context` the summed
 * weight of the question's terms in the term's best sentence. Their loop
 * scores every passage with a hosted model between rounds; here there is one
 * round from the direct route's seeds, and the walk's vector ranking of its
 * candidates stands where that model does.
 */

export interface BridgeSeed {
  chunkId: string;
  content: string;
  /** The seed's score over the best seed's, in (0, 1]. */
  weight: number;
}

export interface SeedTerm {
  /** Lowercased, as it is searched for. */
  term: string;
  /** As the seed spells it. */
  shown: string;
  /** Sentences of the seeds that hold it. */
  tf: number;
  /** The best weight among the seeds that hold it. */
  weight: number;
  /** For each kind of sentence it stands in, which of the question's terms the sentence holds (bit i for term i). */
  contexts: number[];
}

export interface BridgeTerm {
  term: string;
  shown: string;
  score: number;
  idf: number;
}

export interface BridgeCandidate {
  row: RankedChunk;
  /** The bridge terms it was listed under, as the seeds spell them. */
  terms: string[];
}

/** Terms of the seeds weighed in the corpus at most: each costs an index lookup. */
const SEED_TERMS_MAX = 60;
/** A name of several capitalized words, with the small words names hold between them. */
const NAME_PHRASE = /[A-Z][a-zA-Z0-9_$-]*(?: (?:(?:of|the|de|la|van|von|der|del|di|da|and) )*[A-Z][a-zA-Z0-9_$-]*)+/g;
const NAME_WORDS_MAX = 5;
const HAN_RUN = /[一-鿿㐀-䶿]{2,}/g;
/** Longest run of characters the segmenter cut one by one that is kept as one term: a name it does not know. */
const UNKNOWN_RUN_MAX = 6;
const SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' });

function sentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;])\s*|(?<=\.)\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

/** The words of a CJK run: the segmenter's, with the characters it cut one by one kept together as one term. */
function hanWords(run: string): string[] {
  const out: string[] = [];
  let singles = '';
  const flush = () => {
    if (singles.length >= 2 && singles.length <= UNKNOWN_RUN_MAX) out.push(singles);
    singles = '';
  };
  for (const { segment } of SEGMENTER.segment(run)) {
    if (segment.length === 1) {
      singles += segment;
      continue;
    }
    flush();
    out.push(segment);
  }
  flush();
  if (run.length <= 4) out.push(run);
  return out.filter((w) => !CJK_QUERY_STOP.has(w));
}

/** The terms of one sentence, each spelling once: names of several words, words, codes, and CJK words. */
export function sentenceTerms(sentence: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (t: string) => {
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  for (const m of sentence.matchAll(NAME_PHRASE)) {
    const words = m[0].split(' ');
    while (words.length > 0 && LATIN_QUERY_STOP.has(words[0].toLowerCase())) words.shift();
    if (words.length >= 2 && words.length <= NAME_WORDS_MAX) push(words.join(' '));
  }
  for (const m of sentence.matchAll(/[a-zA-Z0-9_.$-]{2,}/g)) {
    const t = m[0].replace(/^[._$-]+|[._$-]+$/g, '');
    if (t.length < 2 || /^[\d.,_-]+$/.test(t)) continue;
    if (LATIN_QUERY_STOP.has(t.toLowerCase())) continue;
    // a short lowercase word says little; a short code or acronym (R-7, AWS) is a name
    if (t.length < 3 && !/[A-Z0-9]/.test(t)) continue;
    push(t);
  }
  for (const run of sentence.matchAll(HAN_RUN)) for (const w of hanWords(run[0])) push(w);
  return out;
}

const bits = (mask: number) => {
  let n = 0;
  for (let m = mask; m; m &= m - 1) n++;
  return n;
};

/**
 * The terms of the seed passages that could lead on: every term of every
 * sentence except those the question already holds (it is searched for
 * anyway), with how many sentences hold each and which of the question's
 * terms stand beside it. The `max` most promising before the corpus is asked
 * are returned: by sentences, by the question's terms beside them, and by
 * their seed's weight.
 */
export function seedTerms(query: string, seeds: BridgeSeed[], max = SEED_TERMS_MAX): SeedTerm[] {
  const queryLower = query.toLowerCase();
  const queryTerms = keywordTerms(query);
  const queryWords = new Set(queryTerms);
  const ofQuery = (term: string) => termCount(queryLower, term) > 0 || term.split(' ').every((w) => queryWords.has(w));
  const found = new Map<string, { shown: string; tf: number; weight: number; contexts: Set<number> }>();
  for (const seed of seeds) {
    for (const sentence of sentences(seed.content)) {
      const lower = sentence.toLowerCase();
      let mask = 0;
      queryTerms.forEach((q, i) => {
        if (i < 30 && termCount(lower, q) > 0) mask |= 1 << i;
      });
      for (const shown of sentenceTerms(sentence)) {
        const term = shown.toLowerCase();
        if (ofQuery(term)) continue;
        const e = found.get(term) ?? found.set(term, { shown, tf: 0, weight: 0, contexts: new Set() }).get(term)!;
        e.tf++;
        e.weight = Math.max(e.weight, seed.weight);
        e.contexts.add(mask);
      }
    }
  }
  const promise = (e: { tf: number; weight: number; contexts: Set<number> }) =>
    (1 + Math.log(e.tf)) * (1 + Math.max(...[...e.contexts].map(bits))) * (0.5 + 0.5 * e.weight);
  return [...found.entries()]
    .map(([term, e]) => ({ term, shown: e.shown, tf: e.tf, weight: e.weight, contexts: [...e.contexts], promise: promise(e) }))
    .sort((a, b) => b.promise - a.promise || (a.term < b.term ? -1 : 1))
    .slice(0, max)
    .map(({ promise: _promise, ...t }) => t);
}

/**
 * The `limit` best bridge terms. A term scores by how often the seeds use it,
 * how rare it is in the corpus (`idf`, with `df` the chunks that hold it),
 * the weight of the question's terms in its best sentence (`queryIdf`), and
 * its seed's weight. A term only its seed holds leads nowhere and is left out.
 */
export function scoreBridgeTerms(terms: SeedTerm[], stats: { df: number[]; idf: number[] }, queryIdf: number[], limit: number): BridgeTerm[] {
  const context = (mask: number) => queryIdf.reduce((sum, w, i) => (mask & (1 << i) ? sum + w : sum), 0);
  return terms
    .map((t, i) => ({ t, df: stats.df[i] ?? 0, idf: stats.idf[i] ?? 0 }))
    .filter((x) => x.df > 1 && x.idf > 0)
    .map(({ t, idf }) => ({
      term: t.term,
      shown: t.shown,
      idf,
      score: (1 + Math.log(t.tf)) * idf * (1 + Math.max(0, ...t.contexts.map(context))) * (0.5 + 0.5 * t.weight),
    }))
    .sort((a, b) => b.score - a.score || (a.term < b.term ? -1 : 1))
    .slice(0, Math.max(0, limit));
}

/**
 * What the bridge terms of `seeds` find: at most `pool` chunks of sources
 * outside `exclude`, each term's best in turn (the best chunk of the best
 * term, of the second, …, then their second-best), a chunk's place in that
 * order being its rank on this route. A term's chunks are ordered by BM25
 * over the question's terms and the bridge terms together, as SAG2 searches
 * `(terms OR question) AND term`.
 */
export async function lexicalBridge(
  store: Store,
  query: string,
  seeds: BridgeSeed[],
  exclude: Set<string>,
  opts: { terms: number; pool: number; asOf?: TimeInput; filter?: ResolvedScopeFilter },
): Promise<{ terms: BridgeTerm[]; candidates: BridgeCandidate[] }> {
  const none = { terms: [], candidates: [] };
  if (opts.terms <= 0 || opts.pool <= 0 || seeds.length === 0) return none;
  const found = seedTerms(query, seeds);
  if (found.length === 0) return none;
  const queryTerms = keywordTerms(query);
  const stats = await termStats(store, [...found.map((t) => t.term), ...queryTerms]);
  const queryIdf = stats.idf.slice(found.length);
  const chosen = scoreBridgeTerms(found, { df: stats.df.slice(0, found.length), idf: stats.idf.slice(0, found.length) }, queryIdf, opts.terms);
  if (chosen.length === 0) return none;

  const perTerm = Math.max(2, Math.ceil(opts.pool / chosen.length));
  const rows = await chunksForTerms(
    store,
    [...chosen.map((t) => t.term), ...queryTerms],
    [...chosen.map((t) => t.idf), ...queryIdf],
    chosen.length,
    { exclude: [...exclude], perTerm, asOf: opts.asOf, filter: opts.filter },
  );
  // the index lists a superset of a term's chunks (its grams), so the text decides
  const lower = new Map(rows.map((r) => [r.chunk_id, r.content.toLowerCase()]));
  const lists = chosen.map((t) => rows.filter((r) => termCount(lower.get(r.chunk_id)!, t.term) > 0).slice(0, perTerm));
  const byChunk = new Map<string, BridgeCandidate>();
  for (let depth = 0; depth < perTerm; depth++) {
    lists.forEach((list, i) => {
      const row = list[depth];
      if (!row) return;
      const held = byChunk.get(row.chunk_id);
      if (held) held.terms.push(chosen[i].shown);
      else if (byChunk.size < opts.pool) byChunk.set(row.chunk_id, { row, terms: [chosen[i].shown] });
    });
  }
  return { terms: chosen, candidates: [...byChunk.values()] };
}
