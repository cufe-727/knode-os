import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, defaultRoutedLlmConfig, LlmConnection } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { readSidecarPart, writeSidecarPart } from '../src/fs/sidecar.js';
import { auditDuplicateClaims, claimPairId, keyNumbers, negated, numbersOf, periodsDisjoint, periodsOf, sameNumber, statementKey } from '../src/graph/claim-dedupe.js';
import { listClaimMerges, unmergeClaim } from '../src/graph/claim-merge.js';
import { mergeSegmentResults, segmentText } from '../src/graph/segment.js';
import { alikeWording, wordingOf } from '../src/graph/wording.js';
import { runDocumentPass } from '../src/ingest/background.js';
import { rebuild } from '../src/lineage/rebuild.js';
import { sync } from '../src/ingest/sync.js';
import { LlmClient } from '../src/llm/client.js';
import { applySuggestion } from '../src/pack/learn.js';
import { ensureDefaultAgents } from '../src/research/agents.js';
import { queryClaims } from '../src/store/claims.js';
import { listSuggestions } from '../src/store/queries.js';
import { refineWiki } from '../src/wiki/refine.js';
import { startFakeOpenAi, type ChatRequest, type FakeOpenAi } from './helpers/fake-openai.js';

/** docs/design/10: long documents read in segments, duplicate claims merged. */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-long-docs-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (p as { text?: string })?.text ?? '').join('') : '';
const systemOf = (r: ChatRequest) => textOf(r.messages?.find((m) => m.role === 'system')?.content);
const userOf = (r: ChatRequest) => textOf(r.messages?.filter((m) => m.role === 'user').at(-1)?.content);

/** An archive-like document: many short sections, each with its own heading. */
function archive(sections: number, tag = ''): string {
  const out = ['---', 'title: 测试归档', '---', '', '# 测试归档', ''];
  for (let k = 1; k <= sections; k++) {
    out.push(`## 帖子 ${k}${tag}`, '', `> 时间: 2025-08-${String((k % 28) + 1).padStart(2, '0')}`, '');
    out.push(`第${k}帖的正文：${'这是一段用来凑长度的文字，讲的是公司经营情况与行业动态。'.repeat(4)}`, '', '---', '');
  }
  return out.join('\n');
}

function fakeModel(url: string): LlmConnection {
  // pinned, so a call goes straight to /chat/completions instead of probing /responses
  return { id: 'connection-1', label: 'fake', provider: 'openai', baseUrl: url, apiKey: 'sk-test', protocol: 'chat', model: 'fake-model', cliPath: '', effort: 'default', cliTimeoutMs: 30_000 };
}

