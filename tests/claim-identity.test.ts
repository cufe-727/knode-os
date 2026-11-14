import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { auditDuplicateClaims, datesApart, eventSpanEnd, monthsApart, yearlessMonthsOf } from '../src/graph/claim-dedupe.js';
import { refreshClaimState } from '../src/graph/claim-state-store.js';
import { RawExtractReply } from '../src/graph/llm-extract.js';
import { claimId } from '../src/graph/store.js';
import { enqueueTier1, runTier1Pass } from '../src/graph/tier1.js';
import { sync } from '../src/ingest/sync.js';
import { readingDay } from '../src/lineage/writer.js';
import { LlmClient } from '../src/llm/client.js';
import { markSupersededClaims } from '../src/wiki/refine.js';

/**
 * A claim's identity (src/graph/store.ts claimId, src/lineage/writer.ts readingDay):
 * one sentence a weekly report repeats about a measure is a reading per week, while a
 * restated text value stays one claim. On the 10× reports benchmark (2026-11-14) 603 of
 * 1,440 weekly metric values had folded into another week's claim.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-claim-identity-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const WEEKS = [99.92, 99.91, 99.92, 99.93];
const monday = (k: number) => new Date(Date.UTC(2025, 0, 6 + k * 7)).toISOString().slice(0, 10);
const friday = (k: number) => new Date(Date.UTC(2025, 0, 10 + k * 7)).toISOString().slice(0, 10);

function fixture(): Map<string, { text: string; reply: RawExtractReply }> {
  const out = new Map<string, { text: string; reply: RawExtractReply }>();
  WEEKS.forEach((v, k) => {
    out.set(`raw/docs/周报/平台组/w${k + 1}.md`, {
      text: `# 平台组周报 · 第${k + 2}周\n\n${monday(k)} ~ ${friday(k)}\n\n本周服务可用性为${v}%。R-70负责人为姜婷。\n`,
      reply: {
        entities: [
          { name: '平台组', type: 'organization', aliases: [] },
          { name: 'R-70', type: 'other', aliases: [] },
          { name: '姜婷', type: 'person', aliases: [] },
        ],
        relations: [],
        claims: [
          // as the benchmark's extraction gave them: the week as the window, the same words every week
          { subject: '平台组', statement: `平台组本周服务可用性为${v}%。`, type: 'other', status: 'fact', kind: 'fact', attribute: '服务可用性', value: v, unit: '%', startDate: monday(k), endDate: friday(k) },
          { subject: 'R-70', object: '姜婷', statement: 'R-70负责人为姜婷。', type: 'risk', status: 'fact', kind: 'fact', attribute: '负责人', value: '姜婷', startDate: monday(k), endDate: friday(k) },
        ],
      },
    });
  });
  return out;
}

function stubExtractor(docs: Map<string, { reply: RawExtractReply }>): LlmClient {
  const reply = (p: string) => docs.get(p)?.reply ?? { entities: [], relations: [], claims: [] };
  const completeJson = async (messages: { role: string; content: string }[]) => {
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    const batched = [...user.matchAll(/^=== Document (\d+): .* \((raw\/docs\/[^)]+)\) ===$/gm)];
    if (batched.length > 0) return { documents: batched.map((m) => ({ doc: Number(m[1]), ...reply(m[2]) })) };
    const single = /Document: .* \((raw\/docs\/[^)]+)\)/.exec(user);
    return reply(single?.[1] ?? '');
  };
  return { enabled: true, label: 'stub@extract', provider: 'openai', model: 'stub', completeJson } as unknown as LlmClient;
}

/** A judge that must not be needed: it counts the pairs it is shown and calls each one the same. */
function countingJudge(count: { pairs: number }): LlmClient {
  const complete = async (messages: { role: string; content: string }[]) => {
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    const n = [...user.matchAll(/^Pair \d+ — /gm)].length;
    count.pairs += n;
    return JSON.stringify({ verdicts: Array.from({ length: n }, (_, i) => ({ pair: i + 1, relation: 'same', confidence: 0.99, reason: '测试' })) });
  };
  return { enabled: true, label: 'stub@judge', provider: 'openai', model: 'stub', complete } as unknown as LlmClient;
}

