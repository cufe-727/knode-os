import { Store } from '../store/db.js';
import { toDateString } from '../store/temporal.js';
import { ClaimItem, SearchResult } from '../types.js';
import { keywordTerms, termCount } from './search.js';

/**
 * The multi-hop route of `ask` (docs/design/30 §3): resolve → relations →
 * read, for a bounded number of hops, without a model call per hop.
 *
 * From the entities the question names, each hop reads the live relations of
 * every entity on the frontier (the heaviest `READ_PER_ENTITY` of each, so a
 * hub cannot crowd out the one relation a person has), scores them, keeps the
 * best and moves to their far ends. A relation scores by
 *
 * - the question's terms its type, description and far end hold, the
 *   question's predicates widened by their synonyms (处理好 reads 修复, 名下
 *   reads 负责, "fixed" reads 修复), each term weighted by how few of this
 *   hop's relations hold it, so a word every candidate shares decides nothing;
 * - its far end lying within two relations of another entity the question
 *   names (not the one this branch started from): "（第七事业部）华鼎零售升级的那起
 *   事故" prefers the customer's incident whose group belongs to the seventh
 *   division over the customer's heavier incidents elsewhere. Each named
 *   entity weighs as a term does, by how few candidates it anchors.
 *
 * A branch may use a term only as often as the question does, so an
 * escalation leads to a second escalation only when the question asks for
 * two. Every branch takes its best step and the `FRONTIER` best of the rest
 * join it, so a hub cannot take a hop whole. Past the first hop only
 * relations that hold a term or are anchored lead on; the walk ends at
 * `maxHops`, or when none does. For every relation kept, the passage where
 * its two ends are mentioned together is read: that is the sentence that
 * states the hop. The passages come chain by chain, the best first.
 *
 * What the walk cannot do: pick "the Nth incident of the year" (an ordering,
 * not a relation), or bridge a rename the index holds as two unrelated
 * entities. Those stay with the answer's completion or with entity
 * resolution.
 *
 * What `ask` gets: the relations walked, as facts with their source; the
 * bridge passages, sharing the top of the context with the SAG search's; and the entities
 * reached, whose claims join the facts. One completion still writes the
 * answer.
 */

export interface WalkStep {
  hop: number;
  relationId: string;
  source: string;
  sourceId: string;
  target: string;
  targetId: string;
  type: string;
  description: string;
  path: string | null;
  validFrom: string | null;
  validTo: string | null;
  /** The scores of the relations on the way here, this one's included: a step deep on a well-matched branch scores most. */
  score: number;
  /** The step that reached this one's near end (an index into `steps`); null from an entity the question names. */
  parent: number | null;
}

export interface Walk {
  steps: WalkStep[];
  /** Entities reached past the named ones. */
  reached: string[];
  /** Passages where a walked relation's two ends are mentioned together, the best-scored step's first. */
  bridges: SearchResult[];
}

/** Relations kept per hop beside each branch's own best (and on the first hop, in all). */
const FRONTIER = 5;
/** Relations read per frontier entity and hop before scoring. */
const READ_PER_ENTITY = 150;
/** Question terms scored at most: a chain question is long, and its last clause names the last hop. */
const WALK_TERMS_MAX = 64;
/** Neighbours read per entity when finding what a named entity anchors (two relations out). */
const ANCHOR_FANOUT = 60;

/**
 * Predicates the question and the relation descriptions word differently:
 * when the question holds any spelling of a family, the relation may hold any
 * other. Verbs and the nouns relations are named by, not domain words.
 */
const PREDICATE_FAMILIES: string[][] = [
  ['修复', '修好', '处理好', '处理', '解决', '搞定', '排除', 'fixed', 'fix', 'resolved', 'resolve', 'repaired'],
  ['负责', '名下', '盯着', '跟进', '主导', '牵头', '在管', '主管', 'owner', 'owns', 'owned', 'responsible', 'in charge', 'leads'],
  ['接手', '接管', '交接', 'took over', 'take over', 'taken over', 'inherited'],
  ['提出', '预警', '提了', '提示', '上报', 'raised', 'flagged', 'warned'],
  ['风险', '隐患', 'risk', 'hazard'],
  ['事故', '故障', '宕机', 'incident', 'outage'],
  ['上线', '投产', '发布', '交付', '落地', 'launched', 'launch', 'released', 'shipped', 'went live', 'go-live'],
  ['调到', '调入', '调往', '调去', '转到', '转岗', '加入', 'transferred', 'moved to', 'joined'],
  ['升级', '投诉', 'escalated', 'escalation', 'complained'],
  ['客户', 'customer', 'client'],
  ['成员', '组员', 'member'],
];

