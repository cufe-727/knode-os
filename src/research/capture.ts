import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppContext } from '../context.js';
import { assertWritablePath, safePath, writeFileBytes } from '../fs/files.js';
import { RAW_DOCS, sidecarRelFor } from '../fs/layout.js';
import { recordOrigin } from '../fs/sidecar.js';
import { assertNotLinked } from '../ingest/folders.js';
import { RESEARCH_MAX_PDF_PAGES } from '../ingest/convert.js';
import { captureComment, htmlToMarkdown, readCaptureComment } from '../ingest/converters/html.js';
import { meaningfulLength } from '../ingest/converters/shared.js';
import { sync } from '../ingest/sync.js';
import { decodeText, FetchedResponse, guardedFetch } from './fetch.js';
import { researchSlug } from './templates.js';
import { readMatter } from '../markdown.js';

/**
 * Web material a study relies on, kept as a source of the knowledge base.
 *
 * An agent that read something on the web asks knode to *capture* it: knode
 * fetches the URL itself (never trusting bytes an agent hands over as the
 * page), keeps what came back as the original under `raw/docs/research/`, and
 * lets the ordinary pipeline do the rest — the HTML or PDF converter turns it
 * into Markdown in the sidecar, sync chunks and embeds it, the background pass
 * extracts entities and claims. From then on the page is searchable, citable
 * by path (a wiki page's `sources:` entry that the validator can verify), and
 * still there when the site changes or disappears.
 *
 *   raw/docs/research/
 *   ├── .captures.json                 url → file, for every capture (dotfile: never indexed)
 *   └── <study>/
 *       ├── sources.md                 the study's register: title, site, date, URL, file, why
 *       ├── web/<date>-<site>-<slug>.html   pages as fetched (as UTF-8), one provenance comment prepended
 *       ├── files/<date>-<site>-<slug>.pdf  PDFs, images, CSV / JSON, text as fetched
 *       ├── notes/                     what the study's collectors found (written by the study runner)
 *       └── reports/                   a deep-research model's report (written by the study runner)
 *
 * The date in a name is the document's own (published), never the fetch
 * date: a date in the path dates the document in the index. Captures are on
 * record as written by whoever asked for them (`recordOrigin`), so an agent's
 * capture lands quarantined like the rest of its work until a person promotes
 * it. The same URL — or the same bytes — is captured once per workspace; a
 * second study asking for it reuses the file and lists it in its own register.
 */

export const RESEARCH_RAW_DIR = `${RAW_DOCS}/research`;
export const CAPTURE_MANIFEST = `${RESEARCH_RAW_DIR}/.captures.json`;
/** Captures that belong to no study (a person's `research capture <url>`, an Ask session). */
export const LOOSE_CAPTURES = 'web';

export type CaptureKind = 'html' | 'pdf' | 'text' | 'data' | 'image' | 'excerpt';

export interface CaptureRequest {
  url: string;
  /** The study the material is for; null = raw/docs/research/web. */
  study?: { id: string; slug: string } | null;
  /** Why it matters, one line — shown in the register, read by later agents. */
  why?: string;
  /** A title when the document carries none (a PDF without metadata). */
  title?: string;
  /**
   * Text the agent read itself, for a page knode cannot fetch (refused,
   * behind a login, rendered by script). Saved as an excerpt, marked as the
   * agent's transcription, never as the page.
   */
  content?: string;
  /** Who asked: `agent/<cli>` for an agent (quarantined), a person's name otherwise. */
  actor: string;
  /** 'background' (default): index without holding the caller; 'wait': finish the sync first; 'none': leave it to the watcher. */
  index?: 'background' | 'wait' | 'none';
  /** Study captures allowed before this one is refused (research.study.maxCaptures). */
  maxCaptures?: number;
  /**
   * Bytes knode already fetched itself, from a source a person configured (an
   * API answer): kept as they are instead of fetching the URL again.
   */
  prefetched?: FetchedResponse;
}

