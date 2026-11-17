import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { ONTOLOGY_DIR } from '../fs/layout.js';
import { parseYaml } from '../compiler/intents.js';
import { stringList } from '../markdown.js';

/**
 * The ontology: which entity types and relation types the graph is written in.
 *
 * Declared in `playbooks/ontology/<pack>.yaml` (gbrain's schema-pack idea),
 * merged in the order `config.graph.ontologyPacks` lists them, with two
 * built-in packs seeded on first run: `core` (the generic vocabulary the
 * pipeline always had) and `organization` (corporate structure and supply
 * chains — subsidiaries, suppliers and customers, stakes, competitors).
 *
 * Everything downstream derives from the loaded ontology instead of a constant:
 * the tier-1 prompt lists these predicates with their definitions, the writer
 * validates and normalizes what comes back (synonyms → the canonical id, an
 * inverse spelling → the canonical id with the edge flipped, a symmetric
 * predicate → one row regardless of direction), and unknown predicates are
 * counted rather than silently becoming `related_to` and disappearing.
 */

export interface EntityTypeSpec {
  id: string;
  label?: string;
  description?: string;
  examples?: string[];
}

export interface RelationTypeSpec {
  id: string;
  label?: string;
  description?: string;
  /** Name of the inverse reading (`parent_of` for `subsidiary_of`). Not itself a stored predicate. */
  inverse?: string;
  /** A r B ⇔ B r A: stored once, endpoints ordered. */
  symmetric?: boolean;
  /** Containment / membership style edge. */
  hierarchical?: boolean;
  /** The edge normally holds for a period (extraction asks for validFrom / validTo). */
  temporal?: boolean;
  /** Entity types typically on each side; hints for the prompt, not constraints. */
  domain?: string[];
  range?: string[];
  /** Raw spellings mapped onto this predicate in its stated direction. */
  synonyms?: string[];
  /** Raw spellings mapped onto this predicate with source and target swapped. */
  inverseSynonyms?: string[];
  examples?: string[];
  /** Written by the pipeline itself (mentions, co_occurs …); never offered to the LLM. */
  system?: boolean;
  /**
   * A page's link to a document (cites, derived_from, tested_by): an author
   * writes it in frontmatter, the extraction prompt never offers it, the
   * research brief does (src/graph/citations.ts).
   */
  documentLink?: boolean;
}

export interface Ontology {
  packs: string[];
  entityTypes: EntityTypeSpec[];
  relationTypes: RelationTypeSpec[];
  /** Fingerprint of the merged packs (changes when any pack file changes). */
  sha: string;
}

export interface NormalizedPredicate {
  /** Canonical predicate id to store. */
  type: string;
  /** Swap source and target before storing (the raw spelling was an inverse reading). */
  flip: boolean;
  /** The raw spelling, when it matched nothing and fell back to `related_to`. */
  unknown?: string;
}

/**
 * Predicates the pipeline itself writes; always legal, never in the prompt.
 * `co_occurs` is no longer written — co-occurrence is derived from mentions on
 * read (cooccur.ts) — but stays legal so old sidecars and packs still validate.
 */
export const SYSTEM_RELATION_TYPES = ['related_to', 'mentions', 'links_to', 'co_occurs', 'stored_in', 'appears_in'] as const;

/**
 * Predicates a wiki page cites a document with (src/graph/citations.ts),
 * present in every workspace whatever its packs say: the packs on disk are
 * the user's files and are never rewritten, so a workspace seeded before
 * these existed would otherwise read `derived_from` as `related_to`. Between
 * two entities they are ordinary predicates (`derived_from: ["[[K0]]"]`). The
 * synonyms stay few and unambiguous, because the writer normalizes tier-1
 * output with them too.
 */
export const DOCUMENT_RELATION_TYPES: readonly RelationTypeSpec[] = [
  {
    id: 'cites',
    inverse: 'cited_by',
    description: 'A refers to document B as a source',
    synonyms: ['references', '引用'],
    inverseSynonyms: ['referenced_by', '被引用'],
    documentLink: true,
  },
  {
    id: 'derived_from',
    inverse: 'basis_of',
    description: 'A was worked out from B: a paper, a dataset, a post, another idea',
    synonyms: ['based_on', 'adapted_from', '源自', '推导自'],
    inverseSynonyms: ['basis_for'],
    documentLink: true,
  },
  {
    id: 'tested_by',
    inverse: 'tests',
    description: 'A was tested, backtested or validated by B: an experiment, a backtest record',
    synonyms: ['backtested_by', 'validated_by'],
    inverseSynonyms: ['backtests', '回测'],
    documentLink: true,
  },
];

