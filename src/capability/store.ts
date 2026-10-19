import { Store } from '../store/db.js';
import { Params, TimeInput, live, toIso } from '../store/temporal.js';

/**
 * Read side of the capability graph: what can be asked of which source, how
 * to reach an entity through it, and what people have written about it.
 *
 * A capability row is the machine-discovered half (schema, dialect, cost
 * defaults); `capability_notes` is the human/agent half. They are folded here
 * rather than at write time, because the two halves come from different
 * sources with different lifetimes — retiring the datasource must not delete
 * the prose someone wrote about it, and vice versa.
 */

export interface CapabilityNoteView {
  sourcePath: string;
  semantics: string;
  sampleQueries: string[];
  pitfalls: string[];
  joins: string[];
}

export interface CapabilityRecord {
  id: string;
  kind: 'table' | 'endpoint' | 'metric' | 'tool';
  sourceId: string;
  name: string;
  title: string;
  /** How a request is written: sql | promql | http | object | tool. */
  dialect: string;
  entityId: string | null;
  schema: unknown;
  /** Machine-derived description plus every note written about it. */
  semantics: string;
  sampleQueries: string[];
  pitfalls: string[];
  joins: string[];
  /** Typical staleness of an answer, in seconds; null = unknown. */
  freshnessSeconds: number | null;
  /** Relative expense of one call, used by the planner's utility function. */
  cost: number;
  placement: string;
  notes: CapabilityNoteView[];
  /** True for capabilities the process provides itself (no external source). */
  builtin?: boolean;
}

export interface Locator {
  entityId: string;
  capabilityId: string;
  param: string;
  value: string;
}

/**
 * Capabilities the process itself provides. They have no owning scope — they
 * are code, not data — so they are synthesized on read instead of stored.
 * The planner needs them in the same catalog as external sources, otherwise
 * "search the local index" could never compete with "query MySQL".
 */
export const BUILTIN_CAPABILITIES: CapabilityRecord[] = [
  {
    id: 'knode.search', kind: 'tool', sourceId: 'knode', name: 'knode_search', title: 'Hybrid retrieval over indexed sources',
    dialect: 'tool', entityId: null, schema: { query: 'string', k: 'number', mode: 'hybrid|vector|keyword|sag', as_of: 'iso', kinds: 'string[]', sources: 'string[]' },
    semantics: 'Vector + keyword + graph recall over everything indexed locally. Cheap and always available; answers are as fresh as the last sync.',
    sampleQueries: [], pitfalls: [], joins: [], freshnessSeconds: null, cost: 1, placement: 'materialize', notes: [], builtin: true,
  },
  {
    id: 'knode.claims', kind: 'tool', sourceId: 'knode', name: 'knode_claims', title: 'Structured time-bound assertions',
    dialect: 'tool', entityId: null, schema: { subject: 'string', types: 'string[]', valid_at: 'iso', valid_range: 'string', as_of: 'iso' },
    semantics: 'Claims with their validity window, status and supporting source. Prefer this over search when the question is what is asserted and since when.',
    sampleQueries: [], pitfalls: [], joins: [], freshnessSeconds: null, cost: 1, placement: 'materialize', notes: [], builtin: true,
  },
  {
    id: 'knode.graph', kind: 'tool', sourceId: 'knode', name: 'knode_graph_search', title: 'Entity neighbourhood',
    dialect: 'tool', entityId: null, schema: { query: 'string', depth: 'number', as_of: 'iso' },
    semantics: 'Entities matching a query plus their typed edges, grounding chunks and claims.',
    sampleQueries: [], pitfalls: [], joins: [], freshnessSeconds: null, cost: 1, placement: 'materialize', notes: [], builtin: true,
  },
  {
    id: 'knode.catalog', kind: 'tool', sourceId: 'catalog', name: 'knode_query', title: 'SQL over the knowledge base itself',
    dialect: 'sql', entityId: null, schema: { source: 'catalog', sql: 'SELECT over v_* views' },
    semantics: 'Aggregate questions about the knowledge base: counts per source, coverage gaps, lineage rollups.',
    sampleQueries: ['SELECT source_path, count(*) FROM v_evidence GROUP BY 1'],
    pitfalls: [], joins: [], freshnessSeconds: null, cost: 1, placement: 'materialize', notes: [], builtin: true,
  },
];

interface CapRow {
  id: string; kind: string; source_id: string; name: string; title: string; dialect: string;
  entity_id: string | null; schema: unknown; semantics: string; sample_queries: unknown;
  freshness_seconds: number | null; cost: number; placement: string;
}

interface NoteRow {
  capability_id: string; source_path: string; semantics: string;
  sample_queries: unknown; pitfalls: unknown; joins: unknown;
  cost: number | null; freshness_seconds: number | null;
}

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

export interface CapabilityFilter {
  sourceIds?: string[];
  kinds?: string[];
  /** Only capabilities that can be reached for one of these entities. */
  entityIds?: string[];
  /** System time: the catalog as it stood then. */
  asOf?: TimeInput;
  /** Omit the built-in tool capabilities (they exist at every point in time). */
  excludeBuiltin?: boolean;
}

