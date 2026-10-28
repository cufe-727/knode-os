import { serve } from '@hono/node-server';
import fs from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { AuthService } from '../auth/service.js';
import { AppContext } from '../context.js';
import { isHiddenName } from '../fs/files.js';
import { RAW_DOCS, RAW_SKILLS, WIKI_DIR } from '../fs/layout.js';
import { TreeWatcher, watchTree } from '../fs/watch.js';
import { nightlySchedule, startDreamScheduler } from '../dream/dream.js';
import { CallLedger } from '../estimate/ledger.js';
import { startFollowUp } from '../labeling/followup.js';
import { judgesHere, LocalLabelingWorkers } from '../labeling/local.js';
import { LabelingProcessing } from '../labeling/processing.js';
import { LabelingScheduler } from '../labeling/scheduler.js';
import { EmbeddingBackfill } from '../ingest/embed-backfill.js';
import { LinkedFolders, linkedFolders, linkOwning, syncedByFolders } from '../ingest/folders.js';
import { sync, SyncContext, SyncStats } from '../ingest/sync.js';
import { WorkBroker } from '../work/broker.js';
import { offeredRemotely } from '../work/config.js';
import { JudgeSource } from '../work/judge.js';
import { SummarySource } from '../work/summarize.js';
import { TranslateSource } from '../work/translate.js';
import { flushUsageToSidecars } from '../stats/heat.js';
import { syncTraces } from '../traces/sync.js';
import { reconcileViews } from '../wiki/pages.js';
import { refineWiki } from '../wiki/refine.js';
import { lintWiki } from '../wiki/lint.js';
import { createApp, WorkspaceServices } from './app.js';
import { embedOrigins } from './embed.js';
import { MCP_TOKEN_FILE, McpWorkspaceTokens } from './mcp-http.js';
import { isLoopbackAddress } from './public-guard.js';
import { startResearchLoop } from '../research/service.js';
import { resetRunningConversations } from '../chat/store.js';
import { McpEndpoint } from '../research/workspace.js';
import { resolveWorkspaceScope, WorkspaceContextRegistry } from './workspaces.js';

const isLoopbackHost = (host: string) => host === 'localhost' || isLoopbackAddress(host.replace(/^\[|\]$/g, ''));

/**
 * Where `serve` listens, checked before anything opens: a listener other
 * machines can reach must speak HTTPS (`server.tls`), unless the operator has
 * said the network encrypts by itself — they would be turned away at every
 * request otherwise, after typing a password over plain HTTP.
 */
export function assertListeners(server: AppContext['config']['server']): void {
  const insecureOk = server.auth?.allowInsecureRemote === true;
  if (!isLoopbackHost(server.host) && !insecureOk) {
    throw new Error(
      `server.host is ${server.host}, which other machines can reach over plain HTTP. Keep it on 127.0.0.1 and either put a tunnel `
      + 'in front (Cloudflare Tunnel, SSH), or add an HTTPS listener with server.tls (`knode-os tls init`). On a network that '
      + 'encrypts by itself (a VPN) set server.auth.allowInsecureRemote: true instead.',
    );
  }
  const tls = server.tls;
  if (tls) {
    if (!Number.isInteger(tls.port) || tls.port < 1 || tls.port > 65_535) throw new Error('server.tls.port must be a port number');
    if (tls.port === server.port) throw new Error('server.tls.port must differ from server.port');
    if (!tls.cert || !tls.key) throw new Error('server.tls needs cert and key (PEM files) — `knode-os tls init` makes a self-signed pair');
  }
  if (server.auth?.enabled === false && (tls || !isLoopbackHost(server.host))) {
    throw new Error('sign-in is off (server.auth.enabled: false): serve must then listen on loopback only, without server.tls');
  }
}

function readPem(root: string, file: string, label: string): Buffer {
  const abs = path.isAbsolute(file) ? file : path.join(root, file);
  try {
    return fs.readFileSync(abs);
  } catch (err) {
    throw new Error(`server.tls.${label}: cannot read ${abs}: ${err instanceof Error ? err.message : err}`);
  }
}

/** A listener that cannot bind is fatal, and says which port: never a silent move to another one. */
function failOnListenError(server: { on: (event: 'error', cb: (err: NodeJS.ErrnoException) => void) => unknown }, what: string): void {
  server.on('error', (err) => {
    console.error(`[knode-os] cannot listen on ${what}: ${err.code === 'EADDRINUSE' ? 'the port is taken by another process' : err.message}`);
    process.exit(1);
  });
}

