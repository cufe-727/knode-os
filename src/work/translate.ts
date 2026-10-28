import crypto from 'node:crypto';
import { KnodeConfig } from '../config.js';
import { Segment } from '../graph/segment.js';
import { contentLanguages } from '../lang/languages.js';
import {
  backfillLanguages, dueTranslations, finishSegment, MAX_TRANSLATE_ATTEMPTS, pendingSegments, planTranslation, recordTranslationState,
  segmentLabel, storeComplete, storeSegment, translationRequest, translationRow, TranslationWork,
} from '../lang/translate.js';
import { classifyFailure, FailureKind } from '../labeling/failures.js';
import { CompleteResult, TaskOutcome, WorkerIdentity } from '../labeling/scheduler.js';
import { renderCliPrompt } from '../llm/cli.js';
import { Store } from '../store/db.js';
import { DocumentRow } from '../types.js';
import { noFailures, SourceStatus, WorkSource, WorkTask } from './broker.js';

/**
 * Translations as leased work (docs/design/12, 17).
 *
 * One per workspace in `serve`, behind the work broker (src/work/broker.ts),
 * idle while the workspace has content languages off. A slot that asks for a
 * translation gets the next segment of the next document due one: a
 * translation someone asked for first, then the documents under raw/docs in
 * another language than the primary one (src/lang/translate.ts). Each
 * segment is a task of its own, so a long document's segments may be out to
 * several workers at once; whoever holds a lease runs its messages on its own
 * model and hands back the text.
 *
 * An answer is checked (every link, anchor and code span still there, about
 * as long as the text, no longer in the source language) and kept in the
 * document's sidecar by the segment's hash; once every segment is in, the
 * whole translation is written beside them. Nothing here calls a model of
 * this machine's, and nothing a worker wrote is lost to a restart.
 *
 * Failures count the way summaries' do: a bad answer uses one of the
 * document's three attempts on its current content, a rate limit or a lost
 * connection does not — though five of those in a row (or lapsed leases)
 * count as one.
 */

export interface TranslateSourceOptions {
  /** How long a worker may hold a call before it goes back in line (renewable). */
  leaseMs?: number;
  /** Wait before a document goes out again after a bad answer (× its attempts so far). */
  modelRetryMs?: number;
  /** Wait before a document goes out again after a transient failure. */
  transientRetryMs?: number;
  /** Wait before looking again when nothing was due (a request ends it early). */
  idleScanMs?: number;
}

export interface TranslateSourceContext {
  dataDir: string;
  store: Store;
  /** Read on every use: a settings save swaps it. */
  config: () => KnodeConfig;
  log?: (msg: string) => void;
}

export interface TranslateStatus extends SourceStatus {
  /** Whether the workspace has content languages on; off, nothing is handed out. */
  enabled: boolean;
  primary: string | null;
  /** Translations due at the last look (documents × languages), those with a segment out among them. */
  due: number;
  scannedAt: string | null;
  leases: { id: string; worker: string; backend: string; remote: boolean; document: string; language: string; label: string; ageSeconds: number; expiresInSeconds: number }[];
  totals: {
    calls: number;
    ok: number;
    failed: Record<FailureKind, number>;
    leasesExpired: number;
    /** Translations completed: every segment of a document in. */
    documents: number;
    stale: number;
  };
  lastHour: { calls: number; documents: number };
}

interface TranslateLease {
  id: string;
  doc: DocumentRow;
  work: TranslationWork;
  segment: Segment;
  spans: string[];
  /** The document, the language and the segment: a long document's segments can be out to several workers at once. */
  key: string;
  who: WorkerIdentity;
  issuedAt: number;
  expiresAt: number;
  /** Kept a while after expiry so a late answer can still land when nobody else took the call. */
  expired: boolean;
}

interface Due {
  doc: DocumentRow;
  target: string;
}

const DEFAULT_LEASE_MS = 15 * 60_000;
const MODEL_RETRY_MS = 30_000;
const TRANSIENT_RETRY_MS = 15_000;
const IDLE_SCAN_MS = 60_000;
const EXPIRED_GRACE_MS = 10 * 60_000;
const STRIKE_LIMIT = 5;
const SCAN_SIZE = 64;
/** Older documents whose language one look reads (schema v17 backfill). */
const BACKFILL_BATCH = 500;
const STALE_SCAN_MS = 5 * 60_000;

