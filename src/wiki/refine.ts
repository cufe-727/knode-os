import crypto from 'node:crypto';
import { KnodeConfig } from '../config.js';
import { appendLog } from '../fs/datadir.js';
import { auditDuplicateEntities } from '../graph/dedupe.js';
import { refreshRecommendations } from '../research/recommend.js';
import { reviewClaims } from '../graph/claim-review.js';
import { slugify } from '../graph/store.js';
import { createEmbeddingProvider, EmbeddingProvider } from '../ingest/embeddings.js';
import { writeDeps } from '../lineage/deps.js';
import { LlmClient } from '../llm/client.js';
import { Store } from '../store/db.js';
import { toDateString, toIso } from '../store/temporal.js';
import { ensureHotTopics, hotEntities, HotEntity, PagesContext, regeneratePage } from './pages.js';

/**
 * Tier-2 — nightly hot-subgraph refinement. The expensive, GraphRAG-style
 * community summarization, but only over the subgraph induced by the hottest
 * entities (never whole-graph Leiden): community summaries become wiki concept
 * pages (views with the anchor entity as a required input), and wiki/index.md
 * gets a maintained "hot topics" region. Cold regions of the graph stay at
 * tier-0/1 quality, which is the point.
 */

export interface Tier2Stats {
  communities: number;
  pagesWritten: number;
  claimIssues: number;
  /** Duplicate-entity pairs queued as merge suggestions. */
  mergeCandidates: number;
  /** Pages recommended for research (filed as wiki suggestions). */
  recommendations: number;
  /** Disputed / suspected claims reviewed by the LLM (review.claims). */
  claimReviews: number;
}

/**
 * Weighted label propagation over the induced subgraph — a deliberately simple
 * community detector (full Leiden is overkill for a top-K induced subgraph).
 */
export function detectCommunities(
  nodeIds: string[],
  edges: { source: string; target: string; weight: number }[],
): Map<string, string[]> {
  const label = new Map<string, string>(nodeIds.map((id) => [id, id]));
  const neighbors = new Map<string, { id: string; w: number }[]>();
  for (const e of edges) {
    if (!label.has(e.source) || !label.has(e.target)) continue;
    (neighbors.get(e.source) ?? neighbors.set(e.source, []).get(e.source)!).push({ id: e.target, w: e.weight });
    (neighbors.get(e.target) ?? neighbors.set(e.target, []).get(e.target)!).push({ id: e.source, w: e.weight });
  }
  for (let iter = 0; iter < 10; iter++) {
    let changed = 0;
    for (const id of nodeIds) {
      const ns = neighbors.get(id);
      if (!ns || ns.length === 0) continue;
      const votes = new Map<string, number>();
      for (const n of ns) {
        const l = label.get(n.id)!;
        votes.set(l, (votes.get(l) ?? 0) + n.w);
      }
      const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
      if (best && best[0] !== label.get(id)) {
        label.set(id, best[0]);
        changed++;
      }
    }
    if (changed === 0) break;
  }
  const groups = new Map<string, string[]>();
  for (const [id, l] of label) {
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l)!.push(id);
  }
  return groups;
}

