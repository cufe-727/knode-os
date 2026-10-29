import { tier0Known, typedEntitiesNamed, weakLinkKey } from '../graph/concepts.js';
import { wikilinkName } from '../graph/frontmatter.js';
import { loadOntology, relationSpec, Ontology } from '../graph/ontology.js';
import { keyOf } from '../graph/normalize.js';
import type { PageContext } from '../graph/store.js';
import type { ScopeWriter } from '../lineage/writer.js';
import type { Store } from '../store/db.js';
import { MindMap, MindMapNode, TRAIL_SEPARATOR, walkMindMap } from './outline.js';

/**
 * What a mind map tells the graph without a model (docs/design/19-mind-maps.md).
 *
 * A node counts when its name is the name of an entity the graph already
 * knows as a typed one, or one the document itself declares in `entities:` (a
 * reviewed transcript types what the graph has not seen, or knows by another
 * spelling); the document's `subject:` stands for its root. Everything else — a branch such
 * as 上游 or 特征, a note such as 20cm — stays text: it reads in the chunks,
 * which carry each branch's path, and tier-1 extraction sees it there.
 *
 * Between a counted node and the nearest counted node above it the map states
 * an edge, typed by what the two are (`edgeFor`) and described by the path
 * from the root, so the entity panel says where the map put it:
 *
 *   永贵电器 —belongs_to_sector→ 华为产业链
 *     "华为 › 华为智驾 › 液冷超充 › 永贵电器（液冷充电枪）"
 *
 * An edge goes to the node right above; past branches nobody names, only to
 * the subject: 上海沿浦 under 座位 under 华为智驾 says nothing about what it
 * has to do with 华为智驾. Two groupings — neither a company — are joined
 * only when the upper one is the subject: 整车 under 华为智驾 is true of this
 * map, not of the auto sector. And a company listed under a segment (赛力斯
 * under 整车) belongs to the subject too, which is what an industry-chain map
 * is for.
 *
 * A node the graph knew is linked the way tier-0 links any name it knows —
 * the fallback type at half weight — so the map never out-votes the type
 * tier-1 gives that entity. A declared one carries the type it was declared
 * with.
 */

export const MINDMAP_EXTRACTOR = 'tier0.mindmap';

/**
 * The planner's version, kept in a mind map document's scope: one applied by
 * an older planner is read again once, the next time a sync visits it, so a
 * change to the rules below reaches the maps already indexed.
 */
export const MINDMAP_PLAN_VERSION = 2;

/** An entity a node stands for: a known one carries its id. */
export interface NodeEntity {
  id: string | null;
  name: string;
  type: string;
}

export interface MindMapEdge {
  source: NodeEntity;
  target: NodeEntity;
  type: string;
  description: string;
}

export interface MindMapPlan {
  /** Every entity some node stands for, with the labels that name it (the needles for its chunk mentions). */
  entities: { entity: NodeEntity; surfaces: string[] }[];
  edges: MindMapEdge[];
}

/** Holders: what a sector or theme groups. */
const HOLDERS = new Set(['organization', 'security', 'fund']);
/** Groupings a holder belongs to. */
const GROUPS = new Set(['sector', 'theme']);
/** Things an organization makes, mines or sells. */
const MADE = new Set(['product', 'component', 'technology', 'commodity']);
/** Kinds that nest inside one another as parts. */
const PARTS = new Set(['sector', 'theme', 'technology', 'product', 'component', 'commodity', 'concept', 'market', 'indicator', 'policy', 'index', 'event', 'project', 'other']);

/**
 * The edge a child under a parent states. The hierarchy says "listed under",
 * which is only as precise as the two types allow: a company under a theme
 * belongs to it, under a product it makes it, a part under a whole is part of
 * it; two companies (赛力斯 under 华为) or a person are only related, and the
 * path in the description says how. Predicates the workspace's ontology does
 * not know fall back to part_of / related_to.
 */
export function edgeFor(child: string, parent: string, ontology?: Ontology): { type: string; flip: boolean } {
  const has = (id: string) => !ontology || Boolean(relationSpec(ontology, id));
  if (HOLDERS.has(child) && GROUPS.has(parent)) return { type: has('belongs_to_sector') ? 'belongs_to_sector' : 'part_of', flip: false };
  if (child === 'organization' && MADE.has(parent)) return has('produces') ? { type: 'produces', flip: false } : { type: 'related_to', flip: false };
  if (MADE.has(child) && parent === 'organization') return has('produces') ? { type: 'produces', flip: true } : { type: 'related_to', flip: false };
  if (PARTS.has(child) && PARTS.has(parent)) return { type: 'part_of', flip: false };
  return { type: 'related_to', flip: false };
}

/**
 * Resolve the nodes and lay out the edges. `resolve` answers a node name with
 * the entity it is, or null; `subject` stands for the root whatever its label.
 */
