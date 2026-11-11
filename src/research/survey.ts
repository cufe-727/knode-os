import fs from 'node:fs';
import path from 'node:path';
import { resolveRoutedLlmConfig, routeTargets } from '../config.js';
import { AppContext } from '../context.js';
import { GUIDE_FILE, isSeedTemplate } from '../fs/datadir.js';
import { loadOntology } from '../graph/ontology.js';
import { graphInsights } from '../graph/query.js';
import { isReservedWikiFile } from '../lineage/declared.js';
import { listDisputes } from '../lineage/trust.js';
import { LlmClient } from '../llm/client.js';
import { parseFrontmatter } from '../markdown.js';
import { Store } from '../store/db.js';
import { knowledgeStats, KnowledgeStats, listDatasets } from '../store/queries.js';
import { toIso } from '../store/temporal.js';

/**
 * A deterministic survey of the whole knowledge base — the orientation an
 * agent (or a person) needs before touching an unfamiliar workspace: what is
 * in it, how it is organised, how far extraction got, and whether a guide
 * (`AGENTS.md`) exists. No LLM; a dozen queries. Rendered into every
 * initialization brief, served as `knode_survey` / `GET /api/survey`, and
 * shown on the Wiki page's initialization card.
 */

export interface GuideStamp {
  job: string;
  at: string;
  agent: string;
}

export interface KbSurvey {
  at: string;
  stats: KnowledgeStats;
  extraction: { queued: number; llmEnabled: boolean };
  documents: {
    total: number;
    byFolder: { folder: string; n: number; latest: string | null }[];
    dateRange: { from: string | null; to: string | null };
    /** By file extension (`md`, `pdf`, …), the most first. */
    byType: { type: string; n: number }[];
    recent: { path: string; title: string | null; docDate: string | null }[];
  };
  entities: {
    total: number;
    byType: { type: string; n: number }[];
    top: { id: string; name: string; type: string; mentions: number; wikiPath: string | null }[];
    /** The entity pages whose claims come from the most documents. */
    topByDocuments: DocumentedEntity[];
    pages: number;
    isolated: number;
    merged: number;
    mergeCandidates: number;
  };
  relations: { total: number; byType: { type: string; n: number }[]; unknownPredicates: { raw: string; n: number }[] };
  claims: { total: number; byStatus: { status: string; n: number }[]; byKind: { kind: string; n: number }[]; eventRange: { from: string | null; to: string | null }; openDisputes: number };
  wiki: {
    views: number;
    humanPages: number;
    researchPages: number;
    overview: { exists: boolean; seeded: boolean; actor: string | null; researchAt: string | null };
  };
  guide: { exists: boolean; path: string; bytes: number; updatedAt: string | null; stamp: GuideStamp | null };
  ontology: { packs: string[]; entityTypes: string[]; relationTypes: string[] };
  datasources: { id: string; kind: string; datasets: number }[];
  notes: { purposeIsTemplate: boolean; schemaIsTemplate: boolean };
  lastInit: { id: string; status: string; startedAt: string | null; finishedAt: string | null } | null;
}

/** The runner stamps the guide's first line: `<!-- knode-init: {"job":…,"at":…,"agent":…} -->`. */
export function readGuideStamp(text: string): GuideStamp | null {
  const m = /^\s*<!--\s*knode-init:\s*(\{[^\n]*?\})\s*-->/.exec(text);
  if (!m) return null;
  try {
    const o = JSON.parse(m[1]) as Record<string, unknown>;
    return typeof o.job === 'string' ? { job: o.job, at: String(o.at ?? ''), agent: String(o.agent ?? '') } : null;
  } catch {
    return null;
  }
}

/**
 * How a document path is grouped in the survey: `raw/docs/a/b/c.md` → `raw/docs/a`,
 * `raw/docs/x.md` → `raw/docs`, `wiki/entities/x.md` → `wiki/entities`, `purpose.md` → `.`.
 * `FOLDER_SQL` below is the same rule in SQL — the grouping runs in the database so a
 * large base never pulls every document row into memory. Keep the two in step.
 */
