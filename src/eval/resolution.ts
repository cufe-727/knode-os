import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ReviewIdentity, saveConfig } from '../config.js';
import { createContext } from '../context.js';
import { initDataDir } from '../fs/datadir.js';
import { CODED_TYPES, CodedDoc, codedClusters, CONTEXT_TYPES, MAX_DOCS, medianDate, MIN_DOCS, namesakeClusters, NamesakeDoc, resolveEntityContext } from '../graph/entity-context.js';
import { codeOf, codesDiffer, codesOf, documentContext, namesakeFor, NamesakeRule } from '../graph/identity.js';
import { builtinOntology } from '../graph/ontology.js';
import { dateFromContent } from '../ingest/docdate.js';
import { slugify } from '../graph/store.js';
import { sync } from '../ingest/sync.js';
import { openPglite } from '../store/backend.js';
import { parseFrontmatter } from '../markdown.js';
import { dateStart } from '../store/dates.js';
import { Queryable } from '../store/migrations.js';
import { EntityResolution, entityResolution } from './metrics/entities.js';
import { normalizeAnswer } from './metrics/text.js';
import { GoldAlias, GoldAliasSchema } from './types.js';

/**
 * Entity resolution measured without a model: a workspace's stored
 * extractions (its sidecars) applied again under the resolution rules of this
 * build, and the entities that come out scored against a pack's gold alias
 * clusters.
 *
 *   index   score an index as it stands — a *copy* of a workspace's `.knode`
 *           folder, opened as PGlite whatever the workspace's config says, so
 *           no server database is ever reached.
 *   replay  copy the workspace's raw documents and sidecars to a temporary
 *           folder (the workspace is only read), index them there with
 *           vectors deferred and no model configured — every tier-1 result
 *           comes from its sidecar — then run refine's entity step until it
 *           decides nothing more. `identity` says under which rules ('name':
 *           a name is one entity, as before; 'context': identity.ts).
 *   scan    read the sidecars alone and say which names refine would part,
 *           under the default rules and under review.identity "context",
 *           and where write-time resolution would file later documents of
 *           those names — for a workspace too large or too live to replay:
 *           mentions are grouped by the id their name gives, which leaves
 *           out what alias keys and merges join, so it is an estimate.
 *
 * Two scores. `pack` is the suite's own (metrics/entities.ts): B-cubed over
 * the names each exported entity claims — comparable with a run's report, but
 * a name several real entities share is given to whichever claimant's text
 * names the context. `mentions` is B-cubed over the mentions themselves:
 * every (document, spelling) an extraction recorded, with the real entity it
 * is — the one of that name, or, where several share it, the one whose
 * context is a folder of the document's path, else the one a spelling only it
 * has (its code) points at — against the entity it was resolved to. Mentions
 * of a shared name the gold cannot place this way are left out.
 */

const norm = (s: string) => normalizeAnswer(s).replace(/\s+/g, '');

export function readGoldAliases(file: string): GoldAlias[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => GoldAliasSchema.parse(JSON.parse(l)));
}

export interface BcubedScore {
  precision: number;
  recall: number;
  f1: number;
  /** Mentions scored. */
  n: number;
  /** System entities holding mentions of two or more real entities. */
  merged: number;
  /** Real entities whose mentions are in two or more system entities. */
  split: number;
}

/** B-cubed precision and recall of items placed in `sys` clusters against their `gold` ones. */
export function bcubed(items: readonly { gold: string; sys: string }[]): BcubedScore {
  const count = (key: (i: { gold: string; sys: string }) => string) => {
    const m = new Map<string, number>();
    for (const i of items) m.set(key(i), (m.get(key(i)) ?? 0) + 1);
    return m;
  };
  const bySys = count((i) => i.sys);
  const byGold = count((i) => i.gold);
  const both = count((i) => `${i.sys}\u0000${i.gold}`);
  let p = 0;
  let r = 0;
  for (const i of items) {
    const same = both.get(`${i.sys}\u0000${i.gold}`)!;
    p += same / bySys.get(i.sys)!;
    r += same / byGold.get(i.gold)!;
  }
  const n = items.length;
  const precision = n ? p / n : 0;
  const recall = n ? r / n : 0;
  const distinct = (key: (i: { gold: string; sys: string }) => string, of: (i: { gold: string; sys: string }) => string) => {
    const m = new Map<string, Set<string>>();
    for (const i of items) (m.get(key(i)) ?? m.set(key(i), new Set()).get(key(i))!).add(of(i));
    return [...m.values()].filter((s) => s.size > 1).length;
  };
  return { precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0, n, merged: distinct((i) => i.sys, (i) => i.gold), split: distinct((i) => i.gold, (i) => i.sys) };
}

