import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiGroupOf } from '../src/auth/apis.js';
import { AppContext, createContext } from '../src/context.js';
import { arxivQuery, parseArxiv } from '../src/ingest/feeds/connectors/arxiv.js';
import { rowItem } from '../src/ingest/feeds/connectors/opencli.js';
import { parseFeedXml, parseJsonFeed } from '../src/ingest/feeds/connectors/rss.js';
import { tweetItem } from '../src/ingest/feeds/connectors/x.js';
import { feedProblem, loadFeed, loadFeeds, normalizeFeed, parseDuration, redactFeed, saveFeed } from '../src/ingest/feeds/definitions.js';
import { FeedLedger } from '../src/ingest/feeds/ledger.js';
import { feedItems } from '../src/ingest/feeds/manage.js';
import { previewFeed, pushToFeed, runFeed } from '../src/ingest/feeds/run.js';
import { nextRunFor } from '../src/ingest/feeds/runner.js';
import { renderTemplate, ruleMatches } from '../src/ingest/feeds/stages.js';
import type { FeedItem, FeedUnit } from '../src/ingest/feeds/types.js';
import { buildUnits, periodOf, zonedIso } from '../src/ingest/feeds/units.js';
import { findLiveScope } from '../src/lineage/scope.js';
import type { LlmClient } from '../src/llm/client.js';
import { pluginRegistry } from '../src/plugins/registry.js';
import { createApp } from '../src/server/app.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';

/**
 * Feeds (src/ingest/feeds, docs/design/26): definitions, units and periods,
 * the filter and transform layers with every kind of stage, the pipeline from
 * pushed and pulled items to indexed documents, the connectors' parsers, the
 * scheduler's arithmetic, and the HTTP routes.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-feeds-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const TZ = 'Asia/Shanghai';
const at = (local: string) => new Date(`${local}+08:00`).toISOString();

const msg = (id: string, local: string, author: string, text: string, extra: Partial<FeedItem> = {}): FeedItem => ({
  id,
  publishedAt: at(local),
  author: { name: author },
  channel: { id: 'oc_1', name: '混沌', kind: 'group' },
  text,
  ...extra,
});

/* ----------------------------- pure functions ---------------------------- */

describe('definitions', () => {
  it('reads durations', () => {
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(parseDuration('soon')).toBeNull();
  });

  it('fills a feed from its connector\'s defaults and says what is wrong with one', () => {
    const feed = normalizeFeed({ connector: 'arxiv', params: { categories: ['cs.CL'] } }, 'papers');
    expect(feed.render.period).toBe('item');
    expect(feed.schedule).toEqual({ at: ['08:30'] });
    expect(feedProblem(feed)).toBeNull();
    expect(feedProblem(normalizeFeed({ connector: 'nope' }, 'x'))).toMatch(/unknown connector "nope"/);
    expect(feedProblem(normalizeFeed({ connector: 'rss' }, 'x'))).toMatch(/needs params\.url/);
    expect(feedProblem(normalizeFeed({ connector: 'push', filter: [{ kind: 'llm' }] }, 'x'))).toMatch(/use \(a connection or agent id\) is required/);
    expect(feedProblem(normalizeFeed({ connector: 'push', filter: [{ kind: 'template', template: 'x' }] }, 'x'))).toMatch(/cannot be a filter/);
    expect(feedProblem(normalizeFeed({ connector: 'push', filter: [{ kind: 'udf', name: 'missing' }] }, 'x'))).toMatch(/no feed stage "missing"/);
    expect(feedProblem(normalizeFeed({ connector: 'push', render: { dest: 'raw/docs' } }, 'x'))).toMatch(/render\.dest/);
  });

  it('saves YAML under playbooks/feeds, masks secrets and keeps them when they come back masked', () => {
    const dir = path.join(tmp, 'defs');
    const saved = saveFeed(dir, 'mail', { connector: 'github', params: { repo: 'a/b', token: 'ghp_secret' }, schedule: { every: '1h' } });
    expect(saved.path).toBe('playbooks/feeds/mail.yaml');
    const shown = redactFeed(saved);
    expect(shown.params.token).toBe('••••••');
    saveFeed(dir, 'mail', { ...shown, title: 'Repo' } as unknown as Record<string, unknown>);
    const again = loadFeed(dir, 'mail')!;
    expect(again.params.token).toBe('ghp_secret');
    expect(again.title).toBe('Repo');
    expect(loadFeeds(dir).map((f) => f.id)).toEqual(['mail']);
    expect(() => saveFeed(dir, 'preview', { connector: 'push' })).toThrow(/feed id/);
    expect(() => saveFeed(dir, 'bad', { connector: 'rss' })).toThrow(/params\.url/);
  });
});

