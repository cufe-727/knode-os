import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seededKey } from '../pack.js';
import type { CorpusDoc, Task, TaskType } from '../types.js';
import { finishDocpack } from './docpack.js';
import { hfRows } from './fetch.js';
import { registerRecipe, RecipeContext } from './index.js';
import { PackWriter } from './writer.js';

/**
 * Pack recipes for the finance domain (docs/design/23 §2).
 *
 * - finance-us: FinanceBench's open-source sample (Islam et al., 2023; 150
 *   questions on US public companies' 10-K, 10-Q, 8-K and earnings filings,
 *   CC BY-NC 4.0), with the filing pages its annotators cite as the corpus —
 *   one document per page — and the published answers as gold. Numeric
 *   extraction, ratio arithmetic and analyst judgement questions, all
 *   model-free; the author model adds a few unanswerable ones.
 * - finance-cn: a frozen, private slice of the user's own knode finance
 *   workspace (research notes, captured filings and articles, Chinese
 *   market commentary by the authors they follow), read-only, with all gold
 *   drafted by the author model. It exists to measure the systems on the
 *   material they will really serve, and must never leave this machine.
 */

type Doc = CorpusDoc & { text: string };

/** Items in a seeded round-robin over strata: every stratum is drawn once before any is drawn twice. */
function stratified<T>(items: T[], stratum: (t: T) => string, key: (t: T) => string, seed: string | number): T[] {
  const groups = new Map<string, T[]>();
  for (const t of items) (groups.get(stratum(t)) ?? groups.set(stratum(t), []).get(stratum(t))!).push(t);
  const lists = [...groups.entries()]
    .sort((a, b) => seededKey(seed, a[0]).localeCompare(seededKey(seed, b[0])))
    .map(([, list]) => list.sort((a, b) => seededKey(seed, key(a)).localeCompare(seededKey(seed, key(b)))));
  const out: T[] = [];
  for (let round = 0; out.length < items.length; round++) for (const l of lists) if (round < l.length) out.push(l[round]);
  return out;
}

/* -------------------------------- finance-us -------------------------------- */

interface FinanceBenchRow {
  financebench_id: string;
  company: string;
  doc_name: string;
  question_type: string;
  question_reasoning: string | null;
  question: string;
  answer: string;
  justification: string | null;
  evidence: { evidence_text: string; doc_name: string; evidence_page_num: number; evidence_text_full_page: string }[];
  doc_type: string;
  doc_period: number;
}

/** A pure figure (`$1577.00`, `24.26`, `1.9%`, `-0.02`, `$8.70 billion`): scored by exact match, judged as fallback. */
const isFigure = (a: string) => /^[-+(]?\s?\$?\s?[\d,]*\.?\d+\)?\s?(%|x|million|billion|m|bn)?$/i.test(a.trim());

/** The first ~300 characters of an evidence passage, cut at a word: an exact quote of its page. */
function lead(text: string, max = 300): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 40)).trim();
}

