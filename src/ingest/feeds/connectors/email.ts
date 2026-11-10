import type { ConnectorContext, FeedAttachment, FeedConnector, FeedItem, PullResult } from '../types.js';
import { FetchedMessage, ImapClient } from './imap.js';
import { MailAddress, parseAddresses, parseMail, parseMailDate, ParsedMail } from './mime.js';

/**
 * Email over IMAP — any mailbox a mail client can read: Gmail, Outlook.com and
 * Microsoft 365 (with an app password or an OAuth token), iCloud, Fastmail,
 * QQ Mail, NetEase 163/126, a company's Dovecot or Exchange, and through a
 * local bridge (DavMail, Proton Mail Bridge) the ones that speak no IMAP.
 *
 * Read-only by construction: mailboxes are opened with EXAMINE and bodies
 * fetched with BODY.PEEK, so nothing is marked read, moved or deleted.
 *
 * The cursor is, per mailbox, the UIDVALIDITY it was read under and the
 * highest UID taken. The first pull searches by date (the feed's backfill);
 * later ones ask only for UIDs above the cursor. A server that renumbered a
 * mailbox (a new UIDVALIDITY) makes its UIDs meaningless, so that mailbox is
 * read again from the backfill horizon; the ledger recognizes the messages it
 * already holds by Message-ID.
 */

interface MailboxCursor {
  uidValidity: number;
  /** The highest UID taken (or known to hold nothing new). */
  lastUid: number;
}

interface EmailState {
  mailboxes: Record<string, MailboxCursor>;
}

interface EmailParams {
  host: string;
  port: number;
  tls: boolean;
  user: string;
  password: string;
  accessToken: string;
  mailboxes: string[];
  maxPerPull: number;
  stripQuotes: boolean;
}

