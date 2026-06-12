import { serve } from '@hono/node-server';
import chokidar from 'chokidar';
import path from 'node:path';
import { AppContext } from '../context.js';
import { startDreamScheduler } from '../dream/dream.js';
import { runIngest } from '../ingest/pipeline.js';
import { syncTraces } from '../traces/sync.js';
import { createApp } from './app.js';

/**
 * `knode-os serve` — HTTP API + web UI, plus the background loops:
 * file watcher → incremental ingest, periodic trace sync, nightly dream.
 */
export async function startServer(ctx: AppContext): Promise<void> {
  const log = (msg: string) => console.log(`[knode-os] ${msg}`);
  const app = createApp(ctx, log);
  const { port, host } = ctx.config.server;

  serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    log(`serving http://${host}:${info.port}  (data: ${ctx.dataDir})`);
  });

  // initial sync + ingest (async, doesn't block startup)
  (async () => {
    try {
      const ts = await syncTraces(ctx.store, ctx.config);
      if (ts.copied || ts.skills) log(`trace sync: ${ts.copied} traces, ${ts.skills} skill files`);
      const stats = await runIngest(ctx.store, ctx.config, ctx.embedder, ctx.llm, { onProgress: (m) => log(m) });
      log(`ingest: ${stats.indexed} indexed, ${stats.unchanged} unchanged, ${stats.chunks} chunks, ${stats.entities} entity refs`);
    } catch (err) {
      log(`startup ingest failed: ${err instanceof Error ? err.message : err}`);
    }
  })();

  // periodic trace sync
  const interval = Math.max(1, ctx.config.trace.syncIntervalMinutes) * 60_000;
  const syncTimer = setInterval(async () => {
    try {
      const ts = await syncTraces(ctx.store, ctx.config);
      if (ts.copied || ts.skills) {
        log(`trace sync: ${ts.copied} traces, ${ts.skills} skill files`);
        await runIngest(ctx.store, ctx.config, ctx.embedder, ctx.llm, { only: ['raw/skills'] });
      }
    } catch (err) {
      log(`trace sync failed: ${err instanceof Error ? err.message : err}`);
    }
  }, interval);
  syncTimer.unref?.();

  // nightly dream
  startDreamScheduler(ctx.store, ctx.config, ctx.llm, log);
  log(`dream scheduled daily at ${ctx.config.dream.schedule} (lookback ${ctx.config.dream.lookbackDays}d)`);

  // watch docs + wiki for changes → debounced incremental ingest
  if (ctx.config.ingest.watch) {
    let timer: NodeJS.Timeout | null = null;
    let running = false;
    const trigger = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        if (running) return trigger();
        running = true;
        try {
          const stats = await runIngest(ctx.store, ctx.config, ctx.embedder, ctx.llm);
          if (stats.indexed || stats.removed) log(`watch ingest: ${stats.indexed} indexed, ${stats.removed} removed`);
        } catch (err) {
          log(`watch ingest failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          running = false;
        }
      }, 1500);
    };
    chokidar
      .watch([
        path.join(ctx.dataDir, 'raw/docs'),
        path.join(ctx.dataDir, 'raw/skills'),
        path.join(ctx.dataDir, 'wiki'),
        path.join(ctx.dataDir, 'purpose.md'),
        path.join(ctx.dataDir, 'schema.md'),
      ], { ignoreInitial: true })
      .on('all', trigger);
    log('watching raw/docs, raw/skills, wiki for changes');
  }
}
