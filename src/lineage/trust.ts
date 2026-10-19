import crypto from 'node:crypto';
import { Store } from '../store/db.js';
import { Params, live } from '../store/temporal.js';
import { appendLedger, nextLedgerSeq } from './ledger.js';

/**
 * Trust tiers and access control, both carried by the scope that produced a
 * fact — the only place that knows where it came from.
 *
 * An agent's own writes land **quarantined**. They are indexed, searchable and
 * attributable, but they cannot silently become the knowledge base's position:
 * where a quarantined claim disagrees with a trusted one, the fold records a
 * *dispute* instead of overwriting. That is the difference between a system
 * that accumulates knowledge and one that accumulates whatever the last agent
 * happened to believe.
 *
 * ACLs are intersected on the way down. A page derived from a public document
 * and a restricted one is restricted, because the alternative — taking the
 * union, or the first input's list — is how derived artifacts leak.
 */

export type TrustTier = 'trusted' | 'quarantined';

export const TRUST_TIERS: readonly TrustTier[] = ['trusted', 'quarantined'];

/** Actors whose writes are quarantined until a person promotes them. */
export function tierForActor(actor: string): TrustTier {
  return /^(agent|mcp|api)\b/i.test(actor) ? 'quarantined' : 'trusted';
}

/** SQL predicate over a scopes alias for a requested tier. `any` matches both. */
export function trustSql(alias: string, p: Params, tier: TrustTier | 'any' | undefined): string {
  if (!tier || tier === 'any') return 'TRUE';
  return `${alias}.trust = ${p.add(tier)}`;
}

/**
 * Intersect ACLs. An empty list means "no restriction", so it is the identity
 * for this operation — intersecting an unrestricted input with a restricted
 * one has to yield the restriction, not the empty (unrestricted) set.
 */
export function intersectAcl(lists: string[][]): string[] {
  const restricted = lists.filter((l) => l.length > 0);
  if (restricted.length === 0) return [];
  return restricted.reduce((acc, list) => acc.filter((x) => list.includes(x)));
}

/** Empty ACL = readable by anyone. Otherwise the actor has to be named. */
export function aclAllows(acl: string[] | null | undefined, actor: string | undefined): boolean {
  if (!acl || acl.length === 0) return true;
  if (!actor) return false;
  return acl.includes(actor) || acl.includes('*');
}

export interface PromoteResult {
  scopeId: string;
  key: string;
  from: TrustTier;
  to: TrustTier;
  evidenceRows: number;
  /** Disputes this scope had opened, now resolved in its favour. */
  disputesResolved: number;
}

/**
 * Promote a quarantined source to trusted, or demote a trusted one — with the
 * live scopes read out of it (its tier-1 extraction, the prose on a generated
 * page), which carry its tier (src/lineage/scope.ts).
 *
 * Promotion resolves the disputes those scopes opened: the whole point of
 * quarantining was to hold the disagreement open until somebody looked at it,
 * so the act of looking is what closes it.
 */