export interface CaptureResult {
  /** The original under raw/docs/research. */
  path: string;
  url: string;
  finalUrl: string;
  title: string | null;
  site: string;
  kind: CaptureKind;
  contentType: string;
  bytes: number;
  sha256: string;
  /** An earlier capture of the same URL or bytes was reused. */
  reused: boolean;
  published: string | null;
  /** What to pass to knode_read for the text (the original; a PDF or HTML page reads as its Markdown). */
  readPath: string;
  /** Characters of readable text, when known now. */
  chars: number | null;
  /** The first headings of the readable text, for knode_read's `section`. */
  outline: { level: number; text: string }[];
  warnings: string[];
}

interface ManifestStudy {
  id: string;
  slug: string;
  why: string;
  at: string;
}

export interface ManifestEntry {
  /** Normalized URL (the key). */
  url: string;
  /** Every spelling that led here: as asked, after redirects. */
  urls: string[];
  path: string;
  sha256: string;
  kind: CaptureKind;
  contentType: string;
  title: string | null;
  site: string;
  published: string | null;
  fetched: string;
  by: string;
  bytes: number;
  studies: ManifestStudy[];
}

interface Manifest {
  version: 1;
  entries: ManifestEntry[];
}

/* -------------------------------------------------------------- utilities */

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref_src|spm|from)$/i;

/** The URL a capture is filed under: no fragment, no tracking parameters, lower-case host, no default port. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
    for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
    u.searchParams.sort();
    let s = u.toString();
    if (u.pathname !== '/' && s.endsWith('/') && !u.search) s = s.slice(0, -1);
    return s;
  } catch {
    return raw.trim();
  }
}

function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** A short, readable file stem: `<date>-<site>-<slug>`, the date only when the document states one. */
function stemFor(input: { published: string | null; site: string; title: string | null; url: string }): string {
  const date = /^\d{4}-\d{2}-\d{2}/.exec(input.published ?? '')?.[0] ?? '';
  const site = input.site.replace(/[^a-z0-9.-]/gi, '').replace(/\./g, '-').slice(0, 40);
  let slug = input.title ? researchSlug(input.title) : '';
  if (!slug || /^entity-[0-9a-f]{8}$/.test(slug)) {
    try {
      const last = new URL(input.url).pathname.split('/').filter(Boolean).pop() ?? '';
      slug = researchSlug(decodeURIComponent(last).replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_+]/g, ' '));
    } catch {
      slug = '';
    }
  }
  if (!slug || /^entity-[0-9a-f]{8}$/.test(slug)) slug = crypto.createHash('sha1').update(input.url).digest('hex').slice(0, 10);
  return [date, site, slug.slice(0, 60).replace(/-+$/, '')].filter(Boolean).join('-');
}