/**
 * `knode-os serve` — HTTP API + web UI + the remote API, plus the background
 * loops: file watcher → scoped sync (apply changed, dispose removed),
 * extraction and summary pages as leased work for this machine's slots and
 * remote workers (src/labeling, src/work), the duplicate audit of what was
 * written, view reconciliation, hourly usage-stats flush to sidecars, periodic trace
 * sync, datasource re-sync, nightly dream + the tier-2 pass.
 *
 * Every request needs a signed-in account (src/auth) unless
 * `server.auth.enabled` is false. The main listener is plain HTTP, for this
 * machine and the tunnels in front of it; `server.tls` adds an HTTPS one for
 * other machines.
 */
export async function startServer(ctx: AppContext): Promise<void> {
  const log = (msg: string) => console.log(`[knode-os] ${msg}`);
  assertListeners(ctx.config.server);
  // an entry that is not an exact origin stops serve here, before anything opens
  const embedAllowed = embedOrigins(ctx.config.server);
  const authConfig = ctx.config.server.auth;
  // browsers share cookies across the ports of a host: one name per port keeps a dev server from signing prod out
  const auth = authConfig?.enabled === false ? null : new AuthService(ctx.dataDir, {
    sessionDays: authConfig?.sessionDays,
    allowInsecureRemote: authConfig?.allowInsecureRemote,
    cookieName: `knode_session_${ctx.config.server.port}`,
  });
  const tlsOptions = ctx.config.server.tls
    ? { cert: readPem(ctx.dataDir, ctx.config.server.tls.cert, 'cert'), key: readPem(ctx.dataDir, ctx.config.server.tls.key, 'key') }
    : null;
  const mcpBase: { url: string | null } = { url: null };
  // the data root's token (.knode/mcp-token) is this machine's own clients'; the agents
  // launched in a workspace get a token for that workspace alone (src/server/mcp-http.ts)
  const mcpTokens = new McpWorkspaceTokens();
  // per-workspace background services the routes may poke (queue a job and run it now; the MCP endpoint a chat turn attaches to)
  const services = new Map<string, WorkspaceServices>();
  const workspaceContexts = new WorkspaceContextRegistry(ctx.dataDir, {
    templateConfig: ctx.config,
    onCreate: (workspaceCtx, scope) => {
      const workspaceLog = (msg: string) => log(`[${scope.relativeDir}] ${msg}`);
      const agentToken = mcpTokens.mint(scope);
      const mcp = (): McpEndpoint | null => mcpBase.url
        ? {
          url: mcpBase.url,
          token: agentToken,
          headers: { 'x-knode-user': scope.user, 'x-knode-workspace-kind': scope.kind, 'x-knode-workspace-id': scope.id, 'x-knode-workspace-name': scope.name },
        }
        : null;
      let started: StartedServices;
      try {
        started = startWorkspaceServices(workspaceCtx, workspaceLog, { mcp, rootDataDir: ctx.dataDir });
      } catch (err) {
        mcpTokens.revoke(agentToken);
        throw err;
      }
      services.set(workspaceCtx.dataDir, {
        mcp, kickResearch: started.kickResearch, track: started.track, folders: started.folders,
        labeling: started.labeling, work: started.work, localWorkers: started.localWorkers, processing: started.processing, translations: started.translations,
        calls: started.calls,
      });
      return async () => {
        services.delete(workspaceCtx.dataDir);
        await started.stop();
        mcpTokens.revoke(agentToken);
      };
    },
  });
  const app = createApp(ctx, log, workspaceContexts, { services: (workspaceCtx) => services.get(workspaceCtx.dataDir) ?? null, auth, mcpTokens });
  const { port, host } = ctx.config.server;

  const main = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    log(`serving http://${host}:${info.port}  (workspace root: ${ctx.dataDir})`);
    const mcp = ctx.config.server.mcp;
    if (!mcp || mcp.enabled !== false) {
      const localHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
      mcpBase.url = `http://${localHost}:${info.port}${mcp?.path || '/mcp'}`;
      log(`mcp endpoint ${mcpBase.url}  (bearer token: ${MCP_TOKEN_FILE}; register with \`knode-os connect <claude|codex|cursor> --http\`)`);
    }
    if (ctx.config.server.remote?.enabled !== false) log(`remote API http://${host}:${info.port}/remote/v1  (tokens: \`knode-os remote token create\`)`);
    if (embedAllowed.length) log(`embedded reader /embed/v1 may be framed by ${embedAllowed.join(', ')}  (server.embed.allowedOrigins)`);
    if (!auth) log('sign-in is OFF (server.auth.enabled: false): any local client may act as any user — for development only');
    else if (auth.setupRequired()) {
      log(`no accounts yet: create the administrator with \`knode-os user add <name> --admin\`, or open http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${info.port} on this machine`);
    } else log(`sign-in on: ${auth.accounts.list().length} account(s) in .knode/accounts.json  (\`knode-os user list\`)`);
    autostartWorkspaces(ctx.dataDir, workspaceContexts, log);
  });
  failOnListenError(main, `${host}:${port}`);

  const tls = ctx.config.server.tls;
  if (tls && tlsOptions) {
    const secure = serve({ fetch: app.fetch, port: tls.port, hostname: tls.host || '0.0.0.0', createServer: https.createServer, serverOptions: tlsOptions }, (info) => {
      const at = info as AddressInfo;
      log(`serving https://${tls.host || '0.0.0.0'}:${at.port}  (for other machines; certificate ${tls.cert})`);
    });
    failOnListenError(secure, `${tls.host || '0.0.0.0'}:${tls.port} (server.tls)`);
  }

  // last-use times of sessions are written once a minute; a clean stop writes the rest
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      auth?.close();
      process.exit(0);
    });
  }
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

