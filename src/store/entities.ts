import { Store } from './db.js';
import { live, Params, toIso } from './temporal.js';

/**
 * The entity table behind Knowledge → Entities: one page of live entities,
 * filtered, sorted and counted by the database, with the numbers that say
 * what an entity is worth — the chunks and documents that mention it, its
 * typed relations, the evidence behind it, and which extractors wrote that
 * evidence. The remote API keeps its bare list on `listEntities`
 * (queries.ts); this is the paged read the UIs browse.
 */

export type EntitySort = 'mentions' | 'name' | 'type' | 'evidence' | 'updated' | 'created';
export type SortOrder = 'asc' | 'desc';

export interface EntityQuery {
  /** Substring of the name or an alias, case-insensitive. */
  q?: string;
  types?: string[];
  sort?: string;
  order?: string;
  offset?: number;
  limit?: number;
  /** Include entities merged into another; by default a merged group answers once, as its survivor. */
  merged?: boolean;
}

export interface EntityPageItem {
  id: string;
  name: string;
  type: string;
  description: string;
  aliases: string[];
  wikiPath: string | null;
  /** Distinct chunks that mention the entity (the fold's mention_count). */
  mentions: number;
  documents: number;
  /** Live typed relations it takes part in, from either end. */
  relations: number;
  evidence: number;
  /** Live entity evidence per extractor family (see `extractorFamily`). */
  sources: Record<string, number>;
  canonicalId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface EntityPage {
  items: EntityPageItem[];
  total: number;
  offset: number;
  limit: number;
  sort: EntitySort;
  order: SortOrder;
  /** Live entities per type under the same `merged` setting, before the type and text filters. */
  typeCounts: { type: string; n: number }[];
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const MAX_TYPES = 20;

/** Sort columns, each with the order it reads best in: counts and dates largest first, names and types A to Z. */
const SORTS: Record<EntitySort, { column: string; order: SortOrder }> = {
  mentions: { column: 'e.mention_count', order: 'desc' },
  name: { column: 'e.name', order: 'asc' },
  type: { column: 'e.type', order: 'asc' },
  evidence: { column: 'e.evidence_count', order: 'desc' },
  updated: { column: 'e.updated_at', order: 'desc' },
  created: { column: 'e.created_at', order: 'desc' },
};

/**
 * The family an extractor label belongs to, as the table names it. Families
 * carry no underscore: the Mac client's decoder rewrites snake_case keys,
 * dictionary keys included.
 */
export function extractorFamily(extractor: string): string {
  if (extractor === 'tier0.concept') return 'mined';
  if (extractor === 'tier0.link') return 'link';
  if (extractor === 'tier0.wikilink') return 'wikilink';
  if (extractor === 'tier0.frontmatter') return 'frontmatter';
  if (extractor === 'tier0.mindmap') return 'mindmap';
  if (extractor.startsWith('tier1.llm')) return 'llm';
  if (extractor === 'human' || extractor === 'datasource') return extractor;
  if (extractor.startsWith('probe.')) return 'probe';
  return 'other';
}

/** `%`, `_` and the escape itself as literal characters of a LIKE pattern. */
export function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (m) => `\\${m}`);
}

interface Row {
  id: string;
  name: string;
  type: string;
  description: string;
  aliases: unknown;
  wiki_path: string | null;
  mention_count: number;
  evidence_count: number;
  canonical_id: string | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
}

