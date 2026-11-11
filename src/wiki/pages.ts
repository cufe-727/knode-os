import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { KnodeConfig } from '../config.js';
import { summaryLlmClient } from '../context.js';
import { DataSourceRegistry } from '../datasource/registry.js';
import { QueryResult } from '../datasource/types.js';
import { safePath } from '../fs/files.js';
import { clearSourceSummaryFailure, readSourceSummary, readSourceSummaryFailure, recordSourceSummaryFailure } from '../fs/sidecar.js';
import { slugify } from '../graph/store.js';
import { applyDocScope } from '../ingest/apply.js';
import { EmbeddingProvider } from '../ingest/embeddings.js';
import { noteOwnWrite } from '../ingest/own-writes.js';
import { matchesPrefixes } from '../lineage/declared.js';
import { readDeps } from '../lineage/deps.js';
import { archivedPath, disposeScope, findLiveScope } from '../lineage/scope.js';
import { DepDecl } from '../lineage/types.js';
import { classifyFailure } from '../labeling/failures.js';
import { LlmClient } from '../llm/client.js';
import { applyScope } from '../lineage/scope.js';
import { readMatter, writeMatter } from '../markdown.js';
import { isGeneratedConcept, okfGenerated } from '../okf/index.js';
import { getDocHeat } from '../stats/heat.js';
import { Store } from '../store/db.js';
import { Params, toDateString, toIso } from '../store/temporal.js';
import { DocumentRow } from '../types.js';
import { hasRegions, renderRegion, replaceRegion, splitRegions } from './regions.js';
import { CORPUS_GENERATORS, CorpusPageKind } from './corpus-views.js';
import { asSummaryLanguage, detectSummaryLanguage, documentChars, isShortDocument, planSummary, produceSummary, shortByRow, summaryMinChars, summaryScaffold } from './summary.js';

/**
 * Wiki pages as materialized views.
 *
 * A generated page declares the graph inputs it was built from (`deps`),
 * carries a fingerprint of those inputs, and owns managed regions between
 * `<!-- knode:begin/end -->` markers. When an input's fold changes the page
 * is marked dirty and regenerated; when a *required* input is tombstoned the
 * page is archived under wiki/.archive/. Prose a human writes outside the
 * markers survives every regeneration — and is itself a knowledge source.
 *
 * Generators never emit graph evidence, and inputs are never other pages,
 * so regeneration cannot loop.
 */

/**
 * `concept_cluster` has no generator any more — concept pages are research's
 * job (docs/design/09) — but rows of that kind may still exist until
 * `retireConceptClusterPages` archives them.
 */
export type PageKind = 'entity_stub' | 'source_summary' | 'dataset' | 'sources_index' | 'entities_index' | 'hot_topics' | 'concept_cluster' | 'dream' | 'research_index' | CorpusPageKind;

export interface PagesContext {
  store: Store;
  dataDir: string;
  config: KnodeConfig;
  /** The Judge stage (`ctx.llm`). */
  llm: LlmClient;
  /** The Summarize stage; resolved from `config` when absent (`summaryLlmClient`). */
  summaryLlm?: LlmClient;
  embedder: EmbeddingProvider;
  datasources?: DataSourceRegistry;
}

export interface PagePlan {
  deps: DepDecl[];
  inputsSha: string;
  data: Record<string, unknown>;
}

export interface PageRender {
  frontmatter: Record<string, unknown>;
  regions: Record<string, string>;
}

export interface PageGenerator {
  kind: PageKind;
  version: number;
  llm: boolean;
  /** The model an `llm` generator writes with, when that is not `ctx.llm`. */
  client?(ctx: PagesContext): LlmClient;
  /** 'file' owns a whole page; 'region' owns one managed region inside a human file (path = file#region). */
  mode: 'file' | 'region';
  plan(ctx: PagesContext, pagePath: string, hint?: Record<string, unknown>): Promise<PagePlan | null>;
  /** null = deferred (LLM unavailable). */
  render(ctx: PagesContext, pagePath: string, plan: PagePlan): Promise<PageRender | null>;
}

export type RegenerateOutcome = 'regenerated' | 'unchanged' | 'archived' | 'deferred' | 'blocked';

export function splitPagePath(pagePath: string): { file: string; region: string | null } {
  const at = pagePath.indexOf('#');
  return at === -1 ? { file: pagePath, region: null } : { file: pagePath.slice(0, at), region: pagePath.slice(at + 1) };
}

