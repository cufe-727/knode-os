import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountStore, accountAllows } from '../src/auth/accounts.js';
import { existingTeams } from '../src/auth/http.js';
import { apiGroupOf, onlyReads } from '../src/auth/apis.js';
import { normalizeGatewayTarget } from '../src/auth/gateways.js';
import { AuthService } from '../src/auth/service.js';
import { SessionStore } from '../src/auth/sessions.js';
import { AppContext, createContext } from '../src/context.js';
import { createApp } from '../src/server/app.js';
import { API_CSP, UI_CSP } from '../src/server/csp.js';
import { clientInfo } from '../src/server/public-guard.js';
import { assertListeners } from '../src/server/serve.js';
import { WorkspaceContextRegistry, resolveWorkspaceScope, workspaceDataDir } from '../src/server/workspaces.js';

/**
 * Sign-in (src/auth): accounts and sessions on disk, the middleware in front
 * of `serve` — local and remote, cookie and bearer, API groups, teams — and
 * the gateway to services on this machine.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-auth-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const COOKIE = 'knode_session_test';
const PASSWORD = 'correct horse battery';

describe('accounts and sessions on disk', () => {
  const root = path.join(tmp, 'store');

  it('hashes passwords, refuses duplicates and weak passwords, and keeps the last administrator', async () => {
    const accounts = new AccountStore(root);
    expect(accounts.hasUsers()).toBe(false);
    const admin = await accounts.create({ username: 'Admin', password: PASSWORD, role: 'admin' });
    expect(admin).toMatchObject({ username: 'admin', role: 'admin', remoteApis: ['*'] });
    expect(fs.readFileSync(accounts.file, 'utf8')).not.toContain(PASSWORD);
    expect(fs.statSync(accounts.file).mode & 0o777).toBe(0o600);
    await expect(accounts.create({ username: 'admin', password: PASSWORD })).rejects.toThrow(/exists/);
    await expect(accounts.create({ username: 'bob', password: 'short' })).rejects.toThrow(/at least 8/);
    await expect(accounts.create({ username: '../evil', password: PASSWORD })).rejects.toThrow(/usernames/);
    await expect(accounts.create({ username: 'bob', password: PASSWORD, remoteApis: ['files', 'shell'] })).rejects.toThrow(/unknown API group "shell"/);

    const bob = await accounts.create({ username: 'bob', password: PASSWORD, teams: ['Knode Labs'] });
    expect(bob.teams).toEqual(['knode-labs']);
    expect(bob.remoteApis).toEqual(['files', 'search', 'ask', 'knowledge', 'ingest', 'traces']);

    expect(await accounts.authenticate('ADMIN', PASSWORD)).toMatchObject({ username: 'admin' });
    expect(await accounts.authenticate('admin', 'wrong password')).toBeNull();
    expect(await accounts.authenticate('nobody', PASSWORD)).toBeNull();

    await expect(accounts.update('admin', { role: 'member' })).rejects.toThrow(/last administrator/);
    expect(() => accounts.remove('admin')).toThrow(/last administrator/);
    await accounts.update('bob', { disabled: true });
    expect(await accounts.authenticate('bob', PASSWORD)).toBeNull();
  });

  it('expires, revokes and voids sessions', async () => {
    const auth = new AuthService(root);
    const admin = auth.accounts.get('admin')!;
    const { token, session } = auth.issue(admin, { kind: 'app', label: 'test mac' });
    expect(token).toMatch(/^knu_[A-Za-z0-9_-]{43}$/);
    expect(fs.readFileSync(auth.sessions.file, 'utf8')).not.toContain(token);
    expect(auth.identify(token)?.account.username).toBe('admin');
    expect(auth.identify(`${token.slice(0, -1)}x`)).toBeNull();

    // a CLI in another process sees and ends the same sessions
    const other = new SessionStore(root);
    expect(other.list('admin').map((s) => s.id)).toContain(session.id);
    expect(other.revoke(session.id)).toBe(true);
    expect(auth.identify(token)).toBeNull();

    // "sign out everywhere" voids what was issued before it, without touching the sessions file
    const second = auth.issue(admin, { kind: 'browser' });
    await new Promise((r) => setTimeout(r, 5));
    auth.accounts.revokeSessions('admin');
    expect(auth.identify(second.token)).toBeNull();

    const expired = new SessionStore(root).create({ username: 'admin', kind: 'token', expiresInDays: 1 });
    const raw = JSON.parse(fs.readFileSync(auth.sessions.file, 'utf8'));
    raw.sessions.find((s: { id: string }) => s.id === expired.session.id).expiresAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(auth.sessions.file, JSON.stringify(raw));
    expect(auth.identify(expired.token)).toBeNull();
  });

  it('keeps read-only to members', async () => {
    const accounts = new AccountStore(root);
    await expect(accounts.create({ username: 'boss', password: PASSWORD, role: 'admin', readOnly: true })).rejects.toThrow(/cannot be read-only/);
    expect(accounts.get('boss')).toBeNull();
    expect(await accounts.create({ username: 'viewer', password: PASSWORD, readOnly: true })).toMatchObject({ role: 'member', readOnly: true });
    await expect(accounts.update('viewer', { role: 'admin' })).rejects.toThrow(/cannot be read-only/);
    expect(accounts.get('viewer')).toMatchObject({ role: 'member', readOnly: true });
    expect((await accounts.update('viewer', { readOnly: false })).account.readOnly).toBeUndefined();
    expect((await accounts.update('viewer', { readOnly: true })).account.readOnly).toBe(true);
  });
});

describe('API groups', () => {
  it('sorts routes into groups and locks down anything unlisted', () => {
    expect(apiGroupOf('GET', '/api/config')).toBeNull();
    expect(apiGroupOf('PUT', '/api/config')).toBe('settings');
    expect(apiGroupOf('POST', '/api/config/test')).toBe('settings');
    expect(apiGroupOf('GET', '/api/tree')).toBe('files');
    expect(apiGroupOf('GET', '/api/file')).toBe('files');
    expect(apiGroupOf('GET', '/api/files-of-something')).toBe('settings');
    expect(apiGroupOf('POST', '/api/entities/merge')).toBe('knowledge');
    expect(apiGroupOf('GET', '/api/entities')).toBe('search');
    expect(apiGroupOf('GET', '/api/disputes')).toBe('search');
    expect(apiGroupOf('POST', '/api/disputes/x/resolve')).toBe('knowledge');
    expect(apiGroupOf('GET', '/api/research/profiles')).toBeNull();
    expect(apiGroupOf('PUT', '/api/research/profiles/deep')).toBe('settings');
    // playbooks are read to draw Settings and written by an administrator; notices are workspace state
    expect(apiGroupOf('GET', '/api/playbooks/file')).toBeNull();
    expect(apiGroupOf('PUT', '/api/playbooks/file')).toBe('settings');
    expect(apiGroupOf('GET', '/api/notices')).toBe('search');
    expect(apiGroupOf('POST', '/api/research/jobs')).toBe('knowledge');
    expect(apiGroupOf('GET', '/api/labeling/status')).toBe('ingest');
    // reading this machine's disk is an administrator's call; following an existing link is not
    expect(apiGroupOf('POST', '/api/folders/import')).toBe('settings');
    expect(apiGroupOf('POST', '/api/folders/preview')).toBe('settings');
    expect(apiGroupOf('POST', '/api/folders/sync')).toBe('files');
    expect(apiGroupOf('GET', '/api/folders')).toBe('files');
    expect(apiGroupOf('GET', '/api/auth/users')).toBe('settings');
    expect(apiGroupOf('GET', '/api/auth/me')).toBeNull();
    expect(apiGroupOf('GET', '/gw/svc/x')).toBe('gateway');
    expect(apiGroupOf('GET', '/api/brand-new')).toBe('settings');
  });

  it('members never get settings; remote use is limited to remoteApis', () => {
    const member = { username: 'm', name: 'm', role: 'member' as const, teams: [], remoteApis: ['files'], gateways: [], createdAt: '', passwordChangedAt: '' };
    expect(accountAllows(member, 'settings', false)).toBe(false);
    expect(accountAllows(member, 'datasources', false)).toBe(true);
    expect(accountAllows(member, 'datasources', true)).toBe(false);
    expect(accountAllows(member, 'files', true)).toBe(true);
    expect(accountAllows({ ...member, role: 'admin', remoteApis: ['*'] }, 'settings', true)).toBe(true);
  });

  it('tells a request that only reads from one that changes something', () => {
    expect(onlyReads('GET', '/api/file')).toBe(true);
    expect(onlyReads('HEAD', '/gw/svc/x')).toBe(true);
    expect(onlyReads('POST', '/api/entities/mentions')).toBe(true);
    expect(onlyReads('POST', '/api/datasources/sales/query')).toBe(true);
    expect(onlyReads('POST', '/api/datasources/sync')).toBe(false);
    expect(onlyReads('PUT', '/api/file')).toBe(false);
    expect(onlyReads('DELETE', '/api/file')).toBe(false);
    // a resolve or a pack is recorded as a receipt
    expect(onlyReads('POST', '/api/resolve')).toBe(false);
    expect(onlyReads('POST', '/api/pack')).toBe(false);
    expect(onlyReads('POST', '/gw/svc/items')).toBe(false);
    expect(onlyReads('GET', '/api/research/recommendations')).toBe(true);
    expect(onlyReads('GET', '/api/research/recommendations', new URLSearchParams('refresh=1'))).toBe(false);
  });
});

describe('where a request comes from', () => {
  const fake = (headers: Record<string, string>, socket?: { remoteAddress: string; encrypted?: boolean }) => ({
    req: { header: (name: string) => headers[name], url: `http://${headers.host ?? 'x'}/api/stats` },
    env: socket ? { incoming: { socket: { ...socket, remotePort: 1, remoteFamily: 'IPv4' } } } : undefined,
  }) as never;

  it('believes proxy headers only from a proxy on this machine', () => {
    // cloudflared on loopback
    expect(clientInfo(fake({ host: 'knode.example.com', 'cf-connecting-ip': '203.0.113.9', 'cf-visitor': '{"scheme":"https"}' }, { remoteAddress: '127.0.0.1' })))
      .toEqual({ local: false, https: true, proxied: true, ip: '203.0.113.9' });
    // an SSH tunnel: loopback, loopback Host, no proxy
    expect(clientInfo(fake({ host: '127.0.0.1:12000' }, { remoteAddress: '127.0.0.1' }))).toMatchObject({ local: true, https: false });
    // another machine that claims to be local and to have come over HTTPS through a proxy
    expect(clientInfo(fake({ host: '127.0.0.1:12000', 'x-forwarded-proto': 'https', 'cf-connecting-ip': '127.0.0.1' }, { remoteAddress: '192.168.1.20' })))
      .toEqual({ local: false, https: false, proxied: false, ip: '192.168.1.20' });
    // the HTTPS listener
    expect(clientInfo(fake({ host: '192.168.1.5:12443' }, { remoteAddress: '192.168.1.20', encrypted: true }))).toMatchObject({ local: false, https: true });
  });

  it('refuses listeners other machines would reach over plain HTTP', () => {
    const server = { port: 12000, host: '127.0.0.1', mcp: { enabled: true, path: '/mcp' }, auth: { enabled: true } };
    expect(() => assertListeners(server)).not.toThrow();
    expect(() => assertListeners({ ...server, host: '0.0.0.0' })).toThrow(/plain HTTP/);
    expect(() => assertListeners({ ...server, host: '0.0.0.0', auth: { enabled: true, allowInsecureRemote: true } })).not.toThrow();
    expect(() => assertListeners({ ...server, tls: { port: 12000, host: '0.0.0.0', cert: 'c', key: 'k' } })).toThrow(/differ/);
    expect(() => assertListeners({ ...server, auth: { enabled: false }, tls: { port: 12443, host: '0.0.0.0', cert: 'c', key: 'k' } })).toThrow(/sign-in is off/);
  });

  it('takes gateway targets on this machine only', () => {
    expect(normalizeGatewayTarget('http://127.0.0.1:12300/api/')).toBe('http://127.0.0.1:12300/api');
    expect(() => normalizeGatewayTarget('http://192.168.1.10:80')).toThrow(/this machine only/);
    expect(() => normalizeGatewayTarget('file:///etc/passwd')).toThrow(/http/);
  });
});

describe('sign-in in front of serve', () => {
  const root = path.join(tmp, 'serve');
  let rootCtx: AppContext;
  let registry: WorkspaceContextRegistry;
  let auth: AuthService;
  let app: ReturnType<typeof createApp>;
  let upstream: http.Server;
  let upstreamUrl = '';
  let seen: { url?: string; headers?: http.IncomingHttpHeaders; body?: string } = {};

  type Init = RequestInit & { token?: string; cookie?: string; remote?: boolean | 'http'; ip?: string; csrf?: boolean };
  const req = (p: string, init: Init = {}) => {
    const headers = new Headers(init.headers);
    if (init.token) headers.set('authorization', `Bearer ${init.token}`);
    if (init.cookie) headers.set('cookie', init.cookie);
    if (init.csrf) headers.set('x-knode-csrf', '1');
    if (init.remote) {
      headers.set('cf-connecting-ip', init.ip ?? '203.0.113.7');
      headers.set('cf-visitor', JSON.stringify({ scheme: init.remote === 'http' ? 'http' : 'https' }));
    }
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    // cloudflared reaches serve over plain HTTP; the edge's scheme is in cf-visitor
    return app.request(init.remote ? `http://knode.example.com${p}` : `http://127.0.0.1:12000${p}`, { ...init, headers });
  };
  const ws = (id = 'default', kind: 'personal' | 'team' = 'personal', name = id) => ({
    'x-knode-workspace-kind': kind, 'x-knode-workspace-id': id, 'x-knode-workspace-name': name,
  });
  const login = async (username: string, password = PASSWORD, extra: Init = {}) => {
    const res = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password, client: 'app', label: 'vitest' }), ...extra });
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
  };

  beforeAll(async () => {
    upstream = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        seen = { url: request.url, headers: request.headers, body };
        if (request.url?.startsWith('/svc/redirect')) {
          response.writeHead(302, { location: '/svc/landed?ok=1' });
          return response.end();
        }
        response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'svc=1; Path=/; HttpOnly' });
        response.end(JSON.stringify({ echo: request.url, method: request.method }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/svc`;

    rootCtx = await createContext(root);
    registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
    auth = new AuthService(root, { cookieName: COOKIE });
    app = createApp(rootCtx, () => {}, registry, { auth });
  });

  afterAll(async () => {
    await registry?.closeAll();
    await rootCtx?.store.close();
    await new Promise<void>((resolve) => upstream?.close(() => resolve()));
  });

  it('asks for the first account on this machine only', async () => {
    expect((await req('/api/stats', { headers: ws() })).status).toBe(401);
    const state = await (await req('/api/auth/state')).json();
    expect(state).toMatchObject({ auth: true, setupRequired: true, canSetup: true, signedIn: false });
    expect(await (await req('/api/auth/state', { remote: true })).json()).toMatchObject({ setupRequired: true, canSetup: false });

    const setup = (remote?: boolean) => req('/api/auth/setup', { method: 'POST', remote, body: JSON.stringify({ username: 'admin', password: PASSWORD }) });
    expect((await setup(true)).status).toBe(403);
    // a form on another site cannot post JSON
    expect((await req('/api/auth/setup', { method: 'POST', body: 'username=admin', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(415);
    const res = await setup();
    expect(res.status).toBe(201);
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`^${COOKIE}=knu_.*HttpOnly.*SameSite=Lax`, 'i'));
    expect((await setup()).status).toBe(409);
  });

  it('signs a browser in with a cookie and holds its writes to the CSRF header', async () => {
    const res = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: PASSWORD }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeUndefined();
    expect(body.account).toMatchObject({ username: 'admin', role: 'admin' });
    const cookie = res.headers.get('set-cookie')!.split(';')[0];

    expect((await req('/api/workspaces', { cookie })).status).toBe(200);
    expect((await req('/api/stats', { cookie, headers: ws() })).status).toBe(200);
    expect((await req('/api/workspaces', { method: 'POST', cookie, body: JSON.stringify({ name: 'Research' }) })).status).toBe(403);
    expect((await req('/api/workspaces', { method: 'POST', cookie, csrf: true, body: JSON.stringify({ name: 'Research' }) })).status).toBe(201);
    expect((await req('/api/auth/logout', { method: 'POST', cookie, body: '{}' })).status).toBe(200);
    expect((await req('/api/stats', { cookie, headers: ws() })).status).toBe(401);
  });

  it('acts for the signed-in account, whatever user a client names', async () => {
    await req('/api/auth/users', { method: 'POST', token: await login('admin'), body: JSON.stringify({ username: 'bob', password: PASSWORD }) });
    const bob = await login('bob');
    const own = await (await req('/api/workspaces', { token: bob, headers: { 'x-knode-user': 'admin' } })).json();
    expect(own.map((w: { id: string }) => w.id)).toEqual(['default']);
    expect(fs.existsSync(path.join(root, 'users', 'bob', 'workspaces', 'default'))).toBe(true);
    expect((await req('/api/stats', { token: bob, headers: { ...ws('research'), 'x-knode-user': 'admin' } })).status).toBe(404);
  });

  it('keeps members out of settings, other teams and user management', async () => {
    const admin = await login('admin');
    const bob = await login('bob');
    expect((await req('/api/config', { token: bob, headers: ws() })).status).toBe(200);
    const put = await req('/api/config', { method: 'PUT', token: bob, headers: ws(), body: JSON.stringify({}) });
    expect(put.status).toBe(403);
    expect((await put.json()).reason).toBe('forbidden');
    expect((await req('/api/auth/users', { token: bob })).status).toBe(403);

    expect((await req('/api/stats', { token: bob, headers: ws('team-knode-labs', 'team', 'Knode Labs') })).status).toBe(403);
    expect((await req('/api/stats', { token: admin, headers: ws('team-knode-labs', 'team', 'Knode Labs') })).status).toBe(200);
    expect((await req('/api/auth/users/bob', { method: 'PATCH', token: admin, body: JSON.stringify({ teams: ['knode-labs'] }) })).status).toBe(200);
    expect((await req('/api/stats', { token: bob, headers: ws('team-knode-labs', 'team', 'Knode Labs') })).status).toBe(200);
    const me = await (await req('/api/auth/me', { token: bob })).json();
    expect(me.teams).toEqual([{ id: 'team-knode-labs', name: 'Knode Labs', kind: 'team', slug: 'knode-labs' }]);
  });

  it('holds other machines to HTTPS and to the account\'s remote API groups', async () => {
    const bob = await login('bob');
    expect((await req('/api/stats', { token: bob, headers: ws(), remote: 'http' })).status).toBe(403);
    expect((await req('/api/stats', { token: bob, headers: ws(), remote: true })).status).toBe(200);
    // datasources: fine here, not in bob's remote list
    expect((await req('/api/datasources', { token: bob, headers: ws() })).status).toBe(200);
    const remote = await req('/api/datasources', { token: bob, headers: ws(), remote: true });
    expect(remote.status).toBe(403);
    expect((await remote.json()).error).toMatch(/from outside this machine/);
    // the data root is this machine's business; MCP is this machine's only
    expect((await (await req('/api/health', { remote: true })).json()).dataRoot).toBeUndefined();
    expect((await (await req('/api/health')).json()).dataRoot).toBe(rootCtx.dataDir);
    expect((await req('/mcp', { method: 'POST', remote: true, body: '{}' })).status).toBe(404);
  });

  it('shares an existing personal workspace through a team without a second index or access to other workspaces', async () => {
    const ownerScope = resolveWorkspaceScope({ user: 'admin', kind: 'personal', id: 'research', name: 'Research' });
    const teamScope = resolveWorkspaceScope({ user: 'bob', kind: 'team', name: 'Finance' });
    const source = workspaceDataDir(root, ownerScope);
    const alias = path.join(root, 'teams', 'finance');
    fs.mkdirSync(path.dirname(alias), { recursive: true });
    fs.symlinkSync(source, alias, 'dir');
    fs.writeFileSync(path.join(source, 'wiki', 'shared-note.md'), '# Shared original');
    const token = await login('bob');
    const teamHeaders = ws('team-finance', 'team', 'Finance');
    try {
      expect(existingTeams(root)).toContain('finance');
      expect(workspaceDataDir(root, teamScope)).toBe(source);
      expect(await registry.get(teamScope)).toBe(await registry.get(ownerScope));
      expect((await req('/api/file?path=wiki/shared-note.md', { token, headers: teamHeaders, remote: true })).status).toBe(403);
      await auth.accounts.update('bob', { teams: ['knode-labs', 'finance'] });
      const view = await (await req('/api/auth/me', { token, remote: true })).json();
      expect(view.teams).toContainEqual({ id: 'team-finance', name: 'Finance', kind: 'team', slug: 'finance' });
      const read = await req('/api/file?path=wiki/shared-note.md', { token, headers: teamHeaders, remote: true });
      expect(read.status).toBe(200);
      expect((await read.json()).content).toBe('# Shared original');
      expect((await req('/api/file?path=wiki/shared-note.md', { token, headers: { ...ws('research'), 'x-knode-user': 'admin' }, remote: true })).status).toBe(404);
      await expect(registry.reset(teamScope)).rejects.toThrow(/owner/);
      await auth.accounts.update('bob', { teams: ['knode-labs'] });
      expect((await req('/api/file?path=wiki/shared-note.md', { token, headers: teamHeaders, remote: true })).status).toBe(403);
    } finally {
      fs.unlinkSync(alias);
      await auth.accounts.update('bob', { teams: ['knode-labs'] });
    }
    // Broken and external links must fail closed instead of initializing or exposing a new workspace.
    for (const target of [path.join(root, 'missing'), tmp, path.join(source, 'wiki')]) {
      fs.symlinkSync(target, alias, 'dir');
      try {
        expect(() => workspaceDataDir(root, teamScope)).toThrow();
        expect(existingTeams(root)).not.toContain('finance');
      } finally { fs.unlinkSync(alias); }
    }
  });

  it('throttles failed sign-ins per client', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await req('/api/auth/login', { method: 'POST', remote: true, ip: '198.51.100.66', body: JSON.stringify({ username: 'bob', password: `nope-${i}-xx` }) });
      expect(res.status).toBe(401);
    }
    const blocked = await req('/api/auth/login', { method: 'POST', remote: true, ip: '198.51.100.66', body: JSON.stringify({ username: 'bob', password: PASSWORD }) });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    // another client is unaffected
    expect((await req('/api/auth/login', { method: 'POST', remote: true, ip: '198.51.100.67', body: JSON.stringify({ username: 'bob', password: PASSWORD, client: 'app' }) })).status).toBe(200);
  });

  it('ends every other session when a password changes, and on disable', async () => {
    const first = await login('bob');
    const second = await login('bob');
    expect((await req('/api/auth/password', { method: 'POST', token: first, body: JSON.stringify({ current: 'wrong-password', password: 'a new long password' }) })).status).toBe(403);
    const changed = await req('/api/auth/password', { method: 'POST', token: first, body: JSON.stringify({ current: PASSWORD, password: 'a new long password' }) });
    expect(changed.status).toBe(200);
    const { token: renewed } = await changed.json();
    expect((await req('/api/auth/me', { token: second })).status).toBe(401);
    expect((await req('/api/auth/me', { token: first })).status).toBe(401);
    expect((await req('/api/auth/me', { token: renewed })).status).toBe(200);

    const admin = await login('admin');
    expect((await req('/api/auth/users/bob', { method: 'PATCH', token: admin, body: JSON.stringify({ disabled: true }) })).status).toBe(200);
    expect((await req('/api/auth/me', { token: renewed })).status).toBe(401);
    expect((await req('/api/auth/users/bob', { method: 'PATCH', token: admin, body: JSON.stringify({ disabled: false, password: PASSWORD }) })).status).toBe(200);
    expect((await req('/api/auth/users/admin', { method: 'PATCH', token: admin, body: JSON.stringify({ disabled: true }) })).status).toBe(400);
  });

  it('forwards a gateway to its service without knode credentials, and only for accounts allowed it', async () => {
    const admin = await login('admin');
    const bob = await login('bob');
    expect((await req('/api/auth/gateways', { method: 'POST', token: admin, body: JSON.stringify({ id: 'svc', target: upstreamUrl, description: 'test service' }) })).status).toBe(201);
    expect((await req('/api/auth/gateways', { method: 'POST', token: admin, body: JSON.stringify({ id: 'lan', target: 'http://10.0.0.5:80' }) })).status).toBe(400);

    const res = await req('/gw/svc/hello?x=1', { token: admin, cookie: `${COOKIE}=knu_${'a'.repeat(43)}; theme=dark`, headers: { 'x-knode-user': 'mallory', 'x-forwarded-prefix': '/elsewhere' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echo: '/svc/hello?x=1', method: 'GET' });
    expect(seen.headers?.['x-knode-user']).toBe('admin');
    expect(seen.headers?.authorization).toBeUndefined();
    expect(seen.headers?.cookie).toBe('theme=dark');
    expect(seen.headers?.['x-forwarded-prefix']).toBe('/gw/svc');
    expect(res.headers.get('content-security-policy')).toBe('sandbox');
    expect(res.headers.get('set-cookie')).toMatch(/Path=\/gw\/svc/);

    const posted = await req('/gw/svc/items', { method: 'POST', token: admin, body: JSON.stringify({ a: 1 }) });
    expect(posted.status).toBe(200);
    expect(seen.body).toBe('{"a":1}');
    const redirected = await req('/gw/svc/redirect', { token: admin });
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get('location')).toBe('/gw/svc/landed?ok=1');

    expect((await req('/gw/svc/hello', { token: bob })).status).toBe(403);
    expect((await req('/api/auth/users/bob', { method: 'PATCH', token: admin, body: JSON.stringify({ gateways: ['svc'] }) })).status).toBe(200);
    expect((await req('/gw/svc/hello', { token: bob })).status).toBe(200);
    // from outside, the gateway group is needed as well
    expect((await req('/gw/svc/hello', { token: bob, remote: true })).status).toBe(403);
    expect((await req('/gw/nope/x', { token: admin })).status).toBe(404);
    expect((await req('/gw/svc/hello')).status).toBe(401);
  });

  it('lets a read-only member look and change nothing, until an administrator says otherwise', async () => {
    const admin = await login('admin');
    const created = await req('/api/auth/users', { method: 'POST', token: admin, body: JSON.stringify({ username: 'carol', password: PASSWORD, readOnly: true, gateways: ['svc'] }) });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ role: 'member', readOnly: true });
    expect((await req('/api/auth/users', { method: 'POST', token: admin, body: JSON.stringify({ username: 'dave', password: PASSWORD, role: 'admin', readOnly: true }) })).status).toBe(400);
    let carol = await login('carol');
    expect((await (await req('/api/auth/me', { token: carol })).json()).account).toMatchObject({ username: 'carol', readOnly: true });

    expect((await req('/api/workspaces', { token: carol })).status).toBe(200);
    expect((await req('/api/stats', { token: carol, headers: ws() })).status).toBe(200);
    expect((await req('/api/entities/mentions', { method: 'POST', token: carol, headers: ws(), body: JSON.stringify({ text: 'nothing known here' }) })).status).toBe(200);
    expect((await req('/gw/svc/hello', { token: carol })).status).toBe(200);

    const put = await req('/api/file', { method: 'PUT', token: carol, headers: ws(), body: JSON.stringify({ path: 'wiki/note.md', content: '# note' }) });
    expect(put.status).toBe(403);
    expect(await put.json()).toMatchObject({ reason: 'read-only' });
    expect(fs.existsSync(path.join(root, 'users', 'carol', 'workspaces', 'default', 'wiki', 'note.md'))).toBe(false);
    const writes = [
      ['POST', '/api/workspaces'], ['POST', '/api/mkdir'], ['POST', '/api/upload'], ['POST', '/api/ingest'], ['POST', '/api/resolve'],
      ['POST', '/api/chat/conversations'], ['POST', '/api/research/jobs'], ['DELETE', '/api/file?path=wiki/x.md'],
      ['GET', '/api/research/recommendations?refresh=1'], ['POST', '/gw/svc/items'],
    ] as const;
    for (const [method, p] of writes) {
      const res = await req(p, { method, token: carol, headers: ws(), body: method === 'POST' ? '{}' : undefined });
      expect(res.status, `${method} ${p}`).toBe(403);
      expect((await res.json()).reason, `${method} ${p}`).toBe('read-only');
    }

    // their own sign-in is still theirs to manage
    const others = await req('/api/auth/signout-others', { method: 'POST', token: carol, body: '{}' });
    expect(others.status).toBe(200);
    carol = (await others.json()).token;

    expect((await req('/api/auth/users/carol', { method: 'PATCH', token: admin, body: JSON.stringify({ role: 'admin' }) })).status).toBe(400);
    expect((await req('/api/auth/users/carol', { method: 'PATCH', token: admin, body: JSON.stringify({ readOnly: false }) })).status).toBe(200);
    // the same session, at once
    expect((await req('/api/workspaces', { method: 'POST', token: carol, body: JSON.stringify({ name: 'Notes' }) })).status).toBe(201);
  });

  it('puts every /api route in a group on purpose: nothing lands in settings by omission', () => {
    const settings = app.routes
      .filter((r) => r.method !== 'ALL' && r.path.startsWith('/api/'))
      .filter((r) => apiGroupOf(r.method, r.path.replace(/:[^/]+/g, 'x')) === 'settings')
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(settings).toEqual([
      'DELETE /api/agents/:name',
      'DELETE /api/auth/gateways/:id',
      'DELETE /api/auth/users/:username',
      'DELETE /api/playbooks/file',
      'DELETE /api/research/profiles/:name',
      'DELETE /api/research/sources/:id',
      'DELETE /api/workspace',
      'GET /api/auth/gateways',
      'GET /api/auth/users',
      // this machine's agent conversations: the catalog shows every session's prompts
      'GET /api/conversations/catalog',
      'GET /api/conversations/preview',
      // the machine's own Feishu sign-in (lark-cli): who it is, and signing in as someone
      'GET /api/feishu/auth',
      'GET /api/feishu/import',
      'GET /api/feishu/import/:id',
      // the machine's own Codex and Cursor accounts: plan, windows, credits
      'GET /api/usage',
      'PATCH /api/auth/users/:username',
      'POST /api/auth/gateways',
      'POST /api/auth/users',
      'POST /api/auth/users/:username/signout',
      // calls the embeddings endpoint it is given, as the embedding test calls the keys
      'POST /api/config/embedding-endpoint/check',
      'POST /api/config/embedding-test',
      'POST /api/config/models',
      'POST /api/config/test',
      'POST /api/conversations/import',
      'POST /api/feishu/auth/login',
      // reading Feishu as the machine's Feishu user
      'POST /api/feishu/import',
      'POST /api/feishu/preview',
      'POST /api/folders/import',
      'POST /api/folders/preview',
      'POST /api/labeling/start',
      'POST /api/labeling/stop',
      'PUT /api/agents/:name',
      'PUT /api/chat/protocol',
      'PUT /api/config',
      'PUT /api/playbooks/file',
      'PUT /api/research/profiles/:name',
      'PUT /api/research/sources/:id',
    ]);
  });

  it('serves the UI to anyone — it signs in by itself — with framing refused and only its own scripts', async () => {
    const res = await req('/', { remote: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toBe(UI_CSP);
    // API answers are data: a policy that lets nothing in them run
    expect((await req('/api/auth/state', { remote: true })).headers.get('content-security-policy')).toBe(API_CSP);
    expect((await req('/api/stats', { token: await login('bob'), headers: ws() })).headers.get('content-security-policy')).toBe(API_CSP);
  });

  it('opens an original from a link — the session says who, the query which workspace — and keeps the page sandboxed', async () => {
    const page = path.join(root, 'users', 'admin', 'workspaces', 'default', 'raw', 'docs', 'saved.html');
    fs.mkdirSync(path.dirname(page), { recursive: true });
    fs.writeFileSync(page, '<!doctype html><html><head><title>Saved</title></head><body><p>hello</p><script>steal()</script></body></html>');
    const bobToken = await login('bob');
    const signedIn = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: PASSWORD }) });
    const cookie = signedIn.headers.get('set-cookie')!.split(';')[0];
    const q = (extra: Record<string, string> = {}) => new URLSearchParams({ path: 'raw/docs/saved.html', kind: 'personal', id: 'default', name: 'default', ...extra });
    const res = await req(`/api/file/original?${q()}`, { cookie, remote: true });
    expect(res.status).toBe(200);
    // the UI's policy would let the page run as ours: the route's sandbox stands
    expect(res.headers.get('content-security-policy')).toMatch(/^sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'/);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(await res.text()).toContain(`<head><meta http-equiv="Content-Security-Policy" content="script-src 'none'`);
    // a user named in the query is not who the request acts for
    const bob = await req(`/api/file/original?${q({ user: 'admin' })}`, { token: bobToken });
    expect(bob.status).toBe(404);
    expect((await req(`/api/file/original?${q()}`)).status).toBe(401);
  });
});
