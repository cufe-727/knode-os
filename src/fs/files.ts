import fs from 'node:fs';
import path from 'node:path';

/** Path-safe file operations confined to the data directory. */

export interface TreeNode {
  name: string;
  path: string; // relative to dataDir, posix separators
  kind: 'file' | 'dir';
  bytes?: number;
  mtime?: string;
  children?: TreeNode[];
}

const HIDDEN = new Set(['.knode', '.git', 'node_modules', '.DS_Store', '.obsidian']);

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
const WRITABLE_ROOTS_RE = /^(wiki|raw\/docs|packs)(\/|$)/;

export function isWritablePath(rel: string): boolean {
  return WRITABLE_ROOTS_RE.test(rel.replace(/\\/g, '/').replace(/^\/+/, ''));
}

export function assertWritablePath(rel: string): void {
  if (!isWritablePath(rel)) throw new Error('writes are restricted to wiki/, raw/docs/ and packs/');
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

const GREP_ROOTS = ['cooked/docs', 'wiki', 'raw/docs', 'raw/skills', 'packs'];
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;

/**
 * grep-style regex search over the knowledge files (agents get grep/ls/read
 * alongside native SQL — the "filesystem view" of the logical database).
 */
export function grepFiles(
  dataDir: string,
  pattern: string,
  opts: { path?: string; maxMatches?: number; ignoreCase?: boolean } = {},
): GrepMatch[] {
  const maxMatches = Math.min(opts.maxMatches ?? 100, 500);
  const re = new RegExp(pattern, opts.ignoreCase === false ? '' : 'i');
  const roots = opts.path ? [opts.path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')] : GREP_ROOTS;
  const out: GrepMatch[] = [];

  for (const root of roots) {
    const rootAbs = safePath(dataDir, root);
    if (!fs.existsSync(rootAbs)) continue;
    const files = fs.statSync(rootAbs).isFile() ? [root] : walkFiles(dataDir, root);
    for (const file of files) {
      if (!isTextFile(file)) continue;
      const abs = safePath(dataDir, file);
      if (fs.statSync(abs).size > MAX_GREP_FILE_BYTES) continue;
      const lines = fs.readFileSync(abs, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          out.push({ path: file, line: i + 1, text: lines[i].trim().slice(0, 300) });
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
