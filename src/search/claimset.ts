import { Store } from '../store/db.js';
import { toDateString } from '../store/temporal.js';
import { isListQuestion } from './excerpts.js';
import { QuestionRoute } from './route.js';
import { typedColumns } from './enumerate.js';

/**
 * A set, a count or a state computed from the claims (docs/design/34 §1).
 *
 * A list, count or "value as of" question was answered from the claims a
 * search and a ranking happened to reach: 8 chunks and 24–150 facts. On the
 * 10× reports benchmark that held every weekly value of a metric for no
 * structured question, and every incident of a division for few. Here the
 * question is read by rules into what it asks of the claims —
 *
 *   scope      the organisations it names (a team, a division and its teams),
 *              or the whole knowledge base when it says so ("全公司", "company-wide")
 *   what       the attribute keys and the statement terms it shares with the
 *              claims in that scope, and a value it names ("P1")
 *   operation  list, count, max / min / mean / sum, or the value as of a date
 *   grouping   by member organisation, by parent, by quarter, month or week
 *   filters    a threshold ("低于99.917%"), a least count ("两起及以上"), a
 *              period (a year, or a quarter / half / month of the data's year),
 *              a state the item must not be in ("没有关闭")
 *
 * — and every matching claim in the scope is read, counted, grouped and
 * filtered in code, each row with its date and its sources. The answer is
 * still written by the model, from this complete set.
 *
 * Where rules end. The words that name the scope, the operation and the
 * grouping are closed classes; the words that name what is counted are not:
 * "离职" in a question and "已离开公司" in a report share no word, and no rule
 * here maps one to the other (a model, or an attribute vocabulary shared by
 * the extractor, would). A question none of whose words reach a claim gets no
 * computed set and is answered as before.
 */

export type SetOp = 'list' | 'count' | 'max' | 'min' | 'mean' | 'sum' | 'value';
export type SetGroup = 'member' | 'parent' | 'quarter' | 'month' | 'week';

export interface SetQuestion {
  op: SetOp;
  groupBy: SetGroup[];
  /** Readings compared with a figure the question gives, in the unit it gives it in ("1万亿元"), when it gives one. */
  threshold?: { cmp: '<' | '<=' | '>' | '>='; value: number; unit?: string };
  /** Items related to at least this many others ("修复过两起及以上事故的人"). */
  atLeast?: number;
  /** The date a value is asked as of (YYYY-MM-DD). */
  asOf?: string;
  /** The question names the whole knowledge base as its scope. */
  company: boolean;
  /**
   * The window the question's own words give (ISO days): a relative one read from today ("去年", "上季度",
   * "近3个月", "last year"), a fiscal year ("2025财年"), a quarter, half or month in the question's own year or
   * else today's ("三季度", "截至三季度" from the year's start). Absent when it names none; the router's
   * explicit range, when it has one, comes first.
   */
  period?: { from: string | null; to: string | null; text: string };
  /** It names a period in words no rule reads ("最近", "recently"): nothing is computed. */
  unreadPeriod?: boolean;
  /** The kind of entity the question asks for, when its words say. */
  asks?: 'person' | 'organization' | 'event' | 'project';
  /** A state the items must not be in ("没有关闭" → 关闭). */
  notIn?: string;
  /** "截至第44周", "through week 44": the reports' own week numbering, read off their titles. */
  throughWeek?: number;
  /** The question with the names, the scope and the closed-class words taken out: what it asks about. */
  rest: string;
}

/** Live claims read for one computed set at most; past this the set says it may be incomplete. */
export const SET_SCAN_CAP = 20000;
/** Milliseconds a computed set may take by default; past them nothing is computed. */
export const SET_BUDGET_MS = 1000;
/** People read from the mentions of a set's claims at most. */
const PEOPLE_CAP = 2000;
/** Rows a computed set hands the model at most (the facts it joins are capped at the enumerate limit). */
export const SET_ROWS = 100;
/** Characters of computed lines the prompt is given at most; past them, item lines are cut and the block says how many. */
export const SET_BLOCK_CHARS = 6000;

/**
 * The lines within `SET_BLOCK_CHARS`: every line that is no item ("12 distinct …", "Q1: 3", "Left out: …") is
 * kept, item lines ("- …") in order while there is room, and a last line says how many were cut — the counts
 * cover them.
 */
export function boundLines(lines: string[], budget = SET_BLOCK_CHARS): string[] {
  const total = lines.reduce((n, l) => n + l.length + 1, 0);
  if (total <= budget) return lines;
  let room = budget - lines.filter((l) => !l.startsWith('- ')).reduce((n, l) => n + l.length + 1, 0);
  let cut = 0;
  const out: string[] = [];
  for (const l of lines) {
    if (!l.startsWith('- ')) { out.push(l); continue; }
    if (room - (l.length + 1) >= 0) { out.push(l); room -= l.length + 1; } else cut++;
  }
  if (cut) out.push(`… ${cut} more lines not shown (the counts above cover them; the rows listed are a sample).`);
  return out;
}
/** Rows of one item listed at most (its first and its latest are always among them). */
const ROWS_PER_ITEM = 4;

const CN_NUM: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const numOf = (s: string) => (/^\d+$/.test(s) ? Number(s) : CN_NUM[s] ?? NaN);

const ASKS: [SetQuestion['asks'], RegExp][] = [
  ['person', /^(?:[^，。？?]{0,3}?)(?:人|谁|员工|成员|同事|工程师|负责人)|\b(?:people|persons?|who|employees?|engineers?|members?)\b/i],
  ['organization', /^(?:[^，。？?]{0,3}?)(?:客户|公司|厂商|供应商|合作方)|\b(?:customers?|clients?|companies|vendors?|suppliers?)\b/i],
  ['event', /^(?:[^，。？?]{0,4}?)(?:事故|故障|事件)|\b(?:incidents?|outages?|events?)\b/i],
  ['project', /^(?:[^，。？?]{0,3}?)(?:项目)|\bprojects?\b/i],
];

/** Where the question asks for its items: after 哪些 / 几起 / which / how many, else anywhere. */
function askedKind(q: string): SetQuestion['asks'] {
  const at = /哪些|哪个|哪几|几[起个位名家项次]|多少[起个位名家项]|\bwhich\b|\bhow many\b|\blist\b/i.exec(q);
  const tail = at ? q.slice(at.index + at[0].length) : q;
  for (const [kind, re] of ASKS) if (re.test(tail)) return kind;
  if (!at) return undefined;
  // "有哪些人", "谁": a person even before the marker
  if (/谁|\bwho\b/i.test(q)) return 'person';
  return undefined;
}

const DATE_CN = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const pad = (n: number | string) => String(n).padStart(2, '0');

