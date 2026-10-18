import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KnodeConfig, LinkedFolder, saveConfig } from '../config.js';
import { MAX_CONVERTIBLE_FILE_BYTES, MAX_FILE_BYTES } from '../constants.js';
import { isHiddenName, isTextFile, safePath, sanitizeRelativePath, walkFiles } from '../fs/files.js';
import { hasSidecarSegment, RAW_DOCS, SIDECAR_ROOT } from '../fs/layout.js';
import { TreeWatcher, watchTree } from '../fs/watch.js';
import { isConvertibleFile } from './convert.js';
import { sync, SyncContext, SyncStats } from './sync.js';

/**
 * Folder import — bringing a folder that lives elsewhere on this machine into
 * `raw/docs`, with its directory structure intact.
 *
 * Two modes share one mechanism, a mirror:
 *
 *   - **copy**: the folder is mirrored once into `raw/docs/<name>/…` and
 *     indexed; from then on it is ordinary workspace content.
 *   - **link**: the same mirror, remembered in `ingest.linkedFolders`. While
 *     `serve` runs, a watcher on the source folder copies every change over
 *     (adds, edits, deletions) and syncs just those keys; a reconcile pass at
 *     startup and every few minutes catches what the watcher missed.
 *
 * The mirror — not a symlink, not indexing in place — is what keeps every
 * invariant of the data directory: the raw path stays the key of every
 * source, sidecars and the attic sit beside a real file, a rebuild replays
 * the ledger without needing the external folder, and the UI's rename / move /
 * delete can never reach the person's original files. The mirror of a linked
 * folder belongs to the link: writes into it are refused (they would be undone
 * by the next sync), and removing the link may remove the mirror.
 *
 * Only what knode-os can index travels: text files and convertible originals
 * (PDF, images). Dot-entries (`.state/`, `.git/`), `node_modules` and symlinks
 * stay behind. A file above the per-file index limit is still copied — the
 * tree stays complete — and reported, so the person knows it will sit there
 * unindexed.
 */

export type { LinkedFolder };

export type ImportMode = 'copy' | 'link';

/** One file the import carries: where it is, and its path inside the folder. */
export interface PlannedFile {
  abs: string;
  rel: string;
  bytes: number;
  mtimeMs: number;
}

export interface FolderPlan {
  source: string;
  files: PlannedFile[];
  bytes: number;
  /** Files of a type knode-os cannot index (archives, databases, code…), plus symlinks: left behind. */
  skippedByType: number;
  /** Files above the per-file index limit: copied so the tree stays whole, but never indexed. */
  tooLarge: number;
}

export interface MirrorResult {
  /** Keys (data-dir-relative) written this pass — new files and changed ones. */
  copied: string[];
  /** Keys removed because the source no longer has them. */
  removed: string[];
  unchanged: number;
  files: number;
  bytes: number;
  skippedByType: number;
  tooLarge: number;
}

export interface ImportFolderOptions {
  /** Destination under raw/docs; default raw/docs/<basename of the source>. */
  dest?: string;
  mode: ImportMode;
  /** Allow a destination that already exists: it becomes a mirror of the source (files it alone has are removed). */
  replace?: boolean;
  llmGraph?: boolean;
  onProgress?: (msg: string) => void;
}

export interface ImportFolderResult extends MirrorResult {
  source: string;
  dest: string;
  mode: ImportMode;
  sync: SyncStats;
}

/** A request the caller can fix by choosing differently (an occupied destination, a folder already linked) — 409. */
export class FolderImportConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FolderImportConflict';
  }
}

/** A scoped sync names each changed key up to here; beyond it, the whole mirror is synced as one prefix. */
const SYNC_KEYS_MAX = 200;

export function linkedFolders(config: KnodeConfig): LinkedFolder[] {
  return Array.isArray(config.ingest.linkedFolders) ? config.ingest.linkedFolders : [];
}

