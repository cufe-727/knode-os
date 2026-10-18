import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import {
  EmbeddingConfig,
  KnodeConfig,
  activeEmbedding,
  defaultConfig,
  defaultRoutedLlmConfig,
  embeddingIdentity,
  loadConfig,
  migrateDefaultLlm,
  migrateEmbeddingProviders,
  migrateRouteConnections,
  resolveRoutedLlmConfig,
} from '../src/config.js';
import { cliCommand, readCursorStream, resolveExecutable } from '../src/llm/cli.js';
import { parseClaudeAliases, parseCodexCatalog, parseCodexDefaults } from '../src/llm/models.js';
import { clearModelCache, listModelsCached } from '../src/llm/model-cache.js';
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

describe('the model list cache', () => {
  // Every case here uses a cliPath that cannot resolve, so the answer comes
  // from the PATH probe in listChatModels — no network, no subprocess.
  const missing = (path: string) => ({
    route: 'llm',
    config: { llm: { provider: 'claude-cli', cliPath: path } },
  });

  it('serves the second ask from cache, and refresh goes back to the provider', async () => {
    clearModelCache();
    const first = (await models(missing('/nope/claude')).then((r) => r.json())) as { cached: boolean; cachedAt: string };
    expect(first.cached).toBe(false);

    const second = (await models(missing('/nope/claude')).then((r) => r.json())) as { cached: boolean; cachedAt: string };
    expect(second.cached).toBe(true);
    expect(second.cachedAt).toBe(first.cachedAt);

    // refresh bypasses the entry and replaces it, so the ask after it is a hit
    // on the *new* answer. The timestamps can match: a PATH probe is instant.
    const forced = (await models({ ...missing('/nope/claude'), refresh: true }).then((r) => r.json())) as { cached: boolean; cachedAt: string };
    expect(forced.cached).toBe(false);
    const after = (await models(missing('/nope/claude')).then((r) => r.json())) as { cached: boolean; cachedAt: string };
    expect(after).toMatchObject({ cached: true, cachedAt: forced.cachedAt });
  });

  it('keys on the endpoint, so a different one is a different entry', async () => {
    clearModelCache();
    await models(missing('/nope/claude'));
    const other = (await models(missing('/elsewhere/claude')).then((r) => r.json())) as { cached: boolean };
    expect(other.cached).toBe(false);
    expect(((await models(missing('/elsewhere/claude')).then((r) => r.json())) as { cached: boolean }).cached).toBe(true);
  });

  it('collapses simultaneous asks for one endpoint into a single answer', async () => {
    clearModelCache();
    const both = await Promise.all([models(missing('/nope/claude')), models(missing('/nope/claude'))]);
    const stamps = await Promise.all(both.map(async (r) => ((await r.json()) as { cachedAt: string }).cachedAt));
    expect(stamps[0]).toBe(stamps[1]);
  });

  it('stamps that answer once, however late each ask resumes', async () => {
    clearModelCache();
    // A clock that moves on with every read: what a loaded machine does to two
    // asks resuming one after the other, made certain rather than occasional.
    // Called directly, not through the route, so the second ask is sure to
    // join the first one's fetch instead of finding its entry.
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now++);
    try {
      const cfg = { ...defaultConfig().llm, provider: 'claude-cli' as const, cliPath: '/nope/claude' };
      const [first, second] = await Promise.all([listModelsCached('chat', cfg), listModelsCached('chat', cfg)]);
      expect(second.cachedAt).toBe(first.cachedAt);
      expect([first.cached, second.cached]).toEqual([false, false]);
    } finally { clock.mockRestore(); }
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
    config.extraction.summaryLlm = { ...defaultRoutedLlmConfig(), provider: 'cursor-cli' };
    config.extraction.documentLlm = { ...defaultRoutedLlmConfig(), provider: 'openai', model: 'gpt-4.1' };
    return config;
  };

  it('lifts per-route overrides into connections and shares one across routes on the same endpoint', () => {
    const migrated = migrateRouteConnections(legacy());
    expect(migrated.connections).toHaveLength(1);
    expect(migrated.connections[0]).toMatchObject({ id: 'cursor-cli-1', provider: 'cursor-cli', label: 'Cursor Agent CLI' });
    expect(migrated.extraction.entityLlm.use).toBe('cursor-cli-1');
    expect(migrated.extraction.summaryLlm.use).toBe('cursor-cli-1');
    // the document route resolved to the default endpoint, so it points there
    expect(migrated.extraction.documentLlm.use).toBe('default');
  });

  it('preserves what each route actually resolved to', () => {
    const before = legacy();
    const after = migrateRouteConnections(JSON.parse(JSON.stringify(before)) as KnodeConfig);
    for (const key of ['entityLlm', 'summaryLlm', 'documentLlm'] as const) {
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

describe('migrateEmbeddingProviders', () => {
  /** What every config file written before the provider library looks like. */
  const legacy = (): KnodeConfig => {
    const config = defaultConfig();
    config.embedding = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-emb', model: 'text-embedding-3-small', dimensions: 1536, batchSize: 32, sendDimensions: false };
    return config;
  };

  it('lifts the single block into one named provider without changing what runs', () => {
    const before = legacy();
    const migrated = migrateEmbeddingProviders(legacy());
    expect(migrated.embeddingProviders).toHaveLength(1);
    expect(migrated.embeddingProviders[0]).toMatchObject({ id: 'openai-1', label: 'OpenAI-compatible API', model: 'text-embedding-3-small' });
    expect(migrated.embeddingUse).toBe('openai-1');
    // the mirror must be byte-identical, or the upgrade would re-embed
    expect(migrated.embedding).toEqual(before.embedding);
  });

  it('lets the library win over a stale mirror, and repairs a dangling pointer', () => {
    const config = migrateEmbeddingProviders(legacy());
    config.embeddingProviders.push({ ...config.embeddingProviders[0], id: 'ark-1', label: 'Ark', provider: 'ark-multimodal', model: 'ep-1', dimensions: 2048 });
    config.embeddingUse = 'ark-1';
    config.embedding = { ...config.embedding, model: 'whatever-was-left-on-disk' };
    expect(migrateEmbeddingProviders(config).embedding).toMatchObject({ model: 'ep-1', dimensions: 2048 });

    config.embeddingUse = 'deleted';
    const repaired = migrateEmbeddingProviders(config);
    expect(repaired.embeddingUse).toBe('openai-1');
    expect(repaired.embedding.model).toBe('text-embedding-3-small');
  });

  it('synthesizes an entry rather than throwing when the library is empty', () => {
    const config = defaultConfig();
    expect(activeEmbedding(config)).toMatchObject({ id: 'local-1', provider: 'local' });
  });
});

describe('embeddingIdentity', () => {
  const base: EmbeddingConfig = { provider: 'openai', baseUrl: 'https://a.example/v1', apiKey: 'sk-1', model: 'text-embedding-3-small', dimensions: 1536, batchSize: 32, sendDimensions: false };

  it('changes when the vectors would stop being comparable', () => {
    expect(embeddingIdentity({ ...base, baseUrl: 'https://b.example/v1' })).not.toBe(embeddingIdentity(base));
    expect(embeddingIdentity({ ...base, model: 'text-embedding-3-large' })).not.toBe(embeddingIdentity(base));
    expect(embeddingIdentity({ ...base, dimensions: 1024 })).not.toBe(embeddingIdentity(base));
    expect(embeddingIdentity({ ...base, sendDimensions: true })).not.toBe(embeddingIdentity(base));
  });

  it('ignores what does not touch the vector space', () => {
    expect(embeddingIdentity({ ...base, apiKey: 'sk-2' })).toBe(embeddingIdentity(base));
    expect(embeddingIdentity({ ...base, batchSize: 8 })).toBe(embeddingIdentity(base));
    expect(embeddingIdentity({ ...base, baseUrl: 'https://a.example/v1/' })).toBe(embeddingIdentity(base));
    // the local embedder reads nothing but the dimension
    const local: EmbeddingConfig = { ...base, provider: 'local' };
    expect(embeddingIdentity({ ...local, baseUrl: '', model: '', apiKey: '' })).toBe(embeddingIdentity(local));
  });
});

describe('PUT /api/config with embedding providers', () => {
  const save = async (body: unknown) =>
    app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify(body) });
  const read = async () => (await app.request('/api/config', { headers }).then((r) => r.json())) as KnodeConfig;
  const saved = async (r: Response) => (await r.json()) as { config: KnodeConfig; reembedded: boolean };

  // Every provider these tests activate is the offline hashing embedder: a
  // switch re-embeds for real, and an API endpoint would make that a network
  // call. The API provider they do configure is deliberately never activated.

  it('starts every workspace with one named provider', async () => {
    const current = await read();
    expect(current.embeddingProviders).toHaveLength(1);
    expect(current.embeddingProviders[0]).toMatchObject({ id: 'local-1', provider: 'local', label: 'Local hashing · offline' });
    expect(current.embeddingUse).toBe('local-1');
    // the macOS client decodes `embedding` non-optionally, so the flat mirror
    // has to keep coming back whole
    expect(Object.keys(current.embedding).sort()).toEqual(
      ['apiKey', 'baseUrl', 'batchSize', 'dimensions', 'model', 'provider', 'sendDimensions'],
    );
  });

  it('treats a legacy flat patch as an edit to the active provider', async () => {
    const before = await read();
    const result = await saved(await save({ embedding: { provider: 'local', dimensions: 16 } }));
    expect(result.config.embeddingProviders).toHaveLength(1);
    expect(result.config.embeddingProviders[0]).toMatchObject({ id: 'local-1', dimensions: 16 });
    expect(result.config.embedding.dimensions).toBe(16);
    expect(result.reembedded).toBe(true);

    await save({ embedding: { provider: 'local', dimensions: before.embedding.dimensions } });
  });

  it('keeps a provider it was not told about, and its stored key', async () => {
    const before = await read();
    const added = await saved(await save({
      embeddingProviders: [
        ...before.embeddingProviders.map((e) => ({ ...e })),
        { id: 'openai-alt', label: 'OpenAI small', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-emb', model: 'text-embedding-3-small', dimensions: 1536 },
        { id: 'local-alt', label: '本地哈希', provider: 'local', dimensions: 8 },
      ],
    }));
    // none of them is active, so nothing re-embeds
    expect(added.reembedded).toBe(false);
    expect(added.config.embeddingProviders).toHaveLength(3);
    expect(added.config.embeddingProviders[1]).toMatchObject({ id: 'openai-alt', apiKey: '***' });

    // omitting `provider` used to silently reset it to 'local' and re-embed
    const patched = await saved(await save({
      embeddingProviders: added.config.embeddingProviders.map((e) =>
        (e.id === 'openai-alt' ? { id: e.id, label: e.label, model: 'text-embedding-3-large', apiKey: '***' } : { ...e })),
    }));
    expect(patched.config.embeddingProviders[1]).toMatchObject({ provider: 'openai', model: 'text-embedding-3-large', baseUrl: 'https://api.openai.com/v1' });
    expect(patched.reembedded).toBe(false);

    // a client that models no providers at all keeps the stored ones
    expect((await saved(await save({ llm: { label: '工作密钥' } }))).config.embeddingProviders).toHaveLength(3);
  });

  it('re-embeds when the active provider changes, and not when a label does', async () => {
    const switched = await saved(await save({ embeddingUse: 'local-alt' }));
    expect(switched.reembedded).toBe(true);
    expect(switched.config.embeddingUse).toBe('local-alt');
    expect(switched.config.embedding).toMatchObject({ provider: 'local', dimensions: 8 });

    const renamed = await saved(await save({
      embeddingProviders: switched.config.embeddingProviders.map((e) => (e.id === 'local-alt' ? { ...e, label: 'renamed' } : { ...e })),
    }));
    expect(renamed.reembedded).toBe(false);
    expect(renamed.config.embeddingProviders.find((e) => e.id === 'local-alt')?.label).toBe('renamed');

    const back = await saved(await save({ embeddingUse: 'local-1' }));
    expect(back.reembedded).toBe(true);
  });

  it('lists a named provider on its own route and refuses an unknown one', async () => {
    const ok = await models({ route: 'embedding:local-alt', config: {} });
    expect(ok.status).toBe(200);
    expect((await ok.json()) as { ok: boolean }).toMatchObject({ ok: true });
    expect((await models({ route: 'embedding:nope', config: {} })).status).toBe(400);
  });

  it('names the default LLM and keeps that name through a later patch', async () => {
    expect((await read()).llm.label).toBe('工作密钥');
    await save({ llm: { model: '' } });
    expect((await read()).llm.label).toBe('工作密钥');
  });

  it('persists model pools and key limits without exposing or erasing keys', async () => {
    vi.stubEnv('KNODE_EMBEDDING_USAGE_FILE', path.join(tmp, 'pool-usage.json'));
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const input = init?.body ? JSON.parse(String(init.body)).input : undefined;
      return Response.json({ data: input ? input.map((_text: string, index: number) => ({ index, embedding: Array(1024).fill(1) })) : [] });
    });
    try {
    const before = await read();
    const poolEntry = { id: 'pool-test', label: 'Pool key', provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1',
      model: 'BAAI/bge-m3', dimensions: 1024, apiKey: 'pool-secret', catalog: ['BAAI/bge-m3'],
      enabled: true, priority: 0, quotaGroup: 'account-test',
      limits: { requestsPerMinute: 60, tokensPerMinute: 100000, requestsPerDay: 5000, tokensPerDay: 1000000, concurrency: 2, resetTimezone: 'UTC' } };
    const response = await save({ embeddingProviders: [...before.embeddingProviders, poolEntry],
      embeddingPool: { enabled: true, model: 'bge-m3', dimensions: 1024, batchSize: 16 } });
    expect(response.status).toBe(200);
    const result = await saved(response);
    expect(result.config.embedding).toMatchObject({ apiKey: '', baseUrl: 'pool://l2-v1', dimensions: 1024 });
    expect(result.config.embeddingProviders.at(-1)).toMatchObject({ apiKey: '***', limits: poolEntry.limits, priority: 0 });
    const renamed = await saved(await save({ embeddingProviders: result.config.embeddingProviders.map((e) => ({ ...e, label: e.label + ' renamed' })) }));
    expect(renamed.reembedded).toBe(false);
    const file = path.join(root, 'users/tester/workspaces/default/knode.config.json');
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8')) as KnodeConfig;
    expect(persisted.embeddingProviders.at(-1)?.apiKey).toBe('pool-secret');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const invalid = await save({ embeddingProviders: renamed.config.embeddingProviders.map((e) => ({ ...e, enabled: false })) });
    expect(invalid.status).toBe(400);
    expect((await read()).embeddingProviders.at(-1)?.enabled).toBe(true);
    // Restore the offline fixture so unrelated route tests never need a network call.
    await save({ embeddingProviders: before.embeddingProviders, embeddingUse: before.embeddingUse, embeddingPool: { enabled: false } });
    } finally { mock.mockRestore(); vi.unstubAllEnvs(); }
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
    const ark = (cfg: KnodeConfig) => cfg.connections.find((c) => c.id === 'ark')!;
    expect(ark(body.config)).toMatchObject({ id: 'ark', label: 'Ark vision', apiKey: '***' });
    expect(body.config.extraction.documentLlm.use).toBe('ark');
    // the default is an ordinary row in the same list, and a client that did
    // not send it gets it back rather than losing it
    expect(body.config.connections.some((c) => c.id === body.config.llmUse)).toBe(true);
    expect(body.config.llm.label).toBe('工作密钥');

    // echoing the redacted key back must not overwrite the stored one
    const kept = await save({ connections: [{ id: 'ark', label: 'Ark vision', provider: 'openai', baseUrl: 'https://ark.example/api/v3', apiKey: '***', model: 'doubao-pro' }] });
    const keptBody = (await kept.json()) as { config: KnodeConfig };
    expect(ark(keptBody.config).model).toBe('doubao-pro');

    const models = await app.request('/api/config/models', {
      method: 'POST',
      headers,
      body: JSON.stringify({ route: 'connection:ark', config: {} }),
    });
    expect(models.status).toBe(200);
    expect((await models.json()) as { source: string }).toMatchObject({ source: 'api' });

    // clearing the list drops the extras but never the default: something has
    // to answer, so the row `llmUse` names comes back from the mirror
    const dropped = ((await (await save({ connections: [] })).json()) as { config: KnodeConfig }).config;
    expect(dropped.connections.map((c) => c.id)).toEqual([dropped.llmUse]);
    expect(dropped.llm.label).toBe('工作密钥');
  });

  it('makes another connection the default by pointing at it, without retyping the endpoint', async () => {
    const save = async (body: unknown) =>
      app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify(body) });

    const before = ((await (await save({
      connections: [{ id: 'ark2', label: 'Ark', provider: 'openai', baseUrl: 'https://ark.example/api/v3', apiKey: 'sk-ark', model: 'doubao-pro' }],
    })).json()) as { config: KnodeConfig }).config;
    const previousDefault = before.llmUse;
    expect(previousDefault).not.toBe('ark2');

    const after = ((await (await save({ llmUse: 'ark2' })).json()) as { config: KnodeConfig }).config;
    expect(after.llmUse).toBe('ark2');
    // the mirror follows the row, so whatever follows the default moves with it
    // — the stages do not, each names what it runs on
    expect(after.llm).toMatchObject({ baseUrl: 'https://ark.example/api/v3', model: 'doubao-pro', apiKey: '***' });
    // and the one that used to be the default is still on the list, just no longer default
    expect(after.connections.some((c) => c.id === previousDefault)).toBe(true);
  });
});

