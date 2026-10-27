import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import type { ResearchWebConfig } from '../config.js';

/**
 * The one way research reaches the web: a GET (or a search API's POST) that
 * knode itself makes, for a URL an agent — or a person — picked.
 *
 * Because the URL may come from an agent, which read it on a page anyone could
 * have written, the request must not become a way into this machine: only
 * http(s), and never a private, loopback, link-local or otherwise reserved
 * address unless `research.web.allowPrivateHosts` says so. The check runs on
 * every address a host resolves to, on every redirect hop, and — on a direct
 * connection — inside the socket's own DNS lookup, so a name cannot pass the
 * check and then resolve somewhere else. Through a proxy the proxy resolves;
 * the same check runs on our own resolution first.
 *
 * Proxies are honoured the way curl honours them (HTTPS_PROXY / HTTP_PROXY /
 * ALL_PROXY, NO_PROXY), because Node's own fetch does not, and a machine
 * behind one would otherwise find that research cannot reach anything. HTTPS
 * goes through a CONNECT tunnel, so the proxy never sees the content.
 *
 * Bodies are capped (`maxBytes`), decompressed (gzip, deflate, br) and
 * returned as bytes; decoding is the caller's (`decodeText`).
 */

export interface FetchedResponse {
  /** As asked. */
  url: string;
  /** After redirects. */
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  /** Lower-case MIME type without parameters ('' when the server sent none). */
  contentType: string;
  /** The charset the Content-Type header names, if any. */
  charset: string | null;
  body: Buffer;
  /** The body was cut at maxBytes. */
  truncated: boolean;
}

/** A URL the guard will not fetch (scheme, private address, too many redirects). */
export class FetchRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchRefused';
  }
}

/** The server answered, with an error status. */
export class FetchHttpError extends Error {
  constructor(readonly status: number, readonly url: string, message: string) {
    super(message);
    this.name = 'FetchHttpError';
  }
}

export interface GuardedRequest {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  accept?: string;
  maxBytes?: number;
  timeoutMs?: number;
  /**
   * The URL came from configuration a person wrote (a search provider's base
   * URL), not from an agent: private addresses are allowed for it.
   */
  trusted?: boolean;
  /** Return 4xx/5xx responses instead of throwing (a search API's error body is worth reading). */
  allowErrorStatus?: boolean;
}

const MAX_REDIRECTS = 5;

/* ------------------------------------------------------------ address guard */

const BLOCKED = new net.BlockList();
for (const [net4, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED.addSubnet(net4, bits, 'ipv4');
for (const [net6, bits] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64],
] as const) BLOCKED.addSubnet(net6, bits, 'ipv6');

