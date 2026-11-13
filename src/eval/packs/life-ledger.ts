import type { GoldAlias, GoldItem, ListSpec, Task } from '../types.js';
import { CORPUS_TASK_MIN_DOCS, DEEP_HOP_MIN, STRUCTURED_MIN_DOCS } from '../types.js';
import { crossLingualOf, exactSetSpec, paraphraseOf } from './separation.js';

/**
 * The ledger of a synthetic life (docs/design/23 §2.1): what the person does
 * week after week — runs with their distances, the mother's blood pressure,
 * meals out, purchases, trips home, book-club meetings, job milestones — plus
 * statements that disagree (which knee hurts, how big the team is, which day
 * the book club meets, where the partner is from), chains of three or four
 * facts whose bridges sit in different documents, and a stream of update
 * batches that change what was true. Every event is planted with an exact
 * phrase in a document of its own, so the corpus-level gold — every item of
 * an aggregate, a timeline's order, each side of a contradiction, everything
 * said about a person — follows from the script without a model.
 */

export type Lang = 'zh' | 'en';
export type Role = 'mother' | 'sibling' | 'friend' | 'runner' | 'manager' | 'partner';
export type Category = 'job' | 'race' | 'home' | 'health' | 'run' | 'bp' | 'med' | 'meal' | 'purchase' | 'trip' | 'book' | 'claim' | 'hop' | 'date';

export interface Person {
  name: string;
  nick?: string;
  role: string;
}

export interface Cast {
  me: Person;
  mother: Person;
  sibling: Person;
  friend: Person;
  runner: Person;
  manager: Person;
  partner: Person;
  oldCo: string;
  newCo: string;
  newCoShort: string;
  jobRole: string;
  tech: string;
  city: string;
  hometown: string;
  area: string;
  rent: number;
  salary: number;
  condition: string;
  race: string;
  km: number;
  commute: number;
}

export interface ScriptEvent {
  id: string;
  week: number;
  date: string;
  docType: 'chat' | 'email' | 'diary';
  with?: string;
  /** What happens, for the renderer. */
  brief: string;
  /** A span the rendered document must contain verbatim. */
  phrase: string;
  /** The gold fact it plants. */
  fact: string;
  question?: string;
  answer?: string;
  short?: boolean;
  entities: string[];
  stress: number;
  joy: number;
  /** Ledger annotations: what kind of event, whom it is about, the key a list matches it by. */
  cat?: Category;
  subjects?: Role[];
  item?: { label: string; aliases?: string[] };
  value?: number;
  /** A disagreement's topic and the side this statement takes. */
  topic?: string;
  side?: string;
  chain?: { id: string; hop: number };
  /** Runs: with the runner. */
  together?: boolean;
  /** Runs: the weekend long run. */
  long?: boolean;
  /** Blood pressure: told in person on a trip home. */
  atHome?: boolean;
}

export interface UpdateDoc {
  path: string;
  text: string;
}

export interface UpdateBatch {
  batch: string;
  date: string;
  docs: UpdateDoc[];
  /** Questions about the latest state once this batch (and every one before it) is applied. */
  tasks: { id: string; question: string; answer: string; doc: string; quote?: string; short?: boolean; stale?: string[] }[];
}

export interface LedgerContext {
  lang: Lang;
  cast: Cast;
  start: Date;
  D: (week: number, day: number) => Date;
  fmt: (d: Date) => string;
  iso: (d: Date) => string;
  one: <T>(xs: T[]) => T;
  r: () => number;
}

/** Names the chains and claims bring in, beyond the cast. */
export interface Extras {
  physio: string;
  clinic: string;
  street: string;
  organizer: string;
  shop: string;
  owner: string;
  prevCo: string;
  founder: string;
  partnerSister: string;
  hospital: string;
  partnerTown: string;
  partnerTownWrong: string;
  med1: string;
  med2: string;
  half: string;
}

const EXTRA_POOLS: Record<Lang, Record<Exclude<keyof Extras, 'partnerSister' | 'partnerTownWrong'>, string[]>> = {
  zh: {
    physio: ['王立', '李澄', '赵屿'], clinic: ['康复源诊所', '仁和理疗中心', '安心运动医学诊所'], street: ['长乐路', '文昌路', '建设路'],
    organizer: ['苏禾', '林木', '白露'], shop: ['慢书房', '半山书局', '见山书店'], owner: ['陆远', '郑川', '何默'],
    prevCo: ['云帆科技', '青石数据', '极光网络'], founder: ['顾明', '邵峰', '程航'], hospital: ['市立医院', '第二人民医院', '仁济医院'],
    partnerTown: ['宁波', '温州', '扬州'], med1: ['氨氯地平'], med2: ['缬沙坦'], half: ['半程马拉松'],
  },
  en: {
    physio: ['Dr. Anand', 'Dr. Weiss', 'Dr. Okafor'], clinic: ['Riverside Physio', 'Northgate Sports Clinic', 'Cedar Rehab Center'], street: ['Alder Street', 'Lincoln Avenue', 'Mill Road'],
    organizer: ['Hana Ito', 'Felix Moore', 'June Sato'], shop: ['Paper Lantern Books', 'Second Story Books', 'Wren & Co. Books'], owner: ['Marcus Bell', 'Ines Duarte', 'Owen Pike'],
    prevCo: ['Cloudsail Tech', 'Bluestone Data', 'Aurora Networks'], founder: ['Victor Hale', 'Nadia Cole', 'Simon Reyes'], hospital: ['Mercy General', "St. Luke's Hospital", 'Valley Medical Center'],
    partnerTown: ['Savannah', 'Tucson', 'Duluth'], med1: ['amlodipine'], med2: ['valsartan'], half: ['the half marathon'],
  },
};

const RESTAURANTS: Record<Lang, string[]> = {
  zh: ['南门涮肉', '松鹤楼', '外婆家', '绿茶餐厅', '老盛昌', '新白鹿', '望湘园', '西贝莜面村', '小龙坎'],
  en: ['Blue Door Bistro', 'Tasty Noodle House', 'Harbor Grill', 'Golden Dumpling', 'Little Olive', 'Maple Diner', 'Saffron Table', 'Green Leaf Cafe', 'Iron Skillet'],
};

const BOOKS: Record<Lang, string[]> = {
  zh: ['活着', '百年孤独', '人类简史', '平凡的世界', '额尔古纳河右岸', '长安的荔枝'],
  en: ['Pachinko', 'Educated', 'The Overstory', 'Klara and the Sun', 'Station Eleven', 'The Remains of the Day'],
};

/** Purchases: item, price (yuan / dollars), week, day, bought with the sibling for the mother. */
const PURCHASES: Record<Lang, [string, number, number, number, boolean][]> = {
  zh: [['跑鞋', 899, 1, 4, false], ['运动手表', 1999, 2, 1, false], ['血压计', 329, 4, 0, true], ['窗帘', 650, 5, 0, false], ['沙发', 2600, 6, 6, false], ['空气炸锅', 459, 7, 1, false], ['筋膜枪', 499, 8, 1, false]],
  en: [['running shoes', 130, 1, 4, false], ['GPS watch', 299, 2, 1, false], ['blood pressure monitor', 49, 4, 0, true], ['curtains', 95, 5, 0, false], ['sofa', 380, 6, 6, false], ['air fryer', 69, 7, 1, false], ['massage gun', 79, 8, 1, false]],
};

/** A cast member as a list item: the name a list would give, and the other ways the sources write it. */
export function personKey(c: Cast, role: Role, lang: Lang): { label: string; aliases: string[] } {
  const p = c[role];
  if (role === 'sibling') {
    const bare = lang === 'zh' ? p.name.replace(/^(哥哥|姐姐|弟弟|妹妹)/, '') : p.name.replace(/^(her|his) (brother|sister) /, '');
    const rel = lang === 'zh' ? p.name.slice(0, 2) : p.name.match(/(brother|sister)/)?.[1] ?? '';
    return { label: bare, aliases: [p.name, rel].filter((x) => x && x !== bare) };
  }
  if (role === 'runner') {
    const bare = lang === 'zh' ? p.name.replace(/^(跑团的|跑友)/, '') : p.name.replace(/ from the .*$/, '');
    return { label: bare, aliases: [p.name].filter((x) => x !== bare) };
  }
  if (role === 'mother') return { label: p.name, aliases: lang === 'zh' ? ['母亲', '妈'] : ['mother', 'Mum'] };
  return { label: p.name, aliases: p.nick ? [p.nick] : [] };
}

export function makeExtras(c: LedgerContext): Extras {
  const P = EXTRA_POOLS[c.lang];
  const partnerTown = c.one(P.partnerTown);
  return {
    physio: c.one(P.physio), clinic: c.one(P.clinic), street: c.one(P.street), organizer: c.one(P.organizer), shop: c.one(P.shop), owner: c.one(P.owner),
    prevCo: c.one(P.prevCo), founder: c.one(P.founder), hospital: c.one(P.hospital),
    partnerSister: c.lang === 'zh' ? `${c.cast.partner.name[0]}${c.one(['晴', '琳', '岚'])}` : c.one(['Clara', 'Maeve', 'Tessa']),
    partnerTown, partnerTownWrong: P.partnerTown.find((t) => t !== partnerTown)!,
    med1: P.med1[0], med2: P.med2[0], half: P.half[0],
  };
}

