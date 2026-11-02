import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { bandsFor, readInBands } from '../src/ingest/converters/image.js';
import { FEISHU_SCOPES, FeishuError, LarkCli, LarkRunner, RunResult } from '../src/ingest/feishu/client.js';
import {
  describeFeishuLinks,
  feishuCheckTime,
  feishuClient,
  FeishuDocs,
  FeishuImportJob,
  feishuLinks,
  FeishuSignIn,
  importFeishuBatch,
  importFeishuDocument,
  lastDailyDue,
  lastFeishuCheck,
  readManifest,
  readTreeManifest,
  refreshFeishuLinks,
  setFeishuRunner,
  splitFeishuInputs,
  unlinkFeishuDocument,
} from '../src/ingest/feishu/docs.js';
import { placePages, WikiTreePage } from '../src/ingest/feishu/tree.js';
import { sidecarRelFor } from '../src/fs/layout.js';
import { parseFeishuRef, renderFeishuMarkdown, scanFeishuMarkdown } from '../src/ingest/feishu/markdown.js';
import { assertNotLinked, syncedByFolders } from '../src/ingest/folders.js';
import { findLiveScope } from '../src/lineage/scope.js';
import { createApp } from '../src/server/app.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';

/**
 * Feishu documents as a source (src/ingest/feishu): links read, lark-cli's
 * Markdown made knode-os's, a document mirrored with its pictures and
 * attachments — once or linked and kept in sync by its last-edit time — and
 * the one-time sign-in, all against a fake lark-cli.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-feishu-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A 1×1 PNG: what a downloaded picture is made of here. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const DOC = 'GzLndXzASoUm5Fxpq7Ic2tFnnGe';
const WIKI = 'WikiNodeAbcdefghijklmnop12';
const IMG1 = 'C6LDbBQNboI1DZxXGgHc7VNtnvh';
const IMG2 = 'H0uhbYkPVoRbvPx48Y7cOAdSnLg';
const NOTES = 'FVuJbl1HioDa44xPH0GcI3zOnSh';
const SHEET = 'FiCob8ytxo3PAExCnmYcnBAfndd';

function docContent(images: string[], extra = ''): string {
  return [
    '<title>4. 九哥星球精华</title>',
    '',
    '# 星球精华',
    '',
    '## 做T',
    '',
    `<source name="做T方法（量能篇）.txt" mime="text/plain" size="40" token="${NOTES}"/>`,
    '',
    '量能篇：',
    '',
    '- 量价齐升：健康',
    '- 缩量下跌：地量见地价',
    '',
    '<grid>',
    ...images.flatMap((t) => ['<column width-ratio="0.5">', `![](https://feishu.cn/file/${t})`, '</column>']),
    '</grid>',
    '',
    `<figure view-type="Preview"><source name="2024年报&amp;2025Q1.xlsx" mime="application/vnd.ms-excel" size="16613" token="${SHEET}"/></figure>`,
    '',
    '<bitable table-id="tbl2aHurn7r8kzB5" token="V3Y3b0SEUaDM5ws3B1ZcElwCnWc"></bitable>',
    '',
    extra,
  ].join('\n');
}

interface FakeNode {
  space: string;
  parent: string;
  obj: string;
  type: string;
  nodeType?: string;
  title: string;
  edited: number;
}

/** A lark-cli that knows a few documents and a wiki, answering the calls knode-os makes. */
class FakeLark {
  docs = new Map<string, { title: string; content: string; revision: number; modified: number }>();
  wiki = new Map<string, FakeNode>([[WIKI, { space: 'SpaceOfOnePage', parent: '', obj: DOC, type: 'docx', title: '4. 九哥星球精华', edited: 1793583245 }]]);
  spaces = new Map<string, string>();
  calls: string[][] = [];
  signedIn = true;
  scopes = [...FEISHU_SCOPES, 'calendar:calendar:read'];
  loginApproved: Promise<void> = Promise.resolve();
  readable = new Set<string>();

  constructor() {
    this.docs.set(DOC, { title: '4. 九哥星球精华', content: docContent([IMG1, IMG2]), revision: 132, modified: 1793583245 });
    this.readable.add(DOC);
  }

