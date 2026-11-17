import { SagSearchConfig, defaultConfig } from '../config.js';
import { EmbeddingProvider } from '../ingest/embeddings.js';
import { boostByHeat, recordChunkHits } from '../stats/heat.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../store/db.js';
import { NO_FILTER, ResolvedScopeFilter, evidenceFilterSql } from '../store/resolver.js';
import { Params, TimeInput, rowLiveAt, toIso } from '../store/temporal.js';
import { SearchResult } from '../types.js';
import { BridgeCandidate, lexicalBridge } from './bridge.js';
import { GENERATED_SHARE, SearchOptions, SearchResults, docLiveAt, entityMatchSql, generatedPlaces, markedPartial, queryTerms, search, sidesOf } from './search.js';

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
  generated: boolean;
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

function normalizedConfig(override?: Partial<SagSearchConfig>): Required<SagSearchConfig> {
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
    bridgeTerms: boundedInteger(override?.bridgeTerms ?? base.bridgeTerms ?? 0, 0, 0, 40),
    bridgePool: boundedInteger(override?.bridgePool ?? base.bridgePool ?? 50, 50, 1, 200),
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
  seenChunks: Set<string>,
  scope: SagScope,
): Promise<ExpandedChunkRow[]> {
  if (entities.length === 0) return [];
  const p = new Params();
  const ids = p.add(entities.map((entity) => entity.id));
  const scores = p.add(entities.map((entity) => entity.score));
  const seen = p.add([...seenChunks]);
  const asOf = toIso(scope.asOf);
  const docCond = docLiveAt('d', p, asOf, scope.filter);
  const sides = await sidesOf(store);
  const rank = p.add(maxEventsPerEntity);
  // An entity with more unseen chunks than the cap keeps those where the most
  // of this hop's entities meet — by the summed scores of the frontier
  // entities a chunk mentions, the structural score it would earn uncut —
  // newest first among equals. Usage heat stays out: it would hand every walk
  // through a busy entity the same documents, and each pick made them hotter.
  return store.query<ExpandedChunkRow>(
    `WITH frontier AS (
       SELECT * FROM unnest(${ids}::text[], ${scores}::float8[]) AS f(entity_id, score)
     ), mentions AS (
       SELECT DISTINCT m.entity_id, m.chunk_id FROM entity_mentions m
       WHERE m.entity_id = ANY(${ids}::text[]) AND m.chunk_id <> ALL(${seen}::text[])
     ), reach AS (
       SELECT m.chunk_id, sum(f.score) AS reach
       FROM mentions m JOIN frontier f ON f.entity_id = m.entity_id
       GROUP BY m.chunk_id
     ), ranked AS (
       SELECT m.entity_id, e.name AS entity_name,
              c.id AS chunk_id, c.document_id, d.path, d.title, c.content, ${sides.generated('d')} AS generated,
              row_number() OVER (
                PARTITION BY m.entity_id
                ORDER BY r.reach DESC, d.doc_date DESC NULLS LAST, d.updated_at DESC, c.seq, c.id
              ) AS event_rank
       FROM mentions m
       JOIN reach r ON r.chunk_id = m.chunk_id
       JOIN entities e ON e.id = m.entity_id
       JOIN chunks c ON c.id = m.chunk_id
       JOIN documents d ON d.id = c.document_id
       WHERE ${rowLiveAt('e', 'entity', p, asOf)} AND ${docCond}
     )
     SELECT entity_id, entity_name, chunk_id, document_id, path, title, content, generated
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
  model: string,
  chunkIds: string[],
): Promise<VectorRankRow[]> {
  if (chunkIds.length === 0) return [];
  const placeholders = chunkIds.map((_, i) => `$${i + 3}`).join(',');
  // the query's own vector space only: another model's vector of the same chunk measures nothing
  return store.query<VectorRankRow>(
    `SELECT e.chunk_id, 1 - (e.embedding <=> $1::${VECTOR_TYPE}) AS raw
     FROM embeddings e
     WHERE e.model = $2 AND e.chunk_id IN (${placeholders})
     ORDER BY e.embedding <=> $1::${VECTOR_TYPE}`,
    [toVectorLiteral(queryVector), model, ...chunkIds],
  );
}

/**
 * The walk's candidates as one list: those the entities reached, in the order
 * of their structural score, and those the bridge terms reached, in the order
 * the terms put them forward (bridge.ts), each list and the vector ranking of
 * all of them counted by reciprocal rank. A chunk both routes reached counts
 * on both. With no bridge candidates this is the entity route as it always
 * ranked.
 */
function fuseStructuralCandidates(
  candidates: StructuralCandidate[],
  bridged: BridgeCandidate[],
  vectorRows: VectorRankRow[],
): SearchResult[] {
  const vectorRanks = new Map(vectorRows.map((row, rank) => [row.chunk_id, { rank, raw: row.raw }]));
  const entries = new Map<string, { result: SearchResult; structural?: { rank: number; candidate: StructuralCandidate }; bridge?: { rank: number; candidate: BridgeCandidate } }>();
  candidates
    .sort((a, b) => b.structuralScore - a.structuralScore)
    .forEach((candidate, rank) => entries.set(candidate.result.chunkId, { result: candidate.result, structural: { rank, candidate } }));
  bridged.forEach((candidate, rank) => {
    const { row } = candidate;
    const entry = entries.get(row.chunk_id);
    if (entry) entry.bridge = { rank, candidate };
    else {
      entries.set(row.chunk_id, {
        result: { chunkId: row.chunk_id, documentId: row.document_id, path: row.path, title: row.title, content: row.content, score: 0, signals: {} },
        bridge: { rank, candidate },
      });
    }
  });
  return [...entries.values()]
    .map(({ result, structural, bridge }) => {
      const vector = vectorRanks.get(result.chunkId);
      const score =
        (structural ? 1 / (RRF_K + structural.rank + 1) : 0) +
        (bridge ? 1 / (RRF_K + bridge.rank + 1) : 0) +
        (vector ? 1 / (RRF_K + vector.rank + 1) : 0);
      return {
        ...result,
        score,
        signals: {
          ...result.signals,
          ...(structural ? { structural: structural.candidate.structuralScore } : {}),
          ...(bridge ? { bridge: bridge.candidate.row.raw } : {}),
          ...(vector ? { vector: vector.raw } : {}),
        },
        trace: {
          route: 'sag' as const,
          hop: structural?.candidate.provenance.hop ?? 1,
          seedChunkId: structural?.candidate.provenance.seedChunkId,
          bridgeEntities: structural?.candidate.provenance.bridges ?? [],
          ...(bridge ? { bridgeTerms: bridge.candidate.terms } : {}),
        },
      };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * The `k` results of a walk: the direct route's first `k · directRatio`, the
 * structural route's best for the rest, then whatever the two rank highest
 * together. Chunks of generated pages (`pages`) take `places` of the `k` at
 * most, whichever route offers them — a page past its places is passed over
 * for the route's next source — and more only when the routes run out of
 * sources (search.ts GENERATED_SHARE). The direct route is itself cut to that
 * share of its own, longer, list: three pages lead its twelve, and its first
 * four were handed on as they stood.
 *
 * The order of the `k` is by the two routes' ranks together, the structural
 * route's ranks starting where the direct route's places end: what the walk
 * reached follows what the question itself found, and a passage both routes
 * found rises. Until 2026-11-17 both counted from one, so the walk's first
 * stood level with the direct route's first and took the second place, its
 * second the fourth: on the 10× reports copy that cost the first five of
 * eight results 18 of 297 questions (30 lost, 12 won), and with bridge terms
 * on MuSiQue 7 points of recall at 2. Which passages are chosen did not change.
 */
function mergeRoutes(direct: SearchResult[], structural: SearchResult[], k: number, directRatio: number, pages: Set<string>, places: number): SearchResult[] {
  const directQuota = Math.round(k * directRatio);
  const structuralQuota = k - directQuota;
  const fused = new Map<string, SearchResult>();
  const fold = (items: SearchResult[], route: 'direct' | 'sag') => {
    const from = route === 'sag' ? directQuota : 0;
    items.forEach((item, at) => {
      const rank = from + at;
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

  const selected: SearchResult[] = [];
  const selectedIds = new Set<string>();
  let pagesTaken = 0;
  const add = (items: SearchResult[], quota: number, pagesAtMost = places) => {
    let added = 0;
    for (const item of items) {
      if (added >= quota) break;
      if (selectedIds.has(item.chunkId)) continue;
      if (pages.has(item.chunkId)) {
        if (pagesTaken >= pagesAtMost) continue;
        pagesTaken++;
      }
      selected.push(fused.get(item.chunkId)!);
      selectedIds.add(item.chunkId);
      added++;
    }
  };
  const together = [...fused.values()].sort((a, b) => b.score - a.score);
  add(direct, directQuota);
  add(structural, structuralQuota);
  add(together, k - selected.length);
  // the routes hold no more sources: pages take the places left
  add(together, k - selected.length, k);
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
): Promise<SearchResults> {
  const cfg = normalizedConfig(opts.sag);
  const scope: SagScope = { asOf: opts.asOf, filter: opts.filter ?? NO_FILTER };
  const k = boundedInteger(opts.k ?? 8, 8, 1, 100);
  const [queryVector] = opts.queryVector ? [opts.queryVector] : await embedder.embed([query]);
  const heatCfg = opts.heat ?? defaultConfig().heat;
  const direct = await search(store, embedder, query, {
    ...opts,
    k: Math.max(k, cfg.seedChunks),
    mode: 'hybrid',
    track: false,
    queryVector,
    // seeds and the direct route rank by relevance alone; heat breaks ties
    // once, on the merged results
    heat: { ...heatCfg, searchWeight: 0 },
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
    // chunks already reached are left out in SQL, so they take no entity's places
    const expandedRows = await expandEntities(store, frontierEntities, cfg.maxEventsPerEntity, seenChunks, scope);
    const nextIds = new Set<string>();

    for (const row of expandedRows) {
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
            // the cut counts pages (search.ts GENERATED_SHARE): a row says so itself, no lookup after
            ...(row.generated ? { generated: true as const } : {}),
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
  // the seeds' own terms as bridges, beside the entities they mention (bridge.ts); off unless configured
  const bridged = cfg.bridgeTerms > 0
    ? await lexicalBridge(
        store,
        query,
        direct.slice(0, cfg.seedChunks).map((r) => ({ chunkId: r.chunkId, content: r.content, weight: direct[0].score > 0 ? r.score / direct[0].score : 1 })),
        new Set(seedChunkIds),
        { terms: cfg.bridgeTerms, pool: cfg.bridgePool, asOf: scope.asOf, filter: scope.filter },
      )
    : { terms: [], candidates: [] };
  const pooled = [...new Set([...structuralPool.map((item) => item.result.chunkId), ...bridged.candidates.map((c) => c.row.chunk_id)])];
  const vectorRows = await coarseVectorRank(store, queryVector, embedder.model, pooled);
  const structuralResults = fuseStructuralCandidates(structuralPool, bridged.candidates, vectorRows);
  const share = opts.generatedShare ?? GENERATED_SHARE;
  const pages = new Set([...direct, ...structuralResults].filter((r) => r.generated).map((r) => r.chunkId));
  // the direct route's first result is the best candidate of all: a page there keeps a place
  const places = generatedPlaces(k, share, direct.length > 0 && pages.has(direct[0].chunkId));
  const results = mergeRoutes(direct, structuralResults, k, cfg.directRatio, pages, places);

  await boostByHeat(store, results, heatCfg);
  results.sort((a, b) => b.score - a.score);
  if (opts.track !== false) {
    await recordChunkHits(store, results.map((result) => ({ chunkId: result.chunkId, documentId: result.documentId })), heatCfg);
  }
  // the direct route is a hybrid search: where its vector channel came back short, the walk's results say so
  return markedPartial(results, direct.partial);
}