export function folderOf(docPath: string): string {
  const parts = docPath.split('/');
  if (parts[0] === 'raw' && parts[1] === 'docs') return parts.length > 3 ? parts.slice(0, 3).join('/') : 'raw/docs';
  // one row per repository
  if (parts[0] === 'raw' && parts[1] === 'codebase' && parts.length > 3) return parts.slice(0, 3).join('/');
  if (parts.length > 2) return parts.slice(0, 2).join('/');
  return parts.length > 1 ? parts[0] : '.';
}

/** `folderOf` as SQL, so the grouping happens in the database. */
const FOLDER_SQL = `CASE
    WHEN path LIKE 'raw/docs/%/%' THEN regexp_replace(path, '^(raw/docs/[^/]+)/.*$', '\\1')
    WHEN path LIKE 'raw/docs/%' THEN 'raw/docs'
    WHEN path LIKE 'raw/codebase/%/%' THEN regexp_replace(path, '^(raw/codebase/[^/]+)/.*$', '\\1')
    WHEN path LIKE '%/%/%' THEN regexp_replace(path, '^([^/]+/[^/]+)/.*$', '\\1')
    WHEN path LIKE '%/%' THEN split_part(path, '/', 1)
    ELSE '.'
  END`;

function day(v: string | Date | null | undefined): string | null {
  const iso = toIso(v ?? null);
  return iso ? iso.slice(0, 10) : null;
}

/** An entity with a page, and how many claims from how many documents stand on it. */
export interface DocumentedEntity { id: string; name: string; type: string; wikiPath: string; claims: number; docs: number }

/**
 * What a knowledge base holds, in numbers: the part of the survey the
 * generated overview (`wiki/overview.md#holdings`) shows, without the graph
 * health queries (`graphInsights`: hubs, isolated entities) that only an
 * initialization brief needs. Plain counts and GROUP BYs over indexed
 * columns — one sort of the document rows per folder grouping — so it can run
 * whenever the navigation is refreshed.
 */
export interface KbHoldings {
  stats: KnowledgeStats;
  documents: { total: number; byFolder: KbSurvey['documents']['byFolder']; dateRange: { from: string | null; to: string | null }; byType: { type: string; n: number }[] };
  entities: { total: number; byType: { type: string; n: number }[]; pages: number; topByDocuments: DocumentedEntity[] };
  relations: { total: number; byType: { type: string; n: number }[] };
  claims: { total: number; byStatus: { status: string; n: number }[]; byKind: { kind: string; n: number }[]; eventRange: { from: string | null; to: string | null }; openDisputes: number };
}

/** Entity pages listed as the best documented. */
const TOP_DOCUMENTED = 20;

