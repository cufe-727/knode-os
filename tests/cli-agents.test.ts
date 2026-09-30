import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, defaultRoutedLlmConfig, KnodeConfig, LlmConnection, llmTargets, loadConfig, resolveRoutedLlmConfig, routeTargets } from '../src/config.js';
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
    saveAgent(dir, { name: 'mine', executor: 'connection-3' });
    saveAgent(dir, { name: 'bare', executor: 'cursor-cli' });

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
    saveAgent(dir, { name: 'cursor-cli-1', executor: 'default', title: 'Something else' });

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
    // the stage lands on the default by name, not on "whatever the default is"
    expect(current.extraction.entityLlm.use).toBe('connection-1');
  });

  it('moves CLI rows an older client still sends into agents', async () => {
    const saved = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ connections: [relay, codex] }) });
    expect(saved.status).toBe(200);
    expect((await config()).connections.map((c) => c.id)).toEqual(['connection-1']);
    const agents = (await (await app.request('/api/agents', { headers })).json()) as { agents: Array<{ name: string; executor: string }> };
    expect(agents.agents.find((a) => a.name === 'connection-3')).toMatchObject({ executor: 'codex-cli' });
  });

  it('runs a stage on a deepagents agent that pins a model, and moves it off by name', async () => {
    await app.request('/api/agents/drafter', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ agent: { title: 'Drafter', executor: 'connection-1', model: 'drafter-model' } }),
    });
    const saved = await app.request('/api/config', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        connections: [relay],
        llmUse: 'connection-1',
        extraction: { entityLlm: { use: 'drafter' }, conceptLlm: { use: 'deep-agent' }, documentLlm: { use: '' } },
      }),
    });
    expect(saved.status).toBe(200);
    let current = await config();
    expect(current.extraction.entityLlm.use).toBe('drafter');
    // the built-in pins no model, so it is its endpoint's row again: the stage lands on that
    expect(current.extraction.conceptLlm.use).toBe('connection-1');
    // a stage that names nothing is written down as the default
    expect(current.extraction.documentLlm.use).toBe('connection-1');
    expect(current.modelAgents).toBeUndefined();

    // give the built-in a model of its own and a stage can name it ...
    await app.request('/api/agents/deep-agent', { method: 'PUT', headers, body: JSON.stringify({ agent: { executor: 'default', model: 'own-model' } }) });
    await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ extraction: { conceptLlm: { use: 'deep-agent' } } }) });
    expect((await config()).extraction.conceptLlm.use).toBe('deep-agent');
    // ... until a reset takes the model away, and the stage follows to the endpoint it runs on
    await app.request('/api/agents/deep-agent', { method: 'DELETE', headers });
    expect((await config()).extraction.conceptLlm.use).toBe('connection-1');

    await app.request('/api/agents/drafter', { method: 'DELETE', headers });
    current = await config();
    expect(current.extraction.entityLlm.use).toBe('connection-1');
  });
});

/**
 * A stage sends its own prompt and wants one answer back, so an agent runs it
 * one-shot: a CLI agent as itself, a deepagents agent as the model it runs on.
 * One with no model of its own is that endpoint's row again, so it is no target.
 */