/** The IPv4 address inside an IPv4-mapped or NAT64 IPv6 address, if any. */
function embeddedIpv4(ip: string): string | null {
  const m = /^(?:::ffff:|64:ff9b::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(ip);
  if (!m) return null;
  if (m[1]) return m[1];
  const hi = parseInt(m[2], 16);
  const lo = parseInt(m[3], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True for an address research must not reach: private, loopback, link-local, reserved, multicast. */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = net.isIP(bare);
  if (family === 4) return BLOCKED.check(bare, 'ipv4');
  if (family === 6) {
    const v4 = embeddedIpv4(bare);
    if (v4) return BLOCKED.check(v4, 'ipv4');
    return BLOCKED.check(bare, 'ipv6');
  }
  return true; // not an address at all: refuse rather than guess
}

/**
 * Fake-IP DNS. Proxy tools (Clash, mihomo, Surge, sing-box) answer every name
 * with an address from a reserved range and resolve the real one themselves
 * when the connection reaches them — on such a machine every public site
 * "resolves" to 198.18.x.x or fdfe:dcba:9876::x, which the check above would
 * refuse. A name that resolves only into these ranges is checked again
 * against public resolvers: a real private answer is still refused; a name
 * they cannot reach either (the proxy owns all DNS) is let through, because
 * the proxy will resolve it and nothing local can say where. An IP literal in
 * these ranges is always refused — no real host has one.
 */
const FAKE_IP = new net.BlockList();
FAKE_IP.addSubnet('198.18.0.0', 15, 'ipv4');
FAKE_IP.addSubnet('fdfe:dcba:9876::', 64, 'ipv6'); // mihomo / Clash Meta fake-ip-range6
FAKE_IP.addSubnet('fc00::', 18, 'ipv6'); // sing-box inet6_range

export function isFakeIp(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (net.isIPv4(bare)) return FAKE_IP.check(bare, 'ipv4');
  if (!net.isIPv6(bare)) return false;
  const v4 = embeddedIpv4(bare);
  return v4 ? FAKE_IP.check(v4, 'ipv4') : FAKE_IP.check(bare, 'ipv6');
}

const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8', '223.5.5.5'];
const publicAnswers = new Map<string, { at: number; addrs: string[] }>();

/** The name's addresses from public resolvers, fake answers left out; [] when none answers. Cached ten minutes. */
async function resolvePublicly(host: string): Promise<string[]> {
  const hit = publicAnswers.get(host);
  if (hit && Date.now() - hit.at < 600_000) return hit.addrs;
  const r = new dns.promises.Resolver({ timeout: 1500, tries: 1 });
  r.setServers(PUBLIC_RESOLVERS);
  const [a, aaaa] = await Promise.allSettled([r.resolve4(host), r.resolve6(host)]);
  const addrs = [...(a.status === 'fulfilled' ? a.value : []), ...(aaaa.status === 'fulfilled' ? aaaa.value : [])].filter((x) => !isFakeIp(x));
  publicAnswers.set(host, { at: Date.now(), addrs });
  return addrs;
}

/** Of a name's addresses, the ones research may not reach (fake-IP answers are the proxy's to resolve). */
function forbiddenAddresses(host: string, addrs: { address: string }[]): { address: string }[] {
  const literal = net.isIP(host.replace(/^\[|\]$/g, '')) !== 0;
  return addrs.filter((a) => isPrivateAddress(a.address) && (literal || !isFakeIp(a.address)));
}

/** Names that mean "this machine" or the local network whatever DNS says. */
function isLocalName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h === 'metadata.google.internal';
}

async function resolveAll(host: string): Promise<{ address: string; family: number }[]> {
  if (net.isIP(host)) return [{ address: host, family: net.isIP(host) }];
  return dns.promises.lookup(host, { all: true, verbatim: true });
}

async function assertPublicHost(host: string, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) return;
  const bare = host.replace(/^\[|\]$/g, '');
  if (isLocalName(bare)) throw new FetchRefused(`refusing to fetch ${host}: a local name (research.web.allowPrivateHosts is off)`);
  let addrs: { address: string }[];
  try {
    addrs = await resolveAll(bare);
  } catch (err) {
    throw new Error(`cannot resolve ${host}: ${err instanceof Error ? err.message : err}`);
  }
  const [bad] = forbiddenAddresses(bare, addrs);
  if (bad) throw new FetchRefused(`refusing to fetch ${host}: it resolves to ${bad.address}, a private or reserved address (research.web.allowPrivateHosts is off)`);
  if (net.isIP(bare) === 0 && addrs.length > 0 && addrs.every((a) => isFakeIp(a.address))) {
    // a proxy's fake-IP answer: ask public resolvers where the name really points
    const real = (await resolvePublicly(bare)).find((x) => isPrivateAddress(x));
    if (real) throw new FetchRefused(`refusing to fetch ${host}: it resolves to ${real}, a private or reserved address (research.web.allowPrivateHosts is off)`);
  }
}

/** A socket lookup that re-checks what the name resolves to at connect time (no DNS rebinding between check and use). */
function guardedLookup(allowPrivate: boolean): net.LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void) => {
    dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addrs) => {
      if (err) return callback(err, '', 0);
      const list = addrs as dns.LookupAddress[];
      const bad = allowPrivate ? undefined : forbiddenAddresses(hostname, list)[0];
      if (bad) return callback(Object.assign(new FetchRefused(`refusing to connect to ${hostname} (${bad.address}): a private or reserved address`), { code: 'EREFUSED' }), '', 0);
      if (list.length === 0) return callback(Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' }), '', 0);
      if (options.all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  }) as net.LookupFunction;
}

/* -------------------------------------------------------------------- proxy */

interface ProxyChoice {
  url: URL;
  auth: string | null;
}

function noProxyMatches(host: string, port: string, list: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  for (const raw of list.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (raw === '*') return true;
    const [entry, entryPort] = raw.startsWith('[') ? [raw.slice(1, raw.indexOf(']')), raw.split(']:')[1]] : raw.split(':');
    if (entryPort && entryPort !== port) continue;
    const bare = entry.replace(/^\*?\./, '');
    if (h === bare || h.endsWith(`.${bare}`)) return true;
  }
  return false;
}

