import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { CODEX_SERVICES_OFF, resolveExecutable } from '../llm/cli.js';
import { ANY_MODEL, catalogArgs, withCodexCatalog } from '../llm/codex-catalog.js';

/**
 * Codex's own account of a plan's limits, and what a task would take of them
 * (docs/design/18).
 *
 * A ChatGPT-login Codex meters use in windows — a week, on some plans five
 * hours as well — and says how far each is used. Three readings meet here:
 *
 * - live: `codex app-server` answers `account/rateLimits/read` (each window's
 *   used percent and reset, the plan, the credits that take over past a limit)
 *   and `account/usage/read` (the account's tokens per day), with no model
 *   call;
 * - history: every session Codex keeps under ~/.codex/sessions records the
 *   windows as they stood at each turn, and knode keeps its own live reads;
 * - calibration: over a window's life, how many percent the account's tokens
 *   moved it. Tokens are weighted the way API prices weigh them — a cached
 *   input token at a tenth, an output token at eight — with the mix this
 *   machine's sessions show, so that a task with another mix converts: its
 *   share is its weighted tokens times percent per weighted token.
 *
 * The account's tokens count every machine and every cloud task; one
 * machine's sessions do not (on the Mac mini they held a tenth on 2026-10-27),
 * and measured against those alone every task would look ten times dearer.
 * Over five weekly windows of 2026-10 the account's rate held within ±12%.
 */

export interface TokenTotals {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

export const emptyTotals = (): TokenTotals => ({ input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 });

/**
 * How API prices weigh tokens against a fresh input token, and so — assumed —
 * how a plan's meter does: OpenAI prices a cached input token at a tenth of a
 * fresh one, an output token (reasoning included) at eight times, and writes
 * to the cache at nothing extra.
 */
export const CODEX_WEIGHTS = { cached: 0.1, cacheWrite: 1, output: 8 } as const;

export function weightedTokens(t: TokenTotals, w: { cached: number; cacheWrite: number; output: number } = CODEX_WEIGHTS): number {
  const fresh = Math.max(0, t.input - t.cached - t.cacheWrite);
  return fresh + t.cached * w.cached + t.cacheWrite * w.cacheWrite + t.output * w.output;
}

export interface CodexWindow {
  /** The window's length in minutes: 300 is five hours, 10080 a week. */
  minutes: number;
  usedPercent: number;
  resetsAt: string | null;
}

export interface CodexAccount {
  readAt: string;
  plan: string | null;
  windows: CodexWindow[];
  /** What takes over once a window is used up. */
  credits: { hasCredits: boolean; unlimited: boolean; balance: number | null } | null;
  /** Set while a limit is reached: `rate_limit_reached`, `workspace_member_credits_depleted`, … */
  limitReached: string | null;
  /** The account's tokens per day, oldest first (empty when the read failed). */
  daily: { date: string; tokens: number }[];
}

/** One reading of one window: when, how far used, and which life of the window (its reset). */
export interface LimitSnapshot {
  at: number;
  minutes: number;
  /** Unix seconds; one value per life of the window, give or take a second. */
  resetsAt: number;
  usedPercent: number;
}

/* ---------------------------- live account read ---------------------------- */

const ACCOUNT_TTL_MS = 60_000;
const accountCache = new Map<string, { at: number; value: Promise<CodexAccount> }>();

/**
 * Read the account through `codex app-server`, at most once a minute per
 * executable. Plugins, apps and analytics are off for it as for a one-shot
 * call (src/llm/cli.ts): reading two numbers must not download a plugin
 * catalog. Nor Codex's model catalog: the app-server downloads all 650 KB of
 * it as it starts, and was killed mid-download once the account answered (at
 * about 2.4 s; the catalog finished at 4.3 s, measured 2026-11-06). Any local
 * copy of this binary's catalog serves (src/llm/codex-catalog.ts), since a
 * read names no model; with one, the read took ↓19 KB and fetched no catalog.
 */
export function readCodexAccount(command = 'codex', opts: { timeoutMs?: number; fresh?: boolean } = {}): Promise<CodexAccount> {
  const cached = accountCache.get(command);
  if (cached && !opts.fresh && Date.now() - cached.at < ACCOUNT_TTL_MS) return cached.value;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  // a failed read throws, with the app-server's stderr on the error
  const value = withCodexCatalog(resolveExecutable(command), ANY_MODEL, (catalog) => queryAppServer(command, timeoutMs, catalog), () => null).then((account) => {
    rememberAccount(account);
    return account;
  });
  accountCache.set(command, { at: Date.now(), value });
  value.catch(() => accountCache.delete(command));
  return value;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function queryAppServer(command: string, timeoutMs: number, catalog: string | null): Promise<CodexAccount> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['app-server', ...CODEX_SERVICES_OFF, ...catalogArgs(catalog)], {
      cwd: os.tmpdir(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const answers = new Map<number, Json>();
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`codex app-server did not answer within ${Math.round(timeoutMs / 1000)}s`))), timeoutMs);
    const send = (message: Json) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on('error', (err: NodeJS.ErrnoException) => finish(() => reject(err.code === 'ENOENT' ? new Error(`${command} not found`) : err)));
    child.on('close', (code) => finish(() => reject(Object.assign(
      new Error(`codex app-server exited (${code}) before answering${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ''}`),
      { stderr },
    ))));
    child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString('utf8')).slice(-2000); });
    child.stdin.on('error', () => {});
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let message: Json;
      try {
        message = JSON.parse(line) as Json;
      } catch {
        return;
      }
      const id = finite(message.id);
      if (id === null || message.method) return; // a notification, or a request of the server's
      if (id === 1) {
        if (message.error) return finish(() => reject(new Error(`codex app-server: ${String(obj(message.error).message ?? 'initialize failed')}`)));
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } });
        send({ id: 3, method: 'account/usage/read', params: null });
        return;
      }
      answers.set(id, message);
      if (answers.has(2) && answers.has(3)) finish(() => {
        const limits = answers.get(2)!;
        if (limits.error) return reject(new Error(`codex app-server: ${String(obj(limits.error).message ?? 'no rate limits')}`));
        resolve(accountFrom(obj(limits.result), obj(answers.get(3)!.result)));
      });
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'knode-os', version: '1' } } });
  });
}

