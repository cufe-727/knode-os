import path from 'node:path';
import { openZip, ZipArchive } from '../../fs/zip.js';
import type { ConverterInput, DocumentConverterPlugin } from '../../plugins/types.js';
import { LANGUAGES, normalizeLanguage } from '../../lang/languages.js';
import { elementToMarkdown, HtmlElement, HtmlNode, htmlToMarkdown, parseHtml } from './html.js';
import { ConversionResult, withProvenance } from './shared.js';

/**
 * The built-in EPUB converter: a book becomes one Markdown text, its chapters
 * in reading order, for search and for reading in the file view.
 *
 * An EPUB is a zip of XHTML chapters with a package document (OPF) that names
 * them in order (the spine), says what the book is (title, authors, language,
 * publisher, date, ISBN) and points at its table of contents — an EPUB 3 nav
 * document or an EPUB 2 NCX. Each chapter goes through the HTML converter in
 * its book mode (`whole`: nothing is chrome in a book). On the way:
 *
 *   - the table of contents gives each chapter its title and its depth: a
 *     chapter that opens without a heading gets one from its entry, and a
 *     chapter's own headings are moved to the depth its entry has, so the
 *     outline reads Part › Chapter › Section whatever levels the file used;
 *   - a note the text refers to in the same chapter (`epub:type="noteref"`,
 *     a Duokan pop-up note, a calibre footnote with its back-link) becomes a
 *     GFM footnote, `[^12.3]`, its text after the chapter;
 *   - a picture keeps its path inside the book, `![](OEBPS/images/fig1.jpg)`:
 *     read relative to the book, as if the .epub were a folder, which is how
 *     the file view and `GET /api/file/original` find it
 *     (`raw/docs/x.epub/OEBPS/images/fig1.jpg`), without a copy on disk;
 *   - links to other places in the book keep their words, links out of it
 *     stay links; a page that is mostly links into the book (its printed
 *     table of contents, an index) is left out.
 *
 * Only the chapters are read and inflated, never the pictures, so a photo
 * book of 170 MB costs what its text does (`maxBytes` is set to match).
 * A zip whose directory was cut off is read from its local headers. DRM
 * (an encrypted chapter) is refused with a message saying so.
 */

const posix = path.posix;

export function isEpubFile(file: string): boolean {
  return path.extname(file).toLowerCase() === '.epub';
}

/** EPUBs up to this size are converted: what is read is the chapters, not the pictures. */
export const MAX_EPUB_BYTES = 512 * 1024 * 1024;

/** One chapter file is never read past this (a sane chapter is well under a megabyte). */
const MAX_CHAPTER_BYTES = 16 * 1024 * 1024;

/** A picture inside a book, by extension: what `pictureEntry` may hand out. */
export const EPUB_PICTURE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

/** Marks a heading the table of contents supplied, until its level is settled. */
const TOC_HEADING = '\u0003';

/* ─────────────────────────────── the tree ────────────────────────────── */

const isEl = (n: HtmlNode | undefined): n is HtmlElement => n !== undefined && typeof n !== 'string';

/** `dc:title` → `title`, `opf:item` → `item`. */
const local = (name: string) => name.slice(name.lastIndexOf(':') + 1);

function walk(el: HtmlElement, visit: (e: HtmlElement) => boolean | void): void {
  for (const c of el.children) {
    if (!isEl(c)) continue;
    if (visit(c) === false) continue;
    walk(c, visit);
  }
}

function findAll(el: HtmlElement, pred: (e: HtmlElement) => boolean): HtmlElement[] {
  const out: HtmlElement[] = [];
  walk(el, (e) => {
    if (pred(e)) out.push(e);
  });
  return out;
}

function findFirst(el: HtmlElement, pred: (e: HtmlElement) => boolean): HtmlElement | null {
  for (const c of el.children) {
    if (!isEl(c)) continue;
    if (pred(c)) return c;
    const hit = findFirst(c, pred);
    if (hit) return hit;
  }
  return null;
}

