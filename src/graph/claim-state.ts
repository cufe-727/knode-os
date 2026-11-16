import { codeOf } from './identity.js';
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
  ['状态', '现状', '当前状态', '项目状态', '风险状态', '事故状态', '处理状态', '跟进状态'],
  ['status', 'state'],
  ['阶段', '当前阶段', '所处阶段'],
  ['stage', 'phase'],
  ['计划上线', '上线时间', '计划上线时间', '预计上线', '预计上线时间', '上线计划', '计划上线日期'],
  ['planned launch', 'launch date', 'go-live', 'go live'],
  ['级别', '等级', '严重级别', '严重等级', '严重程度', '事故级别', '事故等级', '故障级别', '故障等级', '风险等级', '风险级别'],
  ['severity', 'severity level', 'incident severity'],
];

const SYNONYM: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const group of ATTRIBUTE_SYNONYMS) for (const s of group) if (!m.has(s)) m.set(s, group[0]);
  return m;
})();

/** Keys whose value is a text (a person, a stage), read from "<key>为<text>". */
const TEXT_KEYS = new Set(['负责人', 'lead', '状态', 'status', '阶段', 'stage']);

/** Keys of a state or a stage, whose object, when a person, is who handles it. */
const STATE_KEYS = new Set(['状态', 'status', '阶段', 'stage']);

/** The object of a claim as series identity reads it. */
export interface SeriesObject {
  id: string | null | undefined;
  name?: string | null;
  type?: string | null;
}

/**
 * The object a series of `attribute` is kept apart by: a series is one
 * attribute of one thing, so a claim toward an object is a series of that
 * object ("电池业务由李四负责" and "云业务由张三负责" are two owners of 比亚迪), and a
 * claim with no object one of its own. Two exceptions, where the object is
 * not a thing the attribute belongs to:
 *   - the object is the value itself: 负责人 = 廖欣 with 廖欣 as the object;
 *   - a person named on a state or stage line ("R-03由赖艳负责，处于跟进中"):
 *     who handles it, not a part of it.
 * Read on the attribute's synonym head, so a stored 跟进人 is an owner.
 */
export function seriesObject(attribute: string | null | undefined, object: SeriesObject | string | null | undefined, valueText?: string | null): string {
  const o: SeriesObject = typeof object === 'string' || object == null ? { id: object ?? null } : object;
  if (!o.id) return '';
  const head = attributeHead(attribute);
  if (head && TEXT_KEYS.has(head)) {
    const bare = (n: string) => fold(n.replace(/[（(][^）)]*[）)]$/u, ''));
    if (valueText && o.name && bare(o.name) === bare(valueText)) return '';
    if (STATE_KEYS.has(head) && o.type === 'person') return '';
  }
  return o.id;
}

/** Kind words written before or after a name: 风险R-54, 事故INC-001, Orion项目. */
const KIND_WORDS = /^(?:风险|事故|故障|项目|公司|集团|系统|平台|团队|小组|部门|工程|方案|计划|risk|incident|project|company|the)+|(?:风险|事故|故障|项目|公司|集团|系统|平台|团队|小组|部门)+$/giu;

/** Where an owner or a state is said, what stands before it is what the owner or state is of. */
const OWNER_AT = /(?:改为|转为|仍然|依然|统一|继续|暂时|正式|后续|今后|改|现|交|转|仍|已|将|拟|均|暂){0,2}\s*(?:由|归)\s*[\p{Script=Han}A-Za-z·]{2,12}?\s*(?:负责|牵头|主导|跟进)|(?:的)?(?:负责人|牵头人|责任人|跟进人)\s*(?:(?:变更|更换|调整|改|换|变)为|为|是|：|:)|\b(?:is )?(?:led|owned|run) by\b|\b(?:lead|owner)\s+(?:is|was|:)/iu;
const STATE_AT = /(?:的)?(?:状态|阶段)\s*(?:为|是|：|:)|\b(?:status|stage|phase)\s+(?:is|was|:)/iu;

/**
 * What an owner or a state statement is about when the claim carries no
 * object: the last clause before "由张三负责" / "负责人为" / "状态为", without
 * the subject's own spellings and function words. "" when that is the subject
 * itself ("R-03由赖艳负责", "Atlas负责人是廖欣" of Orion, formerly Atlas). The
 * model often leaves the object out: "云业务由张三负责" and "电池业务由李四负责",
 * both filed under 比亚迪, are the owners of two businesses, not one owner
 * changing.
 */
