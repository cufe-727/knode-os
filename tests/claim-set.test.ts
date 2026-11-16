import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { entityKeyKinds } from '../src/graph/normalize.js';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import type { ChatMessage, LlmClient } from '../src/llm/client.js';
import { ask } from '../src/search/ask.js';
import { asOfDate, computeClaimSet, readSetQuestion } from '../src/search/claimset.js';
import { classifyQuestion } from '../src/search/route.js';
import { Store } from '../src/store/db.js';

/**
 * docs/design/34 §1: a set, a count or a value as of a date computed from the
 * claims of the scope a question names — every matching claim, not the ones a
 * search reached — and handed to the answering model with its sources.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-claim-set-'));
let store: Store;

class FixtureEmbedder implements EmbeddingProvider {
  readonly model = 'fixture-v1';
  readonly dimensions = 4;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0, 0, 0]);
  }
}

async function addEntity(id: string, name: string, type: string): Promise<void> {
  await store.query(`INSERT INTO entities (id, name, type, mention_count, aliases, description) VALUES ($1, $2, $3, 5, '[]'::jsonb, '')`, [id, name, type]);
  for (const key of entityKeyKinds(name).keys()) {
    await store.query(`INSERT INTO entity_alias_keys (entity_id, alias_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, key]);
  }
}

/** A weekly report: a document, its chunk and the tier-1 scope its claims' evidence is in. */
async function addReport(id: string, title: string, date: string | null): Promise<void> {
  const p = `raw/docs/${id}.md`;
  await store.query(`INSERT INTO documents (id, path, root, title, sha256, bytes, status, doc_date) VALUES ($1, $2, 'docs', $3, $4, 10, 'indexed', $5)`, [id, p, title, `sha-${id}`, date]);
  await store.query(`INSERT INTO chunks (id, document_id, seq, content, token_count, tsv) VALUES ($1, $2, 0, $3, 3, to_tsvector('simple', $3))`, [`c-${id}`, id, title]);
  await store.query(`INSERT INTO scopes (id, kind, key, sha, status, applied_at) VALUES ($1, 'tier1', $2, $3, 'active', now())`, [`s-${id}`, p, `sha-${id}`]);
}

let claimNo = 0;
async function addClaim(doc: string, subject: string, statement: string, extra: {
  object?: string; attribute?: string; num?: number; text?: string; unit?: string; at?: string | null; correction?: boolean;
} = {}): Promise<void> {
  const id = `cl-${++claimNo}`;
  await store.query(
    `INSERT INTO claims (id, subject_id, object_id, type, statement, status, kind, chunk_id, primary_scope_id, evidence_count, tx_from,
                         attribute, value_num, value_text, unit, effective_at, correction)
     VALUES ($1, $2, $3, 'other', $4, 'fact', 'fact', $5, $6, 1, now(), $7, $8, $9, $10, $11, $12)`,
    [id, subject, extra.object ?? null, statement, `c-${doc}`, `s-${doc}`, extra.attribute ?? null, extra.num ?? null, extra.text ?? null, extra.unit ?? null,
      extra.at === undefined ? null : extra.at, extra.correction ?? false],
  );
  await store.query(`INSERT INTO evidence (kind, target_id, scope_id, weight, extractor, tx_from) VALUES ('claim', $1, $2, 1, 'fixture', now())`, [id, `s-${doc}`]);
}

const monday = (week: number) => new Date(Date.UTC(2025, 0, 6 + 7 * (week - 1))).toISOString().slice(0, 10);
/** A day as the writer stores it: its UTC midnight. */
const at = (week: number) => `${monday(week)}T00:00:00Z`;