function sha256(bytes: Uint8Array | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

const EXT_BY_TYPE: Record<string, { kind: CaptureKind; ext: string }> = {
  'text/html': { kind: 'html', ext: '.html' },
  'application/xhtml+xml': { kind: 'html', ext: '.html' },
  'application/pdf': { kind: 'pdf', ext: '.pdf' },
  'text/plain': { kind: 'text', ext: '.md' },
  'text/markdown': { kind: 'text', ext: '.md' },
  'text/x-markdown': { kind: 'text', ext: '.md' },
  'text/csv': { kind: 'data', ext: '.csv' },
  'application/json': { kind: 'data', ext: '.json' },
  'application/ld+json': { kind: 'data', ext: '.json' },
  'text/xml': { kind: 'data', ext: '.xml' },
  'application/xml': { kind: 'data', ext: '.xml' },
  'image/png': { kind: 'image', ext: '.png' },
  'image/jpeg': { kind: 'image', ext: '.jpg' },
  'image/webp': { kind: 'image', ext: '.webp' },
  'image/gif': { kind: 'image', ext: '.gif' },
};

/** What the bytes are, by Content-Type and, when that is missing or generic, by their first bytes. */
export function classify(contentType: string, body: Buffer, url: string): { kind: CaptureKind; ext: string; contentType: string } | null {
  const known = EXT_BY_TYPE[contentType];
  if (known) return { ...known, contentType };
  const head = body.subarray(0, 512).toString('latin1');
  if (head.startsWith('%PDF-')) return { kind: 'pdf', ext: '.pdf', contentType: 'application/pdf' };
  if (/^\s*(<!doctype html|<html|<head|<body)/i.test(head)) return { kind: 'html', ext: '.html', contentType: 'text/html' };
  if (body[0] === 0x89 && head.startsWith('PNG', 1)) return { kind: 'image', ext: '.png', contentType: 'image/png' };
  if (body[0] === 0xff && body[1] === 0xd8) return { kind: 'image', ext: '.jpg', contentType: 'image/jpeg' };
  const byPath = /\.(pdf|html?|csv|json|md|txt)(?:$|\?)/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
  if (byPath === 'pdf') return { kind: 'pdf', ext: '.pdf', contentType: 'application/pdf' };
  if (byPath === 'htm' || byPath === 'html') return { kind: 'html', ext: '.html', contentType: 'text/html' };
  if (byPath === 'csv') return { kind: 'data', ext: '.csv', contentType: 'text/csv' };
  if (byPath === 'json') return { kind: 'data', ext: '.json', contentType: 'application/json' };
  if (byPath === 'md' || byPath === 'txt') return { kind: 'text', ext: '.md', contentType: 'text/plain' };
  return null;
}

/* --------------------------------------------------------------- manifest */

/** One writer at a time per data dir: captures run in parallel collector sessions. */
const locks = new Map<string, Promise<unknown>>();
function serialized<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(dataDir) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(dataDir, run.catch(() => {}));
  return run;
}

export function readManifest(dataDir: string): Manifest {
  try {
    const raw = JSON.parse(fs.readFileSync(safePath(dataDir, CAPTURE_MANIFEST), 'utf8')) as Partial<Manifest>;
    return { version: 1, entries: Array.isArray(raw.entries) ? raw.entries.filter((e) => e && typeof e.path === 'string') : [] };
  } catch {
    return { version: 1, entries: [] };
  }
}

function writeManifest(dataDir: string, manifest: Manifest): void {
  const abs = safePath(dataDir, CAPTURE_MANIFEST);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(tmp, abs);
}

/** The captures a study made or reused, oldest first. */
export function studyCaptures(dataDir: string, studyId: string): ManifestEntry[] {
  return readManifest(dataDir).entries.filter((e) => e.studies.some((s) => s.id === studyId) && fs.existsSync(safePath(dataDir, e.path)));
}

export function studyFolder(slug: string): string {
  return `${RESEARCH_RAW_DIR}/${slug}`;
}

export function registerPath(slug: string): string {
  return `${studyFolder(slug)}/sources.md`;
}

const cell = (s: string | null | undefined) => (s ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim();

/**
 * Rewrite a study's register from the manifest: one row per capture, the file
 * as a workspace path (which the viewers open), the URL, the date and why it
 * was taken. Regenerated, never appended, so parallel captures cannot
 * interleave rows.
 */
export function writeRegister(dataDir: string, study: { id: string; slug: string; title?: string }, actor: string): string {
  const rel = registerPath(study.slug);
  const rows = studyCaptures(dataDir, study.id);
  const lines = [
    '---',
    `title: ${JSON.stringify(`Sources — ${study.title ?? study.slug}`)}`,
    'type: research-sources',
    `study: ${JSON.stringify(study.id)}`,
    `updated: ${JSON.stringify(new Date().toISOString())}`,
    '---',
    '',
    `# Sources — ${study.title ?? study.slug}`,
    '',
    `Every document this study captured or reused, as knode fetched it. Files are originals; PDFs and web pages read as their converted Markdown.`,
    '',
    '| # | Title | Site | Published | Type | File | URL | Why |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map((e, i) => {
      const why = e.studies.find((s) => s.id === study.id)?.why ?? '';
      return `| ${i + 1} | ${cell(e.title) || '—'} | ${cell(e.site)} | ${cell(e.published) || '—'} | ${e.kind} | \`${e.path}\` | <${e.urls[e.urls.length - 1] ?? e.url}> | ${cell(why)} |`;
    }),
    '',
  ];
  const text = lines.join('\n');
  recordOrigin(dataDir, rel, text, actor);
  writeFileBytes(dataDir, rel, Buffer.from(text));
  return rel;
}

