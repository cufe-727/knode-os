import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { KnodeConfig, resolveRoutedLlmConfig, routeTargets } from '../config.js';
import { LLM_WIKI_INPUT_CHARS } from '../constants.js';
import { DataSourceRegistry } from '../datasource/registry.js';
import { QueryResult } from '../datasource/types.js';
import { safePath } from '../fs/files.js';
import { readPageCache, writePageCache } from '../fs/page-sidecar.js';
import { readSourceSummary, writeSourceSummary } from '../fs/sidecar.js';
import { slugify } from '../graph/store.js';
import { applyDocScope } from '../ingest/apply.js';
import { EmbeddingProvider } from '../ingest/embeddings.js';
import { loadSourceText } from '../ingest/source.js';
import { readDeps } from '../lineage/deps.js';
import { archivedPath, disposeScope, findLiveScope } from '../lineage/scope.js';
import { DepDecl } from '../lineage/types.js';
import { LlmClient } from '../llm/client.js';
import { applyScope } from '../lineage/scope.js';
import { isGeneratedConcept, okfGenerated } from '../okf/index.js';
import { getDocHeat } from '../stats/heat.js';
import { Store } from '../store/db.js';
import { toDateString, toIso } from '../store/temporal.js';
import { DocumentRow } from '../types.js';
import { hasRegions, renderRegion, replaceRegion, splitRegions } from './regions.js';

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

export type PageKind = 'entity_stub' | 'source_summary' | 'dataset' | 'sources_index' | 'hot_topics' | 'concept_cluster' | 'dream' | 'research_index';

export interface PagesContext {
  store: Store;
  dataDir: string;
  config: KnodeConfig;
  llm: LlmClient;
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

const entityStub: PageGenerator = {
  kind: 'entity_stub',
  version: 2,
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
        inputsSha: sha16(['entity_stub@2', 'redirect', e.fold_sha, c.id]),
        data: { entity: e, claims: [], redirect: { id: c.id, name: c.name } },
      };
    }
    const claims = await ctx.store.query<{ id: string; statement: string; status: string; valid_from: string | null; valid_to: string | null; event_at: string | null; superseded_by: string | null; fold_sha: string }>(
      `SELECT id, statement, status, valid_from, valid_to, event_at, superseded_by, fold_sha FROM claims
       WHERE subject_id = $1 AND tx_to IS NULL ORDER BY COALESCE(event_at, valid_from) DESC NULLS LAST, tx_from DESC, id LIMIT 30`,
      [id],
    );
    return {
      deps: [
        { kind: 'entity', id, required: true, sha: e.fold_sha },
        ...claims.map((c) => ({ kind: 'claim' as const, id: c.id, sha: c.fold_sha })),
      ],
      inputsSha: sha16(['entity_stub@3', e.fold_sha, claims.map((c) => [c.fold_sha, c.superseded_by])]),
      data: { entity: e, claims },
    };
  },
  async render(_ctx, _pagePath, plan) {
    const e = plan.data.entity as { id: string; name: string; type: string; description: string; aliases: string[] };
    const claims = plan.data.claims as { id: string; statement: string; status: string; valid_from: string | null; valid_to: string | null; event_at?: string | null; superseded_by?: string | null }[];
    const redirect = plan.data.redirect as { id: string; name: string } | undefined;
    const lines = redirect
      ? [`# ${e.name}`, '', `→ 已合并到 [[${redirect.name}]]（merged into; \`knode-os entities unmerge ${e.id}\` reverts it）`]
      : [`# ${e.name}`, '', e.description || '_No description yet — fill me in._'];
    // gbrain's split: the compiled truth (what holds now) above, the dated history below
    const now = new Date().toISOString();
    const current = claims.filter((c) => !c.superseded_by && !(toIso(c.valid_to) && toIso(c.valid_to)! < now));
    if (current.length > 0) {
      lines.push('', '## Facts (current)', '');
      for (const c of current) {
        const from = toDateString(c.valid_from);
        const to = toDateString(c.valid_to);
        const period = from || to ? ` \`${from ?? '?'} ~ ${to ?? ''}\`` : '';
        lines.push(`- ${c.statement} \`${c.status}\`${period}`);
      }
    }
    const dated = claims
      .filter((c) => toIso(c.event_at ?? null) || toIso(c.valid_from))
      .sort((a, b) => (toIso(a.event_at ?? null) ?? toIso(a.valid_from)!).localeCompare(toIso(b.event_at ?? null) ?? toIso(b.valid_from)!));
    if (dated.length > 0) {
      lines.push('', '## Timeline', '');
      for (const c of dated) {
        const when = toDateString(c.event_at ?? null) ?? toDateString(c.valid_from);
        lines.push(`- ${when} · ${c.statement} \`${c.status}\`${c.superseded_by ? ' _(superseded)_' : ''}`);
      }
    }
    return {
      frontmatter: {
        title: e.name,
        type: e.type,
        aliases: Array.isArray(e.aliases) ? e.aliases : [],
        generated: okfGenerated('knode-os/entity_stub'),
        knode: knodeMeta('entity_stub', { entities: [e.id], claims: claims.map((c) => c.id) }),
      },
      regions: { body: lines.join('\n') },
    };
  },
};

