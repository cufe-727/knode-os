import { Store, toVectorLiteral, VECTOR_TYPE } from '../store/db.js';
import { SearchResult } from '../types.js';
import { factsForQuestion, QuestionFact } from './facts.js';
import { CJK_QUERY_STOP, keywordTerms, LATIN_QUERY_STOP, termCount } from './search.js';

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
 *   the test    a named entity none of whose spellings a fact is about or
 *               a passage mentions or writes; half a lookup's words in none
 *               of the passages and facts; a chain question (route.ts
 *               `isChainQuestion`, or routed multihop) missing a word, or
 *               whose step — the entity its first round reached — has no
 *               passage or fact of its own yet. Words are the segmenter's
 *               (`questionWords`), less stop words, interrogatives and the
 *               kind of answer they ask for ("哪家公司"): never pairs of
 *               characters across a word boundary. There must be something
 *               to look further from: the uncovered named entities, or
 *               entities the first round reached that the question does not
 *               name
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
/** Passages read as candidates at most, the best first (nearest the question, else holding most missing words). */
const CANDIDATES = 240;
/** Mentions of the entities looked from read at most, before the candidates are ranked: a hub has thousands. */
const POOL = 2000;
/** The word segmenter the search's bridge terms use (search/bridge.ts). */
const SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' });
/** Longest run of characters the segmenter cut one by one kept as one word (a name it does not know). */
const UNKNOWN_RUN_MAX = 6;
/** Words that ask, or point back or at now, rather than name what is asked about. */
const ASKING = new Set([
  '哪里', '哪儿', '哪个', '哪家', '哪位', '哪些', '哪一', '什么', '怎么', '怎样', '如何', '为什么', '为何', '多少', '几个', '是否', '现在', '目前', '当前', '如今', '后来', '此人', '这个', '那个', '情况',
  'who', 'whom', 'whose', 'what', 'where', 'when', 'which', 'why', 'how', 'now', 'currently', 'today', 'person', 'people', 'one', 'that', 'this', 'they', 'them', 'their',
]);
/** An interrogative whose next word is the kind of answer asked for ("哪家公司", "which team"), not a word the passages must hold. */
const ASKS_FOR = /^(?:哪|哪家|哪个|哪位|哪些|哪一|什么|啥|which|what)$/i;
/** Characters of grammar: they break a run of characters the segmenter cut one by one, and a word made only of them is no word ("到了", "的人"). */
const GRAMMAR = /^[的了过是在有和与及那这它他她其被由把将又也都还就人个位些此该吗呢么到着得地对从向给于为等之所以而且但或并]+$/;
/** Measure characters between an interrogative and what it asks for ("哪|家|公司", "几|个|人"). */
const MEASURE = /^[家个位名种条项些起件只台座次]$/;

/** The question's words: latin words and the segmenter's CJK words, less stop words, interrogatives and what they ask for. */
export function questionWords(question: string): string[] {
  const out: string[] = [];
  let skipNext = false;
  const push = (w: string) => {
    const lower = w.toLowerCase();
    if (ASKS_FOR.test(lower)) { skipNext = true; return; }
    if (skipNext) { skipNext = false; return; }
    if (ASKING.has(lower) || CJK_QUERY_STOP.has(lower) || LATIN_QUERY_STOP.has(lower) || GRAMMAR.test(lower)) return;
    if (/^[a-z0-9-]+$/i.test(w) ? w.length < 3 : w.length < 2) return;
    out.push(lower);
  };
  for (const m of question.matchAll(/[一-鿿㐀-䶿]+|[A-Za-z][A-Za-z0-9-]*|\d+/g)) {
    const run = m[0];
    if (!/[一-鿿㐀-䶿]/.test(run)) { push(run); continue; }
    // the characters the segmenter cut one by one, kept together as one word (a name it does not know) until grammar
    let singles = '';
    const flush = () => {
      if (singles.length >= 2 && singles.length <= UNKNOWN_RUN_MAX) push(singles);
      singles = '';
    };
    for (const { segment } of SEGMENTER.segment(run)) {
      if (segment.length === 1) {
        if (ASKS_FOR.test(segment)) { flush(); push(segment); continue; }
        if (skipNext && MEASURE.test(segment)) continue;
        if (GRAMMAR.test(segment)) { flush(); continue; }
        singles += segment;
        continue;
      }
      flush();
      push(segment);
    }
    flush();
  }
  return [...new Set(out)];
}