/** Platform's weekly availability: weeks 1–6 in Q1, 14–15 in Q2. */
const AVAILABILITY: [number, number][] = [[1, 99.9], [2, 99.95], [3, 99.8], [4, 99.97], [5, 99.92], [6, 99.93], [14, 99.99], [15, 99.96]];

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, '.knode'), { recursive: true });
  store = await Store.open(tmp, 4);
  await store.indexing;
  await addEntity('northwind', 'Northwind', 'organization');
  await addEntity('platform', 'Northwind Platform', 'organization'); // a part of Northwind by a relation, not by its name
  await addEntity('payments', 'Payments Team', 'organization'); // a part of Northwind by a relation
  await addEntity('southwind', 'Southwind', 'organization');
  await addEntity('alice', 'Alice Chen', 'person');
  await addEntity('bob', 'Bob Li', 'person');
  for (const inc of ['INC-1', 'INC-2', 'INC-3', 'INC-7', 'INC-8', 'INC-9']) await addEntity(inc.toLowerCase(), inc, 'event');
  await addEntity('pool-1', 'POOL-1', 'component');
  await store.query(`INSERT INTO relations (id, source_id, target_id, type, description, weight) VALUES ('r-pay', 'payments', 'northwind', 'part_of', 'Payments Team is part of Northwind', 1)`);
  await store.query(`INSERT INTO relations (id, source_id, target_id, type, description, weight) VALUES ('r-plat', 'platform', 'northwind', 'part_of', 'Northwind Platform is part of Northwind', 1)`);

  for (const [week, value] of AVAILABILITY) {
    const doc = `plat-w${week}`;
    await addReport(doc, `Platform weekly · week ${week}`, at(week));
    await addClaim(doc, 'platform', `Northwind Platform availability this week was ${value}%`, { attribute: 'availability', num: value, unit: '%', at: at(week) });
  }
  for (const week of [2, 4]) {
    await addReport(`pay-w${week}`, `Payments weekly · week ${week}`, at(week));
    await addClaim(`pay-w${week}`, 'payments', `Payments Team availability this week was 99.9%`, { attribute: 'availability', num: 99.9, unit: '%', at: at(week) });
  }
  await addReport('south-w2', 'Southwind weekly · week 2', at(2));
  await addClaim('south-w2', 'southwind', 'Southwind availability this week was 99.5%', { attribute: 'availability', num: 99.5, unit: '%', at: at(2) });

  const incident = async (doc: string, inc: string, severity: string, week: number, fixer?: string) => {
    await addClaim(doc, inc.toLowerCase(), `Incident ${inc} had severity ${severity}`, { attribute: 'severity', text: severity, at: at(week) });
    if (fixer) await addClaim(doc, inc.toLowerCase(), `Incident ${inc} was fixed by ${fixer === 'alice' ? 'Alice Chen' : 'Bob Li'}`, { object: fixer, attribute: 'fixer', text: fixer, at: at(week) });
  };
  await incident('plat-w1', 'INC-1', 'P1', 1, 'alice');
  await incident('plat-w3', 'INC-2', 'P2', 3, 'bob');
  await incident('plat-w14', 'INC-3', 'P1', 14);
  await incident('pay-w2', 'INC-7', 'P1', 2, 'alice');
  await incident('pay-w4', 'INC-8', 'P2', 4);
  await incident('south-w2', 'INC-9', 'P1', 2, 'bob');

  // a setting: set, corrected, and recalled later as it first was
  await addClaim('plat-w1', 'pool-1', 'Order DB pool limit POOL-1 set to 200 connections', { attribute: 'limit', num: 200, unit: 'connections', at: at(1) });
  await addClaim('plat-w3', 'pool-1', 'POOL-1: the 200 is withdrawn, 240 connections stands', { attribute: 'connections', num: 240, unit: 'connections', at: at(3), correction: true });
  await addClaim('plat-w6', 'pool-1', 'The Order DB pool limit was originally 200 connections', { attribute: 'initial limit', num: 200, unit: 'connections', at: at(6) });
  // and later put back, by the short name the first report gave it, in a claim about the team
  await store.query(`UPDATE entities SET aliases = '["pool cap"]'::jsonb WHERE id = 'pool-1'`);
  await addClaim('plat-w15', 'platform', 'Northwind Platform changed the pool cap back to the original 200 connections', { attribute: 'pool cap', num: 200, unit: 'connections', at: at(15) });
});

