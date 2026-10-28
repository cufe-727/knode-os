import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, defaultRoutedLlmConfig, loadConfig, LlmConnection } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { readTranslation, readTranslationParts, sidecarHoldsPaidWork } from '../src/fs/sidecar.js';
import { documentIdFor } from '../src/ingest/apply.js';
import { loadSourceText, sha256 } from '../src/ingest/source.js';
import { sync } from '../src/ingest/sync.js';
import { detectLanguage, detectTextLanguage } from '../src/lang/detect.js';
import { contentLanguages, normalizeLanguage, normalizeLanguagesConfig } from '../src/lang/languages.js';
import { protectSpans, restoreSpans } from '../src/lang/protect.js';
import {
  dueTranslations, finishSegment, pendingSegments, planTranslation, recordTranslationState, splitFrontmatter, storeSegment, translateNow, translationRequest, translationRow,
} from '../src/lang/translate.js';
import { WorkerIdentity } from '../src/labeling/scheduler.js';
import { LlmClient } from '../src/llm/client.js';
import { ensureDefaultAgents } from '../src/research/agents.js';
import { createApp } from '../src/server/app.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';
import { DocumentRow } from '../src/types.js';
import { detectSummaryLanguage, planSummary, summaryStepRequest } from '../src/wiki/summary.js';
import { TranslateSource } from '../src/work/translate.js';

/**
 * Content languages (docs/design/17): what a document is written in, the
 * tokens that keep links and anchors out of a model's hands, translations
 * planned segment by segment and kept by hash, the leased Translate stage,
 * the reader's file API and the settings that turn it on.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-languages-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** A "translation" into Chinese that keeps every token: each Latin word becomes two characters. */
