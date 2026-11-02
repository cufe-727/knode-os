import fs from 'node:fs';
import path from 'node:path';
import { FeishuLink, KnodeConfig, normalizeTimeOfDay, saveConfig } from '../../config.js';
import { activityOf } from '../../activity.js';
import { safePath } from '../../fs/files.js';
import { FolderImportConflict, holdDest, linkOwning, linksUnder, mirrorLinks } from '../folders.js';
import { sync, SyncContext, SyncStats } from '../sync.js';
import { DocumentMeta, FeishuAuthStatus, FeishuError, LarkCli, LarkRunner } from './client.js';
import { parseFeishuRef } from './markdown.js';
import { FeishuTarget, feishuDestFor, feishuLinks, findFeishuMirror, mirrorFeishuDocument, readManifest, resolveFeishuTarget } from './mirror.js';
import { FeishuTreeResult, isMirroredPage, listWikiTree, mirrorFeishuTree, readTreeManifest, resolveWikiTree, WikiTreePage, WikiTreeRoot } from './tree.js';

/**
 * Feishu documents as a source — one person's Feishu Docs, directly or in a
 * wiki, mirrored into `raw/docs/feishu/`, once or kept in sync, the way a
 * folder from this machine is (src/ingest/folders.ts). A document becomes a
 * folder of its own (./mirror.ts); a wiki page with the pages under it, or a
 * whole wiki space, becomes a tree of such folders that keeps the wiki's
 * structure (./tree.ts). Several links can be imported in one batch.
 *
 * **One-time import** (`copy`) writes the mirror and forgets the source: from
 * then on it is ordinary workspace content. **Link** remembers it in
 * `ingest.feishuDocs`; while `serve` runs, it asks Feishu once a day
 * (`ingest.feishu.checkAt`, 06:00 by default, and at startup when that time
 * passed while it was down) when each linked document was last edited — one
 * metadata call per 200 documents, one listing per wiki page with pages under
 * it — and re-mirrors what changed, syncing only the files that changed. The
 * Check now buttons in the app and the web UI (POST /api/feishu/sync) ask at
 * once.
 *
 * Reading goes through lark-cli as the signed-in Feishu user (./client.ts).
 * That is why polling, not push: Feishu sends edit events only to a
 * document's owner and managers (drive/v1/files/:token/subscribe), and most
 * documents worth following are ones someone shared — readable, not managed.
 * See docs/design/21-feishu-documents.md.
 *
 * A mirror belongs to its link: writes into it are refused (mirrorLinks in
 * src/ingest/folders.ts). A document the user can no longer read, or one that
 * was deleted, leaves its mirror alone and reports it, as an unmounted disk
 * does for a linked folder.
 */

export type { FeishuLink };
export { FEISHU_ROOT, feishuDestFor, feishuLinks, findFeishuMirror, mirrorFeishuDocument, readManifest, resolveFeishuTarget } from './mirror.js';
export type { FeishuManifest, FeishuMirrorResult, FeishuTarget } from './mirror.js';
export { isMirroredPage, listWikiTree, MAX_TREE_PAGES, mirrorFeishuTree, readTreeManifest, resolveWikiTree } from './tree.js';
export type { FeishuTreeResult, WikiTreePage, WikiTreeRoot } from './tree.js';

/* ------------------------------ the client ------------------------------- */

let runnerOverride: LarkRunner | null = null;

/** Tests drive a fake lark-cli through this; null restores the real one. */
export function setFeishuRunner(runner: LarkRunner | null): void {
  runnerOverride = runner;
}

export function feishuClient(config: KnodeConfig): LarkCli {
  return new LarkCli({ cli: config.ingest.feishu?.cli, runner: runnerOverride ?? undefined });
}

/* ------------------------------ import / link ---------------------------- */

export type FeishuImportMode = 'copy' | 'link';

export interface FeishuImportOptions {
  mode: FeishuImportMode;
  /** Destination folder under raw/docs; default raw/docs/feishu/<title>__<token>. One import's, never a batch's. */
  dest?: string;
  /** A wiki page comes with the pages under it, as a tree of folders (a wiki space always does). */
  subpages?: boolean;
  llmGraph?: boolean;
  onProgress?: (msg: string) => void;
  /** As for a folder import: return once the mirror is written and index it afterwards. */
  background?: {
    track?: <T>(job: Promise<T>) => Promise<T>;
    onIndexed?: (done: { dest: string; sync: SyncStats | null; error?: string }) => void;
  };
}

/** What one import wrote: a document, or a wiki tree. */
export interface FeishuPlaced {
  kind: 'document' | 'tree';
  url: string;
  token: string;
  title: string;
  dest: string;
  mode: FeishuImportMode;
  /** It was imported here before: this import refreshed that copy. */
  refreshed: boolean;
  /** The document's Markdown; null for a tree. */
  file: string | null;
  revision: number | null;
  modifiedAt: string | null;
  /** Keys written this pass: the Markdown when it changed, and new pictures and attachments. */
  written: string[];
  /** Keys removed because the source no longer references them. */
  removed: string[];
  images: number;
  attachments: number;
  /** Attachments, embeds and wiki pages of another kind that stay in Feishu. */
  keptInFeishu: number;
  /** A tree's pages: in all, how many are Docs documents, how many were fetched. */
  pages: { total: number; documents: number; fetched: number } | null;
  warnings: string[];
}

export interface FeishuImportResult extends FeishuPlaced {
  sync: SyncStats | null;
  indexing: boolean;
}