/** The link whose mirror is `rel` or contains it, if any. */
export function linkOwning(links: LinkedFolder[], rel: string): LinkedFolder | null {
  const clean = rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return links.find((l) => clean === l.dest || clean.startsWith(`${l.dest}/`)) ?? null;
}

/**
 * Destinations an import or an unlink is writing right now, per data dir, with
 * the time their claim lapses (Infinity while the operation runs). Each such
 * operation syncs the keys it writes itself; the claim outlives it by a few
 * seconds because a filesystem watcher reports late.
 */
const inFlight = new Map<string, Map<string, number>>();
const SETTLE_MS = 10_000;

function holdDest(dataDir: string, dest: string): () => void {
  const held = inFlight.get(dataDir) ?? new Map<string, number>();
  inFlight.set(dataDir, held);
  held.set(dest, Infinity);
  return () => held.set(dest, Date.now() + SETTLE_MS);
}

/**
 * True when a change at `rel` is already being synced by the folder machinery,
 * so a watcher on the data dir must leave it alone: a linked folder's mirror
 * (its own watcher and reconcile sync it) or a destination an import or unlink
 * is writing. Without this, every link, import and unlink of a large folder
 * also set off a second sync of everything it touched.
 */
export function syncedByFolders(dataDir: string, config: KnodeConfig, rel: string): boolean {
  const clean = rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (linkOwning(linkedFolders(config), clean)) return true;
  const held = inFlight.get(dataDir);
  if (!held) return false;
  const now = Date.now();
  let owned = false;
  for (const [dest, until] of held) {
    if (until < now) {
      held.delete(dest);
      continue;
    }
    if (clean === dest || clean.startsWith(`${dest}/`)) owned = true;
  }
  return owned;
}

/** Links whose mirror sits inside `rel` — moving or deleting `rel` would take their mirror along. */
export function linksUnder(links: LinkedFolder[], rel: string): LinkedFolder[] {
  const clean = rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return links.filter((l) => l.dest.startsWith(`${clean}/`));
}

/**
 * Guard for writes that take a caller-supplied path: the mirror of a linked
 * folder is written by the link alone. Anything a person wrote there would be
 * undone by the next sync, and a rename or delete of it would be re-copied.
 */
export function assertNotLinked(config: KnodeConfig, rel: string, what = 'write to'): void {
  const links = linkedFolders(config);
  const owner = linkOwning(links, rel);
  if (owner) {
    throw new Error(`${rel} is mirrored from ${owner.source} — edit the original instead, or unlink ${owner.dest} first (cannot ${what} it)`);
  }
  const inside = linksUnder(links, rel);
  if (inside.length) throw new Error(`${rel} contains the linked folder ${inside[0].dest} — unlink it first`);
}

/**
 * The source folder as an absolute path, checked to be a real directory that
 * neither sits inside this workspace nor contains it. `~/` is expanded. The
 * path keeps the caller's spelling (symlinks intact); containment is checked
 * on resolved paths so a symlinked spelling cannot slip either way.
 */
export function resolveImportSource(dataDir: string, source: string): string {
  if (typeof source !== 'string' || !source.trim()) throw new Error('source folder required');
  let abs = source.trim();
  if (abs === '~' || abs.startsWith('~/')) abs = path.join(os.homedir(), abs.slice(1));
  if (!path.isAbsolute(abs)) throw new Error(`the source must be an absolute path on this machine, not ${source}`);
  abs = path.resolve(abs);
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw new Error(`no such folder: ${abs}`);
  }
  if (!fs.statSync(real).isDirectory()) throw new Error(`not a folder: ${abs}`);
  const data = fs.realpathSync(dataDir);
  if (real === data || real.startsWith(data + path.sep)) throw new Error(`${abs} is inside this workspace already`);
  if (data === real || data.startsWith(real + path.sep)) throw new Error(`${abs} contains this workspace — importing it would copy the workspace into itself`);
  return abs;
}

