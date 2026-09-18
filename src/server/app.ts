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
  LlmConnection,
  LlmProvider,
  RoutedLlmConfig,
  SagSearchConfig,
  redactConfig,
  resolveRoutedLlmConfig,
  llmProviderLabel,
  saveConfig, ResearchConfig, ChatConfig } from '../config.js';
import { runSourceQuery } from '../datasource/execute.js';
import { MAX_FILE_BYTES, MAX_PREVIEW_BYTES } from '../constants.js';
import { assertSourcePath, assertWritablePath, cleanRelPath, grepFiles, isRootWritableFile, listTree, makeDir, movePath, pathExists, removePath, safePath, sanitizeRelativePath, writeFileBytes, writeFileText } from '../fs/files.js';
import { hasSidecarSegment, SIDECAR_ROOT } from '../fs/layout.js';
import { moveSidecar } from '../fs/sidecar.js';
import { assertNotConvertedOriginal, readSourceTextCapped } from '../ingest/source.js';
import { graphInsights, graphOverview, graphSearch } from '../graph/query.js';
import { buildContextPack } from '../pack/pack.js';
import { applySuggestion } from '../pack/learn.js';
import { createEmbeddingProvider } from '../ingest/embeddings.js';
import { LlmClient } from '../llm/client.js';
import { cliToolStatus, listChatModels, listEmbeddingModels } from '../llm/models.js';
import { agentForSpec } from '../research/agent.js';
import { availableAgents, suggestResearchAgent } from '../research/executors.js';
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
import { loadOrCreateMcpToken, mountMcp } from './mcp-http.js';
import { applyMerge, listMerges, unmergeEntity } from '../graph/merge.js';
import { auditDuplicateEntities } from '../graph/dedupe.js';
import { reviewClaims } from '../graph/claim-review.js';
import { cancelJob, getJob, latestJob, listJobs, queueJob, retryJob, ResearchStatus } from '../research/jobs.js';
import { killAgentsFor } from '../research/launch.js';
import { loadResearchTemplates, PHASES, RESEARCH_KINDS, ResearchKind } from '../research/templates.js';
import { activeProfile, BUILTIN_PROFILES, deleteProfile, EFFORTS, effectivePipeline, isValidProfileName, loadProfile, loadProfiles, PIPELINE_MODES, profileSummary, ResearchProfile, rolePromptText, saveProfile, writeRolePrompt } from '../research/profile.js';
import { surveyKnowledgeBase } from '../research/survey.js';
import { cancelChatTurn, chatActivity, ChatBusyError, isChatRunning, removeChatWorkspace, resolveChatAgent, startChatTurn } from '../chat/runner.js';
import { createConversation, deleteConversation, getConversation, listConversations } from '../chat/store.js';
import { CHAT_PROTOCOL_FILE, loadChatProtocol, saveChatProtocol } from '../chat/templates.js';
import { CHAT_DIR } from '../fs/layout.js';
import { McpEndpoint, runsRoot } from '../research/workspace.js';
import { recommendWikiTopics, refreshRecommendations } from '../research/recommend.js';
import { lintWiki } from '../wiki/lint.js';

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
  connections?: Partial<LlmConnection>[];
  extraction?: ExtractionConfigDraft;
  retrieval?: { sag?: Partial<SagSearchConfig> };
  research?: Partial<Omit<ResearchConfig, 'auto' | 'init'>> & { auto?: Partial<ResearchConfig['auto']>; init?: Partial<ResearchConfig['init']> };
  chat?: Partial<ChatConfig>;
};

/** What `serve` runs per workspace beside the routes; absent in tests and CLI-hosted apps. */
export interface WorkspaceServices {
  /** The MCP endpoint agents launched for this workspace attach to (null until the server listens). */
  mcp: () => McpEndpoint | null;
  /** Claim queued research now instead of at the next tick. */
  kickResearch: () => void;
  /** Register a background promise so shutdown waits for it. */
  track: <T>(job: Promise<T>) => Promise<T>;
}

/**
 * Paths the workspace is built from: a client may create and delete things
 * inside them, but never rename, move or remove the roots themselves.
 */
const PROTECTED_PATHS = new Set([
  '',
  '.',
  'wiki',
  'raw',
  'raw/docs',
  'playbooks',
  'playbooks/packs',
  'purpose.md',
  'schema.md',
  'knode.config.json',
  'AGENTS.md',
  'CLAUDE.md',
]);