describe('cutting documents into segments', () => {
  it('leaves a document within the limit whole', () => {
    const text = '# 短文\n\n一段话。\n';
    expect(segmentText(text, 12_000)).toEqual([expect.objectContaining({ index: 0, start: 0, end: text.length, text, heading: null })]);
    expect(segmentText('', 12_000)).toEqual([]);
  });

  it('covers the text exactly, within the limit, cutting on headings', () => {
    const text = archive(120);
    const segs = segmentText(text, 4000);
    expect(segs.length).toBeGreaterThan(3);
    expect(segs.map((s) => s.text).join('')).toBe(text);
    for (const [i, s] of segs.entries()) {
      expect(s.index).toBe(i);
      expect(s.end - s.start).toBeLessThanOrEqual(4000);
      if (i > 0) expect(s.start).toBe(segs[i - 1].end);
    }
    // a cut lands on a block boundary: every later segment opens on a heading or a rule
    for (const s of segs.slice(1)) expect(s.text).toMatch(/^(## |---|> |第)/);
  });

  it('keeps every other segment when a section in the middle changes', () => {
    const text = archive(200);
    const before = segmentText(text, 4000);
    const at = text.indexOf('## 帖子 100\n');
    const edited = text.slice(0, at) + '## 插入的帖子\n\n一段新内容。\n\n' + text.slice(at);
    const after = segmentText(edited, 4000);
    const old = new Set(before.map((s) => s.sha));
    const changed = after.filter((s) => !old.has(s.sha));
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.length).toBeLessThanOrEqual(2);
  });

  it('changes only the last segment when text is appended', () => {
    const text = archive(150);
    const before = segmentText(text, 4000);
    const after = segmentText(text + archive(10, '（续）').split('\n').slice(6).join('\n'), 4000);
    const kept = new Set(after.map((s) => s.sha));
    expect(before.slice(0, -1).every((s) => kept.has(s.sha))).toBe(true);
  });

  it('splits a single oversized paragraph at sentence ends', () => {
    const text = '这是一句话。'.repeat(1500);
    const segs = segmentText(text, 2000);
    expect(segs.map((s) => s.text).join('')).toBe(text);
    for (const s of segs) {
      expect(s.end - s.start).toBeLessThanOrEqual(2000);
      expect(s.text.endsWith('。')).toBe(true);
    }
  });
});

describe('merging the segments of one document', () => {
  it('joins spellings, keeps the frequent name, collapses claims and maps relation ends', () => {
    const merged = mergeSegmentResults([
      { index: 0, entities: [{ name: '宁德时代', type: 'organization', description: '电池厂商', aliases: ['CATL'] }], relations: [], claims: [{ subject: '宁德时代', statement: '宁德时代 2025 年营收 4000 亿元', type: 'earnings', status: 'fact' }] },
      { index: 1, entities: [{ name: 'CATL', type: 'organization', aliases: [] }, { name: '特斯拉', type: 'organization' }], relations: [{ source: 'CATL', target: '特斯拉', type: 'supplies_to' }], claims: [{ subject: 'CATL', statement: '宁德时代  2025 年营收 4000 亿元', type: 'earnings', status: 'fact' }] },
      { index: 2, entities: [{ name: 'CATL', type: 'organization' }], relations: [{ source: '宁德时代', target: '特斯拉', type: 'supplies_to', validFrom: '2024' }], claims: [] },
    ]);
    const catl = merged.entities.find((e) => e.name === 'CATL');
    expect(catl).toMatchObject({ type: 'organization', description: '电池厂商', segments: [0, 1, 2] });
    expect(catl?.aliases).toContain('宁德时代');
    expect(merged.entities).toHaveLength(2);
    expect(merged.relations).toEqual([expect.objectContaining({ source: 'CATL', target: '特斯拉', validFrom: '2024' })]);
    expect(merged.claims).toEqual([expect.objectContaining({ subject: 'CATL', segment: 0 })]);
  });
});

describe('telling claims apart', () => {
  it('normalizes wording, numbers, periods and negation', () => {
    expect(statementKey('德明利2025年营收107.89亿元，同比增长126%。')).toBe(statementKey('德明利 2025 年营收 107.89 亿元, 同比增长 126％'));
    expect([...keyNumbers('营收107.89亿元，同比+126%，毛利率 27.14%')].sort()).toEqual(['107.89亿', '126%', '27.14%']);
    expect(keyNumbers('2025年营收')).toEqual(new Set());
    // the same figures, rounded differently (a real pair from the finance archive)
    const a = numbersOf('营收232.9亿元，同比下降0.45%；净利润36.19亿元，同比增长15%；扣非净利润35.63亿元');
    const b = numbersOf('营收232.9亿元、同比下降0.5%，归母净利润36.2亿元、同比增长14.9%，扣非净利润35.6亿元');
    expect(a.every((n) => b.some((m) => sameNumber(n, m)))).toBe(true);
    expect(sameNumber({ value: 120, decimals: 0, unit: '亿' }, { value: 107.89, decimals: 2, unit: '亿' })).toBe(false);
    expect(sameNumber({ value: 15, decimals: 0, unit: '%' }, { value: 15, decimals: 0, unit: '亿' })).toBe(false);
    expect(periodsDisjoint(periodsOf('2025年四季度收入环比增长30%'), periodsOf('25Q3 收入'))).toBe(true);
    expect(periodsDisjoint(periodsOf('2025年全年净利润'), periodsOf('2025年第四季度净利润'))).toBe(false);
    expect(periodsDisjoint(periodsOf('2024年营收47亿元'), periodsOf('FY2025 营收'))).toBe(true);
    // an amount is not a year
    expect(periodsOf('收入2000亿元')).toEqual([]);
    expect(negated('公司尚未计划回购')).toBe(true);
    expect(negated('业绩不及预期')).toBe(false);
    expect(claimPairId('b', 'a')).toBe(claimPairId('a', 'b'));
  });

  it('compares Chinese wording by its bigrams, at a threshold of its own', () => {
    const alike = (a: string, b: string) => alikeWording(wordingOf(a), wordingOf(b));
    // one clause each: as whole words these two shared nothing
    expect(alike('本轮30年期国债期货持仓的边际增量资金主要来自以量价信号入场的CTA趋势型资金', '30年期国债期货本轮边际增量资金主要来自以量价信号入场的CTA趋势型资金')).toBeGreaterThan(0.9);
    expect(alike('甲公司计划扩大海外产能，重点布局东南亚市场', '甲公司计划在东南亚市场扩大海外产能')).toBeGreaterThanOrEqual(0.8);
    // one topic, saying different things: under the CJK threshold (the shared clause made it 0.67 as whole words)
    expect(alike('英特尔将为英伟达定制x86 CPU，并供应集成RTX GPU的x86 SOC芯片', '英特尔将为英伟达定制x86 CPU，由英伟达将其集成至人工智能基础设施平台')).toBeNull();
    expect(alike('甲公司计划回购股份', '甲公司计划扩大海外产能')).toBeNull();
    // Latin wording keeps its threshold
    expect(alike(
      'Volatility-managed portfolios do not systematically outperform their original counterparts on a Sharpe ratio basis.',
      'Volatility-managed portfolios do not systematically outperform their corresponding unmanaged portfolios in direct comparisons.',
    )).toBeCloseTo(8 / 13);
    expect(wordingOf('德明利2025年营收107.89亿元').words).toEqual(new Set(['德明', '明利', '年营', '营收', '亿元', '2025', '107', '89']));
    expect(wordingOf('Revenue grew 20%').cjk).toBe(false);
  });
});

describe('extracting a long document in segments', () => {
  const dataDir = path.join(tmp, 'segments');
  let fake: FakeOpenAi;
  let ctx: AppContext;

  const answer = (request: ChatRequest): string => {
    const system = systemOf(request);
    const user = userOf(request);
    if (system.includes('Summarize the document')) return 'Summary.\n\n## Key points\n\n- 内容';
    if (!system.includes('knowledge-graph extraction engine')) return JSON.stringify({});
    const part = /part (\d+) of (\d+)/.exec(user);
    if (!part) return JSON.stringify({ entities: [], relations: [], claims: [] });
    const k = Number(part[1]);
    if (k === 1) {
      return JSON.stringify({
        subject: { name: '宁德时代', type: 'organization' },
        entities: [{ name: '宁德时代', type: 'organization', description: '电池厂商', aliases: ['CATL'] }],
        relations: [],
        claims: [{ subject: '宁德时代', statement: '宁德时代2025年营收4000亿元', type: 'earnings', status: 'fact' }],
      });
    }
    return JSON.stringify({
      entities: [{ name: 'CATL', type: 'organization', aliases: [] }, { name: `客户${k}`, type: 'organization' }],
      relations: [{ source: 'CATL', target: `客户${k}`, type: 'related_to' }],
      claims: [{ subject: 'CATL', statement: `CATL在第${k}段提到的事实`, type: 'event', status: 'fact' }],
    });
  };

  beforeAll(async () => {
    fake = await startFakeOpenAi({ answer });
    const base = defaultConfig();
    const route = { ...defaultRoutedLlmConfig(), use: 'connection-1' };
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'knode.config.json'), JSON.stringify({
      ...base,
      connections: [fakeModel(fake.url)],
      llmUse: 'connection-1',
      ingest: { ...base.ingest, chunkSize: 300, chunkOverlap: 30 },
      extraction: { ...base.extraction, entityLlm: route, documentLlm: route, summaryLlm: route, judgeLlm: route, segmentChars: 1000, batchSize: 3 },
    }));
    ensureDefaultAgents(dataDir);
    write(dataDir, 'raw/docs/long.md', archive(30));
    ctx = await createContext(dataDir);
    await sync(ctx, {});
  });

  afterAll(async () => {
    await ctx?.datasources.closeAll();
    await ctx?.store.close();
    await fake?.close();
  });

  const extractCalls = (from: number) => fake.calls.slice(from).filter((c) => systemOf(c).includes('knowledge-graph extraction engine'));

  it('reads the first segment first, reserves the rest of the pass for its followers, and resumes next pass', async () => {
    const [queued] = await ctx.store.query<{ segments_total: number }>(`SELECT segments_total FROM extraction_queue`);
    const total = segmentText(fs.readFileSync(path.join(dataDir, 'raw/docs/long.md'), 'utf8'), 1000).length;
    expect(total).toBeGreaterThan(4);
    expect(queued.segments_total).toBe(total);

    const before = fake.calls.length;
    const first = await runDocumentPass(ctx);
    expect(first).toMatchObject({ processed: 0, calls: 3, callsFailed: 0, progressed: true, queued: 1 });
    const calls = extractCalls(before);
    expect(userOf(calls[0])).toContain(`part 1 of ${total}`);
    // the followers know what the document is about
    for (const c of calls.slice(1)) expect(userOf(c)).toContain('Main subject of this document: 宁德时代 (organization)');
    const partial = readSidecarPart(dataDir, 'raw/docs/long.md', 'tier1');
    expect(partial).toMatchObject({ status: 'partial', segmenter: 1 });
    expect(partial?.segments).toHaveLength(3);
    const [progress] = await ctx.store.query<{ segments_done: number }>(`SELECT segments_done FROM extraction_queue`);
    expect(progress.segments_done).toBe(3);

    let passes = 1;
    let pass = first;
    while (pass.queued > 0 && passes < 20) {
      pass = await runDocumentPass(ctx);
      passes++;
    }
    expect(pass.processed).toBe(1);
    expect(extractCalls(before)).toHaveLength(total);

    const done = readSidecarPart(dataDir, 'raw/docs/long.md', 'tier1');
    expect(done).toMatchObject({ status: 'done', segmenter: 1 });
    // one entity for both spellings, with claims from every segment under it
    const entity = done!.entities.find((e) => e.name === 'CATL' || e.name === '宁德时代');
    expect([entity?.name, ...(entity?.aliases ?? [])]).toEqual(expect.arrayContaining(['CATL', '宁德时代']));
    const claims = await queryClaims(ctx.store, { subject: 'CATL', limit: 100 });
    expect(claims.claims.length).toBe(total);
  });

  it('grounds a claim inside its own segment', async () => {
    const text = fs.readFileSync(path.join(dataDir, 'raw/docs/long.md'), 'utf8');
    const segs = segmentText(text, 1000);
    const [row] = await ctx.store.query<{ content: string }>(
      `SELECT ch.content FROM claims c JOIN chunks ch ON ch.id = c.chunk_id WHERE c.statement = $1`,
      ['CATL在第3段提到的事实'],
    );
    const at = text.indexOf(row.content.slice(0, 120));
    expect(at).toBeGreaterThanOrEqual(segs[2].start);
    expect(at).toBeLessThan(segs[2].end);
  });

  it('re-reads only the segments an edit touched', async () => {
    const file = path.join(dataDir, 'raw/docs/long.md');
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text.replace('第15帖的正文：', '第15帖的正文（改过）：'));
    await sync(ctx, {});
    const before = fake.calls.length;
    let pass = await runDocumentPass(ctx);
    while (pass.queued > 0) pass = await runDocumentPass(ctx);
    expect(extractCalls(before).length).toBeGreaterThanOrEqual(1);
    expect(extractCalls(before).length).toBeLessThanOrEqual(2);
    expect(readSidecarPart(dataDir, 'raw/docs/long.md', 'tier1')).toMatchObject({ status: 'done' });
  });

  it('queues again a long document that an old single call read only the start of', async () => {
    const rel = 'raw/docs/legacy.md';
    write(dataDir, rel, archive(120));
    expect(archive(120).length).toBeGreaterThan(12_000);
    await sync(ctx, { llmGraph: false });
    const meta = readSidecarPart(dataDir, rel, 'meta');
    writeSidecarPart(dataDir, rel, 'tier1', { status: 'done', entities: [], relations: [], claims: [], model: 'old', contentSha: meta!.contentSha256, extractedAt: '2026-09-15T00:00:00.000Z' });
    await sync(ctx, {});
    const queued = await ctx.store.query<{ path: string; segments_total: number }>(
      `SELECT d.path, q.segments_total FROM extraction_queue q JOIN documents d ON d.id = q.document_id`,
    );
    expect(queued).toEqual([expect.objectContaining({ path: rel })]);
    expect(queued[0].segments_total).toBeGreaterThan(1);
  });
});

