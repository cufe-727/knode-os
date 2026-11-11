import crypto from 'node:crypto';
import { KnodeConfig } from '../config.js';
import { appendLog } from '../fs/datadir.js';
import { auditDuplicateClaims } from '../graph/claim-dedupe.js';
import { auditDuplicateEntities } from '../graph/dedupe.js';
import { refreshRecommendations } from '../research/recommend.js';
import { reviewClaims } from '../graph/claim-review.js';
import { createEmbeddingProvider, EmbeddingProvider } from '../ingest/embeddings.js';
import { writeDeps } from '../lineage/deps.js';
import { LlmClient } from '../llm/client.js';
import { CLAIM_TYPES } from '../graph/store.js';
import { alikeWording, wordingOf } from '../graph/wording.js';
import { Store } from '../store/db.js';
import { toDateString, toIso } from '../store/temporal.js';
import { refreshNavigationIfChanged } from './navigation.js';
import { ensureHotTopics, PagesContext, retireConceptClusterPages } from './pages.js';

/**
 * Tier-2 — the nightly pass over the whole graph: the zero-LLM claim audit,
 * the full duplicate-entity audit (the backstop to the incremental one after
 * every tier-1 pass), the disputed-claim review, the "hot topics" region of
 * wiki/index.md and the research recommendations.
 *
 * It used to summarize hot communities into wiki/concepts/*-cluster.md pages
 * itself. Hot communities only become `concept` research suggestions now
 * (`refreshRecommendations`), and research writes the page with sources and
 * review (docs/design/09); the old cluster pages are archived here.
 */