/** Placed and waiting to be indexed: the folder stays held until then. */
interface Placement {
  result: FeishuPlaced;
  release: () => void;
}

/** The `only` list for a sync after a pass: each key while there are few, the whole mirror otherwise. */
const syncScope = (dest: string, keys: string[]) => (keys.length > 200 ? [dest] : keys);

function persistLinks(ctx: SyncContext, links: FeishuLink[]): void {
  ctx.config.ingest.feishuDocs = links;
  saveConfig(ctx.dataDir, ctx.config);
}

/** Where an import goes, refusing what would clash with a link or another source's mirror. */
function placeFor(ctx: SyncContext, source: { token: string; title: string }, opts: FeishuImportOptions, holds: (dest: string) => boolean): { dest: string; existed: boolean } {
  const existingLink = feishuLinks(ctx.config).find((l) => l.token === source.token);
  if (existingLink && opts.mode === 'link') throw new FolderImportConflict(`${source.title} is already linked at ${existingLink.dest}`);
  if (existingLink) throw new FolderImportConflict(`${source.title} is linked at ${existingLink.dest} and kept in sync already — sync it instead`);
  const previous = opts.dest ? null : findFeishuMirror(ctx.dataDir, ctx.config, source.token);
  const dest = previous ?? feishuDestFor(source, opts.dest);
  const owner = linkOwning(mirrorLinks(ctx.config), dest);
  if (owner) throw new FolderImportConflict(`${dest} is inside ${owner.dest}, which is mirrored from ${owner.source}`);
  const inside = linksUnder(mirrorLinks(ctx.config), dest);
  if (inside.length) throw new FolderImportConflict(`${dest} would contain the linked ${inside[0].dest} — pick another destination`);
  const destAbs = safePath(ctx.dataDir, dest);
  const occupied = fs.existsSync(destAbs) && fs.readdirSync(destAbs).length > 0;
  if (occupied && !holds(dest)) throw new FolderImportConflict(`${dest} already exists and holds something else — pick another destination`);
  return { dest, existed: occupied };
}

async function placeDocument(ctx: SyncContext, client: LarkCli, target: FeishuTarget, opts: FeishuImportOptions): Promise<Placement> {
  const { dest, existed } = placeFor(ctx, target, opts, (d) => readManifest(ctx.dataDir, d)?.token === target.token);
  opts.onProgress?.(`${opts.mode === 'link' ? 'linking' : 'importing'} ${target.url} → ${dest}`);
  const release = holdDest(ctx.dataDir, dest);
  try {
    const mirrored = await mirrorFeishuDocument(ctx.dataDir, client, target, dest, { onProgress: opts.onProgress });
    if (opts.mode === 'link') {
      persistLinks(ctx, [...feishuLinks(ctx.config), { url: target.url, token: target.token, type: 'docx', ...(target.wiki ? { wiki: target.wiki } : {}), title: mirrored.title, dest, createdAt: new Date().toISOString() }]);
    }
    const { file, revision, modifiedAt, written, removed, images, attachments, keptInFeishu, warnings, title } = mirrored;
    return {
      result: { kind: 'document', url: target.url, token: target.token, title, dest, mode: opts.mode, refreshed: existed, file, revision, modifiedAt, written, removed, images, attachments, keptInFeishu, pages: null, warnings },
      release,
    };
  } catch (err) {
    release();
    throw err;
  }
}

async function placeTree(ctx: SyncContext, client: LarkCli, root: WikiTreeRoot, opts: FeishuImportOptions): Promise<Placement> {
  const { dest, existed } = placeFor(ctx, root, opts, (d) => {
    const manifest = readTreeManifest(ctx.dataDir, d);
    return Boolean(manifest) && (manifest!.root ?? manifest!.spaceId) === root.token;
  });
  opts.onProgress?.(`${opts.mode === 'link' ? 'linking' : 'importing'} ${root.url} with its pages → ${dest}`);
  const release = holdDest(ctx.dataDir, dest);
  try {
    const pages = await treePages(client, root, { reuse: true });
    const tree = await mirrorFeishuTree(ctx.dataDir, client, root, dest, { onProgress: opts.onProgress, pages });
    if (opts.mode === 'link') {
      persistLinks(ctx, [
        ...feishuLinks(ctx.config),
        { url: root.url, token: root.token, type: 'wiki-tree', space: root.spaceId, ...(root.node ? { wiki: root.node.nodeToken } : {}), title: root.title, dest, createdAt: new Date().toISOString() },
      ]);
    }
    return { result: { ...fromTree(tree), mode: opts.mode, token: root.token, refreshed: existed }, release };
  } catch (err) {
    release();
    throw err;
  }
}

function fromTree(tree: FeishuTreeResult): Omit<FeishuPlaced, 'mode' | 'token' | 'refreshed'> {
  return {
    kind: 'tree',
    url: tree.url,
    title: tree.title,
    dest: tree.dest,
    file: null,
    revision: null,
    modifiedAt: null,
    written: tree.written,
    removed: tree.removed,
    images: tree.images,
    attachments: tree.attachments,
    keptInFeishu: tree.keptInFeishu.length,
    pages: { total: tree.pages, documents: tree.documents, fetched: tree.fetched },
    warnings: tree.warnings,
  };
}

/** Trees listed for a preview lately, so the import right after it does not list them again (once). */
const listings = new Map<string, { at: number; pages: WikiTreePage[] }>();
const LISTING_REUSE_MS = 10 * 60_000;

