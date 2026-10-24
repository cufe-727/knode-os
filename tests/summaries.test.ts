import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, defaultRoutedLlmConfig, ExtractionConfig, LlmConnection } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { readSourceSummary, readSourceSummaryParts } from '../src/fs/sidecar.js';
import { segmentText } from '../src/graph/segment.js';
import { loadSourceText } from '../src/ingest/source.js';
import { sync } from '../src/ingest/sync.js';
import { WorkerIdentity } from '../src/labeling/scheduler.js';
import { ensureDefaultAgents } from '../src/research/agents.js';
import { dueSummaryDocuments, ensureSourceSummaries, ensureSourcesIndex, pruneShortSummaries } from '../src/wiki/pages.js';
import { channelNames, detectSummaryLanguage, LinkVocabulary, normalizeLinks, sampleSegments } from '../src/wiki/summary.js';
import { SummarySource } from '../src/work/summarize.js';
import { startFakeOpenAi, type ChatRequest, type FakeOpenAi } from './helpers/fake-openai.js';

/**
 * The Summarize stage after docs/design/14: no page for a document under the
 * size threshold, the page scaffold in the document's language, [[links]]
 * held to the graph's names, long documents summarized segment by segment
 * — in one pass and as leased work — and the sweep that archives the pages
 * written before the threshold existed.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-summaries-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

async function until(check: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (p as { text?: string })?.text ?? '').join('') : '';

const systemOf = (r: ChatRequest) => textOf(r.messages?.find((m) => m.role === 'system')?.content);
const userOf = (r: ChatRequest) => textOf(r.messages?.filter((m) => m.role === 'user').at(-1)?.content);

/** Which call of the stage a request is: one of a long document's parts, the merge of them, or a whole document. */
function kindOf(r: ChatRequest): 'part' | 'merge' | 'single' | 'other' {
  const system = systemOf(r);
  if (!system.includes('Summarize the document into a wiki source page')) return 'other';
  if (system.includes('This call reads part')) return 'part';
  if (system.includes('Merge them into one page')) return 'merge';
  return 'single';
}

/** A model that answers the way a careless one does: English headings, links to names the graph lacks, the channel as an entity. */
function answer(request: ChatRequest): string {
  const kind = kindOf(request);
  const user = userOf(request);
  if (kind === 'other') return JSON.stringify({ entities: [], relations: [], claims: [] });
  if (kind === 'part') {
    const part = /part (\d+) of (\d+)/.exec(user);
    return `第 ${part?.[1]} 部分的摘要。\n\n## 要点\n\n- [[懂王]]发推\n\n## 实体\n\n- [[特朗普]]`;
  }
  if (kind === 'merge') return '合并后的摘要。\n\n## Key points\n\n- 全周震荡\n\n## Entities\n\n- [[特朗普]]\n- [[飞书]]：平台';
  if (user.includes('Source file: raw/docs/zh.md')) {
    return [
      '本周[[懂王]]的关税政策扰动市场，[[融资杠杆]]过高的账户减仓；[[不存在的实体]]与此无关。',
      '',
      '## Key points',
      '',
      '- [[雪球]]上的讨论集中在[[保证金交易]]风险',
      '- [[管我财]]认为应降低仓位',
      '',
      '## Entities',
      '',
      '- [[雪球]]：内容发布平台',
      '- [[管我财]]：作者',
      '- [[特朗普]]',
      '- [[保证金交易]]',
    ].join('\n');
  }
  if (user.includes('Source file: raw/docs/en.md')) return 'An English summary.\n\n## Key points\n\n- Rates\n\n## Entities\n\n- [[Nobody]]';
  return '摘要。\n\n## 要点\n\n- 要点\n\n## 实体\n\n- 无';
}

const SHORT = '---\ntitle: 短文\nplatform: xueqiu\nsource: 管我财\n---\n# 短文\n\n今天只发了一条：继续持有，等待右侧信号，不预测、不抄底。盘中震荡属于正常波动，仓位不动，耐心等待量能回升再说。\n';

const ZH = `---
title: 本周复盘
platform: xueqiu
source: 管我财
entities:
  - { name: 特朗普, type: person, aliases: [懂王] }
  - { name: 保证金交易, type: concept, aliases: [融资杠杆] }
---
# 本周复盘

${'懂王的关税政策再次扰动市场，融资杠杆过高的账户被迫减仓。'.repeat(12)}
`;

