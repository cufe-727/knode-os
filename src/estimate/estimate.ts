import type { KnodeConfig } from '../config.js';
import { CODEX_WEIGHTS, TokenTotals, weightedTokens } from './codex.js';
import type { CallLedger, RouteStats } from './ledger.js';
import type { CodexQuota } from './quota.js';
import { allowancesOf, costOf, priceOf, SERVICE_LABELS, SERVICE_PROFILES, ServiceId } from './services.js';

/**
 * An estimate of what a task will take before it starts (docs/design/18):
 * its model calls, the tokens they read and write, how long they run on the
 * slots that take them, what they move over the network, what they cost at
 * API prices, and how much of each plan's window they use.
 *
 * A task builder (src/estimate/processing.ts, study.ts) says what the work is
 * — calls of a kind, the prompt knode sends each — and which routes take it
 * with how many slots. Each route's calls are then costed from what its
 * earlier calls measured (src/estimate/ledger.ts), or from its service's
 * defaults until it has run some, and the result carries which it was.
 */

export interface Range {
  low: number;
  expected: number;
  high: number;
}

export const range = (low: number, expected: number, high: number): Range => ({ low, expected, high });
const scale = (r: Range, k: number): Range => ({ low: r.low * k, expected: r.expected * k, high: r.high * k });
const add = (a: Range, b: Range): Range => ({ low: a.low + b.low, expected: a.expected + b.expected, high: a.high + b.high });
const ZERO: Range = { low: 0, expected: 0, high: 0 };

/** One kind of work, as the task builder counts it. */
export interface WorkSpec {
  kind: string;
  /** What a person calls it: "Extraction", "Summary pages". */
  label: string;
  calls: number;
  /** Tokens of the text knode itself sends per call, on average (src/llm/tokens.ts). */
  promptTokens: number;
  /** UTF-8 bytes of that text per call. */
  promptBytes: number;
  /** Output tokens per call, reasoning included, until the route's calls have been measured. */
  outputTokens: number;
}

/** A route that takes a kind of work. */
export interface RouteSpec {
  route: string;
  service: ServiceId;
  model: string;
  slots: number;
  remote: boolean;
  /** Of a slot that also takes other kinds, the part of its time this kind gets. */
  share?: number;
}

export interface PerCall {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  seconds: Range;
  bytesUp: number;
  bytesDown: number;
  /** A provider's own price for a call (Claude Code reports one), averaged over the calls that had one. */
  costUsd: number | null;
  basis: Basis;
}

export interface Basis {
  tokens: 'measured' | 'estimated';
  time: 'measured' | 'default';
  transfer: 'measured' | 'assumed';
  /** Calls of this kind on this route the averages came from. */
  measuredCalls: number;
}

export interface EstimateLine {
  kind: string;
  label: string;
  route: string;
  service: ServiceId;
  model: string;
  remote: boolean;
  slots: number;
  calls: number;
  perCall: PerCall;
  tokens: { input: Range; cached: number; cacheWrite: number; output: Range };
  /** Wall clock for this line's calls on its slots; null while no slot takes them. */
  seconds: Range | null;
  /** What the machine running the calls sends and receives. */
  bytes: { up: Range; down: Range };
  /** A remote worker's leases going out and answers coming back, on this machine's link. */
  relayBytes: { up: number; down: number };
  costUsd: Range | null;
  priceSource: 'measured' | 'published' | 'config' | null;
}

export interface QuotaWindow {
  /** "weekly", "5-hour", "monthly". */
  name: string;
  minutes: number | null;
  /** How far it is used now, where the service says. */
  usedPercent: number | null;
  resetsAt: string | null;
  /** What this task would add. */
  taskPercent: Range | null;
  basis: string;
}

