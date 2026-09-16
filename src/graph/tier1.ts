import { KnodeConfig, resolveRoutedLlmConfig } from '../config.js';
import { LLM_EXTRACT_INPUT_CHARS } from '../constants.js';
import { readSidecarPart, replayableTier1, updateSidecarPart } from '../fs/sidecar.js';
import { loadSourceText } from '../ingest/source.js';
import { applyScope, findLiveScope } from '../lineage/scope.js';
import { addBudgetUse, budgetUsedToday } from '../llm/budget.js';
import { LlmClient } from '../llm/client.js';
import { estimateTokens } from '../llm/tokens.js';
import { Store } from '../store/db.js';
import { toIso } from '../store/temporal.js';
import { applyExtraction, knownEntitiesIn, llmExtract } from './llm-extract.js';
import { loadOntology } from './ontology.js';
import { ExtractedClaim, ExtractedEntity, ExtractedRelation, PageContext } from './store.js';

/**
 * Tier-1 — asynchronous LLM entity/relation extraction (LightRAG-style flat
 * graph merging), driven by a priority queue instead of the ingest hot path.
 *
 * - priority = (1 + heat) × freshness boost × per-root importance
 * - a daily token budget caps spend; the queue drains in priority order, so
 *   with a large corpus the graph densifies in the order knowledge is used
 * - results are persisted to the document sidecar (`extraction.tier1`); a DB
 *   rebuild replays them for free when contentSha still matches
 * - every extraction is applied as a child scope of the document's scope, so
 *   removing the document reverts the LLM's contribution with it
 */

export interface Tier1Stats {
  processed: number;
  failed: number;
  entities: number;
  relations: number;
  tokensUsed: number;
  budgetLeft: number;
  queued: number;
}

const MAX_ATTEMPTS = 3;
const OUTPUT_TOKEN_ESTIMATE = 3500; // entities + relations + claims (+ reasoning overhead)

