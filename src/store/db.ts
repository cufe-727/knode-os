import { DatabaseConfig } from '../config.js';
import { ClaimTypeRefoldResult, claimTypesStale, refoldClaimTypes } from '../lineage/claim-types.js';
import { Backend, openBackend } from './backend.js';
import { ensureMatchIndexes, MatchIndexResult } from './grams.js';
import { CoOccursCleanupResult, dropStoredCoOccurrence, migrate, MigrationResult, Queryable } from './migrations.js';

/**
 * Vector column type for the embeddings table.
 *
 * pgvector caps an *index* entry at roughly one 8 KB page (index tuples cannot
 * be TOASTed, so the whole vector must sit inline): 2000 dims for `vector`
 * (4 bytes/dim) but 4000 for `halfvec` (2 bytes/dim). Storing half precision
 * therefore keeps HNSW reachable at dimensions like 2048 that `vector` could
 * only ever answer with a sequential scan — and halves the table on disk. The
 * recall cost of float16 is negligible for embedding search.
 */
export const VECTOR_TYPE = 'halfvec';

/** Largest dimension pgvector will build an HNSW index for, per VECTOR_TYPE. */
const HNSW_MAX_DIM = 4000;

/** SQLSTATEs after which a transaction is simply run again: deadlock_detected, serialization_failure. */
const RETRY_SQLSTATES = new Set(['40P01', '40001']);

/** Tries a transaction gets in all before such a failure is passed on (see Store.tx). */
export const TX_ATTEMPTS = 4;

function isRetryableTxError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && RETRY_SQLSTATES.has(code);
}

/**
 * DDL for the dimension-dependent embeddings table. Above HNSW_MAX_DIM the
 * index is skipped rather than failing the open — recall falls back to a
 * sequential scan, which is correct, just slower.
 */
function embeddingsDdl(dim: number): string {
  const index =
    dim <= HNSW_MAX_DIM
      ? `CREATE INDEX IF NOT EXISTS embeddings_hnsw_idx
           ON embeddings USING hnsw (embedding ${VECTOR_TYPE}_cosine_ops);`
      : '';
  return `
      CREATE TABLE IF NOT EXISTS embeddings (
        chunk_id  TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        model     TEXT NOT NULL,
        embedding ${VECTOR_TYPE}(${dim}) NOT NULL
      );
      ${index}
      -- entity name+description vectors for the duplicate audit; keyed by fold_sha so
      -- an entity is only re-embedded when its folded row changed
      CREATE TABLE IF NOT EXISTS entity_embeddings (
        entity_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
        fold_sha  TEXT NOT NULL,
        model     TEXT NOT NULL,
        embedding ${VECTOR_TYPE}(${dim}) NOT NULL
      );
      -- "subject: statement" vectors for the duplicate-claim audit; a claim's
      -- statement is part of its id, so each is embedded once per model
      CREATE TABLE IF NOT EXISTS claim_embeddings (
        claim_id  TEXT PRIMARY KEY REFERENCES claims(id) ON DELETE CASCADE,
        model     TEXT NOT NULL,
        embedding ${VECTOR_TYPE}(${dim}) NOT NULL
      );
  `;
}

/**
 * The derived index over the markdown/file tree plus the lineage ledger —
 * deleting it and re-running `knode-os sync` (or `rebuild`) reconstructs
 * everything. Schema evolution goes through versioned migrations (see
 * migrations.ts). Backed by a PostgreSQL server with pgvector by default, or
 * by embedded PGlite when `database.kind` is "pglite" (see backend.ts).
 */

export class Store implements Queryable {
  /** Result of the migration run performed by `open` (from === to when nothing changed). */
  public migration: MigrationResult = { from: 0, to: 0 };
  /**
   * The batched follow-up of migration v13 (dropStoredCoOccurrence), running in
   * the background since `open`: settled when it has finished or `close` stopped
   * it. Await it to know the stored co_occurs rows are gone.
   */
  public cleanup: Promise<CoOccursCleanupResult | null> = Promise.resolve(null);
  /**
   * The refold claims folded under an older claim type mapping need
   * (refoldClaimTypes), running in the background after `cleanup`; settled at
   * once when nothing needs it.
   */
  public retype: Promise<ClaimTypeRefoldResult | null> = Promise.resolve(null);
  /**
   * The substring indexes search matches terms through (grams.ts), built in the
   * background after `cleanup` when missing: settled once each is there, or
   * when `close` stopped the build. `matchIndexes` names the ones ready.
   */
  public indexing: Promise<MatchIndexResult | null> = Promise.resolve(null);
  public readonly matchIndexes = new Set<string>();
  private stopCleanup = false;
  /** Backend pid of an index build in flight, for close to cancel; only a server can take that call meanwhile. */
  private buildPid: number | null = null;

