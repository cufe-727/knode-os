import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { addMinutesToTimeOfDay, defaultConfig, loadConfig, normalizeTimeOfDay } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { nightlySchedule, startDreamScheduler } from '../src/dream/dream.js';
import { startTier2Scheduler } from '../src/server/serve.js';
import { syncTraces } from '../src/traces/sync.js';
import { refineWiki } from '../src/wiki/refine.js';

/**
 * `serve` runs Dream at `dream.schedule` and the tier-2 pass ten minutes
 * later, by comparing the clock's "HH:MM" with those strings. The schedulers
 * run here on fake timers; what they start is stubbed, since the real passes
 * read this machine's trace directories and call models.
 */

vi.mock('../src/wiki/refine.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/wiki/refine.js')>()),
  refineWiki: vi.fn(async () => {
    throw new Error('tier-2 stub');
  }),
}));
vi.mock('../src/traces/sync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/traces/sync.js')>()),
  syncTraces: vi.fn(async () => ({ copied: 0, skills: 0 })),
}));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-nightly-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Just enough of a context for the schedulers; a store that fails ends Dream right after its trace sync. */
function stubContext(schedule: string): AppContext {
  return {
    dataDir: tmp,
    config: { dream: { schedule, lookbackDays: 7, maxContextChars: 1000 } },
    store: { dataDir: tmp, query: async () => { throw new Error('store stub'); } },
    llm: {},
  } as unknown as AppContext;
}

/** Local wall-clock time on a fixed day. */
const at = (hours: number, minutes: number) => new Date(2026, 9, 19, hours, minutes, 0);

describe('dream.schedule', () => {
  it('reads a 24-hour time of day, padding an unpadded hour', () => {
    expect(normalizeTimeOfDay('03:00')).toBe('03:00');
    expect(normalizeTimeOfDay('3:00')).toBe('03:00');
    expect(normalizeTimeOfDay(' 7:05 ')).toBe('07:05');
    expect(normalizeTimeOfDay('23:59')).toBe('23:59');
    expect(normalizeTimeOfDay('0:00')).toBe('00:00');
    for (const bad of ['24:00', '12:60', '03:5', '3am', '0300', '', '-1:00', undefined, null, 300]) {
      expect(normalizeTimeOfDay(bad)).toBeNull();
    }
  });

  it('moves a time of day forward, carrying the hour and wrapping past midnight', () => {
    expect(addMinutesToTimeOfDay('03:00', 10)).toBe('03:10');
    expect(addMinutesToTimeOfDay('03:55', 10)).toBe('04:05');
    expect(addMinutesToTimeOfDay('23:55', 10)).toBe('00:05');
    expect(addMinutesToTimeOfDay('00:05', -10)).toBe('23:55');
  });

  it('puts the tier-2 pass ten minutes after Dream, in the next hour or day when that is where it lands', () => {
    expect(nightlySchedule({ dream: { schedule: '03:00', lookbackDays: 7, maxContextChars: 1 } })).toEqual({ dream: '03:00', tier2: '03:10' });
    expect(nightlySchedule({ dream: { schedule: '03:55', lookbackDays: 7, maxContextChars: 1 } })).toEqual({ dream: '03:55', tier2: '04:05' });
    expect(nightlySchedule({ dream: { schedule: '23:55', lookbackDays: 7, maxContextChars: 1 } })).toEqual({ dream: '23:55', tier2: '00:05' });
    expect(nightlySchedule({ dream: { schedule: '3:00', lookbackDays: 7, maxContextChars: 1 } })).toEqual({ dream: '03:00', tier2: '03:10' });
    // not a time of day: neither runs
    expect(nightlySchedule({ dream: { schedule: 'nightly', lookbackDays: 7, maxContextChars: 1 } })).toBeNull();
  });

  it('is held zero-padded once the config is loaded', () => {
    const dir = path.join(tmp, 'config');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'knode.config.json'), JSON.stringify({ dream: { schedule: '3:00' } }));
    expect(loadConfig(dir).dream.schedule).toBe('03:00');
    // what is no time of day stays as written, for `serve` to name in its log
    fs.writeFileSync(path.join(dir, 'knode.config.json'), JSON.stringify({ dream: { schedule: 'nightly' } }));
    expect(loadConfig(dir).dream.schedule).toBe('nightly');
  });
});

