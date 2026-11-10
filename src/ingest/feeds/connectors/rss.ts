import { canonicalUrl } from '../ledger.js';
import type { ConnectorContext, FeedAttachment, FeedConnector, FeedItem, PullResult } from '../types.js';
import { child, children, innerXml, parseXml, textOf, XmlElement } from '../xml.js';

/**
 * RSS 2.0, RSS 1.0 (RDF), Atom and JSON Feed — and through them everything
 * that publishes one: blogs, newsletters, podcasts, YouTube channels, GitHub's
 * releases.atom and commits.atom, arXiv's daily listings, and the sites a
 * self-hosted RSSHub (https://docs.rsshub.app) turns into feeds: X/Twitter
 * accounts, Weibo, Zhihu, Bilibili, WeChat official accounts (with wewe-rss),
 * Telegram channels, Xiaohongshu…
 *
 * The cursor is the server's ETag / Last-Modified per feed URL, so an
 * unchanged feed costs one conditional request; items already in the ledger
 * with the same content are not processed again.
 */

interface RssState {
  /** Per feed URL: validators for a conditional GET. */
  http?: Record<string, { etag?: string; lastModified?: string }>;
}

export function feedUrls(params: Record<string, unknown>): string[] {
  const list = [params.url, ...(Array.isArray(params.urls) ? params.urls : [])].map((u) => (typeof u === 'string' ? u.trim() : '')).filter(Boolean);
  return [...new Set(list)];
}

function dateOf(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    if (!v) continue;
    const t = Date.parse(v.trim());
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return undefined;
}

function kindOf(type: string | undefined, url: string): FeedAttachment['kind'] {
  const t = (type ?? '').toLowerCase();
  if (t.startsWith('image/') || /\.(jpe?g|png|gif|webp)(\?|$)/i.test(url)) return 'image';
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('video/')) return 'video';
  return 'file';
}

/** "someone@example.com (Some One)" → "Some One". */
function rssAuthor(value: string): string {
  const m = /^\s*\S+@\S+\s*\((.+)\)\s*$/.exec(value);
  return (m ? m[1] : value).trim();
}

function attachmentsOf(entry: XmlElement): FeedAttachment[] {
  const out: FeedAttachment[] = [];
  const seen = new Set<string>();
  const add = (url: string | undefined, type: string | undefined, name?: string) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ kind: kindOf(type, url), url, ...(type ? { mime: type } : {}), ...(name ? { name } : {}) });
  };
  for (const e of children(entry, 'enclosure')) add(e.attrs.url, e.attrs.type);
  for (const e of children(entry, 'media:content')) add(e.attrs.url, e.attrs.type ?? (e.attrs.medium === 'image' ? 'image/*' : undefined));
  for (const l of children(entry, 'link')) if (l.attrs.rel === 'enclosure') add(l.attrs.href, l.attrs.type);
  if (!out.length) for (const t of children(entry, 'media:thumbnail')) add(t.attrs.url, 'image/*');
  return out;
}

function atomLink(entry: XmlElement): string | undefined {
  const links = children(entry, 'link');
  return (links.find((l) => !l.attrs.rel || l.attrs.rel === 'alternate') ?? links[0])?.attrs.href;
}

function atomContent(el: XmlElement | undefined): { html?: string; text?: string } {
  if (!el) return {};
  const type = (el.attrs.type ?? 'text').toLowerCase();
  if (type === 'xhtml') return { html: innerXml(el) };
  if (type === 'html' || type === 'text/html') return { html: textOf(el) };
  return { text: textOf(el) };
}

