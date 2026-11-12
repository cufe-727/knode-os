import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, defaultRoutedLlmConfig, EmbeddingConnection, LlmConnection } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { readSidecarPart, readSourceSummary } from '../src/fs/sidecar.js';
import { pendingEmbeddings } from '../src/ingest/embed-backfill.js';
import { DEFAULT_EMBEDDING_LIMITS } from '../src/ingest/embedding-router.js';
import { sync } from '../src/ingest/sync.js';
import { LabelingScheduler } from '../src/labeling/scheduler.js';
import { REMOTE_TOKENS_FILE, RemoteTokenStore } from '../src/remote/tokens.js';
import { createApp } from '../src/server/app.js';
import { hostnameOf, isPublicRequest } from '../src/server/public-guard.js';
import { resolveWorkspaceScope, WorkspaceContextRegistry, workspaceDataDir } from '../src/server/workspaces.js';
import { CallLedger } from '../src/estimate/ledger.js';
import { WorkBroker } from '../src/work/broker.js';
import { EmbedSource, PROBE_TEXTS } from '../src/work/embed.js';
import { JudgeSource } from '../src/work/judge.js';
import { SummarySource } from '../src/work/summarize.js';
import { startFakeEmbeddings, type FakeEmbeddings } from './helpers/fake-embeddings.js';
import { startFakeOpenAi, type ChatRequest, type FakeOpenAi } from './helpers/fake-openai.js';

