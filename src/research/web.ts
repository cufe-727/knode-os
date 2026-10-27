import { resolveSecret, ResearchWebConfig, WebSearchProvider } from '../config.js';
import { guardedFetch } from './fetch.js';

/**
 * knode's own web search, behind `knode_web_search`: the search API a person
 * configured under `research.web.search`, called by the server so that every
 * agent — the built-in one, which has no web tool, and Cursor, whose web
 * access cannot be switched per session — can search the same way Claude Code
 * and Codex do with their own tools. With no provider configured the tool is
 * simply absent: knode never calls a search vendor nobody named.
 *
 * Four adapters, all JSON over HTTPS: SearXNG (self-hosted, no key), Brave
 * Search, Tavily and Serper (Google results). Each comes back as the same
 * `{ title, url, snippet, published }` rows.
 */

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  published: string | null;
  source: string;
}

export interface WebSearchOptions {
  max?: number;
  /** Restrict to these domains (`site:` terms or the provider's own filter). */
  domains?: string[];
  /** Freshness hint: results from the last day / week / month / year where the provider supports it. */
  recency?: 'day' | 'week' | 'month' | 'year';
}

export const WEB_SEARCH_PROVIDERS: Exclude<WebSearchProvider, ''>[] = ['searxng', 'brave', 'tavily', 'serper'];

export function webSearchEnabled(web: ResearchWebConfig | undefined): boolean {
  const s = web?.search;
  if (!s?.provider) return false;
  if (s.provider === 'searxng') return Boolean(s.baseUrl);
  return Boolean(resolveSecret(s.apiKey));
}

const DEFAULT_BASE: Record<Exclude<WebSearchProvider, '' | 'searxng'>, string> = {
  brave: 'https://api.search.brave.com/res/v1/web/search',
  tavily: 'https://api.tavily.com/search',
  serper: 'https://google.serper.dev/search',
};

function withSites(query: string, domains: string[] | undefined): string {
  const sites = (domains ?? []).map((d) => d.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean);
  if (sites.length === 0) return query;
  return `${query} ${sites.length === 1 ? `site:${sites[0]}` : `(${sites.map((s) => `site:${s}`).join(' OR ')})`}`;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function parseJson(body: Buffer, provider: string): Record<string, unknown> {
  try {
    return JSON.parse(body.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error(`${provider} answered something that is not JSON`);
  }
}

export async function webSearch(web: ResearchWebConfig, query: string, opts: WebSearchOptions = {}): Promise<WebSearchResult[]> {
  const cfg = web.search;
  if (!webSearchEnabled(web)) throw new Error('no web search provider is configured (research.web.search: searxng / brave / tavily / serper)');
  const max = Math.min(20, Math.max(1, Math.floor(opts.max ?? cfg.maxResults ?? 8)));
  const q = query.trim();
  if (!q) throw new Error('an empty query');
  const key = resolveSecret(cfg.apiKey);
  const provider = cfg.provider as Exclude<WebSearchProvider, ''>;
  const base = cfg.baseUrl?.trim() || (provider === 'searxng' ? '' : DEFAULT_BASE[provider]);
  // the provider is configuration a person wrote, so a local SearXNG is fine
  const call = (url: string, init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string } = {}) =>
    guardedFetch(url, web, { ...init, trusted: true, accept: 'application/json', maxBytes: 4 * 1024 * 1024, allowErrorStatus: true });
  const fail = (status: number, body: Buffer) => new Error(`${provider} search failed (${status}): ${body.toString('utf8').slice(0, 200)}`);

  if (provider === 'searxng') {
    const u = new URL(base.replace(/\/+$/, '') + '/search');
    u.searchParams.set('q', withSites(q, opts.domains));
    u.searchParams.set('format', 'json');
    if (opts.recency) u.searchParams.set('time_range', opts.recency);
    const res = await call(u.toString());
    if (res.status >= 400) throw fail(res.status, res.body);
    const data = parseJson(res.body, provider);
    return (Array.isArray(data.results) ? data.results : []).slice(0, max).map((r: Record<string, unknown>) => ({
      title: str(r.title), url: str(r.url), snippet: str(r.content), published: str(r.publishedDate) || null, source: provider,
    })).filter((r) => r.url);
  }
  if (provider === 'brave') {
    const u = new URL(base);
    u.searchParams.set('q', withSites(q, opts.domains));
    u.searchParams.set('count', String(max));
    if (opts.recency) u.searchParams.set('freshness', { day: 'pd', week: 'pw', month: 'pm', year: 'py' }[opts.recency]);
    const res = await call(u.toString(), { headers: { 'X-Subscription-Token': key } });
    if (res.status >= 400) throw fail(res.status, res.body);
    const web0 = (parseJson(res.body, provider).web ?? {}) as Record<string, unknown>;
    return (Array.isArray(web0.results) ? web0.results : []).slice(0, max).map((r: Record<string, unknown>) => ({
      title: str(r.title), url: str(r.url), snippet: str(r.description), published: str(r.page_age) || str(r.age) || null, source: provider,
    })).filter((r) => r.url);
  }
  if (provider === 'tavily') {
    const body = JSON.stringify({
      query: q, max_results: max, search_depth: 'advanced',
      ...(opts.domains?.length ? { include_domains: opts.domains } : {}),
      ...(opts.recency ? { time_range: opts.recency } : {}),
    });
    const res = await call(base, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body });
    if (res.status >= 400) throw fail(res.status, res.body);
    const data = parseJson(res.body, provider);
    return (Array.isArray(data.results) ? data.results : []).slice(0, max).map((r: Record<string, unknown>) => ({
      title: str(r.title), url: str(r.url), snippet: str(r.content), published: str(r.published_date) || null, source: provider,
    })).filter((r) => r.url);
  }
  // serper
  const body = JSON.stringify({ q: withSites(q, opts.domains), num: max, ...(opts.recency ? { tbs: { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y' }[opts.recency] } : {}) });
  const res = await call(base, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-KEY': key }, body });
  if (res.status >= 400) throw fail(res.status, res.body);
  const data = parseJson(res.body, provider);
  return (Array.isArray(data.organic) ? data.organic : []).slice(0, max).map((r: Record<string, unknown>) => ({
    title: str(r.title), url: str(r.link), snippet: str(r.snippet), published: str(r.date) || null, source: provider,
  })).filter((r) => r.url);
}
