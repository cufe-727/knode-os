import { characteristicTerms, directions, profileText, STYLE_FEATURES } from '../metrics/stylometry.js';
import type { GoldItem } from '../types.js';
import { finishDocpack } from './docpack.js';
import { fetchText } from './fetch.js';
import { registerRecipe, RecipeContext } from './index.js';
import { PackWriter } from './writer.js';

/**
 * Literature (docs/design/23 §2): the opening chapters of classic novels,
 * from Project Gutenberg (public domain), for two things no other pack
 * measures — what a knowledge base knows about how an author writes, and
 * whether it can tell an unseen passage's author.
 *
 * Models have read these books, so the main characters are renamed
 * consistently (the map stays in the holdout): a plot question then has to
 * be answered from the corpus, and the closed-book reference shows how much
 * memory still leaks through. Style gold is measured, not judged: each
 * author's characteristic terms against the other authors (log-odds,
 * character bigrams for Chinese, renamed names excluded) and the directions
 * in which their sentence length, dialogue share and punctuation differ from
 * the collection's. Attribution probes are passages from later chapters that
 * are not in the corpus.
 */

interface Work {
  id: number;
  slug: string;
  title: string;
  author: string;
  rename: Record<string, string>;
}

const ZH_WORKS: Work[] = [
  { id: 24264, slug: 'hongloumeng', title: '紅樓夢', author: '曹雪芹', rename: { 寶玉: '琮玉', 黛玉: '嵐玉', 寶釵: '慧釵', 熙鳳: '熙鸞', 鳳姐: '鸞姐', 襲人: '晴人', 賈政: '賈端', 賈璉: '賈珽', 王夫人: '柳夫人' } },
  { id: 23950, slug: 'sanguoyanyi', title: '三國志演義', author: '羅貫中', rename: { 劉備: '劉泰', 玄德: '元德', 關羽: '關昂', 雲長: '雲舉', 張飛: '張勇', 翼德: '益德', 曹操: '曹翊', 孟德: '孟章', 孫權: '孫衡', 諸葛亮: '諸葛朗', 孔明: '孔昭' } },
  { id: 23962, slug: 'xiyouji', title: '西遊記', author: '吳承恩', rename: { 悟空: '悟玄', 行者: '行客', 三藏: '三慧', 八戒: '八淨', 沙僧: '沙禪', 悟淨: '悟清', 悟能: '悟拙' } },
  { id: 23863, slug: 'shuihuzhuan', title: '水滸傳', author: '施耐庵', rename: { 宋江: '宋澄', 林沖: '林峻', 魯智深: '魯覺深', 武松: '武岳', 高俅: '高猷', 晁蓋: '晁弘', 吳用: '吳敏', 李逵: '李彪' } },
];

