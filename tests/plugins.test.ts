import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, defaultRoutedLlmConfig, KnodeConfig, redactConfig, redactConnectionUrl } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { readSidecarPart } from '../src/fs/sidecar.js';
import { runTier1Pass } from '../src/graph/tier1.js';
import { conversionCacheKey, isConvertibleFile } from '../src/ingest/convert.js';
import { createEmbeddingProvider } from '../src/ingest/embeddings.js';
import { sync } from '../src/ingest/sync.js';
import { LlmClient } from '../src/llm/client.js';
import { listChatModels } from '../src/llm/models.js';
import { configuredPluginSpecs, resolvePluginModule } from '../src/plugins/loader.js';
import { PluginRegistry, pluginRegistry } from '../src/plugins/registry.js';
import { createApp } from '../src/server/app.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';
import { openPglite, postgresDatabaseName, postgresPoolConfig } from '../src/store/backend.js';

/**
 * The plugin system (docs/design/11): providers, storage backends, converters
 * and hooks registered by a module the config names, exercised through the
 * same code paths the built-ins take — a sync, a tier-1 pass, the settings API.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-plugins-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(root: string, rel: string, content: string, mode?: number): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, mode ? { mode } : undefined);
}

/** Every extension point at once, talking back to the test through globalThis. */
const PLUGIN_MODULE = `
const rot13 = (s) => s.replace(/[a-z]/gi, (c) => {
  const base = c <= 'Z' ? 65 : 97;
  return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
});
const state = { applied: [], options: null, summaryPrompts: 0 };
globalThis.__knodeTestPlugin = state;

export default {
  name: 'test-plugin',
  version: '1.0.0',
  description: 'exercises every extension point',
  llmProviders: [{
    id: 'test-llm',
    label: 'Test LLM',
    kind: 'custom',
    fields: ['model'],
    create: (cfg) => ({
      enabled: true,
      label: 'test-llm:' + (cfg.model || 'default'),
      async complete(messages) {
        const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\\n');
        const user = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\\n');
        if (user.includes('Reply with exactly the word: pong')) return 'pong';
        // an extraction call answers only when the request hook left its mark
        if (!system.includes('PLUGIN-RULE')) return JSON.stringify({ entities: [], relations: [], claims: [] });
        return JSON.stringify({ entities: [{ name: 'Acme', type: 'organization', description: 'a test company', aliases: [] }], relations: [], claims: [] });
      },
    }),
    listModels: async () => ({ ok: true, source: 'builtin', models: [{ id: 'tiny' }, { id: 'large' }] }),
  }],
  embeddingProviders: [{
    id: 'test-embed',
    label: 'Test embedder',
    kind: 'custom',
    fields: ['dimensions'],
    create: (cfg) => ({
      model: 'test-embed-v1',
      dimensions: cfg.dimensions,
      embed: async (texts) => texts.map((t) => {
        const v = new Array(cfg.dimensions).fill(0);
        for (let i = 0; i < t.length; i++) v[t.charCodeAt(i) % cfg.dimensions] += 1;
        const n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      }),
    }),
  }],
  converters: [{
    id: 'rot13',
    label: 'ROT13 text',
    extensions: ['.rot13'],
    version: 2,
    convert: async ({ absPath, rel }) => {
      const fs = await import('node:fs');
      const text = rot13(fs.readFileSync(absPath, 'utf8'));
      return { markdown: '# ' + rel + '\\n\\n' + text, kind: 'rot13', model: 'rot13', warnings: [] };
    },
  }],
  hooks: {
    'source.text': (text) => text.replace(/CONFIDENTIAL/g, '[redacted]'),
    chunk: (pieces) => [{ content: pieces.map((p) => p.content).join('\\n'), tokenCount: 1 }],
    'tier0.concepts': (concepts) => [...concepts, 'PluginConcept'],
    'extract.request': (request) => ({
      ...request,
      messages: request.messages.map((m) => (m.role === 'system' ? { ...m, content: m.content + '\\nPLUGIN-RULE' } : m)),
    }),
    'extract.result': (result) => ({ ...result, entities: result.entities.map((e) => ({ ...e, name: e.name + ' Corp' })) }),
    'summary.request': (messages) => { state.summaryPrompts++; return messages; },
    'document.applied': (event) => { state.applied.push(event.path); },
  },
  setup(api, options) {
    state.options = options;
    api.log('ready');
  },
};
`;