/** A document declaring `statements` as claims about `subject`. */
const claimsDoc = (subject: string, statements: string[]) =>
  [
    '---',
    `title: ${subject}`,
    'entities:',
    `  - { name: ${subject}, type: organization }`,
    'claims:',
    ...statements.map((s) => `  - { subject: ${subject}, statement: ${JSON.stringify(s)} }`),
    '---',
    `# ${subject}`,
    '',
  ].join('\n');

/** A judge that calls every pair it is shown the same, and records them. */
function sameJudge(shown: string[]): LlmClient {
  const complete = async (messages: { role: string; content: string }[]) => {
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    const pairs = [...user.matchAll(/Pair \d+ — subject: [^\n]*\nA: "([^"]*)"[\s\S]*?\nB: "([^"]*)"/g)].map((m) => [m[1], m[2]].sort().join(' | '));
    shown.push(...pairs);
    return JSON.stringify({ verdicts: pairs.map((_, i) => ({ pair: i + 1, relation: 'same', confidence: 0.95, reason: '测试' })) });
  };
  return { enabled: true, label: 'stub', provider: 'openai', model: 'stub', complete } as unknown as LlmClient;
}

describe('Chinese restatements without real vectors', () => {
  const dataDir = path.join(tmp, 'cjk-wording');
  let ctx: AppContext;
  // no number with a unit and no period in common: only the wording brings these up
  const restated = ['甲公司计划扩大海外产能，重点布局东南亚市场', '甲公司计划在东南亚市场扩大海外产能'];
  // worded alike, about different years
  const years = ['甲公司2024年海外收入占比提升', '甲公司2025年海外收入占比提升'];
  // worded alike, with different figures
  const figures = ['甲公司在隔夜交易中收跌2.15%', '甲公司在隔夜交易中收涨0.45%'];
  const other = '甲公司计划回购股份';

  beforeAll(async () => {
    initDataDir(dataDir);
    write(dataDir, 'raw/docs/one.md', claimsDoc('甲公司', [restated[0], years[0], figures[0], other]));
    write(dataDir, 'raw/docs/two.md', claimsDoc('甲公司', [restated[1], years[1], figures[1]]));
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });
  });
  afterAll(async () => {
    await ctx?.datasources.closeAll();
    await ctx?.store.close();
  });

  it('merges a restatement, keeps other years apart without a model, and leaves other figures to a person', async () => {
    expect(ctx.embedder.model).toBe('local-hash-v1');
    const shown: string[] = [];
    const stats = await auditDuplicateClaims({ store: ctx.store, embedder: ctx.embedder, config: ctx.config, llm: sameJudge(shown) });
    expect(stats).toMatchObject({ candidates: 3, differentTime: 1, judged: 2, merged: 1, suggested: 1, conflicts: 0 });
    // the pair no guard holds back goes first
    expect(shown).toEqual([restated.slice().sort().join(' | '), figures.slice().sort().join(' | ')]);

    const merges = await listClaimMerges(ctx.store);
    expect(merges).toHaveLength(1);
    expect(new Set([merges[0].statement, merges[0].canonicalStatement])).toEqual(new Set(restated));
    const pending = (await listSuggestions(ctx.store, {})).filter((s) => s.kind === 'claim-merge' && s.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].body).toContain(figures[0]);
    const live = (await queryClaims(ctx.store, { subject: '甲公司', limit: 50 })).claims.map((c) => c.statement);
    for (const s of [...years, ...figures, other]) expect(live).toContain(s);
  });
});

