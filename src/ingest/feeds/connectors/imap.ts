import net from 'node:net';
import tls from 'node:tls';

/**
 * A small IMAP4rev1 client (RFC 3501): what the email connector needs to read
 * a mailbox without changing it — log in (LOGIN or SASL XOAUTH2), open a
 * mailbox read-only, search by date or UID, fetch whole messages, log out.
 *
 * One command runs at a time. Responses are read as bytes: a literal {n} is
 * n bytes (not n characters), so a message body arrives exactly as the server
 * holds it, whatever its charset. The text around literals is read as latin1
 * (one character per byte) and only human-readable text — a NO's reason — is
 * turned into UTF-8, because some servers answer in Chinese.
 *
 * Nothing here writes to the server: no STORE, COPY, MOVE, EXPUNGE or APPEND,
 * mailboxes are opened with EXAMINE, and bodies are fetched with BODY.PEEK so
 * no \Seen flag is set.
 */

export type ImapValue = string | Buffer | null | ImapValue[];

export interface ImapResponse {
  /** '*' (untagged), '+' (continuation) or the tag of the command it completes. */
  tag: string;
  /** OK / NO / BAD / BYE / PREAUTH, or a data keyword: FETCH, SEARCH, EXISTS, CAPABILITY, FLAGS… */
  type: string;
  /** The number before the keyword: `* 12 FETCH`, `* 3 EXISTS`. */
  num?: number;
  /** A status response's bracketed code: [UIDVALIDITY 3857529045]. */
  code?: { name: string; value: string };
  /** A status response's text (UTF-8), or a data response's rest as written. */
  text: string;
  /** A FETCH response's parenthesized data, tokenized. */
  values?: ImapValue[];
}

export class ImapError extends Error {
  constructor(
    message: string,
    /** NO, BAD, BYE, TIMEOUT, CLOSED, PROTOCOL, … */
    readonly status: string,
    /** The response code, when the server gave one: AUTHENTICATIONFAILED, NONEXISTENT, … */
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ImapError';
  }
}

export interface ImapOptions {
  host: string;
  port: number;
  /** Implicit TLS (port 993). false: a plain connection, upgraded with STARTTLS when the server requires it before LOGIN. */
  tls: boolean;
  /** Without a byte from the server for this long while waiting for it, the connection is given up (default 60 s). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Verify the server's certificate (default true; a STARTTLS upgrade on a loopback bridge skips it). */
  rejectUnauthorized?: boolean;
}

export interface MailboxStatus {
  name: string;
  exists: number;
  uidValidity: number;
  /** Absent when the server does not say. */
  uidNext?: number;
  readOnly: boolean;
}

export interface FetchedMessage {
  seq: number;
  uid: number;
  flags: string[];
  internalDate?: string;
  /** RFC822.SIZE: the whole message's size, which may exceed `body` when a partial fetch cut it. */
  size?: number;
  body: Buffer;
  /** Gmail's thread id (X-GM-THRID), a 64-bit number kept as a string. */
  gmThreadId?: string;
}

interface Pending {
  tag: string;
  label: string;
  untagged: ImapResponse[];
  onUntagged?: (r: ImapResponse) => boolean | void;
  onContinue?: (r: ImapResponse) => void;
  resolve: (r: { tagged: ImapResponse; untagged: ImapResponse[] }) => void;
  reject: (err: Error) => void;
}

type Part = string | { literal: Buffer };

const STATUS = new Set(['OK', 'NO', 'BAD', 'BYE', 'PREAUTH']);

/** Text the server wrote, read as latin1 bytes, back as UTF-8 when it is valid UTF-8. */
function human(latin1: string): string {
  if (!/[\x80-\xff]/.test(latin1)) return latin1;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(latin1, 'latin1'));
  } catch {
    return latin1;
  }
}

