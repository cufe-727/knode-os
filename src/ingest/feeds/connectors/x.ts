import type { ConnectorContext, FeedAttachment, FeedConnector, FeedItem, PullResult } from '../types.js';

/**
 * Posts of X (Twitter) accounts through the official API v2
 * (GET /2/users/:id/tweets), with a bearer token from the developer console
 * (params.token, default env:X_BEARER_TOKEN). The API is paid by use; each
 * pull asks only for posts newer than the newest one seen per account
 * (`since_id`), so an idle account costs one request.
 *
 * Without an API plan the same accounts can be followed two other ways,
 * documented in docs/design/26 §2: an `rss` feed on a self-hosted RSSHub's
 * /twitter/user/<name> route, or an `opencli` feed (`twitter tweets`) on the
 * logged-in browser session.
 *
 * Long posts come whole (note_tweet), t.co links are expanded, a self-thread
 * shares its conversation id (units.by: thread joins it into one unit), and a
 * quote or a repost names what it relays as the item's origin.
 */

const API = 'https://api.x.com/2';

interface XState {
  ids?: Record<string, string>;
  sinceId?: Record<string, string>;
}

function names(params: Record<string, unknown>): string[] {
  const raw = [params.username, ...(Array.isArray(params.usernames) ? params.usernames : typeof params.usernames === 'string' ? params.usernames.split(/[\s,]+/) : [])];
  return [...new Set(raw.map((u) => (typeof u === 'string' ? u.trim().replace(/^@/, '') : '')).filter(Boolean))];
}

async function api<T>(ctx: ConnectorContext, token: string, path: string): Promise<T> {
  const res = await ctx.fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` }, accept: 'application/json', allowErrorStatus: true });
  if (res.status === 429) {
    const reset = Number(res.headers['x-rate-limit-reset']);
    throw new Error(`X rate limit${Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toISOString()}` : ''}`);
  }
  if (res.status === 401 || res.status === 403) throw new Error(`X refused the token (${res.status}): ${res.text.slice(0, 200)}`);
  if (res.status >= 400) throw new Error(`X answered ${res.status} for ${path.split('?')[0]}: ${res.text.slice(0, 200)}`);
  return JSON.parse(res.text) as T;
}

interface Tweet {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  conversation_id?: string;
  in_reply_to_user_id?: string;
  note_tweet?: { text?: string };
  entities?: { urls?: Array<{ url: string; expanded_url?: string; display_url?: string }> };
  referenced_tweets?: Array<{ type: 'retweeted' | 'quoted' | 'replied_to'; id: string }>;
  attachments?: { media_keys?: string[] };
  public_metrics?: Record<string, number>;
  lang?: string;
}

interface Includes {
  media?: Array<{ media_key: string; type: string; url?: string; preview_image_url?: string; alt_text?: string }>;
  tweets?: Tweet[];
  users?: Array<{ id: string; username: string; name: string }>;
}

function expand(t: Tweet): string {
  let text = t.note_tweet?.text ?? t.text;
  for (const u of t.entities?.urls ?? []) if (u.expanded_url) text = text.split(u.url).join(u.expanded_url);
  return text;
}

