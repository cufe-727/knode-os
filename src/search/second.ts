import { Store, toVectorLiteral, VECTOR_TYPE } from '../store/db.js';
import { SearchResult } from '../types.js';
import { factsForQuestion, QuestionFact } from './facts.js';
import { keywordTerms, termCount } from './search.js';

/**
 * A second retrieval round when the first is thin (docs/design/34 §2).
 *
 * `ask` retrieves once: a search, the facts about what the search and the
 * question name. A question whose answer sits one step past what it names
 * ("提出R-03的人现在在哪个组？") gets the step's entity in its facts (方杰) and
 * nothing about where 方杰 is now; a question naming an entity none of whose
 * claims or passages came back gets nothing about it at all. Here, without a
 * model call:
 *
 *   the test    a chain question (route.ts `isChainQuestion`, or routed
 *               multihop): one round answered steps it asks one after another;
 *               a named entity no fact is about and no passage mentions; or
 *               half the words of the question in none of the passages and
 *               facts. In each case there must be something to look further
 *               from: the uncovered named entities, or entities the first
 *               round reached that the question does not name
 *   the round   one, at most: the passages that mention those entities — the
 *               ones that mention most of them and hold most of the missing
 *               words first, nearness to the question breaking ties — and the
 *               facts about them, within `SECOND_CHUNKS` passages and
 *               `SECOND_FACTS` facts
 *
 * An entity reached in the first round that many documents mention (a team
 * that writes every weekly report, a person every report lists) narrows
 * little: one mentioned in more than `BRIDGE_DOCS` documents is looked further
 * from only through passages that also hold a word the first round missed
 * ("调到", "接手"), and never one in more than `BRIDGE_DOCS_WORDED`.
 */

/** Passages a second round adds at most. */
export const SECOND_CHUNKS = 4;
/** Facts a second round adds at most. */
export const SECOND_FACTS = 12;
/** An entity reached is looked further from through any passage when this few documents mention it. */
export const BRIDGE_DOCS = 15;
/** One mentioned in more (up to this many), only through passages that also hold a word the first round missed. */
export const BRIDGE_DOCS_WORDED = 80;
/** Entities reached, looked further from at most. */
const BRIDGES = 4;
/** Passages read as candidates at most. */
const CANDIDATES = 240;
/** Characters that make a CJK pair a piece of grammar, not a word ("的人", "复过", "那起"). */
const FUNCTION_CHARS = /[的了过是在有和与及那这它他她其一被由把将又也都还就人个位些此该吗呢么哪谁几什]/;

export interface SecondRound {
  /** Why it ran: the named entities nothing was about, the words nothing held, the entities it looked from. */
  reason: { uncoveredNamed: string[]; missingTerms: string[]; from: string[] };
  chunks: SearchResult[];
  facts: QuestionFact[];
  statements: number;
  ms: number;
}

interface FactLike { subject: string; object?: string | null; statement: string }

/** The question's words none of the passages and facts hold (names it gives excluded). */
export function missingTerms(question: string, names: string[], text: string): string[] {
  const hay = text.toLowerCase();
  const nameText = names.join(' ').toLowerCase();
  return keywordTerms(question)
    .filter((t) => !nameText.includes(t))
    .filter((t) => !(/^[一-鿿]{2}$/.test(t) && FUNCTION_CHARS.test(t)))
    .filter((t) => termCount(hay, t) === 0);
}

/**
 * Run a second round when the first is thin; null when it is not, or when
 * there is nothing to look further from.
 */
