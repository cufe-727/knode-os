import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, loadConfig, ReviewResolution } from '../config.js';
import { Queryable } from '../store/migrations.js';
import { EntityCorrections, refusedKeys, refuses } from './corrections.js';
import { codeOf, codesDiffer, codesKey, codesOf, MentionContext, namesakeFor, namesakeName, NamesakeRule } from './identity.js';
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
 * lands on was parted into several by refine (entity_namesakes: a person and
 * a namesake, a setting ten divisions each have), the mention's code, its
 * team or parent and its document's organizations say which of them it
 * means. Nothing is parted here: one document cannot tell, and the order
 * documents arrive in must not decide. A mention with no such context
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
}

async function canonicalOf(q: Queryable, row: CandidateRow): Promise<CandidateRow> {
  if (!row.canonical_id) return row;
  const target = await rowById(q, row.canonical_id);
  return target ?? row;
}

/**
 * The identifier a name is, when the name is one: "INC-020-D3T3", "R-71",
 * "事故INC-020-D3T3" (a kind word of up to four characters before it).
 */
export function nameCode(name: string): ReturnType<typeof codeOf> {
  const t = name.normalize('NFKC').trim();
  return codeOf(t) ?? codeOf(t.replace(/^\p{Script=Han}{1,4}/u, '').replace(/\p{Script=Han}{1,4}$/u, ''));
}

/**
 * Two names that are each an identifier of one kind with different values
 * (INC-017-D7T3, INC-020-D3T3) are two things, whatever spellings they share.
 * A mention matched by an alias would otherwise land on the other: an
 * extraction lists the incident's title as an alias ("活动页白屏"), every
 * team's incident of that title carries it, and the first such incident took
 * the later ones' claims (11 of 210 incidents on the 10× benchmark, among them
 * fixes credited to another division's engineer). Only the two names count,
 * not alias lists, so the order documents arrive in decides nothing: each
 * identifier gets its own entity. For the same reason a spelling without an
 * identifier that several such entities carry as an alias resolves to none
 * of them (byKeys).
 */
export function namesApartByCode(a: string, b: string): boolean {
  const x = nameCode(a);
  const y = nameCode(b);
  return Boolean(x && y && codesDiffer(x, y));
}

/**
 * Whether live entities are named by other identifiers of the kind `name` is
 * one of (INC-001-T1 … beside INC-006-T1): a numbered series. Only a kind
 * whose identifiers start with letters is looked for (a ticker such as
 * 600519.SH is not), by the letters before its first digit.
 */
async function numberedSeries(q: Queryable, name: string): Promise<boolean> {
  const code = nameCode(name);
  const prefix = code ? /^[A-Z][A-Z._/-]*/.exec(code.value)?.[0] : undefined;
  if (!code || !prefix) return false;
  const rows = await q.query<{ name: string }>(
    `SELECT name FROM entities WHERE tx_to IS NULL AND canonical_id IS NULL AND upper(name) LIKE $1 LIMIT 50`,
    [`%${prefix.replace(/[%_\\]/g, (c) => `\\${c}`)}%`],
  );
  return rows.some((r) => namesApartByCode(name, r.name));
}

async function byKeys(q: Queryable, keys: Set<string>, type: string | undefined, mode: ReviewResolution, refusing?: (id: string) => boolean, mention?: string): Promise<CandidateRow | null> {
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
  // a spelling several identifiers carry as an alias names none of them: "登录失败事故" is the title of
  // every team's incident of that kind, and landing on the most mentioned one credited a fix to it
  const coded = mention && !nameCode(mention) ? rows.filter((r) => !names(r) && typesCompatible(type, r.type) && nameCode(r.name)) : [];
  const shared = coded.some((a, i) => coded.slice(i + 1).some((b) => namesApartByCode(a.name, b.name)));
  for (const r of [...rows.filter(names), ...rows.filter((r) => !names(r))]) {
    if (!typesCompatible(type, r.type)) continue;
    if (shared && coded.includes(r)) continue;
    if (mention && namesApartByCode(mention, r.name)) continue;
    const canonical = await canonicalOf(q, r);
    if (mention && canonical.id !== r.id && namesApartByCode(mention, canonical.name)) continue;
    if (!refusing?.(canonical.id)) return canonical;
  }
  return null;
}

/**
 * Which entity a mention means once its name landed on `landed`, where that
 * entity belongs to a name refine parted (identity.ts, namesakeFor): another
 * entity of that name, or null when it stays where it landed. Reads only.
 */
