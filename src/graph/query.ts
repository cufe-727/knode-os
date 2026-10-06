import { HeatConfig } from '../config.js';
import { docLiveAt, queryTerms } from '../search/search.js';
import { recordChunkHits } from '../stats/heat.js';
import { Store } from '../store/db.js';
import {
  NO_FILTER,
  ResolvedScopeFilter,
  ResolvedTemporal,
  evidenceFilterSql,
  idsPassingFilter,
  overlapsValidWindow,
  resolveTemporal,
  validOverlap,
} from '../store/resolver.js';
import {
  claimsAsOf,
  entitiesAsOf,
  live,
  Params,
  relationsAsOf,
  rowLiveAt,
  Temporal,
  toDateString,
} from '../store/temporal.js';
import { ClaimItem, EntityRow, GraphEdge, GraphNode, GraphSearchResult, RelationRow, SearchResult } from '../types.js';
import { canonicalMap, expandGroups } from './resolve.js';

/**
 * Scope of a graph read: which times to answer from, and which sources may
 * contribute. `temporal` wins when both it and the loose `asOf` / `validAt`
 * shorthand are present — surfaces resolve once and pass the envelope down.
 */
export type GraphScope = Temporal & {
  temporal?: ResolvedTemporal;
  filter?: ResolvedScopeFilter;
};

function scopeOf(opts: GraphScope): { t: ResolvedTemporal; f: ResolvedScopeFilter } {
  return {
    t: opts.temporal ?? resolveTemporal({ asOf: opts.asOf, validAt: opts.validAt }),
    f: opts.filter ?? NO_FILTER,
  };
}

/**
 * Claims whose subject is one of the given entities, projected for display.
 * The world-time window (`valid_at` / `valid_range`) filters by when the fact
 * is asserted to hold; `as_of` filters by what the knowledge base believed
 * then — recomputed from evidence, since the aggregate columns only hold the
 * current state. `filter` restricts which sources may support a claim.
 */
export async function claimsForEntities(store: Store, subjectIds: string[], limit = 12, opts: GraphScope = {}): Promise<ClaimItem[]> {
  if (subjectIds.length === 0) return [];
  // claims about an entity merged into one of the subjects belong to the survivor
  const entityIds = await expandGroups(store, subjectIds);
  const { t, f } = scopeOf(opts);
  const asOf = t.txTime;
  if (asOf) {
    const rows = await claimsAsOf(store, entityIds, asOf);
    const allowed = await idsPassingFilter(store, 'claim', rows.map((c) => c.id), f, asOf);
    const filtered = rows.filter((c) => allowed.has(c.id) && overlapsValidWindow(c, t));
    const ids = [...new Set([...filtered.map((c) => c.subject_id), ...filtered.map((c) => c.object_id).filter((x): x is string => Boolean(x))])];
    const names = new Map((await entitiesAsOf(store, ids, asOf)).map((e) => [e.id, e.name]));
    const scopeIds = [...new Set(filtered.map((c) => c.primary_scope_id).filter((x): x is string => Boolean(x)))];
    const paths = await scopeKeys(store, scopeIds);
    return filtered.slice(0, limit).map((c) => ({
      id: c.id,
      subject: names.get(c.subject_id) ?? c.subject_id,
      object: c.object_id ? names.get(c.object_id) ?? c.object_id : null,
      type: c.type,
      statement: c.statement,
      status: c.status,
      startDate: toDateString(c.valid_from),
      endDate: toDateString(c.valid_to),
      eventDate: toDateString(c.event_at),
      path: c.primary_scope_id ? paths.get(c.primary_scope_id) ?? null : null,
      evidenceCount: c.evidence_count,
    }));
  }
  const p = new Params();
  const ph = entityIds.map((id) => p.add(id)).join(',');
  const lim = p.add(limit);
  const rows = await store.query<{
    id: string; subject: string; object: string | null; type: string; statement: string;
    status: string; valid_from: string | null; valid_to: string | null; event_at: string | null; path: string | null; evidence_count: number;
  }>(
    `SELECT cl.id, se.name AS subject, oe.name AS object, cl.type, cl.statement, cl.status,
            cl.valid_from, cl.valid_to, cl.event_at, s.key AS path, cl.evidence_count
     FROM claims cl
     JOIN entities se ON se.id = cl.subject_id
     LEFT JOIN entities oe ON oe.id = cl.object_id
     LEFT JOIN scopes s ON s.id = cl.primary_scope_id
     WHERE cl.subject_id IN (${ph}) AND ${live('cl', p)} AND ${validOverlap('cl', p, t)} AND cl.superseded_by IS NULL AND cl.canonical_id IS NULL
       AND ${evidenceFilterSql('cl.id', 'claim', p, f, null)}
     ORDER BY cl.tx_from DESC
     LIMIT ${lim}`,
    p.list,
  );
  return rows.map((r) => ({
    id: r.id, subject: r.subject, object: r.object, type: r.type, statement: r.statement,
    status: r.status, startDate: toDateString(r.valid_from), endDate: toDateString(r.valid_to), eventDate: toDateString(r.event_at), path: r.path,
    evidenceCount: r.evidence_count,
  }));
}

