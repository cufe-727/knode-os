import { Queryable } from './migrations.js';

/**
 * Substring matching through an index.
 *
 * Search matches query terms as substrings of chunk text and entity names
 * (`queryTerms`: Latin tokens, and CJK runs broken into bigrams). Postgres
 * full-text search finds no word boundaries in CJK text, and pg_trgm cannot
 * look up a pattern shorter than three characters, so every such match used to
 * scan the whole table. `match_grams(text)` (migration v18) reduces a text to
 * the n-grams of its lowercased runs: each bigram of a CJK run, each bigram and
 * trigram of a run of [a-z0-9_.$-]. A text that contains a term contains all of
 * the term's grams (`termGrams`), so a GIN index over `match_grams` answers a
 * necessary condition, and `strpos` on the lowercased text decides exactly:
 * the same matches `ILIKE '%term%'` made, without its `_` wildcard.
 *
 * The indexes are built after the store opens (`ensureMatchIndexes`), because
 * on a large workspace that takes minutes; until one is ready, the queries that
 * use it scan without it (`matchIndexReady`).
 */

export const MATCH_INDEXES = {
  entities: {
    name: 'entities_match_grams_idx',
    table: 'entities',
    expr: (alias: string) => `match_grams(${alias}.name || ' ' || ${alias}.aliases::text || ' ' || ${alias}.description)`,
  },
  chunks: {
    name: 'chunks_match_grams_idx',
    table: 'chunks',
    expr: (alias: string) => `match_grams(${alias}.content)`,
  },
} as const;

export type MatchIndex = keyof typeof MATCH_INDEXES;

/** The character classes `match_grams` takes runs of, and `queryTerms` takes terms from. */
const CJK_TERM = /^[一-鿿㐀-䶿]{2,}$/;
const LATIN_TERM = /^[a-z0-9_.$-]{2,}$/;

/**
 * The grams every text containing `term` holds, as `match_grams` makes them:
 * the bigrams of a CJK term, the trigrams of a longer Latin one, a two-letter
 * token itself. Empty for a term outside both classes, which no index serves.
 */
export function termGrams(term: string): string[] {
  const t = term.toLowerCase();
  const n = CJK_TERM.test(t) ? 2 : LATIN_TERM.test(t) ? Math.min(3, t.length) : 0;
  if (n === 0) return [];
  const grams = new Set<string>();
  for (let i = 0; i + n <= t.length; i++) grams.add(t.slice(i, i + n));
  return [...grams];
}

function lexeme(gram: string): string {
  return `'${gram.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/**
 * A tsquery holding when at least `m` of the terms (each given as its grams)
 * have all their grams present: (t1 & atLeast(m-1, rest)) | atLeast(m, rest).
 * GIN evaluates it in one index scan, and only has to walk the posting lists
 * of the rarer terms to find the documents it can hold for.
 */
export function gramQuery(terms: string[][], m: number): string {
  const all = terms.map((grams) => (grams.length === 1 ? lexeme(grams[0]) : `(${grams.map(lexeme).join(' & ')})`));
  const atLeast = (need: number, xs: string[]): string => {
    if (need === 1) return xs.length === 1 ? xs[0] : `(${xs.join(' | ')})`;
    if (need === xs.length) return `(${xs.join(' & ')})`;
    return `((${xs[0]} & ${atLeast(need - 1, xs.slice(1))}) | ${atLeast(need, xs.slice(1))})`;
  };
  return atLeast(Math.max(1, Math.min(m, all.length)), all);
}

/** Readiness lives on the Store; a query handle without it (a benchmark's wrapper) scans. */
export interface MatchIndexState {
  matchIndexes?: ReadonlySet<string>;
}

export function matchIndexReady(store: object, index: MatchIndex): boolean {
  return (store as MatchIndexState).matchIndexes?.has(MATCH_INDEXES[index].name) ?? false;
}

export interface MatchIndexResult {
  built: string[];
  seconds: number;
}

/** What `ensureMatchIndexes` needs of a store: transactions, and the set it marks ready. */
interface MatchIndexStore {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  readonly matchIndexes: Set<string>;
}

/** Rows below which building an index is not worth a log line. */
const QUIET_ROWS = 10_000;

/**
 * Build the substring indexes that are missing, one transaction each, and mark
 * each ready on the store once it is there. Store.open runs this in the
 * background, so the service comes up at once and searches scan until the
 * index they use is ready. Measured on a copy of the finance workspace (374k
 * chunks, 118k entities, 2026-11-01): the chunk index takes 141–154 s to build
 * and is 531 MB, the entity index 1–2 s and 25 MB; a larger maintenance_work_mem
 * does not shorten it, evaluating match_grams does most of the work.
 *
 * A plain CREATE INDEX inside the transaction holds writes to the table until
 * it commits, and is all or nothing: an interrupted build leaves no invalid
 * index behind, and the next open builds it again. An advisory lock keeps two
 * processes opening the same workspace from building the same index at once;
 * the one that finds it taken waits and then finds the index there.
 * `building` hears the backend pid while a build runs, so close can cancel it.
 */
export async function ensureMatchIndexes(
  store: MatchIndexStore,
  opts: { stop?: () => boolean; building?: (pid: number | null) => void; log?: (line: string) => void; pollMs?: number } = {},
): Promise<MatchIndexResult> {
  const log = opts.log ?? ((line: string) => console.log(`[knode-os] ${line}`));
  const started = Date.now();
  const built: string[] = [];
  for (const spec of Object.values(MATCH_INDEXES)) {
    for (;;) {
      if (opts.stop?.()) return { built, seconds: (Date.now() - started) / 1000 };
      const outcome = await store.tx(async (q) => {
        const [{ locked }] = await q.query<{ locked: boolean }>(
          `SELECT pg_try_advisory_xact_lock(hashtext(current_schema() || '.match_grams')) AS locked`,
        );
        if (!locked) return 'busy';
        const [index] = await q.query<{ valid: boolean }>(
          `SELECT i.indisvalid AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
           WHERE c.relname = $1 AND c.relnamespace = current_schema()::regnamespace`,
          [spec.name],
        );
        if (index?.valid) return 'present';
        // an invalid one can only be left by a concurrent build someone ran by hand
        if (index) await q.query(`DROP INDEX ${spec.name}`);
        const [{ rows }] = await q.query<{ rows: number }>(`SELECT count(*)::int AS rows FROM ${spec.table}`);
        const t0 = Date.now();
        if (rows >= QUIET_ROWS) log(`building ${spec.name} over ${rows} ${spec.table} rows; searches scan ${spec.table} until it is ready`);
        const [{ pid }] = await q.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
        opts.building?.(pid);
        try {
          await q.query(`CREATE INDEX ${spec.name} ON ${spec.table} USING gin (${spec.expr(spec.table)})`);
        } finally {
          opts.building?.(null);
        }
        if (rows >= QUIET_ROWS) log(`built ${spec.name} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
        return 'built';
      });
      if (outcome === 'busy') {
        // another process holds the lock while it builds; look again shortly
        const pollMs = opts.pollMs ?? 5000;
        for (let waited = 0; waited < pollMs && !opts.stop?.(); waited += 250) await new Promise((r) => setTimeout(r, Math.min(250, pollMs)));
        continue;
      }
      store.matchIndexes.add(spec.name);
      if (outcome === 'built') built.push(spec.name);
      break;
    }
  }
  return { built, seconds: (Date.now() - started) / 1000 };
}
