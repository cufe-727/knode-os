import { Store } from '../store/db.js';
import { EntityRow, GraphEdge, GraphNode, GraphSearchResult, RelationRow, SearchResult } from '../types.js';

/**
 * Graph search: seed entities matched by name/alias/description, then BFS
 * expansion over relations with per-hop decay (llm_wiki's multi-signal idea,
 * simplified: edge weight × hop decay). Returns a scored subgraph plus the
 * chunks where the entities are grounded.
 */
export async function graphSearch(
  store: Store,
  query: string,
  opts: { depth?: number; limit?: number; chunkLimit?: number } = {},
): Promise<GraphSearchResult> {
  const depth = Math.min(opts.depth ?? 2, 4);
  const limit = opts.limit ?? 30;
  const chunkLimit = opts.chunkLimit ?? 8;

  const terms = query.split(/\s+/).filter(Boolean).slice(0, 6);
  if (terms.length === 0) return { nodes: [], edges: [], chunks: [] };
  const conds = terms
    .map((_, i) => `(name ILIKE $${i + 1} OR aliases::text ILIKE $${i + 1} OR description ILIKE $${i + 1})`)
    .join(' OR ');
  const seeds = await store.query<EntityRow>(
    `SELECT * FROM entities WHERE ${conds} ORDER BY mention_count DESC LIMIT 10`,
    terms.map((t) => `%${t}%`),
  );

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
    if (frontier.length === 0) break;
    const placeholders = frontier.map((_, i) => `$${i + 1}`).join(',');
    const rels = await store.query<RelationRow & { weight: number }>(
      `SELECT * FROM relations WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
      frontier,
    );
    const next = new Set<string>();
    for (const r of rels) {
      const edgeKey = r.id;
      if (!edges.has(edgeKey)) {
        edges.set(edgeKey, { source: r.source_id, target: r.target_id, type: r.type, description: r.description, weight: r.weight });
      }
      for (const [from, to] of [[r.source_id, r.target_id], [r.target_id, r.source_id]] as const) {
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
      const ph = ids.map((_, i) => `$${i + 1}`).join(',');
      const rows = await store.query<EntityRow>(`SELECT * FROM entities WHERE id IN (${ph})`, ids);
      for (const row of rows) nodeById.set(row.id, row);
    }
    frontier = ids;
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
    const ph = topIds.map((_, i) => `$${i + 1}`).join(',');
    const rows = await store.query<{ chunk_id: string; document_id: string; path: string; title: string | null; content: string; hits: number }>(
      `SELECT c.id AS chunk_id, c.document_id, d.path, d.title, c.content, count(*)::int AS hits
       FROM entity_mentions m
       JOIN chunks c ON c.id = m.chunk_id
       JOIN documents d ON d.id = c.document_id
       WHERE m.entity_id IN (${ph})
       GROUP BY c.id, c.document_id, d.path, d.title, c.content
       ORDER BY hits DESC
       LIMIT $${topIds.length + 1}`,
      [...topIds, chunkLimit],
    );
    for (const r of rows) {
      chunks.push({
        chunkId: r.chunk_id, documentId: r.document_id, path: r.path, title: r.title,
        content: r.content, score: r.hits, signals: { graph: r.hits },
      });
    }
  }

  return { nodes, edges: keptEdges, chunks };
}

/** Whole-graph overview for visualization (top-N entities by mentions + edges among them). */
export async function graphOverview(store: Store, limit = 120): Promise<GraphSearchResult> {
  const ents = await store.query<EntityRow>(
    `SELECT * FROM entities ORDER BY mention_count DESC, updated_at DESC LIMIT $1`,
    [limit],
  );
  if (ents.length === 0) return { nodes: [], edges: [], chunks: [] };
  const ids = ents.map((e) => e.id);
  const ph = ids.map((_, i) => `$${i + 1}`).join(',');
  const rels = await store.query<RelationRow>(
    `SELECT * FROM relations WHERE source_id IN (${ph}) AND target_id IN (${ph})`,
    ids,
  );
  return {
    nodes: ents.map((e) => ({ id: e.id, name: e.name, type: e.type, description: e.description, score: e.mention_count, mentionCount: e.mention_count })),
    edges: rels.map((r) => ({ source: r.source_id, target: r.target_id, type: r.type, description: r.description, weight: r.weight })),
    chunks: [],
  };
}

export interface GraphInsights {
  totals: { entities: number; relations: number; mentions: number };
  hubs: { id: string; name: string; degree: number }[];
  isolated: { id: string; name: string }[];
  typeCounts: { type: string; n: number }[];
}

/** Simple graph health insights (llm_wiki's "Graph Insights" idea, minimal version). */
export async function graphInsights(store: Store): Promise<GraphInsights> {
  const [tot] = await store.query<{ entities: number; relations: number; mentions: number }>(
    `SELECT (SELECT count(*)::int FROM entities) AS entities,
            (SELECT count(*)::int FROM relations) AS relations,
            (SELECT count(*)::int FROM entity_mentions) AS mentions`,
  );
  const hubs = await store.query<{ id: string; name: string; degree: number }>(
    `SELECT e.id, e.name, count(r.*)::int AS degree
     FROM entities e
     JOIN relations r ON r.source_id = e.id OR r.target_id = e.id
     GROUP BY e.id, e.name ORDER BY degree DESC LIMIT 10`,
  );
  const isolated = await store.query<{ id: string; name: string }>(
    `SELECT e.id, e.name FROM entities e
     WHERE NOT EXISTS (SELECT 1 FROM relations r WHERE r.source_id = e.id OR r.target_id = e.id)
     ORDER BY e.mention_count DESC LIMIT 20`,
  );
  const typeCounts = await store.query<{ type: string; n: number }>(
    `SELECT type, count(*)::int AS n FROM entities GROUP BY type ORDER BY n DESC`,
  );
  return { totals: tot, hubs, isolated, typeCounts };
}