/** The mirror's path: `raw/docs/<name>`, where a bare name or a raw/docs path is accepted. */
export function importDestFor(source: string, dest?: string): string {
  const name = sanitizeRelativePath((dest ?? '').trim() || path.basename(source));
  if (!name) throw new Error('destination folder required');
  const rel = name === RAW_DOCS || name.startsWith(`${RAW_DOCS}/`) ? name : `${RAW_DOCS}/${name}`;
  if (rel === RAW_DOCS) throw new Error(`the destination must be a folder under ${RAW_DOCS}/, not ${RAW_DOCS} itself`);
  if (hasSidecarSegment(rel)) throw new Error(`${SIDECAR_ROOT}/ is system-owned`);
  return rel;
}

/** True for a path inside the source that the mirror carries: indexable type, no hidden segment. */
export function isImportable(rel: string): boolean {
  const segments = rel.replace(/\\/g, '/').split('/');
  if (segments.some((s) => !s || isHiddenName(s))) return false;
  return isTextFile(rel) || isConvertibleFile(rel);
}

function indexLimit(rel: string): number {
  return isConvertibleFile(rel) ? MAX_CONVERTIBLE_FILE_BYTES : MAX_FILE_BYTES;
}

/** Walk the source and decide, file by file, what the mirror carries. Deterministic order (sorted names). */
export function planFolderImport(source: string): FolderPlan {
  const plan: FolderPlan = { source, files: [], bytes: 0, skippedByType: 0, tooLarge: 0 };
  const visit = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (isHiddenName(e.name)) continue;
      const abs = path.join(dir, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        visit(abs, childRel);
      } else if (e.isFile()) {
        if (!isImportable(childRel)) {
          plan.skippedByType++;
          continue;
        }
        let st: fs.Stats;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        if (st.size > indexLimit(childRel)) plan.tooLarge++;
        plan.files.push({ abs, rel: childRel, bytes: st.size, mtimeMs: st.mtimeMs });
        plan.bytes += st.size;
      } else {
        // a symlink may point anywhere, this workspace included
        plan.skippedByType++;
      }
    }
  };
  visit(source, '');
  return plan;
}

/** Same bytes, as far as size and modification time can tell — the copy carries the source's mtime. */
function sameFile(target: string, file: PlannedFile): boolean {
  let st: fs.Stats;
  try {
    st = fs.statSync(target);
  } catch {
    return false;
  }
  return st.isFile() && st.size === file.bytes && Math.abs(st.mtimeMs - file.mtimeMs) < 2;
}

/**
 * Copy through a hidden temporary name and rename into place: the data-dir
 * watcher (and a reader) never sees a half-written file, and the hidden name
 * is invisible to every walker in the meantime.
 */
