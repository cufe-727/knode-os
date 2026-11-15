import { cnNum } from './separation.js';
import {
  corpusMonths, corpusQuarters, customerNameAt, dayOf, fmtMetric, iso, Lang, leadOf, metricActual, metricReported, monthName, ownerAt, progressAt,
  projectNameAt, quarterKey, quarterName, rosterOf, V3_CORPUS, V3_WEEKS, V3Division, V3Incident, V3Person, V3Team, weekName, weeksOfMonth, weeksOfQuarter, ymKey,
} from './reports-v3.js';

/**
 * Rendering recipe v3's script into documents (docs/design/33 §4). Every line
 * that states a fact of the script carries its key ("fix:INC-1104",
 * "sponsor:D1T1-J2"), so tasks find the documents and the exact lines behind
 * each step without a model: a hop's question can be checked for words it
 * shares with those lines, and its evidence is the documents that state them.
 *
 * Kinds: weekly reports (a team, a week), PMO monthly summaries (a division,
 * a month; they correct weekly figures and say that they prevail), quarterly
 * reviews (a team, a quarter: OKR scores, budget execution, project sponsors
 * and mentors are stated here and nowhere else), incident postmortems (a P1:
 * duration, impact and the owner of its follow-up only here) and the
 * division's monthly meeting minutes (budgets approved, a customer's new
 * name, some nicknames).
 */

export type V3Kind = 'weekly-report' | 'pmo-summary' | 'quarterly-review' | 'postmortem' | 'minutes';
export interface V3Line { keys: string[]; text: string }
export interface V3Doc {
  id: string; kind: V3Kind; div: number; team?: string;
  /** The week it is filed in (its date is that week's Friday, a weekly report's its Monday). */
  week: number; period: string; date: string; title: string; author?: string;
  text: string; lines: V3Line[];
}

/* ------------------------------ fast deterministic picks ------------------------------ */

/** FNV-1a: a pick for filler text that leaves the script's own stream alone and costs no SHA per sentence. */
export function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
const hp = <T>(xs: T[], ...key: (string | number)[]) => xs[fnv(key.join('|')) % xs.length];
const fill = (tpl: string, vars: Record<string, string | number>) => tpl.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));

/* -------------------------------------- phrasings -------------------------------------- */

/**
 * Several ways to state each kind of fact. Lines that a hop may step through
 * avoid the words the hops' questions use for them (收拾, 闹, 担子, 投产, 外号,
 * 师傅, 顶, 隐患, 甲方 …; sorted out, outage, client, went live, nickname …).
 */
const PH: Record<Lang, Record<string, string[]>> = {
  zh: {
    start: ['{p}启动，负责人{o}，计划{w}上线', '{p}立项开工，由{o}负责，目标{w}上线'],
    progress: ['{p}完成度{n}%，负责人{o}，计划{w}上线', '{p}：进度{n}%（负责人{o}），目标{w}上线', '{p}推进到{n}%，{o}负责'],
    launch: ['{p}已于本周上线', '{p}本周正式上线', '{p}完成上线'],
    late: ['，已延期{d}周', '，比计划晚{d}周', '，落后计划{d}周'],
    rename: ['（{a}自本周起更名为{b}）', '（原名{a}，本周起改称{b}）'],
    takeover: ['（自本周起由{o}接手）', '（{o}本周起接手）'],
    metric: ['{m}：{v}', '本周{m}为{v}', '{m}本周是{v}'],
    incident: ['{id}（{sev}）{t}{c}', '新增{sev}事故{id}：{t}{c}', '{id}，级别{sev}，{t}{c}'],
    escalated: ['，由客户{x}投诉升级', '，客户{x}投诉后升级', '（{x}投诉升级）'],
    fix: ['{id}复盘：根因是{cause}，由{f}修复', '{id}已修复（{f}），原因：{cause}', '{id}由{f}排查修复，根因是{cause}'],
    riskNew: ['新风险{id}：{t}（{r}提出，负责人{o}）', '{r}提出风险{id}：{t}，由{o}负责', '登记风险{id}（{t}），提出人{r}，负责人{o}'],
    riskClosed: ['{id}已关闭：{res}', '{id}关闭（{res}）', '风险{id}解除：{res}'],
    riskOwner: ['{id}负责人改为{o}', '{id}转由{o}负责', '{o}接手{id}'],
    riskOpen: ['{id}仍未解决（负责人{o}）', '{id}跟进中，负责人{o}', '{id}未关闭，{o}在跟'],
    join: ['{n}加入，任{r}', '{n}入职，岗位{r}', '{n}到岗（{r}）'],
    replace: ['，接替离职的{x}', '，补上{x}离开后的空缺'],
    left: ['{n}本周离职', '{n}已离开公司', '{n}办完离职'],
    out: ['{n}调往{t}', '{n}转岗去了{t}', '{n}调到{t}'],
    in: ['{n}从{t}调入', '{n}由{t}转来', '欢迎{n}从{t}加入'],
    nick: ['{n}本周值班（同组都喊{n}“{k}”）', '本周值班的是{n}，同组都喊{n}“{k}”'],
    headcount: ['在岗{n}人', '目前{n}人', '团队共{n}人'],
    overtime: ['本周有{n}天加班到十点以后', '这周{n}个晚上过了十点才走'],
    intro: ['{name}（{code}，下称“{short}”）定为{v}', '新定{name}：{v}（编号{code}，简称{short}）'],
    change_code: ['{code}调整为{v}', '自本周起{code}改为{v}'],
    change_short: ['{short}从本周起改成{v}', '{short}调整到{v}'],
    correction_code: ['更正：{code}此前写的{old}有误，应为{v}', '{code}撤回原先的{old}，以{v}为准'],
    correction_short: ['{short}之前报错了，正确的是{v}', '{short}的{old}作废，实际是{v}'],
    revert_code: ['{code}恢复为{v}', '{code}改回{v}'],
    revert_short: ['{short}改回{v}', '{short}恢复原值{v}'],
    recapMetric: ['（两周前{m}是{v}）', '回顾：两周前{m}为{v}'],
    recapSetting: ['（{name}最初定的是{v}）', '备注：{name}起初是{v}'],
  },
  en: {
    start: ['{p} kicked off, owner {o}, launch planned for {w}', '{p} started; {o} owns it; target {w}'],
    progress: ['{p} at {n}%, owner {o}, launch planned for {w}', '{p}: {n}% done (owner {o}), targeting {w}', '{p} is {n}% complete; {o} owns it'],
    launch: ['{p} launched this week', '{p} shipped this week', '{p} is out this week'],
    late: [', {d} weeks late', ', {d} weeks behind plan', ', running {d} weeks over'],
    rename: [' ({a} is called {b} from this week)', ' (formerly {a}, renamed {b} from this week)'],
    takeover: [' ({o} takes over from this week)', ' (now with {o})'],
    metric: ['{m}: {v}', '{m} this week: {v}', '{m} came in at {v}'],
    incident: ['{id} ({sev}) {t}{c}', 'new {sev} incident {id}: {t}{c}', '{id}, severity {sev}, {t}{c}'],
    escalated: [', escalated by {x}', ', raised by {x} as a complaint', ' ({x} escalated it)'],
    fix: ['{id} postmortem: caused by {cause}, fixed by {f}', '{id} resolved by {f}; root cause: {cause}', '{id} was fixed by {f}; root cause: {cause}'],
    riskNew: ['new risk {id}: {t} (raised by {r}, owner {o})', '{r} raised risk {id}: {t}; owner {o}', 'risk {id} logged ({t}), raised by {r}, owner {o}'],
    riskClosed: ['{id} closed: {res}', '{id} closed ({res})', 'risk {id} retired: {res}'],
    riskOwner: ['{id} now owned by {o}', '{id} passed to {o}', '{o} takes {id}'],
    riskOpen: ['{id} still open (owner {o})', '{id} in progress, owner {o}', '{id} not closed; {o} on it'],
    join: ['{n} joined as {r}', '{n} started as {r}', '{n} is on board ({r})'],
    replace: [', replacing {x}, who left', ', in place of {x}, who left'],
    left: ['{n} left the company this week', '{n} has left the company', "{n}'s last day was this week"],
    out: ['{n} moved to {t}', '{n} transferred to {t}', '{n} went over to {t}'],
    in: ['{n} joined us from {t}', '{n} transferred in from {t}', 'welcome {n}, over from {t}'],
    nick: ['{n} was on call this week (everyone on the floor calls {n} "{k}")', 'on call this week: {n}, or "{k}" as the floor calls {n}'],
    headcount: ['{n} people on the roster', 'headcount {n}', 'the roster is {n} people'],
    overtime: ['{n} nights past 10 pm this week', 'stayed past 10 pm on {n} nights'],
    intro: ['{name} ({code}, "{short}" below) set to {v}', 'new {name}: {v} (code {code}, short name {short})'],
    change_code: ['{code} changed to {v}', 'from this week {code} is {v}'],
    change_short: ['{short} moves to {v} from this week', '{short} adjusted to {v}'],
    correction_code: ['correction: {code} was reported as {old} by mistake; it is {v}', '{code}: the earlier {old} is withdrawn, {v} stands'],
    correction_short: ['{short} was misreported; the right figure is {v}', '{short}: scrap the {old}, it is actually {v}'],
    revert_code: ['{code} restored to {v}', '{code} back to {v}'],
    revert_short: ['{short} goes back to {v}', '{short} restored to {v}'],
    recapMetric: ['(two weeks ago {m} was {v})', 'recap: {m} two weeks ago: {v}'],
    recapSetting: ['(the {name} was first set at {v})', 'note: the {name} started at {v}'],
  },
};
const say = (lang: Lang, kind: string, key: string, vars: Record<string, string | number>) => fill(hp(PH[lang][kind], kind, key), vars);