export async function setScopeTrust(
  store: Store,
  opts: { key: string; kind?: string; to: TrustTier; actor?: string },
): Promise<PromoteResult> {
  const p = new Params([opts.key]);
  const kindCond = opts.kind ? ` AND kind = ${p.add(opts.kind)}` : '';
  // the source itself, not a scope read out of it under the same key; a document before a page of the same path
  const [scope] = await store.query<{ id: string; key: string; trust: TrustTier }>(
    `SELECT id, key, trust FROM scopes WHERE key = $1${kindCond} AND status = 'active' AND parent_id IS NULL
     ORDER BY (kind = 'doc') DESC, applied_at DESC LIMIT 1`,
    p.list,
  );
  if (!scope) throw new Error(`no live scope for "${opts.key}"`);

  let evidenceRows = 0;
  let disputesResolved = 0;
  await store.tx(async (q) => {
    const tree = (await q.query<{ id: string }>(
      `WITH RECURSIVE tree AS (
         SELECT id FROM scopes WHERE id = $1
         UNION SELECT s.id FROM scopes s JOIN tree t ON s.parent_id = t.id WHERE s.status <> 'disposed'
       ) SELECT id FROM tree`,
      [scope.id],
    )).map((r) => r.id);
    const t = new Params([opts.to]);
    const inTree = tree.map((id) => t.add(id)).join(',');
    await q.query(`UPDATE scopes SET trust = $1 WHERE id IN (${inTree})`, t.list);
    const rows = await q.query<{ id: string }>(
      `UPDATE evidence SET trust = $1 WHERE scope_id IN (${inTree}) AND tx_to IS NULL RETURNING id`,
      t.list,
    );
    evidenceRows = rows.length;
    if (opts.to === 'trusted') {
      const r = new Params([opts.actor ?? 'user']);
      const resolved = await q.query<{ id: string }>(
        `UPDATE disputes SET status = 'resolved', resolved_at = now(), resolved_by = $1
         WHERE scope_id IN (${tree.map((id) => r.add(id)).join(',')}) AND status = 'open' RETURNING id`,
        r.list,
      );
      disputesResolved = resolved.length;
    }
  });

  const seq = await nextLedgerSeq(store);
  appendLedger(store.dataDir, {
    seq,
    ts: new Date().toISOString(),
    ev: 'feedback',
    actor: opts.actor ?? 'user',
    kind: 'scope.trust',
    id: scope.id,
    payload: { key: scope.key, from: scope.trust, to: opts.to },
  });
  return { scopeId: scope.id, key: scope.key, from: scope.trust, to: opts.to, evidenceRows, disputesResolved };
}

export interface Dispute {
  id: string;
  claimId: string;
  againstId: string | null;
  reason: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
}

/**
 * Open a dispute between two claims. Idempotent on the pair, so re-running a
 * sync does not pile up duplicates of the same disagreement.
 */
export async function openDispute(
  store: Store,
  input: { claimId: string; againstId?: string | null; scopeId?: string | null; reason: string; detail?: Record<string, unknown> },
): Promise<string> {
  const id = crypto.createHash('sha256').update(`${input.claimId}|${input.againstId ?? ''}`).digest('hex').slice(0, 16);
  await store.query(
    `INSERT INTO disputes (id, claim_id, against_id, scope_id, reason, detail)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (id) DO UPDATE SET reason = EXCLUDED.reason, detail = EXCLUDED.detail`,
    [id, input.claimId, input.againstId ?? null, input.scopeId ?? null, input.reason, JSON.stringify(input.detail ?? {})],
  );
  return id;
}

export async function listDisputes(store: Store, opts: { status?: string; claimId?: string } = {}): Promise<Dispute[]> {
  const p = new Params();
  const conds: string[] = [];
  if (opts.status) conds.push(`status = ${p.add(opts.status)}`);
  if (opts.claimId) conds.push(`claim_id = ${p.add(opts.claimId)}`);
  const rows = await store.query<{
    id: string; claim_id: string; against_id: string | null; reason: string;
    status: string; created_at: string; resolved_at: string | null;
  }>(
    `SELECT id, claim_id, against_id, reason, status, created_at, resolved_at FROM disputes
     ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 200`,
    p.list,
  );
  return rows.map((r) => ({
    id: r.id, claimId: r.claim_id, againstId: r.against_id, reason: r.reason,
    status: r.status, createdAt: r.created_at, resolvedAt: r.resolved_at,
  }));
}

export async function resolveDispute(store: Store, id: string, actor = 'user'): Promise<boolean> {
  const rows = await store.query<{ id: string }>(
    `UPDATE disputes SET status = 'resolved', resolved_at = now(), resolved_by = $2
     WHERE id = $1 AND status = 'open' RETURNING id`,
    [id, actor],
  );
  return rows.length > 0;
}

