import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { ALIAS_SUGGESTIONS_PER_RUN, renameIn, resolveEntityContext } from '../src/graph/entity-context.js';
import { RawExtractReply } from '../src/graph/llm-extract.js';
import { enqueueTier1, runTier1Pass } from '../src/graph/tier1.js';
import { sync } from '../src/ingest/sync.js';
import { LlmClient } from '../src/llm/client.js';

/**
 * The rename rule (docs/design/29 §5) against the statements it merged on a
 * copy of the finance workspace on 2026-11-13: 39 merges, most of them wrong.
 * Each case is one of those statements with the entities finance held for it
 * (name, type, the aliases that mattered), the claim's subject and object as
 * extraction filed them, and the merge the rule made then.
 */

type Ent = [name: string, type: string, aliases?: string[]];
interface Case {
  statement: string;
  subject: string;
  object?: string;
  entities: Ent[];
  /** What the rule merged on 2026-11-13: old name → new name. */
  was: [string, string];
  /** Whether that merge is the rename the statement states. */
  right?: true;
  /** The statement does name this old name; the new name it gives is no entity's own. */
  newNameIsAlias?: true;
}

const org = (name: string, aliases: string[] = []): Ent => [name, 'organization', aliases];
const product = (name: string, aliases: string[] = []): Ent => [name, 'product', aliases];

