import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { embeddingDeferred, KnodeConfig, resolveSecret } from '../config.js';
import { EMBED_INPUT_CHARS } from '../constants.js';
import { canonicalEmbeddingModel, embeddingLimits, poolMembers } from '../ingest/embedding-router.js';
import { estimateEmbeddingTokens } from '../ingest/embedding-tokens.js';
import { EmbeddingProvider } from '../ingest/embeddings.js';
import { classifyFailure, FailureKind } from '../labeling/failures.js';
import { CompleteResult, TaskOutcome, WorkerIdentity } from '../labeling/scheduler.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../store/db.js';
import { EmbedWorkTask, LeaseRequest, noFailures, SourceStatus, WorkSource, WorkTask } from './broker.js';

/**
 * Embedding as leased work (docs/design/12 §3.3, §4.3).
 *
 * In `deferred` mode (`ingest.embedding`) a sync writes chunks and their
 * keyword index and leaves the vectors to a backlog: the chunks of indexed
 * documents with no vector for the workspace's embedding identity, newest
 * documents first. The duplicate audits ask for their entity and claim vectors
 * through a `BrokeredEmbedder`, which offers them on the same queue ahead of
 * the backlog and waits for them (at most 5 minutes). `serve`'s own embed
 * slots (`ingest.embedSlots`, `LocalEmbedSlots` below) and remote workers'
 * embed slots lease batches from it.
 *
 * The server stays the only writer and the only judge of a vector. Workers
 * hand back raw vectors; every batch is checked (count, dimension, finite
 * values, a non-zero norm), post-processed as the identity says (a pool's
 * vectors are L2-normalized, so a remote vector ends up as the pool would have
 * made it), dropped when the identity changed since the lease, and its chunk
 * vectors written in one transaction.
 *
 * A remote worker embeds on an endpoint of its own (a local bge-m3, a TEI, an
 * account of its own) only for a pool identity, under the same canonical model
 * name, and only once it has passed calibration: it embeds the probe set
 * (`PROBE_TEXTS`), and each vector must reach `server.remote.embedProbeCosine`
 * (0.98) against reference vectors this machine made with its own pool, kept
 * per identity in `.knode/embedding-probe.json`. One batch in 100 then carries
 * a probe text; a miss parks that worker's embed slots.
 *
 * `serve`'s own embed slots may do the same on an endpoint of this machine
 * (`ingest.embedEndpoint`, set in Settings, which checks it first with
 * `checkEmbedEndpoint`): calibrated and spot-checked like a remote worker's,
 * and back on the pool while it is refused or parked.
 */

/** Sixteen fixed texts, Chinese and English, an own endpoint embeds before its vectors are taken. */
export const PROBE_TEXTS: readonly string[] = [
  '宁德时代发布第三季度报告，营业收入同比增长12.5%，净利润率回升至15%。',
  '比亚迪十月新能源汽车销量突破五十万辆，海外市场占比继续提高。',
  '央行下调存款准备金率0.5个百分点，预计释放长期资金约一万亿元。',
  '沪深300指数今日收涨1.2%，两市成交额放大至1.1万亿元。',
  '公司拟以每股不超过18元的价格回购股份，回购总额不超过5亿元。',
  '光伏组件价格连续三个月下跌，产业链库存压力明显加大。',
  '这家半导体企业的毛利率从32%提升到41%，主要受益于先进封装业务。',
  '知识库的检索质量取决于切分、向量召回和关键词召回的配合。',
  'The Federal Reserve held interest rates steady at its November meeting.',
  'Revenue grew 18% year over year, driven by demand for data center GPUs.',
  'Lithium carbonate prices fell below 80,000 yuan per tonne for the first time since 2021.',
  'The company announced a two-for-one stock split, effective next month.',
  'Vector search returns the chunks whose embeddings lie closest to the query.',
  'A knowledge graph links entities, relations and claims back to the documents they came from.',
  '电池厂商开始把部分产能转向钠离子电池，以降低对锂资源的依赖。',
  'Hello, world.',
];

export const PROBE_FILE = '.knode/embedding-probe.json';
export const DEFAULT_PROBE_COSINE = 0.98;
const PROBE_SHA = crypto.createHash('sha256').update(PROBE_TEXTS.join('\u0000')).digest('hex').slice(0, 16);

/* ------------------------------ vectors ------------------------------ */

/** Vectors as they travel: little-endian float32, n × dimensions, base64. */
export function encodeVectors(vectors: number[][]): string {
  const dims = vectors[0]?.length ?? 0;
  const buf = Buffer.alloc(vectors.length * dims * 4);
  vectors.forEach((v, i) => v.forEach((x, j) => buf.writeFloatLE(x, (i * dims + j) * 4)));
  return buf.toString('base64');
}

/** The vectors in a base64 float32 block; throws unless it holds exactly `count` × `dims` values. */
export function decodeVectors(b64: string, count: number, dims: number): number[][] {
  const buf = Buffer.from(b64, 'base64');
  if (!(dims > 0) || buf.length !== count * dims * 4) {
    throw new Error(`expected ${count} × ${dims} float32 values (${count * dims * 4} bytes), got ${buf.length} bytes`);
  }
  return Array.from({ length: count }, (_, i) => Array.from({ length: dims }, (_, j) => buf.readFloatLE((i * dims + j) * 4)));
}

/** How a vector space's vectors are finished: a pool L2-normalizes, anything else is kept as its provider made it. */
export function postprocessFor(vectorModel: string): 'l2' | 'none' {
  return vectorModel.startsWith('pool:') ? 'l2' : 'none';
}

/** The canonical model name a pool identity (`pool:bge-m3:1024:l2-v1`) stands for, or null for any other. */
export function poolModelOf(vectorModel: string): string | null {
  const m = /^pool:(.+):(\d+):[^:]+$/.exec(vectorModel);
  return m ? m[1] : null;
}

/**
 * Whether a model name means the pool's model: the same canonical name
 * (`canonicalEmbeddingModel`), an Ollama-style tag (`bge-m3:latest`) aside.
 */
export function sameEmbeddingModel(model: string, poolModel: string): boolean {
  const name = model.trim();
  if (!name) return false;
  const canonical = canonicalEmbeddingModel(poolModel);
  return canonicalEmbeddingModel(name) === canonical || canonicalEmbeddingModel(name.replace(/:[^/:]+$/, '')) === canonical;
}

/**
 * Check a batch of vectors and finish them as the identity says: the count,
 * the dimension, finite values and a non-zero norm, as the pool checks its own
 * answers; then L2 for a pool. Throws on the first that fails.
 */
export function checkVectors(vectors: unknown, count: number, dims: number, postprocess: 'l2' | 'none'): number[][] {
  if (!Array.isArray(vectors) || vectors.length !== count) throw new Error(`expected ${count} vectors, got ${Array.isArray(vectors) ? vectors.length : 'none'}`);
  return vectors.map((v, i) => {
    if (!Array.isArray(v) || v.length !== dims) throw new Error(`vector ${i + 1} has ${Array.isArray(v) ? v.length : 'no'} dimensions, not ${dims}`);
    let sum = 0;
    for (const x of v) {
      if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`vector ${i + 1} has a value that is not a finite number`);
      sum += x * x;
    }
    const norm = Math.sqrt(sum);
    if (!(norm > 0) || !Number.isFinite(norm)) throw new Error(`vector ${i + 1} has a zero or invalid norm`);
    return postprocess === 'l2' ? v.map((x: number) => x / norm) : [...v];
  });
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

/* ------------------------------ batches ------------------------------ */

export interface EmbedBatchPlan {
  /** Texts per batch: no more than the smallest pool member's batch size. */
  batchSize: number;
  /** Estimated tokens per batch: within the smallest member's minute allowance. */
  tokenCeiling: number;
  /** Each input is cut to this many characters. */
  inputChars: number;
}

