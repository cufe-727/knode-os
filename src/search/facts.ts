import { findLinks, tier0Known } from '../graph/concepts.js';
import { expandGroups } from '../graph/resolve.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../store/db.js';
import { toDateString } from '../store/temporal.js';
import { ClaimItem, SearchResult } from '../types.js';
import { keywordTerms, termCount } from './search.js';

/**
 * The claims an answer is given beside its retrieved chunks.
 *
 * A chunk says what one passage says. The claims are what the knowledge base
 * extracted from every document, so they are worth their place in a prompt
 * when they add what the chunks do not hold: what other documents say about
 * the things the question names. They used to be any eight claims about any
 * entity a retrieved chunk mentioned, in no order — on the benchmark's
 * corpus-level questions (list every…, what do the documents say about…) they
 * raised the share of gold evidence in the prompt from 0.38 to 0.40.
 *
 * Here the candidates are the claims about the entities the question names
 * (as subject or object), the claims about entities the retrieved chunks
 * mention, and the claims extracted from those chunks; they are ranked by how
 * well they match the question — its terms, and its embedding where the
 * claim has one — and taken a few per source, so that a list question is
 * answered from many documents rather than from the best one three times.
 */

export interface QuestionFact extends ClaimItem {
  /** The chunk the claim was extracted from, when it is still indexed. */
  chunkId: string | null;
}

export interface FactOptions {
  /** Claims returned at most. */
  limit?: number;
  /** The question's embedding and the model it is of: claims embedded by that model are also ranked by it. */
  queryVector?: number[];
  model?: string;
}

/** Entities named in a question at most: past these it is a paragraph, not a question. */
const NAMED_MAX = 6;
/** Claims read per route. A company in a finance workspace has thousands; the newest are the ones asked about. */
const ROUTE_CAP = 300;
/** Claims taken from one source before every other source has had its turn. */
const PER_SOURCE = 3;
const RRF_K = 60;

/** The live entities a text names, most often first, with the ones merged into them. */
export async function namedEntities(store: Store, text: string, max = NAMED_MAX): Promise<string[]> {
  const { index } = await tier0Known(store);
  const counts = new Map<string, number>();
  for (const span of findLinks(text, index)) {
    const id = span.candidate.id;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const ids = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([id]) => id);
  return ids.length ? expandGroups(store, ids) : [];
}

interface Row {
  id: string; via: number; subject: string; object: string | null; type: string; statement: string; status: string; kind: string;
  valid_from: string | null; valid_to: string | null; event_at: string | null; path: string | null; evidence_count: number; chunk_id: string | null; sim: number | null;
}

export async function factsForQuestion(store: Store, question: string, contexts: SearchResult[], opts: FactOptions = {}): Promise<QuestionFact[]> {
  const limit = opts.limit ?? 24;
  if (limit <= 0) return [];
  const chunkIds = contexts.map((c) => c.chunkId);
  const named = await namedEntities(store, question);
  if (chunkIds.length === 0 && named.length === 0) return [];

  const liveClaim = `cl.tx_to IS NULL AND cl.canonical_id IS NULL AND cl.superseded_by IS NULL`;
  const withVector = Boolean(opts.queryVector && opts.model);
  const params: unknown[] = [named, chunkIds, ROUTE_CAP];
  let sim = 'NULL::float';
  if (withVector) {
    params.push(toVectorLiteral(opts.queryVector!), opts.model);
    sim = `(SELECT 1 - (ce.embedding <=> $4::${VECTOR_TYPE}) FROM claim_embeddings ce WHERE ce.claim_id = cl.id AND ce.model = $5)`;
  }
  // via: 0 named by the question, 1 about an entity a retrieved chunk mentions, 2 extracted from a retrieved chunk
  const rows = await store.query<Row>(
    `WITH cand AS (
       (SELECT cl.id, 0 AS via FROM claims cl WHERE cl.subject_id = ANY($1::text[]) AND ${liveClaim} ORDER BY cl.tx_from DESC LIMIT $3)
       UNION ALL
       (SELECT cl.id, 0 AS via FROM claims cl WHERE cl.object_id = ANY($1::text[]) AND ${liveClaim} ORDER BY cl.tx_from DESC LIMIT $3)
       UNION ALL
       (SELECT cl.id, 1 AS via FROM claims cl
        WHERE cl.subject_id IN (SELECT DISTINCT m.entity_id FROM entity_mentions m WHERE m.chunk_id = ANY($2::text[])) AND ${liveClaim}
        ORDER BY cl.tx_from DESC LIMIT $3)
       UNION ALL
       (SELECT cl.id, 2 AS via FROM claims cl WHERE cl.chunk_id = ANY($2::text[]) AND ${liveClaim})
     ), picked AS MATERIALIZED (SELECT id, min(via) AS via FROM cand GROUP BY id)
     SELECT cl.id, p.via, se.name AS subject, oe.name AS object, cl.type, cl.statement, cl.status, cl.kind,
            cl.valid_from, cl.valid_to, cl.event_at, s.key AS path, cl.evidence_count, cl.chunk_id, ${sim} AS sim
     FROM picked p
     JOIN claims cl ON cl.id = p.id
     JOIN entities se ON se.id = cl.subject_id
     LEFT JOIN entities oe ON oe.id = cl.object_id
     LEFT JOIN scopes s ON s.id = cl.primary_scope_id`,
    params,
  );

  // a plain fact read off a chunk the model is given anyway says nothing the chunk does not; a hedged
  // or disputed one, a view or a forecast is what the answer has to flag, so it stays
  const inContext = new Set(chunkIds);
  const pool = rows.filter((r) => !(r.chunk_id && inContext.has(r.chunk_id) && r.status === 'fact' && (r.kind ?? 'fact') === 'fact'));
  if (pool.length === 0) return [];

  const picked = pickRelevant(question, pool, limit, { sim: (r) => r.sim, named: (r) => r.via === 0 });
  return picked.map((r) => ({
    id: r.id, subject: r.subject, object: r.object, type: r.type, statement: r.statement, status: r.status, kind: r.kind,
    startDate: toDateString(r.valid_from), endDate: toDateString(r.valid_to), eventDate: toDateString(r.event_at),
    path: r.path, evidenceCount: r.evidence_count, chunkId: r.chunk_id,
  }));
}