export interface ServiceShare {
  service: ServiceId;
  label: string;
  plan: string | null;
  routes: string[];
  calls: number;
  tokens: { input: number; cached: number; cacheWrite: number; output: number };
  costUsd: Range | null;
  windows: QuotaWindow[];
  /** Codex only, and only for those who may see the account's balance. */
  credits: { hasCredits: boolean; unlimited: boolean; balance: number | null } | null;
  /** The service says a limit is reached, or turned this workspace's calls away lately. */
  limitReached: string | null;
  lastRefusal: { at: string; error: string } | null;
  notes: string[];
}

export interface TaskEstimate {
  task: string;
  title: string;
  at: string;
  /** What the task will do, in a person's words: a row per kind of work. */
  work: { label: string; detail: string }[];
  lines: EstimateLine[];
  totals: {
    calls: number;
    tokens: { input: Range; cached: number; output: Range };
    /** Wall clock for everything that has a slot. */
    seconds: Range | null;
    /** This machine's traffic, and the remote workers' on their own links. */
    bytes: { up: Range; down: Range; remote: Range };
    costUsd: Range | null;
    /** Routes with no known price, so `costUsd` leaves them out. */
    unpriced: string[];
  };
  services: ServiceShare[];
  notes: string[];
}

/* ------------------------------ one call ------------------------------ */

/** Below this many measured calls a route's averages are too thin to replace the defaults. */
const MIN_MEASURED = 3;

/**
 * What one call of a kind costs on a route: measured averages once the route
 * has run a few, its service's defaults until then. Tokens the provider
 * counted beyond knode's own prompt — a CLI's instructions — are learned as a
 * fixed amount per call, so a task with longer prompts scales correctly.
 */
export function perCall(spec: WorkSpec, route: RouteSpec, stats: RouteStats | null): PerCall {
  const profile = SERVICE_PROFILES[route.service];
  const m = stats?.measured;
  let input: number;
  let cached: number;
  let cacheWrite: number;
  let output: number;
  let tokens: Basis['tokens'];
  if (m && m.calls >= MIN_MEASURED) {
    const overhead = Math.max(0, (m.input - m.promptTokens) / m.calls);
    input = spec.promptTokens + overhead;
    cached = Math.min(input, m.cached / m.calls);
    cacheWrite = Math.min(input - cached, m.cacheWrite / m.calls);
    output = m.output / m.calls;
    tokens = 'measured';
  } else {
    input = spec.promptTokens + profile.promptTokens;
    cached = Math.min(input, profile.cachedTokens);
    cacheWrite = 0;
    // a route that answered without counting still shows how long its visible answers run
    const visible = stats && stats.ok >= MIN_MEASURED ? stats.replyTokens / stats.ok : 0;
    output = Math.max(spec.outputTokens, visible);
    tokens = 'estimated';
  }

  let seconds: Range;
  let time: Basis['time'];
  if (stats && stats.ok >= MIN_MEASURED && stats.ms.length) {
    const sorted = [...stats.ms].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] / 1000;
    seconds = range(at(0.25), stats.msSum / stats.ok / 1000, at(0.9));
    time = 'measured';
  } else {
    const expected = profile.startupSeconds + output / profile.tokensPerSecond;
    seconds = range(expected * 0.6, expected, expected * 2);
    time = 'default';
  }

  let bytesUp: number;
  let bytesDown: number;
  let transfer: Basis['transfer'];
  if (stats && stats.bytes.calls >= 1) {
    // an endpoint's bodies as sent and received, and headers both ways
    bytesUp = stats.bytes.up / stats.bytes.calls + profile.bytesUp;
    bytesDown = stats.bytes.down / stats.bytes.calls + profile.bytesDown;
    transfer = 'measured';
  } else {
    bytesUp = spec.promptBytes + profile.bytesUp;
    // an answer streams back as events: about four bytes of framing per token of text
    bytesDown = output * 4 + profile.bytesDown;
    transfer = profile.transferMeasured ? 'measured' : 'assumed';
  }

  const costUsd = m && m.costCalls >= MIN_MEASURED ? m.costUsd / m.costCalls : null;
  return { input, cached, cacheWrite, output, seconds, bytesUp, bytesDown, costUsd, basis: { tokens, time, transfer, measuredCalls: m?.calls ?? 0 } };
}

