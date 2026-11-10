import net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { KnodeConfig } from '../src/config.js';
import { emailConnector, imapDate, stripQuotedHtml, stripQuotedText } from '../src/ingest/feeds/connectors/email.js';
import { encodeMailbox, ImapClient, tokenize, uidSet } from '../src/ingest/feeds/connectors/imap.js';
import { decodeWords, parseAddresses, parseMail, parseMailDate, parseParams } from '../src/ingest/feeds/connectors/mime.js';
import type { ConnectorContext, FeedDefinition, FeedItem, PullResult } from '../src/ingest/feeds/types.js';

/**
 * The email feed connector (src/ingest/feeds/connectors/email.ts): MIME
 * parsing of real-world shapes (encoded words in UTF-8 and GBK, quoted-
 * printable, base64, nested multiparts, RFC 2231 names), quote stripping, and
 * pulls against a fake IMAP server on 127.0.0.1 — the cursor across pulls, a
 * renumbered mailbox, the per-pull cap, and errors the server words itself.
 */

const crlf = (lines: string[]) => lines.join('\r\n');
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
/** 你好中文邮件 in GBK. */
const GBK_NIHAO_ZHONGWEN_YOUJIAN = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xd6, 0xd0, 0xce, 0xc4, 0xd3, 0xca, 0xbc, 0xfe]);

/* --------------------------------- MIME ---------------------------------- */

describe('MIME parsing', () => {
  it('decodes encoded-word subjects in UTF-8, GBK, GB2312, Big5 and ISO-2022-JP', () => {
    expect(decodeWords(`=?UTF-8?B?${b64('季度报告：收入增长')}?=`)).toBe('季度报告：收入增长');
    expect(decodeWords(`=?GBK?B?${b64(GBK_NIHAO_ZHONGWEN_YOUJIAN)}?=`)).toBe('你好中文邮件');
    expect(decodeWords('=?gb2312?Q?=C4=E3=BA=C3?=')).toBe('你好');
    expect(decodeWords(`=?big5?B?${b64(Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]))}?=`)).toBe('中文');
    expect(decodeWords(`=?ISO-2022-JP?B?${b64(Buffer.from('\x1b$BF|K\\\x1b(B', 'latin1'))}?=`)).toBe('日本');
    // text around encoded words is kept; blanks between two encoded words are not
    expect(decodeWords('Re: =?UTF-8?Q?Caf=C3=A9?= =?UTF-8?Q?_au_lait?= tomorrow')).toBe('Re: Café au lait tomorrow');
    // a character split across two words (senders cut where the line ran out)
    const zw = Buffer.from('中文', 'utf8');
    expect(decodeWords(`=?utf-8?B?${b64(zw.subarray(0, 4))}?=\r\n =?utf-8?B?${b64(zw.subarray(4))}?=`)).toBe('中文');
    // an unknown charset reads as UTF-8 rather than failing
    expect(decodeWords(`=?x-made-up?B?${b64('ok')}?=`)).toBe('ok');
  });

  it('reads headers: folding, encoded and quoted names, raw 8-bit values, dates', () => {
    const mail = parseMail(
      Buffer.concat([
        Buffer.from(
          crlf([
            'From: =?UTF-8?B?5byg5LiJ?= <Zhang.San@Example.COM>',
            'To: "Doe, John" <john@example.com>, jane@example.com (Jane Roe),',
            ' undisclosed-recipients:;',
            'Cc: Team: a@example.com, b@example.com;',
            `Subject: =?GBK?B?${b64(GBK_NIHAO_ZHONGWEN_YOUJIAN)}?=`,
            'Date: Mon, 9 Nov 2026 10:00:00 +0800 (CST)',
            'Message-ID: <abc.123@mail.example.com>',
            'In-Reply-To: <root@example.com>',
            'References: <root@example.com>',
            '\t<mid@example.com>',
            'Content-Type: text/plain; charset=gbk',
            'X-Raw: ',
          ]),
          'latin1',
        ),
        GBK_NIHAO_ZHONGWEN_YOUJIAN.subarray(0, 4),
        Buffer.from('\r\n\r\n', 'latin1'),
        GBK_NIHAO_ZHONGWEN_YOUJIAN,
      ]),
    );
    expect(mail.from).toEqual([{ name: '张三', address: 'zhang.san@example.com' }]);
    expect(mail.to).toEqual([
      { name: 'Doe, John', address: 'john@example.com' },
      { name: 'Jane Roe', address: 'jane@example.com' },
    ]);
    expect(mail.cc.map((a) => a.address)).toEqual(['a@example.com', 'b@example.com']);
    expect(mail.subject).toBe('你好中文邮件');
    expect(mail.date?.toISOString()).toBe('2026-11-09T02:00:00.000Z');
    expect(mail.messageId).toBe('abc.123@mail.example.com');
    expect(mail.inReplyTo).toBe('root@example.com');
    expect(mail.references).toEqual(['root@example.com', 'mid@example.com']);
    // raw GBK in a header, read with the charset the message declares
    expect(mail.headers['x-raw']).toEqual(['你好']);
    expect(mail.text).toBe('你好中文邮件');
    expect(parseAddresses('undisclosed-recipients:;')).toEqual([]);
    expect(parseMailDate('09-Nov-2026 10:00:00 -0500')?.toISOString()).toBe('2026-11-09T15:00:00.000Z');
    expect(parseMailDate(' 9-Nov-2026 01:02:03 +0000')?.toISOString()).toBe('2026-11-09T01:02:03.000Z');
    expect(parseMailDate('nonsense')).toBeNull();
  });

  it('decodes quoted-printable and base64 bodies in their charsets', () => {
    const qp = parseMail(
      crlf([
        'Subject: qp',
        'Content-Type: text/plain; charset="utf-8"',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        'Caf=C3=A9 au lait, a very long line that the sender wrapped with a soft =',
        'break, and 1+1=3D2. =E4=B8=AD=E6=96=87',
      ]),
    );
    expect(qp.text).toBe('Café au lait, a very long line that the sender wrapped with a soft break, and 1+1=2. 中文');
    const base64 = parseMail(
      crlf(['Subject: b64', 'Content-Type: text/plain; charset=gb2312', 'Content-Transfer-Encoding: base64', '', ...b64(Buffer.concat([GBK_NIHAO_ZHONGWEN_YOUJIAN, GBK_NIHAO_ZHONGWEN_YOUJIAN])).match(/.{1,12}/g)!]),
    );
    expect(base64.text).toBe('你好中文邮件你好中文邮件');
    // format=flowed: soft breaks joined back into paragraphs
    const flowed = parseMail(crlf(['Content-Type: text/plain; charset=utf-8; format=flowed', '', 'one long ', 'paragraph', '> quoted ', '> on', '', '-- ', 'sig']));
    expect(flowed.text).toBe('one long paragraph\n> quoted on\n\n-- \nsig');
  });

  it('walks nested multiparts: alternative bodies, related pictures, attachments with RFC 2231 names', () => {
    const raw = crlf([
      'From: Ann <ann@example.com>',
      'Subject: report',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="outer"',
      '',
      'This is a multi-part message in MIME format.',
      '--outer',
      'Content-Type: multipart/alternative; boundary=alt',
      '',
      '--alt',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      '报告见附件。',
      '--alt',
      'Content-Type: multipart/related; boundary="rel"',
      '',
      '--rel',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64('<p>报告见<b>附件</b>。<img src="cid:logo@x"></p>'),
      '--rel',
      'Content-Type: image/png',
      'Content-ID: <logo@x>',
      'Content-Transfer-Encoding: base64',
      '',
      b64(Buffer.alloc(30, 1)),
      '--rel--',
      '--alt--',
      '--outer',
      "Content-Type: application/pdf; name*=UTF-8''%E6%8A%A5%E5%91%8A.pdf",
      'Content-Disposition: attachment;',
      "  filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf",
      'Content-Transfer-Encoding: base64',
      '',
      b64(Buffer.alloc(1000, 7)),
      '--outer',
      'Content-Type: application/vnd.ms-excel',
      "Content-Disposition: attachment; filename*0*=UTF-8''%E5%AD%A3%E5%BA%A6; filename*1*=%E6%8A%A5%E5%91%8A.xlsx",
      '',
      'xls-bytes',
      '--outer',
      'Content-Type: text/plain; name="=?UTF-8?B?5aSH5rOoLnR4dA==?="',
      'Content-Disposition: attachment',
      '',
      'a note',
      '--outer',
      'Content-Type: image/jpeg',
      'Content-Disposition: inline; filename*0="IMG_"; filename*1="0042.jpg"',
      'Content-Transfer-Encoding: base64',
      '',
      b64(Buffer.alloc(12, 2)),
      '--outer--',
      'epilogue',
    ]);
    const mail = parseMail(raw);
    expect(mail.text).toBe('报告见附件。');
    expect(mail.html).toBe('<p>报告见<b>附件</b>。<img src="cid:logo@x"></p>');
    expect(mail.attachments).toEqual([
      { mime: 'image/png', size: 30, contentId: 'logo@x', inline: true },
      { filename: '报告.pdf', mime: 'application/pdf', size: 1000, inline: false },
      { filename: '季度报告.xlsx', mime: 'application/vnd.ms-excel', size: 9, inline: false },
      { filename: '备注.txt', mime: 'text/plain', size: 6, inline: false },
      { filename: 'IMG_0042.jpg', mime: 'image/jpeg', size: 12, inline: false },
    ]);
    expect(parseParams('attachment; filename="a \\"b\\".txt"; size=12').params).toEqual({ filename: 'a "b".txt', size: '12' });
  });

  it('keeps what arrived of a message cut short (no closing boundary)', () => {
    const mail = parseMail(crlf(['Content-Type: multipart/mixed; boundary=b', '', '--b', 'Content-Type: text/plain', '', 'the text', '--b', 'Content-Type: application/zip; name=big.zip', 'Content-Transfer-Encoding: base64', '', 'AAAA']));
    expect(mail.text).toBe('the text');
    expect(mail.attachments).toEqual([{ filename: 'big.zip', mime: 'application/zip', size: 3, inline: false }]);
  });
});

