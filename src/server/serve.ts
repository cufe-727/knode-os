import { serve } from '@hono/node-server';
import chokidar from 'chokidar';
import path from 'node:path';
import { AppContext } from '../context.js';
import { SIDECAR_ROOT_SEGMENT } from '../fs/layout.js';
import { startDreamScheduler } from '../dream/dream.js';
import { describeDocumentPass, runDocumentPass } from '../ingest/background.js';
import { sync } from '../ingest/sync.js';
import { flushUsageToSidecars } from '../stats/heat.js';
import { syncTraces } from '../traces/sync.js';
import { reconcileViews } from '../wiki/pages.js';
import { refineWiki } from '../wiki/refine.js';
import { lintWiki } from '../wiki/lint.js';
import { createApp, WorkspaceServices } from './app.js';
import { loadOrCreateMcpToken, MCP_TOKEN_FILE } from './mcp-http.js';
import { startResearchLoop } from '../research/service.js';
import { resetRunningConversations } from '../chat/store.js';
import { McpEndpoint } from '../research/workspace.js';
import { WorkspaceContextRegistry } from './workspaces.js';

/**
 * `knode-os serve` — HTTP API + web UI, plus the background loops:
 * file watcher → scoped sync (apply changed, dispose removed), the periodic
 * document pass (heat-prioritized extraction → duplicate audit of what it
 * wrote → summary pages) followed by view reconciliation, hourly usage-stats
 * flush to sidecars, periodic trace sync, datasource re-sync, nightly dream +
 * the tier-2 pass.
 */
export async function startServer(ctx: AppContext): Promise<void> {
  const log = (msg: string) => console.log(`[knode-os] ${msg}`);
  const mcpBase: { url: string | null } = { url: null };
  const mcpToken = loadOrCreateMcpToken(ctx.dataDir);
  // per-workspace background services the routes may poke (queue a job and run it now; the MCP endpoint a chat turn attaches to)
  const services = new Map<string, WorkspaceServices>();
  const workspaceContexts = new WorkspaceContextRegistry(ctx.dataDir, {
    templateConfig: ctx.config,
    onCreate: (workspaceCtx, scope) => {
      const workspaceLog = (msg: string) => log(`[${scope.relativeDir}] ${msg}`);
      const mcp = (): McpEndpoint | null => mcpBase.url
        ? {
          url: mcpBase.url,
          token: mcpToken,
          headers: { 'x-knode-user': scope.user, 'x-knode-workspace-kind': scope.kind, 'x-knode-workspace-id': scope.id, 'x-knode-workspace-name': scope.name },
        }
        : null;
      const started = startWorkspaceServices(workspaceCtx, workspaceLog, { mcp });
      services.set(workspaceCtx.dataDir, { mcp, kickResearch: started.kickResearch, track: started.track });
      return async () => {
        services.delete(workspaceCtx.dataDir);
        await started.stop();
      };
    },
  });
  const app = createApp(ctx, log, workspaceContexts, { services: (workspaceCtx) => services.get(workspaceCtx.dataDir) ?? null });
  const { port, host } = ctx.config.server;

  serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    log(`serving http://${host}:${info.port}  (workspace root: ${ctx.dataDir})`);
    const mcp = ctx.config.server.mcp;
    if (!mcp || mcp.enabled !== false) {
      const localHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
      mcpBase.url = `http://${localHost}:${info.port}${mcp?.path || '/mcp'}`;
      log(`mcp endpoint ${mcpBase.url}  (bearer token: ${MCP_TOKEN_FILE}; register with \`knode-os connect <claude|codex|cursor> --http\`)`);
    }
  });
}

const WATCH_FULL_SYNC_THRESHOLD = 200;

interface StartedServices {
  stop: () => Promise<void>;
  kickResearch: () => void;
  track: <T>(job: Promise<T>) => Promise<T>;
}