const docKey = (path: string, target: string) => `${path}\u0000${target}`;
const stepKey = (path: string, target: string, sha: string) => `${path}\u0000${target}\u0000${sha}`;
const docKeyOfStep = (key: string) => key.slice(0, key.lastIndexOf('\u0000'));

export class TranslateSource implements WorkSource {
  readonly kind = 'translate' as const;
  private readonly leases = new Map<string, TranslateLease>();
  /** Step key → the lease that holds it. */
  private readonly held = new Map<string, string>();
  /** Document key → earliest time it may go out again after a failure. */
  private readonly notBefore = new Map<string, number>();
  /** Document key → transient failures and lapsed leases since its last counted attempt. */
  private readonly strikes = new Map<string, number>();
  /** Documents with segments still to hand out, ahead of the last look. */
  private readonly ready: Due[] = [];
  private candidates: Due[] = [];
  private scannedAt = 0;
  private due = 0;
  private quietUntil = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private readonly totals: TranslateStatus['totals'] = { calls: 0, ok: 0, failed: noFailures(), leasesExpired: 0, documents: 0, stale: 0 };
  private readonly recentCalls: number[] = [];
  private readonly recentDocs: number[] = [];
  private readonly leaseMs: number;
  private readonly modelRetryMs: number;
  private readonly transientRetryMs: number;
  private readonly idleScanMs: number;
  private readonly log: (msg: string) => void;

  constructor(private readonly ctx: TranslateSourceContext, opts: TranslateSourceOptions = {}) {
    this.leaseMs = Math.max(1_000, opts.leaseMs ?? DEFAULT_LEASE_MS);
    this.modelRetryMs = opts.modelRetryMs ?? MODEL_RETRY_MS;
    this.transientRetryMs = opts.transientRetryMs ?? TRANSIENT_RETRY_MS;
    this.idleScanMs = opts.idleScanMs ?? IDLE_SCAN_MS;
    this.log = ctx.log ?? (() => {});
  }

  get leaseDurationMs(): number {
    return this.leaseMs;
  }

  holds(taskId: string): boolean {
    return this.leases.has(taskId);
  }

  /** Someone asked for a translation, or the settings changed: look again at the next lease. */
  wake(): void {
    this.quietUntil = 0;
    this.candidates = [];
  }

  async lease(who: WorkerIdentity, max = 1): Promise<WorkTask[]> {
    if (this.stopped || !contentLanguages(this.ctx.config()).on) return [];
    const want = Math.max(1, Math.min(8, Math.floor(max)));
    return this.locked(async () => {
      this.expireLeases();
      const out: WorkTask[] = [];
      while (out.length < want && !this.stopped) {
        const next = await this.next();
        if (!next) break;
        const plan = planTranslation(this.ctx.dataDir, next.doc, next.target);
        if (plan.kind === 'none') {
          // nothing a model can do until the document changes
          if (plan.reason !== 'no-text') await recordTranslationState(this.ctx.store, next.doc, next.target, { status: 'skipped', error: plan.reason });
          continue;
        }
        const pending = pendingSegments(plan);
        if (pending.length === 0) {
          // every segment was in already (an interrupted write): the whole translation is written from them
          storeComplete(this.ctx.dataDir, plan);
          await recordTranslationState(this.ctx.store, next.doc, next.target, { status: 'done', parts: plan.segments.length, done: plan.segments.length });
          continue;
        }
        for (const segment of pending.filter((s) => !this.held.has(stepKey(next.doc.path, next.target, s.sha)))) {
          if (out.length >= want) {
            this.requeue(next);
            break;
          }
          out.push(this.issue(next.doc, plan, segment, who));
        }
      }
      return out;
    });
  }

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

  async release(taskIds: string[], who: WorkerIdentity): Promise<number> {
    return this.locked(async () => {
      let n = 0;
      for (const id of taskIds) {
        const lease = this.leases.get(id);
        if (!lease || lease.who.worker !== who.worker) continue;
        this.leases.delete(id);
        if (this.held.get(lease.key) === id) this.held.delete(lease.key);
        this.requeue({ doc: lease.doc, target: lease.work.target });
        n++;
      }
      return n;
    });
  }

