import crypto from 'node:crypto';
import { appendLedger, nextLedgerSeq } from '../lineage/ledger.js';
import { applyScope, disposeScope, findLiveScope } from '../lineage/scope.js';
import { Store } from '../store/db.js';

/**
 * Merging two claims, the way entities merge (graph/merge.ts): evidence is
 * never rewritten. A `claim-merge` scope records the link "this claim says the
 * same as that one" and sets `claims.canonical_id`; the representative's fold
 * then takes in the group's evidence (so its evidence count is its number of
 * sources) and every read of current claims shows the representative only.
 * Disposing the scope (unmerge) restores the claim exactly. Each decision is
 * written to the ledger as feedback, so `rebuild` replays it (docs/design/10).
 */

export interface ClaimMergeInput {
  /** The claim being folded into another. */
  claimId: string;
  /** The representative. */
  canonicalId: string;
  /** 'contains': the representative states this claim and more. */
  kind?: 'same_as' | 'contains';
  reason?: string;
  actor?: string;
  confidence?: number | null;
  /** Write the ledger feedback line (default true; rebuild passes false). */
  log?: boolean;
}

export interface ClaimMergeResult {
  claimId: string;
  canonicalId: string;
  outcome: 'merged' | 'unchanged';
  scopeId: string;
}

interface ClaimLite {
  id: string;
  statement: string;
  canonical_id: string | null;
  tx_to: string | null;
}

async function claim(store: Store, id: string): Promise<ClaimLite | null> {
  const [row] = await store.query<ClaimLite>(`SELECT id, statement, canonical_id, tx_to FROM claims WHERE id = $1`, [id]);
  return row ?? null;
}

export async function applyClaimMerge(store: Store, input: ClaimMergeInput): Promise<ClaimMergeResult> {
  const actor = input.actor ?? 'user';
  const from = await claim(store, input.claimId);
  if (!from || from.tx_to) throw new Error(`claim "${input.claimId}" is not live`);
  let into = await claim(store, input.canonicalId);
  if (!into || into.tx_to) throw new Error(`claim "${input.canonicalId}" is not live`);
  // merging into a merged claim lands on its representative
  if (into.canonical_id) {
    const rep = await claim(store, into.canonical_id);
    if (rep && !rep.tx_to) into = rep;
  }
  if (from.id === into.id) throw new Error('a claim cannot be merged into itself');
  if (into.canonical_id === from.id) throw new Error(`"${into.id}" is already merged into "${from.id}"`);
  // a claim already in a group leaves it first: one live link per claim
  if (from.canonical_id && from.canonical_id !== into.id) await unmergeClaim(store, from.id, { actor, log: input.log });

  const res = await applyScope(
    store,
    { kind: 'claim-merge', key: from.id },
    crypto.createHash('sha256').update(into.id).digest('hex').slice(0, 24),
    { actor, meta: { claimId: from.id, canonicalId: into.id, reason: input.reason ?? '' }, log: input.log },
    async (w) => {
      await w.linkClaim({ claimId: from.id, canonicalId: into.id, kind: input.kind, reason: input.reason, actor, confidence: input.confidence });
    },
  );
  if (res.outcome === 'applied' && (input.log ?? true)) {
    const seq = await nextLedgerSeq(store);
    appendLedger(store.dataDir, {
      seq, ts: new Date().toISOString(), ev: 'feedback', actor, kind: 'claim.merge', id: from.id,
      payload: { canonicalId: into.id, kind: input.kind ?? 'same_as', reason: input.reason ?? '', confidence: input.confidence ?? null },
    });
  }
  return { claimId: from.id, canonicalId: into.id, outcome: res.outcome === 'applied' ? 'merged' : 'unchanged', scopeId: res.scope.id };
}

export async function unmergeClaim(store: Store, claimId: string, opts: { actor?: string; log?: boolean } = {}): Promise<boolean> {
  const scope = await findLiveScope(store, 'claim-merge', claimId);
  if (!scope) return false;
  await disposeScope(store, scope.id, { actor: opts.actor ?? 'user', reason: 'removed', log: opts.log });
  if (opts.log ?? true) {
    const seq = await nextLedgerSeq(store);
    appendLedger(store.dataDir, { seq, ts: new Date().toISOString(), ev: 'feedback', actor: opts.actor ?? 'user', kind: 'claim.unmerge', id: claimId });
  }
  return true;
}

export interface ClaimMergeRow {
  id: string;
  claimId: string;
  statement: string;
  canonicalId: string;
  canonicalStatement: string;
  subject: string;
  kind: string;
  actor: string | null;
  reason: string;
  confidence: number | null;
  createdAt: string;
}

export async function listClaimMerges(store: Store, limit = 200): Promise<ClaimMergeRow[]> {
  // the representative a claim points at now (a later merge may have moved its group)
  const rows = await store.query<{
    id: string; claim_id: string; statement: string; canonical_id: string; canonical_statement: string; subject: string;
    kind: string; actor: string | null; reason: string; confidence: number | null; created_at: string | Date;
  }>(
    `SELECT l.id, l.claim_id, m.statement, c.id AS canonical_id, c.statement AS canonical_statement, e.name AS subject,
            l.kind, l.actor, l.reason, l.confidence, l.created_at
     FROM claim_links l
     JOIN claims m ON m.id = l.claim_id
     JOIN claims c ON c.id = COALESCE(m.canonical_id, l.canonical_id)
     JOIN entities e ON e.id = c.subject_id
     WHERE l.tx_to IS NULL ORDER BY l.created_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id, claimId: r.claim_id, statement: r.statement, canonicalId: r.canonical_id, canonicalStatement: r.canonical_statement,
    subject: r.subject, kind: r.kind, actor: r.actor, reason: r.reason, confidence: r.confidence,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}

/**
 * A representative whose own sources are gone while its members remain is
 * replaced by the member with the most evidence: the others re-link to it and
 * the old representative, now without evidence of its own or members, folds
 * away. Run by the nightly audit.
 */
export async function reanchorClaimGroups(store: Store, opts: { actor?: string; onProgress?: (msg: string) => void } = {}): Promise<number> {
  const actor = opts.actor ?? 'claim-dedupe';
  const orphans = await store.query<{ id: string }>(
    `SELECT r.id FROM claims r
     WHERE r.canonical_id IS NULL
       AND EXISTS (SELECT 1 FROM claims m WHERE m.canonical_id = r.id AND m.tx_to IS NULL)
       AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.kind = 'claim' AND e.target_id = r.id AND e.tx_to IS NULL)`,
  );
  let moved = 0;
  for (const { id } of orphans) {
    const members = await store.query<{ id: string; n: number }>(
      `SELECT m.id, (SELECT count(*)::int FROM evidence e WHERE e.kind = 'claim' AND e.target_id = m.id AND e.tx_to IS NULL) AS n
       FROM claims m WHERE m.canonical_id = $1 AND m.tx_to IS NULL ORDER BY n DESC, m.tx_from ASC, m.id ASC`,
      [id],
    );
    if (members.length === 0) continue;
    const next = members[0].id;
    try {
      for (const m of members) await unmergeClaim(store, m.id, { actor });
      for (const m of members.slice(1)) {
        await applyClaimMerge(store, { claimId: m.id, canonicalId: next, reason: `re-anchored: ${id} lost its sources`, actor });
      }
      moved++;
      opts.onProgress?.(`claims: group of ${id} re-anchored on ${next}`);
    } catch (err) {
      opts.onProgress?.(`claims: re-anchoring ${id} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return moved;
}
