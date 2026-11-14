import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, loadConfig, ReviewIdentity, ReviewResolution } from '../config.js';
import { Queryable } from '../store/migrations.js';
import { EntityCorrections, refusedKeys, refuses } from './corrections.js';
import { ANCHOR_TYPES, Code, codesKey, codesOf, conflictingCode, MentionContext, namesakeFor, namesakeName, NamesakeRule } from './identity.js';
import { entityKeys, mentionKeys, nameKey, typesCompatible } from './normalize.js';
import { slugify } from './store.js';

/**
 * Write-time entity resolution. Before the writer assigns `slugify(name)` as
 * a new entity's id it asks whether the graph already knows that thing under
 * another spelling: an explicit `sameAs` from the extractor, an existing row
 * with the same slug, or a name / alias key match (see normalize.ts). A match
 * returns the *canonical* id, so mentions of an entity that was merged into
 * another land on the survivor — unless a person said that entity does not
 * answer to the mention's spelling (src/graph/corrections.ts).
 *
 * Only exact key equality merges here. Near-duplicates are the nightly
 * audit's job (dedupe.ts), which proposes rather than decides.
 *
 * A name is not always one thing (identity.ts). Where the entity a mention
 * lands on was parted into several (entity_namesakes: a person and a
 * namesake, a setting ten divisions each have), the mention's code, its team
 * or parent and its document's organizations say which of them it means. And
 * a mention whose code differs from the code of the entity it lands on is
 * parted from it here, when that entity's documents stand under a roof this
 * document does not name (`partByCode`). A mention with no such context
 * resolves as it always did.
 */

export interface ResolveInput {
  name: string;
  type?: string;
  aliases?: string[];
  /** Canonical name the extractor believes this entity is the same as. */
  sameAs?: string | null;
  /** What the mention's document says about it: its team or parent, the document's own names (identity.ts). */
  context?: MentionContext;
}

export interface ResolvedEntity {
  id: string;
  /** Current name of the entity the mention resolved to (undefined for a new id). */
  name?: string;
  /** Set when the mention resolved to an entity other than `slugify(name)`. */
  resolvedFrom?: string;
  /** Set when the name was parted and this is the one of its entities the mention means. */
  namesake?: NamesakeRule;
}

interface CandidateRow {
  id: string;
  name: string;
  type: string;
  canonical_id: string | null;
  mention_count: number;
  aliases: string[] | null;
}

