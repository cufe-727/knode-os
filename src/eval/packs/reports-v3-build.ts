import { seededKey } from '../pack.js';
import type { GoldAlias } from '../types.js';
import type { RecipeContext } from './index.js';
import { factIndex, renderDivision, V3Doc } from './reports-v3-render.js';
import { v3Tasks, V3_FAMILY_MIN, V3_STRATUM_MIN } from './reports-v3-tasks.js';
import { customerNameAt, Lang, makeV3World, V3_CORPUS, V3_WEEKS, V3Division, weekLabel } from './reports-v3.js';
import type { Draft } from './separation.js';
import { PackWriter } from './writer.js';

/**
 * Builds a recipe-v3 pack (docs/design/33 §4): `synthetic-reports-<lang>` with
 * `{"version": 3}`. Options: `size` (divisions: 1, 10, 100), `layout`
 * ("by-week", the default: 周报/2025-W34/<hash>.md, so a path says nothing
 * about the team; "by-team" for comparison), `taskDivisions` (whose own
 * questions are asked; default 1 — the scale curve's like-for-like questions).
 * With more than one division the pack adds company-wide aggregates and hops
 * that cross from one division into the next.
 */

export const REPORTS_V3_VERSION = 3;

const FOLDERS: Record<Lang, Record<V3Doc['kind'], string>> = {
  zh: { 'weekly-report': '周报', 'pmo-summary': '月报', 'quarterly-review': '季度复盘', postmortem: '事故复盘', minutes: '会议纪要' },
  en: { 'weekly-report': 'weekly', 'pmo-summary': 'monthly', 'quarterly-review': 'quarterly', postmortem: 'postmortems', minutes: 'minutes' },
};

export async function buildReportsV3(lang: Lang, dir: string, ctx: RecipeContext) {
  const size = Math.max(1, Math.floor(Number(ctx.options.size ?? 1)));
  const layout = ctx.options.layout === 'by-team' ? 'by-team' : 'by-week';
  const taskDivisions = Math.max(1, Math.min(size, Math.floor(Number(ctx.options.taskDivisions ?? 1))));
  const seed = String(ctx.seed ?? 0);
  const zh = lang === 'zh';
  const world = makeV3World(lang, seed, size);
  const teamNames = new Map(world.divisions.flatMap((s) => s.teams.map((t) => [t.id, t.name] as const)));
  const teamName = (id: string) => teamNames.get(id)!;
  const sizeTag = size > 1 ? `-x${size}` : '';
  const w = new PackWriter(dir, {
    id: `synthetic-reports-${lang}-v3${sizeTag}${layout === 'by-team' ? '-by-team' : ''}`,
    version: REPORTS_V3_VERSION,
    title: zh ? `合成周报 v3：${size > 1 ? `${size}个事业部` : '三个组'}的两年半` : `Synthetic weekly reports v3: two and a half years of ${size > 1 ? `${size} divisions` : 'three teams'}`,
    domain: 'synthetic',
    languages: [lang],
    description: 'Recipe v3 (docs/design/33 §4): 130 weeks (2024-W01 … 2026-W26) of weekly reports, PMO monthly summaries that correct weekly figures and say they prevail, quarterly reviews, incident postmortems and monthly meeting minutes of 5,000–20,000 characters, rendered from a seeded script (no model). Weeks 1–122 are the corpus, 123–126 four update batches, 127–130 the holdout. Files by week, not by team. Families of design 33 §3 with gold from the script.',
    builder: { recipe: `synthetic-reports-${lang}`, options: { version: 3, seed, size, layout, taskDivisions } },
    holdout: 'holdout/script.json (the whole script) and holdout/weeks-127-130/ (the reports after the update stream).',
    lint: { families: V3_FAMILY_MIN, strata: V3_STRATUM_MIN },
  });
  const paths = new Map<string, string>();
  const city = (div: number) => world.divisions[div].city;
  const pathOf = (d: V3Doc) => {
    const hash = seededKey(seed, d.id).slice(0, 10);
    const folder = FOLDERS[lang][d.kind];
    if (layout === 'by-team') return `${folder}/${d.team ? teamName(d.team) : city(d.div)}/${hash}.md`;
    return `${folder}/${d.kind === 'weekly-report' ? weekLabel(d.week) : d.period}/${hash}.md`;
  };
  const corpus = new Map<string, V3Doc>();
  const all = new Map<string, V3Doc>();
  for (const s of world.divisions) {
    for (const d of renderDivision(lang, s, teamName)) {
      const p = pathOf(d);
      paths.set(d.id, p);
      all.set(d.id, d);
      const meta = { path: p, title: d.title, date: d.date, ...(d.author ? { author: d.author } : {}), lang, kind: d.kind };
      if (d.week <= V3_CORPUS) {
        w.addDoc(meta, d.text);
        corpus.set(d.id, d);
      } else if (d.week <= V3_CORPUS + 4) w.addUpdate(String(d.week - V3_CORPUS).padStart(2, '0'), p, d.text);
      else w.addHoldout(`weeks-127-130/${p}`, d.text);
    }
    for (const a of aliasClusters(s, teamName)) w.addAlias(a);
  }
  const idx = factIndex([...corpus.values()]);
  const ctxOf = (s: V3Division) => ({ lang, s, idx, docs: all, pathOf: (id: string) => paths.get(id)!, teamName });
  const keep = (t: Draft) => t.evidence.every((e) => w.hasDoc(e.doc) || t.afterUpdate);
  const tasks: Draft[] = [];
  world.divisions.slice(0, taskDivisions).forEach((s, d) => {
    const prefix = d === 0 ? '' : `d${d + 1}-`;
    for (const t of v3Tasks(ctxOf(s)).filter(keep)) tasks.push({ ...t, id: prefix + t.id, ...(t.meta?.of ? { meta: { ...t.meta, of: prefix + String(t.meta.of) } } : {}) });
  });
  if (size > 1) {
    tasks.push(...companyTasks(lang, world.divisions, paths, teamName));
    // hops that cross divisions: the second division and the third, merged
    if (size >= 3) {
      const merged = mergeDivisions(world.divisions.slice(1, 3));
      tasks.push(...v3Tasks(ctxOf(merged), { hops: 'cross' }).filter(keep).map((t) => ({ ...t, id: `x-${t.id}` })));
    }
  }
  for (const t of tasks) w.addTask(markRules(t, world.divisions));
  w.addHoldout('script.json', JSON.stringify({ lang, seed, divisions: world.divisions.slice(0, Math.max(3, taskDivisions)) }, null, size > 1 ? 0 : 1));
  w.setProfile({ styles: Object.assign({}, ...world.divisions.map((s) => s.styles)) });
  ctx.log(`synthetic-reports-${lang} v3: ${w.docCount} documents, ${w.taskCount} tasks, ${size} division(s), ${layout}`);
  return w.finish();
}

