import fs from 'node:fs';
import path from 'node:path';
import { CodebaseLink, KnodeConfig, saveConfig } from '../../config.js';
import { safePath } from '../../fs/files.js';
import { CODEBASE_CARDS, RAW_CODEBASE } from '../../fs/layout.js';
import { writeIfChanged } from '../feishu/mirror.js';
import { FolderPlan, holdDest, MirrorResult, mirrorPlan } from '../folders.js';
import { sync, SyncContext, SyncStats } from '../sync.js';
import { renderCard } from './card.js';
import {
  DEFAULT_CODE_FILE_BYTES,
  DEFAULT_CODEBASE_BYTES,
  DEFAULT_CODEBASE_FILES,
  globToRegExp,
  isRepoDoc,
  looksGenerated,
  matchesAnyGlob,
  MAX_REPO_DOCS,
  skipReason,
} from './files.js';
import { cloneDir, codebaseName, fetchCommit, parseRepoSpec, RepoSpec } from './git.js';

/**
 * Code repositories as a source (docs/design/25).
 *
 * `add` fetches one commit of a repository into a working clone under
 * `.knode/codebases/<name>/`, mirrors the files a reader of the code needs —
 * source, configuration and prose, never dependencies, build output,
 * lockfiles, generated or binary files — into `raw/codebase/<name>/`, writes
 * the repository's card to `raw/docs/codebase/<name>.md`, and syncs both:
 *
 *   - the files are indexed under the `codebase` root: cut along their
 *     language's definitions, embedded and searchable (kind `code`), read and
 *     grepped by agents, but never sent to a model one by one — a repository
 *     is thousands of files, and agents read code better by searching it
 *     than from per-file summaries;
 *   - the card is an ordinary document: extraction and the summary page turn
 *     it into the repository's entities and its page in the wiki.
 *
 * `update` fetches the tracked ref again; git rewrites only what changed, the
 * mirror copies only that, and the sync re-indexes only that. A followed
 * repository is updated by `serve` once a day. The mirror and the card belong
 * to the repository entry: writes into them are refused, and `remove` takes
 * them away.
 */

export interface CodebaseContext extends SyncContext {}

export interface AddCodebaseOptions {
  name?: string;
  ref?: string;
  include?: string[];
  exclude?: string[];
  follow?: boolean;
  /** Copy the documentation to raw/docs/codebase/<name>/ for extraction and summaries (default true). */
  docs?: boolean;
  /** Allow a path on this machine as the source (the CLI); the HTTP routes take remote URLs only. */
  allowLocal?: boolean;
  /** Per-file and per-repository limits. */
  maxFileBytes?: number;
  maxFiles?: number;
  maxBytes?: number;
  llmGraph?: boolean;
  onProgress?: (msg: string) => void;
}

export interface CodebaseResult extends MirrorResult {
  name: string;
  dir: string;
  card: string;
  /** Documentation files copied under raw/docs/codebase/<name>/. */
  docs: number;
  commit: string;
  committedAt: string;
  /** False when the commit was the one already held and nothing was copied. */
  changed: boolean;
  skipped: Record<string, number>;
  sync: SyncStats | null;
}

export class CodebaseConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodebaseConflict';
  }
}

export function codebaseLinks(config: KnodeConfig): CodebaseLink[] {
  return Array.isArray(config.ingest.codebases) ? config.ingest.codebases : [];
}

export function codebaseDir(name: string): string {
  return `${RAW_CODEBASE}/${name}`;
}

export function codebaseCard(name: string): string {
  return `${CODEBASE_CARDS}/${name}.md`;
}

/** Where a repository's documentation is copied for the document pipeline. */
export function codebaseDocsDir(name: string): string {
  return `${CODEBASE_CARDS}/${name}`;
}

function persist(ctx: CodebaseContext, links: CodebaseLink[]): void {
  ctx.config.ingest.codebases = links;
  saveConfig(ctx.dataDir, ctx.config);
}

/** Only remote transports for a request from outside; a local path or a file:// URL only when the caller may read this machine. */
export function assertFetchable(url: string, allowLocal: boolean): void {
  if (/^(https?:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:)/i.test(url)) return;
  if (/^[a-z][a-z0-9+.-]*::/i.test(url) || /^ext::/i.test(url)) throw new Error(`${url}: this git transport is not allowed`);
  if (!allowLocal) throw new Error(`${url}: give the repository's https or ssh URL — a path on the server's machine is taken only from its own command line`);
}

