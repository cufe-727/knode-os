import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { KnodeConfig } from '../src/config.js';
import { FeishuError, LarkRunner, RunResult } from '../src/ingest/feishu/client.js';
import {
  ChatCursor,
  FEISHU_CHAT_SCOPES,
  feishuChatConnector,
  feishuMessageItems,
  missingChatScopes,
  parseLarkTime,
  parseRelayTimestamp,
  pullStart,
  renderFeishuContent,
  setFeishuChatRunner,
  foldCardPictures,
  relaySignature,
} from '../src/ingest/feeds/connectors/feishu-chat.js';
import { FeedLedger } from '../src/ingest/feeds/ledger.js';
import type { ConnectorContext, FeedDefinition, FeedItem } from '../src/ingest/feeds/types.js';

/**
 * The feishu-chat feed connector against a fake lark-cli: how each message
 * type becomes Markdown and attachments, recalls and edits, the per-chat
 * cursor with its look-back, the page limit, relay groups' timestamps, and
 * what a missing scope says.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-feishu-chat-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
afterEach(() => setFeishuChatRunner(null));

const DAY = 86_400_000;
const CHAT = 'oc_5c14a0b2e1f3d4c5b6a7980112233445';

/** lark-cli's create_time: "YYYY-MM-DD HH:MM" in this machine's zone. */
const larkTime = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi);

function message(id: string, at: Date, content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { message_id: id, msg_type: 'text', content, create_time: larkTime(at), deleted: false, updated: false, sender: { id: 'ou_a', id_type: 'open_id', sender_type: 'user', name: '王五' }, ...extra };
}

function ctxFor(params: Record<string, unknown>, state?: unknown, since: Date | null = null): ConnectorContext {
  const feed = {
    id: 'chat', title: 'Chat', description: '', connector: 'feishu-chat', params, enabled: true, schedule: {}, backfillDays: 3,
    units: { by: 'window', gapMinutes: 30 }, filter: [], filterDefault: 'keep', transform: [], render: { period: 'day' },
    maxModelCalls: 0, attachments: { download: true, maxBytes: 1024 * 1024 }, trust: 'trusted', path: '',
  } as FeedDefinition;
  return {
    dataDir: tmp,
    config: { ingest: {} } as unknown as KnodeConfig,
    feed,
    state,
    since,
    fetch: async () => {
      throw new Error('no network in tests');
    },
    secret: (v) => String(v ?? ''),
    log: () => {},
    signal: new AbortController().signal,
  };
}

const ok = (data: unknown, meta?: unknown): RunResult => ({ code: 0, stdout: JSON.stringify({ ok: true, identity: 'user', data, ...(meta ? { meta } : {}) }), stderr: '' });
const fail = (code: number, error: Record<string, unknown>): RunResult => ({ code, stdout: '', stderr: JSON.stringify({ ok: false, identity: 'user', error }) });

/** A lark-cli that serves one listing per chat and records what it was asked. */
class FakeLark {
  calls: string[][] = [];
  chats = new Map<string, { name: string; messages: Record<string, unknown>[]; hasMore?: boolean }>();
  failList = new Map<string, RunResult>();

