import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, saveConfig } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { AGENTS_DIR } from '../src/fs/layout.js';
import { agentForSpec, resolveAgentSpec } from '../src/research/agent.js';
import { AgentDefinition, ensureDefaultAgents, loadAgent, loadAgents, saveAgent, deleteAgent } from '../src/research/agents.js';
import { createApp } from '../src/server/app.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-agents-'));
const root = path.join(tmp, 'data');

const headers = {
  'content-type': 'application/json',
  'x-knode-user': 'tester',
  'x-knode-workspace-kind': 'personal',
  'x-knode-workspace-id': 'default',
  'x-knode-workspace-name': 'Default',
};

let rootCtx: AppContext;
let registry: WorkspaceContextRegistry;
let app: ReturnType<typeof createApp>;
let workspaceDir: string;

beforeAll(async () => {
  rootCtx = await createContext(root);
  registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
  app = createApp(rootCtx, () => {}, registry);
  await app.request('/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-knode-user': 'tester' },
    body: JSON.stringify({ name: 'Default' }),
  });
  workspaceDir = path.join(root, 'users', 'tester', 'workspaces', 'default');
});

afterAll(async () => {
  await registry.closeAll();
  await rootCtx.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * Named agents: the thing a person adds and points research or chat at. Who
 * runs a job lives here; how the research itself is conducted stays in the
 * profile.
 */
describe('agent definitions', () => {
  it('seeds one template per kind, and a deleted built-in comes back', () => {
    const dir = path.join(tmp, 'seed');
    fs.mkdirSync(dir, { recursive: true });
    expect(ensureDefaultAgents(dir)).toEqual([
      `${AGENTS_DIR}/deep-agent.yaml`,
      `${AGENTS_DIR}/deep-research.yaml`,
    ]);
    // seeding twice writes nothing, so a user edit is never clobbered
    expect(ensureDefaultAgents(dir)).toEqual([]);

    const agents = loadAgents(dir);
    expect(agents.get('deep-agent')).toMatchObject({ kind: 'general', executor: 'default' });
    expect(agents.get('deep-research')).toMatchObject({ kind: 'deep-research' });

    expect(deleteAgent(dir, 'deep-agent')).toBe(true);
    expect(loadAgent(dir, 'deep-agent')).toMatchObject({ kind: 'general' });
  });

  it('keeps an edit and fills what the file leaves out', () => {
    const dir = path.join(tmp, 'edit');
    fs.mkdirSync(dir, { recursive: true });
    saveAgent(dir, { name: 'cheap', kind: 'general', executor: 'cursor-cli', effort: 'low' } as Partial<AgentDefinition> & { name: string });
    const loaded = loadAgent(dir, 'cheap');
    expect(loaded).toMatchObject({ name: 'cheap', executor: 'cursor-cli', effort: 'low', kind: 'general' });
    // the fields the caller omitted come from the general template
    expect(loaded?.tools).toEqual({ write: false, files: true, web: 'inherit' });
    expect(loaded?.path).toBe(`${AGENTS_DIR}/cheap.yaml`);

    expect(() => saveAgent(dir, { name: 'not a name' })).toThrow(/invalid agent name/);
  });

  it('resolves a name to its executor, and leaves a bare spec alone', () => {
    const dir = path.join(tmp, 'resolve');
    fs.mkdirSync(dir, { recursive: true });
    const config = defaultConfig();
    config.connections = [{ id: 'ark', label: 'Ark', provider: 'openai', baseUrl: 'https://ark.example/v1', apiKey: 'sk', model: 'doubao', cliPath: '', cliTimeoutMs: 300_000 }];
    saveAgent(dir, { name: 'writer', kind: 'deep-research', executor: 'ark', model: 'doubao-pro' });

    expect(agentForSpec(config, 'writer', '', dir)).toMatchObject({ kind: 'builtin', baseUrl: 'https://ark.example/v1', model: 'doubao-pro' });
    // a pre-agents config names the connection straight, and still resolves
    expect(agentForSpec(config, 'ark', '', dir)).toMatchObject({ kind: 'builtin', model: 'doubao' });
    expect(agentForSpec(config, 'cursor-cli', '', dir)).toMatchObject({ kind: 'cli', provider: 'cursor-cli' });
    expect(agentForSpec(config, 'nobody', '', dir)).toBeNull();
  });

  it('hands back the definition a name resolved through, so its settings can be read', () => {
    const dir = path.join(tmp, 'resolve-definition');
    fs.mkdirSync(dir, { recursive: true });
    const config = defaultConfig();
    config.connections = [{ id: 'ark', label: 'Ark', provider: 'openai', baseUrl: 'https://ark.example/v1', apiKey: 'sk', model: 'doubao', cliPath: '', cliTimeoutMs: 300_000 }];
    saveAgent(dir, { name: 'writer', kind: 'general', executor: 'ark', model: 'doubao-pro', maxTurns: 7, effort: 'high' });

    const named = resolveAgentSpec(config, 'writer', '', dir);
    expect(named?.agent).toMatchObject({ kind: 'builtin', model: 'doubao-pro' });
    expect(named?.definition).toMatchObject({ name: 'writer', maxTurns: 7, effort: 'high' });

    // a bare spec has no definition to read settings from, by construction
    expect(resolveAgentSpec(config, 'ark', '', dir)?.definition).toBeNull();
    expect(resolveAgentSpec(config, 'cursor-cli', '', dir)?.definition).toBeNull();
    expect(resolveAgentSpec({ ...config, llm: { ...config.llm, model: 'gpt-4.1-mini' } }, 'default', '', dir)?.definition).toBeNull();
    // 'default' is only resolvable when the section-01 connection can run a session
    expect(resolveAgentSpec(config, 'default', '', dir)).toBeNull();
    expect(resolveAgentSpec(config, 'nobody', '', dir)).toBeNull();
  });
});

describe('the agents API', () => {
  const read = async (path: string) => app.request(path, { headers });

  it('lists the templates a new workspace starts with', async () => {
    const body = (await read('/api/agents').then((r) => r.json())) as { agents: Array<{ name: string; kind: string; builtin: boolean }> };
    expect(body.agents.map((a) => a.name).sort()).toEqual(['deep-agent', 'deep-research']);
    expect(body.agents.every((a) => a.builtin)).toBe(true);
  });

  it('creates one, points research at it, and refuses an unknown name', async () => {
    const created = await app.request('/api/agents/mine', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ agent: { kind: 'deep-research', title: '我的研究员', executor: 'cursor-cli', effort: 'high' } }),
    });
    expect(created.status).toBe(200);
    expect((await created.json()) as { title: string }).toMatchObject({ title: '我的研究员', executor: 'cursor-cli', effort: 'high' });

    const saved = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ research: { agent: 'mine' } }) });
    expect(saved.status).toBe(200);

    const rejected = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ research: { agent: 'no-such-agent' } }) });
    expect(rejected.status).toBe(400);
  });

  it('moves the config off an agent it deletes, and resets a built-in instead', async () => {
    expect(((await read('/api/config').then((r) => r.json())) as { research: { agent: string } }).research.agent).toBe('mine');

    const removed = await app.request('/api/agents/mine', { method: 'DELETE', headers });
    expect((await removed.json()) as { reset: boolean }).toMatchObject({ ok: true, reset: false });
    expect(((await read('/api/config').then((r) => r.json())) as { research: { agent: string } }).research.agent).toBe('');
    expect(fs.existsSync(path.join(workspaceDir, AGENTS_DIR, 'mine.yaml'))).toBe(false);

    const builtin = await app.request('/api/agents/deep-agent', { method: 'DELETE', headers });
    expect((await builtin.json()) as { reset: boolean }).toMatchObject({ reset: true });
    expect((await read('/api/agents/deep-agent')).status).toBe(200);
  });
});
