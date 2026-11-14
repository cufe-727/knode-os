import crypto from 'node:crypto';
import { canonicalMap } from '../graph/resolve.js';
import { AppContext } from '../context.js';
import { boundStatement, dialectForKind, escapeForDialect, runSourceQuery } from '../datasource/execute.js';
import { SourceDialect } from '../config.js';
import { claimsForEntities } from '../graph/query.js';
import { docLiveAt, search } from '../search/search.js';
import { pickRelevant } from '../search/facts.js';
import { datasetsForEntity } from '../store/queries.js';
import {
  NO_FILTER,
  ResolvedScopeFilter,
  ResolvedTemporal,
  evidenceFilterSql,
  resolveTemporal,
} from '../store/resolver.js';
import { Params, TimeInput, rowLiveAt } from '../store/temporal.js';
import { ClaimItem, EntityRow } from '../types.js';
import { entitySymbol, loadPlaybooks, Playbook, renderProbeSql, resolvePlaybook } from './playbook.js';

/**
 * Context Pack: one call that turns a raw user utterance into everything an
 * agent needs before answering —
 *
 *   1. entity matching   (utterance ↔ entities.name/aliases)
 *   2. graph expansion   (docs that mention them, time-bound claims with
 *                         stale/conflict flags, live tables they appear in)
 *   3. live probes       (playbook-declared native queries, short-TTL cached,
 *                         never persisted — freshness by construction)
 *   4. gap analysis      (what is missing + concrete next queries)
 *
 * Every build is recorded to pack_events so the learning loop can rewrite the
 * playbooks that drove it.
 */

export interface PackEntity {
  id: string;
  name: string;
  type: string;
  description: string;
  aliases: string[];
  wikiPath: string | null;
  mentionCount: number;
}

export interface PackClaim extends ClaimItem {
  /** The validity window has closed — the assertion is no longer known to hold. */
  stale: boolean;
  /** ids of claims about the same subject/type that contradict this one. */
  conflictsWith: string[];
}

export interface PackDoc {
  path: string;
  title: string | null;
  chunkId: string;
  content: string;
  score: number;
}

export interface PackDataset {
  id: string;
  source: string;
  table: string;
  kind: string;
  columns: string[];
  rowCount: number | null;
  refreshedAt: string | null;
  description: string;
  /** Which column linked the entity to this table, when known. */
  linkColumn: string | null;
  wikiPage: string;
}

export interface PackProbe {
  id: string;
  entity: string;
  source: string;
  sql: string;
  description?: string;
  ok: boolean;
  cached: boolean;
  asOf?: string;
  elapsedMs?: number;
  rows?: Record<string, unknown>[];
  error?: string;
}

export interface PackSuggestion {
  kind: 'query' | 'search' | 'freshness' | 'conflict' | 'playbook';
  text: string;
  source?: string;
  sql?: string;
}

export interface ContextPack {
  utterance: string;
  /** System time the pack describes (now, unless the caller asked for an earlier state). */
  asOf: string;
  /** World time claims were filtered by, when the caller asked for an instant. */
  validAt: string | null;
  /** World-time window claims were filtered by, when the caller asked for a range. */
  validRange: { from: string | null; to: string | null } | null;
  /** Every temporal / scope constraint the resolver applied, in words. */
  applied: string[];
  matchedEntities: PackEntity[];
  evidence: {
    docs: PackDoc[];
    claims: PackClaim[];
    datasets: PackDataset[];
  };
  liveData: PackProbe[];
  suggestions: PackSuggestion[];
  gaps: string[];
  playbooksUsed: string[];
  guidance: string[];
}

/** Probe results live only in this short-TTL memory cache — never in the index. */
const liveCache = new Map<string, { expires: number; probe: Omit<PackProbe, 'cached' | 'entity'> }>();

export interface PackOptions {
  record?: boolean;
  /** false: its search records no hits (src/stats/heat.ts). */
  track?: boolean;
  asOf?: TimeInput;
  validAt?: TimeInput;
  /** Resolved envelope; wins over the loose `asOf` / `validAt` shorthand above. */
  temporal?: ResolvedTemporal;
  filter?: ResolvedScopeFilter;
}

