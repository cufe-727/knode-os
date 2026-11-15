import fs from 'node:fs';
import path from 'node:path';
import type { Task } from '../types.js';
import { registerRecipe, RecipeContext } from './index.js';
import { finishRealPack, localRecord, opaquePath, packIdFor, questionCount, sampleByStratum, shortHash, sourceDir, type Family } from './real-docs.js';
import { PackWriter } from './writer.js';

/**
 * real-crud-news-zh (docs/design/33 §4, the scale pack): CRUD-RAG (Lyu et
 * al., 2024; README: Apache-2.0) — about 92,000 Chinese news articles of
 * July–August 2023 as one corpus, and its question-answering tasks over one,
 * two or three of them (2,394 questions; gold answers written with the
 * dataset, judged). The point is the corpus's size: a term that names an
 * event matches hundreds of articles, so a grep's hits no longer fit.
 *
 * Each question comes with the news excerpts it was written from. An
 * excerpt is mapped to the corpus article it was cut from (the same opening,
 * or the same sentence start inside it); an excerpt the corpus does not hold
 * (most single-document questions') becomes an article of its own. Two
 * excerpts of one article are one evidence document, so `meta.hops` counts
 * distinct articles.
 *
 * Download: `downloads/crud-rag/data/80000_docs/*` and
 * `data/crud_split/split_merged.json` from the repository (SOURCE.md).
 */

interface CrudQa {
  ID: string;
  event: string;
  news1: string;
  news2?: string;
  news3?: string;
  questions: string;
  answers: string;
}

const LICENSE = 'Apache-2.0 (CRUD-RAG README badge; the repository has no LICENSE file); the news texts belong to their publishers';
const KEY = 24;

const squash = (s: string) => s.replace(/\s+/g, '');
/** An article's body: what follows its "<time>，正文：" header. */
export const bodyOf = (s: string) => {
  const t = squash(s);
  const i = t.indexOf('正文：');
  return i >= 0 ? t.slice(i + 3) : t;
};

