import fs from 'node:fs';
import path from 'node:path';
import type { ConverterInput, DocumentConverterPlugin } from '../../plugins/types.js';
import { ConversionResult, withProvenance } from './shared.js';

/**
 * The built-in HTML converter: a saved web page, or an SEC filing, becomes
 * readable Markdown with the page's own title, dates and address in the
 * frontmatter. Without it a .html original is indexed as plain text — tags,
 * scripts, cookie banners and all.
 *
 * There is no DOM library to lean on, so this file carries a small tolerant
 * parser: a tokenizer feeding an element stack with the recovery rules real
 * pages depend on (implied end tags, end tags limited to their scope, a depth
 * cap), not the full HTML tree-construction algorithm. Rendering then picks
 * the main content, drops chrome and hidden parts, and writes Markdown in one
 * walk over the tree. Every large string is built from arrays: an EDGAR
 * prospectus is 3–10 MB of inline XBRL with tens of thousands of table rows.
 */

export interface HtmlMeta { title: string | null; description: string | null; author: string | null; published: string | null; modified: string | null; siteName: string | null; canonical: string | null; lang: string | null }
/** Where a saved page came from (written by the research capture service, read back by the converter). */
export interface HtmlCapture { url?: string; finalUrl?: string; fetched?: string; contentType?: string; charset?: string; sha256?: string; by?: string; study?: string; why?: string }
export interface HtmlConversion {
  markdown: string;            // body only, no frontmatter
  meta: HtmlMeta;
  outline: { level: number; text: string; line: number }[];  // headings of `markdown`, 1-based line numbers
  tables: number;
  links: number;
  warnings: string[];
}

const HTML_EXTENSIONS = ['.html', '.htm', '.xhtml'];

export function isHtmlFile(file: string): boolean {
  return HTML_EXTENSIONS.includes(path.extname(file).toLowerCase());
}

/* ─────────────────────────── capture record ─────────────────────────── */

const CAPTURE_KEYS = ['url', 'finalUrl', 'fetched', 'contentType', 'charset', 'sha256', 'by', 'study', 'why'] as const;

/**
 * One line `<!-- knode-capture: {json} -->\n` prepended to a saved page; JSON must not be able to contain "-->" (escape it).
 *
 * The JSON is kept to printable ASCII: `--` (which could end the comment, and
 * which an XML reader of an XHTML page rejects), `<`, `>` and every non-ASCII
 * character are written as \u escapes, so the line reads the same in any
 * charset that keeps ASCII as it is. Capture writes it, and the page after it,
 * as UTF-8 behind a BOM, which outranks a GBK or Shift_JIS page's own
 * `<meta charset>` in a browser and in `decodeSavedHtml`.
 */
export function captureComment(c: HtmlCapture): string {
  const record: Record<string, string> = {};
  for (const key of CAPTURE_KEYS) {
    const value = c[key];
    if (typeof value === 'string' && value) record[key] = value;
  }
  const json = JSON.stringify(record).replace(/--|[<>\u007f-￿]/g, (m) =>
    m === '--' ? '-\\u002d' : `\\u${m.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `<!-- knode-capture: ${json} -->\n`;
}

const CAPTURE_START = /<!--\s*knode-capture:\s*/;
const SAVED_FROM = /<!--\s*saved from url=\(\d+\)\s*(\S+?)\s*-->/i;

/** The capture record at the top of a saved page, or the browser's `<!-- saved from url=(0047)https://… -->` mark as { url }; null otherwise. Only looks at the first ~4 KB. */
export function readCaptureComment(html: string): HtmlCapture | null {
  const head = html.slice(0, 4096);
  const start = CAPTURE_START.exec(head);
  if (start) {
    // the record cannot contain "-->", so the first one after it closes the comment
    const from = start.index + start[0].length;
    const end = html.indexOf('-->', from);
    if (end > 0 && end - from < 65_536) {
      try {
        const parsed: unknown = JSON.parse(html.slice(from, end).trim());
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const out: HtmlCapture = {};
          for (const key of CAPTURE_KEYS) {
            const value = (parsed as Record<string, unknown>)[key];
            if (typeof value === 'string' && value) out[key] = value;
          }
          return out;
        }
      } catch {
        // a damaged record reads as no record; the browser's mark may still be there
      }
    }
  }
  // "about:internet" is what a browser writes for a page it did not download
  const saved = SAVED_FROM.exec(head);
  return saved && /^(?:https?|ftp):/i.test(saved[1]) ? { url: saved[1] } : null;
}

/* ────────────────────────────── entities ────────────────────────────── */

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  sbquo: '‚', bdquo: '„', lsaquo: '‹', rsaquo: '›', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥', cent: '¢', curren: '¤',
  sect: '§', para: '¶', middot: '·', bull: '•', deg: '°', plusmn: '±', times: '×', divide: '÷',
  minus: '−', le: '≤', ge: '≥', ne: '≠', permil: '‰', prime: '′', Prime: '″',
  dagger: '†', Dagger: '‡', larr: '←', rarr: '→', uarr: '↑', darr: '↓',
  frac12: '½', frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³', ordf: 'ª', ordm: 'º',
  not: '¬', macr: '¯', acute: '´', cedil: '¸', uml: '¨', brvbar: '¦',
  emsp: ' ', ensp: ' ', thinsp: ' ', zwnj: '‌', zwj: '‍', lrm: '‎', rlm: '‏', shy: '­',
  iexcl: '¡', iquest: '¿', micro: 'µ',
};
// the Latin-1 letters, U+00C0–U+00FF in order; '-' marks × and ÷, named above
'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml - Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml - oslash ugrave uacute ucirc uuml yacute thorn yuml'
  .split(' ')
  .forEach((name, i) => {
    if (name !== '-') NAMED_ENTITIES[name] = String.fromCharCode(0xc0 + i);
  });

/** Names a browser still decodes without the closing semicolon. */
const BARE_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'nbsp']);

/** `&#128;`–`&#159;` mean Windows-1252, as in every browser; 0 marks the five holes. */
const WINDOWS_1252 = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017d, 0,
  0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0, 0x017e, 0x0178,
];

const ENTITY = /&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}))(;?)/g;