  runner: LarkRunner = async (args, opts) => {
    this.calls.push(args);
    const ok = (data: unknown): RunResult => ({ code: 0, stdout: JSON.stringify({ ok: true, identity: 'user', data }), stderr: '' });
    const fail = (code: number, error: Record<string, unknown>): RunResult => ({ code, stdout: '', stderr: JSON.stringify({ ok: false, error }) });
    const flag = (name: string) => args[args.indexOf(name) + 1];
    const [a, b, c] = args;
    if (a === 'auth' && b === 'status') {
      const user = this.signedIn
        ? { status: 'ready', available: true, userName: '王宁', openId: 'ou_test', tokenStatus: 'valid', scope: this.scopes.join(' '), refreshExpiresAt: '2026-11-09T09:18:34+08:00' }
        : { status: 'missing', available: false, message: 'no user logged in' };
      return { code: 0, stdout: JSON.stringify({ appId: 'cli_test', brand: 'feishu', identities: { user } }), stderr: '' };
    }
    if (a === 'auth' && b === 'login' && args.includes('--no-wait')) {
      return { code: 0, stdout: JSON.stringify({ device_code: 'dev-code', expires_in: 600, verification_url: 'https://accounts.feishu.cn/oauth/v1/device/verify?user_code=ABCD' }), stderr: '' };
    }
    if (a === 'auth' && b === 'login' && args.includes('--device-code')) {
      await this.loginApproved;
      this.signedIn = true;
      return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
    }
    if (!this.signedIn) return fail(3, { type: 'auth', message: 'user token missing' });
    if (a === 'docs' && b === '+fetch') {
      const doc = this.docs.get(flag('--doc'));
      if (!doc || !this.readable.has(flag('--doc'))) return fail(1, { type: 'api', code: 1770032, message: 'forbidden' });
      return ok({ document: { document_id: flag('--doc'), revision_id: doc.revision, content: doc.content } });
    }
    if (a === 'drive' && b === 'metas') {
      const body = JSON.parse(flag('--data')) as { request_docs: { doc_token: string }[] };
      const metas = [];
      const failed = [];
      for (const r of body.request_docs) {
        const doc = this.docs.get(r.doc_token);
        if (doc && this.readable.has(r.doc_token)) metas.push({ doc_token: r.doc_token, doc_type: 'docx', title: doc.title, latest_modify_time: String(doc.modified), owner_id: 'ou_owner', url: `https://my.feishu.cn/docx/${r.doc_token}` });
        else failed.push({ token: r.doc_token, code: 970005 });
      }
      return ok({ metas, failed_list: failed });
    }
    if (a === 'wiki' && b === 'spaces' && c === 'get_node') {
      const { token } = JSON.parse(flag('--params')) as { token: string };
      if (!this.wiki.has(token)) return fail(1, { type: 'api', code: 131005, message: 'not found' });
      return ok({ node: this.nodeJson(token) });
    }
    if (a === 'wiki' && b === 'spaces' && c === 'get') {
      const { space_id } = JSON.parse(flag('--params')) as { space_id: string };
      if (!this.spaces.has(space_id)) return fail(1, { type: 'api', code: 131005, message: 'not found' });
      return ok({ space: { space_id, name: this.spaces.get(space_id) } });
    }
    if (a === 'wiki' && b === 'nodes' && c === 'list') {
      // two to a page, so the listing's paging is walked
      const p = JSON.parse(flag('--params')) as { space_id: string; parent_node_token?: string; page_token?: string };
      const children = [...this.wiki].filter(([, n]) => n.space === p.space_id && n.parent === (p.parent_node_token ?? '')).map(([t]) => t);
      const start = Number(p.page_token ?? 0);
      const more = start + 2 < children.length;
      return ok({ items: children.slice(start, start + 2).map((t) => this.nodeJson(t)), has_more: more, page_token: more ? String(start + 2) : '' });
    }
    if (a === 'docs' && b === '+media-download') {
      const token = flag('--token');
      // as lark-cli does: it writes only under its working directory (or /tmp, ~/files)
      if (path.isAbsolute(flag('--output')) || !opts.cwd) return fail(2, { type: 'validation', message: `unsafe output path: --output "${flag('--output')}" is outside the built-in allowlist` });
      const out = path.join(opts.cwd, flag('--output'));
      const [ext, body, type] = token === NOTES ? ['.txt', '做T 量能篇：放量下跌不能抄底。', 'text/plain'] : ['.png', PNG, 'image/png'];
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out + ext, body);
      return ok({ saved_path: out + ext, size_bytes: Buffer.byteLength(body), content_type: type });
    }
    return fail(2, { type: 'validation', message: `fake lark-cli does not know ${args.join(' ')}` });
  };

  private nodeJson(token: string): Record<string, unknown> {
    const n = this.wiki.get(token)!;
    const hasChild = [...this.wiki.values()].some((m) => m.parent === token);
    return { node_token: token, space_id: n.space, parent_node_token: n.parent, obj_token: n.obj, obj_type: n.type, node_type: n.nodeType ?? 'origin', title: n.title, has_child: hasChild, obj_edit_time: String(n.edited) };
  }

  /** A wiki page; a Docs one gets a document to fetch. */
  page(token: string, node: FakeNode, body = `正文：${node.title}`): void {
    this.wiki.set(token, node);
    if (node.type === 'docx' && node.nodeType !== 'shortcut') {
      this.docs.set(node.obj, { title: node.title, content: `<title>${node.title}</title>\n\n${body}`, revision: 1, modified: node.edited });
      this.readable.add(node.obj);
    }
  }

  /** Edit a wiki page's document (its title too, as a rename is an edit). */
  editPage(token: string, at: number, change: { title?: string; body?: string }): void {
    const node = this.wiki.get(token)!;
    const doc = this.docs.get(node.obj)!;
    const title = change.title ?? node.title;
    this.wiki.set(token, { ...node, title, edited: at });
    this.docs.set(node.obj, { title, content: `<title>${title}</title>\n\n${change.body ?? doc.content.split('\n\n').slice(1).join('\n\n')}`, revision: doc.revision + 1, modified: at });
  }

  fetched(): string[] {
    return this.calls.filter((c) => c[1] === '+fetch').map((c) => c[c.indexOf('--doc') + 1]);
  }

  edit(content: string, at: number): void {
    const doc = this.docs.get(DOC)!;
    this.docs.set(DOC, { ...doc, content, revision: doc.revision + 1, modified: at });
  }

  downloads(): string[] {
    return this.calls.filter((c) => c[1] === '+media-download').map((c) => c[c.indexOf('--token') + 1]);
  }
}

describe('reading a Feishu link', () => {
  it('takes docx and wiki links on any tenant, and a bare token', () => {
    expect(parseFeishuRef(`https://my.feishu.cn/docx/${DOC}`)).toEqual({ kind: 'docx', token: DOC, host: 'my.feishu.cn' });
    expect(parseFeishuRef(`https://acme.larksuite.com/wiki/${WIKI}?from=from_copylink#share-x`)).toEqual({ kind: 'wiki', token: WIKI, host: 'acme.larksuite.com' });
    expect(parseFeishuRef(`my.feishu.cn/docx/${DOC}`).token).toBe(DOC);
    expect(parseFeishuRef(DOC)).toEqual({ kind: 'docx', token: DOC, host: null });
  });

  it('takes a wiki space by its page or its settings', () => {
    expect(parseFeishuRef('https://my.feishu.cn/wiki/space/7370647643917336579')).toEqual({ kind: 'space', token: '7370647643917336579', host: 'my.feishu.cn' });
    expect(parseFeishuRef('https://acme.feishu.cn/wiki/settings/7370647643917336579?tab=members').kind).toBe('space');
  });

  it('refuses what it cannot import, saying what it is', () => {
    expect(() => parseFeishuRef(`https://my.feishu.cn/sheets/${DOC}`)).toThrow(/a Sheet — only Feishu Docs/);
    expect(() => parseFeishuRef(`https://my.feishu.cn/base/${DOC}`)).toThrow(/a Base/);
    expect(() => parseFeishuRef(`https://example.com/docx/${DOC}`)).toThrow(/not a Feishu or Lark link/);
    expect(() => parseFeishuRef('https://my.feishu.cn/drive/home')).toThrow(/no document/);
    expect(() => parseFeishuRef('')).toThrow(/required/);
  });
});