export async function listCapabilities(store: Store, filter: CapabilityFilter = {}): Promise<CapabilityRecord[]> {
  const asOf = toIso(filter.asOf);
  const p = new Params();
  const where: string[] = [live('c', p, asOf)];
  if (filter.sourceIds?.length) where.push(`c.source_id IN (${filter.sourceIds.map((x) => p.add(x)).join(',')})`);
  if (filter.kinds?.length) where.push(`c.kind IN (${filter.kinds.map((x) => p.add(x)).join(',')})`);
  if (filter.entityIds?.length) {
    const ids = filter.entityIds.map((x) => p.add(x)).join(',');
    where.push(`EXISTS (SELECT 1 FROM locators l WHERE l.capability_id = c.id AND l.entity_id IN (${ids}) AND ${live('l', p, asOf)})`);
  }
  const rows = await store.query<CapRow>(
    `SELECT c.id, c.kind, c.source_id, c.name, c.title, c.dialect, c.entity_id, c.schema, c.semantics,
            c.sample_queries, c.freshness_seconds, c.cost, c.placement
     FROM capabilities c WHERE ${where.join(' AND ')} ORDER BY c.source_id, c.name`,
    p.list,
  );

  const notes = await notesFor(store, rows.map((r) => r.id), asOf);
  const out = rows.map((r) => fold(r, notes.get(r.id) ?? []));

  if (!filter.excludeBuiltin && !filter.entityIds?.length) {
    const wantSource = filter.sourceIds?.length ? new Set(filter.sourceIds) : null;
    const wantKind = filter.kinds?.length ? new Set(filter.kinds) : null;
    for (const b of BUILTIN_CAPABILITIES) {
      if (wantSource && !wantSource.has(b.sourceId)) continue;
      if (wantKind && !wantKind.has(b.kind)) continue;
      out.push(b);
    }
  }
  return out;
}

async function notesFor(store: Store, ids: string[], asOf: string | null): Promise<Map<string, NoteRow[]>> {
  const grouped = new Map<string, NoteRow[]>();
  if (ids.length === 0) return grouped;
  // every capability the listing matched, the whole catalog when unfiltered: one array parameter
  const p = new Params();
  const list = p.add(ids);
  const rows = await store.query<NoteRow>(
    `SELECT capability_id, source_path, semantics, sample_queries, pitfalls, joins, cost, freshness_seconds
     FROM capability_notes n WHERE capability_id = ANY(${list}::text[]) AND ${live('n', p, asOf)} ORDER BY source_path`,
    p.list,
  );
  for (const r of rows) (grouped.get(r.capability_id) ?? grouped.set(r.capability_id, []).get(r.capability_id)!).push(r);
  return grouped;
}

/**
 * Machine-derived row + written notes. Notes win on cost and freshness — a
 * person who bothered to write "this view lags 15 minutes" knows more than the
 * introspection default — and their prose is appended rather than replacing
 * the schema description, so neither half is lost.
 */
function fold(row: CapRow, notes: NoteRow[]): CapabilityRecord {
  const semantics = [row.semantics, ...notes.map((n) => n.semantics)].map((s) => s?.trim()).filter(Boolean).join('\n\n');
  const noteCost = notes.map((n) => n.cost).find((c) => c !== null && c !== undefined);
  const noteFresh = notes.map((n) => n.freshness_seconds).find((f) => f !== null && f !== undefined);
  return {
    id: row.id,
    kind: row.kind as CapabilityRecord['kind'],
    sourceId: row.source_id,
    name: row.name,
    title: row.title,
    dialect: row.dialect,
    entityId: row.entity_id,
    schema: row.schema,
    semantics,
    sampleQueries: [...list(row.sample_queries), ...notes.flatMap((n) => list(n.sample_queries))],
    pitfalls: notes.flatMap((n) => list(n.pitfalls)),
    joins: notes.flatMap((n) => list(n.joins)),
    freshnessSeconds: noteFresh ?? row.freshness_seconds,
    cost: noteCost ?? row.cost,
    placement: row.placement,
    notes: notes.map((n) => ({
      sourcePath: n.source_path,
      semantics: n.semantics,
      sampleQueries: list(n.sample_queries),
      pitfalls: list(n.pitfalls),
      joins: list(n.joins),
    })),
  };
}

/** Every way the given entities can be reached through a live capability. */
export async function locatorsForEntities(store: Store, entityIds: string[], asOf?: TimeInput): Promise<Locator[]> {
  if (entityIds.length === 0) return [];
  const p = new Params();
  const ph = entityIds.map((id) => p.add(id)).join(',');
  const rows = await store.query<{ entity_id: string; capability_id: string; param: string; value: string }>(
    `SELECT entity_id, capability_id, param, value FROM locators l
     WHERE entity_id IN (${ph}) AND ${live('l', p, toIso(asOf))}
     ORDER BY capability_id, param, value`,
    p.list,
  );
  return rows.map((r) => ({ entityId: r.entity_id, capabilityId: r.capability_id, param: r.param, value: r.value }));
}

export async function capabilityById(store: Store, id: string, asOf?: TimeInput): Promise<CapabilityRecord | null> {
  const builtin = BUILTIN_CAPABILITIES.find((b) => b.id === id);
  if (builtin) return builtin;
  const found = await listCapabilities(store, { asOf, excludeBuiltin: true });
  return found.find((c) => c.id === id) ?? null;
}
