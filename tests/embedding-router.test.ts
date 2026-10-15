import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingConnection, defaultConfig, embeddingIdentity, syncActiveEmbedding } from '../src/config.js';
import { DEFAULT_EMBEDDING_LIMITS, EmbeddingQuotaLedger, PooledEmbeddingProvider, poolMembers, retryAfterMs } from '../src/ingest/embedding-router.js';
import { listEmbeddingModels } from '../src/llm/models.js';

const dirs: string[] = [];
const ledgerFile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-embedding-test-'));
  dirs.push(dir); return path.join(dir, 'usage.json');
};
const entry = (id: string, overrides: Partial<EmbeddingConnection> = {}): EmbeddingConnection => ({
  id, label: id, provider: 'openai', baseUrl: `https://${id}.example/v1`, apiKey: `secret-${id}`,
  model: 'test-embedding', dimensions: 2, batchSize: 16, sendDimensions: false,
  limits: { ...DEFAULT_EMBEDDING_LIMITS }, ...overrides,
});
const pool = { enabled: true, model: 'test-embedding', dimensions: 2, batchSize: 16 };
const good = () => Response.json({ data: [{ index: 0, embedding: [3, 4] }], usage: { prompt_tokens: 2 } });
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('model pool identity and eligibility', () => {
  it('maps only exact BGE-M3 aliases and a 1024-d pool', () => {
    const entries = [entry('sf', { model: 'BAAI/bge-m3' }), entry('cf', { model: '@cf/baai/bge-m3' }),
      entry('or', { model: 'baai/bge-m3', enabled: false }), entry('rerank', { model: 'BAAI/bge-reranker-v2-m3' })];
    expect(poolMembers(entries, { ...pool, model: 'bge-m3', dimensions: 1024 }).map((e) => e.id)).toEqual(['sf', 'cf']);
    expect(poolMembers(entries, { ...pool, model: 'bge-m3' })).toEqual([]);
    expect(poolMembers([entry('x', { dimensions: 3 })], pool)).toEqual([]);
  });
  it('does not re-embed when pool keys or limits change, but does for the vector space', () => {
    const config = defaultConfig(); config.embeddingProviders = [entry('a')]; config.embeddingPool = pool;
    syncActiveEmbedding(config); const before = embeddingIdentity(config.embedding);
    config.embeddingProviders = [entry('b')]; syncActiveEmbedding(config);
    expect(embeddingIdentity(config.embedding)).toBe(before);
    config.embeddingPool = { ...pool, dimensions: 3 }; syncActiveEmbedding(config);
    expect(embeddingIdentity(config.embedding)).not.toBe(before);
    expect(config.embedding.apiKey).toBe('');
  });
});