const toChinese = (text: string) => text.replace(/[A-Za-z][A-Za-z'’-]*/g, '译文');

/** The text a translation request carries, after its marker. */
const requestText = (messages: { role: string; content: string }[]) => {
  const user = messages.filter((m) => m.role === 'user').at(-1)!.content;
  return user.slice(user.indexOf('=== TEXT ===\n') + '=== TEXT ===\n'.length);
};

const fakeLlm = (answer: (text: string) => string): LlmClient =>
  ({ enabled: true, label: 'fake:translator', complete: async (messages: { role: string; content: string }[]) => answer(requestText(messages)) }) as unknown as LlmClient;

/** An English filing long enough for several translation segments, with the anchors and links a wiki page cites. */
function englishFiling(): string {
  const sections: string[] = ['---\ntitle: "Annual report"\nplatform: sec\n---\n', '# Annual report\n'];
  for (let i = 1; i <= 30; i++) {
    sections.push(
      `<a id="e-${String(i).padStart(8, '0')}"></a>\n## Section ${i}: revenue and costs\n\n` +
        `The company reported that revenue grew in the quarter while the cost of compute was rising faster than expected, and the board said that the outlook for the next year depends on capacity. ` +
        `See [the filing](https://www.sec.gov/Archives/edgar/data/${i}/report.htm) and the table below for the figures that were reported to investors.\n\n` +
        `| Item | Value |\n| --- | --- |\n| Revenue | ${i * 100} |\n| Cost | ${i * 70} |\n\n` +
        `![chart of revenue](https://example.com/charts/${i}.png)\n\n` +
        `The management of the company believes that the demand for its products will continue, and it expects that the margin will improve as the scale of the business increases over time.\n`,
    );
  }
  return sections.join('\n');
}

describe('detecting a document\'s language', () => {
  it('reads what a reader reads: a Chinese digest full of image URLs is Chinese', () => {
    const digest = [
      '---\ntitle: "飞书 · 邢者-向北 · 2026-04-19"\nplatform: feishu\n---\n',
      ...Array.from({ length: 12 }, (_, i) => `<a id="e-${i}"></a>\n## 10:${10 + i} · cli_c08abc1da138d00f\n\n盘中异动[图片]\n\n- image: 图片 (https://rookie-trade.lemoncheese.cc/api/entries/feishu%3Aoc_89909bff61f54d301f88da9a611ecc11%3Aom_x100b5177f53050a4b108e8511af0594/attachments/${i})\n`),
    ].join('\n');
    expect(detectTextLanguage(digest)).toBe('zh');
    // and the summary scaffold follows the same reading
    expect(detectSummaryLanguage(digest)).toBe('zh');
  });

  it('tells Latin-script languages apart by their function words, and knows scripts', () => {
    expect(detectTextLanguage('The market priced in another rate cut while small caps lagged, and the yield curve was flat.')).toBe('en');
    expect(detectTextLanguage('Le marché a anticipé une nouvelle baisse des taux et les petites capitalisations sont restées à la traîne dans la séance.')).toBe('fr');
    expect(detectTextLanguage('Der Markt hat eine weitere Zinssenkung eingepreist, und die kleinen Werte sind nicht mit dem Index gestiegen.')).toBe('de');
    expect(detectTextLanguage('El mercado descontó otro recorte de tipos y las pequeñas empresas se quedaron atrás en la sesión, como se esperaba.')).toBe('es');
    expect(detectTextLanguage('Рынок заложил ещё одно снижение ставки, а акции малых компаний отстали.')).toBe('ru');
    expect(detectTextLanguage('東京市場は利上げ観測で続落した。半導体株が重い。')).toBe('ja');
    expect(detectTextLanguage('코스피는 금리 인상 우려로 하락했다. 반도체가 약세였다.')).toBe('ko');
    expect(detectTextLanguage('NVDA、TSLA、AAPL 同步回调，纳指跌 2%。')).toBe('zh');
    expect(detectTextLanguage('| 1 | 2 |\n| --- | --- |\n| 3.5 | 4 |')).toBeNull();
  });

  it('takes a declared language it knows over the text', () => {
    expect(detectLanguage('懂王的关税政策。', { lang: 'en-US' })).toBe('en');
    expect(detectLanguage('懂王的关税政策。', { language: 'zh-TW' })).toBe('zh-Hant');
    expect(detectLanguage('懂王的关税政策。', { language: 'tlh' })).toBe('zh');
  });

  it('normalizes language tags', () => {
    expect(normalizeLanguage('zh-CN')).toBe('zh');
    expect(normalizeLanguage('zh-Hans')).toBe('zh');
    expect(normalizeLanguage('zh_TW')).toBe('zh-Hant');
    expect(normalizeLanguage('zh-Hant-HK')).toBe('zh-Hant');
    expect(normalizeLanguage('EN-us')).toBe('en');
    expect(normalizeLanguage('pt_BR')).toBe('pt');
    expect(normalizeLanguage('xx')).toBeNull();
    expect(normalizeLanguagesConfig({ enabled: true, primary: 'zh-CN', secondary: ['en', 'zh', 'EN', 'xx'], maxChars: -1 }))
      .toEqual({ enabled: true, primary: 'zh', secondary: ['en'], maxChars: 200_000 });
    expect(contentLanguages({ languages: { enabled: true, primary: '', secondary: ['en'] } }).on).toBe(false);
    expect(contentLanguages({ languages: { enabled: true, primary: 'zh', secondary: ['en'] } }).offered).toEqual(['zh', 'en']);
  });
});

describe('the tokens a translation keeps', () => {
  const text = [
    '<a id="e-8520909f"></a>',
    '## Revenue `ARR` and [[Anthropic]]',
    '',
    'See [the filing](https://www.sec.gov/a.htm "S-1") and ![chart](img/c.png), or https://example.com/x?y=1.[^1]',
    '',
    '```chart',
    '{"type": "bar", "title": "Revenue"}',
    '```',
    '',
    '[^1]: Source, 2026.',
  ].join('\n');

  it('swaps links, anchors, code, wikilinks and footnote marks for tokens and back', () => {
    const p = protectSpans(text);
    expect(p.text).not.toContain('https://');
    expect(p.text).not.toContain('e-8520909f');
    expect(p.text).not.toContain('"bar"');
    expect(p.text).toContain('[the filing]⟦');
    expect(p.text).toContain('Revenue');
    expect(p.spans.length).toBeGreaterThanOrEqual(8);
    const back = restoreSpans(p.text, p.spans);
    expect(back).toEqual({ text, missing: [] });
  });

  it('says which tokens an answer lost, and drops the ones it made up', () => {
    const p = protectSpans(text);
    const lost = restoreSpans(p.text.replace('⟦1⟧', '').replace('⟦2⟧', '⟦2⟧ ⟦99⟧'), p.spans);
    expect(lost.missing).toEqual([1]);
    expect(lost.text).not.toContain('⟦99⟧');
  });
});

describe('a translation, planned and kept', () => {
  const dataDir = path.join(tmp, 'plan');
  const rel = 'raw/docs/filing.md';
  let doc: Pick<DocumentRow, 'id' | 'path' | 'root' | 'sha256'>;

  beforeAll(() => {
    write(dataDir, rel, englishFiling());
    doc = { id: documentIdFor(rel), path: rel, root: 'docs', sha256: sha256(loadSourceText(dataDir, rel, 'docs')!.text) };
  });
  const plan0Frontmatter = () => {
    const plan = planTranslation(dataDir, doc, 'zh');
    if (plan.kind !== 'work') throw new Error('no work');
    expect(plan.frontmatter).toContain('Annual report');
    return plan.frontmatter;
  };

  it('cuts the body into segments, keeps the frontmatter, and checks every answer', () => {
    const plan = planTranslation(dataDir, doc, 'zh');
    if (plan.kind !== 'work') throw new Error(`no work: ${plan.reason}`);
    expect(plan.source).toBe('en');
    expect(plan.frontmatter).toContain('title: "Annual report"');
    expect(plan.segments.length).toBeGreaterThanOrEqual(3);
    // the segments are the indexed body, whole; the frontmatter is the one the reader sees on the file
    expect(plan.segments.map((s) => s.text).join('')).toBe(splitFrontmatter(loadSourceText(dataDir, rel, 'docs')!.text).body);
    expect(plan.frontmatter).toBe('---\ntitle: "Annual report"\nplatform: sec\n---\n');

    const [first] = plan.segments;
    const request = translationRequest(plan, first);
    expect(request.messages[0].content).toContain('into Simplified Chinese');
    expect(request.messages[1].content).not.toContain('https://www.sec.gov');
    const text = requestText(request.messages);

    // a translation that lost a link, one far too short, one still in English
    expect(finishSegment(plan, first, request.spans, toChinese(text).replace('⟦1⟧', ''))).toMatchObject({ ok: false, error: expect.stringContaining('lost 1') });
    expect(finishSegment(plan, first, request.spans, `译文 ${request.spans.map((_, i) => `⟦${i + 1}⟧`).join(' ')}`)).toMatchObject({ ok: false, error: expect.stringContaining('much shorter') });
    expect(finishSegment(plan, first, request.spans, text)).toMatchObject({ ok: false, error: expect.stringContaining('still in English') });
    // a fenced answer is unwrapped; the anchors and links are back
    const finished = finishSegment(plan, first, request.spans, `\`\`\`markdown\n${toChinese(text)}\n\`\`\``);
    if (!finished.ok) throw new Error(finished.error);
    expect(finished.body).toContain('<a id="e-00000001"></a>');
    expect(finished.body).toContain('](https://www.sec.gov/Archives/edgar/data/1/report.htm)');
    expect(finished.body).not.toContain('Section');
  });

  it('keeps each segment by its hash, so an edit pays only for the segments it changed', async () => {
    const llm = fakeLlm(toChinese);
    let calls = 0;
    const counting = { ...llm, label: llm.label, enabled: true, complete: async (m: { role: string; content: string }[]) => { calls++; return toChinese(requestText(m)); } } as unknown as LlmClient;
    const q = { query: async () => [] } as never;
    const first = await translateNow(q, dataDir, doc, 'zh', counting);
    expect(first.status).toBe('done');
    const parts = first.parts;
    expect(calls).toBe(parts);
    const whole = readTranslation(dataDir, rel, 'zh')!;
    expect(whole).toMatchObject({ contentSha: doc.sha256, source: 'en', language: 'zh', parts });
    // the frontmatter stays as it is, ahead of the translated body
    expect(whole.body.startsWith(plan0Frontmatter())).toBe(true);
    expect(whole.body).toContain('<a id="e-00000014"></a>');
    expect(sidecarHoldsPaidWork(dataDir, rel)).toBe(true);

    // an appended section: only the last segment is new
    fs.appendFileSync(path.join(dataDir, rel), '\n## Outlook\n\nThe company expects that growth will continue next year.\n');
    const edited = { ...doc, sha256: sha256(loadSourceText(dataDir, rel, 'docs')!.text) };
    calls = 0;
    const second = await translateNow(q, dataDir, edited, 'zh', counting);
    expect(second.status).toBe('done');
    expect(calls).toBe(1);
    expect(readTranslation(dataDir, rel, 'zh')!.body).toContain('## 译文');
    expect(readTranslationParts(dataDir, rel, 'zh').size).toBe(second.parts);
  });

  it('has nothing to do for a document already in the language', () => {
    write(dataDir, 'raw/docs/zh.md', '# 季报\n\n宁德时代发布季度报告，营收同比增长。\n');
    const zh = { id: documentIdFor('raw/docs/zh.md'), path: 'raw/docs/zh.md', root: 'docs' as const, sha256: 'x' };
    expect(planTranslation(dataDir, zh, 'zh')).toMatchObject({ kind: 'none', reason: 'same-language', source: 'zh' });
    expect(planTranslation(dataDir, zh, 'zh-Hant')).toMatchObject({ kind: 'none', reason: 'same-language' });
    expect(planTranslation(dataDir, zh, 'en')).toMatchObject({ kind: 'work', source: 'zh' });
  });
});

/* ------------------------------ the stage ------------------------------ */

async function languagesWorkspace(name: string, languages: Record<string, unknown>): Promise<AppContext> {
  const dataDir = path.join(tmp, name);
  const model: LlmConnection = {
    id: 'connection-1', label: 'fake', provider: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-test',
    protocol: 'chat', model: 'fake-model', cliPath: '', effort: 'default', cliTimeoutMs: 30_000,
  };
  const base = defaultConfig();
  const route = { ...defaultRoutedLlmConfig(), use: 'connection-1' };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'knode.config.json'), JSON.stringify({
    ...base,
    connections: [model],
    llmUse: 'connection-1',
    extraction: { ...base.extraction, entityLlm: route, documentLlm: route, summaryLlm: route, judgeLlm: route, translateLlm: route },
    languages,
  }));
  ensureDefaultAgents(dataDir);
  write(dataDir, 'raw/docs/filing.md', englishFiling());
  write(dataDir, 'raw/docs/post.md', '# 复盘\n\n今天上传了一篇先进封装相关的深度研报，请大家参考。宁德时代发布季度报告，营收同比增长。\n');
  write(dataDir, 'raw/docs/numbers.csv.md', '| a | b |\n| --- | --- |\n| 1 | 2 |\n');
  // data with words in it: indexed, never translated
  write(dataDir, 'raw/docs/stress.csv', 'param,value,annual_volatility,max_drawdown,win_rate\nentry_fill,mid,0.0188,-0.0413,0.965\nentry_fill,natural,0.0189,-0.0428,0.965\n');
  const ctx = await createContext(dataDir);
  await sync(ctx, {});
  return ctx;
}

