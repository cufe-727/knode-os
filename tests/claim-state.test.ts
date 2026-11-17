import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { auditDuplicateClaims, seriesRelation } from '../src/graph/claim-dedupe.js';
import { formatValue, keyQualifiers, sameValue, namesSubject, normalizeAttribute, parseMeasure, seriesObject, subjectSpellingsOf, unifyAttributeKeys } from '../src/graph/claim-state.js';
import { refreshClaimState, seriesSupersession, StateRow } from '../src/graph/claim-state-store.js';
import { namesakeClusters, NamesakeDoc, renameIn, resolveEntityContext } from '../src/graph/entity-context.js';
import { buildBatchExtractRequest, buildExtractRequest, RawExtractReply } from '../src/graph/llm-extract.js';
import { enqueueTier1, runTier1Pass } from '../src/graph/tier1.js';
import { runDocumentPass } from '../src/ingest/background.js';
import { sync } from '../src/ingest/sync.js';
import { LlmClient } from '../src/llm/client.js';
import { normalizeDateExpr } from '../src/store/dates.js';
import { ensureEntityStubs } from '../src/wiki/pages.js';
import { markSupersededClaims, supersedeForClaims } from '../src/wiki/refine.js';

/** docs/design/29: claims as current state plus history, the judge pre-filter, namesakes and renames. */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-claim-state-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('reading a claim as attribute + value', () => {
  it('reads measures, owners and plans, leaving dates, tickets and clauses alone', () => {
    expect(parseMeasure('风控引擎完成度为11%。', '风控引擎')).toEqual({ attribute: '进度', valueNum: 11, valueText: null, unit: '%' });
    expect(parseMeasure('结算中台完成度可能为24%', '结算中台')).toMatchObject({ attribute: '进度', valueNum: 24 });
    expect(parseMeasure('Orion项目完成度为68%。', 'Orion')).toMatchObject({ attribute: '进度', valueNum: 68 });
    expect(parseMeasure('支付组本周在岗7人。', '支付组')).toMatchObject({ attribute: '在岗人数', valueNum: 7, unit: '人' });
    expect(parseMeasure('7月月报中支付组在岗人数为9人。', '支付组')).toMatchObject({ attribute: '在岗人数', valueNum: 9 });
    expect(parseMeasure('支付组本周支付成功率为97.46%，环比+0.06%。', '支付组')).toMatchObject({ attribute: '支付成功率', valueNum: 97.46, unit: '%' });
    expect(parseMeasure('2026Q2 营业收入 1000 亿元', '宁德时代')).toMatchObject({ attribute: '营业收入', valueNum: 1000, unit: '亿元' });
    expect(parseMeasure('Atlas completion is 68%', 'Atlas')).toMatchObject({ attribute: 'progress', valueNum: 68, unit: '%' });
    expect(parseMeasure('推荐系统改版由何洋负责。', '推荐系统改版')).toMatchObject({ attribute: '负责人', valueText: '何洋' });
    expect(parseMeasure('风控引擎负责人为陈伟。', '风控引擎')).toMatchObject({ attribute: '负责人', valueText: '陈伟' });
    expect(parseMeasure('结算中台计划于2025年第35周上线。', '结算中台')).toMatchObject({ attribute: '计划上线', valueText: '2025-W35' });
    // a date, a ticket or a clause is no measure
    expect(parseMeasure('郭军整理接口文档，对应工单T2-1422。', '郭军')).toBeNull();
    expect(parseMeasure('支付组与安全团队核对了权限清单。', '支付组')).toBeNull();
    expect(parseMeasure('陈刚给陈悦的数据表修改期限为2026年4月23日中午前。', '陈刚')).toBeNull();
    expect(normalizeAttribute('本周的在岗人员', '支付组')).toBe('在岗人数');
    expect(normalizeAttribute('他们一起完成了很多事情')).toBeNull();
    expect(formatValue({ value_num: 75, unit: '%' })).toBe('75%');
    expect(formatValue({ value_num: 12.5, unit: 'billion' })).toBe('12.5 billion');
    expect(formatValue({ value_text: '孙欣' })).toBe('孙欣');
  });

  it('unifies a subject\'s near-synonym keys of one unit, and leaves keys of other units apart', () => {
    const m = unifyAttributeKeys([
      { attribute: '周活跃用户', count: 10, units: ['万'] },
      { attribute: '周活跃用户数', count: 3, units: ['万'] },
      { attribute: '在岗人数', count: 5, units: ['人'] },
      { attribute: '活跃度', count: 2, units: ['%'] },
    ]);
    // named by the most used key, as stored mappings were named before
    expect(m.get('周活跃用户数')?.canonical).toBe('周活跃用户');
    expect(m.has('在岗人数')).toBe(false);
    expect(m.has('活跃度')).toBe(false);
  });

  it('keeps a change, a first value or a target apart from the measure itself', () => {
    expect(keyQualifiers('支付成功率')).toBe('');
    expect(keyQualifiers('支付成功率环比变化')).toBe(keyQualifiers('支付成功率环比'));
    expect(keyQualifiers('初始间隔')).toBe('初始');
    expect(keyQualifiers('目标价')).toBe('计划');
    const m = unifyAttributeKeys([
      { attribute: '支付成功率', count: 40, units: ['%'] },
      { attribute: '支付成功率环比变化', count: 30, units: ['%'] },
      { attribute: '支付成功率环比', count: 9, units: ['%'] },
      { attribute: '股价', count: 5, units: ['元'] },
      { attribute: '目标价', count: 9, units: ['元'] },
      { attribute: '营收', count: 9, units: ['亿元'] },
      { attribute: '营收指引', count: 3, units: ['亿元'] },
    ], ['贵州茅台']);
    // only the two spellings of one week-on-week change are one key; a target is not the price, guidance not revenue
    expect([...m.entries()].map(([k, v]) => `${k}→${v.canonical}`)).toEqual(['支付成功率环比→支付成功率环比变化']);
  });

  it('makes the keys that name a setting itself one key, and its first value another', () => {
    const spellings = subjectSpellingsOf('对账批次间隔（第一事业部支付组 · T2-C2）', ['T2-C2', '批次间隔']);
    // the name, the name without the split's suffix, the code — not the other aliases
    expect(spellings.sort()).toEqual(['T2-C2', '对账批次间隔', '对账批次间隔（第一事业部支付组 · T2-C2）'].sort());
    expect(namesSubject('间隔', spellings)).toBe(true);
    expect(namesSubject('批次间隔', spellings)).toBe(true);
    expect(namesSubject('配置值', spellings)).toBe(true);
    expect(namesSubject('在岗人数', spellings)).toBe(false);
    // the head of a name is its end: 增长 does not name 增长组
    expect(namesSubject('增长', ['增长组'])).toBe(false);
    // one head word is not one measure, and a value word names nothing of a subject without a code
    expect(namesSubject('连接上限', ['订单库连接池上限'])).toBe(false);
    expect(namesSubject('配置值', ['某基金'])).toBe(false);
    const m = unifyAttributeKeys([
      { attribute: '初始间隔', count: 14, units: ['分钟'] },
      { attribute: '间隔', count: 9, units: ['分钟'] },
      { attribute: '配置值', count: 1, units: ['分钟'] },
      { attribute: '批次间隔', count: 1, units: ['分钟'] },
      { attribute: '初始对账批次间隔', count: 3, units: ['分钟'] },
    ], spellings);
    // canonical by rule: the shortest key that names the setting, whatever the counts
    expect(m.get('配置值')?.canonical).toBe('间隔');
    expect(m.get('批次间隔')?.canonical).toBe('间隔');
    expect(m.has('间隔')).toBe(false);
    expect(m.get('初始对账批次间隔')?.canonical).toBe('初始间隔');
  });

  it('reads a severity as one key however it is called, and names a group by its synonym head', () => {
    expect(normalizeAttribute('事故等级')).toBe('级别');
    const m = unifyAttributeKeys([
      { attribute: '事故级别', count: 3, units: [''] },
      { attribute: '事故等级', count: 2, units: [''] },
    ]);
    expect(m.get('事故等级')?.canonical).toBe('级别');
    expect(m.get('事故级别')?.canonical).toBe('级别');
    // a stored key alone moves to its head: an owner stays an owner however it was read
    expect(unifyAttributeKeys([{ attribute: '跟进人', count: 9, units: [''] }, { attribute: '负责人', count: 3, units: [''] }]).get('跟进人')?.canonical).toBe('负责人');
    expect(unifyAttributeKeys([{ attribute: '跟进人', count: 9, units: [''] }]).get('跟进人')?.canonical).toBe('负责人');
    // 审批状态 contains 状态 and was always one key with it; the group is named by the head, not by the count
    expect(unifyAttributeKeys([{ attribute: '审批状态', count: 9, units: [''] }, { attribute: '状态', count: 3, units: [''] }]).get('审批状态')?.canonical).toBe('状态');
  });

  it('reads one week however a value spells it', () => {
    const v = (valueNum: number | null, valueText: string | null, unit: string | null = null) => ({ valueNum, valueText, unit });
    expect(sameValue(v(null, '2025-W25'), v(null, '2025年第25周'))).toBe(true);
    expect(sameValue(v(null, '第21周'), v(21, null, '周'))).toBe(true);
    expect(sameValue(v(null, '2025-W21'), v(null, '第21周'))).toBe(true);
    expect(sameValue(v(null, '2025-W21'), v(null, '2024-W21'))).toBe(false);
    expect(sameValue(v(null, '第32周'), v(null, '第34周'))).toBe(false);
    expect(sameValue(v(21, null, '周'), v(21, null, '人'))).toBe(false);
  });

  it('reads ISO weeks and relative weeks against the document date', () => {
    expect(normalizeDateExpr('2025-W35')).toMatchObject({ from: '2025-08-25T00:00:00.000Z', to: '2025-08-31T23:59:59.999Z', precision: 'week' });
    expect(normalizeDateExpr('2025年第35周')).toMatchObject({ from: '2025-08-25T00:00:00.000Z' });
    expect(normalizeDateExpr('上周', '2025-09-22T00:00:00Z')).toMatchObject({ from: '2025-09-15T00:00:00.000Z', to: '2025-09-21T23:59:59.999Z' });
    expect(normalizeDateExpr('下周', '2025-03-10T00:00:00Z')).toMatchObject({ from: '2025-03-17T00:00:00.000Z' });
    expect(normalizeDateExpr('第31周', '2025-03-10T00:00:00Z')).toMatchObject({ from: '2025-07-28T00:00:00.000Z' });
  });
});

