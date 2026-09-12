import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { AppContext } from '../context.js';
import {
  EmbeddingConfig,
  KnodeConfig,
  LlmConfig,
  LlmProvider,
  RoutedLlmConfig,
  SagSearchConfig,
  redactConfig,
  resolveRoutedLlmConfig,
  saveConfig,
} from '../config.js';
import { runSourceQuery } from '../datasource/execute.js';
import { MAX_FILE_BYTES, MAX_PREVIEW_BYTES } from '../constants.js';
import { assertWritablePath, grepFiles, listTree, makeDir, movePath, pathExists, readFileTextCapped, removePath, safePath, sanitizeRelativePath, writeFileBytes, writeFileText } from '../fs/files.js';
import { graphInsights, graphOverview, graphSearch } from '../graph/query.js';
import { buildContextPack } from '../pack/pack.js';
import { applySuggestion } from '../pack/learn.js';
import { createEmbeddingProvider } from '../ingest/embeddings.js';
import { LlmClient } from '../llm/client.js';
import { sync } from '../ingest/sync.js';
import { historyOf, lineageOf } from '../lineage/inspect.js';
import { forgetSource, purgeArchived, purgeDisposed } from '../lineage/purge.js';
import { rebuild } from '../lineage/rebuild.js';
import { ask } from '../search/ask.js';
import { search, SearchMode } from '../search/search.js';
import { planOnly, resolve } from '../compiler/resolve.js';
import { liveAbsences } from '../compiler/absence.js';
import { distillRecipes } from '../compiler/distill.js';
import { evaluatePacks, writeEvalReport } from '../compiler/evaluate.js';
import { writeRankerReport } from '../compiler/ranker.js';
import { changesSince, listSubscriptions, subscribe, unsubscribe } from '../compiler/subscribe.js';
import { checkout, commitWorkset, envelopeFor, listWorksets } from '../compiler/workset.js';
import { listDisputes, resolveDispute, setScopeTrust } from '../lineage/trust.js';
import { listReceipts, recordFeedback } from '../compiler/receipts.js';
import { readVirtual } from '../compiler/vfs.js';
import { renderCapabilityDts } from '../capability/dts.js';
import { listCapabilities, locatorsForEntities } from '../capability/store.js';
import { queryClaims } from '../store/claims.js';
import { CATALOG_SOURCE, CATALOG_VIEWS, catalogQuery } from '../store/catalog.js';
import { TemporalError, resolveScopeFilter, resolveTemporal } from '../store/resolver.js';
import { syncTraces } from '../traces/sync.js';
import { runDream } from '../dream/dream.js';
import { generateWiki } from '../wiki/generate.js';
import { validateOkfBundle } from '../okf/index.js';
import { resolveKnowledgeLink } from '../obsidian/links.js';
import {
  getSuggestion,
  knowledgeStats,
  listDatasets,
  listDocuments,
  listEntities,
  listSuggestions,
  listTraces,
  setSuggestionStatus,
} from '../store/queries.js';
import { WorkspaceContextRegistry, WorkspaceScope, resolveWorkspaceScope, workspaceDataDir } from './workspaces.js';

/** Comma-separated query parameter → array (absent/empty stays undefined). */
function csv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const out = value.split(',').map((x) => x.trim()).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type ExtractionConfigDraft = {
  entityLlm?: Partial<RoutedLlmConfig>;
  conceptLlm?: Partial<RoutedLlmConfig>;
  documentLlm?: Partial<RoutedLlmConfig>;
  claims?: boolean;
  dailyTokenBudget?: number;
  batchSize?: number;
  concurrency?: number;
};

type ModelConfigDraft = {
  embedding?: Partial<EmbeddingConfig>;
  llm?: Partial<LlmConfig>;
  extraction?: ExtractionConfigDraft;
  retrieval?: { sag?: Partial<SagSearchConfig> };
};

const LLM_PROVIDERS: LlmProvider[] = ['openai', 'codex-cli', 'claude-cli', 'cursor-cli'];

type AppEnv = {
  Variables: {
    workspaceContext: AppContext;
    workspaceScope: WorkspaceScope;
  };
};

function mergeLlmConfig(current: LlmConfig, incoming: Partial<LlmConfig> = {}): LlmConfig {
  const cliTimeout = Number(incoming.cliTimeoutMs);
  return {
    provider: incoming.provider && LLM_PROVIDERS.includes(incoming.provider) ? incoming.provider : current.provider,
    baseUrl: typeof incoming.baseUrl === 'string' ? incoming.baseUrl.trim() : current.baseUrl,
    apiKey: incoming.apiKey === '***' || incoming.apiKey === undefined ? current.apiKey : String(incoming.apiKey),
    model: typeof incoming.model === 'string' ? incoming.model.trim() : current.model,
    cliPath: typeof incoming.cliPath === 'string' ? incoming.cliPath.trim() : current.cliPath,
    cliTimeoutMs: Number.isFinite(cliTimeout) && cliTimeout >= 1000 ? Math.floor(cliTimeout) : current.cliTimeoutMs,
  };
}

