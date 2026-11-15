import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveWorkspaceScope, WorkspaceContextRegistry } from '../src/server/workspaces.js';
import { Store } from '../src/store/db.js';

/**
 * Nothing runs on an index that is closing or closed.
 *
 * Embedded PGlite closes under a statement still queued on it and runs the
 * statement afterwards. When serve's open asked the store a question without
 * waiting for the answer (which way its vector index is walked, for a log
 * line), a workspace closed and reopened at once had the old instance still
 * answering on a directory the new one had opened, and the new one's close
 * never returned: a loop inside the database, at full CPU, which no test
 * timeout can interrupt. tests/pglite-open-guard.test.ts ("a workspace
 * reopened while its context is still closing waits for the close") is that
 * sequence; these tests hold the two things that prevent it. Against the
 * sources of 7d10366, where the open did not wait: "has asked its questions
 * of the store by the time the open returns" fails (the line is not in the
 * log yet), and the first and the last test here do not return, as that
 * suite did not — so run them with a limit when bisecting.
 */

const dirs: string[] = [];
const scratch = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-store-close-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('closing a store', () => {
  it('waits for a statement its caller did not wait for, and takes none after', async () => {
    const dir = scratch();
    fs.mkdirSync(path.join(dir, '.knode'), { recursive: true });
    const store = await Store.open(dir, 4);
    await store.indexing;
    const order: string[] = [];
    // sent, and not waited for: what a log line, a counter or a cache refresh does
    const strays = [
      store.query(`SELECT count(*) FROM documents`).then(() => order.push('query answered')),
      store.tx(async (q) => q.query(`SELECT 1`)).then(() => order.push('transaction answered')),
    ];
    await store.close();
    order.push('closed');
    await Promise.all(strays);
    // the close returned once both had been answered: neither ran on a closed index
    expect(order).toEqual(['query answered', 'transaction answered', 'closed']);
    // and nothing is taken afterwards
    await expect(store.query(`SELECT 1`)).rejects.toThrow(/this index is closed/);
    await expect(store.tx(async (q) => q.query(`SELECT 1`))).rejects.toThrow(/this index is closed/);
    await expect(store.exec(`SELECT 1`)).rejects.toThrow(/this index is closed/);
  });

  it('closes when a statement it waited for failed', async () => {
    const dir = scratch();
    fs.mkdirSync(path.join(dir, '.knode'), { recursive: true });
    const store = await Store.open(dir, 4);
    const failed = store.query(`SELECT * FROM no_such_table`).then(() => 'answered', () => 'failed');
    await store.close();
    expect(await failed).toBe('failed');
  });
});

describe('opening a workspace in serve', () => {
  it('has asked its questions of the store by the time the open returns', async () => {
    const lines: string[] = [];
    const registry = new WorkspaceContextRegistry(scratch(), { log: (line) => lines.push(line) });
    const scope = resolveWorkspaceScope({ user: 'tester', kind: 'personal', id: 'default', name: 'Default' });
    try {
      await registry.get(scope);
      // the line about the vector index is in the log: the statement behind it was waited for, not left
      // in flight for a close that may follow at once
      expect(lines.filter((line) => line.includes('vector search:'))).toHaveLength(1);
    } finally {
      // let anything still on its way arrive before the close, so a failure here is a failure and not a hang
      await new Promise((resolve) => setTimeout(resolve, 500));
      await registry.closeAll();
    }
  });

  it('opens, closes and reopens at once, and closes again', async () => {
    const lines: string[] = [];
    const registry = new WorkspaceContextRegistry(scratch(), { log: (line) => lines.push(line) });
    const scope = resolveWorkspaceScope({ user: 'tester', kind: 'personal', id: 'default', name: 'Default' });
    await registry.get(scope);
    const closing = registry.closeAll();
    const reopened = registry.get(scope);
    await closing;
    const ctx = await reopened;
    expect((await ctx.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM documents`))[0].n).toBe(0);
    await registry.closeAll();
    // one line an open, each written before its open returned
    expect(lines.filter((line) => line.includes('vector search:'))).toHaveLength(2);
    await expect(ctx.store.query(`SELECT 1`)).rejects.toThrow(/this index is closed/);
  });
});
