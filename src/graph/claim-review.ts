import crypto from 'node:crypto';
import { KnodeConfig } from '../config.js';
import { writeDeps } from '../lineage/deps.js';
import { LlmClient } from '../llm/client.js';
import { Store } from '../store/db.js';
import { toDateString } from '../store/temporal.js';

/**
 * LLM review of claims that the deterministic audit could only flag: open
 * disputes (a quarantined source contradicting a trusted claim) and claims
 * extracted as `suspected`. The reviewer reads both statements with their
 * source excerpts and says which holds, whether both can (different periods),
 * and what a maintainer should do. Verdicts are filed as `knowledge`
 * suggestions — the graph itself is never edited by a model's opinion.
 */

export interface ClaimVerdict {
  verdict: 'a' | 'b' | 'both' | 'neither' | 'unclear';
  confidence: number;
  reason: string;
  action: 'promote_source' | 'demote_source' | 'mark_disputed' | 'verify_externally' | 'none';
  model: string;
}

export interface ClaimReviewStats {
  reviewed: number;
  suggested: number;
  skipped: number;
}

interface ClaimDetail {
  id: string;
  subject: string;
  type: string;
  statement: string;
  status: string;
  kind: string;
  valid_from: string | Date | null;
  valid_to: string | Date | null;
  event_at: string | Date | null;
  source_path: string | null;
  trust: string | null;
  excerpt: string | null;
}

export function claimReviewId(claimId: string, againstId: string | null): string {
  return crypto.createHash('sha256').update(`claim-review|${claimId}|${againstId ?? ''}`).digest('hex').slice(0, 16);
}

async function detail(store: Store, id: string): Promise<ClaimDetail | null> {
  const [row] = await store.query<ClaimDetail>(
    `SELECT cl.id, e.name AS subject, cl.type, cl.statement, cl.status, cl.kind, cl.valid_from, cl.valid_to, cl.event_at,
            s.key AS source_path, s.trust, c.content AS excerpt
     FROM claims cl
     JOIN entities e ON e.id = cl.subject_id
     LEFT JOIN scopes s ON s.id = cl.primary_scope_id
     LEFT JOIN chunks c ON c.id = cl.chunk_id
     WHERE cl.id = $1 AND cl.tx_to IS NULL`,
    [id],
  );
  return row ?? null;
}

function describe(label: string, c: ClaimDetail): string {
  const when = [toDateString(c.event_at), toDateString(c.valid_from) && `${toDateString(c.valid_from)} ~ ${toDateString(c.valid_to) ?? ''}`].filter(Boolean).join(' / ');
  return [
    `Claim ${label}: "${c.statement}"`,
    `  subject: ${c.subject}; type: ${c.type}; kind: ${c.kind}; status: ${c.status}${when ? `; time: ${when}` : ''}`,
    `  source: ${c.source_path ?? 'unknown'} (${c.trust ?? 'unknown trust'})`,
    c.excerpt ? `  excerpt: ${c.excerpt.replace(/\s+/g, ' ').slice(0, 600)}` : '  excerpt: (none)',
  ].join('\n');
}

const SYSTEM = `You review factual claims extracted into a knowledge base. You are given one or two claims about the same subject with the source excerpts they were extracted from. Decide which claim the excerpts actually support.

Rules:
- Judge only from the excerpts and the claims' stated dates. Two claims that differ because they describe different periods can BOTH hold ("both").
- "a" / "b" = only that claim is supported; "neither" = the excerpts support neither; "unclear" = cannot tell.
- action: what a maintainer should do — promote_source (the quarantined source is right and should be trusted), demote_source, mark_disputed (leave both, flag), verify_externally (needs an outside check), none.
- confidence 0–1. Write the reason in the language of the claims (2–3 sentences).
Respond with JSON only: {"verdict":"a|b|both|neither|unclear","confidence":0.0,"reason":"…","action":"…"}`;

