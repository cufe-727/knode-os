import fs from 'node:fs';
import path from 'node:path';
import { safePath } from '../../fs/files.js';
import { sidecarRelFor } from '../../fs/layout.js';
import { FeishuError, LarkCli, WikiNode } from './client.js';
import { parseFeishuRef } from './markdown.js';
import { FEISHU_MANIFEST, FeishuTarget, mirrorFeishuDocument, readManifest, segmentName, writeIfChanged } from './mirror.js';

/**
 * A wiki page with the pages under it — or a whole wiki space — as a tree of
 * folders that keeps the wiki's structure:
 *
 *   <dest>/<title>.md, assets/, files/   the top page (none for a whole space)
 *   <dest>/<page>/<page>.md, assets/…    each page under it, a folder of its own
 *   <dest>/<page>/<sub-page>/…           …as deep as the wiki goes
 *   <dest>/.feishu-tree.json             which folder each wiki page is
 *
 * A page holding a Docs document is mirrored into its folder as a single
 * document is (./mirror.ts); a page holding a sheet, a base or another kind
 * stays in Feishu, its folder made only for the pages under it. A shortcut
 * points at a page that lives elsewhere and is not followed.
 *
 * The wiki's listing carries every page's last edit, so a pass lists the tree
 * and fetches only the pages edited since their copy was written. Folders
 * follow the wiki: a page renamed or moved in Feishu moves its own files (with
 * their conversions and extractions, so nothing is read by a model again), and
 * a page deleted from the wiki — or no longer readable — goes.
 */

export const FEISHU_TREE_MANIFEST = '.feishu-tree.json';
/** A wiki bigger than this is refused: import a part of it (a page with the pages under it) instead. */
export const MAX_TREE_PAGES = 2000;
/** Folder names a page may not take: they hold its parent's pictures and attachments. */
const RESERVED = new Set(['assets', 'files']);

export interface WikiTreeRoot {
  spaceId: string;
  /** The top page; null for a whole space. */
  node: WikiNode | null;
  /** What the tree is keyed by: the top page's node token, or the space id. */
  token: string;
  title: string;
  url: string;
  host: string;
}

export interface WikiTreePage extends WikiNode {
  /** The page above it inside the tree; null at the tree's top. */
  treeParent: string | null;
  depth: number;
  url: string;
}

interface PlacedPage {
  parent: string | null;
  /** Its folder's name under its parent's; '' for a tree's top page, whose folder is the tree's. */
  name: string;
  title: string;
  objType: string;
  /** origin, or shortcut (not mirrored). */
  nodeType: string;
  objToken: string;
  editedAt: string | null;
}

export interface FeishuTreeManifest {
  kind: 'wiki-tree';
  spaceId: string;
  /** The top page's node token; null for a whole space. */
  root: string | null;
  url: string;
  title: string;
  nodes: Record<string, PlacedPage>;
}

export function readTreeManifest(dataDir: string, dest: string): FeishuTreeManifest | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(safePath(dataDir, dest), FEISHU_TREE_MANIFEST), 'utf8')) as FeishuTreeManifest;
    return manifest.kind === 'wiki-tree' ? manifest : null;
  } catch {
    return null;
  }
}

/** Read a wiki page's or space's link and ask Feishu what it is — which also proves the signed-in user may read it. */
export async function resolveWikiTree(client: LarkCli, input: string): Promise<WikiTreeRoot> {
  const ref = parseFeishuRef(input);
  if (ref.kind === 'space') {
    const space = await client.wikiSpace(ref.token);
    const host = ref.host ?? 'feishu.cn';
    return { spaceId: space.spaceId, node: null, token: space.spaceId, title: space.name || space.spaceId, url: `https://${host}/wiki/space/${space.spaceId}`, host };
  }
  if (ref.kind !== 'wiki') throw new FeishuError(`${input} is not a wiki page: only a wiki's pages have pages under them`, 'other');
  const node = await client.wikiNode(ref.token);
  const host = ref.host ?? 'feishu.cn';
  return { spaceId: node.spaceId, node, token: node.nodeToken, title: node.title || node.nodeToken, url: `https://${host}/wiki/${node.nodeToken}`, host };
}

