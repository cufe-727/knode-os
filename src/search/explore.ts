import { HeatConfig, SagSearchConfig } from '../config.js';
import { graphSearch } from '../graph/query.js';
import { EmbeddingProvider } from '../ingest/embeddings.js';
import { Store } from '../store/db.js';
import { ResolvedScopeFilter } from '../store/resolver.js';
import { Params } from '../store/temporal.js';
import { ClaimItem, GraphEdge, SearchResult } from '../types.js';
import { ExplainedSearch, queryTerms, SearchMode, searchExplained } from './search.js';
import { likeEscape } from '../store/entities.js';

/**
 * Explore → Search: what a query matches, channel by channel, so a person can
 * see why the agents get the context they get (docs/design/20).
 *
 * Two reads run side by side. The passage read is the hybrid search every
 * agent uses (or SAG), asked to explain itself: each passage carries its rank
 * in the semantic, keyword and entity channels, and each channel says how many
 * chunks it found. The graph read is the entity search behind the graph view,
 * one hop deep: the entities whose name, alias or description holds a query
 * term, the entities one relation away, the relations between them and the
 * claims about the strongest. Either may fail without taking the other down —
 * a spent embedding quota still leaves keyword passages and the graph.
 *
 * Neither read is counted as use: an inspection that fed the usage heat
 * (src/stats/heat.ts) would move the ranking it was opened to look at.
 */

export interface ExploreEntity {
  id: string;
  name: string;
  type: string;
  description: string;
  aliases: string[];
  mentionCount: number;
  /** Live typed relations across the whole graph. */
  degree: number;
  wikiPath: string | null;
  /** The graph read's relevance: 2 an exact name, 1 another match, less for an entity reached through a relation. */
  score: number;
  /** Where a query term is in it — the reason it was found — or null for an entity only reached through a relation. */
  match: { field: 'name' | 'alias' | 'description'; term: string; text: string } | null;
}

export interface ExploreResult {
  query: string;
  mode: SearchMode;
  /** The terms keyword fallback and entity matching look for (CJK runs split into bigrams). */
  terms: string[];
  /** Ranked passages, each with `ranks` (hybrid) or `trace` (SAG). */
  passages: SearchResult[];
  channels: ExplainedSearch['channels'];
  /** Matched entities first, strongest first; then the entities one relation away. */
  entities: ExploreEntity[];
  /** Relations among `entities`: typed ones and derived co-occurrence (`co_occurs`). */
  relations: GraphEdge[];
  claims: ClaimItem[];
  ms: { total: number; passages: number; graph: number };
  /** A read that failed, with its message; the other's results stand. */
  errors: { passages?: string; graph?: string };
}

export interface ExploreOptions {
  k?: number;
  mode?: SearchMode;
  heat?: HeatConfig;
  sag?: Partial<SagSearchConfig>;
  filter?: ResolvedScopeFilter;
  /** Entities the graph read may return, matched and reached together. */
  entityLimit?: number;
}

async function timed<T>(run: () => Promise<T>): Promise<{ value?: T; error?: string; ms: number }> {
  const started = Date.now();
  try {
    return { value: await run(), ms: Date.now() - started };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), ms: Date.now() - started };
  }
}

/** The first field of an entity holding one of the terms, in the order a person would read the reason. */
export function entityMatch(
  entity: { name: string; aliases: string[]; description: string },
  terms: string[],
): ExploreEntity['match'] {
  const lowered = terms.map((t) => ({ term: t, low: t.toLowerCase() }));
  const holds = (text: string) => {
    const low = text.toLowerCase();
    return lowered.find((t) => low.includes(t.low))?.term;
  };
  const inName = holds(entity.name);
  if (inName) return { field: 'name', term: inName, text: entity.name };
  for (const alias of entity.aliases) {
    const term = holds(alias);
    if (term) return { field: 'alias', term, text: alias };
  }
  const inDescription = holds(entity.description);
  return inDescription ? { field: 'description', term: inDescription, text: entity.description } : null;
}

function aliasList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((a): a is string => typeof a === 'string');
  if (typeof raw === 'string') {
    try {
      return aliasList(JSON.parse(raw));
    } catch {
      return [];
    }
  }
  return [];
}

