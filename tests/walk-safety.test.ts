import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { entityKeyKinds } from '../src/graph/normalize.js';
import type { EmbeddingProvider } from '../src/ingest/embeddings.js';
import type { LlmClient } from '../src/llm/client.js';
import { ask } from '../src/search/ask.js';
import { stepsAsFacts, walkRelations, walkTerms } from '../src/search/walk.js';
import { ordinalInQuestion } from '../src/search/walk-order.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../src/store/db.js';

/**
 * The relation walk is safe on questions it cannot help, on a store it cannot
 * embed for, on hubs, and when it orders (docs/design/30 §3, §3.1): the
 * review of the walk as merged in main 7a299bf.
 */

const MODEL = 'fixture-safety-v1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-walk-safety-'));
let store: Store;
let n = 0;
const noLlm = { enabled: false } as unknown as LlmClient;
const config = defaultConfig();

async function entity(id: string, name: string, type = 'organization', vector?: number[]): Promise<void> {
  await store.query(`INSERT INTO entities (id, name, type, mention_count, aliases, description) VALUES ($1, $2, $3, 5, '[]'::jsonb, '')`, [id, name, type]);
  for (const key of entityKeyKinds(name).keys()) await store.query(`INSERT INTO entity_alias_keys (entity_id, alias_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, key]);
  if (vector) await store.query(`INSERT INTO entity_embeddings (entity_id, fold_sha, model, embedding) VALUES ($1, '', $2, $3::${VECTOR_TYPE})`, [id, MODEL, toVectorLiteral(vector)]);
}

/** A dated document of one chunk mentioning `mentions`, with claims [subject, statement, date, type?]. Returns its document and chunk ids. */
async function doc(content: string, mentions: string[], date: string | null = null, claims: [string, string, string | null, string?][] = []): Promise<{ doc: string; chunk: string }> {
  const id = `o${++n}`;
  await store.query(`INSERT INTO documents (id, path, root, title, sha256, bytes, status, doc_date) VALUES ($1, $2, 'docs', $1, $1, 10, 'indexed', $3)`, [`d-${id}`, `raw/docs/${id}.md`, date]);
  await store.query(`INSERT INTO chunks (id, document_id, seq, content, token_count, tsv) VALUES ($1, $2, 0, $3, 3, to_tsvector('simple', $3))`, [`c-${id}`, `d-${id}`, content]);
  await store.query(`INSERT INTO embeddings (chunk_id, model, embedding) VALUES ($1, $2, $3::${VECTOR_TYPE})`, [`c-${id}`, MODEL, toVectorLiteral([1, 0, 0, 0])]);
  await store.query(`INSERT INTO scopes (id, kind, key, sha, status, applied_at) VALUES ($1, 'doc', $2, $1, 'active', now())`, [`s-${id}`, `raw/docs/${id}.md`]);
  for (const e of mentions) await store.query(`INSERT INTO entity_mentions (entity_id, chunk_id, document_id, scope_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [e, `c-${id}`, `d-${id}`, `s-${id}`]);
  for (const [subject, statement, d, type] of claims) {
    await store.query(
      `INSERT INTO claims (id, subject_id, type, statement, status, kind, event_at, chunk_id, primary_scope_id, evidence_count, tx_from) VALUES ($1, $2, $3, $4, 'fact', 'fact', $5, $6, $7, 1, now())`,
      [`cl-${id}-${subject}`, subject, type ?? 'event', statement, d ? `${d}T00:00:00Z` : null, `c-${id}`, `s-${id}`],
    );
  }
  return { doc: `d-${id}`, chunk: `c-${id}` };
}

async function relate(source: string, target: string, description: string, at: { doc: string; chunk: string }, weight = 1, type = 'related_to', validFrom: string | null = null): Promise<void> {
  await store.query(
    `INSERT INTO relations (id, source_id, target_id, type, description, weight, document_id, chunk_id, valid_from) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`r${++n}`, source, target, type, description, weight, at.doc, at.chunk, validFrom ? `${validFrom}T00:00:00Z` : null],
  );
}

class DownEmbedder implements EmbeddingProvider {
  readonly model = MODEL;
  readonly dimensions = 4;
  calls = 0;
  async embed(): Promise<number[][]> {
    this.calls++;
    throw new Error('embedder unavailable');
  }
}

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, '.knode'), { recursive: true });
  store = await Store.open(tmp, 4);
  await store.indexing;
  // a group, two incidents and who fixed them
  await entity('plat', '二部平台组');
  await entity('qian', '钱勇', 'person');
  for (const [id, name, date] of [['i1', 'INC-001-D2T1', '2026-02-03'], ['i2', 'INC-002-D2T1', '2026-04-28']] as const) {
    await entity(id, name, 'event');
    const at = await doc(`${name}是二部平台组报告的事故。`, [id, 'plat'], date, [[id, `${name}发生`, date]]);
    await relate(id, 'plat', `${name}是二部平台组报告的事故。`, at);
    await relate('qian', id, `钱勇修复了${name}。`, await doc(`钱勇修复了${name}。`, ['qian', id], date));
  }
  // a company with heavy competitor relations and five yearly values: a question the walk cannot help
  await entity('catl', '宁德时代');
  for (let i = 0; i < 8; i++) {
    await entity(`peer${i}`, `电池同行${i}号`);
    await relate('catl', `peer${i}`, `宁德时代与电池同行${i}号存在竞争。`, await doc(`宁德时代与电池同行${i}号竞争`, ['catl', `peer${i}`], '2019-01-01'), 9, 'competes_with');
  }
  for (let y = 2021; y <= 2025; y++) {
    await doc(`宁德时代${y}年人均产值为${300 + y - 2021}万元。`, ['catl'], `${y + 1}-03-01`, [['catl', `宁德时代${y}年人均产值为${300 + y - 2021}万元`, `${y}-12-31`, 'metric']]);
  }
  // a group with 200 incidents: the 150 heaviest relations are of March, the year's first incidents (light) of January
  await entity('risk', '风控平台组');
  await store.query(`INSERT INTO entities (id, name, type, mention_count, aliases, description)
    SELECT 'ev' || i, 'EVT-' || lpad(i::text, 3, '0'), 'event', 1, '[]'::jsonb, '' FROM generate_series(0, 199) i`);
  await store.query(`INSERT INTO documents (id, path, root, title, sha256, bytes, status, doc_date)
    SELECT 'dev' || i, 'raw/docs/ev' || i || '.md', 'docs', 'ev' || i, 'shaev' || i, 10, 'indexed',
      CASE WHEN i >= 150 THEN timestamptz '2026-01-01T00:00:00Z' + (i - 150) * interval '1 day' ELSE timestamptz '2026-03-01T00:00:00Z' + i * interval '1 hour' END
    FROM generate_series(0, 199) i`);
  await store.query(`INSERT INTO chunks (id, document_id, seq, content, token_count) SELECT 'cev' || i, 'dev' || i, 0, 'EVT-' || i || ' 事故', 3 FROM generate_series(0, 199) i`);
  await store.query(`INSERT INTO claims (id, subject_id, type, statement, status, kind, event_at, chunk_id, evidence_count, tx_from)
    SELECT 'clev' || i, 'ev' || i, 'event', 'EVT-' || lpad(i::text, 3, '0') || '事故发生', 'fact', 'fact', d.doc_date, 'cev' || i, 1, now()
    FROM generate_series(0, 199) i JOIN documents d ON d.id = 'dev' || i`);
  await store.query(`INSERT INTO relations (id, source_id, target_id, type, description, weight, document_id, chunk_id)
    SELECT 'rev' || i, 'ev' || i, 'risk', 'related_to', 'EVT-' || lpad(i::text, 3, '0') || '是风控平台组报告的事故。', CASE WHEN i >= 150 THEN 1 ELSE 5 END, 'dev' || i, 'cev' || i
    FROM generate_series(0, 199) i`);
  // a group whose two incidents are of last year, in a knowledge base that states this year's dates
  await entity('clear', '清算组');
  for (const [id, date] of [['olda', '2025-02-03'], ['oldb', '2025-06-09']] as const) {
    await entity(id, `INC-OLD-${id}`, 'event');
    await relate(id, 'clear', `INC-OLD-${id}是清算组报告的事故。`, await doc(`INC-OLD-${id}事故`, [id, 'clear'], date, [[id, `INC-OLD-${id}事故发生`, date]]));
  }
  // a product first released in 2019 and released again in 2026, and one released once in 2024
  await entity('sail', '远航科技');
  await entity('pold', '旗舰一号', 'product');
  await entity('pnew', '新品二号', 'product');
  await relate('sail', 'pold', '远航科技发布旗舰一号。', await doc('远航科技发布旗舰一号', ['sail', 'pold'], '2019-05-01', [['pold', '旗舰一号发布', '2019-05-01']]), 3);
  await doc('旗舰一号 2026 款发布', ['sail', 'pold'], '2026-09-01', [['pold', '旗舰一号2026款于9月发布', '2026-09-01']]);
  await doc('旗舰一号参加展会', ['pold'], '2020-01-01', [['pold', '旗舰一号参加展会', '2020-01-01']]);
  await relate('sail', 'pnew', '远航科技发布新品二号。', await doc('远航科技发布新品二号', ['sail', 'pnew'], '2024-03-01', [['pnew', '新品二号发布', '2024-03-01']]), 3);
  // two entities mentioned together in an old note, and a relation between them read from a report years later
  await entity('ann', '安娜', 'person');
  await entity('orbit', '轨道计划', 'project');
  await doc('2019年的会议纪要：安娜与轨道计划都被提到。', ['ann', 'orbit'], '2019-03-01');
  await relate('ann', 'orbit', '安娜负责轨道计划。', await doc('2024年第12周：安娜开始负责轨道计划。', ['ann', 'orbit'], '2024-03-18'));
  // a hub mentioned with one of its neighbours in 600 chunks
  await entity('hub', '中枢平台');
  await entity('spoke', '辐条服务', 'product');
  await store.query(`INSERT INTO documents (id, path, root, title, sha256, bytes, status, doc_date)
    SELECT 'dh' || i, 'raw/docs/hub' || i || '.md', 'docs', 'hub' || i, 'shahub' || i, 10, 'indexed', timestamptz '2025-01-01T00:00:00Z' + i * interval '1 day' FROM generate_series(0, 599) i`);
  await store.query(`INSERT INTO chunks (id, document_id, seq, content, token_count) SELECT 'ch' || i, 'dh' || i, 0, '中枢平台调用辐条服务', 3 FROM generate_series(0, 599) i`);
  await store.query(`INSERT INTO entity_mentions (entity_id, chunk_id, document_id) SELECT e, 'ch' || i, 'dh' || i FROM generate_series(0, 599) i, unnest(ARRAY['hub', 'spoke']) e`);
  await relate('hub', 'spoke', '中枢平台依赖辐条服务。', { doc: 'dh599', chunk: 'ch599' });
  // a holding with 150 product relations, one of whose products lies near the question's vector, and one relation
  // whose description holds a term of the question; and a pair of teams neither near the question
  await entity('hold', '星河控股');
  for (let i = 0; i < 150; i++) {
    const v = i === 0 ? [0.99, 0.14, 0, 0] : [0.2 + (i % 7) * 0.02, 0.98, 0, 0];
    await entity(`prod${i}`, `星河产品${i}号`, 'product', v);
    await relate('hold', `prod${i}`, `星河控股旗下产品${i}号。`, await doc(`星河产品${i}号`, ['hold', `prod${i}`]), 5, 'produces');
  }
  await entity('auditor', '审计署', 'organization');
  await relate('hold', 'auditor', '审计署对星河控股开展了专项审计。', await doc('专项审计', ['hold', 'auditor']), 1);
  await entity('duo', '双子事业部');
  for (const [id, v] of [['tw1', [0, 0, 1, 0]], ['tw2', [0, 0, 0.995, 0.1]]] as const) {
    await entity(id, `双子${id}组`, 'organization', [...v]);
    await relate(id, 'duo', '该组隶属于双子事业部。', await doc('组织架构', [id, 'duo']), 10, 'part_of');
  }
});

afterAll(async () => {
  await store?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a multi-hop answer without the embedder', () => {
  it('falls back to the keyword and graph channels, as the lookup route does', async () => {
    const down = new DownEmbedder();
    for (const mode of [undefined, 'keyword'] as const) {
      const res = await ask(store, config, down, noLlm, '二部平台组的事故是谁修复的？他还修复过哪些事故', mode ? { mode } : {});
      expect(res.route.kind).toBe('multihop');
      expect(res.contexts.length).toBeGreaterThan(0);
      expect(res.facts.some((f) => f.statement.includes('钱勇'))).toBe(true);
    }
  });
});

describe('a question the walk cannot help', () => {
  it('adds no relation that matches nothing, and keeps what the ordinary route would have found', async () => {
    const embedder = { model: MODEL, dimensions: 4, embed: async (t: string[]) => t.map(() => [1, 0, 0, 0]) } as EmbeddingProvider;
    const q = '宁德时代的人均产值是多少，它在行业里排第几';
    const chained = await ask(store, config, embedder, noLlm, q, { route: 'multihop' });
    const lookup = await ask(store, config, embedder, noLlm, q, { route: 'lookup' });
    expect(chained.route.walked).toMatchObject({ relations: 0 });
    expect(chained.facts.filter((f) => f.statement.includes('competes with'))).toEqual([]);
    const have = new Set(chained.facts.map((f) => f.id));
    expect(lookup.facts.map((f) => f.id).filter((id) => !have.has(id))).toEqual([]);
    expect(chained.facts.filter((f) => f.statement.includes('人均产值')).length).toBeGreaterThanOrEqual(lookup.facts.filter((f) => f.statement.includes('人均产值')).length);
  });
});


describe('the ordering step', () => {
  it('orders every candidate, not the heaviest 150 relations', async () => {
    const walk = await walkRelations(store, '风控平台组今年第一起事故是谁修复的？', ['risk'], { maxHops: 1 });
    const picked = walk.steps.find((s) => s.order);
    expect(picked?.source).toBe('EVT-150');
    expect(picked?.order).toMatch(/^the 1st of 200 dated in 2026 \(this year: the knowledge base's latest date, 2026-\d\d-\d\d\), by date \(2026-01-01\)/);
  });

  it('reads 今年 as the present year, not the latest year the candidates are dated in', async () => {
    const walk = await walkRelations(store, '清算组今年第一起事故是谁修复的？', ['clear'], { maxHops: 1 });
    expect(walk.steps.find((s) => s.order)).toBeUndefined();
    expect(walk.ordering?.picks[0]).toMatch(/not ordered: .*0 .*dated in 2026/);
    // a year the question names for the ordering is that year
    const named = await walkRelations(store, '清算组2025年第一起事故是谁修复的？', ['clear'], { maxHops: 1 });
    expect(named.steps.find((s) => s.order)?.source).toBe('INC-OLD-olda');
  });

  it('takes a year named elsewhere in the question as no period of the ordering', () => {
    expect(ordinalInQuestion('周岚2024年加入清算组，清算组今年第一起事故是谁修复的？')).toMatchObject({ period: { unit: 'year', year: null } });
    expect(ordinalInQuestion('周岚2024年加入清算组，清算组第一起事故是谁修复的？')).toMatchObject({ period: null });
  });

  it('dates a candidate by the event the question orders, not by when it was first seen', async () => {
    const walk = await walkRelations(store, '远航科技最近一次发布的产品是谁负责的？', ['sail'], { maxHops: 1 });
    expect(walk.steps.find((s) => s.order)?.target).toBe('旗舰一号');
  });

  it('tells the answer what it picked, from how many and by which date, or that it could not', async () => {
    const embedder = { model: MODEL, dimensions: 4, embed: async (t: string[]) => t.map(() => [1, 0, 0, 0]) } as EmbeddingProvider;
    const res = await ask(store, config, embedder, noLlm, '清算组第三起事故是谁修复的？此人负责哪个项目', { route: 'multihop' });
    expect(res.route.walked?.ordering).toMatchObject({ asked: '第三起' });
    expect(res.facts.some((f) => f.status === 'computed' && /not ordered: 第三起 asks for the 3rd/.test(f.statement))).toBe(true);
    const picked = await ask(store, config, embedder, noLlm, '清算组2025年第二起事故是谁修复的？此人负责哪个项目', { route: 'multihop' });
    const line = picked.facts.find((f) => f.status === 'computed');
    expect(line?.statement).toMatch(/第二起 .*INC-OLD-oldb.*the 2nd of 2 dated in 2025, by date \(2025-06-09\)/);
    // the relation stays a fact of the source; the pick is the walk's, said apart from it
    expect(stepsAsFacts(await walkRelations(store, '清算组2025年第二起事故是谁修复的？', ['clear'], { maxHops: 1 }).then((w) => w.steps)).every((f) => !f.statement.includes('picked'))).toBe(true);
  });
});

describe('the passage that states a hop', () => {
  it('is read from the relation\'s own source, not from an old note that mentions both ends', async () => {
    const walk = await walkRelations(store, '安娜负责的项目是什么？那个项目的负责人还负责什么', ['ann'], { maxHops: 1 });
    expect(walk.steps.map((s) => s.target)).toEqual(['轨道计划']);
    expect(walk.bridges[0].content).toBe('2024年第12周：安娜开始负责轨道计划。');
  });

  it('reads a bounded number of rows for a hub mentioned in hundreds of chunks', async () => {
    const rows: number[] = [];
    const q0 = store.query.bind(store);
    const spy = Object.assign(Object.create(Object.getPrototypeOf(store)), store, {
      query: async (sql: string, params?: unknown[]) => {
        const r = await q0(sql, params as never[]);
        rows.push(r.length);
        return r;
      },
    }) as Store;
    const walk = await walkRelations(spy, '中枢平台依赖什么？它的负责人是谁', ['hub'], { maxHops: 1 });
    expect(walk.steps.map((s) => s.target)).toEqual(['辐条服务']);
    expect(walk.bridges[0].chunkId).toBe('ch599');
    expect(Math.max(...rows)).toBeLessThanOrEqual(250);
  });
});

describe('the meaning signal', () => {
  const vector = { queryVector: [1, 0, 0, 0], model: MODEL };

  it('cannot outweigh a term match, however many siblings it is measured against', async () => {
    // every product relation holds 旗下 and 产品; the audit holds the rarer 专项 and 审计; product 0 is nearest in meaning
    const walk = await walkRelations(store, '星河控股旗下哪个产品接受过专项审计？', ['hold'], { maxHops: 1, ...vector });
    expect(walk.steps[0].target).toBe('审计署');
    const near = walk.steps.find((s) => s.target === '星河产品0号')!;
    const other = walk.steps.find((s) => s.target !== '星河产品0号' && s.target !== '审计署')!;
    // what meaning adds over a sibling that holds the same terms: at most two points, below the audit's rare terms
    expect(near.score - other.score).toBeGreaterThan(0);
    expect(near.score - other.score).toBeLessThanOrEqual(2);
    expect(near.score).toBeLessThan(walk.steps[0].score);
  });

  it('gives nothing to siblings none of which is near the question', async () => {
    const walk = await walkRelations(store, '双子事业部里管基础设施的那支队伍，今年第一起事故是谁处理好的？', ['duo'], { maxHops: 1, ...vector });
    expect(walk.steps).toEqual([]);
  });

  it('is not read from another model\'s vectors', async () => {
    const walk = await walkRelations(store, '星河控股旗下哪个产品接受过专项审计？', ['hold'], { maxHops: 1, queryVector: [1, 0, 0, 0], model: 'another-model' });
    const near = walk.steps.find((s) => s.target === '星河产品0号');
    const other = walk.steps.find((s) => s.target !== '星河产品0号' && s.target !== '审计署');
    expect(near === undefined || near.score === other?.score).toBe(true);
  });
});

describe('the walk\'s vocabulary', () => {
  const texts = (q: string) => walkTerms(q).terms.map((t) => t.text);

  it('widens a predicate only to spellings that mean the same in general', () => {
    // escalating is not complaining, releasing is not going live or delivering, a hint is not raising, joining is not a transfer
    expect(texts('客户升级了哪起事故？')).not.toContain('投诉');
    expect(texts('这款产品什么时候发布的？')).not.toEqual(expect.arrayContaining(['上线']));
    expect(texts('这款产品什么时候发布的？')).not.toContain('交付');
    expect(texts('系统什么时候上线的？')).toContain('投产');
    expect(texts('谁提示过这个风险？')).not.toContain('提出');
    expect(texts('他后来加入了哪个团队？')).not.toContain('调入');
    expect(texts('事故是谁处理好的？')).toContain('修复');
  });

  it('reads 组 as a team only where it is a word', () => {
    expect(walkTerms('他管理的投资组合表现如何').budget.has('type:organization')).toBe(false);
    expect(walkTerms('这个组件由谁维护').budget.has('type:organization')).toBe(false);
    expect(walkTerms('他后来调到了哪个组').budget.has('type:organization')).toBe(true);
    expect(walkTerms('他后来调到了哪个团队').budget.has('type:organization')).toBe(true);
  });
});
