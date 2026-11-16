import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { dropQueuedRun, OwnQueue, RemoteEval, RunCancelledError, scopeOf, ServeQueue, ServeRefusedError } from '../src/eval/remote.js';
import { MCP_TOKEN_FILE } from '../src/server/mcp-http.js';
import type { WorkerIdentity } from '../src/labeling/scheduler.js';
import { mountEvalProducer } from '../src/remote/eval-producer.js';
import type { WorkTask } from '../src/work/broker.js';
import { dropStoredRun, EvalStoreFullError, EvalTaskStore } from '../src/work/eval-store.js';
import { EvalWork } from '../src/work/eval.js';
import type { EvalCallSpec, EvalOutcome, EvalSessionSpec, EvalWorkOptions } from '../src/work/eval.js';

/**
 * docs/design/32 stage 2: `serve` keeps an evaluation run's tasks and their
 * results in the root data folder. These tests restart the real objects — the
 * store, the sources, the producer channel on its port — and drive them with
 * a worker that leases through the sources as `/remote/v1` does.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-work-queue-durable-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(20);
  }
}
let roots = 0;
const newRoot = () => fs.mkdtempSync(path.join(tmp, `root-${++roots}-`));

const agent = { family: 'codex' as const, model: 'gpt-test', effort: null, speed: null };
const call = (run: string, key: string, over: Partial<EvalCallSpec> = {}): EvalCallSpec => ({
  kind: 'eval-call', run, key, eligible: 'any', pool: null, label: `piece ${key}`, agent, prompt: `prompt of ${key}`, schema: null, timeoutMs: 60_000, ...over,
});
const worker = (name = 'w1'): WorkerIdentity => ({ worker: `laptop/${name}/eval-codex#1`, backend: 'codex', remote: true, pool: 'laptop' });

/** A worker: every task it leases, it answers `done: <prompt>`; it counts what it did by key. */
function startWorker(work: () => EvalWork | null, opts: { name?: string; hold?: (task: WorkTask) => boolean } = {}) {
  const done = new Map<string, number>();
  const held: { task: WorkTask; from: EvalWork }[] = [];
  const who = worker(opts.name);
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const w = work();
      const task = w ? (await w.calls.lease(who))[0] ?? (await w.sessions.lease(who))[0] : undefined;
      if (!w || !task) {
        await sleep(15);
        continue;
      }
      if (opts.hold?.(task)) {
        held.push({ task, from: w });
        continue;
      }
      const source = w.sources.find((s) => s.holds(task.id))!;
      const r = await source.complete(task.id, who, { ok: true, text: `done: ${'prompt' in task ? task.prompt : ''}` });
      if (r.accepted) done.set((task as { key: string }).key, (done.get((task as { key: string }).key) ?? 0) + 1);
    }
  })();
  return {
    done, held, who,
    /** Answer a held task now, through whichever serve is up. */
    async answer(i: number, through: EvalWork) {
      const { task } = held[i];
      const source = through.sources.find((s) => s.holds(task.id));
      if (!source) return { accepted: false, reason: 'unknown or expired lease' };
      const r = await source.complete(task.id, who, { ok: true, text: `done: ${'prompt' in task ? task.prompt : ''}` });
      if (r.accepted) done.set((task as { key: string }).key, (done.get((task as { key: string }).key) ?? 0) + 1);
      return r;
    },
    async stop() {
      stopped = true;
      await loop;
    },
  };
}

const TOKEN = 'producer-token-0123456789';

/** `serve` as far as evaluation goes: the store and sources in a data root, the producer channel on a port. */
async function startServe(root: string, opts: { port?: number; work?: EvalWorkOptions } = {}) {
  const work = new EvalWork(root, { retryMs: 0, onlineMs: 1_500, ...opts.work });
  const hits: Record<string, number> = {};
  const app = new Hono();
  app.use('*', async (c, next) => {
    const route = c.req.path.replace(/^\/eval\/v1\//, '').replace(/\/[^/]*\/(cancel|detach)$/, '/$1');
    hits[route] = (hits[route] ?? 0) + 1;
    await next();
  });
  const config = defaultConfig();
  config.server.remote = { enabled: true, offer: { eval: true } };
  mountEvalProducer(app, { work, token: TOKEN, config: () => config });
  const server = serve({ fetch: app.fetch, port: opts.port ?? 0, hostname: '127.0.0.1' }) as unknown as http.Server;
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once('listening', () => resolve())));
  const port = (server.address() as AddressInfo).port;
  return {
    work, hits, port, url: `http://127.0.0.1:${port}`,
    /** `serve` stops: its listener and its open requests, its sources, its hold on the store. */
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      });
      work.close();
    },
  };
}

