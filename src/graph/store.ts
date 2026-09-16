import crypto from 'node:crypto';
import { Queryable } from '../store/migrations.js';

/**
 * Graph vocabulary, identity rules and read helpers. Writes go through the
 * lineage runtime (src/lineage/writer.ts): every entity / relation / claim
 * row is a shared, content-addressed aggregate and each source contributes
 * `evidence` rows that the fold turns into the visible columns.
 */

export interface ExtractedEntity {
  name: string;
  type: string;
  description?: string;
  aliases?: string[];
  /** Name of a known entity this one is the same as (extraction-time linking); resolved before an id is assigned. */
  sameAs?: string | null;
}

export interface ExtractedRelation {
  source: string;
  target: string;
  /** Predicate spelling; normalized against the ontology on write (synonyms, inverse readings). */
  type: string;
  description?: string;
  /** World-time window the edge holds for, when the source states one. */
  validFrom?: string | null;
  validTo?: string | null;
}

/**
 * Time-bound factual assertion about an entity (GraphRAG's covariate/claim).
 * Unlike relations (structural graph edges), claims are citable statements
 * with a truth status and optional validity period.
 */
export interface ExtractedClaim {
  subject: string;
  object?: string | null;
  type: string;
  statement: string;
  status: 'fact' | 'suspected' | 'disputed' | 'absent';
  startDate?: string | null;
  endDate?: string | null;
  /** When the asserted event happened, if the statement is about a dated event. */
  eventDate?: string | null;
}

/** A document being wired into the graph: identity plus its indexed chunks. */
export interface PageContext {
  documentId: string;
  path: string;
  title: string;
  chunkIds: { id: string; content: string }[];
}

export const ENTITY_TYPES = ['person', 'organization', 'product', 'project', 'component', 'technology', 'concept', 'event', 'location', 'datasource', 'dataset', 'other'];
export const RELATION_TYPES = ['related_to', 'part_of', 'uses', 'depends_on', 'works_at', 'authored', 'mentions', 'links_to', 'co_occurs', 'stored_in', 'appears_in'];
/**
 * `absent` is negative knowledge: a lookup that came back empty, recorded so
 * the same empty query is not re-run every session. It carries a validity
 * window like any other claim — "nothing there" is true of a moment, not
 * forever.
 */
export const CLAIM_STATUS = ['fact', 'suspected', 'disputed', 'absent'] as const;

export function slugify(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[\s/\\]+/g, '-')
    .replace(/[^\p{L}\p{N}\-_.]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return s || 'entity-' + crypto.createHash('md5').update(name).digest('hex').slice(0, 8);
}

/** Relation identity is document-independent: the same edge asserted by many sources is one row. */
export function relationId(sourceId: string, type: string, targetId: string): string {
  return crypto.createHash('sha256').update(`${sourceId}|${type}|${targetId}`).digest('hex').slice(0, 24);
}

/** Claim identity: subject + normalized statement (NFKC, trimmed, whitespace-collapsed). */
export function claimId(subjectId: string, statement: string): string {
  const normalized = statement.normalize('NFKC').trim().replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(`${subjectId}|${normalized}`).digest('hex').slice(0, 24);
}

/**
 * Resolve a raw value (e.g. a ticker symbol sampled from a live table) to a
 * live entity by exact name or alias — so `daily_quotes.symbol = "300750"`
 * links to the 宁德时代 entity instead of spawning a duplicate node.
 */
export async function resolveEntityIdByNameOrAlias(q: Queryable, value: string): Promise<string | null> {
  const v = value.trim();
  if (!v) return null;
  const byName = await q.query<{ id: string }>(
    `SELECT id FROM entities WHERE lower(name) = lower($1) AND tx_to IS NULL ORDER BY mention_count DESC LIMIT 1`,
    [v],
  );
  if (byName[0]) return byName[0].id;
  const byAlias = await q.query<{ id: string }>(
    `SELECT e.id FROM entities e, jsonb_array_elements_text(e.aliases) a(alias)
     WHERE lower(a.alias) = lower($1) AND e.tx_to IS NULL ORDER BY e.mention_count DESC LIMIT 1`,
    [v],
  );
  return byAlias[0]?.id ?? null;
}