/** Prefixes one watcher-triggered sync names at most; more paths are folded into their folders. */
const WATCH_SCOPE_MAX = 200;

const WATCHED_TREES = [RAW_DOCS, RAW_SKILLS, WIKI_DIR];
const WATCHED_FILES = new Set(['purpose.md', 'schema.md']);

/**
 * At most `max` sync prefixes that cover every path a watcher reported: while
 * there are too many, the deepest ones are replaced by their folder. A burst
 * of changes under one folder (a copy, an export rewriting a tree) then syncs
 * that folder instead of the whole data dir. Nothing is lifted above the tree
 * it belongs to (raw/docs, raw/skills, wiki), and an anchor file stays itself.
 */
export function coveringPrefixes(paths: Iterable<string>, max: number): string[] {
  const floorOf = (p: string) => WATCHED_TREES.find((t) => p === t || p.startsWith(`${t}/`)) ?? p;
  const depth = (p: string) => p.split('/').length;
  // a path below another one in the set is covered by it already
  const covered = (set: Set<string>) =>
    new Set([...set].filter((p) => {
      for (let up = path.posix.dirname(p); up !== '.' && up !== '/'; up = path.posix.dirname(up)) if (set.has(up)) return false;
      return true;
    }));
  let set = covered(new Set(paths));
  while (set.size > max) {
    const liftable = [...set].filter((p) => p !== floorOf(p));
    if (liftable.length === 0) break;
    const deepest = liftable.reduce((d, p) => Math.max(d, depth(p)), 0);
    set = covered(new Set([...set].map((p) => (p !== floorOf(p) && depth(p) === deepest ? path.posix.dirname(p) : p))));
  }
  return [...set].sort();
}

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

function summarize(log: (msg: string) => void, label: string, s: SyncStats): void {
  log(`${label}: ${s.indexed} applied, ${s.unchanged} unchanged, ${s.disposed} disposed, ${s.chunks} chunks, ${s.pagesRegenerated} pages regenerated${s.pagesArchived ? `, ${s.pagesArchived} archived` : ''}${s.datasourceErrors.length ? `, datasource errors: ${s.datasourceErrors.length}` : ''}`);
}

/** One stat-only look at what the data-dir watcher follows. */
interface WatchedFiles {
  /** When the walk began. */
  at: number;
  /** Data-dir-relative path → ctimeMs, which every write, rename or metadata change moves. */
  files: Map<string, number>;
  /** Folders left out because the folder machinery syncs them. */
  owned: string[];
}

/**
 * Stat every file under raw/docs, raw/skills and wiki, and the anchor files,
 * reading none. A linked mirror or a folder an import or unlink is writing is
 * not walked at all: with its exports linked, a 34k-file workspace costs a
 * few directory listings.
 */
