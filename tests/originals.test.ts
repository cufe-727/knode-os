import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { captureComment, decodeSavedHtml } from '../src/ingest/converters/html.js';
import { createApp } from '../src/server/app.js';
import { originalHtml, PAGE_POLICY } from '../src/server/originals.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';
import { textPdf } from './helpers/pdf.js';

/**
 * The file itself (src/server/originals.ts): a PDF byte for byte, a saved web
 * page with its script off and its links back on its site, for the file
 * view's "original ↗" and the Mac app's Open Original.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-originals-'));
const root = path.join(tmp, 'data');
const workspaceDir = path.join(root, 'users', 'admin', 'workspaces', 'default');

const headers = {
  'x-knode-user': 'admin',
  'x-knode-workspace-kind': 'personal',
  'x-knode-workspace-id': 'default',
  'x-knode-workspace-name': 'Default',
};

/** "人工智能公司的年收入达到四百七十亿美元" in GBK. */
const GBK_SENTENCE = Buffer.from('c8cbb9a4d6c7c4dcb9abcbbeb5c4c4eacad5c8ebb4efb5bdcbc4b0d9c6dfcaaed2dac3c0d4aa', 'hex');
const SENTENCE = '人工智能公司的年收入达到四百七十亿美元';

let rootCtx: AppContext;
let registry: WorkspaceContextRegistry;
let app: ReturnType<typeof createApp>;