interface TestPluginState {
  applied: string[];
  options: Record<string, unknown> | null;
  summaryPrompts: number;
}

const pluginState = () => (globalThis as unknown as { __knodeTestPlugin: TestPluginState }).__knodeTestPlugin;

const headers = {
  'content-type': 'application/json',
  'x-knode-user': 'tester',
  'x-knode-workspace-kind': 'personal',
  'x-knode-workspace-id': 'default',
  'x-knode-workspace-name': 'Default',
};

function pluginConfig(): KnodeConfig {
  const base = defaultConfig();
  const route = { ...defaultRoutedLlmConfig(), use: 'connection-1' };
  return {
    ...base,
    plugins: [{ module: './plugins/test-plugin.mjs', options: { tag: 'T' } }],
    embeddingProviders: [{
      id: 'emb-1', label: 'test', provider: 'test-embed', baseUrl: '', apiKey: '', model: '', dimensions: 16, batchSize: 8, sendDimensions: false,
    }],
    embeddingUse: 'emb-1',
    connections: [{
      id: 'connection-1', label: 'test', provider: 'test-llm', baseUrl: '', apiKey: '', protocol: 'chat', model: 'tiny', cliPath: '', effort: 'default', cliTimeoutMs: 30_000,
    }],
    llmUse: 'connection-1',
    extraction: { ...base.extraction, entityLlm: route, documentLlm: route, summaryLlm: route, judgeLlm: route },
  };
}

