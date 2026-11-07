import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runProcess } from '../../llm/cli.js';
import { foldSpace, seededKey } from '../pack.js';
import type { CorpusDoc, Task } from '../types.js';
import { finishDocpack } from './docpack.js';
import { fetchCached, hfRows } from './fetch.js';
import type { TaskPlan } from './gold.js';
import { registerRecipe, RecipeContext } from './index.js';
import { PackWriter } from './writer.js';

/**
 * Law packs (docs/design/23 §2).
 *
 * `law-cn`: Chinese national laws in force — the Civil Code's general part
 * and contract book, the company, securities, labour contract, personal
 * information, data security and cybersecurity laws — from the
 * twang2218/chinese-law-and-regulations dataset, one document per chapter.
 * Statutes cite each other by article, so the gold links come without a
 * model: every explicit cross-reference (本法第X条, 本编第X条, 《…法》) is a
 * `refers_to` link. When each law was adopted or last amended (its header)
 * and when it took effect (its final article) give model-free temporal tasks.
 *
 * `law-us`: commercial contracts from CUAD v1 (The Atticus Project, CC BY
 * 4.0), each split into parts. Lawyers annotated 41 clause types in every
 * contract; the crisp ones become model-free tasks — governing law, the
 * agreement date, and yes/no questions on clauses whose presence or absence
 * the annotation settles.
 *
 * Both packs add author-drafted QA (docpack) on top.
 */

type Doc = CorpusDoc & { text: string };

const hid = (...parts: string[]) => crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 10);

const bySeed = <T>(items: T[], seed: string | number, key: (t: T) => string) =>
  [...items].sort((a, b) => seededKey(seed, key(a)).localeCompare(seededKey(seed, key(b))));

/** A small build drafts proportionally fewer tasks. */
function scaledPlan(plan: TaskPlan, docs: number, full: number): TaskPlan {
  const f = Math.min(1, docs / full);
  return Object.fromEntries(Object.entries(plan).map(([k, n]) => [k, n ? Math.max(1, Math.round(n * f)) : 0]));
}

/* --------------------------------- law-cn --------------------------------- */

const CN_DATASET = 'twang2218/chinese-law-and-regulations';
const CN_LICENSE = 'Apache-2.0 (dataset); statute texts are not subject to copyright (著作权法第五条)';
const CN_LAWS = ['中华人民共和国民法典', '中华人民共和国公司法', '中华人民共和国证券法', '中华人民共和国劳动合同法', '中华人民共和国个人信息保护法', '中华人民共和国数据安全法', '中华人民共和国网络安全法'];
/** The Civil Code's books (编) kept: the general part and contracts. */
const CIVIL_CODE_BOOKS = ['总则', '合同'];

interface LawRow {
  publish_date: string;
  effective_date: string;
  type: string;
  status: string;
  title: string;
  office: string;
  content?: string;
}

const NUM = '[零〇一二三四五六七八九十百千两]+';
const HEADING = new RegExp(`^第(${NUM})(编|分编|章|节)\\s*(.*)$`);
const ARTICLE = new RegExp(`^第(${NUM})条\\s`);
const REF = new RegExp(`(?:本法|本编)((?:第${NUM}条(?:第${NUM}款)?(?:第${NUM}项)?(?:[、和或及至]|或者|以及)*)+)`, 'g');

function cnNumber(s: string): number {
  const digit: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const unit: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let total = 0;
  let cur = 0;
  for (const ch of s) {
    if (ch in digit) cur = digit[ch];
    else if (ch in unit) {
      total += (cur || 1) * unit[ch];
      cur = 0;
    }
  }
  return total + cur;
}

const cnDate = (iso: string) => `${Number(iso.slice(0, 4))}年${Number(iso.slice(5, 7))}月${Number(iso.slice(8, 10))}日`;
const squash = (s: string) => s.replace(/\s+/g, '');
const shortName = (title: string) => title.replace(/^中华人民共和国/, '');

interface Article {
  no: string;
  lines: string[];
}

/** An article, or a section (节) heading. */
interface Block {
  lines: string[];
  article?: Article;
  heading?: boolean;
}

interface Chapter {
  book?: { no: string; title: string };
  no: number;
  label: string;
  title: string;
  blocks: Block[];
}

interface ParsedLaw {
  row: LawRow;
  short: string;
  header: string;
  chapters: Chapter[];
}