function mergeRoutedLlmConfig(current: RoutedLlmConfig, incoming: Partial<RoutedLlmConfig> = {}): RoutedLlmConfig {
  const cliTimeout = Number(incoming.cliTimeoutMs);
  const provider = incoming.provider;
  return {
    provider: provider === 'inherit' || (provider && LLM_PROVIDERS.includes(provider)) ? provider : current.provider,
    baseUrl: typeof incoming.baseUrl === 'string' ? incoming.baseUrl.trim() : current.baseUrl,
    apiKey: incoming.apiKey === '***' || incoming.apiKey === undefined ? current.apiKey : String(incoming.apiKey),
    model: typeof incoming.model === 'string' ? incoming.model.trim() : current.model,
    cliPath: typeof incoming.cliPath === 'string' ? incoming.cliPath.trim() : current.cliPath,
    cliTimeoutMs: Number.isFinite(cliTimeout) && cliTimeout >= 1000 ? Math.floor(cliTimeout) : current.cliTimeoutMs,
  };
}

async function testLlmConfig(config: LlmConfig): Promise<unknown> {
  const client = new LlmClient(config);
  if (!client.enabled) return { ok: true, enabled: false, note: 'no model set — this route is disabled' };
  const t0 = Date.now();
  const reply = await client.complete([{ role: 'user', content: 'Reply with exactly the word: pong' }], { maxTokens: 8 });
  return { ok: true, enabled: true, model: client.label, sample: reply.trim().slice(0, 120), ms: Date.now() - t0 };
}