/* --------------------------------- events --------------------------------- */

/** Weekday run km by week (no run: null), the weekend run and whether it is a trip weekend. */
const WEEKDAY_KM = [5, 6, 7, 6, 8, 7, 6, null, null, 5, 6, 7];
const WEEKEND: ({ km: number; runner: boolean; day: number } | null)[] = [
  { km: 10, runner: true, day: 5 }, { km: 13, runner: true, day: 5 }, { km: 16, runner: false, day: 5 }, { km: 18, runner: true, day: 6 },
  { km: 20, runner: false, day: 5 }, { km: 22, runner: true, day: 5 }, null /* week 7: the script's long run */, null /* week 8: the knee rests */,
  { km: 8, runner: true, day: 5 }, { km: 12, runner: false, day: 5 }, { km: 15, runner: true, day: 5 }, { km: 18, runner: false, day: 5 },
];
export const TRIP_WEEKS = [3, 5, 8, 10, 12];
const BP: [number, number][] = [[152, 96], [149, 95], [147, 94], [150, 96], [144, 92], [141, 90], [138, 88], [136, 87], [134, 85], [132, 84]];

export function ledgerEvents(c: LedgerContext, x: Extras): ScriptEvent[] {
  const { cast: k, D, fmt, iso, lang } = c;
  const zh = lang === 'zh';
  const me = k.me.name;
  const out: ScriptEvent[] = [];
  let n = 0;
  const add = (e: Omit<ScriptEvent, 'id' | 'date' | 'stress' | 'joy' | 'entities' | 'week'> & { at: [number, number]; entities?: string[] }) => {
    const { at, ...rest } = e;
    const [week, d] = at;
    out.push({ stress: 0, joy: 0, entities: [me], ...rest, week, id: `L${String(++n).padStart(3, '0')}-${e.cat}`, date: iso(D(week, d)) });
  };
  const runnerKey = personKey(k, 'runner', lang);

  // runs: a weekday run most weeks, a weekend run that grows to the long run, rest after the knee goes
  for (let w = 1; w <= 12; w++) {
    const wd = WEEKDAY_KM[w - 1];
    if (wd !== null) {
      const km = wd + (c.r() < 0.5 ? 0 : 1);
      add({ at: [w, 2], cat: 'run', docType: 'diary', value: km, item: { label: zh ? `${km}公里` : `${km} km`, aliases: [`${km}km`] },
        brief: zh ? `下班后一个人跑了${km}公里。` : `An evening run alone: ${km} km.`, phrase: zh ? `跑了${km}公里` : `ran ${km} km`,
        fact: zh ? `${me}在${fmt(D(w, 2))}下班后跑了${km}公里。` : `${me} ran ${km} km after work on ${fmt(D(w, 2))}.` });
    }
    const we = WEEKEND[w - 1];
    if (we) {
      const home = TRIP_WEEKS.includes(w);
      add({ at: [w, we.day], cat: 'run', long: true, together: we.runner, docType: we.runner ? 'chat' : 'diary', with: we.runner ? k.runner.name : undefined, value: we.km,
        subjects: we.runner ? ['runner'] : [], item: { label: zh ? `${we.km}公里` : `${we.km} km`, aliases: [`${we.km}km`] },
        brief: zh ? `周末长距离：${we.runner ? `和${k.runner.name}一起` : home ? `在${k.hometown}老家附近一个人` : '一个人'}跑了${we.km}公里。` : `Weekend long run: ${we.km} km${we.runner ? ` with ${k.runner.name}` : home ? ` alone near home in ${k.hometown}` : ' alone'}.`,
        phrase: zh ? `跑了${we.km}公里` : `ran ${we.km} km`,
        fact: zh ? `${me}在${fmt(D(w, we.day))}${we.runner ? `和${k.runner.name}一起` : ''}跑了${we.km}公里。` : `${me} ran ${we.km} km${we.runner ? ` with ${k.runner.name}` : ''} on ${fmt(D(w, we.day))}.` });
    }
  }

  // the mother's blood pressure every Sunday from week 3 (in person on a trip home); a drug from week 6
  for (let w = 3; w <= 12; w++) {
    const [s, d] = BP[w - 3];
    const home = TRIP_WEEKS.includes(w);
    add({ at: [w, 6], cat: 'bp', atHome: home, docType: home ? 'diary' : 'chat', with: home ? undefined : k.mother.name, value: s, subjects: ['mother'],
      item: { label: `${s}/${d}` },
      brief: zh ? `${home ? '在家里看着妈妈量了血压' : '妈妈电话里说了今天量的血压'}：${s}/${d}。` : `${home ? 'At home, Mom measures her blood pressure' : 'Mom reports her blood pressure on the phone'}: ${s}/${d}.`,
      phrase: zh ? `血压${s}/${d}` : `blood pressure was ${s}/${d}`,
      fact: zh ? `${fmt(D(w, 6))}，${me}妈妈的血压是${s}/${d}。` : `On ${fmt(D(w, 6))}, ${me}'s mother's blood pressure was ${s}/${d}.` });
  }
  add({ at: [6, 0], cat: 'med', docType: 'chat', with: k.mother.name, subjects: ['mother'], item: { label: x.med1 },
    brief: zh ? `妈妈说医生让她开始吃降压药${x.med1}。` : `Mom says the doctor started her on ${x.med1} for her blood pressure.`,
    phrase: zh ? `开始吃${x.med1}` : `started on ${x.med1}`, fact: zh ? `${me}妈妈从${fmt(D(6, 0))}起开始吃降压药${x.med1}。` : `${me}'s mother started taking ${x.med1} on ${fmt(D(6, 0))}.` });

  // trips home: Friday evening trains
  for (const w of TRIP_WEEKS) {
    add({ at: [w, 4], cat: 'trip', docType: 'diary', subjects: ['mother'], item: { label: fmt(D(w, 4)), aliases: [iso(D(w, 4))] },
      brief: zh ? `周五下班坐高铁回${k.hometown}看妈妈。` : `Friday evening train home to ${k.hometown} to see Mom.`,
      phrase: zh ? `坐高铁回${k.hometown}` : `took the train home to ${k.hometown}`,
      fact: zh ? `${me}在${fmt(D(w, 4))}坐高铁回了${k.hometown}。` : `${me} took the train home to ${k.hometown} on ${fmt(D(w, 4))}.` });
  }

  // meals out, each at a different restaurant
  const rest = [...RESTAURANTS[lang]].sort(() => c.r() - 0.5);
  const meals: [number, number, Role | 'team'][] = [[2, 4, 'friend'], [4, 3, 'friend'], [4, 6, 'runner'], [5, 6, 'sibling'], [6, 1, 'friend'], [6, 4, 'team'], [9, 1, 'friend'], [11, 1, 'friend'], [12, 2, 'partner']];
  meals.forEach(([w, d, who], i) => {
    const place = rest[i];
    const name = who === 'team' ? (zh ? `${k.manager.name}和组里的同事` : `${k.manager.name} and the team`) : k[who].name;
    add({ at: [w, d], cat: 'meal', docType: who === 'team' ? 'diary' : 'chat', with: who === 'team' ? undefined : k[who].name, subjects: [who === 'team' ? 'manager' : who],
      item: { label: place }, value: i,
      brief: zh ? `和${name}去${place}吃饭${who === 'sibling' ? `（在${k.hometown}）` : ''}。` : `${who === 'team' ? 'Team lunch' : 'A meal'} with ${name} at ${place}${who === 'sibling' ? ` in ${k.hometown}` : ''}.`,
      phrase: zh ? `去${place}吃饭` : `at ${place}`,
      fact: zh ? `${me}在${fmt(D(w, d))}和${name}去${place}吃了饭。` : `${me} ate with ${name} at ${place} on ${fmt(D(w, d))}.` });
  });

  // purchases over 300 yuan (45 dollars)
  for (const [item, price, w, d, forMom] of PURCHASES[lang]) {
    add({ at: [w, d], cat: 'purchase', docType: forMom ? 'chat' : 'diary', with: forMom ? k.sibling.name : undefined, subjects: forMom ? ['sibling', 'mother'] : [], value: price,
      item: { label: item },
      brief: zh ? `${forMom ? `跟${k.sibling.name}说给妈妈买了` : '买了'}${item}，花了${price}元。` : `${forMom ? `Tells ${k.sibling.name} about buying Mom a` : 'Bought'} ${item} for $${price}.`,
      phrase: zh ? `${item}花了${price}元` : `${item} for $${price}`,
      fact: zh ? `${me}在${fmt(D(w, d))}买了${item}，花了${price}元。` : `${me} bought ${item} for $${price} on ${fmt(D(w, d))}.` });
  }

  // the sibling's own life, so a profile of them has more than what they relay
  const sib = k.sibling.name;
  add({ at: [6, 2], cat: 'home', docType: 'chat', with: sib, subjects: ['sibling'],
    brief: zh ? `${sib}说自己在${k.hometown}当中学老师，这学期带毕业班。` : `${sib} mentions teaching high school in ${k.hometown}, with a senior class this term.`,
    phrase: zh ? `在${k.hometown}当中学老师` : `teaching high school in ${k.hometown}`, fact: zh ? `${sib}在${k.hometown}当中学老师。` : `${sib} teaches high school in ${k.hometown}.` });
  add({ at: [11, 3], cat: 'home', docType: 'chat', with: sib, subjects: ['sibling'],
    brief: zh ? `${sib}说女儿今年秋天上小学。` : `${sib} says their daughter starts school this fall.`,
    phrase: zh ? '女儿今年秋天上小学' : 'daughter starts school this fall', fact: zh ? `${sib}的女儿今年秋天上小学。` : `${sib}'s daughter starts school this fall.` });

  // the book club, on Thursdays from week 5
  const books = [...BOOKS[lang]].sort(() => c.r() - 0.5).slice(0, 5);
  [5, 7, 9, 11, 12].forEach((w, i) => {
    add({ at: [w, 3], cat: 'book', docType: 'diary', item: { label: books[i], aliases: zh ? [`《${books[i]}》`] : [] },
      brief: zh ? `读书会这次读的是《${books[i]}》。` : `This week the book club read ${books[i]}.`,
      phrase: zh ? `《${books[i]}》` : `the book club read ${books[i]}`,
      fact: zh ? `${fmt(D(w, 3))}的读书会读的是《${books[i]}》。` : `The book club read ${books[i]} on ${fmt(D(w, 3))}.` });
  });

  // job milestones after the start
  add({ at: [7, 2], cat: 'job', docType: 'diary', subjects: ['manager'], item: { label: zh ? '试用期目标' : 'probation goal' },
    brief: zh ? `和${k.manager.name}一对一，定了试用期目标：两个月内交出${k.tech}的方案。` : `One-on-one with ${k.manager.name}: the probation goal is a plan for ${k.tech} within two months.`,
    phrase: zh ? '试用期目标' : 'probation goal', fact: zh ? `${k.manager.name}给${me}定的试用期目标是两个月内交出${k.tech}的方案。` : `${k.manager.name} set ${me} the probation goal of a plan for ${k.tech} within two months.` });
  add({ at: [10, 2], cat: 'job', docType: 'email', with: k.manager.name, subjects: ['manager'], item: { label: zh ? '第一阶段完成' : 'first phase complete' },
    brief: zh ? `${k.manager.name}群发邮件：${k.tech}第一阶段完成，感谢${me}。` : `${k.manager.name} emails the team: the first phase of ${k.tech} is complete, thanks to ${me}.`,
    phrase: zh ? '第一阶段完成' : 'first phase is complete', fact: zh ? `${fmt(D(10, 2))}，${k.tech}的第一阶段完成。` : `On ${fmt(D(10, 2))} the first phase of ${k.tech} was complete.` });

  // statements that disagree: one side in several documents, the other in one
  const claim = (topic: string, side: string, at: [number, number], docType: ScriptEvent['docType'], withWho: string | undefined, subjects: Role[], phrase: string, brief: string, fact: string) =>
    add({ at, cat: 'claim', topic, side, docType, with: withWho, subjects, phrase, brief, fact, item: { label: side } });
  const L = zh ? '左膝' : 'left knee';
  const R = zh ? '右膝' : 'right knee';
  claim('knee', R, [8, 0], 'chat', k.runner.name, ['runner'], zh ? '右膝有点疼' : 'my right knee hurts', zh ? `跟${k.runner.name}说右膝有点疼，这周不跑了。` : `Tells ${k.runner.name} the right knee hurts, so no running this week.`, zh ? `${me}跟${k.runner.name}说是右膝疼。` : `${me} told ${k.runner.name} it was the right knee.`);
  claim('knee', L, [8, 3], 'chat', k.sibling.name, ['sibling'], zh ? '左膝还在疼' : 'left knee still hurts', zh ? `跟${k.sibling.name}说左膝还在疼。` : `Tells ${k.sibling.name} the left knee still hurts.`, zh ? `${me}跟${k.sibling.name}说左膝还在疼。` : `${me} told ${k.sibling.name} the left knee still hurt.`);
  claim('knee', L, [9, 5], 'diary', undefined, [], zh ? '左膝好多了' : 'left knee feels much better', zh ? '日记：左膝好多了。' : 'Diary: the left knee feels much better.', zh ? `${me}的左膝在${fmt(D(9, 5))}好多了。` : `${me}'s left knee felt much better on ${fmt(D(9, 5))}.`);
  claim('knee', L, [10, 0], 'chat', k.friend.name, ['friend'], zh ? '左膝基本好了' : 'left knee is mostly fine', zh ? `跟${k.friend.name}说左膝基本好了。` : `Tells ${k.friend.name} the left knee is mostly fine.`, zh ? `${me}跟${k.friend.name}说左膝基本好了。` : `${me} told ${k.friend.name} the left knee was mostly fine.`);
  claim('knee', L, [11, 4], 'diary', undefined, [], zh ? '左膝已经不疼了' : 'left knee no longer hurts', zh ? '日记：左膝已经不疼了。' : 'Diary: the left knee no longer hurts.', zh ? `到${fmt(D(11, 4))}，${me}的左膝已经不疼了。` : `By ${fmt(D(11, 4))} ${me}'s left knee no longer hurt.`);

  const team = (nn: number) => (zh ? `${nn}个人` : `${nn} people`);
  claim('team', team(8), [6, 3], 'email', k.manager.name, ['manager'], zh ? '团队有8个人' : 'the team has 8 people', zh ? `${k.manager.name}的欢迎邮件：团队有8个人。` : `${k.manager.name}'s welcome email: the team has 8 people.`, zh ? `${k.manager.name}说团队有8个人。` : `${k.manager.name} said the team had 8 people.`);
  claim('team', team(8), [7, 4], 'diary', undefined, [], zh ? '组里一共8个人' : 'eight of us in the group', zh ? '日记：组里一共8个人，都很年轻。' : 'Diary: eight of us in the group, all young.', zh ? `${me}写道组里一共8个人。` : `${me} wrote that there were eight in the group.`);
  claim('team', team(10), [8, 4], 'chat', k.friend.name, ['friend'], zh ? '我们组10个人' : 'my team is 10 people', zh ? `跟${k.friend.name}说我们组10个人。` : `Tells ${k.friend.name} the team is 10 people.`, zh ? `${me}跟${k.friend.name}说组里10个人。` : `${me} told ${k.friend.name} the team was 10 people.`);
  claim('team', team(8), [10, 1], 'diary', undefined, [], zh ? '8个人的团队' : 'a team of 8', zh ? '日记：8个人的团队，第一阶段做得不错。' : 'Diary: a team of 8, and the first phase went well.', zh ? `${me}的团队是8个人。` : `${me}'s team was a team of 8.`);
  claim('team', team(6), [11, 2], 'email', k.newCo, ['manager'], zh ? '编制6人' : 'headcount of 6', zh ? `人事部邮件里写团队编制6人。` : `An HR email gives the team a headcount of 6.`, zh ? `人事部写${me}所在团队编制6人。` : `HR wrote that ${me}'s team had a headcount of 6.`);

  const thu = zh ? '周四' : 'Thursday';
  const fri = zh ? '周五' : 'Friday';
  claim('bookday', thu, [5, 2], 'diary', undefined, [], zh ? '每周四晚上的读书会' : 'the Thursday evening book club', zh ? '日记：报名了每周四晚上的读书会。' : 'Diary: signed up for the Thursday evening book club.', zh ? '读书会在周四晚上。' : 'The book club meets on Thursday evenings.');
  claim('bookday', thu, [7, 0], 'chat', k.friend.name, ['friend'], zh ? '周四读书会' : 'book club on Thursday', zh ? `跟${k.friend.name}说周四读书会不能约饭。` : `Tells ${k.friend.name} there is book club on Thursday, so no dinner.`, zh ? `${me}说周四有读书会。` : `${me} said the book club was on Thursday.`);
  claim('bookday', fri, [8, 2], 'chat', k.mother.name, ['mother'], zh ? '周五的读书会' : 'the Friday book club', zh ? '跟妈妈说周五的读书会认识了不少人。' : 'Tells Mom she has met people at the Friday book club.', zh ? `${me}跟妈妈说读书会在周五。` : `${me} told Mom the book club was on Friday.`);
  claim('bookday', thu, [10, 3], 'diary', undefined, [], zh ? '周四的读书会' : "Thursday's book club", zh ? '日记：周四的读书会没开成，改期了。' : "Diary: Thursday's book club was called off this week.", zh ? '读书会在周四。' : 'The book club meets on Thursday.');
  claim('bookday', thu, [12, 0], 'chat', k.partner.name, ['partner'], zh ? '读书会在周四' : 'book club is on Thursday', zh ? `${k.partner.name}问读书会哪天，答：读书会在周四。` : `${k.partner.name} asks which day; the book club is on Thursday.`, zh ? '读书会在周四。' : 'The book club is on Thursday.');

  const T = x.partnerTown;
  const W = x.partnerTownWrong;
  claim('hometown', T, [10, 5], 'chat', k.partner.name, ['partner'], zh ? `老家在${T}` : `grew up in ${T}`, zh ? `${k.partner.name}说自己老家在${T}。` : `${k.partner.name} says they grew up in ${T}.`, zh ? `${k.partner.name}的老家在${T}。` : `${k.partner.name} grew up in ${T}.`);
  claim('hometown', T, [11, 0], 'diary', undefined, ['partner'], zh ? `${T}人` : `from ${T}`, zh ? `日记：${k.partner.name}是${T}人，说话带点口音。` : `Diary: ${k.partner.name} is from ${T}, with a bit of an accent.`, zh ? `${me}写道${k.partner.name}是${T}人。` : `${me} wrote that ${k.partner.name} is from ${T}.`);
  claim('hometown', W, [11, 6], 'chat', k.mother.name, ['partner', 'mother'], zh ? `说是${W}人` : `says ${W}`, zh ? `妈妈问起${k.partner.name}，${me}说是${W}人。` : `Mom asks about ${k.partner.name}; ${me} says ${W}.`, zh ? `${me}跟妈妈说${k.partner.name}是${W}人。` : `${me} told Mom that ${k.partner.name} is from ${W}.`);
  claim('hometown', T, [12, 0], 'diary', undefined, ['partner'], zh ? `${T}的家里` : `family in ${T}`, zh ? `日记：${k.partner.name}五一要回${T}的家里。` : `Diary: ${k.partner.name} is visiting family in ${T}.`, zh ? `${k.partner.name}的家在${T}。` : `${k.partner.name}'s family is in ${T}.`);
  claim('hometown', T, [12, 1], 'chat', k.friend.name, ['partner', 'friend'], zh ? `${T}的海鲜` : `seafood in ${T}`, zh ? `跟${k.friend.name}说${k.partner.name}推荐了${T}的海鲜。` : `Tells ${k.friend.name} that ${k.partner.name} recommends the seafood in ${T}.`, zh ? `${k.partner.name}推荐了${T}的海鲜。` : `${k.partner.name} recommended the seafood in ${T}.`);

  // chains: each hop in its own document, the bridges named only there
  const hop = (chain: string, h: number, at: [number, number], docType: ScriptEvent['docType'], withWho: string | undefined, subjects: Role[], phrase: string, brief: string, fact: string) =>
    add({ at, cat: 'hop', chain: { id: chain, hop: h }, docType, with: withWho, subjects, phrase, brief, fact });
  hop('physio', 1, [8, 1], 'chat', k.runner.name, ['runner'], zh ? `推荐了理疗师${x.physio}` : `recommends ${x.physio}`, zh ? `${k.runner.name}推荐了理疗师${x.physio}。` : `${k.runner.name} recommends ${x.physio}, a physiotherapist.`, zh ? `${k.runner.name}给${me}推荐了理疗师${x.physio}。` : `${k.runner.name} recommended the physiotherapist ${x.physio} to ${me}.`);
  hop('physio', 2, [8, 2], 'diary', undefined, [], zh ? `${x.physio}在${x.clinic}坐诊` : `${x.physio} works at ${x.clinic}`, zh ? `去看了理疗：${x.physio}在${x.clinic}坐诊。` : `Physio visit: ${x.physio} works at ${x.clinic}.`, zh ? `理疗师${x.physio}在${x.clinic}坐诊。` : `${x.physio} works at ${x.clinic}.`);
  hop('physio', 3, [9, 0], 'chat', k.friend.name, ['friend'], zh ? `${x.clinic}在${x.street}` : `${x.clinic} is on ${x.street}`, zh ? `跟${k.friend.name}说${x.clinic}在${x.street}，离公司不远。` : `Tells ${k.friend.name} that ${x.clinic} is on ${x.street}, near the office.`, zh ? `${x.clinic}在${x.street}。` : `${x.clinic} is on ${x.street}.`);

  hop('club', 1, [5, 4], 'chat', k.friend.name, ['friend'], zh ? `读书会的组织者是${x.organizer}` : `the book club is run by ${x.organizer}`, zh ? `跟${k.friend.name}说读书会的组织者是${x.organizer}。` : `Tells ${k.friend.name} the book club is run by ${x.organizer}.`, zh ? `读书会的组织者是${x.organizer}。` : `The book club is run by ${x.organizer}.`);
  hop('club', 2, [7, 5], 'diary', undefined, [], zh ? `${x.organizer}在${x.shop}上班` : `${x.organizer} works at ${x.shop}`, zh ? `日记：原来${x.organizer}在${x.shop}上班。` : `Diary: it turns out ${x.organizer} works at ${x.shop}.`, zh ? `${x.organizer}在${x.shop}上班。` : `${x.organizer} works at ${x.shop}.`);
  hop('club', 3, [10, 6], 'chat', k.friend.name, ['friend'], zh ? `${x.shop}的老板是${x.owner}` : `${x.shop} is owned by ${x.owner}`, zh ? `跟${k.friend.name}说${x.shop}的老板是${x.owner}。` : `Tells ${k.friend.name} that ${x.shop} is owned by ${x.owner}.`, zh ? `${x.shop}的老板是${x.owner}。` : `${x.shop} is owned by ${x.owner}.`);
  hop('club', 4, [12, 5], 'diary', undefined, [], zh ? `${x.owner}是我在${k.oldCo}时的老同事` : `${x.owner} was my colleague at ${k.oldCo}`, zh ? `日记：才发现${x.owner}是我在${k.oldCo}时的老同事。` : `Diary: turns out ${x.owner} was my colleague at ${k.oldCo}.`, zh ? `${x.owner}是${me}在${k.oldCo}时的同事。` : `${x.owner} was ${me}'s colleague at ${k.oldCo}.`);

  hop('founder', 1, [7, 3], 'chat', k.manager.name, ['manager'], zh ? `之前在${x.prevCo}工作` : `previously worked at ${x.prevCo}`, zh ? `${k.manager.name}聊起自己之前在${x.prevCo}工作。` : `${k.manager.name} mentions having previously worked at ${x.prevCo}.`, zh ? `${k.manager.name}之前在${x.prevCo}工作。` : `${k.manager.name} previously worked at ${x.prevCo}.`);
  hop('founder', 2, [9, 2], 'diary', undefined, [], zh ? `${x.prevCo}的创始人是${x.founder}` : `${x.prevCo} was founded by ${x.founder}`, zh ? `日记：看了篇报道，${x.prevCo}的创始人是${x.founder}。` : `Diary: read that ${x.prevCo} was founded by ${x.founder}.`, zh ? `${x.prevCo}的创始人是${x.founder}。` : `${x.prevCo} was founded by ${x.founder}.`);
  hop('founder', 3, [11, 5], 'chat', k.runner.name, ['runner'], zh ? `${x.founder}赞助了${k.race}` : `${x.founder} sponsors ${k.race}`, zh ? `${k.runner.name}说今年是${x.founder}赞助了${k.race}。` : `${k.runner.name} says ${x.founder} sponsors ${k.race} this year.`, zh ? `${x.founder}赞助了${k.race}。` : `${x.founder} sponsors ${k.race}.`);

  hop('sister', 2, [10, 4], 'chat', k.partner.name, ['partner'], zh ? `姐姐叫${x.partnerSister}` : `sister is ${x.partnerSister}`, zh ? `${k.partner.name}说自己的姐姐叫${x.partnerSister}。` : `${k.partner.name} says their sister is ${x.partnerSister}.`, zh ? `${k.partner.name}的姐姐叫${x.partnerSister}。` : `${k.partner.name}'s sister is ${x.partnerSister}.`);
  hop('sister', 3, [11, 2], 'diary', undefined, [], zh ? `${x.partnerSister}在${x.hospital}当医生` : `${x.partnerSister} is a doctor at ${x.hospital}`, zh ? `日记：${x.partnerSister}在${x.hospital}当医生。` : `Diary: ${x.partnerSister} is a doctor at ${x.hospital}.`, zh ? `${x.partnerSister}在${x.hospital}当医生。` : `${x.partnerSister} is a doctor at ${x.hospital}.`);
  return out;
}