/** Whether a question names a team (as the documents do) and an exact id: the rules design 33 §3 counts. */
function markRules(t: Draft, divisions: V3Division[]): Draft {
  const names = divisions.flatMap((s) => s.teams.flatMap((x) => [x.name, x.alt]));
  const namesTeam = names.some((n) => t.question.includes(n));
  const exactId = /\b(?:INC-\d+|R-\d+|(?:PLT|PAY|GRW)\d+-C\d)\b/.test(t.question);
  return { ...t, meta: { ...(t.meta ?? {}), namesTeam, exactId } };
}

/** The company as a whole: counts over every division's reports (their gold changes with the size). */
function companyTasks(lang: Lang, divisions: V3Division[], paths: Map<string, string>, teamName: (id: string) => string): Draft[] {
  const zh = lang === 'zh';
  const out: Draft[] = [];
  const conv = zh ? '（周报按其周一的日期计入季度和年份。）' : ' (A weekly report counts in the quarter and year of its Monday.)';
  const incs = divisions.flatMap((s) => s.incidents.filter((i) => i.week <= V3_CORPUS));
  const ev = (ids: string[]) => [...new Set(ids.map((id) => paths.get(id)!).filter(Boolean))].map((doc) => ({ doc }));
  const quarters = [...new Set(incs.map((i) => quarterOfWeek(i.week)))].filter((q) => q <= '2026-Q1');
  // the quarterly reviews restate each team's counts
  const qrs = (q: string) => divisions.flatMap((s) => s.teams.map((t) => `qr|${t.id}|${q}`)).filter((id) => paths.has(id));
  for (const q of quarters) {
    const mine = incs.filter((i) => quarterOfWeek(i.week) === q);
    const [y, n] = [q.slice(0, 4), q.slice(-1)];
    const qn = zh ? `${y}年第${['', '一', '二', '三', '四'][Number(n)]}季度` : `Q${n} ${y}`;
    out.push({ id: `co-inc-${q}`, suite: 'usage', type: 'structured', lang, scoring: 'count', answer: String(mine.length),
      question: zh ? `${qn}，全公司所有组报告的事故合计多少起？${conv}` : `In ${qn}, how many incidents did the teams report in all, in every city?${conv}`, evidence: ev([...mine.map((i) => `w|${i.team}|${i.week}`), ...qrs(q)]), meta: { family: 'aggregate', scope: 'company', aggregate: 'count' } });
    const p1 = mine.filter((i) => i.sev === 'P1');
    out.push({ id: `co-p1-${q}`, suite: 'usage', type: 'structured', lang, scoring: 'count', answer: String(p1.length),
      question: zh ? `${qn}，全公司所有组合计出过几起P1事故？${conv}` : `In ${qn}, how many P1 incidents did the teams have, in every city?${conv}`, evidence: ev([...p1.map((i) => `w|${i.team}|${i.week}`), ...qrs(q)]), meta: { family: 'aggregate', scope: 'company', aggregate: 'count' } });
  }
  for (const y of [2024, 2025]) {
    const p1 = incs.filter((i) => i.sev === 'P1' && i.minutes && i.week + 2 <= V3_CORPUS && String(new Date(Date.UTC(2024, 0, 1 + (i.week - 1) * 7)).getUTCFullYear()) === String(y));
    const sum = p1.reduce((a, i) => a + i.minutes!, 0);
    out.push({ id: `co-minutes-${y}`, suite: 'usage', type: 'structured', lang, scoring: 'value', answer: String(sum),
      question: zh ? `${y}年，全公司有复盘报告的P1事故影响时长合计多少分钟？${conv}` : `In ${y}, what was the total duration of impact, in minutes, of the P1 incidents of every city's teams that have a postmortem?${conv}`, evidence: ev(p1.map((i) => `pm|${i.id}`)), meta: { family: 'aggregate', scope: 'company', aggregate: 'sum' } });
    const hired = divisions.flatMap((s) => s.people.filter((p) => p.joined > 1 && new Date(Date.UTC(2024, 0, 1 + (p.joined - 1) * 7)).getUTCFullYear() === y && p.joined <= V3_CORPUS));
    out.push({ id: `co-hired-${y}`, suite: 'usage', type: 'structured', lang, scoring: 'count', answer: String(hired.length),
      question: zh ? `${y}年，全公司所有组一共新招了几个人？${conv}` : `How many people did the teams of every city hire in ${y}?${conv}`, evidence: ev(hired.map((p) => `w|${p.team}|${p.joined}`)), meta: { family: 'aggregate', scope: 'company', aggregate: 'count' } });
  }
  void teamName;
  return out.filter((t) => t.evidence.length >= 21);
}