/* --------------------------------------------------------------- indexing */

const pendingSyncs = new Map<string, Set<Promise<unknown>>>();

function indexInBackground(ctx: AppContext, rels: string[]): Promise<unknown> {
  const p = sync(ctx, { only: rels, actor: 'research' }).catch(() => {});
  let set = pendingSyncs.get(ctx.dataDir);
  if (!set) pendingSyncs.set(ctx.dataDir, (set = new Set()));
  set.add(p);
  void p.finally(() => set!.delete(p));
  return p;
}

/** Wait until every capture sync started for this data dir has finished (a study does before its pages are written). */
export async function waitForCaptureIndexing(dataDir: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const set = pendingSyncs.get(dataDir);
    if (!set || set.size === 0) return;
    await Promise.allSettled([...set]);
  }
}

/* ---------------------------------------------------------------- capture */

function uniquePath(dataDir: string, dir: string, stem: string, ext: string, sha: string): string {
  for (let n = 1; n < 100; n++) {
    const rel = `${dir}/${stem}${n > 1 ? `-${n}` : ''}${ext}`;
    const abs = safePath(dataDir, rel);
    if (!fs.existsSync(abs)) return rel;
    if (sha256(fs.readFileSync(abs)) === sha) return rel;
  }
  return `${dir}/${stem}-${sha.slice(0, 8)}${ext}`;
}

async function pdfInfo(body: Buffer): Promise<{ title: string | null; published: string | null; pages: number | null }> {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(body), useSystemFonts: true, isEvalSupported: false }).promise;
    const meta = await doc.getMetadata().catch(() => null);
    const info = (meta?.info ?? {}) as Record<string, unknown>;
    const title = typeof info.Title === 'string' && info.Title.trim() ? info.Title.trim() : null;
    const created = typeof info.CreationDate === 'string' ? /D:(\d{4})(\d{2})(\d{2})/.exec(info.CreationDate) : null;
    const pages = doc.numPages;
    await doc.destroy();
    return { title, published: created ? `${created[1]}-${created[2]}-${created[3]}` : null, pages };
  } catch {
    return { title: null, published: null, pages: null };
  }
}

function outlineOf(markdown: string, max = 40): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  let fence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2].slice(0, 120) });
    if (out.length >= max) break;
  }
  return out;
}

/** What a capture looks like as a result, for one already on file. */
function resultFrom(dataDir: string, e: ManifestEntry, asked: string, reused: boolean, warnings: string[] = []): CaptureResult {
  let outline: { level: number; text: string }[] = [];
  let chars: number | null = null;
  try {
    const derived = safePath(dataDir, `${sidecarRelFor(e.path)}/content.md`);
    const text = fs.existsSync(derived) ? fs.readFileSync(derived, 'utf8') : e.kind === 'text' || e.kind === 'excerpt' ? fs.readFileSync(safePath(dataDir, e.path), 'utf8') : '';
    if (text) {
      chars = text.length;
      outline = outlineOf(readMatter(text).content);
    }
  } catch {
    /* the outline is a convenience */
  }
  return {
    path: e.path, url: asked, finalUrl: e.urls[e.urls.length - 1] ?? e.url, title: e.title, site: e.site, kind: e.kind,
    contentType: e.contentType, bytes: e.bytes, sha256: e.sha256, reused, published: e.published, readPath: e.path, chars, outline, warnings,
  };
}

