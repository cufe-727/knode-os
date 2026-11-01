import { docLiveAt } from '../search/search.js';
import { Queryable } from '../store/migrations.js';
import { NO_FILTER, ResolvedScopeFilter } from '../store/resolver.js';
import { Params, rowLiveAt, TimeInput } from '../store/temporal.js';
import { GraphEdge } from '../types.js';

/**
 * Co-occurrence, derived at read time.
 *
 * Two entities co-occur when one source mentions both: strongly when a chunk
 * carries both mentions, weakly when only the document does. Every producer
 * (tier-0 concepts, wikilink wiring, tier-1 extraction) used to *store* this
 * as `co_occurs` relation rows with their own evidence — 92% of the finance
 * workspace's relations table — although `entity_mentions` already held
 * everything they said, in list order rather than in the text's. Migration
 * v13 dropped those rows; readers call this module instead, so the relations
 * table holds typed predicates only and co-occurrence can neither go stale nor
 * inflate on re-ingest.
 *
 * Liveness and scope follow the document that carries the mention, the way
 * graph grounding and SAG already read mentions (`docLiveAt`): `as_of` keeps
 * the mentions of documents that were live then, a source filter keeps the
 * documents that pass it. Mentions are hard-deleted when a source is disposed,
 * so a removed document contributes nothing to an `as_of` read either — the
 * rule `as_of` search follows for chunks (docs/design/05 §4.6).
 */

export interface CoOccurrence {
  /** One of the requested ids. */
  source: string;
  /** A live entity mentioned by a document that also mentions `source`. */
  target: string;
  /** Distinct chunks mentioning both. */
  chunks: number;
  /** Distinct documents mentioning both (a shared chunk counts for its document too). */
  documents: number;
  /** `CO_OCCURS_CHUNK_WEIGHT` per shared chunk + `CO_OCCURS_DOCUMENT_WEIGHT` per shared document. */
  weight: number;
}

export interface CoOccurrenceOptions {
  /** Only these entities may be targets (the overview wants the edges among its own nodes). */
  among?: readonly string[];
  /** Strongest targets kept per source (default `DEFAULT_PER_ENTITY`). */
  perEntity?: number;
  /** Documents read per source, most recent first (default `DEFAULT_MAX_DOCUMENTS`). */
  maxDocuments?: number;
  /** System time: count only the mentions of documents that were live then. */
  asOf?: TimeInput;
  /** Count only the mentions of documents that pass the filter. */
  filter?: ResolvedScopeFilter;
}

/**
 * Weights on the scale stored `co_occurs` evidence had (wire 0.3, tier-1 0.2,
 * concepts 0.1 per source), so `graphSearch`'s hop gain, `min(1, w / 2 + 0.5)`,
 * reads them as before: one shared chunk in one document is 0.5, a document
 * that mentions both in different chunks is 0.2, and three sources saturate.
 */
export const CO_OCCURS_CHUNK_WEIGHT = 0.3;
export const CO_OCCURS_DOCUMENT_WEIGHT = 0.2;

/**
 * A hub co-occurs with everything; the strongest neighbours are the useful
 * ones, and `graphSearch` keeps at most `limit` nodes anyway.
 */
export const DEFAULT_PER_ENTITY = 50;

/**
 * How many of a source's documents are read, most recent first. The cost of
 * the derivation is the mentions of the seeds' documents, and a hub sits in
 * thousands of documents that each mention hundreds of entities (the finance
 * workspace's top entity: 2k documents, 8k chunks). Its newest documents say
 * what it is about now, and the cap scales the cost: on a copy of that
 * workspace the ten most-mentioned entities take 0.42 s at 200 documents
 * each, 0.82 s at 400, 2.8 s unbounded (ten ordinary entities: 9 ms). Below
 * the cap the derivation is exact.
 */
export const DEFAULT_MAX_DOCUMENTS = 200;

export function coOccurrenceWeight(chunks: number, documents: number): number {
  return Number((chunks * CO_OCCURS_CHUNK_WEIGHT + documents * CO_OCCURS_DOCUMENT_WEIGHT).toFixed(4));
}

/**
 * Entities co-occurring with any of `ids`, strongest first per source id.
 * Targets are live entities (at `asOf`, when given); sources are returned as
 * passed, so a caller that expanded merge groups canonicalizes both ends.
 */
