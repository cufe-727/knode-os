import { Store } from '../store/db.js';
import { toDateString } from '../store/temporal.js';
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
  /** Readings compared with a figure the question gives. */
  threshold?: { cmp: '<' | '<=' | '>' | '>='; value: number };
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
/** Rows a computed set hands the model at most. */
export const SET_ROWS = 240;
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

const todayIso = () => new Date().toISOString().slice(0, 10);
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
    const cumulative = through.test(q.slice(Math.max(0, qm.index - 4), qm.index));
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
  const listy = /哪些|哪几|列出|\bwhich\b|\blist\b/i.test(q);
  const counting = /几[起个位名家项次人]|多少[起个位名家项次人]|一共|总共|总数|\bhow many\b|\bnumber of\b|\bcount\b/i.test(q);
  let op: SetOp;
  if (/平均|均值|\baverage\b|\bmean\b/i.test(q)) op = 'mean';
  else if (/最高|最大|峰值|\bhighest\b|\bmaximum\b|\bpeak\b/i.test(q)) op = 'max';
  else if (/最低|最小|\blowest\b|\bminimum\b/i.test(q)) op = 'min';
  else if (/总额|总和|累计|\bsum\b|\btotal (?:amount|value)\b/i.test(q)) op = 'sum';
  else if (counting) op = 'count';
  else if (asOf && !listy) op = 'value';
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
  const below = /(低于|小于|少于|不足|不到|\bbelow\b|\bunder\b|\bless than\b|\blower than\b)\s*([\d.]+)/i.exec(q);
  const above = /(不低于|高于|大于|超过|多于|\babove\b|\bover\b|\bmore than\b|\bgreater than\b|\bhigher than\b)\s*([\d.]+)/i.exec(q);
  if (below) threshold = { cmp: '<', value: Number(below[2]) };
  else if (above) threshold = { cmp: above[1] === '不低于' ? '>=' : '>', value: Number(above[2]) };

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
  valid_from: string | Date | null; valid_to: string | Date | null;
}

/** How a claim not stated as fact was stated: its kind, and its status when hedged ("rumor, suspected"). */
const claimKind = (c: { kind: string | null; status: string | null }) => [c.kind && c.kind !== 'fact' ? c.kind : '', c.status && c.status !== 'fact' ? c.status : ''].filter(Boolean).join(', ') || 'fact';
/** A claim stated as fact: no forecast, opinion or rumour, nothing suspected or disputed. */
const isFact = (c: { kind: string | null; status: string | null }) => (c.kind ?? 'fact') === 'fact' && (c.status ?? 'fact') === 'fact';

export type Granularity = 'week' | 'month' | 'quarter' | 'half' | 'year';
/** The period a reading is of: its granularity and which one ("quarter", "2025-Q1"). */
export interface Period { gran: Granularity; key: string }

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

/**
 * The organisations a question's named entities scope it to, each with its
 * members: the named organisations, less one that holds another named one
 * (a division named beside its team scopes to the team), and their members —
 * organisations `part_of` them, or named as them and more ("第一事业部平台组"
 * under "第一事业部"), two levels down.
 */
