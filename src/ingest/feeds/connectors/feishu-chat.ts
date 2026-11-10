import fs from 'node:fs';
import path from 'node:path';
import { isConvertibleFile } from '../../convert.js';
import { execRunner, FeishuError, LarkCli, LarkRunner, resolveLarkCli, RunResult } from '../../feishu/client.js';
import type { ConnectorContext, FeedAttachment, FeedConnector, FeedItem, FeedOrigin, PullResult } from '../types.js';

/**
 * Feishu (Lark) group chats, read as the signed-in user through lark-cli
 * (src/ingest/feishu/client.ts holds the sign-in; docs/design/08 the
 * conventions for chats and relay groups).
 *
 * Each pull lists a chat's messages oldest first with
 * `im +chat-messages-list`, which also expands thread replies and attaches
 * reaction counts. The cursor per chat is the newest top-level message read,
 * and every pull starts again `lookbackDays` before it (as gbrain's Slack
 * connector does): that is how an edit, a recall or a late thread reply in
 * the last days is seen at all, since Feishu offers no change feed to a user
 * token. Re-reading is cheap: the ledger keeps an item whose content did not
 * change as it was.
 *
 * lark-cli renders each message's content into text with markers for what
 * is not text (`[Image: img_…]`, `<file key=… name=…/>`, `<card …>`);
 * those markers become attachments here, and the rest is the message's
 * Markdown. The raw API shape (`body.content` JSON, epoch `create_time`) is
 * read too, so a later lark-cli that changes its rendering, or a switch to
 * `lark-cli api GET /open-apis/im/v1/messages`, does not need a new parser.
 */

/**
 * What reading a chat needs from the signed-in user. The first four are what
 * lark-cli's `+chat-messages-list` declares for a user token and checks
 * before it sends anything (the reactions scope because it attaches reaction
 * counts); `im:chat:read` is only for the chat's name, shown instead of its id.
 */
export const FEISHU_CHAT_SCOPES = [
  'im:message:readonly',
  'im:message.group_msg:get_as_user',
  'im:message.p2p_msg:get_as_user',
  'im:message.reactions:read',
  'im:chat:read',
] as const;

/** Scopes Feishu treats as granting the same thing (any one will do). */
const SCOPE_ALTERNATIVES: Record<string, string[]> = {
  'im:chat:read': ['im:chat:read', 'im:chat:readonly', 'im:chat'],
};

/** Of FEISHU_CHAT_SCOPES, the ones `granted` lacks. */
export function missingChatScopes(granted: string[]): string[] {
  const have = new Set(granted);
  return FEISHU_CHAT_SCOPES.filter((s) => !(SCOPE_ALTERNATIVES[s] ?? [s]).some((alt) => have.has(alt)));
}

const DAY = 86_400_000;
const MINUTE = 60_000;

/* --------------------------------- state --------------------------------- */

/** Per chat: where the next pull starts. */
export interface ChatCursor {
  /** create_time of the newest top-level message read (ISO). */
  cursor?: string;
  /** Where the first pull started, so a chat that stays quiet keeps its horizon instead of sliding. */
  from?: string;
  /** The last pull stopped at the page limit: the next one resumes at the cursor itself, without the look-back. */
  more?: boolean;
  name?: string;
  kind?: string;
  /** When the chat's name was last looked up. */
  nameAt?: string;
}

export interface FeishuChatState {
  chats: Record<string, ChatCursor>;
}

function readState(state: unknown): FeishuChatState {
  const chats = state && typeof state === 'object' ? (state as FeishuChatState).chats : undefined;
  return { chats: chats && typeof chats === 'object' ? { ...chats } : {} };
}

/* -------------------------------- params --------------------------------- */

export function chatIdsOf(params: Record<string, unknown>): string[] {
  const more = Array.isArray(params.chatIds) ? params.chatIds : typeof params.chatIds === 'string' ? params.chatIds.split(/[\s,]+/) : [];
  const list = [params.chatId, ...more].map((c) => (typeof c === 'string' ? c.trim() : '')).filter(Boolean);
  return [...new Set(list)];
}

function numberParam(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

interface ChatOptions {
  lookbackDays: number;
  maxPages: number;
  relayTimestamps: boolean;
  /** A relay group: who wrote each post and where it came from are in its text (see `relaySignature`). */
  relay: boolean;
}

function optionsOf(params: Record<string, unknown>): ChatOptions {
  return {
    lookbackDays: numberParam(params.lookbackDays, 2, 0, 60),
    maxPages: Math.round(numberParam(params.maxPages, 20, 1, 1000)),
    relayTimestamps: params.relayTimestamps === true || params.relayTimestamps === 'true' || params.relay === true || params.relay === 'true',
    relay: params.relay === true || params.relay === 'true',
  };
}

/* ------------------------------ lark-cli calls ---------------------------- */

let runnerOverride: LarkRunner | null = null;

/** Tests drive a fake lark-cli through this; null restores the real one. */
export function setFeishuChatRunner(runner: LarkRunner | null): void {
  runnerOverride = runner;
}

/** The feed's own lark-cli, else the one the workspace's Feishu documents use. */
function larkFor(ctx: ConnectorContext): { cli: string; run: LarkRunner } {
  const own = typeof ctx.feed.params.cli === 'string' ? ctx.feed.params.cli.trim() : '';
  const cli = resolveLarkCli(own || ctx.config.ingest?.feishu?.cli);
  return { cli, run: runnerOverride ?? execRunner(cli) };
}

type Json = Record<string, unknown>;

const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** The JSON object a lark-cli call printed; a failure can put a line of prose before it. */
function parseJson(text: string): Json | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  for (const candidate of [trimmed, trimmed.slice(Math.max(0, trimmed.indexOf('{')))]) {
    try {
      const v = JSON.parse(candidate) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Json;
    } catch {
      // try the next
    }
  }
  return null;
}

/** Feishu's codes for "this identity may not read that chat". */
const FORBIDDEN_CODES = new Set([232011, 232025, 231003, 99991672]);