/** A question term, and the key it is counted under: its own spelling, or its predicate family. */
export interface WalkTerm {
  text: string;
  key: string;
}

const isCjk = (w: string) => w.charCodeAt(0) >= 0x3400;
const occurrences = (q: string, w: string) => (isCjk(w) ? q.split(w).length - 1 : termCount(q, w));

/**
 * The question's terms with the spellings of the entities it names blanked
 * out (those are reached by the walk and weighed as anchors, and their
 * fragments — 事业部 of 第七事业部 — would match every sibling's name), the other
 * spellings of each predicate it uses, and how many times the question uses
 * each: a branch may match a term as often as the question says it
 * ("修复过一起…升级的事故…另一个组升级过事故——那一起是谁修复的" walks 升级 and 修复 twice).
 */
export function walkTerms(question: string, namedNames: string[] = []): { terms: WalkTerm[]; budget: Map<string, number> } {
  let q = question.toLowerCase();
  for (const name of [...namedNames].sort((x, y) => y.length - x.length)) if (name.length >= 2) q = q.split(name.toLowerCase()).join(' ');
  const terms = new Map<string, WalkTerm>();
  const budget = new Map<string, number>();
  for (const t of keywordTerms(q, WALK_TERMS_MAX)) {
    const text = t.toLowerCase();
    terms.set(text, { text, key: text });
    budget.set(text, Math.max(1, occurrences(q, text)));
  }
  PREDICATE_FAMILIES.forEach((family, i) => {
    // the longest spellings first, each blanked once counted: 处理好 is one use, not one of 处理好 and one of 处理
    let rest = q;
    let used = 0;
    for (const w of [...family].sort((x, y) => y.length - x.length)) {
      used += occurrences(rest, w);
      rest = rest.split(w).join(' ');
    }
    if (used === 0) return;
    const key = `family:${i}`;
    for (const w of family) terms.set(w, { text: w, key });
    budget.set(key, used);
  });
  return { terms: [...terms.values()], budget };
}

interface RelRow {
  id: string; source_id: string; target_id: string; source: string; target: string; type: string; description: string;
  weight: number; path: string | null; valid_from: string | Date | null; valid_to: string | Date | null;
}

interface Candidate {
  r: RelRow;
  farId: string;
  nearId: string;
  /** The term keys the relation holds that its branch has not used up. */
  held: string[];
  /** Named entities (other than this branch's own) whose two-relation neighbourhood holds the far end. */
  anchors: string[];
  score: number;
}

/** The entities within two live relations of each named one, the named entity itself left out. */
async function anchorSets(store: Store, named: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>(named.map((id) => [id, new Set<string>()]));
  if (named.length < 2) return out;
  const rows = await store.query<{ root: string; id: string }>(
    `WITH roots AS (SELECT unnest($1::text[]) AS root),
     e1 AS (
       SELECT roots.root, n.id FROM roots CROSS JOIN LATERAL (
         SELECT CASE WHEN r.source_id = roots.root THEN r.target_id ELSE r.source_id END AS id
         FROM relations r WHERE (r.source_id = roots.root OR r.target_id = roots.root) AND r.tx_to IS NULL AND r.type <> 'co_occurs'
         ORDER BY r.weight DESC, r.id LIMIT $2) n),
     e2 AS (
       SELECT e1.root, n.id FROM e1 CROSS JOIN LATERAL (
         SELECT CASE WHEN r.source_id = e1.id THEN r.target_id ELSE r.source_id END AS id
         FROM relations r WHERE (r.source_id = e1.id OR r.target_id = e1.id) AND r.tx_to IS NULL AND r.type <> 'co_occurs'
         ORDER BY r.weight DESC, r.id LIMIT $2) n)
     SELECT root, id FROM e1 UNION SELECT root, id FROM e2`,
    [named, ANCHOR_FANOUT],
  );
  for (const r of rows) if (r.id !== r.root) out.get(r.root)?.add(r.id);
  return out;
}

/** How much a signal held by `df` of `n` candidates tells them apart: near zero when every one holds it. */
const rarity = (df: number, n: number) => Math.log((n + 1) / (df + 0.5));