export function tweetItem(t: Tweet, user: { username: string; name: string }, includes: Includes): FeedItem {
  const media = new Map((includes.media ?? []).map((m) => [m.media_key, m]));
  const users = new Map((includes.users ?? []).map((u) => [u.id, u]));
  const attachments: FeedAttachment[] = (t.attachments?.media_keys ?? []).flatMap((k) => {
    const m = media.get(k);
    const url = m?.url ?? m?.preview_image_url;
    return url ? [{ kind: m!.type === 'photo' ? ('image' as const) : ('video' as const), url, ...(m!.alt_text ? { text: m!.alt_text } : {}) }] : [];
  });
  const ref = t.referenced_tweets?.find((r) => r.type === 'retweeted' || r.type === 'quoted');
  const referenced = ref ? (includes.tweets ?? []).find((x) => x.id === ref.id) : undefined;
  const refUser = referenced?.author_id ? users.get(referenced.author_id) : undefined;
  let text = expand(t);
  if (ref?.type === 'retweeted' && referenced) text = expand(referenced);
  else if (ref?.type === 'quoted' && referenced) text = `${text}\n\n> ${refUser ? `@${refUser.username}: ` : ''}${expand(referenced).replace(/\n/g, '\n> ')}`;
  return {
    id: t.id,
    url: `https://x.com/${user.username}/status/${t.id}`,
    author: { name: user.name, id: user.username, url: `https://x.com/${user.username}` },
    channel: { id: user.username, name: `@${user.username}`, kind: 'account' },
    publishedAt: t.created_at ?? '',
    text,
    format: 'text',
    ...(t.conversation_id && t.conversation_id !== t.id ? { threadId: t.conversation_id } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(t.lang ? { lang: t.lang } : {}),
    ...(ref && refUser ? { origin: { platform: 'x', account: refUser.username, id: ref.id, url: `https://x.com/${refUser.username}/status/${ref.id}` } } : {}),
    dedupeKey: `x:${ref?.type === 'retweeted' ? ref.id : t.id}`,
    meta: { metrics: t.public_metrics ?? {}, ...(ref ? { reference: ref.type } : {}), ...(t.in_reply_to_user_id ? { reply: true } : {}) },
  };
}

async function pullX(ctx: ConnectorContext): Promise<PullResult> {
  const token = ctx.secret(ctx.feed.params.token ?? 'env:X_BEARER_TOKEN');
  if (!token) throw new Error('an X API bearer token is required: params.token, or X_BEARER_TOKEN in the service environment');
  const accounts = names(ctx.feed.params);
  if (!accounts.length) throw new Error('params.username (or usernames) is required');
  const prev = (ctx.state ?? {}) as XState;
  const next: XState = { ids: { ...(prev.ids ?? {}) }, sinceId: { ...(prev.sinceId ?? {}) } };
  const missing = accounts.filter((a) => !next.ids![a]);
  if (missing.length) {
    const found = await api<{ data?: Array<{ id: string; username: string }> }>(ctx, token, `/users/by?usernames=${missing.map(encodeURIComponent).join(',')}`);
    for (const a of missing) {
      const hit = (found.data ?? []).find((u) => u.username.toLowerCase() === a.toLowerCase());
      if (hit) next.ids![a] = hit.id;
    }
  }
  const exclude = [ctx.feed.params.replies === true ? '' : 'replies', ctx.feed.params.reposts === true ? '' : 'retweets'].filter(Boolean).join(',');
  const items: FeedItem[] = [];
  const notes: string[] = [];
  for (const account of accounts) {
    const id = next.ids![account];
    if (!id) {
      notes.push(`@${account}: no such account`);
      continue;
    }
    const since = next.sinceId![account];
    const q = new URLSearchParams({
      max_results: '100',
      'tweet.fields': 'created_at,conversation_id,referenced_tweets,entities,attachments,public_metrics,note_tweet,lang,in_reply_to_user_id,author_id',
      expansions: 'attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id',
      'media.fields': 'url,preview_image_url,type,alt_text',
      'user.fields': 'username,name',
      ...(exclude ? { exclude } : {}),
      ...(since ? { since_id: since } : { start_time: (ctx.since ?? new Date(Date.now() - 3 * 86_400_000)).toISOString() }),
    });
    const page = await api<{ data?: Tweet[]; includes?: Includes; meta?: { newest_id?: string } }>(ctx, token, `/users/${id}/tweets?${q}`);
    const user = { username: account, name: (page.includes?.users ?? []).find((u) => u.id === id)?.name ?? account };
    for (const t of page.data ?? []) items.push(tweetItem(t, user, page.includes ?? {}));
    if (page.meta?.newest_id) next.sinceId![account] = page.meta.newest_id;
    notes.push(`@${account}: ${(page.data ?? []).length} post(s)`);
  }
  return { items, state: next, notes };
}

export const xConnector: FeedConnector = {
  id: 'x',
  label: 'X (Twitter) accounts — API v2',
  note: 'Posts of accounts through the paid X API v2 with a bearer token (default env:X_BEARER_TOKEN). Without a plan, follow the same accounts through RSSHub (rss) or OpenCLI on your browser session (opencli).',
  platform: 'twitter',
  params: [
    { name: 'username', label: 'Account (without @)', type: 'string', required: true, example: 'karpathy' },
    { name: 'usernames', label: 'More accounts', type: 'string[]' },
    { name: 'replies', label: 'Include replies (default no)', type: 'boolean' },
    { name: 'reposts', label: 'Include reposts (default no)', type: 'boolean' },
    { name: 'token', label: 'Bearer token (default env:X_BEARER_TOKEN)', type: 'secret' },
  ],
  defaults: { units: { by: 'thread' }, render: { period: 'week', by: 'author' }, schedule: { every: '2h' }, backfillDays: 3 },
  minIntervalMinutes: 15,
  pull: pullX,
};