/** The script's own events, annotated for the ledger's lists: what kind, whom about. */
export function annotateBase(events: ScriptEvent[], k: Cast, lang: Lang): void {
  for (const e of events) {
    if (e.id.startsWith('L')) continue;
    if (e.phrase === `${k.km}公里` || e.phrase === `${k.km} km`) Object.assign(e, { cat: 'run', long: true, value: k.km, item: { label: lang === 'zh' ? `${k.km}公里` : `${k.km} km`, aliases: [`${k.km}km`] } });
    else if (e.week === 9 && e.entities.includes(k.partner.name) && e.docType === 'chat') Object.assign(e, { cat: 'hop', chain: { id: 'sister', hop: 1 }, subjects: ['partner', 'friend'] });
    else if (e.entities.includes(k.partner.name)) Object.assign(e, { cat: 'home', subjects: ['partner'] });
    else if (e.phrase === k.condition) Object.assign(e, { cat: 'health', subjects: ['mother', 'sibling'] });
    else if (e.phrase === k.race) Object.assign(e, { cat: 'race', subjects: ['runner'] });
    else if (e.with === k.mother.name) Object.assign(e, { cat: 'home', subjects: ['mother'] });
    else if (e.with === k.newCo && !e.entities.includes(k.manager.name)) Object.assign(e, { cat: 'job', subjects: [] });
    else if (e.entities.includes(k.manager.name)) Object.assign(e, { cat: 'job', subjects: ['manager'] });
    else if (e.with === k.friend.name) Object.assign(e, { cat: 'job', subjects: ['friend'] });
    else Object.assign(e, { cat: e.phrase.includes(k.oldCo) ? 'job' : 'home' });
  }
}