describe('a series of one attribute', () => {
  const row = (id: string, day: string, value: number, extra: Partial<StateRow> = {}): StateRow => ({
    id, subject: 's', attribute: '进度', object_id: null, kind: 'fact', value_num: value, value_text: null, unit: '%',
    eff: `${day}T00:00:00.000Z`, valid_to: null, correction: false, superseded_by: null, tx_from: '2026-01-01T00:00:00Z', ...extra,
  });

  it('keeps the newest current, supersedes each older value by the next later day, and lets a correction replace the report it corrects', () => {
    const marks = seriesSupersession([
      row('w1', '2025-03-03', 40), row('w2', '2025-03-10', 50), row('w3', '2025-03-17', 55),
      // the same day with another value: a disagreement, neither replaces the other
      row('w3b', '2025-03-17', 57),
      row('fix', '2025-03-17', 52, { correction: true }),
    ]);
    expect(marks.get('w1')).toBe('w2');
    expect(['w3', 'w3b', 'fix']).toContain(marks.get('w2'));
    expect(marks.get('w3b')).toBe('fix');
    expect(marks.get('fix')).toBeNull();
    // w3 has no later day; the correction took w3b (the newest other value up to its day)
    expect(marks.get('w3')).toBeNull();
  });

  it('lets a claim whose window covers the next reading be replaced by the first reading after its window', () => {
    const marks = seriesSupersession([
      // a weekly reading (Monday to Saturday) and a recap dated inside its week
      row('w20', '2025-05-12', 29, { valid_to: '2025-05-17T23:59:59.999Z' }),
      row('recap', '2025-05-16', 31, { valid_to: '2025-05-21T23:59:59.999Z' }),
      row('w21', '2025-05-19', 33, { valid_to: '2025-05-24T23:59:59.999Z' }),
      row('w30', '2025-07-21', 60, { valid_to: '2025-07-26T23:59:59.999Z' }),
    ]);
    // the recap does not replace the reading whose week it falls in; the next week's does
    expect(marks.get('w20')).toBe('w21');
    expect(marks.get('recap')).toBe('w30');
    expect(marks.get('w21')).toBe('w30');
    expect(marks.get('w30')).toBeNull();
  });

  it('keeps a series per object, except where the object is the value or who handles a state', () => {
    // a person named on a state line, and an owner whose object is the owner: one series of the subject
    expect(seriesObject('状态', { id: '赖艳', name: '赖艳', type: 'person' }, '跟进中')).toBe('');
    expect(seriesObject('负责人', { id: '廖欣', name: '廖欣', type: 'person' }, '廖欣')).toBe(seriesObject('负责人', { id: '孙欣', name: '孙欣', type: 'person' }, '孙欣'));
    expect(seriesObject('跟进人', { id: '陈伟平台组', name: '陈伟（平台组）', type: 'person' }, '陈伟')).toBe('');
    expect(normalizeAttribute('跟进人')).toBe('负责人');
    // a thing the attribute belongs to keeps its own series
    expect(seriesObject('负责人', { id: '电池业务', name: '电池业务', type: 'product' }, '李四')).toBe('电池业务');
    expect(seriesObject('状态', { id: '半导体业务', name: '半导体业务', type: 'product' }, '审核中')).toBe('半导体业务');
    expect(seriesObject('持股比例', 'company-a')).not.toBe(seriesObject('持股比例', 'company-b'));
    const base = { subject: 'r-03', kind: 'fact', attribute: '状态', unit: null, value_num: null };
    expect(seriesRelation({ ...base, object: '赖艳', object_name: '赖艳', object_type: 'person', value_text: '跟进中', eff: '2025-06-16' }, { ...base, object: null, value_text: '已关闭', eff: '2025-07-18' })).toBe('different_time');
  });

  it('settles pairs of one series without a model: other days are history, one day and one value are one claim', () => {
    const base = { subject: 's', object: null, kind: 'fact', attribute: '进度', unit: '%', value_text: null };
    expect(seriesRelation({ ...base, value_num: 40, eff: '2025-03-03' }, { ...base, value_num: 50, eff: '2025-03-10' })).toBe('different_time');
    expect(seriesRelation({ ...base, value_num: 40, eff: '2025-03-03' }, { ...base, value_num: 40.0, eff: '2025-03-03T08:00:00Z' })).toBe('same');
    expect(seriesRelation({ ...base, value_num: 40, eff: '2025-03-03' }, { ...base, value_num: 45, eff: '2025-03-03' })).toBeNull();
    expect(seriesRelation({ ...base, value_num: 40, eff: '2025-03-03' }, { ...base, attribute: '在岗人数', value_num: 40, eff: '2025-03-10' })).toBeNull();
  });
});