function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(ENTITY, (m: string, dec: string | undefined, hex: string | undefined, name: string | undefined, semi: string, at: number, all: string) => {
    if (name) {
      // case matters (&Eacute; vs &eacute;), but an all-caps &NBSP; from a 1990s filing still means a space
      const value = NAMED_ENTITIES[name] ?? (name === name.toUpperCase() ? NAMED_ENTITIES[name.toLowerCase()] : undefined);
      if (value === undefined) return m;
      if (!semi && (!BARE_ENTITIES.has(name.toLowerCase()) || all.charCodeAt(at + m.length) === 61 /* = */)) return m;
      return value;
    }
    const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex!, 16);
    if (cp >= 0x80 && cp <= 0x9f) {
      const mapped = WINDOWS_1252[cp - 0x80];
      return mapped ? String.fromCharCode(mapped) : '';
    }
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
    if (cp === 9 || cp === 10 || cp === 13 || cp === 12) return cp === 9 ? '\t' : '\n';
    if (cp < 0x20 || cp === 0x7f) return '';
    // private-use code points are icon-font glyphs; dropping them also keeps the renderer's markers unique
    if (cp >= 0xe000 && cp <= 0xf8ff) return '';
    return String.fromCodePoint(cp);
  });
}

/* ────────────────────────────── the tree ────────────────────────────── */

interface El {
  name: string;
  attrs: Record<string, string>;
  children: Child[];
  parent: El | null;
}
type Child = El | string;

/**
 * The parsed tree, for a converter that reads a document's parts itself
 * before it is rendered (src/ingest/converters/epub.ts: a book's notes,
 * headings and pictures). Names and attribute keys are lower-case.
 */
export type HtmlElement = El;
export type HtmlNode = Child;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/** Elements whose content is text up to their own end tag. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript', 'iframe', 'noembed', 'noframes', 'template']);
/** A block start closes an open <p>. */
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section',
  'summary', 'table', 'ul', 'li', 'dd', 'dt',
]);
/** What an end tag may not reach across: a stray </div> inside a cell closes nothing outside it. */
const SCOPE = new Set(['td', 'th', 'table', 'caption', 'html', 'body', 'template']);
const MAX_DEPTH = 400;

const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!s) return out;
  ATTR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR.exec(s))) {
    const key = m[1].toLowerCase();
    if (!(key in out)) out[key] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

interface Parsed {
  root: El;
  /** The raw JSON of every `<script type="application/ld+json">`. */
  jsonLd: string[];
  scripts: number;
}

/**
 * Tokenize and build in one pass. Comments, doctypes and processing
 * instructions are skipped; raw-text elements are read to their end tag
 * (only a title's text and JSON-LD are kept); the stack applies the implied
 * end tags pages rely on (p, li, dt/dd, tr, td/th, table sections, option).
 */
function parse(html: string): Parsed {
  const root: El = { name: '#root', attrs: {}, children: [], parent: null };
  const stack: El[] = [root];
  const jsonLd: string[] = [];
  let scripts = 0;
  const top = () => stack[stack.length - 1];
  const text = (t: string) => {
    if (!t) return;
    const parent = top();
    const last = parent.children[parent.children.length - 1];
    if (typeof last === 'string') parent.children[parent.children.length - 1] = last + t;
    else parent.children.push(t);
  };
  const closeTo = (names: Set<string>, stopAt: Set<string>) => {
    for (let i = stack.length - 1; i > 0; i--) {
      const n = stack[i].name;
      if (names.has(n)) {
        stack.length = i;
        return true;
      }
      if (stopAt.has(n)) return false;
    }
    return false;
  };
  const open = (name: string, attrs: Record<string, string>, selfClosing: boolean) => {
    // implied end tags
    if (CLOSES_P.has(name)) closeTo(new Set(['p']), new Set([...SCOPE, 'button']));
    if (name === 'li') closeTo(new Set(['li']), new Set([...SCOPE, 'ul', 'ol', 'menu']));
    else if (name === 'dt' || name === 'dd') closeTo(new Set(['dt', 'dd']), new Set([...SCOPE, 'dl']));
    else if (name === 'tr') closeTo(new Set(['tr']), new Set(['table', 'thead', 'tbody', 'tfoot', 'html', 'body']));
    else if (name === 'td' || name === 'th') closeTo(new Set(['td', 'th']), new Set(['tr', 'table', 'html', 'body']));
    else if (name === 'thead' || name === 'tbody' || name === 'tfoot') closeTo(new Set(['thead', 'tbody', 'tfoot']), new Set(['table', 'html', 'body']));
    else if (name === 'option') closeTo(new Set(['option']), new Set(['select', 'datalist', ...SCOPE]));
    const el: El = { name, attrs, children: [], parent: top() };
    top().children.push(el);
    if (!VOID.has(name) && !selfClosing && stack.length < MAX_DEPTH) stack.push(el);
  };
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      text(decodeEntities(html.slice(i)));
      break;
    }
    if (lt > i) text(decodeEntities(html.slice(i, lt)));
    i = lt;
    const next = html.charCodeAt(i + 1);
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (next === 33 /* ! */ || next === 63 /* ? */) {
      // doctype, CDATA, processing instruction
      if (html.startsWith('<![CDATA[', i)) {
        const end = html.indexOf(']]>', i + 9);
        text(html.slice(i + 9, end < 0 ? n : end));
        i = end < 0 ? n : end + 3;
      } else {
        const end = html.indexOf('>', i + 2);
        i = end < 0 ? n : end + 1;
      }
      continue;
    }
    const close = next === 47; /* / */
    const nameStart = close ? i + 2 : i + 1;
    const c0 = html.charCodeAt(nameStart);
    const isLetter = (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122);
    if (!isLetter) {
      text('<');
      i += 1;
      continue;
    }
    // the tag runs to the first '>' outside a quoted attribute value
    let j = nameStart;
    let quote = 0;
    for (; j < n; j++) {
      const c = html.charCodeAt(j);
      if (quote) {
        if (c === quote) quote = 0;
      } else if (c === 34 || c === 39) {
        // a quote only opens inside an attribute value (after '='), so "don't" in a broken tag cannot swallow the page
        let k = j - 1;
        while (k > nameStart && (html.charCodeAt(k) === 32 || html.charCodeAt(k) === 9 || html.charCodeAt(k) === 10)) k--;
        if (html.charCodeAt(k) === 61) quote = c;
      } else if (c === 62) break;
    }
    if (j >= n) {
      text(decodeEntities(html.slice(i)));
      break;
    }
    const inner = html.slice(nameStart, j);
    i = j + 1;
    const nm = /^[^\s/>]+/.exec(inner)![0].toLowerCase();
    if (close) {
      if (nm === 'p' && !stack.some((e) => e.name === 'p')) {
        open('p', {}, true); // a lone </p> is an empty paragraph, as browsers read it
        continue;
      }
      if (nm === 'br') {
        open('br', {}, true);
        continue;
      }
      closeTo(new Set([nm]), SCOPE.has(nm) ? new Set(['html', 'body']) : SCOPE);
      continue;
    }
    const selfClosing = inner.endsWith('/');
    const attrs = parseAttrs(inner.slice(nm.length, selfClosing ? -1 : undefined));
    if (RAW_TEXT.has(nm) && !selfClosing) {
      const endRe = new RegExp(`</${nm}\\s*>`, 'ig');
      endRe.lastIndex = i;
      const m = endRe.exec(html);
      const body = html.slice(i, m ? m.index : n);
      i = m ? m.index + m[0].length : n;
      if (nm === 'script') {
        scripts++;
        if (/ld\+json/i.test(attrs.type ?? '')) jsonLd.push(body);
        continue;
      }
      if (nm === 'title' || nm === 'textarea') {
        const el: El = { name: nm, attrs, children: [decodeEntities(body)], parent: top() };
        top().children.push(el);
        continue;
      }
      // style, noscript, iframe, template …: dropped wholesale
      const el: El = { name: nm, attrs, children: [], parent: top() };
      top().children.push(el);
      continue;
    }
    open(nm, attrs, selfClosing);
  }
  return { root, jsonLd, scripts };
}