async function rowById(q: Queryable, id: string): Promise<CandidateRow | null> {
  const rows = await q.query<CandidateRow>(`SELECT id, name, type, canonical_id, mention_count, aliases FROM entities WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * The entities names were parted into (entity_namesakes), read once for a
 * run of resolutions: the table is small and most mentions land on a name
 * that was never parted.
 */
export class NamesakeIndex {
  private byBase: Map<string, NamesakeRule[]> | null = null;
  private baseOf = new Map<string, string>();

  private async load(q: Queryable): Promise<Map<string, NamesakeRule[]>> {
    if (this.byBase) return this.byBase;
    const rows = await q.query<NamesakeRule>(`SELECT id, base_id, name, label, anchors, base_anchors, documents FROM entity_namesakes ORDER BY created_at, id`);
    const byBase = new Map<string, NamesakeRule[]>();
    for (const r of rows) this.put(byBase, r);
    this.byBase = byBase;
    return byBase;
  }

  private put(byBase: Map<string, NamesakeRule[]>, r: NamesakeRule): void {
    (byBase.get(r.base_id) ?? byBase.set(r.base_id, []).get(r.base_id)!).push(r);
    this.baseOf.set(r.id, r.base_id);
  }

  /** The base entity of the family `id` belongs to and the entities parted from it; null when `id` was never parted. */
  async family(q: Queryable, id: string): Promise<{ baseId: string; rules: NamesakeRule[] } | null> {
    const byBase = await this.load(q);
    const baseId = byBase.has(id) ? id : this.baseOf.get(id);
    return baseId ? { baseId, rules: byBase.get(baseId) ?? [] } : null;
  }

  async add(q: Queryable, rule: NamesakeRule): Promise<void> {
    this.put(await this.load(q), rule);
  }
}

/** Documents an entity needs before the roof they share counts as its own. */
export const PART_MIN_DOCS = 3;
/** The share of an entity's documents that name its roof. */
export const ANCHOR_SHARE = 0.6;

/**
 * A mention whose code differs from the code of the entity its name lands on
 * (D2T1-C1 on an entity that carries D7T1-C1, or T1-C1 alone) is another thing of that name —
 * if the documents agree: the entity is in PART_MIN_DOCS documents or more,
 * ANCHOR_SHARE of them name one organization or project, this document names
 * none of those, and it has a roof of its own (the mention's team or parent,
 * else whose report it is) that none of the entity's documents names. Then
 * the mention gets an entity of its own, "name（roof · code）", and entity_namesakes
 * keeps the rule later mentions follow. Without that agreement the codes are
 * an extraction listing kinds as aliases, and the mention merges as before.
 */
async function partByCode(
  q: Queryable,
  base: CandidateRow,
  landed: CandidateRow,
  code: Code,
  mention: string,
  context: MentionContext,
  rules: NamesakeRule[],
): Promise<NamesakeRule | null> {
  const roof = (context.owners ?? []).map((o) => o.trim()).find(Boolean) ?? context.home?.trim();
  if (!roof || !context.documentNames) return null;
  const rows = await q.query<{ name: string; aliases: string[] | null; n: number; total: number }>(
    `WITH d AS (SELECT DISTINCT document_id FROM entity_mentions WHERE entity_id = $1 AND document_id IS DISTINCT FROM $3)
     SELECT o.name, o.aliases, count(DISTINCT m.document_id)::int AS n, (SELECT count(*)::int FROM d) AS total
     FROM d JOIN entity_mentions m ON m.document_id = d.document_id AND m.entity_id <> $1
     JOIN entities o ON o.id = m.entity_id AND o.tx_to IS NULL AND o.type = ANY($2::text[])
     GROUP BY o.id, o.name, o.aliases`,
    [landed.id, [...ANCHOR_TYPES], context.documentId ?? null],
  );
  if (rows.length === 0 || rows[0].total < PART_MIN_DOCS) return null;
  const lower = (x: string) => x.trim().toLowerCase();
  const spellings = (r: { name: string; aliases: string[] | null }) => [r.name, ...(r.aliases ?? [])].map(lower);
  // the roof of this document is one the entity's documents never name
  if (rows.some((r) => spellings(r).includes(lower(roof)))) return null;
  const anchors = rows.filter((r) => r.n >= ANCHOR_SHARE * r.total).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  if (anchors.length === 0) return null;
  // and this document names none of the entity's own
  if (anchors.some((r) => spellings(r).some((x) => context.documentNames!.has(x)))) return null;
  const rule: NamesakeRule = {
    id: '',
    base_id: base.id,
    name: base.name,
    label: code.raw,
    anchors: [roof],
    base_anchors: rules[0]?.base_anchors ?? anchors.map((r) => r.name),
    documents: context.documentPath ? [context.documentPath] : [],
  };
  rule.id = slugify(namesakeName(rule));
  const taken = await rowById(q, rule.id);
  if (taken && !rules.some((r) => r.id === rule.id)) return null;
  const reason = `同名不同物：「${mention}」带编号 ${code.raw}，与 ${landed.name} 的编号不同；${landed.name} 的 ${rows[0].total} 篇文档中 ${anchors[0].n} 篇与 ${anchors.map((r) => r.name).join('、')} 同现，本文档属于 ${roof}`;
  await q.query(
    `INSERT INTO entity_namesakes (id, base_id, name, label, anchors, base_anchors, documents, reason)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8) ON CONFLICT (id) DO NOTHING`,
    [rule.id, rule.base_id, rule.name, rule.label, JSON.stringify(rule.anchors), JSON.stringify(rule.base_anchors), JSON.stringify(context.documentPath ? [context.documentPath] : []), reason],
  );
  return rule;
}

async function canonicalOf(q: Queryable, row: CandidateRow): Promise<CandidateRow> {
  if (!row.canonical_id) return row;
  const target = await rowById(q, row.canonical_id);
  return target ?? row;
}

async function byKeys(q: Queryable, keys: Set<string>, type: string | undefined, mode: ReviewResolution, refusing?: (id: string) => boolean): Promise<CandidateRow | null> {
  if (keys.size === 0) return null;
  const list = [...keys];
  const ph = list.map((_, i) => `$${i + 1}`).join(',');
  // 'exact' mode ignores the suffix-stripped keys the audit keeps for itself
  const kindCond = mode === 'suffix' ? '' : " AND k.kind = 'exact'";
  const rows = await q.query<CandidateRow>(
    `SELECT DISTINCT e.id, e.name, e.type, e.canonical_id, e.mention_count, e.aliases
     FROM entity_alias_keys k JOIN entities e ON e.id = k.entity_id
     WHERE k.alias_key IN (${ph}) AND e.tx_to IS NULL${kindCond}
     ORDER BY e.mention_count DESC, e.id`,
    list,
  );
  // an entity one of the spellings names comes before a bigger one that only carries it as an alias
  const names = (r: CandidateRow) => {
    const own = nameKey(r.name);
    return keys.has(own.key) || (mode === 'suffix' && keys.has(own.bare));
  };
  for (const r of [...rows.filter(names), ...rows.filter((r) => !names(r))]) {
    if (!typesCompatible(type, r.type)) continue;
    const canonical = await canonicalOf(q, r);
    if (!refusing?.(canonical.id)) return canonical;
  }
  return null;
}

export async function resolveEntityId(
  q: Queryable,
  input: ResolveInput,
  cache?: Map<string, ResolvedEntity>,
  /**
   * `corrections`: a person's (src/graph/corrections.ts) — a spelling an entity refuses never resolves onto it.
   * `namesakes`: the parted names, read once by a caller that resolves many mentions.
   * `identity`: 'name' parts no name here (review.identity); one already parted is still followed.
   */
  opts: { mode?: ReviewResolution; corrections?: EntityCorrections; namesakes?: NamesakeIndex; identity?: ReviewIdentity } = {},
): Promise<ResolvedEntity> {
  const mode = opts.mode ?? 'exact';
  const name = input.name.trim();
  const slug = slugify(name);
  const codes = codesOf([name, ...(input.aliases ?? [])]);
  const cacheKey = `${slug}|${input.sameAs ?? ''}|${mode}|${codesKey(codes)}`;
  const hit = cache?.get(cacheKey);
  if (hit) return hit;

  const finish = (r: ResolvedEntity): ResolvedEntity => {
    cache?.set(cacheKey, r);
    return r;
  };
  const refusing = opts.corrections?.size ? (id: string) => refuses(refusedKeys(opts.corrections!.get(id)), name) : undefined;
  const namesakes = opts.namesakes ?? new NamesakeIndex();

  /** The entity the name stands for, once it landed on `landed`: one of those it was parted into, a new one a code parts from it, else `landed`. */
  const settle = async (landed: CandidateRow): Promise<ResolvedEntity> => {
    const asIs: ResolvedEntity = landed.id === slug ? { id: slug } : { id: landed.id, name: landed.name, resolvedFrom: name };
    const family = await namesakes.family(q, landed.id);
    const rules = (family?.rules ?? []).filter((r) => !refusing?.(r.id));
    const follow = async (rule: NamesakeRule): Promise<ResolvedEntity> => {
      // a parted entity a person merged back resolves to where it was merged
      const row = await rowById(q, rule.id);
      const target = row ? await canonicalOf(q, row) : null;
      if (target && target.id !== rule.id) return target.id === slug ? { id: slug } : { id: target.id, name: target.name, resolvedFrom: name };
      return { id: rule.id, name: namesakeName(rule), resolvedFrom: name, namesake: rule };
    };
    const chosen = namesakeFor(rules, { codes, context: input.context });
    if (chosen) return follow(chosen);
    const code = input.context ? conflictingCode(codes, codesOf([landed.name, ...(landed.aliases ?? [])])) : null;
    if (code && input.context && opts.identity !== 'name') {
      const base = family && family.baseId !== landed.id ? (await rowById(q, family.baseId)) ?? landed : landed;
      const rule = await partByCode(q, base, landed, code, name, input.context, rules);
      if (rule) {
        await namesakes.add(q, rule);
        return follow(rule);
      }
    }
    return asIs;
  };

  // 1. the extractor named the canonical entity outright
  if (input.sameAs && input.sameAs.trim() && input.sameAs.trim().toLowerCase() !== name.toLowerCase()) {
    const target = (await rowById(q, slugify(input.sameAs))) ?? (await byKeys(q, entityKeys(input.sameAs), input.type, 'suffix'));
    if (target && target.id !== slug) {
      const canonical = await canonicalOf(q, target);
      if (!refusing?.(canonical.id)) return finish(await settle(canonical));
    }
  }

  // 2. the slug itself is already a row (possibly merged into another)
  const own = await rowById(q, slug);
  if (own) return finish(await settle(await canonicalOf(q, own)));

  // 3. name / alias key match against live entities of a compatible type (exact spellings, or suffix-stripped too in 'suffix' mode)
  const match = await byKeys(q, mentionKeys(name, input.aliases ?? [], mode), input.type, mode, refusing);
  if (match) return finish(await settle(match));

  return finish({ id: slug });
}

/** id → canonical id for every id that was merged into another entity. */
export async function canonicalMap(q: Queryable, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const list = [...new Set(ids)];
  if (list.length === 0) return out;
  // a graph search asks about every endpoint a hop reached: one array parameter, not an IN list
  const rows = await q.query<{ id: string; canonical_id: string }>(
    `SELECT id, canonical_id FROM entities WHERE id = ANY($1::text[]) AND canonical_id IS NOT NULL`,
    [list],
  );
  for (const r of rows) out.set(r.id, r.canonical_id);
  return out;
}

/** canonical id → live entities merged into it. */
export async function membersOf(q: Queryable, canonicalIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const list = [...new Set(canonicalIds)];
  if (list.length === 0) return out;
  const rows = await q.query<{ id: string; canonical_id: string }>(
    `SELECT id, canonical_id FROM entities WHERE canonical_id = ANY($1::text[]) AND tx_to IS NULL`,
    [list],
  );
  for (const r of rows) (out.get(r.canonical_id) ?? out.set(r.canonical_id, []).get(r.canonical_id)!).push(r.id);
  return out;
}

/** The ids plus everything merged into them (for reads that must see a merged entity's evidence under the survivor). */
export async function expandGroups(q: Queryable, ids: readonly string[]): Promise<string[]> {
  const members = await membersOf(q, ids);
  const out = new Set(ids);
  for (const list of members.values()) for (const id of list) out.add(id);
  return [...out];
}

/** The live entity a name stands for. */
export interface NamedEntity {
  id: string;
  name: string;
  type: string;
  wikiPath: string | null;
}

const NAMED_BATCH = 5_000;

/**
 * The live entity each name stands for — its own spelling or an alias, exact
 * keys only — under the survivor of a merge: what a [[link]] to a name no page
 * answers to points at. Where several entities answer to one spelling a typed
 * one beats a mined concept, then the entity the spelling names beats one
 * that carries it as an alias, then the most mentioned wins. Names no entity
 * answers to are absent from the map, and so are entities the graph knows
 * only from links to them — the concept a link to an unwritten page leaves
 * (wire.ts) — or every link would be its own target.
 */
export async function entitiesNamed(q: Queryable, names: readonly string[]): Promise<Map<string, NamedEntity>> {
  const keyByName = new Map<string, string>();
  for (const n of new Set(names)) {
    const { key } = nameKey(n);
    if (key.length >= 2) keyByName.set(n, key);
  }
  const keys = [...new Set(keyByName.values())];
  const byKey = new Map<string, NamedEntity & { canonicalId: string | null; rank: number }>();
  for (let i = 0; i < keys.length; i += NAMED_BATCH) {
    const rows = await q.query<{ alias_key: string; id: string; name: string; type: string; wiki_path: string | null; canonical_id: string | null }>(
      `SELECT k.alias_key, e.id, e.name, e.type, e.wiki_path, e.canonical_id
       FROM entity_alias_keys k JOIN entities e ON e.id = k.entity_id
       WHERE k.alias_key = ANY($1::text[]) AND k.kind = 'exact' AND e.tx_to IS NULL
         AND (e.wiki_path IS NOT NULL OR e.canonical_id IS NOT NULL OR EXISTS (
           SELECT 1 FROM evidence ev WHERE ev.kind = 'entity' AND ev.target_id = e.id AND ev.tx_to IS NULL AND ev.extractor <> 'tier0.wikilink'))
       ORDER BY e.mention_count DESC, e.id`,
      [keys.slice(i, i + NAMED_BATCH)],
    );
    for (const r of rows) {
      const rank = (r.type === 'concept' ? 2 : 0) + (nameKey(r.name).key === r.alias_key ? 0 : 1);
      const best = byKey.get(r.alias_key);
      if (!best || rank < best.rank) byKey.set(r.alias_key, { id: r.id, name: r.name, type: r.type, wikiPath: r.wiki_path ?? null, canonicalId: r.canonical_id, rank });
    }
  }
  const merged = [...new Set([...byKey.values()].flatMap((e) => (e.canonicalId ? [e.canonicalId] : [])))];
  if (merged.length > 0) {
    const survivors = await q.query<{ id: string; name: string; type: string; wiki_path: string | null }>(
      `SELECT id, name, type, wiki_path FROM entities WHERE id = ANY($1::text[]) AND tx_to IS NULL`,
      [merged],
    );
    const byId = new Map(survivors.map((s) => [s.id, s]));
    for (const [key, e] of byKey) {
      const s = e.canonicalId ? byId.get(e.canonicalId) : undefined;
      if (s) byKey.set(key, { id: s.id, name: s.name, type: s.type, wikiPath: s.wiki_path ?? null, canonicalId: null, rank: e.rank });
    }
  }
  const out = new Map<string, NamedEntity>();
  for (const [n, key] of keyByName) {
    const e = byKey.get(key);
    if (e) out.set(n, { id: e.id, name: e.name, type: e.type, wikiPath: e.wikiPath });
  }
  return out;
}

const modeCache = new Map<string, { stamp: string; mode: ReviewResolution; identity: ReviewIdentity }>();

function reviewModes(dataDir: string): { mode: ReviewResolution; identity: ReviewIdentity } {
  const file = path.join(dataDir, CONFIG_FILE);
  let stamp = 'none';
  try {
    const st = fs.statSync(file);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    // no config file: defaults apply
  }
  const hit = modeCache.get(dataDir);
  if (hit && hit.stamp === stamp) return hit;
  let mode: ReviewResolution = 'exact';
  let identity: ReviewIdentity = 'context';
  try {
    const cfg = loadConfig(dataDir);
    mode = cfg.review?.resolution === 'suffix' ? 'suffix' : 'exact';
    identity = cfg.review?.identity === 'name' ? 'name' : 'context';
  } catch {
    mode = 'exact';
  }
  const entry = { stamp, mode, identity };
  modeCache.set(dataDir, entry);
  return entry;
}

/** `review.resolution` for a data dir, re-read when knode.config.json changes. */
export function resolutionMode(dataDir: string): ReviewResolution {
  return reviewModes(dataDir).mode;
}

/** `review.identity` for a data dir ('context' unless set to 'name'), re-read when knode.config.json changes. */
export function identityMode(dataDir: string): ReviewIdentity {
  return reviewModes(dataDir).identity;
}
