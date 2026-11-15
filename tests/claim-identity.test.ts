import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { auditDuplicateClaims, claimPairId, datesApart, eventSpanEnd, monthsApart, yearlessMonthsOf } from '../src/graph/claim-dedupe.js';
import { applyClaimMerge } from '../src/graph/claim-merge.js';
import { drainCarry, rekeyState, rekeyWeeklyReadings } from '../src/graph/claim-rekey.js';
import { refreshClaimState } from '../src/graph/claim-state-store.js';
import { RawExtractReply } from '../src/graph/llm-extract.js';
import { claimId, isoWeekOf, readingWeek } from '../src/graph/store.js';
import { enqueueTier1, runTier1Pass } from '../src/graph/tier1.js';
import { sync } from '../src/ingest/sync.js';
import { dateStart } from '../src/store/dates.js';
import { foldOptions } from '../src/lineage/scope.js';
import { VECTOR_TYPE } from '../src/store/db.js';
import { recountAll } from '../src/lineage/fold.js';
import { LlmClient } from '../src/llm/client.js';
import { markSupersededClaims } from '../src/wiki/refine.js';

/**
 * A claim's identity (src/graph/store.ts claimId, readingWeek):
 * one sentence a weekly report repeats about a measure is a reading per week, while a
 * restated text value stays one claim. On the 10× reports benchmark (2026-11-14) 603 of
 * 1,440 weekly metric values had folded into another week's claim.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-claim-identity-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const WEEKS = [99.92, 99.91, 99.92, 99.93];
const monday = (k: number) => new Date(Date.UTC(2025, 0, 6 + k * 7)).toISOString().slice(0, 10);
const friday = (k: number) => new Date(Date.UTC(2025, 0, 10 + k * 7)).toISOString().slice(0, 10);

type Extra = (k: number) => NonNullable<RawExtractReply['claims']>;

function fixture(extra?: Extra): Map<string, { text: string; reply: RawExtractReply }> {
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
          ...(extra?.(k) ?? []),
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

async function build(name: string, extra?: Extra): Promise<AppContext> {
  const dataDir = path.join(tmp, name);
  initDataDir(dataDir);
  const docs = fixture(extra);
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
  const reading = {
    statement: '平台组本周服务可用性为99.92%。', attribute: '服务可用性', valueNum: 99.92, dateSource: 'stated',
    validFrom: '2025-06-16T00:00:00.000Z', validTo: '2025-06-20T23:59:59.999Z',
  };

  it('carries the ISO week of a weekly reading of a number', () => {
    expect(readingWeek(reading)).toBe('2025-W25');
    // another day of the week, an open window from a day of it, an event in it: one week, one id
    expect(readingWeek({ ...reading, validFrom: '2025-06-17T00:00:00.000Z', validTo: '2025-06-22T23:59:59.999Z' })).toBe('2025-W25');
    expect(readingWeek({ ...reading, validTo: null })).toBe('2025-W25');
    expect(readingWeek({ ...reading, validFrom: null, validTo: null, eventAt: '2025-06-18T00:00:00.000Z' })).toBe('2025-W25');
    expect(readingWeek({ ...reading, statement: '本周7日年化收益率为2.1%' })).toBe('2025-W25');
    expect(readingWeek({ ...reading, statement: '3号线本周客流为120万人次' })).toBe('2025-W25');
    expect(readingWeek({ ...reading, statement: 'Revenue this week was 3.2m' })).toBe('2025-W25');
    // a later report's restatement of a week, dated by the source with that week
    expect(readingWeek({ ...reading, statement: '七部增长组两周前的周活跃用户为136万。' })).toBe('2025-W25');
    expect(readingWeek({ ...reading, statement: '上周支付成功率为97.4%' })).toBe('2025-W25');
    // a window across two weeks is no week's reading
    expect(readingWeek({ ...reading, validTo: '2025-06-24T23:59:59.999Z' })).toBeNull();
  });

  it('leaves every other claim the identity it had', () => {
    // no figure, or no date at all: not a reading
    expect(readingWeek({ ...reading, statement: '平台组本周R-70仍未解决' })).toBeNull();
    expect(readingWeek({ ...reading, validFrom: null, validTo: null })).toBeNull();
    // not relative to this week: a restated fact or another period's figure is one claim however many reports date it
    for (const statement of [
      '宁德时代净利润120亿元', '六部增长组目前有8人。', '2026Q2 净利润 120 亿元', '下周可用性预计为99.9%',
      '本周公布Q3净利润同比增长20%', '本周披露H1营收12亿元', 'March revenue this week was 3bn', '本周W37完成度46%', '本周确认去年营收12亿元',
      '平台组2025年第24周服务可用性为99.92%', '10月月报列示本周在岗人数为6人', '本周6月18日可用性99.92%', '上周及本周可用性99.92%',
    ]) expect(readingWeek({ ...reading, statement }), statement).toBeNull();
  });

  it('keeps the ids main gave every claim that is not a reading', () => {
    // sha256 of "subject|statement", computed apart from this code
    expect(claimId('宁德时代', '2026Q2 净利润 120 亿元')).toBe('c8139f0950ce4e10b2c8b648');
    expect(claimId('r-70', 'R-70负责人为姜婷。')).toBe('d180122f0f46f32e748ebf1c');
    expect(claimId('六部增长组', '六部增长组目前有8人。')).toBe('328f1c550a9b4a23dc54ce2e');
    expect(claimId('平台组', '平台组本周服务可用性为99.92%。')).toBe('0da6375eef963cfa744fcb25');
    expect(claimId('平台组', '平台组本周服务可用性为99.92%。', '2025-W25')).not.toBe('0da6375eef963cfa744fcb25');
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
    const owner = await ctx.store.query<{ id: string; evidence_count: number }>(`SELECT id, evidence_count FROM claims WHERE subject_id = 'r-70' AND tx_to IS NULL`);
    // the id main gave it
    expect(owner).toEqual([{ id: 'd180122f0f46f32e748ebf1c', evidence_count: WEEKS.length }]);

    // the two 99.92% weeks are worded alike; the audit settles them apart without a model and merges nothing
    const judged = { pairs: 0 };
    const stats = await auditDuplicateClaims({ store: ctx.store, embedder: ctx.embedder, config: ctx.config, llm: countingJudge(judged) });
    expect(judged.pairs).toBe(0);
    expect(stats.merged).toBe(0);
    expect(stats.identical).toBe(0);
    // two readings of other weeks are never even a pair: no verdict is stored for them
    expect(await ctx.store.query(
      `SELECT 1 FROM claim_pair_verdicts v JOIN claims a ON a.id = v.a_id JOIN claims b ON b.id = v.b_id WHERE a.statement = b.statement`,
    )).toHaveLength(0);

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
    // two sources dating one figure a day apart: the judge's, not two times
    const day = (d: string) => week(`${d}T00:00:00Z`, `${d}T23:59:59.999Z`);
    expect(datesApart(day('2025-04-08'), day('2025-04-09'))).toBe(false);
    expect(datesApart(event('2025-04-08T00:00:00Z'), event('2025-04-09T00:00:00Z'))).toBe(false);
    expect(datesApart(day('2025-04-08'), day('2025-04-10'))).toBe(true);
    // a date only the document gives is not the claim's own
    expect(datesApart({ ...none }, week('2025-01-06', '2025-01-10T23:59:59Z'))).toBe(false);
  });
});

describe('months a statement names without a year', () => {
  const claim = (statement: string, kind = 'fact', window: [string, string] | null = null, attribute: string | null = '在岗人数') => ({
    statement, kind, attribute, valid_from: window?.[0] ?? null, valid_to: window?.[1] ?? null,
  });

  it('are the fact\'s months, and a report\'s month only for a measured state that names no other time', () => {
    expect([...yearlessMonthsOf('8月五部平台组在岗人数为6人')]).toEqual([8]);
    expect([...yearlessMonthsOf('4月月报列示四部支付组在岗人数为7人。', true)]).toEqual([4]);
    expect(yearlessMonthsOf('4月月报列示四部支付组在岗人数为7人。', false).size).toBe(0);
    expect(yearlessMonthsOf('5月月报列示Orion已于第18周上线', true).size).toBe(0);
    expect(yearlessMonthsOf('4月月报列示一季度营收为3亿元', true).size).toBe(0);
    expect(yearlessMonthsOf('3月期Shibor为1.8%', true).size).toBe(0);
    expect(yearlessMonthsOf('6个月期存款利率为1.5%').size).toBe(0);
    expect(yearlessMonthsOf('2025年8月结算平台完成度为69%').size).toBe(0);
    expect(yearlessMonthsOf('预计3个月内完成').size).toBe(0);
  });

  it('settle two other months of the year apart, a forecast never', () => {
    // as the benchmark's monthly reports, which carry no date of their own, give them
    expect(monthsApart(claim('4月月报列示四部支付组在岗人数为7人。'), claim('10月月报列示四部支付组在岗人数为8人。'))).toBe(true);
    expect(monthsApart(claim('9月月报列示四部平台组在岗人数为6人。'), claim('9月月报中四部平台组在岗6人。'))).toBe(false);
    // against a week inside one month
    expect(monthsApart(claim('4月月报列示在岗人数为7人。'), claim('本周在岗8人', 'fact', ['2025-06-16T00:00:00Z', '2025-06-20T23:59:59Z']))).toBe(true);
    expect(monthsApart(claim('4月月报列示在岗人数为7人。'), claim('本周在岗7人', 'fact', ['2025-06-16T00:00:00Z', '2025-06-20T23:59:59Z']))).toBe(false);
    expect(monthsApart(claim('4月月报列示在岗人数为7人。'), claim('本周在岗7人', 'fact', ['2025-04-14T00:00:00Z', '2025-04-18T23:59:59Z']))).toBe(false);
    expect(monthsApart(claim('4月月报列示在岗人数为7人。'), claim('本周在岗7人', 'fact', ['2025-04-28T00:00:00Z', '2025-05-02T23:59:59Z']))).toBe(false);
    // the report's month is not the time of what the report says
    expect(monthsApart(claim('5月月报列示Orion已于第18周上线', 'fact', null, null), claim('6月月报列示Orion已于第18周上线', 'fact', null, null))).toBe(false);
    expect(monthsApart(claim('4月月报列示一季度营收为3亿元', 'fact', null, '营收'), claim('5月月报列示一季度营收为3.2亿元', 'fact', null, '营收'))).toBe(false);
    expect(monthsApart(claim('3月期Shibor为1.8%', 'fact', null, 'Shibor'), claim('6月期Shibor为1.9%', 'fact', null, 'Shibor'))).toBe(false);
    // a report's month for a figure two reports give alike says nothing of when it held: registered capital stays put
    expect(monthsApart(claim('4月月报列示注册资本为5000万元', 'fact', null, '注册资本'), claim('5月月报列示注册资本为5000万元', 'fact', null, '注册资本'))).toBe(false);
    expect(monthsApart(claim('9月月报列示四部平台组在岗人数为6人。'), claim('10月月报列示四部平台组在岗人数为6人。'))).toBe(false);
    // the same forecast in two monthly reports is one forecast
    expect(monthsApart(claim('6月月报预计Orion于第32周上线。', 'prediction'), claim('5月月报预计Orion于第32周上线。', 'prediction'))).toBe(false);
    // and not by its kind alone: it names week 32, the report's month is not its time
    expect(monthsApart(claim('6月月报预计Orion于第32周上线。'), claim('5月月报预计Orion于第32周上线。'))).toBe(false);
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

describe('weekly readings worded alike, in every shape of date', () => {
  const opened: AppContext[] = [];
  afterAll(async () => {
    for (const ctx of opened) {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });
  const VALUES = [99.92, 99.91, 99.92, 99.93, 99.92];
  // the shapes an extraction may give "本周" in: a start without an end, a month, an ISO week
  const shapes: Record<string, (k: number) => { startDate?: string; endDate?: string; eventDate?: string }> = {
    'open windows': (k) => ({ startDate: monday(k) }),
    'monthly event dates': (k) => ({ eventDate: `2025-0${k + 1}` }),
    'week event dates': (k) => ({ eventDate: `2025-W${36 + k}` }),
  };

  for (const [shape, dates] of Object.entries(shapes)) {
    it(`stay apart with ${shape}, whatever claimMerge says`, async () => {
      const dataDir = path.join(tmp, `shape-${shape.replace(/\s+/g, '-')}`);
      initDataDir(dataDir);
      const docs = new Map<string, { text: string; reply: RawExtractReply }>();
      VALUES.forEach((v, k) => docs.set(`raw/docs/周报/平台组/s${k + 1}.md`, {
        text: `# 平台组周报 · 第${k + 2}周\n\n本周服务可用性为${v}%。\n`,
        reply: {
          entities: [{ name: '平台组', type: 'organization', aliases: [] }],
          relations: [],
          claims: [{ subject: '平台组', statement: `平台组本周服务可用性为${v}%。`, type: 'other', status: 'fact', kind: 'fact', attribute: '服务可用性', value: v, unit: '%', ...dates(k) }],
        },
      }));
      for (const [p, d] of docs) {
        fs.mkdirSync(path.dirname(path.join(dataDir, p)), { recursive: true });
        fs.writeFileSync(path.join(dataDir, p), d.text);
      }
      const ctx = await createContext(dataDir);
      opened.push(ctx);
      await sync(ctx, { llmGraph: false });
      for (const d of await ctx.store.query<{ id: string }>(`SELECT id FROM documents WHERE root = 'docs'`)) await enqueueTier1(ctx.store, d.id);
      (ctx.config.extraction as { entityLlm?: unknown }).entityLlm = undefined;
      for (let i = 0; i < 10; i++) if ((await runTier1Pass(ctx.store, ctx.config, stubExtractor(docs), { batchSize: 64 })).queued === 0) break;
      const ids = async () => (await ctx.store.query<{ id: string }>(
        `SELECT id FROM claims WHERE subject_id = '平台组' AND statement = '平台组本周服务可用性为99.92%。' AND tx_to IS NULL AND canonical_id IS NULL`,
      )).map((r) => r.id);
      expect(await ids()).toHaveLength(3);
      for (const mode of ['suggest', 'auto'] as const) {
        const judged = { pairs: 0 };
        const config = { ...ctx.config, review: { ...ctx.config.review, claimMerge: mode } };
        await auditDuplicateClaims({ store: ctx.store, embedder: ctx.embedder, config, llm: countingJudge(judged) });
        expect(await ids(), mode).toHaveLength(3);
        // nothing between the three is stored as the same claim, and no judge is asked about them
        const same = await ctx.store.query(
          `SELECT 1 FROM claim_pair_verdicts v JOIN claims a ON a.id = v.a_id JOIN claims b ON b.id = v.b_id
           WHERE a.statement = b.statement AND v.relation IN ('same', 'contains')`,
        );
        expect(same, mode).toHaveLength(0);
      }
    });
  }
});

describe('nearest claims by embedding', () => {
  const opened: AppContext[] = [];
  afterAll(async () => {
    for (const ctx of opened) {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });

  it('are other statements: a reading\'s weekly twins take one place among a claim\'s five, not all', async () => {
    const dataDir = path.join(tmp, 'near');
    initDataDir(dataDir);
    const docs = new Map<string, { text: string; reply: RawExtractReply }>();
    const twin = '己公司本周营收为3亿元。';
    const near = ['己公司收入情况良好。', '己公司营收表现良好。'];
    for (let k = 0; k < 6; k++) docs.set(`raw/docs/周报/己/t${k}.md`, {
      text: `# 己公司周报 ${k}\n\n${twin}${k === 0 ? near.join('') : ''}\n`,
      reply: {
        entities: [{ name: '己公司', type: 'organization', aliases: [] }],
        relations: [],
        claims: [
          { subject: '己公司', statement: twin, type: 'other', status: 'fact', kind: 'fact', attribute: '营收', value: 3, unit: '亿元', startDate: monday(k), endDate: friday(k) },
          ...(k === 0 ? near.map((statement) => ({ subject: '己公司', statement, type: 'other', status: 'fact', kind: 'fact' })) : []),
        ],
      },
    });
    for (const [p, d] of docs) {
      fs.mkdirSync(path.dirname(path.join(dataDir, p)), { recursive: true });
      fs.writeFileSync(path.join(dataDir, p), d.text);
    }
    const ctx = await createContext(dataDir);
    opened.push(ctx);
    await sync(ctx, { llmGraph: false });
    for (const d of await ctx.store.query<{ id: string }>(`SELECT id FROM documents WHERE root = 'docs'`)) await enqueueTier1(ctx.store, d.id);
    (ctx.config.extraction as { entityLlm?: unknown }).entityLlm = undefined;
    for (let i = 0; i < 10; i++) if ((await runTier1Pass(ctx.store, ctx.config, stubExtractor(docs), { batchSize: 64 })).queued === 0) break;
    expect(await ctx.store.query(`SELECT 1 FROM claims WHERE statement = $1 AND tx_to IS NULL`, [twin])).toHaveLength(6);

    // the twins one vector; the first near claim 0.99 from them, the second 0.95 from both
    const dim = ctx.store.embeddingDim;
    const unit = (parts: [number, number][]) => Array.from({ length: dim }, (_, i) => parts.find(([k]) => k === i)?.[1] ?? 0);
    const vectors = new Map<string, number[]>([
      [twin, unit([[0, 1]])],
      [near[0], unit([[0, 0.99], [1, Math.sqrt(1 - 0.99 ** 2)]])],
      [near[1], unit([[0, 0.95], [2, Math.sqrt(1 - 0.95 ** 2)]])],
    ]);
    const embedder = { model: 'test-vectors', dimensions: dim, embed: async (texts: string[]) => texts.map((t) => vectors.get(t.slice(t.indexOf('：') + 1))!) };
    const config = { ...ctx.config, embedding: { ...ctx.config.embedding, provider: 'openai' as const } };
    const shown: string[] = [];
    const complete = async (messages: { role: string; content: string }[]) => {
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      shown.push(...[...user.matchAll(/\nA: "([^"]*)"[\s\S]*?\nB: "([^"]*)"/g)].map((m) => [m[1], m[2]].sort().join(' | ')));
      return JSON.stringify({ verdicts: [] });
    };
    const llm = { enabled: true, label: 'stub', provider: 'openai', model: 'stub', complete } as unknown as LlmClient;
    await auditDuplicateClaims({ store: ctx.store, embedder, config, llm });
    // the two near claims meet, though six twins are nearer to the first
    expect(shown).toContain([near[0], near[1]].sort().join(' | '));
  });
});

describe('a workspace written before weekly readings had ids', () => {
  const opened: AppContext[] = [];
  afterAll(async () => {
    for (const ctx of opened) {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });

  /** Put every claim's evidence back on the id main gave it (subject + statement), as main wrote it. */
  async function asMainWroteIt(ctx: AppContext): Promise<void> {
    const rows = await ctx.store.query<{ id: string; subject_id: string; statement: string }>(`SELECT id, subject_id, statement FROM claims`);
    for (const c of rows) {
      const legacy = claimId(c.subject_id, c.statement);
      if (legacy === c.id) continue;
      await ctx.store.query(
        `INSERT INTO claims (id, subject_id, object_id, type, statement, status, kind, valid_from, valid_to, tx_from)
         SELECT $2, subject_id, object_id, type, statement, status, kind, valid_from, valid_to, tx_from FROM claims WHERE id = $1 ON CONFLICT (id) DO NOTHING`,
        [c.id, legacy],
      );
      await ctx.store.query(`UPDATE evidence SET target_id = $2 WHERE kind = 'claim' AND target_id = $1`, [c.id, legacy]);
      await ctx.store.query(`DELETE FROM claims WHERE id = $1`, [c.id]);
    }
    await recountAll(ctx.store, new Date().toISOString(), foldOptions(ctx.dataDir));
    await ctx.store.query(`DELETE FROM meta WHERE key = 'claim_identity'`);
  }

  it('never merges a new reading into an old claim of its week, and moves in bounded steps carrying decisions', async () => {
    const ctx = await build('legacy');
    opened.push(ctx);
    // a database made by this code has nothing to move
    expect(await rekeyState(ctx.store)).toEqual({ cursor: null, done: true });
    await asMainWroteIt(ctx);
    const live = async (statement: string) => ctx.store.query<{ id: string; evidence_count: number; canonical_id: string | null }>(
      `SELECT id, evidence_count, canonical_id FROM claims WHERE statement = $1 AND tx_to IS NULL ORDER BY valid_from`, [statement],
    );
    const s9992 = '平台组本周服务可用性为99.92%。';
    const s9993 = '平台组本周服务可用性为99.93%。';
    // as main left it: weeks 1 and 3 one claim
    expect(await live(s9992)).toMatchObject([{ id: claimId('平台组', s9992), evidence_count: 2 }]);
    const old9993 = claimId('平台组', s9993);
    const owner = 'd180122f0f46f32e748ebf1c';
    // a person rejected merging the 99.93% claim with the owner claim, and a judge once looked at the pair
    await ctx.store.query(
      `INSERT INTO suggestions (id, kind, title, body, status, payload) VALUES ($1, 'claim-merge', '合并', '', 'rejected', $2::jsonb)`,
      [claimPairId(old9993, owner), JSON.stringify({ claimId: old9993, canonicalId: owner, kind: 'same_as' })],
    );
    await ctx.store.query(
      `INSERT INTO claim_pair_verdicts (pair_id, a_id, b_id, relation, confidence, reason, model) VALUES ($1, $2, $3, 'unrelated', 0.9, '测试', 'judge')`,
      [claimPairId(old9993, owner), old9993, owner],
    );
    // and its vector, paid once, embeds "subject：statement": the same for every week of it
    const vec = `[${Array.from({ length: ctx.store.embeddingDim }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`;
    await ctx.store.query(`INSERT INTO claim_embeddings (claim_id, model, embedding) VALUES ($1, 'test', $2::${VECTOR_TYPE})`, [old9993, vec]);
    await ctx.store.query(`INSERT INTO claim_embeddings (claim_id, model, embedding) VALUES ($1, 'test', $2::${VECTOR_TYPE})`, [claimId('平台组', s9992), vec]);

    // a merge group of two old claims, each one week: the representative comes first by id, so a step moves it
    // before its member (and must not then relink the member to the old, gone representative)
    const s9991 = '平台组本周服务可用性为99.91%。';
    const [rep, member] = [old9993, claimId('平台组', s9991)].sort();
    await applyClaimMerge(ctx.store, { claimId: member, canonicalId: rep, reason: '测试', actor: 'test' });

    // a second report of week 3 arrives, written as readings are now
    const p = 'raw/docs/周报/平台组/w3b.md';
    fs.writeFileSync(path.join(ctx.dataDir, p), `# 平台组周报 · 第4周（补）\n\n本周服务可用性为99.92%。\n`);
    await sync(ctx, { llmGraph: false });
    const [doc] = await ctx.store.query<{ id: string }>(`SELECT id FROM documents WHERE path = $1`, [p]);
    await enqueueTier1(ctx.store, doc.id);
    const docs = new Map([[p, { reply: { entities: [{ name: '平台组', type: 'organization', aliases: [] }], relations: [], claims: [
      { subject: '平台组', statement: s9992, type: 'other', status: 'fact', kind: 'fact', attribute: '服务可用性', value: 99.92, unit: '%', startDate: monday(2), endDate: friday(2) },
    ] } as RawExtractReply }]]);
    for (let i = 0; i < 5; i++) if ((await runTier1Pass(ctx.store, ctx.config, stubExtractor(docs), { batchSize: 8 })).queued === 0) break;
    const week3 = claimId('平台组', s9992, isoWeekOf(monday(2)));
    expect((await live(s9992)).map((c) => c.id).sort()).toEqual([claimId('平台组', s9992), week3].sort());

    // before the old claims have moved, the audit decides nothing about them: the old claim holds week 3 too
    const judged = { pairs: 0 };
    const before = await auditDuplicateClaims({ store: ctx.store, embedder: ctx.embedder, config: ctx.config, llm: countingJudge(judged) }, { rekeyLimit: 0 });
    expect(before.pendingRekey).toBeGreaterThan(0);
    expect(before.merged).toBe(0);
    expect(judged.pairs).toBe(0);

    // then, two claims a step
    let steps = 0;
    for (let st = await rekeyWeeklyReadings(ctx.store, { limit: 2 }); ; st = await rekeyWeeklyReadings(ctx.store, { limit: 2 })) {
      steps++;
      if (st.done) break;
    }
    expect(steps).toBeGreaterThan(1);
    // weeks 1 and 3 are claims of their own; the old claim's week-3 evidence and the new report's are one claim
    expect((await live(s9992)).map((c) => [c.id, c.evidence_count])).toEqual([[claimId('平台组', s9992, isoWeekOf(monday(0))), 1], [week3, 2]]);
    // the 99.93% claim moved whole: the person's rejection and the judged pair moved with it
    const new9993 = claimId('平台组', s9993, isoWeekOf(monday(3)));
    expect(await live(s9993)).toMatchObject([{ id: new9993 }]);
    expect(await ctx.store.query(`SELECT status FROM suggestions WHERE id = $1`, [claimPairId(new9993, owner)])).toEqual([{ status: 'rejected' }]);
    expect(await ctx.store.query(`SELECT relation FROM claim_pair_verdicts WHERE pair_id = $1`, [claimPairId(new9993, owner)])).toEqual([{ relation: 'unrelated' }]);
    // the group moved with its two claims
    const successor = (id: string) => (id === old9993 ? new9993 : claimId('平台组', s9991, isoWeekOf(monday(1))));
    expect(await ctx.store.query(`SELECT canonical_id FROM claims WHERE id = $1`, [successor(member)])).toEqual([{ canonical_id: successor(rep) }]);
    // the vectors went to every claim the old ones became
    expect(await ctx.store.query(`SELECT e.claim_id FROM claim_embeddings e JOIN claims c ON c.id = e.claim_id AND c.tx_to IS NULL WHERE e.model = 'test' ORDER BY e.claim_id`)).toEqual(
      [new9993, claimId('平台组', s9992, isoWeekOf(monday(0))), week3].sort().map((claim_id) => ({ claim_id })),
    );
    // the restated owner claim kept its id
    expect(await ctx.store.query(`SELECT id FROM claims WHERE id = $1 AND tx_to IS NULL`, [owner])).toHaveLength(1);

    // and the audit afterwards merges no reading
    const after = await auditDuplicateClaims({ store: ctx.store, embedder: ctx.embedder, config: ctx.config, llm: countingJudge({ pairs: 0 }) });
    expect(after.pendingRekey).toBe(0);
    // (but for the group carried over above)
    expect(await ctx.store.query(`SELECT id FROM claims WHERE statement LIKE '平台组本周服务可用性%' AND canonical_id IS NOT NULL AND tx_to IS NULL`)).toEqual([{ id: successor(member) }]);

    // a re-apply now changes no claim id
    const ids = async () => (await ctx.store.query<{ id: string }>(`SELECT id FROM claims WHERE tx_to IS NULL ORDER BY id`)).map((r) => r.id);
    const was = await ids();
    await sync(ctx, { llmGraph: false, reapply: true });
    expect(await ids()).toEqual(was);
  });
});