/** Tokens of IMAP data: atoms, "quoted", literals (as Buffers), NIL (null), (lists). */
export function tokenize(s: string, literals: Buffer[]): ImapValue[] {
  let i = 0;
  const list = (nested: boolean): ImapValue[] => {
    const out: ImapValue[] = [];
    while (i < s.length) {
      const c = s[i];
      if (c === ' ') {
        i++;
      } else if (c === ')') {
        i++;
        if (nested) return out;
      } else if (c === '(') {
        i++;
        out.push(list(true));
      } else if (c === '"') {
        let v = '';
        i++;
        while (i < s.length && s[i] !== '"') {
          if (s[i] === '\\' && i + 1 < s.length) i++;
          v += s[i++];
        }
        i++;
        out.push(v);
      } else if (c === '\x00') {
        const end = s.indexOf('\x00', i + 1);
        out.push(literals[Number(s.slice(i + 1, end))] ?? Buffer.alloc(0));
        i = end + 1;
      } else {
        // an atom; brackets nest and may hold spaces: BODY[HEADER.FIELDS (SUBJECT)]<0>
        let j = i;
        let depth = 0;
        while (j < s.length) {
          const d = s[j];
          if (d === '[') depth++;
          else if (d === ']') depth--;
          else if (depth <= 0 && (d === ' ' || d === '(' || d === ')')) break;
          j++;
        }
        const atom = s.slice(i, j);
        i = j;
        out.push(atom.toUpperCase() === 'NIL' ? null : atom);
      }
    }
    return out;
  };
  return list(false);
}

function parseResponse(line: string, literals: Buffer[]): ImapResponse {
  if (line.startsWith('+')) return { tag: '+', type: '+', text: human(line.slice(1).trimStart()) };
  const sp = line.indexOf(' ');
  const tag = sp < 0 ? line : line.slice(0, sp);
  let rest = sp < 0 ? '' : line.slice(sp + 1);
  let num: number | undefined;
  if (tag === '*') {
    const m = /^(\d+) /.exec(rest);
    if (m) {
      num = Number(m[1]);
      rest = rest.slice(m[0].length);
    }
  }
  const sp2 = rest.indexOf(' ');
  const type = (sp2 < 0 ? rest : rest.slice(0, sp2)).toUpperCase();
  rest = sp2 < 0 ? '' : rest.slice(sp2 + 1);
  const res: ImapResponse = { tag, type, text: rest, ...(num !== undefined ? { num } : {}) };
  if (STATUS.has(type)) {
    const m = /^\[([^\s\]]+)(?: ([^\]]*))?\]\s?/.exec(rest);
    if (m) {
      res.code = { name: m[1].toUpperCase(), value: m[2] ?? '' };
      rest = rest.slice(m[0].length);
    }
    res.text = human(rest);
  } else if (type === 'FETCH') {
    res.values = tokenize(rest, literals);
  }
  return res;
}

/** "1:5,7,9:12" for a set of UIDs. */
export function uidSet(uids: number[]): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(j > i ? `${sorted[i]}:${sorted[j]}` : String(sorted[i]));
    i = j;
  }
  return out.join(',');
}

/** A string argument: quoted when it can be, a literal when it holds line breaks, NUL or 8-bit characters. */
export function quoteArg(value: string): Part {
  if (/[\r\n\0]|[^\x00-\x7f]/.test(value)) return { literal: Buffer.from(value, 'utf8') };
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/**
 * A mailbox name in IMAP's modified UTF-7 (RFC 3501 §5.1.3): "已发送" is
 * "&XfJT0ZAB-". A name that already looks encoded is passed through.
 */
export function encodeMailbox(name: string): string {
  if (/^[\x20-\x7e]*$/.test(name) && /&[A-Za-z0-9+,]*-/.test(name)) return name;
  let out = '';
  let run = '';
  const flush = () => {
    if (!run) return;
    const utf16 = Buffer.alloc(run.length * 2);
    for (let i = 0; i < run.length; i++) utf16.writeUInt16BE(run.charCodeAt(i), i * 2);
    out += `&${utf16.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`;
    run = '';
  };
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    if (c >= 0x20 && c <= 0x7e) {
      flush();
      out += ch === '&' ? '&-' : ch;
    } else run += ch;
  }
  flush();
  return out;
}

const isLoopback = (host: string) => host === 'localhost' || host === '::1' || /^127\./.test(host);

export class ImapClient {
  capabilities = new Set<string>();
  /** Set by a PREAUTH greeting: already signed in. */
  preauthenticated = false;