const put = (rel: string, bytes: Buffer | string) => {
  const abs = path.join(workspaceDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
};
const original = (rel: string, init: RequestInit = { headers }) => app.request(`/api/file/original?path=${encodeURIComponent(rel)}`, init);

beforeAll(async () => {
  rootCtx = await createContext(root);
  registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
  app = createApp(rootCtx, () => {}, registry);
  await app.request('/api/workspaces', { headers: { 'x-knode-user': 'admin' } });
});

afterAll(async () => {
  await registry.closeAll();
  await rootCtx.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('originalHtml', () => {
  const record = captureComment({ url: 'https://example.com/news/a?utm_source=x', finalUrl: 'https://www.example.com/news/a', charset: 'utf-8' });

  it('puts the page policy and a base on the captured address at the top of the head, and drops a meta refresh', () => {
    const page = `${record}<!doctype html><html lang="en"><head data-x="1"><meta http-equiv="Refresh" content="0; url=/nojs"><title>A</title></head><body><img src="chart.png"></body></html>`;
    const out = originalHtml(page);
    expect(out).toContain(`<head data-x="1"><meta http-equiv="Content-Security-Policy" content="${PAGE_POLICY}"><base href="https://www.example.com/news/a"><title>A</title>`);
    expect(out).not.toMatch(/refresh/i);
    expect(out.startsWith(`${record}<!doctype html>`)).toBe(true);
  });

  it("resolves the page's own base against where it came from", () => {
    const out = originalHtml(`${record}<html><head><base href="../assets/"></head><body></body></html>`);
    expect(out).toContain('<base href="https://www.example.com/assets/"><base href="../assets/">');
  });

  it('finds a place without a head, and adds no base to a page that does not say where it came from', () => {
    expect(originalHtml(`${record}<html><body>x</body></html>`)).toMatch(/^<!-- knode-capture: .*\n<html><meta http-equiv="Content-Security-Policy"[^>]*><base href="https:\/\/www\.example\.com\/news\/a"><body>/);
    expect(originalHtml('<!DOCTYPE html><p>x</p>')).toMatch(/^<!DOCTYPE html><meta http-equiv="Content-Security-Policy"[^>]*><p>x<\/p>$/);
    const bare = originalHtml('<p>x</p>');
    expect(bare.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(bare).not.toContain('<base');
    // a <header> is not the head
    expect(originalHtml('<html><header>h</header></html>')).toMatch(/^<html><meta http-equiv/);
  });
});

describe('decodeSavedHtml', () => {
  it("reads knode's captures as UTF-8 whatever the page declared, and a person's saved page by its own charset", () => {
    const meta = '<html><head><meta charset="gbk"><title>t</title></head><body>';
    // a capture from before captures began with a BOM: UTF-8 bytes under the page's GBK declaration
    const old = Buffer.from(`${captureComment({ url: 'https://x.cn/a', charset: 'gbk' })}${meta}${SENTENCE}</body></html>`);
    expect(decodeSavedHtml(old)).toContain(SENTENCE);
    expect(decodeSavedHtml(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), old]))).toContain(SENTENCE);
    const saved = Buffer.concat([Buffer.from(meta), GBK_SENTENCE, Buffer.from('</body></html>')]);
    expect(decodeSavedHtml(saved)).toContain(SENTENCE);
  });
});

describe('GET /api/file/original', () => {
  it('sends a PDF as it is, to be shown in the browser', async () => {
    const pdf = textPdf('Registration Statement on Form S-1.');
    put('raw/docs/research/s/files/2026-06-01-sec-gov-s-1.pdf', pdf);
    const res = await original('raw/docs/research/s/files/2026-06-01-sec-gov-s-1.pdf');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe(`inline; filename="2026-06-01-sec-gov-s-1.pdf"; filename*=UTF-8''2026-06-01-sec-gov-s-1.pdf`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-length')).toBe(String(pdf.length));
    expect(Buffer.from(await res.arrayBuffer()).equals(pdf)).toBe(true);
  });

  it('sends a captured page sandboxed, in UTF-8, with its script off and its links on its site', async () => {
    const page = `﻿${captureComment({ url: 'https://www.example.com/a', finalUrl: 'https://www.example.com/a', charset: 'utf-8' })}<!doctype html><html><head><title>A</title></head><body><p>${SENTENCE}</p><script>steal()</script></body></html>`;
    put('raw/docs/research/s/web/a.html', page);
    const res = await original('raw/docs/research/s/web/a.html');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const policy = res.headers.get('content-security-policy')!;
    expect(policy.split('; ')[0]).toBe('sandbox allow-popups allow-popups-to-escape-sandbox');
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toMatch(/allow-scripts|allow-same-origin|script-src/);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.toString('utf8');
    expect(text).toContain(`<head><meta http-equiv="Content-Security-Policy" content="${PAGE_POLICY}"><base href="https://www.example.com/a"><title>A</title>`);
    expect(text).toContain(SENTENCE);
  });

  it("re-encodes a person's saved GBK page as UTF-8", async () => {
    put('raw/docs/saved/gbk.htm', Buffer.concat([Buffer.from('<html><head><meta charset="gbk"></head><body><p>'), GBK_SENTENCE, Buffer.from('</p></body></html>')]));
    const res = await original('raw/docs/saved/gbk.htm');
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString('utf8')).toContain(SENTENCE);
  });

  it('sends a picture as it is, and an SVG sandboxed', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    put('raw/docs/pics/chart.png', png);
    const res = await original('raw/docs/pics/chart.png');
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await res.arrayBuffer()).equals(png)).toBe(true);
    put('wiki/figures/flow.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const svg = await original('wiki/figures/flow.svg');
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('content-security-policy')).toMatch(/^sandbox; default-src 'none'/);
  });

  it('names the workspace in the query, for a link opened in a tab', async () => {
    const q = new URLSearchParams({ path: 'raw/docs/research/s/web/a.html', kind: 'personal', id: 'default', name: 'Default', user: 'admin' });
    const res = await app.request(`/api/file/original?${q}`);
    expect(res.status).toBe(200);
    // for this route only: anywhere else a query names nobody
    const stats = new URLSearchParams({ kind: 'personal', id: 'default', name: 'Default', user: 'admin' });
    expect((await app.request(`/api/stats?${stats}`)).status).toBe(401);
    const missing = new URLSearchParams({ ...Object.fromEntries(q), id: 'missing', name: 'Missing' });
    expect((await app.request(`/api/file/original?${missing}`)).status).toBe(404);
  });

  it('refuses text, private state, missing files and paths out of the workspace', async () => {
    put('wiki/note.md', '# Note\n');
    const text = await original('wiki/note.md');
    expect(text.status).toBe(400);
    expect((await text.json()).error).toMatch(/not a PDF, a book, a web page or a picture/);
    expect((await original('knode.config.json')).status).toBe(403);
    put('raw/docs/.hidden/x.pdf', textPdf('x'));
    expect((await original('raw/docs/.hidden/x.pdf')).status).toBe(403);
    expect((await original('raw/docs/none.pdf')).status).toBe(404);
    expect((await original('../../../etc/x.pdf')).status).toBe(404);
    expect((await app.request('/api/file/original', { headers })).status).toBe(400);
  });
});