describe('units and periods', () => {
  const items = [
    msg('m1', '2026-11-09T10:30:00', 'V+', 'trs主要是海外'),
    msg('m2', '2026-11-09T10:31:00', 'V+', '都是中国人'),
    msg('m3', '2026-11-09T10:47:00', '张三', '这个恐慌情绪就蔓延了'),
    msg('m4', '2026-11-09T14:00:00', 'V+', '下午再看'),
    msg('m5', '2026-11-09T14:05:00', 'V+', '撤回了', { deleted: true }),
  ];

  it('cuts a conversation into windows where it went quiet, and leaves recalled messages out', () => {
    const units = buildUnits(items, { by: 'window', gapMinutes: 30 });
    expect(units.map((u) => [u.kind, u.items.map((i) => i.id)])).toEqual([['window', ['m1', 'm2', 'm3']], ['item', ['m4']]]);
    expect(units[0].id).toBe('m1');
    // a window that gains a message keeps its id and changes its hash
    const grown = buildUnits([...items, msg('m6', '2026-11-09T10:50:00', 'V+', '嗯')], { by: 'window', gapMinutes: 30 });
    expect(grown[0].id).toBe('m1');
    expect(grown[0].hash).not.toBe(units[0].hash);
  });

  it('joins replies to their thread', () => {
    const t = buildUnits([
      msg('a', '2026-11-09T09:00:00', 'A', 'root'),
      msg('b', '2026-11-09T09:05:00', 'B', 'reply', { replyTo: 'a' }),
      msg('c', '2026-11-09T09:06:00', 'C', 'reply to reply', { replyTo: 'b' }),
      msg('d', '2026-11-09T09:07:00', 'D', 'alone'),
    ], { by: 'thread' });
    expect(t.map((u) => u.items.map((i) => i.id))).toEqual([['a', 'b', 'c'], ['d']]);
  });

  it('dates periods in the feed\'s zone', () => {
    // 23:30 UTC on the 8th is the 9th in Shanghai
    expect(periodOf('2026-11-08T23:30:00Z', 'day', TZ).key).toBe('2026-11-09');
    expect(periodOf('2026-11-08T23:30:00Z', 'day', 'UTC').key).toBe('2026-11-08');
    expect(periodOf('2026-11-09T02:00:00Z', 'week', TZ)).toMatchObject({ key: '2026-W46', date: '2026-11-09' });
    expect(periodOf('2026-01-01T02:00:00Z', 'week', TZ).key).toBe('2026-W01');
    expect(periodOf('2026-11-09T02:00:00Z', 'month', TZ).key).toBe('2026-11');
    expect(zonedIso('2026-11-09T02:00:00Z', TZ)).toBe('2026-11-09T10:00:00+08:00');
  });
});