/** Every page of the tree, each after the page above it: one listing call per page that has pages under it. */
export async function listWikiTree(client: LarkCli, root: WikiTreeRoot, opts: { max?: number } = {}): Promise<WikiTreePage[]> {
  const max = opts.max ?? MAX_TREE_PAGES;
  const out: WikiTreePage[] = [];
  const seen = new Set<string>();
  const add = (node: WikiNode, treeParent: string | null, depth: number) => {
    if (out.length >= max) throw new FeishuError(`${root.title} has more than ${max} pages — import a part of it (a page with the pages under it) instead`, 'other');
    seen.add(node.nodeToken);
    out.push({ ...node, treeParent, depth, url: `https://${root.host}/wiki/${node.nodeToken}` });
  };
  const visit = async (parent: string | null, depth: number): Promise<void> => {
    for (const child of await client.wikiChildren(root.spaceId, parent ?? undefined)) {
      if (seen.has(child.nodeToken)) continue;
      add(child, parent, depth);
      if (child.hasChild && child.nodeType !== 'shortcut') await visit(child.nodeToken, depth + 1);
    }
  };
  if (root.node) {
    add(root.node, null, 0);
    if (root.node.hasChild) await visit(root.node.nodeToken, 1);
  } else {
    await visit(null, 0);
  }
  return out;
}

/** A page this tree mirrors: a Docs document that lives here, not a shortcut to one elsewhere. */
export const isMirroredPage = (page: { objType: string; nodeType?: string }) => page.objType === 'docx' && page.nodeType !== 'shortcut';

/**
 * Each page's folder name, unique among its siblings (ignoring case, as the
 * Mac's disks do): its title, with its token's start added when a sibling
 * has the same title. A name a page held before is kept while it still fits,
 * so two same-titled pages do not trade folders between passes.
 */
export function placePages(pages: WikiTreePage[], previous: FeishuTreeManifest | null, rootNode: string | null): Map<string, PlacedPage> {
  const placed = new Map<string, PlacedPage>();
  const siblings = new Map<string | null, WikiTreePage[]>();
  for (const page of pages) {
    if (page.nodeToken === rootNode) continue;
    const group = siblings.get(page.treeParent) ?? [];
    group.push(page);
    siblings.set(page.treeParent, group);
  }
  const at = (page: WikiTreePage, name: string): PlacedPage => ({ parent: page.treeParent, name, title: page.title, objType: page.objType, nodeType: page.nodeType, objToken: page.objToken, editedAt: page.editedAt });
  if (rootNode) {
    const top = pages.find((p) => p.nodeToken === rootNode);
    if (top) placed.set(top.nodeToken, at(top, ''));
  }
  for (const group of siblings.values()) {
    const taken = new Set<string>();
    const free = (name: string) => !taken.has(name.toLowerCase()) && !RESERVED.has(name.toLowerCase());
    const take = (page: WikiTreePage, name: string) => {
      taken.add(name.toLowerCase());
      placed.set(page.nodeToken, at(page, name));
    };
    const fitting = (page: WikiTreePage) => {
      const base = segmentName(page.title, page.objToken || page.nodeToken);
      return [base, `${base}-${page.nodeToken.slice(0, 8)}`, `${base}-${page.nodeToken}`];
    };
    const rest: WikiTreePage[] = [];
    for (const page of group) {
      const before = previous?.nodes[page.nodeToken]?.name;
      if (before && fitting(page).includes(before) && free(before)) take(page, before);
      else rest.push(page);
    }
    for (const page of rest) take(page, fitting(page).find(free) ?? `${page.nodeToken}`);
  }
  return placed;
}

/** A page's folder inside the tree, from its parents' names. */
function folderOf(placed: Map<string, PlacedPage> | Record<string, PlacedPage>, token: string): string {
  const get = (t: string) => (placed instanceof Map ? placed.get(t) : placed[t]);
  const parts: string[] = [];
  const seen = new Set<string>();
  for (let cur: string | null = token; cur && !seen.has(cur); ) {
    seen.add(cur);
    const page = get(cur);
    if (!page) break;
    if (page.name) parts.unshift(page.name);
    cur = page.parent;
  }
  return parts.join('/');
}

/** The files a page's folder holds of its own: those directly in it, and everything under its assets/ and files/. */
function ownFiles(dirAbs: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return out;
  }
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dirAbs, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else out.push(child);
    }
  };
  for (const e of entries) {
    if (e.isFile() && e.name !== FEISHU_TREE_MANIFEST) out.push(e.name);
    else if (e.isDirectory() && RESERVED.has(e.name)) walk(e.name);
  }
  return out;
}

