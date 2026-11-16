import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { EvalOutcome, EvalSpec } from './eval.js';
import type { EvalKind } from './kinds.js';

/**
 * Durable evaluation tasks and their results (docs/design/32 §5, stage 2).
 *
 * `serve` keeps every evaluation piece a run publishes — by the run's id and
 * the run's own key for the piece — with its state and, once it is done, its
 * result, so a run and `serve` can each restart without losing or repeating
 * work in flight:
 *
 *   <root>/.knode/eval-queue/
 *     owner.json                     the one process that holds the store (its pid and a nonce)
 *     <run>/<key>.json               the task: state, deadline, the spec while it waits
 *     <run>/<key>.result.json        its outcome, once done or stuck (a session's stdout can be megabytes)
 *
 * Every file is written whole: a temporary file renamed over it. A result is
 * written before its task's state, so a task that reads `waiting` beside a
 * result that parses is done. Leases are not kept here: after a restart a
 * leased task waits again, and its old lease is unknown.
 *
 * A store opened with no folder keeps the same records in memory: what a
 * `serve` uses when another process holds the folder (stage 1's behaviour,
 * said in its status), and what the tests of the protocol use.
 */

export type StoredState = 'waiting' | 'done' | 'stuck' | 'dropped';

export interface StoredTask {
  v: 1;
  run: string;
  key: string;
  kind: EvalKind;
  /** The producer's own scope (a hash of its run directory): `eval drop` removes only its own run's. */
  scope: string | null;
  state: StoredState;
  publishedAt: number;
  /** When the producer no longer wants it: a task still waiting then is dropped, never run. */
  deadline: number;
  finishedAt: number | null;
  collectedAt: number | null;
  /** Done by one of the run's own slots: the value lived in that run's process and is never handed to another. */
  local: boolean;
  /** Why it was dropped. */
  why: string | null;
  /** The spec while it waits; null once it is finished. */
  spec: EvalSpec | null;
  /** Bytes of its result. */
  resultBytes: number;
}

export interface EvalStoreOptions {
  /** Largest total of stored tasks and results (default 2 GiB): past it a publish is refused. */
  maxBytes?: number;
  /** How long a result nobody collected is kept (default seven days). */
  keepMs?: number;
  /** How long a result is kept after it was first collected, and a dropped task at all (default a day). */
  keepCollectedMs?: number;
  log?: (msg: string) => void;
}

export const DEFAULT_MAX_BYTES = 2 * 1024 ** 3;
const KEEP_MS = 7 * 24 * 3_600_000;
const KEEP_COLLECTED_MS = 24 * 3_600_000;
const RUN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Another process holds the store's folder. */
export class EvalStoreBusyError extends Error {
  constructor(readonly dir: string, readonly pid: number) {
    super(`the evaluation queue in ${dir} is held by process ${pid}: this one keeps its evaluation work in memory`);
  }
}

/** The store is at its bound: a publish is refused until results are collected or runs dropped. */
export class EvalStoreFullError extends Error {
  constructor(readonly bytes: number, readonly maxBytes: number) {
    super(`serve's evaluation queue holds ${mb(bytes)} of results and tasks, its limit (server.remote.evalQueueMB, ${mb(maxBytes)}): resume the runs that wait for them, or drop old ones with \`knode-os eval drop <run-dir>\``);
  }
}

const mb = (n: number) => `${(n / 1024 ** 2).toFixed(n >= 1024 ** 2 * 10 ? 0 : 1)} MB`;

/** The nonces of the stores this process holds: another object in this process is no stale owner. */
const HELD = new Set<string>();

interface Owner {
  pid: number;
  nonce: string;
  at: string;
}

