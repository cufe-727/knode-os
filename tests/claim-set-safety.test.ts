import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, KnodeConfig } from '../src/config.js';
import { tier0Known } from '../src/graph/concepts.js';
import { entityKeyKinds } from '../src/graph/normalize.js';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import type { ChatMessage, LlmClient } from '../src/llm/client.js';
import { ask } from '../src/search/ask.js';
import { computeClaimSet, documentOwners, readSetQuestion, SET_BLOCK_CHARS } from '../src/search/claimset.js';
import { classifyQuestion } from '../src/search/route.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../src/store/db.js';

/**
 * docs/design/34 §1, after the review of 2026-11-16: a computed set says
 * nothing rather than something wrong. Finance-style claims — a typo a later
 * claim replaced, a forecast, two currencies, a quarter and a half-year, a
 * merged spelling, look-alike names — and the switch that keeps it off.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-claim-set-safety-'));
let store: Store;

class FixtureEmbedder implements EmbeddingProvider {
  readonly model = 'fixture-v1';
  readonly dimensions = 4;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0, 0, 0]);
  }
}
const embedder = new FixtureEmbedder();

async function addEntity(id: string, name: string, type: string, canonical: string | null = null): Promise<void> {
  await store.query(`INSERT INTO entities (id, name, type, mention_count, aliases, description, canonical_id) VALUES ($1, $2, $3, 5, '[]'::jsonb, '', $4)`, [id, name, type, canonical]);
  for (const key of entityKeyKinds(name).keys()) {
    await store.query(`INSERT INTO entity_alias_keys (entity_id, alias_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, key]);
  }
}

async function addDoc(id: string, title: string, date: string | null, content: string, mentions: string[] = []): Promise<void> {
  const p = `raw/docs/${id}.md`;
  await store.query(`INSERT INTO documents (id, path, root, title, sha256, bytes, status, doc_date) VALUES ($1, $2, 'docs', $3, $4, 10, 'indexed', $5)`, [id, p, title, `sha-${id}`, date]);
  await store.query(`INSERT INTO chunks (id, document_id, seq, content, token_count, tsv) VALUES ($1, $2, 0, $3, 3, to_tsvector('simple', $3))`, [`c-${id}`, id, content]);
  await store.query(`INSERT INTO embeddings (chunk_id, model, embedding) VALUES ($1, $2, $3::${VECTOR_TYPE})`, [`c-${id}`, embedder.model, toVectorLiteral([1, 0, 0, 0])]);
  await store.query(`INSERT INTO scopes (id, kind, key, sha, status, applied_at) VALUES ($1, 'tier1', $2, $3, 'active', now())`, [`s-${id}`, p, `sha-${id}`]);
  for (const e of mentions) {
    await store.query(`INSERT INTO entity_mentions (entity_id, chunk_id, document_id, scope_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [e, `c-${id}`, id, `s-${id}`]);
  }
}

let claimNo = 0;
interface ClaimExtra {
  id?: string; object?: string; attribute?: string; num?: number; text?: string; unit?: string; at?: string | null;
  from?: string; to?: string; kind?: string; status?: string; supersededBy?: string; correction?: boolean;
}
async function addClaim(doc: string, subject: string, statement: string, x: ClaimExtra = {}): Promise<string> {
  const id = x.id ?? `cl-${++claimNo}`;
  await store.query(
    `INSERT INTO claims (id, subject_id, object_id, type, statement, status, kind, chunk_id, primary_scope_id, evidence_count, tx_from,
                         attribute, value_num, value_text, unit, effective_at, valid_from, valid_to, correction, superseded_by)
     VALUES ($1, $2, $3, 'other', $4, $5, $6, $7, $8, 1, now(), $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [id, subject, x.object ?? null, statement, x.status ?? 'fact', x.kind ?? 'fact', `c-${doc}`, `s-${doc}`, x.attribute ?? null, x.num ?? null, x.text ?? null,
      x.unit ?? null, x.at ?? null, x.from ?? null, x.to ?? null, x.correction ?? false, x.supersededBy ?? null],
  );
  await store.query(`INSERT INTO evidence (kind, target_id, scope_id, weight, extractor, tx_from) VALUES ('claim', $1, $2, 1, 'fixture', now())`, [id, `s-${doc}`]);
  return id;
}
const d = (s: string) => `${s}T00:00:00Z`;

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, '.knode'), { recursive: true });
  store = await Store.open(tmp, embedder.dimensions);
  await store.indexing;
  await addEntity('catl', '宁德时代', 'organization');
  await addEntity('catl-v', 'CATL', 'organization', 'catl'); // a spelling merged into 宁德时代
  await addEntity('byd', '比亚迪', 'organization');
  await addEntity('tesla', '特斯拉', 'organization');
  await addEntity('bmw', '宝马', 'organization');

  await addDoc('r1', '宁德时代2025年一季报点评', d('2025-04-20'), '宁德时代一季度营收847亿元。', ['catl']);
  await addDoc('r2', '宁德时代2025年中报点评', d('2025-08-01'), '宁德时代上半年营收1789亿元。', ['catl']);
  await addDoc('r3', '宁德时代深度：2026年展望', d('2025-09-10'), '预计宁德时代2026年营收4500亿元。', ['catl']);
  await addDoc('r4', 'CATL overseas note', d('2025-10-10'), 'CATL revenue was 59 billion USD.', ['catl-v']);
  await addDoc('r5', '宁德时代周报', d('2026-01-05'), '宁德时代本周要点。', ['catl']);

  // revenue: a typo a later claim of the same quarter replaced, a quarter, a half-year, a forecast, another currency
  const fix = await addClaim('r1', 'catl', '宁德时代2025年一季度营收847亿元', { attribute: '营收', num: 847, unit: '亿元', at: d('2025-04-20'), from: d('2025-01-01'), to: d('2025-03-31') });
  await addClaim('r1', 'catl', '宁德时代2025年一季度营收8470亿元', { attribute: '营收', num: 8470, unit: '亿元', at: d('2025-04-10'), supersededBy: fix });
  await addClaim('r2', 'catl', '宁德时代2025年上半年营收1789亿元', { attribute: '营收', num: 1789, unit: '亿元', at: d('2025-08-01') });
  await addClaim('r3', 'catl', '预计宁德时代2026年营收4500亿元', { attribute: '营收', num: 4500, unit: '亿元', at: d('2025-09-10'), kind: 'prediction', status: 'suspected' });
  await addClaim('r2', 'catl', '宁德时代上半年海外营收折合59亿美元', { attribute: '营收', num: 59, unit: '亿美元', at: d('2025-08-20') });
  // risks, and claims that merely say "需要注意"
  await addClaim('r2', 'catl', '宁德时代面临原材料价格波动风险', {});
  await addClaim('r2', 'catl', '宁德时代存在海外建厂政策风险', {});
  await addClaim('r2', 'byd', '比亚迪二季度销量需要注意同比口径变化', { object: 'catl' });
  await addClaim('r2', 'tesla', '特斯拉储能订单交付节奏需要注意', { object: 'catl' });
  // customers, one of them filed under the merged spelling
  await addClaim('r1', 'tesla', '特斯拉是宁德时代的客户', { object: 'catl', at: d('2025-04-20') });
  await addClaim('r2', 'bmw', '宝马是宁德时代的客户', { object: 'catl', at: d('2025-08-01') });
  await addClaim('r2', 'catl-v', 'CATL 的客户包括多家欧洲车企', { at: d('2025-08-01') });
  await addClaim('r4', 'byd', '比亚迪是CATL的客户', { object: 'catl-v', at: d('2025-10-10') });
  // a customer only rumoured
  await addEntity('nio', '蔚来', 'organization');
  await addClaim('r5', 'nio', '蔚来或将成为宁德时代的客户', { object: 'catl', at: d('2026-01-05'), kind: 'rumor', status: 'suspected' });
  // 中信, its recorded subsidiary 中信证券, and 中信建投, whose name merely begins with 中信
  await addEntity('citic', '中信', 'organization');
  await addEntity('citics', '中信证券', 'organization');
  await addEntity('csc', '中信建投', 'organization');
  await store.query(`INSERT INTO relations (id, source_id, target_id, type, description, weight) VALUES ('r-citics', 'citics', 'citic', 'subsidiary_of', '中信证券是中信的子公司', 1)`);
  await addDoc('c1', '中信证券周报', d('2025-06-01'), '中信证券的客户。', ['citics']);
  await addDoc('c2', '中信建投周报', d('2025-06-01'), '中信建投的客户。', ['csc']);
  for (let i = 0; i < 4; i++) {
    await addClaim('c1', 'citics', `中信证券第${i}项业务进展顺利`, { at: d('2025-06-01') });
    await addClaim('c2', 'csc', `中信建投第${i}项业务进展顺利`, { at: d('2025-06-01') });
  }
  await addClaim('c1', 'bmw', '宝马是中信证券的客户', { object: 'citics', at: d('2025-06-01') });
  await addClaim('c2', 'tesla', '特斯拉是中信建投的客户', { object: 'csc', at: d('2025-06-01') });
  // a weekly series: each week's reading superseded by the next week's, as supersession marks a series
  const weeks = [['2025-03-03', '2025-03-07', 12.1], ['2025-03-10', '2025-03-14', 13.4], ['2025-03-17', '2025-03-21', 12.8]] as const;
  let next: string | undefined;
  for (const [from, to, v] of [...weeks].reverse()) {
    await addDoc(`wk-${from}`, `宁德时代周报 ${from}`, d(to), `本周出货量${v}GWh`, ['catl']);
    next = await addClaim(`wk-${from}`, 'catl', `宁德时代本周出货量${v}GWh`, { attribute: '出货量', num: v, unit: 'GWh', at: d(from), from: d(from), to: d(to), supersededBy: next });
  }
  // a reading of the attribute whose figure was never recorded as a number
  await addClaim('wk-2025-03-17', 'catl', '宁德时代本周出货量与上周持平', { attribute: '出货量', text: '持平', at: d('2025-03-17'), from: d('2025-03-17'), to: d('2025-03-21') });
});

afterAll(async () => {
  await store?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const set = (q: string, named: string[], now = '2026-11-16') => computeClaimSet(store, q, classifyQuestion(q), named, { now });

function recordingLlm(): { llm: LlmClient; prompts: string[] } {
  const prompts: string[] = [];
  const llm = {
    enabled: true,
    complete: async (messages: ChatMessage[]) => {
      prompts.push(messages.map((m) => m.content).join('\n'));
      return 'ok\n{"citations":[],"gaps":[]}';
    },
    completeJson: async () => {
      throw new Error('no JSON call expected');
    },
  } as unknown as LlmClient;
  return { llm, prompts };
}

const withRouter = (router: Partial<NonNullable<KnodeConfig['retrieval']['router']>>): KnodeConfig => {
  const c = defaultConfig();
  c.retrieval.router = { ...c.retrieval.router!, ...router };
  return c;
};

describe('numbers from current, factual claims of one unit and one period granularity (review item 1)', () => {
  it('takes no maximum over a typo a later claim of its own quarter replaced, a forecast, another currency or a mix of quarter and half-year', async () => {
    const max = await set('宁德时代的最高营收是多少？', ['catl', 'catl-v']);
    // a quarter and a half-year, one reading each: no granularity to take a maximum over
    expect(max).toBeNull();
    expect(await set('宁德时代营收总额是多少？', ['catl', 'catl-v'])).toBeNull();
  });

  it('gives the value as of a day from factual readings of the commonest unit, and says what it left out', async () => {
    const v = await set('截至2025年12月31日，宁德时代的营收是多少？', ['catl', 'catl-v']);
    expect(v).toMatchObject({ op: 'value', answer: '1789' });
    const text = v!.lines.join('\n');
    expect(text).not.toContain('4500');
    expect(text).not.toContain('8470');
    expect(text).toMatch(/left out.*not stated as fact/i);
    expect(text).toMatch(/left out.*another unit.*亿美元/i);
    expect(text).toMatch(/left out.*replaced for its own period/i);
  });

  it('counts every week of a series that supersession marks week by week', async () => {
    const max = await set('宁德时代的最高周出货量是多少？', ['catl', 'catl-v']);
    expect(max).toMatchObject({ op: 'max', answer: '13.4' });
    expect(max!.lines[0]).toContain('of 3 readings');
  });

  it('shows each row with its own kind and status, and counts no item reported only as a rumour', async () => {
    const { llm, prompts } = recordingLlm();
    const res = await ask(store, defaultConfig(), embedder, llm, '宁德时代有哪些客户？', { computed: true });
    expect(prompts[0]).toContain('[rumor, suspected; set] 蔚来或将成为宁德时代的客户');
    expect(res.computed!.lines.join('\n')).not.toMatch(/^- 蔚来/m);
    expect(res.computed!.lines.join('\n')).toMatch(/not as fact.*蔚来/);
  });
});

describe('nothing computed when what is asked is not tied to the claims with confidence (review item 2)', () => {
  it('computes no set from a match on part of what the question asks', async () => {
    // "需要注意" matches, "风险" does not: the claims that say 需要注意 are not the risks asked for
    expect(await set('宁德时代有哪些风险需要注意？', ['catl'])).toBeNull();
    // a question whose words reach no claim
    expect(await set('How many ways could this go wrong for 宁德时代?', ['catl'])).toBeNull();
  });

  it('still computes a set the question\'s kind of item and words tie to the claims', async () => {
    const s = await set('宁德时代有哪些客户？', ['catl']);
    expect(s?.lines.join('\n')).toMatch(/^- 特斯拉/m);
  });

  it('tells the model to check the match before taking its figures', async () => {
    const { llm, prompts } = recordingLlm();
    await ask(store, defaultConfig(), embedder, llm, '宁德时代有哪些客户？', { computed: true });
    expect(prompts[0]).toContain('use its figures only where that match is what the question asks');
  });
});

describe('merged spellings are their survivor (review item 3)', () => {
  it('never lists a merged spelling of the scope as an item, and finds what was filed under it', async () => {
    // namedEntities gives the survivor and every spelling merged into it
    const s = await set('宁德时代有哪些客户？', ['catl', 'catl-v']);
    const items = s!.lines.filter((l) => l.startsWith('- ')).map((l) => l.slice(2).split(' ')[0]);
    expect(items).not.toContain('CATL');
    // "比亚迪是CATL的客户" names the merged spelling, in a document of its own
    expect(items.sort()).toEqual(['宝马', '比亚迪', '特斯拉']);
    expect(s!.scope).toBe('宁德时代');
  });

  it('takes no merged spelling for what the question asks about', async () => {
    expect(await set('How many ways could this go wrong for 宁德时代?', ['catl', 'catl-v'])).toBeNull();
  });
});

describe('periods read from today and the question\'s own year; an empty set is not computed (review item 4)', () => {
  const customers = (x: Awaited<ReturnType<typeof set>>) => x!.lines.filter((l) => l.startsWith('- ')).map((l) => l.slice(2).split(' ')[0]).sort();

  it('reads a yearless quarter in today\'s year, and gives nothing — not zero — when that quarter holds nothing', async () => {
    // the latest report is of 2026-01: the fourth quarter asked on 2026-11-16 is 2026's, which holds no customer
    expect(await set('宁德时代四季度有哪些客户？', ['catl'], '2026-11-16')).toBeNull();
    expect(customers(await set('宁德时代四季度有哪些客户？', ['catl'], '2025-12-20'))).toEqual(['比亚迪']);
    expect(await set('截至三季度宁德时代有几个客户？', ['catl'], '2026-11-16')).toBeNull();
    expect(await set('截至三季度宁德时代有几个客户？', ['catl'], '2025-11-01')).toMatchObject({ answer: 2 });
  });

  it('reads last year, a fiscal year and the last N months from today', async () => {
    expect(await set('去年宁德时代有几个客户？', ['catl'], '2026-11-16')).toMatchObject({ answer: 3 });
    // in 2026 only a rumoured customer: nothing to count
    expect(await set('去年宁德时代有几个客户？', ['catl'], '2027-03-01')).toBeNull();
    expect(await set('宁德时代2025财年有几个客户？', ['catl'])).toMatchObject({ answer: 3 });
    expect(customers(await set('宁德时代近3个月有哪些客户？', ['catl'], '2025-11-15'))).toEqual(['比亚迪']);
  });

  it('computes nothing for a period it cannot read', async () => {
    expect(await set('宁德时代最近有哪些客户？', ['catl'])).toBeNull();
  });

  it('computes nothing when no item of the kind asked for is found', async () => {
    expect(await set('宁德时代的客户有哪些人负责？', ['catl'])).toBeNull();
  });
});

describe('a scope\'s members come from recorded relations, not names (review item 7)', () => {
  it('takes a subsidiary for a member, and a look-alike name for none', async () => {
    const s = await set('中信有哪些客户？', ['citic']);
    expect(s!.scope).toBe('中信 (with 1 member organisations)');
    const items = s!.lines.filter((l) => l.startsWith('- ')).map((l) => l.slice(2).split(' ')[0]);
    expect(items).toEqual(['宝马']);
  });
});

describe('bounded work: SQL over indexes and a time budget (review item 5)', () => {
  beforeAll(async () => {
    // twenty thousand people, and two thousand claims about who runs 宁德时代's lines; the one named is mentioned
    await addEntity('wq', '王强', 'person');
    await addDoc('lines', '宁德时代产线周报', d('2025-05-05'), '宁德时代各产线由王强负责。', ['catl', 'wq']);
    await store.query(`INSERT INTO entities (id, name, type, mention_count, aliases, description) SELECT 'p-' || i, '人' || substr(md5(i::text), 1, 3), 'person', 1, '[]'::jsonb, '' FROM generate_series(1, 20000) i`);
    await store.query(
      `INSERT INTO claims (id, subject_id, type, statement, status, kind, chunk_id, primary_scope_id, evidence_count, tx_from, effective_at, correction)
       SELECT 'line-' || i, 'catl', 'other', '宁德时代第' || i || '条产线投产，由王强负责', 'fact', 'fact', 'c-lines', 's-lines', 1, now(), '2025-05-05T00:00:00Z', false FROM generate_series(1, 2000) i`,
    );
    await store.query(`INSERT INTO evidence (kind, target_id, scope_id, weight, extractor, tx_from) SELECT 'claim', 'line-' || i, 's-lines', 1, 'fixture', now() FROM generate_series(1, 2000) i`);
  });

  it('finds the people a set names from the mentions of its claims, never by reading every person', async () => {
    let most = 0;
    const query = store.query.bind(store);
    const spied = Object.assign(Object.create(Object.getPrototypeOf(store)), store, {
      query: async <T>(sql: string, p?: unknown[]) => {
        const rows = await query<T>(sql, p);
        most = Math.max(most, rows.length);
        return rows;
      },
    }) as Store;
    const q = '宁德时代的产线有哪些人负责？';
    const s = await computeClaimSet(spied, q, classifyQuestion(q), ['catl'], { now: '2026-11-16', budgetMs: 60_000 });
    expect(s!.lines.filter((l) => l.startsWith('- ')).map((l) => l.slice(2).split(' ')[0])).toEqual(['王强']);
    expect(most).toBeLessThan(20000);
  });

  it('computes nothing once its time budget is spent', async () => {
    const q = '宁德时代有哪些客户？';
    expect(await computeClaimSet(store, q, classifyQuestion(q), ['catl'], { budgetMs: 0 })).toBeNull();
  });
});

describe('a bounded block (review item 6)', () => {
  beforeAll(async () => {
    // an organisation with a thousand customers
    await addEntity('big', '远航集团', 'organization');
    await addDoc('big-1', '远航集团客户名录', d('2025-06-01'), '远航集团客户名录。', ['big']);
    await store.query(`INSERT INTO entities (id, name, type, mention_count, aliases, description) SELECT 'cust-' || i, '客户公司' || i || '有限责任公司', 'organization', 1, '[]'::jsonb, '' FROM generate_series(1, 1000) i`);
    await store.query(
      `INSERT INTO claims (id, subject_id, object_id, type, statement, status, kind, chunk_id, primary_scope_id, evidence_count, tx_from, effective_at, correction)
       SELECT 'cc-' || i, 'cust-' || i, 'big', 'other', '客户公司' || i || '有限责任公司是远航集团的客户', 'fact', 'fact', 'c-big-1', 's-big-1', 1, now(), '2025-06-01T00:00:00Z', false FROM generate_series(1, 1000) i`,
    );
    await store.query(`INSERT INTO evidence (kind, target_id, scope_id, weight, extractor, tx_from) SELECT 'claim', 'cc-' || i, 's-big-1', 1, 'fixture', now() FROM generate_series(1, 1000) i`);
    // the names a question is matched against are cached: an entity added after the first ask is known only after a refresh
    await tier0Known(store, { force: true });
  });

  it('cuts the computed block at its character budget, says so, and lists no more facts than the limit', async () => {
    const { llm, prompts } = recordingLlm();
    // its own budget is tested apart: a loaded machine may spend the default one here
    const res = await ask(store, withRouter({ computedBudgetMs: 60_000 }), embedder, llm, '远航集团有哪些客户？', { computed: true });
    const p = prompts[0];
    const block = p.slice(p.indexOf('# Computed from the claims'), p.indexOf('# Question'));
    expect(res.computed!.items).toBe(1000);
    expect(block.length).toBeLessThanOrEqual(SET_BLOCK_CHARS + 400);
    expect(block).toMatch(/1000 distinct organization/);
    expect(block).toMatch(/\d+ more lines not shown/);
    expect(res.facts.length).toBeLessThanOrEqual(defaultConfig().retrieval.router!.enumerateLimit);
  });
});

describe('lookups stay lookups (review item 9)', () => {
  const r = (q: string) => readSetQuestion(q, classifyQuestion(q), '2026-11-16');
  it('reads a singular which-question as no set', () => {
    expect(r('Which company acquired Northwind?')).toBeNull();
    expect(r('Which P1 incidents did Northwind have?')).toMatchObject({ op: 'list' });
    expect(r('Which people in Northwind fixed at least two incidents?')).toMatchObject({ op: 'list' });
  });

  it('reads a day in an event question as no value asked as of it', () => {
    expect(r('宁德时代2025年11月7日那天发布了什么公告？')?.op).not.toBe('value');
    expect(r('What did CATL announce on 2025-11-07?')?.op).not.toBe('value');
    expect(r('截至2025年11月7日，平台组的订单库连接池上限是多少？')).toMatchObject({ op: 'value', asOf: '2025-11-07' });
    expect(r('What was the pool limit of Northwind Platform as of 2025-03-01?')).toMatchObject({ op: 'value' });
  });
});

describe('the rest of the review (item 10)', () => {
  it('says how many claims of the attribute had no number to compute with', async () => {
    const max = await set('宁德时代的最高周出货量是多少？', ['catl']);
    expect(max!.lines.join('\n')).toMatch(/1 of the attribute with no numeric value recorded/);
  });

  it('says a set read from fewer documents than its scope has is capped', async () => {
    const s = await computeClaimSet(store, '宁德时代有哪些客户？', classifyQuestion('宁德时代有哪些客户？'), ['catl'], { budgetMs: 60_000, docsCap: 1 });
    expect(s?.capped).toBe(true);
    expect(s!.lines[0]).toContain('may be incomplete');
  });

  it('reads a company-wide question by the attributes it names, with no scan of every statement', async () => {
    const seen: string[] = [];
    const query = store.query.bind(store);
    const spied = Object.assign(Object.create(Object.getPrototypeOf(store)), store, {
      query: async <T>(sql: string, p?: unknown[]) => { seen.push(sql); return query<T>(sql, p); },
    }) as Store;
    const q = '全公司一共有多少条营收记录？';
    await computeClaimSet(spied, q, classifyQuestion(q), [], { budgetMs: 60_000 });
    expect(seen.some((sql) => /ILIKE/i.test(sql))).toBe(false);
  });
});

describe('history the measurement showed the first fix lost', () => {
  beforeAll(async () => {
    await addEntity('cutoff', '拦截分数线', 'component');
    await addEntity('fj', '飞驰集团', 'organization');
    await addDoc('s1', '宁德时代配置周报 3月', d('2025-03-17'), '拦截分数线定为80分。', ['catl']);
    await addDoc('s2', '宁德时代配置周报 5月', d('2025-05-19'), '拦截分数线改为85分。', ['catl']);
    await addDoc('s3', '宁德时代配置周报 7月', d('2025-07-14'), '拦截分数线改回原来的80分。', ['catl']);
    await addDoc('fj-1', '飞驰集团配置周报', d('2025-06-13'), '拦截分数线撤回原先的80分，以85分为准。', ['fj']);
    // one setting entity for two companies (a merge across scopes); the extractor flags the revert as a correction
    const revert = await addClaim('s3', 'cutoff', '宁德时代拦截分数线改回原来的80分', { attribute: '分数线', num: 80, unit: '分', at: d('2025-07-14'), correction: true });
    const other = await addClaim('fj-1', 'cutoff', '飞驰集团拦截分数线撤回原先的80分，以85分为准', { attribute: '分数线', num: 85, unit: '分', at: d('2025-06-13'), correction: true });
    const change = await addClaim('s2', 'cutoff', '宁德时代拦截分数线改为85分', { attribute: '分数线', num: 85, unit: '分', at: d('2025-05-19'), supersededBy: other });
    await addClaim('s1', 'cutoff', '宁德时代拦截分数线定为80分', { attribute: '分数线', num: 80, unit: '分', at: d('2025-03-17'), supersededBy: change });
    await store.query(`UPDATE claims SET superseded_by = $1 WHERE id = $2`, [revert, other]);
    for (const doc of ['s1', 's2', 's3']) for (let i = 0; i < 3; i++) await addClaim(doc, 'catl', `宁德时代配置项${i}正常`, { at: d('2025-05-01') });
    for (let i = 0; i < 3; i++) await addClaim('fj-1', 'fj', `飞驰集团配置项${i}正常`, { at: d('2025-06-13') });
    // a series whose unit is written with and without its noun
    for (const [day, v, unit] of [['2025-04-07', 121, '万'], ['2025-04-14', 135, '万用户'], ['2025-04-21', 128, '万']] as const) {
      await addClaim('r2', 'catl', `宁德时代本周周活跃用户${v}${unit}`, { attribute: '周活跃用户', num: v, unit, at: d(day), from: d(day), to: d(day.replace(/\d\d$/, (x) => String(Number(x) + 4).padStart(2, '0'))) });
    }
  });

  it('keeps a setting\'s earlier value as its history when a later change, or a revert flagged as a correction, replaced it', async () => {
    expect(await set('2025年4月1日那天，宁德时代的拦截分数线是多少？', ['catl'])).toMatchObject({ answer: '80' });
    // replaced by the other company's correction of its own copy: still 宁德时代's value then
    expect(await set('2025年6月18日那天，宁德时代的拦截分数线是多少？', ['catl'])).toMatchObject({ answer: '85' });
    expect(await set('截至2025年11月7日，宁德时代的拦截分数线是多少？', ['catl'])).toMatchObject({ answer: '80' });
  });

  it('takes a unit with and without its noun for one unit', async () => {
    const max = await set('宁德时代的最高周活跃用户是多少？', ['catl']);
    expect(max).toMatchObject({ answer: '135' });
    expect(max!.lines[0]).toContain('of 3 readings');
  });
});

describe('a figure belongs to its claim\'s subject (re-check item 3)', () => {
  beforeAll(async () => {
    // a peer's figures stated in 宁德时代's own reports
    await addClaim('r1', 'catl', '宁德时代2025年一季度毛利率24.4%', { attribute: '毛利率', num: 24.4, unit: '%', at: d('2025-04-20') });
    await addClaim('r2', 'catl', '宁德时代2025年二季度毛利率25.0%', { attribute: '毛利率', num: 25.0, unit: '%', at: d('2025-08-01') });
    await addClaim('r2', 'byd', '比亚迪2025年二季度毛利率17.6%', { attribute: '毛利率', num: 17.6, unit: '%', at: d('2025-08-01') });
    await addClaim('r1', 'catl', '宁德时代市值9800亿元', { attribute: '市值', num: 9800, unit: '亿元', at: d('2025-04-10') });
    await addClaim('r1', 'byd', '比亚迪市值9000亿元', { attribute: '市值', num: 9000, unit: '亿元', at: d('2025-04-11') });
    // a document whose two organisations are each the subject of one claim
    await addEntity('aaa', 'AAA集团', 'organization');
    await addDoc('tie', '行业快讯', d('2025-05-01'), 'AAA集团与比亚迪。', ['aaa', 'byd']);
    await addClaim('tie', 'aaa', 'AAA集团发布新品', { at: d('2025-05-01') });
    await addClaim('tie', 'byd', '比亚迪发布新品', { at: d('2025-05-01') });
  });

  it('takes no peer company\'s figure stated in the company\'s report for the company\'s', async () => {
    expect(await set('宁德时代的最低毛利率是多少？', ['catl'])).toMatchObject({ answer: '24.4' });
    const v = await set('截至2025年6月30日，宁德时代的市值是多少？', ['catl']);
    expect(v).toMatchObject({ op: 'value', answer: '9800' });
    expect(v!.lines.join('\n')).toMatch(/Left out: .*other organisations? \(比亚迪\)/);
  });

  it('gives a document whose organisations tie no owner', async () => {
    const owners = await documentOwners(store, ['raw/docs/tie.md', 'raw/docs/r1.md']);
    expect(owners.get('raw/docs/tie.md')!.home).toBeNull();
    expect(owners.get('raw/docs/r1.md')!.home).toBe('catl');
  });
});

describe('a Chinese question end to end (review item 11)', () => {
  it('puts the value as of a day, its sources and what it left out before the model, and no forecast as a fact', async () => {
    const { llm, prompts } = recordingLlm();
    const res = await ask(store, withRouter({ computedSets: true, computedBudgetMs: 60_000 }), embedder, llm, '截至2025年12月31日，宁德时代的营收是多少？');
    expect(res.route.computed).toMatchObject({ op: 'value', scope: '宁德时代' });
    const p = prompts[0];
    expect(p).toContain('# Computed from the claims');
    expect(p).toContain('Value as of 2025-12-31: 1789亿元');
    expect(p).toMatch(/\[fact; set\] 宁德时代2025年上半年营收1789亿元 \(2025-08-01\) — raw\/docs\/r2\.md/);
    expect(p).not.toMatch(/\[fact; set\] 预计宁德时代2026年营收4500亿元/);
    expect(p).toMatch(/Left out: .*not stated as fact/);
  });
});

describe('the switches', () => {
  it('computes no set unless the workspace or the call turns computed sets on', async () => {
    const q = '宁德时代有哪些客户？';
    expect((await ask(store, defaultConfig(), embedder, recordingLlm().llm, q)).computed).toBeUndefined();
    expect((await ask(store, withRouter({ computedSets: true }), embedder, recordingLlm().llm, q)).computed).toBeDefined();
    expect((await ask(store, defaultConfig(), embedder, recordingLlm().llm, q, { computed: true })).computed).toBeDefined();
    expect((await ask(store, withRouter({ computedSets: true }), embedder, recordingLlm().llm, q, { computed: false })).computed).toBeUndefined();
  });
});