/** The answers of `account/rateLimits/read` and `account/usage/read`, as an account. */
export function accountFrom(limits: Json, usage: Json, now = Date.now()): CodexAccount {
  const snapshot = obj(obj(limits.rateLimitsByLimitId).codex ?? limits.rateLimits);
  const windows: CodexWindow[] = [];
  for (const key of ['primary', 'secondary']) {
    const w = obj(snapshot[key]);
    const used = finite(w.usedPercent);
    const minutes = finite(w.windowDurationMins);
    if (used === null || minutes === null) continue;
    const resets = finite(w.resetsAt);
    windows.push({ minutes, usedPercent: used, resetsAt: resets === null ? null : new Date(resets * 1000).toISOString() });
  }
  const credits = obj(snapshot.credits);
  const balance = Number(credits.balance);
  const daily = Array.isArray(usage.dailyUsageBuckets)
    ? usage.dailyUsageBuckets.map(obj).filter((b) => typeof b.startDate === 'string' && finite(b.tokens) !== null)
        .map((b) => ({ date: String(b.startDate), tokens: Number(b.tokens) }))
    : [];
  return {
    readAt: new Date(now).toISOString(),
    plan: typeof snapshot.planType === 'string' ? snapshot.planType : null,
    windows,
    credits: 'hasCredits' in credits ? { hasCredits: credits.hasCredits === true, unlimited: credits.unlimited === true, balance: Number.isFinite(balance) ? balance : null } : null,
    limitReached: typeof snapshot.rateLimitReachedType === 'string' ? snapshot.rateLimitReachedType : null,
    daily,
  };
}

