import fs from 'node:fs';
import path from 'node:path';
import type { Task } from '../types.js';
import { registerRecipe, RecipeContext } from './index.js';
import { finishRealPack, localRecord, opaquePath, packIdFor, plainNumber, questionCount, roundingTolerance, sampleByStratum, shortHash, sourceDir, type Family } from './real-docs.js';
import { PackWriter } from './writer.js';

/**
 * real-loong-finance (docs/design/33 §4): the financial-report half of Loong
 * (Wang et al., EMNLP 2024, Apache-2.0) — 574 quarterly reports of A-share
 * companies and annual reports (10-K) of US companies, whole and in their
 * own text, as one shared corpus, and Loong's 700 financial questions over
 * them: lookups (level 1, the control), comparisons (2), groupings by a
 * threshold (3) and trends across years (4). Loong hands each question its
 * own handful of reports; here every question is asked of the whole corpus,
 * so a comparison names the companies it compares (as Loong's prompt did by
 * handing over their reports) and a question that names no company gets the
 * one its reports are about. Legal cases and papers are left out: their
 * questions point at documents by their position in the prompt.
 *
 * Download: `downloads/loong/` holds loong.jsonl and doc.zip from the
 * repository's README, unpacked to `extracted/doc/` (see its SOURCE.md).
 */

interface LoongRow {
  id: string;
  type: string;
  level: number;
  set: number;
  length: number;
  language: 'zh' | 'en';
  question: string;
  instruction: string;
  doc: string[];
  answer: unknown;
}

interface Report {
  file: string;
  path: string;
  lang: 'zh' | 'en';
  /** The company as the file names it (or as the report's cover names its registrant). */
  company: string;
  title: string;
  year: string;
}

const LICENSE = 'Apache-2.0 (Loong); the reports are public company filings';
const LEVELS: Record<number, { type: Task['type']; family: Family; name: string }> = {
  1: { type: 'single-hop', family: 'controls', name: 'spotlight locating' },
  2: { type: 'comparison', family: 'aggregates', name: 'comparison' },
  3: { type: 'aggregation', family: 'aggregates', name: 'clustering' },
  4: { type: 'temporal', family: 'timelines', name: 'chain of reasoning' },
};

/** The registrant a 10-K's cover names: the line above "(Exact name of registrant …)". */
export function registrantOf(text: string): string | null {
  const i = text.search(/\(\s*exact name of (the )?registrant/i);
  if (i < 0) return null;
  // the name, not a "(Formerly …)" line between it and the caption
  const lines = text.slice(Math.max(0, i - 600), i).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l && !l.startsWith('(') && !/^[-_=* ]+$/.test(l));
  const name = lines.at(-1);
  return name && name.length <= 120 && /[A-Za-z]/.test(name) ? name : null;
}

/** A report's company, title and year from its file name (and its cover, for US files that do not name the company). */
export function describeReport(file: string, text: string): Omit<Report, 'path'> {
  const stem = file.replace(/\.txt$/, '');
  const zh = stem.match(/^report_(\d{6})-(\d{4})-([^-]+)-(.+)$/);
  if (zh) return { file, lang: 'zh', company: zh[3], year: zh[2], title: `${zh[3]}（${zh[1]}）${zh[4].replace(new RegExp(`^${zh[3]}`), '')}` };
  const zhShort = stem.match(/^(\d{4})-([^-]+)-(.+)$/);
  if (zhShort && /[㐀-鿿]/.test(stem)) return { file, lang: 'zh', company: zhShort[2], year: zhShort[1], title: `${zhShort[2]} ${zhShort[3]}` };
  const en = stem.match(/^(\d{4})-(.+)-([a-z])$/);
  if (en && !/form ?10-?k|10-?k/i.test(stem)) return { file, lang: 'en', company: en[2], year: en[1], title: `${en[2]} annual report (Form 10-K), ${en[1]} file` };
  const year = stem.match(/^(\d{4})/)?.[1] ?? '';
  const company = registrantOf(text) ?? stem;
  return { file, lang: 'en', company, year, title: `${company} annual report (Form 10-K), ${year} file` };
}

/** Loong's own lookup of a document name: `*2024-<name>*.txt` for levels 1–3, `*<name>*.txt` for level 4 — but only when it is unique. */
export function resolveDoc(files: string[], name: string, level: number): string | null {
  const want = level === 4 ? name : `2024-${name}`;
  const hits = files.filter((f) => f.endsWith('.txt') && f.includes(want));
  if (hits.length === 1) return hits[0];
  // a name that is the whole company part of the file name wins over names it is a prefix of
  const exact = hits.filter((f) => new RegExp(`(^|-)${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[^-]+\\.txt$`).test(f));
  return exact.length === 1 ? exact[0] : null;
}