function copyAtomic(src: string, target: string, mtimeMs: number): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  try {
    fs.copyFileSync(src, tmp);
    fs.utimesSync(tmp, new Date(), mtimeMs / 1000);
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Remove now-empty directories from `dir` up to (not including) `stopAt`. */
function pruneEmptyDirs(dir: string, stopAt: string): void {
  let cur = dir;
  while (cur.startsWith(stopAt + path.sep) || cur === stopAt) {
    let entries: string[];
    try {
      entries = fs.readdirSync(cur);
    } catch {
      return;
    }
    if (entries.length > 0 || cur === stopAt) return;
    fs.rmdirSync(cur);
    cur = path.dirname(cur);
  }
}

/**
 * Make `dest` a mirror of `source`: copy what is new or changed, and with
 * `prune` remove what the source no longer has (never the destination folder
 * itself). Idempotent — a second pass over an unchanged source copies nothing.
 */
export function mirrorFolder(dataDir: string, source: string, dest: string, opts: { prune: boolean }): MirrorResult {
  const plan = planFolderImport(source);
  const destAbs = safePath(dataDir, dest);
  fs.mkdirSync(destAbs, { recursive: true });
  const keep = new Set<string>();
  const copied: string[] = [];
  let unchanged = 0;
  for (const f of plan.files) {
    const key = `${dest}/${f.rel}`;
    keep.add(key);
    const target = safePath(dataDir, key);
    if (sameFile(target, f)) {
      unchanged++;
      continue;
    }
    copyAtomic(f.abs, target, f.mtimeMs);
    copied.push(key);
  }
  const removed: string[] = [];
  if (opts.prune) {
    for (const key of walkFiles(dataDir, dest)) {
      if (keep.has(key)) continue;
      const abs = safePath(dataDir, key);
      fs.rmSync(abs, { force: true });
      pruneEmptyDirs(path.dirname(abs), destAbs);
      removed.push(key);
    }
  }
  return { copied, removed, unchanged, files: plan.files.length, bytes: plan.bytes, skippedByType: plan.skippedByType, tooLarge: plan.tooLarge };
}

/**
 * Mirror just the paths a watcher reported. A path that exists is copied when
 * it differs; one that is gone is removed from the mirror. Paths outside the
 * source, hidden, or of an unindexable type are ignored.
 */
export function mirrorPaths(dataDir: string, link: LinkedFolder, absPaths: string[]): { changed: string[] } {
  const destAbs = safePath(dataDir, link.dest);
  const changed: string[] = [];
  for (const abs of new Set(absPaths)) {
    const rel = path.relative(link.source, abs).split(path.sep).join('/');
    if (!rel || rel.startsWith('../') || rel === '..' || path.isAbsolute(rel) || !isImportable(rel)) continue;
    const key = `${link.dest}/${rel}`;
    const target = safePath(dataDir, key);
    let st: fs.Stats | null;
    try {
      st = fs.statSync(abs);
    } catch {
      st = null;
    }
    if (st?.isFile()) {
      const file: PlannedFile = { abs, rel, bytes: st.size, mtimeMs: st.mtimeMs };
      if (sameFile(target, file)) continue;
      copyAtomic(abs, target, st.mtimeMs);
      changed.push(key);
    } else if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true });
      pruneEmptyDirs(path.dirname(target), destAbs);
      changed.push(key);
    }
  }
  return { changed };
}

/** The `only` list for a sync after a mirror pass: each key while there are few, the whole mirror otherwise. */
function syncScope(dest: string, keys: string[]): string[] {
  return keys.length > SYNC_KEYS_MAX ? [dest] : keys;
}

type FolderContext = SyncContext;

function persistLinks(ctx: FolderContext, links: LinkedFolder[]): void {
  ctx.config.ingest.linkedFolders = links;
  saveConfig(ctx.dataDir, ctx.config);
}

/**
 * Import a folder: mirror it under raw/docs, remember it when linking, and
 * sync the mirror so it is indexed before this returns. Tier-1 extraction
 * follows in the background pass, as for any other document.
 */
