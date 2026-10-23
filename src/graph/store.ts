import crypto from 'node:crypto';
import { Queryable } from '../store/migrations.js';

/**
 * Graph vocabulary, identity rules and read helpers. Writes go through the
 * lineage runtime (src/lineage/writer.ts): every entity / relation / claim
 * row is a shared, content-addressed aggregate and each source contributes
 * `evidence` rows that the fold turns into the visible columns.
 */

export interface ExtractedEntity {
  name: string;
  type: string;
  description?: string;
  aliases?: string[];
  /** Name of a known entity this one is the same as (extraction-time linking); resolved before an id is assigned. */
  sameAs?: string | null;
  /** Segments of a long document it was extracted from (docs/design/10); mentions are grounded there. */
  segments?: number[];
}

export interface ExtractedRelation {
  source: string;
  target: string;
  /** Predicate spelling; normalized against the ontology on write (synonyms, inverse readings). */
  type: string;
  description?: string;
  /** World-time window the edge holds for, when the source states one. */
  validFrom?: string | null;
  validTo?: string | null;
}

/**
 * Time-bound factual assertion about an entity (GraphRAG's covariate/claim).
 * Unlike relations (structural graph edges), claims are citable statements
 * with a truth status and optional validity period.
 */
export interface ExtractedClaim {
  subject: string;
  object?: string | null;
  /** One of CLAIM_TYPES (free spellings are mapped on parse; unknown → `other`). */
  type: string;
  statement: string;
  status: 'fact' | 'suspected' | 'disputed' | 'absent';
  /** What sort of assertion it is (default `fact`): the attribution the statement itself leaves out. */
  kind?: ClaimKind;
  startDate?: string | null;
  endDate?: string | null;
  /** When the asserted event happened, if the statement is about a dated event. */
  eventDate?: string | null;
  /** Segment of a long document it was extracted from (docs/design/10); the claim is grounded there. */
  segment?: number;
}

/** A document being wired into the graph: identity plus its indexed chunks. */
export interface PageContext {
  documentId: string;
  path: string;
  title: string;
  chunkIds: { id: string; content: string }[];
}

export const ENTITY_TYPES = ['person', 'organization', 'product', 'project', 'component', 'technology', 'concept', 'event', 'location', 'datasource', 'dataset', 'other'];
export const RELATION_TYPES = ['related_to', 'part_of', 'uses', 'depends_on', 'works_at', 'authored', 'mentions', 'links_to', 'co_occurs', 'stored_in', 'appears_in'];
/**
 * `absent` is negative knowledge: a lookup that came back empty, recorded so
 * the same empty query is not re-run every session. It carries a validity
 * window like any other claim — "nothing there" is true of a moment, not
 * forever.
 */
export const CLAIM_STATUS = ['fact', 'suspected', 'disputed', 'absent'] as const;

/**
 * What sort of assertion a claim is, apart from how firmly the source makes
 * it (`status`). A blog corpus is mostly views and forecasts; stored as facts
 * they read as settled knowledge. The statement is written without its
 * attribution ("宁德时代估值偏高", not "作者认为宁德时代估值偏高") and the kind
 * carries it: `fact` happened or holds, `opinion` is someone's judgement,
 * `prediction` is a forecast, `rumor` is hearsay.
 */
export const CLAIM_KINDS = ['fact', 'opinion', 'prediction', 'rumor'] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export interface ClaimTypeSpec {
  id: string;
  /** One line the tier-1 prompt shows. */
  description: string;
  /** Spellings mapped onto this type (the old free-text labels, Chinese names, near misses). */
  synonyms?: string[];
  /**
   * A measure whose newest period is the current one: a later fact of the same
   * subject, type and object supersedes an older one (src/wiki/refine.ts). Off
   * for types that mix unrelated facts (management, fundamentals, event …),
   * where "newer" says nothing about "replaces".
   */
  supersedes?: boolean;
  /** Written by the pipeline itself; never offered to the LLM. */
  system?: boolean;
}

/**
 * The closed claim vocabulary: the topic of an assertion. Before this list
 * the extractor chose its own label and 236,000 claims carried 44,735 distinct
 * ones, useless as a facet. Anything outside the list maps to `other`.
 */
