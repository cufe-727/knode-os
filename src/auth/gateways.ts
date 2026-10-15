import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Gateways — local services published under `/gw/<id>/…` on serve's own port,
 * so signed-in accounts can reach selected APIs of this machine from outside
 * without each service being exposed on its own.
 *
 * A gateway forwards to a loopback URL only: it publishes this machine's
 * services, never a door into the network behind it. Who may use one is the
 * account's `gateways` list (admins: all), and from outside this machine the
 * `gateway` API group too (src/auth/apis.ts). The caller's knode credentials
 * never reach the service — the session cookie is cut out of `Cookie`, a knode
 * bearer token out of `Authorization` — and the service learns who called from
 * `X-Knode-User`, which the gateway sets and a client cannot.
 *
 * Responses run sandboxed by default (`Content-Security-Policy: sandbox`), so a
 * page a service returns cannot script the knode-os origin; `sandbox: false` is
 * for a service whose web UI you trust as much as knode-os itself.
 */

export interface GatewayRecord {
  id: string;
  /** http(s) URL on this machine the requests are forwarded to; its path is the prefix they land under. */
  target: string;
  description?: string;
  /** Pass the client's `Authorization` header through (default false: it is cut unless it is not a knode token). */
  passAuthorization?: boolean;
  /** Serve responses sandboxed (default true). */
  sandbox?: boolean;
  /** Seconds a forwarded request may take (default 300). */
  timeoutSeconds?: number;
  createdAt: string;
}

interface GatewaysFile {
  version: 1;
  gateways: GatewayRecord[];
}

export const GATEWAYS_FILE = '.knode/gateways.json';
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function assertGatewayId(id: string): void {
  if (!ID_RE.test(id)) throw new Error('gateway ids are 1–32 lower-case letters, digits or dashes, starting with a letter or digit');
}

/** A target must be an http(s) URL on this machine. */
export function normalizeGatewayTarget(raw: string): string {
  let url: URL;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error(`"${raw}" is not a URL — give one like http://127.0.0.1:12300`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('a gateway target is an http:// or https:// URL');
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) throw new Error('a gateway forwards to this machine only — use 127.0.0.1, localhost or [::1]');
  if (url.username || url.password) throw new Error('put credentials in the service, not in the gateway URL');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

export class GatewayStore {
  private cache: { mtimeMs: number; size: number; file: GatewaysFile } | null = null;

  constructor(private readonly rootDataDir: string) {}

  get file(): string {
    return path.join(this.rootDataDir, GATEWAYS_FILE);
  }

  list(): GatewayRecord[] {
    return structuredClone(this.snapshot().gateways);
  }

  get(id: string): GatewayRecord | null {
    const g = this.snapshot().gateways.find((x) => x.id === id);
    return g ? structuredClone(g) : null;
  }

  add(input: { id: string; target: string; description?: string; passAuthorization?: boolean; sandbox?: boolean; timeoutSeconds?: number }, opts: { replace?: boolean } = {}): GatewayRecord {
    const id = String(input.id ?? '').trim().toLowerCase();
    assertGatewayId(id);
    const record: GatewayRecord = {
      id,
      target: normalizeGatewayTarget(input.target),
      ...(input.description?.trim() ? { description: input.description.trim().slice(0, 200) } : {}),
      ...(input.passAuthorization ? { passAuthorization: true } : {}),
      ...(input.sandbox === false ? { sandbox: false } : {}),
      ...(input.timeoutSeconds && Number.isFinite(input.timeoutSeconds) ? { timeoutSeconds: Math.max(1, Math.min(3600, Math.floor(input.timeoutSeconds))) } : {}),
      createdAt: new Date().toISOString(),
    };
    const file = structuredClone(this.snapshot());
    const at = file.gateways.findIndex((g) => g.id === id);
    if (at > -1 && !opts.replace) throw new Error(`gateway "${id}" exists`);
    if (at > -1) file.gateways[at] = { ...record, createdAt: file.gateways[at].createdAt };
    else file.gateways.push(record);
    this.write(file);
    return record;
  }

  remove(id: string): void {
    const file = structuredClone(this.snapshot());
    const before = file.gateways.length;
    file.gateways = file.gateways.filter((g) => g.id !== id);
    if (file.gateways.length === before) throw new Error(`no gateway "${id}"`);
    this.write(file);
  }

  private snapshot(): GatewaysFile {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.file);
    } catch {
      this.cache = null;
      return { version: 1, gateways: [] };
    }
    if (this.cache && this.cache.mtimeMs === st.mtimeMs && this.cache.size === st.size) return this.cache.file;
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as GatewaysFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.gateways)) throw new Error(`${GATEWAYS_FILE} is not a gateways file`);
    this.cache = { mtimeMs: st.mtimeMs, size: st.size, file: parsed };
    return parsed;
  }

  private write(file: GatewaysFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.cache = null;
  }
}

/** Hop-by-hop and framing headers, which describe one connection and never cross a proxy. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  'host', 'content-length', 'expect',
]);
/** What a client says about itself that only the gateway may say. */
const CLIENT_CLAIMS = /^(x-knode-|x-forwarded-|forwarded$|x-real-ip$|cf-|cdn-loop$)/;