describe('the nightly schedulers', () => {
  let timer: NodeJS.Timeout | undefined;
  afterEach(() => {
    if (timer) clearInterval(timer);
    timer = undefined;
    vi.useRealTimers();
    vi.mocked(refineWiki).mockClear();
    vi.mocked(syncTraces).mockClear();
  });

  it('start the tier-2 pass after Dream when Dream is late in the hour', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    vi.setSystemTime(at(3, 5));
    timer = startTier2Scheduler(stubContext('03:55'), (m) => log.push(m));
    expect(log).toContain('tier2 pass scheduled daily at 04:05');

    // 03:05 is ten minutes after 03:55 only if the hour is dropped
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refineWiki).not.toHaveBeenCalled();

    vi.setSystemTime(at(4, 5));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refineWiki).toHaveBeenCalledTimes(1);
    // once a day
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refineWiki).toHaveBeenCalledTimes(1);
  });

  it('run Dream at an unpadded schedule that never went through loadConfig', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    vi.setSystemTime(at(2, 59));
    timer = startDreamScheduler(stubContext('3:00'), (m) => log.push(m));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(syncTraces).not.toHaveBeenCalled();

    vi.setSystemTime(at(3, 0));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(syncTraces).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(log.some((m) => m.startsWith('nightly dream failed: store stub'))).toBe(true));
  });

  it('skip the night\'s Dream and tier-2 pass while the plan they run on is under the quota floor', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const ctx = stubContext('03:00');
    // the tier-2 pass reads the Judge and Summarize stages' routes to know which plan to ask about
    ctx.config = { ...defaultConfig(), dream: ctx.config.dream };
    const held = { reason: 'Codex weekly window has 8% left, under the 10% floor', until: '2026-10-22T06:00:00.000Z' };
    const asked: string[] = [];
    vi.setSystemTime(at(3, 0));
    const dream = startDreamScheduler(ctx, (m) => log.push(m), { hold: async () => held });
    timer = startTier2Scheduler(ctx, (m) => log.push(m), { hold: async (user) => { asked.push(user.provider); return held; } });
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      vi.setSystemTime(at(3, 10));
      await vi.advanceTimersByTimeAsync(30_000);
      // the next night again, still under the floor
      vi.setSystemTime(new Date(2026, 9, 20, 3, 0, 0));
      await vi.advanceTimersByTimeAsync(30_000);
    } finally {
      clearInterval(dream);
    }
    expect(syncTraces).not.toHaveBeenCalled();
    expect(refineWiki).not.toHaveBeenCalled();
    expect(asked.length).toBeGreaterThan(0);
    expect(log.filter((m) => m.startsWith('nightly dream skipped: Codex weekly window has 8% left, under the 10% floor (processing.minQuotaPercent); the window resets 2026-10-22T06:00:00.000Z'))).toHaveLength(2);
    expect(log).toContain('tier2 skipped: Codex weekly window has 8% left, under the 10% floor (processing.minQuotaPercent); the window resets 2026-10-22T06:00:00.000Z');
  });

  it('run them as before while the plan is over the floor', async () => {
    vi.useFakeTimers();
    const ctx = stubContext('03:00');
    ctx.config = { ...defaultConfig(), dream: ctx.config.dream };
    vi.setSystemTime(at(3, 0));
    const dream = startDreamScheduler(ctx, () => {}, { hold: async () => null });
    timer = startTier2Scheduler(ctx, () => {}, { hold: async () => null });
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      vi.setSystemTime(at(3, 10));
      await vi.advanceTimersByTimeAsync(30_000);
    } finally {
      clearInterval(dream);
    }
    expect(syncTraces).toHaveBeenCalledTimes(1);
    expect(refineWiki).toHaveBeenCalledTimes(1);
  });

  it('start nothing while the schedule is not a time of day', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    vi.setSystemTime(at(3, 0));
    const ctx = stubContext('nightly');
    const dream = startDreamScheduler(ctx, (m) => log.push(m));
    timer = startTier2Scheduler(ctx, (m) => log.push(m));
    try {
      await vi.advanceTimersByTimeAsync(24 * 3600 * 1000);
    } finally {
      clearInterval(dream);
    }
    expect(syncTraces).not.toHaveBeenCalled();
    expect(refineWiki).not.toHaveBeenCalled();
    expect(log.some((m) => m.startsWith('tier2 pass scheduled'))).toBe(false);
  });
});