export async function secondRound(
  store: Store,
  question: string,
  opts: { named: string[]; contexts: SearchResult[]; facts: FactLike[]; chain: boolean; queryVector?: number[]; model?: string },
): Promise<SecondRound | null> {
  const started = Date.now();
  let statements = 0;
  const q = <T>(sql: string, p: unknown[]) => {
    statements++;
    return store.query<T>(sql, p);
  };
  const { named, contexts, facts } = opts;
  const text = [...contexts.map((c) => c.content), ...facts.map((f) => `${f.subject} ${f.statement} ${f.object ?? ''}`)].join('\n');

  // named entities nothing was about: no fact's subject or object, no passage mentions them
  const namedRows = named.length
    ? await q<{ id: string; name: string; aliases: unknown; mentioned: boolean }>(
      `SELECT e.id, e.name, e.aliases,
              EXISTS (SELECT 1 FROM entity_mentions m WHERE m.entity_id = e.id AND m.chunk_id = ANY($2::text[])) AS mentioned
       FROM entities e WHERE e.id = ANY($1::text[])`,
      [named, contexts.map((c) => c.chunkId)],
    )
    : [];
  const namesOf = (r: { name: string; aliases: unknown }) => [r.name, ...(Array.isArray(r.aliases) ? r.aliases.filter((a): a is string => typeof a === 'string') : [])];
  const about = new Set(facts.flatMap((f) => [f.subject, f.object ?? '']).filter(Boolean));
  const uncovered = namedRows.filter((r) => !r.mentioned && !namesOf(r).some((n) => about.has(n)));
  const names = namedRows.flatMap(namesOf);
  const missing = missingTerms(question, names, text);
  // a chain asks for steps one round took at once: it gets the next step always; a lookup, when a named entity
  // came back with nothing or half the words it asks about are nowhere
  const thin = opts.chain || uncovered.length > 0 || (missing.length > 0 && missing.length * 2 >= Math.max(1, keywordTerms(question).length));
  if (!thin) return null;

  // what to look further from: the uncovered named entities, and the entities the first round reached — its facts
  // are about, its passages mention — that the question does not name
  const reachedNames = new Map<string, number>();
  for (const f of facts.slice(0, 40)) for (const n of [f.subject, f.object]) if (n && !names.includes(n)) reachedNames.set(n, (reachedNames.get(n) ?? 0) + 1);
  const reached = await q<{ id: string; name: string; docs: number; passages: number }>(
    `WITH ctx AS (SELECT m.entity_id, count(DISTINCT m.chunk_id)::int AS passages FROM entity_mentions m WHERE m.chunk_id = ANY($2::text[]) GROUP BY 1)
     SELECT e.id, e.name, COALESCE(ctx.passages, 0) AS passages,
            (SELECT count(DISTINCT m.document_id)::int FROM entity_mentions m WHERE m.entity_id = e.id) AS docs
     FROM entities e LEFT JOIN ctx ON ctx.entity_id = e.id
     WHERE (e.name = ANY($1::text[]) OR ctx.entity_id IS NOT NULL) AND e.tx_to IS NULL AND e.canonical_id IS NULL AND NOT e.id = ANY($3::text[])`,
    [[...reachedNames.keys()], contexts.map((c) => c.chunkId), named],
  );
  // the ones the facts about what the question asks hold most, a rarer one before a commoner
  const asked = keywordTerms(question).filter((t) => !names.join(' ').toLowerCase().includes(t));
  const weight = new Map<string, number>();
  for (const f of facts.slice(0, 40)) {
    const words = asked.filter((t) => termCount(`${f.statement}`.toLowerCase(), t) > 0).length;
    for (const n of [f.subject, f.object]) if (n) weight.set(n, (weight.get(n) ?? 0) + 1 + words);
  }
  for (const r of reached) weight.set(r.name, (weight.get(r.name) ?? 0) + r.passages);
  const bridges = reached
    .filter((r) => r.docs > 0 && r.docs <= (missing.length ? BRIDGE_DOCS_WORDED : BRIDGE_DOCS) && !names.includes(r.name))
    .sort((a, b) => (weight.get(b.name) ?? 0) - (weight.get(a.name) ?? 0) || a.docs - b.docs || a.id.localeCompare(b.id))
    .slice(0, BRIDGES);
  const common = new Set(bridges.filter((b) => b.docs > BRIDGE_DOCS).map((b) => b.id));
  const from = [...uncovered.map((r) => r.id), ...bridges.map((b) => b.id)];
  if (from.length === 0) return null;

  // the passages that mention them, most of them first, then the missing words, then nearness
  const shown = contexts.map((c) => c.chunkId);
  const withVector = Boolean(opts.queryVector && opts.model);
  const cands = await q<{ chunk_id: string; document_id: string; path: string; title: string | null; content: string; doc_date: string | Date | null; hits: number; ents: string[]; sim: number | null }>(
    `WITH hit AS (
       SELECT m.chunk_id, count(DISTINCT m.entity_id)::int AS hits, array_agg(DISTINCT m.entity_id) AS ents FROM entity_mentions m
       WHERE m.entity_id = ANY($1::text[]) AND NOT m.chunk_id = ANY($2::text[]) GROUP BY 1
     )
     SELECT c.id AS chunk_id, c.document_id, d.path, d.title, c.content, d.doc_date, hit.hits, hit.ents,
            ${withVector ? `(SELECT 1 - (e.embedding <=> $4::${VECTOR_TYPE}) FROM embeddings e WHERE e.chunk_id = c.id AND e.model = $5)` : 'NULL::float'} AS sim
     FROM hit JOIN chunks c ON c.id = hit.chunk_id JOIN documents d ON d.id = c.document_id
     WHERE d.status = 'indexed'
     ORDER BY hit.hits DESC, c.id LIMIT $3`,
    withVector ? [from, shown, CANDIDATES, toVectorLiteral(opts.queryVector!), opts.model] : [from, shown, CANDIDATES],
  );
  const scored = cands.map((c) => {
    const words = missing.filter((t) => termCount(c.content.toLowerCase(), t) > 0).length;
    return { c, words, key: [c.hits, words, c.sim ?? 0] as const };
  })
    // a passage reached only through a common entity must hold a missing word
    .filter((x) => x.words > 0 || (x.c.ents ?? []).some((e) => !common.has(e)))
    .sort((a, b) => b.key[0] - a.key[0] || b.key[1] - a.key[1] || b.key[2] - a.key[2] || a.c.chunk_id.localeCompare(b.c.chunk_id));
  // one passage a document, so the round reaches as many documents as it may
  const seenDoc = new Set(contexts.map((c) => c.documentId));
  const chunks: SearchResult[] = [];
  for (const { c } of scored) {
    if (chunks.length >= SECOND_CHUNKS) break;
    if (seenDoc.has(c.document_id)) continue;
    seenDoc.add(c.document_id);
    chunks.push({
      chunkId: c.chunk_id, documentId: c.document_id, path: c.path, title: c.title, content: c.content,
      docDate: c.doc_date ? new Date(c.doc_date).toISOString().slice(0, 10) : null, score: 0, signals: { graph: c.hits, ...(c.sim !== null ? { vector: c.sim } : {}) },
    });
  }
  // the facts about them, ranked against the question like the first round's
  const known = new Set(facts.map((f) => `${f.subject}|${f.statement}`));
  const more = (await factsForQuestion(store, question, chunks, { named: from, limit: SECOND_FACTS + facts.length, queryVector: opts.queryVector, model: opts.model }))
    .filter((f) => !known.has(`${f.subject}|${f.statement}`))
    .slice(0, SECOND_FACTS);
  statements += 1; // factsForQuestion: one statement (its list routes are not asked for)
  return {
    reason: { uncoveredNamed: uncovered.map((r) => r.name), missingTerms: missing, from: [...uncovered.map((r) => r.name), ...bridges.map((b) => b.name)] },
    chunks, facts: more, statements, ms: Date.now() - started,
  };
}