describe('a plugin module named in the config', () => {
  const dir = path.join(tmp, 'ws');
  let ctx: AppContext;

  beforeAll(async () => {
    fs.mkdirSync(dir, { recursive: true });
    write(dir, 'plugins/test-plugin.mjs', PLUGIN_MODULE);
    fs.writeFileSync(path.join(dir, 'knode.config.json'), JSON.stringify(pluginConfig()));
    // long enough for the built-in splitter to make several chunks; the plugin merges them into one
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}: Knowledge Graph work on CONFIDENTIAL matters. ${'lorem ipsum dolor sit amet '.repeat(12)}`);
    write(dir, 'raw/docs/long.md', `# Long\n\n${paragraphs.join('\n\n')}\n`);
    write(dir, 'raw/docs/secret.rot13', 'Uryyb Jbeyq sebz n cyhtva pbairegre');
    ctx = await createContext(dir);
  });

  afterAll(async () => {
    await ctx.store.close();
  });

  it('is loaded when the context opens, with its options, and provides the embedder and the LLM the config names', () => {
    expect(pluginState().options).toEqual({ tag: 'T' });
    expect(ctx.embedder.model).toBe('test-embed-v1');
    expect(ctx.embedder.dimensions).toBe(16);
    expect(ctx.llm.enabled).toBe(true);
    expect(ctx.llm.label).toBe('test-llm:tiny');
    const summary = pluginRegistry().describe().find((p) => p.name === 'test-plugin');
    expect(summary?.source).toBe('./plugins/test-plugin.mjs');
    expect(summary?.llmProviders).toEqual(['test-llm']);
    expect(summary?.converters).toEqual(['rot13']);
    expect(summary?.hooks).toContain('extract.result');
    expect(pluginRegistry().describe().find((p) => p.name === 'builtin')?.storageBackends).toEqual(['pglite', 'postgres']);
  });

  it('runs its hooks and its converter through a sync', async () => {
    const stats = await sync(ctx, { llmGraph: true });
    expect(stats.errors).toBe(0);
    // the two sources, plus the wiki's own pages
    expect(stats.indexed).toBeGreaterThanOrEqual(2);

    const docs = await ctx.store.query<{ path: string; status: string; id: string }>(`SELECT id, path, status FROM documents WHERE root = 'docs' ORDER BY path`);
    expect(docs.map((d) => [d.path, d.status])).toEqual([['raw/docs/long.md', 'indexed'], ['raw/docs/secret.rot13', 'indexed']]);

    // source.text ran before hashing and chunking; chunk merged the splitter's pieces into one
    const long = docs.find((d) => d.path === 'raw/docs/long.md')!;
    const chunks = await ctx.store.query<{ content: string }>(`SELECT content FROM chunks WHERE document_id = $1`, [long.id]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('[redacted]');
    expect(chunks[0].content).not.toContain('CONFIDENTIAL');

    // the converter plugin owns .rot13: prepared into the sidecar under a key that names it
    expect(isConvertibleFile('raw/docs/secret.rot13')).toBe(true);
    const meta = readSidecarPart(dir, 'raw/docs/secret.rot13', 'meta');
    expect(meta?.conversion?.kind).toBe('rot13');
    expect(meta?.conversion?.key.startsWith('rot13@2|')).toBe(true);
    const secret = docs.find((d) => d.path === 'raw/docs/secret.rot13')!;
    const decoded = await ctx.store.query<{ content: string }>(`SELECT content FROM chunks WHERE document_id = $1`, [secret.id]);
    expect(decoded[0].content).toContain('Hello World from a plugin converter');

    // tier0.concepts added a term, which became a concept entity
    const concept = await ctx.store.query<{ name: string; type: string }>(`SELECT name, type FROM entities WHERE name = 'PluginConcept' AND tx_to IS NULL`);
    expect(concept).toEqual([{ name: 'PluginConcept', type: 'concept' }]);

    // document.applied saw both documents (and the wiki pages, which are documents too)
    expect(pluginState().applied.filter((p) => p.startsWith('raw/docs/')).sort()).toEqual(['raw/docs/long.md', 'raw/docs/secret.rot13']);
    expect(pluginState().applied).toContain('wiki/index.md');

    // the vectors came from the plugin embedder
    const [embedded] = await ctx.store.query<{ n: number; models: number; model: string }>(
      `SELECT count(*)::int AS n, count(DISTINCT e.model)::int AS models, min(e.model) AS model
       FROM embeddings e JOIN chunks c ON c.id = e.chunk_id JOIN documents d ON d.id = c.document_id WHERE d.root = 'docs'`,
    );
    expect(embedded).toEqual({ n: 2, models: 1, model: 'test-embed-v1' });
  });

  it('shapes a tier-1 extraction call and its result', async () => {
    const stats = await runTier1Pass(ctx.store, ctx.config, ctx.llm, { batchSize: 4 });
    expect(stats.calls).toBeGreaterThan(0);
    expect(stats.callsFailed).toBe(0);
    // the fake only extracts when extract.request left PLUGIN-RULE in the system prompt,
    // and extract.result renamed what it extracted
    const acme = await ctx.store.query<{ name: string }>(`SELECT name FROM entities WHERE name LIKE 'Acme%' AND tx_to IS NULL`);
    expect(acme.map((e) => e.name)).toEqual(['Acme Corp']);
    const t1 = readSidecarPart(dir, 'raw/docs/long.md', 'tier1');
    expect(t1?.status).toBe('done');
    expect(t1?.entities.map((e) => e.name)).toEqual(['Acme Corp']);
  });

  it('lists the models a plugin provider offers, and answers a connection test', async () => {
    const models = await listChatModels(ctx.config.connections[0]);
    expect(models.ok).toBe(true);
    expect(models.models.map((m) => m.id)).toEqual(['tiny', 'large']);
    expect(await ctx.llm.complete([{ role: 'user', content: 'Reply with exactly the word: pong' }])).toBe('pong');
  });

  it('serves the provider catalog and the plugin list, and accepts the plugin provider in a settings save', async () => {
    const registry = new WorkspaceContextRegistry(dir, { templateConfig: ctx.config });
    const app = createApp(ctx, () => {}, registry);
    try {
      await app.request('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json', 'x-knode-user': 'tester' }, body: JSON.stringify({ name: 'Default' }) });

      const catalog = await (await app.request('/api/config/providers', { headers })).json() as {
        llm: { id: string; plugin: string; kind: string; fields: string[] | null }[];
        embedding: { id: string }[];
        storage: { id: string }[];
        converters: { id: string; extensions: string[] }[];
        hooks: { hook: string; handlers: string[] }[];
      };
      expect(catalog.llm.find((p) => p.id === 'openai')).toMatchObject({ plugin: 'builtin', kind: 'api', fields: ['baseUrl', 'apiKey', 'protocol', 'model'] });
      expect(catalog.llm.find((p) => p.id === 'command')).toMatchObject({ plugin: 'builtin', kind: 'custom' });
      expect(catalog.llm.find((p) => p.id === 'test-llm')).toMatchObject({ plugin: 'test-plugin', kind: 'custom', fields: ['model'] });
      expect(catalog.embedding.map((p) => p.id)).toEqual(expect.arrayContaining(['local', 'openai', 'ark-multimodal', 'test-embed']));
      expect(catalog.storage.map((b) => b.id)).toEqual(['pglite', 'postgres']);
      expect(catalog.converters.find((v) => v.id === 'rot13')?.extensions).toEqual(['.rot13']);
      expect(catalog.hooks.find((h) => h.hook === 'chunk')?.handlers).toEqual(['test-plugin']);

      const plugins = await (await app.request('/api/plugins', { headers })).json() as { plugins: { name: string }[]; configured: { module: string }[] };
      expect(plugins.plugins.map((p) => p.name)).toEqual(['builtin', 'test-plugin']);
      expect(plugins.configured).toEqual([{ module: './plugins/test-plugin.mjs', options: ['tag'] }]);

      // a connection on the plugin provider saves; an unknown provider is ignored rather than stored
      const saved = await app.request('/api/config', {
        method: 'PUT', headers,
        body: JSON.stringify({ connections: [
          { id: 'connection-1', label: 'test', provider: 'test-llm', model: 'large' },
          { id: 'connection-2', label: 'typo', provider: 'no-such-provider', baseUrl: 'https://x.example/v1', model: 'm' },
        ] }),
      });
      expect(saved.status).toBe(200);
      const body = await saved.json() as { config: KnodeConfig };
      expect(body.config.connections.find((c) => c.id === 'connection-1')).toMatchObject({ provider: 'test-llm', model: 'large' });
      expect(body.config.connections.find((c) => c.id === 'connection-2')?.provider).toBe('openai');
    } finally {
      await registry.closeAll();
    }
  });
});