  runner: LarkRunner = async (args, opts) => {
    this.calls.push(args);
    const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    if (args[0] === 'auth' && args[1] === 'status') {
      const user = { status: 'ready', available: true, userName: '王宁', openId: 'ou_me', tokenStatus: 'valid', scope: [...FEISHU_CHAT_SCOPES, 'offline_access'].join(' ') };
      return { code: 0, stdout: JSON.stringify({ appId: 'cli_test', brand: 'feishu', identities: { user } }), stderr: '' };
    }
    if (args[0] === 'im' && args[1] === 'chats' && args[2] === 'get') {
      const chat = this.chats.get(flag('--chat-id') ?? '');
      return chat ? ok({ name: chat.name, chat_mode: 'group' }) : fail(1, { type: 'api', code: 232011, message: 'operator not in chat' });
    }
    if (args[0] === 'im' && args[1] === '+chat-messages-list') {
      const id = flag('--chat-id') ?? '';
      const failure = this.failList.get(id);
      if (failure) return failure;
      const chat = this.chats.get(id);
      if (!chat) return fail(1, { type: 'api', message: 'chat not found' });
      const start = Number(flag('--start') ?? 0) * 1000;
      const asc = flag('--order') === 'asc';
      let list = chat.messages.filter((m) => (parseLarkTime(m.create_time)?.ms ?? 0) >= start);
      if (!asc) list = [...list].reverse();
      if (args.includes('--page-size') && flag('--page-size') === '1') list = list.slice(0, 1);
      return ok({ messages: list, total: list.length, has_more: chat.hasMore === true, page_token: chat.hasMore ? 'next' : '' }, { pagination: { complete: !chat.hasMore } });
    }
    if (args[0] === 'im' && args[1] === '+messages-resources-download') {
      // like lark-cli: a bare --output name gets its extension from the content type
      const out = path.join(opts.cwd ?? '.', `${flag('--output')}.png`);
      fs.writeFileSync(out, PNG);
      return ok({ saved_path: path.basename(out), size_bytes: PNG.length });
    }
    return fail(2, { type: 'validation', message: `unknown command ${args.join(' ')}` });
  };
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/* ------------------------------- rendering ------------------------------- */

describe('message content', () => {
  it('keeps text and names the mentions lark-cli left as keys', () => {
    const raw = renderFeishuContent('text', JSON.stringify({ text: '@_user_1 看这个 @_user_10' }), {
      messageId: 'om_1',
      mentions: [{ key: '@_user_1', id: 'ou_1', name: '张三' }, { key: '@_user_10', id: 'ou_10', name: '李四' }],
    });
    expect(raw.text).toBe('@张三 看这个 @李四');
    expect(raw.attachments).toEqual([]);
    expect(renderFeishuContent('text', '收盘了', { messageId: 'om_1' }).text).toBe('收盘了');
  });

  it('renders a post with its link, @mention and picture (lark-cli text and raw JSON alike)', () => {
    const rendered = renderFeishuContent('post', '地产政策\n看研报 [申万策略](https://example.com/r?id=1) <at user_id="ou_1">李四</at>\n![Image](img_v3_abc)', { messageId: 'om_2' });
    expect(rendered.text).toBe('地产政策\n看研报 [申万策略](https://example.com/r?id=1) @李四');
    expect(rendered.attachments).toEqual([{ kind: 'image', url: 'feishu:image:om_2:img_v3_abc' }]);

    const raw = {
      zh_cn: {
        title: '地产政策',
        content: [
          [{ tag: 'text', text: '看研报 ' }, { tag: 'a', text: '申万策略', href: 'https://example.com/r?id=1' }, { tag: 'text', text: ' ' }, { tag: 'at', user_id: 'ou_1', user_name: '李四' }],
          [{ tag: 'img', image_key: 'img_v3_abc' }],
        ],
      },
    };
    expect(renderFeishuContent('post', JSON.stringify(raw), { messageId: 'om_2' })).toEqual(rendered);
  });

  it('turns a card into its title and text, and its pictures into attachments', () => {
    const card = '<card title="混沌20000 \\"微博\\"">\n韩国股市高开回落，**抛压不大**\n🖼️ Image(img_key:img_v3_card)\n[查看原文](https://weibo.com/123/AbCdEf)\n</card>';
    const r = renderFeishuContent('interactive', card, { messageId: 'om_3' });
    expect(r.text).toBe('**混沌20000 "微博"**\n韩国股市高开回落，**抛压不大**\n\n[查看原文](https://weibo.com/123/AbCdEf)');
    expect(r.attachments).toEqual([{ kind: 'image', url: 'feishu:image:om_3:img_v3_card' }]);

    const raw = { header: { title: { tag: 'plain_text', content: '投星资产' } }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '今日观点' } }, { tag: 'img', img_key: 'img_v3_x' }] };
    const fromRaw = renderFeishuContent('interactive', JSON.stringify(raw), { messageId: 'om_3' });
    expect(fromRaw.text).toBe('**投星资产**\n今日观点');
    expect(fromRaw.attachments).toEqual([{ kind: 'image', url: 'feishu:image:om_3:img_v3_x' }]);
  });

  it('makes pictures, files, voice and video attachments, and skips stickers', () => {
    expect(renderFeishuContent('image', '[Image: img_v3_pic]', { messageId: 'om_4' })).toEqual({ text: '', attachments: [{ kind: 'image', url: 'feishu:image:om_4:img_v3_pic' }] });
    expect(renderFeishuContent('image', JSON.stringify({ image_key: 'img_v3_pic' }), { messageId: 'om_4' }).attachments).toEqual([{ kind: 'image', url: 'feishu:image:om_4:img_v3_pic' }]);
    expect(renderFeishuContent('file', '<file key="file_v3_doc" name="研报 2026.pdf"/>', { messageId: 'om_5' }).attachments).toEqual([{ kind: 'file', url: 'feishu:file:om_5:file_v3_doc', name: '研报 2026.pdf' }]);
    expect(renderFeishuContent('audio', '<audio key="file_v3_voice" duration="12s"/>', { messageId: 'om_6' }).attachments).toEqual([{ kind: 'audio', url: 'feishu:file:om_6:file_v3_voice', name: 'voice 12s' }]);
    expect(renderFeishuContent('media', '<video key="file_v3_vid" name="盘面.mp4" duration="30s" cover_image_key="img_v3_cover"/>', { messageId: 'om_7' }).attachments).toEqual([{ kind: 'video', url: 'feishu:file:om_7:file_v3_vid', name: '盘面.mp4' }]);
    expect(renderFeishuContent('sticker', '[Sticker]', { messageId: 'om_8' })).toEqual({ text: '', attachments: [] });
    // a key that looks like a path is never handed to lark-cli
    expect(renderFeishuContent('image', '[Image: ../../etc/passwd]', { messageId: 'om_9' }).attachments).toEqual([]);
  });

  it('quotes a forwarded bundle, its pictures fetched through the bundle', () => {
    const tree = '<forwarded_messages>\n[2026-09-29T20:21:31+08:00] 混沌20000:\n    地产重大利好\n    [Image: img_v3_fwd]\n[2026-09-29T20:25:00+08:00] V+:\n    确实\n</forwarded_messages>';
    const r = renderFeishuContent('merge_forward', tree, { messageId: 'om_bundle' });
    expect(r.text).toBe('> **混沌20000** · 2026-09-29 20:21\n> 地产重大利好\n>\n> **V+** · 2026-09-29 20:25\n> 确实');
    expect(r.attachments).toEqual([{ kind: 'image', url: 'feishu:image:om_bundle:img_v3_fwd' }]);
  });
});