/** Messages per UID FETCH: few enough round trips, small enough answers. */
const BATCH = 50;
/**
 * Bytes fetched of one message at most. The text of a mail comes before its
 * attachments, so a 40 MB mail costs 10 MB and still yields its body; the
 * attachments cut off are listed as far as they arrived.
 */
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** IMAP's date for SEARCH SINCE: 09-Nov-2026 (the server compares it with its own day, so a day of slack is kept upstream). */
export function imapDate(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

const flag = (v: unknown, dflt: boolean) => (v === undefined || v === null || v === '' ? dflt : !(v === false || v === 'false' || v === 0 || v === '0'));

function readParams(ctx: ConnectorContext): EmailParams {
  const p = ctx.feed.params;
  const host = typeof p.host === 'string' ? p.host.trim() : '';
  if (!host) throw new Error('params.host is required');
  const user = typeof p.user === 'string' ? p.user.trim() : '';
  if (!user) throw new Error('params.user is required');
  const tls = flag(p.tls, true);
  const password = ctx.secret(p.password);
  const accessToken = ctx.secret(p.accessToken);
  if (!password && !accessToken) throw new Error('params.password (or params.accessToken for OAuth) is required');
  const listed = Array.isArray(p.mailboxes) ? p.mailboxes : typeof p.mailboxes === 'string' ? p.mailboxes.split(',') : [];
  const mailboxes = [...new Set(listed.map((m) => String(m).trim()).filter(Boolean))];
  return {
    host,
    port: Number(p.port) || (tls ? 993 : 143),
    tls,
    user,
    password,
    accessToken,
    mailboxes: mailboxes.length ? mailboxes : ['INBOX'],
    maxPerPull: Math.max(1, Math.floor(Number(p.maxPerPull) || 200)),
    stripQuotes: flag(p.stripQuotes, true),
  };
}

async function signIn(ctx: ConnectorContext, params: EmailParams): Promise<ImapClient> {
  const client = await ImapClient.connect({ host: params.host, port: params.port, tls: params.tls, signal: ctx.signal, timeoutMs: TIMEOUT_MS });
  try {
    if (!client.preauthenticated) {
      // an OAuth token, when given, is what the account expects (Gmail and Microsoft refuse plain passwords without an app password)
      if (params.accessToken) await client.authenticateXOAuth2(params.user, params.accessToken);
      else await client.login(params.user, params.password);
    }
  } catch (err) {
    client.close();
    throw err;
  }
  return client;
}

/* ----------------------------- quote stripping ---------------------------- */

/** "-----Original Message-----", "------------------ 原始邮件 ------------------". */
const ORIGINAL_MESSAGE = /^\s*-{2,}\s*(Original Message|原始邮件|原始郵件|Ursprüngliche Nachricht|Message d'origine|Mensaje original)\s*-{2,}\s*$/i;
/** The header block Outlook, QQ Mail, Foxmail and NetEase put above the message replied to. */
const HEADER_START = /^\s*\**(From|发件人|發件人|寄件者)\**\s*[:：]\s*\S/;
const HEADER_NEXT = /^\s*\**(Sent|Date|To|Subject|Cc|发送时间|發送時間|时间|時間|日期|收件人|收件者|抄送|主题|主題|主旨)\**\s*[:：]/;
/** "On Mon, 9 Nov 2026 at 10:00, Ann <ann@example.com> wrote:", "在 2026年11月9日 10:00，Ann 写道：", "Ann 于2026年11月9日周一 10:00写道：". */
const ATTRIBUTION = [/^\s*(On|At)\s.+\s(wrote|writes):\s*$/i, /^.{0,300}(写道|寫道)\s*[：:]\s*$/];
/** Real attributions carry an address or a date; prose ending in "wrote:" does not. */
const LOOKS_LIKE_ATTRIBUTION = /@|\d{1,4}\s*[-/年.:,]\s*\d/;

/** A forwarded message's banner: the header block under it is the forward, not an earlier message. */
const FORWARD_BANNER = /Forwarded message|Begin forwarded message|转发的邮件|转发邮件|轉寄的郵件|Weitergeleitete Nachricht/i;

const isAttribution = (line: string) => ATTRIBUTION.some((re) => re.test(line));

const quotedLine = (l: string) => /^\s*>/.test(l);
const blankLine = (l: string) => !l.trim();
/** A line a person wrote: not blank, not quoted, not a separator rule, not an attribution. */
const ownLine = (l: string) => !blankLine(l) && !quotedLine(l) && !/^[\s_\-=*~]*$/.test(l) && !isAttribution(l);

/** Lines the attribution starting at i spans (a long one wraps), or 0. */
function attributionAt(lines: string[], i: number, end: number): number {
  if (isAttribution(lines[i])) return 1;
  if (i + 1 < end && /^\s*(On|At)\s/i.test(lines[i]) && isAttribution(`${lines[i]} ${lines[i + 1]}`)) return 2;
  return 0;
}

/**
 * A plain-text reply without the earlier message it carries, so a thread
 * does not repeat itself in its document. Cut are:
 *  - from a top-posting separator ("-----Original Message-----", a
 *    "From:/发件人:" header block) on — not in a forward, where what follows
 *    is the point of the mail;
 *  - from "On … wrote:" / "…写道：" on, when what follows is all quoted or not
 *    quoted at all — text between quoted lines is an inline reply, and kept;
 *  - a trailing block of "> " lines, with its attribution.
 * Nothing is cut when it would leave the mail empty.
 */
export function stripQuotedText(text: string, opts: { forward?: boolean } = {}): { text: string; stripped: boolean } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let end = lines.length;
  const wroteBefore = (i: number) => lines.slice(0, i).some(ownLine);

  if (!opts.forward) {
    for (let i = 1; i < end; i++) {
      const sep =
        ORIGINAL_MESSAGE.test(lines[i]) ||
        (HEADER_START.test(lines[i]) && lines.slice(i + 1, i + 6).some((l) => HEADER_NEXT.test(l)) && !lines.slice(Math.max(0, i - 3), i).some((l) => FORWARD_BANNER.test(l)));
      if (sep && wroteBefore(i)) {
        end = i;
        break;
      }
    }
  }

  for (let i = 1; i < end; i++) {
    const span = attributionAt(lines, i, end);
    if (!span || !wroteBefore(i)) continue;
    const after = lines.slice(i + span, end).filter((l) => !blankLine(l));
    const quoted = after.filter(quotedLine).length;
    const attribution = lines.slice(i, i + span).join(' ');
    if (quoted === after.length || (quoted === 0 && LOOKS_LIKE_ATTRIBUTION.test(attribution))) {
      end = i;
      break;
    }
  }

  let j = end;
  while (j > 0 && (blankLine(lines[j - 1]) || quotedLine(lines[j - 1]))) j--;
  if (j < end && lines.slice(j, end).some(quotedLine) && wroteBefore(j)) {
    end = j;
    let k = end;
    while (k > 0 && blankLine(lines[k - 1])) k--;
    if (k >= 1 && isAttribution(lines[k - 1]) && wroteBefore(k - 1)) end = k - 1;
    else if (k >= 2 && /^\s*(On|At)\s/i.test(lines[k - 2]) && isAttribution(`${lines[k - 2]} ${lines[k - 1]}`) && wroteBefore(k - 2)) end = k - 2;
  }

  if (end === lines.length) return { text, stripped: false };
  // the rule or blank lines a client put above what was cut
  while (end > 0 && /^[\s_\-=*~]*$/.test(lines[end - 1])) end--;
  const out = lines.slice(0, end).join('\n').trimEnd();
  return out.trim() ? { text: out, stripped: true } : { text, stripped: false };
}

/** Where the element opened at `start` closes (just after its end tag), or the end of the document. */
function closeOf(html: string, start: number, tag: string): number {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1]) {
      depth--;
      if (depth <= 0) return m.index + m[0].length;
    } else if (!m[0].endsWith('/>')) depth++;
  }
  return html.length;
}