async function build(name: string): Promise<AppContext> {
  const dataDir = path.join(tmp, name);
  initDataDir(dataDir);
  const docs = fixture();
  for (const [p, d] of docs) {
    fs.mkdirSync(path.dirname(path.join(dataDir, p)), { recursive: true });
    fs.writeFileSync(path.join(dataDir, p), d.text);
  }
  const ctx = await createContext(dataDir);
  await sync(ctx, { llmGraph: false });
  for (const d of await ctx.store.query<{ id: string }>(`SELECT id FROM documents WHERE root = 'docs'`)) await enqueueTier1(ctx.store, d.id);
  (ctx.config.extraction as { entityLlm?: unknown }).entityLlm = undefined;
  const llm = stubExtractor(docs);
  for (let i = 0; i < 10; i++) if ((await runTier1Pass(ctx.store, ctx.config, llm, { batchSize: 64 })).queued === 0) break;
  return ctx;
}

describe('a claim identity', () => {
  it('carries the day of a dated reading of a number, and nothing else', () => {
    const reading = { statement: '平台组本周服务可用性为99.92%。', attribute: '服务可用性', valueNum: 99.92, dateSource: 'stated', validFrom: '2025-01-06T00:00:00.000Z' };
    expect(readingDay(reading)).toBe('2025-01-06');
    expect(readingDay({ ...reading, statement: '七部增长组两周前的周活跃用户为136万。' })).toBe('2025-01-06');
    expect(readingDay({ ...reading, eventAt: '2025-03-03T00:00:00.000Z' })).toBe('2025-03-03');
    // a statement that places itself by no relative time carries a day only as a dated reading of a number
    const fixed = { ...reading, statement: '平台组服务可用性为99.92%。' };
    expect(readingDay({ ...fixed, valueNum: null })).toBeNull();
    expect(readingDay({ ...fixed, attribute: null })).toBeNull();
    expect(readingDay({ ...fixed, dateSource: 'document' })).toBeNull();
    expect(readingDay({ ...fixed, validFrom: null })).toBeNull();
    // one whose time is relative to its document carries its day whatever it is: the day it states, else its document's
    expect(readingDay({ ...reading, valueNum: null, attribute: null })).toBe('2025-01-06');
    expect(readingDay({ statement: '支付组本周评审了结算中台的接口设计。', observedAt: '2025-03-07T00:00:00.000Z' })).toBe('2025-03-07');
    expect(readingDay({ statement: 'R-83较上周仍未关闭。', dateSource: 'document', observedAt: '2025-03-07T00:00:00.000Z' })).toBe('2025-03-07');
    expect(readingDay({ statement: '支付组本周评审了结算中台的接口设计。' })).toBeNull();
    // a statement that names its own time is one fact however many sources report it on other days
    for (const statement of ['2026Q2 净利润 120 亿元', '平台组2025年第24周服务可用性为99.92%', '10月月报列示四部平台组在岗人数为6人', '2025-06-16当周可用性99.92%', 'FY25 revenue was 3.2bn', '上半年营收12亿元']) {
      expect(readingDay({ ...reading, statement })).toBeNull();
    }
    // without a day the id is what it always was, so claims of existing workspaces keep theirs
    expect(claimId('平台组', 'x')).toBe(claimId('平台组', 'x', null));
    expect(claimId('平台组', 'x', '2025-01-06')).not.toBe(claimId('平台组', 'x', '2025-01-20'));
  });
});