describe("lark-cli's Markdown as knode-os keeps it", () => {
  it('lists what the document references, each once, in order', () => {
    const scanned = scanFeishuMarkdown(docContent([IMG1, IMG2, IMG1]));
    expect(scanned.title).toBe('4. 九哥星球精华');
    expect(scanned.media.map((m) => [m.kind, m.token])).toEqual([
      ['file', NOTES],
      ['image', IMG1],
      ['image', IMG2],
      ['file', SHEET],
    ]);
    expect(scanned.media[3]).toMatchObject({ name: '2024年报&2025Q1.xlsx', bytes: 16613 });
  });

  it('points placed media at their local copies and names the rest as staying in Feishu', () => {
    const placed: Record<string, string> = { [IMG1]: 'assets/a.png', [NOTES]: 'files/notes.txt' };
    const { body } = renderFeishuMarkdown(docContent([IMG1, IMG2]), (m) => (placed[m.token] ? { href: placed[m.token] } : null), { host: 'my.feishu.cn' });
    expect(body).toContain('![](assets/a.png)');
    expect(body).toContain(`![](https://feishu.cn/file/${IMG2})`);
    expect(body).toContain('Attachment: [做T方法（量能篇）.txt](files/notes.txt)');
    expect(body).toContain('Attachment: 2024年报&2025Q1.xlsx (XLSX, 16 KB) — kept in Feishu, not imported');
    expect(body).toContain('Base table — kept in Feishu: [open it](https://my.feishu.cn/base/V3Y3b0SEUaDM5ws3B1ZcElwCnWc?table=tbl2aHurn7r8kzB5)');
    expect(body).not.toMatch(/<\/?(grid|column|figure|title|source|bitable)\b/);
    expect(body).not.toMatch(/\n{3,}/);
  });

  it('leaves code and text that only looks like a tag as written', () => {
    const content = ['<title>T</title>', 'Use `<grid>` in templates; <Python> is a word here.', '', '```html', '<column>kept</column>', '```', '<b>bold</b> and <a href="https://x.test">a link</a>'].join('\n');
    const { body } = renderFeishuMarkdown(content, () => null);
    expect(body).toContain('Use `<grid>` in templates; <Python> is a word here.');
    expect(body).toContain('```html\n<column>kept</column>\n```');
    expect(body).toContain('**bold** and [a link](https://x.test)');
  });

  it('turns an HTML table into a GFM table', () => {
    const content = '<table><tr><th>代码</th><th>名称</th></tr><tr><td>300059</td><td>东方财富</td></tr></table>';
    expect(renderFeishuMarkdown(content, () => null).body).toBe('| 代码 | 名称 |\n| --- | --- |\n| 300059 | 东方财富 |');
  });
});

describe('reading a long screenshot in bands', () => {
  it('reads a picture whole while it fits the frame, in bands once it is tall and too tall to fit', () => {
    expect(readInBands({ width: 1152, height: 27627 })).toBe(true);
    expect(readInBands({ width: 621, height: 2000 })).toBe(false); // a vertical mind map that fits: read whole
    expect(readInBands({ width: 2000, height: 4000 })).toBe(false); // tall, but not past the ratio
    expect(readInBands({ width: 0, height: 4000 })).toBe(false);
  });

  it('covers every row once and moves each cut to a blank row near it', () => {
    // text everywhere except a blank row every 100 rows
    const busy = (row: number) => (row % 100 === 0 ? 0 : 200);
    const bands = bandsFor(27627, 1728, busy);
    expect(bands.reduce((n, b) => n + b.height, 0)).toBe(27627);
    for (let i = 1; i < bands.length; i++) expect(bands[i].top).toBe(bands[i - 1].top + bands[i - 1].height);
    for (const b of bands.slice(1)) expect(b.top % 100).toBe(0);
    expect(bands.every((b) => b.height <= 1728)).toBe(true);
    // with no blank row in reach it cuts where it must
    expect(bandsFor(4000, 1000, () => 255).map((b) => b.height)).toEqual([1000, 1000, 1000, 1000]);
    expect(bandsFor(900, 1000, () => 0)).toEqual([{ top: 0, height: 900 }]);
  });
});