function ownerAlive(o: Owner): boolean {
  if (o.pid === process.pid) return HELD.has(o.nonce);
  try {
    process.kill(o.pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function writeWhole(file: string, text: string): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.part`);
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

interface Held extends StoredTask {
  /** Bytes of the task's own file. */
  metaBytes: number;
  /** The result, for a store in memory. */
  memResult?: EvalOutcome;
}

export class EvalTaskStore {
  /** The folder, or null for a store in memory. */
  readonly dir: string | null;
  readonly maxBytes: number;
  private readonly keepMs: number;
  private readonly keepCollectedMs: number;
  private readonly log: (msg: string) => void;
  private readonly runs = new Map<string, Map<string, Held>>();
  private bytes = 0;
  private nonce: string | null = null;
  private closed = false;

  private constructor(dir: string | null, opts: EvalStoreOptions) {
    this.dir = dir;
    this.maxBytes = Math.max(1, opts.maxBytes ?? DEFAULT_MAX_BYTES);
    this.keepMs = opts.keepMs ?? KEEP_MS;
    this.keepCollectedMs = opts.keepCollectedMs ?? KEEP_COLLECTED_MS;
    this.log = opts.log ?? (() => {});
  }

  /** The folder a data root keeps its evaluation queue in. */
  static dirOf(rootDataDir: string): string {
    return path.join(rootDataDir, '.knode', 'eval-queue');
  }

  /** A store in memory: the same records, gone with the process. */
  static memory(opts: EvalStoreOptions = {}): EvalTaskStore {
    return new EvalTaskStore(null, opts);
  }

  /**
   * Open (and hold) the store in a data root. Throws `EvalStoreBusyError` when
   * a live process holds it; an owner that is gone is taken over.
   */
  static open(rootDataDir: string, opts: EvalStoreOptions = {}): EvalTaskStore {
    const dir = EvalTaskStore.dirOf(rootDataDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const store = new EvalTaskStore(dir, opts);
    store.take();
    try {
      store.load();
    } catch (err) {
      store.close();
      throw err;
    }
    return store;
  }

  get durable(): boolean {
    return this.dir !== null;
  }

  /* -------------------------------- owner -------------------------------- */

  private ownerFile(): string {
    return path.join(this.dir!, 'owner.json');
  }

  private take(): void {
    const file = this.ownerFile();
    const nonce = crypto.randomBytes(9).toString('hex');
    for (let attempt = 0; ; attempt++) {
      try {
        fs.writeFileSync(file, JSON.stringify({ pid: process.pid, nonce, at: new Date().toISOString() } satisfies Owner), { flag: 'wx', mode: 0o600 });
        this.nonce = nonce;
        HELD.add(nonce);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 2) throw err;
      }
      let owner: Owner | null = null;
      try {
        owner = JSON.parse(fs.readFileSync(file, 'utf8')) as Owner;
      } catch {
        // half written by a process that died writing it, or gone already
      }
      if (owner && typeof owner.pid === 'number' && ownerAlive(owner)) throw new EvalStoreBusyError(this.dir!, owner.pid);
      this.log(`eval queue: taking over ${file} from process ${owner?.pid ?? '?'}, which is gone`);
      fs.rmSync(file, { force: true });
    }
  }

  /** Release the folder (another process may open it). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.dir || !this.nonce) return;
    HELD.delete(this.nonce);
    try {
      const owner = JSON.parse(fs.readFileSync(this.ownerFile(), 'utf8')) as Owner;
      if (owner.nonce === this.nonce) fs.rmSync(this.ownerFile(), { force: true });
    } catch {
      // gone already
    }
  }

  /* --------------------------------- load -------------------------------- */

  private load(): void {
    const dir = this.dir!;
    let loaded = 0;
    let finished = 0;
    for (const run of fs.readdirSync(dir)) {
      const runDir = path.join(dir, run);
      if (!RUN_RE.test(run) || !fs.statSync(runDir).isDirectory()) continue;
      for (const name of fs.readdirSync(runDir)) {
        const file = path.join(runDir, name);
        // a write a process did not finish
        if (name.endsWith('.part')) {
          fs.rmSync(file, { force: true });
          continue;
        }
        if (!name.endsWith('.json') || name.endsWith('.result.json')) continue;
        const key = name.slice(0, -'.json'.length);
        if (!KEY_RE.test(key)) continue;
        let t: Held;
        try {
          t = { ...(JSON.parse(fs.readFileSync(file, 'utf8')) as StoredTask), metaBytes: fs.statSync(file).size };
        } catch (err) {
          this.log(`eval queue: ${run}/${name} does not read (${err instanceof Error ? err.message : err}): left as it is`);
          continue;
        }
        if (t.v !== 1 || t.run !== run || t.key !== key) continue;
        const resultFile = this.resultFile(run, key);
        if (fs.existsSync(resultFile)) {
          t.resultBytes = fs.statSync(resultFile).size;
          if (t.state === 'waiting') {
            // the result was written, the state not yet: it is done
            const outcome = this.readFile(resultFile);
            if (outcome) {
              t.state = outcome.outcome === 'stuck' ? 'stuck' : 'done';
              t.finishedAt ??= fs.statSync(resultFile).mtimeMs;
              t.spec = null;
              this.writeMeta(t);
              finished++;
            }
          }
        } else t.resultBytes = 0;
        this.index(t);
        loaded++;
      }
    }
    if (loaded) this.log(`eval queue: ${loaded} task(s) from ${dir}${finished ? ` (${finished} finished just before the last stop)` : ''}`);
    this.prune();
  }

  /* -------------------------------- records ------------------------------- */

  private index(t: Held): void {
    let run = this.runs.get(t.run);
    if (!run) this.runs.set(t.run, (run = new Map()));
    const had = run.get(t.key);
    if (had) this.bytes -= had.metaBytes + had.resultBytes;
    run.set(t.key, t);
    this.bytes += t.metaBytes + t.resultBytes;
  }

  private unindex(t: Held): void {
    const run = this.runs.get(t.run);
    if (!run?.delete(t.key)) return;
    this.bytes -= t.metaBytes + t.resultBytes;
    if (!run.size) this.runs.delete(t.run);
  }

  private taskFile(run: string, key: string): string {
    return path.join(this.dir!, run, `${key}.json`);
  }

  private resultFile(run: string, key: string): string {
    return path.join(this.dir!, run, `${key}.result.json`);
  }

  private readFile(file: string): EvalOutcome | null {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as EvalOutcome;
    } catch {
      return null;
    }
  }

  private writeMeta(t: Held): void {
    const { metaBytes: _m, memResult: _r, ...record } = t;
    const text = JSON.stringify(record);
    const before = t.metaBytes;
    t.metaBytes = Buffer.byteLength(text);
    if (this.runs.get(t.run)?.get(t.key) === t) this.bytes += t.metaBytes - before;
    if (!this.dir) return;
    fs.mkdirSync(path.join(this.dir, t.run), { recursive: true, mode: 0o700 });
    writeWhole(this.taskFile(t.run, t.key), text);
  }

  get(run: string, key: string): StoredTask | undefined {
    return this.runs.get(run)?.get(key);
  }

  /** Every task of a run. */
  ofRun(run: string): StoredTask[] {
    return [...(this.runs.get(run)?.values() ?? [])];
  }

  /** Every task waiting, of one kind: what a source holds again after a restart. */
  waiting(kind: EvalKind): StoredTask[] {
    return [...this.runs.values()].flatMap((r) => [...r.values()]).filter((t) => t.state === 'waiting' && t.kind === kind && t.spec);
  }

  get runIds(): string[] {
    return [...this.runs.keys()];
  }

  usage(): { tasks: number; bytes: number; maxBytes: number } {
    let tasks = 0;
    for (const r of this.runs.values()) tasks += r.size;
    return { tasks, bytes: this.bytes, maxBytes: this.maxBytes };
  }

  /**
   * Room for a new task: past the bound, results already collected go first,
   * oldest first; still past it, `EvalStoreFullError`. A result of a task out
   * now is always stored, whatever the bound: refusing it would lose the work.
   */
  ensureRoom(adding = 0): void {
    if (this.bytes + adding <= this.maxBytes) return;
    const collected = [...this.runs.values()].flatMap((r) => [...r.values()])
      .filter((t) => t.state !== 'waiting' && (t.collectedAt !== null || t.state === 'dropped'))
      .sort((a, b) => (a.collectedAt ?? a.finishedAt ?? 0) - (b.collectedAt ?? b.finishedAt ?? 0));
    for (const t of collected) {
      if (this.bytes + adding <= this.maxBytes) break;
      this.remove(t);
    }
    if (this.bytes + adding > this.maxBytes) throw new EvalStoreFullError(this.bytes, this.maxBytes);
  }

  /** A new task, or one published again (waiting once more). */
  put(spec: EvalSpec, opts: { deadline: number; scope: string | null; now?: number }): StoredTask {
    const now = opts.now ?? Date.now();
    const had = this.runs.get(spec.run)?.get(spec.key);
    if (had) this.dropResult(had);
    const t: Held = {
      v: 1, run: spec.run, key: spec.key, kind: spec.kind, scope: opts.scope ?? had?.scope ?? null, state: 'waiting',
      publishedAt: now, deadline: opts.deadline, finishedAt: null, collectedAt: null, local: false, why: null, spec, resultBytes: 0,
      metaBytes: had?.metaBytes ?? 0,
    };
    this.index(t);
    this.writeMeta(t);
    return t;
  }

  /** A waiting task's spec and deadline changed (a producer published it again with new inputs). */
  update(run: string, key: string, change: { spec?: EvalSpec; deadline?: number }): void {
    const t = this.runs.get(run)?.get(key);
    if (!t || t.state !== 'waiting') return;
    if (change.spec) t.spec = change.spec;
    if (change.deadline !== undefined) t.deadline = change.deadline;
    this.writeMeta(t);
  }

  /** It is done (or stuck): the result first, then the state. */
  finish(run: string, key: string, outcome: EvalOutcome, opts: { local?: boolean; now?: number } = {}): void {
    const t = this.runs.get(run)?.get(key);
    if (!t) return;
    const text = JSON.stringify(outcome);
    const bytes = Buffer.byteLength(text);
    if (this.dir) writeWhole(this.resultFile(run, key), text);
    else t.memResult = outcome;
    this.bytes += bytes - t.resultBytes;
    t.resultBytes = bytes;
    t.state = outcome.outcome === 'stuck' ? 'stuck' : 'done';
    t.finishedAt = opts.now ?? Date.now();
    t.local = opts.local === true;
    t.spec = null;
    this.writeMeta(t);
  }

  /** It is no longer wanted: a deadline passed, the run was cancelled or dropped. */
  drop(run: string, key: string, why: string, now = Date.now()): void {
    const t = this.runs.get(run)?.get(key);
    if (!t || t.state !== 'waiting') return;
    t.state = 'dropped';
    t.why = why;
    t.finishedAt = now;
    t.spec = null;
    this.writeMeta(t);
  }

  /** A task's result, read when it is collected. */
  result(run: string, key: string): EvalOutcome | null {
    const t = this.runs.get(run)?.get(key);
    if (!t || (t.state !== 'done' && t.state !== 'stuck')) return null;
    if (!this.dir) return t.memResult ?? null;
    return this.readFile(this.resultFile(run, key));
  }

  /** The producer has it (it may ask again: it is kept a while after). */
  collected(run: string, key: string, now = Date.now()): void {
    const t = this.runs.get(run)?.get(key);
    if (!t || t.collectedAt !== null) return;
    t.collectedAt = now;
    this.writeMeta(t);
  }

  private dropResult(t: Held): void {
    if (!t.resultBytes) return;
    if (this.dir) fs.rmSync(this.resultFile(t.run, t.key), { force: true });
    t.memResult = undefined;
    this.bytes -= t.resultBytes;
    t.resultBytes = 0;
  }

  private remove(t: Held): void {
    this.unindex(t);
    if (!this.dir) return;
    fs.rmSync(this.resultFile(t.run, t.key), { force: true });
    fs.rmSync(this.taskFile(t.run, t.key), { force: true });
    try {
      fs.rmdirSync(path.join(this.dir, t.run));
    } catch {
      // other tasks of the run are still there
    }
  }

  /** Every task of a run (of one scope, when given) removed, its results with it. Returns how many. */
  removeRun(run: string, scope?: string | null): number {
    let n = 0;
    for (const t of this.ofRun(run) as Held[]) {
      if (scope && t.scope && t.scope !== scope) continue;
      this.remove(t);
      n++;
    }
    return n;
  }

  /**
   * Results and finished tasks by age: a result nobody collected after seven
   * days, one collected after a day, a dropped task after a day. Waiting tasks
   * stay until their deadline (their source drops them then).
   */
  prune(now = Date.now()): number {
    let n = 0;
    for (const run of [...this.runs.values()]) {
      for (const t of [...run.values()]) {
        if (t.state === 'waiting') continue;
        const old = t.state === 'dropped' ? now - (t.finishedAt ?? 0) > this.keepCollectedMs
          : t.collectedAt !== null ? now - t.collectedAt > this.keepCollectedMs
            : now - (t.finishedAt ?? 0) > this.keepMs;
        if (!old) continue;
        this.remove(t);
        n++;
      }
    }
    if (n) this.log(`eval queue: pruned ${n} finished task(s)`);
    return n;
  }
}

/**
 * Drop a run's tasks from a data root's store while no `serve` holds it
 * (`eval drop` with `serve` stopped). Returns how many, or null when a live
 * `serve` holds the store (ask it instead).
 */
export function dropStoredRun(rootDataDir: string, run: string, scope?: string | null): number | null {
  if (!fs.existsSync(path.join(EvalTaskStore.dirOf(rootDataDir), run))) return 0;
  let store: EvalTaskStore;
  try {
    store = EvalTaskStore.open(rootDataDir);
  } catch (err) {
    if (err instanceof EvalStoreBusyError) return null;
    throw err;
  }
  try {
    return store.removeRun(run, scope);
  } finally {
    store.close();
  }
}
