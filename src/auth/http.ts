import fs from 'node:fs';
import path from 'node:path';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { ClientInfo, clientInfo, PUBLIC_PREFIX } from '../server/public-guard.js';
import { accountAllows, accountMayUseGateway, AccountUpdate, MIN_PASSWORD_LENGTH, normalizeUsername, PublicAccount, Role } from './accounts.js';
import { API_GROUP_NAMES, API_GROUPS, apiGroupOf, ApiGroup } from './apis.js';
import { forwardToGateway } from './gateways.js';
import { AuthError, AuthService } from './service.js';
import { looksLikeSessionToken, PublicSession, SessionKind } from './sessions.js';

/**
 * Sign-in over HTTP: the middleware that guards `serve`, the /api/auth routes
 * and the /gw gateway.
 *
 *   the web UI and its assets   open — they hold nothing; the UI signs in itself
 *   /api/health, /api/auth/state, /api/auth/login, /api/auth/setup, /api/auth/logout   open
 *   /api/*, /gw/*               a session: the cookie of a signed-in browser, or
 *                               `Authorization: Bearer knu_…` (also `X-Knode-Token`)
 *   /remote/v1/*                its own per-machine tokens (src/remote)
 *   /mcp                        this machine only, with its own token
 *
 * From another machine every request must come over HTTPS (the edge's, or
 * `server.tls`), unless `server.auth.allowInsecureRemote` says the network
 * encrypts by itself, and an account may use only the API groups in its
 * `remoteApis` (src/auth/apis.ts). A browser's state-changing request must
 * carry `X-Knode-CSRF: 1`, which a page on another site cannot send.
 */

export type AuthEnv = {
  Variables: {
    client: ClientInfo;
    account: PublicAccount;
    session: PublicSession;
    credential: 'cookie' | 'bearer';
  };
};

