import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { opencodeActivity } from '../src/chat/runner.js';
import { defaultConfig, KnodeConfig, LlmConfig, LlmConnection, llmTargets, readAgentLlms, resolveRoutedLlmConfig } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { sync } from '../src/ingest/sync.js';
import { completeViaCli, effortFor } from '../src/llm/cli.js';
import { opencodeConfig, opencodeProviderNpm, readOpencodeStream } from '../src/llm/opencode.js';
import { CliAgent, resolveAgentSpec, resolveResearchAgent } from '../src/research/agent.js';
import { loadAgent, saveAgent } from '../src/research/agents.js';
import { agentKey } from '../src/research/failure.js';
import { queueJob } from '../src/research/jobs.js';
import { CliSessionInput, sessionArgs } from '../src/research/launch.js';
import { runResearchJob } from '../src/research/runner.js';
import { createApp } from '../src/server/app.js';
import { MCP_TOKEN_FILE } from '../src/server/mcp-http.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';

/**
 * OpenCode as an executor (`opencode-cli`). It has no login, so an agent file
 * names the model connection it runs on, and every OpenCode process gets that
 * connection — and its permissions, MCP servers and sub-agents — as one
 * generated config in its environment, with the key beside it and never in
 * argv or a file. A fake `opencode` (the fake agent in its OpenCode dialect)
 * runs research and Ask end to end over knode's MCP endpoint.
 */

const helpers = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers');
const fakeOpencode = path.join(helpers, 'fake-opencode.sh');
const KEY = 'sk-ant-test-opencode-0123456789';
const KEY_VAR = 'KNODE_TEST_OPENCODE_KEY';
process.env[KEY_VAR] = KEY;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-opencode-'));

function connection(patch: Partial<LlmConnection> & Pick<LlmConnection, 'id'>): LlmConnection {
  return { label: patch.id, provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: `env:${KEY_VAR}`, protocol: 'chat', model: 'claude-test', cliPath: '', cliTimeoutMs: 300_000, ...patch };
}

function configWith(connections: LlmConnection[], llmUse = connections[0]?.id ?? ''): KnodeConfig {
  return { ...defaultConfig(), connections, llmUse };
}

const endpoint = { baseUrl: 'https://api.anthropic.com/v1', apiKey: `env:${KEY_VAR}`, protocol: 'chat' as const };
const agent: CliAgent = { kind: 'cli', provider: 'opencode-cli', cliPath: '', model: 'claude-sonnet-5-5', endpoint };
const mcp = { url: 'http://127.0.0.1:12000/mcp', token: 'mcp-token', headers: { 'x-knode-user': 'admin', 'x-knode-workspace-id': 'finance' } };

function session(patch: Partial<CliSessionInput> = {}): CliSessionInput {
  return {
    agent, maxTurns: 40, timeoutMs: 0, cwd: tmp, prompt: 'the brief', mcp, readDirs: ['/data/raw/docs', '/data/wiki'],
    jobId: 'r_1', outputPath: 'wiki/x.md', worksetId: 'w_1', tools: 'write', label: 'agent', ...patch,
  };
}

const configOf = (env: Record<string, string> | undefined) => JSON.parse(env?.OPENCODE_CONFIG_CONTENT ?? '{}') as {
  model: string; enabled_providers: string[]; autoupdate: boolean; snapshot: boolean; share: string;
  provider: { knode: { npm: string; options: { baseURL: string; apiKey: string }; models: Record<string, { options?: { reasoningEffort?: string } }> } };
  permission: Record<string, unknown>;
  mcp: Record<string, { type: string; url?: string; headers?: Record<string, string>; timeout?: number; command?: string[]; environment?: Record<string, string> }>;
  agent?: Record<string, { mode?: string; prompt?: string; model?: string; steps?: number; permission?: Record<string, unknown>; reasoningEffort?: string }>;
};

