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
  /** The measure or state the claim gives a value of ("完成度", "headcount"); docs/design/29. */
  attribute?: string | null;
  /** Its value: a number, or a short text (a person, a stage). */
  value?: number | string | null;
  unit?: string | null;
  /** The statement corrects or retracts an earlier report. */
  corrects?: boolean | null;
}

/** A document being wired into the graph: identity plus its indexed chunks. */
export interface PageContext {
  documentId: string;
  path: string;
  title: string;
  chunkIds: { id: string; content: string }[];
}

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
   * Words that decide a label no spelling matches whole. The extractor's old
   * labels were compounds — 盈利预测, 风险判断, 交易建议, 市场份额 — and the word
   * naming the topic sits inside them (normalizeClaimType). Latin labels are
   * read word by word against the ids and synonyms already, so these are
   * mostly the CJK words, which have no word breaks to split on.
   */
  stems?: string[];
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
  { id: 'price_move', supersedes: true, description: 'a price, index level or move: 涨停, 跌 3%, 3000 点, 新高, 成交额', synonyms: ['price', 'price_change', 'price_action', 'market_move', 'market_performance', 'stock_performance', 'performance', 'quote', '市场表现', '股价表现', '股价', '行情', '涨跌', '指数表现', '盘面'], stems: ['股价', '价格', '涨跌', '涨幅', '跌幅', '涨停', '跌停', '连板', '行情', '盘面', '点位', '新高', '新低', '反弹', '回调', '上涨', '下跌', '大涨', '大跌', '涨价', '报价', '表现', '归因', '反应', '广度'] },
  { id: 'technical', supersedes: true, description: 'a technical-analysis reading: 均线, MACD, 支撑/压力位, 量能, 形态, 趋势线', synonyms: ['technical_analysis', 'chart', 'chart_pattern', 'ta', '技术分析', '技术面', '技术指标', '均线', '形态'], stems: ['技术分析', '技术面', '技术指标', '技术形态', '技术判断', '技术走势', '均线', '形态', '支撑', '压力位', '量能', '趋势线', 'k线', '筹码', '缺口'] },
  { id: 'earnings', supersedes: true, description: 'reported results: 营收, 净利润, 毛利率, 增速, 分红, 现金流', synonyms: ['earning', 'financials', 'financial', 'financial_result', 'results', 'revenue', 'profit', 'dividend', 'performance_report', '业绩', '财报', '财务', '财务数据', '营收', '净利润', '利润', '分红', '经营业绩'], stems: ['业绩', '财报', '财务', '营收', '收入', '利润', '盈利', '净利', '毛利', '亏损', '分红', '派息', '股息', '现金', '货币资金', '季报', '年报', '中报', '每股收益', '营业'] },
  { id: 'guidance', supersedes: true, description: "a company's own outlook or plan: 指引, 目标, 订单, 产能规划, 新产品计划", synonyms: ['outlook_company', 'forecast_company', 'plan', 'target', 'company_guidance', '指引', '业绩指引', '规划', '计划', '目标'], stems: ['指引', '规划', '产能规划', '扩产', '目标', '计划'] },
  { id: 'fundamentals', description: 'what a company or product is or does: 产品, 产能, 客户, 市占率, 合同, 成本, 技术能力', synonyms: ['fundamental', 'business', 'operations', 'operation', 'capability', 'capacity', 'benchmark', 'product', 'market_share', 'contract', 'customer', 'supply', 'supplies', 'supply_chain', 'technology', 'company_profile', '基本面', '业务', '经营', '产能', '产品', '市占率', '客户', '订单', '合同', '供应', '供应链', '供货'], stems: ['基本面', '业务', '经营', '产能', '产品', '市占率', '份额', '地位', '客户', '订单', '合同', '供应', '供货', '供给', '需求', '供需', '出货', '销量', '销售', '竞争', '格局', '研发', '能力', '进展', '成本', '开支', '支出', '产业', '渗透率', '商业模式', '护城河', '规模', '产量', '库存', '性能', '功能', '商业化', '量产', '采购', '替代', '资产', '技术路线', '技术应用', '技术布局', '技术进展'] },
  { id: 'valuation', supersedes: true, description: 'a valuation level or judgement: PE 20 倍, 市值, 估值偏高/低估, 目标价', synonyms: ['value', 'valuation_level', 'market_cap', 'pe', 'target_price', '估值', '市值', '目标价', '估值判断'], stems: ['估值', '市值', '目标价', '市盈率', '市净率', '股息率', '定价', '性价比', '低估', '高估', 'pricing'] },
  { id: 'fund_flow', supersedes: true, description: 'money flows and positioning: 北向资金, 融资余额, 主力资金, 换手率, 成交量, 仓位水平', synonyms: ['flow', 'flows', 'capital_flow', 'money_flow', 'liquidity', 'positioning', 'volume', 'turnover', '资金', '资金流向', '资金面', '北向资金', '融资', '成交量', '换手率', '流动性'], stems: ['资金', '融资', '融券', '北向', '南向', '成交', '换手', '流动性', '主力', '量价'] },
  { id: 'holding', supersedes: true, description: 'who holds what: 持仓, 加仓, 减仓, 清仓, 持股比例, 股东变动', synonyms: ['holdings', 'position', 'positions', 'portfolio', 'stake', 'ownership', 'shareholding', 'shareholder', '持仓', '持股', '仓位', '调仓', '加仓', '减仓', '股东', '股权', '交易'], stems: ['持仓', '持股', '仓位', '调仓', '加仓', '减仓', '清仓', '建仓', '买入', '卖出', '操作', '股东', '股权', '增持', '减持', '回购'] },
  { id: 'management', description: 'executives, governance and control: 董事长 / CEO / CFO 任免, 董事会, 实控人, 股权激励', synonyms: ['governance', 'executive', 'executives', 'leadership', 'appointment', 'personnel', 'board', 'ceo', 'cfo', 'chairman', 'officer', 'role', 'control', '高管', '管理层', '人事', '任免', '任命', '董事长', '董事会', '实控人', '治理'], stems: ['高管', '管理层', '人事', '任免', '任命', '任职', '董事', '实控人', '治理', '创始人', '团队', '激励'] },
  { id: 'recommendation', supersedes: true, description: 'advice or a rating: 建议买入/卖出, 看好, 回避, 评级, 关注', synonyms: ['recommend', 'advice', 'rating', 'call', 'buy', 'sell', 'investment_advice', '推荐', '建议', '评级', '看好', '操作建议', '投资建议', '交易计划', '投资计划'], stems: ['推荐', '建议', '评级', '看好', '看空', '关注', '配置'] },
  { id: 'outlook', supersedes: true, description: 'a view on where a market, sector or asset is heading: 牛市/熊市, 底部, 风格切换, 情绪', synonyms: ['market_view', 'market_outlook', 'view', 'judgement', 'judgment', 'trend', 'sentiment', 'forecast', 'prediction', 'expectation', 'opinion', '观点', '看法', '判断', '行情判断', '市场判断', '趋势', '趋势判断', '预测', '预期', '展望', '情绪', '市场情绪', '后市', '行情预测', '行情预期', '价格预测', '价格预期'], stems: ['预测', '预期', '预计', '预判', '展望', '判断', '研判', '观点', '看法', '趋势', '情绪', '后市', '前景', '观察', '分析', '评估', '评价', '逻辑', '轮动', 'assessment', 'observation'] },
  { id: 'macro', supersedes: true, description: 'macroeconomic data or conditions: CPI, GDP, 利率, 汇率, 就业, PMI, 社融', synonyms: ['macroeconomic', 'macroeconomics', 'economy', 'economic', 'economic_data', 'rates', 'inflation', '宏观', '宏观经济', '经济', '经济数据', '利率', '汇率', '通胀'], stems: ['宏观', '经济', '利率', '汇率', '通胀', '就业', '社融', '货币', '出口', '进口', '贸易', '地缘', 'cpi', 'gdp', 'pmi'] },
  { id: 'policy', description: 'a government, regulator or central-bank action or document: 降准, 国九条, 关税, 监管措施', synonyms: ['regulation', 'regulatory', 'government', 'central_bank', 'monetary_policy', 'fiscal_policy', '政策', '监管', '法规', '货币政策', '财政政策', '政府'], stems: ['政策', '货币政策', '财政政策', '监管', '法规', '政府', '关税', '制裁', '降准', '降息', '加息', '出口管制'] },
  { id: 'event', description: 'a dated happening: 并购, 发布, 退市, 停牌, 事故, 会议, 诉讼', synonyms: ['events', 'decision', 'announcement', 'news', 'deal', 'launch', 'incident', 'milestone', 'history', '事件', '公告', '新闻', '动态', '大事', '事故', '并购', '发布', '产品发布'], stems: ['事件', '公告', '新闻', '动态', '大事', '事故', '并购', '收购', '发布', '上市', '退市', '停牌', '会议', '诉讼', '合作', '签约', '发行', '招股', '配售', '认购', '中标', '临床', '军事', 'acquisition', 'merger', 'ipo'] },
  { id: 'risk', description: 'a risk, warning or negative factor: 商誉减值风险, 退市风险, 解禁压力, 利空', synonyms: ['risks', 'warning', 'concern', 'threat', 'negative', '风险', '风险提示', '利空', '隐患', '担忧'], stems: ['风险', '利空', '隐患', '担忧', '警示', '风控'] },
  { id: 'method', description: 'a trading or investment method, rule or lesson: 止损纪律, 均线策略, 定投, 仓位管理', synonyms: ['methodology', 'strategy', 'rule', 'lesson', 'principle', 'approach', 'technique', 'framework', 'trading_strategy', '方法', '方法论', '策略', '纪律', '经验', '原则', '交易策略', '投资策略', '心得'], stems: ['方法', '策略', '纪律', '经验', '原则', '心得', '复盘', '回顾', '反思', '理念', '体系', '框架', '模式', '思路', '教训', '技巧'] },
  { id: 'other', description: 'anything the list above does not cover', synonyms: ['misc', 'general', 'fact', 'unknown', 'none', '其他', '其它'] },
  { id: 'absence', description: 'negative knowledge recorded by a probe', system: true },
];