export function statementObject(statement: string, attribute: string | null | undefined, spellings: readonly string[], valueText?: string | null): string {
  const head = attributeHead(attribute);
  if (!head || !TEXT_KEYS.has(head)) return '';
  const text = statement.normalize('NFKC');
  const at = (STATE_KEYS.has(head) ? STATE_AT : OWNER_AT).exec(text);
  let before: string;
  if (at) before = (text.slice(0, at.index).split(/[，,;；。:：]/).pop() ?? '').trim();
  else {
    // the active voice: "张三负责云业务", what the owner (the value) is said to take on
    const active = STATE_KEYS.has(head) ? null : activeOwnerObject(text, valueText);
    if (active === null) return '';
    before = active;
  }
  before = normalizeReading(before);
  // the subject written in the clause: what follows it is the thing ("比亚迪云业务由…"), what precedes it a lead
  // phrase ("经评审R-03状态为…"); a gloss in brackets is the subject's ("R-03（支付超时）")
  const named = lastSpelling(before, spellings);
  if (named) {
    const after = before.slice(named.end).replace(BRACKETED, '').trim();
    const lead = before.slice(0, named.start).trim();
    before = !after && /\bof$/i.test(lead) ? lead.replace(/\s*\bof$/i, '') : after;
  }
  before = before.replace(BRACKETED, '').replace(LEAD_PHRASE, '');
  before = before.replace(DATE_WORDS, ' ').replace(/\s+/g, '').replace(LEADING_FUNCTION, '').replace(TRAILING_FUNCTION, '').replace(/^(?:的|之|其)+|(?:的|之)+$/u, '');
  // the kind word a name is written with ("风险R-54", "项目Orion") is not another thing
  before = before.replace(KIND_WORDS, '');
  before = normalizeReading(before);
  if (/^(?:the|its|their)$/i.test(before)) return '';
  return before.length >= 2 ? fold(before) : '';
}

/**
 * What is read, without the particles and adverbs around it that are not the
 * thing: 了 / 的 before it, an adverb left alone ("原由张三负责的…" leaves "原"),
 * "now" / "currently" and a trailing "is" ("Cloud is now owned by" → Cloud),
 * and "张三负责的云业务" → 云业务.
 */
function normalizeReading(text: string): string {
  let t = text.trim();
  for (let prev = ''; prev !== t; ) {
    prev = t;
    t = t
      .replace(/^(?:了|的)+/u, '')
      // an adverb alone ("原" of "原由张三负责…"); not the first character of a name (现金业务)
      .replace(/^(?:现|改|暂|原|仍|已|将|now|currently)$/iu, '')
      .replace(/^(?:now|currently|still)\s+/i, '')
      .replace(/\s+(?:is|was|are|were|now|currently|still|being|has been|have been)$/i, '')
      .replace(/^[\p{Script=Han}A-Za-z·、和与及]{0,12}?(?:负责|主导|牵头|管理|主管|分管|跟进)的/u, '')
      .trim();
  }
  return t;
}

/** A bracketed gloss: "R-03（支付超时）", "云业务(含海外)". */
const BRACKETED = /\([^()]*\)|\[[^\[\]]*\]|【[^【】]*】/gu;
/**
 * A phrase that opens a sentence and says when or by whose decision, not what:
 * "自2025年3月起", "从下周开始", "经评审", "经董事会决定后".
 */
const LEAD_PHRASE = /^(?:(?:自|从|于)[^起]{0,16}?(?:起|开始)|经(?:过)?[\p{Script=Han}A-Za-z]{0,8}?(?:评审|审议|审批|批准|决定|决议|讨论|研究|协商|确认|同意|评估|复核|会议)(?:后|通过)?)/u;

/** Verbs an owner takes a thing on with, written after the owner: "张三负责云业务", "李四接手电池业务". */
const OWNER_VERB = /^(?:\s*(?:、|和|与|及)\s*[\p{Script=Han}A-Za-z·]{2,4}?)*\s*(?:将|已|仍|现|也|继续|正式|开始|改为|转为|共同|一起|联合){0,2}\s*(?:负责|主导|牵头|跟进|接手|接管|分管|主管)(?!(?:人|方)(?:[为是:：，,。；;、\s]|$))/u;

