import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safePath } from './files.js';
import { SIDECAR_ROOT, sidecarRelFor } from './layout.js';

/**
 * Sidecars — one directory per source under `<data>/.sidecar/<key>/`, split
 * by lifecycle so each writer touches only its own file:
 *
 *   content.md               converted Markdown (PDF / image / trace episode); text sources have none
 *   meta.json                identity: source + content hashes, conversion cache key, chunk map
 *   tier0.json               zero-LLM extraction (concepts, wikilinks, declared frontmatter facts)
 *   tier1.json               LLM extraction, replayable while `contentSha` matches
 *   usage.json               heat snapshot, flushed hourly from the DB
 *   views/source-summary.md  cached LLM source summary (frontmatter = cache key)
 *
 * The sidecar extends gbrain's "files are truth" rule to derived data that is
 * expensive to rebuild: deleting `.knode/` and re-ingesting never re-pays LLM
 * cost and never loses heat history. Every file is written atomically
 * (tmp + rename); the tmp name is unique per writer so the tier-1 loop, the
 * usage flush and an apply can run concurrently on the same directory.
 */

export const SIDECAR_VERSION = 2;

export interface SidecarChunkMeta {
  id: string;
  seq: number;
  tokenCount: number;
}

export interface SidecarConversion {
  /** Cache identity of the conversion (converter version + model + limits). */
  key: string;
  kind: string;
  model: string;
  warnings?: string[];
}

export interface SidecarMeta {
  version: typeof SIDECAR_VERSION;
  /** The source key, e.g. raw/docs/report.pdf. */
  rawPath: string;
  sourceType: string;
  /** sha256 of the original bytes. */
  sourceSha256: string;
  /** sha256 of the indexed text — the scope sha; differs from sourceSha256 after conversion / normalization. */
  contentSha256: string;
  /** Byte length of the indexed text (documents.bytes). */
  contentBytes: number;
  /** Version of the frontmatter normalizer baked into contentSha256. */
  normalizer: number;
  conversion?: SidecarConversion;
  title: string | null;
  ingestedAt: string;
  chunks: SidecarChunkMeta[];
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

export interface SidecarTier0 {
  /** sha256 of the content the extraction was computed from. */
  contentSha: string;
  concepts: string[];
  wikilinks: string[];
  extractedAt: string;
  /** Frontmatter-declared entities / claims (tier 0.5), kept so a removed source can be replayed from the attic. */
  declared?: { entities: SidecarEntity[]; claims: SidecarClaim[] } | null;
}

export interface SidecarTier1 {
  status: 'pending' | 'done' | 'failed';
  entities: SidecarEntity[];
  relations: SidecarRelation[];
  claims?: SidecarClaim[];
  model: string;
  /** sha256 of the content the extraction was computed from. */
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

/** Cached LLM source summary, keyed by the content it was derived from. */
export interface SourceSummaryCache {
  contentSha: string;
  model: string;
  generatedAt: string;
  body: string;
}

/** The assembled in-memory view of a sidecar directory. */
export interface Sidecar {
  version: typeof SIDECAR_VERSION;
  meta: SidecarMeta;
  extraction: {
    tier0?: SidecarTier0;
    tier1?: SidecarTier1;
  };
  usage: SidecarUsage;
}

export type SidecarPart = 'meta' | 'tier0' | 'tier1' | 'usage';

export interface SidecarParts {
  meta: SidecarMeta;
  tier0: SidecarTier0;
  tier1: SidecarTier1;
  usage: SidecarUsage;
}

const PART_FILES: Record<SidecarPart, string> = {
  meta: 'meta.json',
  tier0: 'tier0.json',
  tier1: 'tier1.json',
  usage: 'usage.json',
};
const CONTENT_FILE = 'content.md';
const VIEWS_DIR = 'views';
const SOURCE_SUMMARY_FILE = `${VIEWS_DIR}/source-summary.md`;

/* ------------------------------ low level ------------------------------ */

/** Atomic write: unique tmp file in the same directory, then rename. */
export function writeAtomic(abs: string, data: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, abs);
}

function readJson<T>(abs: string): T | null {
  if (!fs.existsSync(abs)) return null;
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8')) as T;
  } catch {
    return null; // corrupt part — treated as absent, regenerated by its writer
  }
}