function scanWatched(ctx: SyncContext): WatchedFiles {
  const look: WatchedFiles = { at: Date.now(), files: new Map(), owned: [] };
  const stat = (rel: string) => {
    try {
      look.files.set(rel, fs.statSync(path.join(ctx.dataDir, rel)).ctimeMs);
    } catch {
      // gone meanwhile, or an anchor file that was never there
    }
  };
  const visit = (rel: string) => {
    if (syncedByFolders(ctx.dataDir, ctx.config, rel)) {
      look.owned.push(rel);
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(ctx.dataDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (isHiddenName(e.name)) continue;
      if (e.isDirectory()) visit(`${rel}/${e.name}`);
      else stat(`${rel}/${e.name}`);
    }
  };
  for (const tree of WATCHED_TREES) visit(tree);
  for (const file of WATCHED_FILES) stat(file);
  return look;
}

export interface DataDirWatchOptions {
  log: (msg: string) => void;
  /** Register a background sync so shutdown waits for it. */
  track: <T>(job: Promise<T>) => Promise<T>;
  /** Quiet time after the last event before a sync runs, and after another watcher opened or closed before a catch-up. */
  debounceMs?: number;
}

/**
 * Watch docs + wiki for changes → debounced scoped sync (a path that is gone
 * disposes what was under it). One recursive watcher for the data dir, never
 * one per file (src/fs/watch.ts). Null when the data dir cannot be watched.
 *
 * Whenever another watcher of the process opens or closes (a folder linked, a
 * linked source back, a workspace opened), this one is blind for a moment,
 * and nothing re-syncs raw/docs or wiki on a timer. So a moment later a
 * catch-up stats what this watcher follows and syncs each change since its
 * last look that the watcher never reported. Linked mirrors are not walked,
 * and what the watcher did report is not synced twice: linking a folder costs
 * a large workspace a stat walk, not a re-index.
 */
export function watchDataDir(ctx: SyncContext, opts: DataDirWatchOptions): TreeWatcher | null {
  const { log, track } = opts;
  const debounceMs = opts.debounceMs ?? 1500;
  let closed = false;
  let watchTimer: NodeJS.Timeout | null = null;
  let catchUpTimer: NodeJS.Timeout | null = null;
  let running = false;
  const pending = new Set<string>();
  let fullSync = false;
  // when the watcher last reported each path ('.' for everything): the sync
  // that report started (or the folder machinery's) reads it after that
  let reported = new Map<string, number>();
  // taken before the watch opens: whatever its stream misses from here on shows up in a catch-up
  let seen = scanWatched(ctx);

  const flush = () => {
    watchTimer = null;
    if (closed) return;
    if (running) {
      schedule();
      return;
    }
    running = true;
    // a burst under one folder syncs that folder, never the whole data dir
    const only = fullSync ? undefined : coveringPrefixes(pending, WATCH_SCOPE_MAX);
    pending.clear();
    fullSync = false;
    void track((async () => {
      try {
        const stats = await sync(ctx, { only });
        if (stats.indexed || stats.disposed || stats.pagesRegenerated) summarize(log, 'watch sync', stats);
      } catch (err) {
        log(`watch sync failed: ${err instanceof Error ? err.message : err}`);
      } finally {
        running = false;
      }
    })());
  };
  const schedule = () => {
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = setTimeout(flush, debounceMs);
  };
  const trigger = (absPath: string) => {
    if (closed) return;
    const rel = path.relative(ctx.dataDir, absPath).split(path.sep).join('/');
    // an event naming no path (the data dir itself) is no source
    if (!rel) return;
    const outside = rel.startsWith('..');
    // a linked mirror is synced by its link (src/ingest/folders.ts)
    if (!outside && linkOwning(linkedFolders(ctx.config), rel)) return;
    // seen: synced from here on — by the sync below, or by the import or
    // unlink writing that folder, which syncs what it writes itself
    reported.set(outside ? '.' : rel, Date.now());
    if (!outside && syncedByFolders(ctx.dataDir, ctx.config, rel)) return;
    // every path is a prefix: a directory that came is synced whole, a path
    // that is gone — a file or a directory — disposes everything under it
    if (outside) fullSync = true;
    else pending.add(rel);
    schedule();
  };

  /**
   * When `rel`, gone now, went at the latest: its removal touched the nearest
   * folder still there, and any later change in that folder only moves this on.
   */
  const goneAt = (rel: string): number => {
    for (let dir = path.posix.dirname(rel); ; dir = path.posix.dirname(dir)) {
      try {
        return fs.statSync(path.join(ctx.dataDir, dir)).ctimeMs;
      } catch {
        if (dir === '.') return Infinity;
      }
    }
  };
  const catchUp = () => {
    catchUpTimer = null;
    if (closed) return;
    const before = seen;
    const saw = reported;
    seen = scanWatched(ctx);
    reported = new Map();
    const reportedSince = (rel: string, at: number) => {
      for (let p = rel; ; p = path.posix.dirname(p)) {
        if ((saw.get(p) ?? -Infinity) >= at) return true;
        if (p === '.') return false;
      }
    };
    const under = (dirs: string[], rel: string) => dirs.some((d) => rel.startsWith(`${d}/`));
    const missed: string[] = [];
    for (const [rel, ctime] of seen.files) {
      const was = before.files.get(rel);
      if (was === ctime) continue;
      // a folder the folder machinery has let go of since (a link removed with
      // its copies kept, an import's claim lapsed): it synced what it held
      if (was === undefined && ctime < before.at && under(before.owned, rel)) continue;
      if (!reportedSince(rel, ctime)) missed.push(rel);
    }
    for (const rel of before.files.keys()) {
      if (seen.files.has(rel) || under(seen.owned, rel)) continue;
      if (!reportedSince(rel, goneAt(rel))) missed.push(rel);
    }
    if (missed.length === 0) return;
    const shown = missed.length > 5 ? `${missed.slice(0, 5).join(', ')} and ${missed.length - 5} more` : missed.join(', ');
    log(`watch catch-up: ${missed.length} change(s) the watcher never reported: ${shown}`);
    for (const rel of missed) trigger(path.join(ctx.dataDir, rel));
  };

  let watcher: TreeWatcher;
  try {
    watcher = watchTree(ctx.dataDir, (abs) => trigger(abs), {
      ignore: (rel) => !isWatchedSource(rel),
      onError: (err) => log(`watcher error: ${err.message}`),
      // a look once the rebuilt stream is up; a burst of opens (a workspace
      // starting with its links) gets one
      onBlinded: () => {
        if (closed) return;
        if (catchUpTimer) clearTimeout(catchUpTimer);
        catchUpTimer = setTimeout(catchUp, debounceMs);
      },
    });
  } catch (err) {
    log(`cannot watch ${ctx.dataDir}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
  log('watching raw/docs, raw/skills, wiki for changes');
  return {
    close: () => {
      closed = true;
      if (watchTimer) clearTimeout(watchTimer);
      if (catchUpTimer) clearTimeout(catchUpTimer);
      watcher.close();
    },
  };
}

interface StartedServices {
  stop: () => Promise<void>;
  kickResearch: () => void;
  track: <T>(job: Promise<T>) => Promise<T>;
  folders: LinkedFolders;
  labeling: LabelingScheduler;
  work: WorkBroker;
  localWorkers: LocalLabelingWorkers;
  processing: LabelingProcessing;
  translations: TranslateSource;
  calls: CallLedger;
}

function startWorkspaceServices(ctx: AppContext, log: (msg: string) => void, opts: { mcp?: () => McpEndpoint | null; rootDataDir?: string } = {}): StartedServices {
  let disposed = false;
  // vectors are computed after a document is indexed, never while it is: an
  // import or sync does not wait on the rate-limited pool, and a spent daily
  // quota leaves chunks pending instead of documents unindexed
  const embeddings = new EmbeddingBackfill(ctx, { log, concurrency: Math.max(1, ctx.config.ingest.concurrency ?? 4) });
  ctx.embeddings = embeddings;
  embeddings.start();
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
  // initial trace sync + full reconciliation (async, doesn't block startup)
  void track((async () => {
    try {
      const ts = await syncTraces(ctx.store, ctx.config);
      if (disposed) return;
      if (ts.copied || ts.skills) log(`trace sync: ${ts.copied} traces, ${ts.skills} skill files`);
      summarize(log, 'sync', await sync(ctx, { onProgress: (m) => log(m) }));
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

  // extraction, summary pages and judge calls as leased work (src/labeling,
  // src/work): this machine's slots and remote workers take segments,
  // summaries and a review's judge calls as they free up, nothing waits for
  // the slowest call; the duplicate audit of what was written and the views
  // that depend on it follow on their own loop (docs/design/09, 10, 11). This
  // machine's slots and the reviews spend model calls, so none of them starts
  // on its own: someone starts the processing (the app, POST
  // /api/labeling/start) and it runs until stopped or shut down.
  const leaseMs = Math.max(1, ctx.config.server.remote?.leaseMinutes ?? 15) * 60_000;
  let summaries: SummarySource | null = null;
  const remoteJudge = { askedLately: () => false };
  const labeling = new LabelingScheduler({ dataDir: ctx.dataDir, store: ctx.store, config: () => ctx.config, log, onWritten: (p) => summaries?.prefer(p) }, { leaseMs });
  // a review's judge calls: this machine's judge slots answer them, and remote
  // workers too where the workspace offers them and one asked lately
  const judges = new JudgeSource({
    enabled: () => judgesHere(ctx.config) || (offeredRemotely(ctx.config, 'judge') && remoteJudge.askedLately()),
    deadlineMs: () => Math.max(1, ctx.config.server.remote?.callDeadlineMinutes ?? 20) * 60_000,
    log,
  }, { leaseMs });
  const followUp = startFollowUp(ctx, labeling, { log, track, active: false, judge: judges, onPause: () => judges.cancelWaiting('processing stopped') });
  summaries = new SummarySource(ctx, { serialize: followUp.serialize, log }, { leaseMs });
  // translations into the content languages (docs/design/17): idle while they are off
  const translations = new TranslateSource({ dataDir: ctx.dataDir, store: ctx.store, config: () => ctx.config, log }, { leaseMs });
  void translations.backfill();
  // every answered call is measured, so the next estimate learns from it (docs/design/18)
  const calls = CallLedger.forWorkspace(ctx.dataDir, { log });
  const work = new WorkBroker([labeling, summaries, judges, translations], { shares: () => ctx.config.server.remote?.shares, ledger: calls });
  remoteJudge.askedLately = () => work.askedLately('judge', 2 * 60_000);
  const localWorkers = new LocalLabelingWorkers(work, () => ctx.config, { log });
  const processing = new LabelingProcessing(localWorkers, followUp, log);
  log('processing is stopped until an administrator starts it (the Processing button in the app or the web UI, or POST /api/labeling/start)');

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
  // a link never follows into the data root, whatever the config says (src/ingest/folders.ts)
  const folders = new LinkedFolders(ctx, { log, track, policy: { protectedRoots: opts.rootDataDir ? [opts.rootDataDir] : [] } });
  folders.start();

  // nightly dream + the tier-2 pass
  const dreamTimer = startDreamScheduler(ctx, log);
  const nightly = nightlySchedule(ctx.config);
  if (nightly) log(`dream scheduled daily at ${nightly.dream} (lookback ${ctx.config.dream.lookbackDays}d)`);
  else log(`dream.schedule ${JSON.stringify(ctx.config.dream.schedule)} is not a 24-hour "HH:MM" time: the nightly dream and tier-2 pass will not run`);
  const tier2Timer = startTier2Scheduler(ctx, log);

  // watch docs + wiki for changes → debounced scoped sync
  const dataWatcher = ctx.config.ingest.watch ? watchDataDir(ctx, { log, track }) : null;

  return {
    stop: async () => {
      disposed = true;
      dataWatcher?.close();
      await research?.stop();
      clearInterval(syncTimer);
      followUp.stop();
      localWorkers.stop();
      await work.stop();
      calls.flush();
      clearInterval(flushTimer);
      clearInterval(dreamTimer);
      clearInterval(tier2Timer);
      clearInterval(dsTimer);
      await folders.stop();
      await Promise.allSettled([...activeJobs]);
      await embeddings.stop();
      ctx.embeddings = undefined;
      await ctx.datasources.closeAll();
    },
    kickResearch: () => research?.kick(),
    track,
    folders,
    labeling,
    work,
    localWorkers,
    processing,
    translations,
    calls,
  };
}

/**
 * Run the tier-2 pass daily, a few minutes after the dream schedule
 * (`nightlySchedule`). Like Dream's, it reads the schedule on every tick, so the
 * pass keeps following Dream when the config changes. Exported for tests.
 */
export function startTier2Scheduler(ctx: AppContext, log: (msg: string) => void): NodeJS.Timeout {
  let lastRun = '';
  const timer = setInterval(async () => {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const today = now.toISOString().slice(0, 10);
    if (hhmm === nightlySchedule(ctx.config)?.tier2 && lastRun !== today) {
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
  const target = nightlySchedule(ctx.config)?.tier2;
  if (target) log(`tier2 pass scheduled daily at ${target}`);
  return timer;
}
