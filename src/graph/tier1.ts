import crypto from 'node:crypto';
import { KnodeConfig, resolveRoutedLlmConfig, routeTargets } from '../config.js';
import { LLM_EXTRACT_INPUT_CHARS, SEGMENTER_VERSION } from '../constants.js';
import { readSidecarPart, replayableTier1, SidecarSegment, SidecarTier1, updateSidecarPart } from '../fs/sidecar.js';
import { loadSourceText } from '../ingest/source.js';
import { applyScope, findLiveScope } from '../lineage/scope.js';
import { detectDisputes } from '../lineage/trust.js';
import { LlmClient } from '../llm/client.js';
import { estimateTokens } from '../llm/tokens.js';
import { pluginRegistry } from '../plugins/registry.js';
import { Store } from '../store/db.js';
import { toIso } from '../store/temporal.js';
import { heldDocuments, claimDocument, releaseDocument } from '../labeling/claims.js';
import {
  applyExtraction,
  batchExtractReplies,
  buildBatchExtractRequest,
  EXTRACT_BATCH_DOC_CHARS,
  EXTRACT_BATCH_DOCS,
  buildExtractRequest,
  ExtractRequest,
  ExtractResult,
  KnownEntity,
  knownEntitiesIn,
  parseExtractReply,
  RawExtractReply,
} from './llm-extract.js';
import { retireTier0Placeholders } from './concepts.js';
import { loadOntology, Ontology } from './ontology.js';
import { mergeSegmentResults, Segment, segmentText } from './segment.js';
import { ExtractedClaim, ExtractedEntity, ExtractedRelation, PageContext } from './store.js';

/**
 * Tier-1 — asynchronous LLM entity/relation extraction (LightRAG-style flat
 * graph merging), driven by a priority queue instead of the ingest hot path.
 *
 * - priority = (1 + heat) × freshness boost × per-root importance
 * - the queue drains in priority order; a pass makes at most
 *   `extraction.batchSize` model calls, so with a large corpus the graph
 *   densifies in the order knowledge is used
 * - a document longer than `extraction.segmentChars` is read in segments
 *   (src/graph/segment.ts, docs/design/10): the first one runs first and names
 *   the document's subject, the rest follow in parallel; each result is kept
 *   in the sidecar under its segment's text hash as soon as it arrives, so a
 *   document spans as many passes as it needs and an edit re-extracts only
 *   the segments it changed
 * - once every segment is in, the results are merged into one document-level
 *   result, persisted to the sidecar (`extraction.tier1`) — a DB rebuild
 *   replays it for free while contentSha matches — and applied as a child
 *   scope of the document's scope, so removing the document reverts the
 *   LLM's contribution with it
 */

export interface Tier1Stats {
  /** Documents whose extraction was written this pass (fresh or replayed). */
  processed: number;
  /** Documents given up on: every segment failed repeatedly. */
  failed: number;
  entities: number;
  relations: number;
  tokensUsed: number;
  /** Documents still queued after the pass. */
  queued: number;
  /** Extraction calls made this pass, and how many of them failed. */
  calls: number;
  callsFailed: number;
  /** Segments still to extract across the queue (estimate for queued documents not yet opened). */
  segmentsLeft: number;
  /** Something moved: a call succeeded or a document was written or given up on. */
  progressed: boolean;
  /** Entity ids this pass wrote evidence for — the duplicate audit's focus right after it (docs/design/09). */
  touched: string[];
  /** Claim ids this pass wrote — the duplicate-claim audit's focus (docs/design/10). */
  touchedClaims: string[];
  /** Documents this pass extracted (or replayed), by path — the first in line for a summary. */
  documents: string[];
}

const MAX_ATTEMPTS = 3;
const OUTPUT_TOKEN_ESTIMATE = 4500; // entities + relations + claims (+ reasoning overhead)

/** Queue a document outside a scope (bench / manual re-queue). Sync queues through the document scope itself. */
export async function enqueueTier1(store: Store, documentId: string, segments = 0): Promise<void> {
  await store.query(
    `INSERT INTO extraction_queue (document_id, tier, priority, segments_total) VALUES ($1, 1, 0, $2)
     ON CONFLICT (document_id) DO NOTHING`,
    [documentId, segments],
  );
}

/**
 * Refresh queue priorities from current heat, document age and root importance:
 * priority = (1 + heat) × freshness × importance, where freshness decays from
 * 3 to 1 over `extraction.freshnessBoostDays`. One statement — a queue of tens
 * of thousands of documents made a per-row update a round trip per document on
 * every pass.
 */