/**
 * Capture one URL (or, with `content`, an excerpt of it). Throws a readable
 * error when the URL cannot be fetched or holds nothing worth keeping — the
 * message tells an agent what to do instead.
 */
export async function captureUrl(ctx: AppContext, req: CaptureRequest): Promise<CaptureResult> {
  const web = ctx.config.research.web;
  const asked = req.url.trim();
  // an excerpt is never fetched, so its URL is checked here: it ends up in a register people click
  if (!/^https?:\/\/[^\s]+$/i.test(asked)) throw new Error(`not an http(s) URL: ${asked.slice(0, 200)}`);
  const key = normalizeUrl(asked);
  const studyDir = req.study ? studyFolder(req.study.slug) : `${RESEARCH_RAW_DIR}/${LOOSE_CAPTURES}`;
  assertWritablePath(studyDir);
  assertNotLinked(ctx.config, studyDir, 'capture into');
  const now = new Date().toISOString();

  // an earlier capture of this URL: reuse it, and list it in this study's register too
  const known = await serialized(ctx.dataDir, async () => {
    const manifest = readManifest(ctx.dataDir);
    const hit = manifest.entries.find((e) => (e.url === key || e.urls.some((u) => normalizeUrl(u) === key)) && fs.existsSync(safePath(ctx.dataDir, e.path)));
    if (!hit || req.content) return null;
    if (req.study && !hit.studies.some((s) => s.id === req.study!.id)) {
      hit.studies.push({ id: req.study.id, slug: req.study.slug, why: req.why ?? '', at: now });
      writeManifest(ctx.dataDir, manifest);
    }
    return hit;
  });
  if (known) {
    if (req.study) writeRegister(ctx.dataDir, req.study, req.actor);
    return resultFrom(ctx.dataDir, known, asked, true);
  }
  if (req.study && req.maxCaptures && studyCaptures(ctx.dataDir, req.study.id).length >= req.maxCaptures) {
    throw new Error(`this study already holds ${req.maxCaptures} captures (research.study.maxCaptures): cite what is captured, or capture only what is essential`);
  }

  let kind: CaptureKind;
  let bytes: Buffer;
  /** What identifies the document: the bytes as fetched (the stored file adds a provenance line that differs per capture). */
  let contentSha = '';
  let contentType: string;
  let finalUrl = asked;
  let title: string | null = req.title?.trim() || null;
  let published: string | null = null;
  let outline: { level: number; text: string }[] = [];
  let chars: number | null = null;
  const warnings: string[] = [];
  let ext: string;
  let dir: string;

  if (req.content !== undefined) {
    // the agent's transcription of a page knode could not fetch: an excerpt, labelled as such
    const text = req.content.slice(0, 400_000).trim();
    if (meaningfulLength(text) < 40) throw new Error('content is too short to keep as an excerpt');
    kind = 'excerpt';
    contentType = 'text/markdown';
    ext = '.md';
    dir = `${studyDir}/web`;
    const body = [
      '---',
      `title: ${JSON.stringify(title ?? `Excerpt from ${siteOf(asked) || asked}`)}`,
      `url: ${JSON.stringify(asked)}`,
      `fetched: ${JSON.stringify(now)}`,
      'source_type: "excerpt"',
      `transcribed_by: ${JSON.stringify(req.actor)}`,
      ...(req.why ? [`why: ${JSON.stringify(req.why)}`] : []),
      '---',
      '',
      `> Transcribed by ${req.actor} from <${asked}> on ${now.slice(0, 10)}: knode could not fetch the page itself, so this is the agent's reading of it, not the page.`,
      '',
      text,
      '',
    ].join('\n');
    bytes = Buffer.from(body);
    contentSha = sha256(text);
    chars = text.length;
    outline = outlineOf(text);
  } else {
    const res: FetchedResponse = req.prefetched ?? await guardedFetch(asked, web, { accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,text/*;q=0.8,application/json;q=0.7,image/*;q=0.5,*/*;q=0.1' });
    finalUrl = res.finalUrl;
    contentSha = sha256(res.body);
    if (res.truncated) throw new Error(`${siteOf(finalUrl)}: the document is larger than research.web.maxBytes (${web.maxBytes} bytes) — capture a smaller part (a single exhibit, a page of the filing index) or raise the limit`);
    const what = classify(res.contentType, res.body, finalUrl);
    if (!what) throw new Error(`${siteOf(finalUrl)} returned ${res.contentType || 'an unknown type'}: knode keeps HTML, PDF, text, CSV / JSON / XML and images — find the HTML or PDF version, or pass the text you read as \`content\``);
    kind = what.kind;
    contentType = what.contentType;
    ext = what.ext;
    dir = `${studyDir}/${kind === 'html' ? 'web' : 'files'}`;
    if (kind === 'html') {
      const { text: html, charset } = decodeText(res.body, res.charset, res.contentType);
      const conv = htmlToMarkdown(html, { baseUrl: finalUrl });
      if (meaningfulLength(conv.markdown) < 200) {
        throw new Error(`${siteOf(finalUrl)}: the page has almost no text without JavaScript or behind its login (${conv.warnings.join('; ') || 'nothing readable'}) — capture another URL for it, or pass the text you read as \`content\` to keep an excerpt`);
      }
      title = conv.meta.title ?? title;
      published = conv.meta.published;
      outline = conv.outline.slice(0, 40).map((h) => ({ level: h.level, text: h.text }));
      chars = conv.markdown.length;
      warnings.push(...conv.warnings);
      // the page as fetched, as UTF-8, under one line that says where it came from; the BOM
      // says UTF-8 to a browser that opens the file, over a GBK page's own <meta charset>
      const prior = readCaptureComment(html);
      const head = captureComment({
        url: asked, finalUrl, fetched: now, contentType: res.contentType, charset, sha256: sha256(res.body), by: req.actor,
        ...(req.study ? { study: req.study.id } : {}), ...(req.why ? { why: req.why } : {}),
      });
      bytes = Buffer.from(`\uFEFF${prior ? html : head + html}`);
    } else if (kind === 'pdf') {
      const info = await pdfInfo(res.body);
      title = info.title ?? title;
      published = info.published;
      if (info.pages && info.pages > RESEARCH_MAX_PDF_PAGES) warnings.push(`${info.pages} pages: only the first ${RESEARCH_MAX_PDF_PAGES} are converted`);
      bytes = res.body;
    } else if (kind === 'text') {
      const { text } = decodeText(res.body, res.charset, res.contentType);
      const fm = readMatter(text);
      const body = [
        '---',
        `title: ${JSON.stringify(title ?? (typeof fm.data.title === 'string' ? fm.data.title : siteOf(finalUrl)))}`,
        `url: ${JSON.stringify(finalUrl)}`,
        `fetched: ${JSON.stringify(now)}`,
        `captured_by: ${JSON.stringify(req.actor)}`,
        '---',
        '',
        fm.content.trim(),
        '',
      ].join('\n');
      bytes = Buffer.from(body);
      chars = fm.content.length;
      outline = outlineOf(fm.content);
    } else {
      bytes = res.body;
      if (kind === 'data') chars = res.body.length;
    }
  }

  const sha = sha256(bytes);
  const site = siteOf(finalUrl) || siteOf(asked);
  const finalKey = normalizeUrl(finalUrl);
  const rel = await serialized(ctx.dataDir, async () => {
    const manifest = readManifest(ctx.dataDir);
    // the same document by another way in (a redirect to a URL already kept, a mirror with the same bytes): one file
    const same = manifest.entries.find((e) => (e.sha256 === contentSha || e.url === finalKey || e.urls.some((u) => normalizeUrl(u) === finalKey))
      && e.kind !== 'excerpt' && kind !== 'excerpt' && fs.existsSync(safePath(ctx.dataDir, e.path)));
    if (same) {
      if (!same.urls.includes(asked)) same.urls.push(asked);
      if (req.study && !same.studies.some((s) => s.id === req.study!.id)) same.studies.push({ id: req.study.id, slug: req.study.slug, why: req.why ?? '', at: now });
      writeManifest(ctx.dataDir, manifest);
      return { rel: same.path, reused: same };
    }
    const target = uniquePath(ctx.dataDir, dir, stemFor({ published, site, title, url: finalUrl }), ext, sha);
    recordOrigin(ctx.dataDir, target, bytes, req.actor);
    writeFileBytes(ctx.dataDir, target, bytes);
    const entry: ManifestEntry = {
      url: key, urls: [...new Set([asked, finalUrl])], path: target, sha256: contentSha, kind, contentType, title, site, published,
      fetched: now, by: req.actor, bytes: bytes.length,
      studies: req.study ? [{ id: req.study.id, slug: req.study.slug, why: req.why ?? '', at: now }] : [],
    };
    manifest.entries.push(entry);
    writeManifest(ctx.dataDir, manifest);
    return { rel: target, reused: null as ManifestEntry | null };
  });
  if (req.study) writeRegister(ctx.dataDir, req.study, req.actor);

  const toIndex = [rel.rel, ...(req.study ? [registerPath(req.study.slug)] : [])];
  if (req.index === 'wait') await sync(ctx, { only: toIndex, actor: 'research' });
  else if (req.index !== 'none') void indexInBackground(ctx, toIndex);

  if (rel.reused) return resultFrom(ctx.dataDir, rel.reused, asked, true, warnings);
  return {
    path: rel.rel, url: asked, finalUrl, title, site, kind, contentType, bytes: bytes.length, sha256: contentSha, reused: false, published,
    readPath: rel.rel, chars, outline, warnings,
  };
}

/* ------------------------------------------------------------ fetch only */

export interface ReadableFetch {
  url: string;
  finalUrl: string;
  title: string | null;
  contentType: string;
  published: string | null;
  /** The slice asked for (offset / limit, in characters). */
  text: string;
  totalChars: number;
  nextOffset: number | null;
  warnings: string[];
}

/**
 * Read a URL without keeping it — for deciding whether it is worth a
 * capture. HTML comes back as readable Markdown, text as it is; anything else
 * is described, not decoded (capture a PDF to read it).
 */
export async function fetchReadable(ctx: AppContext, url: string, opts: { offset?: number; limit?: number } = {}): Promise<ReadableFetch> {
  const res = await guardedFetch(url, ctx.config.research.web, { accept: 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8,*/*;q=0.1', maxBytes: Math.min(ctx.config.research.web.maxBytes, 15 * 1024 * 1024) });
  const what = classify(res.contentType, res.body, res.finalUrl);
  let text: string;
  let title: string | null = null;
  let published: string | null = null;
  const warnings: string[] = [];
  if (what?.kind === 'html') {
    const conv = htmlToMarkdown(decodeText(res.body, res.charset, res.contentType).text, { baseUrl: res.finalUrl });
    text = conv.markdown;
    title = conv.meta.title;
    published = conv.meta.published;
    warnings.push(...conv.warnings);
  } else if (what?.kind === 'text' || what?.kind === 'data') {
    text = decodeText(res.body, res.charset, res.contentType).text;
  } else {
    text = `(${what?.contentType ?? (res.contentType || 'unknown type')}, ${res.body.length} bytes — not text: capture it with knode_capture to read it as Markdown)`;
  }
  if (res.truncated) warnings.push('the response was cut at the size limit');
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = Math.min(60_000, Math.max(1_000, Math.floor(opts.limit ?? 30_000)));
  const slice = text.slice(offset, offset + limit);
  return {
    url, finalUrl: res.finalUrl, title, contentType: what?.contentType ?? res.contentType, published,
    text: slice, totalChars: text.length, nextOffset: offset + limit < text.length ? offset + limit : null, warnings,
  };
}