/**
 * The remote API (src/remote) and the public boundary in front of `serve`
 * (src/server/public-guard.ts): per-machine tokens with scopes and
 * workspaces, extraction and summaries over HTTP, knowledge reads and writes
 * that stay inside the knowledge, read-only SQL — and a real worker process
 * on the other side.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-remote-'));
// the embedding pool's quota ledger is machine-wide: never the real one
process.env.KNODE_EMBEDDING_USAGE_FILE = path.join(tmp, 'embedding-usage.json');
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (p as { text?: string })?.text ?? '').join('') : '';

function replyFor(user: string): string {
  const doc = /\((raw\/docs\/[^)]+)\)/.exec(user)?.[1] ?? 'unknown';
  return JSON.stringify({ entities: [{ name: `实体-${path.basename(doc, '.md')}`, type: 'organization', description: '测试', aliases: [] }], relations: [], claims: [] });
}

/** A summary is Markdown naming its document; anything else is an extraction. */
const answer = (request: ChatRequest) => {
  const system = textOf(request.messages?.find((m) => m.role === 'system')?.content);
  const user = textOf(request.messages?.filter((m) => m.role === 'user').at(-1)?.content);
  if (system.includes('Summarize the document')) return `# 摘要\n\n${/Source file: (\S+)/.exec(user)?.[1] ?? '?'} 的摘要。`;
  return replyFor(user);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Summary pages written, by the document each one summarizes. */
const summaryPages = async (ctx: AppContext) => new Map((await ctx.store.query<{ path: string; doc: string }>(
  `SELECT p.path, d.input_id AS doc FROM pages p JOIN deps d ON d.artifact_kind = 'page' AND d.artifact_id = p.path AND d.input_kind = 'document'
   WHERE p.kind = 'source_summary' AND p.status <> 'archived'`,
)).map((r) => [r.doc, r.path]));

describe('the remote API', () => {
  const root = path.join(tmp, 'root');
  let fake: FakeOpenAi;
  let rootCtx: AppContext;
  let fin: AppContext;
  /** A workspace on a bge-m3 pool with its vectors deferred: what remote embed slots work for. */
  let vec: AppContext;
  /** The pool's one key, an own endpoint serving the same model, and one serving another. */
  let poolEndpoint: FakeEmbeddings;
  let ownEndpoint: FakeEmbeddings;
  let otherEndpoint: FakeEmbeddings;
  const embedSources = new Map<string, EmbedSource>();
  let registry: WorkspaceContextRegistry;
  let app: ReturnType<typeof createApp>;
  const schedulers = new Map<string, LabelingScheduler>();
  const brokers = new Map<string, WorkBroker>();
  const judgeSources = new Map<string, JudgeSource>();
  const ledgers = new Map<string, CallLedger>();
  const tok: Record<string, string> = {};

  /** A request as a client on this machine (or through an SSH tunnel) sends it, or as it arrives through the Cloudflare Tunnel. */
  const req = (p: string, init: RequestInit & { token?: string; public?: boolean | 'http'; ip?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.token) headers.set('authorization', `Bearer ${init.token}`);
    if (init.public) {
      headers.set('cf-connecting-ip', init.ip ?? '203.0.113.7');
      headers.set('cf-visitor', JSON.stringify({ scheme: init.public === 'http' ? 'http' : 'https' }));
    }
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    // cloudflared reaches serve over plain HTTP; the edge's scheme is in cf-visitor
    return app.request(init.public ? `http://knode.example.com${p}` : `http://127.0.0.1:12000${p}`, { ...init, headers });
  };
  const ws = '/remote/v1/w/admin/finance';

  beforeAll(async () => {
    fake = await startFakeOpenAi({ answer });
    poolEndpoint = await startFakeEmbeddings({ space: 'bge-m3' });
    ownEndpoint = await startFakeEmbeddings({ space: 'bge-m3', noise: 0.01, model: 'bge-m3' });
    otherEndpoint = await startFakeEmbeddings({ space: 'another-model', model: 'bge-m3' });
    const model: LlmConnection = {
      id: 'connection-1', label: 'fake', provider: 'openai', baseUrl: fake.url, apiKey: 'sk-test',
      protocol: 'chat', model: 'fake-model', cliPath: '', effort: 'default', cliTimeoutMs: 30_000,
    };
    const base = defaultConfig();
    const route = { ...defaultRoutedLlmConfig(), use: 'connection-1' };
    fs.mkdirSync(root, { recursive: true });
    // settings are the server's (src/global-settings.ts): every workspace embeds on a bge-m3 pool with one key,
    // its vectors deferred — leased work for remote embed slots — and no embed slots here
    const key: EmbeddingConnection = {
      id: 'pool-a', label: 'pool a', provider: 'openai', baseUrl: poolEndpoint.url, apiKey: 'sk-pool', model: 'BAAI/bge-m3',
      dimensions: 1024, batchSize: 16, sendDimensions: false, limits: { ...DEFAULT_EMBEDDING_LIMITS, requestsPerMinute: 10_000, concurrency: 8 },
    };
    fs.writeFileSync(path.join(root, 'knode.config.json'), JSON.stringify({
      ...base, connections: [model], llmUse: 'connection-1',
      // one-line documents: no size threshold, or none would be due a summary
      extraction: { ...base.extraction, entityLlm: route, documentLlm: route, summaryLlm: route, judgeLlm: route, summaryMinChars: 0 },
      embeddingProviders: [key], embeddingUse: 'pool-a',
      embeddingPool: { enabled: true, model: 'bge-m3', dimensions: 1024, batchSize: 4 },
      ingest: { ...base.ingest, watch: false, embedding: 'deferred', embedSlots: 0 },
    }));
    rootCtx = await createContext(root);
    registry = new WorkspaceContextRegistry(root, {
      templateConfig: rootCtx.config,
      // what `serve` wires per workspace: the scheduler, the summary source and the judge source behind one broker
      onCreate: (ctx) => {
        let summaries: SummarySource | null = null;
        const scheduler = new LabelingScheduler({ dataDir: ctx.dataDir, store: ctx.store, config: () => ctx.config, onWritten: (p) => summaries?.prefer(p) }, { priorityRefreshMs: 0 });
        summaries = new SummarySource(ctx, {}, { idleScanMs: 0 });
        const judges = new JudgeSource({ enabled: () => true }, { modelRetryMs: 0, transientRetryMs: 0 });
        // one batch in two carries a probe text, so the worker meets spot checks within a few batches
        const embeds = new EmbedSource({ dataDir: ctx.dataDir, store: ctx.store, config: () => ctx.config, embedder: () => ctx.embedder }, { idleScanMs: 0, spotCheckEvery: 2 });
        const ledger = CallLedger.forWorkspace(ctx.dataDir, { flushMs: 60_000 });
        const broker = new WorkBroker([scheduler, summaries, judges, embeds], { shares: () => ctx.config.server.remote?.shares, ledger });
        embedSources.set(ctx.dataDir, embeds);
        schedulers.set(ctx.dataDir, scheduler);
        brokers.set(ctx.dataDir, broker);
        judgeSources.set(ctx.dataDir, judges);
        ledgers.set(ctx.dataDir, ledger);
        return async () => {
          schedulers.delete(ctx.dataDir);
          brokers.delete(ctx.dataDir);
          judgeSources.delete(ctx.dataDir);
          await broker.stop();
        };
      },
    });
    registry.createUserWorkspace('admin', 'finance');
    fin = await registry.get(resolveWorkspaceScope({ user: 'admin', kind: 'personal', id: 'finance', name: 'finance' }));
    // a second workspace, whose vectors the embed tests count
    registry.createUserWorkspace('admin', 'vectors');
    const vecScope = resolveWorkspaceScope({ user: 'admin', kind: 'personal', id: 'vectors', name: 'vectors' });
    vec = await registry.get(vecScope);
    for (let i = 1; i <= 9; i++) write(vec.dataDir, `raw/docs/v${i}.md`, `# 向量 ${i}\n\n第${i}份等待向量的文档：光伏组件与储能电池的价格走势。\n`);
    await sync(vec, {});
    write(fin.dataDir, 'raw/docs/a.md', '# 甲\n\n宁德时代发布季度报告。\n');
    write(fin.dataDir, 'raw/docs/b.md', '# 乙\n\n比亚迪出货量增长。\n');
    write(fin.dataDir, 'raw/traces/claude/s.jsonl', '{"type":"user"}\n');
    await sync(fin, {});
    app = createApp(rootCtx, () => {}, registry, {
      services: (ctx) => ({
        mcp: () => null, kickResearch: () => {}, track: (job) => job,
        labeling: schedulers.get(ctx.dataDir) ?? null, work: brokers.get(ctx.dataDir) ?? null,
      }),
    });
    const tokens = new RemoteTokenStore(root);
    tok.labeler = tokens.create({ name: 'labeler', scopes: ['label'], workspaces: ['admin/finance'] }).token;
    tok.extractor = tokens.create({ name: 'extractor', scopes: ['label'], workspaces: ['admin/finance'], kinds: ['extract'] }).token;
    tok.summarizer = tokens.create({ name: 'summarizer', scopes: ['label'], workspaces: ['admin/finance'], kinds: ['summarize'] }).token;
    tok.reader = tokens.create({ name: 'reader', scopes: ['read', 'sql'], workspaces: ['admin/finance'] }).token;
    tok.writer = tokens.create({ name: 'writer', scopes: ['read', 'write'], workspaces: ['admin/finance'] }).token;
    tok.outsider = tokens.create({ name: 'outsider', scopes: ['read', 'label'], workspaces: ['admin/other'] }).token;
    tok.everywhere = tokens.create({ name: 'everywhere', scopes: ['read'], workspaces: ['*'] }).token;
    tok.revoked = tokens.create({ name: 'revoked', scopes: ['read'], workspaces: ['*'] }).token;
    tokens.revoke('revoked');
    tok.embedder = tokens.create({ name: 'embedder', scopes: ['embed'], workspaces: ['admin/vectors'] }).token;
    tok.both = tokens.create({ name: 'both', scopes: ['label', 'embed'], workspaces: ['admin/vectors', 'admin/finance'] }).token;
  });

  afterAll(async () => {
    await registry?.closeAll();
    await rootCtx?.store.close();
    await fake?.close();
    await Promise.all([poolEndpoint, ownEndpoint, otherEndpoint].map((e) => e?.close()));
  });

  describe('the public boundary', () => {
    it('knows a request from this machine from one that came through a proxy', () => {
      expect(hostnameOf('127.0.0.1:12000')).toBe('127.0.0.1');
      expect(hostnameOf('[::1]:12000')).toBe('[::1]');
      expect(isPublicRequest((h) => ({ host: '127.0.0.1:12000' } as Record<string, string>)[h])).toBe(false);
      expect(isPublicRequest((h) => ({ host: 'localhost:12000' } as Record<string, string>)[h])).toBe(false);
      expect(isPublicRequest((h) => ({ host: 'knode-os.lemoncheese.cc' } as Record<string, string>)[h])).toBe(true);
      // a loopback Host with a proxy's fingerprints is still from outside
      expect(isPublicRequest((h) => ({ host: '127.0.0.1:12000', 'x-forwarded-for': '198.51.100.1' } as Record<string, string>)[h])).toBe(true);
      expect(isPublicRequest(() => undefined, 'http://localhost/api/health')).toBe(false);
    });

    it('shows the outside nothing but the remote API, and that only over HTTPS', async () => {
      expect((await req('/api/health')).status).toBe(200);
      for (const p of ['/api/health', '/', '/index.html', '/mcp', '/api/workspaces']) {
        expect((await req(p, { public: true })).status, p).toBe(404);
      }
      expect((await req('/remote/v1/health', { public: 'http' })).status).toBe(403);
      const health = await req('/remote/v1/health', { public: true });
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true });
      expect((await req('/remote/v1/whoami', { public: true, token: tok.reader })).status).toBe(200);
    });
  });

  describe('tokens', () => {
    it('are stored hashed, owner-readable only, and named in every answer', async () => {
      const file = path.join(root, REMOTE_TOKENS_FILE);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const stored = fs.readFileSync(file, 'utf8');
      // the secret is everything after `knr_<12 hex>_` (base64url, so it may hold underscores itself)
      for (const t of Object.values(tok)) expect(stored).not.toContain(t.slice('knr_'.length + 13));
      const who = await req('/remote/v1/whoami', { token: tok.reader });
      const body = await who.json() as Record<string, unknown>;
      expect(body).toMatchObject({ name: 'reader', scopes: ['read', 'sql'], workspaces: ['admin/finance'] });
      expect(body).not.toHaveProperty('hash');
    });

    it('turn away a missing, malformed, unknown or revoked token', async () => {
      expect((await req('/remote/v1/whoami')).status).toBe(401);
      expect((await req('/remote/v1/whoami', { token: 'nope' })).status).toBe(401);
      expect((await req('/remote/v1/whoami', { token: `${tok.reader.slice(0, -4)}AAAA` })).status).toBe(401);
      expect((await req('/remote/v1/whoami', { token: tok.revoked })).status).toBe(401);
    });

    it('lock a client out after repeated failures, whatever it sends next', async () => {
      for (let i = 0; i < 10; i++) expect((await req('/remote/v1/whoami', { public: true, ip: '198.51.100.99', token: 'knr_000000000000_guess' })).status).toBe(401);
      expect((await req('/remote/v1/whoami', { public: true, ip: '198.51.100.99', token: tok.reader })).status).toBe(429);
      // others are not affected
      expect((await req('/remote/v1/whoami', { public: true, ip: '198.51.100.100', token: tok.reader })).status).toBe(200);
    });

    it('may be narrowed to some kinds of work, which only the "label" scope has', () => {
      const tokens = new RemoteTokenStore(root);
      expect(() => tokens.create({ name: 'odd', scopes: ['label'], workspaces: ['admin/finance'], kinds: ['dream'] })).toThrow(/unknown kind/);
      // embed work has a scope of its own, and lent keys only go with it
      expect(() => tokens.create({ name: 'odd', scopes: ['label'], workspaces: ['admin/finance'], kinds: ['embed'] })).toThrow(/"embed" scope/);
      expect(() => tokens.create({ name: 'odd', scopes: ['label', 'embed-keys'], workspaces: ['admin/finance'] })).toThrow(/"embed" scope too/);
      expect(() => tokens.create({ name: 'odd', scopes: ['read'], workspaces: ['admin/finance'], kinds: ['extract'] })).toThrow(/"label" scope/);
      expect(tokens.list().find((t) => t.name === 'extractor')?.kinds).toEqual(['extract']);
      expect(tokens.list().find((t) => t.name === 'labeler')).not.toHaveProperty('kinds');
    });

    it('reach only the workspaces and scopes they were given', async () => {
      expect((await req(`${ws}/documents`, { token: tok.labeler })).status).toBe(403);
      expect((await req(`${ws}/labeling/lease`, { method: 'POST', token: tok.reader, body: '{}' })).status).toBe(403);
      expect((await req(`${ws}/sql`, { method: 'POST', token: tok.writer, body: JSON.stringify({ sql: 'SELECT 1 FROM v_documents' }) })).status).toBe(403);
      expect((await req(`${ws}/documents`, { token: tok.outsider })).status).toBe(403);
      expect((await req('/remote/v1/w/admin/nowhere/documents', { token: tok.everywhere })).status).toBe(404);
      expect((await req(`${ws}/no-such-route`, { token: tok.everywhere })).status).toBe(404);
    });
  });

  describe('labeling over HTTP', () => {
    it('leases segments, takes the answers back and writes the documents', async () => {
      const lease = await req(`${ws}/labeling/lease`, { method: 'POST', token: tok.labeler, body: JSON.stringify({ worker: 'mac-1', backend: 'codex', max: 4 }) });
      expect(lease.status).toBe(200);
      const { leaseSeconds, tasks } = await lease.json() as { leaseSeconds: number; tasks: { id: string; prompt: string; messages: { role: string; content: string }[]; document: { path: string } }[] };
      expect(leaseSeconds).toBeGreaterThan(0);
      expect(tasks.map((t) => t.document.path).sort()).toEqual(['raw/docs/a.md', 'raw/docs/b.md']);

      // a worker under another name may not answer for this one
      const wrong = await req(`${ws}/labeling/complete`, { method: 'POST', token: tok.labeler, body: JSON.stringify({ worker: 'mac-2', backend: 'codex', id: tasks[0].id, ok: true, text: '{}' }) });
      expect(wrong.status).toBe(409);

      for (const t of tasks) {
        const done = await req(`${ws}/labeling/complete`, {
          method: 'POST', token: tok.labeler,
          body: JSON.stringify({ worker: 'mac-1', backend: 'codex', id: t.id, ok: true, text: replyFor(t.messages.at(-1)!.content), model: 'codex:gpt-test' }),
        });
        expect(await done.json()).toEqual({ accepted: true, documentWritten: true });
      }
      const again = await req(`${ws}/labeling/complete`, { method: 'POST', token: tok.labeler, body: JSON.stringify({ worker: 'mac-1', backend: 'codex', id: tasks[0].id, ok: true, text: '{}' }) });
      expect(again.status).toBe(409);

      expect(readSidecarPart(fin.dataDir, 'raw/docs/a.md', 'tier1')?.model).toBe('remote:codex:gpt-test');
      const status = await (await req(`${ws}/labeling/status`, { token: tok.labeler })).json() as { totals: { documentsWritten: number }; workers: { worker: string }[] };
      expect(status.totals.documentsWritten).toBe(2);
      expect(status.workers.map((w) => w.worker)).toContain('labeler/mac-1');
    });

    it('is extraction only, for a token that may take it', async () => {
      expect((await req(`${ws}/labeling/lease`, { method: 'POST', token: tok.summarizer, body: '{}' })).status).toBe(403);
      expect((await req(`${ws}/labeling/lease`, { method: 'POST', token: tok.extractor, body: '{}' })).status).toBe(200);
    });
  });

  describe('work over HTTP', () => {
    type Config = { version: string; kinds: Record<string, boolean>; shares: Record<string, number>; leaseSeconds: { llm: number }; hints: Record<string, unknown> };
    type Task = { id: string; kind: string; label: string; json: boolean; prompt: string; messages: { role: string; content: string }[] };

    it('tells a worker what it may take here, narrowed by its token and by the workspace', async () => {
      const config = await (await req(`${ws}/work/config`, { token: tok.labeler })).json() as Config;
      // judge calls stay on this machine unless the workspace offers them
      expect(config).toMatchObject({ kinds: { extract: true, summarize: true, judge: false }, shares: { extract: 3, summarize: 1 }, leaseSeconds: { llm: 900 } });
      expect(config.version).toMatch(/^[0-9a-f]{16}$/);
      // the workspace's models are endpoints, so there is no CLI to hint at
      expect(config.hints).toEqual({ extract: {}, summarize: {}, judge: {}, translate: {} });
      // translations are offered only where the workspace has content languages on (docs/design/17)
      expect(config.kinds.translate).toBe(false);
      expect(((await (await req(`${ws}/work/config`, { token: tok.extractor })).json()) as Config).kinds).toEqual({ extract: true, summarize: false, judge: false, translate: false, embed: false, session: false });
      // vectors are not leased work on a workspace that embeds inline, the default
      expect(config.kinds.embed).toBe(false);
      expect(config).not.toHaveProperty('embedding');
      expect((await req(`${ws}/work/config`, { token: tok.reader })).status).toBe(403);

      // the workspace stops offering summaries: the config says so under a new version, and none is leased
      const remote = fin.config.server.remote!;
      fin.config.server.remote = { ...remote, offer: { summarize: false } };
      try {
        const off = await (await req(`${ws}/work/config`, { token: tok.labeler })).json() as Config;
        expect(off.kinds.summarize).toBe(false);
        expect(off.version).not.toBe(config.version);
        const lease = await req(`${ws}/work/lease`, { method: 'POST', token: tok.labeler, body: JSON.stringify({ worker: 'mac-1', backend: 'codex', kinds: ['summarize'] }) });
        expect(await lease.json()).toEqual({ configVersion: off.version, leaseSeconds: 900, tasks: [] });
      } finally {
        fin.config.server.remote = remote;
      }
    });

    it('leases summaries, takes them back and writes the pages', async () => {
      // a token narrowed to extraction asks for summaries in vain
      const narrow = await req(`${ws}/work/lease`, { method: 'POST', token: tok.extractor, body: JSON.stringify({ worker: 'x', backend: 'codex', kinds: ['summarize'] }) });
      expect(((await narrow.json()) as { tasks: Task[] }).tasks).toEqual([]);

      const lease = await req(`${ws}/work/lease`, { method: 'POST', token: tok.labeler, body: JSON.stringify({ worker: 'mac-1', backend: 'codex', kinds: ['summarize'], max: 4 }) });
      const { tasks } = await lease.json() as { tasks: Task[] };
      expect(tasks.map((t) => t.label).sort()).toEqual(['raw/docs/a.md', 'raw/docs/b.md']);
      for (const t of tasks) {
        expect(t).toMatchObject({ kind: 'summarize', json: false });
        expect(t.prompt).toContain(`Source file: ${t.label}`);
        const done = await req(`${ws}/work/complete`, {
          method: 'POST', token: tok.labeler,
          body: JSON.stringify({ worker: 'mac-1', backend: 'codex', id: t.id, ok: true, text: `# 摘要\n\n${t.label} 的摘要。`, model: 'codex:gpt-test' }),
        });
        expect(await done.json()).toEqual({ accepted: true });
      }
      await until(async () => (await summaryPages(fin)).size === 2, 10_000, 'the summary pages');
      expect(readSourceSummary(fin.dataDir, 'raw/docs/a.md')).toMatchObject({ model: 'remote:codex:gpt-test' });

      const status = await (await req(`${ws}/work/status`, { token: tok.labeler })).json() as {
        kinds: { summarize: { totals: { ok: number; pagesWritten: number } } };
        workers: { worker: string; kinds: string[] }[];
      };
      expect(status.kinds.summarize.totals).toMatchObject({ ok: 2, pagesWritten: 2 });
      expect(status.workers.find((w) => w.worker === 'labeler/mac-1')).toMatchObject({ kinds: ['summarize'] });
      expect((await req(`${ws}/work/status`, { token: tok.reader })).status).toBe(200);
    });
  });

  describe('embed work over HTTP', () => {
    const vws = '/remote/v1/w/admin/vectors';
    type EmbedConfig = { version: string; kinds: Record<string, boolean>; leaseSeconds: { llm: number; embed?: number }; embedding?: Record<string, unknown> & { probe: { texts: string[]; minCosine: number } } };

    it('tells an embed token the vector space, the batches and the probe set — and an LLM token none of it', async () => {
      const config = await (await req(`${vws}/work/config`, { token: tok.embedder })).json() as EmbedConfig;
      expect(config.kinds).toEqual({ extract: false, summarize: false, judge: false, translate: false, embed: true, session: false });
      expect(config.leaseSeconds).toEqual({ llm: 900, embed: 120 });
      expect(config.embedding).toMatchObject({
        vectorModel: 'pool:bge-m3:1024:l2-v1', model: 'bge-m3', dimensions: 1024, batchSize: 4, inputChars: 8000, postprocess: 'l2', ownEndpoints: true,
      });
      expect(config.embedding!.probe).toEqual({ texts: [...PROBE_TEXTS], minCosine: 0.98 });
      // nothing about keys: lending is not this token's
      expect(JSON.stringify(config)).not.toContain('sk-pool');
      expect(config.embedding).not.toHaveProperty('credentials');
      // the embed token reaches nothing else here
      expect((await req(`${vws}/documents`, { token: tok.embedder })).status).toBe(403);
      expect((await req(`${vws}/labeling/lease`, { method: 'POST', token: tok.embedder, body: '{}' })).status).toBe(403);
      const extract = await req(`${vws}/work/lease`, { method: 'POST', token: tok.embedder, body: JSON.stringify({ worker: 'x', backend: 'codex', kinds: ['extract'] }) });
      expect(((await extract.json()) as { tasks: unknown[] }).tasks).toEqual([]);
      expect((await req(`${vws}/work/status`, { token: tok.embedder })).status).toBe(200);
      // a worker that names no kinds is an LLM slot from before embed work: it gets no batch
      const unnamed = await req(`${vws}/work/lease`, { method: 'POST', token: tok.both, body: JSON.stringify({ worker: 'old', backend: 'codex' }) });
      expect(((await unnamed.json()) as { tasks: { kind: string }[] }).tasks.every((t) => t.kind !== 'embed')).toBe(true);
      // a token without the embed scope: no embedding section
      expect((await (await req(`${ws}/work/config`, { token: tok.labeler })).json() as EmbedConfig).embedding).toBeUndefined();
    });

    it('turns away an embed slot that has not passed calibration', async () => {
      const lease = await req(`${vws}/work/lease`, { method: 'POST', token: tok.embedder, body: JSON.stringify({ worker: 'raw/embed#1', backend: 'embed', kinds: ['embed'] }) });
      expect(await lease.json()).toMatchObject({ tasks: [], leaseSeconds: 120, embed: { calibrate: true, reason: expect.stringMatching(/not calibrated/) } });
      // and it does not count as a worker taking embed work, so the audits keep embedding directly
      expect(brokers.get(vec.dataDir)!.askedLately('embed', 60_000)).toBe(false);
      const bad = await req(`${vws}/work/calibrate`, { method: 'POST', token: tok.embedder, body: JSON.stringify({ worker: 'raw', model: 'BAAI/bge-m3', vectors: 'AAAA', dimensions: 1024 }) });
      expect(bad.status).toBe(400);
      expect((await req(`${vws}/work/calibrate`, { method: 'POST', token: tok.labeler, body: '{}' })).status).toBe(403);
    });
  });

  describe('knowledge', () => {
    it('lists and reads documents, and nothing outside the knowledge', async () => {
      const list = await (await req(`${ws}/documents?prefix=raw/docs`, { token: tok.reader })).json() as { documents: { path: string }[] };
      expect(list.documents.map((d) => d.path)).toEqual(['raw/docs/a.md', 'raw/docs/b.md']);
      const doc = await (await req(`${ws}/document?path=raw/docs/a.md`, { token: tok.reader })).json() as { content: string };
      expect(doc.content).toContain('宁德时代');
      for (const p of ['knode.config.json', '.knode/mcp-token', 'raw/traces/claude/s.jsonl', 'ledger/events.jsonl', '../../knode.config.json', 'raw/docs/../../knode.config.json', '.sidecar/raw/docs/a.md/meta.json']) {
        const r = await req(`${ws}/document?path=${encodeURIComponent(p)}`, { token: tok.reader });
        expect(r.status, p).toBe(403);
      }
    });

    it('writes and deletes documents through a sync, and refuses anything but knowledge roots', async () => {
      const put = await req(`${ws}/document?path=raw/docs/remote/note.md`, { method: 'PUT', token: tok.writer, body: JSON.stringify({ content: '# 远程笔记\n\n宁德时代与特斯拉签订长期供货协议。\n' }) });
      expect(await put.json()).toMatchObject({ ok: true, indexed: 1 });
      const found = await (await req(`${ws}/search?q=${encodeURIComponent('长期供货协议')}&mode=keyword`, { token: tok.reader })).json() as { results?: { path: string }[] } | { path: string }[];
      expect(JSON.stringify(found)).toContain('raw/docs/remote/note.md');
      for (const p of ['knode.config.json', 'ledger/x.md', 'raw/traces/x.md', '.sidecar/x.md']) {
        const r = await req(`${ws}/document?path=${encodeURIComponent(p)}`, { method: 'PUT', token: tok.writer, body: JSON.stringify({ content: 'x' }) });
        expect(r.status, p).toBe(400);
      }
      expect((await req(`${ws}/document?path=raw/docs/remote/note.md`, { method: 'PUT', token: tok.reader, body: JSON.stringify({ content: 'x' }) })).status).toBe(403);
      const del = await req(`${ws}/document?path=raw/docs/remote/note.md`, { method: 'DELETE', token: tok.writer });
      expect(await del.json()).toMatchObject({ ok: true, disposed: 1 });
      expect((await req(`${ws}/document?path=raw/docs/remote/note.md`, { token: tok.reader })).status).toBe(404);
    });

    it('answers read-only SQL over the catalog views, and nothing a query does outlives it', async () => {
      const ok = await (await req(`${ws}/sql`, { method: 'POST', token: tok.reader, body: JSON.stringify({ sql: 'SELECT path FROM v_documents ORDER BY path' }) })).json() as { rows: { path: string }[] };
      expect(ok.rows.map((r) => r.path)).toEqual(expect.arrayContaining(['raw/docs/a.md', 'raw/docs/b.md']));
      for (const sql of ['DELETE FROM documents', 'SELECT * FROM documents', 'SELECT 1; SELECT 2']) {
        expect((await req(`${ws}/sql`, { method: 'POST', token: tok.reader, body: JSON.stringify({ sql }) })).status, sql).toBe(400);
      }
      // a setting changed inside the query is rolled back with it: the next query still finds its views
      await req(`${ws}/sql`, { method: 'POST', token: tok.reader, body: JSON.stringify({ sql: "SELECT set_config('search_path', 'pg_catalog', false) AS s FROM v_documents LIMIT 1" }) });
      const after = await req(`${ws}/sql`, { method: 'POST', token: tok.reader, body: JSON.stringify({ sql: 'SELECT count(*)::int AS n FROM v_documents' }) });
      expect(after.status).toBe(200);
      expect(((await after.json()) as { rows: { n: number }[] }).rows[0].n).toBeGreaterThanOrEqual(2);
    });
  });

  describe('the worker script', () => {
    it('is handed to any token holder, and to nobody else', async () => {
      expect((await req('/remote/v1/worker.mjs')).status).toBe(401);
      const r = await req('/remote/v1/worker.mjs', { public: true, token: tok.labeler });
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('knode-os remote labeling worker');
    });
  });

  describe('settings', () => {
    const headers = { 'x-knode-user': 'admin', 'x-knode-workspace-kind': 'personal', 'x-knode-workspace-id': 'finance', 'x-knode-workspace-name': 'finance' };

    it('save the local worker slots, and refuse a target that does not exist', async () => {
      const ok = await req('/api/config', { method: 'PUT', headers, body: JSON.stringify({ extraction: { summaryConcurrency: 2, workers: [{ use: 'connection-1', slots: 2, effort: 'medium' }] } }) });
      expect(ok.status).toBe(200);
      expect(fin.config.extraction.workers).toEqual([{ use: 'connection-1', slots: 2, effort: 'medium' }]);
      expect(fin.config.extraction.summaryConcurrency).toBe(2);
      const bad = await req('/api/config', { method: 'PUT', headers, body: JSON.stringify({ extraction: { workers: [{ use: 'nobody', slots: 1 }] } }) });
      expect(bad.status).toBe(400);
      expect(fin.config.extraction.workers).toEqual([{ use: 'connection-1', slots: 2, effort: 'medium' }]);
      // and back to the Extract stage's own route
      await req('/api/config', { method: 'PUT', headers, body: JSON.stringify({ extraction: { workers: [] } }) });
      expect(fin.config.extraction.workers).toEqual([]);
      // no summary slots here: remote workers write the summaries
      await req('/api/config', { method: 'PUT', headers, body: JSON.stringify({ extraction: { summaryConcurrency: 0 } }) });
      expect(fin.config.extraction.summaryConcurrency).toBe(0);
    });
  });

  describe('an embedding endpoint of this machine\'s own, in Settings', () => {
    const headers = { 'x-knode-user': 'admin', 'x-knode-workspace-kind': 'personal', 'x-knode-workspace-id': 'vectors', 'x-knode-workspace-name': 'vectors' };

    it('is checked with the probe set, refused unless it passes, and saved with its key redacted', async () => {
      const check = await req('/api/config/embedding-endpoint/check', { method: 'POST', headers, body: JSON.stringify({ baseUrl: `${ownEndpoint.url}/`, model: 'BAAI/bge-m3' }) });
      expect(await check.json()).toMatchObject({ ok: true, vectorModel: 'pool:bge-m3:1024:l2-v1', threshold: 0.98 });
      const failing = await req('/api/config/embedding-endpoint/check', { method: 'POST', headers, body: JSON.stringify({ baseUrl: otherEndpoint.url, model: 'BAAI/bge-m3' }) });
      expect(await failing.json()).toMatchObject({ ok: false, reason: expect.stringMatching(/below 0\.98/) });
      expect((await req('/api/config/embedding-endpoint/check', { method: 'POST', headers, body: JSON.stringify({ baseUrl: 'ftp://x', model: 'm' }) })).status).toBe(400);

      // saving an endpoint that fails calibration is refused, and nothing changes
      const refused = await req('/api/config', { method: 'PUT', headers, body: JSON.stringify({ ingest: { embedEndpoint: { baseUrl: otherEndpoint.url, model: 'BAAI/bge-m3' } } }) });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toMatch(/did not pass calibration: probe \d+ reached cosine/);
      expect(vec.config.ingest.embedEndpoint).toBeUndefined();

      const saved = await req('/api/config', { method: 'PUT', headers, body: JSON.stringify({ ingest: { embedding: 'deferred', embedSlots: 2, embedEndpoint: { baseUrl: ownEndpoint.url, model: 'BAAI/bge-m3', apiKey: 'sk-local' } } }) });
      expect(saved.status).toBe(200);
      expect(vec.config.ingest).toMatchObject({ embedding: 'deferred', embedSlots: 2, embedEndpoint: { baseUrl: ownEndpoint.url, model: 'BAAI/bge-m3', apiKey: 'sk-local' } });
      const shown = await (await req('/api/config', { headers })).json() as { ingest: { embedEndpoint: { apiKey: string } } };
      expect(shown.ingest.embedEndpoint.apiKey).toBe('***');
      // '***' keeps the key; an unchanged endpoint is not checked again
      const calls = ownEndpoint.calls.length;
      await req('/api/config', { method: 'PUT', headers, body: JSON.stringify({ ingest: { embedEndpoint: { baseUrl: ownEndpoint.url, model: 'BAAI/bge-m3', apiKey: '***' } } }) });
      expect(vec.config.ingest.embedEndpoint?.apiKey).toBe('sk-local');
      expect(ownEndpoint.calls.length).toBe(calls);
      expect((await req('/api/config', { method: 'PUT', headers, body: JSON.stringify({ ingest: { embedding: 'sideways' } }) })).status).toBe(400);
      // and null removes it; the workspace keeps embedding without serve's slots here
      await req('/api/config', { method: 'PUT', headers, body: JSON.stringify({ ingest: { embedSlots: 0, embedEndpoint: null } }) });
      expect(vec.config.ingest.embedEndpoint).toBeUndefined();
      expect(vec.config.ingest.embedSlots).toBe(0);
    });
  });

  describe('a remote worker', () => {
    it('drains the queue over HTTP with its own model, and writes the summaries after it', async () => {
      write(fin.dataDir, 'raw/docs/c.md', '# 丙\n\n远程工作者处理的文档。\n');
      write(fin.dataDir, 'raw/docs/d.md', '# 丁\n\n另一份。\n');
      await sync(fin, { only: ['raw/docs/c.md', 'raw/docs/d.md'] });
      const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      const port = (server.address() as AddressInfo).port;
      try {
        const worker = spawn(process.execPath, [
          path.resolve('worker/knode-worker.mjs'),
          '--server', `http://127.0.0.1:${port}`, '--workspace', 'admin/finance', '--name', 'test-box',
          '--backends', 'api:2', '--api-base-url', fake.url, '--api-model', 'fake-model', '--once', '--idle-ms', '150',
        ], { env: { ...process.env, KNODE_TOKEN: tok.labeler, OPENAI_API_KEY: 'sk-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        worker.stdout.on('data', (d) => (output += d));
        worker.stderr.on('data', (d) => (output += d));
        const code = await new Promise<number | null>((resolve) => worker.on('close', resolve));
        expect(code, output).toBe(0);
        // nothing but --server, --workspace and its backend: the kinds came from the server
        expect(output).toContain('offers extract, summarize; this worker takes extract, summarize');
        expect(output).toContain('document written');
        expect(output).toContain('summary of raw/docs/c.md done');
        expect(output).toContain('summary of raw/docs/d.md done');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      for (const p of ['raw/docs/c.md', 'raw/docs/d.md']) {
        expect(readSidecarPart(fin.dataDir, p, 'tier1')).toMatchObject({ status: 'done', model: 'remote:api:fake-model' });
        expect(readSourceSummary(fin.dataDir, p)).toMatchObject({ model: 'remote:api:fake-model', body: `# 摘要\n\n${p} 的摘要。` });
      }
      const [{ n }] = await fin.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM extraction_queue`);
      expect(n).toBe(0);
      await until(async () => {
        const pages = await summaryPages(fin);
        return pages.has('raw/docs/c.md') && pages.has('raw/docs/d.md');
      }, 10_000, 'the summary pages');
      // a summary is Markdown: the worker did not ask its endpoint for JSON mode
      const summaryCalls = fake.calls.filter((call) => textOf(call.messages?.[0]?.content).includes('Summarize the document'));
      expect(summaryCalls.length).toBe(2);
      for (const call of summaryCalls) expect(call).not.toHaveProperty('response_format');
      // the worker sent back what its endpoint counted, and the server measured each answer (docs/design/18)
      const measured = ledgers.get(fin.dataDir)!.route('extract', 'api:fake-model')!;
      expect(measured).toMatchObject({ remote: true, failed: 0 });
      expect(measured.measured.calls).toBe(measured.ok);
      expect(measured.measured.input / measured.measured.calls).toBe(20);
      expect(measured.bytes.calls).toBe(measured.ok);
    });

    it('answers the judge calls a review waits on, where the workspace offers them', async () => {
      const judges = judgeSources.get(fin.dataDir)!;
      const remote = fin.config.server.remote!;
      fin.config.server.remote = { ...remote, offer: { ...remote.offer, judge: true } };
      const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      try {
        const answers = judges.run([{
          label: '宁德时代 / 宁德时代新能源',
          messages: [
            { role: 'system', content: 'You decide whether two entities in a knowledge graph denote the same real-world thing.' },
            { role: 'user', content: 'Entity A: 宁德时代 (organization)\n\nEntity B: 宁德时代新能源 (organization)' },
          ],
          maxTokens: 300,
        }]);
        const port = (server.address() as AddressInfo).port;
        const worker = spawn(process.execPath, [
          path.resolve('worker/knode-worker.mjs'),
          '--server', `http://127.0.0.1:${port}`, '--workspace', 'admin/finance', '--name', 'judge-box',
          '--backends', 'api:1', '--api-base-url', fake.url, '--api-model', 'fake-model', '--kinds', 'judge', '--once', '--idle-ms', '150',
        ], { env: { ...process.env, KNODE_TOKEN: tok.labeler, OPENAI_API_KEY: 'sk-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        worker.stdout.on('data', (d) => (output += d));
        worker.stderr.on('data', (d) => (output += d));
        const code = await new Promise<number | null>((resolve) => worker.on('close', resolve));
        expect(code, output).toBe(0);
        expect(output).toContain('this worker takes judge');
        expect(output).toContain('judge call on 宁德时代 / 宁德时代新能源 done');
        const [answer] = await answers;
        expect(answer).toMatchObject({ ok: true, model: 'remote:api:fake-model' });
        // a judge call wants a JSON object: the worker asked its endpoint for JSON mode
        const judgeCall = fake.calls.filter((c) => textOf(c.messages?.[0]?.content).includes('denote the same real-world thing')).at(-1);
        expect(judgeCall).toHaveProperty('response_format');
      } finally {
        fin.config.server.remote = remote;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('embeds the backlog on its own endpoint once it passes calibration, and its vectors land', async () => {
      const before = await pendingEmbeddings(vec.store, vec.embedder.model);
      expect(before).toBeGreaterThan(9);
      // the probe reference is made at most once (Settings may have made it already)
      const poolBefore = poolEndpoint.texts();
      expect(poolBefore).toBeLessThanOrEqual(PROBE_TEXTS.length);
      const ownBefore = ownEndpoint.texts();
      const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      try {
        const port = (server.address() as AddressInfo).port;
        const worker = spawn(process.execPath, [
          path.resolve('worker/knode-worker.mjs'),
          '--server', `http://127.0.0.1:${port}`, '--workspace', 'admin/vectors', '--name', 'gpu-box',
          '--backends', 'embed:2', '--embed-base-url', ownEndpoint.url, '--embed-model', 'BAAI/bge-m3', '--once', '--idle-ms', '150',
        ], { env: { ...process.env, KNODE_TOKEN: tok.embedder }, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        worker.stdout.on('data', (d) => (output += d));
        worker.stderr.on('data', (d) => (output += d));
        const killer = setTimeout(() => worker.kill('SIGKILL'), 30_000);
        const code = await new Promise<number | null>((resolve) => worker.on('close', resolve));
        clearTimeout(killer);
        expect(code, output).toBe(0);
        expect(output).toContain('this worker takes embed');
        expect(output).toMatch(/BAAI\/bge-m3 passed calibration for pool:bge-m3:1024:l2-v1 \(cosine ≥ 0\.99/);
        expect(output).toMatch(/embedded in [\d.]+s — \d vectors written/);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      expect(await pendingEmbeddings(vec.store, vec.embedder.model)).toBe(0);
      // every vector the worker made, finished here: unit length, in the pool's space
      const rows = await vec.store.query<{ model: string; embedding: string }>(`SELECT model, embedding::text AS embedding FROM embeddings`);
      expect(rows.length).toBe(before);
      for (const r of rows) {
        expect(r.model).toBe('pool:bge-m3:1024:l2-v1');
        expect(Math.hypot(...(JSON.parse(r.embedding) as number[]))).toBeCloseTo(1, 2);
      }
      // the pool made only the probe reference; the chunks were embedded on the worker's endpoint
      expect(poolEndpoint.texts()).toBe(PROBE_TEXTS.length);
      expect(ownEndpoint.texts() - ownBefore).toBeGreaterThanOrEqual(before + PROBE_TEXTS.length);
      // the worker's request is the pool's: the same fields, no dimensions, no upstream pin
      const poolCall = poolEndpoint.calls[0];
      for (const c of ownEndpoint.calls) {
        expect(Object.keys(c).sort()).toEqual(Object.keys(poolCall).sort());
        expect(c).toMatchObject({ model: 'BAAI/bge-m3', encoding_format: 'float' });
      }
      const status = await embedSources.get(vec.dataDir)!.status();
      expect(status.totals).toMatchObject({ written: before, spotMisses: 0 });
      expect(status.totals.spotChecks).toBeGreaterThan(0);
      expect(status.endpoints).toEqual([expect.objectContaining({ worker: 'embedder/gpu-box', model: 'BAAI/bge-m3', vectors: before })]);
      expect(status.endpoints[0].usageTokens).toBeGreaterThan(0);
    });

    it('is refused on an endpoint that serves another model, by its vectors or by its name', async () => {
      write(vec.dataDir, 'raw/docs/late.md', '# 迟到\n\n校准之后才写下的文档。\n');
      await sync(vec, { only: ['raw/docs/late.md'] });
      const pending = await pendingEmbeddings(vec.store, vec.embedder.model);
      expect(pending).toBeGreaterThan(0);
      const otherBefore = otherEndpoint.texts();
      const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      const run = async (name: string, url: string, model: string) => {
        const port = (server.address() as AddressInfo).port;
        const worker = spawn(process.execPath, [
          path.resolve('worker/knode-worker.mjs'),
          '--server', `http://127.0.0.1:${port}`, '--workspace', 'admin/vectors', '--name', name,
          '--backends', 'embed:1', '--embed-base-url', url, '--embed-model', model, '--once', '--idle-ms', '150',
        ], { env: { ...process.env, KNODE_TOKEN: tok.embedder }, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        worker.stdout.on('data', (d) => (output += d));
        worker.stderr.on('data', (d) => (output += d));
        const killer = setTimeout(() => worker.kill('SIGKILL'), 30_000);
        const code = await new Promise<number | null>((resolve) => worker.on('close', resolve));
        clearTimeout(killer);
        return { code, output };
      };
      try {
        const vectors = await run('impostor', otherEndpoint.url, 'BAAI/bge-m3');
        expect(vectors.code, vectors.output).toBe(0);
        expect(vectors.output).toMatch(/the server refused BAAI\/bge-m3 at .*: probe \d+ reached cosine -?0\.\d+, below 0\.98/);
        expect(vectors.output).not.toContain('embedded in');
        const named = await run('renamed', ownEndpoint.url, 'nomic-embed-text');
        expect(named.code, named.output).toBe(0);
        expect(named.output).toContain('the endpoint serves nomic-embed-text, not bge-m3');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      // nothing either of them made was written
      expect(await pendingEmbeddings(vec.store, vec.embedder.model)).toBe(pending);
      expect(otherEndpoint.texts() - otherBefore).toBe(PROBE_TEXTS.length);
    });

    it('shows the embedding identity and the calibration in --check', async () => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      try {
        const port = (server.address() as AddressInfo).port;
        const worker = spawn(process.execPath, [
          path.resolve('worker/knode-worker.mjs'), '--server', `http://127.0.0.1:${port}`, '--workspace', 'admin/vectors',
          '--backends', 'embed:1', '--embed-base-url', ownEndpoint.url, '--embed-model', 'BAAI/bge-m3', '--check',
        ], { env: { ...process.env, KNODE_TOKEN: tok.embedder }, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        worker.stdout.on('data', (d) => (output += d));
        worker.stderr.on('data', (d) => (output += d));
        const code = await new Promise<number | null>((resolve) => worker.on('close', resolve));
        expect(code, output).toBe(0);
        expect(output).toContain('scopes embed');
        expect(output).toContain('embed: vectors as pool:bge-m3:1024:l2-v1 (1024 dimensions, batches of 4); own endpoints taken');
        expect(output).toMatch(/embedding: \d+ chunks without a vector/);
        expect(output).toContain(`backend embed × 1: ${ownEndpoint.url} (BAAI/bge-m3) — calibrated`);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('falls back to extraction over labeling/* on a server from before work/*', async () => {
      const old = new Hono();
      old.get('/remote/v1/whoami', (c) => c.json({ id: '0123456789ab', name: 'old', scopes: ['label'], workspaces: ['admin/finance'] }));
      old.get('/remote/v1/w/admin/finance/labeling/status', (c) => c.json({ queued: 7, leases: [], workers: [] }));
      old.all('*', (c) => c.json({ error: 'not found' }, 404));
      const server = serve({ fetch: old.fetch, port: 0, hostname: '127.0.0.1' });
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      try {
        const port = (server.address() as AddressInfo).port;
        const worker = spawn(process.execPath, [path.resolve('worker/knode-worker.mjs'), '--server', `http://127.0.0.1:${port}`, '--workspace', 'admin/finance', '--backends', 'api:1', '--check'], {
          env: { ...process.env, KNODE_TOKEN: tok.labeler }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        worker.stdout.on('data', (d) => (output += d));
        worker.stderr.on('data', (d) => (output += d));
        const code = await new Promise<number | null>((resolve) => worker.on('close', resolve));
        expect(code, output).toBe(0);
        expect(output).toContain('a server from before work/* — extraction only');
        expect(output).toContain('7 documents queued');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('refuses to send its token in the clear to another machine', async () => {
      const worker = spawn(process.execPath, [path.resolve('worker/knode-worker.mjs'), '--server', 'http://198.51.100.1:12000', '--workspace', 'admin/finance', '--check'], {
        env: { ...process.env, KNODE_TOKEN: tok.labeler }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      worker.stderr.on('data', (d) => (output += d));
      const code = await new Promise<number | null>((resolve) => worker.on('close', resolve));
      expect(code).not.toBe(0);
      expect(output).toContain('plain http');
    });
  });
});
