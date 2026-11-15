import { describe, expect, it } from 'vitest';
import { Judge } from '../src/eval/judge.js';
import { Meter } from '../src/eval/meter.js';
import { RemoteEval, remoteJudgeClient } from '../src/eval/remote.js';
import { judgeCap, judgeWidth } from '../src/eval/run.js';
import type { LlmClient } from '../src/llm/client.js';

/**
 * How wide the judge asks (docs/design/32 §11): as many calls at once as its
 * width says — the slots online that take its calls — across every batch
 * asked of it at the same time; two when nothing says.
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A judge client that answers every item, and counts how many of its calls overlap. */
function countingJudge(opts: { ms?: number; hold?: Promise<void>; fail?: (call: number) => Error | null } = {}) {
  const seen = { calls: 0, active: 0, peak: 0 };
  const client = {
    label: 'counting-judge',
    model: 'counting-judge',
    async completeJson<T>(messages: { role: string; content: string }[]): Promise<T> {
      const n = ++seen.calls;
      seen.active++;
      seen.peak = Math.max(seen.peak, seen.active);
      try {
        // a call that fails does so before the calls beside it end
        const err = opts.fail?.(n);
        if (opts.hold) await opts.hold;
        else await sleep(err ? 5 : opts.ms ?? 30);
        if (err) throw err;
        const items = (JSON.parse(messages.find((m) => m.role === 'user')!.content) as { items: { id: string }[] }).items;
        return { verdicts: items.map((i) => ({ id: i.id, score: 2, keypoints: [], abstained: false, hallucinated: false, pairs: [] })) } as T;
      } finally {
        seen.active--;
      }
    },
  };
  return { client: client as unknown as LlmClient, seen };
}

const grades = (n: number, tag = 'g') => Array.from({ length: n }, (_, i) => ({ id: `${tag}${i}`, question: `q${tag}${i}`, reference: 'r', answer: 'a' }));
const lists = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `l${i}`, predicted: [`p${i}`], gold: [`g${i}`] }));