describe('persistent quota reservations', () => {
  it('identifies a shared Cloudflare account even when its keys have different group labels', async () => {
    const ledger = new EmbeddingQuotaLedger(ledgerFile());
    const entries = ['a', 'b'].map((id) => entry(id, { baseUrl: 'https://api.cloudflare.com/client/v4/accounts/account-one/ai/v1',
      quotaGroup: id, limits: { ...DEFAULT_EMBEDDING_LIMITS, requestsPerDay: 1 } }));
    const ticket = (await ledger.reserve(entries, 1)).ticket!;
    await ledger.finish(ticket, {});
    expect((await ledger.reserve([entries[1]], 1)).ticket).toBeUndefined();
  });
  it('atomically shares account caps between keys and ledger instances; failed attempts remain counted', async () => {
    const file = ledgerFile();
    const entries = ['a', 'b'].map((id) => entry(id, { quotaGroup: 'one-account', limits: { ...DEFAULT_EMBEDDING_LIMITS, requestsPerDay: 1 } }));
    const results = await Promise.all([new EmbeddingQuotaLedger(file).reserve(entries, 30), new EmbeddingQuotaLedger(file).reserve(entries, 30)]);
    expect(results.filter((r) => r.ticket)).toHaveLength(1);
    const ticket = results.find((r) => r.ticket)!.ticket!;
    await new EmbeddingQuotaLedger(file).finish(ticket, { error: 'HTTP 429', cooldownMs: 10_000 });
    const status = await new EmbeddingQuotaLedger(file).status(entries);
    expect(status.map((s) => s.requestsToday)).toEqual([1, 1]);
    expect(status[0].tokensToday).toBe(30);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('secret-');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
  it('enforces rolling minute, concurrency and token budgets before sending', async () => {
    let now = Date.UTC(2026, 9, 11, 12); const ledger = new EmbeddingQuotaLedger(ledgerFile(), () => now);
    const entries = [entry('a', { limits: { ...DEFAULT_EMBEDDING_LIMITS, concurrency: 1, requestsPerMinute: 1, tokensPerDay: 100 } })];
    const first = (await ledger.reserve(entries, 60)).ticket!;
    expect((await ledger.reserve(entries, 10)).reasons.join()).toContain('concurrency');
    await ledger.finish(first, { tokens: 60 });
    expect((await ledger.reserve(entries, 10)).reasons.join()).toContain('minute');
    now += 60_001;
    expect((await ledger.reserve(entries, 41)).reasons.join()).toContain('daily');
    expect((await ledger.reserve(entries, 40)).ticket).toBeDefined();
  });
  it('resets at configured midnight and reconciles a late response to its original day', async () => {
    let now = Date.UTC(2026, 9, 11, 15, 59, 59); const ledger = new EmbeddingQuotaLedger(ledgerFile(), () => now);
    const entries = [entry('a', { limits: { ...DEFAULT_EMBEDDING_LIMITS, resetTimezone: 'Asia/Shanghai', requestsPerDay: 1 } })];
    const first = (await ledger.reserve(entries, 90)).ticket!;
    now += 2_000; await ledger.finish(first, { tokens: 30 });
    expect((await ledger.status(entries))[0].requestsToday).toBe(0);
    expect((await ledger.reserve(entries, 90)).ticket).toBeDefined();
  });
  it('fails closed on corrupt persistence and rejects inconsistent group timezones', async () => {
    const file = ledgerFile(); fs.writeFileSync(file, 'broken');
    await expect(new EmbeddingQuotaLedger(file).reserve([entry('a')], 1)).rejects.toThrow('unreadable');
    fs.rmSync(file);
    await expect(new EmbeddingQuotaLedger(file).reserve([
      entry('a', { quotaGroup: 'same' }), entry('b', { quotaGroup: 'same', limits: { ...DEFAULT_EMBEDDING_LIMITS, resetTimezone: 'Asia/Shanghai' } }),
    ], 1)).rejects.toThrow('same reset timezone');
  });
});

describe('real request routing contract', () => {
  it('fails over on 429, honors Retry-After, pins the router upstream and L2-normalizes', async () => {
    const ledger = new EmbeddingQuotaLedger(ledgerFile());
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('secret-a must never escape', { status: 429, headers: { 'retry-after': '120' } })).mockResolvedValueOnce(good());
    const embedder = new PooledEmbeddingProvider(pool, [entry('a'), entry('b', { upstream: 'deepinfra/fp32' })], ledger, fetcher, 0);
    expect(await embedder.embed(['test'])).toEqual([[0.6, 0.8]]);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).provider).toEqual({ only: ['deepinfra/fp32'], allow_fallbacks: false });
    const status = await ledger.status([entry('a'), entry('b')]);
    expect(status[0].cooldownUntil).toBeGreaterThan(Date.now() + 110_000);
    expect(status[1].tokensToday).toBe(2);
    expect(JSON.stringify(status)).not.toContain('secret-a');
  });
  it('exhaustion never silently bypasses caps or uses a different vector model', async () => {
    const fetcher = vi.fn();
    const embedder = new PooledEmbeddingProvider(pool, [entry('a', { limits: { ...DEFAULT_EMBEDDING_LIMITS, requestsPerDay: 0 } })], new EmbeddingQuotaLedger(ledgerFile()), fetcher, 0);
    await expect(embedder.embed(['test'])).rejects.toThrow('daily quota');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects malformed vectors and moves to another key', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ data: [{ index: 0, embedding: [0, 0] }] })).mockResolvedValueOnce(good());
    expect(await new PooledEmbeddingProvider(pool, [entry('a'), entry('b')], new EmbeddingQuotaLedger(ledgerFile()), fetcher, 0).embed(['t'])).toEqual([[0.6, 0.8]]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('preserves input order across batches and rotates equal-priority keys', async () => {
    const fetcher = vi.fn().mockImplementation(async (_url, init) => {
      const { input } = JSON.parse(init.body);
      return Response.json({ data: input.map((_t: string, index: number) => ({ index, embedding: [3, 4] })).reverse() });
    });
    const embedder = new PooledEmbeddingProvider({ ...pool, batchSize: 2 }, [entry('a'), entry('b')], new EmbeddingQuotaLedger(ledgerFile()), fetcher, 0);
    expect(await embedder.embed(['one', 'two', 'three'])).toHaveLength(3);
    expect(fetcher.mock.calls.map((c) => c[0])).toEqual(['https://a.example/v1/embeddings', 'https://b.example/v1/embeddings']);
  });
  it('parses date and seconds Retry-After values', () => {
    expect(retryAfterMs('120', 0)).toBe(120_000);
    expect(retryAfterMs('Thu, 01 Jan 1970 00:02:00 GMT', 0)).toBe(120_000);
  });
});

describe('embedding-only provider catalogs', () => {
  it('filters the Cloudflare task catalog, including BGE-M3 but excluding chat and rerankers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ result: [
      { name: '@cf/baai/bge-m3', task: { name: 'Text Embeddings' } },
      { name: '@cf/chat/model', task: { name: 'Text Generation' } },
      { name: '@cf/baai/bge-reranker-base', task: { name: 'Text Classification' } },
    ] })));
    const result = await listEmbeddingModels(entry('cf', { baseUrl: 'https://api.cloudflare.com/client/v4/accounts/test/ai/v1' }));
    expect(result.models).toEqual([{ id: '@cf/baai/bge-m3' }]);
  });
  it('uses the specialized SiliconFlow and OpenRouter endpoints', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ data: [{ id: 'BAAI/bge-m3' }] })); vi.stubGlobal('fetch', fetcher);
    expect((await listEmbeddingModels(entry('sf', { baseUrl: 'https://api.siliconflow.cn/v1' }))).models[0].id).toBe('BAAI/bge-m3');
    expect(fetcher.mock.calls[0][0]).toContain('/models?sub_type=embedding');
    fetcher.mockResolvedValue(Response.json({ data: [{ id: 'baai/bge-m3' }] }));
    await listEmbeddingModels(entry('or', { baseUrl: 'https://openrouter.ai/api/v1' }));
    expect(fetcher.mock.calls[1][0]).toContain('/embeddings/models');
  });
  it('does not drop BGE when the generic catalog also has embed-named models', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: [{ id: 'BAAI/bge-m3' }, { id: 'text-embedding-3-small' }, { id: 'chat-model' }] })));
    expect((await listEmbeddingModels(entry('generic'))).models.map((m) => m.id)).toEqual(['BAAI/bge-m3', 'text-embedding-3-small']);
  });
});
