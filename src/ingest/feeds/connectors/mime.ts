/**
 * Internet mail (RFC 5322) and MIME (RFC 2045–2047, 2231, 3676) — just enough
 * to turn a fetched message into what a feed keeps: its headers, its plain
 * and HTML bodies, and the names and sizes of what it carries.
 *
 * A message is handled as a "binary string" (latin1: one character per byte)
 * until a part's charset is known. Splitting on boundaries and undoing the
 * transfer encoding then never cuts a multibyte character, and a part's bytes
 * come back exactly with Buffer.from(s, 'latin1').
 *
 * It is forgiving where real mail is sloppy: raw UTF-8 or GBK in headers,
 * encoded words inside quoted filenames, a missing closing boundary (also what
 * a message cut short by a partial fetch looks like), unknown charsets.
 */

export interface MailAddress {
  /** Display name, decoded; '' when the address came alone. */
  name: string;
  /** Lower-cased; '' for a group or a name without an address. */
  address: string;
}

export interface MimeAttachment {
  filename?: string;
  /** Lower-cased media type: application/pdf, image/png, message/rfc822. */
  mime: string;
  /** Decoded size in bytes. */
  size: number;
  contentId?: string;
  /**
   * A picture the HTML body shows by its Content-ID (a logo, a signature
   * picture) rather than something sent along: part of the body's look.
   */
  inline: boolean;
}

export interface ParsedMail {
  /** Header fields of the message by lower-case name, in order: unfolded, encoded words decoded. */
  headers: Record<string, string[]>;
  /** The same, as written (unfolded only): what addresses and parameters are parsed from. */
  rawHeaders: Record<string, string[]>;
  subject: string;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  /** The Date header, or null when absent or unreadable. */
  date: Date | null;
  /** Without the angle brackets. */
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  /** The text/plain body parts, joined. */
  text?: string;
  /** The text/html body parts, joined. */
  html?: string;
  attachments: MimeAttachment[];
}

/* -------------------------------- charsets ------------------------------- */

/**
 * Labels mail uses that the WHATWG list TextDecoder follows does not know, or
 * maps somewhere less useful. GB2312 and GBK mail routinely holds characters
 * only GB18030 has, so all three decode as GB18030. US-ASCII decodes as UTF-8:
 * real ASCII is the same either way, and a mislabelled UTF-8 body (common)
 * comes out right instead of as windows-1252 mojibake.
 */
const CHARSET_ALIASES: Record<string, string> = {
  gb2312: 'gb18030', gbk: 'gb18030', 'x-gbk': 'gb18030', cp936: 'gb18030', ms936: 'gb18030', 'windows-936': 'gb18030',
  'euc-cn': 'gb18030', 'x-euc-cn': 'gb18030', csgb2312: 'gb18030', 'gb_2312-80': 'gb18030', chinese: 'gb18030',
  'big5-hkscs': 'big5', cp950: 'big5', 'x-x-big5': 'big5',
  cp949: 'euc-kr', sjis: 'shift_jis', 'x-sjis': 'shift_jis', cp932: 'shift_jis', ms932: 'shift_jis',
  'us-ascii': 'utf-8', ascii: 'utf-8', 'ansi_x3.4-1968': 'utf-8', utf8: 'utf-8', unknown: 'utf-8', 'x-unknown': 'utf-8',
  'unknown-8bit': 'windows-1252', 'x-user-defined': 'windows-1252',
};

const decoders = new Map<string, TextDecoder | null>();