describe('entity rules', () => {
  it('reads renames', () => {
    expect(renameIn('Atlas项目自2025年5月19日所在周起更名为Orion。')).toMatchObject({ from: null, to: 'Orion' });
    expect(renameIn('Orion（原Atlas）完成度为64%')).toMatchObject({ from: 'Atlas', to: 'Orion' });
    expect(renameIn('Meta Platforms, formerly Facebook, reported revenue')).toMatchObject({ from: 'Facebook', to: 'Meta Platforms' });
    expect(renameIn('风控引擎完成度为11%')).toBeNull();
  });

  const doc = (id: string, date: string, context: string[]): NamesakeDoc => ({ id, path: `${id}.md`, date: `${date}T00:00:00.000Z`, context: new Set(context) });
  const types = (id: string) => (id.startsWith('org:') || id.startsWith('proj:') ? (id.startsWith('org:') ? 'organization' : 'project') : 'person');

  it('splits a name whose documents fall into two teams at the same time, and not a person who moved teams', () => {
    const pay = Array.from({ length: 6 }, (_, i) => doc(`p${i}`, `2025-0${1 + (i % 6)}-05`, ['org:支付组', '郭军', '周艳', 'proj:风控引擎']));
    const plat = Array.from({ length: 5 }, (_, i) => doc(`q${i}`, `2025-0${1 + (i % 6)}-12`, ['org:平台组', '孙欣', '罗宇', 'proj:Atlas']));
    const split = namesakeClusters([...pay, ...plat], types);
    expect(split?.[0].docs.map((d) => d.id).sort()).toEqual(pay.map((d) => d.id).sort());
    expect(split?.[0].anchors).toContain('org:支付组');
    expect(split?.[1].anchors).toContain('org:平台组');
    // one context before, another after: a transfer, not two people
    const before = Array.from({ length: 6 }, (_, i) => doc(`a${i}`, `2025-01-0${i + 1}`, ['org:支付组', '郭军', '周艳']));
    const after = Array.from({ length: 6 }, (_, i) => doc(`b${i}`, `2025-06-0${i + 1}`, ['org:平台组', '孙欣', '罗宇']));
    expect(namesakeClusters([...before, ...after], types)).toBeNull();
    // one context throughout: one person
    expect(namesakeClusters(pay, types)).toBeNull();
  });
});