/** A statute's header (adoption and amendment history) and its chapters, in order. */
function parseLaw(row: LawRow): ParsedLaw {
  const lines = (row.content ?? '')
    .replace(/\\([<>])/g, '$1')
    .split('\n')
    .map((l) => l.replace(/^[>\s]+/, '').replace(/\s+$/, ''))
    .filter(Boolean);
  const firstArticle = lines.findIndex((l) => ARTICLE.test(l));
  if (firstArticle < 0) throw new Error(`${row.title}: no articles found`);
  const firstHeading = lines.findIndex((l) => HEADING.test(l));
  let start = firstArticle;
  if (firstHeading >= 0 && firstHeading < firstArticle) {
    // a table of contents repeats the first heading before the body begins
    const again = lines.findIndex((l, i) => i > firstHeading && i < firstArticle && squash(l) === squash(lines[firstHeading]));
    start = again >= 0 ? again : firstHeading;
  }
  const titleAt = lines.findIndex((l) => squash(l) === squash(row.title));
  const preamble = lines.slice(titleAt + 1, start);
  const toc = preamble.findIndex((l) => squash(l) === '目录');
  const header = (toc >= 0 ? preamble.slice(0, toc) : preamble.filter((l) => !HEADING.test(l))).join('');

  const chapters: Chapter[] = [];
  let book: Chapter['book'];
  let chapter: Chapter | undefined;
  let block: Block | undefined;
  const open = (no: number, label: string, title: string) => {
    chapter = { book, no, label, title, blocks: [] };
    chapters.push(chapter);
    block = undefined;
  };
  for (const line of lines.slice(start)) {
    const h = line.match(HEADING);
    if (h) {
      const [, no, level, rawTitle] = h;
      const title = squash(rawTitle);
      if (level === '编') {
        book = { no, title };
        chapter = undefined;
      } else if (level === '章') open(cnNumber(no), `第${no}章 ${title}`, title);
      else if (chapter) {
        block = undefined;
        chapter.blocks.push({ lines: [`## 第${no}${level} ${title}`], heading: true });
      }
      continue;
    }
    if (squash(line) === '附则') {
      open((chapters.at(-1)?.no ?? 0) + 1, '附则', '附则');
      continue;
    }
    if (!chapter) open(1, '正文', '正文');
    const a = line.match(ARTICLE);
    if (a || !block) {
      block = { lines: [], ...(a ? { article: { no: a[1], lines: [] } } : {}) };
      chapter!.blocks.push(block);
    }
    block.lines.push(line);
    block.article?.lines.push(line);
  }
  return { row, short: shortName(row.title), header, chapters };
}

/** A chapter as one document, or — when long — as runs of articles, cut preferably at a section heading. */
function pieces(c: Chapter, max = 6000): Block[][] {
  const len = (b: Block) => b.lines.join('').length;
  if (c.blocks.reduce((n, b) => n + len(b), 0) <= max * 1.5) return [c.blocks];
  const out: Block[][] = [[]];
  let size = 0;
  for (const b of c.blocks) {
    if (size && (size + len(b) > max || (b.heading && size > max / 2))) {
      out.push([]);
      size = 0;
    }
    out.at(-1)!.push(b);
    size += len(b);
  }
  return out;
}

function lawDocs(law: ParsedLaw, books: string[]): { doc: Doc; articles: Article[] }[] {
  const kept = law.chapters.filter((c) => !c.book || books.includes(c.book.title));
  return kept.flatMap((c, ci) => {
    const bookPart = c.book ? `第${c.book.no}编 ${c.book.title} · ` : '';
    const dir = c.book ? `${law.short}/${String(cnNumber(c.book.no)).padStart(2, '0')}-${c.book.title}` : law.short;
    const runs = pieces(c);
    return runs.map((blocks, k) => {
      const articles = blocks.flatMap((b) => (b.article ? [b.article] : []));
      const range = runs.length > 1 && articles.length ? `（第${articles[0].no}条至第${articles.at(-1)!.no}条）` : '';
      const p = `${dir}/${String(c.no).padStart(2, '0')}-${c.title.replace(/[\\/:*?"<>|]/g, '')}${runs.length > 1 ? `-${k + 1}` : ''}.md`;
      const label = `${law.row.title} · ${bookPart}${c.label}${range}`;
      const body = blocks.flatMap((b) => b.lines).join('\n\n');
      const text = [`# ${label}`, ci === 0 && k === 0 && law.header ? law.header : '', body].filter(Boolean).join('\n\n') + '\n';
      return { doc: { path: p, title: label, date: law.row.publish_date.slice(0, 10), lang: 'zh', source: `${CN_DATASET}: ${law.row.title}`, kind: 'statute', text }, articles };
    });
  });
}

/** Explicit cross-references in an article: to articles of the same law, and to other laws by name. */
function crossRefs(law: ParsedLaw, a: Article): { tail: string; internal: boolean }[] {
  const text = a.lines.join('');
  const out: { tail: string; internal: boolean }[] = [];
  for (const m of text.matchAll(REF)) {
    for (const t of m[1].matchAll(new RegExp(`第(${NUM})条`, 'g'))) if (t[1] !== a.no) out.push({ tail: `${law.short} 第${t[1]}条`, internal: true });
  }
  for (const m of text.matchAll(/《([^》]+)》/g)) {
    const name = shortName(m[1]);
    if (!m[1].startsWith('关于') && name !== law.short) out.push({ tail: name, internal: false });
  }
  return out;
}

/** Drafted corpus-level tasks for law-cn, beside its model-free ones: profiles of legal subjects, the rare disagreement, chains. */
export const LAW_CN_CORPUS = { profile: 8, timeline: 0, contradiction: 4, aggregate: 0, deep: 4 };