/**
 * Generic heads that decide a label only when no stem does: 交易 alone is a
 * trade (交易记录, 交易结果), but 交易建议 is advice and 交易策略 a method.
 */
const LAST_RESORT_STEMS: Readonly<Record<string, string>> = { 交易: 'holding', 投资: 'holding', 技术: 'fundamentals', 走势: 'price_move' };

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

interface Stem {
  stem: string;
  type: string;
  /** Latin: found only as a whole word, so `ta` is not found in `data`. */
  word: boolean;
}

const LATIN_KEY = /^[a-z0-9_]+$/;
const WORD_CHAR = /[a-z0-9]/;

function stemOf(spelling: string, type: string): Stem {
  const stem = claimTypeKey(spelling);
  return { stem, type, word: LATIN_KEY.test(stem) };
}

/**
 * The words that decide a compound label, in list order: each type's stems,
 * and its id and Latin synonyms as whole words (`earnings_forecast`,
 * `investment_view`). `other` and the system types decide nothing.
 */
const claimTypeStems: readonly Stem[] = CLAIM_TYPES.filter((t) => !t.system && t.id !== 'other').flatMap((t) => [
  ...(t.stems ?? []).map((s) => stemOf(s, t.id)),
  ...[t.id, ...(t.synonyms ?? [])].map((s) => stemOf(s, t.id)).filter((s) => s.word),
]);
const lastResortStems: readonly Stem[] = Object.entries(LAST_RESORT_STEMS).map(([s, type]) => stemOf(s, type));