/* ----------------------------- quote stripping ---------------------------- */

describe('quote stripping', () => {
  it('drops the quoted earlier message from plain-text replies', () => {
    const gmail = 'Sounds good, see you then.\n\nOn Mon, Nov 9, 2026 at 10:00 AM Ann Lee <ann@example.com> wrote:\n\n> Shall we meet on Tuesday?\n> \n> Ann\n';
    expect(stripQuotedText(gmail)).toEqual({ text: 'Sounds good, see you then.', stripped: true });
    const wrapped = 'Yes.\n\nOn Mon, Nov 9, 2026 at 10:00 AM Ann Lee <\nann@example.com> wrote:\n> Shall we?';
    expect(stripQuotedText(wrapped).text).toBe('Yes.');
    const chinese = '好的，明天见。\r\n\r\n在 2026年11月9日 10:00，张三 <zhang@example.com> 写道：\r\n> 明天开会吗？\r\n';
    expect(stripQuotedText(chinese).text).toBe('好的，明天见。');
    const gmailZh = '收到。\n\nAnn Lee <ann@example.com> 于2026年11月9日周一 10:00写道：\n\n> 请看附件\n';
    expect(stripQuotedText(gmailZh).text).toBe('收到。');
    const outlook = 'Approved.\n\nBest,\nBob\n\n-----Original Message-----\nFrom: Carol <carol@example.com>\nSent: Monday, November 9, 2026 10:00 AM\nTo: Bob\nSubject: Budget\n\nPlease approve the budget.';
    expect(stripQuotedText(outlook).text).toBe('Approved.\n\nBest,\nBob');
    const outlookRule = 'Done.\n\n________________________________\nFrom: Carol <carol@example.com>\nSent: Monday, November 9, 2026 10:00 AM\nTo: Bob\n\nCan you do it?';
    expect(stripQuotedText(outlookRule).text).toBe('Done.');
    const qq = '收到，谢谢！\n\n\n------------------ 原始邮件 ------------------\n发件人: "李四"<li@qq.com>;\n发送时间: 2026年11月9日(星期一) 上午10:00\n收件人: "me"<me@qq.com>;\n主题: 报价\n\n请查收报价。';
    expect(stripQuotedText(qq).text).toBe('收到，谢谢！');
    const netease = '可以。\n\n发件人：李四 <li@163.com>\n发送时间：2026-11-09 10:00\n收件人：me@163.com\n主题：报价\n\n请确认。';
    expect(stripQuotedText(netease).text).toBe('可以。');
    // an unquoted copy after a dated attribution
    const pasted = 'Agreed.\n\nOn 2026-11-09 10:00, Ann wrote:\nShall we ship it?';
    expect(stripQuotedText(pasted).text).toBe('Agreed.');
  });

  it('keeps inline replies, forwards, prose that says "wrote:", and mails that are all quote', () => {
    const inline = 'Answers inline.\n\nOn Mon, Nov 9, 2026 at 10:00 AM Ann <ann@example.com> wrote:\n> Budget?\nYes, approved.\n> Date?\nTuesday.';
    expect(stripQuotedText(inline)).toEqual({ text: inline, stripped: false });
    const forward = 'FYI\n\n-----Original Message-----\nFrom: Carol <carol@example.com>\nSent: Monday\nTo: Bob\n\nThe numbers.';
    expect(stripQuotedText(forward, { forward: true }).stripped).toBe(false);
    const gmailForward = 'See below.\n\n---------- Forwarded message ---------\nFrom: Ann <ann@example.com>\nDate: Mon, Nov 9, 2026 at 10:00 AM\nSubject: Numbers\n\nThe numbers.';
    expect(stripQuotedText(gmailForward).stripped).toBe(false);
    const prose = 'Here is what the author wrote:\nThe sea was calm.';
    expect(stripQuotedText(prose).stripped).toBe(false);
    const onlyQuote = 'On Mon, Nov 9, 2026 at 10:00 AM Ann <ann@example.com> wrote:\n> hello';
    expect(stripQuotedText(onlyQuote).stripped).toBe(false);
    // the trailing quote of an inline reply still goes
    expect(stripQuotedText('Yes.\n> Date?\nTuesday.\n\n> rest of it\n> more').text).toBe('Yes.\n> Date?\nTuesday.');
  });

  it('cuts HTML quotes only in the shapes that are reliable', () => {
    const gmail = '<div dir="ltr">Sounds good</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, Nov 9, 2026 at 10:00 AM Ann &lt;<a href="mailto:ann@example.com">ann@example.com</a>&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0px">Shall we?<div><div>nested</div></div></blockquote></div>';
    expect(stripQuotedHtml(gmail)).toBe('<div dir="ltr">Sounds good</div><br>');
    const gmailForward = '<div dir="ltr">FYI</div><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: Ann</div><br>The numbers.</div>';
    expect(stripQuotedHtml(gmailForward)).toBe(gmailForward);
    const gmailInline = '<div dir="ltr">See below</div><div class="gmail_quote"><div class="gmail_attr">On … wrote:</div><blockquote class="gmail_quote">Budget?</blockquote><div>Approved.</div><blockquote class="gmail_quote">Date?</blockquote></div>';
    expect(stripQuotedHtml(gmailInline)).toBe(gmailInline);
    const apple = '<html><body><div>Yes.</div><div><br><div>On Nov 9, 2026, at 10:00, Ann &lt;ann@example.com&gt; wrote:<br><br></div><blockquote type="cite"><div>Shall we?</div><blockquote type="cite">older</blockquote></blockquote></div></body></html>';
    expect(stripQuotedHtml(apple)).toBe('<html><body><div>Yes.</div><div><br></div></body></html>');
    const thunderbird = '<p>Fine.</p><div class="moz-cite-prefix">On 11/9/26 10:00, Ann wrote:<br></div><blockquote type="cite" cite="mid:x@y">Shall we?</blockquote>';
    expect(stripQuotedHtml(thunderbird)).toBe('<p>Fine.</p>');
    const appleInline = '<div>See below</div><blockquote type="cite">Budget?</blockquote><div>Approved.</div>';
    expect(stripQuotedHtml(appleInline)).toBe(appleInline);
    expect(stripQuotedHtml(apple, { forward: true })).toBe(apple);
  });
});

