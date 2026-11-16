import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { GoldItem, Task } from '../types.js';
import { registerRecipe, RecipeContext } from './index.js';
import { finishRealPack, localRecord, opaquePath, packIdFor, plainNumber, questionCount, sampleByStratum, sourceDir, type Family } from './real-docs.js';
import { wikitextToText } from './wikitext.js';
import { PackWriter } from './writer.js';

/**
 * real-wiki-hops (docs/design/33 §4): two published benchmarks whose
 * questions need many whole Wikipedia articles, over one shared corpus of
 * every article either draws on.
 *
 * - FanOutQA (Zhu et al., ACL 2024; data CC BY-SA 4.0, code MIT): "fan-out"
 *   questions — the batting hand of each of the first five picks of a draft,
 *   the box office of six films — whose answer gathers one fact from each of
 *   5–18 articles; dev set (the test set's answers are withheld). Gold as
 *   the dataset gives it: a mapping scored as a set of (key, value) items, a
 *   list as a set, a count as a number, a name by exact match.
 * - FRAMES (Krishna et al., 2024; Apache-2.0): 824 questions that chain
 *   2–15 articles under several constraints, many with arithmetic or dates;
 *   judged against the dataset's answer.
 *
 * Articles are the revisions the datasets were written against: FanOutQA
 * names them; FRAMES's are the last before 2024-10 (its release). The text
 * is read from the wikitext (src/eval/packs/wikitext.ts); an article both
 * datasets use at different revisions is two documents, each dated.
 *
 * Download: `downloads/fanoutqa/`, `downloads/frames/`, and
 * `downloads/wikipedia-revisions/` (scripts/eval-fetch-wikipedia.py).
 */

interface FanoutNode {
  id: string;
  question: string;
  answer: unknown;
  decomposition?: FanoutNode[];
  evidence?: { pageid: number; revid: number | string; title: string; url?: string } | null;
  categories?: string[];
}

interface IndexRec {
  key: string;
  dataset: 'fanoutqa' | 'frames';
  url?: string;
  title?: string;
  pageid?: number;
  revid?: number | string;
  timestamp?: string;
  missing?: boolean;
}

interface Page {
  title: string;
  pageid: number;
  revid: number;
  timestamp?: string;
  wikitext: string;
}

const FANOUT_LICENSE = 'CC-BY-SA-4.0 (FanOutQA data); Wikipedia text CC-BY-SA-4.0';
const FRAMES_LICENSE = 'Apache-2.0 (FRAMES); Wikipedia text CC-BY-SA-4.0';

function evidenceOf(n: FanoutNode, acc: NonNullable<FanoutNode['evidence']>[] = []) {
  if (n.evidence) acc.push(n.evidence);
  for (const c of n.decomposition ?? []) evidenceOf(c, acc);
  return acc;
}
const depthOf = (n: FanoutNode): number => 1 + Math.max(0, ...(n.decomposition ?? []).map(depthOf));

/** The ways a gold value may be written: as given, without a currency sign, a number without separators. */
export function valueForms(v: unknown): string[] {
  const s = String(v).trim();
  const out = new Set([s]);
  const bare = s.replace(/^[$€£¥]\s*/, '');
  out.add(bare);
  const n = plainNumber(s);
  if (n) {
    out.add(n);
    if (/^\d{4,}$/.test(n)) out.add(Number(n).toLocaleString('en-US'));
  }
  if (typeof v === 'boolean') out.add(v ? 'yes' : 'no');
  return [...out].filter(Boolean);
}