/** The date an article's header gives (2023-08-16 18:24:57, 08/16 13:50, [ 2023-07-28 16：40 ]); the year is 2023 when it gives none. */
export function dateOf(s: string): string | undefined {
  const head = s.slice(0, 60).normalize('NFKC');
  const full = head.match(/(20\d\d)[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (full) return `${full[1]}-${full[2].padStart(2, '0')}-${full[3].padStart(2, '0')}`;
  const short = head.match(/^\D{0,3}(\d{1,2})[-/](\d{1,2})\s/);
  return short ? `2023-${short[1].padStart(2, '0')}-${short[2].padStart(2, '0')}` : undefined;
}

/** Where an excerpt starts inside the articles: their openings and every sentence start, by their first KEY characters. */
export class ExcerptIndex {
  private keys = new Map<string, number[]>();
  constructor(private readonly bodies: string[]) {
    bodies.forEach((b, i) => {
      this.add(b.slice(0, KEY), i);
      for (const m of b.matchAll(/[。！？；]/g)) if (m.index! + 1 + KEY <= b.length) this.add(b.slice(m.index! + 1, m.index! + 1 + KEY), i);
    });
  }

  private add(k: string, i: number) {
    if (k.length < KEY) return;
    const l = this.keys.get(k);
    if (!l) this.keys.set(k, [i]);
    else if (l.at(-1) !== i) l.push(i);
  }

  /** The article an excerpt was cut from: one whose text holds its opening (and, of several, the one that also holds its end). */
  find(excerpt: string): number | null {
    const b = bodyOf(excerpt);
    if (!b) return null;
    // an excerpt shorter than a key: the first article that holds it (rare, so a scan)
    if (b.length < KEY) {
      const i = this.bodies.findIndex((x) => x.includes(b));
      return i >= 0 ? i : null;
    }
    let cands = this.keys.get(b.slice(0, KEY)) ?? [];
    if (!cands.length) {
      // an excerpt that starts mid-sentence: its first full sentence
      const m = b.match(/[。！？；]/);
      if (m && m.index! + 1 + KEY <= b.length) cands = this.keys.get(b.slice(m.index! + 1, m.index! + 1 + KEY)) ?? [];
    }
    if (!cands.length) return null;
    const tail = b.slice(-KEY);
    const whole = cands.filter((i) => this.bodies[i].includes(tail));
    return (whole.length ? whole : cands)[0];
  }
}

export function crudTasks(sets: Record<string, CrudQa[]>, evidenceOf: (excerpt: string) => string): Task[] {
  const tasks: Task[] = [];
  for (const [key, n] of [['questanswer_1doc', 1], ['questanswer_2docs', 2], ['questanswer_3docs', 3]] as const) {
    (sets[key] ?? []).forEach((q, k) => {
      const excerpts = [q.news1, q.news2, q.news3].slice(0, n).filter((x): x is string => Boolean(x && x.trim()));
      const docs = [...new Set(excerpts.map(evidenceOf))];
      const hops = docs.length;
      const family: Family = hops === 1 ? 'controls' : 'hops';
      tasks.push({
        id: `crud-${n}d-${q.ID.slice(-8)}-${shortHash(key, String(k), q.questions).slice(0, 4)}`, suite: 'usage', type: hops === 1 ? 'single-hop' : 'multi-hop', lang: 'zh',
        question: q.questions.trim(), answer: q.answers.trim(), scoring: 'judge', evidence: docs.map((doc) => ({ doc })), primary: true,
        meta: { source: 'crud-rag', datasetId: q.ID, datasetType: key, family, hops, stratum: `crud-${n}doc`, event: q.event },
      });
    });
  }
  return tasks;
}

async function buildCrud(dir: string, ctx: RecipeContext) {
  const from = sourceDir(ctx, 'crud-rag');
  const docDir = path.join(from, 'data', '80000_docs');
  const parts = fs.readdirSync(docDir).filter((f) => f.startsWith('documents_')).sort();
  const raw: string[] = [];
  const seen = new Set<string>();
  for (const f of parts) for (const line of fs.readFileSync(path.join(docDir, f), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    raw.push(t);
  }
  ctx.log(`CRUD-RAG: ${raw.length} distinct articles in ${parts.length} files`);
  const bodies = raw.map(bodyOf);
  const index = new ExcerptIndex(bodies);
  const extra = new Map<string, string>();
  const pathOfIdx = (i: number) => opaquePath('news', `corpus|${i}|${bodies[i].slice(0, 40)}`);
  let mapped = 0;
  const evidenceOf = (excerpt: string) => {
    const i = index.find(excerpt);
    if (i !== null) {
      mapped++;
      return pathOfIdx(i);
    }
    const p = opaquePath('news', `excerpt|${bodyOf(excerpt)}`);
    extra.set(p, excerpt.trim());
    return p;
  };
  const sets = JSON.parse(fs.readFileSync(path.join(from, 'data', 'crud_split', 'split_merged.json'), 'utf8')) as Record<string, CrudQa[]>;
  const all = crudTasks(sets, evidenceOf);
  ctx.log(`CRUD-RAG: ${mapped} excerpts found in the corpus, ${extra.size} added as articles of their own`);
  const n = questionCount(ctx);
  const tasks = n ? sampleByStratum(all, n, ctx.seed ?? 0) : all;
  const writer = new PackWriter(dir, {
    id: packIdFor('real-crud-news-zh', n, all.length),
    version: 1,
    title: 'CRUD-RAG: questions over one to three of 92,000 Chinese news articles',
    domain: 'public',
    languages: ['zh'],
    description: `${tasks.length} CRUD-RAG question-answering tasks (one, two or three source articles; judged against the dataset's answers) over ${raw.length + extra.size} Chinese news articles from July–August 2023, one file each.`,
    builder: { recipe: 'real-crud-news-zh', options: { questions: n ?? 'all' } },
  });
  writer.addSource(localRecord(from, 'data/crud_split/split_merged.json', LICENSE, 'CRUD-RAG tasks (github.com/IAAR-Shanghai/CRUD_RAG); the questanswer_1doc/2docs/3docs sets are used'));
  writer.addSource({ url: 'https://github.com/IAAR-Shanghai/CRUD_RAG/tree/main/data/80000_docs', license: LICENSE, note: `${parts.length} files, one article per line; sha256 of each in the download's SHA256SUMS` });
  raw.forEach((t, i) => {
    const date = dateOf(t);
    writer.addDoc({ path: pathOfIdx(i), ...(date ? { date } : {}), lang: 'zh', source: 'crud-rag', kind: 'news' }, `${t}\n`);
  });
  for (const [p, t] of extra) {
    const date = dateOf(t);
    writer.addDoc({ path: p, ...(date ? { date } : {}), lang: 'zh', source: 'crud-rag', kind: 'news' }, `${t}\n`);
  }
  return finishRealPack(writer, tasks, ctx);
}

export function registerCrudRecipe(): void {
  registerRecipe({ id: 'real-crud-news-zh', title: 'CRUD-RAG: 1–3-article questions over 92,000 Chinese news articles (zh)', domain: 'public', network: false, needsAuthor: false, build: buildCrud });
}
