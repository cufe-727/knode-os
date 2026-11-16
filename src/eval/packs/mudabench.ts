import fs from 'node:fs';
import path from 'node:path';
import type { Task } from '../types.js';
import { registerRecipe, RecipeContext } from './index.js';
import { finishRealPack, localRecord, opaquePath, packIdFor, questionCount, sampleByStratum, sourceDir } from './real-docs.js';
import { PackWriter } from './writer.js';

/**
 * real-mudabench (docs/design/33 §4, "company-wide aggregates"): MuDABench
 * (Li et al., ACL 2026 Findings, Apache-2.0) — analytical questions over a
 * collection of whole annual reports of A-share and US companies, each asked
 * of "your knowledge base": the three banks with the highest capital
 * adequacy ratio in 2021, the companies that changed auditor between two
 * years, the range of total operating cost. Answering one means reading the
 * same figure out of 5 to 38 reports of 100–300 pages.
 *
 * The pack takes the annual-report questions (A股年报, US Stock Annual
 * Report), as the dataset's authors advise since 2026-07, and the profit
 * distribution announcements (A股利润分配权益类公告), with every PDF those
 * questions draw on as one corpus; ESG reports and shareholder-meeting
 * notices are left out with their questions. A question whose answer is a
 * list of stock codes is scored as a set of codes (no model); the others by
 * the judge against the dataset's concise answer. Where the dataset's own
 * per-document values let a "top three" be recomputed, the recomputation is
 * kept in `meta.goldCheck` and a question it disagrees with is not primary.
 *
 * Download: `downloads/mudabench/` holds simple.json, complex.json and
 * pdf/<id>.pdf for the three document types (SOURCE.md). The text pdf.js
 * reads from each PDF is cached in `text/<id>.txt` beside them.
 */

interface MudaMeta {
  symbol: string;
  year: number;
  id: string;
  doctype: string;
  schema?: Record<string, string>;
  [k: string]: unknown;
}

interface MudaRow {
  question_id: string;
  question: string;
  metadata: MudaMeta[];
  source_answer: unknown[];
  final_answer: string;
}

const LICENSE = 'Apache-2.0 (MuDABench); the reports are public company filings';
export const MUDA_DOCTYPES: Record<string, { lang: 'zh' | 'en'; short: string; title: (m: MudaMeta) => string }> = {
  'A股年报': { lang: 'zh', short: 'annual-zh', title: (m) => `${m.symbol} ${m.year}年年度报告` },
  'US Stock Annual Report': { lang: 'en', short: 'annual-en', title: (m) => `${m.symbol} annual report, fiscal ${m.year}` },
  'A股利润分配权益类公告': { lang: 'zh', short: 'dividend-zh', title: (m) => `${m.symbol} ${m.year}年度权益分派公告` },
};

const ASKS_CODES = /股票代码|证券代码|stock symbols?|tickers?|symbols/i;

/** The stock codes a final answer names, among the codes of the question's documents. */
export function codesIn(answer: string, symbols: string[]): string[] {
  const t = answer.normalize('NFKC');
  return [...new Set(symbols)].filter((s) => new RegExp(`(?<![A-Za-z0-9])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`).test(t)).sort((a, b) => t.indexOf(a) - t.indexOf(b));
}

/**
 * A "top three, highest" question recomputed from the dataset's per-document
 * values: agrees, disagrees, or unchecked (another shape, several value
 * fields, or a tie at the cut).
 */
export function checkTopThree(row: MudaRow, gold: string[]): 'agrees' | 'disagrees' | 'unchecked' {
  if (!/(三家|前三|top three|three companies)/i.test(row.question) || !/(最高|最多|highest|largest|top three)/i.test(row.question) || /增长|growth|变化|change/i.test(row.question)) return 'unchecked';
  const keys = new Set(row.metadata.flatMap((m) => Object.keys(m).filter((k) => k.startsWith('value_'))));
  if (keys.size !== 1) return 'unchecked';
  const key = [...keys][0];
  const years = new Set(row.metadata.map((m) => m.year));
  if (years.size !== 1) return 'unchecked';
  const vals = row.metadata.filter((m) => typeof m[key] === 'number').map((m) => ({ s: m.symbol, v: m[key] as number })).sort((a, b) => b.v - a.v);
  if (vals.length < 4 || vals[2].v === vals[3].v) return 'unchecked';
  const top = new Set(vals.slice(0, 3).map((x) => x.s));
  return gold.length === 3 && gold.every((g) => top.has(g)) ? 'agrees' : 'disagrees';
}

