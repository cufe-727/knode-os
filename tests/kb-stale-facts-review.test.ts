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
    expect(await pairs([['基准利率', 5, '%'], ['利率', 3, '%']], '美联储', ['联邦基金利率', 'Fed'])).toEqual([]);
  });

  it('keeps a key that contains another apart, and value words apart under a subject without a code', async () => {
    expect(await pairs([['股价', 5, '美元'], ['基准情景终点股价', 2, '美元']], '英伟达')).toEqual([]);
    expect(await pairs([['首席执行官', 5, ''], ['临时首席执行官', 2, '']], '英伟达')).toEqual([]);
    expect(await pairs([['h股 年内相对收益', 2, '%'], ['a股 年内相对收益', 2, '%']], '银行')).toEqual([]);
    expect(await pairs([['配置', 5, '%'], ['仓位', 9, '%'], ['当前值', 2, '%'], ['设置', 1, '%']], '某基金')).toEqual([]);
  });

  it('still joins one measure spelled two ways, and the keys that name a coded setting', async () => {
    expect(await pairs([['周活跃用户', 10, '万'], ['周活跃用户数', 3, '万']], '增长组')).toEqual(['周活跃用户数→周活跃用户']);
    expect(await pairs([['批次间隔', 1, '分钟'], ['间隔', 9, '分钟'], ['配置值', 1, '分钟'], ['初始间隔', 14, '分钟']], '对账批次间隔（第一事业部支付组 · T2-C2）', ['T2-C2']))
      .toEqual(['批次间隔→间隔', '配置值→间隔']);
    // an entity named by its code: its name is among its aliases
    expect(await pairs([['阈值', 1, '毫秒'], ['超时阈值', 1, '毫秒'], ['配置值', 1, '毫秒']], 'T1-C3', ['核心接口超时阈值', '超时线'])).toEqual(['超时阈值→阈值', '配置值→阈值']);
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
