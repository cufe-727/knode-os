import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { dropPglite, openPglite, pgliteDir, pgliteLockPath, pgliteOpenInProcess } from '../src/store/backend.js';
import { Store } from '../src/store/db.js';
import { resolveWorkspaceScope, WorkspaceContextRegistry, workspaceDataDir } from '../src/server/workspaces.js';

/**
 * Embedded PGlite takes no lock on its directory: two instances on one
 * directory run as independent single-user Postgres over the same files, and
 * after writes one of them waits forever inside WASM (docs/design/31, F2). The
 * backend refuses the second open instead — in this process by a registry, in
 * another by a lock file beside the database.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-pglite-guard-'));
let n = 0;
const workspace = (): string => {
  const dir = path.join(tmp, `ws-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A child process that opens the workspace's index through the backend, says "ready", and holds it until killed. */
async function holdInChild(dataDir: string): Promise<ChildProcess> {
  const script = path.join(tmp, `hold-${++n}.mts`);
  fs.writeFileSync(
    script,
    `import { openPglite } from ${JSON.stringify(path.join(repo, 'src/store/backend.ts'))};\n` +
      `const db = await openPglite(process.argv[2]);\n` +
      `await db.query('SELECT 1');\n` +
      `process.stdout.write('ready\\n');\n` +
      `setInterval(() => {}, 1 << 30);\n`,
  );
  const child = spawn(process.execPath, ['--import', 'tsx', script, dataDir], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let err = '';
  child.stderr!.on('data', (d) => (err += d));
  await new Promise<void>((resolve, reject) => {
    let out = '';
    child.stdout!.on('data', (d) => {
      out += d;
      if (out.includes('ready')) resolve();
    });
    child.once('exit', (code) => reject(new Error(`holder exited (${code}): ${err}`)));
  });
  return child;
}

const exited = (child: ChildProcess): Promise<void> =>
  child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((r) => child.once('exit', () => r()));

/** A pid no process has now: a child that has already exited. */
function deadPid(): number {
  const res = spawnSync(process.execPath, ['-e', '']);
  return res.pid!;
}

function writeLock(dataDir: string, holder: Record<string, unknown>): string {
  const lock = pgliteLockPath(dataDir);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ thread: 0, command: 'knode-os serve', token: 'old', dir: lock.slice(0, -'.lock'.length), ...holder }) + '\n');
  return lock;
}