export async function refreshQueuePriorities(store: Store, config: KnodeConfig): Promise<void> {
  const boostDays = Math.max(0.1, config.extraction.freshnessBoostDays);
  const params: unknown[] = [boostDays];
  const cases: string[] = [];
  for (const [root, weight] of Object.entries(config.extraction.importance ?? {})) {
    if (!Number.isFinite(weight)) continue;
    params.push(root, weight);
    cases.push(`WHEN $${params.length - 1} THEN $${params.length}::real`);
  }
  const importance = cases.length ? `(CASE d.root ${cases.join(' ')} ELSE 1.0 END)` : '1.0';
  await store.query(
    `UPDATE extraction_queue q
     SET priority = (1 + COALESCE(s.heat, 0))
       * (1 + 2 * GREATEST(0, 1 - GREATEST(0, EXTRACT(EPOCH FROM (now() - d.created_at)) / 86400.0) / $1::real))
       * ${importance}
     FROM documents d LEFT JOIN doc_stats s ON s.document_id = d.id
     WHERE d.id = q.document_id`,
    params,
  );
}

/** Thrown inside the tier-1 transaction to roll it back: the document is no longer the text that was read. */
class StaleDocument extends Error {}

/**
 * Apply a tier-1 extraction as a child scope of the document's live scope.
 * Once it is in, the document's tier-0 concept placeholders that did not
 * resolve to a typed entity are retired (src/graph/concepts.ts): tier-1 has
 * now said what the document is about.
 *
 * `stale` means nothing was written: a re-index replaced the document (and
 * the chunks `page` names) after the caller read it. The check runs inside
 * the transaction, under the ledger lock every re-index takes too, so no
 * re-index lands between it and the write.
 */
export async function applyTier1Scope(
  store: Store,
  doc: { path: string; sha256: string },
  page: PageContext,
  extracted: { entities: ExtractedEntity[]; relations: ExtractedRelation[]; claims?: ExtractedClaim[] },
  opts: {
    model: string;
    actor?: string;
    at?: string;
    docDate?: string | null;
    /** A segmented document's text and segment ranges, for grounding (see applyExtraction). */
    segments?: { text: string; ranges: { start: number; end: number }[] };
    /** Re-apply although a scope for this content exists (a fresh extraction of unchanged content). */
    force?: boolean;
    /** The sidecar result's `extractedAt`, kept on the scope so a replay can tell a newer result for the same content. */
    extractedAt?: string;
    /** Take the document off the extraction queue in the same transaction as the write. */
    dequeue?: boolean;
  },
): Promise<{ entities: number; relations: number; claims: number; entityIds: string[]; claimIds: string[]; outcome: 'applied' | 'unchanged' | 'orphan' | 'stale' }> {
  const nothing = { entities: 0, relations: 0, claims: 0, entityIds: [] as string[], claimIds: [] as string[] };
  const parent = await findLiveScope(store, 'doc', doc.path);
  if (!parent) return { ...nothing, outcome: 'orphan' };
  let g = nothing;
  let res: Awaited<ReturnType<typeof applyScope>>;
  try {
    res = await applyScope(
      store,
      { kind: 'tier1', key: doc.path },
      doc.sha256,
      {
        parentId: parent.id,
        actor: opts.actor ?? 'tier1',
        at: opts.at,
        force: opts.force,
        meta: { documentId: page.documentId, model: opts.model, ...(opts.extractedAt ? { extractedAt: opts.extractedAt } : {}) },
      },
      async (w) => {
        // a re-index that committed since the caller looked replaced the
        // document's scope and its chunks: the mentions below would name
        // chunks that are gone, under a parent that is disposed
        const [current] = await w.q.query<{ sha256: string }>(`SELECT sha256 FROM documents WHERE id = $1`, [page.documentId]);
        const live = await findLiveScope(w.q, 'doc', doc.path);
        if (current?.sha256 !== doc.sha256 || live?.id !== parent.id) throw new StaleDocument();
        g = await applyExtraction(w, page, extracted.entities, extracted.relations, extracted.claims ?? [], `tier1.llm:${opts.model}`, {
          docDate: opts.docDate ?? null,
          segments: opts.segments,
        });
        // here rather than after COMMIT: a re-index waiting on the lock queues
        // its new text once this commits, and a later dequeue would take that away
        if (opts.dequeue) await w.q.query(`DELETE FROM extraction_queue WHERE document_id = $1`, [page.documentId]);
      },
    );
  } catch (err) {
    if (err instanceof StaleDocument) return { ...nothing, outcome: 'stale' };
    throw err;
  }
  if (res.outcome === 'applied') {
    await retireTier0Placeholders(store, parent.id, { at: res.scope.applied_at });
    // the claims a model read out of a quarantined source are quarantined too
    // (applyScope), and where they contradict a trusted one that is recorded
    await detectDisputes(store, res.scope.id);
  }
  return { ...g, outcome: res.outcome };
}