/* ------------------------- knode's own live readings ------------------------ */

/** Where live reads are kept: per machine, like the embedding ledger, since the account is the machine's. */
export function codexLimitsHistoryPath(): string {
  return process.env.KNODE_CODEX_LIMITS_FILE || path.join(os.homedir(), '.knode-os', 'codex-limits.json');
}

const HISTORY_MAX = 3000;
const HISTORY_DAYS = 60;

interface HistoryFile {
  version: 1;
  snapshots: LimitSnapshot[];
  /** The last account read that succeeded, for when the next one cannot be made. */
  last?: CodexAccount;
}

function readHistory(file: string): HistoryFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<HistoryFile>;
    return {
      version: 1,
      snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots.filter(isSnapshot) : [],
      ...(parsed.last && typeof parsed.last.readAt === 'string' && Array.isArray(parsed.last.windows) ? { last: parsed.last } : {}),
    };
  } catch {
    return { version: 1, snapshots: [] };
  }
}

/** Live reads kept for calibration — for an account whose only Codex use is knode's own, no session records any. */
export function readLiveSnapshots(file = codexLimitsHistoryPath()): LimitSnapshot[] {
  return readHistory(file).snapshots;
}

/**
 * The last account read that succeeded. A read can fail on a dropped
 * connection; the account's days of tokens hardly change in an hour, and a
 * window's use as of then says more than nothing.
 */
export function readRememberedAccount(file = codexLimitsHistoryPath()): CodexAccount | null {
  return readHistory(file).last ?? null;
}

function isSnapshot(s: unknown): s is LimitSnapshot {
  const v = s as LimitSnapshot;
  return Boolean(v) && [v.at, v.minutes, v.resetsAt, v.usedPercent].every((n) => typeof n === 'number' && Number.isFinite(n));
}

function rememberAccount(account: CodexAccount, file = codexLimitsHistoryPath()): void {
  const at = Date.parse(account.readAt);
  const fresh = account.windows.filter((w) => w.resetsAt).map((w) => ({ at, minutes: w.minutes, resetsAt: Math.round(Date.parse(w.resetsAt!) / 1000), usedPercent: w.usedPercent }));
  try {
    const history = readHistory(file);
    let kept = history.snapshots.filter((s) => s.at > at - HISTORY_DAYS * 86_400_000);
    const last = kept[kept.length - 1];
    // one reading in ten minutes is plenty, unless the window moved
    const same = last && at - last.at < 600_000 && fresh.every((f) => kept.some((k) => k.minutes === f.minutes && k.resetsAt === f.resetsAt && k.usedPercent === f.usedPercent));
    if (!same) kept = [...kept, ...fresh].slice(-HISTORY_MAX);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, snapshots: kept, last: account } satisfies HistoryFile), { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch {
    // calibration does without them
  }
}

/* --------------------------- the sessions on disk --------------------------- */

/** Two windows read together (a five-hour and a weekly one), to scale the short one by the long one. */
export interface PairedReading {
  at: number;
  short: { minutes: number; resetsAt: number; usedPercent: number };
  long: { minutes: number; resetsAt: number; usedPercent: number };
}

export interface RunTotals extends TokenTotals {
  sessions: number;
  /** Model requests: a `token_count` event each, the request's own usage in it. */
  requests: number;
  first: number;
  last: number;
}

export interface SessionScan {
  /** The first and last reading of each window life in each session. */
  snapshots: LimitSnapshot[];
  pairs: PairedReading[];
  /** Every turn of this machine's sessions in the lookback, added up: the mix tokens are weighted with. */
  mix: TokenTotals;
  /** This machine's raw tokens per UTC day, for when the account's cannot be read. */
  daily: Map<string, number>;
  /** Sessions by working directory: a research run's folder holds one or more. */
  byCwd: Map<string, RunTotals>;
  files: number;
}