/* ------------------------------ IMAP pieces ------------------------------ */

describe('IMAP helpers', () => {
  it('tokenizes data with literals, nested brackets and NIL; writes sets and mailbox names', () => {
    const lit = Buffer.from('é\r\n', 'utf8');
    expect(tokenize('(UID 7 FLAGS (\\Seen $Junk) BODY[HEADER.FIELDS (SUBJECT FROM)]<0> \x000\x00 X "a \\"q\\"" Y NIL)', [lit])).toEqual([
      ['UID', '7', 'FLAGS', ['\\Seen', '$Junk'], 'BODY[HEADER.FIELDS (SUBJECT FROM)]<0>', lit, 'X', 'a "q"', 'Y', null],
    ]);
    expect(uidSet([9, 1, 2, 3, 5, 7, 8, 3])).toBe('1:3,5,7:9');
    expect(encodeMailbox('已发送')).toBe('&XfJT0ZAB-');
    expect(encodeMailbox('Tom & Jerry')).toBe('Tom &- Jerry');
    expect(encodeMailbox('[Gmail]/Sent Mail')).toBe('[Gmail]/Sent Mail');
    expect(imapDate(new Date('2026-11-09T12:00:00Z'))).toBe('09-Nov-2026');
  });

  it('gives up on a server that never answers', async () => {
    const silent = net.createServer(() => {});
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    const port = (silent.address() as net.AddressInfo).port;
    try {
      await expect(ImapClient.connect({ host: '127.0.0.1', port, tls: false, timeoutMs: 200 })).rejects.toThrow(/did not answer within/);
    } finally {
      silent.close();
    }
  });
});

