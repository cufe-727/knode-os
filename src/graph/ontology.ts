import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { ONTOLOGY_DIR } from '../fs/layout.js';
import { parseYaml } from '../compiler/intents.js';

/**
 * The ontology: which entity types and relation types the graph is written in.
 *
 * Declared in `playbooks/ontology/<pack>.yaml` (gbrain's schema-pack idea),
 * merged in the order `config.graph.ontologyPacks` lists them, with two
 * built-in packs seeded on first run: `core` (the generic vocabulary the
 * pipeline always had) and `organization` (corporate structure and supply
 * chains — subsidiaries, suppliers and customers, stakes, competitors).
 *
 * Everything downstream derives from the loaded ontology instead of a constant:
 * the tier-1 prompt lists these predicates with their definitions, the writer
 * validates and normalizes what comes back (synonyms → the canonical id, an
 * inverse spelling → the canonical id with the edge flipped, a symmetric
 * predicate → one row regardless of direction), and unknown predicates are
 * counted rather than silently becoming `related_to` and disappearing.
 */

export interface EntityTypeSpec {
  id: string;
  label?: string;
  description?: string;
  examples?: string[];
}

export interface RelationTypeSpec {
  id: string;
  label?: string;
  description?: string;
  /** Name of the inverse reading (`parent_of` for `subsidiary_of`). Not itself a stored predicate. */
  inverse?: string;
  /** A r B ⇔ B r A: stored once, endpoints ordered. */
  symmetric?: boolean;
  /** Containment / membership style edge. */
  hierarchical?: boolean;
  /** The edge normally holds for a period (extraction asks for validFrom / validTo). */
  temporal?: boolean;
  /** Entity types typically on each side; hints for the prompt, not constraints. */
  domain?: string[];
  range?: string[];
  /** Raw spellings mapped onto this predicate in its stated direction. */
  synonyms?: string[];
  /** Raw spellings mapped onto this predicate with source and target swapped. */
  inverseSynonyms?: string[];
  examples?: string[];
  /** Written by the pipeline itself (mentions, co_occurs …); never offered to the LLM. */
  system?: boolean;
}

export interface Ontology {
  packs: string[];
  entityTypes: EntityTypeSpec[];
  relationTypes: RelationTypeSpec[];
  /** Fingerprint of the merged packs (changes when any pack file changes). */
  sha: string;
}

export interface NormalizedPredicate {
  /** Canonical predicate id to store. */
  type: string;
  /** Swap source and target before storing (the raw spelling was an inverse reading). */
  flip: boolean;
  /** The raw spelling, when it matched nothing and fell back to `related_to`. */
  unknown?: string;
}

/**
 * Predicates the pipeline itself writes; always legal, never in the prompt.
 * `co_occurs` is no longer written — co-occurrence is derived from mentions on
 * read (cooccur.ts) — but stays legal so old sidecars and packs still validate.
 */
export const SYSTEM_RELATION_TYPES = ['related_to', 'mentions', 'links_to', 'co_occurs', 'stored_in', 'appears_in'] as const;