function stemAt(key: string, s: Stem): number {
  if (!s.word) return key.indexOf(s.stem);
  for (let at = key.indexOf(s.stem); at >= 0; at = key.indexOf(s.stem, at + 1)) {
    const end = at + s.stem.length;
    if ((at === 0 || !WORD_CHAR.test(key[at - 1])) && (end === key.length || !WORD_CHAR.test(key[end]))) return at;
  }
  return -1;
}

/**
 * The type of the stem that starts first in a label; of two starting
 * together the longer (技术判断 over 技术), of two equal ones the earlier type.
 * A compound names its topic first and its aspect after: 业绩预测 is about
 * earnings, and that it is a forecast is the claim's kind, not its type.
 */
function earliestStem(key: string, stems: readonly Stem[]): string | undefined {
  let best: { at: number; length: number; type: string } | undefined;
  for (const s of stems) {
    const at = stemAt(key, s);
    if (at < 0) continue;
    if (!best || at < best.at || (at === best.at && s.stem.length > best.length)) best = { at, length: s.stem.length, type: s.type };
  }
  return best?.type;
}

/**
 * Map a claim type as the extractor (or a frontmatter author) spelled it onto
 * the closed list: a known spelling; else the earliest stem in it (盈利预测 →
 * earnings, 风险判断 → risk, 交易建议 → recommendation); else a generic head
 * (交易心得 has a stem, 交易结果 only its head → holding); else `other`. On the
 * finance workspace's 57,131 old labels this leaves 15% of their claims in
 * `other`, where a whole-spelling lookup left 88%.
 */
