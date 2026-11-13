import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, defaultRoutedLlmConfig, KnodeConfig, LlmConnection, processingSettings } from '../src/config.js';
import { claudeLimitsFrom, lastRateLimitInfo, readClaudeLimits, recordClaudeLimits } from '../src/estimate/claude-limits.js';
import { accountFrom } from '../src/estimate/codex.js';
import { claudeResultOf, completeViaCli } from '../src/llm/cli.js';
import { CallLimiter, LocalLabelingWorkers } from '../src/labeling/local.js';
import { codexQuota, PlanQuota, PlanReadings, quotaAt, quotaHold, readPlanQuota } from '../src/labeling/plan-quota.js';
import { TaskOutcome, WorkerIdentity } from '../src/labeling/scheduler.js';
import { WorkTask } from '../src/work/broker.js';
import { WorkKind } from '../src/work/kinds.js';
import { startFakeOpenAi, type FakeOpenAi } from './helpers/fake-openai.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-local-processing-'));
process.env.KNODE_CLAUDE_LIMITS_FILE = path.join(tmp, 'claude-limits.json');
process.env.KNODE_CODEX_LIMITS_FILE = path.join(tmp, 'codex-limits.json');

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const until = async (check: () => boolean, ms = 10_000, what = 'the condition') => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A leaser with `supply` tasks of each kind, counting how many calls run at once. */
class FakeLeaser {
  readonly leased: { worker: string; kind: WorkKind }[] = [];
  readonly completed: { id: string; outcome: TaskOutcome }[] = [];
  private n = 0;
  constructor(public supply: Partial<Record<WorkKind, number>>) {}
  async lease(who: WorkerIdentity, kinds: readonly WorkKind[]): Promise<WorkTask[]> {
    for (const kind of kinds) {
      if ((this.supply[kind] ?? 0) <= 0) continue;
      this.supply[kind]!--;
      this.leased.push({ worker: who.worker, kind });
      const id = `${kind}-${++this.n}`;
      return [{ id, kind, label: id, messages: [{ role: 'user', content: `task ${id}` }], prompt: '', json: false, maxTokens: 10, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } as WorkTask];
    }
    return [];
  }
  async complete(id: string, _who: WorkerIdentity, outcome: TaskOutcome) {
    this.completed.push({ id, outcome });
    return { accepted: true };
  }
  renew() {
    return { renewed: [], lost: [] };
  }
}

/** Every stage on one fake endpoint, with the slot counts given; or on a CLI stub. */
function configWith(endpoint: LlmConnection, opts: { slots?: number; processing?: Partial<KnodeConfig['processing']> } = {}): KnodeConfig {
  const base = defaultConfig();
  const route = { ...defaultRoutedLlmConfig(), use: endpoint.id };
  const slots = opts.slots ?? 3;
  return {
    ...base,
    connections: endpoint.provider.endsWith('-cli') ? base.connections : [endpoint],
    agentLlms: endpoint.provider.endsWith('-cli') ? [endpoint] : [],
    llmUse: endpoint.id,
    extraction: {
      ...base.extraction, entityLlm: route, summaryLlm: route, judgeLlm: route, translateLlm: route,
      workers: [{ use: endpoint.id, slots }], summaryConcurrency: slots, translateConcurrency: slots,
    },
    languages: { ...base.languages, enabled: true, primary: 'zh' },
    review: { ...base.review, concurrency: slots },
    processing: { ...processingSettings(base), ...opts.processing },
  };
}

describe('the processing settings', () => {
  it('default to two calls at once and a 20% floor', () => {
    expect(processingSettings(defaultConfig())).toEqual({ maxLocalCalls: 2, minQuotaPercent: 20 });
    // a config from before the section, or with a value that is no count
    expect(processingSettings({})).toEqual({ maxLocalCalls: 2, minQuotaPercent: 20 });
    // an old file's `autoStart` is read past: processing starts with the service everywhere
    expect(processingSettings({ processing: { autoStart: true, maxLocalCalls: -1, minQuotaPercent: 250 } as never })).toEqual({ maxLocalCalls: 2, minQuotaPercent: 100 });
  });
});

