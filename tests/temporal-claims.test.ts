import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { readSidecarPart } from '../src/fs/sidecar.js';
import { claimsForEntities } from '../src/graph/query.js';
import { dateFromContent, dateFromPath, docDateOf } from '../src/ingest/docdate.js';
import { sync } from '../src/ingest/sync.js';
import { queryClaims } from '../src/store/claims.js';
import { normalizeDateExpr } from '../src/store/dates.js';
import { resolveTemporal } from '../src/store/resolver.js';
import { toDateString } from '../src/store/temporal.js';
import { ensureEntityStubs } from '../src/wiki/pages.js';
import { markSupersededClaims } from '../src/wiki/refine.js';

/**
 * World time on claims: date expressions at their stated precision, relative
 * forms anchored on the document's date, event time distinct from validity,
 * supersession of older facts, and the entity page's Facts / Timeline split.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-temporal-claims-'));
let ctx: AppContext | undefined;
afterAll(async () => {
  await ctx?.datasources.closeAll();
  await ctx?.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const d = (s: string | null | undefined) => (s ? s.slice(0, 10) : s);

describe('date expressions', () => {
  it('normalizes absolute, Chinese, fiscal and relative forms to spans', () => {
    expect(normalizeDateExpr('2026-08-10')).toMatchObject({ from: '2026-08-10T00:00:00.000Z', to: '2026-08-10T23:59:59.999Z', precision: 'day' });
    expect(normalizeDateExpr('2026年8月')).toMatchObject({ precision: 'month' });
    expect(d(normalizeDateExpr('2026-08')?.to)).toBe('2026-08-31');
    expect(normalizeDateExpr('2026Q2')).toMatchObject({ from: '2026-04-01T00:00:00.000Z', to: '2026-06-30T23:59:59.999Z', precision: 'quarter' });
    expect(normalizeDateExpr('2026年第二季度')).toMatchObject({ precision: 'quarter', from: '2026-04-01T00:00:00.000Z' });
    expect(normalizeDateExpr('Q3 2025')).toMatchObject({ from: '2025-07-01T00:00:00.000Z' });
    expect(normalizeDateExpr('2026年上半年')).toMatchObject({ from: '2026-01-01T00:00:00.000Z', to: '2026-06-30T23:59:59.999Z', precision: 'half' });
    expect(normalizeDateExpr('FY2025')).toMatchObject({ precision: 'year', from: '2025-01-01T00:00:00.000Z' });
    expect(normalizeDateExpr('2026年')).toMatchObject({ precision: 'year' });
    expect(normalizeDateExpr(2024)).toMatchObject({ precision: 'year', from: '2024-01-01T00:00:00.000Z' });
    expect(normalizeDateExpr('2026-02-30')).toBeNull();
    expect(normalizeDateExpr('去年')).toBeNull(); // relative needs an anchor
    expect(normalizeDateExpr('去年', '2026-08-10T00:00:00Z')).toMatchObject({ from: '2025-01-01T00:00:00.000Z', precision: 'year' });
    expect(normalizeDateExpr('上季度', '2026-08-10T00:00:00Z')).toMatchObject({ from: '2026-04-01T00:00:00.000Z', to: '2026-06-30T23:59:59.999Z' });
    expect(normalizeDateExpr('last quarter', '2026-01-15T00:00:00Z')).toMatchObject({ from: '2025-10-01T00:00:00.000Z' });
    expect(normalizeDateExpr('上个月', '2026-01-15T00:00:00Z')).toMatchObject({ from: '2025-12-01T00:00:00.000Z' });
    expect(normalizeDateExpr('去年同期', '2026-08-10T00:00:00Z')).toMatchObject({ from: '2025-07-01T00:00:00.000Z', precision: 'quarter' });
    expect(normalizeDateExpr('2024年以来')).toMatchObject({ from: '2024-01-01T00:00:00.000Z', to: null });
    expect(normalizeDateExpr('since 2024')).toMatchObject({ from: '2024-01-01T00:00:00.000Z', to: null });
    expect(normalizeDateExpr('截至 2026-06-30')).toMatchObject({ from: null, to: '2026-06-30T23:59:59.999Z' });
    expect(normalizeDateExpr('nonsense')).toBeNull();
    // the query resolver understands the same shorthand
    const r = resolveTemporal({ validRange: '2026Q2' });
    expect(d(r.validFrom)).toBe('2026-04-01');
    expect(d(r.validTo)).toBe('2026-06-30');
    expect(d(resolveTemporal({ validRange: '2026年上半年..2026Q3' }).validTo)).toBe('2026-09-30');
  });

  it('derives a document date from frontmatter or the path, never the mtime', () => {
    expect(d(docDateOf('raw/docs/x.md', { date: '2026-08-10' }))).toBe('2026-08-10');
    expect(d(docDateOf('raw/docs/x.md', { published: '2026年5月' }))).toBe('2026-05-01');
    expect(d(docDateOf('raw/docs/x.md', { generated: { by: 'exporter/1', at: '2026-09-13T04:05:24Z' } }))).toBe('2026-09-13');
    expect(d(dateFromPath('raw/docs/reports/2026-05-10-catl.md'))).toBe('2026-05-10');
    expect(d(dateFromPath('raw/docs/zsxq/15281584515252/2025-05.md'))).toBe('2025-05-01');
    expect(d(dateFromPath('raw/docs/年报/2025年报.pdf'))).toBeNull();
    expect(d(dateFromPath('raw/docs/2026年3月纪要.md'))).toBe('2026-03-01');
    expect(d(dateFromPath('raw/docs/20260510.pdf'))).toBe('2026-05-10');
    expect(d(dateFromPath('raw/docs/2026Q2-review.md'))).toBe('2026-04-01');
    expect(dateFromPath('raw/docs/notes.md')).toBeNull();
  });

  it('reads a dateline at the top of a document when frontmatter and path give none', () => {
    const now = '2026-11-15T12:00:00.000Z';
    const read = (text: string) => dateFromContent(text, now);
    // a weekly report: its week on the second line, dated by the day the week ends
    expect(d(read('# 六部增长组周报 · 第30周\n\n2025-07-28 ~ 2025-08-01 · 龙杰\n\n## 一、进展\n天枢系统完成度76%。'))).toBe('2025-08-01');
    expect(d(read('# 月报\n\n日期：2025年8月29日\n\n正文'))).toBe('2025-08-29');
    expect(d(read('Weekly notes\n\n**Date:** 2025/8/5\n\nBody'))).toBe('2025-08-05');
    expect(d(read('Weekly notes\n\n2025-08-05 | by Lin\n\nBody'))).toBe('2025-08-05');
    expect(d(read('# 例会纪要\n2025年8月29日（周五）\n参会：王芳'))).toBe('2025-08-29');
    // a dotted date behind a label or in a range, two digits each; a month's report: its last day
    expect(d(read('报告期：2025.08.01 至 2025.08.31\n正文'))).toBe('2025-08-31');
    expect(d(read('日期：2025.08.25\n正文'))).toBe('2025-08-25');
    // today, and tomorrow by the writer's clock, are dates the document may carry
    expect(d(read('2026-11-15\n正文'))).toBe('2026-11-15');
    expect(d(read('2026-11-16\n正文'))).toBe('2026-11-16');
  });

  it('reads the datelines real documents carry: a range in dots, a period still running, a byline, a month name, a time, a weekday', () => {
    const now = '2026-11-14T10:00:00.000Z';
    const read = (text: string) => dateFromContent(text, now);
    // a range written with dots is no numbered list
    expect(d(read('2025.08.25 至 2025.08.29\n正文'))).toBe('2025-08-29');
    // a report indexed before its period is over: the day it is indexed — nothing in it is later — and its end once that has passed
    expect(d(read('# 双周报\n\n2026-11-09 ~ 2026-11-20 · 龙杰\n\n进展'))).toBe('2026-11-14');
    expect(d(dateFromContent('# 双周报\n\n2026-11-09 ~ 2026-11-20 · 龙杰\n\n进展', '2026-11-25T10:00:00.000Z'))).toBe('2026-11-20');
    // a byline behind a comma
    expect(d(read('Weekly notes\n\n**Date:** 2025/8/5, by Lin\n\nBody'))).toBe('2025-08-05');
    // a month by its name, with a label or under the title
    expect(d(read('Date: March 1, 2025\n\nBody'))).toBe('2025-03-01');
    expect(d(read('Published: 1 March 2025\n\nBody'))).toBe('2025-03-01');
    expect(d(read('# Minutes\n\nFriday, Aug. 29th, 2025\n\nBody'))).toBe('2025-08-29');
    // a date with a time, a date with a weekday — anywhere among the first lines
    expect(d(read('# 例会\n\n地点：三楼\n\n时间：2025-08-25 14:30\n\n议题'))).toBe('2025-08-25');
    expect(d(read('# 例会\n\n参会：王芳\n\n2025年8月29日 星期五\n\n议题'))).toBe('2025-08-29');
    expect(d(read('# Standup\n\nAttendees: Lin\n\n2025-08-29 09:30 UTC\n\nNotes'))).toBe('2025-08-29');
  });

  it('reads a bare date only directly under the title', () => {
    const now = '2026-11-15T12:00:00.000Z';
    // further down, a line that is only a date may be anything: a birth date in a biography
    expect(dateFromContent('# 张三\n\n张三是一名工程师\n\n1985-03-01\n\n生于杭州', now)).toBeNull();
    expect(dateFromContent('# Notes\n\nSome text\n\nMarch 1, 2025\n\nMore', now)).toBeNull();
    // directly under the title it is read. That is also where a biography may give a birth date: a date decades
    // before the others in the text cannot be told from a plan's horizon decades after, so this case stays.
    expect(d(dateFromContent('# 张三\n\n1985-03-01\n\n张三是一名工程师', now))).toBe('1985-03-01');
    expect(d(dateFromContent('2025-08-29\n\n正文', now))).toBe('2025-08-29');
    // and what follows a date must still be a weekday, a time or a byline
    expect(dateFromContent('2025-08-25 14:30 server started\n', now)).toBeNull();
    expect(dateFromContent('2026-12-01 ~ 2026-12-07\n\n计划', now)).toBeNull();
  });

  it('takes no date from a line that is something else than the document\'s date', () => {
    const now = '2026-11-15T12:00:00.000Z';
    const no = (text: string) => expect(dateFromContent(text, now), text).toBeNull();
    // a sentence that opens with a date, with or without a comma, or goes on behind a dash
    no('2019年3月1日，公司在深圳成立，主营储能业务。');
    no('2025-08-25上线的版本修复了三个问题。');
    no('2025-08-25, the team shipped three fixes.');
    no('2027-06-30 — 完成迁移');
    no('2025-08-25 - initial release');
    // a date inside a sentence, a month alone, a date far down the text, no date at all
    no('# 公司简介\n\n成立于2019年3月1日的公司，主营储能。');
    no('# 纪要\n\n2025年8月\n\n正文');
    no(`# 标题\n\n${'一行正文。\n'.repeat(12)}2025-08-25\n`);
    no('# 标题\n\n2025-13-45 · 作者');
    // a changelog: its first entry as a list item or a heading
    no('# Changelog\n\n- 2023-01-05 - initial release\n- 2023-02-01 - fixes');
    no('# Changelog\n\n## 2023-01-05\n\n- initial release');
    no('1. 2023-01-05\n2. 2023-02-01');
    // a version number
    no('# Release notes\n\n## 2025.8.1\n\n- fixes');
    no('2024.2.3 (build 771)\n\nNotes');
    no('2024.02.03\n\nNotes');
    // a quoted mail header, a table row
    no('> 日期：2024年1月5日\n> 发件人：王芳\n\n正文');
    no('| 2024-01-05 | 发布 |');
    // a deadline or a plan: later than the day the document is indexed
    no('2027-06-30\n\n完成迁移');
    no('# 年度计划\n\n2026-01-01 ~ 2026-12-31\n\n目标');
    // what the document covers, not when it is from: a statistics period, a long range, a range that runs backwards
    no('统计周期：2015-01-01 至 2024-12-31');
    no('2015-01-01 至 2024-12-31');
    no('2025-08-29 ~ 2025-08-25');
    // frontmatter and the path still come first; without a text nothing is read
    expect(d(docDateOf('raw/docs/x.md', { date: '2026-08-10' }, '2025-08-25 · 作者', now))).toBe('2026-08-10');
    expect(d(docDateOf('raw/docs/2026-05-10-x.md', {}, '2025-08-25 · 作者', now))).toBe('2026-05-10');
    expect(d(docDateOf('raw/docs/x.md', {}, '# 周报\n2025-08-25 ~ 2025-08-29 · 作者', now))).toBe('2025-08-29');
    expect(docDateOf('raw/docs/x.md', {})).toBeNull();
  });
});

describe('claims with world time', () => {
  it('anchors relative dates on the document date, keeps event time apart from validity, supersedes older facts and renders a timeline', async () => {
    const dataDir = path.join(tmp, 'ws');
    write(dataDir, 'raw/docs/reports/2026-08-10-q2.md', `---
title: 宁德时代 2026Q2 业绩点评
entities:
  - { name: 宁德时代, type: organization, aliases: ["CATL"] }
claims:
  - { subject: 宁德时代, type: revenue, statement: 2026Q2 营业收入 1000 亿元, eventDate: 本季度 }
  - { subject: 宁德时代, type: revenue, statement: 去年同期营业收入 800 亿元, eventDate: 去年同期 }
  - { subject: 宁德时代, type: ceo, statement: 曾毓群担任董事长, startDate: "2011" }
  - { subject: 宁德时代, type: guidance, statement: 全年出货指引 500GWh, startDate: 今年, endDate: 今年 }
---
2026Q2 营业收入 1000 亿元，同比增长 25%。
`);
    write(dataDir, 'raw/docs/reports/2024-03-01-chairman.md', `---
title: 高管变动
date: 2024-03-01
entities:
  - { name: 宁德时代, type: organization }
claims:
  - { subject: 宁德时代, object: 时代上汽, type: holding, statement: 持有时代上汽 51% 股权, startDate: "2019-01-01" }
  - { subject: 宁德时代, object: 时代上汽, type: holding, statement: 持有时代上汽 70% 股权, startDate: "2024-03-01" }
---
李四接替张三出任 CFO。
`);
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });

    const docs = await ctx.store.query<{ path: string; doc_date: Date | string | null }>(`SELECT path, doc_date FROM documents WHERE root = 'docs' ORDER BY path`);
    expect(docs.map((r) => [r.path, toDateString(r.doc_date)])).toEqual([
      ['raw/docs/reports/2024-03-01-chairman.md', '2024-03-01'],
      ['raw/docs/reports/2026-08-10-q2.md', '2026-08-10'],
    ]);
    expect(readSidecarPart(dataDir, 'raw/docs/reports/2026-08-10-q2.md', 'meta')?.docDate).toBe('2026-08-10T00:00:00.000Z');
    // re-ingest is idempotent: nothing depends on when the file was touched
    expect((await sync(ctx, { llmGraph: false })).indexed).toBe(0);

    const all = await queryClaims(ctx.store, { subject: '宁德时代', includeSuperseded: true, order: 'timeline', limit: 20 });
    const by = (type: string, text: string) => all.claims.find((c) => c.type === type && c.statement.includes(text))!;
    // the free labels the frontmatter used landed on the closed list (revenue → earnings, ceo → management)
    expect(by('earnings', '1000').eventAt).toBe('2026-07-01');   // 本季度 relative to 2026-08-10 → Q3 2026
    expect(by('earnings', '800').eventAt).toBe('2025-07-01');    // 去年同期 → Q3 2025
    expect(by('earnings', '1000').observedAt).toBe('2026-08-10');
    expect(by('management', '曾毓群').validFrom).toBe('2011-01-01');
    expect(by('guidance', '500GWh')).toMatchObject({ validFrom: '2026-01-01', validTo: '2026-12-31' });
    expect(all.claims.map((c) => c.type)).toEqual(['management', 'holding', 'holding', 'earnings', 'guidance', 'earnings']); // timeline order

    // supersession (docs/design/29): the 2024 stake replaces the 2019 one (same subject, attribute and object), and this
    // quarter's revenue the year-ago quarter's (one attribute, a later effective date); the chairman's role, open-ended
    // and older, gives no value of an attribute and is replaced by nothing
    expect(await markSupersededClaims(ctx.store)).toBe(2);
    const current = await queryClaims(ctx.store, { subject: '宁德时代', types: ['holding'] });
    expect(current.claims.map((c) => c.statement)).toEqual(['持有时代上汽 70% 股权']);
    const history = await queryClaims(ctx.store, { subject: '宁德时代', types: ['holding'], includeSuperseded: true, order: 'timeline' });
    expect(history.claims.map((c) => [c.statement, c.superseded])).toEqual([['持有时代上汽 51% 股权', true], ['持有时代上汽 70% 股权', false]]);
    const live = (await claimsForEntities(ctx.store, ['宁德时代'], 20)).map((c) => c.statement);
    expect(live).not.toContain('持有时代上汽 51% 股权');
    expect(live).toContain('曾毓群担任董事长');
    // a filter spelled with the old label still finds its claims
    expect((await queryClaims(ctx.store, { subject: '宁德时代', types: ['revenue'], includeSuperseded: true })).claims).toHaveLength(2);
    expect((await queryClaims(ctx.store, { subject: '宁德时代', types: ['revenue'] })).claims.map((c) => c.statement)).toEqual(['2026Q2 营业收入 1000 亿元']);
    const q3 = await queryClaims(ctx.store, { subject: '宁德时代', eventRange: { from: '2026-07-01T00:00:00Z', to: '2026-09-30T23:59:59Z' } });
    expect(q3.claims.map((c) => c.statement)).toEqual(['2026Q2 营业收入 1000 亿元']);
    // running the audit again changes nothing
    expect(await markSupersededClaims(ctx.store)).toBe(0);

    // the entity page compiles each attribute to its current value with its history, and splits the other
    // current facts from the dated history
    await ensureEntityStubs(ctx, { minMentions: 1 });
    const page = fs.readFileSync(path.join(dataDir, 'wiki', 'entities', '宁德时代.md'), 'utf8');
    const state = page.slice(page.indexOf('## Current state'), page.indexOf('## Facts (current)'));
    expect(state).toContain('- **持有时代上汽**: 70% `2024-03-01` — raw/docs/reports/2024-03-01-chairman.md');
    expect(state).toContain('  - history: 51% (2019-01-01)');
    expect(state).toContain('- **营业收入**: 1000亿元 `2026-07-01` — raw/docs/reports/2026-08-10-q2.md');
    expect(state).toContain('  - history: 800亿元 (2025-07-01)');
    expect(page).toContain('## Timeline');
    const facts = page.slice(page.indexOf('## Facts (current)'), page.indexOf('## Timeline'));
    expect(facts).not.toContain('持有时代上汽');
    expect(facts).toContain('曾毓群担任董事长 `fact` `2011-01-01`');
    // the timeline places what the sources date themselves by effective date
    const timeline = page.slice(page.indexOf('## Timeline'));
    expect(timeline.indexOf('2011-01-01 · 曾毓群')).toBeLessThan(timeline.indexOf('2026-01-01 · 全年出货指引'));
  });
});
