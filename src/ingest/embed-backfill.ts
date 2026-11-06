import { embeddingDeferred, KnodeConfig } from '../config.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../store/db.js';
import { EmbeddingProvider } from './embeddings.js';

/**
 * Embedding as its own step, after a document is indexed.
 *
 * Inside `serve`, applying a document writes its chunks, their full-text index
 * and its graph evidence without waiting for vectors; this fills in every chunk
 * that has no vector for the current model, in the background. That is the
 * inline mode (`ingest.embedding`, the default); in deferred mode the embed
 * slots and remote workers drain the same backlog as leased work
 * (src/work/embed.ts), and this does nothing. A document is
 * searchable by keyword and part of the graph the moment it is applied, and
 * joins vector recall when its vectors land.
 *
 * Why: the embedding pool is rate-limited and capped per day. Embedding inline
 * made an import take as long as its vectors did, and made the whole document
 * fail — no chunks, no graph, no replayed extraction — once the day's quota ran
 * out. Here a pool that cannot serve just means waiting: the chunks stay
 * pending and are picked up again after `retryMs`, or as soon as someone kicks.
 */

export interface EmbeddingBackfillContext {
  store: Store;
  /** Read on every round: a settings change may swap the provider. */
  embedder: EmbeddingProvider;
  /** Read on every round: in deferred mode the embed slots (src/work/embed.ts) drain the backlog instead, and this stands aside. */
  config?: Pick<KnodeConfig, 'ingest'>;
}

export interface EmbeddingBackfillOptions {
  log?: (msg: string) => void;
  /** Chunks per embed call (the provider splits them into its own batches). */
  batch?: number;
  /** Embed calls in flight at once, so several pool keys work in parallel. */
  concurrency?: number;
  /** Wait after a round the provider could not serve (no quota, all keys failing). */
  retryMs?: number;
}

export interface EmbeddingBackfillStatus {
  running: boolean;
  /** Vectors written since start. */
  written: number;
  lastError: string | null;
  /** Set while waiting out a provider that could not serve. */
  retryAt: string | null;
}

/** The current model's missing vectors, oldest documents first. */
async function missingChunks(store: Store, model: string, limit: number): Promise<{ id: string; content: string }[]> {
  return store.query<{ id: string; content: string }>(
    `SELECT c.id, c.content FROM chunks c
     LEFT JOIN embeddings e ON e.chunk_id = c.id AND e.model = $1
     WHERE e.chunk_id IS NULL
     ORDER BY c.document_id, c.seq
     LIMIT ${Math.max(1, Math.floor(limit))}`,
    [model],
  );
}