const EN = `---\ntitle: Weekly review\n---\n# Weekly review\n\n${'The market priced in another rate cut while small caps lagged behind. '.repeat(10)}\n`;

const DECLARED = `---\ntitle: 声明语言\nlang: en\n---\n# 声明语言\n\n${'虽然正文是中文，但 frontmatter 声明了英文。'.repeat(12)}\n`;

/** A digest of `sections` posts, well over one summary call's input. */
const longDoc = (title: string, sections: number) => [
  `---\ntitle: ${title}\nplatform: feishu\nsource: 金乌\nentities:\n  - { name: 特朗普, type: person, aliases: [懂王] }\n---`,
  `# ${title}`,
  ...Array.from({ length: sections }, (_, i) => `## 第${i + 1}条\n\n${`第${i + 1}条：懂王又发推，市场震荡。`.repeat(30)}`),
].join('\n\n');

async function workspace(name: string, fake: FakeOpenAi, extraction: Partial<ExtractionConfig> = {}): Promise<string> {
  const dataDir = path.join(tmp, name);
  const model: LlmConnection = {
    id: 'connection-1', label: 'fake', provider: 'openai', baseUrl: fake.url, apiKey: 'sk-test',
    protocol: 'chat', model: 'fake-model', cliPath: '', effort: 'default', cliTimeoutMs: 30_000,
  };
  const base = defaultConfig();
  const route = { ...defaultRoutedLlmConfig(), use: 'connection-1' };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'knode.config.json'), JSON.stringify({
    ...base,
    connections: [model],
    llmUse: 'connection-1',
    extraction: { ...base.extraction, entityLlm: route, documentLlm: route, summaryLlm: route, judgeLlm: route, segmentChars: 1000, summaryMinChars: 200, ...extraction },
  }));
  ensureDefaultAgents(dataDir);
  return dataDir;
}

/** Summary pages in use, by the document each one summarizes. */
const summaryPages = async (ctx: AppContext) => new Map((await ctx.store.query<{ path: string; doc: string; status: string }>(
  `SELECT p.path, p.status, d.input_id AS doc FROM pages p JOIN deps d ON d.artifact_kind = 'page' AND d.artifact_id = p.path AND d.input_kind = 'document'
   WHERE p.kind = 'source_summary' AND p.status <> 'archived'`,
)).map((r) => [r.doc, r.path]));

const page = (ctx: AppContext, rel: string) => fs.readFileSync(path.join(ctx.dataDir, rel), 'utf8');