describe('rules and templates', () => {
  const unit = (text: string, extra: Partial<FeedItem> = {}): FeedUnit => buildUnits([msg('u', '2026-11-09T10:00:00', '混沌20000', text, extra)], { by: 'item' })[0];

  it('matches every condition a rule names', () => {
    expect(ruleMatches(unit('英伟达财报超预期'), { any: ['英伟达', 'NVDA'] })).toBe(true);
    expect(ruleMatches(unit('英伟达财报'), { all: ['英伟达', '指引'] })).toBe(false);
    expect(ruleMatches(unit('早上好'), { shorterThan: 5 })).toBe(true);
    expect(ruleMatches(unit('the market fell'), { language: 'en' })).toBe(true);
    expect(ruleMatches(unit('市场下跌'), { language: 'zh', authors: ['混沌20000'] })).toBe(true);
    expect(ruleMatches(unit('x', { meta: { msgType: 'system' } }), { fields: { 'meta.msgType': ['system'] } })).toBe(true);
    expect(ruleMatches(unit('price 12.5%'), { regex: ['\\d+(\\.\\d+)?%'] })).toBe(true);
    expect(ruleMatches(unit('text', { attachments: [{ kind: 'image', url: 'https://x/y.png' }] }), { hasMedia: true })).toBe(true);
  });

  it('renders a Mustache subset', () => {
    const out = renderTemplate('## {{title}}\n{{#tags}}#{{.}} {{/tags}}\n{{^url}}no link{{/url}}\n{{#items}}- {{time}} {{author.name}}: {{text}}\n{{/items}}', {
      title: 'T', tags: ['a', 'b'], url: '', items: [{ time: '10:00:00', author: { name: 'A' }, text: 'hi' }],
    });
    expect(out).toBe('## T\n#a #b \nno link\n- 10:00:00 A: hi');
  });
});

describe('connector parsers', () => {
  it('reads RSS 2.0, Atom with XHTML content, and JSON Feed', () => {
    const rss = parseFeedXml(`<?xml version="1.0"?><rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Blog &amp; Co</title>
      <item><title>First</title><link>https://ex.com/a?utm_source=x</link><guid>g1</guid><pubDate>Mon, 09 Nov 2026 02:00:00 GMT</pubDate><dc:creator>Ann</dc:creator>
      <content:encoded><![CDATA[<p>Hello <b>world</b></p>]]></content:encoded><enclosure url="https://ex.com/p.png" type="image/png"/><category>ai</category></item></channel></rss>`, 'https://ex.com/feed');
    expect(rss.title).toBe('Blog & Co');
    expect(rss.items[0]).toMatchObject({ id: 'g1', url: 'https://ex.com/a?utm_source=x', dedupeKey: 'https://ex.com/a', title: 'First', author: { name: 'Ann' }, publishedAt: '2026-11-09T02:00:00.000Z', html: '<p>Hello <b>world</b></p>', tags: ['ai'] });
    expect(rss.items[0].attachments).toEqual([{ kind: 'image', url: 'https://ex.com/p.png', mime: 'image/png' }]);

    const atom = parseFeedXml(`<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title><author><name>Bo</name></author>
      <entry><id>tag:1</id><title>E</title><link rel="alternate" href="https://ex.com/e"/><updated>2026-11-09T01:00:00Z</updated>
      <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>One <em>two</em> three</p></div></content></entry></feed>`, 'u');
    expect(atom.items[0]).toMatchObject({ id: 'tag:1', url: 'https://ex.com/e', author: { name: 'Bo' } });
    expect(atom.items[0].html).toBe('<div><p>One <em>two</em> three</p></div>');

    const json = parseJsonFeed(JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'J', items: [{ id: '1', url: 'https://ex.com/j', content_text: 'plain', date_published: '2026-11-09T00:00:00Z' }] }), 'u');
    expect(json.items[0]).toMatchObject({ id: '1', text: 'plain', publishedAt: '2026-11-09T00:00:00.000Z' });
  });

  it('builds arXiv queries and reads its Atom answer', () => {
    expect(arxivQuery({ categories: ['cs.CL', 'cs.IR'], query: 'abs:"rag"' })).toBe('(cat:cs.CL OR cat:cs.IR) AND (abs:"rag")');
    expect(arxivQuery({ categories: 'cs.CL' })).toBe('cat:cs.CL');
    const { items, total } = parseArxiv(`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">
      <opensearch:totalResults>42</opensearch:totalResults>
      <entry><id>http://arxiv.org/abs/2611.01234v2</id><published>2026-11-08T18:00:00Z</published><updated>2026-11-09T18:00:00Z</updated>
      <title>Graph
        RAG</title><summary>We show
        things.</summary><author><name>A. One</name></author><author><name>B. Two</name></author>
      <arxiv:primary_category term="cs.CL"/><category term="cs.CL"/><category term="cs.IR"/>
      <link title="pdf" href="http://arxiv.org/pdf/2611.01234v2" type="application/pdf"/></entry></feed>`);
    expect(total).toBe(42);
    expect(items[0]).toMatchObject({ id: '2611.01234', title: 'Graph RAG', author: { name: 'A. One et al.' }, dedupeKey: 'arxiv:2611.01234', tags: ['cs.CL', 'cs.IR'], meta: { version: 2 } });
    expect(items[0].text).toContain('We show things.');
    expect(items[0].attachments?.[0]).toMatchObject({ url: 'https://arxiv.org/pdf/2611.01234v2', mime: 'application/pdf' });
    expect(() => parseArxiv('<feed><entry><id>http://arxiv.org/api/errors#x</id><title>Error</title><summary>bad query</summary></entry></feed>')).toThrow(/bad query/);
  });

  it('maps an X post with a quote, and an OpenCLI row', () => {
    const item = tweetItem(
      { id: '2', text: 'look https://t.co/x', created_at: '2026-11-09T01:00:00Z', entities: { urls: [{ url: 'https://t.co/x', expanded_url: 'https://ex.com/full' }] }, referenced_tweets: [{ type: 'quoted', id: '1' }], conversation_id: '2' },
      { username: 'karpathy', name: 'Andrej' },
      { tweets: [{ id: '1', text: 'original', author_id: '9' }], users: [{ id: '9', username: 'other', name: 'O' }] },
    );
    expect(item).toMatchObject({ id: '2', url: 'https://x.com/karpathy/status/2', origin: { platform: 'x', account: 'other', id: '1' } });
    expect(item.text).toBe('look https://ex.com/full\n\n> @other: original');
    expect(item.threadId).toBeUndefined();
    const row = rowItem({ id: '7', author: 'Elon Musk', text: 'hi', created_at: '2026-11-09T01:00:00Z', url: 'https://x.com/e/status/7', media_urls: ['https://pbs.twimg.com/a.jpg'], likes: 3 }, 'twitter');
    expect(row).toMatchObject({ id: 'twitter:7', author: { name: 'Elon Musk' }, attachments: [{ kind: 'image', url: 'https://pbs.twimg.com/a.jpg' }], meta: { likes: 3 } });
  });
});