function sha16(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function knodeMeta(view: PageKind, inputs: Record<string, string[]>): Record<string, unknown> {
  return { view, inputs };
}

/* ------------------------------ generators ------------------------------ */

/** Claims an entity page lists at most, newest first; past these it says how many there are and where to ask. */
export const ENTITY_PAGE_CLAIMS = 300;
/** Claims about other entities that name this one, and relations, listed at most. */
const ENTITY_PAGE_LINKED = 60;

interface PageClaim {
  id: string; statement: string; status: string; kind?: string; valid_from: string | null; valid_to: string | null;
  event_at?: string | null; superseded_by?: string | null; fold_sha?: string; path?: string | null;
}
interface PageMention extends PageClaim { subject: string; subject_page: string | null }
interface PageRelation { id: string; type: string; description: string; out: boolean; other: string; other_page: string | null; path: string | null }
interface PageConflict { a: string; a_path: string | null; b: string; b_path: string | null; reason: string }

/**
 * An entity's page: everything the knowledge base holds about it, each line
 * with the document it comes from.
 *
 * It is the one place where what many documents say about one thing stands
 * together, which no search over the documents assembles: its facts, the
 * views and forecasts about it, its dated history in order, what sources
 * disagree on, what claims about other entities say of it, and its
 * relations. Every line names its source, so a
 * reader can cite the document and open it. The page used to list the newest
 * thirty claims without sources: for a person with 119 claims from 53
 * documents it held a quarter of what was known and could not say where any
 * of it came from.
 */
const entityStub: PageGenerator = {
  kind: 'entity_stub',
  version: 5,
  llm: false,
  mode: 'file',
  async plan(ctx, pagePath) {
    const id = path.posix.basename(pagePath, '.md');
    const [e] = await ctx.store.query<{ id: string; name: string; type: string; description: string; aliases: string[]; fold_sha: string; canonical_id: string | null }>(
      `SELECT id, name, type, description, aliases, fold_sha, canonical_id FROM entities WHERE id = $1 AND tx_to IS NULL`,
      [id],
    );
    if (!e) return null;
    if (e.canonical_id) {
      // merged into another entity: the page becomes a redirect to the survivor
      const [c] = await ctx.store.query<{ id: string; name: string; fold_sha: string }>(`SELECT id, name, fold_sha FROM entities WHERE id = $1 AND tx_to IS NULL`, [e.canonical_id]);
      if (!c) return null;
      return {
        deps: [{ kind: 'entity', id, required: true, sha: e.fold_sha }, { kind: 'entity', id: c.id, sha: c.fold_sha }],
        inputsSha: sha16(['entity_stub@5', 'redirect', e.fold_sha, c.id]),
        data: { entity: e, claims: [], redirect: { id: c.id, name: c.name } },
      };
    }
    const claims = await ctx.store.query<PageClaim>(
      `SELECT cl.id, cl.statement, cl.status, cl.kind, cl.valid_from, cl.valid_to, cl.event_at, cl.superseded_by, cl.fold_sha, s.key AS path
       FROM claims cl LEFT JOIN scopes s ON s.id = cl.primary_scope_id
       WHERE cl.subject_id = $1 AND cl.tx_to IS NULL AND cl.canonical_id IS NULL
       ORDER BY COALESCE(cl.event_at, cl.valid_from) DESC NULLS LAST, cl.tx_from DESC, cl.id LIMIT $2`,
      [id, ENTITY_PAGE_CLAIMS],
    );
    const [{ n: total }] = await ctx.store.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM claims WHERE subject_id = $1 AND tx_to IS NULL AND canonical_id IS NULL`,
      [id],
    );
    const mentions = await ctx.store.query<PageMention>(
      `SELECT cl.id, cl.statement, cl.status, cl.kind, cl.valid_from, cl.valid_to, cl.event_at, cl.superseded_by, cl.fold_sha, s.key AS path,
              se.name AS subject, se.wiki_path AS subject_page
       FROM claims cl JOIN entities se ON se.id = cl.subject_id LEFT JOIN scopes s ON s.id = cl.primary_scope_id
       WHERE cl.object_id = $1 AND cl.subject_id <> $1 AND cl.tx_to IS NULL AND cl.canonical_id IS NULL AND cl.superseded_by IS NULL
       ORDER BY COALESCE(cl.event_at, cl.valid_from) DESC NULLS LAST, cl.tx_from DESC, cl.id LIMIT $2`,
      [id, ENTITY_PAGE_LINKED],
    );
    // a relation's source: its document, else the document its evidence came
    // from — tier 1 writes that evidence on a `tier1` scope keyed by the path
    const relations = await ctx.store.query<PageRelation & { fold_sha: string }>(
      `SELECT r.id, r.type, r.description, (r.source_id = $1) AS out, o.name AS other, o.wiki_path AS other_page, r.fold_sha,
              COALESCE(d.path, (
                SELECT s.key FROM evidence ev JOIN scopes s ON s.id = ev.scope_id
                WHERE ev.kind = 'relation' AND ev.target_id = r.id AND ev.tx_to IS NULL AND s.kind IN ('doc', 'tier1')
                ORDER BY ev.tx_from, s.key LIMIT 1)) AS path
       FROM relations r
       JOIN entities o ON o.id = CASE WHEN r.source_id = $1 THEN r.target_id ELSE r.source_id END
       LEFT JOIN documents d ON d.id = r.document_id
       WHERE (r.source_id = $1 OR r.target_id = $1) AND r.tx_to IS NULL AND r.type <> 'co_occurs'
       ORDER BY r.weight DESC, r.id LIMIT $2`,
      [id, ENTITY_PAGE_LINKED],
    );
    const ids = claims.map((c) => c.id);
    const conflicts = ids.length === 0 ? [] : await ctx.store.query<PageConflict>(
      `SELECT a.statement AS a, sa.key AS a_path, b.statement AS b, sb.key AS b_path, v.reason
       FROM claim_pair_verdicts v
       JOIN claims a ON a.id = v.a_id AND a.tx_to IS NULL
       JOIN claims b ON b.id = v.b_id AND b.tx_to IS NULL
       LEFT JOIN scopes sa ON sa.id = a.primary_scope_id LEFT JOIN scopes sb ON sb.id = b.primary_scope_id
       WHERE v.relation = 'conflict' AND (v.a_id = ANY($1::text[]) OR v.b_id = ANY($1::text[]))
       ORDER BY v.judged_at DESC, v.pair_id LIMIT 30`,
      [ids],
    );
    return {
      deps: [
        { kind: 'entity', id, required: true, sha: e.fold_sha },
        ...claims.map((c) => ({ kind: 'claim' as const, id: c.id, sha: c.fold_sha! })),
        ...mentions.map((c) => ({ kind: 'claim' as const, id: c.id, sha: c.fold_sha! })),
        ...relations.map((r) => ({ kind: 'relation' as const, id: r.id, sha: r.fold_sha })),
      ],
      inputsSha: sha16([
        'entity_stub@5', e.fold_sha, total,
        claims.map((c) => [c.fold_sha, c.superseded_by, c.path]),
        mentions.map((c) => [c.fold_sha, c.path, c.subject, c.subject_page]),
        relations.map((r) => [r.fold_sha, r.other, r.other_page, r.path]),
        conflicts.map((c) => [c.a, c.b, c.reason]),
      ]),
      data: { entity: e, claims, total, mentions, relations, conflicts },
    };
  },
  async render(_ctx, _pagePath, plan) {
    const e = plan.data.entity as { id: string; name: string; type: string; description: string; aliases: string[] };
    const claims = plan.data.claims as PageClaim[];
    const total = (plan.data.total as number | undefined) ?? claims.length;
    const mentions = (plan.data.mentions as PageMention[] | undefined) ?? [];
    const relations = (plan.data.relations as PageRelation[] | undefined) ?? [];
    const conflicts = (plan.data.conflicts as PageConflict[] | undefined) ?? [];
    const redirect = plan.data.redirect as { id: string; name: string } | undefined;
    const lines = redirect
      ? [`# ${e.name}`, '', `→ 已合并到 [[${redirect.name}]]（merged into; \`knode-os entities unmerge ${e.id}\` reverts it）`]
      : [`# ${e.name}`, '', e.description || '_No description yet — fill me in._'];
    const now = new Date().toISOString();
    const kindOf = (c: { kind?: string }) => c.kind ?? 'fact';
    const periodOf = (c: { valid_from: string | null; valid_to: string | null }) => {
      const from = toDateString(c.valid_from);
      const to = toDateString(c.valid_to);
      return from || to ? ` \`${from ?? '?'} ~ ${to ?? ''}\`` : '';
    };
    const from = (p?: string | null) => (p ? ` — ${p}` : '');
    const linked = (name: string, page: string | null) => (page ? `[[${name}]]` : name);
    const sources = new Map<string, number>();
    for (const c of claims) if (c.path) sources.set(c.path, (sources.get(c.path) ?? 0) + 1);
    if (!redirect && total > 0) {
      const docs = sources.size;
      lines.push('', total > claims.length
        ? `_${total} claims; the newest ${claims.length} are listed here from ${docs} ${docs === 1 ? 'document' : 'documents'} — \`knode_claims\` with subject "${e.name}" returns the rest._`
        : `_${total} ${total === 1 ? 'claim' : 'claims'} from ${docs} ${docs === 1 ? 'document' : 'documents'}._`);
    }
    // gbrain's split: the compiled truth (what holds now) above, the dated history below;
    // views, forecasts and rumours are not facts and get their own list, tagged by kind.
    // Something that happened on a day is history: it stands in the timeline alone.
    const happened = (c: PageClaim) => Boolean(toIso(c.event_at ?? null));
    const live = claims.filter((c) => !c.superseded_by && !(toIso(c.valid_to) && toIso(c.valid_to)! < now));
    const current = live.filter((c) => kindOf(c) === 'fact' && !happened(c));
    if (current.length > 0) {
      lines.push('', '## Facts (current)', '');
      for (const c of current) lines.push(`- ${c.statement} \`${c.status}\`${periodOf(c)}${from(c.path)}`);
    }
    const views = live.filter((c) => kindOf(c) !== 'fact' && !happened(c));
    if (views.length > 0) {
      lines.push('', '## Views and forecasts', '');
      for (const c of views) lines.push(`- ${c.statement} \`${kindOf(c)}\`${c.status === 'fact' ? '' : ` \`${c.status}\``}${periodOf(c)}${from(c.path)}`);
    }
    const dated = claims
      .filter((c) => toIso(c.event_at ?? null) || toIso(c.valid_from))
      .sort((a, b) => (toIso(a.event_at ?? null) ?? toIso(a.valid_from)!).localeCompare(toIso(b.event_at ?? null) ?? toIso(b.valid_from)!));
    if (dated.length > 0) {
      lines.push('', '## Timeline', '');
      for (const c of dated) {
        const when = toDateString(c.event_at ?? null) ?? toDateString(c.valid_from);
        lines.push(`- ${when} · ${c.statement} \`${c.status}\`${kindOf(c) === 'fact' ? '' : ` \`${kindOf(c)}\``}${c.superseded_by ? ' _(superseded)_' : ''}${from(c.path)}`);
      }
    }
    const disputed = claims.filter((c) => c.status === 'disputed');
    if (conflicts.length > 0 || disputed.length > 0) {
      lines.push('', '## Disagreements', '');
      for (const c of conflicts) lines.push(`- ${c.a}${from(c.a_path)} ⟷ ${c.b}${from(c.b_path)}${c.reason ? ` (${c.reason})` : ''}`);
      for (const c of disputed) lines.push(`- ${c.statement} \`disputed\`${from(c.path)}`);
    }
    if (mentions.length > 0) {
      lines.push('', '## In claims about others', '');
      for (const c of mentions) {
        const when = toDateString(c.event_at ?? null);
        lines.push(`- ${when ? `${when} · ` : ''}${linked(c.subject, c.subject_page)}: ${c.statement} \`${kindOf(c) === 'fact' ? c.status : kindOf(c)}\`${from(c.path)}`);
      }
    }
    if (relations.length > 0) {
      lines.push('', '## Relations', '');
      for (const r of relations) {
        const other = linked(r.other, r.other_page);
        const type = r.type.replace(/_/g, ' ');
        lines.push(`- ${r.out ? `${type} → ${other}` : `${other} → ${type}`}${r.description ? `: ${r.description}` : ''}${from(r.path)}`);
      }
    }
    return {
      frontmatter: {
        title: e.name,
        type: e.type,
        aliases: Array.isArray(e.aliases) ? e.aliases : [],
        generated: okfGenerated('knode-os/entity_stub'),
        // the claims and documents behind the page are its deps (`knode_lineage` lists them), and every
        // line names its source: three hundred ids here would be a fifth of the file
        knode: knodeMeta('entity_stub', { entities: [e.id] }),
      },
      regions: { body: lines.join('\n') },
    };
  },
};