describe('the lark-cli client', () => {
  it('reports who is signed in and which needed scopes are missing', async () => {
    const fake = new FakeLark();
    fake.scopes = ['docx:document:readonly', 'offline_access'];
    const status = await new LarkCli({ runner: fake.runner }).status();
    expect(status).toMatchObject({ installed: true, signedIn: true, user: { name: '王宁', openId: 'ou_test' }, appId: 'cli_test' });
    expect(status.missingScopes).toEqual(['docs:document.content:read', 'docs:document.media:download', 'drive:drive.metadata:readonly', 'wiki:node:read']);
  });

  it('says when lark-cli is missing, and when signing in again would help', async () => {
    const missing = new LarkCli({ runner: async () => ({ code: 127, stdout: '', stderr: 'spawn lark-cli ENOENT' }) });
    expect((await missing.status()).installed).toBe(false);
    await expect(missing.fetchDocument(DOC)).rejects.toMatchObject({ kind: 'not-installed' });
    const fake = new FakeLark();
    fake.signedIn = false;
    const err = await new LarkCli({ runner: fake.runner }).fetchDocument(DOC).catch((e) => e);
    expect(err).toBeInstanceOf(FeishuError);
    expect(err.kind).toBe('auth');
    fake.signedIn = true;
    fake.readable.delete(DOC);
    await expect(new LarkCli({ runner: fake.runner }).fetchDocument(DOC)).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('signs in once through the device flow, keeping the scopes lark-cli already had', async () => {
    const fake = new FakeLark();
    let approve!: () => void;
    fake.loginApproved = new Promise((r) => (approve = r));
    const client = new LarkCli({ runner: fake.runner });
    const signIn = new FeishuSignIn(() => client);
    const state = await signIn.begin(await client.status());
    expect(state).toMatchObject({ state: 'waiting', verificationUrl: 'https://accounts.feishu.cn/oauth/v1/device/verify?user_code=ABCD' });
    const asked = fake.calls.find((c) => c.includes('--no-wait'))!;
    const scopes = asked[asked.indexOf('--scope') + 1].split(' ');
    expect(scopes).toEqual(expect.arrayContaining([...FEISHU_SCOPES, 'calendar:calendar:read']));
    // a second start while one waits returns the same link
    expect((await signIn.begin()).verificationUrl).toBe(state.verificationUrl);
    approve();
    await signIn.settled();
    expect(signIn.state().state).toBe('done');
  });
});

describe('importing and linking a document', () => {
  const data = path.join(tmp, 'data');
  let ctx: AppContext;
  let fake: FakeLark;
  const ws = (rel: string) => path.join(data, rel);

  beforeAll(async () => {
    ctx = await createContext(data);
  });
  afterAll(async () => {
    setFeishuRunner(null);
    await ctx.datasources.closeAll();
    await ctx.store.close();
  });
  beforeEach(() => {
    fake = new FakeLark();
    setFeishuRunner(fake.runner);
  });

  const dest = `raw/docs/feishu/4. 九哥星球精华__${DOC}`;
  const file = `${dest}/4. 九哥星球精华.md`;

  it('copies a document once with its pictures and indexable attachments, and indexes it', async () => {
    const r = await importFeishuDocument(ctx, feishuClient(ctx.config), `https://my.feishu.cn/docx/${DOC}`, { mode: 'copy' });
    expect(r).toMatchObject({ dest, file, title: '4. 九哥星球精华', revision: 132, images: 2, attachments: 1, keptInFeishu: 2, mode: 'copy', refreshed: false });
    expect(r.modifiedAt).toBe(new Date(1793583245 * 1000).toISOString());
    expect(fs.readFileSync(ws(`${dest}/assets/${IMG1}.png`))).toEqual(PNG);
    expect(fs.readFileSync(ws(`${dest}/files/做T方法（量能篇）.txt`), 'utf8')).toContain('放量下跌');
    const md = fs.readFileSync(ws(file), 'utf8');
    expect(md).toMatch(/^---\ntitle: "4\. 九哥星球精华"\nplatform: feishu\nsource_url: "https:\/\/my\.feishu\.cn\/docx\/GzLnd/);
    expect(md).toContain('feishu_revision: 132');
    expect(md).toContain(`as_of: "${r.modifiedAt}"`);
    expect(md).toContain(`![](assets/${IMG1}.png)`);
    expect(md).toContain('Attachment: [做T方法（量能篇）.txt](files/做T方法（量能篇）.txt)');
    expect(readManifest(data, dest)).toMatchObject({ token: DOC, revision: 132, file: '4. 九哥星球精华.md', media: { [IMG1]: `assets/${IMG1}.png`, [NOTES]: 'files/做T方法（量能篇）.txt' } });
    // the text and the text attachment are indexed; a copy is not a link
    expect(await findLiveScope(ctx.store, 'doc', file)).not.toBeNull();
    expect(await findLiveScope(ctx.store, 'doc', `${dest}/files/做T方法（量能篇）.txt`)).not.toBeNull();
    expect(feishuLinks(ctx.config)).toEqual([]);
  });

  it('refreshes the copy in place when the same document is imported again, downloading nothing it has', async () => {
    const r = await importFeishuDocument(ctx, feishuClient(ctx.config), DOC, { mode: 'copy' });
    expect(r).toMatchObject({ dest, refreshed: true, written: [], removed: [] });
    expect(fake.downloads()).toEqual([]);
  });

  it('links a document through its wiki page, adopting the copy already here', async () => {
    const r = await importFeishuDocument(ctx, feishuClient(ctx.config), `https://my.feishu.cn/wiki/${WIKI}`, { mode: 'link' });
    expect(r).toMatchObject({ dest, mode: 'link', refreshed: true });
    expect(feishuLinks(ctx.config)).toEqual([expect.objectContaining({ token: DOC, wiki: WIKI, dest, url: `https://my.feishu.cn/wiki/${WIKI}`, type: 'docx' })]);
    await expect(importFeishuDocument(ctx, feishuClient(ctx.config), DOC, { mode: 'link' })).rejects.toThrow(/already linked/);
    await expect(importFeishuDocument(ctx, feishuClient(ctx.config), DOC, { mode: 'copy' })).rejects.toThrow(/kept in sync already/);
  });

  it('keeps writes off the mirror, and the data-dir watcher too', () => {
    expect(() => assertNotLinked(ctx.config, file, 'write to')).toThrow(/mirrored from https:\/\/my\.feishu\.cn\/wiki\//);
    expect(() => assertNotLinked(ctx.config, 'raw/docs/feishu', 'delete')).toThrow(/contains the linked folder/);
    expect(syncedByFolders(data, ctx.config, `${dest}/assets/${IMG1}.png`)).toBe(true);
    expect(syncedByFolders(data, ctx.config, 'raw/docs/other.md')).toBe(false);
  });

  it('fetches nothing while Feishu reports no edit', async () => {
    const [r] = await refreshFeishuLinks(ctx, feishuClient(ctx.config));
    expect(r).toMatchObject({ dest, fetched: false, error: null });
    expect(fake.calls.some((c) => c[1] === '+fetch')).toBe(false);
  });

  it('re-mirrors an edited document: new text indexed, a picture it dropped removed, a new one downloaded once', async () => {
    const IMG3 = 'NewPictureTokenAbcdefghijk';
    // a reviewed transcript stays while its picture does, and goes with it
    fs.writeFileSync(ws(`${dest}/assets/${IMG2}.png.md`), '# 量能：缩量下跌\n');
    fs.writeFileSync(ws(`${dest}/assets/${IMG1}.png.md`), '# 量价齐升\n');
    fake.edit(docContent([IMG2, IMG3], '## 20241202\n\n机器人，拓斯达最正宗'), 1793600000);
    const [r] = await refreshFeishuLinks(ctx, feishuClient(ctx.config));
    expect(r).toMatchObject({ fetched: true, error: null, written: 2, removed: 2 });
    expect(fake.downloads()).toEqual([IMG3]);
    expect(fs.existsSync(ws(`${dest}/assets/${IMG1}.png`))).toBe(false);
    expect(fs.existsSync(ws(`${dest}/assets/${IMG1}.png.md`))).toBe(false);
    expect(fs.existsSync(ws(`${dest}/assets/${IMG2}.png.md`))).toBe(true);
    expect(fs.existsSync(ws(`${dest}/assets/${IMG3}.png`))).toBe(true);
    expect(fs.readFileSync(ws(file), 'utf8')).toContain('拓斯达最正宗');
    expect(readManifest(data, dest)).toMatchObject({ revision: 133, modifiedAt: new Date(1793600000 * 1000).toISOString() });
    expect(await findLiveScope(ctx.store, 'doc', file)).not.toBeNull();
    const [status] = describeFeishuLinks(ctx);
    expect(status).toMatchObject({ dest, revision: 133, images: 2, attachments: 1, failed: 0, file });
  });

  it('leaves the mirror alone when the document can no longer be read', async () => {
    fake.readable.delete(DOC);
    const [r] = await refreshFeishuLinks(ctx, feishuClient(ctx.config), { force: true });
    expect(r.fetched).toBe(false);
    expect(r.error).toMatch(/deleted, or no longer shared/);
    expect(fs.existsSync(ws(file))).toBe(true);
  });

  it('unlinks, keeping the copy as ordinary documents or removing it', async () => {
    const kept = await unlinkFeishuDocument(ctx, dest);
    expect(kept).toMatchObject({ removedFiles: false });
    expect(feishuLinks(ctx.config)).toEqual([]);
    expect(() => assertNotLinked(ctx.config, file)).not.toThrow();
    await importFeishuDocument(ctx, feishuClient(ctx.config), DOC, { mode: 'link' });
    const removed = await unlinkFeishuDocument(ctx, dest, { removeFiles: true });
    expect(removed.removedFiles).toBe(true);
    expect(fs.existsSync(ws(dest))).toBe(false);
    expect(await findLiveScope(ctx.store, 'doc', file)).toBeNull();
  });
});

describe('Feishu over the API', () => {
  const root = path.join(tmp, 'api-root');
  const workspaceDir = path.join(root, 'users', 'admin', 'workspaces', 'default');
  const headers = {
    'x-knode-user': 'admin',
    'x-knode-workspace-kind': 'personal',
    'x-knode-workspace-id': 'default',
    'x-knode-workspace-name': 'Default',
  };
  const jsonHeaders = { ...headers, 'content-type': 'application/json' };
  let rootCtx: AppContext;
  let registry: WorkspaceContextRegistry;
  let app: ReturnType<typeof createApp>;
  let fake: FakeLark;
  const post = (url: string, body: unknown) => app.request(url, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) });

  beforeAll(async () => {
    fake = new FakeLark();
    setFeishuRunner(fake.runner);
    rootCtx = await createContext(root);
    registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
    app = createApp(rootCtx, () => {}, registry);
    await app.request('/api/workspaces', { headers: { 'x-knode-user': 'admin' } });
  });
  afterAll(async () => {
    setFeishuRunner(null);
    await registry.closeAll();
    await rootCtx.store.close();
  });

  it('says who Feishu is signed in as', async () => {
    const status = await (await app.request('/api/feishu/auth', { headers })).json();
    expect(status).toMatchObject({ installed: true, signedIn: true, user: { name: '王宁' }, missingScopes: [], signIn: { state: 'idle' } });
  });

  it('previews a document before importing it, and names a sign-in problem as one', async () => {
    const plan = await (await post('/api/feishu/preview', { url: `https://my.feishu.cn/docx/${DOC}` })).json();
    expect(plan).toMatchObject({ token: DOC, title: '4. 九哥星球精华', dest: `raw/docs/feishu/4. 九哥星球精华__${DOC}`, existing: null, linked: null });
    expect(fs.existsSync(path.join(workspaceDir, plan.dest))).toBe(false);
    fake.signedIn = false;
    const refused = await post('/api/feishu/preview', { url: DOC });
    expect(refused.status).toBe(400);
    expect((await refused.json()).reason).toBe('feishu-auth');
    fake.signedIn = true;
    expect((await post('/api/feishu/preview', { url: 'https://my.feishu.cn/sheets/AbCdEfGhIjKlMnOpQrStUv' })).status).toBe(400);
  });

  it('links a document, marks its mirror in the tree, and syncs it on request', async () => {
    const res = await post('/api/feishu/import', { url: `https://my.feishu.cn/docx/${DOC}`, mode: 'link', wait: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, mode: 'link', images: 2, attachments: 1, indexing: false });
    const tree = await (await app.request('/api/tree', { headers })).json();
    expect(tree.links).toContainEqual({ path: body.dest, source: `https://my.feishu.cn/docx/${DOC}`, kind: 'feishu' });
    const { links } = await (await app.request('/api/feishu', { headers })).json();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ dest: body.dest, revision: 132 });
    const put = await app.request('/api/file', { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ path: body.file, content: '# overwritten' }) });
    expect(put.status).toBe(400);
    expect((await post('/api/feishu/import', { url: DOC, mode: 'link' })).status).toBe(409);
    const synced = await (await post('/api/feishu/sync', { dest: body.dest })).json();
    expect(synced.results[0]).toMatchObject({ dest: body.dest, fetched: false, error: null });
    const unlinked = await app.request(`/api/feishu?dest=${encodeURIComponent(body.dest)}&removeFiles=1`, { method: 'DELETE', headers });
    expect(unlinked.status).toBe(200);
    expect(fs.existsSync(path.join(workspaceDir, body.dest))).toBe(false);
  });
});