describe('opencode: the generated config', () => {
  it('speaks Responses to OpenAI and Chat Completions elsewhere, unless the connection pins a wire', () => {
    expect(opencodeProviderNpm({ baseUrl: 'https://api.openai.com/v1', protocol: 'auto' })).toBe('@ai-sdk/openai');
    expect(opencodeProviderNpm({ baseUrl: 'https://api.anthropic.com/v1', protocol: 'auto' })).toBe('@ai-sdk/openai-compatible');
    expect(opencodeProviderNpm({ baseUrl: 'https://api.anthropic.com/v1', protocol: 'chat' })).toBe('@ai-sdk/openai-compatible');
    expect(opencodeProviderNpm({ baseUrl: 'https://relay.example/v1', protocol: 'responses' })).toBe('@ai-sdk/openai');
    expect(opencodeProviderNpm({ baseUrl: 'https://api.openai.com/v1', protocol: 'chat' })).toBe('@ai-sdk/openai-compatible');
  });

  it('names the key by variable and caps effort at high', () => {
    const config = opencodeConfig({ endpoint, model: 'claude-sonnet-5-5', effort: 'max', permission: { '*': 'deny' } }) as ReturnType<typeof configOf>;
    expect(config.provider.knode.options).toEqual({ baseURL: 'https://api.anthropic.com/v1', apiKey: '{env:KNODE_OPENCODE_API_KEY}' });
    expect(config.provider.knode.models['claude-sonnet-5-5'].options).toEqual({ reasoningEffort: 'high' });
    expect(config).toMatchObject({ model: 'knode/claude-sonnet-5-5', enabled_providers: ['knode'], autoupdate: false, snapshot: false, share: 'disabled' });
    expect(JSON.stringify(config)).not.toContain(KEY);
    expect(effortFor('opencode-cli', 'low')).toBe('low');
    expect(effortFor('opencode-cli', 'xhigh')).toBe('high');
    expect(effortFor('opencode-cli', 'default')).toBeNull();
  });
});

describe('opencode: reading `run --format json`', () => {
  it('keeps what came after the last tool call, adds cache and reasoning back into usage, and counts steps', () => {
    const lines = [
      'Performing one time database migration…',
      { type: 'step_start', part: { type: 'step-start' } },
      { type: 'text', part: { type: 'text', text: "I'll search the base first." } },
      { type: 'tool_use', part: { type: 'tool', tool: 'knode-os_knode_search', state: { status: 'completed', input: { query: '宁德时代' } } } },
      { type: 'step_finish', part: { type: 'step-finish', cost: 0, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 900, write: 50 } } } },
      { type: 'text', part: { type: 'text', text: '营业收入 4000 亿元。' } },
      { type: 'step_finish', part: { type: 'step-finish', cost: 0.01, tokens: { input: 10, output: 30, reasoning: 0, cache: { read: 1000, write: 0 } } } },
    ].map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
    const parsed = readOpencodeStream(lines);
    expect(parsed.text).toBe('营业收入 4000 亿元。');
    expect(parsed.steps).toBe(2);
    expect(parsed.error).toBeUndefined();
    expect(parsed.usage).toEqual({ inputTokens: 100 + 900 + 50 + 10 + 1000, cachedInputTokens: 1900, cacheWriteTokens: 50, outputTokens: 20 + 5 + 30, reasoningTokens: 5, costUsd: 0.01 });
    expect(opencodeActivity(lines)).toEqual([{ tool: 'knode_search', summary: '宁德时代', ok: true }]);
    // OpenCode's read tool, as the real CLI reports it
    const read = JSON.stringify({ type: 'tool_use', part: { type: 'tool', tool: 'read', state: { status: 'error', input: { filePath: '/data/raw/docs/a.md' } } } });
    expect(opencodeActivity(read)).toEqual([{ tool: 'read', summary: '/data/raw/docs/a.md', path: '/data/raw/docs/a.md', ok: false }]);
  });

  it('surfaces an error event with its message', () => {
    const parsed = readOpencodeStream(JSON.stringify({ type: 'error', error: { name: 'APIError', data: { message: 'insufficient_quota: You exceeded your current quota' } } }));
    expect(parsed.error).toBe('insufficient_quota: You exceeded your current quota');
    expect(parsed.usage).toBeUndefined();
  });
});

