import { rng } from '../metrics/stats.js';
import { seededKey } from '../pack.js';
import type { GoldItem, ListSpec, Task } from '../types.js';
import { CORPUS_TASK_MIN_DOCS } from '../types.js';
import { registerRecipe, RecipeContext } from './index.js';
import { PackWriter } from './writer.js';

/**
 * A year of weekly reports (docs/design/23 §2.2): three teams of one company
 * write a report every week, a PMO sums them up every month, and a hidden
 * script decides everything they say — people who join, leave and move,
 * projects that progress, slip and get renamed, incidents and who fixed them,
 * risks from first mention to closing, each team's metric, the mood of each
 * team, and how each lead writes. The reports are rendered from templates in
 * the lead's style, so the gold for every task follows from the script without
 * a model, at any size:
 *
 * - corpus-level lists across the year (incidents, departures, transfers,
 *   open risks, monthly figures, the PMO's disagreements with the teams);
 * - chains of four and five facts in five different reports (a customer's
 *   escalation → the incident → its fixer → their transfer → the project they
 *   took over → its launch);
 * - ambiguity: two people with the same name in two teams, a project renamed
 *   halfway, a metric whose definition changes;
 * - traceback: when and by whom a risk was first raised, months before it closed;
 * - emergence: each team's state per quarter (never named), each lead's style,
 *   unsigned excerpts to attribute, which projects will slip after week 48.
 *
 * Weeks 1–44 are the corpus, 45–48 four update batches, 49–52 the holdout.
 * Padding (`--options '{"padTeams":27}'`) adds other teams of the same company
 * whose reports name nobody and nothing the tasks ask about.
 */

type Lang = 'zh' | 'en';
type Draft = Omit<Task, 'evidence'> & { evidence: Task['evidence'] };

export const REPORT_WEEKS = 52;
export const CORPUS_WEEKS = 44;
const START = Date.UTC(2025, 0, 6); // a Monday

const dayOf = (week: number, d = 0) => new Date(START + ((week - 1) * 7 + d) * 86_400_000);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthOf = (week: number) => dayOf(week, 4).getUTCMonth() + 1;

/* ---------------------------------- names ---------------------------------- */

