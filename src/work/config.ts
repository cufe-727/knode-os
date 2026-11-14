import crypto from 'node:crypto';
import { KnodeConfig, LlmConfig, LlmProvider, resolveRoutedLlmConfig, routeTargets } from '../config.js';
import { EmbeddingProvider } from '../ingest/embeddings.js';
import { contentLanguages } from '../lang/languages.js';
import { cursorModel, effortFor, speedFor } from '../llm/cli.js';
import { DEFAULT_PROBE_COSINE, embedBatchPlan, embedOffered, poolModelOf, postprocessFor, PROBE_TEXTS } from './embed.js';
import { isEvalKind, SharedKind, WORK_KINDS, WorkKind } from './kinds.js';

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
 * route; judge calls' from the Judge stage's; translations' from the
 * Translate stage's. A worker applies one to a
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

/**
 * What an embed slot needs to know (docs/design/12 §4.1): the vector space,
 * how the server cuts batches and finishes vectors, and — for an own endpoint
 * — whether it may use one here and the probe set it must pass first. Sent
 * only to a token with the `embed` scope, where the workspace offers embed work.
 */
export interface WorkerEmbedding {
  /** The identity every vector must belong to, e.g. `pool:bge-m3:1024:l2-v1`. */
  vectorModel: string;
  /** The model it stands for: an own endpoint must serve one with the same canonical name. */
  model: string;
  dimensions: number;
  batchSize: number;
  inputChars: number;
  /** What the server does to a vector it takes: "l2" for a pool (workers return raw vectors). */
  postprocess: 'l2' | 'none';
  /** Whether a worker may embed on an endpoint of its own here: pool identities only. */
  ownEndpoints: boolean;
  /** The texts an own endpoint embeds to calibrate, and the cosine each vector must reach. */
  probe: { texts: readonly string[]; minCosine: number } | null;
}

export interface WorkerConfig {
  /** A hash of everything else here: every lease answer carries it, and a worker reads this again when it changes. */
  version: string;
  leaseSeconds: { llm: number; embed?: number; session?: number; eval?: number };
  /** The kinds this token may take here and the workspace offers remote workers. */
  kinds: Record<WorkKind, boolean>;
  shares: Record<SharedKind | 'eval', number>;
  hints: WorkerHints;
  /** Present when the token may take embed work here. */
  embedding?: WorkerEmbedding;
}

const FAMILY: Partial<Record<LlmProvider, CliFamily>> = { 'codex-cli': 'codex', 'claude-cli': 'claude', 'cursor-cli': 'cursor' };

/**
 * Whether the workspace offers this kind of work to remote workers:
 * extraction always, summaries unless turned off, judge calls, research
 * sessions and evaluation work only when turned on, translations while content languages are on
 * (docs/design/17) unless turned off.
 */
export function offeredRemotely(config: KnodeConfig, kind: WorkKind): boolean {
  if (kind === 'summarize') return config.server.remote?.offer?.summarize !== false;
  if (kind === 'judge') return config.server.remote?.offer?.judge === true;
  if (kind === 'session') return config.server.remote?.offer?.session === true;
  // an evaluation run's work is the server's, not the workspace's: settings are server-wide (docs/design/27 §8)
  if (isEvalKind(kind)) return config.server.remote?.offer?.eval === true;
  if (kind === 'translate') return contentLanguages(config).on && config.server.remote?.offer?.translate !== false;
  // vectors are leased work only in deferred mode (docs/design/12 §3.3)
  if (kind === 'embed') return embedOffered(config);
  return true;
}

/** The embedding section of `work/config` for the workspace's embedder. */
export function workerEmbedding(config: KnodeConfig, embedder: Pick<EmbeddingProvider, 'model' | 'dimensions'>): WorkerEmbedding {
  const plan = embedBatchPlan(config);
  const poolModel = poolModelOf(embedder.model);
  const threshold = Number(config.server.remote?.embedProbeCosine);
  return {
    vectorModel: embedder.model,
    model: poolModel ?? embedder.model,
    dimensions: embedder.dimensions,
    batchSize: plan.batchSize,
    inputChars: plan.inputChars,
    postprocess: postprocessFor(embedder.model),
    ownEndpoints: poolModel !== null,
    probe: poolModel ? { texts: PROBE_TEXTS, minCosine: Number.isFinite(threshold) && threshold > 0 && threshold <= 1 ? threshold : DEFAULT_PROBE_COSINE } : null,
  };
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
    translate: hintsFrom([resolveRoutedLlmConfig(config.llm, config.extraction.translateLlm, targets)]),
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
export function workerConfig(config: KnodeConfig, opts: {
  allowed: readonly WorkKind[];
  leaseMs: number;
  shares: Record<SharedKind | 'eval', number>;
  /** The workspace's embedder and how long an embed lease lasts, for a token that may take embed work. */
  embed?: { embedder: Pick<EmbeddingProvider, 'model' | 'dimensions'>; leaseMs: number } | null;
  /** How long a research session's lease lasts (renewed while it runs), where sessions are leased. */
  sessionLeaseMs?: number | null;
  /** How long an evaluation lease lasts (renewed while it runs), where eval work is leased. */
  evalLeaseMs?: number | null;
}): WorkerConfig {
  const kinds = Object.fromEntries(WORK_KINDS.map((k) => [k, opts.allowed.includes(k) && offeredRemotely(config, k)])) as Record<WorkKind, boolean>;
  const embedding = kinds.embed && opts.embed ? workerEmbedding(config, opts.embed.embedder) : undefined;
  const session = kinds.session && opts.sessionLeaseMs ? Math.round(opts.sessionLeaseMs / 1000) : null;
  const evalLease = (kinds['eval-call'] || kinds['eval-session']) && opts.evalLeaseMs ? Math.round(opts.evalLeaseMs / 1000) : null;
  const body = {
    leaseSeconds: {
      llm: Math.round(opts.leaseMs / 1000),
      ...(embedding && opts.embed ? { embed: Math.round(opts.embed.leaseMs / 1000) } : {}),
      ...(session ? { session } : {}),
      ...(evalLease ? { eval: evalLease } : {}),
    },
    kinds,
    shares: opts.shares,
    hints: workerHints(config),
    ...(embedding ? { embedding } : {}),
  };
  const version = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
  return { version, ...body };
}