/** The document without the `tag` elements whose opening tag matches `attr`. */
function removeElements(html: string, tag: string, attr?: RegExp): string {
  const open = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  let out = '';
  let pos = 0;
  for (let m = open.exec(html); m; m = open.exec(html)) {
    if (m.index < pos || (attr && !attr.test(m[0]))) continue;
    const end = closeOf(html, m.index, tag);
    out += html.slice(pos, m.index);
    pos = end;
    open.lastIndex = end;
  }
  return out + html.slice(pos);
}

/** Does this HTML show anything: text, or a picture? */
function visible(html: string): boolean {
  if (/<img\b/i.test(html)) return true;
  const text = html.replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;|&#xa0;/gi, ' ');
  return /\S/.test(text);
}

/**
 * An HTML reply without the earlier message — conservatively, because HTML
 * mail varies more than its plain-text twin (which is what a reply is
 * usually read from: see bodyOf). Only the three shapes that are reliable
 * are cut, and only when the quote is the last thing in the mail and
 * something was written above it:
 *  - Gmail's quote container (div.gmail_quote), unless it holds a forward or
 *    text outside its blockquotes (an inline reply);
 *  - Apple Mail's and Thunderbird's <blockquote type="cite">, with
 *    Thunderbird's moz-cite-prefix or the "On … wrote:" line above it.
 * Outlook's HTML (div#divRplyFwdMsg and friends) looks the same for a reply
 * and a forward and is left alone; Outlook always sends the plain part too.
 */