describe('opencode: a session', () => {
  it('runs `opencode run` with the brief on stdin, and puts the whole setup in its environment', () => {
    const { cmd, args, stdin, env } = sessionArgs(session());
    expect(cmd).toBe('opencode');
    expect(args).toEqual(['run', '--format', 'json', '--model', 'knode/claude-sonnet-5-5', '--title', 'knode agent']);
    expect(stdin).toBe('the brief');
    expect(env?.KNODE_OPENCODE_API_KEY).toBe(KEY);
    expect(env).toMatchObject({ OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1' });
    // the run workspace's AGENTS.md is the schema: project instructions stay on for a session
    expect(env?.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined();
    expect(args.join(' ')).not.toContain(KEY);
    expect(env?.OPENCODE_CONFIG_CONTENT).not.toContain(KEY);

    const config = configOf(env);
    expect(config.provider.knode.npm).toBe('@ai-sdk/openai-compatible');
    expect(config.mcp['knode-os']).toEqual({
      type: 'remote', url: mcp.url, oauth: false, timeout: 300_000,
      headers: { Authorization: 'Bearer {env:KNODE_MCP_TOKEN}', 'x-knode-user': 'admin', 'x-knode-workspace-id': 'finance' },
    });
    // no shell, no edits; knode's tools, the read tools on the read roots
    const permission = config.permission;
    expect(Object.keys(permission)[0]).toBe('*');
    expect(permission['*']).toBe('deny');
    expect(permission).not.toHaveProperty('bash');
    expect(permission).not.toHaveProperty('edit');
    expect(permission).toMatchObject({ read: 'allow', grep: 'allow', glob: 'allow', 'knode-os_*': 'allow' });
    expect(permission.external_directory).toEqual({ '*': 'deny', '/data/raw/docs': 'allow', '/data/raw/docs/*': 'allow', '/data/wiki': 'allow', '/data/wiki/*': 'allow' });
    expect(permission).not.toHaveProperty('webfetch');
    expect(config.agent?.build).toEqual({ steps: 40 });
  });

  it('gives a read-only session the read tool set, and the web only when allowed', () => {
    const { env } = sessionArgs(session({ tools: 'read', files: false, allowNetwork: true }));
    const permission = configOf(env).permission;
    expect(permission['knode-os_*']).toBe('deny');
    expect(permission['knode-os_knode_search']).toBe('allow');
    expect(permission['knode-os_knode_capture']).toBe('allow');
    expect(permission).not.toHaveProperty('knode-os_knode_write');
    expect(permission).not.toHaveProperty('read');
    expect(permission).toMatchObject({ webfetch: 'allow', websearch: 'allow' });
  });

  it('registers native roles as sub-agents and attaches the sources\' servers by variable', () => {
    const { env } = sessionArgs(session({
      agents: [{ id: 'scout', title: 'Scout', description: 'finds sources', prompt: 'Look for {env:HOME} and {file:x}', write: false, files: true, web: false, model: 'claude-haiku-test', effort: 'low', speed: 'default' }],
      extraMcp: [
        { id: 'tushare', url: 'https://mcp.example/tushare', headers: { Authorization: 'Bearer secret-header' }, tools: ['daily'] },
        { id: 'local', command: 'node', args: ['srv.js'], env: { SRC_TOKEN: 'secret-env' }, tools: [] },
      ],
    }));
    const config = configOf(env);
    expect(config.agent?.scout).toMatchObject({ mode: 'subagent', model: 'knode/claude-haiku-test', reasoningEffort: 'low' });
    // OpenCode would substitute these, so they are kept as written
    expect(config.agent?.scout.prompt).toBe('Look for { env:HOME} and { file:x}');
    expect(config.agent?.scout.permission).toMatchObject({ '*': 'deny', read: 'allow', 'knode-os_*': 'deny', 'knode-os_knode_search': 'allow' });
    expect(Object.keys(config.provider.knode.models).sort()).toEqual(['claude-haiku-test', 'claude-sonnet-5-5']);
    expect(config.permission.task).toEqual({ '*': 'deny', scout: 'allow' });
    expect(config.permission).toMatchObject({ tushare_daily: 'allow', 'local_*': 'allow' });
    expect(config.mcp.tushare.headers?.Authorization).toMatch(/^\{env:KNODE_SRC_TUSHARE_0_AUTHORIZATION\}$/);
    expect(config.mcp.local).toMatchObject({ type: 'local', command: ['node', 'srv.js'], environment: { SRC_TOKEN: '{env:SRC_TOKEN}' } });
    expect(env?.OPENCODE_CONFIG_CONTENT).not.toContain('secret-header');
    expect(env?.OPENCODE_CONFIG_CONTENT).not.toContain('secret-env');
  });

  it('refuses to start without a connection', () => {
    expect(() => sessionArgs(session({ agent: { ...agent, endpoint: undefined } }))).toThrow(/model connection/);
  });
});

describe('opencode: agents and connections', () => {
  const dataDir = path.join(tmp, 'agents-data');
  const anthropic = connection({ id: 'anthropic-api', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5' });
  const openai = connection({ id: 'openai-api', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-sol', protocol: 'auto' });

  it('stores the connection only on an OpenCode agent', () => {
    saveAgent(dataDir, { name: 'oc-claude', executor: 'opencode-cli', connection: 'anthropic-api', title: 'OpenCode · Claude' });
    saveAgent(dataDir, { name: 'plain', executor: 'claude-cli' });
    expect(loadAgent(dataDir, 'oc-claude')).toMatchObject({ executor: 'opencode-cli', connection: 'anthropic-api' });
    const text = fs.readFileSync(path.join(dataDir, 'playbooks', 'agents', 'oc-claude.yaml'), 'utf8');
    expect(text).toMatch(/cliPath: ''\nconnection: anthropic-api\n/);
    expect(fs.readFileSync(path.join(dataDir, 'playbooks', 'agents', 'plain.yaml'), 'utf8')).not.toContain('connection');
  });

  it('runs an agent on the connection it names, with that connection\'s model unless it pins one', () => {
    const config = configWith([openai, anthropic]);
    expect(resolveAgentSpec(config, 'oc-claude', '', dataDir)?.agent).toEqual({
      kind: 'cli', provider: 'opencode-cli', cliPath: '', model: 'claude-sonnet-5-5',
      endpoint: { baseUrl: 'https://api.anthropic.com/v1', apiKey: `env:${KEY_VAR}`, protocol: 'chat' },
    });
    expect(resolveAgentSpec(config, 'oc-claude', 'claude-opus-test', dataDir)?.agent.model).toBe('claude-opus-test');
    // a quota is the key's: shared with the built-in agent on that endpoint
    expect(agentKey(resolveAgentSpec(config, 'oc-claude', '', dataDir)!.agent)).toBe('builtin:https://api.anthropic.com/v1');
  });

  it('follows the default LLM when it names none, and does not run without a model endpoint', () => {
    saveAgent(dataDir, { name: 'oc-default', executor: 'opencode-cli' });
    expect(resolveAgentSpec(configWith([openai, anthropic], 'openai-api'), 'oc-default', '', dataDir)?.agent).toMatchObject({ model: 'gpt-6.1-sol', endpoint: { baseUrl: 'https://api.openai.com/v1' } });
    saveAgent(dataDir, { name: 'oc-gone', executor: 'opencode-cli', connection: 'deleted' });
    expect(resolveAgentSpec(configWith([openai]), 'oc-gone', '', dataDir)).toBeNull();
    // the default is this very agent: there is nothing under it to run on
    expect(resolveAgentSpec(configWith([], 'oc-default'), 'oc-default', '', dataDir)).toBeNull();
  });

  it('hands a pipeline stage the agent with its connection bound in', () => {
    const config = { ...configWith([openai, anthropic]), agentLlms: readAgentLlms(dataDir) };
    const row = llmTargets(config).find((t) => t.id === 'oc-claude');
    expect(row).toMatchObject({ provider: 'opencode-cli', baseUrl: 'https://api.anthropic.com/v1', apiKey: `env:${KEY_VAR}`, protocol: 'chat', model: 'claude-sonnet-5-5' });
    const route = resolveRoutedLlmConfig(config.llm, { ...config.extraction.entityLlm, use: 'oc-claude', model: '' }, llmTargets(config));
    expect(route).toMatchObject({ provider: 'opencode-cli', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5' });
    expect(llmTargets({ ...config, connections: [openai] }).find((t) => t.id === 'oc-claude')?.baseUrl).toBe('');
  });
});

describe('opencode: a one-shot call', () => {
  const stub = path.join(tmp, 'opencode-stub.sh');
  const seen = path.join(tmp, 'opencode-seen');
  fs.writeFileSync(stub, `#!/bin/sh
mkdir -p "${seen}"
cat > "${seen}/stdin"
printf '%s\\n' "$@" > "${seen}/argv"
printf '%s' "$OPENCODE_CONFIG_CONTENT" > "${seen}/config"
printf '%s' "$KNODE_OPENCODE_API_KEY" | shasum -a 256 | cut -d' ' -f1 > "${seen}/key"
printf '%s' "$OPENCODE_DISABLE_PROJECT_CONFIG" > "${seen}/project"
if [ -n "$STUB_FAIL" ]; then
  echo '{"type":"error","error":{"name":"APIError","data":{"message":"invalid x-api-key"}}}'
  exit 1
fi
echo '{"type":"step_start","part":{"type":"step-start"}}'
echo '{"type":"text","part":{"type":"text","text":"{\\"ok\\": true}"}}'
echo '{"type":"step_finish","part":{"type":"step-finish","cost":0,"tokens":{"input":12,"output":3,"reasoning":1,"cache":{"read":4000,"write":0}}}}'
`, { mode: 0o755 });
  const cfg = (patch: Partial<LlmConfig> = {}): LlmConfig => ({ provider: 'opencode-cli', baseUrl: 'https://api.anthropic.com/v1', apiKey: `env:${KEY_VAR}`, protocol: 'chat', model: 'claude-sonnet-5-5', cliPath: stub, cliTimeoutMs: 30_000, ...patch });

  it('sends the prompt on stdin with every tool denied, and reports what it used', async () => {
    const usages: unknown[] = [];
    const out = await completeViaCli(cfg({ effort: 'medium' }), [{ role: 'system', content: 'Extract.' }, { role: 'user', content: '宁德时代' }], { json: true, onUsage: (u) => usages.push(u) });
    expect(out).toBe('{"ok": true}');
    expect(fs.readFileSync(path.join(seen, 'stdin'), 'utf8')).toContain('宁德时代');
    expect(fs.readFileSync(path.join(seen, 'argv'), 'utf8').trim().split('\n')).toEqual(['run', '--format', 'json', '--model', 'knode/claude-sonnet-5-5', '--title', 'knode']);
    const config = JSON.parse(fs.readFileSync(path.join(seen, 'config'), 'utf8')) as ReturnType<typeof configOf>;
    expect(config.permission).toEqual({ '*': 'deny' });
    expect(config).not.toHaveProperty('mcp');
    expect(config.provider.knode.models['claude-sonnet-5-5'].options).toEqual({ reasoningEffort: 'medium' });
    expect(fs.readFileSync(path.join(seen, 'key'), 'utf8').trim()).toBe(crypto.createHash('sha256').update(KEY).digest('hex'));
    expect(fs.readFileSync(path.join(seen, 'project'), 'utf8')).toBe('1');
    expect(usages).toEqual([{ inputTokens: 4012, cachedInputTokens: 4000, cacheWriteTokens: 0, outputTokens: 4, reasoningTokens: 1 }]);
  });

  it('lets the read tool reach the images only', async () => {
    const image = path.join(tmp, 'pics', 'chart.png');
    fs.mkdirSync(path.dirname(image), { recursive: true });
    fs.writeFileSync(image, 'png');
    await completeViaCli(cfg(), [{ role: 'user', content: 'what does it show?' }], { images: [image] });
    const config = JSON.parse(fs.readFileSync(path.join(seen, 'config'), 'utf8')) as ReturnType<typeof configOf>;
    expect(config.permission).toEqual({ '*': 'deny', read: 'allow', external_directory: { '*': 'deny', [path.dirname(image)]: 'allow', [path.join(path.dirname(image), '*')]: 'allow' } });
    expect(fs.readFileSync(path.join(seen, 'stdin'), 'utf8')).toContain(image);
  });

  it('fails with what OpenCode said, and says so without a connection', async () => {
    process.env.STUB_FAIL = '1';
    try {
      await expect(completeViaCli(cfg(), [{ role: 'user', content: 'x' }])).rejects.toThrow(/invalid x-api-key/);
    } finally {
      delete process.env.STUB_FAIL;
    }
    await expect(completeViaCli(cfg({ baseUrl: '' }), [{ role: 'user', content: 'x' }])).rejects.toThrow(/names no model connection/);
  });
});

/* ------------------------------------------------------------------ end to end */

const root = path.join(tmp, 'data');
const wsDir = path.join(root, 'users', 'admin', 'workspaces', 'default');
const scope = { user: 'admin', kind: 'personal' as const, id: 'default', name: 'Default', slug: 'default', relativeDir: 'users/admin/workspaces/default' };
const headers = { 'x-knode-user': 'admin', 'x-knode-workspace-kind': 'personal', 'x-knode-workspace-id': 'default', 'x-knode-workspace-name': 'Default' };

let rootCtx: AppContext;
let registry: WorkspaceContextRegistry;
let ctx: AppContext;
let app: ReturnType<typeof createApp>;
let httpServer: Server;
let liveMcp: { url: string; token: string; headers: Record<string, string> };
const tracked: Promise<unknown>[] = [];
const api = (p: string, init: RequestInit = {}) => app.request(p, { ...init, headers: { 'content-type': 'application/json', ...headers, ...(init.headers as Record<string, string> | undefined) } });

beforeAll(async () => {
  rootCtx = await createContext(root);
  registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
  app = createApp(rootCtx, () => {}, registry, {
    services: () => ({ mcp: () => liveMcp ?? null, kickResearch: () => {}, track: <T>(p: Promise<T>) => { tracked.push(p); return p; } }),
  });
  await app.request('/api/workspaces', { headers: { 'x-knode-user': 'admin' } });
  ctx = await registry.get(scope);
  ctx.config.research.pipeline = 'single';
  // a model connection the fake never calls: OpenCode's model is the fake's business
  ctx.config.connections = [connection({ id: 'anthropic-api', label: 'Anthropic API' })];
  saveAgent(wsDir, { name: 'oc', title: 'OpenCode · Claude', executor: 'opencode-cli', connection: 'anthropic-api', cliPath: fakeOpencode });
  const token = fs.readFileSync(path.join(root, MCP_TOKEN_FILE), 'utf8').trim();
  await new Promise<void>((resolve) => {
    httpServer = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      liveMcp = { url: `http://127.0.0.1:${info.port}/mcp`, token, headers };
      resolve();
    }) as Server;
  });
  const abs = path.join(wsDir, 'raw', 'docs', 'trusted.md');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `---
title: 宁德时代 2025 年报摘要
date: 2026-03-30
entities:
  - { name: 宁德时代, type: organization, aliases: ["CATL", "300750"] }
claims:
  - { subject: 宁德时代, type: revenue, statement: 2025 年营业收入 4000 亿元, eventDate: "2025" }
---
宁德时代 2025 年营业收入 4000 亿元，同比增长 20%。
`);
  await sync(ctx, { llmGraph: false });
}, 60_000);

afterAll(async () => {
  await Promise.allSettled(tracked);
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await registry.closeAll();
  await rootCtx.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Every file a run left, read as text: the key must be in none of them. */
function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

describe('opencode: research and Ask end to end', () => {
  it('runs a research job: the page arrives through knode_write, steps count as turns, no key on disk', async () => {
    process.env.FAKE_AGENT_MODE = 'good';
    const agent = resolveResearchAgent({ ...ctx.config, research: { ...ctx.config.research, agent: 'oc' } }, wsDir);
    expect(agent).toMatchObject({ kind: 'cli', provider: 'opencode-cli', cliPath: fakeOpencode, model: 'claude-test' });
    const { job } = await queueJob(ctx.store, { kind: 'entity', target: '宁德时代', requestedBy: 'test' });
    const done = await runResearchJob(ctx, job, { mcp: liveMcp, agent: agent!, log: () => {} });
    expect(done.error ?? null).toBeNull();
    expect(done.status).toBe('done');
    expect(done.turns).toBeGreaterThanOrEqual(3);
    const page = fs.readFileSync(path.join(wsDir, 'wiki', 'entities', '宁德时代.md'), 'utf8');
    expect(page).toContain('actor: agent/opencode-cli');
    expect(page).toContain('## 时间线');

    const runDir = path.join(wsDir, '.runs', job.id);
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'argv-agent.json'), 'utf8'))).toEqual(['run', '--format', 'json', '--model', 'knode/claude-test', '--title', 'knode agent']);
    const config = JSON.parse(fs.readFileSync(path.join(runDir, 'opencode-config-agent.json'), 'utf8')) as ReturnType<typeof configOf>;
    expect(config.mcp['knode-os'].url).toBe(liveMcp.url);
    expect(config.permission['knode-os_*']).toBe('allow');
    const env = JSON.parse(fs.readFileSync(path.join(runDir, 'opencode-env-agent.json'), 'utf8')) as Record<string, string>;
    expect(env.keySha256).toBe(crypto.createHash('sha256').update(KEY).digest('hex'));
    expect(env.OPENCODE_DISABLE_CLAUDE_CODE).toBe('1');
    for (const file of filesUnder(runDir)) expect(fs.readFileSync(file, 'utf8')).not.toContain(KEY);
  }, 120_000);

  it('answers in Ask with the tool activity parsed from its events', async () => {
    process.env.FAKE_AGENT_MODE = 'good';
    const saved = ctx.config.chat.agent;
    ctx.config.chat.agent = 'oc';
    try {
      const { id } = await (await api('/api/chat/conversations', { method: 'POST', body: JSON.stringify({}) })).json() as { id: string };
      const sent = await api(`/api/chat/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ text: '宁德时代 2025 年营收是多少？' }) });
      expect(sent.status).toBe(202);
      const t0 = Date.now();
      while (Date.now() - t0 < 30_000) {
        const status = await (await api(`/api/chat/conversations/${id}/status`)).json() as { status: string };
        if (status.status === 'idle') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const conv = await (await api(`/api/chat/conversations/${id}`)).json() as { messages: { role: string; content: string; events: { tool: string; ok?: boolean }[]; turns: number | null }[] };
      const reply = conv.messages[1];
      expect(reply.role).toBe('assistant');
      expect(reply.content).toContain('关于「宁德时代 2025 年营收是多少？」');
      expect(reply.content).toContain('raw/docs/trusted.md');
      expect(reply.events[0]).toMatchObject({ tool: 'knode_search', ok: true });
      expect(reply.turns).toBeGreaterThanOrEqual(1);
      // Ask writes notes whichever agent answers: the whole knode tool set
      const config = JSON.parse(fs.readFileSync(path.join(wsDir, '.runs', 'chat', id, 'opencode-config-chat.json'), 'utf8')) as ReturnType<typeof configOf>;
      expect(config.permission['knode-os_*']).toBe('allow');
    } finally {
      ctx.config.chat.agent = saved;
    }
  }, 60_000);

  it('keeps an agent\'s connection when a client saves it without one', async () => {
    const put = await api('/api/agents/oc', { method: 'PUT', body: JSON.stringify({ agent: { title: 'Renamed', executor: 'opencode-cli', cliPath: fakeOpencode } }) });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ title: 'Renamed', connection: 'anthropic-api', runnable: true });
    const cleared = await api('/api/agents/oc', { method: 'PUT', body: JSON.stringify({ agent: { title: 'Renamed', executor: 'opencode-cli', cliPath: fakeOpencode, connection: 'default' } }) });
    expect(await cleared.json()).toMatchObject({ connection: 'default' });
  });
});
