import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { supersedeByAttribute } from '../src/graph/claim-state-store.js';
import { sync } from '../src/ingest/sync.js';
import { relativeTimeWord } from '../src/store/dates.js';
import { toDateString } from '../src/store/temporal.js';

/**
 * A statement whose time is relative to its document ("支付组本周评审了接口设计")
 * is a different assertion in every report, so it is a claim per report's day
 * (src/lineage/writer.ts readingDay), never one claim spanning the first
 * report to the last. Nothing about its dates is inferred from the word: the
 * window is what was stated, the effective date the stated one else the
 * document's, and reports of one period keep their documents' order.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-relative-claims-'));
const opened: AppContext[] = [];
afterAll(async () => {
  for (const c of opened) {
    await c.datasources.closeAll();
    await c.store.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** A report dated `date` declaring `claims` (YAML flow maps) about 支付组. */
const report = (date: string, claims: string[]) => `---
title: 支付组周报
date: ${date}
entities:
  - { name: 支付组, type: organization }
claims:
${claims.map((c) => `  - ${c}`).join('\n')}
---
支付组周报。
`;

type Row = { statement: string; valid_from: unknown; valid_to: unknown; effective_at: unknown; date_source: string | null; superseded_by: string | null; evidence_count: number };
async function build(name: string, docs: [string, string][]): Promise<{ ctx: AppContext; rows: () => Promise<Row[]> }> {
  const dataDir = path.join(tmp, name);
  for (const [p, t] of docs) write(dataDir, p, t);
  const ctx = await createContext(dataDir);
  opened.push(ctx);
  await sync(ctx, { llmGraph: false });
  const rows = () => ctx.store.query<Row>(
    `SELECT statement, valid_from, valid_to, effective_at, date_source, superseded_by, evidence_count FROM claims WHERE tx_to IS NULL ORDER BY statement, effective_at`,
  );
  return { ctx, rows };
}
const day = (v: unknown) => toDateString(v as string | null);

describe('a time relative to the document', () => {
  it('is a word of its own, its own period or a comparison base, and not part of another word', () => {
    expect(relativeTimeWord('支付组本周在岗7人。')).toBe('本周');
    expect(relativeTimeWord('支付组在岗7人，较上周增加2人')).toBe('上周');
    expect(relativeTimeWord('支付成功率环比上月提升0.1%')).toBe('上月');
    expect(relativeTimeWord('七部增长组两周前的周活跃用户为136万')).toBe('两周前');
    expect(relativeTimeWord('Signups grew 3% this week')).toBe('this week');
    for (const s of ['资本周转率为1.2次', '日本周三发布数据', '股价站上周线', '股价站上月线', '旗下周边产品', '成本月环比下降', 'the last week of March', '本周期内完成迁移', '线上月活跃用户为30万', 'R-83尚未关闭。']) {
      expect(relativeTimeWord(s)).toBeNull();
    }
  });
});