/** The real entity a mention is: index into `gold`, or -1 when the gold cannot say. */
export function goldMatcher(gold: readonly GoldAlias[]): (docPath: string, spellings: readonly string[]) => number {
  const byName = new Map<string, number[]>();
  gold.forEach((g, gi) => {
    for (const n of new Set([...(/[（(]/.test(g.canonical) ? [] : [g.canonical]), ...g.aliases].map(norm).filter(Boolean))) (byName.get(n) ?? byName.set(n, []).get(n)!).push(gi);
  });
  return (docPath, spellings) => {
    const found = new Set<number>();
    for (const s of spellings) for (const gi of byName.get(norm(s)) ?? []) found.add(gi);
    if (found.size === 0) return -1;
    const folders = new Set(docPath.split('/').map(norm));
    const here = [...found].filter((gi) => (gold[gi].context ?? []).some((c) => folders.has(norm(c))));
    if (here.length === 1) return here[0];
    if (found.size === 1) return [...found][0];
    // under no such folder: a spelling only one of them has (its code) says which
    const only = new Set(spellings.map((x) => byName.get(norm(x)) ?? []).filter((list) => list.length === 1).map((list) => list[0]));
    return only.size === 1 ? [...only][0] : -1;
  };
}

export interface IndexScore {
  /** Live, unmerged entities. */
  entities: number;
  /** Names parted into several entities: by a code at write time or by refine, and people by context. */
  parted: { coded: number; people: number };
  pack: EntityResolution | null;
  /**
   * The suite's score if an exported entity also said under which roof it
   * stands (its rule's anchors): the scorer gives a name several real
   * entities share to the claimant whose text names the context, and an
   * entity "日志保留天数（D7T1-C2）" does not name its team. Equal to `pack` when nothing was parted.
   */
  packWithRoofs: EntityResolution | null;
  mentions: BcubedScore;
  /** The same over the mentions of each kind of real entity. */
  byKind: Record<string, BcubedScore>;
}

/** Score the entities of an open index against gold alias clusters. Reads only. */
export async function scoreIndex(q: Queryable, gold: GoldAlias[]): Promise<IndexScore> {
  const entities = await q.query<{ id: string; name: string; type: string; description: string; aliases: unknown }>(
    `SELECT id, name, type, description, aliases FROM entities WHERE tx_to IS NULL AND canonical_id IS NULL`,
  );
  // the unit an evaluation run exports for an entity (eval/systems/knode.ts)
  const units = entities.map((e) => {
    const aliases = Array.isArray(e.aliases) ? (e.aliases as string[]) : [];
    return { id: `entity:${e.id}`, title: e.name, text: `${e.name} (${e.type}): ${e.description}`.trim() + (aliases.length ? `\naliases: ${aliases.join(', ')}` : '') };
  });
  const said = await q.query<{ path: string; entity: string; attrs: { name?: string; aliases?: string[]; resolved_from?: string } | null }>(
    `SELECT s.key AS path, coalesce(e.canonical_id, e.id) AS entity, ev.attrs
     FROM evidence ev JOIN scopes s ON s.id = ev.scope_id AND s.kind = 'tier1'
     JOIN entities e ON e.id = ev.target_id AND e.tx_to IS NULL
     WHERE ev.kind = 'entity' AND ev.tx_to IS NULL`,
  );
  const match = goldMatcher(gold);
  const items: { gold: string; sys: string; kind: string }[] = [];
  for (const r of said) {
    // what the mention itself was called: the spelling it was resolved from, else the name it was written under
    const spellings = [r.attrs?.resolved_from ?? r.attrs?.name ?? '', ...(r.attrs?.aliases ?? [])].filter((x) => typeof x === 'string' && x);
    const gi = match(r.path, spellings);
    if (gi >= 0) items.push({ gold: String(gi), sys: r.entity, kind: gold[gi].kind ?? 'other' });
  }
  const byKind: Record<string, BcubedScore> = {};
  for (const kind of new Set(items.map((i) => i.kind))) byKind[kind] = bcubed(items.filter((i) => i.kind === kind));
  const rules = await q.query<{ id: string; base_id: string; label: string; anchors: string[]; base_anchors: string[] }>(
    `SELECT n.id, n.base_id, n.label, n.anchors, n.base_anchors FROM entity_namesakes n JOIN entities e ON e.id = n.id AND e.tx_to IS NULL`,
  ).catch(() => []);
  const roofs = new Map<string, string[]>();
  for (const r of rules) {
    roofs.set(`entity:${r.id}`, r.anchors);
    if (!roofs.has(`entity:${r.base_id}`)) roofs.set(`entity:${r.base_id}`, r.base_anchors);
  }
  const roofed = units.map((u) => (roofs.get(u.id)?.length ? { ...u, text: `${u.text}\ncontext: ${roofs.get(u.id)!.join(', ')}` } : u));
  return {
    entities: entities.length,
    parted: { coded: rules.filter((r) => codeOf(r.label)).length, people: rules.filter((r) => !codeOf(r.label)).length },
    pack: entityResolution(gold, units),
    packWithRoofs: entityResolution(gold, roofed),
    mentions: bcubed(items),
    byKind,
  };
}

/** Score a copy of an index folder (the directory that holds `.knode`). Never give it a live workspace: PGlite takes one process. */
export async function scoreIndexCopy(dir: string, gold: GoldAlias[]): Promise<IndexScore> {
  if (!fs.existsSync(path.join(dir, '.knode', 'db'))) throw new Error(`${dir} holds no embedded index (.knode/db) — copy a workspace's .knode folder to a temporary folder and name that`);
  const db = await openPglite(dir);
  try {
    // the backend as it is: no migration runs on the copy
    const q: Queryable = { query: async <T>(sql: string, params?: unknown[]) => (await db.query(sql, params)).rows as T[] };
    return await scoreIndex(q, gold);
  } finally {
    await db.close();
  }
}

export interface ReplayReport {
  identity: ReviewIdentity;
  documents: number;
  /** After indexing: what write-time resolution alone gives. */
  written: IndexScore;
  /** After refine's entity step ran until it decided nothing more. */
  refined: IndexScore;
  refine: { passes: number; merged: number; split: number; replayed: number };
  seconds: number;
}

function copyTree(from: string, to: string): void {
  if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true });
}