/* ------------------------------ update stream ------------------------------ */

export interface UpdateDates {
  startJob: Date;
  newStart: Date;
  raceDay: Date;
  follow: Date;
}

/** When the race and the follow-up move to, in the later batches. */
export function movedDates(dates: UpdateDates): { raceDay2: Date; follow2: Date } {
  return { raceDay2: new Date(dates.raceDay.getTime() + 7 * 86_400_000), follow2: new Date(dates.follow.getTime() + 5 * 86_400_000) };
}

/**
 * Batches 02–04 after the start-date change (01): the race is moved, the
 * mother's follow-up and drug change, the person switches to the half and
 * takes over the project. Questions after each ask the latest state —
 * including ones a later batch leaves alone, which must still hold.
 */
export function laterUpdates(c: LedgerContext, x: Extras, dates: UpdateDates, startDoc: string): UpdateBatch[] {
  const { cast: k, D, fmt, iso, lang } = c;
  const zh = lang === 'zh';
  const me = k.me.name;
  const { raceDay2, follow2 } = movedDates(dates);
  const b2 = iso(D(9, 2));
  const b3 = iso(D(11, 1));
  const b4 = iso(D(12, 4));
  const raceDoc = `email/${b2}-race.md`;
  const followDoc = `chat/${b3}-sibling.md`;
  const halfDoc = `chat/${b4}-runner.md`;
  const leadDoc = `email/${b4}-manager.md`;
  const startAgain = zh ? `${me}最终是哪天入职${k.newCoShort}的？` : `On what date does ${me} finally start at ${k.newCoShort}?`;
  const startAnswer = fmt(dates.newStart);
  return [
    {
      batch: '02', date: b2,
      docs: [{ path: raceDoc, text: zh ? `# 邮件：${k.race}改期通知\n\n各位跑者：因场地调整，${k.race}改期到${fmt(raceDay2)}举行，报名信息保留。\n` : `# Email: ${k.race} rescheduled\n\nDear runners: because of a venue change, ${k.race} is rescheduled to ${fmt(raceDay2)}. Your registration stands.\n` }],
      tasks: [
        { id: 'upd-race-date', question: zh ? `${k.race}现在定在哪天举行？` : `On what date is ${k.race} now held?`, answer: fmt(raceDay2), doc: raceDoc, quote: zh ? `改期到${fmt(raceDay2)}` : `rescheduled to ${fmt(raceDay2)}`, short: true, stale: [fmt(dates.raceDay)] },
        { id: 'upd-start-02', question: startAgain, answer: startAnswer, doc: startDoc, short: true, stale: [fmt(dates.startJob)] },
      ],
    },
    {
      batch: '03', date: b3,
      docs: [{ path: followDoc, text: zh ? `# 微信 · ${me} 与 ${k.sibling.name}\n\n${k.sibling.name}：医院来电话，妈妈的复查改到${fmt(follow2)}了。还有，医生把她的药换成了${x.med2}。\n${me}：好，那天我请假回去。\n` : `# Text · ${me} and ${k.sibling.name}\n\n${k.sibling.name}: The hospital called — Mom's follow-up is moved to ${fmt(follow2)}. And the doctor switched her to ${x.med2}.\n${me}: OK, I'll take the day off.\n` }],
      tasks: [
        { id: 'upd-follow', question: zh ? `${me}妈妈的复查现在约在哪天？` : `When is ${me}'s mother's follow-up now?`, answer: fmt(follow2), doc: followDoc, quote: zh ? `复查改到${fmt(follow2)}` : `moved to ${fmt(follow2)}`, short: true, stale: [fmt(dates.follow)] },
        { id: 'upd-med', question: zh ? `${me}妈妈现在吃的是哪种降压药？` : `Which blood-pressure drug does ${me}'s mother take now?`, answer: x.med2, doc: followDoc, quote: x.med2, short: true, stale: [x.med1] },
      ],
    },
    {
      batch: '04', date: b4,
      docs: [
        { path: halfDoc, text: zh ? `# 微信 · ${me} 与 ${k.runner.name}\n\n${me}：膝盖还是不放心，我改报了${x.half}。\n${k.runner.name}：稳妥，比赛那天见。\n` : `# Text · ${me} and ${k.runner.name}\n\n${me}: Still not sure about the knee, so I switched to ${x.half}.\n${k.runner.name}: Sensible. See you on race day.\n` },
        { path: leadDoc, text: zh ? `# 邮件：项目分工\n\n各位：从下周起，${k.tech}由${me}负责，大家有问题直接找${me}。——${k.manager.name}\n` : `# Email: who leads what\n\nAll: from next week, ${me} leads ${k.tech}; take questions straight to ${me}. — ${k.manager.name}\n` },
      ],
      tasks: [
        { id: 'upd-race-event', question: zh ? `${me}最后报的是比赛的哪个项目？` : `Which event did ${me} end up entering?`, answer: x.half, doc: halfDoc, quote: zh ? `改报了${x.half}` : `switched to ${x.half}`, short: true },
        { id: 'upd-race-date-04', question: zh ? `${k.race}在哪天举行？` : `On what date is ${k.race} held?`, answer: fmt(raceDay2), doc: raceDoc, short: true, stale: [fmt(dates.raceDay)] },
        { id: 'upd-lead', question: zh ? `${me}现在在团队里负责什么？` : `What does ${me} lead in the team now?`, answer: zh ? `负责${k.tech}` : `leads ${k.tech}`, doc: leadDoc },
        { id: 'upd-start-04', question: startAgain, answer: startAnswer, doc: startDoc, short: true, stale: [fmt(dates.startJob)] },
      ],
    },
  ];
}