const CASES: Case[] = [
  // no old name where the renamed thing stands: the longest live name anywhere before the marker was taken
  { statement: '乐聚（深圳）机器人技术有限公司向合作伙伴公告，因经营管理及战略发展需要，更名为乐聚智能（深圳）股份有限公司。', subject: '乐聚机器人', entities: [org('发展'), org('乐聚机器人', ['乐聚智能', '乐聚（深圳）机器人技术有限公司'])], was: ['发展', '乐聚机器人'] },
  { statement: '黄乐接手一家新加坡公司后将其改名为Megaspeed，并将业务转型为云服务。', subject: '黄乐', object: 'Megaspeed', entities: [org('公司'), org('Megaspeed'), ['黄乐', 'person']], was: ['公司', 'Megaspeed'] },
  { statement: '华融国际信托后更名为兴宝国际信托，所持股份于2022年全部出售。', subject: '华融国际信托', entities: [org('国际'), org('华融国际信托', ['兴宝国际信托'])], was: ['国际', '华融国际信托'] },
  { statement: '文中称原名Facebook的上市公司于2021年10月28日正式更名为Meta Platforms。', subject: 'META', entities: [org('上市公司'), org('META', ['Meta Platforms', 'Facebook Inc.'])], was: ['上市公司', 'META'] },
  { statement: '管我财称昱辉阳光已更名为瑞能新能源。', subject: '瑞能新能源', entities: [org('阳光'), org('瑞能新能源')], was: ['阳光', '瑞能新能源'] },
  { statement: '手机淘宝在2021年中更名为淘宝。', subject: '淘宝', entities: [product('手机'), product('淘宝', ['手机淘宝', 'Taobao'])], was: ['手机', '淘宝'] },
  { statement: '每日量化报告中的强势股票池已改名为新高，并新增启动股票池；同时满足启动与新高条件的股票会出现在两个池中。', subject: '股票池', object: '股票池', entities: [product('股票池'), product('新高')], was: ['股票池', '新高'] },
  { statement: 'SpaceX将星链直连手机服务更名为Starlink Mobile。', subject: 'SpaceX', entities: [product('space'), product('Starlink'), org('SpaceX')], was: ['space', 'Starlink'] },
  { statement: 'Polygon.io rebranded as Massive.com on October 30, 2025.', subject: 'Massive', entities: [org('IO'), org('Massive', ['Massive.com', 'Polygon.io'])], was: ['IO', 'Massive'] },
  { statement: '华融金控后更名为信控国际。', subject: '华融金控', entities: [org('华融'), org('华融金控', ['信控国际'])], was: ['华融', '华融金控'] },
  { statement: '新光海航人寿后来更名为鼎诚人寿。', subject: '鼎诚人寿', entities: [org('海航'), org('鼎诚人寿')], was: ['海航', '鼎诚人寿'] },
  { statement: '恒生指数公司于2025年12月11日公告，相关指数将于12月16日更名为恒生港股通软件主题指数，成分股总数仍维持32只。', subject: '恒生港股通软件主题指数', entities: [product('公告'), product('恒生港股通软件主题指数')], was: ['公告', '恒生港股通软件主题指数'] },
  { statement: '湖北长江世禹芯玑半导体于2026年6月30日更名为东阳世芯半导体，注册地迁入东阳画水新能源半导体产业园，并新增半导体设备制造、封装测试及新材料研发经营范围。', subject: '长江半导体', entities: [org('芯玑半导体', ['芯玑（东阳）半导体']), org('长江半导体', ['东阳世芯半导体', '湖北长江世禹芯玑半导体有限公司'])], was: ['芯玑半导体', '长江半导体'] },
  { statement: '截至2023年10月10日，乐凯新材准备更名为航天智造。', subject: '乐凯新材', entities: [org('乐凯'), org('乐凯新材', ['航天智造'])], was: ['乐凯', '乐凯新材'] },
  { statement: 'Salesforce将旗下多款核心产品纳入Agentforce品牌，并将Sales Cloud更名为Agentforce Sales。', subject: 'Salesforce', object: 'Agentforce', entities: [product('CLO'), product('Agentforce'), org('Salesforce')], was: ['CLO', 'Agentforce'] },
  // a subsidiary, a product or a brand of the entity named first is what was renamed
  { statement: '甲骨文在2025年末将其数据库更名为Oracle AI Database。', subject: '甲骨文', entities: [org('甲骨文'), org('Oracle')], was: ['甲骨文', 'Oracle'] },
  { statement: '大族激光于2022年成立独立运营子公司布局3D打印业务，该子公司于2024年更名为大族聚维。', subject: '大族激光', object: '大族聚维', entities: [org('大族激光'), org('大族聚维')], was: ['大族激光', '大族聚维'] },
  { statement: '据彭博报道，马斯克计划解散xAI作为独立公司并将其更名为SpaceXAI。', subject: '马斯克', object: 'xAI', entities: [org('xAI'), org('SpaceXAI', ['SpaceXSI']), ['马斯克', 'person']], was: ['xAI', 'SpaceXAI'] },
  { statement: '星星奶爸称赛力斯最近将蓝电品牌更名为赛豆。', subject: '赛豆', entities: [org('赛力斯'), org('赛豆')], was: ['赛力斯', '赛豆'] },
  { statement: '东芝存储器于2019年更名为铠侠，并于2024年12月在东京证券交易所Prime市场上市。', subject: '铠侠', entities: [org('东芝'), org('铠侠', ['Kioxia'])], was: ['东芝', '铠侠'] },
  { statement: '中际旭创前身中际装备于2016年底宣布以28亿元收购苏州旭创100%股权，并于2017年更名为中际旭创。', subject: '中际旭创', object: '苏州旭创', entities: [org('苏州旭创'), org('中际旭创')], was: ['苏州旭创', '中际旭创'] },
  { statement: '中信金融资产于2022年将所持华融消费金融全部70%股权转让给宁波银行；华融消费金融后更名为宁银消费金融。', subject: '中信金融资产', object: '华融消费金融', entities: [org('中信金融资产'), org('华融消费金融', ['宁银消费金融'])], was: ['中信金融资产', '华融消费金融'] },
  { statement: '2019年8月洲际交易所从美国银行收购MOVE指数及相关固定收益波动率指数系列，并更名为ICE BofA MOVE Index。', subject: '洲际交易所', entities: [org('洲际交易所'), org('ICE')], was: ['洲际交易所', 'ICE'] },
  { statement: '第七大道于2023年出售新加坡子公司7Road International全部股权，由Huang Le Limited收购，后者所收购公司随后更名为Megaspeed。', subject: '第七大道', object: 'Megaspeed', entities: [org('Huang Le Limited'), org('Megaspeed'), org('第七大道')], was: ['Huang Le Limited', 'Megaspeed'] },
  { statement: '江波龙苏州购买力成苏州70%股权，2023年9月底完成交割，标的随后更名为元成苏州，并自2023年10月1日起纳入江波龙合并报表。', subject: '江波龙苏州', object: '元成苏州', entities: [org('江波龙苏州'), org('元成苏州'), org('标的')], was: ['江波龙苏州', '元成苏州'] },
  // a rename that is planned or announced has not happened: the old name is still the name
  { statement: '马斯克于2026年10月4日表示SpaceXAI将改名为SpaceXSI。', subject: 'SpaceXSI公司', entities: [org('SpaceXAI', ['SpaceXSI']), org('SpaceXSI公司')], was: ['SpaceXAI', 'SpaceXSI公司'] },
  { statement: '龙净环保拟更名为紫金龙净。', subject: '龙净环保', entities: [org('龙净环保'), org('紫金龙净')], was: ['龙净环保', '紫金龙净'] },
  { statement: '青松股份拟更名为诺斯贝尔，并拟以4.34元每股向不超过193名董事、高管及核心员工授予不超过7815万份员工持股份额。', subject: '青松股份', entities: [org('青松股份'), org('诺斯贝尔')], was: ['青松股份', '诺斯贝尔'] },
  { statement: '巴里克黄金宣布计划更名为巴里克矿业公司，以反映其日益增长的铜投资。', subject: '巴里克黄金', entities: [org('巴里克黄金'), org('巴里克矿业')], was: ['巴里克黄金', '巴里克矿业'] },
  // the new name is only an alias of the entity it found, or the old name only part of what is written
  { statement: '海联讯已更名为汽轮科技。', subject: '海联', entities: [org('海联讯'), org('海联', ['汽轮科技'])], was: ['海联讯', '海联'], newNameIsAlias: true },
  { statement: '阿里通义更名为Qwen。', subject: '通义', object: '阿里', entities: [product('通义'), product('Qwen'), org('阿里')], was: ['通义', 'Qwen'] },
  // the renames the statements do state
  { statement: '群聊参与者称隆基股份已更名为隆基绿能。', subject: '隆基绿能', entities: [org('隆基', ['lg']), org('隆基绿能', ['LONGI'])], was: ['隆基', '隆基绿能'], right: true },
  { statement: '文中称Clawdbot现已更名为OpenClaw。', subject: 'OpenClaw', entities: [product('Clawdbot'), product('OpenClaw', ['Moltbot'])], was: ['Clawdbot', 'OpenClaw'], right: true },
  { statement: '2025年11月16日的评论称，阿里巴巴的通义千问已经改名为千问。', subject: '千问', entities: [product('通义千问'), product('千问', ['千问APP']), org('阿里巴巴')], was: ['通义千问', '千问'], right: true },
  { statement: '竞价打板承接模式更名为竞价抢筹盘口，优化后的布局在集合竞价阶段完成，取消了打板确认和盘中分时承接力判断。', subject: '竞价抢筹盘口', entities: [product('竞价打板承接模式'), product('竞价抢筹盘口')], was: ['竞价打板承接模式', '竞价抢筹盘口'], right: true },
  { statement: '先导科技集团于2024年入主万业企业，万业企业后更名为先导基电。', subject: '先导集团', object: '先导基电', entities: [org('万业企业'), org('先导基电'), org('先导集团', ['先导科技集团'])], was: ['万业企业', '先导基电'], right: true },
  { statement: '文中称花王股份正式更名为顺景科技，并取得苏驼通讯51%股份，进入800G光模块业务。', subject: '顺景科技', entities: [org('花王股份'), org('顺景科技')], was: ['花王股份', '顺景科技'], right: true },
];