const OPEN_API = new Set(['/api/health', '/api/auth/state', '/api/auth/login', '/api/auth/setup', '/api/auth/logout']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The credential a request presents, and how. */
function credentialOf(c: Context, cookieName: string): { token: string; via: 'cookie' | 'bearer' } | null {
  const bearer = /^bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
  if (looksLikeSessionToken(bearer)) return { token: bearer, via: 'bearer' };
  const header = c.req.header('x-knode-token');
  if (looksLikeSessionToken(header)) return { token: header, via: 'bearer' };
  const cookie = getCookie(c, cookieName);
  if (looksLikeSessionToken(cookie)) return { token: cookie, via: 'cookie' };
  return null;
}

function forbidden(group: ApiGroup, account: PublicAccount, client: ClientInfo): string {
  if (account.role !== 'admin' && group === 'settings') return 'only an administrator may change settings, users or gateways, or start and stop processing';
  return client.local
    ? `your account may not use ${group}`
    : `your account may not use ${group} from outside this machine — an administrator can allow it (knode-os user set ${account.username} --remote-apis …)`;
}

const isUnder = (p: string, prefix: string) => p === prefix || p.startsWith(`${prefix}/`);

/** No framing (clickjacking), no referrer leaving the origin, no type sniffing. */
function hardenUi(c: Context): void {
  c.header('x-frame-options', 'DENY');
  c.header('referrer-policy', 'same-origin');
  c.header('x-content-type-options', 'nosniff');
}

export function authMiddleware(auth: AuthService, opts: { mcpPath?: string } = {}): MiddlewareHandler {
  const mcpPath = opts.mcpPath || '/mcp';
  return async (c, next) => {
    const client = clientInfo(c);
    c.set('client', client);
    if (!client.local && !client.https && !auth.options.allowInsecureRemote) {
      return c.json({ error: 'this server answers other machines over HTTPS only', reason: 'https' }, 403);
    }
    const p = c.req.path;
    if (isUnder(p, PUBLIC_PREFIX)) return next();
    if (isUnder(p, mcpPath)) {
      if (!client.local) return c.json({ error: 'not found' }, 404);
      return next();
    }
    const api = isUnder(p, '/api');
    const gateway = isUnder(p, '/gw');
    if (!api && !gateway) {
      await next();
      hardenUi(c);
      return;
    }
    if (OPEN_API.has(p)) {
      // a sign-in form on another site cannot send JSON, so it cannot sign you in to an account of its choosing
      if (c.req.method === 'POST' && !(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
        return c.json({ error: 'send JSON' }, 415);
      }
      await next();
      hardenUi(c);
      c.header('cache-control', 'no-store');
      return;
    }
    const presented = credentialOf(c, auth.cookieName);
    const identity = presented ? auth.identify(presented.token, client.ip) : null;
    if (!presented || !identity) {
      if (presented?.via === 'cookie') deleteCookie(c, auth.cookieName, { path: '/' });
      return c.json({ error: presented ? 'your session has ended — sign in again' : 'sign in first', reason: 'auth' }, 401);
    }
    if (presented.via === 'cookie' && !SAFE_METHODS.has(c.req.method) && c.req.header('x-knode-csrf') !== '1') {
      return c.json({ error: 'a browser request that changes something must carry X-Knode-CSRF: 1', reason: 'csrf' }, 403);
    }
    const group = apiGroupOf(c.req.method, p);
    if (group && !accountAllows(identity.account, group, !client.local)) {
      return c.json({ error: forbidden(group, identity.account, client), reason: 'forbidden', group }, 403);
    }
    c.set('account', identity.account);
    c.set('session', identity.session);
    c.set('credential', presented.via);
    await next();
    if (api) {
      hardenUi(c);
      if (isUnder(p, '/api/auth')) c.header('cache-control', 'no-store');
    }
  };
}

/** The account a request was signed in as (sign-in on), or null (sign-in off: tests, embedded apps). */
export function requestAccount(c: Context): PublicAccount | null {
  return (c.get('account') as PublicAccount | undefined) ?? null;
}

export interface AuthRoutesDeps {
  /** Team workspaces that exist, by slug. */
  teams: () => string[];
  log?: (msg: string) => void;
}

const prettyTeam = (slug: string) => slug.split('-').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || slug;

function deviceLabel(c: Context, given: unknown): string {
  const label = typeof given === 'string' ? given : '';
  if (label.trim()) return label.trim().slice(0, 120);
  const ua = c.req.header('user-agent') ?? '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' on ');
}

export function mountAuthRoutes(app: Hono<any>, auth: AuthService, deps: AuthRoutesDeps): void {
  const log = deps.log ?? (() => {});
  const fail = (c: Context, e: unknown) => {
    if (e instanceof AuthError) {
      if (e.retryAfter) c.header('retry-after', String(e.retryAfter));
      return c.json({ error: e.message, ...(e.status === 401 ? { reason: 'credentials' } : {}) }, e.status);
    }
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  };
  const body = async <T>(c: Context): Promise<T> => (await c.req.json().catch(() => ({}))) as T;

  /** Hand a new session to the client the way it asked: a cookie for a browser, the token for anything else. */
  const deliver = (c: Context, issued: { token: string; session: PublicSession }, kind: SessionKind, remember: boolean) => {
    const client = c.get('client') as ClientInfo;
    if (kind === 'browser') {
      setCookie(c, auth.cookieName, issued.token, {
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
        secure: client.https,
        ...(remember ? { maxAge: Math.floor(auth.sessionDays * 86_400) } : {}),
      });
      return { session: issued.session };
    }
    return { token: issued.token, session: issued.session };
  };

  const kindOf = (value: unknown): SessionKind => (value === 'app' ? 'app' : 'browser');

  const view = (c: Context, account: PublicAccount) => {
    const client = c.get('client') as ClientInfo;
    const groups = Object.fromEntries(API_GROUP_NAMES.map((g) => [g, accountAllows(account, g, !client.local)]));
    const existing = deps.teams();
    const teamSlugs = account.role === 'admin' || account.teams.includes('*') ? existing : account.teams.filter((t) => t !== '*');
    const gateways = auth.gateways.list().filter((g) => accountMayUseGateway(account, g.id)).map((g) => ({ id: g.id, description: g.description ?? '', path: `/gw/${g.id}/` }));
    return {
      account,
      local: client.local,
      groups,
      teams: [...new Set(teamSlugs)].sort().map((slug) => ({ id: `team-${slug}`, name: prettyTeam(slug), kind: 'team', slug })),
      gateways,
    };
  };

  app.get('/api/auth/state', (c) => {
    const client = c.get('client') as ClientInfo;
    const presented = credentialOf(c, auth.cookieName);
    const identity = presented ? auth.identify(presented.token, client.ip) : null;
    const setupRequired = auth.setupRequired();
    return c.json({
      auth: true,
      setupRequired,
      // the first account is made on this machine only — never by whoever reaches the server first from outside
      canSetup: setupRequired && client.local,
      local: client.local,
      https: client.https,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      signedIn: Boolean(identity),
      ...(identity ? view(c, identity.account) : {}),
    });
  });

  app.post('/api/auth/setup', async (c) => {
    const client = c.get('client') as ClientInfo;
    if (!client.local) return c.json({ error: 'the first account can only be made on the machine knode-os runs on' }, 403);
    if (!auth.setupRequired()) return c.json({ error: 'this server has accounts already — sign in' }, 409);
    const input = await body<{ username?: string; name?: string; password?: string; client?: string; label?: string }>(c);
    try {
      const account = await auth.hashed(() => auth.accounts.create({ username: input.username ?? '', name: input.name, password: input.password ?? '', role: 'admin' }));
      log(`auth: administrator "${account.username}" created from this machine`);
      const kind = kindOf(input.client);
      return c.json({ ...deliver(c, auth.issue(account, { kind, label: deviceLabel(c, input.label), ip: client.ip }), kind, true), ...view(c, account) }, 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post('/api/auth/login', async (c) => {
    const client = c.get('client') as ClientInfo;
    const input = await body<{ username?: string; password?: string; client?: string; label?: string; remember?: boolean }>(c);
    if (auth.setupRequired()) {
      return c.json({ error: client.local ? 'no accounts yet — create the administrator first' : 'this server has no accounts yet', reason: 'setup' }, 409);
    }
    const kind = kindOf(input.client);
    const remember = input.remember !== false;
    try {
      const issued = await auth.login({ username: input.username ?? '', password: input.password ?? '', kind, label: deviceLabel(c, input.label), ip: client.ip, remember });
      log(`auth: ${issued.account.username} signed in (${kind}${client.local ? '' : `, from ${client.ip}`})`);
      return c.json({ ...deliver(c, issued, kind, remember), ...view(c, issued.account) });
    } catch (e) {
      if (e instanceof AuthError && e.status === 401) log(`auth: failed sign-in for "${String(input.username ?? '').slice(0, 64)}" from ${client.ip}`);
      return fail(c, e);
    }
  });

  app.post('/api/auth/logout', (c) => {
    const presented = credentialOf(c, auth.cookieName);
    if (presented) auth.sessions.revokeToken(presented.token);
    deleteCookie(c, auth.cookieName, { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/api/auth/me', (c) => {
    const session = c.get('session') as PublicSession;
    return c.json({ ...view(c, c.get('account')), session, apiGroups: API_GROUPS });
  });

  /** Change your own password: the current one proves it is you; every other session ends. */
  app.post('/api/auth/password', async (c) => {
    const client = c.get('client') as ClientInfo;
    const account = c.get('account') as PublicAccount;
    const session = c.get('session') as PublicSession;
    const input = await body<{ current?: string; password?: string }>(c);
    try {
      if (!(await auth.verifyPassword(account.username, String(input.current ?? ''), client.ip))) throw new AuthError(403, 'the current password is wrong');
      const { account: updated } = await auth.hashed(() => auth.accounts.update(account.username, { password: String(input.password ?? '') }));
      auth.sessions.revokeUser(account.username);
      log(`auth: ${account.username} changed their password; their other sessions ended`);
      const kind = session.kind === 'token' ? 'app' : session.kind;
      return c.json({ ok: true, ...deliver(c, auth.issue(updated, { kind, label: session.label, ip: client.ip }), kind, true) });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get('/api/auth/sessions', (c) => {
    const account = c.get('account') as PublicAccount;
    const current = (c.get('session') as PublicSession).id;
    return c.json(auth.sessions.list(account.username).map((s) => ({ ...s, current: s.id === current })));
  });

  app.delete('/api/auth/sessions/:id', (c) => {
    const account = c.get('account') as PublicAccount;
    if (!auth.sessions.revoke(c.req.param('id'), account.username)) return c.json({ error: 'no such session' }, 404);
    return c.json({ ok: true });
  });

  /** End every session of yours but this one. */
  app.post('/api/auth/signout-others', (c) => {
    const client = c.get('client') as ClientInfo;
    const account = c.get('account') as PublicAccount;
    const session = c.get('session') as PublicSession;
    const updated = auth.accounts.revokeSessions(account.username);
    auth.sessions.revokeUser(account.username);
    const kind = session.kind === 'token' ? 'app' : session.kind;
    return c.json({ ok: true, ...deliver(c, auth.issue(updated, { kind, label: session.label, ip: client.ip }), kind, true) });
  });

  /* ------------------------------ admin ------------------------------ */

  const admin = (c: Context): PublicAccount => {
    const account = c.get('account') as PublicAccount;
    if (account.role !== 'admin') throw new AuthError(403, 'only an administrator may manage users and gateways');
    return account;
  };

  const sessionsOf = (username: string) => {
    const list = auth.sessions.list(username);
    return { count: list.length, lastSeenAt: list.map((s) => s.lastSeenAt).sort().pop() ?? null };
  };

  app.get('/api/auth/users', (c) => {
    try {
      admin(c);
      return c.json({ users: auth.accounts.list().map((u) => ({ ...u, sessions: sessionsOf(u.username) })), apiGroups: API_GROUPS, teams: deps.teams(), gateways: auth.gateways.list().map((g) => g.id) });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post('/api/auth/users', async (c) => {
    try {
      const me = admin(c);
      const input = await body<{ username?: string; name?: string; password?: string; role?: Role; teams?: string[]; remoteApis?: string[]; gateways?: string[] }>(c);
      const account = await auth.hashed(() => auth.accounts.create({
        username: input.username ?? '', name: input.name, password: input.password ?? '', role: input.role,
        teams: input.teams, remoteApis: input.remoteApis, gateways: input.gateways,
      }));
      log(`auth: ${me.username} created ${account.role} "${account.username}"`);
      return c.json(account, 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.patch('/api/auth/users/:username', async (c) => {
    try {
      const me = admin(c);
      const username = normalizeUsername(c.req.param('username'));
      const input = await body<AccountUpdate>(c);
      if (username === me.username && input.password !== undefined) throw new AuthError(400, 'change your own password under Account, with your current one');
      if (username === me.username && (input.disabled === true || (input.role !== undefined && input.role !== 'admin'))) {
        throw new AuthError(400, 'you cannot disable or demote yourself — ask another administrator');
      }
      const changes: AccountUpdate = {};
      for (const key of ['name', 'password', 'role', 'teams', 'remoteApis', 'gateways', 'disabled'] as const) {
        if (input[key] !== undefined) (changes as Record<string, unknown>)[key] = input[key];
      }
      const { account, credentialsChanged } = await auth.hashed(() => auth.accounts.update(username, changes));
      if (credentialsChanged) auth.sessions.revokeUser(username);
      log(`auth: ${me.username} updated "${username}"${credentialsChanged ? ' (their sessions ended)' : ''}`);
      return c.json(account);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.delete('/api/auth/users/:username', (c) => {
    try {
      const me = admin(c);
      const username = normalizeUsername(c.req.param('username'));
      if (username === me.username) throw new AuthError(400, 'you cannot remove yourself — ask another administrator');
      auth.accounts.remove(username);
      auth.sessions.revokeUser(username);
      log(`auth: ${me.username} removed "${username}" (their workspaces stay on disk)`);
      return c.json({ ok: true });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post('/api/auth/users/:username/signout', (c) => {
    try {
      admin(c);
      const username = normalizeUsername(c.req.param('username'));
      auth.accounts.revokeSessions(username);
      return c.json({ ok: true, ended: auth.sessions.revokeUser(username) });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get('/api/auth/gateways', (c) => {
    try {
      admin(c);
      return c.json(auth.gateways.list());
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post('/api/auth/gateways', async (c) => {
    try {
      const me = admin(c);
      const input = await body<{ id?: string; target?: string; description?: string; passAuthorization?: boolean; sandbox?: boolean; timeoutSeconds?: number; replace?: boolean }>(c);
      const gateway = auth.gateways.add({
        id: input.id ?? '', target: input.target ?? '', description: input.description,
        passAuthorization: input.passAuthorization, sandbox: input.sandbox, timeoutSeconds: input.timeoutSeconds,
      }, { replace: input.replace === true });
      log(`auth: ${me.username} published gateway ${gateway.id} → ${gateway.target}`);
      return c.json(gateway, 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.delete('/api/auth/gateways/:id', (c) => {
    try {
      const me = admin(c);
      auth.gateways.remove(c.req.param('id'));
      log(`auth: ${me.username} removed gateway ${c.req.param('id')}`);
      return c.json({ ok: true });
    } catch (e) {
      return fail(c, e);
    }
  });
}

/** /gw/<id>/… — a local service, for the accounts allowed it. */
export function mountGateways(app: Hono<any>, auth: AuthService): void {
  const handler = async (c: Context) => {
    const account = c.get('account') as PublicAccount;
    const client = c.get('client') as ClientInfo;
    const id = c.req.param('id') ?? '';
    const gateway = auth.gateways.get(id);
    if (!gateway) return c.json({ error: `no gateway "${id}"` }, 404);
    if (!accountMayUseGateway(account, id)) return c.json({ error: `your account may not use the gateway "${id}"`, reason: 'forbidden' }, 403);
    const url = new URL(c.req.url);
    const prefix = `/gw/${id}`;
    if (url.pathname === prefix && c.req.method === 'GET') return c.redirect(`${prefix}/${url.search}`, 308);
    return forwardToGateway({
      gateway,
      rest: url.pathname.slice(prefix.length),
      search: url.search,
      request: c.req.raw,
      username: account.username,
      clientIp: client.ip,
      https: client.https,
      publicHost: c.req.header('host') ?? '',
      sessionCookie: auth.cookieName,
    });
  };
  app.all('/gw/:id', handler);
  app.all('/gw/:id/*', handler);
}

/** Team workspaces on disk, by slug. */
export function existingTeams(rootDataDir: string): string[] {
  try {
    return fs.readdirSync(path.join(rootDataDir, 'teams'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