/** Claims read per pack before the ones that answer the utterance are picked: a hub entity has thousands. */
const PACK_CLAIM_POOL = 300;

export async function buildContextPack(
  ctx: AppContext,
  utterance: string,
  opts: PackOptions = {},
): Promise<ContextPack> {
  const { store, config } = ctx;
  const cfg = config.pack;
  const t = opts.temporal ?? resolveTemporal({ asOf: opts.asOf, validAt: opts.validAt });
  const f = opts.filter ?? NO_FILTER;
  const asOf = t.txTime ?? new Date().toISOString();
  // freshness is the one axis that bounds the *future*: a probe answer cached
  // longer than the caller will accept has to be fetched again.
  const liveTtl = t.freshnessSeconds === null ? cfg.liveTtlSeconds : Math.min(cfg.liveTtlSeconds, t.freshnessSeconds);

  /* 1 ── entity matching */
  const entities = await matchEntities(ctx, utterance, cfg.maxEntities, { temporal: t, filter: f });
  const entityIds = entities.map((e) => e.id);

  /* 2 ── graph expansion */
  const playbooks = loadPlaybooks(ctx.dataDir);
  const usedPlaybooks = new Map<string, Playbook>();
  const perEntityPlaybook = new Map<string, Playbook | null>();
  for (const e of entities) {
    const pb = resolvePlaybook(playbooks, e);
    perEntityPlaybook.set(e.id, pb);
    if (pb) usedPlaybooks.set(pb.path, pb);
  }
  const retrievalK = Math.max(cfg.maxDocs, ...[...usedPlaybooks.values()].map((p) => p.retrieval.k), 0) || cfg.maxDocs;
  const retrievalMode = [...usedPlaybooks.values()][0]?.retrieval.mode ?? 'hybrid';

  const docs = await collectDocs(ctx, utterance, entityIds, retrievalK, retrievalMode, t.txTime, f, opts.track);
  // the newest claims of the matched entities, then the ones that answer this utterance, spread over their sources
  const claims = annotateClaims(pickRelevant(utterance, await claimsForEntities(store, entityIds, PACK_CLAIM_POOL, { temporal: t, filter: f }), cfg.maxClaims, { named: () => true }));

  const datasets: PackDataset[] = [];
  const datasetsByEntity = new Map<string, PackDataset[]>();
  for (const e of entities) {
    const rows = await datasetsForEntity(store, e.id);
    const mapped = rows.map((r) => ({
      id: r.id,
      source: r.source_id,
      table: r.table_name,
      kind: r.kind,
      columns: (r.columns ?? []).map((c) => c.name),
      rowCount: r.row_count === null ? null : Number(r.row_count),
      refreshedAt: r.refreshed_at,
      description: r.description,
      linkColumn: /(?:value of|bound by (?:param|label)) [^.]+\.(\S+)/.exec(r.link_description ?? '')?.[1] ?? null,
      wikiPage: `wiki/datasets/${r.id}.md`,
    }));
    datasetsByEntity.set(e.id, mapped);
    for (const d of mapped) if (!datasets.some((x) => x.id === d.id)) datasets.push(d);
  }

  /* 3 ── live probes from playbooks */
  const liveData: PackProbe[] = [];
  const probedTables = new Set<string>();
  outer: for (const e of entities) {
    const pb = perEntityPlaybook.get(e.id);
    if (!pb) continue;
    for (const probe of pb.probes) {
      if (liveData.length >= cfg.maxProbes) break outer;
      const result = await runProbe(ctx, probe, e, cfg.probeRows, liveTtl);
      liveData.push({ ...result, entity: e.name });
      if (probe.table) probedTables.add(`${probe.source}.${probe.table}`);
    }
  }

  /* 4 ── gaps + suggestions */
  const { suggestions, gaps } = deriveSuggestions({
    utterance,
    entities,
    docs,
    claims,
    datasetsByEntity,
    liveData,
    probedTables,
    playbooks: [...usedPlaybooks.values()],
    staleNewsDays: cfg.staleNewsDays,
  });

  const pack: ContextPack = {
    utterance,
    asOf,
    validAt: t.validPoint ? t.validFrom : null,
    validRange: !t.validPoint && (t.validFrom || t.validTo) ? { from: t.validFrom, to: t.validTo } : null,
    applied: [...t.notes, ...f.notes],
    matchedEntities: entities,
    evidence: { docs, claims, datasets },
    liveData,
    suggestions,
    gaps,
    playbooksUsed: [...usedPlaybooks.keys()],
    guidance: [...usedPlaybooks.values()].map((p) => p.guidance).filter(Boolean),
  };

  if (opts.record !== false) await recordPackEvent(ctx, pack);
  return pack;
}