describe('reading a rename', () => {
  it('takes the old name from where the renamed thing stands, never a name that merely occurs before the marker', () => {
    for (const c of CASES) {
      const r = renameIn(c.statement);
      expect(r, c.statement).not.toBeNull();
      if (c.right || c.newNameIsAlias) continue;
      // what was merged is not what the statement names: no reading of the old name is that entity's name
      expect(r!.old, c.statement).not.toContain(c.was[0]);
    }
    expect(renameIn('群聊参与者称隆基股份已更名为隆基绿能。')!.old).toContain('隆基股份');
    expect(renameIn('2025年11月16日的评论称，阿里巴巴的通义千问已经改名为千问。')!.old).toContain('通义千问');
    expect(renameIn('先导科技集团于2024年入主万业企业，万业企业后更名为先导基电。')!.old).toEqual(['万业企业后', '万业企业']);
    expect(renameIn('星星奶爸称赛力斯最近将蓝电品牌更名为赛豆。')!.old).toContain('蓝电品牌');
    expect(renameIn('英特尔将Crescent Island更名为D-Series GPU并聚焦推理场景。')).toMatchObject({ old: expect.arrayContaining(['Crescent Island']), renamed: ['D-Series GPU'] });
  });

  it('reads the whole new name', () => {
    expect(renameIn('甲骨文在2025年末将其数据库更名为Oracle AI Database。')!.renamed).toEqual(['Oracle AI Database']);
    expect(renameIn('SpaceX将星链直连手机服务更名为Starlink Mobile。')!.renamed).toEqual(['Starlink Mobile']);
    expect(renameIn('文中称澳大利亚天然气成本缺乏优势，Incitec Pivot已更名为Dyno Nobel并转向矿山炸药业务。')).toMatchObject({ old: expect.arrayContaining(['Incitec Pivot']), renamed: ['Dyno Nobel'] });
    expect(renameIn('阿里影业更名为大麦娱乐后，逐步将业务重心转向大麦票务平台。')!.renamed).toEqual(['大麦娱乐后', '大麦娱乐']);
    expect(renameIn('中航电测更名为中航成飞的事项已获董事会审议通过。')!.renamed).toContain('中航成飞');
    expect(renameIn('特朗普宣布自2026年8月28日起将安大略湖更名为“美国湖”，并签署相关行政令。')!.renamed).toEqual(['美国湖']);
    expect(renameIn('The Atlas project was renamed to Orion Platform in week 20.')).toMatchObject({ old: expect.arrayContaining(['Atlas']), renamed: ['Orion Platform', 'Orion'] });
  });

  it('leaves out a rename that is planned, proposed or denied', () => {
    const unsettled = [
      ['龙净环保拟更名为紫金龙净。', '龙净环保'],
      ['天山股份拟更名为天山材料，以体现产业链延伸发展及全国性布局战略。', '天山股份'],
      ['马斯克确认将把SpaceXAI更名为SpaceXSI。', 'SpaceXAI'],
      ['相关指数将于12月16日更名为恒生港股通软件主题指数。', '相关指数'],
      ['HIS1963于2017年9月16日强烈建议将格力电器更名为“中国格力”。', '格力电器'],
      ['特朗普誓言将墨西哥湾更名为美国湾，并重申对墨西哥和加拿大征收巨额关税的承诺。', '墨西哥湾'],
      ['Motiv Space Systems计划更名为Rocket Lab Robotics。', 'Motiv Space Systems'],
      ['腾讯云计划自2026年5月15日起调整计费，将企业旗舰版更名为SaaS企业版并从78元涨至198元。', '企业旗舰版'],
      ['京城机电股份尚未更名为京城智造。', '京城机电股份'],
      ['The Claude Code SDK will be renamed to Agent SDK.', 'Claude Code SDK'],
    ];
    for (const [statement, name] of unsettled) {
      const r = renameIn(statement)!;
      expect(r.planned, statement).toBe(true);
      expect(r.old, statement).not.toContain(name);
    }
    // 将 before the thing renamed is no future
    expect(renameIn('特斯拉中国将FSD更名为特斯拉辅助驾驶。')).toMatchObject({ planned: false, old: expect.arrayContaining(['FSD']) });
  });

  it('keeps the forms the reports pack writes', () => {
    expect(renameIn('Atlas项目自2025-02-05所在周起更名为Orion')).toMatchObject({ old: expect.arrayContaining(['Atlas']), renamed: ['Orion'], planned: false });
    expect(renameIn('结算中台（原项目名结算平台，自本周起改名为天秤）完成度54%')).toMatchObject({ old: ['结算平台', '结算'], renamed: ['天秤'] });
    expect(renameIn('推荐系统改版自本周起更名为千人千面')).toMatchObject({ old: expect.arrayContaining(['推荐系统改版']), renamed: ['千人千面'] });
    expect(renameIn('易达出行自第30周起更名为易达科技。')).toMatchObject({ old: expect.arrayContaining(['易达出行']), renamed: ['易达科技'] });
    expect(renameIn('Orion（原Atlas）完成度为64%')).toMatchObject({ old: ['Atlas'], renamed: ['Orion'] });
    expect(renameIn('Swift Labs, formerly Swift Mobility, escalated a P1')).toMatchObject({ old: ['Swift Mobility'], renamed: ['Swift Labs'] });
  });
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-rename-rule-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** One document per case: the statement as its text, and the extraction finance had for it. */
function fixture(): Map<string, { text: string; reply: RawExtractReply }> {
  const out = new Map<string, { text: string; reply: RawExtractReply }>();
  CASES.forEach((c, i) => {
    out.set(`raw/docs/finance/${String(i + 1).padStart(2, '0')}.md`, {
      text: `# 摘录 ${i + 1}\n\n${c.statement}\n\n提到：${c.entities.map(([name]) => name).join('、')}。\n`,
      reply: {
        entities: c.entities.map(([name, type, aliases]) => ({ name, type, aliases: aliases ?? [] })),
        relations: [],
        claims: [{ subject: c.subject, ...(c.object ? { object: c.object } : {}), statement: c.statement, type: 'event', status: 'fact', kind: 'fact' }],
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

describe('the rename rule on the finance statements', () => {
  let ctx: AppContext | undefined;
  afterAll(async () => {
    await ctx?.store.close();
  });

  it('merges the renames the statements state and none of the others', async () => {
    const dataDir = path.join(tmp, 'finance');
    initDataDir(dataDir);
    const docs = fixture();
    for (const [p, d] of docs) {
      fs.mkdirSync(path.dirname(path.join(dataDir, p)), { recursive: true });
      fs.writeFileSync(path.join(dataDir, p), d.text);
    }
    ctx = await createContext(dataDir);
    const store = ctx.store;
    await sync(ctx, { llmGraph: false });
    for (const d of await store.query<{ id: string }>(`SELECT id FROM documents WHERE root = 'docs'`)) await enqueueTier1(store, d.id);
    (ctx.config.extraction as { entityLlm?: unknown }).entityLlm = undefined;
    const llm = stubExtractor(docs);
    for (let i = 0; i < 10; i++) if ((await runTier1Pass(store, ctx.config, llm, { batchSize: 64 })).queued === 0) break;

    // the fixture stands as finance did: every entity a case names is live under that name, with a specific type
    const live = await store.query<{ name: string; type: string }>(`SELECT name, type FROM entities WHERE tx_to IS NULL AND canonical_id IS NULL`);
    const typeOf = new Map(live.map((e) => [e.name, e.type]));
    for (const c of CASES) for (const [name, type] of c.entities) expect(typeOf.get(name), `${name} in 「${c.statement}」`).toBe(type);
    const claims = await store.query<{ statement: string }>(`SELECT statement FROM claims WHERE tx_to IS NULL AND status = 'fact'`);
    expect(new Set(claims.map((c) => c.statement))).toEqual(new Set(CASES.map((c) => c.statement)));

    const messages: string[] = [];
    const stats = await resolveEntityContext(store, { config: ctx.config, onProgress: (m) => messages.push(m) });
    const merged = await store.query<{ old: string; new: string; reason: string }>(
      `SELECT e.name AS old, c.name AS new, l.reason FROM entities e JOIN entities c ON c.id = e.canonical_id
       JOIN entity_links l ON l.entity_id = e.id AND l.tx_to IS NULL WHERE e.tx_to IS NULL ORDER BY e.name`,
    );
    const right = CASES.filter((c) => c.right).map((c) => c.was.join(' → ')).sort();
    expect(merged.map((m) => `${m.old} → ${m.new}`).sort()).toEqual(right);
    expect(stats.merged).toBe(right.length);
    for (const m of merged) expect(m.reason).toContain('更名：「');
    // a second run decides nothing new
    expect((await resolveEntityContext(store, { config: ctx.config })).merged).toBe(0);
  }, 240_000);

  it('files alias suggestions the likeliest first, a bounded number a run, and none for a weak alias', async () => {
    const store = ctx!.store;
    const before = (await store.query<{ n: number }>(`SELECT count(*)::int AS n FROM suggestions WHERE kind = 'merge'`))[0].n;
    // 70 pairs: 甲k lists 乙k among its aliases; the last five list each other; one alias is two Latin letters
    const pairs = Array.from({ length: 70 }, (_, k) => ({ a: `甲方实体${k}`, b: `乙方实体${k}`, mentions: 10 + k, mutual: k >= 65 }));
    for (const p of pairs) {
      await store.query(
        `INSERT INTO entities (id, name, type, name_key, aliases, mention_count) VALUES ($1, $1, 'organization', $1, $2::jsonb, $5), ($3, $3, 'organization', $3, $4::jsonb, $5)`,
        [p.a, JSON.stringify([p.b]), p.b, JSON.stringify(p.mutual ? [p.a] : []), p.mentions],
      );
    }
    await store.query(`INSERT INTO entities (id, name, type, name_key, aliases, mention_count) VALUES ('长名实体', '长名实体', 'organization', '长名实体', '["QZ"]'::jsonb, 9000), ('qz', 'QZ', 'organization', 'qz', '[]'::jsonb, 9000)`);

    const first = await resolveEntityContext(store, { config: ctx!.config });
    expect(first.suggested).toBe(ALIAS_SUGGESTIONS_PER_RUN);
    const filed = async () => (await store.query<{ title: string }>(`SELECT title FROM suggestions WHERE kind = 'merge' AND status = 'pending' AND title LIKE '%方实体%'`)).map((s) => s.title);
    const titles = await filed();
    expect(titles).toHaveLength(ALIAS_SUGGESTIONS_PER_RUN);
    // each lists the other: first; then the most mentioned
    for (let k = 65; k < 70; k++) expect(titles.some((t) => t.includes(`方实体${k}`))).toBe(true);
    expect(titles.some((t) => t.endsWith('乙方实体64 → 甲方实体64'))).toBe(true);
    expect(titles.some((t) => t.includes('方实体0 →') || t.endsWith('方实体0'))).toBe(false);
    // the rest the next run, and nothing after that
    const second = await resolveEntityContext(store, { config: ctx!.config });
    expect(second.suggested).toBe(70 - ALIAS_SUGGESTIONS_PER_RUN);
    expect((await resolveEntityContext(store, { config: ctx!.config })).suggested).toBe(0);
    const after = (await store.query<{ n: number }>(`SELECT count(*)::int AS n FROM suggestions WHERE kind = 'merge'`))[0].n;
    expect(after - before).toBe(70);
    expect(await store.query(`SELECT 1 FROM suggestions WHERE title LIKE '%QZ%'`)).toHaveLength(0);
  }, 120_000);
});
