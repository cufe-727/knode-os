import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import {
  importDestFor,
  importFolder,
  isImportable,
  LinkedFolders,
  linkedFolders,
  mirrorFolder,
  mirrorPaths,
  planFolderImport,
  refreshLinkedFolders,
  resolveImportSource,
  syncedByFolders,
  unlinkFolder,
} from '../src/ingest/folders.js';
import { rawDocsUnder } from '../src/ingest/prepare.js';
import { sync } from '../src/ingest/sync.js';
import { findLiveScope } from '../src/lineage/scope.js';
import { createApp } from '../src/server/app.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';

/**
 * Folder import (src/ingest/folders.ts): a folder elsewhere on this machine
 * mirrored under raw/docs with its tree intact — once, or linked and kept in
 * sync — and the scoped prepare pass a linked folder's changes rely on.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-folders-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function write(root: string, rel: string, content: string | Buffer): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Wait until the async `check` holds, or fail after `ms`. */
async function eventually(check: () => Promise<boolean>, label: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Wait until `check` holds, or fail after `ms`. */
async function until(check: () => boolean, ms = 10_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** A folder the way the rookie-trade export lays one out: platform / group / month, plus the things an import must leave behind. */
function makeExport(dir: string): void {
  write(dir, 'INDEX.md', '# 资讯平台按月原始数据\n');
  write(dir, 'feishu/INDEX.md', '# 飞书 · 群聊目录\n');
  write(dir, 'feishu/混沌__e33af2da801e/2026-09.md', '# 飞书 · 混沌 · 2026-09\n\n## 2026-09-29 20:21:00 · 混沌 · 帖子\n\n韩国股市高开回落，影响情绪。\n');
  write(dir, 'feishu/混沌__e33af2da801e/2026-10.md', '# 飞书 · 混沌 · 2026-10\n\n## 2026-10-01 09:47:13 · 混沌 · 帖子\n\n地产还有利好：房贷利息贴息启动。\n');
  write(dir, 'xueqiu/2026-09.md', '# 雪球 · 2026-09\n\n## 2026-09-01 · 管我财 · 评论\n\n旭创 FCC 又过了 5 个。\n');
  write(dir, '.state/parts/0001.ndjson.gz', 'not for us');
  write(dir, 'content.sqlite', 'binary');
  write(dir, 'update.command', '#!/bin/zsh\n');
  write(dir, 'big/2025-07.md', `# huge\n\n${'x'.repeat(4 * 1024 * 1024 + 10)}\n`);
}

describe('planning an import', () => {
  const source = path.join(tmp, 'plan-source');
  beforeAll(() => makeExport(source));

  it('carries indexable files with their paths, leaves hidden entries and other types behind, flags the oversized', () => {
    const plan = planFolderImport(source);
    expect([...plan.files.map((f) => f.rel)].sort()).toEqual([
      'INDEX.md',
      'big/2025-07.md',
      'feishu/INDEX.md',
      'feishu/混沌__e33af2da801e/2026-09.md',
      'feishu/混沌__e33af2da801e/2026-10.md',
      'xueqiu/2026-09.md',
    ]);
    // the order is stable between runs, which is what keeps a mirror pass deterministic
    expect(planFolderImport(source).files.map((f) => f.rel)).toEqual(plan.files.map((f) => f.rel));
    expect(plan.skippedByType).toBe(2); // content.sqlite, update.command — .state/ is never visited
    expect(plan.tooLarge).toBe(1);
    expect(plan.bytes).toBe(plan.files.reduce((n, f) => n + f.bytes, 0));
  });

  it('knows what can travel', () => {
    expect(isImportable('feishu/a/2026-09.md')).toBe(true);
    expect(isImportable('report.pdf')).toBe(true);
    expect(isImportable('.state/parts/x.md')).toBe(false);
    expect(isImportable('a/.sidecar/x.md')).toBe(false);
    expect(isImportable('node_modules/x.md')).toBe(false);
    expect(isImportable('a.sqlite')).toBe(false);
  });

  it('accepts only an absolute, existing folder that neither sits in the workspace nor contains it', () => {
    const data = path.join(tmp, 'plan-data');
    initDataDir(data);
    expect(resolveImportSource(data, source)).toBe(source);
    expect(() => resolveImportSource(data, 'relative/path')).toThrow(/absolute/);
    expect(() => resolveImportSource(data, path.join(tmp, 'nowhere'))).toThrow(/no such folder/);
    expect(() => resolveImportSource(data, path.join(source, 'INDEX.md'))).toThrow(/not a folder/);
    expect(() => resolveImportSource(data, path.join(data, 'raw'))).toThrow(/inside this workspace/);
    expect(() => resolveImportSource(data, tmp)).toThrow(/contains this workspace/);
    expect(() => resolveImportSource(data, '')).toThrow(/required/);
  });

  it('puts the mirror under raw/docs whatever spelling the destination takes', () => {
    expect(importDestFor('/x/exports')).toBe('raw/docs/exports');
    expect(importDestFor('/x/exports', 'finance/exports')).toBe('raw/docs/finance/exports');
    expect(importDestFor('/x/exports', 'raw/docs/finance')).toBe('raw/docs/finance');
    expect(importDestFor('/x/exports', '../../etc')).toBe('raw/docs/etc');
    expect(() => importDestFor('/x/exports', 'raw/docs')).toThrow(/not raw\/docs itself/);
    expect(() => importDestFor('/x/exports', 'raw/docs/.sidecar/x')).toThrow(/system-owned/);
  });
});

describe('mirroring', () => {
  const source = path.join(tmp, 'mirror-source');
  const data = path.join(tmp, 'mirror-data');
  beforeAll(() => {
    makeExport(source);
    initDataDir(data);
  });

  it('copies the tree, is idempotent, follows edits and prunes what the source lost', () => {
    const first = mirrorFolder(data, source, 'raw/docs/exports', { prune: true });
    expect(first.copied).toHaveLength(6);
    expect(first.removed).toEqual([]);
    expect(fs.readFileSync(path.join(data, 'raw/docs/exports/feishu/混沌__e33af2da801e/2026-10.md'), 'utf8')).toContain('房贷利息贴息');
    expect(fs.existsSync(path.join(data, 'raw/docs/exports/.state'))).toBe(false);
    expect(fs.existsSync(path.join(data, 'raw/docs/exports/content.sqlite'))).toBe(false);
    // the copy keeps the source's mtime: that is how the next pass knows it is current
    const srcStat = fs.statSync(path.join(source, 'xueqiu/2026-09.md'));
    const dstStat = fs.statSync(path.join(data, 'raw/docs/exports/xueqiu/2026-09.md'));
    expect(Math.abs(dstStat.mtimeMs - srcStat.mtimeMs)).toBeLessThan(2);

    const second = mirrorFolder(data, source, 'raw/docs/exports', { prune: true });
    expect(second.copied).toEqual([]);
    expect(second.unchanged).toBe(6);

    write(source, 'xueqiu/2026-09.md', '# 雪球 · 2026-09\n\n## 2026-09-02 · 管我财 · 评论\n\n改了。\n');
    write(source, 'xueqiu/2026-10.md', '# 雪球 · 2026-10\n');
    fs.rmSync(path.join(source, 'feishu/混沌__e33af2da801e/2026-09.md'));
    const third = mirrorFolder(data, source, 'raw/docs/exports', { prune: true });
    expect(third.copied.sort()).toEqual(['raw/docs/exports/xueqiu/2026-09.md', 'raw/docs/exports/xueqiu/2026-10.md']);
    expect(third.removed).toEqual(['raw/docs/exports/feishu/混沌__e33af2da801e/2026-09.md']);
    expect(fs.readFileSync(path.join(data, 'raw/docs/exports/xueqiu/2026-09.md'), 'utf8')).toContain('改了');
  });

  it('mirrors just the paths a watcher reported, and ignores what cannot travel', () => {
    const link = { source, dest: 'raw/docs/exports', createdAt: new Date().toISOString() };
    write(source, 'weibo/2026-10.md', '# 微博 · 2026-10\n');
    write(source, '.state/x.md', 'hidden');
    fs.rmSync(path.join(source, 'xueqiu/2026-10.md'));
    const { changed } = mirrorPaths(data, link, [
      path.join(source, 'weibo/2026-10.md'),
      path.join(source, '.state/x.md'),
      path.join(source, 'xueqiu/2026-10.md'),
      path.join(source, 'content.sqlite'),
      path.join(tmp, 'elsewhere.md'),
      path.join(source, 'INDEX.md'), // unchanged: nothing to copy
    ]);
    expect(changed.sort()).toEqual(['raw/docs/exports/weibo/2026-10.md', 'raw/docs/exports/xueqiu/2026-10.md']);
    expect(fs.existsSync(path.join(data, 'raw/docs/exports/weibo/2026-10.md'))).toBe(true);
    expect(fs.existsSync(path.join(data, 'raw/docs/exports/xueqiu/2026-10.md'))).toBe(false);
    expect(fs.existsSync(path.join(data, 'raw/docs/exports/.state'))).toBe(false);
  });
});

describe('the scoped prepare pass', () => {
  const data = path.join(tmp, 'scoped-data');
  let ctx: AppContext;
  beforeAll(async () => {
    ctx = await createContext(data);
  });
  afterAll(async () => {
    await ctx.store.close();
  });

  it('lists only the raw/docs sources under the sync prefixes', () => {
    write(data, 'raw/docs/a.md', '# a');
    write(data, 'raw/docs/sub/b.md', '# b');
    write(data, 'raw/docs/sub/deeper/c.md', '# c');
    expect(rawDocsUnder(data, undefined).sort()).toEqual(['raw/docs/a.md', 'raw/docs/sub/b.md', 'raw/docs/sub/deeper/c.md']);
    expect(rawDocsUnder(data, ['raw']).sort()).toEqual(['raw/docs/a.md', 'raw/docs/sub/b.md', 'raw/docs/sub/deeper/c.md']);
    expect(rawDocsUnder(data, ['raw/docs/sub']).sort()).toEqual(['raw/docs/sub/b.md', 'raw/docs/sub/deeper/c.md']);
    expect(rawDocsUnder(data, ['raw/docs/a.md', 'raw/docs/sub/deeper'])).toEqual(['raw/docs/a.md', 'raw/docs/sub/deeper/c.md']);
    expect(rawDocsUnder(data, ['raw/docs/gone.md'])).toEqual([]);
    expect(rawDocsUnder(data, ['raw/docs/.sidecar/x.md'])).toEqual([]);
    expect(rawDocsUnder(data, ['wiki/x.md'])).toEqual([]);
  });

  it('applies the keys it was asked about and nothing else, and a later full sync picks up the rest', async () => {
    const scoped = await sync(ctx, { only: ['raw/docs/a.md'], llmGraph: false });
    expect(scoped.indexed).toBe(1);
    expect(await findLiveScope(ctx.store, 'doc', 'raw/docs/a.md')).not.toBeNull();
    expect(await findLiveScope(ctx.store, 'doc', 'raw/docs/sub/b.md')).toBeNull();

    // the full run also applies the wiki's seed pages; the two documents the scoped run left out are among them
    const full = await sync(ctx, { llmGraph: false });
    expect(full.indexed).toBeGreaterThanOrEqual(2);
    expect(await findLiveScope(ctx.store, 'doc', 'raw/docs/sub/b.md')).not.toBeNull();
    expect(await findLiveScope(ctx.store, 'doc', 'raw/docs/sub/deeper/c.md')).not.toBeNull();
  });
});

describe('folder import over the API', () => {
  const root = path.join(tmp, 'api-root');
  const workspaceDir = path.join(root, 'users', 'admin', 'workspaces', 'default');
  const source = path.join(tmp, 'api-source');
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

  const post = (url: string, body: unknown) => app.request(url, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) });
  const tree = async () => (await app.request('/api/tree', { headers })).json();
  const findNode = (node: { path: string; children?: unknown[] }, p: string): (Record<string, unknown> & { children?: unknown[] }) | null => {
    if (node.path === p) return node as Record<string, unknown>;
    for (const child of (node.children ?? []) as { path: string; children?: unknown[] }[]) {
      const hit = findNode(child, p);
      if (hit) return hit;
    }
    return null;
  };
  const workspaceCtx = () => registry.get({ user: 'admin', kind: 'personal', id: 'default', name: 'Default', slug: 'default', relativeDir: 'users/admin/workspaces/default' });

  beforeAll(async () => {
    makeExport(source);
    rootCtx = await createContext(root);
    registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
    app = createApp(rootCtx, () => {}, registry);
    await app.request('/api/workspaces', { headers: { 'x-knode-user': 'admin' } });
  });

  afterAll(async () => {
    await registry.closeAll();
    await rootCtx.store.close();
  });

  it('previews what an import would carry without writing anything', async () => {
    const response = await post('/api/folders/preview', { source });
    expect(response.status).toBe(200);
    const plan = await response.json();
    expect(plan).toMatchObject({ source, dest: 'raw/docs/api-source', files: 6, skippedByType: 2, tooLarge: 1, exists: false, linked: null });
    expect(plan.sample).toContain('feishu/混沌__e33af2da801e/2026-10.md');
    expect(fs.existsSync(path.join(workspaceDir, 'raw/docs/api-source'))).toBe(false);

    expect((await post('/api/folders/preview', { source: 'relative' })).status).toBe(400);
    expect((await post('/api/folders/preview', { source: path.join(tmp, 'missing') })).status).toBe(400);
  });

  it('copies a folder once, tree intact, and indexes it after answering', async () => {
    const response = await post('/api/folders/import', { source, dest: 'exports', mode: 'copy' });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ ok: true, mode: 'copy', dest: 'raw/docs/exports', tooLarge: 1, sync: null, indexing: true });
    expect(result.copied).toHaveLength(6);
    // indexing follows the answer: five indexable documents; the oversized one is copied and skipped, as the plan said
    const ctx = await workspaceCtx();
    const docs = ['INDEX.md', 'feishu/INDEX.md', 'feishu/混沌__e33af2da801e/2026-09.md', 'feishu/混沌__e33af2da801e/2026-10.md', 'xueqiu/2026-09.md'];
    await eventually(async () => (await Promise.all(docs.map((d) => findLiveScope(ctx.store, 'doc', `raw/docs/exports/${d}`)))).every(Boolean), 'the copy to be indexed');
    expect(await findLiveScope(ctx.store, 'doc', 'raw/docs/exports/big/2025-07.md')).toBeNull();
    expect(fs.existsSync(path.join(workspaceDir, 'raw/docs/exports/feishu/混沌__e33af2da801e/2026-10.md'))).toBe(true);
    expect(fs.existsSync(path.join(workspaceDir, 'raw/docs/exports/content.sqlite'))).toBe(false);

    const t = await tree();
    const group = findNode(t, 'raw/docs/exports/feishu/混沌__e33af2da801e');
    expect(group?.kind).toBe('dir');
    expect((group?.children as { name: string }[]).map((c) => c.name).sort()).toEqual(['2026-09.md', '2026-10.md']);
    expect(findNode(t, 'raw/docs/exports')?.linked).toBeUndefined();

    const search = await (await app.request(`/api/search?q=${encodeURIComponent('房贷利息贴息')}&mode=keyword`, { headers })).json();
    expect(search.some((r: { path: string }) => r.path === 'raw/docs/exports/feishu/混沌__e33af2da801e/2026-10.md')).toBe(true);
  });

  it('refuses to land on an occupied destination unless told to replace it', async () => {
    expect((await post('/api/folders/import', { source, dest: 'exports', mode: 'copy' })).status).toBe(409);
    write(path.join(workspaceDir), 'raw/docs/exports/stray.md', '# only here');
    const replaced = await post('/api/folders/import', { source, dest: 'exports', mode: 'copy', replace: true });
    expect(replaced.status).toBe(200);
    const result = await replaced.json();
    expect(result.copied).toEqual([]);
    expect(result.removed).toEqual(['raw/docs/exports/stray.md']);
    expect(result.unchanged).toBe(6);
    expect((await post('/api/folders/import', { source, mode: 'tar' })).status).toBe(400);
  });

  it('links a folder: the mirror is marked in the tree, remembered in the config, and read-only to every write route', async () => {
    // `wait`: the answer comes once the link is indexed, with what that pass did
    const response = await post('/api/folders/import', { source, dest: 'finance/exports', mode: 'link', wait: true });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ ok: true, mode: 'link', dest: 'raw/docs/finance/exports', indexing: false });
    expect(result.sync.indexed).toBe(5);

    const config = loadConfig(workspaceDir);
    expect(config.ingest.linkedFolders).toEqual([expect.objectContaining({ source, dest: 'raw/docs/finance/exports' })]);
    const links = await (await app.request('/api/folders', { headers })).json();
    expect(links.links).toEqual([expect.objectContaining({ source, dest: 'raw/docs/finance/exports', files: 6, sourceExists: true, watching: false })]);

    const t = await tree();
    expect(findNode(t, 'raw/docs/finance/exports')?.linked).toBe(source);
    expect(findNode(t, 'raw/docs/finance')?.linked).toBeUndefined();

    const mirrored = 'raw/docs/finance/exports/xueqiu/2026-09.md';
    const put = await app.request('/api/file', { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ path: mirrored, content: '# overwritten' }) });
    expect(put.status).toBe(400);
    expect((await put.json()).error).toMatch(/mirrored from/);
    expect((await app.request(`/api/file?path=${encodeURIComponent(mirrored)}`, { method: 'DELETE', headers })).status).toBe(400);
    expect((await post('/api/mkdir', { path: 'raw/docs/finance/exports/mine' })).status).toBe(400);
    expect((await post('/api/mv', { from: mirrored, to: 'raw/docs/moved.md' })).status).toBe(400);
    expect((await post('/api/mv', { from: 'raw/docs/exports/INDEX.md', to: 'raw/docs/finance/exports/INDEX2.md' })).status).toBe(400);
    // the folder holding the mirror cannot be moved or deleted either: the link would dangle
    expect((await post('/api/mv', { from: 'raw/docs/finance', to: 'raw/docs/money' })).status).toBe(400);
    expect((await app.request('/api/file?path=raw/docs/finance', { method: 'DELETE', headers })).status).toBe(400);
    const form = new FormData();
    form.set('dir', 'raw/docs/finance/exports');
    form.append('files', new File(['x'], 'x.md'));
    expect((await app.request('/api/upload', { method: 'POST', headers, body: form })).status).toBe(400);
    expect(fs.readFileSync(path.join(workspaceDir, mirrored), 'utf8')).not.toContain('overwritten');

    // a second link of the same source, or one over the mirror, is a conflict
    expect((await post('/api/folders/import', { source, dest: 'twin', mode: 'link' })).status).toBe(409);
    expect((await post('/api/folders/import', { source: path.join(tmp, 'mirror-source'), dest: 'finance/exports/inner', mode: 'copy' })).status).toBe(409);
    expect((await post('/api/folders/import', { source: path.join(tmp, 'mirror-source'), dest: 'finance', mode: 'copy', replace: true })).status).toBe(409);
  });

  it('syncs a link on demand: edits and additions are indexed, removals disposed', async () => {
    const ctx = await workspaceCtx();
    write(source, 'feishu/混沌__e33af2da801e/2026-10.md', '# 飞书 · 混沌 · 2026-10\n\n## 2026-10-02 · 混沌 · 帖子\n\n万科由跌停爬起涨停。\n');
    write(source, 'feishu/唐主任__d2ab09754b4f/2026-10.md', '# 飞书 · 唐主任 · 2026-10\n\n## 2026-10-03 · 唐主任 · 帖子\n\n光模块需求继续上行。\n');
    fs.rmSync(path.join(source, 'xueqiu/2026-09.md'));

    const response = await post('/api/folders/sync', { dest: 'raw/docs/finance/exports' });
    expect(response.status).toBe(200);
    const { results } = await response.json();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ dest: 'raw/docs/finance/exports', copied: 2, removed: 1, sourceMissing: false });
    expect(results[0].sync.indexed).toBe(2);
    expect(results[0].sync.disposed).toBe(1);
    expect(await findLiveScope(ctx.store, 'doc', 'raw/docs/finance/exports/xueqiu/2026-09.md')).toBeNull();
    expect(await findLiveScope(ctx.store, 'doc', 'raw/docs/finance/exports/feishu/唐主任__d2ab09754b4f/2026-10.md')).not.toBeNull();
    const search = await (await app.request(`/api/search?q=${encodeURIComponent('万科 涨停')}&mode=keyword`, { headers })).json();
    expect(search.some((r: { path: string }) => r.path === 'raw/docs/finance/exports/feishu/混沌__e33af2da801e/2026-10.md')).toBe(true);

    // nothing changed since: the mirror is current and no sync runs
    const again = await (await post('/api/folders/sync', {})).json();
    expect(again.results[0]).toMatchObject({ copied: 0, removed: 0, sync: null });
    expect((await post('/api/folders/sync', { dest: 'raw/docs/nope' })).status).toBe(400);
  });

  it('leaves the mirror alone while the source folder is away', async () => {
    const away = `${source}.away`;
    fs.renameSync(source, away);
    try {
      const { results } = await (await post('/api/folders/sync', { dest: 'raw/docs/finance/exports' })).json();
      expect(results[0]).toMatchObject({ sourceMissing: true, removed: 0 });
      expect(fs.existsSync(path.join(workspaceDir, 'raw/docs/finance/exports/INDEX.md'))).toBe(true);
      const links = await (await app.request('/api/folders', { headers })).json();
      expect(links.links[0].sourceExists).toBe(false);
    } finally {
      fs.renameSync(away, source);
    }
  });

  it('unlinks, keeping the copies or removing them', async () => {
    const ctx = await workspaceCtx();
    const kept = await app.request('/api/folders?dest=raw%2Fdocs%2Ffinance%2Fexports', { method: 'DELETE', headers });
    expect(kept.status).toBe(200);
    expect(await kept.json()).toMatchObject({ ok: true, removedFiles: false });
    expect(loadConfig(workspaceDir).ingest.linkedFolders).toEqual([]);
    expect(fs.existsSync(path.join(workspaceDir, 'raw/docs/finance/exports/INDEX.md'))).toBe(true);
    expect(findNode(await tree(), 'raw/docs/finance/exports')?.linked).toBeUndefined();
    // an ordinary folder again: writable
    expect((await post('/api/mkdir', { path: 'raw/docs/finance/exports/mine' })).status).toBe(200);
    expect((await app.request('/api/folders?dest=raw%2Fdocs%2Ffinance%2Fexports', { method: 'DELETE', headers })).status).toBe(400);

    expect((await post('/api/folders/import', { source, dest: 'gone', mode: 'link', wait: true })).status).toBe(200);
    const removed = await app.request('/api/folders?dest=raw%2Fdocs%2Fgone&removeFiles=1', { method: 'DELETE', headers });
    expect(removed.status).toBe(200);
    const body = await removed.json();
    expect(body.removedFiles).toBe(true);
    expect(body.sync.disposed).toBe(5);
    expect(fs.existsSync(path.join(workspaceDir, 'raw/docs/gone'))).toBe(false);
    expect(await findLiveScope(ctx.store, 'doc', 'raw/docs/gone/INDEX.md')).toBeNull();
  });
});