/** The tree of a document — a page, or XML read the same tolerant way (an EPUB's package and table of contents). */
export function parseHtml(html: string): HtmlElement {
  return parse(html).root;
}

/* ────────────────────────────── selection ───────────────────────────── */

/** Never content: scripts, forms, media players, the hidden XBRL header of an SEC filing … */
const DROP = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select',
  'textarea', 'option', 'datalist', 'dialog', 'head', 'title', 'meta', 'link', 'base', 'map', 'audio', 'video', 'source', 'track',
  'noembed', 'noframes', 'ix:header', 'xbrli:context', 'math',
]);
const CHROME_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'search', 'complementary']);
const BOILERPLATE = new Set([
  'cookie', 'cookies', 'consent', 'gdpr', 'newsletter', 'subscribe', 'subscription', 'share', 'sharing', 'social', 'advert',
  'advertisement', 'ads', 'promo', 'promotion', 'breadcrumb', 'breadcrumbs', 'related', 'comments', 'popup', 'navbar', 'sidebar',
  'masthead', 'skiplink', 'paywall',
]);

function isHidden(el: El): boolean {
  if ('hidden' in el.attrs) return true;
  if ((el.attrs['aria-hidden'] ?? '').toLowerCase() === 'true') return true;
  const style = (el.attrs.style ?? '').toLowerCase().replace(/\s+/g, '');
  return style.includes('display:none') || style.includes('visibility:hidden');
}