/** How far each figure may fall from its expected value, by what it rests on. */
const SPREAD = {
  input: { measured: [0.9, 1.15], estimated: [0.85, 1.3] },
  output: { measured: [0.8, 1.25], estimated: [0.6, 1.6] },
  bytes: { measured: [0.8, 1.3], assumed: [0.5, 3] },
} as const;

/* ------------------------------ one kind ------------------------------ */

/**
 * Cost one kind of work over the routes that take it. Every slot takes the
 * next call as soon as it is free, so calls spread over the routes by how
 * many each finishes per second. Work no slot takes is still costed — it
 * runs once one does — on `waitingOn`, the route its stage names.
 */
export function costWork(
  spec: WorkSpec,
  routes: RouteSpec[],
  ledger: Pick<CallLedger, 'route'> | null,
  config: Pick<KnodeConfig, 'usage'>,
  waitingOn: RouteSpec | null,
): EstimateLine[] {
  if (spec.calls <= 0) return [];
  const live = routes.filter((r) => r.slots > 0);
  const costed = live.map((r) => ({ route: r, call: perCall(spec, r, ledger?.route(spec.kind, r.route) ?? null) }));
  const rate = (c: { route: RouteSpec; call: PerCall }) => (c.route.slots * (c.route.share ?? 1)) / Math.max(1, c.call.seconds.expected);
  const total = costed.reduce((n, c) => n + rate(c), 0);
  if (!costed.length || !(total > 0)) {
    if (!waitingOn) return [];
    const call = perCall(spec, waitingOn, ledger?.route(spec.kind, waitingOn.route) ?? null);
    return [line(spec, { ...waitingOn, slots: 0 }, call, spec.calls, config)];
  }
  // whole calls, the remainder to the fastest route
  const shares = costed.map((c) => Math.floor((spec.calls * rate(c)) / total));
  const fastest = costed.reduce((best, c, i) => (rate(c) > rate(costed[best]) ? i : best), 0);
  shares[fastest] += spec.calls - shares.reduce((a, b) => a + b, 0);
  return costed.map((c, i) => line(spec, c.route, c.call, shares[i], config)).filter((l) => l.calls > 0);
}

function line(spec: WorkSpec, route: RouteSpec, call: PerCall, calls: number, config: Pick<KnodeConfig, 'usage'>): EstimateLine {
  const t = call.basis.tokens;
  const input = scale(range(SPREAD.input[t][0], 1, SPREAD.input[t][1]), call.input * calls);
  const output = scale(range(SPREAD.output[t][0], 1, SPREAD.output[t][1]), call.output * calls);
  const capacity = route.slots * (route.share ?? 1);
  const seconds = capacity > 0 ? scale(call.seconds, calls / capacity) : null;
  const b = SPREAD.bytes[call.basis.transfer];
  const up = scale(range(b[0], 1, b[1]), call.bytesUp * calls);
  // Codex's model catalog, where no copy is there yet: the first call of a day on each slot downloads it
  const days = seconds ? Math.max(1, Math.ceil(seconds.expected / 86_400)) : 1;
  const catalog = SERVICE_PROFILES[route.service].catalogBytes * Math.min(calls, Math.max(1, route.slots)) * days;
  const down = add(scale(range(b[0], 1, b[1]), call.bytesDown * calls), range(0, catalog, catalog));
  // a remote worker's lease carries the messages and the flattened prompt; its answer comes back
  const relayBytes = route.remote ? { up: calls * (spec.promptBytes * 2 + 2_000), down: calls * (call.output * 3 + 1_000) } : { up: 0, down: 0 };

  const tokens = { input, cached: call.cached * calls, cacheWrite: call.cacheWrite * calls, output };
  let costUsd: Range | null = null;
  let priceSource: EstimateLine['priceSource'] = null;
  if (call.costUsd !== null) {
    costUsd = scale(range(0.8, 1, 1.3), call.costUsd * calls);
    priceSource = 'measured';
  } else {
    const price = priceOf(route.model, config);
    if (price) {
      const at = (k: keyof Range) => costOf(price.price, { ...inputAt({ tokens }, k), output: output[k] });
      costUsd = range(at('low'), at('expected'), at('high'));
      priceSource = price.source;
    }
  }
  return {
    kind: spec.kind, label: spec.label, route: route.route, service: route.service, model: route.model, remote: route.remote,
    slots: route.slots, calls, perCall: call, tokens, seconds, bytes: { up, down }, relayBytes, costUsd, priceSource,
  };
}

