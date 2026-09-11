import crypto from 'node:crypto';
import { Store } from '../store/db.js';
import { toIso } from '../store/temporal.js';

/**
 * Change subscriptions.
 *
 * Polled, not pushed, and the cursor is a system time rather than a queue
 * position. That means a subscriber that was offline for a week still sees
 * everything that happened, and two subscribers reading the same target never
 * consume each other's events — which a queue would have to be careful about
 * and a bitemporal store gets for free.
 */

export type SubscriptionKind = 'entity' | 'source' | 'intent';

export interface Subscription {
  id: string;
  kind: SubscriptionKind;
  target: string;
  actor: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface Change {
  kind: 'evidence' | 'claim' | 'scope' | 'receipt';
  at: string;
  summary: string;
  detail: Record<string, unknown>;
}

interface Row {
  id: string; kind: string; target: string; actor: string; created_at: string; last_seen_at: string;
}

function project(r: Row): Subscription {
  return {
    id: r.id, kind: r.kind as SubscriptionKind, target: r.target, actor: r.actor,
    createdAt: toIso(r.created_at)!, lastSeenAt: toIso(r.last_seen_at)!,
  };
}

export async function subscribe(store: Store, input: { kind: SubscriptionKind; target: string; actor?: string }): Promise<Subscription> {
  const actor = input.actor ?? 'agent';
  const id = `s_${crypto.createHash('sha256').update(`${actor}|${input.kind}|${input.target}`).digest('hex').slice(0, 16)}`;
  const [row] = await store.query<Row>(
    `INSERT INTO subscriptions (id, kind, target, actor) VALUES ($1, $2, $3, $4)
     ON CONFLICT (actor, kind, target) DO UPDATE SET target = EXCLUDED.target
     RETURNING id, kind, target, actor, created_at, last_seen_at`,
    [id, input.kind, input.target, actor],
  );
  return project(row);
}

export async function unsubscribe(store: Store, id: string): Promise<boolean> {
  const rows = await store.query<{ id: string }>(`DELETE FROM subscriptions WHERE id = $1 RETURNING id`, [id]);
  return rows.length > 0;
}

export async function listSubscriptions(store: Store, actor?: string): Promise<Subscription[]> {
  const rows = await store.query<Row>(
    actor
      ? `SELECT id, kind, target, actor, created_at, last_seen_at FROM subscriptions WHERE actor = $1 ORDER BY created_at`
      : `SELECT id, kind, target, actor, created_at, last_seen_at FROM subscriptions ORDER BY created_at`,
    actor ? [actor] : [],
  );
  return rows.map(project);
}

/**
 * What changed for a subscription since its cursor.
 *
 * `advance: false` peeks without moving the cursor — a subscriber that crashes
 * mid-handling should see the same events again, so the cursor only moves once
 * the caller says it has them.
 */
export async function changesSince(
  store: Store,
  id: string,
  opts: { limit?: number; advance?: boolean } = {},
): Promise<{ subscription: Subscription; changes: Change[]; cursor: string }> {
  const [row] = await store.query<Row>(
    `SELECT id, kind, target, actor, created_at, last_seen_at FROM subscriptions WHERE id = $1`,
    [id],
  );
  if (!row) throw new Error(`unknown subscription ${id}`);
  const sub = project(row);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const since = sub.lastSeenAt;
  const changes: Change[] = [];

  if (sub.kind === 'entity') {
    const evidence = await store.query<{ target_id: string; kind: string; extractor: string; tx_from: string; key: string }>(
      `SELECT ev.target_id, ev.kind, ev.extractor, ev.tx_from, s.key
       FROM evidence ev JOIN scopes s ON s.id = ev.scope_id
       WHERE ev.target_id = $1 AND ev.tx_from > $2::timestamptz
       ORDER BY ev.tx_from LIMIT $3`,
      [sub.target, since, limit],
    );
    for (const e of evidence) {
      changes.push({
        kind: 'evidence',
        at: toIso(e.tx_from)!,
        summary: `${e.key} added ${e.kind} evidence via ${e.extractor}`,
        detail: { targetId: e.target_id, source: e.key, extractor: e.extractor },
      });
    }
    const claims = await store.query<{ id: string; statement: string; status: string; tx_from: string }>(
      `SELECT id, statement, status, tx_from FROM claims
       WHERE subject_id = $1 AND tx_from > $2::timestamptz ORDER BY tx_from LIMIT $3`,
      [sub.target, since, limit],
    );
    for (const c of claims) {
      changes.push({
        kind: 'claim',
        at: toIso(c.tx_from)!,
        summary: `claim ${c.status}: ${c.statement.slice(0, 120)}`,
        detail: { claimId: c.id, status: c.status },
      });
    }
  } else if (sub.kind === 'source') {
    const scopes = await store.query<{ id: string; kind: string; key: string; applied_at: string; disposed_at: string | null }>(
      `SELECT id, kind, key, applied_at, disposed_at FROM scopes
       WHERE (key = $1 OR key LIKE $1 || '/%')
         AND (applied_at > $2::timestamptz OR disposed_at > $2::timestamptz)
       ORDER BY applied_at LIMIT $3`,
      [sub.target, since, limit],
    );
    for (const s of scopes) {
      const disposed = s.disposed_at && toIso(s.disposed_at)! > since;
      changes.push({
        kind: 'scope',
        at: toIso(disposed ? s.disposed_at! : s.applied_at)!,
        summary: `${s.kind} ${s.key} ${disposed ? 'disposed' : 'applied'}`,
        detail: { scopeId: s.id, kind: s.kind, key: s.key, disposed: Boolean(disposed) },
      });
    }
  } else {
    const receipts = await store.query<{ id: string; query: string; outcome: string | null; created_at: string }>(
      `SELECT id, query, outcome, created_at FROM receipts
       WHERE intent = $1 AND created_at > $2::timestamptz ORDER BY created_at LIMIT $3`,
      [sub.target, since, limit],
    );
    for (const r of receipts) {
      changes.push({
        kind: 'receipt',
        at: toIso(r.created_at)!,
        summary: `resolve ${r.id}${r.outcome ? ` → ${r.outcome}` : ' (no feedback yet)'}: ${r.query.slice(0, 80)}`,
        detail: { receiptId: r.id, outcome: r.outcome },
      });
    }
  }

  changes.sort((a, b) => a.at.localeCompare(b.at));
  const cursor = changes.length > 0 ? changes[changes.length - 1].at : since;
  if (opts.advance !== false && changes.length > 0) {
    await store.query(`UPDATE subscriptions SET last_seen_at = $2::timestamptz WHERE id = $1`, [id, cursor]);
  }
  return { subscription: { ...sub, lastSeenAt: cursor }, changes: changes.slice(0, limit), cursor };
}