/**
 * Markdown cache file: a frontmatter block of JSON-quoted strings carries the
 * cache key, the body is the cached text verbatim. Written and read by this
 * module only, with a deliberately tiny format: JSON-quoted values can never
 * form a `---` line, so a body that itself opens with a fence survives, and
 * ISO timestamps stay strings instead of being coerced into YAML dates.
 */
export function writeMarkdownCache(abs: string, frontmatter: Record<string, string>, body: string): void {
  const head = Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  writeAtomic(abs, `---\n${head}\n---\n${body}${body.endsWith('\n') ? '' : '\n'}`);
}

export function readMarkdownCache(abs: string): { frontmatter: Record<string, unknown>; body: string } | null {
  if (!fs.existsSync(abs)) return null;
  const text = fs.readFileSync(abs, 'utf8');
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return null;
  const frontmatter: Record<string, unknown> = {};
  for (const line of text.slice(4, end).split('\n')) {
    const at = line.indexOf(': ');
    if (at === -1) continue;
    try {
      frontmatter[line.slice(0, at)] = JSON.parse(line.slice(at + 2));
    } catch {
      return null; // not one of ours — regenerated by its writer
    }
  }
  return { frontmatter, body: text.slice(end + 5).replace(/\n$/, '') };
}

/** Frontmatter string value of a cache file, or null when missing / not a string. */
export function cacheString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/* ------------------------------ locations ------------------------------ */

/** Absolute sidecar directory for a source key. */
export function sidecarDir(dataDir: string, key: string): string {
  return safePath(dataDir, sidecarRelFor(key));
}

/** A sidecar exists once its meta.json does. */
export function hasSidecar(dataDir: string, key: string): boolean {
  return isFile(path.join(sidecarDir(dataDir, key), PART_FILES.meta));
}

function isFile(abs: string): boolean {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

/* -------------------------------- parts -------------------------------- */

function readPartFrom<P extends SidecarPart>(absDir: string, part: P): SidecarParts[P] | null {
  const value = readJson<SidecarParts[P]>(path.join(absDir, PART_FILES[part]));
  if (!value || typeof value !== 'object') return null;
  if (part === 'meta') {
    const m = value as SidecarMeta;
    if (m.version !== SIDECAR_VERSION || typeof m.rawPath !== 'string' || typeof m.contentSha256 !== 'string') return null;
  }
  return value;
}

export function readSidecarPart<P extends SidecarPart>(dataDir: string, key: string, part: P): SidecarParts[P] | null {
  return readPartFrom(sidecarDir(dataDir, key), part);
}

export function writeSidecarPart<P extends SidecarPart>(dataDir: string, key: string, part: P, value: SidecarParts[P]): void {
  writeAtomic(path.join(sidecarDir(dataDir, key), PART_FILES[part]), JSON.stringify(value, null, 2) + '\n');
}

/**
 * Read-mutate-write one part. Returns null without writing when the sidecar
 * does not exist (no meta.json), so writers never create orphan directories.
 * `cur` is null when that part has not been written yet (never for `meta`).
 */
export function updateSidecarPart<P extends SidecarPart>(
  dataDir: string,
  key: string,
  part: P,
  mutate: (cur: SidecarParts[P] | null) => SidecarParts[P],
): SidecarParts[P] | null {
  if (!hasSidecar(dataDir, key)) return null;
  const next = mutate(readSidecarPart(dataDir, key, part));
  writeSidecarPart(dataDir, key, part, next);
  return next;
}

/* ------------------------------ assembled ------------------------------ */

/** Assemble the sidecar from its parts; null unless a valid meta.json exists. */
export function readSidecarFromDir(absDir: string): Sidecar | null {
  const meta = readPartFrom(absDir, 'meta');
  if (!meta) return null;
  const tier0 = readPartFrom(absDir, 'tier0') ?? undefined;
  const tier1 = readPartFrom(absDir, 'tier1') ?? undefined;
  const usage = readPartFrom(absDir, 'usage') ?? emptyUsage(meta.ingestedAt);
  return { version: SIDECAR_VERSION, meta, extraction: { tier0, tier1 }, usage };
}

export function readSidecar(dataDir: string, key: string): Sidecar | null {
  return readSidecarFromDir(sidecarDir(dataDir, key));
}

/**
 * Remove everything this sidecar owns. Only the known files and `views/` are
 * deleted, so a nested sidecar of a longer key (`raw/docs/notes` next to
 * `raw/docs/notes/x.md`) survives; empty parents are pruned up to the root.
 */
export function removeSidecar(dataDir: string, key: string): void {
  const dir = sidecarDir(dataDir, key);
  if (!fs.existsSync(dir)) return;
  for (const file of [...Object.values(PART_FILES), CONTENT_FILE]) fs.rmSync(path.join(dir, file), { force: true });
  fs.rmSync(path.join(dir, VIEWS_DIR), { recursive: true, force: true });
  pruneEmpty(dir, safePath(dataDir, SIDECAR_ROOT));
}

/** Move a sidecar along with its source (`/api/mv`), so a moved PDF is not converted again. */
export function moveSidecar(dataDir: string, fromKey: string, toKey: string): boolean {
  const src = sidecarDir(dataDir, fromKey);
  if (!fs.existsSync(src)) return false;
  const dst = sidecarDir(dataDir, toKey);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst);
  pruneEmpty(path.dirname(src), safePath(dataDir, SIDECAR_ROOT));
  return true;
}