/**
 * A line's input at one end of its range, its cached and cache-written parts
 * in the same proportion: more input than expected is more of the same mix,
 * not all of it fresh.
 */
export function inputAt(l: { tokens: { input: Range; cached: number; cacheWrite: number } }, at: keyof Range): { input: number; cached: number; cacheWrite: number } {
  const input = l.tokens.input[at];
  const k = l.tokens.input.expected > 0 ? input / l.tokens.input.expected : 0;
  return { input, cached: Math.min(input, l.tokens.cached * k), cacheWrite: l.tokens.cacheWrite * k };
}

/* ------------------------------ the whole ------------------------------ */

/**
 * Wall clock for the whole task: kinds run side by side on their own slots,
 * so it is the slowest kind's time; within a kind, the routes share the calls
 * and finish together. A stage that waits on another (`after`: summaries of
 * documents still being extracted) adds one of its calls after that one ends.
 */
export function wallClock(lines: EstimateLine[], after: Record<string, string> = {}): Range | null {
  const byKind = new Map<string, Range>();
  for (const l of lines) {
    if (!l.seconds) continue;
    const cur = byKind.get(l.kind);
    // routes of one kind finish together: their times are equal by construction, so take the largest
    byKind.set(l.kind, cur ? { low: Math.max(cur.low, l.seconds.low), expected: Math.max(cur.expected, l.seconds.expected), high: Math.max(cur.high, l.seconds.high) } : l.seconds);
  }
  if (!byKind.size) return null;
  let wall: Range = ZERO;
  for (const [kind, t] of byKind) {
    let total = t;
    const before = after[kind] ? byKind.get(after[kind]) : undefined;
    if (before) {
      const tail = lines.find((l) => l.kind === kind)?.perCall.seconds ?? ZERO;
      total = { low: Math.max(t.low, before.low + tail.low), expected: Math.max(t.expected, before.expected + tail.expected), high: Math.max(t.high, before.high + tail.high) };
    }
    wall = { low: Math.max(wall.low, total.low), expected: Math.max(wall.expected, total.expected), high: Math.max(wall.high, total.high) };
  }
  return wall;
}

export function totalsOf(lines: EstimateLine[], after: Record<string, string> = {}): TaskEstimate['totals'] {
  let input = ZERO;
  let output = ZERO;
  let up = ZERO;
  let down = ZERO;
  let remote = ZERO;
  let cost: Range | null = null;
  let cached = 0;
  let calls = 0;
  const unpriced = new Set<string>();
  for (const l of lines) {
    calls += l.calls;
    input = add(input, l.tokens.input);
    output = add(output, l.tokens.output);
    cached += l.tokens.cached;
    if (l.remote) {
      remote = add(remote, add(l.bytes.up, l.bytes.down));
      // the leases go out over this machine's link, the answers come back over it
      up = add(up, range(l.relayBytes.up * 0.9, l.relayBytes.up, l.relayBytes.up * 1.2));
      down = add(down, range(l.relayBytes.down * 0.6, l.relayBytes.down, l.relayBytes.down * 1.6));
    } else {
      up = add(up, l.bytes.up);
      down = add(down, l.bytes.down);
    }
    if (l.costUsd) cost = add(cost ?? ZERO, l.costUsd);
    else unpriced.add(l.route);
  }
  return { calls, tokens: { input, cached, output }, seconds: wallClock(lines, after), bytes: { up, down, remote }, costUsd: cost, unpriced: [...unpriced] };
}

