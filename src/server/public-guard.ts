import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

/**
 * Where a request comes from, and the boundary `serve` keeps without sign-in.
 *
 * A request is local when it arrives on a loopback connection, names a
 * loopback host and no proxy touched it. An SSH-forwarded request is local in
 * this sense: whoever holds an SSH session on this machine is trusted with it
 * already. Anything else is remote — a public hostname through the Cloudflare
 * Tunnel (which adds `cf-*` headers), another proxy (forwarding headers), or a
 * direct connection from another machine when `server.host` is not loopback.
 *
 * Proxy headers are believed only from a proxy on this machine: a direct
 * connection from elsewhere can write any header it likes, so its address and
 * scheme come from the socket alone. The Host header alone never makes a
 * request local.
 *
 * With sign-in on (src/auth) every request needs an account wherever it comes
 * from, and remote ones are held to HTTPS and to the API groups their account
 * may use from outside. With sign-in off, `publicGuard` keeps the old boundary:
 * from outside, only the token-authenticated remote API exists.
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

export function isLoopbackAddress(address: string): boolean {
  const a = address.toLowerCase();
  return a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.');
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

/** Whether a proxied request came in over HTTPS, as the edge reports it. */
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

export interface ClientInfo {
  /** On this machine: loopback connection, loopback Host, no proxy (an SSH tunnel counts). */
  local: boolean;
  /** Reached `serve` over TLS — its own, or the edge's when a proxy on this machine forwarded it. */
  https: boolean;
  /** A proxy on this machine (cloudflared, nginx) forwarded the request. */
  proxied: boolean;
  /** The client's address, for rate limits and the audit: the edge's word only when a local proxy forwarded it. */
  ip: string;
}

/** The socket's peer, or null for an in-process request (tests) that has none. */
function peerOf(c: Context): { address: string; encrypted: boolean } | null {
  try {
    const address = getConnInfo(c).remote.address;
    if (!address) return null;
    const env = c.env as { incoming?: { socket?: { encrypted?: boolean } }; server?: { incoming?: { socket?: { encrypted?: boolean } } } } | undefined;
    const socket = (env?.server?.incoming ?? env?.incoming)?.socket;
    return { address, encrypted: Boolean(socket?.encrypted) };
  } catch {
    return null;
  }
}

function forwardedClient(header: (name: string) => string | undefined): string | null {
  const value = header('cf-connecting-ip') ?? header('x-forwarded-for')?.split(',')[0] ?? header('x-real-ip');
  const ip = value?.trim();
  return ip ? ip.slice(0, 64) : null;
}

export function clientInfo(c: Context): ClientInfo {
  const header = (name: string) => c.req.header(name);
  const peer = peerOf(c);
  // in-process requests have no socket: they are this process, so the rest decides
  const peerLocal = peer ? isLoopbackAddress(peer.address) : true;
  const proxyHeaders = PROXY_HEADERS.some((name) => header(name) !== undefined);
  const proxied = peerLocal && proxyHeaders;
  const local = peerLocal && !isPublicRequest(header, c.req.url);
  const tls = peer ? peer.encrypted : c.req.url.startsWith('https:');
  const https = tls || (proxied && publicRequestIsHttps(header));
  const ip = (proxied ? forwardedClient(header) : null) ?? peer?.address ?? 'local';
  return { local, https, proxied, ip };
}

/** Sign-in off: from outside this machine only the remote API exists, and only over HTTPS. */
export function publicGuard(opts: { allowInsecureRemote?: boolean } = {}): MiddlewareHandler {
  return async (c, next) => {
    const client = clientInfo(c);
    if (client.local) return next();
    const p = c.req.path;
    if (p !== PUBLIC_PREFIX && !p.startsWith(`${PUBLIC_PREFIX}/`)) return c.json({ error: 'not found' }, 404);
    if (!client.https && !opts.allowInsecureRemote) return c.json({ error: 'use https' }, 403);
    await next();
  };
}