/* ---------------------------- fake IMAP server ---------------------------- */

interface FakeMessage {
  uid: number;
  raw: string | Buffer;
  /** INTERNALDATE. */
  date: string;
  flags?: string[];
  thrid?: string;
}

interface FakeBox {
  uidValidity: number;
  messages: FakeMessage[];
  /** Leave UIDNEXT out of EXAMINE (some servers do). */
  noUidNext?: boolean;
}

/**
 * Just enough of an IMAP server: greeting, CAPABILITY, LOGIN (quoted or
 * literal arguments, with a continuation), AUTHENTICATE XOAUTH2, ID, EXAMINE,
 * UID SEARCH (SINCE, UID n:* — with the real "*" quirk), UID FETCH (partial
 * BODY.PEEK[]), LOGOUT. Every command is logged.
 */
class FakeImap {
  boxes: Record<string, FakeBox> = {};
  commands: string[] = [];
  caps = ['IMAP4rev1', 'ID', 'AUTH=XOAUTH2', 'SASL-IR'];
  user = 'me@example.com';
  password = 'pa"ss\\word';
  token = 'ya29.token';
  /** Send answers a few bytes at a time. */
  dribble = false;
  port = 0;
  private readonly sockets = new Set<net.Socket>();
  private readonly server = net.createServer((s) => this.session(s));

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as net.AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise((r) => this.server.close(r));
  }

  private session(sock: net.Socket): void {
    this.sockets.add(sock);
    sock.on('close', () => this.sockets.delete(sock));
    sock.on('error', () => {});
    const send = (data: string | Buffer) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      if (!this.dribble) return void sock.write(buf);
      for (let i = 0; i < buf.length; i += 5) sock.write(buf.subarray(i, i + 5));
    };
    let buf = Buffer.alloc(0);
    let acc = '';
    let lits: Buffer[] = [];
    let need = -1;
    let box: FakeBox | null = null;
    let auth: { tag: string; stage: 'token' | 'error' } | null = null;

    const checkToken = (tag: string, b64token: string) => {
      const expected = `user=${this.user}\x01auth=Bearer ${this.token}\x01\x01`;
      if (Buffer.from(b64token, 'base64').toString('utf8') === expected) {
        auth = null;
        send(`${tag} OK Success\r\n`);
      } else {
        auth = { tag, stage: 'error' };
        send(`+ ${b64(JSON.stringify({ status: '401', schemes: 'bearer' }))}\r\n`);
      }
    };

    const handle = (line: string, literals: Buffer[]) => {
      if (auth) {
        if (auth.stage === 'token') checkToken(auth.tag, line);
        else {
          send(`${auth.tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`);
          auth = null;
        }
        return;
      }
      const sp = line.indexOf(' ');
      const tag = line.slice(0, sp);
      const rest = line.slice(sp + 1);
      this.commands.push(rest);
      const args = tokenize(rest, literals);
      const str = (v: unknown) => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));
      const cmd = str(args[0]).toUpperCase();
      if (cmd === 'CAPABILITY') return send(`* CAPABILITY ${this.caps.join(' ')}\r\n${tag} OK done\r\n`);
      if (cmd === 'ID') return send(`* ID NIL\r\n${tag} OK ID completed\r\n`);
      if (cmd === 'NOOP') return send(`${tag} OK\r\n`);
      if (cmd === 'LOGOUT') {
        send(`* BYE see you\r\n${tag} OK bye\r\n`);
        return void sock.end();
      }
      if (cmd === 'LOGIN') {
        if (str(args[1]) === this.user && str(args[2]) === this.password) return send(`${tag} OK Logged in\r\n`);
        return send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`);
      }
      if (cmd === 'AUTHENTICATE') {
        if (args[2] !== undefined) return checkToken(tag, str(args[2]));
        auth = { tag, stage: 'token' };
        return send('+ \r\n');
      }
      if (cmd === 'EXAMINE') {
        const name = str(args[1]);
        box = this.boxes[name] ?? null;
        if (!box) return send(`${tag} NO [NONEXISTENT] Mailbox doesn't exist: ${name}\r\n`);
        const max = Math.max(0, ...box.messages.map((m) => m.uid));
        return send(
          `* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n* ${box.messages.length} EXISTS\r\n* 0 RECENT\r\n` +
            `* OK [UIDVALIDITY ${box.uidValidity}] UIDs valid\r\n${box.noUidNext ? '' : `* OK [UIDNEXT ${max + 1}] Predicted next UID\r\n`}` +
            `${tag} OK [READ-ONLY] EXAMINE completed\r\n`,
        );
      }
      if (cmd === 'UID' && box) {
        const sub = str(args[1]).toUpperCase();
        const msgs = [...box.messages].sort((a, b) => a.uid - b.uid);
        const max = msgs.length ? msgs[msgs.length - 1].uid : 0;
        if (sub === 'SEARCH') {
          let found: number[] = [];
          const key = str(args[2]).toUpperCase();
          if (key === 'SINCE') {
            const since = parseMailDate(`${str(args[3])} 00:00:00 +0000`)!.getTime();
            found = msgs.filter((m) => parseMailDate(m.date)!.getTime() >= since).map((m) => m.uid);
          } else if (key === 'UID') {
            const [a, b] = str(args[3]).split(':');
            const lo = Number(a);
            const hi = b === '*' ? max : Number(b ?? a);
            found = msgs.filter((m) => m.uid >= Math.min(lo, hi) && m.uid <= Math.max(lo, hi)).map((m) => m.uid);
            // RFC 3501: "n:*" always includes the highest UID, even when it is below n
            if (b === '*' && !found.length && max) found = [max];
          }
          return send(`* SEARCH${found.map((u) => ` ${u}`).join('')}\r\n${tag} OK SEARCH completed\r\n`);
        }
        if (sub === 'FETCH') {
          const wanted = new Set<number>();
          for (const part of str(args[2]).split(',')) {
            const [a, b] = part.split(':').map((x) => (x === '*' ? max : Number(x)));
            for (let u = Math.min(a, b ?? a); u <= Math.max(a, b ?? a); u++) wanted.add(u);
          }
          const items = (args[3] as string[]).map(String);
          const bodyItem = items.find((i) => /^BODY(\.PEEK)?\[\]/i.test(i)) ?? '';
          const cut = /<0\.(\d+)>$/.exec(bodyItem);
          msgs.forEach((m, i) => {
            if (!wanted.has(m.uid)) return;
            const raw = Buffer.isBuffer(m.raw) ? m.raw : Buffer.from(m.raw, 'utf8');
            const body = cut ? raw.subarray(0, Number(cut[1])) : raw;
            const head = `* ${i + 1} FETCH (UID ${m.uid} FLAGS (${(m.flags ?? []).join(' ')}) INTERNALDATE "${m.date}" RFC822.SIZE ${raw.length} ${cut ? 'BODY[]<0>' : 'BODY[]'} {${body.length}}\r\n`;
            const tail = `${items.includes('X-GM-THRID') && m.thrid ? ` X-GM-THRID ${m.thrid}` : ''})\r\n`;
            send(Buffer.concat([Buffer.from(head, 'latin1'), body, Buffer.from(tail, 'latin1')]));
          });
          return send(`${tag} OK FETCH completed\r\n`);
        }
      }
      if (cmd === 'SELECT') return send(`${tag} OK [READ-WRITE] SELECT completed\r\n`);
      return send(`${tag} BAD Unknown command\r\n`);
    };

    send(`* OK [CAPABILITY ${this.caps.filter((c) => c !== 'X-GM-EXT-1').join(' ')}] fake IMAP ready\r\n`);
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (need >= 0) {
          if (buf.length < need) return;
          lits.push(Buffer.from(buf.subarray(0, need)));
          acc += `\x00${lits.length - 1}\x00`;
          buf = buf.subarray(need);
          need = -1;
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.toString('latin1', 0, nl);
        buf = buf.subarray(nl + 2);
        const lit = /\{(\d+)(\+?)\}$/.exec(line);
        if (lit) {
          acc += line.slice(0, lit.index);
          need = Number(lit[1]);
          if (!lit[2]) send('+ go ahead\r\n');
          continue;
        }
        const full = acc + line;
        const literals = lits;
        acc = '';
        lits = [];
        handle(full, literals);
      }
    });
  }
}