const zhList = (xs: string[]) => xs.join('、');
const enList = (xs: string[]) => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** The question as one asks it of the whole corpus: the companies it compares, the company its reports are about. */
export function scopedQuestion(row: LoongRow, reports: Report[], ambiguous: (r: Report) => boolean): string {
  const q = row.question.trim();
  const names = [...new Set(reports.map((r) => r.company))];
  if (row.level === 2 || row.level === 3) {
    return row.language === 'zh' ? `考虑以下公司的2024年财报：${zhList(names)}。${q}` : `Consider the 2024 reports of these companies: ${enList(names)}. ${q}`;
  }
  const named = (n: string) => q.toLowerCase().includes(n.toLowerCase()) || q.toLowerCase().includes(n.toLowerCase().replace(/[,.]?\s*(inc|corp|co|ltd|llc|l\.p)\.?$/i, '').trim());
  if (row.level === 1) {
    const r = reports[0];
    const period = row.language === 'zh' ? `（依据其${r.title.replace(/^.*?）/, '').replace(new RegExp(`^${r.company}\\s*`), '')}）` : ` (from its ${r.year} report)`;
    const scoped = ambiguous(r) ? `${q.replace(/[？?]$/, '')}${period}${row.language === 'zh' ? '？' : '?'}` : q;
    return named(r.company) ? scoped : row.language === 'zh' ? `（${r.company}）${scoped}` : `For ${r.company}: ${scoped}`;
  }
  return names.some(named) ? q : row.language === 'zh' ? `（${zhList(names)}）${q}` : `For ${enList(names)}: ${q}`;
}

/** The gold of a level-3 grouping: one item per company, its group as the second field. */
function groupItems(answer: Record<string, string[]>, reports: Report[]) {
  const items = Object.entries(answer).flatMap(([group, members]) => (Array.isArray(members) ? members : []).map((m) => ({ label: `${m}: ${group}`, fields: [[m], [group]], aliases: [], weight: 1 })));
  return items.map((it) => ({ ...it, docs: reports.filter((r) => r.company === it.fields[0][0]).map((r) => r.path) }));
}

export function loongTasks(rows: LoongRow[], reports: Map<string, Report>, files: string[], log: (m: string) => void): Task[] {
  const byCompany = new Map<string, Report[]>();
  for (const r of reports.values()) (byCompany.get(r.company) ?? byCompany.set(r.company, []).get(r.company)!).push(r);
  const ambiguous = (r: Report) => (byCompany.get(r.company)?.length ?? 0) > 1;
  const tasks: Task[] = [];
  const dropped: Record<string, number> = {};
  const drop = (why: string) => (dropped[why] = (dropped[why] ?? 0) + 1);
  for (const row of rows) {
    if (row.type !== 'financial') continue;
    const level = LEVELS[row.level];
    const resolved = row.doc.map((d) => resolveDoc(files, d, row.level));
    if (resolved.some((f) => !f)) {
      drop('a document name that does not resolve to one report');
      continue;
    }
    const docs = resolved.map((f) => reports.get(f!)!);
    // a lookup's evidence is the report of the company it names; the others were Loong's distractors
    let evidence = docs;
    if (row.level === 1) {
      const named = docs.filter((r) => row.question.toLowerCase().includes(r.company.toLowerCase()));
      if (named.length !== 1) {
        drop('a lookup that names none or several of its companies');
        continue;
      }
      evidence = named;
    }
    const question = scopedQuestion(row, evidence, ambiguous);
    const base = {
      id: `loong-${row.id.slice(0, 8)}-${shortHash(row.id).slice(0, 4)}`,
      suite: 'usage' as const,
      lang: row.language,
      question,
      evidence: evidence.map((r) => ({ doc: r.path })),
      meta: {
        source: 'loong', datasetId: row.id, datasetType: level.name, level: row.level, set: row.set, family: level.family,
        hops: row.level === 1 ? 1 : evidence.length, stratum: `${row.language}-L${row.level}`, ...(question !== row.question ? { originalQuestion: row.question } : {}),
      },
    };
    const a = row.answer;
    if (row.level === 3 && a && typeof a === 'object' && !Array.isArray(a)) {
      const items = groupItems(a as Record<string, string[]>, evidence);
      if (!items.length || items.some((it) => !it.docs.length)) {
        drop('a grouping whose members are not its companies');
        continue;
      }
      tasks.push({ ...base, type: level.type, scoring: 'set', items, list: { match: 'fields', ordered: false, maxItems: Math.max(10, items.length + 2), requireDocs: false, primary: 'exact' } });
    } else if (Array.isArray(a)) {
      const members = a.map(String);
      tasks.push({ ...base, type: level.type, scoring: 'set', items: members.map((m) => ({ label: m, aliases: [], weight: 1, docs: evidence.filter((r) => r.company === m).map((r) => r.path) })), list: { match: 'alias', ordered: false, maxItems: Math.max(10, members.length + 2), requireDocs: false, primary: 'exact' } });
    } else if (typeof a === 'string' && a.trim()) {
      const plain = row.level === 1 ? plainNumber(a) : null;
      if (plain) tasks.push({ ...base, type: 'numeric', scoring: 'value', answer: a.trim(), answers: [...new Set([a.trim(), plain])], meta: { ...base.meta, tolerance: roundingTolerance(plain) } });
      else tasks.push({ ...base, type: level.type, scoring: row.level === 4 ? 'judge' : 'exact', answer: a.trim() });
    } else {
      drop('an answer of another shape');
    }
  }
  for (const [why, n] of Object.entries(dropped)) log(`Loong: ${n} questions left out — ${why}`);
  return tasks;
}