/**
 * A failed call as a FeishuError saying what to do. A missing scope is told
 * apart from an expired sign-in because the fix differs: granting a scope is
 * a one-time `lark-cli auth login --scope …`, which the in-app sign-in
 * (`knode-os feishu login`) then keeps, since it asks again for every scope
 * already granted.
 */
export function feishuChatError(result: RunResult, what: string): FeishuError {
  if (result.code === 127) return new FeishuError('lark-cli is not installed', 'not-installed', "install it (https://github.com/larksuite/cli), or set ingest.feishu.cli (or the feed's params.cli) to where it is");
  const env = parseJson(result.stderr) ?? parseJson(result.stdout);
  const error = obj(env?.error);
  const type = str(error.type);
  const subtype = str(error.subtype);
  const message = str(error.message) || result.stderr.trim().split('\n').pop() || `exit code ${result.code}`;
  const code = typeof error.code === 'number' ? error.code : Number(/\b(\d{5,8})\b/.exec(message)?.[1] ?? NaN);
  const listed = Array.isArray(error.missing_scopes) ? error.missing_scopes.map(String).filter(Boolean) : [];
  const fromMessage = /missing required scopes?(?:\(s\))?:\s*(.+)/i.exec(message)?.[1].split(/[\s,]+/).filter((s) => s.includes(':')) ?? [];
  const missing = listed.length ? listed : fromMessage;
  if (subtype === 'missing_scope' || missing.length) {
    const scopes = missing.length ? missing : [...FEISHU_CHAT_SCOPES];
    return new FeishuError(
      `${what}: the signed-in Feishu user has not granted ${scopes.join(', ')}`,
      'auth',
      `grant it once with \`lark-cli auth login --scope "${scopes.join(' ')}"\` and open the link it prints; \`knode-os feishu login\` keeps it afterwards`,
    );
  }
  if (result.code === 3 || type === 'auth' || type === 'authentication' || /token|unauthori[sz]ed|not.?logged.?in|login|expired/i.test(subtype)) {
    return new FeishuError(`${what}: Feishu authorization needed`, 'auth', 'sign in to Feishu again (`knode-os feishu login`, or Import → Feishu → Connect)');
  }
  if (code === 230002 || /bot.{0,20}(not|outside).{0,20}(chat|group)|not in (the )?chat/i.test(message)) {
    return new FeishuError(
      `${what}: Feishu answered that the app is not in this chat (230002)`,
      'forbidden',
      "Feishu can ask for lark-cli's app bot to be a member of the group even when reading as the user: add the bot to the group (group settings → Bots → Add bot), and check the signed-in user is a member",
    );
  }
  if (FORBIDDEN_CODES.has(code) || /permission|forbidden|no access|not a member|无权限/i.test(message)) {
    return new FeishuError(`${what}: the signed-in Feishu user may not read this chat`, 'forbidden', 'the user must be a member of the group');
  }
  if (/not ?found|not exist|不存在|invalid.{0,10}chat/i.test(message)) return new FeishuError(`${what}: no such chat — check the chat id (oc_…)`, 'not-found');
  return new FeishuError(`${what}: ${message}`, 'other', str(error.hint) || undefined);
}

/** Run one lark-cli call and return its envelope (`data`, `meta`). */
async function callLark(run: LarkRunner, args: string[], what: string, timeoutMs: number, cwd?: string): Promise<Json> {
  const result = await run(args, { timeoutMs, cwd });
  const env = result.code === 0 ? parseJson(result.stdout) : null;
  if (!env || env.ok === false) throw feishuChatError(result, what);
  return env;
}

/** A chat's name and kind (`im chats get`, which needs im:chat:read). */
async function chatInfo(run: LarkRunner, chatId: string): Promise<{ name: string; kind: string }> {
  const env = await callLark(run, ['im', 'chats', 'get', '--chat-id', chatId, '--as', 'user'], `read the name of chat ${chatId}`, 60_000);
  const data = obj(env.data);
  const chat = data.name !== undefined ? data : obj(data.chat ?? data.data);
  return { name: str(chat.name).trim(), kind: str(chat.chat_mode) === 'p2p' ? 'p2p' : 'group' };
}

const messagesOf = (env: Json): Json[] => {
  const data = obj(env.data);
  const list = Array.isArray(data.messages) ? data.messages : Array.isArray(data.items) ? data.items : [];
  return list.filter((m): m is Json => Boolean(m) && typeof m === 'object');
};

/* --------------------------------- times --------------------------------- */

/**
 * A create_time as lark-cli prints it: epoch seconds or milliseconds (the
 * raw API), ISO 8601, or its own "YYYY-MM-DD HH:MM" in this machine's zone —
 * the zone lark-cli formats in too, since it runs with this process's
 * environment. `minute` is true when the seconds were dropped.
 */
export function parseLarkTime(value: unknown): { ms: number; minute: boolean } | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? { ms: value >= 1e12 ? value : value * 1000, minute: false } : null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (/^\d{9,}$/.test(s)) {
    const n = Number(s);
    return { ms: n >= 1e12 ? n : n * 1000, minute: false };
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (local) {
    const [, y, mo, d, h, mi, sec] = local;
    const t = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), sec ? Number(sec) : 0).getTime();
    return Number.isNaN(t) ? null : { ms: t, minute: sec === undefined };
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : { ms: t, minute: false };
}

/**
 * Where a chat's next pull starts: the first pull at the feed's horizon; a
 * pull after one that hit the page limit at the cursor itself (so a long
 * backlog makes progress); otherwise `lookbackDays` before the cursor, never
 * before the horizon. Whole minutes, since that is all lark-cli's
 * create_time carries.
 */
export function pullStart(chat: ChatCursor, since: Date | null, lookbackDays: number, now = Date.now(), backfillDays = 3): { startMs: number; from: string } {
  const floor = (ms: number) => Math.floor(ms / MINUTE) * MINUTE;
  const fromMs = chat.from ? Date.parse(chat.from) : NaN;
  const horizon = floor(Number.isFinite(fromMs) ? fromMs : since ? since.getTime() : now - backfillDays * DAY);
  const cursor = chat.cursor ? Date.parse(chat.cursor) : NaN;
  let start = horizon;
  if (Number.isFinite(cursor)) start = chat.more ? cursor : Math.max(horizon, cursor - lookbackDays * DAY);
  return { startMs: floor(start), from: new Date(horizon).toISOString() };
}