/**
 * Find claims a quarantined scope contradicts, and open a dispute for each.
 *
 * "Contradicts" is deliberately narrow: same subject, same claim type, a
 * different statement, and an overlapping validity window. Two claims about
 * different quarters do not disagree, and a broad definition would bury the
 * real disagreements under noise nobody reads.
 */
export async function detectDisputes(store: Store, scopeId: string): Promise<Dispute[]> {
  const [scope] = await store.query<{ id: string; trust: TrustTier; key: string }>(
    `SELECT id, trust, key FROM scopes WHERE id = $1`,
    [scopeId],
  );
  if (!scope || scope.trust !== 'quarantined') return [];

  const conflicts = await store.query<{ mine: string; theirs: string; subject: string; type: string; my_statement: string; their_statement: string }>(
    `SELECT DISTINCT a.id AS mine, b.id AS theirs, a.subject_id AS subject, a.type,
            a.statement AS my_statement, b.statement AS their_statement
     FROM evidence ev
     JOIN claims a ON a.id = ev.target_id AND ev.kind = 'claim'
     JOIN claims b ON b.subject_id = a.subject_id AND b.type = a.type AND b.id <> a.id
       -- two wordings of one fact (a merged claim group) are not a contradiction
       AND COALESCE(b.canonical_id, b.id) <> COALESCE(a.canonical_id, a.id)
     WHERE ev.scope_id = $1 AND ev.tx_to IS NULL AND a.tx_to IS NULL AND b.tx_to IS NULL
       AND a.statement <> b.statement
       AND a.status <> 'absent' AND b.status <> 'absent'
       AND (a.valid_from IS NULL OR b.valid_to IS NULL OR a.valid_from <= b.valid_to)
       AND (a.valid_to IS NULL OR b.valid_from IS NULL OR a.valid_to >= b.valid_from)
       AND EXISTS (
         SELECT 1 FROM evidence tv WHERE tv.kind = 'claim' AND tv.target_id = b.id
           AND tv.tx_to IS NULL AND tv.trust = 'trusted')`,
    [scopeId],
  );

  const out: Dispute[] = [];
  for (const c of conflicts) {
    const id = await openDispute(store, {
      claimId: c.mine,
      againstId: c.theirs,
      scopeId,
      reason: `quarantined source ${scope.key} contradicts a trusted claim about ${c.subject} (${c.type})`,
      detail: { quarantined: c.my_statement, trusted: c.their_statement },
    });
    out.push({
      id, claimId: c.mine, againstId: c.theirs,
      reason: `quarantined source ${scope.key} contradicts a trusted claim about ${c.subject} (${c.type})`,
      status: 'open', createdAt: new Date().toISOString(), resolvedAt: null,
    });
  }
  return out;
}

/** Trust predicate over an evidence alias, for read paths that filter by tier. */
export function evidenceTrustSql(alias: string, p: Params, tier: TrustTier | 'any' | undefined): string {
  if (!tier || tier === 'any') return 'TRUE';
  return `${alias}.trust = ${p.add(tier)}`;
}

/** Live claims a scope asserts, with the trust tier behind each. */
export async function claimTrust(store: Store, claimIds: string[]): Promise<Map<string, TrustTier>> {
  if (claimIds.length === 0) return new Map();
  const p = new Params();
  const ph = claimIds.map((id) => p.add(id)).join(',');
  const rows = await store.query<{ target_id: string; trust: TrustTier }>(
    `SELECT ev.target_id, min(ev.trust) AS trust FROM evidence ev
     WHERE ev.kind = 'claim' AND ev.target_id IN (${ph}) AND ${live('ev', p)}
     GROUP BY ev.target_id`,
    p.list,
  );
  // min() over ('quarantined','trusted') picks 'quarantined' — a claim with any
  // trusted support reads as trusted only when *all* its support is trusted
  return new Map(rows.map((r) => [r.target_id, r.trust]));
}