async function buildLoong(dir: string, ctx: RecipeContext) {
  const from = sourceDir(ctx, 'loong');
  const docDir = path.join(from, 'extracted', 'doc', 'financial');
  if (!fs.existsSync(docDir)) throw new Error(`${docDir} is missing: unpack doc.zip into ${path.join(from, 'extracted')} (SOURCE.md)`);
  const rows = fs.readFileSync(path.join(from, 'loong.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as LoongRow);
  const files = fs.readdirSync(docDir).filter((f) => f.endsWith('.txt')).sort();
  const reports = new Map<string, Report>();
  const texts = new Map<string, string>();
  for (const f of files) {
    const text = fs.readFileSync(path.join(docDir, f), 'utf8');
    const d = describeReport(f, text);
    reports.set(f, { ...d, path: opaquePath(`filings/${d.lang}`, f) });
    texts.set(f, text);
  }
  const all = loongTasks(rows, reports, files, ctx.log);
  const n = questionCount(ctx);
  const tasks = n ? sampleByStratum(all, n, ctx.seed ?? 0) : all;
  const writer = new PackWriter(dir, {
    id: packIdFor('real-loong-finance', n, all.length),
    version: 1,
    title: 'Loong financial reports: lookups, comparisons, groupings and trends over whole filings',
    domain: 'finance',
    languages: ['zh', 'en'],
    description: `${tasks.length} of Loong's ${all.length} usable financial questions (stratified by language and level) over all ${files.length} reports as one corpus: A-share quarterly reports (Chinese) and US 10-K annual reports (English), each whole. Lookups are scored by value, comparisons by exact match, groupings as sets matched by company and group, trends by the judge.`,
    builder: { recipe: 'real-loong-finance', options: { questions: n ?? 'all' } },
  });
  writer.addSource(localRecord(from, 'loong.jsonl', LICENSE, 'Loong questions (Wang et al., 2024), repository MozerWang/Loong'));
  writer.addSource(localRecord(from, 'doc.zip', LICENSE, 'Loong documents: financial/ used, legal/ and paper/ not'));
  for (const f of files) {
    const r = reports.get(f)!;
    writer.addDoc({ path: r.path, title: r.title, lang: r.lang, source: 'loong', kind: r.lang === 'zh' ? 'quarterly-report' : 'annual-report-10k', ...(r.year ? { date: r.year } : {}) }, `# ${r.title}\n\n${texts.get(f)!.trim()}\n`);
  }
  ctx.log(`Loong: ${tasks.length} questions over ${files.length} reports`);
  return finishRealPack(writer, tasks, ctx);
}

export function registerLoongRecipe(): void {
  registerRecipe({ id: 'real-loong-finance', title: 'Loong financial reports (zh A-share quarterlies, en 10-Ks): lookup, comparison, grouping, trend', domain: 'finance', network: false, needsAuthor: false, build: buildLoong });
}
