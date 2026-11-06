import fs from 'node:fs';
import path from 'node:path';
import { activityOf } from '../../activity.js';
import { ConversationLink, KnodeConfig, saveConfig } from '../../config.js';
import { safePath, sanitizeRelativePath } from '../../fs/files.js';
import { RAW_DOCS } from '../../fs/layout.js';
import { segmentName, writeIfChanged } from '../feishu/mirror.js';
import { FolderImportConflict, holdDest, linkOwning, linksUnder, mirrorLinks } from '../folders.js';
import { sync, SyncContext, SyncStats } from '../sync.js';
import { describeTranscript, findTranscript } from './catalog.js';
import { RENDER_VERSION, renderConversation, titleOf } from './render.js';
import { AGENT_NAMES, ConversationAgent, projectOf, readConversationFile } from './transcript.js';

/**
 * Agent conversations as a source (docs/design/24): a Claude Code or Codex
 * session on this machine, rendered as dialogue into one Markdown file under
 * `raw/docs/conversations/<project>/`, once or kept in sync.
 *
 * **Import** (`copy`) writes the file and forgets the session: from then on it
 * is ordinary workspace content. **Follow** remembers it in
 * `ingest.conversations`; while `serve` runs, every
 * `ingest.conversationSync.everyMinutes` each followed transcript is looked
 * at, and one that changed and has been quiet for `quietMinutes` is rendered
 * again — written only when the Markdown changed, and synced by its key.
 * Rendering is stable (./render.ts), so what was there before keeps its
 * chunks, embeddings and extraction; only new exchanges cost anything.
 *
 * A followed copy belongs to its conversation: writes into it are refused
 * (mirrorLinks in src/ingest/folders.ts). A transcript that moved is found
 * again by its id; one gone from this machine — Claude Code deletes old ones —
 * leaves the copy as it was and says so.
 */

export const CONVERSATIONS_ROOT = `${RAW_DOCS}/conversations`;

/** What each followed transcript looked like when last rendered, so an unchanged one is not read again. */
const STATE_FILE = '.knode/conversation-sync.json';

export const DEFAULT_CHECK_MINUTES = 10;
export const DEFAULT_QUIET_MINUTES = 10;

export type ConversationImportMode = 'copy' | 'follow';

export interface ConversationRef {
  agent: ConversationAgent;
  id: string;
}

export function conversationLinks(config: KnodeConfig): ConversationLink[] {
  return Array.isArray(config.ingest.conversations) ? config.ingest.conversations : [];
}

export function conversationCheckMinutes(config: KnodeConfig): number {
  const n = Number(config.ingest.conversationSync?.everyMinutes);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_CHECK_MINUTES;
}

export function conversationQuietMinutes(config: KnodeConfig): number {
  const n = Number(config.ingest.conversationSync?.quietMinutes);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_QUIET_MINUTES;
}

function persistLinks(ctx: SyncContext, links: ConversationLink[]): void {
  ctx.config.ingest.conversations = links;
  saveConfig(ctx.dataDir, ctx.config);
}

/* ------------------------------ follow state ----------------------------- */

interface Rendered {
  size: number;
  mtimeMs: number;
  renderer: number;
  at: string;
}

function readState(dataDir: string): Record<string, Rendered> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, STATE_FILE), 'utf8')) as { entries?: Record<string, Rendered> };
    return raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
  } catch {
    return {};
  }
}