/* ------------------------------- the fixture build ------------------------------- */

const PAY_WEEKS = 12;
const PLAT_WEEKS = 8;
const week = (k: number, offsetDays = 0) => new Date(Date.UTC(2025, 0, 6 + k * 7 + offsetDays)).toISOString().slice(0, 10);
const progressOf = (k: number) => 10 + k * 5;
const headcountOf = (k: number) => (k >= 4 && k < 8 ? 8 : 7);
const wauOf = (k: number) => 140 + k;

/** The extraction the stub model gives for each document, keyed by path. */
function fixture(): Map<string, { text: string; reply: RawExtractReply }> {
  const out = new Map<string, { text: string; reply: RawExtractReply }>();
  for (let k = 0; k < PAY_WEEKS; k++) {
    const p = `raw/docs/周报/支付组/${week(k)}.md`;
    const synonym = k % 3 === 2 ? '进度' : '完成度';
    out.set(p, {
      text: `# 支付组周报 第${k + 1}周\n\n风控引擎${synonym}${progressOf(k)}%，负责人陈伟。在岗${headcountOf(k)}人。周活跃用户${wauOf(k)}万。郭军、周艳参加评审。\n`,
      reply: {
        entities: [
          { name: '支付组', type: 'organization', aliases: [] },
          { name: '风控引擎', type: 'component', aliases: [] },
          { name: '陈伟', type: 'person', aliases: [] },
          { name: '郭军', type: 'person', aliases: [] },
          { name: '周艳', type: 'person', aliases: [] },
        ],
        relations: [{ source: '陈伟', target: '支付组', type: 'member_of' }],
        claims: [
          { subject: '风控引擎', statement: `风控引擎${synonym}为${progressOf(k)}%`, type: 'fundamentals', status: 'fact', kind: 'fact', attribute: synonym, value: progressOf(k), unit: '%' },
          // the model left the fields out: the statement is read instead; the same sentence in many weeks is one claim
          { subject: '支付组', statement: `支付组在岗人数为${headcountOf(k)}人`, type: 'management', status: 'fact', kind: 'fact' },
          { subject: '支付组', statement: k % 2 ? `支付组周活跃用户数为${wauOf(k)}万` : `支付组周活跃用户为${wauOf(k)}万`, type: 'fundamentals', status: 'fact', kind: 'fact' },
          { subject: '陈伟', statement: '陈伟负责风控引擎', type: 'management', status: 'fact', kind: 'fact' },
        ],
      },
    });
  }
  // a correction of last week's figure
  const fix = `raw/docs/周报/支付组/${week(PAY_WEEKS)}.md`;
  out.set(fix, {
    text: `# 支付组周报 更正\n\n更正：上周风控引擎完成度应为62%，而非${progressOf(PAY_WEEKS - 1)}%。陈伟、郭军已核对。\n`,
    reply: {
      entities: [{ name: '支付组', type: 'organization' }, { name: '风控引擎', type: 'component' }, { name: '陈伟', type: 'person' }, { name: '郭军', type: 'person' }, { name: '周艳', type: 'person' }],
      relations: [],
      claims: [{ subject: '风控引擎', statement: '更正：风控引擎上周完成度应为62%', type: 'fundamentals', status: 'fact', kind: 'fact', attribute: '完成度', value: 62, unit: '%', corrects: true, startDate: week(PAY_WEEKS - 1) }],
    },
  });
  for (let k = 0; k < PLAT_WEEKS; k++) {
    const p = `raw/docs/周报/平台组/${week(k, 2)}.md`;
    const renamed = k >= 4;
    const project = renamed ? 'Orion' : 'Atlas';
    const claims: RawExtractReply['claims'] = [
      { subject: project, statement: `${project}完成度为${30 + k * 6}%`, type: 'fundamentals', status: 'fact', kind: 'fact', attribute: '完成度', value: 30 + k * 6, unit: '%' },
      { subject: '陈伟', statement: `陈伟本周迁移历史数据第${k + 1}批`, type: 'other', status: 'fact', kind: 'fact' },
    ];
    if (k === 4) claims.push({ subject: 'Orion', statement: `Atlas项目自${week(k, 2)}所在周起更名为Orion`, type: 'event', status: 'fact', kind: 'fact' });
    out.set(p, {
      text: `# 平台组周报 第${k + 1}周\n\n${project}完成度${30 + k * 6}%${k === 4 ? '（原项目名Atlas，自本周起改名为Orion）' : ''}。陈伟：迁移历史数据。孙欣、罗宇参加评审。\n`,
      reply: {
        entities: [
          { name: '平台组', type: 'organization', aliases: [] },
          // as in the benchmark run, the renamed project came out as an entity of its own
          { name: project, type: 'project', aliases: [] },
          ...(k === 4 ? [{ name: 'Atlas', type: 'project', aliases: [] }] : []),
          { name: '陈伟', type: 'person', aliases: [] },
          { name: '孙欣', type: 'person', aliases: [] },
          { name: '罗宇', type: 'person', aliases: [] },
        ],
        relations: [{ source: '陈伟', target: '平台组', type: 'member_of' }],
        claims,
      },
    });
  }
  return out;
}

