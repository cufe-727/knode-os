import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EmbeddingConnection, EmbeddingLimits, EmbeddingPoolConfig, KnodeConfig, resolveSecret } from '../config.js';
import { EMBED_INPUT_CHARS } from '../constants.js';
import { createEmbeddingProvider, EmbeddingProvider } from './embeddings.js';
import { estimateEmbeddingTokens } from './embedding-tokens.js';

export const DEFAULT_EMBEDDING_LIMITS: EmbeddingLimits = {
  requestsPerMinute: 60, tokensPerMinute: 100_000, requestsPerDay: 5_000,
  tokensPerDay: 1_000_000, concurrency: 2, resetTimezone: 'UTC',
};

/** Deliberate aliases only. Similar names (including rerankers) are not equivalent. */
export function canonicalEmbeddingModel(model: string): string {
  return ['bge-m3', 'baai/bge-m3', '@cf/baai/bge-m3'].includes(model.toLowerCase()) ? 'bge-m3' : model;
}

export function poolMembers(entries: EmbeddingConnection[], pool: EmbeddingPoolConfig): EmbeddingConnection[] {
  const canonical = canonicalEmbeddingModel(pool.model);
  return entries.flatMap((entry) => {
    if (entry.enabled === false || entry.provider !== 'openai') return [];
    const model = [entry.model, ...(entry.catalog ?? [])].find((id) => canonicalEmbeddingModel(id) === canonical);
    // BGE-M3 has a fixed dense 1024-dimensional space. Other models must be
    // explicitly selected on each key, with matching dimensions.
    const compatible = canonical === 'bge-m3' ? pool.dimensions === 1024
      : model === entry.model && pool.dimensions === entry.dimensions;
    return model && compatible ? [{ ...entry, model, dimensions: pool.dimensions }] : [];
  });
}

export function validateEmbeddingPool(config: Pick<KnodeConfig, 'embeddingPool' | 'embeddingProviders'>): void {
  const pool = config.embeddingPool;
  if (!pool?.enabled) return;
  if (!pool.model.trim() || !Number.isSafeInteger(pool.dimensions) || pool.dimensions < 1 ||
      !Number.isSafeInteger(pool.batchSize) || pool.batchSize < 1 || pool.batchSize > 128) {
    throw new Error('Embedding pool requires a model, positive dimensions and a batch size of 1–128.');
  }
  if (!poolMembers(config.embeddingProviders, pool).length) {
    throw new Error('No enabled key matches the pool model and dimensions. Refresh its embedding models or select the model on a key.');
  }
}

export function embeddingLimits(entry: EmbeddingConnection): EmbeddingLimits {
  const limits = { ...DEFAULT_EMBEDDING_LIMITS, ...entry.limits };
  for (const name of ['requestsPerMinute', 'tokensPerMinute', 'requestsPerDay', 'tokensPerDay', 'concurrency'] as const) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 0 || (name === 'concurrency' && limits[name] < 1)) {
      throw new Error(`Invalid embedding limit: ${name}`);
    }
  }
  try { new Intl.DateTimeFormat('en', { timeZone: limits.resetTimezone }); }
  catch { throw new Error('Invalid embedding quota reset timezone. Use UTC or an IANA timezone such as Asia/Shanghai.'); }
  return limits;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const credentialId = (entry: EmbeddingConnection) => hash(`${entry.baseUrl.replace(/\/+$/, '')}\0${resolveSecret(entry.apiKey)}`);