/** The date a value is asked as of: "截至2025年11月7日", "2025年5月21日那天", "as of 2025-05-21", "on March 3, 2025". */
export function asOfDate(q: string): string | undefined {
  let m = new RegExp(`(?:截至|截止|到|于)?\\s*${DATE_CN.source}\\s*(那天|当天|时|为止|之前)?`).exec(q);
  if (m && (/截至|截止/.test(q.slice(Math.max(0, m.index - 3), m.index + 3)) || m[4] || /那天|当天|当时|这一天/.test(q))) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = /\b(?:as of|on|at|by)\s+(\d{4})-(\d{2})-(\d{2})\b/i.exec(q);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = new RegExp(`\\b(?:as of|on|by)\\s+(${MONTHS.join('|')})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'i').exec(q);
  if (m) return `${m[3]}-${pad(MONTHS.indexOf(m[1].toLowerCase()) + 1)}-${pad(m[2])}`;
  return undefined;
}

/** Closed-class words a question uses to ask, not to name what it asks about. */
const ASKING_WORDS = new RegExp([
  '（[^）]*）', '\\([^)]*\\)', '列出[^，。？?；;]*', '保留\\s*\\d+\\s*位小数', '\\blist (?:each|every|the)[^,.?;]*',
  '\\d{4}\\s*年\\s*\\d{1,2}\\s*月\\s*\\d{1,2}\\s*[日号]', '\\d{4}\\s*年', '第\\s*\\d+\\s*周', '第[一二三四1-4]季度', '[一二三四]季度', 'Q[1-4]', '上半年', '下半年', '\\d{1,2}\\s*月',
  '截至', '截止', '为止', '今年', '去年', '本年', '全年', '那天', '当天', '当时',
  '哪些', '哪个', '哪几', '哪一', '什么', '多少', '是谁', '几[起个位名家项次]', '一共', '总共', '合计', '分别', '各自?', '每个?', '按', '统计', '列出', '注明', '请', '只列', '不为零',
  '平均', '均值', '最高', '最低', '最大', '最小', '低于', '高于', '超过', '小于', '大于', '不足', '及以上', '以上', '以下', '至少',
  '[两二三四五六七八九十\\d]+\\s*[起次个]', '(?<![A-Za-z])[\\d.]+%?',
  '的', '了', '过', '是', '有', '在', '和', '与', '及', '或', '都', '也', '还', '为', '吗', '呢', '同名', '人',
  '\\b(?:which|what|who|how many|how much|list|every|all|each|per|by|the|a|an|of|in|on|at|as of|was|were|is|are|did|does|do|has|have|had|to|for|and|or|this year|company-wide)\\b',
].join('|'), 'gi');

/** Today in the local time zone (YYYY-MM-DD): a question asked on 1 January in Shanghai is not asked on 31 December. */
export const todayIso = () => {
  const t = new Date();
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
};
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
const span = (y: number, m1: number, m2: number, text: string) => ({ from: `${y}-${pad(m1)}-01`, to: lastDay(y, m2), text });

/** The window a question's period words give, relative ones from `now` (see `SetQuestion.period`). */
export function readPeriod(q: string, now: string, groupBy: SetGroup[] = []): { period?: SetQuestion['period']; unreadPeriod?: boolean } {
  const y = Number(now.slice(0, 4));
  const month = Number(now.slice(5, 7));
  const quarter = Math.floor((month - 1) / 3) + 1;
  const back = (n: number, unit: string) => {
    const t = new Date(`${now}T00:00:00Z`);
    if (/月|month/.test(unit)) t.setUTCMonth(t.getUTCMonth() - n);
    else if (/年|year/.test(unit)) t.setUTCFullYear(t.getUTCFullYear() - n);
    else if (/周|week/.test(unit)) t.setUTCDate(t.getUTCDate() - 7 * n);
    else t.setUTCDate(t.getUTCDate() - n);
    return t.toISOString().slice(0, 10);
  };
  // the last N months / years / weeks / days
  let m = /(?:近|过去|最近)\s*([\d一二两三四五六七八九十]+)\s*个?\s*(月|年|周|天|日)|\b(?:last|past) (\d+) (months?|years?|weeks?|days?)\b/i.exec(q);
  if (m) {
    const n = numOf(m[1] ?? m[3]);
    if (n > 0) return { period: { from: back(n, m[2] ?? m[4]), to: now, text: m[0] } };
  }
  if (/本季度|这个?季度|\bthis quarter\b/i.test(q)) return { period: span(y, (quarter - 1) * 3 + 1, quarter * 3, '本季度') };
  if (/上个?季度|\blast quarter\b/i.test(q)) {
    const qy = quarter === 1 ? y - 1 : y;
    const qq = quarter === 1 ? 4 : quarter - 1;
    return { period: span(qy, (qq - 1) * 3 + 1, qq * 3, '上季度') };
  }
  if (/本月|这个月|\bthis month\b/i.test(q)) return { period: span(y, month, month, '本月') };
  if (/上个?月|\blast month\b/i.test(q)) return { period: month === 1 ? span(y - 1, 12, 12, '上月') : span(y, month - 1, month - 1, '上月') };
  // the year: one the question names (a fiscal year as the calendar year), a relative one, else today's
  const fiscal = /(\d{4})\s*财年|\bFY\s?(\d{4})\b|\bfiscal (?:year )?(\d{4})\b/i.exec(q);
  const named = /(\d{4})\s*年/.exec(q) ?? /\b((?:19|20)\d{2})\b/.exec(q);
  const relative = /前年|\bthe year before last\b/i.test(q) ? y - 2 : /去年|上一年|\blast year\b/i.test(q) ? y - 1 : /今年|本年|\bthis year\b/i.test(q) ? y : null;
  const year = fiscal ? Number(fiscal[1] ?? fiscal[2] ?? fiscal[3]) : named ? Number(named[1]) : relative ?? y;
  const through = /截至|截止|到|\bthrough\b|\bup to\b/i;
  const qm = /第?([一二三四1-4])\s*季度|\bQ([1-4])\b/i.exec(q);
  const perQuarter = groupBy.includes('quarter') && /每个?季度|各季度|按季度|\bper quarter\b|\beach quarter\b/i.test(q) && !/第[一二三四1-4]季度/.test(q);
  if (qm && !perQuarter) {
    const n = numOf(qm[1] ?? qm[2]);
    // "截至三季度", "前三季度", "Q3 YTD": from the year's start
    const cumulative = through.test(q.slice(Math.max(0, qm.index - 4), qm.index)) || /前\s*$/.test(q.slice(0, qm.index)) || /^\s*YTD\b/i.test(q.slice(qm.index + qm[0].length));
    return { period: span(year, cumulative ? 1 : (n - 1) * 3 + 1, n * 3, qm[0]) };
  }
  if (/上半年|\bfirst half\b|\bH1\b/i.test(q)) return { period: span(year, 1, 6, '上半年') };
  if (/下半年|\bsecond half\b|\bH2\b/i.test(q)) return { period: span(year, 7, 12, '下半年') };
  const mm = /(?<![\d年])(\d{1,2})\s*月(?!\s*\d{1,2}\s*[日号])/.exec(q);
  if (mm && !groupBy.includes('month') && Number(mm[1]) >= 1 && Number(mm[1]) <= 12 && !named) return { period: span(year, Number(mm[1]), Number(mm[1]), mm[0]) };
  if (fiscal || relative !== null) return { period: span(year, 1, 12, fiscal ? fiscal[0] : relative === y ? '今年' : relative === y - 1 ? '去年' : '前年') };
  if (/近期|最近|近来|这段时间|\brecent(?:ly)?\b|\blately\b|\bthese days\b/i.test(q)) return { unreadPeriod: true };
  return {};
}

/** Read what a question asks of the claims, or null when it asks for no set, count or state. */
export function readSetQuestion(question: string, routed: Pick<QuestionRoute, 'kind'>, now = todayIso()): SetQuestion | null {
  const q = question;
  const asOf = asOfDate(q);
  // a list: 哪些 / 列出, or an English plural after which ("which incidents", "which people") — "which company
  // acquired X" asks for one
  const listy = /哪些|哪几|列出/.test(q) || isListQuestion(q) || /\bwhich (?:\w+ )?(?:people|persons|staff|children|men|women)\b/i.test(q);
  // a value asked as of a day: a quantity or a setting, not what happened that day ("那天发布了什么公告")
  const valueAsked = /多少|几|数值|水平|上限|下限|阈值|比例|\bhow (?:much|many)\b|\bwhat (?:is|was) the (?!\w+ (?:that|which)\b)[\w -]{0,40}\b(?:of|for|at)\b/i.test(q)
    && !/发布|宣布|公告|发生|举行|召开|签署|\bannounc|\bhappen|\breleas|\bpublish|\bsign(?:ed)?\b|\bsaid\b/i.test(q);
  // a count asks how many of something (几起, 多少个, 总数, how many); a total of a figure without one is a sum
  // ("营收合计多少", "一共多少营收")
  const counting = /几[起个位名家项次人]|多少[起个位名家项次人]|总数|\bhow many\b|\bnumber of\b|\bcount\b/i.test(q);
  const totalling = /一共|总共|合计|共计|总计|总额|总和|累计|加起来|\bsum\b|\btotal\b/i.test(q);
  let op: SetOp;
  if (/平均|均值|\baverage\b|\bmean\b/i.test(q)) op = 'mean';
  else if (/最高|最大|峰值|\bhighest\b|\bmaximum\b|\bpeak\b/i.test(q)) op = 'max';
  else if (/最低|最小|\blowest\b|\bminimum\b/i.test(q)) op = 'min';
  else if (counting) op = 'count';
  else if (totalling) op = 'sum';
  else if (asOf && !listy && valueAsked) op = 'value';
  else if (listy || routed.kind === 'list' || routed.kind === 'aggregate') op = 'list';
  else return null;

  const groupBy: SetGroup[] = [];
  for (const m of q.matchAll(/按|每个?|各个?|分(?=组|季度|月)|\b(?:by|per|each|for each)\b\s*/gi)) {
    // the next few characters, or the next word of an English question
    const after = q.slice(m.index + m[0].length);
    const w = /^[A-Za-z]/.test(after) ? after.slice(0, 12) : after.slice(0, 4);
    if (/^组|^[^季月]{0,2}和?组|^团队|^team/i.test(w) || /^组和/.test(w)) groupBy.push('member');
    if (/^事业部|^部门|^division|^department/i.test(w)) groupBy.push('parent');
    if (/季度|quarter/i.test(w)) groupBy.push('quarter');
    if (/^月|^个月|^month/i.test(w)) groupBy.push('month');
    if (/^周|^week/i.test(w)) groupBy.push('week');
  }

  let threshold: SetQuestion['threshold'];
  // the figure, and the unit written after it up to the next word of grammar ("1万亿元的季度" -> 万亿元)
  const UNIT_AFTER = '\\s*([^\\s\\d，。？?、；;,.的之以（(]{0,8})';
  const below = new RegExp(`(低于|小于|少于|不足|不到|\\bbelow\\b|\\bunder\\b|\\bless than\\b|\\blower than\\b)\\s*([\\d.]+)${UNIT_AFTER}`, 'i').exec(q);
  const above = new RegExp(`(不低于|高于|大于|超过|多于|\\babove\\b|\\bover\\b|\\bmore than\\b|\\bgreater than\\b|\\bhigher than\\b)\\s*([\\d.]+)${UNIT_AFTER}`, 'i').exec(q);
  const unitOfThreshold = (m: RegExpExecArray) => (m[3] && /^(?:万亿|千亿|百亿|十亿|亿|千万|百万|十万|万|%|[a-z$]+)/i.test(m[3]) ? { unit: m[3].replace(/(?:季度|月|周|年|天).*$/, '') } : {});
  if (below) threshold = { cmp: '<', value: Number(below[2]), ...unitOfThreshold(below) };
  else if (above) threshold = { cmp: above[1] === '不低于' ? '>=' : '>', value: Number(above[2]), ...unitOfThreshold(above) };

  let atLeast: number | undefined;
  const least = /([两二三四五六七八九十\d]+)\s*[起次个件项]?\s*(?:及以上|或以上|以上)|至少\s*([两二三四五六七八九十\d]+)|\bat least (\w+)|\b(\d+) or more\b/i.exec(q);
  if (least) {
    const word = least[1] ?? least[2] ?? least[4] ?? least[3];
    const n = numOf(word) || ({ two: 2, three: 3, four: 4, five: 5 } as Record<string, number>)[String(word).toLowerCase()];
    if (n > 0) atLeast = n;
  }

  const { period, unreadPeriod } = readPeriod(q, now, groupBy);

  const not = /(?:没有|还没|尚未|仍未|未|不再)\s*([一-鿿]{2})|\bnot (?:yet )?(\w+)|\bstill open\b/i.exec(q);
  const notIn = not ? (not[1] ?? not[2] ?? 'closed') : undefined;
  const wk = /(?:截至|截止|到)\s*第\s*(\d{1,3})\s*周|第\s*(\d{1,3})\s*周(?:为止|之前|以前)|\b(?:through|up to|until|by) week (\d{1,3})\b/i.exec(q);
  const throughWeek = wk ? Number(wk[1] ?? wk[2] ?? wk[3]) : undefined;
  const company = /全公司|所有事业部|各个?事业部|每个事业部|整个公司|全集团|\bcompany-wide\b|\bwhole company\b|\ball divisions\b|\bacross the company\b/i.test(q);
  const rest = q.replace(ASKING_WORDS, ' ').replace(/[，。？?！!、：:；;,.]/g, ' ').replace(/\s+/g, ' ').trim();
  return { op, groupBy: [...new Set(groupBy)], threshold, atLeast, asOf, company, period, unreadPeriod, asks: askedKind(q), notIn, throughWeek, rest };
}

/** A row the computed set lists: one claim, its date, its value and every source behind it. */
export interface SetRow {
  id: string;
  subject: string;
  object: string | null;
  statement: string;
  date: string | null;
  value: string | null;
  attribute: string | null;
  sources: string[];
  /** The title of the first source, which often says what period it reports on ("平台组周报 · 第5周"). */
  title: string | null;
  superseded: boolean;
  /** The claim's own kind and status: a forecast or a rumour is shown as one. */
  kind: string;
  status: string;
}

export interface ComputedSet {
  op: SetOp;
  question: SetQuestion;
  /** The scope as read: the organisations, or "the whole knowledge base". */
  scope: string;
  /** What matched: attribute keys and statement terms. */
  matchedBy: string[];
  /** Live claims in the scope that matched, before grouping. */
  matched: number;
  /** The scope held more claims than were read. */
  capped: boolean;
  /** Distinct items (or readings) the answer is over. */
  items: number;
  /** The computed answer, one line per group or item, each with its sources' titles. */
  lines: string[];
  /** The number the computation gives, for a count, a mean, a sum or a value. */
  answer?: number | string;
  rows: SetRow[];
  ms: number;
}

interface Cand {
  id: string; subject_id: string; subject: string; subject_type: string; object_id: string | null; object: string | null; object_type: string | null;
  statement: string; attribute: string | null; value_num: number | null; value_text: string | null; unit: string | null;
  eff: string | Date | null; superseded_by: string | null; correction: boolean | null; kind: string | null; status: string | null;
  valid_from: string | Date | null; valid_to: string | Date | null; chunk_id: string | null;
}

/** How a claim not stated as fact was stated: its kind, and its status when hedged ("rumor, suspected"). */
const claimKind = (c: { kind: string | null; status: string | null }) => [c.kind && c.kind !== 'fact' ? c.kind : '', c.status && c.status !== 'fact' ? c.status : ''].filter(Boolean).join(', ') || 'fact';
const CJK_SCALES: [string, number][] = [['万亿', 1e12], ['千亿', 1e11], ['百亿', 1e10], ['十亿', 1e9], ['亿', 1e8], ['千万', 1e7], ['百万', 1e6], ['十万', 1e5], ['万', 1e4]];
/** Nouns a count is written with that name no measure of their own ("万人", "3名", "12个"). */
const COUNT_NOUNS = new Set(['人', '个', '名', '位', '次', '家', '件', '项', '条', '户', 'people', 'persons', 'items']);
const EN_SCALES: Record<string, number> = { trillion: 1e12, tn: 1e12, billion: 1e9, bn: 1e9, million: 1e6, mn: 1e6, thousand: 1e3, k: 1e3 };

/**
 * A unit's scale and base: "万亿元" is 1e12 of 元, "亿美元" 1e8 of 美元, "billion USD" 1e9 of usd, "亿" 1e8 of
 * nothing named. Figures of one base compare across scales (1.1万亿元 above 9800亿元); two bases never merge.
 */
export function unitParts(unit: string | null): { scale: number; base: string } {
  const u = (unit ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  for (const [prefix, factor] of CJK_SCALES) if (u.startsWith(prefix)) return { scale: factor, base: u.slice(prefix.length).trim() };
  const m = /^(trillion|tn|billion|bn|million|mn|thousand|k)\b\.?\s*(.*)$/.exec(u);
  if (m) return { scale: EN_SCALES[m[1]], base: m[2].trim() };
  // a scale written after the currency: "HK$ bn", "USD billion"
  const after = /^(.*?)\s+(trillion|tn|billion|bn|million|mn|thousand|k)\.?$/.exec(u);
  if (after) return { scale: EN_SCALES[after[2]], base: after[1].trim() };
  return { scale: 1, base: u };
}

/** A claim stated as fact: no forecast, opinion or rumour, nothing suspected or disputed. */
const isFact = (c: { kind: string | null; status: string | null }) => (c.kind ?? 'fact') === 'fact' && (c.status ?? 'fact') === 'fact';

export type Granularity = 'week' | 'month' | 'quarter' | 'half' | 'year' | 'ytd';
/**
 * The period a reading is of: its granularity and which one ("quarter", "2025-Q1"). A running total from the
 * year's start ("前三季度", "1-9月", "Q3 YTD") is `ytd`, keyed by its last month ("2025-09"): no quarter's figure.
 */
export interface Period { gran: Granularity; key: string }

/** The days a period covers (YYYY-MM-DD, both ends included). */
export function periodSpan(p: Period): { from: string; to: string } {
  const y = Number(p.key.slice(0, 4));
  const day = (t: Date) => t.toISOString().slice(0, 10);
  switch (p.gran) {
    case 'week': {
      const w = Number(p.key.slice(6));
      const jan4 = new Date(Date.UTC(y, 0, 4));
      const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000 + (w - 1) * 7 * 86400000);
      return { from: day(monday), to: day(new Date(monday.getTime() + 6 * 86400000)) };
    }
    case 'month': { const m = Number(p.key.slice(5, 7)); return { from: day(new Date(Date.UTC(y, m - 1, 1))), to: day(new Date(Date.UTC(y, m, 0))) }; }
    case 'quarter': { const q = Number(p.key.slice(6)); return { from: day(new Date(Date.UTC(y, (q - 1) * 3, 1))), to: day(new Date(Date.UTC(y, q * 3, 0))) }; }
    case 'half': { const h = Number(p.key.slice(6)); return { from: day(new Date(Date.UTC(y, (h - 1) * 6, 1))), to: day(new Date(Date.UTC(y, h * 6, 0))) }; }
    case 'year': return { from: `${y}-01-01`, to: `${y}-12-31` };
    case 'ytd': { const m = Number(p.key.slice(5, 7)); return { from: `${y}-01-01`, to: day(new Date(Date.UTC(y, m, 0))) }; }
  }
}

/** A quarter, half or month of a fiscal year, which need not be the calendar's ("2025财年第一季度", "FY2025 Q1", "fiscal Q2"). */
const fiscalPart = (st: string) =>
  /财年|会计年度|\bFY\s?'?\d{2,4}\b|\bfiscal\b/i.test(st) && /季度|半年|\bQ[1-4]\b|\bH[12]\b|\bquarter\b|\bhalf\b|月/i.test(st);

/** A running total from the year's start: "前三季度", "前8个月", "1-9月", "截至三季度末", "Q3 YTD", "9M"; the months it covers. */
function runningMonths(st: string): number | null {
  let m = /前\s*([一二两三1-3])\s*(?:个)?季度|\bQ([1-3])\s*YTD\b|截[至止]\s*第?([一二三1-3])\s*季度末?/i.exec(st);
  if (m) return numOf(m[1] ?? m[2] ?? m[3]) * 3;
  m = /前\s*([\d一二两三四五六七八九十]{1,3})\s*个月|(?<!\d)(?:1|一)\s*(?:-|－|—|~|～|至|到)\s*(\d{1,2}|[二三四五六七八九十]{1,3})\s*月|截[至止]\s*(\d{1,2})\s*月(?:末|底)|\b(\d{1,2})M\b|\bfirst (\w+) months\b/i.exec(st);
  if (m) {
    const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11 };
    const n = m[5] ? words[m[5].toLowerCase()] ?? 0 : numOf(m[1] ?? m[2] ?? m[3] ?? m[4]);
    return n >= 2 && n <= 11 ? n : null;
  }
  if (/\bfirst (?:three|3) quarters\b|\bnine months\b/i.test(st)) return 9;
  return null;
}

/**
 * The period a claim's figure is of: from its validity window when it has
 * one, else from the words of its statement ("2025年一季度", "上半年", "全年",
 * "本周", "Q3 2025"), with its own date for the year; null when neither says.
 */
export function periodOf(c: { statement: string; valid_from?: string | Date | null; valid_to?: string | Date | null; eff?: string | Date | null }): Period | null {
  const from = toDateString(c.valid_from ?? null);
  const to = toDateString(c.valid_to ?? null);
  if (from && to && to >= from) {
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
    const y = from.slice(0, 4);
    const m = Number(from.slice(5, 7));
    // from the year's start through a month other than June or December: a running total
    if (from.slice(5) === '01-01' && days > 92 && days < 365 && to.slice(5, 7) !== '06') return { gran: 'ytd', key: to.slice(0, 7) };
    if (days <= 8) return { gran: 'week', key: isoWeek(from) };
    if (days <= 31) return { gran: 'month', key: from.slice(0, 7) };
    if (days <= 92) return { gran: 'quarter', key: `${y}-Q${Math.floor((m - 1) / 3) + 1}` };
    if (days <= 184) return { gran: 'half', key: `${y}-H${m <= 6 ? 1 : 2}` };
    if (days <= 366) return { gran: 'year', key: y };
    return null;
  }
  const st = c.statement;
  const eff = toDateString(c.eff ?? null);
  const year = /(\d{4})\s*(?:年|财年)/.exec(st)?.[1] ?? /\b(?:FY\s?)?((?:19|20)\d{2})\b/.exec(st)?.[1] ?? eff?.slice(0, 4);
  if (!year) return null;
  // a quarter or half of a fiscal year ("2025财年第一季度", "FY25 Q1") is of a calendar this claim does not give:
  // a company whose year starts in October has its first quarter in the calendar's last
  if (fiscalPart(st)) return null;
  const running = runningMonths(st);
  if (running) return { gran: 'ytd', key: `${year}-${pad(running)}` };
  let m = /第?([一二三四1-4])\s*季度|\bQ([1-4])\b/i.exec(st);
  if (m) return { gran: 'quarter', key: `${year}-Q${numOf(m[1] ?? m[2])}` };
  if (/上半年|\bH1\b|\bfirst half\b/i.test(st)) return { gran: 'half', key: `${year}-H1` };
  if (/下半年|\bH2\b|\bsecond half\b/i.test(st)) return { gran: 'half', key: `${year}-H2` };
  if (/全年|年度|财年|\bfull[- ]year\b|\bFY\b|\bannual\b/i.test(st)) return { gran: 'year', key: year };
  m = /(?<![\d年])(\d{1,2})\s*月(?!\s*\d{1,2}\s*[日号])/.exec(st);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return { gran: 'month', key: `${year}-${pad(m[1])}` };
  if (eff && /本周|当周|这周|\bthis week\b|\bweekly\b/i.test(st)) return { gran: 'week', key: isoWeek(eff) };
  return null;
}

/** An identifier inside a name ("INC-001-T1", "R-04"): two names with one identifier are one item. */
const CODE = /\b[A-Z]{1,6}-\d{1,5}(?:-[A-Z0-9]{1,8})?\b/;
const itemKey = (name: string) => CODE.exec(name)?.[0] ?? name;

/** A statement about an earlier value, not the value then ("最初定为200", "originally 200"). */
const RETROSPECTIVE = /最初|起初|原先|原来|一开始|当初|此前曾|\boriginally\b|\binitially\b|\bat first\b|\bpreviously\b/i;
/** A statement that a value changed, which may name the old one ("由30天改为45天", "以240个连接为准"). */
const CHANGE = /改为|改成|改回|调整为|调为|变更为|更新为|提高到|提高至|降低到|降至|上调|下调|恢复|回退|退回|撤回|以.{0,16}为准|\brolled back\b|\bback to\b|\bchanged? (?:it )?to\b|\braised to\b|\blowered to\b|\brevert(?:ed)? to\b|\bcorrected to\b/i;
/** A statement that the earlier figure was wrong ("撤回原先的200，以240为准", "更正为"), not that it changed since. */
const CORRECTS = /更正|订正|勘误|有误|应为|撤回|以.{0,16}为准|\bcorrect(?:ed|ion)\b|\btypo\b|\berratum\b|\bshould (?:read|be)\b/i;
/** A change since ("改回", "调整为"): the extractor may flag a revert as a correction, but what it replaces did hold. */
const CHANGED = /改回|恢复|回退|退回|回到|调整为|调为|改为|改成|变更为|更新为|提高到|提高至|降低到|降至|上调|下调|\brolled back\b|\bback to\b|\bchanged? (?:it )?to\b|\braised to\b|\blowered to\b|\brevert(?:ed)? to\b/i;
/** The claim `by`, which replaced another, says that one was wrong (and so never held). */
const correcting = (by: { statement: string; correction: boolean | null }) => CORRECTS.test(by.statement) || (Boolean(by.correction) && !CHANGED.test(by.statement));
/** It states an earlier value only: "最初定为200" — not "撤回原先的200，以240为准". */
const onlyRetrospective = (c: { statement: string; correction: boolean | null }) => !c.correction && RETROSPECTIVE.test(c.statement) && !CHANGE.test(c.statement);
/** A statement that a state holds, so that "没有关闭" can be tested on an item's latest one. */
const NEGATED = /未|没|不|尚未|仍未|还未|\bnot\b|\bno longer\b|\bstill open\b/i;

/** Longest common substring length. */
function lcs(a: string, b: string): number {
  if (!a || !b) return 0;
  let best = 0;
  const prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0;
      if (prev[j] > best) best = prev[j];
      diag = tmp;
    }
  }
  return best;
}

/** CJK runs and latin words of the rest of a question, longest first. */
function fragments(rest: string): string[] {
  const out = new Set<string>();
  for (const m of rest.matchAll(/[一-鿿㐀-䶿A-Za-z0-9-]{2,}/g)) out.add(m[0]);
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * The statement terms of a question: for each fragment of its rest, the
 * longest substrings (two characters or more for CJK, whole words otherwise)
 * that some candidate statement holds. A substring nearly every candidate of a
 * scope holds says nothing about it and is dropped.
 */
function statementTerms(frags: string[], statements: string[], maxShare = 0.9): string[] {
  const terms = new Set<string>();
  const lower = statements.map((s) => s.toLowerCase());
  const df = (t: string) => {
    let n = 0;
    for (const s of lower) if (s.includes(t)) n++;
    return n;
  };
  for (const f of frags) {
    const cjk = /[一-鿿]/.test(f);
    if (!cjk) {
      // a word, or its singular ("incidents" in a question, "incident" in the claims)
      const w = f.toLowerCase();
      const t = [w, w.replace(/(?:es|s)$/, ''), w.replace(/s$/, '')].find((x) => x.length >= 3 && df(x) > 0 && df(x) <= lower.length * maxShare);
      if (t) terms.add(t);
      continue;
    }
    let found = false;
    for (let len = f.length; len >= 2 && !found; len--) {
      for (let i = 0; i + len <= f.length; i++) {
        const t = f.slice(i, i + len).toLowerCase();
        const n = df(t);
        if (n > 0 && n <= lower.length * maxShare) {
          terms.add(t);
          found = true;
        }
      }
    }
  }
  return [...terms];
}

const quarterOf = (d: string) => `Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
function isoWeek(d: string): string {
  const t = new Date(`${d}T00:00:00Z`);
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const first = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const w = 1 + Math.round(((t.getTime() - first.getTime()) / 86400000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
  return `${t.getUTCFullYear()}-W${pad(w)}`;
}
const fmt = (n: number) => String(Number(n.toFixed(6)));
/** Dated first, oldest first; undated last. */
const byDate = (a: string | null, b: string | null) => (a && b ? a.localeCompare(b) : a ? -1 : b ? 1 : 0);

/** Merge levels followed at most from a spelling to its survivor. */
const MERGE_DEPTH = 4;

/** Each id's survivor: the entity it was merged into, followed to the end (itself when it was not merged). */
async function survivorsOf(store: Store, ids: string[]): Promise<Map<string, string>> {
  const out = new Map(ids.map((id) => [id, id]));
  let open = [...new Set(ids)];
  for (let i = 0; i < MERGE_DEPTH && open.length; i++) {
    const rows = await store.query<{ id: string; canonical_id: string }>(`SELECT id, canonical_id FROM entities WHERE id = ANY($1::text[]) AND canonical_id IS NOT NULL`, [open]);
    if (rows.length === 0) break;
    const step = new Map(rows.map((r) => [r.id, r.canonical_id]));
    for (const [id, at] of out) if (step.has(at)) out.set(id, step.get(at)!);
    open = [...new Set(rows.map((r) => r.canonical_id))];
  }
  return out;
}

/** The survivors and every spelling merged into them, at any depth. */
async function spellingsOf(store: Store, survivors: string[]): Promise<string[]> {
  const all = new Set(survivors);
  let open = [...all];
  for (let i = 0; i < MERGE_DEPTH && open.length; i++) {
    const rows = await store.query<{ id: string }>(`SELECT id FROM entities WHERE canonical_id = ANY($1::text[])`, [open]);
    open = rows.map((r) => r.id).filter((id) => !all.has(id));
    for (const id of open) all.add(id);
  }
  return [...all];
}

/** Relations that make one organisation a part of another. */
const PART_OF = ['part_of', 'subsidiary_of', 'belongs_to', 'member_of'];
/** Levels of parts read under a scope, and of holders over a named organisation. */
const PART_DEPTH = 3;

/** The organisations holding each of `ids` (`part_of` and the like), one level up: child → parent. */
async function parentsOf(store: Store, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await store.query<{ child: string; parent: string }>(
    `SELECT DISTINCT ON (r.source_id) r.source_id AS child, COALESCE(b.canonical_id, b.id) AS parent
     FROM relations r JOIN entities b ON b.id = r.target_id AND b.type = 'organization'
     WHERE r.source_id = ANY($1::text[]) AND r.type = ANY($2::text[]) AND r.tx_to IS NULL AND r.source_id <> r.target_id
     ORDER BY r.source_id, r.weight DESC, r.target_id`,
    [ids, PART_OF],
  );
  for (const r of rows) out.set(r.child, r.parent);
  return out;
}

/**
 * The organisations a question's named entities scope it to, each with its
 * members: the named organisations, less one that holds another named one (a
 * division named beside its team scopes to the team), and the organisations
 * recorded as their parts (`part_of`, `subsidiary_of`, …), `PART_DEPTH`
 * levels down. Only recorded relations: a name that merely begins with the
 * scope's ("中信建投" under "中信") is no part of it. All of it in SQL over the
 * relations of the named organisations, never over every organisation.
 */
async function scopeOf(store: Store, named: string[]): Promise<{ roots: { id: string; name: string }[]; members: Map<string, string>; parent: Map<string, string> }> {
  const members = new Map<string, string>();
  const parent = new Map<string, string>();
  if (named.length === 0) return { roots: [], members, parent };
  const orgs = await store.query<{ id: string; name: string }>(
    `SELECT id, name FROM entities WHERE id = ANY($1::text[]) AND type = 'organization' AND tx_to IS NULL AND canonical_id IS NULL`,
    [named],
  );
  if (orgs.length === 0) return { roots: [], members, parent };
  const ids = orgs.map((o) => o.id);
  // the holders of the named ones (to tell a team from its division) and the parts under them
  const links = await store.query<{ child: string; parent: string }>(
    `WITH RECURSIVE up(child, parent, depth) AS (
       SELECT r.source_id, r.target_id, 1 FROM relations r
       WHERE r.source_id = ANY($1::text[]) AND r.type = ANY($2::text[]) AND r.tx_to IS NULL AND r.source_id <> r.target_id
       UNION
       SELECT r.source_id, r.target_id, up.depth + 1 FROM relations r JOIN up ON r.source_id = up.parent
       WHERE r.type = ANY($2::text[]) AND r.tx_to IS NULL AND r.source_id <> r.target_id AND up.depth < $3
     ), down(child, parent, depth) AS (
       SELECT r.source_id, r.target_id, 1 FROM relations r
       WHERE r.target_id = ANY($1::text[]) AND r.type = ANY($2::text[]) AND r.tx_to IS NULL AND r.source_id <> r.target_id
       UNION
       SELECT r.source_id, r.target_id, down.depth + 1 FROM relations r JOIN down ON r.target_id = down.child
       WHERE r.type = ANY($2::text[]) AND r.tx_to IS NULL AND r.source_id <> r.target_id AND down.depth < $3
     )
     SELECT l.child, l.parent FROM (SELECT child, parent FROM up UNION SELECT child, parent FROM down) l
     JOIN entities a ON a.id = l.child AND a.type = 'organization' AND a.canonical_id IS NULL
     JOIN entities b ON b.id = l.parent AND b.type = 'organization' AND b.canonical_id IS NULL`,
    [ids, PART_OF, PART_DEPTH],
  );
  for (const r of links) if (!parent.has(r.child)) parent.set(r.child, r.parent);
  const holds = (outer: string, inner: string) => {
    for (let at: string | undefined = inner, i = 0; at && i <= PART_DEPTH * 2; at = parent.get(at), i++) if (parent.get(at) === outer) return true;
    return false;
  };
  const roots = orgs.filter((o) => !orgs.some((x) => x.id !== o.id && holds(o.id, x.id)));
  const children = new Map<string, string[]>();
  for (const [c, p] of parent) (children.get(p) ?? children.set(p, []).get(p)!).push(c);
  for (const r of roots) {
    members.set(r.id, r.id);
    const open = [r.id];
    for (let depth = 0; depth < PART_DEPTH && open.length; depth++) {
      const next: string[] = [];
      for (const at of open) for (const c of children.get(at) ?? []) if (!members.has(c)) { members.set(c, r.id); next.push(c); }
      open.splice(0, open.length, ...next);
    }
  }
  return { roots, members, parent };
}

/** The scopes a claim's evidence comes from, keyed by its document's path. */
const SOURCE_SCOPES = ['tier1', 'doc'];

/** Documents read for a scope at most: an organisation with more is read from its first ones. */
const SCOPE_DOCS_CAP = 5000;

interface DocInfo {
  /** The organisation most of its claims are about: whose document it is. */
  home: string | null;
  title: string | null;
  date: string | null;
}

/**
 * Each document's own organisation, title and date, for the paths given
 * (scope keys of its evidence). Short statements over id arrays, each through
 * its index (`= ANY($ids)`): an embedded database without statistics turns a
 * correlated lookup into a scan of the index for every row.
 */
export async function documentOwners(store: Store, paths: string[]): Promise<Map<string, DocInfo>> {
  return docsOf(store, paths);
}

async function docsOf(store: Store, paths: string[]): Promise<Map<string, DocInfo>> {
  const out = new Map<string, DocInfo>();
  if (paths.length === 0) return out;
  const scopes = await store.query<{ id: string; key: string }>(`SELECT id, key FROM scopes WHERE kind = ANY($2::text[]) AND key = ANY($1::text[])`, [paths, SOURCE_SCOPES]);
  const keyOf = new Map(scopes.map((r) => [r.id, r.key]));
  const ev = scopes.length
    ? await store.query<{ scope_id: string; target_id: string }>(`SELECT scope_id, target_id FROM evidence WHERE scope_id = ANY($1::text[]) AND kind = 'claim' AND tx_to IS NULL`, [scopes.map((r) => r.id)])
    : [];
  const claims = ev.length
    ? await store.query<{ id: string; subject_id: string }>(`SELECT id, subject_id FROM claims WHERE id = ANY($1::text[]) AND tx_to IS NULL AND canonical_id IS NULL`, [[...new Set(ev.map((e) => e.target_id))]])
    : [];
  const subjectOf = new Map(claims.map((c) => [c.id, c.subject_id]));
  const orgs = claims.length
    ? await store.query<{ id: string; org: string }>(`SELECT id, COALESCE(canonical_id, id) AS org FROM entities WHERE id = ANY($1::text[]) AND type = 'organization'`, [[...new Set(claims.map((c) => c.subject_id))]])
    : [];
  const orgOf = new Map(orgs.map((o) => [o.id, o.org]));
  const counts = new Map<string, Map<string, number>>();
  for (const e of ev) {
    const key = keyOf.get(e.scope_id);
    const subject = subjectOf.get(e.target_id);
    const org = subject ? orgOf.get(subject) : undefined;
    if (!key || !org) continue;
    const per = counts.get(key) ?? counts.set(key, new Map()).get(key)!;
    per.set(org, (per.get(org) ?? 0) + 1);
  }
  const docs = await store.query<{ path: string; title: string | null; doc_date: string | Date | null }>(`SELECT path, title, doc_date FROM documents WHERE path = ANY($1::text[])`, [paths]);
  const docOf = new Map(docs.map((d) => [d.path, d]));
  for (const p of paths) {
    const per = [...(counts.get(p) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    // two organisations equally often the subject: the document is neither's (no tie is broken by an id's spelling)
    const home = per.length && !(per.length > 1 && per[1][1] === per[0][1]) ? per[0][0] : null;
    out.set(p, { home, title: docOf.get(p)?.title ?? null, date: toDateString(docOf.get(p)?.doc_date ?? null) });
  }
  return out;
}

/**
 * The attribute keys a question names: those sharing the longest run of
 * characters with it, and among them the ones it covers most of ("服务可用性",
 * not "服务可用性环比变化"; "事故等级" and "事故级别" alike for "事故").
 */
function matchAttributes(keys: Set<string>, rest: string): Set<string> {
  const lower = rest.toLowerCase();
  const words = new Set((lower.match(/[a-z][a-z0-9-]+/g) ?? []).flatMap((w) => [w, w.replace(/(?:es|s)$/, ''), w.replace(/s$/, '')]));
  // a key in words is named by all its words; one in CJK characters by the longest run it shares
  const score = (a: string) => {
    const k = a.toLowerCase();
    if (!/[一-鿿]/.test(k)) {
      const parts = k.split(/[\s_-]+/).filter(Boolean);
      return parts.length && parts.every((p) => words.has(p) || words.has(p.replace(/s$/, ''))) ? k.length : 0;
    }
    return lcs(k, lower);
  };
  const scored = [...keys].map((a) => [a, score(a)] as const);
  const bestLen = Math.max(0, ...scored.map(([, n]) => n));
  const out = new Set<string>();
  if (bestLen < 2) return out;
  const bestRatio = Math.max(...scored.filter(([, n]) => n === bestLen).map(([a, n]) => n / a.length));
  for (const [a, n] of scored) if (n >= bestLen && n / a.length >= bestRatio * 0.75) out.add(a);
  return out;
}

/**
 * Compute the set a question asks for from the claims. Null when the
 * question asks for none, names no scope and no company, or none of its words
 * reach a claim of the scope.
 */
/** The time budget ran out while a statement was under way. */
class BudgetSpent extends Error {}

/**
 * The store as a computed set reads it: a statement still under way when the deadline passes is no longer waited
 * for (the computation ends, nothing computed). An embedded database finishes it on its own; a server's pool goes on.
 */
function withDeadline(store: Store, deadline: number): Store {
  const query = async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
    const left = deadline - Date.now();
    if (left <= 0) throw new BudgetSpent();
    const running = store.query<T>(sql, params);
    running.catch(() => undefined); // abandoned past the deadline, it must not fail unheard
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([running, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new BudgetSpent()), left); })]);
    } finally {
      clearTimeout(timer);
    }
  };
  return Object.assign(Object.create(store) as Store, { query });
}

