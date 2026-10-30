import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from '../compiler/intents.js';
import { ENTITY_CORRECTIONS_DIR } from '../fs/layout.js';
import { writeAtomic } from '../fs/sidecar.js';
import { nameKey } from './normalize.js';

/**
 * Corrections a person made to single entities, kept in
 * `playbooks/entities/corrections.yaml` by entity id. The fold
 * (src/lineage/fold.ts) applies them over whatever the extractors said:
 *
 *   type        replaces the folded type. The fold goes by the ontology's
 *               precedence, where one stray "organization" reading outranks a
 *               thousand "theme" ones (人工智能 in finance, 2026-10-30).
 *   notAliases  spellings the entity does not answer to. They leave its alias
 *               list and its lookup keys — with or without a corporate suffix,
 *               whichever merged member brought them — so nothing links or
 *               marks them as this entity, and extraction stops resolving them
 *               onto it (src/graph/resolve.ts, src/lineage/writer.ts). An
 *               extraction merge that filed 创业板 under A股 otherwise pulls
 *               every later 创业板 onto A股, and the alias with it.
 *
 * Evidence is never rewritten: an entry taken out brings back what the
 * extractors said at the entity's next fold. `knode-os entities correct`
 * writes an entry and refolds the entity; a hand edit applies when the entity
 * next folds. The file is declared state, so a rebuild keeps it.
 */

export const ENTITY_CORRECTIONS_FILE = `${ENTITY_CORRECTIONS_DIR}/corrections.yaml`;

export interface EntityCorrection {
  /** The entity's name when it was corrected, for whoever reads the file (the id is the key). */
  name?: string;
  type?: string;
  /** Spellings as a person wrote them; compared by normalized key. */
  notAliases?: string[];
  reason?: string;
  by?: string;
  at?: string;
}

/** Entity id → its correction. */
export type EntityCorrections = ReadonlyMap<string, EntityCorrection>;

const NO_KEYS: ReadonlySet<string> = new Set();

function text(v: unknown): string | undefined {
  if (v instanceof Date) return v.toISOString();
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function strings(v: unknown): string[] {
  const list = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  return list.flatMap((x) => (typeof x === 'string' || typeof x === 'number' ? [String(x).trim()] : [])).filter(Boolean);
}

export function parseEntityCorrections(source: string): Map<string, EntityCorrection> {
  const out = new Map<string, EntityCorrection>();
  const raw = parseYaml(source).entities;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = key.trim();
    if (!id || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const o = value as Record<string, unknown>;
    const c: EntityCorrection = {};
    const name = text(o.name);
    if (name) c.name = name;
    const type = text(o.type);
    if (type) c.type = type;
    const notAliases = strings(o.notAliases ?? o.not_aliases);
    if (notAliases.length) c.notAliases = notAliases;
    if (!c.type && !c.notAliases) continue;
    const reason = text(o.reason);
    if (reason) c.reason = reason;
    const by = text(o.by);
    if (by) c.by = by;
    const at = text(o.at);
    if (at) c.at = at;
    out.set(id, c);
  }
  return out;
}

const cache = new Map<string, { stamp: string; entries: EntityCorrections }>();

/** The workspace's corrections, read again when the file changes. */
export function readEntityCorrections(dataDir: string): EntityCorrections {
  const abs = path.join(dataDir, ENTITY_CORRECTIONS_FILE);
  let stamp = 'none';
  try {
    const st = fs.statSync(abs);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    // no corrections yet
  }
  const hit = cache.get(dataDir);
  if (hit && hit.stamp === stamp) return hit.entries;
  let entries: EntityCorrections = new Map();
  if (stamp !== 'none') {
    try {
      entries = parseEntityCorrections(fs.readFileSync(abs, 'utf8'));
    } catch {
      // unreadable between a stat and a read: the next call tries again
      return hit?.entries ?? entries;
    }
  }
  cache.set(dataDir, { stamp, entries });
  return entries;
}

export function writeEntityCorrections(dataDir: string, entries: EntityCorrections): void {
  const q = (s: string) => JSON.stringify(s);
  const lines = [
    '# Corrections a person made to single entities (src/graph/corrections.ts), by entity id.',
    '# `type` replaces the type the fold picked; `notAliases` are spellings the entity does',
    '# not answer to. Evidence is untouched: an entry taken out brings back what the',
    '# extractors said. `knode-os entities correct` writes this file and refolds the entity;',
    '# a hand edit applies when the entity next folds.',
  ];
  if (entries.size === 0) lines.push('entities: {}');
  else lines.push('entities:');
  for (const [id, c] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${q(id)}:`);
    if (c.name) lines.push(`    name: ${q(c.name)}`);
    if (c.type) lines.push(`    type: ${q(c.type)}`);
    if (c.notAliases?.length) lines.push(`    notAliases: [${c.notAliases.map(q).join(', ')}]`);
    if (c.reason) lines.push(`    reason: ${q(c.reason)}`);
    if (c.by) lines.push(`    by: ${q(c.by)}`);
    if (c.at) lines.push(`    at: ${q(c.at)}`);
  }
  writeAtomic(path.join(dataDir, ENTITY_CORRECTIONS_FILE), lines.join('\n') + '\n');
  cache.delete(dataDir);
}

/** Normalized keys of the spellings a correction says its entity does not answer to. */
export function refusedKeys(c: EntityCorrection | undefined): ReadonlySet<string> {
  if (!c?.notAliases?.length) return NO_KEYS;
  const out = new Set<string>();
  for (const s of c.notAliases) {
    const { key } = nameKey(s);
    if (key) out.add(key);
  }
  return out;
}

/** Whether `spelling` is one of those keys, as written or without a corporate suffix (中国船舶 refuses 中国船舶集团 too). */
export function refuses(keys: ReadonlySet<string>, spelling: string): boolean {
  if (keys.size === 0 || typeof spelling !== 'string') return false;
  const { key, bare } = nameKey(spelling);
  return keys.has(key) || keys.has(bare);
}
