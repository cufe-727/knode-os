import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { bandsFor, readInBands } from '../src/ingest/converters/image.js';
import { FEISHU_SCOPES, FeishuError, LarkCli, LarkRunner, RunResult } from '../src/ingest/feishu/client.js';
import {
  describeFeishuLinks,
  feishuClient,
  feishuLinks,
  FeishuSignIn,
  importFeishuDocument,
  readManifest,
  refreshFeishuLinks,
  setFeishuRunner,
  unlinkFeishuDocument,
} from '../src/ingest/feishu/docs.js';
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

/** A lark-cli that knows a few documents, answering the calls knode-os makes. */
class FakeLark {
  docs = new Map<string, { title: string; content: string; revision: number; modified: number }>();
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
      if (token !== WIKI) return fail(1, { type: 'api', code: 131005, message: 'not found' });
      return ok({ node: { obj_token: DOC, obj_type: 'docx', title: '4. 九哥星球精华' } });
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