export async function walkRelations(store: Store, question: string, named: string[], opts: { maxHops?: number } = {}): Promise<Walk> {
  const maxHops = Math.min(Math.max(opts.maxHops ?? 4, 1), 4);
  const out: Walk = { steps: [], reached: [], bridges: [] };
  if (named.length === 0) return out;
  const names = await store.query<{ name: string; aliases: unknown }>(`SELECT name, aliases FROM entities WHERE id = ANY($1::text[])`, [named]);
  const { terms, budget } = walkTerms(question, names.flatMap((e) => [e.name, ...(Array.isArray(e.aliases) ? e.aliases.filter((a): a is string => typeof a === 'string') : [])]));
  const anchors = await anchorSets(store, named);
  // per entity reached: the named entities its branch descends from (a branch is not anchored by its own start),
  // and the term keys the relations on its way have used
  const origins = new Map<string, Set<string>>(named.map((id) => [id, new Set([id])]));
  const spent = new Map<string, Map<string, number>>();
  const pathScore = new Map<string, number>();
  const reachedBy = new Map<string, number>();
  const visited = new Set(named);
  const used = new Set<string>();
  let frontier = [...named];

  for (let hop = 1; hop <= maxHops && frontier.length > 0; hop++) {
    const rows = await store.query<RelRow & { near_id: string }>(
      `SELECT f.id AS near_id, r.id, r.source_id, r.target_id, se.name AS source, te.name AS target, r.type, r.description, r.weight,
              r.valid_from, r.valid_to,
              COALESCE((SELECT d.path FROM documents d WHERE d.id = r.document_id),
                       (SELECT s.key FROM evidence ev JOIN scopes s ON s.id = ev.scope_id
                        WHERE ev.kind = 'relation' AND ev.target_id = r.id AND ev.tx_to IS NULL ORDER BY ev.tx_from, s.key LIMIT 1)) AS path
       FROM unnest($1::text[]) AS f(id)
       CROSS JOIN LATERAL (
         SELECT * FROM relations r WHERE (r.source_id = f.id OR r.target_id = f.id) AND r.tx_to IS NULL AND r.type <> 'co_occurs'
         ORDER BY r.weight DESC, r.id LIMIT $2) r
       JOIN entities se ON se.id = r.source_id JOIN entities te ON te.id = r.target_id
       ORDER BY r.id, f.id`,
      [frontier, READ_PER_ENTITY],
    );
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      // a relation between two frontier entities is read once, from the first
      if (used.has(r.id) || seen.has(r.id)) continue;
      seen.add(r.id);
      const nearId = r.near_id;
      const forward = r.source_id === nearId;
      const farId = forward ? r.target_id : r.source_id;
      const near = forward ? r.source : r.target;
      const far = forward ? r.target : r.source;
      // the near end's own name says nothing about where the relation leads
      const text = `${r.type.replace(/_/g, ' ')} ${near ? r.description.split(near).join(' ') : r.description} ${far}`.toLowerCase();
      const spentHere = spent.get(nearId);
      const held = [...new Set(terms.filter((t) => termCount(text, t.text) > 0).map((t) => t.key))]
        .filter((k) => (spentHere?.get(k) ?? 0) < (budget.get(k) ?? 1));
      const from = origins.get(nearId) ?? new Set<string>();
      const anchoredBy = named.filter((n) => !from.has(n) && (n === farId || anchors.get(n)?.has(farId)));
      candidates.push({ r, farId, nearId, held, anchors: anchoredBy, score: 0 });
    }
    // a term or a named entity weighs by how few of this hop's candidates hold it
    const n = candidates.length;
    const df = new Map<string, number>();
    for (const c of candidates) for (const k of [...c.held, ...c.anchors.map((a) => `anchor:${a}`)]) df.set(k, (df.get(k) ?? 0) + 1);
    for (const c of candidates) {
      c.score = [...c.held, ...c.anchors.map((a) => `anchor:${a}`)].reduce((s, k) => s + rarity(df.get(k)!, n), 0);
    }
    const leads = (c: Candidate) => c.held.length > 0 || c.anchors.length > 0;
    const scored = candidates
      .filter((c) => !visited.has(c.farId) || leads(c))
      .sort((a, b) => b.score - a.score || b.r.weight - a.r.weight || (a.r.id < b.r.id ? -1 : 1));
    // past the first hop, only relations that match the question or lead toward another entity it names go on;
    // every branch takes its own best step, then the best of the rest fill the hop, so a hub cannot take it whole
    const eligible = hop === 1 ? scored : scored.filter(leads);
    const chosen = new Set<Candidate>();
    if (hop > 1) {
      const best = new Map<string, Candidate>();
      for (const c of eligible) if (!best.has(c.nearId)) best.set(c.nearId, c);
      for (const c of [...best.values()].slice(0, FRONTIER)) chosen.add(c);
    }
    for (let i = 0, extra = 0; i < eligible.length && extra < FRONTIER; i++) {
      if (!chosen.has(eligible[i])) {
        chosen.add(eligible[i]);
        extra++;
      }
    }
    const kept = eligible.filter((c) => chosen.has(c));
    if (kept.length === 0) break;
    const next: string[] = [];
    for (const { r, farId, nearId, held, score } of kept) {
      used.add(r.id);
      const total = (pathScore.get(nearId) ?? 0) + score;
      out.steps.push({
        hop, relationId: r.id, source: r.source, sourceId: r.source_id, target: r.target, targetId: r.target_id,
        type: r.type, description: r.description, path: r.path, validFrom: toDateString(r.valid_from), validTo: toDateString(r.valid_to), score: total,
        parent: reachedBy.get(nearId) ?? null,
      });
      if (visited.has(farId)) continue;
      pathScore.set(farId, total);
      reachedBy.set(farId, out.steps.length - 1);
      visited.add(farId);
      next.push(farId);
      out.reached.push(farId);
      origins.set(farId, new Set(origins.get(nearId)));
      const was = spent.get(nearId);
      const now = new Map(was);
      for (const k of held) now.set(k, (now.get(k) ?? 0) + 1);
      spent.set(farId, now);
    }
    frontier = next;
  }

  out.bridges = await bridgePassages(store, out.steps);
  return out;
}