const connect = (url: string, run: string, over: Record<string, unknown> = {}) => RemoteEval.connect({ serveUrl: url, token: TOKEN, run, scope: path.join(tmp, 'runs', run), refreshMs: 100, backoffMs: 30, waitMinutes: 0, ...over });
const publishCall = (remote: RemoteEval, prompt: string) => remote.publish({ kind: 'eval-call', eligible: 'any', label: 'answer', agent, prompt, schema: null, timeoutMs: 60_000 }, async () => 'here', { system: 'closed-book', task: prompt });
const textOf = (p: Awaited<ReturnType<typeof publishCall>>) => (p.local ? `local: ${'value' in p ? p.value : p.error}` : p.outcome.outcome === 'answered' ? p.outcome.text : `error: ${p.outcome.error}`);

describe('the store in the root data folder', () => {
  it('keeps a published task across a restart, waiting again whatever lease it had, and refuses the old lease\'s late answer', async () => {
    const root = newRoot();
    const a = new EvalWork(root, { retryMs: 0 });
    a.publish([call('r1', 'piece-0001')]);
    const [task] = await a.calls.lease(worker());
    expect(task).toBeDefined();
    expect((await a.calls.status()).leases).toHaveLength(1);
    a.close();

    const b = new EvalWork(root, { retryMs: 0 });
    expect((await b.calls.status()).waiting).toBe(1);
    expect(b.collect('r1', ['piece-0001'])).toMatchObject({ waiting: ['piece-0001'] });
    // the answer from the lease serve handed out before it stopped
    expect(await b.calls.complete(task.id, worker(), { ok: true, text: 'late' })).toEqual({ accepted: false, reason: 'unknown or expired lease' });
    const [again] = await b.calls.lease(worker());
    expect(again.id).not.toBe(task.id);
    expect((await b.calls.complete(again.id, worker(), { ok: true, text: 'answer' })).accepted).toBe(true);
    b.close();

    // the result outlives the next restart too, and comes back each time it is collected
    const c = new EvalWork(root, { retryMs: 0 });
    for (let i = 0; i < 2; i++) {
      const found = c.collect('r1', ['piece-0001']);
      expect(found.done).toHaveLength(1);
      expect(found.done[0].outcome).toMatchObject({ outcome: 'answered', text: 'answer', worker: 'laptop/w1/eval-codex#1' });
    }
    expect((await c.calls.lease(worker()))).toEqual([]);
    c.close();
  });

  it('returns the task that exists, or its stored result, when a key is published again — never a second task', async () => {
    const root = newRoot();
    const w = new EvalWork(root, { retryMs: 0 });
    const first = w.calls.publish(call('r2', 'piece-0002'));
    const second = w.calls.publish(call('r2', 'piece-0002', { prompt: 'prompt of piece-0002' }));
    expect(second).toEqual({ id: first.id, state: 'waiting' });
    expect((await w.calls.status()).waiting).toBe(1);
    const [task] = await w.calls.lease(worker());
    expect(w.calls.publish(call('r2', 'piece-0002'))).toEqual({ id: first.id, state: 'leased' });
    await w.calls.complete(task.id, worker(), { ok: true, text: 'once' });
    const third = w.calls.publish(call('r2', 'piece-0002'));
    expect(third.state).toBe('done');
    expect(third.outcome).toMatchObject({ outcome: 'answered', text: 'once' });
    expect((await w.calls.status()).waiting).toBe(0);
    expect(await w.calls.lease(worker())).toEqual([]);
    w.close();
  });

  it('never hands a result one of the run\'s own slots made to another process: published again, it waits again', async () => {
    const root = newRoot();
    const w = new EvalWork(root, { retryMs: 0 });
    w.publish([call('r3', 'piece-0003', { eligible: 'local' })]);
    const own: WorkerIdentity = { worker: 'local/r3/eval-codex#1', backend: 'codex', remote: false, run: 'r3', pool: 'local' };
    const [task] = await w.calls.lease(own);
    await w.calls.complete(task.id, own, { ok: true, text: '' });
    // the producer that ran it learns it is done, by its own slot
    expect(w.collect('r3', ['piece-0003']).done[0].outcome).toMatchObject({ outcome: 'answered', local: true });
    // another process of the run (a resume) has no value for it: it waits for a slot again
    expect(w.calls.publish(call('r3', 'piece-0003', { eligible: 'local' })).state).toBe('waiting');
    w.close();
  });

  it('drops a task still waiting at its deadline, never leasing it', async () => {
    const root = newRoot();
    const w = new EvalWork(root, { retryMs: 0 });
    w.publish([call('r4', 'piece-0004')], { deadline: Date.now() + 150 });
    await sleep(800);
    expect(await w.calls.lease(worker())).toEqual([]);
    expect(w.collect('r4', ['piece-0004']).done).toEqual([{ key: 'piece-0004', outcome: { outcome: 'cancelled' } }]);
    expect(w.store.get('r4', 'piece-0004')).toMatchObject({ state: 'dropped', why: 'its deadline passed' });
    // a producer that asks after a task keeps it wanted past the deadline it was published with
    w.publish([call('r4', 'piece-0005')], { deadline: Date.now() + 1_000 });
    for (let i = 0; i < 6; i++) {
      await sleep(300);
      w.collect('r4', ['piece-0005']);
    }
    expect(w.collect('r4', ['piece-0005']).waiting).toEqual(['piece-0005']);
    w.close();
  });

  it('prunes results by age: one nobody collected after seven days, one collected after a day', async () => {
    const root = newRoot();
    const w = new EvalWork(root, { retryMs: 0 });
    w.publish([call('r5', 'piece-0006'), call('r5', 'piece-0007'), call('r5', 'piece-0008')]);
    for (let i = 0; i < 2; i++) {
      const [t] = await w.calls.lease(worker());
      await w.calls.complete(t.id, worker(), { ok: true, text: 'x' });
    }
    const done = w.store.ofRun('r5').filter((t) => t.state === 'done').map((t) => t.key);
    w.collect('r5', [done[0]]);
    const day = 24 * 3_600_000;
    expect(w.prune(Date.now() + 2 * day)).toBe(1);
    expect(w.store.get('r5', done[0])).toBeUndefined();
    expect(w.store.get('r5', done[1])).toBeDefined();
    expect(w.prune(Date.now() + 8 * day)).toBe(1);
    // a waiting task is its deadline's, not its age's
    expect(w.store.ofRun('r5').map((t) => t.state)).toEqual(['waiting']);
    expect(fs.readdirSync(path.join(EvalTaskStore.dirOf(root), 'r5')).filter((f) => f.endsWith('.result.json'))).toEqual([]);
    w.close();
  });

  it('refuses a publish past its bound with a clear error, after dropping results already collected', async () => {
    const root = newRoot();
    const w = new EvalWork(root, { retryMs: 0, durable: { maxBytes: 4_500 } });
    const big = 'x'.repeat(1_500);
    w.publish([call('r6', 'piece-0009', { prompt: big }), call('r6', 'piece-0010', { prompt: big })]);
    for (let i = 0; i < 2; i++) {
      const [t] = await w.calls.lease(worker());
      await w.calls.complete(t.id, worker(), { ok: true, text: big });
    }
    w.collect('r6', ['piece-0009']);
    // room is made from the collected result; the uncollected one stays
    w.publish([call('r6', 'piece-0011', { prompt: big })]);
    expect(w.store.get('r6', 'piece-0009')).toBeUndefined();
    expect(w.store.get('r6', 'piece-0010')).toBeDefined();
    expect(() => w.publish([call('r6', 'piece-0012', { prompt: big }), call('r6', 'piece-0013', { prompt: big })])).toThrow(EvalStoreFullError);
    expect(() => w.publish([call('r6', 'piece-0014', { prompt: big })])).toThrow(/evaluation queue holds .* its limit \(server\.remote\.evalQueueMB.*knode-os eval drop/);
    // a result of a task out now is stored whatever the bound
    const [t] = await w.calls.lease(worker());
    expect((await w.calls.complete(t.id, worker(), { ok: true, text: big })).accepted).toBe(true);
    expect(w.store.result('r6', (t as { key: string }).key)).toMatchObject({ text: big });
    w.close();
  });

  it('is held by one serve at a time: a second keeps its work in memory and says why, and a dead owner\'s folder is taken over', async () => {
    const root = newRoot();
    const first = new EvalWork(root);
    first.publish([call('r7', 'piece-0015')]);
    const second = new EvalWork(root);
    expect(second.store.durable).toBe(false);
    expect(second.storeStatus().reason).toMatch(/held by process \d+/);
    // the second sees none of the first's tasks and writes none
    expect((await second.calls.status()).waiting).toBe(0);
    second.publish([call('r7', 'piece-0016')]);
    second.close();
    expect(fs.readdirSync(path.join(EvalTaskStore.dirOf(root), 'r7'))).toEqual(['piece-0015.json']);
    first.close();
    // an owner whose process is gone
    fs.writeFileSync(path.join(EvalTaskStore.dirOf(root), 'owner.json'), JSON.stringify({ pid: 2 ** 22 + 12_345, nonce: 'gone', at: '' }));
    const third = new EvalWork(root);
    expect(third.store.durable).toBe(true);
    expect((await third.calls.status()).waiting).toBe(1);
    third.close();
    expect(fs.existsSync(path.join(EvalTaskStore.dirOf(root), 'owner.json'))).toBe(false);
  });

  it('drops a run\'s tasks and results, of its own scope only, with serve up or stopped', async () => {
    const root = newRoot();
    const w = new EvalWork(root, { retryMs: 0 });
    w.publish([call('r8', 'piece-0017')], { scope: 'aaaaaaaaaaaa' });
    w.publish([call('r8', 'piece-0018')], { scope: 'bbbbbbbbbbbb' });
    w.publish([call('r9', 'piece-0019')]);
    expect(w.dropRun('r8', 'aaaaaaaaaaaa')).toBe(1);
    expect(w.store.ofRun('r8').map((t) => t.key)).toEqual(['piece-0018']);
    // its piece is gone from the sources too
    expect((await w.calls.status()).runs.find((r) => r.run === 'r8')?.waiting).toBe(1);
    // with serve up, the store is held: dropping it here is refused and serve is asked instead
    expect(dropStoredRun(root, 'r9')).toBeNull();
    w.close();
    expect(dropStoredRun(root, 'r9')).toBe(1);
    expect(dropStoredRun(root, 'gone')).toBe(0);
    const again = new EvalWork(root);
    expect(again.store.ofRun('r9')).toEqual([]);
    expect(again.store.ofRun('r8')).toHaveLength(1);
    again.close();
  });

  it('when a run goes away, drops only what it alone can serve, and holds a session that calls its tools until it is back', async () => {
    const root = newRoot();
    const w = new EvalWork(root, { retryMs: 0, presentMs: 200 });
    const session = (key: string, mcp: boolean): EvalSessionSpec => ({
      kind: 'eval-session', run: 'r10', key, eligible: 'any', pool: null, label: key, agent, sandbox: 'read-only', maxSteps: 5, timeoutMs: 60_000, prompt: 'p', archive: null,
      mcp: mcp ? { url: 'http://127.0.0.1:9/mcp', secret: 'secret-0123456789abcdef', tools: ['knode_ls'] } : null,
    });
    w.publish([session('tools-0001', true), session('files-0001', false), call('r10', 'local-0001', { eligible: 'local' })]);
    // the run is not attached: its tool session waits, the file session does not
    const leased = await w.sessions.lease(worker());
    expect(leased.map((t) => (t as { key: string }).key)).toEqual(['files-0001']);
    expect(await w.sessions.lease(worker('w2'))).toEqual([]);
    w.attach('r10');
    expect((await w.sessions.lease(worker('w2'))).map((t) => (t as { key: string }).key)).toEqual(['tools-0001']);
    expect(w.detachRun('r10')).toBe(2);
    expect(w.store.ofRun('r10').map((t) => [t.key, t.state]).sort()).toEqual([['files-0001', 'waiting'], ['local-0001', 'dropped'], ['tools-0001', 'dropped']]);
    // the file session's worker still finishes it, for the run's resume
    expect((await w.sessions.complete(leased[0].id, worker(), { ok: true, text: 'kept', session: { exitCode: 0, output: '', stderr: '', lastMessage: 'kept' } })).accepted).toBe(true);
    expect(w.store.get('r10', 'files-0001')?.state).toBe('done');
    w.close();
  });

  it('keeps an archive a waiting task needs however old it is', async () => {
    const root = newRoot();
    const w = new EvalWork(root, { retryMs: 0 });
    const dir = path.join(root, '.knode', 'eval-archives');
    fs.mkdirSync(dir, { recursive: true });
    const sha = 'a'.repeat(64);
    const old = new Date(Date.now() - 3 * 24 * 3_600_000);
    for (const s of [sha, 'b'.repeat(64)]) {
      fs.writeFileSync(path.join(dir, `${s}.kpa`), 'x');
      fs.utimesSync(path.join(dir, `${s}.kpa`), old, old);
    }
    w.publish([{ kind: 'eval-session', run: 'r11', key: 'files-0002', eligible: 'any', pool: null, label: 'x', agent, sandbox: 'read-only', maxSteps: 5, timeoutMs: 60_000, prompt: 'p', archive: { sha256: sha, bytes: 1 }, mcp: null }]);
    w.prune();
    expect(fs.readdirSync(dir)).toEqual([`${sha}.kpa`]);
    w.close();
  });
});

describe('a run against serve\'s durable queue', () => {
  it('publishes in batches and collects with a poll, never one held request a piece', async () => {
    const s = await startServe(newRoot());
    const w = startWorker(() => s.work);
    const remote = (await connect(s.url, 'batches'))!;
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => publishCall(remote, `q${i}`)));
    expect(results.map(textOf)).toEqual(Array.from({ length: 40 }, (_, i) => `done: q${i}`));
    expect(s.hits.offer ?? 0).toBe(0);
    expect(s.hits.tasks).toBeLessThanOrEqual(4);
    expect([...w.done.values()].every((n) => n === 1)).toBe(true);
    expect(w.done.size).toBe(40);
    remote.close();
    await w.stop();
    await s.close();
  });

  it('carries on across a restart of serve while it waits, each piece done once, and the old lease\'s answer refused', async () => {
    const root = newRoot();
    let s = await startServe(root);
    const port = s.port;
    let up: EvalWork | null = s.work;
    const lines: string[] = [];
    const remote = (await connect(s.url, 'restart', { log: (m: string) => lines.push(m) }))!;
    // the worker holds the first piece it gets, as one would while serve stops
    let holdOne = true;
    const w = startWorker(() => up, { hold: () => (holdOne ? ((holdOne = false), true) : false) });
    const pieces = Array.from({ length: 6 }, (_, i) => publishCall(remote, `r${i}`));
    await until(() => w.held.length === 1 && w.done.size >= 2);
    // serve stops while pieces wait, and starts again on the same port and data root
    up = null;
    await s.close();
    await sleep(300);
    s = await startServe(root, { port });
    expect((await w.answer(0, s.work)).accepted).toBe(false);
    up = s.work;
    const results = await Promise.all(pieces);
    expect(results.map(textOf)).toEqual(Array.from({ length: 6 }, (_, i) => `done: r${i}`));
    expect(w.done.size).toBe(6);
    expect([...w.done.values()].every((n) => n === 1)).toBe(true);
    expect(lines.some((l) => /serve is not answering/.test(l))).toBe(true);
    remote.close();
    await w.stop();
    await s.close();
  });

  it('exits and resumes without losing or repeating work in flight: what a worker finished meanwhile is collected, not asked again', async () => {
    const s = await startServe(newRoot());
    const w = startWorker(() => s.work, { hold: (t) => ['x0', 'x1'].includes((t as { prompt?: string }).prompt ?? '') });
    const a = (await connect(s.url, 'resume'))!;
    const first = ['x0', 'x1', 'x2', 'x3'].map((q) => publishCall(a, q).catch((e) => e));
    await until(() => w.held.length === 2 && w.done.size === 2);
    // the run stops (a signal, its wait limit): the pieces out with the worker stay in serve
    await a.cancel();
    expect((await Promise.all(first)).slice(0, 2).every((e) => e instanceof RunCancelledError)).toBe(true);
    for (let i = 0; i < 2; i++) expect((await w.answer(i, s.work)).accepted).toBe(true);
    // the resume asks what its records lack — here all four — and every one comes back from the store
    const b = (await connect(s.url, 'resume'))!;
    const results = await Promise.all(['x0', 'x1', 'x2', 'x3'].map((q) => publishCall(b, q)));
    expect(results.map(textOf)).toEqual(['done: x0', 'done: x1', 'done: x2', 'done: x3']);
    expect(w.done.size).toBe(4);
    expect([...w.done.values()].every((n) => n === 1)).toBe(true);
    b.close();
    await w.stop();
    await s.close();
  });

  it('keeps the run\'s own slots working against it, their results never handed to another process of the run', async () => {
    const s = await startServe(newRoot());
    const a = (await connect(s.url, 'own'))!;
    a.startLocal({ codex: 2 });
    let runs = 0;
    const own = (remote: RemoteEval, q: string) => remote.publish({ kind: 'eval-call', eligible: 'local', label: 'answer', agent, prompt: '', schema: null, timeoutMs: 60_000 }, async () => `${++runs}: ${q}`, { system: 'closed-book', task: q }, [q]);
    expect(await Promise.all(['l0', 'l1', 'l2'].map((q) => own(a, q)))).toEqual([
      { local: true, value: expect.stringMatching(/: l0$/) }, { local: true, value: expect.stringMatching(/: l1$/) }, { local: true, value: expect.stringMatching(/: l2$/) },
    ]);
    expect(runs).toBe(3);
    a.close();
    await a.drained();
    // another process of the run has no value for them: its own slots run them again
    const b = (await connect(s.url, 'own'))!;
    b.startLocal({ codex: 1 });
    expect(await own(b, 'l0')).toEqual({ local: true, value: '4: l0' });
    b.close();
    await b.drained();
    await s.close();
  });

  it('serves two producers: two runs apart, and one key published by two clients as one task', async () => {
    const s = await startServe(newRoot());
    const w = startWorker(() => s.work);
    const r1 = (await connect(s.url, 'two-a'))!;
    const r2 = (await connect(s.url, 'two-b'))!;
    const [a, b] = await Promise.all([Promise.all(['p0', 'p1'].map((q) => publishCall(r1, q))), Promise.all(['p0', 'p1'].map((q) => publishCall(r2, q)))]);
    expect(a.map(textOf)).toEqual(['done: p0', 'done: p1']);
    expect(b.map(textOf)).toEqual(['done: p0', 'done: p1']);
    // the same prompt in two runs is two pieces: a run never gets another's result
    expect(w.done.size).toBe(4);
    r1.close();
    r2.close();
    await w.stop();
    // two clients of one run publish the same key: one task, both get its result
    const q1 = new ServeQueue(s.url, TOKEN);
    const q2 = new ServeQueue(s.url, TOKEN);
    await q1.status('same', true);
    await q2.status('same', true);
    const ac = new AbortController();
    const spec = call('same', 'shared-0001');
    const both = Promise.all([q1.publish(spec, ac.signal), q2.publish(spec, ac.signal)]);
    await until(() => s.work.calls.live('same', 'shared-0001') === 'waiting');
    await sleep(100);
    expect((await s.work.calls.status()).runs.find((r) => r.run === 'same')).toMatchObject({ waiting: 1 });
    const w2 = startWorker(() => s.work);
    const outcomes = await both;
    expect(outcomes.map((o) => (o as EvalOutcome & { text?: string }).text)).toEqual(['done: prompt of shared-0001', 'done: prompt of shared-0001']);
    expect(w2.done.get('shared-0001')).toBe(1);
    q1.close();
    q2.close();
    await w2.stop();
    await s.close();
  });

  it('stops plainly with serve\'s word when its queue is full', async () => {
    const s = await startServe(newRoot(), { work: { durable: { maxBytes: 500 } } });
    const remote = (await connect(s.url, 'full'))!;
    const err = await Promise.race([publishCall(remote, 'y'.repeat(2_000)).catch((e) => e), sleep(5_000).then(() => 'still publishing')]);
    expect(err).toBeInstanceOf(ServeRefusedError);
    expect(String(err.message)).toMatch(/serve refused .*507.*its limit \(server\.remote\.evalQueueMB/);
    remote.close();
    await s.close();
  });

  it('says in status where it keeps tasks, and drops a run\'s tasks on DELETE', async () => {
    const root = newRoot();
    const s = await startServe(root);
    const headers = { authorization: `Bearer ${TOKEN}` };
    const status = await (await fetch(`${s.url}/eval/v1/status`, { headers })).json() as { tasks: { version: number; durable: boolean } };
    expect(status.tasks).toMatchObject({ version: 2, durable: true });
    s.work.publish([call('dropme', 'piece-0020')]);
    expect(await (await fetch(`${s.url}/eval/v1/runs/dropme`, { method: 'DELETE', headers })).json()).toEqual({ removed: 1 });
    expect(s.work.store.ofRun('dropme')).toEqual([]);
    await s.close();
  });
});