/* ------------------------------ relay groups ----------------------------- */

const RELAY_TIME = /^\s*(?:\*\*)?\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(Z|[+-]\d{2}:?\d{2})?\s*(?:\*\*)?\s*$/;

/**
 * A relay bot's first line, the time the post was published at its origin
 * ("2026-09-30 10:46:51", Asia/Shanghai unless it carries an offset): that
 * time and the text after it. Null when the first line is anything else, or
 * the time is after the delivery or a year before it — then it is not a
 * relay header.
 */
export function parseRelayTimestamp(text: string, deliveredMs?: number): { at: string; rest: string } | null {
  const nl = text.indexOf('\n');
  const m = RELAY_TIME.exec(nl < 0 ? text : text.slice(0, nl));
  if (!m) return null;
  const [, y, mo, d, h, mi, s, off] = m;
  const pad = (v: string) => v.padStart(2, '0');
  const zone = !off ? '+08:00' : off === 'Z' ? 'Z' : off.includes(':') ? off : `${off.slice(0, 3)}:${off.slice(3)}`;
  // a date that does not exist (02-30, 25:00) is not a timestamp, whatever Date.parse would roll it into
  const check = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0)));
  if (check.getUTCDate() !== Number(d) || check.getUTCMonth() !== Number(mo) - 1 || check.getUTCHours() !== Number(h)) return null;
  const at = `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${mi}:${s ?? '00'}${zone}`;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return null;
  if (deliveredMs !== undefined && (t > deliveredMs + 3_600_000 || t < deliveredMs - 365 * DAY)) return null;
  return { at, rest: nl < 0 ? '' : text.slice(nl + 1).trim() };
}

const RELAY_PREFIX = /^\s*【(付费|免费)?(微博|知识星球|星球|公众号)】/;
const RELAY_PLATFORMS: Record<string, string> = { 微博: 'weibo', 知识星球: 'zsxq', 星球: 'zsxq', 公众号: 'wechat' };

/**
 * Where a relayed post came from, when the bot says so with a prefix such as
 * 【付费微博】: the platform, whether the post was paid, and for Weibo the
 * post's id when its link is in the text (it is what tells the same post
 * relayed into two groups apart from two posts). Nothing is guessed beyond that.
 */
export function relayOrigin(text: string): { origin: FeedOrigin; visibility?: 'paid' | 'free' } | null {
  const m = RELAY_PREFIX.exec(text);
  if (!m) return null;
  const origin: FeedOrigin = { platform: RELAY_PLATFORMS[m[2]] };
  if (origin.platform === 'weibo') {
    const link = /https?:\/\/(?:m\.)?weibo\.(?:com|cn)\/(?:status\/|detail\/|\d+\/)([A-Za-z0-9]{6,})/.exec(text);
    if (link) {
      origin.url = link[0];
      origin.id = link[1];
    }
  }
  return { origin, ...(m[1] ? { visibility: m[1] === '付费' ? ('paid' as const) : ('free' as const) } : {}) };
}

const ORIGIN_HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)weibo\.(com|cn)$/, 'weibo'],
  [/(^|\.)xueqiu\.com$/, 'xueqiu'],
  [/(^|\.)zsxq\.com$/, 'zsxq'],
  [/(^|\.)(x|twitter)\.com$/, 'x'],
  [/(^|\.)mp\.weixin\.qq\.com$/, 'wechat'],
  [/(^|\.)taoguba\.com\.cn$/, 'taoguba'],
];

/**
 * A relay bot's signature: the post's last line names its author and links the
 * original — `@ 混沌20000  https://weibo.com/混沌20000/5362582648784375` — and
 * its text often starts with the same name (`混沌20000：…`). Then the author is
 * that account, not the bot, the link is the item's origin (its id tells the
 * same post relayed into two groups apart), and both the signature and the
 * name prefix leave the text. Null when the last line is not such a signature.
 */
export function relaySignature(text: string): { account: string; platform: string; url: string; id?: string; rest: string } | null {
  const lines = text.replace(/\s+$/, '').split('\n');
  const last = lines[lines.length - 1] ?? '';
  const m = /^\s*@\s*(\S{1,40}?)\s+(https?:\/\/\S+)\s*$/.exec(last);
  if (!m) return null;
  let host = '';
  let segments: string[] = [];
  try {
    const u = new URL(m[2]);
    host = u.hostname.toLowerCase();
    segments = u.pathname.split('/').filter(Boolean);
  } catch {
    return null;
  }
  const platform = ORIGIN_HOSTS.find(([re]) => re.test(host))?.[1] ?? host.replace(/^www\./, '');
  const account = m[1];
  const tail = segments[segments.length - 1] ?? '';
  const id = /^[A-Za-z0-9]{6,}$/.test(tail) && decodeURIComponent(tail) !== account ? tail : undefined;
  let rest = lines.slice(0, -1).join('\n').trim();
  const prefix = new RegExp(`^${account.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[：:]\\s*`);
  rest = rest.replace(prefix, '');
  return { account, platform, url: m[2], ...(id ? { id } : {}), rest };
}

/* -------------------------------- content -------------------------------- */

interface Mention {
  key?: unknown;
  id?: unknown;
  name?: unknown;
}

/** lark-cli escapes attribute values with backslashes (`\"`, `\\`, `\n`). */
function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w-]+)="((?:[^"\\]|\\.)*)"/g)) {
    out[m[1]] = m[2].replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '' : c));
  }
  return out;
}