/**
 * The Summarize stage's page (docs/design/14). What it asks a model and what
 * it makes of the answer lives in ./summary.ts, shared with the leased work
 * source (src/work/summarize.ts); the one-shot pass calls the model from
 * `render`, through `produceSummary`.
 */
const sourceSummary: PageGenerator = {
  kind: 'source_summary',
  version: 2,
  llm: true,
  client: (ctx) => documentSummaryLlm(ctx),
  mode: 'file',
  async plan(ctx, pagePath, hint) {
    let docPath = typeof hint?.documentPath === 'string' ? hint.documentPath : undefined;
    if (!docPath) {
      const deps = await readDeps(ctx.store, { kind: 'page', id: pagePath });
      docPath = deps.find((d) => d.input_kind === 'document')?.input_id;
    }
    if (!docPath) return null;
    const [doc] = await ctx.store.query<DocumentRow>(`SELECT * FROM documents WHERE path = $1 AND status = 'indexed'`, [docPath]);
    if (!doc) return null;
    // a document under the size threshold gets no page: one written before the
    // threshold is archived when its document next changes (`wiki prune-summaries` sweeps the rest)
    if (await isShortDocument(ctx.store, ctx.dataDir, doc, summaryMinChars(ctx.config))) return null;
    return {
      deps: [{ kind: 'document', id: doc.path, required: true, sha: doc.sha256 }],
      inputsSha: sha16(['source_summary@2', doc.sha256]),
      data: { doc },
    };
  },
  async render(ctx, _pagePath, plan) {
    const doc = plan.data.doc as DocumentRow;
    const llm = documentSummaryLlm(ctx);
    // generated.by/at describe the body we are about to write, so a cache hit
    // reports the model and instant that produced it, not this regeneration.
    let cached = readSourceSummary(ctx.dataDir, doc.path);
    if (!cached || cached.contentSha !== doc.sha256) {
      if (!llm.enabled) return null;
      const work = await planSummary(ctx.store, ctx.dataDir, ctx.config, doc);
      if (work.kind === 'none') return null;
      cached = await produceSummary(ctx.dataDir, work, llm);
    }
    // a cache from before the language was recorded is read for it
    const language = asSummaryLanguage(cached.language) ?? detectSummaryLanguage(cached.body);
    const heat = (await getDocHeat(ctx.store, [doc.id], ctx.config.heat)).get(doc.id) ?? 0;
    const title = doc.title ?? path.basename(doc.path);
    return {
      frontmatter: {
        title,
        type: 'source',
        description: summaryScaffold(language).description(doc.path),
        source: doc.path,
        heat: Number(heat.toFixed(3)),
        ...(cached.coverage ? { coverage: cached.coverage } : {}),
        generated: okfGenerated(`knode-os/${cached.model}`, cached.generatedAt),
        knode: knodeMeta('source_summary', { documents: [doc.path] }),
      },
      regions: { body: cached.body.trim() },
    };
  },
};

const dataset: PageGenerator = {
  kind: 'dataset',
  version: 2,
  llm: false,
  mode: 'file',
  async plan(ctx, pagePath) {
    const id = path.posix.basename(pagePath, '.md');
    const [d] = await ctx.store.query<{
      id: string; source_id: string; table_name: string; kind: string; columns: { name: string; type: string }[];
      row_count: number | null; schema_sha: string; description: string; refreshed_at: string | null;
    }>(`SELECT * FROM datasets WHERE id = $1 AND tx_to IS NULL`, [id]);
    if (!d) return null;
    const linked = await ctx.store.query<{ id: string; name: string; fold_sha: string }>(
      `SELECT e.id, e.name, e.fold_sha FROM relations r JOIN entities e ON e.id = r.source_id
       WHERE r.target_id = $1 AND r.type = 'appears_in' AND r.tx_to IS NULL AND e.tx_to IS NULL
       ORDER BY e.mention_count DESC, e.name LIMIT 50`,
      [id],
    );
    return {
      deps: [
        { kind: 'dataset', id, required: true, sha: d.schema_sha },
        ...linked.map((e) => ({ kind: 'entity' as const, id: e.id, sha: e.fold_sha })),
      ],
      inputsSha: sha16(['dataset@2', d.schema_sha, d.description, linked.map((e) => e.name)]),
      data: { dataset: d, linked },
    };
  },
  async render(ctx, _pagePath, plan) {
    const d = plan.data.dataset as {
      id: string; source_id: string; table_name: string; kind: string; columns: { name: string; type: string }[];
      row_count: number | null; description: string; refreshed_at: string | null;
    };
    const linked = plan.data.linked as { id: string; name: string }[];
    let sample: QueryResult | null = null;
    try {
      if (ctx.datasources?.has(d.source_id)) sample = await ctx.datasources.get(d.source_id).sampleRows(d.table_name, 3);
    } catch {
      /* source temporarily unreachable — page still renders schema */
    }
    const refreshed = d.refreshed_at ? new Date(d.refreshed_at).toISOString() : new Date().toISOString();
    return {
      frontmatter: {
        type: 'dataset',
        title: `${d.source_id}.${d.table_name}`,
        description: d.description.replace(/\n/g, ' '),
        source: d.source_id,
        table: d.table_name,
        source_kind: d.kind,
        row_count: d.row_count ?? 'unknown',
        refreshed,
        generated: okfGenerated('knode-os/dataset'),
        knode: knodeMeta('dataset', { datasets: [d.id], entities: linked.map((e) => e.id) }),
      },
      regions: { body: renderDatasetBody({ ...d, refreshed_at: refreshed }, linked.map((e) => e.name), sample) },
    };
  },
};

function renderDatasetBody(
  d: { id: string; source_id: string; table_name: string; kind: string; columns: { name: string; type: string }[]; row_count: number | null; description: string; refreshed_at: string },
  linkedEntities: string[],
  sample: QueryResult | null,
): string {
  const lines = [
    `# ${d.source_id}.${d.table_name}`,
    '',
    d.description,
    '',
    `> Live table in **${d.kind}** source \`${d.source_id}\` — rows are NOT indexed here. Query them natively via \`knode_query\` (source \`${d.source_id}\`). Schema refreshed ${d.refreshed_at}.`,
    '',
    '## Schema',
    '',
    '| column | type |',
    '| ------ | ---- |',
    ...d.columns.map((c) => `| ${c.name} | ${c.type} |`),
    '',
  ];
  if (sample && sample.rows.length > 0) {
    lines.push(`## Sample rows (snapshot ${sample.asOf} — stale by design, query live for current values)`, '');
    lines.push(`| ${sample.columns.join(' | ')} |`);
    lines.push(`| ${sample.columns.map(() => '---').join(' | ')} |`);
    for (const row of sample.rows) {
      lines.push(`| ${sample.columns.map((c) => String(row[c] ?? '')).join(' | ')} |`);
    }
    lines.push('');
  }
  if (linkedEntities.length > 0) {
    lines.push('## Entities appearing in this table', '');
    for (const name of linkedEntities) lines.push(`- [[${name}]]`);
    lines.push('');
  }
  lines.push('## How to query', '', '```sql', `SELECT * FROM ${d.table_name} LIMIT 10`, '```');
  return lines.join('\n');
}

