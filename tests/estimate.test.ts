import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, defaultRoutedLlmConfig, KnodeConfig, LlmConfig, LlmConnection } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { calibrateCodex, LimitSnapshot, PairedReading, scanCodexSessions, tokensBetween, weightedTokens } from '../src/estimate/codex.js';
import { costWork, perCall, RouteSpec, serviceShares, totalsOf, WorkSpec } from '../src/estimate/estimate.js';
import { formatEstimate } from '../src/estimate/format.js';
import { CallLedger, isRefusal } from '../src/estimate/ledger.js';
import { estimateProcessing } from '../src/estimate/processing.js';
import { CodexQuota, QuotaSources } from '../src/estimate/quota.js';
import { modelOfLabel, priceOf, serviceOfLabel } from '../src/estimate/services.js';
import { sync } from '../src/ingest/sync.js';
import { classifyFailure } from '../src/labeling/failures.js';
import { LocalLabelingWorkers } from '../src/labeling/local.js';
import { LabelingScheduler } from '../src/labeling/scheduler.js';
import { completeViaCli, readCursorStream } from '../src/llm/cli.js';
import { readCodexEvents, sanitizeUsage, usageFromClaudeResult, usageFromCursorResult, usageFromOpenAi } from '../src/llm/usage.js';
import { ensureDefaultAgents } from '../src/research/agents.js';
import { WorkBroker } from '../src/work/broker.js';
import { SummarySource } from '../src/work/summarize.js';
import { startFakeOpenAi, type ChatRequest, type FakeOpenAi } from './helpers/fake-openai.js';

