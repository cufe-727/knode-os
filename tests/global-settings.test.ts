import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { defaultRoutedLlmConfig, KnodeConfig, loadConfig, saveConfig } from '../src/config.js';
import { sharedSettingsOf, syncWorkspaceSettings, workspaceDirs } from '../src/global-settings.js';
import { createApp } from '../src/server/app.js';
import { WorkspaceContextRegistry, WorkspaceScope } from '../src/server/workspaces.js';

/**
 * Every setting but what a workspace contains is the server's
 * (src/global-settings.ts): the root config holds them, every workspace takes
 * them when it opens — a new one included — and an administrator's change in
 * any workspace reaches the root, every other workspace's files and the
 * workspaces open now. The agents they name travel with them, so no route is
 * pinned back to the default for want of its target. A workspace's data
 * sources, linked folders and code repositories stay its own.
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
const sourced = personal('reader', 'sourced', 'Sourced');

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

describe('the server\'s settings', () => {
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

  it('replace all of an existing workspace\'s settings when it opens, and are not pinned back', async () => {
    const ctx = await registry.get(shelf);
    expect(ctx.config.extraction.workers).toEqual([{ use: 'connection-3', slots: 2, model: 'gpt-6.1-sol', effort: 'medium' }]);
    expect(ctx.config.extraction.summaryLlm).toMatchObject({ use: 'connection-3', speed: 'fast' });
    // the root says nothing of summaryConcurrency: the workspace's own 2 goes, and `concurrency` counts
    expect(ctx.config.extraction.summaryConcurrency).toBeUndefined();
    expect(ctx.config.extraction.concurrency).toBe(3);
    // an old `autoStart` does not travel, and is gone from the file
    expect(ctx.config.processing).toEqual({ maxLocalCalls: 6, minQuotaPercent: 10 });
    expect(JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'knode.config.json'), 'utf8')).processing).toEqual({ maxLocalCalls: 6, minQuotaPercent: 10 });
    // what used to be its own is the server's too: languages, the default model
    expect(ctx.config.languages).toEqual(rootCtx.config.languages);
    expect(ctx.config.llmUse).toBe(rootCtx.config.llmUse);
    expect(sharedSettingsOf(ctx.config)).toEqual(sharedSettingsOf(rootCtx.config));
    // an agent file of its own that nothing shared names is left where it is
    expect(fs.existsSync(path.join(ctx.dataDir, 'playbooks', 'agents', 'codex.yaml'))).toBe(true);
    // read again from the file, nothing moves: every target resolves there
    const before = fs.readFileSync(path.join(ctx.dataDir, 'knode.config.json'), 'utf8');
    const again = loadConfig(ctx.dataDir);
    expect(again.extraction.entityLlm.use).toBe('connection-3');
    expect(again.extraction.judgeLlm.use).toBe('api-judge');
    expect(fs.readFileSync(path.join(ctx.dataDir, 'knode.config.json'), 'utf8')).toBe(before);
    // a second sync has nothing to write
    expect(syncWorkspaceSettings(root, rootCtx.config, ctx.dataDir)).toBe(false);
    expect(logs).toContain('[users/reader/workspaces/library] took the server\'s settings');
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
    const body = (await res.json()) as { shared?: { written: number; reloaded: number; failed: number; reembedded: number } };
    expect(body.shared).toEqual({ written: 2, reloaded: 1, failed: 0, reembedded: 0 });
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
    expect(logs.some((m) => m.startsWith('settings: the settings saved in users/admin/workspaces/finance apply to every workspace now'))).toBe(true);
  });

  it('share languages, research and embedding from a save in any workspace', async () => {
    const res = await app.request('/api/config', {
      method: 'PUT',
      headers: headersFor(finance),
      body: JSON.stringify({ languages: { enabled: true, primary: 'zh' }, ingest: { embedding: 'deferred', embedSlots: 3 } }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { shared?: { written: number } }).shared?.written).toBe(2);
    const shelfCtx = await registry.get(shelf);
    expect(shelfCtx.config.languages).toMatchObject({ enabled: true, primary: 'zh' });
    expect(shelfCtx.config.ingest).toMatchObject({ embedding: 'deferred', embedSlots: 3 });
    expect(loadConfig(path.join(root, closed.relativeDir)).languages.primary).toBe('zh');
    expect(rootCtx.config.languages.primary).toBe('zh');
  });

  it('move an open workspace onto the embedding model another workspace saved', async () => {
    const shelfCtx = await registry.get(shelf);
    const embedderBefore = shelfCtx.embedder;
    const financeCtx = await registry.get(finance);
    const dimensions = financeCtx.config.embedding.dimensions === 256 ? 384 : 256;
    const res = await app.request('/api/config', {
      method: 'PUT',
      headers: headersFor(finance),
      body: JSON.stringify({ embedding: { dimensions, sendDimensions: true } }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { shared?: { reembedded: number } }).shared?.reembedded).toBe(1);
    expect(shelfCtx.embedder).not.toBe(embedderBefore);
    expect(shelfCtx.embedder.dimensions).toBe(dimensions);
    expect(shelfCtx.store.embeddingDim).toBe(dimensions);
  });

  it('keep what a workspace contains its own: data sources, linked folders and code repositories', async () => {
    const linked = [{ source: '/tmp/somewhere', dest: 'raw/docs/somewhere', createdAt: '2026-11-01T00:00:00.000Z' }];
    oldWorkspace(sourced, {
      ingest: { linkedFolders: linked, embedding: 'inline' } as never,
      datasources: [{ name: 'mine', kind: 'sql' }] as never,
      llmUse: 'mine',
    } as never);
    const ctx = await registry.get(sourced);
    expect(ctx.config.ingest.linkedFolders).toEqual(linked);
    expect(ctx.config.datasources).toEqual([{ name: 'mine', kind: 'sql' }]);
    expect(ctx.config.ingest.embedding).toBe('deferred');
    expect(ctx.config.llmUse).toBe(rootCtx.config.llmUse);
    // and they stay with it, never reaching the root or another workspace, when it saves
    const res = await app.request('/api/config', { method: 'PUT', headers: headersFor(sourced), body: JSON.stringify({ processing: { maxLocalCalls: 5 } }) });
    expect(res.status).toBe(200);
    expect(rootCtx.config.ingest.linkedFolders ?? []).toEqual([]);
    expect(loadConfig(path.join(root, shelf.relativeDir)).ingest.linkedFolders ?? []).toEqual([]);
    expect(loadConfig(path.join(root, shelf.relativeDir)).processing.maxLocalCalls).toBe(5);
    expect(loadConfig(ctx.dataDir).ingest.linkedFolders).toEqual(linked);
  });

  it('carry an edit of the agent a stage runs on everywhere, to a workspace whose research runs on it too', async () => {
    const archiveDir = path.join(root, closed.relativeDir);
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
  });

  it('carry the agent research runs on, which no stage names', async () => {
    const financeCtx = await registry.get(finance);
    fs.writeFileSync(path.join(financeCtx.dataDir, 'playbooks', 'agents', 'researcher.yaml'), 'name: researcher\ntitle: R\nexecutor: codex-cli\ncliPath: \'\'\nmodel: gpt-6.1-sol\neffort: high\nspeed: default\n');
    const res = await app.request('/api/config', { method: 'PUT', headers: headersFor(finance), body: JSON.stringify({ research: { agent: 'researcher' } }) });
    expect(res.status).toBe(200);
    for (const scope of [shelf, closed]) {
      const dir = path.join(root, scope.relativeDir);
      expect(fs.existsSync(path.join(dir, 'playbooks', 'agents', 'researcher.yaml'))).toBe(true);
      expect(loadConfig(dir).research.agent).toBe('researcher');
    }
  });

  it('list every workspace folder, a Team of its own included and a shared one left to its owner', () => {
    fs.mkdirSync(path.join(root, 'teams', 'research'), { recursive: true });
    fs.symlinkSync(`../${shelf.relativeDir}`, path.join(root, 'teams', 'library'));
    expect(workspaceDirs(root).map((d) => path.relative(root, d)).sort()).toEqual([
      'teams/research', 'users/admin/workspaces/finance', 'users/reader/workspaces/archive', 'users/reader/workspaces/library', 'users/reader/workspaces/sourced',
    ]);
  });
});