/** Everyday work: what fills a weekly report and is gold for nothing. */
const WORK: Record<Lang, { items: string[]; status: string[]; plan: string[]; feedback: string[]; meeting: string[] }> = {
  zh: {
    items: ['完成接口评审', '补充单元测试', '整理监控看板', '优化慢查询', '对接下游团队', '编写技术方案', '处理工单', '本周值守', '参加需求评审', '修复测试环境问题', '更新部署脚本', '梳理告警规则', '做性能压测', '迁移历史数据', '带新人熟悉代码', '清理技术债', '升级依赖库版本', '整理接口文档'],
    status: ['已完成', '进行中', '待评审', '阻塞中，等待依赖方'],
    plan: ['推进{p}联调', '完成{p}的灰度方案', '准备季度复盘材料', '和产品对齐{p}的需求变更', '安排一次应急演练', '整理{p}的上线检查清单'],
    meeting: ['周会讨论了值守轮换，维持现状', '和运维对齐了下季度机器预算', '评审了{p}的接口设计，提了三条修改意见', '同步了公司新的代码评审规范', '讨论是否引入新的日志平台，暂不引入', '回顾了上月的告警噪音，计划减少一半', '和安全团队过了一遍权限清单', '确认了{p}的验收标准'],
    feedback: ['反馈对账报表导出偏慢', '询问新功能的上线时间', '希望增加批量操作', '反馈移动端偶发闪退', '提出接口限流阈值偏低', '表扬了上次问题处理及时'],
  },
  en: {
    items: ['finished the API review', 'added unit tests', 'cleaned up the monitoring dashboard', 'tuned slow queries', 'synced with the downstream team', 'wrote a design doc', 'worked through tickets', 'was on duty', 'joined the requirements review', 'fixed the test environment', 'updated deploy scripts', 'pruned alert rules', 'ran load tests', 'migrated old data', 'onboarded a new hire', 'paid down tech debt', 'bumped library versions', 'tidied the API docs'],
    status: ['done', 'in progress', 'in review', 'blocked on a dependency'],
    plan: ['integration testing for the {p} project', 'a canary plan for {p}', 'quarterly review material', 'aligning with product on {p} project changes', 'a failure drill', 'the {p} launch checklist'],
    meeting: ['weekly sync kept the duty rotation as is', "agreed next quarter's machine budget with ops", 'reviewed the {p} API design: three changes requested', 'went over the new code review guidelines', 'discussed a new logging platform: not now', "reviewed last month's alert noise: aim to halve it", 'walked through access lists with security', 'agreed acceptance criteria for {p}'],
    feedback: ['says the reconciliation export is slow', 'asks when the new feature ships', 'wants bulk actions', 'reports occasional mobile crashes', 'finds the API rate limit too low', 'thanked us for the quick fix last time'],
  },
};