const escAttr = (v: unknown) => str(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/** `@_user_1` keys left in text become the names the mentions array gives them. */
function resolveMentions(text: string, mentions: Mention[]): string {
  const pairs = mentions.map((m) => [str(m.key), str(m.name)] as const).filter(([k, n]) => k && n);
  // longest first, so @_user_1 does not eat the start of @_user_10
  for (const [key, name] of pairs.sort((a, b) => b[0].length - a[0].length)) text = text.split(key).join(`@${name}`);
  return text;
}

function postElement(el: Json): string {
  const style = Array.isArray(el.style) ? el.style.map(String) : [];
  const styled = (t: string) => {
    if (!t) return t;
    if (style.includes('bold')) t = `**${t}**`;
    if (style.includes('italic')) t = `*${t}*`;
    if (style.includes('lineThrough')) t = `~~${t}~~`;
    return t;
  };
  switch (str(el.tag)) {
    case 'text':
      return styled(str(el.text));
    case 'a': {
      const text = str(el.text);
      const href = str(el.href);
      return styled(href && text ? `[${text.replace(/[[\]]/g, '\\$&')}](${href})` : href || text);
    }
    case 'at': {
      const id = str(el.user_id);
      return id === 'all' || id === '@_all' ? '@all' : `@${str(el.user_name) || id}`;
    }
    case 'img':
      return el.image_key ? `![Image](${str(el.image_key)})` : '';
    case 'media':
      return el.file_key ? `[Media: ${str(el.file_key)}]` : '';
    case 'emotion':
      return el.emoji_type ? `:${str(el.emoji_type)}:` : '';
    case 'code_block':
      return `\n\`\`\`${str(el.language)}\n${str(el.text)}\n\`\`\`\n`;
    case 'hr':
      return '\n---\n';
    default:
      return str(el.text);
  }
}

function rawPost(o: Json): string {
  let body: Json = o;
  if (!('content' in o) && !('title' in o)) {
    const locale = ['zh_cn', 'en_us', 'ja_jp'].find((k) => o[k] && typeof o[k] === 'object') ?? Object.keys(o).sort().find((k) => o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]));
    body = locale ? obj(o[locale]) : {};
  }
  const lines: string[] = [];
  if (str(body.title)) lines.push(str(body.title));
  const blocks = Array.isArray(body.content_v2) && body.content_v2.length ? body.content_v2 : Array.isArray(body.content) ? body.content : [];
  for (const para of blocks) lines.push((Array.isArray(para) ? para : []).map((el) => postElement(obj(el))).join(''));
  const files = Array.isArray(o.files) ? o.files.map(obj).filter((f) => f.file_key) : [];
  for (const f of files) lines.push(`<file key="${escAttr(f.file_key)}" name="${escAttr(f.file_name || f.file_key)}"/>`);
  return lines.join('\n');
}

/** A card's words in reading order, and its pictures; enough to read it, not to redraw it. */
function rawCard(o: Json): string {
  let card: unknown = o;
  if (typeof o.json_card === 'string') {
    try {
      card = JSON.parse(o.json_card);
    } catch {
      return '[interactive card]';
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const n = node as Json;
    for (const key of ['img_key', 'image_key']) if (/^img_/.test(str(n[key]))) out.push(`🖼️ Image(img_key:${str(n[key])})`);
    for (const key of ['content', 'text']) {
      const t = str(n[key]).trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
    for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v);
  };
  const c = obj(card);
  walk(c.header);
  if (out.length) out[0] = `**${out[0]}**`;
  walk(c.body ?? c.elements ?? c.i18n_elements);
  return out.length ? out.join('\n') : '[interactive card]';
}

function rawSystem(o: Json): string {
  const names = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean).join(', ') : '');
  return str(o.template)
    .replace(/\{from_user\}/g, names(o.from_user))
    .replace(/\{to_chatters\}/g, names(o.to_chatters))
    .replace(/\{divider_text\}/g, str(obj(o.divider_text).text))
    .replace(/\{(\w+)\}/g, (m, key: string) => str(o[key]) || m)
    .trim();
}

/** The raw API's content object for this message type, or null when `content` is already lark-cli's text. */
function rawContentOf(msgType: string, content: unknown): Json | null {
  let value = content;
  if (typeof content === 'string') {
    const s = content.trim();
    if (!s.startsWith('{')) return null;
    try {
      value = JSON.parse(s);
    } catch {
      return null;
    }
  }
  const o = obj(value);
  const has = (k: string) => k in o;
  // only the shape this message type has: a text message whose text is a JSON object stays text
  const looks: Record<string, boolean> = {
    text: typeof o.text === 'string',
    post: Array.isArray(o.content) || has('title') || has('zh_cn') || has('en_us') || has('ja_jp'),
    image: typeof o.image_key === 'string',
    file: typeof o.file_key === 'string',
    audio: typeof o.file_key === 'string',
    media: typeof o.file_key === 'string',
    video: typeof o.file_key === 'string',
    sticker: typeof o.file_key === 'string',
    interactive: has('json_card') || has('elements') || has('header') || has('body') || has('i18n_elements'),
    system: typeof o.template === 'string',
  };
  return looks[msgType] ? o : null;
}

/** The raw API's content in lark-cli's text form, so one pass below reads both. */
function rawToText(msgType: string, o: Json): string {
  switch (msgType) {
    case 'text':
      return str(o.text);
    case 'post':
      return rawPost(o);
    case 'image':
      return `[Image: ${str(o.image_key)}]`;
    case 'file':
      return `<file key="${escAttr(o.file_key)}" name="${escAttr(o.file_name || o.file_key)}"/>`;
    case 'audio':
      return `<audio key="${escAttr(o.file_key)}"/>`;
    case 'media':
    case 'video':
      return `<video key="${escAttr(o.file_key)}" name="${escAttr(o.file_name || o.file_key)}"/>`;
    case 'sticker':
      return '[Sticker]';
    case 'interactive':
      return rawCard(o);
    case 'system':
      return rawSystem(o);
    default:
      return `[${msgType}]`;
  }
}

/** lark-cli's merge_forward tree as nested quotes: `> **who** · when` over what they said. */
function quoteForwarded(text: string): string {
  if (!text.includes('<forwarded_messages')) return text;
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const lead = /^ */.exec(line)![0].length;
    const body = line.slice(lead);
    if (/^<\/?forwarded_messages\/?>$/.test(body.trim())) continue;
    const level = Math.floor(lead / 4);
    const head = /^\[([^\]]+)\] (.+):$/.exec(body);
    if (head) {
      const when = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(head[1]) ? ` · ${head[1].slice(0, 16).replace('T', ' ')}` : '';
      out.push(`${'> '.repeat(level + 1)}**${head[2]}**${when}`);
    } else {
      out.push(`${'> '.repeat(Math.max(level, 1))}${body}`.trimEnd());
    }
  }
  return out.join('\n');
}

