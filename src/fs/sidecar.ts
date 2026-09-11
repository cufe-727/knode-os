import fs from 'node:fs';
import path from 'node:path';
import { safePath } from './files.js';

/**
 * Sidecar files — one `<name>.knode.json` next to each cooked document.
 *
 * The sidecar extends gbrain's "files are truth" rule to derived data that is
 * expensive to rebuild: LLM extraction results and usage statistics live here,
 * so deleting `.knode/` and re-ingesting never re-pays LLM cost (tier-1
 * results are replayed when `extraction.tier1.contentSha` still matches) and
 * never loses heat history.
 *
 * The DB is the real-time ledger for usage; the sidecar is the persistent
 * snapshot, flushed periodically off the hot path.
 */

const SIDECAR_SUFFIX = '.knode.json';

export interface SidecarChunkMeta {
  id: string;
  seq: number;
  tokenCount: number;
}

export interface SidecarTier0 {
  concepts: string[];
  wikilinks: string[];
  extractedAt: string;
  /** Frontmatter-declared entities / claims (tier 0.5), kept so a removed source can be replayed from the attic. */
  declared?: { entities: SidecarEntity[]; claims: SidecarClaim[] } | null;
}

export interface SidecarEntity {
  name: string;
  type: string;
  description?: string;
  aliases?: string[];
}

export interface SidecarRelation {
  source: string;
  target: string;
  type: string;
  description?: string;
}

export interface SidecarClaim {
  subject: string;
  object?: string | null;
  type: string;
  statement: string;
  status: 'fact' | 'suspected' | 'disputed' | 'absent';
  startDate?: string | null;
  endDate?: string | null;
}

export interface SidecarTier1 {
  status: 'pending' | 'done' | 'failed';
  entities: SidecarEntity[];
  relations: SidecarRelation[];
  claims?: SidecarClaim[];
  model: string;
  /** sha256 of the cooked content the extraction was computed from. */
  contentSha: string;
  extractedAt: string;
  error?: string;
}

export interface SidecarUsage {
  firstSeenAt: string;
  lastAccessedAt: string | null;
  accessCount: number;
  heat: number;
  chunkHits: Record<string, { count: number; lastAt: string }>;
  flushedAt: string | null;
}

/** Cached LLM view outputs keyed by the content they were derived from. */
export interface SidecarViews {
  sourceSummary?: {
    contentSha: string;
    model: string;
    body: string;
    generatedAt: string;
  };
}

export interface Sidecar {
  version: 1;
  meta: {
    /** sha256 of the cooked Markdown consumed by the index. */
    sha256: string;
    /** sha256 of the original raw source; differs from sha256 after conversion. */
    sourceSha256?: string;
    title: string | null;
    sourceType: string;
    rawPath: string;
    /** Cache identity for PDF/image conversion (converter version + model). */
    conversionKey?: string;
    conversion?: {
      kind: string;
      model: string;
      warnings?: string[];
    };
    ingestedAt: string;
    chunks: SidecarChunkMeta[];
  };
  extraction: {
    tier0?: SidecarTier0;
    tier1?: SidecarTier1;
  };
  usage: SidecarUsage;
  /** Generated-view caches (e.g. the wiki source summary) — survive DB rebuilds like tier-1 results. */
  views?: SidecarViews;
}

function sidecarPathFor(cookedRel: string): string {
  return cookedRel + SIDECAR_SUFFIX;
}

export function isSidecarPath(rel: string): boolean {
  return rel.endsWith(SIDECAR_SUFFIX);
}

/**
 * Tier-1 extraction that can be replayed for free: status is done and the
 * content hash still matches. Shared by ingest replay and the tier-1 queue.
 */
export function replayableTier1(sidecar: Sidecar | null | undefined, contentSha: string): SidecarTier1 | null {
  const t1 = sidecar?.extraction.tier1;
  return t1 && t1.status === 'done' && t1.contentSha === contentSha ? t1 : null;
}

export function emptyUsage(now = new Date().toISOString()): SidecarUsage {
  return { firstSeenAt: now, lastAccessedAt: null, accessCount: 0, heat: 0, chunkHits: {}, flushedAt: null };
}

export function readSidecar(dataDir: string, cookedRel: string): Sidecar | null {
  const abs = safePath(dataDir, sidecarPathFor(cookedRel));
  if (!fs.existsSync(abs)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf8')) as Sidecar;
    if (parsed?.version !== 1 || !parsed.meta) return null;
    return parsed;
  } catch {
    return null; // corrupt sidecar — treated as absent, will be regenerated
  }
}

/** Atomic write (tmp + rename) so a crash never leaves a half-written sidecar. */
export function writeSidecar(dataDir: string, cookedRel: string, sidecar: Sidecar): void {
  const abs = safePath(dataDir, sidecarPathFor(cookedRel));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(sidecar, null, 2) + '\n');
  fs.renameSync(tmp, abs);
}

/** Merge-update a sidecar on disk; creates nothing if it doesn't exist. */
export function updateSidecar(
  dataDir: string,
  cookedRel: string,
  mutate: (s: Sidecar) => void,
): Sidecar | null {
  const cur = readSidecar(dataDir, cookedRel);
  if (!cur) return null;
  mutate(cur);
  writeSidecar(dataDir, cookedRel, cur);
  return cur;
}

export function removeSidecar(dataDir: string, cookedRel: string): void {
  const abs = safePath(dataDir, sidecarPathFor(cookedRel));
  fs.rmSync(abs, { force: true });
}
