import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { defaultRoutedLlmConfig, KnodeConfig, loadConfig, saveConfig } from '../src/config.js';
import { settleSharedIds, sharedSettingsOf, syncWorkspaceSettings, workspaceDirs } from '../src/global-settings.js';
import { createApp } from '../src/server/app.js';
import { WorkspaceContextRegistry, WorkspaceScope } from '../src/server/workspaces.js';

/**
 * Processing and the stage models are the server's (src/global-settings.ts):
 * the root config holds them, every workspace takes them when it opens — a
 * new one included — and an administrator's change in any workspace reaches
 * the root, every other workspace's files and the workspaces open now. The
 * agents and rows the stages name travel with them, so no route is pinned
 * back to a workspace's default for want of its target.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-global-settings-'));
const root = path.join(tmp, 'data');

const CODEX_AGENT = 'name: connection-3\ntitle: codex\nexecutor: codex-cli\ncliPath: \'\'\nmodel: gpt-6.1-sol\neffort: medium\nspeed: default\n';
const route = (over: Record<string, unknown> = {}) => ({ ...defaultRoutedLlmConfig(), use: 'connection-3', model: 'gpt-6.1-sol', speed: 'fast' as const, ...over });

const personal = (user: string, id: string, name: string): WorkspaceScope => ({ user, kind: 'personal', id, name, slug: id, relativeDir: `users/${user}/workspaces/${id}` });
const headersFor = (scope: WorkspaceScope) => ({
  'content-type': 'application/json',
  'x-knode-user': scope.user,
  'x-knode-workspace-kind': 'personal',
  'x-knode-workspace-id': scope.id,
  'x-knode-workspace-name': scope.name,
});

const finance = personal('admin', 'finance', 'Finance');
const shelf = personal('reader', 'library', 'Library');
const closed = personal('reader', 'archive', 'Archive');
const clash = personal('reader', 'clash', 'Clash');

let rootCtx: AppContext;
let registry: WorkspaceContextRegistry;
let app: ReturnType<typeof createApp>;
const logs: string[] = [];

/** A workspace folder made before the settings were shared: its own stages, its own limits, an agent of its own. */
function oldWorkspace(scope: WorkspaceScope, config: Partial<KnodeConfig>): string {
  const dir = path.join(root, scope.relativeDir);
  fs.mkdirSync(path.join(dir, 'playbooks', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'playbooks', 'agents', 'codex.yaml'), 'name: codex\ntitle: Codex\nexecutor: codex-cli\ncliPath: \'\'\nmodel: gpt-6.1-sol\neffort: medium\nspeed: default\n');
  fs.writeFileSync(path.join(dir, 'knode.config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(dir, '.workspace.json'), JSON.stringify({ id: scope.id, name: scope.name, kind: 'personal', createdAt: '2026-11-01T00:00:00.000Z' }));
  return dir;
}

beforeAll(async () => {
  // the root: every stage on the Codex agent, the Judge stage on an API row, six calls at once, a 10% floor
  fs.mkdirSync(path.join(root, 'playbooks', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'playbooks', 'agents', 'connection-3.yaml'), CODEX_AGENT);
  rootCtx = await createContext(root);
  const config = rootCtx.config;
  config.connections = [...config.connections, { id: 'api-judge', label: 'judge API', provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-shared-judge', protocol: 'chat', model: 'judge-model', cliPath: '', effort: 'default', cliTimeoutMs: 30_000 }];
  config.extraction = {
    ...config.extraction,
    entityLlm: route({ effort: 'medium' }), documentLlm: route({ effort: 'high' }), summaryLlm: route(), judgeLlm: route({ use: 'api-judge', model: '' }), translateLlm: route(),
    workers: [{ use: 'connection-3', slots: 2, model: 'gpt-6.1-sol', effort: 'medium' }], concurrency: 3,
  };
  config.review = { ...config.review, concurrency: 2 };
  config.processing = { maxLocalCalls: 6, minQuotaPercent: 10 };
  saveConfig(root, config);
  rootCtx.config = loadConfig(root);

  oldWorkspace(shelf, {
    llmUse: 'openai-1',
    extraction: { entityLlm: { use: 'codex', effort: 'medium' }, summaryLlm: { use: 'codex' }, workers: [{ use: 'codex', slots: 0 }], summaryConcurrency: 2 } as never,
    languages: { enabled: true, primary: 'en' } as never,
    processing: { autoStart: true, maxLocalCalls: 2, minQuotaPercent: 50 } as never,
  });
  oldWorkspace(closed, { processing: { maxLocalCalls: 1, minQuotaPercent: 0 } });

  registry = new WorkspaceContextRegistry(root, { templateConfig: () => rootCtx.config, log: (m) => logs.push(m) });
  app = createApp(rootCtx, (m) => logs.push(m), registry);
}, 60_000);

afterAll(async () => {
  await registry.closeAll();
  await rootCtx.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the server\'s processing and stage settings', () => {
  it('reach a new workspace, with the agent its stages run on and the row the Judge stage names', async () => {
    const res = await app.request('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json', 'x-knode-user': 'admin' }, body: JSON.stringify({ name: 'Finance' }) });
    expect(res.status).toBe(201);
    const ctx = await registry.get(finance);
    expect(fs.readFileSync(path.join(ctx.dataDir, 'playbooks', 'agents', 'connection-3.yaml'), 'utf8')).toBe(CODEX_AGENT);
    expect(ctx.config.extraction.entityLlm).toMatchObject({ use: 'connection-3', model: 'gpt-6.1-sol', effort: 'medium', speed: 'fast' });
    expect(ctx.config.extraction.judgeLlm.use).toBe('api-judge');
    expect(ctx.config.connections.find((c) => c.id === 'api-judge')?.apiKey).toBe('sk-shared-judge');
    expect(ctx.config.processing).toEqual({ maxLocalCalls: 6, minQuotaPercent: 10 });
    expect(sharedSettingsOf(ctx.config)).toEqual(sharedSettingsOf(rootCtx.config));
  });

  it('replace an existing workspace\'s own when it opens, keep its content settings, and are not pinned back', async () => {
    const ctx = await registry.get(shelf);
    expect(ctx.config.extraction.workers).toEqual([{ use: 'connection-3', slots: 2, model: 'gpt-6.1-sol', effort: 'medium' }]);
    expect(ctx.config.extraction.summaryLlm).toMatchObject({ use: 'connection-3', speed: 'fast' });
    // the root says nothing of summaryConcurrency: the workspace's own 2 goes, and `concurrency` counts
    expect(ctx.config.extraction.summaryConcurrency).toBeUndefined();
    expect(ctx.config.extraction.concurrency).toBe(3);
    // an old `autoStart` does not travel, and is gone from the file
    expect(ctx.config.processing).toEqual({ maxLocalCalls: 6, minQuotaPercent: 10 });
    expect(JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'knode.config.json'), 'utf8')).processing).toEqual({ maxLocalCalls: 6, minQuotaPercent: 10 });
    // content settings stay its own, and so does its own agent
    expect(ctx.config.languages).toMatchObject({ enabled: true, primary: 'en' });
    expect(ctx.config.llmUse).toBe('openai-1');
    expect(fs.existsSync(path.join(ctx.dataDir, 'playbooks', 'agents', 'codex.yaml'))).toBe(true);
    // read again from the file, nothing moves: every target resolves there
    const before = fs.readFileSync(path.join(ctx.dataDir, 'knode.config.json'), 'utf8');
    const again = loadConfig(ctx.dataDir);
    expect(again.extraction.entityLlm.use).toBe('connection-3');
    expect(again.extraction.judgeLlm.use).toBe('api-judge');
    expect(fs.readFileSync(path.join(ctx.dataDir, 'knode.config.json'), 'utf8')).toBe(before);
    // a second sync has nothing to write
    expect(syncWorkspaceSettings(root, rootCtx.config, ctx.dataDir)).toBe(false);
    expect(logs).toContain('[users/reader/workspaces/library] took the server\'s processing and stage settings');
  });

  it('go from an administrator\'s save in one workspace to the root, every other workspace and the open ones', async () => {
    const shelfCtx = await registry.get(shelf);
    const llmBefore = shelfCtx.llm;
    const res = await app.request('/api/config', {
      method: 'PUT',
      headers: headersFor(finance),
      body: JSON.stringify({ processing: { maxLocalCalls: 4 }, extraction: { judgeLlm: route({ effort: 'high' }) } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shared?: { written: number; reloaded: number; failed: number; renamed: Record<string, string> } };
    expect(body.shared).toEqual({ written: 2, reloaded: 1, failed: 0, renamed: {} });
    // the root's file and the copy serve holds
    expect(loadConfig(root).processing).toEqual({ maxLocalCalls: 4, minQuotaPercent: 10 });
    expect(rootCtx.config.extraction.judgeLlm).toMatchObject({ use: 'connection-3', effort: 'high' });
    // the open workspace runs on it now: its config and its Judge client
    expect(shelfCtx.config.processing).toEqual({ maxLocalCalls: 4, minQuotaPercent: 10 });
    expect(shelfCtx.config.extraction.judgeLlm).toMatchObject({ use: 'connection-3', effort: 'high' });
    expect(shelfCtx.llm).not.toBe(llmBefore);
    // a closed one has it in its file, for when it opens
    const archive = loadConfig(path.join(root, closed.relativeDir));
    expect(archive.processing).toEqual({ maxLocalCalls: 4, minQuotaPercent: 10 });
    expect(archive.extraction.entityLlm.use).toBe('connection-3');
    expect(fs.readFileSync(path.join(root, closed.relativeDir, 'playbooks', 'agents', 'connection-3.yaml'), 'utf8')).toBe(CODEX_AGENT);
    expect(logs.some((m) => m.startsWith('settings: the processing and stage settings saved in users/admin/workspaces/finance apply to every workspace now'))).toBe(true);
  });

  it('move a workspace\'s own model aside when the server\'s stages arrive under its id', async () => {
    // copied in from elsewhere after the stages were shared: its own default has the id they run on
    oldWorkspace(clash, {
      connections: [{ id: 'connection-3', label: 'my API', provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-mine', protocol: 'chat', model: 'my-model', cliPath: '', effort: 'default', cliTimeoutMs: 30_000 }],
      llmUse: 'connection-3',
    } as never);
    const ctx = await registry.get(clash);
    expect(ctx.config.llmUse).toBe('connection-3-own');
    expect(ctx.config.connections.find((c) => c.id === 'connection-3-own')).toMatchObject({ apiKey: 'sk-mine', model: 'my-model' });
    expect(ctx.config.connections.some((c) => c.id === 'connection-3')).toBe(false);
    expect(ctx.config.extraction.entityLlm.use).toBe('connection-3');
    expect(fs.readFileSync(path.join(ctx.dataDir, 'playbooks', 'agents', 'connection-3.yaml'), 'utf8')).toBe(CODEX_AGENT);
    expect(logs).toContain('[users/reader/workspaces/clash] its own "connection-3" is "connection-3-own" now: the server\'s stages run on another "connection-3"');
  });

  it('give a stage on a workspace\'s default an id of its own, so it takes over no other workspace\'s default', async () => {
    const ctx = await registry.get(finance);
    // finance's default row: every workspace made from the root has an "openai-1" of its own
    const own = ctx.config.llmUse;
    const res = await app.request('/api/config', {
      method: 'PUT',
      headers: headersFor(finance),
      body: JSON.stringify({
        connections: ctx.config.connections.map((c) => (c.id === own ? { ...c, baseUrl: 'http://127.0.0.1:9/finance', model: 'finance-default' } : c)),
        extraction: { summaryLlm: route({ use: own, model: '' }) },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shared: { renamed: Record<string, string> } };
    expect(body.shared.renamed).toEqual({ [own]: `${own}-server` });
    expect(ctx.config.extraction.summaryLlm.use).toBe(`${own}-server`);
    expect(ctx.config.llmUse).toBe(own);
    // everyone runs summaries on finance's endpoint, and keeps a default of their own
    for (const scope of [shelf, closed]) {
      const other = loadConfig(path.join(root, scope.relativeDir));
      expect(other.extraction.summaryLlm.use).toBe(`${own}-server`);
      expect(other.connections.find((c) => c.id === `${own}-server`)?.model).toBe('finance-default');
      expect(other.connections.find((c) => c.id === other.llmUse)?.model ?? '').not.toBe('finance-default');
    }
    expect(loadConfig(root).connections.find((c) => c.id === loadConfig(root).llmUse)?.model ?? '').not.toBe('finance-default');
    // back on the Codex agent for what follows
    await app.request('/api/config', { method: 'PUT', headers: headersFor(finance), body: JSON.stringify({ extraction: { summaryLlm: route() } }) });
  });

  it('leave a save of content settings in its workspace', async () => {
    const res = await app.request('/api/config', { method: 'PUT', headers: headersFor(finance), body: JSON.stringify({ languages: { enabled: true, primary: 'zh' } }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { shared?: unknown }).shared).toBeUndefined();
    expect((await registry.get(shelf)).config.languages.primary).toBe('en');
    expect(rootCtx.config.languages.enabled).toBe(false);
  });

  it('carry an edit of the agent a stage runs on everywhere, to a workspace whose research runs on it too', async () => {
    // the archive's research runs on the server's agent: an edit made in another workspace is an edit of it
    const archiveDir = path.join(root, closed.relativeDir);
    const archive = loadConfig(archiveDir);
    archive.research.agent = 'connection-3';
    saveConfig(archiveDir, archive);
    const res = await app.request('/api/agents/connection-3', {
      method: 'PUT',
      headers: headersFor(shelf),
      body: JSON.stringify({ agent: { title: 'codex', executor: 'codex-cli', model: 'gpt-6.2-sol', effort: 'medium' } }),
    });
    expect(res.status).toBe(200);
    const edited = fs.readFileSync(path.join(root, shelf.relativeDir, 'playbooks', 'agents', 'connection-3.yaml'), 'utf8');
    expect(edited).toContain('gpt-6.2-sol');
    expect(rootCtx.config.extraction.entityLlm.use).toBe('connection-3');
    for (const dir of [root, path.join(root, finance.relativeDir), archiveDir]) {
      expect(fs.readFileSync(path.join(dir, 'playbooks', 'agents', 'connection-3.yaml'), 'utf8')).toBe(edited);
    }
    // the open workspace's stages see the new model through its re-read agents
    expect((await registry.get(finance)).config.agentLlms?.find((a) => a.id === 'connection-3')?.model).toBe('gpt-6.2-sol');
    expect(loadConfig(archiveDir).research.agent).toBe('connection-3');
  });

  it('take the same row written in another key order for the same row, and rename nothing for it', () => {
    const base = path.join(tmp, 'order');
    const row = { id: 'openai-1', label: 'OpenAI-compatible API', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'env:OPENAI_API_KEY', protocol: 'auto', model: '', cliPath: '', effort: 'default', cliTimeoutMs: 300_000 };
    const reordered = Object.fromEntries(Object.entries(row).reverse());
    const write = (dir: string, connections: unknown[]) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'knode.config.json'), JSON.stringify({ connections, llmUse: 'openai-1' }));
    };
    write(base, [row]);
    write(path.join(base, 'users', 'a', 'workspaces', 'one'), [reordered]);
    write(path.join(base, 'users', 'a', 'workspaces', 'two'), [row]);
    const from = loadConfig(path.join(base, 'users', 'a', 'workspaces', 'one'));
    expect(from.extraction.summaryLlm.use).toBe('openai-1');
    expect(settleSharedIds(base, loadConfig(base), path.join(base, 'users', 'a', 'workspaces', 'one'), from).size).toBe(0);
  });

  it('list every workspace folder, a Team of its own included and a shared one left to its owner', () => {
    fs.mkdirSync(path.join(root, 'teams', 'research'), { recursive: true });
    fs.symlinkSync(`../${shelf.relativeDir}`, path.join(root, 'teams', 'library'));
    expect(workspaceDirs(root).map((d) => path.relative(root, d)).sort()).toEqual([
      'teams/research', 'users/admin/workspaces/finance', 'users/reader/workspaces/archive', 'users/reader/workspaces/clash', 'users/reader/workspaces/library',
    ]);
  });
});
