import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmbeddingProvider } from '../src/ingest/embeddings.js';
import { buildFixturePack } from '../src/eval/packs/fixture.js';
import { runAgentHere, setAgentStopping } from '../src/eval/agent.js';
import { OwnQueue, PieceStuckError, RemoteEval, WaitLimitError } from '../src/eval/remote.js';
import { eachWithin, runEval } from '../src/eval/run.js';
import { RunStore } from '../src/eval/runstore.js';
import type { WorkerIdentity } from '../src/labeling/scheduler.js';
import { EvalSource } from '../src/work/eval.js';
import type { EvalCallSpec, EvalSpec } from '../src/work/eval.js';
import { ScriptedBackend, scriptedJudge } from './helpers/eval-scripted.js';

/**
 * docs/design/32 stage 1: an evaluation run only publishes its model work;
 * slots that lease it do it, and with none a piece waits — on the run's own
 * broker here (the scripted backend, no worker processes), on serve's with
 * real workers in tests/remote-eval.test.ts.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-work-queue-'));
const packDir = path.join(tmp, 'packs', 'fixture-life');
const embedder = createEmbeddingProvider({ provider: 'local', baseUrl: '', apiKey: '', model: '', dimensions: 384, batchSize: 64, sendDimensions: false });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const common = () => ({
  packs: [packDir], systems: ['closed-book'], quota: false, suites: ['usage' as const], limit: 3,
  overrides: { chat: new ScriptedBackend(), judge: scriptedJudge(), embedder }, waitCheckMs: 50,
});

beforeAll(() => {
  buildFixturePack(packDir);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const callSpec = (over: Partial<EvalCallSpec> = {}): Omit<EvalCallSpec, 'run' | 'key'> => ({
  kind: 'eval-call', eligible: 'any', label: 'x', agent: { family: 'codex', model: 'gpt-test', effort: null, speed: null }, prompt: 'p', schema: null, timeoutMs: 60_000, ...over,
});

describe('waiting', () => {
  it('stops cleanly at the wait limit with nothing recorded, and a resume finishes with no answer twice or lost', async () => {
    const runDir = path.join(tmp, 'runs', 'wait');
    const lines: string[] = [];
    const t0 = Date.now();
    // no worker, no --local: nothing runs, and the run says what it waits for
    const err = await runEval({ ...common(), runDir, local: {}, waitMinutes: 0.02, onProgress: (m) => lines.push(m) }).catch((e) => e);
    expect(err).toBeInstanceOf(WaitLimitError);
    expect(err.message).toMatch(/waited 0.02 min for a slot that takes a model call on codex/);
    expect(err.runDir).toBe(runDir);
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(lines.some((l) => /no slot on this machine: the run's pieces wait/.test(l))).toBe(true);
    expect(lines.some((l) => /^waiting: \d+ piece\(s\) for a model call on codex/.test(l))).toBe(true);
    expect(new RunStore(runDir).allAnswers()).toEqual([]);
    // a resume on the run's own slots finishes it
    const res = await runEval({ ...common(), runDir, local: { codex: 2, claude: 1 } });
    const answers = new RunStore(res.runDir).allAnswers();
    expect(answers.length).toBe(3);
    expect(answers.filter((a) => a.error)).toEqual([]);
    const lines2 = fs.readFileSync(path.join(runDir, 'answers.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { key: string });
    expect(new Set(lines2.map((l) => l.key)).size).toBe(lines2.length);
    expect(lines2.length).toBe(3);
  }, 120_000);

  it('runs an old command line here, on slots sized from --slots, with answers three at a time', async () => {
    const lines: string[] = [];
    const runDir = path.join(tmp, 'runs', 'legacy');
    await runEval({ ...common(), runDir, slots: 4, onProgress: (m) => lines.push(m) });
    expect(lines.some((l) => /no --remote and no --local: .* on --local codex:4,claude:4 \(sized from --slots\)/.test(l))).toBe(true);
    const answers = new RunStore(runDir).allAnswers();
    expect(answers.length).toBe(3);
    expect(new Set(answers.map((a) => a.worker ?? 'local'))).toEqual(new Set(['local']));
    expect(new RunStore(runDir).allScores().length).toBeGreaterThan(0);
  }, 120_000);

  it('waits with no limit at --wait-minutes 0', async () => {
    const remote = RemoteEval.own({ run: 'no-limit', waitMinutes: 0, checkMs: 20 });
    const p = remote.publish(callSpec(), async () => 'done');
    await sleep(300);
    expect(remote.stopped).toBeNull();
    remote.startLocal({ codex: 1 });
    expect(await p).toEqual({ local: true, value: 'done' });
    remote.close();
  });
});

describe('width', () => {
  it('counts the run\'s own slots and the slots online that could take its work', async () => {
    const remote = RemoteEval.own({ run: 'w', refreshMs: 50 });
    const queue = remote.queue as OwnQueue;
    expect(remote.width('eval-call', 'codex', 'any')).toBe(0);
    remote.startLocal({ codex: 2, claude: 1 });
    expect(remote.width('eval-call', 'codex', 'any')).toBe(2);
    expect(remote.width('eval-session', 'codex', 'any')).toBe(2);
    expect(remote.width('eval-call', 'claude', 'any')).toBe(1);
    expect(remote.width('eval-session', 'claude', 'any')).toBe(0);
    // slots that asked of the queue: a worker elsewhere counts for any piece, never for one that stays here
    const away: WorkerIdentity = { worker: 'laptop/w/eval-codex#1', backend: 'codex', remote: true };
    const here: WorkerIdentity = { worker: 'box/eval-codex#1', backend: 'codex', remote: false };
    const otherRun: WorkerIdentity = { worker: 'local/x/eval-codex#1', backend: 'codex', remote: false, run: 'x' };
    for (const who of [away, here, otherRun]) await queue.calls.lease(who, 1);
    await sleep(150);
    expect(remote.width('eval-call', 'codex', 'any')).toBe(4);
    expect(remote.width('eval-call', 'codex', 'local')).toBe(3);
    remote.close();
  });

  it('answers as wide as the width says, re-read as it changes', async () => {
    let width = 1;
    let active = 0;
    const seen: number[] = [];
    const items = Array.from({ length: 12 }, (_, i) => i);
    const done = eachWithin(items, () => width, async () => {
      active++;
      seen.push(active);
      await sleep(120);
      active--;
    });
    await sleep(300);
    expect(Math.max(...seen)).toBe(1);
    width = 4;
    await done;
    expect(Math.max(...seen)).toBe(4);
  });
});

describe('failures', () => {
  const piece = (run = 'f'): EvalSpec => ({ ...callSpec(), run, key: `piece-${run}-0001` }) as EvalSpec;
  const worker = (name: string, n = 1): WorkerIdentity => ({ worker: `${name}/eval-codex#${n}`, backend: 'codex', remote: true });
  const fail = async (source: EvalSource, who: WorkerIdentity) => {
    const [task] = await source.lease(who, 1);
    expect(task).toBeDefined();
    return source.complete(task.id, who, { ok: false, error: 'usage limit reached, try again later', kind: 'transient' });
  };

  it('puts a piece a worker could not serve back in line, and marks it stuck when three different machines could not', async () => {
    const source = new EvalSource('eval-call', { retryMs: 0 });
    const offer = source.offer(piece());
    let settled = false;
    void offer.result.then(() => (settled = true));
    // one machine failing it on two of its slots is one machine
    await fail(source, worker('laptop/a', 1));
    await fail(source, worker('laptop/a', 2));
    await fail(source, worker('laptop/b'));
    await sleep(20);
    expect(settled).toBe(false);
    expect(source.runStatus('f')).toEqual({ waiting: 1, leased: 0 });
    await fail(source, worker('laptop/c'));
    expect(await offer.result).toEqual({ outcome: 'stuck', workers: ['laptop/a', 'laptop/b', 'laptop/c'], lastError: 'usage limit reached, try again later' });
    expect((await source.status()).totals.stuck).toBe(1);
    source.close();
  });

  it('gives a machine a piece it failed again only when nothing else waits for it', async () => {
    const source = new EvalSource('eval-call', { retryMs: 0 });
    const first = source.offer({ ...piece(), key: 'piece-first-0001' } as EvalSpec);
    const second = source.offer({ ...piece(), key: 'piece-second-01' } as EvalSpec);
    await fail(source, worker('laptop/a'));
    const [next] = await source.lease(worker('laptop/a'), 1);
    expect('key' in next && next.key).toBe('piece-second-01');
    first.cancel();
    second.cancel();
    source.close();
  });

  it('tells a stuck piece to the run, which reports it with the system and task it was for', async () => {
    const stuck: unknown[] = [];
    const remote = RemoteEval.own({ run: 'r-stuck', onStuck: (p) => stuck.push(p), source: { retryMs: 0 } });
    const queue = remote.queue as OwnQueue;
    const p = remote.publish(callSpec({ label: 'closed-book · answer · t1' }), async () => 'never', { system: 'closed-book', task: 't1' }).catch((e) => e);
    for (const name of ['laptop/m1', 'laptop/m2', 'laptop/m3']) {
      for (let i = 0; i < 50 && !(await queue.calls.lease(worker(name), 1).then(async ([t]) => (t ? (await queue.calls.complete(t.id, worker(name), { ok: false, error: 'not logged in', kind: 'fatal' }), true) : false))); i++) await sleep(10);
    }
    const err = await p;
    expect(err).toBeInstanceOf(PieceStuckError);
    expect(err.message).toMatch(/stuck: 3 workers could not serve closed-book · answer · t1 \(laptop\/m1, laptop\/m2, laptop\/m3\): not logged in/);
    expect(remote.stuckFor(0, 'closed-book', 't1')).toHaveLength(1);
    expect(remote.stuckFor(0, 'closed-book', 't2')).toHaveLength(0);
    expect(stuck).toHaveLength(1);
    remote.close();
  });
});

describe('cancelled sessions', () => {
  const script = (name: string, body: string) => {
    const f = path.join(tmp, name);
    fs.writeFileSync(f, `#!/bin/sh\ncat > /dev/null\n${body}\n`);
    fs.chmodSync(f, 0o755);
    return f;
  };
  const old = process.env.KNODE_CODEX_CATALOG_HOURS;
  beforeAll(() => (process.env.KNODE_CODEX_CATALOG_HOURS = '0'));
  afterAll(() => {
    if (old === undefined) delete process.env.KNODE_CODEX_CATALOG_HOURS;
    else process.env.KNODE_CODEX_CATALOG_HOURS = old;
  });

  it('records a session killed by a signal as cancelled, never as an empty answer', async () => {
    const cwd = fs.mkdtempSync(path.join(tmp, 'agent-'));
    const r = await runAgentHere({ cwd, prompt: 'p', sandbox: 'read-only', model: 'gpt-test', command: script('killed.sh', 'kill -TERM $$') });
    expect(r.cancelled).toBe(true);
    expect(r.error).toMatch(/^cancelled: codex was killed by SIGTERM/);
    expect(r.text).toBe('');
  });

  it('records a session that ended with nothing while the run was stopping as cancelled, and one that did not as it was', async () => {
    const cwd = fs.mkdtempSync(path.join(tmp, 'agent-'));
    const nothing = script('nothing.sh', 'exit 0');
    expect((await runAgentHere({ cwd, prompt: 'p', sandbox: 'read-only', model: 'gpt-test', command: nothing })).cancelled).toBeUndefined();
    const ac = new AbortController();
    ac.abort();
    setAgentStopping(ac.signal);
    try {
      const r = await runAgentHere({ cwd, prompt: 'p', sandbox: 'read-only', model: 'gpt-test', command: nothing });
      expect(r.cancelled).toBe(true);
      expect(r.error).toMatch(/^cancelled: the session ended with nothing while the run was stopping/);
    } finally {
      setAgentStopping(null);
    }
  });
});

describe('what a task requires', () => {
  const spec = (over: Partial<EvalSpec> = {}): EvalSpec => ({ ...callSpec(), run: 'req', key: 'piece-req-00001', pool: null, ...over }) as EvalSpec;
  const who = (over: Partial<WorkerIdentity> = {}): WorkerIdentity => ({ worker: 'laptop/w/eval-codex#1', backend: 'codex', remote: true, ...over });

  it('hands a task out with its class, requirements, pool and eligibility', async () => {
    const source = new EvalSource('eval-call');
    const offer = source.offer(spec({ pool: 'gateway' }));
    const [task] = await source.lease(who({ pool: 'gateway' }), 1);
    expect(task).toMatchObject({ kind: 'eval-call', class: 'eval', requires: { family: 'codex', model: 'gpt-test' }, pool: 'gateway', eligible: 'any', key: 'piece-req-00001' });
    offer.cancel();
    source.close();
  });

  it('never gives a piece that requires pool A to a slot of pool B, or of none', async () => {
    const source = new EvalSource('eval-call');
    const offer = source.offer(spec({ pool: 'A' }));
    expect(await source.lease(who({ pool: 'B' }), 1)).toEqual([]);
    expect(await source.lease(who({ pool: undefined }), 1)).toEqual([]);
    expect(await source.lease(who({ worker: 'box/eval-codex#1', remote: false, pool: 'B' }), 1)).toEqual([]);
    expect(await source.lease(who({ backend: 'claude', pool: 'A' }), 1)).toEqual([]);
    expect(await source.lease(who({ pool: 'A' }), 1)).toHaveLength(1);
    offer.cancel();
    source.close();
  });

  it('never lets eligible: local work leave this machine', async () => {
    const source = new EvalSource('eval-call');
    const offer = source.offer(spec({ eligible: 'local' }));
    expect(await source.lease(who(), 1)).toEqual([]);
    // nor to another run's own slots: they run their run's backends
    expect(await source.lease(who({ worker: 'local/other/eval-codex#1', remote: false, run: 'other' }), 1)).toEqual([]);
    expect(await source.lease(who({ worker: 'local/req/eval-codex#1', remote: false, run: 'req' }), 1)).toHaveLength(1);
    offer.cancel();
    source.close();
  });

  it('puts a run\'s own slots in its pool, and names the pool it waited for', async () => {
    const err = await runEval({ ...common(), runDir: path.join(tmp, 'runs', 'pool-wait'), local: {}, pool: 'gateway', waitMinutes: 0.02 }).catch((e) => e);
    expect(err).toBeInstanceOf(WaitLimitError);
    expect(err.message).toMatch(/a model call on codex in pool gateway, on this machine's slots only/);
    // the run's own slots join its pool, so they take its pieces
    const res = await runEval({ ...common(), runDir: path.join(tmp, 'runs', 'pool-wait'), local: { codex: 1, claude: 1 }, pool: 'gateway' });
    expect(new RunStore(res.runDir).allAnswers()).toHaveLength(3);
  }, 60_000);
});
