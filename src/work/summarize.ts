import crypto from 'node:crypto';
import { clearSourceSummaryFailure, readSourceSummary, readSourceSummaryFailure, recordSourceSummaryFailure, writeSourceSummary, writeSourceSummaryPart } from '../fs/sidecar.js';
import { classifyFailure, FailureKind } from '../labeling/failures.js';
import { CompleteResult, TaskOutcome, WorkerIdentity } from '../labeling/scheduler.js';
import { renderCliPrompt } from '../llm/cli.js';
import { LlmClient } from '../llm/client.js';
import { DocumentRow } from '../types.js';
import { dueSummaryDocuments, MAX_SUMMARY_ATTEMPTS, PagesContext, writeSourceSummaryPage } from '../wiki/pages.js';
import { finishSummary, pendingSteps, planSummary, stepLabel, summaryMinChars, SummaryStep, summaryStepRequest, SummaryWork } from '../wiki/summary.js';
import { noFailures, SourceStatus, WorkSource, WorkTask } from './broker.js';

/**
 * Summary pages as leased work (docs/design/12, 14).
 *
 * One per workspace in `serve`, behind the work broker (src/work/broker.ts).
 * A slot that asks for a summary gets the next call of the next document due
 * one — an indexed source no longer waiting for extraction, long enough for a
 * page, whose page is missing or dirty, the ones extracted most lately first.
 * A document that fits one call is one task; a long one is a task per
 * segment, which several workers can hold at once, and then one task that
 * merges the parts (src/wiki/summary.ts). Whoever holds a lease runs its
 * messages on its own model and hands back the text.
 *
 * A part's answer goes to the document's part cache in its sidecar, keyed by
 * the segment's text; the final answer goes to the document's summary cache,
 * keyed by the content it summarizes, and the page is then written from that
 * cache — in the reviews' turn (src/labeling/followup.ts), so a summary page
 * and a review never write at once, and without a model call of this
 * machine's. A page that cannot be written now is written from the cache
 * later; nothing a worker wrote is lost to a restart.
 *
 * Failures count as they always have: a bad answer uses one of the
 * document's three attempts on its current content, a rate limit or a lost
 * connection does not — though five of those in a row (or lapsed leases)
 * count as one, so a document no model can finish cannot circle forever.
 */

export interface SummarySourceOptions {
  /** How long a worker may hold a call before it goes back in line (renewable). */
  leaseMs?: number;
  /** Wait before a document goes out again after a bad answer (× its attempts so far). */
  modelRetryMs?: number;
  /** Wait before a document goes out again after a transient failure. */
  transientRetryMs?: number;
  /** Wait before looking again when nothing was due (an extraction written ends it early). */
  idleScanMs?: number;
}

export interface SummarySourceContext {
  /**
   * Run a page write in turn with the reviews (`FollowUp.serialize`). Absent:
   * one after another on a chain of the source's own.
   */
  serialize?: (fn: () => Promise<void>) => Promise<void>;
  log?: (msg: string) => void;
}

export interface SummaryStatus extends SourceStatus {
  /** Documents due a summary page at the last look, not counting those out or waiting to retry. */
  due: number;
  scannedAt: string | null;
  leases: { id: string; worker: string; backend: string; remote: boolean; document: string; label: string; ageSeconds: number; expiresInSeconds: number }[];
  totals: {
    calls: number;
    ok: number;
    /** Of `ok`, the answers that were one part of a long document rather than a finished summary. */
    parts: number;
    failed: Record<FailureKind, number>;
    leasesExpired: number;
    pagesWritten: number;
    stale: number;
  };
  lastHour: { calls: number; pagesWritten: number };
}

interface SummaryLease {
  id: string;
  doc: DocumentRow;
  work: SummaryWork;
  step: SummaryStep;
  /** The document and the step: a long document's parts can be out to several workers at once. */
  key: string;
  who: WorkerIdentity;
  issuedAt: number;
  expiresAt: number;
  /** Kept a while after expiry so a late answer can still land when nobody else took the call. */
  expired: boolean;
}

const DEFAULT_LEASE_MS = 15 * 60_000;
const MODEL_RETRY_MS = 30_000;
const TRANSIENT_RETRY_MS = 15_000;
const IDLE_SCAN_MS = 30_000;
const EXPIRED_GRACE_MS = 10 * 60_000;
/** Transient failures (or lapsed leases) of one document that count as one real attempt. */
const STRIKE_LIMIT = 5;
/** Documents taken from one look at what is due. */
const SCAN_SIZE = 64;
/** A look goes stale: look again after this long, even with documents left from the last one. */
const STALE_SCAN_MS = 5 * 60_000;
/** A document extracted since the last look is looked for again after at most this long. */
const PREFER_SCAN_MS = 30_000;
const RECENT_LIMIT = 500;