export function fanoutTask(q: FanoutNode, docOf: (e: NonNullable<FanoutNode['evidence']>) => string | null): Task | string {
  const ev = evidenceOf(q);
  const docs = [...new Set(ev.map(docOf))];
  if (!docs.length || docs.some((d) => !d)) return 'an evidence article that was not fetched';
  const evidence = (docs as string[]).map((doc) => ({ doc }));
  const fanout = evidence.length;
  const shape = Array.isArray(q.answer) ? 'list' : q.answer && typeof q.answer === 'object' ? 'mapping' : typeof q.answer;
  const meta = { source: 'fanoutqa', datasetId: q.id, datasetType: `fan-out (${shape})`, family: 'aggregates' as Family, hops: depthOf(q), fanout, stratum: `fanoutqa-${shape}`, categories: q.categories ?? [] };
  const base = { id: `fanout-${q.id}`, suite: 'usage' as const, lang: 'en', question: q.question, evidence, meta };
  const corpusLevel = fanout >= 5;
  if (shape === 'mapping') {
    const items: GoldItem[] = Object.entries(q.answer as Record<string, unknown>).map(([k, v]) => ({ label: `${k}: ${String(v)}`, aliases: [], weight: 1, fields: [[k], valueForms(v)] }));
    if (!items.length) return 'an empty answer';
    if (items.length > 58) return 'more answer items than a list may hold';
    return { ...base, type: corpusLevel ? 'aggregate' : 'aggregation', scoring: 'set', items, list: { match: 'fields', ordered: false, maxItems: Math.min(60, Math.max(10, items.length + 2)), requireDocs: false, primary: 'recall' } };
  }
  if (shape === 'list') {
    const items: GoldItem[] = (q.answer as unknown[]).map((v) => ({ label: String(v), aliases: valueForms(v).filter((f) => f !== String(v)), weight: 1 }));
    // a list of repeated values ([2006, 2012, 2006, 1995]) is a sequence, not a set: the judge reads it
    if (new Set(items.map((i) => i.label)).size < items.length) return { ...base, type: 'aggregation', scoring: 'judge', answer: (q.answer as unknown[]).map(String).join(', ') };
    if (items.length > 58) return 'more answer items than a list may hold';
    return { ...base, type: corpusLevel ? 'aggregate' : 'aggregation', scoring: 'set', items, list: { match: 'alias', ordered: false, maxItems: Math.min(60, Math.max(10, items.length + 2)), requireDocs: false, primary: 'recall' } };
  }
  if (shape === 'number' && Number.isInteger(q.answer)) return { ...base, type: corpusLevel ? 'aggregate' : 'numeric', scoring: 'count', answer: String(q.answer) };
  if (shape === 'number') return { ...base, type: 'numeric', scoring: 'exact', answer: String(q.answer), answers: valueForms(q.answer) };
  if (shape === 'boolean') return { ...base, type: 'comparison', scoring: 'exact', answer: q.answer ? 'Yes' : 'No', answers: valueForms(q.answer) };
  if (shape === 'string' && String(q.answer).trim()) return { ...base, type: 'comparison', scoring: 'exact', answer: String(q.answer).trim() };
  return 'an answer of another shape';
}

export interface FramesRow {
  index: string;
  Prompt: string;
  Answer: string;
  reasoning_types: string;
  links: string[];
}

export function framesTask(r: FramesRow, docOf: (url: string) => string | null): Task | string {
  const docs = [...new Set(r.links.map(docOf))];
  if (!docs.length || docs.some((d) => !d)) return 'a linked article that was not fetched';
  const kinds = r.reasoning_types.split('|').map((s) => s.trim()).filter(Boolean);
  const hops = docs.length;
  const temporal = kinds.includes('Temporal reasoning');
  const numeric = kinds.includes('Numerical reasoning');
  const type: Task['type'] = temporal ? 'temporal' : numeric ? 'numeric' : hops >= 3 ? 'deep-hop' : 'multi-hop';
  const family: Family = temporal ? 'timelines' : numeric ? 'aggregates' : 'hops';
  return {
    id: `frames-${r.index.padStart(3, '0')}`, suite: 'usage', type, lang: 'en', question: r.Prompt.trim(), answer: r.Answer.trim(), scoring: 'judge',
    evidence: (docs as string[]).map((doc) => ({ doc })), primary: true,
    meta: { source: 'frames', datasetId: r.index, datasetType: r.reasoning_types, family, hops, stratum: `frames-${type}-${Math.min(hops, 5)}${hops >= 5 ? '+' : ''}` },
  };
}

/** FRAMES's rows: the links of every `wikipedia_link_*` column. */
export function readFrames(tsv: string): FramesRow[] {
  const lines = tsv.split('\n').filter((l) => l.trim());
  const head = lines[0].split('\t');
  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    const row: Record<string, string> = {};
    head.forEach((h, i) => (row[h] = cells[i] ?? ''));
    return { index: row[''] ?? row.index ?? '', Prompt: row.Prompt, Answer: row.Answer, reasoning_types: row.reasoning_types ?? '', links: head.filter((h) => h.startsWith('wikipedia_link')).map((h) => (row[h] ?? '').trim()).filter(Boolean) };
  });
}

