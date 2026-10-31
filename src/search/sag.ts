import { SagSearchConfig, defaultConfig } from '../config.js';
import { EmbeddingProvider } from '../ingest/embeddings.js';
import { getDocHeat, recordChunkHits } from '../stats/heat.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../store/db.js';
import { NO_FILTER, ResolvedScopeFilter, evidenceFilterSql } from '../store/resolver.js';
import { Params, TimeInput, rowLiveAt, toIso } from '../store/temporal.js';
import { SearchResult } from '../types.js';
import { SearchOptions, docLiveAt, entityMatchSql, queryTerms, search } from './search.js';

interface EntityMentionRow {
  entity_id: string;
  name: string;
  mention_count: number;
  chunk_id: string;
}

interface EntityRow {
  entity_id: string;
  name: string;
  mention_count: number;
}

interface ExpandedChunkRow {
  entity_id: string;
  entity_name: string;
  chunk_id: string;
  document_id: string;
  path: string;
  title: string | null;
  content: string;
}

interface VectorRankRow {
  chunk_id: string;
  raw: number;
}

interface Provenance {
  seedChunkId?: string;
  bridges: string[];
  hop: number;
}

interface StructuralCandidate {
  result: SearchResult;
  structuralScore: number;
  bestContribution: number;
  provenance: Provenance;
}

interface FrontierEntity {
  id: string;
  name: string;
  score: number;
  parentChunkId?: string;
}

const RRF_K = 60;