/** A model that answers single and batched extraction requests from the fixture, and counts its calls. */
function stubExtractor(docs: Map<string, { reply: RawExtractReply }>, calls: { n: number; chars: number }): LlmClient {
  const reply = (p: string) => docs.get(p)?.reply ?? { entities: [], relations: [], claims: [] };
  const completeJson = async (messages: { role: string; content: string }[]) => {
    calls.n++;
    calls.chars += messages.reduce((n, m) => n + m.content.length, 0);
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    const batched = [...user.matchAll(/^=== Document (\d+): .* \((raw\/docs\/[^)]+)\) ===$/gm)];
    if (batched.length > 0) return { documents: batched.map((m) => ({ doc: Number(m[1]), ...reply(m[2]) })) };
    const single = /Document: .* \((raw\/docs\/[^)]+)\)/.exec(user);
    return reply(single?.[1] ?? '');
  };
  return { enabled: true, label: 'stub@extract', provider: 'openai', model: 'stub', completeJson } as unknown as LlmClient;
}

/** A judge that calls every pair it is shown the same, counting its calls and pairs. */
function countingJudge(count: { calls: number; pairs: number }): LlmClient {
  const complete = async (messages: { role: string; content: string }[]) => {
    count.calls++;
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    const n = [...user.matchAll(/^Pair \d+ — /gm)].length;
    if (process.env.DEBUG_JUDGE) console.log(user.slice(0, 1500));
    count.pairs += n;
    return JSON.stringify({ verdicts: Array.from({ length: n }, (_, i) => ({ pair: i + 1, relation: 'different_time', confidence: 0.95, reason: '测试' })) });
  };
  return { enabled: true, label: 'stub@judge', provider: 'openai', model: 'stub', complete } as unknown as LlmClient;
}

async function build(name: string): Promise<{ ctx: AppContext; dataDir: string; calls: { n: number; chars: number } }> {
  const dataDir = path.join(tmp, name);
  initDataDir(dataDir);
  const docs = fixture();
  for (const [p, d] of docs) write(dataDir, p, d.text);
  const ctx = await createContext(dataDir);
  await sync(ctx, { llmGraph: false });
  for (const d of await ctx.store.query<{ id: string }>(`SELECT id FROM documents WHERE root = 'docs'`)) await enqueueTier1(ctx.store, d.id);
  const calls = { n: 0, chars: 0 };
  const llm = stubExtractor(docs, calls);
  // no extraction route of its own: the pass calls the stub it is given
  (ctx.config.extraction as { entityLlm?: unknown }).entityLlm = undefined;
  for (let i = 0; i < 10; i++) {
    const stats = await runTier1Pass(ctx.store, ctx.config, llm, { batchSize: 64 });
    if (stats.queued === 0) break;
  }
  return { ctx, dataDir, calls };
}