/** A ref git takes as a ref, never as an option: letters, digits and `._/-`, not starting with `-`. */
export function checkRef(ref: string | undefined): string | undefined {
  const r = ref?.trim();
  if (!r) return undefined;
  if (!/^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/.test(r) || r.includes('..')) throw new Error(`"${ref}" is not a branch, tag or commit name`);
  return r;
}

/* ------------------------------- the plan ------------------------------- */

export interface CodebasePlanOptions {
  include?: string[];
  exclude?: string[];
  maxFileBytes?: number;
}

/** What of the clone travels: every file the rules and the globs let through, within the size limit. */
export function planCodebase(source: string, opts: CodebasePlanOptions = {}): { plan: FolderPlan; skipped: Record<string, number> } {
  const include = (opts.include ?? []).filter(Boolean).map(globToRegExp);
  const exclude = (opts.exclude ?? []).filter(Boolean).map(globToRegExp);
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_CODE_FILE_BYTES;
  const plan: FolderPlan = { source, files: [], bytes: 0, skippedByType: 0, tooLarge: 0 };
  const skipped: Record<string, number> = {};
  const skip = (why: string) => {
    skipped[why] = (skipped[why] ?? 0) + 1;
    plan.skippedByType++;
  };
  const visit = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // a folder the rules leave behind is not walked at all (node_modules, .git)
        const why = skipReason(`${childRel}/x.ts`);
        if (why === 'hidden' || why === 'dependencies') continue;
        if (exclude.length && matchesAnyGlob(childRel, exclude)) continue;
        visit(abs, childRel);
        continue;
      }
      if (!e.isFile()) {
        skip('type'); // a symlink may point anywhere
        continue;
      }
      const why = skipReason(childRel);
      if (why) {
        skip(why);
        continue;
      }
      if ((include.length && !matchesAnyGlob(childRel, include)) || (exclude.length && matchesAnyGlob(childRel, exclude))) {
        skip('filtered');
        continue;
      }
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (st.size > maxFileBytes) {
        skipped.tooLarge = (skipped.tooLarge ?? 0) + 1;
        plan.tooLarge++;
        continue;
      }
      if (looksGenerated(abs, st.size)) {
        skip('generated');
        continue;
      }
      plan.files.push({ abs, rel: childRel, bytes: st.size, mtimeMs: st.mtimeMs });
      plan.bytes += st.size;
    }
  };
  visit(source, '');
  return { plan, skipped };
}

/* ---------------------------- add and update ---------------------------- */