describe('the Summarize stage', () => {
  let fake: FakeOpenAi;
  let ctx: AppContext;

  beforeAll(async () => {
    fake = await startFakeOpenAi({ answer });
    const dataDir = await workspace('stage', fake);
    write(dataDir, 'raw/docs/short.md', SHORT);
    write(dataDir, 'raw/docs/zh.md', ZH);
    write(dataDir, 'raw/docs/en.md', EN);
    write(dataDir, 'raw/docs/declared.md', DECLARED);
    write(dataDir, 'raw/docs/long.md', longDoc('长周报', 30));
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });
  });

  afterAll(async () => {
    await ctx?.datasources.closeAll();
    await ctx?.store.close();
    await fake?.close();
  });

  it('leaves a document under extraction.summaryMinChars out: never due, no page, marked short in the sources index', async () => {
    const chars = async (rel: string) => (await ctx.store.query<{ chars: number | null; bytes: number }>(`SELECT chars, bytes FROM documents WHERE path = $1`, [rel]))[0];
    // the indexed text's length is written with the document
    const short = await chars('raw/docs/short.md');
    expect(short.chars).toBe(loadSourceText(ctx.dataDir, 'raw/docs/short.md', 'docs')!.text.length);
    expect(short.chars!).toBeLessThan(200);
    // a Chinese line of under 200 characters is over 200 bytes: only the text tells
    expect(short.bytes).toBeGreaterThanOrEqual(200);

    const due = await dueSummaryDocuments(ctx.store, ctx.dataDir, { limit: 50, minChars: 200 });
    expect(due.due).toBe(4);
    expect(due.docs.map((d) => d.path).sort()).toEqual(['raw/docs/declared.md', 'raw/docs/en.md', 'raw/docs/long.md', 'raw/docs/zh.md']);
    // a row indexed before the column existed reads its text once, and the column is filled in
    await ctx.store.query(`UPDATE documents SET chars = NULL WHERE path = 'raw/docs/short.md'`);
    expect((await dueSummaryDocuments(ctx.store, ctx.dataDir, { limit: 50, minChars: 200 })).docs.map((d) => d.path)).not.toContain('raw/docs/short.md');
    expect((await chars('raw/docs/short.md')).chars).toBe(short.chars);
    // 0 turns the threshold off
    expect((await dueSummaryDocuments(ctx.store, ctx.dataDir, { limit: 50, minChars: 0 })).docs.map((d) => d.path)).toContain('raw/docs/short.md');

    const written = await ensureSourceSummaries(ctx, { limit: 20 });
    expect(written.sort()).toEqual(['wiki/sources/weekly-review.md', 'wiki/sources/声明语言.md', 'wiki/sources/本周复盘.md', 'wiki/sources/长周报.md']);
    expect(fs.existsSync(path.join(ctx.dataDir, 'wiki/sources/短文.md'))).toBe(false);
    expect(fake.calls.filter((c) => userOf(c).includes('raw/docs/short.md'))).toEqual([]);

    await ensureSourcesIndex(ctx);
    const index = page(ctx, 'wiki/sources/index.md');
    expect(index).toMatch(/^\* 短文 - `raw\/docs\/short\.md`.* `short`$/m);
    expect(index).toMatch(/^\* \[本周复盘\]\(本周复盘\.md\) - `raw\/docs\/zh\.md`/m);
    expect(index).toContain('A document under `extraction.summaryMinChars` (`short`) gets none');
  });

  it("writes the scaffold in the document's language — read from its text, or declared in its frontmatter", async () => {
    const zhCall = fake.calls.find((c) => userOf(c).includes('Source file: raw/docs/zh.md'))!;
    expect(systemOf(zhCall)).toContain("Write in Chinese, in the document's own variety");
    expect(systemOf(zhCall)).toContain('"## 要点"');
    expect(systemOf(zhCall)).toContain('"## 实体"');
    const zh = page(ctx, 'wiki/sources/本周复盘.md');
    expect(zh).toContain('description: raw/docs/zh.md 的摘要。');
    // the model answered with English headings; the page has the scaffold's
    expect(zh).toContain('\n## 要点\n');
    expect(zh).toContain('\n## 实体\n');
    expect(zh).not.toContain('Key points');

    const enCall = fake.calls.find((c) => userOf(c).includes('Source file: raw/docs/en.md'))!;
    expect(systemOf(enCall)).toContain('Write in English.');
    expect(systemOf(enCall)).toContain('"## Key points"');
    const en = page(ctx, 'wiki/sources/weekly-review.md');
    expect(en).toContain('description: Summary of raw/docs/en.md.');
    expect(en).toContain('\n## Key points\n');

    // `lang: en` in the frontmatter beats the Chinese text
    const declaredCall = fake.calls.find((c) => userOf(c).includes('Source file: raw/docs/declared.md'))!;
    expect(systemOf(declaredCall)).toContain('Write in English.');
    expect(page(ctx, 'wiki/sources/声明语言.md')).toContain('description: Summary of raw/docs/declared.md.');
  });

  it("links only the graph's names, under the graph's spelling, and keeps the document's channel out of the entities", async () => {
    const call = fake.calls.find((c) => userOf(c).includes('Source file: raw/docs/zh.md'))!;
    const system = systemOf(call);
    // the names the graph has for this document, with the spellings the document uses
    expect(system).toContain('特朗普 (also 懂王)');
    expect(system).toContain('保证金交易 (also 融资杠杆)');
    expect(system).toContain('only the entities listed here may be linked');
    // its own platform and author, by id and by name
    expect(system).toContain("(xueqiu, 雪球, 管我财): do not list the platform or the author");

    const zh = page(ctx, 'wiki/sources/本周复盘.md');
    // an alias links to its entity, shown as the document spells it; a name is kept
    expect(zh).toContain('[[特朗普|懂王]]');
    expect(zh).toContain('[[保证金交易|融资杠杆]]');
    expect(zh).toContain('- [[特朗普]]');
    expect(zh).toContain('- [[保证金交易]]');
    // a name the graph lacks stays as text
    expect(zh).toContain('不存在的实体与此无关');
    expect(zh).not.toContain('[[不存在的实体]]');
    // the channel is never a link, and not an entity; as a subject of a key point it stays
    expect(zh).not.toContain('[[雪球]]');
    expect(zh).not.toContain('[[管我财]]');
    expect(zh).toContain('- 雪球上的讨论集中在[[保证金交易]]风险');
    expect(zh).toContain('- 管我财认为应降低仓位');
    expect(zh).not.toContain('雪球：内容发布平台');
    expect(zh).not.toContain('管我财：作者');

    // with no entities of the graph in a document, nothing is linked
    const enCall = fake.calls.find((c) => userOf(c).includes('Source file: raw/docs/en.md'))!;
    expect(systemOf(enCall)).toContain('write every name as plain text');
    expect(page(ctx, 'wiki/sources/weekly-review.md')).toContain('- Nobody');
  });

  it('summarizes a long document segment by segment, merges the parts, and says how much of it the page read', async () => {
    const text = loadSourceText(ctx.dataDir, 'raw/docs/long.md', 'docs')!.text;
    expect(text.length).toBeGreaterThan(14_000);
    const segments = segmentText(text, 1000);
    expect(segments.length).toBeGreaterThan(12);
    const calls = fake.calls.filter((c) => userOf(c).includes('raw/docs/long.md'));
    // the default reads at most 12 segments, evenly through the document, then merges
    expect(calls.filter((c) => kindOf(c) === 'part')).toHaveLength(12);
    expect(calls.filter((c) => kindOf(c) === 'merge')).toHaveLength(1);
    const merge = calls.find((c) => kindOf(c) === 'merge')!;
    expect(systemOf(merge)).toContain(`12 of its ${segments.length} parts were read`);
    expect(userOf(merge)).toContain(`### Part 1 of ${segments.length}`);
    expect(userOf(merge)).toContain(`### Part ${segments.length} of ${segments.length}`);
    // each part saw the names that appear in it
    expect(systemOf(calls.find((c) => kindOf(c) === 'part')!)).toContain('特朗普 (also 懂王)');

    const long = page(ctx, 'wiki/sources/长周报.md');
    expect(long).toContain(`> 分段摘要：全文约 ${text.length.toLocaleString('en-US')} 字、${segments.length} 段，本页只读了其中 12 段（约 `);
    expect(long).toMatch(/本页只读了其中 12 段（约 \d+%，30 节中的 \d+ 节）。/);
    expect(long).toContain(`parts: ${segments.length}`);
    expect(long).toContain('read: 12');
    // the merge answered with English headings and the platform as an entity
    expect(long).toContain('\n## 要点\n');
    expect(long).toContain('- [[特朗普]]');
    expect(long).not.toContain('飞书：平台');
    const cache = readSourceSummary(ctx.dataDir, 'raw/docs/long.md')!;
    expect(cache.coverage).toMatchObject({ chars: text.length, parts: segments.length, read: 12, sections: 30 });
    expect(cache.language).toBe('zh');
    expect(readSourceSummaryParts(ctx.dataDir, 'raw/docs/long.md').size).toBe(12);

    // a post appended and the cap lifted: only the segments without a cached part are read again, then the merge
    const before = readSourceSummaryParts(ctx.dataDir, 'raw/docs/long.md');
    ctx.config.extraction.summaryMaxSegments = 64;
    write(ctx.dataDir, 'raw/docs/long.md', longDoc('长周报', 31));
    await sync(ctx, { only: ['raw/docs/long.md'], llmGraph: false });
    const seen = fake.calls.length;
    expect(await ensureSourceSummaries(ctx, { limit: 20 })).toEqual(['wiki/sources/长周报.md']);
    const again = segmentText(loadSourceText(ctx.dataDir, 'raw/docs/long.md', 'docs')!.text, 1000);
    const reused = again.filter((s) => before.has(s.sha)).length;
    expect(reused).toBeGreaterThan(0);
    const fresh = fake.calls.slice(seen);
    expect(fresh.filter((c) => kindOf(c) === 'part')).toHaveLength(again.length - reused);
    expect(fresh.filter((c) => kindOf(c) === 'merge')).toHaveLength(1);
    expect(page(ctx, 'wiki/sources/长周报.md')).toContain(`段，逐段摘要后合并。`);
    expect(readSourceSummaryParts(ctx.dataDir, 'raw/docs/long.md').size).toBe(again.length);
  });

  it("leases a long document's parts to several workers at once, then the merge, and writes the page from their answers", async () => {
    ctx.config.extraction.summaryMaxSegments = 12;
    write(ctx.dataDir, 'raw/docs/leased.md', longDoc('远程周报', 30));
    await sync(ctx, { only: ['raw/docs/leased.md'], llmGraph: false });
    const segments = segmentText(loadSourceText(ctx.dataDir, 'raw/docs/leased.md', 'docs')!.text, 1000);
    const source = new SummarySource(ctx, {}, { idleScanMs: 0, leaseMs: 60_000 });
    const mac: WorkerIdentity = { worker: 'macbook/codex#1', backend: 'codex', remote: true };
    const box: WorkerIdentity = { worker: 'aliyun/api#1', backend: 'api', remote: true };
    try {
      const calls = fake.calls.length;
      const first = await source.lease(mac, 8);
      const second = await source.lease(box, 8);
      expect(first).toHaveLength(8);
      expect(second).toHaveLength(4);
      for (const t of [...first, ...second]) {
        expect(t.label).toMatch(new RegExp(`^raw/docs/leased\\.md \\[\\d+/${segments.length}\\]$`));
        expect(t).toMatchObject({ kind: 'summarize', json: false, maxTokens: 900 });
        expect(t.messages[0].content).toContain('This call reads part');
      }
      // every part is out: nothing more until one lands
      expect(await source.lease(mac, 8)).toEqual([]);
      expect((await source.status()).leases).toHaveLength(12);
      for (const t of first) expect(await source.complete(t.id, mac, { ok: true, text: `${t.label} 的摘要。`, model: 'codex:gpt-test' })).toEqual({ accepted: true });
      for (const t of second) expect(await source.complete(t.id, box, { ok: true, text: `${t.label} 的摘要。`, model: 'api:gpt-test' })).toEqual({ accepted: true });
      expect(readSourceSummaryParts(ctx.dataDir, 'raw/docs/leased.md').size).toBe(12);
      // the parts are in: the merge goes out, carrying them
      const [merge, ...rest] = await source.lease(mac, 8);
      expect(rest).toEqual([]);
      expect(merge).toMatchObject({ label: 'raw/docs/leased.md [merge]', maxTokens: 1500 });
      expect(merge.messages[0].content).toContain('Merge them into one page');
      expect(merge.messages[1].content).toContain(`### Part 1 of ${segments.length}`);
      expect(merge.messages[1].content).toContain('raw/docs/leased.md [1/');
      expect(await source.complete(merge.id, mac, { ok: true, text: '合并后的摘要。\n\n## Key points\n\n- [[懂王]]\n\n## Entities\n\n- [[特朗普]]', model: 'codex:gpt-test' })).toEqual({ accepted: true });
      await until(async () => (await summaryPages(ctx)).has('raw/docs/leased.md'), 10_000, 'the leased summary page');
      // no model call of this machine's
      expect(fake.calls.length).toBe(calls);
      const written = page(ctx, (await summaryPages(ctx)).get('raw/docs/leased.md')!);
      expect(written).toContain('[[特朗普|懂王]]');
      expect(written).toContain('\n## 要点\n');
      expect(written).toContain('本页只读了其中 12 段');
      expect(written).toContain('knode-os/remote:codex:gpt-test');
      expect((await source.status()).totals).toMatchObject({ calls: 13, ok: 13, parts: 12, pagesWritten: 1 });
      expect(await source.lease(mac, 8)).toEqual([]);
    } finally {
      await source.stop();
    }
  });

  it('archives the pages of documents under the threshold on request, and brings them back for free when it drops', async () => {
    // the page a short document got before the threshold existed
    ctx.config.extraction.summaryMinChars = 0;
    expect(await ensureSourceSummaries(ctx, { limit: 20 })).toEqual(['wiki/sources/短文.md']);
    ctx.config.extraction.summaryMinChars = 200;

    const dry = await pruneShortSummaries(ctx, { dryRun: true });
    expect(dry).toMatchObject({ minChars: 200, archived: ['wiki/sources/短文.md'], kept: 5 });
    expect(fs.existsSync(path.join(ctx.dataDir, 'wiki/sources/短文.md'))).toBe(true);

    const done = await pruneShortSummaries(ctx);
    expect(done.archived).toEqual(['wiki/sources/短文.md']);
    expect(fs.existsSync(path.join(ctx.dataDir, 'wiki/sources/短文.md'))).toBe(false);
    expect(fs.existsSync(path.join(ctx.dataDir, 'wiki/.archive/sources/短文.md'))).toBe(true);
    expect((await ctx.store.query<{ status: string }>(`SELECT status FROM pages WHERE path = 'wiki/sources/短文.md'`))[0]?.status).toBe('archived');
    expect((await summaryPages(ctx)).has('raw/docs/short.md')).toBe(false);
    expect(page(ctx, 'wiki/sources/index.md')).toMatch(/^\* 短文 - `raw\/docs\/short\.md`.* `short`$/m);
    // nothing comes back on its own
    expect(await ensureSourceSummaries(ctx, { limit: 20 })).toEqual([]);
    expect((await pruneShortSummaries(ctx)).archived).toEqual([]);

    // the cached summary is kept: a lower threshold restores the page without a model call
    ctx.config.extraction.summaryMinChars = 0;
    const calls = fake.calls.length;
    expect(await ensureSourceSummaries(ctx, { limit: 20 })).toEqual(['wiki/sources/短文.md']);
    expect(fake.calls.length).toBe(calls);
    expect(fs.existsSync(path.join(ctx.dataDir, 'wiki/sources/短文.md'))).toBe(true);
    ctx.config.extraction.summaryMinChars = 200;
  });
});