/** A card's `<card title="…">` wrapper as a bold title line. */
function unwrapCard(text: string): string {
  return text
    .replace(/^<card((?:\s[^>]*)?)>$/gm, (_, attrs: string) => {
      const a = attrsOf(attrs);
      return [a.title ? `**${a.title}**` : '', a.subtitle ?? ''].filter(Boolean).join('\n');
    })
    .replace(/^<\/card>$/gm, '');
}

export interface RenderedContent {
  /** Markdown, with the markers of pictures and files taken out (the renderer lists attachments itself). */
  text: string;
  attachments: FeedAttachment[];
}

/**
 * A message's content as Markdown and attachments. Attachment URLs are
 * `feishu:image:<message_id>:<key>` or `feishu:file:<message_id>:<key>`,
 * what `download` below fetches; a picture inside a forwarded bundle is
 * fetched through the bundle's own message id, as Feishu requires.
 */
export function renderFeishuContent(msgType: string, content: unknown, opts: { messageId: string; mentions?: Mention[] }): RenderedContent {
  if (msgType === 'sticker') return { text: '', attachments: [] };
  const attachments: FeedAttachment[] = [];
  const seen = new Set<string>();
  const add = (kind: FeedAttachment['kind'], type: 'image' | 'file', key: string | undefined, name?: string) => {
    // the key goes to lark-cli as --file-key: anything path-like is not one
    if (!key || /[/\\]|\.\./.test(key)) return;
    const url = `feishu:${type}:${opts.messageId}:${key}`;
    if (seen.has(url)) return;
    seen.add(url);
    attachments.push({ kind, url, ...(name ? { name } : {}) });
  };
  const raw = rawContentOf(msgType, content);
  let text = raw ? rawToText(msgType, raw) : typeof content === 'string' ? content : '';
  if (msgType === 'merge_forward') text = quoteForwarded(text);
  if (msgType === 'interactive') text = unwrapCard(text);
  text = text
    .replace(/<file\s[^>]*?\/>/g, (tag) => {
      const a = attrsOf(tag);
      add('file', 'file', a.key, a.name && a.name !== a.key ? a.name : undefined);
      return '';
    })
    .replace(/<audio\s[^>]*?\/>/g, (tag) => {
      const a = attrsOf(tag);
      add('audio', 'file', a.key, a.duration ? `voice ${a.duration}` : 'voice');
      return '';
    })
    .replace(/<video\s[^>]*?\/>/g, (tag) => {
      const a = attrsOf(tag);
      add('video', 'file', a.key, a.name && a.name !== a.key ? a.name : undefined);
      return '';
    })
    .replace(/<folder\s([^>]*?)\/?>/g, (_, inner: string) => `[folder: ${attrsOf(inner).name || 'folder'}]`)
    .replace(/<\/folder>/g, '')
    .replace(/\[Image: ([^\]\s]+)\]/g, (_, key: string) => {
      add('image', 'image', key);
      return '';
    })
    // a post's inline picture; only Feishu image keys, so a relative link someone wrote stays a link
    .replace(/!\[[^\]]*\]\((img_[^)\s]+)\)/g, (_, key: string) => {
      add('image', 'image', key);
      return '';
    })
    .replace(/\[Media: ([^\]\s]+)\]/g, (_, key: string) => {
      add('video', 'file', key);
      return '';
    })
    .replace(/🖼️ ?([^\n(]*)\(img_key:([^)\s]+)\)/g, (_, alt: string, key: string) => {
      add('image', 'image', key, alt.trim() && alt.trim() !== 'Image' ? alt.trim() : undefined);
      return '';
    })
    .replace(/\(img_token:[^)]*\)/g, '')
    .replace(/<at user_id="([^"]*)">([^<]*)<\/at>/g, (_, id: string, name: string) => (id === 'all' ? '@all' : `@${name || id}`))
    .replace(/<\/?u>/g, '');
  text = resolveMentions(text, opts.mentions ?? []);
  text = text
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, attachments };
}

/* --------------------------------- items --------------------------------- */

function reactionSummary(value: unknown): Record<string, number> | undefined {
  const counts = obj(value).counts;
  const out: Record<string, number> = {};
  if (Array.isArray(counts)) {
    for (const c of counts.map(obj)) {
      const type = str(c.reaction_type) || str(c.emoji_type);
      const n = Number(c.count);
      if (type && n > 0) out[type] = (out[type] ?? 0) + n;
    }
  } else {
    for (const [type, n] of Object.entries(obj(counts))) if (Number(n) > 0) out[type] = Number(n);
  }
  return Object.keys(out).length ? out : undefined;
}

export interface ChatInfo {
  id: string;
  name?: string;
  kind?: string;
}

/**
 * lark-cli's create_time keeps only the minute, and items of one minute
 * would otherwise be ordered by id, which in Feishu says nothing about time.
 * The n-th message of a minute in the listing is placed n milliseconds into
 * it, so a conversation keeps its order. The listing always covers whole
 * minutes and keeps recalled messages, so n does not change between pulls.
 */
function minuteOrder(): (ms: number) => number {
  const seen = new Map<number, number>();
  return (ms) => {
    const n = seen.get(ms) ?? 0;
    seen.set(ms, n + 1);
    return n;
  };
}