/* --------------------------------- items --------------------------------- */

describe('messages as items', () => {
  const chat = { id: CHAT, name: '混沌' };

  it('maps sender, channel, reactions, mentions, threads and system messages', () => {
    const at = local(2026, 11, 9, 10, 21);
    const { items, lastMs } = feishuMessageItems(
      [
        message('om_root', at, '<at user_id="ou_b">赵六</at> 怎么看', {
          thread_id: 'omt_1',
          mentions: [{ key: '@_user_1', id: 'ou_b', name: '赵六' }],
          reactions: { counts: [{ reaction_type: 'THUMBSUP', count: 3 }], details: [] },
          message_app_link: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_x&position=12',
          thread_replies: [
            message('om_root', at, '<at user_id="ou_b">赵六</at> 怎么看', { thread_id: 'omt_1' }),
            message('om_reply', local(2026, 11, 9, 10, 40), '看多', { thread_id: 'omt_1', sender: { id: 'ou_b', name: '赵六' } }),
          ],
        }),
        message('om_quote', local(2026, 11, 9, 10, 30), '同意', { reply_to: 'om_root' }),
        { message_id: 'om_sys', msg_type: 'system', content: '王五 邀请 赵六 加入群聊', create_time: larkTime(local(2026, 11, 9, 10, 31)), deleted: false, updated: false, sender: { id: '', sender_type: '' } },
      ],
      chat,
    );
    expect(items.map((i) => i.id)).toEqual(['om_root', 'om_reply', 'om_quote', 'om_sys']);
    const [root, reply, quote, sys] = items;
    expect(root).toMatchObject({
      publishedAt: at.toISOString(),
      author: { id: 'ou_a', name: '王五' },
      channel: { id: CHAT, name: '混沌', kind: 'group' },
      text: '@赵六 怎么看',
      threadId: 'omt_1',
      url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_x&position=12',
      meta: { msgType: 'text', senderType: 'user', mentions: ['赵六'], reactions: { THUMBSUP: 3 } },
    });
    expect(reply).toMatchObject({ threadId: 'omt_1', replyTo: 'om_root', author: { id: 'ou_b', name: '赵六' } });
    expect(quote.replyTo).toBe('om_root');
    expect(sys.meta).toEqual({ msgType: 'system' });
    expect(sys.author).toBeUndefined();
    expect(lastMs).toBe(local(2026, 11, 9, 10, 31).getTime());
  });

  it('keeps the order of messages within one minute (lark-cli keeps only the minute)', () => {
    const at = local(2026, 11, 9, 9, 30);
    const { items } = feishuMessageItems(['om_z', 'om_a', 'om_m'].map((id) => message(id, at, id)), chat);
    const times = items.map((i) => Date.parse(i.publishedAt));
    expect(times).toEqual([at.getTime(), at.getTime() + 1, at.getTime() + 2]);
  });

  it('reads epoch and ISO times as well as lark-cli\'s local minutes', () => {
    expect(parseLarkTime('1793583245123')).toEqual({ ms: 1793583245123, minute: false });
    expect(parseLarkTime('1793583245')).toEqual({ ms: 1793583245000, minute: false });
    expect(parseLarkTime(1793583245)).toEqual({ ms: 1793583245000, minute: false });
    expect(parseLarkTime('2026-11-09T10:21:31+08:00')).toEqual({ ms: Date.parse('2026-11-09T02:21:31Z'), minute: false });
    expect(parseLarkTime('2026-11-09 10:21')).toEqual({ ms: local(2026, 11, 9, 10, 21).getTime(), minute: true });
    expect(parseLarkTime('soon')).toBeNull();
  });

  it('marks a recalled message deleted, and an edit is a new revision in the ledger', () => {
    const at = local(2026, 11, 9, 11, 0);
    const first = feishuMessageItems([message('om_e', at, '目标价 10 元'), message('om_r', at, '[Image: img_v3_r]', { msg_type: 'image' })], chat).items;
    expect(first[1].attachments).toHaveLength(1);
    const ledger = new FeedLedger(path.join(tmp, 'ledger-edit'), 'chat');
    expect(ledger.upsert(first).changed).toHaveLength(2);

    const again = feishuMessageItems([message('om_e', at, '目标价 10 元'), message('om_r', at, '[Image: img_v3_r]', { msg_type: 'image' })], chat).items;
    expect(ledger.upsert(again).changed).toHaveLength(0);

    const edited = message('om_e', at, '目标价 12 元', { updated: true, update_time: larkTime(local(2026, 11, 9, 11, 5)) });
    const recalled = message('om_r', at, 'This message was recalled', { msg_type: 'image', deleted: true });
    const later = feishuMessageItems([edited, recalled], chat).items;
    expect(later[0]).toMatchObject({ text: '目标价 12 元', updatedAt: local(2026, 11, 9, 11, 5).toISOString() });
    expect(later[1].deleted).toBe(true);
    expect(later[1].attachments).toBeUndefined();
    const up = ledger.upsert(later);
    expect(up.changed.map((i: FeedItem) => i.id).sort()).toEqual(['om_e', 'om_r']);
  });
});