/* ------------------------------ the plans ------------------------------ */

const windowName = (minutes: number): string =>
  minutes === 10080 ? 'weekly' : minutes === 300 ? '5-hour' : minutes % 1440 === 0 ? `${minutes / 1440}-day` : `${Math.round(minutes / 60)}-hour`;

/**
 * Each service's part of the task, against its plan where the plan can be
 * known: Codex's windows as Codex reports them, its share calibrated on the
 * account (src/estimate/codex.ts); Cursor and Claude Code against what their
 * plans include at API prices; an API key by its bill.
 */
export function serviceShares(
  lines: EstimateLine[],
  input: {
    config: Pick<KnodeConfig, 'usage'>;
    codex: CodexQuota | null;
    cursorPlan: string | null;
    /** Every route's measured totals, for the latest refusal per service. */
    stats: RouteStats[];
    /** Whether the caller may see an account's credits balance. */
    showBalance: boolean;
  },
): ServiceShare[] {
  const services = [...new Set(lines.map((l) => l.service))];
  return services.map((service) => {
    const mine = lines.filter((l) => l.service === service);
    const tokens = { input: 0, cached: 0, cacheWrite: 0, output: 0 };
    let low: TokenTotals = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };
    let high: TokenTotals = { ...low };
    let cost: Range | null = null;
    let unpriced = false;
    for (const l of mine) {
      tokens.input += l.tokens.input.expected;
      tokens.cached += l.tokens.cached;
      tokens.cacheWrite += l.tokens.cacheWrite;
      tokens.output += l.tokens.output.expected;
      const lo = inputAt(l, 'low');
      const hi = inputAt(l, 'high');
      low = { ...low, input: low.input + lo.input, cached: low.cached + lo.cached, cacheWrite: low.cacheWrite + lo.cacheWrite, output: low.output + l.tokens.output.low };
      high = { ...high, input: high.input + hi.input, cached: high.cached + hi.cached, cacheWrite: high.cacheWrite + hi.cacheWrite, output: high.output + l.tokens.output.high };
      if (l.costUsd) cost = add(cost ?? ZERO, l.costUsd);
      else unpriced = true;
    }
    const routes = [...new Set(mine.map((l) => l.route))];
    const refusals = input.stats.filter((s) => routes.includes(s.route) && s.lastRefusal).map((s) => s.lastRefusal!);
    const lastRefusal = refusals.sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
    const share: ServiceShare = {
      service, label: SERVICE_LABELS[service], plan: null, routes, calls: mine.reduce((n, l) => n + l.calls, 0),
      tokens, costUsd: unpriced ? null : cost, windows: [], credits: null, limitReached: null, lastRefusal, notes: [],
    };
    if (unpriced && cost) share.notes.push('Part of this service\'s work runs on a model with no known price; the cost covers the rest.');
    if (unpriced && !cost && service !== 'codex') share.notes.push(`No price is known for ${[...new Set(mine.map((l) => l.model || 'its default model'))].join(', ')}: add one under usage.prices in knode.config.json to see a cost${service === 'cursor' || service === 'claude' ? ' and a share of the plan' : ''}.`);

    if (service === 'codex') codexShare(share, input.codex, { ...tokens, reasoning: 0 }, low, high, input.showBalance);
    else if (service === 'cursor' || service === 'claude') {
      const plan = service === 'cursor' ? input.cursorPlan : null;
      share.plan = plan;
      for (const a of allowancesOf(service, input.config, plan)) {
        share.windows.push({
          name: a.window, minutes: null, usedPercent: null, resetsAt: null,
          taskPercent: share.costUsd ? scale(share.costUsd, 100 / a.usd) : null,
          basis: `${a.source === 'published' ? `${plan} plan's published` : 'configured'} $${a.usd} of API-priced usage per ${a.window === 'monthly' ? 'month' : a.window === 'weekly' ? 'week' : 'five hours'}; ${service === 'cursor' ? 'Cursor' : 'Claude Code'} does not report how much of it is used`,
        });
      }
      if (!share.windows.length && service === 'claude') share.notes.push('Claude Code does not report its plan\'s use: set usage.allowances.claude (fiveHourUsd, weeklyUsd) to see a share.');
    }
    if (lastRefusal) {
      const when = new Date(lastRefusal.at);
      if (Date.now() - when.getTime() < 7 * 86_400_000) share.notes.push(`${share.label} turned a call away on ${when.toISOString().slice(0, 16).replace('T', ' ')} UTC: “${lastRefusal.error.slice(0, 160)}”`);
    }
    return share;
  });
}