/** The proxy a request to `target` goes through, or null for a direct connection. */
export function proxyFor(target: URL, setting: string, env: NodeJS.ProcessEnv = process.env): ProxyChoice | null {
  const configured = setting.trim();
  if (configured === 'none') return null;
  let raw = configured;
  if (!raw) {
    const noProxy = env.NO_PROXY ?? env.no_proxy ?? '';
    const port = target.port || (target.protocol === 'https:' ? '443' : '80');
    if (noProxy && noProxyMatches(target.hostname, port, noProxy)) return null;
    raw = target.protocol === 'https:'
      ? env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy ?? ''
      : env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY ?? env.all_proxy ?? '';
  }
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:') return null; // socks / https proxies: not spoken here, go direct rather than fail oddly
  const auth = url.username ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}` : null;
  return { url, auth };
}

/** A TLS socket to target:port through an HTTP proxy's CONNECT tunnel. */
function tunnel(proxy: ProxyChoice, target: URL, timeoutMs: number): Promise<tls.TLSSocket> {
  const port = Number(target.port || 443);
  const host = target.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.url.hostname,
      port: Number(proxy.url.port || 80),
      method: 'CONNECT',
      path: `${net.isIPv6(host) ? `[${host}]` : host}:${port}`,
      headers: { Host: `${host}:${port}`, ...(proxy.auth ? { 'Proxy-Authorization': proxy.auth } : {}) },
      timeout: timeoutMs,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy ${proxy.url.host} refused the tunnel to ${host}:${port} (${res.statusCode})`));
        return;
      }
      const secure = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, ALPNProtocols: ['http/1.1'] });
      secure.once('secureConnect', () => resolve(secure));
      secure.once('error', reject);
    });
    req.once('timeout', () => req.destroy(new Error(`proxy ${proxy.url.host} did not answer within ${timeoutMs} ms`)));
    req.once('error', reject);
    req.end();
  });
}

/* ------------------------------------------------------------------ request */

function headerMap(raw: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  return out;
}

export function parseContentType(value: string | undefined): { contentType: string; charset: string | null } {
  const [mime, ...params] = (value ?? '').split(';');
  const charset = params.map((p) => /^\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(p)?.[1]).find(Boolean) ?? null;
  return { contentType: mime.trim().toLowerCase(), charset: charset ? charset.toLowerCase() : null };
}

function decoded(res: http.IncomingMessage): Readable {
  const enc = String(res.headers['content-encoding'] ?? '').trim().toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(zlib.createGunzip());
  if (enc === 'deflate') return res.pipe(zlib.createInflate());
  if (enc === 'br') return res.pipe(zlib.createBrotliDecompress());
  return res;
}

interface OneHop {
  status: number;
  headers: Record<string, string>;
  location: string | null;
  body: Buffer;
  truncated: boolean;
}

