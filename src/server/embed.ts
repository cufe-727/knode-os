import fs from 'node:fs';
import path from 'node:path';
import type { Context, Hono } from 'hono';
import type { KnodeConfig } from '../config.js';
import { API_CSP, embedCsp } from './csp.js';

/**
 * The embeddable reader, for another app's iframe (`server.embed`):
 *
 *   /embed/v1?view=doc|folder|search&path=&q=&scope=&kind=&ws=&theme=&origin=#fragment
 *                  one document, folder or search of a workspace, drawn by the
 *                  web UI's own renderers in a page with a thin toolbar and no
 *                  app around it (web/embed/index.html, web/embed/embed.js)
 *   /embed/sdk.js  an ES module that mounts the reader in a host page
 *   /embed/embed.js, /embed/embed.css   the page's own files
 *
 * The page is the only one `serve` lets another site frame: it carries the
 * UI's policy with `frame-ancestors` opened to this origin and the exact
 * origins listed, and no X-Frame-Options. It holds nothing and signs in
 * nothing — it reads through /api with the browser's knode-os session
 * cookie (SameSite=Lax), which an iframe sends when its host is on the same
 * site — so, like the UI, it is served to anyone. The listed origins are
 * written into the page for the script to check its `origin` parameter
 * against: it talks to that origin alone, over postMessage.
 *
 * The SDK goes out with CORS for a listed origin, so a page there can import
 * it; elsewhere a browser refuses to run it as a module.
 */

/** A hostname as a URL parser leaves it: ASCII labels (an IDN arrives as xn--), or an IPv6 literal. */
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$|^\[[0-9a-f:.]+\]$/;

/** scheme://authority and at most a closing slash: no path, query, fragment, credentials or spaces. */
const ORIGIN_SHAPE = /^https?:\/\/[^/?#@\s]+\/?$/i;

/** One allowed origin, normalized the way a browser serializes it ("https://app.example.com"), or why it is not one. */
export function normalizeEmbedOrigin(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const shown = typeof raw === 'string' ? JSON.stringify(raw) : String(raw);
  if (!text) throw new Error(`${shown} is not an origin — write scheme://host[:port], such as https://app.example.com`);
  if (text.includes('*')) throw new Error(`${shown}: wildcards are not allowed — list each origin exactly`);
  if (!ORIGIN_SHAPE.test(text)) throw new Error(`${shown} is not an origin — write scheme://host[:port] (http or https), with no path, query or credentials`);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${shown} is not an origin — write scheme://host[:port], such as https://app.example.com`);
  }
  if (!HOSTNAME.test(url.hostname)) throw new Error(`${shown}: "${url.hostname}" is not a host name`);
  return url.origin;
}

/**
 * `server.embed.allowedOrigins`, checked and normalized: a list of exact
 * origins, each once. Throws on anything else, naming every bad entry —
 * `serve` refuses to start on it rather than frame for less (or more) than
 * was meant.
 */
export function parseEmbedOrigins(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('server.embed.allowedOrigins must be a list of origins, such as ["https://app.example.com"]');
  const origins: string[] = [];
  const problems: string[] = [];
  for (const entry of value) {
    try {
      const origin = normalizeEmbedOrigin(entry);
      if (!origins.includes(origin)) origins.push(origin);
    } catch (e) {
      problems.push((e as Error).message);
    }
  }
  if (problems.length) throw new Error(`server.embed.allowedOrigins: ${problems.join('; ')}`);
  return origins;
}

/** The origins a config lets frame the reader. */
export function embedOrigins(server: KnodeConfig['server']): string[] {
  return parseEmbedOrigins(server.embed?.allowedOrigins);
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The page's placeholder for the listed origins, filled in as it goes out. */
const ORIGINS_META = /<meta name="knode-embed-origins" content="[^"]*"\s*\/?>/;

/** The reader's own files, by the name they are asked for under /embed/. */
const ASSETS: Record<string, string> = {
  'embed.js': 'text/javascript',
  'embed.css': 'text/css',
};

export function mountEmbed(app: Hono<any>, opts: { webDir: string | null; allowedOrigins: readonly string[] }): void {
  const { webDir, allowedOrigins } = opts;
  const policy = embedCsp(allowedOrigins);
  const meta = `<meta name="knode-embed-origins" content="${attr(JSON.stringify(allowedOrigins))}">`;
  const read = (name: string) => (webDir ? fs.readFileSync(path.join(webDir, 'embed', name)) : null);
  const missing = (c: Context) => c.text('web UI assets not found', 404, { 'content-security-policy': API_CSP });

  // read on every request, as the rest of the UI is: `serve` answers from the live web/ folder
  const page = (c: Context) => {
    const html = read('index.html');
    if (!html) return missing(c);
    return c.body(html.toString('utf8').replace(ORIGINS_META, meta), 200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': policy,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'cache-control': 'no-cache',
    });
  };
  app.get('/embed/v1', page);
  app.get('/embed/v1/', page);

  app.get('/embed/sdk.js', (c) => {
    const js = read('sdk.js');
    if (!js) return missing(c);
    const origin = c.req.header('origin');
    const headers: Record<string, string> = {
      'content-type': 'text/javascript; charset=utf-8',
      'content-security-policy': API_CSP,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-cache',
      // a cached answer for one origin must not serve another
      vary: 'Origin',
    };
    if (origin && allowedOrigins.includes(origin)) headers['access-control-allow-origin'] = origin;
    return c.body(js, 200, headers);
  });

  app.get('/embed/:asset', (c) => {
    const type = ASSETS[c.req.param('asset')];
    if (!type) return c.text('not found', 404);
    const body = read(c.req.param('asset'));
    if (!body) return missing(c);
    return c.body(body, 200, { 'content-type': type, 'content-security-policy': API_CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' });
  });

  // nothing else under /embed: never the app's page, whose policy refuses every frame
  app.all('/embed', (c) => c.text('not found', 404));
  app.all('/embed/*', (c) => c.text('not found', 404));
}