describe('what a weekly reading is (review of df45ee5)', () => {
  const week = { validFrom: '2025-06-16T00:00:00.000Z', validTo: '2025-06-20T23:59:59.999Z' };
  const w = (statement: string, dates: Record<string, string | null> = week) => readingWeek({ statement, ...dates });

  it('is a figure of this or an earlier week, named as a word, however the figure is compared', () => {
    expect(w('平台组本周服务可用性为99.92%，较上周增长5%')).toBe('2025-W25');
    expect(w('本周销售额同比去年增长12%')).toBe('2025-W25');
    expect(w('本周成交额为2000亿元')).toBe('2025-W25');
    expect(w('本周完成3项评审')).toBe('2025-W25');
    expect(w('Revenue two weeks ago was 3.2m')).toBe('2025-W25');
    expect(w('上上周完成度为46%')).toBe('2025-W25');
  });

  it('is not a cycle, a company report, or 本周 inside another word', () => {
    for (const statement of ['本周期产能利用率为78%', 'LPR上周期报价为3.45%', '本周三季报披露净利润12亿元', '资本周转率为1.2', '日本周三公布CPI为2.1%', '本周R-70仍未解决']) {
      expect(w(statement), statement).toBeNull();
    }
  });

  it('takes its week from the source\'s own calendar day, the document\'s date when it states none, and none without either', () => {
    // a local midnight east of UTC is stored as the day before in UTC, and no offset is kept to read it back
    // (store.ts calendarDay): a week written that way spans two UTC weeks and keys nothing
    expect(w('本周可用性为99.92%', { validFrom: '2025-06-15T16:00:00.000Z', validTo: '2025-06-20T15:59:59.999Z' })).toBeNull();
    expect(w('本周可用性为99.92%', { observedAt: '2025-06-18T00:00:00.000Z' })).toBe('2025-W25');
    expect(w('两周前可用性为99.92%', { observedAt: '2025-06-18T00:00:00.000Z' })).toBe('2025-W23');
    // a model that dated "两周前" with the report's own week: the statement says which week it is
    expect(w('两周前可用性为99.92%', { ...week, observedAt: '2025-06-18T00:00:00.000Z' })).toBe('2025-W23');
    expect(w('本周可用性为99.92%', {})).toBeNull();
  });

  it('resolves 两周前 and 上上周 against the document date', () => {
    expect(dateStart('两周前', '2025-06-18T00:00:00.000Z')).toBe('2025-06-02T00:00:00.000Z');
    expect(dateStart('上上周', '2025-06-18T00:00:00.000Z')).toBe('2025-06-02T00:00:00.000Z');
    expect(dateStart('3周前', '2025-06-18T00:00:00.000Z')).toBe('2025-05-26T00:00:00.000Z');
  });
});