export function normalizeClaimType(raw: unknown): string {
  if (typeof raw !== 'string') return 'other';
  const key = claimTypeKey(raw);
  return claimTypeIndex.get(key) ?? earliestStem(key, claimTypeStems) ?? earliestStem(key, lastResortStems) ?? 'other';
}

/**
 * Changes whenever a spelling, stem or head would map some label differently.
 * Claims folded under another mapping keep their old type until something
 * refolds them, so a change here refolds them once (src/lineage/claim-types.ts).
 */
export const CLAIM_TYPE_MAPPING_SHA = crypto
  .createHash('sha256')
  .update(JSON.stringify([CLAIM_TYPES.map((t) => [t.id, t.synonyms ?? [], t.stems ?? []]), LAST_RESORT_STEMS]))
  .digest('hex')
  .slice(0, 16);

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

/**
 * Claim identity: subject + normalized statement (NFKC, trimmed, whitespace-collapsed),
 * and for a weekly reading the ISO week it is of (`at`, "2025-W24"; readingWeek):
 * "平台组本周服务可用性为99.92%" in week 3 and in week 17 are two readings, not one
 * claim reported twice. Without `at` the id is what it always was.
 */
export function claimId(subjectId: string, statement: string, at?: string | null): string {
  const normalized = statement.normalize('NFKC').trim().replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(`${subjectId}|${normalized}${at ? `|@${at}` : ''}`).digest('hex').slice(0, 24);
}

/**
 * The reading test (readingWeek), on the statement and the claim's own dates
 * alone — no attribute, value or date source, which evidence written before
 * 2026-11-13 does not carry, so a claim of any age gets the id the writer
 * would give it now.
 *
 * A week is named relative to the report's own: this week (本周, 这周, 当周,
 * "this week"), last week (上周, 上一周, "last week") or N weeks before (上上周,
 * 两周前, 3周前, "two weeks ago"). Each is a word: 本周 inside 资本周转率 or
 * 日本周三, a cycle (本周期, 上周期) and a word ending in 上 (早上周会) are none.
 */
const BEFORE_BEN = '资日成版样基根文剧课账读原副脚范标摹底蓝话绘稿刊抄拓选珍孤善刻写足残节记笔';
const BEFORE_SHANG = '马早晚路线网身手桌之向往加爱赶遇碰';
const BEFORE_DANG = '相应适得正妥';
const CN_COUNT: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const EN_COUNT: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const WEEK_WORD = new RegExp([
  `(?<![${BEFORE_BEN}])(?:本|这)周(?![期年刊岁])`,
  `(?<![${BEFORE_DANG}])当周(?![期年刊岁])`,
  `(?<![${BEFORE_SHANG}上])上上?一?周(?![期年刊岁])`,
  String.raw`(?<![\d.])([一两二三四五六七八九十]|\d{1,2})\s*个?\s*(?:周|星期|礼拜)前`,
  String.raw`\bthis week\b|\blast week\b|\bthe week before last\b|\b(one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2}) weeks? ago\b`,
].join('|'), 'gi');

