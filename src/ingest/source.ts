import crypto from 'node:crypto';
import fs from 'node:fs';
import { assertNotPrivate, CappedText, isTextFile, readFileTextCapped, safePath } from '../fs/files.js';
import { RAW_DOCS, RAW_TRACES, sidecarRelFor } from '../fs/layout.js';
import { readContent } from '../fs/sidecar.js';
import { normalizeCookedFrontmatter } from '../okf/normalize.js';
import { pluginRegistry } from '../plugins/registry.js';
import { DocRoot } from '../types.js';
import { isConvertibleFile } from './convert.js';

/**
 * The indexed text of a source — the one place that knows where it lives.
 *
 * Text sources are read from `raw/` and normalized in memory (OKF `type` /
 * `title` frontmatter, see src/okf/normalize.ts); nothing is written back.
 * Converted sources (PDF, images) and trace episodes are read from the
 * sidecar's `content.md`, which the prepare step produced. Every hash of
 * "the content" — the scope sha, `meta.contentSha256`, the tier-1 replay
 * gate — is `sha256()` of exactly what this module returns.
 */

export interface SourceText {
  text: string;
  /** knode-os-derived Markdown (sidecar content.md) rather than the raw file's own text. */
  derived: boolean;
}

export const CONTENT_FILE = 'content.md';

export function sha256(value: string | Uint8Array): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** sha256 of a file's bytes, read a megabyte at a time: a 170 MB book is hashed without being held. */
export function sha256File(abs: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** True when the indexed text of `rel` is derived Markdown in the sidecar. */
export function isDerivedTextSource(rel: string): boolean {
  if (rel.startsWith(`${RAW_TRACES}/`)) return rel.endsWith('.jsonl');
  return rel.startsWith(`${RAW_DOCS}/`) && isConvertibleFile(rel);
}

/**
 * Guard for every text write that takes a caller-supplied path. A converted
 * original (PDF, image) is shown as the Markdown knode-os derived from it, so
 * an editor round-trip would write that Markdown over the original's bytes and
 * destroy the only copy. The derived text belongs to the sidecar; the original
 * is replaced by re-uploading it.
 */
export function assertNotConvertedOriginal(rel: string): void {
  if (isConvertibleFile(rel)) {
    throw new Error(`${rel} is a converted original — its text is derived and cannot be written back over the file`);
  }
}

/**
 * Normalize a text source for indexing. Deliberately passes no `at`: the
 * raw file's mtime must not leak into the content hash, or a `touch` would
 * dispose and re-apply the document.
 */
export function normalizeSourceText(rel: string, text: string): string {
  return normalizeCookedFrontmatter(rel, text);
}

/**
 * Indexed text for a source key, or null when nothing indexable exists yet.
 *
 * `source.text` plugin hooks run last, on every read: what they return is the
 * content — hashed, chunked, extracted and replayed as such — so a hook that
 * changes its mind changes the document, which is the honest outcome.
 */
export function loadSourceText(dataDir: string, rel: string, root: DocRoot): SourceText | null {
  const loaded = readSource(dataDir, rel, root);
  if (!loaded) return null;
  const registry = pluginRegistry();
  if (!registry.hasHandlers('source.text')) return loaded;
  return { ...loaded, text: registry.filterSync('source.text', loaded.text, { path: rel, root, dataDir }) };
}

function readSource(dataDir: string, rel: string, root: DocRoot): SourceText | null {
  if (root === 'traces' || (root === 'docs' && isConvertibleFile(rel))) {
    const text = readContent(dataDir, rel);
    return text === null ? null : { text, derived: true };
  }
  if (!isTextFile(rel)) return null;
  const abs = safePath(dataDir, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  const raw = fs.readFileSync(abs, 'utf8');
  return { text: root === 'docs' ? normalizeSourceText(rel, raw) : raw, derived: false };
}

/**
 * Capped read for preview surfaces (`GET /api/file`, `knode_read`): a
 * convertible original answers with its derived Markdown (null until it has
 * been prepared); anything else reads the file itself — never the config or
 * the workspace's private state (`isPrivatePath`).
 */
export function readSourceTextCapped(dataDir: string, rel: string, maxBytes: number): (CappedText & { derived: boolean }) | null {
  assertNotPrivate(rel);
  if (isDerivedTextSource(rel)) {
    const contentRel = `${sidecarRelFor(rel)}/${CONTENT_FILE}`;
    if (!fs.existsSync(safePath(dataDir, contentRel))) return null;
    return { ...readFileTextCapped(dataDir, contentRel, maxBytes), derived: true };
  }
  return { ...readFileTextCapped(dataDir, rel, maxBytes), derived: false };
}