async function scopeKeys(store: Store, scopeIds: string[]): Promise<Map<string, string>> {
  if (scopeIds.length === 0) return new Map();
  const p = new Params();
  const ph = scopeIds.map((id) => p.add(id)).join(',');
  const rows = await store.query<{ id: string; key: string }>(`SELECT id, key FROM scopes WHERE id IN (${ph})`, p.list);
  return new Map(rows.map((r) => [r.id, r.key]));
}

/**
 * Graph search: seed entities matched by name/alias/description, then BFS
 * expansion over relations with per-hop decay (llm_wiki's multi-signal idea,
 * simplified: edge weight × hop decay). Returns a scored subgraph plus the
 * chunks where the entities are grounded. With `asOf`, nodes and edges are
 * recomputed from evidence as of that system time; `filter` restricts both the
 * seed entities and the grounding chunks to the requested sources.
 */
export async function graphSearch(
  store: Store,
  query: string,
  opts: { depth?: number; limit?: number; chunkLimit?: number; heat?: HeatConfig; track?: boolean } & GraphScope = {},
): Promise<GraphSearchResult> {
  const depth = Math.min(opts.depth ?? 2, 4);
  const limit = opts.limit ?? 30;
  const chunkLimit = opts.chunkLimit ?? 8;
  const { t, f } = scopeOf(opts);
  const asOf = t.txTime;

  const terms = queryTerms(query, 6);
  if (terms.length === 0) return { nodes: [], edges: [], chunks: [] };
  const p = new Params();
  const conds = terms
    .map((term) => {
      const ph = p.add(`%${term}%`);
      return `(name ILIKE ${ph} OR aliases::text ILIKE ${ph} OR description ILIKE ${ph})`;
    })
    .join(' OR ');
  const liveCond = rowLiveAt('e', 'entity', p, asOf);
  let seeds = await store.query<EntityRow>(
    `SELECT * FROM entities e
     WHERE (${conds}) AND ${liveCond} AND ${evidenceFilterSql('e.id', 'entity', p, f, asOf)}
     ORDER BY mention_count DESC LIMIT 10`,
    p.list,
  );
  if (asOf) seeds = await asOfRows(store, seeds.map((seed) => seed.id), asOf, seeds);
  seeds = await canonicalSeeds(store, seeds, asOf);

  const score = new Map<string, number>();
  const nodeById = new Map<string, EntityRow>();
  for (const s of seeds) {
    // exact-name match scores above fuzzy
    const exact = terms.some((t) => s.name.toLowerCase() === t.toLowerCase());
    score.set(s.id, exact ? 2.0 : 1.0);
    nodeById.set(s.id, s);
  }

  const edges = new Map<string, GraphEdge>();
  let frontier = [...score.keys()];
  const HOP_DECAY = 0.5;

  for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
    // a merged entity's edges count for its survivor: expand the frontier to whole merge groups
    const frontierAll = await expandGroups(store, frontier);
    const rels = asOf
      ? (await relationsAsOf(store, frontierAll, asOf)).filter((r) => overlapsValidWindow(r, t))
      : await (async () => {
          const rp = new Params();
          const placeholders = frontierAll.map((id) => rp.add(id)).join(',');
          return store.query<RelationRow>(
            `SELECT * FROM relations r WHERE (source_id IN (${placeholders}) OR target_id IN (${placeholders})) AND ${live('r', rp)} AND ${validOverlap('r', rp, t)}`,
            rp.list,
          );
        })();
    const canon = await canonicalMap(store, rels.flatMap((r) => [r.source_id, r.target_id]));
    const c = (id: string) => canon.get(id) ?? id;
    const next = new Set<string>();
    for (const r of rels) {
      const sId = c(r.source_id);
      const tId = c(r.target_id);
      if (sId === tId) continue;
      const key = `${sId}|${r.type}|${tId}`;
      const existing = edges.get(key);
      if (existing) existing.weight = Number((existing.weight + r.weight).toFixed(4));
      else {
        edges.set(key, {
          source: sId, target: tId, type: r.type, description: r.description, weight: r.weight,
          validFrom: toDateString(r.valid_from ?? null), validTo: toDateString(r.valid_to ?? null),
        });
      }
      for (const [from, to] of [[sId, tId], [tId, sId]] as const) {
        const base = score.get(from);
        if (base === undefined) continue;
        const gain = base * HOP_DECAY * Math.min(1, r.weight / 2 + 0.5) * (r.type === 'co_occurs' ? 0.5 : 1);
        const prev = score.get(to) ?? 0;
        if (gain > prev) {
          score.set(to, gain);
          if (!nodeById.has(to)) next.add(to);
        }
      }
    }
    const ids = [...next];
    if (ids.length > 0) {
      const allowed = await idsPassingFilter(store, 'entity', ids, f, asOf);
      const wanted = ids.filter((id) => allowed.has(id));
      const rows = asOf ? await asOfRows(store, wanted, asOf) : await liveRows(store, wanted);
      for (const row of rows) nodeById.set(row.id, row);
      // entities not live then, or outside the requested sources, are unreachable
      for (const id of ids) if (!nodeById.has(id)) score.delete(id);
    }
    frontier = ids.filter((id) => nodeById.has(id));
  }

  const nodes: GraphNode[] = [...nodeById.values()]
    .map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      description: e.description,
      score: score.get(e.id) ?? 0,
      mentionCount: e.mention_count,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const keep = new Set(nodes.map((n) => n.id));
  const keptEdges = [...edges.values()].filter((e) => keep.has(e.source) && keep.has(e.target));

  // ground the subgraph in source chunks (highest-scored entities first)
  const chunks: SearchResult[] = [];
  const topIds = nodes.slice(0, 6).map((n) => n.id);
  if (topIds.length > 0) {
    const cp = new Params();
    const ph = topIds.map((id) => cp.add(id)).join(',');
    const docCond = docLiveAt('d', cp, asOf, f);
    const clim = cp.add(chunkLimit);
    const rows = await store.query<{ chunk_id: string; document_id: string; path: string; title: string | null; content: string; hits: number }>(
      `SELECT c.id AS chunk_id, c.document_id, d.path, d.title, c.content, count(DISTINCT m.entity_id)::int AS hits
       FROM entity_mentions m
       JOIN chunks c ON c.id = m.chunk_id
       JOIN documents d ON d.id = c.document_id
       WHERE m.entity_id IN (${ph}) AND ${docCond}
       GROUP BY c.id, c.document_id, d.path, d.title, c.content
       ORDER BY hits DESC
       LIMIT ${clim}`,
      cp.list,
    );
    for (const r of rows) {
      chunks.push({
        chunkId: r.chunk_id, documentId: r.document_id, path: r.path, title: r.title,
        content: r.content, score: r.hits, signals: { graph: r.hits },
      });
    }
  }

  if (opts.track !== false && chunks.length > 0) {
    await recordChunkHits(store, chunks.map((c) => ({ chunkId: c.chunkId, documentId: c.documentId })), opts.heat);
  }

  const claims = await claimsForEntities(store, nodes.slice(0, 6).map((n) => n.id), 12, { temporal: t, filter: f });

  return { nodes, edges: keptEdges, chunks, claims };
}