/** In the active voice, the clause after the owner's verb with its "…的工作" tail dropped; null when the owner is not written so. */
function activeOwnerObject(text: string, valueText: string | null | undefined): string | null {
  const owner = valueText?.normalize('NFKC').trim();
  if (!owner || owner.length < 2) return null;
  for (let i = text.indexOf(owner); i >= 0; i = text.indexOf(owner, i + 1)) {
    const verb = OWNER_VERB.exec(text.slice(i + owner.length));
    if (!verb) continue;
    const rest = text.slice(i + owner.length + verb[0].length).split(/[，,;；。:：]/)[0] ?? '';
    return rest.replace(/(?:的)?(?:相关)?(?:工作|事宜|事务|方面|领域)$/u, '').trim();
  }
  return null;
}

/** The last place in `text` a spelling of the subject is written, longest spelling first. */
function lastSpelling(text: string, spellings: readonly string[]): { start: number; end: number } | null {
  const lower = text.toLowerCase();
  let best: { start: number; end: number } | null = null;
  for (const sp of [...spellings].map((x) => x.normalize('NFKC').trim().toLowerCase()).filter((x) => x.length >= 2).sort((a, b) => b.length - a.length)) {
    const i = lower.lastIndexOf(sp);
    if (i >= 0 && (!best || i + sp.length > best.end)) best = { start: i, end: i + sp.length };
  }
  return best;
}

/** A claim as series identity reads it: the object it carries (seriesObject), else what its statement is about (statementObject). */
export interface SeriesReading {
  statement: string;
  /** seriesObject's answer: an object id, or "". */
  object: string;
  /** statementObject's reading, when `object` is "". */
  about: string;
}

/**
 * The object part of each owner or state claim's series among one subject's
 * claims, settled against the things that subject's claims are known to be
 * about. Clause reading misses wordings ("原由张三负责的云业务现由李四负责",
 * "张三不再负责云业务，改由李四接手"), and a claim read as about nothing, or as
 * about something no other claim is about, would be a series of its own and
 * leave two current owners. So such a claim goes to the series of the one
 * known thing its statement names — an object another claim carries
 * (`objects`: key and names) or a reading of another claim; the longest when
 * one contains another. Two named, or none: as read ("" is the subject's own
 * series: "由李四负责" says nothing of 云业务). A reading another claim shares,
 * or the name of a carried object, is known already and stays.
 * Returns "~reading", an object key, or "" for each row.
 */
export function settleSeriesObjects(rows: readonly SeriesReading[], objects: readonly { key: string; names: readonly string[] }[] = []): string[] {
  const read = new Map<string, number>();
  for (const r of rows) if (!r.object && r.about) read.set(r.about, (read.get(r.about) ?? 0) + 1);
  const known: { key: string; name: string }[] = [
    ...objects.flatMap((o) => o.names.map((n) => ({ key: o.key, name: fold(n.replace(/[（(][^）)]*[）)]$/u, '')) }))),
    ...[...read.keys()].map((r) => ({ key: `~${r}`, name: r })),
  ].filter((k) => k.name.length >= 2);
  return rows.map((r) => {
    if (r.object) return r.object;
    const carried = [...new Set(known.filter((k) => !k.key.startsWith('~') && k.name === r.about).map((k) => k.key))];
    if (r.about && carried.length === 1) return carried[0];
    if (r.about && (read.get(r.about) ?? 0) >= 2) return `~${r.about}`;
    const text = fold(r.statement).replace(/\s+/g, '');
    const hits = known.filter((k) => k.name !== r.about && text.includes(k.name.replace(/\s+/g, '')));
    const longest = hits.filter((h) => !hits.some((o) => o.name !== h.name && o.name.includes(h.name)));
    const keys = [...new Set(longest.map((h) => h.key))];
    if (keys.length === 1) return keys[0];
    return r.about ? `~${r.about}` : '';
  });
}

/** Whether a key is an owner or a state (its synonym head is 负责人, 状态, 阶段 …): such claims are read for what they are about. */
export function isTextKey(attribute: string | null | undefined): boolean {
  const head = attributeHead(attribute);
  return !!head && TEXT_KEYS.has(head);
}

