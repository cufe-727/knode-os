import crypto from 'node:crypto';
import { mapLimit } from '../../bench/util.js';
import type { LlmClient } from '../../llm/client.js';
import { foldSpace, seededKey } from '../pack.js';
import type { GoldFact, GoldItem, ListSpec, Task } from '../types.js';
import { CORPUS_TASK_MIN_DOCS, DEEP_HOP_MIN } from '../types.js';
import { DocText, oracleCheck } from './gold.js';

/**
 * Corpus-level tasks for packs whose sources come without a script
 * (docs/design/23 §2.1): profiles, timelines, contradictions and aggregates
 * whose evidence spans at least five documents, and chains of three or four
 * facts in different documents. The author model (Claude) drafts; what makes
 * the gold usable is checked without it:
 *
 * - entities are clustered once, then found in the documents by their names
 *   (no model), and only those in 5–N documents are used;
 * - every statement behind an item carries an exact quote that must occur in
 *   its document;
 * - an aggregate is bounded by keywords any qualifying document must contain:
 *   every document holding one is read, so the list is complete within that
 *   bound, and padding that holds none cannot change it;
 * - a chain is kept only when the author, reading its documents alone,
 *   answers it as the gold does (the oracle check).
 *
 * Profiles are scored on recall (the statements are what the author found,
 * not provably all there is); aggregates and contradictions on F1.
 */

export interface CorpusPlan {
  profile?: number;
  timeline?: number;
  contradiction?: number;
  aggregate?: number;
  /** Chains of 3–4 facts. */
  deep?: number;
  /** An entity in more documents than this is too broad to profile (default 30, at most a third of the corpus). */
  maxDocs?: number;
}

const hash = (...parts: string[]) => crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 10);
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');
const langName = (lang: string) => (lang === 'zh' ? 'Chinese' : 'English');
const CJK = /[㐀-鿿]/;