export const CORE_PACK_YAML = `# Ontology pack "core": the vocabulary every knode-os graph is written in.
# Edit or add packs under playbooks/ontology/ and list them in knode.config.json
# under graph.ontologyPacks (merged in order; later packs may extend earlier ones).
#
# relationTypes fields:
#   id           canonical predicate, stored on the edge
#   inverse      the inverse reading (not stored; an LLM or a frontmatter author may
#                use it and the edge is flipped into the canonical direction)
#   symmetric    A r B == B r A (stored once)
#   hierarchical containment / membership
#   temporal     usually holds for a period — extraction asks for validFrom / validTo
#   domain/range typical entity types on each side (prompt hints, not constraints)
#   synonyms / inverseSynonyms   raw spellings mapped onto this predicate
id: core
entityTypes:
  - { id: person, label: 人物 }
  - { id: organization, label: 组织 / 公司 }
  - { id: product, label: 产品 }
  - { id: project, label: 项目 }
  - { id: component, label: 组件 / 模块 }
  - { id: technology, label: 技术 }
  - { id: event, label: 事件 }
  - { id: location, label: 地点 }
  - { id: datasource, label: 数据源 }
  - { id: dataset, label: 数据集 }
  - { id: other, label: 其他 }
  - { id: concept, label: 概念（兜底） }
relationTypes:
  - { id: related_to, description: generic association when nothing more specific applies, system: true }
  - id: part_of
    inverse: has_part
    hierarchical: true
    description: A is a component, division or member of B
    synonyms: [component_of, belongs_to, division_of, 属于, 隶属于, 组成部分]
    inverseSynonyms: [contains, consists_of, 包含, 下设]
  - id: uses
    description: A uses B (a technology, tool, material or dataset)
    synonyms: [using, adopts, utilizes, 使用, 采用]
    inverseSynonyms: [used_by, 被使用]
  - id: depends_on
    description: A requires B to function or to be delivered
    synonyms: [requires, relies_on, 依赖]
    inverseSynonyms: [required_by, 被依赖]
  - id: works_at
    inverse: employs
    temporal: true
    domain: [person]
    range: [organization]
    description: person A holds a position at organization B
    synonyms: [employed_by, works_for, 就职于, 任职于, 任职]
    inverseSynonyms: [employer_of, 雇佣]
  - id: authored
    inverse: authored_by
    domain: [person, organization]
    description: A wrote or produced B (a document, report, product)
    synonyms: [wrote, created, published, 撰写, 发布]
    inverseSynonyms: [written_by, created_by, published_by, 作者]
  - id: located_in
    inverse: location_of
    domain: [organization, person, event]
    range: [location]
    description: A is based in / took place in B
    synonyms: [based_in, headquartered_in, 位于, 总部位于, 注册地]
  - id: member_of
    inverse: has_member
    hierarchical: true
    description: A belongs to group / alliance / index B
    synonyms: [joined, 成员, 加入]
  - id: succeeded_by
    inverse: preceded_by
    temporal: true
    description: A was replaced or followed by B
    synonyms: [replaced_by, superseded_by, followed_by, 被取代, 继任者]
    inverseSynonyms: [replaces, supersedes, succeeds, 取代, 接替]
  - id: caused
    inverse: caused_by
    description: A led to B
    synonyms: [led_to, resulted_in, triggered, 导致, 引发]
    inverseSynonyms: [because_of, due_to, 由于]
  - id: contradicts
    symmetric: true
    description: A and B make incompatible claims
    synonyms: [conflicts_with, disagrees_with, 矛盾, 冲突]
  - { id: mentions, system: true }
  - { id: links_to, system: true }
  - { id: co_occurs, system: true, symmetric: true }
  - { id: stored_in, system: true }
  - { id: appears_in, system: true }
`;