export async function exploreSearch(store: Store, embedder: EmbeddingProvider, query: string, opts: ExploreOptions = {}): Promise<ExploreResult> {
  const started = Date.now();
  const mode = opts.mode ?? 'hybrid';
  const terms = queryTerms(query, 8);
  const [passages, graph] = await Promise.all([
    timed(() => searchExplained(store, embedder, query, { k: opts.k ?? 20, mode, heat: opts.heat, sag: opts.sag, filter: opts.filter, explain: true, track: false })),
    // one hop: the matches and their neighbours, without the grounding chunks the passage read already covers
    timed(() => graphSearch(store, query, { depth: 1, limit: opts.entityLimit ?? 30, chunkLimit: 0, heat: opts.heat, filter: opts.filter, track: false })),
  ]);

  const nodes = graph.value?.nodes ?? [];
  const aliases = new Map<string, string[]>();
  if (nodes.length > 0) {
    const rows = await store.query<{ id: string; aliases: unknown }>(`SELECT id, aliases FROM entities WHERE id = ANY($1::text[])`, [nodes.map((n) => n.id)]);
    for (const row of rows) aliases.set(row.id, aliasList(row.aliases));
  }
  const entities: ExploreEntity[] = nodes.map((n) => {
    const own = aliases.get(n.id) ?? [];
    return {
      id: n.id,
      name: n.name,
      type: n.type,
      description: n.description,
      aliases: own,
      mentionCount: n.mentionCount,
      degree: n.degree ?? 0,
      wikiPath: n.wikiPath ?? null,
      score: Number(n.score.toFixed(4)),
      match: entityMatch({ name: n.name, aliases: own, description: n.description }, terms),
    };
  });
  // the reason first: what matched the query, then what is only related to it
  entities.sort((a, b) => Number(b.match !== null) - Number(a.match !== null) || b.score - a.score || b.mentionCount - a.mentionCount);

  return {
    query,
    mode,
    terms,
    passages: passages.value?.results ?? [],
    channels: passages.value?.channels ?? {},
    entities,
    relations: graph.value?.edges ?? [],
    claims: graph.value?.claims ?? [],
    ms: { total: Date.now() - started, passages: passages.ms, graph: graph.ms },
    errors: { ...(passages.error ? { passages: passages.error } : {}), ...(graph.error ? { graph: graph.error } : {}) },
  };
}

/* ------------------------------ suggestions ------------------------------ */

export interface SearchSuggestions {
  entities: { id: string; name: string; type: string; mentionCount: number; wikiPath: string | null; alias: string | null }[];
  documents: { path: string; title: string | null }[];
}

/**
 * What a search box offers while someone types: entities whose name or alias
 * holds the text — an exact name first, then names that start with it — and
 * indexed documents whose title or path does. Substring reads only, no model
 * and no vectors, so it answers as fast as the keys come.
 */
export async function searchSuggest(store: Store, text: string, limit = 6): Promise<SearchSuggestions> {
  const q = text.trim();
  if (!q) return { entities: [], documents: [] };
  const n = Math.min(Math.max(Math.floor(limit) || 6, 1), 20);
  const ep = new Params();
  const exact = ep.add(q);
  const prefix = ep.add(`${likeEscape(q)}%`);
  const contains = ep.add(`%${likeEscape(q)}%`);
  const elim = ep.add(n);
  const dp = new Params();
  const dcontains = dp.add(`%${likeEscape(q)}%`);
  const dprefix = dp.add(`${likeEscape(q)}%`);
  const dlim = dp.add(n);
  const [entityRows, documents] = await Promise.all([
    store.query<{ id: string; name: string; type: string; mention_count: number; wiki_path: string | null; aliases: unknown }>(
      `SELECT e.id, e.name, e.type, e.mention_count, e.wiki_path, e.aliases
       FROM entities e
       WHERE e.tx_to IS NULL AND e.canonical_id IS NULL AND (e.name ILIKE ${contains} OR e.aliases::text ILIKE ${contains})
       ORDER BY CASE WHEN lower(e.name) = lower(${exact}) THEN 0 WHEN e.name ILIKE ${prefix} THEN 1 WHEN e.name ILIKE ${contains} THEN 2 ELSE 3 END,
                e.mention_count DESC, e.name, e.id
       LIMIT ${elim}`,
      ep.list,
    ),
    store.query<{ path: string; title: string | null }>(
      `SELECT d.path, d.title FROM documents d
       WHERE d.status = 'indexed' AND (d.title ILIKE ${dcontains} OR d.path ILIKE ${dcontains})
       ORDER BY (d.title ILIKE ${dprefix}) DESC, length(d.path), d.path
       LIMIT ${dlim}`,
      dp.list,
    ),
  ]);
  const low = q.toLowerCase();
  return {
    entities: entityRows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      mentionCount: r.mention_count,
      wikiPath: r.wiki_path,
      // the spelling that matched, when it is not the name
      alias: r.name.toLowerCase().includes(low) ? null : aliasList(r.aliases).find((a) => a.toLowerCase().includes(low)) ?? null,
    })),
    documents,
  };
}