/* ------------------------------ wiki trees ------------------------------- */

const SPACE = '7370647643917336579';
const HOME = 'NodeHome00000000000000001';
const DESIGN = 'NodeDesign000000000000001';
const TECH = 'NodeTech00000000000000001';
const API = 'NodeApi000000000000000001';
const SHEETNODE = 'NodeSheet0000000000000001';
const UNDERSHEET = 'NodeUnderSheet00000000001';
const SHORT = 'NodeShortcut0000000000001';
const DUP = 'NodeDupe00000000000000001';
const ASSETSPAGE = 'NodeAssets000000000000001';
const MEET = 'NodeMeet00000000000000001';
const M1 = 'NodeMeeting0519000000001';
const IMGH = 'HomePictureTokenAbcdefghi';

/** A small wiki: a home page with sub-pages of every kind, and a meetings page beside it. */
function wikiFake(): FakeLark {
  const fake = new FakeLark();
  fake.spaces.set(SPACE, 'AI剧本引擎');
  const page = (token: string, parent: string, title: string, extra: Partial<FakeNode> = {}, body?: string) =>
    fake.page(token, { space: SPACE, parent, obj: `Obj${token.slice(4)}`, type: 'docx', title, edited: 1716112635, ...extra }, body);
  page(HOME, '', '首页', {}, `欢迎\n\n![](https://feishu.cn/file/${IMGH})`);
  page(DESIGN, HOME, '产品设计');
  page(TECH, HOME, '技术文档');
  page(API, TECH, '接口', {}, '接口说明：GET /v1/scripts');
  page(SHEETNODE, HOME, '数据表', { type: 'sheet' });
  page(UNDERSHEET, SHEETNODE, '表下页面');
  page(SHORT, HOME, '捷径', { nodeType: 'shortcut' });
  page(DUP, HOME, '产品设计');
  page(ASSETSPAGE, HOME, 'assets');
  page(MEET, '', '会议记录');
  page(M1, MEET, '讨论--0519', {}, '讨论了剧本引擎的分镜');
  return fake;
}