/** How the server cuts texts into batches: the way the pool does (src/ingest/embedding-router.ts). */
export function embedBatchPlan(config: Pick<KnodeConfig, 'embedding' | 'embeddingPool' | 'embeddingProviders'>): EmbedBatchPlan {
  const pool = config.embeddingPool;
  if (pool?.enabled) {
    const members = poolMembers(config.embeddingProviders ?? [], pool);
    const batchSize = Math.max(1, Math.min(pool.batchSize, ...members.map((e) => Math.max(1, e.batchSize))));
    let tokenCeiling = Infinity;
    for (const e of members) {
      try {
        tokenCeiling = Math.min(tokenCeiling, embeddingLimits(e).tokensPerMinute);
      } catch {
        // an invalid limit fails the pool's own call; it does not cut batches
      }
    }
    return { batchSize, tokenCeiling, inputChars: EMBED_INPUT_CHARS };
  }
  return { batchSize: Math.max(1, Math.min(128, Math.floor(config.embedding.batchSize) || 16)), tokenCeiling: Infinity, inputChars: EMBED_INPUT_CHARS };
}

/** Texts cut to the plan's input length, then into batches: index ranges into `texts`. */
export function cutBatches(texts: string[], plan: EmbedBatchPlan): { start: number; end: number; tokens: number }[] {
  const out: { start: number; end: number; tokens: number }[] = [];
  let start = 0, tokens = 0;
  for (let i = 0; i < texts.length; i++) {
    const estimate = estimateEmbeddingTokens(texts[i]);
    if (i > start && (i - start >= plan.batchSize || tokens + estimate > plan.tokenCeiling)) {
      out.push({ start, end: i, tokens });
      start = i;
      tokens = 0;
    }
    tokens += estimate;
  }
  if (texts.length > start) out.push({ start, end: texts.length, tokens });
  return out;
}

const inputOf = (text: string, plan: EmbedBatchPlan) => text.slice(0, plan.inputChars) || ' ';

/* ------------------------- the probe reference ------------------------- */

interface ProbeFile {
  version: 1;
  identities: Record<string, { probe: string; dimensions: number; vectors: string; createdAt: string }>;
}

/** This identity's reference vectors for the probe set, if this machine made them already. */
export function readProbeReference(dataDir: string, vectorModel: string, dims: number): number[][] | null {
  try {
    const file = JSON.parse(fs.readFileSync(path.join(dataDir, PROBE_FILE), 'utf8')) as ProbeFile;
    const entry = file.version === 1 ? file.identities?.[vectorModel] : undefined;
    if (!entry || entry.probe !== PROBE_SHA || entry.dimensions !== dims) return null;
    return decodeVectors(entry.vectors, PROBE_TEXTS.length, dims);
  } catch {
    return null;
  }
}