function itemOf(m: Json, chat: ChatInfo, relay: boolean, order: (ms: number) => number, host?: { id: string; threadId?: string }, signatures = false): FeedItem | null {
  const id = str(m.message_id).trim();
  if (!id) return null;
  const msgType = str(m.msg_type) || 'text';
  const deleted = m.deleted === true;
  const t = parseLarkTime(m.create_time);
  const delivered = t ? t.ms + (t.minute ? order(t.ms) : 0) : null;
  const mentions = Array.isArray(m.mentions) ? (m.mentions as Mention[]) : [];
  const content = m.content !== undefined ? m.content : obj(m.body).content;
  const rendered = renderFeishuContent(msgType, content, { messageId: id, mentions });
  let text = rendered.text;
  let publishedAt = delivered !== null ? new Date(delivered).toISOString() : '';
  const meta: Json = { msgType };
  let origin: FeedOrigin | undefined;
  let dedupeKey: string | undefined;
  if (relay && t && !deleted) {
    const stamp = parseRelayTimestamp(text, t.ms);
    if (stamp) {
      publishedAt = stamp.at;
      text = stamp.rest;
      meta.deliveredAt = new Date(t.ms).toISOString();
    }
    const from = relayOrigin(text);
    if (from) {
      origin = from.origin;
      if (from.visibility) meta.visibility = from.visibility;
      if (from.origin.id) dedupeKey = `${from.origin.platform}:${from.origin.id}`;
    }
  }
  const sender = obj(m.sender);
  let senderId = str(sender.id);
  let senderName = str(sender.name) || str(sender.sender_name);
  if (signatures && !deleted) {
    const sig = relaySignature(text);
    if (sig) {
      text = sig.rest;
      if (senderName) meta.relayedBy = senderName;
      senderName = sig.account;
      senderId = `${sig.platform}:${sig.account}`;
      origin = { ...(origin ?? {}), platform: origin?.platform ?? sig.platform, account: sig.account, url: origin?.url ?? sig.url, ...(origin?.id ?? sig.id ? { id: origin?.id ?? sig.id } : {}) };
      if (!dedupeKey && origin.id) dedupeKey = `${origin.platform}:${origin.id}`;
    }
  }
  if (str(sender.sender_type)) meta.senderType = str(sender.sender_type);
  const names = mentions.map((x) => str(x.name)).filter(Boolean);
  if (names.length) meta.mentions = names;
  const reactions = reactionSummary(m.reactions);
  if (reactions) meta.reactions = reactions;
  if (m.thread_has_more === true) meta.threadHasMore = true;
  const threadId = str(m.thread_id) || host?.threadId || '';
  const replyTo = host ? host.id : str(m.reply_to) || str(m.parent_id) || str(m.root_id);
  const edited = m.updated === true ? parseLarkTime(m.update_time) : null;
  const url = str(m.message_app_link);
  return {
    id,
    publishedAt,
    ...(edited ? { updatedAt: new Date(edited.ms).toISOString() } : {}),
    ...(senderId || senderName ? { author: { name: senderName || senderId, ...(senderId ? { id: senderId } : {}) } } : {}),
    channel: { id: chat.id, name: chat.name || chat.id, kind: chat.kind ?? 'group' },
    text,
    format: 'markdown',
    ...(threadId ? { threadId } : {}),
    ...(replyTo && replyTo !== id ? { replyTo } : {}),
    // a recalled message's pictures cannot be fetched any more
    ...(!deleted && rendered.attachments.length ? { attachments: rendered.attachments } : {}),
    ...(/^https?:/.test(url) ? { url } : {}),
    ...(origin ? { origin } : {}),
    ...(dedupeKey ? { dedupeKey } : {}),
    meta,
    ...(deleted ? { deleted: true } : {}),
  };
}

/**
 * Items of one listing: the top-level messages, and the thread replies
 * lark-cli attached to them (each reply's threadId is its thread, its
 * replyTo the thread's first message). `lastMs` is the create_time of the
 * last top-level message, the chat's next cursor.
 */
export function feishuMessageItems(messages: unknown[], chat: ChatInfo, opts: { relayTimestamps?: boolean; relay?: boolean } = {}): { items: FeedItem[]; lastMs: number | null; threadsCut: number } {
  const items: FeedItem[] = [];
  const seen = new Set<string>();
  const order = minuteOrder();
  let lastMs: number | null = null;
  let threadsCut = 0;
  for (const raw of messages) {
    const m = obj(raw);
    const item = itemOf(m, chat, opts.relayTimestamps === true, order, undefined, opts.relay === true);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
    const t = parseLarkTime(m.create_time);
    if (t) lastMs = lastMs === null ? t.ms : Math.max(lastMs, t.ms);
    if (m.thread_has_more === true) threadsCut++;
    const replies = Array.isArray(m.thread_replies) ? m.thread_replies : [];
    // replies get their own ordering, so a new reply never shifts the top-level messages' times
    const replyOrder = minuteOrder();
    for (const r of replies) {
      const reply = itemOf(obj(r), chat, opts.relayTimestamps === true, replyOrder, { id: item.id, threadId: item.threadId }, opts.relay === true);
      // a thread's listing can start with its own first message
      if (!reply || seen.has(reply.id)) continue;
      seen.add(reply.id);
      items.push(reply);
    }
  }
  return { items: opts.relay ? foldCardPictures(items) : items, lastMs, threadsCut };
}

const CARD_GAP_MS = 90_000;

/**
 * A relay bot sends a card as two messages, a picture and then its text, a
 * moment apart. In a relay group the picture joins the text it belongs to —
 * the next message from the same sender within 90 s (or else the one just
 * before it) — so a post is one item with its picture, not a post and a
 * bare picture.
 */