/** Legal terms whose articles a corpus-level task lists: spread across chapters, so the list needs many documents. */
const LAW_TERMS = [
  '国务院', '书面', '公告', '登记', '股东会', '董事会', '监事会', '职工', '工会', '劳动报酬', '经济补偿', '违约金', '期限届满', '三十日', '十五日', '六个月', '诉讼时效',
  '法定代表人', '个人信息处理者', '网络运营者', '关键信息基础设施', '数据处理', '未成年人', '监护人', '代理人', '解除合同', '不可抗力', '信息披露', '证券交易所', '上市公司',
  '内幕信息', '试用期', '劳务派遣', '竞业限制', '网信部门', '公安机关', '责令改正', '没收违法所得', '有关主管部门', '国家标准', '合法权益', '损害赔偿', '善意相对人', '担保',
  '人民法院', '仲裁', '县级以上', '行政法规', '处分', '罚款', '警告', '吊销', '营业执照', '注册资本', '出资', '清算', '分立', '合并', '债权人', '债务人', '抵押', '质押',
  '要约', '格式条款', '撤销', '无效', '追认', '公示', '备案', '许可', '保密', '安全评估', '出境', '敏感个人信息', '删除', '社会保险', '工资', '加班', '国务院证券监督管理机构',
  '投资者', '中介机构', '会计师事务所', '公司章程', '有限责任公司', '股份有限公司', '国家机关', '个人信息', '重要数据', '网络产品', '监督管理', '民事法律行为', '相对人', '第三人',
];

interface LawArticle {
  law: ParsedLaw;
  no: string;
  text: string;
  first: string;
  doc: string;
}

/** `第六十八条` → `第68条`: the other way an answer writes an article number. */
const arabicArticle = (no: string) => `第${cnNumber(no)}条`;

/**
 * Corpus-level tasks from the statutes themselves, without a model: which
 * articles of a law mention a term (an exact list, and a count), the laws in
 * order of commencement and of their latest amendment, and chains through
 * internal cross-references (article A cites B, B cites C, each in another
 * chapter). A law-scoped task's gold is closed under its law's folder, so
 * padding from other laws cannot change it.
 */