/** Items of an RSS, RDF or Atom document. */
export function parseFeedXml(xml: string, feedUrl: string): { title: string; items: FeedItem[] } {
  const root = parseXml(xml);
  const top = root.children[0];
  if (!top) throw new Error('not a feed: empty document');
  const channel: FeedItem['channel'] = { id: feedUrl, name: '', kind: 'feed' };
  const items: FeedItem[] = [];
  const name = top.name.toLowerCase();
  if (name === 'feed' || name.endsWith(':feed')) {
    channel.name = textOf(child(top, 'title')) || feedUrl;
    const feedAuthor = textOf(child(child(top, 'author'), 'name'));
    for (const entry of children(top, 'entry')) {
      const url = atomLink(entry);
      const content = atomContent(child(entry, 'content'));
      const summary = atomContent(child(entry, 'summary'));
      const author = textOf(child(child(entry, 'author'), 'name')) || feedAuthor;
      const id = textOf(child(entry, 'id')) || url || '';
      const published = dateOf(textOf(child(entry, 'published')), textOf(child(entry, 'updated')));
      const updated = dateOf(textOf(child(entry, 'updated')));
      items.push({
        id,
        ...(url ? { url, dedupeKey: canonicalUrl(url) } : {}),
        title: textOf(child(entry, 'title')),
        ...(author ? { author: { name: author } } : {}),
        channel,
        publishedAt: published ?? '',
        ...(updated && updated !== published ? { updatedAt: updated } : {}),
        ...(content.html || content.text ? content : summary),
        attachments: attachmentsOf(entry),
        tags: children(entry, 'category').map((c) => c.attrs.term ?? c.attrs.label ?? textOf(c)).filter(Boolean),
      });
    }
    return { title: channel.name, items };
  }
  // RSS 2.0: rss > channel > item; RSS 1.0: rdf:RDF > channel + item
  const ch = child(top, 'channel') ?? top;
  channel.name = textOf(child(ch, 'title')) || feedUrl;
  const entries = [...children(ch, 'item'), ...(ch === top ? [] : children(top, 'item'))];
  for (const entry of entries) {
    const link = textOf(child(entry, 'link')) || child(entry, 'link')?.attrs.href || entry.attrs['rdf:about'];
    const guid = textOf(child(entry, 'guid'));
    const html = textOf(child(entry, 'content:encoded')) || textOf(child(entry, 'description'));
    const author = textOf(child(entry, 'dc:creator')) || rssAuthor(textOf(child(entry, 'author')));
    items.push({
      id: guid || link || '',
      ...(link ? { url: link, dedupeKey: canonicalUrl(link) } : {}),
      title: textOf(child(entry, 'title')),
      ...(author ? { author: { name: author } } : {}),
      channel,
      publishedAt: dateOf(textOf(child(entry, 'pubDate')), textOf(child(entry, 'dc:date')), textOf(child(entry, 'published'))) ?? '',
      ...(html ? { html } : {}),
      attachments: attachmentsOf(entry),
      tags: children(entry, 'category').map((c) => textOf(c)).filter(Boolean),
    });
  }
  return { title: channel.name, items };
}

/** Items of a JSON Feed (https://jsonfeed.org). */
export function parseJsonFeed(json: string, feedUrl: string): { title: string; items: FeedItem[] } {
  const doc = JSON.parse(json) as { title?: string; items?: Array<Record<string, unknown>>; authors?: Array<{ name?: string }>; author?: { name?: string } };
  const channel = { id: feedUrl, name: doc.title || feedUrl, kind: 'feed' };
  const feedAuthor = doc.authors?.[0]?.name ?? doc.author?.name;
  const items = (doc.items ?? []).map((it): FeedItem => {
    const url = typeof it.url === 'string' ? it.url : undefined;
    const authors = (it.authors as Array<{ name?: string }> | undefined) ?? (it.author ? [it.author as { name?: string }] : []);
    const author = authors[0]?.name ?? feedAuthor;
    return {
      id: String(it.id ?? url ?? ''),
      ...(url ? { url, dedupeKey: canonicalUrl(url) } : {}),
      title: typeof it.title === 'string' ? it.title : '',
      ...(author ? { author: { name: author } } : {}),
      channel,
      publishedAt: dateOf(it.date_published as string, it.date_modified as string) ?? '',
      ...(typeof it.content_html === 'string' ? { html: it.content_html } : typeof it.content_text === 'string' ? { text: it.content_text } : typeof it.summary === 'string' ? { text: it.summary } : {}),
      attachments: ((it.attachments as Array<{ url?: string; mime_type?: string; title?: string }> | undefined) ?? [])
        .filter((a) => a.url)
        .map((a) => ({ kind: kindOf(a.mime_type, a.url!), url: a.url!, ...(a.mime_type ? { mime: a.mime_type } : {}), ...(a.title ? { name: a.title } : {}) })),
      tags: Array.isArray(it.tags) ? (it.tags as unknown[]).map(String) : [],
    };
  });
  return { title: channel.name, items };
}