export function planMindMapGraph(
  map: MindMap,
  resolve: (name: string) => NodeEntity | null,
  opts: { subject?: NodeEntity | null; ontology?: Ontology } = {},
): MindMapPlan {
  const byNode = new Map<MindMapNode, NodeEntity>();
  const entities = new Map<string, { entity: NodeEntity; surfaces: string[] }>();
  const keyOfEntity = (e: NodeEntity) => e.id ?? `name:${keyOf(e.name)}`;
  const note = (e: NodeEntity, surface: string) => {
    const k = keyOfEntity(e);
    const seen = entities.get(k) ?? entities.set(k, { entity: e, surfaces: [] }).get(k)!;
    if (surface && !seen.surfaces.includes(surface)) seen.surfaces.push(surface);
  };

  for (const { node } of walkMindMap(map)) {
    const entity = node === map.root && opts.subject ? opts.subject : resolve(node.name) ?? (node.name !== node.text ? resolve(node.text) : null);
    if (!entity) continue;
    byNode.set(node, entity);
    note(entity, node === map.root && opts.subject ? opts.subject.name : node.name);
  }

  const edges: MindMapEdge[] = [];
  const stated = new Set<string>();
  const subject = opts.subject ? byNode.get(map.root) : undefined;
  const isSubject = (e: NodeEntity) => Boolean(subject) && keyOfEntity(e) === keyOfEntity(subject!);
  const state = (child: NodeEntity, parent: NodeEntity, description: string) => {
    if (keyOfEntity(parent) === keyOfEntity(child)) return;
    const { type, flip } = edgeFor(child.type, parent.type, opts.ontology);
    const [source, target] = flip ? [parent, child] : [child, parent];
    const key = `${keyOfEntity(source)}|${type}|${keyOfEntity(target)}`;
    if (stated.has(key)) return;
    stated.add(key);
    edges.push({ source, target, type, description });
  };
  for (const { node, trail } of walkMindMap(map)) {
    const child = byNode.get(node);
    if (!child) continue;
    let parent: NodeEntity | undefined;
    let direct = false;
    for (let i = trail.length - 1; i >= 0 && !parent; i--) {
      parent = byNode.get(trail[i]);
      direct = i === trail.length - 1;
    }
    if (!parent) continue;
    const description = [...trail, node].map((n) => n.text).join(TRAIL_SEPARATOR);
    const toSubject = isSubject(parent);
    // the node right above, unless both are groupings that nest only inside this map (整车 under 华为智驾);
    // past unnamed branches, only the subject
    if (toSubject || (direct && (HOLDERS.has(child.type) || HOLDERS.has(parent.type)))) state(child, parent, description);
    // a company the map lists belongs to the map's subject whatever segment it sits in
    if (subject && !toSubject && HOLDERS.has(child.type)) state(child, subject, description);
  }
  return { entities: [...entities.values()], edges };
}

/**
 * Types a node never resolves to unless the document declares it: where
 * extraction leaves its generic words (a phase of a cycle typed indicator, a
 * board typed dataset), and people — a branch called 火炮 is no blogger.
 */
const UNNAMED_TYPES = new Set(['person', 'event', 'dataset', 'datasource', 'indicator', 'other']);

/**
 * The plan for one document: its `entities:` first (the author typed them),
 * then the graph's typed entities by the exact spelling of their **name**.
 * Aliases do not count: in a graph built by extraction they collect what was
 * merged into an entity, rightly or not (创业板 and 20cm under A股, CPU and
 * HBM under 芯片, 中国船舶 under 中船特气), and a map's node would be drawn
 * onto the wrong one. A stop-listed name does not count either, nor any name
 * the graph knows when the document says `linkNodes: declared`. `subject:`
 * names what the root stands for (`华为产业链`, or `{ name, type }`); a wiki
 * page's own entity does when it has none.
 */
export async function planDocumentMindMap(
  store: Store,
  map: MindMap,
  fm: Record<string, unknown>,
  self?: { name: string; type: string } | null,
): Promise<MindMapPlan> {
  const ontology = loadOntology(store.dataDir);
  const declared = new Map<string, NodeEntity>();
  for (const raw of Array.isArray(fm.entities) ? fm.entities : []) {
    const o = typeof raw === 'string' ? { name: raw } : raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
    const name = o && typeof o.name === 'string' ? wikilinkName(o.name) : '';
    if (!o || !name) continue;
    const entity: NodeEntity = { id: null, name, type: typeof o.type === 'string' && o.type.trim() ? o.type.trim() : 'concept' };
    for (const spelling of [name, ...(Array.isArray(o.aliases) ? o.aliases.map(String) : [])]) {
      const k = keyOf(spelling);
      if (k && !declared.has(k)) declared.set(k, entity);
    }
  }

  const names = new Set<string>();
  for (const { node } of walkMindMap(map)) {
    names.add(node.name);
    if (node.text !== node.name) names.add(node.text);
  }
  // `linkNodes: declared` — a map of jargon, say, whose words the graph types badly — counts only what it declares
  const known = new Map<string, NodeEntity>();
  if (fm.linkNodes !== 'declared') {
    const { linkStop } = await tier0Known(store);
    // hottest first, so a name two typed entities share goes to the one the corpus means
    for (const c of await typedEntitiesNamed(store, store.dataDir, [...names])) {
      const k = keyOf(c.name);
      if (!c.id || UNNAMED_TYPES.has(c.type) || known.has(k) || weakLinkKey(k, { isName: true, stop: linkStop })) continue;
      // two characters are where companies and everyday words meet (海洋, 稀土 typed organization): declare those
      if (c.type === 'organization' && [...k].length < 3) continue;
      known.set(k, { id: c.id, name: c.name, type: c.type });
    }
  }
  // a declared name counts however short (铜, 锡); the graph's only from two characters on
  const resolve = (name: string): NodeEntity | null => {
    const k = keyOf(name);
    if (!k) return null;
    return declared.get(k) ?? (k.length >= 2 ? known.get(k) : undefined) ?? null;
  };

  const declaredSubject = mindMapSubject(fm, ontology);
  const subject: NodeEntity | null = declaredSubject
    ? resolve(declaredSubject.name) ?? { id: null, ...declaredSubject }
    : self ? { id: null, name: self.name, type: self.type } : null;
  return planMindMapGraph(map, resolve, { subject, ontology });
}

