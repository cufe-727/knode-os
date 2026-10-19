import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, KnodeConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { rebuild } from '../src/lineage/rebuild.js';
import { pluginRegistry } from '../src/plugins/registry.js';
import { resolveWorkspaceScope, WorkspaceContextRegistry } from '../src/server/workspaces.js';
import { dropBackend, dropPglite, openPglite } from '../src/store/backend.js';

/**
 * Clearing a workspace and `knode-os rebuild` drop the index through the
 * storage backend (docs/design/11 §3.3). Deleting files is not enough: an
 * index kept anywhere else — a PostgreSQL schema named after the workspace
 * path, a PGlite directory outside the workspace, a plugin's own location —
 * would be reopened by the recreated workspace. These run on PGlite; the
 * schema drop itself is exercised in backend-postgres.test.ts.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-drop-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** The data dirs the `side-store` backend was asked to drop. */
const dropped: string[] = [];

beforeAll(() => {
  // a backend that keeps its index where `database.path` does not say, as a plugin backend may
  pluginRegistry().registerStorageBackend({
    id: 'side-store',
    label: 'Side store',
    open: (dataDir) => openPglite(dataDir, { path: '.knode/side-db' }),
    drop: async (dataDir) => {
      dropped.push(dataDir);
      await dropPglite(dataDir, { path: '.knode/side-db' });
    },
  }, 'test-suite');
  // and one written before backends could drop
  pluginRegistry().registerStorageBackend({
    id: 'no-drop-store',
    label: 'Store without drop',
    open: (dataDir) => openPglite(dataDir, { path: '.knode/no-drop-db' }),
  }, 'test-suite');
});

function configWith(database: Partial<KnodeConfig['database']>): KnodeConfig {
  const config = defaultConfig();
  config.database = { ...config.database, ...database };
  return config;
}

const scope = resolveWorkspaceScope({ user: 'alice', kind: 'personal', id: 'default', name: 'Default' });

describe('clearing a workspace', () => {
  it('drops an index the workspace keeps outside its directory', async () => {
    const external = path.join(tmp, 'outside-index');
    const registry = new WorkspaceContextRegistry(path.join(tmp, 'outside'), { templateConfig: configWith({ kind: 'pglite', path: external }) });
    try {
      const ctx = await registry.get(scope);
      await ctx.store.setMeta('probe', { stale: true });
      expect(fs.existsSync(external)).toBe(true);

      await registry.reset(scope);
      const fresh = await registry.get(scope);
      expect(await fresh.store.getMeta('probe')).toBeUndefined();
    } finally {
      await registry.closeAll();
    }
  });

  it("drops through a plugin backend's drop, whether or not the workspace is open", async () => {
    const root = path.join(tmp, 'side');
    const registry = new WorkspaceContextRegistry(root, { templateConfig: configWith({ kind: 'side-store' }) });
    try {
      const ctx = await registry.get(scope);
      await ctx.store.setMeta('probe', { stale: true });
      dropped.length = 0;
      await registry.reset(scope);
      expect(dropped).toEqual([ctx.dataDir]);
      expect(await (await registry.get(scope)).store.getMeta('probe')).toBeUndefined();

      // not open, and its config unreadable: the clear still goes through the
      // backend the workspace was made with
      await registry.closeAll();
      fs.writeFileSync(path.join(ctx.dataDir, 'knode.config.json'), '{ not json');
      dropped.length = 0;
      await registry.reset(scope);
      expect(dropped).toEqual([ctx.dataDir]);
      expect(JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'knode.config.json'), 'utf8')).database.kind).toBe('side-store');
    } finally {
      await registry.closeAll();
    }
  });

  it('refuses on a backend that cannot drop, and leaves the workspace as it was', async () => {
    const registry = new WorkspaceContextRegistry(path.join(tmp, 'no-drop'), { templateConfig: configWith({ kind: 'no-drop-store' }) });
    try {
      const ctx = await registry.get(scope);
      const note = path.join(ctx.dataDir, 'wiki', 'keep.md');
      fs.writeFileSync(note, '# keep\n');
      await expect(registry.reset(scope)).rejects.toThrow(/storage backend "no-drop-store" \(database.kind\) cannot drop/);
      expect(fs.existsSync(note)).toBe(true);
      // nothing was closed: the same context still answers
      expect(await registry.get(scope)).toBe(ctx);
      expect(await ctx.store.query<{ one: number }>('SELECT 1 AS one')).toEqual([{ one: 1 }]);
    } finally {
      await registry.closeAll();
    }
  });
});

describe('rebuild', () => {
  it("starts from an empty index dropped through the backend's drop", async () => {
    const dir = path.join(tmp, 'rebuild-side');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'knode.config.json'), JSON.stringify({ database: { kind: 'side-store' } }));
    const ctx = await createContext(dir);
    try {
      await ctx.store.setMeta('probe', { stale: true });
      dropped.length = 0;
      await rebuild(ctx);
      expect(dropped).toEqual([dir]);
      expect(await ctx.store.getMeta('probe')).toBeUndefined();
    } finally {
      await ctx.store.close();
    }
  });

  it('refuses on a backend that cannot drop, with the store left open', async () => {
    const dir = path.join(tmp, 'rebuild-no-drop');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'knode.config.json'), JSON.stringify({ database: { kind: 'no-drop-store' } }));
    const ctx = await createContext(dir);
    try {
      await ctx.store.setMeta('probe', { kept: true });
      await expect(rebuild(ctx)).rejects.toThrow(/cannot drop a workspace's index/);
      expect(await ctx.store.getMeta('probe')).toEqual({ kept: true });
    } finally {
      await ctx.store.close();
    }
  });
});

describe('dropBackend', () => {
  it('removes the embedded database where database.path puts it, and is a no-op where there is none', async () => {
    const dir = path.join(tmp, 'pglite-path');
    fs.mkdirSync(path.join(dir, '.knode'), { recursive: true });
    const db = await openPglite(dir, { path: '.knode/elsewhere' });
    await db.close();
    expect(fs.existsSync(path.join(dir, '.knode/elsewhere'))).toBe(true);
    await dropBackend(dir, configWith({ kind: 'pglite', path: '.knode/elsewhere' }).database);
    expect(fs.existsSync(path.join(dir, '.knode/elsewhere'))).toBe(false);
    await dropBackend(dir, configWith({ kind: 'pglite', path: '.knode/elsewhere' }).database);
  });

  it('names the kinds there are for an unknown kind', async () => {
    await expect(dropBackend(tmp, configWith({ kind: 'mystery' }).database)).rejects.toThrow(/unknown database.kind "mystery" \(registered: pglite, postgres, side-store, no-drop-store\)/);
  });
});