async function bringUp(
  ctx: CodebaseContext,
  link: CodebaseLink,
  opts: { maxFileBytes?: number; maxFiles?: number; maxBytes?: number; llmGraph?: boolean; onProgress?: (m: string) => void; force?: boolean },
): Promise<CodebaseResult> {
  const progress = opts.onProgress ?? (() => {});
  const dir = codebaseDir(link.name);
  const card = codebaseCard(link.name);
  const clone = cloneDir(ctx.dataDir, link.name);
  progress(`fetching ${link.url}${link.ref ? ` (${link.ref})` : ''}`);
  const head = await fetchCommit(clone, link.url, link.ref);
  const { plan, skipped } = planCodebase(clone, { include: link.include, exclude: link.exclude, maxFileBytes: opts.maxFileBytes });
  const maxFiles = opts.maxFiles ?? DEFAULT_CODEBASE_FILES;
  const maxBytes = opts.maxBytes ?? DEFAULT_CODEBASE_BYTES;
  if (plan.files.length > maxFiles || plan.bytes > maxBytes) {
    throw new Error(`${link.name} would carry ${plan.files.length} files (${(plan.bytes / 1e6).toFixed(0)} MB), above the limit of ${maxFiles} files / ${(maxBytes / 1e6).toFixed(0)} MB — narrow it with --include (e.g. "src/**") or --exclude`);
  }
  const docsDir = codebaseDocsDir(link.name);
  const release = holdDest(ctx.dataDir, dir);
  const releaseCard = holdDest(ctx.dataDir, card);
  const releaseDocs = holdDest(ctx.dataDir, docsDir);
  try {
    progress(`mirroring ${plan.files.length} files into ${dir}`);
    const mirror = mirrorPlan(ctx.dataDir, plan, dir, { prune: true });
    // the documentation, a second time, as documents: what extraction and summaries read
    const docFiles = link.docs === false ? [] : plan.files.filter((f) => isRepoDoc(f.rel))
      .sort((a, b) => a.rel.split('/').length - b.rel.split('/').length || a.rel.localeCompare(b.rel))
      .slice(0, MAX_REPO_DOCS);
    const docsAbs = safePath(ctx.dataDir, docsDir);
    const docs = docFiles.length > 0
      ? mirrorPlan(ctx.dataDir, { source: plan.source, files: docFiles, bytes: docFiles.reduce((n, f) => n + f.bytes, 0), skippedByType: 0, tooLarge: 0 }, docsDir, { prune: true })
      : { copied: [] as string[], removed: fs.existsSync(docsAbs) ? ['(all)'] : [] };
    if (docFiles.length === 0) fs.rmSync(docsAbs, { recursive: true, force: true });
    const markdown = renderCard({
      name: link.name,
      title: titleFor(link),
      url: link.url,
      web: link.web ?? null,
      ref: link.ref ?? null,
      commit: head.commit,
      committedAt: head.committedAt,
      subject: head.subject,
      files: plan.files.map((f) => ({ rel: f.rel, abs: f.abs, bytes: f.bytes })),
      skipped,
      include: link.include ?? [],
      exclude: link.exclude ?? [],
    });
    const cardChanged = writeIfChanged(safePath(ctx.dataDir, card), markdown);
    const changed = mirror.copied.length > 0 || mirror.removed.length > 0 || cardChanged || docs.copied.length > 0 || docs.removed.length > 0;
    let stats: SyncStats | null = null;
    if (changed || opts.force) {
      progress(`indexing ${dir}, ${card}${docFiles.length ? ` and ${docFiles.length} documentation files under ${docsDir}` : ''}`);
      stats = await sync(ctx, { only: [dir, card, docsDir], llmGraph: opts.llmGraph, actor: 'codebase', onProgress: progress });
    }
    return { ...mirror, name: link.name, dir, card, docs: docFiles.length, commit: head.commit, committedAt: head.committedAt, changed, skipped, sync: stats };
  } finally {
    release();
    releaseCard();
    releaseDocs();
  }
}

function titleFor(link: CodebaseLink): string {
  const web = link.web ? /^https:\/\/[^/]+\/(.+)$/.exec(link.web)?.[1] : null;
  return web ?? link.name;
}

/** Add a repository: fetch, mirror, card, index — and remember it. */
export async function addCodebase(ctx: CodebaseContext, spec: string, opts: AddCodebaseOptions = {}): Promise<CodebaseResult> {
  const repo: RepoSpec = parseRepoSpec(spec);
  assertFetchable(repo.url, Boolean(opts.allowLocal));
  const name = opts.name ? codebaseName(opts.name) : repo.name;
  const links = codebaseLinks(ctx.config);
  if (links.some((l) => l.name === name)) throw new CodebaseConflict(`a repository is already kept as ${codebaseDir(name)} — update it, or pick another --name`);
  if (fs.existsSync(safePath(ctx.dataDir, codebaseDir(name)))) throw new CodebaseConflict(`${codebaseDir(name)} already exists — pick another --name`);
  const link: CodebaseLink = {
    name,
    url: repo.url,
    web: repo.web,
    ...(checkRef(opts.ref) ? { ref: checkRef(opts.ref) } : {}),
    ...(opts.include?.length ? { include: opts.include } : {}),
    ...(opts.exclude?.length ? { exclude: opts.exclude } : {}),
    follow: Boolean(opts.follow),
    ...(opts.docs === false ? { docs: false } : {}),
    createdAt: new Date().toISOString(),
  };
  let result: CodebaseResult;
  try {
    result = await bringUp(ctx, link, { ...opts, force: true });
  } catch (e) {
    // a first fetch that failed leaves nothing behind but the error
    fs.rmSync(cloneDir(ctx.dataDir, name), { recursive: true, force: true });
    throw e;
  }
  persist(ctx, [...codebaseLinks(ctx.config), { ...link, commit: result.commit, committedAt: result.committedAt, checkedAt: new Date().toISOString() }]);
  return result;
}