/** The segment ranges a merged sidecar result was grounded with (undefined for a single-call document). */
export function segmentRangesOf(t1: SidecarTier1 | null | undefined): { start: number; end: number }[] | undefined {
  const segs = t1?.segments;
  return segs && segs.length > 1 ? [...segs].sort((a, b) => a.i - b.i).map((s) => ({ start: s.start, end: s.end })) : undefined;
}

/**
 * Drain from the extraction queue — at most `batchSize` model calls. Called
 * by `knode-os extract`, an initialization draining the queue, and tests;
 * `serve` runs the labeling scheduler instead (src/labeling), which shares the
 * helpers below and holds its documents in the same registry, so the two never
 * pick the same document.
 */
// One pass at a time per data dir: serve's timer, `knode-os extract` and an
// initialization job draining the queue must never pick the same batch twice.
const tier1Chains = new Map<string, Promise<unknown>>();

export function runTier1Pass(
  store: Store,
  config: KnodeConfig,
  llm: LlmClient,
  opts: { onProgress?: (msg: string) => void; batchSize?: number; concurrency?: number } = {},
): Promise<Tier1Stats> {
  const previous = tier1Chains.get(store.dataDir) ?? Promise.resolve();
  const run = previous.then(() => runTier1PassUnlocked(store, config, llm, opts));
  tier1Chains.set(store.dataDir, run.catch(() => {}));
  return run;
}

/** The extraction stage's client: `extraction.entityLlm`, else the caller's. */
export function entityLlmClient(config: KnodeConfig, fallback: LlmClient): LlmClient {
  return config.extraction.entityLlm
    ? new LlmClient(resolveRoutedLlmConfig(config.llm, config.extraction.entityLlm, routeTargets(config), config.extraction.tier1Model))
    : fallback;
}

/** Segment size the extraction calls read, from the config. */
export function extractionSegmentChars(config: KnodeConfig): number {
  return Math.max(1000, Math.floor(config.extraction.segmentChars || LLM_EXTRACT_INPUT_CHARS));
}

export interface QueueRow {
  document_id: string;
  path: string;
  title: string | null;
  sha256: string;
  doc_date: string | Date | null;
}

/** One queued document while extraction works on it. */
export interface DocPlan {
  row: QueueRow;
  text: string;
  page: PageContext;
  docDate: string | null;
  segments: Segment[];
  /** Index-aligned with `segments`: a cached or fresh result, or null while pending. */
  results: (SidecarSegment | null)[];
}

interface Task {
  plan: DocPlan;
  index: number;
}

/** A segment needs no more calls: extracted, or failed `MAX_ATTEMPTS` times. */
export function settled(r: SidecarSegment | null): boolean {
  return Boolean(r && (r.status === 'done' || (r.attempts ?? 0) >= MAX_ATTEMPTS));
}

/** Segments of a plan still to extract. */
export function pendingOf(plan: DocPlan): number[] {
  return plan.results.flatMap((r, i) => (settled(r) ? [] : [i]));
}

