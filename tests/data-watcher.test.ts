import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { watchTree, WatchTreeOptions } from '../src/fs/watch.js';
import { LinkedFolders } from '../src/ingest/folders.js';
import { sync } from '../src/ingest/sync.js';
import { findLiveScope } from '../src/lineage/scope.js';
import { watchDataDir } from '../src/server/serve.js';

/**
 * serve's data-dir watcher (src/server/serve.ts) and the moment it is blind:
 * libuv runs every recursive watcher of a process on one FSEvents stream and
 * rebuilds it whenever one opens or closes, and a change made then is never
 * reported. That gap is a few milliseconds wide, so here the watcher's events
 * are dropped on purpose while the test says it is blind.
 */

const blind = vi.hoisted(() => ({ roots: new Set<string>(), dropped: [] as string[] }));
vi.mock('../src/fs/watch.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/fs/watch.js')>();
  return {
    ...real,
    watchTree: (root: string, onPath: (abs: string, rel: string) => void, opts?: WatchTreeOptions) =>
      real.watchTree(root, (abs, rel) => {
        if (blind.roots.has(root)) blind.dropped.push(rel);
        else onPath(abs, rel);
      }, opts),
  };
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-data-watcher-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Wait until the async `check` holds, or fail after `ms`. */
async function eventually(check: () => Promise<boolean> | boolean, label: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('the data-dir watcher', () => {
  const data = path.join(tmp, 'data');
  const logs: string[] = [];
  let ctx: AppContext;
  let watcher: ReturnType<typeof watchDataDir> = null;
  beforeAll(async () => {
    ctx = await createContext(data);
    write(data, 'raw/docs/notes/seen.md', '# Seen\n\nFollowed from the start.\n');
    write(data, 'raw/docs/notes/gone.md', '# Gone\n\nRemoved while the watcher is blind.\n');
    write(data, 'raw/docs/archive/old.md', '# Old\n\nRemoved while watched.\n');
    await sync(ctx, { llmGraph: false });
    watcher = watchDataDir(ctx, { log: (m) => logs.push(m), track: (job) => job, debounceMs: 150 });
    await sleep(300); // FSEvents starts delivering a moment after the stream opens
  });
  afterAll(async () => {
    watcher?.close();
    await ctx.store.close();
  });

  const live = (key: string) => findLiveScope(ctx.store, 'doc', key);
  const catchUps = () => logs.filter((m) => m.startsWith('watch catch-up'));

  /**
   * Make changes the watcher never hears about, the way an edit in the moment
   * another watcher opens goes unreported. Waits until each of `paths` was
   * dropped — or a folder above it: a file landing in a folder just made may
   * come as that folder alone.
   */
  async function whileBlind(change: () => void, paths: string[]): Promise<void> {
    blind.roots.add(data);
    blind.dropped.length = 0;
    try {
      change();
      await eventually(() => paths.every((p) => blind.dropped.some((rel) => p === rel || p.startsWith(`${rel}/`))), `${paths.join(', ')} to go unreported`);
      await sleep(500); // and whatever else FSEvents had to say about them
    } finally {
      blind.roots.delete(data);
    }
  }

  /** Open a watcher somewhere else in the process and close it again. */
  function openAndCloseAnother(): void {
    const dir = fs.mkdtempSync(path.join(tmp, 'other-'));
    watchTree(dir, () => {}).close();
  }

  it('syncs what changed while another watcher opened, and nothing it had already seen', async () => {
    expect(watcher).not.toBeNull();
    // what the watcher hears about is synced as always
    const before = (await live('raw/docs/notes/seen.md'))?.sha;
    write(data, 'raw/docs/notes/seen.md', '# Seen\n\nEdited while watched.\n');
    fs.rmSync(path.join(data, 'raw/docs/archive/old.md'));
    await eventually(async () => (await live('raw/docs/notes/seen.md'))?.sha !== before, 'the watched edit to be synced');
    await eventually(async () => (await live('raw/docs/archive/old.md')) === null, 'the watched removal to be synced');

    await whileBlind(() => {
      write(data, 'raw/docs/notes/missed.md', '# Missed\n\nWritten while the watcher was blind.\n');
      fs.rmSync(path.join(data, 'raw/docs/notes/gone.md'));
    }, ['raw/docs/notes/missed.md', 'raw/docs/notes/gone.md']);
    await sleep(500);
    // nothing re-syncs raw/docs on a timer: without a catch-up these wait for the next restart
    expect(await live('raw/docs/notes/missed.md')).toBeNull();
    expect(await live('raw/docs/notes/gone.md')).not.toBeNull();

    // another watcher of the process opens: the data-dir watcher looks again
    const other = watchTree(fs.mkdtempSync(path.join(tmp, 'other-')), () => {});
    try {
      await eventually(async () => (await live('raw/docs/notes/missed.md')) !== null, 'the missed file to be synced');
      await eventually(async () => (await live('raw/docs/notes/gone.md')) === null, 'the removed file to be disposed');
    } finally {
      other.close();
    }
    await sleep(600); // the look after that close finds nothing left to do
    expect(catchUps()).toHaveLength(1);
    expect(catchUps()[0]).toMatch(/2 change\(s\)/);
    expect(catchUps()[0]).toContain('raw/docs/notes/missed.md');
    expect(catchUps()[0]).toContain('raw/docs/notes/gone.md');
    expect(catchUps()[0]).not.toMatch(/seen\.md|old\.md/);
  });

  it('leaves a linked mirror to its link, and does not re-sync the copies an unlink leaves behind', async () => {
    const source = path.join(tmp, 'export');
    write(source, 'feishu/2026-09.md', '# 飞书 · 2026-09\n\n韩国股市高开回落，影响情绪。\n');
    write(source, 'xueqiu/2026-09.md', '# 雪球 · 2026-09\n\n旭创 FCC 又过了 5 个。\n');
    const links = new LinkedFolders(ctx, { debounceMs: 150, writeSettleMs: 150, reconcileMinutes: 0 });
    const seen = catchUps().length;
    try {
      // the mirror is written while the data-dir watcher hears nothing; the
      // link's own watcher then opens, and the look it causes skips the mirror
      let adding: Promise<unknown> = Promise.resolve();
      await whileBlind(() => {
        adding = links.add(source, { dest: 'export', llmGraph: false });
      }, ['raw/docs/export/feishu/2026-09.md', 'raw/docs/export/xueqiu/2026-09.md']);
      await adding;
      expect(await live('raw/docs/export/xueqiu/2026-09.md')).not.toBeNull();
      expect(links.status()[0]).toMatchObject({ dest: 'raw/docs/export', watching: true });
      await sleep(600);
      expect(catchUps().length).toBe(seen);

      // unlinked with its copies kept, the mirror becomes ordinary content once
      // the import's claim on it lapses; the next look takes the copies as they
      // are instead of syncing all of them again
      await links.remove('raw/docs/export');
      await sleep(600);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 11_000);
      try {
        openAndCloseAnother();
        await sleep(600);
      } finally {
        vi.useRealTimers();
      }
      expect(catchUps().length).toBe(seen);

      // and from then on the data-dir watcher catches up on it like on anything else
      await whileBlind(() => write(data, 'raw/docs/export/xueqiu/2026-09.md', '# 雪球 · 2026-09\n\n改过了。\n'), ['raw/docs/export/xueqiu/2026-09.md']);
      const before = (await live('raw/docs/export/xueqiu/2026-09.md'))?.sha;
      openAndCloseAnother();
      await eventually(async () => (await live('raw/docs/export/xueqiu/2026-09.md'))?.sha !== before, 'the edited copy to be synced');
      expect(catchUps().slice(seen)).toEqual([expect.stringContaining('1 change(s)')]);
    } finally {
      await links.stop();
    }
  });
});
