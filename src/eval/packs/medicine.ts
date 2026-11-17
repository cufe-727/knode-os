import { bySeed, shortHash as hid } from '../pack.js';
import type { CorpusDoc, Task } from '../types.js';
import { finishDocpack } from './docpack.js';
import { fetchCached, fetchJson, fetchText } from './fetch.js';
import { scaledPlan } from './gold.js';
import { registerRecipe, RecipeContext } from './index.js';
import { PackWriter } from './writer.js';

/**
 * Medicine packs (docs/design/23 §2).
 *
 * `medicine-us`: one clinical topic seen from two kinds of source — PubMed
 * abstracts of randomized trials of GLP-1 receptor agonists (semaglutide,
 * tirzepatide, liraglutide) in obesity published 2023–2025 (NCBI
 * E-utilities), and the FDA prescribing information of five of these
 * products (openFDA drug labels), one document per label section. Trial
 * results and label statements meet on the same drugs, doses and adverse
 * events, so the author-drafted multi-hop questions can cross the two.
 *
 * `medicine-zh`: Chinese medical encyclopedia entries from
 * FreedomIntelligence/huatuo_encyclopedia_qa — answers to templated
 * questions (X的病因 / 症状 / 诊断 / 治疗…), regrouped into one document per
 * disease with a section per answer. The dataset's own questions, with its
 * answers as gold, are the model-free tasks.
 */

type Doc = CorpusDoc & { text: string };