describe('the built-in command provider', () => {
  it('runs an executable with the request on stdin and reads the reply from stdout', async () => {
    const script = path.join(tmp, 'model.sh');
    write(tmp, 'model.sh', [
      '#!/bin/bash',
      'input=$(cat)',
      `node -e 'const r = JSON.parse(process.argv[1]); console.log(JSON.stringify({ messages: r.messages.length, model: process.env.KNODE_LLM_MODEL, json: r.json, key: process.env.KNODE_LLM_API_KEY }))' "$input"`,
    ].join('\n'), 0o755);
    process.env.KNODE_TEST_CMD_KEY = 'secret-1';
    const client = new LlmClient({ provider: 'command', baseUrl: '', apiKey: 'env:KNODE_TEST_CMD_KEY', model: 'm1', cliPath: script, cliTimeoutMs: 30_000 });
    expect(client.enabled).toBe(true);
    expect(client.label).toBe('command:model.sh:m1');
    const reply = await client.completeJson<{ messages: number; model: string; json: boolean; key: string }>([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ]);
    expect(reply).toEqual({ messages: 2, model: 'm1', json: true, key: 'secret-1' });
    // no executable, no model
    expect(new LlmClient({ provider: 'command', baseUrl: '', apiKey: '', model: '', cliPath: '', cliTimeoutMs: 1000 }).enabled).toBe(false);
  });
});

describe('unknown providers', () => {
  it('make a disabled client that names the provider when called', async () => {
    const client = new LlmClient({ provider: 'nope', baseUrl: '', apiKey: '', model: 'x', cliPath: '', cliTimeoutMs: 1000 });
    expect(client.enabled).toBe(false);
    expect(client.label).toBe('nope');
    await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(/unknown LLM provider "nope"/);
    expect(() => createEmbeddingProvider({ provider: 'nope', baseUrl: '', apiKey: '', model: '', dimensions: 4, batchSize: 1, sendDimensions: false })).toThrow(/unknown embedding provider "nope"/);
  });
});

