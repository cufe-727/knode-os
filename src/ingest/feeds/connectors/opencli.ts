import { runCommand } from '../command.js';
import type { ConnectorContext, FeedAttachment, FeedConnector, FeedItem, PullResult } from '../types.js';

/**
 * OpenCLI (https://github.com/jackwener/opencli): site adapters that read a
 * website through the person's own logged-in Chrome — X/Twitter timelines and
 * lists, Weibo, Zhihu, Xueqiu, Jike, Bilibili, Xiaohongshu, Reddit, Hacker
 * News and some 160 more. One feed runs one read command:
 *
 *   params: { site: twitter, command: tweets, args: { username: karpathy, limit: 50 } }
 *     → opencli twitter tweets --username karpathy --limit 50 -f json
 *
 * Only commands OpenCLI itself marks `access: read` are run (asked once with
 * `<command> --help -f json`): a feed must never post, like, follow or delete
 * on someone's account. The rows come back as JSON; the common columns (id,
 * text/content, title, author, url, created_at/time, media_urls) map onto an
 * item, and `params.fields` maps any other column.
 */

const accessChecked = new Map<string, Promise<string>>();

function cliOf(params: Record<string, unknown>): string {
  return typeof params.cli === 'string' && params.cli.trim() ? params.cli.trim() : 'opencli';
}

export function opencliArgs(params: Record<string, unknown>): string[] {
  const site = String(params.site ?? '').trim();
  const command = String(params.command ?? '').trim();
  if (!/^[\w.-]+$/.test(site) || !/^[\w.-]+$/.test(command)) throw new Error('params.site and params.command are required (e.g. twitter / tweets)');
  const out = [site, command];
  const args = params.args;
  if (Array.isArray(args)) out.push(...args.map(String));
  else if (args && typeof args === 'object') {
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      if (v === undefined || v === null || v === false) continue;
      if (!/^[\w-]+$/.test(k)) throw new Error(`not an option name: ${k}`);
      out.push(`--${k}`);
      if (v !== true) out.push(String(v));
    }
  }
  return [...out, '-f', 'json'];
}

async function run(ctx: ConnectorContext, args: string[], timeoutMs: number): Promise<unknown> {
  const res = await runCommand({ command: cliOf(ctx.feed.params), args, timeoutMs }, null, { cwd: ctx.dataDir, signal: ctx.signal });
  const text = res.stdout.trim();
  let body: { ok?: boolean; data?: unknown; error?: { code?: string; message?: string; hint?: string } } | unknown[];
  try {
    body = JSON.parse(text.slice(Math.max(0, Math.min(...['{', '['].map((c) => (text.indexOf(c) < 0 ? Infinity : text.indexOf(c)))))));
  } catch {
    throw new Error(`opencli ${args.slice(0, 2).join(' ')} did not answer JSON (exit ${res.code}): ${(text || res.stderr).slice(0, 300)}`);
  }
  if (Array.isArray(body)) return body;
  if (body.ok === false || res.code !== 0) {
    const e = body.error ?? {};
    throw new Error(`opencli ${args.slice(0, 2).join(' ')}: ${e.message ?? `exit ${res.code}`}${e.hint ? ` — ${e.hint}` : ''}`);
  }
  return body.data ?? body;
}

/** The command's declared access, from its own help; anything but "read" is refused. */
async function assertReadOnly(ctx: ConnectorContext, site: string, command: string): Promise<void> {
  const key = `${cliOf(ctx.feed.params)}\0${site}\0${command}`;
  if (!accessChecked.has(key)) {
    accessChecked.set(key, (async () => {
      const help = (await run(ctx, [site, command, '--help', '-f', 'json'], 60_000)) as Record<string, unknown>;
      const access = String(help?.access ?? (help?.command as Record<string, unknown> | undefined)?.access ?? '');
      return access;
    })().catch((err) => {
      accessChecked.delete(key);
      throw err;
    }));
  }
  const access = await accessChecked.get(key)!;
  if (access !== 'read') throw new Error(`opencli ${site} ${command} is ${access ? `a "${access}" command` : 'not declared read-only'} — a feed only runs commands that read`);
}