/**
 * The steps as chains, best first: the best-scored step with the steps that
 * led to it, from the first hop down, then the next best not yet listed.
 */
export function chainOrder(steps: WalkStep[]): number[] {
  const out: number[] = [];
  const listed = new Set<number>();
  const byScore = steps.map((_, i) => i).sort((a, b) => steps[b].score - steps[a].score || a - b);
  for (const i of byScore) {
    const chain: number[] = [];
    for (let j: number | null = i; j !== null && !listed.has(j); j = steps[j].parent) chain.push(j);
    for (const j of chain.reverse()) {
      listed.add(j);
      out.push(j);
    }
  }
  return out;
}

/** For each step, one chunk mentioning both of its ends (the most recent document first), the best chain's first. */
async function bridgePassages(store: Store, steps: WalkStep[]): Promise<SearchResult[]> {
  if (steps.length === 0) return [];
  const rows = await store.query<{ i: number; chunk_id: string; document_id: string; path: string; title: string | null; content: string; doc_date: string | Date | null }>(
    `SELECT pair.i, c.id AS chunk_id, c.document_id, d.path, d.title, c.content, d.doc_date
     FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS pair(a, b, i)
     CROSS JOIN LATERAL (
       SELECT m1.chunk_id FROM entity_mentions m1
       JOIN entity_mentions m2 ON m2.chunk_id = m1.chunk_id AND m2.entity_id = pair.b
       WHERE m1.entity_id = pair.a
       LIMIT 1
     ) x
     JOIN chunks c ON c.id = x.chunk_id
     JOIN documents d ON d.id = c.document_id`,
    [steps.map((s) => s.sourceId), steps.map((s) => s.targetId)],
  );
  const byStep = new Map(rows.map((r) => [Number(r.i) - 1, r]));
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const i of chainOrder(steps)) {
    const r = byStep.get(i);
    if (!r || seen.has(r.chunk_id)) continue;
    seen.add(r.chunk_id);
    const step = steps[i];
    out.push({
      chunkId: r.chunk_id, documentId: r.document_id, path: r.path, title: r.title, content: r.content,
      docDate: toDateString(r.doc_date), score: 0, signals: { structural: step.hop },
      trace: { route: 'sag', hop: step.hop, bridgeEntities: [step.source, step.target] },
    });
  }
  return out;
}

/** The walked relations as facts `ask` lists: "A acquired B: description", with their source. */
export function stepsAsFacts(steps: WalkStep[]): (ClaimItem & { chunkId: string | null })[] {
  return steps.map((s) => ({
    id: `relation:${s.relationId}`,
    subject: s.source,
    object: s.target,
    type: s.type,
    statement: `${s.source} ${s.type.replace(/_/g, ' ')} ${s.target}${s.description ? `: ${s.description}` : ''}`,
    status: 'fact',
    kind: 'fact',
    startDate: s.validFrom,
    endDate: s.validTo,
    eventDate: null,
    path: s.path,
    chunkId: null,
  }));
}
