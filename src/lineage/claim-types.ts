import { CLAIM_TYPE_MAPPING_SHA, CLAIM_TYPES } from '../graph/store.js';
import { Queryable } from '../store/migrations.js';
import { foldTouched } from './fold.js';
import { lockLedger } from './ledger.js';
import { emptyTouched } from './types.js';

/**
 * A claim takes its type from its evidence, and evidence written before the
 * closed list carries the extractor's own label: on the finance workspace
 * 367,688 live claims under 57,131 labels (市场表现, 盈利预测 …), 57% of them,
 * which no type filter found. The fold maps the label now
 * (`foldClaimEvidence`), but a claim only folds again when one of its sources
 * changes. So whenever the mapping changes (`CLAIM_TYPE_MAPPING_SHA`), the
 * live claims it could move — a type off the list, or `other` — are folded
 * again here, once, in the background after `Store.open`.
 *
 * A repair, like `sync --verify`'s recount: the type is how a row reads, not
 * what any source asserts, so nothing that depends on the claims is marked
 * dirty or stale. On finance that would have put 1,061 pending suggestions out
 * of date for a relabel.
 */

/** `meta` key: the mapping the live claims were last folded under, and how that refold went. */
export const CLAIM_TYPES_META = 'claim_types';

export interface ClaimTypeRefoldResult {
  claims: number;
  /** Claims whose fold changed: their type, or drift the fold repaired on the way. */
  changed: number;
  batches: number;
  seconds: number;
}

interface RefoldStore extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
}

/** Types no mapping moves a claim out of: every one on the list but `other`. */
const SETTLED = CLAIM_TYPES.filter((t) => t.id !== 'other').map((t) => t.id);

/**
 * Whether the live claims were folded under another mapping. A store with no
 * live claims has nothing to refold and records the mapping at once, before
 * `open` returns, so a fresh store starts no background pass that could race
 * its first writes.
 */
export async function claimTypesStale(store: RefoldStore): Promise<boolean> {
  const meta = await store.getMeta<{ sha?: string }>(CLAIM_TYPES_META);
  if (meta?.sha === CLAIM_TYPE_MAPPING_SHA) return false;
  const [live] = await store.query<{ one: number }>(`SELECT 1 AS one FROM claims WHERE tx_to IS NULL LIMIT 1`);
  if (live) return true;
  await store.setMeta(CLAIM_TYPES_META, { sha: CLAIM_TYPE_MAPPING_SHA, at: new Date().toISOString(), claims: 0 });
  return false;
}

/**
 * Fold the live claims whose type the mapping may change, `batch` claims per
 * transaction, keyed forward by id. Each transaction takes the ledger lock
 * first, as scope transactions do, since both fold claim rows. Stopped, it
 * leaves the mapping unrecorded and the next open starts over; the claims it
 * already moved onto a listed type are not selected again.
 */
export async function refoldClaimTypes(
  store: RefoldStore,
  opts: { batch?: number; log?: (line: string) => void; stop?: () => boolean } = {},
): Promise<ClaimTypeRefoldResult | null> {
  const meta = await store.getMeta<{ sha?: string }>(CLAIM_TYPES_META);
  if (meta?.sha === CLAIM_TYPE_MAPPING_SHA) return null;
  const batch = Math.max(100, Math.floor(opts.batch ?? 2_000));
  const log = opts.log ?? ((line: string) => console.log(`[knode-os] ${line}`));
  const [{ n: total }] = await store.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM claims WHERE tx_to IS NULL AND NOT (type = ANY($1::text[]))`,
    [SETTLED],
  );
  const started = Date.now();
  if (total > 0) log(`refolding ${total} claims the claim type mapping may move, ${batch} per transaction`);
  const result: ClaimTypeRefoldResult = { claims: 0, changed: 0, batches: 0, seconds: 0 };
  let last = '';
  let lastLog = started;
  for (;;) {
    if (opts.stop?.()) {
      result.seconds = (Date.now() - started) / 1000;
      log(`claim type refold paused at ${result.claims} / ${total} claims after ${result.seconds.toFixed(1)} s; the next open resumes it`);
      return result;
    }
    const ids = (await store.query<{ id: string }>(
      `SELECT id FROM claims WHERE tx_to IS NULL AND id > $1 AND NOT (type = ANY($2::text[])) ORDER BY id LIMIT $3`,
      [last, SETTLED, batch],
    )).map((r) => r.id);
    if (ids.length === 0) break;
    last = ids[ids.length - 1];
    const touched = emptyTouched();
    for (const id of ids) touched.claims.add(id);
    const folded = await store.tx(async (q) => {
      await lockLedger(q);
      return foldTouched(q, touched, new Date().toISOString());
    });
    result.claims += ids.length;
    result.changed += folded.changed.claims.size;
    result.batches++;
    if (Date.now() - lastLog >= 2000) {
      lastLog = Date.now();
      log(`claim type refold: ${result.claims} / ${total} claims, ${result.changed} changed, ${((lastLog - started) / 1000).toFixed(1)} s`);
    }
  }
  result.seconds = (Date.now() - started) / 1000;
  await store.setMeta(CLAIM_TYPES_META, { sha: CLAIM_TYPE_MAPPING_SHA, at: new Date().toISOString(), ...result });
  if (total > 0 || result.claims > 0) log(`refolded ${result.claims} claims in ${result.batches} batches, ${result.changed} changed, ${result.seconds.toFixed(1)} s`);
  return result;
}