export async function reviewClaims(
  ctx: { store: Store; llm: LlmClient; config: KnodeConfig },
  opts: { onProgress?: (msg: string) => void; limit?: number } = {},
): Promise<ClaimReviewStats> {
  const { store, llm, config } = ctx;
  const progress = opts.onProgress ?? (() => {});
  const stats: ClaimReviewStats = { reviewed: 0, suggested: 0, skipped: 0 };
  if (config.review?.claims === 'off' || !llm.enabled) return stats;
  const limit = opts.limit ?? 20;

  const pairs: { claimId: string; againstId: string | null; disputeId: string | null }[] = [];
  for (const d of await store.query<{ id: string; claim_id: string; against_id: string | null }>(
    `SELECT id, claim_id, against_id FROM disputes WHERE status = 'open' ORDER BY created_at DESC LIMIT $1`, [limit],
  )) pairs.push({ claimId: d.claim_id, againstId: d.against_id, disputeId: d.id });
  for (const c of await store.query<{ id: string }>(
    // a hedged view or forecast cannot be verified against its excerpt: only hedged facts queue
    `SELECT id FROM claims WHERE status = 'suspected' AND kind = 'fact' AND tx_to IS NULL AND canonical_id IS NULL AND superseded_by IS NULL ORDER BY tx_from DESC LIMIT $1`, [limit],
  )) pairs.push({ claimId: c.id, againstId: null, disputeId: null });

  for (const pair of pairs.slice(0, limit)) {
    const id = claimReviewId(pair.claimId, pair.againstId);
    const [existing] = await store.query<{ id: string }>(`SELECT id FROM suggestions WHERE id = $1`, [id]);
    if (existing) {
      stats.skipped++;
      continue;
    }
    const a = await detail(store, pair.claimId);
    const b = pair.againstId ? await detail(store, pair.againstId) : null;
    if (!a) continue;
    const user = [describe('A', a), b ? describe('B', b) : 'There is no claim B: judge whether the excerpt supports claim A.'].join('\n\n');
    let verdict: ClaimVerdict;
    try {
      const raw = await llm.completeJson<Partial<ClaimVerdict>>([{ role: 'system', content: SYSTEM }, { role: 'user', content: user }], { maxTokens: 400 });
      const v = typeof raw.verdict === 'string' && ['a', 'b', 'both', 'neither', 'unclear'].includes(raw.verdict) ? raw.verdict : 'unclear';
      const action = typeof raw.action === 'string' && ['promote_source', 'demote_source', 'mark_disputed', 'verify_externally', 'none'].includes(raw.action) ? raw.action : 'none';
      verdict = { verdict: v, confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)), reason: String(raw.reason ?? '').slice(0, 800), action, model: llm.label } as ClaimVerdict;
    } catch (err) {
      progress(`claim review failed for ${pair.claimId}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    stats.reviewed++;

    const label = { a: '支持 A', b: '支持 B', both: '两者可同时成立（不同时期）', neither: '两者都缺乏依据', unclear: '无法判断' }[verdict.verdict];
    const actionLabel = { promote_source: '提升来源为可信（knode_trust / Wiki 页 promote）', demote_source: '降级来源', mark_disputed: '保留争议标记', verify_externally: '需要外部核实（可排一个 verify 研究任务）', none: '无需操作' }[verdict.action];
    const title = `断言复核: ${a.subject} · ${a.type}`;
    const body = [
      `- A: ${a.statement}（${a.source_path ?? '?'}，${a.trust ?? '?'}）`,
      b ? `- B: ${b.statement}（${b.source_path ?? '?'}，${b.trust ?? '?'}）` : null,
      `- LLM 判定：${label}（置信 ${verdict.confidence.toFixed(2)}，${verdict.model}）`,
      `- 理由：${verdict.reason}`,
      `- 建议动作：${actionLabel}`,
    ].filter(Boolean).join('\n');
    await store.query(
      `INSERT INTO suggestions (id, kind, title, body, evidence, status, payload)
       VALUES ($1, 'knowledge', $2, $3, $4::jsonb, 'pending', $5::jsonb) ON CONFLICT (id) DO NOTHING`,
      [id, title, body, JSON.stringify([a.statement, b?.statement].filter(Boolean)), JSON.stringify({ kind: 'claim-review', claimId: a.id, againstId: b?.id ?? null, disputeId: pair.disputeId, verdict })],
    );
    await writeDeps(store, { kind: 'suggestion', id }, [{ kind: 'claim', id: a.id, required: true }, ...(b ? [{ kind: 'claim' as const, id: b.id, required: true }] : [])]);
    stats.suggested++;
  }
  if (stats.reviewed) progress(`claim review: ${stats.reviewed} reviewed, ${stats.suggested} verdicts filed`);
  return stats;
}