describe('moving an older workspace (review of df45ee5)', () => {
  const opened: AppContext[] = [];
  afterAll(async () => {
    for (const ctx of opened) {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });
  const s9992 = '平台组本周服务可用性为99.92%。';
  const s9993 = '平台组本周服务可用性为99.93%。';
  const owner = 'd180122f0f46f32e748ebf1c';
  const weekOf = (k: number) => isoWeekOf(monday(k));
  const live = async (ctx: AppContext, statement: string) => (await ctx.store.query<{ id: string }>(
    `SELECT id FROM claims WHERE statement = $1 AND tx_to IS NULL ORDER BY valid_from`, [statement],
  )).map((r) => r.id);

  /** The workspace as main wrote it: each claim's evidence on subject + statement, the claim state as of `format`. */
  async function asWritten(ctx: AppContext, format: 'before-2026-11-13' | 'after'): Promise<void> {
    for (const c of await ctx.store.query<{ id: string; subject_id: string; statement: string }>(`SELECT id, subject_id, statement FROM claims`)) {
      const legacy = claimId(c.subject_id, c.statement);
      if (legacy === c.id) continue;
      await ctx.store.query(
        `INSERT INTO claims (id, subject_id, object_id, type, statement, status, kind, valid_from, valid_to, tx_from)
         SELECT $2, subject_id, object_id, type, statement, status, kind, valid_from, valid_to, '2026-10-01T00:00:00Z' FROM claims WHERE id = $1 ON CONFLICT (id) DO NOTHING`,
        [c.id, legacy],
      );
      await ctx.store.query(`UPDATE evidence SET target_id = $2 WHERE kind = 'claim' AND target_id = $1`, [c.id, legacy]);
      await ctx.store.query(`DELETE FROM claims WHERE id = $1`, [c.id]);
    }
    // evidence before 0f14a235 (2026-11-13) held no claim state
    if (format === 'before-2026-11-13') await ctx.store.query(`UPDATE evidence SET attrs = attrs - 'attribute' - 'value_num' - 'value_text' - 'unit' - 'date_source' - 'correction' WHERE kind = 'claim'`);
    await recountAll(ctx.store, new Date().toISOString(), foldOptions(ctx.dataDir));
    await ctx.store.query(`UPDATE claims SET tx_from = '2026-10-01T00:00:00Z'`);
    await ctx.store.query(`DELETE FROM meta WHERE key = 'claim_identity'`);
  }
  const untilDone = async (ctx: AppContext, limit = 2) => {
    const total = { rekeyed: 0, unmoved: 0, listed: 0 };
    for (;;) {
      const st = await rekeyWeeklyReadings(ctx.store, { limit });
      total.rekeyed += st.rekeyed;
      total.unmoved += st.unmoved;
      total.listed += st.listed;
      if (st.done) return total;
    }
  };

  it('A: moves evidence written before claim state was recorded, and leaves whole what it cannot tell', async () => {
    const ctx = await build('old-format');
    opened.push(ctx);
    await asWritten(ctx, 'before-2026-11-13');
    // and one claim whose evidence predates event dates (2026-09-16) and has no window
    const old9993 = claimId('平台组', s9993);
    await ctx.store.query(`UPDATE evidence SET attrs = (attrs - 'event_at' - 'observed_at') || '{"valid_from": null, "valid_to": null}'::jsonb WHERE kind = 'claim' AND target_id = $1`, [old9993]);
    const total = await untilDone(ctx);
    expect(total.rekeyed).toBeGreaterThan(0);
    expect(await live(ctx, s9992)).toEqual([claimId('平台组', s9992, weekOf(0)), claimId('平台组', s9992, weekOf(2))]);
    expect(await live(ctx, s9993)).toEqual([old9993]);
    expect(total.unmoved).toBe(1);
    expect((await rekeyState(ctx.store)).unmoved).toBe(1);
    // the moved claims are as old as the claims they came from
    expect(await ctx.store.query(`SELECT DISTINCT tx_from FROM claims WHERE statement = $1 AND tx_to IS NULL`, [s9992])).toEqual([{ tx_from: new Date('2026-10-01T00:00:00Z') }]);
  });

  it('B: two steps at once move each evidence row once', async () => {
    const ctx = await build('two-steps');
    opened.push(ctx);
    await asWritten(ctx, 'after');
    const [{ n: before }] = await ctx.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM evidence WHERE kind = 'claim' AND tx_to IS NULL`);
    await Promise.all([rekeyWeeklyReadings(ctx.store, { limit: 100 }), rekeyWeeklyReadings(ctx.store, { limit: 100 })]);
    const [{ n: after }] = await ctx.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM evidence WHERE kind = 'claim' AND tx_to IS NULL`);
    expect(after).toBe(before);
    expect(await ctx.store.query(`SELECT evidence_count FROM claims WHERE statement = $1 AND tx_to IS NULL`, [s9992])).toEqual([{ evidence_count: 1 }, { evidence_count: 1 }]);
  });

  it('C: a claim that splits carries a refusal to every week, and a person\'s merge week by week or to the person', async () => {
    const release = '平台组本周发布2次。';
    const duty = '平台组本周值班2人。';
    const ctx = await build('split-carry', (k) => [
      ...(k === 0 || k === 2 ? [{ subject: '平台组', statement: release, type: 'other', status: 'fact', kind: 'fact', attribute: '发布次数', value: 2, startDate: monday(k), endDate: friday(k) }] : []),
      ...(k === 0 || k === 1 ? [{ subject: '平台组', statement: duty, type: 'other', status: 'fact', kind: 'fact', attribute: '值班人数', value: 2, startDate: monday(k), endDate: friday(k) }] : []),
    ]);
    opened.push(ctx);
    await asWritten(ctx, 'after');
    const L = claimId('平台组', s9992);
    // a person refused merging the 99.92% claim with the owner claim, and merged two other claims into it
    await ctx.store.query(
      `INSERT INTO suggestions (id, kind, title, body, status, payload) VALUES ($1, 'claim-merge', '合并', '', 'rejected', $2::jsonb)`,
      [claimPairId(L, owner), JSON.stringify({ claimId: L, canonicalId: owner, kind: 'same_as' })],
    );
    await applyClaimMerge(ctx.store, { claimId: claimId('平台组', release), canonicalId: L, reason: '同一件事', actor: 'user' });
    await applyClaimMerge(ctx.store, { claimId: claimId('平台组', duty), canonicalId: L, reason: '同一件事', actor: 'user' });

    // a step whose carrying was cut short: the moves are there, the decisions not yet
    await rekeyWeeklyReadings(ctx.store, { limit: 100, carry: false });
    const refused = async () => (await ctx.store.query<{ id: string }>(`SELECT id FROM suggestions WHERE status = 'rejected' ORDER BY id`)).map((r) => r.id);
    const weeks = [claimId('平台组', s9992, weekOf(0)), claimId('平台组', s9992, weekOf(2))];
    expect(await live(ctx, s9992)).toEqual(weeks);
    expect(await refused()).toEqual([claimPairId(L, owner)]);
    // the next run carries them
    const resumed = await drainCarry(ctx.store);
    expect(resumed.carried).toBeGreaterThan(0);
    expect(await refused()).toEqual([claimPairId(L, owner), ...weeks.map((w) => claimPairId(w, owner))].sort());
    // weeks 1 and 3 of the release figure join weeks 1 and 3; the duty figure's week 1 joins week 1, its week 2 has none to join
    const canon = async (id: string) => (await ctx.store.query<{ canonical_id: string | null }>(`SELECT canonical_id FROM claims WHERE id = $1`, [id]))[0]?.canonical_id;
    expect(await canon(claimId('平台组', release, weekOf(0)))).toBe(weeks[0]);
    expect(await canon(claimId('平台组', release, weekOf(2)))).toBe(weeks[1]);
    expect(await canon(claimId('平台组', duty, weekOf(0)))).toBe(weeks[0]);
    expect(await canon(claimId('平台组', duty, weekOf(1)))).toBeNull();
    expect(resumed.listed).toBe(1);
    expect(await ctx.store.query(`SELECT status FROM suggestions WHERE payload->>'claimId' = $1 AND status = 'pending'`, [claimId('平台组', duty, weekOf(1))])).toEqual([{ status: 'pending' }]);
  });
});

