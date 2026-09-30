import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, loadConfig, saveConfig } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { AGENTS_DIR } from '../src/fs/layout.js';
import { agentForSpec, resolveAgentSpec } from '../src/research/agent.js';
import { AgentDefinition, BUILTIN_AGENTS, ensureDefaultAgents, loadAgent, loadAgents, saveAgent, deleteAgent } from '../src/research/agents.js';
import { loadProfile } from '../src/research/profile.js';
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
  it('seeds the one template, and a deleted built-in comes back', () => {
    const dir = path.join(tmp, 'seed');
    fs.mkdirSync(dir, { recursive: true });
    expect(ensureDefaultAgents(dir)).toEqual([`${AGENTS_DIR}/deep-agent.yaml`]);
    // seeding twice writes nothing, so a user edit is never clobbered
    expect(ensureDefaultAgents(dir)).toEqual([]);

    const agents = loadAgents(dir);
    expect([...agents.keys()]).toEqual(['deep-agent']);
    expect(agents.get('deep-agent')).toMatchObject({ title: 'deep agent', executor: 'default', model: '' });
    expect(agents.get('deep-agent')).not.toHaveProperty('kind');

    expect(deleteAgent(dir, 'deep-agent')).toBe(true);
    expect(loadAgent(dir, 'deep-agent')).toMatchObject({ executor: 'default' });
  });

  it('keeps an edit and fills what the file leaves out', () => {
    const dir = path.join(tmp, 'edit');
    fs.mkdirSync(dir, { recursive: true });
    saveAgent(dir, { name: 'cheap', executor: 'cursor-cli', effort: 'low' } as Partial<AgentDefinition> & { name: string });
    const loaded = loadAgent(dir, 'cheap');
    expect(loaded).toMatchObject({ name: 'cheap', executor: 'cursor-cli', effort: 'low' });
    // the fields the caller omitted come from the general template
    expect(loaded?.tools).toEqual({ web: 'inherit' });
    expect(loaded?.path).toBe(`${AGENTS_DIR}/cheap.yaml`);

    expect(() => saveAgent(dir, { name: 'not a name' })).toThrow(/invalid agent name/);
  });

  it('resolves a name to its executor, and leaves a bare spec alone', () => {
    const dir = path.join(tmp, 'resolve');
    fs.mkdirSync(dir, { recursive: true });
    const config = defaultConfig();
    config.connections = [{ id: 'ark', label: 'Ark', provider: 'openai', baseUrl: 'https://ark.example/v1', apiKey: 'sk', model: 'doubao', cliPath: '', cliTimeoutMs: 300_000 }];
    saveAgent(dir, { name: 'writer', executor: 'ark', model: 'doubao-pro' });

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
    saveAgent(dir, { name: 'writer', executor: 'ark', model: 'doubao-pro', effort: 'high', tools: { web: 'off' } });

    const named = resolveAgentSpec(config, 'writer', '', dir);
    expect(named?.agent).toMatchObject({ kind: 'builtin', model: 'doubao-pro' });
    expect(named?.definition).toMatchObject({ name: 'writer', effort: 'high', tools: { web: 'off' } });

    // a bare spec has no definition to read settings from, by construction
    expect(resolveAgentSpec(config, 'ark', '', dir)?.definition).toBeNull();
    expect(resolveAgentSpec(config, 'cursor-cli', '', dir)?.definition).toBeNull();
    expect(resolveAgentSpec({ ...config, llm: { ...config.llm, model: 'gpt-4.1-mini' } }, 'default', '', dir)?.definition).toBeNull();
    // 'default' is only resolvable when the section-01 connection can run a session
    expect(resolveAgentSpec(config, 'default', '', dir)).toBeNull();
    expect(resolveAgentSpec(config, 'nobody', '', dir)).toBeNull();
  });
});

/**
 * `deep-research` shipped as a second template that was `deep-agent` under
 * another name. Loading the config retires it: an untouched copy goes and
 * whatever named it follows `deep-agent`; one someone edited stays.
 */