async function buildFinanceUs(dir: string, ctx: RecipeContext) {
  const seed = ctx.seed ?? 0;
  const limit = ctx.limit ?? Infinity;
  const want = Number(ctx.options.questions ?? (ctx.limit ? 60 : 150));
  const writer = new PackWriter(dir, {
    id: 'finance-us',
    version: 1,
    title: 'FinanceBench: US public-company filings',
    domain: 'finance',
    languages: ['en'],
    description: 'FinanceBench\'s open-source sample: questions on US public companies\' 10-K, 10-Q, 8-K and earnings filings (metric extraction, numerical reasoning, analyst judgement), with the published answers as gold. The corpus is the filing pages the annotators cite, one document per page — far smaller than the full filings, so retrieval is easier than in the original benchmark.',
    builder: { recipe: 'finance-us', options: { questions: want } },
  });
  const { rows, record } = await hfRows<FinanceBenchRow>('PatronusAI/financebench', { limit: 150, license: 'CC-BY-NC-4.0' });
  writer.addSource({ ...record, note: `${record.note ?? ''}; FinanceBench (Islam et al., arXiv:2311.11944), open-source sample` });

  const pageKey = (e: FinanceBenchRow['evidence'][number]) => `${e.doc_name}|${e.evidence_page_num}`;
  const docs = new Map<string, Doc>();
  const tasks: Task[] = [];
  for (const r of stratified(rows, (x) => x.question_type, (x) => x.financebench_id, seed)) {
    if (tasks.length >= want) break;
    const pages = [...new Map(r.evidence.map((e) => [pageKey(e), e])).values()];
    const fresh = pages.filter((e) => !docs.has(pageKey(e))).length;
    if (!pages.length || docs.size + fresh > limit) continue;
    for (const e of pages) {
      if (docs.has(pageKey(e))) continue;
      const head = `${r.company} ${r.doc_type.toUpperCase()} ${e.doc_name.includes(String(r.doc_period)) ? '' : `${r.doc_period} `}(${e.doc_name}), page ${e.evidence_page_num}`.replace(/\s+/g, ' ');
      const body = (e.evidence_text_full_page || e.evidence_text).trim();
      docs.set(pageKey(e), {
        path: `${e.doc_name}/p${e.evidence_page_num}.md`, title: head, date: String(r.doc_period), lang: 'en', source: 'financebench', kind: r.doc_type,
        text: `# ${head}\n\n${body}\n`,
      });
    }
    const reasoning = r.question_reasoning ?? '';
    const type: TaskType = pages.length > 1 ? 'multi-hop' : r.question_type === 'metrics-generated' || /numerical/i.test(reasoning) ? 'numeric' : 'single-hop';
    tasks.push({
      id: `fb-${r.financebench_id.replace(/^financebench_id_/, '')}`, suite: 'usage', type, lang: 'en', question: r.question, answer: r.answer.trim(),
      scoring: isFigure(r.answer) ? 'exact' : 'judge',
      evidence: r.evidence.map((e) => ({ doc: docs.get(pageKey(e))!.path, quote: lead(e.evidence_text) })),
      primary: true,
      meta: { source: 'financebench', company: r.company, questionType: r.question_type, reasoning: r.question_reasoning, justification: r.justification },
    });
  }
  ctx.log(`FinanceBench: ${tasks.length} questions, ${docs.size} filing pages`);
  return finishDocpack({ writer, docs: [...docs.values()], lang: 'en', tasks, plan: { unanswerable: 5 }, perDoc: 4 }, ctx);
}

/* -------------------------------- finance-cn -------------------------------- */

const MAX_CHARS = 40_000;
const MIN_CHARS = 300;

/** Share of CJK among letters: the pack keeps documents written mainly in Chinese. */
const cjkShare = (t: string) => {
  const c = t.match(/[一-鿿]/g)?.length ?? 0;
  const l = t.match(/[A-Za-z]/g)?.length ?? 0;
  return c / (c + l + 1);
};

/** Monday of an ISO week (`2026-W09` → `2026-02-23`). */
function isoWeekMonday(year: number, week: number): string {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86_400_000 + (week - 1) * 7 * 86_400_000);
  return monday.toISOString().slice(0, 10);
}

