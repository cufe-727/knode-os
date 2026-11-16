import { rng } from '../metrics/stats.js';
import { seededKey } from '../pack.js';
import type { GoldAlias, GoldItem, ListSpec, Task } from '../types.js';
import { CORPUS_TASK_MIN_DOCS, STRUCTURED_MIN_DOCS } from '../types.js';
import { registerRecipe, RecipeContext } from './index.js';
import { cnNum, crossLingualOf, Draft, enOrdinal, exactSetSpec, lexicallyDisjoint, lexicalOverlap, paraphraseOf, quarterForms } from './separation.js';
import { buildReportsV3 } from './reports-v3-build.js';
import { PackWriter } from './writer.js';

/**
 * A year of weekly reports (docs/design/23 §2.2, 28): teams of one company
 * write a report every week, a PMO sums them up every month, and a hidden
 * script decides everything they say — people who join, leave and move,
 * projects that progress, slip and get renamed, incidents and who fixed them,
 * risks from first mention to closing, each team's metric, settings that are
 * changed, corrected and reverted, the mood of each team, and how each lead
 * writes. The reports are rendered from several phrasings per fact (picked by
 * seed) in the lead's style, so the gold for every task follows from the
 * script without a model, at any size:
 *
 * - corpus-level lists across the year (incidents, departures, transfers,
 *   open risks, monthly figures, the PMO's disagreements with the teams);
 * - chains of four and five facts in five different reports, and chains whose
 *   question shares no words with the bridges' evidence;
 * - ambiguity and look-alikes: namesakes in different teams, near-identical
 *   project and customer names, projects and a customer renamed halfway, a
 *   metric whose definition changes;
 * - stale traps: a setting introduced by its name and later changed,
 *   corrected or reverted under its code, a short alias or a pronoun only;
 * - structured queries: filter, group and count over more than 20 reports;
 * - emergence: each team's state per quarter (never named), each lead's
 *   style, unsigned excerpts to attribute, which projects will slip, and
 *   incidents and risks that are the same problem in different words.
 *
 * Weeks 1–44 are the corpus, 45–48 four update batches, 49–52 the holdout.
 * `size` (10, 100) makes the company that many divisions of three teams —
 * the corpus generated natively at that scale, gold computed the same way.
 * Padding (`scale`, `padTeams`) adds other teams whose reports name nobody
 * and nothing the tasks ask about. File names carry no week or date unless
 * `datedPaths` is set; the dates stay in each report's body.
 */

type Lang = 'zh' | 'en';

/** 3 (2026-11-14): a division's questions name it in its weekly reports' words; deep hops carry their chain as `meta.stratum`. */
export const REPORTS_VERSION = 3;
export const REPORT_WEEKS = 52;
export const CORPUS_WEEKS = 44;
const START = Date.UTC(2025, 0, 6); // a Monday

const dayOf = (week: number, d = 0) => new Date(START + ((week - 1) * 7 + d) * 86_400_000);
const iso = (d: Date) => d.toISOString().slice(0, 10);
/** A report is dated by its Monday (its path, its corpus date): the calendar month it belongs to. */
export const monthOf = (week: number) => dayOf(week).getUTCMonth() + 1;
const quarterOf = (week: number) => Math.ceil(monthOf(week) / 3);
const weeksUpTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const MONTHS_EN = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/* ---------------------------------- names ---------------------------------- */