const stepKey = (doc: DocumentRow, step: SummaryStep): string => `${doc.path}\u0000${step.kind === 'part' ? `part:${step.sha}` : step.kind}`;
const pathOfKey = (key: string): string => key.slice(0, key.indexOf('\u0000'));

export class SummarySource implements WorkSource {
  readonly kind = 'summarize' as const;
  private readonly leases = new Map<string, SummaryLease>();
  /** Step key (document and step) → the lease that holds it. */
  private readonly held = new Map<string, string>();
  /** Document path → earliest time it may go out again after a failure. */
  private readonly notBefore = new Map<string, number>();
  /** Document path → transient failures and lapsed leases since its last counted attempt. */
  private readonly strikes = new Map<string, number>();
  /** Documents whose page write waits in line. */
  private readonly writing = new Set<string>();
  /** Documents extracted lately, newest last: they go first. */
  private readonly recent: string[] = [];
  /** Documents with calls still to hand out — the rest of a long document's parts, its merge once they are in — ahead of the last look. */
  private readonly ready: DocumentRow[] = [];
  private candidates: DocumentRow[] = [];
  private scannedAt = 0;
  private due = 0;
  /** No look before this: the last one found nothing. */
  private quietUntil = 0;
  private preferPending = false;
  private chain: Promise<unknown> = Promise.resolve();
  private ownPages: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private readonly totals: SummaryStatus['totals'] = { calls: 0, ok: 0, parts: 0, failed: noFailures(), leasesExpired: 0, pagesWritten: 0, stale: 0 };
  private readonly recentCalls: number[] = [];
  private readonly recentPages: number[] = [];
  private readonly leaseMs: number;
  private readonly modelRetryMs: number;
  private readonly transientRetryMs: number;
  private readonly idleScanMs: number;
  private readonly log: (msg: string) => void;

  /** `ctx` is read on every use: a settings save swaps its config. */
  constructor(private readonly ctx: PagesContext, private readonly hooks: SummarySourceContext = {}, opts: SummarySourceOptions = {}) {
    this.leaseMs = Math.max(1_000, opts.leaseMs ?? DEFAULT_LEASE_MS);
    this.modelRetryMs = opts.modelRetryMs ?? MODEL_RETRY_MS;
    this.transientRetryMs = opts.transientRetryMs ?? TRANSIENT_RETRY_MS;
    this.idleScanMs = opts.idleScanMs ?? IDLE_SCAN_MS;
    this.log = hooks.log ?? (() => {});
  }

  get leaseDurationMs(): number {
    return this.leaseMs;
  }

  holds(taskId: string): boolean {
    return this.leases.has(taskId);
  }

  /** A document's extraction was just written: its summary goes before older ones. */
  prefer(path: string): void {
    const at = this.recent.indexOf(path);
    if (at !== -1) this.recent.splice(at, 1);
    this.recent.push(path);
    if (this.recent.length > RECENT_LIMIT) this.recent.splice(0, this.recent.length - RECENT_LIMIT);
    this.quietUntil = 0;
    this.preferPending = true;
  }

  /** Up to `max` calls for `who` to run now; empty when none is due. */
  async lease(who: WorkerIdentity, max = 1): Promise<WorkTask[]> {
    if (this.stopped) return [];
    const want = Math.max(1, Math.min(8, Math.floor(max)));
    return this.locked(async () => {
      this.expireLeases();
      const out: WorkTask[] = [];
      while (out.length < want && !this.stopped) {
        const doc = await this.next();
        if (!doc) break;
        const plan = await planSummary(this.ctx.store, this.ctx.dataDir, this.ctx.config, doc);
        if (plan.kind === 'none') {
          // nothing to read: no model can help until the document changes. (A document under the
          // size threshold is not offered by the scan; one the threshold moved under since is simply not leased.)
          if (plan.reason === 'no-text') recordSourceSummaryFailure(this.ctx.dataDir, doc.path, doc.sha256, 'no source text to summarize');
          continue;
        }
        // the calls of it nobody holds: every part of a long document may be out at once
        for (const step of pendingSteps(plan).filter((s) => !this.held.has(stepKey(doc, s)))) {
          if (out.length >= want) {
            this.requeue(doc); // the rest of it goes out next
            break;
          }
          out.push(await this.issue(doc, plan, step, who));
        }
      }
      return out;
    });
  }