describe('near-duplicate statements while claim merging is off', () => {
  const dataDir = path.join(tmp, 'cjk-near-duplicates');
  let ctx: AppContext;

  beforeAll(async () => {
    initDataDir(dataDir);
    write(dataDir, 'raw/docs/one.md', claimsDoc('乙公司', ['乙公司计划扩大海外产能，重点布局东南亚市场', '乙公司计划回购股份']));
    write(dataDir, 'raw/docs/two.md', claimsDoc('乙公司', ['乙公司计划在东南亚市场扩大海外产能', '乙公司计划提高分红比例']));
    ctx = await createContext(dataDir);
    ctx.config.review.claimMerge = 'off';
    await sync(ctx, { llmGraph: false });
  });
  afterAll(async () => {
    await ctx?.datasources.closeAll();
    await ctx?.store.close();
  });

  it('flags a Chinese restatement from another source, and no other pair', async () => {
    await refineWiki(ctx.store, ctx.config, ctx.llm, { embedder: ctx.embedder });
    const flagged = (await listSuggestions(ctx.store, {})).filter((s) => s.title.startsWith('多来源相似断言待核对'));
    expect(flagged).toHaveLength(1);
    expect(flagged[0].body).toContain('乙公司计划扩大海外产能，重点布局东南亚市场');
    expect(flagged[0].body).toContain('乙公司计划在东南亚市场扩大海外产能');
  });
});

