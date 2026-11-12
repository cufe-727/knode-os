import { gramQuery, MATCH_INDEXES, matchIndexReady, termGrams } from '../store/grams.js';
import { Store } from '../store/db.js';
import { Params, toDateString } from '../store/temporal.js';
import { SearchResult } from '../types.js';
import { docLiveAt, keywordTerms, termCount } from './search.js';

/**
 * Excerpts: for a question that asks for every case, the lines of further
 * documents that name what it asks about.
 *
 * A list question ("which papers use Gemini", "哪些条文提到了“注册资本”",
 * "what do these documents say about OpenAI") is answered by a passage in
 * each of many documents. The search returns the dozen chunks that match it
 * best, and the claims reach more documents, but on the benchmark's
 * corpus-level questions most of the evidence missing from ask's prompt was in
 * neither: a paper that cites "OpenAI (2025)" in passing gets no claim about
 * OpenAI, and a claim restating a statute's article leaves out the article's
 * number and often the very term asked about. What an agent with grep does is
 * read the lines that hold the name. This does that once, bounded: the chunks
 * holding the named entities' names, or the question's quoted term, found
 * through the chunk gram index; each cut to the paragraphs that hold it (a
 * list item with the line that introduces it); documents taking turns; at
 * most `EXCERPT_CHARS` in all.
 */

/**
 * Characters of excerpts given at most: about 40% of what the chunks and facts
 * already take. On the benchmark's corpus-level questions 2,000 / 4,000 /
 * 6,000 / 8,000 characters reached 0.58 / 0.71 / 0.75 / 0.79 of research-ai's
 * evidence (before the rarest-word fallback) while law-cn's was flat past
 * 4,000; most questions do not fill it, so a prompt grew by 1,400–4,400
 * characters on average.
 */
export const EXCERPT_CHARS = 6000;
/** A paragraph longer than this is cut to the part around its first hit. */
const WINDOW_MAX = 360;
const WINDOW_BEFORE = 140;
/** Chunks holding an anchor read at most: a name in every document is not narrowed by reading more of them. */
const SCAN_CAP = 400;

/**
 * Whether a question asks for every case rather than one answer: list, which-
 * plural, every/all, how many, what the documents say about, disagreements,
 * timelines.
 * A false positive costs only the excerpts' characters; a miss leaves the
 * question with what any other question gets.
 */
export function isListQuestion(question: string): boolean {
  const q = question.toLowerCase();
  if (/哪些|列出|列举|全部|所有|逐条|都说了|有何异同|互相矛盾|说法.{0,4}矛盾|时间线|从早到晚|从晚到早|[一总]?共有?(几|多少)[条篇份个项次]/.test(question)) return true;
  if (/\bhow many (papers|documents|articles|studies|sources|reports|files|notes)\b/.test(q)) return true;
  if (/\b(list|enumerate)\b|\bevery\b|\ball (the |of the )?\w+s\b|\beach (paper|document|study|source|article)\b/.test(q)) return true;
  if (/\bwhat do (these|the|all) (documents|papers|sources|materials|notes|reports)\b/.test(q)) return true;
  if (/\b(disagree|contradict|conflict)/.test(q) || /\btimeline\b|\bhistory of\b/.test(q)) return true;
  // "which papers …", "which two models …": a plural after which
  return /\bwhich\s+(?:\w+\s+)?(?!is\b|was\b|has\b|does\b|this\b)\w{3,}s\b/.test(q);
}

/** The terms a question quotes: “注册资本”, "GitHub", 「仲裁」. Book-title marks name a work, which entity linking finds. */
export function quotedTerms(question: string): string[] {
  const out = new Set<string>();
  for (const m of question.matchAll(/[“"「『]([^”"」』]{2,40})[”"」』]/g)) out.add(m[1].trim());
  return [...out].filter(Boolean);
}

interface Hit {
  chunk_id: string;
  document_id: string;
  seq: number;
  path: string;
  title: string | null;
  doc_date: string | Date | null;
  content: string;
}

const LIST_ITEM = /^\s*(?:[-*+•]\s|\d{1,3}[.)、]\s?|[（(][一二三四五六七八九十百\d]{1,4}[)）]|[一二三四五六七八九十]{1,3}、|[a-z][.)]\s)/;

