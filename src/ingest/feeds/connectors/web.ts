import { htmlToMarkdown } from '../../converters/html.js';
import { canonicalUrl } from '../ledger.js';
import type { ConnectorContext, FeedConnector, FeedItem, PullResult } from '../types.js';

/**
 * Pages watched for changes: a pricing page, a policy, a project's roadmap,
 * a disclosure list. Each page is one item whose id is its URL; when its main
 * text changes, the item gets a new revision and its document is rewritten
 * (the earlier versions stay in the feed's ledger). The main text is picked
 * out the way the HTML converter does for a saved page, so navigation and
 * footers changing do not count as the page changing.
 */

interface WebState {
  http?: Record<string, { etag?: string; lastModified?: string }>;
}

function pageUrls(params: Record<string, unknown>): string[] {
  const list = [params.url, ...(Array.isArray(params.urls) ? params.urls : [])].map((u) => (typeof u === 'string' ? u.trim() : '')).filter(Boolean);
  return [...new Set(list)];
}

async function pullWeb(ctx: ConnectorContext): Promise<PullResult> {
  const urls = pageUrls(ctx.feed.params);
  if (!urls.length) throw new Error('params.url is required');
  const prev = (ctx.state ?? {}) as WebState;
  const next: WebState = { http: { ...(prev.http ?? {}) } };
  const items: FeedItem[] = [];
  const notes: string[] = [];
  for (const url of urls) {
    const v = prev.http?.[url] ?? {};
    const headers: Record<string, string> = {};
    if (v.etag) headers['if-none-match'] = v.etag;
    if (v.lastModified) headers['if-modified-since'] = v.lastModified;
    const res = await ctx.fetch(url, { headers, accept: 'text/html,application/xhtml+xml,text/plain;q=0.8', allowErrorStatus: true });
    if (res.status === 304) {
      notes.push(`${url}: not modified`);
      continue;
    }
    if (res.status >= 400) {
      notes.push(`${url}: answered ${res.status}`);
      continue;
    }
    next.http![url] = { ...(res.headers.etag ? { etag: res.headers.etag } : {}), ...(res.headers['last-modified'] ? { lastModified: res.headers['last-modified'] } : {}) };
    const html = /html|xml/.test(res.contentType) || /^\s*</.test(res.text);
    const conv = html ? htmlToMarkdown(res.text, { baseUrl: res.url }) : null;
    const text = conv ? conv.markdown : res.text;
    items.push({
      id: canonicalUrl(url),
      url,
      title: conv?.meta.title ?? url,
      // a page without a date of its own is dated when first seen (the pipeline keeps that date across pulls),
      // so an unchanged page hashes the same every time
      publishedAt: conv?.meta.published ?? '',
      ...(conv?.meta.modified ? { updatedAt: conv.meta.modified } : {}),
      text,
      channel: { id: new URL(url).host, name: new URL(url).host, kind: 'site' },
      dedupeKey: canonicalUrl(url),
    });
  }
  return { items, state: next, notes };
}

export const webConnector: FeedConnector = {
  id: 'web',
  label: 'Web pages (watch for changes)',
  note: 'Fetches pages and keeps their main text; a page whose text changed gets a new revision and its document is rewritten.',
  platform: 'web',
  params: [
    { name: 'url', label: 'Page URL', type: 'string', required: true },
    { name: 'urls', label: 'More pages', type: 'string[]' },
  ],
  defaults: { units: { by: 'item' }, render: { period: 'item' }, schedule: { every: '1d' }, backfillDays: 3650 },
  minIntervalMinutes: 30,
  pull: pullWeb,
};
