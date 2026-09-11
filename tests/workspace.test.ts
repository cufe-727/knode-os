import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { createApp } from '../src/server/app.js';
import { syncTraces } from '../src/traces/sync.js';
import {
  WorkspaceContextRegistry,
  resolveWorkspaceScope,
  workspaceDataDir,
} from '../src/server/workspaces.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-workspaces-'));
const root = path.join(tmp, 'data');

const headers = (user: string, kind: 'personal' | 'team', name = 'Default', id?: string) => ({
  'content-type': 'application/json',
  'x-knode-user': user,
  'x-knode-workspace-kind': kind,
  'x-knode-workspace-id': id ?? (kind === 'personal' ? name.toLowerCase().replace(/\s+/g, '-') : ''),
  'x-knode-workspace-name': name,
});

const userHeaders = (user: string) => ({
  'content-type': 'application/json',
  'x-knode-user': user,
});

let rootCtx: AppContext;
let registry: WorkspaceContextRegistry;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  rootCtx = await createContext(root);
  registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
  app = createApp(rootCtx, () => {}, registry);
});

afterAll(async () => {
  await registry.closeAll();
  await rootCtx.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('workspace paths', () => {
  it('maps multiple user workspaces and shared Teams to isolated directories', () => {
    const personal = resolveWorkspaceScope({ user: 'Admin', kind: 'personal', id: 'Research', name: 'Research' });
    const team = resolveWorkspaceScope({ user: 'test', kind: 'team', name: 'Knode Labs' });
    const cjk = resolveWorkspaceScope({ user: 'test', kind: 'personal', name: '研究 空间' });

    expect(personal.relativeDir).toBe('users/admin/workspaces/research');
    expect(team.relativeDir).toBe('teams/knode-labs');
    expect(cjk.relativeDir).toBe('users/test/workspaces/研究-空间');
    expect(workspaceDataDir(root, personal)).toBe(path.join(root, 'users', 'admin', 'workspaces', 'research'));
  });

  it('rejects missing, invalid, and traversal-like scope headers', () => {
    expect(() => resolveWorkspaceScope({ user: '', kind: 'personal' })).toThrow(/username/);
    expect(() => resolveWorkspaceScope({ user: 'admin', kind: 'other' })).toThrow(/kind/);
    expect(() => resolveWorkspaceScope({ user: '../', kind: 'personal' })).toThrow(/username/);
    expect(() => resolveWorkspaceScope({ user: 'admin', kind: 'team', name: '../../' })).toThrow(/Team name/);
  });
});

describe('workspace lifecycle and API isolation', () => {
  it('requires workspace identity headers for data APIs', async () => {
    const response = await app.request('/api/tree');
    expect(response.status).toBe(401);
  });

  it('does not recreate a removed or stale workspace from request headers', async () => {
    const response = await app.request('/api/tree', {
      headers: headers('admin', 'personal', 'Removed workspace', 'removed-workspace'),
    });
    expect(response.status).toBe(404);
    expect(fs.existsSync(path.join(root, 'users', 'admin', 'workspaces', 'removed-workspace'))).toBe(false);
  });

  it('creates and lists multiple workspaces for one user', async () => {
    const initial = await app.request('/api/workspaces', { headers: userHeaders('admin') });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject([{ id: 'default', name: 'Default', kind: 'personal' }]);

    const created = await app.request('/api/workspaces', {
      method: 'POST',
      headers: userHeaders('admin'),
      body: JSON.stringify({ name: 'Product Research' }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id: 'product-research', name: 'Product Research', kind: 'personal' });

    const listed = await app.request('/api/workspaces', { headers: userHeaders('admin') });
    expect(await listed.json()).toMatchObject([
      { id: 'default', name: 'Default' },
      { id: 'product-research', name: 'Product Research' },
    ]);
    expect(fs.existsSync(path.join(root, 'users', 'admin', 'workspaces', 'default', 'wiki', 'index.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'users', 'admin', 'workspaces', 'product-research', 'wiki', 'index.md'))).toBe(true);
  });

  it('keeps workspaces separate within a user and across users', async () => {
    await app.request('/api/workspaces', { headers: userHeaders('test') });

    const write = await app.request('/api/file', {
      method: 'PUT',
      headers: headers('admin', 'personal', 'Product Research', 'product-research'),
      body: JSON.stringify({ path: 'wiki/private.md', content: '# Product research only' }),
    });
    expect(write.status).toBe(200);

    const defaultRead = await app.request('/api/file?path=wiki/private.md', {
      headers: headers('admin', 'personal'),
    });
    const otherUserRead = await app.request('/api/file?path=wiki/private.md', {
      headers: headers('test', 'personal'),
    });
    expect(defaultRead.status).toBe(404);
    expect(otherUserRead.status).toBe(404);
    expect(fs.existsSync(path.join(root, 'users', 'admin', 'workspaces', 'product-research', 'wiki', 'private.md'))).toBe(true);
  });

  it('shares one Team directory across users with the same Team name', async () => {
    const write = await app.request('/api/file', {
      method: 'PUT',
      headers: headers('admin', 'team', 'Alpha Team', 'alpha-team'),
      body: JSON.stringify({ path: 'wiki/shared.md', content: '# Team shared' }),
    });
    expect(write.status).toBe(200);

    const read = await app.request('/api/file?path=wiki/shared.md', {
      headers: headers('test', 'team', 'ALPHA TEAM', 'alpha-team'),
    });
    expect(read.status).toBe(200);
    expect((await read.json()).content).toBe('# Team shared');
    expect(fs.existsSync(path.join(root, 'teams', 'alpha-team', 'wiki', 'shared.md'))).toBe(true);
  });

  it('persists and hot-applies config only in the selected user workspace', async () => {
    const save = await app.request('/api/config', {
      method: 'PUT',
      headers: headers('admin', 'personal', 'Product Research', 'product-research'),
      body: JSON.stringify({
        llm: { provider: 'codex-cli', model: 'research-model', cliPath: 'codex-research' },
        extraction: {
          entityLlm: { provider: 'claude-cli', model: 'entity-model' },
          conceptLlm: { provider: 'inherit', model: 'concept-model' },
        },
      }),
    });
    expect(save.status).toBe(200);

    const researchConfig = await (await app.request('/api/config', {
      headers: headers('admin', 'personal', 'Product Research', 'product-research'),
    })).json();
    const personalConfig = await (await app.request('/api/config', {
      headers: headers('admin', 'personal'),
    })).json();

    expect(researchConfig.llm).toMatchObject({ provider: 'codex-cli', model: 'research-model', cliPath: 'codex-research' });
    expect(researchConfig.extraction.entityLlm).toMatchObject({ provider: 'claude-cli', model: 'entity-model' });
    expect(personalConfig.llm.model).toBe('');
  });

  it('clears the whole workspace and recreates only an empty skeleton', async () => {
    const response = await app.request('/api/workspace', {
      method: 'DELETE',
      headers: headers('admin', 'personal', 'Product Research', 'product-research'),
    });
    expect(response.status).toBe(200);

    const dir = path.join(root, 'users', 'admin', 'workspaces', 'product-research');
    expect(fs.existsSync(path.join(dir, 'wiki', 'private.md'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'wiki', 'index.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.workspace.json'))).toBe(true);

    const config = await (await app.request('/api/config', {
      headers: headers('admin', 'personal', 'Product Research', 'product-research'),
    })).json();
    expect(config.llm.model).toBe('');

    const listed = await (await app.request('/api/workspaces', { headers: userHeaders('admin') })).json();
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'product-research', name: 'Product Research' }),
    ]));
  });

  it('keeps historical trace sync paused until the user explicitly requests it', async () => {
    const scope = resolveWorkspaceScope({
      user: 'admin',
      kind: 'personal',
      id: 'product-research',
      name: 'Product Research',
    });
    await registry.reset(scope);
    const ctx = await registry.get(scope);
    const source = path.join(tmp, 'external-codex');
    const trace = path.join(source, '2026', '07', '26', 'rollout-test.jsonl');
    fs.mkdirSync(path.dirname(trace), { recursive: true });
    fs.writeFileSync(trace, `${JSON.stringify({ timestamp: new Date().toISOString(), message: 'new trace' })}\n`);
    ctx.config.trace.claudeProjectsDir = path.join(tmp, 'no-claude-traces');
    ctx.config.trace.codexSessionsDir = source;
    ctx.config.trace.skillDirs = [];

    expect(await syncTraces(ctx.store, ctx.config)).toMatchObject({ copied: 0, skills: 0 });
    expect(fs.existsSync(path.join(ctx.dataDir, 'raw/traces/codex/2026/07/26/rollout-test.jsonl'))).toBe(false);

    expect(await syncTraces(ctx.store, ctx.config, { ignoreSince: true })).toMatchObject({ copied: 1 });
    expect(fs.existsSync(path.join(ctx.dataDir, 'raw/traces/codex/2026/07/26/rollout-test.jsonl'))).toBe(true);
  });
});
