import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, defaultRoutedLlmConfig, KnodeConfig, LlmConnection, llmTargets, loadConfig, resolveRoutedLlmConfig } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { resolveAgentSpec } from '../src/research/agent.js';
import { ensureDefaultAgents, loadAgent, saveAgent } from '../src/research/agents.js';
import { createApp } from '../src/server/app.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-cli-agents-'));

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function workspace(name: string, config: Partial<KnodeConfig>): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'knode.config.json'), JSON.stringify({ ...defaultConfig(), ...config }));
  ensureDefaultAgents(dir);
  return dir;
}

const row = (patch: Partial<LlmConnection> & Pick<LlmConnection, 'id' | 'label' | 'provider'>): LlmConnection => ({
  baseUrl: '',
  apiKey: '',
  model: '',
  cliPath: '',
  effort: 'default',
  cliTimeoutMs: 300_000,
  ...patch,
});

const cursor = row({ id: 'cursor-cli-1', label: 'cursor', provider: 'cursor-cli', model: 'cursor-grok-4.6-high-fast' });
const relay = row({ id: 'connection-1', label: 'super-relay', provider: 'openai', baseUrl: 'https://relay.example/v1', apiKey: 'sk', model: 'ark/seed-evolving' });
const codex = row({ id: 'connection-3', label: 'codex', provider: 'codex-cli', model: 'gpt-6-sol', cliPath: '/opt/codex', effort: 'high' });

/**
 * A coding-agent CLI is an agent, not a model endpoint: it moved from
 * `connections` into `playbooks/agents/`. Everything that named one has to
 * keep running exactly where it ran — the default is the one deliberate move.
 */
describe('moving CLI rows into agents', () => {
  it('turns each CLI row into an agent, and nothing but the default runs anywhere new', () => {
    const base = defaultConfig();
    const { id: _id, ...mirror } = cursor;
    const dir = workspace('mixed', {
      llm: mirror,
      connections: [cursor, relay, codex],
      llmUse: 'cursor-cli-1',
      research: { ...base.research, agent: 'cursor-cli' },
      extraction: {
        ...base.extraction,
        entityLlm: { ...defaultRoutedLlmConfig(), use: 'connection-1' },
        conceptLlm: { ...defaultRoutedLlmConfig(), use: 'connection-3' },
      },
    });
    // one agent ran on a CLI row by id, one on a bare CLI that borrowed the default's model
    saveAgent(dir, { name: 'mine', kind: 'deep-research', executor: 'connection-3' });
    saveAgent(dir, { name: 'bare', kind: 'general', executor: 'cursor-cli' });

    const loaded = loadConfig(dir);
    expect(loaded.connections.map((c) => c.id)).toEqual(['connection-1']);
    expect(loadAgent(dir, 'cursor-cli-1')).toMatchObject({ title: 'cursor', executor: 'cursor-cli', model: 'cursor-grok-4.6-high-fast', cliPath: '' });
    expect(loadAgent(dir, 'connection-3')).toMatchObject({ title: 'codex', executor: 'codex-cli', model: 'gpt-6-sol', cliPath: '/opt/codex', effort: 'high' });
    expect(loadAgent(dir, 'mine')).toMatchObject({ executor: 'codex-cli', cliPath: '/opt/codex', model: 'gpt-6-sol' });
    expect(loadAgent(dir, 'bare')).toMatchObject({ executor: 'cursor-cli', model: 'cursor-grok-4.6-high-fast' });

    // the default moves to the model endpoint, because deepagents follows it
    expect(loaded.llmUse).toBe('connection-1');
    expect(loaded.llm).toMatchObject({ provider: 'openai', model: 'ark/seed-evolving', label: 'super-relay' });
    expect(resolveAgentSpec(loaded, 'deep-agent', '', dir)?.agent).toMatchObject({ kind: 'builtin', model: 'ark/seed-evolving' });

    // a route on a CLI row still runs that CLI, one-shot
    expect(resolveRoutedLlmConfig(loaded.llm, loaded.extraction.conceptLlm, llmTargets(loaded))).toMatchObject({
      provider: 'codex-cli',
      model: 'gpt-6-sol',
      cliPath: '/opt/codex',
    });
    expect(resolveRoutedLlmConfig(loaded.llm, loaded.extraction.entityLlm, llmTargets(loaded))).toMatchObject({ provider: 'openai', model: 'ark/seed-evolving' });

    // research becomes the agent its bare CLI name borrowed from, and runs the same
    expect(loaded.research.agent).toBe('cursor-cli-1');
    expect(resolveAgentSpec(loaded, loaded.research.agent, '', dir)?.agent).toEqual({
      kind: 'cli',
      provider: 'cursor-cli',
      cliPath: '',
      model: 'cursor-grok-4.6-high-fast',
    });

    // written back once, without the derived copy, so the next load moves nothing
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'knode.config.json'), 'utf8')) as KnodeConfig;
    expect(onDisk.connections.map((c) => c.id)).toEqual(['connection-1']);
    expect(onDisk.llmUse).toBe('connection-1');
    expect(onDisk.agentLlms).toBeUndefined();
    const again = loadConfig(dir);
    expect(again.connections).toEqual(loaded.connections);
    expect(again.llmUse).toBe('connection-1');
    expect(again.research.agent).toBe('cursor-cli-1');
  });

  it('keeps a CLI as the default when there is no model to move to', () => {
    const claude = row({ id: 'claude-cli-1', label: 'Claude', provider: 'claude-cli' });
    const { id: _id, ...mirror } = claude;
    const dir = workspace('cli-only', { llm: mirror, connections: [claude], llmUse: 'claude-cli-1' });

    const loaded = loadConfig(dir);
    expect(loaded.connections).toEqual([]);
    expect(loaded.llmUse).toBe('claude-cli-1');
    expect(loaded.llm).toMatchObject({ provider: 'claude-cli' });
    // Ask with nothing configured still answers, on the CLI the default is ...
    expect(resolveAgentSpec(loaded, 'default', '', dir)?.agent).toMatchObject({ kind: 'cli', provider: 'claude-cli' });
    // ... but the deepagents template does not quietly run that CLI under its name
    expect(resolveAgentSpec(loaded, 'deep-agent', '', dir)).toBeNull();
    // and a reload does not rebuild a CLI row from the mirror
    expect(loadConfig(dir).connections).toEqual([]);
  });

  it('gives a CLI row a name of its own when another agent already has its id', () => {
    const base = defaultConfig();
    const dir = workspace('clash', {
      connections: [relay, cursor],
      llmUse: 'connection-1',
      extraction: { ...base.extraction, entityLlm: { ...defaultRoutedLlmConfig(), use: 'cursor-cli-1' } },
    });
    saveAgent(dir, { name: 'cursor-cli-1', kind: 'general', executor: 'default', title: 'Something else' });

    const loaded = loadConfig(dir);
    expect(loadAgent(dir, 'cursor-cli-1')).toMatchObject({ title: 'Something else', executor: 'default' });
    expect(loadAgent(dir, 'cursor-cli-1-agent')).toMatchObject({ executor: 'cursor-cli', model: 'cursor-grok-4.6-high-fast' });
    expect(loaded.extraction.entityLlm.use).toBe('cursor-cli-1-agent');
  });
});

