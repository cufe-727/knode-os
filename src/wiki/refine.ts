import crypto from 'node:crypto';
import { KnodeConfig } from '../config.js';
import { appendLog } from '../fs/datadir.js';
import { auditDuplicateClaims } from '../graph/claim-dedupe.js';
import { backfillClaimState, refreshAttributeKeys, seriesSubjects, supersedeByAttribute } from '../graph/claim-state-store.js';
import { resolveEntityContext } from '../graph/entity-context.js';
import { auditDuplicateEntities } from '../graph/dedupe.js';
import { refreshRecommendations } from '../research/recommend.js';
import { reviewClaims } from '../graph/claim-review.js';
import { createEmbeddingProvider, EmbeddingProvider } from '../ingest/embeddings.js';
import { writeDeps } from '../lineage/deps.js';
import { LlmClient } from '../llm/client.js';
import { breather } from '../pool.js';
import { CLAIM_TYPES } from '../graph/store.js';
import { alikeWording, wordingOf } from '../graph/wording.js';
import { Store } from '../store/db.js';
import { groupBy, toDateString } from '../store/temporal.js';
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
  /** Entities merged on rename or alias evidence (src/graph/entity-context.ts). */
  entityMerges?: number;
  /** Namesakes split off by context (src/graph/entity-context.ts). */
  entitySplits?: number;
  /** Claims whose state (attribute, value, effective date) was read this run (docs/design/29). */
  claimStateRead?: number;
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
    const resolved = await resolveEntityContext(store, { config, onProgress: progress });
    stats.entityMerges = resolved.merged;
    stats.entitySplits = resolved.split;
  } catch (err) {
    progress(`entity resolution failed: ${err instanceof Error ? err.message : err}`);
  }
  try {
    stats.mergeCandidates = (await auditDuplicateEntities({ store, embedder: ctx.embedder, config, llm }, { onProgress: progress })).suggested;
  } catch (err) {
    progress(`dedupe audit failed: ${err instanceof Error ? err.message : err}`);
  }
  // claim state before the claim audits: the duplicate audit settles a series by its attribute
  try {
    const state = await backfillClaimState(store);
    const keys = await refreshAttributeKeys(store);
    stats.claimStateRead = state;
    if (state || keys.mapped || keys.dropped) progress(`claim state: ${state} claims read, ${keys.mapped} attribute keys unified, ${keys.dropped} dropped`);
  } catch (err) {
    progress(`claim state failed: ${err instanceof Error ? err.message : err}`);
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
 * Supersession. A claim that gives the value of an attribute (docs/design/29)
 * takes part in its attribute's series, in every domain: the newest by
 * effective date is current, the rest are history, and a correction replaces
 * the report it corrects (src/graph/claim-state-store.ts supersedeByAttribute).
 *
 * A claim no attribute was read from keeps the older rule: among facts
 * (kind = fact) of one subject, type and object, for the measure-like types
 * (CLAIM_TYPES.supersedes), an older one whose window ended by the time a
 * newer one began (or never closed) is marked superseded by it. A forecast
 * never supersedes the result it foresaw and is never superseded; a
 * management or event fact is never "replaced" by a later one.
 * System-maintained, not evidence — the old fact stays for history and
 * timelines but stops being quoted as current. Marks whose superseder is gone
 * are cleared.
 *
 * With `subjects` (whole merged groups, `seriesSubjects`), only the series of
 * those subjects: what a document pass runs for the subjects it wrote claims
 * of (`supersedeForClaims`).
 */
export async function markSupersededClaims(store: Store, opts: { subjects?: string[] } = {}): Promise<number> {
  const { subjects } = opts;
  if (subjects && subjects.length === 0) return 0;
  const byAttribute = await supersedeByAttribute(store, { subjects });
  // with a closed type list "same subject and type" is coarse, so only the
  // measure-like types take part (CLAIM_TYPES.supersedes: a later period of
  // earnings, a later holding of the same stock …) and the object is part of
  // the key; views, forecasts and rumours are never current facts.
  // Worked out in the database, each claim against the next of its series: they
  // used to be read into the server (finance, 2026-11-13: 53,007 claims) and
  // marked with a statement each (1,290 that night).
  const [marked] = await store.query<{ n: number }>(
    `WITH series AS (
       SELECT id, valid_from, valid_to,
              lead(id) OVER w AS newer_id, lead(valid_from) OVER w AS newer_from
       FROM claims
       WHERE tx_to IS NULL AND canonical_id IS NULL AND status = 'fact' AND kind = 'fact' AND valid_from IS NOT NULL
         AND attribute IS NULL AND type = ANY($1::text[])${subjects ? ' AND subject_id = ANY($2::text[])' : ''}
       WINDOW w AS (PARTITION BY subject_id, type, object_id ORDER BY valid_from ASC, tx_from ASC, id ASC)
     ), marks AS (
       UPDATE claims c SET superseded_by = s.newer_id
       FROM series s
       WHERE c.id = s.id AND s.newer_id IS NOT NULL
         AND s.valid_from < s.newer_from AND (s.valid_to IS NULL OR s.valid_to <= s.newer_from)
         AND c.superseded_by IS DISTINCT FROM s.newer_id
       RETURNING 1
     )
     SELECT count(*)::int AS n FROM marks`,
    [CLAIM_TYPES.filter((t) => t.supersedes).map((t) => t.id), ...(subjects ? [subjects] : [])],
  );
  const [cleared] = await store.query<{ n: number }>(
    `WITH gone AS (
       UPDATE claims c SET superseded_by = NULL
       WHERE superseded_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM claims n WHERE n.id = c.superseded_by AND n.tx_to IS NULL)${subjects ? ' AND c.subject_id = ANY($1::text[])' : ''}
       RETURNING 1
     )
     SELECT count(*)::int AS n FROM gone`,
    subjects ? [subjects] : [],
  );
  return byAttribute + marked.n + cleared.n;
}

/**
 * What is current among the subjects of `claims`, the claims a document pass
 * just wrote: those subjects' attribute keys are unified again (a new report
 * may word an attribute another way: 完成度, 进度), then supersession runs over
 * their series. Refine did this alone, once a night over every claim, so
 * between two refines each new report's value stood as current beside the
 * ones before it: five current values of a team's weekly metric after four
 * update batches on the 2026-11 separation benchmark.
 */
export async function supersedeForClaims(store: Store, claims: string[]): Promise<{ subjects: number; keys: number; superseded: number }> {
  const subjects = await seriesSubjects(store, claims);
  if (subjects.length === 0) return { subjects: 0, keys: 0, superseded: 0 };
  const keys = await refreshAttributeKeys(store, { subjects });
  const superseded = await markSupersededClaims(store, { subjects });
  return { subjects: subjects.length, keys: keys.mapped + keys.dropped, superseded };
}

/** Findings the claim audit files a night; the rest are only counted. */
const AUDIT_FILED = 20;
/** Claims the near-duplicate check reads at a time (and the subject the page ends in). */
const AUDIT_PAGE = 20_000;

interface AuditIssue {
  title: string;
  body: string;
  evidence: string[];
  claims: string[];
}

interface AuditClaim {
  id: string;
  subject_id: string;
  subject: string;
  type: string;
  object_id: string | null;
  statement: string;
  status: string;
  primary_scope_id: string | null;
  path: string | null;
}

const AUDIT_FROM = `FROM claims cl
     JOIN entities e ON e.id = cl.subject_id
     LEFT JOIN scopes s ON s.id = cl.primary_scope_id
     WHERE cl.tx_to IS NULL AND cl.canonical_id IS NULL AND e.tx_to IS NULL`;

/**
 * Similar statements of one (subject, type, object) group of facts from
 * different sources: counted, and the first `room` of them kept. Read a page
 * of claims at a time in subject order, a subject's claims held until the
 * subject ends, so the heap holds a page and one subject however many claims
 * there are. Groups whose statuses clash are the contradiction check's.
 */
async function nearDuplicateIssues(store: Store, room: number, pageSize: number): Promise<{ count: number; issues: AuditIssue[] }> {
  const issues: AuditIssue[] = [];
  let count = 0;
  const pause = breather();
  const compare = (claims: AuditClaim[]) => {
    for (const group of groupBy(claims, (c) => `${c.type}|${c.object_id ?? ''}`).values()) {
      if (group.length < 2) continue;
      if (group.some((c) => c.status === 'fact') && group.some((c) => c.status === 'disputed')) continue;
      const wordings = group.map((c) => wordingOf(c.statement));
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i], b = group[j];
          if (!a.primary_scope_id || a.primary_scope_id === b.primary_scope_id || a.statement === b.statement) continue;
          if (alikeWording(wordings[i], wordings[j]) === null) continue;
          count++;
          if (issues.length < room) {
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
  };
  let subject: AuditClaim[] = [];
  let after: [string, string] = ['', ''];
  for (;;) {
    await pause();
    const page = await store.query<AuditClaim>(
      `SELECT cl.id, cl.subject_id, e.name AS subject, cl.type, cl.object_id, cl.statement, cl.status, cl.primary_scope_id, s.key AS path
       ${AUDIT_FROM} AND cl.kind = 'fact' AND (cl.subject_id, cl.id) > ($1, $2)
       ORDER BY cl.subject_id, cl.id LIMIT $3`,
      [after[0], after[1], pageSize],
    );
    for (const c of page) {
      if (subject.length > 0 && subject[0].subject_id !== c.subject_id) {
        compare(subject);
        subject = [];
      }
      subject.push(c);
    }
    if (page.length < pageSize) break;
    after = [page[page.length - 1].subject_id, page[page.length - 1].id];
  }
  compare(subject);
  return { count, issues };
}

/**
 * Zero-LLM claim audit over live facts (kind = fact; views, forecasts and
 * rumours are neither stale nor contradicted): flag contradictions (same
 * subject + type + object with clashing status, or near-duplicate statements
 * from different sources) and expired facts (valid_to in the past). Findings become
 * suggestions (kind 'knowledge') that declare the claims they depend on, so a
 * claim that disappears marks its suggestion stale instead of leaving it
 * dangling.
 *
 * `nearDuplicates`: also flag similar statements from different sources —
 * only while duplicate-claim merging is off; otherwise the Judge's verdicts
 * (merge, or a contradiction suggestion) already covered those pairs.
 *
 * The findings are counted in the database and only the AUDIT_FILED that are
 * filed are read, oldest claims first. Every live claim used to be read for
 * it, statement and source path included: on finance (2026-11-13: 1,105,684
 * claims, 70,302 findings) 0.9 GB of heap, for twenty suggestions.
 */
export async function auditClaims(store: Store, progress: (msg: string) => void, opts: { nearDuplicates: boolean; pageSize?: number }): Promise<number> {
  const superseded = await markSupersededClaims(store);
  if (superseded) progress(`claim audit: ${superseded} supersession marks updated`);

  const issues: AuditIssue[] = [];
  // a claim's date is its UTC day: expired once that day is before today's
  const today = new Date().toISOString().slice(0, 10);
  const startOfToday = `${today}T00:00:00.000Z`;

  // expired facts (a forecast whose window closed is not a stale fact)
  const expiredWhere = `${AUDIT_FROM} AND cl.status = 'fact' AND cl.kind = 'fact' AND cl.valid_to < $1::timestamptz`;
  const [expired] = await store.query<{ n: number }>(`SELECT count(*)::int AS n ${expiredWhere}`, [startOfToday]);
  if (expired.n > 0) {
    const rows = await store.query<{ id: string; subject: string; statement: string; valid_to: string | Date; path: string | null }>(
      `SELECT cl.id, e.name AS subject, cl.statement, cl.valid_to, s.key AS path ${expiredWhere} ORDER BY cl.tx_from, cl.id LIMIT $2`,
      [startOfToday, AUDIT_FILED],
    );
    for (const c of rows) {
      issues.push({
        title: `断言可能已过期: ${c.subject}`,
        body: `"${c.statement}" 的有效期至 ${toDateString(c.valid_to)}，已过期。建议核实并更新相关文档/wiki 页。`,
        evidence: [c.path ?? '', c.statement].filter(Boolean),
        claims: [c.id],
      });
    }
  }

  // contradictions within (subject, type, object) groups of facts — views and forecasts contradict nothing
  const clashing = `SELECT cl.subject_id, cl.type, cl.object_id ${AUDIT_FROM} AND cl.kind = 'fact' AND cl.status IN ('fact', 'disputed')
     GROUP BY cl.subject_id, cl.type, cl.object_id
     HAVING bool_or(cl.status = 'fact') AND bool_or(cl.status = 'disputed')`;
  const [clashes] = await store.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${clashing}) g`);
  if (clashes.n > 0 && issues.length < AUDIT_FILED) {
    const groups = await store.query<{ subject_id: string; type: string; object_id: string | null }>(
      `${clashing} ORDER BY cl.subject_id, cl.type, cl.object_id LIMIT $1`,
      [AUDIT_FILED - issues.length],
    );
    for (const g of groups) {
      const side = async (status: string) => (await store.query<{ id: string; subject: string; statement: string; path: string | null }>(
        `SELECT cl.id, e.name AS subject, cl.statement, s.key AS path ${AUDIT_FROM} AND cl.kind = 'fact' AND cl.status = $1
           AND cl.subject_id = $2 AND cl.type = $3 AND cl.object_id IS NOT DISTINCT FROM $4
         ORDER BY cl.tx_from, cl.id LIMIT 1`,
        [status, g.subject_id, g.type, g.object_id],
      ))[0];
      const fact = await side('fact');
      const disputed = await side('disputed');
      if (!fact || !disputed) continue;
      issues.push({
        title: `检测到矛盾的断言: ${fact.subject}`,
        body: `同一主体的 "${g.type}" 类断言状态冲突。\n- [fact] ${fact.statement} (${fact.path ?? '?'})\n- [disputed] ${disputed.statement} (${disputed.path ?? '?'})\n建议人工核实哪条为准。`,
        evidence: [fact.statement, disputed.statement],
        claims: [fact.id, disputed.id],
      });
    }
  }

  // near-duplicate statements from different sources — possible divergence
  let alike = 0;
  if (opts.nearDuplicates) {
    const near = await nearDuplicateIssues(store, AUDIT_FILED - issues.length, Math.max(1, opts.pageSize ?? AUDIT_PAGE));
    alike = near.count;
    issues.push(...near.issues);
  }

  for (const issue of issues.slice(0, AUDIT_FILED)) {
    const id = crypto.createHash('sha256').update(`knowledge|${issue.title}|${issue.evidence.join('|')}`).digest('hex').slice(0, 16);
    await store.query(
      `INSERT INTO suggestions (id, kind, title, body, evidence, status)
       VALUES ($1, 'knowledge', $2, $3, $4::jsonb, 'pending')
       ON CONFLICT (id) DO UPDATE SET status = CASE WHEN suggestions.status = 'stale' THEN 'pending' ELSE suggestions.status END`,
      [id, issue.title, issue.body, JSON.stringify(issue.evidence)],
    );
    await writeDeps(store, { kind: 'suggestion', id }, issue.claims.map((c) => ({ kind: 'claim' as const, id: c, required: true })));
  }
  const found = expired.n + clashes.n + alike;
  if (found > 0) progress(`claim audit: ${found} issues queued as suggestions`);
  return found;
}