export async function importFolder(ctx: FolderContext, source: string, opts: ImportFolderOptions): Promise<ImportFolderResult> {
  const src = resolveImportSource(ctx.dataDir, source);
  const dest = importDestFor(src, opts.dest);
  const links = linkedFolders(ctx.config);
  const owner = linkOwning(links, dest);
  if (owner) throw new FolderImportConflict(`${owner.dest} is already linked to ${owner.source} — unlink it first`);
  const inside = linksUnder(links, dest);
  if (inside.length) throw new FolderImportConflict(`${dest} would contain the linked folder ${inside[0].dest} — pick another destination`);
  if (opts.mode === 'link') {
    const twin = links.find((l) => l.source === src);
    if (twin) throw new FolderImportConflict(`${src} is already linked at ${twin.dest}`);
  }
  const exists = fs.existsSync(safePath(ctx.dataDir, dest));
  if (exists && !opts.replace) throw new FolderImportConflict(`${dest} already exists — pick another destination, or replace it`);

  const progress = opts.onProgress ?? (() => {});
  progress(`${opts.mode === 'link' ? 'linking' : 'importing'} ${src} → ${dest}`);
  const release = holdDest(ctx.dataDir, dest);
  try {
    const mirrored = mirrorFolder(ctx.dataDir, src, dest, { prune: exists });
    progress(`${opts.mode}: ${mirrored.copied.length} copied, ${mirrored.removed.length} removed, ${mirrored.unchanged} unchanged${mirrored.tooLarge ? `, ${mirrored.tooLarge} above the index limit` : ''}`);
    if (opts.mode === 'link') {
      persistLinks(ctx, [...links, { source: src, dest, createdAt: new Date().toISOString() }]);
    }
    const stats = await sync(ctx, { only: [dest], llmGraph: opts.llmGraph, onProgress: opts.onProgress });
    return { ...mirrored, source: src, dest, mode: opts.mode, sync: stats };
  } finally {
    release();
  }
}

export interface RefreshResult extends MirrorResult {
  dest: string;
  /** Null when the mirror was already current and nothing needed syncing. */
  sync: SyncStats | null;
  /** The source folder is not there (unmounted, renamed): the mirror was left alone. */
  sourceMissing: boolean;
}

/**
 * Bring one link's mirror up to date and sync what changed. A source that is
 * not there is left alone rather than pruned: an unmounted disk must not
 * dispose a whole folder's knowledge.
 */
export async function refreshLinkedFolder(ctx: FolderContext, link: LinkedFolder, opts: { onProgress?: (m: string) => void } = {}): Promise<RefreshResult> {
  let present = false;
  try {
    present = fs.statSync(link.source).isDirectory();
  } catch {
    present = false;
  }
  if (!present) {
    return { dest: link.dest, copied: [], removed: [], unchanged: 0, files: 0, bytes: 0, skippedByType: 0, tooLarge: 0, sync: null, sourceMissing: true };
  }
  const mirrored = mirrorFolder(ctx.dataDir, link.source, link.dest, { prune: true });
  const changed = [...mirrored.copied, ...mirrored.removed];
  if (changed.length === 0) return { ...mirrored, dest: link.dest, sync: null, sourceMissing: false };
  opts.onProgress?.(`linked ${link.dest}: ${mirrored.copied.length} copied, ${mirrored.removed.length} removed`);
  const stats = await sync(ctx, { only: syncScope(link.dest, changed), onProgress: opts.onProgress });
  return { ...mirrored, dest: link.dest, sync: stats, sourceMissing: false };
}

/** Refresh every link, or the one at `dest`. */
export async function refreshLinkedFolders(ctx: FolderContext, dest?: string, opts: { onProgress?: (m: string) => void } = {}): Promise<RefreshResult[]> {
  const links = linkedFolders(ctx.config).filter((l) => !dest || l.dest === dest);
  if (dest && links.length === 0) throw new Error(`no linked folder at ${dest}`);
  const out: RefreshResult[] = [];
  for (const link of links) out.push(await refreshLinkedFolder(ctx, link, opts));
  return out;
}

/**
 * Forget a link. The mirror stays as ordinary workspace content unless
 * `removeFiles` is set, in which case it is deleted and its sources disposed
 * (reversible through the ledger, like any removal).
 */