/** Fetch the tracked ref of one repository (or every one) again and index what changed. */
export async function updateCodebases(
  ctx: CodebaseContext,
  name?: string,
  opts: { followedOnly?: boolean; force?: boolean; llmGraph?: boolean; onProgress?: (m: string) => void } = {},
): Promise<(CodebaseResult | { name: string; error: string })[]> {
  const links = codebaseLinks(ctx.config).filter((l) => (name ? l.name === name : !opts.followedOnly || l.follow));
  if (name && links.length === 0) throw new Error(`no repository named ${name} — \`knode-os codebase list\` shows them`);
  const out: (CodebaseResult | { name: string; error: string })[] = [];
  for (const link of links) {
    try {
      const r = await bringUp(ctx, link, { llmGraph: opts.llmGraph, onProgress: opts.onProgress, force: opts.force });
      out.push(r);
      note(ctx, link.name, { commit: r.commit, committedAt: r.committedAt, checkedAt: new Date().toISOString() });
    } catch (e) {
      out.push({ name: link.name, error: e instanceof Error ? e.message : String(e) });
      note(ctx, link.name, { checkedAt: new Date().toISOString() });
    }
  }
  return out;
}

function note(ctx: CodebaseContext, name: string, patch: Partial<CodebaseLink>): void {
  persist(ctx, codebaseLinks(ctx.config).map((l) => (l.name === name ? { ...l, ...patch } : l)));
}

/** Change what an entry tracks (ref, globs, follow); the next update applies it. */
export function editCodebase(ctx: CodebaseContext, name: string, patch: Pick<Partial<CodebaseLink>, 'ref' | 'include' | 'exclude' | 'follow' | 'docs'>): CodebaseLink {
  const link = codebaseLinks(ctx.config).find((l) => l.name === name);
  if (!link) throw new Error(`no repository named ${name}`);
  const next: CodebaseLink = { ...link, ...patch };
  if (patch.ref !== undefined) {
    const ref = checkRef(patch.ref);
    if (ref) next.ref = ref;
    else delete next.ref;
  }
  persist(ctx, codebaseLinks(ctx.config).map((l) => (l.name === name ? next : l)));
  return next;
}

/** Forget a repository; its files, card and clone go too unless `keepFiles` (then they stay as plain workspace content). */
export async function removeCodebase(
  ctx: CodebaseContext,
  name: string,
  opts: { keepFiles?: boolean; onProgress?: (m: string) => void } = {},
): Promise<{ name: string; removedFiles: boolean; sync: SyncStats | null }> {
  const link = codebaseLinks(ctx.config).find((l) => l.name === name);
  if (!link) throw new Error(`no repository named ${name}`);
  persist(ctx, codebaseLinks(ctx.config).filter((l) => l.name !== name));
  fs.rmSync(cloneDir(ctx.dataDir, name), { recursive: true, force: true });
  if (opts.keepFiles) return { name, removedFiles: false, sync: null };
  const dir = codebaseDir(name);
  const card = codebaseCard(name);
  const docsDir = codebaseDocsDir(name);
  const release = holdDest(ctx.dataDir, dir);
  const releaseDocs = holdDest(ctx.dataDir, docsDir);
  try {
    fs.rmSync(safePath(ctx.dataDir, dir), { recursive: true, force: true });
    fs.rmSync(safePath(ctx.dataDir, docsDir), { recursive: true, force: true });
    fs.rmSync(safePath(ctx.dataDir, card), { force: true });
    const stats = await sync(ctx, { only: [dir, card, docsDir], actor: 'codebase', onProgress: opts.onProgress });
    return { name, removedFiles: true, sync: stats };
  } finally {
    release();
    releaseDocs();
  }
}

export interface CodebaseStatus extends CodebaseLink {
  dir: string;
  card: string;
  files: number;
  bytes: number;
}

export function describeCodebases(ctx: { dataDir: string; config: KnodeConfig }): CodebaseStatus[] {
  return codebaseLinks(ctx.config).map((l) => {
    const dir = codebaseDir(l.name);
    let files = 0;
    let bytes = 0;
    const walk = (abs: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(abs, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) {
          files++;
          try {
            bytes += fs.statSync(p).size;
          } catch {
            // gone meanwhile
          }
        }
      }
    };
    walk(safePath(ctx.dataDir, dir));
    return { ...l, dir, card: codebaseCard(l.name), files, bytes };
  });
}

/* ------------------------------ daily check ------------------------------ */