function codexShare(share: ServiceShare, quota: CodexQuota | null, expected: TokenTotals, low: TokenTotals, high: TokenTotals, showBalance: boolean): void {
  if (!quota) {
    share.notes.push('Codex was not found here, so its plan could not be read.');
    return;
  }
  const account = quota.account;
  share.plan = account?.plan ?? null;
  share.limitReached = account?.limitReached ?? null;
  if (showBalance) share.credits = account?.credits ?? null;
  if (quota.error && !account) share.notes.push(`Codex's limits could not be read: ${quota.error}`);
  else if (quota.error && account) share.notes.push(`Codex's limits could not be read just now (${quota.error.slice(0, 160)}); they are shown as last read, ${account.readAt.slice(0, 16).replace('T', ' ')} UTC.`);
  const windows = account?.windows.length
    ? account.windows.map((w) => ({ minutes: w.minutes, usedPercent: w.usedPercent, resetsAt: w.resetsAt }))
    : (quota.calibration?.rates ?? []).map((r) => ({ minutes: r.minutes, usedPercent: null, resetsAt: null }));
  for (const w of windows) {
    const rate = quota.calibration?.rates.find((r) => r.minutes === w.minutes);
    const name = windowName(w.minutes);
    let taskPercent: Range | null = null;
    let basis = `not calibrated yet: no ${name} window has moved far enough in the sessions this machine keeps`;
    if (rate) {
      taskPercent = range(
        (weightedTokens(low, CODEX_WEIGHTS) / 1e6) * rate.low,
        (weightedTokens(expected, CODEX_WEIGHTS) / 1e6) * rate.percentPerMillion,
        (weightedTokens(high, CODEX_WEIGHTS) / 1e6) * rate.high,
      );
      basis = rate.basis === 'account'
        ? `calibrated on ${rate.lives} ${name} window${rate.lives === 1 ? '' : 's'} against the account's tokens`
        : rate.basis === 'local'
          ? `calibrated on ${rate.lives} ${name} window${rate.lives === 1 ? '' : 's'} against this machine's sessions only — an upper bound, since use elsewhere moved them too`
          : 'scaled from the weekly window by how the two moved together';
    }
    share.windows.push({ name, minutes: w.minutes, usedPercent: w.usedPercent, resetsAt: w.resetsAt, taskPercent, basis });
    if (taskPercent && w.usedPercent !== null && w.usedPercent + taskPercent.expected > 100) {
      share.notes.push(`This would run past the ${name} limit (${Math.round(w.usedPercent)}% used now); beyond it Codex ${account?.credits?.hasCredits ? 'spends credits' : 'turns calls away until the window resets'}.`);
    }
  }
  if (windows.length) share.notes.push('Tokens are weighted as API prices weigh them (a cached input token at ×0.1, an output token at ×8) to convert them to a share of the window.');
}