export function foldCardPictures(items: FeedItem[]): FeedItem[] {
  const pictureOnly = (i: FeedItem) => !i.deleted && !i.text?.trim() && (i.attachments ?? []).length > 0 && !i.replyTo;
  // who sent the message in the group: the bot, for a post whose author came from its signature
  const senderOf = (i: FeedItem) => String(i.meta?.relayedBy ?? i.author?.name ?? '');
  const sameCard = (a: FeedItem, b: FeedItem | undefined): b is FeedItem =>
    b !== undefined && !b.deleted && Boolean(b.text?.trim()) && !b.replyTo && senderOf(a) !== '' && senderOf(a) === senderOf(b)
    && Math.abs(deliveredAt(a) - deliveredAt(b)) <= CARD_GAP_MS;
  // when they reached the group: a relay header may have moved publishedAt to the original post's time
  function deliveredAt(i: FeedItem): number {
    return Date.parse(String(i.meta?.deliveredAt ?? i.publishedAt));
  }
  const out: FeedItem[] = [];
  const folded = new Set<number>();
  // per text: how many pictures sent before it have been put in front of its own
  const before = new Map<number, number>();
  // the text a picture belongs to: past the card's other pictures to its text (a card may carry several), else the post just before
  const textFor = (i: number): number => {
    const item = items[i];
    for (let j = i + 1; j < items.length; j++) {
      if (sameCard(item, items[j])) return j;
      if (!(pictureOnly(items[j]) && senderOf(items[j]) === senderOf(item) && Math.abs(deliveredAt(items[j]) - deliveredAt(item)) <= CARD_GAP_MS)) break;
    }
    return sameCard(item, items[i - 1]) ? i - 1 : -1;
  };
  items.forEach((item, i) => {
    if (!pictureOnly(item)) return;
    const target = textFor(i);
    if (target < 0) return;
    const host = items[target];
    const atts = [...(host.attachments ?? [])];
    if (target > i) {
      // pictures sent before their text go first, in the order they came
      const at = before.get(target) ?? 0;
      atts.splice(at, 0, ...item.attachments!);
      before.set(target, at + item.attachments!.length);
    } else {
      atts.push(...item.attachments!);
    }
    items[target] = { ...host, attachments: atts };
    folded.add(i);
  });
  items.forEach((item, i) => {
    if (!folded.has(i)) out.push(item);
  });
  return out;
}

/* ---------------------------------- pull --------------------------------- */

async function pullChat(ctx: ConnectorContext, run: LarkRunner, chatId: string, prev: ChatCursor, opts: ChatOptions): Promise<{ items: FeedItem[]; state: ChatCursor; more: boolean; notes: string[] }> {
  const now = Date.now();
  const notes: string[] = [];
  const { startMs, from } = pullStart(prev, ctx.since, opts.lookbackDays, now, ctx.feed.backfillDays ?? 3);
  const args = [
    'im', '+chat-messages-list', '--chat-id', chatId, '--as', 'user', '--order', 'asc', '--start', String(Math.floor(startMs / 1000)),
    '--page-size', '50', '--page-all', '--page-limit', String(opts.maxPages), '--format', 'json',
  ];
  const env = await callLark(run, args, `read Feishu chat ${chatId}`, 900_000);
  const data = obj(env.data);
  const pagination = obj(obj(env.meta).pagination);
  // with --page-all, has_more is still true at the end only when --page-limit stopped it
  const more = data.has_more === true || pagination.complete === false;

  // the name is looked up once (again after a week, or a day when it failed): it is one call per chat, and optional
  let { name, kind, nameAt } = prev;
  const age = nameAt ? now - Date.parse(nameAt) : Infinity;
  if (!(age < (name ? 7 : 1) * DAY)) {
    nameAt = new Date(now).toISOString();
    try {
      const info = await chatInfo(run, chatId);
      if (info.name) name = info.name;
      kind = info.kind;
    } catch (err) {
      notes.push(`${chatId}: chat name not read, the id is used (${err instanceof Error ? err.message : err})`);
    }
  }

  const messages = messagesOf(env);
  const { items, lastMs, threadsCut } = feishuMessageItems(messages, { id: chatId, name, kind }, { relayTimestamps: opts.relayTimestamps, relay: opts.relay });
  const cursor = lastMs !== null ? new Date(lastMs).toISOString() : prev.cursor;
  const label = name ? `${name} (${chatId})` : chatId;
  notes.push(`${label}: ${messages.length} message(s) since ${new Date(startMs).toISOString()}${more ? `; stopped at ${opts.maxPages} page(s), more to read` : ''}`);
  if (threadsCut) notes.push(`${label}: ${threadsCut} thread(s) have more replies than lark-cli lists (50)`);
  const state: ChatCursor = { ...(cursor ? { cursor } : {}), from, ...(more ? { more: true } : {}), ...(name ? { name } : {}), ...(kind ? { kind } : {}), ...(nameAt ? { nameAt } : {}) };
  return { items, state, more, notes };
}

async function pullFeishuChat(ctx: ConnectorContext): Promise<PullResult> {
  const chats = chatIdsOf(ctx.feed.params);
  if (!chats.length) throw new Error('params.chatId (an oc_… chat id) or params.chatIds is required');
  const opts = optionsOf(ctx.feed.params);
  const { run } = larkFor(ctx);
  const prev = readState(ctx.state);
  const next: FeishuChatState = { chats: { ...prev.chats } };
  const items: FeedItem[] = [];
  const notes: string[] = [];
  const errors: Error[] = [];
  let done = 0;
  let more = false;
  for (const chatId of chats) {
    if (ctx.signal.aborted) {
      errors.push(new Error('stopped before every chat was read'));
      break;
    }
    try {
      const got = await pullChat(ctx, run, chatId, prev.chats[chatId] ?? {}, opts);
      items.push(...got.items);
      notes.push(...got.notes);
      next.chats[chatId] = got.state;
      more ||= got.more;
      done++;
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
  }
  // nothing read: fail the pull, so the cursors stay where they were
  if (!done && errors.length) throw errors[0];
  // some chats read: theirs is kept and their cursors move; the others are tried again next time
  return { items, state: next, more, notes, ...(errors.length ? { error: errors.map((e) => e.message).join('; ') } : {}) };
}

/* -------------------------------- download ------------------------------- */

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain', '.md': 'text/markdown', '.html': 'text/html', '.epub': 'application/epub+zip',
};