  private constructor(
    public readonly db: Backend,
    public readonly dataDir: string,
    public embeddingDim: number,
    private readonly embedded: boolean,
  ) {}

  /**
   * Open (or create) the store: run pending migrations, then make sure the
   * dimension-dependent embeddings table exists. If the dimension changed
   * since last run the table is rebuilt (embeddings are regenerated by sync).
   */
  static async open(dataDir: string, embeddingDim: number, dbConfig?: DatabaseConfig): Promise<Store> {
    const db = await openBackend(dataDir, dbConfig);
    const store = new Store(db, dataDir, embeddingDim, (dbConfig?.kind || 'pglite') === 'pglite');
    try {
      return await store.prepare(embeddingDim);
    } catch (err) {
      // a failed open hands its backend back: the pool's connections, an embedded database's claim on its directory
      await store.close().catch(() => undefined);
      throw err;
    }
  }

  private async prepare(embeddingDim: number): Promise<Store> {
    const db = this.db;
    await db.exec(`
      CREATE EXTENSION IF NOT EXISTS vector;
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value JSONB NOT NULL
      );
    `);
    this.migration = await migrate(this, (fn) => this.tx(fn));

    const prev = await db.query<{ value: { dim: number; type?: string } }>(
      `SELECT value FROM meta WHERE key = 'embedding'`,
    );
    const prevDim = prev.rows[0]?.value?.dim;
    // Databases written before the halfvec switch carry no type and are `vector`.
    const prevType = prev.rows[0]?.value?.type ?? 'vector';
    if (prevDim !== undefined && prevDim !== embeddingDim) {
      // A new dimension invalidates the stored vectors themselves — drop them
      // and let the next sync regenerate.
      await db.exec(`DROP TABLE IF EXISTS embeddings; DROP TABLE IF EXISTS entity_embeddings; DROP TABLE IF EXISTS claim_embeddings;`);
      await db.exec(`UPDATE documents SET status = 'pending' WHERE status = 'indexed';`);
      console.warn(`[knode-os] embedding dimension changed ${prevDim} -> ${embeddingDim}; embeddings dropped, re-run sync.`);
    } else if (prevDim !== undefined && prevType !== VECTOR_TYPE) {
      // Same dimension, different column type (the vector -> halfvec switch):
      // the values stay meaningful, so cast in place instead of re-embedding.
      // Any index built for the old type's operator class must go first.
      await db.exec(`
        DROP INDEX IF EXISTS embeddings_hnsw_idx;
        ALTER TABLE embeddings
          ALTER COLUMN embedding TYPE ${VECTOR_TYPE}(${embeddingDim})
          USING embedding::${VECTOR_TYPE}(${embeddingDim});
      `);
      console.warn(`[knode-os] embedding column converted ${prevType} -> ${VECTOR_TYPE} (${embeddingDim}d); vectors preserved.`);
    }
    await db.exec(embeddingsDdl(embeddingDim));
    await this.setMeta('embedding', { dim: embeddingDim, type: VECTOR_TYPE });
    // v13 leaves the stored co_occurs rows for here: short autocommitted batches
    // in the background, not one delete inside the migration's transaction, so
    // the open returns at once; close() stops them and the next open resumes
    this.cleanup = dropStoredCoOccurrence(this, { stop: () => this.stopCleanup }).catch((err: unknown) => {
      console.warn(`[knode-os] co_occurs cleanup stopped: ${err instanceof Error ? err.message : String(err)}; the next open resumes it`);
      return null;
    });
    // claims folded under an older claim type mapping follow the same way; a
    // store without claims records the mapping here and starts nothing
    if (await claimTypesStale(this)) {
      this.retype = this.cleanup
        .then(() => refoldClaimTypes(this, { stop: () => this.stopCleanup }))
        .catch((err: unknown) => {
          console.warn(`[knode-os] claim type refold stopped: ${err instanceof Error ? err.message : String(err)}; the next open resumes it`);
          return null;
        });
    }
    // building the chunk index takes minutes on a large workspace; searches
    // scan without it until it is ready, and a stopped build starts over
    this.indexing = this.cleanup
      .then(() => ensureMatchIndexes(this, { stop: () => this.stopCleanup, building: (pid) => { this.buildPid = pid; } }))
      .catch((err: unknown) => {
        console.warn(`[knode-os] search index build stopped: ${err instanceof Error ? err.message : String(err)}; the next open builds it`);
        return null;
      });
    return this;
  }

  /** Statements and transactions sent to the backend and not answered yet. */
  private readonly inFlight = new Set<Promise<void>>();
  /** Set when `close` has let the last statements finish: nothing more is sent to the backend. */
  private closed = false;