async function scopeOf(store: Store, named: string[]): Promise<{ roots: { id: string; name: string }[]; members: Map<string, string>; parent: Map<string, string> }> {
  const members = new Map<string, string>();
  const parent = new Map<string, string>();
  const orgs = named.length
    ? await store.query<{ id: string; name: string }>(
      `SELECT id, name FROM entities WHERE id = ANY($1::text[]) AND type = 'organization' AND tx_to IS NULL AND canonical_id IS NULL`,
      [named],
    )
    : [];
  const all = await store.query<{ id: string; name: string }>(`SELECT id, name FROM entities WHERE type = 'organization' AND tx_to IS NULL AND canonical_id IS NULL`);
  const partOf = await store.query<{ child: string; parent: string }>(
    `SELECT DISTINCT r.source_id AS child, r.target_id AS parent FROM relations r
     JOIN entities a ON a.id = r.source_id AND a.type = 'organization' JOIN entities b ON b.id = r.target_id AND b.type = 'organization'
     WHERE r.tx_to IS NULL AND r.type IN ('part_of', 'subsidiary_of', 'belongs_to', 'member_of') AND r.source_id <> r.target_id`,
  );
  for (const r of partOf) parent.set(r.child, r.parent);
  // a longer name that begins with an organisation's name is one of its parts
  const byName = [...all].sort((a, b) => b.name.length - a.name.length);
  for (const e of all) {
    if (parent.has(e.id)) continue;
    const holder = byName.find((o) => o.id !== e.id && o.name.length >= 2 && o.name.length < e.name.length && e.name.startsWith(o.name));
    if (holder) parent.set(e.id, holder.id);
  }
  const holds = (outer: string, inner: string) => {
    for (let at: string | undefined = inner, i = 0; at && i < 4; at = parent.get(at), i++) if (parent.get(at) === outer) return true;
    return false;
  };
  const roots = orgs.filter((o) => !orgs.some((x) => x.id !== o.id && holds(o.id, x.id)));
  for (const r of roots) {
    members.set(r.id, r.id);
    for (const e of all) if (holds(r.id, e.id)) members.set(e.id, r.id);
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

/** Each document's own organisation, title and date, for the paths given (scope keys of its evidence). */
async function docsOf(store: Store, paths: string[]): Promise<Map<string, DocInfo>> {
  const out = new Map<string, DocInfo>();
  for (let i = 0; i < paths.length; i += 1000) {
    const part = paths.slice(i, i + 1000);
    const rows = await store.query<{ path: string; org: string | null; title: string | null; doc_date: string | Date | null }>(
      `WITH sc AS MATERIALIZED (SELECT id, key FROM scopes WHERE kind = ANY($2::text[]) AND key = ANY($1::text[])),
       ev AS MATERIALIZED (
         SELECT sc.key, ev.target_id FROM evidence ev JOIN sc ON sc.id = ev.scope_id WHERE ev.kind = 'claim' AND ev.tx_to IS NULL
       ), per AS (
         SELECT ev.key AS path, COALESCE(e.canonical_id, e.id) AS org, count(*) AS n
         FROM ev
         JOIN claims cl ON cl.id = ev.target_id AND cl.tx_to IS NULL AND cl.canonical_id IS NULL
         JOIN entities e ON e.id = cl.subject_id AND e.type = 'organization'
         GROUP BY 1, 2
       ), home AS (SELECT DISTINCT ON (path) path, org FROM per ORDER BY path, n DESC, org)
       SELECT p.path, h.org, d.title, d.doc_date
       FROM unnest($1::text[]) AS p(path) LEFT JOIN home h ON h.path = p.path LEFT JOIN documents d ON d.path = p.path`,
      [part, SOURCE_SCOPES],
    );
    for (const r of rows) out.set(r.path, { home: r.org, title: r.title, date: toDateString(r.doc_date) });
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
export async function computeClaimSet(
  store: Store,
  question: string,
  routed: Pick<QuestionRoute, 'kind' | 'range'>,
  named: string[],
  opts: { now?: string } = {},
): Promise<ComputedSet | null> {
  const started = Date.now();
  const read = readSetQuestion(question, routed, opts.now ?? todayIso());
  if (!read || read.unreadPeriod) return null;
  const typed = await typedColumns(store);
  if (!typed.attribute || !typed.effective) return null; // a store before claim state: nothing to compute over
  // a merged spelling is its survivor: as scope, as what is asked about, and as the subject of a claim filed under it
  const survivorOf = await survivorsOf(store, named);
  named = [...new Set(named.map((id) => survivorOf.get(id) ?? id))];
  const { roots, members, parent } = await scopeOf(store, named);
  if (roots.length === 0 && !read.company) return null;

  const memberIds = await spellingsOf(store, [...members.keys()]);
  const scoped = roots.length > 0;
  const docs = new Map<string, DocInfo>();
  const learn = async (paths: string[]) => {
    const missing = [...new Set(paths)].filter((p) => !docs.has(p));
    for (const [k, v] of await docsOf(store, missing)) docs.set(k, v);
  };
  // the documents in scope: those whose own organisation (the one most of their claims are about) is a member
  let docsInScope: string[] = [];
  if (scoped) {
    const mine = await store.query<{ key: string }>(
      `SELECT DISTINCT s.key FROM claims cl
       JOIN evidence ev ON ev.kind = 'claim' AND ev.target_id = cl.id AND ev.tx_to IS NULL
       JOIN scopes s ON s.id = ev.scope_id
       WHERE cl.subject_id = ANY($1::text[]) AND cl.tx_to IS NULL AND cl.canonical_id IS NULL
       LIMIT ${SCOPE_DOCS_CAP}`,
      [memberIds],
    );
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
            cl.superseded_by, cl.correction, cl.kind, cl.status, cl.valid_from, cl.valid_to
     FROM claims cl JOIN entities se ON se.id = cl.subject_id LEFT JOIN entities sv ON sv.id = se.canonical_id
     LEFT JOIN entities oe ON oe.id = cl.object_id LEFT JOIN entities ov ON ov.id = oe.canonical_id`;
  let cands: Cand[];
  let matchedAttrs: Set<string>;
  if (scoped) {
    // every live claim about a member, naming one, or stated in a document of the scope; a named entity's
    // claims from elsewhere are not the scope's (one name may stand for several scopes' settings)
    cands = await store.query<Cand>(
      `WITH ids AS (
         SELECT id FROM claims WHERE subject_id = ANY($1::text[]) AND tx_to IS NULL
         UNION SELECT id FROM claims WHERE object_id = ANY($1::text[]) AND tx_to IS NULL
         UNION SELECT COALESCE(c.canonical_id, c.id) FROM evidence ev JOIN claims c ON c.id = ev.target_id
               WHERE ev.kind = 'claim' AND ev.tx_to IS NULL
                 AND ev.scope_id IN (SELECT id FROM scopes WHERE kind = ANY($3::text[]) AND key = ANY($2::text[]))
       )
       ${select} JOIN ids ON ids.id = cl.id
       WHERE cl.tx_to IS NULL AND cl.canonical_id IS NULL
       LIMIT ${SET_SCAN_CAP + 1}`,
      [memberIds, docsInScope, SOURCE_SCOPES],
    );
    matchedAttrs = matchAttributes(new Set(cands.map((c) => c.attribute).filter((a): a is string => Boolean(a))), rest);
  } else {
    // the whole knowledge base: only the claims of the attributes the question names, or holding its words
    const keys = await store.query<{ attribute: string }>(
      `SELECT DISTINCT ${col('attribute', 'text')} AS attribute FROM claims cl WHERE cl.tx_to IS NULL AND ${col('attribute', 'text')} IS NOT NULL LIMIT 20000`,
    );
    matchedAttrs = matchAttributes(new Set(keys.map((k) => k.attribute)), rest);
    const words = fragments(rest).filter((f) => f.length >= 2).slice(0, 8);
    cands = await store.query<Cand>(
      `${select}
       WHERE cl.tx_to IS NULL AND cl.canonical_id IS NULL
         AND (${col('attribute', 'text')} = ANY($1::text[]) OR cl.statement ILIKE ANY($2::text[])
              OR cl.subject_id = ANY($3::text[]) OR cl.object_id = ANY($3::text[]))
       LIMIT ${SET_SCAN_CAP + 1}`,
      [[...matchedAttrs], words.map((w) => `%${w.replace(/[%_\\]/g, '\\$&')}%`), [...namedWhat]],
    );
  }
  const capped = cands.length > SET_SCAN_CAP;
  if (capped) cands.length = SET_SCAN_CAP;
  if (cands.length === 0) return null;

  const frags = fragments(rest);
  // the whole knowledge base was read by these words already: a word every candidate holds is still the one asked
  const terms = statementTerms(frags, cands.map((c) => c.statement), scoped ? 0.9 : 1);
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
  if (!confident) return null;

  const matches = (c: Cand) =>
    namedWhat.has(c.subject_id) || (c.object_id !== null && namedWhat.has(c.object_id)) ||
    (c.attribute !== null && matchedAttrs.has(c.attribute)) || terms.some((t) => c.statement.toLowerCase().includes(t));
  let matched = cands.filter(matches);
  if (matched.length === 0) return null;

  // a value as of a date: every value of the subjects the matching claims are about
  if (read.op === 'value') {
    // what the value is of: the subjects the matching claims are about, the scope's organisations only when nothing else is
    let subjects = new Set(matched.map((c) => c.subject_id).filter((id) => !members.has(id)));
    if (subjects.size === 0) subjects = new Set(matched.map((c) => c.subject_id));
    // a later report may name it only by the short name it was given ("下称保留期") or its code: those statements
    // are about it whoever their subject is
    const aliasRows = await store.query<{ aliases: unknown }>(`SELECT aliases FROM entities WHERE id = ANY($1::text[])`, [[...subjects]]);
    const aliases = aliasRows.flatMap((r) => (Array.isArray(r.aliases) ? r.aliases : [])).filter((a): a is string => typeof a === 'string' && a.length >= 2);
    const have = new Set(matched.map((c) => c.id));
    for (const c of cands) if (aliases.some((a) => c.statement.includes(a))) have.add(c.id);
    matched = cands.filter((c) => (subjects.has(c.subject_id) && (have.has(c.id) || !members.has(c.subject_id))) || (have.has(c.id) && c.value_num !== null));
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

  // every source of a claim, its merged members' included
  const sourceRows = await store.query<{ id: string; key: string }>(
    `SELECT DISTINCT COALESCE(c.canonical_id, c.id) AS id, s.key
     FROM claims c
     JOIN evidence ev ON ev.kind = 'claim' AND ev.target_id = c.id AND ev.tx_to IS NULL
     JOIN scopes s ON s.id = ev.scope_id AND s.kind = ANY($2::text[])
     WHERE c.id = ANY($1::text[]) OR c.canonical_id = ANY($1::text[]) ORDER BY 2`,
    [matched.map((c) => c.id), SOURCE_SCOPES],
  );
  const sources = new Map<string, string[]>();
  for (const r of sourceRows) (sources.get(r.id) ?? sources.set(r.id, []).get(r.id)!).push(r.key);
  await learn(sourceRows.map((r) => r.key));
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
  const groupLabel = (g: SetGroup, c: Cand): string => {
    const d = dateOf(c) ?? '';
    switch (g) {
      case 'member': { const m = memberOf(c); return m ? orgName.get(m) ?? m : '?'; }
      case 'parent': { const p = parentOf(memberOf(c)); return p ? orgName.get(p) ?? p : '?'; }
      case 'quarter': return d ? quarterOf(d) : '?';
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
    const replacedBy = new Map<string, Cand>();
    const superseders = [...new Set(matched.map((c) => c.superseded_by).filter((x): x is string => Boolean(x)))];
    if (superseders.length) {
      for (const r of await store.query<Cand>(`${select} WHERE cl.id = ANY($1::text[])`, [superseders])) replacedBy.set(r.id, r);
    }
    const left = { notFact: 0, replaced: 0, recalled: 0, noNumber: 0, units: new Map<string, number>(), grans: new Map<string, number>() };
    const readings = new Map<string, Cand>();
    const periods = new Map<string, Period | null>();
    for (const c of matched) {
      if (read.op !== 'value' && matchedAttrs.size > 0 && (!c.attribute || !matchedAttrs.has(c.attribute))) continue;
      if (c.value_num === null && (read.op !== 'value' || !c.value_text)) {
        if (c.attribute && matchedAttrs.has(c.attribute)) left.noNumber++;
        continue;
      }
      if (!inPeriod(c)) continue;
      if (!isFact(c)) { left.notFact++; continue; }
      if (onlyRetrospective(c)) { left.recalled++; continue; }
      const period = periodOf(c);
      periods.set(c.id, period);
      if (c.superseded_by) {
        const by = replacedBy.get(c.superseded_by);
        const byPeriod = by ? periodOf(by) : null;
        const samePeriod = !by || by.correction || !period || !byPeriod || (byPeriod.gran === period.gran && byPeriod.key === period.key);
        if (samePeriod) { left.replaced++; continue; }
      }
      const d = dateOf(c);
      const key = read.op === 'value' ? c.id : `${c.subject_id}|${period ? `${period.gran}:${period.key}` : d ? isoWeek(d) : c.id}`;
      const prev = readings.get(key);
      if (!prev || byDate(dateOf(prev), d) < 0) readings.set(key, c);
    }
    // one unit: the commonest; a tie names no figure
    const unitOf = (c: Cand) => (c.unit ?? '').trim().toLowerCase();
    const byUnit = new Map<string, number>();
    for (const c of readings.values()) byUnit.set(unitOf(c), (byUnit.get(unitOf(c)) ?? 0) + 1);
    const unitsRanked = [...byUnit].sort((a, b) => b[1] - a[1]);
    if (unitsRanked.length > 1 && unitsRanked[0][1] === unitsRanked[1][1]) return null;
    const theUnit = unitsRanked[0]?.[0];
    for (const [k, c] of readings) if (unitOf(c) !== theUnit) { left.units.set(c.unit ?? '(none)', (left.units.get(c.unit ?? '(none)') ?? 0) + 1); readings.delete(k); }
    // one granularity for a figure over many readings: the commonest known one; a tie, or a sum over periods not all known, names none
    if (read.op !== 'value') {
      const byGran = new Map<string, number>();
      for (const c of readings.values()) { const g = periods.get(c.id)?.gran ?? 'unknown'; byGran.set(g, (byGran.get(g) ?? 0) + 1); }
      const known = [...byGran].filter(([g]) => g !== 'unknown').sort((a, b) => b[1] - a[1]);
      if (known.length > 1 && known[0][1] === known[1][1]) return null;
      if (read.op === 'sum' && (byGran.has('unknown') || known.length !== 1)) return null;
      const theGran = known[0]?.[0];
      if (theGran) for (const [k, c] of readings) if (periods.get(c.id)?.gran !== theGran) { left.grans.set(periods.get(c.id)?.gran ?? 'unknown', (left.grans.get(periods.get(c.id)?.gran ?? 'unknown') ?? 0) + 1); readings.delete(k); }
    }
    const leftOut = [
      left.notFact ? `${left.notFact} not stated as fact (a forecast, opinion or rumour, or suspected)` : '',
      left.replaced ? `${left.replaced} replaced for its own period by a later claim` : '',
      left.recalled ? `${left.recalled} only recalling an earlier value` : '',
      left.units.size ? `${[...left.units.values()].reduce((a, b) => a + b, 0)} in another unit (${[...left.units.keys()].join(', ')})` : '',
      left.grans.size ? `${[...left.grans.values()].reduce((a, b) => a + b, 0)} of another period length (${[...left.grans.keys()].join(', ')})` : '',
      left.noNumber ? `${left.noNumber} of the attribute with no numeric value recorded` : '',
    ].filter(Boolean);
    if (readings.size === 0) return null;
    let list = [...readings.values()].sort((a, b) => byDate(dateOf(a), dateOf(b)) || a.id.localeCompare(b.id));
    if (read.op === 'value') {
      // the value then: the latest stated on or before the date, a correction over what it corrects
      const dated = list.filter((c) => dateOf(c));
      const latest = dated[dated.length - 1];
      if (!latest) return null;
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
        list = list.filter((c) => {
          const v = c.value_num!;
          return cmp === '<' ? v < value : cmp === '<=' ? v <= value : cmp === '>' ? v > value : v >= value;
        });
        if (list.length === 0) return null;
      }
      items = list.length;
      let groups = new Map<string, Cand[]>();
      for (const c of list) {
        const key = read.groupBy.length ? read.groupBy.map((g) => groupLabel(g, c)).join(' · ') : 'all';
        (groups.get(key) ?? groups.set(key, []).get(key)!).push(c);
      }
      // groups of one reading each ("各周的周均值") group nothing: the operation is over them all
      if (groups.size > 1 && [...groups.values()].every((g) => g.length === 1)) groups = new Map([['all', list]]);
      const unit = list.find((c) => c.unit)?.unit ?? '';
      const attr = [...matchedAttrs].join('/') || terms.join('/');
      if (read.op === 'list' || read.op === 'count') {
        lines.push(`${list.length} readings of ${attr}${read.threshold ? ` ${read.threshold.cmp} ${read.threshold.value}` : ''}${from || to ? ` (${from ?? ''}..${to ?? ''})` : ''}:`);
        for (const c of list) { const r = toRow(c); lines.push(`- ${label(r)}: ${r.value}`); }
        if (read.op === 'count') answer = list.length;
      } else {
        for (const [key, cs] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
          const vs = cs.map((c) => c.value_num!);
          if (read.op === 'mean' || read.op === 'sum') {
            const total = vs.reduce((s, v) => s + v, 0);
            const v = read.op === 'mean' ? total / vs.length : total;
            if (groups.size === 1) answer = fmt(v);
            lines.push(`${key === 'all' ? '' : `${key}: `}${read.op} of ${attr} over ${vs.length} readings${from || to ? ` (${from ?? ''}..${to ?? ''})` : ''} = ${fmt(v)}${unit} (3 decimals: ${v.toFixed(3)})`);
          } else {
            const best = cs.reduce((b, c) => ((read.op === 'max' ? c.value_num! > b.value_num! : c.value_num! < b.value_num!) ? c : b));
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
    const people = read.asks === 'person'
      ? await store.query<{ id: string; name: string }>(`SELECT id, name FROM entities WHERE type = 'person' AND tx_to IS NULL AND canonical_id IS NULL AND length(name) >= 2`)
      : [];
    // the scope's own organisations are where the items are, never items
    const itemsOf = (c: Cand): { key: string; name: string; id: string }[] => {
      const subjectFits = !members.has(c.subject_id) && (!read.asks || c.subject_type === read.asks);
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
    if (list.length === 0) return null;
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
  if (rows.length === 0 && !lines.length) return null;
  return {
    op: read.op, question: read, scope: scopeText,
    matchedBy: [...[...matchedAttrs].map((a) => `attribute:${a}`), ...terms.map((t) => `term:${t}`), ...(namedValue ? [`value:${namedValue}`] : [])],
    matched: matched.length, capped, items, lines, answer, rows: dedupeRows(rows).slice(0, SET_ROWS), ms: Date.now() - started,
  };
}

function dedupeRows(rows: SetRow[]): SetRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}