function tokensOf(el: El): string[] {
  return `${el.attrs.id ?? ''} ${el.attrs.class ?? ''}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Visible text length of a subtree (dropped and hidden parts excluded), cached per element. */
function textLength(el: El, cache: Map<El, number>): number {
  const hit = cache.get(el);
  if (hit !== undefined) return hit;
  let total = 0;
  if (!DROP.has(el.name) && !isHidden(el)) {
    for (const c of el.children) total += typeof c === 'string' ? c.replace(/\s+/g, '').length : textLength(c, cache);
  }
  cache.set(el, total);
  return total;
}

/** Matching elements in content (not inside dropped parts); `everywhere` searches the head too. */
function findAll(el: El, pred: (e: El) => boolean, out: El[] = [], everywhere = false): El[] {
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    if (pred(c)) out.push(c);
    if (everywhere || !DROP.has(c.name)) findAll(c, pred, out, everywhere);
  }
  return out;
}

/** The text of a subtree as written: whitespace kept, a <br> a newline (for <pre>). */
function rawText(el: El): string {
  return el.children.map((c) => (typeof c === 'string' ? c : c.name === 'br' ? '\n' : DROP.has(c.name) ? '' : rawText(c))).join('');
}

function find(el: El, pred: (e: El) => boolean): El | null {
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    if (pred(c)) return c;
    const hit = find(c, pred);
    if (hit) return hit;
  }
  return null;
}

const CANDIDATE_IDS = new Set(['content', 'main', 'article', 'main-content', 'maincontent']);
const CANDIDATE_CLASSES = new Set(['post', 'article', 'entry-content', 'content', 'post-content', 'article-body', 'story-body']);

function isCandidate(el: El): boolean {
  if (el.name === 'article' || el.name === 'main') return true;
  if ((el.attrs.role ?? '').toLowerCase() === 'main') return true;
  if (el.attrs.id && CANDIDATE_IDS.has(el.attrs.id.toLowerCase())) return true;
  return (el.attrs.class ?? '').toLowerCase().split(/\s+/).some((c) => CANDIDATE_CLASSES.has(c));
}

/* ────────────────────────────── rendering ───────────────────────────── */

const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd', 'details', 'dir', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'html', 'li', 'main', 'menu', 'nav',
  'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', '#root', 'legend',
]);
const BR = '\u0001';

interface Ctx {
  base: URL | null;
  cache: Map<El, number>;
  /** The subtree being rendered and its text: chrome inside it stays, a big "boilerplate" element stays. */
  scopeText: number;
  /** No article / main was found: header, footer and aside are the page's chrome, not the article's. */
  mainIsBody: boolean;
  /** Everything in the body is the text (a book's chapter): no chrome or boilerplate is left out. */
  whole: boolean;
  resolveUrl?: HtmlToMarkdownOptions['resolveUrl'];
  links: number;
  tables: number;
}

/** Where a link or a picture points: the caller's resolver when it has one, else the address against the page's base. */
function target(url: string, kind: 'a' | 'img', ctx: Ctx): string | null {
  return ctx.resolveUrl ? ctx.resolveUrl(url, kind) : absolute(url, ctx);
}

function absolute(url: string, ctx: Ctx): string | null {
  const u = url.trim();
  if (!u || /^javascript:/i.test(u) || /^(vbscript|data):/i.test(u) && !/^data:image\//i.test(u)) return null;
  try {
    return ctx.base ? new URL(u, ctx.base).toString() : new URL(u).toString();
  } catch {
    return /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : null;
  }
}

/** An element the renderer leaves out where it stands (hidden, chrome, boilerplate). */
function skipped(el: El, ctx: Ctx): boolean {
  if (DROP.has(el.name) || isHidden(el)) return true;
  if (ctx.whole) return false;
  const role = (el.attrs.role ?? '').toLowerCase();
  // an article's own <header> holds its title and byline; the page's holds the site's menu
  const pageChrome = ctx.mainIsBody && (el.name === 'header' || el.name === 'footer' || el.name === 'aside');
  const chrome = el.name === 'nav' || CHROME_ROLES.has(role) || pageChrome;
  const boiler = tokensOf(el).some((t) => BOILERPLATE.has(t));
  if (!chrome && !boiler) return false;
  if (el.name === 'table') return false;
  // never what holds most of the page: a site that wraps its article in <header> keeps it
  return textLength(el, ctx.cache) <= ctx.scopeText * 0.4;
}

function collapse(s: string): string {
  return s.replace(/[ \t\n\r\f\v ]+/g, ' ');
}

function fenceFor(code: string, min = 1): string {
  let longest = 0;
  for (const m of code.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(min, longest + 1));
}

/** Inline Markdown of an element's content; blocks met inside inline content become spaces. */
function inline(el: El, ctx: Ctx): string {
  const parts: string[] = [];
  for (const c of el.children) {
    if (typeof c === 'string') {
      parts.push(c.replace(/\u0001/g, ''));
      continue;
    }
    if (skipped(c, ctx)) continue;
    parts.push(inlineEl(c, ctx));
  }
  return parts.join('');
}

function wrap(mark: string, s: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s)!;
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : s;
}

function inlineEl(el: El, ctx: Ctx): string {
  switch (el.name) {
    case 'br':
      return BR;
    case 'wbr':
      return '';
    case 'img': {
      const alt = collapse(el.attrs.alt ?? el.attrs.title ?? '').trim();
      const src = el.attrs.src ?? '';
      // a page's picture without words is decoration; a book's is a figure, a plate, a photograph
      if ((!alt && !ctx.whole) || (el.attrs.width === '1' && el.attrs.height === '1')) return '';
      if (/^data:/i.test(src) && src.length > 2048) return '';
      const abs = target(src, 'img', ctx);
      return abs ? `![${alt.replace(/[[\]]/g, '')}](${abs.replace(/\)/g, '%29').replace(/ /g, '%20')})` : '';
    }
    case 'strong':
    case 'b':
      return wrap('**', inline(el, ctx));
    case 'em':
    case 'i':
    case 'cite':
      return wrap('*', inline(el, ctx));
    case 'code':
    case 'tt':
    case 'kbd':
    case 'samp': {
      const code = collapse(inline(el, ctx).replace(new RegExp(BR, 'g'), ' '));
      if (!code.trim()) return code;
      const fence = fenceFor(code);
      return `${fence}${code.startsWith('`') ? ' ' : ''}${code}${code.endsWith('`') ? ' ' : ''}${fence}`;
    }
    case 'sup': {
      const t = collapse(inline(el, ctx)).trim();
      return /^[\d*†‡§a-z]{1,3}$/i.test(t) ? `^${t}` : t;
    }
    case 'a': {
      const label = inline(el, ctx);
      const href = el.attrs.href ?? '';
      const text = collapse(label).trim();
      if (!text) return label.includes('![') ? label : '';
      if (!href || href.startsWith('#')) return label;
      const abs = target(href, 'a', ctx);
      if (!abs || /^javascript:/i.test(abs)) return label;
      ctx.links++;
      if (text === abs || text === href) return `<${abs}>`;
      return `[${text.replace(/[[\]]/g, '\\$&')}](${abs.replace(/\)/g, '%29').replace(/ /g, '%20')})`;
    }
    case 'q':
      return `“${inline(el, ctx)}”`;
    default:
      if (!BLOCK.has(el.name) && el.attrs.style) {
        // a filing printed to HTML says bold and italic in CSS, not with <b> / <i>
        const style = el.attrs.style.toLowerCase();
        const text = inline(el, ctx);
        const bold = /font-weight\s*:\s*(bold|bolder|[6-9]00)\b/.test(style);
        const italic = /font-style\s*:\s*italic\b/.test(style);
        return bold ? wrap('**', text) : italic ? wrap('*', text) : text;
      }
      if (BLOCK.has(el.name)) {
        // a block inside inline content (a <div> in a cell): its own words, set apart
        if (el.name === 'table') return ` ${tableCells(el, ctx).map((r) => r.map((c) => c.text).filter(Boolean).join(' ')).filter(Boolean).join(' · ')} `;
        return ` ${inline(el, ctx)} `;
      }
      return inline(el, ctx);
  }
}

/** Inline text as it lands in a block: whitespace collapsed, breaks kept, lines trimmed. */
function finish(s: string): string {
  return collapse(s)
    .split(BR)
    .map((l) => l.trim())
    .join('  \n')
    .replace(/(?:  \n)+$/, '')
    .replace(/^(?:  \n)+/, '')
    .trim();
}

/** A line that would read as Markdown structure it is not. */
function escapeLine(line: string): string {
  return line
    .replace(/^(\s*)(#{1,6}\s)/, '$1\\$2')
    .replace(/^(\s*)>/, '$1\\>')
    .replace(/^(\s*)([-+*])(\s)/, '$1\\$2$3')
    .replace(/^(\s*)(\d{1,9})([.)])(\s)/, '$1$2\\$3$4')
    .replace(/^(\s*)(-{3,}|\*{3,}|_{3,}|={3,})\s*$/, '$1\\$2');
}

function paragraph(text: string): string {
  return text.split('\n').map(escapeLine).join('\n');
}

interface Cell {
  text: string;
  header: boolean;
  span: number;
  /** Holds block structure of its own (a nested table, several paragraphs): the table is layout, not data. */
  blocky: boolean;
}

/** The rows of a table, nested tables left inside their cells. */
function tableRows(table: El): El[] {
  const rows: El[] = [];
  const visit = (el: El) => {
    for (const c of el.children) {
      if (typeof c === 'string') continue;
      if (c.name === 'tr') rows.push(c);
      else if (c.name === 'thead' || c.name === 'tbody' || c.name === 'tfoot') visit(c);
    }
  };
  visit(table);
  return rows;
}

function tableCells(table: El, ctx: Ctx): Cell[][] {
  return tableRows(table).map((tr) => tr.children
    .filter((c): c is El => typeof c !== 'string' && (c.name === 'td' || c.name === 'th') && !isHidden(c))
    .map((td) => {
      const blocks = findAll(td, (e) => e.name === 'table' || e.name === 'p' || e.name === 'div' || e.name === 'ul' || e.name === 'ol');
      const blocky = blocks.some((b) => b.name === 'table' || b.name === 'ul' || b.name === 'ol') || blocks.filter((b) => textLength(b, ctx.cache) > 40).length >= 3;
      const span = Math.min(50, Math.max(1, parseInt(td.attrs.colspan ?? '1', 10) || 1));
      return { text: finish(inline(td, ctx)).replace(/ {2}\n/g, ' '), header: td.name === 'th', span, blocky };
    }));
}

const LEADING = /^(?:\$|US\$|€|£|¥|RMB|HK\$|\()$/;
const TRAILING = /^(?:\)|%|\)%|%\))$/;
const BULLET = /^(?:[•·◦▪●○■□‣⁃–—-]|\(?[0-9]{1,3}[.)]|\(?[a-z][.)]|\([ivx]{1,5}\))$/i;

/** Render one table: a data table as a GFM grid, a layout table as its content. */
function table(el: El, ctx: Ctx, out: string[]): void {
  const rows = tableCells(el, ctx);
  const width = Math.max(0, ...rows.map((r) => r.reduce((n, c) => n + c.span, 0)));
  if (rows.length === 0 || width === 0) return;
  const layout = width === 1 || rows.some((r) => r.some((c) => c.blocky));
  if (layout) {
    // its cells hold the page: render them as blocks, in reading order
    for (const tr of tableRows(el)) {
      for (const td of tr.children) if (typeof td !== 'string' && (td.name === 'td' || td.name === 'th')) blocks(td, ctx, out);
    }
    return;
  }
  // an SEC-style bullet list laid out as a table: "•" | text
  const filled = rows.map((r) => r.filter((c) => c.text));
  if (filled.length && filled.every((r) => r.length === 2 && BULLET.test(r[0].text))) {
    out.push(filled.map((r) => (/^[•·◦▪●○■□‣⁃–—-]$/.test(r[0].text) ? `- ${r[1].text}` : `- ${r[0].text} ${r[1].text}`)).join('\n'));
    return;
  }
  // expand spans, then fold the cells a financial table splits a number into ("$" | "1,234" | ")")
  const grid = rows.map((r) => {
    const cells: string[] = [];
    const head: boolean[] = [];
    for (const c of r) {
      cells.push(c.text);
      head.push(c.header);
      for (let k = 1; k < c.span; k++) {
        cells.push('');
        head.push(c.header);
      }
    }
    while (cells.length < width) {
      cells.push('');
      head.push(false);
    }
    for (let k = 0; k < cells.length; k++) {
      if (LEADING.test(cells[k])) {
        // the number moves into the symbol's cell: a header spanning "$" and the figure sits over that one
        const next = cells.findIndex((v, idx) => idx > k && v !== '');
        if (next > 0 && !LEADING.test(cells[next])) {
          cells[k] = `${cells[k]}${cells[next]}`;
          cells[next] = '';
        }
      } else if (TRAILING.test(cells[k])) {
        let prev = k - 1;
        while (prev >= 0 && cells[prev] === '') prev--;
        if (prev >= 0) {
          cells[prev] = `${cells[prev]}${cells[k]}`;
          cells[k] = '';
        }
      }
    }
    return { cells, head };
  });
  const keep = Array.from({ length: width }, (_, k) => grid.some((r) => r.cells[k] !== ''));
  const kept = grid.map((r) => ({ cells: r.cells.filter((_, k) => keep[k]), head: r.head.filter((_, k) => keep[k]) })).filter((r) => r.cells.some((c) => c !== ''));
  if (kept.length === 0) return;
  const cols = kept[0].cells.length;
  if (cols === 1) {
    out.push(kept.map((r) => paragraph(r.cells[0])).join('\n\n'));
    return;
  }
  ctx.tables++;
  // the header: the leading rows a page marked as <th> (or <thead>), else the first row
  let headerRows = 0;
  while (headerRows < kept.length - 1 && kept[headerRows].head.every((h, k) => h || kept[headerRows].cells[k] === '')) headerRows++;
  if (headerRows === 0) headerRows = 1;
  const header = Array.from({ length: cols }, (_, k) => kept.slice(0, headerRows).map((r) => r.cells[k]).filter(Boolean).join(' '));
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const line = (cells: string[]) => `| ${cells.map((c) => esc(c) || ' ').join(' | ')} |`;
  out.push([line(header), `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`, ...kept.slice(headerRows).map((r) => line(r.cells))].join('\n'));
}

function list(el: El, ctx: Ctx, depth: number): string {
  const ordered = el.name === 'ol';
  let n = Math.max(0, parseInt(el.attrs.start ?? '1', 10) || 1);
  const lines: string[] = [];
  const indent = '  '.repeat(depth);
  for (const c of el.children) {
    if (typeof c === 'string') {
      if (c.trim()) lines.push(`${indent}- ${collapse(c).trim()}`);
      continue;
    }
    if (skipped(c, ctx)) continue;
    if (c.name === 'ul' || c.name === 'ol') {
      lines.push(list(c, ctx, depth + 1));
      continue;
    }
    // an item: its inline content, then its nested lists one level in
    const own: Child[] = [];
    const nested: El[] = [];
    for (const k of c.children) {
      if (typeof k !== 'string' && (k.name === 'ul' || k.name === 'ol')) nested.push(k);
      else own.push(k);
    }
    const text = finish(inline({ ...c, children: own }, ctx)).replace(/ {2}\n/g, `  \n${indent}  `);
    const marker = ordered ? `${n++}.` : '-';
    if (text) lines.push(`${indent}${marker} ${text}`);
    for (const sub of nested) lines.push(list(sub, ctx, depth + 1));
  }
  return lines.filter(Boolean).join('\n');
}

/* A page printed to HTML (many SEC filings): every printed line is its own absolutely positioned <div>
   at a `top:` offset, its words in positioned <font> runs. Lines are joined back into paragraphs where
   the vertical gap is a line's, and a new paragraph starts where it is wider. */

const pt = (v: string, unit: string) => parseFloat(v) * (unit.toLowerCase() === 'px' ? 0.75 : 1);

/** The `top` of a <div> that is one printed line (absolutely positioned, inline content only), else null. */
function lineTop(el: El): number | null {
  if (el.name !== 'div' && el.name !== 'p') return null;
  const style = el.attrs.style ?? '';
  if (!/position\s*:\s*absolute/i.test(style)) return null;
  const m = /(?:^|;)\s*top\s*:\s*(-?[\d.]+)(pt|px)/i.exec(style);
  if (!m) return null;
  if (el.children.some((c) => typeof c !== 'string' && BLOCK.has(c.name) && c.name !== 'br')) return null;
  return pt(m[1], m[2]);
}

/** A line's words: positioned runs get a space between them where the layout leaves a gap. */
function lineText(el: El, ctx: Ctx): string {
  const parts: string[] = [];
  let right: number | null = null;
  for (const c of el.children) {
    if (typeof c === 'string') {
      parts.push(c);
      right = null;
      continue;
    }
    if (skipped(c, ctx)) continue;
    const style = c.attrs.style ?? '';
    const left = /(?:^|;)\s*left\s*:\s*(-?[\d.]+)(pt|px)/i.exec(style);
    const width = /(?:^|;)\s*width\s*:\s*([\d.]+)(pt|px)/i.exec(style);
    const text = inlineEl(c, ctx);
    if (left && right !== null && pt(left[1], left[2]) > right + 0.5 && parts.length && !/\s$/.test(parts[parts.length - 1]) && !/^\s/.test(text)) parts.push(' ');
    parts.push(text);
    right = left && width ? pt(left[1], left[2]) + pt(width[1], width[2]) : null;
  }
  return finish(parts.join('')).replace(/\*\*\*\*/g, '').replace(/ {2}\n/g, ' ');
}

/** Consecutive printed lines as paragraphs; a paragraph that is one fully bold line is marked as a heading candidate. */
function printedParagraphs(lines: { top: number; el: El }[], ctx: Ctx, out: string[]): void {
  const items = lines.map((l) => ({ top: l.top, text: lineText(l.el, ctx) })).filter((l) => l.text);
  if (items.length === 0) return;
  const gaps = items.slice(1).map((it, i) => it.top - items[i].top).filter((g) => g > 0).sort((a, b) => a - b);
  // a line's spacing: the lower quartile of the gaps, since a short page may have as many paragraph gaps as line gaps
  const typical = gaps.length ? gaps[Math.floor(gaps.length / 4)] : 12;
  let current: string[] = [items[0].text];
  const emit = () => {
    const joined = current.reduce((acc, line) => (!acc ? line : /[a-z]-$/.test(acc) && /^[a-z]/.test(line) ? acc + line : `${acc} ${line}`), '');
    if (current.length === 1 && /^\*\*[^*]{2,120}\*\*$/.test(joined) && !/[.,;]\*\*$/.test(joined)) out.push(`${HEADING_CANDIDATE}${joined}`);
    else out.push(paragraph(joined));
  };
  for (let i = 1; i < items.length; i++) {
    const gap = items[i].top - items[i - 1].top;
    if (gap <= 0 || gap > typical * 1.45 + 0.5) {
      emit();
      current = [];
    }
    current.push(items[i].text);
  }
  emit();
}

const HEADING_CANDIDATE = '\u0002';

/** Holds a block element (or a printed line) among its children. */
function holdsBlocks(el: El): boolean {
  return el.children.some((k) => typeof k !== 'string' && k.name !== 'br' && (BLOCK.has(k.name) || lineTop(k) !== null || (!VOID.has(k.name) && holdsBlocks(k))));
}

/** Block Markdown for an element's children, consecutive inline content gathered into paragraphs. */
function blocks(el: El, ctx: Ctx, out: string[]): void {
  let run: Child[] = [];
  let printed: { top: number; el: El }[] = [];
  const flushPrinted = () => {
    if (printed.length) printedParagraphs(printed, ctx, out);
    printed = [];
  };
  const flush = () => {
    flushPrinted();
    if (run.length === 0) return;
    const text = finish(inline({ name: 'span', attrs: {}, children: run, parent: el }, ctx));
    if (text) out.push(paragraph(text));
    run = [];
  };
  for (const c of el.children) {
    if (typeof c !== 'string' && skipped(c, ctx)) continue;
    if (typeof c !== 'string' && !BLOCK.has(c.name) && holdsBlocks(c)) {
      // an element that is no block by name but holds blocks (inline-XBRL text blocks, a <font> around <div>s,
      // a custom element) is laid out as the blocks it holds
      flush();
      blocks(c, ctx, out);
      continue;
    }
    if (typeof c !== 'string') {
      const top = lineTop(c);
      if (top !== null) {
        if (run.some((r) => typeof r !== 'string' || r.trim())) flush();
        run = [];
        printed.push({ top, el: c });
        continue;
      }
    } else if (typeof c === 'string' && printed.length && !c.trim()) {
      continue;
    }
    flushPrinted();
    if (typeof c === 'string' || (!BLOCK.has(c.name) && c.name !== 'br') || c.name === 'br') {
      if (typeof c !== 'string' && skipped(c, ctx)) continue;
      run.push(c);
      continue;
    }
    if (skipped(c, ctx)) continue;
    flush();
    block(c, ctx, out);
  }
  flush();
}

function block(el: El, ctx: Ctx, out: string[]): void {
  const name = el.name;
  if (/^h[1-6]$/.test(name)) {
    let text = finish(inline(el, ctx)).replace(/ {2}\n/g, ' ');
    // a book that bolds its headings, one character at a time at that (**版****权**), means no emphasis by it
    if (ctx.whole) text = text.replace(/\*\*/g, '').trim();
    if (text) out.push(`${'#'.repeat(Number(name[1]))} ${text}`);
    return;
  }
  switch (name) {
    case 'p':
    case 'summary':
    case 'legend':
    case 'caption': {
      if (el.children.some((c) => typeof c !== 'string' && BLOCK.has(c.name) && c.name !== 'br')) {
        blocks(el, ctx, out);
        return;
      }
      const text = finish(inline(el, ctx));
      if (text) out.push(name === 'summary' ? `**${text.replace(/\*\*/g, '')}**` : paragraph(text));
      return;
    }
    case 'hr':
      out.push('---');
      return;
    case 'pre': {
      const code = rawText(el).replace(/^\n/, '').replace(/\s+$/, '');
      if (code.trim()) {
        const fence = fenceFor(code, 3);
        out.push(`${fence}\n${code}\n${fence}`);
      }
      return;
    }
    case 'ul':
    case 'ol':
    case 'menu':
    case 'dir': {
      const text = list({ ...el, name: name === 'ol' ? 'ol' : 'ul' }, ctx, 0);
      if (text) out.push(text);
      return;
    }
    case 'dl': {
      const items: string[] = [];
      let term = '';
      for (const c of el.children) {
        if (typeof c === 'string' || skipped(c, ctx)) continue;
        if (c.name === 'dt') {
          if (term) items.push(`**${term}**`);
          term = finish(inline(c, ctx)).replace(/ {2}\n/g, ' ');
        } else if (c.name === 'dd') {
          const def = finish(inline(c, ctx)).replace(/ {2}\n/g, ' ');
          items.push(term ? `**${term}** — ${def}` : def);
          term = '';
        }
      }
      if (term) items.push(`**${term}**`);
      if (items.length) out.push(items.join('\n\n'));
      return;
    }
    case 'blockquote': {
      const inner: string[] = [];
      blocks(el, ctx, inner);
      if (inner.length) out.push(inner.join('\n\n').split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'));
      return;
    }
    case 'table':
      table(el, ctx, out);
      return;
    case 'figure': {
      const caption = el.children.find((c): c is El => typeof c !== 'string' && c.name === 'figcaption');
      blocks({ ...el, children: el.children.filter((c) => c !== caption) }, ctx, out);
      const text = caption ? finish(inline(caption, ctx)).replace(/ {2}\n/g, ' ') : '';
      if (text) out.push(`*${text.replace(/\*/g, '')}*`);
      return;
    }
    default:
      blocks(el, ctx, out);
  }
}

/* ──────────────────────────────── meta ──────────────────────────────── */

function normalizeDate(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) {
    const t = Date.parse(v.replace(' ', 'T'));
    return Number.isFinite(t) ? new Date(t).toISOString() : v.slice(0, 10);
  }
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return v;
  // a date without a time is the day it names, wherever this runs
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function jsonLdNodes(raw: string[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      out.push(o);
      if (Array.isArray(o['@graph'])) visit(o['@graph']);
    }
  };
  for (const text of raw) {
    try {
      visit(JSON.parse(text.trim()));
    } catch {
      // a broken block is skipped; another one may still say what the page is
    }
  }
  return out;
}

function nameOf(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v)) return v.map(nameOf).filter(Boolean).join(', ') || null;
  if (v && typeof v === 'object' && typeof (v as Record<string, unknown>).name === 'string') return ((v as Record<string, unknown>).name as string).trim() || null;
  return null;
}

function readMeta(parsed: Parsed, ctx: Ctx, main: El): HtmlMeta {
  const metas = findAll(parsed.root, (e) => e.name === 'meta', [], true);
  const metaFor = (...keys: string[]): string | null => {
    for (const key of keys) {
      const hit = metas.find((m) => (m.attrs.property ?? m.attrs.name ?? m.attrs.itemprop ?? '').toLowerCase() === key && m.attrs.content?.trim());
      if (hit) return collapse(hit.attrs.content).trim();
    }
    return null;
  };
  const ld = jsonLdNodes(parsed.jsonLd);
  const ldValue = (key: string): unknown => ld.find((n) => n[key] !== undefined && n[key] !== null && n[key] !== '')?.[key];
  const titleEl = find(parsed.root, (e) => e.name === 'title');
  const h1 = find(main, (e) => e.name === 'h1');
  const title = metaFor('og:title', 'twitter:title')
    ?? (titleEl ? collapse(inline(titleEl, ctx)).trim() || null : null)
    ?? (typeof ldValue('headline') === 'string' ? (ldValue('headline') as string) : null)
    ?? (h1 ? finish(inline(h1, ctx)).replace(/ {2}\n/g, ' ') || null : null);
  const time = find(main, (e) => e.name === 'time' && Boolean(e.attrs.datetime));
  const canonicalEl = findAll(parsed.root, (e) => e.name === 'link' && (e.attrs.rel ?? '').toLowerCase().split(/\s+/).includes('canonical'), [], true)[0];
  const html = find(parsed.root, (e) => e.name === 'html');
  return {
    title,
    description: metaFor('og:description', 'description', 'twitter:description') ?? (typeof ldValue('description') === 'string' ? (ldValue('description') as string) : null),
    author: metaFor('author', 'article:author', 'dc.creator', 'citation_author') ?? nameOf(ldValue('author')),
    published: normalizeDate(
      metaFor('article:published_time', 'date', 'pubdate', 'publishdate', 'dc.date', 'dc.date.issued', 'citation_publication_date', 'publication_date', 'parsely-pub-date', 'sailthru.date')
      ?? (typeof ldValue('datePublished') === 'string' ? (ldValue('datePublished') as string) : null)
      ?? time?.attrs.datetime ?? null,
    ),
    modified: normalizeDate(metaFor('article:modified_time', 'og:updated_time', 'last-modified') ?? (typeof ldValue('dateModified') === 'string' ? (ldValue('dateModified') as string) : null)),
    siteName: metaFor('og:site_name', 'application-name') ?? nameOf(ldValue('publisher')),
    canonical: canonicalEl?.attrs.href ? absolute(canonicalEl.attrs.href, ctx) : null,
    lang: html?.attrs.lang?.trim() || html?.attrs['xml:lang']?.trim() || null,
  };
}

/* ─────────────────────────────── the API ────────────────────────────── */

/**
 * Readable Markdown of a page: the main content (the largest `article` /
 * `main` / `#content` …, else the body without its chrome), tables as GFM
 * grids, links absolute, plus what the page says about itself.
 */
