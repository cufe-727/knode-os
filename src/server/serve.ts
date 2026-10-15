import { serve } from '@hono/node-server';
import fs from 'node:fs';
import path from 'node:path';
import { AppContext } from '../context.js';
import { isHiddenName } from '../fs/files.js';
import { RAW_DOCS, RAW_SKILLS, WIKI_DIR } from '../fs/layout.js';
import { TreeWatcher, watchTree } from '../fs/watch.js';
import { startDreamScheduler } from '../dream/dream.js';
import { startFollowUp } from '../labeling/followup.js';
import { LocalLabelingWorkers } from '../labeling/local.js';
import { LabelingScheduler } from '../labeling/scheduler.js';
import { LinkedFolders } from '../ingest/folders.js';
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
import { resolveWorkspaceScope, WorkspaceContextRegistry } from './workspaces.js';

/**
 * `knode-os serve` — HTTP API + web UI + the remote API, plus the background
 * loops: file watcher → scoped sync (apply changed, dispose removed),
 * extraction as leased work for this machine's worker slots and remote workers
 * (src/labeling), the duplicate audit of what it wrote and summary pages after
 * it, view reconciliation, hourly usage-stats flush to sidecars, periodic trace
 * sync, datasource re-sync, nightly dream + the tier-2 pass.
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
      services.set(workspaceCtx.dataDir, {
        mcp, kickResearch: started.kickResearch, track: started.track, folders: started.folders,
        labeling: started.labeling, localWorkers: started.localWorkers,
      });
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
    if (ctx.config.server.remote?.enabled !== false) log(`remote API http://${host}:${info.port}/remote/v1  (tokens: \`knode-os remote token create\`)`);
    autostartWorkspaces(ctx.dataDir, workspaceContexts, log);
  });
}

/**
 * Open, at startup, every workspace that follows a linked folder: its watchers,
 * extraction and summaries must not wait for someone to open it in the UI —
 * after a restart they would otherwise sit idle until then.
 */