const quotaId = (entry: EmbeddingConnection) => {
  // Workers AI exposes the authoritative account in the endpoint itself.
  const account = /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/([^/]+)\//.exec(entry.baseUrl)?.[1];
  return hash(account ? `cloudflare:${account}` : entry.quotaGroup?.trim() || credentialId(entry));
};
const dayKey = (now: number, timezone: string) => new Intl.DateTimeFormat('en-CA', {
  timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(now));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Reservation { id: string; at: number; tokens: number; day: string; expires: number; active: boolean }
// `estimated` is the part of `tokens` no provider reported. A day recorded before the field existed has
// no split, so it stays without one rather than count those tokens as reported.
interface Day { requests: number; tokens: number; estimated?: number }
interface Bucket { days: Record<string, Day>; recent: Reservation[]; lastUsed: number }
interface Health { cooldownUntil: number; lastError?: string; lastSuccess?: number }
interface Ledger { version: 1; buckets: Record<string, Bucket>; health: Record<string, Health> }
interface Ticket { entry: EmbeddingConnection; bucket: string; credential: string; reservation: Reservation }
interface Selection { ticket?: Ticket; retryAt?: number; reasons: string[] }

export function defaultEmbeddingUsagePath(): string {
  // A machine-level ledger: the same account must not get a new allowance in
  // every workspace, or after a service restart. Contains hashes, never keys.
  return process.env.KNODE_EMBEDDING_USAGE_FILE || path.join(os.homedir(), '.knode-os', 'embedding-usage.json');
}

/** Atomic reservations cover concurrent ingests, processes and workspaces. */
export class EmbeddingQuotaLedger {
  constructor(readonly file = defaultEmbeddingUsagePath(), private readonly now = Date.now) {}

  private async transaction<T>(run: (ledger: Ledger) => T): Promise<T> {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const lock = `${this.file}.lock`;
    const start = Date.now();
    for (;;) {
      try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); break; }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        // Recover a lock left by a dead process; never steal a live process's lock.
        try {
          const pid = Number(fs.readFileSync(lock, 'utf8'));
          if (pid > 0) {
            try { process.kill(pid, 0); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') fs.rmSync(lock, { force: true }); }
          }
        } catch { /* Another process released it. */ }
        if (Date.now() - start > 5_000) throw new Error('Embedding usage ledger is busy; retry shortly.');
        await sleep(20);
      }
    }
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      let ledger: Ledger = { version: 1, buckets: {}, health: {} };
      if (fs.existsSync(this.file)) {
        try {
          ledger = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Ledger;
          if (ledger.version !== 1 || !ledger.buckets || !ledger.health) throw new Error('invalid');
        } catch { throw new Error('Embedding usage ledger is unreadable; restore it before making further requests.'); }
      }
      const answer = run(ledger);
      fs.writeFileSync(temp, JSON.stringify(ledger), { mode: 0o600 });
      fs.renameSync(temp, this.file);
      return answer;
    } finally {
      fs.rmSync(temp, { force: true });
      fs.rmSync(lock, { force: true });
    }
  }

  private bucket(ledger: Ledger, id: string, now: number): Bucket {
    const bucket = ledger.buckets[id] ??= { days: {}, recent: [], lastUsed: 0 };
    bucket.recent = bucket.recent.filter((r) => r.at > now - 60_000 || (r.active && r.expires > now));
    for (const reservation of bucket.recent) if (reservation.expires <= now) reservation.active = false;
    // Keep enough daily buckets for requests that finish across midnight and
    // for local timezone edits, without growing the file indefinitely.
    for (const day of Object.keys(bucket.days).sort().slice(0, -8)) delete bucket.days[day];
    return bucket;
  }

  async reserve(entries: EmbeddingConnection[], tokens: number, excluded = new Set<string>()): Promise<Selection> {
    return this.transaction((ledger) => {
      const now = this.now();
      const reasons: string[] = [];
      let retryAt = Infinity;
      const candidates = [...entries].sort((a, b) => (a.priority ?? 10) - (b.priority ?? 10) ||
        (ledger.buckets[quotaId(a)]?.lastUsed ?? 0) - (ledger.buckets[quotaId(b)]?.lastUsed ?? 0));
      for (const entry of candidates) {
        const credential = credentialId(entry);
        if (excluded.has(credential)) continue;
        const id = quotaId(entry);
        const limits = embeddingLimits(entry);
        // Multiple keys in one account cannot multiply that account's limits.
        for (const other of entries.filter((e) => quotaId(e) === id)) {
          const shared = embeddingLimits(other);
          if (limits.resetTimezone !== shared.resetTimezone) throw new Error('Keys sharing an embedding quota group must use the same reset timezone.');
          for (const field of ['requestsPerMinute', 'tokensPerMinute', 'requestsPerDay', 'tokensPerDay', 'concurrency'] as const) {
            limits[field] = Math.min(limits[field], shared[field]);
          }
        }
        const bucket = this.bucket(ledger, id, now);
        const day = dayKey(now, limits.resetTimezone);
        const today = bucket.days[day] ??= { requests: 0, tokens: 0, estimated: 0 };
        if (today.requests >= limits.requestsPerDay || today.tokens + tokens > limits.tokensPerDay) {
          reasons.push(`${entry.label}: daily quota reached`); continue;
        }
        if (tokens > limits.tokensPerMinute || limits.requestsPerMinute === 0) {
          reasons.push(`${entry.label}: batch exceeds minute limit`); continue;
        }
        const cooldown = ledger.health[credential]?.cooldownUntil ?? 0;
        if (cooldown > now) {
          retryAt = Math.min(retryAt, cooldown); reasons.push(`${entry.label}: cooling down`); continue;
        }
        if (bucket.recent.filter((r) => r.active).length >= limits.concurrency) {
          retryAt = Math.min(retryAt, now + 250); reasons.push(`${entry.label}: concurrency limit`); continue;
        }
        const recent = bucket.recent.filter((r) => r.at > now - 60_000);
        if (recent.length >= limits.requestsPerMinute || recent.reduce((n, r) => n + r.tokens, 0) + tokens > limits.tokensPerMinute) {
          retryAt = Math.min(retryAt, Math.min(...recent.map((r) => r.at)) + 60_001);
          reasons.push(`${entry.label}: minute limit`); continue;
        }
        const reservation: Reservation = { id: randomUUID(), at: now, tokens, day, expires: now + 120_000, active: true };
        bucket.recent.push(reservation);
        bucket.lastUsed = Math.max(now, bucket.lastUsed + 1);
        today.requests++;
        today.tokens += tokens;
        return { ticket: { entry, bucket: id, credential, reservation }, reasons };
      }
      return { reasons, ...(Number.isFinite(retryAt) ? { retryAt } : {}) };
    });
  }

  async finish(ticket: Ticket, result: { tokens?: number; error?: string; cooldownMs?: number }): Promise<void> {
    await this.transaction((ledger) => {
      const bucket = ledger.buckets[ticket.bucket];
      const reservation = bucket?.recent.find((r) => r.id === ticket.reservation.id);
      if (reservation) {
        reservation.active = false;
        const day = bucket.days[reservation.day];
        if (typeof result.tokens === 'number' && Number.isSafeInteger(result.tokens) && result.tokens >= 0) {
          if (day) day.tokens += result.tokens - reservation.tokens;
          reservation.tokens = result.tokens;
        } else if (day?.estimated !== undefined) {
          // No provider usage (none in the response, or the call failed): the reservation stays as the estimate.
          day.estimated += reservation.tokens;
        }
      }
      ledger.health[ticket.credential] = result.error
        ? { ...ledger.health[ticket.credential], cooldownUntil: this.now() + (result.cooldownMs ?? 30_000), lastError: result.error }
        : { cooldownUntil: 0, lastSuccess: this.now() };
    });
  }

  async status(entries: EmbeddingConnection[]) {
    return this.transaction((ledger) => entries.map((entry) => {
      const now = this.now();
      const limits = embeddingLimits(entry);
      const bucket = this.bucket(ledger, quotaId(entry), now);
      const day = dayKey(now, limits.resetTimezone);
      const today = bucket.days[day] ?? { requests: 0, tokens: 0, estimated: 0 };
      // A request in flight is still its estimate until the response settles it.
      const pending = bucket.recent.reduce((n, r) => n + (r.active && r.day === day ? r.tokens : 0), 0);
      return { id: entry.id, requestsToday: today.requests, tokensToday: today.tokens,
        ...(today.estimated === undefined ? {} : { estimatedTokensToday: today.estimated + pending }),
        requestsThisMinute: bucket.recent.filter((r) => r.at > now - 60_000).length,
        inFlight: bucket.recent.filter((r) => r.active).length, ...ledger.health[credentialId(entry)] };
    }));
  }
}