/** How many chunks still wait for a vector of the current model. */
export async function pendingEmbeddings(store: Store, model: string): Promise<number> {
  const [row] = await store.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM chunks c LEFT JOIN embeddings e ON e.chunk_id = c.id AND e.model = $1 WHERE e.chunk_id IS NULL`,
    [model],
  );
  return row?.n ?? 0;
}

async function writeVector(store: Store, chunkId: string, model: string, vec: number[]): Promise<boolean> {
  try {
    // the chunk may have gone with its document in the meantime
    const rows = await store.query<{ chunk_id: string }>(
      `INSERT INTO embeddings (chunk_id, model, embedding)
       SELECT $1, $2, $3::${VECTOR_TYPE} WHERE EXISTS (SELECT 1 FROM chunks WHERE id = $1)
       ON CONFLICT (chunk_id) DO UPDATE SET model = EXCLUDED.model, embedding = EXCLUDED.embedding
       RETURNING chunk_id`,
      [chunkId, model, toVectorLiteral(vec)],
    );
    return rows.length > 0;
  } catch (err) {
    if ((err as { code?: string }).code === '23503') return false; // deleted between the check and the insert
    throw err;
  }
}

export class EmbeddingBackfill {
  private timer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;
  private loop: Promise<void> | null = null;
  private stopped = false;
  private kicked = false;
  /** Waiting out a provider that could not serve: a kick does not cut that short. */
  private waitingOut = false;
  private readonly state: EmbeddingBackfillStatus = { running: false, written: 0, lastError: null, retryAt: null };
  private readonly log: (msg: string) => void;
  private readonly batch: number;
  private readonly concurrency: number;
  private readonly retryMs: number;

  constructor(private readonly ctx: EmbeddingBackfillContext, opts: EmbeddingBackfillOptions = {}) {
    this.log = opts.log ?? (() => {});
    this.batch = Math.max(1, opts.batch ?? 64);
    this.concurrency = Math.max(1, opts.concurrency ?? 4);
    this.retryMs = Math.max(1000, opts.retryMs ?? 15 * 60_000);
  }

  /** Work through what is pending, then sleep until kicked. */
  start(): void {
    if (this.loop) return;
    this.stopped = false;
    this.loop = this.run();
  }

  /** New chunks were written: look now (unless waiting out a provider that could not serve). */
  kick(): void {
    this.kicked = true;
    if (!this.waitingOut) this.wake?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.waitingOut = false;
    this.wake?.();
    await this.loop;
    this.loop = null;
  }

  status(): EmbeddingBackfillStatus {
    return { ...this.state };
  }

  /**
   * One round: embed up to `batch × concurrency` missing vectors. Returns how
   * many were written, or null when the provider could serve none of them.
   */
  async runOnce(): Promise<number | null> {
    const { store, embedder } = this.ctx;
    if (this.ctx.config && embeddingDeferred(this.ctx.config)) return 0;
    const model = embedder.model;
    const rows = await missingChunks(store, model, this.batch * this.concurrency);
    if (rows.length === 0) return 0;
    const slices: { id: string; content: string }[][] = [];
    for (let i = 0; i < rows.length; i += this.batch) slices.push(rows.slice(i, i + this.batch));
    let written = 0;
    let served = false;
    let lastError: string | null = null;
    await Promise.all(slices.map(async (slice) => {
      let vecs: number[][];
      try {
        vecs = await embedder.embed(slice.map((r) => r.content));
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        return;
      }
      served = true;
      for (let i = 0; i < slice.length; i++) if (vecs[i] && (await writeVector(store, slice[i].id, model, vecs[i]))) written++;
    }));
    this.state.written += written;
    this.state.lastError = lastError;
    return served ? written : null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wake = () => {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.wake = null;
        resolve();
      };
      if (ms === Infinity) return;
      this.timer = setTimeout(() => this.wake?.(), ms);
      this.timer.unref?.();
    });
  }

  private async run(): Promise<void> {
    let reported = 0;
    while (!this.stopped) {
      this.kicked = false;
      this.state.running = true;
      let n: number | null;
      try {
        n = await this.runOnce();
      } catch (err) {
        this.state.lastError = err instanceof Error ? err.message : String(err);
        n = null;
      }
      if (this.stopped) break;
      if (n === null) {
        // the provider served nothing (quota spent, every key failing): wait it out
        this.state.running = false;
        this.state.retryAt = new Date(Date.now() + this.retryMs).toISOString();
        const pending = await pendingEmbeddings(this.ctx.store, this.ctx.embedder.model).catch(() => -1);
        this.log(`embeddings: ${pending} chunks pending, provider unavailable (${this.state.lastError}); retrying in ${Math.round(this.retryMs / 60_000)} min`);
        this.waitingOut = true;
        await this.sleep(this.retryMs);
        this.waitingOut = false;
        this.state.retryAt = null;
        continue;
      }
      if (n > 0) {
        reported += n;
        if (reported >= 2000) {
          const pending = await pendingEmbeddings(this.ctx.store, this.ctx.embedder.model).catch(() => -1);
          this.log(`embeddings: ${this.state.written} written, ${pending} pending`);
          reported = 0;
        }
        continue;
      }
      // nothing pending: sleep until a sync writes new chunks
      this.state.running = false;
      if (reported > 0) {
        this.log(`embeddings: up to date (${this.state.written} written)`);
        reported = 0;
      }
      if (!this.kicked) await this.sleep(Infinity);
    }
    this.state.running = false;
  }
}