  /** Hand back a call's outcome. A lapsed lease is still accepted while nobody else has the call. */
  async complete(taskId: string, who: WorkerIdentity, outcome: TaskOutcome): Promise<CompleteResult> {
    return this.locked(async (): Promise<CompleteResult> => {
      const lease = this.leases.get(taskId);
      if (!lease) return { accepted: false, reason: 'unknown or long-expired lease' };
      if (lease.who.worker !== who.worker) return { accepted: false, reason: 'the lease belongs to another worker' };
      const holder = this.held.get(lease.key);
      if (lease.expired ? holder !== undefined : holder !== lease.id) {
        this.leases.delete(taskId);
        return { accepted: false, reason: lease.expired ? 'lease expired and the document moved on' : 'document no longer leased to this worker' };
      }
      this.leases.delete(taskId);
      this.held.delete(lease.key);
      await this.record(lease, who, outcome);
      return { accepted: true };
    });
  }

  renew(taskIds: string[], who: WorkerIdentity): { renewed: string[]; lost: string[] } {
    const renewed: string[] = [];
    const lost: string[] = [];
    const now = Date.now();
    for (const id of taskIds) {
      const lease = this.leases.get(id);
      if (lease && !lease.expired && lease.who.worker === who.worker) {
        lease.expiresAt = now + this.leaseMs;
        renewed.push(id);
      } else {
        lost.push(id);
      }
    }
    return { renewed, lost };
  }

  /** Give leases back unanswered (a worker shutting down): the calls go straight back in line. */
  async release(taskIds: string[], who: WorkerIdentity): Promise<number> {
    return this.locked(async () => {
      let n = 0;
      for (const id of taskIds) {
        const lease = this.leases.get(id);
        if (!lease || lease.who.worker !== who.worker) continue;
        this.leases.delete(id);
        if (this.held.get(lease.key) === id) this.held.delete(lease.key);
        this.requeue(lease.doc);
        n++;
      }
      return n;
    });
  }

  async status(): Promise<SummaryStatus> {
    const now = Date.now();
    this.trim(now);
    return {
      due: this.due,
      scannedAt: this.scannedAt ? new Date(this.scannedAt).toISOString() : null,
      leases: [...this.leases.values()].filter((l) => !l.expired).map((l) => ({
        id: l.id, worker: l.who.worker, backend: l.who.backend, remote: l.who.remote, document: l.doc.path, label: stepLabel(l.work, l.step),
        ageSeconds: Math.round((now - l.issuedAt) / 1000), expiresInSeconds: Math.round((l.expiresAt - now) / 1000),
      })),
      totals: { ...this.totals, failed: { ...this.totals.failed } },
      lastHour: { calls: this.recentCalls.length, pagesWritten: this.recentPages.length },
    };
  }

  /** Stop leasing; pages already in line are written, or written from the cache after the next start. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.locked(async () => {});
    await this.ownPages;
    this.leases.clear();
    this.held.clear();
  }

  /* ------------------------------ internals ------------------------------ */

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private trim(now: number): void {
    const hourAgo = now - 3_600_000;
    while (this.recentCalls.length && this.recentCalls[0] < hourAgo) this.recentCalls.shift();
    while (this.recentPages.length && this.recentPages[0] < hourAgo) this.recentPages.shift();
  }

  /** Documents with a call out. */
  private heldPaths(): Set<string> {
    return new Set([...this.held.keys()].map(pathOfKey));
  }

  /** A document with calls still to hand out goes before the last look's documents. */
  private requeue(doc: DocumentRow): void {
    if (!this.ready.some((d) => d.path === doc.path)) this.ready.push(doc);
    this.quietUntil = 0;
  }

  /** The next document with a call to hand out: one put back, else from the last look at what is due or a new one. */
  private async next(): Promise<DocumentRow | null> {
    const now = Date.now();
    while (this.ready.length) {
      const doc = this.ready.shift()!;
      if (this.writing.has(doc.path) || (this.notBefore.get(doc.path) ?? 0) > now) continue;
      if (await this.stillDue(doc)) return doc;
    }
    const age = now - this.scannedAt;
    if (age > STALE_SCAN_MS || (this.preferPending && age > PREFER_SCAN_MS)) this.candidates = [];
    for (let looks = 0; looks < 2; looks++) {
      while (this.candidates.length) {
        const doc = this.candidates.shift()!;
        if (this.writing.has(doc.path) || (this.notBefore.get(doc.path) ?? 0) > now) continue;
        if (await this.stillDue(doc)) return doc;
      }
      if (!(await this.scan(now))) return null;
    }
    return null;
  }