describe('the Translate stage as leased work', () => {
  let ctx: AppContext;
  let source: TranslateSource;
  const mac: WorkerIdentity = { worker: 'macbook/codex#1', backend: 'codex', remote: true };
  const box: WorkerIdentity = { worker: 'aliyun/api#1', backend: 'api', remote: true };

  beforeAll(async () => {
    ctx = await languagesWorkspace('stage', { enabled: true, primary: 'zh', secondary: ['en'] });
    source = new TranslateSource({ dataDir: ctx.dataDir, store: ctx.store, config: () => ctx.config }, { leaseMs: 1_000, modelRetryMs: 0, transientRetryMs: 0, idleScanMs: 0 });
  });
  afterAll(async () => {
    await source?.stop();
    await ctx?.store.close();
  });

  it('records every document\'s language on apply', async () => {
    const rows = await ctx.store.query<{ path: string; language: string }>(`SELECT path, language FROM documents WHERE root = 'docs' ORDER BY path`);
    expect(Object.fromEntries(rows.map((r) => [r.path, r.language]))).toEqual({
      'raw/docs/filing.md': 'en', 'raw/docs/numbers.csv.md': '', 'raw/docs/post.md': 'zh', 'raw/docs/stress.csv': 'en',
    });
  });

  it('hands out the segments of documents not in the primary language, several workers at once, and writes the translation once all are in', async () => {
    const tasks = await source.lease(mac, 8);
    expect(tasks.length).toBeGreaterThanOrEqual(3);
    expect(new Set(tasks.map((t) => t.label.split(' → ')[0]))).toEqual(new Set(['raw/docs/filing.md']));
    expect(tasks[0]).toMatchObject({ kind: 'translate', json: false });
    expect(tasks[0].prompt).toContain('into Simplified Chinese');
    // the rest goes to the next worker
    const more = await source.lease(box, 8);
    const all = [...tasks, ...more];
    const plan = planTranslation(ctx.dataDir, (await ctx.store.query<DocumentRow>(`SELECT * FROM documents WHERE path = 'raw/docs/filing.md'`))[0], 'zh');
    if (plan.kind !== 'work') throw new Error('no work');
    expect(all.length).toBe(plan.segments.length);

    // one answer that lost an anchor uses an attempt and goes out again
    const [bad, ...good] = all;
    expect(await source.complete(bad.id, tasks.includes(bad) ? mac : box, { ok: true, text: toChinese(requestText(bad.messages)).replace(/⟦1⟧/, '') })).toEqual({ accepted: true });
    const id = documentIdFor('raw/docs/filing.md');
    expect(await translationRow(ctx.store, id, 'zh')).toMatchObject({ status: 'failed', attempts: 1 });
    for (const t of good) {
      expect(await source.complete(t.id, tasks.includes(t) ? mac : box, { ok: true, text: toChinese(requestText(t.messages)), model: 'codex:gpt-test' })).toEqual({ accepted: true });
    }
    expect(await translationRow(ctx.store, id, 'zh')).toMatchObject({ status: 'partial', done: plan.segments.length - 1 });
    const [retry] = await source.lease(mac, 8);
    expect(retry.label).toBe(bad.label);
    expect(await source.complete(retry.id, mac, { ok: true, text: toChinese(requestText(retry.messages)) })).toEqual({ accepted: true });
    expect(await translationRow(ctx.store, id, 'zh')).toMatchObject({ status: 'done', done: plan.segments.length, parts: plan.segments.length });
    expect(readTranslation(ctx.dataDir, 'raw/docs/filing.md', 'zh')?.model).toContain('remote:codex:gpt-test');
    // Chinese needs nothing; a secondary language waits for a request
    expect(await source.lease(mac, 8)).toEqual([]);
    expect((await source.status()).totals).toMatchObject({ documents: 1, failed: expect.objectContaining({ model: 1 }) });
  });

  it('translates into a secondary language once someone asks, and leaves the request standing for later versions', async () => {
    const [post] = await ctx.store.query<DocumentRow>(`SELECT * FROM documents WHERE path = 'raw/docs/post.md'`);
    await recordTranslationState(ctx.store, post, 'en', { status: 'requested', requested: true });
    source.wake();
    const [task] = await source.lease(box, 8);
    expect(task.label).toBe('raw/docs/post.md → en');
    expect(task.prompt).toContain('from Simplified Chinese into English');
    const english = 'Recap\n\nToday I uploaded an in-depth research report on advanced packaging for your reference. CATL released its quarterly report, and revenue grew year on year.';
    expect(await source.complete(task.id, box, { ok: true, text: `# ${english}` })).toEqual({ accepted: true });
    expect(readTranslation(ctx.dataDir, 'raw/docs/post.md', 'en')?.body).toContain('CATL released');
    expect((await translationRow(ctx.store, post.id, 'en'))?.requested).toBe(true);
    const { due } = await dueTranslations(ctx.store, contentLanguages(ctx.config), { limit: 10 });
    expect(due).toEqual([]);
  });

  it('drops an answer for a document that changed while it was out', async () => {
    write(ctx.dataDir, 'raw/docs/memo.md', '# Memo\n\nThe board approved the plan to expand capacity in the next quarter, and the company said that demand was strong.\n');
    await sync(ctx, { only: ['raw/docs/memo.md'] });
    source.wake();
    const [task] = await source.lease(mac, 1);
    expect(task.label).toBe('raw/docs/memo.md → zh');
    write(ctx.dataDir, 'raw/docs/memo.md', '# Memo\n\nThe board approved a different plan, and the company said that demand was weaker than expected.\n');
    await sync(ctx, { only: ['raw/docs/memo.md'] });
    const stale = (await source.status()).totals.stale;
    expect(await source.complete(task.id, mac, { ok: true, text: toChinese(requestText(task.messages)) })).toEqual({ accepted: true });
    expect((await source.status()).totals.stale).toBe(stale + 1);
    expect(readTranslation(ctx.dataDir, 'raw/docs/memo.md', 'zh')).toBeNull();
    const [fresh] = await source.lease(mac, 1);
    expect(requestText(fresh.messages)).toContain('weaker than expected');
  });

  it('reads the language of documents indexed before it was recorded, then translates what is foreign', async () => {
    write(ctx.dataDir, 'raw/docs/old.md', 'The fund said that it had reduced its position in the company during the quarter, and that it expects lower returns.\n');
    await sync(ctx, { only: ['raw/docs/old.md'] });
    // as a row from before schema v17 has it
    await ctx.store.query(`UPDATE documents SET language = NULL WHERE path IN ('raw/docs/old.md', 'raw/docs/post.md')`);
    source.wake();
    const [task] = await source.lease(mac, 1);
    expect(task.label).toBe('raw/docs/old.md → zh');
    const rows = await ctx.store.query<{ path: string; language: string }>(`SELECT path, language FROM documents WHERE path IN ('raw/docs/old.md', 'raw/docs/post.md') ORDER BY path`);
    expect(rows.map((r) => [r.path, r.language])).toEqual([['raw/docs/old.md', 'en'], ['raw/docs/post.md', 'zh']]);
    expect(await source.complete(task.id, mac, { ok: true, text: toChinese(requestText(task.messages)) })).toEqual({ accepted: true });
    // a file without frontmatter gets none in its translation: the lines the index adds are not the reader's
    expect(readTranslation(ctx.dataDir, 'raw/docs/old.md', 'zh')?.body.startsWith('译文')).toBe(true);
  });

  it('hands out nothing while content languages are off', async () => {
    const off = await languagesWorkspace('off', { enabled: false, primary: 'zh' });
    const idle = new TranslateSource({ dataDir: off.dataDir, store: off.store, config: () => off.config }, { idleScanMs: 0 });
    try {
      expect(await idle.lease(mac, 8)).toEqual([]);
      expect((await idle.status()).enabled).toBe(false);
    } finally {
      await idle.stop();
      await off.store.close();
    }
  });
});