export interface Tier2Stats {
  /** Concept-cluster pages from before docs/design/09, archived this run. */
  retiredPages: number;
  claimIssues: number;
  /** Duplicate-entity pairs queued as merge suggestions. */
  mergeCandidates: number;
  /** Pages recommended for research (filed as wiki suggestions). */
  recommendations: number;
  /** Disputed / suspected claims reviewed by the LLM (review.claims). */
  claimReviews: number;
  /** Duplicate claims merged into a representative (review.claimMerge). */
  claimsMerged: number;
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

/** Tier-2 entry point: claim audit, full duplicate audit, claim review, hot topics, recommendations. `llm` is the Judge stage. */
export async function refineWiki(
  store: Store,
  config: KnodeConfig,
  llm: LlmClient,
  opts: { onProgress?: (msg: string) => void; embedder?: EmbeddingProvider } = {},
): Promise<Tier2Stats> {
  const progress = opts.onProgress ?? (() => {});
  const stats: Tier2Stats = { retiredPages: 0, claimIssues: 0, mergeCandidates: 0, recommendations: 0, claimReviews: 0, claimsMerged: 0 };
  const ctx: PagesContext = {
    store,
    dataDir: store.dataDir,
    config,
    llm,
    embedder: opts.embedder ?? createEmbeddingProvider(config.embedding),
  };

  // entities first (claims are compared per canonical subject), then claims,
  // then the audit over what is left: one fact in several wordings is one claim by then
  try {
    stats.mergeCandidates = (await auditDuplicateEntities({ store, embedder: ctx.embedder, config, llm }, { onProgress: progress })).suggested;
  } catch (err) {
    progress(`dedupe audit failed: ${err instanceof Error ? err.message : err}`);
  }
  try {
    const merged = await auditDuplicateClaims({ store, embedder: ctx.embedder, config, llm }, { onProgress: progress });
    stats.claimsMerged = merged.merged;
  } catch (err) {
    progress(`claim merge failed: ${err instanceof Error ? err.message : err}`);
  }
  stats.claimIssues = await auditClaims(store, progress, { nearDuplicates: (config.review?.claimMerge ?? 'auto') === 'off' });
  try {
    stats.claimReviews = (await reviewClaims({ store, llm, config }, { onProgress: progress })).suggested;
  } catch (err) {
    progress(`claim review failed: ${err instanceof Error ? err.message : err}`);
  }

  try {
    const retired = await retireConceptClusterPages(ctx, { actor: 'tier2' });
    stats.retiredPages = retired.length;
    if (retired.length > 0) progress(`tier2: archived ${retired.length} concept-cluster page(s) — concept pages come from research now`);
  } catch (err) {
    progress(`retiring cluster pages failed: ${err instanceof Error ? err.message : err}`);
  }

  await ensureHotTopics(ctx, { actor: 'tier2', force: true });
  try {
    await refreshNavigationIfChanged(ctx, { actor: 'tier2' });
  } catch (err) {
    progress(`navigation failed: ${err instanceof Error ? err.message : err}`);
  }
  try {
    stats.recommendations = (await refreshRecommendations({ ...ctx, datasources: ctx.datasources! } as never)).suggested;
  } catch (err) {
    progress(`recommendations failed: ${err instanceof Error ? err.message : err}`);
  }
  if (stats.retiredPages > 0) {
    appendLog(store.dataDir, 'tier2', `${stats.retiredPages} concept-cluster pages archived; hot communities are research suggestions now`);
  }
  return stats;
}

/**
 * Zero-LLM claim audit over live facts (kind = fact; views, forecasts and
 * rumours are neither stale nor contradicted): flag contradictions (same
 * subject + type + object with clashing status, or near-duplicate statements
 * from different sources) and expired facts (valid_to in the past). Findings become
 * suggestions (kind 'knowledge') that declare the claims they depend on, so a
 * claim that disappears marks its suggestion stale instead of leaving it
 * dangling.
 */
/**
 * Supersession: among facts (kind = fact) of one subject, type and object, for
 * the measure-like types (CLAIM_TYPES.supersedes), an older one whose window
 * ended by the time a newer one began (or never closed) is marked superseded
 * by it. A forecast never supersedes the result it foresaw and is never
 * superseded; a management or event fact is never "replaced" by a later one.
 * System-maintained, not evidence — the old fact stays for history and
 * timelines but stops being quoted as current. Marks whose superseder is gone
 * are cleared.
 */
export async function markSupersededClaims(store: Store): Promise<number> {
  const rows = await store.query<{ id: string; subject_id: string; type: string; object_id: string | null; valid_from: string | Date; valid_to: string | Date | null; superseded_by: string | null }>(
    `SELECT id, subject_id, type, object_id, valid_from, valid_to, superseded_by FROM claims
     WHERE tx_to IS NULL AND canonical_id IS NULL AND status = 'fact' AND kind = 'fact' AND valid_from IS NOT NULL
       AND type = ANY($1::text[])
     ORDER BY subject_id, type, object_id, valid_from ASC, tx_from ASC`,
    [CLAIM_TYPES.filter((t) => t.supersedes).map((t) => t.id)],
  );
  // with a closed type list "same subject and type" is coarse, so only the
  // measure-like types take part (CLAIM_TYPES.supersedes: a later period of
  // earnings, a later holding of the same stock …) and the object is part of
  // the key; views, forecasts and rumours are never current facts
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.subject_id}|${r.type}|${r.object_id ?? ''}`;
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

/**
 * `nearDuplicates`: also flag similar statements from different sources —
 * only while duplicate-claim merging is off; otherwise the Judge's verdicts
 * (merge, or a contradiction suggestion) already covered those pairs.
 */
async function auditClaims(store: Store, progress: (msg: string) => void, opts: { nearDuplicates: boolean }): Promise<number> {
  const superseded = await markSupersededClaims(store);
  if (superseded) progress(`claim audit: ${superseded} supersession marks updated`);
  const rows = await store.query<{
    id: string; subject_id: string; subject: string; type: string; object_id: string | null; statement: string;
    status: string; kind: string; valid_to: string | null; primary_scope_id: string | null; path: string | null;
  }>(
    `SELECT cl.id, cl.subject_id, e.name AS subject, cl.type, cl.object_id, cl.statement, cl.status, cl.kind,
            cl.valid_to, cl.primary_scope_id, s.key AS path
     FROM claims cl
     JOIN entities e ON e.id = cl.subject_id
     LEFT JOIN scopes s ON s.id = cl.primary_scope_id
     WHERE cl.tx_to IS NULL AND cl.canonical_id IS NULL AND e.tx_to IS NULL`,
  );
  if (rows.length === 0) return 0;

  const issues: { title: string; body: string; evidence: string[]; claims: string[] }[] = [];
  const today = new Date().toISOString().slice(0, 10);

  // expired facts (a forecast whose window closed is not a stale fact)
  for (const c of rows) {
    const validTo = toDateString(c.valid_to);
    if (c.status === 'fact' && c.kind === 'fact' && validTo && validTo < today) {
      issues.push({
        title: `断言可能已过期: ${c.subject}`,
        body: `"${c.statement}" 的有效期至 ${validTo}，已过期。建议核实并更新相关文档/wiki 页。`,
        evidence: [c.path ?? '', c.statement].filter(Boolean),
        claims: [c.id],
      });
    }
  }

  // contradictions within (subject, type, object) groups of facts — views and forecasts contradict nothing
  const groups = new Map<string, typeof rows>();
  for (const c of rows) {
    if (c.kind !== 'fact') continue;
    const key = `${c.subject_id}|${c.type}|${c.object_id ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
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
    if (!opts.nearDuplicates) continue;
    const wordings = group.map((c) => wordingOf(c.statement));
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (!a.primary_scope_id || a.primary_scope_id === b.primary_scope_id || a.statement === b.statement) continue;
        if (alikeWording(wordings[i], wordings[j]) !== null) {
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