/* ---------------------------------- tasks ---------------------------------- */

export interface LedgerScript {
  lang: Lang;
  cast: Cast;
  events: ScriptEvent[];
  extras: Extras;
}

type Draft = Omit<Task, 'evidence'> & { evidence: Task['evidence'] };

const MONTHS_EN = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * The corpus-level tasks a script implies, given which document each event
 * landed in: aggregates and counts, timelines, contradictions, profiles and
 * deep chains. A task whose events did not all land, or whose evidence
 * spreads over fewer documents than a corpus-level task needs, is left out
 * (and named in `skipped`) — gold that may be wrong is noise.
 */
export function ledgerTasks(script: LedgerScript, docOf: Map<string, string>, quoteOf: (eventId: string) => string | undefined = () => undefined): { tasks: Draft[]; skipped: string[] } {
  const { lang, cast: k, extras: x } = script;
  const zh = lang === 'zh';
  const me = k.me.name;
  const tasks: Draft[] = [];
  const skipped: string[] = [];
  const all = script.events;
  // the cast's names: padding that names none of them cannot add to what the person did
  const castTerms = [...new Set([me, k.friend.name, k.friend.nick ?? '', k.manager.name, k.partner.name, personKey(k, 'sibling', lang).label, personKey(k, 'runner', lang).label].filter((s) => s.length >= 2))];
  const ev = (e: ScriptEvent) => ({ doc: docOf.get(e.id)!, ...(quoteOf(e.id) ? { quote: quoteOf(e.id) } : {}) });
  const spec = (s: Partial<ListSpec>): ListSpec => ({ match: 'alias', ordered: false, maxItems: 10, requireDocs: false, primary: 'f1', ...s });
  const month = (e: ScriptEvent) => Number(e.date.slice(5, 7));
  const monthName = (m: number) => (zh ? `${m}月` : MONTHS_EN[m]);

  const ready = (id: string, events: ScriptEvent[]) => {
    const missing = events.filter((e) => !docOf.has(e.id));
    if (missing.length) {
      skipped.push(`${id}: ${missing.length} event(s) not in any document`);
      return false;
    }
    if (new Set(events.map((e) => docOf.get(e.id))).size < CORPUS_TASK_MIN_DOCS) {
      skipped.push(`${id}: evidence in fewer than ${CORPUS_TASK_MIN_DOCS} documents`);
      return false;
    }
    return true;
  };
  const evidence = (events: ScriptEvent[]) => {
    const seen = new Set<string>();
    return events.filter((e) => (seen.has(docOf.get(e.id)!) ? false : (seen.add(docOf.get(e.id)!), true))).map(ev);
  };
  const itemOf = (e: ScriptEvent, extra: Partial<GoldItem> = {}): GoldItem => ({ label: e.item!.label, aliases: e.item!.aliases ?? [], weight: 1, date: e.date, docs: [docOf.get(e.id)!], ...extra });
  const list = (id: string, type: Task['type'], question: string, events: ScriptEvent[], items: GoldItem[], s: Partial<ListSpec>, terms: string[] = [], primary = false) => {
    if (!ready(id, events)) return;
    const maxItems = Math.min(60, Math.max(10, items.length + 5));
    tasks.push({ id, suite: 'usage', type, lang, question, scoring: 'set', items, list: spec({ maxItems, ...s }), closedWorld: { terms: [...castTerms, ...terms], prefixes: [] }, evidence: evidence(events), ...(primary ? { primary } : {}) });
  };
  const count = (id: string, question: string, events: ScriptEvent[], n: number, terms: string[] = []) => {
    if (!ready(id, events)) return;
    tasks.push({ id, suite: 'usage', type: 'aggregate', lang, question, answer: String(n), scoring: 'count', closedWorld: { terms: [...castTerms, ...terms], prefixes: [] }, evidence: evidence(events) });
  };

  // runs
  const runs = all.filter((e) => e.cat === 'run').sort((a, b) => a.date.localeCompare(b.date));
  const kmTerms = zh ? ['公里'] : ['km', 'kilomet'];
  for (const m of [...new Set(runs.map(month))]) {
    const inMonth = runs.filter((e) => month(e) === m);
    list(`l-runs-${m}`, 'aggregate', zh ? `${me}在${m}月每次跑步分别跑了多少公里？请全部列出（含日期）。` : `List every run ${me} did in ${monthName(m)}, with its distance and date.`, inMonth, inMonth.map((e) => itemOf(e)), {}, kmTerms, m === 4);
    count(`n-runs-${m}`, zh ? `${me}在${m}月一共跑了几次步？` : `How many times did ${me} go running in ${monthName(m)}?`, inMonth, inMonth.length, kmTerms);
  }
  const together = runs.filter((e) => e.together);
  count('n-runs-runner', zh ? `${me}和${k.runner.name}一起跑过几次步？` : `How many times did ${me} run together with ${k.runner.name}?`, together, together.length, kmTerms);
  list('l-runs-runner', 'aggregate', zh ? `${me}和${k.runner.name}一起跑步的那几次，各跑了多少公里？` : `On the runs ${me} did with ${k.runner.name}, how far did they go each time?`, together, together.map((e) => itemOf(e)), {}, kmTerms);
  const long15 = runs.filter((e) => (e.value ?? 0) >= 15);
  list('l-runs-15', 'aggregate', zh ? `${me}跑过的15公里及以上的长距离都有哪些？列出日期和距离。` : `List every run of 15 km or more that ${me} did, with date and distance.`, long15, long15.map((e) => itemOf(e)), {}, kmTerms, true);
  const weekend = runs.filter((e) => e.long);
  list('t-long-runs', 'timeline', zh ? `${me}周末长距离的距离是怎么变化的？按时间列出每次的日期和公里数。` : `How did ${me}'s weekend long-run distance change? List each one in order, with date and distance.`, weekend, weekend.map((e) => itemOf(e)), { ordered: true }, kmTerms, true);
  const weeks = [...new Set(runs.map((e) => e.week))].sort((a, b) => a - b);
  const weekly = weeks.map((w) => {
    const of = runs.filter((e) => e.week === w);
    const total = of.reduce((s, e) => s + (e.value ?? 0), 0);
    const monday = of[0].date; // the week's first run stands for the week
    return { w, of, total, monday };
  });
  if (weekly.every(({ of }) => of.every((e) => docOf.has(e.id)))) {
    list('t-weekly-km', 'timeline', zh ? `${me}每周的总跑量是多少公里？按周列出（注明那一周的日期）。` : `What was ${me}'s total running distance each week? List the weeks in order, with a date in each week.`,
      runs, weekly.map(({ total, monday, of }) => ({ label: zh ? `${total}公里` : `${total} km`, aliases: [`${total}km`], weight: 1, date: monday.slice(0, 10), docs: of.map((e) => docOf.get(e.id)!) })), { ordered: true }, kmTerms);
  }

  // structured queries (docs/design/28 §c): group and sum over every run, the whole set or nothing
  const monthForms = (m: number) => (zh ? [`${m}月`] : [MONTHS_EN[m], MONTHS_EN[m].slice(0, 3)]);
  const structured = (id: string, question: string, events: ScriptEvent[], items: GoldItem[]) => {
    if (!ready(id, events)) return;
    if (new Set(events.map((e) => docOf.get(e.id))).size < STRUCTURED_MIN_DOCS) {
      skipped.push(`${id}: evidence in fewer than ${STRUCTURED_MIN_DOCS} documents`);
      return;
    }
    tasks.push({ id, suite: 'usage', type: 'structured', lang, question, scoring: 'set', items, list: exactSetSpec(items.length), closedWorld: { terms: [...castTerms, ...kmTerms], prefixes: [] }, evidence: evidence(events), meta: { family: 'structured' } });
  };
  const runMonths = [...new Set(runs.map(month))];
  structured('sq-km-month', zh ? `${me}每个月的跑步总里程分别是多少公里？按月列出。` : `What was ${me}'s total running distance in each month? List every month.`, runs,
    runMonths.map((m) => {
      const of = runs.filter((e) => month(e) === m);
      const total = of.reduce((sum, e) => sum + (e.value ?? 0), 0);
      return { label: zh ? `${m}月：${total}公里` : `${MONTHS_EN[m]}: ${total} km`, aliases: [], weight: 1, docs: of.map((e) => docOf.get(e.id)!).filter(Boolean), fields: [monthForms(m), [String(total)]] };
    }));
  const alone = runs.filter((e) => !e.together);
  structured('sq-runs-company', zh ? `${me}的跑步里，和${k.runner.name}一起跑的有几次、自己一个人跑的有几次？` : `Of ${me}'s runs, how many were with ${k.runner.name} and how many alone?`, runs, [
    { label: zh ? `和${k.runner.name}一起：${together.length}次` : `with ${k.runner.name}: ${together.length}`, aliases: [], weight: 1, fields: [[personKey(k, 'runner', lang).label, ...personKey(k, 'runner', lang).aliases, zh ? '一起' : 'together'], [String(together.length)]] },
    { label: zh ? `一个人：${alone.length}次` : `alone: ${alone.length}`, aliases: [], weight: 1, fields: [zh ? ['一个人', '独自', '自己'] : ['alone', 'solo', 'by herself', 'by himself', 'on their own'], [String(alone.length)]] },
  ]);
  if (ready('sq-km-total', runs) && new Set(runs.map((e) => docOf.get(e.id))).size >= STRUCTURED_MIN_DOCS) {
    tasks.push({ id: 'sq-km-total', suite: 'usage', type: 'structured', lang, scoring: 'count', answer: String(runs.reduce((sum, e) => sum + (e.value ?? 0), 0)),
      question: zh ? `这段时间${me}所有跑步加起来一共跑了多少公里？` : `How many kilometres did ${me} run in total over this period, all runs together?`, closedWorld: { terms: [...castTerms, ...kmTerms], prefixes: [] }, evidence: evidence(runs), meta: { family: 'structured', aggregate: 'sum' } });
  }

  // blood pressure
  const bp = all.filter((e) => e.cat === 'bp').sort((a, b) => a.date.localeCompare(b.date));
  const bpTerms = zh ? ['血压'] : ['blood pressure'];
  list('t-bp', 'timeline', zh ? `${me}妈妈的血压从3月到5月是怎么变化的？按时间列出每次的读数和日期。` : `How did ${me}'s mother's blood pressure change from March to May? List every reading in order, with its date.`, bp, bp.map((e) => itemOf(e)), { ordered: true }, bpTerms, true);
  const high = bp.filter((e) => (e.value ?? 0) >= 140);
  list('l-bp-high', 'aggregate', zh ? `${me}妈妈哪几次量的血压收缩压在140及以上？列出读数和日期。` : `Which of ${me}'s mother's readings had a systolic pressure of 140 or more? List each reading and its date.`, high, high.map((e) => itemOf(e)), {}, bpTerms);
  count('n-bp-high', zh ? `${me}妈妈有几次血压读数的收缩压在140及以上？` : `How many of ${me}'s mother's blood-pressure readings had a systolic value of 140 or more?`, high, high.length, bpTerms);
  const med = all.find((e) => e.cat === 'med');
  if (med) {
    const after = bp.filter((e) => e.date >= med.date);
    list('l-bp-after-med', 'aggregate', zh ? `${me}妈妈开始吃降压药以后，每次量的血压是多少？` : `After ${me}'s mother started her blood-pressure drug, what was each reading?`, [med, ...after], after.map((e) => itemOf(e)), {}, bpTerms);
  }
  const atHome = bp.filter((e) => e.atHome);
  list('l-bp-home', 'aggregate', zh ? `${me}每次回${k.hometown}的那个周末，妈妈量的血压分别是多少？` : `On each weekend ${me} went home to ${k.hometown}, what was Mom's blood-pressure reading?`, [...atHome, ...all.filter((e) => e.cat === 'trip')], atHome.map((e) => itemOf(e)), {}, bpTerms);

  // meals
  const meals = all.filter((e) => e.cat === 'meal').sort((a, b) => a.date.localeCompare(b.date));
  const restTerms = meals.map((e) => e.item!.label);
  list('l-restaurants', 'aggregate', zh ? `这三个月里${me}在外面吃饭去过哪些餐厅？` : `Which restaurants did ${me} eat at over these three months?`, meals, meals.map((e) => itemOf(e)), {}, restTerms, true);
  const diners = [...new Set(meals.map((e) => e.subjects![0]))] as Role[];
  list('l-diners', 'aggregate', zh ? `这三个月里${me}都和谁一起在外面吃过饭？` : `Who did ${me} eat out with over these three months?`, meals,
    diners.map((r) => ({ ...personKey(k, r, lang), weight: 1, docs: meals.filter((e) => e.subjects![0] === r).map((e) => docOf.get(e.id)!).filter(Boolean) })), {}, restTerms);
  const withFriend = meals.filter((e) => e.subjects![0] === 'friend');
  count('n-meals-friend', zh ? `${me}和${k.friend.name}一起在外面吃过几次饭？` : `How many times did ${me} eat out with ${k.friend.name}?`, withFriend, withFriend.length, restTerms);
  list('t-meals', 'timeline', zh ? `按时间列出${me}每次在外面吃饭的日期和餐厅。` : `List, in order, each time ${me} ate out: the date and the restaurant.`, meals, meals.map((e) => itemOf(e)), { ordered: true }, restTerms);

  // purchases
  const buys = all.filter((e) => e.cat === 'purchase').sort((a, b) => a.date.localeCompare(b.date));
  const buyTerms = buys.map((e) => e.item!.label);
  const threshold = zh ? '300元' : '$45';
  list('l-purchases', 'aggregate', zh ? `这三个月里${me}买过哪些${threshold}以上的东西？` : `What did ${me} buy for more than ${threshold} over these three months?`, buys, buys.map((e) => itemOf(e)), {}, buyTerms, true);
  count('n-purchases', zh ? `${me}买了几件${threshold}以上的东西？` : `How many things costing more than ${threshold} did ${me} buy?`, buys, buys.length, buyTerms);
  count('n-purchases-sum', zh ? `${me}买的这些${threshold}以上的东西一共花了多少元？` : `How much did ${me} spend in total, in dollars, on the things costing more than ${threshold}?`, buys, buys.reduce((s, e) => s + (e.value ?? 0), 0), buyTerms);
  list('t-purchases', 'timeline', zh ? `按时间列出${me}每次${threshold}以上的消费：日期、买了什么。` : `List, in order, each purchase over ${threshold} by ${me}: the date and what was bought.`, buys, buys.map((e) => itemOf(e)), { ordered: true }, buyTerms);

  // trips home
  const trips = all.filter((e) => e.cat === 'trip').sort((a, b) => a.date.localeCompare(b.date));
  const tripTerms = [k.hometown];
  count('n-trips', zh ? `这三个月里${me}回了几次${k.hometown}？` : `How many times did ${me} go home to ${k.hometown} over these three months?`, trips, trips.length, tripTerms);
  list('t-trips', 'timeline', zh ? `${me}每次回${k.hometown}是哪天？按时间列出。` : `On which dates did ${me} go home to ${k.hometown}? List them in order.`, trips, trips.map((e) => itemOf(e)), { ordered: true }, tripTerms);

  // book club
  const books = all.filter((e) => e.cat === 'book').sort((a, b) => a.date.localeCompare(b.date));
  const bookTerms = books.map((e) => e.item!.label);
  list('l-books', 'aggregate', zh ? `读书会这段时间读了哪些书？` : `Which books did the book club read over this period?`, books, books.map((e) => itemOf(e)), {}, bookTerms, true);
  list('t-books', 'timeline', zh ? `读书会每次读的是哪本书？按时间列出日期和书名。` : `Which book did each book-club meeting read? List them in order with their dates.`, books, books.map((e) => itemOf(e)), { ordered: true }, bookTerms);

  // the job, judged: its stages are not names or numbers
  const job = all.filter((e) => e.cat === 'job').sort((a, b) => a.date.localeCompare(b.date));
  const jobUnique = job.filter((e, i) => job.findIndex((o) => docOf.get(o.id) === docOf.get(e.id) && o.fact === e.fact) === i);
  list('t-job', 'timeline', zh ? `${me}换工作这件事是怎么一步步推进的？按时间列出每个节点和日期。` : `How did ${me}'s job change unfold? List each step in order, with its date.`, jobUnique,
    jobUnique.map((e) => ({ label: e.fact, aliases: [e.phrase], weight: 1, date: e.date, docs: [docOf.get(e.id)!] })), { match: 'judge', ordered: true }, [k.newCo, k.oldCo]);

  // contradictions: each side with the documents that take it; a side found without one of them is not found
  const topics: [string, string][] = zh
    ? [['knee', `关于${me}哪个膝盖受伤，各份材料的说法一致吗？哪些材料说法不同，分别怎么说？`], ['team', `关于${me}所在团队有多少人，各份材料的说法一致吗？哪些材料说法不同，分别怎么说？`],
      ['bookday', `读书会是星期几，各份材料的说法一致吗？哪些材料说法不同，分别怎么说？`], ['hometown', `${k.partner.name}是哪里人，各份材料的说法一致吗？哪些材料说法不同，分别怎么说？`]]
    : [['knee', `Do the documents agree on which of ${me}'s knees was hurt? Which disagree, and what does each side say?`], ['team', `Do the documents agree on how many people are on ${me}'s team? Which disagree, and what does each side say?`],
      ['bookday', 'Do the documents agree on which day the book club meets? Which disagree, and what does each side say?'], ['hometown', `Do the documents agree on where ${k.partner.name} is from? Which disagree, and what does each side say?`]];
  const sideAliases: Record<string, string[]> = zh
    ? { 左膝: ['左膝盖', '左腿'], 右膝: ['右膝盖', '右腿'], '8个人': ['8人', '八个人', '八人'], '10个人': ['10人', '十个人', '十人'], '6个人': ['6人', '六个人', '六人', '编制6'], 周四: ['星期四', '礼拜四'], 周五: ['星期五', '礼拜五'] }
    : { 'left knee': ['left'], 'right knee': ['right'], '8 people': ['8', 'eight'], '10 people': ['10', 'ten'], '6 people': ['6', 'six', 'headcount of 6'], Thursday: ['Thu'], Friday: ['Fri'] };
  const claims = all.filter((e) => e.cat === 'claim');
  for (const [topic, question] of topics) {
    const of = claims.filter((e) => e.topic === topic);
    const sides = [...new Set(of.map((e) => e.side!))];
    list(`c-${topic}`, 'contradiction', question, of, sides.map((side) => ({ label: side, aliases: sideAliases[side] ?? [], weight: 1, docs: of.filter((e) => e.side === side).map((e) => docOf.get(e.id)!).filter(Boolean) })),
      { requireDocs: true }, topic === 'knee' ? [zh ? '膝' : 'knee'] : topic === 'team' ? [zh ? '团队' : 'team'] : topic === 'bookday' ? [zh ? '读书会' : 'book club'] : [], topic === 'knee');
  }
  const topicLabels: Record<string, [string, string[]]> = zh
    ? { knee: ['哪个膝盖受伤', ['膝盖', '膝']], team: ['团队有多少人', ['团队人数', '组里几个人', '编制']], bookday: ['读书会是星期几', ['读书会']], hometown: [`${k.partner.name}是哪里人`, ['老家', '籍贯', '哪里人']] }
    : { knee: ['which knee was hurt', ['knee']], team: ['how many people are on the team', ['team size', 'headcount']], bookday: ['which day the book club meets', ['book club']], hometown: [`where ${k.partner.name} is from`, ['hometown', 'grew up']] };
  list('c-all', 'contradiction', zh ? `通读这些材料，有哪些事情不同材料的说法互相矛盾？逐一列出是什么事。` : 'Reading all the materials, on which matters do different documents contradict each other? List each matter.', claims,
    topics.map(([t]) => ({ label: topicLabels[t][0], aliases: topicLabels[t][1], weight: 1, docs: claims.filter((e) => e.topic === t).map((e) => docOf.get(e.id)!).filter(Boolean) })), { match: 'judge' });

  // profiles: everything said about a person, the series summed up in one item each
  const roles: Role[] = ['mother', 'sibling', 'friend', 'runner', 'manager', 'partner'];
  for (const role of roles) {
    // statements are about their topic, not their listener — except where the partner is from
    const about = all.filter((e) => e.subjects?.includes(role) && (e.cat !== 'claim' || (role === 'partner' && e.topic === 'hometown')));
    const series = about.filter((e) => e.cat === 'bp' || e.cat === 'trip' || e.cat === 'claim' || (e.cat === 'run' && e.together));
    const single = about.filter((e) => !series.includes(e));
    const items: GoldItem[] = single.map((e) => ({ label: e.fact, aliases: [e.phrase], weight: 1, date: e.date, docs: [docOf.get(e.id)!].filter(Boolean) }));
    const docsOf = (es: ScriptEvent[]) => es.map((e) => docOf.get(e.id)!).filter(Boolean);
    const bpOf = series.filter((e) => e.cat === 'bp');
    if (bpOf.length) items.push({ label: zh ? `血压从${bpOf[0].item!.label}逐渐降到${bpOf.at(-1)!.item!.label}` : `blood pressure fell from ${bpOf[0].item!.label} to ${bpOf.at(-1)!.item!.label}`, aliases: [bpOf[0].item!.label, bpOf.at(-1)!.item!.label], weight: 1, docs: docsOf(bpOf) });
    const tripsOf = series.filter((e) => e.cat === 'trip');
    if (tripsOf.length) items.push({ label: zh ? `${me}回${k.hometown}看了她${tripsOf.length}次` : `${me} came home to ${k.hometown} to see her ${tripsOf.length} times`, aliases: [], weight: 1, docs: docsOf(tripsOf) });
    const runsOf = series.filter((e) => e.cat === 'run');
    if (runsOf.length) items.push({ label: zh ? `和${me}一起跑过${runsOf.length}次` : `ran with ${me} ${runsOf.length} times`, aliases: [], weight: 1, docs: docsOf(runsOf) });
    const fromOf = series.filter((e) => e.cat === 'claim' && e.side === x.partnerTown);
    if (fromOf.length) items.push({ label: zh ? `${k.partner.name}是${x.partnerTown}人` : `${k.partner.name} is from ${x.partnerTown}`, aliases: [x.partnerTown], weight: 1, docs: docsOf(fromOf) });
    const key = personKey(k, role, lang);
    list(`p-${role}`, 'profile', zh ? `这些材料里关于${key.label}都说了些什么？逐条列出。` : `What do these materials say about ${key.label}? List every fact.`, about, items, { match: 'judge', primary: 'recall' }, [], role === 'mother');
  }

  // deep chains: the question names the start; bridges sit in other documents
  const chains: Record<string, { q: string; a: string; answers?: string[] }> = zh ? {
    physio: { q: `${k.runner.name}给${me}推荐的那位理疗师所在的诊所，位于哪条路？`, a: x.street },
    club: { q: `${me}参加的读书会，其组织者上班的那家书店，老板以前和${me}在哪家公司共事？`, a: k.oldCo },
    founder: { q: `${me}的直属领导之前任职的那家公司，其创始人赞助了哪场比赛？`, a: k.race },
    sister: { q: `${me}在读书会认识的那个人，他/她的姐姐在哪家医院当医生？`, a: x.hospital },
  } : {
    physio: { q: `The physiotherapist ${k.runner.name} recommended to ${me} works at a clinic: which street is that clinic on?`, a: x.street },
    club: { q: `The organizer of ${me}'s book club works at a bookshop. At which company did that bookshop's owner once work with ${me}?`, a: k.oldCo },
    founder: { q: `${me}'s manager previously worked at another company. Which race does that company's founder sponsor?`, a: k.race },
    sister: { q: `The person ${me} met at the book club has a sister who is a doctor. At which hospital?`, a: x.hospital },
  };
  for (const [chain, { q, a }] of Object.entries(chains)) {
    const hops = all.filter((e) => e.chain?.id === chain).sort((p, r) => p.chain!.hop - r.chain!.hop);
    const docs = new Set(hops.map((e) => docOf.get(e.id)));
    if (hops.some((e) => !docOf.has(e.id)) || docs.size < DEEP_HOP_MIN || hops.length < DEEP_HOP_MIN) {
      skipped.push(`h-${chain}: a hop is missing or shares a document`);
      continue;
    }
    tasks.push({ id: `h-${chain}`, suite: 'usage', type: 'deep-hop', lang, question: q, answer: a, scoring: 'judge', evidence: hops.map(ev), meta: { hops: hops.length, bridges: hops.slice(0, -1).map((e) => e.phrase) }, primary: true });
  }

  // the same counts in other words, and in the other language (docs/design/28 §f): gold unchanged
  const other: Lang = zh ? 'en' : 'zh';
  const variants: Record<string, [string, string]> = zh ? {
    'n-trips': [`这三个月${me}一共回过几趟${k.hometown}？`, `How many trips home to ${k.hometown} did ${me} make over these three months?`],
    'n-purchases': [`${me}这段时间有几笔单价超过${threshold}的消费？`, `How many purchases above ${threshold} did ${me} make?`],
    'n-runs-runner': [`${me}跟${k.runner.name}结伴跑步一共几回？`, `How many times did ${me} go running with ${k.runner.name}?`],
    'n-meals-friend': [`${me}和${k.friend.name}一起下馆子总共几次？`, `How many meals out did ${me} have with ${k.friend.name}?`],
  } : {
    'n-trips': [`Over these three months, how many trips home to ${k.hometown} did ${me} make in all?`, `这三个月里${me}回了几次${k.hometown}？`],
    'n-purchases': [`How many separate purchases above ${threshold} did ${me} make?`, `${me}买了几件超过${threshold}的东西？`],
    'n-runs-runner': [`How many runs did ${me} share with ${k.runner.name}?`, `${me}和${k.runner.name}一起跑过几次步？`],
    'n-meals-friend': [`How often did ${me} and ${k.friend.name} eat out together?`, `${me}和${k.friend.name}一起在外面吃过几次饭？`],
  };
  for (const [id, [pp, xl]] of Object.entries(variants)) {
    const b = tasks.find((t) => t.id === id);
    if (!b) continue;
    tasks.push(paraphraseOf(b, pp), crossLingualOf(b, xl, other));
  }
  return { tasks, skipped };
}