class EmbeddingHttpError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number) { super(`Embedding upstream returned HTTP ${status}`); }
}

export function retryAfterMs(value: string | null, now = Date.now()): number {
  if (!value) return 30_000;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(1000, seconds * 1000) : Math.max(1000, Date.parse(value) - now || 30_000);
}

export class PooledEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly entries: EmbeddingConnection[];
  constructor(private readonly pool: EmbeddingPoolConfig, entries: EmbeddingConnection[],
    readonly ledger = new EmbeddingQuotaLedger(), private readonly request: typeof fetch = fetch,
    private readonly maxWaitMs = 65_000) {
    validateEmbeddingPool({ embeddingPool: pool, embeddingProviders: entries });
    this.entries = poolMembers(entries, pool);
    this.dimensions = pool.dimensions;
    // Persisted vectors keep one identity even when requests move between keys.
    this.model = `pool:${canonicalEmbeddingModel(pool.model)}:${pool.dimensions}:l2-v1`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    // Respect the smallest member's batch size. Batches are also split to fit
    // its minute-token allowance; one unusually large input fails explicitly.
    const batchSize = Math.min(this.pool.batchSize, ...this.entries.map((e) => Math.max(1, e.batchSize)));
    const tokenCeiling = Math.min(...this.entries.map((e) => embeddingLimits(e).tokensPerMinute));
    let batch: string[] = [], tokens = 0;
    for (const text of texts) {
      const input = text.slice(0, EMBED_INPUT_CHARS) || ' ';
      const estimate = estimateEmbeddingTokens(input);
      if (batch.length && (batch.length >= batchSize || tokens + estimate > tokenCeiling)) {
        vectors.push(...await this.embedBatch(batch, tokens)); batch = []; tokens = 0;
      }
      batch.push(input); tokens += estimate;
    }
    if (batch.length) vectors.push(...await this.embedBatch(batch, tokens));
    return vectors;
  }

  private async embedBatch(batch: string[], tokens: number): Promise<number[][]> {
    const excluded = new Set<string>();
    const deadline = Date.now() + this.maxWaitMs;
    const errors: string[] = [];
    for (;;) {
      const selection = await this.ledger.reserve(this.entries, tokens, excluded);
      const ticket = selection.ticket;
      if (!ticket) {
        if (selection.retryAt && selection.retryAt < deadline && Date.now() < deadline) {
          await sleep(Math.max(25, Math.min(1000, selection.retryAt - Date.now()))); continue;
        }
        throw new Error(`Embedding pool unavailable: ${[...errors, ...selection.reasons].join('; ') || 'no compatible key'}`);
      }
      try {
        const entry = ticket.entry;
        const response = await this.request(`${entry.baseUrl.replace(/\/+$/, '')}/embeddings`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${resolveSecret(entry.apiKey)}` },
          signal: AbortSignal.timeout(45_000),
          body: JSON.stringify({ model: entry.model, input: batch, encoding_format: 'float',
            ...(entry.sendDimensions ? { dimensions: this.dimensions } : {}),
            ...(entry.upstream ? { provider: { only: [entry.upstream], allow_fallbacks: false } } : {}),
          }),
        });
        if (!response.ok) {
          // Provider error bodies may echo credentials. Never persist or return them.
          await response.body?.cancel();
          throw new EmbeddingHttpError(response.status, retryAfterMs(response.headers.get('retry-after')));
        }
        const body = await response.json() as { data?: { index: number; embedding: number[] }[]; usage?: { prompt_tokens?: number; total_tokens?: number } };
        const data = body.data;
        if (!Array.isArray(data) || data.length !== batch.length) throw new Error('Embedding response count mismatch');
        const vectors = [...data].sort((a, b) => a.index - b.index).map((item, index) => {
          const vector = item.embedding;
          if (item.index !== index || !Array.isArray(vector) || vector.length !== this.dimensions || !vector.every(Number.isFinite)) {
            throw new Error('Embedding response has invalid indices, dimensions or values');
          }
          const norm = Math.hypot(...vector);
          if (!(norm > 0) || !Number.isFinite(norm)) throw new Error('Embedding response has a zero or invalid vector');
          return vector.map((x) => x / norm);
        });
        await this.ledger.finish(ticket, { tokens: body.usage?.prompt_tokens ?? body.usage?.total_tokens });
        return vectors;
      } catch (error) {
        const http = error instanceof EmbeddingHttpError ? error : undefined;
        const safeError = http ? http.message : 'Embedding request failed or returned invalid vectors';
        const cooldownMs = http && [401, 402, 403, 404].includes(http.status) ? 15 * 60_000 : http?.retryAfterMs ?? 30_000;
        await this.ledger.finish(ticket, { error: safeError, cooldownMs });
        excluded.add(ticket.credential);
        errors.push(`${ticket.entry.label}: ${safeError}`);
      }
    }
  }
}

export function createConfiguredEmbeddingProvider(config: Pick<KnodeConfig, 'embedding' | 'embeddingPool' | 'embeddingProviders'>): EmbeddingProvider {
  return config.embeddingPool?.enabled
    ? new PooledEmbeddingProvider(config.embeddingPool, config.embeddingProviders)
    : createEmbeddingProvider(config.embedding);
}