afterAll(async () => {
  await store?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Asked at the end of the fixture's year: its yearless periods are 2025's. */
const set = (q: string, named: string[]) => computeClaimSet(store, q, classifyQuestion(q), named, { now: '2025-12-31' });

describe('reading what a question asks of the claims', () => {
  it('reads the operation, the grouping, the filters and the period by rules', () => {
    const r = (q: string) => readSetQuestion(q, classifyQuestion(q), '2025-12-31');
    expect(r('（第一事业部）按组和季度统计：第一事业部的三个组在每个季度各报告了几起事故（截至第44周）？')).toMatchObject({ op: 'count', groupBy: ['member', 'quarter'], asks: 'event', throughWeek: 44 });
    expect(r('平台组的服务可用性在哪些周低于99.917%（截至第44周）？')).toMatchObject({ op: 'list', threshold: { cmp: '<', value: 99.917 } });
    expect(r('平台组的服务可用性每个季度的最高周值分别是多少？')).toMatchObject({ op: 'max', groupBy: ['quarter'] });
    expect(r('平台组上半年服务可用性的周均值是多少？保留3位小数。')).toMatchObject({ op: 'mean', period: { from: '2025-01-01', to: '2025-06-30' } });
    expect(r('修复过两起及以上事故的有哪些人？')).toMatchObject({ atLeast: 2, asks: 'person' });
    expect(r('截至2025年11月7日，平台组的订单库连接池上限是多少？')).toMatchObject({ op: 'value', asOf: '2025-11-07' });
    expect(r('每个事业部第二季度各报告了几起事故？')).toMatchObject({ op: 'count', groupBy: ['parent'], company: true, period: { from: '2025-04-01', to: '2025-06-30' } });
    expect(r('截至第44周，还有哪些风险没有关闭？')).toMatchObject({ op: 'list', notIn: '关闭' });
    expect(r('Which people fixed at least two incidents?')).toMatchObject({ op: 'list', atLeast: 2, asks: 'person' });
    expect(r('What is Northwind?')).toBeNull();
  });

  it('routes a question for the first and the last of something to the timeline', () => {
    expect(classifyQuestion('（第一事业部）风险R-01是哪一周、由谁最早提出的？最后是在哪一周、怎么关闭的？').kind).toBe('timeline');
    expect(classifyQuestion('When was risk R-01 first raised, and when was it finally closed?').kind).toBe('timeline');
    expect(classifyQuestion('谁最早提出了R-01？').kind).not.toBe('timeline');
  });

  it('reads the day a value is asked as of', () => {
    expect(asOfDate('2025年5月21日那天，平台组的日志保留天数是多少？')).toBe('2025-05-21');
    expect(asOfDate('What was the pool limit as of 2025-03-01?')).toBe('2025-03-01');
    expect(asOfDate('What was it on March 3, 2025?')).toBe('2025-03-03');
    // a day in a question about something else is no as-of date
    expect(asOfDate('2025年5月21日发布了什么？')).toBeUndefined();
  });
});

describe('computing the set from the claims', () => {
  it('counts the items of a team, not the claims about them', async () => {
    const s = await set('How many incidents did Northwind Platform report?', ['platform']);
    expect(s).toMatchObject({ op: 'count', answer: 3, scope: 'Northwind Platform' });
    expect(s!.lines.join('\n')).toMatch(/INC-1[\s\S]*INC-2[\s\S]*INC-3/);
  });

  it('lists a division\'s items of a value it names, its teams by relation, no other division', async () => {
    const s = await set('Which P1 incidents did Northwind have?', ['northwind']);
    const listed = s!.lines.filter((l) => l.startsWith('- ')).map((l) => /INC-\d+/.exec(l)![0]);
    expect(listed.sort()).toEqual(['INC-1', 'INC-3', 'INC-7']);
    expect(s!.scope).toBe('Northwind (with 2 member organisations)');
    // each row with its source and that source's title
    expect(s!.rows.find((r) => r.statement.includes('INC-7'))).toMatchObject({ sources: ['raw/docs/pay-w2.md'], title: 'Payments weekly · week 2' });
  });

  it('groups by member organisation and by quarter', async () => {
    const s = await set('How many incidents did each team of Northwind report per quarter?', ['northwind']);
    expect(s!.question.groupBy).toEqual(['member', 'quarter']);
    expect(s!.lines).toEqual(expect.arrayContaining(['Northwind Platform · Q1: 2', 'Northwind Platform · Q2: 1', 'Payments Team · Q1: 2']));
  });

  it('filters readings by a threshold, one reading a week', async () => {
    const s = await set('In which weeks was the availability of Northwind Platform below 99.92?', ['platform']);
    const weeks = s!.lines.filter((l) => l.startsWith('- '));
    expect(weeks).toEqual([`- ${monday(1)} 《Platform weekly · week 1》: 99.9%`, `- ${monday(3)} 《Platform weekly · week 3》: 99.8%`]);
  });

  it('takes the highest reading per quarter and the mean over a yearless half', async () => {
    const max = await set('What was the highest weekly availability of Northwind Platform per quarter?', ['platform']);
    expect(max!.lines).toEqual([
      `Q1: max availability = 99.97% — ${monday(4)} 《Platform weekly · week 4》 (of 6 readings)`,
      `Q2: max availability = 99.99% — ${monday(14)} 《Platform weekly · week 14》 (of 2 readings)`,
    ]);
    const mean = await set('What was the average availability of Northwind Platform in the first half?', ['platform']);
    const expected = AVAILABILITY.reduce((s, [, v]) => s + v, 0) / AVAILABILITY.length;
    expect(Number(mean!.answer)).toBeCloseTo(expected, 6);
  });

  it('cuts a period at the week the reports number as theirs', async () => {
    const s = await set('How many incidents did Northwind Platform report up to week 6?', ['platform']);
    expect(s!.answer).toBe(2);
  });

  it('gives a value as of a day: a correction over what it corrects, a later recollection of the first value not', async () => {
    const now = await set('What was the Order DB pool limit of Northwind Platform as of 2025-03-01?', ['platform']);
    expect(now).toMatchObject({ op: 'value', answer: '240' });
    expect(now!.lines[0]).toContain('a correction');
    const then = await set('What was the Order DB pool limit of Northwind Platform as of 2025-01-10?', ['platform']);
    expect(then!.answer).toBe('200');
    // a revert named by the setting's short name, in a claim about the team, is the value after it
    const later = await set('What was the Order DB pool limit of Northwind Platform as of 2025-05-01?', ['platform']);
    expect(later!.answer).toBe('200');
    expect(later!.lines[0]).toContain('changed the pool cap back to the original 200');
  });

  it('counts what an item of the kind asked for is related to, and keeps the ones related to enough', async () => {
    const s = await set('Which people in Northwind fixed at least two incidents?', ['northwind']);
    const people = s!.lines.filter((l) => l.startsWith('- '));
    expect(people).toHaveLength(1);
    expect(people[0]).toMatch(/^- Alice Chen \(2: INC-1, INC-7\)/);
  });

  it('counts over the whole knowledge base when the question says so, by an attribute it names', async () => {
    const s = await set('How many incidents of severity P1 were there company-wide?', []);
    expect(s).toMatchObject({ scope: 'the whole knowledge base', answer: 4 });
    expect(await set('How many incidents of severity P1 were there?', [])).toBeNull();
    // naming no attribute, a company-wide question is not read off every statement
    expect(await set('How many P1 incidents were there company-wide?', [])).toBeNull();
  });
});

describe('ask with a computed set', () => {
  const config = defaultConfig();
  const embedder = new FixtureEmbedder();

  function recordingLlm(): { llm: LlmClient; prompts: string[] } {
    const prompts: string[] = [];
    const llm = {
      enabled: true,
      complete: async (messages: ChatMessage[]) => {
        prompts.push(messages.map((m) => m.content).join('\n'));
        return 'Three.\n{"citations":[],"gaps":[]}';
      },
      completeJson: async () => {
        throw new Error('no JSON call expected');
      },
    } as unknown as LlmClient;
    return { llm, prompts };
  }

  it('hands the model the computed lines and every row as a fact with its source, in one completion', async () => {
    const { llm, prompts } = recordingLlm();
    const res = await ask(store, config, embedder, llm, 'How many incidents did Northwind Platform report?', { computed: true });
    expect(prompts).toHaveLength(1);
    expect(res.route.computed).toMatchObject({ op: 'count', scope: 'Northwind Platform', items: 3 });
    expect(prompts[0]).toContain('# Computed from the claims\nScope: Northwind Platform.');
    expect(prompts[0]).toContain('3 distinct event matching');
    expect(prompts[0]).toMatch(/\[fact; set\] Incident INC-2 had severity P2 \(\d{4}-\d\d-\d\d\) — raw\/docs\/plat-w3\.md/);
    expect(prompts[0]).toContain('The "Computed from the claims" section was computed in code');
    expect(res.computed?.answer).toBe(3);
  });

  it('computes nothing for a question that asks for no set', async () => {
    const { llm, prompts } = recordingLlm();
    const res = await ask(store, config, embedder, llm, 'What is Northwind Platform?', { computed: true });
    expect(res.computed).toBeUndefined();
    expect(res.route.computed).toBeUndefined();
    expect(prompts[0]).not.toContain('# Computed from the claims');
  });
});
