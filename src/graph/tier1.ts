import { KnodeConfig, resolveRoutedLlmConfig, routeTargets } from '../config.js';
import { LLM_EXTRACT_INPUT_CHARS, SEGMENTER_VERSION } from '../constants.js';
import { readSidecarPart, replayableTier1, SidecarSegment, SidecarTier1, updateSidecarPart } from '../fs/sidecar.js';
import { loadSourceText } from '../ingest/source.js';
import { applyScope, findLiveScope } from '../lineage/scope.js';
import { LlmClient } from '../llm/client.js';
import { estimateTokens } from '../llm/tokens.js';
import { Store } from '../store/db.js';
import { toIso } from '../store/temporal.js';
import { applyExtraction, KnownEntity, knownEntitiesIn, llmExtract } from './llm-extract.js';
import { loadOntology } from './ontology.js';
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

/** Refresh queue priorities from current heat, document age and root importance. */
async function recomputePriorities(store: Store, config: KnodeConfig): Promise<void> {
  const boostDays = Math.max(0.1, config.extraction.freshnessBoostDays);
  const rows = await store.query<{
    document_id: string; root: string; created_at: string; heat: number | null;
  }>(
    `SELECT q.document_id, d.root, d.created_at, s.heat
     FROM extraction_queue q
     JOIN documents d ON d.id = q.document_id
     LEFT JOIN doc_stats s ON s.document_id = q.document_id`,
  );
  const now = Date.now();
  for (const r of rows) {
    const ageDays = Math.max(0, (now - new Date(r.created_at).getTime()) / (24 * 3600 * 1000));
    const freshness = 1 + 2 * Math.max(0, 1 - ageDays / boostDays);
    const importance = config.extraction.importance[r.root] ?? 1.0;
    const priority = (1 + (r.heat ?? 0)) * freshness * importance;
    await store.query(`UPDATE extraction_queue SET priority = $2 WHERE document_id = $1`, [r.document_id, priority]);
  }
}

/** Apply a tier-1 extraction as a child scope of the document's live scope. */
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
  },
): Promise<{ entities: number; relations: number; claims: number; entityIds: string[]; claimIds: string[]; outcome: 'applied' | 'unchanged' | 'orphan' }> {
  const parent = await findLiveScope(store, 'doc', doc.path);
  if (!parent) return { entities: 0, relations: 0, claims: 0, entityIds: [], claimIds: [], outcome: 'orphan' };
  let g = { entities: 0, relations: 0, claims: 0, entityIds: [] as string[], claimIds: [] as string[] };
  const res = await applyScope(
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
      g = await applyExtraction(w, page, extracted.entities, extracted.relations, extracted.claims ?? [], `tier1.llm:${opts.model}`, {
        docDate: opts.docDate ?? null,
        segments: opts.segments,
      });
    },
  );
  return { ...g, outcome: res.outcome };
}

/** The segment ranges a merged sidecar result was grounded with (undefined for a single-call document). */
export function segmentRangesOf(t1: SidecarTier1 | null | undefined): { start: number; end: number }[] | undefined {
  const segs = t1?.segments;
  return segs && segs.length > 1 ? [...segs].sort((a, b) => a.i - b.i).map((s) => ({ start: s.start, end: s.end })) : undefined;
}