/** A paragraph opening a numbered unit of a statute, contract or standard: 第二十五条, Article 12, § 4. */
const UNIT_OPENER = /^\s*(?:第[一二三四五六七八九十百千零〇两\d]+条|article\s+\d+|art\.\s*\d+|§\s*\d+|section\s+\d+)/i;
/** What of an opening line is kept before the paragraph it leads to: its number and first words. */
const OPENER_MAX = 60;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * The parts of `content` that hold one of `anchors` (lowercased): each
 * paragraph holding one, a long one cut around its first hit, behind what it
 * cannot be read without — a list item behind the line that introduces its
 * list, and a paragraph inside a numbered unit (第二十五条, Article 12) behind
 * the line that opens the unit, which carries its number. "Which articles
 * mention 注册资本" is answered by article numbers, and the term is as often
 * in an article's second paragraph or third item as in its first line: on
 * law-cn's corpus-level questions, 138 evidence articles were excerpted
 * without the line that names them before this.
 */
export function excerptOf(content: string, anchors: string[], windowMax = WINDOW_MAX, carried?: string | null): string[] {
  const paras = content.split(/\n+/).map((p) => p.trim());
  const windows: string[] = [];
  const used = new Set<number>();
  let carry = carried ?? null;
  for (let i = 0; i < paras.length; i++) {
    if (used.has(i)) continue;
    const lower = paras[i].toLowerCase();
    const at = Math.min(...anchors.map((a) => (termCount(lower, a) > 0 ? lower.indexOf(a) : Infinity)));
    if (!Number.isFinite(at)) continue;
    let text = paras[i];
    const lead: string[] = [];
    if (text.length > windowMax) {
      const before = Math.round(windowMax * (WINDOW_BEFORE / WINDOW_MAX));
      let from = Math.max(0, at - before);
      // an opening line cut away from its number would not say which article it is
      if (UNIT_OPENER.test(text)) {
        if (from <= OPENER_MAX) from = 0;
        else lead.push(clip(text, OPENER_MAX));
      }
      text = `${from > 0 ? '…' : ''}${text.slice(from, from + windowMax)}${from + windowMax < text.length ? '…' : ''}`;
    }
    let head = i;
    if (LIST_ITEM.test(paras[i])) {
      let stem = i - 1;
      while (stem >= 0 && LIST_ITEM.test(paras[stem])) stem--;
      if (stem >= 0) {
        if (!used.has(stem)) lead.push(clip(paras[stem], windowMax));
        used.add(stem);
        head = stem;
      }
    }
    if (!UNIT_OPENER.test(paras[head])) {
      let opener = head - 1;
      while (opener >= 0 && !UNIT_OPENER.test(paras[opener])) opener--;
      if (opener >= 0 && !used.has(opener)) {
        lead.unshift(clip(paras[opener], OPENER_MAX));
        used.add(opener);
      } else if (opener < 0 && carry) {
        // the unit began in the chunk before this one
        lead.unshift(clip(carry, OPENER_MAX));
        carry = null;
      }
    }
    windows.push([...lead, text].join(' … '));
    used.add(i);
  }
  return windows;
}

/** The opening line of the last numbered unit `content` starts, which a following chunk continues. */
export function lastOpener(content: string): string | null {
  const paras = content.split(/\n+/).map((p) => p.trim());
  for (let i = paras.length - 1; i >= 0; i--) if (UNIT_OPENER.test(paras[i])) return paras[i];
  return null;
}

/** Whether a hit in `content` comes before any unit opens in it: its unit, if any, began in the chunk before. */
function hitBeforeOpener(content: string, anchors: string[]): boolean {
  for (const para of content.split(/\n+/)) {
    if (UNIT_OPENER.test(para)) return false;
    const lower = para.toLowerCase();
    if (anchors.some((a) => termCount(lower, a) > 0)) return true;
  }
  return false;
}

/**
 * Words that frame a list question rather than say what it is about: the
 * fallback anchor of a question naming nothing is its rarest word, and in a
 * corpus of papers "distinct" or "mention" can be rarer than the subject.
 */
