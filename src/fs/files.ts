import fs from 'node:fs';
import path from 'node:path';
import { hasSidecarSegment, listSidecarKeys, PACKS_DIR, RAW_DOCS, RAW_SKILLS, SIDECAR_ROOT_SEGMENT, sidecarRelFor } from './layout.js';

/** Path-safe file operations confined to the data directory. */

export interface TreeNode {
  name: string;
  path: string; // relative to dataDir, posix separators
  kind: 'file' | 'dir';
  bytes?: number;
  mtime?: string;
  children?: TreeNode[];
}

const HIDDEN = new Set(['.knode', SIDECAR_ROOT_SEGMENT, '.git', 'node_modules', '.DS_Store', '.obsidian']);

/** A directory entry every walker skips: dot-entries, the derived state, dependency trees. */
export function isHiddenName(name: string): boolean {
  return HIDDEN.has(name) || name.startsWith('.');
}

/** Resolve a user-supplied relative path inside dataDir, rejecting traversal. */
export function safePath(dataDir: string, rel: string): string {
  const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(dataDir, cleaned);
  const root = path.resolve(dataDir);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path escapes data directory: ${rel}`);
  }
  return abs;
}

export function listTree(dataDir: string, rel = '.', maxDepth = 8): TreeNode {
  const abs = safePath(dataDir, rel);
  const stat = fs.statSync(abs);
  const name = rel === '.' ? path.basename(dataDir) : path.basename(abs);
  const relPosix = rel === '.' ? '' : rel.replace(/\\/g, '/');
  if (stat.isFile()) {
    return { name, path: relPosix, kind: 'file', bytes: stat.size, mtime: stat.mtime.toISOString() };
  }
  const node: TreeNode = { name, path: relPosix, kind: 'dir', children: [] };
  if (maxDepth <= 0) return node;
  const entries = fs.readdirSync(abs, { withFileTypes: true })
    .filter((e) => !HIDDEN.has(e.name) && !e.name.startsWith('.'))
    .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
  for (const e of entries) {
    const childRel = relPosix ? `${relPosix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      node.children!.push(listTree(dataDir, childRel, maxDepth - 1));
    } else {
      const st = fs.statSync(path.join(abs, e.name));
      node.children!.push({ name: e.name, path: childRel, kind: 'file', bytes: st.size, mtime: st.mtime.toISOString() });
    }
  }
  return node;
}

export function readFileText(dataDir: string, rel: string): string {
  return fs.readFileSync(safePath(dataDir, rel), 'utf8');
}

export interface CappedText {
  content: string;
  /** Size of the file on disk, not of `content`. */
  bytes: number;
  truncated: boolean;
}

/**
 * Read at most `maxBytes` of a text file. Preview surfaces must never pull a
 * multi-megabyte document into memory (and then into a single text view), so
 * they read through here and render `truncated` as read-only.
 */
export function readFileTextCapped(dataDir: string, rel: string, maxBytes: number): CappedText {
  const abs = safePath(dataDir, rel);
  const bytes = fs.statSync(abs).size;
  if (bytes <= maxBytes) return { content: fs.readFileSync(abs, 'utf8'), bytes, truncated: false };

  const buf = Buffer.alloc(maxBytes);
  const fd = fs.openSync(abs, 'r');
  let read: number;
  try {
    read = fs.readSync(fd, buf, 0, maxBytes, 0);
  } finally {
    fs.closeSync(fd);
  }
  // The cut lands at an arbitrary byte, so drop the partial trailing rune and
  // then the partial trailing line.
  let content = buf.subarray(0, read).toString('utf8').replace(/\uFFFD+$/, '');
  const lastNewline = content.lastIndexOf('\n');
  if (lastNewline > 0) content = content.slice(0, lastNewline);
  return { content, bytes, truncated: true };
}

