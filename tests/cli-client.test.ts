import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth/service.js';
import { KnodeClient, ServerError } from '../src/client/client.js';
import { commandPath, listWorkspaces, pickWorkspace, serverClient, signIn, signOut, WorkspaceChoice } from '../src/client/commands.js';
import { downloadFile, formatListing, formatTree, uploadEntries } from '../src/client/files.js';
import { normalizeServerUrl, SignInStore, signInsFile } from '../src/client/signins.js';
import { AppContext, createContext } from '../src/context.js';
import type { TreeNode } from '../src/fs/files.js';
import { createApp } from '../src/server/app.js';
import { resolveWorkspaceScope, WorkspaceContextRegistry, workspaceDataDir } from '../src/server/workspaces.js';
import { Command } from 'commander';

/**
 * The CLI as a client of `serve` (src/client): signing in from another
 * machine, the saved sign-ins, choosing a Team workspace, and the file and
 * search routes the commands call — against the real app, reached as a
 * remote HTTPS client would reach it through a tunnel.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-cli-client-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const PASSWORD = 'correct horse battery';
const SERVER = 'https://knode.example.com';

describe('server addresses and saved sign-ins', () => {
  it('takes a bare host as HTTPS and keeps plain HTTP to this machine', () => {
    expect(normalizeServerUrl('knode.example.com')).toBe('https://knode.example.com');
    expect(normalizeServerUrl('https://knode.example.com/')).toBe('https://knode.example.com');
    expect(normalizeServerUrl('http://127.0.0.1:12000')).toBe('http://127.0.0.1:12000');
    expect(normalizeServerUrl('http://localhost:12000')).toBe('http://localhost:12000');
    expect(() => normalizeServerUrl('http://knode.example.com')).toThrow(/plain HTTP/);
    expect(() => normalizeServerUrl('https://knode.example.com/app')).toThrow(/without a path/);
    expect(() => normalizeServerUrl('ftp://knode.example.com')).toThrow(/https/);
    expect(() => normalizeServerUrl('')).toThrow(/name the server/);
  });

  it('keeps sign-ins in one private file, and signing out of the current one leaves none current', () => {
    expect(signInsFile({ KNODE_OS_SIGNINS: '/x/servers.json' })).toBe('/x/servers.json');
    expect(signInsFile({ XDG_CONFIG_HOME: '/cfg' })).toBe('/cfg/knode-os/servers.json');
    const store = new SignInStore(path.join(tmp, 'store', 'servers.json'));
    expect(store.current()).toBeNull();
    store.save({ url: 'https://a.example', username: 'ann', token: 'knu_a', signedInAt: 'now' });
    store.save({ url: 'https://b.example', username: 'bo', token: 'knu_b', signedInAt: 'now' });
    expect(store.current()?.url).toBe('https://b.example');
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
    store.makeCurrent('https://a.example');
    store.setWorkspace('https://a.example', { kind: 'team', id: 'team-finance', name: 'Finance' });
    expect(store.current()?.workspace?.name).toBe('Finance');
    store.remove('https://a.example');
    expect(store.current()).toBeNull();
    expect(store.get('https://b.example')?.token).toBe('knu_b');
  });

  it('finds a workspace by bare name, kind/name or display name, personal first', () => {
    const choices: WorkspaceChoice[] = [
      { kind: 'personal', id: 'default', name: 'Default', ref: 'personal/default' },
      { kind: 'personal', id: 'finance', name: 'Finance', ref: 'personal/finance' },
      { kind: 'team', id: 'team-finance', name: 'Finance', ref: 'team/finance' },
      { kind: 'team', id: 'team-knode-labs', name: 'Knode Labs', ref: 'team/knode-labs' },
    ];
    expect(pickWorkspace(choices).ref).toBe('personal/default');
    expect(pickWorkspace(choices, 'finance').ref).toBe('personal/finance');
    expect(pickWorkspace(choices, 'team/finance').ref).toBe('team/finance');
    expect(pickWorkspace(choices, 'Knode Labs').ref).toBe('team/knode-labs');
    expect(pickWorkspace(choices, undefined, { kind: 'team', id: 'team-finance', name: 'Finance' }).ref).toBe('team/finance');
    expect(() => pickWorkspace(choices, 'nope')).toThrow(/personal\/default, personal\/finance/);
    expect(() => pickWorkspace([])).toThrow(/no workspace/);
  });

  it('names a nested command by its path', () => {
    const root = new Command('knode-os');
    const leaf = root.command('research').command('study').command('list');
    expect(commandPath(leaf)).toBe('research study list');
  });
});

describe('formatting', () => {
  const tree: TreeNode = {
    name: 'docs', path: 'raw/docs', kind: 'dir', children: [
      { name: 'a', path: 'raw/docs/a', kind: 'dir', children: [{ name: 'x.md', path: 'raw/docs/a/x.md', kind: 'file', bytes: 2048, mtime: '2026-11-05T08:00:00.000Z' }] },
      { name: 'b.pdf', path: 'raw/docs/b.pdf', kind: 'file', bytes: 10, mtime: '2026-11-05T09:00:00.000Z' },
    ],
  };

  it('draws a tree and lists a folder', () => {
    expect(formatTree(tree)).toBe(['raw/docs', '├── a/', '│   └── x.md', '└── b.pdf'].join('\n'));
    const listing = formatListing(tree.children!);
    expect(listing).toMatch(/^raw\/docs\/a\//);
    expect(listing).toMatch(/raw\/docs\/b\.pdf\s+10 B\s+2026-11-05 09:00/);
  });

  it('uploads a folder under its own name, dot entries left out', () => {
    const dir = path.join(tmp, 'up', 'notes');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, 'a.md'), 'a');
    fs.writeFileSync(path.join(dir, 'sub', 'b.md'), 'b');
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'x');
    const single = path.join(tmp, 'up', 'one.txt');
    fs.writeFileSync(single, '1');
    expect(uploadEntries([dir, single]).map((e) => e.name).sort()).toEqual(['notes/a.md', 'notes/sub/b.md', 'one.txt']);
  });
});

describe('the CLI against a server', () => {
  const root = path.join(tmp, 'serve');
  let rootCtx: AppContext;
  let registry: WorkspaceContextRegistry;
  let auth: AuthService;
  let app: ReturnType<typeof createApp>;
  // cloudflared reaches serve over plain HTTP from loopback; the edge says HTTPS — as the tunnel does
  const viaTunnel = (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const headers = new Headers(init?.headers);
    headers.set('cf-connecting-ip', '203.0.113.9');
    headers.set('cf-visitor', JSON.stringify({ scheme: 'https' }));
    return Promise.resolve(app.request(`http://knode.example.com${url.pathname}${url.search}`, { ...init, headers }));
  };
  const store = new SignInStore(path.join(tmp, 'client', 'servers.json'));

  beforeAll(async () => {
    rootCtx = await createContext(root);
    registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
    auth = new AuthService(root, { cookieName: 'knode_session_cli' });
    app = createApp(rootCtx, () => {}, registry, { auth });
    await auth.accounts.create({ username: 'admin', password: PASSWORD, role: 'admin' });
    await auth.accounts.create({ username: 'viewer', password: PASSWORD, teams: ['finance'], readOnly: true });
    await auth.accounts.create({ username: 'editor', password: PASSWORD, teams: ['finance'] });
    // the finance Team is the administrator's personal workspace, shared through an alias (docs/remote-access.md)
    const owner = resolveWorkspaceScope({ user: 'admin', kind: 'personal', id: 'finance', name: 'Finance' });
    await registry.get(owner);
    const source = workspaceDataDir(root, owner);
    fs.mkdirSync(path.join(source, 'raw', 'docs', 'reports'), { recursive: true });
    fs.writeFileSync(path.join(source, 'raw', 'docs', 'reports', 'q3.md'), '# Q3\n\nMargins widened on copper.\n');
    fs.writeFileSync(path.join(source, 'raw', 'docs', 'reports', 'chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    fs.mkdirSync(path.join(root, 'teams'), { recursive: true });
    fs.symlinkSync(source, path.join(root, 'teams', 'finance'), 'dir');
  });

  afterAll(async () => {
    await registry?.closeAll();
    await rootCtx?.store.close();
  });

  it('signs in from another machine, onto the Team it names, and keeps the session', async () => {
    const out = await signIn({ server: 'knode.example.com', store, username: 'viewer', password: async () => PASSWORD, workspace: 'finance', label: 'vitest', fetch: viaTunnel });
    expect(out.reused).toBe(false);
    expect(out.saved).toMatchObject({ url: SERVER, username: 'viewer', workspace: { kind: 'team', id: 'team-finance', name: 'Finance' } });
    expect(out.saved.token).toMatch(/^knu_/);
    expect(out.me.local).toBe(false);
    expect(out.me.account.readOnly).toBe(true);
    expect(out.workspaces.map((w) => w.ref)).toEqual(['personal/default', 'team/finance']);
    expect(store.current()?.url).toBe(SERVER);
    expect(auth.sessions.list('viewer').map((s) => s.label)).toContain('vitest');

    // the next login finds the session still good and asks for no password
    const again = await signIn({ server: SERVER, store, password: async () => { throw new Error('asked for a password'); }, fetch: viaTunnel });
    expect(again.reused).toBe(true);
    expect(again.saved.workspace?.id).toBe('team-finance');
  });

  it('refuses a wrong password and a server without accounts', async () => {
    const other = new SignInStore(path.join(tmp, 'client-wrong', 'servers.json'));
    await expect(signIn({ server: SERVER, store: other, username: 'viewer', password: async () => 'not it at all', fetch: viaTunnel })).rejects.toBeInstanceOf(ServerError);
    expect(other.current()).toBeNull();
    await expect(signIn({ server: SERVER, store: other, password: async () => PASSWORD, fetch: viaTunnel })).rejects.toThrow(/--user/);
  });

  it('lists, reads, greps and downloads the Team\'s files', async () => {
    const client = serverClient(store, viaTunnel)!;
    const folder = await client.get<TreeNode>('/api/tree', { path: 'raw/docs/reports', depth: 1 });
    expect(folder.children?.map((c) => c.path).sort()).toEqual(['raw/docs/reports/chart.png', 'raw/docs/reports/q3.md']);
    const file = await client.get<{ content: string; truncated: boolean }>('/api/file', { path: 'raw/docs/reports/q3.md' });
    expect(file.content).toContain('Margins widened');
    const matches = await client.get<{ path: string; line: number }[]>('/api/grep', { pattern: 'copper' });
    expect(matches).toEqual([expect.objectContaining({ path: 'raw/docs/reports/q3.md', line: 3 })]);

    const text = await downloadFile(client, 'raw/docs/reports/q3.md');
    expect(Buffer.from(text.bytes).toString('utf8')).toBe('# Q3\n\nMargins widened on copper.\n');
    const picture = await downloadFile(client, 'raw/docs/reports/chart.png');
    expect([...picture.bytes]).toEqual([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

    // the workspace's private files stay out of reach
    await expect(client.get('/api/file', { path: 'knode.config.json' })).rejects.toMatchObject({ status: 403 });
  });

  it('holds a read-only account to looking', async () => {
    const client = serverClient(store, viaTunnel)!;
    const write = client.put('/api/file', { path: 'wiki/x.md', content: 'x' });
    await expect(write).rejects.toBeInstanceOf(ServerError);
    await expect(write).rejects.toMatchObject({ status: 403, reason: 'read-only' });
    const form = new FormData();
    form.append('file', new File(['y'], 'y.md'));
    await expect(client.upload('/api/upload', form)).rejects.toMatchObject({ reason: 'read-only' });
  });

  it('lets a member upload, move and delete in the Team', async () => {
    const editorStore = new SignInStore(path.join(tmp, 'client-editor', 'servers.json'));
    await signIn({ server: SERVER, store: editorStore, username: 'editor', password: async () => PASSWORD, workspace: 'team/finance', fetch: viaTunnel });
    const client = serverClient(editorStore, viaTunnel)!;
    const form = new FormData();
    form.set('dir', 'raw/docs/inbox');
    form.append('file', new File(['# memo\n'], 'memo.md'));
    form.append('file', new File(['nested'], 'pack/deep.txt'));
    const up = await client.upload<{ saved: string[] }>('/api/upload', form);
    expect(up.saved.sort()).toEqual(['raw/docs/inbox/memo.md', 'raw/docs/inbox/pack/deep.txt']);
    await client.post('/api/mkdir', { path: 'raw/docs/archive' });
    await client.post('/api/mv', { from: 'raw/docs/inbox/memo.md', to: 'raw/docs/archive/memo.md' });
    const moved = await client.get<{ content: string }>('/api/file', { path: 'raw/docs/archive/memo.md' });
    expect(moved.content).toBe('# memo\n');
    await client.delete('/api/file', { path: 'raw/docs/inbox/pack/deep.txt' });
    await expect(client.get('/api/file', { path: 'raw/docs/inbox/pack/deep.txt' })).rejects.toMatchObject({ status: 404 });
    // the same files, seen from the owner's side of the alias
    const owner = workspaceDataDir(root, resolveWorkspaceScope({ user: 'admin', kind: 'personal', id: 'finance', name: 'Finance' }));
    expect(fs.readFileSync(path.join(owner, 'raw', 'docs', 'archive', 'memo.md'), 'utf8')).toBe('# memo\n');
  });

  it('switches workspaces only to ones the account has', async () => {
    const saved = store.current()!;
    const choices = await listWorkspaces(KnodeClient.forSaved(saved, viaTunnel));
    expect(() => pickWorkspace(choices, 'team/knode-labs')).toThrow(/no workspace/);
    const personal = pickWorkspace(choices, 'personal/default');
    store.setWorkspace(saved.url, personal);
    const tree = await serverClient(store, viaTunnel)!.get<TreeNode>('/api/tree', { path: '.', depth: 1 });
    expect(tree.children?.some((c) => c.path === 'raw')).toBe(true);
    store.setWorkspace(saved.url, pickWorkspace(choices, 'finance'));
  });

  it('signs out: the server ends the session and this machine forgets it', async () => {
    const token = store.current()!.token;
    const out = await signOut(store, undefined, viaTunnel);
    expect(out).toMatchObject({ url: SERVER, ended: true });
    expect(store.current()).toBeNull();
    const stale = new KnodeClient(SERVER, { token, workspace: { kind: 'team', id: 'team-finance', name: 'Finance' }, fetch: viaTunnel });
    await expect(stale.get('/api/tree')).rejects.toThrow(/sign in again: knode-os login https:\/\/knode\.example\.com/);
    expect(await signOut(store, undefined, viaTunnel)).toBeNull();
  });

  it('words a server that cannot be reached', async () => {
    const down = new KnodeClient(SERVER, { fetch: () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })) });
    await expect(down.state()).rejects.toThrow(`cannot reach ${SERVER}: ENOTFOUND`);
    const tunnel = new KnodeClient(SERVER, { fetch: () => Promise.resolve(new Response('<html>timeout</html>', { status: 524 })) });
    await expect(tunnel.state()).rejects.toThrow(/longer than its tunnel waits/);
  });
});