describe('summary helpers', () => {
  it('tells the language of a text by its script, or takes the frontmatter\'s word', () => {
    expect(detectSummaryLanguage('懂王的关税政策再次扰动市场，A股与港股同步回落，CATL 领跌。')).toBe('zh');
    expect(detectSummaryLanguage('The market priced in another rate cut while small caps lagged.')).toBe('en');
    expect(detectSummaryLanguage('東京市場は利上げ観測で続落した。半導体株が重い。')).toBe('ja');
    expect(detectSummaryLanguage('코스피는 금리 인상 우려로 하락했다. 반도체가 약세였다.')).toBe('ko');
    // tickers and English terms in a Chinese post do not make it English
    expect(detectSummaryLanguage('NVDA、TSLA、AAPL 同步回调，纳指跌 2%。')).toBe('zh');
    expect(detectSummaryLanguage('懂王的关税政策。', { lang: 'en-US' })).toBe('en');
    // an unknown declared language falls back to the text
    expect(detectSummaryLanguage('懂王的关税政策。', { language: 'fr' })).toBe('zh');
    expect(detectSummaryLanguage('')).toBe('en');
  });

  it('samples segments evenly, keeping the first and the last', () => {
    expect(sampleSegments([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4)).toEqual([0, 3, 6, 9]);
    expect(sampleSegments([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 1)).toEqual([0]);
    expect(sampleSegments([0, 1, 2], 12)).toEqual([0, 1, 2]);
    expect(sampleSegments([0, 1, 2, 3, 4], 5)).toEqual([0, 1, 2, 3, 4]);
  });

  it('holds links to the vocabulary and the channel', () => {
    const vocabulary = new LinkVocabulary([{ name: '特朗普', type: 'person', aliases: ['懂王', 'Trump'] }, { name: 'CATL', type: 'organization', aliases: [] }]);
    expect(normalizeLinks('[[懂王]]发推，[[trump]]回应。', vocabulary)).toBe('[[特朗普|懂王]]发推，[[特朗普|trump]]回应。');
    expect(normalizeLinks('[[特朗普]]与[[catl]]', vocabulary)).toBe('[[特朗普]]与[[CATL|catl]]');
    expect(normalizeLinks('[[特朗普|川普]]说', vocabulary)).toBe('[[特朗普|川普]]说');
    expect(normalizeLinks('[[不存在]]和[[X|某人]]', vocabulary)).toBe('不存在和某人');
    expect(normalizeLinks('[[雪球]]上的[[特朗普]]', vocabulary, ['雪球'])).toBe('雪球上的[[特朗普]]');
    expect(normalizeLinks('![[chart.png]] [[特朗普]]', vocabulary)).toBe('![[chart.png]] [[特朗普]]');
    expect(vocabulary.appearingIn('Trump 又发推').map((e) => e.name)).toEqual(['特朗普']);
  });

  it('reads the channel out of the frontmatter, platform ids by their names too', () => {
    expect(channelNames({ platform: 'xueqiu', source: '管我财', author: 'https://x.com/someone' })).toEqual(['xueqiu', '雪球', '管我财']);
    expect(channelNames({ platform: 'wechat', title: '不是渠道' })).toEqual(['wechat', '微信', '微信公众号', '公众号']);
    expect(channelNames({ source: 'raw/docs/a.md' })).toEqual([]);
    expect(channelNames({})).toEqual([]);
  });
});