function boundedInteger(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizedConfig(override?: Partial<SagSearchConfig>): SagSearchConfig {
  const base = defaultConfig().retrieval.sag;
  const directRatio = override?.directRatio ?? base.directRatio;
  return {
    seedChunks: boundedInteger(override?.seedChunks ?? base.seedChunks, base.seedChunks, 1, 100),
    entityFrontier: boundedInteger(override?.entityFrontier ?? base.entityFrontier, base.entityFrontier, 1, 200),
    maxEventsPerEntity: boundedInteger(
      override?.maxEventsPerEntity ?? base.maxEventsPerEntity,
      base.maxEventsPerEntity,
      1,
      100,
    ),
    candidatePool: boundedInteger(override?.candidatePool ?? base.candidatePool, base.candidatePool, 1, 500),
    maxHops: boundedInteger(override?.maxHops ?? base.maxHops, base.maxHops, 1, 4),
    directRatio: Number.isFinite(directRatio) ? Math.min(1, Math.max(0, directRatio)) : base.directRatio,
  };
}

/**
 * The bipartite expansion reads entities and chunks directly, so it repeats
 * the temporal and scope predicates the direct route gets from `search`: an
 * `as_of` walk must not bridge through an entity that did not exist then, and
 * a scoped walk must not escape its sources through a shared entity.
 */
interface SagScope {
  asOf?: TimeInput;
  filter: ResolvedScopeFilter;
}

async function queryMatchedEntities(store: Store, query: string, limit: number, scope: SagScope): Promise<EntityRow[]> {
  const terms = queryTerms(query, 6);
  if (terms.length === 0) return [];
  const p = new Params();
  const named = entityMatchSql(store, 'e', terms, p);
  const asOf = toIso(scope.asOf);
  const lim = p.add(limit);
  return store.query<EntityRow>(
    `SELECT e.id AS entity_id, e.name, e.mention_count
     FROM entities e
     WHERE ${named} AND ${rowLiveAt('e', 'entity', p, asOf)}
       AND ${evidenceFilterSql('e.id', 'entity', p, scope.filter, asOf)}
     ORDER BY e.mention_count DESC, e.name ASC
     LIMIT ${lim}`,
    p.list,
  );
}

async function mentionsForChunks(store: Store, chunkIds: string[], scope: SagScope): Promise<EntityMentionRow[]> {
  if (chunkIds.length === 0) return [];
  const p = new Params();
  const placeholders = chunkIds.map((id) => p.add(id)).join(',');
  const asOf = toIso(scope.asOf);
  return store.query<EntityMentionRow>(
    `SELECT DISTINCT m.entity_id, e.name, e.mention_count, m.chunk_id
     FROM entity_mentions m
     JOIN entities e ON e.id = m.entity_id
     WHERE m.chunk_id IN (${placeholders}) AND ${rowLiveAt('e', 'entity', p, asOf)}
       AND ${evidenceFilterSql('e.id', 'entity', p, scope.filter, asOf)}`,
    p.list,
  );
}

async function expandEntities(
  store: Store,
  entities: FrontierEntity[],
  maxEventsPerEntity: number,
  scope: SagScope,
): Promise<ExpandedChunkRow[]> {
  if (entities.length === 0) return [];
  const p = new Params();
  const placeholders = entities.map((entity) => p.add(entity.id)).join(',');
  const asOf = toIso(scope.asOf);
  const docCond = docLiveAt('d', p, asOf, scope.filter);
  const rank = p.add(maxEventsPerEntity);
  return store.query<ExpandedChunkRow>(
    `WITH mentions AS (
       SELECT DISTINCT entity_id, chunk_id, document_id FROM entity_mentions WHERE entity_id IN (${placeholders})
     ), ranked AS (
       SELECT m.entity_id, e.name AS entity_name,
              c.id AS chunk_id, c.document_id, d.path, d.title, c.content,
              row_number() OVER (
                PARTITION BY m.entity_id
                ORDER BY COALESCE(ds.heat, 0) DESC, c.seq ASC
              ) AS event_rank
       FROM mentions m
       JOIN entities e ON e.id = m.entity_id
       JOIN chunks c ON c.id = m.chunk_id
       JOIN documents d ON d.id = c.document_id
       LEFT JOIN doc_stats ds ON ds.document_id = c.document_id
       WHERE ${rowLiveAt('e', 'entity', p, asOf)} AND ${docCond}
     )
     SELECT entity_id, entity_name, chunk_id, document_id, path, title, content
     FROM ranked
     WHERE event_rank <= ${rank}`,
    p.list,
  );
}

function chooseFrontierEntities(
  mentionRows: EntityMentionRow[],
  queryRows: EntityRow[],
  currentProvenance: Map<string, Provenance>,
  seenEntities: Set<string>,
  totalChunks: number,
  limit: number,
): FrontierEntity[] {
  const candidates = new Map<string, {
    id: string;
    name: string;
    mentionCount: number;
    parents: Set<string>;
    queryMatch: boolean;
  }>();

  for (const row of mentionRows) {
    const candidate = candidates.get(row.entity_id) ?? {
      id: row.entity_id,
      name: row.name,
      mentionCount: row.mention_count,
      parents: new Set<string>(),
      queryMatch: false,
    };
    candidate.parents.add(row.chunk_id);
    candidates.set(row.entity_id, candidate);
  }
  for (const row of queryRows) {
    const candidate = candidates.get(row.entity_id) ?? {
      id: row.entity_id,
      name: row.name,
      mentionCount: row.mention_count,
      parents: new Set<string>(),
      queryMatch: true,
    };
    candidate.queryMatch = true;
    candidates.set(row.entity_id, candidate);
  }

  return [...candidates.values()]
    .filter((candidate) => !seenEntities.has(candidate.id))
    .map((candidate) => {
      const mentionCount = Math.min(totalChunks, Math.max(0, candidate.mentionCount));
      const idf = Math.log((totalChunks + 1) / (mentionCount + 1)) + 1;
      const support = 1 + Math.log1p(candidate.parents.size);
      const queryBoost = candidate.queryMatch ? 2 : 0;
      const parentChunkId = [...candidate.parents]
        .sort((a, b) => (currentProvenance.get(a)?.bridges.length ?? 0) - (currentProvenance.get(b)?.bridges.length ?? 0))[0];
      return { id: candidate.id, name: candidate.name, score: idf * support + queryBoost, parentChunkId };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

async function coarseVectorRank(
  store: Store,
  queryVector: number[],
  chunkIds: string[],
): Promise<VectorRankRow[]> {
  if (chunkIds.length === 0) return [];
  const placeholders = chunkIds.map((_, i) => `$${i + 2}`).join(',');
  return store.query<VectorRankRow>(
    `SELECT e.chunk_id, 1 - (e.embedding <=> $1::${VECTOR_TYPE}) AS raw
     FROM embeddings e
     WHERE e.chunk_id IN (${placeholders})
     ORDER BY e.embedding <=> $1::${VECTOR_TYPE}`,
    [toVectorLiteral(queryVector), ...chunkIds],
  );
}

function fuseStructuralCandidates(
  candidates: StructuralCandidate[],
  vectorRows: VectorRankRow[],
): SearchResult[] {
  const vectorRanks = new Map(vectorRows.map((row, rank) => [row.chunk_id, { rank, raw: row.raw }]));
  return candidates
    .sort((a, b) => b.structuralScore - a.structuralScore)
    .map((candidate, structuralRank) => {
      const vector = vectorRanks.get(candidate.result.chunkId);
      const score = 1 / (RRF_K + structuralRank + 1) + (vector ? 1 / (RRF_K + vector.rank + 1) : 0);
      return {
        ...candidate.result,
        score,
        signals: {
          ...candidate.result.signals,
          structural: candidate.structuralScore,
          ...(vector ? { vector: vector.raw } : {}),
        },
        trace: {
          route: 'sag' as const,
          hop: candidate.provenance.hop,
          seedChunkId: candidate.provenance.seedChunkId,
          bridgeEntities: candidate.provenance.bridges,
        },
      };
    })
    .sort((a, b) => b.score - a.score);
}

function mergeRoutes(direct: SearchResult[], structural: SearchResult[], k: number, directRatio: number): SearchResult[] {
  const fused = new Map<string, SearchResult>();
  const fold = (items: SearchResult[], route: 'direct' | 'sag') => {
    items.forEach((item, rank) => {
      const contribution = 1 / (RRF_K + rank + 1);
      const previous = fused.get(item.chunkId);
      if (previous) {
        previous.score += contribution;
        previous.signals = { ...previous.signals, ...item.signals };
        if (route === 'sag') previous.trace = { ...item.trace!, route: 'both' };
      } else {
        fused.set(item.chunkId, {
          ...item,
          score: contribution,
          trace: route === 'direct' ? { route: 'direct' } : item.trace,
        });
      }
    });
  };
  fold(direct, 'direct');
  fold(structural, 'sag');

  const directQuota = Math.round(k * directRatio);
  const structuralQuota = k - directQuota;
  const selected: SearchResult[] = [];
  const selectedIds = new Set<string>();
  const add = (items: SearchResult[], quota: number) => {
    let added = 0;
    for (const item of items) {
      if (added >= quota) break;
      if (selectedIds.has(item.chunkId)) continue;
      selected.push(fused.get(item.chunkId)!);
      selectedIds.add(item.chunkId);
      added++;
    }
  };
  add(direct, directQuota);
  add(structural, structuralQuota);
  add([...fused.values()].sort((a, b) => b.score - a.score), k - selected.length);
  return selected.sort((a, b) => b.score - a.score).slice(0, k);
}

/**
 * SAG-style query-time retrieval over the existing graph schema.
 *
 * A chunk acts as an event and entity_mentions acts as the event/entity join:
 * direct chunks -> mentioned entities -> other chunks. The discovered pool is
 * vector-ranked and then fused with a reserved direct retrieval route, so
 * sparse extraction degrades to normal hybrid search instead of empty recall.
 */
export async function sagSearch(
  store: Store,
  embedder: EmbeddingProvider,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResult[]> {
  const cfg = normalizedConfig(opts.sag);
  const scope: SagScope = { asOf: opts.asOf, filter: opts.filter ?? NO_FILTER };
  const k = boundedInteger(opts.k ?? 8, 8, 1, 100);
  const [queryVector] = opts.queryVector ? [opts.queryVector] : await embedder.embed([query]);
  const direct = await search(store, embedder, query, {
    ...opts,
    k: Math.max(k, cfg.seedChunks),
    mode: 'hybrid',
    track: false,
    queryVector,
  });

  const [{ count }, queryEntities] = await Promise.all([
    store.query<{ count: number }>(`SELECT count(*)::int AS count FROM chunks`).then((rows) => rows[0] ?? { count: 0 }),
    queryMatchedEntities(store, query, cfg.entityFrontier, scope),
  ]);
  const totalChunks = Number(count) || 0;
  const seedChunkIds = direct.slice(0, cfg.seedChunks).map((result) => result.chunkId);
  const seenChunks = new Set(seedChunkIds);
  const seenEntities = new Set<string>();
  const structural = new Map<string, StructuralCandidate>();
  let frontierChunkIds = seedChunkIds;
  let frontierProvenance = new Map<string, Provenance>(
    frontierChunkIds.map((chunkId) => [chunkId, { seedChunkId: chunkId, bridges: [], hop: 0 }]),
  );

  for (let hop = 1; hop <= cfg.maxHops && (frontierChunkIds.length > 0 || hop === 1); hop++) {
    const mentionRows = await mentionsForChunks(store, frontierChunkIds, scope);
    const frontierEntities = chooseFrontierEntities(
      mentionRows,
      hop === 1 ? queryEntities : [],
      frontierProvenance,
      seenEntities,
      totalChunks,
      cfg.entityFrontier,
    );
    if (frontierEntities.length === 0) break;
    frontierEntities.forEach((entity) => seenEntities.add(entity.id));

    const entityById = new Map(frontierEntities.map((entity) => [entity.id, entity]));
    const expandedRows = await expandEntities(store, frontierEntities, cfg.maxEventsPerEntity, scope);
    const seenBeforeHop = new Set(seenChunks);
    const nextIds = new Set<string>();

    for (const row of expandedRows) {
      if (seenBeforeHop.has(row.chunk_id)) continue;
      const entity = entityById.get(row.entity_id);
      if (!entity) continue;
      const parent = entity.parentChunkId ? frontierProvenance.get(entity.parentChunkId) : undefined;
      const provenance: Provenance = {
        seedChunkId: parent?.seedChunkId ?? entity.parentChunkId,
        bridges: [...(parent?.bridges ?? []), row.entity_name],
        hop,
      };
      const contribution = entity.score * Math.pow(0.65, hop - 1);
      const previous = structural.get(row.chunk_id);
      if (previous) {
        previous.structuralScore += contribution;
        if (contribution > previous.bestContribution) {
          previous.bestContribution = contribution;
          previous.provenance = provenance;
        }
      } else {
        structural.set(row.chunk_id, {
          result: {
            chunkId: row.chunk_id,
            documentId: row.document_id,
            path: row.path,
            title: row.title,
            content: row.content,
            score: 0,
            signals: {},
          },
          structuralScore: contribution,
          bestContribution: contribution,
          provenance,
        });
      }
      nextIds.add(row.chunk_id);
    }

    nextIds.forEach((chunkId) => seenChunks.add(chunkId));
    frontierChunkIds = [...nextIds]
      .sort((a, b) => (structural.get(b)?.structuralScore ?? 0) - (structural.get(a)?.structuralScore ?? 0))
      .slice(0, cfg.seedChunks);
    frontierProvenance = new Map(
      frontierChunkIds.map((chunkId) => [chunkId, structural.get(chunkId)!.provenance]),
    );
  }

  const structuralPool = [...structural.values()]
    .sort((a, b) => b.structuralScore - a.structuralScore)
    .slice(0, cfg.candidatePool);
  const vectorRows = await coarseVectorRank(store, queryVector, structuralPool.map((item) => item.result.chunkId));
  const structuralResults = fuseStructuralCandidates(structuralPool, vectorRows);
  const results = mergeRoutes(direct, structuralResults, k, cfg.directRatio);

  const heatCfg = opts.heat ?? defaultConfig().heat;
  const heat = await getDocHeat(store, [...new Set(results.map((result) => result.documentId))], heatCfg);
  for (const result of results) {
    const value = heat.get(result.documentId);
    if (value) result.score *= 1 + heatCfg.searchWeight * value;
  }
  results.sort((a, b) => b.score - a.score);
  if (opts.track !== false) {
    await recordChunkHits(store, results.map((result) => ({ chunkId: result.chunkId, documentId: result.documentId })), heatCfg);
  }
  return results;
}