  private socket!: net.Socket;
  private buf: Buffer = Buffer.alloc(0);
  private chunks: Buffer[] = [];
  private chunksLen = 0;
  /** Bytes the parser needs before it can make progress (so a large literal is not re-scanned per packet). */
  private need = 0;
  private literalLeft = -1;
  private curLine = '';
  private curLiterals: Buffer[] = [];
  private current: Pending | null = null;
  private greeting: { resolve: (r: ImapResponse) => void; reject: (e: Error) => void } | null = null;
  private closed: Error | null = null;
  private bye = '';
  private tagN = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly timeoutMs: number;
  private readonly onAbort = () => this.fail(new ImapError('IMAP: stopped (the run was cancelled)', 'ABORTED'));
  private readonly onData = (chunk: Buffer) => this.receive(chunk);
  private readonly onError = (err: Error) => this.fail(new ImapError(`IMAP connection to ${this.opts.host}:${this.opts.port} failed: ${err.message}`, 'CLOSED'));
  private readonly onClose = () => this.fail(new ImapError(`IMAP server ${this.opts.host} closed the connection${this.bye ? `: ${this.bye}` : ''}`, 'CLOSED'));
  private readonly onTimeout = () => {
    if (this.current || this.greeting) this.fail(new ImapError(`IMAP server ${this.opts.host} did not answer within ${this.timeoutMs < 1000 ? `${this.timeoutMs} ms` : `${Math.round(this.timeoutMs / 1000)} s`}`, 'TIMEOUT'));
  };