async function treePages(client: LarkCli, root: WikiTreeRoot, opts: { reuse: boolean }): Promise<WikiTreePage[]> {
  const cached = listings.get(root.token);
  listings.delete(root.token);
  if (opts.reuse && cached && Date.now() - cached.at < LISTING_REUSE_MS) return cached.pages;
  const pages = await listWikiTree(client, root);
  if (!opts.reuse) listings.set(root.token, { at: Date.now(), pages });
  for (const [token, l] of listings) if (Date.now() - l.at > LISTING_REUSE_MS) listings.delete(token);
  return pages;
}

/** What importing one link would bring, before anything is written — and proof the signed-in account may read it. */
export interface FeishuPreview {
  input: string;
  kind: 'document' | 'tree';
  url: string;
  token: string;
  title: string;
  /** A document's last edit; a tree's latest among its pages. */
  modifiedAt: string | null;
  wiki: string | null;
  dest: string;
  /** A tree's pages: in all, Docs documents among them, pages of other kinds and shortcuts left in Feishu, how many levels of folders. */
  pages: { total: number; documents: number; keptInFeishu: number; levels: number } | null;
  existing: { dest: string; revision: number | null; modifiedAt: string | null } | null;
  linked: { dest: string } | null;
}

export async function previewFeishu(ctx: { dataDir: string; config: KnodeConfig }, client: LarkCli, input: string, opts: { subpages?: boolean; dest?: string } = {}): Promise<FeishuPreview> {
  const ref = parseFeishuRef(input);
  if (ref.kind === 'space' || (ref.kind === 'wiki' && opts.subpages)) {
    const root = await resolveWikiTree(client, input);
    if (!root.node || root.node.hasChild) {
      const pages = await treePages(client, root, { reuse: false });
      const dest = (opts.dest ? null : findFeishuMirror(ctx.dataDir, ctx.config, root.token)) ?? feishuDestFor(root, opts.dest);
      const link = feishuLinks(ctx.config).find((l) => l.token === root.token);
      const documents = pages.filter(isMirroredPage).length;
      return {
        input,
        kind: 'tree',
        url: root.url,
        token: root.token,
        title: root.title,
        modifiedAt: pages.map((p) => p.editedAt).filter((t): t is string => Boolean(t)).sort().at(-1) ?? null,
        wiki: root.node?.nodeToken ?? null,
        dest,
        pages: { total: pages.length, documents, keptInFeishu: pages.length - documents, levels: 1 + Math.max(0, ...pages.map((p) => p.depth)) },
        existing: readTreeManifest(ctx.dataDir, dest) ? { dest, revision: null, modifiedAt: null } : null,
        linked: link ? { dest: link.dest } : null,
      };
    }
  }
  const target = await resolveFeishuTarget(client, input);
  const dest = (opts.dest ? null : findFeishuMirror(ctx.dataDir, ctx.config, target.token)) ?? feishuDestFor(target, opts.dest);
  const manifest = readManifest(ctx.dataDir, dest);
  const link = feishuLinks(ctx.config).find((l) => l.token === target.token);
  return {
    input,
    kind: 'document',
    url: target.url,
    token: target.token,
    title: target.title,
    modifiedAt: target.modifiedAt,
    wiki: target.wiki ?? null,
    dest,
    pages: null,
    existing: manifest ? { dest, revision: manifest.revision, modifiedAt: manifest.modifiedAt } : null,
    linked: link ? { dest: link.dest } : null,
  };
}

/** Resolve a link and write its mirror: a wiki space, or a wiki page with `subpages` that has some, as a tree; anything else as one document. */
async function place(ctx: SyncContext, client: LarkCli, input: string, opts: FeishuImportOptions): Promise<Placement> {
  const ref = parseFeishuRef(input);
  if (ref.kind === 'space' || (ref.kind === 'wiki' && opts.subpages)) {
    const root = await resolveWikiTree(client, input);
    if (!root.node || root.node.hasChild) return placeTree(ctx, client, root, opts);
  }
  return placeDocument(ctx, client, await resolveFeishuTarget(client, input), opts);
}

/** Index what the placements wrote, at once or (with `background`) after returning; their folders are released once it is done. */
async function indexPlaced(ctx: SyncContext, placements: Placement[], opts: FeishuImportOptions): Promise<{ sync: SyncStats | null; indexing: boolean }> {
  const releaseAll = () => placements.forEach((p) => p.release());
  const touched = placements.filter((p) => p.result.written.length + p.result.removed.length > 0);
  if (touched.length === 0) {
    releaseAll();
    return { sync: null, indexing: false };
  }
  const keys = touched.flatMap((p) => [...p.result.written, ...p.result.removed]);
  const only = keys.length > 200 ? touched.map((p) => p.result.dest) : keys;
  const indexing = sync(ctx, { only, llmGraph: opts.llmGraph, onProgress: opts.onProgress });
  if (opts.background) {
    const { track = (job) => job, onIndexed } = opts.background;
    const dest = touched.map((p) => p.result.dest).join(', ');
    void track(indexing.finally(releaseAll)).then(
      (stats) => onIndexed?.({ dest, sync: stats }),
      (err) => onIndexed?.({ dest, sync: null, error: err instanceof Error ? err.message : String(err) }),
    );
    return { sync: null, indexing: true };
  }
  try {
    return { sync: await indexing, indexing: false };
  } finally {
    releaseAll();
  }
}

/**
 * Import a Feishu document — or, with `subpages`, a wiki page with the pages
 * under it; a wiki space always comes whole — then remember it when linking,
 * and index what was written. Importing what is already here refreshes that
 * copy instead of making a second one.
 */