interface FileScan {
  cwd: string | null;
  snapshots: LimitSnapshot[];
  pairs: PairedReading[];
  totals: TokenTotals;
  requests: number;
  daily: Record<string, number>;
  first: number;
  last: number;
}

const fileCache = new Map<string, { mtimeMs: number; size: number; scan: FileScan }>();

/**
 * Read the session files modified since `sinceMs`, each once until it
 * changes. Line by line and asynchronously: 160 MB of a month's sessions must
 * not hold the server's event loop.
 */
export async function scanCodexSessions(dir: string, opts: { sinceMs: number; maxFiles?: number }): Promise<SessionScan> {
  const files = listSessionFiles(dir, opts.sinceMs).slice(0, opts.maxFiles ?? 2000);
  const out: SessionScan = { snapshots: [], pairs: [], mix: emptyTotals(), daily: new Map(), byCwd: new Map(), files: files.length };
  for (const f of files) {
    let scan = fileCache.get(f.path);
    if (!scan || scan.mtimeMs !== f.mtimeMs || scan.size !== f.size) {
      try {
        scan = { mtimeMs: f.mtimeMs, size: f.size, scan: await scanFile(f.path) };
      } catch {
        continue;
      }
      fileCache.set(f.path, scan);
    }
    const s = scan.scan;
    out.snapshots.push(...s.snapshots);
    out.pairs.push(...s.pairs);
    addTotals(out.mix, s.totals);
    for (const [day, n] of Object.entries(s.daily)) out.daily.set(day, (out.daily.get(day) ?? 0) + n);
    if (s.cwd && s.first) {
      const run = out.byCwd.get(s.cwd) ?? { ...emptyTotals(), sessions: 0, requests: 0, first: s.first, last: s.last };
      addTotals(run, s.totals);
      run.sessions++;
      run.requests += s.requests;
      run.first = Math.min(run.first, s.first);
      run.last = Math.max(run.last, s.last);
      out.byCwd.set(s.cwd, run);
    }
  }
  return out;
}

function addTotals(into: TokenTotals, t: TokenTotals): void {
  into.input += t.input;
  into.cached += t.cached;
  into.cacheWrite += t.cacheWrite;
  into.output += t.output;
  into.reasoning += t.reasoning;
}

function listSessionFiles(dir: string, sinceMs: number): { path: string; mtimeMs: number; size: number }[] {
  const out: { path: string; mtimeMs: number; size: number }[] = [];
  const walk = (d: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs >= sinceMs) out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          // gone meanwhile
        }
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function scanFile(file: string): Promise<FileScan> {
  const out: FileScan = { cwd: null, snapshots: [], pairs: [], totals: emptyTotals(), requests: 0, daily: {}, first: 0, last: 0 };
  // per window life, the first and last reading of this session; per pair of lives, likewise
  const ends = new Map<string, [LimitSnapshot, LimitSnapshot]>();
  const pairEnds = new Map<string, [PairedReading, PairedReading]>();
  const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    const meta = !out.cwd && line.includes('"session_meta"');
    if (!meta && !line.includes('"token_count"')) continue;
    let event: Json;
    try {
      event = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    const payload = obj(event.payload);
    if (meta && event.type === 'session_meta') {
      if (typeof payload.cwd === 'string') out.cwd = payload.cwd;
      continue;
    }
    if (payload.type !== 'token_count') continue;
    const at = Date.parse(String(event.timestamp ?? ''));
    if (!Number.isFinite(at)) continue;
    const last = obj(obj(payload.info).last_token_usage);
    const input = finite(last.input_tokens) ?? 0;
    const output = finite(last.output_tokens) ?? 0;
    if (input || output) {
      out.requests++;
      out.totals.input += input;
      out.totals.cached += finite(last.cached_input_tokens) ?? 0;
      out.totals.cacheWrite += finite(last.cache_write_input_tokens) ?? 0;
      out.totals.output += output;
      out.totals.reasoning += finite(last.reasoning_output_tokens) ?? 0;
      const day = new Date(at).toISOString().slice(0, 10);
      out.daily[day] = (out.daily[day] ?? 0) + input + output;
      out.first ||= at;
      out.last = at;
    }
    const limits = obj(payload.rate_limits);
    const read: LimitSnapshot[] = [];
    for (const key of ['primary', 'secondary']) {
      const w = obj(limits[key]);
      const used = finite(w.used_percent);
      const minutes = finite(w.window_minutes);
      const resets = finite(w.resets_at);
      if (used === null || minutes === null || resets === null) continue;
      const s = { at, minutes, resetsAt: resets, usedPercent: used };
      read.push(s);
      const key2 = `${minutes}:${Math.round(resets / 600)}`;
      const seen = ends.get(key2);
      ends.set(key2, seen ? [seen[0], s] : [s, s]);
    }
    if (read.length === 2) {
      const [short, long] = read[0].minutes <= read[1].minutes ? read : [read[1], read[0]];
      const p: PairedReading = { at, short: { ...short }, long: { ...long } };
      const key2 = `${Math.round(short.resetsAt / 600)}:${Math.round(long.resetsAt / 600)}`;
      const seen = pairEnds.get(key2);
      pairEnds.set(key2, seen ? [seen[0], p] : [p, p]);
    }
  }
  for (const [a, b] of ends.values()) out.snapshots.push(a, ...(b === a ? [] : [b]));
  for (const [a, b] of pairEnds.values()) out.pairs.push(a, ...(b === a ? [] : [b]));
  return out;
}