/**
 * Estimates before a task starts (docs/design/18): what each provider says a
 * call used, the ledger that keeps it, Codex's windows calibrated against the
 * account, and the processing estimate that puts them together.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-estimate-'));
process.env.KNODE_CODEX_LIMITS_FILE = path.join(tmp, 'codex-limits.json');
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function stub(name: string, body: string): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  return file;
}

const cliConfig = (over: Partial<LlmConfig>): LlmConfig => ({
  provider: 'codex-cli', baseUrl: '', apiKey: '', model: '', cliPath: '', effort: 'default', speed: 'default', cliTimeoutMs: 10_000, ...over,
});

describe('what a provider says a call used', () => {
  it('reads Codex --json events: the turn\'s usage, and a failed turn\'s reason', () => {
    // as codex-cli 0.161 printed them on 2026-10-28
    const ok = [
      '{"type":"thread.started","thread_id":"01a18248-97f4-7970-b136-12de3c4e3269"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}',
      '{"type":"turn.completed","usage":{"input_tokens":15428,"cached_input_tokens":12032,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
    ].join('\n');
    expect(readCodexEvents(ok)).toEqual({
      usage: { inputTokens: 15428, cachedInputTokens: 12032, cacheWriteTokens: 0, outputTokens: 5, reasoningTokens: 0 },
      error: null,
      threadId: '01a18248-97f4-7970-b136-12de3c4e3269',
    });
    const failed = '{"type":"error","message":"You\'ve hit your usage limit."}\n{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit."}}';
    expect(readCodexEvents(failed)).toMatchObject({ usage: null, error: "You've hit your usage limit." });
  });

  it('adds Claude Code\'s and Cursor\'s cache reads and writes into the input they read', () => {
    expect(usageFromClaudeResult({ result: 'pong', total_cost_usd: 0.0123, usage: { input_tokens: 10, cache_creation_input_tokens: 2000, cache_read_input_tokens: 13000, output_tokens: 40 } }))
      .toEqual({ inputTokens: 15010, cachedInputTokens: 13000, cacheWriteTokens: 2000, outputTokens: 40, reasoningTokens: 0, costUsd: 0.0123 });
    // cursor-agent 2026.10.22's result event, measured 2026-10-28
    const result = { type: 'result', subtype: 'success', duration_ms: 4071, is_error: false, result: 'OK', usage: { inputTokens: 4, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 15144 } };
    expect(usageFromCursorResult(result)).toEqual({ inputTokens: 15148, cachedInputTokens: 0, cacheWriteTokens: 15144, outputTokens: 4, reasoningTokens: 0 });
    expect(readCursorStream(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } })}\n${JSON.stringify(result)}`).usage?.inputTokens).toBe(15148);
  });

  it('reads both OpenAI wires, and keeps a worker\'s report to plain numbers', () => {
    expect(usageFromOpenAi({ usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 200 } } }))
      .toMatchObject({ inputTokens: 1200, cachedInputTokens: 1000, outputTokens: 300, reasoningTokens: 200 });
    expect(usageFromOpenAi({ usage: { prompt_tokens: 20, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 5 } } }))
      .toMatchObject({ inputTokens: 20, cachedInputTokens: 5, outputTokens: 10 });
    expect(usageFromOpenAi({ choices: [] })).toBeNull();
    expect(sanitizeUsage({ inputTokens: '9', outputTokens: -3 })).toBeNull();
    expect(sanitizeUsage({ inputTokens: 100, cachedInputTokens: 500, outputTokens: 10, costUsd: 1e9 })).toEqual({ inputTokens: 100, cachedInputTokens: 100, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0, costUsd: 1000 });
  });

  it('the CLI runners hand the usage on, a failed Codex turn its reason', async () => {
    const codex = stub('codex-json.sh', `
out=""; prev=""; json=0
for a in "$@"; do [ "$prev" = "--output-last-message" ] && out="$a"; [ "$a" = "--json" ] && json=1; prev="$a"; done
cat > /dev/null
[ "$json" = 1 ] || exit 9
echo -n '{"entities":[]}' > "$out"
echo '{"type":"turn.completed","usage":{"input_tokens":16000,"cached_input_tokens":12000,"output_tokens":900,"reasoning_output_tokens":300}}'
`);
    let seen: unknown = null;
    expect(await completeViaCli(cliConfig({ cliPath: codex }), [{ role: 'user', content: 'x' }], { onUsage: (u) => { seen = u; } })).toBe('{"entities":[]}');
    expect(seen).toMatchObject({ inputTokens: 16000, cachedInputTokens: 12000, outputTokens: 900, reasoningTokens: 300 });

    const limited = stub('codex-limit.sh', `
cat > /dev/null
echo '{"type":"turn.failed","error":{"message":"You have hit your usage limit. Try again in 3 days."}}'
exit 1
`);
    await expect(completeViaCli(cliConfig({ cliPath: limited }), [{ role: 'user', content: 'x' }])).rejects.toThrow(/usage limit/);
  });
});

describe('a refusal for usage', () => {
  it('Cursor\'s "out of usage" is a limit, not a bad answer: the segment keeps its attempts', () => {
    const cursor = "cursor CLI error: ActionRequiredError: Increase limits for faster responses You're out of usage. Switch to Auto, or ask your admin to increase your limit to continue.";
    expect(classifyFailure(cursor)).toBe('transient');
    expect(isRefusal(cursor)).toBe(true);
    expect(isRefusal('connection reset by peer')).toBe(false);
  });

  it('Claude\'s "hit your weekly limit" is a limit too', () => {
    const claude = "claude CLI error: You've hit your weekly limit · resets 6am (Asia/Shanghai)";
    expect(classifyFailure(claude)).toBe('transient');
    expect(isRefusal(claude)).toBe(true);
  });
});

describe('the call ledger', () => {
  it('keeps per route what answered calls took, and reads it back after a restart', () => {
    const file = path.join(tmp, 'ledger', 'usage.json');
    const ledger = new CallLedger(file, { flushMs: 60_000 });
    for (let i = 0; i < 4; i++) {
      ledger.record({ kind: 'extract', route: 'codex-cli:gpt-x', remote: false, ok: true, ms: 60_000 + i * 1000, promptTokens: 3000, replyTokens: 2500,
        usage: { inputTokens: 18_400, cachedInputTokens: 12_000, cacheWriteTokens: 0, outputTokens: 4000, reasoningTokens: 1200 } });
    }
    ledger.record({ kind: 'extract', route: 'codex-cli:gpt-x', remote: false, ok: false, ms: 1000, promptTokens: 3000, replyTokens: 0, error: "You've hit your usage limit", refused: true });
    ledger.flush();
    const again = new CallLedger(file).route('extract', 'codex-cli:gpt-x')!;
    expect(again).toMatchObject({ calls: 5, ok: 4, failed: 1, refused: 1, measured: { calls: 4, input: 73_600, promptTokens: 12_000 } });
    expect(again.lastRefusal?.error).toContain('usage limit');
    expect(again.ms).toHaveLength(4);

    // what Codex adds beyond the prompt is learned as a fixed part of every call
    const spec: WorkSpec = { kind: 'extract', label: 'Extraction', calls: 10, promptTokens: 6000, promptBytes: 24_000, outputTokens: 4500 };
    const call = perCall(spec, { route: 'codex-cli:gpt-x', service: 'codex', model: 'gpt-x', slots: 1, remote: false }, again);
    expect(call.basis).toMatchObject({ tokens: 'measured', time: 'measured', measuredCalls: 4 });
    expect(call.input).toBe(6000 + 15_400);
    expect(call.cached).toBe(12_000);
    expect(call.output).toBe(4000);
    expect(call.seconds.expected).toBeCloseTo(61.5, 1);
  });
});

describe('Codex\'s windows, calibrated', () => {
  const start = Date.UTC(2026, 9, 1);
  const mix = { input: 1_000_000, cached: 900_000, cacheWrite: 0, output: 10_000, reasoning: 0 };
  // weighted per raw token: (100k fresh + 90k cached-weighted + 80k output-weighted) / 1.01M
  const weightPerToken = (100_000 + 90_000 + 80_000) / 1_010_000;
  const daily = Array.from({ length: 20 }, (_, i) => ({ date: new Date(start + i * DAY).toISOString().slice(0, 10), tokens: 100_000_000 }));
  // two weekly lives: 10% a day each, read every six hours
  const life = (from: number, resetsAt: number, upTo = 80): LimitSnapshot[] => Array.from({ length: 25 }, (_, i) => ({
    at: from + i * 6 * HOUR, minutes: 10080, resetsAt, usedPercent: Math.min(100, (i * 6 * 10) / 24),
  })).filter((s) => s.usedPercent <= upTo + 25);

  it('measures percent per million weighted tokens against the account\'s days', () => {
    const snapshots = [...life(start, start / 1000 + 7 * 86_400), ...life(start + 8 * DAY, (start + 15 * DAY) / 1000)];
    const cal = calibrateCodex({ snapshots, accountDaily: daily, mix })!;
    expect(cal.weightPerToken).toBeCloseTo(weightPerToken, 6);
    const weekly = cal.rates.find((r) => r.minutes === 10080)!;
    // 10% per 100M raw tokens → 0.1% per million raw → divided by the weight per token
    expect(weekly.basis).toBe('account');
    expect(weekly.lives).toBe(2);
    expect(weekly.percentPerMillion).toBeCloseTo(0.1 / weightPerToken, 3);
    // one extraction call's share follows from it
    const call = { input: 25_000, cached: 12_000, cacheWrite: 0, output: 4_500, reasoning: 0 };
    expect((weightedTokens(call) / 1e6) * weekly.percentPerMillion).toBeCloseTo((13_000 + 1_200 + 36_000) / 1e6 * (0.1 / weightPerToken), 6);
  });

  it('leaves out a window past 99% (credits take over) and short lives, and falls back to this machine\'s sessions as an upper bound', () => {
    const capped = life(start, start / 1000 + 7 * 86_400, 200).map((s) => ({ ...s, usedPercent: Math.min(100, s.usedPercent) }));
    const short = [{ at: start + 10 * DAY, minutes: 10080, resetsAt: (start + 17 * DAY) / 1000, usedPercent: 5 }, { at: start + 10 * DAY + HOUR, minutes: 10080, resetsAt: (start + 17 * DAY) / 1000 + 1, usedPercent: 9 }];
    const account = calibrateCodex({ snapshots: [...capped, ...short], accountDaily: daily, mix })!;
    const weekly = account.rates[0];
    expect(weekly.lives).toBe(1);
    expect(weekly.percentPerMillion).toBeCloseTo(0.1 / weightPerToken, 3);

    const local = new Map(daily.map((d) => [d.date, d.tokens / 10]));
    const fallback = calibrateCodex({ snapshots: capped, localDaily: local, mix })!.rates[0];
    expect(fallback.basis).toBe('local');
    expect(fallback.percentPerMillion).toBeCloseTo(weekly.percentPerMillion * 10, 3);
  });

  it('scales a five-hour window from the weekly one by how far each moved over the same stretch', () => {
    const snapshots = life(start, start / 1000 + 7 * 86_400);
    const pairs: PairedReading[] = [0, 1].map((k) => ({
      at: start + k * 4 * HOUR,
      short: { minutes: 300, resetsAt: start / 1000 + 5 * 3600, usedPercent: k * 12 },
      long: { minutes: 10080, resetsAt: start / 1000 + 7 * 86_400, usedPercent: k * 4 },
    }));
    const cal = calibrateCodex({ snapshots, pairs, accountDaily: daily, mix })!;
    const five = cal.rates.find((r) => r.minutes === 300)!;
    expect(five.basis).toBe('scaled');
    expect(five.percentPerMillion).toBeCloseTo(cal.rates.find((r) => r.minutes === 10080)!.percentPerMillion * 3, 6);
  });

  it('spreads a day\'s tokens over its hours', () => {
    const days = new Map([['2026-10-01', 240], ['2026-10-02', 480]]);
    expect(tokensBetween(days, Date.UTC(2026, 9, 1, 18), Date.UTC(2026, 9, 2, 6))).toBeCloseTo(60 + 120, 6);
  });

  it('reads the windows, the mix and each run folder\'s tokens out of the sessions Codex keeps', async () => {
    const dir = path.join(tmp, 'sessions', '2026', '10', '28');
    fs.mkdirSync(dir, { recursive: true });
    const event = (at: number, used: number, input: number, output: number) => JSON.stringify({
      timestamp: new Date(at).toISOString(), type: 'event_msg',
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: input, cached_input_tokens: input - 1000, output_tokens: output } },
        rate_limits: { primary: { used_percent: used, window_minutes: 10080, resets_at: 1_793_774_160 }, secondary: null } },
    });
    const meta = JSON.stringify({ timestamp: new Date(start).toISOString(), type: 'session_meta', payload: { cwd: '/data/.runs/r_1', source: 'exec' } });
    fs.writeFileSync(path.join(dir, 'rollout-a.jsonl'), [meta, event(start, 10, 50_000, 500), '{"type":"response_item"}', event(start + HOUR, 11, 60_000, 700), event(start + 2 * HOUR, 12, 70_000, 900)].join('\n'));
    const scan = await scanCodexSessions(path.join(tmp, 'sessions'), { sinceMs: 0 });
    expect(scan.files).toBe(1);
    // the first and last reading of the window's life, not every one
    expect(scan.snapshots.map((s) => s.usedPercent)).toEqual([10, 12]);
    expect(scan.mix).toMatchObject({ input: 180_000, cached: 177_000, output: 2100 });
    expect(scan.byCwd.get('/data/.runs/r_1')).toMatchObject({ sessions: 1, input: 180_000, output: 2100 });
  });
});

describe('costing the work', () => {
  const spec: WorkSpec = { kind: 'extract', label: 'Extraction', calls: 100, promptTokens: 5000, promptBytes: 20_000, outputTokens: 4500 };
  const config = defaultConfig();

  it('spreads calls over routes by how many each finishes per second, and costs work no slot takes on its stage\'s route', () => {
    const codex: RouteSpec = { route: 'codex-cli:gpt-x', service: 'codex', model: 'gpt-x', slots: 3, remote: false };
    const api: RouteSpec = { route: 'gpt-4.1-mini', service: 'api', model: 'gpt-4.1-mini', slots: 1, remote: false };
    const lines = costWork(spec, [codex, api], null, config, null);
    expect(lines.reduce((n, l) => n + l.calls, 0)).toBe(100);
    const [onCodex, onApi] = lines;
    // codex: 8 s + 4500/60 = 83 s a call on 3 slots; the endpoint: 2 s + 75 s on 1
    expect(onCodex.calls / onApi.calls).toBeCloseTo((3 / 83) / (1 / 77), 0);
    expect(onCodex.seconds!.expected).toBeCloseTo(onApi.seconds!.expected, -2);
    expect(onApi.costUsd).not.toBeNull();
    expect(onCodex.costUsd).toBeNull();
    // ↓ 1.5 MB a Codex call: its own start-up traffic dwarfs the text
    expect(onCodex.bytes.down.expected).toBeGreaterThan(onCodex.calls * 1_500_000);

    const waiting = costWork(spec, [{ ...codex, slots: 0 }], null, config, codex);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ slots: 0, calls: 100, seconds: null });
    expect(totalsOf(waiting).seconds).toBeNull();
  });

  it('gives each plan its share: Codex\'s window from the calibration, Cursor\'s against its published allowance', () => {
    const lines = [
      ...costWork(spec, [{ route: 'codex-cli:gpt-x', service: 'codex', model: 'gpt-x', slots: 2, remote: false }], null, config, null),
      ...costWork({ ...spec, kind: 'summarize', label: 'Summary pages', outputTokens: 1000 }, [{ route: 'cursor-cli:claude-sonnet-5-5', service: 'cursor', model: 'claude-sonnet-5-5', slots: 1, remote: false }], null, config, null),
    ];
    const codex: CodexQuota = {
      account: { readAt: new Date().toISOString(), plan: 'pro', windows: [{ minutes: 10080, usedPercent: 40, resetsAt: '2026-11-04T06:36:00.000Z' }], credits: { hasCredits: true, unlimited: false, balance: 100 }, limitReached: null, daily: [] },
      calibration: { rates: [{ minutes: 10080, percentPerMillion: 0.6, low: 0.5, high: 0.7, basis: 'account', lives: 4 }], weightPerToken: 0.17, mix: { input: 1, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 } },
      runs: new Map(),
      error: null,
    };
    const stats = [{ kind: 'summarize', route: 'cursor-cli:claude-sonnet-5-5', lastRefusal: { at: new Date().toISOString(), error: "You're out of usage." } }] as never;
    const [codexShare, cursorShare] = serviceShares(lines, { config, codex, cursorPlan: 'Ultra', stats, showBalance: false });
    const weekly = codexShare.windows[0];
    expect(weekly).toMatchObject({ name: 'weekly', usedPercent: 40 });
    const extract = lines[0];
    const expected = (weightedTokens({ input: extract.tokens.input.expected, cached: extract.tokens.cached, cacheWrite: 0, output: extract.tokens.output.expected, reasoning: 0 }) / 1e6) * 0.6;
    expect(weekly.taskPercent!.expected).toBeCloseTo(expected, 6);
    expect(weekly.taskPercent!.low).toBeLessThan(weekly.taskPercent!.expected);
    expect(weekly.taskPercent!.high).toBeLessThan(weekly.taskPercent!.expected * 3);
    // a balance only for who may see it
    expect(codexShare.credits).toBeNull();

    expect(cursorShare.plan).toBe('Ultra');
    expect(cursorShare.costUsd).not.toBeNull();
    expect(cursorShare.windows[0]).toMatchObject({ name: 'monthly' });
    expect(cursorShare.windows[0].taskPercent!.expected).toBeCloseTo((cursorShare.costUsd!.expected / 400) * 100, 6);
    expect(cursorShare.notes.join(' ')).toMatch(/turned a call away/);
  });

  it('knows a route\'s service and model by its label, and prices only models it knows', () => {
    expect(serviceOfLabel('codex-cli:gpt-6.1-sol')).toBe('codex');
    expect(serviceOfLabel('codex:gpt-6.1-sol')).toBe('codex');
    expect(serviceOfLabel('remote:cursor:auto')).toBe('cursor');
    expect(serviceOfLabel('gpt-4.1-mini')).toBe('api');
    expect(modelOfLabel('codex:default')).toBe('');
    expect(modelOfLabel('claude-cli:opus')).toBe('opus');
    expect(priceOf('opus')?.price.output).toBe(20);
    expect(priceOf('claude-opus-4-8[effort=high]')?.price.input).toBe(5);
    expect(priceOf('gpt-5-codex')?.price.input).toBe(1.25);
    expect(priceOf('gpt-5.2')).toBeNull();
    expect(priceOf('gpt-6-sol')).toBeNull();
    expect(priceOf('gpt-6.1-sol')).toEqual({ price: { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 }, source: 'published' });
    const own = { usage: { prices: { 'gpt-6*': { input: 2, cachedInput: 0.2, output: 16 } } } } as Pick<KnodeConfig, 'usage'>;
    expect(priceOf('gpt-6.1-sol', own)).toEqual({ price: { input: 2, cachedInput: 0.2, output: 16 }, source: 'config' });
  });
});

describe('the processing estimate', () => {
  let fake: FakeOpenAi;
  let ctx: AppContext;
  const answer = (request: ChatRequest) => {
    const system = JSON.stringify(request.messages?.[0]?.content ?? '');
    if (system.includes('Summarize the document')) return 'Summary.\n\n## Key points\n\n- point';
    return JSON.stringify({ entities: [{ name: 'Acme', type: 'organization', description: 'a company', aliases: [] }], relations: [], claims: [] });
  };
  const noQuota: QuotaSources = { codex: async () => null, cursorPlan: async () => null };

  beforeAll(async () => {
    fake = await startFakeOpenAi({ answer });
    const dataDir = path.join(tmp, 'processing');
    const model: LlmConnection = {
      id: 'connection-1', label: 'fake', provider: 'openai', baseUrl: fake.url, apiKey: 'sk-test',
      protocol: 'chat', model: 'gpt-4.1-mini', cliPath: '', effort: 'default', cliTimeoutMs: 30_000,
    };
    const base = defaultConfig();
    const route = { ...defaultRoutedLlmConfig(), use: 'connection-1' };
    fs.mkdirSync(path.join(dataDir, 'raw/docs'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'knode.config.json'), JSON.stringify({
      ...base, connections: [model], llmUse: 'connection-1',
      extraction: { ...base.extraction, entityLlm: route, documentLlm: route, summaryLlm: route, judgeLlm: route, segmentChars: 1000, summaryMinChars: 0, concurrency: 2 },
      review: { ...base.review, llmJudge: 'off', claims: 'off' },
    }));
    ensureDefaultAgents(dataDir);
    fs.writeFileSync(path.join(dataDir, 'raw/docs/a.md'), '# A\n\nAcme reported a quarter.\n');
    // past LLM_WIKI_INPUT_CHARS (14,000), so its summary is written in parts and merged
    fs.writeFileSync(path.join(dataDir, 'raw/docs/long.md'), ['# Long', ...Array.from({ length: 4 }, (_, i) => `## Part ${i + 1}\n\n${'Acme builds batteries and sells them. '.repeat(120)}`)].join('\n\n'));
    ctx = await createContext(dataDir);
    await sync(ctx, {});
  });
  afterAll(async () => {
    await ctx?.store.close();
    await fake?.close();
  });

  it('counts the queue\'s segments and the summaries due, on this machine\'s slots, before anything ran', async () => {
    const e = await estimateProcessing({ store: ctx.store, config: ctx.config, ledger: null, workers: [], quota: noQuota });
    const extract = e.lines.find((l) => l.kind === 'extract')!;
    const segments = await ctx.store.query<{ n: number }>(`SELECT COALESCE(sum(segments_total), 0)::int AS n FROM extraction_queue`);
    expect(extract.calls).toBe(segments[0].n);
    expect(extract.calls).toBeGreaterThanOrEqual(3);
    expect(extract).toMatchObject({ route: 'gpt-4.1-mini', service: 'api', slots: 2, remote: false });
    expect(extract.perCall.basis).toMatchObject({ tokens: 'estimated', time: 'default' });
    // both documents are due a summary once extracted; the long one in parts and a merge
    expect(e.work[1].detail).toMatch(/0 due now · 2 more once extracted/);
    expect(e.lines.find((l) => l.kind === 'summarize')!.calls).toBeGreaterThanOrEqual(3);
    expect(e.totals.costUsd?.expected).toBeGreaterThan(0);
    expect(e.services.map((s) => s.service)).toEqual(['api']);
    expect(formatEstimate(e)).toMatch(/Extraction: 2 documents waiting/);
  });

  it('learns from the calls the broker measured: the next estimate rests on them', async () => {
    const ledger = new CallLedger(path.join(tmp, 'processing-usage.json'), { flushMs: 60_000 });
    const scheduler = new LabelingScheduler({ dataDir: ctx.dataDir, store: ctx.store, config: () => ctx.config }, { leaseMs: 30_000, priorityRefreshMs: 0 });
    const summaries = new SummarySource(ctx, {}, { leaseMs: 30_000, idleScanMs: 50 });
    const broker = new WorkBroker([scheduler, summaries], { ledger });
    const workers = new LocalLabelingWorkers(broker, () => ctx.config, { idleMs: 50 });
    workers.start();
    try {
      for (let i = 0; i < 200 && (ledger.route('extract', 'gpt-4.1-mini')?.measured.calls ?? 0) < 3; i++) await sleep(50);
    } finally {
      workers.stop();
      await broker.stop();
    }
    const measured = ledger.route('extract', 'gpt-4.1-mini')!;
    // the fake endpoint counts 20 in and 10 out for every call, and the bodies both ways
    expect(measured.measured.calls).toBeGreaterThanOrEqual(3);
    expect(measured.measured.input / measured.measured.calls).toBe(20);
    expect(measured.bytes.calls).toBe(measured.measured.calls);

    await sync(ctx, {});
    fs.appendFileSync(path.join(ctx.dataDir, 'raw/docs/a.md'), '\nAcme hired.\n');
    await sync(ctx, {});
    const e = await estimateProcessing({ store: ctx.store, config: ctx.config, ledger, workers: [], quota: noQuota });
    const extract = e.lines.find((l) => l.kind === 'extract')!;
    expect(extract.perCall.basis).toMatchObject({ tokens: 'measured', time: 'measured', transfer: 'measured' });
    expect(extract.perCall.output).toBe(10);
  });
});