describe('placing wiki pages in folders', () => {
  const at = (nodeToken: string, treeParent: string | null, title: string): WikiTreePage => ({
    nodeToken, spaceId: SPACE, parent: treeParent ?? '', objToken: `Obj${nodeToken}`, objType: 'docx', nodeType: 'origin', title, hasChild: false, editedAt: null, treeParent, depth: 1, url: '',
  });

  it('names each folder for its page, unique among its siblings, never assets or files', () => {
    const placed = placePages([at('A1', null, 'Notes'), at('B2', null, 'notes'), at('C3', null, 'Files'), at('D4', 'A1', 'Notes')], null, null);
    expect([...placed].map(([t, p]) => [t, p.name])).toEqual([['A1', 'Notes'], ['B2', 'notes-B2'], ['C3', 'Files-C3'], ['D4', 'Notes']]);
  });

  it('keeps the name a page held, so same-titled pages do not trade folders', () => {
    const previous = { kind: 'wiki-tree' as const, spaceId: SPACE, root: null, url: '', title: '', nodes: { B2: { parent: null, name: 'Notes', title: 'Notes', objType: 'docx', nodeType: 'origin', objToken: 'x', editedAt: null } } };
    const placed = placePages([at('A1', null, 'Notes'), at('B2', null, 'Notes')], previous, null);
    expect(placed.get('B2')!.name).toBe('Notes');
    expect(placed.get('A1')!.name).toBe('Notes-A1');
  });
});

describe('importing a wiki with its pages', () => {
  const data = path.join(tmp, 'wiki-data');
  let ctx: AppContext;
  let fake: FakeLark;
  const ws = (rel: string) => path.join(data, rel);
  const tree = `raw/docs/feishu/首页__${HOME}`;

  beforeAll(async () => {
    ctx = await createContext(data);
    fake = wikiFake();
    setFeishuRunner(fake.runner);
  });
  afterAll(async () => {
    setFeishuRunner(null);
    await ctx.datasources.closeAll();
    await ctx.store.close();
  });
  beforeEach(() => {
    fake.calls = [];
  });

  it('copies a wiki page with the pages under it as folders that keep the wiki\'s structure', async () => {
    const r = await importFeishuDocument(ctx, feishuClient(ctx.config), `https://my.feishu.cn/wiki/${HOME}`, { mode: 'copy', subpages: true });
    expect(r).toMatchObject({ kind: 'tree', dest: tree, title: '首页', token: HOME, pages: { total: 9, documents: 7, fetched: 7 }, keptInFeishu: 2, images: 1, refreshed: false });
    for (const rel of ['首页.md', `assets/${IMGH}.png`, '产品设计/产品设计.md', '技术文档/技术文档.md', '技术文档/接口/接口.md', '数据表/表下页面/表下页面.md', `产品设计-${DUP.slice(0, 8)}/产品设计.md`, `assets-${ASSETSPAGE.slice(0, 8)}/assets.md`]) {
      expect(fs.existsSync(ws(`${tree}/${rel}`)), rel).toBe(true);
    }
    // a sheet stays in Feishu (its folder only holds the page under it); a shortcut is not followed
    expect(fs.readdirSync(ws(`${tree}/数据表`))).toEqual(['表下页面']);
    expect(fs.existsSync(ws(`${tree}/捷径`))).toBe(false);
    const md = fs.readFileSync(ws(`${tree}/技术文档/接口/接口.md`), 'utf8');
    expect(md).toContain(`source_url: "https://my.feishu.cn/wiki/${API}"`);
    expect(md).toContain(`feishu_wiki_node: "${API}"`);
    expect(md).toContain('GET /v1/scripts');
    expect(readTreeManifest(data, tree)).toMatchObject({ kind: 'wiki-tree', spaceId: SPACE, root: HOME, nodes: { [API]: { parent: TECH, name: '接口' }, [HOME]: { name: '' } } });
    expect(await findLiveScope(ctx.store, 'doc', `${tree}/技术文档/接口/接口.md`)).not.toBeNull();
    // six pages under the home page, listed two at a time
    expect(fake.calls.filter((c) => c[1] === 'nodes' && c.join(' ').includes(`"parent_node_token":"${HOME}"`))).toHaveLength(3);
  });

  it('refreshes that copy when it is imported again, fetching nothing unedited', async () => {
    const r = await importFeishuDocument(ctx, feishuClient(ctx.config), `https://my.feishu.cn/wiki/${HOME}`, { mode: 'copy', subpages: true });
    expect(r).toMatchObject({ kind: 'tree', dest: tree, refreshed: true, written: [], removed: [], pages: { fetched: 0 } });
    expect(fake.fetched()).toEqual([]);
  });

  it('imports a wiki page without the pages under it unless asked', async () => {
    const r = await importFeishuDocument(ctx, feishuClient(ctx.config), `https://my.feishu.cn/wiki/${TECH}`, { mode: 'copy' });
    expect(r).toMatchObject({ kind: 'document', title: '技术文档', pages: null });
    expect(fs.readdirSync(ws(r.dest)).filter((n) => !n.startsWith('.'))).toEqual(['技术文档.md']);
  });
});