/** Long documents' prose: sentences that name nobody, so a long document is long without planting a shortcut. */
const PROSE: Record<Lang, Record<string, string[]>> = {
  zh: {
    process: ['本季度继续执行双人评审制度，所有变更至少两人确认后才能合入主干。', '发布窗口固定在周二和周四下午，紧急变更需要额外审批。', '值守交接改为书面记录，每次交接写明遗留问题和观察项。', '测试环境与生产环境的配置差异已经整理成清单，按月复核。',
      '需求评审增加了容量评估一栏，新功能上线前必须给出峰值预估。', '回滚预案成为上线检查清单的必填项，演练记录归档到知识库。', '跨组依赖统一登记在依赖看板上，每周例会过一遍阻塞项。', '代码评审的平均等待时间从两天缩短到不到一天。',
      '自动化测试覆盖率稳步提升，核心链路已经全部纳入回归。', '告警分级重新梳理，低优先级告警改为日报汇总。', '文档模板统一后，新人查阅资料的时间明显减少。', '本期对历史工单做了归类，重复问题集中在少数几个模块。'],
    quality: ['线上问题的平均发现时间比上一期缩短，主要得益于监控补齐。', '慢查询数量下降，但个别报表接口仍然偏慢，需要继续跟踪。', '客户侧报告的问题中，有相当一部分是使用方式不当，已补充说明文档。', '灰度发布比例调整为先百分之五、再百分之三十、最后全量。',
      '日志采样策略调整后，存储成本有所下降，排障效率没有受到影响。', '压测在非高峰时段进行，结果与线上流量模型基本吻合。', '接口超时问题多数与下游依赖有关，已与对方约定响应时间目标。', '版本兼容性检查纳入流水线，减少了因依赖升级带来的回归。'],
    people: ['团队整体节奏平稳，加班主要集中在上线前一周。', '新人培养采用一对一带教，每两周做一次进度回顾。', '本期组织了两次内部分享，主题分别是排障方法和容量规划。', '岗位职责做了微调，值守与开发工作尽量错开。',
      '跨组轮岗试点进展顺利，参与者普遍认为对理解全链路有帮助。', '招聘渠道以内推为主，面试流程压缩到两周以内。'],
    plan: ['下一阶段的重点是稳定性和成本，新功能开发适度放缓。', '计划在下季度完成监控体系的统一，减少重复建设。', '准备推动接口规范化，逐步淘汰历史遗留的调用方式。', '将继续压缩发布周期，同时提高自动化回归的覆盖面。',
      '预算方面优先保障核心链路，非核心需求排到后续迭代。', '下季度会安排一次全链路演练，验证应急预案的有效性。'],
    timeline: ['值守收到第一条告警，开始排查', '确认影响范围，拉起应急群', '初步判断与最近一次变更有关', '暂停相关发布，保留现场', '定位到问题模块，准备修复方案', '修复方案评审通过，开始灰度',
      '灰度观察指标恢复正常，逐步放量', '全量恢复，持续观察', '对外同步处理进展', '确认无残留影响，结束应急', '补充监控项，防止再次发生', '整理时间线，准备复盘'],
    lessons: ['变更前的检查清单需要覆盖配置项，而不只是代码。', '告警阈值要随业务量调整，固定阈值容易漏报。', '应急群里应指定一名记录人，事后整理时间线更快。', '对外沟通要有统一口径，避免信息不一致。',
      '依赖方的变更通知需要纳入我们的发布日历。', '演练比文档更能暴露预案里的漏洞。', '回滚不应依赖个人经验，脚本化之后更可靠。', '监控大盘需要区分核心与非核心指标。'],
    agenda: ['讨论了下季度机器资源的分配原则，倾向于按实际用量核算。', '安全团队通报了近期的权限审计结果，整体情况良好。', '财务同步了费用报销流程的调整，下月起执行。', '各组反馈了跨组协作中的摩擦点，约定由例会统一协调。',
      '讨论了值守补贴标准，暂维持不变。', '对年度目标的进度做了回顾，整体符合预期。', '提出建立统一的事故分级口径，会后整理草案。', '同步了公司层面的数据合规要求。'],
  },
  en: {
    process: ['This quarter we kept two-person review: every change needs two approvals before it merges.', 'Release windows stay on Tuesday and Thursday afternoons; urgent changes need an extra sign-off.', 'Duty handovers are now written down, listing open issues and things to watch.', 'Differences between the test and production configuration are kept in a list and checked monthly.',
      'Requirements reviews now include a capacity estimate; every new feature states its expected peak.', 'A rollback plan is a required item of the launch checklist, and drill records go to the wiki.', 'Cross-team dependencies are tracked on one board and walked through at the weekly sync.', 'Average wait for code review dropped from two days to under one.',
      'Automated test coverage keeps rising; every core path is now in the regression suite.', 'Alert levels were reworked; low-priority alerts now roll up into a daily digest.', 'With one documentation template, new hires find what they need much faster.', 'We sorted old tickets this period: repeat issues cluster in a handful of modules.'],
    quality: ['Mean time to detect fell compared with last period, mostly thanks to better monitoring.', 'Slow queries are down, though a few reporting endpoints are still slow and stay on the list.', 'Many issues reported from the field turned out to be usage questions; the docs were extended.', 'Canary steps are now five percent, then thirty percent, then everyone.',
      'After the log sampling change storage costs went down without hurting troubleshooting.', 'Load tests ran off-peak and matched the production traffic model closely.', 'Most timeouts trace back to downstream dependencies; response targets were agreed with them.', 'Compatibility checks are part of the pipeline now, which cut regressions from upgrades.'],
    people: ['The pace has been steady; late nights cluster in the week before a launch.', 'New hires are paired one to one, with a progress check every two weeks.', 'We held two internal talks this period, on troubleshooting and on capacity planning.', 'Duties were adjusted slightly so that on-duty weeks and feature work overlap less.',
      'The cross-team rotation pilot went well; participants said it helped them see the whole flow.', 'Hiring mostly comes through referrals, and interviews now finish within two weeks.'],
    plan: ['Next period the focus is stability and cost; feature work slows down a little.', 'We plan to unify monitoring next quarter and stop building the same thing twice.', 'We will push for consistent interfaces and retire legacy call patterns step by step.', 'Release cycles will keep shrinking while automated regression grows.',
      'Budget goes to the core path first; everything else moves to later iterations.', 'A full end-to-end drill is planned next quarter to test the response plans.'],
    timeline: ['first alert reached the duty engineer; investigation started', 'scope confirmed, response channel opened', 'first suspicion: the latest change', 'related releases paused, state preserved', 'faulty module located, fix being prepared', 'fix reviewed, canary started',
      'canary metrics back to normal, ramping up', 'fully recovered, still watching', 'status shared outside the team', 'no remaining impact; response closed', 'monitoring added so it cannot recur silently', 'timeline written up for the review'],
    lessons: ['Pre-change checklists must cover configuration, not only code.', 'Alert thresholds have to follow traffic; fixed thresholds miss things.', 'Name a scribe in the response channel; the timeline comes together faster.', 'Outside communication needs one voice to avoid mixed messages.',
      "Dependencies' change notices belong on our release calendar.", 'Drills expose gaps in a plan better than documents do.', 'Rollback should not depend on one person remembering; scripts are safer.', 'Dashboards should separate core from non-core metrics.'],
    agenda: ['Discussed how to share out machine capacity next quarter; leaning towards charging actual use.', 'Security reported on the recent access audit; things look good overall.', 'Finance explained the new expense process, starting next month.', 'Teams raised friction points in cross-team work; the monthly meeting will coordinate them.',
      'Discussed the on-duty allowance; it stays as is.', 'Reviewed progress against the yearly goals; broadly on track.', 'Proposed one shared scale for incident severity; a draft will follow.', 'Went over the company-level data compliance rules.'],
  },
};
/** A paragraph of `n` sentences (four times as many in Chinese, whose sentences are short). */
const paragraph = (lang: Lang, topic: string, n: number, ...key: (string | number)[]) =>
  Array.from({ length: lang === 'zh' ? n * 4 : n }, (_, i) => hp(PROSE[lang][topic], topic, ...key, i)).join(lang === 'zh' ? '' : ' ');

/* --------------------------------------- weekly --------------------------------------- */