describe('retiring the deep-research template', () => {
  // the two files exactly as the old templates were seeded
  const seededResearch = [
    'name: deep-research',
    'title: 深度研究 agent',
    'description: 按 research profile 的阶段与子代理跑：规划 → 并行调查 → 综合 → 评审 → 修订，把页面写回 wiki。',
    'kind: deep-research',
    'executor: default',
    "model: ''",
    'effort: default',
    'tools:',
    '  write: true',
    '  files: true',
    '  web: inherit',
    'maxTurns: 0',
    'timeoutMs: 0',
    "prompt: ''",
    '',
  ].join('\n');
  const seededGeneral = seededResearch
    .replace('name: deep-research', 'name: deep-agent')
    .replace('title: 深度研究 agent', 'title: 通用 deep agent')
    .replace(/description: .*/, 'description: LangChain deepagents 循环，跑在 OpenAI 兼容连接上；单会话回答，可读知识库、可写隔离笔记。没装任何 CLI 的机器用它。')
    .replace('kind: deep-research', 'kind: general');

  function workspace(name: string, research: string): string {
    const dir = path.join(tmp, name);
    fs.mkdirSync(path.join(dir, AGENTS_DIR), { recursive: true });
    const config = defaultConfig();
    config.connections = [{ id: 'relay', label: 'relay', provider: 'openai', baseUrl: 'https://relay.example/v1', apiKey: 'sk', model: 'relay-model', cliPath: '', effort: 'default', cliTimeoutMs: 300_000 }];
    config.llmUse = 'relay';
    config.research.agent = 'deep-research';
    config.chat.agent = 'deep-research';
    config.extraction.entityLlm = { ...config.extraction.entityLlm, use: 'deep-research' };
    saveConfig(dir, config);
    fs.writeFileSync(path.join(dir, AGENTS_DIR, 'deep-research.yaml'), research);
    fs.writeFileSync(path.join(dir, AGENTS_DIR, 'deep-agent.yaml'), seededGeneral);
    const profiles = path.join(dir, 'playbooks', 'research', 'profiles');
    fs.mkdirSync(profiles, { recursive: true });
    fs.writeFileSync(path.join(profiles, 'mine.yaml'), "title: Mine\nroles:\n  - id: critic\n    phase: review\n    agent: deep-research\n  - id: planner\n    phase: plan\n    agent: ''\n");
    return dir;
  }

  it('deletes an untouched copy and moves what named it to deep-agent', () => {
    const dir = workspace('retired', seededResearch);
    const loaded = loadConfig(dir);

    expect(fs.existsSync(path.join(dir, AGENTS_DIR, 'deep-research.yaml'))).toBe(false);
    expect(loaded.research.agent).toBe('deep-agent');
    expect(loaded.chat.agent).toBe('deep-agent');
    // deep-agent pins no model, so a stage on it is its endpoint's row: it lands there
    expect(loaded.extraction.entityLlm.use).toBe('relay');
    expect(loadProfile(dir, 'mine')?.roles.map((r) => r.agent)).toEqual(['deep-agent', '']);

    // the built-in that stays takes its current wording, and no file keeps a
    // kind or what only Ask read
    const file = path.join(dir, AGENTS_DIR, 'deep-agent.yaml');
    expect(loadAgent(dir, 'deep-agent')).toMatchObject({ title: 'deep agent', executor: 'default', tools: { web: 'inherit' } });
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/^(kind|description|maxTurns|timeoutMs|prompt):|^ {2}(write|files):/m);

    // written down once, and not seeded back: the next load finds nothing to do
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'knode.config.json'), 'utf8')).research.agent).toBe('deep-agent');
    const before = fs.readFileSync(file, 'utf8');
    expect(loadConfig(dir).research.agent).toBe('deep-agent');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(ensureDefaultAgents(dir)).toEqual([]);
  });

  it('keeps a copy someone edited, as an ordinary agent that runs as it did', () => {
    // an effort of its own, and the tools it inherited from the template left out
    const edited = seededResearch.replace('effort: default', 'effort: high').replace(/tools:\n(?: {2}.*\n)+/, '');
    const dir = workspace('retired-edited', edited);
    const loaded = loadConfig(dir);

    expect(loaded.research.agent).toBe('deep-research');
    expect(loadProfile(dir, 'mine')?.roles[0].agent).toBe('deep-research');
    expect(BUILTIN_AGENTS['deep-research']).toBeUndefined();
    expect(loadAgent(dir, 'deep-research')).toMatchObject({ title: '深度研究 agent', effort: 'high', tools: { web: 'inherit' } });
    expect(fs.readFileSync(path.join(dir, AGENTS_DIR, 'deep-research.yaml'), 'utf8')).not.toMatch(/^(kind|description|maxTurns|timeoutMs|prompt):|^ {2}(write|files):/m);
  });
});

/**
 * An agent is who runs a job and on what model. The turn cap, timeout, page
 * and file tools and system prompt only Ask read, and the description nothing
 * read, leave the files on load; web access stays.
 */
describe('dropping what only Ask read', () => {
  it('strips those fields from every agent file once, keeping web access', () => {
    const dir = path.join(tmp, 'ask-only');
    fs.mkdirSync(path.join(dir, AGENTS_DIR), { recursive: true });
    saveConfig(dir, defaultConfig());
    const file = path.join(dir, AGENTS_DIR, 'codex.yaml');
    fs.writeFileSync(file, [
      'name: codex',
      'title: codex',
      'description: When to pick this agent',
      'executor: codex-cli',
      'model: gpt-6-sol',
      'effort: high',
      'tools:',
      '  write: false',
      '  files: false',
      '  web: on',
      'maxTurns: 7',
      'timeoutMs: 60000',
      'prompt: 只用一句话回答。',
      '',
    ].join('\n'));

    loadConfig(dir);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toMatch(/^(description|maxTurns|timeoutMs|prompt):|^ {2}(write|files):/m);
    expect(loadAgent(dir, 'codex')).toMatchObject({ executor: 'codex-cli', model: 'gpt-6-sol', effort: 'high', tools: { web: 'on' } });

    // the next load finds nothing to do
    loadConfig(dir);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });
});

describe('the agents API', () => {
  const read = async (path: string) => app.request(path, { headers });

  it('lists the template a new workspace starts with', async () => {
    const body = (await read('/api/agents').then((r) => r.json())) as { agents: Array<{ name: string; builtin: boolean }> };
    expect(body.agents.map((a) => a.name)).toEqual(['deep-agent']);
    expect(body.agents.every((a) => a.builtin)).toBe(true);
  });

  it('creates one, points research at it, and refuses an unknown name', async () => {
    const created = await app.request('/api/agents/mine', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ agent: { title: '我的研究员', executor: 'cursor-cli', effort: 'high' } }),
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