function writeState(dataDir: string, entries: Record<string, Rendered>): void {
  const file = path.join(dataDir, STATE_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
}

function noteRendered(dataDir: string, dest: string, stat: fs.Stats | null): void {
  const entries = readState(dataDir);
  if (stat) entries[dest] = { size: stat.size, mtimeMs: stat.mtimeMs, renderer: RENDER_VERSION, at: new Date().toISOString() };
  else delete entries[dest];
  writeState(dataDir, entries);
}

/* ------------------------------ placement -------------------------------- */

/** The session id's last 8 hex digits: the random part of both UUID v4 (Claude Code) and v7 (Codex). */
export function idTail(id: string): string {
  return id.replace(/[^0-9a-z]/gi, '').slice(-8).toLowerCase();
}

/** A folder under raw/docs the person named, as a key; refusing raw/docs itself. */
function folderKey(folder: string): string {
  const name = sanitizeRelativePath(folder.trim());
  const rel = name === RAW_DOCS || name.startsWith(`${RAW_DOCS}/`) ? name : `${RAW_DOCS}/${name}`;
  if (rel === RAW_DOCS) throw new Error(`the folder must be under ${RAW_DOCS}/, not ${RAW_DOCS} itself`);
  return rel;
}

/** `raw/docs/conversations/<project>/<title>__<id8>.md`, or the same file name in a folder the person named. */
export function conversationDestFor(c: { title: string; id: string; project: string | null }, folder?: string): string {
  const base = folder?.trim() ? folderKey(folder) : `${CONVERSATIONS_ROOT}/${segmentName(c.project ?? '', 'other')}`;
  return `${base}/${segmentName(c.title, 'conversation').slice(0, 72).trim()}__${idTail(c.id)}.md`;
}

/** The session a copy holds, from its frontmatter: `platform` and `session_id`. */
export function readCopyIdentity(dataDir: string, rel: string): { agent: ConversationAgent; id: string } | null {
  let head = '';
  try {
    const fd = fs.openSync(safePath(dataDir, rel), 'r');
    try {
      const buf = Buffer.alloc(4096);
      head = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const front = head.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const platform = front.match(/^platform:\s*(\S+)/m)?.[1];
  const id = front.match(/^session_id:\s*"?([^"\n]+)"?/m)?.[1];
  const agent = platform === 'claude-code' ? 'claude' : platform === 'codex' ? 'codex' : null;
  return agent && id ? { agent, id } : null;
}

/** A copy of this session already in the workspace: under raw/docs/conversations, or in the folder named. */
function findCopy(dataDir: string, ref: ConversationRef, folder?: string): string | null {
  const suffix = `__${idTail(ref.id)}.md`;
  const roots = [CONVERSATIONS_ROOT, ...(folder?.trim() ? [folderKey(folder)] : [])];
  for (const root of roots) {
    const visit = (rel: string, depth: number): string | null => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(safePath(dataDir, rel), { withFileTypes: true });
      } catch {
        return null;
      }
      for (const e of entries) {
        const child = `${rel}/${e.name}`;
        if (e.isFile() && e.name.endsWith(suffix)) {
          const who = readCopyIdentity(dataDir, child);
          if (who?.agent === ref.agent && who.id === ref.id) return child;
        } else if (e.isDirectory() && !e.name.startsWith('.') && depth < 4) {
          const found = visit(child, depth + 1);
          if (found) return found;
        }
      }
      return null;
    };
    const found = visit(root, 0);
    if (found) return found;
  }
  return null;
}

/**
 * The conversations this workspace holds a copy of, followed or not:
 * `<agent>:<id>` → the copy's key. Read from the copies' frontmatter under
 * raw/docs/conversations and from the follow list.
 */
export function conversationCopies(dataDir: string, config: KnodeConfig): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (rel: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(safePath(dataDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory() && !e.name.startsWith('.') && depth < 4) visit(child, depth + 1);
      else if (e.isFile() && /__[0-9a-f]{8}\.md$/.test(e.name)) {
        const who = readCopyIdentity(dataDir, child);
        if (who) out.set(`${who.agent}:${who.id}`, child);
      }
    }
  };
  visit(CONVERSATIONS_ROOT, 0);
  for (const l of conversationLinks(config)) out.set(`${l.agent}:${l.id}`, l.dest);
  return out;
}

/** What importing a conversation would write: its Markdown as rendered now, and where it would go. */
export function previewConversation(ctx: { dataDir: string; config: KnodeConfig }, ref: ConversationRef, folder?: string): { dest: string; title: string; markdown: string; exchanges: number; redactions: number; bytes: number } {
  const file = findTranscript(ctx.config, ref.agent, ref.id);
  if (!file) throw new Error(`no ${AGENT_NAMES[ref.agent]} conversation ${ref.id} on this machine`);
  const conversation = readConversationFile(file, ref.agent);
  const title = describeTranscript(ctx.config, ref.agent, file)?.title ?? titleOf(conversation);
  const dest = conversationLinks(ctx.config).find((l) => l.agent === ref.agent && l.id === ref.id)?.dest
    ?? findCopy(ctx.dataDir, ref, folder)
    ?? conversationDestFor({ title, id: ref.id, project: projectOf(conversation.cwd) }, folder);
  const rendered = renderConversation({ conversation, title, transcript: file });
  return { dest, title, markdown: rendered.markdown, exchanges: rendered.exchanges, redactions: rendered.redactions, bytes: Buffer.byteLength(rendered.markdown) };
}

