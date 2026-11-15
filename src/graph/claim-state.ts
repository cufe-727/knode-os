/**
 * Claim state (docs/design/29). A measure-like claim — "风控引擎完成度为11%",
 * "支付组在岗人数为7人", "Orion项目负责人为孙欣", "Atlas completion is 68%" — says
 * subject + attribute + value (+ unit) at a date. Read that way, the claims of
 * one attribute form a series: the newest is the current value, the others its
 * history, and two of them are never "duplicates" a model has to judge.
 *
 * The model is asked for attribute / value / unit with each claim; this module
 * normalizes what it says and, where it said nothing (sidecars written before,
 * frontmatter, a model that left the fields out), reads the statement itself,
 * without a model call. It is conservative: a statement it cannot read as one
 * attribute and one value gets no attribute and stays an ordinary fact.
 *
 * Keys are normalized globally here (synonyms, subject and date words left
 * out); refine then unifies a subject's near-synonym keys (unifyAttributeKeys,
 * stored in claim_attribute_keys), so 完成度 and 进度 of one project are one
 * series without a model call per claim.
 */

/** Bump when the reading changes: rows read by an older version are read again (refine's backfill). */
export const CLAIM_STATE_VERSION = 1;

export interface ClaimMeasure {
  /** The normalized attribute key. */
  attribute: string;
  valueNum: number | null;
  valueText: string | null;
  unit: string | null;
}

/** Synonym groups: every spelling maps to the group's first. Chinese and English keep their own keys. */
const ATTRIBUTE_SYNONYMS: readonly string[][] = [
  ['进度', '完成度', '完成率', '完成进度', '进展', '整体进度', '项目进度', '开发进度'],
  ['progress', 'completion', 'percent complete', 'completion rate', 'completed'],
  ['在岗人数', '在岗', '在岗人员', '在岗人员数', '人数', '团队人数', '员工人数', '人员', '人员规模', '在职人数', '编制'],
  ['headcount', 'staff', 'team size', 'staff count', 'employees'],
  ['负责人', '负责', '主负责人', '牵头人', '项目负责人', '责任人', '跟进人', '跟进负责人', 'owner'],
  ['lead', 'owner', 'project lead'],
  ['状态', '现状', '当前状态', '项目状态'],
  ['status', 'state'],
  ['阶段', '当前阶段', '所处阶段'],
  ['stage', 'phase'],
  ['计划上线', '上线时间', '计划上线时间', '预计上线', '预计上线时间', '上线计划', '计划上线日期'],
  ['planned launch', 'launch date', 'go-live', 'go live'],
];

const SYNONYM: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const group of ATTRIBUTE_SYNONYMS) for (const s of group) if (!m.has(s)) m.set(s, group[0]);
  return m;
})();

/** Keys whose value is a text (a person, a stage), read from "<key>为<text>". */
const TEXT_KEYS = new Set(['负责人', 'lead', '状态', 'status', '阶段', 'stage']);

/**
 * The object a series of `attribute` is kept apart by. A measure of a subject
 * toward one object is a series per object (a holding in each company); the
 * owner or the state of a subject is one series whatever the claim names
 * besides: "R-03由赖艳负责，处于跟进中" and "R-03已关闭" are one state, and
 * "负责人为廖欣" / "负责人为孙欣" — whose object is the value itself — one
 * owner. Kept apart by object, a risk closed in week 19 stayed open beside it
 * (108 of 120 risks on the 10× benchmark had two or more current states).
 */
export function seriesObject(attribute: string | null | undefined, objectId: string | null | undefined): string {
  if (attribute && TEXT_KEYS.has(attribute)) return '';
  return objectId ?? '';
}