export function writeFileText(dataDir: string, rel: string, content: string): void {
  const abs = safePath(dataDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

export function writeFileBytes(dataDir: string, rel: string, content: Uint8Array): void {
  const abs = safePath(dataDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

export function removePath(dataDir: string, rel: string): void {
  const abs = safePath(dataDir, rel);
  fs.rmSync(abs, { recursive: true, force: true });
}

export function movePath(dataDir: string, from: string, to: string): void {
  const src = safePath(dataDir, from);
  const dst = safePath(dataDir, to);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst);
}

export function makeDir(dataDir: string, rel: string): void {
  fs.mkdirSync(safePath(dataDir, rel), { recursive: true });
}

export function pathExists(dataDir: string, rel: string): boolean {
  return fs.existsSync(safePath(dataDir, rel));
}

/**
 * Normalize a client-supplied name into a relative posix path.
 *
 * Folder uploads send each file's path inside the dropped folder as its
 * multipart filename, so nested names are expected — but `..` must never
 * escape the destination directory. `safePath` alone is not enough here:
 * `raw/docs/../../purpose.md` still resolves inside the data directory and
 * would overwrite a root file. Returns '' when nothing usable is left.
 */
export function sanitizeRelativePath(name: string): string {
  return name
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/');
}

/** Roots that external interfaces (HTTP / MCP) may write to. Everything else is read-only. */
const WRITABLE_ROOTS = ['wiki', RAW_DOCS, PACKS_DIR];
const WRITABLE_ROOTS_RE = new RegExp(`^(${WRITABLE_ROOTS.map((r) => r.replace(/\//g, '\\/')).join('|')})(\\/|$)`);
/** Root-level files an agent may (re)write: the knowledge-base guide and its Claude Code copy. Never sources. */
export const ROOT_WRITABLE_FILES = new Set(['AGENTS.md', 'CLAUDE.md']);

/**
 * The canonical form of a data-dir-relative path: posix separators, no leading
 * slash, no `.` / `..` segments. Every permission check runs on this, never on
 * the caller's spelling — `wiki/../knode.config.json` stays inside the data
 * directory, so `safePath` alone would let it through a `wiki/`-prefix test.
 * Returns '' for a path that is empty, is the root itself, or climbs out.
 */
export function cleanRelPath(rel: string): string {
  const raw = rel.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!raw) return '';
  const norm = path.posix.normalize(raw).replace(/\/+$/, '');
  if (!norm || norm === '.' || norm.startsWith('/') || norm === '..' || norm.startsWith('../')) return '';
  return norm;
}

export function isRootWritableFile(rel: string): boolean {
  return ROOT_WRITABLE_FILES.has(cleanRelPath(rel));
}

/** The sidecar tree is system-owned: no external write may land there, whatever root it is under. */
export function isWritablePath(rel: string): boolean {
  const clean = cleanRelPath(rel);
  if (!clean) return false;
  return ROOT_WRITABLE_FILES.has(clean) || (!hasSidecarSegment(clean) && WRITABLE_ROOTS_RE.test(clean));
}

export function assertWritablePath(rel: string): void {
  if (!isWritablePath(rel)) throw new Error(`writes are restricted to ${WRITABLE_ROOTS.map((r) => `${r}/`).join(', ')} and the root ${[...ROOT_WRITABLE_FILES].join(' / ')}`);
}

/** A source path: writable, but not one of the root guide files (which are never indexed). */
export function assertSourcePath(rel: string): void {
  assertWritablePath(rel);
  if (isRootWritableFile(rel)) throw new Error(`${rel} is the knowledge-base guide, not a source`);
}

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.text', '.json', '.jsonl', '.yaml', '.yml', '.csv', '.tsv', '.html', '.htm', '.xml', '.rst', '.org']);

export function isTextFile(file: string): boolean {
  return TEXT_EXT.has(path.extname(file).toLowerCase());
}

/** Recursively list files (absolute paths) under any directory, skipping dotfiles. */
export function walkAbsolute(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) visit(abs);
      else if (e.isFile()) out.push(abs);
    }
  };
  visit(root);
  return out;
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

const GREP_ROOTS = ['wiki', RAW_DOCS, RAW_SKILLS, PACKS_DIR];
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;

/**
 * grep-style regex search over the knowledge files (agents get grep/ls/read
 * alongside native SQL — the "filesystem view" of the logical database).
 *
 * Originals whose text knode-os derived (PDFs, images) are searched through
 * the Markdown in their sidecar and reported under the original's path; the
 * rest of the sidecar tree (extraction JSON, usage stats) is never a target.
 */
export function grepFiles(
  dataDir: string,
  pattern: string,
  opts: { path?: string; maxMatches?: number; ignoreCase?: boolean } = {},
): GrepMatch[] {
  const maxMatches = Math.min(opts.maxMatches ?? 100, 500);
  const re = new RegExp(pattern, opts.ignoreCase === false ? '' : 'i');
  const explicit = opts.path ? opts.path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : undefined;
  if (explicit !== undefined && hasSidecarSegment(explicit)) return [];
  const roots = explicit !== undefined ? [explicit] : GREP_ROOTS;
  const out: GrepMatch[] = [];

  for (const root of roots) {
    const rootAbs = safePath(dataDir, root);
    if (!fs.existsSync(rootAbs)) continue;
    const single = fs.statSync(rootAbs).isFile();
    const targets: { read: string; report: string }[] = [];
    for (const file of single ? [root] : walkFiles(dataDir, root)) {
      if (isTextFile(file)) targets.push({ read: file, report: file });
    }
    for (const key of single ? [root] : listSidecarKeys(dataDir, root)) {
      const derived = `${sidecarRelFor(key)}/content.md`;
      if (!isTextFile(key) && fs.existsSync(safePath(dataDir, derived))) targets.push({ read: derived, report: key });
    }
    for (const target of targets) {
      const abs = safePath(dataDir, target.read);
      if (fs.statSync(abs).size > MAX_GREP_FILE_BYTES) continue;
      const lines = fs.readFileSync(abs, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          out.push({ path: target.report, line: i + 1, text: lines[i].trim().slice(0, 300) });
          if (out.length >= maxMatches) return out;
        }
      }
    }
  }
  return out;
}

/** Recursively list files (relative posix paths) under a directory inside dataDir. */
export function walkFiles(dataDir: string, rel: string): string[] {
  const out: string[] = [];
  const visit = (r: string) => {
    const abs = safePath(dataDir, r);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (HIDDEN.has(e.name) || e.name.startsWith('.')) continue;
      const childRel = `${r}/${e.name}`;
      if (e.isDirectory()) visit(childRel);
      else out.push(childRel);
    }
  };
  visit(rel.replace(/\\/g, '/').replace(/\/+$/, ''));
  return out;
}