describe('storage backends', () => {
  it('open the embedded database where database.path says, and through a plugin backend', async () => {
    const custom = path.join(tmp, 'custom-store');
    fs.mkdirSync(custom, { recursive: true });
    const cfg = defaultConfig();
    cfg.database = { ...cfg.database, kind: 'pglite', path: '.knode/elsewhere' };
    fs.writeFileSync(path.join(custom, 'knode.config.json'), JSON.stringify(cfg));
    const ctx = await createContext(custom);
    try {
      expect(fs.existsSync(path.join(custom, '.knode/elsewhere'))).toBe(true);
      expect(fs.existsSync(path.join(custom, '.knode/db'))).toBe(false);
    } finally {
      await ctx.store.close();
    }

    // an in-process registration, the way an embedding program or a test adds a backend
    const opened: string[] = [];
    pluginRegistry().registerStorageBackend({
      id: 'test-store',
      label: 'Test store',
      open: (dataDir, config) => {
        opened.push(String(config.options?.hint));
        return openPglite(dataDir, { path: '.knode/plugin-db' });
      },
    }, 'test-suite');
    const viaPlugin = path.join(tmp, 'plugin-store');
    fs.mkdirSync(viaPlugin, { recursive: true });
    const cfg2 = defaultConfig();
    cfg2.database = { ...cfg2.database, kind: 'test-store', options: { hint: 'from-options' } };
    fs.writeFileSync(path.join(viaPlugin, 'knode.config.json'), JSON.stringify(cfg2));
    const ctx2 = await createContext(viaPlugin);
    try {
      expect(opened).toEqual(['from-options']);
      expect(fs.existsSync(path.join(viaPlugin, '.knode/plugin-db'))).toBe(true);
      await ctx2.store.query('SELECT 1');
    } finally {
      await ctx2.store.close();
    }
    expect(pluginRegistry().describe().find((p) => p.name === 'test-suite')?.storageBackends).toEqual(['test-store']);

    // an unknown kind fails the open with the kinds that exist
    const unknown = path.join(tmp, 'unknown-store');
    fs.mkdirSync(unknown, { recursive: true });
    const cfg3 = defaultConfig();
    cfg3.database = { ...cfg3.database, kind: 'mystery' };
    fs.writeFileSync(path.join(unknown, 'knode.config.json'), JSON.stringify(cfg3));
    await expect(createContext(unknown)).rejects.toThrow(/unknown database.kind "mystery" \(registered: pglite, postgres, test-store\)/);
  });

  it('build pg pool settings from a connection string or the host fields', () => {
    process.env.KNODE_TEST_PG_URL = 'postgres://knode:s3cret@db.example:6432/knode_prod?sslmode=require';
    const viaUrl = { kind: 'postgres', host: '', port: 0, user: '', password: '', database: 'knode', schemaPrefix: 'ws', url: 'env:KNODE_TEST_PG_URL', ssl: 'no-verify' as const, poolSize: 4 };
    expect(postgresDatabaseName(viaUrl)).toBe('knode_prod');
    expect(postgresPoolConfig(viaUrl)).toEqual({ connectionString: process.env.KNODE_TEST_PG_URL, ssl: { rejectUnauthorized: false }, max: 4 });
    const admin = postgresPoolConfig(viaUrl, { database: 'postgres', max: 1 });
    expect(admin.connectionString).toBe('postgres://knode:s3cret@db.example:6432/postgres?sslmode=require');
    expect(admin.max).toBe(1);

    const viaFields = { kind: 'postgres', host: '127.0.0.1', port: 5432, user: 'knode', password: 'pw', database: 'knode', schemaPrefix: 'ws', ssl: true as const };
    expect(postgresDatabaseName(viaFields)).toBe('knode');
    expect(postgresPoolConfig(viaFields, { database: 'knode' })).toEqual({ host: '127.0.0.1', port: 5432, user: 'knode', password: 'pw', database: 'knode', ssl: true });

    // the settings API never shows the password inside a connection string
    expect(redactConnectionUrl('postgres://knode:s3cret@db.example:6432/knode')).toBe('postgres://knode:***@db.example:6432/knode');
    expect(redactConnectionUrl('env:DATABASE_URL')).toBe('env:DATABASE_URL');
    const cfg = defaultConfig();
    cfg.database = { ...cfg.database, url: 'postgres://knode:s3cret@db.example/knode' };
    expect(redactConfig(cfg).database.url).toBe('postgres://knode:***@db.example/knode');
  });
});