/** Verbs and hedges between an attribute and its value, longest first. */
const LINKS_ZH = ['更正为', '修正为', '调整为', '下降至', '提升至', '提高至', '增加至', '减少至', '维持在', '保持在', '仍然为', '约为', '应为', '可能为', '预计为', '达到了', '达到', '升至', '降至', '增至', '减至', '变为', '已达', '仍为', '依然为', '为', '是', '达', '约', '有', '：', ':', '='];
const LINKS_EN = /\s*(?:is now|was revised to|was corrected to|stood at|rose to|fell to|increased to|decreased to|dropped to|grew to|reached|is|was|are|were|at|of|to|:|=)\s*$/i;
/** Date and period words that say when, not what: left out of an attribute key. */
const DATE_WORDS = /(?:(?:fy|FY)\s*\d{2,4}|\d{4}\s*(?:年度?|财年)?\s*(?:[qQ][1-4]|[hH][12]|[上下]半年|第?[一二三四1-4]季度)|[qQ][1-4]|[hH][12]\b|\d{4}\s*(?:年度?|财年)(?!\d)|[上下]半年|第?[一二三四]季度)\s*|(?:\d{4}\s*年)?\s*(?:第?\s*\d{1,2}\s*(?:周|月份?|季度|日|号)|[一二三四五六七八九十]+月份?|[上下本今去明]+(?:周|月|季度|年)|本周末?|当前|目前|截至|截止|现阶段|最新|月报中|周报中|月报|周报|中的?|期间|同期|累计)\s*/g;
const HEDGES = /^(?:可能|大约|约|预计|估计|仍|已经|已|当前|目前|现)+/;
const TRAILING_FUNCTION = /(?:的|之|其|共|总|合计|总计|达|为|是|在|于|将|已|仍|再|都|也|还|又|共计)+$/;
const LEADING_FUNCTION = /^(?:的|其|该|此|这个|项目|系统|组|团队|整体|总体|本周|本月|本期|上期|初步|估计|评估|预估|报告|记录|显示|所列|统计|实际|最新)+/;