function pruneEmpty(dir: string, stopAt: string): void {
  let cur = dir;
  while (cur.startsWith(stopAt + path.sep)) {
    try {
      if (fs.readdirSync(cur).length > 0) return;
      fs.rmdirSync(cur);
    } catch {
      return;
    }
    cur = path.dirname(cur);
  }
}

/* ------------------------------- content ------------------------------- */

export function readContent(dataDir: string, key: string): string | null {
  const abs = path.join(sidecarDir(dataDir, key), CONTENT_FILE);
  return isFile(abs) ? fs.readFileSync(abs, 'utf8') : null;
}

export function writeContent(dataDir: string, key: string, text: string): void {
  writeAtomic(path.join(sidecarDir(dataDir, key), CONTENT_FILE), text);
}

export function hasContent(dataDir: string, key: string): boolean {
  return isFile(path.join(sidecarDir(dataDir, key), CONTENT_FILE));
}

/* -------------------------------- views -------------------------------- */

export function readSourceSummary(dataDir: string, key: string): SourceSummaryCache | null {
  const cache = readMarkdownCache(path.join(sidecarDir(dataDir, key), SOURCE_SUMMARY_FILE));
  if (!cache) return null;
  const contentSha = cacheString(cache.frontmatter.contentSha);
  const model = cacheString(cache.frontmatter.model);
  const generatedAt = cacheString(cache.frontmatter.generatedAt);
  if (contentSha === null || model === null || generatedAt === null) return null;
  return { contentSha, model, generatedAt, body: cache.body };
}

export function writeSourceSummary(dataDir: string, key: string, cache: SourceSummaryCache): void {
  writeMarkdownCache(
    path.join(sidecarDir(dataDir, key), SOURCE_SUMMARY_FILE),
    { contentSha: cache.contentSha, model: cache.model, generatedAt: cache.generatedAt },
    cache.body,
  );
}

/* ------------------------------- helpers ------------------------------- */

/**
 * Tier-1 extraction that can be replayed for free: status is done and the
 * content hash still matches. Shared by ingest replay and the tier-1 queue.
 */
export function replayableTier1(t1: SidecarTier1 | null | undefined, contentSha: string): SidecarTier1 | null {
  return t1 && t1.status === 'done' && t1.contentSha === contentSha ? t1 : null;
}

export function emptyUsage(now = new Date().toISOString()): SidecarUsage {
  return { firstSeenAt: now, lastAccessedAt: null, accessCount: 0, heat: 0, chunkHits: {}, flushedAt: null };
}
