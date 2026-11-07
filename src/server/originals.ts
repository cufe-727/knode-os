import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { assertNotPrivate, safePath } from '../fs/files.js';
import { isEpubFile, pictureEntry, splitBookPath } from '../ingest/converters/epub.js';
import { decodeSavedHtml, isHtmlFile, readCaptureComment } from '../ingest/converters/html.js';

/**
 * A file as it was, for people to read: `GET /api/file/original`.
 *
 * The file view shows the Markdown knode-os derived from a PDF, an image or a
 * saved web page; this answers with the file itself. A PDF or a picture goes
 * out byte for byte. A web page is someone else's HTML, so it never runs as
 * ours: the response is sandboxed (a unique origin, no script, no form, no
 * plugin), and the page carries a policy of its own that keeps script off
 * wherever it is opened, a browser tab or a copy the Mac app saved. Its
 * relative links and pictures point back at the site it was captured from (a
 * `<base>` from the capture record), so it is drawn with that site's styles
 * and images, fetched by whoever reads it; a `<meta http-equiv="refresh">`,
 * which would carry the reader off to the live site, is dropped. Its text goes
 * out as UTF-8 behind a BOM, whatever the page declared.
 *
 * An EPUB goes out as a download (no browser shows one; the Mac app hands it
 * to Books), and a book is a folder of its own pictures: a path through it,
 * `raw/docs/x.epub/OEBPS/images/fig1.jpg`, answers with that picture from
 * inside the book — what the Markdown derived from it shows (src/ingest/
 * converters/epub.ts). Only pictures: a chapter's XHTML never goes out as a page.
 */

export class OriginalError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404) {
    super(message);
  }
}

/** What a browser shows as it is, by extension. */
const TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xhtml': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.svg': 'image/svg+xml',
  '.epub': 'application/epub+zip',
};

/** The type a file goes out as, or null when it is not one a browser shows as it is. */
export function originalType(rel: string): string | null {
  return TYPES[path.extname(rel).toLowerCase()] ?? null;
}

/** In the page itself: holds wherever the copy is opened, a tab or a file on disk. */
export const PAGE_POLICY = "script-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'";

/** On the response: a sandbox (a unique origin, no script or form) that may draw the page with its site's styles, fonts and pictures. */
const PAGE_RESPONSE_POLICY = [
  'sandbox allow-popups allow-popups-to-escape-sandbox',
  "default-src 'none'",
  'img-src https: http: data:',
  "style-src https: http: 'unsafe-inline'",
  'font-src https: http: data:',
  'media-src https: http: data:',
  "frame-ancestors 'none'",
].join('; ');

/** An SVG is a document that can hold script: a sandbox too, drawing only itself. */
const SVG_POLICY = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'none'";

const OTHER_POLICY = "default-src 'none'; frame-ancestors 'none'";

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * A saved page made safe to open: the page's policy and a `<base>` at the
 * top of its head, no meta refresh. The base is the page's own one resolved
 * against the address it came from, or that address.
 */
export function originalHtml(html: string): string {
  const capture = readCaptureComment(html);
  const from = capture?.finalUrl ?? capture?.url;
  const tags = [`<meta http-equiv="Content-Security-Policy" content="${attr(PAGE_POLICY)}">`];
  if (from) {
    const theirs = /<base\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(html);
    const href = (theirs?.[1] ?? theirs?.[2] ?? theirs?.[3] ?? '').replace(/&amp;/gi, '&').trim();
    try {
      const base = new URL(href, from);
      if (/^https?:$/.test(base.protocol)) tags.push(`<base href="${attr(base.toString())}">`);
    } catch {
      // an address that does not parse: links stay as the page wrote them
    }
  }
  const page = html.replace(/<meta\b[^>]*\bhttp-equiv\s*=\s*["']?\s*refresh\b[^>]*>/gi, '');
  const at = /<head(?=[\s>/])[^>]*>/i.exec(page) ?? /<html(?=[\s>])[^>]*>/i.exec(page) ?? /<!doctype[^>]*>/i.exec(page);
  const cut = at ? at.index + at[0].length : 0;
  return page.slice(0, cut) + tags.join('') + page.slice(cut);
}

const contentDisposition = (rel: string, inline: boolean) => {
  const name = path.basename(rel);
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

/** The answer to `GET /api/file/original`: the bytes and the headers they go out with. */
export function readOriginal(dataDir: string, rel: string): { body: Uint8Array<ArrayBuffer> | ReadableStream; headers: Record<string, string> } {
  try {
    assertNotPrivate(rel);
  } catch (e) {
    throw new OriginalError((e as Error).message, 403);
  }
  const inBook = splitBookPath(rel);
  if (inBook && !fs.existsSync(safePath(dataDir, rel))) return readBookPicture(dataDir, rel, inBook);
  const type = originalType(rel);
  if (!type) throw new OriginalError(`${rel} is not a PDF, a book, a web page or a picture: open it in the file view`, 400);
  const abs = safePath(dataDir, rel);
  const stat = fs.existsSync(abs) ? fs.statSync(abs) : null;
  if (!stat?.isFile()) throw new OriginalError(`${rel} does not exist`, 404);
  const headers: Record<string, string> = {
    'content-type': type,
    'content-disposition': contentDisposition(rel, !isEpubFile(rel)),
    'content-security-policy': OTHER_POLICY,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'cache-control': 'private, no-cache',
  };
  if (isHtmlFile(rel)) {
    const body = Buffer.from(`\uFEFF${originalHtml(decodeSavedHtml(fs.readFileSync(abs)))}`);
    return { body, headers: { ...headers, 'content-security-policy': PAGE_RESPONSE_POLICY, 'content-length': String(body.length) } };
  }
  if (type === 'image/svg+xml') headers['content-security-policy'] = SVG_POLICY;
  const body = Readable.toWeb(fs.createReadStream(abs)) as unknown as ReadableStream;
  return { body, headers: { ...headers, 'content-length': String(stat.size) } };
}

/** A picture from inside a book, for the Markdown derived from it to show. */
function readBookPicture(dataDir: string, rel: string, at: { book: string; entry: string }): { body: Uint8Array<ArrayBuffer>; headers: Record<string, string> } {
  try {
    assertNotPrivate(at.book);
  } catch (e) {
    throw new OriginalError((e as Error).message, 403);
  }
  const abs = safePath(dataDir, at.book);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new OriginalError(`${at.book} does not exist`, 404);
  let picture: { bytes: Buffer; type: string };
  try {
    picture = pictureEntry(abs, at.entry);
  } catch (e) {
    throw new OriginalError(`${rel}: ${(e as Error).message}`, 404);
  }
  const body = new Uint8Array(picture.bytes.buffer as ArrayBuffer, picture.bytes.byteOffset, picture.bytes.byteLength);
  return {
    body,
    headers: {
      'content-type': picture.type,
      'content-disposition': contentDisposition(at.entry, true),
      'content-security-policy': picture.type === 'image/svg+xml' ? SVG_POLICY : OTHER_POLICY,
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin',
      // the book's bytes decide the picture: unchanged book, unchanged picture
      'cache-control': 'private, no-cache',
      'content-length': String(body.byteLength),
    },
  };
}