/**
 * Re-apply a workspace's stored extractions under `identity` in a temporary
 * folder and score what comes out. The workspace is read, never written;
 * its config is not copied (the replay runs on defaults: embedded index, no
 * model, vectors deferred), only its ontology packs are.
 */
export async function replayResolution(
  source: string,
  gold: GoldAlias[],
  opts: { identity?: ReviewIdentity; keep?: boolean; onProgress?: (msg: string) => void } = {},
): Promise<ReplayReport> {
  const started = Date.now();
  const identity = opts.identity ?? 'context';
  const progress = opts.onProgress ?? (() => {});
  if (!fs.existsSync(path.join(source, '.sidecar', 'raw', 'docs'))) throw new Error(`${source} has no sidecars under .sidecar/raw/docs: nothing to re-apply`);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-resolution-'));
  try {
    initDataDir(dataDir);
    copyTree(path.join(source, 'raw', 'docs'), path.join(dataDir, 'raw', 'docs'));
    copyTree(path.join(source, '.sidecar', 'raw', 'docs'), path.join(dataDir, '.sidecar', 'raw', 'docs'));
    copyTree(path.join(source, 'playbooks', 'ontology'), path.join(dataDir, 'playbooks', 'ontology'));
    const config = loadConfig(dataDir);
    config.database.kind = 'pglite'; // an embedded index in the temporary folder: no server database is reached
    config.ingest.concurrency = 1; // one document at a time, in path order: an entity is whoever was written first
    config.ingest.embedding = 'deferred';
    config.review.identity = identity;
    saveConfig(dataDir, config);
    const ctx = await createContext(dataDir);
    try {
      progress(`indexing a copy of ${source} in ${dataDir} (review.identity: ${identity})`);
      await sync(ctx, { llmGraph: false });
      const [{ n: documents }] = await ctx.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM documents WHERE root = 'docs'`);
      const written = await scoreIndex(ctx.store, gold);
      progress(`indexed ${documents} documents: ${written.entities} entities`);
      const refine = { passes: 0, merged: 0, split: 0, replayed: 0 };
      for (let i = 0; i < 5; i++) {
        const stats = await resolveEntityContext(ctx.store, { config: ctx.config, onProgress: (m) => (m.startsWith('entities:') ? progress(m) : undefined) });
        refine.passes++;
        refine.merged += stats.merged;
        refine.split += stats.split;
        refine.replayed += stats.replayed;
        if (stats.merged + stats.split === 0) break;
      }
      const refined = await scoreIndex(ctx.store, gold);
      return { identity, documents, written, refined, refine, seconds: Math.round((Date.now() - started) / 1000) };
    } finally {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  } finally {
    if (opts.keep) progress(`kept ${dataDir}`);
    else fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

/** Where write-time resolution would file the documents of the names a scan parts, if each arrived after the split. */
export interface FollowCount {
  /** With the entity refine gave the document to. */
  same: number;
  /** With another of the name's entities. */
  elsewhere: number;
  /** With the entity that keeps the name, though refine gave the document to a parted one (nothing in it said which). */
  base: number;
}

export interface ScanReport {
  sidecars: number;
  names: number;
  /** Names of a type a code may part whose mentions carry two or more codes of one kind. */
  codedCandidates: number;
  /** Of those, the names refine's coded split would part (review.identity "context"), with the entities it would add. */
  coded: { name: string; documents: number; parts: { code: string; documents: number; anchors: string[] }[]; follow: FollowCount }[];
  /** People of 6–600 documents the namesake rule would look at. */
  peopleCandidates: number;
  /**
   * Of those, the names it would split, and under which rules at the least:
   * 'indexed' — the default rules with the dates the index has now;
   * 'reindexed' — the default rules once documents are indexed again and those with a dateline get a date;
   * 'context' — only with review.identity "context" (documents dated by their claims, contexts compared by what they are about).
   */
  people: { name: string; documents: number; anchors: [string[], string[]]; rules: 'indexed' | 'reindexed' | 'context'; follow: FollowCount }[];
  /** The write-time path: `follow` over every name above. */
  follow: FollowCount;
}

/**
 * What refine would part in a workspace, and where write-time resolution
 * would then file later documents, read from its sidecars and raw texts
 * alone (no index is opened). An estimate: mentions are grouped by the id
 * their name gives, context is the other names of the same document, and
 * nothing the index knows beyond that — merges, alias keys, names already
 * parted — is taken into account.
 *
 * Nothing is parted when a document is written (resolve.ts), so the
 * write-time path is the following of a name refine parted. `follow` asks it
 * of every document of every such name: were this document to arrive after
 * the split, with no list of the split's documents to go by, would its
 * mention be filed where refine put it — by its code, its owner, the roofs
 * its document names?
 */
export function scanSidecars(source: string): ScanReport {
  const root = path.join(source, '.sidecar');
  const ontology = builtinOntology();
  type Mention = { doc: string; spellings: string[]; type: string };
  const groups = new Map<string, { name: string; mentions: Mention[] }>();
  const docs = new Map<string, { context: Map<string, string>; names: Set<string>; owners: Map<string, string[]>; date: string | null; dateline: string | null; claimDate: string | null }>();
  let sidecars = 0;
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    if (names.includes('tier1.json')) {
      let t1: { status?: string; entities?: { name?: unknown; type?: unknown; aliases?: unknown }[]; relations?: { source?: unknown; target?: unknown; type?: unknown }[]; claims?: { startDate?: unknown; eventDate?: unknown }[] };
      try {
        t1 = JSON.parse(fs.readFileSync(path.join(dir, 'tier1.json'), 'utf8'));
      } catch {
        return;
      }
      if (t1.status !== 'done') return;
      sidecars++;
      const doc = path.relative(root, dir);
      let date: string | null = null;
      try {
        date = dateStart((JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as { docDate?: unknown }).docDate);
      } catch {
        // no meta: undated
      }
      // the date an index made now would give it: what the index has, else a dateline in the raw text
      let dateline: string | null = null;
      if (!date && /\.(?:md|markdown|txt)$/i.test(doc)) {
        try {
          dateline = dateFromContent(parseFrontmatter(fs.readFileSync(path.join(source, doc), 'utf8')).body);
        } catch {
          // no raw text beside the sidecar
        }
      }
      const stated = (t1.claims ?? []).map((c) => dateStart(c.eventDate) ?? dateStart(c.startDate)).filter((x): x is string => Boolean(x));
      const context = new Map<string, string>();
      const all = new Set<string>();
      const entities: { name: string; type: string; aliases: string[] }[] = [];
      for (const e of t1.entities ?? []) {
        if (typeof e.name !== 'string' || !e.name.trim()) continue;
        const id = slugify(e.name);
        const type = typeof e.type === 'string' ? e.type : 'concept';
        if (CONTEXT_TYPES.includes(type)) context.set(id, type);
        const aliases = Array.isArray(e.aliases) ? e.aliases.filter((a): a is string => typeof a === 'string') : [];
        for (const n of [e.name, ...aliases]) all.add(slugify(n));
        entities.push({ name: e.name, type, aliases });
        (groups.get(id) ?? groups.set(id, { name: e.name.trim(), mentions: [] }).get(id)!).mentions.push({ doc, spellings: [e.name, ...aliases], type });
      }
      const relations = (t1.relations ?? []).filter((r): r is { source: string; target: string; type: string } => typeof r.source === 'string' && typeof r.target === 'string' && typeof r.type === 'string');
      const stated_ = documentContext(entities, relations, ontology);
      const owners = new Map<string, string[]>();
      for (const e of entities) {
        const own = stated_.of(e.name).owners ?? [];
        if (own.length > 0) owners.set(slugify(e.name), own.map(slugify));
      }
      docs.set(doc, { context, names: all, owners, date, dateline, claimDate: medianDate(stated) });
      return;
    }
    for (const n of names) if (!n.includes('.json')) walk(path.join(dir, n));
  };
  walk(root);

  const types = new Map<string, string>();
  for (const [id, g] of groups) {
    const counts = new Map<string, number>();
    for (const m of g.mentions) counts.set(m.type, (counts.get(m.type) ?? 0) + 1);
    types.set(id, [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  }
  const typeOf = (id: string) => types.get(id);
  const contextOf = (doc: string, self: string) => new Set([...docs.get(doc)!.context.keys()].filter((id) => id !== self));
  const zero = (): FollowCount => ({ same: 0, elsewhere: 0, base: 0 });
  /** Where each document would be filed if it arrived after the split: `rules` without their document lists, ids standing for names. */
  const followOf = (id: string, name: string, rules: NamesakeRule[], placed: Map<string, string>, spellings: Map<string, string[]>): FollowCount => {
    const count = zero();
    for (const [doc, to] of placed) {
      const d = docs.get(doc)!;
      const chosen = namesakeFor(rules, { codes: codesOf(spellings.get(doc) ?? []), baseCodes: codesOf([name]), context: { owners: d.owners.get(id) ?? [], documentNames: d.names } }, (x) => x);
      const filed = chosen?.id ?? id;
      if (filed === to) count.same++;
      else if (filed === id) count.base++;
      else count.elsewhere++;
    }
    return count;
  };
  const report: ScanReport = { sidecars, names: groups.size, codedCandidates: 0, coded: [], peopleCandidates: 0, people: [], follow: zero() };
  const add = (f: FollowCount) => {
    report.follow.same += f.same;
    report.follow.elsewhere += f.elsewhere;
    report.follow.base += f.base;
  };
  for (const [id, g] of groups) {
    const perDoc = new Map<string, string[]>();
    // as refine reads it: a name that is itself a code is on every mention, and says nothing of which thing a document means
    const named = codeOf(g.name) !== null;
    for (const m of g.mentions) (perDoc.get(m.doc) ?? perDoc.set(m.doc, []).get(m.doc)!).push(...m.spellings.filter((x) => !named || slugify(x) !== id));
    if (perDoc.size > MAX_DOCS) continue;
    const codes = [...new Set(g.mentions.flatMap((m) => m.spellings))].map(codeOf).filter((c) => c !== null);
    // (the candidate test keeps the name: refine looks at every entity whose spellings differ)
    if (perDoc.size >= 4 && CODED_TYPES.includes(types.get(id) ?? '') && codes.some((a, i) => codes.slice(i + 1).some((b) => codesDiffer(a, b)))) {
      report.codedCandidates++;
      const coded: CodedDoc[] = [...perDoc.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([doc, spellings]) => ({ id: doc, path: doc, date: null, context: contextOf(doc, id), codes: codesOf(spellings) }));
      const split = codedClusters(coded, typeOf);
      if (split) {
        const kept = split.rest.length === 0 ? split.parts[0] : null;
        const parts = split.parts.filter((p) => p !== kept);
        const baseAnchors = kept ? kept.anchors : split.restAnchors;
        const rules: NamesakeRule[] = [
          ...(kept ? [{ id, base_id: id, name: g.name, label: kept.code.raw, anchors: kept.anchors, base_anchors: baseAnchors }] : []),
          ...parts.map((p) => ({ id: `${id}/${p.code.value}`, base_id: id, name: g.name, label: p.code.raw, anchors: p.anchors, base_anchors: baseAnchors })),
        ];
        const placed = new Map<string, string>();
        for (const d of [...split.rest, ...(kept?.docs ?? [])]) placed.set(d.id, id);
        for (const p of parts) for (const d of p.docs) placed.set(d.id, `${id}/${p.code.value}`);
        const follow = followOf(id, g.name, rules, placed, perDoc);
        add(follow);
        report.coded.push({ name: g.name, documents: perDoc.size, parts: parts.map((p) => ({ code: p.code.raw, documents: p.docs.length, anchors: p.anchors })), follow });
      }
    }
    if (types.get(id) === 'person' && perDoc.size >= MIN_DOCS) {
      report.peopleCandidates++;
      const of = (date: (d: { date: string | null; dateline: string | null; claimDate: string | null }) => string | null): NamesakeDoc[] =>
        [...perDoc.keys()].sort().map((doc) => ({ id: doc, path: doc, date: date(docs.get(doc)!), context: contextOf(doc, id) }));
      const tries: [ScanReport['people'][number]['rules'], NamesakeDoc[], boolean][] = [
        ['indexed', of((d) => d.date), false],
        ['reindexed', of((d) => d.date ?? d.dateline), false],
        ['context', of((d) => d.date ?? d.dateline ?? d.claimDate), true],
      ];
      for (const [rules, list, characteristic] of tries) {
        const split = namesakeClusters(list, typeOf, { characteristic });
        if (!split) continue;
        const variant = `${id}/${split[1].anchors[0]}`;
        const rule: NamesakeRule = { id: variant, base_id: id, name: g.name, label: split[1].anchors[0], anchors: split[1].anchors, base_anchors: split[0].anchors };
        const placed = new Map<string, string>();
        for (const d of list) placed.set(d.id, split[1].docs.some((x) => x.id === d.id) ? variant : id);
        const follow = followOf(id, g.name, [rule], placed, perDoc);
        add(follow);
        report.people.push({ name: g.name, documents: perDoc.size, anchors: [split[0].anchors, split[1].anchors], rules, follow });
        break;
      }
    }
  }
  report.coded.sort((a, b) => b.documents - a.documents);
  report.people.sort((a, b) => b.documents - a.documents);
  return report;
}

const pct = (x: number) => x.toFixed(3);

/** One score as lines of text. */
export function formatIndexScore(label: string, s: IndexScore): string {
  const lines = [
    `${label}: ${s.entities} entities; parted by code ${s.parted.coded}, people ${s.parted.people}`,
    `  mentions  P ${pct(s.mentions.precision)}  R ${pct(s.mentions.recall)}  F1 ${pct(s.mentions.f1)}  (${s.mentions.n} mentions; ${s.mentions.merged} entities hold several real ones, ${s.mentions.split} real ones are spread over several)`,
  ];
  for (const [kind, k] of Object.entries(s.byKind).sort()) lines.push(`    ${kind.padEnd(9)} P ${pct(k.precision)}  R ${pct(k.recall)}  (${k.n}; merged ${k.merged}, split ${k.split})`);
  if (s.pack) lines.push(`  pack      P ${pct(s.pack.precision)}  R ${pct(s.pack.recall)}  F1 ${pct(s.pack.f1)}  (${s.pack.n} real entities found; merged ${s.pack.merged}, split ${s.pack.split})`);
  if (s.packWithRoofs && s.parted.coded + s.parted.people > 0) lines.push(`  pack, roofs named  P ${pct(s.packWithRoofs.precision)}  R ${pct(s.packWithRoofs.recall)}  F1 ${pct(s.packWithRoofs.f1)}  (merged ${s.packWithRoofs.merged}, split ${s.packWithRoofs.split})`);
  return lines.join('\n');
}