export const ORGANIZATION_PACK_YAML = `# Ontology pack "organization": corporate structure and supply-chain relations
# for company / industry research. Directions read "A <predicate> B".
id: organization
description: corporate structure, ownership and supply chains
relationTypes:
  - id: subsidiary_of
    inverse: parent_of
    hierarchical: true
    temporal: true
    domain: [organization]
    range: [organization]
    description: A is a subsidiary of / controlled by B
    synonyms: [controlled_by, unit_of, 子公司, 附属公司, 控股子公司, 全资子公司]
    inverseSynonyms: [controls, has_subsidiary, 母公司, 控股股东, 控股]
  - id: supplies_to
    inverse: customer_of
    temporal: true
    domain: [organization]
    range: [organization]
    description: A is an upstream supplier of B (B buys from A)
    synonyms: [supplier_of, sells_to, upstream_of, vendor_of, 供应商, 供货给, 上游, 供应]
    inverseSynonyms: [buys_from, purchases_from, downstream_of, sources_from, 客户, 采购自, 下游, 客户是]
  - id: owns
    inverse: owned_by
    temporal: true
    description: A holds an equity stake in B
    synonyms: [holds_stake_in, shareholder_of, stake_in, 持股, 持有股份, 股东]
  - id: invested_in
    inverse: invested_by
    temporal: true
    description: A invested money in B (a round, a fund, an acquisition of shares)
    synonyms: [invests_in, investor_in, 投资, 参股, 注资]
    inverseSynonyms: [funded_by, backed_by, raised_from, 获投资, 融资自]
  - id: acquired
    inverse: acquired_by
    temporal: true
    domain: [organization]
    range: [organization]
    description: A bought B (whole or majority)
    synonyms: [bought, took_over, merged_with?, 收购, 并购]
    inverseSynonyms: [被收购, sold_to]
  - id: competes_with
    symmetric: true
    domain: [organization, product]
    description: A and B compete in the same market
    synonyms: [competitor_of, rival_of, 竞争对手, 竞品, 竞争]
  - id: partner_of
    symmetric: true
    temporal: true
    description: A and B cooperate (joint venture, strategic partnership, alliance)
    synonyms: [partners_with, collaborates_with, joint_venture_with, 合作伙伴, 合作, 战略合作]
  - id: produces
    inverse: produced_by
    domain: [organization]
    range: [product]
    description: A makes or sells product B
    synonyms: [makes, manufactures, sells, offers, 生产, 制造, 销售, 主营]
    inverseSynonyms: [made_by, manufactured_by, 由...生产]
  - id: founded
    inverse: founded_by
    domain: [person, organization]
    range: [organization]
    description: A established B
    synonyms: [founder_of, established, 创立, 创办, 创建]
    inverseSynonyms: [创始人, founded_in?]
  - id: reports_to
    inverse: manages
    temporal: true
    domain: [person]
    range: [person]
    description: person A reports to person B
    synonyms: [汇报给, 向...汇报]
    inverseSynonyms: [manager_of, supervises, 管理, 领导]
  - id: regulated_by
    inverse: regulates
    domain: [organization]
    range: [organization]
    description: A is supervised or licensed by regulator B
    synonyms: [supervised_by, licensed_by, 受监管于, 监管]
`;

const BUILTIN_PACKS: Record<string, string> = { core: CORE_PACK_YAML, organization: ORGANIZATION_PACK_YAML };

/** Write the built-in packs once (never overwrites user edits). */
export function ensureDefaultOntology(dataDir: string): string[] {
  const created: string[] = [];
  for (const [name, yaml] of Object.entries(BUILTIN_PACKS)) {
    const file = path.join(dataDir, ONTOLOGY_DIR, `${name}.yaml`);
    if (fs.existsSync(file)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, yaml);
    created.push(`${ONTOLOGY_DIR}/${name}.yaml`);
  }
  return created;
}

function strings(v: unknown): string[] {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (!Array.isArray(v)) return [];
  return v.map(String).map((s) => s.trim()).filter(Boolean);
}

function idOf(v: unknown): string {
  return typeof v === 'string' ? predicateKey(v) : '';
}