/* ------------------------------ import ----------------------------------- */

export interface ConversationImportOptions {
  mode: ConversationImportMode;
  /** A folder under raw/docs to put new copies in, instead of raw/docs/conversations/<project>. */
  folder?: string;
  llmGraph?: boolean;
  onProgress?: (msg: string) => void;
}

export interface ConversationPlaced {
  agent: ConversationAgent;
  id: string;
  title: string;
  project: string | null;
  dest: string;
  mode: ConversationImportMode;
  /** A copy was here already and was brought up to date in place. */
  refreshed: boolean;
  /** The Markdown changed (or is new). */
  written: boolean;
  exchanges: number;
  redactions: number;
  asOf: string | null;
}

export interface ConversationImportItem extends ConversationRef {
  ok: boolean;
  result: ConversationPlaced | null;
  error: string | null;
}

export interface ConversationImportResult {
  items: ConversationImportItem[];
  sync: SyncStats | null;
}

interface Placement {
  result: ConversationPlaced;
  release: () => void;
}

/** Read a session, render it, and write its copy; with `follow`, remember it. The copy's folder is held until released. */
function place(ctx: SyncContext, ref: ConversationRef, opts: ConversationImportOptions): Placement {
  const agentName = AGENT_NAMES[ref.agent];
  const link = conversationLinks(ctx.config).find((l) => l.agent === ref.agent && l.id === ref.id);
  if (link) {
    throw new FolderImportConflict(opts.mode === 'follow'
      ? `this ${agentName} conversation is already followed at ${link.dest}`
      : `this ${agentName} conversation is followed at ${link.dest} and kept in sync already — sync it instead`);
  }
  const file = findTranscript(ctx.config, ref.agent, ref.id);
  if (!file) throw new Error(`no ${agentName} conversation ${ref.id} on this machine`);
  const conversation = readConversationFile(file, ref.agent);
  if (conversation.exchanges.length === 0) throw new Error(`nothing has been asked in ${agentName} conversation ${ref.id} yet`);
  const title = describeTranscript(ctx.config, ref.agent, file)?.title ?? titleOf(conversation);
  const project = projectOf(conversation.cwd);

  const previous = findCopy(ctx.dataDir, ref, opts.folder);
  const dest = previous ?? conversationDestFor({ title, id: ref.id, project }, opts.folder);
  const owner = linkOwning(mirrorLinks(ctx.config), dest);
  if (owner) throw new FolderImportConflict(`${dest} is inside ${owner.dest}, which is mirrored from ${owner.source}`);
  const inside = linksUnder(mirrorLinks(ctx.config), dest);
  if (inside.length) throw new FolderImportConflict(`${dest} would contain the linked ${inside[0].dest} — pick another folder`);
  if (!previous && fs.existsSync(safePath(ctx.dataDir, dest))) throw new FolderImportConflict(`${dest} already exists and holds something else — pick another folder`);

  opts.onProgress?.(`${opts.mode === 'follow' ? 'following' : 'importing'} ${agentName} ${ref.id} → ${dest}`);
  const release = holdDest(ctx.dataDir, dest);
  try {
    const rendered = renderConversation({ conversation, title, transcript: file });
    const written = writeIfChanged(safePath(ctx.dataDir, dest), rendered.markdown);
    if (opts.mode === 'follow') {
      noteRendered(ctx.dataDir, dest, fs.statSync(file));
      persistLinks(ctx, [...conversationLinks(ctx.config), { agent: ref.agent, id: ref.id, source: file, title, project, dest, createdAt: new Date().toISOString() }]);
    }
    return {
      result: { agent: ref.agent, id: ref.id, title, project, dest, mode: opts.mode, refreshed: Boolean(previous), written, exchanges: rendered.exchanges, redactions: rendered.redactions, asOf: rendered.asOf },
      release,
    };
  } catch (err) {
    release();
    throw err;
  }
}

/**
 * Import or follow conversations, each on its own — one that fails is
 * reported and the rest go on — then index what was written in one sync.
 * Importing a conversation already here refreshes that copy.
 */