/** The extension a file's first bytes say it has, for when Feishu named no type. */
function sniffExt(file: string): string | null {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(12);
    fs.readSync(fd, b, 0, 12, 0);
    if (b[0] === 0xff && b[1] === 0xd8) return '.jpg';
    if (b.subarray(0, 4).toString('hex') === '89504e47') return '.png';
    if (b.subarray(0, 3).toString('latin1') === 'GIF') return '.gif';
    if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
    if (b.subarray(0, 4).toString('latin1') === '%PDF') return '.pdf';
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export function parseResourceRef(url: string | undefined): { type: 'image' | 'file'; messageId: string; key: string } | null {
  const m = /^feishu:(image|file):(om_[\w-]+):([\w-]+)$/.exec(url ?? '');
  return m ? { type: m[1] as 'image' | 'file', messageId: m[2], key: m[3] } : null;
}

/**
 * Pictures always; a file only when it is one the Convert stage reads and no
 * larger than the feed's attachment limit (Feishu tells its size only once it
 * is downloaded). Voice and video are left: they become no text.
 */
async function downloadFeishuResource(ctx: ConnectorContext, _item: FeedItem, att: FeedAttachment, destBase: string): Promise<{ path: string; mime?: string; bytes: number } | null> {
  const ref = parseResourceRef(att.url);
  if (!ref) return null;
  if (ref.type === 'file' && att.kind !== 'file') return null;
  if (ref.type === 'file' && att.name && path.extname(att.name) && !isConvertibleFile(att.name)) return null;
  const dir = path.dirname(destBase);
  fs.mkdirSync(dir, { recursive: true });
  const { run } = larkFor(ctx);
  // lark-cli writes only under its working directory (or /tmp, ~/files): run it there and give it a bare name;
  // it adds the extension the content type or file name says
  const args = ['im', '+messages-resources-download', '--message-id', ref.messageId, '--file-key', ref.key, '--type', ref.type, '--output', path.basename(destBase), '--as', 'user', '--format', 'json'];
  const env = await callLark(run, args, `download ${att.kind} ${ref.key}`, 600_000, dir);
  const data = obj(env.data);
  let saved = str(data.saved_path) ? path.resolve(dir, str(data.saved_path)) : '';
  if (!saved || !fs.existsSync(saved)) throw new FeishuError(`download ${ref.key}: lark-cli saved nothing`, 'other');
  if (!path.extname(saved)) {
    const ext = sniffExt(saved) ?? (att.name ? path.extname(att.name) : '');
    if (ext) {
      fs.renameSync(saved, `${saved}${ext}`);
      saved = `${saved}${ext}`;
    }
  }
  const bytes = fs.statSync(saved).size;
  const maxBytes = ctx.feed.attachments?.maxBytes ?? 20 * 1024 * 1024;
  if (bytes > maxBytes || (ref.type === 'file' && !isConvertibleFile(saved))) {
    fs.rmSync(saved, { force: true });
    return null;
  }
  const mime = MIME_BY_EXT[path.extname(saved).toLowerCase()];
  return { path: saved, bytes, ...(mime ? { mime } : {}) };
}

/* --------------------------------- check --------------------------------- */

async function checkFeishuChat(ctx: ConnectorContext): Promise<{ ok: boolean; message: string }> {
  const chats = chatIdsOf(ctx.feed.params);
  if (!chats.length) return { ok: false, message: 'params.chatId (an oc_… chat id) or params.chatIds is required' };
  const { cli, run } = larkFor(ctx);
  const status = await new LarkCli({ cli, runner: run }).status();
  const grant = `lark-cli auth login --scope "${FEISHU_CHAT_SCOPES.join(' ')}"`;
  if (!status.installed) return { ok: false, message: `lark-cli is not installed (${status.error ?? cli}) — install it (https://github.com/larksuite/cli), or set ingest.feishu.cli or params.cli to where it is` };
  if (!status.signedIn) return { ok: false, message: `no Feishu user is signed in to lark-cli (${status.error ?? 'not signed in'}) — run \`knode-os feishu login\`, then grant the chat scopes once with \`${grant}\`` };
  const lines: string[] = [];
  try {
    for (const chatId of chats) {
      // the same command a pull runs, one message long: lark-cli checks the scopes it needs before sending it
      const env = await callLark(run, ['im', '+chat-messages-list', '--chat-id', chatId, '--as', 'user', '--order', 'desc', '--page-size', '1', '--format', 'json'], `read Feishu chat ${chatId}`, 120_000);
      const latest = parseLarkTime(messagesOf(env)[0]?.create_time);
      const info = await chatInfo(run, chatId).catch(() => null);
      lines.push(`${info?.name ? `${info.name} (${chatId})` : chatId}: readable${latest ? `, latest message ${new Date(latest.ms).toISOString()}` : ', no messages yet'}`);
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  const missing = status.scopes.length ? missingChatScopes(status.scopes) : [];
  if (missing.includes('im:chat:read')) lines.push('chat names need im:chat:read, so ids are shown instead — grant it with `lark-cli auth login --scope "im:chat:read"`');
  return { ok: true, message: `as ${status.user?.name || 'the signed-in user'}: ${lines.join('; ')}` };
}

/* ------------------------------- connector ------------------------------- */

export const feishuChatConnector: FeedConnector = {
  id: 'feishu-chat',
  label: 'Feishu group chat',
  note: 'Messages of Feishu (Lark) group chats the signed-in user is in, read through lark-cli as that user; edits, recalls and late thread replies of the last days are picked up by reading them again.',
  platform: 'feishu',
  params: [
    { name: 'chatId', label: 'Chat id (oc_…); required unless chatIds is set', type: 'string', example: 'oc_5c14a0b2e1f3d4c5b6a7980112233445', note: 'lark-cli im +chat-search --query "<name>" finds it' },
    { name: 'chatIds', label: 'More chat ids (several chats in one feed)', type: 'string[]' },
    { name: 'lookbackDays', label: 'Days read again before the cursor, for edits, recalls and late replies (default 2)', type: 'number' },
    { name: 'maxPages', label: 'Pages of 50 messages per chat per pull (default 20)', type: 'number' },
    { name: 'relay', label: 'Relay group: a bot reposts other platforms\' posts — each post\'s author and origin come from its "@ account link" signature, its picture joins its text, and a leading original time is read (default false)', type: 'boolean' },
    { name: 'relayTimestamps', label: "Relay group: a first line like 2026-09-30 10:46:51 is the original post's time (default false)", type: 'boolean' },
    { name: 'cli', label: 'lark-cli path (default ingest.feishu.cli, else the one on PATH)', type: 'string' },
  ],
  defaults: { units: { by: 'window', gapMinutes: 30 }, render: { period: 'day' }, schedule: { every: '30m' }, backfillDays: 3, platform: 'feishu' },
  minIntervalMinutes: 5,
  check: checkFeishuChat,
  pull: pullFeishuChat,
  download: downloadFeishuResource,
};