const sourcesIndex: PageGenerator = {
  kind: 'sources_index',
  version: 2,
  llm: false,
  mode: 'region',
  async plan(ctx) {
    const docs = await ctx.store.query<DocumentRow>(
      `SELECT * FROM documents WHERE root = 'docs' AND status = 'indexed' AND kind = 'source' ORDER BY updated_at DESC LIMIT 2000`,
    );
    if (docs.length === 0) return null;
    const heat = await getDocHeat(ctx.store, docs.map((d) => d.id), ctx.config.heat);
    const pages = await summaryPagesByDocument(ctx.store);
    const minChars = summaryMinChars(ctx.config);
    const rows = docs.map((d) => {
      const h = heat.get(d.id) ?? 0;
      const page = pages.get(d.path)?.path ?? null;
      // under the size threshold by its row alone; a row without `chars` that its bytes do not
      // settle reads as merely unsummarized until the Summarize stage's scan fills the column in
      const short = !page && shortByRow(d, minChars) === true;
      return { path: d.path, title: d.title ?? path.basename(d.path), page: page ? path.posix.basename(page) : null, heat: h, cold: h < ctx.config.heat.coldThreshold, short, sha: d.sha256 };
    });
    const setSha = sha16(rows.map((r) => [r.path, r.sha, r.page, r.cold, r.short, Math.round(r.heat * 100)]));
    return {
      deps: [
        { kind: 'set', id: 'docs', sha: setSha },
        ...docs.map((d) => ({ kind: 'document' as const, id: d.path, sha: d.sha256 })),
      ],
      inputsSha: sha16(['sources_index@2', setSha]),
      data: { rows },
    };
  },
  async render(_ctx, _pagePath, plan) {
    const rows = plan.data.rows as { path: string; title: string; page: string | null; heat: number; cold: boolean; short?: boolean }[];
    const lines = [
      '## Sources index',
      '',
      'Every indexed document, most recently updated first, linked to its summary page once the Summarize stage has written one. A document under `extraction.summaryMinChars` (`short`) gets none: search finds the document itself.',
      '',
      ...rows.map((r) => {
        const link = r.page ? `[${r.title}](${r.page})` : r.title;
        const badge = r.cold ? ' `cold`' : ` \`heat ${r.heat.toFixed(2)}\``;
        return `* ${link} - \`${r.path}\`${badge}${r.short ? ' `short`' : ''}`;
      }),
    ];
    return { frontmatter: {}, regions: { sources: lines.join('\n') } };
  },
};

export interface HotEntity {
  id: string;
  name: string;
  type: string;
  description: string;
  mention_count: number;
  heat: number;
  fold_sha: string;
}

/**
 * Top-K live entities scored by mentions + heat of the documents mentioning
 * them (heat summed over their mention rows), among those mentioned at all.
 *
 * Heat is never negative, so only two kinds of entity can make the top K:
 * one with heat — mentioned in a document with usage stats, a few hundred
 * documents — and one whose mention count alone reaches the K-th highest.
 * Scoring just those reads the mentions of the used documents instead of
 * grouping every mention in the base (5.5 s on a 3.7M-mention workspace,
 * which every small sync paid while a top entity kept gaining mentions).
 * The sum is taken in double precision, so the same stats give the same
 * heat whatever order the rows come in.
 */
export async function hotEntities(store: Store, limit: number): Promise<HotEntity[]> {
  return store.query<HotEntity>(
    `WITH heated AS (
       SELECT m.entity_id, sum(ds.heat::float8) AS heat
       FROM doc_stats ds JOIN entity_mentions m ON m.document_id = ds.document_id
       GROUP BY m.entity_id
     ), cutoff AS (
       SELECT e.mention_count FROM entities e
       WHERE e.tx_to IS NULL AND e.canonical_id IS NULL AND EXISTS (SELECT 1 FROM entity_mentions m WHERE m.entity_id = e.id)
       ORDER BY e.mention_count DESC OFFSET $1::int - 1 LIMIT 1
     ), candidates AS (
       SELECT e.id FROM entities e
       WHERE e.tx_to IS NULL AND e.canonical_id IS NULL
         AND e.mention_count >= COALESCE((SELECT mention_count FROM cutoff), e.mention_count)
         AND EXISTS (SELECT 1 FROM entity_mentions m WHERE m.entity_id = e.id)
       UNION
       SELECT entity_id FROM heated
     )
     SELECT e.id, e.name, e.type, e.description, e.mention_count, e.fold_sha, COALESCE(h.heat, 0)::float AS heat
     FROM candidates c
     JOIN entities e ON e.id = c.id
     LEFT JOIN heated h ON h.entity_id = e.id
     WHERE e.tx_to IS NULL AND e.canonical_id IS NULL
     ORDER BY (e.mention_count + COALESCE(h.heat, 0) * 5) DESC, e.name ASC
     LIMIT $1`,
    [Math.max(1, Math.floor(limit))],
  );
}

interface IndexedEntity { id: string; name: string; type: string; description: string; wiki_path: string; fold_sha: string; claims: number; docs: number }

/** Entity pages the index lists at most, the best documented first. */
const ENTITIES_INDEX_LIMIT = 2000;

/**
 * The contents of wiki/entities/: every entity page with what it is and how
 * much stands on it. A directory listing shows slugs; this is what tells a
 * reader — a person or an agent — which page holds the answer before opening
 * any.
 */
const entitiesIndex: PageGenerator = {
  kind: 'entities_index',
  version: 1,
  llm: false,
  mode: 'region',
  async plan(ctx) {
    const rows = await ctx.store.query<IndexedEntity>(
      `SELECT e.id, e.name, e.type, e.description, e.wiki_path, e.fold_sha, COALESCE(c.claims, 0)::int AS claims, COALESCE(c.docs, 0)::int AS docs
       FROM entities e
       LEFT JOIN LATERAL (
         SELECT count(*) AS claims, count(DISTINCT cl.primary_scope_id) AS docs
         FROM claims cl WHERE cl.subject_id = e.id AND cl.tx_to IS NULL AND cl.canonical_id IS NULL
       ) c ON true
       WHERE e.wiki_path LIKE 'wiki/entities/%' AND e.tx_to IS NULL AND e.canonical_id IS NULL
       ORDER BY COALESCE(c.docs, 0) DESC, COALESCE(c.claims, 0) DESC, e.name
       LIMIT $1`,
      [ENTITIES_INDEX_LIMIT],
    );
    if (rows.length === 0) return null;
    const setSha = sha16(rows.map((r) => [r.id, r.fold_sha, r.wiki_path, r.claims, r.docs]));
    return {
      deps: [{ kind: 'set', id: 'entity-pages', sha: setSha }],
      inputsSha: sha16(['entities_index@1', setSha]),
      data: { rows },
    };
  },
  async render(_ctx, _pagePath, plan) {
    const rows = plan.data.rows as IndexedEntity[];
    const lines = [
      '## Entity pages',
      '',
      'Every entity with a page, the ones the most documents speak of first. A page lists what the knowledge base holds about its entity — facts, dated history, disagreements, relations — each with the document it comes from.',
      '',
      ...rows.map((r) => {
        const about = r.description ? ` — ${r.description.replace(/\s+/g, ' ').slice(0, 160)}` : '';
        const held = r.claims > 0 ? ` \`${r.claims} ${r.claims === 1 ? 'claim' : 'claims'}, ${r.docs} ${r.docs === 1 ? 'document' : 'documents'}\`` : '';
        return `* [${r.name}](${path.posix.basename(r.wiki_path)}) (${r.type})${about}${held}`;
      }),
    ];
    return { frontmatter: {}, regions: { entities: lines.join('\n') } };
  },
};