export interface SecondRound {
  /** Why it ran: the named entities nothing was about, the words nothing held, the entities it looked from. */
  reason: { uncoveredNamed: string[]; missingTerms: string[]; from: string[] };
  chunks: SearchResult[];
  facts: QuestionFact[];
  statements: number;
  ms: number;
}

interface FactLike { subject: string; object?: string | null; statement: string; path?: string | null }

/** The question's words none of the passages and facts hold (names it gives excluded). */
export function missingTerms(question: string, names: string[], text: string): string[] {
  const hay = text.toLowerCase();
  const nameText = names.join(' ').toLowerCase();
  return questionWords(question)
    .filter((t) => !nameText.includes(t))
    // a word held, or its singular ("incidents" / "incident")
    .filter((t) => !hay.includes(t) && !(/^[a-z]{4,}s$/.test(t) && hay.includes(t.slice(0, -1))));
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

  // named entities nothing was about: an entity, not a spelling — one is covered when any spelling merged into or
  // with it is mentioned by a passage, is a fact's subject or object, or is written in a passage
  const namedRows = named.length
    ? await q<{ id: string; root: string; name: string; aliases: unknown }>(
      `SELECT e.id, COALESCE(e.canonical_id, e.id) AS root, e.name, e.aliases FROM entities e
       WHERE e.id = ANY($1::text[]) OR e.canonical_id = ANY($1::text[])
          OR e.id IN (SELECT canonical_id FROM entities WHERE id = ANY($1::text[]) AND canonical_id IS NOT NULL)`,
      [named],
    )
    : [];
  const spellingIds = namedRows.map((r) => r.id);
  const mentioned = new Set(spellingIds.length && contexts.length
    ? (await q<{ entity_id: string }>(`SELECT DISTINCT entity_id FROM entity_mentions WHERE entity_id = ANY($1::text[]) AND chunk_id = ANY($2::text[])`, [spellingIds, contexts.map((c) => c.chunkId)])).map((r) => r.entity_id)
    : []);
  const namesOf = (r: { name: string; aliases: unknown }) => [r.name, ...(Array.isArray(r.aliases) ? r.aliases.filter((a): a is string => typeof a === 'string') : [])];
  const about = new Set(facts.flatMap((f) => [f.subject, f.object ?? '']).filter(Boolean));
  const passageText = contexts.map((c) => c.content).join('\n');
  const groups = new Map<string, typeof namedRows>();
  for (const r of namedRows) (groups.get(r.root) ?? groups.set(r.root, []).get(r.root)!).push(r);
  const uncovered = [...groups.values()]
    .filter((g) => !g.some((r) => mentioned.has(r.id) || namesOf(r).some((n) => about.has(n) || (n.length >= 2 && passageText.includes(n)))))
    .map((g) => g.find((r) => r.id === r.root) ?? g[0]);
  const names = namedRows.flatMap(namesOf);
  const missing = missingTerms(question, names, text);
  // thin: a named entity came back with nothing; half a lookup's words are nowhere; a chain misses a word, or its
  // step — the entity its first round reached — has no passage or fact of its own yet (only the claim that led to it)
  const asked0 = questionWords(question).filter((t) => !names.join(' ').toLowerCase().includes(t));
  let thin = uncovered.length > 0 || (missing.length > 0 && (opts.chain || missing.length * 2 >= Math.max(1, asked0.length)));
  let stepCheck = false;
  if (!thin && opts.chain) stepCheck = true;
  else if (!thin) return null;

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
    [[...reachedNames.keys()], contexts.map((c) => c.chunkId), spellingIds],
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
  if (stepCheck) {
    // the chain's step: the reached entity weighed most; it is covered when a passage mentions it or a fact is about it
    const step = [...reached].filter((r) => !names.includes(r.name))
      .sort((a, b) => (weight.get(b.name) ?? 0) - (weight.get(a.name) ?? 0) || a.id.localeCompare(b.id))[0];
    if (!step || step.passages > 0 || facts.some((f) => f.subject === step.name)) return null;
    thin = true;
  }
  const common = new Set(bridges.filter((b) => b.docs > BRIDGE_DOCS).map((b) => b.id));
  // an uncovered named entity is looked from through every spelling; a hub among them, with no vector to rank its
  // passages by, only through passages holding a missing word
  const withVector = Boolean(opts.queryVector && opts.model);
  const uncoveredIds = uncovered.flatMap((u) => groups.get(u.root)!.map((r) => r.id));
  if (!withVector && uncoveredIds.length) {
    const hubs = await q<{ id: string }>(
      `SELECT entity_id AS id FROM entity_mentions WHERE entity_id = ANY($1::text[]) GROUP BY 1 HAVING count(DISTINCT document_id) > $2`, [uncoveredIds, BRIDGE_DOCS],
    );
    for (const h of hubs) common.add(h.id);
  }
  const from = [...uncoveredIds, ...bridges.map((b) => b.id)];
  if (from.length === 0) return null;

  // the passages that mention them, most of them first, then the missing words, then nearness
  const shown = contexts.map((c) => c.chunkId);
  const words = missing.slice(0, 6).map((t) => `%${t.replace(/[%_\\]/g, '\\$&')}%`);
  const wordsSql = words.length ? words.map((_, i) => `(c.content ILIKE $${withVector ? 6 + i : 4 + i})::int`).join(' + ') : '0';
  const cands = await q<{ chunk_id: string; document_id: string; path: string; title: string | null; content: string; doc_date: string | Date | null; hits: number; ents: string[]; sim: number | null; words: number }>(
    `WITH m AS MATERIALIZED (
       SELECT chunk_id, entity_id FROM entity_mentions WHERE entity_id = ANY($1::text[]) AND NOT chunk_id = ANY($2::text[]) LIMIT ${POOL}
     ), hit AS (
       SELECT chunk_id, count(DISTINCT entity_id)::int AS hits, array_agg(DISTINCT entity_id) AS ents FROM m GROUP BY 1
     ), scored AS (
       SELECT c.id AS chunk_id, c.document_id, d.path, d.title, c.content, d.doc_date, hit.hits, hit.ents,
              ${withVector ? `(SELECT 1 - (e.embedding <=> $4::${VECTOR_TYPE}) FROM embeddings e WHERE e.chunk_id = c.id AND e.model = $5)` : 'NULL::float'} AS sim,
              ${wordsSql} AS words
       FROM hit JOIN chunks c ON c.id = hit.chunk_id JOIN documents d ON d.id = c.document_id
       WHERE d.status = 'indexed'
     )
     SELECT * FROM scored ORDER BY hits DESC, ${withVector ? 'sim DESC NULLS LAST, ' : ''}words DESC, chunk_id LIMIT $3`,
    withVector ? [from, shown, CANDIDATES, toVectorLiteral(opts.queryVector!), opts.model, ...words] : [from, shown, CANDIDATES, ...words],
  );
  const scored = cands.map((c) => {
    const words = missing.filter((t) => termCount(c.content.toLowerCase(), t) > 0).length;
    return { c, words, key: withVector ? [c.hits, c.sim ?? 0, words] as const : [c.hits, words, 0] as const };
  })
    // a passage reached only through a common entity must hold a missing word
    .filter((x) => x.words > 0 || (x.c.ents ?? []).some((e) => !common.has(e)))
    .sort((a, b) => b.key[0] - a.key[0] || b.key[1] - a.key[1] || b.key[2] - a.key[2] || a.c.chunk_id.localeCompare(b.c.chunk_id));
  // one passage a document, so the round reaches as many documents as it may; a document the first round shows
  // already — a passage of it, a generated page citing it by path, a fact it is the source of — is not new
  const seenDoc = new Set(contexts.map((c) => c.documentId));
  const cited = new Set([
    ...contexts.flatMap((c) => [c.path, ...[...c.content.matchAll(/raw\/[^\s)\]>|"']+?\.md/g)].map((m) => m[0])]),
    ...facts.map((f) => f.path).filter((p): p is string => Boolean(p)),
  ]);
  const chunks: SearchResult[] = [];
  for (const { c } of scored) {
    if (chunks.length >= SECOND_CHUNKS) break;
    if (seenDoc.has(c.document_id) || cited.has(c.path)) continue;
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