const SECTIONS = ['progress', 'metric', 'incidents', 'risks', 'config', 'people', 'members', 'meeting', 'feedback', 'recap', 'mood', 'plan'] as const;
type Section = (typeof SECTIONS)[number];
const HEAD: Record<Lang, Record<Section, string>> = {
  zh: { progress: '进展', metric: '指标', incidents: '事故', risks: '风险', config: '配置', people: '人员', mood: '团队', members: '成员动态', meeting: '会议纪要', feedback: '客户反馈', recap: '回顾', plan: '下周计划' },
  en: { progress: 'Progress', metric: 'Metrics', incidents: 'Incidents', risks: 'Risks', config: 'Settings', people: 'People', mood: 'Mood', members: 'Member updates', meeting: 'Meetings', feedback: 'Customer feedback', recap: 'Recap', plan: 'Next week' },
};

export interface RenderCtx { lang: Lang; s: V3Division; teamName: (id: string) => string }

function weeklyFacts(c: RenderCtx, t: V3Team, week: number): Record<Section, V3Line[]> {
  const { lang, s } = c;
  const zh = lang === 'zh';
  const out = Object.fromEntries(SECTIONS.map((k) => [k, [] as V3Line[]])) as Record<Section, V3Line[]>;
  const W = WORK[lang];
  const tw = `${t.id}|${week}`;
  const add = (sec: Section, keys: string[], text: string) => out[sec].push({ keys, text });
  const lead = leadOf(t, week);
  for (const m of rosterOf(s.people, t.id, week).filter((p) => p.name !== lead)) {
    const a = hp(W.items, tw, m.id, 'a');
    const b = hp(W.items, tw, m.id, 'b');
    const ticket = `${zh ? '工单' : 'ticket'} ${t.id}-${1000 + (fnv(`${tw}|${m.id}`) % 9000)}`;
    add('members', [], zh ? `${m.name}：${a}（${hp(W.status, tw, m.id)}）；${b}，${ticket}` : `${m.name}: ${a} (${hp(W.status, tw, m.id)}); ${b}, ${ticket}`);
  }
  const mine = s.projects.filter((p) => p.team === t.id);
  const active = mine.filter((p) => week >= p.start && week < p.launch);
  for (let k = 0; k < 2; k++) {
    const p = active[k % Math.max(1, active.length)];
    add('plan', [], hp(W.plan, tw, 'plan', k).replace('{p}', p ? projectNameAt(p, week) : zh ? '例行工作' : 'routine work'));
  }
  for (let k = 0; k < 2; k++) {
    const p = active[(k + week) % Math.max(1, active.length)];
    add('meeting', [], hp(W.meeting, tw, 'meet', k).replace('{p}', p ? projectNameAt(p, week) : zh ? '例行工作' : 'routine work'));
  }
  if (fnv(`fb|${tw}`) % 10 < 6) {
    const cu = hp(s.customers, tw, 'c');
    add('feedback', [], zh ? `客户${customerNameAt(cu, week)}${hp(W.feedback, tw)}，已记录` : `${customerNameAt(cu, week)} ${hp(W.feedback, tw)}; logged`);
  }
  for (const p of mine) {
    if (week < p.start || week > p.launch) continue;
    const name = projectNameAt(p, week);
    const owner = ownerAt(p, week);
    const n = progressAt(p, week);
    const key = `${p.id}|${week}`;
    const keys = [`prog:${p.id}:${week}`];
    let text: string;
    if (week === p.launch) {
      text = say(lang, 'launch', key, { p: name });
      keys.push(`launch:${p.id}`);
    } else if (week === p.start) {
      text = say(lang, 'start', key, { p: name, o: owner, w: weekName(lang, p.planned) });
      keys.push(`start:${p.id}`);
    } else text = say(lang, 'progress', key, { p: name, n, o: owner, w: weekName(lang, p.planned) });
    if (p.rename && week === p.rename.week) {
      text += say(lang, 'rename', key, { a: p.name, b: p.rename.to });
      keys.push(`rename:${p.id}`);
    }
    if (p.takeover && week === p.takeover.week) {
      text += say(lang, 'takeover', key, { o: p.takeover.to });
      keys.push(`takeover:${p.id}`);
    }
    if (week > p.planned && week < p.launch) text += say(lang, 'late', key, { d: week - p.planned });
    add('progress', keys, text);
  }
  const v = metricReported(s, t.id, week);
  const pv = week > 1 ? metricReported(s, t.id, week - 1) : v;
  add('metric', [`metric:${t.id}:${week}`], say(lang, 'metric', tw, { m: t.metric.name, v: fmtMetric(lang, t, v) }));
  add('metric', [], zh ? `环比${v >= pv ? '+' : ''}${(((v - pv) / (pv || 1)) * 100).toFixed(2)}%` : `${v >= pv ? '+' : ''}${(((v - pv) / (pv || 1)) * 100).toFixed(2)}% week on week`);
  if (t.metric.redefined === week) add('metric', [`redefined:${t.id}`], zh ? '自本周起周活跃用户口径调整：剔除测试账号和机器人账号' : 'from this week weekly active users exclude test and bot accounts');
  for (const i of s.incidents.filter((x) => x.team === t.id && x.week === week)) {
    const cu = i.customer ? s.customers.find((x) => x.id === i.customer)! : undefined;
    const esc = cu ? say(lang, 'escalated', i.id, { x: customerNameAt(cu, week) }) : '';
    add('incidents', [`inc:${i.id}`], say(lang, 'incident', i.id, { id: i.id, sev: i.sev, t: i.title, c: esc }));
  }
  for (const i of s.incidents.filter((x) => x.team === t.id && x.week + 1 === week)) add('incidents', [`fix:${i.id}`], say(lang, 'fix', i.id, { id: i.id, t: i.title, cause: i.cause, f: i.fixer }));
  for (const rk of s.risks.filter((x) => x.team === t.id && x.opened <= week && (!x.closed || x.closed >= week))) {
    const owner = rk.handover && week >= rk.handover.week ? rk.handover.to : rk.owner;
    const key = `${rk.id}|${week}`;
    if (week === rk.opened) add('risks', [`risk:${rk.id}:new`], say(lang, 'riskNew', key, { id: rk.id, t: rk.text, r: rk.raisedBy, o: owner }));
    else if (week === rk.closed) add('risks', [`risk:${rk.id}:closed`], say(lang, 'riskClosed', key, { id: rk.id, res: rk.resolution }));
    else if (rk.handover && week === rk.handover.week) add('risks', [`risk:${rk.id}:owner`], say(lang, 'riskOwner', key, { id: rk.id, o: owner }));
    else add('risks', [`risk:${rk.id}:open:${week}`], say(lang, 'riskOpen', key, { id: rk.id, o: owner }));
  }
  for (const x of s.settings.filter((y) => y.team === t.id)) {
    const val = (n: number) => `${n}${x.unit}`;
    x.history.forEach((h, hi) => {
      if (h.week !== week || h.by !== 'team') return;
      const key = `${x.id}|${hi}`;
      const old = val(x.history[hi - 1]?.value ?? h.value);
      const text = h.how === 'intro' ? say(lang, 'intro', key, { name: x.name, code: x.id, short: x.short, v: val(h.value) }) : say(lang, `${h.how}_${h.via}`, key, { code: x.id, short: x.short, v: val(h.value), old });
      add('config', [`cfg:${x.id}:${hi}`], text);
    });
  }
  for (const p of s.people) {
    if (p.team === t.id && p.joined === week && week > 1) {
      const gone = p.replaces ? s.people.find((x) => x.id === p.replaces)! : undefined;
      add('people', [`join:${p.id}`, ...(gone ? [`replace:${p.id}`] : [])], say(lang, 'join', p.id, { n: p.name, r: p.role }) + (gone ? say(lang, 'replace', p.id, { x: gone.name }) : ''));
    }
    if (p.team === t.id && p.left === week) add('people', [`left:${p.id}`], say(lang, 'left', p.id, { n: p.name }));
    if (p.move && p.move.week === week && p.team === t.id) add('people', [`out:${p.id}`], say(lang, 'out', p.id, { n: p.name, t: c.teamName(p.move.team) }));
    if (p.move && p.move.week === week && p.move.team === t.id) add('people', [`in:${p.id}`], say(lang, 'in', p.id, { n: p.name, t: c.teamName(p.team) }));
    if (p.nick && p.nick.where === 'weekly' && p.nick.week === week && rosterOf(s.people, t.id, week).includes(p)) add('people', [`nick:${p.id}`], say(lang, 'nick', p.id, { n: p.name, k: p.nick.text }));
  }
  t.leadChanges.forEach((lc, i) => {
    if (lc.week === week) add('people', [`lead:${t.id}:${i}`], zh ? `${leadOf(t, week - 1)}卸任，${lc.to}接任组负责人` : `${leadOf(t, week - 1)} steps down; ${lc.to} now leads the team`);
  });
  add('people', [`headcount:${t.id}:${week}`], say(lang, 'headcount', tw, { n: rosterOf(s.people, t.id, week).length }));
  // old values beside the current ones: grep finds both
  if (week > 2 && fnv(`recap|${tw}`) % 2 === 0) add('recap', [], say(lang, 'recapMetric', tw, { m: t.metric.name, v: fmtMetric(lang, t, metricReported(s, t.id, week - 2)) }));
  for (const x of s.settings.filter((y) => y.team === t.id && y.history[0].week < week && !y.history.some((h) => h.week === week))) {
    if (fnv(`recap|${x.id}|${week}`) % 100 < 20) add('recap', [], say(lang, 'recapSetting', `${x.id}|${week}`, { name: x.name, v: `${x.history[0].value}${x.unit}` }));
  }
  if (fnv(`ot|${tw}`) % 7 === 0) add('mood', [], say(lang, 'overtime', tw, { n: 2 + (week % 3) }));
  return out;
}

