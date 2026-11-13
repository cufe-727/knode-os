import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, defaultRoutedLlmConfig, LlmConnection } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { readSourceSummaryFailure } from '../src/fs/sidecar.js';
import { auditDuplicateEntities, mergeSuggestionId } from '../src/graph/dedupe.js';
import { runDocumentPass } from '../src/ingest/background.js';
import { sync } from '../src/ingest/sync.js';
import { LlmClient } from '../src/llm/client.js';
import { ensureDefaultAgents } from '../src/research/agents.js';
import { listSuggestions } from '../src/store/queries.js';
import { ensureSourceSummaries } from '../src/wiki/pages.js';
import { refineWiki } from '../src/wiki/refine.js';
import { startFakeOpenAi, type ChatRequest, type FakeOpenAi } from './helpers/fake-openai.js';

/**
 * The background document pass (docs/design/09): extraction, then the
 * duplicate audit over the entities it wrote, then summary pages — and the
 * nightly pass that no longer writes concept-cluster pages.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-document-pass-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (p as { text?: string })?.text ?? '').join('') : '';

/** Each stage's prompt, answered the way that stage expects. */
function answer(request: ChatRequest): string {
  const system = textOf(request.messages?.find((m) => m.role === 'system')?.content);
  const user = textOf(request.messages?.filter((m) => m.role === 'user').at(-1)?.content);
  if (system.includes('Summarize the document into a wiki source page')) {
    const source = /Source file: (\S+)/.exec(user)?.[1] ?? '?';
    return `Summary of ${source}.\n\n## Key points\n\n- 出货量增长\n\n## Entities\n\n- [[宁德时代]]`;
  }
  if (system.includes('denote the same real-world thing')) {
    return JSON.stringify({ same: true, confidence: 0.97, reason: '同一家公司的简称与全称' });
  }
  const extracted = (name: string) => ({ entities: [{ name, type: 'organization', description: '动力电池厂商', aliases: [] }], relations: [], claims: [] });
  const of = (text: string) =>
    text.includes('(raw/docs/a.md)') ? extracted('宁德时代新能源科技股份有限公司') : text.includes('(raw/docs/b.md)') ? extracted('宁德时代') : { entities: [], relations: [], claims: [] };
  // short documents go several to a call (docs/design/29 §6), each under its own header
  const batch = user.split(/^(?==== Document \d+: )/m).filter((part) => part.startsWith('=== Document'));
  if (batch.length > 0) return JSON.stringify({ documents: batch.map((part, i) => ({ doc: i + 1, ...of(part.split('\n')[0]) })) });
  return JSON.stringify(of(user));
}

const kindOf = (request: ChatRequest) => {
  const system = textOf(request.messages?.find((m) => m.role === 'system')?.content);
  if (system.includes('Summarize the document')) return 'summary';
  if (system.includes('denote the same real-world thing')) return 'judge';
  return 'extract';
};