describe('the judge\'s width', () => {
  it('asks as many calls at once as its width says', async () => {
    const { client, seen } = countingJudge();
    const judge = new Judge({ client, meter: new Meter(), batchSize: 1, width: () => 5 });
    const verdicts = await judge.gradeAnswers(grades(20));
    expect(verdicts.size).toBe(20);
    expect(seen.calls).toBe(20);
    expect(seen.peak).toBe(5);
  });

  it('keeps two at once when nothing says how wide it is, and a fixed concurrency when one is given', async () => {
    const plain = countingJudge();
    await new Judge({ client: plain.client, meter: new Meter(), batchSize: 1 }).gradeAnswers(grades(8));
    expect(plain.seen.peak).toBe(2);
    const fixed = countingJudge();
    await new Judge({ client: fixed.client, meter: new Meter(), batchSize: 1, concurrency: 3 }).gradeAnswers(grades(8));
    expect(fixed.seen.peak).toBe(3);
  });

  it('follows a width that grows while calls wait, with no call ending in between', async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => (release = r));
    const { client, seen } = countingJudge({ hold });
    let width = 1;
    const judge = new Judge({ client, meter: new Meter(), batchSize: 1, width: () => width, widthCheckMs: 10 });
    const done = judge.gradeAnswers(grades(6));
    await sleep(40);
    expect(seen.active).toBe(1);
    // four more slots come online: the calls that waited go out without any call having ended
    width = 5;
    await sleep(80);
    expect(seen.active).toBe(5);
    release();
    expect((await done).size).toBe(6);
    expect(seen.peak).toBe(5);
  });

  it('bounds two batches asked at the same time together, not each on its own', async () => {
    const { client, seen } = countingJudge();
    const judge = new Judge({ client, meter: new Meter(), batchSize: 1, width: () => 3 });
    const [g, l] = await Promise.all([judge.gradeAnswers(grades(9)), judge.matchList(lists(9))]);
    expect(g.size).toBe(9);
    expect(l.size).toBe(9);
    expect(seen.calls).toBe(18);
    expect(seen.peak).toBe(3);
  });

  it('starts no further call of a batch after one failed, and throws that failure', async () => {
    const boom = new Error('claude CLI error: Not logged in');
    const { client, seen } = countingJudge({ fail: (n) => (n === 1 ? boom : null) });
    const judge = new Judge({ client, meter: new Meter(), batchSize: 1, width: () => 2 });
    await expect(judge.gradeAnswers(grades(10))).rejects.toBe(boom);
    await sleep(150);
    // the call beside the failed one was already out; the eight that waited never start
    expect(seen.calls).toBe(2);
    expect(seen.active).toBe(0);
    // a later batch of the same judge is asked as usual
    const again = await judge.gradeAnswers(grades(3, 'h'));
    expect(again.size).toBe(3);
  });

  it('still asks a reply that does not parse again in halves, each call through the gate', async () => {
    let n = 0;
    const seen = { active: 0, peak: 0 };
    const client = {
      label: 'j', model: 'j',
      async completeJson<T>(messages: { role: string; content: string }[]): Promise<T> {
        n++;
        seen.active++;
        seen.peak = Math.max(seen.peak, seen.active);
        try {
          await sleep(10);
          const items = (JSON.parse(messages.find((m) => m.role === 'user')!.content) as { items: { id: string }[] }).items;
          if (items.length > 1) throw new SyntaxError('Unexpected end of JSON input');
          return { verdicts: items.map((i) => ({ id: i.id, score: 1, keypoints: [], abstained: false, hallucinated: false })) } as T;
        } finally {
          seen.active--;
        }
      },
    } as unknown as LlmClient;
    const judge = new Judge({ client, meter: new Meter(), batchSize: 4, width: () => 1 });
    const verdicts = await judge.gradeAnswers(grades(4));
    expect(verdicts.size).toBe(4);
    // 4 → 2 + 2 → 1 + 1 + 1 + 1, one at a time, and none waits on a gate it holds itself
    expect(n).toBe(7);
    expect(seen.peak).toBe(1);
  });
});

describe('the judge\'s width in a run', () => {
  it('is 2 for an old command line, the flag when given, and otherwise unbounded', () => {
    expect(judgeCap({}, { legacy: true })).toBe(2);
    expect(judgeCap({}, { legacy: false })).toBeUndefined();
    expect(judgeCap({ judgeConcurrency: 4 }, { legacy: true })).toBe(4);
    expect(judgeCap({ judgeConcurrency: 4 }, { legacy: false })).toBe(4);
  });

  it('is the slots that take the judge\'s calls, at most the cap, and one when none is online', async () => {
    const remote = RemoteEval.own({ run: 'judge-width', waitMinutes: 0 });
    try {
      // no slot yet: one call is published and waits
      expect(judgeWidth(remote, 'claude', 'local', undefined)()).toBe(1);
      remote.startLocal({ claude: 5 });
      expect(judgeWidth(remote, 'claude', 'local', undefined)()).toBe(5);
      expect(judgeWidth(remote, 'claude', 'local', 2)()).toBe(2);
      // Codex slots do not take a Claude judge's calls
      expect(judgeWidth(remote, 'codex', 'local', undefined)()).toBe(1);

      // and a judge published to those slots runs five wide
      const { client, seen } = countingJudge();
      const published = remoteJudgeClient(client, remote, { family: 'claude', model: '', effort: null, eligible: 'local', backend: null });
      const judge = new Judge({ client: published, meter: new Meter(), batchSize: 1, width: judgeWidth(remote, 'claude', 'local', undefined) });
      const verdicts = await judge.gradeAnswers(grades(15));
      expect(verdicts.size).toBe(15);
      expect(seen.peak).toBe(5);
    } finally {
      remote.close();
    }
  });
});