function startWorkspaceServices(ctx: AppContext, log: (msg: string) => void, opts: { mcp?: () => McpEndpoint | null } = {}): StartedServices {
  let disposed = false;
  // deep-research jobs: an external CLI writes wiki pages through the MCP endpoint serve hosts
  const research = opts.mcp ? startResearchLoop(ctx, { mcp: opts.mcp, log }) : null;
  // a chat turn only lives in one process: whatever a previous serve left mid-answer is idle now
  void resetRunningConversations(ctx.store)
    .then((n) => n && log(`chat: ${n} conversation(s) left answering by a previous run are idle again`))
    .catch(() => {});
  const activeJobs = new Set<Promise<unknown>>();
  const track = <T>(job: Promise<T>): Promise<T> => {
    activeJobs.add(job);
    void job.then(
      () => activeJobs.delete(job),
      () => activeJobs.delete(job),
    );
    return job;
  };
  const summarize = (label: string, s: Awaited<ReturnType<typeof sync>>) =>
    log(`${label}: ${s.indexed} applied, ${s.unchanged} unchanged, ${s.disposed} disposed, ${s.chunks} chunks, ${s.pagesRegenerated} pages regenerated${s.pagesArchived ? `, ${s.pagesArchived} archived` : ''}${s.datasourceErrors.length ? `, datasource errors: ${s.datasourceErrors.length}` : ''}`);

  // initial trace sync + full reconciliation (async, doesn't block startup)
  void track((async () => {
    try {
      const ts = await syncTraces(ctx.store, ctx.config);
      if (disposed) return;
      if (ts.copied || ts.skills) log(`trace sync: ${ts.copied} traces, ${ts.skills} skill files`);
      summarize('sync', await sync(ctx, { onProgress: (m) => log(m) }));
    } catch (err) {
      log(`startup sync failed: ${err instanceof Error ? err.message : err}`);
    }
  })());

  // periodic live-schema refresh: keeps dataset pages / entity links / freshness current
  const dsTimer = setInterval(() => {
    if (disposed || ctx.config.datasources.length === 0) return;
    void track((async () => {
      try {
        const s = await sync(ctx, { only: ['datasources'], onProgress: log });
        if (s.pagesRegenerated > 0) log(`datasource sync: ${s.pagesRegenerated} wiki pages refreshed`);
      } catch (err) {
        log(`datasource sync failed: ${err instanceof Error ? err.message : err}`);
      }
    })());
  }, 30 * 60_000);
  dsTimer.unref?.();

  // periodic trace sync (skills are sources: removed skills get disposed)
  const interval = Math.max(1, ctx.config.trace.syncIntervalMinutes) * 60_000;
  const syncTimer = setInterval(() => {
    if (disposed) return;
    void track((async () => {
      try {
        const ts = await syncTraces(ctx.store, ctx.config);
        if (ts.copied || ts.skills) {
          log(`trace sync: ${ts.copied} traces, ${ts.skills} skill files`);
          await sync(ctx, { only: ['raw/skills'] });
        }
      } catch (err) {
        log(`trace sync failed: ${err instanceof Error ? err.message : err}`);
      }
    })());
  }, interval);
  syncTimer.unref?.();

  // the document pass: extract from the priority queue, audit the entities
  // and claims it wrote for duplicates, write summary pages — then let pages
  // that depend on the new evidence regenerate (docs/design/09, 10). While a
  // backlog remains and passes make progress they run back to back; the
  // interval only paces polling an empty (or stuck) queue.
  const tier1Interval = Math.max(1, ctx.config.extraction.intervalMinutes) * 60_000;
  let tier1Running = false;
  const tier1Timer = setInterval(() => {
    if (disposed || tier1Running) return;
    tier1Running = true;
    void track((async () => {
      try {
        for (;;) {
          const pass = await runDocumentPass(ctx, { onProgress: log });
          const line = describeDocumentPass(pass);
          if (line) {
            log(line);
            const views = await reconcileViews(ctx, { actor: 'tier1', llm: false, onProgress: log });
            if (views.regenerated || views.archived) log(`views: ${views.regenerated} regenerated, ${views.archived} archived`);
          }
          if (disposed || pass.queued === 0 || !pass.progressed) break;
        }
      } catch (err) {
        log(`document pass failed: ${err instanceof Error ? err.message : err}`);
      } finally {
        tier1Running = false;
      }
    })());
  }, tier1Interval);
  tier1Timer.unref?.();

  // usage stats → sidecar flush
  const flushInterval = Math.max(1, ctx.config.heat.flushIntervalMinutes) * 60_000;
  const flushTimer = setInterval(() => {
    if (disposed) return;
    void track((async () => {
      try {
        const n = await flushUsageToSidecars(ctx.store, ctx.config.heat);
        if (n) log(`usage stats flushed to ${n} sidecars`);
      } catch (err) {
        log(`stats flush failed: ${err instanceof Error ? err.message : err}`);
      }
    })());
  }, flushInterval);
  flushTimer.unref?.();

  // nightly dream + the tier-2 pass
  const dreamTimer = startDreamScheduler(ctx, log);
  log(`dream scheduled daily at ${ctx.config.dream.schedule} (lookback ${ctx.config.dream.lookbackDays}d)`);
  const tier2Timer = startTier2Scheduler(ctx, log);

  // watch docs + wiki for changes → debounced scoped sync (unlink events dispose)
  let watchTimer: NodeJS.Timeout | null = null;
  let watcher: ReturnType<typeof chokidar.watch> | null = null;
  if (ctx.config.ingest.watch) {
    let running = false;
    const pending = new Set<string>();
    let fullSync = false;
    const trigger = (event: string, absPath: string) => {
      if (disposed) return;
      const rel = path.relative(ctx.dataDir, absPath).split(path.sep).join('/');
      if (event === 'addDir' || event === 'unlinkDir' || !rel || rel.startsWith('..')) fullSync = true;
      else pending.add(rel);
      if (pending.size > WATCH_FULL_SYNC_THRESHOLD) fullSync = true;
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        if (disposed) return;
        if (running) {
          trigger('retry', absPath);
          return;
        }
        running = true;
        const only = fullSync ? undefined : [...pending];
        pending.clear();
        fullSync = false;
        void track((async () => {
          try {
            const stats = await sync(ctx, { only });
            if (stats.indexed || stats.disposed || stats.pagesRegenerated) summarize('watch sync', stats);
          } catch (err) {
            log(`watch sync failed: ${err instanceof Error ? err.message : err}`);
          } finally {
            running = false;
          }
        })());
      }, 1500);
    };
    watcher = chokidar.watch([
        path.join(ctx.dataDir, 'raw/docs'),
        path.join(ctx.dataDir, 'raw/skills'),
        path.join(ctx.dataDir, 'wiki'),
        path.join(ctx.dataDir, 'purpose.md'),
        path.join(ctx.dataDir, 'schema.md'),
      ], {
        ignoreInitial: true,
        // Obsidian rewrites workspace/cache state during normal navigation;
        // those Vault settings are not knowledge and must not trigger a sync.
        // wiki/.archive holds disposed pages and is never a source, and the
        // sidecar tree is written by the pipeline itself.
        ignored: new RegExp(`(^|[/\\\\])(\\.obsidian|\\.archive|${SIDECAR_ROOT_SEGMENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})([/\\\\]|$)`),
      })
      .on('all', trigger);
    log('watching raw/docs, raw/skills, wiki for changes');
  }

  return {
    stop: async () => {
      disposed = true;
      await research?.stop();
      clearInterval(syncTimer);
      clearInterval(tier1Timer);
      clearInterval(flushTimer);
      clearInterval(dreamTimer);
      clearInterval(tier2Timer);
      clearInterval(dsTimer);
      if (watchTimer) clearTimeout(watchTimer);
      if (watcher) await watcher.close();
      await Promise.allSettled([...activeJobs]);
      await ctx.datasources.closeAll();
    },
    kickResearch: () => research?.kick(),
    track,
  };
}