/** The words of a subtree, whitespace collapsed. */
function textOf(n: HtmlNode): string {
  const parts: string[] = [];
  const visit = (x: HtmlNode) => {
    if (typeof x === 'string') parts.push(x);
    else if (!['script', 'style', 'head'].includes(x.name)) x.children.forEach(visit);
  };
  visit(n);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/** What a title compares as: case, spaces, punctuation and width set aside. */
const comparable = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

/** `epub:type` and the matching ARIA `doc-` roles, as one list. */
function semantics(el: HtmlElement): string[] {
  const types = (el.attrs['epub:type'] ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const role = (el.attrs.role ?? '').toLowerCase();
  return role.startsWith('doc-') ? [...types, role.slice(4)] : types;
}

function detach(el: HtmlElement): void {
  if (!el.parent) return;
  const i = el.parent.children.indexOf(el);
  if (i >= 0) el.parent.children.splice(i, 1);
  el.parent = null;
}

function replaceWith(el: HtmlElement, node: HtmlNode): void {
  const parent = el.parent;
  if (!parent) return;
  const i = parent.children.indexOf(el);
  if (i < 0) return;
  parent.children[i] = node;
  if (isEl(node)) node.parent = parent;
}

const BLOCKS = new Set(['p', 'div', 'li', 'aside', 'section', 'article', 'blockquote', 'dd', 'dt', 'td', 'th', 'figure', 'header', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'body']);
const isHeading = (el: HtmlElement) => /^h[1-6]$/.test(el.name);

/** The block an element sits in (itself when it is one). */
function blockOf(el: HtmlElement): HtmlElement {
  let at: HtmlElement | null = el;
  while (at && !BLOCKS.has(at.name)) at = at.parent;
  return at ?? el;
}

/** The first words in reading order under `el`, as the text node's parent. */
function firstWords(el: HtmlElement): HtmlElement | null {
  for (const c of el.children) {
    if (typeof c === 'string') {
      if (c.trim()) return el;
      continue;
    }
    if (['script', 'style', 'head', 'title'].includes(c.name)) continue;
    const hit = firstWords(c);
    if (hit) return hit;
  }
  return null;
}

const within = (el: HtmlElement, ancestor: HtmlElement) => {
  for (let at: HtmlElement | null = el; at; at = at.parent) if (at === ancestor) return true;
  return false;
};

const inHeading = (el: HtmlElement) => {
  for (let at: HtmlElement | null = el; at; at = at.parent) if (isHeading(at)) return true;
  return false;
};

/** Hidden where it stands, or inside something hidden. */
function hiddenWithin(el: HtmlElement): boolean {
  for (let at: HtmlElement | null = el; at; at = at.parent) {
    if ('hidden' in at.attrs || (at.attrs['aria-hidden'] ?? '').toLowerCase() === 'true') return true;
    const style = (at.attrs.style ?? '').toLowerCase().replace(/\s+/g, '');
    if (style.includes('display:none') || style.includes('visibility:hidden')) return true;
  }
  return false;
}

/** Whether any words come before `target` in reading order (true when it is not under `root` at all). */
function wordsBefore(root: HtmlElement, target: HtmlElement): boolean {
  let found = false;
  let words = false;
  const visit = (el: HtmlElement) => {
    for (const c of el.children) {
      if (found) return;
      if (typeof c === 'string') {
        if (c.trim()) words = true;
        continue;
      }
      if (c === target) {
        found = true;
        return;
      }
      if (!['script', 'style', 'head', 'title'].includes(c.name)) visit(c);
    }
  };
  visit(root);
  return found ? words : true;
}

/** What a note says, inside the wrappers it came in: `aside > ol > li` is the `li`. */
function noteBody(el: HtmlElement): HtmlElement {
  let at = el;
  for (;;) {
    const kids = at.children.filter((c) => isEl(c) || c.trim());
    const only = kids.length === 1 ? kids[0] : undefined;
    if (!isEl(only) || !['ol', 'ul', 'li', 'div', 'section', 'aside'].includes(only.name)) return at;
    at = only;
  }
}

/* ─────────────────────────────── paths ───────────────────────────────── */

function decodePart(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Where an href inside the book points: the entry and its fragment; null for an address outside the book. */
export function resolveInBook(from: string, href: string): { file: string; fragment: string | null } | null {
  const raw = href.trim();
  if (!raw || /^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith('//')) return null;
  const hash = raw.indexOf('#');
  const target = decodePart(hash >= 0 ? raw.slice(0, hash) : raw).split('?')[0];
  const fragment = hash >= 0 ? decodePart(raw.slice(hash + 1)) || null : null;
  if (!target) return { file: from, fragment };
  const joined = target.startsWith('/') ? target.slice(1) : posix.join(posix.dirname(from), target);
  const file = posix.normalize(joined);
  if (file === '..' || file.startsWith('../') || file === '.') return null;
  return { file, fragment };
}

/** An entry path as a Markdown link target: each part escaped, parentheses too. */
export function entryHref(entry: string): string {
  return entry
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

/**
 * A path through a book to a file inside it — `raw/docs/x.epub/OEBPS/a.jpg`
 * — split at the book. Null when the path does not go through an .epub.
 */
export function splitBookPath(rel: string): { book: string; entry: string } | null {
  const m = /^(.+?\.epub)\/(.+)$/i.exec(rel.replace(/\\/g, '/'));
  if (!m) return null;
  const entry = posix.normalize(m[2]);
  if (!entry || entry === '.' || entry === '..' || entry.startsWith('../') || entry.startsWith('/')) return null;
  return { book: m[1], entry };
}

/** A picture inside a book, for `GET /api/file/original`; throws when the book has no such picture. */
export function pictureEntry(absBook: string, entry: string): { bytes: Buffer; type: string } {
  const type = EPUB_PICTURE_TYPES[posix.extname(entry).toLowerCase()];
  if (!type) throw new Error(`${entry} is not a picture`);
  const zip = openZip(absBook);
  try {
    const found = zip.find(entry);
    if (!found) throw new Error(`the book has no ${entry}`);
    return { bytes: zip.read(found), type };
  } finally {
    zip.close();
  }
}

/* ───────────────────────────── the package ───────────────────────────── */

interface ManifestItem {
  id: string;
  /** Entry path inside the zip. */
  href: string;
  mediaType: string;
  properties: string[];
}

interface TocEntry {
  label: string;
  file: string;
  fragment: string | null;
  depth: number;
}

export interface EpubMeta {
  title: string | null;
  authors: string[];
  language: string | null;
  publisher: string | null;
  published: string | null;
  isbn: string | null;
  description: string | null;
  subjects: string[];
}

export interface EpubPackage {
  opf: string;
  meta: EpubMeta;
  manifest: Map<string, ManifestItem>;
  spine: { item: ManifestItem; linear: boolean }[];
  /** The package had no spine: `spine` is the manifest's pages in its order. */
  unordered: boolean;
  toc: TocEntry[];
  cover: string | null;
  /** Entries listed as encrypted (META-INF/encryption.xml): fonts are, under font obfuscation; a chapter is under DRM. */
  encrypted: Set<string>;
}

/**
 * Decode an XML or XHTML entry: a byte-order mark, else the XML
 * declaration's encoding, else a `<meta charset>`, else UTF-8.
 */
export function decodeXml(bytes: Buffer): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8');
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  const head = bytes.subarray(0, 2048).toString('latin1');
  const label = (/^\s*<\?xml[^>]*?\bencoding\s*=\s*["']([\w.:-]+)/i.exec(head)?.[1] ?? /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1])?.toLowerCase();
  if (label && label !== 'utf-8' && label !== 'utf8') {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // an encoding this Node does not know: read it as UTF-8
    }
  }
  return bytes.toString('utf8');
}

function readText(zip: ZipArchive, entry: string): string | null {
  const found = zip.find(entry);
  return found ? decodeXml(zip.read(found, MAX_CHAPTER_BYTES)) : null;
}

/** `2018-03-06T00:00:00+00:00` → `2018-03-06`; calibre's "unknown" (year 0101) and other junk → null. */
function bookDate(raw: string): string | null {
  const m = /^\s*(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(raw);
  if (!m || Number(m[1]) < 1000) return null;
  return [m[1], m[2], m[3]].filter(Boolean).join('-');
}

/** ISO 639-2 codes some packages use, for the languages knode-os names. */
const THREE_LETTER: Record<string, string> = {
  eng: 'en', zho: 'zh', chi: 'zh', jpn: 'ja', kor: 'ko', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', spa: 'es', por: 'pt', ita: 'it', rus: 'ru',
};

/** `en-US` → `en`, `eng` → `en`, a language written as its name (`Chinese`) → its code; `und` → null; anything else as written. */
function languageCode(raw: string): string | null {
  const code = normalizeLanguage(raw);
  if (code) return code;
  const name = raw.trim().toLowerCase();
  if (!name || name === 'und') return null;
  if (THREE_LETTER[name.split('-')[0]]) return THREE_LETTER[name.split('-')[0]];
  const named = LANGUAGES.find((l) => [l.english, l.native, l.prompt].some((n) => n.toLowerCase() === name || n.toLowerCase().split(' (')[0] === name));
  return named?.code ?? raw.trim();
}

function isbnOf(id: HtmlElement): string | null {
  const text = textOf(id);
  const scheme = (id.attrs['opf:scheme'] ?? id.attrs.scheme ?? '').toLowerCase();
  const digits = text.replace(/^urn:isbn:/i, '').replace(/[\s-]/g, '');
  if (scheme === 'isbn' || /^urn:isbn:/i.test(text)) return /^(?:\d{9}[\dXx]|\d{13})$/.test(digits) ? digits : null;
  return /^97[89]\d{10}$/.test(digits) ? digits : null;
}

/** An EPUB 3 `<meta refines property>value</meta>`: the parser reads `meta` as empty, so its value is the text after it. */
function metaValue(el: HtmlElement): string {
  if (el.attrs.content) return el.attrs.content.trim();
  const parent = el.parent;
  const next = parent ? parent.children[parent.children.indexOf(el) + 1] : undefined;
  return typeof next === 'string' ? next.trim() : '';
}

function readMeta(metadata: HtmlElement | null): EpubMeta {
  const dc = (name: string) => (metadata ? findAll(metadata, (e) => local(e.name) === name) : []);
  const metas = metadata ? findAll(metadata, (e) => local(e.name) === 'meta') : [];
  const refined = (id: string | undefined, property: string) =>
    id ? metas.find((m) => m.attrs.refines === `#${id}` && m.attrs.property === property) : undefined;
  const creators = dc('creator').map((c) => ({
    name: textOf(c),
    role: (c.attrs['opf:role'] ?? (refined(c.attrs.id, 'role') ? metaValue(refined(c.attrs.id, 'role')!) : '')).toLowerCase(),
  })).filter((c) => c.name);
  const authors = creators.some((c) => c.role === 'aut' || !c.role) ? creators.filter((c) => c.role === 'aut' || !c.role) : creators;
  const dates = dc('date');
  const published = dates.find((d) => /publication/i.test(d.attrs['opf:event'] ?? '') && bookDate(textOf(d)))
    ?? dates.find((d) => !d.attrs['opf:event'] && bookDate(textOf(d)))
    ?? dates.find((d) => bookDate(textOf(d)));
  // a description is often HTML written as text: read it as such, a paragraph's end a space
  const rawDescription = dc('description').map(textOf).find(Boolean) ?? null;
  const description = rawDescription ? textOf(parseHtml(rawDescription.replace(/<\/(?:p|div|li|h[1-6])\s*>|<br\s*\/?>/gi, ' $&'))) : null;
  const language = dc('language').map(textOf).find(Boolean) ?? null;
  return {
    title: dc('title').map(textOf).find(Boolean) ?? null,
    authors: [...new Set(authors.map((a) => a.name))],
    language: language ? languageCode(language) : null,
    publisher: dc('publisher').map(textOf).find(Boolean) ?? null,
    published: published ? bookDate(textOf(published)) : null,
    isbn: dc('identifier').map(isbnOf).find(Boolean) ?? null,
    description: description ? (description.length > 600 ? `${description.slice(0, 599).trimEnd()}…` : description) : null,
    subjects: [...new Set(dc('subject').map(textOf).filter(Boolean))],
  };
}

function navToc(zip: ZipArchive, nav: ManifestItem): TocEntry[] {
  const text = readText(zip, nav.href);
  if (!text) return [];
  const root = parseHtml(text);
  const navs = findAll(root, (e) => e.name === 'nav');
  const toc = navs.find((n) => semantics(n).includes('toc')) ?? navs[0];
  const list = toc ? findFirst(toc, (e) => e.name === 'ol' || e.name === 'ul') : null;
  const out: TocEntry[] = [];
  const visit = (ol: HtmlElement, depth: number) => {
    for (const li of ol.children) {
      if (!isEl(li) || li.name !== 'li') continue;
      const head = li.children.find((c): c is HtmlElement => isEl(c) && (c.name === 'a' || c.name === 'span'));
      const label = head ? textOf(head) : '';
      const at = head?.attrs.href ? resolveInBook(nav.href, head.attrs.href) : null;
      if (label && at) out.push({ label, file: at.file, fragment: at.fragment, depth });
      for (const sub of li.children) if (isEl(sub) && (sub.name === 'ol' || sub.name === 'ul')) visit(sub, depth + 1);
    }
  };
  if (list) visit(list, 1);
  return out;
}

function ncxToc(zip: ZipArchive, ncx: ManifestItem): TocEntry[] {
  const text = readText(zip, ncx.href);
  if (!text) return [];
  const root = parseHtml(text);
  const map = findFirst(root, (e) => local(e.name) === 'navmap');
  const out: TocEntry[] = [];
  const visit = (el: HtmlElement, depth: number) => {
    for (const point of el.children) {
      if (!isEl(point) || local(point.name) !== 'navpoint') continue;
      const labelEl = point.children.find((c): c is HtmlElement => isEl(c) && local(c.name) === 'navlabel');
      const content = point.children.find((c): c is HtmlElement => isEl(c) && local(c.name) === 'content');
      const label = labelEl ? textOf(labelEl) : '';
      const at = content?.attrs.src ? resolveInBook(ncx.href, content.attrs.src) : null;
      if (label && at) out.push({ label, file: at.file, fragment: at.fragment, depth });
      visit(point, depth + 1);
    }
  };
  if (map) visit(map, 1);
  return out;
}

export function readPackage(zip: ZipArchive): EpubPackage {
  const container = readText(zip, 'META-INF/container.xml');
  const rootfiles = container ? findAll(parseHtml(container), (e) => local(e.name) === 'rootfile') : [];
  const named = rootfiles.find((r) => (r.attrs['media-type'] ?? '') === 'application/oebps-package+xml') ?? rootfiles[0];
  const opf = named?.attrs['full-path'] ? posix.normalize(decodePart(named.attrs['full-path'])) : [...zip.entries.keys()].find((n) => /\.opf$/i.test(n));
  if (!opf) throw new Error('no package document (container.xml names none, and there is no .opf)');
  const opfText = readText(zip, opf);
  if (opfText === null) throw new Error(`the package document ${opf} is missing`);
  const root = parseHtml(opfText);
  const pkg = findFirst(root, (e) => local(e.name) === 'package') ?? root;
  const manifest = new Map<string, ManifestItem>();
  for (const item of findAll(pkg, (e) => local(e.name) === 'item')) {
    const id = item.attrs.id;
    const at = item.attrs.href ? resolveInBook(opf, item.attrs.href) : null;
    if (!id || !at) continue;
    manifest.set(id, {
      id,
      href: at.file,
      mediaType: (item.attrs['media-type'] ?? '').toLowerCase(),
      properties: (item.attrs.properties ?? '').toLowerCase().split(/\s+/).filter(Boolean),
    });
  }
  const spineEl = findFirst(pkg, (e) => local(e.name) === 'spine');
  const items = [...manifest.values()];
  let spine = (spineEl ? findAll(spineEl, (e) => local(e.name) === 'itemref') : [])
    .map((ref) => ({ item: manifest.get(ref.attrs.idref ?? ''), linear: (ref.attrs.linear ?? 'yes').toLowerCase() !== 'no' }))
    .filter((s): s is { item: ManifestItem; linear: boolean } => Boolean(s.item));
  // no reading order: the manifest's pages, in the order it lists them
  const unordered = spine.length === 0;
  if (unordered) spine = items.filter((i) => /html/.test(i.mediaType) && !i.properties.includes('nav')).map((item) => ({ item, linear: true }));
  const nav = items.find((i) => i.properties.includes('nav'));
  const ncx = manifest.get(spineEl?.attrs.toc ?? '') ?? items.find((i) => i.mediaType === 'application/x-dtbncx+xml');
  let toc = nav ? navToc(zip, nav) : [];
  if (toc.length === 0 && ncx) toc = ncxToc(zip, ncx);
  const metadata = findFirst(pkg, (e) => local(e.name) === 'metadata');
  const coverId = metadata ? findAll(metadata, (e) => local(e.name) === 'meta' && e.attrs.name === 'cover')[0]?.attrs.content : undefined;
  // EPUB 2 names the cover's manifest id; some books write its path there instead
  const cover = items.find((i) => i.properties.includes('cover-image'))?.href
    ?? (coverId ? manifest.get(coverId)?.href ?? resolveInBook(opf, coverId)?.file : undefined)
    ?? null;
  const encryption = readText(zip, 'META-INF/encryption.xml');
  const encrypted = new Set(
    encryption
      ? findAll(parseHtml(encryption), (e) => local(e.name) === 'cipherreference').map((r) => posix.normalize(decodePart(r.attrs.uri ?? ''))).filter(Boolean)
      : [],
  );
  return { opf, meta: readMeta(metadata), manifest, spine, unordered, toc, cover, encrypted };
}

/* ─────────────────────────────── chapters ────────────────────────────── */

const isChapterType = (t: string, href: string) =>
  t === 'application/xhtml+xml' || t === 'text/html' || ((t === '' || t === 'application/xml' || t === 'text/xml') && /\.(?:x?html?|xml)$/i.test(href));
const isPictureType = (t: string) => /^image\//.test(t);

/** Alt text that says nothing: "image", "cover", a file name, a number. */
const EMPTY_ALT = /^(?:(?:image|img|picture|pic|photo|figure|fig|cover|illustration|graphic|logo|图片?|插图|封面|图像|照片)[\s._-]*\d*|[\w.-]+\.(?:jpe?g|png|gif|svg|webp|bmp)|\d+)$/i;

/** Notes: what a reference points at, when the two are a note and its marker. */
const NOTE_TYPES = new Set(['footnote', 'endnote', 'rearnote', 'note', 'footnotes', 'endnotes', 'rearnotes']);
const NOTE_CLASS = /(?:^|[\s_-])(?:foot|end)?notes?(?:$|[\s_-])|footnote|endnote|duokan-footnote/i;

interface ChapterResult {
  markdown: string;
  /** Mostly links into the book: a printed table of contents or an index. */
  navigation: boolean;
  /** The depth of the headings the table of contents gave the chapter's start; null when it had its own. */
  titleDepth: number | null;
}

/**
 * One chapter's Markdown: its notes as footnotes, a heading from the table of
 * contents where it opens without one, pictures and links resolved in the book.
 */
function renderChapter(xhtml: string, file: string, chapter: number, entries: TocEntry[], zip: ZipArchive, boldHeadings: boolean): ChapterResult {
  const resolveUrl = (url: string, kind: 'a' | 'img'): string | null => {
    const u = url.trim();
    if (/^(?:https?|mailto):/i.test(u)) return kind === 'a' || /^https?:/i.test(u) ? u : null;
    const at = resolveInBook(file, u);
    if (!at) return null;
    if (kind === 'a') return null; // another place in the book: its words are enough
    const found = zip.find(at.file);
    return found ? entryHref(found.name) : null;
  };
  const notes: { label: string; body: string }[] = [];
  let navigation = false;
  let titleDepth: number | null = null;

  const prepare = (root: HtmlElement) => {
    const body = findFirst(root, (e) => e.name === 'body') ?? root;

    // a printed table of contents or an index: mostly words that link into the book (a scanned book's pages are pictures, kept)
    const total = textOf(body).replace(/\s/g, '').length;
    const internal = findAll(body, (e) => e.name === 'a' && Boolean(e.attrs.href) && resolveInBook(file, e.attrs.href) !== null);
    const linked = internal.reduce((n, a) => n + textOf(a).replace(/\s/g, '').length, 0);
    const pictures = findAll(body, (e) => e.name === 'img' || e.name === 'svg').length;
    if (internal.length >= 5 && total > 0 && linked / total >= 0.6 && pictures < 3) {
      navigation = true;
      return;
    }

    // navigation and printed page numbers are not the text
    for (const el of findAll(body, (e) => e.name === 'nav' || semantics(e).includes('pagebreak'))) detach(el);

    // a cover or a plate drawn as SVG around one picture
    for (const svg of findAll(body, (e) => e.name === 'svg')) {
      const image = findFirst(svg, (e) => local(e.name) === 'image');
      const src = image?.attrs['xlink:href'] ?? image?.attrs.href;
      if (src) replaceWith(svg, { name: 'img', attrs: { src, alt: '' }, children: [], parent: null });
    }
    for (const img of findAll(body, (e) => e.name === 'img')) {
      if (EMPTY_ALT.test((img.attrs.alt ?? '').trim())) img.attrs.alt = '';
    }

    // notes the chapter points at: [^chapter.n] where the marker was, the note after the chapter
    const byId = new Map<string, HtmlElement>();
    walk(body, (e) => {
      const id = e.attrs.id ?? (e.name === 'a' ? e.attrs.name : undefined);
      if (id && !byId.has(id)) byId.set(id, e);
    });
    const refIds = new Set<string>();
    const refs: { a: HtmlElement; target: HtmlElement }[] = [];
    for (const a of findAll(body, (e) => e.name === 'a' && Boolean(e.attrs.href))) {
      const at = resolveInBook(file, a.attrs.href);
      if (!at || at.file !== file || !at.fragment) continue;
      const target = byId.get(at.fragment);
      if (!target || within(a, target) || within(target, a)) continue;
      // a marker is seen: a hidden run of links to every note (some books carry one for reading systems) marks nothing
      if (hiddenWithin(a) || (!textOf(a) && !findFirst(a, (e) => e.name === 'img'))) continue;
      const marker = semantics(a).includes('noteref') || /duokan-footnote|noteref|footnote-?ref/i.test(a.attrs.class ?? '');
      const note = blockOf(target);
      const typed = [target, note].some((t) => semantics(t).some((s) => NOTE_TYPES.has(s)) || NOTE_CLASS.test(t.attrs.class ?? ''))
        || (note.parent !== null && semantics(note.parent).some((s) => NOTE_TYPES.has(s)));
      const ownId = a.attrs.id ?? (a.parent?.name === 'sup' ? a.parent.attrs.id : undefined);
      const backLinked = ownId !== undefined && findAll(note, (e) => e.name === 'a' && (e.attrs.href ?? '').endsWith(`#${ownId}`)).length > 0;
      if (!marker && !typed && !backLinked) continue;
      if (note === body || isHeading(note) || (!textOf(note) && !findFirst(note, (e) => e.name === 'img'))) continue;
      if (ownId) refIds.add(ownId);
      refs.push({ a, target: note });
    }
    const pending = new Map<HtmlElement, { label: string; marker: string; holders: HtmlElement[] }>();
    for (const { a, target } of refs) {
      let entry = pending.get(target);
      if (!entry) {
        entry = { label: `${chapter}.${pending.size + 1}`, marker: textOf(a), holders: [] };
        pending.set(target, entry);
      }
      // the marker, with the <sup> it sits alone in, held in a span until the note is known to say something
      const holder = a.parent && a.parent.name === 'sup' && a.parent.children.filter((c) => isEl(c) || c.trim()).length === 1 ? a.parent : a;
      const span: HtmlElement = { name: 'span', attrs: {}, children: [`[^${entry.label}]`], parent: null };
      replaceWith(holder, span);
      entry.holders.push(span);
      span.attrs['data-marker'] = textOf(holder);
    }
    for (const [note, { label, marker, holders }] of pending) {
      // the way back to the text is no part of the note
      for (const back of findAll(note, (e) => e.name === 'a' && Boolean(e.attrs.href))) {
        const at = resolveInBook(file, back.attrs.href);
        if (at?.file === file && at.fragment && (refIds.has(at.fragment) || !textOf(back) || /^[↩↑⏎^]+$|^返回$/.test(textOf(back)))) detach(back);
      }
      detach(note);
      let text = elementToMarkdown(noteBody(note), { resolveUrl }).replace(/\s*\n+\s*/g, ' ').trim();
      // the note's own number, written again before its text
      const number = marker.replace(/[[\]()]/g, '').trim();
      if (number) text = text.replace(new RegExp(`^[\\[(]?${number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\])]?[.、:：)]?\\s+`), '');
      if (text) notes.push({ label, body: text });
      // a note that says nothing leaves its marker as it was written
      else for (const span of holders) span.children = [span.attrs['data-marker'] ?? ''];
    }

    // a title from the table of contents where the chapter, or a part of it, opens without one
    const synthetic = (depth: number, label: string): HtmlElement => ({ name: `h${Math.min(6, depth)}`, attrs: {}, children: [TOC_HEADING + label], parent: null });
    /** Before `el` in its parent; the body's own content when `el` is the body. */
    const insertBefore = (el: HtmlElement, heading: HtmlElement) => {
      const parent = el === body || !el.parent ? body : el.parent;
      const i = el === body ? 0 : Math.max(0, parent.children.indexOf(el));
      parent.children.splice(i, 0, heading);
      heading.parent = parent;
    };
    /** The words are there, not as a heading: they become it. */
    const titleAt = (block: HtmlElement, entry: TocEntry): boolean => {
      if (isHeading(block) || block === body || !comparable(entry.label) || comparable(textOf(block)) !== comparable(entry.label)) return false;
      block.name = `h${Math.min(6, entry.depth)}`;
      block.children.unshift(TOC_HEADING);
      return true;
    };
    const start = firstWords(body);
    const atStart = entries.filter((e) => {
      const target = e.fragment ? byId.get(e.fragment) : undefined;
      return !target || target === body || !wordsBefore(body, target);
    });
    if (start && !inHeading(start) && atStart.length) {
      titleDepth = Math.max(...atStart.map((e) => e.depth));
      const first = blockOf(start);
      if (!(atStart.length === 1 && titleAt(first, atStart[0]))) {
        // words straight in the body go after the headings too
        const before = first !== body ? first : start !== body ? start : body;
        for (const entry of atStart) insertBefore(before, synthetic(entry.depth, entry.label));
      }
    }
    for (const entry of entries) {
      if (atStart.includes(entry) || !entry.fragment) continue;
      const target = byId.get(entry.fragment);
      if (!target || !target.parent) continue;
      const block = blockOf(target);
      const at = block === body ? target : block;
      const words = firstWords(at);
      if (isHeading(at) || (words && inHeading(words))) continue;
      // the heading may follow the anchor rather than hold it
      const siblings = at.parent?.children ?? [];
      const next = siblings.slice(siblings.indexOf(at) + 1).find((c): c is HtmlElement => isEl(c) && Boolean(textOf(c)));
      if (!textOf(at) && next && isHeading(next)) continue;
      if (titleAt(at, entry)) continue;
      insertBefore(at, synthetic(entry.depth, entry.label));
    }
  };

  const conv = htmlToMarkdown(xhtml, { whole: true, boldHeadings, resolveUrl, prepare });
  if (navigation) return { markdown: '', navigation, titleDepth };
  const defs = notes.map((n) => `[^${n.label}]: ${n.body}`);
  return { markdown: [conv.markdown, ...(defs.length ? [defs.join('\n')] : [])].filter(Boolean).join('\n\n'), navigation, titleDepth };
}

/**
 * Settle a chapter's heading levels: a heading from the table of contents
 * keeps its entry's depth; the chapter's own move together so the highest
 * stands at `base` (none move when there is no base to go by).
 */
function levelHeadings(markdown: string, base: number | null): string {
  const lines = markdown.split('\n');
  let fence = false;
  let min = Infinity;
  for (const line of lines) {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && /^(#{1,6}) (.)/.exec(line);
    if (m && m[2] !== TOC_HEADING) min = Math.min(min, m[1].length);
  }
  const shift = base === null || min === Infinity ? 0 : base - min;
  fence = false;
  return lines.map((line) => {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && /^(#{1,6}) ([\s\S]*)$/.exec(line);
    if (!m) return line;
    if (m[2].startsWith(TOC_HEADING)) return `${m[1]} ${m[2].slice(1).trim()}`;
    return `${'#'.repeat(Math.min(6, Math.max(1, m[1].length + shift)))} ${m[2]}`;
  }).join('\n').replace(NUMBER_HEADING, (_all, hashes: string, number: string, title: string) => `${hashes} ${joinTitle(number.trim(), title.trim())}`);
}

/**
 * A heading that is only the chapter's number, followed by its title at the
 * same level (`## 1` / `## The Surprising Power…`, `# 第一章` / `# 起源`):
 * one heading, so the outline reads one line per chapter.
 */
const NUMBER_HEADING = /^(#{1,6}) ((?:(?:chapter|part|book|section|lesson|step|day)\s+)?(?:\d{1,3}|[ivxlc]{1,7}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\.?|第[一二三四五六七八九十百零〇两\d]{1,5}[章节部篇卷回讲课])[ \t]*\n+\1 (?!\d{1,3}\.?\s*$)([^\n]+)$/gim;

function joinTitle(number: string, title: string): string {
  if (/^第/.test(number)) return `${number} ${title}`;
  return /^[\divxlc]+\.?$/i.test(number) ? `${number.replace(/\.$/, '')}. ${title}` : `${number}: ${title}`;
}

export interface EpubConversion {
  markdown: string;
  meta: EpubMeta;
  chapters: number;
  pictures: number;
  notes: number;
  warnings: string[];
}

/** A book's text, chapters in reading order (no frontmatter: `convertEpub` adds it). */
export function epubToMarkdown(zip: ZipArchive): EpubConversion {
  const pkg = readPackage(zip);
  const warnings: string[] = [];
  if (zip.recovered) warnings.push("the book's zip directory is missing or damaged; its chapters were read from the entries in order");
  if (pkg.spine.length === 0) throw new Error('the book lists no chapters');
  if (pkg.unordered) warnings.push('the book has no reading order (spine); its pages are in the order the package lists them');
  const tocByFile = new Map<string, TocEntry[]>();
  for (const entry of pkg.toc) {
    const key = zip.find(entry.file)?.name ?? entry.file;
    tocByFile.set(key, [...(tocByFile.get(key) ?? []), entry]);
  }
  const parts: string[] = [];
  const seen = new Set<string>();
  let lastDepth: number | null = null;
  let chapters = 0;
  for (const [i, { item }] of pkg.spine.entries()) {
    const found = zip.find(item.href);
    if (!found) {
      warnings.push(`${item.href} is in the reading order but not in the book`);
      continue;
    }
    if (seen.has(found.name)) continue;
    seen.add(found.name);
    if (pkg.encrypted.has(found.name)) {
      throw new Error(`the book is DRM-protected: ${found.name} is encrypted, and only a copy without DRM can be read`);
    }
    if (isPictureType(item.mediaType)) {
      parts.push(`![](${entryHref(found.name)})`);
      continue;
    }
    if (!isChapterType(item.mediaType, found.name)) continue;
    let xhtml: string;
    try {
      xhtml = decodeXml(zip.read(found, MAX_CHAPTER_BYTES));
    } catch (e) {
      warnings.push(`${found.name} could not be read: ${(e as Error).message}`);
      continue;
    }
    const entries = tocByFile.get(found.name) ?? [];
    // a table of contents of one entry ("Start") says nothing of the chapters: their bold title lines will have to
    const chapter = renderChapter(xhtml, found.name, i + 1, entries, zip, pkg.toc.length <= 1);
    const depths = entries.map((e) => e.depth);
    const entryDepth = depths.length ? Math.min(...depths) : null;
    // a printed table of contents or an index is left out: the headings are the book's contents
    if (!chapter.navigation && chapter.markdown.trim()) {
      // the chapter's own headings sit under a title the contents gave it, else at its entry's depth, else under the last entry
      const base = chapter.titleDepth !== null ? chapter.titleDepth + 1 : entryDepth ?? (lastDepth !== null ? lastDepth + 1 : null);
      parts.push(levelHeadings(chapter.markdown, base));
      chapters++;
    }
    if (depths.length) lastDepth = depths[depths.length - 1];
  }
  let markdown = parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  // a cover kept outside the reading order still opens the book
  if (pkg.cover) {
    const cover = zip.find(pkg.cover);
    if (cover && !markdown.includes(entryHref(cover.name))) markdown = `![${(pkg.meta.title ?? '').replace(/[[\]]/g, '')}](${entryHref(cover.name)})\n\n${markdown}`;
  }
  if (!markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim()) warnings.push('the book has no text, only pictures');
  return {
    markdown,
    meta: pkg.meta,
    chapters,
    pictures: (markdown.match(/!\[[^\]]*\]\(/g) ?? []).length,
    notes: (markdown.match(/^\[\^[^\]\s]+\]:/gm) ?? []).length,
    warnings,
  };
}

async function convertEpub(input: ConverterInput): Promise<ConversionResult> {
  let zip: ZipArchive;
  try {
    zip = openZip(input.absPath);
  } catch (e) {
    throw new Error(`not a readable EPUB (${(e as Error).message}): ${input.rel}`);
  }
  try {
    const book = epubToMarkdown(zip);
    const m = book.meta;
    const warningBlock = book.warnings.length ? `\n\n## Conversion warnings\n\n${book.warnings.map((w) => `- ${w}`).join('\n')}` : '';
    const markdown = withProvenance(input.rel, 'epub', 'knode-epub', (book.markdown || '_(the book has no readable text)_') + warningBlock, {
      title: m.title,
      author: m.authors.join(', '),
      lang: m.language,
      published: m.published,
      publisher: m.publisher,
      isbn: m.isbn,
      subject: m.subjects.join(', '),
      description: m.description,
    });
    return { markdown, kind: 'epub', model: 'knode-epub', warnings: book.warnings };
  } finally {
    zip.close();
  }
}

export const epubConverter: DocumentConverterPlugin = {
  id: 'epub',
  label: 'EPUB (chapters, notes and pictures)',
  extensions: ['.epub'],
  version: 1,
  usesVision: false,
  maxBytes: MAX_EPUB_BYTES,
  convert: convertEpub,
};
