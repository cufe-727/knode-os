import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * What follows extraction in `serve` (src/labeling/followup.ts), and the
 * switch that starts and stops it with this machine's slots
 * (src/labeling/processing.ts). The reviews are stand-ins here: what is under
 * test is who gets a turn, and when — a review, or a summary page that a slot
 * or a remote worker wrote (src/work/summarize.ts).
 */

const timing = { reviewMs: 0 };
const calls: { reviews: number; judges: unknown[] } = { reviews: 0, judges: [] };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

vi.mock('../src/graph/dedupe.js', () => ({
  auditDuplicateEntities: async (ctx: { judge?: unknown }) => {
    calls.reviews++;
    calls.judges.push(ctx.judge);
    await sleep(timing.reviewMs);
    return { suggested: 0, autoMerged: 0, llmRejected: 0, leftToPerson: 0 };
  },
}));
vi.mock('../src/graph/claim-dedupe.js', () => ({
  auditDuplicateClaims: async (ctx: { judge?: unknown }) => {
    calls.judges.push(ctx.judge);
    return { merged: 0, suggested: 0, conflicts: 0, leftToPerson: 0 };
  },
}));
vi.mock('../src/wiki/pages.js', () => ({
  reconcileViews: async () => ({ regenerated: 0, archived: 0 }),
}));

const { startFollowUp } = await import('../src/labeling/followup.js');
const { LabelingProcessing } = await import('../src/labeling/processing.js');
const { LocalLabelingWorkers } = await import('../src/labeling/local.js');
const { defaultConfig, defaultRoutedLlmConfig } = await import('../src/config.js');

/** A scheduler that always has a finished batch to review, so every review is a slow one. */
const busyScheduler = () => ({
  takeFinished: () => ({ written: 1, failed: 0, documents: ['raw/docs/a.md'], entityIds: ['e1'], claimIds: ['c1'] }),
});

const ctx = { config: { extraction: { intervalMinutes: 5, concurrency: 1 } } } as never;

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  calls.reviews = 0;
  calls.judges = [];
});

describe('the follow-up loop', () => {
  it('writes summary pages between reviews when every review outlasts its interval', async () => {
    timing.reviewMs = 200;
    const followUp = startFollowUp(ctx, busyScheduler() as never, { reviewIntervalMs: 50 });
    stops.push(followUp.stop);
    const waits: number[] = [];
    const until = Date.now() + 1500;
    while (Date.now() < until) {
      const queued = Date.now();
      await followUp.serialize(async () => {
        waits.push(Date.now() - queued);
      });
      await sleep(20);
    }
    // reviews queued on a clock (every 50 ms, each 200 ms long) used to pile up
    // ahead of everything else; a page waits for the review in progress, no more
    expect(calls.reviews).toBeGreaterThanOrEqual(3);
    expect(waits.length).toBeGreaterThanOrEqual(5);
    expect(Math.max(...waits)).toBeLessThan(450);
  });

  it('reviews nothing while paused but writes pages either way, and reviews once switched on', async () => {
    timing.reviewMs = 5;
    const followUp = startFollowUp(ctx, busyScheduler() as never, { reviewIntervalMs: 20, active: false });
    stops.push(followUp.stop);
    let pages = 0;
    const page = async () => {
      pages++;
    };
    await followUp.serialize(page);
    await sleep(200);
    expect(calls.reviews).toBe(0);
    expect(pages).toBe(1);
    followUp.setActive(true);
    await sleep(200);
    expect(calls.reviews).toBeGreaterThan(0);
    followUp.setActive(false);
    await sleep(50);
    const settled = calls.reviews;
    await sleep(200);
    expect(calls.reviews).toBe(settled);
    // once stopped, nothing more is written
    followUp.stop();
    await followUp.serialize(page);
    expect(pages).toBe(1);
  });

  it('hands both audits\' judge calls to the judge it was given, and gives up the waiting ones on a pause', async () => {
    timing.reviewMs = 5;
    const judge = { enabled: true, run: async () => [] };
    let pauses = 0;
    const followUp = startFollowUp(ctx, busyScheduler() as never, { reviewIntervalMs: 20, judge, onPause: () => pauses++ });
    stops.push(followUp.stop);
    await sleep(100);
    expect(calls.judges.length).toBeGreaterThanOrEqual(2);
    expect(calls.judges.every((j) => j === judge)).toBe(true);
    followUp.setActive(false);
    followUp.setActive(false);
    // a pause is felt once; switching on again is no pause
    expect(pauses).toBe(1);
    followUp.setActive(true);
    expect(pauses).toBe(1);
  });
});

describe('processing', () => {
  const config = () => {
    const base = defaultConfig();
    const route = { ...defaultRoutedLlmConfig(), use: 'connection-1' };
    return {
      ...base,
      connections: [{
        id: 'connection-1', label: 'fake', provider: 'openai' as const, baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-test',
        protocol: 'chat' as const, model: 'fake-model', cliPath: '', effort: 'default' as const, cliTimeoutMs: 5_000,
      }],
      llmUse: 'connection-1',
      extraction: { ...base.extraction, entityLlm: route, summaryLlm: route, judgeLlm: route, workers: [{ use: 'connection-1', slots: 2 }] },
    };
  };

  it('starts this machine\'s slots — extraction, summaries and judge calls — and the reviews together, as often as it is started and stopped', async () => {
    const asked: string[] = [];
    const work = {
      lease: async (_who: unknown, kinds: readonly string[]) => {
        asked.push(kinds.join());
        return [];
      },
      complete: async () => ({}),
      renew: () => ({}),
    };
    const workers = new LocalLabelingWorkers(work, config as never, { idleMs: 5 });
    const followUp = startFollowUp(ctx, busyScheduler() as never, { reviewIntervalMs: 20, active: false });
    stops.push(followUp.stop, () => workers.stop());
    const processing = new LabelingProcessing(workers, followUp);

    await sleep(100);
    expect(asked).toEqual([]);
    // the cap applies before the first start; the floor is the processing's own (none given here)
    expect(processing.state()).toEqual({ running: false, since: null, by: null, calls: { inFlight: 0, max: 2 }, minQuotaPercent: 0, quotaHolds: [] });

    expect(processing.start('admin')).toBe(true);
    expect(processing.start('admin')).toBe(false);
    expect(followUp.active).toBe(true);
    await sleep(100);
    // each slot asks only for its own kind: segments on the Extract route, summaries on the
    // Summarize route, judge calls on the Judge route
    expect(new Set(asked)).toEqual(new Set(['extract', 'summarize', 'judge']));
    expect(processing.state()).toMatchObject({ running: true, by: 'admin' });

    expect(processing.stop('admin')).toBe(true);
    expect(followUp.active).toBe(false);
    await sleep(30);
    const stopped = asked.length;
    await sleep(100);
    expect(asked.length).toBe(stopped);

    // and again: a stop is not the end of it
    processing.start('admin');
    await sleep(100);
    expect(asked.length).toBeGreaterThan(stopped);
    expect(workers.status().map((b) => [b.id, b.slots])).toEqual([['connection-1', 2], ['summarize', 1], ['judge', 2]]);
  });
});