/** Run the tier-2 pass daily, a few minutes after the dream schedule. */
function startTier2Scheduler(ctx: AppContext, log: (msg: string) => void): NodeJS.Timeout {
  const [h, m] = ctx.config.dream.schedule.split(':').map(Number);
  const target = `${String(h).padStart(2, '0')}:${String((m + 10) % 60).padStart(2, '0')}`;
  let lastRun = '';
  const timer = setInterval(async () => {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const today = now.toISOString().slice(0, 10);
    if (hhmm === target && lastRun !== today) {
      lastRun = today;
      try {
        const res = await refineWiki(ctx.store, ctx.config, ctx.llm, { onProgress: log, embedder: ctx.embedder });
        log(`tier2 done: ${res.mergeCandidates} merge suggestions, ${res.claimReviews} claim reviews, ${res.recommendations} research recommendations${res.retiredPages ? `, ${res.retiredPages} cluster pages archived` : ''}`);
        const views = await reconcileViews(ctx, { actor: 'tier2', llm: true, onProgress: log });
        if (views.regenerated || views.archived) log(`views: ${views.regenerated} regenerated, ${views.archived} archived`);
        const lint = await lintWiki(ctx, { onProgress: log });
        log(`wiki lint: ${lint.issues.length} findings → ${lint.reportPath}`);
      } catch (err) {
        log(`tier2 failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }, 30 * 1000);
  timer.unref?.();
  log(`tier2 pass scheduled daily at ${target}`);
  return timer;
}