function renderWeekly(c: RenderCtx, t: V3Team, week: number): V3Doc {
  const { lang, s } = c;
  const zh = lang === 'zh';
  const author = leadOf(t, week);
  const style = s.styles[author] ?? 'terse';
  const f = weeklyFacts(c, t, week);
  const title = zh ? `${t.name}周报 · ${weekName(lang, week)}` : `${t.name} weekly report · ${weekName(lang, week)}`;
  const sections = SECTIONS.filter((k) => f[k].length);
  const lines: V3Line[] = [];
  const L = (text: string, keys: string[] = []) => lines.push({ keys, text });
  L(`# ${title}`);
  L('');
  L(`${iso(dayOf(week))} ~ ${iso(dayOf(week, 4))} · ${author}`);
  L('');
  const hedge = (x: string, i: number) => (zh ? `${['大概', '可能', '初步看'][i % 3]}${x}` : `${['roughly, ', 'probably ', 'at first glance '][i % 3]}${x}`);
  if (style === 'terse') {
    for (const k of sections) {
      L(`**${HEAD[lang][k]}**`);
      for (const l of f[k]) L(`- ${/^(risk|inc|fix|cfg)/.test(l.keys[0] ?? '') ? '⚠️' : '✅'} ${l.text}`, l.keys);
      L('');
    }
  } else if (style === 'narrative') {
    L(zh ? '各位好，' : 'Hi all,');
    L('');
    sections.forEach((k, i) => {
      // one line per fact even in prose: the keyed sentence stays its own line
      L(zh ? `${HEAD.zh[k]}方面：` : `On ${HEAD.en[k].toLowerCase()}:`);
      f[k].forEach((l, j) => L(`${k === 'progress' && j === 0 ? hedge(l.text, week + i) : l.text}${zh ? '。' : '.'}`, l.keys));
      L('');
    });
    L(zh ? '辛苦大家！' : 'Thanks, everyone!');
  } else if (style === 'formal') {
    sections.forEach((k, i) => {
      L(zh ? `## ${cnNum(i + 1)}、${HEAD.zh[k]}` : `## ${i + 1}. ${HEAD.en[k]}`);
      for (const l of f[k]) L(`${l.text}${zh ? '。' : '.'}`, l.keys);
      L('');
    });
    L(zh ? '以上，请审阅。' : 'Submitted for review.');
  } else {
    L(zh ? `**结论**：${f.metric[0].text}` : `**TL;DR**: ${f.metric[0].text}`, f.metric[0].keys);
    L('');
    for (const k of sections) {
      L(`### ${HEAD[lang][k]}`);
      for (const l of f[k]) L(`- ${l.text}`, l.keys);
      L('');
    }
    L(zh ? '如有问题随时找我。' : 'Ping me with questions.');
  }
  return doc({ id: `w|${t.id}|${week}`, kind: 'weekly-report', div: s.index, team: t.id, week, period: weekName(lang, week), date: iso(dayOf(week)), title, author, lines });
}

function doc(d: Omit<V3Doc, 'text'>): V3Doc {
  return { ...d, text: d.lines.map((l) => l.text).join('\n').replace(/\n{3,}/g, '\n\n') + '\n' };
}

/* ------------------------------------- PMO summary ------------------------------------- */

