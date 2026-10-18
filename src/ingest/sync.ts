import fs from 'node:fs';
import { KnodeConfig, resolveRoutedLlmConfig, routeTargets } from '../config.js';
import type { DeferredEmbeddings } from '../context.js';
import { DataSourceRegistry } from '../datasource/registry.js';
import { applyDatasourceScopes } from '../datasource/sync.js';
import { safePath } from '../fs/files.js';
import { listSidecarKeys, RAW_DOCS, RAW_TRACES } from '../fs/layout.js';
import { removeSidecar } from '../fs/sidecar.js';
import { invalidateTier0Known, maybeLearnFrequentTerms } from '../graph/concepts.js';
import { loadOntology, typePrecedence } from '../graph/ontology.js';
import { buildWikiIndex } from '../graph/wire.js';
import { DATASOURCES_PREFIX, declaredKey, enumerateDeclared, matchesPrefixes, normalizePrefixes } from '../lineage/declared.js';
import { recountAll } from '../lineage/fold.js';
import { appendLedger, nextLedgerSeq, readLedger } from '../lineage/ledger.js';
import { disposeScope } from '../lineage/scope.js';
import { ScopeKind, ScopeRow } from '../lineage/types.js';
import { LlmClient } from '../llm/client.js';
import { Store } from '../store/db.js';
import { IngestStats } from '../types.js';
import { reconcileViews } from '../wiki/pages.js';
import { applyDocScope } from './apply.js';
import { prepareEpisodes } from './episode.js';
import { EmbeddingProvider } from './embeddings.js';
import { prepareDocs } from './prepare.js';

/**
 * `sync` — configuration reconciliation for knowledge.
 *
 *   declared state = files under raw/docs (prepared), raw/traces (episodes),
 *                    raw/skills, wiki/, purpose.md / schema.md, datasource configs
 *   running state  = live root scopes
 *
 * Diff them and apply / dispose only the delta, then let dependent views
 * (generated wiki pages) regenerate or archive. Replaces the old full-scan
 * orphan sweeps: incremental runs (`only`) and watcher-triggered runs dispose
 * removed sources exactly like a full run does.
 */

export interface SyncContext {
  dataDir: string;
  config: KnodeConfig;
  store: Store;
  embedder: EmbeddingProvider;
  llm: LlmClient;
  datasources?: DataSourceRegistry;
  /** Set by `serve`: applies leave vectors to the background embedder (src/ingest/embed-backfill.ts). */
  embeddings?: DeferredEmbeddings;
}

export interface SyncOptions {
  /** Restrict to keys under these prefixes ('datasources' selects live sources). */
  only?: string[];
  /** Queue changed docs for tier-1 LLM extraction (default: true when llm configured). */
  llmGraph?: boolean;
  /** Include datasource scopes (default: full syncs only). */
  datasources?: boolean;
  /** Run consistency checks (fold recount, ledger/scopes agreement). */
  verify?: boolean;
  /** Re-apply documents whose content is unchanged too (tier-0 recomputed, tier-1 replayed; see ApplyDocOptions.reapply). */
  reapply?: boolean;
  actor?: string;
  /** Transaction time override per source (rebuild replays original apply times when the sha still matches). */
  at?: (kind: ScopeKind, key: string, sha?: string) => string | undefined;
  onProgress?: (msg: string) => void;
}

/** Back-compat options of the former `runIngest`. */
export interface IngestOptions {
  only?: string[];
  llmGraph?: boolean;
  onProgress?: (msg: string) => void;
}

export interface SyncVerifyReport {
  recount: { entities: number; relations: number; claims: number; changed: number };
  ledgerRepaired: number;
  pagesMissingFile: string[];
}

export interface SyncStats extends IngestStats {
  disposed: number;
  applied: number;
  pagesRegenerated: number;
  pagesArchived: number;
  pagesDeferred: number;
  datasourceErrors: string[];
  verify?: SyncVerifyReport;
}

// Global sync mutex: startup, watcher, HTTP API, MCP and trace-sync triggered
// runs serialize here instead of racing on the same sources.
let syncChain: Promise<unknown> = Promise.resolve();

export async function sync(ctx: SyncContext, opts: SyncOptions = {}): Promise<SyncStats> {
  const run = syncChain.then(() => syncAll(ctx, opts));
  syncChain = run.catch(() => {});
  return run;
}

/** Former entry point; kept so existing callers and tests keep working. Does not touch datasources. */
export async function runIngest(
  store: Store,
  config: KnodeConfig,
  embedder: EmbeddingProvider,
  llm: LlmClient,
  opts: IngestOptions = {},
): Promise<SyncStats> {
  return sync({ dataDir: store.dataDir, config, store, embedder, llm }, {
    only: opts.only,
    llmGraph: opts.llmGraph,
    datasources: false,
    onProgress: opts.onProgress,
  });
}

