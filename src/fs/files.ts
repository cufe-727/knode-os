import fs from 'node:fs';
import path from 'node:path';
import { hasSidecarSegment, listSidecarKeys, PACKS_DIR, RAW_CODEBASE, RAW_DOCS, RAW_SKILLS, SIDECAR_ROOT_SEGMENT, sidecarRelFor } from './layout.js';
import { isCodebaseFile } from '../ingest/codebase/files.js';

/** Path-safe file operations confined to the data directory. */

export interface TreeNode {
  name: string;
  path: string; // relative to dataDir, posix separators
  kind: 'file' | 'dir';
  bytes?: number;
  mtime?: string;
  /** A folder's entries; absent on a folder past the listing's depth — not listed, which is not empty. */
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

/** The workspace config — literal API keys live in it. Settings reads it through the redacted GET /api/config. */
const CONFIG_FILE_NAME = 'knode.config.json';

/**
 * Paths no file route reads, lists or writes — the REST file API, MCP's
 * knode_read / knode_ls / knode_grep / knode_write, grep: the workspace
 * config, and every dot-entry, which is where a workspace keeps what is not
 * knowledge — `.knode/` (the index, tokens, audit log), `.runs/` (the
 * research and chat run workspaces, with their MCP credentials),
 * `.workspace.json`, a `.git/` or `.obsidian/` someone put there. The sidecar
 * tree at the root stays readable: it holds the Markdown derived from PDFs
 * and images, which agents are told to read.
 *
 * Compared without case, because the volume usually ignores it:
 * `Knode.Config.json` opens the same file on macOS.
 */
export function isPrivatePath(rel: string): boolean {
  const clean = cleanRelPath(rel).toLowerCase();
  if (!clean) return false;
  if (clean === CONFIG_FILE_NAME) return true;
  return clean.split('/').some((segment, i) => segment.startsWith('.') && !(i === 0 && segment === SIDECAR_ROOT_SEGMENT));
}

export function assertNotPrivate(rel: string): void {
  if (!isPrivatePath(rel)) return;
  const config = cleanRelPath(rel).toLowerCase() === CONFIG_FILE_NAME;
  throw new Error(`${rel} is not available through the file API${config ? ' — Settings shows the configuration, without its keys' : ': it is the workspace\'s private state'}`);
}

/**
 * A file or a folder `maxDepth` levels down. A folder past that depth comes
 * back without `children`, so a client can list one level at a time and fetch
 * a folder when it is opened: a whole workspace is tens of thousands of files.
 * `dirsOnly` leaves the files out — the folders a picker offers. `hide` names
 * paths left out of every listing below `rel` (the file tree's TREE_HIDDEN);
 * listing one of them by its own path still works.
 */
export function listTree(dataDir: string, rel = '.', maxDepth = 8, opts: { dirsOnly?: boolean; hide?: ReadonlySet<string> } = {}): TreeNode {
  assertNotPrivate(rel);
  const abs = safePath(dataDir, rel);
  const stat = fs.statSync(abs);
  const name = rel === '.' ? path.basename(dataDir) : path.basename(abs);
  const relPosix = rel === '.' ? '' : rel.replace(/\\/g, '/');
  if (stat.isFile()) {
    return { name, path: relPosix, kind: 'file', bytes: stat.size, mtime: stat.mtime.toISOString() };
  }
  const node: TreeNode = { name, path: relPosix, kind: 'dir' };
  if (maxDepth <= 0) return node;
  const children: TreeNode[] = (node.children = []);
  const entries = fs.readdirSync(abs, { withFileTypes: true })
    .filter((e) => {
      const childRel = relPosix ? `${relPosix}/${e.name}` : e.name;
      return !HIDDEN.has(e.name) && !e.name.startsWith('.') && !isPrivatePath(childRel) && !opts.hide?.has(childRel);
    })
    .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
  for (const e of entries) {
    const childRel = relPosix ? `${relPosix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      // the last level needs no stat: the entry already says it is a folder
      children.push(maxDepth > 1 ? listTree(dataDir, childRel, maxDepth - 1, opts) : { name: e.name, path: childRel, kind: 'dir' });
    } else if (!opts.dirsOnly) {
      const st = fs.statSync(path.join(abs, e.name));
      children.push({ name: e.name, path: childRel, kind: 'file', bytes: st.size, mtime: st.mtime.toISOString() });
    }
  }
  return node;
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

/** The same cap on a text already in memory (a translation): whole lines, at most `maxBytes` of UTF-8. */
export function capText(text: string, maxBytes: number): CappedText {
  const bytes = Buffer.byteLength(text);
  if (bytes <= maxBytes) return { content: text, bytes, truncated: false };
  let content = Buffer.from(text).subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/, '');
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
 * Root-level files a person edits from the app and an agent never rewrites:
 * what the workspace is for and the rules its wiki follows steer every
 * generator, so they stay the owner's word. The HTTP file API takes them; MCP
 * does not. Never sources.
 */
export const OWNER_ROOT_FILES = new Set(['purpose.md', 'schema.md']);

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

export function isOwnerRootFile(rel: string): boolean {
  return OWNER_ROOT_FILES.has(cleanRelPath(rel));
}

/** The sidecar tree is system-owned: no external write may land there, whatever root it is under; nor in a private path. */
export function isWritablePath(rel: string): boolean {
  const clean = cleanRelPath(rel);
  if (!clean || isPrivatePath(clean)) return false;
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

const TEXT_EXT = new Set(['.md', '.markdown', '.mdx', '.txt', '.text', '.json', '.jsonl', '.yaml', '.yml', '.csv', '.tsv', '.html', '.htm', '.xml', '.rst', '.org']);

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

// repositories last: a pattern that matches prose and code shows the prose first
const GREP_ROOTS = ['wiki', RAW_DOCS, RAW_SKILLS, PACKS_DIR, RAW_CODEBASE];
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;

/** A folder holding matches, as a grep answer that leaves some of them out names it. */
export interface GrepFolder {
  path: string;
  /** Matching lines in the folder's own files (with `folders`, in the files below it too), as far as they were read. */
  matches: number;
  /** Its files that hold a match. */
  files: number;
  /** How many of its matching lines the answer shows. */
  shown: number;
  /** Folders below it whose matches are counted in, when a long list was folded into their parents. */
  folders?: number;
  /** Files the scan stopped before reading: its `matches` are then a lower bound. */
  unread?: number;
}

export interface GrepResult {
  matches: GrepMatch[];
  /** Matching lines in all, shown or not; a lower bound when the scan is `partial`. */
  total: number;
  /** When matches were left out: every folder that holds matches, in the order searched. */
  folders?: GrepFolder[];
  /** When the scan stopped before every file was read: how far it got. */
  partial?: GrepPartial;
}

/** How far a scan that stopped early got: of the files listed, and of the folders they are in. */
export interface GrepPartial {
  filesRead: number;
  files: number;
  /** Folders it read a file of. The others may hold matches too, and none of them is among `folders`. */
  foldersReached: number;
  folders: number;
}

/**
 * Each amount's share of `budget`: water-filling, so every amount under the
 * common level is met whole and the larger ones get the level; what is left
 * under a whole level goes one each to the earliest of them. With fewer
 * places than amounts the earliest get one each: none is given two while
 * another, however small, has none.
 */
export function shareEvenly(amounts: number[], budget: number): number[] {
  const given = (level: number) => amounts.reduce((n, a) => n + Math.min(a, level), 0);
  let low = 0;
  let high = Math.max(0, ...amounts);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (given(mid) <= budget) low = mid;
    else high = mid - 1;
  }
  const out = amounts.map((a) => Math.min(a, low));
  let left = Math.max(0, budget - given(low));
  for (let i = 0; i < out.length && left > 0; i++) {
    if (amounts[i] > low) {
      out[i]++;
      left--;
    }
  }
  return out;
}

const folderOf = (file: string) => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '');

/**
 * What a scan reads at least before it may stop with its answer full — this
 * many files or this many bytes, whichever comes first. Past it a pattern
 * that is everywhere is not counted to the end: on 92,400 small files (the
 * 10× benchmark's documents 60 times over) counting /平台组/ to the end took
 * 10.6 s, on serve's event loop, where the first 40 matches took 0.14 s.
 */
export const GREP_SCAN_FILES = 5000;
export const GREP_SCAN_BYTES = 16 * 1024 * 1024;
/** Matching lines kept from the files as they are read; a file chosen for the answer past that is read once more. */
const GREP_HELD_LINES = 5000;

/**
 * grep-style regex search over the knowledge files (agents get grep/ls/read
 * alongside native SQL — the "filesystem view" of the logical database).
 *
 * Originals whose text knode-os derived (PDFs, images) are searched through
 * the Markdown in their sidecar and reported under the original's path; the
 * rest of the sidecar tree (extraction JSON, usage stats) is never a target.
 *
 * When more lines match than `maxMatches`, the places are shared evenly over
 * the folders that hold matches, and in a folder over its files (water-
 * filling: a folder or file with fewer matches than its share is shown
 * whole, and where there are more folders than places the folders searched
 * first get one each — the wiki and the documents before skills and code),
 * and `folders` names every folder that matches with how many lines it
 * holds. Taking matches as the walk met them filled the answer from the
 * first folder: /平台组/ over the ten divisions' reports returned 39 of 40
 * matches from 七部平台组, and an agent answered for that division.
 *
 * The files are read a folder in turn, one file each a round, so that a scan
 * cut short has still read some of every folder. It is cut short only when
 * the answer is full already and `GREP_SCAN_FILES` files or `GREP_SCAN_BYTES`
 * have been read: a rare pattern is looked for in every file, as it always
 * was, and a pattern that is everywhere stops there, with `partial` and
 * counts that are lower bounds — before, it stopped at the first
 * `maxMatches` lines.
 */
export function grepSearch(
  dataDir: string,
  pattern: string,
  opts: { paths?: string[]; maxMatches?: number; maxPerFile?: number; ignoreCase?: boolean; scanFiles?: number; scanBytes?: number } = {},
): GrepResult {
  const maxMatches = Math.max(1, Math.min(opts.maxMatches ?? 100, 500));
  const perFile = Math.max(1, opts.maxPerFile ?? maxMatches);
  const scanBytes = opts.scanBytes ?? GREP_SCAN_BYTES;
  const scanFiles = opts.scanFiles ?? GREP_SCAN_FILES;
  const re = new RegExp(pattern, opts.ignoreCase === false ? '' : 'i');
  const roots: string[] = [];
  for (const raw of opts.paths?.length ? opts.paths : [undefined]) {
    if (raw === undefined) roots.push(...GREP_ROOTS);
    else {
      const explicit = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!hasSidecarSegment(explicit) && !isPrivatePath(explicit)) roots.push(explicit);
    }
  }

  // the files to read, by folder, in the order searched; nothing is read yet
  interface Target { read: string; report: string; at: number; count: number; held?: { line: number; text: string }[] }
  const byFolder = new Map<string, Target[]>();
  const seen = new Set<string>();
  let listed = 0;
  for (const root of roots) {
    const rootAbs = safePath(dataDir, root);
    if (!fs.existsSync(rootAbs)) continue;
    const single = fs.statSync(rootAbs).isFile();
    const targets: { read: string; report: string }[] = [];
    for (const file of single ? [root] : walkFiles(dataDir, root)) {
      if (isTextFile(file) || isCodebaseFile(file)) targets.push({ read: file, report: file });
    }
    for (const key of single ? [root] : listSidecarKeys(dataDir, root)) {
      const derived = `${sidecarRelFor(key)}/content.md`;
      if (!isTextFile(key) && fs.existsSync(safePath(dataDir, derived))) targets.push({ read: derived, report: key });
    }
    for (const target of targets) {
      // a walk from the root passes the config too; two subtrees asked for may overlap
      if (isPrivatePath(target.read) || seen.has(target.report)) continue;
      seen.add(target.report);
      const folder = folderOf(target.report);
      (byFolder.get(folder) ?? byFolder.set(folder, []).get(folder)!).push({ ...target, at: listed++, count: -1 });
    }
  }

  /** The lines of `read` that match, as far as `keep` of them; all of them counted. */
  const scan = (read: string, keep: number): { count: number; lines: { line: number; text: string }[]; bytes: number } => {
    const abs = safePath(dataDir, read);
    // the fill is counted in bytes on disk: a character of Chinese is three
    const { size } = fs.statSync(abs);
    if (size > MAX_GREP_FILE_BYTES) return { count: 0, lines: [], bytes: 0 };
    const text = fs.readFileSync(abs, 'utf8');
    const lines = text.split('\n');
    const found: { line: number; text: string }[] = [];
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      if (count++ < keep) found.push({ line: i + 1, text: lines[i].trim().slice(0, 300) });
    }
    return { count, lines: found, bytes: size };
  };

  // a folder in turn, one file each a round
  const folders = [...byFolder.entries()];
  const longest = folders.reduce((n, [, files]) => Math.max(n, files.length), 0);
  const keep = Math.min(perFile, maxMatches);
  let total = 0;
  let bytes = 0;
  let held = 0;
  let filesRead = 0;
  let stopped = false;
  for (let round = 0; round < longest && !stopped; round++) {
    for (const [, files] of folders) {
      const target = files[round];
      if (!target) continue;
      if (total >= maxMatches && (bytes >= scanBytes || filesRead >= scanFiles)) {
        stopped = true;
        break;
      }
      const found = scan(target.read, held < GREP_HELD_LINES ? keep : 0);
      target.count = found.count;
      if (found.count > 0 && held < GREP_HELD_LINES) {
        target.held = found.lines;
        held += found.lines.length;
      }
      total += found.count;
      bytes += found.bytes;
      filesRead++;
    }
  }

  // the places: over the folders that hold matches, then over each folder's files
  const matching = folders.map(([folder, files]) => ({ folder, files: files.filter((f) => f.count > 0), unread: files.filter((f) => f.count < 0).length })).filter((f) => f.files.length > 0);
  const offered = (f: Target) => Math.min(f.count, perFile);
  const folderShares = shareEvenly(matching.map((m) => m.files.reduce((n, f) => n + offered(f), 0)), maxMatches);
  const picked: { file: Target; take: number }[] = [];
  const shownOf = new Map<string, number>();
  matching.forEach((m, at) => {
    const shares = shareEvenly(m.files.map(offered), folderShares[at]);
    m.files.forEach((file, j) => {
      if (shares[j] > 0) picked.push({ file, take: shares[j] });
    });
    shownOf.set(m.folder, folderShares[at]);
  });

  const matches: GrepMatch[] = [];
  for (const { file, take } of picked.sort((a, b) => a.file.at - b.file.at)) {
    for (const m of (file.held ?? scan(file.read, take).lines).slice(0, take)) matches.push({ path: file.report, line: m.line, text: m.text });
  }
  // set only when a file listed was left unread: a fill reached at the last file is a whole scan
  const partial: GrepPartial | undefined = stopped
    ? { filesRead, files: listed, foldersReached: folders.filter(([, files]) => files.some((f) => f.count >= 0)).length, folders: folders.length }
    : undefined;
  if (matches.length >= total && !partial) return { matches, total };
  return {
    matches,
    total,
    folders: matching.map((m) => ({
      path: m.folder,
      matches: m.files.reduce((n, f) => n + f.count, 0),
      files: m.files.length,
      shown: shownOf.get(m.folder) ?? 0,
      ...(m.unread > 0 ? { unread: m.unread } : {}),
    })),
    ...(partial ? { partial } : {}),
  };
}

/**
 * `folders` as a list of `max` entries at most: while it is longer, the
 * deepest folders are folded into their parents, which then count the
 * matches below them (`folders`: how many were folded in). Every folder that
 * matches is still named, itself or by a folder above it.
 */
export function foldGrepFolders(folders: GrepFolder[], max: number): GrepFolder[] {
  const depth = (f: GrepFolder) => (f.path === '' ? 0 : f.path.split('/').length);
  let list = folders;
  while (list.length > max) {
    const deepest = Math.max(...list.map(depth));
    if (deepest <= 1) break;
    const folded = new Map<string, GrepFolder>();
    for (const f of list) {
      const into = depth(f) === deepest ? folderOf(f.path) : f.path;
      const have = folded.get(into);
      const below = depth(f) === deepest ? 1 + (f.folders ?? 0) : (f.folders ?? 0);
      if (!have) {
        folded.set(into, { path: into, matches: f.matches, files: f.files, shown: f.shown, ...(below ? { folders: below } : {}), ...(f.unread ? { unread: f.unread } : {}) });
      } else {
        have.matches += f.matches;
        have.files += f.files;
        have.shown += f.shown;
        if (below + (have.folders ?? 0) > 0) have.folders = (have.folders ?? 0) + below;
        if ((f.unread ?? 0) + (have.unread ?? 0) > 0) have.unread = (have.unread ?? 0) + (f.unread ?? 0);
      }
    }
    list = [...folded.values()];
  }
  return list;
}

/** Folders a cut answer names at most; a longer list is folded into parent folders. */
export const GREP_FOLDERS_MAX = 60;

/** What every interface says of a grep answer: its matches, how many lines match in all, and — when it is a sample — where the rest are. */
export interface GrepAnswer {
  matches: GrepMatch[];
  /** Matching lines in all; a lower bound when `cut.partial`. */
  total: number;
  /** Present when the matches are a sample of what matches, absent when they are all of it. */
  cut?: {
    shown: number;
    /** Every folder holding matches (deep ones folded into their parents past `GREP_FOLDERS_MAX`), with its count and how many are shown. */
    folders: GrepFolder[];
    /** The scan stopped before reading every file: `total` and the folders' counts are lower bounds, and folders it never reached are not among `folders`. */
    partial?: GrepPartial;
    note: string;
  };
}

/** How far a scan that stopped got, in words: the files read, and the folders it never came to. */
export function grepPartialNote(partial: GrepPartial): string {
  const n = (x: number) => x.toLocaleString('en-US');
  const unreached = partial.folders - partial.foldersReached;
  return `the scan stopped after ${n(partial.filesRead)} of ${n(partial.files)} files, a folder in turn${unreached > 0 ? `, and never reached ${n(unreached)} of the ${n(partial.folders)} folders: they may hold matches and are not named below` : ''}`;
}

/** `result` as an interface answers with it: one shape, cut or not. */
export function grepAnswer(result: GrepResult): GrepAnswer {
  if (!result.folders) return { matches: result.matches, total: result.total };
  const folders = foldGrepFolders(result.folders, GREP_FOLDERS_MAX);
  const lower = result.partial ? ` (at least: ${grepPartialNote(result.partial)})` : '';
  return {
    matches: result.matches,
    total: result.total,
    cut: {
      shown: result.matches.length,
      folders,
      ...(result.partial ? { partial: result.partial } : {}),
      note: `Showing ${result.matches.length.toLocaleString('en-US')} of ${result.total.toLocaleString('en-US')} matching lines${lower}, shared over the folders and files that hold them. \`folders\` names every folder that matches with its count; search one folder alone to see its matches, or narrow the pattern.`,
    },
  };
}