/** Queue a document outside a scope (bench / manual re-queue). Sync queues through the document scope itself. */
export async function enqueueTier1(store: Store, documentId: string): Promise<void> {
  await store.query(
    `INSERT INTO extraction_queue (document_id, tier, priority) VALUES ($1, 1, 0)
     ON CONFLICT (document_id) DO NOTHING`,
    [documentId],
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
  opts: { model: string; actor?: string; at?: string; docDate?: string | null },
): Promise<{ entities: number; relations: number; claims: number; outcome: 'applied' | 'unchanged' | 'orphan' }> {
  const parent = await findLiveScope(store, 'doc', doc.path);
  if (!parent) return { entities: 0, relations: 0, claims: 0, outcome: 'orphan' };
  let g = { entities: 0, relations: 0, claims: 0 };
  const res = await applyScope(
    store,
    { kind: 'tier1', key: doc.path },
    doc.sha256,
    { parentId: parent.id, actor: opts.actor ?? 'tier1', at: opts.at, meta: { documentId: page.documentId, model: opts.model } },
    async (w) => {
      g = await applyExtraction(w, page, extracted.entities, extracted.relations, extracted.claims ?? [], `tier1.llm:${opts.model}`, { docDate: opts.docDate ?? null });
    },
  );
  return { ...g, outcome: res.outcome };
}

/**
 * Drain one batch from the extraction queue, respecting the daily token
 * budget. Called periodically while `serve` runs, or manually via the CLI.
 */
export async function runTier1Pass(
  store: Store,
  config: KnodeConfig,
  llm: LlmClient,
  opts: { onProgress?: (msg: string) => void; batchSize?: number; concurrency?: number } = {},
): Promise<Tier1Stats> {
  const progress = opts.onProgress ?? (() => {});
  const stats: Tier1Stats = { processed: 0, failed: 0, entities: 0, relations: 0, tokensUsed: 0, budgetLeft: 0, queued: 0 };
  const entityLlm = config.extraction.entityLlm
    ? new LlmClient(resolveRoutedLlmConfig(config.llm, config.extraction.entityLlm, config.connections, config.extraction.tier1Model))
    : llm;

  const countQueue = async () => {
    const [row] = await store.query<{ n: number }>(`SELECT count(*)::int AS n FROM extraction_queue`);
    return row?.n ?? 0;
  };
  stats.queued = await countQueue();
  const used = await budgetUsedToday(store);
  stats.budgetLeft = Math.max(0, config.extraction.dailyTokenBudget - used);
  if (!entityLlm.enabled || stats.queued === 0 || stats.budgetLeft <= 0) return stats;

  await recomputePriorities(store, config);
  const batch = await store.query<{
    document_id: string; attempts: number; path: string; title: string | null; sha256: string; doc_date: string | Date | null;
  }>(
    `SELECT q.document_id, q.attempts, d.path, d.title, d.sha256, d.doc_date
     FROM extraction_queue q JOIN documents d ON d.id = q.document_id
     WHERE q.tier = 1 AND d.status = 'indexed'
     ORDER BY q.priority DESC
     LIMIT $1`,
    [opts.batchSize ?? config.extraction.batchSize],
  );
  const processDoc = async (doc: (typeof batch)[number]): Promise<void> => {
    if (stats.budgetLeft <= 0) return;
    const dequeue = () => store.query(`DELETE FROM extraction_queue WHERE document_id = $1`, [doc.document_id]);
    try {
      const source = loadSourceText(store.dataDir, doc.path, 'docs');
      if (!source) {
        await dequeue();
        return;
      }
      const content = source.text;
      const chunks = await store.query<{ id: string; content: string }>(
        `SELECT id, content FROM chunks WHERE document_id = $1 ORDER BY seq`,
        [doc.document_id],
      );
      const page: PageContext = {
        documentId: doc.document_id,
        path: doc.path,
        title: doc.title ?? doc.path,
        chunkIds: chunks,
      };

      // replay for free when the sidecar already has a matching extraction
      const tier1 = replayableTier1(readSidecarPart(store.dataDir, doc.path, 'tier1'), doc.sha256);
      const docDate = toIso(doc.doc_date);
      if (tier1) {
        const g = await applyTier1Scope(store, doc, page, tier1, { model: tier1.model, docDate });
        stats.entities += g.entities;
        stats.relations += g.relations;
        stats.processed++;
        await dequeue();
        progress(`tier1 replay ${doc.path} (${g.entities} entities, ${g.claims} claims)`);
        return;
      }

      const cost = estimateTokens(content.slice(0, LLM_EXTRACT_INPUT_CHARS)) + OUTPUT_TOKEN_ESTIMATE;
      if (cost > stats.budgetLeft) return; // try again next pass (or tomorrow)
      stats.budgetLeft -= cost; // claim budget up-front so parallel workers can't overshoot

      progress(`tier1 extract ${doc.path}`);
      const knownEntities = await knownEntitiesIn(store, content.slice(0, LLM_EXTRACT_INPUT_CHARS));
      const extracted = await llmExtract(entityLlm, page, content, { claims: config.extraction.claims, ontology: loadOntology(store.dataDir, config.graph?.ontologyPacks), knownEntities, docDate });
      const g = await applyTier1Scope(store, doc, page, extracted, { model: entityLlm.label, docDate });

      updateSidecarPart(store.dataDir, doc.path, 'tier1', () => ({
        status: 'done',
        entities: extracted.entities,
        relations: extracted.relations,
        claims: extracted.claims,
        model: entityLlm.label,
        contentSha: doc.sha256,
        extractedAt: new Date().toISOString(),
      }));

      await addBudgetUse(store, cost);
      stats.tokensUsed += cost;
      stats.entities += g.entities;
      stats.relations += g.relations;
      stats.processed++;
      await dequeue();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      progress(`tier1 failed for ${doc.path}: ${msg}`);
      if (doc.attempts + 1 >= MAX_ATTEMPTS) {
        await dequeue();
        updateSidecarPart(store.dataDir, doc.path, 'tier1', (prev) => ({
          status: 'failed',
          entities: prev?.entities ?? [],
          relations: prev?.relations ?? [],
          model: entityLlm.label,
          contentSha: doc.sha256,
          extractedAt: new Date().toISOString(),
          error: msg.slice(0, 300),
        }));
        stats.failed++;
      } else {
        await store.query(`UPDATE extraction_queue SET attempts = attempts + 1 WHERE document_id = $1`, [doc.document_id]);
      }
    }
  };

  // LLM calls run concurrently; scope transactions serialize on the single
  // PGlite connection underneath
  const concurrency = Math.max(1, opts.concurrency ?? config.extraction.concurrency ?? 1);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, batch.length) }, async () => {
      while (next < batch.length && stats.budgetLeft > 0) {
        const doc = batch[next++];
        await processDoc(doc);
      }
    }),
  );

  stats.queued = await countQueue();
  return stats;
}