const hotTopics: PageGenerator = {
  kind: 'hot_topics',
  version: 2,
  llm: false,
  mode: 'region',
  async plan(ctx) {
    const hot = await hotEntities(ctx.store, 10);
    if (hot.length === 0) return null;
    const setSha = sha16(hot.map((e) => [e.id, e.fold_sha, Math.round(e.heat * 100)]));
    return {
      deps: [
        { kind: 'set', id: 'hot-entities', sha: setSha },
        ...hot.map((e) => ({ kind: 'entity' as const, id: e.id, sha: e.fold_sha })),
      ],
      inputsSha: sha16(['hot_topics@2', setSha]),
      data: { hot },
    };
  },
  async render(_ctx, _pagePath, plan) {
    const hot = plan.data.hot as HotEntity[];
    const lines = ['## Hot topics', '', ...hot.map((e) => `- [[${e.name}]] — ${e.type}, mentions ${e.mention_count}, heat ${e.heat.toFixed(2)}`)];
    return { frontmatter: {}, regions: { 'hot-topics': lines.join('\n') } };
  },
};

/**
 * The Summarize stage — its own route, not `ctx.llm`, which is the Judge
 * stage's. A context may carry it ready-made; otherwise it is resolved from
 * the config each time, which is free: endpoint negotiation is cached per
 * endpoint, not per client.
 */
function documentSummaryLlm(ctx: PagesContext): LlmClient {
  return ctx.summaryLlm ?? summaryLlmClient(ctx.config);
}

/** `wiki/index.md#recent-research`: the pages research agents wrote, newest first, with their review state. */
const researchIndex: PageGenerator = {
  kind: 'research_index',
  version: 1,
  llm: false,
  mode: 'region',
  async plan(ctx) {
    const rows = await ctx.store.query<{ output_path: string; kind: string; target: string | null; query: string | null; finished_at: string | Date | null; trust: string | null }>(
      `SELECT DISTINCT ON (j.output_path) j.output_path, j.kind, j.target, j.query, j.finished_at,
              (SELECT s.trust FROM scopes s WHERE s.kind = 'doc' AND s.key = j.output_path AND s.status = 'active' ORDER BY s.applied_at DESC LIMIT 1) AS trust
       FROM research_jobs j WHERE j.status = 'done' AND j.output_path IS NOT NULL
       ORDER BY j.output_path, j.finished_at DESC`,
    );
    if (rows.length === 0) return null;
    const list = rows
      .filter((r) => fs.existsSync(safePath(ctx.dataDir, r.output_path)))
      .sort((a, b) => String(toIso(b.finished_at) ?? '').localeCompare(String(toIso(a.finished_at) ?? '')))
      .slice(0, 30);
    const setSha = sha16(list.map((r) => [r.output_path, r.trust, toIso(r.finished_at)]));
    return {
      deps: [{ kind: 'set', id: 'research-pages', sha: setSha }],
      inputsSha: sha16(['research_index@1', setSha]),
      data: { list: list.map((r) => ({ ...r, finished_at: toIso(r.finished_at) })) },
    };
  },
  async render(_ctx, _pagePath, plan) {
    const list = plan.data.list as { output_path: string; kind: string; target: string | null; query: string | null; finished_at: string | null; trust: string | null }[];
    const pending = list.filter((r) => r.trust === 'quarantined').length;
    const lines = [
      '## Recent research',
      '',
      `Pages written by research agents, newest first${pending ? ` — ${pending} awaiting review (quarantined)` : ''}.`,
      '',
      ...list.map((r) => {
        const name = path.posix.basename(r.output_path, '.md');
        return `- [[${name}]] — ${r.kind} ${r.target ?? r.query ?? ''} \`${r.trust ?? 'unsynced'}\`${r.finished_at ? ` ${r.finished_at.slice(0, 10)}` : ''}`;
      }),
    ];
    return { frontmatter: {}, regions: { 'recent-research': lines.join('\n') } };
  },
};

export async function ensureRecentResearch(ctx: PagesContext, opts: { actor?: string } = {}): Promise<RegenerateOutcome> {
  return regeneratePage(ctx, 'wiki/index.md#recent-research', 'research_index', { actor: opts.actor ?? 'research', force: true });
}

export const GENERATORS: Partial<Record<PageKind, PageGenerator>> = {
  entity_stub: entityStub,
  research_index: researchIndex,
  source_summary: sourceSummary,
  dataset,
  sources_index: sourcesIndex,
  entities_index: entitiesIndex,
  hot_topics: hotTopics,
  ...CORPUS_GENERATORS,
};

