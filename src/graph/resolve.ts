import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, loadConfig, ReviewResolution } from '../config.js';
import { Queryable } from '../store/migrations.js';
import { entityKeys, mentionKeys, typesCompatible } from './normalize.js';
import { slugify } from './store.js';

/**
 * Write-time entity resolution. Before the writer assigns `slugify(name)` as
 * a new entity's id it asks whether the graph already knows that thing under
 * another spelling: an explicit `sameAs` from the extractor, an existing row
 * with the same slug, or a name / alias key match (see normalize.ts). A match
 * returns the *canonical* id, so mentions of an entity that was merged into
 * another land on the survivor.
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

async function byKeys(q: Queryable, keys: Set<string>, type: string | undefined, mode: ReviewResolution): Promise<CandidateRow | null> {
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
  for (const r of rows) {
    if (typesCompatible(type, r.type)) return canonicalOf(q, r);
  }
  return null;
}

export async function resolveEntityId(q: Queryable, input: ResolveInput, cache?: Map<string, ResolvedEntity>, opts: { mode?: ReviewResolution } = {}): Promise<ResolvedEntity> {
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

  // 1. the extractor named the canonical entity outright
  if (input.sameAs && input.sameAs.trim() && input.sameAs.trim().toLowerCase() !== name.toLowerCase()) {
    const target = (await rowById(q, slugify(input.sameAs))) ?? (await byKeys(q, entityKeys(input.sameAs), input.type, 'suffix'));
    if (target && target.id !== slug) {
      const canonical = await canonicalOf(q, target);
      return finish({ id: canonical.id, name: canonical.name, resolvedFrom: name });
    }
  }

  // 2. the slug itself is already a row (possibly merged into another)
  const own = await rowById(q, slug);
  if (own) {
    const canonical = await canonicalOf(q, own);
    return finish(canonical.id === slug ? { id: slug } : { id: canonical.id, name: canonical.name, resolvedFrom: name });
  }

  // 3. name / alias key match against live entities of a compatible type (exact spellings, or suffix-stripped too in 'suffix' mode)
  const match = await byKeys(q, mentionKeys(name, input.aliases ?? [], mode), input.type, mode);
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