describe('the linked-folder service', () => {
  const data = path.join(tmp, 'service-data');
  const source = path.join(tmp, 'service-source');
  let ctx: AppContext;
  let service: LinkedFolders;
  beforeAll(async () => {
    makeExport(source);
    ctx = await createContext(data);
  });
  afterAll(async () => {
    await service?.stop();
    await ctx.store.close();
  });

  it('links, follows the source with a watcher, and reconciles on refresh', async () => {
    service = new LinkedFolders(ctx, { debounceMs: 150, writeSettleMs: 150, reconcileMinutes: 0 });
    const linked = await service.add(source, { dest: 'exports', llmGraph: false });
    expect(linked.sync.indexed).toBe(5);
    expect(linkedFolders(ctx.config)).toHaveLength(1);
    expect(service.status()[0]).toMatchObject({ dest: 'raw/docs/exports', watching: true, files: 6 });

    // a change in the source reaches the mirror and the index without anyone asking
    write(source, 'weibo/2026-10.md', '# 微博 · 2026-10\n\n## 2026-10-05 · 大才子 · 帖子\n\n存储芯片涨价。\n');
    await until(() => fs.existsSync(path.join(data, 'raw/docs/exports/weibo/2026-10.md')), 15_000, 'the mirror to pick up weibo/2026-10.md');
    await until(() => service.status()[0].lastChange?.copied === 1, 15_000, 'the sync after the copy');
    expect(await findLiveScope(ctx.store, 'doc', 'raw/docs/exports/weibo/2026-10.md')).not.toBeNull();

    // and so does a removal: the copy goes, then the scoped sync disposes the document
    fs.rmSync(path.join(source, 'weibo/2026-10.md'));
    await until(() => !fs.existsSync(path.join(data, 'raw/docs/exports/weibo/2026-10.md')), 15_000, 'the mirror to drop weibo/2026-10.md');
    let disposed = false;
    for (let i = 0; i < 150 && !disposed; i++) {
      disposed = (await findLiveScope(ctx.store, 'doc', 'raw/docs/exports/weibo/2026-10.md')) === null;
      if (!disposed) await sleep(100);
    }
    expect(disposed).toBe(true);

    // what a watcher may miss, a refresh catches
    await service.stop();
    write(source, 'tgb/2026-10.md', '# 淘股吧 · 2026-10\n');
    const [refreshed] = await service.refresh('raw/docs/exports');
    expect(refreshed.copied).toEqual(['raw/docs/exports/tgb/2026-10.md']);
    expect(refreshed.sync?.indexed).toBe(1);

    // the same through the plain function `knode-os folders sync` uses, and an unlink that keeps the files
    const [again] = await refreshLinkedFolders(ctx, 'raw/docs/exports');
    expect(again.sync).toBeNull();
    const unlinked = await unlinkFolder(ctx, 'raw/docs/exports');
    expect(unlinked.removedFiles).toBe(false);
    expect(linkedFolders(ctx.config)).toEqual([]);
    expect(fs.existsSync(path.join(data, 'raw/docs/exports/tgb/2026-10.md'))).toBe(true);
  });

  it('catches up on a change made before its watcher could report it', async () => {
    const early = path.join(tmp, 'early-source');
    const mirror = path.join(data, 'raw/docs/early');
    makeExport(early);
    const linker = new LinkedFolders(ctx, { debounceMs: 150, writeSettleMs: 150, reconcileMinutes: 0 });
    let wrote = false;
    try {
      // written once the mirror pass is done, while the link still indexes: no
      // watcher is up yet, so none will ever report it
      await linker.add(early, {
        dest: 'early',
        llmGraph: false,
        onProgress: () => {
          if (wrote || !fs.existsSync(path.join(mirror, 'INDEX.md'))) return;
          write(early, 'weibo/2026-10.md', '# 微博 · 2026-10\n\n## 2026-10-05 · 大才子 · 帖子\n\n存储芯片涨价。\n');
          wrote = true;
        },
      });
      expect(wrote).toBe(true);
      expect(fs.existsSync(path.join(mirror, 'weibo/2026-10.md'))).toBe(false);
      await until(() => fs.existsSync(path.join(mirror, 'weibo/2026-10.md')), 15_000, 'the mirror to catch up with weibo/2026-10.md');
      await until(() => linker.status().find((s) => s.dest === 'raw/docs/early')?.lastChange?.copied === 1, 15_000, 'the sync after the copy');
      expect(await findLiveScope(ctx.store, 'doc', 'raw/docs/early/weibo/2026-10.md')).not.toBeNull();
    } finally {
      await linker.stop();
    }
  });

  it('applies reported paths directly when driven without a watcher', async () => {
    // a source of its own: a link another test left behind is no conflict
    const own = path.join(tmp, 'driven-source');
    makeExport(own);
    const result = await importFolder(ctx, own, { dest: 'again', mode: 'link', llmGraph: false });
    expect(result.copied.length).toBeGreaterThan(0);
    const link = linkedFolders(ctx.config).find((l) => l.source === own)!;
    expect(link.dest).toBe('raw/docs/again');
    const driven = new LinkedFolders(ctx, { reconcileMinutes: 0 });
    write(own, 'tgb/2026-11.md', '# 淘股吧 · 2026-11\n\n短线情绪回暖。\n');
    await driven.apply(link, [path.join(own, 'tgb/2026-11.md')]);
    expect(await findLiveScope(ctx.store, 'doc', 'raw/docs/again/tgb/2026-11.md')).not.toBeNull();
    expect(driven.status().find((s) => s.dest === 'raw/docs/again')?.lastChange).toMatchObject({ copied: 1 });
    await driven.stop();
  });
});