/* ------------------------------ entity match ------------------------------ */

export async function matchEntities(
  ctx: AppContext,
  utterance: string,
  max: number,
  scope: { temporal?: ResolvedTemporal; filter?: ResolvedScopeFilter } = {},
): Promise<PackEntity[]> {
  const asOf = scope.temporal?.txTime ?? null;
  const filter = scope.filter ?? NO_FILTER;
  const p = new Params([utterance]);
  const rows = await ctx.store.query<EntityRow>(
    `SELECT DISTINCT e.* FROM entities e
     LEFT JOIN LATERAL jsonb_array_elements_text(e.aliases) a(alias) ON true
     WHERE ${rowLiveAt('e', 'entity', p, asOf)}
       AND ${evidenceFilterSql('e.id', 'entity', p, filter, asOf)}
       AND (
        (length(e.name) >= 2 AND position(lower(e.name) IN lower($1)) > 0)
        OR (a.alias IS NOT NULL AND length(a.alias) >= 2 AND position(lower(a.alias) IN lower($1)) > 0))`,
    p.list,
  );
  const said = utterance.toLowerCase();
  const ranked = rows
    // tier-0 concept fragments (e.g. 2-char co-occurrence tokens) are too noisy to anchor a pack
    .filter((e) => e.type !== 'concept' || e.name.length >= 4)
    // a Latin name is a word of the utterance, not letters inside one: "PE" is not in "papers", "IC" not in "which"
    .filter((e) => [e.name, ...(Array.isArray(e.aliases) ? e.aliases : [])].some((n) => typeof n === 'string' && n.length >= 2 && namedIn(said, n.toLowerCase())))
    .sort((a, b) => typeRank(a.type) - typeRank(b.type) || b.name.length - a.name.length || b.mention_count - a.mention_count);
  const kept: EntityRow[] = [];
  for (const e of ranked) {
    if (kept.length >= max) break;
    // "宁德时代" beats its substrings; skip entities shadowed by an accepted one
    if (kept.some((k) => k.name.toLowerCase().includes(e.name.toLowerCase()))) continue;
    kept.push(e);
  }
  // an entity merged into another answers as the survivor
  const canon = await canonicalMap(ctx.store, kept.map((e) => e.id));
  if (canon.size > 0) {
    const targets = [...new Set(canon.values())];
    const ph = targets.map((_, i) => `$${i + 1}`).join(',');
    const survivors = new Map((await ctx.store.query<EntityRow>(`SELECT * FROM entities WHERE id IN (${ph}) AND tx_to IS NULL`, targets)).map((s) => [s.id, s]));
    const seen = new Set<string>();
    const merged: EntityRow[] = [];
    for (const e of kept) {
      const row = canon.has(e.id) ? survivors.get(canon.get(e.id)!) : e;
      if (!row || seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(row);
    }
    kept.splice(0, kept.length, ...merged);
  }
  return kept.map((e) => ({
    id: e.id,
    name: e.name,
    type: e.type,
    description: e.description,
    aliases: Array.isArray(e.aliases) ? e.aliases : [],
    wikiPath: e.wiki_path,
    mentionCount: e.mention_count,
  }));
}

/** True when lowercased `name` stands in lowercased `text` as written: anywhere for a CJK name, as whole words for a Latin one. */
function namedIn(text: string, name: string): boolean {
  const alnum = (ch: string | undefined) => ch !== undefined && /[a-z0-9]/.test(ch);
  for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) {
    if (!(alnum(name[0]) && alnum(text[i - 1])) && !(alnum(name[name.length - 1]) && alnum(text[i + name.length]))) return true;
  }
  return false;
}