describe('merging duplicate claims', () => {
  const dataDir = path.join(tmp, 'claims');
  let fake: FakeOpenAi;
  let ctx: AppContext;

  const docs: Record<string, string> = {
    a: '德明利2025年营收107.89亿元，同比增长126%。',
    b: '德明利 2025 年营收 107.89 亿元, 同比增长 126%',
    c: '2025年德明利实现营业收入107.89亿元',
    d: '德明利2024年营收同比增长126%',
    e: '德明利2025年营收120亿元，同比增长126%',
  };

  const answer = (request: ChatRequest): string => {
    const system = systemOf(request);
    const user = userOf(request);
    if (system.includes('Summarize the document')) return 'Summary.';
    if (system.includes('You compare pairs of factual claims')) {
      const verdicts = [...user.matchAll(/Pair (\d+) — subject: [^\n]*\nA: "([^"]*)"[\s\S]*?\nB: "([^"]*)"/g)].map((m) => {
        const [a, b] = [m[2], m[3]];
        if (a.includes('120亿') || b.includes('120亿')) return { pair: Number(m[1]), relation: 'conflict', confidence: 0.85, reason: '营收数字不一致' };
        if (a.includes('107.89') && b.includes('107.89')) return { pair: Number(m[1]), relation: 'same', keep: a.length >= b.length ? 'a' : 'b', confidence: 0.95, reason: '同一营收数字' };
        return { pair: Number(m[1]), relation: 'unrelated', confidence: 0.3, reason: '无关' };
      });
      return JSON.stringify({ verdicts });
    }
    if (!system.includes('knowledge-graph extraction engine')) return JSON.stringify({});
    const doc = /\(raw\/docs\/(\w)\.md\)/.exec(user)?.[1] ?? '';
    const statement = docs[doc];
    if (!statement) return JSON.stringify({ entities: [], relations: [], claims: [] });
    return JSON.stringify({
      entities: [{ name: '德明利', type: 'organization', aliases: [] }],
      relations: [],
      claims: [{ subject: '德明利', statement, type: doc === 'c' ? 'financials' : 'earnings', status: 'fact' }],
    });
  };

  beforeAll(async () => {
    fake = await startFakeOpenAi({ answer });
    const base = defaultConfig();
    const route = { ...defaultRoutedLlmConfig(), use: 'connection-1' };
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'knode.config.json'), JSON.stringify({
      ...base,
      connections: [fakeModel(fake.url)],
      llmUse: 'connection-1',
      extraction: { ...base.extraction, entityLlm: route, documentLlm: route, summaryLlm: route, judgeLlm: route },
    }));
    ensureDefaultAgents(dataDir);
    for (const [k, v] of Object.entries(docs)) write(dataDir, `raw/docs/${k}.md`, `# ${k}\n\n${v}\n`);
    ctx = await createContext(dataDir);
    await sync(ctx, {});
  });

  afterAll(async () => {
    await ctx?.datasources.closeAll();
    await ctx?.store.close();
    await fake?.close();
  });

  it('merges identical and judged-same wordings, keeps other periods apart, flags the contradiction', async () => {
    const before = fake.calls.length;
    const pass = await runDocumentPass(ctx);
    expect(pass.processed).toBe(5);
    // d (2024) against a, b and e (2025) is settled without a model
    expect(pass.claims).toMatchObject({ identical: 1, differentTime: 3, merged: 2, conflicts: 1 });
    // one judge call for every pair that needed one
    expect(fake.calls.slice(before).filter((c) => systemOf(c).includes('You compare pairs of factual claims'))).toHaveLength(1);

    const res = await queryClaims(ctx.store, { subject: '德明利', limit: 50 });
    expect(res.claims).toHaveLength(3);
    const rep = res.claims.find((c) => c.statement.includes('107.89'))!;
    expect(rep.evidenceCount).toBe(3);
    expect(rep.sources).toEqual(['raw/docs/a.md', 'raw/docs/b.md', 'raw/docs/c.md']);
    expect(res.claims.some((c) => c.statement === docs.d)).toBe(true);
    expect(res.claims.some((c) => c.statement === docs.e)).toBe(true);

    const conflict = (await listSuggestions(ctx.store, {})).filter((s) => s.title.startsWith('矛盾的断言'));
    expect(conflict).toHaveLength(1);
    expect((await listClaimMerges(ctx.store)).length).toBe(2);
  });

  it('never judges a pair twice', async () => {
    const before = fake.calls.length;
    const { auditDuplicateClaims } = await import('../src/graph/claim-dedupe.js');
    const again = await auditDuplicateClaims(ctx, {});
    expect(again).toMatchObject({ judged: 0, merged: 0, conflicts: 0 });
    expect(fake.calls.length).toBe(before);
  });

  it('undoes a merge exactly', async () => {
    const [member] = await listClaimMerges(ctx.store);
    expect(await unmergeClaim(ctx.store, member.claimId)).toBe(true);
    const res = await queryClaims(ctx.store, { subject: '德明利', limit: 50 });
    expect(res.claims).toHaveLength(4);
    expect(res.claims.find((c) => c.id === member.canonicalId)?.evidenceCount).toBe(2);
    expect(res.claims.find((c) => c.id === member.claimId)?.evidenceCount).toBe(1);
  });

  it('only suggests a judged merge in suggest mode, and merges when the suggestion is accepted', async () => {
    ctx.config.review.claimMerge = 'suggest';
    write(dataDir, 'raw/docs/f.md', '# f\n\n德明利2025年实现营收107.89亿元\n');
    docs.f = '德明利2025年实现营收107.89亿元';
    await sync(ctx, {});
    const pass = await runDocumentPass(ctx);
    expect(pass.claims?.merged).toBe(0);
    const pending = (await listSuggestions(ctx.store, {})).filter((s) => s.kind === 'claim-merge' && s.status === 'pending');
    expect(pending.length).toBeGreaterThan(0);
    const applied = await applySuggestion(ctx.store, dataDir, pending[0].id);
    expect(applied.applied).toBe(true);
    const merges = await listClaimMerges(ctx.store);
    expect(merges.some((m) => m.statement === docs.f || m.canonicalStatement === docs.f)).toBe(true);
  });

  it('keeps its merges through a rebuild (they are ledger feedback)', async () => {
    const shape = async () => (await listClaimMerges(ctx.store)).map((m) => `${m.claimId}>${m.canonicalId}`).sort();
    const before = await shape();
    const before2 = (await queryClaims(ctx.store, { subject: '德明利', limit: 50 })).claims.map((c) => `${c.id}:${c.evidenceCount}`).sort();
    const report = await rebuild(ctx);
    expect(report.feedbackReplayed).toBeGreaterThan(0);
    expect(await shape()).toEqual(before);
    expect((await queryClaims(ctx.store, { subject: '德明利', limit: 50 })).claims.map((c) => `${c.id}:${c.evidenceCount}`).sort()).toEqual(before2);
  });

  it('moves a group onto a member when its representative loses its own source', async () => {
    const merged = new Set((await listClaimMerges(ctx.store)).map((m) => m.canonicalId));
    const rep = (await queryClaims(ctx.store, { subject: '德明利', limit: 50 })).claims.find((c) => merged.has(c.id))!;
    expect(rep.evidenceCount).toBeGreaterThan(1);
    const own = await ctx.store.query<{ key: string }>(
      `SELECT s.key FROM evidence e JOIN scopes s ON s.id = e.scope_id WHERE e.kind = 'claim' AND e.target_id = $1 AND e.tx_to IS NULL`,
      [rep.id],
    );
    for (const { key } of own) fs.rmSync(path.join(dataDir, key));
    await sync(ctx, {});
    // still standing on its members' evidence until the nightly run
    const standing = (await queryClaims(ctx.store, { subject: '德明利', limit: 50 })).claims.find((c) => c.id === rep.id);
    expect(standing?.evidenceCount).toBe(rep.evidenceCount - own.length);

    const { auditDuplicateClaims } = await import('../src/graph/claim-dedupe.js');
    const night = await auditDuplicateClaims(ctx, {});
    expect(night.reanchored).toBe(1);
    const after = (await queryClaims(ctx.store, { subject: '德明利', limit: 50 })).claims;
    expect(after.some((c) => c.id === rep.id)).toBe(false);
    const moved = after.find((c) => c.sources.length === rep.evidenceCount - own.length && c.statement.includes('107.89'));
    expect(moved).toBeDefined();
  });
});
