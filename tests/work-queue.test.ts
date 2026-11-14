import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmbeddingProvider } from '../src/ingest/embeddings.js';
import { buildFixturePack } from '../src/eval/packs/fixture.js';
import { OwnQueue, RemoteEval, WaitLimitError } from '../src/eval/remote.js';
import { eachWithin, runEval } from '../src/eval/run.js';
import { RunStore } from '../src/eval/runstore.js';
import type { WorkerIdentity } from '../src/labeling/scheduler.js';
import type { EvalCallSpec } from '../src/work/eval.js';
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