const pick = (row: Record<string, unknown>, names: string[]): unknown => {
  for (const n of names) {
    const v = row[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

function dateOf(v: unknown): string {
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === 'string' && v.trim()) {
    if (/^\d{10,13}$/.test(v.trim())) return dateOf(Number(v.trim()));
    const t = Date.parse(v.trim());
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return '';
}

function mediaOf(v: unknown): FeedAttachment[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? v.split(/[\s,]+/) : [];
  return list.map(String).filter((u) => /^https?:\/\//.test(u)).map((url) => ({ kind: /\.(mp4|m3u8|mov)(\?|$)/i.test(url) ? ('video' as const) : ('image' as const), url }));
}

/** One row of a read command as an item; `fields` maps item fields onto other column names. */
export function rowItem(row: Record<string, unknown>, site: string, fields: Record<string, string> = {}): FeedItem | null {
  const col = (field: string, defaults: string[]) => pick(row, fields[field] ? [fields[field]] : defaults);
  const url = col('url', ['url', 'link', 'href']);
  const id = col('id', ['id', 'mblogid', 'bvid', 'note_id', 'question_id']) ?? url;
  if (id === undefined) return null;
  const authorValue = col('author', ['author', 'screen_name', 'username', 'user', 'name']);
  const author = typeof authorValue === 'object' && authorValue ? String((authorValue as Record<string, unknown>).name ?? (authorValue as Record<string, unknown>).screen_name ?? '') : authorValue ? String(authorValue) : '';
  const text = col('text', ['text', 'content', 'selftext', 'desc', 'excerpt', 'summary', 'body']);
  const title = col('title', ['title', 'question_title']);
  const quoted = row.quoted_tweet && typeof row.quoted_tweet === 'object' ? (row.quoted_tweet as Record<string, unknown>) : null;
  const meta: Record<string, unknown> = {};
  for (const k of ['likes', 'retweets', 'reposts', 'replies', 'comments', 'views', 'votes', 'upvotes', 'score', 'plays', 'is_retweet']) if (row[k] !== undefined) meta[k] = row[k];
  let body = text === undefined ? '' : String(text);
  if (quoted && (quoted.text || quoted.content)) body += `\n\n> ${quoted.author ? `${quoted.author}: ` : ''}${String(quoted.text ?? quoted.content).replace(/\n/g, '\n> ')}`;
  return {
    id: `${site}:${String(id)}`,
    ...(url ? { url: String(url) } : {}),
    ...(title ? { title: String(title) } : {}),
    ...(author ? { author: { name: author } } : {}),
    publishedAt: dateOf(col('publishedAt', ['created_at', 'time', 'date', 'created_utc', 'created_ts', 'publish_time', 'created', 'updated_at'])),
    text: body,
    format: 'text',
    attachments: mediaOf(col('media', ['media_urls', 'gallery_urls', 'images', 'pics', 'cover'])),
    dedupeKey: `${site}:${String(id)}`,
    meta,
  };
}

async function pullOpencli(ctx: ConnectorContext): Promise<PullResult> {
  const args = opencliArgs(ctx.feed.params);
  const [site, command] = args;
  await assertReadOnly(ctx, site, command);
  const timeoutMs = Number(ctx.feed.params.timeoutMs) > 0 ? Number(ctx.feed.params.timeoutMs) : 5 * 60_000;
  const data = await run(ctx, args, timeoutMs);
  const rows = Array.isArray(data) ? data : data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).items) ? ((data as Record<string, unknown>).items as unknown[]) : [];
  const fields = ctx.feed.params.fields && typeof ctx.feed.params.fields === 'object' ? (ctx.feed.params.fields as Record<string, string>) : {};
  const channelName = typeof ctx.feed.params.channel === 'string' && ctx.feed.params.channel.trim() ? ctx.feed.params.channel.trim() : `${site} ${command}`;
  const items = rows
    .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object')
    .map((r) => rowItem(r, site, fields))
    .filter((i): i is FeedItem => i !== null)
    .map((i) => ({ ...i, channel: { id: `${site}/${command}/${JSON.stringify(ctx.feed.params.args ?? {})}`, name: channelName, kind: 'list' } }));
  return { items, notes: [`opencli ${site} ${command}: ${items.length} row(s)`] };
}

export const opencliConnector: FeedConnector = {
  id: 'opencli',
  label: 'OpenCLI (sites read through your browser session)',
  note: 'Runs a read-only OpenCLI command — X timelines and lists, Weibo, Zhihu, Xueqiu, Jike, Bilibili, Xiaohongshu, Reddit, Hacker News… — on your logged-in Chrome. Commands OpenCLI does not mark read-only are refused.',
  platform: 'web',
  platformFor: (feed) => (typeof feed.params.site === 'string' && feed.params.site.trim() ? feed.params.site.trim() : 'web'),
  params: [
    { name: 'site', label: 'Site', type: 'string', required: true, example: 'twitter' },
    { name: 'command', label: 'Read command', type: 'string', required: true, example: 'tweets' },
    { name: 'args', label: 'Options, as { name: value }', type: 'string', example: { username: 'karpathy', limit: 50 } },
    { name: 'fields', label: 'Column for an item field when the defaults miss it: { text: "content" }', type: 'string' },
    { name: 'channel', label: 'Channel name in documents (default "<site> <command>")', type: 'string' },
    { name: 'platform', label: 'Platform written into frontmatter and tags (default the site)', type: 'string' },
    { name: 'cli', label: 'opencli executable (default opencli on PATH)', type: 'string' },
  ],
  defaults: { units: { by: 'item' }, render: { period: 'week', by: 'author' }, schedule: { every: '3h' }, backfillDays: 7 },
  minIntervalMinutes: 30,
  async check(ctx) {
    const [site, command] = opencliArgs(ctx.feed.params);
    await assertReadOnly(ctx, site, command);
    return { ok: true, message: `opencli ${site} ${command} is a read command` };
  },
  pull: pullOpencli,
};