function typeRank(type: string): number {
  const order = ['organization', 'person', 'product', 'project', 'technology', 'event', 'location', 'dataset', 'datasource', 'component', 'other', 'concept'];
  const i = order.indexOf(type);
  return i === -1 ? order.length : i;
}

/* -------------------------------- evidence -------------------------------- */

async function collectDocs(
  ctx: AppContext,
  utterance: string,
  entityIds: string[],
  k: number,
  mode: 'hybrid' | 'vector' | 'keyword' | 'sag',
  asOf?: TimeInput,
  filter: ResolvedScopeFilter = NO_FILTER,
  track?: boolean,
): Promise<PackDoc[]> {
  const out = new Map<string, PackDoc>();
  const hits = await search(ctx.store, ctx.embedder, utterance, {
    k,
    mode,
    heat: ctx.config.heat,
    sag: ctx.config.retrieval.sag,
    asOf,
    filter,
    track,
  });
  for (const h of hits) {
    out.set(h.chunkId, { path: h.path, title: h.title, chunkId: h.chunkId, content: trim(h.content), score: +h.score.toFixed(4) });
  }
  // mention-grounded chunks per entity (documents the graph knows are about them)
  for (const id of entityIds) {
    const mp = new Params([id]);
    const docCond = docLiveAt('d', mp, asOf, filter);
    const rows = await ctx.store.query<{ chunk_id: string; path: string; title: string | null; content: string; hits: number }>(
      `SELECT c.id AS chunk_id, d.path, d.title, c.content, count(*)::int AS hits
       FROM entity_mentions m JOIN chunks c ON c.id = m.chunk_id JOIN documents d ON d.id = c.document_id
       WHERE m.entity_id = $1 AND d.root = 'docs' AND ${docCond}
       GROUP BY c.id, d.path, d.title, c.content
       ORDER BY hits DESC LIMIT 2`,
      mp.list,
    );
    for (const r of rows) {
      if (!out.has(r.chunk_id)) {
        out.set(r.chunk_id, { path: r.path, title: r.title, chunkId: r.chunk_id, content: trim(r.content), score: r.hits });
      }
    }
  }
  return [...out.values()].slice(0, k + 4);
}

function trim(s: string): string {
  return s.length > 700 ? s.slice(0, 700) + '…' : s;
}

/** Flag expired claims and cross-annotate contradictions among them. */
export function annotateClaims(claims: ClaimItem[], today = new Date().toISOString().slice(0, 10)): PackClaim[] {
  const out: PackClaim[] = claims.map((c) => ({
    ...c,
    stale: Boolean(c.endDate && c.endDate < today),
    conflictsWith: [],
  }));
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const a = out[i];
      const b = out[j];
      if (a.subject !== b.subject || a.type !== b.type) continue;
      const differentSource = a.path !== b.path;
      const disputed = a.status === 'disputed' || b.status === 'disputed';
      if ((differentSource || disputed) && tokenOverlap(a.statement, b.statement) >= 0.35) {
        a.conflictsWith.push(b.id);
        b.conflictsWith.push(a.id);
      }
    }
  }
  return out;
}