export async function computeClaimSet(
  store: Store,
  question: string,
  routed: Pick<QuestionRoute, 'kind' | 'range'>,
  named: string[],
  opts: Parameters<typeof computeWithin>[4] = {},
): Promise<ComputedSet | null> {
  const budget = opts.budgetMs ?? SET_BUDGET_MS;
  try {
    return await computeWithin(withDeadline(store, Date.now() + budget), question, routed, named, opts);
  } catch (err) {
    if (!(err instanceof BudgetSpent)) throw err;
    opts.skipped?.('over its time budget');
    return null;
  }
}

async function computeWithin(
  store: Store,
  question: string,
  routed: Pick<QuestionRoute, 'kind' | 'range'>,
  named: string[],
  opts: {
    now?: string;
    /** Milliseconds the computation may take; past them nothing is computed (default `SET_BUDGET_MS`). */
    budgetMs?: number;
    /** Told why nothing was computed, when nothing is. */
    skipped?: (why: string) => void;
    /** Documents of a scope read at most (default `SCOPE_DOCS_CAP`); past them the set says it may be incomplete. */
    docsCap?: number;
  } = {},
): Promise<ComputedSet | null> {
  const started = Date.now();
  const skip = (why: string): null => {
    opts.skipped?.(why);
    return null;
  };
  const budget = opts.budgetMs ?? SET_BUDGET_MS;
  /** The budget is spent: whatever was read, nothing is computed. */
  const late = () => Date.now() - started >= budget;
  const read = readSetQuestion(question, routed, opts.now ?? todayIso());
  if (!read || read.unreadPeriod) return skip('no set asked, or a period no rule reads');
  const typed = await typedColumns(store);
  if (!typed.attribute || !typed.effective) return skip('the store has no claim state'); // a store before claim state: nothing to compute over
  // a merged spelling is its survivor: as scope, as what is asked about, and as the subject of a claim filed under it
  const survivorOf = await survivorsOf(store, named);
  named = [...new Set(named.map((id) => survivorOf.get(id) ?? id))];
  const { roots, members, parent } = await scopeOf(store, named);
  if (roots.length === 0 && !read.company) return skip('no scope named');
  if (late()) return skip('over its time budget');

  const memberIds = await spellingsOf(store, [...members.keys()]);
  const scoped = roots.length > 0;
  const docs = new Map<string, DocInfo>();
  const learn = async (paths: string[]) => {
    const missing = [...new Set(paths)].filter((p) => !docs.has(p));
    for (const [k, v] of await docsOf(store, missing)) docs.set(k, v);
  };
  // the documents in scope: those whose own organisation (the one most of their claims are about) is a member
  let docsInScope: string[] = [];
  let docsCapped = false;
  const docsCap = Math.max(1, opts.docsCap ?? SCOPE_DOCS_CAP);
  if (scoped) {
    // short statements over id arrays, each through its index (see docsOf)
    const own = await store.query<{ id: string }>(
      `SELECT id FROM claims WHERE subject_id = ANY($1::text[]) AND tx_to IS NULL AND canonical_id IS NULL LIMIT ${SET_SCAN_CAP}`, [memberIds],
    );
    const scopeIds = own.length
      ? await store.query<{ scope_id: string }>(`SELECT DISTINCT scope_id FROM evidence WHERE kind = 'claim' AND tx_to IS NULL AND target_id = ANY($1::text[])`, [own.map((r) => r.id)])
      : [];
    const mine = scopeIds.length
      ? await store.query<{ key: string }>(`SELECT DISTINCT key FROM scopes WHERE id = ANY($1::text[]) AND kind = ANY($2::text[]) ORDER BY key LIMIT ${docsCap + 1}`, [scopeIds.map((r) => r.scope_id), SOURCE_SCOPES])
      : [];
    docsCapped = mine.length > docsCap;
    if (docsCapped) mine.length = docsCap;
    await learn(mine.map((r) => r.key));
    docsInScope = mine.map((r) => r.key).filter((k) => members.has(docs.get(k)?.home ?? ''));
  }

  // the scope's names are where to look, not what is asked about; a named entity that is no organisation of
  // the scope is what the question asks about ("T1-C1", "R-01")
  const scopeNamed = named.filter((id) => members.has(id) || [...members.keys()].some((m) => parent.get(m) === id) || [...parent.values()].includes(id));
  const namedWhat = new Set(named.filter((id) => !scopeNamed.includes(id)));
  // every spelling of the scope is its name ("CATL有哪些客户" names 宁德时代's merged spelling)
  const surfaces = scopeNamed.length ? await store.query<{ name: string; aliases: unknown }>(`SELECT name, aliases FROM entities WHERE id = ANY($1::text[])`, [await spellingsOf(store, scopeNamed)]) : [];
  const names = surfaces.flatMap((e) => [e.name, ...(Array.isArray(e.aliases) ? e.aliases.filter((a): a is string => typeof a === 'string') : [])])
    .filter((n) => n.length >= 2 && !CODE.test(n)).sort((a, b) => b.length - a.length);
  let rest = read.rest;
  for (const n of names) rest = rest.split(n).join(' ');
  rest = rest.replace(/\s+/g, ' ').trim();

  const col = (role: 'attribute' | 'valueNum' | 'valueText' | 'unit' | 'effective', cast: string) => (typed[role] ? `cl.${typed[role]}::${cast}` : `NULL::${cast}`);
  const select = `SELECT cl.id, COALESCE(sv.id, se.id) AS subject_id, COALESCE(sv.name, se.name) AS subject, COALESCE(sv.type, se.type) AS subject_type,
            COALESCE(ov.id, oe.id) AS object_id, COALESCE(ov.name, oe.name) AS object, COALESCE(ov.type, oe.type) AS object_type,
            cl.statement, ${col('attribute', 'text')} AS attribute, ${col('valueNum', 'float8')} AS value_num, ${col('valueText', 'text')} AS value_text,
            ${col('unit', 'text')} AS unit, COALESCE(${col('effective', 'timestamptz')}, cl.event_at, cl.valid_from) AS eff,
            cl.superseded_by, cl.correction, cl.kind, cl.status, cl.valid_from, cl.valid_to, cl.chunk_id
     FROM claims cl JOIN entities se ON se.id = cl.subject_id LEFT JOIN entities sv ON sv.id = se.canonical_id
     LEFT JOIN entities oe ON oe.id = cl.object_id LEFT JOIN entities ov ON ov.id = oe.canonical_id`;
  let cands: Cand[];
  let matchedAttrs: Set<string>;
  if (scoped) {
    // the claims stated in the scope's documents, by id (see docsOf)
    const docScopes = docsInScope.length
      ? await store.query<{ id: string }>(`SELECT id FROM scopes WHERE kind = ANY($2::text[]) AND key = ANY($1::text[])`, [docsInScope, SOURCE_SCOPES])
      : [];
    const inDocs = docScopes.length
      ? (await store.query<{ target_id: string }>(`SELECT DISTINCT target_id FROM evidence WHERE scope_id = ANY($1::text[]) AND kind = 'claim' AND tx_to IS NULL`, [docScopes.map((r) => r.id)])).map((r) => r.target_id)
      : [];
    // every live claim about a member, naming one, or stated in a document of the scope; a named entity's
    // claims from elsewhere are not the scope's (one name may stand for several scopes' settings)
    cands = await store.query<Cand>(
      `WITH ids AS MATERIALIZED (
         SELECT id FROM claims WHERE subject_id = ANY($1::text[]) AND tx_to IS NULL
         UNION SELECT id FROM claims WHERE object_id = ANY($1::text[]) AND tx_to IS NULL
         UNION SELECT COALESCE(c.canonical_id, c.id) FROM claims c WHERE c.id = ANY($2::text[])
       )
       ${select} JOIN ids ON ids.id = cl.id
       WHERE cl.tx_to IS NULL AND cl.canonical_id IS NULL
       LIMIT ${SET_SCAN_CAP + 1}`,
      [memberIds, inDocs],
    );
    matchedAttrs = matchAttributes(new Set(cands.map((c) => c.attribute).filter((a): a is string => Boolean(a))), rest);
  } else {
    // the whole knowledge base: only the claims of the attributes the question names (read off the partial index on
    // attributed live claims) or about an entity it names — never a scan of every statement for its words
    const keys = await store.query<{ attribute: string }>(
      `SELECT DISTINCT attribute FROM claims WHERE tx_to IS NULL AND attribute IS NOT NULL LIMIT 20000`,
    );
    matchedAttrs = matchAttributes(new Set(keys.map((k) => k.attribute)), rest);
    if (matchedAttrs.size === 0 && namedWhat.size === 0) return skip('a company-wide question names no attribute');
    if (late()) return skip('over its time budget');
    cands = await store.query<Cand>(
      `WITH ids AS MATERIALIZED (
         SELECT id FROM claims WHERE tx_to IS NULL AND attribute = ANY($1::text[])
         UNION SELECT id FROM claims WHERE tx_to IS NULL AND (subject_id = ANY($2::text[]) OR object_id = ANY($2::text[]))
       )
       ${select} JOIN ids ON ids.id = cl.id
       WHERE cl.tx_to IS NULL AND cl.canonical_id IS NULL
       LIMIT ${SET_SCAN_CAP + 1}`,
      [[...matchedAttrs], await spellingsOf(store, [...namedWhat])],
    );
  }
  // more claims, or more documents, than were read: the set may be incomplete, and says so
  const capped = cands.length > SET_SCAN_CAP || docsCapped;
  if (cands.length > SET_SCAN_CAP) cands.length = SET_SCAN_CAP;
  if (cands.length === 0) return skip('no claim in the scope');
  if (late()) return skip('over its time budget');

  const frags = fragments(rest);
  // the scope's own names are out of the rest already: a word nearly every claim of the scope holds is still the one asked
  const terms = statementTerms(frags, cands.map((c) => c.statement), 1);
  // a value the question names ("P1"), among the values of the attributes in scope: "P1 incidents" names a
  // severity's value without naming the severity
  const valuesOfAttrs = new Map<string, Set<string>>();
  for (const c of cands) {
    if (!c.attribute || !c.value_text || c.value_text.length > 12) continue;
    const v = c.value_text.toLowerCase();
    (valuesOfAttrs.get(v) ?? valuesOfAttrs.set(v, new Set()).get(v)!).add(c.attribute);
  }
  const namedValue = frags.map((f) => f.toLowerCase()).flatMap((f) => [f, ...f.split(/(?<=[a-z0-9])(?=[一-鿿])|(?<=[一-鿿])(?=[a-z0-9])/)])
    .find((f) => valuesOfAttrs.has(f) && f.length >= 2);
  // the attributes that hold the named value: the item's latest of those is tested, not its latest of any
  const valueAttrs = namedValue ? valuesOfAttrs.get(namedValue)! : new Set<string>();

  // confidence: an attribute it names, an entity it names that is not its scope, or words that cover everything it
  // asks about (or the kind of item it asks for and words): a match on part of it ("需要注意" of "风险需要注意") is
  // a set of something else
  const covered = (f: string) => {
    const lower = f.toLowerCase();
    const on = new Array<boolean>(lower.length).fill(false);
    for (const t of terms) for (let at = lower.indexOf(t); at >= 0; at = lower.indexOf(t, at + 1)) for (let i = at; i < at + t.length; i++) on[i] = true;
    // a latin word matched by its singular counts as covered
    if (!/[一-鿿]/.test(f)) return terms.some((t) => lower.startsWith(t));
    return on.every(Boolean);
  };
  const namedWhatHit = cands.some((c) => namedWhat.has(c.subject_id) || (c.object_id !== null && namedWhat.has(c.object_id)));
  const confident = matchedAttrs.size > 0 || namedWhatHit || (terms.length > 0 && (read.asks !== undefined || frags.every(covered)));
  if (!confident) return skip('no confident match');

  const matches = (c: Cand) =>
    namedWhat.has(c.subject_id) || (c.object_id !== null && namedWhat.has(c.object_id)) ||
    (c.attribute !== null && matchedAttrs.has(c.attribute)) || terms.some((t) => c.statement.toLowerCase().includes(t));
  let matched = cands.filter(matches);
  if (matched.length === 0) return skip('no claim matched');

  // a figure is its claim's subject's: another organisation's figure stated in the scope's document (a peer's revenue
  // in a company's report) is not the scope's, whatever document states it
  const peer = (c: Cand) => scoped && c.subject_type === 'organization' && !members.has(c.subject_id) && !namedWhat.has(c.subject_id);
  // a value as of a date: every value of the subjects the matching claims are about
  if (read.op === 'value') {
    // what the value is of: the subjects the matching claims are about (no peer organisation), the scope's
    // organisations only when nothing else is
    let subjects = new Set(matched.filter((c) => !peer(c)).map((c) => c.subject_id).filter((id) => !members.has(id)));
    if (subjects.size === 0) subjects = new Set(matched.map((c) => c.subject_id));
    // a later report may name it only by the short name it was given ("下称保留期") or its code: those statements
    // are about it whoever their subject is
    const aliasRows = await store.query<{ aliases: unknown }>(`SELECT aliases FROM entities WHERE id = ANY($1::text[])`, [[...subjects]]);
    const aliases = aliasRows.flatMap((r) => (Array.isArray(r.aliases) ? r.aliases : [])).filter((a): a is string => typeof a === 'string' && a.length >= 2);
    const have = new Set(matched.map((c) => c.id));
    for (const c of cands) if (aliases.some((a) => c.statement.includes(a))) have.add(c.id);
    matched = cands.filter((c) => (subjects.has(c.subject_id) && (have.has(c.id) || !members.has(c.subject_id))) || (have.has(c.id) && c.value_num !== null));
    // a peer's figure is left out below, and said
  }

  // the period: the router's explicit range, else what the question's period words give; a value as of a day is read
  // up to that day (the month the day is in is no window)
  const dateOf = (c: Cand) => toDateString(c.eff);
  let from: string | null = read.asOf ? null : routed.range?.from?.slice(0, 10) ?? read.period?.from ?? null;
  let to: string | null = read.asOf ? null : routed.range?.to?.slice(0, 10) ?? read.period?.to ?? null;
  if (read.throughWeek) {
    // the last report that names the week as its own, and the days of its week
    const [w] = await store.query<{ d: string | Date | null }>(
      `SELECT max(doc_date) AS d FROM documents WHERE doc_date IS NOT NULL AND (title LIKE $1 OR title ILIKE $2)`,
      [`%第${read.throughWeek}周%`, `%week ${read.throughWeek}`],
    );
    const end = toDateString(w?.d ?? null);
    if (end) {
      const t = new Date(`${end}T00:00:00Z`);
      t.setUTCDate(t.getUTCDate() + 6 - ((t.getUTCDay() + 6) % 7));
      const cut = t.toISOString().slice(0, 10);
      if (!to || cut < to) to = cut;
    }
  }
  if (read.asOf && (!to || read.asOf < to)) to = read.asOf;
  const inPeriod = (c: Cand) => {
    const d = dateOf(c);
    // an undated claim (a summary without a dateline) is kept unless the window has a start it may be before
    if (!d) return !from;
    return (!from || d >= from) && (!to || d <= to);
  };

  // every source of a claim, its merged members' included: indexed steps over id arrays (an OR over the claim and its
  // members kept the planner off both indexes)
  const matchedIds = matched.map((c) => c.id);
  const mergedIn = await store.query<{ id: string; canonical_id: string }>(`SELECT id, canonical_id FROM claims WHERE canonical_id = ANY($1::text[])`, [matchedIds]);
  const repOf = new Map<string, string>([...matchedIds.map((id) => [id, id] as [string, string]), ...mergedIn.map((r) => [r.id, r.canonical_id] as [string, string])]);
  const evRows = await store.query<{ target_id: string; scope_id: string }>(
    `SELECT DISTINCT target_id, scope_id FROM evidence WHERE kind = 'claim' AND tx_to IS NULL AND target_id = ANY($1::text[])`, [[...repOf.keys()]],
  );
  const scopeKeys = new Map((await store.query<{ id: string; key: string }>(
    `SELECT id, key FROM scopes WHERE id = ANY($1::text[]) AND kind = ANY($2::text[])`, [[...new Set(evRows.map((r) => r.scope_id))], SOURCE_SCOPES],
  )).map((r) => [r.id, r.key]));
  const sourceRows = [...new Map(evRows.filter((r) => scopeKeys.has(r.scope_id)).map((r) => {
    const row = { id: repOf.get(r.target_id)!, key: scopeKeys.get(r.scope_id)! };
    return [`${row.id}|${row.key}`, row] as const;
  })).values()].sort((a, b) => a.key.localeCompare(b.key));
  const sources = new Map<string, string[]>();
  for (const r of sourceRows) (sources.get(r.id) ?? sources.set(r.id, []).get(r.id)!).push(r.key);
  await learn(sourceRows.map((r) => r.key));
  if (late()) return skip('over its time budget');
  const docDate = new Map([...docs].map(([k, v]) => [k, v.date]));
  const titleOf = new Map([...docs].map(([k, v]) => [k, v.title]));
  // the source that reports on the claim's own date: the first dated on or after it, else the first titled
  const titled = (keys: string[], date: string | null) => {
    const dated = keys.filter((k) => docDate.get(k)).sort((a, b) => docDate.get(a)!.localeCompare(docDate.get(b)!));
    return (date ? dated.find((k) => docDate.get(k)! >= date) : undefined) ?? keys.find((k) => titleOf.get(k)) ?? keys[0];
  };
  const toRow = (c: Cand): SetRow => {
    const src = sources.get(c.id) ?? [];
    const first = titled(src, dateOf(c));
    return {
      id: c.id, subject: c.subject, object: c.object, statement: c.statement, date: dateOf(c),
      value: c.value_num !== null ? `${fmt(c.value_num)}${c.unit ?? ''}` : c.value_text, attribute: c.attribute,
      sources: first ? [first, ...src.filter((s) => s !== first)] : src, title: first ? titleOf.get(first) ?? null : null, superseded: Boolean(c.superseded_by),
      kind: c.kind ?? 'fact', status: c.status ?? 'fact',
    };
  };
  const label = (r: SetRow) => `${r.date ?? '?'}${r.title ? ` 《${r.title}》` : ''}`;
  if (read.groupBy.includes('parent') || read.groupBy.includes('member')) {
    const homes = [...new Set([...docs.values()].map((d) => d.home).filter((h): h is string => Boolean(h) && !parent.has(h!)))];
    for (const [c, p] of await parentsOf(store, homes)) parent.set(c, p);
  }
  const orgName = new Map<string, string>();
  for (const r of await store.query<{ id: string; name: string }>(`SELECT id, name FROM entities WHERE id = ANY($1::text[])`, [[...new Set([...[...docs.values()].map((d) => d.home).filter((h): h is string => Boolean(h)), ...parent.values(), ...parent.keys()])]])) orgName.set(r.id, r.name);
  // a claim's organisation in scope: its sources' own one, the one nearest a root
  const memberOf = (c: Cand): string | null => {
    for (const s of sources.get(c.id) ?? []) {
      const h = docs.get(s)?.home;
      if (h && (!scoped || members.has(h))) return h;
    }
    return members.has(c.subject_id) ? c.subject_id : null;
  };
  const parentOf = (org: string | null) => (org ? parent.get(org) ?? org : null);
  // a figure is grouped by the period it covers (its first day), not by when it was stated; quarters carry their year
  const groupLabel = (g: SetGroup, c: Cand): string => {
    const covered = periodOf(c);
    const d = (covered && (g !== 'week' || covered.gran === 'week') ? periodSpan(covered).from : null) ?? dateOf(c) ?? '';
    switch (g) {
      case 'member': { const m = memberOf(c); return m ? orgName.get(m) ?? m : '?'; }
      case 'parent': { const p = parentOf(memberOf(c)); return p ? orgName.get(p) ?? p : '?'; }
      case 'quarter': return d ? `${d.slice(0, 4)}-${quarterOf(d)}` : '?';
      case 'month': return d ? d.slice(0, 7) : '?';
      case 'week': return d ? isoWeek(d) : '?';
    }
  };

  const lines: string[] = [];
  const rows: SetRow[] = [];
  let answer: number | string | undefined;
  let items = 0;
  const scopeText = scoped ? roots.map((r) => r.name).join('、') + (members.size > roots.length ? ` (with ${members.size - roots.length} member organisations)` : '') : 'the whole knowledge base';

  const numeric = read.op === 'max' || read.op === 'min' || read.op === 'mean' || read.op === 'sum' || read.op === 'value' || Boolean(read.threshold);
  if (numeric) {
    // readings: one figure a claim states for a period. Only claims stated as fact; a claim replaced by another of its
    // own period never held (a typo, a restatement), one replaced by a later period's is that period's history
    // only a claim of the scope replaces one: an entity merged across scopes (one setting code in ten divisions)
    // chains the supersession of one scope's figures through another's
    const inScope = new Map(cands.map((c) => [c.id, c]));
    const replacedBy = new Map<string, Cand>();
    for (const c of matched) if (c.superseded_by && inScope.has(c.superseded_by)) replacedBy.set(c.superseded_by, inScope.get(c.superseded_by)!);
    const left = { notFact: 0, replaced: 0, recalled: 0, noNumber: 0, fiscal: 0, units: new Map<string, number>(), grans: new Map<string, number>(), peers: new Map<string, number>() };
    const readings = new Map<string, Cand>();
    const periods = new Map<string, Period | null>();
    const conflicted = new Set<string>();
    // a unit's noun that only repeats what is counted (用户 of 周活跃用户) or is a bare count noun (人, 个, 名) names no
    // other measure: "万", "万用户" and "万人" of one attribute are one unit; "亿元" and "亿美元" are still two
    const baseOfC = (c: Cand) => {
      const b = unitParts(c.unit).base;
      return !b || COUNT_NOUNS.has(b) || (c.attribute ?? '').includes(b) ? '' : b;
    };
    for (const c of matched) {
      if (read.op !== 'value' && matchedAttrs.size > 0 && (!c.attribute || !matchedAttrs.has(c.attribute))) continue;
      if (c.value_num === null && (read.op !== 'value' || !c.value_text)) {
        if (c.attribute && matchedAttrs.has(c.attribute)) left.noNumber++;
        continue;
      }
      // a window asked is tested on the period the figure covers ("2024年下半年" stated in 2025 is no 2025 figure); a
      // value as of a day, on when it was stated (what was known that day)
      const covers = periodOf(c);
      // a fiscal quarter without its days is in no calendar window
      if (!read.asOf && !covers && (from || to) && fiscalPart(c.statement)) { left.fiscal++; continue; }
      if (!read.asOf && covers && (from || to)) {
        // a week belongs to the window its first day is in (its report may close in the next month); a longer period
        // must lie inside the window ("2024年下半年" is no part of 2025's first half)
        const span = periodSpan(covers);
        const outside = covers.gran === 'week'
          ? (from && span.from < from) || (to && span.from > to)
          : (from && span.from < from) || (to && span.to > to);
        if (outside) continue;
      } else if (!inPeriod(c)) continue;
      if (peer(c)) { left.peers.set(c.subject, (left.peers.get(c.subject) ?? 0) + 1); continue; }
      if (!isFact(c)) { left.notFact++; continue; }
      if (onlyRetrospective(c)) { left.recalled++; continue; }
      const period = periodOf(c);
      periods.set(c.id, period);
      if (c.superseded_by && replacedBy.has(c.superseded_by)) {
        const by = replacedBy.get(c.superseded_by);
        const byPeriod = by ? periodOf(by) : null;
        // replaced for its own period: by a correction, by a claim of the same period, or — neither period known (a
        // setting) — by one of the same day; a later change of a setting is its history, not a correction of it
        const samePeriod = !by || correcting(by)
          || (period && byPeriod ? byPeriod.gran === period.gran && byPeriod.key === period.key : !period && !byPeriod && dateOf(by) === dateOf(c));
        if (samePeriod) { left.replaced++; continue; }
      }
      const d = dateOf(c);
      // one reading per subject, period and base: a figure in another currency is another measure, never the same one restated
      const key = read.op === 'value' ? c.id : `${c.subject_id}|${baseOfC(c)}|${period ? `${period.gran}:${period.key}` : d ? isoWeek(d) : c.id}`;
      const prev = readings.get(key);
      // two figures of one subject, period and base, neither replacing the other, are two measures under one name
      // (宁德时代's revenue and its overseas revenue): neither is the figure, and the period is left out
      if (prev && read.op !== 'value' && prev.value_num !== null && c.value_num !== null && Math.abs(prev.value_num - c.value_num) > 1e-9 * Math.max(1, Math.abs(prev.value_num))) conflicted.add(key);
      if (!prev || byDate(dateOf(prev), d) < 0) readings.set(key, c);
    }
    for (const k of conflicted) readings.delete(k);
    // the scope's own figure is the whole: when the organisations it names report one, its parts' figures (a
    // subsidiary's, a team's) are inside it and stay out
    let parts = 0;
    const rootIds = new Set(roots.map((r) => r.id));
    if (scoped && [...readings.values()].some((c) => rootIds.has(c.subject_id))) {
      for (const [k, c] of readings) if (members.has(c.subject_id) && !rootIds.has(c.subject_id)) { readings.delete(k); parts++; }
    }
    // one base: the commonest; a tie names no figure. A base that begins another is the same one written with its
    // noun ("个" and "个连接"); a bare scale ("亿", "万") joins a base only when one base is named among the readings
    // ("万" with "万用户"), never when two are ("亿" beside "亿元" and "亿美元"); "亿元" and "亿美元" are two
    const namedBases = [...new Set([...readings.values()].map(baseOfC).filter(Boolean))].sort((a, b) => a.length - b.length);
    const rootOf = (b: string) => (b ? namedBases.find((v) => b.startsWith(v)) ?? b : namedBases.length === 1 ? namedBases[0] : '');
    const unitOf = (c: Cand) => rootOf(baseOfC(c));
    const byUnit = new Map<string, number>();
    for (const c of readings.values()) byUnit.set(unitOf(c), (byUnit.get(unitOf(c)) ?? 0) + 1);
    const unitsRanked = [...byUnit].sort((a, b) => b[1] - a[1]);
    if (unitsRanked.length > 1 && unitsRanked[0][1] === unitsRanked[1][1]) return skip('two units equally common');
    const theUnit = unitsRanked[0]?.[0];
    for (const [k, c] of readings) if (unitOf(c) !== theUnit) { left.units.set(c.unit ?? '(none)', (left.units.get(c.unit ?? '(none)') ?? 0) + 1); readings.delete(k); }
    // one granularity for a figure over many readings: the commonest known one; a tie, or a sum over periods not all known, names none
    if (read.op !== 'value') {
      const byGran = new Map<string, number>();
      for (const c of readings.values()) { const g = periods.get(c.id)?.gran ?? 'unknown'; byGran.set(g, (byGran.get(g) ?? 0) + 1); }
      const known = [...byGran].filter(([g]) => g !== 'unknown').sort((a, b) => b[1] - a[1]);
      if (known.length > 1 && known[0][1] === known[1][1]) return skip('two period lengths equally common');
      if (read.op === 'sum' && (byGran.has('unknown') || known.length !== 1)) return skip('a sum over periods not all of one length');
      if ((read.op === 'sum' || read.op === 'mean') && known[0]?.[0] === 'ytd') return skip('running totals (前三季度, year to date) add up to no figure');
      const theGran = known[0]?.[0];
      if (theGran) for (const [k, c] of readings) if (periods.get(c.id)?.gran !== theGran) { left.grans.set(periods.get(c.id)?.gran ?? 'unknown', (left.grans.get(periods.get(c.id)?.gran ?? 'unknown') ?? 0) + 1); readings.delete(k); }
    }
    const leftOut = [
      left.notFact ? `${left.notFact} not stated as fact (a forecast, opinion or rumour, or suspected)` : '',
      left.replaced ? `${left.replaced} replaced for its own period by a later claim` : '',
      left.recalled ? `${left.recalled} only recalling an earlier value` : '',
      left.fiscal ? `${left.fiscal} of a fiscal quarter or half whose calendar months are not recorded` : '',
      left.units.size ? `${[...left.units.values()].reduce((a, b) => a + b, 0)} in another unit (${[...left.units.keys()].join(', ')})` : '',
      left.grans.size ? `${[...left.grans.values()].reduce((a, b) => a + b, 0)} of another period length (${[...left.grans.keys()].join(', ')})` : '',
      left.noNumber ? `${left.noNumber} of the attribute with no numeric value recorded` : '',
      left.peers.size ? `${[...left.peers.values()].reduce((a, b) => a + b, 0)} about other organisations (${[...left.peers.keys()].join(', ')})` : '',
      conflicted.size ? `${conflicted.size} period${conflicted.size > 1 ? 's' : ''} whose figures disagree (two measures under one name)` : '',
      parts ? `${parts} of the scope's parts, inside its own figure` : '',
    ].filter(Boolean);
    if (readings.size === 0) return skip('no reading');
    // figures compare in their base; they are shown in the commonest unit's scale
    const unitCount = new Map<string, number>();
    for (const c of readings.values()) unitCount.set(c.unit ?? '', (unitCount.get(c.unit ?? '') ?? 0) + 1);
    const shownUnit = [...unitCount].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';
    const shownScale = unitParts(shownUnit).scale;
    const inBase = (c: Cand) => c.value_num! * unitParts(c.unit).scale;
    const shown = (c: Cand) => inBase(c) / shownScale;
    let list = [...readings.values()].sort((a, b) => byDate(dateOf(a), dateOf(b)) || a.id.localeCompare(b.id));
    if (read.op === 'value') {
      // the value then: the latest stated on or before the date, a correction over what it corrects
      const dated = list.filter((c) => dateOf(c));
      const latest = dated[dated.length - 1];
      if (!latest) return skip('no dated reading');
      const sameDay = dated.filter((c) => dateOf(c) === dateOf(latest));
      const pick = sameDay.find((c) => c.correction) ?? sameDay.find((c) => !c.superseded_by) ?? latest;
      const r = toRow(pick);
      answer = pick.value_num !== null ? fmt(pick.value_num) : pick.value_text ?? undefined;
      lines.push(`Value as of ${read.asOf}: ${r.value ?? r.statement} — stated ${label(r)}${pick.correction ? ', a correction' : ''}: ${pick.statement}`);
      const history = list.slice(-ROWS_PER_ITEM * 3);
      lines.push(`History up to ${read.asOf} (${list.length} statements, latest last): ${history.map((c) => `${dateOf(c)} ${c.value_num !== null ? fmt(c.value_num) + (c.unit ?? '') : c.value_text}${c.correction ? ' (correction)' : ''}`).join('; ')}`);
      rows.push(...history.map(toRow));
      items = list.length;
      if (leftOut.length) lines.push(`Left out: ${leftOut.join('; ')}.`);
    } else {
      if (read.threshold) {
        const { cmp, value } = read.threshold;
        // a threshold with a scale ("1万亿元", "900亿元") is compared in the base; one without in the unit shown
        const tu = read.threshold.unit ? unitParts(read.threshold.unit) : null;
        const scaled = Boolean(tu && tu.scale !== 1);
        const target = scaled ? value * tu!.scale : value;
        list = list.filter((c) => {
          const v = scaled ? inBase(c) : shown(c);
          return cmp === '<' ? v < target : cmp === '<=' ? v <= target : cmp === '>' ? v > target : v >= target;
        });
        if (list.length === 0) return skip('no reading past the threshold');
      }
      items = list.length;
      let groups = new Map<string, Cand[]>();
      for (const c of list) {
        const key = read.groupBy.length ? read.groupBy.map((g) => groupLabel(g, c)).join(' · ') : 'all';
        (groups.get(key) ?? groups.set(key, []).get(key)!).push(c);
      }
      // groups of one reading each ("各周的周均值") group nothing: the operation is over them all
      if (groups.size > 1 && [...groups.values()].every((g) => g.length === 1)) groups = new Map([['all', list]]);
      const unit = shownUnit;
      const attr = [...matchedAttrs].join('/') || terms.join('/');
      if (read.op === 'list' || read.op === 'count') {
        lines.push(`${list.length} readings of ${attr}${read.threshold ? ` ${read.threshold.cmp} ${read.threshold.value}` : ''}${from || to ? ` (${from ?? ''}..${to ?? ''})` : ''}:`);
        for (const c of list) { const r = toRow(c); lines.push(`- ${label(r)}: ${r.value}`); }
        if (read.op === 'count') answer = list.length;
      } else {
        for (const [key, cs] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
          const vs = cs.map(shown);
          if (read.op === 'mean' || read.op === 'sum') {
            const total = vs.reduce((s, v) => s + v, 0);
            const v = read.op === 'mean' ? total / vs.length : total;
            if (groups.size === 1) answer = fmt(v);
            // a total over a window says how many of the window's periods its figures cover: three quarters of a year
            // are not the year's
            let covered = '';
            const g = periods.get(cs[0].id)?.gran;
            if (read.op === 'sum' && g && from && to) {
              // the periods of that length lying wholly inside the window
              const inWindow = new Set<string>();
              for (let t = new Date(`${from}T00:00:00Z`); t.toISOString().slice(0, 10) <= to; t.setUTCDate(t.getUTCDate() + 1)) {
                const d = t.toISOString().slice(0, 10);
                const k = g === 'week' ? isoWeek(d) : g === 'month' ? d.slice(0, 7) : g === 'quarter' ? `${d.slice(0, 4)}-${quarterOf(d)}` : g === 'half' ? `${d.slice(0, 4)}-H${Number(d.slice(5, 7)) <= 6 ? 1 : 2}` : d.slice(0, 4);
                const span = periodSpan({ gran: g, key: k });
                if (span.from >= from && span.to <= to) inWindow.add(k);
              }
              const expected = inWindow.size;
              if (expected > cs.length) covered = `; it covers ${cs.length} of the window's ${expected} ${g}s only, so it is not the window's total`;
            }
            lines.push(`${key === 'all' ? '' : `${key}: `}${read.op} of ${attr} over ${vs.length} readings${from || to ? ` (${from ?? ''}..${to ?? ''})` : ''} = ${fmt(v)}${unit} (3 decimals: ${v.toFixed(3)})${covered}`);
          } else {
            const best = cs.reduce((b, c) => ((read.op === 'max' ? inBase(c) > inBase(b) : inBase(c) < inBase(b)) ? c : b));
            const r = toRow(best);
            if (groups.size === 1) answer = fmt(best.value_num!);
            lines.push(`${key === 'all' ? '' : `${key}: `}${read.op} ${attr} = ${r.value} — ${label(r)} (of ${vs.length} readings)`);
          }
        }
      }
      rows.push(...list.map(toRow));
      if (leftOut.length) lines.push(`Left out: ${leftOut.join('; ')}.`);
    }
  } else {
    // items: the entities the claims are about, or the ones of the kind the question asks for
    // the people a claim may name: those its own passage mentions, not every person of the knowledge base
    const chunkIds = [...new Set(matched.map((c) => c.chunk_id).filter((x): x is string => Boolean(x)))];
    const people = read.asks === 'person' && chunkIds.length
      ? await store.query<{ id: string; name: string }>(
        `SELECT DISTINCT COALESCE(sv.id, e.id) AS id, COALESCE(sv.name, e.name) AS name
         FROM entity_mentions m JOIN entities e ON e.id = m.entity_id LEFT JOIN entities sv ON sv.id = e.canonical_id
         WHERE m.chunk_id = ANY($1::text[]) AND e.type = 'person' AND length(e.name) >= 2
         LIMIT ${PEOPLE_CAP}`,
        [chunkIds],
      )
      : [];
    if (late()) return skip('over its time budget');
    // the scope's own organisations are where the items are, never items
    // another organisation's claim about itself ("比亚迪毛利率17.6%", stated in the scope's report) makes it no item
    // of the scope: an organisation is one when its claim relates it to the scope (names a member, or is the scope's)
    const relatesToScope = (c: Cand) => (c.object_id !== null && members.has(c.object_id)) || names.some((n) => n.length >= 2 && c.statement.includes(n));
    const itemsOf = (c: Cand): { key: string; name: string; id: string }[] => {
      const subjectFits = !members.has(c.subject_id) && (!read.asks || c.subject_type === read.asks) && !(scoped && c.subject_type === 'organization' && !relatesToScope(c));
      if (subjectFits) return [{ key: itemKey(c.subject), name: c.subject, id: c.subject_id }];
      if (c.object && c.object_id && !members.has(c.object_id) && (!read.asks || c.object_type === read.asks)) return [{ key: itemKey(c.object), name: c.object, id: c.object_id }];
      if (read.asks === 'person') {
        const inText = people.filter((p) => c.statement.includes(p.name.replace(/（.*$/, '')) && p.name !== c.subject);
        if (inText.length) return inText.map((p) => ({ key: p.name, name: p.name, id: p.id }));
      }
      return [];
    };
    const byItem = new Map<string, { name: string; claims: Cand[]; about: Set<string>; ids: Set<string> }>();
    for (const c of matched) {
      if (!inPeriod(c)) continue;
      for (const it of itemsOf(c)) {
        const entry = byItem.get(it.key) ?? byItem.set(it.key, { name: it.name, claims: [], about: new Set(), ids: new Set() }).get(it.key)!;
        entry.claims.push(c);
        entry.ids.add(it.id);
        // what the item is related to: the other ends of its claims ("方杰" fixed INC-001-T1 and INC-007-T1)
        if (itemKey(c.subject) !== it.key) entry.about.add(itemKey(c.subject));
      }
    }
    let list = [...byItem.entries()].map(([key, v]) => ({ key, ...v, claims: v.claims.sort((a, b) => byDate(dateOf(a), dateOf(b)) || a.id.localeCompare(b.id)) }));
    if (scoped && list.length > 0) {
      // an item most of whose claims are reported outside the scope belongs there (a mislinked mention brought it in)
      const ids = [...new Set(list.flatMap((it) => [...it.ids]))];
      const totals = new Map((await store.query<{ id: string; n: number }>(
        `SELECT subject_id AS id, count(*)::int AS n FROM claims WHERE subject_id = ANY($1::text[]) AND tx_to IS NULL AND canonical_id IS NULL GROUP BY 1`, [ids],
      )).map((r) => [r.id, r.n]));
      const inScope = new Map<string, number>();
      for (const c of cands) inScope.set(c.subject_id, (inScope.get(c.subject_id) ?? 0) + 1);
      // only an item known by an identifier: a customer or a person is rightly reported in many scopes
      list = list.filter((it) => !CODE.test(it.key) || [...it.ids].some((id) => (inScope.get(id) ?? 0) * 2 >= (totals.get(id) ?? 0)));
    }
    // when most items carry an identifier, one without is a description of one that does ("退款卡单事故" of INC-013-T2)
    const coded = list.filter((it) => CODE.test(it.key));
    let uncoded: typeof list = [];
    if (list.length >= 4 && coded.length >= list.length * 0.75 && coded.length < list.length) {
      uncoded = list.filter((it) => !CODE.test(it.key));
      list = coded;
    }
    if (namedValue) {
      // the item's own value of the matched attributes, its latest
      list = list.filter((it) => {
        const vals = it.claims.filter((c) => c.attribute && valueAttrs.has(c.attribute) && c.value_text);
        const last = vals.filter((c) => !c.superseded_by).pop() ?? vals.pop();
        return last ? last.value_text!.toLowerCase() === namedValue : false;
      });
    }
    if (read.notIn) {
      const word = read.notIn.toLowerCase();
      list = list.filter((it) => {
        const stating = it.claims.filter((c) => c.statement.toLowerCase().includes(word) || (c.value_text ?? '').toLowerCase().includes(word));
        const last = stating[stating.length - 1];
        // its latest word on the state does not say it is in it
        return !last || NEGATED.test(last.statement.slice(Math.max(0, last.statement.toLowerCase().indexOf(word) - 3), last.statement.toLowerCase().indexOf(word)));
      });
    }
    if (read.atLeast) list = list.filter((it) => it.about.size >= read.atLeast!);
    // an item no claim states as fact (only forecast, rumoured, suspected) is not counted; it is named apart
    const unfactual = list.filter((it) => !it.claims.some(isFact));
    list = list.filter((it) => it.claims.some(isFact));
    // nothing found is not a computed zero: the question is answered as if no set were asked for
    if (list.length === 0) return skip('no item');
    list.sort((a, b) => byDate(dateOf(a.claims[0]), dateOf(b.claims[0])) || a.key.localeCompare(b.key));
    items = list.length;
    const relatedCount = list.some((it) => it.about.size > 0) && (read.atLeast !== undefined || read.asks === 'person' || read.asks === 'organization');
    const groups = new Map<string, typeof list>();
    for (const it of list) {
      const key = read.groupBy.length ? read.groupBy.map((g) => groupLabel(g, it.claims[0])).join(' · ') : 'all';
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(it);
    }
    const what = [namedValue ? `${[...matchedAttrs].join('/')} = ${namedValue.toUpperCase()}` : '', terms.length ? `"${terms.join('" / "')}"` : '', matchedAttrs.size && !namedValue ? [...matchedAttrs].join('/') : '']
      .filter(Boolean).join(', ');
    if (read.op === 'count') answer = list.length;
    lines.push(`${list.length} distinct ${read.asks ?? 'items'} matching ${what}${from || to ? ` (${from ?? ''}..${to ?? ''})` : ''}${read.notIn ? `, latest state not "${read.notIn}"` : ''}${read.atLeast ? `, related to at least ${read.atLeast}` : ''}${capped ? ' (scope larger than read: may be incomplete)' : ''}`);
    for (const [key, its] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (key !== 'all') lines.push(`${key}: ${its.length}`);
      for (const it of its) {
        const first = toRow(it.claims[0]);
        const related = relatedCount ? ` (${it.about.size}: ${[...it.about].join(', ')})` : '';
        lines.push(`- ${it.name}${related} — first ${label(first)}${it.claims.length > 1 ? `, latest ${label(toRow(it.claims[it.claims.length - 1]))}` : ''}`);
      }
    }
    if (uncoded.length) lines.push(`Also named without an identifier (each may be one listed above, not counted): ${uncoded.map((it) => it.name).join('、')}`);
    if (unfactual.length) lines.push(`Also reported, not as fact (not counted): ${unfactual.map((it) => `${it.name} (${[...new Set(it.claims.map((c) => claimKind(c)))].join(', ')})`).join('、')}`);
    // the rows: each item's first and latest claims, and a few between
    for (const it of [...list, ...unfactual]) {
      const cs = it.claims;
      const pick = cs.length <= ROWS_PER_ITEM ? cs : [cs[0], ...cs.slice(1, -1).filter((c) => c.attribute && matchedAttrs.has(c.attribute)).slice(-(ROWS_PER_ITEM - 2)), cs[cs.length - 1]];
      for (const c of pick) rows.push(toRow(c));
    }
  }
  if (rows.length === 0 && !lines.length) return skip('nothing computed');
  return {
    op: read.op, question: read, scope: scopeText,
    matchedBy: [...[...matchedAttrs].map((a) => `attribute:${a}`), ...terms.map((t) => `term:${t}`), ...(namedValue ? [`value:${namedValue}`] : [])],
    matched: matched.length, capped, items, lines: boundLines(lines), answer, rows: dedupeRows(rows).slice(0, SET_ROWS), ms: Date.now() - started,
  };
}

function dedupeRows(rows: SetRow[]): SetRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}