/** Pieces of at most about `max` characters, cut between paragraphs, or between sentences in a paragraph too long for one piece. */
function splitText(text: string, max = 6000): string[] {
  const out: string[] = [];
  let cur = '';
  for (const para of text.split(/\n\n+/)) {
    const units = para.length > max ? para.split(/(?<=[.!?])\s+(?=[A-Z(])/) : [para];
    for (const [i, u] of units.entries()) {
      const sep = !cur ? '' : i === 0 ? '\n\n' : ' ';
      if (cur && cur.length + sep.length + u.length > max) {
        out.push(cur);
        cur = u;
      } else cur += sep + u;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/* ------------------------------- medicine-us ------------------------------- */

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const PUBMED_TERM = '(semaglutide[tiab] OR tirzepatide[tiab] OR liraglutide[tiab]) AND obesity[mh] AND randomized controlled trial[pt] AND hasabstract AND 2023:2025[dp]';
const PUBMED_LICENSE = 'NLM PubMed data, NLM terms and conditions (citations public; abstracts may be under publisher copyright, used for research)';
const FDA_LICENSE = 'openFDA: public domain (CC0 1.0)';

/** Products whose labels the pack reads, with the label holder preferred over repackagers. */
const PRODUCTS = [
  { brand: 'Wegovy', holder: 'Novo Nordisk' },
  { brand: 'Ozempic', holder: 'Novo Nordisk' },
  { brand: 'Saxenda', holder: 'Novo Nordisk' },
  { brand: 'Zepbound', holder: 'Eli Lilly' },
  { brand: 'Mounjaro', holder: 'Eli Lilly' },
];

const LABEL_SECTIONS: { key: string; title: string; fields: string[] }[] = [
  { key: 'indications', title: 'Indications and usage', fields: ['indications_and_usage'] },
  { key: 'dosage', title: 'Dosage and administration', fields: ['dosage_and_administration', 'dosage_forms_and_strengths'] },
  { key: 'warnings', title: 'Boxed warning, contraindications, warnings and precautions', fields: ['boxed_warning', 'contraindications', 'warnings_and_cautions'] },
  { key: 'adverse-reactions', title: 'Adverse reactions', fields: ['adverse_reactions'] },
];

interface Abstract {
  pmid: string;
  title: string;
  journal: string;
  date: string;
  authors: string[];
  doi?: string;
  sections: { label?: string; text: string }[];
}

interface FdaLabel {
  set_id?: string;
  effective_time?: string;
  openfda?: { brand_name?: string[]; generic_name?: string[]; manufacturer_name?: string[] };
  [field: string]: unknown;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function xmlText(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function xmlDate(block: string | undefined): string | undefined {
  if (!block) return undefined;
  const year = block.match(/<Year>(\d{4})<\/Year>/)?.[1] ?? block.match(/<MedlineDate>(\d{4})/)?.[1];
  if (!year) return undefined;
  const m = block.match(/<Month>([^<]+)<\/Month>/)?.[1];
  const month = m ? (/^\d+$/.test(m) ? Number(m) : MONTHS.indexOf(m.slice(0, 3).toLowerCase()) + 1) : 0;
  const day = Number(block.match(/<Day>(\d+)<\/Day>/)?.[1] ?? 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return month > 0 ? `${year}-${pad(month)}${day ? `-${pad(day)}` : ''}` : year;
}

function parsePubmed(xml: string): Abstract[] {
  return [...xml.matchAll(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g)].map((m) => {
    const a = m[1];
    const authors = [...a.matchAll(/<Author\b[^>]*>([\s\S]*?)<\/Author>/g)].map((x) => {
      const last = x[1].match(/<LastName>([^<]+)<\/LastName>/)?.[1];
      const initials = x[1].match(/<Initials>([^<]+)<\/Initials>/)?.[1];
      return last ? `${xmlText(last)}${initials ? ` ${initials}` : ''}` : xmlText(x[1].match(/<CollectiveName>([\s\S]*?)<\/CollectiveName>/)?.[1] ?? '');
    }).filter(Boolean);
    return {
      pmid: a.match(/<PMID[^>]*>(\d+)<\/PMID>/)?.[1] ?? '',
      title: xmlText(a.match(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/)?.[1] ?? ''),
      journal: xmlText(a.match(/<Journal>[\s\S]*?<Title>([\s\S]*?)<\/Title>/)?.[1] ?? ''),
      date: xmlDate(a.match(/<ArticleDate[^>]*>([\s\S]*?)<\/ArticleDate>/)?.[1]) ?? xmlDate(a.match(/<PubDate>([\s\S]*?)<\/PubDate>/)?.[1]) ?? '',
      authors,
      doi: a.match(/<ArticleId IdType="doi">([^<]+)<\/ArticleId>/)?.[1],
      sections: [...a.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)].map((x) => ({ label: x[1].match(/Label="([^"]+)"/)?.[1], text: xmlText(x[2]) })).filter((x) => x.text),
    };
  });
}

function abstractDoc(a: Abstract): Doc {
  const byline = a.authors.length > 3 ? `${a.authors.slice(0, 3).join(', ')} et al.` : a.authors.join(', ');
  const body = a.sections.map((s) => (s.label ? `${s.label}: ${s.text}` : s.text)).join('\n\n');
  return {
    path: `pubmed/${a.pmid}.md`, title: a.title, ...(a.date ? { date: a.date } : {}), author: byline, lang: 'en', source: `PMID ${a.pmid}`, kind: 'abstract',
    text: `# ${a.title}\n\n${a.journal} · ${a.date} · PMID ${a.pmid}${a.doi ? ` · doi:${a.doi}` : ''}\n${byline}\n\n${body}\n`,
  };
}

/** The current label of a product: the holder's own when openFDA has it, else the latest repackager's. */
function chooseLabel(labels: FdaLabel[], brand: string, holder: string): FdaLabel | undefined {
  const own = labels.filter((l) => {
    const names = l.openfda?.brand_name ?? [];
    return names.length > 0 && names.every((n) => n.toLowerCase().startsWith(brand.toLowerCase()));
  });
  const score = (l: FdaLabel) => `${(l.openfda?.manufacturer_name ?? []).some((m) => m.includes(holder)) ? 1 : 0}${l.effective_time ?? ''}`;
  return own.sort((a, b) => score(b).localeCompare(score(a)))[0];
}

function labelDocs(label: FdaLabel, brand: string): Doc[][] {
  const generic = (label.openfda?.generic_name?.[0] ?? '').toLowerCase();
  const maker = label.openfda?.manufacturer_name?.[0] ?? '';
  const t = label.effective_time ?? '';
  const date = t.length === 8 ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : undefined;
  return LABEL_SECTIONS.map((s) => {
    const text = s.fields
      .flatMap((f) => (Array.isArray(label[f]) ? (label[f] as string[]) : []))
      .map((x) => x.replace(/\s+(?=\d{1,2}\.\d{1,2} [A-Z])/g, '\n\n').trim())
      .join('\n\n');
    const pieces = text ? splitText(text) : [];
    return pieces.map((piece, i) => {
      const part = pieces.length > 1 ? ` (part ${i + 1} of ${pieces.length})` : '';
      return {
        path: `fda-labels/${brand.toLowerCase()}/${s.key}${pieces.length > 1 ? `-${i + 1}` : ''}.md`,
        title: `${brand.toUpperCase()} (${generic}) prescribing information: ${s.title}${part}`, date, lang: 'en', source: `openFDA drug label set_id ${label.set_id}`, kind: 'drug-label',
        text: `# ${brand.toUpperCase()} (${generic}) — ${s.title}${part}\n\nFDA prescribing information, label effective ${date ?? 'n/a'}; ${maker}; set_id ${label.set_id}\n\n${piece}\n`,
      };
    });
  }).filter((x) => x.length);
}

async function buildMedicineUs(dir: string, ctx: RecipeContext) {
  const nAbstracts = ctx.limit ? Math.ceil(ctx.limit * 0.6) : Number(ctx.options.abstracts ?? 64);
  const writer = new PackWriter(dir, {
    id: 'medicine-us',
    version: 1,
    title: 'GLP-1 receptor agonists for obesity: trials and FDA labels',
    domain: 'medicine',
    languages: ['en'],
    description: `PubMed abstracts of randomized trials of semaglutide, tirzepatide and liraglutide in obesity (2023–2025) and the FDA prescribing information of ${PRODUCTS.map((p) => p.brand).join(', ')} (openFDA), by section.`,
    builder: { recipe: 'medicine-us', options: { term: PUBMED_TERM, abstracts: nAbstracts, products: PRODUCTS.map((p) => p.brand), limit: ctx.limit } },
  });

  const searchUrl = `${EUTILS}/esearch.fcgi?db=pubmed&retmode=json&retmax=200&sort=relevance&tool=knode-os-eval&term=${encodeURIComponent(PUBMED_TERM)}`;
  const search = await fetchJson<{ esearchresult: { idlist: string[]; count: string } }>(searchUrl, { license: PUBMED_LICENSE, name: `esearch-${hid(PUBMED_TERM)}.json` });
  writer.addSource({ ...search.record, note: `esearch: ${PUBMED_TERM} (${search.json.esearchresult.count} hits, by relevance)` });
  // a few spare ids: an abstract too short to stand as a document is skipped
  const ids = search.json.esearchresult.idlist.slice(0, Math.ceil(nAbstracts * 1.2));
  const fetched = await fetchText(`${EUTILS}/efetch.fcgi?db=pubmed&retmode=xml&tool=knode-os-eval&id=${ids.join(',')}`, { license: PUBMED_LICENSE, name: `efetch-${hid(...ids)}.xml` });
  writer.addSource({ ...fetched.record, note: `efetch: ${ids.length} PubMed records (XML)` });
  const abstracts = parsePubmed(fetched.text)
    .filter((a) => a.pmid && a.title && a.sections.reduce((n, s) => n + s.text.length, 0) >= 400)
    .slice(0, nAbstracts);

  const perProduct: Doc[][][] = [];
  for (const p of PRODUCTS) {
    const url = `https://api.fda.gov/drug/label.json?search=${encodeURIComponent(`openfda.brand_name:"${p.brand}"`)}&limit=20`;
    const { json, record } = await fetchJson<{ results?: FdaLabel[] }>(url, { license: FDA_LICENSE, name: `label-${p.brand.toLowerCase()}.json` });
    const label = chooseLabel(json.results ?? [], p.brand, p.holder);
    if (!label) {
      ctx.log(`medicine-us: no openFDA label for ${p.brand}`);
      continue;
    }
    writer.addSource({ ...record, note: `${p.brand} label set_id ${label.set_id}, effective ${label.effective_time}, ${label.openfda?.manufacturer_name?.[0] ?? ''}` });
    perProduct.push(labelDocs(label, p.brand));
  }
  // label documents taken section by section across products, so a small build still compares them
  const labels: Doc[] = [];
  for (let s = 0; s < LABEL_SECTIONS.length; s++) for (const product of perProduct) labels.push(...(product[s] ?? []));
  const docs = [...abstracts.map(abstractDoc), ...labels.slice(0, ctx.limit ? Math.max(0, ctx.limit - abstracts.length) : labels.length)];
  ctx.log(`medicine-us: ${abstracts.length} abstracts, ${docs.length - abstracts.length} label sections`);
  return finishDocpack({ writer, docs, lang: 'en', plan: scaledPlan({ single: 22, multi: 12, temporal: 6, unanswerable: 6, global: 4 }, docs.length, 105), perDoc: 5 }, ctx);
}

/* ------------------------------- medicine-zh ------------------------------- */

const HUATUO = 'FreedomIntelligence/huatuo_encyclopedia_qa';
const HUATUO_LICENSE = 'Apache-2.0 (dataset card; entries drawn from Chinese Wikipedia and Qianwen Health articles)';
/** The smaller of the train split's two parquet shards: about 54,000 rows. */
const HUATUO_SHARD = `https://huggingface.co/datasets/${HUATUO}/resolve/refs%2Fconvert%2Fparquet/default/train/0001.parquet`;

/** Encyclopedia section labels, in the order a disease entry presents them. */
const SECTIONS = ['概述', '病因', '原因', '病理生理', '流行病学', '症状', '临床表现', '并发症', '检查', '诊断', '诊断方法', '鉴别诊断', '治疗', '治疗方案', '治疗方法', '西医治疗', '中医治疗', '预防和治疗方法', '预防', '护理', '饮食', '注意事项', '预后'];
const SECTION_Q = new RegExp(`^(?:请描述|什么是)?(.+?)的(${SECTIONS.slice(1).join('|')})(?:是什么)?[？?]?$`);
const DEFINITION_Q = /^(?:什么是|请解释)?(.+?)(?:是什么)?[？?]$/;
const CLINICAL = new Set(['病因', '原因', '症状', '临床表现', '诊断', '诊断方法', '治疗', '治疗方案', '治疗方法', '西医治疗']);

interface QaRow {
  questions: string[][];
  answers: string[];
}

interface Entry {
  name: string;
  sections: Map<string, { question: string; answer: string }>;
}

async function readHuatuo(file: string): Promise<QaRow[]> {
  // loaded here, not with the module: every recipe module is imported whenever the eval CLI starts
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const db = await DuckDBInstance.create(':memory:');
  const conn = await db.connect();
  try {
    const r = await conn.runAndReadAll(`SELECT questions, answers FROM read_parquet('${file.replace(/'/g, "''")}')`);
    return r.getRowObjectsJson() as unknown as QaRow[];
  } finally {
    conn.closeSync();
    db.closeSync();
  }
}

/** Disease entries rebuilt from the templated questions: X的症状是什么？ → entry X, section 症状. */
function diseaseEntries(rows: QaRow[]): Entry[] {
  const entries = new Map<string, Entry>();
  const definitions = new Map<string, { question: string; answer: string }>();
  const entry = (name: string) => entries.get(name) ?? entries.set(name, { name, sections: new Map() }).get(name)!;
  for (const row of rows) {
    const qs = row.questions.flat();
    const answer = (row.answers[0] ?? '').trim();
    if (answer.length < 15 || !qs.length) continue;
    const s = qs.map((q) => q.match(SECTION_Q)).find(Boolean);
    if (s) {
      const e = entry(s[1]);
      if (!e.sections.has(s[2]) && ![...e.sections.values()].some((x) => x.answer === answer)) e.sections.set(s[2], { question: qs[0], answer });
      continue;
    }
    // a definition comes in several phrasings: X是什么？ / 什么是X？
    const d = qs.length > 1 ? qs.map((q) => q.match(DEFINITION_Q)?.[1]) : [];
    if (d.length && d[0] && d.every((x) => x === d[0])) definitions.set(d[0], { question: qs[0], answer });
  }
  for (const [name, def] of definitions) entries.get(name)?.sections.set('概述', def);
  return [...entries.values()].filter((e) => e.name.length <= 20 && [...e.sections.keys()].some((k) => CLINICAL.has(k)));
}

/** An entry as one document, or — when long — as parts cut between sections; and the document holding each section. */
function entryDocs(e: Entry, max = 7000): { docs: Doc[]; docOf: Map<string, string> } {
  const order = [...e.sections.keys()].sort((a, b) => SECTIONS.indexOf(a) - SECTIONS.indexOf(b));
  const len = (k: string) => e.sections.get(k)!.answer.length;
  const groups: string[][] = [[]];
  let size = 0;
  for (const k of order) {
    if (size && size + len(k) > max && order.reduce((n, x) => n + len(x), 0) > max * 1.3) {
      groups.push([]);
      size = 0;
    }
    groups.at(-1)!.push(k);
    size += len(k);
  }
  const base = `diseases/${e.name.replace(/[\\/:*?"<>|\s]/g, '_')}`;
  const docOf = new Map<string, string>();
  const docs = groups.map((keys, i) => {
    const part = groups.length > 1 ? `（${i + 1}/${groups.length}）` : '';
    const p = `${base}${groups.length > 1 ? `-${i + 1}` : ''}.md`;
    for (const k of keys) docOf.set(k, p);
    return { path: p, title: `${e.name}${part}`, lang: 'zh', source: HUATUO, kind: 'encyclopedia', text: `# ${e.name}${part}\n\n${keys.map((k) => `## ${k}\n\n${e.sections.get(k)!.answer}`).join('\n\n')}\n` };
  });
  return { docs, docOf };
}

async function buildMedicineZh(dir: string, ctx: RecipeContext) {
  const n = ctx.limit ?? Number(ctx.options.diseases ?? 100);
  const seed = ctx.seed ?? 0;
  const writer = new PackWriter(dir, {
    id: 'medicine-zh',
    version: 1,
    title: '中文医学百科：疾病条目',
    domain: 'medicine',
    languages: ['zh'],
    description: `${n} disease entries rebuilt from ${HUATUO} (one document per disease, a section per encyclopedia answer); the dataset's own questions with its answers as model-free tasks.`,
    builder: { recipe: 'medicine-zh', options: { diseases: n, shard: 'train/0001.parquet', limit: ctx.limit } },
  });
  const { file, record } = await fetchCached(HUATUO_SHARD, { license: HUATUO_LICENSE, name: 'huatuo_encyclopedia_qa-train-0001.parquet', maxBytes: 120 * 1024 * 1024 });
  writer.addSource({ ...record, note: 'train split, parquet shard 0001 of 0000–0001 (Hugging Face parquet conversion)' });
  const rows = await readHuatuo(file);

  // the fullest entries first; among equals, a seeded order
  const ranked = bySeed(diseaseEntries(rows).filter((e) => e.sections.size >= 3), seed, (e) => e.name).sort((a, b) => b.sections.size - a.sections.size);
  const chosen = ranked.slice(0, n).map((entry) => ({ entry, ...entryDocs(entry) }));
  const docs = chosen.flatMap((x) => x.docs);

  // one of each entry's own questions, its answer short enough to grade against
  const tasks: Task[] = [];
  for (const { entry, docOf } of bySeed(chosen, seed, (x) => x.entry.name).slice(0, 36)) {
    const options = [...entry.sections.entries()].filter(([, s]) => s.answer.length >= 30 && s.answer.length <= 600);
    const [label, s] = bySeed(options, seed, ([l]) => entry.name + l)[0] ?? [];
    if (!label || !s) continue;
    const lead = s.answer.split(/[。！？\n]/)[0].slice(0, 60);
    tasks.push({
      id: `medicine-zh-qa-${hid(entry.name, label)}`, suite: 'usage', type: 'single-hop', lang: 'zh',
      question: s.question, answer: s.answer, scoring: 'judge', primary: true,
      evidence: [{ doc: docOf.get(label)!, ...(lead.length >= 8 ? { quote: lead } : {}) }], meta: { origin: 'dataset', section: label },
    });
  }
  ctx.log(`medicine-zh: ${rows.length} rows, ${ranked.length} entries with 3+ sections, ${chosen.length} entries in ${docs.length} documents, ${tasks.length} dataset questions`);
  return finishDocpack({ writer, docs, lang: 'zh', tasks, plan: scaledPlan({ multi: 8, unanswerable: 6, global: 4 }, docs.length, 100), perDoc: 4 }, ctx);
}

/** Pack recipes for the medicine domain (docs/design/23 §2). */
export function registerMedicineRecipes(): void {
  registerRecipe({ id: 'medicine-us', title: 'GLP-1 receptor agonists for obesity: PubMed trial abstracts and FDA labels', domain: 'medicine', network: true, needsAuthor: true, build: buildMedicineUs });
  registerRecipe({ id: 'medicine-zh', title: 'Chinese medical encyclopedia disease entries (Huatuo) with the dataset’s own QA', domain: 'medicine', network: true, needsAuthor: true, build: buildMedicineZh });
}