describe('weekly readings of one measure', () => {
  const opened: AppContext[] = [];
  afterAll(async () => {
    for (const ctx of opened) {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });

  it('keep every week, a value that comes back included, and leave a restated owner one claim', async () => {
    const ctx = await build('weeks');
    opened.push(ctx);
    const readings = await ctx.store.query<{ statement: string; valid_from: Date; valid_to: Date; evidence_count: number }>(
      `SELECT statement, valid_from, valid_to, evidence_count FROM claims WHERE subject_id = '平台组' AND attribute = '服务可用性' AND tx_to IS NULL ORDER BY valid_from`,
    );
    // before: three claims, the 99.92% one spanning weeks 1 to 3 over the 99.91% of week 2
    expect(readings.map((r) => [r.statement, r.valid_from.toISOString().slice(0, 10), r.valid_to.toISOString().slice(0, 10), r.evidence_count])).toEqual(
      WEEKS.map((v, k) => [`平台组本周服务可用性为${v}%。`, monday(k), friday(k), 1]),
    );
    const owner = await ctx.store.query<{ evidence_count: number }>(`SELECT evidence_count FROM claims WHERE subject_id = 'r-70' AND tx_to IS NULL`);
    expect(owner).toEqual([{ evidence_count: WEEKS.length }]);

    // the two 99.92% weeks are worded alike; the audit settles them apart without a model and merges nothing
    const judged = { pairs: 0 };
    const stats = await auditDuplicateClaims({ store: ctx.store, embedder: ctx.embedder, config: ctx.config, llm: countingJudge(judged) });
    expect(judged.pairs).toBe(0);
    expect(stats.merged).toBe(0);
    expect(stats.identical).toBe(0);
    const [{ reason }] = await ctx.store.query<{ reason: string }>(
      `SELECT v.reason FROM claim_pair_verdicts v JOIN claims a ON a.id = v.a_id JOIN claims b ON b.id = v.b_id WHERE a.statement = b.statement`,
    );
    expect(reason).toBe('同一说法、不同时点');

    // the history holds all four weeks, the last one current
    await refreshClaimState(ctx.store);
    await markSupersededClaims(ctx.store);
    const series = await ctx.store.query<{ value_num: number; effective_at: Date; superseded_by: string | null }>(
      `SELECT value_num, effective_at, superseded_by FROM claims WHERE subject_id = '平台组' AND attribute = '服务可用性' AND tx_to IS NULL AND canonical_id IS NULL ORDER BY effective_at`,
    );
    expect(series.map((r) => [r.value_num, r.effective_at.toISOString().slice(0, 10), r.superseded_by === null])).toEqual(
      WEEKS.map((v, k) => [v, monday(k), k === WEEKS.length - 1]),
    );
  });
});

describe('the dates a claim states of itself', () => {
  it('read an event as the widest period its start date allows', () => {
    expect(eventSpanEnd('2025-09-08T00:00:00.000Z')).toBe('2025-09-14T23:59:59.999Z'); // a Monday: 2025-W37
    expect(eventSpanEnd('2025-09-01T00:00:00.000Z')).toBe('2025-09-30T23:59:59.999Z'); // 2025-09
    expect(eventSpanEnd('2025-04-01T00:00:00.000Z')).toBe('2025-06-30T23:59:59.999Z'); // 2025Q2
    expect(eventSpanEnd('2025-07-01T00:00:00.000Z')).toBe('2025-12-31T23:59:59.999Z'); // 2025Q3 or 2025H2
    expect(eventSpanEnd('2025-01-01T00:00:00.000Z')).toBe('2025-12-31T23:59:59.999Z'); // 2025
    expect(eventSpanEnd('2025-06-18T00:00:00.000Z')).toBe('2025-06-18T23:59:59.999Z'); // a Wednesday
    expect(eventSpanEnd('2025-06-16T02:00:00.000Z')).toBe('2025-06-16T23:59:59.999Z'); // a time of day, on a Monday
  });

  it('settle a pair apart only when both are known and miss each other', () => {
    const none = { valid_from: null, valid_to: null, event_at: null };
    const week = (from: string, to: string) => ({ ...none, valid_from: from, valid_to: to });
    const event = (at: string) => ({ ...none, event_at: at });
    expect(datesApart(week('2025-01-06', '2025-01-10T23:59:59Z'), week('2025-01-20', '2025-01-24T23:59:59Z'))).toBe(true);
    expect(datesApart(week('2025-01-06', '2025-01-10T23:59:59Z'), week('2025-01-08', '2025-01-24T23:59:59Z'))).toBe(false);
    // an open window holds from its start on
    expect(datesApart({ ...none, valid_from: '2025-05-19' }, week('2025-05-05', '2025-05-09T23:59:59Z'))).toBe(true);
    expect(datesApart({ ...none, valid_from: '2025-05-01' }, week('2025-05-05', '2025-05-09T23:59:59Z'))).toBe(false);
    // events: two weeks apart; a week against a window; a quarter's event against a month inside it
    expect(datesApart(event('2025-08-25T00:00:00Z'), event('2025-10-27T00:00:00Z'))).toBe(true);
    expect(datesApart(event('2025-08-25T00:00:00Z'), week('2025-08-27', '2025-08-29T23:59:59Z'))).toBe(false);
    expect(datesApart(event('2025-07-01T00:00:00Z'), week('2025-08-01', '2025-08-31T23:59:59Z'))).toBe(false);
    expect(datesApart(event('2025-09-08T00:00:00Z'), week('2025-10-13', '2025-10-17T23:59:59Z'))).toBe(true);
    // a date only the document gives is not the claim's own
    expect(datesApart({ ...none }, week('2025-01-06', '2025-01-10T23:59:59Z'))).toBe(false);
  });
});

describe('months a statement names without a year', () => {
  const claim = (statement: string, kind = 'fact', window: [string, string] | null = null) => ({
    statement, kind, valid_from: window?.[0] ?? null, valid_to: window?.[1] ?? null,
  });

  it('are read only where no year is named', () => {
    expect([...yearlessMonthsOf('4月月报列示四部支付组在岗人数为7人。')]).toEqual([4]);
    expect([...yearlessMonthsOf('10月月报列示X计划于12月31日前完成')].sort((x, y) => x - y)).toEqual([10, 12]);
    expect(yearlessMonthsOf('2025年8月结算平台完成度为69%').size).toBe(0);
    expect(yearlessMonthsOf('预计3个月内完成').size).toBe(0);
    expect(yearlessMonthsOf('支付组本周支付成功率为97.4%').size).toBe(0);
  });

  it('settle two other months of the year apart, a forecast never', () => {
    // as the benchmark's monthly reports, which carry no date of their own, give them
    expect(monthsApart(claim('4月月报列示四部支付组在岗人数为7人。'), claim('10月月报列示四部支付组在岗人数为8人。'))).toBe(true);
    expect(monthsApart(claim('9月月报列示四部平台组在岗人数为6人。'), claim('9月月报中四部平台组在岗6人。'))).toBe(false);
    // against a week inside one month
    expect(monthsApart(claim('4月月报列示在岗人数为7人。'), claim('本周在岗7人', 'fact', ['2025-06-16T00:00:00Z', '2025-06-20T23:59:59Z']))).toBe(true);
    expect(monthsApart(claim('4月月报列示在岗人数为7人。'), claim('本周在岗7人', 'fact', ['2025-04-14T00:00:00Z', '2025-04-18T23:59:59Z']))).toBe(false);
    expect(monthsApart(claim('4月月报列示在岗人数为7人。'), claim('本周在岗7人', 'fact', ['2025-04-28T00:00:00Z', '2025-05-02T23:59:59Z']))).toBe(false);
    // the same forecast in two monthly reports is one forecast
    expect(monthsApart(claim('6月月报预计Orion于第32周上线。', 'prediction'), claim('5月月报预计Orion于第32周上线。', 'prediction'))).toBe(false);
    // nothing to read
    expect(monthsApart(claim('在岗7人'), claim('在岗8人'))).toBe(false);
  });
});

describe('the duplicate-claim audit before the judge', () => {
  const opened: AppContext[] = [];
  afterAll(async () => {
    for (const ctx of opened) {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });

  it('settles worded-alike events of other weeks itself, and still asks about one week', async () => {
    const dataDir = path.join(tmp, 'events');
    initDataDir(dataDir);
    const doc = (title: string, statement: string, eventDate: string) => [
      '---', `title: ${title}`, 'entities:', '  - { name: 平台组, type: organization }',
      'claims:', `  - { subject: 平台组, statement: ${JSON.stringify(statement)}, eventDate: "${eventDate}" }`, '---', `# ${title}`, '',
    ].join('\n');
    const files: [string, string][] = [
      ['raw/docs/a.md', doc('第10周', '平台组发生缓存击穿事故，已由常博修复', '2025-W10')],
      ['raw/docs/b.md', doc('第20周', '平台组发生缓存击穿事故，已由余涛修复', '2025-W20')],
      ['raw/docs/c.md', doc('第20周补记', '平台组发生缓存击穿事故，已由余涛修复完毕', '2025-W20')],
    ];
    for (const [p, text] of files) {
      fs.mkdirSync(path.dirname(path.join(dataDir, p)), { recursive: true });
      fs.writeFileSync(path.join(dataDir, p), text);
    }
    const ctx = await createContext(dataDir);
    opened.push(ctx);
    await sync(ctx, { llmGraph: false });
    expect(await ctx.store.query(`SELECT 1 FROM claims WHERE subject_id = '平台组' AND event_at IS NOT NULL AND tx_to IS NULL`)).toHaveLength(3);
    const judged = { pairs: 0 };
    const stats = await auditDuplicateClaims({ store: ctx.store, embedder: ctx.embedder, config: ctx.config, llm: countingJudge(judged) });
    // week 10 against either of week 20 is settled by the dates; the two of week 20 are the judge's
    expect(stats.differentTime).toBe(2);
    expect(judged.pairs).toBe(1);
  });
});
