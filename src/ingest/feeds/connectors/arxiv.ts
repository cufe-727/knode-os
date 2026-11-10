import type { ConnectorContext, FeedConnector, FeedItem, PullResult } from '../types.js';
import { child, children, parseXml, textOf } from '../xml.js';

/**
 * New papers on arXiv, through its query API (export.arxiv.org/api/query,
 * Atom). A feed names a search — categories, words in the title or
 * abstract, authors — in arXiv's own query syntax, or just categories:
 *
 *   params: { categories: [cs.CL, cs.IR], query: 'abs:"retrieval augmented"' }
 *     → search_query = (cat:cs.CL OR cat:cs.IR) AND abs:"retrieval augmented"
 *
 * Results come newest first by submission date; a pull pages back until it
 * reaches papers older than the newest one it had seen (with a day's overlap,
 * because arXiv announces in batches), at one request per three seconds as
 * arXiv asks. A paper is one item under its arXiv id without the version, so
 * a v2 replaces v1 in its document. With `attachments.download`, the PDF is
 * fetched and the Convert stage reads the full text.
 */

const API = 'https://export.arxiv.org/api/query';
const PAGE = 100;
const POLITE_MS = 3100;

interface ArxivState {
  /** The newest submission date seen. */
  newest?: string;
}

export function arxivQuery(params: Record<string, unknown>): string {
  const cats = (Array.isArray(params.categories) ? params.categories : typeof params.categories === 'string' ? params.categories.split(/[\s,]+/) : [])
    .map((c) => String(c).trim())
    .filter(Boolean);
  const query = typeof params.query === 'string' ? params.query.trim() : '';
  const catPart = cats.length ? (cats.length === 1 ? `cat:${cats[0]}` : `(${cats.map((c) => `cat:${c}`).join(' OR ')})`) : '';
  return [catPart, query && cats.length ? `(${query})` : query].filter(Boolean).join(' AND ');
}

/** "http://arxiv.org/abs/2411.01234v2" → ["2411.01234", 2]. */
export function arxivId(url: string): { id: string; version: number } {
  const m = /arxiv\.org\/abs\/(.+?)(?:v(\d+))?$/.exec(url.trim());
  return m ? { id: m[1], version: Number(m[2] ?? 1) } : { id: url.trim(), version: 1 };
}

export function parseArxiv(xml: string): { items: FeedItem[]; total: number } {
  const feed = parseXml(xml).children[0];
  if (!feed) throw new Error('arXiv answered an empty document');
  const total = Number(textOf(child(feed, 'opensearch:totalResults'))) || 0;
  const items: FeedItem[] = [];
  for (const entry of children(feed, 'entry')) {
    const idUrl = textOf(child(entry, 'id'));
    // an error is reported as an entry titled "Error"
    if (!/arxiv\.org\/abs\//.test(idUrl)) {
      const summary = textOf(child(entry, 'summary'));
      if (/error/i.test(textOf(child(entry, 'title')))) throw new Error(`arXiv: ${summary || 'query error'}`);
      continue;
    }
    const { id, version } = arxivId(idUrl);
    const authors = children(entry, 'author').map((a) => textOf(child(a, 'name'))).filter(Boolean);
    const categories = children(entry, 'category').map((c) => c.attrs.term).filter(Boolean);
    const primary = child(entry, 'arxiv:primary_category')?.attrs.term ?? categories[0];
    const pdf = children(entry, 'link').find((l) => l.attrs.title === 'pdf' || l.attrs.type === 'application/pdf')?.attrs.href;
    const comment = textOf(child(entry, 'arxiv:comment'));
    const journal = textOf(child(entry, 'arxiv:journal_ref'));
    const doi = textOf(child(entry, 'arxiv:doi'));
    const abstract = textOf(child(entry, 'summary')).replace(/\s*\n\s*/g, ' ').trim();
    const facts = [
      `**Authors:** ${authors.join(', ')}`,
      `**Categories:** ${categories.join(', ')}`,
      ...(comment ? [`**Comment:** ${comment}`] : []),
      ...(journal ? [`**Journal:** ${journal}`] : []),
      ...(doi ? [`**DOI:** ${doi}`] : []),
    ];
    const lines = [...facts.map((f) => `${f}  `), '', abstract];
    items.push({
      id,
      url: `https://arxiv.org/abs/${id}`,
      title: textOf(child(entry, 'title')).replace(/\s*\n\s*/g, ' '),
      author: { name: authors.length > 1 ? `${authors[0]} et al.` : authors[0] ?? 'unknown' },
      channel: { id: primary ?? 'arxiv', name: primary ?? 'arXiv', kind: 'category' },
      publishedAt: textOf(child(entry, 'published')),
      updatedAt: textOf(child(entry, 'updated')),
      text: lines.join('\n'),
      format: 'markdown',
      tags: categories,
      dedupeKey: `arxiv:${id}`,
      ...(pdf ? { attachments: [{ kind: 'file' as const, url: pdf.replace(/^http:/, 'https:'), mime: 'application/pdf', name: `${id}.pdf` }] } : {}),
      meta: { arxivId: id, version, authors, categories, primary, ...(doi ? { doi } : {}), ...(journal ? { journal } : {}) },
    });
  }
  return { items, total };
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('cancelled'));
    }, { once: true });
  });

