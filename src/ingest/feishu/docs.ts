import fs from 'node:fs';
import path from 'node:path';
import { FeishuLink, KnodeConfig, saveConfig } from '../../config.js';
import { MAX_CONVERTIBLE_FILE_BYTES, MAX_FILE_BYTES } from '../../constants.js';
import { activityOf } from '../../activity.js';
import { safePath, sanitizeRelativePath, walkFiles } from '../../fs/files.js';
import { RAW_DOCS } from '../../fs/layout.js';
import { isConvertibleFile, originalOfTranscript } from '../convert.js';
import { FolderImportConflict, holdDest, isImportable, linkOwning, linksUnder, mirrorLinks } from '../folders.js';
import { sync, SyncContext, SyncStats } from '../sync.js';
import { DocumentMeta, FeishuAuthStatus, FeishuError, LarkCli, LarkRunner } from './client.js';
import { FeishuRef, parseFeishuRef, renderFeishuMarkdown, scanFeishuMarkdown } from './markdown.js';

/**
 * Feishu documents as a source — one person's Feishu Docs (directly or in a
 * wiki) mirrored into `raw/docs/feishu/<title>__<token>/`, once or kept in
 * sync, the way a folder from this machine is (src/ingest/folders.ts):
 *
 *   <dest>/<title>.md        the document as Markdown, frontmatter saying where it came from
 *   <dest>/assets/<token>.*  its pictures and whiteboards — each one a source of its own,
 *                            transcribed by the vision model like any image
 *   <dest>/files/<name>      its attachments of a type knode-os indexes (PDF, text…);
 *                            the rest stay in Feishu, named in the text
 *   <dest>/.feishu.json      the manifest: which token each file came from, the revision held
 *
 * **One-time import** (`copy`) writes the mirror and forgets the document:
 * from then on it is ordinary workspace content. **Link** remembers it in
 * `ingest.feishuDocs`; while `serve` runs, a poller asks Feishu every few
 * minutes when each linked document was last edited (one metadata call per
 * 200 documents) and re-mirrors the ones that moved, syncing only the files
 * that changed. Pictures are downloaded once: Feishu gives a replaced picture
 * a new token, so a token already on disk is never fetched again.
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

export const FEISHU_ROOT = `${RAW_DOCS}/feishu`;
const MANIFEST = '.feishu.json';

export interface FeishuManifest {
  token: string;
  type: string;
  url: string;
  title: string;
  /** The Markdown file's name inside the mirror — kept when the document is renamed, so its knowledge stays put. */
  file: string;
  revision: number;
  modifiedAt: string | null;
  /** media token → its path inside the mirror */
  media: Record<string, string>;
  /** Media that failed to download, with why, retried on the next pass. */
  failed?: Record<string, string>;
}

/* ------------------------------ the client ------------------------------- */

let runnerOverride: LarkRunner | null = null;

/** Tests drive a fake lark-cli through this; null restores the real one. */
export function setFeishuRunner(runner: LarkRunner | null): void {
  runnerOverride = runner;
}

export function feishuClient(config: KnodeConfig): LarkCli {
  return new LarkCli({ cli: config.ingest.feishu?.cli, runner: runnerOverride ?? undefined });
}

export function feishuLinks(config: KnodeConfig): FeishuLink[] {
  return Array.isArray(config.ingest.feishuDocs) ? config.ingest.feishuDocs : [];
}

/* ------------------------------ targets ---------------------------------- */

/** A document resolved to what Feishu stores it as: wiki links name a node, not the document. */
export interface FeishuTarget {
  ref: FeishuRef;
  /** The docx token. */
  token: string;
  type: 'docx';
  url: string;
  title: string;
  modifiedAt: string | null;
  ownerId: string | null;
  /** The wiki node a wiki link named. */
  wiki?: string;
}