async function buildWikiHops(dir: string, ctx: RecipeContext) {
  const fanoutDir = sourceDir({ ...ctx, options: { from: ctx.options.fanoutqa } }, 'fanoutqa');
  const framesDir = sourceDir({ ...ctx, options: { from: ctx.options.frames } }, 'frames');
  const wikiDir = sourceDir({ ...ctx, options: { from: ctx.options.wikipedia } }, 'wikipedia-revisions');
  const index = new Map<string, IndexRec>();
  for (const line of fs.readFileSync(path.join(wikiDir, 'index.jsonl'), 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line) as IndexRec;
    index.set(r.key, r);
  }
  const pages = new Map<number, Page>();
  const pageOf = (revid: unknown) => {
    const id = Number(revid);
    if (!Number.isInteger(id)) return null;
    if (!pages.has(id)) {
      const file = path.join(wikiDir, 'pages', `${id}.json.gz`);
      if (!fs.existsSync(file)) return null;
      pages.set(id, JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')) as Page);
    }
    return pages.get(id)!;
  };
  const pathOf = (p: Page) => opaquePath('wiki', `${p.title}|${p.revid}`);
  const used = new Map<number, Page>();
  const use = (revid: unknown) => {
    const p = pageOf(revid);
    if (!p) return null;
    used.set(p.revid, p);
    return pathOf(p);
  };

  const fanout = JSON.parse(fs.readFileSync(path.join(fanoutDir, 'fanout-final-dev.json'), 'utf8')) as FanoutNode[];
  const frames = readFrames(fs.readFileSync(path.join(framesDir, 'test.tsv'), 'utf8'));
  const dropped: Record<string, number> = {};
  const all: Task[] = [];
  for (const q of fanout) {
    const t = fanoutTask(q, (e) => use(index.get(`fanoutqa:${e.pageid}:${e.revid}`)?.revid));
    if (typeof t === 'string') dropped[`FanOutQA: ${t}`] = (dropped[`FanOutQA: ${t}`] ?? 0) + 1;
    else all.push(t);
  }
  for (const r of frames) {
    const t = framesTask(r, (u) => use(index.get(`frames:${u}`)?.revid));
    if (typeof t === 'string') dropped[`FRAMES: ${t}`] = (dropped[`FRAMES: ${t}`] ?? 0) + 1;
    else all.push(t);
  }
  for (const [why, n] of Object.entries(dropped)) ctx.log(`${n} questions left out — ${why}`);
  // documents of questions left out stay: they are articles of the same kind, distractors now
  for (const rec of index.values()) if (rec.revid !== undefined) use(rec.revid);

  const n = questionCount(ctx);
  const tasks = n ? sampleByStratum(all, n, ctx.seed ?? 0) : all;
  const writer = new PackWriter(dir, {
    id: packIdFor('real-wiki-hops', n, all.length),
    version: 1,
    title: 'FanOutQA and FRAMES: questions across many whole Wikipedia articles',
    domain: 'public',
    languages: ['en'],
    description: `${tasks.length} questions — FanOutQA dev (fan-out over 5–18 articles; sets, counts, names) and FRAMES (chains of 2–15 articles, numerical and temporal reasoning; judged) — over ${used.size} Wikipedia articles at the revisions the datasets were written against, each whole.`,
    builder: { recipe: 'real-wiki-hops', options: { questions: n ?? 'all' } },
  });
  writer.addSource(localRecord(fanoutDir, 'fanout-final-dev.json', FANOUT_LICENSE, 'FanOutQA dev questions (github.com/zhudotexe/fanoutqa)'));
  writer.addSource(localRecord(framesDir, 'test.tsv', FRAMES_LICENSE, 'FRAMES (huggingface.co/datasets/google/frames-benchmark)'));
  writer.addSource({ url: 'https://en.wikipedia.org/w/api.php', license: 'CC-BY-SA-4.0 (Wikipedia)', note: `${used.size} article revisions as wikitext (scripts/eval-fetch-wikipedia.py); index.jsonl maps each dataset link to its revision` });
  for (const p of [...used.values()].sort((a, b) => a.revid - b.revid)) {
    const date = p.timestamp?.slice(0, 10);
    writer.addDoc({ path: pathOf(p), title: p.title, ...(date ? { date } : {}), lang: 'en', source: 'wikipedia', kind: 'article' }, `# ${p.title}\n\nWikipedia, revision ${p.revid}${date ? ` of ${date}` : ''}\n\n${wikitextToText(p.wikitext)}\n`);
  }
  ctx.log(`wiki-hops: ${tasks.length} questions (${all.filter((t) => t.meta?.source === 'fanoutqa').length} FanOutQA, ${all.filter((t) => t.meta?.source === 'frames').length} FRAMES usable) over ${used.size} articles`);
  return finishRealPack(writer, tasks, ctx);
}

export function registerWikiHopsRecipe(): void {
  registerRecipe({ id: 'real-wiki-hops', title: 'FanOutQA + FRAMES over whole Wikipedia articles: fan-out sets, chains of 2–15 articles', domain: 'public', network: false, needsAuthor: false, build: buildWikiHops });
}
