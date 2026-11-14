import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { sync } from '../src/ingest/sync.js';
import { documentPeriod } from '../src/store/dates.js';
import { EvidenceAtRow, foldClaimEvidence, toDateString } from '../src/store/temporal.js';

/**
 * A statement about its document's period ("支付组本周在岗7人") repeated word
 * for word in report after report is one claim row with a supporter per
 * report. Its window is the newest supporter's period, not the span from the
 * first report to the last; a week-relative supporter that stated no window,
 * or one longer than a week, takes its document's week.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-claim-period-windows-'));
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

const ev = (attrs: Record<string, unknown>, scope: string, tx = '2026-01-01T00:00:00Z'): EvidenceAtRow =>
  ({ kind: 'claim', target_id: 'c', scope_id: scope, segment_id: null, weight: 1, extractor: 'x', attrs, tx_from: tx });
const week = (from: string, to: string) => ({ valid_from: `${from}T00:00:00.000Z`, valid_to: `${to}T23:59:59.999Z` });
const days = (w: { valid_from: string | null; valid_to: string | null } | null) => (w ? [toDateString(w.valid_from), toDateString(w.valid_to)] : null);

describe('the period a statement names relative to its document', () => {
  it('reads week, month, quarter, year and day words, the finest first', () => {
    expect(documentPeriod('支付组本周在岗7人。')).toEqual({ word: '本周', scale: 'week' });
    expect(documentPeriod('七部增长组这周周活跃用户为136万')).toEqual({ word: '这周', scale: 'week' });
    expect(documentPeriod('上一周完成了评审')).toEqual({ word: '上一周', scale: 'week' });
    expect(documentPeriod('Signups grew 3% this week')).toEqual({ word: 'this week', scale: 'week' });
    expect(documentPeriod('上个月在岗8人')).toEqual({ word: '上个月', scale: 'month' });
    expect(documentPeriod('营收比去年同期增长20%')).toEqual({ word: '去年', scale: 'year' });
    expect(documentPeriod('今年本月完成两次演练')).toEqual({ word: '本月', scale: 'month' });
    // "this cycle" is no week, and a statement naming no period has none
    expect(documentPeriod('本周期内完成迁移')).toBeNull();
    expect(documentPeriod('R-83尚未关闭。')).toBeNull();
    expect(documentPeriod('天璇工程目标于2025年第40周上线。')).toBeNull();
  });
});

describe('the window of a claim several documents repeat', () => {
  const row = { id: 'c', subject_id: 's', statement: '支付组本周在岗7人。' };

  it('is the newest supporter\'s week, not the span over all of them', () => {
    const rows = [
      ev({ statement: row.statement, ...week('2025-04-28', '2025-05-02') }, 'a'),
      ev({ statement: row.statement, ...week('2025-06-16', '2025-06-20') }, 'c'),
      ev({ statement: row.statement, ...week('2025-05-05', '2025-05-09') }, 'b'),
    ];
    expect(days(foldClaimEvidence(row, rows))).toEqual(['2025-06-16', '2025-06-20']);
    // a statement naming no period of its document keeps the span
    const other = { ...row, statement: 'R-83尚未关闭。' };
    expect(days(foldClaimEvidence(other, rows.map((r) => ({ ...r, attrs: { ...r.attrs, statement: other.statement } }))))).toEqual(['2025-04-28', '2025-06-20']);
  });

  it('gives a week-relative supporter with no window, or one longer than a week, its document\'s week', () => {
    const docs = new Map([
      ['a', { documentId: 'da', docDate: '2025-09-05T00:00:00.000Z' }],
      ['b', { documentId: 'db', docDate: '2025-09-12T00:00:00.000Z' }],
    ]);
    // no window stated: the ISO week of the report's date, a date the statement states ("本周")
    expect(days(foldClaimEvidence(row, [ev({ statement: row.statement }, 'a')], undefined, docs))).toEqual(['2025-09-01', '2025-09-07']);
    expect(foldClaimEvidence(row, [ev({ statement: row.statement }, 'a')], undefined, docs)).toMatchObject({ effective_at: '2025-09-01T00:00:00.000Z', date_source: 'stated' });
    // the evidence's own observed date anchors it before the document's date now
    expect(days(foldClaimEvidence(row, [ev({ statement: row.statement, observed_at: '2025-03-14T00:00:00.000Z' }, 'a')], undefined, docs))).toEqual(['2025-03-10', '2025-03-16']);
    // a month stated for "this week" is no week: the report's week instead
    expect(days(foldClaimEvidence(row, [ev({ statement: row.statement, ...week('2025-09-01', '2025-09-30') }, 'b')], undefined, docs))).toEqual(['2025-09-08', '2025-09-14']);
    // last week, relative to the report
    const last = { ...row, statement: '支付组上周在岗7人。' };
    expect(days(foldClaimEvidence(last, [ev({ statement: last.statement }, 'b')], undefined, docs))).toEqual(['2025-09-01', '2025-09-07']);
    // without a document date nothing is made up
    expect(days(foldClaimEvidence(row, [ev({ statement: row.statement }, 'z')], undefined, docs))).toEqual([null, null]);
    // a year word is often a comparison: a supporter that stated no window keeps none
    const yoy = { ...row, statement: '营收比去年同期增长20%。' };
    expect(days(foldClaimEvidence(yoy, [ev({ statement: yoy.statement }, 'a')], undefined, docs))).toEqual([null, null]);
  });
});

describe('weekly reports repeating one statement', () => {
  it('fold to the newest report\'s week, and a report\'s undated week claim takes the report\'s week', async () => {
    const dataDir = path.join(tmp, 'ws');
    const report = (date: string, from: string, to: string) => `---
title: 支付组周报
date: ${date}
entities:
  - { name: 支付组, type: organization }
claims:
  - { subject: 支付组, type: other, statement: 支付组本周在岗7人。, startDate: "${from}", endDate: "${to}" }
  - { subject: 支付组, type: other, statement: 支付组本周有3天加班。 }
---
支付组本周在岗7人。
`;
    write(dataDir, 'raw/docs/周报/支付组/w18.md', report('2025-05-02', '2025-04-28', '2025-05-02'));
    write(dataDir, 'raw/docs/周报/支付组/w25.md', report('2025-06-20', '2025-06-16', '2025-06-20'));
    write(dataDir, 'raw/docs/周报/支付组/w19.md', report('2025-05-09', '2025-05-05', '2025-05-09'));
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });
    const rows = await ctx.store.query<{ statement: string; valid_from: string | Date | null; valid_to: string | Date | null; evidence_count: number; effective_at: string | Date | null; date_source: string | null }>(
      `SELECT statement, valid_from, valid_to, evidence_count, effective_at, date_source FROM claims WHERE tx_to IS NULL ORDER BY statement`,
    );
    expect(rows.map((r) => [r.statement, toDateString(r.valid_from), toDateString(r.valid_to), r.evidence_count, toDateString(r.effective_at), r.date_source])).toEqual([
      ['支付组本周在岗7人。', '2025-06-16', '2025-06-20', 3, '2025-06-16', 'stated'],
      // stated no window: the newest report's week (2025-06-20 is a Friday); the week it names is a date it states
      ['支付组本周有3天加班。', '2025-06-16', '2025-06-22', 3, '2025-06-16', 'stated'],
    ]);
    // every report's own week stays in the evidence
    const ev = await ctx.store.query<{ n: number }>(
      `SELECT count(DISTINCT e.attrs->>'valid_from')::int AS n FROM evidence e JOIN claims c ON c.id = e.target_id
       WHERE e.kind = 'claim' AND e.tx_to IS NULL AND c.statement = '支付组本周在岗7人。'`,
    );
    expect(ev[0].n).toBe(3);
  });
});