export async function queryEntities(store: Store, q: EntityQuery = {}): Promise<EntityPage> {
  const sort: EntitySort = q.sort !== undefined && q.sort in SORTS ? (q.sort as EntitySort) : 'mentions';
  const order: SortOrder = q.order === 'asc' || q.order === 'desc' ? q.order : SORTS[sort].order;
  const limit = Math.min(Math.max(Math.floor(Number(q.limit)) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(Math.floor(Number(q.offset)) || 0, 0);

  const p = new Params();
  const where = [live('e', p)];
  if (!q.merged) where.push('e.canonical_id IS NULL');
  // the type counts describe the table before the type and text filters narrow it
  const scope = where.join(' AND ');
  const types = (q.types ?? []).map((t) => t.trim()).filter(Boolean).slice(0, MAX_TYPES);
  if (types.length) where.push(`e.type IN (${types.map((t) => p.add(t)).join(',')})`);
  const text = q.q?.trim();
  if (text) {
    const like = p.add(`%${likeEscape(text)}%`);
    where.push(`(e.name ILIKE ${like} OR e.aliases::text ILIKE ${like})`);
  }
  const cond = where.join(' AND ');

  const [{ n: total }] = await store.query<{ n: number }>(`SELECT count(*)::int AS n FROM entities e WHERE ${cond}`, [...p.list]);
  // name and id break ties, so equal counts page without repeats or gaps
  const rows = await store.query<Row>(
    `SELECT e.id, e.name, e.type, e.description, e.aliases, e.wiki_path, e.mention_count, e.evidence_count, e.canonical_id, e.created_at, e.updated_at
     FROM entities e
     WHERE ${cond}
     ORDER BY ${SORTS[sort].column} ${order === 'asc' ? 'ASC' : 'DESC'}, e.name ASC, e.id ASC
     LIMIT ${p.add(limit)} OFFSET ${p.add(offset)}`,
    p.list,
  );
  const ids = rows.map((r) => r.id);
  const [degrees, documents, sources, typeCounts] = await Promise.all([
    typedDegrees(store, ids),
    documentCounts(store, ids),
    sourceCounts(store, ids),
    store.query<{ type: string; n: number }>(`SELECT e.type, count(*)::int AS n FROM entities e WHERE ${scope} GROUP BY e.type ORDER BY n DESC, e.type ASC`),
  ]);
  return {
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      description: r.description ?? '',
      aliases: Array.isArray(r.aliases) ? r.aliases.map(String) : [],
      wikiPath: r.wiki_path ?? null,
      mentions: r.mention_count,
      documents: documents.get(r.id) ?? 0,
      relations: degrees.get(r.id) ?? 0,
      evidence: r.evidence_count ?? 0,
      sources: sources.get(r.id) ?? {},
      canonicalId: r.canonical_id ?? null,
      createdAt: toIso(r.created_at),
      updatedAt: toIso(r.updated_at),
    })),
    total,
    offset,
    limit,
    sort,
    order,
    typeCounts,
  };
}

/**
 * Live typed relations per entity, counted from either end. Two scans, one
 * per endpoint index, instead of the OR join `graphInsights` affords for its
 * top ten: a page asks for hundreds of ids at once.
 */
export async function typedDegrees(store: Store, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await store.query<{ id: string; n: number }>(
    `SELECT id, count(*)::int AS n FROM (
       SELECT r.source_id AS id FROM relations r WHERE r.tx_to IS NULL AND r.type <> 'co_occurs' AND r.source_id = ANY($1::text[])
       UNION ALL
       SELECT r.target_id AS id FROM relations r WHERE r.tx_to IS NULL AND r.type <> 'co_occurs' AND r.target_id = ANY($1::text[])
     ) d GROUP BY id`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id, r.n]));
}

async function documentCounts(store: Store, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await store.query<{ id: string; n: number }>(
    `SELECT entity_id AS id, count(DISTINCT document_id)::int AS n FROM entity_mentions WHERE entity_id = ANY($1::text[]) GROUP BY entity_id`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id, r.n]));
}

async function sourceCounts(store: Store, ids: string[]): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>();
  if (ids.length === 0) return out;
  const rows = await store.query<{ id: string; extractor: string; n: number }>(
    `SELECT target_id AS id, extractor, count(*)::int AS n FROM evidence
     WHERE kind = 'entity' AND tx_to IS NULL AND target_id = ANY($1::text[])
     GROUP BY target_id, extractor`,
    [ids],
  );
  for (const r of rows) {
    const family = extractorFamily(r.extractor);
    const counts = out.get(r.id) ?? out.set(r.id, {}).get(r.id)!;
    counts[family] = (counts[family] ?? 0) + r.n;
  }
  return out;
}