  /** Look at what is due; false when nothing is (and then not again for a while). */
  private async scan(now: number): Promise<boolean> {
    if (now < this.quietUntil) return false;
    const waiting = [...this.notBefore].filter(([, t]) => t > now);
    // a document with a call out comes back through `requeue` when that call lands
    const exclude = new Set([...this.heldPaths(), ...this.writing, ...waiting.map(([p]) => p)]);
    const { docs, due } = await dueSummaryDocuments(this.ctx.store, this.ctx.dataDir, {
      limit: SCAN_SIZE,
      prefer: [...this.recent].reverse(),
      skipQueued: true,
      exclude,
      minChars: summaryMinChars(this.ctx.config),
    });
    this.scannedAt = now;
    this.due = due;
    this.preferPending = false;
    this.candidates = docs;
    // nothing due: look again after a while, or as soon as a document waiting to retry may go
    if (docs.length === 0) this.quietUntil = Math.min(now + this.idleScanMs, ...waiting.map(([, t]) => t));
    return docs.length > 0;
  }

  /** Whether a document from an earlier look is still due as it was; a summary already cached only needs its page. */
  private async stillDue(doc: DocumentRow): Promise<boolean> {
    const [row] = await this.ctx.store.query<{ sha256: string; status: string; queued: boolean }>(
      `SELECT d.sha256, d.status, EXISTS (SELECT 1 FROM extraction_queue q WHERE q.document_id = d.id) AS queued FROM documents d WHERE d.id = $1`,
      [doc.id],
    );
    if (!row || row.status !== 'indexed' || row.sha256 !== doc.sha256 || row.queued) return false;
    if (readSourceSummary(this.ctx.dataDir, doc.path)?.contentSha === doc.sha256) {
      // summarized already — the page was not written yet, or another pass wrote the cache
      this.queuePage(doc);
      return false;
    }
    const failed = readSourceSummaryFailure(this.ctx.dataDir, doc.path);
    return !(failed && failed.contentSha === doc.sha256 && failed.attempts >= MAX_SUMMARY_ATTEMPTS);
  }

  private async issue(doc: DocumentRow, work: SummaryWork, step: SummaryStep, who: WorkerIdentity): Promise<WorkTask> {
    const request = await summaryStepRequest(work, step, this.ctx.dataDir);
    const now = Date.now();
    const lease: SummaryLease = { id: crypto.randomUUID(), doc, work, step, key: stepKey(doc, step), who, issuedAt: now, expiresAt: now + this.leaseMs, expired: false };
    this.leases.set(lease.id, lease);
    this.held.set(lease.key, lease.id);
    return {
      id: lease.id,
      kind: 'summarize',
      label: stepLabel(work, step),
      messages: request.messages,
      prompt: renderCliPrompt(request.messages, false),
      json: false,
      maxTokens: request.maxTokens,
      leaseExpiresAt: new Date(lease.expiresAt).toISOString(),
    };
  }

  private async record(lease: SummaryLease, who: WorkerIdentity, outcome: TaskOutcome): Promise<void> {
    const now = Date.now();
    const { doc, work, step } = lease;
    const model = who.remote ? `remote:${outcome.model || who.backend}` : outcome.model || who.backend;
    this.totals.calls++;
    this.recentCalls.push(now);
    let failure: { kind: FailureKind; error: string };
    if (outcome.ok) {
      const text = outcome.text.trim();
      if (text) {
        const [current] = await this.ctx.store.query<{ sha256: string; status: string }>(`SELECT sha256, status FROM documents WHERE id = $1`, [doc.id]);
        // the document changed while it was being read (its new text is due a summary of its own),
        // or a late answer comes after another worker's: either way there is nothing to write
        if (!current || current.sha256 !== doc.sha256 || current.status !== 'indexed' || readSourceSummary(this.ctx.dataDir, doc.path)?.contentSha === doc.sha256) {
          this.totals.stale++;
          return;
        }
        this.totals.ok++;
        this.notBefore.delete(doc.path);
        this.strikes.delete(doc.path);
        if (step.kind === 'part') {
          // one segment of a long document: kept by the segment's hash, so the rest of the
          // document — its other parts, then the merge — goes out next and an edit keeps this one
          writeSourceSummaryPart(this.ctx.dataDir, doc.path, step.sha, { body: text, model, generatedAt: new Date(now).toISOString() }, work.segments.map((s) => s.sha));
          this.totals.parts++;
          this.requeue(doc);
          return;
        }
        const { body, coverage } = finishSummary(work, text);
        writeSourceSummary(this.ctx.dataDir, doc.path, {
          contentSha: doc.sha256, model, body, generatedAt: new Date(now).toISOString(), language: work.language, ...(coverage ? { coverage } : {}),
        });
        this.queuePage(doc);
        return;
      }
      failure = { kind: 'model', error: 'the model answered with an empty summary' };
    } else {
      failure = { kind: outcome.kind ?? classifyFailure(outcome.error), error: outcome.error || 'failed without a message' };
    }
    this.totals.failed[failure.kind]++;
    this.fail(doc, failure, who.worker, now);
  }