async function oneRequest(target: URL, web: ResearchWebConfig, req: GuardedRequest & { allowPrivate: boolean; deadline: number }): Promise<OneHop> {
  const timeoutMs = Math.max(1, req.deadline - Date.now());
  const maxBytes = req.maxBytes ?? web.maxBytes;
  const proxy = proxyFor(target, web.proxy ?? '');
  const headers: Record<string, string> = {
    'User-Agent': web.userAgent || 'knode-os',
    Accept: req.accept ?? '*/*',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en,zh;q=0.8,*;q=0.5',
    ...(req.headers ?? {}),
  };
  if (req.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(req.body));
  const isHttps = target.protocol === 'https:';
  const path = `${target.pathname || '/'}${target.search}`;

  let options: http.RequestOptions;
  if (proxy && isHttps) {
    const socket = await tunnel(proxy, target, timeoutMs);
    options = { createConnection: () => socket, host: target.hostname, path, headers: { Host: target.host, ...headers } };
  } else if (proxy) {
    // plain http through the proxy: the absolute URL is the request target
    options = {
      host: proxy.url.hostname, port: Number(proxy.url.port || 80), path: target.toString(),
      headers: { Host: target.host, ...headers, ...(proxy.auth ? { 'Proxy-Authorization': proxy.auth } : {}) },
    };
  } else {
    options = {
      host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port || (isHttps ? 443 : 80)), path, headers,
      lookup: guardedLookup(req.allowPrivate),
      ...(isHttps ? { servername: net.isIP(target.hostname) ? undefined : target.hostname } : {}),
    };
  }
  const lib = isHttps && !proxy ? https : http;
  return new Promise<OneHop>((resolve, reject) => {
    // `agent: false` would make Node build a fresh agent that ignores createConnection (the tunnel), so it is set only without one
    const r = lib.request({ ...options, method: req.method ?? 'GET', ...(options.createConnection ? {} : { agent: false }) }, (res) => {
      const status = res.statusCode ?? 0;
      const hdrs = headerMap(res.headers);
      if (status >= 300 && status < 400 && hdrs.location) {
        res.resume();
        resolve({ status, headers: hdrs, location: hdrs.location, body: Buffer.alloc(0), truncated: false });
        return;
      }
      const declared = Number(hdrs['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes && !req.allowErrorStatus) {
        res.destroy();
        reject(new FetchRefused(`${target.host} sent ${declared} bytes; research.web.maxBytes allows ${maxBytes}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      const stream = decoded(res);
      stream.on('data', (chunk: Buffer) => {
        if (truncated) return;
        if (size + chunk.length > maxBytes) {
          chunks.push(chunk.subarray(0, maxBytes - size));
          size = maxBytes;
          truncated = true;
          res.destroy();
          resolve({ status, headers: hdrs, location: null, body: Buffer.concat(chunks), truncated });
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      stream.once('end', () => resolve({ status, headers: hdrs, location: null, body: Buffer.concat(chunks), truncated }));
      stream.once('error', (err) => (truncated ? undefined : reject(err)));
    });
    const timer = setTimeout(() => r.destroy(new Error(`${target.host} did not answer within ${timeoutMs} ms`)), timeoutMs);
    timer.unref?.();
    r.once('close', () => clearTimeout(timer));
    r.once('error', reject);
    if (req.body !== undefined) r.write(req.body);
    r.end();
  });
}

/**
 * GET (or POST) a URL with the guard, the proxy, redirects (re-checked hop by
 * hop, at most five) and the size cap. A 4xx/5xx is a FetchHttpError unless
 * `allowErrorStatus`; the message says what the site refused, which is what
 * an agent needs to decide on another source.
 */
export async function guardedFetch(rawUrl: string, web: ResearchWebConfig, req: GuardedRequest = {}): Promise<FetchedResponse> {
  let target: URL;
  try {
    target = new URL(rawUrl.trim());
  } catch {
    throw new FetchRefused(`not a URL: ${rawUrl.slice(0, 200)}`);
  }
  const allowPrivate = Boolean(req.trusted) || web.allowPrivateHosts === true;
  const deadline = Date.now() + (req.timeoutMs ?? web.timeoutMs ?? 30_000);
  let method = req.method ?? 'GET';
  let body = req.body;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new FetchRefused(`refusing ${target.protocol} URLs: only http and https are fetched`);
    if (target.username || target.password) throw new FetchRefused('refusing a URL with credentials in it');
    await assertPublicHost(target.hostname, allowPrivate);
    const res = await oneRequest(target, web, { ...req, method, body, allowPrivate, deadline });
    if (res.location) {
      const next = new URL(res.location, target);
      // a 303 (and, by browser custom, a 301/302 after a POST) turns into a GET without a body
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      target = next;
      continue;
    }
    const { contentType, charset } = parseContentType(res.headers['content-type']);
    if (res.status >= 400 && !req.allowErrorStatus) {
      const hint = res.status === 403 || res.status === 401
        ? ' — the site refused knode\'s request (some publishers require a contact User-Agent: set research.web.userAgent; others block automated access entirely)'
        : res.status === 429 ? ' — rate limited; try again later' : '';
      throw new FetchHttpError(res.status, target.toString(), `${target.host} answered ${res.status}${hint}`);
    }
    return { url: rawUrl, finalUrl: target.toString(), status: res.status, headers: res.headers, contentType, charset, body: res.body, truncated: res.truncated };
  }
  throw new FetchRefused(`more than ${MAX_REDIRECTS} redirects from ${rawUrl}`);
}

/**
 * Text from fetched bytes: a BOM wins, then the header's charset, then a
 * `<meta charset>` / `http-equiv` in the first bytes of an HTML page, then
 * UTF-8. An encoding this Node cannot decode falls back to UTF-8 with a note.
 */
export function decodeText(body: Buffer, charset: string | null, contentType: string): { text: string; charset: string } {
  let label = charset ?? '';
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) label = 'utf-8';
  else if (body[0] === 0xff && body[1] === 0xfe) label = 'utf-16le';
  else if (body[0] === 0xfe && body[1] === 0xff) label = 'utf-16be';
  if (!label && /html|xml/.test(contentType || 'html')) {
    const head = body.subarray(0, 4096).toString('latin1');
    label = /<meta[^>]+charset\s*=\s*["']?([\w:.-]+)/i.exec(head)?.[1]
      ?? /<\?xml[^>]+encoding\s*=\s*["']([\w:.-]+)/i.exec(head)?.[1]
      ?? '';
  }
  label = (label || 'utf-8').toLowerCase();
  try {
    return { text: new TextDecoder(label).decode(body), charset: label };
  } catch {
    return { text: new TextDecoder('utf-8').decode(body), charset: 'utf-8' };
  }
}