/* ------------------------------- calibration ------------------------------- */

export interface WindowRate {
  minutes: number;
  /** Percent of the window per million weighted tokens; `low`–`high` is the spread between the window lives it came from. */
  percentPerMillion: number;
  low: number;
  high: number;
  /**
   * What the window lives were measured against: the account's tokens; only
   * this machine's sessions (an upper bound: use elsewhere moved the window
   * too); or, for a short window, the long one's rate scaled by how the two
   * moved together.
   */
  basis: 'account' | 'local' | 'scaled';
  lives: number;
}

export interface CodexCalibration {
  rates: WindowRate[];
  /** Weighted tokens per raw token in this machine's mix — what converts the account's raw tokens. */
  weightPerToken: number;
  mix: TokenTotals;
}

/** A window life counts once it ran this long and moved this far: shorter ones are mostly rounding. */
const MIN_SPAN_MS = 18 * 3_600_000;
const MIN_MOVE = 3;

/**
 * Percent per million weighted tokens, for each window length the readings
 * know. Per life of a window: the first and last reading under 99% (past
 * 100% a window stops moving and credits take over), the percent between them
 * against the tokens spent between them — the account's daily totals pro-rated
 * by the hour, or this machine's when those are missing.
 */
export function calibrateCodex(input: {
  snapshots: LimitSnapshot[];
  pairs?: PairedReading[];
  accountDaily?: { date: string; tokens: number }[];
  localDaily?: Map<string, number>;
  mix: TokenTotals;
}): CodexCalibration | null {
  const raw = input.mix.input + input.mix.output;
  const weightPerToken = raw > 0 ? weightedTokens(input.mix) / raw : 0;
  if (!(weightPerToken > 0)) return null;
  const account = new Map((input.accountDaily ?? []).map((d) => [d.date, d.tokens]));
  const daily = account.size ? account : input.localDaily ?? new Map<string, number>();
  const basis: WindowRate['basis'] = account.size ? 'account' : 'local';

  const rates: WindowRate[] = [];
  for (const [minutes, lives] of windowLives(input.snapshots)) {
    let moved = 0;
    let tokens = 0;
    const each: number[] = [];
    for (const life of lives) {
      const under = life.filter((s) => s.usedPercent < 99).sort((a, b) => a.at - b.at);
      if (under.length < 2) continue;
      const first = under[0];
      const last = under[under.length - 1];
      const delta = last.usedPercent - first.usedPercent;
      if (last.at - first.at < MIN_SPAN_MS || delta < MIN_MOVE) continue;
      const spent = tokensBetween(daily, first.at, last.at);
      if (!(spent > 0)) continue;
      moved += delta;
      tokens += spent;
      each.push(delta / spent);
    }
    if (!each.length) continue;
    const perWeighted = (r: number) => (r / weightPerToken) * 1e6;
    rates.push({
      minutes,
      percentPerMillion: perWeighted(moved / tokens),
      low: perWeighted(Math.min(...each)),
      high: perWeighted(Math.max(...each)),
      basis,
      lives: each.length,
    });
  }

  // a short window (five hours) through the long one: how far each moved over the same stretch
  const long = rates.sort((a, b) => b.minutes - a.minutes)[0];
  if (long && input.pairs?.length) {
    const byShort = new Map<number, { short: number; long: number }>();
    for (const [, group] of groupPairs(input.pairs)) {
      const sorted = group.filter((p) => p.short.usedPercent < 99 && p.long.usedPercent < 99).sort((a, b) => a.at - b.at);
      if (sorted.length < 2) continue;
      const a = sorted[0];
      const b = sorted[sorted.length - 1];
      if (a.long.minutes !== long.minutes) continue;
      const t = byShort.get(a.short.minutes) ?? { short: 0, long: 0 };
      t.short += b.short.usedPercent - a.short.usedPercent;
      t.long += b.long.usedPercent - a.long.usedPercent;
      byShort.set(a.short.minutes, t);
    }
    for (const [minutes, t] of byShort) {
      if (rates.some((r) => r.minutes === minutes) || t.long < MIN_MOVE || t.short <= 0) continue;
      const scale = t.short / t.long;
      rates.push({ minutes, percentPerMillion: long.percentPerMillion * scale, low: long.low * scale, high: long.high * scale, basis: 'scaled', lives: 0 });
    }
  }
  return rates.length ? { rates: rates.sort((a, b) => a.minutes - b.minutes), weightPerToken, mix: input.mix } : null;
}