function statuteCorpusTasks(parsed: ParsedLaw[], articles: LawArticle[], headerDocs: { law: ParsedLaw; doc: string; quote: string; date: string }[], commenced: { law: ParsedLaw; date: string; doc: string; quote: string }[], seed: string | number): Task[] {
  const tasks: Task[] = [];
  const dirOf = (law: ParsedLaw) => `${law.short}/`;
  const ev = (a: LawArticle) => ({ doc: a.doc, quote: a.first });
  const candidates: { law: ParsedLaw; term: string; hits: LawArticle[] }[] = [];
  for (const law of parsed) {
    const own = articles.filter((a) => a.law === law);
    for (const term of LAW_TERMS) {
      const hits = own.filter((a) => a.text.includes(term));
      if (hits.length >= 5 && hits.length <= 25 && new Set(hits.map((a) => a.doc)).size >= 5) candidates.push({ law, term, hits });
    }
  }
  const ordered = bySeed(candidates, seed, (c) => `${c.law.short}|${c.term}`);
  // lists first, a law at a time; counts from the rest
  const perLaw = new Map<string, number>();
  const listed: typeof candidates = [];
  for (const c of ordered) {
    if ((perLaw.get(c.law.short) ?? 0) >= 6 || listed.length >= 26) continue;
    perLaw.set(c.law.short, (perLaw.get(c.law.short) ?? 0) + 1);
    listed.push(c);
  }
  for (const c of listed) {
    tasks.push({
      id: `law-cn-terms-${hid(c.law.short, c.term)}`, suite: 'usage', type: 'aggregate', lang: 'zh',
      question: `在收录的《${c.law.row.title}》条文中，哪些条文提到了“${c.term}”？请列出全部条号。`, scoring: 'set',
      items: c.hits.map((a) => ({ label: `第${a.no}条`, aliases: [arabicArticle(a.no)], weight: 1, docs: [a.doc] })),
      list: { match: 'alias', ordered: false, maxItems: Math.min(40, c.hits.length + 10), requireDocs: false, primary: 'f1' },
      closedWorld: { terms: [], prefixes: [dirOf(c.law)] }, evidence: c.hits.map(ev), primary: tasks.length < 6, meta: { origin: 'model-free', term: c.term },
    });
  }
  // counts: terms no list asks about first, then listed ones (a count is a different question of the same gold)
  for (const c of [...ordered.filter((x) => !listed.includes(x)), ...listed].slice(0, 10)) {
    tasks.push({
      id: `law-cn-count-${hid(c.law.short, c.term)}`, suite: 'usage', type: 'aggregate', lang: 'zh',
      question: `在收录的《${c.law.row.title}》条文中，提到“${c.term}”的条文一共有几条？`, answer: String(c.hits.length), scoring: 'count',
      closedWorld: { terms: [], prefixes: [dirOf(c.law)] }, evidence: c.hits.map(ev), meta: { origin: 'model-free', term: c.term },
    });
  }
  // the laws in order: of commencement, and of the latest adoption or amendment
  if (new Set(commenced.map((c) => c.doc)).size >= 5) {
    const items = [...commenced].sort((a, b) => a.law.row.effective_date.localeCompare(b.law.row.effective_date));
    tasks.push({
      id: 'law-cn-commenced-order', suite: 'usage', type: 'timeline', lang: 'zh',
      question: '按施行日期从早到晚，列出收录的这些法律，并注明各自的施行日期。', scoring: 'set',
      items: items.map((c) => ({ label: c.law.short, aliases: [c.law.row.title], weight: 1, date: c.law.row.effective_date.slice(0, 10), docs: [c.doc] })),
      list: { match: 'alias', ordered: true, maxItems: 15, requireDocs: false, primary: 'f1' }, closedWorld: { terms: [], prefixes: items.map((c) => dirOf(c.law)) },
      evidence: items.map((c) => ({ doc: c.doc, quote: c.quote })), meta: { origin: 'model-free' },
    });
  }
  const isoOf = (cn: string) => {
    const m = cn.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
  };
  const amended = headerDocs.filter((h) => isoOf(h.date));
  if (new Set(amended.map((h) => h.doc)).size >= 5) {
    const items = [...amended].sort((a, b) => isoOf(a.date).localeCompare(isoOf(b.date)));
    tasks.push({
      id: 'law-cn-amended-order', suite: 'usage', type: 'timeline', lang: 'zh',
      question: '按最近一次通过、修正或修订的时间从早到晚，列出收录的这些法律，并注明日期。', scoring: 'set',
      items: items.map((h) => ({ label: h.law.short, aliases: [h.law.row.title], weight: 1, date: isoOf(h.date), docs: [h.doc] })),
      list: { match: 'alias', ordered: true, maxItems: 15, requireDocs: false, primary: 'f1' }, closedWorld: { terms: [], prefixes: items.map((h) => dirOf(h.law)) },
      evidence: items.map((h) => ({ doc: h.doc, quote: h.quote })), meta: { origin: 'model-free' },
    });
    const years = items.map((h) => Number(isoOf(h.date).slice(0, 4))).sort((a, b) => a - b);
    const cut = years[Math.floor(years.length / 2)];
    const after = items.filter((h) => Number(isoOf(h.date).slice(0, 4)) >= cut);
    tasks.push({
      id: 'law-cn-amended-since', suite: 'usage', type: 'aggregate', lang: 'zh',
      question: `收录的法律中，哪些是在${cut}年或之后通过或最近一次修改的？`, scoring: 'set',
      items: after.map((h) => ({ label: h.law.short, aliases: [h.law.row.title], weight: 1, docs: [h.doc] })),
      list: { match: 'alias', ordered: false, maxItems: 15, requireDocs: false, primary: 'f1' }, closedWorld: { terms: [], prefixes: items.map((h) => dirOf(h.law)) },
      evidence: items.map((h) => ({ doc: h.doc, quote: h.quote })), meta: { origin: 'model-free' },
    });
  }
  // chains through cross-references: A → B → C, each article in another chapter
  const byNo = new Map(articles.map((a) => [`${a.law.short}|${a.no}`, a]));
  const refsOf = (a: LawArticle) => crossRefs(a.law, { no: a.no, lines: [a.text] }).filter((r) => r.internal).map((r) => byNo.get(`${a.law.short}|${r.tail.split(' 第')[1].replace(/条$/, '')}`)).filter((x): x is LawArticle => Boolean(x));
  let chains = 0;
  for (const a of bySeed(articles, seed, (x) => `${x.law.short}|${x.no}`)) {
    if (chains >= 8) break;
    const b = refsOf(a).find((x) => x.doc !== a.doc);
    const c = b ? refsOf(b).find((x) => x.doc !== a.doc && x.doc !== b.doc && x.no !== a.no) : undefined;
    if (!b || !c) continue;
    chains++;
    const body = c.text.replace(/^第[零〇一二三四五六七八九十百千两]+条\s*/, '').slice(0, 160);
    tasks.push({
      id: `law-cn-chain-${hid(a.law.short, a.no, b.no, c.no)}`, suite: 'usage', type: 'deep-hop', lang: 'zh',
      question: `《${a.law.row.title}》第${a.no}条引用了本法的另一个条文，那个条文又引用了本法的第三个条文。第三个条文是第几条，规定了什么？`,
      answer: `第${c.no}条：${body}`, keypoints: [`第${c.no}条`], scoring: 'judge',
      evidence: [ev(a), ev(b), ev(c)], meta: { origin: 'model-free', hops: 3, bridges: [`第${b.no}条`] },
    });
  }
  return tasks;
}

/** The header's last clause — adoption, or the latest amendment — as a dated event. */
function lastEnactment(header: string): { quote: string; date: string; meeting: string; act: string } | undefined {
  const parts = header.replace(/^[（(]|[）)]$/g, '').split(/\s+/).filter(Boolean);
  const last = parts.at(-1);
  const m = last?.match(/^(?:根据)?(\d{4}年\d{1,2}月\d{1,2}日)(.+?会议)(.*)$/);
  return m ? { quote: last!, date: m[1], meeting: m[2], act: m[3] } : undefined;
}