/** The statement names a week relative to its report's (WEEK_WORD). */
export function speaksOfAWeek(statement: string): boolean {
  return new RegExp(WEEK_WORD.source, 'i').test(statement.normalize('NFKC'));
}

/** Substrings every statement speaksOfAWeek takes contains one of (lower-cased): a LIKE filter for SQL. */
export const WEEK_WORD_HINTS = ['本周', '这周', '当周', '上周', '上一周', '周前', '星期前', '礼拜前', 'this week', 'last week', 'week before last', 'weeks ago', 'week ago'];

/** How many weeks before the report's own a week word names: 本周 0, 上周 1, 上上周 2, 两周前 2. */
function weeksBack(word: string): number {
  const w = word.toLowerCase().replace(/\s+/g, ' ');
  if (/^(?:本|这|当)周$|^this week$/.test(w)) return 0;
  if (/^上上周$|^the week before last$/.test(w)) return 2;
  if (/^上一?周$|^last week$/.test(w)) return 1;
  const n = /^([一两二三四五六七八九十]|\d{1,2})/.exec(w)?.[1] ?? /^(\w+) weeks? ago$/.exec(w)?.[1] ?? '';
  return CN_COUNT[n] ?? EN_COUNT[n] ?? (Number(n) || 0);
}

/** A comparison names the period a figure is compared with, not the period it is of: 较上周, 同比去年, "vs last week". */
const COMPARISON = /(?:较|比|相比|相较|对比|环比|同比|比起|高于|低于|多于|少于)(?:于)?\s*(?:上上?一?周|[两三四\d]\s*周前|上个?月|上一?季度?|上年(?:同期)?|去年(?:同期)?|前一周|上期|同期)|\b(?:compared (?:with|to)|vs\.?|versus|from|than)\s+(?:the week before last|last (?:week|month|quarter|year)|a year (?:ago|earlier))/gi;

/**
 * Any other time a statement names, which makes it no reading of a week: a
 * year (2025年, 2025-06, FY25, "in 2025", 去年 — a bare 2000 is a value, as
 * in 成交额为2000亿元), a quarter, half or a company's report of one (Q3, 3Q25,
 * 三季度, 三季报, 年报, H1, 上半年), another week (W37, 第24周, 下周, 两周后,
 * "next week"), a month (6月, 六月, 本月, March — not a tenor: 3月期) or a date
 * (18日, 18号, 今日 — not 7日年化, 3号线, 5日均线).
 */
const OTHER_TIME = new RegExp([
  String.raw`\d{4}\s*(?:年|财年|-\d{1,2})|\bfy\s*'?\d{2,4}\b|\b(?:in|of|for|since|during|until)\s+(?:19|20)\d{2}\b|[去今明上本]年|(?<![当目此之提日])前年|年[初中底末]`,
  String.raw`\bq[1-4]\b|q[1-4](?=\d|[^a-z]|$)|(?<![\d.])[1-4]\s*q(?=\d|[^a-z]|$)|[一二三四1-4]\s*季(?:度|报)|[上下本]季度|季报|年报|半年报|中报|\bh[12]\b|(?<![a-z])h[12](?=[^a-z\d]|$)|(?<![\d.])[12]\s*h(?=\d|[^a-z]|$)|[上下]半年`,
  String.raw`\bw\d{1,2}\b|(?<![a-z])w\d{1,2}(?=\D|$)|第\s*\d{1,3}\s*周|下下?一?周|[一两二三四五六七八九十\d]{1,2}\s*个?\s*周后|\bnext week\b`,
  String.raw`\d{1,2}\s*月(?!期)|[一二三四五六七八九十]{1,2}月(?!期)|[上下本]个?月|月[初中底末]|\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b`,
  String.raw`(?<![\d.])\d{1,2}\s*[日号](?![均年线])|[今昨明前]日|[今昨明前]天`,
].join('|'), 'i');

/** A figure that is no code, date or week: 99.92%, 149万, 3项 — not R-70, INC-012-T1, D6T3-1059. */
function hasFigure(text: string): boolean {
  return /\d/.test(text.replace(/[a-z]+[-_]?\d+(?:[-_][a-z0-9]+)*/gi, ' ').replace(/\d{4}-\d{1,2}(?:-\d{1,2})?/g, ' '));
}