function renderPmo(c: RenderCtx, month: string): V3Doc {
  const { lang, s } = c;
  const zh = lang === 'zh';
  const weeks = weeksOfMonth(month);
  const last = weeks.at(-1)!;
  const [year, mon] = month.split('-').map(Number);
  const title = zh ? `项目管理办公室月报 · ${monthName(lang, year, mon)} · ${s.city}事业部` : `PMO monthly summary · ${monthName(lang, year, mon)} · ${s.city} division`;
  const lines: V3Line[] = [];
  const L = (text: string, keys: string[] = []) => lines.push({ keys, text });
  L(`# ${title}`);
  L('');
  L(zh ? '说明：本月报中的数字经项目管理办公室逐项核对；与各组周报不一致之处，以本月报为准。' : "Note: the PMO checks every figure in this summary; where it differs from a team's weekly report, this summary prevails.", ['precedence']);
  L('');
  for (const t of s.teams) {
    L(`## ${t.name}`);
    L(zh ? `- 月末在岗人数：${rosterOf(s.people, t.id, last).length}人` : `- Headcount at month end: ${rosterOf(s.people, t.id, last).length}`, [`pmo:head:${t.id}:${month}`]);
    for (const p of s.projects.filter((x) => x.team === t.id && x.start <= last && x.launch >= weeks[0])) {
      const n = progressAt(p, last);
      L(zh ? `- ${projectNameAt(p, last)}：月末完成度${n}%${p.launch <= last ? '（已上线）' : ''}` : `- ${projectNameAt(p, last)}: ${n}% at month end${p.launch <= last ? ' (launched)' : ''}`, [`pmo:prog:${p.id}:${month}`]);
    }
    for (const i of s.incidents.filter((x) => x.team === t.id && weeks.includes(x.week))) L(zh ? `- 事故${i.id}：${i.sev}` : `- Incident ${i.id}: ${i.sev}`, [`pmo:inc:${i.id}`]);
    for (const f of s.metricFixes.filter((x) => x.team === t.id && weeks.includes(x.week))) {
      L(zh ? `- 更正：${t.name}${weekName(lang, f.week)}周报所报${t.metric.name}${fmtMetric(lang, t, f.reported)}有误，经核实为${fmtMetric(lang, t, f.actual)}，以本月报为准`
        : `- Correction: ${t.name}'s report for ${weekName(lang, f.week)} gave ${t.metric.name} as ${fmtMetric(lang, t, f.reported)}; the checked figure is ${fmtMetric(lang, t, f.actual)}, and this summary prevails`, [`pmo:metric:${t.id}:${f.week}`]);
    }
    for (const x of s.settings.filter((y) => y.team === t.id)) {
      x.history.forEach((h, hi) => {
        if (h.by !== 'pmo' || !weeks.includes(h.week)) return;
        const prev = x.history[hi - 1];
        L(zh ? `- 更正：${t.name}${weekName(lang, prev.week)}周报中${x.id}（${x.short}）的${prev.value}${x.unit}有误，经核实实际执行值为${h.value}${x.unit}，以本月报为准`
          : `- Correction: ${t.name}'s report for ${weekName(lang, prev.week)} gave ${x.id} (${x.short}) as ${prev.value}${x.unit}; the value actually in force is ${h.value}${x.unit}, and this summary prevails`, [`pmo:cfg:${x.id}:${hi}`]);
      });
    }
    L('');
  }
  return doc({ id: `pmo|${s.index}|${month}`, kind: 'pmo-summary', div: s.index, week: last, period: month, date: iso(dayOf(last, 4)), title, lines });
}

/* ------------------------------------ quarterly review ------------------------------------ */

function renderQuarterly(c: RenderCtx, t: V3Team, quarter: string): V3Doc {
  const { lang, s } = c;
  const zh = lang === 'zh';
  const weeks = weeksOfQuarter(quarter);
  const last = weeks.at(-1)!;
  const [year, qn] = [Number(quarter.slice(0, 4)), Number(quarter.slice(-1))];
  const author = leadOf(t, last);
  const title = zh ? `${t.name}季度复盘 · ${quarterName(lang, year, qn)}` : `${t.name} quarterly review · ${quarterName(lang, year, qn)}`;
  const lines: V3Line[] = [];
  const L = (text: string, keys: string[] = []) => lines.push({ keys, text });
  const P = (topic: string, n: number, k: string | number) => L(paragraph(lang, topic, n, t.id, quarter, k));
  const incs = s.incidents.filter((i) => i.team === t.id && weeks.includes(i.week));
  const launched = s.projects.filter((p) => p.team === t.id && weeks.includes(p.launch));
  const joined = s.people.filter((p) => p.team === t.id && weeks.includes(p.joined) && p.joined > 1);
  const left = s.people.filter((p) => p.team === t.id && p.left && weeks.includes(p.left));
  const o = s.okr[t.id][quarter];
  L(`# ${title}`);
  L('');
  L(`${iso(dayOf(weeks[0]))} ~ ${iso(dayOf(last, 4))} · ${author}`);
  L('');
  L(zh ? '## 一、季度概览' : '## 1. The quarter at a glance');
  L(zh ? `本季度共报告事故${incs.length}起，其中最高级别${incs.filter((i) => i.sev === 'P1').length}起；${launched.length}个项目上线；${joined.length}人加入，${left.length}人离开。` : `This quarter the team reported ${incs.length} incidents, ${incs.filter((i) => i.sev === 'P1').length} of them at the top severity; ${launched.length} launches; ${joined.length} joined and ${left.length} left.`, [`qr:summary:${t.id}:${quarter}`]);
  P('process', 5, 'a');
  L('');
  L(zh ? '## 二、目标与预算' : '## 2. Goals and budget');
  L(zh ? `本季度OKR完成度为${o.score}。` : `OKR attainment this quarter: ${o.score}.`, [`okr:${t.id}:${quarter}`]);
  L(zh ? `季度预算执行率为${o.budget}%。` : `Budget execution for the quarter: ${o.budget}%.`, [`budget:${t.id}:${quarter}`]);
  P('plan', 3, 'b');
  L('');
  L(zh ? '## 三、指标周表（经项目管理办公室核对）' : '## 3. Weekly figures (as checked by the PMO)');
  L(zh ? `| 周 | ${t.metric.name} | 在岗人数 |` : `| Week | ${t.metric.name} | Headcount |`);
  L('| --- | --- | --- |');
  for (const w of weeks.filter((x) => x <= V3_CORPUS)) L(`| ${weekName(lang, w)} | ${fmtMetric(lang, t, metricActual(s, t.id, w))} | ${rosterOf(s.people, t.id, w).length} |`, [`qr:metric:${t.id}:${w}`]);
  L('');
  L(zh ? '## 四、项目' : '## 4. Projects');
  for (const p of s.projects.filter((x) => x.team === t.id && x.start <= last && x.launch >= weeks[0])) {
    const cu = s.customers.find((x) => x.id === p.sponsor)!;
    L(zh ? `${projectNameAt(p, last)}（需求方：${customerNameAt(cu, last)}）：季末完成度${progressAt(p, last)}%。` : `${projectNameAt(p, last)} (requested by ${customerNameAt(cu, last)}): ${progressAt(p, last)}% at quarter end.`, [`sponsor:${p.id}`]);
    P('quality', 2, p.id);
  }
  L('');
  L(zh ? '## 五、事故回顾' : '## 5. Incidents');
  for (const i of incs) {
    L(zh ? `${iso(dayOf(i.week))}那周的${i.title}，定级${i.sev}，已处理完毕。` : `${i.title} in the week of ${iso(dayOf(i.week))}, rated ${i.sev}, has been dealt with.`, [`qr:inc:${i.id}`]);
  }
  P('quality', 4, 'c');
  L('');
  L(zh ? '## 六、人员' : '## 6. People');
  for (const p of joined) {
    const m = s.people.find((x) => x.id === p.mentor);
    const mentor = m ? (m.nick && m.nick.week < last ? m.nick.text : m.name) : undefined;
    L(zh ? `${p.name}本季度入职${mentor ? `，由${mentor}带教` : ''}。` : `${p.name} joined this quarter${mentor ? `, mentored by ${mentor}` : ''}.`, mentor ? [`mentor:${p.id}`] : []);
  }
  for (const p of left) L(zh ? `${p.name}本季度离开。` : `${p.name} left this quarter.`);
  for (const p of s.people.filter((x) => x.move && weeks.includes(x.move.week) && (x.team === t.id || x.move.team === t.id))) {
    L(zh ? `${p.name}${p.team === t.id ? `调去了${c.teamName(p.move!.team)}` : `从${c.teamName(p.team)}调来`}。` : `${p.name} ${p.team === t.id ? `moved to ${c.teamName(p.move!.team)}` : `came over from ${c.teamName(p.team)}`}.`, [`qr:move:${p.id}`]);
  }
  P('people', 4, 'd');
  L('');
  L(zh ? '## 七、下季度计划' : '## 7. Next quarter');
  P('plan', 4, 'e');
  P('process', 6, 'f');
  L('');
  L(zh ? '## 八、逐周回顾' : '## 8. Week by week');
  for (const w of weeks.filter((x) => x <= V3_CORPUS)) {
    const wi = s.incidents.filter((i) => i.team === t.id && i.week === w);
    const wl = s.projects.filter((p) => p.team === t.id && p.launch === w);
    L(zh ? `${weekName(lang, w)}：${t.metric.name}${fmtMetric(lang, t, metricActual(s, t.id, w))}，在岗${rosterOf(s.people, t.id, w).length}人${wi.length ? `，新出${wi.map((i) => `${i.sev}级的${i.title}`).join('、')}` : '，没有新事故'}${wl.length ? `，${wl.map((p) => projectNameAt(p, w)).join('、')}上线` : ''}。${paragraph(lang, 'quality', 1, t.id, w)}`
      : `${weekName(lang, w)}: ${t.metric.name} ${fmtMetric(lang, t, metricActual(s, t.id, w))}, ${rosterOf(s.people, t.id, w).length} on the roster${wi.length ? `, new: ${wi.map((i) => `a ${i.sev} ${i.title}`).join(', ')}` : ', no new incidents'}${wl.length ? `, ${wl.map((p) => projectNameAt(p, w)).join(', ')} launched` : ''}. ${paragraph(lang, 'quality', 1, t.id, w)}`, [`qr:week:${t.id}:${w}`]);
  }
  L('');
  L(zh ? '## 九、附：讨论纪要' : '## 9. Appendix: discussion notes');
  // some reviews run long: four to fourteen paragraphs of notes
  for (let k = 0; k < 4 + (fnv(`${t.id}|${quarter}|len`) % 11); k++) P(['process', 'quality', 'people', 'plan'][k % 4], 5, `g${k}`);
  return doc({ id: `qr|${t.id}|${quarter}`, kind: 'quarterly-review', div: s.index, team: t.id, week: last, period: quarter, date: iso(dayOf(last, 4)), title, author, lines });
}