export function stripQuotedHtml(html: string, opts: { forward?: boolean } = {}): string {
  if (opts.forward) return html;
  const gmail = /<div\b[^>]*class\s*=\s*["'][^"']*\bgmail_quote\b[^"']*["'][^>]*>/i.exec(html);
  if (gmail) {
    const close = closeOf(html, gmail.index, 'div');
    const inner = html.slice(gmail.index + gmail[0].length, close);
    const forwarded = /Forwarded message|转发的邮件|轉寄的郵件|已转发邮件/i.test(inner.slice(0, 2000));
    const outside = removeElements(removeElements(inner, 'blockquote'), 'div', /gmail_attr/i);
    if (forwarded || visible(outside) || visible(html.slice(close)) || !visible(html.slice(0, gmail.index))) return html;
    return html.slice(0, gmail.index) + html.slice(close);
  }
  const cite = /<blockquote\b[^>]*\btype\s*=\s*["']?cite\b[^>]*>/i.exec(html);
  if (cite) {
    const close = closeOf(html, cite.index, 'blockquote');
    if (visible(html.slice(close))) return html;
    let start = cite.index;
    const prefix = /<div\b[^>]*class\s*=\s*["'][^"']*\bmoz-cite-prefix\b[^"']*["'][^>]*>/gi;
    for (let m = prefix.exec(html); m && m.index < start; m = prefix.exec(html)) {
      if (!visible(html.slice(closeOf(html, m.index, 'div'), start))) start = m.index;
    }
    let kept = html.slice(0, start);
    // Apple Mail writes "On … wrote:" in its own line just above the quote
    const attribution = /(?:<(?:div|p)\b[^>]*>|<br\s*\/?>)(?:(?!<(?:div|p)\b|<br)[\s\S])*?(?:wrote:|写道[：:]|寫道[：:])(?:\s|<[^>]*>|&nbsp;)*$/i.exec(kept);
    if (attribution) kept = kept.slice(0, attribution.index);
    if (!visible(kept)) return html;
    return kept + html.slice(close);
  }
  return html;
}

/* --------------------------------- items --------------------------------- */

const FORWARD = /^\s*(fwd?|fw|转发|轉寄|转寄)\s*[:：]/i;

/**
 * The body an item carries. HTML when there is an HTML part, plain text
 * otherwise — except a reply whose plain part had a quote to strip: its
 * stripped plain text is used, because the HTML twin would repeat the thread
 * and cutting HTML is less certain.
 */
function bodyOf(mail: ParsedMail, stripQuotes: boolean): { text?: string; html?: string; format?: 'text'; stripped?: boolean } {
  const forward = FORWARD.test(mail.subject);
  if (stripQuotes && mail.text) {
    const s = stripQuotedText(mail.text, { forward });
    if (s.stripped) return { text: s.text, format: 'text', stripped: true };
  }
  if (mail.html) {
    if (!stripQuotes) return { html: mail.html };
    const html = stripQuotedHtml(mail.html, { forward });
    return { html, ...(html !== mail.html ? { stripped: true } : {}) };
  }
  if (mail.text) return { text: mail.text, format: 'text' };
  return {};
}

/** Sent by a machine: a list, a bulk sender, an auto-reply, a no-reply address, a bounce. */
function isAutomated(mail: ParsedMail, from: MailAddress | undefined): boolean {
  const h = (name: string) => (mail.headers[name]?.[0] ?? '').trim().toLowerCase();
  if (mail.headers['list-id'] || mail.headers['list-unsubscribe']) return true;
  if (/^(bulk|list|junk)$/.test(h('precedence'))) return true;
  const auto = h('auto-submitted');
  if (auto && auto !== 'no') return true;
  if (h('return-path') === '<>') return true;
  const local = (from?.address ?? '').split('@')[0];
  return /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|mailer-daemon|postmaster)(?![a-z0-9])/i.test(local);
}

const attachmentKind = (mime: string): FeedAttachment['kind'] => (mime.startsWith('image/') ? 'image' : 'file');

/** One fetched message as a feed item. */
export function mailItem(msg: FetchedMessage, mailbox: string, uidValidity: number, opts: { stripQuotes: boolean }): FeedItem {
  const mail = parseMail(msg.body);
  const received = parseMailDate(msg.internalDate);
  // a Date header well after the server received the mail (a wrong clock, spam) is not believed
  const date = mail.date && !(received && mail.date.getTime() > received.getTime() + 86_400_000) ? mail.date : received;
  const from = mail.from[0] ?? parseAddresses(mail.rawHeaders.sender?.[0])[0];
  const body = bodyOf(mail, opts.stripQuotes);
  // replies share their root's Message-ID (the first in References) and Gmail's thread id; a root carries its own,
  // so it lands in the same unit as its replies
  const threadId = msg.gmThreadId ?? mail.references[0] ?? mail.inReplyTo ?? mail.messageId;
  const listId = mail.headers['list-id']?.[0];
  const attachments: FeedAttachment[] = mail.attachments
    .filter((a) => !a.inline)
    .map((a) => ({ kind: attachmentKind(a.mime), name: a.filename ?? a.mime, mime: a.mime, bytes: a.size }));
  const truncated = msg.size !== undefined && msg.size > msg.body.length;
  return {
    id: mail.messageId ?? `${mailbox}:${uidValidity}:${msg.uid}`,
    ...(mail.subject ? { title: mail.subject } : {}),
    ...(from ? { author: { name: from.name || from.address, ...(from.address ? { id: from.address } : {}) } } : {}),
    channel: { id: mailbox, name: mailbox, kind: 'mailbox' },
    publishedAt: date ? date.toISOString() : '',
    ...(body.html !== undefined ? { html: body.html } : {}),
    ...(body.text !== undefined ? { text: body.text, format: body.format } : {}),
    ...(threadId ? { threadId } : {}),
    ...(mail.inReplyTo ? { replyTo: mail.inReplyTo } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(mail.messageId ? { dedupeKey: `email:${mail.messageId}` } : {}),
    meta: {
      to: mail.to.map((a) => a.address).filter(Boolean),
      cc: mail.cc.map((a) => a.address).filter(Boolean),
      ...(listId ? { listId: /<([^<>]+)>/.exec(listId)?.[1] ?? listId } : {}),
      uid: msg.uid,
      mailbox,
      automated: isAutomated(mail, from),
      ...(body.stripped ? { quoteStripped: true } : {}),
      ...(truncated ? { truncated: true } : {}),
    },
  };
}

/* ---------------------------------- pull --------------------------------- */

function stateOf(value: unknown): EmailState {
  const boxes = (value as EmailState | undefined)?.mailboxes;
  const out: EmailState = { mailboxes: {} };
  if (boxes && typeof boxes === 'object') {
    for (const [name, c] of Object.entries(boxes)) {
      if (c && Number.isFinite(c.uidValidity) && Number.isFinite(c.lastUid)) out.mailboxes[name] = { uidValidity: c.uidValidity, lastUid: c.lastUid };
    }
  }
  return out;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface MailboxPull {
  taken: number;
  /** UIDs found but left for the next pull. */
  left: number;
}

async function pullMailbox(
  ctx: ConnectorContext,
  client: ImapClient,
  mailbox: string,
  prev: MailboxCursor | undefined,
  budget: number,
  params: EmailParams,
  next: EmailState,
  add: (item: FeedItem) => void,
  notes: string[],
): Promise<MailboxPull> {
  const box = await client.examine(mailbox);
  let cursor = prev && prev.uidValidity === box.uidValidity ? prev : undefined;
  let uids: number[];
  if (!cursor) {
    const since = ctx.since ?? new Date(Date.now() - 7 * 86_400_000);
    if (prev) {
      notes.push(`${mailbox}: the server renumbered the mailbox (UIDVALIDITY ${prev.uidValidity} → ${box.uidValidity}); reading it again from ${imapDate(since)}`);
      ctx.log(notes[notes.length - 1]);
    }
    uids = box.exists ? await client.uidSearch(`SINCE ${imapDate(since)}`) : [];
    cursor = { uidValidity: box.uidValidity, lastUid: 0 };
  } else if (!box.exists || (box.uidNext !== undefined && box.uidNext <= cursor.lastUid + 1)) {
    uids = [];
  } else {
    const after = cursor.lastUid;
    // "n:*" also matches the highest UID when it is below n, so what is not above the cursor is dropped
    uids = (await client.uidSearch(`UID ${after + 1}:*`)).filter((u) => u > after);
  }
  const take = uids.slice(0, budget);
  let lastUid = cursor.lastUid;
  next.mailboxes[mailbox] = { uidValidity: box.uidValidity, lastUid };
  for (let i = 0; i < take.length; i += BATCH) {
    const batch = take.slice(i, i + BATCH);
    await client.fetchMessages(
      batch,
      (msg) => {
        try {
          add(mailItem(msg, mailbox, box.uidValidity, { stripQuotes: params.stripQuotes }));
        } catch (err) {
          notes.push(`${mailbox} UID ${msg.uid}: could not be read: ${messageOf(err)}`);
        }
      },
      { maxBytes: MAX_MESSAGE_BYTES },
    );
    // the cursor moves batch by batch, so a pull that stops part way keeps what it took
    lastUid = Math.max(lastUid, batch[batch.length - 1]);
    next.mailboxes[mailbox] = { uidValidity: box.uidValidity, lastUid };
  }
  const left = uids.length - take.length;
  // everything below UIDNEXT has been seen: later pulls can skip the search while nothing arrives
  if (!left && box.uidNext !== undefined) next.mailboxes[mailbox] = { uidValidity: box.uidValidity, lastUid: Math.max(lastUid, box.uidNext - 1) };
  if (take.length || left) notes.push(`${mailbox}: ${take.length} message(s)${left ? `, ${left} more waiting` : ''}`);
  return { taken: take.length, left };
}

async function pullEmail(ctx: ConnectorContext): Promise<PullResult> {
  const params = readParams(ctx);
  const prev = stateOf(ctx.state);
  const next: EmailState = { mailboxes: {} };
  for (const m of params.mailboxes) if (prev.mailboxes[m]) next.mailboxes[m] = prev.mailboxes[m];
  // one message filed in two mailboxes (INBOX and a label, a copy in Sent) is one item
  const items = new Map<string, FeedItem>();
  const add = (item: FeedItem) => {
    if (!items.has(item.id)) items.set(item.id, item);
  };
  const notes: string[] = [];
  const errors: string[] = [];
  let budget = params.maxPerPull;
  let more = false;
  const client = await signIn(ctx, params);
  try {
    for (const mailbox of params.mailboxes) {
      if (budget <= 0) {
        more = true;
        break;
      }
      try {
        const got = await pullMailbox(ctx, client, mailbox, prev.mailboxes[mailbox], budget, params, next, add, notes);
        budget -= got.taken;
        if (got.left) more = true;
      } catch (err) {
        // one mailbox failing (renamed, not subscribed) does not lose the others; a dead connection ends the pull
        errors.push(`${mailbox}: ${messageOf(err)}`);
        if (client.isClosed) break;
      }
    }
  } finally {
    await client.logout();
  }
  return { items: [...items.values()], state: next, more, notes, ...(errors.length ? { error: errors.join('; ') } : {}) };
}

export const emailConnector: FeedConnector = {
  id: 'email',
  label: 'Email (IMAP)',
  note: 'A mailbox over IMAP — Gmail, Outlook / Microsoft 365, iCloud, QQ Mail, NetEase 163, Fastmail, a company server, or a local bridge (DavMail, Proton Mail Bridge). Signs in with a password or app password, or an OAuth access token (XOAUTH2); reads without marking anything read.',
  platform: 'email',
  params: [
    { name: 'host', label: 'IMAP server', type: 'string', required: true, example: 'imap.gmail.com' },
    { name: 'port', label: 'Port (default 993, or 143 without TLS)', type: 'number' },
    { name: 'tls', label: 'TLS (default true; false for a plain local bridge, upgraded with STARTTLS when the server asks)', type: 'boolean' },
    { name: 'user', label: 'User name (usually the address)', type: 'string', required: true, example: 'me@example.com' },
    { name: 'password', label: 'Password or app password', type: 'secret', note: '"env:VAR" reads it from the environment. Not needed with an access token.', example: 'env:MAIL_PASSWORD' },
    { name: 'accessToken', label: 'OAuth access token (XOAUTH2, instead of a password)', type: 'secret', note: '"env:VAR" allowed. Access tokens expire within hours; keep the variable refreshed.' },
    { name: 'mailboxes', label: 'Mailboxes (default ["INBOX"])', type: 'string[]', example: ['INBOX', '[Gmail]/Sent Mail'] },
    { name: 'maxPerPull', label: 'Messages fetched per pull (default 200; more follow in the next pull)', type: 'number' },
    { name: 'stripQuotes', label: 'Drop the quoted earlier message from replies (default true)', type: 'boolean' },
  ],
  defaults: { units: { by: 'thread' }, render: { period: 'item' }, schedule: { every: '15m' }, backfillDays: 14, platform: 'email' },
  minIntervalMinutes: 2,
  async check(ctx) {
    try {
      const params = readParams(ctx);
      const client = await signIn(ctx, params);
      try {
        const box = await client.examine(params.mailboxes[0]);
        return { ok: true, message: `${params.user} on ${params.host}: ${box.name} holds ${box.exists} message(s)` };
      } finally {
        await client.logout();
      }
    } catch (err) {
      return { ok: false, message: messageOf(err) };
    }
  },
  pull: pullEmail,
};