/**
 * Drain from the extraction queue — at most `batchSize` model calls. Called
 * periodically while `serve` runs, or manually via the CLI.
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

interface QueueRow {
  document_id: string;
  path: string;
  title: string | null;
  sha256: string;
  doc_date: string | Date | null;
}

/** One queued document while a pass works on it. */
interface DocPlan {
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

function settled(r: SidecarSegment | null): boolean {
  return Boolean(r && (r.status === 'done' || (r.attempts ?? 0) >= MAX_ATTEMPTS));
}

function pendingOf(plan: DocPlan): number[] {
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
  const entityLlm = config.extraction.entityLlm
    ? new LlmClient(resolveRoutedLlmConfig(config.llm, config.extraction.entityLlm, routeTargets(config), config.extraction.tier1Model))
    : llm;

  const countQueue = async () => {
    const [row] = await store.query<{ n: number; segments: number }>(
      `SELECT count(*)::int AS n, COALESCE(sum(GREATEST(segments_total - segments_done, 1)), 0)::int AS segments FROM extraction_queue`,
    );
    stats.queued = row?.n ?? 0;
    stats.segmentsLeft = row?.segments ?? 0;
  };
  await countQueue();
  if (!entityLlm.enabled || stats.queued === 0) return stats;

  await recomputePriorities(store, config);
  const maxCalls = Math.max(1, Math.floor(opts.batchSize ?? config.extraction.batchSize));
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? config.extraction.concurrency ?? 1));
  const segmentChars = Math.max(1000, Math.floor(config.extraction.segmentChars || LLM_EXTRACT_INPUT_CHARS));
  const ontology = loadOntology(store.dataDir, config.graph?.ontologyPacks);
  const dequeue = (id: string) => store.query(`DELETE FROM extraction_queue WHERE document_id = $1`, [id]);
  const done = (path: string, g: { entities: number; relations: number; entityIds: string[]; claimIds: string[] }) => {
    stats.processed++;
    stats.entities += g.entities;
    stats.relations += g.relations;
    stats.documents.push(path);
    for (const id of g.entityIds) touched.add(id);
    for (const id of g.claimIds) touchedClaims.add(id);
  };

  /** Write a settled document: merge its segments, persist, apply. */
  const finish = async (plan: DocPlan): Promise<void> => {
    const { row } = plan;
    const ok = plan.results.filter((r): r is SidecarSegment => r?.status === 'done');
    const failedSegments = plan.results.flatMap((r, i) => (r?.status === 'failed' ? [i] : []));
    const now = new Date().toISOString();
    if (ok.length === 0) {
      // every segment failed: give up like a failed single call (a content change retries)
      const error = plan.results.map((r) => r?.error).find(Boolean) ?? 'extraction failed';
      updateSidecarPart(store.dataDir, row.path, 'tier1', (prev) => ({
        status: 'failed',
        entities: prev?.entities ?? [],
        relations: prev?.relations ?? [],
        model: entityLlm.label,
        contentSha: row.sha256,
        extractedAt: now,
        error: error.slice(0, 300),
        segmenter: SEGMENTER_VERSION,
        segments: plan.results.filter((r): r is SidecarSegment => r !== null),
      }));
      await dequeue(row.document_id);
      stats.failed++;
      return;
    }
    const single = plan.segments.length === 1;
    const merged = single
      ? { entities: ok[0].entities, relations: ok[0].relations, claims: ok[0].claims ?? [] }
      : mergeSegmentResults(ok.map((r) => ({ index: r.i, entities: r.entities, relations: r.relations, claims: r.claims ?? [] })));
    const model = [...ok].sort((a, b) => a.extractedAt.localeCompare(b.extractedAt)).pop()?.model ?? entityLlm.label;
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
    const g = await applyTier1Scope(store, row, plan.page, merged, {
      model,
      docDate: plan.docDate,
      force: true,
      extractedAt: now,
      segments: single ? undefined : { text: plan.text, ranges: plan.segments.map((s) => ({ start: s.start, end: s.end })) },
    });
    done(row.path, g);
    await dequeue(row.document_id);
    progress(`tier1 wrote ${row.path} (${single ? 'one call' : `${plan.segments.length} segments${failedSegments.length ? `, ${failedSegments.length} failed` : ''}`}; ${g.entities} entities, ${g.claims} claims)`);
  };

  /** Keep a document's progress in its sidecar after every call. */
  const persist = (plan: DocPlan) => {
    updateSidecarPart(store.dataDir, plan.row.path, 'tier1', (prev) => ({
      status: 'partial',
      entities: prev?.entities ?? [],
      relations: prev?.relations ?? [],
      claims: prev?.claims ?? [],
      model: entityLlm.label,
      contentSha: plan.row.sha256,
      extractedAt: prev?.extractedAt ?? new Date().toISOString(),
      segmenter: SEGMENTER_VERSION,
      segments: plan.results.filter((r): r is SidecarSegment => r !== null),
    }));
  };

  const queue = await store.query<QueueRow>(
    `SELECT q.document_id, d.path, d.title, d.sha256, d.doc_date
     FROM extraction_queue q JOIN documents d ON d.id = q.document_id
     WHERE q.tier = 1 AND d.status = 'indexed'
     ORDER BY q.priority DESC, q.enqueued_at ASC`,
  );

  const plans: DocPlan[] = [];
  const ready: Task[] = [];
  /** Followers held back until their document's first segment is in, with the calls reserved for them. */
  const waiting = new Map<DocPlan, number[]>();
  let planned = 0;
  let opened = 0;

  for (const row of queue) {
    if (planned >= maxCalls || opened >= maxCalls) break;
    opened++;
    const source = loadSourceText(store.dataDir, row.path, 'docs');
    if (!source) {
      await dequeue(row.document_id);
      continue;
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
      const g = await applyTier1Scope(store, row, page, { entities: replay.entities, relations: replay.relations, claims: replay.claims ?? [] }, {
        model: replay.model,
        docDate,
        force: true,
        extractedAt: replay.extractedAt,
        segments: ranges ? { text, ranges } : undefined,
      });
      done(row.path, g);
      await dequeue(row.document_id);
      progress(`tier1 replay ${row.path} (${g.entities} entities, ${g.claims} claims)`);
      continue;
    }

    const segments = segmentText(text, segmentChars);
    if (segments.length === 0) {
      await dequeue(row.document_id);
      continue;
    }
    const cached = new Map<string, SidecarSegment>();
    if (t1?.segmenter === SEGMENTER_VERSION) for (const s of t1.segments ?? []) cached.set(s.sha, s);
    const plan: DocPlan = {
      row, text, page, docDate, segments,
      results: segments.map((seg) => {
        const c = cached.get(seg.sha);
        return c ? { ...c, i: seg.index, start: seg.start, end: seg.end, heading: seg.heading } : null;
      }),
    };
    plans.push(plan);
    const pending = pendingOf(plan);
    if (pending.length === 0) continue; // every segment cached: written after the calls below

    if (segments.length > 1 && !settled(plan.results[0])) {
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
    const multi = plan.segments.length > 1;
    const lead = plan.results[0];
    const fromDb = await knownEntitiesIn(store, seg.text);
    const fromDoc = multi ? knownFromDocument(plan, seg.text) : [];
    const known = [...fromDoc, ...fromDb.filter((k) => !fromDoc.some((d) => d.name.toLowerCase() === k.name.toLowerCase()))].slice(0, 30);
    const label = multi ? ` [${index + 1}/${plan.segments.length}]` : '';
    const now = new Date().toISOString();
    try {
      progress(`tier1 extract ${plan.row.path}${label}`);
      const extracted = await llmExtract(entityLlm, plan.page, seg.text, {
        claims: config.extraction.claims,
        ontology,
        knownEntities: known,
        docDate: plan.docDate,
        maxChars: segmentChars,
        segment: multi ? { index, total: plan.segments.length, heading: seg.heading } : undefined,
        subject: multi && index > 0 && lead?.status === 'done' ? lead.subject ?? null : null,
        askSubject: multi && index === 0,
      });
      plan.results[index] = {
        i: index, sha: seg.sha, start: seg.start, end: seg.end, heading: seg.heading, status: 'done',
        entities: extracted.entities, relations: extracted.relations, claims: extracted.claims,
        ...(multi && index === 0 ? { subject: extracted.subject ?? null } : {}),
        model: entityLlm.label, extractedAt: now,
      };
      stats.tokensUsed += estimateTokens(seg.text) + OUTPUT_TOKEN_ESTIMATE;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const prev = plan.results[index];
      const attempts = (prev?.status === 'failed' ? prev.attempts ?? 0 : 0) + 1;
      plan.results[index] = {
        i: index, sha: seg.sha, start: seg.start, end: seg.end, heading: seg.heading, status: 'failed', attempts,
        entities: [], relations: [], claims: [], model: entityLlm.label, extractedAt: now, error: msg.slice(0, 300),
      };
      stats.callsFailed++;
      progress(`tier1 failed for ${plan.row.path}${label}: ${msg}`);
    }
    stats.calls++;
    persist(plan);
    const followers = index === 0 ? waiting.get(plan) : undefined;
    if (followers) {
      waiting.delete(plan);
      // a first segment still to be retried holds its followers until a later pass
      if (settled(plan.results[0])) for (const i of followers) ready.push({ plan, index: i });
    }
  };

  // LLM calls run concurrently; scope transactions run afterwards, one at a time
  await new Promise<void>((resolve) => {
    let active = 0;
    const pump = () => {
      while (active < concurrency && ready.length > 0) {
        const task = ready.shift()!;
        active++;
        void runTask(task).finally(() => {
          active--;
          pump();
        });
      }
      if (active === 0 && ready.length === 0) resolve();
    };
    pump();
  });

  for (const plan of plans) {
    if (pendingOf(plan).length === 0) {
      await finish(plan);
    } else {
      const doneCount = plan.results.filter(settled).length;
      await store.query(`UPDATE extraction_queue SET segments_total = $2, segments_done = $3 WHERE document_id = $1`, [
        plan.row.document_id, plan.segments.length, doneCount,
      ]);
    }
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