  private constructor(private readonly opts: ImapOptions) {
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  /** Connect and read the greeting and the server's capabilities. */
  static async connect(opts: ImapOptions): Promise<ImapClient> {
    const client = new ImapClient(opts);
    try {
      await client.open();
    } catch (err) {
      client.close();
      throw err;
    }
    return client;
  }

  private async open(): Promise<void> {
    const { host, port, signal } = this.opts;
    if (signal?.aborted) throw new ImapError('IMAP: stopped (the run was cancelled)', 'ABORTED');
    signal?.addEventListener('abort', this.onAbort, { once: true });
    const greeted = new Promise<ImapResponse>((resolve, reject) => {
      this.greeting = { resolve, reject };
    });
    const socket = this.opts.tls
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: this.opts.rejectUnauthorized ?? true })
      : net.connect({ host, port });
    this.attach(socket);
    const hello = await greeted;
    if (hello.type === 'BYE') throw new ImapError(`IMAP server ${host} refused the connection: ${hello.text}`, 'BYE');
    this.preauthenticated = hello.type === 'PREAUTH';
    if (hello.code?.name === 'CAPABILITY') this.setCapabilities(hello.code.value);
    else await this.refreshCapabilities();
    // a plain connection: upgrade whenever the server offers it — to a remote host always, so a password never
    // crosses the network in the clear; a local bridge (DavMail, Proton Bridge) only when it insists
    if (!this.opts.tls && !this.preauthenticated && this.capabilities.has('STARTTLS') && (!isLoopback(host) || this.capabilities.has('LOGINDISABLED'))) {
      await this.startTls();
      this.secured = true;
    }
  }

  /** The connection is encrypted: implicit TLS, or upgraded with STARTTLS. */
  private secured = false;

  /** Credentials go only over an encrypted connection, or to this machine. */
  private assertMaySendCredentials(): void {
    if (this.opts.tls || this.secured || isLoopback(this.opts.host)) return;
    throw new ImapError(`IMAP server ${this.opts.host} offers no encryption on this connection: refusing to send credentials in the clear (use tls: true, port 993)`, 'NO');
  }

  private attach(socket: net.Socket): void {
    this.socket = socket;
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
    socket.on('timeout', this.onTimeout);
    socket.setTimeout(this.timeoutMs);
  }

  private detach(socket: net.Socket): void {
    socket.off('data', this.onData);
    socket.off('error', this.onError);
    socket.off('close', this.onClose);
    socket.off('timeout', this.onTimeout);
    socket.setTimeout(0);
  }

  private async startTls(): Promise<void> {
    await this.run('STARTTLS', ['STARTTLS']);
    const plain = this.socket;
    this.detach(plain);
    const { host } = this.opts;
    const secure = tls.connect({ socket: plain, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: this.opts.rejectUnauthorized ?? !isLoopback(host) });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        secure.destroy();
        reject(new ImapError(`IMAP STARTTLS with ${host} did not finish`, 'TIMEOUT'));
      }, this.timeoutMs);
      secure.once('secureConnect', () => {
        clearTimeout(timer);
        resolve();
      });
      secure.once('error', (err) => {
        clearTimeout(timer);
        reject(new ImapError(`IMAP STARTTLS with ${host} failed: ${err.message}`, 'CLOSED'));
      });
    });
    this.attach(secure);
    // capabilities seen before TLS must not be trusted after it
    await this.refreshCapabilities();
  }

  private setCapabilities(list: string): void {
    this.capabilities = new Set(list.split(/\s+/).filter(Boolean).map((c) => c.toUpperCase()));
  }

  async refreshCapabilities(): Promise<void> {
    await this.run('CAPABILITY', ['CAPABILITY']);
  }

  /* ------------------------------- reading ------------------------------- */

  private receive(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.chunksLen += chunk.length;
    if (this.buf.length + this.chunksLen < this.need) return;
    this.buf = Buffer.concat([this.buf, ...this.chunks]);
    this.chunks = [];
    this.chunksLen = 0;
    this.need = 0;
    try {
      this.drain();
    } catch (err) {
      this.fail(err instanceof ImapError ? err : new ImapError(`IMAP: ${err instanceof Error ? err.message : err}`, 'PROTOCOL'));
    }
  }

  /** Read every complete response in the buffer: lines, and the literals inside them. */
  private drain(): void {
    while (!this.closed) {
      if (this.literalLeft >= 0) {
        if (this.buf.length < this.literalLeft) {
          this.need = this.literalLeft;
          return;
        }
        // a copy, so the response does not pin the whole receive buffer
        this.curLiterals.push(Buffer.from(this.buf.subarray(0, this.literalLeft)));
        this.curLine += `\x00${this.curLiterals.length - 1}\x00`;
        this.buf = this.buf.subarray(this.literalLeft);
        this.literalLeft = -1;
        continue;
      }
      const nl = this.buf.indexOf(0x0a);
      if (nl < 0) {
        if (this.buf.length > 1024 * 1024) throw new ImapError('IMAP: the server sent a line over 1 MB', 'PROTOCOL');
        this.need = this.buf.length + 1;
        return;
      }
      const line = this.buf.toString('latin1', 0, nl > 0 && this.buf[nl - 1] === 0x0d ? nl - 1 : nl);
      this.buf = this.buf.subarray(nl + 1);
      // a line ending in {n} (or {n+}, ~{n}) continues after n bytes of literal
      const lit = /~?\{(\d+)\+?\}$/.exec(line);
      if (lit) {
        this.curLine += line.slice(0, lit.index);
        this.literalLeft = Number(lit[1]);
        continue;
      }
      const text = this.curLine + line;
      const literals = this.curLiterals;
      this.curLine = '';
      this.curLiterals = [];
      this.dispatch(parseResponse(text, literals));
    }
  }

  private dispatch(r: ImapResponse): void {
    if (this.greeting && r.tag === '*') {
      const g = this.greeting;
      this.greeting = null;
      g.resolve(r);
      return;
    }
    if (r.tag === '+') {
      this.current?.onContinue?.(r);
      return;
    }
    if (r.tag === '*') {
      if (r.type === 'CAPABILITY') this.setCapabilities(r.text);
      else if (r.code?.name === 'CAPABILITY') this.setCapabilities(r.code.value);
      if (r.type === 'BYE') this.bye = r.text;
      const cur = this.current;
      if (cur && !cur.onUntagged?.(r)) cur.untagged.push(r);
      return;
    }
    const cur = this.current;
    if (!cur || r.tag !== cur.tag) return;
    this.current = null;
    if (r.code?.name === 'CAPABILITY') this.setCapabilities(r.code.value);
    if (r.type === 'OK') cur.resolve({ tagged: r, untagged: cur.untagged });
    else cur.reject(new ImapError(`IMAP ${cur.label} failed: ${r.type}${r.code ? ` [${r.code.name}${r.code.value ? ` ${r.code.value}` : ''}]` : ''} ${r.text}`.trim(), r.type, r.code?.name));
  }

  private fail(err: Error): void {
    if (this.closed) return;
    this.closed = err;
    this.opts.signal?.removeEventListener('abort', this.onAbort);
    this.socket?.destroy();
    this.greeting?.reject(err);
    this.greeting = null;
    const cur = this.current;
    this.current = null;
    cur?.reject(err);
  }

  /* ------------------------------- writing ------------------------------- */

  /**
   * Run one command and wait for its tagged answer. `parts` are joined with
   * nothing between them; a { literal } part is sent as {n} and, unless the
   * server takes LITERAL+, only after it says to go ahead.
   */
  run(label: string, parts: Part[], hooks: Pick<Pending, 'onUntagged' | 'onContinue'> = {}): Promise<{ tagged: ImapResponse; untagged: ImapResponse[] }> {
    const job = this.chain.then(() => this.exec(label, parts, hooks));
    this.chain = job.catch(() => {});
    return job;
  }

  private exec(label: string, parts: Part[], hooks: Pick<Pending, 'onUntagged' | 'onContinue'>): Promise<{ tagged: ImapResponse; untagged: ImapResponse[] }> {
    if (this.closed) return Promise.reject(this.closed);
    const tag = `K${++this.tagN}`;
    return new Promise((resolve, reject) => {
      let waitGo: ((r: ImapResponse) => void) | null = null;
      const pending: Pending = {
        tag,
        label,
        untagged: [],
        onUntagged: hooks.onUntagged,
        onContinue: (r) => {
          if (waitGo) {
            const go = waitGo;
            waitGo = null;
            go(r);
          } else hooks.onContinue?.(r);
        },
        resolve,
        reject,
      };
      this.current = pending;
      const literalPlus = this.capabilities.has('LITERAL+');
      const send = async () => {
        let text = `${tag} `;
        for (const p of parts) {
          if (typeof p === 'string') {
            text += p;
            continue;
          }
          if (literalPlus) {
            this.socket.write(`${text}{${p.literal.length}+}\r\n`, 'latin1');
            this.socket.write(p.literal);
          } else {
            this.socket.write(`${text}{${p.literal.length}}\r\n`, 'latin1');
            await new Promise<ImapResponse>((go) => {
              waitGo = go;
            });
            if (this.current !== pending) return;
            this.socket.write(p.literal);
          }
          text = '';
        }
        this.socket.write(`${text}\r\n`, 'latin1');
      };
      send().catch((err) => this.fail(err instanceof Error ? err : new Error(String(err))));
    });
  }

  /* ------------------------------- commands ------------------------------ */

  async login(user: string, password: string): Promise<void> {
    this.assertMaySendCredentials();
    if (this.capabilities.has('LOGINDISABLED')) throw new ImapError(`IMAP server ${this.opts.host} does not accept a password over this connection (use tls: true)`, 'NO');
    const { tagged } = await this.run('LOGIN', ['LOGIN ', quoteArg(user), ' ', quoteArg(password)]);
    await this.afterAuth(tagged);
  }

  /** SASL XOAUTH2 (Gmail, Outlook.com, Microsoft 365) with an OAuth access token. */
  async authenticateXOAuth2(user: string, accessToken: string): Promise<void> {
    this.assertMaySendCredentials();
    const token = Buffer.from(`user=${user}\x01auth=Bearer ${accessToken}\x01\x01`, 'utf8').toString('base64');
    const inline = this.capabilities.has('SASL-IR');
    let sent = inline;
    let detail = '';
    let done: ImapResponse;
    try {
      ({ tagged: done } = await this.run('AUTHENTICATE XOAUTH2', [inline ? `AUTHENTICATE XOAUTH2 ${token}` : 'AUTHENTICATE XOAUTH2'], {
        onContinue: (r) => {
          if (!sent) {
            sent = true;
            this.socket.write(`${token}\r\n`, 'latin1');
            return;
          }
          // a failure comes as a challenge holding a JSON error; an empty answer ends the exchange with NO
          try {
            detail = Buffer.from(r.text, 'base64').toString('utf8');
          } catch {
            detail = r.text;
          }
          this.socket.write('\r\n', 'latin1');
        },
      }));
    } catch (err) {
      if (err instanceof ImapError && detail) throw new ImapError(`${err.message} (${detail})`, err.status, err.code);
      throw err;
    }
    await this.afterAuth(done);
  }

  private async afterAuth(tagged: ImapResponse): Promise<void> {
    // capabilities change once signed in (Gmail's X-GM-EXT-1, for one); the OK may have listed them already
    if (tagged.code?.name !== 'CAPABILITY') await this.refreshCapabilities();
    // NetEase (163.com, 126.com) refuses to open a mailbox for a client that has not said who it is
    if (this.capabilities.has('ID')) await this.run('ID', ['ID ("name" "knode-os" "vendor" "knode-os")']).catch(() => {});
  }

  /** Open a mailbox read-only (EXAMINE): nothing is marked read or expunged. */
  async examine(mailbox: string): Promise<MailboxStatus> {
    const status: MailboxStatus = { name: mailbox, exists: 0, uidValidity: 0, readOnly: true };
    const { tagged } = await this.run(`EXAMINE ${JSON.stringify(mailbox)}`, ['EXAMINE ', quoteArg(encodeMailbox(mailbox))], {
      onUntagged: (r) => {
        if (r.type === 'EXISTS' && r.num !== undefined) status.exists = r.num;
        else if (r.code?.name === 'UIDVALIDITY') status.uidValidity = Number(r.code.value) || 0;
        else if (r.code?.name === 'UIDNEXT') status.uidNext = Number(r.code.value) || undefined;
        return false;
      },
    });
    if (tagged.code?.name === 'READ-WRITE') status.readOnly = false;
    return status;
  }

  /** UID SEARCH with ASCII criteria ("SINCE 09-Nov-2026", "UID 120:*"): the matching UIDs, ascending. */
  async uidSearch(criteria: string): Promise<number[]> {
    const uids: number[] = [];
    await this.run(`UID SEARCH ${criteria}`, [`UID SEARCH ${criteria}`], {
      onUntagged: (r) => {
        if (r.type !== 'SEARCH') return false;
        for (const t of r.text.split(/\s+/)) if (/^\d+$/.test(t)) uids.push(Number(t));
        return true;
      },
    });
    return [...new Set(uids)].sort((a, b) => a - b);
  }

  /**
   * UID FETCH whole messages, handing each to `onMessage` as it arrives, so a
   * batch never sits in memory at once. `maxBytes` fetches at most that many
   * bytes of each (a partial fetch, BODY.PEEK[]<0.n>): the text of a mail
   * comes first, a huge attachment last.
   */
  async fetchMessages(uids: number[], onMessage: (m: FetchedMessage) => void, opts: { maxBytes?: number } = {}): Promise<void> {
    if (!uids.length) return;
    const items = ['UID', 'FLAGS', 'INTERNALDATE', 'RFC822.SIZE', opts.maxBytes ? `BODY.PEEK[]<0.${opts.maxBytes}>` : 'BODY.PEEK[]'];
    if (this.capabilities.has('X-GM-EXT-1')) items.push('X-GM-THRID');
    // a server may split one message's data over several FETCH responses: merged by sequence number
    const partial = new Map<number, Partial<FetchedMessage>>();
    const emit = (seq: number) => {
      const m = partial.get(seq)!;
      if (m.uid === undefined || !m.body) return;
      partial.delete(seq);
      onMessage({ seq, uid: m.uid, flags: m.flags ?? [], body: m.body, ...(m.internalDate ? { internalDate: m.internalDate } : {}), ...(m.size !== undefined ? { size: m.size } : {}), ...(m.gmThreadId ? { gmThreadId: m.gmThreadId } : {}) });
    };
    const set = uidSet(uids);
    await this.run(`UID FETCH ${set}`, [`UID FETCH ${set} (${items.join(' ')})`], {
      onUntagged: (r) => {
        if (r.type !== 'FETCH' || r.num === undefined) return false;
        const data = Array.isArray(r.values?.[0]) ? (r.values![0] as ImapValue[]) : [];
        const m = partial.get(r.num) ?? {};
        for (let i = 0; i + 1 < data.length; i += 2) {
          const key = typeof data[i] === 'string' ? (data[i] as string).toUpperCase() : '';
          const v = data[i + 1];
          if (key === 'UID') m.uid = Number(v);
          else if (key === 'FLAGS' && Array.isArray(v)) m.flags = v.filter((f): f is string => typeof f === 'string');
          else if (key === 'INTERNALDATE' && typeof v === 'string') m.internalDate = v;
          else if (key === 'RFC822.SIZE') m.size = Number(v);
          else if (key === 'X-GM-THRID' && v !== null) m.gmThreadId = String(v);
          else if (key.startsWith('BODY[')) m.body = Buffer.isBuffer(v) ? v : Buffer.from(typeof v === 'string' ? v : '', 'latin1');
        }
        partial.set(r.num, m);
        emit(r.num);
        return true;
      },
    });
    for (const seq of [...partial.keys()]) emit(seq);
  }

  /** Say goodbye and close; never throws. */
  async logout(): Promise<void> {
    if (this.closed) return;
    try {
      await Promise.race([this.run('LOGOUT', ['LOGOUT']), new Promise((r) => setTimeout(r, 5_000).unref())]);
    } catch {
      // the server may close before its OK arrives
    }
    this.close();
  }

  /** The connection is gone (failed, aborted or closed): no further command can run. */
  get isClosed(): boolean {
    return this.closed !== null;
  }

  /** Drop the connection. */
  close(): void {
    if (this.closed) return;
    this.closed = new ImapError('IMAP: connection closed', 'CLOSED');
    this.opts.signal?.removeEventListener('abort', this.onAbort);
    const socket = this.socket as net.Socket | undefined;
    if (!socket) return;
    this.detach(socket);
    socket.on('error', () => {});
    socket.end();
    socket.destroy();
  }
}