describe('summaries in the primary language', () => {
  it('writes an English document\'s page in Chinese when Chinese is primary', async () => {
    const ctx = await languagesWorkspace('summary', { enabled: true, primary: 'zh', secondary: ['en'] });
    try {
      const [filing] = await ctx.store.query<DocumentRow>(`SELECT * FROM documents WHERE path = 'raw/docs/filing.md'`);
      const plan = await planSummary(ctx.store, ctx.dataDir, { ...ctx.config, extraction: { ...ctx.config.extraction, summaryMinChars: 0 } }, filing);
      if (plan.kind === 'none') throw new Error(plan.reason);
      expect(plan.language).toBe('zh');
      const step = plan.kind === 'single' ? { kind: 'single' as const } : { kind: 'part' as const, index: 0, sha: plan.segments[0].sha };
      const call = await summaryStepRequest(plan, step as never, ctx.dataDir);
      expect(call.messages[0].content).toContain('Write in Simplified Chinese.');
      expect(call.messages[0].content).toContain('## 要点');
    } finally {
      await ctx.store.close();
    }
  });
});

/* ------------------------------ the reader ------------------------------ */

describe('reading a document in another language', () => {
  const root = path.join(tmp, 'api');
  const workspaceDir = path.join(root, 'users', 'admin', 'workspaces', 'default');
  const headers = { 'x-knode-user': 'admin', 'x-knode-workspace-kind': 'personal', 'x-knode-workspace-id': 'default', 'x-knode-workspace-name': 'Default' };
  const jsonHeaders = { ...headers, 'content-type': 'application/json' };
  let rootCtx: AppContext;
  let registry: WorkspaceContextRegistry;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    rootCtx = await createContext(root);
    registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
    app = createApp(rootCtx, () => {}, registry);
    await app.request('/api/workspaces', { headers: { 'x-knode-user': 'admin' } });
    write(workspaceDir, 'raw/docs/filing.md', englishFiling());
    write(workspaceDir, 'raw/docs/post.md', '# 复盘\n\n今天上传了一篇先进封装相关的深度研报，请大家参考。\n');
    expect((await app.request('/api/sync', { method: 'POST', headers: jsonHeaders, body: '{}' })).status).toBe(200);
  });
  afterAll(async () => {
    await registry.closeAll();
    await rootCtx.store.close();
  });

  const file = async (p: string, lang?: string) =>
    (await app.request(`/api/file?path=${encodeURIComponent(p)}${lang ? `&lang=${lang}` : ''}`, { headers })).json() as Promise<Record<string, any>>;

  it('says nothing about languages while they are off, and refuses a request', async () => {
    expect((await file('raw/docs/filing.md')).languages).toBeUndefined();
    const r = await app.request('/api/file/translate', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ path: 'raw/docs/filing.md', lang: 'zh' }) });
    expect(r.status).toBe(409);
  });

  it('takes the languages in the settings, refusing one it does not know', async () => {
    const bad = await app.request('/api/config', { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ languages: { enabled: true, primary: 'klingon' } }) });
    expect(bad.status).toBe(400);
    const none = await app.request('/api/config', { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ languages: { enabled: true, primary: '' } }) });
    expect(none.status).toBe(400);
    const ok = await app.request('/api/config', { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ languages: { enabled: true, primary: 'zh-CN', secondary: ['en'] }, extraction: { translateConcurrency: 0 } }) });
    expect(ok.status).toBe(200);
    const saved = loadConfig(workspaceDir);
    expect(saved.languages).toEqual({ enabled: true, primary: 'zh', secondary: ['en'], maxChars: 200_000 });
    expect(saved.extraction.translateConcurrency).toBe(0);
    // a route from before the stage started as the Summarize stage's
    expect(saved.extraction.translateLlm.use).toBe(saved.extraction.summaryLlm.use);
    const list = await (await app.request('/api/languages', { headers })).json() as Record<string, any>;
    expect(list).toMatchObject({ enabled: true, primary: 'zh', offered: ['zh', 'en'] });
    expect(list.languages.find((l: { code: string }) => l.code === 'zh-Hant').native).toBe('繁體中文');
  });

  it('shows the original with where each translation stands, then the translation once it is in', async () => {
    const before = await file('raw/docs/filing.md', 'zh');
    expect(before.languages).toMatchObject({ source: 'en', primary: 'zh', offered: ['zh', 'en'], shown: 'en', translations: { zh: { status: 'none' }, en: { status: 'source' } } });
    expect(before.translation).toBeUndefined();

    const text = loadSourceText(workspaceDir, 'raw/docs/filing.md', 'docs')!.text;
    const doc = { id: documentIdFor('raw/docs/filing.md'), path: 'raw/docs/filing.md', root: 'docs' as const, sha256: sha256(text) };
    const plan = planTranslation(workspaceDir, doc, 'zh');
    if (plan.kind !== 'work') throw new Error('no work');
    // half of it in: the rest reads as the original
    const [first] = pendingSegments(plan);
    const request = translationRequest(plan, first);
    const finished = finishSegment(plan, first, request.spans, toChinese(requestText(request.messages)));
    if (!finished.ok) throw new Error(finished.error);
    storeSegment(workspaceDir, plan, first, finished.body, 'fake:translator');
    const partial = await file('raw/docs/filing.md', 'zh');
    expect(partial.languages.shown).toBe('zh');
    expect(partial.translation).toMatchObject({ language: 'zh', done: 1, parts: plan.segments.length });
    expect(partial.content).toContain('译文');
    expect(partial.content).toContain('The management of the company');

    for (const s of pendingSegments(plan)) {
      const r = translationRequest(plan, s);
      const f = finishSegment(plan, s, r.spans, toChinese(requestText(r.messages)));
      if (!f.ok) throw new Error(f.error);
      storeSegment(workspaceDir, plan, s, f.body, 'fake:translator');
    }
    const whole = await file('raw/docs/filing.md', 'zh');
    expect(whole.translation).toMatchObject({ done: plan.segments.length, parts: plan.segments.length });
    expect(whole.content).not.toContain('The management of the company');
    expect(whole.content).toContain('<a id="e-00000007"></a>');
    expect((await file('raw/docs/filing.md')).languages.translations.zh).toMatchObject({ status: 'done', model: 'fake:translator' });
  });

  it('queues a request for a secondary language, and refuses the document\'s own', async () => {
    const own = await app.request('/api/file/translate', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ path: 'raw/docs/post.md', lang: 'zh' }) });
    expect(own.status).toBe(400);
    const other = await app.request('/api/file/translate', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ path: 'raw/docs/post.md', lang: 'fr' }) });
    expect(other.status).toBe(400);
    const r = await app.request('/api/file/translate', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ path: 'raw/docs/post.md', lang: 'en' }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, status: 'requested', processing: false });
    expect((await file('raw/docs/post.md', 'en')).languages).toMatchObject({ source: 'zh', shown: 'zh', translations: { en: { status: 'requested', requested: true } } });
    const cancel = await app.request('/api/file/translate', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ path: 'raw/docs/post.md', lang: 'en', cancel: true }) });
    expect(cancel.status).toBe(200);
    expect((await file('raw/docs/post.md')).languages.translations.en.requested).toBe(false);
  });

  it('lists a workspace language the document is written in already as the document\'s own', async () => {
    const r = await app.request('/api/config', { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ languages: { primary: 'zh-TW' } }) });
    expect(r.status).toBe(200);
    const post = await file('raw/docs/post.md', 'zh-Hant');
    expect(post.languages).toMatchObject({ source: 'zh', primary: 'zh-Hant', offered: ['zh', 'en'], shown: 'zh', translations: { zh: { status: 'source' } } });
    expect(post.translation).toBeUndefined();
  });
});