function decoderFor(charset: string | undefined, fatal: boolean): TextDecoder | null {
  let label = (charset ?? '').trim().replace(/^["']|["']$/g, '').toLowerCase() || 'utf-8';
  label = CHARSET_ALIASES[label] ?? label;
  const key = `${label}\0${fatal}`;
  if (!decoders.has(key)) {
    try {
      decoders.set(key, new TextDecoder(label, { fatal }));
    } catch {
      decoders.set(key, null);
    }
  }
  return decoders.get(key) ?? null;
}

/** Bytes in a charset, as text; an unknown charset reads as UTF-8. */
export function decodeCharset(bytes: Uint8Array, charset?: string): string {
  const d = decoderFor(charset, false) ?? decoderFor('utf-8', false)!;
  return d.decode(bytes);
}

/** As decodeCharset, but null when the bytes are not valid in that charset. */
function tryDecode(bytes: Uint8Array, charset: string): string | null {
  const d = decoderFor(charset, true);
  if (!d) return null;
  try {
    return d.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Text whose charset was not declared: UTF-8 when it is valid UTF-8, else
 * GB18030 when that reads it (undeclared 8-bit mail comes mostly from East
 * Asian clients), else windows-1252, which reads anything.
 */
function decodeUndeclared(bytes: Uint8Array): string {
  return tryDecode(bytes, 'utf-8') ?? tryDecode(bytes, 'gb18030') ?? decodeCharset(bytes, 'windows-1252');
}

const toBytes = (bin: string) => Buffer.from(bin, 'latin1');

/* ---------------------------- transfer encodings ------------------------- */

/** Quoted-printable (RFC 2045 §6.7) to bytes; a stray '=' is kept as written. */
export function decodeQuotedPrintable(bin: string): Buffer {
  const out = Buffer.alloc(bin.length);
  let n = 0;
  for (let i = 0; i < bin.length; i++) {
    const c = bin.charCodeAt(i);
    if (c === 0x3d) {
      const hex = bin.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out[n++] = parseInt(hex, 16);
        i += 2;
        continue;
      }
      // a soft line break: '=' at the end of a line, maybe with trailing blanks a relay added
      const soft = /^[ \t]*\r?\n/.exec(bin.slice(i + 1, i + 64));
      if (soft) {
        i += soft[0].length;
        continue;
      }
      if (i === bin.length - 1) continue;
    }
    out[n++] = c & 0xff;
  }
  return out.subarray(0, n);
}

function decodeBase64(bin: string): Buffer {
  return Buffer.from(bin.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
}

function decodeTransfer(bin: string, encoding: string): Buffer {
  if (encoding === 'base64') return decodeBase64(bin);
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(bin);
  return toBytes(bin);
}

/** A part's decoded size without decoding it: attachments can be large and their bytes are not kept. */
function transferSize(bin: string, encoding: string): number {
  if (encoding === 'base64') {
    const clean = bin.replace(/[^A-Za-z0-9+/=]/g, '');
    const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((clean.length * 3) / 4) - pad);
  }
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(bin).length;
  return bin.length;
}

/* -------------------------------- headers -------------------------------- */

/** "Q" encoding of an encoded word: '_' is a space, =XX a byte. */
function decodeQ(text: string): Buffer {
  return decodeQuotedPrintable(text.replace(/_/g, ' '));
}

/**
 * RFC 2047 encoded words (=?charset?B|Q?…?=) in a header value. Whitespace
 * between two encoded words is not part of the text. Adjacent words in one
 * charset are joined as bytes before decoding, because senders split a long
 * subject wherever the line ran out, often in the middle of a character.
 */
export function decodeWords(value: string): string {
  const re = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;
  let out = '';
  let last = 0;
  // the run of adjacent encoded words not yet decoded
  let charset = '';
  let bytes: Buffer[] = [];
  const flush = () => {
    if (bytes.length) out += decodeCharset(Buffer.concat(bytes), charset);
    bytes = [];
  };
  for (const m of value.matchAll(re)) {
    const between = value.slice(last, m.index);
    if (!(bytes.length && /^[ \t\r\n]*$/.test(between))) {
      flush();
      out += between;
    }
    // RFC 2231 lets a charset carry a language: utf-8*en
    const cs = m[1].replace(/\*.*$/, '').toLowerCase();
    if (cs !== charset) flush();
    charset = cs;
    bytes.push(m[2] === 'B' || m[2] === 'b' ? decodeBase64(m[3]) : decodeQ(m[3]));
    last = m.index! + m[0].length;
  }
  flush();
  return out + value.slice(last);
}

/**
 * A header block as text. RFC 6532 allows raw UTF-8 in headers; older clients
 * write raw GBK or Big5 instead, which only the part's own charset (when it
 * declares one) can read.
 */
function decodeHeaderBlock(bin: string): string {
  if (!/[\x80-\xff]/.test(bin)) return bin;
  const bytes = toBytes(bin);
  const utf8 = tryDecode(bytes, 'utf-8');
  if (utf8 !== null) return utf8;
  const declared = /charset\s*=\s*"?([\w.:-]+)/i.exec(bin)?.[1];
  return (declared ? tryDecode(bytes, declared) : null) ?? decodeUndeclared(bytes);
}

/** Header lines unfolded (a line starting with a blank continues the one before) into [lower-case name, value]. */
function unfold(head: string): Array<[string, string]> {
  const fields: Array<[string, string]> = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      if (fields.length) fields[fields.length - 1][1] += line;
      continue;
    }
    const colon = line.indexOf(':');
    // not a field (an mbox "From " line, garbage): no valid name before a colon
    if (colon <= 0 || !/^[!-9;-~]+$/.test(line.slice(0, colon))) continue;
    fields.push([line.slice(0, colon).toLowerCase(), line.slice(colon + 1)]);
  }
  return fields.map(([k, v]) => [k, v.trim()]);
}

function splitHead(bin: string): { head: string; body: string } {
  if (bin.startsWith('\r\n')) return { head: '', body: bin.slice(2) };
  if (bin.startsWith('\n')) return { head: '', body: bin.slice(1) };
  const m = /\r?\n\r?\n/.exec(bin);
  if (!m) return { head: bin, body: '' };
  return { head: bin.slice(0, m.index), body: bin.slice(m.index + m[0].length) };
}

/** Split a structured value on a separator that is not inside quotes, angle brackets or a comment. */
function splitOutside(value: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quoted) {
      cur += c;
      if (c === '\\' && i + 1 < value.length) cur += value[++i];
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === '<') angle++;
    else if (c === '>') angle = Math.max(0, angle - 1);
    else if (c === '(') paren++;
    else if (c === ')') paren = Math.max(0, paren - 1);
    else if (c === sep && !angle && !paren) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\(.)/g, '$1');
  return t;
}