const NAMES: Record<Lang, { sur: string[]; moreSur: string[]; given: string[]; given2: string[]; padSur: string[]; padCustomers: string[] }> = {
  zh: {
    sur: ['王', '李', '张', '刘', '杨', '赵', '黄', '周', '吴', '徐', '孙', '胡', '朱', '高', '林', '何', '郭', '马', '罗'],
    moreSur: ['蒋', '蔡', '贾', '丁', '魏', '薛', '阎', '余', '潘', '杜', '戴', '夏', '钟', '汪', '田', '任', '姜', '范', '方', '石', '姚', '谭', '廖', '邹', '熊', '金', '陆', '郝', '孔', '白', '崔', '康', '毛', '邱', '秦', '史', '顾', '侯', '邵', '孟', '龙', '万', '段', '雷', '钱', '汤', '尹', '黎', '易', '常', '武', '乔', '贺', '赖', '龚', '文'],
    given: ['芳', '娜', '敏', '静', '强', '磊', '洋', '艳', '勇', '军', '杰', '涛', '明', '超', '霞', '平', '晨', '宇', '欣', '博', '鹏', '婷', '雪', '浩', '凯', '琳'],
    // two-character given names whose first character is no one-character given name: 王芳 is never inside 王芳菲
    given2: ['子涵', '雨萱', '安然', '梓轩', '思远', '嘉怡', '俊熙', '一诺', '若溪', '沐阳', '书瑶', '亦凡', '语桐', '景行', '知秋', '清扬', '以安', '星河', '慕白', '南乔'],
    padSur: ['梁', '宋', '郑', '谢', '韩', '唐', '冯', '于', '董', '萧', '程', '曹', '袁', '邓', '许', '傅', '沈', '曾', '彭', '吕'],
    padCustomers: ['云杉家居', '北辰医药', '海岳传媒', '启航旅行', '东篱餐饮', '南风电器', '金石地产', '白帆航运'],
  },
  en: {
    sur: ['Smith', 'Johnson', 'Brown', 'Davis', 'Miller', 'Wilson', 'Moore', 'Taylor', 'Thomas', 'Lee', 'Martin', 'Clark', 'Lewis', 'Walker', 'Hall', 'Young', 'King', 'Wright', 'Scott'],
    moreSur: ['Allen', 'Baker', 'Carter', 'Evans', 'Foster', 'Gray', 'Hughes', 'James', 'Kelly', 'Long', 'Morgan', 'Price', 'Reed', 'Stone', 'Turner', 'Ward', 'West', 'Wood', 'Bell', 'Cook', 'Fox', 'Grant', 'Hill', 'Lane', 'Mills', 'Nash', 'Page', 'Rowe', 'Shaw', 'Webb'],
    given: ['Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'Ethan', 'Mia', 'Lucas', 'Zoe', 'Ryan', 'Nina', 'Owen', 'Leah', 'Jack', 'Iris', 'Sam', 'Ruby', 'Max', 'Ella', 'Ben', 'Cara', 'Dean', 'Faye', 'Gabe', 'Hope', 'Ivan'],
    given2: ['ABCDEFGHJKLMNPRSTVW'],
    padSur: ['Adler', 'Baxter', 'Crane', 'Dalton', 'Ellis', 'Fowler', 'Garner', 'Hayes', 'Ingram', 'Jarvis', 'Keane', 'Lowell', 'Marsh', 'Nolan', 'Orton', 'Pryce', 'Quinn', 'Royce', 'Sutton', 'Tate'],
    padCustomers: ['Cedar Home', 'Polar Pharma', 'Summit Media', 'Voyage Travel', 'Hearth Dining', 'Breeze Appliances', 'Granite Estates', 'Sail Shipping'],
  },
};

/** Namesakes: each name is given to two people of one division (two teams, or two roles). Their surnames are in no pool. */
const TWINS: Record<Lang, { names: string[]; sur: string[] }> = {
  zh: { names: ['陈伟', '叶敏', '江涛'], sur: ['陈', '叶', '江'] },
  en: { names: ['Alex Chen', 'Jordan Park', 'Sam Rivera'], sur: ['Chen', 'Park', 'Rivera'] },
};

/**
 * Customers, one table for the company: two pairs of near-identical names (no
 * name inside another) and one customer that renames itself halfway; later
 * documents use only the new name.
 */
const CUSTOMERS: Record<Lang, { name: string; renamed?: string; lookalike?: number }[]> = {
  zh: [{ name: '华鼎零售' }, { name: '青禾教育' }, { name: '华顶零售', lookalike: 0 }, { name: '星联物流' }, { name: '易达出行', renamed: '易达科技' }, { name: '恒信保险' }, { name: '远景银行' }, { name: '远境银行', lookalike: 6 }],
  en: [{ name: 'Brightmart Retail' }, { name: 'Greenfield Learning' }, { name: 'Brightmark Retail', lookalike: 0 }, { name: 'Stellar Logistics' }, { name: 'Swift Mobility', renamed: 'Swift Labs' }, { name: 'Harbor Insurance' }, { name: 'Vista Bank' }, { name: 'Vesta Bank', lookalike: 6 }],
};
const CUSTOMER_RENAME_WEEK = 23;
/** Which customer escalates each team's P1s (k = 0, 2, 4): both names of each look-alike pair, the renamed one before and after. */
const ESCALATIONS = [[0, 4, 2], [3, 0, 4], [6, 7, 5]];

/* --------------------------------- the script -------------------------------- */

export interface RCustomer { id: string; name: string; renamed?: { week: number; to: string }; lookalikeOf?: string }
export interface RPerson { id: string; name: string; team: string; role: string; joined: number; left?: number; movedTo?: { team: string; week: number } }
export interface RProject { id: string; team: string; name: string; renamed?: { week: number; to: string }; owner: string; ownerChange?: { week: number; to: string }; planned: number; launch: number; progress: number[]; lookalikeOf?: string }
export interface RIncident { id: string; team: string; week: number; sev: 'P1' | 'P2' | 'P3'; title: string; customer?: string; fixer: string; causeKind: number; cause: string; pmoSev?: 'P1' | 'P2' }
export interface RRisk { id: string; team: string; kind: number; opened: number; raisedBy: string; owner: string; ownerChange?: { week: number; to: string }; closed?: number; text: string; resolution: string }
/** A setting introduced by its name, then changed under its code, a short alias or a pronoun (the stale traps). */
export interface RTracked {
  id: string; team: string; name: string; alt: string; short: string; unit: string;
  /** In order: the first is the introduction; `correction` replaces what was said before (it was never right). */
  history: { week: number; value: number; how: 'intro' | 'change' | 'correction' | 'revert'; via: 'name' | 'code' | 'short' | 'pronoun' }[];
}
export interface RTeam { id: string; name: string; alt: string; def: number; lead: string; leadChange?: { week: number; to: string }; metric: { name: string; alt: string; unit: string; values: number[]; redefined?: { week: number; note: string } }; health: string[] }

export interface ReportScript {
  lang: Lang;
  seed: string;
  /**
   * The division: its index, what the PMO calls it (`label`, `alt` in the other language) and how questions say
   * which division they ask about (`scope`, `altScope`) — all '' when the company is one division. The PMO's
   * name ("第二事业部", "Division 2") is in the monthly summaries and in no weekly report: a question that
   * opened with it sent a keyword search to the summaries (hit@5 0.07 with the prefix, 0.39 without, on the
   * 2026-11 10× run). `scope` is in the words the weekly reports use: in Chinese "二部", as in "二部平台组"
   * — and "一部" for the first division, whose teams carry no prefix: a word of the same kind that no document
   * holds, so it sends a search nowhere (naming its three teams sent it to every summary, which name all three)
   * — and in English the division's three team names ("Platform 2, Payments 2 and Growth 2").
   */
  division: { index: number; label: string; alt: string; scope: string; altScope: string };
  teams: RTeam[];
  people: RPerson[];
  projects: RProject[];
  incidents: RIncident[];
  risks: RRisk[];
  customers: RCustomer[];
  tracked: RTracked[];
  /** Names two people of this division share. */
  twins: string[];
  /** Planted 5-hop chains: customer → incident → fixer → transfer → project → launch. */
  chains: { incident: string; person: string; project: string }[];
  /** Weeks a team reports overtime (a health signal, never named as such). */
  overtime: Record<string, number[]>;
  /** The PMO's monthly figures where they differ from the team's. */
  pmo: { team: string; month: number; field: 'launch' | 'headcount' | 'severity'; teamSays: string; pmoSays: string; ref?: string }[];
  styles: Record<string, StyleId>;
}

export interface ReportWorld {
  lang: Lang;
  divisions: ReportScript[];
  padTeams: ReportScript[];
}

type StyleId = 'terse' | 'narrative' | 'formal' | 'data';
const STYLES: StyleId[] = ['terse', 'narrative', 'formal', 'data'];

/** What a style is, as a gold list (labels in the pack's language). */
const STYLE_ITEMS: Record<Lang, Record<StyleId, GoldItem[]>> = {
  zh: {
    terse: [
      { label: '要点式短句，几乎没有成段文字', aliases: ['列表', '短句', '简洁'], weight: 1 },
      { label: '用✅⚠️等表情标记状态', aliases: ['表情', 'emoji', '✅'], weight: 1 },
      { label: '数字写在最前面', aliases: ['先写数字', '数字开头'], weight: 1 },
      { label: '没有结束语', aliases: ['不写结尾', '无落款'], weight: 1 },
    ],
    narrative: [
      { label: '成段叙述，像写信', aliases: ['段落', '叙述'], weight: 1 },
      { label: '常用“大概”“可能”“初步看”等保留措辞', aliases: ['含糊', '保留', '不确定的措辞'], weight: 1 },
      { label: '以“辛苦大家！”结尾', aliases: ['辛苦大家', '感谢团队'], weight: 1 },
      { label: '会写团队氛围和个人感受', aliases: ['氛围', '感受', '士气'], weight: 1 },
    ],
    formal: [
      { label: '用“一、二、三”编号的正式标题', aliases: ['编号标题', '一、二、三'], weight: 1 },
      { label: '大量被动句，如“已完成”“已上线”', aliases: ['被动', '已完成'], weight: 1 },
      { label: '夹用ETA、OKR等英文缩写', aliases: ['英文缩写', 'ETA', 'OKR'], weight: 1 },
      { label: '以“以上，请审阅。”结尾', aliases: ['请审阅', '以上'], weight: 1 },
    ],
    data: [
      { label: '指标用表格呈现', aliases: ['表格'], weight: 1 },
      { label: '每个数字都给环比', aliases: ['环比', '变化百分比'], weight: 1 },
      { label: '先结论后细节', aliases: ['结论先行', 'TL;DR'], weight: 1 },
      { label: '以“如有问题随时找我”结尾', aliases: ['随时找我'], weight: 1 },
    ],
  },
  en: {
    terse: [
      { label: 'short bullet points, almost no prose', aliases: ['bullets', 'terse'], weight: 1 },
      { label: 'status marked with ✅ ⚠️ emoji', aliases: ['emoji', '✅'], weight: 1 },
      { label: 'numbers first', aliases: ['leads with numbers'], weight: 1 },
      { label: 'no sign-off', aliases: ['no closing line'], weight: 1 },
    ],
    narrative: [
      { label: 'paragraphs, like a letter', aliases: ['prose', 'narrative'], weight: 1 },
      { label: 'hedges: "roughly", "probably", "at first glance"', aliases: ['hedging', 'tentative'], weight: 1 },
      { label: 'ends with "Thanks, everyone!"', aliases: ['thanks everyone'], weight: 1 },
      { label: 'writes about the team mood and feelings', aliases: ['morale', 'mood'], weight: 1 },
    ],
    formal: [
      { label: 'numbered formal headings (1., 2., 3.)', aliases: ['numbered headings'], weight: 1 },
      { label: 'passive voice ("has been completed")', aliases: ['passive'], weight: 1 },
      { label: 'abbreviations like ETA and OKR', aliases: ['ETA', 'OKR', 'acronyms'], weight: 1 },
      { label: 'ends with "Submitted for review."', aliases: ['for review'], weight: 1 },
    ],
    data: [
      { label: 'metrics in a table', aliases: ['table'], weight: 1 },
      { label: 'week-on-week change for every figure', aliases: ['week-on-week', 'WoW'], weight: 1 },
      { label: 'conclusion first (TL;DR)', aliases: ['TL;DR', 'bottom line first'], weight: 1 },
      { label: 'ends with "Ping me with questions"', aliases: ['ping me'], weight: 1 },
    ],
  },
};

interface TeamDef { name: string; desc: string; metric: string; unit: string; base: number; step: number; projects: string[]; renameTo: string; renameAt: number; renamed: number; titles: string[] }

/**
 * The three kinds of team. The first team's second project and the second
 * team's first are near-identical names; each team renames one project.
 * `desc` names the team without a word of its name (non-lexical hops).
 */
const TEAM_DEFS: Record<Lang, TeamDef[]> = {
  zh: [
    { name: '平台组', desc: '管基础设施的那个组', metric: '服务可用性', unit: '%', base: 99.9, step: 0.002, projects: ['Atlas', '结算平台'], renamed: 0, renameTo: 'Orion', renameAt: 20, titles: ['缓存击穿', '数据延迟', '配置下发失败'] },
    { name: '支付组', desc: '管收款的那个组', metric: '支付成功率', unit: '%', base: 97.2, step: 0.03, projects: ['结算中台', '风控引擎'], renamed: 1, renameTo: '天秤', renameAt: 22, titles: ['支付超时', '账单错误', '退款卡单'] },
    { name: '增长组', desc: '管拉新的那个组', metric: '周活跃用户', unit: '万', base: 120, step: 1.2, projects: ['推荐系统改版', '新人礼包'], renamed: 0, renameTo: '千人千面', renameAt: 26, titles: ['推送重复', '登录失败', '活动页白屏'] },
  ],
  en: [
    { name: 'Platform', desc: 'the infrastructure group', metric: 'service availability', unit: '%', base: 99.9, step: 0.002, projects: ['Atlas', 'Settlement Hive'], renamed: 0, renameTo: 'Orion', renameAt: 20, titles: ['cache stampede', 'data lag', 'config push failure'] },
    { name: 'Payments', desc: 'the group that moves the money', metric: 'payment success rate', unit: '%', base: 97.2, step: 0.03, projects: ['Settlement Hub', 'Risk Engine'], renamed: 1, renameTo: 'Libra', renameAt: 22, titles: ['payment timeout', 'billing error', 'stuck refunds'] },
    { name: 'Growth', desc: 'the user-acquisition group', metric: 'weekly active users', unit: 'k', base: 1200, step: 12, projects: ['Recs Revamp', 'Welcome Bonus'], renamed: 0, renameTo: 'Mosaic', renameAt: 26, titles: ['duplicate push', 'login failure', 'blank campaign page'] },
  ],
};

/** Project names of the divisions after the first: no name inside another. */
const PROJECT_POOL: Record<Lang, { head: string[]; tail: string[] }> = {
  zh: { head: ['天枢', '天璇', '天玑', '天权', '玉衡', '开阳', '摇光', '北辰', '南斗', '紫微', '太微', '少微', '文昌', '司命', '织女', '参宿', '心宿', '房宿', '角宿', '亢宿', '氐宿', '箕宿'], tail: ['计划', '工程', '系统', '中心', '方案'] },
  en: { head: ['Altair', 'Capella', 'Deneb', 'Electra', 'Fomalhaut', 'Hadar', 'Izar', 'Kochab', 'Lesath', 'Mira', 'Nunki', 'Polaris', 'Rigel', 'Sirius', 'Thuban', 'Vega', 'Wezen', 'Zosma', 'Alcor', 'Merak', 'Mizar', 'Spica'], tail: ['Hub', 'Core', 'Suite', 'Gate', 'Desk'] },
};

/** Settings each kind of team tracks: name, its other-language name, a short alias, a unit, three values. */
const TRACKED: Record<Lang, { name: string; short: string; unit: string; values: [number, number, number] }[][]> = {
  zh: [
    [{ name: '订单库连接池上限', short: '池上限', unit: '个连接', values: [200, 240, 320] }, { name: '日志保留天数', short: '保留期', unit: '天', values: [30, 45, 60] }, { name: '核心接口超时阈值', short: '超时线', unit: '毫秒', values: [800, 1200, 1000] }],
    [{ name: '单笔退款审批上限', short: '审批线', unit: '元', values: [5000, 8000, 6500] }, { name: '对账批次间隔', short: '批次间隔', unit: '分钟', values: [15, 30, 20] }, { name: '风控拦截分数线', short: '拦截线', unit: '分', values: [80, 85, 75] }],
    [{ name: '每日推送上限', short: '推送配额', unit: '条', values: [3, 5, 4] }, { name: '新人礼包金额', short: '礼包额度', unit: '元', values: [20, 30, 25] }, { name: '活动页缓存时长', short: '缓存期', unit: '分钟', values: [10, 30, 15] }],
  ],
  en: [
    [{ name: 'order DB connection pool cap', short: 'the pool cap', unit: ' connections', values: [200, 240, 320] }, { name: 'log retention period', short: 'retention', unit: ' days', values: [30, 45, 60] }, { name: 'core API timeout threshold', short: 'the timeout line', unit: ' ms', values: [800, 1200, 1000] }],
    [{ name: 'per-refund approval limit', short: 'the approval line', unit: ' dollars', values: [5000, 8000, 6500] }, { name: 'reconciliation batch interval', short: 'the batch gap', unit: ' minutes', values: [15, 30, 20] }, { name: 'fraud block score', short: 'the block line', unit: ' points', values: [80, 85, 75] }],
    [{ name: 'daily push cap', short: 'the push quota', unit: ' pushes', values: [3, 5, 4] }, { name: 'welcome bonus amount', short: 'the bonus size', unit: ' dollars', values: [20, 30, 25] }, { name: 'campaign page cache time', short: 'the cache window', unit: ' minutes', values: [10, 30, 15] }],
  ],
};

/**
 * Root causes, five kinds, six ways to say each: no two phrasings of a kind
 * share a word (or two Chinese characters), so incidents with the same cause
 * are connected only by what the words mean.
 */
const CAUSES: Record<Lang, string[][]> = {
  zh: [
    ['配置项写错', '参数填反了', '开关下发有误', '上线时漏改了一个设置', '阈值设得不对', '灰度规则没生效'],
    ['容量不足', '机器不够用', '流量超出预估', '连接数被打满', '磁盘写满了', '峰值压垮了实例'],
    ['依赖服务超时', '下游接口迟迟不返回', '第三方回调丢失', '上游推送中断', '外部网关限流', '合作方证书过期'],
    ['代码缺陷', '一处空指针', '并发写入冲突', '边界条件没覆盖', '新版本引入的回归', '死循环耗尽线程'],
    ['数据迁移遗漏', '旧表字段格式不一', '脏记录混入', '索引没重建', '导入脚本中途退出', '缓存与库对不上'],
  ],
  en: [
    ['a bad config', 'a flag pushed with the wrong value', 'a threshold set too low', 'a setting missed during rollout', 'swapped parameters', 'a canary rule that never applied'],
    ['capacity', 'not enough machines', 'traffic beyond the forecast', 'an exhausted connection pool', 'a full disk', 'peak load crushing the instances'],
    ['a dependency timing out', 'a downstream API that stopped answering', 'lost third-party callbacks', 'an upstream feed that broke off', 'rate limiting at an external gateway', "a partner's expired certificate"],
    ['a code defect', 'a null pointer', 'a race between concurrent writes', 'an untested edge case', 'a regression in the new release', 'an infinite loop starving threads'],
    ['a missed data migration', 'mismatched legacy formats', 'dirty records slipping in', 'an index never rebuilt', 'an import script that died halfway', 'a cache out of sync with the database'],
  ],
};

/** Risks, four kinds, one phrasing per team of a division: the same problem in three teams' words. */
const RISKS: Record<Lang, string[][]> = {
  zh: [
    ['核心依赖年底停止维护', '底层组件明年不再有补丁', '所用框架即将停更'],
    ['关键岗位只有一人', '某个模块仅一位同事熟悉', '人员单点，请假即停摆'],
    ['供应商合同到期', '外包协议快要失效', '采购的服务年中续约未定'],
    ['压测环境不足', '没有地方做性能演练', '缺少仿真流量的机器'],
  ],
  en: [
    ['a core dependency reaches end of life', 'an underlying component stops getting patches next year', 'the framework we build on is being discontinued'],
    ['a key role has one person', 'only a single engineer understands one module', 'if one colleague is away, that area stalls'],
    ['a vendor contract expires', 'the outsourcing agreement is about to lapse', 'renewal of a purchased service is unsettled'],
    ['no load-test environment', 'nowhere to rehearse performance', 'no machines to replay simulated traffic'],
  ],
};
const RESOLUTIONS: Record<Lang, string[]> = { zh: ['已完成替换', '已补招一人', '已续签', '已申请到资源'], en: ['replaced', 'a second hire made', 'contract renewed', 'resources granted'] };
const HEALTH: Record<Lang, string[]> = { zh: ['健康', '吃紧', '透支'], en: ['healthy', 'stretched', 'burning out'] };

export interface ReportOptions {
  /** Divisions of three teams (1, 10, 100): the corpus generated natively at that size. */
  size?: number;
  /** Padding teams (scale curves): reports naming nobody the tasks ask about. */
  padTeams?: number;
}

/** The whole company, from a seed: no model, any number of divisions and padding teams. */
export function makeReportWorld(lang: Lang, seed: string | number, opts: ReportOptions = {}): ReportWorld {
  const r = rng(parseInt(seededKey(seed, `reports-${lang}`).slice(0, 8), 16));
  const N = NAMES[lang];
  const size = Math.max(1, Math.floor(opts.size ?? 1));
  const used = new Set<string>(TWINS[lang].names);
  // risk ids run across the whole company (R-01 … in the first division, on from there)
  const seq = { risk: 0 };
  const sur = size > 1 ? [...N.sur, ...N.moreSur] : N.sur;
  const person = nameMaker(lang, r, used, sur, N.given, N.given2);
  const projectNames = new Set<string>();
  const divisions: ReportScript[] = [];
  for (let d = 0; d < size; d++) {
    const twins = d === 0 ? TWINS[lang].names : TWINS[lang].sur.map((s) => {
      for (;;) {
        const name = lang === 'zh' ? `${s}${N.given[Math.floor(r() * N.given.length)]}${r() < 0.5 ? '' : N.given2[Math.floor(r() * N.given2.length)]}` : `${N.given[Math.floor(r() * N.given.length)]} ${String.fromCharCode(65 + Math.floor(r() * 26))}. ${s}`;
        if (!used.has(name)) {
          used.add(name);
          return name;
        }
      }
    });
    divisions.push(buildDivision(lang, r, String(seed), { index: d, size }, person, twins, customersOf(CUSTOMERS[lang]), projectNames, seq));
  }
  const pads: ReportScript[] = [];
  const padPerson = nameMaker(lang, r, used, N.padSur, N.given, N.given2);
  const padCustomers = customersOf(N.padCustomers.map((name) => ({ name })));
  for (let i = 0; i < (opts.padTeams ?? 0); i++) pads.push(buildDivision(lang, r, String(seed), { index: i, size, pad: true }, padPerson, [], padCustomers, projectNames, seq));
  return { lang, divisions, padTeams: pads };
}

/** The first division (the whole corpus at size 1) with the padding teams: what v1 of this recipe returned. */
export function makeReportScript(lang: Lang, seed: string | number, opts: ReportOptions = {}): ReportScript & { padTeams: ReportScript[]; divisions: ReportScript[] } {
  const w = makeReportWorld(lang, seed, opts);
  return { ...w.divisions[0], padTeams: w.padTeams, divisions: w.divisions };
}

function nameMaker(lang: Lang, r: () => number, used: Set<string>, sur: string[], given: string[], given2: string[]): () => string {
  return () => {
    for (let i = 0; ; i++) {
      const s = sur[Math.floor(r() * sur.length)];
      const g = given[Math.floor(r() * given.length)];
      // two-character names first; three characters (an initial) once they run short
      const name = lang === 'zh' ? (i < 30 ? `${s}${g}` : `${s}${given2[Math.floor(r() * given2.length)]}`) : i < 30 ? `${g} ${s}` : `${g} ${given2[0][Math.floor(r() * given2[0].length)]}. ${s}`;
      if (!used.has(name)) {
        used.add(name);
        return name;
      }
    }
  };
}

function customersOf(table: { name: string; renamed?: string; lookalike?: number }[]): RCustomer[] {
  return table.map((c, i) => ({ id: `C${i}`, name: c.name, ...(c.renamed ? { renamed: { week: CUSTOMER_RENAME_WEEK, to: c.renamed } } : {}), ...(c.lookalike !== undefined ? { lookalikeOf: `C${c.lookalike}` } : {}) }));
}

function divisionLabel(lang: Lang, index: number, size: number): { label: string; alt: string } {
  if (size <= 1) return { label: '', alt: '' };
  return lang === 'zh' ? { label: `第${cnNum(index + 1)}事业部`, alt: `Division ${index + 1}` } : { label: `Division ${index + 1}`, alt: `第${cnNum(index + 1)}事业部` };
}

/** How a question says which division it asks about, in the words the weekly reports name teams with (see `ReportScript.division`). */
function divisionScope(lang: Lang, index: number, size: number, teams: string[]): string {
  if (size <= 1) return '';
  if (lang === 'zh') return `${cnNum(index + 1)}部`;
  return `${teams.slice(0, -1).join(', ')} and ${teams.at(-1)}`;
}

function teamNames(lang: Lang, defIndex: number, d: number): { name: string; alt: string } {
  const other: Lang = lang === 'zh' ? 'en' : 'zh';
  const named = (l: Lang) => (d === 0 ? TEAM_DEFS[l][defIndex].name : l === 'zh' ? `${cnNum(d + 1)}部${TEAM_DEFS.zh[defIndex].name}` : `${TEAM_DEFS.en[defIndex].name} ${d + 1}`);
  return { name: named(lang), alt: other === 'en' ? `the ${named('en')} team` : named('zh') };
}

function buildDivision(
  lang: Lang, r: () => number, seed: string, at: { index: number; size: number; pad?: boolean }, name: () => string, twins: string[],
  customers: RCustomer[], projectNames: Set<string>, seq: { risk: number },
): ReportScript {
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const zh = lang === 'zh';
  const focal = !at.pad;
  const d = at.index;
  const teams: RTeam[] = [];
  const people: RPerson[] = [];
  const projects: RProject[] = [];
  const incidents: RIncident[] = [];
  const risks: RRisk[] = [];
  const tracked: RTracked[] = [];
  const overtime: Record<string, number[]> = {};
  const pmo: ReportScript['pmo'] = [];
  const styles: Record<string, StyleId> = {};
  const roles = zh ? ['后端工程师', '前端工程师', '测试工程师', '数据工程师', '产品经理'] : ['backend engineer', 'frontend engineer', 'QA engineer', 'data engineer', 'product manager'];
  const other: Lang = zh ? 'en' : 'zh';
  const poolName = () => {
    const P = PROJECT_POOL[lang];
    for (let i = 0; ; i++) {
      const n = `${pick(P.head)}${zh ? '' : ' '}${pick(P.tail)}${i > 40 ? `-${d + 1}` : ''}`;
      if (!projectNames.has(n)) {
        projectNames.add(n);
        return n;
      }
    }
  };
  // one pass per team kind; a padding team is one team of the kind its index gives
  const defs = focal ? [0, 1, 2] : [d % 3];
  let inc = 0;
  defs.forEach((di, ti) => {
    const def = TEAM_DEFS[lang][di];
    const names = focal ? teamNames(lang, di, d) : { name: zh ? `业务${d + 1}组` : `Unit ${d + 1}`, alt: '' };
    const team = focal ? (d === 0 ? `T${ti + 1}` : `D${d + 1}T${ti + 1}`) : `P-${names.name}`;
    const lead = name();
    const members = [lead, ...Array.from({ length: 6 }, () => name())];
    // namesakes: the first in the first two teams, the second in the last two, the third among the hires
    if (focal && twins.length) {
      if (ti < 2) members[3] = twins[0];
      if (ti > 0) members[4] = twins[1];
    }
    members.forEach((m, k) => people.push({ id: `${team}-${k}`, name: m, team, role: k === 0 ? (zh ? '负责人' : 'lead') : pick(roles), joined: 1 }));
    const hireWeek = 8 + Math.floor(r() * 20);
    people.push({ id: `${team}-h`, name: focal && twins.length && ti !== 1 ? twins[2] : name(), team, role: pick(roles), joined: hireWeek });
    const leaver = people.find((p) => p.id === `${team}-5`)!;
    leaver.left = 14 + Math.floor(r() * 20);
    const t: RTeam = {
      id: team, name: names.name, alt: names.alt, def: di, lead,
      metric: {
        name: def.metric, alt: TEAM_DEFS[other][di].metric, unit: def.unit,
        values: Array.from({ length: REPORT_WEEKS }, (_, w) => {
          const noise = (r() - 0.5) * def.step * 3;
          const v = def.base + def.step * w * (di === 2 && w >= 29 ? 0.6 : 1) + noise - (di === 2 && w >= 29 ? def.base * 0.08 : 0);
          return Number(Math.min(def.unit === '%' ? 99.999 : Infinity, v).toFixed(def.unit === '%' ? (def.base > 99 ? 3 : 2) : 0));
        }),
        ...(di === 2 ? { redefined: { week: 30, note: zh ? '自本周起周活跃用户口径调整：剔除测试账号和机器人账号' : 'from this week weekly active users exclude test and bot accounts' } } : {}),
      },
      health: [],
    };
    // one team's lead leaves halfway: a new lead, a new style
    if (focal && di === 1) t.leadChange = { week: 27, to: members[1] };
    teams.push(t);
    styles[lead] = STYLES[ti % 4];
    if (t.leadChange) styles[t.leadChange.to] = 'data';
    // projects: progress per week, a planned and an actual launch; one renamed per team
    const pnames = !focal ? [`Nova-${d + 1}`, `Vega-${d + 1}`] : d === 0 ? def.projects : [poolName(), poolName()];
    if (d === 0 && focal) for (const p of pnames) projectNames.add(p);
    pnames.forEach((pname, pi) => {
      const planned = 20 + Math.floor(r() * 18) + pi * 8;
      const slip = pi === 1 ? 6 + Math.floor(r() * 6) : Math.floor(r() * 3);
      const launch = Math.min(REPORT_WEEKS, planned + slip);
      const startW = 2 + pi * 4;
      const progress = Array.from({ length: REPORT_WEEKS }, (_, w0) => {
        const w = w0 + 1;
        if (w < startW) return 0;
        if (w >= launch) return 100;
        return Math.min(99, Math.round(((w - startW) / Math.max(1, launch - startW)) * 100));
      });
      const renameTo = focal && pi === def.renamed ? (d === 0 ? def.renameTo : poolName()) : undefined;
      projects.push({ id: `${team}-p${pi}`, team, name: pname, owner: members[2 + pi], planned, launch, progress, ...(renameTo ? { renamed: { week: def.renameAt, to: renameTo } } : {}) });
    });
    // incidents: at least three P1s a team, the P1s escalated by customers (both names of the look-alike pairs)
    for (let k = 0; k < 7; k++) {
      const week = 3 + k * 6 + Math.floor(r() * 4);
      if (week > REPORT_WEEKS - 1) break;
      const sev = k % 2 === 0 ? 'P1' : k % 3 === 0 ? 'P2' : 'P3';
      const customer = sev === 'P1' && k < 6 ? (focal ? customers[ESCALATIONS[ti][k / 2]].id : customers[(d * 2 + k) % customers.length].id) : undefined;
      incidents.push({ id: `INC-${focal ? '' : 'X'}${String(++inc).padStart(3, '0')}-${team}`, team, week, sev, title: def.titles[k % def.titles.length], customer, fixer: members[1 + (k % 5)], causeKind: k % 5, cause: '' });
    }
    // risks: raised, owned, sometimes handed over, mostly closed; each kind in each team's own words
    for (let k = 0; k < 4; k++) {
      const opened = 2 + k * 9 + Math.floor(r() * 5);
      const closed = k === 3 ? undefined : opened + 6 + Math.floor(r() * 10);
      risks.push({ id: `R-${focal ? '' : 'X'}${String(++seq.risk).padStart(2, '0')}`, team, kind: k, opened, raisedBy: members[1 + k], owner: members[2 + k], ...(k === 1 ? { ownerChange: { week: opened + 4, to: members[2] } } : {}), ...(closed && closed <= REPORT_WEEKS ? { closed } : {}), text: RISKS[lang][k][ti % 3], resolution: RESOLUTIONS[lang][k] });
    }
    // settings: introduced by name, then changed, corrected or reverted under another name
    if (focal) {
      TRACKED[lang][di].forEach((x, k) => {
        const intro = 2 + k * 4 + Math.floor(r() * 3);
        const b = intro + 8 + Math.floor(r() * 6);
        const c = b + 8 + Math.floor(r() * 5);
        const mode = (ti + k + d) % 3;
        const via = (n: number): 'code' | 'short' | 'pronoun' => (['code', 'short', 'pronoun'] as const)[(ti + k + n + d) % 3];
        const history: RTracked['history'] = [{ week: intro, value: x.values[0], how: 'intro', via: 'name' }];
        if (mode === 0) history.push({ week: b, value: x.values[1], how: 'correction', via: via(0) });
        else if (mode === 1) history.push({ week: b, value: x.values[1], how: 'change', via: via(0) }, { week: c, value: x.values[0], how: 'revert', via: via(1) });
        else history.push({ week: b, value: x.values[1], how: 'change', via: via(0) }, { week: c, value: x.values[2], how: 'change', via: via(1) });
        tracked.push({ id: `${team}-C${k + 1}`, team, name: x.name, alt: TRACKED[other][di][k].name, short: x.short, unit: x.unit, history });
      });
    }
    // overtime: a burst in the quarter this team strains
    const strained = di === 2 ? 3 : di === 1 ? 2 : 0;
    overtime[team] = weeksUpTo(REPORT_WEEKS).filter((w) => strained && Math.ceil(w / 13) === strained && r() < 0.7);
    t.health = [1, 2, 3, 4].map((q) => {
      const ot = overtime[team].filter((w) => Math.ceil(w / 13) === q).length;
      const p1 = incidents.filter((i) => i.team === team && i.sev === 'P1' && Math.ceil(i.week / 13) === q).length;
      const leaving = people.filter((p) => p.team === team && p.left && Math.ceil(p.left / 13) === q).length;
      const score = ot / 3 + p1 + leaving;
      return HEALTH[lang][score >= 4 ? 2 : score >= 2 ? 1 : 0];
    });
  });
  // one phrasing per incident, never the same twice for one cause in a division
  const seen = new Map<number, number>();
  for (const i of [...incidents].sort((a, b) => a.week - b.week || a.team.localeCompare(b.team))) {
    const n = seen.get(i.causeKind) ?? 0;
    seen.set(i.causeKind, n + 1);
    i.cause = CAUSES[lang][i.causeKind][n % CAUSES[lang][i.causeKind].length];
  }

  const chains: ReportScript['chains'] = [];
  if (focal) {
    // transfers: a fixer of an escalated P1 moves to another team and takes over a project there
    for (const [from, to] of [[0, 2], [1, 0], [2, 1]] as const) {
      for (const p1 of incidents.filter((i) => i.team === teams[from].id && i.customer && i.week < 20)) {
        const mover = people.find((p) => p.name === p1.fixer && p.team === teams[from].id && !p.left && !p.movedTo && !twins.includes(p.name) && p.name !== teams[from].lead && p.name !== teams[from].leadChange?.to
          && !projects.some((x) => x.owner === p.name) && !risks.some((x) => x.owner === p.name || x.ownerChange?.to === p.name));
        if (!mover) continue;
        const week = p1.week + 5 + Math.floor(r() * 4);
        const project = projects.find((p) => p.team === teams[to].id && p.launch > week + 4 && p.launch <= CORPUS_WEEKS && !p.ownerChange);
        if (!project) continue;
        mover.movedTo = { team: teams[to].id, week };
        project.ownerChange = { week: week + 2, to: mover.name };
        chains.push({ incident: p1.id, person: mover.id, project: project.id });
        break;
      }
    }
    // the PMO's monthly figures that differ from the teams'
    teams.forEach((t, ti) => {
      const p = projects.find((x) => x.team === t.id)!;
      pmo.push({ team: t.id, month: Math.min(10, monthOf(p.planned) - 1 || 2), field: 'launch', teamSays: String(p.planned), pmoSays: String(p.planned + 2), ref: p.id });
      const mover = people.find((x) => x.movedTo?.team === t.id);
      if (mover) pmo.push({ team: t.id, month: monthOf(mover.movedTo!.week), field: 'headcount', teamSays: 'team', pmoSays: 'lag', ref: mover.id });
      const p2 = incidents.find((i) => i.team === t.id && i.sev === 'P2' && i.week <= CORPUS_WEEKS - 4);
      if (p2 && ti !== 1) {
        p2.pmoSev = 'P1';
        pmo.push({ team: t.id, month: monthOf(p2.week), field: 'severity', teamSays: 'P2', pmoSays: 'P1', ref: p2.id });
      }
    });
    // the near-identical project pair: the first team's second project and the second team's first
    if (d === 0) projects.find((p) => p.id === `${teams[0].id}-p1`)!.lookalikeOf = `${teams[1].id}-p0`;
  }
  const label = focal ? divisionLabel(lang, d, at.size) : { label: '', alt: '' };
  const scope = focal ? { scope: divisionScope(lang, d, at.size, teams.map((t) => t.name)), altScope: divisionScope(lang === 'zh' ? 'en' : 'zh', d, at.size, teams.map((t) => t.alt)) } : { scope: '', altScope: '' };
  return { lang, seed, division: { index: d, ...label, ...scope }, teams, people, projects, incidents, risks, customers, tracked, twins: focal ? twins : [], chains, overtime, pmo, styles };
}

/* ---------------------------------- rendering ---------------------------------- */

/** Who is in a team in a week, and who leads it. */
export function rosterOf(s: ReportScript, team: string, week: number): RPerson[] {
  return s.people.filter((p) => {
    const inTeam = p.team === team ? !(p.movedTo && week >= p.movedTo.week) : p.movedTo?.team === team && week >= p.movedTo.week;
    return inTeam && p.joined <= week && !(p.left && week >= p.left);
  });
}
const leadOf = (t: RTeam, week: number) => (t.leadChange && week >= t.leadChange.week ? t.leadChange.to : t.lead);
const projectName = (p: RProject, week: number) => (p.renamed && week >= p.renamed.week ? p.renamed.to : p.name);
export const customerName = (c: RCustomer, week: number) => (c.renamed && week >= c.renamed.week ? c.renamed.to : c.name);
/** The value a setting holds after week `week`'s report (a correction replaces what it corrects). */
export function trackedValue(x: RTracked, week: number): number | undefined {
  let v: number | undefined;
  for (const h of x.history) if (h.week <= week) v = h.value;
  return v;
}

interface Line {
  key: string;
  text: string;
  /** How the formal style writes it, when that differs. */
  formal?: string;
  /** A metric line as a table row: name, value. */
  cells?: [string, string];
}

/** Several ways to state each kind of fact; the seed picks one per fact, so no one pattern finds them all. */
const PHRASES: Record<Lang, Record<string, string[]>> = {
  zh: {
    progress: ['{p}完成度{n}%，负责人{o}，计划第{w}周上线', '{p}：进度{n}%（负责人{o}），目标第{w}周上线', '{p}推进到{n}%，{o}负责，按计划第{w}周上线'],
    launch: ['{p}已于本周上线', '{p}本周正式上线', '{p}完成上线'],
    late: ['，已延期{d}周', '，比计划晚{d}周', '，落后计划{d}周'],
    rename: ['（原项目名{a}，自本周起改名为{b}）', '（{a}自本周起更名为{b}）'],
    takeover: ['（自本周起由{o}接手）', '（{o}本周起接手）'],
    metric: ['{m}：{v}', '本周{m}为{v}', '{m}本周是{v}'],
    incident: ['{id}（{sev}）{t}{c}', '新增{sev}事故{id}：{t}{c}', '{id}，级别{sev}，{t}{c}'],
    escalated: ['，由客户{x}升级', '，客户{x}升级上来的', '（{x}投诉升级）'],
    postmortem: ['{id}复盘：根因是{cause}，由{f}修复', '{id}已修复（{f}），原因：{cause}', '上周那起{t}已由{f}修复，根因是{cause}'],
    riskNew: ['新风险{id}：{t}（{r}提出，负责人{o}）', '{r}提出风险{id}：{t}，由{o}负责', '登记风险{id}（{t}），提出人{r}，负责人{o}'],
    riskClosed: ['{id}已关闭：{res}', '{id}关闭（{res}）', '风险{id}解除：{res}'],
    riskOwner: ['{id}负责人改为{o}', '{id}转由{o}负责', '{o}接手{id}'],
    riskOpen: ['{id}仍未解决（负责人{o}）', '{id}跟进中，负责人{o}', '{id}未关闭，{o}在跟'],
    join: ['{n}加入，任{r}', '新同事{n}入职，岗位{r}', '{n}到岗（{r}）'],
    left: ['{n}本周离职', '{n}已离开公司', '{n}办完离职'],
    out: ['{n}调往{t}', '{n}转岗去了{t}', '{n}调到{t}'],
    in: ['{n}从{t}调入', '{n}由{t}转来', '欢迎{n}从{t}加入'],
    headcount: ['在岗{n}人', '目前{n}人', '团队共{n}人'],
    overtime: ['本周有{n}天加班到十点以后', '这周{n}个晚上过了十点才走', '本周{n}天熬到十点后'],
    intro: ['{name}（{code}，下称“{short}”）定为{v}', '新定{name}：{v}（编号{code}，简称{short}）'],
    change_code: ['{code}调整为{v}', '自本周起{code}改为{v}'],
    change_short: ['{short}从本周起改成{v}', '{short}调整到{v}'],
    change_pronoun: ['复查了{short}的执行情况。|这个值自本周起改为{v}', '讨论了{short}。|决定从本周起把它定为{v}'],
    correction_code: ['更正：{code}此前写的{old}有误，应为{v}', '{code}撤回原先的{old}，以{v}为准'],
    correction_short: ['{short}之前报错了，正确的是{v}', '{short}的{old}作废，实际是{v}'],
    correction_pronoun: ['核对了{short}的记录。|之前那个数写错了，应为{v}', '翻了{short}的旧记录。|先前报的{old}不对，实际是{v}'],
    revert_code: ['{code}恢复为{v}', '{code}改回{v}'],
    revert_short: ['{short}改回{v}', '{short}恢复原值{v}'],
    revert_pronoun: ['又讨论了{short}。|决定改回原来的{v}', '复盘了{short}的调整。|还是恢复成{v}'],
    recapMetric: ['（两周前{m}是{v}）', '回顾：两周前{m}为{v}'],
    recapTracked: ['（{name}最初定的是{v}）', '备注：{name}起初是{v}'],
    recapProgress: ['（一个月前{p}完成度{n}%）', '回顾：四周前{p}在{n}%'],
  },
  en: {
    progress: ['{p} at {n}%, owner {o}, launch planned for week {w}', '{p}: {n}% done (owner {o}), targeting week {w}', '{p} is {n}% complete; {o} owns it; planned launch week {w}'],
    launch: ['{p} launched this week', '{p} went out this week', '{p} shipped this week'],
    late: [', {d} weeks late', ', {d} weeks behind plan', ', running {d} weeks over'],
    rename: [' (formerly {a}, renamed {b} from this week)', ' ({a} is called {b} from this week)'],
    takeover: [' ({o} takes over from this week)', ' (now with {o})'],
    metric: ['{m}: {v}', '{m} this week: {v}', '{m} came in at {v}'],
    incident: ['{id} ({sev}) {t}{c}', 'new {sev} incident {id}: {t}{c}', '{id}, severity {sev}, {t}{c}'],
    escalated: [', escalated by {x}', ', raised to us by {x}', ' ({x} escalated it)'],
    postmortem: ['{id} postmortem: caused by {cause}, fixed by {f}', '{id} resolved by {f}; root cause: {cause}', "last week's {t} was fixed by {f}; root cause: {cause}"],
    riskNew: ['new risk {id}: {t} (raised by {r}, owner {o})', '{r} raised risk {id}: {t}; owner {o}', 'risk {id} logged ({t}), raised by {r}, owner {o}'],
    riskClosed: ['{id} closed: {res}', '{id} closed ({res})', 'risk {id} retired: {res}'],
    riskOwner: ['{id} now owned by {o}', '{id} handed to {o}', '{o} takes {id}'],
    riskOpen: ['{id} still open (owner {o})', '{id} in progress, owner {o}', '{id} not closed; {o} on it'],
    join: ['{n} joined as {r}', 'new colleague {n} started as {r}', '{n} is on board ({r})'],
    left: ['{n} left the company this week', '{n} has left the company', "{n}'s last day was this week"],
    out: ['{n} moved to {t}', '{n} transferred to {t}', '{n} went over to {t}'],
    in: ['{n} joined us from {t}', '{n} transferred in from {t}', 'welcome {n}, over from {t}'],
    headcount: ['{n} people on the team', 'headcount {n}', 'the team is {n} people'],
    overtime: ['{n} nights past 10 pm this week', '{n} late nights (after 10 pm) this week', 'stayed past 10 pm on {n} nights'],
    intro: ['{name} ({code}, "{short}" below) set to {v}', 'new {name}: {v} (code {code}, short name {short})'],
    change_code: ['{code} changed to {v}', 'from this week {code} is {v}'],
    change_short: ['{short} moves to {v} from this week', '{short} adjusted to {v}'],
    change_pronoun: ['reviewed how {short} works in practice.|from this week that number is {v}', 'discussed {short}.|we set it to {v} from this week'],
    correction_code: ['correction: {code} was reported as {old} by mistake; it is {v}', '{code}: the earlier {old} is withdrawn, {v} stands'],
    correction_short: ['{short} was misreported; the right figure is {v}', '{short}: scrap the {old}, it is actually {v}'],
    correction_pronoun: ['checked the records on {short}.|the number given before was wrong; it is {v}', 'went back over {short}.|the {old} we reported was a mistake; it is {v}'],
    revert_code: ['{code} restored to {v}', '{code} back to {v}'],
    revert_short: ['{short} goes back to {v}', '{short} restored to {v}'],
    revert_pronoun: ['talked about {short} again.|back to the original {v}', 'reviewed the change to {short}.|we return it to {v}'],
    recapMetric: ['(two weeks ago {m} was {v})', 'recap: {m} two weeks ago: {v}'],
    recapTracked: ['(the {name} was first set at {v})', 'note: the {name} started at {v}'],
    recapProgress: ['(a month ago {p} was at {n}%)', 'recap: four weeks ago {p} stood at {n}%'],
  },
};

/** A phrasing for one fact, picked by the seed and the fact's key. */
function say(s: ReportScript, kind: string, key: string, vars: Record<string, string | number>): string {
  const list = PHRASES[s.lang][kind];
  const tpl = list[parseInt(seededKey(s.seed, `${kind}|${key}`).slice(0, 8), 16) % list.length];
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
}

const SECTIONS = ['progress', 'metric', 'incidents', 'risks', 'config', 'people', 'members', 'meeting', 'feedback', 'recap', 'mood', 'plan'] as const;
type Section = (typeof SECTIONS)[number];

/** What a team's report says in a week, as keyed lines; the style decides how they are laid out. */
export function facts(s: ReportScript, t: RTeam, week: number): Record<Section, Line[]> {
  const zh = s.lang === 'zh';
  const fmtV = (v: number) => (t.metric.unit === '%' ? `${v}%` : zh ? `${v}万` : `${v}k`);
  const out = Object.fromEntries(SECTIONS.map((k) => [k, [] as Line[]])) as Record<Section, Line[]>;
  const W = WORK[s.lang];
  const tw = `${t.id}|${week}`;
  for (const m of rosterOf(s, t.id, week).filter((p) => p.name !== leadOf(t, week))) {
    const a = hashPick(W.items, t.id, week, m.id, 'a');
    const b = hashPick(W.items, t.id, week, m.id, 'b');
    const st = hashPick(W.status, t.id, week, m.id);
    const ticket = `${zh ? '工单' : 'ticket'} ${t.id}-${1000 + ((week * 37 + m.id.length * 11 + a.length) % 900)}`;
    out.members.push({ key: `member:${m.id}`, text: zh ? `${m.name}：${a}（${st}）；${b}，${ticket}` : `${m.name}: ${a} (${st}); ${b}, ${ticket}` });
  }
  const own = s.projects.filter((p) => p.team === t.id && p.progress[week - 1] > 0 && p.progress[week - 1] < 100);
  for (let k = 0; k < 2; k++) {
    const p = own[k % Math.max(1, own.length)];
    out.plan.push({ key: `plan:${k}`, text: hashPick(W.plan, t.id, week, k).replace('{p}', p ? projectName(p, week) : zh ? '例行工作' : 'routine work') });
  }
  for (let k = 0; k < 3; k++) {
    const p = own[(k + week) % Math.max(1, own.length)];
    out.meeting.push({ key: `meeting:${k}`, text: hashPick(W.meeting, t.id, week, 'm', k).replace('{p}', p ? projectName(p, week) : zh ? '例行工作' : 'routine work') });
  }
  if (parseInt(seededKey('fb', tw).slice(0, 2), 16) < 90 && s.customers.length) {
    const c = customerName(hashPick(s.customers, t.id, week, 'c'), week);
    out.feedback.push({ key: 'feedback', text: zh ? `客户${c}${hashPick(W.feedback, t.id, week)}，已记录` : `${c} ${hashPick(W.feedback, t.id, week)}; logged` });
  }
  for (const p of s.projects.filter((x) => x.team === t.id)) {
    const name = projectName(p, week);
    const prog = p.progress[week - 1];
    if (prog === 0) continue;
    const prev = week > 1 ? p.progress[week - 2] : 0;
    if (prev === 100) continue;
    const owner = p.ownerChange && week >= p.ownerChange.week ? p.ownerChange.to : p.owner;
    const key = `${p.id}|${week}`;
    let text = prog === 100 ? say(s, 'launch', key, { p: name }) : say(s, 'progress', key, { p: name, n: prog, o: owner, w: p.planned });
    const formal = prog === 100 ? (zh ? `${name}已上线（ETA达成）` : `${name} has been launched (ETA met)`) : undefined;
    let suffix = '';
    if (p.renamed && week === p.renamed.week) suffix += say(s, 'rename', key, { a: p.name, b: p.renamed.to });
    if (p.ownerChange && week === p.ownerChange.week) suffix += say(s, 'takeover', key, { o: p.ownerChange.to });
    if (week > p.planned && prog < 100) suffix += say(s, 'late', key, { d: week - p.planned });
    text += suffix;
    out.progress.push({ key: `prog:${p.id}`, text, ...(formal ? { formal: formal + suffix } : {}) });
  }
  const v = t.metric.values[week - 1];
  const pv = week > 1 ? t.metric.values[week - 2] : v;
  out.metric.push({ key: 'metric', text: say(s, 'metric', tw, { m: t.metric.name, v: fmtV(v) }), cells: [t.metric.name, fmtV(v)] });
  out.metric.push({ key: 'metric-delta', text: zh ? `环比${v >= pv ? '+' : ''}${(((v - pv) / (pv || 1)) * 100).toFixed(2)}%` : `${v >= pv ? '+' : ''}${(((v - pv) / (pv || 1)) * 100).toFixed(2)}% week on week` });
  if (t.metric.redefined && week === t.metric.redefined.week) out.metric.push({ key: 'redefined', text: t.metric.redefined.note });
  for (const i of s.incidents.filter((x) => x.team === t.id && x.week === week)) {
    const c = i.customer ? say(s, 'escalated', i.id, { x: customerName(s.customers.find((x) => x.id === i.customer)!, week) }) : '';
    out.incidents.push({ key: `inc:${i.id}`, text: say(s, 'incident', i.id, { id: i.id, sev: i.sev, t: i.title, c }) });
  }
  for (const i of s.incidents.filter((x) => x.team === t.id && x.week + 1 === week)) {
    out.incidents.push({ key: `fix:${i.id}`, text: say(s, 'postmortem', i.id, { id: i.id, t: i.title, cause: i.cause, f: i.fixer }) });
  }
  for (const rk of s.risks.filter((x) => x.team === t.id && x.opened <= week && (!x.closed || x.closed >= week))) {
    const owner = rk.ownerChange && week >= rk.ownerChange.week ? rk.ownerChange.to : rk.owner;
    const key = `${rk.id}|${week}`;
    const text = week === rk.opened ? say(s, 'riskNew', key, { id: rk.id, t: rk.text, r: rk.raisedBy, o: owner })
      : week === rk.closed ? say(s, 'riskClosed', key, { id: rk.id, res: rk.resolution })
        : rk.ownerChange && week === rk.ownerChange.week ? say(s, 'riskOwner', key, { id: rk.id, o: owner })
          : say(s, 'riskOpen', key, { id: rk.id, o: owner });
    out.risks.push({ key: `risk:${rk.id}`, text });
  }
  for (const x of s.tracked.filter((y) => y.team === t.id)) {
    const val = (n: number) => `${n}${x.unit}`;
    x.history.forEach((h, hi) => {
      if (h.week !== week) return;
      const key = `${x.id}|${hi}`;
      const old = val(x.history[hi - 1]?.value ?? h.value);
      const text = h.how === 'intro' ? say(s, 'intro', key, { name: x.name, code: x.id, short: x.short, v: val(h.value) }) : say(s, `${h.how}_${h.via}`, key, { code: x.id, short: x.short, v: val(h.value), old });
      // a pronoun needs the sentence before it: both go in, the second names nothing
      text.split('|').forEach((part, pi) => out.config.push({ key: `cfg:${x.id}:${hi}${pi ? ':it' : ''}`, text: part }));
    });
  }
  for (const p of s.people) {
    if (p.team === t.id && p.joined === week && week > 1) out.people.push({ key: `join:${p.id}`, text: say(s, 'join', p.id, { n: p.name, r: p.role }) });
    if (p.team === t.id && p.left === week) out.people.push({ key: `left:${p.id}`, text: say(s, 'left', p.id, { n: p.name }) });
    if (p.movedTo && p.movedTo.week === week && p.team === t.id) out.people.push({ key: `out:${p.id}`, text: say(s, 'out', p.id, { n: p.name, t: s.teams.find((x) => x.id === p.movedTo!.team)!.name }) });
    if (p.movedTo && p.movedTo.week === week && p.movedTo.team === t.id) out.people.push({ key: `in:${p.id}`, text: say(s, 'in', p.id, { n: p.name, t: s.teams.find((x) => x.id === p.team)!.name }) });
  }
  if (t.leadChange && week === t.leadChange.week) out.people.push({ key: 'lead', text: zh ? `${t.lead}卸任，${t.leadChange.to}接任组负责人` : `${t.lead} steps down; ${t.leadChange.to} now leads the team` });
  out.people.push({ key: 'headcount', text: say(s, 'headcount', tw, { n: rosterOf(s, t.id, week).length }) });
  // the haystack carries old values of the same things: grep finds them beside the current ones
  const roll = parseInt(seededKey(s.seed, `recap|${tw}`).slice(0, 4), 16) / 0xffff;
  if (week > 2 && roll < 0.5) out.recap.push({ key: 'recap:metric', text: say(s, 'recapMetric', tw, { m: t.metric.name, v: fmtV(t.metric.values[week - 3]) }) });
  // a setting's first value, recalled by its name — never in a report that changes it (that would name it beside the new value)
  for (const x of s.tracked.filter((y) => y.team === t.id && y.history[0].week < week && trackedValue(y, week) !== y.history[0].value && !y.history.some((h) => h.week === week))) {
    if (parseInt(seededKey(s.seed, `recap|${x.id}|${week}`).slice(0, 4), 16) / 0xffff < 0.35) out.recap.push({ key: `recap:${x.id}`, text: say(s, 'recapTracked', `${x.id}|${week}`, { name: x.name, v: `${x.history[0].value}${x.unit}` }) });
  }
  const ongoing = own.find((p) => week > 4 && p.progress[week - 5] > 0);
  if (ongoing && roll > 0.6) out.recap.push({ key: `recap:${ongoing.id}`, text: say(s, 'recapProgress', tw, { p: projectName(ongoing, week), n: ongoing.progress[week - 5] }) });
  if (s.overtime[t.id]?.includes(week)) out.mood.push({ key: 'overtime', text: say(s, 'overtime', tw, { n: 2 + (week % 3) }) });
  return out;
}

const HEAD: Record<Lang, Record<Section, string>> = {
  zh: { progress: '进展', metric: '指标', incidents: '事故', risks: '风险', config: '配置', people: '人员', mood: '团队', members: '成员动态', meeting: '会议纪要', feedback: '客户反馈', recap: '回顾', plan: '下周计划' },
  en: { progress: 'Progress', metric: 'Metrics', incidents: 'Incidents', risks: 'Risks', config: 'Settings', people: 'People', mood: 'Team', members: 'Member updates', meeting: 'Meetings', feedback: 'Customer feedback', recap: 'Recap', plan: 'Next week' },
};

/** Everyday work: what fills most of a report and is gold for nothing. */
const WORK: Record<Lang, { items: string[]; status: string[]; plan: string[]; feedback: string[]; meeting: string[] }> = {
  zh: {
    items: ['完成接口评审', '补充单元测试', '整理监控看板', '优化慢查询', '对接下游团队', '编写技术方案', '处理工单', '本周值班', '参加需求评审', '修复测试环境问题', '更新部署脚本', '梳理告警规则', '做性能压测', '迁移历史数据', '带新人熟悉代码', '清理技术债', '升级依赖库版本', '整理接口文档'],
    status: ['已完成', '进行中', '待评审', '阻塞中，等待依赖方'],
    plan: ['推进{p}联调', '完成{p}的灰度方案', '准备季度复盘材料', '和产品对齐{p}的需求变更', '安排一次故障演练', '整理{p}的上线检查清单'],
    meeting: ['周会讨论了值班轮换，维持现状', '和运维对齐了下季度机器预算', '评审了{p}的接口设计，提了三条修改意见', '同步了公司新的代码评审规范', '讨论是否引入新的日志平台，暂不引入', '回顾了上月的告警噪音，计划减少一半', '和安全团队过了一遍权限清单', '确认了{p}的验收标准'],
    feedback: ['反馈对账报表导出偏慢', '询问新功能的上线时间', '希望增加批量操作', '反馈移动端偶发闪退', '提出接口限流阈值偏低', '表扬了上次问题处理及时'],
  },
  en: {
    items: ['finished the API review', 'added unit tests', 'cleaned up the monitoring dashboard', 'tuned slow queries', 'synced with the downstream team', 'wrote a design doc', 'worked through tickets', 'was on call', 'joined the requirements review', 'fixed the test environment', 'updated deploy scripts', 'pruned alert rules', 'ran load tests', 'migrated old data', 'onboarded a new hire', 'paid down tech debt', 'bumped library versions', 'tidied the API docs'],
    status: ['done', 'in progress', 'in review', 'blocked on a dependency'],
    plan: ['integration testing for {p}', 'a canary plan for {p}', 'quarterly review material', 'aligning with product on {p} changes', 'a failure drill', 'the {p} launch checklist'],
    meeting: ['weekly sync kept the on-call rotation as is', 'agreed next quarter\'s machine budget with ops', 'reviewed the {p} API design: three changes requested', 'went over the new code review guidelines', 'discussed a new logging platform: not now', 'reviewed last month\'s alert noise: aim to halve it', 'walked through access lists with security', 'agreed acceptance criteria for {p}'],
    feedback: ['says the reconciliation export is slow', 'asks when the new feature ships', 'wants bulk actions', 'reports occasional mobile crashes', 'finds the API rate limit too low', 'thanked us for the quick fix last time'],
  },
};

/** A deterministic pick for filler text, so it does not move the script's own random stream. */
const hashPick = <T>(xs: T[], ...key: (string | number)[]) => xs[parseInt(seededKey('fill', key.join('|')).slice(0, 8), 16) % xs.length];

/** One report, laid out in its author's style. */
export function renderReport(s: ReportScript, t: RTeam, week: number): { title: string; text: string; author: string } {
  const zh = s.lang === 'zh';
  const author = leadOf(t, week);
  const style = s.styles[author] ?? 'terse';
  const f = facts(s, t, week);
  const range = `${iso(dayOf(week))} ~ ${iso(dayOf(week, 4))}`;
  const title = zh ? `${t.name}周报 · 第${week}周` : `${t.name} weekly report · week ${week}`;
  const sections = SECTIONS.filter((k) => f[k].length);
  const lines: string[] = [`# ${title}`, '', `${range} · ${author}`, ''];
  const hedge = (x: string, i: number) => (zh ? `${['大概', '可能', '初步看'][i % 3]}${x}` : `${['roughly, ', 'probably ', 'at first glance '][i % 3]}${x}`);
  if (style === 'terse') {
    for (const k of sections) {
      lines.push(`**${HEAD[s.lang][k]}**`);
      for (const l of f[k]) lines.push(`- ${/^(risk|inc|fix|cfg)/.test(l.key) ? '⚠️' : '✅'} ${l.text}`);
      lines.push('');
    }
  } else if (style === 'narrative') {
    lines.push(zh ? '各位好，' : 'Hi all,', '');
    sections.forEach((k, i) => {
      const body = f[k].map((l, j) => (k === 'progress' && j === 0 ? hedge(l.text, week + i) : l.text)).join(zh ? '；' : '; ');
      lines.push(zh ? `${HEAD.zh[k]}方面，${body}。` : `On ${HEAD.en[k].toLowerCase()}: ${body}.`, '');
    });
    if (!f.mood.length) lines.push(zh ? '这周大家状态还不错。' : 'The team seemed in good spirits this week.', '');
    lines.push(zh ? '辛苦大家！' : 'Thanks, everyone!');
  } else if (style === 'formal') {
    sections.forEach((k, i) => {
      lines.push(zh ? `## ${cnNum(i + 1)}、${HEAD.zh[k]}` : `## ${i + 1}. ${HEAD.en[k]}`);
      for (const l of f[k]) lines.push(`${l.formal ?? l.text}${zh ? '。' : '.'}`);
      lines.push('');
    });
    lines.push(zh ? '以上，请审阅。' : 'Submitted for review.');
  } else {
    lines.push(zh ? `**结论**：${f.progress[0]?.text ?? f.metric[0].text}` : `**TL;DR**: ${f.progress[0]?.text ?? f.metric[0].text}`, '');
    lines.push(zh ? '| 指标 | 本周 | 环比 |' : '| Metric | This week | WoW |', '| --- | --- | --- |');
    lines.push(`| ${f.metric[0].cells![0]} | ${f.metric[0].cells![1]} | ${f.metric[1].text.replace(/环比| week on week/g, '')} |`, '');
    for (const k of sections.filter((x) => x !== 'metric')) {
      lines.push(`### ${HEAD[s.lang][k]}`);
      for (const l of f[k]) lines.push(`- ${l.text}`);
      lines.push('');
    }
    if (f.metric.length > 2) lines.push(f.metric[2].text, '');
    lines.push(zh ? '如有问题随时找我。' : 'Ping me with questions.');
  }
  return { title, text: lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n', author };
}

/** The PMO's monthly roll-up of a division: each team's headcount, its first project's launch week and its incidents — with the PMO's own figures. */
export function renderPmo(s: ReportScript, month: number): { title: string; text: string } {
  const zh = s.lang === 'zh';
  const weeks = weeksUpTo(CORPUS_WEEKS + 4).filter((w) => monthOf(w) === month);
  const last = weeks.at(-1)!;
  const div = s.division.label ? (zh ? `（${s.division.label}）` : ` (${s.division.label})`) : '';
  const lines = [zh ? `# 项目管理办公室月报 · ${month}月${div}` : `# PMO monthly summary · ${MONTHS_EN[month]}${div}`, ''];
  for (const t of s.teams) {
    const p = s.projects.find((x) => x.team === t.id)!;
    const diff = (field: string) => s.pmo.find((d) => d.team === t.id && d.month === month && d.field === field);
    let head = rosterOf(s, t.id, last).length;
    const lag = diff('headcount');
    if (lag) {
      const mover = s.people.find((x) => x.id === lag.ref)!;
      head += mover.movedTo!.team === t.id ? -1 : 0;
    }
    const launch = diff('launch') ? Number(diff('launch')!.pmoSays) : p.planned;
    const incs = s.incidents.filter((i) => i.team === t.id && weeks.includes(i.week));
    lines.push(`## ${t.name}`);
    lines.push(zh ? `- 在岗人数：${head}人` : `- Headcount: ${head}`);
    if (p.progress[last - 1] < 100) lines.push(zh ? `- ${projectName(p, last)}：预计第${launch}周上线` : `- ${projectName(p, last)}: expected to launch in week ${launch}`);
    for (const i of incs) lines.push(zh ? `- 事故${i.id}：${i.pmoSev ?? i.sev}` : `- Incident ${i.id}: ${i.pmoSev ?? i.sev}`);
    lines.push('');
  }
  return { title: lines[0].slice(2), text: lines.join('\n') + '\n' };
}

/* ------------------------------------ tasks ------------------------------------ */

/** The months whose last report lies inside the corpus, and that report's week: month-end gold. */
export function monthEndWeeks(lastWeek = CORPUS_WEEKS): { month: number; week: number }[] {
  const weeks = weeksUpTo(lastWeek);
  return [...new Set(weeks.map(monthOf))].map((month) => ({ month, week: Math.max(...weeks.filter((w) => monthOf(w) === month)) }));
}

/** Gold and tasks from a division's script and where each report landed (no model). */
export function reportTasks(s: ReportScript, docOf: (team: string, week: number) => string, pmoDoc: (month: number) => string, textOf: (doc: string) => string = () => ''): Draft[] {
  const zh = s.lang === 'zh';
  const L = s.lang;
  const out: Draft[] = [];
  const team = (id: string) => s.teams.find((t) => t.id === id)!;
  const cust = (id: string) => s.customers.find((c) => c.id === id)!;
  const names = [...new Set([...s.people.map((p) => p.name), ...s.teams.map((t) => t.name), ...s.projects.map((p) => p.name), ...s.projects.flatMap((p) => (p.renamed ? [p.renamed.to] : []))])];
  const closed = { terms: names, prefixes: [] as string[] };
  const spec = (x: Partial<ListSpec>): ListSpec => ({ match: 'alias', ordered: false, maxItems: 10, requireDocs: false, primary: 'f1', ...x });
  const ev = (docs: string[]) => [...new Set(docs)].map((doc) => ({ doc }));
  const inCorpus = (w: number) => w >= 1 && w <= CORPUS_WEEKS;
  const q = scoped(s);
  const three = threeTeams(s, zh ? '三个组' : 'the three teams');
  const list = (id: string, type: Task['type'], question: string, items: GoldItem[], docs: string[], x: Partial<ListSpec> = {}, primary = false) => {
    if (new Set(docs).size < CORPUS_TASK_MIN_DOCS || !items.length) return;
    out.push({ id, suite: 'usage', type, lang: L, question: q(question), scoring: 'set', items, list: spec({ maxItems: Math.min(60, Math.max(10, items.length + 5)), ...x }), closedWorld: closed, evidence: ev(docs), ...(primary ? { primary } : {}) });
  };
  const count = (id: string, question: string, n: number, docs: string[]) => {
    if (new Set(docs).size < CORPUS_TASK_MIN_DOCS) return;
    out.push({ id, suite: 'usage', type: 'aggregate', lang: L, question: q(question), answer: String(n), scoring: 'count', closedWorld: closed, evidence: ev(docs) });
  };
  const monthName = (m: number) => (zh ? `${m}月` : MONTHS_EN[m]);

  // incidents: every P1 of a team, all incidents escalated by customers, counts
  for (const t of s.teams) {
    const p1 = s.incidents.filter((i) => i.team === t.id && i.sev === 'P1' && inCorpus(i.week + 1));
    list(`r-p1-${t.id}`, 'aggregate', zh ? `${t.name}今年（截至第${CORPUS_WEEKS}周）出过哪些P1事故？列出事故编号和名称。` : `Which P1 incidents did ${t.name} have this year (through week ${CORPUS_WEEKS})? Give each incident's ID and title.`,
      p1.map((i) => ({ label: i.id, aliases: [], weight: 1, docs: [docOf(t.id, i.week)] })), p1.flatMap((i) => [docOf(t.id, i.week), docOf(t.id, i.week + 1)]), {}, t.id === s.teams[0].id && s.division.index === 0);
    const all = s.incidents.filter((i) => i.team === t.id && inCorpus(i.week));
    count(`r-n-inc-${t.id}`, zh ? `截至第${CORPUS_WEEKS}周，${t.name}一共报告了几起事故？` : `How many incidents did ${t.name} report through week ${CORPUS_WEEKS}?`, all.length, all.map((i) => docOf(t.id, i.week)));
  }
  const escalated = s.incidents.filter((i) => i.customer && inCorpus(i.week));
  const escalators = [...new Set(escalated.map((i) => i.customer!))].map(cust);
  list('r-customers', 'aggregate', zh ? '今年有哪些客户升级过事故？' : 'Which customers escalated an incident this year?',
    escalators.map((c) => ({ label: customerName(c, CORPUS_WEEKS), aliases: c.renamed ? [c.name] : [], weight: 1, docs: escalated.filter((i) => i.customer === c.id).map((i) => docOf(i.team, i.week)) })), escalated.map((i) => docOf(i.team, i.week)), {}, true);
  const p1All = s.incidents.filter((i) => i.sev === 'P1' && inCorpus(i.week));
  count('r-n-p1', zh ? `截至第${CORPUS_WEEKS}周，${three}一共出过几起P1事故？` : `How many P1 incidents did ${three} have in all through week ${CORPUS_WEEKS}?`, p1All.length, p1All.map((i) => docOf(i.team, i.week)));

  // people: departures, transfers, hires
  const left = s.people.filter((p) => p.left && inCorpus(p.left));
  const moved = s.people.filter((p) => p.movedTo && inCorpus(p.movedTo.week));
  const hired = s.people.filter((p) => p.joined > 1 && inCorpus(p.joined));
  list('r-left', 'aggregate', zh ? '今年有哪些人离职了？' : 'Who left the company this year?', left.map((p) => ({ label: p.name, aliases: [], weight: 1, docs: [docOf(p.team, p.left!)] })), [...left.map((p) => docOf(p.team, p.left!)), ...left.map((p) => docOf(p.team, p.left! - 1))]);
  list('r-moved', 'aggregate', zh ? '今年有哪些人在组之间调动？分别从哪个组调到哪个组？' : 'Who moved between teams this year, and from which team to which?', moved.map((p) => ({ label: p.name, aliases: [], weight: 1, docs: [docOf(p.team, p.movedTo!.week), docOf(p.movedTo!.team, p.movedTo!.week)] })), moved.flatMap((p) => [docOf(p.team, p.movedTo!.week - 1), docOf(p.team, p.movedTo!.week), docOf(p.movedTo!.team, p.movedTo!.week)]), { requireDocs: false }, true);
  count('r-n-hired', zh ? `截至第${CORPUS_WEEKS}周，${three}一共新招了几个人？` : `How many people did ${three} hire through week ${CORPUS_WEEKS}?`, hired.length, [...hired.map((p) => docOf(p.team, p.joined)), ...s.teams.map((t) => docOf(t.id, CORPUS_WEEKS))]);

  // risks: open at the end, lifecycles, traceback
  const open = s.risks.filter((r) => r.opened <= CORPUS_WEEKS && (!r.closed || r.closed > CORPUS_WEEKS));
  list('r-open-risks', 'aggregate', zh ? `截至第${CORPUS_WEEKS}周，还有哪些风险没有关闭？` : `Which risks are still open as of week ${CORPUS_WEEKS}?`, open.map((r) => ({ label: r.id, aliases: [], weight: 1, docs: [docOf(r.team, r.opened)] })), [...open.map((r) => docOf(r.team, r.opened)), ...s.teams.map((t) => docOf(t.id, CORPUS_WEEKS))], {}, true);
  for (const rk of s.risks.filter((r) => r.closed && r.closed <= CORPUS_WEEKS && r.ownerChange)) {
    const steps: GoldItem[] = [
      { label: zh ? `${rk.raisedBy}提出${rk.id}` : `${rk.raisedBy} raised ${rk.id}`, aliases: [rk.raisedBy], weight: 1, date: iso(dayOf(rk.opened)), docs: [docOf(rk.team, rk.opened)] },
      { label: zh ? `负责人改为${rk.ownerChange!.to}` : `owner changed to ${rk.ownerChange!.to}`, aliases: [rk.ownerChange!.to], weight: 1, date: iso(dayOf(rk.ownerChange!.week)), docs: [docOf(rk.team, rk.ownerChange!.week)] },
      { label: zh ? `关闭：${rk.resolution}` : `closed: ${rk.resolution}`, aliases: [rk.resolution], weight: 1, date: iso(dayOf(rk.closed!)), docs: [docOf(rk.team, rk.closed!)] },
    ];
    const docs = Array.from({ length: rk.closed! - rk.opened + 1 }, (_, i) => docOf(rk.team, rk.opened + i));
    list(`r-risk-${rk.id}`, 'timeline', zh ? `风险${rk.id}从提出到关闭经历了什么？按时间列出每一步（谁、哪一周）。` : `What happened to risk ${rk.id} from first mention to closing? List each step in order (who, which week).`, steps, docs, { ordered: true });
  }
  for (const rk of s.risks.filter((r) => r.closed && r.closed <= CORPUS_WEEKS).slice(0, 6)) {
    out.push({ id: `r-trace-${rk.id}`, suite: 'usage', type: 'temporal', lang: L, question: q(zh ? `风险${rk.id}是哪一周、由谁最早提出的？最后是在哪一周、怎么关闭的？` : `In which week, and by whom, was risk ${rk.id} first raised? When and how was it closed?`),
      answer: zh ? `第${rk.opened}周由${rk.raisedBy}提出；第${rk.closed}周关闭（${rk.resolution}）` : `raised in week ${rk.opened} by ${rk.raisedBy}; closed in week ${rk.closed} (${rk.resolution})`,
      keypoints: [String(rk.opened), rk.raisedBy, String(rk.closed), rk.resolution], scoring: 'judge', evidence: ev([docOf(rk.team, rk.opened), docOf(rk.team, rk.closed!)]), meta: { span: rk.closed! - rk.opened } });
  }

  for (const t of s.teams) {
    const rs = s.risks.filter((r) => r.team === t.id && inCorpus(r.opened));
    list(`r-risks-${t.id}`, 'aggregate', zh ? `${t.name}今年提出过哪些风险？列出编号。` : `Which risks has ${t.name} raised this year? Give their IDs.`, rs.map((r) => ({ label: r.id, aliases: [], weight: 1, docs: [docOf(t.id, r.opened)] })),
      [...rs.map((r) => docOf(t.id, r.opened)), ...rs.map((r) => docOf(t.id, Math.min(CORPUS_WEEKS, r.closed ?? CORPUS_WEEKS)))]);
  }
  const slipped = s.projects.filter((p) => p.planned < Math.min(p.launch, CORPUS_WEEKS + 1) && p.planned <= CORPUS_WEEKS);
  list('r-slipped', 'aggregate', zh ? `截至第${CORPUS_WEEKS}周，哪些项目错过了计划上线周？` : `Which projects had missed their planned launch week by week ${CORPUS_WEEKS}?`,
    slipped.map((p) => ({ label: projectName(p, CORPUS_WEEKS), aliases: p.renamed ? [p.name] : [], weight: 1, docs: [docOf(p.team, Math.min(CORPUS_WEEKS, p.planned + 1))] })),
    [...slipped.map((p) => docOf(p.team, Math.min(CORPUS_WEEKS, p.planned + 1))), ...slipped.map((p) => docOf(p.team, p.planned)), ...s.projects.map((p) => docOf(p.team, Math.min(CORPUS_WEEKS, p.launch)))]);
  for (const p of s.projects) {
    const items: GoldItem[] = [];
    const docs: string[] = [];
    const add = (label: string, week: number, aliases: string[] = []) => {
      if (!inCorpus(week)) return;
      items.push({ label, aliases, weight: 1, docs: [docOf(p.team, week)] });
      docs.push(docOf(p.team, week));
    };
    const start = 2 + 4 * Number(p.id.slice(-1));
    add(zh ? `属于${team(p.team).name}，负责人${p.owner}` : `run by ${team(p.team).name}, owner ${p.owner}`, start + 1, [p.owner]);
    add(zh ? `计划第${p.planned}周上线` : `planned for week ${p.planned}`, start + 1, [String(p.planned)]);
    if (p.renamed) add(zh ? `第${p.renamed.week}周改名为${p.renamed.to}` : `renamed ${p.renamed.to} in week ${p.renamed.week}`, p.renamed.week, [p.renamed.to]);
    if (p.ownerChange) add(zh ? `第${p.ownerChange.week}周由${p.ownerChange.to}接手` : `${p.ownerChange.to} took over in week ${p.ownerChange.week}`, p.ownerChange.week, [p.ownerChange.to]);
    if (p.launch > p.planned) add(zh ? `延期，第${p.planned + 1}周起报告延期` : `slipped, reported late from week ${p.planned + 1}`, p.planned + 1);
    add(zh ? `第${p.launch}周上线` : `launched in week ${p.launch}`, p.launch, [String(p.launch)]);
    for (const w of [start + 8, start + 16]) if (inCorpus(w) && w < p.launch) docs.push(docOf(p.team, w));
    list(`p-proj-${p.id}`, 'profile', zh ? `周报里关于${p.renamed ? `${p.name}（后改名${p.renamed.to}）` : p.name}项目都说了些什么？逐条列出。` : `What do the reports say about the ${p.renamed ? `${p.name} (later ${p.renamed.to})` : p.name} project? List every fact.`, items, docs, { match: 'judge', primary: 'recall' });
  }

  // figures over the year: month-end metric, project progress — month-end is the last report dated in that month
  const monthEnds = monthEndWeeks().map((m) => m.week);
  for (const t of s.teams) {
    const fmtV = (v: number) => (t.metric.unit === '%' ? `${v}%` : zh ? `${v}万` : `${v}k`);
    list(`t-metric-${t.id}`, 'timeline', zh ? `${t.name}的${t.metric.name}每个月最后一周分别是多少？按月列出。` : `What was ${t.name}'s ${t.metric.name} in the last week of each month? List the months in order.`,
      monthEnds.map((w) => ({ label: fmtV(t.metric.values[w - 1]), aliases: [String(t.metric.values[w - 1])], weight: 1, date: iso(dayOf(w)), docs: [docOf(t.id, w)] })), monthEnds.map((w) => docOf(t.id, w)), { ordered: true }, t.def === 1 && s.division.index === 0);
  }
  for (const p of s.projects) {
    const weeks = monthEnds.filter((w) => p.progress[w - 1] > 0 && (w <= p.launch));
    list(`t-prog-${p.id}`, 'timeline', zh ? `${p.renamed ? `${p.name}（后改名${p.renamed.to}）` : p.name}项目每月底的完成度分别是多少？按月列出。` : `What was the ${p.renamed ? `${p.name} (later ${p.renamed.to})` : p.name} project's progress at each month end? List them in order.`,
      weeks.map((w) => ({ label: `${p.progress[w - 1]}%`, aliases: [], weight: 1, date: iso(dayOf(w)), docs: [docOf(p.team, w)] })), weeks.map((w) => docOf(p.team, w)), { ordered: true });
  }

  // contradictions: what the PMO says against what the team says
  const pmoSides: GoldItem[] = [];
  const pmoDocs: string[] = [];
  for (const d of s.pmo) {
    const t = team(d.team);
    if (d.field === 'launch') {
      const p = s.projects.find((x) => x.id === d.ref)!;
      const teamDocs = weeksUpTo(CORPUS_WEEKS).filter((w) => p.progress[w - 1] > 0 && p.progress[w - 1] < 100 && monthOf(w) <= d.month + 1).slice(-5).map((w) => docOf(t.id, w));
      const sides: GoldItem[] = [
        { label: zh ? `第${d.teamSays}周` : `week ${d.teamSays}`, aliases: zh ? [`${d.teamSays}周`] : [`wk ${d.teamSays}`], weight: 1, docs: teamDocs },
        { label: zh ? `第${d.pmoSays}周` : `week ${d.pmoSays}`, aliases: zh ? [`${d.pmoSays}周`] : [`wk ${d.pmoSays}`], weight: 1, docs: [pmoDoc(d.month)] },
      ];
      list(`c-launch-${t.id}`, 'contradiction', zh ? `关于${projectName(p, 1)}计划哪一周上线，各份材料的说法一致吗？哪些材料说法不同，分别怎么说？` : `Do the documents agree on the week ${projectName(p, 1)} is planned to launch? Which disagree, and what does each say?`, sides, [...teamDocs, pmoDoc(d.month)], { requireDocs: true });
      pmoSides.push({ label: zh ? `${projectName(p, 1)}的上线周` : `${projectName(p, 1)}'s launch week`, aliases: [projectName(p, 1)], weight: 1, docs: [pmoDoc(d.month), teamDocs.at(-1)!] });
      pmoDocs.push(pmoDoc(d.month), ...teamDocs);
    } else if (d.field === 'severity') {
      const i = s.incidents.find((x) => x.id === d.ref)!;
      pmoSides.push({ label: zh ? `${i.id}的级别` : `${i.id}'s severity`, aliases: [i.id], weight: 1, docs: [pmoDoc(d.month), docOf(t.id, i.week)] });
      pmoDocs.push(pmoDoc(d.month), docOf(t.id, i.week));
    } else {
      const mover = s.people.find((x) => x.id === d.ref)!;
      pmoSides.push({ label: zh ? `${t.name}的在岗人数` : `${t.name}'s headcount`, aliases: [t.name], weight: 1, docs: [pmoDoc(d.month), docOf(t.id, mover.movedTo!.week)] });
      pmoDocs.push(pmoDoc(d.month), docOf(t.id, mover.movedTo!.week));
    }
  }
  list('c-pmo', 'contradiction', zh ? '项目管理办公室月报和各组周报在哪些数字上说法不一致？逐一列出是哪个数字。' : 'On which figures do the PMO summaries and the team reports disagree? List each figure.', pmoSides, pmoDocs, { match: 'judge' }, true);

  // profiles: the people with a year's worth of history (namesakes have their own tasks)
  const history = (p: RPerson) => (p.movedTo ? 2 : 0) + s.projects.filter((x) => x.owner === p.name || x.ownerChange?.to === p.name).length * 2 + s.incidents.filter((i) => i.fixer === p.name).length
    + s.risks.filter((r) => r.raisedBy === p.name || r.owner === p.name || r.ownerChange?.to === p.name).length;
  const rich = s.people.filter((p) => !s.twins.includes(p.name) && history(p) >= 3).sort((a, b) => history(b) - history(a) || a.id.localeCompare(b.id)).slice(0, 10);
  for (const p of rich) {
    const items: GoldItem[] = [];
    const docs: string[] = [];
    const add = (label: string, doc: string, aliases: string[] = []) => {
      items.push({ label, aliases, weight: 1, docs: [doc] });
      docs.push(doc);
    };
    if (p.movedTo && inCorpus(p.movedTo.week)) add(zh ? `第${p.movedTo.week}周从${team(p.team).name}调到${team(p.movedTo.team).name}` : `moved from ${team(p.team).name} to ${team(p.movedTo.team).name} in week ${p.movedTo.week}`, docOf(p.team, p.movedTo.week), [team(p.movedTo.team).name]);
    for (const i of s.incidents.filter((x) => x.fixer === p.name && inCorpus(x.week + 1) && (x.team === p.team || x.team === p.movedTo?.team))) {
      add(zh ? `修复了${i.id}（${i.title}）` : `fixed ${i.id} (${i.title})`, docOf(i.team, i.week + 1), [i.id]);
      docs.push(docOf(i.team, i.week));
    }
    for (const r of s.risks.filter((x) => x.raisedBy === p.name && inCorpus(x.opened))) add(zh ? `提出了风险${r.id}` : `raised risk ${r.id}`, docOf(r.team, r.opened), [r.id]);
    for (const r of s.risks.filter((x) => (x.owner === p.name || x.ownerChange?.to === p.name) && inCorpus(x.opened))) add(zh ? `负责风险${r.id}` : `owned risk ${r.id}`, docOf(r.team, r.ownerChange?.to === p.name ? r.ownerChange.week : r.opened), [r.id]);
    for (const x of s.projects.filter((y) => (y.owner === p.name || y.ownerChange?.to === p.name))) {
      const w = x.ownerChange?.to === p.name ? x.ownerChange.week : 2 + 4 * Number(x.id.slice(-1));
      if (inCorpus(w)) add(zh ? `负责${projectName(x, w)}项目` : `owns the ${projectName(x, w)} project`, docOf(x.team, w), [projectName(x, w)]);
    }
    list(`p-${p.id}`, 'profile', zh ? `这些周报里关于${p.name}都说了些什么？逐条列出。` : `What do these reports say about ${p.name}? List every fact.`, items.slice(0, 20), docs, { match: 'judge', primary: 'recall' });
  }

  // five hops: customer → incident → fixer → their move → the project they took over → its launch
  for (const c of s.chains) {
    const i = s.incidents.find((x) => x.id === c.incident)!;
    const mover = s.people.find((x) => x.id === c.person)!;
    const p = s.projects.find((x) => x.id === c.project)!;
    const docs = [docOf(i.team, i.week), docOf(i.team, i.week + 1), docOf(mover.movedTo!.team, mover.movedTo!.week), docOf(p.team, p.ownerChange!.week), docOf(p.team, Math.min(p.launch, CORPUS_WEEKS))];
    if (new Set(docs).size < 5 || p.launch > CORPUS_WEEKS) continue;
    const cn = customerName(cust(i.customer!), i.week);
    out.push({ id: `h5-${i.id}`, suite: 'usage', type: 'deep-hop', lang: L,
      question: q(zh ? `${monthName(monthOf(i.week))}${cn}升级的那起P1事故，修复它的工程师后来调到了另一个组，并在那里接手了一个项目。那个项目最终是在第几周上线的？` : `The P1 incident ${cn} escalated in ${monthName(monthOf(i.week))} was fixed by an engineer who later moved to another team and took over a project there. In which week did that project finally launch?`),
      answer: zh ? `第${p.launch}周（${projectName(p, p.launch)}）` : `week ${p.launch} (${projectName(p, p.launch)})`, keypoints: [String(p.launch)], scoring: 'judge', evidence: ev(docs), primary: true,
      meta: { hops: 5, stratum: 'h5', bridges: [i.id, mover.name, team(mover.movedTo!.team).name, projectName(p, p.ownerChange!.week)] } });
  }
  // four hops: risk → who raised it → they left → who owns the risk after → that person's project
  for (const rk of s.risks.filter((r) => r.ownerChange && inCorpus(r.ownerChange.week))) {
    const owner = rk.ownerChange!.to;
    const p = s.projects.find((x) => x.owner === owner && x.team === rk.team) ?? s.projects.find((x) => x.ownerChange?.to === owner);
    if (!p) continue;
    const pw = Math.min(Math.max(rk.ownerChange!.week + 3, 2), CORPUS_WEEKS);
    const docs = [docOf(rk.team, rk.opened), docOf(rk.team, rk.ownerChange!.week), docOf(p.team, pw), docOf(p.team, Math.min(CORPUS_WEEKS, p.launch))];
    if (new Set(docs).size < 4) continue;
    const status = p.launch <= CORPUS_WEEKS ? (zh ? `第${p.launch}周上线` : `launched in week ${p.launch}`) : (zh ? `到第${CORPUS_WEEKS}周完成度${p.progress[CORPUS_WEEKS - 1]}%` : `${p.progress[CORPUS_WEEKS - 1]}% done by week ${CORPUS_WEEKS}`);
    out.push({ id: `h4-${rk.id}`, suite: 'usage', type: 'deep-hop', lang: L,
      question: q(zh ? `风险${rk.id}后来换了负责人。新负责人自己负责的是哪个项目？那个项目到第${CORPUS_WEEKS}周为止情况如何？` : `Risk ${rk.id} later changed owner. Which project does the new owner run, and where did it stand by week ${CORPUS_WEEKS}?`),
      answer: `${projectName(p, CORPUS_WEEKS)}：${status}`, keypoints: [projectName(p, CORPUS_WEEKS), status], scoring: 'judge', evidence: ev(docs), meta: { hops: 4, stratum: 'h4', bridges: [owner] } });
  }
  // five hops the other way: a risk → who raised it → the escalated P1 they fixed → the same customer's incident in another team → who fixed that
  for (const rk of s.risks.filter((r) => inCorpus(r.opened))) {
    const fixed = s.incidents.find((i) => i.fixer === rk.raisedBy && i.customer && inCorpus(i.week + 1) && i.team === rk.team);
    const other = fixed && s.incidents.find((i) => i.customer === fixed.customer && i.team !== fixed.team && inCorpus(i.week + 1));
    if (!fixed || !other || other.fixer === rk.raisedBy) continue;
    const docs = [docOf(rk.team, rk.opened), docOf(fixed.team, fixed.week + 1), docOf(fixed.team, fixed.week), docOf(other.team, other.week), docOf(other.team, other.week + 1)];
    if (new Set(docs).size < 5 || out.some((t) => t.id === `h5r-${fixed.customer}`)) continue;
    out.push({ id: `h5r-${fixed.customer}`, suite: 'usage', type: 'deep-hop', lang: L,
      question: q(zh ? `提出风险${rk.id}的人修复过一起由客户升级的事故。同一个客户还在另一个组升级过事故——那一起是谁修复的？` : `Whoever raised risk ${rk.id} fixed an incident a customer had escalated. The same customer escalated an incident in another team as well: who fixed that one?`),
      answer: zh ? `${other.fixer}（${team(other.team).name}，${other.id}）` : `${other.fixer} (${team(other.team).name}, ${other.id})`, keypoints: [other.fixer], scoring: 'judge', evidence: ev(docs), primary: true,
      meta: { hops: 5, stratum: 'h5r', bridges: [rk.raisedBy, fixed.id, fixed.customer!, other.id] } });
  }

  // ambiguity: people with one name; a renamed project; a metric whose definition changed
  const firstMention = (p: RPerson) => weeksUpTo(CORPUS_WEEKS).map((w) => docOf(p.team, w)).find((d) => textOf(d).includes(p.name));
  s.twins.forEach((twin, n) => {
    const pair = s.people.filter((p) => p.name === twin);
    if (pair.length !== 2 || !pair.every(firstMention)) return;
    const suffix = n === 0 ? '' : `-${n + 1}`;
    out.push({ id: `a-twins${suffix}`, suite: 'usage', type: 'ambiguous', lang: L, question: q(zh ? `${twin}在哪个组？` : `Which team is ${twin} on?`), scoring: 'set',
      items: pair.map((p) => ({ label: team(p.team).name, aliases: [], weight: 1, docs: [firstMention(p)!] })), list: spec({ maxItems: 5 }), evidence: ev(pair.map((p) => firstMention(p)!)), meta: { readings: 2 }, ...(n === 0 ? { primary: true } : {}) });
    if (n > 0) return;
    for (const p of pair) {
      const fixed = s.incidents.filter((i) => i.fixer === p.name && i.team === p.team && inCorpus(i.week + 1));
      if (!fixed.length) continue;
      out.push({ id: `a-twin-${p.team}`, suite: 'usage', type: 'ambiguous', lang: L, question: q(zh ? `${team(p.team).name}的${p.name}今年修复过哪些事故？` : `Which incidents did ${p.name} of ${team(p.team).name} fix this year?`), scoring: 'set',
        items: fixed.map((i) => ({ label: i.id, aliases: [], weight: 1, docs: [docOf(i.team, i.week + 1)] })), list: spec({}), evidence: ev(fixed.map((i) => docOf(i.team, i.week + 1))), meta: { twin: true } });
    }
  });
  const renamed = s.projects.find((p) => p.renamed);
  if (renamed && renamed.launch <= CORPUS_WEEKS) {
    out.push({ id: 'a-renamed', suite: 'usage', type: 'ambiguous', lang: L, question: q(zh ? `${renamed.name}项目最后上线了吗？哪一周？` : `Did the ${renamed.name} project ever launch? In which week?`),
      answer: zh ? `上线了：第${renamed.launch}周，那时已改名为${renamed.renamed!.to}（第${renamed.renamed!.week}周改名）` : `yes, in week ${renamed.launch}, by then renamed ${renamed.renamed!.to} (renamed in week ${renamed.renamed!.week})`,
      keypoints: [String(renamed.launch), renamed.renamed!.to], scoring: 'judge', evidence: ev([docOf(renamed.team, renamed.renamed!.week), docOf(renamed.team, renamed.launch)]), meta: { hops: 2 } });
  }
  const growth = s.teams.find((t) => t.metric.redefined);
  if (growth) {
    const w = growth.metric.redefined!.week;
    const fmtV = (v: number) => (zh ? `${v}万` : `${v}k`);
    out.push({ id: 'a-redefined', suite: 'usage', type: 'ambiguous', lang: L,
      question: q(zh ? `${growth.name}的${growth.metric.name}从第1周到第${CORPUS_WEEKS}周增长了多少？` : `How much did ${growth.name}'s ${growth.metric.name} grow from week 1 to week ${CORPUS_WEEKS}?`),
      answer: zh ? `不能直接相减：第${w}周口径调整（剔除测试和机器人账号）。旧口径从${fmtV(growth.metric.values[0])}到第${w - 1}周${fmtV(growth.metric.values[w - 2])}，新口径从第${w}周${fmtV(growth.metric.values[w - 1])}到第${CORPUS_WEEKS}周${fmtV(growth.metric.values[CORPUS_WEEKS - 1])}`
        : `not directly: the definition changed in week ${w} (test and bot accounts excluded). Old basis ${fmtV(growth.metric.values[0])} to ${fmtV(growth.metric.values[w - 2])} in week ${w - 1}; new basis ${fmtV(growth.metric.values[w - 1])} in week ${w} to ${fmtV(growth.metric.values[CORPUS_WEEKS - 1])} in week ${CORPUS_WEEKS}`,
      keypoints: [zh ? '口径调整' : 'definition changed', String(w)], scoring: 'judge', evidence: ev([docOf(growth.id, 1), docOf(growth.id, w - 1), docOf(growth.id, w), docOf(growth.id, CORPUS_WEEKS)]) });
  }

  // emergence: each team's state per quarter (never named), the signs, each lead's style
  for (const t of s.teams) {
    t.health.slice(0, 3).forEach((h, qi) => {
      const weeks = Array.from({ length: 13 }, (_, i) => qi * 13 + i + 1).filter(inCorpus);
      out.push({ id: `e-health-${t.id}-q${qi + 1}`, suite: 'emergence', type: 'affect', lang: L,
        question: q(zh ? `综合第${qi + 1}季度的周报，${t.name}那段时间的整体状态更接近哪一种？` : `Taking the reports of quarter ${qi + 1} together, which best describes the state ${t.name} was in?`),
        choices: HEALTH[L], answer: h, scoring: 'choice', evidence: ev(weeks.slice(0, 6).map((w) => docOf(t.id, w))), primary: qi === 2 });
    });
    const authors = [t.lead, ...(t.leadChange ? [t.leadChange.to] : [])];
    for (const a of authors) {
      const style = s.styles[a];
      const weeks = weeksUpTo(CORPUS_WEEKS).filter((w) => leadOf(t, w) === a);
      out.push({ id: `e-style-${t.id}-${style}`, suite: 'emergence', type: 'style', lang: L,
        question: q(zh ? `${a}写周报有什么风格特点？` : `What is characteristic of how ${a} writes the weekly reports?`), scoring: 'set', items: STYLE_ITEMS[L][style],
        evidence: ev(weeks.slice(0, 5).map((w) => docOf(t.id, w))), meta: { minEvidence: 1 } });
    }
  }
  // which projects will slip past their planned week after the corpus ends (the holdout decides)
  const late = s.projects.filter((p) => p.launch > CORPUS_WEEKS && p.launch > p.planned);
  if (late.length) {
    out.push({ id: 'e-slip', suite: 'emergence', type: 'forecast', lang: L,
      question: q(zh ? `根据到第${CORPUS_WEEKS}周为止的周报，哪些项目最可能赶不上原定的上线周？` : `From the reports through week ${CORPUS_WEEKS}, which projects are most likely to miss their planned launch week?`),
      scoring: 'set', items: late.map((p) => ({ label: projectName(p, CORPUS_WEEKS), aliases: p.renamed ? [p.name] : [], weight: 1 })), evidence: [], meta: { minEvidence: 1, match: 'terms' } });
  }
  return out;
}

/**
 * Questions of a division say which one when the company has more than one: by the team they name ("二部平台组"
 * is of the second division), else by the division's `scope` in front. `alt`: a question in the other language.
 */
function scoped(s: ReportScript, alt = false): (question: string) => string {
  const scope = alt ? s.division.altScope : s.division.scope;
  if (!scope) return (x) => x;
  const names = s.teams.map((t) => (alt ? t.alt : t.name));
  const zh = (s.lang === 'zh') !== alt;
  return (x) => (x.includes(scope) || names.some((n) => x.includes(n)) ? x : zh ? `（${scope}）${x}` : `(${scope}) ${x}`);
}

/** "The three teams" of a division, said so that it names the division: `bare` when the company is one division. */
function threeTeams(s: ReportScript, bare: string): string {
  const { scope } = s.division;
  if (!scope) return bare;
  if (s.lang === 'zh') return `${scope}的三个组`;
  return `the three teams ${scope}`;
}

/* --------------------------- the separation families --------------------------- */

/**
 * The tasks of docs/design/28 for one division: stale traps, look-alikes and
 * renames, structured queries, non-lexical hops, planted connections, and
 * paraphrased and cross-lingual copies of existing questions. `base` holds
 * the division's other tasks (the ones paraphrased).
 */
export function separationTasks(s: ReportScript, docOf: (team: string, week: number) => string, base: Draft[]): Draft[] {
  const zh = s.lang === 'zh';
  const L = s.lang;
  const other: Lang = zh ? 'en' : 'zh';
  const out: Draft[] = [];
  const q = scoped(s);
  const ev = (docs: string[]) => [...new Set(docs)].map((doc) => ({ doc }));
  const inCorpus = (w: number) => w >= 1 && w <= CORPUS_WEEKS;
  const team = (id: string) => s.teams.find((t) => t.id === id)!;
  const cust = (id: string) => s.customers.find((c) => c.id === id)!;
  const dateZh = (w: number, d = 1) => {
    const x = dayOf(w, d);
    return `${x.getUTCFullYear()}年${x.getUTCMonth() + 1}月${x.getUTCDate()}日`;
  };
  const dateEn = (w: number, d = 1) => {
    const x = dayOf(w, d);
    return `${MONTHS_EN[x.getUTCMonth() + 1]} ${x.getUTCDate()}, ${x.getUTCFullYear()}`;
  };
  const date = (w: number, d = 1) => (zh ? dateZh(w, d) : dateEn(w, d));
  const lineOf = (teamId: string, week: number, key: string) => {
    const f = facts(s, team(teamId), week);
    return SECTIONS.flatMap((k) => f[k]).filter((l) => l.key === key || l.key.startsWith(`${key}:`)).map((l) => l.text);
  };
  const scope = threeTeams(s, zh ? '这三个组' : 'the three teams');
  const idSpec = (n: number): ListSpec => ({ match: 'alias', ordered: false, maxItems: Math.min(60, Math.max(10, n + 5)), requireDocs: false, primary: 'f1' });

  /* a. stale traps: the setting's name only ever carries its first value */
  for (const x of s.tracked) {
    const t = team(x.team);
    const val = (v: number) => `${v}${x.unit}`;
    const values = [...new Set(x.history.map((h) => h.value))];
    const changeDocs = x.history.filter((h) => inCorpus(h.week)).map((h) => docOf(x.team, h.week));
    const now = trackedValue(x, CORPUS_WEEKS)!;
    const last = x.history.filter((h) => inCorpus(h.week)).at(-1)!;
    const stale = values.filter((v) => v !== now).map(String);
    if (stale.length) {
      out.push({ id: `st-${x.id}-now`, suite: 'usage', type: 'stale', lang: L, scoring: 'value',
        question: q(zh ? `截至${dateZh(CORPUS_WEEKS, 4)}，${t.name}的${x.name}是多少？` : `As of ${dateEn(CORPUS_WEEKS, 4)}, what is ${t.name}'s ${x.name}?`),
        answer: String(now), answers: [val(now)], evidence: ev(changeDocs), meta: { family: 'stale', stale, staleText: stale.map((v) => val(Number(v))), item: x.id, via: last.via, how: last.how } });
    }
    // as of a week strictly between two changes (never a correction: what was true then is not what was said then)
    const changes = x.history.filter((h) => h.how !== 'intro');
    for (let i = 0; i + 1 < changes.length; i++) {
      const [a, b] = [changes[i], changes[i + 1]];
      if (a.how === 'correction' || b.week - a.week < 4) continue;
      const w = a.week + Math.floor((b.week - a.week) / 2);
      const then = trackedValue(x, w)!;
      const staleThen = values.filter((v) => v !== then).map(String);
      out.push({ id: `st-${x.id}-asof`, suite: 'usage', type: 'stale', lang: L, scoring: 'value', asOf: iso(dayOf(w, 2)),
        question: q(zh ? `${dateZh(w, 2)}那天，${t.name}的${x.name}是多少？` : `On ${dateEn(w, 2)}, what was ${t.name}'s ${x.name}?`),
        answer: String(then), answers: [val(then)], evidence: ev(x.history.filter((h) => h.week <= w).map((h) => docOf(x.team, h.week))), meta: { family: 'stale', stale: staleThen, staleText: staleThen.map((v) => val(Number(v))), item: x.id, asOfWeek: w } });
      break;
    }
  }

  /* b. look-alikes and renames */
  // namesakes: the question names the person by team; the other one's record is the distractor
  for (const twin of s.twins) {
    const pair = s.people.filter((p) => p.name === twin);
    if (pair.length !== 2) continue;
    for (const p of pair) {
      const otherOne = pair.find((x) => x !== p)!;
      const raised = (who: RPerson) => s.risks.filter((r) => r.raisedBy === who.name && r.team === who.team && inCorpus(r.opened));
      const fixed = (who: RPerson) => s.incidents.filter((i) => i.fixer === who.name && i.team === who.team && inCorpus(i.week + 1));
      const mine = [...fixed(p).map((i) => ({ id: i.id, doc: docOf(i.team, i.week + 1) })), ...raised(p).map((r) => ({ id: r.id, doc: docOf(r.team, r.opened) }))];
      const theirs = [...fixed(otherOne).map((i) => i.id), ...raised(otherOne).map((r) => r.id)];
      if (!mine.length || !theirs.length) continue;
      out.push({ id: `la-twin-${p.id}`, suite: 'usage', type: 'lookalike', lang: L, scoring: 'set', list: idSpec(mine.length),
        question: q(zh ? `${team(p.team).name}的那位${p.name}（不是另一个组的同名同事）今年修复过哪些事故、提出过哪些风险？列出编号。` : `Which incidents did ${p.name} of ${team(p.team).name} (not the colleague of the same name elsewhere) fix this year, and which risks did they raise? Give the IDs.`),
        items: mine.map((m) => ({ label: m.id, aliases: [], weight: 1, docs: [m.doc] })), evidence: ev(mine.map((m) => m.doc)), meta: { family: 'lookalike', subtype: 'namesake', distractors: theirs } });
    }
  }
  // near-identical customers: the look-alike's escalations are the distractors
  for (const c of s.customers.filter((x) => s.customers.some((y) => y.lookalikeOf === x.id) || x.lookalikeOf)) {
    const twin = s.customers.find((y) => y.lookalikeOf === c.id || y.id === c.lookalikeOf)!;
    const mine = s.incidents.filter((i) => i.customer === c.id && inCorpus(i.week));
    const theirs = s.incidents.filter((i) => i.customer === twin.id && inCorpus(i.week));
    if (!mine.length || !theirs.length) continue;
    out.push({ id: `la-cust-${c.id}`, suite: 'usage', type: 'lookalike', lang: L, scoring: 'set', list: idSpec(mine.length),
      question: q(zh ? `客户${c.name}今年升级过哪些事故？列出事故编号。` : `Which incidents did ${c.name} escalate this year? Give the incident IDs.`),
      items: mine.map((i) => ({ label: i.id, aliases: [], weight: 1, docs: [docOf(i.team, i.week)] })), evidence: ev(mine.map((i) => docOf(i.team, i.week))), meta: { family: 'lookalike', subtype: 'near-name', distractors: theirs.map((i) => i.id), lookalike: twin.name } });
  }
  // a renamed customer asked by its old name: escalations after the rename count
  for (const c of s.customers.filter((x) => x.renamed)) {
    const mine = s.incidents.filter((i) => i.customer === c.id && inCorpus(i.week));
    if (!mine.some((i) => i.week >= c.renamed!.week) || !mine.some((i) => i.week < c.renamed!.week)) continue;
    out.push({ id: `la-renamed-${c.id}`, suite: 'usage', type: 'lookalike', lang: L, scoring: 'set', list: idSpec(mine.length),
      question: q(zh ? `客户${c.name}今年一共升级过哪些事故？列出事故编号。` : `Which incidents has ${c.name} escalated this year in all? Give the incident IDs.`),
      items: mine.map((i) => ({ label: i.id, aliases: [], weight: 1, docs: [docOf(i.team, i.week)] })), evidence: ev(mine.map((i) => docOf(i.team, i.week))), meta: { family: 'lookalike', subtype: 'rename', newName: c.renamed!.to, renamedWeek: c.renamed!.week } });
  }
  // renamed projects asked by their old name, about a state reported only under the new one
  for (const p of s.projects.filter((x) => x.renamed && x.renamed.week + 4 <= CORPUS_WEEKS)) {
    const w = Math.min(CORPUS_WEEKS, p.launch <= CORPUS_WEEKS ? p.launch : CORPUS_WEEKS);
    const before = p.progress[p.renamed!.week - 2];
    if (p.launch <= CORPUS_WEEKS) {
      out.push({ id: `la-rename-${p.id}`, suite: 'usage', type: 'lookalike', lang: L, scoring: 'value',
        question: q(zh ? `${p.name}项目是在第几周上线的？` : `In which week did the ${p.name} project launch?`), answer: String(p.launch), answers: [zh ? `第${p.launch}周` : `week ${p.launch}`],
        evidence: ev([docOf(p.team, p.renamed!.week), docOf(p.team, w)]), meta: { family: 'lookalike', subtype: 'rename', newName: p.renamed!.to, stale: [String(p.planned)].filter((v) => v !== String(p.launch)) } });
    } else {
      const now = p.progress[CORPUS_WEEKS - 1];
      out.push({ id: `la-rename-${p.id}`, suite: 'usage', type: 'lookalike', lang: L, scoring: 'value',
        question: q(zh ? `截至第${CORPUS_WEEKS}周，${p.name}项目的完成度是多少？` : `How far along was the ${p.name} project by week ${CORPUS_WEEKS}?`), answer: `${now}%`, answers: [String(now)],
        evidence: ev([docOf(p.team, p.renamed!.week), docOf(p.team, CORPUS_WEEKS)]), meta: { family: 'lookalike', subtype: 'rename', newName: p.renamed!.to, stale: before !== now ? [`${before}%`] : [] } });
    }
  }
  // near-identical projects: the question names one, the other's figures are the distractors
  for (const p of s.projects.filter((x) => x.lookalikeOf)) {
    const twin = s.projects.find((x) => x.id === p.lookalikeOf)!;
    for (const [a, b] of [[p, twin], [twin, p]] as const) {
      if (a.planned === b.planned) continue;
      out.push({ id: `la-proj-${a.id}`, suite: 'usage', type: 'lookalike', lang: L, scoring: 'value',
        question: q(zh ? `${a.name}项目原计划第几周上线？` : `In which week was the ${a.name} project planned to launch?`), answer: String(a.planned), answers: [zh ? `第${a.planned}周` : `week ${a.planned}`],
        evidence: ev([docOf(a.team, 2 + 4 * Number(a.id.slice(-1)) + 1)]), meta: { family: 'lookalike', subtype: 'near-name', lookalike: b.name, stale: [String(b.planned)] } });
    }
  }

  /* c. structured queries: filter, group, count — the whole set over more than 20 reports */
  const structured = (id: string, question: string, items: GoldItem[], docs: string[], extra: Record<string, unknown> = {}) => {
    if (new Set(docs).size < STRUCTURED_MIN_DOCS || !items.length || items.length > 55) return;
    out.push({ id, suite: 'usage', type: 'structured', lang: L, question: q(question), scoring: 'set', items, list: exactSetSpec(items.length), evidence: ev(docs), meta: { family: 'structured', ...extra } });
  };
  const incs = s.incidents.filter((i) => inCorpus(i.week));
  const byTQ = new Map<string, RIncident[]>();
  for (const i of incs) (byTQ.get(`${i.team}|${quarterOf(i.week)}`) ?? byTQ.set(`${i.team}|${quarterOf(i.week)}`, []).get(`${i.team}|${quarterOf(i.week)}`)!).push(i);
  structured('sq-inc-team-quarter', zh ? `按组和季度统计：${scope}在每个季度各报告了几起事故（截至第${CORPUS_WEEKS}周）？只列事故数不为零的组和季度。` : `By team and quarter: how many incidents did each of ${scope} report in each quarter (through week ${CORPUS_WEEKS})? List only the team-quarters with at least one.`,
    [...byTQ].map(([k, is]) => {
      const [tid, qq] = k.split('|');
      return { label: zh ? `${team(tid).name} Q${qq}：${is.length}起` : `${team(tid).name} Q${qq}: ${is.length}`, aliases: [], weight: 1, docs: is.map((i) => docOf(i.team, i.week)), fields: [[team(tid).name], quarterForms(L, Number(qq)), [String(is.length)]] };
    }), incs.map((i) => docOf(i.team, i.week)), { groupBy: ['team', 'quarter'] });
  const fixedOnes = s.incidents.filter((i) => inCorpus(i.week + 1));
  const byFixer = new Map<string, RIncident[]>();
  for (const i of fixedOnes) {
    const who = s.people.find((p) => p.name === i.fixer && (p.team === i.team || p.movedTo?.team === i.team))!;
    (byFixer.get(who.id) ?? byFixer.set(who.id, []).get(who.id)!).push(i);
  }
  const busy = [...byFixer].filter(([, is]) => is.length >= 2);
  structured('sq-fixers', zh ? `${scope}里，今年（截至第${CORPUS_WEEKS}周）修复过两起及以上事故的有哪些人？各修复了几起？同名的人请注明组。` : `Among ${scope}, who fixed two or more incidents this year (through week ${CORPUS_WEEKS}), and how many each? Name the team for people who share a name.`,
    busy.map(([pid, is]) => {
      const p = s.people.find((x) => x.id === pid)!;
      const twin = s.twins.includes(p.name);
      return { label: zh ? `${p.name}${twin ? `（${team(p.team).name}）` : ''}：${is.length}起` : `${p.name}${twin ? ` (${team(p.team).name})` : ''}: ${is.length}`, aliases: [], weight: 1, docs: is.map((i) => docOf(i.team, i.week + 1)), fields: [[p.name], [String(is.length)], ...(twin ? [[team(p.team).name]] : [])] };
    }), fixedOnes.map((i) => docOf(i.team, i.week + 1)), { filter: 'fixed >= 2' });
  for (const t of s.teams) {
    const weeks = weeksUpTo(CORPUS_WEEKS);
    const fmtV = (v: number) => (t.metric.unit === '%' ? `${v}%` : zh ? `${v}万` : `${v}k`);
    const all = weeks.map((w) => docOf(t.id, w));
    // the weeks below a threshold that 15–25% of weeks fall under
    const sorted = weeks.map((w) => t.metric.values[w - 1]).sort((a, b) => a - b);
    const threshold = sorted[Math.floor(sorted.length * 0.2)];
    const low = weeks.filter((w) => t.metric.values[w - 1] < threshold);
    structured(`sq-low-${t.id}`, zh ? `${t.name}的${t.metric.name}在哪些周低于${fmtV(threshold)}（截至第${CORPUS_WEEKS}周）？列出每一周和当周数值。` : `In which weeks (through week ${CORPUS_WEEKS}) was ${t.name}'s ${t.metric.name} below ${fmtV(threshold)}? List each week with its value.`,
      low.map((w) => ({ label: zh ? `第${w}周：${fmtV(t.metric.values[w - 1])}` : `week ${w}: ${fmtV(t.metric.values[w - 1])}`, aliases: [], weight: 1, date: iso(dayOf(w)), docs: [docOf(t.id, w)], fields: [[`第${w}周`, `week ${w}`, `W${w}`, iso(dayOf(w))], [String(t.metric.values[w - 1])]] })), all, { filter: `< ${threshold}` });
    const quarters = [...new Set(weeks.map(quarterOf))];
    structured(`sq-qmax-${t.id}`, zh ? `${t.name}的${t.metric.name}每个季度的最高周值分别是多少（截至第${CORPUS_WEEKS}周）？` : `What was the highest weekly ${t.metric.name} of ${t.name} in each quarter (through week ${CORPUS_WEEKS})?`,
      quarters.map((qq) => {
        const v = Math.max(...weeks.filter((w) => quarterOf(w) === qq).map((w) => t.metric.values[w - 1]));
        return { label: `Q${qq}: ${fmtV(v)}`, aliases: [], weight: 1, docs: weeks.filter((w) => quarterOf(w) === qq && t.metric.values[w - 1] === v).map((w) => docOf(t.id, w)), fields: [quarterForms(L, qq), [String(v)]] };
      }), all, { groupBy: ['quarter'], aggregate: 'max' });
    const h1 = weeks.filter((w) => monthOf(w) <= 6);
    const digits = t.metric.unit === '%' ? (t.metric.values[0] > 99 ? 3 : 2) : 0;
    const avg = h1.reduce((sum, w) => sum + t.metric.values[w - 1], 0) / h1.length;
    if (h1.length >= STRUCTURED_MIN_DOCS) {
      out.push({ id: `sq-h1avg-${t.id}`, suite: 'usage', type: 'structured', lang: L, scoring: 'value',
        question: q(zh ? `${t.name}上半年（周报日期在1月到6月的各周）${t.metric.name}的周均值是多少？保留${digits}位小数。` : `What was ${t.name}'s average weekly ${t.metric.name} over the first half of the year (reports dated January to June)? Round to ${digits} decimals.`),
        answer: avg.toFixed(digits), evidence: ev(h1.map((w) => docOf(t.id, w))), meta: { family: 'structured', aggregate: 'mean', tolerance: 1.01 * 10 ** -digits, weeks: h1.length } });
    }
  }

  /* d. non-lexical hops: the team by what it does, the incident by its rank, the bridges in other words */
  const ord = (n: number) => (zh ? cnNum(n) : enOrdinal(n));
  for (const t of s.teams) {
    const desc = TEAM_DEFS[L][t.def].desc;
    const p1s = s.incidents.filter((i) => i.team === t.id && i.sev === 'P1' && inCorpus(i.week + 1)).sort((a, b) => a.week - b.week);
    p1s.forEach((i, n) => {
      const fixer = s.people.find((p) => p.name === i.fixer && (p.team === t.id || p.movedTo?.team === t.id))!;
      // the team by what it does, among the division's: its scope names the division, never the team
      const within = !s.division.scope ? '' : zh ? s.division.scope : ` among ${s.division.scope}`;
      const anchor = zh ? `${within}${desc}今年第${ord(n + 1)}起最严重一档的故障` : `the ${ord(n + 1)} top-severity outage of the year in ${desc}${within}`;
      const base = [docOf(t.id, i.week), docOf(t.id, i.week + 1)];
      const baseLines = [...lineOf(t.id, i.week, `inc:${i.id}`), ...lineOf(t.id, i.week + 1, `fix:${i.id}`)];
      const push = (kind: string, question: string, answer: string, answers: string[], docs: string[], lines: string[], hops: number, bridges: string[], scoring: Task['scoring']) => {
        const overlap = lexicalOverlap(L, question, lines, [s.division.scope, ...s.teams.map((x) => x.name)]);
        if (overlap.length || new Set(docs).size < 3 || bridges.some((b) => question.includes(b))) return;
        out.push({ id: `nh-${kind}-${i.id}`, suite: 'usage', type: 'nonlexical-hop', lang: L, question, answer, ...(answers.length ? { answers } : {}), scoring, evidence: ev(docs), meta: { family: 'nonlexical-hop', hops, bridges, overlap } });
      };
      // the hazard the fixer once flagged, and who minds it now
      const rk = s.risks.find((r) => r.raisedBy === fixer.name && r.team === fixer.team && inCorpus(r.opened));
      if (rk) {
        const ownerNow = rk.ownerChange && rk.ownerChange.week <= CORPUS_WEEKS ? rk.ownerChange.to : rk.owner;
        const docs = [...base, docOf(rk.team, rk.opened), ...(rk.ownerChange && inCorpus(rk.ownerChange.week) ? [docOf(rk.team, rk.ownerChange.week)] : [])];
        const lines = [...baseLines, ...lineOf(rk.team, rk.opened, `risk:${rk.id}`), ...(rk.ownerChange && inCorpus(rk.ownerChange.week) ? lineOf(rk.team, rk.ownerChange.week, `risk:${rk.id}`) : [])];
        const question = zh ? `${anchor}，是谁处理好的？此人曾预警过一个隐患，眼下是谁在盯着那个隐患？` : `Who sorted out ${anchor}? That person once flagged a hazard: who is minding that hazard now?`;
        push('risk', question, ownerNow, [], docs, lines, 4, [i.id, fixer.name, rk.id], 'value');
      }
      // the project the fixer runs, and the week it went live
      const proj = s.projects.find((p) => (p.ownerChange?.to === fixer.name || (p.owner === fixer.name && p.team === fixer.team && !p.ownerChange)) && p.launch <= CORPUS_WEEKS);
      if (proj) {
        const ownWeek = proj.ownerChange?.to === fixer.name ? proj.ownerChange.week : 2 + 4 * Number(proj.id.slice(-1)) + 1;
        const docs = [...base, docOf(proj.team, ownWeek), docOf(proj.team, proj.launch)];
        const lines = [...baseLines, ...lineOf(proj.team, ownWeek, `prog:${proj.id}`), ...lineOf(proj.team, proj.launch, `prog:${proj.id}`)];
        const question = zh ? `${anchor}，是谁处理好的？此人名下的那个项目是在哪一周投产的？` : `Who sorted out ${anchor}? In which week did the project that person runs go live?`;
        push('proj', question, String(proj.launch), [zh ? `第${proj.launch}周` : `week ${proj.launch}`], docs, lines, 3, [i.id, fixer.name, projectName(proj, proj.launch)], 'value');
      }
    });
  }

  /* e. emergence: incidents and risks that are the same problem, said in words that share nothing */
  const postmortem = (i: RIncident) => docOf(i.team, i.week + 1);
  for (const i of fixedOnes) {
    const same = fixedOnes.filter((x) => x !== i && x.causeKind === i.causeKind);
    if (!same.length || same.some((x) => !lexicallyDisjoint(L, x.cause, i.cause))) continue;
    out.push({ id: `x-cause-${i.id}`, suite: 'emergence', type: 'connection', lang: L, scoring: 'set', list: idSpec(same.length),
      question: q(zh ? `${i.id}的根本原因，和${scope}里哪些别的事故其实是同一类问题？列出事故编号。` : `Which other incidents in ${scope} come down to the same kind of root cause as ${i.id}? Give their IDs.`),
      items: same.map((x) => ({ label: x.id, aliases: [], weight: 1, docs: [postmortem(x)] })), evidence: ev([postmortem(i), ...same.map(postmortem)]), meta: { family: 'connection', kind: 'cause', causeKind: i.causeKind } });
  }
  const opened = s.risks.filter((r) => inCorpus(r.opened));
  for (const rk of opened) {
    const same = opened.filter((x) => x !== rk && x.kind === rk.kind);
    if (!same.length || same.some((x) => !lexicallyDisjoint(L, x.text, rk.text))) continue;
    out.push({ id: `x-risk-${rk.id}`, suite: 'emergence', type: 'connection', lang: L, scoring: 'set', list: idSpec(same.length),
      question: q(zh ? `风险${rk.id}说的那件事，在${scope}的其他组里也被提出过吗？列出说的其实是同一个问题的风险编号。` : `Was the problem behind risk ${rk.id} raised in other teams of ${scope} too? Give the IDs of the risks that are really the same problem.`),
      items: same.map((x) => ({ label: x.id, aliases: [], weight: 1, docs: [docOf(x.team, x.opened)] })), evidence: ev([docOf(rk.team, rk.opened), ...same.map((x) => docOf(x.team, x.opened))]), meta: { family: 'connection', kind: 'risk', riskKind: rk.kind } });
  }

  /* f. the same questions in other words, and in the other language */
  const alt = (t: RTeam) => t.alt;
  const altScope = scoped(s, true);
  const find = (id: string) => base.find((t) => t.id === id) ?? out.find((t) => t.id === id);
  const variant = (key: string, n: number) => parseInt(seededKey(s.seed, `pp|${key}`).slice(0, 8), 16) % n;
  for (const t of s.teams) {
    const n = find(`r-n-inc-${t.id}`);
    if (n) {
      const forms = zh ? [`从年初到第${CORPUS_WEEKS}周，${t.name}的周报里总共记了多少起事故？`, `${t.name}截至第${CORPUS_WEEKS}周累计出过多少次事故？`] : [`From the start of the year to week ${CORPUS_WEEKS}, how many incidents do ${t.name}'s reports log in total?`, `What is ${t.name}'s running total of incidents as of week ${CORPUS_WEEKS}?`];
      out.push(paraphraseOf(n, q(forms[variant(n.id, forms.length)])));
      out.push(crossLingualOf(n, altScope(other === 'en' ? `How many incidents did ${alt(t)} report through week ${CORPUS_WEEKS}?` : `截至第${CORPUS_WEEKS}周，${alt(t)}一共报告了几起事故？`), other));
    }
    const p1 = find(`r-p1-${t.id}`);
    if (p1) out.push(crossLingualOf(p1, altScope(other === 'en' ? `Which P1 incidents did ${alt(t)} have this year (through week ${CORPUS_WEEKS})? Give each incident's ID.` : `${alt(t)}今年（截至第${CORPUS_WEEKS}周）出过哪些P1事故？列出事故编号。`), other));
  }
  for (const id of ['r-n-p1', 'r-n-hired']) {
    const b = find(id);
    if (!b) continue;
    const forms = id === 'r-n-p1'
      ? (zh ? [`到第${CORPUS_WEEKS}周为止，${scope}合计发生过多少次最高级别（P1）事故？`, `${scope}截至第${CORPUS_WEEKS}周的P1事故总数是多少？`] : [`Up to week ${CORPUS_WEEKS}, how many top-severity (P1) incidents did ${scope} have between them?`, `What is the total count of P1 incidents across ${scope} as of week ${CORPUS_WEEKS}?`])
      : (zh ? [`到第${CORPUS_WEEKS}周，${scope}共有几位新同事入职？`, `${scope}截至第${CORPUS_WEEKS}周新进了多少人？`] : [`By week ${CORPUS_WEEKS}, how many new colleagues had joined ${scope}?`, `How many new hires did ${scope} take on up to week ${CORPUS_WEEKS}?`]);
    out.push(paraphraseOf(b, q(forms[variant(id, forms.length)])));
  }
  for (const x of s.tracked) {
    const b = out.find((t) => t.id === `st-${x.id}-now`);
    if (!b) continue;
    const t = team(x.team);
    const forms = zh ? [`${t.name}目前执行的${x.name}是多少？（以第${CORPUS_WEEKS}周为准）`, `第${CORPUS_WEEKS}周时，${t.name}的${x.name}定在多少？`] : [`What ${x.name} is ${t.name} running with now (as of week ${CORPUS_WEEKS})?`, `At week ${CORPUS_WEEKS}, where was ${t.name}'s ${x.name} set?`];
    out.push(paraphraseOf(b, q(forms[variant(b.id, forms.length)])));
    out.push(crossLingualOf(b, altScope(other === 'en' ? `As of week ${CORPUS_WEEKS}, what is ${alt(t)}'s ${x.alt}?` : `截至第${CORPUS_WEEKS}周，${alt(t)}的${x.alt}是多少？`), other));
  }
  return out;
}

/** Excerpts no corpus document holds, in each author's style, to attribute (the attribution probes). */
export function attributionProbes(s: ReportScript): { id: string; excerpt: string; author: string; choices: string[] }[] {
  const authors = [...new Set(Object.keys(s.styles))];
  const probes: { id: string; excerpt: string; author: string; choices: string[] }[] = [];
  for (const t of s.teams) for (const week of [REPORT_WEEKS - 3, REPORT_WEEKS - 1]) {
    const r = renderReport(s, t, week);
    // names, projects, teams, customers, settings and IDs blanked: only the way it is written says who wrote it
    const blank = s.lang === 'zh' ? '某某' : 'someone';
    let body = r.text.split('\n').slice(4).filter((l) => !/^#/.test(l)).join('\n');
    const words = [...s.people.map((p) => p.name), ...s.teams.map((x) => x.name), ...s.projects.flatMap((p) => [p.name, ...(p.renamed ? [p.renamed.to] : [])]),
      ...s.customers.flatMap((c) => [c.name, ...(c.renamed ? [c.renamed.to] : [])]), ...s.tracked.flatMap((x) => [x.name, x.short])].sort((a, b) => b.length - a.length);
    for (const w of words) body = body.split(w).join(blank);
    body = body.replace(/INC-\w+-\w+/g, 'INC-…').replace(/R-\d+/g, 'R-…').replace(/\b(?:D\d+)?T\d-C\d\b/g, 'C-…').trim();
    probes.push({ id: `e-attr-${t.id}-w${week}`, excerpt: body.slice(0, 900), author: r.author, choices: authors });
  }
  return probes;
}

/** Gold alias clusters, one per real entity: people (namesakes told apart by team), teams, projects (renames), customers (renames; look-alikes their own), settings (name, code, short alias). */
export function aliasClusters(s: ReportScript, withCustomers = true): GoldAlias[] {
  const out: GoldAlias[] = [];
  const team = (id: string) => s.teams.find((t) => t.id === id)!;
  for (const p of s.people) {
    const twin = s.twins.includes(p.name);
    out.push({ canonical: twin ? `${p.name} (${team(p.team).name})` : p.name, aliases: [p.name], kind: 'person', ...(twin ? { context: [team(p.team).name, ...(p.movedTo ? [team(p.movedTo.team).name] : []), p.role] } : {}) });
  }
  for (const t of s.teams) out.push({ canonical: t.name, aliases: [t.name, t.alt].filter(Boolean), kind: 'team' });
  for (const p of s.projects) out.push({ canonical: p.name, aliases: [p.name, ...(p.renamed ? [p.renamed.to] : [])], kind: 'project', context: [team(p.team).name] });
  for (const c of withCustomers ? s.customers : []) out.push({ canonical: c.name, aliases: [c.name, ...(c.renamed ? [c.renamed.to] : [])], kind: 'customer' });
  for (const x of s.tracked) out.push({ canonical: x.name, aliases: [x.name, x.id, x.short], kind: 'setting', context: [team(x.team).name] });
  return out;
}

/* ----------------------------------- recipe ----------------------------------- */

async function buildReports(lang: Lang, dir: string, ctx: RecipeContext) {
  const size = Math.max(1, Math.floor(Number(ctx.options.size ?? 1)));
  const datedPaths = ctx.options.datedPaths === true || ctx.options.datedPaths === 'true';
  // per-division tasks for the first divisions only: a 100× pack keeps a runnable number of tasks
  const taskDivisions = Math.max(1, Math.floor(Number(ctx.options.taskDivisions ?? Math.min(size, 10))));
  // `scale` 10: enough padding teams for --fraction 10 (each team writes CORPUS_WEEKS reports)
  const scale = Number(ctx.options.scale ?? ctx.options.padding ?? 0);
  const coreDocs = size * (3 * CORPUS_WEEKS + 9);
  const padTeams = Number(ctx.options.padTeams ?? (scale > 1 ? Math.ceil(((scale - 1) * coreDocs) / CORPUS_WEEKS) : 0));
  const world = makeReportWorld(lang, ctx.seed ?? 0, { size, padTeams });
  const zh = lang === 'zh';
  const seed = String(ctx.seed ?? 0);
  const w = new PackWriter(dir, {
    id: `synthetic-reports-${lang}${size > 1 ? `-x${size}` : ''}`,
    version: REPORTS_VERSION,
    title: zh ? `合成周报：一家公司${size > 1 ? `${size}个事业部` : '三个组'}的一年` : `Synthetic weekly reports: a year of ${size > 1 ? `${size} divisions` : 'three teams'}`,
    domain: 'synthetic',
    languages: [lang],
    description: `A year of weekly team reports and monthly PMO summaries rendered from a seeded hidden script in each lead's style, several phrasings per fact (no model): people, projects, incidents, risks, settings, metrics, team states and styles are known by construction. ${size} division(s) of three teams. Weeks 1–44 are the corpus, 45–48 four update batches, 49–52 the holdout. Separation families (docs/design/28): stale traps, look-alikes and renames, structured queries, non-lexical hops, planted connections, paraphrased and cross-lingual questions.`,
    builder: { recipe: `synthetic-reports-${lang}`, options: { seed, padTeams, size, datedPaths, taskDivisions, ...(scale > 1 ? { scale } : {}) } },
    holdout: 'holdout/script.json (the whole year) and holdout/weeks-49-52/ (the reports after the corpus ends).',
  });
  const weekly = zh ? '周报' : 'weekly';
  // the week and date are in the body; the file name says neither unless asked to
  const path = (team: RTeam, week: number) => `${weekly}/${team.name}/${datedPaths ? `${String(week).padStart(2, '0')}-${iso(dayOf(week))}` : seededKey(seed, `${team.id}|${week}`).slice(0, 10)}.md`;
  const pmoPath = (s: ReportScript) => (month: number) => `${zh ? '月报' : 'monthly'}/${s.division.index ? `${s.division.label}/` : ''}pmo-${String(month).padStart(2, '0')}.md`;
  const texts = new Map<string, string>();
  for (const s of world.divisions) {
    for (let week = 1; week <= REPORT_WEEKS; week++) {
      for (const t of s.teams) {
        const r = renderReport(s, t, week);
        texts.set(path(t, week), r.text);
        const doc = { path: path(t, week), title: r.title, date: iso(dayOf(week)), author: r.author, lang, kind: 'weekly-report' };
        if (week <= CORPUS_WEEKS) w.addDoc(doc, r.text);
        else if (week <= CORPUS_WEEKS + 4) w.addUpdate(String(week - CORPUS_WEEKS).padStart(2, '0'), doc.path, r.text);
        else w.addHoldout(`weeks-49-52/${doc.path}`, r.text);
      }
    }
    // a month's summary comes out with its last week: the months that end inside the corpus
    for (const { month } of monthEndWeeks(REPORT_WEEKS).filter((m) => m.week <= CORPUS_WEEKS)) {
      const p = renderPmo(s, month);
      const last = monthEndWeeks(REPORT_WEEKS).find((m) => m.month === month)!.week;
      w.addDoc({ path: pmoPath(s)(month), title: p.title, date: iso(dayOf(last, 4)), lang, kind: 'pmo-summary' }, p.text);
    }
    // customers are the company's: their clusters once
    for (const a of aliasClusters(s, s.division.index === 0)) w.addAlias(a);
  }
  const allTeams = world.divisions.flatMap((s) => s.teams);
  const docOf = (team: string, week: number) => path(allTeams.find((t) => t.id === team)!, week);
  const keep = (t: Draft) => t.evidence.every((e) => w.hasDoc(e.doc));
  world.divisions.slice(0, taskDivisions).forEach((s, d) => {
    const prefix = d === 0 ? '' : `d${d + 1}-`;
    const base = reportTasks(s, docOf, pmoPath(s), (doc) => texts.get(doc) ?? '').filter(keep);
    const extra = separationTasks(s, docOf, base).filter(keep);
    for (const t of [...base, ...extra]) w.addTask({ ...t, id: prefix + t.id, ...(t.meta?.of ? { meta: { ...t.meta, of: prefix + String(t.meta.of) } } : {}) });
  });
  // the company as a whole, when it has divisions: counts over every report
  if (size > 1) {
    const all = world.divisions.flatMap((s) => s.incidents.filter((i) => i.week <= CORPUS_WEEKS && i.sev === 'P1'));
    w.addTask({ id: 'sq-company-p1', suite: 'usage', type: 'structured', lang, scoring: 'count', answer: String(all.length),
      // "every team", not "every division": a division is named in the monthly summaries only
      question: zh ? `截至第${CORPUS_WEEKS}周，全公司所有组一共出过几起P1事故？` : `Through week ${CORPUS_WEEKS}, how many P1 incidents did the whole company have, across all its teams?`, evidence: [...new Set(all.map((i) => docOf(i.team, i.week)))].map((doc) => ({ doc })), meta: { family: 'structured', aggregate: 'count', scope: 'company' } });
    if (size <= 50) {
      const per = world.divisions.map((s) => ({ s, n: s.incidents.filter((i) => i.week <= CORPUS_WEEKS && quarterOf(i.week) === 2).length }));
      w.addTask({ id: 'sq-company-q2-divisions', suite: 'usage', type: 'structured', lang, scoring: 'set', list: exactSetSpec(per.length),
        question: zh ? '每个事业部第二季度各报告了几起事故？按事业部列出。' : 'How many incidents did each division report in the second quarter? List every division.',
        items: per.map(({ s, n }) => ({ label: `${s.division.label}: ${n}`, aliases: [], weight: 1, fields: [[s.division.label], [String(n)]] })),
        evidence: [...new Set(world.divisions.flatMap((s) => s.incidents.filter((i) => quarterOf(i.week) === 2 && i.week <= CORPUS_WEEKS).map((i) => docOf(i.team, i.week))))].map((doc) => ({ doc })), meta: { family: 'structured', groupBy: ['division'], scope: 'company' } });
    }
  }
  const first = world.divisions[0];
  for (const pr of attributionProbes(first)) {
    w.addTask({ id: pr.id, suite: 'emergence', type: 'attribution', lang, question: zh ? `下面这段周报（隐去了组名）最可能是谁写的？\n\n${pr.excerpt}` : `Who most likely wrote this weekly report (team name removed)?\n\n${pr.excerpt}`, choices: pr.choices, answer: pr.author, scoring: 'choice' });
  }
  // the update stream: weeks 45–48, a batch each; the latest state after each, the week before as the stale value
  for (let b = 1; b <= 4; b++) {
    const week = CORPUS_WEEKS + b;
    const batch = String(b).padStart(2, '0');
    for (const t of first.teams.slice(0, 2)) {
      const fmt = (v: number) => (t.metric.unit === '%' ? `${v}%` : zh ? `${v}万` : `${v}k`);
      const v = t.metric.values[week - 1];
      const prev = t.metric.values[week - 2];
      w.addTask({ id: `upd-metric-${t.id}-${batch}`, suite: 'update', type: 'update', lang, afterUpdate: batch, scoring: 'judge',
        question: zh ? `${t.name}最新一周的${t.metric.name}是多少？` : `What is ${t.name}'s latest weekly ${t.metric.name}?`,
        answer: fmt(v), evidence: [{ doc: path(t, week) }], ...(prev !== v ? { meta: { stale: [String(prev)], staleText: [fmt(prev)] } } : {}) });
    }
    const t3 = first.teams[2];
    const head = rosterOf(first, t3.id, week).length;
    const before = rosterOf(first, t3.id, week - 1).length;
    w.addTask({ id: `upd-head-${batch}`, suite: 'update', type: 'update', lang, afterUpdate: batch, scoring: 'judge',
      question: zh ? `${t3.name}现在在岗多少人？` : `How many people are on ${t3.name} now?`, answer: zh ? `${head}人` : `${head}`, evidence: [{ doc: path(t3, week) }], ...(before !== head ? { meta: { stale: [String(before)] } } : {}) });
  }
  // padding: other teams' years, naming nobody and nothing above
  for (const pad of world.padTeams) {
    for (let week = 1; week <= CORPUS_WEEKS; week++) {
      for (const t of pad.teams) {
        const r = renderReport(pad, t, week);
        w.addPadding({ path: path(t, week), title: r.title, date: iso(dayOf(week)), author: r.author, lang, kind: 'weekly-report' }, r.text);
      }
    }
  }
  // the first division at the top (what v1 held), the others beside it
  w.addHoldout('script.json', JSON.stringify({ ...first, otherDivisions: world.divisions.slice(1) }, null, size > 1 ? 0 : 1));
  w.setProfile({ health: Object.fromEntries(world.divisions.flatMap((s) => s.teams.map((t) => [t.name, t.health]))), styles: Object.assign({}, ...world.divisions.map((s) => s.styles)) });
  ctx.log(`synthetic-reports-${lang}: ${w.docCount} documents, ${w.taskCount} tasks, ${size} division(s)${padTeams ? `, ${padTeams} padding teams` : ''}`);
  return w.finish();
}

export function registerReportRecipes(): void {
  for (const lang of ['zh', 'en'] as const) {
    registerRecipe({
      id: `synthetic-reports-${lang}`,
      title: lang === 'zh' ? 'Synthetic weekly reports (Chinese): a year of three teams (or `size` divisions), from a hidden script' : 'Synthetic weekly reports (English): a year of three teams (or `size` divisions), from a hidden script',
      domain: 'synthetic',
      network: false,
      needsAuthor: false,
      padding: 'local',
      // recipe v3 (docs/design/33 §4) on `{"version": 3}`; without it the v2 pack, byte for byte
      build: (dir, ctx) => (Number(ctx.options.version) === 3 ? buildReportsV3(lang, dir, ctx) : buildReports(lang, dir, ctx)),
    });
  }
}
