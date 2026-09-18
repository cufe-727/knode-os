import { AppContext } from '../context.js';
import { claimNextJob, requeueStale, updateJob } from './jobs.js';
import { killActiveAgents } from './launch.js';
import { autoAcceptRecommendations } from './recommend.js';
import { resolveResearchAgent, runResearchJob } from './runner.js';
import { McpEndpoint } from './workspace.js';

/**
 * The queue loop `serve` runs per workspace: claim the oldest queued job when
 * a slot is free, run it, repeat. Jobs left `running` by a previous process
 * are queued again at start.
 */
export function startResearchLoop(
  ctx: AppContext,
  opts: { mcp: () => McpEndpoint | null; log: (msg: string) => void; intervalMs?: number },
): { stop: () => Promise<void>; kick: () => void } {
  let disposed = false;
  let running = 0;
  const inflight = new Set<Promise<unknown>>();
  let warnedNoAgent = false;

  void requeueStale(ctx.store).then((n) => n && opts.log(`research: ${n} interrupted job(s) queued again`)).catch(() => {});

  const tick = async () => {
    if (disposed) return;
    const concurrency = Math.max(1, ctx.config.research?.concurrency ?? 1);
    while (!disposed && running < concurrency) {
      const mcp = opts.mcp();
      if (!mcp) return;
      const agent = resolveResearchAgent(ctx.config);
      if (!agent) {
        if (!warnedNoAgent) {
          opts.log(`research: no agent configured — queued jobs wait. Set research.agent in knode.config.json to a CLI (claude-cli / codex-cli / cursor-cli), a connection id, or 'default' to run the built-in agent on the default LLM connection`);
          warnedNoAgent = true;
        }
        return;
      }
      warnedNoAgent = false;
      let job = await claimNextJob(ctx.store).catch(() => null);
      if (!job && ctx.config.research?.auto?.enabled && running === 0) {
        // nothing queued: let auto mode accept the best recommendation within today's budget
        const n = await autoAcceptRecommendations(ctx, ctx.config.research.auto.dailyJobs ?? 3).catch(() => 0);
        if (n > 0) job = await claimNextJob(ctx.store).catch(() => null);
      }
      if (!job) return;
      running++;
      const p = runResearchJob(ctx, job, { mcp, log: opts.log })
        .catch(async (err) => {
          opts.log(`research ${job.id} crashed: ${err instanceof Error ? err.message : err}`);
          await updateJob(ctx.store, job.id, { status: 'failed', error: String(err instanceof Error ? err.message : err), finishedAt: new Date().toISOString() }).catch(() => {});
        })
        .finally(() => {
          running--;
          inflight.delete(p);
        });
      inflight.add(p);
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs ?? 30_000);
  timer.unref?.();
  setTimeout(() => void tick(), 2_000).unref?.();

  return {
    stop: async () => {
      disposed = true;
      clearInterval(timer);
      killActiveAgents();
      await Promise.allSettled([...inflight]);
    },
    /** Claim queued work now instead of at the next tick (a job was just queued from the UI). */
    kick: () => void tick(),
  };
}
