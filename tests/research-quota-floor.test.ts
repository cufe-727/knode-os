import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import type { PlanUser } from '../src/labeling/background-floor.js';
import type { QuotaHold } from '../src/labeling/plan-quota.js';
import { getJob, queueJob } from '../src/research/jobs.js';
import { startResearchLoop } from '../src/research/service.js';

/**
 * The quota floor over background work reaches research: a job whose agent
 * runs on a plan under it goes back in line, paused until the window resets,
 * with the other jobs on the same account — never run, never failed, its
 * attempt handed back.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-research-floor-'));
let ctx: AppContext;

beforeAll(async () => {
  ctx = await createContext(tmp);
  ctx.config.research.agent = 'codex-cli';
}, 60_000);

afterAll(async () => {
  await ctx.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const until = async (check: () => Promise<boolean>, ms = 10_000, what = 'the condition') => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('research under the quota floor', () => {
  it('pauses the claimed job and every job on the same account until the window resets', async () => {
    const reset = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const held: QuotaHold = { reason: 'Codex weekly window has 8% left, under the 10% floor', until: reset };
    const asked: PlanUser[] = [];
    const { job: first } = await queueJob(ctx.store, { kind: 'entity', target: 'CATL', requestedBy: 'test' });
    const { job: second } = await queueJob(ctx.store, { kind: 'entity', target: 'BYD', requestedBy: 'test' });
    const logs: string[] = [];
    const loop = startResearchLoop(ctx, {
      mcp: () => ({ url: 'http://127.0.0.1:9/mcp', token: 'test', headers: {} }),
      log: (m) => logs.push(m),
      intervalMs: 3_600_000,
      hold: async (user) => {
        asked.push(user);
        return user.provider === 'codex-cli' ? held : null;
      },
    });
    try {
      loop.kick();
      await until(async () => {
        const [a, b] = await Promise.all([getJob(ctx.store, first.id), getJob(ctx.store, second.id)]);
        return Boolean(a?.payload.pause && b?.payload.pause);
      }, 10_000, 'both jobs paused');
    } finally {
      await loop.stop();
    }
    expect(asked[0]).toMatchObject({ provider: 'codex-cli' });
    for (const id of [first.id, second.id]) {
      const job = (await getJob(ctx.store, id))!;
      expect(job.status).toBe('queued');
      expect(job.attempts).toBe(0);
      expect(job.error).toBeNull();
      expect(job.payload.pause).toMatchObject({
        kind: 'quota',
        reason: 'Codex weekly window has 8% left, under the 10% floor (processing.minQuotaPercent)',
        // a margin after the reset the reading names
        until: new Date(Date.parse(reset) + 2 * 60_000).toISOString(),
        resetKnown: true,
        count: 0,
      });
    }
    // nothing ran: no run workspace was prepared
    expect(fs.existsSync(path.join(tmp, '.runs', first.id))).toBe(false);
    expect(logs.some((m) => m.includes('waits until') && m.includes('under the 10% floor'))).toBe(true);
  });
});