async function pullArxiv(ctx: ConnectorContext): Promise<PullResult> {
  const query = arxivQuery(ctx.feed.params);
  if (!query) throw new Error('name params.categories or params.query (arXiv query syntax, e.g. abs:"knowledge graph")');
  const state = (ctx.state ?? {}) as ArxivState;
  const stopAt = state.newest ? Date.parse(state.newest) - 86_400_000 : ctx.since ? ctx.since.getTime() : Date.now() - 7 * 86_400_000;
  const maxPages = Math.max(1, Number(ctx.feed.params.maxPages ?? 5) || 5);
  const items: FeedItem[] = [];
  let newest = state.newest;
  let more = false;
  for (let page = 0; page < maxPages; page++) {
    if (page > 0) await sleep(POLITE_MS, ctx.signal);
    const url = `${API}?search_query=${encodeURIComponent(query)}&sortBy=submittedDate&sortOrder=descending&start=${page * PAGE}&max_results=${PAGE}`;
    const res = await ctx.fetch(url, { accept: 'application/atom+xml', timeoutMs: 90_000 });
    const { items: got } = parseArxiv(res.text);
    let reachedOld = got.length < PAGE;
    for (const item of got) {
      const t = Date.parse(item.publishedAt);
      if (t < stopAt) {
        reachedOld = true;
        continue;
      }
      items.push(item);
      if (!newest || t > Date.parse(newest)) newest = item.publishedAt;
    }
    if (reachedOld) break;
    if (page === maxPages - 1) more = true;
  }
  return { items, state: { newest } satisfies ArxivState, more, notes: [`${items.length} paper(s) for ${query}`] };
}

export const arxivConnector: FeedConnector = {
  id: 'arxiv',
  label: 'arXiv papers',
  note: 'New papers matching a search in arXiv\'s query syntax (categories, abs:, ti:, au:), newest first, at arXiv\'s requested pace. With attachments.download the PDF is read too.',
  platform: 'arxiv',
  params: [
    { name: 'categories', label: 'Categories', type: 'string[]', example: ['cs.CL', 'cs.IR'] },
    { name: 'query', label: 'Query (arXiv syntax)', type: 'string', example: 'abs:"retrieval augmented generation" AND NOT ti:survey' },
    { name: 'maxPages', label: 'Pages of 100 per pull (default 5)', type: 'number' },
  ],
  defaults: { units: { by: 'item' }, render: { period: 'item' }, schedule: { at: ['08:30'] }, backfillDays: 7 },
  minIntervalMinutes: 60,
  async check(ctx) {
    const query = arxivQuery(ctx.feed.params);
    if (!query) return { ok: false, message: 'name params.categories or params.query' };
    const res = await ctx.fetch(`${API}?search_query=${encodeURIComponent(query)}&max_results=1`, { accept: 'application/atom+xml' });
    const { total } = parseArxiv(res.text);
    return { ok: true, message: `${total} paper(s) match ${query}` };
  },
  pull: pullArxiv,
};
