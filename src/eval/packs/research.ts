import { seededKey } from '../pack.js';
import type { GoldItem } from '../types.js';
import { finishDocpack } from './docpack.js';
import { fetchText, htmlToText } from './fetch.js';
import { registerRecipe, RecipeContext } from './index.js';
import { PackWriter } from './writer.js';

/**
 * Research papers on AI agents and LLMs (docs/design/23 §2), from arXiv:
 * papers submitted in the second half of 2025 — abstract, introduction and
 * conclusion or limitations, from arXiv's HTML rendering — as the corpus,
 * and papers from spring 2026 as the holdout.
 *
 * Besides QA, the pack asks the two emergence questions a research knowledge
 * base should answer: which unresolved problems recur across these papers
 * (gold: the limitation statements the papers themselves make, grouped by the
 * author model, each group backed by at least two papers) and which themes the
 * field turns to next (gold: the themes of the 2026 holdout, which no system
 * sees — a forecast, with the closed-book reference as its control).
 */

interface Paper {
  id: string;
  title: string;
  summary: string;
  published: string;
  authors: string[];
}

const QUERY = '(cat:cs.CL OR cat:cs.AI OR cat:cs.MA) AND (abs:agent OR abs:agents OR abs:"large language model")';

export function parseAtom(xml: string): Paper[] {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
    const e = m[1];
    const tag = (t: string) => (e.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`))?.[1] ?? '').replace(/\s+/g, ' ').trim();
    return {
      id: tag('id').replace(/^https?:\/\/arxiv\.org\/abs\//, ''),
      title: tag('title'),
      summary: tag('summary'),
      published: tag('published').slice(0, 10),
      authors: [...e.matchAll(/<name>([^<]+)<\/name>/g)].map((a) => a[1].trim()),
    };
  });
}

async function search(from: string, to: string, max: number, ctx: RecipeContext, writer: PackWriter): Promise<Paper[]> {
  const out: Paper[] = [];
  for (let start = 0; start < max; start += 100) {
    const q = `${QUERY} AND submittedDate:[${from} TO ${to}]`;
    const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(q)}&start=${start}&max_results=100&sortBy=submittedDate&sortOrder=descending`;
    const { text, record } = await fetchText(url, { license: 'arXiv metadata: CC0 1.0', name: `arxiv-${from}-${to}-${start}.xml` });
    if (start === 0) writer.addSource({ ...record, url: 'https://export.arxiv.org/api/query', note: `${QUERY} submitted ${from}–${to}` });
    const page = parseAtom(text);
    out.push(...page);
    if (page.length < 100) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return out;
}

/** Introduction and conclusion / limitations / discussion sections from arXiv's LaTeXML HTML. */
function keySections(html: string): string {
  const sections = [...html.matchAll(/<section[^>]*class="ltx_section"[^>]*>([\s\S]*?)<\/section>/g)].map((m) => m[1]);
  const keep = sections.filter((s) => /<h2[^>]*>[\s\S]*?(Introduction|Conclusion|Limitation|Discussion|Future Work)/i.test(s));
  return keep.map((s) => htmlToText(s)).join('\n\n').slice(0, 9000);
}

async function buildResearch(dir: string, ctx: RecipeContext) {
  const n = ctx.limit ?? 100;
  const writer = new PackWriter(dir, {
    id: 'research-ai',
    version: 1,
    title: 'Research on AI agents and LLMs (arXiv, 2025-H2)',
    domain: 'research',
    languages: ['en'],
    description: 'arXiv papers on agents and large language models submitted July–December 2025 (abstract, introduction, conclusion/limitations); 2026 papers held out for the theme forecast.',
    builder: { recipe: 'research-ai', options: { papers: n } },
    holdout: 'holdout/papers-2026.json: abstracts of March–June 2026 papers, the gold for emerging themes.',
  });
  const pool = await search('202507010000', '202512312359', Math.max(300, n * 3), ctx, writer);
  const papers = [...pool].sort((a, b) => seededKey(ctx.seed ?? 0, a.id).localeCompare(seededKey(ctx.seed ?? 0, b.id))).slice(0, n);
  const docs: { path: string; title: string; date: string; author: string; lang: string; source: string; kind: string; text: string }[] = [];
  for (const [i, p] of papers.entries()) {
    let body = '';
    try {
      const { text } = await fetchText(`https://arxiv.org/html/${p.id}`, { license: 'arXiv non-exclusive distribution license (per paper)', name: `html-${p.id}.html`, maxBytes: 20 * 1024 * 1024 });
      body = keySections(text);
    } catch {
      /* no HTML rendering for this paper: the abstract stands alone */
    }
    if ((i + 1) % 20 === 0) ctx.log(`papers: ${i + 1}/${papers.length}`);
    await new Promise((r) => setTimeout(r, 1000));
    docs.push({
      path: `papers/${p.id.replace(/v\d+$/, '')}.md`, title: p.title, date: p.published, author: p.authors.slice(0, 3).join(', '), lang: 'en', source: `arxiv:${p.id}`, kind: 'paper',
      text: `# ${p.title}\n\n${p.authors.join(', ')} · ${p.published} · arXiv:${p.id}\n\n## Abstract\n\n${p.summary}\n\n${body}`,
    });
  }
  writer.addSource({ url: 'https://arxiv.org/html/', license: 'arXiv non-exclusive distribution license (per paper)', note: `${docs.length} papers, HTML sections` });

  const holdout = await search('202603010000', '202606302359', 200, ctx, writer);
  writer.addHoldout('papers-2026.json', JSON.stringify(holdout.map((p) => ({ id: p.id, title: p.title, date: p.published, abstract: p.summary })), null, 1));

  const tasks: Parameters<PackWriter['addTask']>[0][] = [];
  if (ctx.author) {
    // recurring unresolved problems, from what the papers say about their own limits
    const limits: { paper: string; problem: string }[] = [];
    for (let i = 0; i < docs.length; i += 8) {
      const group = docs.slice(i, i + 8);
      const r = await ctx.author.completeJson<{ limits?: { paper?: string; problem?: string }[] }>([
        { role: 'system', content: 'For each paper, list the unresolved problems, limitations and future work its authors state (1–3 per paper, one short sentence each, generalised slightly so similar problems in different papers can be grouped). Answer with JSON: {"limits":[{"paper":"<path>","problem":"…"}]}' },
        { role: 'user', content: group.map((d) => `<paper path="${d.path}">\n${d.text.slice(0, 6000)}\n</paper>`).join('\n\n') },
      ], { maxTokens: 3000 });
      for (const l of r.limits ?? []) if (l.paper && l.problem && group.some((d) => d.path === l.paper)) limits.push({ paper: l.paper, problem: l.problem });
    }
    const clustered = await ctx.author.completeJson<{ problems?: { label?: string; aliases?: string[]; papers?: string[] }[] }>([
      { role: 'system', content: 'Group these limitation statements from different papers into the recurring unresolved problems of the field. Keep only problems stated by at least two different papers; give each a short label, two alternative phrasings, and the papers behind it. At most 10, most widely shared first. Answer with JSON: {"problems":[{"label":"…","aliases":["…"],"papers":["<path>"]}]}' },
      { role: 'user', content: JSON.stringify(limits) },
    ], { maxTokens: 3000 });
    const problems = (clustered.problems ?? []).filter((p) => p.label && new Set(p.papers ?? []).size >= 2);
    const problemItems: GoldItem[] = problems.map((p) => ({ label: p.label!, aliases: (p.aliases ?? []).slice(0, 3), signal: 'implicit', weight: 1 }));
    if (problemItems.length) {
      tasks.push({
        id: 'emerge-open-problems', suite: 'emergence', type: 'themes', lang: 'en',
        question: 'Across these papers, which unresolved problems or limitations come up again and again? List the recurring ones, each backed by the papers that raise it.',
        items: problemItems, scoring: 'set', primary: true, meta: { minEvidence: 2 },
        evidence: [...new Set(problems.flatMap((p) => p.papers ?? []))].slice(0, 20).map((doc) => ({ doc })),
      });
    }
    // themes of the next half-year, from the holdout no system sees
    const themes = await ctx.author.completeJson<{ themes?: { label?: string; aliases?: string[]; count?: number }[] }>([
      { role: 'system', content: 'These are abstracts of papers on AI agents and LLMs from March–June 2026. Name the 10 research themes most prominent among them (specific themes, not "LLMs" or "agents" in general), each with two alternative phrasings and how many abstracts it covers. Answer with JSON: {"themes":[{"label":"…","aliases":["…"],"count":<n>}]}' },
      { role: 'user', content: JSON.stringify(holdout.slice(0, 160).map((p) => ({ title: p.title, abstract: p.summary.slice(0, 900) }))) },
    ], { maxTokens: 3000 });
    const themeItems: GoldItem[] = (themes.themes ?? []).filter((t) => t.label).map((t) => ({ label: t.label!, aliases: (t.aliases ?? []).slice(0, 3), signal: 'latent', weight: 1 }));
    if (themeItems.length) {
      tasks.push({
        id: 'emerge-next-themes', suite: 'emergence', type: 'forecast', lang: 'en',
        question: 'Judging from these papers (second half of 2025), which research themes in AI agents and LLMs are likely to be most prominent in the following half-year? Name specific themes, each grounded in the papers that point to it.',
        items: themeItems, scoring: 'set', meta: { minEvidence: 1 },
      });
    }
    writer.setProfile({ limits, problems, themes: themes.themes ?? [] });
  }
  return finishDocpack({ writer, docs, lang: 'en', tasks, plan: { single: 20, multi: 10, unanswerable: 5, global: 3 }, perDoc: 5 }, ctx);
}

export function registerResearchRecipes(): void {
  registerRecipe({ id: 'research-ai', title: 'arXiv papers on AI agents and LLMs, 2025-H2, with a 2026 holdout', domain: 'research', network: true, needsAuthor: true, build: buildResearch });
}
