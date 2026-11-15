import { describe, expect, it } from 'vitest';
import type { Judge } from '../src/eval/judge.js';
import { parseStructured, unclosedItems } from '../src/eval/prompts.js';
import { foldThousands, listParts, matchForm, scoreLists, splitListedItems } from '../src/eval/score/lists.js';
import { scoreUsage } from '../src/eval/score/usage.js';
import { namesValue, numbersIn, readValue } from '../src/eval/score/values.js';
import { emptyUsage, type AnswerRecord, type ScoreRecord, type Task } from '../src/eval/types.js';

/*
 * Format-tolerant scoring (docs/design/33 §5): answers the 10× run
 * (separation-2026-11/run-10x) scored below right for their form, not their
 * content. Each case is the recorded answer's text, cut to what matters.
 */

const answer = (taskId: string, text: string, extra: Partial<AnswerRecord> = {}): AnswerRecord => ({
  key: `${taskId}-${extra.system ?? 's'}`, pack: 'p', system: 's', taskId, text, finalAnswer: '', citations: [], retrieved: [], toolCalls: 0,
  usage: emptyUsage(), ms: 10, at: new Date().toISOString(), ...extra,
});
const noJudge = { gradeAnswers: async () => new Map(), matchList: async () => new Map(), matchItems: async () => new Map() } as unknown as Judge;
const metric = (rs: ScoreRecord[], taskId: string, m: string) => rs.find((r) => r.taskId === taskId && r.metric === m)?.value;
const listTask = (id: string, labels: string[], type: Task['type'] = 'connection'): Task => ({
  id, suite: 'usage', type, question: '?', scoring: 'set', evidence: [],
  items: labels.map((label) => ({ label, aliases: [], weight: 1 })),
  list: { match: 'alias', ordered: false, maxItems: 10, requireDocs: false, primary: 'f1' },
});

describe('format-tolerant scoring: an unclosed JSON list', () => {
  // d10-x-cause-INC-005-D10T1, agent-grep: both incidents right, the object's closing brace missing
  const text = `- **INC-012-D10T2**（十部支付组）——根因是"旧表字段格式不一"。
- **INC-019-D10T3**（十部增长组）——根因是"脏记录混入"。

{"items":[{"label":"INC-012-D10T2","confidence":0.94,"evidence":["周报/十部平台组/8ee814da99.md","周报/十部支付组/734ed3f79c.md"]},{"label":"INC-019-D10T3","confidence":0.94,"evidence":["周报/十部平台组/8ee814da99.md","周报/十部增长组/eaad15bacb.md"]}`;

  it('reads the items it did write', () => {
    expect(parseStructured(text).items.map((i) => i.label)).toEqual(['INC-012-D10T2', 'INC-019-D10T3']);
    // cut inside the second item: the first still counts
    expect(unclosedItems('{"items":[{"label":"A","evidence":[]},{"label":"B","evid')?.items).toEqual([{ label: 'A', evidence: [] }]);
    // the array closed, the object not
    expect(unclosedItems('{"items":[{"label":"A"}]')?.items).toEqual([{ label: 'A' }]);
    expect(unclosedItems('{"items":[')?.items).toEqual([]);
    // a balanced object is not this function's: jsonObjects reads it
    expect(unclosedItems('{"items":[{"label":"A"}]}')).toBeNull();
    expect(unclosedItems('no json here')).toBeNull();
  });

  it('scores the task as right without a model', async () => {
    const rs = await scoreLists({ answers: [answer('cause', text)], tasks: new Map([['p|cause', listTask('cause', ['INC-012-D10T2', 'INC-019-D10T3'])]]), corpusDocs: new Map() }, noJudge);
    expect(metric(rs, 'cause', 'correctness')).toBe(1);
  });

  it('keeps a label task\'s label where the reply also lists items', () => {
    const p = parseStructured('{"items":[{"label":"x"}]}\n{"label":"支付组","confidence":0.8}');
    expect(p.label).toBe('支付组');
    expect(p.items.map((i) => i.label)).toEqual(['x']);
  });
});