const SOURCE_SYSTEM = `You maintain a personal wiki. Summarize the document into a wiki source page.

Output rules:
- Markdown only, no preamble.
- Start with: a one-paragraph abstract, then "## Key points" bullets, then "## Entities" linking the important entities as [[Entity Name]] wikilinks.
- Wrap every important person/org/product/concept name in [[double brackets]].
- Write in the document's language. Max ~400 words.`;

const sourceSummary: PageGenerator = {
  kind: 'source_summary',
  version: 2,
  llm: true,
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
    return {
      deps: [{ kind: 'document', id: doc.path, required: true, sha: doc.sha256 }],
      inputsSha: sha16(['source_summary@2', doc.sha256]),
      data: { doc },
    };
  },
  async render(ctx, _pagePath, plan) {
    const doc = plan.data.doc as DocumentRow;
    const cached = readSourceSummary(ctx.dataDir, doc.path);
    let body: string;
    // generated.by/at describe the body we are about to write, so a cache hit
    // reports the model and instant that produced it, not this regeneration.
    let by: string;
    let at: string;
    const llm = documentSummaryLlm(ctx);
    if (cached && cached.contentSha === doc.sha256) {
      body = cached.body;
      by = cached.model;
      at = cached.generatedAt;
    } else {
      if (!llm.enabled) return null;
      const source = loadSourceText(ctx.dataDir, doc.path, doc.root);
      if (!source) return null;
      const content = source.text.slice(0, LLM_WIKI_INPUT_CHARS);
      body = await llm.complete([
        { role: 'system', content: SOURCE_SYSTEM },
        { role: 'user', content: `Source file: ${doc.path}\n\n${content}` },
      ], { maxTokens: 1200 });
      by = llm.label;
      at = new Date().toISOString();
      writeSourceSummary(ctx.dataDir, doc.path, { contentSha: doc.sha256, model: llm.label, body, generatedAt: at });
    }
    const heat = (await getDocHeat(ctx.store, [doc.id], ctx.config.heat)).get(doc.id) ?? 0;
    const title = doc.title ?? path.basename(doc.path);
    return {
      frontmatter: {
        title,
        type: 'source',
        description: `Summary of ${doc.path}.`,
        source: doc.path,
        heat: Number(heat.toFixed(3)),
        generated: okfGenerated(`knode-os/${by}`, at),
        knode: knodeMeta('source_summary', { documents: [doc.path] }),
      },
      regions: { body: body.trim() },
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
    const pages = new Set((await ctx.store.query<{ path: string }>(`SELECT path FROM pages WHERE kind = 'source_summary' AND status <> 'archived'`)).map((p) => p.path));
    const rows = docs.map((d) => {
      const h = heat.get(d.id) ?? 0;
      const slug = slugify(d.title ?? path.basename(d.path));
      const pageRel = `wiki/sources/${slug}.md`;
      return { path: d.path, title: d.title ?? path.basename(d.path), slug, hasPage: pages.has(pageRel), heat: h, cold: h < ctx.config.heat.coldThreshold, sha: d.sha256 };
    });
    const setSha = sha16(rows.map((r) => [r.path, r.sha, r.hasPage, r.cold, Math.round(r.heat * 100)]));
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
    const rows = plan.data.rows as { path: string; title: string; slug: string; hasPage: boolean; heat: number; cold: boolean }[];
    const lines = [
      '## Sources index',
      '',
      'Every indexed document, hottest activity first. Cold documents are listed here without a maintained summary page.',
      '',
      ...rows.map((r) => {
        const link = r.hasPage ? `[${r.title}](${r.slug}.md)` : r.title;
        const badge = r.cold ? ' `cold`' : ` \`heat ${r.heat.toFixed(2)}\``;
        return `* ${link} - \`${r.path}\`${badge}`;
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

/** Top-K live entities scored by mentions + heat of the documents mentioning them. */
export async function hotEntities(store: Store, limit: number): Promise<HotEntity[]> {
  return store.query<HotEntity>(
    `SELECT e.id, e.name, e.type, e.description, e.mention_count, e.fold_sha,
            COALESCE(sum(ds.heat), 0)::float AS heat
     FROM entities e
     JOIN entity_mentions m ON m.entity_id = e.id
     LEFT JOIN doc_stats ds ON ds.document_id = m.document_id
     WHERE e.tx_to IS NULL AND e.canonical_id IS NULL
     GROUP BY e.id, e.name, e.type, e.description, e.mention_count, e.fold_sha
     ORDER BY (e.mention_count + COALESCE(sum(ds.heat), 0) * 5) DESC, e.name ASC
     LIMIT $1`,
    [limit],
  );
}

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

const COMMUNITY_SYSTEM = `You maintain a personal wiki. You are given a cluster of related entities and their relations from a knowledge graph, plus text excerpts where they appear. Write a wiki concept page that synthesizes what this cluster is about.

Output rules:
- Markdown only, no preamble.
- Start with a one-paragraph synthesis, then "## Key entities" bullets, then "## Relations" describing how they connect.
- Wrap every entity name in [[double brackets]].
- Write in the dominant language of the excerpts. Max ~350 words.`;

const conceptCluster: PageGenerator = {
  kind: 'concept_cluster',
  version: 2,
  llm: true,
  mode: 'file',
  async plan(ctx, pagePath, hint) {
    let anchor = typeof hint?.anchor === 'string' ? hint.anchor : undefined;
    let members = Array.isArray(hint?.members) ? (hint!.members as string[]) : undefined;
    if (!anchor || !members) {
      const deps = await readDeps(ctx.store, { kind: 'page', id: pagePath });
      anchor = anchor ?? deps.find((d) => d.input_kind === 'entity' && d.required)?.input_id;
      members = members ?? deps.filter((d) => d.input_kind === 'entity').map((d) => d.input_id);
    }
    if (!anchor) return null;
    const ids = [...new Set([anchor, ...(members ?? [])])];
    const ph = ids.map((_, i) => `$${i + 1}`).join(',');
    const rows = await ctx.store.query<HotEntity>(
      `SELECT id, name, type, description, mention_count, fold_sha, 0::float AS heat FROM entities WHERE id IN (${ph}) AND tx_to IS NULL`,
      ids,
    );
    const a = rows.find((r) => r.id === anchor);
    if (!a) return null;
    const memberRows = rows.filter((r) => r.id !== anchor).sort((x, y) => y.mention_count - x.mention_count);
    if (memberRows.length < 2) return null;
    return {
      deps: [
        { kind: 'entity', id: anchor, required: true, sha: a.fold_sha },
        ...memberRows.map((m) => ({ kind: 'entity' as const, id: m.id })),
      ],
      inputsSha: sha16(['concept_cluster@2', anchor, memberRows.map((m) => m.id).sort()]),
      data: { anchor: a, members: memberRows },
    };
  },
  async render(ctx, pagePath, plan) {
    const a = plan.data.anchor as HotEntity;
    const members = plan.data.members as HotEntity[];
    const all = [a, ...members];
    const cached = readPageCache(ctx.dataDir, pagePath);
    let body: string;
    let by: string;
    let at: string;
    const llm = conceptLlm(ctx);
    if (cached && cached.inputsSha === plan.inputsSha) {
      body = cached.body;
      by = cached.model;
      at = cached.generatedAt;
    } else {
      if (!llm.enabled) return null;
      const ids = all.map((e) => e.id);
      const ph = ids.map((_, i) => `$${i + 1}`).join(',');
      const rels = await ctx.store.query<{ source_id: string; target_id: string; type: string }>(
        `SELECT source_id, target_id, type FROM relations WHERE source_id IN (${ph}) AND target_id IN (${ph}) AND tx_to IS NULL AND type <> 'co_occurs'`,
        ids,
      );
      const byId = new Map(all.map((e) => [e.id, e]));
      const excerpts = await groundingExcerpts(ctx.store, ids.slice(0, 5));
      const prompt = [
        'Entities:',
        ...all.slice(0, 15).map((e) => `- ${e.name} (${e.type})${e.description ? ': ' + e.description.slice(0, 120) : ''}`),
        '',
        'Relations:',
        ...rels.slice(0, 20).map((r) => `- ${byId.get(r.source_id)?.name} —${r.type}→ ${byId.get(r.target_id)?.name}`),
        '',
        'Excerpts:',
        ...excerpts.map((x) => `> ${x}`),
      ].join('\n');
      body = await llm.complete([{ role: 'system', content: COMMUNITY_SYSTEM }, { role: 'user', content: prompt }], { maxTokens: 800 });
      by = llm.label;
      at = new Date().toISOString();
      writePageCache(ctx.dataDir, pagePath, { inputsSha: plan.inputsSha, model: llm.label, body, generatedAt: at });
    }
    return {
      frontmatter: {
        title: `${a.name} cluster`,
        type: 'concept',
        entities: all.slice(0, 15).map((e) => e.name),
        generated: okfGenerated(`knode-os/${by}`, at),
        knode: knodeMeta('concept_cluster', { entities: all.map((e) => e.id) }),
      },
      regions: { body: body.trim() },
    };
  },
};

async function groundingExcerpts(store: Store, entityIds: string[]): Promise<string[]> {
  if (entityIds.length === 0) return [];
  const ph = entityIds.map((_, i) => `$${i + 1}`).join(',');
  const rows = await store.query<{ content: string }>(
    `SELECT DISTINCT c.content
     FROM entity_mentions m JOIN chunks c ON c.id = m.chunk_id
     WHERE m.entity_id IN (${ph})
     LIMIT 5`,
    entityIds,
  );
  return rows.map((r) => r.content.replace(/\s+/g, ' ').slice(0, 300));
}

/** The Summarize stage, which is what `ctx.llm` runs on (`summaryLlmClient`). */
function documentSummaryLlm(ctx: PagesContext): LlmClient {
  return ctx.llm;
}

function conceptLlm(ctx: PagesContext): LlmClient {
  return ctx.config.extraction.conceptLlm
    ? new LlmClient(resolveRoutedLlmConfig(ctx.config.llm, ctx.config.extraction.conceptLlm, routeTargets(ctx.config), ctx.config.extraction.tier2Model))
    : ctx.llm;
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
  hot_topics: hotTopics,
  concept_cluster: conceptCluster,
};

/* ----------------------------- composition ------------------------------ */

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** Merge generated frontmatter keys and regions into an existing page (or build a fresh one). */
export function composePage(existing: string | null, frontmatter: Record<string, unknown>, regions: Record<string, string>): string {
  if (!existing) {
    const front = Object.keys(frontmatter).length ? matter.stringify('', frontmatter).trimEnd() : '';
    const body = Object.entries(regions).map(([id, c]) => renderRegion(id, c)).join('\n\n');
    return `${front ? front + '\n\n' : ''}${body}\n`;
  }
  let parsed: { data: Record<string, unknown>; content: string };
  try {
    const p = matter(existing);
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
  return matter.stringify('\n' + body, data).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
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
  const [row] = await store.query<{ path: string; status: string }>(`SELECT path, status FROM pages WHERE path = $1`, [pagePath]);

  const plan = await gen.plan(ctx, pagePath, opts.hint);
  if (!plan) {
    if (row && row.status !== 'archived') await archivePage(ctx, pagePath, actor);
    else if (row) await archivePage(ctx, pagePath, actor);
    return 'archived';
  }
  const live = await findLiveScope(store, 'page', pagePath);
  if (live && live.sha === plan.inputsSha && !opts.force) {
    if (row?.status === 'dirty') await store.query(`UPDATE pages SET status = 'active', dirty_reason = NULL WHERE path = $1`, [pagePath]);
    return 'unchanged';
  }
  if (gen.llm && !ctx.llm.enabled && !(await cachedRenderAvailable(ctx, gen, pagePath, plan))) return 'deferred';

  const rendered = await gen.render(ctx, pagePath, plan);
  if (!rendered) return 'deferred';

  const { file, region } = splitPagePath(pagePath);
  const abs = safePath(ctx.dataDir, file);
  const existing = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  if (gen.mode === 'file' && existing && !row) {
    let generated = false;
    try {
      generated = isGeneratedConcept(matter(existing).data as Record<string, unknown>);
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

  await applyScope(store, { kind: 'page', key: pagePath }, plan.inputsSha, { actor, at: opts.at, meta: { kind, file } }, async (w) => {
    await w.page({ path: pagePath, kind, generator: `${kind}@${gen.version}`, inputs_sha: plan.inputsSha, file_sha: fileSha, regions });
    await w.deps({ kind: 'page', id: pagePath }, plan.deps);
    if (kind === 'entity_stub') await w.setWikiPath((plan.data.entity as { id: string }).id, pagePath);
    if (gen.mode === 'file') await w.writeFile(file, text);
    else await w.writeRegion(file, region ?? 'body', regionContent ?? '');
  });

  // search projection of the (re)written file
  await applyDocScope(ctx, file, 'wiki', { queueTier1: false, actor });
  return 'regenerated';
}

async function cachedRenderAvailable(ctx: PagesContext, gen: PageGenerator, pagePath: string, plan: PagePlan): Promise<boolean> {
  if (gen.kind === 'concept_cluster') return readPageCache(ctx.dataDir, pagePath)?.inputsSha === plan.inputsSha;
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
    await applyDocScope(ctx, file, 'wiki', { queueTier1: false, actor });
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

  // drift: file gone → archive; file edited inside our regions → dirty
  const live = await store.query<{ path: string; kind: PageKind; status: string; file_sha: string | null; regions: { id: string; sha: string }[] }>(
    `SELECT path, kind, status, file_sha, regions FROM pages WHERE status IN ('active', 'dirty')`,
  );
  for (const p of live) {
    const { file } = splitPagePath(p.path);
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

/** Create stub pages for high-mention live entities that don't have a wiki page yet. */
export async function ensureEntityStubs(ctx: PagesContext, opts: { minMentions?: number; max?: number; actor?: string } = {}): Promise<string[]> {
  const entities = await ctx.store.query<{ id: string }>(
    `SELECT id FROM entities WHERE wiki_path IS NULL AND mention_count >= $1 AND tx_to IS NULL AND canonical_id IS NULL ORDER BY mention_count DESC LIMIT $2`,
    [opts.minMentions ?? 2, opts.max ?? 30],
  );
  const created: string[] = [];
  for (const e of entities) {
    const pagePath = `wiki/entities/${e.id}.md`;
    restoreArchived(ctx.dataDir, pagePath);
    const r = await regeneratePage(ctx, pagePath, 'entity_stub', { actor: opts.actor });
    if (r === 'regenerated') created.push(pagePath);
  }
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

/** Summary pages for hot / fresh documents without one (cold docs live only in the sources index). */
export async function ensureSourceSummaries(ctx: PagesContext, opts: { limit?: number; actor?: string; onProgress?: (msg: string) => void } = {}): Promise<string[]> {
  const progress = opts.onProgress ?? (() => {});
  const docs = await ctx.store.query<DocumentRow>(
    `SELECT * FROM documents WHERE root = 'docs' AND status = 'indexed' AND kind = 'source' ORDER BY updated_at DESC LIMIT $1`,
    [opts.limit ?? 20],
  );
  const heat = await getDocHeat(ctx.store, docs.map((d) => d.id), ctx.config.heat);
  const graceMs = ctx.config.extraction.freshnessBoostDays * 24 * 3600 * 1000;
  const isCold = (d: DocumentRow) =>
    (heat.get(d.id) ?? 0) < ctx.config.heat.coldThreshold && Date.now() - new Date(d.created_at).getTime() > graceMs;
  const created: string[] = [];
  for (const doc of docs) {
    if (isCold(doc)) continue;
    const slug = slugify(doc.title ?? path.basename(doc.path));
    const pagePath = `wiki/sources/${slug}.md`;
    const [existing] = await ctx.store.query<{ path: string }>(`SELECT path FROM pages WHERE path = $1 AND status <> 'archived'`, [pagePath]);
    if (existing) continue;
    try {
      restoreArchived(ctx.dataDir, pagePath);
      progress(`summarizing ${doc.path}`);
      const r = await regeneratePage(ctx, pagePath, 'source_summary', { actor: opts.actor, hint: { documentPath: doc.path } });
      if (r === 'regenerated') created.push(pagePath);
    } catch (err) {
      progress(`summary failed for ${doc.path}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return created;
}

export async function ensureSourcesIndex(ctx: PagesContext, opts: { actor?: string } = {}): Promise<RegenerateOutcome> {
  return regeneratePage(ctx, 'wiki/sources/index.md#sources', 'sources_index', { actor: opts.actor });
}

export async function ensureHotTopics(ctx: PagesContext, opts: { actor?: string; force?: boolean } = {}): Promise<RegenerateOutcome> {
  return regeneratePage(ctx, 'wiki/index.md#hot-topics', 'hot_topics', { actor: opts.actor, force: opts.force });
}