function writeProbeReference(dataDir: string, vectorModel: string, vectors: number[][]): void {
  const file = path.join(dataDir, PROBE_FILE);
  let current: ProbeFile = { version: 1, identities: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ProbeFile;
    if (parsed.version === 1 && parsed.identities) current = parsed;
  } catch {
    // first reference
  }
  current.identities[vectorModel] = { probe: PROBE_SHA, dimensions: vectors[0].length, vectors: encodeVectors(vectors), createdAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** The probe set's reference vectors for this embedder's identity: read from the workspace, or made once with it and kept. */
export async function probeReferenceFor(dataDir: string, embedder: EmbeddingProvider): Promise<number[][]> {
  const stored = readProbeReference(dataDir, embedder.model, embedder.dimensions);
  if (stored) return stored;
  const vectors = checkVectors(await embedder.embed([...PROBE_TEXTS]), PROBE_TEXTS.length, embedder.dimensions, postprocessFor(embedder.model));
  writeProbeReference(dataDir, embedder.model, vectors);
  return vectors;
}

export interface ProbeComparison {
  ok: boolean;
  minCosine: number;
  meanCosine: number;
  /** Why not, when not: the worst probe and its cosine. */
  reason?: string;
}

/** An endpoint's probe vectors (finished) against the reference: every cosine must reach `threshold`. */
export function compareProbe(vectors: number[][], reference: number[][], threshold: number): ProbeComparison {
  const cosines = vectors.map((v, i) => cosine(v, reference[i]));
  const minCosine = Math.min(...cosines);
  const meanCosine = cosines.reduce((a, b) => a + b, 0) / cosines.length;
  if (minCosine >= threshold) return { ok: true, minCosine, meanCosine };
  return { ok: false, minCosine, meanCosine, reason: `probe ${cosines.indexOf(minCosine) + 1} reached cosine ${minCosine.toFixed(4)}, below ${threshold}` };
}

/** The cosine an own endpoint's vectors must reach (`server.remote.embedProbeCosine`, default 0.98). */
export function probeThreshold(config: Pick<KnodeConfig, 'server'>): number {
  const t = Number(config.server.remote?.embedProbeCosine);
  return Number.isFinite(t) && t > 0 && t <= 1 ? t : DEFAULT_PROBE_COSINE;
}

/** An OpenAI-compatible embeddings endpoint of this machine's own (`ingest.embedEndpoint`). */
export interface EmbedEndpoint {
  /** Up to and including `/v1`, e.g. http://127.0.0.1:12020/v1. */
  baseUrl: string;
  /** The model it serves, e.g. BAAI/bge-m3. */
  model: string;
  /** A key, if the endpoint needs one: plain or "env:VAR". */
  apiKey?: string;
}

/** The endpoint the config names for this machine's embed slots, or null when none (or none usable) is set. */
export function localEmbedEndpoint(config: Pick<KnodeConfig, 'ingest'>): EmbedEndpoint | null {
  const e = config.ingest?.embedEndpoint;
  if (!e || typeof e.baseUrl !== 'string' || typeof e.model !== 'string') return null;
  const baseUrl = e.baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/\S+$/.test(baseUrl) || !e.model.trim()) return null;
  return { baseUrl, model: e.model.trim(), ...(e.apiKey ? { apiKey: e.apiKey } : {}) };
}

/**
 * One call to an own endpoint: `/embeddings` with encoding_format "float",
 * as the pool and the worker send it. The vectors come back raw; an error
 * body is never read, since it may echo the key.
 */
export async function embedOnEndpoint(
  endpoint: EmbedEndpoint, inputs: string[], opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ vectors: number[][]; endpointModel: string | null; tokens: number | null }> {
  const key = endpoint.apiKey ? resolveSecret(endpoint.apiKey) : '';
  const res = await (opts.fetch ?? fetch)(`${endpoint.baseUrl.replace(/\/+$/, '')}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: endpoint.model, input: inputs, encoding_format: 'float' }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`embedding endpoint returned HTTP ${res.status}`);
  }
  const body = await res.json() as { data?: { index: number; embedding: unknown }[]; model?: unknown; usage?: { prompt_tokens?: number; total_tokens?: number } };
  const data = Array.isArray(body.data) ? [...body.data].sort((a, b) => a.index - b.index) : null;
  if (!data || data.length !== inputs.length) throw new Error(`embedding response has ${data?.length ?? 'no'} vectors for ${inputs.length} inputs`);
  const tokens = Number(body.usage?.prompt_tokens ?? body.usage?.total_tokens);
  return {
    vectors: data.map((d) => d.embedding as number[]),
    endpointModel: typeof body.model === 'string' ? body.model : null,
    tokens: Number.isFinite(tokens) && tokens > 0 ? tokens : null,
  };
}

export interface EndpointCheck {
  ok: boolean;
  /** What failed: the identity, the model name, the call, or the worst probe's cosine. */
  reason?: string;
  vectorModel: string;
  dimensions: number;
  /** The model the endpoint said it ran, when it said. */
  endpointModel?: string | null;
  minCosine?: number;
  meanCosine?: number;
  threshold: number;
  ms: number;
}

/**
 * Whether an endpoint makes this workspace's vectors (docs/design/12 §4.3): a
 * pool identity, a model with the pool's canonical name, and the probe set
 * embedded within the threshold of the reference this machine's pool made.
 * Settings runs it before an endpoint is saved, and on save again.
 */
export async function checkEmbedEndpoint(
  ctx: { dataDir: string; config: Pick<KnodeConfig, 'server'>; embedder: EmbeddingProvider },
  endpoint: EmbedEndpoint,
  opts: { fetch?: typeof fetch } = {},
): Promise<EndpointCheck> {
  const started = Date.now();
  const { model: vectorModel, dimensions } = ctx.embedder;
  const threshold = probeThreshold(ctx.config);
  const out = (rest: Partial<EndpointCheck> & { ok: boolean }): EndpointCheck => ({ vectorModel, dimensions, threshold, ms: Date.now() - started, ...rest });
  const poolModel = poolModelOf(vectorModel);
  if (!poolModel) return out({ ok: false, reason: `an endpoint of your own is used only with an embedding model pool; this workspace embeds as ${vectorModel}` });
  if (!sameEmbeddingModel(endpoint.model, poolModel)) return out({ ok: false, reason: `${endpoint.model} is not ${poolModel}, the pool's model` });
  let made: Awaited<ReturnType<typeof embedOnEndpoint>>;
  try {
    made = await embedOnEndpoint(endpoint, [...PROBE_TEXTS], { fetch: opts.fetch, timeoutMs: 60_000 });
  } catch (err) {
    return out({ ok: false, reason: `could not embed on ${endpoint.baseUrl}: ${err instanceof Error ? err.message : String(err)}` });
  }
  if (made.endpointModel && !sameEmbeddingModel(made.endpointModel, poolModel)) {
    return out({ ok: false, endpointModel: made.endpointModel, reason: `the endpoint answered as ${made.endpointModel}, not ${poolModel}` });
  }
  let vectors: number[][];
  try {
    vectors = checkVectors(made.vectors, PROBE_TEXTS.length, dimensions, postprocessFor(vectorModel));
  } catch (err) {
    return out({ ok: false, endpointModel: made.endpointModel, reason: `unusable vectors: ${err instanceof Error ? err.message : String(err)}` });
  }
  let reference: number[][];
  try {
    reference = await probeReferenceFor(ctx.dataDir, ctx.embedder);
  } catch (err) {
    return out({ ok: false, endpointModel: made.endpointModel, reason: `the pool could not embed the probe set to compare with: ${err instanceof Error ? err.message : String(err)}` });
  }
  const c = compareProbe(vectors, reference, threshold);
  return out({ ok: c.ok, endpointModel: made.endpointModel, minCosine: c.minCosine, meanCosine: c.meanCosine, ...(c.reason ? { reason: c.reason } : {}) });
}

/* ------------------------------ the source ------------------------------ */

export interface EmbedSourceContext {
  dataDir: string;
  store: Store;
  config: () => KnodeConfig;
  /** This machine's own embedder: the identity, the probe reference, what the audits fall back on. */
  embedder: () => EmbeddingProvider;
  log?: (msg: string) => void;
}

export interface EmbedSourceOptions {
  /** How long a slot may hold a batch before it goes back in line (renewable; default 120 s). */
  leaseMs?: number;
  /** Longest an audit waits for its vectors (default 5 min). */
  requestDeadlineMs?: number;
  /** One batch in this many, to a calibrated own endpoint, carries a probe text (default 100). */
  spotCheckEvery?: number;
  /** How long a spot-check miss parks a worker's embed slots (default 30 min). */
  parkMs?: number;
  /** Wait before a failed batch's texts go out again (× its attempts; default 15 s). */
  retryMs?: number;
  /** Chunks read from the backlog at a time (default 256). */
  refillRows?: number;
  /** Least time between two reads of an empty backlog, unless kicked (default 10 s). */
  idleScanMs?: number;
}

/** Chunk vectors in the backlog, or texts an audit waits on. */
type Item =
  | { kind: 'chunk'; chunkId: string; document: string; text: string }
  | { kind: 'request'; request: AuditRequest; index: number; text: string };

interface Batch {
  items: Item[];
  tokens: number;
  vectorModel: string;
  /** Bad answers so far. */
  attempts: number;
  notBefore: number;
  /** The lease that holds it, if any. */
  lease: string | null;
  done: boolean;
}

interface AuditRequest {
  vectorModel: string;
  vectors: (number[] | null)[];
  remaining: number;
  batches: Batch[];
  done: boolean;
  settle: (result: { ok: true; vectors: number[][] } | { ok: false; error: string }) => void;
}

interface EmbedLease {
  id: string;
  batch: Batch;
  who: WorkerIdentity;
  vectorModel: string;
  dimensions: number;
  inputs: string[];
  /** Where a spot-check probe sits in `inputs`, and which probe text it is. */
  probe: { at: number; index: number } | null;
  calibration: string | null;
  issuedAt: number;
  expiresAt: number;
  /** Kept a while after expiry so a late answer can still land when nobody else took the batch. */
  expired: boolean;
}

interface Calibration {
  id: string;
  /** `<token>/<worker name>`: every embed slot of that worker process. */
  worker: string;
  model: string;
  vectorModel: string;
  minCosine: number;
  meanCosine: number;
  at: number;
  batches: number;
  vectors: number;
  usageTokens: number;
}

export type CalibrationResult =
  | { ok: true; calibration: string; minCosine: number; meanCosine: number }
  | { ok: false; reason: string; minCosine?: number; meanCosine?: number; retryAfterSeconds?: number };

export interface EmbedStatus extends SourceStatus {
  mode: 'inline' | 'deferred';
  vectorModel: string;
  /** Chunks without a vector of the current identity (deferred mode; counted at most every 30 s), else null. */
  backlog: number | null;
  /** Batches ready to lease: audit requests and the part of the backlog already read. */
  waiting: number;
  audit: { requests: number; batches: number };
  leases: { id: string; worker: string; backend: string; remote: boolean; texts: number; label: string; ageSeconds: number; expiresInSeconds: number }[];
  totals: { batches: number; vectors: number; written: number; failed: Record<FailureKind, number>; dropped: number; leasesExpired: number; spotChecks: number; spotMisses: number; auditFailed: number };
  lastHour: { batches: number; vectors: number };
  /** Own endpoints that passed calibration, and workers parked by a spot check. */
  endpoints: { worker: string; model: string; minCosine: number; at: string; batches: number; vectors: number; usageTokens: number }[];
  parked: { worker: string; until: string; reason: string }[];
}

const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_DEADLINE_MS = 5 * 60_000;
const EXPIRED_GRACE_MS = 5 * 60_000;
/** Bad answers to one batch before an audit's request fails, or a chunk rests an hour. */
const MAX_ATTEMPTS = 3;
const CHUNK_REST_MS = 60 * 60_000;
const BACKLOG_COUNT_TTL_MS = 30_000;

/** Whether a remote worker may embed here at all: deferred mode, and the workspace offers it. */
export function embedOffered(config: KnodeConfig): boolean {
  return embeddingDeferred(config) && config.server.remote?.offer?.embed !== false;
}

/** `serve`'s own embed slots: `ingest.embedSlots` (default 8) in deferred mode, none otherwise. */
export function localEmbedSlots(config: KnodeConfig): number {
  if (!embeddingDeferred(config)) return 0;
  const n = Math.floor(Number(config.ingest.embedSlots ?? 8));
  return Number.isFinite(n) ? Math.max(0, Math.min(32, n)) : 8;
}

export class EmbedSource implements WorkSource {
  readonly kind = 'embed' as const;
  private readonly requests: AuditRequest[] = [];
  /** Backlog batches read and not yet leased, oldest read first. */
  private backlog: Batch[] = [];
  /** Chunk ids in `backlog` or out on a lease: the next read skips them. */
  private readonly held = new Set<string>();
  /** Chunk ids that failed lately: skipped until then. */
  private readonly resting = new Map<string, number>();
  private readonly leases = new Map<string, EmbedLease>();
  private readonly calibrations = new Map<string, Calibration>();
  private readonly parkedWorkers = new Map<string, { until: number; reason: string }>();
  private reference: { vectorModel: string; vectors: number[][] } | null = null;
  private referencing: Promise<number[][]> | null = null;
  private refilling: Promise<void> | null = null;
  private lastEmptyScan = 0;
  private backlogCount: { vectorModel: string; n: number; at: number } | null = null;
  private stopped = false;
  private readonly totals: EmbedStatus['totals'] = {
    batches: 0, vectors: 0, written: 0, failed: noFailures(), dropped: 0, leasesExpired: 0, spotChecks: 0, spotMisses: 0, auditFailed: 0,
  };
  private readonly recent: { at: number; vectors: number }[] = [];
  private readonly leaseMs: number;
  private readonly deadlineMs: number;
  private readonly spotCheckEvery: number;
  private readonly parkMs: number;
  private readonly retryMs: number;
  private readonly refillRows: number;
  private readonly idleScanMs: number;
  private readonly log: (msg: string) => void;

  constructor(private readonly ctx: EmbedSourceContext, opts: EmbedSourceOptions = {}) {
    this.leaseMs = Math.max(1_000, opts.leaseMs ?? DEFAULT_LEASE_MS);
    this.deadlineMs = Math.max(1_000, opts.requestDeadlineMs ?? DEFAULT_DEADLINE_MS);
    this.spotCheckEvery = Math.max(1, Math.floor(opts.spotCheckEvery ?? 100));
    this.parkMs = Math.max(1_000, opts.parkMs ?? 30 * 60_000);
    this.retryMs = Math.max(0, opts.retryMs ?? 15_000);
    this.refillRows = Math.max(1, opts.refillRows ?? 256);
    this.idleScanMs = Math.max(0, opts.idleScanMs ?? 10_000);
    this.log = ctx.log ?? (() => {});
  }

  get leaseDurationMs(): number {
    return this.leaseMs;
  }

  holds(taskId: string): boolean {
    return this.leases.has(taskId);
  }

  /** New chunks were written: the next lease reads the backlog again. */
  kick(): void {
    this.lastEmptyScan = 0;
    this.backlogCount = null;
  }

  /* ---------------------------- audit requests ---------------------------- */

  /**
   * Vectors for `texts`, in order, made by whichever embed slot takes them —
   * this machine's or a remote worker's — and checked and finished like any
   * other batch. Rejects when they are not all back within the deadline, when
   * a batch failed three times, or when the identity changed meanwhile.
   */
  request(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return Promise.resolve([]);
    if (this.stopped) return Promise.reject(new Error('embedding work is stopped'));
    const embedder = this.ctx.embedder();
    const plan = embedBatchPlan(this.ctx.config());
    const inputs = texts.map((t) => inputOf(t, plan));
    return new Promise<number[][]>((resolve, reject) => {
      const req: AuditRequest = {
        vectorModel: embedder.model, vectors: inputs.map(() => null), remaining: inputs.length, batches: [], done: false, settle: () => {},
      };
      const timer = setTimeout(() => {
        this.totals.auditFailed++;
        req.settle({ ok: false, error: `no vectors within ${Math.round(this.deadlineMs / 1000)} s — no embed slot took them` });
      }, this.deadlineMs);
      timer.unref?.();
      req.settle = (result) => {
        if (req.done) return;
        req.done = true;
        clearTimeout(timer);
        for (const b of req.batches) b.done = true;
        const at = this.requests.indexOf(req);
        if (at !== -1) this.requests.splice(at, 1);
        if (result.ok) resolve(result.vectors);
        else reject(new Error(`embedding failed: ${result.error}`));
      };
      for (const r of cutBatches(inputs, plan)) {
        req.batches.push({
          items: inputs.slice(r.start, r.end).map((text, k) => ({ kind: 'request' as const, request: req, index: r.start + k, text })),
          tokens: r.tokens, vectorModel: embedder.model, attempts: 0, notBefore: 0, lease: null, done: false,
        });
      }
      this.requests.push(req);
    });
  }

  /* ------------------------------ calibration ------------------------------ */

  /** Why a worker may not take embed work on its own endpoint now (and until when, when parked), or null when it may. */
  calibrationProblem(who: WorkerIdentity, calibration: string | undefined): { reason: string; parkedUntil?: string } | null {
    const parked = this.parkedFor(who.worker);
    if (parked) return { reason: `parked: ${parked.reason}`, parkedUntil: new Date(parked.until).toISOString() };
    const cal = calibration ? this.calibrations.get(calibration) : undefined;
    if (!cal || !belongsTo(who.worker, cal.worker)) return { reason: 'not calibrated here (or this server restarted since): calibrate again' };
    const identity = this.ctx.embedder().model;
    if (cal.vectorModel !== identity) return { reason: `calibrated for ${cal.vectorModel}, the workspace now embeds as ${identity}: calibrate again` };
    return null;
  }

  /**
   * Compare an own endpoint's vectors for the probe set with this machine's
   * reference: accepted when the model has the pool's canonical name and every
   * cosine reaches the threshold. `worker` is `<token>/<worker name>`.
   */
  async calibrate(worker: string, input: { model: string; endpointModel?: string; vectors: unknown }): Promise<CalibrationResult> {
    const embedder = this.ctx.embedder();
    const vectorModel = embedder.model;
    const poolModel = poolModelOf(vectorModel);
    if (!poolModel) return { ok: false, reason: `own endpoints are taken only for a model pool; this workspace embeds as ${vectorModel}` };
    const parked = this.parkedFor(worker);
    if (parked) return { ok: false, reason: `parked until ${new Date(parked.until).toISOString()}: ${parked.reason}`, retryAfterSeconds: Math.ceil((parked.until - Date.now()) / 1000) };
    for (const name of [input.model, input.endpointModel].filter((m): m is string => typeof m === 'string' && m.trim() !== '')) {
      if (!sameEmbeddingModel(name, poolModel)) return this.refuse(worker, `the endpoint serves ${name}, not ${poolModel}`);
    }
    if (!input.model?.trim()) return { ok: false, reason: 'name the endpoint\'s model (--embed-model)' };
    let vectors: number[][];
    try {
      vectors = checkVectors(input.vectors, PROBE_TEXTS.length, embedder.dimensions, postprocessFor(vectorModel));
    } catch (err) {
      return this.refuse(worker, `unusable probe vectors: ${err instanceof Error ? err.message : String(err)}`);
    }
    let reference: number[][];
    try {
      reference = await this.probeReference();
    } catch (err) {
      return { ok: false, reason: `no reference vectors yet — this machine could not embed the probe set: ${err instanceof Error ? err.message : String(err)}`, retryAfterSeconds: 300 };
    }
    const { ok, minCosine, meanCosine, reason } = compareProbe(vectors, reference, this.threshold());
    if (!ok) return { ...this.refuse(worker, reason!), minCosine, meanCosine };
    for (const [id, c] of this.calibrations) if (c.worker === worker) this.calibrations.delete(id);
    const id = crypto.randomUUID();
    this.calibrations.set(id, { id, worker, model: input.model.trim(), vectorModel, minCosine, meanCosine, at: Date.now(), batches: 0, vectors: 0, usageTokens: 0 });
    this.log(`embed: ${worker} passed calibration on ${input.model} (cosine ≥ ${minCosine.toFixed(4)}, mean ${meanCosine.toFixed(4)})`);
    return { ok: true, calibration: id, minCosine, meanCosine };
  }

  /** The probe set's reference vectors for the current identity: read, or made once with this machine's embedder. */
  async probeReference(): Promise<number[][]> {
    const embedder = this.ctx.embedder();
    if (this.reference?.vectorModel === embedder.model) return this.reference.vectors;
    const stored = readProbeReference(this.ctx.dataDir, embedder.model, embedder.dimensions);
    if (stored) {
      this.reference = { vectorModel: embedder.model, vectors: stored };
      return stored;
    }
    this.referencing ??= (async () => {
      try {
        const vectors = await probeReferenceFor(this.ctx.dataDir, embedder);
        this.reference = { vectorModel: embedder.model, vectors };
        this.log(`embed: probe reference made for ${embedder.model}`);
        return vectors;
      } finally {
        this.referencing = null;
      }
    })();
    return this.referencing;
  }

  /* -------------------------------- leases -------------------------------- */

  async lease(who: WorkerIdentity, max = 1, request: LeaseRequest = {}): Promise<WorkTask[]> {
    if (this.stopped) return [];
    this.expireLeases();
    const config = this.ctx.config();
    const embedder = this.ctx.embedder();
    // an own endpoint — a remote worker's, or this machine's (`ingest.embedEndpoint`) — embeds once
    // calibrated, and is spot-checked; a remote worker has nothing else to embed on (lent keys: §4.2)
    let calibration: Calibration | null = null;
    if (who.remote || request.calibration) {
      if (who.remote && !embedOffered(config)) return [];
      if (this.calibrationProblem(who, request.calibration)) return [];
      calibration = this.calibrations.get(request.calibration!)!;
    }
    const want = Math.max(1, Math.min(4, Math.floor(max)));
    const out: EmbedWorkTask[] = [];
    const now = Date.now();
    while (out.length < want) {
      const batch = await this.nextBatch(embedder.model, embeddingDeferred(config), now);
      if (!batch) break;
      const inputs = batch.items.map((i) => i.text);
      let probe: EmbedLease['probe'] = null;
      if (calibration && ++calibration.batches % this.spotCheckEvery === 0) {
        const index = Math.floor(Math.random() * PROBE_TEXTS.length);
        const at = Math.floor(Math.random() * (inputs.length + 1));
        inputs.splice(at, 0, PROBE_TEXTS[index]);
        probe = { at, index };
      }
      const lease: EmbedLease = {
        id: crypto.randomUUID(), batch, who, vectorModel: embedder.model, dimensions: embedder.dimensions, inputs, probe,
        calibration: calibration?.id ?? null, issuedAt: now, expiresAt: now + this.leaseMs, expired: false,
      };
      batch.lease = lease.id;
      this.leases.set(lease.id, lease);
      out.push({
        id: lease.id, kind: 'embed', label: labelOf(batch), vectorModel: embedder.model, dimensions: embedder.dimensions,
        credential: null, inputs, leaseExpiresAt: new Date(lease.expiresAt).toISOString(),
      });
    }
    return out;
  }

  /** Hand back a batch's vectors: checked, finished, and written (chunks) or passed to the audit waiting on them. */
  async complete(taskId: string, who: WorkerIdentity, outcome: TaskOutcome): Promise<CompleteResult> {
    const lease = this.leases.get(taskId);
    if (!lease) return { accepted: false, reason: 'unknown or long-expired lease' };
    if (lease.who.worker !== who.worker) return { accepted: false, reason: 'the lease belongs to another worker' };
    this.leases.delete(taskId);
    const batch = lease.batch;
    if (batch.done) return { accepted: false, reason: 'these texts no longer need vectors' };
    if (lease.expired ? batch.lease !== null : batch.lease !== lease.id) {
      return { accepted: false, reason: lease.expired ? 'lease expired and the batch moved on' : 'batch no longer leased to this worker' };
    }
    // a late answer to a lapsed lease: the batch leaves the line it went back to
    if (lease.expired) this.unqueue(batch);
    batch.lease = null;
    const identity = this.ctx.embedder().model;
    if (identity !== lease.vectorModel) {
      this.drop(batch, `the workspace embeds as ${identity} now, not ${lease.vectorModel}`);
      return { accepted: false, reason: `the embedding model changed since the lease (${lease.vectorModel} → ${identity})` };
    }
    const cal = lease.calibration ? this.calibrations.get(lease.calibration) : undefined;
    if (!outcome.ok) {
      this.fail(batch, outcome.kind ?? classifyFailure(outcome.error), outcome.error || 'failed without a message', who.worker);
      return { accepted: true };
    }
    if (who.remote || cal) {
      const poolModel = poolModelOf(identity);
      const named = [outcome.model?.replace(/^embed:/, ''), outcome.endpointModel].filter((m): m is string => typeof m === 'string' && m.trim() !== '');
      const wrong = poolModel ? named.find((m) => !sameEmbeddingModel(m, poolModel)) : undefined;
      if (wrong) {
        this.park(who.worker, cal, `its endpoint answered as ${wrong}, not ${poolModel}`);
        this.fail(batch, 'transient', `vectors from ${wrong} refused`, who.worker);
        return { accepted: false, reason: `vectors from ${wrong} are not ${poolModel}: this worker's embed slots are parked` };
      }
    }
    let vectors: number[][];
    try {
      vectors = checkVectors(outcome.vectors, lease.inputs.length, lease.dimensions, postprocessFor(identity));
    } catch (err) {
      this.fail(batch, 'model', `unusable vectors: ${err instanceof Error ? err.message : String(err)}`, who.worker);
      return { accepted: true };
    }
    if (lease.probe) {
      this.totals.spotChecks++;
      const [probeVector] = vectors.splice(lease.probe.at, 1);
      let reference: number[][] | null = null;
      try {
        reference = await this.probeReference();
      } catch {
        // no reference to check against: the batch itself was checked
      }
      const c = reference ? cosine(probeVector, reference[lease.probe.index]) : 1;
      if (c < this.threshold()) {
        this.totals.spotMisses++;
        this.park(who.worker, cal, `a spot check reached cosine ${c.toFixed(4)}, below ${this.threshold()}`);
        this.fail(batch, 'transient', `spot check missed on ${who.worker}`, who.worker);
        return { accepted: false, reason: `spot check missed (cosine ${c.toFixed(4)}): this worker's embed slots are parked` };
      }
    }
    const written = await this.land(batch, vectors, identity);
    batch.done = true;
    this.totals.batches++;
    this.totals.vectors += vectors.length;
    this.recent.push({ at: Date.now(), vectors: vectors.length });
    if (cal) {
      cal.vectors += vectors.length;
      cal.usageTokens += Math.max(0, Math.floor(outcome.usage?.inputTokens ?? 0));
    }
    return { accepted: true, ...(written !== null ? { vectorsWritten: written } : {}) };
  }

  renew(taskIds: string[], who: WorkerIdentity): { renewed: string[]; lost: string[] } {
    const renewed: string[] = [];
    const lost: string[] = [];
    const now = Date.now();
    for (const id of taskIds) {
      const lease = this.leases.get(id);
      if (lease && !lease.expired && !lease.batch.done && lease.who.worker === who.worker) {
        lease.expiresAt = now + this.leaseMs;
        renewed.push(id);
      } else {
        lost.push(id);
      }
    }
    return { renewed, lost };
  }

  /** Give leases back unanswered: the batches go straight back in line. */
  async release(taskIds: string[], who: WorkerIdentity): Promise<number> {
    let n = 0;
    for (const id of taskIds) {
      const lease = this.leases.get(id);
      if (!lease || lease.who.worker !== who.worker) continue;
      this.leases.delete(id);
      if (lease.batch.lease === id && !lease.batch.done) {
        lease.batch.lease = null;
        this.requeue(lease.batch);
      }
      n++;
    }
    return n;
  }

  async status(): Promise<EmbedStatus> {
    const now = Date.now();
    while (this.recent.length && this.recent[0].at < now - 3_600_000) this.recent.shift();
    const config = this.ctx.config();
    const embedder = this.ctx.embedder();
    const deferred = embeddingDeferred(config);
    for (const [worker, p] of this.parkedWorkers) if (p.until <= now) this.parkedWorkers.delete(worker);
    return {
      mode: deferred ? 'deferred' : 'inline',
      vectorModel: embedder.model,
      backlog: deferred ? await this.countBacklog(embedder.model).catch(() => null) : null,
      waiting: this.requests.reduce((n, r) => n + r.batches.filter((b) => !b.done && b.lease === null).length, 0) + this.backlog.length,
      audit: { requests: this.requests.length, batches: this.requests.reduce((n, r) => n + r.batches.filter((b) => !b.done).length, 0) },
      leases: [...this.leases.values()].filter((l) => !l.expired).map((l) => ({
        id: l.id, worker: l.who.worker, backend: l.who.backend, remote: l.who.remote, texts: l.batch.items.length, label: labelOf(l.batch),
        ageSeconds: Math.round((now - l.issuedAt) / 1000), expiresInSeconds: Math.round((l.expiresAt - now) / 1000),
      })),
      totals: { ...this.totals, failed: { ...this.totals.failed } },
      lastHour: { batches: this.recent.length, vectors: this.recent.reduce((n, r) => n + r.vectors, 0) },
      endpoints: [...this.calibrations.values()].map((c) => ({
        worker: c.worker, model: c.model, minCosine: Number(c.minCosine.toFixed(4)), at: new Date(c.at).toISOString(),
        batches: c.batches, vectors: c.vectors, usageTokens: c.usageTokens,
      })),
      parked: [...this.parkedWorkers.entries()].map(([worker, p]) => ({ worker, until: new Date(p.until).toISOString(), reason: p.reason })),
    };
  }

  /** Stop: no new leases, and every audit waiting on vectors gets its failure at once. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const r of [...this.requests]) r.settle({ ok: false, error: 'embedding work stopped' });
    for (const lease of this.leases.values()) lease.batch.done = true;
    this.leases.clear();
    this.backlog = [];
    this.held.clear();
  }

  /* ------------------------------ internals ------------------------------ */

  private threshold(): number {
    return probeThreshold(this.ctx.config());
  }

  private parkedFor(worker: string): { until: number; reason: string } | null {
    const now = Date.now();
    for (const [key, p] of this.parkedWorkers) {
      if (p.until <= now) {
        this.parkedWorkers.delete(key);
        continue;
      }
      if (belongsTo(worker, key)) return p;
    }
    return null;
  }

  /** A refused calibration, logged. */
  private refuse(worker: string, reason: string): CalibrationResult {
    this.log(`embed: ${worker} refused: ${reason}`);
    return { ok: false, reason };
  }

  /** A worker whose endpoint stopped agreeing: its calibration ends and its embed slots wait `parkMs`. */
  private park(worker: string, cal: Calibration | undefined, reason: string): void {
    const key = cal?.worker ?? worker;
    if (cal) this.calibrations.delete(cal.id);
    this.parkedWorkers.set(key, { until: Date.now() + this.parkMs, reason });
    this.log(`embed: ${key} parked for ${Math.round(this.parkMs / 60_000)} min: ${reason}`);
  }

  /** The next batch to lease: an audit's first, then the backlog (deferred mode only), read again as it runs out. */
  private async nextBatch(identity: string, deferred: boolean, now: number): Promise<Batch | null> {
    for (const req of this.requests) {
      if (req.done) continue;
      if (req.vectorModel !== identity) {
        this.totals.auditFailed++;
        req.settle({ ok: false, error: `the embedding model changed (${req.vectorModel} → ${identity})` });
        return this.nextBatch(identity, deferred, now);
      }
      const batch = req.batches.find((b) => !b.done && b.lease === null && b.notBefore <= now);
      if (batch) return batch;
    }
    if (!deferred) {
      this.clearBacklog();
      return null;
    }
    for (;;) {
      const at = this.backlog.findIndex((b) => b.notBefore <= now);
      if (at !== -1) {
        const [batch] = this.backlog.splice(at, 1);
        if (batch.vectorModel === identity) return batch;
        for (const item of batch.items) if (item.kind === 'chunk') this.held.delete(item.chunkId);
        continue;
      }
      if (this.backlog.length > 0 || Date.now() - this.lastEmptyScan < this.idleScanMs) return null;
      const before = this.backlog.length;
      await this.refill(identity);
      if (this.backlog.length === before) {
        this.lastEmptyScan = Date.now();
        return null;
      }
    }
  }

  /** Read the next chunks without a vector of `identity` into batches; one read at a time. */
  private refill(identity: string): Promise<void> {
    this.refilling ??= (async () => {
      try {
        const now = Date.now();
        for (const [id, until] of this.resting) if (until <= now) this.resting.delete(id);
        const skip = this.held.size + this.resting.size;
        const rows = await this.ctx.store.query<{ id: string; content: string; path: string }>(
          `SELECT c.id, c.content, d.path FROM chunks c
           JOIN documents d ON d.id = c.document_id
           LEFT JOIN embeddings e ON e.chunk_id = c.id AND e.model = $1
           WHERE e.chunk_id IS NULL
           ORDER BY d.updated_at DESC, d.id, c.seq
           LIMIT ${Math.min(20_000, this.refillRows + skip)}`,
          [identity],
        );
        const fresh = rows.filter((r) => !this.held.has(r.id) && !this.resting.has(r.id)).slice(0, this.refillRows);
        if (fresh.length === 0 || this.stopped) return;
        const plan = embedBatchPlan(this.ctx.config());
        const texts = fresh.map((r) => inputOf(r.content, plan));
        for (const r of cutBatches(texts, plan)) {
          const items: Item[] = fresh.slice(r.start, r.end).map((row, k) => ({ kind: 'chunk', chunkId: row.id, document: row.path, text: texts[r.start + k] }));
          for (const item of items) if (item.kind === 'chunk') this.held.add(item.chunkId);
          this.backlog.push({ items, tokens: r.tokens, vectorModel: identity, attempts: 0, notBefore: 0, lease: null, done: false });
        }
      } finally {
        this.refilling = null;
      }
    })();
    return this.refilling;
  }

  private clearBacklog(): void {
    for (const b of this.backlog) for (const item of b.items) if (item.kind === 'chunk') this.held.delete(item.chunkId);
    this.backlog = [];
  }

  private async countBacklog(identity: string): Promise<number> {
    const now = Date.now();
    if (this.backlogCount && this.backlogCount.vectorModel === identity && now - this.backlogCount.at < BACKLOG_COUNT_TTL_MS) return this.backlogCount.n;
    const [row] = await this.ctx.store.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM chunks c LEFT JOIN embeddings e ON e.chunk_id = c.id AND e.model = $1 WHERE e.chunk_id IS NULL`,
      [identity],
    );
    this.backlogCount = { vectorModel: identity, n: row?.n ?? 0, at: now };
    return this.backlogCount.n;
  }

  /**
   * Put checked vectors where they belong: chunk vectors into `embeddings` in
   * one transaction, skipping chunks that went with their document meanwhile;
   * an audit's into its request. Returns the chunk vectors written, or null
   * for an audit's batch.
   */
  private async land(batch: Batch, vectors: number[][], identity: string): Promise<number | null> {
    const chunks: { id: string; vector: number[] }[] = [];
    batch.items.forEach((item, i) => {
      if (item.kind === 'chunk') chunks.push({ id: item.chunkId, vector: vectors[i] });
      else if (!item.request.done && item.request.vectors[item.index] === null) {
        item.request.vectors[item.index] = vectors[i];
        if (--item.request.remaining === 0) item.request.settle({ ok: true, vectors: item.request.vectors as number[][] });
      }
    });
    if (chunks.length === 0) return null;
    let written = 0;
    try {
      written = await this.ctx.store.transaction(async (q) => {
        let n = 0;
        for (const c of chunks) n += (await q(INSERT_VECTOR, [c.id, identity, toVectorLiteral(c.vector)])).length;
        return n;
      });
    } catch (err) {
      // a chunk deleted between the check and the insert aborts the transaction: write the rest one by one
      if ((err as { code?: string }).code !== '23503') throw err;
      written = 0;
      for (const c of chunks) {
        try {
          written += (await this.ctx.store.query(INSERT_VECTOR, [c.id, identity, toVectorLiteral(c.vector)])).length;
        } catch (e) {
          if ((e as { code?: string }).code !== '23503') throw e;
        }
      }
    }
    for (const c of chunks) this.held.delete(c.id);
    this.totals.written += written;
    if (this.backlogCount) this.backlogCount.n = Math.max(0, this.backlogCount.n - written);
    return written;
  }

  /**
   * A batch that came back without usable vectors. A bad answer uses one of
   * its attempts; after three an audit's request fails and backlog chunks
   * rest an hour. A busy or broken slot costs no attempt: the batch just goes
   * back in line a little later.
   */
  private fail(batch: Batch, kind: FailureKind, error: string, worker: string): void {
    this.totals.failed[kind]++;
    const now = Date.now();
    if (kind === 'model') batch.attempts++;
    if (batch.attempts >= MAX_ATTEMPTS) {
      this.log(`embed: a batch failed ${MAX_ATTEMPTS} times, last on ${worker}: ${error.slice(0, 240)}`);
      this.drop(batch, error, CHUNK_REST_MS);
      return;
    }
    batch.notBefore = now + this.retryMs * Math.max(1, batch.attempts);
    this.requeue(batch);
    if (kind !== 'transient') this.log(`embed: a batch failed on ${worker} (${kind}): ${error.slice(0, 240)}`);
  }

  /** Give up on a batch: an audit's request fails, backlog chunks are left for a later read (after `restMs`). */
  private drop(batch: Batch, reason: string, restMs = 0): void {
    batch.done = true;
    this.totals.dropped++;
    this.unqueue(batch);
    for (const item of batch.items) {
      if (item.kind === 'request') {
        if (!item.request.done) {
          this.totals.auditFailed++;
          item.request.settle({ ok: false, error: reason });
        }
      } else {
        this.held.delete(item.chunkId);
        if (restMs > 0) this.resting.set(item.chunkId, Date.now() + restMs);
      }
    }
  }

  /** Back in line: an audit's batch stays in its request; a backlog batch goes to the front of the backlog. */
  private requeue(batch: Batch): void {
    if (batch.done || batch.items[0]?.kind === 'request') return;
    if (!this.backlog.includes(batch)) this.backlog.unshift(batch);
  }

  private unqueue(batch: Batch): void {
    const at = this.backlog.indexOf(batch);
    if (at !== -1) this.backlog.splice(at, 1);
  }

  private expireLeases(): void {
    const now = Date.now();
    for (const lease of [...this.leases.values()]) {
      if (lease.expired) {
        if (now - lease.expiresAt > EXPIRED_GRACE_MS) this.leases.delete(lease.id);
        continue;
      }
      if (lease.expiresAt > now) continue;
      lease.expired = true;
      this.totals.leasesExpired++;
      const batch = lease.batch;
      if (batch.done || batch.lease !== lease.id) continue;
      batch.lease = null;
      this.requeue(batch);
    }
  }
}

const INSERT_VECTOR = `INSERT INTO embeddings (chunk_id, model, embedding)
  SELECT $1, $2, $3::${VECTOR_TYPE} WHERE EXISTS (SELECT 1 FROM chunks WHERE id = $1)
  ON CONFLICT (chunk_id) DO UPDATE SET model = EXCLUDED.model, embedding = EXCLUDED.embedding
  RETURNING chunk_id`;

const endpointKey = (e: EmbedEndpoint) => `${e.baseUrl}|${e.model}|${e.apiKey ?? ''}`;

/** Whether a slot (`<token>/<name>/embed#2`) belongs to a worker (`<token>/<name>`). */
function belongsTo(slot: string, worker: string): boolean {
  return slot === worker || slot.startsWith(`${worker}/`);
}

function labelOf(batch: Batch): string {
  const first = batch.items[0];
  if (!first) return 'nothing';
  if (first.kind === 'request') return `${batch.items.length} audit text${batch.items.length === 1 ? '' : 's'}`;
  const docs = new Set(batch.items.map((i) => (i.kind === 'chunk' ? i.document : '')));
  return `${batch.items.length} chunk${batch.items.length === 1 ? '' : 's'} of ${first.document}${docs.size > 1 ? ` and ${docs.size - 1} more` : ''}`;
}

/* -------------------------- the brokered embedder -------------------------- */

/**
 * What the duplicate audits embed with in deferred mode: their texts go on
 * the embed queue, ahead of the backlog, and come back from whichever embed
 * slot took them. When nobody could take them — no embed slots here and no
 * remote worker asked for embed work in the last two minutes — or in inline
 * mode, it embeds directly, as before.
 */
export class BrokeredEmbedder implements EmbeddingProvider {
  constructor(
    private readonly source: EmbedSource,
    private readonly direct: () => EmbeddingProvider,
    private readonly brokered: () => boolean,
  ) {}

  get model(): string {
    return this.direct().model;
  }

  get dimensions(): number {
    return this.direct().dimensions;
  }

  embed(texts: string[]): Promise<number[][]> {
    return this.brokered() ? this.source.request(texts) : this.direct().embed(texts);
  }
}

/* --------------------------- this machine's slots --------------------------- */

/** What the embed slots take their work from: the work broker. */
export interface EmbedLeaser {
  lease(who: WorkerIdentity, kinds: readonly ['embed'], max?: number, request?: LeaseRequest): Promise<WorkTask[]>;
  complete(taskId: string, who: WorkerIdentity, outcome: TaskOutcome): Promise<unknown>;
  renew(taskIds: string[], who: WorkerIdentity): unknown;
}

export interface LocalEmbedSlotsOptions {
  /** Wait between polls of an empty queue (default 5 s; a kick cuts it short). */
  idleMs?: number;
  /** How often `ingest.embedSlots` is read again (default 30 s). */
  reconfigureMs?: number;
  /** Where an endpoint of this machine's (`ingest.embedEndpoint`) is calibrated; without it the slots embed on the pool only. */
  source?: Pick<EmbedSource, 'calibrate' | 'calibrationProblem'>;
  /** Wait before an endpoint that failed calibration is tried again (default 15 min). */
  recalibrateMs?: number;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
}

export interface LocalEmbedStatus {
  slots: number;
  busy: number;
  batches: number;
  vectors: number;
  failed: number;
  pausedUntil: string | null;
  lastError: string | null;
  /** This machine's own endpoint, when one is set: whether the slots embed on it now, and why not. */
  endpoint: { baseUrl: string; model: string; calibrated: boolean; minCosine: number | null; note: string | null } | null;
}

/**
 * `serve`'s own embed slots: `ingest.embedSlots` of them in deferred mode,
 * each leasing a batch and embedding it with this machine's embedder (the
 * pool, which keeps its own quota). They run whether or not processing is
 * started, as embedding always has. A failure pauses them all — 30 s, doubling
 * to 15 min — since the pool behind them is shared: a spent daily quota just
 * means waiting.
 *
 * With an endpoint of this machine's own (`ingest.embedEndpoint`) they embed
 * there instead, once it passes calibration like a remote worker's endpoint,
 * spot checks included. While it is refused or parked they embed on the pool,
 * and try the endpoint again later.
 */
export class LocalEmbedSlots {
  private slots = 0;
  private generation = 0;
  private busy = 0;
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private readonly sleepers = new Set<() => void>();
  private readonly health = { batches: 0, vectors: 0, failed: 0, streak: 0, pausedUntil: 0, lastError: null as string | null };
  /** The own endpoint's calibration, per endpoint (`baseUrl|model`). */
  private endpointState: { key: string; calibration: string | null; minCosine: number | null; retryAt: number; note: string | null } | null = null;
  private calibrating: Promise<void> | null = null;
  private readonly worker = `local:${os.hostname()}`;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly work: EmbedLeaser,
    private readonly embedder: () => EmbeddingProvider,
    private readonly config: () => KnodeConfig,
    private readonly opts: LocalEmbedSlotsOptions = {},
  ) {
    this.log = opts.log ?? (() => {});
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.slots = 0;
    this.reconfigure();
    this.timer = setInterval(() => this.reconfigure(), this.opts.reconfigureMs ?? 30_000);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.kick();
  }

  /** New work: idle slots look now (a pause after a failure still runs out). */
  kick(): void {
    for (const wake of [...this.sleepers]) wake();
  }

  status(): LocalEmbedStatus {
    const now = Date.now();
    const endpoint = this.opts.source && embeddingDeferred(this.config()) ? localEmbedEndpoint(this.config()) : null;
    const state = endpoint && this.endpointState?.key === endpointKey(endpoint) ? this.endpointState : null;
    return {
      slots: this.slots, busy: this.busy, batches: this.health.batches, vectors: this.health.vectors, failed: this.health.failed,
      pausedUntil: this.health.pausedUntil > now ? new Date(this.health.pausedUntil).toISOString() : null, lastError: this.health.lastError,
      endpoint: endpoint ? {
        baseUrl: endpoint.baseUrl, model: endpoint.model, calibrated: Boolean(state?.calibration), minCosine: state?.minCosine ?? null,
        note: state?.note ?? (state ? null : 'not calibrated yet'),
      } : null,
    };
  }

  /**
   * The calibration to lease with: this machine's endpoint's, calibrated
   * first when it is new or its time to try again has come; undefined while
   * there is none — then the slots embed on the pool.
   */
  private async endpointCalibration(who: WorkerIdentity): Promise<{ endpoint: EmbedEndpoint; calibration: string } | null> {
    const source = this.opts.source;
    const endpoint = source ? localEmbedEndpoint(this.config()) : null;
    if (!source || !endpoint) return null;
    const key = endpointKey(endpoint);
    if (this.endpointState?.key !== key) this.endpointState = { key, calibration: null, minCosine: null, retryAt: 0, note: null };
    const state = this.endpointState;
    if (state.calibration) {
      const problem = source.calibrationProblem(who, state.calibration);
      if (!problem) return { endpoint, calibration: state.calibration };
      // parked by a spot check, or forgotten: the pool until then
      state.calibration = null;
      state.retryAt = problem.parkedUntil ? Date.parse(problem.parkedUntil) : Date.now();
      state.note = problem.reason;
      this.log(`embed: ${endpoint.baseUrl} ${problem.reason} — embedding on the pool meanwhile`);
    }
    if (Date.now() < state.retryAt) return null;
    this.calibrating ??= (async () => {
      try {
        const made = await embedOnEndpoint(endpoint, [...PROBE_TEXTS], { fetch: this.opts.fetch, timeoutMs: 60_000 });
        const result = await source.calibrate(this.worker, { model: endpoint.model, endpointModel: made.endpointModel ?? undefined, vectors: made.vectors });
        if (this.endpointState !== state) return;
        if (result.ok) {
          Object.assign(state, { calibration: result.calibration, minCosine: result.minCosine, note: null });
          this.log(`embed: local slots embed on ${endpoint.baseUrl} (${endpoint.model}, cosine ≥ ${result.minCosine.toFixed(4)})`);
        } else {
          const wait = Math.max(this.opts.recalibrateMs ?? 15 * 60_000, (result.retryAfterSeconds ?? 0) * 1000);
          Object.assign(state, { retryAt: Date.now() + wait, minCosine: result.minCosine ?? null, note: result.reason });
          this.log(`embed: ${endpoint.baseUrl} refused: ${result.reason} — local slots embed on the pool, trying it again in ${Math.round(wait / 60_000)} min`);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (this.endpointState === state) Object.assign(state, { retryAt: Date.now() + 60_000, note: reason });
        this.log(`embed: ${endpoint.baseUrl} could not be calibrated: ${reason} — local slots embed on the pool meanwhile`);
      } finally {
        this.calibrating = null;
      }
    })();
    await this.calibrating;
    return state.calibration ? { endpoint, calibration: state.calibration } : null;
  }

  /** Start or stop slots to match `ingest.embedSlots` (0 outside deferred mode). */
  reconfigure(): void {
    if (this.stopped) return;
    const want = localEmbedSlots(this.config());
    if (want === this.slots) return;
    const generation = ++this.generation;
    this.kick();
    this.slots = want;
    for (let n = 1; n <= want; n++) void this.slot(n, generation);
    if (want > 0) this.log(`embed: ${want} local embed slot(s) on ${this.embedder().model}`);
  }

  private sleep(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.sleepers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      this.sleepers.add(done);
    });
  }

  private live(generation: number): boolean {
    return !this.stopped && generation === this.generation;
  }

  private async slot(n: number, generation: number): Promise<void> {
    const who: WorkerIdentity = { worker: `${this.worker}/embed#${n}`, backend: 'embed:local', remote: false };
    const idleMs = this.opts.idleMs ?? 5_000;
    while (this.live(generation)) {
      const pause = this.health.pausedUntil - Date.now();
      if (pause > 0) {
        await this.sleep(Math.min(pause, 15_000));
        // a kick does not cut a pause short
        continue;
      }
      let task: WorkTask | undefined;
      let own: { endpoint: EmbedEndpoint; calibration: string } | null = null;
      try {
        own = await this.endpointCalibration(who);
        [task] = await this.work.lease(who, ['embed'], 1, own ? { calibration: own.calibration } : undefined);
      } catch (err) {
        this.log(`embed: ${who.worker} could not take work: ${err instanceof Error ? err.message : err}`);
        await this.sleep(30_000);
        continue;
      }
      if (!task || task.kind !== 'embed') {
        await this.sleep(Math.round(idleMs * (0.75 + Math.random() * 0.5)));
        continue;
      }
      const outcome = await this.run(task, who, own?.endpoint ?? null);
      try {
        await this.work.complete(task.id, who, outcome);
      } catch (err) {
        this.log(`embed: ${who.worker} could not hand back ${task.label}: ${err instanceof Error ? err.message : err}`);
      }
      if (outcome.ok) {
        this.health.batches++;
        this.health.vectors += task.inputs.length;
        this.health.streak = 0;
      } else {
        this.health.failed++;
        this.health.lastError = outcome.error;
        const ms = Math.min(15 * 60_000, 30_000 * 2 ** this.health.streak++);
        if (this.health.pausedUntil < Date.now()) this.log(`embed: local slots rest ${Math.round(ms / 1000)} s: ${outcome.error.slice(0, 240)}`);
        this.health.pausedUntil = Math.max(this.health.pausedUntil, Date.now() + ms);
      }
    }
  }

  private async run(task: EmbedWorkTask, who: WorkerIdentity, endpoint: EmbedEndpoint | null): Promise<TaskOutcome> {
    this.busy++;
    const leaseMs = Date.parse(task.leaseExpiresAt) - Date.now();
    const renew = setInterval(() => this.work.renew([task.id], who), Math.max(5_000, Math.floor((Number.isFinite(leaseMs) ? leaseMs : 60_000) / 3)));
    renew.unref?.();
    const embedder = this.embedder();
    const model = endpoint ? endpoint.model : embedder.model;
    try {
      if (endpoint) {
        const made = await embedOnEndpoint(endpoint, task.inputs, { fetch: this.opts.fetch });
        return {
          ok: true, text: '', vectors: made.vectors, model, ...(made.endpointModel ? { endpointModel: made.endpointModel } : {}),
          ...(made.tokens ? { usage: { inputTokens: made.tokens, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 } } : {}),
        };
      }
      const vectors = await embedder.embed(task.inputs);
      return { ok: true, text: '', vectors, model };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { ok: false, error, kind: classifyFailure(error), model };
    } finally {
      clearInterval(renew);
      this.busy--;
    }
  }
}