describe('reports repeating a relative statement', () => {
  it('give a claim per report, in its own week; a restated text without one stays one claim', async () => {
    const week = (date: string, from: string, to: string) => report(date, [
      `{ subject: 支付组, type: other, statement: 支付组本周在岗7人。, startDate: "${from}", endDate: "${to}" }`,
      `{ subject: 支付组, type: other, statement: 支付组本周评审了结算中台的接口设计。, startDate: "${from}", endDate: "${to}" }`,
      '{ subject: 支付组, type: other, statement: 支付组本周有3天加班。 }',
      `{ subject: 支付组, type: other, statement: 支付组负责人为孙欣。, startDate: "${from}", endDate: "${to}" }`,
    ]);
    const { rows } = await build('weeks', [
      ['raw/docs/周报/支付组/w18.md', week('2025-05-02', '2025-04-28', '2025-05-02')],
      ['raw/docs/周报/支付组/w25.md', week('2025-06-20', '2025-06-16', '2025-06-20')],
      ['raw/docs/周报/支付组/w19.md', week('2025-05-09', '2025-05-05', '2025-05-09')],
    ]);
    const all = await rows();
    const of = (s: string) => all.filter((r) => r.statement === s).map((r) => [day(r.valid_from), day(r.valid_to), day(r.effective_at), r.date_source, r.evidence_count]);
    expect(of('支付组本周在岗7人。')).toEqual([
      ['2025-04-28', '2025-05-02', '2025-04-28', 'stated', 1],
      ['2025-05-05', '2025-05-09', '2025-05-05', 'stated', 1],
      ['2025-06-16', '2025-06-20', '2025-06-16', 'stated', 1],
    ]);
    expect(of('支付组本周评审了结算中台的接口设计。')).toHaveLength(3);
    // no window stated: none inferred; each report dates its own claim, and says it did
    expect(of('支付组本周有3天加班。')).toEqual([
      [null, null, '2025-05-02', 'document', 1],
      [null, null, '2025-05-09', 'document', 1],
      [null, null, '2025-06-20', 'document', 1],
    ]);
    // a fact restated week after week in the same words is one claim over the weeks
    expect(of('支付组负责人为孙欣。')).toEqual([['2025-04-28', '2025-06-20', '2025-06-16', 'stated', 3]]);
  });

  it('keep their documents\' order within one period, and a comparison base dates nothing', async () => {
    const { ctx, rows } = await build('order', [
      // Wednesday's and Friday's report of one week, no windows stated
      ['raw/docs/周报/支付组/wed.md', report('2025-09-17', ['{ subject: 支付组, type: other, statement: 支付组在岗6人。 }', '{ subject: 支付组, type: other, statement: 支付组本周加班50小时。 }'])],
      ['raw/docs/周报/支付组/fri.md', report('2025-09-19', ['{ subject: 支付组, type: other, statement: 支付组在岗7人，较上周增加2人。 }', '{ subject: 支付组, type: other, statement: 支付组本周加班80小时。 }'])],
    ]);
    await supersedeByAttribute(ctx.store);
    const all = await rows();
    const by = (s: string) => all.find((r) => r.statement.startsWith(s))!;
    // "较上周" is the base of a comparison: the claim is dated by its document, nothing is called stated
    expect(by('支付组在岗7人')).toMatchObject({ valid_from: null, valid_to: null, date_source: 'document', superseded_by: null });
    expect(day(by('支付组在岗7人').effective_at)).toBe('2025-09-19');
    expect(by('支付组在岗6人').superseded_by).not.toBeNull();
    // two readings of one week stay in their documents' order: Friday's is current
    expect(day(by('支付组本周加班50小时').effective_at)).toBe('2025-09-17');
    expect(day(by('支付组本周加班80小时').effective_at)).toBe('2025-09-19');
    expect(by('支付组本周加班50小时').superseded_by).not.toBeNull();
    expect(by('支付组本周加班80小时').superseded_by).toBeNull();
  });

  it('never replace a window that was stated', async () => {
    const { rows } = await build('stated', [
      ['raw/docs/a.md', report('2024-03-01', [
        '{ subject: 支付组, type: other, statement: 支付组资本周转率为1.2次。, startDate: "2024-01-01", endDate: "2024-12-31" }',
        '{ subject: 支付组, type: other, statement: 支付组本季度营收为50亿元。, startDate: "2024Q2", endDate: "2024Q2" }',
      ])],
      // the same quarter's figure repeated with no window in a later report
      ['raw/docs/b.md', report('2024-09-02', ['{ subject: 支付组, type: other, statement: 支付组本季度营收为50亿元。 }'])],
    ]);
    const all = await rows();
    const of = (s: string) => all.filter((r) => r.statement === s).map((r) => [day(r.valid_from), day(r.valid_to), day(r.effective_at), r.date_source]);
    expect(of('支付组资本周转率为1.2次。')).toEqual([['2024-01-01', '2024-12-31', '2024-01-01', 'stated']]);
    // the stated quarter stays on the claim that stated it; the undated repeat is the later report's own
    expect(of('支付组本季度营收为50亿元。')).toEqual([
      ['2024-04-01', '2024-06-30', '2024-04-01', 'stated'],
      [null, null, '2024-09-02', 'document'],
    ]);
  });
});