export const CORE_PACK_YAML = `# Ontology pack "core": the vocabulary every knode-os graph is written in.
# Edit or add packs under playbooks/ontology/ and list them in knode.config.json
# under graph.ontologyPacks (merged in order; later packs may extend earlier ones).
#
# relationTypes fields:
#   id           canonical predicate, stored on the edge
#   inverse      the inverse reading (not stored; an LLM or a frontmatter author may
#                use it and the edge is flipped into the canonical direction)
#   symmetric    A r B == B r A (stored once)
#   hierarchical containment / membership
#   temporal     usually holds for a period — extraction asks for validFrom / validTo
#   domain/range typical entity types on each side (prompt hints, not constraints)
#   synonyms / inverseSynonyms   raw spellings mapped onto this predicate
#
# entityTypes fields:
#   id           the type stored on the entity
#   label        a short name in the corpus language
#   description  one line the tier-1 prompt shows (what belongs here, what does not)
#   examples     a few names the prompt shows after the description
# A later pack may restate a type to sharpen its description for its domain;
# the type keeps its place (and fold precedence) from the pack that declared it.
id: core
entityTypes:
  - id: person
    label: 人物
    description: a named individual (an executive, analyst, author, official)
  - id: organization
    label: 组织 / 公司
    description: a company, institution, agency, exchange, platform or team
  - id: product
    label: 产品
    description: a product or service an organization makes or sells
  - id: project
    label: 项目
    description: a named initiative, programme or venture with a start and an end
  - id: component
    label: 组件 / 模块
    description: a part, module or subsystem of a product or system
  - id: technology
    label: 技术
    description: a technology, technique, standard or material
  - id: event
    label: 事件
    description: one dated happening with a name (a launch, a deal, a crash, a meeting)
  - id: location
    label: 地点
    description: a place — country, region, city, site
  - id: datasource
    label: 数据源
    description: a system or feed that data comes from
  - id: dataset
    label: 数据集
    description: a table or data set
  - id: other
    label: 其他
    description: a named thing no type above fits (prefer a specific type)
  - id: concept
    label: 概念（兜底）
    description: an abstract notion; the fallback when nothing else fits
relationTypes:
  - { id: related_to, description: generic association when nothing more specific applies, system: true }
  - id: part_of
    inverse: has_part
    hierarchical: true
    description: A is a component, division or member of B
    synonyms: [component_of, belongs_to, division_of, 属于, 隶属于, 组成部分]
    inverseSynonyms: [contains, consists_of, 包含, 下设]
  - id: uses
    description: A uses B (a technology, tool, material or dataset)
    synonyms: [using, adopts, utilizes, 使用, 采用]
    inverseSynonyms: [used_by, 被使用]
  - id: depends_on
    description: A requires B to function or to be delivered
    synonyms: [requires, relies_on, 依赖]
    inverseSynonyms: [required_by, 被依赖]
  - id: works_at
    inverse: employs
    temporal: true
    domain: [person]
    range: [organization]
    description: person A holds a position at organization B
    synonyms: [employed_by, works_for, 就职于, 任职于, 任职]
    inverseSynonyms: [employer_of, 雇佣]
  - id: authored
    inverse: authored_by
    domain: [person, organization]
    description: A wrote or produced B (a document, report, product)
    synonyms: [wrote, created, published, 撰写, 发布]
    inverseSynonyms: [written_by, created_by, published_by, 作者]
  - id: located_in
    inverse: location_of
    domain: [organization, person, event]
    range: [location]
    description: A is based in / took place in B
    synonyms: [based_in, headquartered_in, 位于, 总部位于, 注册地]
  - id: member_of
    inverse: has_member
    hierarchical: true
    description: A belongs to group / alliance / index B
    synonyms: [joined, 成员, 加入]
  - id: succeeded_by
    inverse: preceded_by
    temporal: true
    description: A was replaced or followed by B
    synonyms: [replaced_by, superseded_by, followed_by, 被取代, 继任者]
    inverseSynonyms: [replaces, supersedes, succeeds, 取代, 接替]
  - id: caused
    inverse: caused_by
    description: A led to B
    synonyms: [led_to, resulted_in, triggered, 导致, 引发]
    inverseSynonyms: [because_of, due_to, 由于]
  - id: contradicts
    symmetric: true
    description: A and B make incompatible claims
    synonyms: [conflicts_with, disagrees_with, 矛盾, 冲突]
  - { id: mentions, system: true }
  - { id: links_to, system: true }
  - { id: co_occurs, system: true, symmetric: true }
  - { id: stored_in, system: true }
  - { id: appears_in, system: true }
`;