/* ------------------------------- the pipeline ----------------------------- */

describe('the pipeline', () => {
  const data = path.join(tmp, 'ws');
  let ctx: AppContext;
  const read = (rel: string) => fs.readFileSync(path.join(data, rel), 'utf8');

  beforeAll(async () => {
    ctx = await createContext(data);
    // a model connection the model stages name; the tests hand them a fake client
    ctx.config.connections = [...(ctx.config.connections ?? []), { ...ctx.config.llm, provider: 'openai', baseUrl: 'http://127.0.0.1:9', model: 'fake', id: 'fake-model', label: 'Fake' }];
    fs.writeFileSync(path.join(data, 'purpose.md'), 'A-share market notes.');
  });
  afterAll(async () => {
    await ctx.datasources.closeAll();
    await ctx.store.close();
  });

  it('pushes a day of chat into one document of windows, drops what a rule drops, and indexes it', async () => {
    const feed = saveFeed(data, 'hundun', {
      title: '混沌',
      connector: 'push',
      params: { platform: 'feishu' },
      units: { by: 'window', gapMinutes: 30 },
      filter: [{ kind: 'rules', rules: [{ drop: { shorterThan: 4 }, note: 'too short' }, { keep: { any: ['恐慌', '利好'] } }] }],
      render: { period: 'day', timezone: TZ },
    });
    const r = await pushToFeed(ctx, feed, [
      msg('m1', '2026-11-09T10:30:00', 'V+', 'trs主要是海外的杠杆'),
      msg('m2', '2026-11-09T10:31:00', 'V+', '这个恐慌情绪就蔓延了'),
      msg('m3', '2026-11-09T14:00:00', 'V+', '嗯'),
      msg('m4', '2026-11-09T16:00:00', '张三', '地产政策是重大利好'),
    ]);
    expect(r).toMatchObject({ pushed: 4, changed: 4, decided: 3, kept: 2, dropped: 1, pending: 0 });
    const doc = 'raw/docs/feeds/hundun/2026/11/2026-11-09.md';
    expect(r.documents).toEqual([{ path: doc, written: true, units: 2 }]);
    const text = read(doc);
    expect(text).toMatch(/^---\ntype: FeedDigest\ntitle: 混沌 · 2026-11-09\ndate: '2026-11-09'\nplatform: feishu\nfeed: hundun/);
    expect(text).toContain('## 10:30–10:31 · V+ · trs主要是海外的杠杆 (2 messages)');
    expect(text).toContain('- 10:30:00 V+：trs主要是海外的杠杆');
    expect(text).toContain('## 16:00 · 张三 · 地产政策是重大利好');
    expect(text).not.toContain('嗯');
    expect(await findLiveScope(ctx.store, 'doc', doc)).not.toBeNull();
    const dropped = feedItems(data, feed, { status: 'drop' });
    expect(dropped).toEqual([expect.objectContaining({ unit: 'm3', by: 'rules#1', reason: 'too short' })]);
  });

  it('keeps earlier sections byte-identical, replaces an edited message and removes a recalled one', async () => {
    const feed = loadFeed(data, 'hundun')!;
    const doc = 'raw/docs/feeds/hundun/2026/11/2026-11-09.md';
    const before = read(doc);
    const window = before.slice(before.indexOf('## 10:30'), before.indexOf('## 16:00'));
    // the same items again: nothing new
    const same = await pushToFeed(ctx, feed, [msg('m1', '2026-11-09T10:30:00', 'V+', 'trs主要是海外的杠杆')]);
    expect(same).toMatchObject({ changed: 0, unchanged: 1, decided: 0 });
    expect(same.documents).toEqual([]);
    // a later message joins nothing earlier
    await pushToFeed(ctx, feed, [msg('m5', '2026-11-09T20:00:00', '李四', '明天关注利好落地')]);
    expect(read(doc)).toContain(window);
    // an edit and a recall
    const edited = await pushToFeed(ctx, feed, [
      msg('m4', '2026-11-09T16:00:00', '张三', '地产政策是重大利好（修正）'),
      msg('m5', '2026-11-09T20:00:00', '李四', '明天关注利好落地', { deleted: true }),
    ]);
    expect(edited.decided).toBe(1);
    const after = read(doc);
    expect(after).toContain('重大利好（修正）');
    expect(after).not.toContain('明天关注');
    expect(after).toContain(window);
  });

  it('asks a model with the purpose and the items, honours a threshold, and caches the verdict', async () => {
    const calls: string[] = [];
    const client = (answer: (prompt: string) => string) => ({ enabled: true, label: 'fake', model: 'fake', provider: 'openai', complete: async (messages: Array<{ content: string }>) => {
      calls.push(messages.map((m) => m.content).join('\n---\n'));
      return answer(messages[1].content);
    } }) as unknown as LlmClient;
    const feed = saveFeed(data, 'judged', {
      connector: 'push',
      filter: [{ kind: 'llm', use: 'fake-model', prompt: 'Keep market views with reasons.', threshold: 0.6 }],
      render: { period: 'item', timezone: TZ },
    });
    const fake = client((user) => JSON.stringify({ verdicts: [...user.matchAll(/id="(u\d+)"/g)].map((m, i) => ({ id: m[1], keep: true, score: i === 0 ? 0.9 : 0.3, reason: i === 0 ? 'has reasons' : 'vague' })) }));
    const r = await pushToFeed(ctx, feed, [
      { id: 'p1', title: '为什么看好券商', text: '成交额放大，政策托底。', publishedAt: at('2026-11-09T09:00:00') },
      { id: 'p2', title: '随便聊聊', text: '今天天气不错', publishedAt: at('2026-11-09T09:10:00') },
    ], { clientFor: () => fake });
    expect(r.decisions.map((d) => [d.unit, d.status, d.score])).toEqual([['p1', 'keep', 0.9], ['p2', 'drop', 0.3]]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('A-share market notes.');
    expect(calls[0]).toContain('Keep market views with reasons.');
    expect(calls[0]).toContain('untrusted content');
    expect(r.documents).toHaveLength(1);
    expect(read(r.documents[0].path)).toMatch(/title: 为什么看好券商/);
    // rendering again decides nothing again
    const again = await runFeed(ctx, feed, { pull: false, all: true, clientFor: () => fake });
    expect(again.decided).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('leaves units pending when the model fails or the quota floor holds, and decides them on a later run', async () => {
    const feed = saveFeed(data, 'flaky', { connector: 'push', filter: [{ kind: 'llm', use: 'fake-model' }], render: { period: 'item' } });
    const failing = { enabled: true, label: 'fake', complete: async () => 'not json' } as unknown as LlmClient;
    const r = await pushToFeed(ctx, feed, [{ id: 'f1', text: 'something', publishedAt: at('2026-11-09T09:00:00') }], { clientFor: () => failing });
    expect(r).toMatchObject({ pending: 1, kept: 0 });
    expect(r.documents).toEqual([]);
    const held = await runFeed(ctx, feed, { pull: false, hold: async () => 'Codex weekly window under 10%', clientFor: () => failing });
    expect(held.decisions[0]).toMatchObject({ status: 'pending', reason: expect.stringMatching(/waiting: Codex weekly window/) });
    const ok = { enabled: true, label: 'fake', complete: async () => '{"verdicts":[{"id":"u1","keep":true}]}' } as unknown as LlmClient;
    const later = await runFeed(ctx, feed, { pull: false, clientFor: () => ok });
    expect(later).toMatchObject({ decided: 1, kept: 1 });
    expect(later.documents).toHaveLength(1);
  });

  it('runs user-defined, command, template and model transforms in order', async () => {
    pluginRegistry().registerFeedStage({ id: 'shout', kind: 'transform', run: (units) => units.map((u) => ({ title: (u.items[0].title ?? '').toUpperCase() })) }, 'test');
    pluginRegistry().registerFeedStage({ id: 'only-a', kind: 'filter', run: (units) => units.map((u) => ({ keep: u.items[0].id.startsWith('a') ? true : null })) }, 'test');
    const script = path.join(tmp, 'stage.mjs');
    fs.writeFileSync(script, `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const req=JSON.parse(s);process.stdout.write(JSON.stringify({results:req.units.map(u=>({id:u.id,tags:['from-'+req.stage],context:'via '+req.protocol}))}))})`);
    const feed = saveFeed(data, 'shaped', {
      connector: 'push',
      filter: [{ kind: 'udf', name: 'only-a' }],
      filterDefault: 'drop',
      transform: [
        { kind: 'udf', name: 'shout' },
        { kind: 'command', command: process.execPath, args: [script] },
        { kind: 'template', template: '**{{title}}** by {{author.name}}\n\n{{text}}' },
        { kind: 'llm', use: 'fake-model', prompt: 'One line summary.', when: { any: ['long'] } },
      ],
      render: { period: 'item' },
    });
    const model = { enabled: true, label: 'fake', complete: async () => '{"summary":"short","tags":["model"]}' } as unknown as LlmClient;
    const r = await pushToFeed(ctx, feed, [
      { id: 'a1', title: 'hello', text: 'a long body', author: 'Ann', publishedAt: at('2026-11-09T09:00:00') },
      { id: 'b1', title: 'skip', text: 'b', publishedAt: at('2026-11-09T09:00:00') },
    ], { clientFor: () => model });
    expect(r.decisions.map((d) => [d.unit, d.status, d.by])).toEqual([['a1', 'keep', 'udf:only-a'], ['b1', 'drop', 'default']]);
    const text = read(r.documents[0].path);
    expect(text).toContain('# HELLO');
    expect(text).toContain('_via knode-feed-stage/1_');
    expect(text).toContain('**HELLO** by Ann\n\na long body');
    expect(text).toContain('summary: short');
    expect(text).toMatch(/tags:\n {2}- feed\/shaped\n {2}- platform\/push\n {2}- from-transform\n {2}- model/);
  });

  it('pulls from a program speaking knode-feed/1, keeping what came before its last checkpoint when it fails', async () => {
    const script = path.join(tmp, 'source.mjs');
    fs.writeFileSync(script, `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const req=JSON.parse(s);const n=(req.state&&req.state.n)||0;
      const out=o=>process.stdout.write(JSON.stringify(o)+'\\n');
      out({type:'log',message:'from '+n});
      out({type:'item',item:{id:'c'+(n+1),title:'Item '+(n+1),text:'body',publishedAt:'2026-11-09T01:00:00Z'}});
      out({type:'state',state:{n:n+1}});
      if(n===1){out({type:'item',item:{id:'lost',text:'x',publishedAt:'2026-11-09T01:00:00Z'}});out({type:'error',message:'site went away'});process.exit(2)}
    })`);
    const feed = saveFeed(data, 'program', { connector: 'command', params: { command: process.execPath, args: [script] }, render: { period: 'item' } });
    const first = await runFeed(ctx, feed);
    expect(first).toMatchObject({ error: null, pulled: 1, kept: 1 });
    const second = await runFeed(ctx, feed);
    expect(second).toMatchObject({ error: 'site went away', pulled: 1, kept: 1 });
    expect(new FeedLedger(data, 'program').state().cursor).toEqual({ n: 2 });
    expect(new FeedLedger(data, 'program').has('lost')).toBe(false);
  });

  it('pulls an RSS feed over HTTP with conditional requests', async () => {
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits++;
      if (req.headers['if-none-match'] === '"v1"') {
        res.writeHead(304);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/rss+xml', etag: '"v1"' });
      res.end(`<rss><channel><title>T</title><item><guid>r1</guid><title>Post</title><link>http://127.0.0.1/r1</link><pubDate>${new Date().toUTCString()}</pubDate><description>&lt;p&gt;Body &lt;b&gt;bold&lt;/b&gt;&lt;/p&gt;</description></item></channel></rss>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const feed = saveFeed(data, 'blog', { connector: 'rss', params: { url: `http://127.0.0.1:${port}/feed` } });
      const preview = await previewFeed(ctx, feed);
      expect(preview.documents[0].content).toContain('Body **bold**');
      expect(new FeedLedger(data, 'blog').size).toBe(0);
      const r = await runFeed(ctx, feed);
      expect(r).toMatchObject({ pulled: 1, kept: 1 });
      const again = await runFeed(ctx, feed);
      expect(again).toMatchObject({ pulled: 0, changed: 0 });
      expect(again.notes.join(' ')).toMatch(/not modified/);
      expect(hits).toBe(3);
    } finally {
      server.close();
    }
  });

  it('redacts secrets in what it writes when the feed has a redact stage', async () => {
    const feed = saveFeed(data, 'secrets', { connector: 'push', transform: [{ kind: 'redact' }], render: { period: 'item' } });
    const r = await pushToFeed(ctx, feed, [{ id: 's1', title: 'key', text: 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123', publishedAt: at('2026-11-09T09:00:00') }]);
    expect(read(r.documents[0].path)).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123');
  });
});

/* ------------------------------- scheduling ------------------------------ */

describe('scheduling', () => {
  const feed = (schedule: Record<string, unknown>) => normalizeFeed({ connector: 'rss', params: { url: 'https://ex.com/f' }, schedule }, 'f');
  const now = new Date('2026-11-09T12:00:00Z');

  it('runs a feed every so often, at its times, sooner when more waits and later after failures', () => {
    expect(nextRunFor(feed({ every: '1h' }), {}, now)?.toISOString()).toBe(now.toISOString());
    expect(nextRunFor(feed({ every: '1h' }), { lastRunAt: '2026-11-09T11:30:00Z' }, now)?.toISOString()).toBe('2026-11-09T12:30:00.000Z');
    expect(nextRunFor(feed({ every: '1h' }), { lastRunAt: '2026-11-09T11:59:00Z', more: true }, now)?.toISOString()).toBe('2026-11-09T12:04:00.000Z');
    expect(nextRunFor(feed({ every: '1h' }), { lastRunAt: '2026-11-09T11:59:00Z', failures: 3 }, now)?.toISOString()).toBe('2026-11-09T12:19:00.000Z');
    expect(nextRunFor(feed('manual' as unknown as Record<string, unknown>), {}, now)).toBeNull();
    expect(nextRunFor(feed('manual' as unknown as Record<string, unknown>), { lastRunAt: '2026-11-09T11:59:00Z', failures: 2 }, now)).toBeNull();
    expect(nextRunFor(normalizeFeed({ connector: 'push' }, 'p'), {}, now)).toBeNull();
    // a daily time that passed since the last run is owed now
    const local = new Date(now);
    const hhmm = `${String((local.getHours() + 23) % 24).padStart(2, '0')}:00`;
    expect(nextRunFor(feed({ at: [hhmm] }), { lastRunAt: '2026-11-07T00:00:00Z' }, now)!.getTime()).toBeLessThanOrEqual(now.getTime());
  });
});

/* ---------------------------------- HTTP --------------------------------- */

describe('the HTTP routes', () => {
  const root = path.join(tmp, 'server');
  const headers = { 'x-knode-user': 'admin', 'x-knode-workspace-kind': 'personal', 'x-knode-workspace-id': 'default', 'x-knode-workspace-name': 'Default' };
  const jsonHeaders = { ...headers, 'content-type': 'application/json' };
  let rootCtx: AppContext;
  let registry: WorkspaceContextRegistry;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    rootCtx = await createContext(root);
    registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
    app = createApp(rootCtx, () => {}, registry);
    await app.request('/api/workspaces', { headers });
  });
  afterAll(async () => {
    await registry.closeAll();
    await rootCtx.store.close();
  });

  it('puts defining with the administrator, running and pushing with ingest, reading with files', () => {
    expect(apiGroupOf('PUT', '/api/feeds/x')).toBe('settings');
    expect(apiGroupOf('DELETE', '/api/feeds/x')).toBe('settings');
    expect(apiGroupOf('POST', '/api/feeds/preview')).toBe('settings');
    expect(apiGroupOf('POST', '/api/feeds/check')).toBe('settings');
    expect(apiGroupOf('POST', '/api/feeds/x/run')).toBe('ingest');
    expect(apiGroupOf('POST', '/api/feeds/x/items')).toBe('ingest');
    expect(apiGroupOf('GET', '/api/feeds')).toBe('files');
    expect(apiGroupOf('GET', '/api/feeds/x/items')).toBe('files');
  });

  it('defines a feed, takes pushed NDJSON, shows what it kept, and deletes it with its files', async () => {
    const put = await app.request('/api/feeds/inbox', { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ title: 'Inbox', connector: 'push', render: { period: 'item' } }) });
    expect(put.status).toBe(200);
    const connectors = await (await app.request('/api/feeds/connectors', { headers })).json();
    expect(connectors.connectors.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining(['rss', 'arxiv', 'github', 'x', 'opencli', 'web', 'push', 'command']));
    const ndjson = [{ id: 'n1', title: 'Saved link', text: 'worth keeping', url: 'https://ex.com/n1', publishedAt: '2026-11-09T01:00:00Z' }].map((i) => JSON.stringify(i)).join('\n');
    const pushed = await app.request('/api/feeds/inbox/items', { method: 'POST', headers: { ...headers, 'content-type': 'application/x-ndjson' }, body: ndjson });
    expect(pushed.status).toBe(200);
    const body = await pushed.json();
    expect(body.result).toMatchObject({ pushed: 1, kept: 1 });
    const list = await (await app.request('/api/feeds', { headers })).json();
    expect(list.feeds).toEqual([expect.objectContaining({ id: 'inbox', connector: 'push', items: 1, dest: 'raw/docs/feeds/inbox' })]);
    const items = await (await app.request('/api/feeds/inbox/items', { headers })).json();
    expect(items.items).toEqual([expect.objectContaining({ unit: 'n1', status: 'keep', title: 'Saved link', url: 'https://ex.com/n1' })]);
    const bad = await app.request('/api/feeds/inbox/items', { method: 'POST', headers: jsonHeaders, body: '{"items":[]}' });
    expect(bad.status).toBe(400);
    const gone = await app.request('/api/feeds/inbox?removeFiles=1&forget=1', { method: 'DELETE', headers });
    expect(await gone.json()).toMatchObject({ ok: true, removedFiles: 'raw/docs/feeds/inbox', forgotLedger: true });
    expect((await (await app.request('/api/feeds', { headers })).json()).feeds).toEqual([]);
  });
});