/** NFKC, lower case, spaces collapsed. */
function fold(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The key a spelling of an attribute stands for: synonyms, then the subject's
 * name, date words and function words left out. Returns null for something
 * that is not a plausible key (empty, a clause, too long).
 */
export function normalizeAttribute(raw: unknown, subject?: string | null): string | null {
  if (typeof raw !== 'string') return null;
  let s = fold(raw).replace(/[“”"'`'‘’《》「」【】()（）[\]]/g, '');
  const direct = SYNONYM.get(s);
  if (direct) return direct;
  if (subject) {
    for (const spelling of subjectSpellings(subject)) {
      if (spelling && s.includes(spelling)) s = s.split(spelling).join(' ');
    }
  }
  s = s.replace(DATE_WORDS, ' ').replace(/\s+/g, ' ').trim();
  // the last clause of what is left names the attribute ("支付组本周的在岗人数" → 在岗人数)
  s = s.split(/[,，、;；。]|的(?=[^的]{2,}$)/).pop()!.trim();
  s = s.replace(LEADING_FUNCTION, '').replace(TRAILING_FUNCTION, '').replace(HEDGES, '').trim();
  s = s.replace(/^(?:the|its|their|a|an)\s+/i, '').replace(/^'s\s+/, '').trim();
  if (!s) return null;
  const syn = SYNONYM.get(s);
  if (syn) return syn;
  // a key is a name, not a clause: short, no sentence punctuation, no aspect particle
  const cjk = /[一-鿿]/.test(s);
  if (cjk ? s.length > 10 || s.length < 2 : s.split(' ').length > 4 || s.length < 3) return null;
  if (/[了着过吗呢吧]|[!?！？]/.test(s)) return null;
  if (/\d/.test(s)) return null;
  return s;
}

function subjectSpellings(subject: string): string[] {
  const f = fold(subject);
  const out = new Set([f]);
  // "Orion项目", "风控引擎系统": the subject with its kind word
  for (const tail of ['项目', '系统', '平台', '团队', '小组', 'project', 'team']) out.add(`${f}${tail}`);
  return [...out].sort((a, b) => b.length - a.length);
}

const UNITS: Record<string, string> = {
  '%': '%', '％': '%', 个百分点: 'pp', pct: 'pp', pp: 'pp', 人: '人', 名: '人', 位: '人', 个: '个', 项: '项', 件: '件', 次: '次', 天: '天', 小时: '小时',
  元: '元', 万元: '万元', 亿元: '亿元', 亿: '亿', 万: '万', 千: '千', 倍: '倍', 分: '分', 条: '条', 台: '台', 家: '家', 户: '户', 单: '单',
  ms: 'ms', s: 's', kg: 'kg', km: 'km', usd: 'usd', '$': 'usd', people: '人', persons: '人', person: '人', percent: '%',
  billion: 'billion', bn: 'billion', million: 'million', trillion: 'trillion',
};
const UNIT_RE = '个百分点|万元|亿元|小时|percent|people|persons|person|billion|million|trillion|bn|pct|pp|ms|kg|km|usd|[%％人名位个项件次天元亿万千倍分条台家户单s]';
/** A number with its unit, not part of a date, a ticket or a code ("2025年", "第35周", "T2-1420", "R-05"). */
const MEASURE = new RegExp(
  `(?<![A-Za-z\\d.\\-_/])([+-]?\\d+(?:,\\d{3})*(?:\\.\\d+)?)\\s*(${UNIT_RE})?(?![\\d\\-_/]|年|月|日|号|周|季|期|版|代|级|楼|点|:)`,
  'giu',
);

/** A unit spelled as the statement spelled it, normalized; unknown spellings are kept as they are. */
export function normalizeUnit(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const u = fold(raw);
  return UNITS[u] ?? u.slice(0, 16);
}

const LATIN_UNIT_WORDS = /^(?:percent|people|persons|person|billion|million|trillion|bn|pct|pp|ms|kg|km|usd|s)$/i;

/** Statements with these words correct an earlier report. */
const CORRECTION = /更正|勘误|订正|纠正|有误|数字错误|应为|修正为|更正为|此前(?:报告|数据)?(?:有误|错误)|\bcorrect(?:ed|ion)\b|\berrat(?:um|a)\b|\bshould have been\b|\bmisreported\b/i;

export function isCorrectionStatement(statement: string): boolean {
  return CORRECTION.test(statement.normalize('NFKC'));
}

/** "由孙欣负责" → 负责人 孙欣. */
const OWNER_ZH = /由\s*([\p{Script=Han}A-Za-z·]{2,12}?)\s*(?:负责|牵头|主导)/u;
const OWNER_EN = /\b(?:led|owned|run) by ([A-Z][\w.-]*(?: [A-Z][\w.-]*){0,2})/;
/** "计划于2025年第35周上线", "预计第31周上线": the planned launch, as text. */
const LAUNCH_ZH = /(?:计划|预计|将|定于)\s*(?:于|在)?\s*((?:\d{4}\s*年)?\s*(?:第\s*\d{1,2}\s*周|\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?|q[1-4]|[一二三四]季度|\d{4}-\d{2}(?:-\d{2})?|\d{4}-w\d{1,2}))\s*(?:上线|发布|交付|完成)/iu;

/** A planned period as text, one spelling per period: "2025年第35周" → "2025-W35", "第30周" → "W30". */
function periodText(raw: string): string {
  const t = raw.replace(/\s+/g, '').toUpperCase();
  const year = /^(\d{4})(?:年|-)?/.exec(t);
  const rest = year ? t.slice(year[0].length) : t;
  let m: RegExpExecArray | null;
  let p = rest;
  if ((m = /^第(\d{1,2})周$/.exec(rest)) || (m = /^W(\d{1,2})$/.exec(rest))) p = `W${m[1].padStart(2, '0')}`;
  else if ((m = /^(\d{1,2})月(?:(\d{1,2})日)?$/.exec(rest))) p = m[2] ? `${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : m[1].padStart(2, '0');
  else if ((m = /^([一二三四])季度$/.exec(rest))) p = `Q${'一二三四'.indexOf(m[1]) + 1}`;
  return year ? `${year[1]}-${p}` : p;
}

/**
 * Read one attribute and one value out of a statement, or null. The first
 * measure in the statement counts ("支付成功率为97.46%，环比+0.06%" → 支付成功率
 * 97.46 %); a number that is part of a date, a ticket or a code is no value.
 */
export function parseMeasure(statement: string, subject?: string | null): ClaimMeasure | null {
  const text = statement.normalize('NFKC').trim();
  if (!text) return null;

  for (const m of text.matchAll(MEASURE)) {
    const at = m.index ?? 0;
    const unitRaw = m[2];
    // a bare number (no unit) only counts right after a link word ("评分为4.5")
    let before = text.slice(0, at);
    const linkZh = LINKS_ZH.find((l) => before.trimEnd().endsWith(l));
    const linkEn = LINKS_EN.exec(before);
    if (!unitRaw && !linkZh && !linkEn) continue;
    // a Latin unit glued to a following word is a word ("5 steps")
    if (unitRaw && LATIN_UNIT_WORDS.test(unitRaw) && /^[a-z]/i.test(text.slice(at + m[0].length))) continue;
    if (linkZh) before = before.trimEnd().slice(0, before.trimEnd().length - linkZh.length);
    else if (linkEn) before = before.slice(0, linkEn.index);
    // the clause the value belongs to
    const clause = before.split(/[，,;；。:：]/).pop() ?? before;
    const attribute = normalizeAttribute(clause, subject);
    if (!attribute) return null;
    const value = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(value)) return null;
    return { attribute, valueNum: value, valueText: null, unit: normalizeUnit(unitRaw ?? '') };
  }

  const owner = OWNER_ZH.exec(text) ?? OWNER_EN.exec(text);
  if (owner) return { attribute: /[一-鿿]/.test(text) ? '负责人' : 'lead', valueNum: null, valueText: owner[1].trim(), unit: null };

  const launch = LAUNCH_ZH.exec(text);
  if (launch) return { attribute: '计划上线', valueNum: null, valueText: periodText(launch[1]), unit: null };

  // "<key>为<text>" for the keys whose value is a text (负责人, 状态, 阶段)
  for (const link of ['为', '是', '：', ':']) {
    const i = text.indexOf(link);
    if (i <= 0) continue;
    const key = normalizeAttribute(text.slice(0, i), subject);
    if (!key || !TEXT_KEYS.has(key)) continue;
    const value = text.slice(i + link.length).replace(/[。.!！]+$/, '').trim();
    if (value && value.length <= 24 && !/[，,;；]/.test(value)) return { attribute: key, valueNum: null, valueText: value, unit: null };
  }
  const en = /^(?:.*?\s)?(status|stage|phase|lead|owner)\s+(?:is|was|:)\s+(.{1,40}?)[.!]?$/i.exec(text);
  if (en) {
    const key = SYNONYM.get(en[1].toLowerCase()) ?? en[1].toLowerCase();
    return { attribute: key, valueNum: null, valueText: en[2].trim(), unit: null };
  }
  return null;
}

/**
 * The measure of a claim: what the extractor stated (normalized), else what
 * the statement reads as. A stated attribute with no usable value falls back
 * to the statement's value.
 */
export function claimMeasure(
  c: { statement: string; attribute?: unknown; value?: unknown; unit?: unknown },
  subject?: string | null,
): ClaimMeasure | null {
  const parsed = parseMeasure(c.statement, subject);
  const stated = normalizeAttribute(c.attribute, subject);
  if (!stated) return parsed;
  let valueNum: number | null = null;
  let valueText: string | null = null;
  if (typeof c.value === 'number' && Number.isFinite(c.value)) valueNum = c.value;
  else if (typeof c.value === 'string' && c.value.trim()) {
    const n = Number(c.value.replace(/[,%％\s]/g, ''));
    if (/^-?[\d,]+(?:\.\d+)?\s*[%％]?$/.test(c.value.trim()) && Number.isFinite(n)) valueNum = n;
    else valueText = c.value.trim().slice(0, 80);
  }
  if (valueNum === null && valueText === null) {
    if (!parsed) return null;
    return { ...parsed, attribute: stated };
  }
  const unit = normalizeUnit(c.unit) ?? (typeof c.value === 'string' && /[%％]\s*$/.test(c.value) ? '%' : null) ?? (valueNum !== null ? parsed?.unit ?? null : null);
  return { attribute: stated, valueNum, valueText, unit };
}

/** The same value: numbers compared at the coarser of their precisions, texts folded. */
export function sameValue(a: Pick<ClaimMeasure, 'valueNum' | 'valueText' | 'unit'>, b: Pick<ClaimMeasure, 'valueNum' | 'valueText' | 'unit'>): boolean {
  if ((a.unit ?? '') !== (b.unit ?? '')) return false;
  if (a.valueNum !== null && b.valueNum !== null) {
    const decimals = (n: number) => (String(n).split('.')[1]?.length ?? 0);
    const scale = 10 ** Math.min(decimals(a.valueNum), decimals(b.valueNum));
    return Math.round(a.valueNum * scale + 1e-9) === Math.round(b.valueNum * scale + 1e-9);
  }
  if (a.valueText !== null && b.valueText !== null) return fold(a.valueText) === fold(b.valueText);
  return false;
}

/** A value as a page shows it: "75%", "7人", "孙欣". */
export function formatValue(c: { value_num?: number | null; value_text?: string | null; unit?: string | null }): string {
  if (c.value_num !== null && c.value_num !== undefined) {
    const n = Number(c.value_num);
    const unit = c.unit ?? '';
    const sep = /^[a-z]/i.test(unit) ? ' ' : '';
    return `${Number.isInteger(n) ? n : Number(n.toFixed(4))}${unit === 'pp' ? ' pp' : `${sep}${unit}`}`;
  }
  return c.value_text ?? '';
}

/* ------------------------- per-subject key unification ------------------------- */

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  const t = s.replace(/\s+/g, '');
  for (let i = 0; i + 2 <= t.length; i++) out.add(t.slice(i, i + 2));
  if (t.length === 1) out.add(t);
  return out;
}

function dice(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  let shared = 0;
  for (const g of x) if (y.has(g)) shared++;
  return (2 * shared) / Math.max(1, x.size + y.size);
}

export interface AttributeUse {
  attribute: string;
  /** How many claims of the subject use it. */
  count: number;
  /** Units it was read with; keys only unify when they measure in one unit (or both carry text). */
  units: string[];
}

/**
 * The qualifiers that make a key another measure of the same thing: a change
 * (环比 / 同比 / 变化), the first value (初始 / 最初), a plan or forecast, an
 * average, a running total, a peak. "支付成功率环比变化" contains
 * "支付成功率" and "初始间隔" contains "间隔", but neither is that measure:
 * unified with it, a week-on-week change of +0.04% stood beside the week's
 * 98.64% as a second current value of one day, and a report's "（对账批次间隔
 * 最初定的是15分钟）" became the setting's newest value.
 */
const QUALIFIERS: readonly [string, RegExp][] = [
  ['环比', /环比|week[- ]on[- ]week|\bwow\b|month[- ]on[- ]month/i],
  ['同比', /同比|year[- ]on[- ]year|\byoy\b/i],
  ['变化', /变化|变动|增幅|降幅|涨幅|增速|增量|差值|增减|\bchange\b|\bdelta\b|\bgrowth\b/i],
  ['初始', /初始|最初|起初|原始|原定|最早|\binitial\b|\boriginal\b|\bfirst\b/i],
  // not 目标 / target: an extraction labels a setting put back ("决定改回原来的80分") 目标阈值
  ['计划', /计划|预计|预期|预测|\bplanned\b|\bforecast\b|\bexpected\b/i],
  ['平均', /平均|均值|\baverage\b|\bmean\b/i],
  ['累计', /累计|累积|\bcumulative\b|\bytd\b/i],
  ['峰值', /峰值|最高|最大|\bpeak\b|\bmax(?:imum)?\b/i],
  ['最低', /最低|最小|\bmin(?:imum)?\b/i],
];

/** Which qualifiers a key carries; a change word goes with the period it is a change over. */
export function keyQualifiers(key: string): string {
  const q = QUALIFIERS.filter(([, re]) => re.test(key)).map(([k]) => k);
  const period = q.includes('环比') || q.includes('同比');
  return q.filter((k) => !(period && k === '变化')).join('+');
}

/**
 * Keys that name the value of the subject itself: "配置值", "取值", "数值",
 * or a spelling of the subject (its name without the "（平台组 · T1-C2）" a
 * split adds, an alias, a code) or a part of one ("批次间隔", "间隔" of
 * 对账批次间隔). A setting reported as "对账批次间隔定为15分钟", "批次间隔从本周
 * 起调整为30分钟" and "T2-C2调整为20分钟" was three series (批次间隔 / 间隔 /
 * 配置值), each with a current value of its own.
 */
const VALUE_WORDS = /^(?:值|取值|数值|配置值|设定值|设置值|参数值|当前值|配置|设定|设置|参数|配置数值|value|setting|current value)$/i;

/** The head words of a name that is a measure, not a thing that has measures: 上限, 时长, 天数, 金额, 分数线 … */
const MEASURE_HEAD = /(?:上限|下限|阈值|时长|天数|间隔|金额|额度|配额|比例|比率|分数线|分数|数量|次数|人数|周期|期限|费率|利率|价格|单价)$/u;

export function namesSubject(key: string, spellings: readonly string[]): boolean {
  const bare = key.replace(new RegExp(QUALIFIERS.map(([, re]) => re.source).join('|'), 'gi'), '').trim();
  if (!bare) return false;
  if (VALUE_WORDS.test(bare)) return true;
  return spellings.some((sp) => {
    const s = fold(sp);
    if (s.length < 2 || bare.length < 2) return false;
    // the head of a name is its end: 间隔 names 对账批次间隔, 增长 does not name 增长组; a key
    // with the head of a name that is a measure itself (…上限, …时长) is that measure's value
    if (s === bare || s.endsWith(bare)) return true;
    if (/^\p{Script=Han}+$/u.test(s) && /^\p{Script=Han}+$/u.test(bare) && s.length >= 4 && bare.length >= 3 && MEASURE_HEAD.test(s) && s.slice(-2) === bare.slice(-2)) return true;
    const rest = bare.split(s).join('').trim();
    return bare.includes(s) && (!rest || VALUE_WORDS.test(rest));
  });
}

/** The spellings of an entity a key may name it by: its name, the name without a split's "（…）", the codes and aliases. */
export function subjectSpellingsOf(name: string, aliases: readonly string[] = []): string[] {
  const out = new Set<string>([name, ...aliases]);
  const m = /^(.+?)[（(]([^）)]*)[）)]$/.exec(name.trim());
  if (m) {
    out.add(m[1].trim());
    for (const part of m[2].split(/[·・,，]/)) if (/\d/.test(part) && /[A-Za-z]/.test(part)) out.add(part.trim());
  }
  return [...out].filter((s) => s.trim().length >= 2);
}

/**
 * A subject's near-synonym keys, unified: two keys of one unit join when one
 * contains the other (在岗 / 在岗人数) or their bigrams mostly agree (Dice ≥
 * 0.67: 支付成功率 / 支付的成功率), and only when they carry the same
 * qualifiers (keyQualifiers: 支付成功率环比 is not 支付成功率). Keys that name
 * the subject itself (namesSubject, given the subject's `spellings`) are one
 * key per qualifier. The most used key of a group names it.
 * Returns key → canonical key, with the reason, for keys that change.
 */
export function unifyAttributeKeys(uses: AttributeUse[], spellings: readonly string[] = []): Map<string, { canonical: string; reason: string }> {
  const sorted = [...uses].sort((a, b) => b.count - a.count || a.attribute.localeCompare(b.attribute));
  const unitOf = (u: AttributeUse) => [...new Set(u.units.map((x) => x || '∅'))].sort().join('|');
  const groups: { head: AttributeUse; unit: string; qualifiers: string; self: boolean; members: AttributeUse[] }[] = [];
  const out = new Map<string, { canonical: string; reason: string }>();
  for (const use of sorted) {
    const unit = unitOf(use);
    const qualifiers = keyQualifiers(use.attribute);
    const self = namesSubject(use.attribute, spellings);
    const group = groups.find((g) => {
      if (g.unit !== unit || g.qualifiers !== qualifiers) return false;
      if (self && g.self) return true;
      return g.members.some((m) => {
        const [s, l] = m.attribute.length <= use.attribute.length ? [m.attribute, use.attribute] : [use.attribute, m.attribute];
        return (s.length >= 2 && l.includes(s)) || dice(m.attribute, use.attribute) >= 0.67;
      });
    });
    if (!group) {
      groups.push({ head: use, unit, qualifiers, self, members: [use] });
      continue;
    }
    group.members.push(use);
    group.self ||= self;
    const why = self && group.self ? '都指主体自身的取值' : '同单位且名称相近';
    out.set(use.attribute, { canonical: group.head.attribute, reason: `与"${group.head.attribute}"${why}（${use.count} 条断言）` });
  }
  return out;
}