export const ORGANIZATION_PACK_YAML = `# Ontology pack "organization": corporate structure and supply-chain relations
# for company / industry research. Directions read "A <predicate> B".
id: organization
description: corporate structure, ownership and supply chains
relationTypes:
  - id: subsidiary_of
    inverse: parent_of
    hierarchical: true
    temporal: true
    domain: [organization]
    range: [organization]
    description: A is a subsidiary of / controlled by B
    synonyms: [controlled_by, unit_of, 子公司, 附属公司, 控股子公司, 全资子公司]
    inverseSynonyms: [controls, has_subsidiary, 母公司, 控股股东, 控股]
  - id: supplies_to
    inverse: customer_of
    temporal: true
    domain: [organization]
    range: [organization]
    description: A is an upstream supplier of B (B buys from A)
    synonyms: [supplier_of, sells_to, upstream_of, vendor_of, 供应商, 供货给, 上游, 供应]
    inverseSynonyms: [buys_from, purchases_from, downstream_of, sources_from, 客户, 采购自, 下游, 客户是]
  - id: owns
    inverse: owned_by
    temporal: true
    description: A holds an equity stake in B
    synonyms: [holds_stake_in, shareholder_of, stake_in, 持股, 持有股份, 股东]
  - id: invested_in
    inverse: invested_by
    temporal: true
    description: A invested money in B (a round, a fund, an acquisition of shares)
    synonyms: [invests_in, investor_in, 投资, 参股, 注资]
    inverseSynonyms: [funded_by, backed_by, raised_from, 获投资, 融资自]
  - id: acquired
    inverse: acquired_by
    temporal: true
    domain: [organization]
    range: [organization]
    description: A bought B (whole or majority)
    synonyms: [bought, took_over, merged_with?, 收购, 并购]
    inverseSynonyms: [被收购, sold_to]
  - id: competes_with
    symmetric: true
    domain: [organization, product]
    description: A and B compete in the same market
    synonyms: [competitor_of, rival_of, 竞争对手, 竞品, 竞争]
  - id: partner_of
    symmetric: true
    temporal: true
    description: A and B cooperate (joint venture, strategic partnership, alliance)
    synonyms: [partners_with, collaborates_with, joint_venture_with, 合作伙伴, 合作, 战略合作]
  - id: produces
    inverse: produced_by
    domain: [organization]
    range: [product]
    description: A makes or sells product B
    synonyms: [makes, manufactures, sells, offers, 生产, 制造, 销售, 主营]
    inverseSynonyms: [made_by, manufactured_by, 由...生产]
  - id: founded
    inverse: founded_by
    domain: [person, organization]
    range: [organization]
    description: A established B
    synonyms: [founder_of, established, 创立, 创办, 创建]
    inverseSynonyms: [创始人, founded_in?]
  - id: reports_to
    inverse: manages
    temporal: true
    domain: [person]
    range: [person]
    description: person A reports to person B
    synonyms: [汇报给, 向...汇报]
    inverseSynonyms: [manager_of, supervises, 管理, 领导]
  - id: regulated_by
    inverse: regulates
    domain: [organization]
    range: [organization]
    description: A is supervised or licensed by regulator B
    synonyms: [supervised_by, licensed_by, 受监管于, 监管]
`;