describe('what the folder machinery syncs by itself', () => {
  const data = path.join(tmp, 'owned-data');
  const source = path.join(tmp, 'owned-source');
  let ctx: AppContext;
  beforeAll(async () => {
    makeExport(source);
    ctx = await createContext(data);
  });
  afterAll(async () => {
    vi.useRealTimers();
    await ctx.store.close();
  });
  const owned = (rel: string) => syncedByFolders(ctx.dataDir, ctx.config, rel);
  const later = (ms: number) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + ms);
  };

  it('claims an import while it writes and syncs, and for a moment after; never the folders around it', async () => {
    const key = 'raw/docs/owned/xueqiu/2026-09.md';
    expect(owned(key)).toBe(false);
    const during: boolean[] = [];
    await importFolder(ctx, source, { mode: 'copy', dest: 'owned', onProgress: () => during.push(owned(key)) });
    expect(during).toContain(true);
    // the watcher's events arrive late: still the import's
    expect(owned(key)).toBe(true);
    expect(owned('raw/docs/owned')).toBe(true);
    expect(owned('raw/docs/owned-too/a.md')).toBe(false);
    expect(owned('raw/docs')).toBe(false);
    expect(owned('raw/docs/notes.md')).toBe(false);
    later(11_000);
    // a copy is ordinary content once the claim lapses
    expect(owned(key)).toBe(false);
    vi.useRealTimers();
  });

  it('leaves a linked mirror to its link for as long as it is linked, and an unlink with its files to the unlink', async () => {
    const key = 'raw/docs/followed/xueqiu/2026-09.md';
    await importFolder(ctx, source, { mode: 'link', dest: 'followed' });
    later(60_000);
    expect(owned(key)).toBe(true);
    vi.useRealTimers();

    await unlinkFolder(ctx, 'raw/docs/followed', { removeFiles: true });
    expect(linkedFolders(ctx.config)).toEqual([]);
    expect(fs.existsSync(path.join(ctx.dataDir, 'raw/docs/followed'))).toBe(false);
    // the removal was synced by the unlink itself
    expect(await findLiveScope(ctx.store, 'doc', key)).toBeNull();
    expect(owned(key)).toBe(true);
    later(11_000);
    expect(owned(key)).toBe(false);
    vi.useRealTimers();
  });
});
