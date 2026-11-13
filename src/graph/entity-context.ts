import { KnodeConfig } from '../config.js';
import { readSidecarPart } from '../fs/sidecar.js';
import { writeDeps } from '../lineage/deps.js';
import { breather } from '../pool.js';
import { Store } from '../store/db.js';
import { Queryable } from '../store/migrations.js';
import { groupBy, toIso } from '../store/temporal.js';
import { mergeSuggestionId } from './dedupe.js';
import { applyMerge } from './merge.js';
import { keyOf, typesCompatible } from './normalize.js';
import { entitiesNamed } from './resolve.js';
import { ExtractedEntity, slugify } from './store.js';

/**
 * Entity resolution by context (docs/design/29 §5), run by refine before the
 * duplicate audit. Two rules, both deterministic and conservative — a wrong
 * merge is worse than a missed one — and each records its reason:
 *
 *   rename   a claim says one entity was renamed to another ("Atlas项目更名为
 *            Orion", "Orion（原Atlas）", "renamed to", "formerly"): the old
 *            name merges into the new (reversible, `entities unmerge`).
 *            An alias list alone is weaker evidence — an extraction can file
 *            创业板 under A股 — so it only files a merge suggestion.
 *   namesake one person name whose documents fall into separate contexts at
 *            the same time — disjoint co-mentioned people and teams, each
 *            with an organization or project of its own — is two people. The
 *            smaller context's documents are re-applied from their sidecars
 *            (no model call) with the name resolved to a new entity
 *            "陈伟（平台组）"; entity_namesakes keeps the rule that resolution
 *            follows from then on (namesakeChoice).
 */

export interface EntityContextStats {
  merged: number;
  suggested: number;
  split: number;
  replayed: number;
}

/* ---------------------------------- rename ---------------------------------- */

const RENAME_MARKER = /更名为|改名为|更名成|改名成|易名为|renamed (?:to|as)|rebranded (?:to|as)|now (?:called|known as)/i;
const RENAME_TO = new RegExp(`(?:${RENAME_MARKER.source})\\s*[“"「《]?([^，,。；;（）()“”"」》\\s]{1,40})`, 'i');
const FORMERLY = /([^\s，,。；;（(]{1,40})\s*[（(]\s*(?:原名|原项目名|原|旧称|曾用名|formerly(?: known as)?|previously)[:：\s]*([^）)，,]{1,40})[）)]/i;
const FORMERLY_EN = /([A-Z][\w.&-]*(?: [A-Z][\w.&-]*){0,3}),? formerly (?:known as )?([A-Z][\w.&-]*(?: [A-Z][\w.&-]*){0,3})/;
const RENAME_SQL = '(更名|改名|易名|原名|原项目名|renamed|rebranded|formerly|now known as|now called)';

/** Old and new names a statement gives for one rename, as written; null when it gives none. */
export function renameIn(statement: string): { from: string | null; to: string; marker: number } | null {
  const text = statement.normalize('NFKC');
  let m = FORMERLY.exec(text) ?? FORMERLY_EN.exec(text);
  if (m) return { from: m[2].trim(), to: m[1].trim(), marker: m.index };
  m = RENAME_TO.exec(text);
  if (m) return { from: null, to: m[1].replace(/(?:项目|系统|平台|公司)$/, '').trim(), marker: m.index };
  return null;
}

interface Live {
  id: string;
  name: string;
  type: string;
  aliases: string[];
}

/** A person said no to merging these two: they undid such a merge, or rejected the suggestion themselves. */
async function refusedByPerson(store: Store, a: string, b: string): Promise<boolean> {
  const [undone] = await store.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM scopes WHERE kind = 'merge' AND key = ANY($1::text[]) AND status = 'disposed'`,
    [[a, b]],
  );
  if (undone.n > 0) return true;
  const [s] = await store.query<{ status: string; llm: unknown }>(`SELECT status, payload->'llm' AS llm FROM suggestions WHERE id = $1`, [mergeSuggestionId(a, b)]);
  return Boolean(s && s.status === 'rejected' && (s.llm === null || s.llm === undefined));
}

async function namesakePair(store: Store, a: string, b: string): Promise<boolean> {
  const [r] = await store.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM entity_namesakes WHERE (id = $1 AND base_id = $2) OR (id = $2 AND base_id = $1)`,
    [a, b],
  );
  return r.n > 0;
}