/**
 * A MuDABench question asks of "your knowledge base", which in the dataset is
 * the question's own set of 5–38 reports (two questions with the same text
 * rank different sets). Asked of one shared corpus, the question says which
 * set that is: the companies' codes and the years.
 */
export function scopeQuestion(row: MudaRow, lang: 'zh' | 'en', doctype: string): string {
  const codes = [...new Set(row.metadata.map((m) => m.symbol))];
  const years = [...new Set(row.metadata.map((m) => m.year))].sort();
  const span = years.length > 1 ? `${years[0]}–${years.at(-1)}` : String(years[0]);
  if (lang === 'zh') {
    const label = doctype === 'A股利润分配权益类公告' ? '权益分派（利润分配）公告' : '年度报告';
    return `本题中"知识库"指以下${codes.length}家公司${span}年的${label}：${codes.join('、')}。${row.question}`;
  }
  return `Here "your knowledge base" means the annual reports for ${span} of these ${codes.length} companies: ${codes.join(', ')}. ${row.question}`;
}

export function mudaTasks(rows: MudaRow[], complex: Map<string, string>, pathOf: (id: string) => string, unreadable: Set<string> = new Set()): Task[] {
  const tasks: Task[] = [];
  const ids = new Map<string, number>();
  for (const row of rows) {
    const types = new Set(row.metadata.map((m) => m.doctype));
    if (types.size !== 1 || !MUDA_DOCTYPES[[...types][0]]) continue;
    const kind = MUDA_DOCTYPES[[...types][0]];
    const docs = [...new Set(row.metadata.map((m) => m.id))];
    const evidence = docs.map((id) => ({ doc: pathOf(id) }));
    const symbols = row.metadata.map((m) => m.symbol);
    const codes = ASKS_CODES.test(row.question) ? codesIn(row.final_answer, symbols) : [];
    const goldCheck = codes.length ? checkTopThree(row, codes) : 'unchecked';
    const unread = docs.filter((id) => unreadable.has(id));
    const meta = {
      source: 'mudabench', datasetId: row.question_id, datasetType: [...types][0], family: 'aggregates', hops: docs.length, stratum: kind.short,
      goldCheck, originalQuestion: row.question, ...(unread.length ? { unreadableEvidence: unread.map(pathOf) } : {}),
      ...(complex.get(row.question_id) ? { analyticAnswer: complex.get(row.question_id) } : {}),
    };
    // the dataset repeats a few question ids; the repeat gets a suffix
    const seen = (ids.get(row.question_id) ?? 0) + 1;
    ids.set(row.question_id, seen);
    const id = `muda-${row.question_id.replace(/^q_/, '')}${seen > 1 ? `-${seen}` : ''}`;
    const base = { id, suite: 'usage' as const, lang: kind.lang, question: scopeQuestion(row, kind.lang, [...types][0]), answer: row.final_answer, evidence, primary: goldCheck !== 'disagrees' && !unread.length, meta };
    if (codes.length) {
      const items = codes.map((c) => ({ label: c, aliases: [], weight: 1, docs: row.metadata.filter((m) => m.symbol === c).map((m) => pathOf(m.id)) }));
      // the corpus-level type needs five documents; a narrower question is an aggregation all the same
      tasks.push({ ...base, type: docs.length >= 5 ? 'aggregate' : 'aggregation', scoring: 'set', items, list: { match: 'alias', ordered: false, maxItems: Math.max(10, codes.length + 5), requireDocs: false, primary: 'exact' } });
    } else {
      tasks.push({ ...base, type: 'aggregation', scoring: 'judge' });
    }
  }
  return tasks;
}

/** The text pdf.js reads from a PDF, page by page, cached beside the download. */
async function pdfText(from: string, id: string): Promise<string> {
  const cache = path.join(from, 'text', `${id}.txt`);
  if (fs.existsSync(cache)) return fs.readFileSync(cache, 'utf8');
  const { extractPdfPageText } = await import('../../ingest/converters/pdf.js');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(path.join(from, 'pdf', `${id}.pdf`))), useSystemFonts: true, isEvalSupported: false }).promise;
  const pages: string[] = [];
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      pages.push(`<!-- page ${n} -->\n${await extractPdfPageText(page)}`);
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }
  const text = pages.join('\n\n');
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, text);
  return text;
}

