import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { KnodeConfig, loadConfig, saveConfig } from '../src/config.js';
import { initDataDir } from '../src/fs/datadir.js';
import { seriesRelation } from '../src/graph/claim-dedupe.js';
import { refreshClaimState } from '../src/graph/claim-state-store.js';
import { sync } from '../src/ingest/sync.js';

/**
 * The review of the 10× fixes (2026-11-16): rules fitted to the benchmark's
 * weekly reports that go wrong on other text — owner and state series across
 * objects, key unification by a measure's head word, codes kept apart by a
 * prefix, outcomes that depend on the order documents arrive in, and the
 * back-reference step outside periodic reports.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-stale-review-'));
const contexts: AppContext[] = [];
afterAll(async () => {
  for (const ctx of contexts) {
    await ctx.datasources.closeAll();
    await ctx.store.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

export async function workspace(name: string, docs: Record<string, string>, edit?: (c: KnodeConfig) => void): Promise<AppContext> {
  const dataDir = path.join(tmp, name);
  for (const [rel, text] of Object.entries(docs)) {
    const abs = path.join(dataDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  initDataDir(dataDir);
  const config = loadConfig(dataDir);
  config.ingest.concurrency = 1;
  edit?.(config);
  saveConfig(dataDir, config);
  const ctx = await createContext(dataDir);
  contexts.push(ctx);
  await sync(ctx, { llmGraph: false });
  return ctx;
}

const dated = (title: string, date: string, fm: string) => `---\ntitle: ${title}\ndate: ${date}\n${fm}---\n${title}\n`;

describe('owner and state series of one subject toward several objects', () => {
  it('keeps the owner of each business its own series, and one owner of the subject apart from them', async () => {
    const ctx = await workspace('objects', {
      'raw/docs/a.md': dated('周观察1', '2025-03-10', `entities:
  - { name: 比亚迪, type: organization }
  - { name: 云业务, type: product }
  - { name: 张三, type: person }
claims:
  - { subject: 比亚迪, object: 云业务, statement: 云业务由张三负责, type: management }
`),
      'raw/docs/b.md': dated('周观察2', '2025-03-17', `entities:
  - { name: 比亚迪, type: organization }
  - { name: 电池业务, type: product }
  - { name: 李四, type: person }
claims:
  - { subject: 比亚迪, object: 电池业务, statement: 电池业务由李四负责, type: management }
  - { subject: 比亚迪, object: 电池业务, statement: 比亚迪电池业务分拆状态为已完成, type: other }
`),
      'raw/docs/c.md': dated('周观察3', '2025-03-24', `entities:
  - { name: 比亚迪, type: organization }
  - { name: 半导体业务, type: product }
claims:
  - { subject: 比亚迪, object: 半导体业务, statement: 比亚迪半导体业务上市状态为审核中, type: other }
`),
    });
    await refreshClaimState(ctx.store);
    const rows = await ctx.store.query<{ statement: string; attribute: string | null; superseded_by: string | null }>(
      `SELECT statement, attribute, superseded_by FROM claims WHERE tx_to IS NULL AND attribute IS NOT NULL ORDER BY statement`,
    );
    expect(rows.filter((r) => r.attribute === '负责人').map((r) => r.statement).sort()).toEqual(['云业务由张三负责', '电池业务由李四负责'].sort());
    // nothing supersedes anything: each is the current owner or state of its own business
    expect(rows.map((r) => [r.statement, r.superseded_by])).toEqual(rows.map((r) => [r.statement, null]));
  });

  it('still reads a risk\'s state and owner as one series where the object is who handles it or the owner itself', async () => {
    const ctx = await workspace('risk', {
      'raw/docs/a.md': dated('周报1', '2025-03-10', `entities:
  - { name: R-03, type: event }
  - { name: 赖艳, type: person }
claims:
  - { subject: R-03, object: 赖艳, statement: R-03由赖艳负责, type: risk }
  - { subject: R-03, object: 赖艳, statement: R-03状态为跟进中, type: risk }
`),
      'raw/docs/b.md': dated('周报2', '2025-03-17', `entities:
  - { name: R-03, type: event }
  - { name: 钱博, type: person }
claims:
  - { subject: R-03, object: 钱博, statement: R-03由钱博负责, type: risk }
  - { subject: R-03, statement: R-03状态为已关闭, type: risk }
`),
    });
    await refreshClaimState(ctx.store);
    const rows = await ctx.store.query<{ statement: string; attribute: string; current: boolean }>(
      `SELECT statement, attribute, superseded_by IS NULL AS current FROM claims WHERE tx_to IS NULL AND attribute IS NOT NULL`,
    );
    const current = rows.filter((r) => r.current).map((r) => r.statement).sort();
    expect(current).toEqual(['R-03状态为已关闭', 'R-03由钱博负责'].sort());
  });

  it('supersedes within a series of claims that name no object, on stored rows', async () => {
    const ctx = await workspace('objectless', {
      'raw/docs/a.md': dated('周报1', '2025-03-03', 'entities:\n  - { name: 结算平台, type: project }\nclaims:\n  - { subject: 结算平台, statement: 结算平台完成度为40%, type: other }\n  - { subject: 结算平台, statement: 结算平台状态为进行中, type: other }\n'),
      'raw/docs/b.md': dated('周报2', '2025-03-10', 'entities:\n  - { name: 结算平台, type: project }\nclaims:\n  - { subject: 结算平台, statement: 结算平台完成度为55%, type: other }\n  - { subject: 结算平台, statement: 结算平台状态为已上线, type: other }\n'),
    });
    await refreshClaimState(ctx.store);
    const rows = await ctx.store.query<{ statement: string; object_id: string | null; current: boolean }>(
      `SELECT statement, object_id, superseded_by IS NULL AS current FROM claims WHERE tx_to IS NULL AND attribute IS NOT NULL`,
    );
    expect(rows.every((r) => r.object_id === null)).toBe(true);
    expect(rows.filter((r) => r.current).map((r) => r.statement).sort()).toEqual(['结算平台完成度为55%', '结算平台状态为已上线'].sort());
  });

  it('never settles two claims toward different objects as one by rule', () => {
    const base = { subject: 'co', kind: 'fact', attribute: '状态', unit: null, value_num: null };
    expect(seriesRelation({ ...base, object: 'b', value_text: '已完成', eff: '2025-06-16' }, { ...base, object: 'c', value_text: '已完成', eff: '2025-06-16' })).toBeNull();
    expect(seriesRelation({ ...base, object: 'b', value_text: '已完成', eff: '2025-06-16' }, { ...base, object: 'c', value_text: '进行中', eff: '2025-06-23' })).toBeNull();
    expect(seriesRelation({ ...base, object: 'b', value_text: '已完成', eff: '2025-06-16' }, { ...base, object: 'b', value_text: '已完成', eff: '2025-06-16' })).toBe('same');
  });
});

describe('attribute keys of real subjects', () => {
  const pairs = async (uses: [string, number, string][], name: string, aliases: string[] = []) => {
    const { unifyAttributeKeys, subjectSpellingsOf } = await import('../src/graph/claim-state.js');
    const m = unifyAttributeKeys(uses.map(([attribute, count, u]) => ({ attribute, count, units: [u] })), subjectSpellingsOf(name, aliases));
    return [...m.entries()].map(([k, v]) => `${k}→${v.canonical}`).sort();
  };

  it('keeps measures of one head word apart', async () => {
    expect(await pairs([['批发价格', 10, '元'], ['零售价格', 8, '元'], ['出厂价格', 3, '元']], '猪肉价格')).toEqual([]);
    expect(await pairs([['现货价格', 10, '万元'], ['期货价格', 8, '万元']], '碳酸锂价格')).toEqual([]);
    expect(await pairs([['存款利率', 5, '%'], ['贷款利率', 9, '%'], ['按揭利率', 2, '%']], '贷款市场报价利率', ['贷款利率'])).toEqual([]);
    expect(await pairs([['持股比例', 5, '%'], ['质押比例', 4, '%'], ['减持比例', 3, '%']], '大股东持股比例')).toEqual([]);
    // value words name nothing of a subject without a code
    expect(await pairs([['配置', 5, '%'], ['仓位', 9, '%'], ['当前值', 2, '%'], ['设置', 1, '%']], '某基金')).toEqual([]);
  });

  it('joins what claim state joined before the 10× work, except across a qualifier', async () => {
    // one key containing the other, or bigrams that mostly agree: joined as they always were
    expect(await pairs([['净利润', 20, '亿元'], ['归母净利润', 15, '亿元']], '贵州茅台')).toEqual(['归母净利润→净利润']);
    expect(await pairs([['毛利率', 5, '%'], ['销售毛利率', 2, '%']], '某公司')).toEqual(['销售毛利率→毛利率']);
    expect(await pairs([['市盈率', 5, '倍'], ['市盈率TTM', 2, '倍']], '某公司')).toEqual(['市盈率TTM→市盈率']);
    expect(await pairs([['股价', 5, '美元'], ['基准情景终点股价', 2, '美元']], '英伟达')).toEqual(['基准情景终点股价→股价']);
    // an alias of the subject plays no part: the same with or without it
    expect(await pairs([['基准利率', 5, '%'], ['利率', 3, '%']], '美联储', ['联邦基金利率'])).toEqual(await pairs([['基准利率', 5, '%'], ['利率', 3, '%']], '美联储'));
    // across a qualifier the old rule joined, and no longer does: a change, guidance, a target, a low
    expect(await pairs([['同比涨幅', 5, '%'], ['环比涨幅', 3, '%'], ['涨幅', 2, '%']], 'CPI')).toEqual([]);
    expect(await pairs([['毛利率', 5, '%'], ['毛利率指引', 2, '%']], '中芯国际')).toEqual([]);
    expect(await pairs([['门店数', 5, '家'], ['门店数目标', 2, '家']], '肯悦咖啡')).toEqual([]);
    // a group is named by its whole key, not one cut short
    expect(await pairs([['指数', 3, '点'], ['指', 1, '点']], '上证')).toEqual(['指→指数']);
    expect(await pairs([['用户数', 5, '万'], ['用户', 1, '万']], '某应用')).toEqual(['用户→用户数']);
  });

  it('still joins one measure spelled two ways, and the keys that name a coded setting', async () => {
    expect(await pairs([['周活跃用户', 10, '万'], ['周活跃用户数', 3, '万']], '增长组')).toEqual(['周活跃用户数→周活跃用户']);
    expect(await pairs([['批次间隔', 1, '分钟'], ['间隔', 9, '分钟'], ['配置值', 1, '分钟'], ['初始间隔', 14, '分钟']], '对账批次间隔（第一事业部支付组 · T2-C2）', ['T2-C2']))
      .toEqual(['批次间隔→间隔', '配置值→间隔']);
    // an entity named by its code: its name is among its aliases
    expect(await pairs([['阈值', 1, '毫秒'], ['超时阈值', 1, '毫秒'], ['配置值', 1, '毫秒']], 'T1-C3', ['核心接口超时阈值', '超时线'])).toEqual(['配置值→超时阈值', '阈值→超时阈值']);
  });
});

describe('stored keys of an older reading', () => {
  it('move to their synonym head through the key mapping, and the owner rule applies to them', async () => {
    const ctx = await workspace('stored-keys', {
      'raw/docs/a.md': dated('周报1', '2025-03-10', `entities:
  - { name: R-07, type: event }
  - { name: 赖艳, type: person }
claims:
  - { subject: R-07, object: 赖艳, statement: R-07由赖艳负责, type: risk }
`),
      'raw/docs/b.md': dated('周报2', '2025-03-17', `entities:
  - { name: R-07, type: event }
  - { name: 钱博, type: person }
claims:
  - { subject: R-07, object: 钱博, statement: R-07由钱博负责, type: risk }
`),
    });
    await refreshClaimState(ctx.store);
    // as a workspace read before 跟进人 was a synonym of 负责人 holds them: the claims themselves are not read again
    await ctx.store.query(`UPDATE claims SET attribute = '跟进人', superseded_by = NULL WHERE tx_to IS NULL AND attribute = '负责人'`);
    const { refreshAttributeKeys } = await import('../src/graph/claim-state-store.js');
    const { markSupersededClaims } = await import('../src/wiki/refine.js');
    await refreshAttributeKeys(ctx.store);
    await markSupersededClaims(ctx.store);
    const keys = await ctx.store.query<{ attribute: string; canonical: string }>(`SELECT attribute, canonical FROM claim_attribute_keys`);
    expect(keys).toEqual([{ attribute: '跟进人', canonical: '负责人' }]);
    const current = await ctx.store.query<{ statement: string }>(`SELECT statement FROM claims WHERE tx_to IS NULL AND attribute = '跟进人' AND superseded_by IS NULL`);
    expect(current.map((r) => r.statement)).toEqual(['R-07由钱博负责']);
  });
});

const ents = async (ctx: AppContext) => (await ctx.store.query<{ id: string; canonical_id: string | null }>(
  `SELECT id, canonical_id FROM entities WHERE tx_to IS NULL ORDER BY id`)).map((r) => (r.canonical_id ? `${r.id}→${r.canonical_id}` : r.id)).sort();
const subjects = async (ctx: AppContext) => (await ctx.store.query<{ subject: string; statement: string }>(
  `SELECT COALESCE(e.canonical_id, e.id) AS subject, c.statement FROM claims c JOIN entities e ON e.id = c.subject_id WHERE c.tx_to IS NULL`)).map((r) => `${r.subject}:${r.statement}`).sort();
const fm = (title: string, entities: string, claims = '') => `---\ntitle: ${title}\nentities:\n${entities}${claims ? `claims:\n${claims}` : ''}---\n${title}\n`;

describe('codes of one kind', () => {
  it('keeps apart only identifiers of one numbered series, and reads year and quarter forms as one', async () => {
    const { namesApartByCode } = await import('../src/graph/resolve.js');
    for (const [a, b] of [['X100', 'vivoX100'], ['GPT-4', 'ChatGPT-4'], ['CU2501', 'SHFE.CU2501'], ['24Q3', '2024Q3'], ['FY24', 'FY2024'], ['Model3', 'TeslaModel3'], ['H20', 'H100']]) {
      expect(namesApartByCode(a, b), `${a} / ${b}`).toBe(false);
    }
    for (const [a, b] of [['INC-001-T1', 'INC-005-T3'], ['INC-001-T1', 'INC-001-D2T1'], ['R-01', 'R-02']]) expect(namesApartByCode(a, b), `${a} / ${b}`).toBe(true);
  });

  it('lands a code on the entity that carries exactly that code', async () => {
    const ctx = await workspace('prefixed', {
      'raw/docs/a.md': fm('a', '  - { name: vivoX100, type: product, aliases: ["X100"] }\n  - { name: ChatGPT-4, type: product, aliases: ["GPT-4"] }\n  - { name: SHFE.CU2501, type: product, aliases: ["CU2501"] }\n'),
      'raw/docs/b.md': fm('b', '  - { name: X100, type: product }\n  - { name: GPT-4, type: product }\n  - { name: CU2501, type: product }\n'),
    });
    expect((await ents(ctx)).filter((e) => !['overview', 'wikilinks'].includes(e))).toEqual(['chatgpt-4', 'shfe.cu2501', 'vivox100'].sort());
  });

  it('lets a product code join the spelling it carries as an alias', async () => {
    const ctx = await workspace('h20', {
      'raw/docs/a.md': fm('a', '  - { name: H100, type: product }\n  - { name: Nvidia H20, type: product }\n'),
      'raw/docs/b.md': fm('b', '  - { name: H20, type: product, aliases: ["Nvidia H20"] }\n'),
    });
    expect((await ents(ctx)).filter((e) => /h20|h100/.test(e))).toEqual(['h100', 'nvidia-h20']);
  });
});

describe('the order documents arrive in', () => {
  const docs: Record<string, string> = {
    title: fm('复盘', '  - { name: 登录失败事故, type: event }\n', '  - { subject: 登录失败事故, statement: 登录失败事故复盘已完成, type: event }\n'),
    one: fm('事故一', '  - { name: INC-001-T1, type: event, aliases: ["登录失败事故"] }\n', '  - { subject: INC-001-T1, statement: INC-001-T1已由甲修复, type: event }\n'),
    five: fm('事故五', '  - { name: INC-005-T3, type: event, aliases: ["登录失败事故"] }\n', '  - { subject: INC-005-T3, statement: INC-005-T3已由乙修复, type: event }\n'),
  };
  it('decides nothing about which entity a title or an incident is', async () => {
    const outcomes = new Set<string>();
    for (const order of [['title', 'one', 'five'], ['one', 'title', 'five'], ['one', 'five', 'title'], ['five', 'title', 'one']]) {
      const files = Object.fromEntries(order.map((k, i) => [`raw/docs/${i}-${k}.md`, docs[k]]));
      const ctx = await workspace(`order-${order.join('-')}`, files);
      outcomes.add(JSON.stringify(await subjects(ctx)));
    }
    expect([...outcomes]).toEqual([JSON.stringify(['inc-001-t1:INC-001-T1已由甲修复', 'inc-005-t3:INC-005-T3已由乙修复', '登录失败事故:登录失败事故复盘已完成'])]);
  });
});

describe('a setting named by its code alone', () => {
  const report = (code: string) => fm('周报', `  - { name: 对账批次间隔, type: other, aliases: ["${code}", "批次间隔"] }\n`, '  - { subject: 对账批次间隔, statement: 对账批次间隔定为15分钟, type: other }\n');
  const alone = (code: string) => fm('周报', `  - { name: ${code}, type: other }\n`, `  - { subject: ${code}, statement: ${code}调整为20分钟, type: other }\n`);

  it('ends with the one entity that carries the code, whichever report came first (identity "name")', async () => {
    const { splitEntities } = await import('../src/graph/entity-context.js');
    const outcomes = new Set<string>();
    // another division's report first makes the setting an entity; the code alone then has no carrier yet
    for (const [name, files] of [
      ['code-first', { 'raw/docs/a.md': report('D2T2-C2'), 'raw/docs/b.md': alone('T2-C2'), 'raw/docs/c.md': report('T2-C2') }],
      ['code-after', { 'raw/docs/a.md': report('D2T2-C2'), 'raw/docs/b.md': report('T2-C2'), 'raw/docs/c.md': alone('T2-C2') }],
    ] as const) {
      const ctx = await workspace(`code-${name}`, files);
      await splitEntities(ctx.store, { config: ctx.config });
      // one entity holds both statements; which spelling's id it keeps is the first document's
      const bySubject = new Map<string, string[]>();
      for (const r of await subjects(ctx)) {
        const [subject, statement] = r.split(':');
        (bySubject.get(subject) ?? bySubject.set(subject, []).get(subject)!).push(statement);
      }
      outcomes.add(JSON.stringify([...bySubject.values()].map((v) => v.sort()).sort()));
    }
    expect([...outcomes]).toEqual([JSON.stringify([['T2-C2调整为20分钟', '对账批次间隔定为15分钟'].sort()])]);
  });

  it('joins the entity a coded split labelled with that code (identity "context")', async () => {
    const { enqueueTier1, runTier1Pass } = await import('../src/graph/tier1.js');
    const { resolveEntityContext } = await import('../src/graph/entity-context.js');
    const dataDir = path.join(tmp, 'coded-split');
    initDataDir(dataDir);
    const docs = new Map<string, { text: string; reply: { entities: unknown[]; relations: unknown[]; claims: unknown[] } }>();
    const setting = (code: string) => ({ name: '对账批次间隔', type: 'component', aliases: [code] });
    for (const [team, code, who] of [['支付组', 'T2-C2', '郭军'], ['二部支付组', 'D2T2-C2', '周洋']] as const) {
      for (const k of [1, 2]) {
        docs.set(`raw/docs/周报/${team}/w${k}.md`, {
          text: `# ${team}周报 第${k}周\n\n对账批次间隔（${code}）定为15分钟。${who}负责。\n`,
          reply: { entities: [{ name: team, type: 'organization', aliases: [] }, { name: who, type: 'person', aliases: [] }, setting(code)], relations: [{ source: who, target: team, type: 'member_of' }], claims: [] },
        });
      }
    }
    // the code alone, in a report of the second team
    docs.set('raw/docs/周报/二部支付组/w3.md', {
      text: '# 二部支付组周报 第3周\n\nD2T2-C2调整为20分钟。\n',
      reply: { entities: [{ name: '二部支付组', type: 'organization', aliases: [] }, { name: 'D2T2-C2', type: 'component', aliases: [] }], relations: [], claims: [{ subject: 'D2T2-C2', object: null, type: 'other', kind: 'fact', statement: 'D2T2-C2调整为20分钟', status: 'fact' }] },
    });
    for (const [p, d] of docs) {
      fs.mkdirSync(path.dirname(path.join(dataDir, p)), { recursive: true });
      fs.writeFileSync(path.join(dataDir, p), d.text);
    }
    const ctx = await createContext(dataDir);
    contexts.push(ctx);
    await sync(ctx, { llmGraph: false });
    for (const d of await ctx.store.query<{ id: string }>(`SELECT id FROM documents WHERE root = 'docs'`)) await enqueueTier1(ctx.store, d.id);
    (ctx.config.extraction as { entityLlm?: unknown }).entityLlm = undefined;
    const reply = (p: string) => docs.get(p)?.reply ?? { entities: [], relations: [], claims: [] };
    const completeJson = async (messages: { role: string; content: string }[]) => {
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      const batched = [...user.matchAll(/^=== Document (\d+): .* \((raw\/docs\/[^)]+)\) ===$/gm)];
      if (batched.length > 0) return { documents: batched.map((m) => ({ doc: Number(m[1]), ...reply(m[2]) })) };
      return reply(/Document: .* \((raw\/docs\/[^)]+)\)/.exec(user)?.[1] ?? '');
    };
    const llm = { enabled: true, label: 'stub@extract', provider: 'openai', model: 'stub', completeJson } as never;
    for (let i = 0; i < 10; i++) if ((await runTier1Pass(ctx.store, ctx.config, llm, { batchSize: 64 })).queued === 0) break;
    ctx.config.review.identity = 'context';
    await resolveEntityContext(ctx.store, { config: ctx.config });
    const [rule] = await ctx.store.query<{ id: string }>(`SELECT id FROM entity_namesakes WHERE label = 'D2T2-C2'`);
    expect(rule).toBeDefined();
    const [row] = await ctx.store.query<{ subject: string }>(
      `SELECT COALESCE(e.canonical_id, e.id) AS subject FROM claims c JOIN entities e ON e.id = c.subject_id WHERE c.tx_to IS NULL AND c.statement = 'D2T2-C2调整为20分钟'`,
    );
    expect(row.subject).toBe(rule.id);
  });
});

describe('back-references outside periodic reports', () => {
  const notes = {
    'raw/docs/feishu/某分析师/0303.md': dated('航空周观察', '2025-03-03', 'entities:\n  - { name: B737, type: product }\n  - { name: 波音, type: organization }\nclaims:\n  - { subject: B737, statement: B737交付延迟仍在持续, type: event }\n'),
    'raw/docs/feishu/某分析师/0310.md': dated('新能源车周观察', '2025-03-10', 'entities:\n  - { name: 王传福, type: person }\n  - { name: 比亚迪, type: organization }\nclaims:\n  - { subject: 王传福, statement: 上周的交付延迟已由王传福在业绩会上解释, type: event }\n  - { subject: 比亚迪, statement: 上周美联储宣布降息后比亚迪股价修复, type: market }\n'),
  };

  it('reads no reference into a sentence that states no fix, and links nothing in a folder that is not a series', async () => {
    const { backReference, linkBackReferences } = await import('../src/graph/backrefs.js');
    for (const s of ['上周美联储宣布降息', '上周的交付延迟已由王传福在业绩会上解释', '上周A股成交额下降', '上期分红已于6月派发', '由于上周暴雨，物流中断']) expect(backReference(s), s).toBeNull();
    const ctx = await workspace('analyst', notes);
    for (const backReferences of [{ detect: true }, { periodic: ['raw/docs/feishu'] }]) {
      const stats = await linkBackReferences(ctx.store, { config: { review: { ...ctx.config.review, backReferences } }, full: true });
      expect(stats.linked, JSON.stringify(backReferences)).toBe(0);
    }
    expect(await ctx.store.query(`SELECT 1 FROM scopes WHERE kind = 'backref'`)).toEqual([]);
  });

  it('tells a series of reports from a folder of notes', async () => {
    const { isSeries } = await import('../src/graph/backrefs.js');
    const weekly = [3, 10, 17, 24, 31].map((d, i) => ({ title: `平台组周报 · 第${10 + i}周`, date: `2025-03-${String(d).padStart(2, '0')}` }));
    expect(isSeries(weekly)).toBe(true);
    expect(isSeries(weekly.slice(0, 3))).toBe(false);
    expect(isSeries(weekly.map((w, i) => ({ ...w, title: ['航空周观察', '新能源车周观察', '半导体周观察', '银行周观察', '地产周观察'][i] })))).toBe(false);
    expect(isSeries(weekly.map((w, i) => ({ ...w, date: ['2025-03-03', '2025-03-04', '2025-03-20', '2025-03-21', '2025-04-30'][i] })))).toBe(false);
  });

  it('gives a link its fix sentence\'s document, passage, trust and acl, and disposes it with that document', async () => {
    const { linkBackReferences } = await import('../src/graph/backrefs.js');
    const report = (date: string, body: string, entities: string) => dated('平台组周报', date, `entities:\n${entities}`).replace(/\n平台组周报\n$/, `\n${body}\n`);
    const ctx = await workspace('attributed', {
      'raw/docs/周报/平台组/w05.md': report('2025-02-03', 'INC-001-T1（P1）缓存击穿', '  - { name: INC-001-T1, type: event }\nclaims:\n  - { subject: INC-001-T1, statement: INC-001-T1为P1级缓存击穿事故, type: event }\n'),
      'raw/docs/周报/平台组/w06.md': report('2025-02-10', '上周那起缓存击穿已由方杰修复', '  - { name: 方杰, type: person }\nclaims:\n  - { subject: 方杰, statement: 上周那起缓存击穿已由方杰修复, type: event }\n'),
    });
    const config = { review: { ...ctx.config.review, backReferences: { periodic: ['raw/docs/周报'] } } };
    expect((await linkBackReferences(ctx.store, { config })).linked).toBe(1);
    const [link] = await ctx.store.query<{ document_id: string | null; description: string; path: string }>(
      `SELECT r.document_id, r.description, d.path FROM relations r LEFT JOIN documents d ON d.id = r.document_id WHERE r.tx_to IS NULL AND r.target_id = 'inc-001-t1'`,
    );
    expect(link).toMatchObject({ path: 'raw/docs/周报/平台组/w06.md', description: '修复上一期报告的缓存击穿' });
    const [scope] = await ctx.store.query<{ trust: string; acl: unknown; parent_trust: string; parent_acl: unknown; parent_key: string }>(
      `SELECT s.trust, s.acl, p.trust AS parent_trust, p.acl AS parent_acl, p.key AS parent_key FROM scopes s JOIN scopes p ON p.id = s.parent_id WHERE s.kind = 'backref' AND s.status = 'active'`,
    );
    expect(scope).toMatchObject({ parent_key: 'raw/docs/周报/平台组/w06.md', trust: scope.parent_trust, acl: scope.parent_acl });
    // the fix report removed: the link goes with it, no refine needed
    fs.rmSync(path.join(ctx.dataDir, 'raw/docs/周报/平台组/w06.md'));
    await sync(ctx, { llmGraph: false });
    expect(await ctx.store.query(`SELECT 1 FROM relations WHERE tx_to IS NULL AND target_id = 'inc-001-t1'`)).toEqual([]);
    expect(await ctx.store.query(`SELECT 1 FROM scopes WHERE kind = 'backref' AND status = 'active'`)).toEqual([]);
  });
});

describe('owner and state claims the model gave no object', () => {
  it('keeps statements about different things apart, and the subject\'s own owner one series', async () => {
    const ctx = await workspace('no-object', {
      'raw/docs/a.md': dated('a', '2025-03-10', 'entities:\n  - { name: 比亚迪, type: organization }\nclaims:\n  - { subject: 比亚迪, statement: 云业务由张三负责, type: other }\n  - { subject: 比亚迪, statement: 比亚迪负责人为王传福, type: other }\n'),
      'raw/docs/b.md': dated('b', '2025-03-17', 'entities:\n  - { name: 比亚迪, type: organization }\nclaims:\n  - { subject: 比亚迪, statement: 电池业务由李四负责, type: other }\n  - { subject: 比亚迪, statement: 比亚迪的负责人是王传福和李柯, type: other }\n'),
    });
    await refreshClaimState(ctx.store);
    const rows = await ctx.store.query<{ statement: string; current: boolean }>(
      `SELECT statement, superseded_by IS NULL AS current FROM claims WHERE tx_to IS NULL AND attribute IS NOT NULL`,
    );
    const current = rows.filter((r) => r.current).map((r) => r.statement).sort();
    // each business keeps its owner; the company's own owner is one series
    expect(current).toEqual(['云业务由张三负责', '电池业务由李四负责', '比亚迪的负责人是王传福和李柯'].sort());
  });

  it('reads what an owner or state statement is about', async () => {
    const { statementObject } = await import('../src/graph/claim-state.js');
    expect(statementObject('云业务由张三负责', '负责人', ['比亚迪'])).toBe('云业务');
    expect(statementObject('比亚迪云业务由张三负责。', '负责人', ['比亚迪'])).toBe('云业务');
    expect(statementObject('R-03由赖艳负责', '负责人', ['R-03'])).toBe('');
    expect(statementObject('风险R-54由陈强南乔负责。', '负责人', ['R-54'])).toBe('');
    expect(statementObject('风险R-118的负责人是方平。', '负责人', ['R-118'])).toBe('');
    expect(statementObject('R-59正在跟进，负责人为叶超', '负责人', ['R-59'])).toBe('');
    expect(statementObject('Atlas负责人是廖欣', '负责人', ['Orion', 'Atlas'])).toBe('');
    expect(statementObject('比亚迪半导体业务上市状态为审核中', '状态', ['比亚迪'])).toBe('半导体业务上市');
    expect(statementObject('R-03状态为已关闭', '状态', ['R-03'])).toBe('');
  });
});

describe('back-reference links that no longer hold', () => {
  const rep = (date: string, fm: string) => dated('平台组周报', date, fm);
  const docs = {
    'raw/docs/周报/平台组/w05.md': rep('2025-02-03', 'entities:\n  - { name: INC-001-T1, type: event }\nclaims:\n  - { subject: INC-001-T1, statement: INC-001-T1为P1级支付超时事故, type: event }\n'),
    'raw/docs/周报/平台组/w06.md': rep('2025-02-10', 'entities:\n  - { name: 方杰, type: person }\nclaims:\n  - { subject: 方杰, statement: 上周那起支付超时已由方杰修复, type: event }\n'),
  };
  const linked = async (ctx: AppContext) => (await ctx.store.query(`SELECT 1 FROM relations WHERE tx_to IS NULL AND target_id = 'inc-001-t1'`)).length;

  it('goes with the earlier report it was resolved from, in an incremental run', async () => {
    const { linkBackReferences } = await import('../src/graph/backrefs.js');
    const ctx = await workspace('stale-previous', docs);
    const config = { review: { ...ctx.config.review, backReferences: { periodic: ['raw/docs/周报'] } } };
    expect((await linkBackReferences(ctx.store, { config })).linked).toBe(1);
    fs.rmSync(path.join(ctx.dataDir, 'raw/docs/周报/平台组/w05.md'));
    await sync(ctx, { llmGraph: false });
    expect(await linkBackReferences(ctx.store, { config })).toMatchObject({ disposed: 1, linked: 0 });
    expect(await linked(ctx)).toBe(0);
  });

  it('goes when the workspace turns the step off', async () => {
    const { linkBackReferences } = await import('../src/graph/backrefs.js');
    const ctx = await workspace('stale-off', docs);
    const config = { review: { ...ctx.config.review, backReferences: { periodic: ['raw/docs/周报'] } } };
    expect((await linkBackReferences(ctx.store, { config })).linked).toBe(1);
    expect(await linkBackReferences(ctx.store, { config: { review: { ...ctx.config.review } } })).toMatchObject({ disposed: 1 });
    expect(await linked(ctx)).toBe(0);
    // and a folder no longer listed loses its links the same way
    expect((await linkBackReferences(ctx.store, { config, full: true })).linked).toBe(1);
    expect(await linkBackReferences(ctx.store, { config: { review: { ...ctx.config.review, backReferences: { periodic: ['raw/docs/月报'] } } } })).toMatchObject({ disposed: 1 });
    expect(await linked(ctx)).toBe(0);
  });
});

describe('who a back-reference credits', () => {
  it('reads the fixer from the sentence, and 上期 only as a word', async () => {
    const { fixerSpans, backReference } = await import('../src/graph/backrefs.js');
    expect(fixerSpans('上周那起缓存击穿已由方杰修复，根因是参数填反了')).toContain('方杰');
    expect(fixerSpans('方杰已修复上周发生的配置下发失败。')).toContain('方杰');
    expect(fixerSpans('叶敏已修复2025年6月2日至6月8日发生的推送重复事故')).toContain('叶敏');
    expect(fixerSpans("Last week's cache stampede was fixed by Fang Jie")).toContain('Fang Jie');
    expect(fixerSpans('上周那起支付超时已修复，客户张三确认')).not.toContain('张三');
    expect(backReference('王五称上期所的铜库存问题已解决')).toBeNull();
    expect(backReference('上期那起缓存击穿已由方杰修复')?.term).toBe('缓存击穿');
  });

  it('links only the person who did the fixing', async () => {
    const { linkBackReferences } = await import('../src/graph/backrefs.js');
    const rep = (date: string, fm: string) => dated('平台组周报', date, fm);
    const ctx = await workspace('fixer', {
      'raw/docs/周报/平台组/w05.md': rep('2025-02-03', 'entities:\n  - { name: INC-001-T1, type: event }\nclaims:\n  - { subject: INC-001-T1, statement: INC-001-T1为P1级支付超时事故, type: event }\n'),
      'raw/docs/周报/平台组/w06.md': rep('2025-02-10', 'entities:\n  - { name: 张三, type: person }\n  - { name: 客服部, type: organization }\nclaims:\n  - { subject: 客服部, statement: 上周那起支付超时已修复，客户张三确认, type: event }\n'),
    });
    const config = { review: { ...ctx.config.review, backReferences: { periodic: ['raw/docs/周报'] } } };
    expect((await linkBackReferences(ctx.store, { config })).linked).toBe(0);
    expect(await ctx.store.query(`SELECT 1 FROM relations WHERE tx_to IS NULL AND target_id = 'inc-001-t1'`)).toEqual([]);
  });
});

describe('an identifier written without its tail', () => {
  it('is not kept apart from the same counter with a tail, and other counters or tails still are', async () => {
    const { namesApartByCode } = await import('../src/graph/resolve.js');
    expect(namesApartByCode('INC-006', 'INC-006-T1')).toBe(false);
    expect(namesApartByCode('R-07', 'R-7')).toBe(false);
    expect(namesApartByCode('INC-006-T1', 'INC-006-D2T1')).toBe(true);
    expect(namesApartByCode('INC-006', 'INC-007-T1')).toBe(true);
  });

  it('lands on the incident that carries the short form', async () => {
    const ctx = await workspace('short-id', {
      'raw/docs/a.md': fm('a', '  - { name: INC-006-T1, type: event, aliases: ["INC-006"] }\n'),
      'raw/docs/b.md': fm('b', '  - { name: INC-006, type: event }\n', '  - { subject: INC-006, statement: INC-006已由方杰修复, type: event }\n'),
    });
    const [row] = await ctx.store.query<{ subject_id: string }>(`SELECT subject_id FROM claims WHERE tx_to IS NULL AND statement = 'INC-006已由方杰修复'`);
    expect(row.subject_id).toBe('inc-006-t1');
  });
});

describe('what refine does without anyone asking, in bounded steps', () => {
  it('keeps keys and supersession current a slice of subjects at a time, ending where a whole run ends', async () => {
    const { refreshClaimStateStep, refreshAttributeKeys, supersedeByAttribute } = await import('../src/graph/claim-state-store.js');
    const docs: Record<string, string> = {};
    for (const [k, date] of [[1, '2025-03-03'], [2, '2025-03-10']] as const) {
      docs[`raw/docs/w${k}.md`] = dated(`周报${k}`, date, `entities:\n${['甲项目', '乙项目', '丙项目', '丁项目'].map((p) => `  - { name: ${p}, type: project }`).join('\n')}\nclaims:\n${['甲项目', '乙项目', '丙项目', '丁项目'].map((p, i) => `  - { subject: ${p}, statement: ${p}${k === 1 ? '完成度' : '进度'}为${10 * k + i}%, type: other }`).join('\n')}\n`);
    }
    const ctx = await workspace('step', docs);
    const snapshot = async () => JSON.stringify([
      (await ctx.store.query<{ s: string }>(`SELECT subject_id || ':' || attribute || '→' || canonical AS s FROM claim_attribute_keys`)).map((r) => r.s).sort(),
      (await ctx.store.query<{ s: string }>(`SELECT statement || ':' || (superseded_by IS NULL)::text AS s FROM claims WHERE tx_to IS NULL`)).map((r) => r.s).sort(),
    ]);
    await refreshAttributeKeys(ctx.store);
    await supersedeByAttribute(ctx.store);
    const whole = await snapshot();
    await ctx.store.query(`DELETE FROM claim_attribute_keys`);
    await ctx.store.query(`UPDATE claims SET superseded_by = NULL`);
    // two keyed claims a slice: one subject a run, four runs, the cursor kept between them
    const runs = [];
    for (let i = 0; i < 6; i++) {
      const r = await refreshClaimStateStep(ctx.store, { budget: 2 });
      runs.push(r.subjects);
      if (r.passDone) break;
    }
    expect(runs).toEqual([1, 1, 1, 1]);
    expect(await snapshot()).toBe(whole);
  });

  it('reads code-named entities for a carrier a bounded number a run, from a cursor', async () => {
    const { splitEntities } = await import('../src/graph/entity-context.js');
    const ctx = await workspace('code-step', {
      'raw/docs/a.md': fm('a', ['A1-C1', 'A1-C2', 'A1-C3'].map((c) => `  - { name: ${c}, type: other }`).join('\n') + '\n'),
      'raw/docs/b.md': fm('b', ['甲', '乙', '丙'].map((x) => `  - { name: 设置${x}, type: other }`).join('\n') + '\n'),
    });
    // as a workspace holds them when the code came first and the carrier learnt the code later: the code an alias of the carrier
    const { nameKey } = await import('../src/graph/normalize.js');
    for (const i of [0, 1, 2]) {
      const id = `设置${'甲乙丙'[i]}`;
      await ctx.store.query(`UPDATE entities SET aliases = jsonb_build_array($2::text) WHERE id = $1`, [id, `A1-C${i + 1}`]);
      await ctx.store.query(`INSERT INTO entity_alias_keys (entity_id, alias_key, kind) VALUES ($1, $2, 'exact') ON CONFLICT DO NOTHING`, [id, nameKey(`A1-C${i + 1}`).key]);
    }
    const merged = async () => (await ctx.store.query(`SELECT 1 FROM entities WHERE canonical_id IS NOT NULL AND tx_to IS NULL`)).length;
    const cursor = async () => (await ctx.store.getMeta<{ after?: string }>('code_merge_pass'))?.after ?? null;
    await splitEntities(ctx.store, { config: ctx.config, codeMergeStep: 2 });
    expect(await merged()).toBe(2);
    expect(await cursor()).toBe('a1-c2');
    await splitEntities(ctx.store, { config: ctx.config, codeMergeStep: 2 });
    expect(await merged()).toBe(3);
    expect(await cursor()).toBeNull();
  });
});