describe('deepagents agents as pipeline stages', () => {
  const other = row({ id: 'connection-2', label: 'other', provider: 'openai', baseUrl: 'https://other.example/v1', apiKey: 'sk-2', model: 'other-model' });

  it('runs a stage on the model an agent pins, and moves one on a model-less agent to its endpoint', () => {
    const base = defaultConfig();
    const { id: _id, ...mirror } = relay;
    const dir = workspace('deepagents-stages', {
      llm: mirror,
      connections: [relay, other],
      llmUse: 'connection-1',
      extraction: {
        ...base.extraction,
        entityLlm: { ...defaultRoutedLlmConfig(), use: 'deep-agent' },
        conceptLlm: { ...defaultRoutedLlmConfig(), use: 'pinned' },
        documentLlm: { ...defaultRoutedLlmConfig(), use: 'plain', model: 'route-model' },
      },
    });
    saveAgent(dir, { name: 'pinned', title: 'Pinned', executor: 'connection-2', model: 'agent-model' });
    saveAgent(dir, { name: 'plain', title: 'Plain', executor: 'connection-2' });

    const loaded = loadConfig(dir);
    const resolve = (key: 'entityLlm' | 'conceptLlm' | 'documentLlm') =>
      resolveRoutedLlmConfig(loaded.llm, loaded.extraction[key], routeTargets(loaded));
    // one that pins a model brings that endpoint and its own model, and stays a target
    expect(loaded.extraction.conceptLlm.use).toBe('pinned');
    expect(resolve('conceptLlm')).toMatchObject({ baseUrl: 'https://other.example/v1', apiKey: 'sk-2', model: 'agent-model' });
    expect(routeTargets(loaded).find((t) => t.id === 'pinned')).toMatchObject({ label: 'Pinned', model: 'agent-model' });

    // one without is the endpoint it runs on, under another name: the stage
    // moves there — the default's for the built-in that follows it, the pinned
    // connection for the other — and runs exactly as before, route model included
    expect(loaded.extraction.entityLlm.use).toBe('connection-1');
    expect(resolve('entityLlm')).toMatchObject({ provider: 'openai', baseUrl: 'https://relay.example/v1', model: 'ark/seed-evolving' });
    expect(loaded.extraction.documentLlm).toMatchObject({ use: 'connection-2', model: 'route-model' });
    expect(resolve('documentLlm')).toMatchObject({ baseUrl: 'https://other.example/v1', model: 'route-model' });
    expect(routeTargets(loaded).map((t) => t.id)).toEqual(['connection-1', 'connection-2', 'pinned']);

    // the default cannot be an agent like these, since they may follow it
    expect(llmTargets(loaded).map((t) => t.id)).toEqual(['connection-1', 'connection-2']);
  });

  it('leaves out one that follows a CLI default, and moves its stage to that default', () => {
    const base = defaultConfig();
    const claude = row({ id: 'claude-cli-1', label: 'Claude', provider: 'claude-cli' });
    const { id: _id, ...mirror } = claude;
    const dir = workspace('deepagents-cli-default', {
      llm: mirror,
      connections: [claude],
      llmUse: 'claude-cli-1',
      extraction: { ...base.extraction, entityLlm: { ...defaultRoutedLlmConfig(), use: 'follower' } },
    });
    // a model of its own, so it is only the CLI default that keeps it out
    saveAgent(dir, { name: 'follower', executor: 'default', model: 'own-model' });

    const loaded = loadConfig(dir);
    expect(routeTargets(loaded).map((t) => t.id)).toEqual(['claude-cli-1']);
    // what it would have run anyway, now written down
    expect(loaded.extraction.entityLlm.use).toBe('claude-cli-1');
  });
});

describe('effort and speed on a stage', () => {
  it('lets a stage set its own effort and speed, and otherwise runs at its target\'s', () => {
    const base = defaultConfig().llm;
    const fast = { ...codex, speed: 'fast' as const };
    const route = { ...defaultRoutedLlmConfig(), use: fast.id };
    // 'default' on the route is the agent's own setting
    expect(resolveRoutedLlmConfig(base, route, [fast])).toMatchObject({ provider: 'codex-cli', effort: 'high', speed: 'fast' });
    // a level of its own wins, one field at a time
    expect(resolveRoutedLlmConfig(base, { ...route, effort: 'ultra' }, [fast])).toMatchObject({ effort: 'ultra', speed: 'fast' });
    expect(resolveRoutedLlmConfig(base, { ...route, speed: 'fast' }, [codex])).toMatchObject({ effort: 'high', speed: 'fast' });
  });

  it('reads a CLI agent\'s speed from its file, as the stages see it', () => {
    const dir = workspace('agent-speed', {});
    saveAgent(dir, { name: 'quick', executor: 'codex-cli', model: 'gpt-6.1-sol', speed: 'fast' });
    saveAgent(dir, { name: 'odd', executor: 'codex-cli', speed: 'warp' as never });
    expect(loadAgent(dir, 'quick')).toMatchObject({ speed: 'fast' });
    const targets = llmTargets(loadConfig(dir));
    expect(targets.find((t) => t.id === 'quick')).toMatchObject({ provider: 'codex-cli', speed: 'fast' });
    // an unknown tier is no tier
    expect(targets.find((t) => t.id === 'odd')).toMatchObject({ speed: 'default' });
  });
});