describe('a fixture build of weekly reports', () => {
  const opened: AppContext[] = [];
  afterAll(async () => {
    for (const ctx of opened) {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });

  it('extracts short documents several to a call, at a fraction of the prompt', async () => {
    const { ctx, calls } = await build('batched');
    opened.push(ctx);
    const docs = PAY_WEEKS + 1 + PLAT_WEEKS;
    expect(calls.n).toBe(Math.ceil(docs / 8));
    const [{ n }] = await ctx.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM documents d WHERE root = 'docs' AND NOT EXISTS (SELECT 1 FROM extraction_queue q WHERE q.document_id = d.id)`);
    expect(n).toBe(docs);
    // what one call per document would have sent
    const single = [...fixture().entries()].reduce((sum, [p, d]) => sum + buildExtractRequest({ path: p, title: p }, d.text, { docDate: '2025-01-06' }).messages.reduce((x, m) => x + m.content.length, 0), 0);
    expect(calls.chars).toBeLessThan(single * 0.2);
    const items = [...fixture().entries()].slice(0, 8).map(([p, d]) => ({ page: { path: p, title: p }, content: d.text, docDate: '2025-01-06' }));
    expect(buildBatchExtractRequest(items).messages[0].content).toContain('"documents":[{"doc":1,');
  });

  it('settles a series without the judge: the calls a build used to pay for are gone', async () => {
    // before: the same claims without their state, as main stored them
    const before = await build('judge-before');
    opened.push(before.ctx);
    await before.ctx.store.query(`UPDATE claims SET attribute = NULL, value_num = NULL, value_text = NULL, unit = NULL, effective_at = NULL, date_source = NULL`);
    const was = { calls: 0, pairs: 0 };
    const old = await auditDuplicateClaims({ store: before.ctx.store, embedder: before.ctx.embedder, config: before.ctx.config, llm: countingJudge(was) }, { stateRules: false });

    const after = await build('judge-after');
    opened.push(after.ctx);
    await refreshClaimState(after.ctx.store);
    const now = { calls: 0, pairs: 0 };
    const stats = await auditDuplicateClaims({ store: after.ctx.store, embedder: after.ctx.embedder, config: after.ctx.config, llm: countingJudge(now) });

    expect(old.judged).toBeGreaterThan(20);
    expect(was.calls).toBeGreaterThanOrEqual(3);
    expect(stats.series).toBeGreaterThan(20);
    expect(now.pairs).toBeLessThan(was.pairs * 0.1);
    expect(now.calls).toBeLessThan(was.calls);
    console.log(`judge on the fixture series: ${was.calls} calls / ${was.pairs} pairs before, ${now.calls} calls / ${now.pairs} pairs after (${stats.series} settled as a series)`);
  });

  it('compiles one current value per attribute with its history, merges the rename and splits the namesake', async () => {
    const { ctx, dataDir } = await build('state');
    opened.push(ctx);

    // entity rules first, as refine runs them
    const resolved = await resolveEntityContext(ctx.store, { config: ctx.config });
    expect(resolved).toMatchObject({ merged: 1, split: 1 });
    expect(resolved.replayed).toBe(PLAT_WEEKS);
    const [atlas] = await ctx.store.query<{ canonical_id: string | null }>(`SELECT canonical_id FROM entities WHERE id = 'atlas'`);
    expect(atlas.canonical_id).toBe('orion');
    const [link] = await ctx.store.query<{ reason: string }>(`SELECT reason FROM entity_links WHERE entity_id = 'atlas' AND tx_to IS NULL`);
    expect(link.reason).toContain('更名');
    const [ns] = await ctx.store.query<{ id: string; base_id: string; reason: string; documents: string[] }>(`SELECT id, base_id, reason, documents FROM entity_namesakes`);
    expect(ns).toMatchObject({ id: '陈伟平台组', base_id: '陈伟' });
    expect(await ctx.store.query(`SELECT name FROM entities WHERE id = '陈伟平台组'`)).toEqual([{ name: '陈伟（平台组）' }]);
    expect(ns.reason).toContain('平台组');
    expect(ns.documents).toHaveLength(PLAT_WEEKS);
    const docsOf = async (id: string) => (await ctx.store.query<{ n: number }>(`SELECT count(DISTINCT document_id)::int AS n FROM entity_mentions WHERE entity_id = $1`, [id]))[0].n;
    expect(await docsOf('陈伟')).toBe(PAY_WEEKS + 1);
    expect(await docsOf('陈伟平台组')).toBe(PLAT_WEEKS);
    const platClaims = await ctx.store.query<{ statement: string }>(`SELECT statement FROM claims WHERE subject_id = '陈伟平台组' AND tx_to IS NULL`);
    expect(platClaims).toHaveLength(PLAT_WEEKS);
    expect(await ctx.store.query(`SELECT 1 FROM claims WHERE subject_id = '陈伟' AND statement LIKE '%迁移%' AND tx_to IS NULL`)).toHaveLength(0);
    // a second run decides nothing new
    expect(await resolveEntityContext(ctx.store, { config: ctx.config })).toMatchObject({ merged: 0, split: 0 });

    await refreshClaimState(ctx.store);
    await markSupersededClaims(ctx.store);

    // the catalog view: one current value per attribute, dated by its newest source
    const current = await ctx.store.query<{ attribute: string; value_num: number; effective_at: Date; date_source: string; effective_source_path: string; correction: boolean }>(
      `SELECT v.attribute, v.value_num, v.effective_at, v.date_source, v.effective_source_path, v.correction
       FROM v_claims v JOIN entities e ON e.id = v.subject_id
       WHERE e.name = '风控引擎' AND v.attribute IS NOT NULL AND v.superseded_by IS NULL`,
    );
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ attribute: '进度', value_num: 62, date_source: 'stated', correction: true });
    const headcount = await ctx.store.query<{ value_num: number; effective_at: Date; effective_source_path: string; date_source: string }>(
      `SELECT v.value_num, v.effective_at, v.effective_source_path, v.date_source FROM v_claims v WHERE v.subject_id = '支付组' AND v.attribute = '在岗人数' AND v.superseded_by IS NULL`,
    );
    // "在岗人数为7人" is said in weeks 1-4 and 9-12: one claim, dated by week 12, not week 1
    expect(headcount).toEqual([{ value_num: 7, effective_at: new Date(`${week(PAY_WEEKS - 1)}T00:00:00.000Z`), effective_source_path: `raw/docs/周报/支付组/${week(PAY_WEEKS - 1)}.md`, date_source: 'document' }]);
    // 周活跃用户 and 周活跃用户数 are one key of the subject
    const wau = await ctx.store.query<{ attribute: string; n: number }>(`SELECT attribute, count(*)::int AS n FROM v_claims WHERE subject_id = '支付组' AND attribute LIKE '周活跃%' GROUP BY 1`);
    expect(wau).toEqual([{ attribute: '周活跃用户', n: PAY_WEEKS }]);

    // the page
    await ensureEntityStubs(ctx, { minMentions: 1 });
    const page = (name: string) => fs.readFileSync(path.join(dataDir, 'wiki', 'entities', `${name}.md`), 'utf8');
    const engine = page('风控引擎');
    const state = engine.slice(engine.indexOf('## Current state'));
    expect(state).toMatch(/- \*\*进度\*\*: 62% `\d{4}-\d{2}-\d{2}` _\(corrected\)_ — raw\/docs\/周报\/支付组\//);
    expect(state).toContain(`  - history: ${progressOf(PAY_WEEKS - 1)}% (${week(PAY_WEEKS - 1)}), ${progressOf(PAY_WEEKS - 2)}% (${week(PAY_WEEKS - 2)})`);
    expect(engine.match(/完成度为\d+%/g) ?? []).toHaveLength(0);
    const team = page('支付组');
    expect(team).toContain(`- **在岗人数**: 7人 \`as of ${week(PAY_WEEKS - 1)}\``);
    expect(team).toContain(`  - history: 8人 (${week(7)})`);
    expect(team).toMatch(/- \*\*周活跃用户\*\*: 151万/);
    // the renamed project's page holds what was said under its old name
    const orion = page('orion');
    expect(orion).toMatch(/- \*\*进度\*\*: 72%/);
    expect(orion).toContain(`(${week(3, 2)})`);
    // the old name has no page of its own (one written before the merge would become a redirect)
    expect(fs.existsSync(path.join(dataDir, 'wiki', 'entities', 'atlas.md'))).toBe(false);
    if (process.env.SHOW_PAGES) for (const n of ['风控引擎', '支付组', 'orion', '陈伟', '陈伟平台组']) console.log(page(n));
    // the namesakes have a page each
    expect(page('陈伟平台组')).toContain('迁移历史数据');
    expect(page('陈伟')).not.toContain('迁移历史数据');
  });

  it('leaves one current value per attribute after each update pass, without a refine', async () => {
    // supersession ran in refine alone: on the 2026-11 separation benchmark a team's weekly metric had five
    // current values after four update batches. Extraction alone still leaves them so:
    const control = await build('update-control');
    opened.push(control.ctx);
    const currentOf = (ctx: AppContext, subject: string, attributes: string[]) => ctx.store.query<{ value_num: number }>(
      `SELECT c.value_num FROM claims c JOIN entities e ON e.id = c.subject_id
       WHERE e.name = $1 AND c.attribute = ANY($2::text[]) AND c.tx_to IS NULL AND c.canonical_id IS NULL AND c.superseded_by IS NULL
       ORDER BY c.value_num`,
      [subject, attributes],
    );
    expect((await currentOf(control.ctx, '风控引擎', ['完成度', '进度'])).length).toBeGreaterThan(5);

    // the corpus: eight weeks of the payments team; then four update batches, a week each
    const dataDir = path.join(tmp, 'update');
    initDataDir(dataDir);
    const docs = fixture();
    const file = (k: number) => `raw/docs/周报/支付组/${week(k)}.md`;
    const CORPUS_WEEKS = 8;
    for (let k = 0; k < CORPUS_WEEKS; k++) write(dataDir, file(k), docs.get(file(k))!.text);
    const ctx = await createContext(dataDir);
    opened.push(ctx);
    (ctx.config.extraction as { entityLlm?: unknown }).entityLlm = undefined;
    const judged = { calls: 0, pairs: 0 };
    (ctx as { llm: LlmClient }).llm = { ...stubExtractor(docs, { n: 0, chars: 0 }), complete: (countingJudge(judged) as unknown as { complete: unknown }).complete } as unknown as LlmClient;

    /** Sync, queue what is new, and run document passes until the queue is empty: what serve does after documents are added. */
    const ingest = async (): Promise<number> => {
      await sync(ctx, { llmGraph: false });
      for (const d of await ctx.store.query<{ id: string }>(`SELECT d.id FROM documents d WHERE d.root = 'docs' AND NOT EXISTS (SELECT 1 FROM claims c JOIN scopes s ON s.id = c.primary_scope_id WHERE s.key = d.path)`)) await enqueueTier1(ctx.store, d.id);
      let superseded = 0;
      for (let i = 0; i < 10; i++) {
        const pass = await runDocumentPass(ctx, { batchSize: 64 });
        superseded += pass.superseded;
        if (pass.touchedClaims.length > 0) lastWritten = pass.touchedClaims;
        if (pass.queued === 0) break;
      }
      return superseded;
    };
    /** The claims the last pass that wrote any wrote. */
    let lastWritten: string[] = [];

    expect(await ingest()).toBeGreaterThan(0);
    // 完成度 and 进度 are one key of the subject, unified by the pass: one current value, the newest week's
    expect(await currentOf(ctx, '风控引擎', ['完成度', '进度'])).toEqual([{ value_num: progressOf(CORPUS_WEEKS - 1) }]);
    expect(await currentOf(ctx, '支付组', ['周活跃用户', '周活跃用户数'])).toEqual([{ value_num: wauOf(CORPUS_WEEKS - 1) }]);
    expect(await currentOf(ctx, '支付组', ['在岗人数'])).toEqual([{ value_num: 8 }]);

    for (let k = CORPUS_WEEKS; k < PAY_WEEKS; k++) {
      write(dataDir, file(k), docs.get(file(k))!.text);
      expect(await ingest(), `update ${k}`).toBeGreaterThan(0);
      expect(await currentOf(ctx, '风控引擎', ['完成度', '进度']), `update ${k}`).toEqual([{ value_num: progressOf(k) }]);
      expect(await currentOf(ctx, '支付组', ['周活跃用户', '周活跃用户数']), `update ${k}`).toEqual([{ value_num: wauOf(k) }]);
      // back to 7 people from week 9 on: the value said again is the current one, 8 is history
      expect(await currentOf(ctx, '支付组', ['在岗人数']), `update ${k}`).toEqual([{ value_num: headcountOf(k) }]);
    }
    // the history is kept: every week's value, all but the newest marked
    const [series] = await ctx.store.query<{ n: number; superseded: number }>(
      `SELECT count(*)::int AS n, count(c.superseded_by)::int AS superseded FROM claims c JOIN entities e ON e.id = c.subject_id
       WHERE e.name = '风控引擎' AND c.attribute IS NOT NULL AND c.tx_to IS NULL AND c.canonical_id IS NULL`,
    );
    expect(series).toEqual({ n: PAY_WEEKS, superseded: PAY_WEEKS - 1 });
    // a subject the updates wrote nothing of keeps its marks: nothing is cleared elsewhere
    const [others] = await ctx.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM claims c JOIN entities e ON e.id = c.subject_id WHERE e.name = '陈伟' AND c.superseded_by IS NOT NULL`);
    expect(others.n).toBe(0);

    // run again for the claims the last update wrote, the step changes nothing: no mark, no key — twice over
    const state = () => ctx.store.query(
      `SELECT c.id, c.superseded_by, k.canonical FROM claims c LEFT JOIN claim_attribute_keys k ON k.subject_id = c.subject_id AND k.attribute = c.attribute
       WHERE c.tx_to IS NULL ORDER BY c.id`,
    );
    const settled = await state();
    expect(lastWritten.length).toBeGreaterThan(0);
    const again = await supersedeForClaims(ctx.store, lastWritten);
    expect(again.subjects).toBeGreaterThan(0);
    expect(again).toMatchObject({ keys: 0, superseded: 0 });
    expect(await supersedeForClaims(ctx.store, lastWritten)).toMatchObject({ keys: 0, superseded: 0 });
    expect(await state()).toEqual(settled);
    // and it left nothing for refine's run over every claim to change
    expect(await markSupersededClaims(ctx.store)).toBe(0);
    expect(await state()).toEqual(settled);
    // a pass with nothing in its queue writes no claim and does not run the step at all
    const idle = await runDocumentPass(ctx, { batchSize: 64 });
    expect(idle).toMatchObject({ touchedClaims: [], superseded: 0 });
  });
});