export const FINANCE_PACK_YAML = `# Ontology pack "finance": markets, securities, sectors, indicators and the
# relations a stock-market corpus states. Directions read "A <predicate> B".
# Opt-in: list it after core and organization in graph.ontologyPacks.
#
# Typing rules this pack adds on top of core:
#   - A listed company is one entity, type organization, with its tickers
#     (300750, CATL, 宁德时代.SZ) in aliases. security is for instruments that
#     are not a company or a fund (可转债, 债券, 期货/期权合约, 存托凭证).
#   - A platform or media account (雪球, 知识星球, 微博) is an organization and a
#     blogger is a person; there is no channel type, so an author stays one
#     entity whether quoted as a writer or as a trader.
#   - A generic market move (大跌, 反弹, 回调) is a claim of type price_move,
#     never an event entity; an event is one dated happening with a name.
#   - A sector or theme is named bare (银行, not 银行股 / 银行板块); an indicator
#     is the measure (5日均线, 市盈率), its value on a day is a claim.
id: finance
description: markets, securities, sectors, indicators and who holds, recommends or forecasts what
entityTypes:
  # core types restated with the meaning they have in a market corpus (place and precedence unchanged)
  - id: organization
    description: a company (listed or not; tickers in aliases), exchange, regulator, central bank, fund manager, broker, platform or media account
    examples: [宁德时代, 贵州茅台, 中国证监会, 美联储, 雪球]
  - id: product
    description: a concrete product or service a company sells; not a sector, theme, index or indicator
    examples: [麒麟电池, Model Y, 余额宝]
  - id: technology
    description: a technology or technical approach; a technical indicator such as 均线 is an indicator
    examples: [固态电池, CPO, 大模型]
  - id: event
    description: one dated happening with a name (a crash, a meeting, a launch, an incident); a generic rise or fall is a price_move claim, not an entity
    examples: [2015年股灾, 2020年3月美股熔断, 2024年中央经济工作会议]
  - id: dataset
    description: a data table or data set; an index or a market is not a dataset
  - id: market
    label: 市场
    description: a trading venue or market segment where securities are listed and traded
    examples: [A股, 港股, 美股, 科创板, 北交所, 债市]
  - id: index
    label: 指数
    description: a stock-market or asset index — the number funds track and bloggers quote
    examples: [上证指数, 沪深300, 创业板指, 上证50, 纳斯达克指数, 美元指数]
  - id: security
    label: 证券
    description: a tradable instrument that is not a company or a fund — a bond, convertible, futures or options contract, warrant, depositary receipt; a listed company stays organization with its tickers as aliases
    examples: [宁德转债, 十年期国债, 沪深300股指期货]
  - id: fund
    label: 基金
    description: a fund or fund product — a public mutual fund, ETF, private fund, QDII, pension or sovereign fund (tickers in aliases)
    examples: [科创50ETF, 易方达蓝筹精选, 社保基金, 挪威主权基金]
  - id: sector
    label: 行业 / 板块
    description: an industry or industry board — what companies do, named bare (银行, not 银行股), with a stable hierarchy (part_of)
    examples: [半导体, 新能源, 光模块, 医药, 消费, 银行, 券商, 军工]
  - id: theme
    label: 题材 / 概念
    description: a market theme or concept board stocks are grouped under — a narrative rather than an industry
    examples: [人工智能, 算力, 低空经济, 华为产业链, 中特估, 国企改革]
  - id: indicator
    label: 指标
    description: a measure, ratio or technical / fundamental / flow indicator — the measure itself; its value on a day is a claim
    examples: [市盈率, 5日均线, MACD, 融资余额, 北向资金净流入, 换手率, ROE]
  - id: currency
    label: 货币
    description: a currency or crypto-asset
    examples: [人民币, 美元, 日元, 比特币]
  - id: commodity
    label: 商品
    description: a traded commodity or raw material
    examples: [黄金, 原油, 铜, 碳酸锂, 铁矿石, 白银]
  - id: policy
    label: 政策
    description: a government, regulator or central-bank policy, measure, regulation or official meeting
    examples: [国九条, 降准, 以旧换新, 中央经济工作会议, 美联储加息]
relationTypes:
  - id: member_of
    description: A belongs to group or alliance B (an index constituent is constituent_of, a sector or theme member belongs_to_sector)
  - id: listed_on
    inverse: lists
    hierarchical: true
    temporal: true
    domain: [organization, security, fund]
    range: [market]
    description: A is listed or traded on market B
    synonyms: [traded_on, trades_on, 上市于, 在...上市, 挂牌, 登陆]
    inverseSynonyms: [lists, 上市公司包括]
  - id: constituent_of
    inverse: has_constituent
    hierarchical: true
    temporal: true
    domain: [organization, security, fund]
    range: [index]
    description: A is a constituent of index B
    synonyms: [component_of_index, member_of_index, included_in_index, in_index, 成分股, 成份股, 指数成分, 纳入, 纳入指数]
    inverseSynonyms: [has_constituent, includes_constituent, 成分股包括, 成分股有]
  - id: belongs_to_sector
    inverse: sector_includes
    hierarchical: true
    domain: [organization, security, fund, product]
    range: [sector, theme]
    description: A (a company, stock, fund or product) belongs to sector or theme B
    synonyms: [in_sector, sector_of?, in_theme, theme_of?, 所属行业, 所属板块, 属于板块, 属于行业, 概念股, 板块成员, 行业分类, 题材股]
    inverseSynonyms: [sector_includes, theme_includes, includes_stock, 板块包含, 板块内个股, 行业包含, 成员股]
  - id: tracks
    inverse: tracked_by
    domain: [fund, security]
    range: [index, commodity, currency]
    description: fund or ETF A tracks index or asset B
    synonyms: [tracks_index, tracking, follows_index, indexed_to, 跟踪, 跟踪指数, 挂钩, 跟踪标的]
    inverseSynonyms: [tracked_by, 被跟踪]
  - id: issued_by
    inverse: issued
    domain: [security, fund, currency]
    range: [organization]
    description: instrument A was issued by B (a convertible by its company, a fund by its manager, a currency by its central bank)
    synonyms: [issuer?, issuer_is, 发行人, 发行方, 由...发行]
    inverseSynonyms: [issued, issues, 发行, 发行了]
  - id: manages_fund
    inverse: managed_by
    temporal: true
    domain: [person, organization]
    range: [fund]
    description: person or company A manages fund B
    synonyms: [fund_manager_of, runs_fund, 管理基金, 基金经理, 掌管]
    inverseSynonyms: [managed_by, 由...管理, 基金经理是]
  - id: benefits_from
    inverse: benefits
    domain: [organization, sector, theme, security, fund, commodity, currency, market, index]
    range: [policy, event, theme, technology, commodity, currency]
    description: A gains from B (a policy, event, trend or price move); the opposite is harmed_by
    synonyms: [gains_from, boosted_by, supported_by, driven_by, 受益于, 受益, 受提振, 得益于]
    inverseSynonyms: [benefits, boosts, favors, favours, supports, 利好, 提振, 带动, 推动, 有利于]
  - id: harmed_by
    inverse: hurts
    domain: [organization, sector, theme, security, fund, commodity, currency, market, index]
    range: [policy, event, theme, technology, commodity, currency]
    description: A loses from B (a policy, event, trend or price move); the opposite is benefits_from
    synonyms: [hurt_by, pressured_by, weighed_by, suffers_from, 受损于, 受冲击, 受压制, 受拖累]
    inverseSynonyms: [hurts, weighs_on, pressures, drags, 利空, 冲击, 压制, 拖累, 不利于]
  - id: holds_position_in
    inverse: held_by
    temporal: true
    domain: [person, fund, organization]
    range: [organization, security, fund, commodity, currency, index]
    description: A holds a trading or portfolio position in B (a stock, fund, bond, commodity); a corporate equity stake is owns
    synonyms: [holds, holds_position, position_in, long, 持仓, 持有, 重仓, 建仓, 加仓, 买入, 配置, 买了]
    inverseSynonyms: [held_by, 被持有, 持仓者]
  - id: recommends
    inverse: recommended_by
    temporal: true
    domain: [person, organization]
    range: [organization, security, fund, sector, theme, commodity, currency, index, market]
    description: A recommends buying, holding or watching B (看好 / 推荐 / 建议关注); a bearish call is bearish_on
    synonyms: [recommend, bullish_on, likes, rates_buy, 看好, 推荐, 看多, 唱多, 建议买入, 建议关注, 建议持有, 评级买入, 评级增持, 增持评级]
    inverseSynonyms: [recommended_by, 被推荐, 被看好]
  - id: bearish_on
    inverse: shunned_by
    temporal: true
    domain: [person, organization]
    range: [organization, security, fund, sector, theme, commodity, currency, index, market]
    description: A advises against B or expects it to fall (看空 / 建议卖出 / 回避); the opposite is recommends
    synonyms: [bearish, shorts, rates_sell, 看空, 看淡, 不看好, 唱空, 建议卖出, 建议回避, 回避, 减持评级, 评级减持, 做空]
    inverseSynonyms: [shunned_by, 被看空]
  - id: predicts
    inverse: predicted_by
    temporal: true
    domain: [person, organization]
    description: A forecasts something about B (an event, a policy, a price level); the forecast itself is a claim of kind prediction
    synonyms: [forecasts, expects, projects, anticipates, 预测, 预计, 预期, 预判, 预言]
    inverseSynonyms: [predicted_by, forecast_by, 被预测]
`;