describe('the background document pass', () => {
  const dataDir = path.join(tmp, 'pass');
  let fake: FakeOpenAi;
  let ctx: AppContext;

  beforeAll(async () => {
    fake = await startFakeOpenAi({ answer });
    const model: LlmConnection = {
      id: 'connection-1', label: 'fake', provider: 'openai', baseUrl: fake.url, apiKey: 'sk-test',
      // pinned, so a call goes straight to /chat/completions instead of probing /responses
      protocol: 'chat', model: 'fake-model', cliPath: '', effort: 'default', cliTimeoutMs: 30_000,
    };
    const base = defaultConfig();
    const route = { ...defaultRoutedLlmConfig(), use: 'connection-1' };
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'knode.config.json'), JSON.stringify({
      ...base,
      connections: [model],
      llmUse: 'connection-1',
      // the documents here are a line each: no size threshold, or none would get a summary
      extraction: { ...base.extraction, entityLlm: route, documentLlm: route, summaryLlm: route, judgeLlm: route, summaryMinChars: 0 },
      review: { ...base.review, llmJudge: 'auto' },
    }));
    ensureDefaultAgents(dataDir);
    // one title for both, so the second summary has to find a path of its own
    write(dataDir, 'raw/docs/a.md', '---\ntitle: 季度报告\n---\n# 季度报告\n\n电池出货量同比增长。\n');
    write(dataDir, 'raw/docs/b.md', '---\ntitle: 季度报告\n---\n# 季度报告\n\n储能业务继续扩张。\n');
    ctx = await createContext(dataDir);
    await sync(ctx, {});
  });

  afterAll(async () => {
    await ctx?.datasources.closeAll();
    await ctx?.store.close();
    await fake?.close();
  });

  it('extracts, resolves what it extracted and summarizes — in that order, in one pass', async () => {
    const before = fake.calls.length;
    const pass = await runDocumentPass(ctx);

    expect(pass.processed).toBe(2);
    expect([...pass.documents].sort()).toEqual(['raw/docs/a.md', 'raw/docs/b.md']);
    expect([...pass.touched].sort()).toEqual(['宁德时代', '宁德时代新能源科技股份有限公司']);

    // the two spellings met minutes after arriving, not at night: judged the
    // same and merged, reversibly, because review.llmJudge is auto
    expect(pass.resolve).toMatchObject({ judged: 1, autoMerged: 1 });
    const merged = await ctx.store.query<{ id: string; canonical_id: string | null }>(
      `SELECT id, canonical_id FROM entities WHERE id IN ('宁德时代', '宁德时代新能源科技股份有限公司') AND tx_to IS NULL ORDER BY id`,
    );
    expect(merged.filter((e) => e.canonical_id).length).toBe(1);
    const suggestion = (await listSuggestions(ctx.store, {})).find((s) => s.id === mergeSuggestionId('宁德时代', '宁德时代新能源科技股份有限公司'));
    expect(suggestion?.status).toBe('accepted');

    // every document gets a summary page, written on the Summarize route
    expect(pass.summaries).toHaveLength(2);
    const pages = pass.summaries.map((p) => fs.readFileSync(path.join(dataDir, p), 'utf8'));
    expect(pages.some((text) => text.includes('Summary of raw/docs/a.md.'))).toBe(true);
    expect(pages.some((text) => text.includes('Summary of raw/docs/b.md.'))).toBe(true);
    // one title, two documents: the second takes a path of its own instead of going without
    expect(pass.summaries).toContain('wiki/sources/季度报告.md');
    expect(pass.summaries.find((p) => p !== 'wiki/sources/季度报告.md')).toMatch(/^wiki\/sources\/季度报告-[0-9a-f]{6}\.md$/);

    const kinds = fake.calls.slice(before).map(kindOf);
    // the two one-line documents are read in one batched call
    expect(kinds.filter((k) => k === 'extract')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'judge')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'summary')).toHaveLength(2);
    // resolve runs on what extraction wrote, summaries come last
    expect(kinds.lastIndexOf('extract')).toBeLessThan(kinds.indexOf('judge'));
    expect(kinds.indexOf('judge')).toBeLessThan(kinds.indexOf('summary'));
  });

  it('has nothing to do once every document is extracted and summarized', async () => {
    const before = fake.calls.length;
    const pass = await runDocumentPass(ctx);
    expect(pass).toMatchObject({ processed: 0, summaries: [], resolve: null });
    expect(fake.calls.length).toBe(before);
  });

  it('re-summarizes a document whose content changed, at the path it already had', async () => {
    const [{ path: pagePath }] = await ctx.store.query<{ path: string }>(
      `SELECT p.path FROM pages p JOIN deps d ON d.artifact_kind = 'page' AND d.artifact_id = p.path AND d.input_kind = 'document'
       WHERE p.kind = 'source_summary' AND d.input_id = 'raw/docs/b.md'`,
    );
    write(dataDir, 'raw/docs/b.md', '---\ntitle: 季度报告\n---\n# 季度报告\n\n储能业务继续扩张，海外订单翻倍。\n');
    await sync(ctx, {});
    const pass = await runDocumentPass(ctx);
    expect(pass.documents).toEqual(['raw/docs/b.md']);
    expect(pass.summaries).toEqual([pagePath]);
  });
});

describe('summaries on their own', () => {
  const dataDir = path.join(tmp, 'summaries');
  let ctx: AppContext;

  const stub = (complete: () => Promise<string>, enabled = true): LlmClient =>
    ({ enabled, label: 'stub', provider: 'openai', model: 'stub', complete, completeJson: async () => ({}) }) as unknown as LlmClient;

  beforeAll(async () => {
    write(dataDir, 'raw/docs/c.md', '# 备忘\n\n一段要总结的文字。\n');
    // one-line documents: no size threshold here
    const base = defaultConfig();
    write(dataDir, 'knode.config.json', JSON.stringify({ ...base, extraction: { ...base.extraction, summaryMinChars: 0 } }));
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });
  });

  afterAll(async () => {
    await ctx?.datasources.closeAll();
    await ctx?.store.close();
  });

  it('stops retrying a document after three failures on the same content', async () => {
    let calls = 0;
    const failing = stub(async () => {
      calls++;
      throw new Error('upstream 500');
    });
    for (let i = 0; i < 4; i++) {
      expect(await ensureSourceSummaries({ ...ctx, summaryLlm: failing }, { limit: 5 })).toEqual([]);
    }
    expect(calls).toBe(3);
    expect(readSourceSummaryFailure(dataDir, 'raw/docs/c.md')).toMatchObject({ attempts: 3, error: 'upstream 500' });

    // new content starts over, and a success clears the record
    write(dataDir, 'raw/docs/c.md', '# 备忘\n\n改过的文字。\n');
    await sync(ctx, { llmGraph: false });
    const written = await ensureSourceSummaries({ ...ctx, summaryLlm: stub(async () => '一段摘要。') }, { limit: 5 });
    expect(written).toEqual(['wiki/sources/备忘.md']);
    expect(readSourceSummaryFailure(dataDir, 'raw/docs/c.md')).toBeNull();
  });

  it('writes with the Summarize route even when the Judge route has no model', async () => {
    write(dataDir, 'raw/docs/d.md', '# 纪要\n\n另一段文字。\n');
    await sync(ctx, { llmGraph: false });
    const judgeOff = stub(async () => 'never', false);
    const written = await ensureSourceSummaries({ ...ctx, llm: judgeOff, summaryLlm: stub(async () => '纪要的摘要。') }, { limit: 5 });
    expect(written).toEqual(['wiki/sources/纪要.md']);
    // and with no Summarize model there is nothing to write, whatever Judge has
    write(dataDir, 'raw/docs/e.md', '# 第三篇\n\n文字。\n');
    await sync(ctx, { llmGraph: false });
    expect(await ensureSourceSummaries({ ...ctx, summaryLlm: stub(async () => 'x', false) }, { limit: 5 })).toEqual([]);
  });
});