  /** A failed call: a bad answer uses an attempt; five busy or broken backends in a row count as one. */
  private fail(doc: DocumentRow, failure: { kind: FailureKind; error: string }, worker: string, now: number): void {
    const strikes = (this.strikes.get(doc.path) ?? 0) + 1;
    if (failure.kind === 'model' || strikes >= STRIKE_LIMIT) {
      const failed = recordSourceSummaryFailure(this.ctx.dataDir, doc.path, doc.sha256, failure.error);
      this.strikes.delete(doc.path);
      this.notBefore.set(doc.path, now + this.modelRetryMs * failed.attempts);
      this.log(`summary failed for ${doc.path} on ${worker} (${failed.attempts}/${MAX_SUMMARY_ATTEMPTS}): ${failure.error.slice(0, 240)}`);
    } else {
      // an unreachable model is no verdict on the document: it keeps its attempts
      this.strikes.set(doc.path, strikes);
      this.notBefore.set(doc.path, now + this.transientRetryMs);
      this.log(`summary put off for ${doc.path} on ${worker} (${failure.kind}): ${failure.error.slice(0, 240)}`);
    }
  }

  private expireLeases(): void {
    const now = Date.now();
    for (const lease of [...this.leases.values()]) {
      if (lease.expired) {
        if (now - lease.expiresAt > EXPIRED_GRACE_MS) this.leases.delete(lease.id);
        continue;
      }
      if (lease.expiresAt > now) continue;
      lease.expired = true;
      this.totals.leasesExpired++;
      if (this.held.get(lease.key) !== lease.id) continue;
      this.held.delete(lease.key);
      this.fail(lease.doc, { kind: 'transient', error: `no answer from ${lease.who.worker} before its lease ran out` }, lease.who.worker, now);
    }
  }

  /** Write a document's page from its cache, in turn with the reviews; once per document at a time. */
  private queuePage(doc: DocumentRow): void {
    if (this.writing.has(doc.path)) return;
    this.writing.add(doc.path);
    const write = () => this.writePage(doc);
    const run = this.hooks.serialize ? this.hooks.serialize(write) : (this.ownPages = this.ownPages.then(write));
    void run
      .catch((err) => this.log(`summary page for ${doc.path} failed: ${err instanceof Error ? err.message : err}`))
      .finally(() => this.writing.delete(doc.path));
  }

  private async writePage(doc: DocumentRow): Promise<void> {
    const { dataDir, store } = this.ctx;
    const [current] = await store.query<DocumentRow>(`SELECT * FROM documents WHERE id = $1 AND status = 'indexed'`, [doc.id]);
    // gone, or changed since: the new text is due a summary of its own
    if (!current || readSourceSummary(dataDir, current.path)?.contentSha !== current.sha256) return;
    // from the cache only: a page written here must never call this machine's model
    const ctx: PagesContext = { ...this.ctx, summaryLlm: new LlmClient({ ...this.ctx.config.llm, provider: 'openai', model: '', loop: undefined }) };
    try {
      const { outcome, path } = await writeSourceSummaryPage(ctx, current, { actor: 'summarize' });
      if (outcome === 'regenerated' || outcome === 'unchanged') {
        clearSourceSummaryFailure(dataDir, current.path);
        if (outcome === 'regenerated') {
          this.totals.pagesWritten++;
          this.recentPages.push(Date.now());
          this.log(`summary page ${path} written`);
        }
        return;
      }
      if (outcome === 'archived') return;
      const failed = recordSourceSummaryFailure(dataDir, current.path, current.sha256, outcome === 'blocked' ? `${path} belongs to a person` : 'the summary page could not be written');
      this.log(`summary page for ${current.path} not written (${failed.attempts}/${MAX_SUMMARY_ATTEMPTS}): ${outcome}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (classifyFailure(message) !== 'transient') recordSourceSummaryFailure(dataDir, current.path, current.sha256, message);
      this.log(`summary page for ${current.path} failed: ${message}`);
    }
  }
}