/** RFC 2231 extended value: charset'language'percent-encoded bytes. */
function percentBytes(s: string): Buffer {
  return Buffer.from(s.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1');
}

/**
 * A Content-Type or Content-Disposition value: the lower-cased main value and
 * its parameters, with RFC 2231 continuations (name*0, name*1*) and charsets
 * (name*=utf-8''%E6%8A%A5) assembled, and encoded words decoded where senders
 * put them though they should not (name="=?UTF-8?B?…?=").
 */
export function parseParams(value: string): { value: string; params: Record<string, string> } {
  const [main, ...rest] = splitOutside(value, ';');
  const params: Record<string, string> = {};
  const extended = new Map<string, Array<{ index: number; encoded: boolean; value: string }>>();
  for (const seg of rest) {
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    const name = seg.slice(0, eq).trim().toLowerCase();
    const raw = seg.slice(eq + 1).trim();
    const m = /^([^*]+)\*(?:(\d+)\*?)?$/.exec(name);
    if (m && (name.endsWith('*') || m[2] !== undefined)) {
      const list = extended.get(m[1]) ?? [];
      list.push({ index: m[2] === undefined ? 0 : Number(m[2]), encoded: name.endsWith('*'), value: unquote(raw) });
      extended.set(m[1], list);
      continue;
    }
    params[name] = decodeWords(unquote(raw));
  }
  for (const [name, segs] of extended) {
    segs.sort((a, b) => a.index - b.index);
    let charset = 'utf-8';
    const bytes: Buffer[] = [];
    segs.forEach((s, i) => {
      let v = s.value;
      if (s.encoded && i === 0) {
        const parts = /^([^']*)'[^']*'([\s\S]*)$/.exec(v);
        if (parts) {
          charset = parts[1] || 'utf-8';
          v = parts[2];
        }
      }
      bytes.push(s.encoded ? percentBytes(v) : Buffer.from(v, 'utf8'));
    });
    params[name] = decodeCharset(Buffer.concat(bytes), charset);
  }
  return { value: (main ?? '').trim().toLowerCase(), params };
}

/** Addresses of a From / To / Cc value: "Name" <a@b>, a@b (Name), =?…?= <a@b>, groups. */
export function parseAddresses(value: string | undefined): MailAddress[] {
  if (!value) return [];
  const out: MailAddress[] = [];
  for (const part of splitOutside(value, ',')) {
    // a group "Team: a@b, c@d;" stands for its members; "undisclosed-recipients:;" for none
    const p = part.replace(/^\s*[^"<>@:,]+:/, '').replace(/;\s*$/, '').trim();
    if (!p) continue;
    const angle = /^(.*?)<([^<>]*)>\s*(?:\(.*\))?$/.exec(p);
    if (angle) {
      out.push({ name: decodeWords(unquote(angle[1])).trim(), address: angle[2].trim().toLowerCase() });
      continue;
    }
    const comment = /^([^\s()]+@[^\s()]+)\s*\((.*)\)$/.exec(p);
    if (comment) {
      out.push({ name: decodeWords(comment[2]).trim(), address: comment[1].toLowerCase() });
      continue;
    }
    if (/@/.test(p)) out.push({ name: '', address: unquote(p).toLowerCase() });
    else out.push({ name: decodeWords(unquote(p)), address: '' });
  }
  return out;
}

/** The ids <…> a Message-ID, In-Reply-To or References value holds, without the brackets. */
export function messageIds(value: string | undefined): string[] {
  if (!value) return [];
  const ids = [...value.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]);
  // a bare id without brackets (seen from some ticketing systems)
  if (!ids.length && /^\S+@\S+$/.test(value.trim())) ids.push(value.trim());
  return ids;
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const ZONES: Record<string, number> = { UT: 0, UTC: 0, GMT: 0, Z: 0, EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420 };

/**
 * An RFC 5322 date ("Mon, 9 Nov 2026 10:00:00 +0800 (CST)") or an IMAP
 * INTERNALDATE ("09-Nov-2026 10:00:00 +0800"); null when unreadable.
 */
export function parseMailDate(value: string | undefined): Date | null {
  if (!value) return null;
  const v = value.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const m = /(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -](\d{2,4}),? (\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)? ?([+-]\d{4}|[A-Za-z]{1,3})?/.exec(v);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) {
    let year = Number(m[3]);
    if (m[3].length === 2) year += year < 50 ? 2000 : 1900;
    else if (m[3].length === 3) year += 1900;
    let offset = 0;
    const zone = m[7];
    if (zone && /^[+-]\d{4}$/.test(zone)) offset = (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3)));
    else if (zone) offset = ZONES[zone.toUpperCase()] ?? 0;
    const t = Date.UTC(year, MONTHS[m[2].toLowerCase()], Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)) - offset * 60_000;
    return Number.isNaN(t) ? null : new Date(t);
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}

/* --------------------------------- bodies -------------------------------- */

/** The delimited parts of a multipart body; a body cut short (no closing delimiter) keeps its last part. */
function splitMultipart(body: string, boundary: string): string[] {
  const delim = `--${boundary}`;
  const parts: string[] = [];
  let start = -1;
  let pos = 0;
  for (;;) {
    const at = body.indexOf(delim, pos);
    if (at < 0) break;
    pos = at + delim.length;
    if (at > 0 && body[at - 1] !== '\n') continue;
    const eol = body.indexOf('\n', pos);
    const rest = body.slice(pos, eol < 0 ? body.length : eol).replace(/\r$/, '');
    // only the boundary itself, maybe closed with "--" and padded with blanks: not a longer boundary sharing its start
    if (!/^(--)?[ \t]*$/.test(rest)) continue;
    if (start >= 0) {
      let end = at;
      if (body[end - 1] === '\n') end--;
      if (body[end - 1] === '\r') end--;
      parts.push(body.slice(start, Math.max(start, end)));
    }
    if (rest.startsWith('--')) return parts;
    start = eol < 0 ? body.length : eol + 1;
    pos = start;
  }
  if (start >= 0 && start < body.length) parts.push(body.slice(start));
  return parts;
}

/**
 * format=flowed (RFC 3676): a line ending in a space continues on the next
 * one. Joined back into paragraphs so quote stripping and Markdown see whole
 * lines; quoted depth is kept.
 */
function unflow(text: string, delsp: boolean): string {
  const out: string[] = [];
  let buf: string | null = null;
  let depth = 0;
  for (const raw of text.split(/\r?\n/)) {
    const q = /^>+/.exec(raw);
    const d = q ? q[0].length : 0;
    let line = raw.slice(d);
    if (line.startsWith(' ')) line = line.slice(1);
    if (buf !== null && d !== depth) {
      out.push(buf);
      buf = null;
    }
    const soft = line.endsWith(' ') && line !== '-- ';
    const piece = soft && delsp ? line.slice(0, -1) : line;
    buf = buf === null ? `${d ? `${'>'.repeat(d)} ` : ''}${piece}` : buf + piece;
    depth = d;
    if (!soft) {
      out.push(buf);
      buf = null;
    }
  }
  if (buf !== null) out.push(buf);
  return out.join('\n');
}

interface Collector {
  text: string[];
  html: string[];
  attachments: MimeAttachment[];
}

const MAX_DEPTH = 20;

function walk(bin: string, out: Collector, depth: number, inRelated: boolean, top: boolean): Array<[string, string]> {
  const { head, body } = splitHead(bin);
  const fields = unfold(decodeHeaderBlock(head));
  const get = (name: string) => fields.find(([k]) => k === name)?.[1];
  const ctype = parseParams(get('content-type') || 'text/plain');
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(ctype.value) ? ctype.value : 'text/plain';
  if (type.startsWith('multipart/') && ctype.params.boundary && depth < MAX_DEPTH) {
    const related = type === 'multipart/related';
    for (const sub of splitMultipart(body, ctype.params.boundary)) walk(sub, out, depth + 1, related, false);
    return fields;
  }
  const disposition = parseParams(get('content-disposition') ?? '');
  const filename = disposition.params.filename || ctype.params.name || undefined;
  const encoding = (get('content-transfer-encoding') ?? '7bit').trim().toLowerCase();
  const isBody = (type === 'text/plain' || type === 'text/html') && disposition.value !== 'attachment' && !filename;
  if (isBody) {
    const bytes = decodeTransfer(body, encoding);
    let charset: string | undefined = ctype.params.charset;
    // an HTML part that names its charset only in a <meta> tag
    if (!charset && type === 'text/html') charset = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(bytes.subarray(0, 4096).toString('latin1'))?.[1];
    let text = charset ? decodeCharset(bytes, charset) : decodeUndeclared(bytes);
    if (type === 'text/plain') {
      if ((ctype.params.format ?? '').toLowerCase() === 'flowed') text = unflow(text, (ctype.params.delsp ?? '').toLowerCase() === 'yes');
      out.text.push(text);
    } else out.html.push(text);
    return fields;
  }
  const contentId = messageIds(get('content-id'))[0];
  let name = filename;
  if (!name && type === 'message/rfc822') {
    const inner = unfold(decodeHeaderBlock(splitHead(decodeTransfer(body, encoding).toString('latin1')).head));
    const subject = decodeWords(inner.find(([k]) => k === 'subject')?.[1] ?? '').trim();
    name = `${subject || 'message'}.eml`;
  }
  out.attachments.push({
    ...(name ? { filename: name } : {}),
    mime: type,
    size: transferSize(body, encoding),
    ...(contentId ? { contentId } : {}),
    inline: Boolean(contentId && inRelated && disposition.value !== 'attachment' && !top),
  });
  return fields;
}

/** Parse a whole message (RFC 5322 with MIME) from its bytes. */
export function parseMail(raw: Buffer | string): ParsedMail {
  const bin = typeof raw === 'string' ? Buffer.from(raw, 'utf8').toString('latin1') : raw.toString('latin1');
  const out: Collector = { text: [], html: [], attachments: [] };
  const fields = walk(bin, out, 0, false, true);
  const rawHeaders: Record<string, string[]> = {};
  const headers: Record<string, string[]> = {};
  for (const [k, v] of fields) {
    (rawHeaders[k] ??= []).push(v);
    (headers[k] ??= []).push(decodeWords(v));
  }
  const first = (name: string) => rawHeaders[name]?.[0];
  const references = messageIds(first('references'));
  const text = out.text.filter((t) => t.trim()).map((t) => t.trimEnd()).join('\n\n');
  const html = out.html.filter((t) => t.trim()).map((t) => t.trimEnd()).join('\n');
  return {
    headers,
    rawHeaders,
    subject: (headers.subject?.[0] ?? '').replace(/\s+/g, ' ').trim(),
    from: parseAddresses(first('from')),
    to: (rawHeaders.to ?? []).flatMap((v) => parseAddresses(v)),
    cc: (rawHeaders.cc ?? []).flatMap((v) => parseAddresses(v)),
    date: parseMailDate(first('date')),
    ...(messageIds(first('message-id'))[0] ? { messageId: messageIds(first('message-id'))[0] } : {}),
    ...(messageIds(first('in-reply-to'))[0] ? { inReplyTo: messageIds(first('in-reply-to'))[0] } : {}),
    references,
    ...(text ? { text } : {}),
    ...(html ? { html } : {}),
    attachments: out.attachments,
  };
}
