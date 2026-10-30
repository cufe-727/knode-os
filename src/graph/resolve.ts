import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, loadConfig, ReviewResolution } from '../config.js';
import { Queryable } from '../store/migrations.js';
import { EntityCorrections, refusedKeys, refuses } from './corrections.js';
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
 */

export interface ResolveInput {
  name: string;
  type?: string;
  aliases?: string[];
  /** Canonical name the extractor believes this entity is the same as. */
  sameAs?: string | null;
}

export interface ResolvedEntity {
  id: string;
  /** Current name of the entity the mention resolved to (undefined for a new id). */
  name?: string;
  /** Set when the mention resolved to an entity other than `slugify(name)`. */
  resolvedFrom?: string;
}

interface CandidateRow {
  id: string;
  name: string;
  type: string;
  canonical_id: string | null;
  mention_count: number;
}

async function rowById(q: Queryable, id: string): Promise<CandidateRow | null> {
  const rows = await q.query<CandidateRow>(`SELECT id, name, type, canonical_id, mention_count FROM entities WHERE id = $1`, [id]);
  return rows[0] ?? null;
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
    `SELECT DISTINCT e.id, e.name, e.type, e.canonical_id, e.mention_count
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
  /** `corrections`: a person's (src/graph/corrections.ts) — a spelling an entity refuses never resolves onto it. */
  opts: { mode?: ReviewResolution; corrections?: EntityCorrections } = {},
): Promise<ResolvedEntity> {
  const mode = opts.mode ?? 'exact';
  const name = input.name.trim();
  const slug = slugify(name);
  const cacheKey = `${slug}|${input.sameAs ?? ''}|${mode}`;
  const hit = cache?.get(cacheKey);
  if (hit) return hit;

  const finish = (r: ResolvedEntity): ResolvedEntity => {
    cache?.set(cacheKey, r);
    return r;
  };
  const refusing = opts.corrections?.size ? (id: string) => refuses(refusedKeys(opts.corrections!.get(id)), name) : undefined;

  // 1. the extractor named the canonical entity outright
  if (input.sameAs && input.sameAs.trim() && input.sameAs.trim().toLowerCase() !== name.toLowerCase()) {
    const target = (await rowById(q, slugify(input.sameAs))) ?? (await byKeys(q, entityKeys(input.sameAs), input.type, 'suffix'));
    if (target && target.id !== slug) {
      const canonical = await canonicalOf(q, target);
      if (!refusing?.(canonical.id)) return finish({ id: canonical.id, name: canonical.name, resolvedFrom: name });
    }
  }

  // 2. the slug itself is already a row (possibly merged into another)
  const own = await rowById(q, slug);
  if (own) {
    const canonical = await canonicalOf(q, own);
    return finish(canonical.id === slug ? { id: slug } : { id: canonical.id, name: canonical.name, resolvedFrom: name });
  }

  // 3. name / alias key match against live entities of a compatible type (exact spellings, or suffix-stripped too in 'suffix' mode)
  const match = await byKeys(q, mentionKeys(name, input.aliases ?? [], mode), input.type, mode, refusing);
  if (match) return finish({ id: match.id, name: match.name, resolvedFrom: name });

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
