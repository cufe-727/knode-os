import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import {
  KnodeConfig,
  defaultConfig,
  defaultRoutedLlmConfig,
  migrateRouteConnections,
  resolveRoutedLlmConfig,
} from '../src/config.js';
import { cliCommand, readCursorStream, resolveExecutable } from '../src/llm/cli.js';
import { createApp } from '../src/server/app.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-config-models-'));
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

const models = (body: unknown) =>
  app.request('/api/config/models', { method: 'POST', headers, body: JSON.stringify(body) });

beforeAll(async () => {
  rootCtx = await createContext(root);
  registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
  app = createApp(rootCtx, () => {}, registry);
  await app.request('/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-knode-user': 'tester' },
    body: JSON.stringify({ name: 'Default' }),
  });
});

afterAll(async () => {
  await registry.closeAll();
  await rootCtx.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('executable resolution', () => {
  it('falls back to each provider default command and finds it on PATH', () => {
    expect(cliCommand('cursor-cli')).toBe('cursor-agent');
    expect(cliCommand('claude-cli', '  /opt/bin/claude  ')).toBe('/opt/bin/claude');
    expect(resolveExecutable('sh')).toMatch(/\/sh$/);
    expect(resolveExecutable('knode-nope-not-a-command')).toBeNull();
    expect(resolveExecutable('/nope/claude')).toBeNull();
  });
});

describe('POST /api/config/models', () => {
  it('reports where a CLI provider would run, without needing the CLI to answer', async () => {
    const res = await models({ route: 'llm', config: { llm: { provider: 'claude-cli', cliPath: '/nope/claude' } } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; command: string; resolvedPath?: string; error: string };
    expect(body.ok).toBe(false);
    expect(body.command).toBe('/nope/claude');
    expect(body.resolvedPath).toBeUndefined();
    expect(body.error).toMatch(/not an executable file/);
  });

  it('answers the embedding route without a network call for local and Ark', async () => {
    const local = await models({ route: 'embedding', config: { embedding: { provider: 'local' } } });
    const localBody = (await local.json()) as { ok: boolean; models: unknown[]; note: string };
    expect(localBody.ok).toBe(true);
    expect(localBody.models).toEqual([]);
    expect(localBody.note).toMatch(/local hashing/i);

    const ark = await models({ route: 'embedding', config: { embedding: { provider: 'ark-multimodal' } } });
    const arkBody = (await ark.json()) as { ok: boolean; note: string };
    expect(arkBody.ok).toBe(false);
    expect(arkBody.note).toMatch(/endpoint id/);
  });

  it('rejects an unknown route', async () => {
    const res = await models({ route: 'nope', config: {} });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/config/cli-tools', () => {
  it('resolves every CLI provider against the service PATH', async () => {
    const res = await app.request('/api/config/cli-tools', { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: Array<{ provider: string; command: string; path: string | null }> };
    expect(body.tools.map((t) => t.provider).sort()).toEqual(['claude-cli', 'codex-cli', 'cursor-cli']);
    expect(body.tools.find((t) => t.provider === 'cursor-cli')?.command).toBe('cursor-agent');
    for (const tool of body.tools) expect(tool.path === null || path.isAbsolute(tool.path)).toBe(true);
  });
});

describe('named connections', () => {
  const base = { provider: 'openai' as const, baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-default', model: 'gpt-4.1-mini', cliPath: '', cliTimeoutMs: 300_000 };
  const ark = { ...base, id: 'ark', label: 'Ark', baseUrl: 'https://ark.example/api/v3', apiKey: 'sk-ark', model: 'doubao-vision' };

  it('runs a route on the connection it names, with the route model on top', () => {
    const route = { ...defaultRoutedLlmConfig(), use: 'ark' };
    expect(resolveRoutedLlmConfig(base, route, [ark])).toMatchObject({
      baseUrl: 'https://ark.example/api/v3',
      apiKey: 'sk-ark',
      model: 'doubao-vision',
    });
    expect(resolveRoutedLlmConfig(base, { ...route, model: 'doubao-pro' }, [ark]).model).toBe('doubao-pro');
  });

  it('falls back to the default connection for "default" and for an id that no longer exists', () => {
    for (const use of ['default', 'deleted']) {
      const resolved = resolveRoutedLlmConfig(base, { ...defaultRoutedLlmConfig(), use }, [ark]);
      expect(resolved).toMatchObject({ baseUrl: base.baseUrl, apiKey: base.apiKey, model: base.model });
    }
  });

  it('keeps resolving routes written before connections existed', () => {
    const legacy = { ...defaultRoutedLlmConfig(), provider: 'claude-cli' as const, model: 'opus' };
    expect(resolveRoutedLlmConfig(base, legacy, [])).toMatchObject({ provider: 'claude-cli', model: 'opus' });
  });
});

describe('migrateRouteConnections', () => {
  const legacy = (): KnodeConfig => {
    const config = defaultConfig();
    config.llm = { ...config.llm, apiKey: 'sk-default', model: 'gpt-4.1-mini' };
    config.extraction.entityLlm = { ...defaultRoutedLlmConfig(), provider: 'cursor-cli', model: 'gpt-5.2' };
    config.extraction.conceptLlm = { ...defaultRoutedLlmConfig(), provider: 'cursor-cli' };
    config.extraction.documentLlm = { ...defaultRoutedLlmConfig(), provider: 'openai', model: 'gpt-4.1' };
    return config;
  };

  it('lifts per-route overrides into connections and shares one across routes on the same endpoint', () => {
    const migrated = migrateRouteConnections(legacy());
    expect(migrated.connections).toHaveLength(1);
    expect(migrated.connections[0]).toMatchObject({ id: 'cursor-cli-1', provider: 'cursor-cli', label: 'Cursor Agent CLI' });
    expect(migrated.extraction.entityLlm.use).toBe('cursor-cli-1');
    expect(migrated.extraction.conceptLlm.use).toBe('cursor-cli-1');
    // the document route resolved to the default endpoint, so it points there
    expect(migrated.extraction.documentLlm.use).toBe('default');
  });

  it('preserves what each route actually resolved to', () => {
    const before = legacy();
    const after = migrateRouteConnections(JSON.parse(JSON.stringify(before)) as KnodeConfig);
    for (const key of ['entityLlm', 'conceptLlm', 'documentLlm'] as const) {
      expect(resolveRoutedLlmConfig(after.llm, after.extraction[key], after.connections)).toEqual(
        resolveRoutedLlmConfig(before.llm, before.extraction[key], []),
      );
    }
  });

  it('leaves inherited routes and already-migrated configs alone', () => {
    const config = defaultConfig();
    expect(migrateRouteConnections(config).connections).toEqual([]);
    expect(migrateRouteConnections(config).extraction.entityLlm.use).toBe('');
  });
});

describe('PUT /api/config with connections', () => {
  it('stores the list, redacts its keys, and keeps a secret the client echoes back', async () => {
    const save = async (body: unknown) =>
      app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify(body) });

    const created = await save({
      connections: [{ id: 'ark', label: 'Ark vision', provider: 'openai', baseUrl: 'https://ark.example/api/v3', apiKey: 'sk-ark', model: 'doubao-vision' }],
      extraction: { documentLlm: { use: 'ark' } },
    });
    expect(created.status).toBe(200);
    const body = (await created.json()) as { config: KnodeConfig };
    expect(body.config.connections[0]).toMatchObject({ id: 'ark', label: 'Ark vision', apiKey: '***' });
    expect(body.config.extraction.documentLlm.use).toBe('ark');

    // echoing the redacted key back must not overwrite the stored one
    const kept = await save({ connections: [{ id: 'ark', label: 'Ark vision', provider: 'openai', baseUrl: 'https://ark.example/api/v3', apiKey: '***', model: 'doubao-pro' }] });
    const keptBody = (await kept.json()) as { config: KnodeConfig };
    expect(keptBody.config.connections[0].model).toBe('doubao-pro');

    const models = await app.request('/api/config/models', {
      method: 'POST',
      headers,
      body: JSON.stringify({ route: 'connection:ark', config: {} }),
    });
    expect(models.status).toBe(200);
    expect((await models.json()) as { source: string }).toMatchObject({ source: 'api' });

    const dropped = await save({ connections: [] });
    expect(((await dropped.json()) as { config: KnodeConfig }).config.connections).toEqual([]);
  });
});

describe('readCursorStream', () => {
  const line = (event: unknown) => `${JSON.stringify(event)}\n`;
  const assistant = (text: string) => line({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

  it('drops the narration cursor-agent emits before reaching for a tool', () => {
    const stdout =
      line({ type: 'system', subtype: 'init' }) +
      assistant('I will read the image first, then transcribe it.') +
      line({ type: 'tool_call', subtype: 'started' }) +
      line({ type: 'tool_call', subtype: 'completed' }) +
      assistant('## Quarterly revenue\n\nOwner: Ops') +
      line({ type: 'result', subtype: 'success', is_error: false, result: 'everything glued together' });
    expect(readCursorStream(stdout)).toEqual({ text: '## Quarterly revenue\n\nOwner: Ops', error: undefined });
  });

  it('keeps every message when no tool ran, and joins a split answer', () => {
    expect(readCursorStream(assistant('first half') + assistant('second half')).text).toBe('first half\nsecond half');
  });

  it('reports an error result and falls back to the result text when the stream carries no message', () => {
    expect(readCursorStream(line({ type: 'result', subtype: 'error', is_error: true, result: 'not logged in' })).error).toBe('not logged in');
    expect(readCursorStream(line({ type: 'result', subtype: 'success', result: 'plain answer' })).text).toBe('plain answer');
  });

  it('ignores progress lines that are not JSON', () => {
    expect(readCursorStream(`Connecting…\n${assistant('done')}`).text).toBe('done');
  });
});