/**
 * The calendar day a stored instant stands for: its date as stored. Dates are
 * stored as UTC instants, and what the extractor writes is a date without a
 * time (YYYY-MM-DD, YYYY-Www) or the document's date, each its own UTC
 * midnight, so the stored date is the date written; a timestamp with a time of
 * day is read by the date it carries (2025-06-22T20:30+08:00 is stored as
 * 12:30Z on the 22nd: Sunday the 22nd). The writer keeps no offset, so a local
 * midnight written with one ahead of UTC (2025-06-16T00:00+08:00) is read as
 * the UTC day before; reading it as written needs the raw value, which only
 * the extraction path has (src/graph/llm-extract.ts, src/store/dates.ts).
 */
function calendarDay(iso: string): number {
  return Math.floor(Date.parse(iso) / 86_400_000) * 86_400_000;
}

/** ISO week of a UTC instant (its UTC day): "2025-W24". */
export function isoWeekOf(iso: string | number): string {
  const d = new Date(iso);
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - dow);
  const week = Math.ceil(((day.getTime() - Date.UTC(day.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const isoOf = (t: string | Date | null | undefined): string | null => {
  if (t === null || t === undefined || t === '') return null;
  const d = t instanceof Date ? t : new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * The ISO week a claim is a reading of, or null: what claimId's `at` carries.
 *
 * A reading is what the 10× weekly reports (2026-11-14) showed folding
 * together: a figure in a statement of one week relative to its report's
 * (WEEK_WORD; a comparison beside it, 较上周, is not its period) that names no
 * other time (OTHER_TIME). Its week is
 *   - the week of the date the source gives the claim (a window inside one
 *     ISO week, an open window from a day of it, or an event in it), by its
 *     stored calendar date (calendarDay); but when the statement says N weeks
 *     back, the report is dated on a weekday and that date is the report's own
 *     week (the extractor gave the report's dates), N weeks before it;
 *   - else N weeks before the week of the document's date (`observedAt`),
 *     counted from the document's own ISO week, a weekend's included;
 *   - else none: a reading no date places stays one claim, as on main.
 * When a document's date changes, its relative readings change week and id:
 * src/graph/claim-rekey.ts (rekeyClaims) moves them with what was decided.
 */
export function readingWeek(c: {
  statement: string;
  eventAt?: string | Date | null;
  validFrom?: string | Date | null;
  validTo?: string | Date | null;
  observedAt?: string | Date | null;
}): string | null {
  const text = c.statement.normalize('NFKC').replace(COMPARISON, ' ');
  const words = [...text.matchAll(WEEK_WORD)].map((m) => m[0]);
  if (words.length === 0) return null;
  const back = new Set(words.map(weeksBack));
  if (back.size > 1) return null; // two weeks in one statement (上周及本周): no one week's reading
  const rest = text.replace(WEEK_WORD, ' ');
  if (OTHER_TIME.test(rest) || !hasFigure(rest)) return null;
  const n = [...back][0];
  const from = isoOf(c.validFrom) ?? isoOf(c.eventAt);
  const doc = isoOf(c.observedAt);
  const weekBefore = (day: number) => isoWeekOf(day - n * 7 * 86_400_000);
  if (from) {
    const start = calendarDay(from);
    const to = isoOf(c.validFrom) ? isoOf(c.validTo) : null;
    if (to && isoWeekOf(calendarDay(to)) !== isoWeekOf(start)) return null;
    // dates the extractor gave the week the word names are taken as they are; only a weekday
    // report that gave "上周" / "两周前" its own week is read N weeks back. A report written on a
    // weekend may call the week it closes 上周, so its own week stands there too
    if (n > 0 && doc) {
      const docDay = calendarDay(doc);
      const weekday = new Date(docDay).getUTCDay();
      if (weekday >= 1 && weekday <= 5 && isoWeekOf(docDay) === isoWeekOf(start)) return weekBefore(start);
    }
    return isoWeekOf(start);
  }
  return doc ? weekBefore(calendarDay(doc)) : null;
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