/** Does `text` name `name` — as a substring in Chinese, as a whole word in Latin script? */
export function mentions(text: string, name: string): boolean {
  if (!name || name.length < 2) return false;
  if (CJK.test(name)) return text.includes(name);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

/** Up to `max` characters of `text` around the places it names any of `names`, merged, in order. */
export function excerpt(text: string, names: string[], radius = 700, max = 6000): string {
  const spans: [number, number][] = [];
  const lower = text.toLowerCase();
  for (const n of names) {
    if (!n || n.length < 2) continue;
    const needle = CJK.test(n) ? n : n.toLowerCase();
    const hay = CJK.test(n) ? text : lower;
    for (let i = hay.indexOf(needle); i >= 0 && spans.length < 200; i = hay.indexOf(needle, i + needle.length)) spans.push([Math.max(0, i - radius), Math.min(text.length, i + needle.length + radius)]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const s of spans) {
    const last = merged.at(-1);
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  let out = '';
  for (const [a, b] of merged) {
    const part = text.slice(a, b);
    if (out.length + part.length > max) {
      out += (out ? '\n…\n' : '') + part.slice(0, Math.max(0, max - out.length));
      break;
    }
    out += (out ? '\n…\n' : '') + part;
  }
  return out;
}

export interface Entity {
  name: string;
  aliases: string[];
  type: string;
  docs: string[];
}

export interface Statement {
  id: string;
  entity: string;
  doc: string;
  text: string;
  quote: string;
  date?: string;
}

type Draft = Omit<Task, 'evidence'> & { evidence: Task['evidence'] };

const spec = (s: Partial<ListSpec>): ListSpec => ({ match: 'judge', ordered: false, maxItems: 10, requireDocs: false, primary: 'f1', ...s });

/** Calls in groups whose text stays under `budget` characters. */
function packed<T>(units: T[], size: (u: T) => number, budget: number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let n = 0;
  for (const u of units) {
    if (cur.length && n + size(u) > budget) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(u);
    n += size(u);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Entities the facts name, clustered by the author, found in the documents by name. */
export async function corpusEntities(author: LlmClient, facts: GoldFact[], docs: DocText[], opts: { lang: string; maxDocs: number; log?: (m: string) => void }): Promise<Entity[]> {
  const counts = new Map<string, { name: string; docs: Set<string> }>();
  for (const f of facts) for (const e of f.entities) {
    const k = norm(e);
    if (k.length < 2) continue;
    const c = counts.get(k) ?? counts.set(k, { name: e.trim(), docs: new Set() }).get(k)!;
    c.docs.add(f.doc);
  }
  const candidates = [...counts.values()].filter((c) => c.docs.size >= 2).sort((a, b) => b.docs.size - a.docs.size).slice(0, 150);
  if (!candidates.length) return [];
  const r = await author.completeJson<{ entities?: { name?: string; aliases?: string[]; type?: string }[] }>([
    { role: 'system', content: `These names were extracted from a document collection. Group the names that refer to the same specific entity (a person, organization, company, product, law, paper, place, event or named method), give each group a canonical name as the documents write it, its other names, and a type. Leave out generic words that are not one specific entity (e.g. "market", "investors", "AI", "the government", "this paper"). Write names in ${langName(opts.lang)} where the documents do.
Answer with JSON: {"entities":[{"name":"…","aliases":["…"],"type":"person|organization|company|product|law|paper|place|event|method|other"}]}` },
    { role: 'user', content: JSON.stringify(candidates.map((c) => ({ name: c.name, documents: c.docs.size }))) },
  ], { maxTokens: 4000 });
  const out: Entity[] = [];
  const seen = new Set<string>();
  for (const e of r.entities ?? []) {
    if (!e.name || seen.has(norm(e.name))) continue;
    seen.add(norm(e.name));
    const names = [e.name, ...(e.aliases ?? [])].map(String).filter((n) => n.trim().length >= 2);
    const inDocs = docs.filter((d) => names.some((n) => mentions(d.text, n))).map((d) => d.path);
    if (inDocs.length >= CORPUS_TASK_MIN_DOCS && inDocs.length <= opts.maxDocs) out.push({ name: e.name.trim(), aliases: (e.aliases ?? []).map(String).filter((a) => a.trim() && norm(a) !== norm(e.name!)), type: e.type ?? 'other', docs: inDocs });
  }
  opts.log?.(`corpus tasks: ${out.length} entities in ${CORPUS_TASK_MIN_DOCS}–${opts.maxDocs} documents (of ${candidates.length} candidate names)`);
  return out;
}

/** Every statement each document makes about the chosen entities, each with an exact quote. */
export async function sweepStatements(author: LlmClient, entities: Entity[], docs: DocText[], opts: { lang: string; log?: (m: string) => void }): Promise<Statement[]> {
  const byDoc = new Map(docs.map((d) => [d.path, d]));
  const units = [...new Set(entities.flatMap((e) => e.docs))].map((path) => {
    const doc = byDoc.get(path)!;
    const here = entities.filter((e) => e.docs.includes(path));
    return { doc, here, text: excerpt(doc.text, here.flatMap((e) => [e.name, ...e.aliases])) };
  }).filter((u) => u.text);
  const out: Statement[] = [];
  let rejected = 0;
  await mapLimit(packed(units, (u) => u.text.length + 200, 12_000), 3, async (group) => {
    const r = await author.completeJson<{ statements?: { doc?: string; entity?: string; text?: string; quote?: string; date?: string }[] }>([
      { role: 'system', content: `For each document excerpt, list EVERY distinct statement it makes about each entity listed for it: one checkable claim each (what, when, how much, who said or did it), self-contained, in ${langName(opts.lang)}. Give "quote": a short span copied EXACTLY from the excerpt that states it (8–80 characters), and "date": the date the statement is about (YYYY-MM-DD, YYYY-MM or YYYY) when the excerpt gives or implies one, else "". Skip passing mentions that say nothing about the entity.
Answer with JSON: {"statements":[{"doc":"<path>","entity":"<entity name>","text":"…","quote":"…","date":"…"}]}` },
      { role: 'user', content: group.map((u) => `<excerpt path="${u.doc.path}"${u.doc.date ? ` date="${u.doc.date}"` : ''} entities="${u.here.map((e) => e.name).join('; ')}">\n${u.text}\n</excerpt>`).join('\n\n') },
    ], { maxTokens: 6000 });
    for (const s of r.statements ?? []) {
      const u = group.find((x) => x.doc.path === s.doc);
      const ent = u?.here.find((e) => norm(e.name) === norm(s.entity ?? '') || e.aliases.some((a) => norm(a) === norm(s.entity ?? '')));
      if (!u || !ent || !s.text || !s.quote) continue;
      if (!foldSpace(u.doc.text).includes(foldSpace(s.quote))) {
        rejected++;
        continue;
      }
      out.push({ id: `s${out.length + 1}`, entity: ent.name, doc: u.doc.path, text: s.text.trim(), quote: s.quote, ...(s.date && /^\d{4}(-\d{2}){0,2}$/.test(s.date) ? { date: s.date } : {}) });
    }
  }, (err) => opts.log?.(`statement sweep failed: ${err instanceof Error ? err.message : String(err)}`));
  opts.log?.(`corpus tasks: ${out.length} statements about ${entities.length} entities (${rejected} quotes not in their document)`);
  return out;
}

interface Assembly {
  entity?: string;
  facts?: { label?: string; statements?: string[] }[];
  timeline?: { label?: string; date?: string; statements?: string[] }[];
  conflicts?: { about?: string; sides?: { label?: string; statements?: string[] }[] }[];
}

const Q = {
  profile: (lang: string, e: string) => (lang === 'zh' ? `这些材料里关于“${e}”都说了些什么？逐条列出每个不同的事实。` : `What do these documents say about ${e}? List every distinct fact.`),
  timeline: (lang: string, e: string) => (lang === 'zh' ? `“${e}”的情况（状态、角色或数字）随时间是怎么变化的？按时间顺序列出每个变化及其日期。` : `How did ${e}'s state, role or figures change over time? List each change in order, with its date.`),
  contradiction: (lang: string, e: string) => (lang === 'zh' ? `关于“${e}”，哪些材料的说法互相矛盾？列出每个分歧中各方的说法和出处。` : `Which documents disagree about ${e}? For each disagreement, list what each side says and where.`),
};

/** Profiles, timelines and contradictions of each entity, from its statements. */
export async function assembleEntityTasks(author: LlmClient, entities: Entity[], statements: Statement[], docs: DocText[], opts: { lang: string; plan: CorpusPlan; prefix: string; seed: string | number; log?: (m: string) => void }): Promise<Draft[]> {
  const docDate = new Map(docs.map((d) => [d.path, d.date]));
  const byId = new Map(statements.map((s) => [s.id, s]));
  const of = new Map<string, Statement[]>();
  for (const s of statements) (of.get(s.entity) ?? of.set(s.entity, []).get(s.entity)!).push(s);
  const usable = entities.filter((e) => new Set((of.get(e.name) ?? []).map((s) => s.doc)).size >= CORPUS_TASK_MIN_DOCS);
  const out: Draft[] = [];
  const counts = { profile: 0, timeline: 0, contradiction: 0 };
  const groups: Entity[][] = [];
  for (let i = 0; i < usable.length; i += 2) groups.push(usable.slice(i, i + 2));
  const assemblies = await mapLimit(groups, 3, async (group) => author.completeJson<{ entities?: Assembly[] }>([
    { role: 'system', content: `Each entity comes with the statements a document collection makes about it (id, document, document date, date, text). For each entity:
- "facts": merge statements that say the same thing; one entry per distinct fact (a short label in ${langName(opts.lang)}, and the ids of the statements behind it). At most 25, the most informative first.
- "timeline": the entity's state, role or figures as they change over time — one entry per change, in chronological order, each with its date (YYYY-MM-DD or YYYY-MM) and statement ids. Only real changes of the same thing (a price target raised, a role taken, a rule amended); [] when there are fewer than five.
- "conflicts": where statements contradict each other (different numbers, opposite claims or forecasts about the same thing, different dates for the same event) — "about" what, and each side's label and statement ids. [] when none do. Differences of opinion on the same question count; statements about different times do not.
Answer with JSON: {"entities":[{"entity":"<name>","facts":[{"label":"…","statements":["s1"]}],"timeline":[{"label":"…","date":"…","statements":["s2"]}],"conflicts":[{"about":"…","sides":[{"label":"…","statements":["s3"]}]}]}]}` },
    { role: 'user', content: JSON.stringify(group.map((e) => ({ entity: e.name, statements: (of.get(e.name) ?? []).map((s) => ({ id: s.id, doc: s.doc, docDate: docDate.get(s.doc) ?? '', date: s.date ?? '', text: s.text })) }))) },
  ], { maxTokens: 8000 }), (err) => opts.log?.(`assembly failed: ${err instanceof Error ? err.message : String(err)}`));

  const docsOf = (ids: string[] | undefined, entity: string) => [...new Set((ids ?? []).map((i) => byId.get(i)).filter((s): s is Statement => Boolean(s) && s!.entity === entity).map((s) => s.doc))];
  const ordered = [...usable].sort((a, b) => seededKey(opts.seed, a.name).localeCompare(seededKey(opts.seed, b.name)));
  const asmOf = new Map<string, Assembly>();
  for (const r of assemblies) for (const a of r?.entities ?? []) if (a.entity) asmOf.set(norm(a.entity), a);
  for (const e of ordered) {
    const a = asmOf.get(norm(e.name));
    if (!a) continue;
    const terms = [e.name, ...e.aliases];
    const all = of.get(e.name) ?? [];
    const evidenceOf = (docsList: string[]) => docsList.map((doc) => ({ doc, ...(all.find((s) => s.doc === doc) ? { quote: all.find((s) => s.doc === doc)!.quote } : {}) }));
    // profile: every distinct fact, scored on recall
    const facts: GoldItem[] = (a.facts ?? []).filter((f) => f.label).map((f) => ({ label: f.label!, aliases: [], weight: 1, docs: docsOf(f.statements, e.name) })).filter((f) => f.docs!.length).slice(0, 25);
    const factDocs = [...new Set(facts.flatMap((f) => f.docs!))];
    if (counts.profile < (opts.plan.profile ?? 0) && facts.length >= 3 && factDocs.length >= CORPUS_TASK_MIN_DOCS) {
      counts.profile++;
      out.push({ id: `${opts.prefix}-p-${hash(e.name)}`, suite: 'usage', type: 'profile', lang: opts.lang, question: Q.profile(opts.lang, e.name), scoring: 'set', items: facts,
        list: spec({ primary: 'recall', maxItems: Math.min(40, facts.length + 10) }), closedWorld: { terms, prefixes: [] }, evidence: evidenceOf(factDocs), meta: { entity: e.name, origin: 'drafted' } });
    }
    // timeline: dated changes in order
    const steps: GoldItem[] = (a.timeline ?? []).filter((t) => t.label && t.date && /^\d{4}(-\d{2}){0,2}$/.test(t.date)).map((t) => ({ label: t.label!, aliases: [], weight: 1, date: t.date!, docs: docsOf(t.statements, e.name) })).filter((t) => t.docs!.length)
      .sort((x, y) => x.date!.localeCompare(y.date!));
    const stepDocs = [...new Set(steps.flatMap((s) => s.docs!))];
    if (counts.timeline < (opts.plan.timeline ?? 0) && steps.length >= CORPUS_TASK_MIN_DOCS && stepDocs.length >= CORPUS_TASK_MIN_DOCS) {
      counts.timeline++;
      out.push({ id: `${opts.prefix}-t-${hash(e.name)}`, suite: 'usage', type: 'timeline', lang: opts.lang, question: Q.timeline(opts.lang, e.name), scoring: 'set', items: steps.slice(0, 25),
        list: spec({ ordered: true, maxItems: Math.min(40, steps.length + 10) }), closedWorld: { terms, prefixes: [] }, evidence: evidenceOf(stepDocs), meta: { entity: e.name, origin: 'drafted' } });
    }
    // contradictions: each side with its documents; the reader has to read everything said about the entity to find them
    const sides: GoldItem[] = (a.conflicts ?? []).flatMap((cf) => (cf.sides ?? []).length >= 2 ? (cf.sides ?? []).filter((s) => s.label).map((s) => ({ label: `${cf.about ?? ''}: ${s.label}`.replace(/^: /, ''), aliases: [], weight: 1, docs: docsOf(s.statements, e.name) })) : [])
      .filter((s) => s.docs!.length);
    const allDocs = [...new Set(all.map((s) => s.doc))];
    if (counts.contradiction < (opts.plan.contradiction ?? 0) && sides.length >= 2 && allDocs.length >= CORPUS_TASK_MIN_DOCS) {
      counts.contradiction++;
      out.push({ id: `${opts.prefix}-c-${hash(e.name)}`, suite: 'usage', type: 'contradiction', lang: opts.lang, question: Q.contradiction(opts.lang, e.name), scoring: 'set', items: sides.slice(0, 20),
        list: spec({ requireDocs: true, maxItems: Math.min(40, sides.length + 10) }), closedWorld: { terms, prefixes: [] }, evidence: evidenceOf(allDocs), meta: { entity: e.name, origin: 'drafted' } });
    }
  }
  opts.log?.(`corpus tasks: ${counts.profile} profiles, ${counts.timeline} timelines, ${counts.contradiction} contradictions from ${usable.length} entities`);
  return out;
}

/**
 * Aggregates: the author proposes "list every X that …" with keywords any
 * qualifying document must contain; every document that holds one is read,
 * so the gold is complete within that bound.
 */
export async function draftAggregates(author: LlmClient, entities: Entity[], facts: GoldFact[], docs: DocText[], opts: { lang: string; n: number; prefix: string; seed: string | number; log?: (m: string) => void }): Promise<Draft[]> {
  if (opts.n <= 0) return [];
  const sample = [...facts].sort((a, b) => seededKey(opts.seed, a.id).localeCompare(seededKey(opts.seed, b.id))).slice(0, 80);
  const proposal = await author.completeJson<{ questions?: { question?: string; predicate?: string; keywords?: string[]; item?: string }[] }>([
    { role: 'system', content: `Propose ${Math.ceil(opts.n * 1.6)} questions about this document collection, in ${langName(opts.lang)}, that ask to list EVERY item satisfying a condition across the whole collection (e.g. every company whose target price was raised, every paper that evaluates on a given benchmark, every article that sets a time limit). Each should have roughly 5–20 answers spread over several documents. For each give: "question"; "predicate": the condition to check in one document; "keywords": 2–8 exact strings, as the documents would write them, at least one of which any document satisfying the predicate must contain; "item": what each answer is (a company name, a paper title, an article number…).
Answer with JSON: {"questions":[{"question":"…","predicate":"…","keywords":["…"],"item":"…"}]}` },
    { role: 'user', content: JSON.stringify({ entities: entities.slice(0, 60).map((e) => `${e.name} (${e.type}, ${e.docs.length} docs)`), facts: sample.map((f) => f.text) }) },
  ], { maxTokens: 4000 });
  const preds = (proposal.questions ?? []).filter((q) => q.question && q.predicate && q.keywords?.length).map((q, i) => ({ ...q, key: `q${i}`, keywords: q.keywords!.map(String).filter((k) => k.trim().length >= 2) }))
    .map((q) => ({ ...q, docs: docs.filter((d) => q.keywords.some((k) => mentions(d.text, k))) }))
    .filter((q) => q.docs.length >= CORPUS_TASK_MIN_DOCS && q.docs.length <= 40);
  if (!preds.length) return [];
  // one read of each document for every predicate whose keywords it holds
  const units = [...new Set(preds.flatMap((q) => q.docs.map((d) => d.path)))].map((path) => {
    const doc = docs.find((d) => d.path === path)!;
    const here = preds.filter((q) => q.docs.some((d) => d.path === path));
    return { doc, here, text: excerpt(doc.text, here.flatMap((q) => q.keywords), 800, 6000) };
  });
  const found = new Map<string, { name: string; doc: string; quote: string }[]>();
  await mapLimit(packed(units, (u) => u.text.length + 300, 12_000), 3, async (group) => {
    const r = await author.completeJson<{ items?: { doc?: string; predicate?: string; name?: string; quote?: string }[] }>([
      { role: 'system', content: `For each excerpt, check each predicate listed for it and list every item the excerpt shows satisfying it: "name" as the excerpt writes it, and "quote": a short span copied EXACTLY from the excerpt that shows it (8–80 characters). List nothing for a predicate the excerpt does not satisfy.
Answer with JSON: {"items":[{"doc":"<path>","predicate":"<predicate id>","name":"…","quote":"…"}]}` },
      { role: 'user', content: group.map((u) => `<excerpt path="${u.doc.path}">\n${u.text}\n</excerpt>\n<predicates path="${u.doc.path}">\n${u.here.map((q) => `${q.key}: ${q.predicate} (items: ${q.item ?? 'names'})`).join('\n')}\n</predicates>`).join('\n\n') },
    ], { maxTokens: 6000 });
    for (const it of r.items ?? []) {
      const u = group.find((x) => x.doc.path === it.doc);
      if (!u || !it.name || !it.quote || !it.predicate || !u.here.some((q) => q.key === it.predicate)) continue;
      if (!foldSpace(u.doc.text).includes(foldSpace(it.quote))) continue;
      (found.get(it.predicate) ?? found.set(it.predicate, []).get(it.predicate)!).push({ name: it.name.trim(), doc: u.doc.path, quote: it.quote });
    }
  }, (err) => opts.log?.(`aggregate sweep failed: ${err instanceof Error ? err.message : String(err)}`));
  // the same item under different names: merged once for all predicates
  const merge = await author.completeJson<{ predicates?: { predicate?: string; items?: { name?: string; aliases?: string[] }[] }[] }>([
    { role: 'system', content: 'For each predicate, merge the names that refer to the same item; give each item one name and its other names. Answer with JSON: {"predicates":[{"predicate":"<id>","items":[{"name":"…","aliases":["…"]}]}]}' },
    { role: 'user', content: JSON.stringify([...found].map(([predicate, list]) => ({ predicate, names: [...new Set(list.map((x) => x.name))] }))) },
  ], { maxTokens: 4000 }).catch(() => ({ predicates: [] }));
  const out: Draft[] = [];
  for (const q of preds) {
    const hits = found.get(q.key) ?? [];
    if (!hits.length) continue;
    const merged = merge.predicates?.find((p) => p.predicate === q.key)?.items ?? [...new Set(hits.map((h) => h.name))].map((name) => ({ name, aliases: [] as string[] }));
    const items: GoldItem[] = merged.filter((m) => m.name).map((m) => {
      const names = [m.name!, ...(m.aliases ?? [])].map(norm);
      return { label: m.name!, aliases: (m.aliases ?? []).filter((a) => norm(a) !== norm(m.name!)), weight: 1, docs: [...new Set(hits.filter((h) => names.includes(norm(h.name))).map((h) => h.doc))] };
    }).filter((it) => it.docs!.length);
    const itemDocs = [...new Set(items.flatMap((it) => it.docs!))];
    if (items.length < CORPUS_TASK_MIN_DOCS || items.length > 25 || itemDocs.length < CORPUS_TASK_MIN_DOCS) continue;
    const evidence = itemDocs.map((doc) => ({ doc, quote: hits.find((h) => h.doc === doc)!.quote }));
    const id = `${opts.prefix}-a-${hash(q.question!)}`;
    out.push({ id, suite: 'usage', type: 'aggregate', lang: opts.lang, question: q.question!, scoring: 'set', items, list: spec({ match: 'alias', maxItems: Math.min(40, items.length + 10) }),
      closedWorld: { terms: q.keywords, prefixes: [] }, evidence, meta: { predicate: q.predicate, keywords: q.keywords, origin: 'drafted' } });
    if (out.length >= opts.n) break;
  }
  opts.log?.(`corpus tasks: ${out.length} aggregates of ${preds.length} proposed within bounds`);
  return out;
}

/** Chains of 3–4 facts linked by shared entities, each in another document; the author writes the question, the oracle check keeps it. */
export async function draftChains(author: LlmClient, facts: GoldFact[], entities: Entity[], docs: DocText[], opts: { lang: string; n: number; prefix: string; seed: string | number; log?: (m: string) => void }): Promise<Draft[]> {
  if (opts.n <= 0) return [];
  const canon = new Map<string, string>();
  for (const e of entities) for (const n of [e.name, ...e.aliases]) canon.set(norm(n), e.name);
  const ents = (f: GoldFact) => [...new Set(f.entities.map((x) => canon.get(norm(x)) ?? x.trim()).filter((x) => x.length >= 2))];
  const byEntity = new Map<string, GoldFact[]>();
  for (const f of facts) for (const e of ents(f)) (byEntity.get(e) ?? byEntity.set(e, []).get(e)!).push(f);
  const chains: { facts: GoldFact[]; bridges: string[] }[] = [];
  const start = [...facts].filter((f) => ents(f).length >= 2).sort((a, b) => seededKey(opts.seed, a.id).localeCompare(seededKey(opts.seed, b.id)));
  const usedDocs = new Map<string, number>();
  for (const f1 of start) {
    if (chains.length >= opts.n * 3) break;
    const walk = (path: GoldFact[], bridges: string[], at: string, depth: number): { facts: GoldFact[]; bridges: string[] } | null => {
      if (depth === 0) return { facts: path, bridges };
      for (const next of (byEntity.get(at) ?? []).sort((a, b) => seededKey(opts.seed, a.id).localeCompare(seededKey(opts.seed, b.id)))) {
        if (path.some((p) => p.doc === next.doc || p.id === next.id)) continue;
        const onward = ents(next).filter((e) => e !== at && !bridges.includes(e) && !ents(path[0]).includes(e));
        if (depth > 1 && !onward.length) continue;
        const r = depth > 1 ? walk([...path, next], [...bridges, at], onward[0], depth - 1) : { facts: [...path, next], bridges: [...bridges, at] };
        if (r) return r;
      }
      return null;
    };
    const hops = chains.length % 3 === 2 ? 3 : 2; // about one chain in three has four facts
    for (const e of ents(f1)) {
      const r = walk([f1], [], e, hops);
      if (r && r.facts.every((f) => (usedDocs.get(f.doc) ?? 0) < 2)) {
        for (const f of r.facts) usedDocs.set(f.doc, (usedDocs.get(f.doc) ?? 0) + 1);
        chains.push(r);
        break;
      }
    }
  }
  if (!chains.length) return [];
  const drafts: Draft[] = [];
  for (let i = 0; i < chains.length; i += 6) {
    const group = chains.slice(i, i + 6);
    const r = await author.completeJson<{ tasks?: { chain?: number; question?: string; answer?: string }[] }>([
      { role: 'system', content: `Each chain is a sequence of facts from different documents, linked by the bridge entities listed. Write one question in ${langName(opts.lang)} that can only be answered by following the whole chain: start from what the first fact says, and ask for something in the last fact. Do NOT name the bridge entities in the question (describe them by their relation instead), so a reader must find each one in turn. Give the short answer.
Answer with JSON: {"tasks":[{"chain":<index>,"question":"…","answer":"…"}]}` },
      { role: 'user', content: JSON.stringify(group.map((c, k) => ({ chain: k, bridges: c.bridges, facts: c.facts.map((f) => f.text) }))) },
    ], { maxTokens: 3000 });
    for (const t of r.tasks ?? []) {
      const c = typeof t.chain === 'number' ? group[t.chain] : undefined;
      if (!c || !t.question || !t.answer) continue;
      // a question that names a bridge is a lookup, not a chain
      if (c.bridges.some((b) => t.question!.includes(b))) continue;
      drafts.push({ id: `${opts.prefix}-h-${hash(...c.facts.map((f) => f.id))}`, suite: 'usage', type: 'deep-hop', lang: opts.lang, question: t.question, answer: t.answer, scoring: 'judge',
        evidence: c.facts.map((f) => ({ doc: f.doc, ...(f.quote ? { quote: f.quote } : {}) })), meta: { hops: c.facts.length, bridges: c.bridges, origin: 'drafted' }, primary: true });
    }
  }
  // the oracle reads each document around the facts the chain uses, not its first pages
  const quotes = new Map<string, string[]>();
  for (const c of chains) for (const f of c.facts) if (f.quote) (quotes.get(f.doc) ?? quotes.set(f.doc, []).get(f.doc)!).push(f.quote);
  const texts = new Map(docs.map((d) => [d.path, quotes.has(d.path) ? excerpt(d.text, quotes.get(d.path)!, 1500, 5000) : d.text]));
  const kept = (await oracleCheck(author, drafts, texts, langName(opts.lang), opts.log)).slice(0, opts.n);
  opts.log?.(`corpus tasks: ${kept.length} chains kept of ${drafts.length} drafted (${chains.length} found)`);
  return kept.filter((t) => new Set(t.evidence.map((e) => e.doc)).size >= DEEP_HOP_MIN);
}

/** All corpus-level tasks a plan asks for, from the pack's gold facts and documents. */
export async function draftCorpusTasks(author: LlmClient, facts: GoldFact[], docs: DocText[], opts: { lang: string; plan: CorpusPlan; seed?: string | number; prefix?: string; log?: (m: string) => void }): Promise<Draft[]> {
  const seed = opts.seed ?? 0;
  const prefix = opts.prefix ?? 'k';
  const plan = opts.plan;
  // an entity in more than a third of a sizeable corpus is too broad to profile, unless the plan says otherwise
  const maxDocs = plan.maxDocs ?? Math.max(CORPUS_TASK_MIN_DOCS, Math.min(30, Math.floor(docs.length / 3)));
  const entities = await corpusEntities(author, facts, docs, { lang: opts.lang, maxDocs, log: opts.log });
  const wanted = Math.max(plan.profile ?? 0, plan.timeline ?? 0, plan.contradiction ?? 0);
  // more entities than tasks: not every entity has a timeline or a disagreement
  const chosen = [...entities].sort((a, b) => b.docs.length - a.docs.length || seededKey(seed, a.name).localeCompare(seededKey(seed, b.name))).slice(0, Math.ceil(wanted * 2.5));
  const out: Draft[] = [];
  if (chosen.length && wanted) {
    const statements = await sweepStatements(author, chosen, docs, { lang: opts.lang, log: opts.log });
    out.push(...await assembleEntityTasks(author, chosen, statements, docs, { lang: opts.lang, plan, prefix, seed, log: opts.log }));
  }
  out.push(...await draftAggregates(author, entities, facts, docs, { lang: opts.lang, n: plan.aggregate ?? 0, prefix, seed, log: opts.log }));
  out.push(...await draftChains(author, facts, entities, docs, { lang: opts.lang, n: plan.deep ?? 0, prefix, seed, log: opts.log }));
  return out;
}
