import { Store } from '../store/db.js';
import { toDateString } from '../store/temporal.js';
import { CurrentClaim, SearchResult } from '../types.js';

/**
 * Current state beside a passage (docs/design/30 §4).
 *
 * A passage is what a document said when it was written; a claim read off it
 * may since have been replaced by a newer one of the same subject and type
 * (`claims.superseded_by`, set today by wiki refinement for finance and being
 * generalised by the claim-state work). Search ranks passages, not beliefs, so
 * an old quarterly figure can outrank the restated one. Rather than demote the
 * passage — it may be exactly the history the question asks about — each hit
 * that rests on a superseded claim carries the claim that holds now, at the end
 * of its chain, with its date and source, and `ask` lists that claim among
 * its facts. One query over the returned chunks, plus one per link of the
 * longest chain (bounded).
 */

const MAX_CHAIN = 6;
/** Superseded claims attached to one hit at most. */
const PER_HIT = 4;

interface Was {
  chunk_id: string;
  id: string;
  statement: string;
  superseded_by: string;
}

interface Link {
  id: string;
  statement: string;
  superseded_by: string | null;
  event_at: string | Date | null;
  valid_from: string | Date | null;
  path: string | null;
}

/** The claims that replaced claims read off `chunkIds`: chunk id → what was said, and what holds now. */
export async function currentFor(store: Store, chunkIds: string[]): Promise<Map<string, CurrentClaim[]>> {
  const out = new Map<string, CurrentClaim[]>();
  if (chunkIds.length === 0) return out;
  const was = await store.query<Was>(
    `SELECT cl.chunk_id, cl.id, cl.statement, cl.superseded_by
     FROM claims cl
     WHERE cl.chunk_id = ANY($1::text[]) AND cl.superseded_by IS NOT NULL AND cl.tx_to IS NULL AND cl.canonical_id IS NULL
     ORDER BY cl.chunk_id, cl.id`,
    [chunkIds],
  );
  if (was.length === 0) return out;

  // follow each chain to the claim nothing has replaced
  const links = new Map<string, Link>();
  let want = [...new Set(was.map((w) => w.superseded_by))];
  for (let i = 0; i < MAX_CHAIN && want.length > 0; i++) {
    const rows = await store.query<Link>(
      `SELECT cl.id, cl.statement, cl.superseded_by, cl.event_at, cl.valid_from, s.key AS path
       FROM claims cl LEFT JOIN scopes s ON s.id = cl.primary_scope_id
       WHERE cl.id = ANY($1::text[]) AND cl.tx_to IS NULL`,
      [want],
    );
    for (const r of rows) links.set(r.id, r);
    want = [...new Set(rows.map((r) => r.superseded_by).filter((x): x is string => Boolean(x) && !links.has(x!)))];
  }
  const head = (id: string): Link | null => {
    let at = links.get(id) ?? null;
    for (let i = 0; at?.superseded_by && links.has(at.superseded_by) && i < MAX_CHAIN; i++) at = links.get(at.superseded_by)!;
    return at;
  };

  for (const w of was) {
    const now = head(w.superseded_by);
    if (!now) continue; // the replacing claim is gone: nothing to point at
    const list = out.get(w.chunk_id) ?? [];
    if (list.length >= PER_HIT) continue;
    list.push({
      was: { id: w.id, statement: w.statement },
      now: { id: now.id, statement: now.statement, date: toDateString(now.event_at ?? now.valid_from), path: now.path },
    });
    out.set(w.chunk_id, list);
  }
  return out;
}

/** `results` with `current` set on every hit that rests on a superseded claim. */
export async function attachCurrent(store: Store, results: SearchResult[]): Promise<SearchResult[]> {
  const current = await currentFor(store, results.map((r) => r.chunkId));
  if (current.size === 0) return results;
  return results.map((r) => (current.has(r.chunkId) ? { ...r, current: current.get(r.chunkId) } : r));
}
