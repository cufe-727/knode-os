import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { readSidecarPart } from '../src/fs/sidecar.js';
import { claimsForEntities } from '../src/graph/query.js';
import { dateFromPath, docDateOf } from '../src/ingest/docdate.js';
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
  - { subject: 宁德时代, type: cfo, statement: 张三担任 CFO, startDate: "2019-01-01" }
  - { subject: 宁德时代, type: cfo, statement: 李四担任 CFO, startDate: "2024-03-01" }
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
    expect(by('revenue', '1000').eventAt).toBe('2026-07-01');   // 本季度 relative to 2026-08-10 → Q3 2026
    expect(by('revenue', '800').eventAt).toBe('2025-07-01');    // 去年同期 → Q3 2025
    expect(by('revenue', '1000').observedAt).toBe('2026-08-10');
    expect(by('ceo', '曾毓群').validFrom).toBe('2011-01-01');
    expect(by('guidance', '500GWh')).toMatchObject({ validFrom: '2026-01-01', validTo: '2026-12-31' });
    expect(all.claims.map((c) => c.type)).toEqual(['ceo', 'cfo', 'cfo', 'revenue', 'guidance', 'revenue']); // timeline order

    // supersession: the 2024 CFO fact replaces the 2019 one
    expect(await markSupersededClaims(ctx.store)).toBe(1);
    const current = await queryClaims(ctx.store, { subject: '宁德时代', types: ['cfo'] });
    expect(current.claims.map((c) => c.statement)).toEqual(['李四担任 CFO']);
    const history = await queryClaims(ctx.store, { subject: '宁德时代', types: ['cfo'], includeSuperseded: true, order: 'timeline' });
    expect(history.claims.map((c) => [c.statement, c.superseded])).toEqual([['张三担任 CFO', true], ['李四担任 CFO', false]]);
    expect((await claimsForEntities(ctx.store, ['宁德时代'], 20)).map((c) => c.statement)).not.toContain('张三担任 CFO');
    const q3 = await queryClaims(ctx.store, { subject: '宁德时代', eventRange: { from: '2026-07-01T00:00:00Z', to: '2026-09-30T23:59:59Z' } });
    expect(q3.claims.map((c) => c.statement)).toEqual(['2026Q2 营业收入 1000 亿元']);
    // running the audit again changes nothing
    expect(await markSupersededClaims(ctx.store)).toBe(0);

    // the entity page splits current facts from the dated history
    await ensureEntityStubs(ctx, { minMentions: 1 });
    const page = fs.readFileSync(path.join(dataDir, 'wiki', 'entities', '宁德时代.md'), 'utf8');
    expect(page).toContain('## Facts (current)');
    expect(page).toContain('## Timeline');
    expect(page).toMatch(/- 2019-01-01 · 张三担任 CFO `fact` _\(superseded\)_/);
    expect(page.indexOf('2019-01-01 · 张三')).toBeLessThan(page.indexOf('2026-07-01 · 2026Q2'));
    const facts = page.slice(page.indexOf('## Facts (current)'), page.indexOf('## Timeline'));
    expect(facts).not.toContain('张三担任 CFO');
    expect(facts).toContain('李四担任 CFO');
  });
});