/** A root path is protected however it is spelled (`wiki/..` resolves to the root too). */
function isProtectedPath(rel: string): boolean {
  return PROTECTED_PATHS.has(cleanRelPath(rel)) || PROTECTED_PATHS.has(rel);
}

const LLM_PROVIDERS: LlmProvider[] = ['openai', 'codex-cli', 'claude-cli', 'cursor-cli'];
const EMBEDDING_PROVIDERS: EmbeddingConfig['provider'][] = ['openai', 'ark-multimodal', 'local'];

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
    use: typeof incoming.use === 'string' ? incoming.use.trim() : current.use,
    provider: provider === 'inherit' || (provider && LLM_PROVIDERS.includes(provider)) ? provider : current.provider,
    baseUrl: typeof incoming.baseUrl === 'string' ? incoming.baseUrl.trim() : current.baseUrl,
    apiKey: incoming.apiKey === '***' || incoming.apiKey === undefined ? current.apiKey : String(incoming.apiKey),
    model: typeof incoming.model === 'string' ? incoming.model.trim() : current.model,
    cliPath: typeof incoming.cliPath === 'string' ? incoming.cliPath.trim() : current.cliPath,
    cliTimeoutMs: Number.isFinite(cliTimeout) && cliTimeout >= 1000 ? Math.floor(cliTimeout) : current.cliTimeoutMs,
  };
}

/**
 * Connections replace wholesale — the client owns the list, including order and
 * deletions — but each one keeps its stored secret when the client echoes back
 * the redacted '***', and anything without a usable id is dropped rather than
 * saved as an unreferenceable row.
 */
function mergeConnections(current: LlmConnection[], incoming: Partial<LlmConnection>[] | undefined): LlmConnection[] {
  if (!incoming) return current;
  const out: LlmConnection[] = [];
  for (const draft of incoming) {
    const id = typeof draft.id === 'string' ? draft.id.trim() : '';
    if (!id || id === 'default' || out.some((c) => c.id === id)) continue;
    const previous = current.find((c) => c.id === id);
    const merged = mergeLlmConfig(previous ?? defaultConnectionConfig(), draft);
    out.push({
      ...merged,
      id,
      label: typeof draft.label === 'string' && draft.label.trim() ? draft.label.trim() : previous?.label || llmProviderLabel(merged.provider),
    });
  }
  return out;
}