/** An EDGAR document's SGML wrapper (<DOCUMENT><TYPE>S-1<SEQUENCE>1…<TEXT>), which is no HTML and never closed. */
function stripSgmlWrapper(html: string): string {
  const at = html.search(/<html[\s>]/i);
  if (at <= 0) return html;
  const head = html.slice(0, at);
  if (!/<(DOCUMENT|TYPE|SEQUENCE|FILENAME|TEXT)>/.test(head)) return html;
  const end = html.search(/<\/html\s*>/i);
  return end > at ? html.slice(at, end + 7) : html.slice(at);
}

export interface HtmlToMarkdownOptions {
  /** The address the page came from: relative links and pictures resolve against it. */
  baseUrl?: string;
  /**
   * Everything in the body is the text — a book's chapter, not a web page: no
   * main content is picked out, no header, aside or "sidebar" is dropped as
   * chrome, a picture is kept without alt text, and no bold line is promoted
   * to a heading.
   */
  whole?: boolean;
  /** With `whole`, still read a fully bold one-line paragraph as a heading — for a book with no table of contents to go by. */
  boldHeadings?: boolean;
  /**
   * Where a link or a picture points, in place of resolving it against
   * `baseUrl`. Null keeps a link's label alone and leaves a picture out.
   */
  resolveUrl?: (url: string, kind: 'a' | 'img') => string | null;
  /** Called with the parsed tree before anything is rendered; may change it. */
  prepare?: (root: HtmlElement) => void;
}