export async function unlinkFolder(ctx: FolderContext, dest: string, opts: { removeFiles?: boolean; onProgress?: (m: string) => void } = {}): Promise<{ dest: string; removedFiles: boolean; sync: SyncStats | null }> {
  const links = linkedFolders(ctx.config);
  const link = links.find((l) => l.dest === dest);
  if (!link) throw new Error(`no linked folder at ${dest}`);
  if (!opts.removeFiles) {
    persistLinks(ctx, links.filter((l) => l !== link));
    return { dest, removedFiles: false, sync: null };
  }
  // held before the link is forgotten: from then on the mirror is no longer
  // the link's, and its removal is synced right here
  const release = holdDest(ctx.dataDir, dest);
  try {
    persistLinks(ctx, links.filter((l) => l !== link));
    fs.rmSync(safePath(ctx.dataDir, dest), { recursive: true, force: true });
    const stats = await sync(ctx, { only: [dest], onProgress: opts.onProgress });
    return { dest, removedFiles: true, sync: stats };
  } finally {
    release();
  }
}

export interface LinkedFolderStatus extends LinkedFolder {
  sourceExists: boolean;
  /** Files in the mirror right now. */
  files: number;
  bytes: number;
  /** A watcher is on the source (false outside `serve`). */
  watching: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  lastChange: { copied: number; removed: number; at: string } | null;
}

export interface LinkRuntime {
  watching: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  lastChange: { copied: number; removed: number; at: string } | null;
}

/** Every link with what is on disk now, plus the runtime's view of it when `serve` supplies one. */
export function describeLinkedFolders(ctx: { dataDir: string; config: KnodeConfig }, runtime?: Map<string, LinkRuntime>): LinkedFolderStatus[] {
  return linkedFolders(ctx.config).map((link) => {
    let files = 0;
    let bytes = 0;
    try {
      for (const key of walkFiles(ctx.dataDir, link.dest)) {
        files++;
        bytes += fs.statSync(safePath(ctx.dataDir, key)).size;
      }
    } catch {
      // a mirror someone removed by hand: reported as empty
    }
    let sourceExists = false;
    try {
      sourceExists = fs.statSync(link.source).isDirectory();
    } catch {
      sourceExists = false;
    }
    const rt = runtime?.get(link.dest);
    return {
      ...link,
      sourceExists,
      files,
      bytes,
      watching: rt?.watching ?? false,
      lastSyncAt: rt?.lastSyncAt ?? null,
      lastError: rt?.lastError ?? null,
      lastChange: rt?.lastChange ?? null,
    };
  });
}

/* ------------------------------ the watcher ------------------------------ */

interface PendingEvents {
  timer: NodeJS.Timeout | null;
  running: boolean;
  /** Events arrived while a pass ran: run once more when it ends. */
  rerun: boolean;
}

export interface LinkedFoldersOptions {
  log?: (msg: string) => void;
  /** Register a background promise so shutdown waits for it. */
  track?: <T>(job: Promise<T>) => Promise<T>;
  /** Quiet time after the last event before a pass runs. */
  debounceMs?: number;
  /** Full reconcile of every link this often (stat-only when nothing changed); 0 disables. */
  reconcileMinutes?: number;
  /** A file must stop changing for this long before it counts as written — exports rewrite whole files. The quiet time is the longer of the two. */
  writeSettleMs?: number;
}

/**
 * What `serve` runs per workspace for its linked folders: one recursive
 * watcher per source (src/fs/watch.ts — one handle per tree, never one per
 * file) whose events re-mirror the link and sync the keys that changed, one
 * such pass as each watcher opens for what changed before it could report
 * anything, a startup refresh for whatever changed while knode-os was down,
 * and a periodic reconcile for the events a filesystem watcher drops.
 */
export class LinkedFolders {
  private readonly watchers = new Map<string, TreeWatcher>();
  private readonly pending = new Map<string, PendingEvents>();
  private readonly runtime = new Map<string, LinkRuntime>();
  private reconcileTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly log: (msg: string) => void;
  private readonly track: <T>(job: Promise<T>) => Promise<T>;
  private readonly debounceMs: number;

  constructor(private readonly ctx: FolderContext, private readonly opts: LinkedFoldersOptions = {}) {
    this.log = opts.log ?? (() => {});
    this.track = opts.track ?? ((job) => job);
    this.debounceMs = Math.max(opts.debounceMs ?? 1500, opts.writeSettleMs ?? 1000);
  }