async function syncAll(ctx: SyncContext, opts: SyncOptions): Promise<SyncStats> {
  const { store, config } = ctx;
  const stats: SyncStats = {
    scanned: 0, indexed: 0, unchanged: 0, removed: 0, skipped: 0, errors: 0, chunks: 0, entities: 0, relations: 0,
    disposed: 0, applied: 0, pagesRegenerated: 0, pagesArchived: 0, pagesDeferred: 0, datasourceErrors: [],
  };
  const progress = opts.onProgress ?? (() => {});
  const actor = opts.actor ?? 'sync';
  const prefixes = normalizePrefixes(opts.only);
  const touches = (root: string) => !prefixes || prefixes.some((p) => p === root || p.startsWith(`${root}/`) || root.startsWith(`${p}/`));
  const touchesDocs = touches(RAW_DOCS);
  const touchesTraces = touches(RAW_TRACES);
  const includeDatasources = Boolean(ctx.datasources) && (opts.datasources ?? (!prefixes || prefixes.includes(DATASOURCES_PREFIX)));

  const entityLlm = config.extraction.entityLlm
    ? new LlmClient(resolveRoutedLlmConfig(config.llm, config.extraction.entityLlm, routeTargets(config), config.extraction.tier1Model))
    : ctx.llm;
  const queueTier1 = (opts.llmGraph ?? true) && entityLlm.enabled;
  const documentLlm = new LlmClient(resolveRoutedLlmConfig(config.llm, config.extraction.documentLlm, routeTargets(config)));

  // L0 → L1: describe (and where needed convert) raw/docs before scanning
  let preparedDocs: Map<string, string> | undefined;
  let failed = new Set<string>();
  if (touchesDocs) {
    // tier-0 links against what the graph knows now, not what it knew when the last pass loaded its index
    invalidateTier0Known(ctx.dataDir);
    // a scoped run prepares only the keys it was asked about: a watcher event
    // on one file must not hash every file under raw/docs
    const prep = await prepareDocs(ctx.dataDir, {
      vision: documentLlm,
      concurrency: config.ingest.convertConcurrency,
      onProgress: progress,
      prefixes,
    });
    stats.skipped += prep.stats.skipped;
    stats.errors += prep.stats.errors;
    failed = prep.failed;
    preparedDocs = prep.wanted;
    if (prep.stats.prepared) progress(`prepare: ${prep.stats.prepared} sources`);
  }

  // L0 → L1 for transcripts: turn-segmented episodes, opt-in per config.
  // Sweeping stale episode sidecars here rather than after enumeration
  // matters: the declared set is what sync reconciles against, so the files
  // on disk have to be final before it is built — otherwise switching
  // `episodes` off would re-apply the very episodes this pass just deleted.
  let preparedTraces: Map<string, string> | undefined;
  if (touchesTraces) {
    if (config.trace.episodes) {
      const episodes = prepareEpisodes(ctx.dataDir, { onProgress: progress });
      stats.skipped += episodes.skipped;
      preparedTraces = episodes.wanted;
      if (episodes.prepared) progress(`episodes: ${episodes.prepared} prepared`);
    } else {
      preparedTraces = new Map();
    }
    for (const key of listSidecarKeys(ctx.dataDir, RAW_TRACES)) {
      if (preparedTraces.has(key) || !matchesPrefixes(key, prefixes)) continue;
      removeSidecar(ctx.dataDir, key);
    }
  }

  const declared = enumerateDeclared(ctx.dataDir, config, {
    prefixes: opts.only,
    includeDatasources,
    docs: preparedDocs,
    traces: preparedTraces,
    failed,
  });

  const runningRows = await store.query<ScopeRow>(
    `SELECT * FROM scopes WHERE status = 'active' AND parent_id IS NULL AND kind IN ('doc', 'datasource')`,
  );
  const running = new Map<string, ScopeRow>();
  for (const s of runningRows) {
    if (s.kind === 'doc' && !matchesPrefixes(s.key, prefixes)) continue;
    if (s.kind === 'datasource' && !includeDatasources) continue;
    running.set(declaredKey(s.kind, s.key), s);
  }

  // removed: running but no longer declared → dispose (cascades children, pages)
  for (const [k, s] of running) {
    if (declared.has(k)) continue;
    if (s.kind === 'doc' && failed.has(s.key)) continue; // conversion failed this run — keep the last good state
    progress(`dispose ${s.kind} ${s.key}`);
    await disposeScope(store, s.id, { actor, reason: 'removed', at: opts.at?.(s.kind, s.key) });
    stats.removed++;
    stats.disposed++;
  }

  // orphan sidecars: neither a raw original nor a live scope (disposed
  // sources moved theirs to the attic a moment ago, so nothing paid is lost)
  if (touchesDocs && preparedDocs) {
    for (const key of listSidecarKeys(ctx.dataDir, RAW_DOCS)) {
      if (preparedDocs.has(key) || failed.has(key) || running.has(declaredKey('doc', key)) || !matchesPrefixes(key, prefixes)) continue;
      removeSidecar(ctx.dataDir, key);
    }
  }

  // added / replaced documents
  const wikiIndex = buildWikiIndex(ctx.dataDir, 'wiki');
  const docs = [...declared.values()].filter((d) => d.kind === 'doc');
  const processOne = async (d: (typeof docs)[number]) => {
    stats.scanned++;
    try {
      const r = await applyDocScope(ctx, d.key, d.root ?? 'docs', {
        queueTier1,
        reapply: opts.reapply,
        actor,
        at: opts.at?.('doc', d.key, d.sha),
        wikiIndex,
        onProgress: progress,
      });
      if (r.outcome === 'applied') {
        stats.indexed++;
        stats.applied++;
        // embedding keeps pace with a long pass instead of starting when it ends
        if (r.chunks) ctx.embeddings?.kick();
      } else if (r.outcome === 'unchanged') stats.unchanged++;
      else stats.skipped++;
      stats.chunks += r.chunks;
      stats.entities += r.entities;
      stats.relations += r.relations;
    } catch (err) {
      stats.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      progress(`error ${d.key}: ${msg}`);
      await store.query(
        `UPDATE documents SET status = 'error', error = $2, updated_at = now() WHERE path = $1`,
        [d.key, msg.slice(0, 500)],
      );
    }
  };
  // embedding round-trips dominate; fan files out while scope transactions
  // serialize on the single PGlite connection underneath
  const concurrency = Math.max(1, config.ingest.concurrency ?? 1);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, docs.length) }, async () => {
      while (next < docs.length) await processOne(docs[next++]);
    }),
  );

  // live datasources (after documents, so alias resolution sees the doc entities)
  if (includeDatasources && ctx.datasources) {
    const ds = await applyDatasourceScopes(ctx, ctx.datasources, { actor, onProgress: progress, at: opts.at });
    stats.datasourceErrors = ds.errors;
    stats.pagesRegenerated += ds.wikiPages;
  }

  // views: archive / regenerate dependents, repair drift
  const views = await reconcileViews(ctx, { actor, llm: false, onProgress: progress, prefixes });
  stats.pagesRegenerated += views.regenerated;
  stats.pagesArchived += views.archived;
  stats.pagesDeferred += views.deferred;

  // the corpus-frequent stop terms follow the corpus: a full pass that applied
  // documents learns them again when the list is missing, old, or the corpus doubled
  if (touchesDocs && !prefixes && stats.applied > 0) {
    const learned = await maybeLearnFrequentTerms(store, { onProgress: progress });
    if (learned) progress(`concepts: ${learned.terms.length} frequent terms learned over ${learned.docs} documents (threshold ${learned.threshold})`);
  }

  if (opts.verify) stats.verify = await verify(ctx, progress);
  // what this pass applied or regenerated may wait for vectors
  if (stats.applied || stats.pagesRegenerated) ctx.embeddings?.kick();
  return stats;
}