describe('what a CLI says it offers', () => {
  it('reads the listable models out of a codex catalog, best first', () => {
    const catalog = JSON.stringify({
      models: [
        { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 12, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'xhigh' }] },
        { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', priority: 1, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }, { effort: 'ultra' }] },
        { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', priority: 3 },
        { slug: '', display_name: 'nameless', visibility: 'list' },
      ],
    });
    expect(parseCodexCatalog(catalog)).toEqual([
      { id: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: [{ id: 'low' }, { id: 'max' }, { id: 'ultra' }] },
      { id: 'gpt-5.5', label: 'GPT-5.5', efforts: [{ id: 'low' }, { id: 'high' }, { id: 'xhigh' }] },
    ]);
  });

  it('keeps what the effort control needs: the levels, the default, and the Fast tier', () => {
    const catalog = JSON.stringify({
      models: [{
        slug: 'gpt-6.1-sol',
        display_name: 'GPT-6.1-Sol',
        visibility: 'list',
        priority: 1,
        default_reasoning_level: 'low',
        supported_reasoning_levels: [
          { effort: 'low', description: 'Fast responses with lighter reasoning' },
          { effort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
          'not a level',
        ],
        // the tier is named here the way service_tier takes it…
        additional_speed_tiers: ['fast'],
        // …and described here, under an id of its own
        service_tiers: [{ id: 'priority', name: 'Fast', description: '2x speed, increased usage' }],
      }],
    });
    expect(parseCodexCatalog(catalog)).toEqual([{
      id: 'gpt-6.1-sol',
      label: 'GPT-6.1-Sol',
      efforts: [
        { id: 'low', description: 'Fast responses with lighter reasoning' },
        { id: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
      ],
      defaultEffort: 'low',
      speeds: [{ id: 'fast', name: 'Fast', description: '2x speed, increased usage' }],
    }]);
  });

  it('reads what codex runs when nothing is named, profile first', () => {
    const toml = [
      'model = "gpt-6-astra"',
      'model_reasoning_effort = "xhigh"',
      'service_tier = "default"',
      '',
      '[mcp_servers.docs]',
      'model = "not a codex setting"',
      '',
      '[profiles.quick]',
      'model_reasoning_effort = "low"',
      'service_tier = "fast"',
    ].join('\n');
    expect(parseCodexDefaults(toml)).toEqual({ model: 'gpt-6-astra', effort: 'xhigh' });
    expect(parseCodexDefaults(`profile = "quick"\n${toml}`)).toEqual({ model: 'gpt-6-astra', effort: 'low', speed: 'fast' });
    expect(parseCodexDefaults('# nothing set\n[tui]\ntheme = "dark"\n')).toBeUndefined();
  });

  it('tolerates a catalog with noise around it, and refuses one that is not JSON', () => {
    expect(parseCodexCatalog('warning: stale cache\n{"models":[{"slug":"gpt-6-astra"}]}\n')).toEqual([
      { id: 'gpt-6-astra', label: 'gpt-6-astra' },
    ]);
    expect(() => parseCodexCatalog('command not found')).toThrow();
  });

  it('reads the aliases claude names as examples, and drops the full ids', () => {
    const help = [
      '  --model <model>                       Model for the current session. Provide',
      "                                        an alias for the latest model (e.g.",
      "                                        'fable', 'opus', or 'sonnet') or a",
      "                                        model's full name (e.g.",
      "                                        'claude-fable-5').",
      '  -n, --name <name>                     Set a display name for this session',
    ].join('\n');
    expect(parseClaudeAliases(help)).toEqual(['fable', 'opus', 'sonnet']);
    expect(parseClaudeAliases('nothing to see here')).toEqual([]);
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

describe('migrateChatConfig', () => {
  it('drops the chat keys the agent definition now owns, and keeps the conversation ones', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'chat-config-'));
    const stored = {
      ...defaultConfig(),
      chat: { agent: 'writer', model: 'sonnet', effort: 'high', maxTurns: 100, timeoutMs: 1_200_000, web: 'on', historyTurns: 4, keep: 9 },
    };
    fs.writeFileSync(path.join(dir, 'knode.config.json'), JSON.stringify(stored));

    const loaded = loadConfig(dir);
    expect(loaded.chat).toEqual({ agent: 'writer', model: 'sonnet', historyTurns: 4, keep: 9 });
    // the keys are gone from the object, not merely ignored, so the next save cleans the file
    expect(Object.keys(loaded.chat)).not.toContain('effort');
    expect(Object.keys(loaded.chat)).not.toContain('maxTurns');
  });
});

describe('dropTokenBudget', () => {
  it('drops the retired daily token budget, and writes the file without it', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'budget-config-'));
    const file = path.join(dir, 'knode.config.json');
    fs.writeFileSync(file, JSON.stringify(loadConfig(dir)));
    loadConfig(dir); // settles whatever else a first load writes down
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...stored, extraction: { ...stored.extraction, dailyTokenBudget: 5_000_000 } }));

    const loaded = loadConfig(dir);
    expect(loaded.extraction).not.toHaveProperty('dailyTokenBudget');
    expect(loaded.extraction.batchSize).toBe(stored.extraction.batchSize);
    // written down at once, so the file stops showing a setting nothing reads
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).extraction).not.toHaveProperty('dailyTokenBudget');
  });
});