describe('the agents API with CLI agents', () => {
  const root = path.join(tmp, 'api');
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
  const config = async () => (await (await app.request('/api/config', { headers })).json()) as KnodeConfig;

  beforeAll(async () => {
    rootCtx = await createContext(root);
    registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
    app = createApp(rootCtx, () => {}, registry);
    await app.request('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json', 'x-knode-user': 'tester' }, body: JSON.stringify({ name: 'Default' }) });
  });

  afterAll(async () => {
    await registry.closeAll();
    await rootCtx.store.close();
  });

  it('lets a CLI agent be the default and a route target, and moves both off it when it goes', async () => {
    const created = await app.request('/api/agents/clawd', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ agent: { title: 'Clawd', executor: 'claude-cli', cliPath: '/opt/claude', model: 'opus' } }),
    });
    expect(created.status).toBe(200);
    expect((await created.json()) as object).toMatchObject({ executor: 'claude-cli', cliPath: '/opt/claude', runnable: true });

    const saved = await app.request('/api/config', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        connections: [relay],
        llmUse: 'clawd',
        extraction: { entityLlm: { use: 'clawd' } },
      }),
    });
    expect(saved.status).toBe(200);
    let current = await config();
    expect(current.llmUse).toBe('clawd');
    expect(current.llm).toMatchObject({ provider: 'claude-cli', cliPath: '/opt/claude', model: 'opus' });
    expect(current.connections.map((c) => c.id)).toEqual(['connection-1']);
    // the service's derived copy stays the service's
    expect(current.agentLlms).toBeUndefined();

    // editing the agent reaches the default, which is a mirror of it
    await app.request('/api/agents/clawd', { method: 'PUT', headers, body: JSON.stringify({ agent: { title: 'Clawd', executor: 'claude-cli', cliPath: '/opt/claude', model: 'sonnet' } }) });
    expect((await config()).llm).toMatchObject({ model: 'sonnet' });

    const removed = await app.request('/api/agents/clawd', { method: 'DELETE', headers });
    expect(removed.status).toBe(200);
    current = await config();
    expect(current.llmUse).toBe('connection-1');
    expect(current.llm).toMatchObject({ provider: 'openai', model: 'ark/seed-evolving' });
    expect(current.extraction.entityLlm.use).toBe('');
  });

  it('moves CLI rows an older client still sends into agents', async () => {
    const saved = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ connections: [relay, codex] }) });
    expect(saved.status).toBe(200);
    expect((await config()).connections.map((c) => c.id)).toEqual(['connection-1']);
    const agents = (await (await app.request('/api/agents', { headers })).json()) as { agents: Array<{ name: string; executor: string }> };
    expect(agents.agents.find((a) => a.name === 'connection-3')).toMatchObject({ executor: 'codex-cli' });
  });
});