const EN_WORKS: Work[] = [
  { id: 1342, slug: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen', rename: { Elizabeth: 'Eleanor', Lizzy: 'Nelly', Darcy: 'Thorne', Bennet: 'Barrett', Bingley: 'Hartley', Wickham: 'Wexford', Lydia: 'Letty', Collins: 'Cotton' } },
  { id: 158, slug: 'emma', title: 'Emma', author: 'Jane Austen', rename: { Emma: 'Ada', Woodhouse: 'Whitford', Knightley: 'Kingsley', Harriet: 'Hester', Elton: 'Easton', Weston: 'Weyland' } },
  { id: 1400, slug: 'great-expectations', title: 'Great Expectations', author: 'Charles Dickens', rename: { Pip: 'Kit', Estella: 'Ottilie', Havisham: 'Hallam', Joe: 'Ned', Magwitch: 'Margrave', Jaggers: 'Juggins', Pumblechook: 'Pumbleford' } },
  { id: 730, slug: 'oliver-twist', title: 'Oliver Twist', author: 'Charles Dickens', rename: { Oliver: 'Owen', Fagin: 'Faber', Dodger: 'Rambler', Bumble: 'Bramble', Nancy: 'Norah', Sikes: 'Stokes' } },
  { id: 74, slug: 'tom-sawyer', title: 'The Adventures of Tom Sawyer', author: 'Mark Twain', rename: { Tom: 'Rob', Sawyer: 'Sayer', Huck: 'Hal', Becky: 'Bessie', Polly: 'Prudence' } },
  { id: 76, slug: 'huckleberry-finn', title: 'Adventures of Huckleberry Finn', author: 'Mark Twain', rename: { Huck: 'Hal', Huckleberry: 'Halbert', Finn: 'Flint', Jim: 'Sol', Tom: 'Rob', Sawyer: 'Sayer' } },
];

function stripGutenberg(text: string): string {
  const start = text.search(/\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\n/i);
  const end = text.search(/\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG EBOOK/i);
  const body = text.slice(start >= 0 ? text.indexOf('\n', start) + 1 : 0, end > 0 ? end : undefined);
  return body.replace(/\r\n/g, '\n');
}

function chapters(text: string, lang: 'zh' | 'en'): { title: string; text: string }[] {
  const re = lang === 'zh' ? /^\s*(第[一二三四五六七八九十百零〇]+回[^\n]*)$/gm : /^\s*(CHAPTER [IVXLC\d]+\.?[^\n]*|Chapter [IVXLC\d]+\.?[^\n]*)$/gm;
  const marks = [...text.matchAll(re)].map((m) => ({ title: m[1].trim(), at: m.index! }));
  // a table of contents repeats the headings: keep the last run of increasing positions with real text between them
  const out: { title: string; text: string }[] = [];
  for (let i = 0; i < marks.length; i++) {
    const body = text.slice(marks[i].at, marks[i + 1]?.at ?? text.length).trim();
    if (body.length > (lang === 'zh' ? 1500 : 3000)) out.push({ title: marks[i].title, text: body });
  }
  return out;
}

function renameAll(text: string, map: Record<string, string>, lang: 'zh' | 'en'): string {
  let out = text;
  for (const [from, to] of Object.entries(map).sort((a, b) => b[0].length - a[0].length)) {
    out = lang === 'zh' ? out.split(from).join(to) : out.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
  }
  return out;
}

async function buildLiterature(lang: 'zh' | 'en', dir: string, ctx: RecipeContext) {
  const works = lang === 'zh' ? ZH_WORKS : EN_WORKS;
  const perWork = Number(ctx.options.chapters ?? (ctx.limit ? Math.max(1, Math.floor(ctx.limit / works.length)) : lang === 'zh' ? 12 : 8));
  const zh = lang === 'zh';
  const writer = new PackWriter(dir, {
    id: `literature-${lang}`,
    version: 1,
    title: zh ? '古典小说：四大名著前若干回（人名已替换）' : 'Classic novels: opening chapters (names replaced)',
    domain: 'literature',
    languages: [lang],
    description: `Opening chapters of ${works.map((w) => w.title).join(', ')} from Project Gutenberg, main character names consistently replaced. Style gold by stylometry; attribution probes from later chapters.`,
    builder: { recipe: `literature-${lang}`, options: { chaptersPerWork: perWork } },
    holdout: 'holdout/rename.json (the name map) and holdout/passages/ (attribution probes from later chapters).',
  });

  const docs: { path: string; title: string; author: string; lang: string; source: string; kind: string; text: string }[] = [];
  const byAuthor = new Map<string, string[]>();
  const probes: { author: string; work: Work; text: string }[] = [];
  const renameValues = new Set<string>();
  for (const work of works) {
    const { text, record } = await fetchText(`https://www.gutenberg.org/cache/epub/${work.id}/pg${work.id}.txt`, { license: 'Public domain (Project Gutenberg)', name: `pg${work.id}.txt` });
    writer.addSource(record);
    const chs = chapters(stripGutenberg(text), lang);
    if (chs.length < perWork + 6) ctx.log(`${work.title}: only ${chs.length} chapters found`);
    Object.values(work.rename).forEach((v) => renameValues.add(v));
    chs.slice(0, perWork).forEach((ch, i) => {
      const body = renameAll(ch.text, work.rename, lang);
      docs.push({ path: `${work.slug}/${String(i + 1).padStart(2, '0')}.md`, title: `${work.title} · ${ch.title}`, author: work.author, lang, source: `gutenberg:${work.id}`, kind: 'chapter', text: `# ${work.title} · ${renameAll(ch.title, work.rename, lang)}\n\n${body}` });
      (byAuthor.get(work.author) ?? byAuthor.set(work.author, []).get(work.author)!).push(body);
    });
    // probes: one passage from each of a few later chapters, not in the corpus
    for (const ch of chs.slice(perWork + 2, perWork + 5)) {
      const paras = renameAll(ch.text, work.rename, lang).split(/\n\s*\n/).filter((p) => p.length > (zh ? 120 : 300));
      const text = (paras.length > 2 ? paras.slice(1, 3) : paras.slice(0, 2)).join('\n\n').slice(0, zh ? 500 : 1200);
      if (text.length > (zh ? 150 : 400)) probes.push({ author: work.author, work, text });
    }
  }

  const authors = [...byAuthor.keys()];
  const allText = [...byAuthor.values()].flat().join('\n');
  const collection = profileText(allText, lang);
  const exclude = new Set<string>();
  for (const w of works) for (const [k, v] of Object.entries(w.rename)) {
    exclude.add(k.toLowerCase());
    exclude.add(v.toLowerCase());
    if (zh) for (const name of [k, v]) for (let i = 0; i + 2 <= name.length; i++) exclude.add(name.slice(i, i + 2));
  }
  // proper nouns in English: words written capitalized nearly always
  if (!zh) {
    const caps = new Map<string, [number, number]>();
    for (const m of allText.matchAll(/\b([A-Za-z][a-z]+)\b/g)) {
      const w = m[1].toLowerCase();
      const c = caps.get(w) ?? [0, 0];
      c[/[A-Z]/.test(m[1][0]) ? 0 : 1]++;
      caps.set(w, c);
    }
    for (const [w, [upper, lower]] of caps) if (upper > 3 && upper > 4 * lower) exclude.add(w);
  }
  const tasks: Parameters<PackWriter['addTask']>[0][] = [];
  const profile: Record<string, unknown> = { collection };
  for (const author of authors) {
    const own = byAuthor.get(author)!.join('\n');
    const rest = authors.filter((a) => a !== author).map((a) => byAuthor.get(a)!.join('\n')).join('\n');
    const terms = characteristicTerms(own, rest, { lang, k: 50, minCount: zh ? 8 : 6, exclude });
    const prof = profileText(own, lang);
    const dirs = directions(prof, collection);
    profile[author] = { profile: prof, directions: dirs, terms };
    const evidence = docs.filter((d) => d.author === author).slice(0, 4).map((d) => ({ doc: d.path }));
    tasks.push({
      id: `style-terms-${authors.indexOf(author)}`, suite: 'emergence', type: 'style', lang,
      question: zh ? `与语料中的其他作者相比，${author}的作品里最有特色、最常用的词有哪些？请列出 10 个（人名除外）。` : `Compared with the other authors in the collection, which words are most characteristic of ${author}'s writing? List 10 (not character names).`,
      items: terms.slice(0, 50).map((t) => ({ label: t.term, aliases: [], weight: 1 })), scoring: 'set', evidence, primary: true, meta: { match: 'terms' },
    });
    const items: GoldItem[] = Object.entries(dirs).filter(([, d]) => d !== 'similar').map(([f, d]) => ({
      label: zh ? `${STYLE_FEATURES[f].zh}${d === 'higher' ? '高于' : '低于'}其他作者` : `${STYLE_FEATURES[f].en} ${d === 'higher' ? 'higher' : 'lower'} than the other authors`,
      aliases: [], weight: 1,
    }));
    if (items.length) tasks.push({
      id: `style-habits-${authors.indexOf(author)}`, suite: 'emergence', type: 'style', lang,
      question: zh ? `与语料中其他作者相比，${author}在写作上有哪些可以量化的习惯？（如句子长短、对话所占比例、感叹号和问号的使用、用词丰富度）` : `Compared with the other authors in the collection, what measurable habits does ${author}'s writing show (sentence length, share of dialogue, exclamation and question marks, vocabulary richness)?`,
      items, scoring: 'set', evidence,
    });
  }
  probes.forEach((p, i) => {
    writer.addHoldout(`passages/${i + 1}.txt`, p.text);
    tasks.push({
      id: `attrib-${i + 1}`, suite: 'emergence', type: 'attribution', lang,
      question: zh ? `下面这段文字最可能出自哪位作者？（这段文字不在资料里）\n\n${p.text}` : `Which author most likely wrote this passage? (It is not in the collection.)\n\n${p.text}`,
      choices: authors, answer: p.author, scoring: 'choice', evidence: docs.filter((d) => d.author === p.author).slice(0, 2).map((d) => ({ doc: d.path })),
    });
  });
  writer.addHoldout('rename.json', JSON.stringify(Object.fromEntries(works.map((w) => [w.title, w.rename])), null, 2));
  writer.setProfile({ style: profile });
  return finishDocpack({
    writer, docs, lang, tasks,
    plan: { single: 20, multi: 10, unanswerable: 5, global: 3 }, perDoc: 5,
  }, ctx);
}

export function registerLiteratureRecipes(): void {
  registerRecipe({ id: 'literature-zh', title: 'Four classic Chinese novels, opening chapters, names replaced (Gutenberg)', domain: 'literature', network: true, needsAuthor: true, build: (dir, ctx) => buildLiterature('zh', dir, ctx) });
  registerRecipe({ id: 'literature-en', title: 'Austen, Dickens, Twain: opening chapters, names replaced (Gutenberg)', domain: 'literature', network: true, needsAuthor: true, build: (dir, ctx) => buildLiterature('en', dir, ctx) });
}