async function verify(ctx: SyncContext, progress: (m: string) => void): Promise<SyncVerifyReport> {
  const recount = await ctx.store.tx((q) => recountAll(q, undefined, { typePrecedence: typePrecedence(loadOntology(ctx.dataDir)) }));
  if (recount.changed) progress(`verify: fold drift repaired on ${recount.changed} rows`);

  // every live scope should have an apply line; backfill missing ones
  const logged = new Set(readLedger(ctx.dataDir).filter((e) => e.ev === 'apply').map((e) => (e as { scope: { id: string } }).scope.id));
  const live = await ctx.store.query<ScopeRow>(`SELECT * FROM scopes WHERE status = 'active'`);
  let repaired = 0;
  for (const s of live) {
    if (logged.has(s.id)) continue;
    const seq = await nextLedgerSeq(ctx.store);
    appendLedger(ctx.dataDir, {
      seq,
      ts: new Date().toISOString(),
      ev: 'apply',
      actor: 'verify',
      scope: { id: s.id, kind: s.kind, key: s.key, sha: s.sha, parent: s.parent_id },
      stats: { repair: 1 },
    });
    repaired++;
  }

  const pages = await ctx.store.query<{ path: string }>(`SELECT path FROM pages WHERE status <> 'archived'`);
  const missing = pages.map((p) => p.path.split('#')[0]).filter((p) => !fs.existsSync(safePath(ctx.dataDir, p)));
  return { recount, ledgerRepaired: repaired, pagesMissingFile: [...new Set(missing)] };
}