export const CLAIM_TYPES: readonly ClaimTypeSpec[] = [
  { id: 'price_move', supersedes: true, description: 'a price, index level or move: 涨停, 跌 3%, 3000 点, 新高, 成交额', synonyms: ['price', 'price_change', 'price_action', 'market_move', 'market_performance', 'stock_performance', 'performance', 'quote', '市场表现', '股价表现', '股价', '行情', '涨跌', '指数表现', '盘面'] },
  { id: 'technical', supersedes: true, description: 'a technical-analysis reading: 均线, MACD, 支撑/压力位, 量能, 形态, 趋势线', synonyms: ['technical_analysis', 'chart', 'chart_pattern', 'ta', '技术分析', '技术面', '技术指标', '均线', '形态'] },
  { id: 'earnings', supersedes: true, description: 'reported results: 营收, 净利润, 毛利率, 增速, 分红, 现金流', synonyms: ['earning', 'financials', 'financial', 'financial_result', 'results', 'revenue', 'profit', 'dividend', 'performance_report', '业绩', '财报', '财务', '财务数据', '营收', '净利润', '利润', '分红'] },
  { id: 'guidance', supersedes: true, description: "a company's own outlook or plan: 指引, 目标, 订单, 产能规划, 新产品计划", synonyms: ['outlook_company', 'forecast_company', 'plan', 'target', 'company_guidance', '指引', '业绩指引', '规划', '计划', '目标'] },
  { id: 'fundamentals', description: 'what a company or product is or does: 产品, 产能, 客户, 市占率, 合同, 成本, 技术能力', synonyms: ['fundamental', 'business', 'operations', 'operation', 'capability', 'capacity', 'benchmark', 'product', 'market_share', 'contract', 'customer', 'supply', 'supplies', 'supply_chain', 'technology', 'company_profile', '基本面', '业务', '经营', '产能', '产品', '市占率', '客户', '订单', '合同', '供应', '供应链', '供货'] },
  { id: 'valuation', supersedes: true, description: 'a valuation level or judgement: PE 20 倍, 市值, 估值偏高/低估, 目标价', synonyms: ['value', 'valuation_level', 'market_cap', 'pe', 'target_price', '估值', '市值', '目标价', '估值判断'] },
  { id: 'fund_flow', supersedes: true, description: 'money flows and positioning: 北向资金, 融资余额, 主力资金, 换手率, 成交量, 仓位水平', synonyms: ['flow', 'flows', 'capital_flow', 'money_flow', 'liquidity', 'positioning', 'volume', 'turnover', '资金', '资金流向', '资金面', '北向资金', '融资', '成交量', '换手率', '流动性'] },
  { id: 'holding', supersedes: true, description: 'who holds what: 持仓, 加仓, 减仓, 清仓, 持股比例, 股东变动', synonyms: ['holdings', 'position', 'positions', 'portfolio', 'stake', 'ownership', 'shareholding', 'shareholder', '持仓', '持股', '仓位', '调仓', '加仓', '减仓', '股东', '股权'] },
  { id: 'management', description: 'executives, governance and control: 董事长 / CEO / CFO 任免, 董事会, 实控人, 股权激励', synonyms: ['governance', 'executive', 'executives', 'leadership', 'appointment', 'personnel', 'board', 'ceo', 'cfo', 'chairman', 'officer', 'role', 'control', '高管', '管理层', '人事', '任免', '任命', '董事长', '董事会', '实控人', '治理'] },
  { id: 'recommendation', supersedes: true, description: 'advice or a rating: 建议买入/卖出, 看好, 回避, 评级, 关注', synonyms: ['recommend', 'advice', 'rating', 'call', 'buy', 'sell', 'investment_advice', '推荐', '建议', '评级', '看好', '操作建议', '投资建议'] },
  { id: 'outlook', supersedes: true, description: 'a view on where a market, sector or asset is heading: 牛市/熊市, 底部, 风格切换, 情绪', synonyms: ['market_view', 'market_outlook', 'view', 'judgement', 'judgment', 'trend', 'sentiment', 'forecast', 'prediction', 'expectation', 'opinion', '观点', '看法', '判断', '行情判断', '市场判断', '趋势', '趋势判断', '预测', '预期', '展望', '情绪', '市场情绪', '后市'] },
  { id: 'macro', supersedes: true, description: 'macroeconomic data or conditions: CPI, GDP, 利率, 汇率, 就业, PMI, 社融', synonyms: ['macroeconomic', 'macroeconomics', 'economy', 'economic', 'economic_data', 'rates', 'inflation', '宏观', '宏观经济', '经济', '经济数据', '利率', '汇率', '通胀'] },
  { id: 'policy', description: 'a government, regulator or central-bank action or document: 降准, 国九条, 关税, 监管措施', synonyms: ['regulation', 'regulatory', 'government', 'central_bank', 'monetary_policy', 'fiscal_policy', '政策', '监管', '法规', '货币政策', '财政政策', '政府'] },
  { id: 'event', description: 'a dated happening: 并购, 发布, 退市, 停牌, 事故, 会议, 诉讼', synonyms: ['events', 'decision', 'announcement', 'news', 'deal', 'launch', 'incident', 'milestone', 'history', '事件', '公告', '新闻', '动态', '大事', '事故', '并购', '发布'] },
  { id: 'risk', description: 'a risk, warning or negative factor: 商誉减值风险, 退市风险, 解禁压力, 利空', synonyms: ['risks', 'warning', 'concern', 'threat', 'negative', '风险', '风险提示', '利空', '隐患', '担忧'] },
  { id: 'method', description: 'a trading or investment method, rule or lesson: 止损纪律, 均线策略, 定投, 仓位管理', synonyms: ['methodology', 'strategy', 'rule', 'lesson', 'principle', 'approach', 'technique', 'framework', 'trading_strategy', '方法', '方法论', '策略', '纪律', '经验', '原则', '交易策略', '投资策略', '心得'] },
  { id: 'other', description: 'anything the list above does not cover', synonyms: ['misc', 'general', 'fact', 'unknown', 'none', '其他', '其它'] },
  { id: 'absence', description: 'negative knowledge recorded by a probe', system: true },
];