/** Tier-2 refinement entry point (community pages + claim audit + hot topics). */
export async function refineWiki(
  store: Store,
  config: KnodeConfig,
  llm: LlmClient,
  opts: { onProgress?: (msg: string) => void; topEntities?: number; maxCommunities?: number; embedder?: EmbeddingProvider } = {},
): Promise<Tier2Stats> {
  const progress = opts.onProgress ?? (() => {});
  const stats: Tier2Stats = { communities: 0, pagesWritten: 0, claimIssues: 0, mergeCandidates: 0, recommendations: 0, claimReviews: 0 };
  const ctx: PagesContext = {
    store,
    dataDir: store.dataDir,
    config,
    llm,
    embedder: opts.embedder ?? createEmbeddingProvider(config.embedding),
  };

  stats.claimIssues = await auditClaims(store, progress);
  try {
    stats.mergeCandidates = (await auditDuplicateEntities({ store, embedder: ctx.embedder, config, llm }, { onProgress: progress })).suggested;
  } catch (err) {
    progress(`dedupe audit failed: ${err instanceof Error ? err.message : err}`);
  }
  try {
    stats.claimReviews = (await reviewClaims({ store, llm, config }, { onProgress: progress })).suggested;
  } catch (err) {
    progress(`claim review failed: ${err instanceof Error ? err.message : err}`);
  }

  const ents = await hotEntities(store, opts.topEntities ?? 60);
  if (ents.length < 3) {
    await ensureHotTopics(ctx, { actor: 'tier2', force: true });
    return stats;
  }
  const byId = new Map(ents.map((e) => [e.id, e]));
  const ids = ents.map((e) => e.id);
  const ph = ids.map((_, i) => `$${i + 1}`).join(',');
  const rels = await store.query<{ source_id: string; target_id: string; weight: number }>(
    `SELECT source_id, target_id, weight FROM relations
     WHERE source_id IN (${ph}) AND target_id IN (${ph}) AND tx_to IS NULL`,
    ids,
  );

  const groups = [...detectCommunities(ids, rels.map((r) => ({ source: r.source_id, target: r.target_id, weight: r.weight }))).values()]
    .filter((g) => g.length >= 3)
    .sort((a, b) => heatOf(b, byId) - heatOf(a, byId))
    .slice(0, opts.maxCommunities ?? 5);
  stats.communities = groups.length;

  for (const group of groups) {
    const members = group.map((id) => byId.get(id)!).sort((a, b) => b.mention_count - a.mention_count);
    const anchor = members[0];
    const pagePath = `wiki/concepts/${slugify(anchor.name)}-cluster.md`;
    try {
      progress(`tier2 community summary: ${anchor.name} (${members.length} entities)`);
      const r = await regeneratePage(ctx, pagePath, 'concept_cluster', {
        actor: 'tier2',
        hint: { anchor: anchor.id, members: members.map((m) => m.id) },
      });
      if (r === 'regenerated') stats.pagesWritten++;
    } catch (err) {
      progress(`tier2 summary failed for ${anchor.name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  await ensureHotTopics(ctx, { actor: 'tier2', force: true });
  try {
    stats.recommendations = (await refreshRecommendations({ ...ctx, datasources: ctx.datasources! } as never)).suggested;
  } catch (err) {
    progress(`recommendations failed: ${err instanceof Error ? err.message : err}`);
  }
  if (stats.pagesWritten > 0) {
    appendLog(store.dataDir, 'tier2', `${stats.pagesWritten} community pages from ${stats.communities} hot communities`);
  }
  return stats;
}

/**
 * Zero-LLM claim audit over live claims: flag contradictions (same subject +
 * type with clashing status, or near-duplicate statements from different
 * sources) and expired facts (valid_to in the past). Findings become
 * suggestions (kind 'knowledge') that declare the claims they depend on, so a
 * claim that disappears marks its suggestion stale instead of leaving it
 * dangling.
 */
/**
 * Supersession: among facts of one subject and type, an older one whose window
 * ended by the time a newer one began (or never closed) is marked superseded
 * by it. System-maintained, not evidence — the old fact stays for history and
 * timelines but stops being quoted as current. Marks whose superseder is gone
 * are cleared.
 */
export async function markSupersededClaims(store: Store): Promise<number> {
  const rows = await store.query<{ id: string; subject_id: string; type: string; valid_from: string | Date; valid_to: string | Date | null; superseded_by: string | null }>(
    `SELECT id, subject_id, type, valid_from, valid_to, superseded_by FROM claims
     WHERE tx_to IS NULL AND status = 'fact' AND valid_from IS NOT NULL
     ORDER BY subject_id, type, valid_from ASC, tx_from ASC`,
  );
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.subject_id}|${r.type}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  let changed = 0;
  for (const group of groups.values()) {
    for (let i = 0; i + 1 < group.length; i++) {
      const older = group[i];
      const newer = group[i + 1];
      const olderFrom = toIso(older.valid_from)!;
      const newerFrom = toIso(newer.valid_from)!;
      const olderTo = toIso(older.valid_to);
      if (olderFrom >= newerFrom || (olderTo && olderTo > newerFrom)) continue;
      if (older.superseded_by === newer.id) continue;
      await store.query(`UPDATE claims SET superseded_by = $2 WHERE id = $1`, [older.id, newer.id]);
      changed++;
    }
  }
  const cleared = await store.query<{ id: string }>(
    `UPDATE claims c SET superseded_by = NULL
     WHERE superseded_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM claims n WHERE n.id = c.superseded_by AND n.tx_to IS NULL)
     RETURNING id`,
  );
  return changed + cleared.length;
}

async function auditClaims(store: Store, progress: (msg: string) => void): Promise<number> {
  const superseded = await markSupersededClaims(store);
  if (superseded) progress(`claim audit: ${superseded} supersession marks updated`);
  const rows = await store.query<{
    id: string; subject_id: string; subject: string; type: string; statement: string;
    status: string; valid_to: string | null; primary_scope_id: string | null; path: string | null;
  }>(
    `SELECT cl.id, cl.subject_id, e.name AS subject, cl.type, cl.statement, cl.status,
            cl.valid_to, cl.primary_scope_id, s.key AS path
     FROM claims cl
     JOIN entities e ON e.id = cl.subject_id
     LEFT JOIN scopes s ON s.id = cl.primary_scope_id
     WHERE cl.tx_to IS NULL AND e.tx_to IS NULL`,
  );
  if (rows.length === 0) return 0;

  const issues: { title: string; body: string; evidence: string[]; claims: string[] }[] = [];
  const today = new Date().toISOString().slice(0, 10);

  // expired facts
  for (const c of rows) {
    const validTo = toDateString(c.valid_to);
    if (c.status === 'fact' && validTo && validTo < today) {
      issues.push({
        title: `断言可能已过期: ${c.subject}`,
        body: `"${c.statement}" 的有效期至 ${validTo}，已过期。建议核实并更新相关文档/wiki 页。`,
        evidence: [c.path ?? '', c.statement].filter(Boolean),
        claims: [c.id],
      });
    }
  }

  // contradictions within (subject, type) groups
  const groups = new Map<string, typeof rows>();
  for (const c of rows) {
    const key = `${c.subject_id}|${c.type}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  const tokenize = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2));
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const hasFact = group.some((c) => c.status === 'fact');
    const hasDisputed = group.some((c) => c.status === 'disputed');
    if (hasFact && hasDisputed) {
      const fact = group.find((c) => c.status === 'fact')!;
      const disputed = group.find((c) => c.status === 'disputed')!;
      issues.push({
        title: `检测到矛盾的断言: ${fact.subject}`,
        body: `同一主体的 "${fact.type}" 类断言状态冲突。\n- [fact] ${fact.statement} (${fact.path ?? '?'})\n- [disputed] ${disputed.statement} (${disputed.path ?? '?'})\n建议人工核实哪条为准。`,
        evidence: [fact.statement, disputed.statement],
        claims: [fact.id, disputed.id],
      });
      continue;
    }
    // near-duplicate statements from different sources — possible divergence
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (!a.primary_scope_id || a.primary_scope_id === b.primary_scope_id || a.statement === b.statement) continue;
        const ta = tokenize(a.statement), tb = tokenize(b.statement);
        const inter = [...ta].filter((t) => tb.has(t)).length;
        const overlap = inter / Math.max(1, Math.min(ta.size, tb.size));
        if (overlap >= 0.6) {
          issues.push({
            title: `多来源相似断言待核对: ${a.subject}`,
            body: `不同文档对 "${a.subject}" 有相似但不一致的表述：\n- ${a.statement} (${a.path ?? '?'})\n- ${b.statement} (${b.path ?? '?'})\n可能是同一事实的不同版本，建议在 wiki 中统一。`,
            evidence: [a.statement, b.statement],
            claims: [a.id, b.id],
          });
        }
      }
    }
  }

  for (const issue of issues.slice(0, 20)) {
    const id = crypto.createHash('sha256').update(`knowledge|${issue.title}|${issue.evidence.join('|')}`).digest('hex').slice(0, 16);
    await store.query(
      `INSERT INTO suggestions (id, kind, title, body, evidence, status)
       VALUES ($1, 'knowledge', $2, $3, $4::jsonb, 'pending')
       ON CONFLICT (id) DO UPDATE SET status = CASE WHEN suggestions.status = 'stale' THEN 'pending' ELSE suggestions.status END`,
      [id, issue.title, issue.body, JSON.stringify(issue.evidence)],
    );
    await writeDeps(store, { kind: 'suggestion', id }, issue.claims.map((c) => ({ kind: 'claim' as const, id: c, required: true })));
  }
  if (issues.length > 0) progress(`claim audit: ${issues.length} issues queued as suggestions`);
  return issues.length;
}

function heatOf(group: string[], byId: Map<string, HotEntity>): number {
  return group.reduce((s, id) => s + (byId.get(id)?.heat ?? 0) + (byId.get(id)?.mention_count ?? 0) * 0.1, 0);
}
