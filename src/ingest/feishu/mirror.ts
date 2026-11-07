import fs from 'node:fs';
import path from 'node:path';
import { FeishuLink, KnodeConfig } from '../../config.js';
import { MAX_FILE_BYTES } from '../../constants.js';
import { safePath, sanitizeRelativePath, walkFiles } from '../../fs/files.js';
import { RAW_DOCS } from '../../fs/layout.js';
import { isConvertibleFile, maxConvertibleBytes, originalOfTranscript } from '../convert.js';
import { isImportable } from '../folders.js';
import { FeishuError, LarkCli } from './client.js';
import { FeishuRef, parseFeishuRef, renderFeishuMarkdown, scanFeishuMarkdown } from './markdown.js';

/**
 * One Feishu document as a folder of the workspace (see ./docs.ts for how
 * documents are imported, linked and kept in sync):
 *
 *   <dest>/<title>.md        the document as Markdown, frontmatter saying where it came from
 *   <dest>/assets/<token>.*  its pictures and whiteboards — each one a source of its own,
 *                            transcribed by the vision model like any image
 *   <dest>/files/<name>      its attachments of a type knode-os indexes (PDF, text…);
 *                            the rest stay in Feishu, named in the text
 *   <dest>/.feishu.json      the manifest: which token each file came from, the revision held
 *
 * Pictures are downloaded once: Feishu gives a replaced picture a new token,
 * so a token already on disk is never fetched again.
 */

export const FEISHU_ROOT = `${RAW_DOCS}/feishu`;
export const FEISHU_MANIFEST = '.feishu.json';

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
  if (ref.kind === 'space') throw new FeishuError(`${input} is a whole wiki space — import it with its pages`, 'other');
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
export function segmentName(title: string, fallback: string): string {
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
    return JSON.parse(fs.readFileSync(path.join(safePath(dataDir, dest), FEISHU_MANIFEST), 'utf8')) as FeishuManifest;
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
export function writeIfChanged(abs: string, content: string): boolean {
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
export async function mirrorFeishuDocument(
  dataDir: string,
  client: LarkCli,
  target: FeishuTarget,
  dest: string,
  /**
   * `ownOnly`: the folder also holds other pages' folders (a wiki tree,
   * ./tree.ts), which are not this document's to clean up. `file`: the
   * Markdown's name for a new mirror (default the title's).
   */
  opts: { onProgress?: (m: string) => void; ownOnly?: boolean; file?: string } = {},
): Promise<FeishuMirrorResult> {
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
        if ((m.bytes ?? 0) > (isConvertibleFile(name) ? maxConvertibleBytes(name) : MAX_FILE_BYTES)) {
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
  const file = before?.file ?? opts.file ?? `${segmentName(title, 'document')}.md`;
  const fileKey = `${dest}/${file}`;
  if (writeIfChanged(path.join(destAbs, file), composeMarkdown({ ...target, title }, doc.revisionId, rendered.body))) written.unshift(fileKey);

  // what the document stopped referencing goes; so does a stray file the manifest never named
  const keep = new Set([file, ...Object.values(media)]);
  const removed: string[] = [];
  for (const key of walkFiles(dataDir, dest)) {
    const rel = key.slice(dest.length + 1);
    if (keep.has(rel)) continue;
    if (opts.ownOnly && rel.includes('/') && !/^(assets|files)\//.test(rel)) continue;
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
  writeIfChanged(path.join(destAbs, FEISHU_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
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