/** What `pickRelevant` reads of a claim. */
export interface RankableClaim {
  id: string;
  subject: string;
  object?: string | null;
  statement: string;
  path?: string | null;
}

/**
 * The `limit` claims that answer `question` best, a few per source in turn.
 *
 * A claim is ranked by the question's terms it holds (each weighted by how
 * rare it is among the candidates) and, where `sim` gives one, by its
 * embedding's nearness to the question's; the two orders are fused by rank.
 * A claim matching neither is kept only when `named` says the question names
 * its entity: "what is known about X" matches no claim's words. Sources take
 * turns, `PER_SOURCE` claims a round, so a list question is answered from as
 * many documents as there are rather than from the best one.
 */
export function pickRelevant<T extends RankableClaim>(
  question: string,
  pool: T[],
  limit: number,
  opts: { sim?: (c: T) => number | null | undefined; named?: (c: T) => boolean } = {},
): T[] {
  if (pool.length === 0 || limit <= 0) return [];
  const terms = keywordTerms(question);
  const texts = pool.map((r) => `${r.subject} ${r.statement} ${r.object ?? ''}`.toLowerCase());
  const idf = terms.map((t) => {
    const df = texts.filter((x) => termCount(x, t) > 0).length;
    return df === 0 ? 0 : Math.log(1 + (pool.length - df + 0.5) / (df + 0.5));
  });
  const lexical = texts.map((x) => terms.reduce((sum, t, i) => (idf[i] > 0 && termCount(x, t) > 0 ? sum + idf[i] : sum), 0));

  const rankOf = (score: (i: number) => number | null | undefined): Map<number, number> => {
    const order = pool.map((_, i) => i).filter((i) => (score(i) ?? 0) > 0).sort((a, b) => score(b)! - score(a)! || (pool[a].id < pool[b].id ? -1 : 1));
    return new Map(order.map((i, rank) => [i, rank]));
  };
  const byTerms = rankOf((i) => lexical[i]);
  const byVector = opts.sim ? rankOf((i) => opts.sim!(pool[i])) : new Map<number, number>();
  const ranked = pool
    .map((r, i) => {
      let score = 0;
      if (byTerms.has(i)) score += 1 / (RRF_K + byTerms.get(i)! + 1);
      if (byVector.has(i)) score += 1 / (RRF_K + byVector.get(i)! + 1);
      return { r, score, named: opts.named?.(r) ?? false };
    })
    .filter((x) => x.score > 0 || x.named)
    .sort((a, b) => b.score - a.score || Number(b.named) - Number(a.named) || (a.r.id < b.r.id ? -1 : 1));

  const picked: T[] = [];
  const done = new Set<T>();
  const taken = new Map<string, number>();
  const seenText = new Set<string>();
  for (let round = 1; picked.length < limit && round <= Math.ceil(limit / PER_SOURCE) + 1; round++) {
    let added = false;
    for (const { r } of ranked) {
      if (picked.length >= limit) break;
      if (done.has(r)) continue;
      const source = r.path ?? '';
      if ((taken.get(source) ?? 0) >= PER_SOURCE * round) continue;
      done.add(r);
      const text = `${r.subject}|${r.statement}`;
      // the same statement from a second source says nothing new
      if (seenText.has(text)) continue;
      seenText.add(text);
      taken.set(source, (taken.get(source) ?? 0) + 1);
      picked.push(r);
      added = true;
    }
    if (!added) break;
  }
  return picked;
}