/** Folders left empty under `root` (not `root` itself), deepest first. */
function pruneEmptyDirs(rootAbs: string): void {
  const visit = (dir: string): boolean => {
    let empty = true;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && visit(path.join(dir, e.name))) continue;
      empty = false;
    }
    if (empty && dir !== rootAbs) fs.rmdirSync(dir);
    return empty;
  };
  if (fs.existsSync(rootAbs)) visit(rootAbs);
}

const join = (...parts: string[]) => parts.filter(Boolean).join('/');
const isFile = (abs: string) => {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
};

export interface FeishuTreeResult {
  dest: string;
  title: string;
  url: string;
  /** Pages in the tree, and how many of them are Docs documents mirrored here. */
  pages: number;
  documents: number;
  /** Documents fetched this pass: edited since their copy, new, or forced. */
  fetched: number;
  /** Pages whose folder moved, because they were renamed or moved in Feishu. */
  moved: number;
  /** Pages gone from the wiki since the last pass, their copies removed. */
  removedPages: number;
  /** Pages of another kind (a sheet, a base…) and shortcuts, left in Feishu. */
  keptInFeishu: { title: string; type: string }[];
  /** Keys written and removed this pass, moves included. */
  written: string[];
  removed: string[];
  images: number;
  attachments: number;
  warnings: string[];
}

/**
 * Bring the tree at `dest` up to the wiki as it is now: list it, move the
 * folders of pages that were renamed or moved, remove those of pages that
 * went, and fetch the documents edited since their copy (all with `force`).
 * A page that cannot be fetched keeps the copy it had and is reported.
 */