/** Readings grouped by window length, then by life — resets within a quarter of an hour are one life. */
function windowLives(snapshots: LimitSnapshot[]): Map<number, LimitSnapshot[][]> {
  const out = new Map<number, LimitSnapshot[][]>();
  const sorted = [...snapshots].sort((a, b) => a.minutes - b.minutes || a.resetsAt - b.resetsAt);
  let life: LimitSnapshot[] = [];
  for (const s of sorted) {
    const prev = life[life.length - 1];
    if (prev && (prev.minutes !== s.minutes || s.resetsAt - prev.resetsAt > 900)) {
      out.set(prev.minutes, [...(out.get(prev.minutes) ?? []), life]);
      life = [];
    }
    life.push(s);
  }
  if (life.length) out.set(life[0].minutes, [...(out.get(life[0].minutes) ?? []), life]);
  return out;
}

function groupPairs(pairs: PairedReading[]): Map<string, PairedReading[]> {
  const out = new Map<string, PairedReading[]>();
  for (const p of pairs) {
    const key = `${p.short.minutes}:${Math.round(p.short.resetsAt / 900)}:${p.long.minutes}:${Math.round(p.long.resetsAt / 900)}`;
    out.set(key, [...(out.get(key) ?? []), p]);
  }
  return out;
}

/** Tokens spent between two instants, from per-day totals spread evenly over each UTC day. */
export function tokensBetween(daily: Map<string, number>, from: number, to: number): number {
  let total = 0;
  const DAY = 86_400_000;
  for (let day = Math.floor(from / DAY) * DAY; day < to; day += DAY) {
    const lo = Math.max(from, day);
    const hi = Math.min(to, day + DAY);
    if (hi > lo) total += (daily.get(new Date(day).toISOString().slice(0, 10)) ?? 0) * ((hi - lo) / DAY);
  }
  return total;
}