/* ------------------------------ relay groups ----------------------------- */

describe('relay timestamps', () => {
  const delivered = Date.parse('2026-09-30T02:47:20Z'); // 10:47:20 in Shanghai

  it('takes the first line as the original time, in Shanghai unless it has an offset', () => {
    expect(parseRelayTimestamp('2026-09-30 10:46:51\n韩国股市高开回落', delivered)).toEqual({ at: '2026-09-30T10:46:51+08:00', rest: '韩国股市高开回落' });
    expect(parseRelayTimestamp('**2026-09-30 10:46**\n正文', delivered)?.at).toBe('2026-09-30T10:46:00+08:00');
    expect(parseRelayTimestamp('2026-09-30T02:46:51Z\n正文', delivered)?.at).toBe('2026-09-30T02:46:51Z');
  });

  it('leaves anything that is not a relay header alone', () => {
    expect(parseRelayTimestamp('2026-09-30 10:46:51 开盘了', delivered)).toBeNull();
    expect(parseRelayTimestamp('明天 2026-09-30 10:46:51\n…', delivered)).toBeNull();
    // later than the delivery, or a date that does not exist
    expect(parseRelayTimestamp('2026-10-02 10:46:51\n…', delivered)).toBeNull();
    expect(parseRelayTimestamp('2026-02-30 10:46:51\n…', delivered)).toBeNull();
  });

  it('strips the line into publishedAt on a pull, keeps the delivery time and the origin', async () => {
    const fake = new FakeLark();
    const deliveredAt = local(2026, 9, 30, 10, 47);
    fake.chats.set(CHAT, {
      name: '唐史主任',
      messages: [
        message('om_relay', deliveredAt, '2026-09-30 10:46:51\n【付费微博】地产政策是重大利好 https://weibo.com/1234567890/QaBcDeF12', { sender: { id: 'cli_bot', sender_type: 'app', name: '自定义机器人' } }),
        message('om_plain', deliveredAt, '收到'),
      ],
    });
    setFeishuChatRunner(fake.runner);
    const res = await feishuChatConnector.pull!(ctxFor({ chatId: CHAT, relayTimestamps: true }, undefined, local(2026, 9, 29, 0, 0)));
    const [relay, plain] = res.items;
    expect(relay).toMatchObject({
      publishedAt: '2026-09-30T10:46:51+08:00',
      text: '【付费微博】地产政策是重大利好 https://weibo.com/1234567890/QaBcDeF12',
      origin: { platform: 'weibo', id: 'QaBcDeF12', url: 'https://weibo.com/1234567890/QaBcDeF12' },
      dedupeKey: 'weibo:QaBcDeF12',
      meta: { msgType: 'text', senderType: 'app', deliveredAt: deliveredAt.toISOString(), visibility: 'paid' },
      channel: { name: '唐史主任' },
    });
    expect(plain.publishedAt).toBe(new Date(deliveredAt.getTime() + 1).toISOString());
    expect(plain.meta?.deliveredAt).toBeUndefined();
    expect(plain.origin).toBeUndefined();
  });
});