/** Gold alias clusters of the cast: every way the sources name each person, and the new company. */
export function ledgerAliases(k: Cast, lang: Lang): GoldAlias[] {
  const roles: Role[] = ['mother', 'sibling', 'friend', 'runner', 'manager', 'partner'];
  const out: GoldAlias[] = roles.map((role) => {
    const key = personKey(k, role, lang);
    return { canonical: key.label, aliases: [key.label, ...key.aliases], kind: 'person', context: [role] };
  });
  out.push({ canonical: k.me.name, aliases: [k.me.name], kind: 'person', context: ['me'] });
  out.push({ canonical: k.newCo, aliases: [k.newCo, k.newCoShort], kind: 'organization' });
  return out;
}

/* --------------------------- closed-world checks --------------------------- */

const RUN_RE: Record<Lang, RegExp> = { zh: /(\d+(?:\.\d+)?)\s*公里/g, en: /(\d+(?:\.\d+)?)\s*(?:km|kilomet(?:er|re)s?)\b/gi };
const BP_RE = /(?<![\d/])(\d{2,3})\s*\/\s*(\d{2,3})(?![\d/])/g;

/** Remove whitespace: a phrase the renderer spaced differently is still the phrase. */
export const compact = (s: string) => s.replace(/\s+/g, '');