/** Every pack that ships with knode-os, seeded into playbooks/ontology/ on init and used when a named pack file is missing. */
const BUILTIN_PACKS: Record<string, string> = { core: CORE_PACK_YAML, organization: ORGANIZATION_PACK_YAML, finance: FINANCE_PACK_YAML };

/** The packs a workspace uses unless its config lists others (`finance` ships but is opt-in). */
export const DEFAULT_ONTOLOGY_PACKS: readonly string[] = ['core', 'organization'];

/** Write the built-in packs once (never overwrites user edits). */
export function ensureDefaultOntology(dataDir: string): string[] {
  const created: string[] = [];
  for (const [name, yaml] of Object.entries(BUILTIN_PACKS)) {
    const file = path.join(dataDir, ONTOLOGY_DIR, `${name}.yaml`);
    if (fs.existsSync(file)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, yaml);
    created.push(`${ONTOLOGY_DIR}/${name}.yaml`);
  }
  return created;
}

function idOf(v: unknown): string {
  return typeof v === 'string' ? predicateKey(v) : '';
}

/** Spelling → lookup key: trimmed, lower-cased, separators collapsed to `_`, trailing `?` dropped. */
export function predicateKey(raw: string): string {
  return raw
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\?+$/, '')
    .replace(/[\s\-/]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function parseOntologyPack(text: string): { id: string; entityTypes: EntityTypeSpec[]; relationTypes: RelationTypeSpec[] } {
  const fm = parseYaml(text);
  const entityTypes: EntityTypeSpec[] = [];
  for (const raw of Array.isArray(fm.entityTypes) ? fm.entityTypes : []) {
    if (typeof raw === 'string') {
      if (idOf(raw)) entityTypes.push({ id: idOf(raw) });
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const id = idOf(o.id);
    if (!id) continue;
    entityTypes.push({
      id,
      label: typeof o.label === 'string' ? o.label : undefined,
      description: typeof o.description === 'string' ? o.description : undefined,
      examples: stringList(o.examples),
    });
  }
  const relationTypes: RelationTypeSpec[] = [];
  for (const raw of Array.isArray(fm.relationTypes) ? fm.relationTypes : []) {
    if (typeof raw === 'string') {
      if (idOf(raw)) relationTypes.push({ id: idOf(raw) });
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const id = idOf(o.id);
    if (!id) continue;
    relationTypes.push({
      id,
      label: typeof o.label === 'string' ? o.label : undefined,
      description: typeof o.description === 'string' ? o.description : undefined,
      inverse: idOf(o.inverse) || undefined,
      symmetric: o.symmetric === true,
      hierarchical: o.hierarchical === true,
      temporal: o.temporal === true,
      domain: stringList(o.domain).map(predicateKey),
      range: stringList(o.range).map(predicateKey),
      synonyms: stringList(o.synonyms),
      inverseSynonyms: stringList(o.inverseSynonyms ?? o.inverse_synonyms),
      examples: stringList(o.examples),
      system: o.system === true,
      documentLink: o.documentLink === true || o.document_link === true,
    });
  }
  return { id: typeof fm.id === 'string' ? fm.id : '', entityTypes, relationTypes };
}

function mergeSpec<T extends { id: string }>(into: Map<string, T>, spec: T): void {
  const prev = into.get(spec.id);
  if (!prev) {
    into.set(spec.id, spec);
    return;
  }
  const merged: Record<string, unknown> = { ...prev };
  for (const [k, v] of Object.entries(spec as Record<string, unknown>)) {
    if (v === undefined || v === '' || v === false) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    merged[k] = v;
  }
  into.set(spec.id, merged as T);
}

/** Merge packs in order into one ontology; system and document predicates are always present. */
export function buildOntology(packs: { name: string; text: string }[]): Ontology {
  const entityTypes = new Map<string, EntityTypeSpec>();
  const relationTypes = new Map<string, RelationTypeSpec>();
  for (const pack of packs) {
    const parsed = parseOntologyPack(pack.text);
    for (const e of parsed.entityTypes) mergeSpec(entityTypes, e);
    for (const r of parsed.relationTypes) mergeSpec(relationTypes, r);
  }
  for (const id of SYSTEM_RELATION_TYPES) {
    if (!relationTypes.has(id)) relationTypes.set(id, { id, system: true, symmetric: id === 'co_occurs' });
  }
  for (const spec of DOCUMENT_RELATION_TYPES) {
    if (!relationTypes.has(spec.id)) relationTypes.set(spec.id, { ...spec });
  }
  if (!entityTypes.has('concept')) entityTypes.set('concept', { id: 'concept' });
  const sha = sha16(packs.map((p) => [p.name, p.text]));
  return { packs: packs.map((p) => p.name), entityTypes: [...entityTypes.values()], relationTypes: [...relationTypes.values()], sha };
}

function sha16(value: unknown): string {
  // tiny non-crypto fingerprint is enough: it only invalidates caches
  const text = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + text.length.toString(16);
}

interface CacheEntry {
  stamp: string;
  ontology: Ontology;
}

const cache = new Map<string, CacheEntry>();

function packsFromConfig(dataDir: string): string[] {
  try {
    const packs = loadConfig(dataDir).graph?.ontologyPacks;
    return Array.isArray(packs) && packs.length > 0 ? packs.map(String) : [...DEFAULT_ONTOLOGY_PACKS];
  } catch {
    return [...DEFAULT_ONTOLOGY_PACKS];
  }
}

/**
 * The ontology for a data directory. Synchronous and cached on the pack
 * files' mtimes, so it is cheap enough to call from inside a scope body. A
 * pack named in the config but missing on disk falls back to the built-in of
 * the same name (or is skipped); `ensureDefaultOntology` seeds the built-ins
 * at init so the usual case reads them from the user's files.
 */
export function loadOntology(dataDir: string, packs: string[] = packsFromConfig(dataDir)): Ontology {
  const dir = path.join(dataDir, ONTOLOGY_DIR);
  const sources: { name: string; text: string; stamp: string }[] = [];
  for (const name of packs) {
    const file = path.join(dir, `${name}.yaml`);
    try {
      const st = fs.statSync(file);
      sources.push({ name, text: fs.readFileSync(file, 'utf8'), stamp: `${st.mtimeMs}:${st.size}` });
    } catch {
      if (BUILTIN_PACKS[name]) sources.push({ name, text: BUILTIN_PACKS[name], stamp: 'builtin' });
    }
  }
  const key = `${dataDir}|${packs.join(',')}`;
  const stamp = sources.map((s) => `${s.name}@${s.stamp}`).join(';');
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp) return hit.ontology;
  const ontology = buildOntology(sources);
  cache.set(key, { stamp, ontology });
  return ontology;
}

/** The default packs' built-in text alone (used where no data directory is at hand). */
export function builtinOntology(): Ontology {
  return buildOntology(DEFAULT_ONTOLOGY_PACKS.map((name) => ({ name, text: BUILTIN_PACKS[name] })));
}

/** A shipped pack's yaml by name (`core`, `organization`, `finance`), for copying into a workspace. */
export function builtinPackYaml(name: string): string | undefined {
  return BUILTIN_PACKS[name];
}

export function entityTypeIds(ont: Ontology): Set<string> {
  return new Set(ont.entityTypes.map((t) => t.id));
}

export function relationSpec(ont: Ontology, id: string): RelationTypeSpec | undefined {
  return ont.relationTypes.find((r) => r.id === id);
}

/**
 * Type precedence for the entity fold: the declared order, with `concept`
 * (the extraction fallback) last. The fold takes the most-read type and
 * consults this order only to break a tie (store/temporal.ts).
 */
export function typePrecedence(ont: Ontology): string[] {
  const ids = ont.entityTypes.map((t) => t.id).filter((id) => id !== 'concept');
  return [...ids, 'concept'];
}

interface PredicateIndex {
  canonical: Map<string, { id: string; flip: boolean }>;
}

const indexCache = new WeakMap<Ontology, PredicateIndex>();

function predicateIndex(ont: Ontology): PredicateIndex {
  let idx = indexCache.get(ont);
  if (idx) return idx;
  const canonical = new Map<string, { id: string; flip: boolean }>();
  const put = (key: string, id: string, flip: boolean) => {
    if (key && !canonical.has(key)) canonical.set(key, { id, flip });
  };
  // ids first so a synonym never shadows a real predicate
  for (const r of ont.relationTypes) put(r.id, r.id, false);
  for (const r of ont.relationTypes) {
    for (const s of r.synonyms ?? []) put(predicateKey(s), r.id, false);
    if (r.symmetric) {
      if (r.inverse) put(r.inverse, r.id, false);
      for (const s of r.inverseSynonyms ?? []) put(predicateKey(s), r.id, false);
    } else {
      if (r.inverse) put(r.inverse, r.id, true);
      for (const s of r.inverseSynonyms ?? []) put(predicateKey(s), r.id, true);
    }
  }
  idx = { canonical };
  indexCache.set(ont, idx);
  return idx;
}

/**
 * Map a raw predicate spelling onto the ontology. Unknown spellings fall back
 * to `related_to` and report the original so callers can count them — the
 * signal that a pack is missing a predicate people keep needing.
 */
export function normalizePredicate(ont: Ontology, raw: string): NormalizedPredicate {
  const key = predicateKey(raw ?? '');
  if (!key) return { type: 'related_to', flip: false, unknown: raw };
  const hit = predicateIndex(ont).canonical.get(key);
  if (hit) return { type: hit.id, flip: hit.flip };
  return { type: 'related_to', flip: false, unknown: raw.trim() };
}

/**
 * The vocabulary as the tier-1 prompt states it: one line per entity type
 * (id, label, meaning, examples) and per relation type (canonical id,
 * one-line meaning, inverse spelling, hints). `documentLinks` adds the
 * predicates a page cites documents with: the research brief wants them, the
 * extraction prompt does not.
 */
export function promptFragment(ont: Ontology, opts: { documentLinks?: boolean } = {}): { entityTypes: string; relationTypes: string } {
  const entityTypes = ont.entityTypes.map((t) => {
    const parts: string[] = [];
    if (t.description) parts.push(t.description);
    if (t.examples?.length) parts.push(`e.g. ${t.examples.join(', ')}`);
    return `- ${t.id}${t.label ? ` (${t.label})` : ''}${parts.length ? `: ${parts.join('; ')}` : ''}`;
  }).join('\n');
  const lines: string[] = [];
  for (const r of ont.relationTypes) {
    if (r.system || (r.documentLink && !opts.documentLinks)) continue;
    const parts: string[] = [];
    if (r.description) parts.push(r.description);
    if (r.symmetric) parts.push('symmetric');
    else if (r.inverse) parts.push(`inverse: ${r.inverse}`);
    if (r.domain?.length || r.range?.length) parts.push(`${(r.domain ?? ['*']).join('|')} → ${(r.range ?? ['*']).join('|')}`);
    if (r.temporal) parts.push('time-bound: give validFrom/validTo when stated');
    lines.push(`- ${r.id}${parts.length ? `: ${parts.join('; ')}` : ''}`);
  }
  lines.push('- related_to: only when nothing above fits');
  return { entityTypes, relationTypes: lines.join('\n') };
}