function contextFor(base: URL | null, scope: El, cache: Map<El, number>, mainIsBody: boolean, opts: HtmlToMarkdownOptions): Ctx {
  return { base, cache, scopeText: textLength(scope, cache), mainIsBody, whole: Boolean(opts.whole), resolveUrl: opts.resolveUrl, links: 0, tables: 0 };
}

export function htmlToMarkdown(html: string, opts: HtmlToMarkdownOptions = {}): HtmlConversion {
  const parsed = parse(stripSgmlWrapper(html).replace(/\u0001/g, ''));
  opts.prepare?.(parsed.root);
  const cache = new Map<El, number>();
  let base: URL | null = null;
  const baseHref = find(parsed.root, (e) => e.name === 'base' && Boolean(e.attrs.href))?.attrs.href;
  try {
    base = opts.baseUrl ? new URL(baseHref ?? '', opts.baseUrl) : baseHref ? new URL(baseHref) : null;
  } catch {
    base = null;
  }
  const body = find(parsed.root, (e) => e.name === 'body') ?? parsed.root;
  const bodyText = textLength(body, cache);
  const warnings: string[] = [];
  let main = body;
  if (!opts.whole) {
    const candidates = findAll(body, isCandidate).filter((e) => !isHidden(e));
    const best = candidates.sort((a, b) => textLength(b, cache) - textLength(a, cache))[0];
    if (best && textLength(best, cache) >= bodyText * 0.3) main = best;
    else if (candidates.length) warnings.push('no main content found, used the whole body');
  }
  const ctx = contextFor(base, main, cache, main === body, opts);
  const out: string[] = [];
  block(main === body ? { ...main, name: 'body' } : main, ctx, out);
  // a page with no headings of its own (a filing printed to HTML) gets its fully bold one-line paragraphs as headings
  const ownHeadings = out.filter((b) => /^#{1,6} /.test(b)).length;
  const blocksOut = out.map((b) => {
    const candidate = b.startsWith(HEADING_CANDIDATE) || /^\*\*[^*\n]{2,120}\*\*$/.test(b);
    const text = b.replace(HEADING_CANDIDATE, '');
    const plain = text.replace(/^\*\*|\*\*$/g, '').replace(/\*\*/g, '').trim();
    // a bold year over a column, a bold figure, a bold "Table of Contents" on every page: no section titles
    if (!candidate || (opts.whole && !opts.boldHeadings) || ownHeadings >= 3 || /[.,;]\*\*$/.test(text) || !/\p{L}{3}/u.test(plain) || /^table of contents$/i.test(plain)) return text;
    return `${/[a-z]/.test(plain) ? '###' : '##'} ${plain}`;
  });
  const markdown = blocksOut.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  if (markdown.replace(/\s+/g, '').length < 200 && parsed.scripts > 0) warnings.push('page looks like a script-rendered app shell (little text)');
  const outline: HtmlConversion['outline'] = [];
  let fence = false;
  markdown.split('\n').forEach((line, i) => {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && /^(#{1,6}) (.+)$/.exec(line);
    if (m) outline.push({ level: m[1].length, text: m[2].trim(), line: i + 1 });
  });
  return { markdown, meta: readMeta(parsed, ctx, main), outline, tables: ctx.tables, links: ctx.links, warnings };
}

/**
 * The Markdown of one element of a parsed tree, whole — a note lifted out of
 * a book's chapter, say. Links and pictures resolve the way `opts` says.
 */
export function elementToMarkdown(el: HtmlElement, opts: Pick<HtmlToMarkdownOptions, 'resolveUrl'> = {}): string {
  const out: string[] = [];
  block(el, contextFor(null, el, new Map(), false, { ...opts, whole: true }), out);
  return out.map((b) => b.replace(HEADING_CANDIDATE, '')).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Decode a saved page: a BOM, then knode's own capture (UTF-8, whatever the
 * page declared: the record's `charset` says what it was fetched as), then a
 * `<meta charset>` in its first bytes, else UTF-8.
 */
export function decodeSavedHtml(bytes: Buffer): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8');
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  const head = bytes.subarray(0, 4096).toString('latin1');
  // a capture from before captures began with a BOM: UTF-8 too, under the page's own <meta charset>
  if (CAPTURE_START.test(head)) return bytes.toString('utf8');
  const label = /<meta[^>]+charset\s*=\s*["']?([\w:.-]+)/i.exec(head)?.[1]?.toLowerCase();
  if (label && label !== 'utf-8' && label !== 'utf8') {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // an encoding this Node does not know: read it as UTF-8
    }
  }
  return bytes.toString('utf8');
}

async function convertHtml(input: ConverterInput): Promise<ConversionResult> {
  const html = decodeSavedHtml(fs.readFileSync(input.absPath));
  const capture = readCaptureComment(html);
  const conv = htmlToMarkdown(html, { baseUrl: capture?.finalUrl ?? capture?.url });
  const m = conv.meta;
  const markdown = withProvenance(input.rel, 'html-readable', 'knode-html', conv.markdown || '_(the page has no readable text)_', {
    title: m.title,
    url: capture?.finalUrl ?? capture?.url ?? m.canonical,
    fetched: capture?.fetched,
    published: m.published,
    modified: m.modified,
    author: m.author,
    site: m.siteName,
    description: m.description,
    lang: m.lang,
  });
  return { markdown, kind: 'html-readable', model: 'knode-html', warnings: conv.warnings };
}

export const htmlConverter: DocumentConverterPlugin = {
  id: 'html',
  label: 'HTML (readable text)',
  extensions: HTML_EXTENSIONS,
  version: 1,
  usesVision: false,
  convert: convertHtml,
};