/** `subject:` as written — `华为产业链`, `[[华为产业链]]` or `{ name, type }` — typed `theme` when the ontology has it and it says nothing. */
export function mindMapSubject(fm: Record<string, unknown>, ontology?: Ontology): { name: string; type: string } | null {
  const s = fm.subject;
  const o = s && typeof s === 'object' ? (s as Record<string, unknown>) : null;
  const name = typeof s === 'string' ? wikilinkName(s) : typeof o?.name === 'string' ? wikilinkName(o.name) : '';
  if (!name) return null;
  const typed = typeof o?.type === 'string' ? o.type.trim() : '';
  return { name, type: typed || (!ontology || ontology.entityTypes.some((t) => t.id === 'theme') ? 'theme' : 'concept') };
}

/**
 * The frontmatter the declared step reads, with the subject among its
 * `entities:`: a relation the document states about its subject then
 * resolves it with the subject's type, never as a bare name an alias could
 * capture (华为产业链 is an alias of the company 华为 in finance).
 */
export function withMindMapSubject(fm: Record<string, unknown>, ontology?: Ontology): Record<string, unknown> {
  const subject = mindMapSubject(fm, ontology);
  if (!subject) return fm;
  const entities = Array.isArray(fm.entities) ? fm.entities : [];
  return { ...fm, entities: [subject, ...entities] };
}

/** Chunk mentions a node's entity gets at most, as for any tier-0 link. */
const MENTIONS_PER_ENTITY = 4;

/**
 * Write the plan into the document's scope: each entity with mentions in the
 * chunks that name it, then the edges. Known entities are linked by id at half
 * weight with the fallback type; declared ones carry their type.
 */
export async function wireMindMap(w: ScopeWriter, page: PageContext, plan: MindMapPlan): Promise<{ entities: number; relations: number }> {
  const ids = new Map<string, string>();
  const keyOfEntity = (e: NodeEntity) => e.id ?? `name:${keyOf(e.name)}`;
  for (const { entity, surfaces } of plan.entities) {
    const needles = [...surfaces, entity.name].map((s) => s.toLowerCase()).filter(Boolean);
    const hits = page.chunkIds.filter((c) => {
      const lc = c.content.toLowerCase();
      return needles.some((n) => lc.includes(n));
    });
    const segmentId = hits[0]?.id ?? page.chunkIds[0]?.id ?? null;
    const id = entity.id
      ? await w.entity({ name: entity.name, type: 'concept' }, { id: entity.id, extractor: MINDMAP_EXTRACTOR, weight: 0.5, segmentId })
      : await w.entity({ name: entity.name, type: entity.type }, { extractor: MINDMAP_EXTRACTOR, weight: 0.5, segmentId });
    ids.set(keyOfEntity(entity), id);
    for (const h of hits.slice(0, MENTIONS_PER_ENTITY)) await w.mention(id, h.id, page.documentId);
    if (hits.length === 0 && page.chunkIds[0]) await w.mention(id, page.chunkIds[0].id, page.documentId);
  }
  let relations = 0;
  for (const edge of plan.edges) {
    const source = ids.get(keyOfEntity(edge.source));
    const target = ids.get(keyOfEntity(edge.target));
    if (!source || !target) continue;
    const segmentId = page.chunkIds.find((c) => c.content.includes(edge.description.split(TRAIL_SEPARATOR).pop() ?? ''))?.id ?? null;
    const written = await w.relation(source, target, {
      type: edge.type,
      description: edge.description,
      // "related" is all the map can say of two companies: it should not weigh like a stated predicate
      weight: edge.type === 'related_to' ? 0.5 : 1,
      extractor: MINDMAP_EXTRACTOR,
      segmentId,
    });
    if (written) relations++;
  }
  return { entities: ids.size, relations };
}