export async function importConversations(ctx: SyncContext, refs: ConversationRef[], opts: ConversationImportOptions): Promise<ConversationImportResult> {
  const items: ConversationImportItem[] = [];
  const placements: Placement[] = [];
  try {
    for (const ref of refs) {
      try {
        const placed = place(ctx, ref, opts);
        placements.push(placed);
        items.push({ ...ref, ok: true, result: placed.result, error: null });
      } catch (err) {
        items.push({ ...ref, ok: false, result: null, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const keys = placements.filter((p) => p.result.written).map((p) => p.result.dest);
    const stats = keys.length ? await sync(ctx, { only: keys, llmGraph: opts.llmGraph, onProgress: opts.onProgress }) : null;
    return { items, sync: stats };
  } finally {
    for (const p of placements) p.release();
  }
}

/* ------------------------------ keeping in sync -------------------------- */

export interface ConversationRefreshResult {
  dest: string;
  agent: ConversationAgent;
  id: string;
  title: string;
  /** The transcript changed since the copy was rendered (or a render was forced). */
  changed: boolean;
  /** It changed, but the agent wrote to it too recently: it is rendered once it has been quiet. */
  waiting: boolean;
  /** The copy's Markdown changed and was synced. */
  written: boolean;
  exchanges: number | null;
  /** Why it could not be read; the copy was left as it was. */
  error: string | null;
}

export interface ConversationRefreshOptions {
  /** Only the conversation whose copy is here. */
  dest?: string;
  /** Render even an unchanged transcript. */
  force?: boolean;
  /** Leave a transcript written to less than `quietMinutes` ago for a later check (the scheduled check does). */
  waitForQuiet?: boolean;
  now?: number;
  onProgress?: (msg: string) => void;
}

/**
 * Bring followed conversations up to date: each transcript whose size or time
 * moved since its copy was rendered is read and rendered again; a copy whose
 * Markdown changed is written and synced, all of them in one sync.
 */
export async function refreshConversations(ctx: SyncContext, opts: ConversationRefreshOptions = {}): Promise<ConversationRefreshResult[]> {
  const links = conversationLinks(ctx.config).filter((l) => !opts.dest || l.dest === opts.dest);
  if (opts.dest && links.length === 0) throw new Error(`no followed conversation at ${opts.dest}`);
  const now = opts.now ?? Date.now();
  const quietMs = conversationQuietMinutes(ctx.config) * 60_000;
  const state = readState(ctx.dataDir);
  const out: ConversationRefreshResult[] = [];
  const written: string[] = [];
  const releases: (() => void)[] = [];
  let moved = false;
  let renamed = false;
  try {
    for (const link of links) {
      const base = { dest: link.dest, agent: link.agent, id: link.id, title: link.title, changed: false, waiting: false, written: false, exchanges: null, error: null };
      let file: string | null = fs.existsSync(link.source) ? link.source : null;
      if (!file) {
        file = findTranscript(ctx.config, link.agent, link.id);
        if (file) {
          link.source = file;
          moved = true;
        }
      }
      if (!file) {
        out.push({ ...base, error: `the ${AGENT_NAMES[link.agent]} transcript is no longer on this machine (last at ${link.source}) — the copy was kept as it was` });
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch (err) {
        out.push({ ...base, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      const seen = state[link.dest];
      const copyThere = fs.existsSync(safePath(ctx.dataDir, link.dest));
      const changed = Boolean(opts.force) || !seen || !copyThere || seen.size !== stat.size || seen.mtimeMs !== stat.mtimeMs || seen.renderer !== RENDER_VERSION;
      if (!changed) {
        out.push(base);
        continue;
      }
      if (opts.waitForQuiet && !opts.force && copyThere && now - stat.mtimeMs < quietMs) {
        out.push({ ...base, changed: true, waiting: true });
        continue;
      }
      try {
        const conversation = readConversationFile(file, link.agent);
        const title = describeTranscript(ctx.config, link.agent, file)?.title ?? titleOf(conversation);
        const release = holdDest(ctx.dataDir, link.dest);
        releases.push(release);
        const rendered = renderConversation({ conversation, title, transcript: file });
        const wrote = writeIfChanged(safePath(ctx.dataDir, link.dest), rendered.markdown);
        state[link.dest] = { size: stat.size, mtimeMs: stat.mtimeMs, renderer: RENDER_VERSION, at: new Date(now).toISOString() };
        if (title !== link.title) {
          link.title = title;
          renamed = true;
        }
        if (wrote) written.push(link.dest);
        out.push({ ...base, title, changed: true, written: wrote, exchanges: rendered.exchanges });
      } catch (err) {
        out.push({ ...base, changed: true, error: err instanceof Error ? err.message : String(err) });
      }
    }
    writeState(ctx.dataDir, state);
    if (moved || renamed) persistLinks(ctx, conversationLinks(ctx.config));
    if (written.length) {
      opts.onProgress?.(`conversations: ${written.length} cop${written.length === 1 ? 'y' : 'ies'} updated`);
      await sync(ctx, { only: written, onProgress: opts.onProgress });
    }
    return out;
  } finally {
    for (const release of releases) release();
  }
}

/**
 * Stop following a conversation. Its copy stays as ordinary workspace
 * content unless `removeFiles`, in which case it is deleted and its
 * knowledge disposed.
 */
export async function unfollowConversation(ctx: SyncContext, dest: string, opts: { removeFiles?: boolean; onProgress?: (m: string) => void } = {}): Promise<{ dest: string; removedFiles: boolean; sync: SyncStats | null }> {
  const links = conversationLinks(ctx.config);
  const link = links.find((l) => l.dest === dest);
  if (!link) throw new Error(`no followed conversation at ${dest}`);
  persistLinks(ctx, links.filter((l) => l !== link));
  noteRendered(ctx.dataDir, dest, null);
  if (!opts.removeFiles) return { dest, removedFiles: false, sync: null };
  const release = holdDest(ctx.dataDir, dest);
  try {
    fs.rmSync(safePath(ctx.dataDir, dest), { force: true });
    return { dest, removedFiles: true, sync: await sync(ctx, { only: [dest], onProgress: opts.onProgress }) };
  } finally {
    release();
  }
}

/* ------------------------------ status ----------------------------------- */

export interface ConversationRuntime {
  lastCheckAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  /** Changed at the last check, but not quiet yet. */
  waiting: boolean;
}

export interface ConversationStatus extends ConversationLink, ConversationRuntime {
  /** The transcript is where the link last found it. */
  sourcePresent: boolean;
  /** What the copy holds: its exchanges and last activity, from its frontmatter. */
  exchanges: number | null;
  asOf: string | null;
}

function copyFacts(dataDir: string, rel: string): { exchanges: number | null; asOf: string | null } {
  try {
    const fd = fs.openSync(safePath(dataDir, rel), 'r');
    try {
      const buf = Buffer.alloc(4096);
      const head = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0));
      const n = head.match(/^exchanges:\s*(\d+)/m)?.[1];
      return { exchanges: n ? Number(n) : null, asOf: head.match(/^as_of:\s*"?([^"\n]+)"?/m)?.[1] ?? null };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { exchanges: null, asOf: null };
  }
}

export function describeConversationLinks(ctx: { dataDir: string; config: KnodeConfig }, runtime?: Map<string, ConversationRuntime>): ConversationStatus[] {
  return conversationLinks(ctx.config).map((link) => {
    const rt = runtime?.get(link.dest);
    return {
      ...link,
      lastCheckAt: rt?.lastCheckAt ?? null,
      lastSyncAt: rt?.lastSyncAt ?? null,
      lastError: rt?.lastError ?? null,
      waiting: rt?.waiting ?? false,
      sourcePresent: fs.existsSync(link.source),
      ...copyFacts(ctx.dataDir, link.dest),
    };
  });
}

/* ------------------------------ the checker ------------------------------ */

export interface AgentConversationsOptions {
  log?: (msg: string) => void;
  track?: <T>(job: Promise<T>) => Promise<T>;
  /** Seconds after start before the first check (the startup sync goes first). */
  firstCheckSeconds?: number;
}

/**
 * What `serve` runs per workspace for its followed conversations: a look
 * every `everyMinutes`, shortly after startup too — what changed while
 * knode-os was down is caught up then — and `checkNow` when a person asks.
 */
export class AgentConversations {
  private readonly runtime = new Map<string, ConversationRuntime>();
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private running: Promise<ConversationRefreshResult[]> | null = null;
  private lastRunAt = 0;
  private stopped = false;
  private readonly log: (msg: string) => void;
  private readonly track: <T>(job: Promise<T>) => Promise<T>;

  constructor(private readonly ctx: SyncContext, private readonly opts: AgentConversationsOptions = {}) {
    this.log = opts.log ?? (() => {});
    this.track = opts.track ?? ((job) => job);
  }

  start(): void {
    const tick = () => {
      if (!this.stopped && this.due()) this.checkNow({ scheduled: true });
    };
    this.first = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, 60_000);
      this.timer.unref?.();
    }, (this.opts.firstCheckSeconds ?? 30) * 1000);
    this.first.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
    await this.running?.catch(() => {});
  }

  /** A check is owed: something followed, none under way, the interval passed since the last. */
  due(now = Date.now()): boolean {
    if (this.running || conversationLinks(this.ctx.config).length === 0) return false;
    return now - this.lastRunAt >= conversationCheckMinutes(this.ctx.config) * 60_000;
  }

  /** When the next scheduled check comes; null while nothing is followed. */
  nextCheck(now = Date.now()): string | null {
    if (conversationLinks(this.ctx.config).length === 0) return null;
    return new Date(Math.max(now, this.lastRunAt + conversationCheckMinutes(this.ctx.config) * 60_000)).toISOString();
  }

  /** When the last check ran; null before the first. */
  lastCheck(): string | null {
    return this.lastRunAt ? new Date(this.lastRunAt).toISOString() : null;
  }

  /** Start checking every followed conversation in the background; false when a check is under way. A scheduled check waits for quiet. */
  checkNow(opts: { force?: boolean; scheduled?: boolean } = {}): boolean {
    if (this.running) return false;
    void this.track(
      this.refresh(undefined, { force: opts.force, waitForQuiet: Boolean(opts.scheduled) }).catch((err) => {
        this.log(`conversations: check failed: ${err instanceof Error ? err.message : err}`);
      }),
    );
    return true;
  }

  /** Import or follow conversations; a follow counts as checked. */
  async add(refs: ConversationRef[], opts: ConversationImportOptions): Promise<ConversationImportResult> {
    const result = await importConversations(this.ctx, refs, { ...opts, onProgress: opts.onProgress ?? this.log });
    if (opts.mode === 'follow') {
      const at = new Date().toISOString();
      for (const item of result.items) {
        if (item.result) this.runtime.set(item.result.dest, { lastCheckAt: at, lastSyncAt: at, lastError: null, waiting: false });
      }
    }
    return result;
  }

  async remove(dest: string, opts: { removeFiles?: boolean } = {}): Promise<Awaited<ReturnType<typeof unfollowConversation>>> {
    this.runtime.delete(dest);
    return unfollowConversation(this.ctx, dest, { ...opts, onProgress: this.log });
  }

  /** Check every followed conversation (or the one at `dest`) now; one check runs at a time. */
  async refresh(dest?: string, opts: { force?: boolean; waitForQuiet?: boolean } = {}): Promise<ConversationRefreshResult[]> {
    while (this.running) await this.running.catch(() => {});
    const job = activityOf(this.ctx.dataDir).run(
      'conversations',
      dest ? `${dest}: checking the conversation for new exchanges` : 'Followed conversations: checking for new exchanges',
      (progress) =>
        refreshConversations(this.ctx, {
          dest,
          force: opts.force,
          waitForQuiet: opts.waitForQuiet,
          onProgress: (m) => {
            this.log(m);
            progress(m);
          },
        }),
      (results) => {
        const written = results.filter((r) => r.written).length;
        const waiting = results.filter((r) => r.waiting).length;
        const failed = results.filter((r) => r.error).length;
        return `${results.length} checked, ${written} updated${waiting ? `, ${waiting} still being written` : ''}${failed ? `, ${failed} unreadable` : ''}`;
      },
    );
    this.running = job;
    const at = new Date().toISOString();
    try {
      const results = await job;
      for (const r of results) {
        const rt = this.runtime.get(r.dest);
        this.runtime.set(r.dest, { lastCheckAt: at, lastSyncAt: r.written ? at : rt?.lastSyncAt ?? null, lastError: r.error, waiting: r.waiting });
        if (r.error) this.log(`conversation ${r.dest}: ${r.error}`);
      }
      if (!dest) this.lastRunAt = Date.parse(at);
      return results;
    } finally {
      if (this.running === job) this.running = null;
    }
  }

  get checking(): boolean {
    return this.running !== null;
  }

  status(): ConversationStatus[] {
    return describeConversationLinks(this.ctx, this.runtime);
  }
}
