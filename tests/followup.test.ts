import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * What follows extraction in `serve` (src/labeling/followup.ts), and the
 * switch that starts and stops it with the extraction slots
 * (src/labeling/processing.ts). The review, the claim review and the summary
 * writer are stand-ins here: what is under test is who gets a turn, and when.
 */

const timing = { reviewMs: 0, summaryMs: 0 };
const calls = { reviews: 0, summaries: 0 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

vi.mock('../src/graph/dedupe.js', () => ({
  auditDuplicateEntities: async () => {
    calls.reviews++;
    await sleep(timing.reviewMs);
    return { suggested: 0, autoMerged: 0, llmRejected: 0 };
  },
}));
vi.mock('../src/graph/claim-dedupe.js', () => ({
  auditDuplicateClaims: async () => ({ merged: 0, suggested: 0, conflicts: 0 }),
}));
vi.mock('../src/wiki/pages.js', () => ({
  ensureSourceSummaries: async () => {
    calls.summaries++;
    await sleep(timing.summaryMs);
    return ['wiki/sources/page.md'];
  },
  reconcileViews: async () => ({ regenerated: 0, archived: 0 }),
}));

const { startFollowUp } = await import('../src/labeling/followup.js');
const { LabelingProcessing } = await import('../src/labeling/processing.js');
const { LocalLabelingWorkers } = await import('../src/labeling/local.js');
const { defaultConfig, defaultRoutedLlmConfig } = await import('../src/config.js');

/** A scheduler that always has a finished batch to review, so every review is a slow one. */
const busyScheduler = () => ({
  takeFinished: () => ({ written: 1, failed: 0, documents: ['raw/docs/a.md'], entityIds: ['e1'], claimIds: [] }),
});

const ctx = { config: { extraction: { intervalMinutes: 5, concurrency: 1 } } } as never;

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  calls.reviews = 0;
  calls.summaries = 0;
});

describe('the follow-up loop', () => {
  it('keeps writing summaries when every review outlasts its interval', async () => {
    timing.reviewMs = 200;
    timing.summaryMs = 10;
    const followUp = startFollowUp(ctx, busyScheduler() as never, { reviewIntervalMs: 50 });
    stops.push(followUp.stop);
    await sleep(1500);
    // reviews queued on a clock (every 50 ms, each 200 ms long) used to pile up
    // ahead of the summary loop: a handful of summaries, then none at all
    expect(calls.reviews).toBeGreaterThanOrEqual(3);
    expect(calls.summaries).toBeGreaterThanOrEqual(15);
  });

  it('does nothing while paused, and starts at once when switched on', async () => {
    timing.reviewMs = 5;
    timing.summaryMs = 5;
    const followUp = startFollowUp(ctx, busyScheduler() as never, { reviewIntervalMs: 20, active: false });
    stops.push(followUp.stop);
    await sleep(200);
    expect(calls).toEqual({ reviews: 0, summaries: 0 });
    followUp.setActive(true);
    await sleep(200);
    expect(calls.summaries).toBeGreaterThan(0);
    expect(calls.reviews).toBeGreaterThan(0);
    followUp.setActive(false);
    await sleep(50);
    const settled = { ...calls };
    await sleep(200);
    expect(calls).toEqual(settled);
  });
});

describe('processing', () => {
  const config = () => {
    const base = defaultConfig();
    return {
      ...base,
      connections: [{
        id: 'connection-1', label: 'fake', provider: 'openai' as const, baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-test',
        protocol: 'chat' as const, model: 'fake-model', cliPath: '', effort: 'default' as const, cliTimeoutMs: 5_000,
      }],
      llmUse: 'connection-1',
      extraction: { ...base.extraction, entityLlm: { ...defaultRoutedLlmConfig(), use: 'connection-1' }, workers: [{ use: 'connection-1', slots: 2 }] },
    };
  };

  it('starts the slots and the follow-up together, as often as it is started and stopped', async () => {
    let leases = 0;
    const scheduler = {
      lease: async () => {
        leases++;
        return [];
      },
      takeFinished: () => ({ written: 0, failed: 0, documents: [], entityIds: [], claimIds: [] }),
    };
    const workers = new LocalLabelingWorkers(scheduler as never, config as never, { idleMs: 5 });
    const followUp = startFollowUp(ctx, scheduler as never, { reviewIntervalMs: 20, active: false });
    stops.push(followUp.stop, () => workers.stop());
    const processing = new LabelingProcessing(workers, followUp);

    await sleep(100);
    expect(leases).toBe(0);
    expect(processing.state()).toEqual({ running: false, since: null, by: null });

    expect(processing.start('admin')).toBe(true);
    expect(processing.start('admin')).toBe(false);
    expect(followUp.active).toBe(true);
    await sleep(100);
    expect(leases).toBeGreaterThan(0);
    expect(processing.state()).toMatchObject({ running: true, by: 'admin' });

    expect(processing.stop('admin')).toBe(true);
    expect(followUp.active).toBe(false);
    await sleep(30);
    const stopped = leases;
    await sleep(100);
    expect(leases).toBe(stopped);

    // and again: a stop is not the end of it
    processing.start('admin');
    await sleep(100);
    expect(leases).toBeGreaterThan(stopped);
    expect(workers.status().map((b) => b.slots)).toEqual([2]);
  });
});