describe('format-tolerant scoring: numbers', () => {
  const value = (id: string, gold: string, meta: Record<string, unknown> = {}): Task => ({ id, suite: 'usage', type: 'structured', question: '?', scoring: 'value', answer: gold, evidence: [], meta });

  it('reads a thousands separator: "1,000 milliseconds" names 1000 (d10-st-D10T1-C3-now-xl)', async () => {
    const t: Task = { ...value('ms', '1000', { stale: ['800', '1200'] }), answers: ['1000毫秒'] };
    expect(readValue(t, 'Final answer: 1,000 milliseconds (1 second).').gold).toBe(true);
    // and a stale value written the same way is read as stale
    expect(readValue(t, 'Final answer: 1,200 milliseconds.')).toMatchObject({ gold: false, stale: true });
    const rs = await scoreUsage({ answers: [answer('ms', 'Final answer: 1,000 milliseconds (1 second).')], tasks: new Map([['p|ms', t]]), citing: new Set() }, noJudge);
    expect(metric(rs, 'ms', 'correctness')).toBe(1);
  });

  it('folds only well-formed groups', () => {
    expect(foldThousands('1,347,307.69人')).toBe('1347307.69人');
    expect(foldThousands('第1,2周')).toBe('第1,2周');
    expect(foldThousands('3,4567')).toBe('3,4567');
    expect(matchForm('1,000 ms')).toBe(matchForm('1000ms'));
    expect(numbersIn('134.7万人，共 1,347,308 人')).toEqual([{ value: 134.7, scaled: 1_347_000 }, { value: 1_347_308, scaled: 1_347_308 }]);
  });

  it('reads a figure given at full size against a gold in 万, within the pack\'s tolerance (d9-sq-h1avg-D9T3)', async () => {
    const t = value('avg', '135', { tolerance: 1.01 });
    const recorded = '各月周活跃用户数汇总如下，单位为万人。\n\n周均值＝3503 × 10000 ÷ 26＝1,347,307.69人，四舍五入保留0位小数为 **1,347,308人**。\n\nFinal answer: 九部增长组上半年周活跃用户的周均值为1,347,308人。';
    expect(readValue(t, recorded).gold).toBe(true);
    const rs = await scoreUsage({ answers: [answer('avg', recorded)], tasks: new Map([['p|avg', t]]), citing: new Set() }, noJudge);
    expect(metric(rs, 'avg', 'correctness')).toBe(1);
    // the same figure in 万, and the gold at full size against an answer in 万
    expect(readValue(t, 'Final answer: 134.7万人').gold).toBe(true);
    expect(readValue(value('abs', '1350000', { tolerance: 10_100 }), 'Final answer: 135万人').gold).toBe(true);
    // converted, it is held to the same tolerance: 133.0万 is two away from 135
    expect(readValue(t, '单位为万人。Final answer: 1,330,000人').gold).toBe(false);
    // an answer that never works in 万 is not converted
    expect(readValue(t, 'Final answer: 1,347,308人').gold).toBe(false);
    // a gold small against its tolerance is never compared with a converted number
    expect(namesValue('52,000人', ['5'], 1.01, [1e4])).toBe(false);
    // no tolerance, no conversion
    expect(namesValue('1,347,308人', ['135'], undefined, [1e4])).toBe(false);
  });
});

describe('format-tolerant scoring: two items in one entry', () => {
  const twins = listTask('twins', ['九部平台组', '九部支付组'], 'ambiguous');
  const json = (labels: string[]) => `{"items":[${labels.map((l) => JSON.stringify({ label: l, confidence: 0.99, evidence: [] })).join(',')}]}`;
  const score = async (labels: string[]) => metric(await scoreLists({ answers: [answer('twins', json(labels))], tasks: new Map([['p|twins', twins]]), corpusDocs: new Map() }, noJudge), 'twins', 'correctness');

  it('splits a label at its top-level separators', () => {
    expect(listParts('九部平台组、九部支付组（归属不唯一）')).toEqual(['九部平台组', '九部支付组(归属不唯一)']);
    expect(listParts('五部平台组／五部支付组（归属有歧义）')).toEqual(['五部平台组', '五部支付组(归属有歧义)']);
    expect(listParts('A（甲、乙）')).toEqual(['A(甲、乙)']);
    expect(listParts('1,000 and 2,000')).toEqual(['1000', '2000']);
  });

  it('counts an entry naming both gold items for both (d9-a-twins and its twelve siblings)', async () => {
    expect(await score(['九部平台组、九部支付组（归属不唯一）'])).toBe(1);
    expect(await score(['五部平台组／五部支付组（归属有歧义）'.replace(/五/g, '九')])).toBe(1);
    // a wrong part still costs precision, as a separate wrong entry would: P 2/3, R 1
    expect(await score(['九部平台组、九部支付组、九部增长组'])).toBeCloseTo(0.8, 6);
    // one phrase that mentions both is one claim, matched once
    expect(await score(['九部平台组调往九部支付组'])).toBeCloseTo(2 / 3, 6);
    // parts that name at most one gold item: the entry keeps its form
    expect(splitListedItems([{ label: '九部平台组、负责人陈晨' }], twins.items!)).toEqual([{ label: '九部平台组、负责人陈晨' }]);
  });
});