export function createApp(
  rootCtx: AppContext,
  log: (msg: string) => void = console.log,
  workspaceContexts = new WorkspaceContextRegistry(rootCtx.dataDir, { templateConfig: rootCtx.config }),
) {
  const app = new Hono<AppEnv>();
  const ingestRunning = new Set<string>();

  const err = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) });
  /** 400 for a request the caller can fix (a bad time window, an unknown kind), 500 otherwise. */
  const status = (e: unknown, fallback: 400 | 500 = 500): 400 | 500 => (e instanceof TemporalError ? 400 : fallback);
  const requestCtx = (c: { get: (key: 'workspaceContext') => AppContext }) => c.get('workspaceContext');

  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/health' || c.req.path === '/api/workspaces') return next();
    try {
      const scope = resolveWorkspaceScope({
        user: c.req.header('x-knode-user'),
        kind: c.req.header('x-knode-workspace-kind'),
        id: c.req.header('x-knode-workspace-id'),
        name: c.req.header('x-knode-workspace-name'),
      });
      c.set('workspaceScope', scope);
      if (scope.kind === 'personal' && !workspaceContexts.exists(scope)) {
        return c.json({ error: `workspace "${scope.name}" does not exist` }, 404);
      }
      if (c.req.path === '/api/workspace' && c.req.method === 'DELETE') return next();
      c.set('workspaceContext', await workspaceContexts.get(scope));
      await next();
    } catch (e) {
      return c.json(err(e), 401);
    }
  });

  /* ------------------------------- system ------------------------------- */

  app.get('/api/health', (c) => c.json({ ok: true, dataRoot: rootCtx.dataDir, workspaceIsolation: true }));

  app.get('/api/workspaces', (c) => {
    try {
      const user = c.req.header('x-knode-user');
      if (!user) return c.json({ error: 'username is required' }, 401);
      return c.json(workspaceContexts.listUserWorkspaces(user));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.post('/api/workspaces', async (c) => {
    try {
      const user = c.req.header('x-knode-user');
      if (!user) return c.json({ error: 'username is required' }, 401);
      const { name } = await c.req.json<{ name: string }>();
      return c.json(workspaceContexts.createUserWorkspace(user, name), 201);
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.delete('/api/workspace', async (c) => {
    const scope = c.get('workspaceScope');
    const dataDir = workspaceDataDir(rootCtx.dataDir, scope);
    if (ingestRunning.has(dataDir)) return c.json({ error: 'ingest running — try again shortly' }, 409);
    try {
      await workspaceContexts.reset(scope);
      return c.json({ ok: true });
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  app.get('/api/config', (c) => {
    const ctx = requestCtx(c);
    return c.json(redactConfig(ctx.config));
  });

  // Test a draft model configuration without persisting it. An apiKey of '***'
  // means "keep the current secret" (GET /api/config redacts literal keys).
  app.post('/api/config/test', async (c) => {
    const ctx = requestCtx(c);
    const draft = (await c.req.json().catch(() => ({}))) as ModelConfigDraft;
    const out: { embedding: unknown; llm: unknown; entityLlm: unknown; conceptLlm: unknown; documentLlm: unknown } = {
      embedding: null, llm: null, entityLlm: null, conceptLlm: null, documentLlm: null,
    };

    try {
      const e: EmbeddingConfig = { ...ctx.config.embedding, ...(draft.embedding ?? {}) };
      if (e.apiKey === '***') e.apiKey = ctx.config.embedding.apiKey;
      const provider = createEmbeddingProvider(e);
      const t0 = Date.now();
      const [vec] = await provider.embed(['knode-os configuration connectivity test']);
      out.embedding = { ok: true, provider: e.provider, model: provider.model, dimensions: vec.length, ms: Date.now() - t0 };
    } catch (e) {
      out.embedding = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    const baseLlm = mergeLlmConfig(ctx.config.llm, draft.llm);
    const entityRoute = mergeRoutedLlmConfig(ctx.config.extraction.entityLlm, draft.extraction?.entityLlm);
    const conceptRoute = mergeRoutedLlmConfig(ctx.config.extraction.conceptLlm, draft.extraction?.conceptLlm);
    const documentRoute = mergeRoutedLlmConfig(ctx.config.extraction.documentLlm, draft.extraction?.documentLlm);
    try {
      out.llm = await testLlmConfig(baseLlm);
    } catch (e) {
      out.llm = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const routedTests: Array<[keyof Pick<typeof out, 'entityLlm' | 'conceptLlm' | 'documentLlm'>, RoutedLlmConfig, string]> = [
      ['entityLlm', entityRoute, ctx.config.extraction.tier1Model],
      ['conceptLlm', conceptRoute, ctx.config.extraction.tier2Model],
      ['documentLlm', documentRoute, ''],
    ];
    for (const [key, route, legacyModel] of routedTests) {
      const fullyInherited = route.provider === 'inherit' && !route.baseUrl && !route.apiKey && !route.model && !route.cliPath;
      if (fullyInherited && !legacyModel) {
        out[key] = { ...(out.llm as Record<string, unknown>), inherited: true };
        continue;
      }
      try {
        out[key] = await testLlmConfig(resolveRoutedLlmConfig(baseLlm, route, legacyModel));
      } catch (e) {
        out[key] = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    return c.json(out);
  });

  // Persist + hot-apply embedding/llm config. Re-embeds the corpus when the
  // embedding provider/model/dimensions changed.
  app.put('/api/config', async (c) => {
    const ctx = requestCtx(c);
    if (ingestRunning.has(ctx.dataDir)) return c.json({ error: 'ingest running — try again shortly' }, 409);
    try {
      const incoming = (await c.req.json()) as ModelConfigDraft;
      const next: KnodeConfig = JSON.parse(JSON.stringify(ctx.config));

      if (incoming.embedding) {
        const e = incoming.embedding;
        const dims = Number(e.dimensions);
        next.embedding = {
          provider: e.provider === 'openai' ? 'openai' : 'local',
          baseUrl: typeof e.baseUrl === 'string' ? e.baseUrl.trim() : next.embedding.baseUrl,
          apiKey: e.apiKey === '***' || e.apiKey === undefined ? next.embedding.apiKey : String(e.apiKey),
          model: typeof e.model === 'string' ? e.model.trim() : next.embedding.model,
          dimensions: Number.isFinite(dims) && dims >= 1 ? Math.floor(dims) : next.embedding.dimensions,
          batchSize: next.embedding.batchSize,
          sendDimensions: typeof e.sendDimensions === 'boolean' ? e.sendDimensions : next.embedding.sendDimensions,
        };
      }
      if (incoming.llm) {
        next.llm = mergeLlmConfig(next.llm, incoming.llm);
      }
      if (incoming.extraction) {
        const x = incoming.extraction;
        if (x.entityLlm) {
          next.extraction.entityLlm = mergeRoutedLlmConfig(next.extraction.entityLlm, x.entityLlm);
          next.extraction.tier1Model = '';
        }
        if (x.conceptLlm) {
          next.extraction.conceptLlm = mergeRoutedLlmConfig(next.extraction.conceptLlm, x.conceptLlm);
          next.extraction.tier2Model = '';
        }
        if (x.documentLlm) {
          next.extraction.documentLlm = mergeRoutedLlmConfig(next.extraction.documentLlm, x.documentLlm);
        }
        if (typeof x.claims === 'boolean') next.extraction.claims = x.claims;
        const budget = Number(x.dailyTokenBudget);
        const batchSize = Number(x.batchSize);
        const concurrency = Number(x.concurrency);
        if (Number.isFinite(budget) && budget >= 0) next.extraction.dailyTokenBudget = Math.floor(budget);
        if (Number.isFinite(batchSize) && batchSize >= 1) next.extraction.batchSize = Math.floor(batchSize);
        if (Number.isFinite(concurrency) && concurrency >= 1) next.extraction.concurrency = Math.floor(concurrency);
      }
      if (incoming.retrieval?.sag) {
        const sag = incoming.retrieval.sag;
        const setInt = (key: keyof Omit<SagSearchConfig, 'directRatio'>, min: number, max: number) => {
          const value = Number(sag[key]);
          if (Number.isFinite(value)) next.retrieval.sag[key] = Math.min(max, Math.max(min, Math.floor(value)));
        };
        setInt('seedChunks', 1, 100);
        setInt('entityFrontier', 1, 200);
        setInt('maxEventsPerEntity', 1, 100);
        setInt('candidatePool', 1, 500);
        setInt('maxHops', 1, 4);
        const directRatio = Number(sag.directRatio);
        if (Number.isFinite(directRatio)) next.retrieval.sag.directRatio = Math.min(1, Math.max(0, directRatio));
      }

      const reembed =
        next.embedding.provider !== ctx.config.embedding.provider ||
        next.embedding.model !== ctx.config.embedding.model ||
        next.embedding.dimensions !== ctx.config.embedding.dimensions ||
        next.embedding.sendDimensions !== ctx.config.embedding.sendDimensions;
      const dimChanged = next.embedding.dimensions !== ctx.config.embedding.dimensions;
      const previousDocumentLlm = resolveRoutedLlmConfig(ctx.config.llm, ctx.config.extraction.documentLlm);
      const nextDocumentLlm = resolveRoutedLlmConfig(next.llm, next.extraction.documentLlm);
      const reconvert =
        previousDocumentLlm.provider !== nextDocumentLlm.provider ||
        previousDocumentLlm.model !== nextDocumentLlm.model ||
        previousDocumentLlm.baseUrl !== nextDocumentLlm.baseUrl ||
        previousDocumentLlm.cliPath !== nextDocumentLlm.cliPath;

      saveConfig(ctx.dataDir, next);
      ctx.config = next;
      ctx.llm = new LlmClient(next.llm);
      ctx.embedder = createEmbeddingProvider(next.embedding);

      let reindex: Awaited<ReturnType<typeof sync>> | null = null;
      if (reembed || reconvert) {
        ingestRunning.add(ctx.dataDir);
        try {
          // a new embedding model re-applies every document scope (chunks are
          // reused, only missing vectors are computed); a new dimension
          // rebuilds the embeddings table first
          if (reembed && dimChanged) await ctx.store.setEmbeddingDimension(next.embedding.dimensions);
          reindex = await sync(ctx, { onProgress: log });
        } finally {
          ingestRunning.delete(ctx.dataDir);
        }
      }
      return c.json({ ok: true, config: redactConfig(next), reembedded: reembed, reconverted: reconvert, reindex });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.get('/api/stats', async (c) => {
    const ctx = requestCtx(c);
    const row = await knowledgeStats(ctx.store);
    const lastDream = await ctx.store.getMeta('last_dream');
    return c.json({ ...row, lastDream: lastDream ?? null, embeddingModel: ctx.embedder.model, llmModel: ctx.llm.enabled ? ctx.llm.label : null });
  });

  /* ------------------------------- files -------------------------------- */

  app.get('/api/tree', (c) => {
    const ctx = requestCtx(c);
    try {
      return c.json(listTree(ctx.dataDir, c.req.query('path') ?? '.'));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.get('/api/file', (c) => {
    const ctx = requestCtx(c);
    try {
      const p = c.req.query('path');
      if (!p) return c.json({ error: 'path required' }, 400);
      const asked = Number(c.req.query('maxBytes'));
      const cap = Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_FILE_BYTES) : MAX_PREVIEW_BYTES;
      const file = readFileTextCapped(ctx.dataDir, p, cap);
      return c.json({ path: p, content: file.content, bytes: file.bytes, truncated: file.truncated });
    } catch (e) {
      return c.json(err(e), 404);
    }
  });

  app.get('/api/link/resolve', (c) => {
    const ctx = requestCtx(c);
    try {
      const target = c.req.query('target');
      const from = c.req.query('from');
      if (!target || !from) return c.json({ error: 'target and from required' }, 400);
      const resolved = resolveKnowledgeLink(ctx.dataDir, from, target);
      if (!resolved) return c.json({ error: `link target not found: ${target}` }, 404);
      return c.json(resolved);
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.put('/api/file', async (c) => {
    const ctx = requestCtx(c);
    try {
      const { path: p, content } = await c.req.json<{ path: string; content: string }>();
      if (!p || typeof content !== 'string') return c.json({ error: 'path and content required' }, 400);
      assertWritablePath(p);
      writeFileText(ctx.dataDir, p, content);
      return c.json({ ok: true });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.delete('/api/file', async (c) => {
    const ctx = requestCtx(c);
    try {
      const p = c.req.query('path');
      if (!p) return c.json({ error: 'path required' }, 400);
      if (['wiki', 'raw', 'raw/docs', '.', '', 'purpose.md', 'schema.md', 'knode.config.json'].includes(p)) {
        return c.json({ error: 'refusing to delete a root path' }, 400);
      }
      assertWritablePath(p);
      removePath(ctx.dataDir, p);
      // deleting a source is a dispose: everything it produced is reverted,
      // history stays queryable with as_of (use /api/forget to purge it)
      const stats = await sync(ctx, { only: [p], onProgress: log });
      return c.json({ ok: true, disposed: stats.disposed, pagesArchived: stats.pagesArchived });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.post('/api/mkdir', async (c) => {
    const ctx = requestCtx(c);
    try {
      const { path: p } = await c.req.json<{ path: string }>();
      const rel = sanitizeRelativePath(p ?? '');
      if (!rel) return c.json({ error: 'path required' }, 400);
      assertWritablePath(rel);
      makeDir(ctx.dataDir, rel);
      return c.json({ ok: true, path: rel });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  // A move is a pure filesystem operation: the doc's scope key is its path, so
  // the knowledge only follows once an ingest reconciles the old key away and
  // applies the new one. Batch callers move everything first and ingest once,
  // the way uploads do — syncing per file would re-cook raw/docs each time.
  app.post('/api/mv', async (c) => {
    const ctx = requestCtx(c);
    try {
      const { from, to } = await c.req.json<{ from: string; to: string }>();
      if (!from || !to) return c.json({ error: 'from and to required' }, 400);
      const src = sanitizeRelativePath(from);
      const dst = sanitizeRelativePath(to);
      if (!src || !dst) return c.json({ error: 'from and to required' }, 400);
      assertWritablePath(src);
      assertWritablePath(dst);
      if (src === dst) return c.json({ ok: true, from: src, to: dst });
      // renameSync replaces the destination without a word, which in a batch
      // move would silently destroy a same-named file already sitting there
      if (pathExists(ctx.dataDir, dst)) return c.json({ error: `already exists: ${dst}` }, 409);
      if (!pathExists(ctx.dataDir, src)) return c.json({ error: `no such path: ${src}` }, 404);
      movePath(ctx.dataDir, src, dst);
      return c.json({ ok: true, from: src, to: dst });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.post('/api/upload', async (c) => {
    const ctx = requestCtx(c);
    try {
      const form = await c.req.formData();
      // sanitize before the prefix check: "raw/docs/../../x" would pass it
      const dir = sanitizeRelativePath((form.get('dir') as string) || '') || 'raw/docs';
      if (!/^(raw\/docs|wiki)(\/|$)/.test(dir)) return c.json({ error: 'uploads go to raw/docs or wiki' }, 400);
      const saved: string[] = [];
      for (const [, v] of form.entries()) {
        if (!(v instanceof File)) continue;
        // folder uploads carry the path inside the dropped folder as the
        // filename ("notes/2026/kickoff.md"), so the subtree is recreated
        const name = sanitizeRelativePath(v.name);
        if (!name) continue;
        const rel = `${dir}/${name}`.replace(/\/+/g, '/');
        if (pathExists(ctx.dataDir, rel)) {
          const ext = path.extname(name);
          const stem = name.slice(0, name.length - ext.length);
          const alt = `${dir}/${stem}-${Date.now()}${ext}`;
          writeFileBytes(ctx.dataDir, alt, new Uint8Array(await v.arrayBuffer()));
          saved.push(alt);
        } else {
          writeFileBytes(ctx.dataDir, rel, new Uint8Array(await v.arrayBuffer()));
          saved.push(rel);
        }
      }
      return c.json({ ok: true, saved });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  /* ----------------------------- knowledge ------------------------------ */

  app.post('/api/ingest', async (c) => {
    const ctx = requestCtx(c);
    if (ingestRunning.has(ctx.dataDir)) return c.json({ error: 'ingest already running' }, 409);
    ingestRunning.add(ctx.dataDir);
    try {
      const stats = await sync(ctx, { onProgress: log });
      return c.json(stats);
    } catch (e) {
      return c.json(err(e), 500);
    } finally {
      ingestRunning.delete(ctx.dataDir);
    }
  });

  app.post('/api/sync', async (c) => {
    const ctx = requestCtx(c);
    if (ingestRunning.has(ctx.dataDir)) return c.json({ error: 'sync already running' }, 409);
    ingestRunning.add(ctx.dataDir);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { only?: string[]; verify?: boolean };
      return c.json(await sync(ctx, { only: Array.isArray(body.only) ? body.only.map(String) : undefined, verify: Boolean(body.verify), onProgress: log }));
    } catch (e) {
      return c.json(err(e), 500);
    } finally {
      ingestRunning.delete(ctx.dataDir);
    }
  });

  /* ------------------------------- lineage ------------------------------ */

  app.get('/api/lineage', async (c) => {
    const ctx = requestCtx(c);
    const kind = c.req.query('kind');
    const id = c.req.query('id');
    if (!id || !['entity', 'relation', 'claim', 'page', 'document'].includes(kind ?? '')) {
      return c.json({ error: 'kind (entity|relation|claim|page|document) and id required' }, 400);
    }
    try {
      return c.json(await lineageOf(ctx.store, kind as 'entity', id));
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  app.get('/api/history', async (c) => {
    const ctx = requestCtx(c);
    const p = c.req.query('path');
    if (!p) return c.json({ error: 'path required' }, 400);
    return c.json(await historyOf(ctx.store, ctx.dataDir, p));
  });

  app.post('/api/forget', async (c) => {
    const ctx = requestCtx(c);
    if (ingestRunning.has(ctx.dataDir)) return c.json({ error: 'sync running — try again shortly' }, 409);
    try {
      const { path: p } = await c.req.json<{ path: string }>();
      if (!p) return c.json({ error: 'path required' }, 400);
      assertWritablePath(p);
      return c.json(await forgetSource(ctx, p));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.post('/api/purge', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { before?: string; archived?: boolean };
      const out: Record<string, unknown> = {};
      if (body.archived) out.archivedRemoved = purgeArchived(ctx.dataDir);
      if (body.before || !body.archived) out.disposed = await purgeDisposed(ctx.store, { before: body.before, actor: 'api' });
      return c.json(out);
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.post('/api/rebuild', async (c) => {
    const ctx = requestCtx(c);
    if (ingestRunning.has(ctx.dataDir)) return c.json({ error: 'sync running — try again shortly' }, 409);
    ingestRunning.add(ctx.dataDir);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { history?: boolean };
      return c.json(await rebuild(ctx, { history: Boolean(body.history), onProgress: log }));
    } catch (e) {
      return c.json(err(e), 500);
    } finally {
      ingestRunning.delete(ctx.dataDir);
    }
  });

  app.get('/api/search', async (c) => {
    const ctx = requestCtx(c);
    const q = c.req.query('q');
    if (!q) return c.json({ error: 'q required' }, 400);
    const k = Number(c.req.query('k') ?? 8);
    const modeParam = c.req.query('mode') ?? 'hybrid';
    if (!['hybrid', 'vector', 'keyword', 'sag'].includes(modeParam)) {
      return c.json({ error: `unsupported search mode: ${modeParam}` }, 400);
    }
    const mode = modeParam as SearchMode;
    try {
      return c.json(await search(ctx.store, ctx.embedder, q, {
        k,
        mode,
        heat: ctx.config.heat,
        sag: ctx.config.retrieval.sag,
        asOf: c.req.query('as_of') || undefined,
        filter: resolveScopeFilter({ kinds: csv(c.req.query('kinds')), sources: csv(c.req.query('sources')) }),
      }));
    } catch (e) {
      return c.json(err(e), status(e));
    }
  });

  app.post('/api/ask', async (c) => {
    const ctx = requestCtx(c);
    try {
      const { question, mode = 'hybrid' } = await c.req.json<{ question: string; mode?: SearchMode }>();
      if (!question) return c.json({ error: 'question required' }, 400);
      if (!['hybrid', 'vector', 'keyword', 'sag'].includes(mode)) {
        return c.json({ error: `unsupported search mode: ${mode}` }, 400);
      }
      return c.json(await ask(ctx.store, ctx.config, ctx.embedder, ctx.llm, question, { mode }));
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  app.get('/api/graph', async (c) => {
    const ctx = requestCtx(c);
    try {
      const q = c.req.query('q');
      const depth = Number(c.req.query('depth') ?? 2);
      if (q) {
        return c.json(await graphSearch(ctx.store, q, {
          depth,
          heat: ctx.config.heat,
          temporal: resolveTemporal({
            asOf: c.req.query('as_of') || undefined,
            validAt: c.req.query('valid_at') || undefined,
            validRange: c.req.query('valid_range') || undefined,
          }),
          filter: resolveScopeFilter({ kinds: csv(c.req.query('kinds')), sources: csv(c.req.query('sources')) }),
        }));
      }
      return c.json(await graphOverview(ctx.store, Number(c.req.query('limit') ?? 120)));
    } catch (e) {
      return c.json(err(e), status(e));
    }
  });

  app.get('/api/claims', async (c) => {
    const ctx = requestCtx(c);
    try {
      return c.json(await queryClaims(ctx.store, {
        subject: c.req.query('subject') || undefined,
        object: c.req.query('object') || undefined,
        types: csv(c.req.query('types')),
        statuses: csv(c.req.query('status')),
        text: c.req.query('text') || undefined,
        limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
        temporal: resolveTemporal({
          asOf: c.req.query('as_of') || undefined,
          validAt: c.req.query('valid_at') || undefined,
          validRange: c.req.query('valid_range') || undefined,
        }),
        filter: resolveScopeFilter({ kinds: csv(c.req.query('kinds')), sources: csv(c.req.query('sources')) }),
      }));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.get('/api/graph/insights', async (c) => {
    const ctx = requestCtx(c);
    return c.json(await graphInsights(ctx.store));
  });

  app.get('/api/entities', async (c) => {
    const ctx = requestCtx(c);
    return c.json(await listEntities(ctx.store, c.req.query('q')));
  });

  app.get('/api/documents', async (c) => {
    const ctx = requestCtx(c);
    return c.json(await listDocuments(ctx.store));
  });

  app.get('/api/okf/validate', (c) => {
    const ctx = requestCtx(c);
    try {
      return c.json(validateOkfBundle(safePath(ctx.dataDir, c.req.query('path') ?? 'wiki')));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.post('/api/wiki/generate', async (c) => {
    const ctx = requestCtx(c);
    try {
      return c.json({ created: await generateWiki(ctx.store, ctx.llm, { config: ctx.config, onProgress: log }) });
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  app.get('/api/grep', (c) => {
    const ctx = requestCtx(c);
    try {
      const pattern = c.req.query('pattern');
      if (!pattern) return c.json({ error: 'pattern required' }, 400);
      return c.json(grepFiles(ctx.dataDir, pattern, {
        path: c.req.query('path') || undefined,
        maxMatches: Number(c.req.query('maxMatches') ?? 100),
      }));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  /* --------------------------- live datasources -------------------------- */

  app.post('/api/resolve', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = await c.req.json<{
        query: string; actor?: string; render?: 'json-graph' | 'ts-program'; record?: boolean;
        maxToolCalls?: number; asOf?: string; validAt?: string; validRange?: string; freshness?: string;
        kinds?: string[]; sources?: string[]; trust?: string; workset?: string;
      }>();
      if (!body.query) return c.json({ error: 'query required' }, 400);
      return c.json(await resolve(ctx, body.query, {
        actor: body.actor,
        render: body.render,
        record: body.record,
        budget: body.maxToolCalls ? { maxToolCalls: body.maxToolCalls } : undefined,
        temporal: await envelopeFor(ctx.store, {
          workset: body.workset, asOf: body.asOf, validAt: body.validAt, validRange: body.validRange, freshness: body.freshness,
        }),
        filter: resolveScopeFilter({ kinds: body.kinds, sources: body.sources, trust: body.trust, actor: body.actor }),
      }));
    } catch (e) {
      return c.json(err(e), status(e));
    }
  });

  app.post('/api/plan', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = await c.req.json<{ query: string; render?: 'json-graph' | 'ts-program'; maxToolCalls?: number; asOf?: string; freshness?: string }>();
      if (!body.query) return c.json({ error: 'query required' }, 400);
      return c.json(await planOnly(ctx, body.query, {
        render: body.render,
        budget: body.maxToolCalls ? { maxToolCalls: body.maxToolCalls } : undefined,
        temporal: resolveTemporal({ asOf: body.asOf, freshness: body.freshness }),
      }));
    } catch (e) {
      return c.json(err(e), status(e));
    }
  });

  app.post('/api/feedback', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = await c.req.json<Parameters<typeof recordFeedback>[1]>();
      if (!body.receiptId) return c.json({ error: 'receiptId required' }, 400);
      return c.json(await recordFeedback(ctx.store, body));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.post('/api/worksets', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = await c.req.json<{ actor?: string; note?: string; asOf?: string; entities?: string[] }>()
        .catch(() => ({} as { actor?: string; note?: string; asOf?: string; entities?: string[] }));
      return c.json(await checkout(ctx.store, body));
    } catch (e) {
      return c.json(err(e), status(e, 400));
    }
  });

  app.get('/api/worksets', async (c) => {
    const ctx = requestCtx(c);
    return c.json(await listWorksets(ctx.store, { actor: c.req.query('actor') || undefined, open: c.req.query('open') === 'true' }));
  });

  app.post('/api/worksets/:id/commit', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = await c.req.json<{ content: string; title?: string; path?: string; keepOpen?: boolean }>();
      if (!body.content) return c.json({ error: 'content required' }, 400);
      return c.json(await commitWorkset(ctx, { worksetId: c.req.param('id'), ...body }));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.get('/api/absences', async (c) => {
    const ctx = requestCtx(c);
    const entities = csv(c.req.query('entities'));
    if (!entities) return c.json({ error: 'entities required' }, 400);
    return c.json(await liveAbsences(ctx.store, entities, c.req.query('as_of') || undefined));
  });

  app.get('/api/disputes', async (c) => {
    const ctx = requestCtx(c);
    return c.json(await listDisputes(ctx.store, { status: c.req.query('status') ?? 'open' }));
  });

  app.post('/api/disputes/:id/resolve', async (c) => {
    const ctx = requestCtx(c);
    const body = await c.req.json<{ actor?: string }>().catch(() => ({} as { actor?: string }));
    return c.json({ resolved: await resolveDispute(ctx.store, c.req.param('id'), body.actor) });
  });

  app.post('/api/trust', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = await c.req.json<{ path: string; to: 'trusted' | 'quarantined'; actor?: string }>();
      if (!body.path || !body.to) return c.json({ error: 'path and to required' }, 400);
      return c.json(await setScopeTrust(ctx.store, { key: body.path, to: body.to, actor: body.actor }));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.get('/api/subscriptions', async (c) => {
    const ctx = requestCtx(c);
    return c.json(await listSubscriptions(ctx.store, c.req.query('actor') || undefined));
  });

  app.post('/api/subscriptions', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = await c.req.json<{ kind: 'entity' | 'source' | 'intent'; target: string; actor?: string }>();
      if (!body.kind || !body.target) return c.json({ error: 'kind and target required' }, 400);
      return c.json(await subscribe(ctx.store, body));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.delete('/api/subscriptions/:id', async (c) => {
    const ctx = requestCtx(c);
    return c.json({ removed: await unsubscribe(ctx.store, c.req.param('id')) });
  });

  app.get('/api/subscriptions/:id/changes', async (c) => {
    const ctx = requestCtx(c);
    try {
      return c.json(await changesSince(ctx.store, c.req.param('id'), {
        limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
        advance: c.req.query('peek') !== 'true',
      }));
    } catch (e) {
      return c.json(err(e), 404);
    }
  });

  app.get('/api/learning', async (c) => {
    const ctx = requestCtx(c);
    const lookbackDays = c.req.query('lookback') ? Number(c.req.query('lookback')) : undefined;
    const intent = c.req.query('intent') || undefined;
    const ranking = await writeRankerReport(ctx.store, { intent });
    const evaluation = await evaluatePacks(ctx.store, { lookbackDays });
    const evalPath = writeEvalReport(ctx.dataDir, evaluation);
    const distilled = c.req.query('distill') === 'true' ? await distillRecipes(ctx.store, { lookbackDays, intent }) : null;
    return c.json({ ranking, evaluation, evalPath, distilled });
  });

  app.get('/api/receipts', async (c) => {
    const ctx = requestCtx(c);
    return c.json(await listReceipts(ctx.store, {
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
      intent: c.req.query('intent') || undefined,
    }));
  });

  app.get('/api/vfs', async (c) => {
    const ctx = requestCtx(c);
    const p = c.req.query('path');
    if (!p) return c.json({ error: 'path required' }, 400);
    try {
      return c.text(await readVirtual(ctx, p.startsWith('/') ? p : `/${p}`));
    } catch (e) {
      return c.json(err(e), 404);
    }
  });

  app.get('/api/capabilities', async (c) => {
    const ctx = requestCtx(c);
    try {
      const entity = c.req.query('entity') || undefined;
      const asOf = c.req.query('as_of') || undefined;
      const capabilities = await listCapabilities(ctx.store, {
        sourceIds: csv(c.req.query('source')),
        kinds: csv(c.req.query('kind')),
        entityIds: entity ? [entity] : undefined,
        asOf,
      });
      if (c.req.query('format') === 'dts') return c.text(renderCapabilityDts(capabilities));
      const locators = entity ? await locatorsForEntities(ctx.store, [entity], asOf) : [];
      return c.json({ capabilities, locators });
    } catch (e) {
      return c.json(err(e), status(e, 400));
    }
  });

  app.get('/api/datasources', async (c) => {
    const ctx = requestCtx(c);
    const datasets = await listDatasets(ctx.store);
    return c.json({
      sources: [
        ...ctx.config.datasources.map((d) => ({ id: d.id, kind: d.kind, description: d.description ?? '' })),
        { id: CATALOG_SOURCE, kind: 'catalog', description: 'the knowledge base itself, as read-only SQL views' },
      ],
      catalog: CATALOG_VIEWS,
      datasets,
    });
  });

  app.post('/api/datasources/sync', async (c) => {
    const ctx = requestCtx(c);
    try {
      const stats = await sync(ctx, { only: ['datasources'], onProgress: log });
      return c.json({ sources: ctx.config.datasources.length, wikiPages: stats.pagesRegenerated, errors: stats.datasourceErrors, disposed: stats.disposed });
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  app.post('/api/datasources/:id/query', async (c) => {
    const ctx = requestCtx(c);
    try {
      const { sql, maxRows } = await c.req.json<{ sql: string; maxRows?: number }>();
      if (!sql) return c.json({ error: 'sql required' }, 400);
      const id = c.req.param('id');
      if (id === CATALOG_SOURCE) return c.json(await catalogQuery(ctx.store, sql, { maxRows }));
      return c.json(await runSourceQuery(ctx.datasources, id, sql, { maxRows }));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  /* ------------------------------ context pack --------------------------- */

  app.post('/api/pack', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = await c.req.json<{
        utterance: string; record?: boolean; asOf?: string; validAt?: string;
        validRange?: string; freshness?: string; kinds?: string[]; sources?: string[];
      }>();
      if (!body.utterance) return c.json({ error: 'utterance required' }, 400);
      return c.json(await buildContextPack(ctx, body.utterance, {
        record: body.record,
        temporal: resolveTemporal({ asOf: body.asOf, validAt: body.validAt, validRange: body.validRange, freshness: body.freshness }),
        filter: resolveScopeFilter({ kinds: body.kinds, sources: body.sources }),
      }));
    } catch (e) {
      return c.json(err(e), status(e));
    }
  });

  /* --------------------------- traces & dream --------------------------- */

  app.get('/api/traces', async (c) => {
    const ctx = requestCtx(c);
    return c.json(await listTraces(ctx.store));
  });

  app.post('/api/traces/sync', async (c) => {
    const ctx = requestCtx(c);
    try {
      return c.json(await syncTraces(ctx.store, ctx.config, { ignoreSince: true }));
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  app.get('/api/suggestions', async (c) => {
    const ctx = requestCtx(c);
    return c.json(await listSuggestions(ctx.store, { status: c.req.query('status') }));
  });

  app.post('/api/suggestions/:id/status', async (c) => {
    const ctx = requestCtx(c);
    const { status } = await c.req.json<{ status: string }>();
    if (status !== 'pending' && status !== 'accepted' && status !== 'rejected' && status !== 'stale') return c.json({ error: 'bad status' }, 400);
    const id = c.req.param('id');
    await setSuggestionStatus(ctx.store, id, status);
    // machine-actionable suggestions (playbook revisions) take effect on accept
    let applied: { applied: boolean; path?: string } = { applied: false };
    if (status === 'accepted') {
      const s = await getSuggestion(ctx.store, id);
      if (s?.kind === 'pack') applied = await applySuggestion(ctx.store, ctx.dataDir, id);
    }
    return c.json({ ok: true, ...applied });
  });

  app.post('/api/dream', async (c) => {
    const ctx = requestCtx(c);
    try {
      const res = await runDream(ctx.store, ctx.config, ctx.llm, { onProgress: log });
      return c.json(res);
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  /* ------------------------------ static UI ----------------------------- */

  const webDir = findWebDir();
  const markedJs = findMarkedUmd();
  app.get('/vendor/marked.js', (c) => {
    if (!markedJs) return c.text('window.marked=null;', 200, { 'content-type': 'text/javascript' });
    return c.text(fs.readFileSync(markedJs, 'utf8'), 200, { 'content-type': 'text/javascript' });
  });
  app.get('/*', (c) => {
    if (!webDir) return c.text('web UI assets not found', 404);
    let rel = c.req.path.replace(/^\/+/, '') || 'index.html';
    if (!fs.existsSync(path.join(webDir, rel)) || fs.statSync(path.join(webDir, rel)).isDirectory()) rel = 'index.html';
    const abs = path.resolve(webDir, rel);
    if (!abs.startsWith(path.resolve(webDir))) return c.text('forbidden', 403);
    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
      '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
    };
    const ct = types[path.extname(abs)] ?? 'application/octet-stream';
    return c.body(fs.readFileSync(abs), 200, { 'content-type': ct });
  });

  return app;
}

function findWebDir(): string | null {
  for (const candidate of [
    path.resolve(__dirname, '../../web'), // dist/server → package root
    path.resolve(__dirname, '../../../web'),
    path.resolve(process.cwd(), 'web'),
  ]) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

function findMarkedUmd(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('marked'); // .../marked/lib/marked.cjs
    for (const name of ['marked.umd.js', 'marked.cjs']) {
      const p = path.join(path.dirname(entry), name);
      if (fs.existsSync(p)) return p;
    }
  } catch {
    /* not installed */
  }
  return null;
}