async function buildLawCn(dir: string, ctx: RecipeContext) {
  const laws = (ctx.options.laws as string[] | undefined) ?? CN_LAWS;
  const books = (ctx.options.civilCodeBooks as string[] | undefined) ?? CIVIL_CODE_BOOKS;
  const writer = new PackWriter(dir, {
    id: 'law-cn',
    version: 1,
    title: 'Chinese civil, commercial and data laws in force',
    domain: 'law',
    languages: ['zh'],
    description: `National laws with status 有效 from twang2218/chinese-law-and-regulations (${laws.map(shortName).join('、')}; Civil Code books ${books.join('、')}), one document per chapter; cross-references between articles as model-free links, enactment and commencement dates as model-free temporal tasks.`,
    builder: { recipe: 'law-cn', options: { laws, civilCodeBooks: books, limit: ctx.limit, padding: Number(ctx.options.padding ?? 0) } },
  });

  // national laws come first in the dataset; the metadata split finds their rows without their texts
  const meta = await hfRows<LawRow>(CN_DATASET, { config: 'metadata', limit: 600, license: CN_LICENSE });
  writer.addSource({ ...meta.record, note: `metadata of the first ${meta.rows.length} rows (national laws), to locate the selected laws` });
  const parsed: ParsedLaw[] = [];
  for (const title of laws) {
    const idx = meta.rows.findIndex((r) => r.title === title && r.type === '法律' && r.status === '有效');
    if (idx < 0) throw new Error(`law-cn: ${title} is not among the national laws in force`);
    const { rows, record } = await hfRows<LawRow>(CN_DATASET, { offset: idx, limit: 1, license: CN_LICENSE });
    const row = rows[0];
    if (row?.title !== title || !row.content) throw new Error(`law-cn: row ${idx} is ${row?.title ?? 'missing'}, expected ${title}`);
    writer.addSource({ ...record, note: `${title} (row ${idx}, ${row.content.length} chars, published ${row.publish_date.slice(0, 10)}, effective ${row.effective_date.slice(0, 10)})` });
    parsed.push(parseLaw(row));
  }

  const perLaw = parsed.map((l) => lawDocs(l, books));
  const all = perLaw.flat();
  // a limited build still spans every law: chapters are taken round-robin
  const keep = new Set<string>();
  for (let i = 0; keep.size < (ctx.limit ?? all.length) && i < Math.max(...perLaw.map((x) => x.length)); i++) {
    for (const list of perLaw) if (list[i] && keep.size < (ctx.limit ?? all.length)) keep.add(list[i].doc.path);
  }
  const chosen = all.filter((x) => keep.has(x.doc.path));
  const docs = chosen.map((x) => x.doc);
  const docOfArticle = new Map<string, string>();
  for (const [li, list] of perLaw.entries()) {
    for (const x of list) if (keep.has(x.doc.path)) for (const a of x.articles) docOfArticle.set(`${parsed[li].short}|${a.no}`, x.doc.path);
  }

  const seenLink = new Set<string>();
  for (const [li, law] of parsed.entries()) {
    writer.addAlias({ canonical: law.short, aliases: [law.row.title] });
    for (const x of perLaw[li]) {
      if (!keep.has(x.doc.path)) continue;
      for (const a of x.articles) {
        const head = `${law.short} 第${a.no}条`;
        for (const r of crossRefs(law, a)) {
          if (seenLink.has(`${head}|${r.tail}`)) continue;
          seenLink.add(`${head}|${r.tail}`);
          writer.addLink({ head, relation: 'refers_to', tail: r.tail, doc: x.doc.path, origin: 'model-free' });
        }
      }
    }
  }
  for (const name of new Set([...seenLink].map((k) => k.split('|')[1]).filter((t) => !t.includes(' 第')))) {
    if (!parsed.some((l) => l.short === name)) writer.addAlias({ canonical: name, aliases: [`中华人民共和国${name}`] });
  }

  const tasks: Task[] = [];
  const commenced: { law: ParsedLaw; date: string; doc: string; quote: string }[] = [];
  const headers: { law: ParsedLaw; doc: string; quote: string; date: string }[] = [];
  for (const [li, law] of parsed.entries()) {
    const headerDoc = perLaw[li][0]?.doc.path;
    const e = lastEnactment(law.header);
    if (e && headerDoc && keep.has(headerDoc)) headers.push({ law, doc: headerDoc, quote: e.quote, date: e.date });
    if (e && headerDoc && keep.has(headerDoc) && e.date === cnDate(law.row.publish_date)) {
      const adopted = e.act.endsWith('通过');
      tasks.push({
        id: `law-cn-date-${hid(law.row.title, 'enacted')}`, suite: 'usage', type: 'temporal', lang: 'zh',
        question: adopted ? `《${law.row.title}》是在哪一天、由哪次会议通过的？` : `《${law.row.title}》现行文本最近一次修正或修订是在哪一天、由哪次会议作出的？`,
        answer: `${e.date}，${e.meeting}${e.act}`, scoring: 'judge',
        evidence: [{ doc: headerDoc, quote: e.quote }], meta: { origin: 'model-free', publish_date: law.row.publish_date.slice(0, 10) },
      });
    }
    // the commencement article states the date the law (as first enacted) took effect: a task only when it is still the effective date
    for (const a of law.chapters.flatMap((c) => c.blocks.flatMap((b) => (b.article ? [b.article] : [])))) {
      const m = a.lines.join('').match(/本法自(\d{4}年\d{1,2}月\d{1,2}日)起施行/);
      const doc = docOfArticle.get(`${law.short}|${a.no}`);
      if (!m || !doc || m[1] !== cnDate(law.row.effective_date)) continue;
      commenced.push({ law, date: m[1], doc, quote: m[0] });
      tasks.push({
        id: `law-cn-date-${hid(law.row.title, 'effective')}`, suite: 'usage', type: 'temporal', lang: 'zh',
        question: `《${law.row.title}》自何时起施行？`, answer: m[1], answers: [m[1], law.row.effective_date.slice(0, 10)], scoring: 'exact',
        evidence: [{ doc, quote: m[0] }], meta: { origin: 'model-free', effective_date: law.row.effective_date.slice(0, 10) },
      });
    }
  }
  const pairs = commenced.flatMap((a, i) => commenced.slice(i + 1).map((b) => [a, b] as const)).filter(([a, b]) => a.date !== b.date);
  for (const [a, b] of bySeed(pairs, ctx.seed ?? 0, ([x, y]) => x.law.short + y.law.short).slice(0, 3)) {
    const [first, second] = a.law.row.effective_date < b.law.row.effective_date ? [a, b] : [b, a];
    tasks.push({
      id: `law-cn-order-${hid(a.law.short, b.law.short)}`, suite: 'usage', type: 'temporal', lang: 'zh',
      question: `《${a.law.row.title}》和《${b.law.row.title}》哪一部先施行？`,
      answer: `《${first.law.row.title}》先施行（${first.date}起施行），《${second.law.row.title}》${second.date}起施行。`, keypoints: [first.law.short, first.date, second.date], scoring: 'judge',
      evidence: [{ doc: a.doc, quote: a.quote }, { doc: b.doc, quote: b.quote }], meta: { origin: 'model-free' },
    });
  }
  const lawArticles: LawArticle[] = perLaw.flatMap((list, li) => list.filter((x) => keep.has(x.doc.path)).flatMap((x) => x.articles.map((a) => ({
    law: parsed[li], no: a.no, text: a.lines.join(''), first: a.lines[0].slice(0, 40), doc: x.doc.path,
  }))));
  const corpusLevel = statuteCorpusTasks(parsed, lawArticles, headers, commenced, ctx.seed ?? 0);
  ctx.log(`law-cn: ${docs.length} chapters from ${parsed.length} laws, ${seenLink.size} cross-reference links, ${tasks.length} model-free date tasks, ${corpusLevel.length} model-free corpus-level tasks`);
  tasks.push(...corpusLevel);

  // padding for scale curves: chapters of other national laws in force (each fetched once, then cached)
  const padding = Number(ctx.options.padding ?? 0);
  const candidates: Doc[] = [];
  if (padding > 1) {
    const want = Math.ceil(docs.length * (padding - 1) * 1.3);
    const others = bySeed(meta.rows.map((r, idx) => ({ r, idx })).filter(({ r }) => r.type === '法律' && r.status === '有效' && !laws.includes(r.title)), ctx.seed ?? 0, ({ r }) => r.title);
    for (const { r, idx } of others) {
      if (candidates.length >= want) break;
      try {
        const { rows, record } = await hfRows<LawRow>(CN_DATASET, { offset: idx, limit: 1, license: CN_LICENSE });
        if (rows[0]?.title !== r.title || !rows[0].content) continue;
        writer.addSource({ ...record, note: `padding: ${r.title} (row ${idx})` });
        const other = parseLaw(rows[0]);
        for (const x of lawDocs(other, other.chapters.flatMap((c) => (c.book ? [c.book.title] : [])))) candidates.push(x.doc);
      } catch (err) {
        ctx.log(`padding: ${r.title} skipped (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    ctx.log(`padding: ${candidates.length} chapters of other laws as candidates`);
  }
  return finishDocpack({
    writer, docs, lang: 'zh', tasks, plan: scaledPlan({ single: 20, multi: 10, temporal: 3, unanswerable: 6, global: 4 }, docs.length, 100), perDoc: 5,
    corpus: LAW_CN_CORPUS,
    ...(padding > 1 ? { padding: { candidates, multiple: padding } } : {}),
  }, ctx);
}

/* --------------------------------- law-us --------------------------------- */

const CUAD_URL = 'https://github.com/TheAtticusProject/cuad/raw/main/data.zip';
const CUAD_LICENSE = 'CC BY 4.0 (The Atticus Project, CUAD v1)';

interface CuadQa {
  id: string;
  answers: { text: string; answer_start: number }[];
}
interface CuadContract {
  title: string;
  paragraphs: { context: string; qas: CuadQa[] }[];
}

/** Clause types whose annotation settles a yes/no question about the contract. */
const YES_NO: Record<string, string> = {
  'Non-Compete': 'Does {c} restrict a party from competing with the counterparty or operating in a field or territory (a non-compete clause)?',
  Exclusivity: 'Does {c} contain an exclusivity commitment (exclusive rights or exclusive dealing)?',
  'Change Of Control': 'Does {c} give a party rights (such as termination or consent) when the other party undergoes a change of control?',
  'Audit Rights': "Does {c} give a party the right to audit the other party's books, records or compliance?",
  'Cap On Liability': "Does {c} cap or limit a party's liability?",
  'Termination For Convenience': 'Can a party terminate {c} for convenience, without cause?',
};

const ORG = /\b(Inc|Incorporated|Corp|Corporation|LLC|L\.L\.C|Ltd|Limited|Company|Co|LP|L\.P|LLP|plc|PLC|GmbH|S\.A|N\.V|AG|AB|Trust|Bank|Holdings|Group)\b\.?/;

function titleCase(s: string): string {
  const small = new Set(['of', 'and', 'the', 'for', 'to', 'in', 'on', 'a', 'an', 'or', 'by', 'with']);
  return s.toLowerCase().replace(/[a-z][a-z'’]*/g, (w, i: number) => (i > 0 && small.has(w) ? w : w[0].toUpperCase() + w.slice(1)));
}

const cleanText = (s: string) => s.replace(/[ \t\u00a0\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/** A quote no longer than `max` characters around position `at` of a folded span, cut at word boundaries. */
function clip(span: string, max = 240, at = 0): string {
  const s = foldSpace(span);
  if (s.length <= max) return s;
  let from = Math.max(0, Math.min(at - 80, s.length - max));
  let to = from + max;
  while (from > 0 && s[from - 1] !== ' ') from++;
  while (to < s.length && s[to] !== ' ') to--;
  return s.slice(from, to).trim();
}

/** Parts of at most about `max` characters, cut between paragraphs (between lines in a paragraph too long for one part). */
function splitContract(text: string, max = 7000): string[] {
  const out: string[] = [];
  let cur = '';
  for (const p of text.split(/\n\n+/).flatMap((x) => (x.length > max ? x.split('\n') : [x]))) {
    if (cur && cur.length + p.length + 2 > max) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur && out.length && cur.length < max / 5) out[out.length - 1] += `\n\n${cur}`;
  else if (cur) out.push(cur);
  return out;
}

function jurisdiction(span: string): string | undefined {
  const s = foldSpace(span);
  const states = [...new Set([...s.matchAll(/\b(?:State|Commonwealth|Province) of ([A-Z][a-z]+(?: [A-Z][a-z]+)?)/g)].map((m) => m[1]))];
  if (states.length > 1) return undefined;
  if (states.length === 1) return states[0];
  const m = s.match(/\blaws? of (?:the )?((?:People's Republic of )?[A-Z][a-z]+(?: (?:and |of )?[A-Z][a-z]+)*)/);
  return m && !/^(United States|Federal)$/.test(m[1]) ? m[1] : undefined;
}

async function loadCuad(writer: PackWriter): Promise<CuadContract[]> {
  const { file, record } = await fetchCached(CUAD_URL, { license: CUAD_LICENSE, name: 'cuad-v1-data.zip', maxBytes: 60 * 1024 * 1024 });
  writer.addSource({ ...record, note: 'CUAD v1: 510 contracts with 41 clause categories (CUADv1.json, SQuAD format)' });
  const out = `${file}.d`;
  const json = path.join(out, 'CUADv1.json');
  if (!fs.existsSync(json)) {
    fs.mkdirSync(out, { recursive: true });
    const r = await runProcess('unzip', ['-o', '-q', file, 'CUADv1.json', '-d', out], '', 120_000);
    if (r.code !== 0) throw new Error(`unzip failed (${r.code}): ${r.stderr.slice(-300)}`);
  }
  return (JSON.parse(fs.readFileSync(json, 'utf8')) as { data: CuadContract[] }).data;
}

async function buildLawUs(dir: string, ctx: RecipeContext) {
  const count = Number(ctx.options.contracts ?? 40);
  const writer = new PackWriter(dir, {
    id: 'law-us',
    version: 1,
    title: 'US commercial contracts (CUAD)',
    domain: 'law',
    languages: ['en'],
    description: `${count} commercial contracts from CUAD v1 (EDGAR filings annotated by lawyers for 41 clause types), split into parts; model-free tasks from the clause annotations (governing law, agreement date, presence of ${Object.keys(YES_NO).join(', ')}).`,
    builder: { recipe: 'law-us', options: { contracts: count, limit: ctx.limit } },
  });
  const seed = ctx.seed ?? 0;
  const contracts = await loadCuad(writer);

  const spans = (c: CuadContract, cat: string) => c.paragraphs[0].qas.find((q) => q.id.endsWith(`__${cat}`))?.answers ?? [];
  type Selected = { c: CuadContract; name: string; label: string; parties: string[]; parts: { path: string; text: string }[] };
  const selected: Selected[] = [];
  const perType = new Map<string, number>();
  const labels = new Set<string>();
  let docCount = 0;
  for (const c of bySeed(contracts, seed, (x) => x.title)) {
    if (selected.length >= count || (ctx.limit && docCount >= ctx.limit)) break;
    const context = c.paragraphs[0].context;
    const docName = spans(c, 'Document Name')[0]?.text;
    if (context.length < 6000 || context.length > 20000 || !docName || !spans(c, 'Governing Law').length) continue;
    const name = titleCase(foldSpace(docName).replace(/^["'“]+|[\s"'”(,.;:]+$/g, ''));
    if ((perType.get(name) ?? 0) >= 2) continue;
    // named companies, not the defined terms ("Company", "Distributor") the annotation also marks
    const parties = [...new Map(spans(c, 'Parties')
      .map((s) => foldSpace(s.text).replace(/^[^:]*:\s*/, '').replace(/^["“(]+|["”),.;:(]+$/g, '').replace(/^the /i, ''))
      .filter((s) => ORG.test(s) && /[A-Z]\w/.test(s.replace(new RegExp(ORG.source, 'g'), '')) && s.length <= 80 && !/["“”]/.test(s))
      .map((s) => [s.toLowerCase().replace(new RegExp(ORG.source, 'gi'), '').replace(/[^a-z0-9]/g, ''), s] as const)).values()].slice(0, 2);
    if (!parties.length) continue;
    const label = parties.length === 2 ? `the ${name} between ${parties[0]} and ${parties[1]}` : `the ${name} of ${parties[0]}`;
    if (labels.has(label)) continue;
    const parts = splitContract(cleanText(context));
    if (ctx.limit && selected.length && docCount + parts.length > ctx.limit) continue;
    const slug = c.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
    selected.push({ c, name, label, parties, parts: parts.map((text, i) => ({ text, path: `cuad/${slug}/part-${i + 1}.md` })) });
    perType.set(name, (perType.get(name) ?? 0) + 1);
    labels.add(label);
    docCount += parts.length;
  }

  const docs: Doc[] = selected.flatMap((s) => s.parts.map((p, i) => ({
    path: p.path, title: `${s.name} (${s.parties.join(' / ')})${s.parts.length > 1 ? `, part ${i + 1} of ${s.parts.length}` : ''}`,
    lang: 'en', source: `CUAD v1: ${s.c.title}`, kind: 'contract',
    text: `# ${s.name} — ${s.parties.join(' / ')}${s.parts.length > 1 ? ` (part ${i + 1} of ${s.parts.length})` : ''}\n\n${p.text}\n`,
  })));

  /** A quote of an annotated span, and the part that holds it. */
  const locate = (s: Selected, span: string, at = 0) => {
    const quote = clip(span, 240, at);
    const part = s.parts.find((p) => foldSpace(p.text).includes(quote));
    return part && quote.length >= 8 ? { doc: part.path, quote } : undefined;
  };

  const law: Task[] = [];
  const dates: Task[] = [];
  const yesNo = new Map<string, { yes: Task[]; no: Task[] }>(Object.keys(YES_NO).map((k) => [k, { yes: [], no: [] }]));
  for (const s of selected) {
    for (const p of s.parties) writer.addLink({ head: p, relation: 'party_to', tail: s.name, doc: s.parts[0].path, origin: 'model-free' });
    const gov = spans(s.c, 'Governing Law')[0];
    const j = gov && jurisdiction(gov.text);
    const govAt = j ? foldSpace(gov.text).indexOf(j) : 0;
    const govEv = gov && locate(s, gov.text, govAt);
    if (j && govEv && govEv.quote.includes(j)) {
      law.push({
        id: `law-us-gov-${hid(s.c.title)}`, suite: 'usage', type: 'single-hop', lang: 'en',
        question: `Which jurisdiction's law governs ${s.label}?`, answer: j, answers: [j, `${j} law`, `the laws of ${j}`], scoring: 'exact',
        evidence: [govEv], primary: true, meta: { origin: 'model-free', cuad: 'Governing Law' },
      });
    }
    const date = spans(s.c, 'Agreement Date')[0];
    const dateEv = date && date.text.length <= 60 && !/_|\[/.test(date.text) && locate(s, date.text);
    if (dateEv) {
      dates.push({
        id: `law-us-date-${hid(s.c.title)}`, suite: 'usage', type: 'temporal', lang: 'en',
        question: `What is the agreement date of ${s.label}?`, answer: foldSpace(date.text).replace(/[\s.,;:(]+$/, ''), scoring: 'judge',
        evidence: [dateEv], meta: { origin: 'model-free', cuad: 'Agreement Date' },
      });
    }
    for (const [cat, q] of Object.entries(YES_NO)) {
      const found = spans(s.c, cat);
      const ev = found.map((a) => locate(s, a.text)).find(Boolean);
      if (found.length && !ev) continue;
      const task: Task = {
        id: `law-us-clause-${hid(s.c.title, cat)}`, suite: 'usage', type: 'single-hop', lang: 'en',
        question: q.replace('{c}', s.label), answer: found.length ? 'Yes' : 'No', scoring: 'exact',
        // absence rests on the whole contract
        evidence: ev ? [ev] : s.parts.map((p) => ({ doc: p.path })), meta: { origin: 'model-free', cuad: cat },
      };
      yesNo.get(cat)![found.length ? 'yes' : 'no'].push(task);
    }
  }
  const tasks = [...bySeed(law, seed, (t) => t.id).slice(0, 12), ...bySeed(dates, seed, (t) => t.id).slice(0, 8)];
  for (const { yes, no } of yesNo.values()) tasks.push(...bySeed(yes, seed, (t) => t.id).slice(0, 2), ...bySeed(no, seed, (t) => t.id).slice(0, 2));
  ctx.log(`law-us: ${selected.length} contracts in ${docs.length} parts, ${tasks.length} model-free clause tasks`);
  return finishDocpack({ writer, docs, lang: 'en', tasks, plan: scaledPlan({ single: 6, multi: 6, unanswerable: 4, global: 3 }, docs.length, 100), perDoc: 5 }, ctx);
}

/** Pack recipes for the law domain (docs/design/23 §2). */
export function registerLawRecipes(): void {
  registerRecipe({ id: 'law-cn', title: 'Chinese national laws in force (civil, company, securities, labour, data), by chapter', domain: 'law', network: true, needsAuthor: true, build: buildLawCn, corpusPlan: LAW_CN_CORPUS, modelFreeCorpus: true, padding: 'download' });
  registerRecipe({ id: 'law-us', title: 'US commercial contracts from CUAD v1 with clause-annotation tasks', domain: 'law', network: true, needsAuthor: true, build: buildLawUs });
}