/* ----------------------------- composition ------------------------------ */

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** Merge generated frontmatter keys and regions into an existing page (or build a fresh one). */
export function composePage(existing: string | null, frontmatter: Record<string, unknown>, regions: Record<string, string>): string {
  if (!existing) {
    const front = Object.keys(frontmatter).length ? writeMatter('', frontmatter).trimEnd() : '';
    const body = Object.entries(regions).map(([id, c]) => renderRegion(id, c)).join('\n\n');
    return `${front ? front + '\n\n' : ''}${body}\n`;
  }
  let parsed: { data: Record<string, unknown>; content: string };
  try {
    const p = readMatter(existing);
    parsed = { data: p.data as Record<string, unknown>, content: p.content };
  } catch {
    parsed = { data: {}, content: existing };
  }
  const data = { ...parsed.data };
  let changed = false;
  for (const [k, v] of Object.entries(frontmatter)) {
    if (JSON.stringify(data[k]) !== JSON.stringify(v)) {
      data[k] = v;
      changed = true;
    }
  }
  let body = parsed.content;
  // a legacy fully-generated page (no markers) is managed wholesale
  if (!hasRegions(body) && isGeneratedConcept(data) && Object.keys(regions).length > 0) body = '';
  for (const [id, c] of Object.entries(regions)) body = replaceRegion(body, id, c);
  body = body.replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n').trimEnd();
  const hadFrontmatter = FRONTMATTER_RE.test(existing);
  if (!changed && (hadFrontmatter || Object.keys(frontmatter).length === 0)) {
    const front = hadFrontmatter ? FRONTMATTER_RE.exec(existing)![0].trimEnd() : '';
    return `${front ? front + '\n\n' : ''}${body}\n`;
  }
  return writeMatter('\n' + body, data).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/* ----------------------------- regeneration ----------------------------- */

export interface RegenerateOptions {
  actor?: string;
  at?: string;
  force?: boolean;
  hint?: Record<string, unknown>;
}

export async function regeneratePage(ctx: PagesContext, pagePath: string, kind: PageKind, opts: RegenerateOptions = {}): Promise<RegenerateOutcome> {
  const gen = GENERATORS[kind];
  if (!gen) return 'deferred';
  const actor = opts.actor ?? 'pages';
  const { store } = ctx;
  const [row] = await store.query<{ path: string; status: string; generator: string | null }>(`SELECT path, status, generator FROM pages WHERE path = $1`, [pagePath]);

  const plan = await gen.plan(ctx, pagePath, opts.hint);
  if (!plan) {
    if (row && row.status !== 'archived') await archivePage(ctx, pagePath, actor);
    else if (row) await archivePage(ctx, pagePath, actor);
    return 'archived';
  }
  const live = await findLiveScope(store, 'page', pagePath);
  // the same inputs through a newer generator make a different page; one a model writes waits for its inputs to change
  const outdated = !gen.llm && Boolean(row?.generator) && row!.generator !== `${kind}@${gen.version}`;
  if (live && live.sha === plan.inputsSha && !opts.force && !outdated) {
    if (row?.status === 'dirty') await store.query(`UPDATE pages SET status = 'active', dirty_reason = NULL WHERE path = $1`, [pagePath]);
    return 'unchanged';
  }
  // the model this generator writes with — the Summarize stage for a summary,
  // not `ctx.llm` — decides whether an uncached page can be written now
  const client = gen.client?.(ctx) ?? ctx.llm;
  if (gen.llm && !client.enabled && !(await cachedRenderAvailable(ctx, gen, pagePath, plan))) return 'deferred';

  const rendered = await gen.render(ctx, pagePath, plan);
  if (!rendered) return 'deferred';

  const { file, region } = splitPagePath(pagePath);
  const abs = safePath(ctx.dataDir, file);
  const existing = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  if (gen.mode === 'file' && existing && !row) {
    let generated = false;
    try {
      generated = isGeneratedConcept(readMatter(existing).data as Record<string, unknown>);
    } catch {
      generated = false;
    }
    if (!generated) return 'blocked'; // a human owns the file at this path
  }

  let text: string;
  let regionContent: string | null = null;
  if (gen.mode === 'file') {
    text = composePage(existing, rendered.frontmatter, rendered.regions);
  } else {
    regionContent = rendered.regions[region ?? 'body'] ?? '';
    text = replaceRegion(existing ?? '', region ?? 'body', regionContent);
  }
  const fileSha = sha256(text);
  const regions = Object.entries(rendered.regions).map(([id, c]) => ({ id, sha: sha16(c) }));

  // the same inputs through a newer generator are a new version of the page
  await applyScope(store, { kind: 'page', key: pagePath }, plan.inputsSha, { actor, at: opts.at, meta: { kind, file }, force: outdated }, async (w) => {
    await w.page({ path: pagePath, kind, generator: `${kind}@${gen.version}`, inputs_sha: plan.inputsSha, file_sha: fileSha, regions });
    await w.deps({ kind: 'page', id: pagePath }, plan.deps);
    if (kind === 'entity_stub') await w.setWikiPath((plan.data.entity as { id: string }).id, pagePath);
    if (gen.mode === 'file') await w.writeFile(file, text);
    else await w.writeRegion(file, region ?? 'body', regionContent ?? '');
  });

  // search projection of the (re)written file; the watcher's report of the write has nothing left to sync
  const indexed = await applyDocScope(ctx, file, 'wiki', { queueTier1: false, actor });
  if (indexed.sha) noteOwnWrite(ctx.dataDir, file, 'wiki', indexed.sha);
  return 'regenerated';
}

async function cachedRenderAvailable(ctx: PagesContext, gen: PageGenerator, _pagePath: string, plan: PagePlan): Promise<boolean> {
  if (gen.kind === 'source_summary') {
    const doc = plan.data.doc as DocumentRow | undefined;
    if (!doc) return false;
    return readSourceSummary(ctx.dataDir, doc.path)?.contentSha === doc.sha256;
  }
  return false;
}

/** Archive a page: dispose its scope (file → wiki/.archive), drop its search projection. */
export async function archivePage(ctx: PagesContext, pagePath: string, actor = 'pages'): Promise<void> {
  const { store } = ctx;
  const { file, region } = splitPagePath(pagePath);
  const scope = await findLiveScope(store, 'page', pagePath);
  if (scope) {
    await disposeScope(store, scope.id, { actor, reason: 'archived' });
  } else {
    await store.query(`UPDATE pages SET status = 'archived', scope_id = NULL, tx_to = COALESCE(tx_to, now()) WHERE path = $1`, [pagePath]);
    const abs = safePath(ctx.dataDir, file);
    if (!region && fs.existsSync(abs)) {
      const dst = safePath(ctx.dataDir, archivedPath(file));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(abs, dst);
    }
  }
  if (!region) {
    const doc = await findLiveScope(store, 'doc', file);
    if (doc) await disposeScope(store, doc.id, { actor, reason: 'removed' });
  } else if (fs.existsSync(safePath(ctx.dataDir, file))) {
    const indexed = await applyDocScope(ctx, file, 'wiki', { queueTier1: false, actor });
    if (indexed.sha) noteOwnWrite(ctx.dataDir, file, 'wiki', indexed.sha);
  }
}

export interface ReconcileStats {
  regenerated: number;
  archived: number;
  deferred: number;
  blocked: number;
  unchanged: number;
}

/**
 * Reactive reconciliation of views: archive pages whose required inputs are
 * gone, regenerate dirty ones (LLM pages only when `llm` is allowed), and
 * repair drift between the pages table and the files on disk.
 */
export async function reconcileViews(
  ctx: PagesContext,
  opts: { actor?: string; llm?: boolean; onProgress?: (msg: string) => void; prefixes?: string[] } = {},
): Promise<ReconcileStats> {
  const { store } = ctx;
  const actor = opts.actor ?? 'pages';
  const progress = opts.onProgress ?? (() => {});
  const stats: ReconcileStats = { regenerated: 0, archived: 0, deferred: 0, blocked: 0, unchanged: 0 };

  const toArchive = await store.query<{ path: string }>(`SELECT path FROM pages WHERE status = 'archived' AND scope_id IS NOT NULL`);
  for (const p of toArchive) {
    progress(`archive page ${p.path}`);
    await archivePage(ctx, p.path, actor);
    stats.archived++;
  }

  // drift: file gone → archive; file edited inside our regions → dirty. A
  // scoped pass reads only the page files under its prefixes: an edit or a
  // removal anywhere else is reported by the watcher and synced on its own,
  // and a full pass reads them all
  const live = await store.query<{ path: string; kind: PageKind; status: string; file_sha: string | null; generator: string | null; regions: { id: string; sha: string }[] }>(
    `SELECT path, kind, status, file_sha, generator, regions FROM pages WHERE status IN ('active', 'dirty')`,
  );
  for (const p of live) {
    const { file } = splitPagePath(p.path);
    if (!matchesPrefixes(file, opts.prefixes)) continue;
    // a page a model did not write, written by an older version of its generator, is written again:
    // it costs nothing, and otherwise it keeps the old layout until one of its inputs happens to change
    const gen = GENERATORS[p.kind];
    if (gen && !gen.llm && p.status === 'active' && p.generator && p.generator !== `${p.kind}@${gen.version}`) {
      await store.query(`UPDATE pages SET status = 'dirty', dirty_reason = $2::jsonb WHERE path = $1`, [p.path, JSON.stringify({ generator: `${p.kind}@${gen.version}` })]);
      p.status = 'dirty';
    }
    const abs = safePath(ctx.dataDir, file);
    if (!fs.existsSync(abs)) {
      progress(`page file missing, archiving ${p.path}`);
      await archivePage(ctx, p.path, actor);
      stats.archived++;
      continue;
    }
    if (p.status === 'active' && p.file_sha) {
      const current = fs.readFileSync(abs, 'utf8');
      if (sha256(current) !== p.file_sha) {
        const regions = splitRegions(current).regions;
        const managedChanged = (p.regions ?? []).some((r) => sha16(regions.get(r.id) ?? '') !== r.sha);
        if (managedChanged) {
          await store.query(`UPDATE pages SET status = 'dirty', dirty_reason = $2::jsonb WHERE path = $1`, [p.path, JSON.stringify({ drift: true })]);
        } else {
          await store.query(`UPDATE pages SET file_sha = $2 WHERE path = $1`, [p.path, sha256(current)]);
        }
      }
    }
  }

  // dirty pages; a regeneration can dirty others (or itself, transiently,
  // while its own search projection is replaced), so take a few passes
  const processed = new Set<string>();
  for (let pass = 0; pass < 3; pass++) {
    const dirty = (await store.query<{ path: string; kind: PageKind }>(`SELECT path, kind FROM pages WHERE status = 'dirty'`))
      .filter((p) => !processed.has(p.path) || pass > 0);
    if (dirty.length === 0) break;
    for (const p of dirty) {
      const gen = GENERATORS[p.kind];
      if (!gen) continue;
      if (gen.llm && !opts.llm) {
        if (!processed.has(p.path)) stats.deferred++;
        processed.add(p.path);
        continue;
      }
      processed.add(p.path);
      try {
        const r = await regeneratePage(ctx, p.path, p.kind, { actor });
        if (r === 'regenerated') {
          stats.regenerated++;
          progress(`regenerated ${p.path}`);
        } else if (r === 'archived') stats.archived++;
        else if (r === 'deferred') stats.deferred++;
        else if (r === 'blocked') stats.blocked++;
        else stats.unchanged++;
      } catch (err) {
        progress(`page ${p.path} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  return stats;
}

/* ------------------------------ creation rules -------------------------- */

/**
 * Create pages for the live entities worth one that have none yet, the best
 * documented first: an entity several documents make claims about, one with
 * at least `minClaims` claims (default 3), or one mentioned at least
 * `minMentions` times (default 2); null leaves a test out. The ones with the
 * most documents behind their claims come first, so the pages a call can
 * write go to what the knowledge base knows most about, not to the words it
 * met most often.
 *
 * Mentions alone used to decide, thirty pages a call, and nothing called it
 * but `wiki generate` and an initialization: a workspace of 27,000 documents
 * had eight entity pages. `focus` restricts the pass to those entities — the
 * ones a document pass has just written — so pages come as documents do.
 * Without `max`, a call writes up to one page for every four documents, 30
 * at least and 300 at most: a page is a file the next sync indexes and embeds.
 */
export async function ensureEntityStubs(
  ctx: PagesContext,
  opts: { minMentions?: number | null; minClaims?: number | null; max?: number; actor?: string; focus?: string[] } = {},
): Promise<string[]> {
  if (opts.focus && opts.focus.length === 0) return [];
  let max = opts.max;
  if (max === undefined) {
    const [{ n }] = await ctx.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM documents WHERE root = 'docs' AND status = 'indexed'`);
    max = Math.min(300, Math.max(30, Math.ceil(n / 4)));
  }
  const p = new Params();
  const tests = ['COALESCE(c.docs, 0) >= 2'];
  const minClaims = opts.minClaims === undefined ? 3 : opts.minClaims;
  const minMentions = opts.minMentions === undefined ? 2 : opts.minMentions;
  if (minClaims !== null) tests.push(`COALESCE(c.claims, 0) >= ${p.add(minClaims)}`);
  if (minMentions !== null) tests.push(`e.mention_count >= ${p.add(minMentions)}`);
  const focus = opts.focus ? p.add(opts.focus) : null;
  const entities = await ctx.store.query<{ id: string }>(
    `SELECT e.id
     FROM entities e
     LEFT JOIN (
       SELECT cl.subject_id, count(*) AS claims, count(DISTINCT cl.primary_scope_id) AS docs
       FROM claims cl
       WHERE cl.tx_to IS NULL AND cl.canonical_id IS NULL ${focus ? `AND cl.subject_id = ANY(${focus}::text[])` : ''}
       GROUP BY cl.subject_id
     ) c ON c.subject_id = e.id
     WHERE e.wiki_path IS NULL AND e.tx_to IS NULL AND e.canonical_id IS NULL ${focus ? `AND e.id = ANY(${focus}::text[])` : ''}
       AND (${tests.join(' OR ')})
     ORDER BY COALESCE(c.docs, 0) DESC, COALESCE(c.claims, 0) DESC, e.mention_count DESC, e.id
     LIMIT ${p.add(max)}`,
    p.list,
  );
  const created: string[] = [];
  for (const e of entities) {
    const pagePath = `wiki/entities/${e.id}.md`;
    restoreArchived(ctx.dataDir, pagePath);
    const r = await regeneratePage(ctx, pagePath, 'entity_stub', { actor: opts.actor });
    if (r === 'regenerated') created.push(pagePath);
  }
  if (created.length > 0) await ensureEntitiesIndex(ctx, { actor: opts.actor });
  return created;
}

/** Bring an archived copy back so human-written parts survive re-creation. */
function restoreArchived(dataDir: string, pagePath: string): void {
  const abs = safePath(dataDir, pagePath);
  const archived = safePath(dataDir, archivedPath(pagePath));
  if (!fs.existsSync(abs) && fs.existsSync(archived)) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.renameSync(archived, abs);
  }
}

/** Summary pages still in use, by the document each one summarizes (its `document` dep). */
export async function summaryPagesByDocument(store: Store): Promise<Map<string, { path: string; status: string }>> {
  const rows = await store.query<{ path: string; status: string; doc: string }>(
    `SELECT p.path, p.status, d.input_id AS doc
     FROM pages p JOIN deps d ON d.artifact_kind = 'page' AND d.artifact_id = p.path AND d.input_kind = 'document'
     WHERE p.kind = 'source_summary' AND p.status <> 'archived'`,
  );
  return new Map(rows.map((r) => [r.doc, { path: r.path, status: r.status }]));
}

/**
 * The most of a title's slug a summary page's name takes, in UTF-8 bytes: a
 * GitHub page's title carries the whole repository description, and a file
 * name stops at 255 bytes — less the hash, `.md` and a temporary write's suffix.
 */
const SUMMARY_SLUG_MAX_BYTES = 120;

/** A document's title as a summary page's name: its slug, cut to SUMMARY_SLUG_MAX_BYTES at a word where one is near. */
function summarySlug(doc: DocumentRow): string {
  const slug = slugify(doc.title ?? path.basename(doc.path));
  if (Buffer.byteLength(slug) <= SUMMARY_SLUG_MAX_BYTES) return slug;
  let cut = '';
  let bytes = 0;
  for (const ch of slug) {
    bytes += Buffer.byteLength(ch);
    if (bytes > SUMMARY_SLUG_MAX_BYTES) break;
    cut += ch;
  }
  const word = cut.lastIndexOf('-');
  return (word > cut.length / 2 ? cut.slice(0, word) : cut).replace(/[-.]+$/, '');
}

/** `wiki/sources/<title slug>-<path hash>.md`: where a summary goes when its title's path belongs to someone else. */
function hashedSummaryPath(doc: DocumentRow): string {
  return `wiki/sources/${summarySlug(doc)}-${crypto.createHash('sha256').update(doc.path).digest('hex').slice(0, 6)}.md`;
}

/** `wiki/sources/<title slug>.md`: where a document's first summary page goes, unless another document holds it. */
function plainSummaryPath(doc: DocumentRow): string {
  return `wiki/sources/${summarySlug(doc)}.md`;
}

/** Summaries that failed this often on a document's current content wait for new content. */
export const MAX_SUMMARY_ATTEMPTS = 3;

/**
 * Documents due a summary page: indexed sources under raw/docs whose page is
 * missing or dirty (their document changed since), leaving out those under
 * `minChars` (docs/design/14), those that failed MAX_SUMMARY_ATTEMPTS times
 * on their current content and those in `exclude` — the documents in
 * `prefer` first, then the most recently updated. `due` counts them all,
 * `docs` holds the first `limit`.
 */
export async function dueSummaryDocuments(
  store: Store,
  dataDir: string,
  opts: {
    limit: number;
    prefer?: string[];
    /** Leave out documents still waiting for extraction — a summary written first would miss what it finds. */
    skipQueued?: boolean;
    exclude?: ReadonlySet<string>;
    /** Documents shorter than this, in characters of indexed text, are never due (`extraction.summaryMinChars`); default 0, every document. */
    minChars?: number;
  },
): Promise<{ docs: DocumentRow[]; due: number; pages: Map<string, { path: string; status: string }> }> {
  const pages = await summaryPagesByDocument(store);
  const minChars = Math.max(0, Math.floor(opts.minChars ?? 0));
  const docs = await store.query<DocumentRow>(
    `SELECT * FROM documents d WHERE root = 'docs' AND status = 'indexed' AND kind = 'source'${opts.skipQueued ? ' AND NOT EXISTS (SELECT 1 FROM extraction_queue q WHERE q.document_id = d.id)' : ''}
       AND ($1::int <= 0 OR d.chars IS NULL OR d.chars >= $1::int)
     ORDER BY updated_at DESC, path`,
    [minChars],
  );
  const due: DocumentRow[] = [];
  for (const d of docs) {
    if (opts.exclude?.has(d.path)) continue;
    const page = pages.get(d.path);
    if (page && page.status !== 'dirty') continue;
    // a row indexed before the `chars` column reads its text once here, never again
    if (await isShortDocument(store, dataDir, d, minChars)) continue;
    const failed = readSourceSummaryFailure(dataDir, d.path);
    if (failed && failed.contentSha === d.sha256 && failed.attempts >= MAX_SUMMARY_ATTEMPTS) continue;
    due.push(d);
  }
  const prefer = new Set(opts.prefer ?? []);
  const ordered = prefer.size ? [...due.filter((d) => prefer.has(d.path)), ...due.filter((d) => !prefer.has(d.path))] : due;
  return { docs: ordered.slice(0, Math.max(0, opts.limit)), due: due.length, pages };
}

/**
 * Write a document's summary page — at `pagePath`, else where its page is or
 * a new one goes — or at its hashed path when a file a person wrote holds
 * that one. Says what happened and where.
 */
export async function writeSourceSummaryPage(
  ctx: PagesContext,
  doc: DocumentRow,
  opts: { pagePath?: string; actor?: string } = {},
): Promise<{ outcome: RegenerateOutcome; path: string }> {
  let at = opts.pagePath ?? (await summaryPagePath(ctx.store, doc));
  restoreArchived(ctx.dataDir, at);
  let outcome = await regeneratePage(ctx, at, 'source_summary', { actor: opts.actor, hint: { documentPath: doc.path } });
  if (outcome === 'blocked' && at !== hashedSummaryPath(doc)) {
    // a file a person wrote holds the title's path
    at = hashedSummaryPath(doc);
    outcome = await regeneratePage(ctx, at, 'source_summary', { actor: opts.actor, hint: { documentPath: doc.path } });
  }
  return { outcome, path: at };
}

/** Where one document's summary page goes: where it is, else the title's path unless another document's page holds that. */
async function summaryPagePath(store: Store, doc: DocumentRow): Promise<string> {
  const pages = await summaryPagesByDocument(store);
  const own = pages.get(doc.path)?.path;
  if (own) return own;
  const plain = plainSummaryPath(doc);
  return [...pages].some(([other, page]) => page.path === plain && other !== doc.path) ? hashedSummaryPath(doc) : plain;
}

/**
 * The Summarize stage: one summary page per indexed source document under
 * raw/docs, written in the background document pass right after extraction
 * (docs/design/09). One call writes at most `limit` pages — missing ones, and
 * ones whose document changed since (dirty) — taking the documents in `prefer`
 * (what the pass just extracted) first, then the most recently updated, with
 * `concurrency` model calls at a time. A page keeps its path; a new one takes
 * the title's path unless another document holds it. Returns the paths written.
 *
 * `serve` leases the same calls to its own slots and to remote workers
 * instead (src/work/summarize.ts); this is the one-shot pass.
 */
export async function ensureSourceSummaries(
  ctx: PagesContext,
  opts: {
    limit?: number;
    prefer?: string[];
    concurrency?: number;
    actor?: string;
    onProgress?: (msg: string) => void;
    /** Leave out documents still waiting for extraction — a summary written first would miss what it finds. */
    skipQueued?: boolean;
    /** Counts summaries put off because the model could not be reached, for the caller's backoff. */
    stats?: { deferred: number };
  } = {},
): Promise<string[]> {
  const progress = opts.onProgress ?? (() => {});
  const limit = Math.max(0, Math.floor(opts.limit ?? 20));
  if (limit === 0 || !documentSummaryLlm(ctx).enabled) return [];
  const { docs: picked, pages } = await dueSummaryDocuments(ctx.store, ctx.dataDir, { limit, prefer: opts.prefer, skipQueued: opts.skipQueued, minChars: summaryMinChars(ctx.config) });
  if (picked.length === 0) return [];

  // paths are handed out before any call runs, so two new documents with one
  // title never race for the same path
  const owner = new Map([...pages].map(([doc, page]) => [page.path, doc]));
  const work = picked.map((doc) => {
    let pagePath = pages.get(doc.path)?.path;
    if (!pagePath) {
      const plain = plainSummaryPath(doc);
      pagePath = owner.has(plain) && owner.get(plain) !== doc.path ? hashedSummaryPath(doc) : plain;
      owner.set(pagePath, doc.path);
    }
    return { doc, pagePath };
  });

  const written: string[] = [];
  const summarize = async ({ doc, pagePath }: (typeof work)[number]) => {
    try {
      progress(`summarizing ${doc.path}`);
      const { outcome: r, path: at } = await writeSourceSummaryPage(ctx, doc, { pagePath, actor: opts.actor });
      if (r === 'regenerated' || r === 'unchanged') {
        clearSourceSummaryFailure(ctx.dataDir, doc.path);
        if (r === 'regenerated') written.push(at);
        return;
      }
      if (r === 'deferred' || r === 'blocked') throw new Error(r === 'blocked' ? `${at} belongs to a person` : 'no source text to summarize');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // an unreachable model (a rate limit, the network, a timeout) is no verdict on
      // the document: it keeps its attempts, so an outage cannot use them all up
      if (classifyFailure(message) === 'transient') {
        if (opts.stats) opts.stats.deferred++;
        progress(`summary put off for ${doc.path}: ${message.slice(0, 200)}`);
        return;
      }
      const failed = recordSourceSummaryFailure(ctx.dataDir, doc.path, doc.sha256, message);
      progress(`summary failed for ${doc.path} (${failed.attempts}/${MAX_SUMMARY_ATTEMPTS}): ${message}`);
    }
  };
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, Math.floor(opts.concurrency ?? 1)), work.length) }, async () => {
      while (next < work.length) await summarize(work[next++]);
    }),
  );
  return written;
}