async function mergeRenames(store: Store, stats: EntityContextStats, progress: (msg: string) => void): Promise<void> {
  const claims = await store.query<{ id: string; statement: string; subject_id: string; path: string | null }>(
    `SELECT c.id, c.statement, c.subject_id, s.key AS path FROM claims c LEFT JOIN scopes s ON s.id = c.primary_scope_id
     WHERE c.tx_to IS NULL AND c.canonical_id IS NULL AND c.status = 'fact' AND c.statement ~* $1
     ORDER BY c.id`,
    [RENAME_SQL],
  );
  if (claims.length === 0) return;
  const entities = await store.query<Live>(`SELECT id, name, type, aliases FROM entities WHERE tx_to IS NULL AND canonical_id IS NULL`);
  for (const c of claims) {
    const rename = renameIn(c.statement);
    if (!rename) continue;
    const named = await entitiesNamed(store, [rename.to, ...(rename.from ? [rename.from] : [])]);
    const to = named.get(rename.to);
    if (!to) continue;
    let from = rename.from ? named.get(rename.from) : undefined;
    if (!rename.from) {
      // the old name stands before the marker: the longest live name of a compatible type written there
      const before = c.statement.normalize('NFKC').slice(0, rename.marker).toLowerCase();
      from = entities
        .filter((e) => e.id !== to.id && keyOf(e.name).length >= 2 && typesCompatible(e.type, to.type) && e.type !== 'concept' && before.includes(e.name.toLowerCase()))
        .sort((a, b) => b.name.length - a.name.length)
        .map((e) => ({ id: e.id, name: e.name, type: e.type, wikiPath: null }))[0];
    }
    if (!from || from.id === to.id || !typesCompatible(from.type, to.type)) continue;
    if ((await refusedByPerson(store, from.id, to.id)) || (await namesakePair(store, from.id, to.id))) continue;
    const reason = `更名：「${c.statement}」${c.path ? `（${c.path}）` : ''}`;
    try {
      const res = await applyMerge(store, { entityId: from.id, canonicalId: to.id, reason, actor: 'entity-context' });
      if (res.outcome === 'merged') {
        stats.merged++;
        progress(`entities: merged ${from.name} into ${to.name} — ${reason}`);
      }
    } catch (err) {
      progress(`entities: rename merge ${from.name} → ${to.name} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/**
 * An entity whose alias list names another live entity of the same specific
 * type: filed as a merge suggestion with the alias as its reason (the
 * duplicate audit's own cap does not hold it back), never merged on that alone.
 */
async function suggestAliasMerges(store: Store, stats: EntityContextStats): Promise<void> {
  const rows = await store.query<{ a: string; a_name: string; a_type: string; b: string; b_name: string; b_type: string; alias: string }>(
    // the aliases first, then the entities they name: joined the other way round, the planner
    // paired every entity with every other of its type (20k organizations: 4.5 minutes)
    `WITH al AS MATERIALIZED (
       SELECT ea.id, ea.name, ea.type, lower(a.alias) AS alias
       FROM entities ea CROSS JOIN LATERAL jsonb_array_elements_text(ea.aliases) AS a(alias)
       WHERE ea.tx_to IS NULL AND ea.canonical_id IS NULL AND ea.type NOT IN ('concept', 'other') AND length(a.alias) >= 2
     )
     SELECT al.id AS a, al.name AS a_name, al.type AS a_type, eb.id AS b, eb.name AS b_name, eb.type AS b_type, al.alias
     FROM al JOIN entities eb ON lower(eb.name) = al.alias
     WHERE eb.id <> al.id AND eb.tx_to IS NULL AND eb.canonical_id IS NULL AND eb.type = al.type`,
  );
  for (const r of rows) {
    const id = mergeSuggestionId(r.a, r.b);
    const [existing] = await store.query<{ status: string }>(`SELECT status FROM suggestions WHERE id = $1`, [id]);
    if (existing && existing.status !== 'stale') continue;
    if (await namesakePair(store, r.a, r.b)) continue;
    const reason = `"${r.a_name}" 的别名列表含有 "${r.b_name}"（同为 ${r.a_type}）`;
    await store.query(
      `INSERT INTO suggestions (id, kind, title, body, evidence, status, payload)
       VALUES ($1, 'merge', $2, $3, $4::jsonb, 'pending', $5::jsonb)
       ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, evidence = EXCLUDED.evidence, payload = EXCLUDED.payload, status = 'pending'`,
      [
        id, `合并重复实体: ${r.b_name} → ${r.a_name}`,
        `${reason}。接受后 "${r.b_name}" 会指向 "${r.a_name}"（可撤销：knode-os entities unmerge ${r.b}）。`,
        JSON.stringify([`${r.b_name} ↔ ${r.a_name}`, reason]),
        JSON.stringify({ entityId: r.b, canonicalId: r.a, score: 0.97, reason, llm: null }),
      ],
    );
    await writeDeps(store, { kind: 'suggestion', id }, [{ kind: 'entity', id: r.a, required: true }, { kind: 'entity', id: r.b, required: true }]);
    stats.suggested++;
  }
}

/* --------------------------------- namesakes --------------------------------- */

/** Entity types that tell one person's context from another's. */
const CONTEXT_TYPES = ['person', 'organization', 'project', 'product', 'component'];
/** Types that may anchor a context: the team, company or project a person belongs to. */
const ANCHOR_TYPES = new Set(['organization', 'project']);
/** Documents a person name needs before its contexts are compared. */
const MIN_DOCS = 6;
/** The most documents of one name compared (a celebrity in a news corpus is one person in many contexts). */
const MAX_DOCS = 600;

export interface NamesakeDoc {
  id: string;
  path: string;
  date: string | null;
  /** Entity ids co-mentioned with the name in this document (context types only). */
  context: Set<string>;
}

export interface NamesakeCluster {
  docs: NamesakeDoc[];
  /** Anchors: an organization or project in most of this cluster's documents and almost none of the other's. */
  anchors: string[];
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / Math.max(1, a.size + b.size - shared);
}

/**
 * The documents of one name split into contexts that are two people, or null.
 * Documents join when their co-mentions mostly agree (Jaccard ≥ 0.3), and a
 * split needs all of: two clusters holding ≥ 90% of the documents, each ≥ 3
 * documents and ≥ 15%; contexts that barely meet (Jaccard of their unions <
 * 0.25); an anchor of each side (≥ 60% of its documents, ≤ 5% of the other's);
 * and both active at the same time (their date ranges overlap by ≥ 30% of
 * the shorter) — a person who moved teams has one context before and another
 * after, which is no namesake. Exported for tests.
 */
export function namesakeClusters(docs: NamesakeDoc[], typeOf: (id: string) => string | undefined): [NamesakeCluster, NamesakeCluster] | null {
  if (docs.length < MIN_DOCS) return null;
  const parent = docs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      if (find(i) !== find(j) && jaccard(docs[i].context, docs[j].context) >= 0.3) parent[find(i)] = find(j);
    }
  }
  const groups = [...groupBy(docs.map((d, i) => ({ d, i })), (x) => String(find(x.i))).values()].map((g) => g.map((x) => x.d)).sort((a, b) => b.length - a.length);
  if (groups.length < 2) return null;
  const [a, b] = groups;
  if (a.length + b.length < 0.9 * docs.length) return null;
  if (b.length < 3 || b.length < 0.15 * docs.length) return null;
  const union = (g: NamesakeDoc[]) => new Set(g.flatMap((d) => [...d.context]));
  if (jaccard(union(a), union(b)) >= 0.25) return null;
  const share = (g: NamesakeDoc[], id: string) => g.filter((d) => d.context.has(id)).length / g.length;
  const anchorsOf = (own: NamesakeDoc[], other: NamesakeDoc[]) =>
    [...union(own)]
      .filter((id) => ANCHOR_TYPES.has(typeOf(id) ?? '') && share(own, id) >= 0.6 && share(other, id) <= 0.05)
      .sort((x, y) => share(own, y) - share(own, x) || x.localeCompare(y));
  const anchorsA = anchorsOf(a, b);
  const anchorsB = anchorsOf(b, a);
  if (anchorsA.length === 0 || anchorsB.length === 0) return null;
  const range = (g: NamesakeDoc[]) => {
    const dates = g.map((d) => d.date).filter((x): x is string => Boolean(x)).sort();
    return dates.length ? [Date.parse(dates[0]), Date.parse(dates[dates.length - 1])] as const : null;
  };
  const ra = range(a);
  const rb = range(b);
  if (!ra || !rb) return null;
  const overlap = Math.min(ra[1], rb[1]) - Math.max(ra[0], rb[0]);
  const shorter = Math.max(1, Math.min(ra[1] - ra[0], rb[1] - rb[0]));
  if (overlap < 0.3 * shorter) return null;
  return [{ docs: a, anchors: anchorsA }, { docs: b, anchors: anchorsB }];
}

/** Re-apply documents' tier-1 extractions from their sidecars; a document without a whole one is left alone (no model call is ever queued). */
async function replayDocuments(store: Store, config: KnodeConfig, docs: { id: string; path: string }[], progress: (msg: string) => void): Promise<number> {
  const { enqueueTier1, planQueuedDocument, dequeueDocument, queuedDocuments } = await import('./tier1.js');
  let replayed = 0;
  for (const d of docs) {
    const t1 = readSidecarPart(store.dataDir, d.path, 'tier1');
    if (!t1 || t1.status !== 'done') continue;
    const [queuedBefore] = await store.query<{ n: number }>(`SELECT count(*)::int AS n FROM extraction_queue WHERE document_id = $1`, [d.id]);
    await enqueueTier1(store, d.id);
    const [row] = (await queuedDocuments(store)).filter((r) => r.document_id === d.id);
    if (!row) continue;
    const planned = await planQueuedDocument(store, config, row, { onProgress: progress });
    if (planned.kind === 'replayed') replayed++;
    // not replayable after all: back as it was, so no model call is spent on a decision of ours
    else if (planned.kind === 'plan' && queuedBefore.n === 0) await dequeueDocument(store, d.id);
  }
  return replayed;
}

async function splitNamesakes(store: Store, config: KnodeConfig | undefined, stats: EntityContextStats, progress: (msg: string) => void): Promise<void> {
  const people = await store.query<{ id: string; name: string; docs: number }>(
    `SELECT e.id, e.name, count(DISTINCT m.document_id)::int AS docs
     FROM entities e JOIN entity_mentions m ON m.entity_id = e.id
     WHERE e.tx_to IS NULL AND e.canonical_id IS NULL AND e.type = 'person'
       AND NOT EXISTS (SELECT 1 FROM entities x WHERE x.canonical_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM entity_namesakes n WHERE n.base_id = e.id OR n.id = e.id)
     GROUP BY e.id, e.name HAVING count(DISTINCT m.document_id) BETWEEN $1 AND $2`,
    [MIN_DOCS, MAX_DOCS],
  );
  if (people.length === 0) return;
  const pause = breather();
  for (const p of people) {
    await pause();
    const rows = await store.query<{ document_id: string; path: string; doc_date: string | Date | null; other: string | null; other_type: string | null }>(
      `WITH d AS (SELECT DISTINCT document_id FROM entity_mentions WHERE entity_id = $1)
       SELECT d.document_id, doc.path, doc.doc_date, o.id AS other, o.type AS other_type
       FROM d JOIN documents doc ON doc.id = d.document_id
       LEFT JOIN entity_mentions m ON m.document_id = d.document_id AND m.entity_id <> $1
       LEFT JOIN entities o ON o.id = m.entity_id AND o.tx_to IS NULL AND o.type = ANY($2::text[])`,
      [p.id, CONTEXT_TYPES],
    );
    const types = new Map<string, string>();
    const docs = [...groupBy(rows, (r) => r.document_id).values()].map((g) => {
      const context = new Set<string>();
      for (const r of g) if (r.other && r.other_type) {
        context.add(r.other);
        types.set(r.other, r.other_type);
      }
      return { id: g[0].document_id, path: g[0].path, date: toIso(g[0].doc_date), context };
    });
    const split = namesakeClusters(docs, (id) => types.get(id));
    if (!split) continue;
    const [base, other] = split;
    const anchorNames = async (ids: string[]) => (await store.query<{ id: string; name: string }>(`SELECT id, name FROM entities WHERE id = ANY($1::text[])`, [ids]))
      .sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id)).map((e) => e.name);
    const otherAnchors = await anchorNames(other.anchors);
    const baseAnchors = await anchorNames(base.anchors);
    const label = otherAnchors[0];
    const variantName = `${p.name}（${label}）`;
    const variantId = slugify(variantName);
    const reason = `同名不同人：${base.docs.length} 篇文档与 ${baseAnchors.join('、')} 同现，${other.docs.length} 篇与 ${otherAnchors.join('、')} 同现，同一时期内两组共现实体几乎不重合`;
    await store.query(
      `INSERT INTO entity_namesakes (id, base_id, name, label, anchors, base_anchors, documents, reason)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)
       ON CONFLICT (id) DO UPDATE SET anchors = EXCLUDED.anchors, base_anchors = EXCLUDED.base_anchors, documents = EXCLUDED.documents, reason = EXCLUDED.reason`,
      [variantId, p.id, p.name, label, JSON.stringify(otherAnchors), JSON.stringify(baseAnchors), JSON.stringify(other.docs.map((d) => d.path).sort()), reason],
    );
    stats.split++;
    progress(`entities: ${p.name} split — ${reason}`);
    if (config) stats.replayed += await replayDocuments(store, config, other.docs, progress);
    // the two never come up as duplicates again: recorded as a decided pair
    const [variant] = await store.query<{ id: string }>(`SELECT id FROM entities WHERE id = $1 AND tx_to IS NULL`, [variantId]);
    if (variant) {
      const id = mergeSuggestionId(p.id, variantId);
      await store.query(
        `INSERT INTO suggestions (id, kind, title, body, evidence, status, payload)
         VALUES ($1, 'merge', $2, $3, $4::jsonb, 'rejected', $5::jsonb)
         ON CONFLICT (id) DO UPDATE SET status = 'rejected', body = EXCLUDED.body, payload = EXCLUDED.payload`,
        [id, `合并重复实体: ${variantName} → ${p.name}`, reason, JSON.stringify([reason]), JSON.stringify({ entityId: variantId, canonicalId: p.id, reason, namesake: true, llm: { same: false, confidence: 1, reason, model: 'rule' } })],
      );
    }
  }
}

/** The namesake rules for these names: name (lower case) → its variants. */
export interface NamesakeRule {
  id: string;
  base_id: string;
  name: string;
  label: string;
  anchors: string[];
  base_anchors: string[];
}

export async function namesakeRules(q: Queryable, names: string[]): Promise<Map<string, NamesakeRule[]>> {
  const lower = [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))];
  if (lower.length === 0) return new Map();
  const rows = await q.query<NamesakeRule>(
    `SELECT id, base_id, name, label, anchors, base_anchors FROM entity_namesakes WHERE lower(name) = ANY($1::text[])`,
    [lower],
  );
  return groupBy(rows, (r) => r.name.toLowerCase());
}

/**
 * Which of a split name's people a document means: the variant whose anchors
 * the document's own entities name most, if it names more of them than of the
 * base person's; else null (the base person keeps the name).
 */
export function namesakeChoice(rules: NamesakeRule[], documentEntities: ExtractedEntity[]): NamesakeRule | null {
  const names = new Set(documentEntities.flatMap((e) => [e.name, ...(e.aliases ?? [])]).map((n) => n.trim().toLowerCase()));
  const score = (anchors: string[]) => anchors.filter((a) => names.has(a.toLowerCase())).length;
  const base = rules.length ? score(rules[0].base_anchors) : 0;
  let best: { rule: NamesakeRule; s: number } | null = null;
  for (const r of rules) {
    const s = score(r.anchors);
    if (s > 0 && s > base && (!best || s > best.s)) best = { rule: r, s };
  }
  return best?.rule ?? null;
}

/** Refine's entity step: rename merges, alias suggestions, namesake splits. */
export async function resolveEntityContext(store: Store, opts: { config?: KnodeConfig; onProgress?: (msg: string) => void } = {}): Promise<EntityContextStats> {
  const progress = opts.onProgress ?? (() => {});
  const stats: EntityContextStats = { merged: 0, suggested: 0, split: 0, replayed: 0 };
  await mergeRenames(store, stats, progress);
  await suggestAliasMerges(store, stats);
  await splitNamesakes(store, opts.config, stats, progress);
  return stats;
}