/* ------------------------------ mail fixtures ----------------------------- */

function message(h: Record<string, string>, body: string | string[], contentType = 'text/plain; charset=utf-8'): string {
  const headers = Object.entries(h).map(([k, v]) => `${k}: ${v}`);
  return crlf([...headers, 'MIME-Version: 1.0', ...(contentType ? [`Content-Type: ${contentType}`] : []), '', ...(Array.isArray(body) ? body : [body]), '']);
}

const ROOT = message(
  {
    From: '"Ann Lee" <Ann@Example.com>',
    To: 'Me <me@example.com>',
    Cc: 'bob@example.com',
    Subject: `=?UTF-8?B?${b64('季度计划')}?=`,
    Date: 'Mon, 2 Nov 2026 09:00:00 +0800',
    'Message-ID': '<root@example.com>',
  },
  ['--a', 'Content-Type: text/plain; charset=utf-8', '', 'The plan for Q1.', '--a', 'Content-Type: text/html; charset=utf-8', '', '<p>The plan for <b>Q1</b>.</p>', '--a--'],
  'multipart/alternative; boundary=a',
);

const REPLY = message(
  {
    From: 'Me <me@example.com>',
    To: 'Ann Lee <ann@example.com>',
    Subject: `Re: =?UTF-8?B?${b64('季度计划')}?=`,
    Date: 'Tue, 3 Nov 2026 10:00:00 +0000',
    'Message-ID': '<reply1@example.com>',
    'In-Reply-To': '<root@example.com>',
    References: '<root@example.com>',
  },
  [
    '--a',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Looks good.',
    '',
    'On Mon, Nov 2, 2026 at 9:00 AM Ann Lee <ann@example.com> wrote:',
    '> The plan for Q1.',
    '--a',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<div>Looks good.</div><div class="gmail_quote"><blockquote>The plan for Q1.</blockquote></div>',
    '--a--',
  ],
  'multipart/alternative; boundary=a',
);

const NEWSLETTER = message(
  {
    From: 'Example News <noreply@news.example.com>',
    To: 'me@example.com',
    Subject: 'Weekly digest',
    Date: 'Wed, 4 Nov 2026 08:00:00 +0000',
    'Message-ID': '<digest-45@news.example.com>',
    'List-Id': 'Example News <news.example.com>',
  },
  [
    '--m',
    'Content-Type: multipart/related; boundary=r',
    '',
    '--r',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '<h1>Digest</h1><p>Caf=C3=A9 news</p><img src=3D"cid:logo">',
    '--r',
    'Content-Type: image/png',
    'Content-ID: <logo>',
    'Content-Transfer-Encoding: base64',
    '',
    b64(Buffer.alloc(9)),
    '--r--',
    '--m',
    "Content-Type: application/pdf; name*=UTF-8''%E6%8A%A5%E5%91%8A.pdf",
    'Content-Disposition: attachment',
    'Content-Transfer-Encoding: base64',
    '',
    b64(Buffer.alloc(300, 1)),
    '--m',
    'Content-Type: image/jpeg; name=chart.jpg',
    'Content-Disposition: attachment; filename=chart.jpg',
    'Content-Transfer-Encoding: base64',
    '',
    b64(Buffer.alloc(60, 2)),
    '--m--',
  ],
  'multipart/mixed; boundary=m',
);