/** Replace seeds that were merged into another entity with the survivor's row (deduplicated). */
async function canonicalSeeds(store: Store, seeds: EntityRow[], asOf: string | null): Promise<EntityRow[]> {
  const canon = await canonicalMap(store, seeds.map((s) => s.id));
  if (canon.size === 0) return seeds;
  const targets = [...new Set(canon.values())].filter((id) => !seeds.some((s) => s.id === id));
  const extra = targets.length ? (asOf ? await asOfRows(store, targets, asOf) : await liveRows(store, targets)) : [];
  const byId = new Map<string, EntityRow>();
  for (const s of [...seeds.filter((s) => !canon.has(s.id)), ...extra]) if (!byId.has(s.id)) byId.set(s.id, s);
  return [...byId.values()];
}

async function liveRows(store: Store, ids: string[]): Promise<EntityRow[]> {
  if (ids.length === 0) return [];
  const p = new Params();
  const ph = ids.map((id) => p.add(id)).join(',');
  return store.query<EntityRow>(`SELECT * FROM entities e WHERE id IN (${ph}) AND ${live('e', p)}`, p.list);
}

/** Entity rows as they were at `asOf` (falls back to the current row for wiki_path). */
async function asOfRows(store: Store, ids: string[], asOf: string, fallback: EntityRow[] = []): Promise<EntityRow[]> {
  const rows = await entitiesAsOf(store, ids, asOf);
  const wiki = new Map(fallback.map((f) => [f.id, f.wiki_path]));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    description: r.description,
    aliases: r.aliases,
    wiki_path: r.wiki_path ?? wiki.get(r.id) ?? null,
    mention_count: r.mention_count,
  }));
}