function tokenOverlap(a: string, b: string): number {
  const tok = (s: string) => new Set(tokens(s));
  const ta = tok(a);
  const tb = tok(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common / Math.min(ta.size, tb.size);
}

function tokens(s: string): string[] {
  const out: string[] = [];
  for (const m of s.toLowerCase().matchAll(/[a-z0-9_.]{2,}/g)) out.push(m[0]);
  for (const run of s.matchAll(/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g)) {
    for (let i = 0; i + 2 <= run[0].length; i++) out.push(run[0].slice(i, i + 2));
  }
  return out;
}

/* ------------------------------- live probes ------------------------------ */

async function runProbe(
  ctx: AppContext,
  probe: { id: string; source: string; sql: string; description?: string },
  entity: PackEntity,
  maxRows: number,
  ttlSeconds: number,
): Promise<Omit<PackProbe, 'entity'>> {
  let sql: string;
  try {
    // a probe template is rendered for the dialect it lands in: SQL literal,
    // URL component, PromQL label value
    let dialect: SourceDialect = 'sql';
    try {
      dialect = ctx.datasources.get(probe.source).dialect;
    } catch {
      /* unknown source: the query below reports it */
    }
    sql = renderProbeSql(probe.sql, entity, (v) => escapeForDialect(dialect, v));
  } catch (err) {
    return { id: probe.id, source: probe.source, sql: probe.sql, description: probe.description, ok: false, cached: false, error: String(err instanceof Error ? err.message : err) };
  }
  const key = `${probe.source}|${sql}`;
  const hit = liveCache.get(key);
  if (hit && hit.expires > Date.now()) return { ...hit.probe, cached: true };

  try {
    const res = await runSourceQuery(ctx.datasources, probe.source, sql, { maxRows });
    const result: Omit<PackProbe, 'cached' | 'entity'> = {
      id: probe.id,
      source: probe.source,
      sql,
      description: probe.description,
      ok: true,
      asOf: res.asOf,
      elapsedMs: res.elapsedMs,
      rows: res.rows,
    };
    liveCache.set(key, { expires: Date.now() + ttlSeconds * 1000, probe: result });
    return { ...result, cached: false };
  } catch (err) {
    return { id: probe.id, source: probe.source, sql, description: probe.description, ok: false, cached: false, error: String(err instanceof Error ? err.message : err) };
  }
}

/* ---------------------------- gaps & suggestions --------------------------- */

function deriveSuggestions(input: {
  utterance: string;
  entities: PackEntity[];
  docs: PackDoc[];
  claims: PackClaim[];
  datasetsByEntity: Map<string, PackDataset[]>;
  liveData: PackProbe[];
  probedTables: Set<string>;
  playbooks: Playbook[];
  staleNewsDays: number;
}): { suggestions: PackSuggestion[]; gaps: string[] } {
  const suggestions: PackSuggestion[] = [];
  const gaps: string[] = [];

  if (input.entities.length === 0) {
    gaps.push('no known entity matched the utterance');
    suggestions.push({ kind: 'search', text: '未匹配到已知实体 — 先用 knode_search 检索原话，或用 knode_graph_search 找相近实体名。' });
  }
  if (input.entities.length > 0 && input.docs.length === 0) {
    gaps.push('no documents mention the matched entities');
    suggestions.push({ kind: 'search', text: '本地知识库没有相关文档 — 尝试换关键词 knode_search，或将新资料放入 raw/docs 后 ingest。' });
  }

  // unprobed linked tables → concrete native queries the agent can run next
  for (const e of input.entities) {
    for (const d of input.datasetsByEntity.get(e.id) ?? []) {
      if (input.probedTables.has(`${d.source}.${d.table}`)) continue;
      const value = d.linkColumn && /symbol|code|ticker/i.test(d.linkColumn) ? entitySymbol(e) : e.name;
      const dialect = dialectForKind(d.kind);
      const sql = boundStatement(dialect, d.table, d.linkColumn, d.linkColumn ? value : null);
      const unit = dialect === 'http' ? '端点' : dialect === 'promql' ? '指标' : '实时表';
      suggestions.push({
        kind: 'query',
        text: `${e.name} 可通过${unit} ${d.source}.${d.table} 获取（未在本 pack 中探测）— 可用 knode_query 拉取实时数据。`,
        source: d.source,
        sql,
      });
    }
    if ((input.datasetsByEntity.get(e.id) ?? []).length === 0 && e.type === 'organization') {
      gaps.push(`${e.name}: no linked live dataset`);
    }
  }

  // stale / conflicting claims
  for (const c of input.claims) {
    if (c.stale) {
      suggestions.push({
        kind: 'freshness',
        text: `断言已过期（有效期至 ${c.endDate}）：「${c.statement.slice(0, 80)}」— 勿直接引用，先查实时数据源或更新资讯。`,
      });
    }
  }
  const conflicted = input.claims.filter((c) => c.conflictsWith.length > 0);
  if (conflicted.length > 0) {
    const pairs = new Set<string>();
    for (const c of conflicted) {
      for (const other of conflicted) {
        if (!c.conflictsWith.includes(other.id)) continue;
        const key = [c.id, other.id].sort().join('|');
        if (pairs.has(key)) continue;
        pairs.add(key);
        suggestions.push({
          kind: 'conflict',
          text: `事实冲突：「${c.statement.slice(0, 60)}」(${c.path ?? '?'}, ${c.startDate ?? '?'}) vs 「${other.statement.slice(0, 60)}」(${other.path ?? '?'}, ${other.startDate ?? '?'}) — 以较新日期或原生数据源为准。`,
        });
      }
    }
    gaps.push(`${pairs.size} conflicting claim pair(s) need adjudication`);
  }

  // claim freshness for matched entities
  if (input.entities.length > 0 && input.claims.length > 0) {
    const latest = input.claims.map((c) => c.startDate ?? '').filter(Boolean).sort().pop();
    if (latest) {
      const ageDays = (Date.now() - new Date(latest).getTime()) / 86_400_000;
      if (ageDays > input.staleNewsDays) {
        gaps.push(`latest dated claim is ${Math.floor(ageDays)} days old`);
        suggestions.push({
          kind: 'freshness',
          text: `最新带日期的断言停留在 ${latest}（超过 ${input.staleNewsDays} 天）— 建议先查实时行情表或搜索更新资讯再下结论。`,
        });
      }
    }
  }

  for (const probe of input.liveData) {
    if (!probe.ok) {
      gaps.push(`probe ${probe.id} failed: ${probe.error}`);
      suggestions.push({ kind: 'playbook', text: `探针 ${probe.id}（${probe.source}）失败：${probe.error} — 数据源可能未启动，或该 playbook 需要修订。` });
    }
  }

  // playbook-authored static suggestions come last
  for (const pb of input.playbooks) {
    for (const s of pb.suggestions) suggestions.push({ kind: 'playbook', text: s });
  }

  return { suggestions, gaps };
}

/* --------------------------------- events --------------------------------- */

/**
 * Packs and resolves share one history table: `pack_events` is now a view over
 * `receipts`, so the learning loop keeps its query while every context
 * assembly — with or without a plan — lands in the same place.
 */
async function recordPackEvent(ctx: AppContext, pack: ContextPack): Promise<void> {
  const id = `p_${crypto.createHash('sha256').update(`${pack.utterance}|${pack.asOf}`).digest('hex').slice(0, 22)}`;
  await ctx.store.query(
    `INSERT INTO receipts (id, kind, query, entities, playbooks, datasets, probes, gaps, summary)
     VALUES ($1, 'pack', $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       entities = EXCLUDED.entities, playbooks = EXCLUDED.playbooks, datasets = EXCLUDED.datasets,
       probes = EXCLUDED.probes, gaps = EXCLUDED.gaps, summary = EXCLUDED.summary, created_at = now()`,
    [
      id,
      pack.utterance.slice(0, 500),
      JSON.stringify(pack.matchedEntities.map((e) => ({ id: e.id, name: e.name, type: e.type }))),
      JSON.stringify(pack.playbooksUsed),
      JSON.stringify(pack.evidence.datasets.map((d) => d.id)),
      JSON.stringify(pack.liveData.map((p) => ({ id: p.id, source: p.source, ok: p.ok, ms: p.elapsedMs ?? null, error: p.error ?? null }))),
      JSON.stringify(pack.gaps),
      JSON.stringify({
        docCount: pack.evidence.docs.length,
        claimCount: pack.evidence.claims.length,
        staleCount: pack.evidence.claims.filter((c) => c.stale).length,
        conflictCount: pack.evidence.claims.filter((c) => c.conflictsWith.length > 0).length,
      }),
    ],
  );
}