function autostartWorkspaces(root: string, registry: WorkspaceContextRegistry, log: (msg: string) => void): void {
  const linked = (dataDir: string) => {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'knode.config.json'), 'utf8')) as { ingest?: { linkedFolders?: unknown[] } };
      return Array.isArray(config.ingest?.linkedFolders) && config.ingest.linkedFolders.length > 0;
    } catch {
      return false;
    }
  };
  const dirs = (abs: string) => {
    try {
      return fs.readdirSync(abs, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
    } catch {
      return [];
    }
  };
  const open = (label: string, scope: Parameters<WorkspaceContextRegistry['get']>[0]) => {
    void registry.get(scope).then(
      () => log(`[${label}] opened at startup: it follows linked folders`),
      (err) => log(`[${label}] could not open at startup: ${err instanceof Error ? err.message : err}`),
    );
  };
  for (const user of dirs(path.join(root, 'users'))) {
    for (const id of dirs(path.join(root, 'users', user, 'workspaces'))) {
      const dataDir = path.join(root, 'users', user, 'workspaces', id);
      if (!linked(dataDir)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, '.workspace.json'), 'utf8')) as { name?: string };
        open(`users/${user}/workspaces/${id}`, resolveWorkspaceScope({ user, kind: 'personal', id, name: manifest.name || id }));
      } catch (err) {
        log(`[users/${user}/workspaces/${id}] could not open at startup: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  for (const team of dirs(path.join(root, 'teams'))) {
    if (!linked(path.join(root, 'teams', team))) continue;
    try {
      open(`teams/${team}`, resolveWorkspaceScope({ user: 'autostart', kind: 'team', name: team }));
    } catch (err) {
      log(`[teams/${team}] could not open at startup: ${err instanceof Error ? err.message : err}`);
    }
  }
}

const WATCH_FULL_SYNC_THRESHOLD = 200;

const WATCHED_TREES = [RAW_DOCS, RAW_SKILLS, WIKI_DIR];
const WATCHED_FILES = new Set(['purpose.md', 'schema.md']);

/**
 * What the data-dir watcher syncs: raw/docs, raw/skills, wiki and the two
 * anchor files. Never a hidden path — Obsidian rewrites its vault state during
 * normal navigation, wiki/.archive holds disposed pages, the sidecar tree is
 * written by the pipeline itself — nor anything else at the root (ledger,
 * index, config).
 */
export function isWatchedSource(rel: string): boolean {
  if (WATCHED_FILES.has(rel)) return true;
  if (!WATCHED_TREES.some((t) => rel === t || rel.startsWith(`${t}/`))) return false;
  return !rel.split('/').some(isHiddenName);
}

interface StartedServices {
  stop: () => Promise<void>;
  kickResearch: () => void;
  track: <T>(job: Promise<T>) => Promise<T>;
  folders: LinkedFolders;
  labeling: LabelingScheduler;
  localWorkers: LocalLabelingWorkers;
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

  // extraction as leased work (src/labeling): this machine's worker slots and
  // remote workers take segments as they free up, nothing waits for the
  // slowest call; the duplicate audit of what was written, the views that
  // depend on it and the summary pages follow on their own loop
  // (docs/design/09, 10)
  const remote = ctx.config.server.remote;
  const labeling = new LabelingScheduler({ dataDir: ctx.dataDir, store: ctx.store, config: () => ctx.config, log }, {
    leaseMs: Math.max(1, remote?.leaseMinutes ?? 15) * 60_000,
  });
  const localWorkers = new LocalLabelingWorkers(labeling, () => ctx.config, { log });
  localWorkers.start();
  const followUp = startFollowUp(ctx, labeling, { log, track });

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

  // linked folders: mirror what changed while knode-os was down, then follow
  // their sources with a watcher of their own (src/ingest/folders.ts)
  const folders = new LinkedFolders(ctx, { log, track });
  folders.start();

  // nightly dream + the tier-2 pass
  const dreamTimer = startDreamScheduler(ctx, log);
  log(`dream scheduled daily at ${ctx.config.dream.schedule} (lookback ${ctx.config.dream.lookbackDays}d)`);
  const tier2Timer = startTier2Scheduler(ctx, log);

  // watch docs + wiki for changes → debounced scoped sync (a path that is gone
  // disposes what was under it). One recursive watcher for the data dir, never
  // one per file (src/fs/watch.ts).
  let watchTimer: NodeJS.Timeout | null = null;
  let watcher: TreeWatcher | null = null;
  if (ctx.config.ingest.watch) {
    let running = false;
    const pending = new Set<string>();
    let fullSync = false;
    const trigger = (absPath: string) => {
      if (disposed) return;
      const rel = path.relative(ctx.dataDir, absPath).split(path.sep).join('/');
      // an event naming no path (the data dir itself) is no source
      if (!rel) return;
      // a directory that came is synced whole; a path that is gone — a file or
      // a directory — is a prefix the scoped sync disposes everything under
      let isDir = false;
      try {
        isDir = fs.statSync(absPath).isDirectory();
      } catch {
        isDir = false;
      }
      if (isDir || rel.startsWith('..')) fullSync = true;
      else pending.add(rel);
      if (pending.size > WATCH_FULL_SYNC_THRESHOLD) fullSync = true;
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        if (disposed) return;
        if (running) {
          trigger(absPath);
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
    try {
      watcher = watchTree(ctx.dataDir, (abs) => trigger(abs), {
        ignore: (rel) => !isWatchedSource(rel),
        onError: (err) => log(`watcher error: ${err.message}`),
      });
      log('watching raw/docs, raw/skills, wiki for changes');
    } catch (err) {
      log(`cannot watch ${ctx.dataDir}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return {
    stop: async () => {
      disposed = true;
      await research?.stop();
      clearInterval(syncTimer);
      followUp.stop();
      localWorkers.stop();
      await labeling.stop();
      clearInterval(flushTimer);
      clearInterval(dreamTimer);
      clearInterval(tier2Timer);
      clearInterval(dsTimer);
      if (watchTimer) clearTimeout(watchTimer);
      watcher?.close();
      await folders.stop();
      await Promise.allSettled([...activeJobs]);
      await ctx.datasources.closeAll();
    },
    kickResearch: () => research?.kick(),
    track,
    folders,
    labeling,
    localWorkers,
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