describe('one open per embedded PGlite database', () => {
  it('refuses a second open in this process, and the first keeps working', async () => {
    const ws = workspace();
    const db = await openPglite(ws);
    try {
      await db.exec('CREATE TABLE t (x int); INSERT INTO t VALUES (1)');
      await expect(openPglite(ws)).rejects.toThrow(/already open in this process/);
      // another spelling of the same directory is the same directory
      await expect(openPglite(path.join(ws, '.', 'sub', '..'))).rejects.toThrow(/already open in this process/);
      const link = path.join(tmp, `link-${n}`);
      fs.symlinkSync(ws, link);
      await expect(openPglite(link)).rejects.toThrow(/already open in this process/);
      expect((await db.query<{ x: number }>('SELECT x FROM t')).rows).toEqual([{ x: 1 }]);
      expect(fs.existsSync(pgliteLockPath(ws))).toBe(true);
      // the lock sits beside the database, not among PGlite's files
      expect(path.dirname(pgliteLockPath(ws))).toBe(path.dirname(fs.realpathSync(pgliteDir(ws))));
    } finally {
      await db.close();
    }
    expect(pgliteOpenInProcess(ws)).toBe(false);
    expect(fs.existsSync(pgliteLockPath(ws))).toBe(false);
  });

  it('opens again after close, with the data written before', async () => {
    const ws = workspace();
    const first = await openPglite(ws);
    await first.exec('CREATE TABLE t (x int); INSERT INTO t VALUES (7)');
    await first.close();
    const second = await openPglite(ws);
    expect((await second.query<{ x: number }>('SELECT x FROM t')).rows).toEqual([{ x: 7 }]);
    await second.close();
  });

  it('two opens started together: one wins, the other is refused', async () => {
    const ws = workspace();
    const results = await Promise.allSettled([openPglite(ws), openPglite(ws), openPglite(ws)]);
    const opened = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof openPglite>>> => r.status === 'fulfilled');
    expect(opened).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(String(r.reason)).toMatch(/already open in this process/);
    await opened[0].value.close();
  });

  it('releases the directory when close fails part-way', async () => {
    const ws = workspace();
    // spied before the open, which binds the instance's close; armed after it (PGlite.create calls close on its own way up)
    const spy = vi.spyOn(PGlite.prototype, 'close');
    const db = await openPglite(ws);
    spy.mockRejectedValueOnce(new Error('close broke'));
    try {
      await expect(db.close()).rejects.toThrow('close broke');
    } finally {
      spy.mockRestore();
    }
    expect(pgliteOpenInProcess(ws)).toBe(false);
    expect(fs.existsSync(pgliteLockPath(ws))).toBe(false);
    // the instance itself is still up: close it for real
    await PGlite.prototype.close.call(db as unknown as PGlite);
  });

  it('does not leave the directory marked open when the open fails', async () => {
    const ws = workspace();
    const spy = vi.spyOn(PGlite, 'create').mockRejectedValueOnce(new Error('create broke'));
    try {
      await expect(openPglite(ws)).rejects.toThrow('create broke');
    } finally {
      spy.mockRestore();
    }
    expect(pgliteOpenInProcess(ws)).toBe(false);
    expect(fs.existsSync(pgliteLockPath(ws))).toBe(false);
    const db = await openPglite(ws);
    await db.close();
  });

  it('a store whose open fails after the backend opened hands the backend back', async () => {
    const ws = workspace();
    const spy = vi.spyOn(Store.prototype, 'setMeta').mockRejectedValueOnce(new Error('meta broke'));
    try {
      await expect(Store.open(ws, 8)).rejects.toThrow('meta broke');
    } finally {
      spy.mockRestore();
    }
    expect(pgliteOpenInProcess(ws)).toBe(false);
    const store = await Store.open(ws, 8);
    await store.close();
  });

  it('reclaims a lock whose process is gone', async () => {
    const ws = workspace();
    const lock = writeLock(ws, { pid: deadPid(), at: Date.now() - 60_000, started: Date.now() - 120_000 });
    const db = await openPglite(ws);
    const held = JSON.parse(fs.readFileSync(lock, 'utf8'));
    expect(held.pid).toBe(process.pid);
    await db.close();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('reclaims an unreadable lock, a lock of a reused pid, and one copied from elsewhere', async () => {
    const ws = workspace();
    const lock = pgliteLockPath(ws);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, 'not json');
    await (await openPglite(ws)).close();

    // a live pid whose process started after the lock was taken is not the holder
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    children.push(sleeper);
    await new Promise((r) => setTimeout(r, 200));
    writeLock(ws, { pid: sleeper.pid, at: Date.now() - 10 * 60_000 });
    await (await openPglite(ws)).close();

    // copied along with a workspace: it names another directory
    writeLock(ws, { pid: sleeper.pid, dir: path.join(tmp, 'elsewhere', '.knode', 'db'), at: Date.now() + 60_000 });
    await (await openPglite(ws)).close();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('refuses while another live process holds the lock, naming it; reclaims it once that process is killed', async () => {
    const ws = workspace();
    const child = await holdInChild(ws);
    const lock = pgliteLockPath(ws);
    const err = await openPglite(ws).then(
      () => null,
      (e: unknown) => e as Error & { code?: string; holder?: { pid: number } },
    );
    expect(err).not.toBeNull();
    expect(err!.message).toContain(`process ${child.pid}`);
    expect(err!.message).toContain('hold-');
    expect(err!.code).toBe('KNODE_PGLITE_OPEN');
    expect(err!.holder?.pid).toBe(child.pid);
    expect(pgliteOpenInProcess(ws)).toBe(false);
    await expect(dropPglite(ws)).rejects.toThrow(new RegExp(`process ${child.pid}`));
    expect(fs.existsSync(pgliteDir(ws))).toBe(true);

    // SIGKILL runs no exit handler: the lock stays, and the next open reclaims it because the pid is gone
    child.kill('SIGKILL');
    await exited(child);
    expect(fs.existsSync(lock)).toBe(true);
    const db = await openPglite(ws);
    expect(JSON.parse(fs.readFileSync(lock, 'utf8')).pid).toBe(process.pid);
    await db.close();
  });

  it('dropPglite refuses while the database is open here, and drops it once closed', async () => {
    const ws = workspace();
    const db = await openPglite(ws);
    await db.exec('CREATE TABLE t (x int)');
    await expect(dropPglite(ws)).rejects.toThrow(/open in this process/);
    expect((await db.query('SELECT * FROM t')).rows).toEqual([]);
    await db.close();
    await dropPglite(ws);
    expect(fs.existsSync(pgliteDir(ws))).toBe(false);
    expect(fs.existsSync(pgliteLockPath(ws))).toBe(false);
  });

  it('a workspace reopened while its context is still closing waits for the close', async () => {
    const root = workspace();
    const registry = new WorkspaceContextRegistry(root);
    const scope = resolveWorkspaceScope({ user: 'tester', kind: 'personal', id: 'default', name: 'Default' });
    await registry.get(scope);
    const closing = registry.closeAll();
    const reopened = registry.get(scope);
    await closing;
    const ctx = await reopened;
    expect(pgliteOpenInProcess(workspaceDataDir(root, scope))).toBe(true);
    await registry.closeAll();
    expect(pgliteOpenInProcess(ctx.dataDir)).toBe(false);
  });
});