const FRAME_WORDS = new Set([
  'which', 'what', 'list', 'every', 'each', 'all', 'any', 'distinct', 'fact', 'facts', 'say', 'says', 'said', 'mention', 'mentions', 'mentioned',
  'document', 'documents', 'paper', 'papers', 'article', 'articles', 'source', 'sources', 'study', 'studies', 'report', 'reports', 'note', 'notes',
  'these', 'those', 'their', 'there', 'make', 'makes', 'use', 'uses', 'using', 'used', 'evaluate', 'evaluates', 'propose', 'proposes', 'study',
  'available', 'many', 'how', 'disagree', 'disagreement', 'side', 'where', 'about', 'with', 'from', 'that', 'this', 'other', 'others',
]);
/** Chunks a fallback anchor may be in: a word in more says nothing about what the question is about. */
const FALLBACK_DF_MAX = 1000;
/** The fallback anchors together should find this many chunks before the next rarest word is added. */
const FALLBACK_DF_MIN = 20;

/**
 * The anchors of a list question that names no entity and quotes nothing
 * ("which papers make their code available on GitHub" in a workspace with no
 * GitHub entity): its rarest words that the chunks hold, as an agent would
 * grep for the distinctive word, one or two of them.
 */
async function rarestTerms(store: Store, question: string): Promise<string[]> {
  const terms = keywordTerms(question).filter((t) => !FRAME_WORDS.has(t) && (/[一-鿿]/.test(t) || t.length >= 3) && termGrams(t).length > 0);
  if (terms.length === 0) return [];
  const p = new Params();
  const indexed = matchIndexReady(store, 'chunks');
  const cap = p.add(FALLBACK_DF_MAX);
  const counts = terms.map((t, i) => {
    const where = indexed ? `${MATCH_INDEXES.chunks.expr('c')} @@ ${p.add(gramQuery([termGrams(t)], 1))}::tsquery` : `strpos(lower(c.content), ${p.add(t)}) > 0`;
    return `SELECT ${i} AS i, (SELECT count(*)::int FROM (SELECT 1 FROM chunks c WHERE ${where} LIMIT ${cap}) x) AS df`;
  });
  const rows = await store.query<{ i: number; df: number }>(counts.join(' UNION ALL '), p.list);
  const ranked = rows.filter((r) => r.df > 0 && r.df < FALLBACK_DF_MAX).sort((a, b) => a.df - b.df || a.i - b.i);
  const out: string[] = [];
  let found = 0;
  for (const r of ranked) {
    if (out.length >= 2 || found >= FALLBACK_DF_MIN) break;
    out.push(terms[r.i]);
    found += r.df;
  }
  return out;
}

export interface ExcerptOptions {
  /** Characters of excerpt text at most (default `EXCERPT_CHARS`). */
  budget?: number;
  /** The named entities' surface forms, when the caller has them. */
  names: string[];
  /** The documents the named entities are mentioned in: a quoted term is looked for there when there are any. */
  namedDocs?: string[];
}

/**
 * Excerpts of the chunks outside `contexts` that hold the question's quoted
 * terms (inside the named entities' documents, when the question names any)
 * or, failing those, the named entities' names; ranked by the question's other
 * terms, a window per document per turn, up to the character budget. Each is
 * a `SearchResult` with `excerpt: true` and the excerpt as its content.
 */
