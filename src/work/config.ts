import crypto from 'node:crypto';
import { KnodeConfig, LlmConfig, LlmProvider, resolveRoutedLlmConfig, routeTargets } from '../config.js';
import { cursorModel, effortFor, speedFor } from '../llm/cli.js';
import { SharedKind, WORK_KINDS, WorkKind } from './kinds.js';

/**
 * What a remote worker reads from the server instead of being told by hand
 * (`GET …/work/config`, docs/design/12): which kinds of work it may take
 * here, how long a lease lasts, how kinds share a slot, and — per kind — how
 * the server itself would run the call on each coding-agent CLI.
 *
 * A hint is what `serve` would pass that CLI for the stage: the model, and
 * the effort and speed in that CLI's own terms (`effortFor`, `speedFor`,
 * cursor's effort inside the model name). Extraction's come from
 * `extraction.workers` (with their overrides, listed with 0 slots or not),
 * then the Extract stage's route; summaries' from the Summarize stage's
 * route; judge calls' from the Judge stage's. A worker applies one to a
 * backend of the same CLI unless it was given a model of its own. Endpoints
 * (`api` backends) get none: model names differ between them.
 */

export type CliFamily = 'codex' | 'claude' | 'cursor';

export interface BackendHint {
  model?: string;
  effort?: string;
  speed?: string;
}

export type WorkerHints = Partial<Record<WorkKind, Partial<Record<CliFamily, BackendHint>>>>;

export interface WorkerConfig {
  /** A hash of everything else here: every lease answer carries it, and a worker reads this again when it changes. */
  version: string;
  leaseSeconds: { llm: number };
  /** The kinds this token may take here and the workspace offers remote workers. */
  kinds: Record<WorkKind, boolean>;
  shares: Record<SharedKind, number>;
  hints: WorkerHints;
}

const FAMILY: Partial<Record<LlmProvider, CliFamily>> = { 'codex-cli': 'codex', 'claude-cli': 'claude', 'cursor-cli': 'cursor' };

/** Whether the workspace offers this kind of work to remote workers: extraction always, summaries unless turned off, judge calls only when turned on. */
export function offeredRemotely(config: KnodeConfig, kind: WorkKind): boolean {
  if (kind === 'summarize') return config.server.remote?.offer?.summarize !== false;
  if (kind === 'judge') return config.server.remote?.offer?.judge === true;
  return true;
}

export function workerHints(config: KnodeConfig): WorkerHints {
  const targets = routeTargets(config);
  const route = config.extraction.entityLlm;
  const extract: LlmConfig[] = [];
  for (const w of config.extraction.workers ?? []) {
    if (!w || typeof w.use !== 'string' || !targets.some((t) => t.id === w.use.trim())) continue;
    extract.push(resolveRoutedLlmConfig(config.llm, {
      ...route,
      use: w.use.trim(),
      model: w.model ?? '',
      effort: w.effort ?? 'default',
      speed: w.speed ?? 'default',
    }, targets));
  }
  extract.push(resolveRoutedLlmConfig(config.llm, route, targets, config.extraction.tier1Model));
  return {
    extract: hintsFrom(extract),
    summarize: hintsFrom([resolveRoutedLlmConfig(config.llm, config.extraction.summaryLlm, targets)]),
    judge: hintsFrom([resolveRoutedLlmConfig(config.llm, config.extraction.judgeLlm, targets)]),
  };
}

/** One hint per CLI, from the first configuration that runs on it. */
function hintsFrom(configs: LlmConfig[]): Partial<Record<CliFamily, BackendHint>> {
  const out: Partial<Record<CliFamily, BackendHint>> = {};
  for (const llm of configs) {
    const family = FAMILY[llm.provider];
    if (!family || out[family]) continue;
    const hint: BackendHint = {};
    if (family === 'cursor') {
      const model = cursorModel(llm.model, llm.effort);
      if (model) hint.model = model;
    } else {
      if (llm.model) hint.model = llm.model;
      const effort = effortFor(llm.provider, llm.effort);
      if (effort) hint.effort = effort;
      const speed = speedFor(llm.provider, llm.speed);
      if (speed) hint.speed = speed;
    }
    out[family] = hint;
  }
  return out;
}

/** The configuration a worker holding a token that may take `allowed` reads for this workspace. */
export function workerConfig(config: KnodeConfig, opts: { allowed: readonly WorkKind[]; leaseMs: number; shares: Record<SharedKind, number> }): WorkerConfig {
  const body = {
    leaseSeconds: { llm: Math.round(opts.leaseMs / 1000) },
    kinds: Object.fromEntries(WORK_KINDS.map((k) => [k, opts.allowed.includes(k) && offeredRemotely(config, k)])) as Record<WorkKind, boolean>,
    shares: opts.shares,
    hints: workerHints(config),
  };
  const version = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
  return { version, ...body };
}