/** `grepSearch` under one path, its matches alone: for callers that show no more than lines. */
export function grepFiles(
  dataDir: string,
  pattern: string,
  opts: { path?: string; maxMatches?: number; ignoreCase?: boolean } = {},
): GrepMatch[] {
  return grepSearch(dataDir, pattern, { paths: opts.path ? [opts.path] : undefined, maxMatches: opts.maxMatches, ignoreCase: opts.ignoreCase }).matches;
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

/**
 * `walkFiles(dataDir, root)` restricted to what sits under `prefixes`,
 * without walking the rest: a prefix at or above `root` covers it whole, a
 * directory below it is walked, a file is taken as it is. A path that no
 * longer exists, or is hidden, yields nothing. No prefixes: all of `root`.
 */
export function walkFilesUnder(dataDir: string, root: string, prefixes: string[] | undefined): string[] {
  if (!prefixes) return walkFiles(dataDir, root);
  const out = new Set<string>();
  for (const p of prefixes) {
    if (p === root || root.startsWith(`${p}/`)) return walkFiles(dataDir, root);
    if (!p.startsWith(`${root}/`) || p.split('/').some(isHiddenName)) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(safePath(dataDir, p));
    } catch {
      continue;
    }
    if (st.isDirectory()) for (const f of walkFiles(dataDir, p)) out.add(f);
    else if (st.isFile()) out.add(p);
  }
  return [...out];
}