/**
 * Archive the concept-cluster pages the retired Synthesize stage wrote:
 * concept pages are research's job now (docs/design/09). Prose a person added
 * outside the managed region goes to wiki/.archive with the file. Idempotent;
 * returns the paths it archived.
 */
export async function retireConceptClusterPages(ctx: PagesContext, opts: { actor?: string } = {}): Promise<string[]> {
  const rows = await ctx.store.query<{ path: string }>(`SELECT path FROM pages WHERE kind = 'concept_cluster' AND status <> 'archived'`);
  for (const r of rows) await archivePage(ctx, r.path, opts.actor ?? 'tier2');
  return rows.map((r) => r.path);
}

export interface PruneSummariesResult {
  minChars: number;
  /** Summary pages archived — or, on a dry run, that would be. */
  archived: string[];
  /** Pages kept: their documents are long enough. */
  kept: number;
}

/**
 * Archive the summary pages of documents under `extraction.summaryMinChars`
 * (docs/design/14): pages written before the threshold existed, or before it
 * was raised. Each goes to wiki/.archive through `archivePage`, its search
 * projection with it, and the sources index is rewritten without the links.
 * The cached summaries stay in the sidecars, so lowering the threshold brings
 * the pages back without a model call. `knode-os wiki prune-summaries`.
 */