export async function coOccurringEntities(q: Queryable, ids: readonly string[], opts: CoOccurrenceOptions = {}): Promise<CoOccurrence[]> {
  const seeds = [...new Set(ids)];
  if (seeds.length === 0) return [];
  const among = opts.among ? [...new Set(opts.among)] : null;
  if (among && among.length === 0) return [];
  const perEntity = Math.max(1, Math.floor(opts.perEntity ?? DEFAULT_PER_ENTITY));
  const maxDocuments = Math.max(1, Math.floor(opts.maxDocuments ?? DEFAULT_MAX_DOCUMENTS));

  // seeds and `among` go as array parameters: graphOverview passes the web API's limit through uncapped
  const p = new Params();
  const seedPh = p.add(seeds);
  const amongCond = among ? `AND o.entity_id = ANY(${p.add(among)}::text[])` : '';
  const docCond = docLiveAt('d', p, opts.asOf, opts.filter ?? NO_FILTER);
  const maxDocs = p.add(maxDocuments);
  const targetLive = rowLiveAt('e', 'entity', p, opts.asOf);
  const lim = p.add(perEntity);
  // Everything after the seeds' recent documents is read from those documents'
  // own mention rows, fetched once by document id. Joined to entity_mentions
  // as a whole instead, the planner sorted all of it to merge on (entity,
  // document): 24 s for ten hub entities on the finance workspace's 3.7M
  // mentions, against 2 s this way.
  const rows = await q.query<{ source: string; target: string; chunks: number; documents: number }>(
    `WITH seed_docs AS (
       SELECT entity_id, document_id FROM (
         SELECT x.entity_id, x.document_id,
                row_number() OVER (PARTITION BY x.entity_id ORDER BY x.doc_date DESC NULLS LAST, x.updated_at DESC, x.document_id) AS rn
         FROM (
           SELECT DISTINCT m.entity_id, m.document_id, d.doc_date, d.updated_at
           FROM entity_mentions m
           JOIN documents d ON d.id = m.document_id
           WHERE m.entity_id = ANY(${seedPh}::text[]) AND ${docCond}
         ) x
       ) recent
       WHERE rn <= ${maxDocs}
     ),
     doc_mentions AS MATERIALIZED (
       SELECT m.document_id, m.entity_id, m.chunk_id
       FROM entity_mentions m
       WHERE m.document_id = ANY(ARRAY(SELECT DISTINCT document_id FROM seed_docs))
     ),
     seed AS (
       SELECT DISTINCT dm.entity_id, dm.chunk_id
       FROM doc_mentions dm
       JOIN seed_docs sd ON sd.document_id = dm.document_id AND sd.entity_id = dm.entity_id
     ),
     by_chunk AS (
       SELECT s.entity_id AS source, o.entity_id AS target, count(DISTINCT s.chunk_id)::int AS chunks
       FROM seed s
       JOIN doc_mentions o ON o.chunk_id = s.chunk_id AND o.entity_id <> s.entity_id ${amongCond}
       GROUP BY s.entity_id, o.entity_id
     ),
     doc_entities AS (
       SELECT DISTINCT document_id, entity_id FROM doc_mentions
     ),
     by_document AS (
       SELECT s.entity_id AS source, o.entity_id AS target, count(*)::int AS documents
       FROM seed_docs s
       JOIN doc_entities o ON o.document_id = s.document_id AND o.entity_id <> s.entity_id ${amongCond}
       GROUP BY s.entity_id, o.entity_id
     ),
     scored AS (
       SELECT bd.source, bd.target, bd.documents, COALESCE(bc.chunks, 0) AS chunks,
              COALESCE(bc.chunks, 0) * ${CO_OCCURS_CHUNK_WEIGHT} + bd.documents * ${CO_OCCURS_DOCUMENT_WEIGHT} AS weight
       FROM by_document bd
       LEFT JOIN by_chunk bc ON bc.source = bd.source AND bc.target = bd.target
       JOIN entities e ON e.id = bd.target
       WHERE ${targetLive}
     ),
     ranked AS (
       SELECT source, target, chunks, documents, row_number() OVER (PARTITION BY source ORDER BY weight DESC, target) AS rn
       FROM scored
     )
     SELECT source, target, chunks, documents FROM ranked WHERE rn <= ${lim} ORDER BY source, rn`,
    p.list,
  );
  return rows.map((r) => ({
    source: r.source,
    target: r.target,
    chunks: Number(r.chunks),
    documents: Number(r.documents),
    weight: coOccurrenceWeight(Number(r.chunks), Number(r.documents)),
  }));
}

/** The edge a derived pair is shown as: undirected, so the endpoints are ordered. */
export function coOccurrenceEdge(x: CoOccurrence): GraphEdge {
  const [source, target] = x.source < x.target ? [x.source, x.target] : [x.target, x.source];
  const n = (count: number, noun: string) => `${count} shared ${noun}${count === 1 ? '' : 's'}`;
  return {
    source,
    target,
    type: 'co_occurs',
    description: `${n(x.documents, 'document')}, ${n(x.chunks, 'chunk')}`,
    weight: x.weight,
    validFrom: null,
    validTo: null,
  };
}

/**
 * SQL predicate: the entity `idExpr` co-occurs with some other live entity —
 * a live, indexed document mentions both. What keeps a mention-only entity out
 * of the insights' isolated list.
 */
export function coOccursSql(idExpr: string): string {
  return `EXISTS (
    SELECT 1 FROM entity_mentions m
    JOIN documents d ON d.id = m.document_id AND d.status = 'indexed'
    JOIN entity_mentions o ON o.document_id = m.document_id AND o.entity_id <> m.entity_id
    JOIN entities oe ON oe.id = o.entity_id AND oe.tx_to IS NULL
    WHERE m.entity_id = ${idExpr})`;
}