async function buildMudabench(dir: string, ctx: RecipeContext) {
  const from = sourceDir(ctx, 'mudabench');
  const rows = JSON.parse(fs.readFileSync(path.join(from, 'simple.json'), 'utf8')) as MudaRow[];
  const complexRows = fs.existsSync(path.join(from, 'complex.json')) ? (JSON.parse(fs.readFileSync(path.join(from, 'complex.json'), 'utf8')) as MudaRow[]) : [];
  const complex = new Map(complexRows.map((r) => [r.question_id, r.final_answer]));
  const docMeta = new Map<string, MudaMeta>();
  for (const r of rows) for (const m of r.metadata) if (MUDA_DOCTYPES[m.doctype] && !docMeta.has(m.id)) docMeta.set(m.id, m);
  // a PDF already read (its text cached) need not be there any more
  const missing = [...docMeta.keys()].filter((id) => !fs.existsSync(path.join(from, 'pdf', `${id}.pdf`)) && !fs.existsSync(path.join(from, 'text', `${id}.txt`)));
  if (missing.length) throw new Error(`${missing.length} PDFs are missing from ${path.join(from, 'pdf')} (first: ${missing[0]}.pdf)`);
  const pathOf = (id: string) => opaquePath(`reports/${MUDA_DOCTYPES[docMeta.get(id)!.doctype].lang}`, id);
  let done = 0;
  const ids = [...docMeta.keys()].sort();
  const texts = new Map<string, string>();
  const queue = [...ids];
  await Promise.all(Array.from({ length: 3 }, async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      texts.set(id, await pdfText(from, id));
      if (++done % 25 === 0) ctx.log(`MuDABench: ${done}/${ids.length} PDFs read`);
    }
  }));
  // a report whose PDF holds almost no text (a scan) cannot be read without a vision model: its questions are kept, not primary
  const unreadable = new Set(ids.filter((id) => MUDA_DOCTYPES[docMeta.get(id)!.doctype].short.startsWith('annual') && texts.get(id)!.replace(/<!-- page \d+ -->|\s/g, '').length < 5_000));
  if (unreadable.size) ctx.log(`MuDABench: ${unreadable.size} annual reports with almost no text in their PDF (scans): ${[...unreadable].join(', ')}`);
  const all = mudaTasks(rows, complex, pathOf, unreadable);
  const n = questionCount(ctx);
  const tasks = n ? sampleByStratum(all, n, ctx.seed ?? 0) : all;
  const writer = new PackWriter(dir, {
    id: packIdFor('real-mudabench', n, all.length),
    version: 1,
    title: 'MuDABench: analytical questions across whole annual reports of A-share and US companies',
    domain: 'finance',
    languages: ['zh', 'en'],
    description: `${tasks.length} MuDABench questions over ${docMeta.size} reports (A-share annual reports and dividend announcements in Chinese, US annual reports in English), each read whole from its PDF. Each question ranks, counts or compares one figure across 5–38 reports; lists of stock codes are scored as sets, the rest by the judge against the dataset's concise answer.`,
    builder: { recipe: 'real-mudabench', options: { questions: n ?? 'all' } },
  });
  writer.addSource(localRecord(from, 'simple.json', LICENSE, 'MuDABench questions with concise answers (Hugging Face Zhanli-Li/MuDABench)'));
  if (complexRows.length) writer.addSource(localRecord(from, 'complex.json', LICENSE, 'the same questions with analytic answers (kept in meta.analyticAnswer)'));
  writer.addSource({ url: 'https://huggingface.co/datasets/Zhanli-Li/MuDABench/tree/main/data/pdf', license: LICENSE, note: `${docMeta.size} PDFs (A股年报, US Stock Annual Report, A股利润分配权益类公告); sha256 of each in the download's SHA256SUMS` });

  for (const id of ids) {
    const m = docMeta.get(id)!;
    const kind = MUDA_DOCTYPES[m.doctype];
    const title = kind.title(m);
    writer.addDoc({ path: pathOf(id), title, date: String(m.year), lang: kind.lang, source: 'mudabench', kind: kind.short }, `# ${title}\n\n${texts.get(id)!.trim()}\n`);
  }
  const checks = all.reduce<Record<string, number>>((acc, t) => ((acc[String(t.meta?.goldCheck)] = (acc[String(t.meta?.goldCheck)] ?? 0) + 1), acc), {});
  ctx.log(`MuDABench: ${all.length} questions (${all.filter((t) => t.scoring === 'set').length} code lists); top-three recomputed from the dataset's values: ${JSON.stringify(checks)}`);
  return finishRealPack(writer, tasks, ctx);
}

export function registerMudabenchRecipe(): void {
  registerRecipe({ id: 'real-mudabench', title: 'MuDABench: aggregates across whole A-share and US annual reports (zh, en)', domain: 'finance', network: false, needsAuthor: false, build: buildMudabench });
}