/** Read a link and ask Feishu what it is — which also proves the signed-in user may read it. */
export async function resolveFeishuTarget(client: LarkCli, input: string): Promise<FeishuTarget> {
  const ref = parseFeishuRef(input);
  let token = ref.token;
  let wiki: string | undefined;
  let title = '';
  if (ref.kind === 'wiki') {
    const node = await client.wikiNode(ref.token);
    if (node.objType !== 'docx') throw new FeishuError(`${input} is a wiki page holding a ${node.objType || 'non-document'} — only Docs (docx) pages can be imported`, 'other');
    token = node.objToken;
    wiki = ref.token;
    title = node.title;
  }
  const { metas, failed } = await client.metas([{ token, type: 'docx' }]);
  const meta = metas.get(token);
  if (!meta) {
    const code = failed.get(token);
    throw new FeishuError(`cannot read ${input}${code ? ` (Feishu code ${code})` : ''}`, 'forbidden', 'check that the link is right and that the signed-in Feishu user can open it');
  }
  const host = ref.host ?? (meta.url ? new URL(meta.url).hostname : 'feishu.cn');
  const url = wiki ? `https://${host}/wiki/${wiki}` : meta.url ?? `https://${host}/docx/${token}`;
  return { ref, token, type: 'docx', url, title: meta.title || title || token, modifiedAt: meta.modifiedAt, ownerId: meta.ownerId, wiki };
}

/** A name that is safe as one path segment on every filesystem knode-os runs on. */
function segmentName(title: string, fallback: string): string {
  const clean = title
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();
  return clean || fallback;
}

/** The mirror's folder: `raw/docs/feishu/<title>__<token>`, or a folder under raw/docs the caller names. */
export function feishuDestFor(target: { title: string; token: string }, dest?: string): string {
  if (dest?.trim()) {
    const name = sanitizeRelativePath(dest.trim());
    const rel = name === RAW_DOCS || name.startsWith(`${RAW_DOCS}/`) ? name : `${RAW_DOCS}/${name}`;
    if (rel === RAW_DOCS) throw new Error(`the destination must be a folder under ${RAW_DOCS}/, not ${RAW_DOCS} itself`);
    return rel;
  }
  return `${FEISHU_ROOT}/${segmentName(target.title, 'document')}__${target.token}`;
}

export function readManifest(dataDir: string, dest: string): FeishuManifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(safePath(dataDir, dest), MANIFEST), 'utf8')) as FeishuManifest;
  } catch {
    return null;
  }
}

/** Where a document was imported before, by its token: its link, else a mirror under raw/docs/feishu named for it. */
export function findFeishuMirror(dataDir: string, config: KnodeConfig, token: string): string | null {
  const link = feishuLinks(config).find((l) => l.token === token);
  if (link) return link.dest;
  const root = safePath(dataDir, FEISHU_ROOT);
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.endsWith(`__${token}`)) return `${FEISHU_ROOT}/${e.name}`;
    }
  } catch {
    // no Feishu documents yet
  }
  return null;
}

/* ------------------------------ mirroring -------------------------------- */

export interface FeishuMirrorResult {
  dest: string;
  /** The Markdown file's key. */
  file: string;
  title: string;
  revision: number;
  modifiedAt: string | null;
  /** Keys written this pass: the Markdown when it changed, and new pictures and attachments. */
  written: string[];
  /** Keys removed because the document no longer references them. */
  removed: string[];
  images: number;
  attachments: number;
  /** Attachments and embeds that stay in Feishu (a type knode-os does not index, or too large). */
  keptInFeishu: number;
  warnings: string[];
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|avif|heic|heif|svg)$/i;

/** A relative link target Markdown reads whole: angle brackets when the path has spaces or parentheses. */
const href = (rel: string) => (/[\s()<>]/.test(rel) ? `<${rel}>` : rel);

/** The local name of an attachment: its own name, made unique within the mirror. */
function attachmentName(name: string, token: string, taken: Set<string>): string {
  const ext = path.extname(name);
  const base = segmentName(path.basename(name, ext), token);
  let candidate = `files/${base}${ext.toLowerCase()}`;
  if (taken.has(candidate)) candidate = `files/${base}-${token.slice(0, 8)}${ext.toLowerCase()}`;
  taken.add(candidate);
  return candidate;
}