describe('linking a whole wiki space and keeping it in sync', () => {
  const data = path.join(tmp, 'space-data');
  let ctx: AppContext;
  let fake: FakeLark;
  const ws = (rel: string) => path.join(data, rel);
  const space = `raw/docs/feishu/AI剧本引擎__${SPACE}`;
  const check = async () => (await refreshFeishuLinks(ctx, feishuClient(ctx.config)))[0];

  beforeAll(async () => {
    ctx = await createContext(data);
    fake = wikiFake();
    setFeishuRunner(fake.runner);
  });
  afterAll(async () => {
    setFeishuRunner(null);
    await ctx.datasources.closeAll();
    await ctx.store.close();
  });
  beforeEach(() => {
    fake.calls = [];
  });

  it('links a space: its top pages become folders, and the link remembers it as a tree', async () => {
    const r = await importFeishuDocument(ctx, feishuClient(ctx.config), `https://my.feishu.cn/wiki/space/${SPACE}`, { mode: 'link' });
    expect(r).toMatchObject({ kind: 'tree', dest: space, title: 'AI剧本引擎', pages: { total: 11, documents: 9 } });
    expect(fs.readdirSync(ws(space)).filter((n) => !n.startsWith('.')).sort()).toEqual(['会议记录', '首页']);
    expect(fs.existsSync(ws(`${space}/会议记录/讨论--0519/讨论--0519.md`))).toBe(true);
    expect(feishuLinks(ctx.config)).toEqual([expect.objectContaining({ type: 'wiki-tree', token: SPACE, space: SPACE, dest: space, url: `https://my.feishu.cn/wiki/space/${SPACE}` })]);
    expect(() => assertNotLinked(ctx.config, `${space}/首页/首页.md`, 'write to')).toThrow(/mirrored from/);
    const [status] = describeFeishuLinks(ctx);
    expect(status).toMatchObject({ type: 'wiki-tree', pages: 11, documents: 9, revision: null });
  });

  it('lists the tree and fetches nothing while no page was edited', async () => {
    const r = await check();
    expect(r).toMatchObject({ kind: 'tree', fetched: false, written: 0, removed: 0, error: null, pages: { total: 11, fetched: 0, moved: 0, removed: 0 } });
    expect(fake.fetched()).toEqual([]);
  });

  it('fetches only the page that was edited', async () => {
    fake.editPage(API, 1793600000, { body: '接口说明：POST /v2/scripts' });
    const r = await check();
    expect(r).toMatchObject({ fetched: true, pages: { fetched: 1 } });
    expect(fake.fetched()).toEqual([`Obj${API.slice(4)}`]);
    expect(fs.readFileSync(ws(`${space}/首页/技术文档/接口/接口.md`), 'utf8')).toContain('POST /v2/scripts');
  });

  it('moves a renamed page\'s folder, with the pages under it and their extractions', async () => {
    const before = `${space}/首页/技术文档/接口/接口.md`;
    const after = `${space}/首页/技术方案/接口/接口.md`;
    expect(fs.existsSync(ws(sidecarRelFor(before)))).toBe(true);
    fake.editPage(TECH, 1793600100, { title: '技术方案' });
    const r = await check();
    expect(r).toMatchObject({ fetched: true, pages: { fetched: 1, moved: 2 } });
    expect(fake.fetched()).toEqual([`Obj${TECH.slice(4)}`]);
    expect(fs.existsSync(ws(`${space}/首页/技术方案/技术方案.md`))).toBe(true);
    expect(fs.existsSync(ws(after))).toBe(true);
    expect(fs.existsSync(ws(`${space}/首页/技术文档`))).toBe(false);
    // the sidecar went along: the moved page is not converted or read again
    expect(fs.existsSync(ws(sidecarRelFor(after)))).toBe(true);
    expect(fs.existsSync(ws(sidecarRelFor(before)))).toBe(false);
    expect(await findLiveScope(ctx.store, 'doc', after)).not.toBeNull();
    expect(await findLiveScope(ctx.store, 'doc', before)).toBeNull();
  });

  it('follows a page moved under another one, and removes a page deleted from the wiki', async () => {
    fake.wiki.set(M1, { ...fake.wiki.get(M1)!, parent: HOME });
    fake.wiki.delete(DESIGN);
    const r = await check();
    expect(r).toMatchObject({ pages: { fetched: 0, moved: 1, removed: 1 } });
    expect(fs.existsSync(ws(`${space}/首页/讨论--0519/讨论--0519.md`))).toBe(true);
    expect(fs.existsSync(ws(`${space}/会议记录/讨论--0519`))).toBe(false);
    expect(fs.existsSync(ws(`${space}/首页/产品设计`))).toBe(false);
    expect(await findLiveScope(ctx.store, 'doc', `${space}/首页/产品设计/产品设计.md`)).toBeNull();
    expect(await findLiveScope(ctx.store, 'doc', `${space}/首页/讨论--0519/讨论--0519.md`)).not.toBeNull();
  });

  it('keeps a page\'s copy when it cannot be fetched, and says so', async () => {
    fake.editPage(MEET, 1793600200, { body: '新的会议' });
    fake.readable.delete(`Obj${MEET.slice(4)}`);
    const r = await check();
    expect(r.error).toBeNull();
    expect(r.warnings.join('\n')).toMatch(/会议记录: .*may not read it/);
    expect(fs.existsSync(ws(`${space}/会议记录/会议记录.md`))).toBe(true);
    fake.readable.add(`Obj${MEET.slice(4)}`);
  });

  it('reports a space it can no longer list, leaving the copy alone', async () => {
    fake.spaces.delete(SPACE);
    const r = await check();
    expect(r.error).toMatch(/left as it was/);
    expect(fs.existsSync(ws(`${space}/首页/首页.md`))).toBe(true);
    fake.spaces.set(SPACE, 'AI剧本引擎');
  });

  it('checks once a day at its time, catching up on a day missed', async () => {
    expect(feishuCheckTime(ctx.config)).toBe('06:00');
    expect(lastDailyDue('06:00', new Date(2026, 10, 2, 5, 0)).getTime()).toBe(new Date(2026, 10, 1, 6, 0).getTime());
    expect(lastDailyDue('06:00', new Date(2026, 10, 2, 7, 0)).getTime()).toBe(new Date(2026, 10, 2, 6, 0).getTime());
    const docs = new FeishuDocs(ctx);
    // nothing noted yet: owed now
    fs.rmSync(path.join(data, '.knode/feishu-checked-at'), { force: true });
    expect(docs.due()).toBe(true);
    await docs.refresh();
    const last = lastFeishuCheck(data)!;
    expect(last).not.toBeNull();
    expect(docs.due()).toBe(false);
    const tomorrow = new Date(Date.parse(last));
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(6, 1, 0, 0);
    expect(docs.due(tomorrow)).toBe(true);
    expect(Date.parse(docs.nextCheck()!)).toBeGreaterThan(Date.parse(last));
    ctx.config.ingest.feishu = { checkAt: 'off' };
    expect(feishuCheckTime(ctx.config)).toBeNull();
    expect(docs.due(tomorrow)).toBe(false);
    expect(docs.nextCheck()).toBeNull();
    ctx.config.ingest.feishu = { checkAt: '7:30' };
    expect(feishuCheckTime(ctx.config)).toBe('07:30');
    delete ctx.config.ingest.feishu;
  });

  it('checks every link now when asked, one check at a time', async () => {
    const docs = new FeishuDocs(ctx);
    expect(docs.checkNow()).toBe(true);
    expect(docs.checking).toBe(true);
    expect(docs.checkNow()).toBe(false);
    await docs.stop();
    expect(docs.checking).toBe(false);
  });

  it('unlinks the tree, removing its copies', async () => {
    const r = await unlinkFeishuDocument(ctx, space, { removeFiles: true });
    expect(r.removedFiles).toBe(true);
    expect(fs.existsSync(ws(space))).toBe(false);
    expect(await findLiveScope(ctx.store, 'doc', `${space}/首页/首页.md`)).toBeNull();
  });
});