export async function importFeishuDocument(ctx: SyncContext, client: LarkCli, input: string, opts: FeishuImportOptions): Promise<FeishuImportResult> {
  const placed = await place(ctx, client, input, opts);
  return { ...placed.result, ...(await indexPlaced(ctx, [placed], opts)) };
}

export interface FeishuBatchItem {
  input: string;
  ok: boolean;
  result: FeishuPlaced | null;
  error: string | null;
  /** Refused because it clashes with something here (linked already, a folder taken). */
  conflict: boolean;
}

/** The links of a batch: one per line or comma, each once. */
export function splitFeishuInputs(inputs: string | string[]): string[] {
  const all = (Array.isArray(inputs) ? inputs : [inputs]).flatMap((s) => String(s ?? '').split(/[\s,]+/));
  return [...new Set(all.map((s) => s.trim()).filter(Boolean))];
}

/**
 * Import several links in one go, each as `importFeishuDocument` would; one
 * that fails is reported and the rest go on, until Feishu wants a new
 * sign-in, which ends the batch. What was written is indexed in one sync.
 */
export async function importFeishuBatch(
  ctx: SyncContext,
  client: LarkCli,
  inputs: string[],
  opts: FeishuImportOptions & { onItem?: (index: number, item: FeishuBatchItem | null) => void },
): Promise<{ items: FeishuBatchItem[]; sync: SyncStats | null; indexing: boolean }> {
  if (opts.dest && inputs.length > 1) throw new Error('a destination names one import\'s folder — leave it out to import several');
  const placements: Placement[] = [];
  const items: FeishuBatchItem[] = [];
  let stop: string | null = null;
  for (const [i, input] of inputs.entries()) {
    if (stop) {
      items.push({ input, ok: false, result: null, error: stop, conflict: false });
      continue;
    }
    opts.onItem?.(i, null);
    try {
      const placed = await place(ctx, client, input, opts);
      placements.push(placed);
      items.push({ input, ok: true, result: placed.result, error: null, conflict: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      items.push({ input, ok: false, result: null, error: message, conflict: err instanceof FolderImportConflict });
      if (err instanceof FeishuError && (err.kind === 'auth' || err.kind === 'not-installed')) stop = message;
    }
    opts.onItem?.(i, items[i]);
  }
  return { items, ...(await indexPlaced(ctx, placements, opts)) };
}

/* ------------------------------ background imports ----------------------- */

/** A batch (or a tree) imported in the background, as the web UI follows it. */
export interface FeishuImportJob {
  id: string;
  mode: FeishuImportMode;
  subpages: boolean;
  state: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  inputs: string[];
  /** Links finished so far, and the one under way. */
  done: number;
  current: string | null;
  items: FeishuBatchItem[];
  /** What was written is being indexed still. */
  indexing: boolean;
  sync: SyncStats | null;
  error: string | null;
}

const importJobs = new Map<string, FeishuImportJob[]>();
const KEPT_JOBS = 10;

export function feishuImportJobs(dataDir: string): FeishuImportJob[] {
  return importJobs.get(dataDir) ?? [];
}

/**
 * Start importing `inputs` in the background, as an activity of the
 * workspace: returned at once, filled in as it goes. One runs at a time per
 * workspace. `done` settles when the links are written (indexing may go on).
 */
export function startFeishuImport(
  ctx: SyncContext,
  client: LarkCli,
  inputs: string[],
  opts: { mode: FeishuImportMode; subpages?: boolean; llmGraph?: boolean; log?: (m: string) => void; track?: <T>(job: Promise<T>) => Promise<T>; onDone?: (job: FeishuImportJob) => void },
): { job: FeishuImportJob; done: Promise<FeishuImportJob> } {
  if (inputs.length === 0) throw new Error('no Feishu links to import');
  const jobs = feishuImportJobs(ctx.dataDir);
  if (jobs.some((j) => j.state === 'running')) throw new FolderImportConflict('a Feishu import is under way in this workspace — wait for it to end');
  const job: FeishuImportJob = {
    id: `feishu-${Date.now().toString(36)}`,
    mode: opts.mode,
    subpages: Boolean(opts.subpages),
    state: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    inputs,
    done: 0,
    current: inputs[0],
    items: [],
    indexing: false,
    sync: null,
    error: null,
  };
  importJobs.set(ctx.dataDir, [job, ...jobs].slice(0, KEPT_JOBS));
  const track = opts.track ?? ((p) => p);
  let indexed = false;
  const verb = opts.mode === 'link' ? 'Link' : 'Import';
  const label = inputs.length === 1 ? `${verb} ${inputs[0]}${opts.subpages ? ' with its pages' : ''}` : `${verb} ${inputs.length} Feishu links${opts.subpages ? ' with their pages' : ''}`;
  const work = activityOf(ctx.dataDir).run(
    'feishu',
    label,
    (progress) =>
      importFeishuBatch(ctx, client, inputs, {
        mode: opts.mode,
        subpages: opts.subpages,
        llmGraph: opts.llmGraph,
        onProgress: (m) => {
          opts.log?.(m);
          progress(inputs.length > 1 ? `${job.done + 1} of ${inputs.length} · ${m}` : m);
        },
        onItem: (i, item) => {
          if (item) {
            job.items[i] = item;
            job.done = i + 1;
            job.current = inputs[i + 1] ?? null;
          } else {
            job.current = inputs[i];
          }
        },
        background: {
          track,
          onIndexed: (d) => {
            indexed = true;
            job.indexing = false;
            job.sync = d.sync;
            opts.log?.(d.error ? `feishu ${d.dest}: indexing failed: ${d.error}` : `feishu ${d.dest}: ${d.sync!.indexed} indexed, ${d.sync!.unchanged} unchanged, ${d.sync!.errors} errors`);
          },
        },
      }),
    (out) => {
      const ok = out.items.filter((x) => x.ok).length;
      const failed = out.items.length - ok;
      return `${ok} of ${out.items.length} written${failed ? `, ${failed} failed` : ''}${out.indexing ? ' · indexing' : ''}`;
    },
  );
  const done = work.then(
    (out) => {
      Object.assign(job, { items: out.items, indexing: out.indexing && !indexed, sync: job.sync ?? out.sync, state: 'done', current: null, finishedAt: new Date().toISOString() });
      opts.onDone?.(job);
      return job;
    },
    (err) => {
      Object.assign(job, { state: 'failed', error: err instanceof Error ? err.message : String(err), current: null, finishedAt: new Date().toISOString() });
      return job;
    },
  );
  void track(done);
  return { job, done };
}

export interface FeishuRefreshResult {
  dest: string;
  url: string;
  title: string;
  kind: 'document' | 'tree';
  /** Feishu says it changed (or the refresh was forced), so it was fetched again — for a tree, some of its pages. */
  fetched: boolean;
  written: number;
  removed: number;
  /** A document's last edit; a tree's latest one among its pages. */
  modifiedAt: string | null;
  /** A tree's pages: in all, Docs documents among them, fetched, moved to follow the wiki, gone from it. */
  pages: { total: number; documents: number; fetched: number; moved: number; removed: number } | null;
  sync: SyncStats | null;
  /** Why it could not be read; the mirror was left alone. */
  error: string | null;
  warnings: string[];
}

/**
 * Bring linked documents and trees (all, or the one at `dest`) up to date:
 * one metadata call says which documents changed since their mirror was
 * written, a tree's listing which of its pages did, and only those are
 * fetched. `force` fetches every one regardless.
 */
export async function refreshFeishuLinks(
  ctx: SyncContext,
  client: LarkCli,
  opts: { dest?: string; force?: boolean; onProgress?: (m: string) => void } = {},
): Promise<FeishuRefreshResult[]> {
  const links = feishuLinks(ctx.config).filter((l) => !opts.dest || l.dest === opts.dest);
  if (opts.dest && links.length === 0) throw new Error(`no linked Feishu document at ${opts.dest}`);
  if (links.length === 0) return [];
  const docs = links.filter((l) => l.type !== 'wiki-tree');
  const { metas, failed } = docs.length ? await client.metas(docs.map((l) => ({ token: l.token, type: 'docx' }))) : { metas: new Map<string, DocumentMeta>(), failed: new Map<string, number>() };
  const out: FeishuRefreshResult[] = [];
  for (const link of links) {
    out.push(link.type === 'wiki-tree' ? await refreshTree(ctx, client, link, opts) : await refreshOne(ctx, client, link, metas.get(link.token) ?? null, failed.get(link.token), opts));
  }
  return out;
}

function renamed(ctx: SyncContext, link: FeishuLink, title: string): void {
  if (title && title !== link.title) persistLinks(ctx, feishuLinks(ctx.config).map((l) => (l.dest === link.dest ? { ...l, title } : l)));
}

async function refreshOne(
  ctx: SyncContext,
  client: LarkCli,
  link: FeishuLink,
  meta: DocumentMeta | null,
  failedCode: number | undefined,
  opts: { force?: boolean; onProgress?: (m: string) => void },
): Promise<FeishuRefreshResult> {
  const base = { dest: link.dest, url: link.url, title: link.title, kind: 'document' as const, fetched: false, written: 0, removed: 0, modifiedAt: meta?.modifiedAt ?? null, pages: null, sync: null, warnings: [] as string[] };
  if (!meta) {
    return { ...base, error: `Feishu would not return this document${failedCode ? ` (code ${failedCode})` : ''} — deleted, or no longer shared with the signed-in user; the mirror was left as it was` };
  }
  const manifest = readManifest(ctx.dataDir, link.dest);
  const current = manifest && meta.modifiedAt && manifest.modifiedAt === meta.modifiedAt && !manifest.failed;
  if (current && !opts.force && fs.existsSync(safePath(ctx.dataDir, `${link.dest}/${manifest.file}`))) return { ...base, error: null };
  const ref = parseFeishuRef(link.url);
  const target: FeishuTarget = { ref, token: link.token, type: 'docx', url: link.url, title: meta.title || link.title, modifiedAt: meta.modifiedAt, ownerId: meta.ownerId, wiki: link.wiki };
  const release = holdDest(ctx.dataDir, link.dest);
  try {
    const mirrored = await mirrorFeishuDocument(ctx.dataDir, client, target, link.dest, { onProgress: opts.onProgress });
    const changed = [...mirrored.written, ...mirrored.removed];
    renamed(ctx, link, mirrored.title);
    const stats = changed.length ? await sync(ctx, { only: syncScope(link.dest, changed), onProgress: opts.onProgress }) : null;
    if (changed.length) opts.onProgress?.(`feishu ${link.dest}: ${mirrored.written.length} written, ${mirrored.removed.length} removed`);
    return { ...base, title: mirrored.title, fetched: true, written: mirrored.written.length, removed: mirrored.removed.length, sync: stats, error: null, warnings: mirrored.warnings };
  } finally {
    release();
  }
}

async function refreshTree(ctx: SyncContext, client: LarkCli, link: FeishuLink, opts: { force?: boolean; onProgress?: (m: string) => void }): Promise<FeishuRefreshResult> {
  const base = { dest: link.dest, url: link.url, title: link.title, kind: 'tree' as const, fetched: false, written: 0, removed: 0, modifiedAt: null, pages: null, sync: null, warnings: [] as string[] };
  let root: WikiTreeRoot;
  let pages: WikiTreePage[];
  try {
    root = await resolveWikiTree(client, link.url);
    pages = await listWikiTree(client, root);
  } catch (err) {
    // a lapsed sign-in fails the whole check, as it does for documents; a page gone or unshared fails this tree
    if (err instanceof FeishuError && (err.kind === 'auth' || err.kind === 'not-installed')) throw err;
    return { ...base, error: `${err instanceof Error ? err.message : String(err)} — the copy was left as it was` };
  }
  const release = holdDest(ctx.dataDir, link.dest);
  try {
    const tree = await mirrorFeishuTree(ctx.dataDir, client, root, link.dest, { force: opts.force, onProgress: opts.onProgress, pages });
    renamed(ctx, link, tree.title);
    const changed = [...tree.written, ...tree.removed];
    const stats = changed.length ? await sync(ctx, { only: syncScope(link.dest, changed), onProgress: opts.onProgress }) : null;
    if (changed.length) opts.onProgress?.(`feishu ${link.dest}: ${tree.fetched} page(s) fetched, ${tree.moved} moved, ${tree.removedPages} gone`);
    const latest = pages.map((p) => p.editedAt).filter((t): t is string => Boolean(t)).sort().at(-1) ?? null;
    return {
      ...base,
      title: tree.title,
      fetched: tree.fetched + tree.moved + tree.removedPages > 0,
      written: tree.written.length,
      removed: tree.removed.length,
      modifiedAt: latest,
      pages: { total: tree.pages, documents: tree.documents, fetched: tree.fetched, moved: tree.moved, removed: tree.removedPages },
      sync: stats,
      error: null,
      warnings: tree.warnings,
    };
  } finally {
    release();
  }
}

/**
 * Forget a linked document. The mirror stays as ordinary workspace content
 * unless `removeFiles`, in which case it is deleted and its sources disposed.
 */
export async function unlinkFeishuDocument(ctx: SyncContext, dest: string, opts: { removeFiles?: boolean; onProgress?: (m: string) => void } = {}): Promise<{ dest: string; removedFiles: boolean; sync: SyncStats | null }> {
  const links = feishuLinks(ctx.config);
  const link = links.find((l) => l.dest === dest);
  if (!link) throw new Error(`no linked Feishu document at ${dest}`);
  if (!opts.removeFiles) {
    persistLinks(ctx, links.filter((l) => l !== link));
    return { dest, removedFiles: false, sync: null };
  }
  const release = holdDest(ctx.dataDir, dest);
  try {
    persistLinks(ctx, links.filter((l) => l !== link));
    fs.rmSync(safePath(ctx.dataDir, dest), { recursive: true, force: true });
    return { dest, removedFiles: true, sync: await sync(ctx, { only: [dest], onProgress: opts.onProgress }) };
  } finally {
    release();
  }
}

/* ------------------------------ status ----------------------------------- */

export interface FeishuLinkRuntime {
  lastCheckAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  lastChange: { written: number; removed: number; at: string } | null;
}

export interface FeishuLinkStatus extends FeishuLink, FeishuLinkRuntime {
  /** The revision and last edit a document's mirror holds; null for a tree. */
  revision: number | null;
  modifiedAt: string | null;
  file: string | null;
  /** A tree's pages, and the Docs documents among them; null for a document. */
  pages: number | null;
  documents: number | null;
  images: number;
  attachments: number;
  /** Media a pass could not download, retried on the next. */
  failed: number;
}

export function describeFeishuLinks(ctx: { dataDir: string; config: KnodeConfig }, runtime?: Map<string, FeishuLinkRuntime>): FeishuLinkStatus[] {
  return feishuLinks(ctx.config).map((link) => {
    const rt = runtime?.get(link.dest);
    const run = { lastCheckAt: rt?.lastCheckAt ?? null, lastSyncAt: rt?.lastSyncAt ?? null, lastError: rt?.lastError ?? null, lastChange: rt?.lastChange ?? null };
    if (link.type === 'wiki-tree') {
      const tree = readTreeManifest(ctx.dataDir, link.dest);
      const nodes = Object.values(tree?.nodes ?? {});
      return { ...link, ...run, revision: null, modifiedAt: null, file: null, pages: tree ? nodes.length : null, documents: tree ? nodes.filter(isMirroredPage).length : null, images: 0, attachments: 0, failed: 0 };
    }
    const manifest = readManifest(ctx.dataDir, link.dest);
    const media = Object.values(manifest?.media ?? {});
    return {
      ...link,
      ...run,
      // links made before trees name no type: a document
      type: 'docx' as const,
      revision: manifest?.revision ?? null,
      modifiedAt: manifest?.modifiedAt ?? null,
      file: manifest ? `${link.dest}/${manifest.file}` : null,
      pages: null,
      documents: null,
      images: media.filter((rel) => rel.startsWith('assets/')).length,
      attachments: media.filter((rel) => rel.startsWith('files/')).length,
      failed: Object.keys(manifest?.failed ?? {}).length,
    };
  });
}

/* ------------------------------ the daily check -------------------------- */

export const DEFAULT_FEISHU_CHECK_AT = '06:00';
const CHECKED_AT_FILE = '.knode/feishu-checked-at';

/** When `serve` asks Feishu about linked documents each day ("HH:MM"); null when that is off. */
export function feishuCheckTime(config: KnodeConfig): string | null {
  const value = config.ingest.feishu?.checkAt;
  if (typeof value === 'string' && value.trim().toLowerCase() === 'off') return null;
  return normalizeTimeOfDay(value ?? DEFAULT_FEISHU_CHECK_AT) ?? DEFAULT_FEISHU_CHECK_AT;
}

/** When every linked document was last checked, here or by a Check now; null before the first. */
export function lastFeishuCheck(dataDir: string): string | null {
  try {
    const text = fs.readFileSync(path.join(dataDir, CHECKED_AT_FILE), 'utf8').trim();
    return Number.isFinite(Date.parse(text)) ? text : null;
  } catch {
    return null;
  }
}

function noteFeishuCheck(dataDir: string, at: string): void {
  fs.mkdirSync(path.dirname(path.join(dataDir, CHECKED_AT_FILE)), { recursive: true });
  fs.writeFileSync(path.join(dataDir, CHECKED_AT_FILE), `${at}\n`);
}

/** The last time the daily check fell due: today's when it has come, else yesterday's. */
export function lastDailyDue(hhmm: string, now = new Date()): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const due = new Date(now);
  due.setHours(h, m, 0, 0);
  if (due.getTime() > now.getTime()) due.setDate(due.getDate() - 1);
  return due;
}

/* ------------------------------ sign-in ---------------------------------- */

export interface FeishuSignInState {
  state: 'idle' | 'waiting' | 'done' | 'failed';
  verificationUrl: string | null;
  expiresAt: string | null;
  error: string | null;
}

/**
 * The one-time authorization, started from knode-os: lark-cli's device flow
 * gives a link the person opens — on this Mac or a phone — to approve
 * knode-os's scopes as their Feishu account; lark-cli then holds the token
 * and keeps it fresh. lark-cli's sign-in is this machine's, not a
 * workspace's, so one flow runs at a time per process.
 */
export class FeishuSignIn {
  private current: FeishuSignInState = { state: 'idle', verificationUrl: null, expiresAt: null, error: null };
  private waiting: Promise<void> | null = null;

  constructor(private readonly client: () => LarkCli, private readonly log: (msg: string) => void = () => {}) {}

  state(): FeishuSignInState {
    if (this.current.state === 'waiting' && this.current.expiresAt && Date.parse(this.current.expiresAt) < Date.now()) {
      this.current = { ...this.current, state: 'failed', error: 'the sign-in link expired before it was approved' };
    }
    return { ...this.current };
  }

  /** Start a sign-in (or return the one under way): the link to open. */
  async begin(status?: FeishuAuthStatus): Promise<FeishuSignInState> {
    if (this.state().state === 'waiting') return this.state();
    const client = this.client();
    // the scopes lark-cli's user already granted are asked again, so its other uses keep them
    const login = await client.beginLogin(status?.signedIn ? status.scopes : []);
    this.current = { state: 'waiting', verificationUrl: login.verificationUrl, expiresAt: new Date(Date.now() + login.expiresIn * 1000).toISOString(), error: null };
    this.waiting = client.completeLogin(login).then(
      () => {
        this.current = { ...this.current, state: 'done', error: null };
        this.log('feishu: signed in through lark-cli');
      },
      (err) => {
        this.current = { ...this.current, state: 'failed', error: err instanceof Error ? err.message : String(err) };
        this.log(`feishu: sign-in failed: ${this.current.error}`);
      },
    );
    return this.state();
  }

  /** Resolves when a sign-in under way ends (tests and shutdown). */
  async settled(): Promise<void> {
    await this.waiting;
  }
}

/* ------------------------------ the scheduler ---------------------------- */

export interface FeishuDocsOptions {
  log?: (msg: string) => void;
  track?: <T>(job: Promise<T>) => Promise<T>;
  /** Seconds after start before the first look at the clock (the startup sync goes first). */
  firstCheckSeconds?: number;
}

/** After a check that failed outright (a lapsed sign-in, Feishu down), how long until the clock tries again. */
const RETRY_MS = 60 * 60_000;

/**
 * What `serve` runs per workspace for its linked Feishu documents: once a
 * day at `ingest.feishu.checkAt`, and shortly after startup when that time
 * passed while knode-os was down, it asks Feishu which of them changed and
 * fetches those. `checkNow` does the same when a person asks.
 */
export class FeishuDocs {
  private readonly runtime = new Map<string, FeishuLinkRuntime>();
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private running: Promise<FeishuRefreshResult[]> | null = null;
  private retryAfter = 0;
  private stopped = false;
  private readonly log: (msg: string) => void;
  private readonly track: <T>(job: Promise<T>) => Promise<T>;

  constructor(private readonly ctx: SyncContext, private readonly opts: FeishuDocsOptions = {}) {
    this.log = opts.log ?? (() => {});
    this.track = opts.track ?? ((job) => job);
  }

  private get client(): LarkCli {
    return feishuClient(this.ctx.config);
  }

  start(): void {
    const tick = () => {
      if (!this.stopped && this.due()) this.checkNow({ scheduled: true });
    };
    this.first = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, 60_000);
      this.timer.unref?.();
    }, (this.opts.firstCheckSeconds ?? 20) * 1000);
    this.first.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
    await this.running?.catch(() => {});
  }

  /** Whether the daily check is owed: links to check, the clock past today's time (or yesterday's) since the last check, no check under way. */
  due(now = new Date()): boolean {
    const at = feishuCheckTime(this.ctx.config);
    if (!at || this.running || now.getTime() < this.retryAfter || feishuLinks(this.ctx.config).length === 0) return false;
    const last = lastFeishuCheck(this.ctx.dataDir);
    return !last || Date.parse(last) < lastDailyDue(at, now).getTime();
  }

  /** When the next daily check comes; null while it is off or nothing is linked. */
  nextCheck(now = new Date()): string | null {
    const at = feishuCheckTime(this.ctx.config);
    if (!at || feishuLinks(this.ctx.config).length === 0) return null;
    const last = lastFeishuCheck(this.ctx.dataDir);
    if (!last || Date.parse(last) < lastDailyDue(at, now).getTime()) return new Date(Math.max(now.getTime(), this.retryAfter)).toISOString();
    const next = lastDailyDue(at, now);
    next.setDate(next.getDate() + 1);
    return next.toISOString();
  }

  /** Start checking every link in the background; false when a check is under way already. */
  checkNow(opts: { force?: boolean; scheduled?: boolean } = {}): boolean {
    if (this.running) return false;
    void this.track(
      this.refresh(undefined, { force: opts.force }).catch((err) => {
        if (opts.scheduled) this.retryAfter = Date.now() + RETRY_MS;
        this.log(`feishu: check failed: ${err instanceof Error ? err.message : err}${opts.scheduled ? ' — trying again in an hour' : ''}`);
      }),
    );
    return true;
  }

  /** Import a document (or a tree) once, or link it. */
  async add(input: string, opts: FeishuImportOptions): Promise<FeishuImportResult> {
    const result = await importFeishuDocument(this.ctx, this.client, input, { ...opts, onProgress: opts.onProgress ?? this.log });
    if (opts.mode === 'link') this.linked(result, result.indexing);
    return result;
  }

  /** Import several links (or a tree) in the background; see startFeishuImport. */
  startImport(inputs: string[], opts: { mode: FeishuImportMode; subpages?: boolean; llmGraph?: boolean }): ReturnType<typeof startFeishuImport> {
    return startFeishuImport(this.ctx, this.client, inputs, {
      ...opts,
      log: this.log,
      track: this.track,
      onDone: (job) => {
        if (job.mode !== 'link') return;
        for (const item of job.items) if (item.result) this.linked(item.result, job.indexing);
      },
    });
  }

  /** A link just made counts as checked; the first one starts the daily clock. */
  private linked(result: FeishuPlaced, indexing: boolean): void {
    const at = new Date().toISOString();
    this.runtime.set(result.dest, { lastCheckAt: at, lastSyncAt: indexing ? null : at, lastError: null, lastChange: { written: result.written.length, removed: result.removed.length, at } });
    if (!lastFeishuCheck(this.ctx.dataDir)) noteFeishuCheck(this.ctx.dataDir, at);
  }

  async remove(dest: string, opts: { removeFiles?: boolean } = {}): Promise<Awaited<ReturnType<typeof unlinkFeishuDocument>>> {
    this.runtime.delete(dest);
    return unlinkFeishuDocument(this.ctx, dest, { ...opts, onProgress: this.log });
  }

  /** Check every link (or the one at `dest`) now; one check runs at a time. */
  async refresh(dest?: string, opts: { force?: boolean } = {}): Promise<FeishuRefreshResult[]> {
    while (this.running) await this.running.catch(() => {});
    const job = activityOf(this.ctx.dataDir).run(
      'feishu',
      dest ? `${dest}: checking Feishu for edits` : 'Linked Feishu documents: checking for edits',
      (progress) =>
        refreshFeishuLinks(this.ctx, this.client, {
          dest,
          force: opts.force,
          onProgress: (m) => {
            this.log(m);
            progress(m);
          },
        }),
      (results) => {
        const fetched = results.filter((r) => r.fetched).length;
        const failed = results.filter((r) => r.error).length;
        return `${results.length} checked, ${fetched} fetched${failed ? `, ${failed} unreadable` : ''}`;
      },
    );
    this.running = job;
    const at = new Date().toISOString();
    try {
      const results = await job;
      for (const r of results) {
        const rt = this.runtimeOf(r.dest);
        this.runtime.set(r.dest, {
          lastCheckAt: at,
          lastSyncAt: r.fetched ? at : rt.lastSyncAt,
          lastError: r.error,
          lastChange: r.written || r.removed ? { written: r.written, removed: r.removed, at } : rt.lastChange,
        });
        if (r.error) this.log(`feishu ${r.dest}: ${r.error}`);
      }
      // a check of every link is the daily one, whoever asked for it
      if (!dest) {
        noteFeishuCheck(this.ctx.dataDir, at);
        this.retryAfter = 0;
      }
      return results;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const link of feishuLinks(this.ctx.config).filter((l) => !dest || l.dest === dest)) {
        this.runtime.set(link.dest, { ...this.runtimeOf(link.dest), lastCheckAt: at, lastError: message });
      }
      throw err;
    } finally {
      if (this.running === job) this.running = null;
    }
  }

  /** A check is under way. */
  get checking(): boolean {
    return this.running !== null;
  }

  status(): FeishuLinkStatus[] {
    return describeFeishuLinks(this.ctx, this.runtime);
  }

  private runtimeOf(dest: string): FeishuLinkRuntime {
    return this.runtime.get(dest) ?? { lastCheckAt: null, lastSyncAt: null, lastError: null, lastChange: null };
  }
}