const OLD = message({ From: 'old@example.com', Subject: 'Old', Date: 'Tue, 20 Oct 2026 08:00:00 +0000', 'Message-ID': '<old@example.com>' }, 'old');

const NO_ID = message({ From: 'Bob <bob@example.com>', Subject: 'No id here', Date: 'Thu, 5 Nov 2026 08:00:00 +0000' }, 'plain body');

const GBK_REPLY = Buffer.concat([
  Buffer.from(
    crlf([
      'From: =?gb2312?B?wO7LxA==?= <li@163.com>',
      'To: me@example.com',
      `Subject: =?GBK?B?${b64(Buffer.concat([Buffer.from('Re: ', 'latin1'), GBK_NIHAO_ZHONGWEN_YOUJIAN]))}?=`,
      'Date: Fri, 6 Nov 2026 08:00:00 +0800',
      'Message-ID: <li-2@163.com>',
      'In-Reply-To: <reply1@example.com>',
      'References: <root@example.com> <reply1@example.com>',
      'Content-Type: text/plain; charset=GBK',
      'Content-Transfer-Encoding: base64',
      '',
      '',
    ]),
    'latin1',
  ),
  Buffer.from(b64(GBK_NIHAO_ZHONGWEN_YOUJIAN), 'latin1'),
  Buffer.from('\r\n', 'latin1'),
]);