/** Write through a hidden temporary name and rename into place, only when the bytes differ. */
function writeIfChanged(abs: string, content: string): boolean {
  try {
    if (fs.readFileSync(abs, 'utf8') === content) return false;
  } catch {
    // new
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, abs);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return true;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

/** The document as knode-os keeps it: provenance in the frontmatter, the title as its heading. */
function composeMarkdown(target: FeishuTarget, revision: number, body: string): string {
  const lines = [
    '---',
    `title: ${yamlString(target.title)}`,
    'platform: feishu',
    `source_url: ${yamlString(target.url)}`,
    `feishu_token: ${yamlString(target.token)}`,
    ...(target.wiki ? [`feishu_wiki_node: ${yamlString(target.wiki)}`] : []),
    `feishu_revision: ${revision}`,
    // the text is as of the last edit Feishu reports
    ...(target.modifiedAt ? [`as_of: ${yamlString(target.modifiedAt)}`] : []),
    'tags: ["platform/feishu"]',
    '---',
    '',
    `# ${target.title}`,
    '',
    body,
    '',
  ];
  return lines.join('\n');
}

/**
 * Bring the mirror at `dest` up to the document's current content: fetch it,
 * download what it references that is not on disk yet, write the Markdown
 * when it changed, and remove what it no longer references. Idempotent: a
 * second pass over an unchanged document writes nothing.
 */
export async function mirrorFeishuDocument(dataDir: string, client: LarkCli, target: FeishuTarget, dest: string, opts: { onProgress?: (m: string) => void } = {}): Promise<FeishuMirrorResult> {
  const progress = opts.onProgress ?? (() => {});
  const destAbs = safePath(dataDir, dest);
  const before = readManifest(dataDir, dest);
  const doc = await client.fetchDocument(target.token);
  const scanned = scanFeishuMarkdown(doc.content);
  fs.mkdirSync(destAbs, { recursive: true });

  const warnings: string[] = [];
  const written: string[] = [];
  const media: Record<string, string> = {};
  const failed: Record<string, string> = {};
  const taken = new Set<string>(Object.values(before?.media ?? {}).filter((rel) => rel.startsWith('files/')));
  // downloads land in a hidden folder first: no walker or watcher sees a half-written file
  const staging = path.join(destAbs, `.download-${process.pid}`);
  let keptInFeishu = 0;
  try {
    for (const m of scanned.media) {
      const known = before?.media[m.token];
      if (known && fs.existsSync(path.join(destAbs, known))) {
        media[m.token] = known;
        continue;
      }
      if (m.kind === 'file') {
        const name = m.name ?? m.token;
        if (!isImportable(name)) {
          keptInFeishu++;
          continue;
        }
        if ((m.bytes ?? 0) > MAX_CONVERTIBLE_FILE_BYTES || (!isConvertibleFile(name) && (m.bytes ?? 0) > MAX_FILE_BYTES)) {
          keptInFeishu++;
          warnings.push(`${name}: too large to index — kept in Feishu`);
          continue;
        }
      }
      try {
        fs.mkdirSync(staging, { recursive: true });
        const got = await client.download(m.token, path.join(staging, m.token), m.kind === 'whiteboard' ? 'whiteboard' : 'media');
        const ext = path.extname(got.path).toLowerCase();
        let rel: string;
        if (m.kind === 'file') {
          rel = attachmentName(m.name ?? `${m.token}${ext}`, m.token, taken);
        } else {
          rel = `assets/${m.token}${ext || '.png'}`;
          if (!IMAGE_EXT.test(rel)) warnings.push(`${m.token}: Feishu served ${got.contentType || 'an unknown type'} for a picture`);
        }
        const abs = path.join(destAbs, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.renameSync(got.path, abs);
        media[m.token] = rel;
        written.push(`${dest}/${rel}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed[m.token] = message;
        warnings.push(`${m.name ?? m.token}: ${message}`);
      }
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  if (written.length) progress(`feishu ${dest}: ${written.length} picture(s) and attachment(s) downloaded`);

  const rendered = renderFeishuMarkdown(doc.content, (m) => (media[m.token] ? { href: href(media[m.token]) } : null), { host: target.ref.host ?? new URL(target.url).hostname });
  const title = target.title || rendered.title || target.token;
  const file = before?.file ?? `${segmentName(title, 'document')}.md`;
  const fileKey = `${dest}/${file}`;
  if (writeIfChanged(path.join(destAbs, file), composeMarkdown({ ...target, title }, doc.revisionId, rendered.body))) written.unshift(fileKey);

  // what the document stopped referencing goes; so does a stray file the manifest never named
  const keep = new Set([file, ...Object.values(media)]);
  const removed: string[] = [];
  for (const key of walkFiles(dataDir, dest)) {
    const rel = key.slice(dest.length + 1);
    if (keep.has(rel)) continue;
    // a reviewed transcript beside a picture (docs/design/19) is a person's reading of it: it stays while the picture does
    const original = originalOfTranscript(rel);
    if (original && keep.has(original)) continue;
    fs.rmSync(safePath(dataDir, key), { force: true });
    removed.push(key);
  }
  for (const sub of ['assets', 'files']) {
    try {
      fs.rmdirSync(path.join(destAbs, sub));
    } catch {
      // not empty, or not there
    }
  }

  const manifest: FeishuManifest = {
    token: target.token,
    type: target.type,
    url: target.url,
    title,
    file,
    revision: doc.revisionId,
    modifiedAt: target.modifiedAt,
    media,
    ...(Object.keys(failed).length ? { failed } : {}),
  };
  writeIfChanged(path.join(destAbs, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  const images = Object.values(media).filter((rel) => rel.startsWith('assets/')).length;
  return {
    dest,
    file: fileKey,
    title,
    revision: doc.revisionId,
    modifiedAt: target.modifiedAt,
    written,
    removed,
    images,
    attachments: Object.keys(media).length - images,
    keptInFeishu: keptInFeishu + (doc.content.match(/<(bitable|sheet)\b/gi)?.length ?? 0),
    warnings,
  };
}

/* ------------------------------ import / link ---------------------------- */

export type FeishuImportMode = 'copy' | 'link';

export interface FeishuImportOptions {
  mode: FeishuImportMode;
  /** Destination folder under raw/docs; default raw/docs/feishu/<title>__<token>. */
  dest?: string;
  llmGraph?: boolean;
  onProgress?: (msg: string) => void;
  /** As for a folder import: return once the mirror is written and index it afterwards. */
  background?: {
    track?: <T>(job: Promise<T>) => Promise<T>;
    onIndexed?: (done: { dest: string; sync: SyncStats | null; error?: string }) => void;
  };
}

export interface FeishuImportResult extends FeishuMirrorResult {
  url: string;
  token: string;
  mode: FeishuImportMode;
  /** The document was imported here before: this import refreshed that copy. */
  refreshed: boolean;
  sync: SyncStats | null;
  indexing: boolean;
}

/** The `only` list for a sync after a pass: each key while there are few, the whole mirror otherwise. */
const syncScope = (dest: string, keys: string[]) => (keys.length > 200 ? [dest] : keys);

function persistLinks(ctx: SyncContext, links: FeishuLink[]): void {
  ctx.config.ingest.feishuDocs = links;
  saveConfig(ctx.dataDir, ctx.config);
}

/**
 * Import a Feishu document: resolve the link, mirror it, remember it when
 * linking, and index what was written. Importing a document that is already
 * here refreshes that copy instead of making a second one.
 */
export async function importFeishuDocument(ctx: SyncContext, client: LarkCli, input: string, opts: FeishuImportOptions): Promise<FeishuImportResult> {
  const target = await resolveFeishuTarget(client, input);
  const links = feishuLinks(ctx.config);
  const existingLink = links.find((l) => l.token === target.token);
  if (existingLink && opts.mode === 'link') throw new FolderImportConflict(`${target.title} is already linked at ${existingLink.dest}`);
  if (existingLink) throw new FolderImportConflict(`${target.title} is linked at ${existingLink.dest} and kept in sync already — sync it instead`);
  const previous = opts.dest ? null : findFeishuMirror(ctx.dataDir, ctx.config, target.token);
  const dest = previous ?? feishuDestFor(target, opts.dest);
  const owner = linkOwning(mirrorLinks(ctx.config), dest);
  if (owner) throw new FolderImportConflict(`${dest} is inside ${owner.dest}, which is mirrored from ${owner.source}`);
  const inside = linksUnder(mirrorLinks(ctx.config), dest);
  if (inside.length) throw new FolderImportConflict(`${dest} would contain the linked ${inside[0].dest} — pick another destination`);
  const destAbs = safePath(ctx.dataDir, dest);
  const manifest = readManifest(ctx.dataDir, dest);
  if (fs.existsSync(destAbs) && fs.readdirSync(destAbs).length && manifest?.token !== target.token) {
    throw new FolderImportConflict(`${dest} already exists and holds something else — pick another destination`);
  }

  const progress = opts.onProgress ?? (() => {});
  progress(`${opts.mode === 'link' ? 'linking' : 'importing'} ${target.url} → ${dest}`);
  const release = holdDest(ctx.dataDir, dest);
  let handedOff = false;
  try {
    const mirrored = await mirrorFeishuDocument(ctx.dataDir, client, target, dest, { onProgress: opts.onProgress });
    if (opts.mode === 'link') {
      persistLinks(ctx, [...links, { url: target.url, token: target.token, type: target.type, ...(target.wiki ? { wiki: target.wiki } : {}), title: mirrored.title, dest, createdAt: new Date().toISOString() }]);
    }
    const changed = [...mirrored.written, ...mirrored.removed];
    const base = { ...mirrored, url: target.url, token: target.token, mode: opts.mode, refreshed: Boolean(manifest) };
    if (changed.length === 0) return { ...base, sync: null, indexing: false };
    const indexing = sync(ctx, { only: syncScope(dest, changed), llmGraph: opts.llmGraph, onProgress: opts.onProgress });
    if (opts.background) {
      const { track = (job) => job, onIndexed } = opts.background;
      handedOff = true;
      void track(indexing.finally(release)).then(
        (stats) => onIndexed?.({ dest, sync: stats }),
        (err) => onIndexed?.({ dest, sync: null, error: err instanceof Error ? err.message : String(err) }),
      );
      return { ...base, sync: null, indexing: true };
    }
    return { ...base, sync: await indexing, indexing: false };
  } finally {
    if (!handedOff) release();
  }
}

export interface FeishuRefreshResult {
  dest: string;
  url: string;
  title: string;
  /** Feishu says it changed (or the refresh was forced), so it was fetched again. */
  fetched: boolean;
  written: number;
  removed: number;
  modifiedAt: string | null;
  sync: SyncStats | null;
  /** Why the document could not be read; the mirror was left alone. */
  error: string | null;
  warnings: string[];
}

/**
 * Bring linked documents (all, or the one at `dest`) up to date: one
 * metadata call says which changed since their mirror was written, and only
 * those are fetched. `force` fetches every one regardless.
 */
export async function refreshFeishuLinks(
  ctx: SyncContext,
  client: LarkCli,
  opts: { dest?: string; force?: boolean; onProgress?: (m: string) => void } = {},
): Promise<FeishuRefreshResult[]> {
  const links = feishuLinks(ctx.config).filter((l) => !opts.dest || l.dest === opts.dest);
  if (opts.dest && links.length === 0) throw new Error(`no linked Feishu document at ${opts.dest}`);
  if (links.length === 0) return [];
  const { metas, failed } = await client.metas(links.map((l) => ({ token: l.token, type: l.type })));
  const out: FeishuRefreshResult[] = [];
  for (const link of links) {
    out.push(await refreshOne(ctx, client, link, metas.get(link.token) ?? null, failed.get(link.token), opts));
  }
  return out;
}

async function refreshOne(
  ctx: SyncContext,
  client: LarkCli,
  link: FeishuLink,
  meta: DocumentMeta | null,
  failedCode: number | undefined,
  opts: { force?: boolean; onProgress?: (m: string) => void },
): Promise<FeishuRefreshResult> {
  const base = { dest: link.dest, url: link.url, title: link.title, fetched: false, written: 0, removed: 0, modifiedAt: meta?.modifiedAt ?? null, sync: null, warnings: [] as string[] };
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
    if (mirrored.title !== link.title) persistLinks(ctx, feishuLinks(ctx.config).map((l) => (l.dest === link.dest ? { ...l, title: mirrored.title } : l)));
    const stats = changed.length ? await sync(ctx, { only: syncScope(link.dest, changed), onProgress: opts.onProgress }) : null;
    if (changed.length) opts.onProgress?.(`feishu ${link.dest}: ${mirrored.written.length} written, ${mirrored.removed.length} removed`);
    return { ...base, title: mirrored.title, fetched: true, written: mirrored.written.length, removed: mirrored.removed.length, sync: stats, error: null, warnings: mirrored.warnings };
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
  /** The revision and last edit the mirror holds. */
  revision: number | null;
  modifiedAt: string | null;
  file: string | null;
  images: number;
  attachments: number;
  /** Media a pass could not download, retried on the next. */
  failed: number;
}

export function describeFeishuLinks(ctx: { dataDir: string; config: KnodeConfig }, runtime?: Map<string, FeishuLinkRuntime>): FeishuLinkStatus[] {
  return feishuLinks(ctx.config).map((link) => {
    const manifest = readManifest(ctx.dataDir, link.dest);
    const media = Object.values(manifest?.media ?? {});
    const rt = runtime?.get(link.dest);
    return {
      ...link,
      revision: manifest?.revision ?? null,
      modifiedAt: manifest?.modifiedAt ?? null,
      file: manifest ? `${link.dest}/${manifest.file}` : null,
      images: media.filter((rel) => rel.startsWith('assets/')).length,
      attachments: media.filter((rel) => rel.startsWith('files/')).length,
      failed: Object.keys(manifest?.failed ?? {}).length,
      lastCheckAt: rt?.lastCheckAt ?? null,
      lastSyncAt: rt?.lastSyncAt ?? null,
      lastError: rt?.lastError ?? null,
      lastChange: rt?.lastChange ?? null,
    };
  });
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

/* ------------------------------ the poller ------------------------------- */

export interface FeishuDocsOptions {
  log?: (msg: string) => void;
  track?: <T>(job: Promise<T>) => Promise<T>;
  /** Minutes between asking Feishu which linked documents changed; 0 disables. Default ingest.feishu.pollMinutes, else 10. */
  pollMinutes?: number;
  /** Seconds after start before the first check (the startup sync goes first). */
  firstCheckSeconds?: number;
}

/**
 * What `serve` runs per workspace for its linked Feishu documents: a check
 * shortly after startup for whatever changed while knode-os was down, then
 * one every few minutes. A check is one metadata call for all of them; only
 * documents edited since their mirror was written are fetched.
 */
export class FeishuDocs {
  private readonly runtime = new Map<string, FeishuLinkRuntime>();
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private running: Promise<FeishuRefreshResult[]> | null = null;
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
    const minutes = this.opts.pollMinutes ?? this.ctx.config.ingest.feishu?.pollMinutes ?? 10;
    if (minutes <= 0) return;
    const check = () => {
      if (this.stopped || feishuLinks(this.ctx.config).length === 0) return;
      void this.track(this.refresh().catch((err) => this.log(`feishu: check failed: ${err instanceof Error ? err.message : err}`)));
    };
    this.first = setTimeout(check, (this.opts.firstCheckSeconds ?? 20) * 1000);
    this.first.unref?.();
    this.timer = setInterval(check, minutes * 60_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
    await this.running?.catch(() => {});
  }

  /** Import a document once, or link it. */
  async add(input: string, opts: FeishuImportOptions): Promise<FeishuImportResult> {
    const result = await importFeishuDocument(this.ctx, this.client, input, { ...opts, onProgress: opts.onProgress ?? this.log });
    if (opts.mode === 'link') {
      const at = new Date().toISOString();
      this.runtime.set(result.dest, { lastCheckAt: at, lastSyncAt: result.indexing ? null : at, lastError: null, lastChange: { written: result.written.length, removed: result.removed.length, at } });
    }
    return result;
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
      () => refreshFeishuLinks(this.ctx, this.client, { dest, force: opts.force, onProgress: this.log }),
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

  status(): FeishuLinkStatus[] {
    return describeFeishuLinks(this.ctx, this.runtime);
  }

  private runtimeOf(dest: string): FeishuLinkRuntime {
    return this.runtime.get(dest) ?? { lastCheckAt: null, lastSyncAt: null, lastError: null, lastChange: null };
  }
}
