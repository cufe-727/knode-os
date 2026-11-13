import type { EmbeddingProvider } from '../../ingest/embeddings.js';
import type { Judge } from '../judge.js';
import { entityResolution } from '../metrics/entities.js';
import { wilson } from '../metrics/stats.js';
import { normalizeAnswer } from '../metrics/text.js';
import { docText, LoadedPack, seededKey } from '../pack.js';
import { Bm25, Chunk, chunkDocs, rrf, VectorIndex } from '../retrieval.js';
import { recordKey } from '../runstore.js';
import type { KnowledgeUnit, ScoreRecord } from '../types.js';

/**
 * Scoring what a system generated from the sources (docs/design/23 §5,
 * generation). Every system's units are looked at the same way — the same
 * retrievers find the units that might state a gold fact, the same judge
 * decides — so no system's own index decides what counts as covered.
 * Raw source passages are never units: a system that only stores chunks
 * would otherwise cover everything by definition.
 */

export interface GenerationOptions {
  /** Gold facts checked for coverage (a seeded sample when there are more). */
  maxFacts?: number;
  /** Units sampled for precision, and atomic claims checked among them. */
  precisionUnits?: number;
  precisionClaims?: number;
  /** Characters of unit text a fact's lookup may show the judge (the fixed budget coverage is measured within). */
  budgetChars?: number;
  links?: number;
  contradictionPairs?: number;
  seed?: string | number;
}

type Put = (metric: string, value: number | null, extra?: { n?: number; ci?: [number, number]; detail?: Record<string, unknown> }) => void;

function sample<T>(items: T[], n: number, seed: string | number, key: (t: T) => string): T[] {
  return [...items].sort((a, b) => seededKey(seed, key(a)).localeCompare(seededKey(seed, key(b)))).slice(0, n);
}

function normName(s: string): string {
  return normalizeAnswer(s).replace(/\s+/g, '');
}

