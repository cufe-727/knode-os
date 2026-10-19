import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingConnection, defaultConfig, embeddingIdentity, syncActiveEmbedding } from '../src/config.js';
import { DEFAULT_EMBEDDING_LIMITS, EmbeddingQuotaLedger, PooledEmbeddingProvider, poolMembers, retryAfterMs } from '../src/ingest/embedding-router.js';
import { estimateEmbeddingTokens } from '../src/ingest/embedding-tokens.js';
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
  it('counts what no provider reported as estimated: no usage and failed attempts do, reported settles do not', async () => {
    const file = ledgerFile(); const ledger = new EmbeddingQuotaLedger(file); const entries = [entry('a')];
    const first = (await ledger.reserve(entries, 30)).ticket!;
    expect((await ledger.status(entries))[0]).toMatchObject({ tokensToday: 30, estimatedTokensToday: 30 });
    await ledger.finish(first, { tokens: 12 });
    expect((await ledger.status(entries))[0]).toMatchObject({ tokensToday: 12, estimatedTokensToday: 0 });
    await ledger.finish((await ledger.reserve(entries, 20)).ticket!, {});
    await ledger.finish((await ledger.reserve(entries, 8)).ticket!, { error: 'HTTP 500' });
    expect((await ledger.status(entries))[0]).toMatchObject({ requestsToday: 3, tokensToday: 40, estimatedTokensToday: 28 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(1);
  });
  it('shows no split for a day recorded before the estimated field existed', async () => {
    const file = ledgerFile(); const ledger = new EmbeddingQuotaLedger(file); const entries = [entry('a')];
    await ledger.finish((await ledger.reserve(entries, 10)).ticket!, { tokens: 7 });
    const before = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const bucket of Object.values<any>(before.buckets)) for (const day of Object.values<any>(bucket.days)) delete day.estimated;
    fs.writeFileSync(file, JSON.stringify(before), { mode: 0o600 });
    await ledger.finish((await ledger.reserve(entries, 5)).ticket!, {});
    const [status] = await ledger.status(entries);
    expect(status).toMatchObject({ requestsToday: 2, tokensToday: 12 });
    expect(status).not.toHaveProperty('estimatedTokensToday');
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
  it('reserves a token estimate, not bytes, and tags what the provider did not report', async () => {
    // Cloudflare answers with vectors only; SiliconFlow and OpenRouter add `usage`.
    const text = '公司第三季度营业收入同比增长12.5%，净利润率较上年同期下降0.8个百分点，主要受原材料价格上涨影响。';
    const ledger = new EmbeddingQuotaLedger(ledgerFile());
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ data: [{ index: 0, embedding: [3, 4] }] })).mockResolvedValueOnce(good());
    const embedder = new PooledEmbeddingProvider(pool, [entry('a')], ledger, fetcher, 0);
    await embedder.embed([text]);
    const estimate = estimateEmbeddingTokens(text);
    expect(estimate).toBeLessThan(Buffer.byteLength(text, 'utf8'));
    expect((await ledger.status([entry('a')]))[0]).toMatchObject({ tokensToday: estimate, estimatedTokensToday: estimate });
    await embedder.embed(['t']);
    expect((await ledger.status([entry('a')]))[0]).toMatchObject({ tokensToday: estimate + 2, estimatedTokensToday: estimate });
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

// Real BGE-M3 counts: pieces plus <s> and </s> from the model's own tokenizer.json (BAAI/bge-m3, SHA-256
// 21106b6d7dab2952c1d496fb21d5dc9db75c28ed361a05f5020bbba27810dd08), which is how SiliconFlow and OpenRouter
// count: both report 56 for the first two strings together.
const zhSentence = '公司第三季度营业收入同比增长12.5%，净利润率较上年同期下降0.8个百分点，主要受原材料价格上涨影响。';
const enSentence = 'Third-quarter revenue grew 12.5% year over year, while net margin fell 0.8 points on higher input costs.';
const samples: [name: string, text: string, real: number][] = [
  ['Chinese sentence with numbers', zhSentence, 29],
  ['English sentence with numbers', enSentence, 27],
  ['Chinese prose', '本公司董事会及全体董事保证本公告内容不存在任何虚假记载、误导性陈述或者重大遗漏，并对其内容的真实性、准确性和完整性承担法律责任。报告期内，公司坚持稳中求进的工作总基调，持续优化产品结构，加大研发投入，积极拓展海外市场，实现了经营业绩的稳步增长。', 79],
  ['digit table', '2021 2022 2023 2024 1,234.56 2,345.67 3,456.78 4,567.89 12.5% 8.3% 9.1% 10.4% 0.82 0.91 1.05 1.12 100 200 300 400 500 600 700 800 900', 51],
  ['dense decimals', '60.2 61.5 59.8 62.1 63.4 64.0 65.2 66.7 67.1 68.3 69.9 70.2 71.4 72.8 73.5 74.1 75.6 76.0 77.3 78.9 79.2 80.4 81.7 82.5 83.1 84.6 85.0 86.2 87.9 88.3', 67],
  ['long numbers and dates', '13800138000 13900139000 123456789012345678 9876543210987654321 2024-10-18 2024-10-19 2024-10-20 20241018 20241019', 45],
  ['markdown table', '| 项目 | 2023年 | 2024年 | 同比 |\n| --- | ---: | ---: | ---: |\n| 营业收入 | 1,234.56 | 1,389.01 | +12.5% |\n| 归母净利润 | 123.45 | 134.56 | +9.0% |\n| 毛利率 | 38.2% | 37.4% | -0.8pp |\n| 经营现金流 | 98.7 | 110.3 | +11.8% |', 132],
  ['Chinese and English mixed', '2024年Q3，NVIDIA 数据中心收入达到 $30.8B，同比增长 112%；EBITDA margin 为 62.1%，高于市场预期的 60.5%。管理层上调了 FY2025 指引。', 53],
  ['English prose', 'The committee reviewed the proposed changes to the retention policy and concluded that, although the new thresholds would reduce storage costs, they would also make it harder to reconstruct older incidents. It recommended a phased rollout with a review after the first quarter.', 61],
  ['code', 'export async function embedBatch(batch: string[], tokens: number): Promise<number[][]> {\n  const excluded = new Set<string>();\n  for (;;) {\n    const selection = await this.ledger.reserve(this.entries, tokens, excluded);\n    if (!selection.ticket) throw new Error(`pool unavailable: ${selection.reasons.join("; ")}`);\n  }\n}', 117],
  ['blank input', ' ', 3],
];
// Scripts the estimate has no class for: it may over-count them, never under-count.
const otherScripts: [name: string, text: string, real: number][] = [
  ['Japanese', '四半期の売上高は前年同期比12.5%増加し、純利益率は0.8ポイント低下しました。主な要因は原材料価格の上昇です。取締役会は、来期も引き続き研究開発への投資を拡大する方針を確認しました。', 61],
  ['Korean', '3분기 매출은 전년 동기 대비 12.5% 증가했으나, 순이익률은 원자재 가격 상승의 영향으로 0.8%포인트 하락했습니다. 이사회는 내년에도 연구개발 투자를 확대하기로 했습니다.', 50],
  ['Russian', 'Выручка за третий квартал выросла на 12,5% по сравнению с аналогичным периодом прошлого года, а рентабельность по чистой прибыли снизилась на 0,8 процентного пункта из-за роста цен на сырьё. Совет директоров подтвердил план увеличения инвестиций в исследования.', 60],
  ['Thai', 'รายได้ในไตรมาสที่สามเพิ่มขึ้น 12.5% เมื่อเทียบกับปีก่อน ขณะที่อัตรากำไรสุทธิลดลง 0.8 จุดเนื่องจากราคาวัตถุดิบที่สูงขึ้น คณะกรรมการยืนยันแผนการเพิ่มการลงทุนด้านการวิจัย', 41],
];

describe('embedding token estimate', () => {
  it('is above the real count on the pair the providers report as 56, and not the byte estimate', () => {
    const zh = estimateEmbeddingTokens(zhSentence), en = estimateEmbeddingTokens(enSentence);
    expect(zh).toBeGreaterThanOrEqual(29);
    expect(en).toBeGreaterThanOrEqual(27);
    // bytes + 32 per input gave 172 and 136 here.
    expect(zh + en).toBeLessThan(2 * 56);
  });
  it('never falls below the real count on digit-heavy, Chinese, mixed and other-script samples', () => {
    for (const [name, text, real] of [...samples, ...otherScripts]) expect(estimateEmbeddingTokens(text), name).toBeGreaterThanOrEqual(real);
  });
  it('stays near real tokens on the text the pool embeds', () => {
    const real = samples.reduce((n, [, , r]) => n + r, 0);
    const estimate = samples.reduce((n, [, text]) => n + estimateEmbeddingTokens(text), 0);
    const bytes = samples.reduce((n, [, text]) => n + Buffer.byteLength(text, 'utf8') + 32, 0);
    expect(estimate / real).toBeGreaterThan(1);
    expect(estimate / real).toBeLessThan(1.5);
    expect(bytes / real).toBeGreaterThan(3);
  });
  it('is never below a quarter token per UTF-8 byte', () => {
    expect(estimateEmbeddingTokens('\u3000'.repeat(100))).toBe(75);
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