/** The date a path carries (`…/2026-05-17-…`, `…/2026-W30.md`), else the front matter's `date:`. */
export function workspaceDate(rel: string, text: string): string | undefined {
  const day = rel.match(/(?:^|[^\d])(20\d{2}-\d{2}-\d{2})(?!\d)/);
  if (day) return day[1];
  const week = rel.match(/(?:^|[^\d])(20\d{2})-W(\d{2})(?!\d)/);
  if (week) return isoWeekMonday(+week[1], +week[2]);
  return text.match(/^---\n[\s\S]*?^date:\s*["']?(\d{4}-\d{2}-\d{2})/m)?.[1];
}

function walk(root: string, rel: string, out: string[]): void {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return;
  for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(root, r, out);
    else if (e.isFile()) out.push(r);
  }
}

async function buildFinanceCn(dir: string, ctx: RecipeContext) {
  const n = ctx.limit ?? 100;
  const seed = ctx.seed ?? 0;
  const workspace = path.resolve(String(ctx.options.workspace ?? path.join(os.homedir(), '.knode-os/users/admin/workspaces/finance')));
  const raw = path.join(workspace, 'raw', 'docs');
  if (!fs.existsSync(raw)) throw new Error(`finance-cn reads a local knode workspace; none at ${workspace} (set --options '{"workspace":"…"}')`);
  const writer = new PackWriter(dir, {
    id: 'finance-cn',
    version: 2,
    title: 'Private: a frozen slice of the local finance knowledge base (zh)',
    domain: 'finance',
    languages: ['zh'],
    description: `PRIVATE — DO NOT SHARE. A frozen slice of the user's own local knode finance workspace (${n} documents, read-only copies): research notes and captured web pages, filings and reports (converted text) from raw/docs/research, and Chinese market commentary from raw/docs/content-markdown, drawn across sub-folders by seed. The corpus is personal material: keep this pack, its runs and reports on this machine; never upload, publish or share them. All gold is drafted by the author model.`,
    builder: { recipe: 'finance-cn', options: { documents: n, padding: Number(ctx.options.padding ?? 0) } },
  });
  writer.addSource({ url: `file://${raw}`, license: 'private: the user\'s own knowledge base — must not be shared', retrievedAt: new Date().toISOString(), note: 'raw/docs/research and raw/docs/content-markdown; sidecar content.md preferred where it exists' });

  const files: string[] = [];
  walk(raw, 'research', files);
  walk(raw, 'content-markdown', files);
  const textOf = (rel: string): string | null => {
    const side = path.join(workspace, '.sidecar', 'raw', 'docs', rel, 'content.md');
    if (fs.existsSync(side)) return fs.readFileSync(side, 'utf8');
    return rel.endsWith('.md') ? fs.readFileSync(path.join(raw, rel), 'utf8') : null;
  };
  // research by project (or its web captures), commentary by author
  const stratum = (rel: string) => rel.split('/').slice(0, 2).join('/');
  const quotas: [string, number][] = [['research/', Math.round(n * 0.4)], ['content-markdown/', n - Math.round(n * 0.4)]];
  // padding for scale curves: more of the same workspace, read the same way (local files: nothing is downloaded)
  const padding = Number(ctx.options.padding ?? 0);
  const docs: Doc[] = [];
  const spare: Doc[] = [];
  let skipped = 0;
  for (const [prefix, quota] of quotas) {
    let taken = 0;
    let extra = 0;
    const spareQuota = padding > 1 ? Math.ceil(quota * (padding - 1) * 1.5) + 20 : 0;
    for (const rel of stratified(files.filter((f) => f.startsWith(prefix)), stratum, (f) => f, seed)) {
      if (taken >= quota && extra >= spareQuota) break;
      const text = textOf(rel)?.trim();
      if (!text || text.length < MIN_CHARS || text.length > MAX_CHARS || cjkShare(text) < 0.2) {
        skipped++;
        continue;
      }
      const date = workspaceDate(rel, text);
      const title = text.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? text.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(rel);
      const doc: Doc = {
        path: rel.endsWith('.md') ? rel : `${rel}.md`, title: title.slice(0, 160), ...(date ? { date } : {}), lang: 'zh',
        source: stratum(rel), kind: prefix === 'research/' ? 'research' : 'commentary', text: `${text}\n`,
      };
      if (taken < quota) {
        docs.push(doc);
        taken++;
      } else {
        spare.push(doc);
        extra++;
      }
    }
  }
  ctx.log(`finance workspace: ${docs.length} documents from ${new Set(docs.map((d) => d.source)).size} sub-folders (${skipped} skipped: too long, too short, not Chinese or not text)${spare.length ? `; ${spare.length} padding candidates` : ''}`);
  return finishDocpack({
    writer, docs, lang: 'zh', plan: { single: 20, multi: 12, temporal: 8, unanswerable: 5, global: 3 }, perDoc: 5,
    corpus: { profile: 12, timeline: 10, contradiction: 10, aggregate: 12, deep: 10 },
    ...(padding > 1 ? { padding: { candidates: spare, multiple: padding } } : {}),
  }, ctx);
}

export function registerFinanceRecipes(): void {
  registerRecipe({ id: 'finance-us', title: 'FinanceBench questions over the US filing pages they cite', domain: 'finance', network: true, needsAuthor: true, build: buildFinanceUs });
  registerRecipe({ id: 'finance-cn', title: 'PRIVATE frozen slice of the local zh finance workspace (never share)', domain: 'finance', network: false, needsAuthor: true, build: buildFinanceCn });
}