const NAMES: Record<Lang, { sur: string[]; given: string[]; padSur: string[]; customers: string[]; padCustomers: string[] }> = {
  zh: {
    sur: ['王', '李', '张', '刘', '杨', '赵', '黄', '周', '吴', '徐', '孙', '胡', '朱', '高', '林', '何', '郭', '马', '罗'],
    given: ['芳', '娜', '敏', '静', '强', '磊', '洋', '艳', '勇', '军', '杰', '涛', '明', '超', '霞', '平', '晨', '宇', '欣', '博', '鹏', '婷', '雪', '浩', '凯', '琳'],
    padSur: ['梁', '宋', '郑', '谢', '韩', '唐', '冯', '于', '董', '萧', '程', '曹', '袁', '邓', '许', '傅', '沈', '曾', '彭', '吕'],
    customers: ['华鼎零售', '星联物流', '远景银行', '青禾教育', '易达出行', '恒信保险'],
    padCustomers: ['云杉家居', '北辰医药', '海岳传媒', '启航旅行', '东篱餐饮', '南风电器', '金石地产', '白帆航运'],
  },
  en: {
    sur: ['Smith', 'Johnson', 'Brown', 'Davis', 'Miller', 'Wilson', 'Moore', 'Taylor', 'Thomas', 'Lee', 'Martin', 'Clark', 'Lewis', 'Walker', 'Hall', 'Young', 'King', 'Wright', 'Scott'],
    given: ['Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'Ethan', 'Mia', 'Lucas', 'Zoe', 'Ryan', 'Nina', 'Owen', 'Leah', 'Jack', 'Iris', 'Sam', 'Ruby', 'Max', 'Ella', 'Ben', 'Cara', 'Dean', 'Faye', 'Gabe', 'Hope', 'Ivan'],
    padSur: ['Adler', 'Baxter', 'Crane', 'Dalton', 'Ellis', 'Fowler', 'Garner', 'Hayes', 'Ingram', 'Jarvis', 'Keane', 'Lowell', 'Marsh', 'Nolan', 'Orton', 'Pryce', 'Quinn', 'Royce', 'Sutton', 'Tate'],
    customers: ['Brightmart Retail', 'Stellar Logistics', 'Vista Bank', 'Greenfield Learning', 'Swift Mobility', 'Harbor Insurance'],
    padCustomers: ['Cedar Home', 'Polar Pharma', 'Summit Media', 'Voyage Travel', 'Hearth Dining', 'Breeze Appliances', 'Granite Estates', 'Sail Shipping'],
  },
};

/** The one name two people share, in two teams: the ambiguity tasks' subject. */
const TWIN: Record<Lang, string> = { zh: '陈伟', en: 'Alex Chen' };

/* --------------------------------- the script -------------------------------- */

export interface RPerson { id: string; name: string; team: string; role: string; joined: number; left?: number; movedTo?: { team: string; week: number } }
export interface RProject { id: string; team: string; name: string; renamed?: { week: number; to: string }; owner: string; ownerChange?: { week: number; to: string }; planned: number; launch: number; progress: number[] }
export interface RIncident { id: string; team: string; week: number; sev: 'P1' | 'P2' | 'P3'; title: string; customer?: string; fixer: string; cause: string; pmoSev?: 'P1' | 'P2' }
export interface RRisk { id: string; team: string; opened: number; raisedBy: string; owner: string; ownerChange?: { week: number; to: string }; closed?: number; text: string; resolution: string }
export interface RTeam { id: string; name: string; lead: string; leadChange?: { week: number; to: string }; metric: { name: string; unit: string; values: number[]; redefined?: { week: number; note: string } }; health: string[] }

export interface ReportScript {
  lang: Lang;
  teams: RTeam[];
  people: RPerson[];
  projects: RProject[];
  incidents: RIncident[];
  risks: RRisk[];
  /** Planted 5-hop chains: customer → incident → fixer → transfer → project → launch. */
  chains: { incident: string; person: string; project: string }[];
  /** Weeks a team reports overtime (a health signal, never named as such). */
  overtime: Record<string, number[]>;
  /** The PMO's monthly figures where they differ from the team's. */
  pmo: { team: string; month: number; field: 'launch' | 'headcount' | 'severity'; teamSays: string; pmoSays: string; ref?: string }[];
  styles: Record<string, StyleId>;
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

const TEAM_DEFS: Record<Lang, { name: string; metric: string; unit: string; base: number; step: number; projects: string[]; titles: string[] }[]> = {
  zh: [
    { name: '平台组', metric: '服务可用性', unit: '%', base: 99.9, step: 0.002, projects: ['Atlas', '多活机房'], titles: ['缓存击穿', '数据延迟', '配置下发失败'] },
    { name: '支付组', metric: '支付成功率', unit: '%', base: 97.2, step: 0.03, projects: ['结算中台', '风控引擎'], titles: ['支付超时', '账单错误', '退款卡单'] },
    { name: '增长组', metric: '周活跃用户', unit: '万', base: 120, step: 1.2, projects: ['推荐系统改版', '新人礼包'], titles: ['推送重复', '登录失败', '活动页白屏'] },
  ],
  en: [
    { name: 'Platform', metric: 'service availability', unit: '%', base: 99.9, step: 0.002, projects: ['Atlas', 'Active-Active'], titles: ['cache stampede', 'data lag', 'config push failure'] },
    { name: 'Payments', metric: 'payment success rate', unit: '%', base: 97.2, step: 0.03, projects: ['Settlement Hub', 'Risk Engine'], titles: ['payment timeout', 'billing error', 'stuck refunds'] },
    { name: 'Growth', metric: 'weekly active users', unit: 'k', base: 1200, step: 12, projects: ['Recs Revamp', 'Welcome Bonus'], titles: ['duplicate push', 'login failure', 'blank campaign page'] },
  ],
};

const RENAMED: Record<Lang, string> = { zh: 'Orion', en: 'Orion' };
const HEALTH: Record<Lang, string[]> = { zh: ['健康', '吃紧', '透支'], en: ['healthy', 'stretched', 'burning out'] };

/** The whole year, from a seed: no model, any number of padding teams. */
export function makeReportScript(lang: Lang, seed: string | number, opts: { padTeams?: number } = {}): ReportScript & { padTeams: ReportScript[] } {
  const r = rng(parseInt(seededKey(seed, `reports-${lang}`).slice(0, 8), 16));
  const N = NAMES[lang];
  const used = new Set<string>([TWIN[lang]]);
  const person = (sur: string[]) => {
    for (;;) {
      const name = lang === 'zh' ? `${sur[Math.floor(r() * sur.length)]}${N.given[Math.floor(r() * N.given.length)]}` : `${N.given[Math.floor(r() * N.given.length)]} ${sur[Math.floor(r() * sur.length)]}`;
      if (!used.has(name)) {
        used.add(name);
        return name;
      }
    }
  };
  const core = buildTeams(lang, r, () => person(N.sur), TEAM_DEFS[lang], N.customers, true);
  const pads: ReportScript[] = [];
  for (let i = 0; i < (opts.padTeams ?? 0); i++) {
    const def = { ...TEAM_DEFS[lang][i % 3], name: lang === 'zh' ? `业务${i + 1}组` : `Unit ${i + 1}`, projects: [`Nova-${i + 1}`, `Vega-${i + 1}`] };
    pads.push(buildTeams(lang, r, () => person(N.padSur), [def], N.padCustomers, false));
  }
  return { ...core, padTeams: pads };
}

function buildTeams(lang: Lang, r: () => number, name: () => string, defs: (typeof TEAM_DEFS)['zh'], customers: string[], focal: boolean): ReportScript {
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const zh = lang === 'zh';
  const teams: RTeam[] = [];
  const people: RPerson[] = [];
  const projects: RProject[] = [];
  const incidents: RIncident[] = [];
  const risks: RRisk[] = [];
  const overtime: Record<string, number[]> = {};
  const pmo: ReportScript['pmo'] = [];
  const styles: Record<string, StyleId> = {};
  const roles = zh ? ['后端工程师', '前端工程师', '测试工程师', '数据工程师', '产品经理'] : ['backend engineer', 'frontend engineer', 'QA engineer', 'data engineer', 'product manager'];
  const causes = zh ? ['配置错误', '容量不足', '依赖服务超时', '代码缺陷', '数据迁移遗漏'] : ['a bad config', 'capacity', 'a dependency timing out', 'a code defect', 'a missed data migration'];
  const riskTexts = zh ? ['核心依赖年底停止维护', '关键岗位只有一人', '供应商合同到期', '压测环境不足', '合规审查未排期'] : ['a core dependency reaches end of life', 'a key role has one person', 'a vendor contract expires', 'no load-test environment', 'compliance review not scheduled'];
  const resolutions = zh ? ['已完成替换', '已补招一人', '已续签', '已申请到资源', '审查已通过'] : ['replaced', 'a second hire made', 'contract renewed', 'resources granted', 'review passed'];
  let inc = 0;
  let rk = 0;
  defs.forEach((d, ti) => {
    const team = focal ? `T${ti + 1}` : `P-${d.name}`;
    const lead = name();
    const members = [lead, ...Array.from({ length: 6 }, () => name())];
    // the twin name: one member of the first two focal teams
    if (focal && ti < 2) members[3] = TWIN[lang];
    members.forEach((m, k) => people.push({ id: `${team}-${k}`, name: m, team, role: k === 0 ? (zh ? '负责人' : 'lead') : pick(roles), joined: 1 }));
    // hires and departures across the year
    const hireWeek = 8 + Math.floor(r() * 20);
    people.push({ id: `${team}-h`, name: name(), team, role: pick(roles), joined: hireWeek });
    const leaver = people.find((p) => p.id === `${team}-5`)!;
    leaver.left = 14 + Math.floor(r() * 20);
    const t: RTeam = {
      id: team, name: d.name, lead,
      metric: {
        name: d.metric, unit: d.unit,
        values: Array.from({ length: REPORT_WEEKS }, (_, w) => {
          const noise = (r() - 0.5) * d.step * 3;
          const v = d.base + d.step * w * (ti === 2 && w >= 29 ? 0.6 : 1) + noise - (ti === 2 && w >= 29 ? d.base * 0.08 : 0);
          return Number(Math.min(d.unit === '%' ? 99.999 : Infinity, v).toFixed(d.unit === '%' ? (d.base > 99 ? 3 : 2) : 0));
        }),
        ...(ti === 2 ? { redefined: { week: 30, note: zh ? '自本周起周活跃用户口径调整：剔除测试账号和机器人账号' : 'from this week weekly active users exclude test and bot accounts' } } : {}),
      },
      health: [],
    };
    // one team's lead leaves halfway: a new lead, a new style
    if (focal && ti === 1) t.leadChange = { week: 27, to: members[1] };
    teams.push(t);
    styles[lead] = STYLES[ti % 4];
    if (t.leadChange) styles[t.leadChange.to] = 'data';
    // projects: progress per week, a planned and an actual launch
    d.projects.forEach((pname, pi) => {
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
      projects.push({ id: `${team}-p${pi}`, team, name: pname, owner: members[2 + pi], planned, launch, progress, ...(focal && ti === 0 && pi === 0 ? { renamed: { week: 20, to: RENAMED[lang] } } : {}) });
    });
    // incidents: at least three P1s a team, some escalated by customers
    for (let k = 0; k < 7; k++) {
      const week = 3 + k * 6 + Math.floor(r() * 4);
      if (week > REPORT_WEEKS - 1) break;
      const sev = k % 2 === 0 ? 'P1' : k % 3 === 0 ? 'P2' : 'P3';
      incidents.push({ id: `INC-${focal ? '' : 'X'}${String(++inc).padStart(3, '0')}-${team}`, team, week, sev, title: d.titles[k % d.titles.length], customer: sev === 'P1' && k < 6 ? customers[(ti * 2 + k) % customers.length] : undefined, fixer: members[1 + (k % 5)], cause: causes[k % causes.length] });
    }
    // risks: raised, owned, sometimes handed over, mostly closed
    for (let k = 0; k < 4; k++) {
      const opened = 2 + k * 9 + Math.floor(r() * 5);
      const closed = k === 3 ? undefined : opened + 6 + Math.floor(r() * 10);
      risks.push({ id: `R-${focal ? '' : 'X'}${String(++rk).padStart(2, '0')}`, team, opened, raisedBy: members[1 + k], owner: members[2 + k], ...(k === 1 ? { ownerChange: { week: opened + 4, to: members[2] } } : {}), ...(closed && closed <= REPORT_WEEKS ? { closed } : {}), text: riskTexts[k], resolution: resolutions[k] });
    }
    // overtime: a burst in the quarter this team strains
    const strained = ti === 2 ? 3 : ti === 1 ? 2 : 0;
    overtime[team] = Array.from({ length: REPORT_WEEKS }, (_, w) => w + 1).filter((w) => strained && Math.ceil(w / 13) === strained && r() < 0.7);
    t.health = [1, 2, 3, 4].map((q) => {
      const ot = overtime[team].filter((w) => Math.ceil(w / 13) === q).length;
      const p1 = incidents.filter((i) => i.team === team && i.sev === 'P1' && Math.ceil(i.week / 13) === q).length;
      const leaving = people.filter((p) => p.team === team && p.left && Math.ceil(p.left / 13) === q).length;
      const score = ot / 3 + p1 + leaving;
      return HEALTH[lang][score >= 4 ? 2 : score >= 2 ? 1 : 0];
    });
  });

  const chains: ReportScript['chains'] = [];
  if (focal) {
    // transfers: a fixer of an escalated P1 moves to another team and takes over a project there
    for (const [from, to] of [[0, 2], [1, 0], [2, 1]] as const) {
      // an escalated P1 whose fixer can move: not a lead, not the twin, not leaving, not moved already
      for (const p1 of incidents.filter((i) => i.team === teams[from].id && i.customer && i.week < 20)) {
        const mover = people.find((p) => p.name === p1.fixer && p.team === teams[from].id && !p.left && !p.movedTo && p.name !== TWIN[lang] && p.name !== teams[from].lead && p.name !== teams[from].leadChange?.to
          && !projects.some((x) => x.owner === p.name) && !risks.some((x) => x.owner === p.name || x.ownerChange?.to === p.name));
        if (!mover) continue;
        const week = p1.week + 5 + Math.floor(r() * 4);
        // the project they take over launches inside the corpus, so the chain ends in an answer
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
  }
  return { lang, teams, people, projects, incidents, risks, chains, overtime, pmo, styles };
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
const personName = (s: ReportScript, id: string) => s.people.find((p) => p.id === id)!.name;

interface Line {
  key: string;
  text: string;
}

/** What a team's report says in a week, as keyed lines; the style decides how they are laid out. */
function facts(s: ReportScript, t: RTeam, week: number): Record<'progress' | 'metric' | 'incidents' | 'risks' | 'people' | 'mood' | 'members' | 'feedback' | 'meeting' | 'plan', Line[]> {
  const zh = s.lang === 'zh';
  const fmtV = (v: number) => (t.metric.unit === '%' ? `${v}%` : zh ? `${v}万` : `${v}k`);
  const out = { progress: [] as Line[], metric: [] as Line[], incidents: [] as Line[], risks: [] as Line[], people: [] as Line[], mood: [] as Line[], members: [] as Line[], feedback: [] as Line[], meeting: [] as Line[], plan: [] as Line[] };
  const W = WORK[s.lang];
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
    out.meeting.push({ key: `meeting:${k}`, text: hashPick(WORK[s.lang].meeting, t.id, week, 'm', k).replace('{p}', p ? projectName(p, week) : zh ? '例行工作' : 'routine work') });
  }
  if (parseInt(seededKey('fb', `${t.id}|${week}`).slice(0, 2), 16) < 90) {
    const c = hashPick(NAMES[s.lang].customers, t.id, week, 'c');
    out.feedback.push({ key: 'feedback', text: zh ? `客户${c}${hashPick(W.feedback, t.id, week)}，已记录` : `${c} ${hashPick(W.feedback, t.id, week)}; logged` });
  }
  for (const p of s.projects.filter((x) => x.team === t.id)) {
    const name = projectName(p, week);
    const prog = p.progress[week - 1];
    if (prog === 0) continue;
    const prev = week > 1 ? p.progress[week - 2] : 0;
    if (prev === 100) continue;
    const owner = p.ownerChange && week >= p.ownerChange.week ? p.ownerChange.to : p.owner;
    let text = prog === 100 ? (zh ? `${name}已于本周上线` : `${name} launched this week`) : zh ? `${name}完成度${prog}%，负责人${owner}，计划第${p.planned}周上线` : `${name} at ${prog}%, owner ${owner}, launch planned for week ${p.planned}`;
    if (p.renamed && week === p.renamed.week) text += zh ? `（原项目名${p.name}，自本周起改名为${p.renamed.to}）` : ` (formerly ${p.name}, renamed ${p.renamed.to} from this week)`;
    if (p.ownerChange && week === p.ownerChange.week) text += zh ? `（自本周起由${p.ownerChange.to}接手）` : ` (${p.ownerChange.to} takes over from this week)`;
    if (week > p.planned && prog < 100) text += zh ? `，已延期${week - p.planned}周` : `, ${week - p.planned} weeks late`;
    out.progress.push({ key: `prog:${p.id}`, text });
  }
  const v = t.metric.values[week - 1];
  const pv = week > 1 ? t.metric.values[week - 2] : v;
  out.metric.push({ key: 'metric', text: zh ? `${t.metric.name}：${fmtV(v)}` : `${t.metric.name}: ${fmtV(v)}` });
  out.metric.push({ key: 'metric-delta', text: zh ? `环比${v >= pv ? '+' : ''}${(((v - pv) / (pv || 1)) * 100).toFixed(2)}%` : `${v >= pv ? '+' : ''}${(((v - pv) / (pv || 1)) * 100).toFixed(2)}% week on week` });
  if (t.metric.redefined && week === t.metric.redefined.week) out.metric.push({ key: 'redefined', text: t.metric.redefined.note });
  for (const i of s.incidents.filter((x) => x.team === t.id && x.week === week)) {
    out.incidents.push({ key: `inc:${i.id}`, text: zh ? `${i.id}（${i.sev}）${i.title}${i.customer ? `，由客户${i.customer}升级` : ''}` : `${i.id} (${i.sev}) ${i.title}${i.customer ? `, escalated by ${i.customer}` : ''}` });
  }
  for (const i of s.incidents.filter((x) => x.team === t.id && x.week + 1 === week)) {
    out.incidents.push({ key: `fix:${i.id}`, text: zh ? `${i.id}复盘：根因是${i.cause}，由${i.fixer}修复` : `${i.id} postmortem: caused by ${i.cause}, fixed by ${i.fixer}` });
  }
  for (const rk of s.risks.filter((x) => x.team === t.id && x.opened <= week && (!x.closed || x.closed >= week))) {
    const owner = rk.ownerChange && week >= rk.ownerChange.week ? rk.ownerChange.to : rk.owner;
    const text = week === rk.opened ? (zh ? `新风险${rk.id}：${rk.text}（${rk.raisedBy}提出，负责人${owner}）` : `new risk ${rk.id}: ${rk.text} (raised by ${rk.raisedBy}, owner ${owner})`)
      : week === rk.closed ? (zh ? `${rk.id}已关闭：${rk.resolution}` : `${rk.id} closed: ${rk.resolution}`)
        : rk.ownerChange && week === rk.ownerChange.week ? (zh ? `${rk.id}负责人改为${owner}` : `${rk.id} now owned by ${owner}`)
          : (zh ? `${rk.id}仍未解决（负责人${owner}）` : `${rk.id} still open (owner ${owner})`);
    out.risks.push({ key: `risk:${rk.id}`, text });
  }
  for (const p of s.people) {
    if (p.team === t.id && p.joined === week && week > 1) out.people.push({ key: `join:${p.id}`, text: zh ? `${p.name}加入，任${p.role}` : `${p.name} joined as ${p.role}` });
    if (p.team === t.id && p.left === week) out.people.push({ key: `left:${p.id}`, text: zh ? `${p.name}本周离职` : `${p.name} left the company this week` });
    if (p.movedTo && p.movedTo.week === week && p.team === t.id) out.people.push({ key: `out:${p.id}`, text: zh ? `${p.name}调往${s.teams.find((x) => x.id === p.movedTo!.team)!.name}` : `${p.name} moved to ${s.teams.find((x) => x.id === p.movedTo!.team)!.name}` });
    if (p.movedTo && p.movedTo.week === week && p.movedTo.team === t.id) out.people.push({ key: `in:${p.id}`, text: zh ? `${p.name}从${s.teams.find((x) => x.id === p.team)!.name}调入` : `${p.name} joined us from ${s.teams.find((x) => x.id === p.team)!.name}` });
  }
  if (t.leadChange && week === t.leadChange.week) out.people.push({ key: 'lead', text: zh ? `${t.lead}卸任，${t.leadChange.to}接任组负责人` : `${t.lead} steps down; ${t.leadChange.to} now leads the team` });
  out.people.push({ key: 'headcount', text: zh ? `在岗${rosterOf(s, t.id, week).length}人` : `${rosterOf(s, t.id, week).length} people on the team` });
  if (s.overtime[t.id]?.includes(week)) out.mood.push({ key: 'overtime', text: zh ? `本周有${2 + (week % 3)}天加班到十点以后` : `${2 + (week % 3)} nights past 10 pm this week` });
  return out;
}

const HEAD: Record<Lang, Record<string, string>> = {
  zh: { progress: '进展', metric: '指标', incidents: '事故', risks: '风险', people: '人员', mood: '团队', members: '成员动态', meeting: '会议纪要', feedback: '客户反馈', plan: '下周计划' },
  en: { progress: 'Progress', metric: 'Metrics', incidents: 'Incidents', risks: 'Risks', people: 'People', mood: 'Team', members: 'Member updates', meeting: 'Meetings', feedback: 'Customer feedback', plan: 'Next week' },
};

/** Everyday work: what fills most of a report and is gold for nothing — the haystack. */
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
  const sections = (['progress', 'metric', 'incidents', 'risks', 'people', 'members', 'meeting', 'feedback', 'mood', 'plan'] as const).filter((k) => f[k].length);
  const lines: string[] = [`# ${title}`, '', zh ? `${range} · ${author}` : `${range} · ${author}`, ''];
  const hedge = (x: string, i: number) => (zh ? `${['大概', '可能', '初步看'][i % 3]}${x}` : `${['roughly, ', 'probably ', 'at first glance '][i % 3]}${x}`);
  if (style === 'terse') {
    for (const k of sections) {
      lines.push(`**${HEAD[s.lang][k]}**`);
      for (const l of f[k]) lines.push(`- ${l.key.startsWith('risk') || l.key.startsWith('inc') ? '⚠️' : '✅'} ${l.text}`);
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
    const nums = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
    sections.forEach((k, i) => {
      lines.push(zh ? `## ${nums[i]}、${HEAD.zh[k]}` : `## ${i + 1}. ${HEAD.en[k]}`);
      for (const l of f[k]) lines.push(zh ? `${l.text.replace(/已于本周上线/, '已上线（ETA达成）')}。` : `${l.text.replace(/launched this week/, 'has been launched (ETA met)')}.`);
      lines.push('');
    });
    lines.push(zh ? '以上，请审阅。' : 'Submitted for review.');
  } else {
    lines.push(zh ? `**结论**：${f.progress[0]?.text ?? f.metric[0].text}` : `**TL;DR**: ${f.progress[0]?.text ?? f.metric[0].text}`, '');
    lines.push(zh ? '| 指标 | 本周 | 环比 |' : '| Metric | This week | WoW |', '| --- | --- | --- |');
    lines.push(`| ${f.metric[0].text.split(/[：:]/)[0]} | ${f.metric[0].text.split(/[：:]\s*/)[1]} | ${f.metric[1].text.replace(/环比| week on week/g, '')} |`, '');
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

/** The PMO's monthly roll-up: each team's headcount, its first project's launch week and its incidents — with the PMO's own figures. */
export function renderPmo(s: ReportScript, month: number): { title: string; text: string } {
  const zh = s.lang === 'zh';
  const weeks = Array.from({ length: CORPUS_WEEKS + 4 }, (_, i) => i + 1).filter((w) => monthOf(w) === month);
  const last = weeks.at(-1)!;
  const lines = [zh ? `# 项目管理办公室月报 · ${month}月` : `# PMO monthly summary · ${['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][month]}`, ''];
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
    lines.push(zh ? `## ${t.name}` : `## ${t.name}`);
    lines.push(zh ? `- 在岗人数：${head}人` : `- Headcount: ${head}`);
    if (p.progress[last - 1] < 100) lines.push(zh ? `- ${projectName(p, last)}：预计第${launch}周上线` : `- ${projectName(p, last)}: expected to launch in week ${launch}`);
    for (const i of incs) lines.push(zh ? `- 事故${i.id}：${i.pmoSev ?? i.sev}` : `- Incident ${i.id}: ${i.pmoSev ?? i.sev}`);
    lines.push('');
  }
  return { title: lines[0].slice(2), text: lines.join('\n') + '\n' };
}

/* ------------------------------------ tasks ------------------------------------ */

/** Gold and tasks from the script and where each report landed (no model). */
export function reportTasks(s: ReportScript, docOf: (team: string, week: number) => string, pmoDoc: (month: number) => string, textOf: (doc: string) => string = () => ''): Draft[] {
  const zh = s.lang === 'zh';
  const L = s.lang;
  const out: Draft[] = [];
  const team = (id: string) => s.teams.find((t) => t.id === id)!;
  const names = [...new Set([...s.people.map((p) => p.name), ...s.teams.map((t) => t.name), ...s.projects.map((p) => p.name), ...s.projects.flatMap((p) => (p.renamed ? [p.renamed.to] : []))])];
  const closed = { terms: names, prefixes: [] as string[] };
  const spec = (x: Partial<ListSpec>): ListSpec => ({ match: 'alias', ordered: false, maxItems: 10, requireDocs: false, primary: 'f1', ...x });
  const ev = (docs: string[]) => [...new Set(docs)].map((doc) => ({ doc }));
  const inCorpus = (w: number) => w >= 1 && w <= CORPUS_WEEKS;
  const list = (id: string, type: Task['type'], question: string, items: GoldItem[], docs: string[], x: Partial<ListSpec> = {}, primary = false) => {
    if (new Set(docs).size < CORPUS_TASK_MIN_DOCS || !items.length) return;
    out.push({ id, suite: 'usage', type, lang: L, question, scoring: 'set', items, list: spec({ maxItems: Math.min(60, Math.max(10, items.length + 5)), ...x }), closedWorld: closed, evidence: ev(docs), ...(primary ? { primary } : {}) });
  };
  const count = (id: string, question: string, n: number, docs: string[]) => {
    if (new Set(docs).size < CORPUS_TASK_MIN_DOCS) return;
    out.push({ id, suite: 'usage', type: 'aggregate', lang: L, question, answer: String(n), scoring: 'count', closedWorld: closed, evidence: ev(docs) });
  };
  const monthName = (m: number) => (zh ? `${m}月` : ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m]);

  // incidents: every P1 of a team, all incidents escalated by customers, counts
  for (const t of s.teams) {
    const p1 = s.incidents.filter((i) => i.team === t.id && i.sev === 'P1' && inCorpus(i.week + 1));
    list(`r-p1-${t.id}`, 'aggregate', zh ? `${t.name}今年（截至第${CORPUS_WEEKS}周）出过哪些P1事故？列出事故编号和名称。` : `Which P1 incidents did ${t.name} have this year (through week ${CORPUS_WEEKS})? Give each incident's ID and title.`,
      p1.map((i) => ({ label: i.id, aliases: [], weight: 1, docs: [docOf(t.id, i.week)] })), p1.flatMap((i) => [docOf(t.id, i.week), docOf(t.id, i.week + 1)]), {}, t.id === 'T1');
    const all = s.incidents.filter((i) => i.team === t.id && inCorpus(i.week));
    count(`r-n-inc-${t.id}`, zh ? `截至第${CORPUS_WEEKS}周，${t.name}一共报告了几起事故？` : `How many incidents did ${t.name} report through week ${CORPUS_WEEKS}?`, all.length, all.map((i) => docOf(t.id, i.week)));
  }
  const escalated = s.incidents.filter((i) => i.customer && inCorpus(i.week));
  list('r-customers', 'aggregate', zh ? '今年有哪些客户升级过事故？' : 'Which customers escalated an incident this year?', [...new Set(escalated.map((i) => i.customer!))].map((c) => ({ label: c, aliases: [], weight: 1, docs: escalated.filter((i) => i.customer === c).map((i) => docOf(i.team, i.week)) })), escalated.map((i) => docOf(i.team, i.week)), {}, true);
  count('r-n-p1', zh ? `截至第${CORPUS_WEEKS}周，三个组一共出过几起P1事故？` : `How many P1 incidents did the three teams have in all through week ${CORPUS_WEEKS}?`, s.incidents.filter((i) => i.sev === 'P1' && inCorpus(i.week)).length, s.incidents.filter((i) => i.sev === 'P1' && inCorpus(i.week)).map((i) => docOf(i.team, i.week)));

  // people: departures, transfers, hires
  const left = s.people.filter((p) => p.left && inCorpus(p.left));
  const moved = s.people.filter((p) => p.movedTo && inCorpus(p.movedTo.week));
  const hired = s.people.filter((p) => p.joined > 1 && inCorpus(p.joined));
  list('r-left', 'aggregate', zh ? '今年有哪些人离职了？' : 'Who left the company this year?', left.map((p) => ({ label: p.name, aliases: [], weight: 1, docs: [docOf(p.team, p.left!)] })), [...left.map((p) => docOf(p.team, p.left!)), ...left.map((p) => docOf(p.team, p.left! - 1))]);
  list('r-moved', 'aggregate', zh ? '今年有哪些人在组之间调动？分别从哪个组调到哪个组？' : 'Who moved between teams this year, and from which team to which?', moved.map((p) => ({ label: p.name, aliases: [], weight: 1, docs: [docOf(p.team, p.movedTo!.week), docOf(p.movedTo!.team, p.movedTo!.week)] })), moved.flatMap((p) => [docOf(p.team, p.movedTo!.week - 1), docOf(p.team, p.movedTo!.week), docOf(p.movedTo!.team, p.movedTo!.week)]), { requireDocs: false }, true);
  count('r-n-hired', zh ? `截至第${CORPUS_WEEKS}周，三个组一共新招了几个人？` : `How many people did the three teams hire through week ${CORPUS_WEEKS}?`, hired.length, [...hired.map((p) => docOf(p.team, p.joined)), ...s.teams.map((t) => docOf(t.id, CORPUS_WEEKS))]);

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
    out.push({ id: `r-trace-${rk.id}`, suite: 'usage', type: 'temporal', lang: L, question: zh ? `风险${rk.id}是哪一周、由谁最早提出的？最后是在哪一周、怎么关闭的？` : `In which week, and by whom, was risk ${rk.id} first raised? When and how was it closed?`,
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
    slipped.map((p) => ({ label: projectName(p, CORPUS_WEEKS), aliases: [p.name], weight: 1, docs: [docOf(p.team, Math.min(CORPUS_WEEKS, p.planned + 1))] })),
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

  // figures over the year: month-end metric, month-end headcount, project progress
  const monthEnds = [...new Set(Array.from({ length: CORPUS_WEEKS }, (_, i) => i + 1).map(monthOf))].map((m) => Math.max(...Array.from({ length: CORPUS_WEEKS }, (_, i) => i + 1).filter((w) => monthOf(w) === m)));
  for (const t of s.teams) {
    const fmtV = (v: number) => (t.metric.unit === '%' ? `${v}%` : zh ? `${v}万` : `${v}k`);
    list(`t-metric-${t.id}`, 'timeline', zh ? `${t.name}的${t.metric.name}每个月最后一周分别是多少？按月列出。` : `What was ${t.name}'s ${t.metric.name} in the last week of each month? List the months in order.`,
      monthEnds.map((w) => ({ label: fmtV(t.metric.values[w - 1]), aliases: [String(t.metric.values[w - 1])], weight: 1, date: iso(dayOf(w)), docs: [docOf(t.id, w)] })), monthEnds.map((w) => docOf(t.id, w)), { ordered: true }, t.id === 'T2');
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
      const teamDocs = Array.from({ length: CORPUS_WEEKS }, (_, i) => i + 1).filter((w) => p.progress[w - 1] > 0 && p.progress[w - 1] < 100 && monthOf(w) <= d.month + 1).slice(-5).map((w) => docOf(t.id, w));
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

  // profiles: the people with a year's worth of history
  const rich = s.people.filter((p) => p.movedTo || s.projects.some((x) => x.owner === p.name || x.ownerChange?.to === p.name) || s.incidents.filter((i) => i.fixer === p.name).length >= 2).slice(0, 10);
  for (const p of rich) {
    if (p.name === TWIN[L]) continue;
    const items: GoldItem[] = [];
    const docs: string[] = [];
    const add = (label: string, doc: string, aliases: string[] = []) => {
      items.push({ label, aliases, weight: 1, docs: [doc] });
      docs.push(doc);
    };
    if (p.movedTo && inCorpus(p.movedTo.week)) add(zh ? `第${p.movedTo.week}周从${team(p.team).name}调到${team(p.movedTo.team).name}` : `moved from ${team(p.team).name} to ${team(p.movedTo.team).name} in week ${p.movedTo.week}`, docOf(p.team, p.movedTo.week), [team(p.movedTo.team).name]);
    for (const i of s.incidents.filter((x) => x.fixer === p.name && inCorpus(x.week + 1))) add(zh ? `修复了${i.id}（${i.title}）` : `fixed ${i.id} (${i.title})`, docOf(i.team, i.week + 1), [i.id]);
    for (const r of s.risks.filter((x) => x.raisedBy === p.name && inCorpus(x.opened))) add(zh ? `提出了风险${r.id}` : `raised risk ${r.id}`, docOf(r.team, r.opened), [r.id]);
    for (const r of s.risks.filter((x) => (x.owner === p.name || x.ownerChange?.to === p.name) && inCorpus(x.opened))) add(zh ? `负责风险${r.id}` : `owned risk ${r.id}`, docOf(r.team, r.ownerChange?.to === p.name ? r.ownerChange.week : r.opened), [r.id]);
    for (const x of s.projects.filter((q) => (q.owner === p.name || q.ownerChange?.to === p.name))) {
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
    out.push({ id: `h5-${i.id}`, suite: 'usage', type: 'deep-hop', lang: L,
      question: zh ? `${monthName(monthOf(i.week))}${i.customer}升级的那起P1事故，修复它的工程师后来调到了另一个组，并在那里接手了一个项目。那个项目最终是在第几周上线的？` : `The P1 incident ${i.customer} escalated in ${monthName(monthOf(i.week))} was fixed by an engineer who later moved to another team and took over a project there. In which week did that project finally launch?`,
      answer: zh ? `第${p.launch}周（${projectName(p, p.launch)}）` : `week ${p.launch} (${projectName(p, p.launch)})`, keypoints: [String(p.launch)], scoring: 'judge', evidence: ev(docs), primary: true,
      meta: { hops: 5, bridges: [i.id, mover.name, team(mover.movedTo!.team).name, projectName(p, p.ownerChange!.week)] } });
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
      question: zh ? `风险${rk.id}后来换了负责人。新负责人自己负责的是哪个项目？那个项目到第${CORPUS_WEEKS}周为止情况如何？` : `Risk ${rk.id} later changed owner. Which project does the new owner run, and where did it stand by week ${CORPUS_WEEKS}?`,
      answer: `${projectName(p, CORPUS_WEEKS)}：${status}`, keypoints: [projectName(p, CORPUS_WEEKS), status], scoring: 'judge', evidence: ev(docs), meta: { hops: 4, bridges: [owner] } });
  }

  // five hops the other way: a risk → who raised it → the escalated P1 they fixed → the same customer's incident in another team → who fixed that
  for (const rk of s.risks.filter((r) => inCorpus(r.opened))) {
    const fixed = s.incidents.find((i) => i.fixer === rk.raisedBy && i.customer && inCorpus(i.week + 1) && i.team === rk.team);
    const other = fixed && s.incidents.find((i) => i.customer === fixed.customer && i.team !== fixed.team && inCorpus(i.week + 1));
    if (!fixed || !other || other.fixer === rk.raisedBy) continue;
    const docs = [docOf(rk.team, rk.opened), docOf(fixed.team, fixed.week + 1), docOf(fixed.team, fixed.week), docOf(other.team, other.week), docOf(other.team, other.week + 1)];
    if (new Set(docs).size < 5 || out.some((t) => t.id === `h5r-${fixed.customer}`)) continue;
    out.push({ id: `h5r-${fixed.customer}`, suite: 'usage', type: 'deep-hop', lang: L,
      question: zh ? `提出风险${rk.id}的人修复过一起由客户升级的事故。同一个客户还在另一个组升级过事故——那一起是谁修复的？` : `Whoever raised risk ${rk.id} fixed an incident a customer had escalated. The same customer escalated an incident in another team as well: who fixed that one?`,
      answer: zh ? `${other.fixer}（${team(other.team).name}，${other.id}）` : `${other.fixer} (${team(other.team).name}, ${other.id})`, keypoints: [other.fixer], scoring: 'judge', evidence: ev(docs), primary: true,
      meta: { hops: 5, bridges: [rk.raisedBy, fixed.id, fixed.customer!, other.id] } });
  }

  // ambiguity: two people with one name; a renamed project; a metric whose definition changed
  const twins = s.people.filter((p) => p.name === TWIN[L]);
  // the first report of each twin's team that names them
  const firstMention = (p: RPerson) => Array.from({ length: CORPUS_WEEKS }, (_, i) => docOf(p.team, i + 1)).find((d) => textOf(d).includes(p.name));
  if (twins.length === 2 && twins.every(firstMention)) {
    const readings: GoldItem[] = twins.map((p) => ({ label: team(p.team).name, aliases: [], weight: 1, docs: [firstMention(p)!] }));
    out.push({ id: 'a-twins', suite: 'usage', type: 'ambiguous', lang: L, question: zh ? `${TWIN.zh}在哪个组？` : `Which team is ${TWIN.en} on?`, scoring: 'set', items: readings, list: spec({ maxItems: 5 }),
      evidence: ev(twins.map((p) => firstMention(p)!)), meta: { readings: 2 }, primary: true });
    for (const p of twins) {
      const fixed = s.incidents.filter((i) => i.fixer === p.name && i.team === p.team && inCorpus(i.week + 1));
      if (!fixed.length) continue;
      out.push({ id: `a-twin-${p.team}`, suite: 'usage', type: 'ambiguous', lang: L, question: zh ? `${team(p.team).name}的${p.name}今年修复过哪些事故？` : `Which incidents did ${p.name} of ${team(p.team).name} fix this year?`, scoring: 'set',
        items: fixed.map((i) => ({ label: i.id, aliases: [], weight: 1, docs: [docOf(i.team, i.week + 1)] })), list: spec({}), evidence: ev(fixed.map((i) => docOf(i.team, i.week + 1))), meta: { twin: true } });
    }
  }
  const renamed = s.projects.find((p) => p.renamed);
  if (renamed && renamed.launch <= CORPUS_WEEKS) {
    out.push({ id: 'a-renamed', suite: 'usage', type: 'ambiguous', lang: L, question: zh ? `${renamed.name}项目最后上线了吗？哪一周？` : `Did the ${renamed.name} project ever launch? In which week?`,
      answer: zh ? `上线了：第${renamed.launch}周，那时已改名为${renamed.renamed!.to}（第${renamed.renamed!.week}周改名）` : `yes, in week ${renamed.launch}, by then renamed ${renamed.renamed!.to} (renamed in week ${renamed.renamed!.week})`,
      keypoints: [String(renamed.launch), renamed.renamed!.to], scoring: 'judge', evidence: ev([docOf(renamed.team, renamed.renamed!.week), docOf(renamed.team, renamed.launch)]), meta: { hops: 2 } });
  }
  const growth = s.teams.find((t) => t.metric.redefined);
  if (growth) {
    const w = growth.metric.redefined!.week;
    const fmtV = (v: number) => (zh ? `${v}万` : `${v}k`);
    out.push({ id: 'a-redefined', suite: 'usage', type: 'ambiguous', lang: L,
      question: zh ? `${growth.name}的${growth.metric.name}从第1周到第${CORPUS_WEEKS}周增长了多少？` : `How much did ${growth.name}'s ${growth.metric.name} grow from week 1 to week ${CORPUS_WEEKS}?`,
      answer: zh ? `不能直接相减：第${w}周口径调整（剔除测试和机器人账号）。旧口径从${fmtV(growth.metric.values[0])}到第${w - 1}周${fmtV(growth.metric.values[w - 2])}，新口径从第${w}周${fmtV(growth.metric.values[w - 1])}到第${CORPUS_WEEKS}周${fmtV(growth.metric.values[CORPUS_WEEKS - 1])}`
        : `not directly: the definition changed in week ${w} (test and bot accounts excluded). Old basis ${fmtV(growth.metric.values[0])} to ${fmtV(growth.metric.values[w - 2])} in week ${w - 1}; new basis ${fmtV(growth.metric.values[w - 1])} in week ${w} to ${fmtV(growth.metric.values[CORPUS_WEEKS - 1])} in week ${CORPUS_WEEKS}`,
      keypoints: [zh ? '口径调整' : 'definition changed', String(w)], scoring: 'judge', evidence: ev([docOf(growth.id, 1), docOf(growth.id, w - 1), docOf(growth.id, w), docOf(growth.id, CORPUS_WEEKS)]) });
  }

  // emergence: each team's state per quarter (never named), the signs, each lead's style
  for (const t of s.teams) {
    t.health.slice(0, 3).forEach((h, qi) => {
      const weeks = Array.from({ length: 13 }, (_, i) => qi * 13 + i + 1).filter(inCorpus);
      out.push({ id: `e-health-${t.id}-q${qi + 1}`, suite: 'emergence', type: 'affect', lang: L,
        question: zh ? `综合第${qi + 1}季度的周报，${t.name}那段时间的整体状态更接近哪一种？` : `Taking the reports of quarter ${qi + 1} together, which best describes the state ${t.name} was in?`,
        choices: HEALTH[L], answer: h, scoring: 'choice', evidence: ev(weeks.slice(0, 6).map((w) => docOf(t.id, w))), primary: qi === 2 });
    });
    const authors = [t.lead, ...(t.leadChange ? [t.leadChange.to] : [])];
    for (const a of authors) {
      const style = s.styles[a];
      const weeks = Array.from({ length: CORPUS_WEEKS }, (_, i) => i + 1).filter((w) => leadOf(t, w) === a);
      out.push({ id: `e-style-${t.id}-${style}`, suite: 'emergence', type: 'style', lang: L,
        question: zh ? `${a}写周报有什么风格特点？` : `What is characteristic of how ${a} writes the weekly reports?`, scoring: 'set', items: STYLE_ITEMS[L][style],
        evidence: ev(weeks.slice(0, 5).map((w) => docOf(t.id, w))), meta: { minEvidence: 1 } });
    }
  }
  // which projects will slip past their planned week after the corpus ends (the holdout decides)
  const late = s.projects.filter((p) => p.launch > CORPUS_WEEKS && p.launch > p.planned);
  if (late.length) {
    out.push({ id: 'e-slip', suite: 'emergence', type: 'forecast', lang: L,
      question: zh ? `根据到第${CORPUS_WEEKS}周为止的周报，哪些项目最可能赶不上原定的上线周？` : `From the reports through week ${CORPUS_WEEKS}, which projects are most likely to miss their planned launch week?`,
      scoring: 'set', items: late.map((p) => ({ label: projectName(p, CORPUS_WEEKS), aliases: [p.name], weight: 1 })), evidence: [], meta: { minEvidence: 1, match: 'terms' } });
  }
  return out;
}

/** Excerpts no corpus document holds, in each author's style, to attribute (the attribution probes). */
export function attributionProbes(s: ReportScript): { id: string; excerpt: string; author: string; choices: string[] }[] {
  const authors = [...new Set(Object.keys(s.styles))];
  const probes: { id: string; excerpt: string; author: string; choices: string[] }[] = [];
  for (const t of s.teams) for (const week of [REPORT_WEEKS - 3, REPORT_WEEKS - 1]) {
    // a holdout week, written by whoever leads then
    const r = renderReport(s, t, week);
    // names, projects, teams and IDs blanked: only the way it is written says who wrote it
    const blank = s.lang === 'zh' ? '某某' : 'someone';
    let body = r.text.split('\n').slice(4).filter((l) => !/^#/.test(l)).join('\n');
    const words = [...s.people.map((p) => p.name), ...s.teams.map((x) => x.name), ...s.projects.flatMap((p) => [p.name, ...(p.renamed ? [p.renamed.to] : [])])].sort((a, b) => b.length - a.length);
    for (const w of words) body = body.split(w).join(blank);
    body = body.replace(/INC-\w+-\w+/g, 'INC-…').replace(/R-\d+/g, 'R-…').trim();
    probes.push({ id: `e-attr-${t.id}-w${week}`, excerpt: body.slice(0, 900), author: r.author, choices: authors });
  }
  return probes;
}

/* ----------------------------------- recipe ----------------------------------- */

async function buildReports(lang: Lang, dir: string, ctx: RecipeContext) {
  // `scale` 10: enough other teams for --fraction 10 (each team writes CORPUS_WEEKS reports; the corpus is three teams and the PMO)
  const scale = Number(ctx.options.scale ?? ctx.options.padding ?? 0);
  const coreDocs = 3 * CORPUS_WEEKS + 9;
  const padTeams = Number(ctx.options.padTeams ?? (scale > 1 ? Math.ceil(((scale - 1) * coreDocs) / CORPUS_WEEKS) : 0));
  const s = makeReportScript(lang, ctx.seed ?? 0, { padTeams });
  const zh = lang === 'zh';
  const w = new PackWriter(dir, {
    id: `synthetic-reports-${lang}`,
    version: 1,
    title: zh ? '合成周报：一家公司三个组的一年' : 'Synthetic weekly reports: a year of three teams',
    domain: 'synthetic',
    languages: [lang],
    description: 'A year of weekly team reports and monthly PMO summaries rendered from a seeded hidden script in each lead\'s style (no model): people, projects, incidents, risks, metrics, team states and styles are known by construction. Weeks 1–44 are the corpus, 45–48 four update batches, 49–52 the holdout.',
    builder: { recipe: `synthetic-reports-${lang}`, options: { seed: ctx.seed ?? 0, padTeams, ...(scale > 1 ? { scale } : {}) } },
    holdout: 'holdout/script.json (the whole year) and holdout/weeks-49-52/ (the reports after the corpus ends).',
  });
  const path = (team: RTeam, week: number) => `${zh ? '周报' : 'weekly'}/${team.name}/${String(week).padStart(2, '0')}-${iso(dayOf(week))}.md`;
  const pmoPath = (month: number) => `${zh ? '月报' : 'monthly'}/pmo-${String(month).padStart(2, '0')}.md`;
  const texts = new Map<string, string>();
  for (let week = 1; week <= REPORT_WEEKS; week++) {
    for (const t of s.teams) {
      const r = renderReport(s, t, week);
      texts.set(path(t, week), r.text);
      const doc = { path: path(t, week), title: r.title, date: iso(dayOf(week, 4)), author: r.author, lang, kind: 'weekly-report' };
      if (week <= CORPUS_WEEKS) w.addDoc(doc, r.text);
      else if (week <= CORPUS_WEEKS + 4) w.addUpdate(String(week - CORPUS_WEEKS).padStart(2, '0'), doc.path, r.text);
      else w.addHoldout(`weeks-49-52/${doc.path}`, r.text);
    }
  }
  // a month's summary comes out with its last week: the months that end inside the corpus
  const allWeeks = Array.from({ length: REPORT_WEEKS }, (_, i) => i + 1);
  const months = [...new Set(allWeeks.map(monthOf))].filter((m) => Math.max(...allWeeks.filter((wk) => monthOf(wk) === m)) <= CORPUS_WEEKS);
  for (const m of months) {
    const p = renderPmo(s, m);
    w.addDoc({ path: pmoPath(m), title: p.title, lang, kind: 'pmo-summary' }, p.text);
  }
  const docOf = (team: string, week: number) => path(s.teams.find((t) => t.id === team)!, week);
  for (const t of reportTasks(s, docOf, pmoPath, (d) => texts.get(d) ?? '')) if (t.evidence.every((e) => w.hasDoc(e.doc))) w.addTask(t);
  for (const pr of attributionProbes(s)) {
    w.addTask({ id: pr.id, suite: 'emergence', type: 'attribution', lang, question: zh ? `下面这段周报（隐去了组名）最可能是谁写的？\n\n${pr.excerpt}` : `Who most likely wrote this weekly report (team name removed)?\n\n${pr.excerpt}`, choices: pr.choices, answer: pr.author, scoring: 'choice' });
  }
  // the update stream: weeks 45–48, a batch each; the latest state after each
  for (let b = 1; b <= 4; b++) {
    const week = CORPUS_WEEKS + b;
    const batch = String(b).padStart(2, '0');
    for (const t of s.teams.slice(0, 2)) {
      const v = t.metric.values[week - 1];
      w.addTask({ id: `upd-metric-${t.id}-${batch}`, suite: 'update', type: 'update', lang, afterUpdate: batch, scoring: 'judge',
        question: zh ? `${t.name}最新一周的${t.metric.name}是多少？` : `What is ${t.name}'s latest weekly ${t.metric.name}?`,
        answer: t.metric.unit === '%' ? `${v}%` : zh ? `${v}万` : `${v}k`, evidence: [{ doc: path(t, week) }] });
    }
    const t3 = s.teams[2];
    w.addTask({ id: `upd-head-${batch}`, suite: 'update', type: 'update', lang, afterUpdate: batch, scoring: 'judge',
      question: zh ? `${t3.name}现在在岗多少人？` : `How many people are on ${t3.name} now?`, answer: zh ? `${rosterOf(s, t3.id, week).length}人` : `${rosterOf(s, t3.id, week).length}`, evidence: [{ doc: path(t3, week) }] });
  }
  // padding: other teams' years, naming nobody and nothing above
  for (const pad of makeReportScript(lang, ctx.seed ?? 0, { padTeams }).padTeams) {
    for (let week = 1; week <= CORPUS_WEEKS; week++) {
      for (const t of pad.teams) {
        const r = renderReport(pad, t, week);
        w.addPadding({ path: `${zh ? '周报' : 'weekly'}/${t.name}/${String(week).padStart(2, '0')}-${iso(dayOf(week))}.md`, title: r.title, date: iso(dayOf(week, 4)), author: r.author, lang, kind: 'weekly-report' }, r.text);
      }
    }
  }
  w.addHoldout('script.json', JSON.stringify({ ...s, padTeams: undefined }, null, 1));
  w.setProfile({ health: Object.fromEntries(s.teams.map((t) => [t.name, t.health])), styles: s.styles });
  ctx.log(`synthetic-reports-${lang}: ${w.docCount} documents, ${w.taskCount} tasks${padTeams ? `, ${padTeams} padding teams` : ''}`);
  return w.finish();
}

export function registerReportRecipes(): void {
  for (const lang of ['zh', 'en'] as const) {
    registerRecipe({
      id: `synthetic-reports-${lang}`,
      title: lang === 'zh' ? 'Synthetic weekly reports (Chinese): a year of three teams, from a hidden script' : 'Synthetic weekly reports (English): a year of three teams, from a hidden script',
      domain: 'synthetic',
      network: false,
      needsAuthor: false,
      padding: 'local',
      build: (dir, ctx) => buildReports(lang, dir, ctx),
    });
  }
}