export function parseAnyFeed(text: string, contentType: string, url: string): { title: string; items: FeedItem[] } {
  if (/json/.test(contentType) || /^\s*\{/.test(text)) return parseJsonFeed(text, url);
  return parseFeedXml(text, url);
}

async function pullRss(ctx: ConnectorContext): Promise<PullResult> {
  const urls = feedUrls(ctx.feed.params);
  if (!urls.length) throw new Error('params.url is required');
  const prev = (ctx.state ?? {}) as RssState;
  const next: RssState = { http: { ...(prev.http ?? {}) } };
  const max = Number(ctx.feed.params.maxItems ?? 200) || 200;
  const items: FeedItem[] = [];
  const notes: string[] = [];
  const headersParam = (ctx.feed.params.headers ?? {}) as Record<string, string>;
  for (const url of urls) {
    const validators = prev.http?.[url] ?? {};
    const headers: Record<string, string> = Object.fromEntries(Object.entries(headersParam).map(([k, v]) => [k, ctx.secret(v)]));
    if (validators.etag) headers['if-none-match'] = validators.etag;
    if (validators.lastModified) headers['if-modified-since'] = validators.lastModified;
    const res = await ctx.fetch(url, { headers, accept: 'application/atom+xml, application/rss+xml, application/feed+json, application/xml;q=0.9, */*;q=0.5', allowErrorStatus: true });
    if (res.status === 304) {
      notes.push(`${url}: not modified`);
      continue;
    }
    if (res.status >= 400) throw new Error(`${url} answered ${res.status}`);
    const parsed = parseAnyFeed(res.text, res.contentType, url);
    next.http![url] = { ...(res.headers.etag ? { etag: res.headers.etag } : {}), ...(res.headers['last-modified'] ? { lastModified: res.headers['last-modified'] } : {}) };
    // a feed lists newest first; keep the newest `max`
    const list = parsed.items.filter((i) => i.id).sort((a, b) => Date.parse(b.publishedAt || '0') - Date.parse(a.publishedAt || '0')).slice(0, max);
    items.push(...list);
    notes.push(`${parsed.title || url}: ${list.length} item(s)`);
  }
  return { items, state: next, notes };
}

export const rssConnector: FeedConnector = {
  id: 'rss',
  label: 'RSS / Atom / JSON Feed',
  note: 'Any RSS, Atom or JSON Feed URL — blogs, newsletters, podcasts, GitHub release feeds, arXiv listings, and every site a self-hosted RSSHub turns into a feed (X, Weibo, Zhihu, Bilibili, WeChat accounts via wewe-rss, Telegram channels).',
  platform: 'web',
  params: [
    { name: 'url', label: 'Feed URL', type: 'string', required: true, example: 'http://127.0.0.1:1200/twitter/user/elonmusk' },
    { name: 'urls', label: 'More feed URLs (one feed of several sources)', type: 'string[]' },
    { name: 'headers', label: 'Request headers ("env:VAR" allowed)', type: 'string' },
    { name: 'maxItems', label: 'Newest items taken per pull (default 200)', type: 'number' },
  ],
  defaults: { units: { by: 'item' }, render: { period: 'item' }, schedule: { every: '1h' }, backfillDays: 30 },
  minIntervalMinutes: 5,
  async check(ctx) {
    const [url] = feedUrls(ctx.feed.params);
    if (!url) return { ok: false, message: 'params.url is required' };
    const res = await ctx.fetch(url, { allowErrorStatus: true });
    if (res.status >= 400) return { ok: false, message: `${url} answered ${res.status}` };
    const parsed = parseAnyFeed(res.text, res.contentType, url);
    return { ok: true, message: `${parsed.title || url}: ${parsed.items.length} item(s)` };
  },
  pull: pullRss,
};