/**
 * Distances and blood-pressure readings a document states that no event
 * planted in it: a filler that adds a run, or an event document that adds a
 * reading, would make a closed list's gold wrong. Returns the series it
 * breaks ('run', 'bp') with the offending text.
 */
export function seriesViolations(lang: Lang, text: string, planted: ScriptEvent[]): { series: 'run' | 'bp'; found: string }[] {
  const out: { series: 'run' | 'bp'; found: string }[] = [];
  const runs = new Set(planted.filter((e) => e.cat === 'run').map((e) => e.value));
  for (const m of text.matchAll(RUN_RE[lang])) if (!runs.has(Number(m[1]))) out.push({ series: 'run', found: m[0] });
  const bps = new Set(planted.filter((e) => e.cat === 'bp').map((e) => e.item!.label));
  for (const m of text.matchAll(BP_RE)) {
    const [sys, dia] = [Number(m[1]), Number(m[2])];
    if (sys < 90 || sys > 220 || dia < 50 || dia > 140) continue;
    if (!bps.has(`${sys}/${dia}`)) out.push({ series: 'bp', found: m[0] });
  }
  return out;
}

/** Tasks that rest on a series: dropped when a document breaks it. */
export const SERIES_TASKS: Record<'run' | 'bp', RegExp> = {
  run: /^(l-runs|n-runs|t-long-runs|t-weekly-km|p-runner|sq-km|sq-runs)/,
  bp: /^(t-bp|l-bp|n-bp|p-mother)/,
};