const DEFAULT_CHECK_AT = '05:00';

/** The next local time `HH:MM` falls at, after `from`; null when checks are off. */
export function nextCodebaseCheck(config: KnodeConfig, from: Date): Date | null {
  const at = (config.ingest.codebaseCheckAt ?? DEFAULT_CHECK_AT).trim();
  if (at === 'off') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(at) ?? /^(\d{1,2}):(\d{2})$/.exec(DEFAULT_CHECK_AT)!;
  const next = new Date(from);
  next.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (next <= from) next.setDate(next.getDate() + 1);
  return next;
}

/** True when a followed repository has not been looked at since the last scheduled time. */
export function codebaseCheckOwed(config: KnodeConfig, now: Date): boolean {
  const followed = codebaseLinks(config).filter((l) => l.follow);
  if (followed.length === 0) return false;
  const next = nextCodebaseCheck(config, new Date(now.getTime() - 24 * 3600_000));
  if (!next || next > now) return false;
  return followed.some((l) => !l.checkedAt || new Date(l.checkedAt) < next);
}

export interface CodebasesOptions {
  log?: (msg: string) => void;
  track?: <T>(job: Promise<T>) => Promise<T>;
  /** Seconds after start before the first look (default 60). */
  firstCheckSeconds?: number;
}

const RETRY_MS = 60 * 60_000;

/**
 * What `serve` runs per workspace for its repositories: once a day, at
 * `ingest.codebaseCheckAt`, every followed one is fetched again and what
 * changed is indexed; `update` and `add` go through here so one fetch runs
 * at a time per workspace.
 */
export class Codebases {
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  private retryAfter = 0;
  private stopped = false;
  private readonly log: (msg: string) => void;
  private readonly track: <T>(job: Promise<T>) => Promise<T>;

  constructor(private readonly ctx: CodebaseContext, private readonly opts: CodebasesOptions = {}) {
    this.log = opts.log ?? (() => {});
    this.track = opts.track ?? ((job) => job);
  }

  start(): void {
    const tick = () => {
      // fetching and indexing are local work; the card's extraction waits in the queue like any document's, under the quota floor
      if (this.stopped || this.running || Date.now() < this.retryAfter) return;
      if (codebaseCheckOwed(this.ctx.config, new Date())) void this.update(undefined, { followedOnly: true, scheduled: true });
    };
    this.first = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, 5 * 60_000);
      this.timer.unref?.();
    }, (this.opts.firstCheckSeconds ?? 60) * 1000);
    this.first.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
    await this.running?.catch(() => {});
  }

  get busy(): boolean {
    return this.running !== null;
  }

  /** One operation at a time: a second waits for the first. */
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const before = this.running ?? Promise.resolve();
    const run = before.catch(() => {}).then(job);
    const tracked = this.track(run);
    this.running = tracked;
    void tracked.finally(() => {
      if (this.running === tracked) this.running = null;
    }).catch(() => {});
    return tracked;
  }

  add(spec: string, opts: AddCodebaseOptions): Promise<CodebaseResult> {
    return this.serial(() => addCodebase(this.ctx, spec, { ...opts, onProgress: opts.onProgress ?? ((m) => this.log(`codebase: ${m}`)) }));
  }

  update(name?: string, opts: { followedOnly?: boolean; force?: boolean; scheduled?: boolean } = {}): Promise<(CodebaseResult | { name: string; error: string })[]> {
    return this.serial(async () => {
      const results = await updateCodebases(this.ctx, name, { followedOnly: opts.followedOnly, force: opts.force, onProgress: (m) => this.log(`codebase: ${m}`) });
      for (const r of results) {
        this.log('error' in r
          ? `codebase ${r.name}: update failed: ${r.error}`
          : `codebase ${r.name}: ${r.changed ? `now at ${r.commit.slice(0, 12)}, ${r.copied.length} files copied, ${r.removed.length} removed` : `unchanged at ${r.commit.slice(0, 12)}`}`);
      }
      if (opts.scheduled && results.some((r) => 'error' in r)) this.retryAfter = Date.now() + RETRY_MS;
      return results;
    });
  }

  remove(name: string, opts: { keepFiles?: boolean } = {}): ReturnType<typeof removeCodebase> {
    return this.serial(() => removeCodebase(this.ctx, name, { ...opts, onProgress: (m) => this.log(`codebase: ${m}`) }));
  }
}