export async function surveyHoldings(store: Store, opts: { topByDocuments?: DocumentedEntity[] } = {}): Promise<KbHoldings> {
  const stats = await knowledgeStats(store);
  const folderRows = await store.query<{ folder: string; n: number; latest: string | Date | null }>(
    `SELECT ${FOLDER_SQL} AS folder, count(*)::int AS n, max(doc_date) AS latest
     FROM documents WHERE status = 'indexed' AND root <> 'traces'
     GROUP BY 1 ORDER BY n DESC, folder`,
  );
  const [docRange] = await store.query<{ n: number; lo: string | Date | null; hi: string | Date | null }>(
    `SELECT count(*)::int AS n, min(doc_date) AS lo, max(doc_date) AS hi FROM documents WHERE status = 'indexed' AND root = 'docs'`,
  );
  const docTypes = await store.query<{ type: string; n: number }>(
    `SELECT COALESCE(lower(substring(path from '\\.([A-Za-z0-9]+)$')), '(none)') AS type, count(*)::int AS n
     FROM documents WHERE status = 'indexed' AND root = 'docs' GROUP BY 1 ORDER BY n DESC, type`,
  );
  const entityTypes = await store.query<{ type: string; n: number }>(`SELECT type, count(*)::int AS n FROM entities WHERE tx_to IS NULL GROUP BY type ORDER BY n DESC`);
  const relationTypes = await store.query<{ type: string; n: number }>(
    `SELECT type, count(*)::int AS n FROM relations WHERE tx_to IS NULL AND type <> 'co_occurs' GROUP BY type ORDER BY n DESC`,
  );
  const [{ pages }] = await store.query<{ pages: number }>(
    `SELECT count(*)::int AS pages FROM entities WHERE wiki_path LIKE 'wiki/entities/%' AND tx_to IS NULL AND canonical_id IS NULL`,
  );
  const topByDocuments = opts.topByDocuments?.slice(0, TOP_DOCUMENTED) ?? (await store.query<DocumentedEntity>(
    `SELECT e.id, e.name, e.type, e.wiki_path AS "wikiPath", c.claims, c.docs
     FROM entities e
     JOIN LATERAL (
       SELECT count(*)::int AS claims, count(DISTINCT cl.primary_scope_id)::int AS docs
       FROM claims cl WHERE cl.subject_id = e.id AND cl.tx_to IS NULL AND cl.canonical_id IS NULL
     ) c ON c.claims > 0
     WHERE e.wiki_path LIKE 'wiki/entities/%' AND e.tx_to IS NULL AND e.canonical_id IS NULL
     ORDER BY c.docs DESC, c.claims DESC, e.name LIMIT $1`,
    [TOP_DOCUMENTED],
  ));
  const claimStatus = await store.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM claims WHERE tx_to IS NULL AND canonical_id IS NULL GROUP BY status ORDER BY n DESC`);
  const claimKind = await store.query<{ kind: string; n: number }>(`SELECT kind, count(*)::int AS n FROM claims WHERE tx_to IS NULL AND canonical_id IS NULL GROUP BY kind ORDER BY n DESC`);
  const [claimRange] = await store.query<{ lo: string | Date | null; hi: string | Date | null }>(`SELECT min(event_at) AS lo, max(event_at) AS hi FROM claims WHERE tx_to IS NULL AND canonical_id IS NULL`);
  const openDisputes = (await listDisputes(store, { status: 'open' })).length;
  return {
    stats,
    documents: { total: docRange?.n ?? 0, byFolder: folderRows.map((r) => ({ folder: r.folder, n: r.n, latest: day(r.latest) })), dateRange: { from: day(docRange?.lo), to: day(docRange?.hi) }, byType: docTypes },
    entities: { total: stats.entities, byType: entityTypes, pages, topByDocuments },
    relations: { total: stats.relations, byType: relationTypes },
    claims: { total: stats.claims, byStatus: claimStatus, byKind: claimKind, eventRange: { from: day(claimRange?.lo), to: day(claimRange?.hi) }, openDisputes },
  };
}

export async function surveyKnowledgeBase(ctx: AppContext): Promise<KbSurvey> {
  const { store, dataDir, config } = ctx;
  const holdings = await surveyHoldings(store);
  const { stats } = holdings;
  const insights = await graphInsights(store);
  const recentRows = await store.query<{ path: string; title: string | null; doc_date: string | Date | null }>(
    `SELECT path, title, doc_date FROM documents WHERE status = 'indexed' AND root = 'docs'
     ORDER BY doc_date DESC NULLS LAST, updated_at DESC LIMIT 15`,
  );
  const recent = recentRows.map((d) => ({ path: d.path, title: d.title, docDate: day(d.doc_date) }));

  const top = await store.query<{ id: string; name: string; type: string; mention_count: number; wiki_path: string | null }>(
    `SELECT id, name, type, mention_count, wiki_path FROM entities WHERE tx_to IS NULL AND canonical_id IS NULL ORDER BY mention_count DESC, evidence_count DESC LIMIT 20`,
  );

  // index.md / log.md are OKF navigation files, not anyone's prose
  const wikiDocs = await store.query<{ path: string; kind: string }>(`SELECT path, kind FROM documents WHERE status = 'indexed' AND root = 'wiki'`);
  const views = wikiDocs.filter((d) => d.kind === 'view').length;
  const wikiSources = wikiDocs.filter((d) => d.kind !== 'view' && !isReservedWikiFile(d.path)).length;
  const researchPaths = await store.query<{ output_path: string }>(`SELECT DISTINCT output_path FROM research_jobs WHERE status = 'done' AND output_path IS NOT NULL AND output_path LIKE 'wiki/%'`);
  const researchPages = researchPaths.filter((r) => fs.existsSync(path.join(dataDir, r.output_path))).length;

  const overviewFile = path.join(dataDir, 'wiki', 'overview.md');
  let overview: KbSurvey['wiki']['overview'] = { exists: false, seeded: false, actor: null, researchAt: null };
  if (fs.existsSync(overviewFile)) {
    const text = fs.readFileSync(overviewFile, 'utf8');
    const fm = parseFrontmatter(text).frontmatter;
    const research = fm.research && typeof fm.research === 'object' ? (fm.research as Record<string, unknown>) : null;
    overview = {
      exists: true,
      seeded: isSeedTemplate('wiki/overview.md', text),
      actor: typeof fm.actor === 'string' ? fm.actor : null,
      researchAt: typeof research?.at === 'string' ? research.at : null,
    };
  }

  const guideFile = path.join(dataDir, GUIDE_FILE);
  let guide: KbSurvey['guide'] = { exists: false, path: GUIDE_FILE, bytes: 0, updatedAt: null, stamp: null };
  if (fs.existsSync(guideFile)) {
    const st = fs.statSync(guideFile);
    const text = fs.readFileSync(guideFile, 'utf8');
    guide = { exists: text.trim().length > 0, path: GUIDE_FILE, bytes: st.size, updatedAt: st.mtime.toISOString(), stamp: readGuideStamp(text) };
  }

  const ont = loadOntology(dataDir);
  const datasets = await listDatasets(store);
  const datasources = (config.datasources ?? []).map((ds) => ({ id: ds.id, kind: String(ds.kind), datasets: datasets.filter((d) => d.source_id === ds.id).length }));

  const entityLlm = config.extraction.entityLlm
    ? new LlmClient(resolveRoutedLlmConfig(config.llm, config.extraction.entityLlm, routeTargets(config), config.extraction.tier1Model))
    : ctx.llm;

  const [lastInit] = await store.query<{ id: string; status: string; started_at: string | Date | null; finished_at: string | Date | null }>(
    `SELECT id, status, started_at, finished_at FROM research_jobs WHERE kind = 'init' ORDER BY created_at DESC LIMIT 1`,
  );

  const isTemplate = (rel: string) => {
    const abs = path.join(dataDir, rel);
    return fs.existsSync(abs) ? isSeedTemplate(rel, fs.readFileSync(abs, 'utf8')) : true;
  };

  return {
    at: new Date().toISOString(),
    stats,
    extraction: { queued: stats.extraction_queue, llmEnabled: entityLlm.enabled },
    documents: { ...holdings.documents, recent },
    entities: {
      total: insights.totals.entities,
      byType: insights.typeCounts,
      top: top.map((e) => ({ id: e.id, name: e.name, type: e.type, mentions: e.mention_count, wikiPath: e.wiki_path })),
      topByDocuments: holdings.entities.topByDocuments,
      pages: holdings.entities.pages,
      isolated: insights.isolated.length,
      merged: insights.merged,
      mergeCandidates: insights.mergeCandidates,
    },
    relations: { total: insights.totals.relations, byType: insights.relationTypeCounts, unknownPredicates: insights.unknownPredicates },
    claims: holdings.claims,
    wiki: { views, humanPages: Math.max(0, wikiSources - researchPages), researchPages, overview },
    guide,
    ontology: {
      packs: ont.packs,
      entityTypes: ont.entityTypes.map((e) => e.id),
      relationTypes: ont.relationTypes.filter((r) => !r.system).map((r) => r.id),
    },
    datasources,
    notes: { purposeIsTemplate: isTemplate('purpose.md'), schemaIsTemplate: isTemplate('schema.md') },
    lastInit: lastInit ? { id: lastInit.id, status: lastInit.status, startedAt: toIso(lastInit.started_at), finishedAt: toIso(lastInit.finished_at) } : null,
  };
}

/** The survey as the Chinese Markdown block a brief carries (`## 知识库概况`). */
export function renderSurvey(s: KbSurvey): string {
  const lines: string[] = ['## 知识库概况', ''];
  lines.push(`- 文档 ${s.documents.total}（分块 ${s.stats.chunks}）· 实体 ${s.entities.total} · 关系 ${s.relations.total} · claims ${s.claims.total} · 生成页 ${s.wiki.views} · 人写 wiki 页 ${s.wiki.humanPages} · 研究页 ${s.wiki.researchPages}`);
  lines.push(`- 资料日期范围：${s.documents.dateRange.from ?? '未知'} → ${s.documents.dateRange.to ?? '未知'}；claims 事件范围：${s.claims.eventRange.from ?? '未知'} → ${s.claims.eventRange.to ?? '未知'}`);
  lines.push(`- 抽取：${s.extraction.llmEnabled ? `LLM 已配置，待抽取 ${s.extraction.queued} 篇` : `未配置抽取 LLM（图谱只有 tier-0 的 frontmatter / 概念挖掘 / wikilink 证据），待抽取 ${s.extraction.queued} 篇`}`);
  lines.push(`- 指南 AGENTS.md：${s.guide.exists ? `已有（${s.guide.bytes} 字节${s.guide.stamp ? `，${s.guide.stamp.at.slice(0, 10)} 由 ${s.guide.stamp.agent} 生成` : ''}）` : '尚未生成'}；总览 wiki/overview.md：${s.wiki.overview.exists ? (s.wiki.overview.seeded ? '仍是初始模板' : `已有（${s.wiki.overview.actor ?? '人写'}）`) : '不存在'}`);
  lines.push(`- purpose.md ${s.notes.purposeIsTemplate ? '仍是模板' : '已填写'}；schema.md ${s.notes.schemaIsTemplate ? '仍是模板' : '已填写'}；本体包：${s.ontology.packs.join(', ') || '（无）'}`);
  lines.push('');
  if (s.documents.byFolder.length) {
    lines.push('### 目录', '');
    for (const f of s.documents.byFolder.slice(0, 30)) lines.push(`- ${f.folder === '.' ? '（数据目录根：purpose.md / schema.md）' : f.folder}：${f.n} 篇${f.latest ? `，最新 ${f.latest}` : ''}`);
    lines.push('');
  }
  if (s.documents.byType?.length) {
    lines.push('### 文件类型', '');
    lines.push(s.documents.byType.map((t) => `${t.type} ${t.n}`).join(' · '));
    lines.push('');
  }
  if (s.documents.recent.length) {
    lines.push('### 最近的文档（按文档日期）', '');
    for (const d of s.documents.recent) lines.push(`- ${d.path}${d.title ? ` — ${d.title}` : ''}${d.docDate ? `（${d.docDate}）` : ''}`);
    lines.push('');
  }
  if (s.entities.byType.length) {
    lines.push('### 实体类型', '');
    lines.push(s.entities.byType.map((t) => `${t.type} ${t.n}`).join(' · '));
    lines.push('');
  }
  if (s.entities.top.length) {
    lines.push('### 提及最多的实体', '');
    for (const e of s.entities.top) lines.push(`- ${e.name}（${e.type}，${e.mentions} 次提及${e.wikiPath ? `，页面 ${e.wikiPath}` : ''}）`);
    lines.push(`（孤立实体 ${s.entities.isolated}，已合并 ${s.entities.merged}，待审合并 ${s.entities.mergeCandidates}）`, '');
  }
  if (s.entities.topByDocuments?.length) {
    lines.push(`### 资料最多的实体页（共 ${s.entities.pages} 页）`, '');
    for (const e of s.entities.topByDocuments) lines.push(`- ${e.name}（${e.type}，${e.docs} 篇文档的 ${e.claims} 条 claims，页面 ${e.wikiPath}）`);
    lines.push('');
  }
  if (s.relations.byType.length) {
    lines.push('### 关系谓词', '');
    lines.push(s.relations.byType.map((t) => `${t.type} ${t.n}`).join(' · '));
    if (s.relations.unknownPredicates.length) lines.push(`未知谓词（已归入 related_to）：${s.relations.unknownPredicates.map((u) => `${u.raw} ${u.n}`).join(' · ')}`);
    lines.push('');
  }
  if (s.claims.byStatus.length) {
    lines.push('### claims', '');
    const kinds = (s.claims.byKind ?? []).filter((c) => c.kind !== 'fact');
    lines.push(`${s.claims.byStatus.map((c) => `${c.status} ${c.n}`).join(' · ')}${kinds.length ? `；其中 ${kinds.map((c) => `${c.kind} ${c.n}`).join(' · ')}` : ''}；未决争议 ${s.claims.openDisputes}`, '');
  }
  if (s.datasources.length) {
    lines.push('### 外部数据源', '');
    for (const d of s.datasources) lines.push(`- ${d.id}（${d.kind}，${d.datasets} 张表）`);
    lines.push('');
  }
  lines.push(`（以上由 knode_survey 于 ${s.at.slice(0, 19).replace('T', ' ')} 生成；实体类型：${s.ontology.entityTypes.join(', ')}；谓词：${s.ontology.relationTypes.join(', ')}）`);
  return lines.join('\n');
}