export async function excerptsForQuestion(store: Store, question: string, contexts: SearchResult[], opts: ExcerptOptions): Promise<SearchResult[]> {
  const budget = opts.budget ?? EXCERPT_CHARS;
  if (budget <= 0) return [];
  const quoted = quotedTerms(question).map((t) => t.toLowerCase());
  const names = [...new Set(opts.names.map((n) => n.toLowerCase().trim()))].filter((n) => n.length >= (/[一-鿿]/.test(n) ? 2 : 3));
  // a quoted name is a name; a quoted term is what to look for inside the named things
  const terms = quoted.filter((t) => !names.includes(t));
  const anchors = terms.length ? terms : names.length ? names : await rarestTerms(store, question);
  if (anchors.length === 0) return [];
  const inDocs = terms.length && opts.namedDocs?.length ? opts.namedDocs : null;

  const p = new Params();
  const exact = anchors.map((a) => `strpos(lower(c.content), ${p.add(a)}) > 0`).join(' OR ');
  const grams = anchors.map(termGrams);
  const indexed = matchIndexReady(store, 'chunks') && grams.every((g) => g.length > 0);
  const match = indexed ? `${MATCH_INDEXES.chunks.expr('c')} @@ ${p.add(gramQuery(grams, 1))}::tsquery` : `(${exact})`;
  const skip = p.add(contexts.map((c) => c.chunkId));
  const docs = inDocs ? `AND c.document_id = ANY(${p.add(inDocs)}::text[])` : '';
  const cap = p.add(SCAN_CAP);
  const cond = docLiveAt('d', p);
  // the index lookup in its own materialized step, as in search's term lists: joined directly, a planner
  // without statistics evaluates match_grams on every chunk
  const rows = await store.query<Hit>(
    `WITH hit AS MATERIALIZED (SELECT c.id FROM chunks c WHERE ${match} ${docs} AND NOT c.id = ANY(${skip}::text[]) LIMIT ${cap})
     SELECT c.id AS chunk_id, c.document_id, c.seq, d.path, d.title, d.doc_date, c.content
     FROM hit h JOIN chunks c ON c.id = h.id JOIN documents d ON d.id = c.document_id
     WHERE ${cond} AND (${exact})`,
    p.list,
  );
  if (rows.length === 0) return [];
  // a hit above the first unit a chunk opens is in the unit the chunk before left open: its opening line
  const carry = new Map<string, string>();
  const before = rows.filter((r) => r.seq > 0 && hitBeforeOpener(r.content, anchors));
  if (before.length) {
    const prev = await store.query<{ document_id: string; seq: number; content: string }>(
      `SELECT c.document_id, c.seq, c.content FROM chunks c JOIN unnest($1::text[], $2::int[]) AS k(doc, seq) ON c.document_id = k.doc AND c.seq = k.seq`,
      [before.map((r) => r.document_id), before.map((r) => r.seq - 1)],
    );
    for (const p of prev) {
      const opener = lastOpener(p.content);
      if (opener) carry.set(`${p.document_id}:${p.seq + 1}`, opener);
    }
  }

  // the question's other terms rank the windows: "which papers use RAG for code" prefers the code ones
  const rank = keywordTerms(question).filter((t) => !anchors.some((a) => a.includes(t)));
  type Win = { hit: Hit; text: string; score: number };
  const byDoc = new Map<string, Win[]>();
  // chunks overlap: a window two of them hold is shown once
  const shown = new Set<string>();
  for (const hit of rows) {
    for (const text of excerptOf(hit.content, anchors, WINDOW_MAX, carry.get(`${hit.document_id}:${hit.seq}`))) {
      if (shown.has(text)) continue;
      shown.add(text);
      const lower = text.toLowerCase();
      const score = rank.reduce((s, t) => s + (termCount(lower, t) > 0 ? 1 : 0), 0);
      (byDoc.get(hit.document_id) ?? byDoc.set(hit.document_id, []).get(hit.document_id)!).push({ hit, text, score });
    }
  }
  for (const wins of byDoc.values()) wins.sort((a, b) => b.score - a.score || (a.hit.chunk_id < b.hit.chunk_id ? -1 : 1));
  // documents whose best window matches the question best go first in each turn
  const order = [...byDoc.entries()].sort((a, b) => b[1][0].score - a[1][0].score || b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));

  const taken = new Map<string, { hit: Hit; texts: string[] }>();
  let used = 0;
  for (let turn = 0, added = true; added && used < budget; turn++) {
    added = false;
    for (const [, wins] of order) {
      const w = wins[turn];
      if (!w) continue;
      if (used + w.text.length > budget) continue;
      used += w.text.length;
      added = true;
      const t = taken.get(w.hit.chunk_id) ?? taken.set(w.hit.chunk_id, { hit: w.hit, texts: [] }).get(w.hit.chunk_id)!;
      t.texts.push(w.text);
    }
  }
  return [...taken.values()].map(({ hit, texts }) => ({
    chunkId: hit.chunk_id,
    documentId: hit.document_id,
    path: hit.path,
    title: hit.title,
    // in the chunk's own order
    content: texts.sort((a, b) => hit.content.indexOf(a.replace(/^…/, '').slice(0, 20)) - hit.content.indexOf(b.replace(/^…/, '').slice(0, 20))).join('\n…\n'),
    docDate: toDateString(hit.doc_date),
    score: 0,
    signals: {},
    excerpt: true,
  }));
}