describe('the call limiter', () => {
  it('lets `capacity` through and serves judge calls ahead of the rest in line', async () => {
    const limiter = new CallLimiter();
    limiter.setCapacity(2);
    expect(await limiter.acquire()).toBe(true);
    expect(await limiter.acquire()).toBe(true);
    const order: string[] = [];
    const a = limiter.acquire().then((ok) => order.push(`extract:${ok}`));
    const b = limiter.acquire().then((ok) => order.push(`summarize:${ok}`));
    const j = limiter.acquire(true).then((ok) => order.push(`judge:${ok}`));
    expect(limiter.inUse).toBe(2);
    limiter.release();
    await j;
    expect(order).toEqual(['judge:true']);
    limiter.release();
    await a;
    // stopping turns the rest away
    limiter.cancel();
    await b;
    expect(order).toEqual(['judge:true', 'extract:true', 'summarize:false']);
  });

  it('turns away only the waiters of the owner that stops, and counts each owner\'s calls', async () => {
    const limiter = new CallLimiter();
    limiter.setCapacity(1);
    const finance = {};
    const shelf = {};
    expect(await limiter.acquire(false, finance)).toBe(true);
    const order: string[] = [];
    const a = limiter.acquire(false, shelf).then((ok) => order.push(`shelf:${ok}`));
    const b = limiter.acquire(false, finance).then((ok) => order.push(`finance:${ok}`));
    const j = limiter.acquire(true, shelf).then((ok) => order.push(`shelf judge:${ok}`));
    expect([limiter.inUseBy(finance), limiter.inUseBy(shelf)]).toEqual([1, 0]);
    // finance stops: its own waiter is turned away, shelf's keep their place
    limiter.cancel(finance);
    await b;
    expect(order).toEqual(['finance:false']);
    limiter.release(finance);
    await j;
    expect(order).toEqual(['finance:false', 'shelf judge:true']);
    expect([limiter.inUse, limiter.inUseBy(finance), limiter.inUseBy(shelf)]).toEqual([1, 0, 1]);
    limiter.release(shelf);
    await a;
    expect(order).toEqual(['finance:false', 'shelf judge:true', 'shelf:true']);
    limiter.release(shelf);
    expect(limiter.inUse).toBe(0);
  });

  it('counts without a cap at 0, and lets more through when the cap is raised', async () => {
    const limiter = new CallLimiter();
    for (let i = 0; i < 5; i++) expect(await limiter.acquire()).toBe(true);
    expect(limiter.inUse).toBe(5);
    for (let i = 0; i < 5; i++) limiter.release();
    limiter.setCapacity(1);
    await limiter.acquire();
    let second = false;
    void limiter.acquire().then(() => { second = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(second).toBe(false);
    limiter.setCapacity(2);
    await until(() => second, 1000, 'the raised cap');
  });
});

describe('this machine\'s slots under the processing limits', () => {
  let fake: FakeOpenAi;
  let inFlight = 0;
  let peak = 0;

  beforeAll(async () => {
    fake = await startFakeOpenAi({
      delayMs: 40,
      answer: () => {
        // the fake answers after its delay; count from the request's arrival
        return 'ok';
      },
    });
  });
  afterAll(async () => fake?.close());

  const endpoint = (): LlmConnection => ({
    id: 'connection-1', label: 'fake', provider: 'openai', baseUrl: fake.url, apiKey: 'sk-test',
    protocol: 'chat', model: 'fake-model', cliPath: '', effort: 'default', cliTimeoutMs: 30_000,
  });

  it('run at most `maxLocalCalls` calls at once across extraction, summaries, translations and reviews', async () => {
    const config = configWith(endpoint(), { slots: 3, processing: { maxLocalCalls: 2 } });
    const leaser = new FakeLeaser({ extract: 6, summarize: 6, translate: 6, judge: 4 });
    // wrap the leaser to see how many leased calls are out at once
    const counting = {
      lease: async (who: WorkerIdentity, kinds: readonly WorkKind[]) => {
        const tasks = await leaser.lease(who, kinds);
        if (tasks.length) {
          inFlight++;
          peak = Math.max(peak, inFlight);
        }
        return tasks;
      },
      complete: async (id: string, who: WorkerIdentity, outcome: TaskOutcome) => {
        inFlight--;
        return leaser.complete(id, who, outcome);
      },
      renew: () => leaser.renew(),
    };
    const workers = new LocalLabelingWorkers(counting, () => config, { idleMs: 20 });
    workers.start();
    try {
      await until(() => leaser.completed.length === 22, 20_000, 'every task');
      // four stages × three slots, but never more than two calls out
      expect(workers.status().map((b) => [b.id, b.slots])).toEqual([['connection-1', 3], ['summarize', 3], ['judge', 3], ['translate', 3]]);
      expect(peak).toBe(2);
      expect(leaser.completed.every((c) => c.outcome.ok)).toBe(true);
      expect(new Set(leaser.leased.map((l) => l.kind))).toEqual(new Set(['extract', 'summarize', 'translate', 'judge']));
    } finally {
      workers.stop();
    }
  });

  it('share one cap across workspaces, and a workspace that stops leaves the other\'s slots running', async () => {
    const config = configWith(endpoint(), { slots: 3, processing: { maxLocalCalls: 3 } });
    const limiter = new CallLimiter();
    let out = 0;
    let most = 0;
    const counting = (leaser: FakeLeaser) => ({
      lease: async (who: WorkerIdentity, kinds: readonly WorkKind[]) => {
        const tasks = await leaser.lease(who, kinds);
        if (tasks.length) most = Math.max(most, ++out);
        return tasks;
      },
      complete: async (id: string, who: WorkerIdentity, outcome: TaskOutcome) => {
        out--;
        return leaser.complete(id, who, outcome);
      },
      renew: () => leaser.renew(),
    });
    const financeWork = new FakeLeaser({ extract: 8, summarize: 8 });
    const shelfWork = new FakeLeaser({ extract: 8, summarize: 8 });
    const finance = new LocalLabelingWorkers(counting(financeWork), () => config, { idleMs: 20, limiter });
    const shelf = new LocalLabelingWorkers(counting(shelfWork), () => config, { idleMs: 20, limiter });
    finance.start();
    shelf.start();
    try {
      await until(() => financeWork.completed.length >= 2 && shelfWork.completed.length >= 2, 10_000, 'both workspaces at work');
      // twelve slots in each workspace, three calls on the machine
      expect(finance.calls().max).toBe(3);
      expect(finance.calls().inFlight).toBe(limiter.inUse);
      finance.stop();
      await until(() => shelfWork.completed.length === 16, 20_000, 'shelf after finance stopped');
      expect(most).toBe(3);
      expect(finance.calls().workspace).toBe(0);
    } finally {
      finance.stop();
      shelf.stop();
    }
  });

  it('leave a plan under the quota floor alone, and take work again once it is over it', async () => {
    // a Claude CLI stand-in: one result event, nothing about its plan
    const stub = path.join(tmp, 'claude-ok.sh');
    fs.writeFileSync(stub, `#!/bin/sh\ncat > /dev/null\necho '{"type":"result","is_error":false,"result":"ok"}'\n`, { mode: 0o755 });
    const claude: LlmConnection = { id: 'claude', label: 'Claude', provider: 'claude-cli', baseUrl: '', apiKey: '', protocol: 'auto', model: '', cliPath: stub, effort: 'default', cliTimeoutMs: 30_000 };
    const config = configWith(claude, { slots: 1, processing: { maxLocalCalls: 2, minQuotaPercent: 20 } });
    // a window still open whenever this runs: one whose reset has passed counts as reset, and holds nothing
    const resets = new Date(Date.now() + 86_400_000).toISOString();
    let reading: PlanQuota = { plan: 'Claude', windows: [{ name: 'weekly', leftPercent: 12, resetsAt: resets }], limitReached: null, readAt: new Date().toISOString() };
    const reads: string[] = [];
    const leaser = new FakeLeaser({ summarize: 2 });
    const logs: string[] = [];
    const workers = new LocalLabelingWorkers(leaser, () => config, {
      idleMs: 20, quotaCheckMs: 30, log: (m) => logs.push(m),
      readQuota: async (provider, command) => {
        reads.push(`${provider} ${command}`);
        return reading;
      },
    });
    workers.start();
    try {
      await until(() => workers.quotaHolds().length === 4, 5_000, 'every stage held');
      await new Promise((r) => setTimeout(r, 100));
      expect(leaser.leased).toEqual([]);
      expect(reads[0]).toBe(`claude-cli ${stub}`);
      const [summary] = workers.status().filter((b) => b.id === 'summarize');
      // shown as a rest until the window resets, with the reason
      expect(summary.pausedUntil).toBe(resets);
      expect(summary.pauseReason).toBe('Claude weekly window has 12% left, under the 20% floor');
      expect(workers.heldForQuota('judge')).toBe(true);
      expect(logs.some((l) => l.includes('takes no new work: Claude weekly window has 12% left'))).toBe(true);

      // the window reset: work again
      reading = { ...reading, windows: [{ name: 'weekly', leftPercent: 95, resetsAt: new Date(Date.now() + 7 * 86_400_000).toISOString() }] };
      await until(() => leaser.completed.length === 2, 5_000, 'the summaries after the reset');
      expect(workers.quotaHolds()).toEqual([]);
      expect(workers.heldForQuota('judge')).toBe(false);
      expect(logs.some((l) => l.includes('takes work again'))).toBe(true);
    } finally {
      workers.stop();
    }
  });

  it('read a plan once for every workspace that shares the readings', async () => {
    const stub = path.join(tmp, 'claude-shared.sh');
    fs.writeFileSync(stub, `#!/bin/sh\ncat > /dev/null\necho '{"type":"result","is_error":false,"result":"ok"}'\n`, { mode: 0o755 });
    const claude: LlmConnection = { id: 'claude', label: 'Claude', provider: 'claude-cli', baseUrl: '', apiKey: '', protocol: 'auto', model: '', cliPath: stub, effort: 'default', cliTimeoutMs: 30_000 };
    const config = configWith(claude, { slots: 1, processing: { maxLocalCalls: 2, minQuotaPercent: 10 } });
    let reads = 0;
    const plans = new PlanReadings({
      checkMs: 60_000,
      read: async () => {
        reads++;
        return { plan: 'Claude', windows: [{ name: 'weekly', leftPercent: 8, resetsAt: new Date(Date.now() + 86_400_000).toISOString() }], limitReached: null, readAt: new Date().toISOString() };
      },
    });
    const a = new LocalLabelingWorkers(new FakeLeaser({ extract: 1 }), () => config, { idleMs: 20, plans });
    const b = new LocalLabelingWorkers(new FakeLeaser({ extract: 1 }), () => config, { idleMs: 20, plans });
    a.start();
    b.start();
    try {
      await until(() => a.quotaHolds().length === 4 && b.quotaHolds().length === 4, 5_000, 'both held');
      expect(reads).toBe(1);
      expect(b.quotaHolds()[0].reason).toBe('Claude weekly window has 8% left, under the 10% floor');
    } finally {
      a.stop();
      b.stop();
    }
  });

  it('never hold a backend without a plan reading, nor any with the floor at 0', async () => {
    const reads: string[] = [];
    const readQuota = async (provider: string) => {
      reads.push(provider);
      return { plan: 'Codex', windows: [{ name: 'weekly', leftPercent: 1, resetsAt: null }], limitReached: null, readAt: '' };
    };
    // an API endpoint: no plan to read
    const api = configWith(endpoint(), { slots: 1 });
    const leaser = new FakeLeaser({ extract: 1 });
    const workers = new LocalLabelingWorkers(leaser, () => api, { idleMs: 20, quotaCheckMs: 30, readQuota });
    workers.start();
    try {
      await until(() => leaser.completed.length === 1, 5_000, 'the call on an API endpoint');
      expect(reads).toEqual([]);
    } finally {
      workers.stop();
    }
  });
});

describe('a plan\'s quota', () => {
  const now = Date.parse('2026-11-07T15:00:00Z');

  it('reads Codex windows as percent left, forgetting a window that reset since', () => {
    const account = accountFrom({
      rateLimits: {
        planType: 'pro',
        primary: { usedPercent: 83, windowDurationMins: 10_080, resetsAt: Date.parse('2026-11-13T06:38:16Z') / 1000 },
        secondary: { usedPercent: 99, windowDurationMins: 300, resetsAt: Date.parse('2026-11-07T14:00:00Z') / 1000 },
      },
    }, {}, now - 3_600_000);
    const quota = codexQuota(account, now);
    expect(quota.windows).toEqual([{ name: 'weekly', leftPercent: 17, resetsAt: '2026-11-13T06:38:16.000Z' }]);
    expect(quotaHold(quota, 20)).toEqual({ reason: 'Codex weekly window has 17% left, under the 20% floor', until: '2026-11-13T06:38:16.000Z' });
    expect(quotaHold(quota, 15)).toBeNull();
    expect(quotaHold(quota, 0)).toBeNull();
  });

  it('forgets, in a reading kept for a while, a window or a limit whose reset has passed', () => {
    const quota: PlanQuota = {
      plan: 'Codex',
      windows: [
        { name: 'five-hour', leftPercent: 3, resetsAt: '2026-11-07T14:00:00.000Z' },
        { name: 'weekly', leftPercent: 40, resetsAt: '2026-11-13T00:00:00.000Z' },
      ],
      limitReached: 'five-hour',
      limitResetsAt: '2026-11-07T14:00:00.000Z',
      readAt: '',
    };
    expect(quotaHold(quotaAt(quota, Date.parse('2026-11-07T13:00:00Z')), 10)?.reason).toBe('Codex limit reached (five-hour)');
    const later = quotaAt(quota, Date.parse('2026-11-07T15:00:00Z'));
    expect(later?.windows.map((w) => w.name)).toEqual(['weekly']);
    expect(quotaHold(later, 10)).toBeNull();
  });

  it('holds until every short window resets, and while a limit is reached', () => {
    const quota: PlanQuota = {
      plan: 'Claude',
      windows: [
        { name: 'five-hour', leftPercent: 5, resetsAt: '2026-11-07T17:00:00.000Z' },
        { name: 'weekly', leftPercent: 18, resetsAt: '2026-11-10T00:00:00.000Z' },
      ],
      limitReached: null,
      readAt: '',
    };
    expect(quotaHold(quota, 20)).toEqual({ reason: 'Claude five-hour window has 5% left, under the 20% floor', until: '2026-11-10T00:00:00.000Z' });
    expect(quotaHold({ ...quota, windows: [], limitReached: 'five-hour', limitResetsAt: '2026-11-07T17:00:00.000Z' }, 20))
      .toEqual({ reason: 'Claude limit reached (five-hour)', until: '2026-11-07T17:00:00.000Z' });
    expect(quotaHold(null, 20)).toBeNull();
  });

  it('keeps the Claude CLI\'s last rate-limit reading and reads it as a plan', async () => {
    // as a research run's transcript has it (2026-11-04)
    const event = {
      status: 'allowed', resetsAt: 1793777400, rateLimitType: 'five_hour', overageStatus: 'rejected', isUsingOverage: false,
      unifiedWindows: { five_hour: { utilization: 0.27, resetsAt: 1793777400, status: 'allowed' }, seven_day: { utilization: 0.86, resetsAt: 1793829600, status: 'allowed' } },
    };
    const before = Date.parse('2026-11-04T07:00:00Z');
    expect(claudeLimitsFrom(event, before)?.windows.map((w) => [w.name, w.utilization])).toEqual([['five_hour', 0.27], ['seven_day', 0.86]]);
    recordClaudeLimits(event, undefined, before);
    expect(readClaudeLimits()?.readAt).toBe('2026-11-04T07:00:00.000Z');
    const quota = await readPlanQuota('claude-cli', 'claude', before);
    expect(quota?.windows).toEqual([
      { name: 'five-hour', leftPercent: 73, resetsAt: new Date(1793777400 * 1000).toISOString() },
      { name: 'weekly', leftPercent: 14, resetsAt: new Date(1793829600 * 1000).toISOString() },
    ]);
    expect(quotaHold(quota, 20)?.reason).toBe('Claude weekly window has 14% left, under the 20% floor');
    // once both windows have reset, the reading says nothing more
    const after = (1793829600 + 60) * 1000;
    expect(quotaHold(await readPlanQuota('claude-cli', 'claude', after), 20)).toBeNull();
    // an older CLI says only the limiting window; a refused one is a reached limit
    expect(claudeLimitsFrom({ status: 'rejected', resetsAt: 1793777400, rateLimitType: 'five_hour', utilization: 1 })?.windows).toEqual([
      { name: 'five_hour', utilization: 1, resetsAt: 1793777400, status: 'rejected' },
    ]);
    expect(claudeLimitsFrom({ status: 'allowed' })).toBeNull();
    // other providers have no reading
    expect(await readPlanQuota('cursor-cli', 'cursor-agent')).toBeNull();
    expect(await readPlanQuota('openai', '')).toBeNull();
  });
});

describe('a one-shot Claude call', () => {
  const streamOf = (...events: object[]) => events.map((e) => JSON.stringify(e)).join('\n');

  it('takes its answer from the stream\'s result event and keeps its rate-limit reading', async () => {
    const stdout = streamOf(
      { type: 'system', subtype: 'init', tools: [] },
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: 1893456000 } } } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'pong' }] } },
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.51, resetsAt: 1893456000 } } } },
      { type: 'result', subtype: 'success', is_error: false, result: 'pong', usage: { input_tokens: 3, output_tokens: 1 } },
    );
    expect(claudeResultOf(stdout)).toMatchObject({ type: 'result', result: 'pong' });
    expect(lastRateLimitInfo(stdout)).toMatchObject({ unifiedWindows: { seven_day: { utilization: 0.51 } } });
    // a CLI that printed one JSON document
    expect(claudeResultOf('{"type":"result","is_error":false,"result":"ok"}')).toMatchObject({ result: 'ok' });
    expect(claudeResultOf('plain text')).toBeNull();

    const stub = path.join(tmp, 'claude-stream.sh');
    fs.writeFileSync(stub, `#!/bin/sh\nargs="$*"\ncat > /dev/null\n[ "\${args#*--output-format stream-json --verbose}" != "$args" ] || exit 7\ncat <<'EOF'\n${stdout}\nEOF\n`, { mode: 0o755 });
    fs.rmSync(process.env.KNODE_CLAUDE_LIMITS_FILE!, { force: true });
    const out = await completeViaCli({ ...defaultConfig().llm, provider: 'claude-cli', cliPath: stub, cliTimeoutMs: 10_000 }, [{ role: 'user', content: 'ping' }]);
    expect(out).toBe('pong');
    expect(readClaudeLimits()?.windows).toEqual([{ name: 'seven_day', utilization: 0.51, resetsAt: 1893456000, status: null }]);
  });
});