describe('the duplicate audit with a focus', () => {
  const dataDir = path.join(tmp, 'focus');
  let ctx: AppContext;

  beforeAll(async () => {
    write(dataDir, 'raw/docs/a.md', '---\ntitle: 腾讯\nentities:\n  - { name: 腾讯控股, type: organization }\n  - { name: 腾讯, type: organization }\n  - { name: 比亚迪, type: organization }\n---\n腾讯控股与腾讯；比亚迪造车。\n');
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });
  });

  afterAll(async () => {
    await ctx?.datasources.closeAll();
    await ctx?.store.close();
  });

  it('only scores pairs with an entity in focus', async () => {
    const ids = (await ctx.store.query<{ id: string }>(`SELECT id FROM entities WHERE tx_to IS NULL AND id IN ('腾讯', '腾讯控股', '比亚迪')`)).map((r) => r.id);
    expect([...ids].sort()).toEqual(['腾讯', '腾讯控股', '比亚迪'].sort());

    // 腾讯 / 腾讯控股 differ by a corporate suffix only: the audit's business, not write time's
    expect((await auditDuplicateEntities(ctx, { focus: ['比亚迪'] })).candidates).toBe(0);
    expect((await auditDuplicateEntities(ctx, { focus: ['nothing-here'] })).candidates).toBe(0);
    const focused = await auditDuplicateEntities(ctx, { focus: ['腾讯'] });
    expect(focused.candidates).toBeGreaterThanOrEqual(1);
    expect((await listSuggestions(ctx.store, {})).map((s) => s.id)).toContain(mergeSuggestionId('腾讯', '腾讯控股'));
    // the nightly audit, with no focus, still sees every pair
    expect((await auditDuplicateEntities(ctx, {})).candidates).toBe(focused.candidates);
  });
});

describe('the nightly pass', () => {
  const dataDir = path.join(tmp, 'nightly');
  let ctx: AppContext;

  beforeAll(async () => {
    write(dataDir, 'raw/docs/a.md', '# 笔记\n\n文字。\n');
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });
  });

  afterAll(async () => {
    await ctx?.datasources.closeAll();
    await ctx?.store.close();
  });

  it('archives the concept-cluster pages the retired Synthesize stage wrote, and writes none', async () => {
    const page = 'wiki/concepts/宁德时代-cluster.md';
    write(dataDir, page, '---\ntitle: 宁德时代 cluster\ntype: concept\ngenerated: { by: knode-os/old-model }\n---\n\n<!-- knode:begin body -->\n旧的簇页。\n<!-- knode:end body -->\n');
    await ctx.store.query(
      `INSERT INTO pages (path, kind, generator, inputs_sha, status, tx_from) VALUES ($1, 'concept_cluster', 'concept_cluster@2', 'x', 'active', now())`,
      [page],
    );

    const stats = await refineWiki(ctx.store, ctx.config, ctx.llm, { embedder: ctx.embedder });
    expect(stats.retiredPages).toBe(1);
    expect(fs.existsSync(path.join(dataDir, page))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'wiki/.archive/concepts/宁德时代-cluster.md'))).toBe(true);
    const [row] = await ctx.store.query<{ status: string }>(`SELECT status FROM pages WHERE path = $1`, [page]);
    expect(row.status).toBe('archived');

    // nothing left to retire, and no new cluster page appears
    expect((await refineWiki(ctx.store, ctx.config, ctx.llm, { embedder: ctx.embedder })).retiredPages).toBe(0);
    expect(fs.readdirSync(path.join(dataDir, 'wiki/concepts')).filter((f) => f.endsWith('-cluster.md'))).toEqual([]);
  });
});
