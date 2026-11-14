import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { supersedeByAttribute } from '../src/graph/claim-state-store.js';
import { sync } from '../src/ingest/sync.js';
import { toDateString } from '../src/store/temporal.js';

/**
 * Claims that name their document's period ("本周", "较上周") as the fold reads
 * them: nothing is inferred from the word. A weekly reading of a number is a
 * claim per ISO week (claim identity, src/graph/store.ts readingWeek); a
 * restated fact is one claim over its reports; a window is what was stated;
 * a claim that states none is dated by its document, as 'document'; and
 * reports of one period keep their documents' order.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-period-claims-'));
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

describe('claims about their document\'s period', () => {
  it('are a reading per week for a weekly number, one claim for a restated fact', async () => {
    const week = (date: string, from: string, to: string) => report(date, [
      `{ subject: 支付组, type: other, statement: 支付组本周在岗7人。, startDate: "${from}", endDate: "${to}" }`,
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
    expect(by('支付组在岗7人')).toMatchObject({ valid_from: null, valid_to: null, date_source: 'document', superseded_by: null });
    expect(day(by('支付组在岗7人').effective_at)).toBe('2025-09-19');
    expect(by('支付组在岗6人').superseded_by).not.toBeNull();
    expect(day(by('支付组本周加班50小时').effective_at)).toBe('2025-09-17');
    expect(day(by('支付组本周加班80小时').effective_at)).toBe('2025-09-19');
    expect(by('支付组本周加班50小时').superseded_by).not.toBeNull();
    expect(by('支付组本周加班80小时').superseded_by).toBeNull();
  });

  it('never have a stated window replaced', async () => {
    const { rows } = await build('stated', [
      ['raw/docs/a.md', report('2024-03-01', [
        '{ subject: 支付组, type: other, statement: 支付组资本周转率为1.2次。, startDate: "2024-01-01", endDate: "2024-12-31" }',
        '{ subject: 支付组, type: other, statement: 支付组本季度营收为50亿元。, startDate: "2024Q2", endDate: "2024Q2" }',
      ])],
      // the same quarter's figure repeated with no window in a later report
      ['raw/docs/b.md', report('2024-09-02', ['{ subject: 支付组, type: other, statement: 支付组本季度营收为50亿元。 }'])],
    ]);
    const all = await rows();
    const of = (s: string) => all.filter((r) => r.statement === s).map((r) => [day(r.valid_from), day(r.valid_to), r.date_source]);
    expect(of('支付组资本周转率为1.2次。')).toEqual([['2024-01-01', '2024-12-31', 'stated']]);
    // the stated quarter is kept although the newest supporter states none; that later report dates the repeat
    expect(of('支付组本季度营收为50亿元。')).toEqual([['2024-04-01', null, 'document']]);
    expect(day(all.find((r) => r.statement === '支付组本季度营收为50亿元。')!.effective_at)).toBe('2024-09-02');
  });
});