export async function scoreGeneration(
  pack: LoadedPack,
  system: string,
  units: KnowledgeUnit[],
  judge: Judge,
  embedder: EmbeddingProvider | null,
  opts: GenerationOptions = {},
): Promise<ScoreRecord[]> {
  const at = new Date().toISOString();
  const out: ScoreRecord[] = [];
  const put: Put = (metric, value, extra = {}) =>
    out.push({ key: recordKey('gen', pack.manifest.id, system, metric), pack: pack.manifest.id, system, suite: 'generation', metric, value, at, ...extra });
  const seed = opts.seed ?? 0;
  const corpusChars = pack.docs.reduce((s, d) => s + docText(pack, d.path).length, 0);

  /* ----------------------------- size and shape ----------------------------- */
  const byKind: Record<string, number> = {};
  for (const u of units) byKind[u.kind] = (byKind[u.kind] ?? 0) + 1;
  const unitChars = units.reduce((s, u) => s + u.text.length, 0);
  put('units', units.length, { detail: byKind });
  put('compression', corpusChars ? unitChars / corpusChars : null, { detail: { unitChars, corpusChars } });
  if (!units.length) return out;

  /* -------------------------------- coverage -------------------------------- */
  const budget = opts.budgetChars ?? 6000;
  const bm25 = new Bm25(units, (u) => `${u.title ?? ''} ${u.text}`);
  const vectors = embedder ? await VectorIndex.build(units, (u) => `${u.title ?? ''} ${u.text}`.slice(0, 2000), embedder) : null;
  const facts = sample(pack.facts, opts.maxFacts ?? 150, seed, (f) => f.id);
  const lookup = async (q: string): Promise<KnowledgeUnit[]> => {
    const lexical = bm25.search(q, 20).map((h) => h.item.id);
    const dense = vectors ? (await vectors.search(q, 20)).map((h) => h.item.id) : [];
    const byId = new Map(units.map((u) => [u.id, u]));
    const shown: KnowledgeUnit[] = [];
    let chars = 0;
    for (const id of rrf([lexical, dense])) {
      const u = byId.get(id)!;
      if (chars + Math.min(u.text.length, 1200) > budget && shown.length) break;
      shown.push(u);
      chars += Math.min(u.text.length, 1200);
      if (shown.length >= 10) break;
    }
    return shown;
  };
  if (facts.length) {
    const items = await Promise.all(facts.map(async (f) => ({ id: recordKey('cov', system, f.id), fact: f.text, units: (await lookup(f.text)).map((u) => u.text), signal: f.signal })));
    const v = await judge.factPresent(items.map(({ id, fact, units: us }) => ({ id, fact, units: us })));
    const judged = items.filter((i) => v.has(i.id));
    const hit = judged.filter((i) => v.get(i.id)!.present).length;
    put('coverage', judged.length ? hit / judged.length : null, { n: judged.length, ci: wilson(hit, judged.length) });
    for (const signal of ['explicit', 'implicit', 'latent'] as const) {
      const of = judged.filter((i) => i.signal === signal);
      if (of.length) put(`coverage_${signal}`, of.filter((i) => v.get(i.id)!.present).length / of.length, { n: of.length });
    }
  }

  /* -------------------------- precision and attribution -------------------------- */
  const chunks = chunkDocs(pack.docs.map((d) => ({ path: d.path, text: docText(pack, d.path) })));
  const corpusIndex = new Bm25<Chunk>(chunks, (c) => c.text);
  const chunksOf = new Map<string, Chunk[]>();
  for (const c of chunks) (chunksOf.get(c.doc) ?? chunksOf.set(c.doc, []).get(c.doc)!).push(c);
  const passagesFor = (claim: string, cited: string[]): { cited: string[]; all: string[] } => {
    const fromCited = cited.flatMap((d) => new Bm25(chunksOf.get(d) ?? [], (c) => c.text).search(claim, 2).map((h) => h.item.text));
    const top = corpusIndex.search(claim, 5).map((h) => h.item.text);
    return { cited: fromCited, all: [...new Set([...fromCited, ...top])] };
  };
  const prose = units.filter((u) => u.kind !== 'relation' && u.text.length > 20);
  const picked = sample(prose, opts.precisionUnits ?? 40, seed, (u) => u.id);
  const decomposed = await judge.decompose(picked.map((u) => ({ id: recordKey('dec', system, u.id), text: u.text })));
  const claims = picked.flatMap((u) => (decomposed.get(recordKey('dec', system, u.id))?.claims ?? []).map((c, i) => ({ unit: u, claim: String(c), i })));
  const checked = sample(claims, opts.precisionClaims ?? 80, seed, (c) => `${c.unit.id}#${c.i}`);
  const supportItems = checked.map((c) => {
    const p = passagesFor(c.claim, c.unit.sources);
    return { id: recordKey('sup', system, c.unit.id, c.i), claim: c.claim, sources: p.all, citedOnly: p.cited, hasSources: c.unit.sources.length > 0 };
  });
  const support = await judge.claimSupport(supportItems.map(({ id, claim, sources }) => ({ id, claim, sources })));
  const verdicts = supportItems.map((s) => support.get(s.id)?.verdict).filter(Boolean) as string[];
  if (verdicts.length) {
    const ok = verdicts.filter((v) => v === 'supported' || v === 'inference').length;
    put('precision', ok / verdicts.length, { n: verdicts.length, ci: wilson(ok, verdicts.length), detail: Object.fromEntries(['supported', 'inference', 'unsupported', 'contradicted'].map((k) => [k, verdicts.filter((v) => v === k).length])) });
    put('contradicted_rate', verdicts.filter((v) => v === 'contradicted').length / verdicts.length, { n: verdicts.length });
  }
  const attributable = supportItems.filter((s) => s.hasSources && s.citedOnly.length);
  if (attributable.length) {
    const att = await judge.claimSupport(attributable.map((s) => ({ id: recordKey('att', s.id), claim: s.claim, sources: s.citedOnly })));
    const vs = attributable.map((s) => att.get(recordKey('att', s.id))?.verdict).filter(Boolean) as string[];
    const ok = vs.filter((v) => v === 'supported').length;
    if (vs.length) put('attribution_precision', ok / vs.length, { n: vs.length, ci: wilson(ok, vs.length) });
  }
  put('units_with_sources', units.filter((u) => u.sources.length).length / units.length);

  /* -------------------------- related information -------------------------- */
  const relations = units.filter((u) => u.kind === 'relation' && u.head && u.tail);
  const linkSample = sample(relations, opts.links ?? 30, seed, (u) => u.id);
  if (linkSample.length) {
    const items = linkSample.map((u) => ({ id: recordKey('link', system, u.id), head: u.head!, relation: u.relation ?? 'related to', tail: u.tail!, sources: passagesFor(`${u.head} ${u.tail}`, u.sources).all }));
    const v = await judge.linkCorrect(items);
    const judged = items.filter((i) => v.has(i.id));
    const ok = judged.filter((i) => v.get(i.id)!.correct).length;
    if (judged.length) put('link_precision', ok / judged.length, { n: judged.length, ci: wilson(ok, judged.length) });
  }
  if (pack.links.length) {
    const aliasOf = new Map<string, string[]>();
    for (const g of pack.aliases) aliasOf.set(normName(g.canonical), [g.canonical, ...g.aliases].map(normName));
    const names = (n: string) => aliasOf.get(normName(n)) ?? [normName(n)];
    const has = (text: string, n: string) => names(n).some((x) => x && normName(text).includes(x));
    let found = 0;
    for (const l of pack.links) {
      const edge = relations.some((u) => (has(u.head!, l.head) && has(u.tail!, l.tail)) || (has(u.head!, l.tail) && has(u.tail!, l.head)));
      const coMention = edge || units.some((u) => u.kind !== 'relation' && has(u.text, l.head) && has(u.text, l.tail));
      if (coMention) found++;
    }
    put('link_recall', found / pack.links.length, { n: pack.links.length, ci: wilson(found, pack.links.length) });
  }

  /* ---------------------------- entity resolution ---------------------------- */
  const entities = units.filter((u) => u.kind === 'entity' || (u.kind === 'page' && /(^|\/)entities\//.test(u.title ?? '')));
  if (pack.aliases.length && entities.length) {
    const titleOf = (u: KnowledgeUnit) => normName((u.title ?? '').replace(/^.*\//, '').replace(/\.md$/, ''));
    let groups = 0;
    let duplicated = 0;
    const owner = new Map<string, Set<string>>();
    for (const g of pack.aliases) {
      const forms = [g.canonical, ...g.aliases].map(normName).filter(Boolean);
      const matching = entities.filter((u) => forms.includes(titleOf(u)));
      if (!matching.length) continue;
      groups++;
      if (matching.length > 1) duplicated++;
      for (const u of matching) (owner.get(u.id) ?? owner.set(u.id, new Set()).get(u.id)!).add(g.canonical);
    }
    if (groups) put('duplicate_rate', duplicated / groups, { n: groups, ci: wilson(duplicated, groups) });
    const overMerged = [...owner.values()].filter((s) => s.size > 1).length;
    put('over_merge', owner.size ? overMerged / owner.size : null, { n: owner.size });
  }

  /* -------------------- entity resolution: B-cubed (docs/design/28) -------------------- */
  // every exported entity, against the gold alias clusters (namesakes, renames, aliases): no model
  const er = entityResolution(pack.aliases, entities);
  if (er && er.n) {
    put('er_bcubed_precision', er.precision, { n: er.n, detail: { merged: er.merged } });
    put('er_bcubed_recall', er.recall, { n: er.n, detail: { split: er.split } });
    put('er_bcubed_f1', er.f1, { n: er.n });
    put('er_found', er.found, { n: pack.aliases.length });
  }

  /* ------------------------------- consistency ------------------------------- */
  const bySubject = new Map<string, KnowledgeUnit[]>();
  for (const u of units.filter((x) => x.kind === 'claim' || x.kind === 'page' || x.kind === 'summary')) {
    const k = normName(u.title ?? '');
    if (k) (bySubject.get(k) ?? bySubject.set(k, []).get(k)!).push(u);
  }
  const pairs: { id: string; a: string; b: string }[] = [];
  for (const [subject, list] of bySubject) {
    if (list.length < 2) continue;
    const [a, b] = sample(list, 2, seed, (u) => u.id);
    pairs.push({ id: recordKey('con', system, subject), a: a.text, b: b.text });
  }
  const conSample = sample(pairs, opts.contradictionPairs ?? 30, seed, (p) => p.id);
  if (conSample.length) {
    const v = await judge.contradicts(conSample);
    const judged = conSample.filter((p) => v.has(p.id));
    const bad = judged.filter((p) => v.get(p.id)!.contradict).length;
    if (judged.length) put('contradiction_rate', bad / judged.length, { n: judged.length, ci: wilson(bad, judged.length) });
  }

  /* -------------------------------- structure -------------------------------- */
  const pages = units.filter((u) => u.kind === 'page' || u.kind === 'summary' || u.kind === 'community');
  if (pages.length) {
    const ids = new Set(units.map((u) => u.id));
    const titles = new Set(pages.map((p) => normName((p.title ?? '').replace(/^.*\//, '').replace(/\.md$/, ''))));
    const resolves = (l: string) => ids.has(l) || titles.has(normName(l.replace(/^page:/, '').replace(/^.*\//, '').replace(/\.md$/, '')));
    const inbound = new Map<string, number>();
    let links = 0;
    let dangling = 0;
    for (const p of pages) {
      for (const l of p.links) {
        links++;
        if (!resolves(l)) dangling++;
        const target = normName(l.replace(/^page:/, '').replace(/^.*\//, '').replace(/\.md$/, ''));
        inbound.set(target, (inbound.get(target) ?? 0) + 1);
      }
    }
    const orphans = pages.filter((p) => !p.links.length && !inbound.get(normName((p.title ?? '').replace(/^.*\//, '').replace(/\.md$/, '')))).length;
    put('links_per_page', links / pages.length, { n: pages.length });
    put('dangling_link_rate', links ? dangling / links : null, { n: links });
    put('orphan_page_rate', orphans / pages.length, { n: pages.length });
  }
  return out;
}