export async function mirrorFeishuTree(
  dataDir: string,
  client: LarkCli,
  root: WikiTreeRoot,
  dest: string,
  opts: { force?: boolean; onProgress?: (m: string) => void; pages?: WikiTreePage[] } = {},
): Promise<FeishuTreeResult> {
  const progress = opts.onProgress ?? (() => {});
  const destAbs = safePath(dataDir, dest);
  const pages = opts.pages ?? (await listWikiTree(client, root));
  const previous = readTreeManifest(dataDir, dest);
  const placed = placePages(pages, previous, root.node?.nodeToken ?? null);
  const byToken = new Map(pages.map((p) => [p.nodeToken, p]));
  fs.mkdirSync(destAbs, { recursive: true });

  const written: string[] = [];
  const removed: string[] = [];
  const warnings: string[] = [];

  // pages that moved or went: their own files go through a hidden folder
  // first, so a page taking a folder another one just left never meets its files
  const staging = path.join(destAbs, `.moving-${process.pid}`);
  const moving: { token: string; from: string; to: string; files: string[] }[] = [];
  let removedPages = 0;
  for (const [token, before] of Object.entries(previous?.nodes ?? {})) {
    if (!isMirroredPage(before)) continue;
    const from = folderOf(previous!.nodes, token);
    const now = byToken.get(token);
    const to = now && isMirroredPage(now) ? folderOf(placed, token) : null;
    if (to === from) continue;
    const files = ownFiles(path.join(destAbs, from));
    if (to === null) {
      removedPages++;
      for (const rel of files) {
        fs.rmSync(path.join(destAbs, from, rel), { force: true });
        if (!rel.startsWith('.')) removed.push(join(dest, from, rel));
      }
      continue;
    }
    moving.push({ token, from, to, files });
    for (const rel of files) {
      const abs = path.join(staging, token, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.renameSync(path.join(destAbs, from, rel), abs);
    }
  }
  try {
    // the sidecars too, so the moved files keep their conversions and extractions
    const sidecar = (key: string) => safePath(dataDir, sidecarRelFor(key));
    const visible = (m: (typeof moving)[number]) => m.files.filter((rel) => !rel.split('/').some((s) => s.startsWith('.')));
    for (const m of moving) {
      for (const rel of visible(m)) {
        const src = sidecar(join(dest, m.from, rel));
        if (!fs.existsSync(src)) continue;
        const tmp = sidecar(join(dest, `.moving-${process.pid}`, m.token, rel));
        fs.mkdirSync(path.dirname(tmp), { recursive: true });
        fs.renameSync(src, tmp);
      }
    }
    for (const m of moving) {
      for (const rel of m.files) {
        const abs = path.join(destAbs, m.to, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.renameSync(path.join(staging, m.token, rel), abs);
      }
      for (const rel of visible(m)) {
        const tmp = sidecar(join(dest, `.moving-${process.pid}`, m.token, rel));
        if (!fs.existsSync(tmp)) continue;
        const dst = sidecar(join(dest, m.to, rel));
        fs.rmSync(dst, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(tmp, dst);
      }
      for (const rel of visible(m)) {
        removed.push(join(dest, m.from, rel));
        written.push(join(dest, m.to, rel));
      }
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(safePath(dataDir, sidecarRelFor(join(dest, `.moving-${process.pid}`))), { recursive: true, force: true });
  }
  if (moving.length) progress(`feishu ${dest}: ${moving.length} page(s) moved to follow the wiki`);

  let fetched = 0;
  let images = 0;
  let attachments = 0;
  const keptInFeishu: { title: string; type: string }[] = [];
  const documents = pages.filter(isMirroredPage);
  for (const page of pages) {
    if (!isMirroredPage(page)) {
      keptInFeishu.push({ title: page.title, type: page.nodeType === 'shortcut' ? 'shortcut' : page.objType });
      continue;
    }
    const folder = folderOf(placed, page.nodeToken);
    const pageDest = join(dest, folder);
    const pageAbs = path.join(destAbs, folder);
    let manifest = readManifest(dataDir, pageDest);
    // a renamed page's Markdown follows its title, its sidecar along with it
    const file = `${segmentName(page.title, 'document')}.md`;
    if (manifest && manifest.file !== file && isFile(path.join(pageAbs, manifest.file)) && !fs.existsSync(path.join(pageAbs, file))) {
      fs.renameSync(path.join(pageAbs, manifest.file), path.join(pageAbs, file));
      const src = safePath(dataDir, sidecarRelFor(join(pageDest, manifest.file)));
      if (fs.existsSync(src)) {
        const dst = safePath(dataDir, sidecarRelFor(join(pageDest, file)));
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(src, dst);
      }
      removed.push(join(pageDest, manifest.file));
      written.push(join(pageDest, file));
      manifest = { ...manifest, file };
      writeIfChanged(path.join(pageAbs, FEISHU_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    }
    const current = manifest && page.editedAt && manifest.modifiedAt === page.editedAt && !manifest.failed && isFile(path.join(pageAbs, manifest.file));
    if (current && !opts.force) {
      const media = Object.values(manifest!.media);
      images += media.filter((rel) => rel.startsWith('assets/')).length;
      attachments += media.filter((rel) => rel.startsWith('files/')).length;
      continue;
    }
    const target: FeishuTarget = {
      ref: { kind: 'wiki', token: page.nodeToken, host: root.host },
      token: page.objToken,
      type: 'docx',
      url: page.url,
      title: page.title || page.objToken,
      modifiedAt: page.editedAt,
      ownerId: null,
      wiki: page.nodeToken,
    };
    try {
      progress(`feishu ${dest}: fetching ${page.title || page.objToken} (${fetched + 1})`);
      const mirrored = await mirrorFeishuDocument(dataDir, client, target, pageDest, { ownOnly: true, file });
      fetched++;
      written.push(...mirrored.written);
      removed.push(...mirrored.removed);
      images += mirrored.images;
      attachments += mirrored.attachments;
      warnings.push(...mirrored.warnings.map((w) => `${page.title}: ${w}`));
    } catch (err) {
      // the copy it had stays; the next pass tries again
      warnings.push(`${page.title || page.objToken}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  pruneEmptyDirs(destAbs);

  const manifest: FeishuTreeManifest = {
    kind: 'wiki-tree',
    spaceId: root.spaceId,
    root: root.node?.nodeToken ?? null,
    url: root.url,
    title: root.title,
    nodes: Object.fromEntries([...placed].map(([token, page]) => [token, page])),
  };
  writeIfChanged(path.join(destAbs, FEISHU_TREE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    dest,
    title: root.title,
    url: root.url,
    pages: pages.length,
    documents: documents.length,
    fetched,
    moved: moving.length,
    removedPages,
    keptInFeishu,
    written,
    removed,
    images,
    attachments,
    warnings,
  };
}