/** The head of a key's synonym group (跟进人 → 负责人), or the key. */
export function attributeHead(attribute: string | null | undefined): string | null {
  if (!attribute) return null;
  return SYNONYM.get(fold(attribute)) ?? attribute;
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

/**
 * A value that is a week, as one spelling: "2025-W25", "2025年第25周", "第25周"
 * and 25 with the unit 周 are W25 (with the year when one is given). An
 * extraction writes a planned launch week each of those ways; read as four
 * values of one day they never superseded each other (23 series of the 10×
 * benchmark had "several current values" that were one week).
 */
function weekValue(v: Pick<ClaimMeasure, 'valueNum' | 'valueText' | 'unit'>): { year: string | null; week: string } | null {
  if (v.valueNum !== null && v.unit === '周' && Number.isInteger(v.valueNum) && v.valueNum >= 1 && v.valueNum <= 53) return { year: null, week: String(v.valueNum) };
  if (v.valueText === null) return null;
  const t = periodText(v.valueText.normalize('NFKC').replace(/[。.\s]+$/u, ''));
  const m = /^(?:(\d{4})-)?W(\d{2})$/.exec(t);
  return m ? { year: m[1] ?? null, week: String(Number(m[2])) } : null;
}

/** The same value: numbers compared at the coarser of their precisions, texts folded, weeks however spelled. */
export function sameValue(a: Pick<ClaimMeasure, 'valueNum' | 'valueText' | 'unit'>, b: Pick<ClaimMeasure, 'valueNum' | 'valueText' | 'unit'>): boolean {
  const wa = weekValue(a);
  const wb = weekValue(b);
  if (wa && wb) return wa.week === wb.week && (!wa.year || !wb.year || wa.year === wb.year);
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
 * average, a running total, a peak. Keys with different qualifiers never
 * unify, whatever else they share: a week-on-week change is not the week's
 * value, and a report's "（对账批次间隔最初定的是15分钟）" is the setting's first
 * value, not its newest.
 */
const QUALIFIERS: readonly [string, RegExp][] = [
  ['环比', /环比|week[- ]on[- ]week|\bwow\b|month[- ]on[- ]month/i],
  ['同比', /同比|year[- ]on[- ]year|\byoy\b/i],
  ['变化', /变化|变动|增幅|降幅|涨幅|增速|增量|差值|增减|\bchange\b|\bdelta\b|\bgrowth\b/i],
  ['初始', /初始|最初|起初|原始|原定|最早|\binitial\b|\boriginal\b|\bfirst\b/i],
  ['计划', /计划|预计|预期|预测|目标|指引|\btarget\b|\bguidance\b|\bplanned\b|\bforecast\b|\bexpected\b/i],
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

/** Words that name "the value" of a thing that is a value itself (a coded setting): 配置值, 取值, 数值. */
const VALUE_WORDS = /^(?:值|取值|数值|配置值|设定值|设置值|参数值|value)$/i;

/**
 * Whether a key names the subject's own value: the subject's name (without
 * the "（平台组 · T1-C2）" a split adds), a tail of it of two characters or more
 * ("批次间隔", "间隔" of 对账批次间隔: the head of a Chinese name is its end),
 * or its code; and, for a subject that carries a code (a coded setting), a
 * generic value word (配置值, 取值). Aliases do not count — a group's aliases
 * collect what extractions listed (美联储: 联邦基金利率) — and neither does a
 * key that only shares a name's last word (零售价格 is not 猪肉价格's value).
 */
export function namesSubject(key: string, spellings: readonly string[]): boolean {
  // a qualified key ("初始间隔") names the subject's first value: compared without its qualifier, grouped with its own kind
  const k = fold(key).replace(new RegExp(QUALIFIERS.map(([, re]) => re.source).join('|'), 'gi'), '').replace(/的/g, '').trim();
  if (k.length < 2) return false;
  const names = spellings.map((s) => fold(s).replace(/的/g, '')).filter((s) => s.length >= 2);
  if (names.some((s) => s === k || (s.endsWith(k) && !codeOf(s)))) return true;
  return VALUE_WORDS.test(k) && spellings.some((s) => codeOf(s) !== null);
}

/** The spellings a key may name an entity by: its name, the name without a split's "（…）", the codes among its name parts and aliases, and — for an entity named by a code — its aliases. */
export function subjectSpellingsOf(name: string, aliases: readonly string[] = []): string[] {
  const out = new Set<string>([name]);
  const m = /^(.+?)[（(]([^）)]*)[）)]$/.exec(name.trim());
  if (m) {
    out.add(m[1].trim());
    for (const part of m[2].split(/[·・,，]/)) if (codeOf(part.trim())) out.add(part.trim());
  }
  // an entity named by its code ("T1-C3") has its names among its aliases; any other entity's aliases are what extractions listed
  const coded = codeOf(name.trim()) !== null;
  for (const a of aliases) if (coded || codeOf(a.trim())) out.add(a.trim());
  return [...out].filter((s) => s.trim().length >= 2);
}

/** A key with "的", spaces, a neutral last word (数, 数量, 值) and the change word after 环比/同比 left out: 周活跃用户数 / 周活跃用户, 环比 / 环比增幅 read alike. */
function neutralKey(key: string): string {
  return fold(key).replace(/[的\s]/g, '').replace(/(环比|同比)(?:变化|变动|增幅|增速|涨幅|增长|增减)/gu, '$1').replace(/(?:数量|数|水平)$/u, '');
}

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

/**
 * A subject's keys that are one attribute, unified. Keys of one unit and the
 * same qualifiers (keyQualifiers: a change, a first value, a plan, an
 * average, a total, a peak) are one when
 *   - one contains the other or their bigrams mostly agree (Dice ≥ 0.67):
 *     the rule claim state was built with (归母净利润 / 净利润, 销售毛利率 /
 *     毛利率, 市盈率TTM / 市盈率), kept as it was;
 *   - a synonym group holds both (事故级别 / 事故等级, 跟进人 / 负责人);
 *   - they differ by 的, spaces or a neutral last word (周活跃用户 / 周活跃用户数);
 *   - both name the subject itself (namesSubject).
 * What the qualifiers keep apart is what that rule used to join across them:
 * a week-on-week change and the week's value, a setting's first value and its
 * current one, 环比涨幅 and 同比涨幅. Keys are taken most used first (ties:
 * code-point order) and each joins the first group it is one with, as before.
 * A group's canonical key is its most used key, as before, so that an
 * upgrade rewrites as few stored mappings as it can: ties go to a name the
 * group is already stored under (`stored`, the canonical keys in
 * claim_attribute_keys), then to code-point order. One exception: a group
 * with a key of a synonym group goes by that group's head (负责人, 状态,
 * 级别), a key alone included: owner and state series are read on the head
 * (审批状态 joined with 状态 is a state), and stored keys of an older reading
 * (跟进人) move with the mapping, without re-reading their claims.
 * Returns key → canonical key, with the reason, for keys that change.
 */
export function unifyAttributeKeys(uses: AttributeUse[], spellings: readonly string[] = [], stored: ReadonlySet<string> = new Set()): Map<string, { canonical: string; reason: string }> {
  const sorted = [...uses].sort((a, b) => b.count - a.count || (a.attribute < b.attribute ? -1 : a.attribute > b.attribute ? 1 : 0));
  const unitOf = (u: AttributeUse) => [...new Set(u.units.map((x) => x || '∅'))].sort().join('|');
  type Key = { use: AttributeUse; unit: string; qualifiers: string; synonym: string | null; neutral: string; self: boolean; why: string };
  const groups: Key[][] = [];
  const related = (m: Key, k: Key): string | null => {
    if (m.synonym && m.synonym === k.synonym) return '同义';
    if (m.neutral === k.neutral) return '仅措辞不同';
    if (m.self && k.self) return '都指主体自身的取值';
    const [s, l] = m.use.attribute.length <= k.use.attribute.length ? [m.use.attribute, k.use.attribute] : [k.use.attribute, m.use.attribute];
    if ((s.length >= 2 && l.includes(s)) || dice(m.use.attribute, k.use.attribute) >= 0.67) return '同单位且名称相近';
    return null;
  };
  for (const use of sorted) {
    const k: Key = { use, unit: unitOf(use), qualifiers: keyQualifiers(use.attribute), synonym: SYNONYM.get(fold(use.attribute)) ?? null, neutral: neutralKey(use.attribute), self: namesSubject(use.attribute, spellings), why: '同义' };
    let joined = false;
    for (const g of groups) {
      if (g[0].unit !== k.unit || g[0].qualifiers !== k.qualifiers) continue;
      const why = g.map((m) => related(m, k)).find(Boolean);
      if (!why) continue;
      k.why = why;
      g.push(k);
      joined = true;
      break;
    }
    if (!joined) groups.push([k]);
  }
  const out = new Map<string, { canonical: string; reason: string }>();
  for (const keys of groups) {
    const head = keys.find((k) => k.synonym)?.synonym;
    // keys are in count order: the most used, a tie going to the name already stored, then code point
    const top = keys.filter((k) => k.use.count === keys[0].use.count);
    const canonical = head ?? (top.find((k) => stored.has(k.use.attribute)) ?? top[0]).use.attribute;
    for (const k of keys) {
      if (k.use.attribute === canonical) continue;
      out.set(k.use.attribute, { canonical, reason: `与"${canonical}"${k.why}（${k.use.count} 条断言）` });
    }
  }
  return out;
}