function defaultConnectionConfig(): LlmConfig {
  return { provider: 'openai', baseUrl: '', apiKey: '', model: '', cliPath: '', cliTimeoutMs: 300_000 };
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
  opts: { services?: (ctx: AppContext) => WorkspaceServices | null } = {},
) {
  const app = new Hono<AppEnv>();
  const ingestRunning = new Set<string>();
  const servicesFor = (ctx: AppContext): WorkspaceServices | null => opts.services?.(ctx) ?? null;

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

  // MCP over Streamable HTTP shares the workspace registry (and therefore the
  // one open index per workspace) with the REST routes; see mcp-http.ts.
  const mcpConfig = rootCtx.config.server.mcp;
  if (!mcpConfig || mcpConfig.enabled !== false) {
    mountMcp(app, {
      path: mcpConfig?.path || '/mcp',
      token: loadOrCreateMcpToken(rootCtx.dataDir),
      registry: workspaceContexts,
    });
  }

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
    const connections = mergeConnections(ctx.config.connections, draft.connections);
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
      const fullyInherited =
        !route.use && route.provider === 'inherit' && !route.baseUrl && !route.apiKey && !route.model && !route.cliPath;
      if (fullyInherited && !legacyModel) {
        out[key] = { ...(out.llm as Record<string, unknown>), inherited: true };
        continue;
      }
      try {
        out[key] = await testLlmConfig(resolveRoutedLlmConfig(baseLlm, route, connections, legacyModel));
      } catch (e) {
        out[key] = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    return c.json(out);
  });

  // Which models a draft route can actually be pointed at. Same '***' apiKey
  // convention as /api/config/test; a route that inherits is resolved against
  // the draft default provider first, so the list matches what would run.
  app.post('/api/config/models', async (c) => {
    const ctx = requestCtx(c);
    const body = (await c.req.json().catch(() => ({}))) as { route?: string; config?: ModelConfigDraft };
    const draft = body.config ?? {};
    const route = body.route ?? 'llm';

    if (route === 'embedding') {
      const e: EmbeddingConfig = { ...ctx.config.embedding, ...(draft.embedding ?? {}) };
      if (e.apiKey === '***') e.apiKey = ctx.config.embedding.apiKey;
      return c.json(await listEmbeddingModels(e));
    }

    const baseLlm = mergeLlmConfig(ctx.config.llm, draft.llm);
    const connections = mergeConnections(ctx.config.connections, draft.connections);
    if (route === 'llm') return c.json(await listChatModels(baseLlm));

    // A named connection can be listed on its own, before any route uses it.
    if (route.startsWith('connection:')) {
      const connection = connections.find((c) => c.id === route.slice('connection:'.length));
      if (!connection) return c.json({ error: `unknown connection: ${route}` }, 400);
      return c.json(await listChatModels(connection));
    }

    if (route !== 'entityLlm' && route !== 'conceptLlm' && route !== 'documentLlm') {
      return c.json({ error: `unknown route: ${route}` }, 400);
    }
    const merged = mergeRoutedLlmConfig(ctx.config.extraction[route], draft.extraction?.[route]);
    return c.json(await listChatModels(resolveRoutedLlmConfig(baseLlm, merged, connections)));
  });

  // Where each coding-agent CLI resolved to on the service PATH — Settings uses
  // this to keep the executable field out of the way when it is redundant.
  app.get('/api/config/cli-tools', (c) => c.json({ tools: cliToolStatus() }));

  // Which executors can actually run here, and which one to preselect when
  // `research.agent` is still empty. Both clients read this instead of each
  // working out its own preference order.
  app.get('/api/config/agents', async (c) => {
    const ctx = requestCtx(c);
    const agents = await availableAgents(ctx.config);
    return c.json({ agents, suggested: suggestResearchAgent(ctx.config, agents) });
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
          provider: e.provider && EMBEDDING_PROVIDERS.includes(e.provider) ? e.provider : 'local',
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
      if (incoming.connections) {
        next.connections = mergeConnections(next.connections, incoming.connections);
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
      if (incoming.research) {
        const r = incoming.research;
        const cur = next.research;
        if (typeof r.agent === 'string') {
          const spec = r.agent.trim();
          // '' is legal (not configured); anything else has to resolve, or the
          // queue would stall with nothing but a log line to show for it
          if (spec && !agentForSpec(next, spec)) return c.json({ error: `unknown research agent "${spec}"` }, 400);
          cur.agent = spec;
        }
        if (typeof r.model === 'string') cur.model = r.model.trim();
        if (typeof r.profile === 'string' && isValidProfileName(r.profile.trim())) cur.profile = r.profile.trim();
        if (typeof r.pipeline === 'string' && (PIPELINE_MODES as readonly string[]).includes(r.pipeline)) cur.pipeline = r.pipeline as ResearchConfig['pipeline'];
        const setInt = (key: 'maxTurns' | 'timeoutMs' | 'concurrency' | 'researchers' | 'reviewRounds' | 'keepRuns', min: number, max: number) => {
          const value = Number(r[key]);
          if (r[key] !== undefined && Number.isFinite(value)) cur[key] = Math.min(max, Math.max(min, Math.floor(value)));
        };
        setInt('maxTurns', 1, 500);
        setInt('timeoutMs', 60_000, 24 * 3_600_000);
        setInt('concurrency', 1, 8);
        setInt('researchers', 1, 16);
        setInt('reviewRounds', 0, 6);
        setInt('keepRuns', 1, 500);
        if (r.auto) {
          if (typeof r.auto.enabled === 'boolean') cur.auto.enabled = r.auto.enabled;
          const daily = Number(r.auto.dailyJobs);
          if (r.auto.dailyJobs !== undefined && Number.isFinite(daily)) cur.auto.dailyJobs = Math.min(50, Math.max(1, Math.floor(daily)));
        }
        if (r.init) {
          cur.init = { ...cur.init };
          const followUps = Number(r.init.followUps);
          if (r.init.followUps !== undefined && Number.isFinite(followUps)) cur.init.followUps = Math.min(20, Math.max(0, Math.floor(followUps)));
          if (r.init.extraction === 'drain' || r.init.extraction === 'skip') cur.init.extraction = r.init.extraction;
          const maxMs = Number(r.init.extractionMaxMs);
          if (r.init.extractionMaxMs !== undefined && Number.isFinite(maxMs)) cur.init.extractionMaxMs = Math.min(3_600_000, Math.max(60_000, Math.floor(maxMs)));
        }
      }
      if (incoming.chat) {
        const ch = incoming.chat;
        const cur = next.chat;
        if (typeof ch.agent === 'string') {
          const spec = ch.agent.trim();
          if (spec && !agentForSpec(next, spec)) return c.json({ error: `unknown chat agent "${spec}"` }, 400);
          cur.agent = spec;
        }
        if (typeof ch.model === 'string') cur.model = ch.model.trim();
        if (typeof ch.effort === 'string' && (EFFORTS as readonly string[]).includes(ch.effort)) cur.effort = ch.effort as ChatConfig['effort'];
        if (ch.web === 'inherit' || ch.web === 'on' || ch.web === 'off') cur.web = ch.web;
        const setInt = (key: 'maxTurns' | 'timeoutMs' | 'historyTurns' | 'keep', min: number, max: number) => {
          const value = Number(ch[key]);
          if (ch[key] !== undefined && Number.isFinite(value)) cur[key] = Math.min(max, Math.max(min, Math.floor(value)));
        };
        setInt('maxTurns', 1, 200);
        setInt('timeoutMs', 60_000, 2 * 3_600_000);
        setInt('historyTurns', 0, 50);
        setInt('keep', 1, 500);
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
      const previousDocumentLlm = resolveRoutedLlmConfig(ctx.config.llm, ctx.config.extraction.documentLlm, ctx.config.connections);
      const nextDocumentLlm = resolveRoutedLlmConfig(next.llm, next.extraction.documentLlm, next.connections);
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

  // the whole base in numbers: documents by folder, entities by type, predicates, claims, wiki pages, the guide
  app.get('/api/survey', async (c) => {
    const ctx = requestCtx(c);
    try {
      return c.json(await surveyKnowledgeBase(ctx));
    } catch (e) {
      return c.json(err(e), 500);
    }
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
      // a PDF / image original answers with the Markdown knode-os derived from it
      const file = readSourceTextCapped(ctx.dataDir, p, cap);
      if (!file) return c.json({ error: `no derived text for ${p} yet — run a sync first` }, 404);
      return c.json({ path: p, content: file.content, bytes: file.bytes, truncated: file.truncated, derived: file.derived });
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
      assertNotConvertedOriginal(p);
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
      if (isProtectedPath(p)) return c.json({ error: 'refusing to delete a root path' }, 400);
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
      // a directory where the guide belongs would break every later read of it
      if (isProtectedPath(rel) || isRootWritableFile(rel)) return c.json({ error: `${rel} is a file this workspace owns, not a directory` }, 400);
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
      // wiki/ and raw/docs/ are writable, which alone would let a rename walk
      // the whole tree away from under the workspace
      if (isProtectedPath(src) || isProtectedPath(dst)) {
        return c.json({ error: 'refusing to move a root path' }, 400);
      }
      if (src === dst) return c.json({ ok: true, from: src, to: dst });
      // renameSync replaces the destination without a word, which in a batch
      // move would silently destroy a same-named file already sitting there
      if (pathExists(ctx.dataDir, dst)) return c.json({ error: `already exists: ${dst}` }, 409);
      if (!pathExists(ctx.dataDir, src)) return c.json({ error: `no such path: ${src}` }, 404);
      movePath(ctx.dataDir, src, dst);
      // the sidecar follows, so a moved PDF is not converted again and keeps its tier-1 result
      moveSidecar(ctx.dataDir, src, dst);
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
      if (hasSidecarSegment(dir)) return c.json({ error: `${SIDECAR_ROOT}/ is system-owned` }, 400);
      const saved: string[] = [];
      const skipped: string[] = [];
      for (const [, v] of form.entries()) {
        if (!(v instanceof File)) continue;
        // folder uploads carry the path inside the dropped folder as the
        // filename ("notes/2026/kickoff.md"), so the subtree is recreated
        const name = sanitizeRelativePath(v.name);
        if (!name) continue;
        // a dropped folder copied from another workspace may carry its old
        // sidecar tree along: that is knode-os's state, never an upload
        if (hasSidecarSegment(name)) {
          skipped.push(name);
          continue;
        }
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
      return c.json({ ok: true, saved, ...(skipped.length ? { skipped } : {}) });
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
      assertSourcePath(p);
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
        eventRange: c.req.query('event_range')
          ? (({ validFrom, validTo }) => ({ from: validFrom, to: validTo }))(resolveTemporal({ validRange: c.req.query('event_range') }))
          : undefined,
        includeSuperseded: c.req.query('include_superseded') === '1' || c.req.query('include_superseded') === 'true',
        order: c.req.query('order') === 'timeline' ? 'timeline' : undefined,
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
      const asIndexed = ['1', 'true'].includes(c.req.query('asIndexed') ?? '');
      return c.json(validateOkfBundle(safePath(ctx.dataDir, c.req.query('path') ?? 'wiki'), { asIndexed }));
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
      if (s && (s.kind === 'pack' || s.kind === 'recipe' || s.kind === 'merge' || s.kind === 'wiki')) {
        try {
          applied = await applySuggestion(ctx.store, ctx.dataDir, id);
        } catch (e) {
          await setSuggestionStatus(ctx.store, id, 'pending');
          return c.json(err(e), 400);
        }
      }
    }
    return c.json({ ok: true, ...applied });
  });

  /* ------------------------------ entities -------------------------------- */

  app.get('/api/entities/merges', async (c) => c.json(await listMerges(requestCtx(c).store)));

  app.post('/api/entities/merge', async (c) => {
    const ctx = requestCtx(c);
    try {
      const { entityId, canonicalId, reason } = await c.req.json<{ entityId: string; canonicalId: string; reason?: string }>();
      return c.json(await applyMerge(ctx.store, { entityId, canonicalId, reason, actor: 'user' }));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.post('/api/entities/unmerge', async (c) => {
    const ctx = requestCtx(c);
    try {
      const { entityId } = await c.req.json<{ entityId: string }>();
      return c.json({ ok: await unmergeEntity(ctx.store, entityId, { actor: 'user' }) });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.post('/api/review/claims', async (c) => {
    const ctx = requestCtx(c);
    try {
      return c.json(await reviewClaims(ctx, { onProgress: log }));
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  app.post('/api/entities/dedupe', async (c) => {
    const ctx = requestCtx(c);
    try {
      return c.json(await auditDuplicateEntities({ store: ctx.store, embedder: ctx.embedder, config: ctx.config, llm: ctx.llm }, { onProgress: log }));
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  app.post('/api/wiki/lint', async (c) => {
    const ctx = requestCtx(c);
    try {
      return c.json(await lintWiki(ctx, { onProgress: log }));
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  /* ------------------------------ research -------------------------------- */

  app.get('/api/research/jobs', async (c) => {
    const ctx = requestCtx(c);
    const status = c.req.query('status');
    return c.json(await listJobs(ctx.store, {
      status: status ? (status.split(',').map((s) => s.trim()).filter(Boolean) as ResearchStatus[]) : undefined,
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    }));
  });

  app.post('/api/research/jobs', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = await c.req.json<{ kind?: string; target?: string; query?: string; template?: string }>();
      const kind = (body.kind ?? (body.query && !body.target ? 'question' : 'entity')) as ResearchKind;
      if (!RESEARCH_KINDS.includes(kind)) return c.json({ error: `kind must be one of ${RESEARCH_KINDS.join(', ')}` }, 400);
      const res = await queueJob(ctx.store, { kind, target: body.target, query: body.query, template: body.template, requestedBy: 'web' });
      if (res.created) servicesFor(ctx)?.kickResearch();
      return c.json(res, res.created ? 201 : 200);
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  // Knowledge-base initialization: the survey, the guide, the newest init job and the pages it queued.
  app.get('/api/research/init', async (c) => {
    const ctx = requestCtx(c);
    try {
      const [survey, job, followUps] = await Promise.all([
        surveyKnowledgeBase(ctx),
        latestJob(ctx.store, 'init'),
        listJobs(ctx.store, { requestedBy: 'init', limit: 10 }),
      ]);
      return c.json({ survey, guide: survey.guide, job, followUps });
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  app.post('/api/research/init', async (c) => {
    const ctx = requestCtx(c);
    try {
      const res = await queueJob(ctx.store, { kind: 'init', requestedBy: 'web' });
      if (res.created) servicesFor(ctx)?.kickResearch();
      return c.json(res, res.created ? 201 : 200);
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.post('/api/research/ask', async (c) => {
    const ctx = requestCtx(c);
    try {
      const { query } = await c.req.json<{ query: string }>();
      if (!query?.trim()) return c.json({ error: 'query is required' }, 400);
      return c.json(await queueJob(ctx.store, { kind: 'question', query, requestedBy: 'web' }), 201);
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.get('/api/research/recommendations', async (c) => {
    const ctx = requestCtx(c);
    try {
      if (c.req.query('refresh')) return c.json((await refreshRecommendations(ctx)).recommendations);
      // pending wiki suggestions are the filed recommendations; recompute on demand otherwise
      const pending = await ctx.store.query<{ id: string; payload: Record<string, unknown> }>(
        `SELECT id, payload FROM suggestions WHERE kind = 'wiki' AND status = 'pending' ORDER BY (payload ->> 'score')::float DESC NULLS LAST LIMIT 30`,
      );
      if (pending.length > 0) return c.json(pending.map((s) => ({ ...s.payload, suggestionId: s.id })));
      return c.json(await recommendWikiTopics(ctx));
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  // Research profiles: how a job runs (effort, search, verification, sub-agent roles with their own prompts).
  const profileDetail = (dataDir: string, profile: ResearchProfile) => ({
    ...profile,
    builtin: Boolean(BUILTIN_PROFILES[profile.name]),
    phaseDefaults: PHASES,
    roles: profile.roles.map((r) => {
      const p = rolePromptText(dataDir, r);
      return { ...r, promptPath: p.path, promptText: p.text, promptIsDefault: p.isDefault, promptDefault: PHASES[r.phase] };
    }),
  });

  app.get('/api/research/profiles', (c) => {
    const ctx = requestCtx(c);
    const active = activeProfile(ctx.dataDir, ctx.config);
    return c.json({ active: active.name, pipeline: effectivePipeline(active, ctx.config), profiles: [...loadProfiles(ctx.dataDir).values()].map(profileSummary) });
  });

  app.get('/api/research/profiles/:name', (c) => {
    const ctx = requestCtx(c);
    const profile = loadProfile(ctx.dataDir, c.req.param('name'));
    if (!profile) return c.json({ error: 'no such profile' }, 404);
    return c.json(profileDetail(ctx.dataDir, profile));
  });

  app.put('/api/research/profiles/:name', async (c) => {
    const ctx = requestCtx(c);
    const name = c.req.param('name');
    if (!isValidProfileName(name)) return c.json({ error: 'profile names use letters, digits, - and _ (max 41 chars)' }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { profile?: Record<string, unknown>; prompts?: Record<string, string>; activate?: boolean };
      let saved = saveProfile(ctx.dataDir, { ...(body.profile ?? {}), name } as Partial<ResearchProfile> & { name: string });
      // role prompts: only a text that differs from what the role currently runs with is written (built-ins stay built-in)
      let changed = false;
      const roles = saved.roles.map((role) => {
        const text = body.prompts?.[role.id];
        if (typeof text !== 'string') return role;
        const current = rolePromptText(ctx.dataDir, role);
        if (text.trim() === current.text.trim()) return role;
        changed = true;
        return { ...role, prompt: writeRolePrompt(ctx.dataDir, role, text) };
      });
      if (changed) saved = saveProfile(ctx.dataDir, { ...saved, roles });
      if (body.activate && ctx.config.research.profile !== name) {
        ctx.config.research.profile = name;
        saveConfig(ctx.dataDir, ctx.config);
      }
      return c.json(profileDetail(ctx.dataDir, saved));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.delete('/api/research/profiles/:name', (c) => {
    const ctx = requestCtx(c);
    const name = c.req.param('name');
    if (!isValidProfileName(name)) return c.json({ error: 'invalid profile name' }, 400);
    if ((ctx.config.research?.profile || 'default') === name && !BUILTIN_PROFILES[name]) return c.json({ error: 'select another profile before deleting the active one' }, 400);
    const removed = deleteProfile(ctx.dataDir, name);
    if (!removed) return c.json({ error: 'no such profile' }, 404);
    // a built-in comes back as its default on the next load (delete = reset)
    return c.json({ ok: true, reset: Boolean(BUILTIN_PROFILES[name]) });
  });

  app.get('/api/research/templates', (c) => {
    const ctx = requestCtx(c);
    return c.json([...loadResearchTemplates(ctx.dataDir).values()].map((t) => ({ name: t.name, kind: t.kind, output: t.output, maxTurns: t.maxTurns, requires: t.requires, path: t.path })));
  });

  app.get('/api/research/pages', async (c) => {
    const ctx = requestCtx(c);
    const jobs = await listJobs(ctx.store, { status: 'done', limit: 200 });
    const out: unknown[] = [];
    const seen = new Set<string>();
    for (const job of jobs) {
      if (!job.outputPath || seen.has(job.outputPath)) continue;
      seen.add(job.outputPath);
      let exists = false;
      try {
        exists = fs.existsSync(safePath(ctx.dataDir, job.outputPath));
      } catch {
        exists = false;
      }
      const [scope] = await ctx.store.query<{ trust: string; actor: string; applied_at: string }>(
        `SELECT trust, actor, applied_at FROM scopes WHERE kind = 'doc' AND key = $1 AND status = 'active' ORDER BY applied_at DESC LIMIT 1`,
        [job.outputPath],
      );
      out.push({ path: job.outputPath, exists, job: job.id, kind: job.kind, target: job.target ?? job.query, agent: job.agent, finishedAt: job.finishedAt, trust: scope?.trust ?? null, warnings: Array.isArray(job.payload.warnings) ? job.payload.warnings : [] });
    }
    return c.json(out);
  });

  // One job, with what the run directory knows while it is still running: phases so far, the plan (and an
  // init job's topics), and — on request — the tail of one session's transcript (`log=1` = the main one,
  // `log=<label>` = transcript-<label>.jsonl of a team phase).
  app.get('/api/research/jobs/:id', async (c) => {
    const ctx = requestCtx(c);
    const job = await getJob(ctx.store, c.req.param('id'));
    if (!job) return c.json({ error: 'no such job' }, 404);
    const runDir = path.join(runsRoot(ctx.dataDir, ctx.config.research?.runsDir ?? '.runs'), job.id);
    const readJson = (name: string): unknown => {
      try {
        return JSON.parse(fs.readFileSync(path.join(runDir, name), 'utf8'));
      } catch {
        return null;
      }
    };
    let log: string | null = null;
    const wanted = c.req.query('log');
    if (wanted) {
      const label = wanted === '1' || wanted === 'agent' ? '' : /^[a-z0-9-]{1,40}$/i.test(wanted) ? wanted : null;
      if (label === null) return c.json({ error: 'log must be 1 or a phase label (letters, digits, -)' }, 400);
      const file = path.join(runDir, label ? `transcript-${label}.jsonl` : 'transcript.jsonl');
      if (fs.existsSync(file)) log = fs.readFileSync(file, 'utf8').split('\n').slice(-200).join('\n');
    }
    const phases = Array.isArray(job.payload.phases) ? job.payload.phases : readJson('phases.json');
    const plan = readJson('plan.json');
    const transcripts = fs.existsSync(runDir)
      ? fs.readdirSync(runDir).filter((f) => /^transcript(-.+)?\.jsonl$/.test(f)).map((f) => f.replace(/^transcript-?/, '').replace(/\.jsonl$/, '') || 'agent').sort()
      : [];
    return c.json({ ...job, log, phases: phases ?? [], plan, steps: Array.isArray(job.payload.steps) ? job.payload.steps : [], transcripts });
  });

  // cancel flips the row and kills the job's running sessions in this process
  app.post('/api/research/jobs/:id/cancel', async (c) => {
    const id = c.req.param('id');
    const cancelled = await cancelJob(requestCtx(c).store, id);
    return c.json({ cancelled, killed: cancelled ? killAgentsFor(id) : 0 });
  });

  app.post('/api/research/jobs/:id/retry', async (c) => {
    const job = await retryJob(requestCtx(c).store, c.req.param('id'));
    return job ? c.json(job) : c.json({ error: 'job is not in a retryable state' }, 400);
  });

  /* ------------------------------ chat ------------------------------------ */

  app.get('/api/chat/conversations', async (c) => {
    const ctx = requestCtx(c);
    const limit = Number(c.req.query('limit'));
    return c.json(await listConversations(ctx.store, { limit: Number.isFinite(limit) && limit > 0 ? Math.min(200, Math.floor(limit)) : undefined }));
  });

  app.post('/api/chat/conversations', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { title?: string };
      const scope = c.get('workspaceScope');
      return c.json(await createConversation(ctx.store, { title: body.title, createdBy: scope?.user ?? null }), 201);
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.get('/api/chat/conversations/:id', async (c) => {
    const ctx = requestCtx(c);
    const conversation = await getConversation(ctx.store, c.req.param('id'), { messages: true });
    if (!conversation) return c.json({ error: 'no such conversation' }, 404);
    return c.json({ ...conversation, running: isChatRunning(ctx, conversation.id) });
  });

  // A message starts a turn in the background: 202 with the user message's seq; poll /status until idle.
  app.post('/api/chat/conversations/:id/messages', async (c) => {
    const ctx = requestCtx(c);
    const id = c.req.param('id');
    try {
      const body = (await c.req.json().catch(() => ({}))) as { text?: string };
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) return c.json({ error: 'text is required' }, 400);
      if (!(await getConversation(ctx.store, id))) return c.json({ error: 'no such conversation' }, 404);
      const services = servicesFor(ctx);
      const mcp = services?.mcp() ?? null;
      if (!mcp) return c.json({ error: 'chat needs the MCP endpoint `serve` hosts — start knode-os serve' }, 503);
      if (!resolveChatAgent(ctx.config)) return c.json({ error: 'no chat agent configured: set chat.agent or research.agent (Settings → Deep research)' }, 503);
      const { seq, turn } = await startChatTurn(ctx, id, text, { mcp, log });
      const tracked = services ? services.track(turn) : turn;
      tracked.catch((e) => log(`chat ${id}: turn failed: ${e instanceof Error ? e.message : e}`));
      return c.json({ ok: true, seq, status: 'running' }, 202);
    } catch (e) {
      if (e instanceof ChatBusyError) return c.json({ error: e.message }, 409);
      return c.json(err(e), 400);
    }
  });

  app.get('/api/chat/conversations/:id/status', async (c) => {
    const ctx = requestCtx(c);
    const id = c.req.param('id');
    const conversation = await getConversation(ctx.store, id);
    if (!conversation) return c.json({ error: 'no such conversation' }, 404);
    const activity = chatActivity(ctx, id);
    // the row says running until the turn's message lands; the in-process registry is the truth in this process
    return c.json({ ...activity, status: activity.status === 'running' ? 'running' : conversation.status === 'running' && activity.status === 'idle' && !isChatRunning(ctx, id) ? 'idle' : activity.status, updatedAt: conversation.updatedAt });
  });

  app.post('/api/chat/conversations/:id/cancel', (c) => {
    const ctx = requestCtx(c);
    return c.json({ cancelled: cancelChatTurn(ctx, c.req.param('id')) });
  });

  app.delete('/api/chat/conversations/:id', async (c) => {
    const ctx = requestCtx(c);
    const id = c.req.param('id');
    if (isChatRunning(ctx, id)) return c.json({ error: 'the conversation is answering — cancel it first' }, 409);
    const removed = await deleteConversation(ctx.store, id);
    if (!removed) return c.json({ error: 'no such conversation' }, 404);
    removeChatWorkspace(ctx, id);
    return c.json({ ok: true });
  });

  app.get('/api/chat/protocol', (c) => {
    const ctx = requestCtx(c);
    return c.json({ path: `${CHAT_DIR}/${CHAT_PROTOCOL_FILE}`, text: loadChatProtocol(ctx.dataDir) });
  });

  app.put('/api/chat/protocol', async (c) => {
    const ctx = requestCtx(c);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { text?: string };
      if (typeof body.text !== 'string' || !body.text.trim()) return c.json({ error: 'text is required' }, 400);
      return c.json({ path: saveChatProtocol(ctx.dataDir, body.text), text: loadChatProtocol(ctx.dataDir) });
    } catch (e) {
      return c.json(err(e), 400);
    }
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