/* --------------------------------------- postmortem --------------------------------------- */

const DETECTED: Record<Lang, string[]> = { zh: ['监控告警', '客户反馈', '值守巡检'], en: ['monitoring alerts', 'a customer report', 'a routine duty check'] };
const ACTIONS: Record<Lang, string[]> = {
  zh: ['补齐相关监控项', '把配置检查加入发布流水线', '为关键接口增加熔断', '整理并演练回滚脚本', '扩容并设置容量预警', '与依赖方约定响应时间目标', '补充边界条件的自动化测试', '修订值守手册'],
  en: ['add the missing monitors', 'put a config check into the release pipeline', 'add circuit breakers to the key endpoints', 'write and drill the rollback script', 'add capacity and a capacity alert', 'agree response targets with the dependency', 'add automated tests for the edge cases', 'revise the duty handbook'],
};

function renderPostmortem(c: RenderCtx, i: V3Incident): V3Doc {
  const { lang, s } = c;
  const zh = lang === 'zh';
  const week = i.week + 2;
  const t = s.teams.find((x) => x.id === i.team)!;
  const title = zh ? `事故复盘报告：${i.id} ${i.title}` : `Incident postmortem: ${i.id} ${i.title}`;
  const lines: V3Line[] = [];
  const L = (text: string, keys: string[] = []) => lines.push({ keys, text });
  const P = (topic: string, n: number, k: string | number) => L(paragraph(lang, topic, n, i.id, k));
  const cu = i.customer ? s.customers.find((x) => x.id === i.customer)! : undefined;
  const owner = s.people.find((p) => p.name === i.actionOwner && (p.team === i.team || p.move?.team === i.team))!;
  const ownerName = owner.nick && owner.nick.week < week ? owner.nick.text : owner.name;
  L(`# ${title}`);
  L('');
  L(`${t.name} · ${iso(dayOf(week, 4))}`);
  L('');
  L(zh ? '## 概要' : '## Summary');
  L(zh ? `${iso(dayOf(i.week))}那周发生的${i.title}，定级P1。${cu ? `最先反映问题的是客户${customerNameAt(cu, i.week)}。` : ''}` : `The ${i.title} in the week of ${iso(dayOf(i.week))}, rated P1.${cu ? ` ${customerNameAt(cu, i.week)} reported it first.` : ''}`, cu ? [`pm:${i.id}:customer`] : []);
  L(zh ? `最先由${DETECTED.zh[i.detected!]}发现。` : `First noticed through ${DETECTED.en[i.detected!]}.`, [`pm:${i.id}:detected`]);
  L('');
  L(zh ? '## 影响' : '## Impact');
  L(zh ? `影响时长：${i.minutes}分钟。` : `Duration of impact: ${i.minutes} minutes.`, [`pm:${i.id}:minutes`]);
  L(zh ? `受影响请求约${i.affected}笔。` : `About ${i.affected} requests were affected.`, [`pm:${i.id}:affected`]);
  P('quality', 3, 'impact');
  L('');
  L(zh ? '## 时间线' : '## Timeline');
  const base = 9 * 60 + (fnv(i.id) % 300);
  const steps = 12 + (fnv(`${i.id}|n`) % 8);
  for (let k = 0; k < steps; k++) {
    const m = base + Math.round((k * (i.minutes ?? 60)) / steps);
    L(`- ${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')} ${hp(PROSE[lang].timeline, i.id, 'tl', k)}`);
  }
  L('');
  L(zh ? '## 根因' : '## Root cause');
  L(zh ? `根因：${i.cause}。` : `Root cause: ${i.cause}.`, [`pm:${i.id}:cause`]);
  P('quality', 5, 'cause');
  P('process', 4, 'cause2');
  L('');
  L(zh ? '## 处理' : '## Response');
  L(zh ? `由${i.fixer}定位并完成修复。` : `${i.fixer} found the fault and fixed it.`, [`pm:${i.id}:fixer`]);
  P('process', 4, 'resp');
  L('');
  L(zh ? '## 整改项' : '## Follow-up actions');
  L(zh ? `整改总负责人：${ownerName}。` : `Overall owner of the follow-up actions: ${ownerName}.`, [`pm:${i.id}:owner`]);
  const n = 4 + (fnv(`${i.id}|a`) % 3);
  for (let k = 0; k < n; k++) L(zh ? `${k + 1}. ${hp(ACTIONS.zh, i.id, 'act', k)}，${['两周内', '本月内', '下季度前'][k % 3]}完成。` : `${k + 1}. ${hp(ACTIONS.en, i.id, 'act', k)}, ${['within two weeks', 'this month', 'before next quarter'][k % 3]}.`);
  L('');
  L(zh ? '## 经验教训' : '## Lessons');
  for (let k = 0; k < 4; k++) P('lessons', 4, `l${k}`);
  L('');
  L(zh ? '## 附：讨论记录' : '## Appendix: discussion');
  for (let k = 0; k < 4; k++) P(['quality', 'process', 'lessons'][k % 3], 5, `x${k}`);
  return doc({ id: `pm|${i.id}`, kind: 'postmortem', div: s.index, team: i.team, week, period: ymKey(week), date: iso(dayOf(week, 4)), title, author: leadOf(t, week), lines });
}