describe('eval drop', () => {
  it('drops a run\'s tasks and results through serve when it answers, and from the folder when it does not', async () => {
    const root = newRoot();
    fs.mkdirSync(path.join(root, '.knode'), { recursive: true });
    fs.writeFileSync(path.join(root, MCP_TOKEN_FILE), TOKEN);
    const runDir = path.join(tmp, 'runs', 'drop-me');
    let s = await startServe(root);
    const port = s.port;
    const remote = (await connect(s.url, 'drop-me'))!;
    void publishCall(remote, 'd0').catch(() => {});
    await until(() => s.work.store.ofRun('drop-me').length === 1);
    // another run directory of the same name keeps its tasks
    s.work.publish([call('drop-me', 'other-dir-01')], { scope: 'cccccccccccc' });
    const lines: string[] = [];
    expect(await dropQueuedRun(runDir, root, { serveUrl: s.url, log: (m) => lines.push(m) })).toBe(1);
    expect(lines).toEqual(['drop-me: dropped 1 task(s) and their results from serve\'s queue']);
    expect(s.work.store.ofRun('drop-me').map((t) => t.key)).toEqual(['other-dir-01']);
    remote.close();
    await s.close();
    // serve stopped: straight from the folder, the scoring's pieces too
    const w = new EvalWork(root);
    w.publish([call('drop-me-score', 'score-0001')], { scope: scopeOf(`${runDir}#score`) });
    w.close();
    expect(await dropQueuedRun(runDir, root, { serveUrl: `http://127.0.0.1:${port}` })).toBe(1);
    const after = new EvalWork(root);
    expect(after.store.ofRun('drop-me-score')).toEqual([]);
    after.close();
    s = await startServe(root, { port });
    await s.close();
  });
});

