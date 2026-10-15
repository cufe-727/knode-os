import type { MiddlewareHandler } from 'hono';

/**
 * The public boundary of `serve`.
 *
 * The web UI, `/api` and `/mcp` still trust the workspace headers a client
 * sends (a mock login), so nothing but the token-authenticated remote API may
 * be reached from outside this machine. A request counts as public when it
 * names any host other than loopback, or when a proxy touched it — the
 * Cloudflare Tunnel adds `cf-*` headers, nginx and others add forwarding
 * headers. Such a request reaches `/remote/v1` only, and only over HTTPS;
 * everything else answers 404 as if it did not exist.
 *
 * An SSH-forwarded request arrives on loopback with a loopback Host and stays
 * local: whoever holds an SSH session on this machine is trusted with it
 * already.
 */

export const PUBLIC_PREFIX = '/remote/v1';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const PROXY_HEADERS = ['cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cdn-loop', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded'];

/** Hostname of a Host header: lower-cased, port dropped, IPv6 brackets kept. */
export function hostnameOf(host: string | null | undefined): string {
  const h = (host ?? '').trim().toLowerCase();
  if (!h) return '';
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  const colon = h.lastIndexOf(':');
  return colon > -1 && h.indexOf(':') === colon ? h.slice(0, colon) : h;
}

/**
 * `url` stands in for a missing Host header: the Node adapter builds the request
 * URL from the Host header, and an in-process request (tests) has no header at all.
 */
export function isPublicRequest(header: (name: string) => string | undefined, url?: string): boolean {
  let host = hostnameOf(header('host'));
  if (!host && url) {
    try {
      host = hostnameOf(new URL(url).host);
    } catch {
      host = '';
    }
  }
  if (!LOCAL_HOSTS.has(host)) return true;
  return PROXY_HEADERS.some((name) => header(name) !== undefined);
}

/** Whether a public request came in over HTTPS, as the edge reports it. */
export function publicRequestIsHttps(header: (name: string) => string | undefined): boolean {
  const visitor = header('cf-visitor');
  if (visitor) {
    try {
      return (JSON.parse(visitor) as { scheme?: string }).scheme === 'https';
    } catch {
      return false;
    }
  }
  return (header('x-forwarded-proto') ?? '').split(',')[0].trim().toLowerCase() === 'https';
}

export function publicGuard(): MiddlewareHandler {
  return async (c, next) => {
    const header = (name: string) => c.req.header(name);
    if (!isPublicRequest(header, c.req.url)) return next();
    const p = c.req.path;
    if (p !== PUBLIC_PREFIX && !p.startsWith(`${PUBLIC_PREFIX}/`)) return c.json({ error: 'not found' }, 404);
    if (!publicRequestIsHttps(header)) return c.json({ error: 'use https' }, 403);
    await next();
  };
}