describe('dropInitExtractionChoice', () => {
  it('drops the retired drain / skip choice and keeps the time cap', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'init-config-'));
    const file = path.join(dir, 'knode.config.json');
    fs.writeFileSync(file, JSON.stringify(loadConfig(dir)));
    loadConfig(dir); // settles whatever else a first load writes down
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({
      ...stored,
      research: { ...stored.research, init: { followUps: 4, extraction: 'skip', extractionMaxMs: 300_000 } },
    }));

    const loaded = loadConfig(dir);
    expect(loaded.research.init).toEqual({ followUps: 4, extractionMaxMs: 300_000 });
    // an initialization always catches up now, so the file stops offering a choice nothing reads
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).research.init).not.toHaveProperty('extraction');
  });
});

describe('migrateDefaultLlm', () => {
  const write = (config: unknown) => {
    const dir = fs.mkdtempSync(path.join(tmp, 'default-llm-'));
    fs.writeFileSync(path.join(dir, 'knode.config.json'), JSON.stringify(config));
    return dir;
  };

  it('lifts a lone `llm` into the connection list and points at it', () => {
    const base = defaultConfig();
    const dir = write({
      ...base,
      llm: { ...base.llm, provider: 'openai', baseUrl: 'https://one.example/v1', apiKey: 'sk', model: 'm-1', label: '主力' },
      connections: [],
    });

    const loaded = loadConfig(dir);
    const row = loaded.connections.find((c) => c.id === loaded.llmUse);
    expect(row).toMatchObject({ baseUrl: 'https://one.example/v1', model: 'm-1', label: '主力' });
    // the mirror is the row, so nothing that reads config.llm has to change
    expect(loaded.llm).toMatchObject({ baseUrl: 'https://one.example/v1', model: 'm-1' });
  });

  it('reuses a connection with the same endpoint instead of adding a twin', () => {
    const base = defaultConfig();
    const endpoint = { provider: 'openai' as const, baseUrl: 'https://two.example/v1', apiKey: 'sk', model: 'm-2', cliPath: '', cliTimeoutMs: 300_000 };
    const dir = write({
      ...base,
      llm: { ...base.llm, ...endpoint },
      connections: [{ ...endpoint, id: 'already', label: 'Already there' }],
    });

    const loaded = loadConfig(dir);
    expect(loaded.llmUse).toBe('already');
    expect(loaded.connections).toHaveLength(1);
  });

  it('pins an inheriting route to the default it ran on, and writes that down', () => {
    const base = defaultConfig();
    const dir = write({
      ...base,
      llm: { ...base.llm, provider: 'openai', baseUrl: 'https://three.example/v1', apiKey: 'sk', model: 'm-3' },
      connections: [],
      extraction: {
        ...base.extraction,
        tier1Model: 'legacy-entity',
        entityLlm: { ...defaultRoutedLlmConfig(), use: '' },
        summaryLlm: { ...defaultRoutedLlmConfig(), use: 'default' },
      },
    });

    const loaded = loadConfig(dir);
    // a stage names what it runs on: there is no "whatever the default is"
    for (const key of ['entityLlm', 'documentLlm', 'summaryLlm', 'judgeLlm'] as const) {
      expect(loaded.extraction[key].use).toBe(loaded.llmUse);
    }
    expect(resolveRoutedLlmConfig(loaded.llm, loaded.extraction.documentLlm, loaded.connections).model).toBe('m-3');
    // the legacy tier model the route was running is carried onto it
    expect(loaded.extraction.entityLlm.model).toBe('legacy-entity');
    expect(loaded.extraction.tier1Model).toBe('');

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'knode.config.json'), 'utf8')) as KnodeConfig;
    expect(onDisk.extraction.entityLlm.use).toBe(loaded.llmUse);
    expect(onDisk.modelAgents).toBeUndefined();
  });

  it('is idempotent', () => {
    const once = migrateDefaultLlm(defaultConfig());
    const twice = migrateDefaultLlm(JSON.parse(JSON.stringify(once)) as KnodeConfig);
    expect(twice.llmUse).toBe(once.llmUse);
    expect(twice.connections).toHaveLength(once.connections.length);
  });
});