  /** Watch every configured link and refresh each one once, in the background. */
  start(): void {
    for (const link of linkedFolders(this.ctx.config)) {
      this.watch(link);
      void this.track(this.refreshOne(link).catch((err) => this.log(`linked ${link.dest}: refresh failed: ${err instanceof Error ? err.message : err}`)));
    }
    const minutes = this.opts.reconcileMinutes ?? 10;
    if (minutes > 0) {
      this.reconcileTimer = setInterval(() => {
        if (this.stopped) return;
        void this.track(this.refresh().catch((err) => this.log(`linked folders: reconcile failed: ${err instanceof Error ? err.message : err}`)));
      }, minutes * 60_000);
      this.reconcileTimer.unref?.();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    for (const state of this.pending.values()) if (state.timer) clearTimeout(state.timer);
    this.pending.clear();
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    for (const rt of this.runtime.values()) rt.watching = false;
  }

  /** Link a folder: mirror, remember, index, then watch it. */
  async add(source: string, opts: Omit<ImportFolderOptions, 'mode'> = {}): Promise<ImportFolderResult> {
    const result = await importFolder(this.ctx, source, { ...opts, mode: 'link', onProgress: opts.onProgress ?? this.log });
    const link = linkedFolders(this.ctx.config).find((l) => l.dest === result.dest);
    if (link) {
      this.watch(link);
      this.runtime.set(link.dest, { ...this.runtimeOf(link.dest), lastSyncAt: new Date().toISOString(), lastChange: { copied: result.copied.length, removed: result.removed.length, at: new Date().toISOString() } });
    }
    return result;
  }

  /** Forget a link and stop watching it; optionally remove the mirror. */
  async remove(dest: string, opts: { removeFiles?: boolean } = {}): Promise<Awaited<ReturnType<typeof unlinkFolder>>> {
    this.unwatch(dest);
    this.runtime.delete(dest);
    return unlinkFolder(this.ctx, dest, { ...opts, onProgress: this.log });
  }

  /** Bring every link (or the one at `dest`) up to date now. */
  async refresh(dest?: string): Promise<RefreshResult[]> {
    const links = linkedFolders(this.ctx.config).filter((l) => !dest || l.dest === dest);
    if (dest && links.length === 0) throw new Error(`no linked folder at ${dest}`);
    const out: RefreshResult[] = [];
    for (const link of links) out.push(await this.refreshOne(link));
    return out;
  }

  status(): LinkedFolderStatus[] {
    return describeLinkedFolders(this.ctx, this.runtime);
  }

  /**
   * Apply a batch of watcher events for one link right away — what a
   * debounced pass does, exposed so it can be driven without a filesystem
   * watcher.
   */
  async apply(link: LinkedFolder, absPaths: string[], opts: { full?: boolean } = {}): Promise<void> {
    const at = new Date().toISOString();
    try {
      if (opts.full) {
        await this.refreshOne(link);
        return;
      }
      const { changed } = mirrorPaths(this.ctx.dataDir, link, absPaths);
      if (changed.length === 0) return;
      this.log(`linked ${link.dest}: ${changed.length} change(s) from ${link.source}`);
      await sync(this.ctx, { only: syncScope(link.dest, changed), onProgress: this.log });
      this.runtime.set(link.dest, { ...this.runtimeOf(link.dest), lastSyncAt: at, lastError: null, lastChange: { copied: changed.length, removed: 0, at } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.runtime.set(link.dest, { ...this.runtimeOf(link.dest), lastError: message });
      this.log(`linked ${link.dest}: sync failed: ${message}`);
    }
  }

  private runtimeOf(dest: string): LinkRuntime {
    return this.runtime.get(dest) ?? { watching: this.watchers.has(dest), lastSyncAt: null, lastError: null, lastChange: null };
  }

  private async refreshOne(link: LinkedFolder): Promise<RefreshResult> {
    const at = new Date().toISOString();
    try {
      const result = await refreshLinkedFolder(this.ctx, link, { onProgress: this.log });
      const rt = this.runtimeOf(link.dest);
      this.runtime.set(link.dest, {
        ...rt,
        lastSyncAt: at,
        lastError: result.sourceMissing ? `source folder not found: ${link.source}` : null,
        lastChange: result.copied.length || result.removed.length ? { copied: result.copied.length, removed: result.removed.length, at } : rt.lastChange,
      });
      // a source that was away (or whose watcher failed) is watched again once it is back
      if (!result.sourceMissing) this.watch(link);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.runtime.set(link.dest, { ...this.runtimeOf(link.dest), lastError: message });
      throw err;
    }
  }

  /** The link is still configured — a refresh that ends after an unlink must not watch it again. */
  private isLinked(link: LinkedFolder): boolean {
    return linkedFolders(this.ctx.config).some((l) => l.dest === link.dest && l.source === link.source);
  }

  private watch(link: LinkedFolder): void {
    if (this.stopped || this.watchers.has(link.dest) || !this.isLinked(link)) return;
    let watcher: TreeWatcher;
    try {
      watcher = watchTree(link.source, () => this.onEvent(link), {
        // dot-entries never travel (the exporter's `.state/` cache, `.git/`), so their churn is not ours to see
        ignore: (rel) => rel.split('/').some((seg) => seg && isHiddenName(seg)),
        onError: (err) => {
          this.runtime.set(link.dest, { ...this.runtimeOf(link.dest), lastError: err.message });
          this.log(`linked ${link.dest}: watcher error: ${err.message}`);
          // dropped: the next reconcile watches the source again once it is there
          this.unwatch(link.dest);
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.runtime.set(link.dest, { ...this.runtimeOf(link.dest), lastError: message });
      this.log(`linked ${link.dest}: cannot watch ${link.source}: ${message}`);
      return;
    }
    this.watchers.set(link.dest, watcher);
    this.runtime.set(link.dest, { ...this.runtimeOf(link.dest), watching: true });
    this.log(`watching ${link.source} → ${link.dest}`);
    // a change made before the OS's side of the watch is up is never reported —
    // one since the walk that ran before this (the import, a refresh) or one in
    // the moment FSEvents takes to open its stream on another thread once
    // fs.watch has returned — so one debounced pass re-walks the source
    this.onEvent(link);
  }

  private unwatch(dest: string): void {
    const watcher = this.watchers.get(dest);
    this.watchers.delete(dest);
    const state = this.pending.get(dest);
    if (state?.timer) clearTimeout(state.timer);
    this.pending.delete(dest);
    watcher?.close();
    const rt = this.runtime.get(dest);
    if (rt) rt.watching = false;
  }

  private onEvent(link: LinkedFolder): void {
    if (this.stopped) return;
    const state = this.pending.get(link.dest) ?? { timer: null, running: false, rerun: false };
    this.pending.set(link.dest, state);
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => void this.flush(link, state), this.debounceMs);
  }

  private async flush(link: LinkedFolder, state: PendingEvents): Promise<void> {
    state.timer = null;
    if (this.stopped || !this.isLinked(link)) return;
    if (state.running) {
      state.rerun = true;
      return;
    }
    state.running = true;
    try {
      // an event only says that something under the source changed; re-walking
      // the source against the mirror (stats only) decides what to copy, remove
      // and sync — whatever the event's path, kind, or spelling of the name
      await this.track(this.refreshOne(link).catch((err) => this.log(`linked ${link.dest}: sync failed: ${err instanceof Error ? err.message : err}`)));
    } finally {
      state.running = false;
      if (state.rerun) {
        state.rerun = false;
        state.timer = setTimeout(() => void this.flush(link, state), this.debounceMs);
      }
    }
  }
}