/* ------------------------------ cursor & pull ----------------------------- */

describe('cursor and look-back', () => {
  const now = Date.parse('2026-11-09T12:00:30Z');

  it('starts at the horizon, then lookbackDays before the cursor, never before the horizon', () => {
    const since = new Date('2026-11-06T12:00:45Z');
    const first = pullStart({}, since, 2, now);
    expect(first).toEqual({ startMs: Date.parse('2026-11-06T12:00:00Z'), from: '2026-11-06T12:00:00.000Z' });
    // no horizon given (the feed's state outlived it): the backfill days before now
    expect(pullStart({}, null, 2, now, 3).startMs).toBe(Date.parse('2026-11-06T12:00:00Z'));

    const state: ChatCursor = { cursor: '2026-11-09T11:30:00.000Z', from: first.from };
    expect(pullStart(state, null, 2, now).startMs).toBe(Date.parse('2026-11-07T11:30:00Z'));
    expect(pullStart(state, null, 0, now).startMs).toBe(Date.parse('2026-11-09T11:30:00Z'));
    // the look-back never reaches behind where the feed began
    expect(pullStart({ ...state, cursor: '2026-11-07T00:00:00.000Z' }, null, 2, now).startMs).toBe(Date.parse('2026-11-06T12:00:00Z'));
    // after a pull cut by the page limit: straight from the cursor, so a backlog makes progress
    expect(pullStart({ ...state, more: true }, null, 2, now).startMs).toBe(Date.parse('2026-11-09T11:30:00Z'));
  });

  it('pulls each chat from its cursor and reports more when the page limit was hit', async () => {
    const fake = new FakeLark();
    // lark-cli's times are whole minutes
    const minute = (ms: number) => new Date(Math.floor(ms / 60_000) * 60_000);
    const t0 = minute(Date.now() - 5 * DAY);
    const t1 = minute(Date.now() - 3 * DAY - 3_600_000);
    const t2 = minute(Date.now() - 1 * DAY);
    fake.chats.set(CHAT, { name: '混沌', messages: [message('om_1', t0, '一'), message('om_2', t1, '二')], hasMore: true });
    setFeishuChatRunner(fake.runner);
    const since = new Date(Date.now() - 7 * DAY);

    const first = await feishuChatConnector.pull!(ctxFor({ chatId: CHAT, lookbackDays: 2, maxPages: 3 }, undefined, since));
    const list = fake.calls.find((c) => c[1] === '+chat-messages-list')!;
    expect(list).toEqual(['im', '+chat-messages-list', '--chat-id', CHAT, '--as', 'user', '--order', 'asc', '--start', String(Math.floor(since.getTime() / 60_000) * 60), '--page-size', '50', '--page-all', '--page-limit', '3', '--format', 'json']);
    expect(first.more).toBe(true);
    expect(first.items.map((i) => i.id)).toEqual(['om_1', 'om_2']);
    const chatState = (first.state as { chats: Record<string, ChatCursor> }).chats[CHAT];
    expect(chatState).toMatchObject({ cursor: new Date(t1.getTime()).toISOString(), more: true, name: '混沌', kind: 'group' });
    expect(first.notes?.join('\n')).toMatch(/stopped at 3 page\(s\)/);

    // the next pull resumes at the last message read; the name is not looked up again
    fake.calls = [];
    fake.chats.get(CHAT)!.messages.push(message('om_3', t2, '三'));
    fake.chats.get(CHAT)!.hasMore = false;
    const second = await feishuChatConnector.pull!(ctxFor({ chatId: CHAT, lookbackDays: 2, maxPages: 3 }, first.state));
    expect(fake.calls.map((c) => c[1])).toEqual(['+chat-messages-list']);
    expect(fake.calls[0][fake.calls[0].indexOf('--start') + 1]).toBe(String(t1.getTime() / 1000));
    expect(second.items.map((i) => i.id)).toEqual(['om_2', 'om_3']);
    expect(second.more).toBe(false);

    // caught up: the pull after starts lookbackDays before the newest message
    fake.calls = [];
    const third = await feishuChatConnector.pull!(ctxFor({ chatId: CHAT, lookbackDays: 2, maxPages: 3 }, second.state));
    expect(fake.calls[0][fake.calls[0].indexOf('--start') + 1]).toBe(String((t2.getTime() - 2 * DAY) / 1000));
    expect(third.items.map((i) => i.id)).toEqual(['om_3']);
  });

  it('keeps what one chat gave when another fails, and moves only its cursor', async () => {
    const fake = new FakeLark();
    const other = 'oc_99999999999999999999999999999999';
    fake.chats.set(CHAT, { name: '混沌', messages: [message('om_1', new Date(Date.now() - DAY), '一')] });
    fake.failList.set(other, fail(1, { type: 'api', code: 230002, message: 'Bot is not in the chat' }));
    setFeishuChatRunner(fake.runner);
    const res = await feishuChatConnector.pull!(ctxFor({ chatIds: [CHAT, other] }, undefined, new Date(Date.now() - 3 * DAY)));
    expect(res.items.map((i) => i.id)).toEqual(['om_1']);
    expect(Object.keys((res.state as { chats: Record<string, unknown> }).chats)).toEqual([CHAT]);
    expect(res.error).toMatch(/not in this chat \(230002\)/);
    expect(res.error).toMatch(/add the bot to the group/);
  });
});