describe('what a weekly reading is (review of 4ec34fd)', () => {
  const w = (statement: string, dates: Record<string, string | null>) => readingWeek({ statement, ...dates });
  const week25 = { validFrom: '2025-06-16T00:00:00.000Z', validTo: '2025-06-20T23:59:59.999Z' };

  it('2: reads a stored instant by its own calendar date, a Sunday evening included', () => {
    // 2025-06-22T20:30+08:00, stored as UTC: still Sunday the 22nd, week 25
    expect(w('本周可用性为99.92%', { eventAt: '2025-06-22T12:30:00.000Z' })).toBe('2025-W25');
    expect(w('本周可用性为99.92%', { eventAt: '2025-06-22T23:59:00.000Z' })).toBe('2025-W25');
    expect(w('本周可用性为99.92%', { eventAt: '2025-06-23T00:00:00.000Z' })).toBe('2025-W26');
  });

  it('3: dates the model gave the named week are not shifted again, from a weekday or a weekend report', () => {
    // a recap of last week, dated Mon–Fri of it, in Sunday's and in Monday's report: one week
    expect(w('上周可用性为99.92%', { ...week25, observedAt: '2025-06-22T00:00:00.000Z' })).toBe('2025-W25');
    expect(w('上周可用性为99.92%', { ...week25, observedAt: '2025-06-23T00:00:00.000Z' })).toBe('2025-W25');
    // a weekday report that gave "上周" its own week: the statement says it was the week before
    expect(w('上周可用性为99.92%', { validFrom: '2025-06-23T00:00:00.000Z', validTo: '2025-06-27T23:59:59.999Z', observedAt: '2025-06-25T00:00:00.000Z' })).toBe('2025-W25');
  });

  it('reads these as weekly readings too', () => {
    expect(w('截至上周五累计完成87%', { ...week25 })).toBe('2025-W25');
    expect(w('上周末客流为12万人次', { validFrom: '2025-06-21T00:00:00.000Z', validTo: '2025-06-22T23:59:59.999Z' })).toBe('2025-W25');
    expect(w('综合本周数据，转化率为3.2%', { ...week25 })).toBe('2025-W25');
    expect(w('本周当前年化收益率为2.1%', { ...week25 })).toBe('2025-W25');
  });

  it('does not settle a change of plan as two times', () => {
    const c = (statement: string) => ({ statement, kind: 'fact', attribute: null, valid_from: null, valid_to: null });
    expect(monthsApart(c('Atlas计划于6月上线'), c('Atlas上线推迟至8月'))).toBe(false);
  });
});