/** Whole-graph overview for visualization (top-N live entities by mentions + edges among them). */
export async function graphOverview(store: Store, limit = 120): Promise<GraphSearchResult> {
  const ents = await store.query<EntityRow>(
    `SELECT * FROM entities WHERE tx_to IS NULL ORDER BY mention_count DESC, updated_at DESC LIMIT $1`,
    [limit],
  );
  if (ents.length === 0) return { nodes: [], edges: [], chunks: [] };
  const ids = ents.map((e) => e.id);
  const ph = ids.map((_, i) => `$${i + 1}`).join(',');
  const rels = await store.query<RelationRow>(
    `SELECT * FROM relations WHERE source_id IN (${ph}) AND target_id IN (${ph}) AND tx_to IS NULL`,
    ids,
  );
  return {
    nodes: ents.map((e) => ({ id: e.id, name: e.name, type: e.type, description: e.description, score: e.mention_count, mentionCount: e.mention_count })),
    edges: rels.map((r) => ({ source: r.source_id, target: r.target_id, type: r.type, description: r.description, weight: r.weight, validFrom: toDateString(r.valid_from ?? null), validTo: toDateString(r.valid_to ?? null) })),
    chunks: [],
  };
}

export interface GraphInsights {
  totals: { entities: number; relations: number; mentions: number; tombstoned: number };
  hubs: { id: string; name: string; degree: number }[];
  isolated: { id: string; name: string }[];
  typeCounts: { type: string; n: number }[];
  relationTypeCounts: { type: string; n: number }[];
  /** Predicate spellings that matched nothing in the ontology (stored as related_to); a hint to extend a pack. */
  unknownPredicates: { raw: string; n: number }[];
  /** Entities folded into a survivor, and merge proposals awaiting a decision. */
  merged: number;
  mergeCandidates: number;
}

/** Simple graph health insights (llm_wiki's "Graph Insights" idea, minimal version). */
export async function graphInsights(store: Store): Promise<GraphInsights> {
  const [tot] = await store.query<{ entities: number; relations: number; mentions: number; tombstoned: number }>(
    `SELECT (SELECT count(*)::int FROM entities WHERE tx_to IS NULL) AS entities,
            (SELECT count(*)::int FROM relations WHERE tx_to IS NULL) AS relations,
            (SELECT count(*)::int FROM entity_mentions) AS mentions,
            (SELECT count(*)::int FROM entities WHERE tx_to IS NOT NULL) AS tombstoned`,
  );
  const hubs = await store.query<{ id: string; name: string; degree: number }>(
    `SELECT e.id, e.name, count(r.*)::int AS degree
     FROM entities e
     JOIN relations r ON (r.source_id = e.id OR r.target_id = e.id) AND r.tx_to IS NULL
     WHERE e.tx_to IS NULL
     GROUP BY e.id, e.name ORDER BY degree DESC LIMIT 10`,
  );
  const isolated = await store.query<{ id: string; name: string }>(
    `SELECT e.id, e.name FROM entities e
     WHERE e.tx_to IS NULL AND NOT EXISTS (SELECT 1 FROM relations r WHERE (r.source_id = e.id OR r.target_id = e.id) AND r.tx_to IS NULL)
     ORDER BY e.mention_count DESC LIMIT 20`,
  );
  const typeCounts = await store.query<{ type: string; n: number }>(
    `SELECT type, count(*)::int AS n FROM entities WHERE tx_to IS NULL GROUP BY type ORDER BY n DESC`,
  );
  const relationTypeCounts = await store.query<{ type: string; n: number }>(
    `SELECT type, count(*)::int AS n FROM relations WHERE tx_to IS NULL GROUP BY type ORDER BY n DESC`,
  );
  const unknownPredicates = await store.query<{ raw: string; n: number }>(
    `SELECT attrs ->> 'raw_type' AS raw, count(*)::int AS n FROM evidence
     WHERE kind = 'relation' AND tx_to IS NULL AND attrs ? 'raw_type'
     GROUP BY attrs ->> 'raw_type' ORDER BY n DESC LIMIT 20`,
  );
  const [merges] = await store.query<{ merged: number; candidates: number }>(
    `SELECT (SELECT count(*)::int FROM entities WHERE tx_to IS NULL AND canonical_id IS NOT NULL) AS merged,
            (SELECT count(*)::int FROM suggestions WHERE kind = 'merge' AND status = 'pending') AS candidates`,
  );
  return { totals: tot, hubs, isolated, typeCounts, relationTypeCounts, unknownPredicates, merged: merges?.merged ?? 0, mergeCandidates: merges?.candidates ?? 0 };
}