/* ------------------------------ errors, check ----------------------------- */

describe('scopes and check', () => {
  const missingScope = fail(1, {
    type: 'authorization',
    subtype: 'missing_scope',
    code: 99991679,
    message: 'missing required scope(s): im:message.group_msg:get_as_user',
    hint: 'run lark-cli auth login --scope ...',
    missing_scopes: ['im:message.group_msg:get_as_user'],
  });

  it('says which scope is missing and how to grant it', async () => {
    const fake = new FakeLark();
    fake.failList.set(CHAT, missingScope);
    setFeishuChatRunner(fake.runner);
    const err = await feishuChatConnector.pull!(ctxFor({ chatId: CHAT }, undefined, new Date())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FeishuError);
    expect((err as FeishuError).kind).toBe('auth');
    expect((err as FeishuError).message).toMatch(/has not granted im:message\.group_msg:get_as_user/);
    expect((err as FeishuError).message).toContain('lark-cli auth login --scope "im:message.group_msg:get_as_user"');

    const check = await feishuChatConnector.check!(ctxFor({ chatId: CHAT }));
    expect(check.ok).toBe(false);
    expect(check.message).toContain('lark-cli auth login --scope "im:message.group_msg:get_as_user"');
  });

  it('passes when the chat is readable, and tells which scopes are lacking', async () => {
    const fake = new FakeLark();
    fake.chats.set(CHAT, { name: '混沌', messages: [message('om_1', new Date(), '一')] });
    setFeishuChatRunner(fake.runner);
    const check = await feishuChatConnector.check!(ctxFor({ chatId: CHAT }));
    expect(check).toMatchObject({ ok: true });
    expect(check.message).toMatch(/王宁.*混沌 \(oc_.*\): readable, latest message/);
    expect((await feishuChatConnector.check!(ctxFor({}))).ok).toBe(false);
    expect(missingChatScopes(['im:message:readonly', 'im:chat:readonly'])).toEqual(['im:message.group_msg:get_as_user', 'im:message.p2p_msg:get_as_user', 'im:message.reactions:read']);
  });
});