describe('compatibility', () => {
  it('serves a run from stage 1 on its held offer, and drops the piece when it closes the request', async () => {
    const s = await startServe(newRoot());
    const w = startWorker(() => s.work);
    const offer = (spec: EvalCallSpec, signal?: AbortSignal) => fetch(`${s.url}/eval/v1/offer`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ spec, offerSeconds: 30 }), signal });
    const res = await offer(call('old-run', 'old-key-0001'));
    expect(JSON.parse((await res.text()).trim())).toMatchObject({ outcome: 'answered', text: 'done: prompt of old-key-0001' });
    await w.stop();
    const ac = new AbortController();
    const pending = offer(call('old-run', 'old-key-0002'), ac.signal).then((r) => r.text()).catch(() => 'closed');
    await until(() => s.work.calls.live('old-run', 'old-key-0002') === 'waiting');
    ac.abort();
    await pending;
    await until(() => s.work.store.get('old-run', 'old-key-0002')?.state === 'dropped');
    await s.close();
  });

  it('publishes to a serve from stage 1 the stage-1 way, one held offer a piece, and says so', async () => {
    let offers = 0;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        if (req.url?.startsWith('/eval/v1/status')) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ offered: true, slots: { 'eval-call': [], 'eval-session': [] }, run: { waiting: 0, leased: 0 } }));
        } else if (req.url === '/eval/v1/offer') {
          offers++;
          const { spec } = JSON.parse(body) as { spec: EvalCallSpec };
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ outcome: 'answered', worker: 'laptop/w1/eval-codex#1', backend: 'codex-cli:gpt-test', text: `old: ${spec.prompt}`, usage: null, model: 'gpt-test' }));
        } else res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const lines: string[] = [];
    const remote = (await connect(url, 'to-old', { log: (m: string) => lines.push(m) }))!;
    expect(textOf(await publishCall(remote, 'z'))).toBe('old: z');
    expect(offers).toBe(1);
    expect(lines.some((l) => /from before durable tasks/.test(l))).toBe(true);
    remote.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('keeps the run\'s own broker in memory: nothing written, nothing kept after a piece settles', async () => {
    const remote = RemoteEval.own({ run: 'in-memory', source: { retryMs: 0 } });
    remote.startLocal({ codex: 1 });
    const r = await publishCall(remote, 'm');
    expect(r).toEqual({ local: true, value: 'here' });
    const queue = remote.queue as OwnQueue;
    expect(queue.calls.durable).toBe(false);
    expect((await queue.calls.status()).store).toBeNull();
    expect(queue.calls.live('in-memory', 'anything')).toBeNull();
    remote.close();
  });
});