/* ----------------------------------------- minutes ----------------------------------------- */

function renderMinutes(c: RenderCtx, month: string): V3Doc {
  const { lang, s } = c;
  const zh = lang === 'zh';
  const weeks = weeksOfMonth(month);
  const last = weeks.at(-1)!;
  const [year, mon] = month.split('-').map(Number);
  const title = zh ? `${s.city}经营例会纪要 · ${monthName(lang, year, mon)}` : `${s.city} monthly operations meeting · ${monthName(lang, year, mon)}`;
  const lines: V3Line[] = [];
  const L = (text: string, keys: string[] = []) => lines.push({ keys, text });
  const P = (topic: string, n: number, k: string | number) => L(paragraph(lang, topic, n, s.index, month, k));
  L(`# ${title}`);
  L('');
  L(zh ? `时间：${iso(dayOf(last, 3))}` : `Date: ${iso(dayOf(last, 3))}`);
  L(zh ? `参会：${s.teams.map((t) => leadOf(t, last)).join('、')}，项目管理办公室` : `Present: ${s.teams.map((t) => leadOf(t, last)).join(', ')}, the PMO`);
  L('');
  L(zh ? '## 一、各组情况' : '## 1. Team updates');
  for (const t of s.teams) {
    const incs = s.incidents.filter((i) => i.team === t.id && weeks.includes(i.week));
    const launched = s.projects.filter((p) => p.team === t.id && weeks.includes(p.launch));
    L(zh ? `${t.name}：本月${incs.length}起事故，${launched.length ? `${launched.map((p) => projectNameAt(p, last)).join('、')}上线` : '无上线'}。` : `${t.name}: ${incs.length} incidents this month; ${launched.length ? `${launched.map((p) => projectNameAt(p, last)).join(', ')} launched` : 'no launches'}.`, [`mn:team:${t.id}:${month}`]);
    P(['process', 'quality', 'people'][t.kind], 5, t.id);
  }
  L('');
  L(zh ? '## 二、预算' : '## 2. Budget');
  const budgets = s.projects.filter((p) => p.budget?.month === month);
  for (const p of budgets) L(zh ? `同意为${projectNameAt(p, last)}拨付预算${p.budget!.amount}万元。` : `Approved a budget of ${p.budget!.amount}k for ${projectNameAt(p, last)}.`, [`budget:${p.id}`]);
  if (!budgets.length) L(zh ? '本月无新增预算审批。' : 'No new budget approvals this month.');
  P('plan', 3, 'budget');
  L('');
  L(zh ? '## 三、客户与对外' : '## 3. Customers');
  for (const cu of s.customers.filter((x) => x.rename && weeks.includes(x.rename.week))) {
    L(zh ? `客户${cu.name}自本月起更名为${cu.rename!.to}，此后材料一律使用新名称。` : `${cu.name} renamed itself ${cu.rename!.to} this month; from now on documents use the new name.`, [`crename:${cu.id}`]);
  }
  const escalated = s.incidents.filter((i) => i.customer && weeks.includes(i.week));
  L(zh ? `本月客户投诉升级${escalated.length}次，详见各组周报。` : `${escalated.length} customer escalations this month; see the weekly reports.`);
  L('');
  L(zh ? '## 四、其他议题' : '## 4. Other business');
  for (const p of s.people.filter((x) => x.nick?.where === 'minutes' && weeks.includes(x.nick.week) && !(x.left && x.left <= last))) {
    L(zh ? `${p.name}（同组都喊${p.name}“${p.nick!.text}”）汇报了值守情况。` : `${p.name} (everyone on the floor calls ${p.name} "${p.nick!.text}") reported on duty coverage.`, [`nick:${p.id}`]);
  }
  for (let k = 0; k < 5; k++) L(hp(PROSE[lang].agenda, s.index, month, 'ag', k));
  L('');
  L(zh ? '## 五、待办' : '## 5. Actions');
  const nicked = s.people.filter((p) => p.nick && p.nick.week < weeks[0] && rosterOf(s.people, p.move && p.move.week <= last ? p.move.team : p.team, last).includes(p));
  for (let k = 0; k < 4; k++) {
    const who = nicked.length ? hp(nicked, month, 'who', k).nick!.text : zh ? '各组负责人' : 'each lead';
    L(zh ? `${k + 1}. ${hp(ACTIONS.zh, month, 'mact', k)}，由${who}跟进。` : `${k + 1}. ${hp(ACTIONS.en, month, 'mact', k)}; ${who} follows up.`);
  }
  L('');
  L(zh ? '## 六、讨论记录' : '## 6. Discussion notes');
  for (let k = 0; k < 8 + (fnv(`${s.index}|${month}|len`) % 6); k++) P(['process', 'quality', 'plan', 'people'][k % 4], 5, `d${k}`);
  return doc({ id: `mn|${s.index}|${month}`, kind: 'minutes', div: s.index, week: last, period: month, date: iso(dayOf(last, 3)), title, lines });
}

/* ----------------------------------------- a division ----------------------------------------- */

/** Every document of a division: weekly reports for all 130 weeks (corpus, updates, holdout), the rest for the corpus. */
export function renderDivision(lang: Lang, s: V3Division, teamName: (id: string) => string): V3Doc[] {
  const c: RenderCtx = { lang, s, teamName };
  const out: V3Doc[] = [];
  for (let week = 1; week <= V3_WEEKS; week++) for (const t of s.teams) out.push(renderWeekly(c, t, week));
  for (const m of corpusMonths()) out.push(renderPmo(c, m), renderMinutes(c, m));
  for (const q of corpusQuarters()) for (const t of s.teams) out.push(renderQuarterly(c, t, q));
  for (const i of s.incidents.filter((x) => x.sev === 'P1' && x.week + 2 <= V3_CORPUS)) out.push(renderPostmortem(c, i));
  return out;
}

/** Where each keyed fact is stated: key → the documents and lines. */
export function factIndex(docs: V3Doc[]): Map<string, { doc: string; text: string }[]> {
  const idx = new Map<string, { doc: string; text: string }[]>();
  for (const d of docs) for (const l of d.lines) for (const k of l.keys) (idx.get(k) ?? idx.set(k, []).get(k)!).push({ doc: d.id, text: l.text });
  return idx;
}