export interface ForwardInput {
  gateway: GatewayRecord;
  /** The path under /gw/<id>, starting with "/" (or empty). */
  rest: string;
  /** The query string, with its "?", or empty. */
  search: string;
  request: Request;
  username: string;
  clientIp: string;
  https: boolean;
  publicHost: string;
  /** The name of knode's session cookie, cut out of `Cookie`. */
  sessionCookie: string;
}

/** Forward one request to a gateway's service and hand back its answer, rewritten to stay under /gw/<id>. */
export async function forwardToGateway(input: ForwardInput): Promise<Response> {
  const { gateway } = input;
  const prefix = `/gw/${gateway.id}`;
  const target = new URL(gateway.target);
  const basePath = target.pathname.replace(/\/+$/, '');
  const url = `${target.origin}${basePath}${input.rest || '/'}${input.search}`;

  const headers = new Headers();
  input.request.headers.forEach((value, name) => {
    const n = name.toLowerCase();
    if (HOP_BY_HOP.has(n) || CLIENT_CLAIMS.test(n)) return;
    if (n === 'authorization' && (!gateway.passAuthorization || /^bearer\s+knu_/i.test(value))) return;
    if (n === 'cookie') {
      const kept = value.split(';').map((p) => p.trim()).filter((p) => p && !p.startsWith(`${input.sessionCookie}=`));
      if (kept.length) headers.set('cookie', kept.join('; '));
      return;
    }
    headers.set(name, value);
  });
  headers.set('x-knode-user', input.username);
  headers.set('x-knode-gateway', gateway.id);
  headers.set('x-forwarded-for', input.clientIp);
  headers.set('x-forwarded-proto', input.https ? 'https' : 'http');
  if (input.publicHost) headers.set('x-forwarded-host', input.publicHost);
  headers.set('x-forwarded-prefix', prefix);
  // fetch decodes compressed bodies itself; ask for none rather than decode and re-send
  headers.set('accept-encoding', 'identity');

  const method = input.request.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (gateway.timeoutSeconds ?? 300) * 1000);
  timer.unref?.();
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method,
      headers,
      body: hasBody ? input.request.body : undefined,
      redirect: 'manual',
      signal: controller.signal,
      ...(hasBody ? { duplex: 'half' } : {}),
    } as RequestInit);
  } catch (err) {
    clearTimeout(timer);
    const aborted = controller.signal.aborted;
    return Response.json(
      { error: aborted ? `gateway "${gateway.id}" timed out` : `gateway "${gateway.id}" is unreachable: ${err instanceof Error ? err.message : err}` },
      { status: aborted ? 504 : 502 },
    );
  }

  const out = new Headers();
  upstream.headers.forEach((value, name) => {
    const n = name.toLowerCase();
    if (HOP_BY_HOP.has(n) || n === 'content-encoding' || n === 'set-cookie') return;
    if (n === 'location') {
      out.set(name, rewriteLocation(value, target, basePath, prefix));
      return;
    }
    out.append(name, value);
  });
  // cookies the service sets stay under its prefix and on this host
  for (const cookie of upstream.headers.getSetCookie?.() ?? []) out.append('set-cookie', scopeCookie(cookie, prefix));
  if (gateway.sandbox !== false) out.set('content-security-policy', 'sandbox');
  out.set('x-content-type-options', 'nosniff');
  const body = method === 'HEAD' || upstream.status === 204 || upstream.status === 304 ? null : upstream.body;
  // the timer covers the whole answer: a stream still running at the limit is cut
  if (body) {
    const reader = body.getReader();
    const stream = new ReadableStream({
      async pull(ctrl) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            clearTimeout(timer);
            ctrl.close();
          } else ctrl.enqueue(value);
        } catch (err) {
          clearTimeout(timer);
          ctrl.error(err);
        }
      },
      cancel(reason) {
        clearTimeout(timer);
        return reader.cancel(reason);
      },
    });
    return new Response(stream, { status: upstream.status, statusText: upstream.statusText, headers: out });
  }
  clearTimeout(timer);
  return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

/** A redirect inside the service stays inside the gateway; one elsewhere is left alone. */
function rewriteLocation(value: string, target: URL, basePath: string, prefix: string): string {
  try {
    const loc = new URL(value, `${target.origin}${basePath}/`);
    if (loc.origin !== target.origin) return value;
    const inside = basePath && (loc.pathname === basePath || loc.pathname.startsWith(`${basePath}/`)) ? loc.pathname.slice(basePath.length) : basePath ? null : loc.pathname;
    if (inside === null) return value;
    return `${prefix}${inside || '/'}${loc.search}${loc.hash}`;
  } catch {
    return value;
  }
}

function scopeCookie(cookie: string, prefix: string): string {
  const parts = cookie.split(';').map((p) => p.trim()).filter(Boolean);
  const kept = parts.filter((p, i) => i === 0 || !/^(domain|path)=/i.test(p));
  const original = parts.find((p) => /^path=/i.test(p))?.slice(5).trim() ?? '/';
  const scoped = `${prefix}${original.startsWith('/') ? original : `/${original}`}`.replace(/\/+$/, '');
  kept.push(`Path=${scoped}`);
  return kept.join('; ');
}
