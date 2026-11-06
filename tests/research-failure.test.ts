import { describe, expect, it } from 'vitest';
import { agentKey, classifyFailure, pauseFor, PAUSE, pausingFailure, resetTimeFrom, RunPause } from '../src/research/failure.js';
import { codexFailure } from '../src/research/launch.js';

/**
 * What a failed research session means for its job (docs/design/22): a spent
 * usage limit, a rate limit or a lost login pause it — until the time the
 * agent named, where it named one — and anything else is an ordinary failure.
 */

// 23:20 in Shanghai, 07:20 in Los Angeles
const now = new Date('2026-11-03T15:20:00Z');

describe('classifying a failed session', () => {
  it('reads each agent\'s usage limit as a quota, with the time it resets', () => {
    const claude = classifyFailure("claude: You've hit your 5-hour limit · resets 1:30am (Asia/Shanghai)", now);
    expect(claude.kind).toBe('quota');
    expect(claude.resetAt?.toISOString()).toBe('2026-11-03T17:30:00.000Z');
    expect(classifyFailure("claude: You've hit your weekly limit · resets Nov 7, 9am (America/Los_Angeles)", now).resetAt?.toISOString()).toBe('2026-11-07T17:00:00.000Z');
    expect(classifyFailure('Claude AI usage limit reached|1762200000', now).resetAt?.toISOString()).toBe('2025-11-03T20:00:00.000Z');
    const codex = classifyFailure("codex exec exited with code 1: ERROR: You've hit your usage limit. Upgrade to Pro or try again in 2 days 3 hours 5 minutes.", now);
    expect(codex.kind).toBe('quota');
    expect(codex.resetAt?.toISOString()).toBe('2026-11-05T18:25:00.000Z');
    expect(classifyFailure('cursor: You are out of usage for this billing cycle', now)).toEqual({ kind: 'quota', message: 'cursor: You are out of usage for this billing cycle', resetAt: null });
    expect(classifyFailure('openai: 429 insufficient_quota', now).kind).toBe('quota');
  });

  it('tells a passing refusal and a broken setup from a run that did not do the work', () => {
    expect(classifyFailure('claude: API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}', now).kind).toBe('transient');
    expect(classifyFailure('claude: API Error: 529 Overloaded', now).kind).toBe('transient');
    expect(classifyFailure('codex exec exited with code 1: stream disconnected before completion', now).kind).toBe('transient');
    expect(classifyFailure('claude: Invalid API key · Please run /login', now).kind).toBe('setup');
    expect(classifyFailure('claude CLI not found — install it or set cliPath for the research agent', now).kind).toBe('setup');
    expect(classifyFailure('claude: error_max_turns', now).kind).toBe('other');
    expect(classifyFailure('claude exited with code 1: ', now).kind).toBe('other');
    // the first session error that pauses wins; ordinary ones are passed over
    expect(pausingFailure(['claude: error_max_turns', null, "claude: You've hit your 5-hour limit · resets 1:30am (Asia/Shanghai)"], now)?.kind).toBe('quota');
    expect(pausingFailure(['claude: error_max_turns', undefined], now)).toBeNull();
  });

  it('reads clock times in their zone (or this machine\'s), the next time the clock shows them', () => {
    expect(resetTimeFrom('resets 12am', now, 'Asia/Shanghai')?.toISOString()).toBe('2026-11-03T16:00:00.000Z');
    expect(resetTimeFrom('resets 11:45pm', now, 'Asia/Shanghai')?.toISOString()).toBe('2026-11-03T15:45:00.000Z');
    expect(resetTimeFrom('resets 11:15pm', now, 'Asia/Shanghai')?.toISOString()).toBe('2026-11-04T15:15:00.000Z');
    expect(resetTimeFrom("You've hit your usage limit. Try again at 3:04 PM.", now, 'Asia/Shanghai')?.toISOString()).toBe('2026-11-04T07:04:00.000Z');
    expect(resetTimeFrom('retry after 30 seconds', now)?.toISOString()).toBe('2026-11-03T15:20:30.000Z');
    expect(resetTimeFrom('Retry-After: 120', now)?.toISOString()).toBe('2026-11-03T15:22:00.000Z');
    expect(resetTimeFrom('the limit resets 5', now)).toBeNull();
    expect(resetTimeFrom('usage limit', now)).toBeNull();
  });

  it('finds codex\'s reason at the end of its stderr, past the banner and the echoed prompt', () => {
    const stderr = ['OpenAI Codex v0.55.0 (research preview)', '--------', 'workdir: /tmp/x', 'user', '# 收集资料：「额度」 rate limit quota …', "[2026-11-03T15:20:00] ERROR: You've hit your usage limit. Try again in 4 hours 12 minutes."].join('\n');
    expect(codexFailure(stderr, '')).toBe("[2026-11-03T15:20:00] ERROR: You've hit your usage limit. Try again in 4 hours 12 minutes.");
    expect(codexFailure('banner\nsomething went wrong at the end', '')).toBe('banner\nsomething went wrong at the end');
  });
});

describe('pausing', () => {
  const quota = classifyFailure("claude: You've hit your 5-hour limit · resets 1:30am (Asia/Shanghai)", now);

  it('waits until the named reset and a margin, else a backoff that doubles with each pause in a row', () => {
    const first = pauseFor(quota, null, 'claude-cli', now)!;
    expect(first).toMatchObject({ kind: 'quota', until: '2026-11-03T17:32:00.000Z', count: 1, agent: 'claude-cli', resetKnown: true, since: now.toISOString() });
    const unnamed = classifyFailure('cursor: out of usage', now);
    const a = pauseFor(unnamed, null, 'cursor-cli', now)!;
    expect(Date.parse(a.until) - now.getTime()).toBe(PAUSE.quotaBaseMs);
    const b = pauseFor(unnamed, a, 'cursor-cli', now)!;
    expect(b.count).toBe(2);
    expect(b.since).toBe(a.since);
    expect(Date.parse(b.until) - now.getTime()).toBe(2 * PAUSE.quotaBaseMs);
    // a reset in the past (an old epoch) is no reset: the backoff stands in
    const stale = pauseFor(classifyFailure('Claude AI usage limit reached|1762200000', now), null, 'claude-cli', now)!;
    expect(stale.resetKnown).toBe(false);
  });

  it('stops pausing after too many in a row, and never pauses an ordinary failure', () => {
    const transient = classifyFailure('claude: API Error: 529 Overloaded', now);
    let prev: RunPause | null = null;
    for (let i = 0; i < PAUSE.limit.transient; i++) prev = pauseFor(transient, prev, 'claude-cli', now);
    expect(prev?.count).toBe(PAUSE.limit.transient);
    expect(Date.parse(prev!.until) - now.getTime()).toBeLessThanOrEqual(PAUSE.transientMaxMs);
    expect(pauseFor(transient, prev, 'claude-cli', now)).toBeNull();
    expect(pauseFor(classifyFailure('claude: error_max_turns', now), null, 'claude-cli', now)).toBeNull();
  });

  it('keys a limit by the CLI login it belongs to, not the model', () => {
    expect(agentKey({ kind: 'cli', provider: 'claude-cli', cliPath: '', model: 'claude-opus-5-5' })).toBe(agentKey({ kind: 'cli', provider: 'claude-cli', cliPath: '', model: 'claude-sonnet-5-5' }));
    expect(agentKey({ kind: 'cli', provider: 'claude-cli', cliPath: '/opt/claude', model: '' })).toBe('claude-cli:/opt/claude');
  });
});