export async function followNamesake(
  q: Queryable,
  landed: { id: string; name: string },
  mention: { name: string; spellings: readonly string[]; context?: MentionContext },
  namesakes: NamesakeIndex,
  refusing?: (id: string) => boolean,
): Promise<{ id: string; name: string; rule?: NamesakeRule } | null> {
  const family = await namesakes.family(q, landed.id);
  if (!family) return null;
  // a mention that names a parted entity by its own name means that one
  if (landed.id !== family.baseId && nameKey(landed.name).key === nameKey(mention.name).key) return null;
  const rules = family.rules.filter((r) => !refusing?.(r.id));
  const base = landed.id === family.baseId ? landed : (await rowById(q, family.baseId)) ?? landed;
  const context = mention.context;
  // which entity each roof is: an alias of a team, or a team merged into another, is that team
  const roofs = [...new Set([...rules.flatMap((r) => [...r.anchors, ...r.base_anchors]), ...(context?.owners ?? []), ...(context?.documentNames ?? [])])];
  const known = await entitiesNamed(q, roofs);
  const same = (n: string) => known.get(n)?.id ?? `~${nameKey(n).key}`;
  // a spelling only one of the name's entities answers to — and that one a parted entity — means it
  const keys = [...mentionKeys(mention.name, mention.spellings, 'exact')];
  const members = [family.baseId, ...rules.filter((r) => r.id !== r.base_id).map((r) => r.id)];
  const carried = keys.length === 0 ? [] : await q.query<{ entity_id: string; alias_key: string }>(
    `SELECT DISTINCT entity_id, alias_key FROM entity_alias_keys WHERE entity_id = ANY($1::text[]) AND alias_key = ANY($2::text[]) AND kind = 'exact'`,
    [members, keys],
  );
  const carriers = new Map<string, Set<string>>();
  for (const r of carried) (carriers.get(r.alias_key) ?? carriers.set(r.alias_key, new Set()).get(r.alias_key)!).add(r.entity_id);
  const alone = new Set([...carriers.values()].filter((c) => c.size === 1).map((c) => [...c][0]).filter((id) => id !== family.baseId));
  const only = alone.size === 1 ? [...alone][0] : null;
  const chosen = namesakeFor(rules, { codes: codesOf(mention.spellings), baseCodes: codesOf([base.name]), only, context }, same);
  if (!chosen) return base.id === landed.id ? null : { id: base.id, name: base.name };
  // a parted entity a person merged back resolves to where it was merged
  const row = await rowById(q, chosen.id);
  const target = row ? await canonicalOf(q, row) : null;
  if (target && target.id !== chosen.id) return target.id === landed.id ? null : { id: target.id, name: target.name };
  return chosen.id === landed.id ? null : { id: chosen.id, name: namesakeName(chosen), rule: chosen };
}

export async function resolveEntityId(
  q: Queryable,
  input: ResolveInput,
  cache?: Map<string, ResolvedEntity>,
  /**
   * `corrections`: a person's (src/graph/corrections.ts) — a spelling an entity refuses never resolves onto it.
   * `namesakes`: the parted names, read once by a caller that resolves many mentions.
   */
  opts: { mode?: ReviewResolution; corrections?: EntityCorrections; namesakes?: NamesakeIndex } = {},
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

  /** The entity the name stands for, once it landed on `landed`: one of those it was parted into, else `landed`. */
  const settle = async (landed: CandidateRow): Promise<ResolvedEntity> => {
    const asIs: ResolvedEntity = landed.id === slug ? { id: slug } : { id: landed.id, name: landed.name, resolvedFrom: name };
    const meant = await followNamesake(q, landed, { name, spellings: [name, ...(input.aliases ?? [])], context: input.context }, namesakes, refusing);
    if (!meant) return asIs;
    return meant.id === slug ? { id: slug } : { id: meant.id, name: meant.name, resolvedFrom: name, ...(meant.rule ? { namesake: meant.rule } : {}) };
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
  // a name that is one of a numbered series ("INC-006-T1" beside other INC-… entities) is that thing by its
  // number alone: its other spellings (the incident's title) are what every incident of the kind is called
  const code = nameCode(name);
  if (code && (input.aliases ?? []).length > 0 && (await numberedSeries(q, name))) {
    const byNumber = await byKeys(q, mentionKeys(name, [], mode), input.type, mode, refusing, name);
    return finish(byNumber ? await settle(byNumber) : { id: slug });
  }
  const match = await byKeys(q, mentionKeys(name, input.aliases ?? [], mode), input.type, mode, refusing, name);
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

const modeCache = new Map<string, { stamp: string; mode: ReviewResolution }>();

/** `review.resolution` for a data dir, re-read when knode.config.json changes. */
export function resolutionMode(dataDir: string): ReviewResolution {
  const file = path.join(dataDir, CONFIG_FILE);
  let stamp = 'none';
  try {
    const st = fs.statSync(file);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    // no config file: defaults apply
  }
  const hit = modeCache.get(dataDir);
  if (hit && hit.stamp === stamp) return hit.mode;
  let mode: ReviewResolution = 'exact';
  try {
    const cfg = loadConfig(dataDir);
    mode = cfg.review?.resolution === 'suffix' ? 'suffix' : 'exact';
  } catch {
    mode = 'exact';
  }
  modeCache.set(dataDir, { stamp, mode });
  return mode;
}