  async status(): Promise<TranslateStatus> {
    const now = Date.now();
    this.trim(now);
    const languages = contentLanguages(this.ctx.config());
    return {
      enabled: languages.on,
      primary: languages.primary,
      due: this.due,
      scannedAt: this.scannedAt ? new Date(this.scannedAt).toISOString() : null,
      leases: [...this.leases.values()].filter((l) => !l.expired).map((l) => ({
        id: l.id, worker: l.who.worker, backend: l.who.backend, remote: l.who.remote, document: l.doc.path, language: l.work.target,
        label: segmentLabel(l.work, l.segment), ageSeconds: Math.round((now - l.issuedAt) / 1000), expiresInSeconds: Math.round((l.expiresAt - now) / 1000),
      })),
      totals: { ...this.totals, failed: { ...this.totals.failed } },
      lastHour: { calls: this.recentCalls.length, documents: this.recentDocs.length },
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.locked(async () => {});
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
    while (this.recentDocs.length && this.recentDocs[0] < hourAgo) this.recentDocs.shift();
  }

  private requeue(due: Due): void {
    if (!this.ready.some((d) => d.doc.path === due.doc.path && d.target === due.target)) this.ready.push(due);
    this.quietUntil = 0;
  }

  private async next(): Promise<Due | null> {
    const now = Date.now();
    while (this.ready.length) {
      const due = this.ready.shift()!;
      if ((this.notBefore.get(docKey(due.doc.path, due.target)) ?? 0) > now) continue;
      if (await this.stillDue(due)) return due;
    }
    if (now - this.scannedAt > STALE_SCAN_MS) this.candidates = [];
    for (let looks = 0; looks < 2; looks++) {
      while (this.candidates.length) {
        const due = this.candidates.shift()!;
        if ((this.notBefore.get(docKey(due.doc.path, due.target)) ?? 0) > now) continue;
        if (await this.stillDue(due)) return due;
      }
      if (!(await this.scan(now))) return null;
    }
    return null;
  }

  private async scan(now: number): Promise<boolean> {
    if (now < this.quietUntil) return false;
    const languages = contentLanguages(this.ctx.config());
    // documents indexed before their language was recorded are read once, a batch per look
    const filled = await backfillLanguages(this.ctx.store, this.ctx.dataDir, BACKFILL_BATCH).catch((err) => {
      this.log(`translate: language backfill failed: ${err instanceof Error ? err.message : err}`);
      return 0;
    });
    const waiting = [...this.notBefore].filter(([, t]) => t > now);
    // a document with a segment out comes back through `requeue` when that call lands
    const exclude = new Set([...[...this.held.keys()].map(docKeyOfStep), ...waiting.map(([k]) => k)]);
    const { due, count } = await dueTranslations(this.ctx.store, languages, { limit: SCAN_SIZE, exclude });
    this.scannedAt = now;
    this.due = count;
    this.candidates = due.map((d) => ({ doc: d.doc, target: d.target }));
    // nothing due: look again after a while — at once while older documents still wait to have their language read
    if (due.length === 0) this.quietUntil = filled >= BACKFILL_BATCH ? now : Math.min(now + this.idleScanMs, ...waiting.map(([, t]) => t));
    return due.length > 0;
  }

  /** Whether a document from an earlier look is still due as it was. */
  private async stillDue(due: Due): Promise<boolean> {
    const [row] = await this.ctx.store.query<{ sha256: string; status: string }>(`SELECT sha256, status FROM documents WHERE id = $1`, [due.doc.id]);
    if (!row || row.status !== 'indexed' || row.sha256 !== due.doc.sha256) return false;
    const t = await translationRow(this.ctx.store, due.doc.id, due.target);
    if (!t || t.content_sha !== due.doc.sha256) return true;
    if (t.status === 'done' || t.status === 'skipped') return false;
    return !(t.status === 'failed' && t.attempts >= MAX_TRANSLATE_ATTEMPTS);
  }

  private issue(doc: DocumentRow, work: TranslationWork, segment: Segment, who: WorkerIdentity): WorkTask {
    const request = translationRequest(work, segment);
    const now = Date.now();
    const lease: TranslateLease = {
      id: crypto.randomUUID(), doc, work, segment, spans: request.spans, key: stepKey(doc.path, work.target, segment.sha),
      who, issuedAt: now, expiresAt: now + this.leaseMs, expired: false,
    };
    this.leases.set(lease.id, lease);
    this.held.set(lease.key, lease.id);
    return {
      id: lease.id,
      kind: 'translate',
      label: segmentLabel(work, segment),
      messages: request.messages,
      prompt: renderCliPrompt(request.messages, false),
      json: false,
      maxTokens: request.maxTokens,
      leaseExpiresAt: new Date(lease.expiresAt).toISOString(),
    };
  }

  private async record(lease: TranslateLease, who: WorkerIdentity, outcome: TaskOutcome): Promise<void> {
    const now = Date.now();
    const { doc, work, segment } = lease;
    const model = who.remote ? `remote:${outcome.model || who.backend}` : outcome.model || who.backend;
    this.totals.calls++;
    this.recentCalls.push(now);
    let failure: { kind: FailureKind; error: string };
    if (outcome.ok) {
      const [current] = await this.ctx.store.query<{ sha256: string; status: string }>(`SELECT sha256, status FROM documents WHERE id = $1`, [doc.id]);
      // the document changed while the segment was out: its new text is due a translation of its own
      if (!current || current.sha256 !== doc.sha256 || current.status !== 'indexed') {
        this.totals.stale++;
        return;
      }
      const finished = finishSegment(work, segment, lease.spans, outcome.text);
      if (finished.ok) {
        this.totals.ok++;
        this.notBefore.delete(docKey(doc.path, work.target));
        this.strikes.delete(docKey(doc.path, work.target));
        const stored = storeSegment(this.ctx.dataDir, work, segment, finished.body, model, new Date(now));
        await recordTranslationState(this.ctx.store, doc, work.target, {
          status: stored.complete ? 'done' : 'partial', parts: stored.parts, done: stored.done, model,
        });
        if (stored.complete) {
          this.totals.documents++;
          this.recentDocs.push(now);
          this.log(`translation of ${doc.path} into ${work.target} written (${stored.parts} part${stored.parts === 1 ? '' : 's'})`);
        } else {
          this.requeue({ doc, target: work.target });
        }
        return;
      }
      failure = { kind: 'model', error: finished.error };
    } else {
      failure = { kind: outcome.kind ?? classifyFailure(outcome.error), error: outcome.error || 'failed without a message' };
    }
    this.totals.failed[failure.kind]++;
    await this.fail(lease.doc, work, failure, who.worker, now);
  }

  private async fail(doc: DocumentRow, work: TranslationWork, failure: { kind: FailureKind; error: string }, worker: string, now: number): Promise<void> {
    const key = docKey(doc.path, work.target);
    const strikes = (this.strikes.get(key) ?? 0) + 1;
    if (failure.kind === 'model' || strikes >= STRIKE_LIMIT) {
      this.strikes.delete(key);
      const done = work.segments.filter((s) => work.cached.has(s.sha)).length;
      await recordTranslationState(this.ctx.store, doc, work.target, { status: 'failed', parts: work.segments.length, done, failed: true, error: failure.error.slice(0, 300) });
      const row = await translationRow(this.ctx.store, doc.id, work.target);
      const attempts = row?.attempts ?? 1;
      this.notBefore.set(key, now + this.modelRetryMs * attempts);
      this.log(`translation of ${doc.path} into ${work.target} failed on ${worker} (${attempts}/${MAX_TRANSLATE_ATTEMPTS}): ${failure.error.slice(0, 240)}`);
    } else {
      // an unreachable model is no verdict on the document: it keeps its attempts, and the next look finds it again
      this.strikes.set(key, strikes);
      this.notBefore.set(key, now + this.transientRetryMs);
      this.log(`translation of ${doc.path} into ${work.target} put off on ${worker} (${failure.kind}): ${failure.error.slice(0, 240)}`);
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
      void this.fail(lease.doc, lease.work, { kind: 'transient', error: `no answer from ${lease.who.worker} before its lease ran out` }, lease.who.worker, now);
    }
  }
}