export async function pruneShortSummaries(
  ctx: PagesContext,
  opts: { minChars?: number; dryRun?: boolean; actor?: string; onProgress?: (msg: string) => void } = {},
): Promise<PruneSummariesResult> {
  const progress = opts.onProgress ?? (() => {});
  const actor = opts.actor ?? 'wiki';
  const minChars = Math.max(0, Math.floor(opts.minChars ?? summaryMinChars(ctx.config)));
  const archived: string[] = [];
  let kept = 0;
  if (minChars <= 0) return { minChars, archived, kept };
  for (const [docPath, page] of await summaryPagesByDocument(ctx.store)) {
    const [doc] = await ctx.store.query<DocumentRow>(`SELECT * FROM documents WHERE path = $1 AND status = 'indexed'`, [docPath]);
    if (!doc) continue; // a page whose document is gone is reconcileViews' to archive
    const chars = await documentChars(ctx.store, ctx.dataDir, doc);
    if (chars === null || chars >= minChars) {
      kept++;
      continue;
    }
    progress(`${opts.dryRun ? 'would archive' : 'archiving'} ${page.path} — ${docPath} has ${chars} characters, under ${minChars}`);
    if (!opts.dryRun) await archivePage(ctx, page.path, actor);
    archived.push(page.path);
  }
  if (!opts.dryRun && archived.length > 0) await ensureSourcesIndex(ctx, { actor });
  return { minChars, archived, kept };
}

export async function ensureSourcesIndex(ctx: PagesContext, opts: { actor?: string } = {}): Promise<RegenerateOutcome> {
  return regeneratePage(ctx, 'wiki/sources/index.md#sources', 'sources_index', { actor: opts.actor });
}

export async function ensureEntitiesIndex(ctx: PagesContext, opts: { actor?: string } = {}): Promise<RegenerateOutcome> {
  return regeneratePage(ctx, 'wiki/entities/index.md#entities', 'entities_index', { actor: opts.actor });
}

export async function ensureHotTopics(ctx: PagesContext, opts: { actor?: string; force?: boolean } = {}): Promise<RegenerateOutcome> {
  return regeneratePage(ctx, 'wiki/index.md#hot-topics', 'hot_topics', { actor: opts.actor, force: opts.force });
}