  /**
   * `sent`, counted as in flight until it settles — and refused once the
   * store has closed. `close` waits for what is in flight: an embedded
   * database's own close does not, and a statement its caller did not wait
   * for then ran after the close had returned, on a directory that could be
   * open again by then (see `close`).
   */
  private track<T>(send: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('this index is closed: nothing more can be asked of it'));
    const sent = send();
    const settled = sent.then(() => undefined, () => undefined);
    this.inFlight.add(settled);
    void settled.then(() => this.inFlight.delete(settled));
    return sent;
  }

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    const res = await this.track(() => this.db.query<T>(sql, params));
    return res.rows;
  }

  async exec(sql: string): Promise<void> {
    await this.track(() => this.db.exec(sql));
  }

  /**
   * Run `fn` inside a transaction. The passed handle must be used for every
   * statement in the callback: on PostgreSQL `store.query` runs on another
   * pooled connection, outside the transaction, and on PGlite, which holds a
   * mutex for the transaction, calling it from inside deadlocks.
   *
   * A transaction Postgres picks as a deadlock victim, or one that fails to
   * serialize, is rolled back and run again, up to TX_ATTEMPTS times in all —
   * so `fn` may run more than once: it keeps effects outside the database for
   * after it returns, and starts any state it builds up afresh.
   */
  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      // a body that swallowed the deadlock error fails later on "current transaction is aborted": the deadlock decides
      let conflict = false;
      const watch = <R>(p: Promise<R>): Promise<R> =>
        p.catch((err: unknown) => {
          if (isRetryableTxError(err)) conflict = true;
          throw err;
        });
      try {
        return await this.track(() => this.db.transaction(async (tx) =>
          fn({
            query: async (sql, params) => (await watch(tx.query(sql, params))).rows as never,
            exec: async (sql) => {
              await watch(tx.exec(sql));
            },
          }),
        ));
      } catch (err) {
        if (attempt >= TX_ATTEMPTS || !(conflict || isRetryableTxError(err))) throw err;
        console.warn(`[knode-os] transaction rolled back (${err instanceof Error ? err.message : err}); running it again, attempt ${attempt + 1} of ${TX_ATTEMPTS}`);
        // the transaction that won holds its locks until it commits; let it
        await new Promise((r) => setTimeout(r, attempt * (20 + Math.random() * 30)));
      }
    }
  }

  /** Legacy transaction helper; prefer `tx`. */
  async transaction<T>(fn: (query: <R>(sql: string, params?: unknown[]) => Promise<R[]>) => Promise<T>): Promise<T> {
    return this.tx((q) => fn((sql, params) => q.query(sql, params)));
  }

  /**
   * Rebuild the embeddings table for a new vector dimension and mark every
   * document pending so the next sync regenerates embeddings. No-op if the
   * dimension is unchanged.
   */
  async setEmbeddingDimension(dim: number): Promise<void> {
    if (dim === this.embeddingDim) return;
    await this.db.exec(`DROP TABLE IF EXISTS embeddings; DROP TABLE IF EXISTS entity_embeddings; DROP TABLE IF EXISTS claim_embeddings;`);
    await this.db.exec(embeddingsDdl(dim));
    await this.db.exec(`UPDATE documents SET status = 'pending' WHERE status = 'indexed';`);
    await this.setMeta('embedding', { dim, type: VECTOR_TYPE });
    this.embeddingDim = dim;
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    const rows = await this.query<{ value: T }>(`SELECT value FROM meta WHERE key = $1`, [key]);
    return rows[0]?.value;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.query(
      `INSERT INTO meta (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    );
  }

  async close(): Promise<void> {
    // let the batch in flight finish, then stop: a half-done cleanup or refold resumes at the next open
    this.stopCleanup = true;
    // an index build is one statement of minutes: cancel it (it rolls back whole); embedded PGlite runs one statement at a time, so it is waited for
    if (this.buildPid !== null && !this.embedded) {
      await this.query(`SELECT pg_cancel_backend($1)`, [this.buildPid]).catch(() => undefined);
    }
    await this.cleanup;
    await this.retype;
    await this.indexing;
    // Whatever was sent and not waited for by its caller is waited for here, and nothing is taken after.
    // Embedded PGlite closes under a statement still queued on it and runs the statement afterwards: a
    // workspace closed and reopened at once then had two instances on one directory, and the second one's
    // close never returned (a loop inside the database; tests/pglite-open-guard.test.ts hung on it when
    // serve's open asked a question it did not wait for, 2026-11-15).
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
    this.closed = true;
    await this.db.close();
  }
}

export type { Queryable } from './migrations.js';

/** Serialize a JS number[] for a pgvector parameter. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? +x.toFixed(7) : 0)).join(',')}]`;
}