const quarterOfWeek = (w: number) => {
  const d = new Date(Date.UTC(2024, 0, 1 + (w - 1) * 7));
  return `${d.getUTCFullYear()}-Q${Math.ceil((d.getUTCMonth() + 1) / 3)}`;
};

/** Two divisions as one, for chains that cross from one into the other. */
function mergeDivisions(ds: V3Division[]): V3Division {
  const uniq = <T extends { id: string }>(xs: T[]) => [...new Map(xs.map((x) => [x.id, x])).values()];
  return {
    ...ds[0], teams: ds.flatMap((d) => d.teams), people: uniq(ds.flatMap((d) => d.people)), projects: ds.flatMap((d) => d.projects), incidents: ds.flatMap((d) => d.incidents),
    risks: ds.flatMap((d) => d.risks), settings: ds.flatMap((d) => d.settings), customers: ds.flatMap((d) => d.customers), metricFixes: ds.flatMap((d) => d.metricFixes),
    twins: ds.flatMap((d) => d.twins), styles: Object.assign({}, ...ds.map((d) => d.styles)), okr: Object.assign({}, ...ds.map((d) => d.okr)),
  };
}

/** Gold alias clusters: people (namesakes told apart by team; nicknames), teams, projects (renames), customers (renames), settings (name, code, short). */
export function aliasClusters(s: V3Division, teamName: (id: string) => string): GoldAlias[] {
  const out: GoldAlias[] = [];
  for (const p of s.people.filter((x) => s.teams.some((t) => t.id === x.team))) {
    const twin = s.twins.includes(p.name);
    out.push({ canonical: twin ? `${p.name} (${teamName(p.team)})` : p.name, aliases: [p.name, ...(p.nick ? [p.nick.text] : [])], kind: 'person', ...(twin ? { context: [teamName(p.team), ...(p.move ? [teamName(p.move.team)] : [])] } : {}) });
  }
  for (const t of s.teams) out.push({ canonical: t.name, aliases: [t.name, t.alt], kind: 'team' });
  for (const p of s.projects) out.push({ canonical: p.name, aliases: [p.name, ...(p.rename ? [p.rename.to] : [])], kind: 'project', context: [teamName(p.team)] });
  for (const c of s.customers) out.push({ canonical: c.name, aliases: [c.name, ...(c.rename ? [c.rename.to] : [])], kind: 'customer' });
  for (const x of s.settings) out.push({ canonical: `${x.name} (${teamName(x.team)})`, aliases: [x.name, x.id, x.short], kind: 'setting', context: [teamName(x.team)] });
  void customerNameAt;
  void V3_WEEKS;
  return out;
}