/** An INTERNALDATE some days before now. */
function daysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${String(d.getUTCDate()).padStart(2, '0')}-${mon}-${d.getUTCFullYear()} ${d.toISOString().slice(11, 19)} +0000`;
}

const plain = (n: number, day: number) =>
  message({ From: `sender${n}@example.com`, Subject: `Message ${n}`, Date: `${day} Nov 2026 08:00:00 +0000`, 'Message-ID': `<m${n}@example.com>` }, `Body ${n}`);

/* --------------------------------- pulls --------------------------------- */

const SINCE = new Date('2026-11-01T00:00:00Z');

function feedOf(params: Record<string, unknown>): FeedDefinition {
  return {
    id: 'mail', title: 'Mail', description: '', connector: 'email', params, enabled: true, schedule: {}, units: { by: 'thread' }, filter: [], filterDefault: 'keep',
    transform: [], render: { period: 'item' }, maxModelCalls: 0, attachments: { download: false, maxBytes: 0 }, trust: 'trusted', path: '',
  };
}

describe('email connector against a fake IMAP server', () => {
  const fake = new FakeImap();
  const logs: string[] = [];
  beforeAll(() => fake.start());
  afterAll(() => fake.stop());
  afterEach(() => {
    fake.dribble = false;
    fake.caps = ['IMAP4rev1', 'ID', 'AUTH=XOAUTH2', 'SASL-IR'];
  });

  const ctxOf = (params: Record<string, unknown>, state?: unknown, opts: { since?: Date | null; signal?: AbortSignal } = {}): ConnectorContext => ({
    dataDir: '/nonexistent',
    config: {} as KnodeConfig,
    feed: feedOf({ host: '127.0.0.1', port: fake.port, tls: false, user: fake.user, password: 'env:KNODE_TEST_MAIL_PASSWORD', ...params }),
    state,
    since: opts.since === undefined ? (state === undefined ? SINCE : null) : opts.since,
    fetch: async () => {
      throw new Error('fetch is not used by the email connector');
    },
    secret: (v) => (typeof v === 'string' && v.startsWith('env:') ? process.env[v.slice(4)] ?? '' : v === undefined || v === null ? '' : String(v)),
    log: (m) => logs.push(m),
    signal: opts.signal ?? new AbortController().signal,
  });
  const pull = (params: Record<string, unknown>, state?: unknown, opts?: { since?: Date | null; signal?: AbortSignal }) => emailConnector.pull!(ctxOf(params, state, opts));
  const byId = (r: PullResult) => new Map(r.items.map((i) => [i.id, i] as [string, FeedItem]));
  const commandsSince = (n: number) => fake.commands.slice(n);

  beforeAll(() => {
    process.env.KNODE_TEST_MAIL_PASSWORD = fake.password;
  });

  it('declares its params and defaults', () => {
    expect(emailConnector.id).toBe('email');
    expect(emailConnector.platform).toBe('email');
    expect(emailConnector.params.map((p) => p.name)).toEqual(['host', 'port', 'tls', 'user', 'password', 'accessToken', 'mailboxes', 'maxPerPull', 'stripQuotes']);
    expect(emailConnector.params.find((p) => p.name === 'password')?.type).toBe('secret');
    expect(emailConnector.defaults).toMatchObject({ units: { by: 'thread' }, render: { period: 'item' }, schedule: { every: '15m' }, backfillDays: 14 });
    expect(emailConnector.minIntervalMinutes).toBe(2);
  });

  it('reads a mailbox into items, then only what is new, without writing to the server', async () => {
    fake.boxes.INBOX = {
      uidValidity: 100,
      messages: [
        { uid: 1, raw: OLD, date: '20-Oct-2026 08:00:00 +0000' },
        { uid: 2, raw: ROOT, date: '02-Nov-2026 01:00:05 +0000', flags: ['\\Seen'] },
        { uid: 3, raw: REPLY, date: '03-Nov-2026 10:00:05 +0000' },
        { uid: 4, raw: NEWSLETTER, date: '04-Nov-2026 08:00:05 +0000' },
      ],
    };
    const n0 = fake.commands.length;
    const first = await pull({});
    expect(first.error).toBeUndefined();
    expect(first.more).toBe(false);
    expect(first.state).toEqual({ mailboxes: { INBOX: { uidValidity: 100, lastUid: 4 } } });
    expect(first.items.map((i) => i.id)).toEqual(['root@example.com', 'reply1@example.com', 'digest-45@news.example.com']);
    const items = byId(first);

    const root = items.get('root@example.com')!;
    expect(root).toMatchObject({
      title: '季度计划',
      author: { name: 'Ann Lee', id: 'ann@example.com' },
      channel: { id: 'INBOX', name: 'INBOX', kind: 'mailbox' },
      publishedAt: '2026-11-02T01:00:00.000Z',
      html: '<p>The plan for <b>Q1</b>.</p>',
      threadId: 'root@example.com',
      dedupeKey: 'email:root@example.com',
      meta: { to: ['me@example.com'], cc: ['bob@example.com'], uid: 2, mailbox: 'INBOX', automated: false },
    });
    expect(root.text).toBeUndefined();

    // a reply: its stripped plain text instead of the HTML that repeats the thread
    const reply = items.get('reply1@example.com')!;
    expect(reply).toMatchObject({ title: 'Re: 季度计划', text: 'Looks good.', threadId: 'root@example.com', replyTo: 'root@example.com', meta: { quoteStripped: true } });
    expect(reply.html).toBeUndefined();

    const digest = items.get('digest-45@news.example.com')!;
    expect(digest.html).toBe('<h1>Digest</h1><p>Café news</p><img src="cid:logo">');
    expect(digest.attachments).toEqual([
      { kind: 'file', name: '报告.pdf', mime: 'application/pdf', bytes: 300 },
      { kind: 'image', name: 'chart.jpg', mime: 'image/jpeg', bytes: 60 },
    ]);
    expect(digest.meta).toMatchObject({ automated: true, listId: 'news.example.com' });

    const firstCommands = commandsSince(n0);
    expect(firstCommands).toContain('UID SEARCH SINCE 01-Nov-2026');
    expect(firstCommands).toContain('UID FETCH 2:4 (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[]<0.10485760>)');
    // the password went quoted, its quote and backslash escaped
    expect(firstCommands).toContain('LOGIN "me@example.com" "pa\\"ss\\\\word"');

    // new mail, plus one that lacks a Message-ID
    fake.boxes.INBOX.messages.push({ uid: 7, raw: NO_ID, date: '05-Nov-2026 08:00:00 +0000' }, { uid: 8, raw: GBK_REPLY, date: '06-Nov-2026 00:00:01 +0000' });
    const n1 = fake.commands.length;
    const second = await pull({}, first.state);
    expect(second.items.map((i) => i.id)).toEqual(['INBOX:100:7', 'li-2@163.com']);
    const gbk = byId(second).get('li-2@163.com')!;
    expect(gbk).toMatchObject({ title: 'Re: 你好中文邮件', author: { name: '李四', id: 'li@163.com' }, text: '你好中文邮件', threadId: 'root@example.com', replyTo: 'reply1@example.com' });
    const noId = byId(second).get('INBOX:100:7')!;
    expect(noId).toMatchObject({ title: 'No id here', text: 'plain body', author: { name: 'Bob', id: 'bob@example.com' } });
    expect(noId.threadId).toBeUndefined();
    expect(noId.dedupeKey).toBeUndefined();
    expect(second.state).toEqual({ mailboxes: { INBOX: { uidValidity: 100, lastUid: 8 } } });
    const secondCommands = commandsSince(n1);
    expect(secondCommands).toContain('UID SEARCH UID 5:*');
    expect(secondCommands.filter((c) => c.startsWith('UID FETCH'))).toEqual(['UID FETCH 7:8 (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[]<0.10485760>)']);

    // nothing new: UIDNEXT says so, and no search is made
    const n2 = fake.commands.length;
    const third = await pull({}, second.state);
    expect(third.items).toEqual([]);
    expect(commandsSince(n2).some((c) => c.startsWith('UID SEARCH') || c.startsWith('UID FETCH'))).toBe(false);

    // a server that does not report UIDNEXT: "9:*" answers the highest UID (8), which is not new
    fake.boxes.INBOX.noUidNext = true;
    const fourth = await pull({}, second.state);
    expect(fourth.items).toEqual([]);
    expect(fourth.state).toEqual(second.state);
    fake.boxes.INBOX.noUidNext = false;

    // read-only throughout: EXAMINE, BODY.PEEK, never SELECT / STORE / EXPUNGE / COPY / MOVE / APPEND
    expect(fake.commands.some((c) => /^(SELECT|STORE|UID STORE|EXPUNGE|UID EXPUNGE|COPY|UID COPY|MOVE|UID MOVE|APPEND|DELETE)\b/i.test(c))).toBe(false);
    expect(fake.commands.filter((c) => c.startsWith('UID FETCH')).every((c) => c.includes('BODY.PEEK[]'))).toBe(true);
    expect(fake.commands.filter((c) => c.startsWith('EXAMINE')).length).toBeGreaterThan(0);
  });

  it('reads a renumbered mailbox (new UIDVALIDITY) again from the horizon', async () => {
    // INTERNALDATEs within the last week of the real clock: the horizon below is "seven days back from now"
    fake.boxes.INBOX = { uidValidity: 200, messages: [{ uid: 1, raw: ROOT, date: daysAgo(3) }, { uid: 2, raw: plain(9, 7), date: daysAgo(0) }, { uid: 3, raw: OLD, date: daysAgo(30) }] };
    logs.length = 0;
    const n0 = fake.commands.length;
    const res = await pull({}, { mailboxes: { INBOX: { uidValidity: 100, lastUid: 8 } } }, { since: null });
    expect(res.items.map((i) => i.id)).toEqual(['root@example.com', 'm9@example.com']);
    expect(res.state).toEqual({ mailboxes: { INBOX: { uidValidity: 200, lastUid: 3 } } });
    expect(res.notes?.some((n) => /renumbered.*100 → 200/.test(n))).toBe(true);
    expect(logs.some((l) => /UIDVALIDITY/.test(l))).toBe(true);
    // no horizon from the run: the last seven days
    expect(commandsSince(n0).some((c) => /^UID SEARCH SINCE \d\d-\w{3}-\d{4}$/.test(c))).toBe(true);
  });

  it('stops at maxPerPull and says more is waiting; the next pulls continue where it stopped', async () => {
    fake.boxes.INBOX = { uidValidity: 300, messages: [1, 2, 3, 4, 5].map((n) => ({ uid: n * 10, raw: plain(n, n + 1), date: `0${n + 1}-Nov-2026 08:00:00 +0000` })) };
    fake.dribble = true;
    const a = await pull({ maxPerPull: 2 });
    expect(a.items.map((i) => i.title)).toEqual(['Message 1', 'Message 2']);
    expect(a.more).toBe(true);
    expect(a.state).toEqual({ mailboxes: { INBOX: { uidValidity: 300, lastUid: 20 } } });
    const b = await pull({ maxPerPull: 2 }, a.state);
    expect(b.items.map((i) => i.title)).toEqual(['Message 3', 'Message 4']);
    expect(b.more).toBe(true);
    const c = await pull({ maxPerPull: 2 }, b.state);
    expect(c.items.map((i) => i.title)).toEqual(['Message 5']);
    expect(c.more).toBe(false);
    expect(c.state).toEqual({ mailboxes: { INBOX: { uidValidity: 300, lastUid: 50 } } });
  });

  it('fetches in batches and cuts a huge message to its first bytes', async () => {
    const big = message({ From: 'big@example.com', Subject: 'Big', Date: '8 Nov 2026 08:00:00 +0000', 'Message-ID': '<big@example.com>' }, [
      '--b', 'Content-Type: text/plain', '', 'see attached', '--b', 'Content-Type: application/octet-stream; name=huge.bin', 'Content-Transfer-Encoding: base64', '', ...Array(200_000).fill('A'.repeat(76)), '--b--',
    ], 'multipart/mixed; boundary=b');
    fake.boxes.INBOX = {
      uidValidity: 400,
      messages: [...Array.from({ length: 120 }, (_, k) => ({ uid: k + 1, raw: plain(k + 1, 2), date: '02-Nov-2026 08:00:00 +0000' })), { uid: 121, raw: big, date: '08-Nov-2026 08:00:00 +0000' }],
    };
    const n0 = fake.commands.length;
    const res = await pull({});
    expect(res.items).toHaveLength(121);
    expect(commandsSince(n0).filter((c) => c.startsWith('UID FETCH')).map((c) => c.split(' ')[2])).toEqual(['1:50', '51:100', '101:121']);
    const item = byId(res).get('big@example.com')!;
    expect(item.text).toBe('see attached');
    expect(item.meta).toMatchObject({ truncated: true });
    expect(item.attachments?.[0]).toMatchObject({ name: 'huge.bin' });
  });

  it("turns a server's NO into a readable error, keeping what other mailboxes gave", async () => {
    fake.boxes.INBOX = { uidValidity: 500, messages: [{ uid: 1, raw: plain(1, 2), date: '02-Nov-2026 08:00:00 +0000' }] };
    const res = await pull({ mailboxes: ['Archive', 'INBOX'] });
    expect(res.error).toBe("Archive: IMAP EXAMINE \"Archive\" failed: NO [NONEXISTENT] Mailbox doesn't exist: Archive");
    expect(res.items.map((i) => i.id)).toEqual(['m1@example.com']);
    expect(res.state).toEqual({ mailboxes: { INBOX: { uidValidity: 500, lastUid: 1 } } });

    await expect(pull({ password: 'wrong' })).rejects.toThrow('IMAP LOGIN failed: NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)');
    await expect(pull({ password: undefined })).rejects.toThrow(/params.password/);
    await expect(pull({ host: '' })).rejects.toThrow(/params.host is required/);

    const check = await emailConnector.check!(ctxOf({ password: 'wrong' }));
    expect(check).toEqual({ ok: false, message: 'IMAP LOGIN failed: NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)' });
  });

  it('checks a connection: signs in and counts the first mailbox', async () => {
    fake.boxes.INBOX = { uidValidity: 600, messages: [{ uid: 1, raw: plain(1, 2), date: '02-Nov-2026 08:00:00 +0000' }, { uid: 2, raw: plain(2, 3), date: '03-Nov-2026 08:00:00 +0000' }] };
    expect(await emailConnector.check!(ctxOf({}))).toEqual({ ok: true, message: 'me@example.com on 127.0.0.1: INBOX holds 2 message(s)' });
  });

  it('signs in with XOAUTH2, sends a non-ASCII password as a literal, and uses Gmail thread ids', async () => {
    fake.boxes.INBOX = { uidValidity: 700, messages: [{ uid: 1, raw: REPLY, date: '03-Nov-2026 10:00:05 +0000', thrid: '1782391233451234567' }] };
    fake.caps = ['IMAP4rev1', 'AUTH=XOAUTH2', 'SASL-IR', 'X-GM-EXT-1'];
    const res = await pull({ password: undefined, accessToken: fake.token });
    expect(res.items[0]).toMatchObject({ id: 'reply1@example.com', threadId: '1782391233451234567' });
    expect(fake.commands.some((c) => c.startsWith('UID FETCH') && c.includes('X-GM-THRID'))).toBe(true);
    await expect(pull({ password: undefined, accessToken: 'expired' })).rejects.toThrow(/AUTHENTICATIONFAILED.*"status":"401"/);

    // without SASL-IR the token follows a continuation
    fake.caps = ['IMAP4rev1', 'AUTH=XOAUTH2'];
    expect((await pull({ password: undefined, accessToken: fake.token })).items).toHaveLength(1);

    const saved = fake.password;
    fake.password = '密码 with "quotes"';
    try {
      const n0 = fake.commands.length;
      expect((await pull({ password: fake.password })).items).toHaveLength(1);
      expect(commandsSince(n0).find((c) => c.startsWith('LOGIN'))).toBe('LOGIN "me@example.com" \x000\x00');
    } finally {
      fake.password = saved;
    }
  });

  it('stops when the run is cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(pull({}, undefined, { signal: ac.signal })).rejects.toThrow(/cancelled/);
  });
});