describe('the registry', () => {
  it('chains filters, keeps a value a handler does not return, and refuses an async handler on a synchronous hook', async () => {
    const registry = new PluginRegistry();
    registry.on('tier0.concepts', (concepts) => [...concepts, 'a'], 'p1');
    registry.on('tier0.concepts', () => undefined as unknown as string[], 'p2');
    registry.on('tier0.concepts', (concepts) => concepts.map((c) => c.toUpperCase()), 'p3');
    const ctx = { path: 'raw/docs/x.md', root: 'docs' as const, dataDir: '/tmp', text: '', frontmatter: {} };
    expect(await registry.filter('tier0.concepts', ['x'], ctx)).toEqual(['X', 'A']);

    registry.on('source.text', ((text: string) => Promise.resolve(text)) as unknown as (text: string) => string, 'lazy');
    expect(() => registry.filterSync('source.text', 'hi', { path: 'raw/docs/x.md', root: 'docs', dataDir: '/tmp' })).toThrow(/plugin lazy: 'source.text' handlers must be synchronous/);

    expect(() => registry.on('nope' as never, () => undefined, 'p')).toThrow(/unknown hook "nope"/);
    expect(() => registry.registerLlmProvider({ id: 'default', label: 'x', kind: 'custom', create: () => ({ enabled: false, label: 'x', complete: async () => '' }) }, 'p')).toThrow(/reserved/);
  });

  it('lets a plugin replace a built-in and says so', () => {
    const registry = new PluginRegistry();
    registry.registerConverter({ id: 'pdf', extensions: ['.pdf'], convert: async () => ({ markdown: 'x', kind: 'k', model: 'm', warnings: [] }) }, 'builtin');
    registry.registerConverter({ id: 'better-pdf', extensions: ['.pdf', '.PDF'], version: 3, convert: async () => ({ markdown: 'y', kind: 'k', model: 'm', warnings: [] }) }, 'vendor');
    expect(registry.converterFor('a.pdf')?.id).toBe('better-pdf');
    expect(registry.convertibleExtensions()).toEqual(['.pdf']);
    expect(registry.warnings).toEqual(['vendor: converter "better-pdf" takes .pdf over from "pdf"']);
    registry.registerLlmProvider({ id: 'openai', label: 'stock', kind: 'api', create: () => ({ enabled: true, label: 'stock', complete: async () => 'ok' }) }, 'builtin');
    registry.registerLlmProvider({ id: 'openai', label: 'mine', kind: 'api', create: () => ({ enabled: true, label: 'mine', complete: async () => 'ok' }) }, 'vendor');
    expect(registry.llmProvider('openai')?.label).toBe('mine');
    expect(registry.warnings).toContain('vendor replaces LLM provider "openai" from builtin');
    // the replaced id is no longer listed under the plugin that lost it
    expect(registry.describe().find((p) => p.name === 'builtin')?.llmProviders).toEqual([]);
    expect(registry.describe().find((p) => p.name === 'vendor')?.llmProviders).toEqual(['openai']);
  });
});

describe('the loader', () => {
  it('resolves module specs against the data directory, then the roots it is given, and reads KNODE_PLUGINS', () => {
    const dataDir = path.join(tmp, 'resolve');
    expect(resolvePluginModule(dataDir, './plugins/x.mjs')).toBe(`file://${path.join(dataDir, 'plugins/x.mjs')}`);
    expect(resolvePluginModule(dataDir, '/abs/x.mjs')).toBe('file:///abs/x.mjs');
    // a workspace copy of the root config: the file is beside the root config
    const root = path.join(tmp, 'resolve-root');
    write(root, 'plugins/shared.mjs', 'export default { name: "shared" };');
    expect(resolvePluginModule(dataDir, './plugins/shared.mjs', [root])).toBe(`file://${path.join(root, 'plugins/shared.mjs')}`);
    write(dataDir, 'plugins/shared.mjs', 'export default { name: "own" };');
    expect(resolvePluginModule(dataDir, './plugins/shared.mjs', [root])).toBe(`file://${path.join(dataDir, 'plugins/shared.mjs')}`);
    expect(resolvePluginModule(dataDir, 'some-package')).toBe('some-package');
    expect(() => resolvePluginModule(dataDir, '  ')).toThrow(/empty/);
    expect(configuredPluginSpecs([{ module: ' ./a.mjs ', options: { x: 1 } }, { module: './off.mjs', enabled: false }], { KNODE_PLUGINS: 'pkg-a, ./a.mjs' }))
      .toEqual([{ module: './a.mjs', options: { x: 1 } }, { module: 'pkg-a', options: {} }]);
  });

  it('keeps the cache key the built-in converters used before converters were plugins', () => {
    expect(conversionCacheKey({}, 'raw/docs/a.pdf')).toBe('v1|no-vision|pages:100|image:2048');
    // the format, not the number: images went to version 2 when mind maps began coming back as outlines (docs/design/19)
    expect(conversionCacheKey({ vision: { enabled: true, label: 'gpt-vision', complete: async () => '' } }, 'raw/docs/a.png')).toBe('v2|gpt-vision|pages:100|image:2048');
    expect(conversionCacheKey({})).toBe('v1|no-vision|pages:100|image:2048');
  });
});