/** Entities this document's finished segments named that also appear in `text` — so one document keeps one spelling. */
function knownFromDocument(plan: DocPlan, text: string, limit = 20): KnownEntity[] {
  const lc = text.toLowerCase();
  const out: KnownEntity[] = [];
  const seen = new Set<string>();
  for (const r of plan.results) {
    if (r?.status !== 'done') continue;
    for (const e of r.entities) {
      const key = e.name.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      const aliases = (e.aliases ?? []).map(String);
      if (![e.name, ...aliases].some((n) => n.length >= 2 && lc.includes(n.toLowerCase()))) continue;
      seen.add(key);
      out.push({ name: e.name, type: e.type, aliases });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Queued documents in extraction order (priority, then age), leaving out `exclude`. */
export async function queuedDocuments(store: Store, opts: { exclude?: string[]; limit?: number } = {}): Promise<QueueRow[]> {
  const params: unknown[] = [];
  let where = `q.tier = 1 AND d.status = 'indexed'`;
  if (opts.exclude?.length) {
    params.push(opts.exclude);
    where += ` AND NOT (q.document_id = ANY($${params.length}::text[]))`;
  }
  let limit = '';
  if (opts.limit) {
    params.push(Math.max(1, Math.floor(opts.limit)));
    limit = ` LIMIT $${params.length}`;
  }
  return store.query<QueueRow>(
    `SELECT q.document_id, d.path, d.title, d.sha256, d.doc_date
     FROM extraction_queue q JOIN documents d ON d.id = q.document_id
     WHERE ${where}
     ORDER BY q.priority DESC, q.enqueued_at ASC${limit}`,
    params,
  );
}

export async function dequeueDocument(store: Store, documentId: string): Promise<void> {
  await store.query(`DELETE FROM extraction_queue WHERE document_id = $1`, [documentId]);
}

export type AppliedTier1 = Awaited<ReturnType<typeof applyTier1Scope>>;

export type PlannedDocument =
  /** Its text is gone or yields no segment: dequeued. */
  | { kind: 'dropped' }
  /** The sidecar held a whole extraction of this content, applied for free: dequeued. */
  | { kind: 'replayed'; applied: AppliedTier1 }
  /** A re-index replaced it while it was being opened: still queued, for its new text. */
  | { kind: 'stale' }
  | { kind: 'plan'; plan: DocPlan };

/**
 * Open a queued document for extraction: its text, chunks and date, its
 * segments, and every segment result the sidecar already holds for this text
 * (cached by the segment's hash, so an edit re-extracts only what changed).
 */
export async function planQueuedDocument(
  store: Store,
  config: KnodeConfig,
  row: QueueRow,
  opts: { onProgress?: (msg: string) => void } = {},
): Promise<PlannedDocument> {
  const source = loadSourceText(store.dataDir, row.path, 'docs');
  if (!source) {
    await dequeueDocument(store, row.document_id);
    return { kind: 'dropped' };
  }
  const text = source.text;
  const chunks = await store.query<{ id: string; content: string }>(`SELECT id, content FROM chunks WHERE document_id = $1 ORDER BY seq`, [row.document_id]);
  const page: PageContext = { documentId: row.document_id, path: row.path, title: row.title ?? row.path, chunkIds: chunks };
  const docDate = toIso(row.doc_date);
  const t1 = readSidecarPart(store.dataDir, row.path, 'tier1');

  // replay for free when the sidecar already holds a whole extraction of
  // this content; forced, because a queued document is one whose live scope
  // may predate that result (an interrupted pass, a copied sidecar)
  const replay = replayableTier1(t1, row.sha256, text.length);
  if (replay) {
    const ranges = segmentRangesOf(replay);
    const applied = await applyTier1Scope(store, row, page, { entities: replay.entities, relations: replay.relations, claims: replay.claims ?? [] }, {
      model: replay.model,
      docDate,
      force: true,
      extractedAt: replay.extractedAt,
      segments: ranges ? { text, ranges } : undefined,
      dequeue: true,
    });
    if (applied.outcome === 'stale') return { kind: 'stale' };
    if (applied.outcome !== 'applied') await dequeueDocument(store, row.document_id);
    opts.onProgress?.(`tier1 replay ${row.path} (${applied.entities} entities, ${applied.claims} claims)`);
    return { kind: 'replayed', applied };
  }

  const segments = segmentText(text, extractionSegmentChars(config));
  if (segments.length === 0) {
    await dequeueDocument(store, row.document_id);
    return { kind: 'dropped' };
  }
  const cached = new Map<string, SidecarSegment>();
  if (t1?.segmenter === SEGMENTER_VERSION) for (const s of t1.segments ?? []) cached.set(s.sha, s);
  return {
    kind: 'plan',
    plan: {
      row, text, page, docDate, segments,
      results: segments.map((seg) => {
        const c = cached.get(seg.sha);
        return c ? { ...c, i: seg.index, start: seg.start, end: seg.end, heading: seg.heading } : null;
      }),
    },
  };
}

/**
 * The prompt for one segment of an open document: the entities the graph and
 * this document's finished segments already name, the lead segment's subject
 * for a follower, the subject question for a lead.
 */
export async function segmentExtractRequest(store: Store, config: KnodeConfig, plan: DocPlan, index: number, ontology: Ontology): Promise<ExtractRequest> {
  const seg = plan.segments[index];
  const multi = plan.segments.length > 1;
  const lead = plan.results[0];
  const fromDb = await knownEntitiesIn(store, seg.text);
  const fromDoc = multi ? knownFromDocument(plan, seg.text) : [];
  const known = [...fromDoc, ...fromDb.filter((k) => !fromDoc.some((d) => d.name.toLowerCase() === k.name.toLowerCase()))].slice(0, 30);
  const request = buildExtractRequest(plan.page, seg.text, {
    claims: config.extraction.claims,
    ontology,
    knownEntities: known,
    docDate: plan.docDate,
    maxChars: extractionSegmentChars(config),
    segment: multi ? { index, total: plan.segments.length, heading: seg.heading } : undefined,
    subject: multi && index > 0 && lead?.status === 'done' ? lead.subject ?? null : null,
    askSubject: multi && index === 0,
  });
  // `extract.request` hooks (docs/design/11) see the call as it will be sent —
  // or leased to a worker on another machine, which runs exactly these messages
  const registry = pluginRegistry();
  if (!registry.hasHandlers('extract.request')) return request;
  const shaped = await registry.filter('extract.request', request, { path: plan.row.path, root: 'docs', dataDir: store.dataDir, title: plan.page.title, segment: segmentContext(plan, index) });
  if (!shaped || !Array.isArray(shaped.messages) || shaped.messages.length === 0) throw new Error(`extract.request hook returned no messages for ${plan.row.path}`);
  return { ...request, ...shaped, maxTokens: Number.isFinite(shaped.maxTokens) && shaped.maxTokens > 0 ? Math.floor(shaped.maxTokens) : request.maxTokens };
}

function segmentContext(plan: DocPlan, index: number): { index: number; total: number; heading: string | null } | undefined {
  if (plan.segments.length <= 1) return undefined;
  return { index, total: plan.segments.length, heading: plan.segments[index]?.heading ?? null };
}

/**
 * Check a model's reply the way `parseExtractReply` does, then let
 * `extract.result` hooks (docs/design/11) filter, rename or enrich what was
 * extracted; the outcome is checked once more, so a loosely shaped answer from
 * a hook never reaches the sidecar. Shared by the batch pass and the labeling
 * scheduler, so a hook sees every extraction however it was run.
 */
export async function checkExtractReply(
  reply: RawExtractReply,
  request: Pick<ExtractRequest, 'withClaims' | 'askSubject'>,
  ctx: { dataDir: string; plan: DocPlan; index: number; model: string },
): Promise<ExtractResult> {
  const parsed = parseExtractReply(reply, request);
  const registry = pluginRegistry();
  if (!registry.hasHandlers('extract.result')) return parsed;
  const shaped = await registry.filter('extract.result', parsed, {
    path: ctx.plan.row.path, root: 'docs', dataDir: ctx.dataDir, title: ctx.plan.page.title, model: ctx.model, segment: segmentContext(ctx.plan, ctx.index),
  });
  return parseExtractReply(shaped as RawExtractReply, request);
}

/** What one call made of a segment: its result, or one more failed attempt. */
export type SegmentOutcome = { ok: true; result: ExtractResult } | { ok: false; error: string };

/** Record a call's outcome on the plan; `model` names who answered (or failed to). */
export function recordSegmentOutcome(plan: DocPlan, index: number, outcome: SegmentOutcome, model: string, at = new Date().toISOString()): void {
  const seg = plan.segments[index];
  const multi = plan.segments.length > 1;
  if (outcome.ok) {
    const extracted = outcome.result;
    plan.results[index] = {
      i: index, sha: seg.sha, start: seg.start, end: seg.end, heading: seg.heading, status: 'done',
      entities: extracted.entities, relations: extracted.relations, claims: extracted.claims,
      ...(multi && index === 0 ? { subject: extracted.subject ?? null } : {}),
      model, extractedAt: at,
    };
    return;
  }
  const prev = plan.results[index];
  const attempts = (prev?.status === 'failed' ? prev.attempts ?? 0 : 0) + 1;
  plan.results[index] = {
    i: index, sha: seg.sha, start: seg.start, end: seg.end, heading: seg.heading, status: 'failed', attempts,
    entities: [], relations: [], claims: [], model, extractedAt: at, error: outcome.error.slice(0, 300),
  };
}

/** Keep a document's progress in its sidecar after every call. */
export function persistPlan(dataDir: string, plan: DocPlan, model: string): void {
  updateSidecarPart(dataDir, plan.row.path, 'tier1', (prev) => ({
    status: 'partial',
    entities: prev?.entities ?? [],
    relations: prev?.relations ?? [],
    claims: prev?.claims ?? [],
    model,
    contentSha: plan.row.sha256,
    extractedAt: prev?.extractedAt ?? new Date().toISOString(),
    segmenter: SEGMENTER_VERSION,
    segments: plan.results.filter((r): r is SidecarSegment => r !== null),
  }));
}

export type FinishedDocument =
  /** Every segment failed: given up like a failed single call (a content change retries). */
  | { kind: 'failed' }
  /** A re-index replaced the document while it was being read: nothing written, still queued for its new text. */
  | { kind: 'stale' }
  | { kind: 'written'; applied: AppliedTier1; segments: number; failedSegments: number[]; model: string };

/** Write a settled document: merge its segments, persist the result, apply and dequeue it — unless a re-index replaced it meanwhile. */
export async function finishPlan(store: Store, plan: DocPlan, fallbackModel: string): Promise<FinishedDocument> {
  const { row } = plan;
  const ok = plan.results.filter((r): r is SidecarSegment => r?.status === 'done');
  const failedSegments = plan.results.flatMap((r, i) => (r?.status === 'failed' ? [i] : []));
  const now = new Date().toISOString();
  if (ok.length === 0) {
    const error = plan.results.map((r) => r?.error).find(Boolean) ?? 'extraction failed';
    updateSidecarPart(store.dataDir, row.path, 'tier1', (prev) => ({
      status: 'failed',
      entities: prev?.entities ?? [],
      relations: prev?.relations ?? [],
      model: fallbackModel,
      contentSha: row.sha256,
      extractedAt: now,
      error: error.slice(0, 300),
      segmenter: SEGMENTER_VERSION,
      segments: plan.results.filter((r): r is SidecarSegment => r !== null),
    }));
    await dequeueDocument(store, row.document_id);
    return { kind: 'failed' };
  }
  const single = plan.segments.length === 1;
  const merged = single
    ? { entities: ok[0].entities, relations: ok[0].relations, claims: ok[0].claims ?? [] }
    : mergeSegmentResults(ok.map((r) => ({ index: r.i, entities: r.entities, relations: r.relations, claims: r.claims ?? [] })));
  const model = [...ok].sort((a, b) => a.extractedAt.localeCompare(b.extractedAt)).pop()?.model ?? fallbackModel;
  updateSidecarPart(store.dataDir, row.path, 'tier1', () => ({
    status: 'done',
    entities: merged.entities,
    relations: merged.relations,
    claims: merged.claims,
    model,
    contentSha: row.sha256,
    extractedAt: now,
    segmenter: SEGMENTER_VERSION,
    segments: plan.results as SidecarSegment[],
    ...(failedSegments.length ? { failedSegments } : {}),
  }));
  const applied = await applyTier1Scope(store, row, plan.page, merged, {
    model,
    docDate: plan.docDate,
    force: true,
    extractedAt: now,
    segments: single ? undefined : { text: plan.text, ranges: plan.segments.map((s) => ({ start: s.start, end: s.end })) },
    dequeue: true,
  });
  // the sidecar keeps the segments by their text: reopened, it re-reads only what changed
  if (applied.outcome === 'stale') return { kind: 'stale' };
  if (applied.outcome !== 'applied') await dequeueDocument(store, row.document_id);
  return { kind: 'written', applied, segments: plan.segments.length, failedSegments, model };
}

/** Queue counts of a document still in progress. */
export async function recordPlanProgress(store: Store, plan: DocPlan): Promise<void> {
  const doneCount = plan.results.filter(settled).length;
  await store.query(`UPDATE extraction_queue SET segments_total = $2, segments_done = $3 WHERE document_id = $1`, [
    plan.row.document_id, plan.segments.length, doneCount,
  ]);
}

async function runTier1PassUnlocked(
  store: Store,
  config: KnodeConfig,
  llm: LlmClient,
  opts: { onProgress?: (msg: string) => void; batchSize?: number; concurrency?: number } = {},
): Promise<Tier1Stats> {
  const progress = opts.onProgress ?? (() => {});
  const stats: Tier1Stats = {
    processed: 0, failed: 0, entities: 0, relations: 0, tokensUsed: 0, queued: 0,
    calls: 0, callsFailed: 0, segmentsLeft: 0, progressed: false, touched: [], touchedClaims: [], documents: [],
  };
  const touched = new Set<string>();
  const touchedClaims = new Set<string>();
  const entityLlm = entityLlmClient(config, llm);

  const countQueue = async () => {
    const [row] = await store.query<{ n: number; segments: number }>(
      `SELECT count(*)::int AS n, COALESCE(sum(GREATEST(segments_total - segments_done, 1)), 0)::int AS segments FROM extraction_queue`,
    );
    stats.queued = row?.n ?? 0;
    stats.segmentsLeft = row?.segments ?? 0;
  };
  await countQueue();
  if (!entityLlm.enabled || stats.queued === 0) return stats;

  await refreshQueuePriorities(store, config);
  const maxCalls = Math.max(1, Math.floor(opts.batchSize ?? config.extraction.batchSize));
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? config.extraction.concurrency ?? 1));
  const ontology = loadOntology(store.dataDir, config.graph?.ontologyPacks);
  const done = (path: string, g: { entities: number; relations: number; entityIds: string[]; claimIds: string[] }) => {
    stats.processed++;
    stats.entities += g.entities;
    stats.relations += g.relations;
    stats.documents.push(path);
    for (const id of g.entityIds) touched.add(id);
    for (const id of g.claimIds) touchedClaims.add(id);
  };

  // documents the labeling scheduler holds are its own; this pass holds what it opens
  const owner = `pass:${crypto.randomUUID()}`;
  const held: string[] = [];
  try {
    const queue = await queuedDocuments(store, { exclude: heldDocuments(store.dataDir) });

    const plans: DocPlan[] = [];
    const ready: Task[] = [];
    /** Followers held back until their document's first segment is in, with the calls reserved for them. */
    const waiting = new Map<DocPlan, number[]>();
    let planned = 0;
    let opened = 0;

    for (const row of queue) {
      if (planned >= maxCalls || opened >= maxCalls) break;
      if (!claimDocument(store.dataDir, row.document_id, owner)) continue;
      held.push(row.document_id);
      opened++;
      const planned_ = await planQueuedDocument(store, config, row, { onProgress: progress });
      if (planned_.kind === 'replayed') {
        done(row.path, planned_.applied);
        continue;
      }
      if (planned_.kind !== 'plan') continue;
      const plan = planned_.plan;
      plans.push(plan);
      const pending = pendingOf(plan);
      if (pending.length === 0) continue; // every segment cached: written after the calls below

      if (plan.segments.length > 1 && !settled(plan.results[0])) {
        // the first segment names the document's subject for the rest; the
        // followers' calls are reserved so the document finishes before the next one starts
        ready.push({ plan, index: 0 });
        planned++;
        const followers = pending.filter((i) => i !== 0).slice(0, Math.max(0, maxCalls - planned));
        planned += followers.length;
        waiting.set(plan, followers);
      } else {
        for (const i of pending.slice(0, maxCalls - planned)) {
          ready.push({ plan, index: i });
          planned++;
        }
      }
    }

    const runTask = async ({ plan, index }: Task): Promise<void> => {
      const seg = plan.segments[index];
      const label = plan.segments.length > 1 ? ` [${index + 1}/${plan.segments.length}]` : '';
      try {
        progress(`tier1 extract ${plan.row.path}${label}`);
        const request = await segmentExtractRequest(store, config, plan, index, ontology);
        const reply = await entityLlm.completeJson<RawExtractReply>(request.messages, { maxTokens: request.maxTokens });
        const result = await checkExtractReply(reply, request, { dataDir: store.dataDir, plan, index, model: entityLlm.label });
        recordSegmentOutcome(plan, index, { ok: true, result }, entityLlm.label);
        stats.tokensUsed += estimateTokens(seg.text) + OUTPUT_TOKEN_ESTIMATE;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recordSegmentOutcome(plan, index, { ok: false, error: msg }, entityLlm.label);
        stats.callsFailed++;
        progress(`tier1 failed for ${plan.row.path}${label}: ${msg}`);
      }
      stats.calls++;
      persistPlan(store.dataDir, plan, entityLlm.label);
      const followers = index === 0 ? waiting.get(plan) : undefined;
      if (followers) {
        waiting.delete(plan);
        // a first segment still to be retried holds its followers until a later pass
        if (settled(plan.results[0])) for (const i of followers) jobs.push([{ plan, index: i }]);
      }
    };

    // several short single-segment documents, one call (buildBatchExtractRequest); each keeps its own sidecar result
    const runBatch = async (tasks: Task[]): Promise<void> => {
      progress(`tier1 extract ${tasks.length} documents: ${tasks.map((t) => t.plan.row.path).join(', ')}`);
      try {
        const items = await Promise.all(tasks.map(async ({ plan }) => ({
          page: plan.page,
          content: plan.segments[0].text,
          docDate: plan.docDate,
          knownEntities: await knownEntitiesIn(store, plan.segments[0].text),
        })));
        const request = buildBatchExtractRequest(items, { claims: config.extraction.claims, ontology, maxChars: extractionSegmentChars(config) });
        const reply = await entityLlm.completeJson<unknown>(request.messages, { maxTokens: request.maxTokens });
        const byDoc = batchExtractReplies(reply, tasks.length);
        for (const [i, { plan }] of tasks.entries()) {
          const raw = byDoc.get(i);
          try {
            if (!raw) throw new Error('the batched reply had no entry for this document');
            const result = await checkExtractReply(raw, request, { dataDir: store.dataDir, plan, index: 0, model: entityLlm.label });
            recordSegmentOutcome(plan, 0, { ok: true, result }, entityLlm.label);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            recordSegmentOutcome(plan, 0, { ok: false, error: msg }, entityLlm.label);
            progress(`tier1 failed for ${plan.row.path}: ${msg}`);
          }
        }
        stats.tokensUsed += items.reduce((n, item) => n + estimateTokens(item.content), 0) + OUTPUT_TOKEN_ESTIMATE * tasks.length;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        for (const { plan } of tasks) recordSegmentOutcome(plan, 0, { ok: false, error: msg }, entityLlm.label);
        stats.callsFailed++;
        progress(`tier1 failed for ${tasks.length} documents: ${msg}`);
      }
      stats.calls++;
      for (const { plan } of tasks) persistPlan(store.dataDir, plan, entityLlm.label);
    };

    // a plugin that shapes extraction requests sees one document a request, as it always has
    const batching = !pluginRegistry().hasHandlers('extract.request');
    const perBatch = EXTRACT_BATCH_DOCS;
    const budget = extractionSegmentChars(config);
    const jobs: Task[][] = [];
    let open: Task[] = [];
    let openChars = 0;
    for (const task of ready) {
      const len = task.plan.segments[task.index].text.length;
      // a document that failed before is retried on its own: one that breaks a batch must not take the others' attempts with it
      const failedBefore = (task.plan.results[task.index]?.attempts ?? 0) > 0;
      if (!batching || failedBefore || task.plan.segments.length > 1 || len > EXTRACT_BATCH_DOC_CHARS) {
        jobs.push([task]);
        continue;
      }
      if (open.length > 0 && (open.length >= perBatch || openChars + len > budget)) {
        jobs.push(open);
        open = [];
        openChars = 0;
      }
      open.push(task);
      openChars += len;
    }
    if (open.length > 0) jobs.push(open);

    // LLM calls run concurrently; scope transactions run afterwards, one at a time
    await new Promise<void>((resolve) => {
      let active = 0;
      const pump = () => {
        while (active < concurrency && jobs.length > 0) {
          const job = jobs.shift()!;
          active++;
          void (job.length === 1 ? runTask(job[0]) : runBatch(job)).finally(() => {
            active--;
            pump();
          });
        }
        if (active === 0 && jobs.length === 0) resolve();
      };
      pump();
    });

    for (const plan of plans) {
      if (pendingOf(plan).length === 0) {
        const finished = await finishPlan(store, plan, entityLlm.label);
        if (finished.kind === 'failed') {
          stats.failed++;
          continue;
        }
        if (finished.kind === 'stale') {
          progress(`tier1 ${plan.row.path} changed while it was read; its new text stays queued`);
          continue;
        }
        done(plan.row.path, finished.applied);
        const { segments, failedSegments, applied } = finished;
        progress(`tier1 wrote ${plan.row.path} (${segments === 1 ? 'one call' : `${segments} segments${failedSegments.length ? `, ${failedSegments.length} failed` : ''}`}; ${applied.entities} entities, ${applied.claims} claims)`);
      } else {
        await recordPlanProgress(store, plan);
      }
    }
  } finally {
    for (const id of held) releaseDocument(store.dataDir, id, owner);
  }

  await countQueue();
  stats.progressed = stats.calls > stats.callsFailed || stats.processed > 0 || stats.failed > 0;
  stats.touched = [...touched];
  stats.touchedClaims = [...touchedClaims];
  return stats;
}

/**
 * `knode-os extract --retry-failed`: documents with segments that failed
 * repeatedly (or failed outright) go back in the queue with those segments
 * cleared, so the next passes try them again and rewrite the document.
 */
export async function requeueFailedExtractions(store: Store, config: KnodeConfig): Promise<number> {
  const docs = await store.query<{ id: string; path: string }>(`SELECT id, path FROM documents WHERE root = 'docs' AND status = 'indexed'`);
  const segmentChars = Math.max(1000, Math.floor(config.extraction.segmentChars || LLM_EXTRACT_INPUT_CHARS));
  let requeued = 0;
  for (const doc of docs) {
    const t1 = readSidecarPart(store.dataDir, doc.path, 'tier1');
    if (!t1 || (t1.status !== 'failed' && !t1.failedSegments?.length)) continue;
    updateSidecarPart(store.dataDir, doc.path, 'tier1', (cur) => ({
      ...cur!,
      status: 'partial',
      segments: (cur?.segments ?? []).filter((s) => s.status === 'done'),
      failedSegments: undefined,
    }));
    const text = loadSourceText(store.dataDir, doc.path, 'docs')?.text ?? '';
    await enqueueTier1(store, doc.id, segmentText(text, segmentChars).length);
    requeued++;
  }
  return requeued;
}