describe('importing several Feishu links at once', () => {
  const data = path.join(tmp, 'batch-data');
  let ctx: AppContext;
  let fake: FakeLark;

  beforeAll(async () => {
    ctx = await createContext(data);
    fake = wikiFake();
    setFeishuRunner(fake.runner);
  });
  afterAll(async () => {
    setFeishuRunner(null);
    await ctx.datasources.closeAll();
    await ctx.store.close();
  });

  it('splits pasted links, each once', () => {
    expect(splitFeishuInputs(`https://a.feishu.cn/docx/${DOC}\n  https://a.feishu.cn/docx/${DOC}, ${WIKI}\n\n`)).toEqual([`https://a.feishu.cn/docx/${DOC}`, WIKI]);
  });

  it('imports each link — a document, a wiki page with its pages — reports one that fails, and indexes them in one sync', async () => {
    const out = await importFeishuBatch(ctx, feishuClient(ctx.config), [`https://my.feishu.cn/docx/${DOC}`, `https://my.feishu.cn/wiki/${MEET}`, 'https://my.feishu.cn/sheets/AbCdEfGhIjKlMnOpQrStUv'], { mode: 'link', subpages: true });
    expect(out.items.map((i) => [i.ok, i.result?.kind ?? null])).toEqual([[true, 'document'], [true, 'tree'], [false, null]]);
    expect(out.items[2].error).toMatch(/a Sheet/);
    expect(out.sync).not.toBeNull();
    expect(feishuLinks(ctx.config).map((l) => l.type)).toEqual(['docx', 'wiki-tree']);
    expect(await findLiveScope(ctx.store, 'doc', `raw/docs/feishu/会议记录__${MEET}/讨论--0519/讨论--0519.md`)).not.toBeNull();
  });

  it('stops at a lapsed sign-in instead of failing every link the same way', async () => {
    fake.signedIn = false;
    fake.calls = [];
    const out = await importFeishuBatch(ctx, feishuClient(ctx.config), [`https://my.feishu.cn/wiki/${TECH}`, `https://my.feishu.cn/wiki/${HOME}`], { mode: 'copy' });
    expect(out.items.every((i) => !i.ok && /authorization needed/.test(i.error!))).toBe(true);
    expect(fake.calls.filter((c) => c[0] === 'wiki')).toHaveLength(1);
    fake.signedIn = true;
  });
});

describe('Feishu batches and trees over the API', () => {
  const root = path.join(tmp, 'api-batch-root');
  const headers = { 'x-knode-user': 'admin', 'x-knode-workspace-kind': 'personal', 'x-knode-workspace-id': 'default', 'x-knode-workspace-name': 'Default' };
  const jsonHeaders = { ...headers, 'content-type': 'application/json' };
  let rootCtx: AppContext;
  let registry: WorkspaceContextRegistry;
  let app: ReturnType<typeof createApp>;
  const post = (url: string, body: unknown) => app.request(url, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) });

  beforeAll(async () => {
    setFeishuRunner(wikiFake().runner);
    rootCtx = await createContext(root);
    registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
    app = createApp(rootCtx, () => {}, registry);
    await app.request('/api/workspaces', { headers: { 'x-knode-user': 'admin' } });
  });
  afterAll(async () => {
    setFeishuRunner(null);
    await registry.closeAll();
    await rootCtx.store.close();
  });

  it('previews several links, a wiki page with its pages counted', async () => {
    const res = await post('/api/feishu/preview', { urls: `https://my.feishu.cn/docx/${DOC}\nhttps://my.feishu.cn/wiki/${HOME}\nnot-a-link`, subpages: true });
    const { items } = await res.json();
    expect(items.map((i: { ok: boolean }) => i.ok)).toEqual([true, true, false]);
    expect(items[0].preview).toMatchObject({ kind: 'document', title: '4. 九哥星球精华' });
    expect(items[1].preview).toMatchObject({ kind: 'tree', title: '首页', dest: `raw/docs/feishu/首页__${HOME}`, pages: { total: 9, documents: 7, keptInFeishu: 2, levels: 3 } });
  });

  it('imports a batch in the background, followed until it ends', async () => {
    const res = await post('/api/feishu/import', { urls: [`https://my.feishu.cn/docx/${DOC}`, `https://my.feishu.cn/wiki/${HOME}`], subpages: true, mode: 'copy' });
    expect(res.status).toBe(202);
    let job = (await res.json()).job as FeishuImportJob;
    expect(job).toMatchObject({ state: 'running', inputs: [`https://my.feishu.cn/docx/${DOC}`, `https://my.feishu.cn/wiki/${HOME}`] });
    expect((await post('/api/feishu/import', { urls: [DOC, WIKI], mode: 'copy' })).status).toBe(409);
    for (let i = 0; i < 100 && job.state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      job = await (await app.request(`/api/feishu/import/${job.id}`, { headers })).json();
    }
    expect(job).toMatchObject({ state: 'done', done: 2 });
    expect(job.items.map((i) => i.result?.kind)).toEqual(['document', 'tree']);
    const { jobs } = await (await app.request('/api/feishu/import', { headers })).json();
    expect(jobs[0].id).toBe(job.id);
    expect((await app.request('/api/feishu/import/nope', { headers })).status).toBe(404);
  });

  it('reports the daily check in Tasks, and checks every link when asked', async () => {
    const linked = await post('/api/feishu/import', { url: `https://my.feishu.cn/wiki/${MEET}`, subpages: true, mode: 'link', wait: true });
    expect((await linked.json()).items[0].result).toMatchObject({ kind: 'tree' });
    const synced = await (await post('/api/feishu/sync', {})).json();
    expect(synced.results).toEqual([expect.objectContaining({ kind: 'tree', fetched: false, error: null })]);
    const tasks = await (await app.request('/api/tasks', { headers })).json();
    expect(tasks.scheduled.find((x: { id: string }) => x.id === 'feishu')).toMatchObject({ at: '06:00', everyMinutes: null });
  });
});