/** Spelling → lookup key: trimmed, lower-cased, separators collapsed to `_`, trailing `?` dropped. */
export function predicateKey(raw: string): string {
  return raw
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\?+$/, '')
    .replace(/[\s\-/]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function parseOntologyPack(text: string): { id: string; entityTypes: EntityTypeSpec[]; relationTypes: RelationTypeSpec[] } {
  const fm = parseYaml(text);
  const entityTypes: EntityTypeSpec[] = [];
  for (const raw of Array.isArray(fm.entityTypes) ? fm.entityTypes : []) {
    if (typeof raw === 'string') {
      if (idOf(raw)) entityTypes.push({ id: idOf(raw) });
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const id = idOf(o.id);
    if (!id) continue;
    entityTypes.push({
      id,
      label: typeof o.label === 'string' ? o.label : undefined,
      description: typeof o.description === 'string' ? o.description : undefined,
      examples: strings(o.examples),
    });
  }
  const relationTypes: RelationTypeSpec[] = [];
  for (const raw of Array.isArray(fm.relationTypes) ? fm.relationTypes : []) {
    if (typeof raw === 'string') {
      if (idOf(raw)) relationTypes.push({ id: idOf(raw) });
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const id = idOf(o.id);
    if (!id) continue;
    relationTypes.push({
      id,
      label: typeof o.label === 'string' ? o.label : undefined,
      description: typeof o.description === 'string' ? o.description : undefined,
      inverse: idOf(o.inverse) || undefined,
      symmetric: o.symmetric === true,
      hierarchical: o.hierarchical === true,
      temporal: o.temporal === true,
      domain: strings(o.domain).map(predicateKey),
      range: strings(o.range).map(predicateKey),
      synonyms: strings(o.synonyms),
      inverseSynonyms: strings(o.inverseSynonyms ?? o.inverse_synonyms),
      examples: strings(o.examples),
      system: o.system === true,
    });
  }
  return { id: typeof fm.id === 'string' ? fm.id : '', entityTypes, relationTypes };
}

function mergeSpec<T extends { id: string }>(into: Map<string, T>, spec: T): void {
  const prev = into.get(spec.id);
  if (!prev) {
    into.set(spec.id, spec);
    return;
  }
  const merged: Record<string, unknown> = { ...prev };
  for (const [k, v] of Object.entries(spec as Record<string, unknown>)) {
    if (v === undefined || v === '' || v === false) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    merged[k] = v;
  }
  into.set(spec.id, merged as T);
}

/** Merge packs in order into one ontology; system predicates are always present. */
export function buildOntology(packs: { name: string; text: string }[]): Ontology {
  const entityTypes = new Map<string, EntityTypeSpec>();
  const relationTypes = new Map<string, RelationTypeSpec>();
  for (const pack of packs) {
    const parsed = parseOntologyPack(pack.text);
    for (const e of parsed.entityTypes) mergeSpec(entityTypes, e);
    for (const r of parsed.relationTypes) mergeSpec(relationTypes, r);
  }
  for (const id of SYSTEM_RELATION_TYPES) {
    if (!relationTypes.has(id)) relationTypes.set(id, { id, system: true, symmetric: id === 'co_occurs' });
  }
  if (!entityTypes.has('concept')) entityTypes.set('concept', { id: 'concept' });
  const sha = sha16(packs.map((p) => [p.name, p.text]));
  return { packs: packs.map((p) => p.name), entityTypes: [...entityTypes.values()], relationTypes: [...relationTypes.values()], sha };
}

function sha16(value: unknown): string {
  // tiny non-crypto fingerprint is enough: it only invalidates caches
  const text = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + text.length.toString(16);
}

interface CacheEntry {
  stamp: string;
  ontology: Ontology;
}

const cache = new Map<string, CacheEntry>();

function packsFromConfig(dataDir: string): string[] {
  try {
    const packs = loadConfig(dataDir).graph?.ontologyPacks;
    return Array.isArray(packs) && packs.length > 0 ? packs.map(String) : ['core', 'organization'];
  } catch {
    return ['core', 'organization'];
  }
}

/**
 * The ontology for a data directory. Synchronous and cached on the pack
 * files' mtimes, so it is cheap enough to call from inside a scope body. A
 * pack named in the config but missing on disk falls back to the built-in of
 * the same name (or is skipped); `ensureDefaultOntology` seeds the built-ins
 * at init so the usual case reads them from the user's files.
 */
export function loadOntology(dataDir: string, packs: string[] = packsFromConfig(dataDir)): Ontology {
  const dir = path.join(dataDir, ONTOLOGY_DIR);
  const sources: { name: string; text: string; stamp: string }[] = [];
  for (const name of packs) {
    const file = path.join(dir, `${name}.yaml`);
    try {
      const st = fs.statSync(file);
      sources.push({ name, text: fs.readFileSync(file, 'utf8'), stamp: `${st.mtimeMs}:${st.size}` });
    } catch {
      if (BUILTIN_PACKS[name]) sources.push({ name, text: BUILTIN_PACKS[name], stamp: 'builtin' });
    }
  }
  const key = `${dataDir}|${packs.join(',')}`;
  const stamp = sources.map((s) => `${s.name}@${s.stamp}`).join(';');
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp) return hit.ontology;
  const ontology = buildOntology(sources);
  cache.set(key, { stamp, ontology });
  return ontology;
}

/** The built-in vocabulary alone (used where no data directory is at hand). */
export function builtinOntology(): Ontology {
  return buildOntology(Object.entries(BUILTIN_PACKS).map(([name, text]) => ({ name, text })));
}

export function entityTypeIds(ont: Ontology): Set<string> {
  return new Set(ont.entityTypes.map((t) => t.id));
}

export function relationTypeIds(ont: Ontology): Set<string> {
  return new Set(ont.relationTypes.map((t) => t.id));
}

export function relationSpec(ont: Ontology, id: string): RelationTypeSpec | undefined {
  return ont.relationTypes.find((r) => r.id === id);
}

/**
 * Type precedence for the entity fold: the declared order, with `concept`
 * (the extraction fallback) always losing to anything more specific.
 */
export function typePrecedence(ont: Ontology): string[] {
  const ids = ont.entityTypes.map((t) => t.id).filter((id) => id !== 'concept');
  return [...ids, 'concept'];
}

interface PredicateIndex {
  canonical: Map<string, { id: string; flip: boolean }>;
}

const indexCache = new WeakMap<Ontology, PredicateIndex>();

function predicateIndex(ont: Ontology): PredicateIndex {
  let idx = indexCache.get(ont);
  if (idx) return idx;
  const canonical = new Map<string, { id: string; flip: boolean }>();
  const put = (key: string, id: string, flip: boolean) => {
    if (key && !canonical.has(key)) canonical.set(key, { id, flip });
  };
  // ids first so a synonym never shadows a real predicate
  for (const r of ont.relationTypes) put(r.id, r.id, false);
  for (const r of ont.relationTypes) {
    for (const s of r.synonyms ?? []) put(predicateKey(s), r.id, false);
    if (r.symmetric) {
      if (r.inverse) put(r.inverse, r.id, false);
      for (const s of r.inverseSynonyms ?? []) put(predicateKey(s), r.id, false);
    } else {
      if (r.inverse) put(r.inverse, r.id, true);
      for (const s of r.inverseSynonyms ?? []) put(predicateKey(s), r.id, true);
    }
  }
  idx = { canonical };
  indexCache.set(ont, idx);
  return idx;
}

/**
 * Map a raw predicate spelling onto the ontology. Unknown spellings fall back
 * to `related_to` and report the original so callers can count them — the
 * signal that a pack is missing a predicate people keep needing.
 */
export function normalizePredicate(ont: Ontology, raw: string): NormalizedPredicate {
  const key = predicateKey(raw ?? '');
  if (!key) return { type: 'related_to', flip: false, unknown: raw };
  const hit = predicateIndex(ont).canonical.get(key);
  if (hit) return { type: hit.id, flip: hit.flip };
  return { type: 'related_to', flip: false, unknown: raw.trim() };
}

/** The relation list as the tier-1 prompt states it: canonical id, one-line meaning, inverse spelling, hints. */
export function promptFragment(ont: Ontology): { entityTypes: string; relationTypes: string } {
  const entityTypes = ont.entityTypes.map((t) => t.id).join(', ');
  const lines: string[] = [];
  for (const r of ont.relationTypes) {
    if (r.system) continue;
    const parts: string[] = [];
    if (r.description) parts.push(r.description);
    if (r.symmetric) parts.push('symmetric');
    else if (r.inverse) parts.push(`inverse: ${r.inverse}`);
    if (r.domain?.length || r.range?.length) parts.push(`${(r.domain ?? ['*']).join('|')} → ${(r.range ?? ['*']).join('|')}`);
    if (r.temporal) parts.push('time-bound: give validFrom/validTo when stated');
    lines.push(`- ${r.id}${parts.length ? `: ${parts.join('; ')}` : ''}`);
  }
  lines.push('- related_to: only when nothing above fits');
  return { entityTypes, relationTypes: lines.join('\n') };
}