const claimTypeIndex = (() => {
  const m = new Map<string, string>();
  for (const t of CLAIM_TYPES) m.set(t.id, t.id);
  for (const t of CLAIM_TYPES) for (const s of t.synonyms ?? []) if (!m.has(claimTypeKey(s))) m.set(claimTypeKey(s), t.id);
  return m;
})();

/** Spelling → lookup key: NFKC, trimmed, lower-cased, separators collapsed to `_`. */
function claimTypeKey(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase().replace(/[\s\-/]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

/** Map a claim type as the extractor (or a frontmatter author) spelled it onto the closed list; unknown → `other`. */
export function normalizeClaimType(raw: unknown): string {
  if (typeof raw !== 'string') return 'other';
  return claimTypeIndex.get(claimTypeKey(raw)) ?? 'other';
}

/** The closed type a known spelling means (`revenue` → `earnings`), or undefined for one the list does not know — for filters, where an unknown spelling should match nothing rather than `other`. */
export function claimTypeOf(raw: string): string | undefined {
  return claimTypeIndex.get(claimTypeKey(raw));
}

const CLAIM_KIND_SYNONYMS: Record<string, ClaimKind> = {
  fact: 'fact', facts: 'fact', factual: 'fact', statement: 'fact', 事实: 'fact',
  opinion: 'opinion', opinions: 'opinion', view: 'opinion', judgement: 'opinion', judgment: 'opinion', belief: 'opinion', 观点: 'opinion', 看法: 'opinion', 判断: 'opinion', 评价: 'opinion',
  prediction: 'prediction', predictions: 'prediction', forecast: 'prediction', expectation: 'prediction', outlook: 'prediction', projection: 'prediction', 预测: 'prediction', 预期: 'prediction', 预计: 'prediction', 展望: 'prediction',
  rumor: 'rumor', rumour: 'rumor', rumors: 'rumor', hearsay: 'rumor', unconfirmed: 'rumor', speculation: 'rumor', 传闻: 'rumor', 传言: 'rumor', 小道消息: 'rumor', 小作文: 'rumor',
};

/** Map a claim kind as the extractor spelled it; anything unrecognized (including a missing one) is `fact`. */
export function normalizeClaimKind(raw: unknown): ClaimKind {
  if (typeof raw !== 'string') return 'fact';
  return CLAIM_KIND_SYNONYMS[claimTypeKey(raw)] ?? 'fact';
}

export function slugify(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[\s/\\]+/g, '-')
    .replace(/[^\p{L}\p{N}\-_.]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return s || 'entity-' + crypto.createHash('md5').update(name).digest('hex').slice(0, 8);
}

/** Relation identity is document-independent: the same edge asserted by many sources is one row. */
export function relationId(sourceId: string, type: string, targetId: string): string {
  return crypto.createHash('sha256').update(`${sourceId}|${type}|${targetId}`).digest('hex').slice(0, 24);
}

/** Claim identity: subject + normalized statement (NFKC, trimmed, whitespace-collapsed). */
export function claimId(subjectId: string, statement: string): string {
  const normalized = statement.normalize('NFKC').trim().replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(`${subjectId}|${normalized}`).digest('hex').slice(0, 24);
}

/**
 * Resolve a raw value (e.g. a ticker symbol sampled from a live table) to a
 * live entity by exact name or alias — so `daily_quotes.symbol = "300750"`
 * links to the 宁德时代 entity instead of spawning a duplicate node.
 */
export async function resolveEntityIdByNameOrAlias(q: Queryable, value: string): Promise<string | null> {
  const v = value.trim();
  if (!v) return null;
  const byName = await q.query<{ id: string }>(
    `SELECT id FROM entities WHERE lower(name) = lower($1) AND tx_to IS NULL ORDER BY mention_count DESC LIMIT 1`,
    [v],
  );
  if (byName[0]) return byName[0].id;
  const byAlias = await q.query<{ id: string }>(
    `SELECT e.id FROM entities e, jsonb_array_elements_text(e.aliases) a(alias)
     WHERE lower(a.alias) = lower($1) AND e.tx_to IS NULL ORDER BY e.mention_count DESC LIMIT 1`,
    [v],
  );
  return byAlias[0]?.id ?? null;
}