/* -------------------------------- download -------------------------------- */

describe('download', () => {
  it('fetches a picture into the asset folder with the extension lark-cli gives it', async () => {
    const fake = new FakeLark();
    setFeishuChatRunner(fake.runner);
    const dest = path.join(tmp, 'assets', 'abc123');
    const item = { id: 'om_4', publishedAt: new Date().toISOString() };
    const got = await feishuChatConnector.download!(ctxFor({ chatId: CHAT }), item, { kind: 'image', url: 'feishu:image:om_4:img_v3_pic' }, dest);
    expect(got).toEqual({ path: `${dest}.png`, bytes: PNG.length, mime: 'image/png' });
    const call = fake.calls.at(-1)!;
    expect(call).toEqual(['im', '+messages-resources-download', '--message-id', 'om_4', '--file-key', 'img_v3_pic', '--type', 'image', '--output', 'abc123', '--as', 'user', '--format', 'json']);
    // voice and video are left alone, as is anything that is not a Feishu reference
    expect(await feishuChatConnector.download!(ctxFor({ chatId: CHAT }), item, { kind: 'audio', url: 'feishu:file:om_4:file_v3_voice' }, dest)).toBeNull();
    expect(await feishuChatConnector.download!(ctxFor({ chatId: CHAT }), item, { kind: 'image', url: 'https://example.com/a.png' }, dest)).toBeNull();
  });
});


describe('relay groups', () => {
  it('reads the author and origin from a relay bot\'s signature line', () => {
    const sig = relaySignature('混沌20000：红果看多了 ?\n@ 混沌20000  https://weibo.com/混沌20000/5362615943430722');
    expect(sig).toEqual({ account: '混沌20000', platform: 'weibo', url: 'https://weibo.com/混沌20000/5362615943430722', id: '5362615943430722', rest: '红果看多了 ?' });
    expect(relaySignature('注意：明天开会\n@ 张三 一起')).toBeNull();
    expect(relaySignature('plain text')).toBeNull();
  });

  it('turns a bot\'s picture-then-text card into one post by its author', () => {
    const chat = { id: 'oc_1', name: '混沌', kind: 'group' };
    const bot = { id: 'cli_bot', name: '自定义机器人', sender_type: 'app' };
    const { items } = feishuMessageItems([
      { message_id: 'om_1', msg_type: 'image', create_time: '2026-11-07 11:40', sender: bot, content: '[Image: img_v3_abc]' },
      { message_id: 'om_2', msg_type: 'text', create_time: '2026-11-07 11:40', sender: bot, content: '混沌20000：大家说这个项链好看吗 ?\n@ 混沌20000  https://weibo.com/混沌20000/5362582648784375' },
      { message_id: 'om_3', msg_type: 'text', create_time: '2026-11-07 13:52', sender: bot, content: '混沌20000：红果看多了 ?\n@ 混沌20000  https://weibo.com/混沌20000/5362615943430722' },
    ], chat, { relay: true });
    expect(items.map((i) => i.id)).toEqual(['om_2', 'om_3']);
    expect(items[0]).toMatchObject({
      text: '大家说这个项链好看吗 ?',
      author: { name: '混沌20000', id: 'weibo:混沌20000' },
      origin: { platform: 'weibo', account: '混沌20000', id: '5362582648784375' },
      dedupeKey: 'weibo:5362582648784375',
      meta: { relayedBy: '自定义机器人' },
    });
    expect(items[0].attachments?.[0]).toMatchObject({ kind: 'image' });
    // without relay, the same messages stay as they were sent
    expect(feishuMessageItems([{ message_id: 'om_3', msg_type: 'text', create_time: '2026-11-07 13:52', sender: bot, content: '混沌20000：x\n@ 混沌20000  https://weibo.com/混沌20000/5362615943430722' }], chat).items[0].author?.name).toBe('自定义机器人');
    expect(foldCardPictures([])).toEqual([]);
    // a card of two pictures and its text is one post, its pictures in order
    const two = feishuMessageItems([
      { message_id: 'om_a', msg_type: 'image', create_time: '2026-11-07 17:01', sender: bot, content: '[Image: img_v3_first]' },
      { message_id: 'om_b', msg_type: 'image', create_time: '2026-11-07 17:01', sender: bot, content: '[Image: img_v3_second]' },
      { message_id: 'om_c', msg_type: 'text', create_time: '2026-11-07 17:01', sender: bot, content: '混沌20000：两张图\n@ 混沌20000  https://weibo.com/混沌20000/5362663370785277' },
    ], chat, { relay: true }).items;
    expect(two.map((i) => i.id)).toEqual(['om_c']);
    expect(two[0].attachments?.map((a) => a.url)).toEqual([expect.stringContaining('img_v3_first'), expect.stringContaining('img_v3_second')]);
  });
});
