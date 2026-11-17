import path from 'node:path';
import { okfGenerated } from '../okf/index.js';
import { excerptOf, lastOpener } from '../search/excerpts.js';
import { gramQuery, MATCH_INDEXES, matchIndexReady, termGrams } from '../store/grams.js';
import { Store } from '../store/db.js';
import { Params, toDateString, toIso } from '../store/temporal.js';
import type { PageGenerator, PagePlan } from './pages.js';
import { sha16 } from '../digest.js';

/**
 * Pages across documents: what no entity page holds because it is about many
 * entities at once (docs/design/00, "Cross-document pages").
 *
 * The benchmark's corpus-level questions — which papers use Gemini, which
 * articles name a body, what happened in what order, which sources disagree —
 * had their answer spread over a dozen entity pages, or on none: a paper that
 * evaluates "Gemini-3 Pro" in passing gets no claim about Gemini, and the
 * dated claims of seven statutes stood on seven pages. Three kinds of page
 * gather them, each line with the document it comes from, as entity pages do:
 *
 * - `wiki/mentions/<entity>.md`: every source document that names an entity
 *   or a name that extends it ("Gemini 1.5", "Qwen3" for Qwen), with the
 *   names it uses, where (the article or section numbers) and its first
 *   passage. Written for the entity families the most documents mention.
 * - `wiki/timelines/<year>.md`, or `<year>-<month>.md` for a year with more
 *   dated claims than one page lists: every dated claim of every entity.
 * - `wiki/disagreements/<n>.md`: the conflicts the Judge found between two
 *   claims and the claims extracted as disputed, by subject, a page per 200.
 *
 * Each directory's `index.md` lists its pages in a managed region (OKF keeps
 * frontmatter to the root index). The generators import only types from
 * ./pages.ts, which registers them: ./corpus.ts creates and refreshes them.
 */

export type CorpusPageKind = 'mentions' | 'mentions_index' | 'timeline' | 'timelines_index' | 'disagreements' | 'disagreements_index';

const meta = (view: CorpusPageKind, inputs: Record<string, string[]>) => ({ view, inputs });
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const from = (p?: string | null) => (p ? ` — ${p}` : '');
const linked = (name: string, page: string | null | undefined) => (page ? `[[${name}]]` : name);

/* -------------------------------- mentions ------------------------------- */

/**
 * Documents a mention page lists at most — the ones that use the names most,
 * shown by path; past that it says how many it found. At ~400 bytes a line,
 * 300 pages of 100 lines are 12 MB on a workspace of 27,000 documents, under
 * the 19 MB its 13,606 summary pages take; at 200 they would be more.
 */
export const MENTION_PAGE_DOCS = 100;
/** Chunks naming the family read at most for one page: past that the page says "at least". */
const MENTION_SCAN_CHUNKS = 4000;
/** Variants a family takes at most, the most mentioned first. */
const MENTION_VARIANTS = 40;
/** Documents below which a family keeps no page: one or two are what the entity page and search show. */
export const MENTION_MIN_DOCS = 3;
/** A family named in more than this share of a corpus of at least MENTION_BROAD_CORPUS documents gets no page. */
export const MENTION_BROAD_SHARE = 0.5;
export const MENTION_BROAD_CORPUS = 20;
/**
 * UTF-8 bytes of a document's first passage on its line, about 80 CJK or 240
 * Latin characters. At 160 characters, law-cn's statute pages — where every
 * line is Chinese and names a dozen articles — came to 11 KB a page.
 */
const MENTION_EXCERPT_BYTES = 240;
/** Characters of the passage kept before the first hit. */
const EXCERPT_BEFORE = 30;

const alnum = (ch: string | undefined) => Boolean(ch) && /[\p{L}\p{N}]/u.test(ch!);

/**
 * How often each of `anchors` (lowercased) stands in `lower`, and where the
 * first hit is. A Latin name is a whole word on both sides — the Geminids are
 * not Gemini — and a longer name is counted first and masked, so "Gemini 1.5"
 * is one hit of itself, not also one of Gemini. A CJK name is a substring:
 * Chinese has no word boundary to look for, and the statutes' 国务院 questions
 * count the articles of 国务院证券监督管理机构 too.
 */
export function nameHits(lower: string, anchors: string[]): { counts: Map<string, number>; first: number } {
  const counts = new Map<string, number>();
  let text = lower;
  let first = Infinity;
  for (const a of [...anchors].sort((x, y) => y.length - x.length)) {
    const cjk = /[一-鿿]/.test(a);
    let n = 0;
    for (let i = text.indexOf(a); i >= 0; i = text.indexOf(a, i + a.length)) {
      if (!cjk && ((alnum(a[0]) && alnum(text[i - 1])) || (alnum(a[a.length - 1]) && alnum(text[i + a.length])))) continue;
      n++;
      first = Math.min(first, i);
      if (!cjk) text = text.slice(0, i) + ' '.repeat(a.length) + text.slice(i + a.length);
    }
    if (n > 0) counts.set(a, n);
  }
  return { counts, first };
}

/** The passage around the first hit of any anchor in `content`, on one line, cut to MENTION_EXCERPT_BYTES. */
export function passageAround(content: string, anchors: string[]): string | null {
  const text = oneLine(content);
  const at = nameHits(text.toLowerCase(), anchors).first;
  if (!Number.isFinite(at)) return null;
  const start = Math.max(0, at - EXCERPT_BEFORE);
  let out = '';
  let bytes = 0;
  for (const ch of text.slice(start)) {
    bytes += Buffer.byteLength(ch);
    if (bytes > MENTION_EXCERPT_BYTES) break;
    out += ch;
  }
  return `${start > 0 ? '…' : ''}${out.trim()}${start + out.length < text.length ? '…' : ''}`;
}
/** Article or section numbers a line names at most. */
const MENTION_LOCATORS = 40;

/** A name the chunk gram index can look up and that is not a bare number: two CJK characters, or three others. */
export function usableName(name: string): boolean {
  const n = name.trim();
  if (!/[a-zA-Z一-鿿]/.test(n)) return false;
  return /[一-鿿]/.test(n) ? n.length >= 2 : n.length >= 3;
}

const LATIN = /^[\x20-\x7e]+$/;

/**
 * Whether `name` extends `root` as a model or product line does: "Gemini 1.5",
 * "Gemini-3 Pro", "Qwen3", "Llama3.2" for Gemini, Qwen and Llama. Latin names
 * only: a CJK name that begins with another is usually something else
 * (国务院证券监督管理机构 is not a kind of 国务院).
 */
export function extendsName(name: string, root: string): boolean {
  const n = name.toLowerCase();
  const r = root.toLowerCase();
  if (!LATIN.test(r) || !/[a-z0-9]$/.test(r) || n.length <= r.length || !n.startsWith(r)) return false;
  const next = n[r.length];
  return next === ' ' || next === '-' || (/[0-9]/.test(next) && /[a-z]$/.test(r));
}

/** The names a variant extends, shortest first: "gemini-3 pro" → gemini, gemini-3. */
export function rootsOf(name: string): string[] {
  const n = name.toLowerCase();
  if (!LATIN.test(n)) return [];
  const out: string[] = [];
  for (let i = 1; i < n.length; i++) {
    const cut = n.slice(0, i);
    if (extendsName(n, cut) && usableName(cut)) out.push(cut);
  }
  return out;
}

interface FamilyEntity { id: string; name: string; type: string; aliases: string[]; fold_sha: string; wiki_path: string | null }

/** An entity's variants: live, canonical entities whose name extends its own. */
export async function familyOf(store: Store, root: { id: string; name: string }): Promise<FamilyEntity[]> {
  if (!LATIN.test(root.name)) return [];
  const like = root.name.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`) + '%';
  const rows = await store.query<FamilyEntity>(
    `SELECT id, name, type, aliases, fold_sha, wiki_path FROM entities
     WHERE tx_to IS NULL AND canonical_id IS NULL AND id <> $1 AND lower(name) LIKE $2 ESCAPE '\\'
     ORDER BY mention_count DESC, id LIMIT 400`,
    [root.id, like],
  );
  return rows.filter((e) => extendsName(e.name, root.name)).slice(0, MENTION_VARIANTS);
}

const LOCATOR = /^(?:…\s*)?(第[一二三四五六七八九十百千零〇两\d]+条|article\s+\d+|art\.\s*\d+|§\s*\d+|section\s+\d+)/i;

interface MentionDoc { path: string; title: string; sha: string; names: [string, number][]; locators: string[]; excerpt: string | null }

/**
 * The source documents that name any of `names`, each with how often it uses
 * which name, the numbered units the hits are in, and its first passage. The
 * chunks come through the gram index (`excerptsForQuestion` does the same at
 * question time); a hit is what `nameHits` counts.
 */
export async function documentsNaming(store: Store, names: string[]): Promise<{ docs: MentionDoc[]; capped: boolean }> {
  const anchors = [...new Set(names.map((n) => n.toLowerCase().trim()))].filter(usableName);
  if (anchors.length === 0) return { docs: [], capped: false };
  const display = new Map<string, string>();
  for (const n of names) if (!display.has(n.toLowerCase().trim())) display.set(n.toLowerCase().trim(), n.trim());
  const p = new Params();
  const grams = anchors.map(termGrams);
  const indexed = matchIndexReady(store, 'chunks') && grams.every((g) => g.length > 0);
  const match = indexed
    ? `${MATCH_INDEXES.chunks.expr('c')} @@ ${p.add(gramQuery(grams, 1))}::tsquery`
    : `(${anchors.map((a) => `strpos(lower(c.content), ${p.add(a)}) > 0`).join(' OR ')})`;
  // the index lookup on its own: joined directly, a planner without statistics evaluates match_grams on
  // every chunk. Wiki pages name the family too, and are left out after it.
  const hits = await store.query<{ id: string }>(`SELECT c.id FROM chunks c WHERE ${match} LIMIT ${p.add(MENTION_SCAN_CHUNKS)}`, p.list);
  if (hits.length === 0) return { docs: [], capped: false };
  const q = new Params([hits.map((h) => h.id)]);
  const rows = await store.query<{ document_id: string; seq: number; content: string; path: string; title: string | null; sha256: string }>(
    `SELECT c.document_id, c.seq, c.content, d.path, d.title, d.sha256
     FROM chunks c JOIN documents d ON d.id = c.document_id
     WHERE c.id = ANY($1::text[]) AND d.root = 'docs' AND d.status = 'indexed'
       AND (${anchors.map((a) => `strpos(lower(c.content), ${q.add(a)}) > 0`).join(' OR ')})
     ORDER BY d.path, c.seq`,
    q.list,
  );
  // a hit above the first unit a chunk opens is in the unit the chunk before left open
  const prevKeys = rows.filter((r) => r.seq > 0).map((r) => [r.document_id, r.seq - 1] as const);
  const carry = new Map<string, string>();
  if (prevKeys.length) {
    const prev = await store.query<{ document_id: string; seq: number; content: string }>(
      `SELECT c.document_id, c.seq, c.content FROM chunks c JOIN unnest($1::text[], $2::int[]) AS k(doc, seq) ON c.document_id = k.doc AND c.seq = k.seq`,
      [prevKeys.map((k) => k[0]), prevKeys.map((k) => k[1])],
    );
    for (const r of prev) {
      const opener = lastOpener(r.content);
      if (opener) carry.set(`${r.document_id}:${r.seq + 1}`, opener);
    }
  }
  const byDoc = new Map<string, MentionDoc & { counts: Map<string, number>; units: Set<string> }>();
  for (const r of rows) {
    const lower = r.content.toLowerCase();
    const counts = [...nameHits(lower, anchors).counts];
    if (counts.length === 0) continue;
    const d = byDoc.get(r.path) ?? byDoc.set(r.path, { path: r.path, title: r.title ?? path.posix.basename(r.path), sha: r.sha256, names: [], locators: [], excerpt: null, counts: new Map(), units: new Set() }).get(r.path)!;
    // chunks overlap: a name counted in two of them is the larger count, not the sum
    for (const [a, n] of counts) d.counts.set(a, Math.max(d.counts.get(a) ?? 0, n));
    for (const w of excerptOf(r.content, counts.map(([a]) => a), 360, carry.get(`${r.document_id}:${r.seq}`))) {
      const unit = LOCATOR.exec(w)?.[1];
      if (unit) d.units.add(unit.replace(/\s+/g, ' '));
    }
    if (!d.excerpt) d.excerpt = passageAround(r.content, counts.map(([a]) => a));
  }
  const docs = [...byDoc.values()].map((d) => ({
    path: d.path, title: d.title, sha: d.sha, excerpt: d.excerpt,
    names: [...d.counts].map(([a, n]) => [display.get(a) ?? a, n] as [string, number]).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])),
    locators: [...d.units],
  }));
  return { docs, capped: hits.length >= MENTION_SCAN_CHUNKS };
}

const mentions: PageGenerator = {
  kind: 'mentions',
  version: 1,
  llm: false,
  mode: 'file',
  async plan(ctx, pagePath) {
    const id = path.posix.basename(pagePath, '.md');
    const [e] = await ctx.store.query<FamilyEntity & { canonical_id: string | null }>(
      `SELECT id, name, type, aliases, fold_sha, wiki_path, canonical_id FROM entities WHERE id = $1 AND tx_to IS NULL`,
      [id],
    );
    if (!e || e.canonical_id || !usableName(e.name)) return null;
    const variants = await familyOf(ctx.store, e);
    const aliases = Array.isArray(e.aliases) ? e.aliases.filter((a): a is string => typeof a === 'string') : [];
    const names = [e.name, ...aliases, ...variants.map((v) => v.name)];
    const { docs, capped } = await documentsNaming(ctx.store, names);
    if (docs.length < Math.min(2, MENTION_MIN_DOCS)) return null;
    // a name in more than half of a corpus of twenty documents or more (中华人民共和国 in every statute
    // chapter, an alias such as 本法) lists nearly everything: the sources index does that already
    const [{ n: corpus }] = await ctx.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM documents WHERE root = 'docs' AND status = 'indexed'`);
    if (corpus >= MENTION_BROAD_CORPUS && docs.length > corpus * MENTION_BROAD_SHARE) return null;
    const uses = (d: MentionDoc) => d.names.reduce((a, [, n]) => a + n, 0);
    const listed = docs.length <= MENTION_PAGE_DOCS ? docs
      : [...docs].sort((a, b) => uses(b) - uses(a) || (a.path < b.path ? -1 : 1)).slice(0, MENTION_PAGE_DOCS).sort((a, b) => (a.path < b.path ? -1 : 1));
    const page: PagePlan = {
      deps: [
        { kind: 'entity', id: e.id, required: true, sha: e.fold_sha },
        ...variants.map((v) => ({ kind: 'entity' as const, id: v.id, sha: v.fold_sha })),
        ...listed.map((d) => ({ kind: 'document' as const, id: d.path, sha: d.sha })),
      ],
      inputsSha: sha16(['mentions@1', e.fold_sha, e.name, e.wiki_path, aliases, variants.map((v) => [v.id, v.name]), docs.length, capped, listed.map((d) => [d.path, d.sha, d.title])]),
      data: { entity: { id: e.id, name: e.name, type: e.type, wiki_path: e.wiki_path, aliases }, variants: variants.map((v) => v.name), docs: listed, total: docs.length, capped },
    };
    return page;
  },
  async render(_ctx, _pagePath, plan) {
    const e = plan.data.entity as { id: string; name: string; type: string; wiki_path: string | null; aliases: string[] };
    const variants = plan.data.variants as string[];
    const docs = plan.data.docs as MentionDoc[];
    const total = plan.data.total as number;
    const capped = plan.data.capped as boolean;
    const count = `${capped ? 'at least ' : ''}${total} ${total === 1 ? 'document' : 'documents'}`;
    const family = variants.length ? ` or a name that extends it (${variants.slice(0, 12).join(', ')}${variants.length > 12 ? ', …' : ''})` : '';
    const lines = [
      `# ${e.name} — where it is mentioned`,
      '',
      `_${count} name ${e.name}${family}${total > docs.length ? `; the ${docs.length} that use the names most are listed — \`knode_search\` for "${e.name}" finds the rest` : ''}._`,
      `Each line: the document, the names it uses and how often, the articles or sections they are in, and its first passage.${e.wiki_path ? ` What is claimed about it: [[${e.name}]].` : ''}`,
      '',
      ...docs.map((d) => {
        const names = d.names.map(([n, k]) => `${n}${k > 1 ? ` ×${k}` : ''}`).join(', ');
        const where = d.locators.length ? ` · ${d.locators.slice(0, MENTION_LOCATORS).join(', ')}${d.locators.length > MENTION_LOCATORS ? ', …' : ''}` : '';
        return `- ${oneLine(d.title)} — ${d.path} · ${names}${where}${d.excerpt ? ` · “${d.excerpt}”` : ''}`;
      }),
    ];
    return {
      frontmatter: {
        title: `${e.name} (mentions)`,
        type: 'mentions',
        description: `Every source document that names ${e.name}${variants.length ? ' or its variants' : ''}, with where and how.`,
        generated: okfGenerated('knode-os/mentions'),
        knode: meta('mentions', { entities: [e.id] }),
      },
      regions: { body: lines.join('\n') },
    };
  },
};

/** `wiki/mentions/index.md#mentions`: every mention page, the most documents first. */
const mentionsIndex: PageGenerator = {
  kind: 'mentions_index',
  version: 1,
  llm: false,
  mode: 'region',
  async plan(ctx) {
    const rows = await ctx.store.query<{ path: string; name: string | null; type: string | null; docs: number }>(
      `SELECT p.path, e.name, e.type,
              (SELECT count(*)::int FROM deps d WHERE d.artifact_kind = 'page' AND d.artifact_id = p.path AND d.input_kind = 'document') AS docs
       FROM pages p LEFT JOIN entities e ON e.id = regexp_replace(p.path, '^wiki/mentions/(.*)\\.md$', '\\1') AND e.tx_to IS NULL
       WHERE p.kind = 'mentions' AND p.status <> 'archived'
       ORDER BY 4 DESC, e.name`,
    );
    if (rows.length === 0) return null;
    const setSha = sha16(rows.map((r) => [r.path, r.name, r.docs]));
    return { deps: [{ kind: 'set', id: 'mention-pages', sha: setSha }], inputsSha: sha16(['mentions_index@1', setSha]), data: { rows } };
  },
  async render(_ctx, _pagePath, plan) {
    const rows = plan.data.rows as { path: string; name: string | null; type: string | null; docs: number }[];
    const lines = [
      '## Where things are mentioned',
      '',
      'For each of the names the most documents use, every source document that uses it or a name that extends it — "which papers use X", "which articles name X" — with the article or section and a passage.',
      '',
      ...rows.map((r) => `* [${r.name ?? path.posix.basename(r.path, '.md')}](${path.posix.basename(r.path)})${r.type ? ` (${r.type})` : ''} \`${r.docs}${r.docs >= MENTION_PAGE_DOCS ? '+' : ''} documents\``),
    ];
    return { frontmatter: {}, regions: { mentions: lines.join('\n') } };
  },
};

/* -------------------------------- timelines ------------------------------ */

/** Dated claims one timeline page lists: a year with more is split into months; a month with more lists the oldest this many. */
export const TIMELINE_PAGE_CLAIMS = 400;

/** Every dated claim's date (its event, else the start of its window), by year and month. */
export async function datedClaimCounts(store: Store): Promise<Map<string, { n: number; months: Map<string, number>; first: string; last: string }>> {
  const rows = await store.query<{ d: string | Date }>(
    `SELECT COALESCE(event_at, valid_from) AS d FROM claims
     WHERE tx_to IS NULL AND canonical_id IS NULL AND COALESCE(event_at, valid_from) IS NOT NULL`,
  );
  const years = new Map<string, { n: number; months: Map<string, number>; first: string; last: string }>();
  for (const r of rows) {
    const day = toDateString(r.d);
    if (!day) continue;
    const y = years.get(day.slice(0, 4)) ?? years.set(day.slice(0, 4), { n: 0, months: new Map(), first: day, last: day }).get(day.slice(0, 4))!;
    y.n++;
    y.months.set(day.slice(0, 7), (y.months.get(day.slice(0, 7)) ?? 0) + 1);
    if (day < y.first) y.first = day;
    if (day > y.last) y.last = day;
  }
  return years;
}

/**
 * The pages the dated claims make, coarsest first: one page for them all
 * (`all`) while they fit on one (TIMELINE_PAGE_CLAIMS), else a page per
 * decade that fits, else its years, else a year's months. A page per year
 * gave law-cn sixteen pages of one to three claims; its nineteen dated claims
 * are one page, and "list the laws by their last amendment" one page's read. The boundaries are the calendar's, so a new claim moves
 * no other claim to another page unless it tips its period over the limit.
 */
export function timelinePeriods(years: Awaited<ReturnType<typeof datedClaimCounts>>): { period: string; n: number; first: string; last: string }[] {
  const decades = new Map<string, { n: number; first: string; last: string; years: string[] }>();
  for (const [y, v] of years) {
    const key = `${y.slice(0, 3)}0s`;
    const d = decades.get(key) ?? decades.set(key, { n: 0, first: v.first, last: v.last, years: [] }).get(key)!;
    d.n += v.n;
    d.years.push(y);
    if (v.first < d.first) d.first = v.first;
    if (v.last > d.last) d.last = v.last;
  }
  const out: { period: string; n: number; first: string; last: string }[] = [];
  const all = [...decades.values()];
  const total = all.reduce((a, d) => a + d.n, 0);
  if (total === 0) return out;
  if (total <= TIMELINE_PAGE_CLAIMS) {
    return [{ period: 'all', n: total, first: all.map((d) => d.first).sort()[0], last: all.map((d) => d.last).sort().reverse()[0] }];
  }
  for (const [key, d] of [...decades].sort((x, y) => x[0].localeCompare(y[0]))) {
    if (d.n <= TIMELINE_PAGE_CLAIMS) {
      out.push({ period: key, n: d.n, first: d.first, last: d.last });
      continue;
    }
    for (const y of d.years.sort()) {
      const v = years.get(y)!;
      if (v.n <= TIMELINE_PAGE_CLAIMS) out.push({ period: y, n: v.n, first: v.first, last: v.last });
      else for (const [m, n] of [...v.months].sort((x, z) => x[0].localeCompare(z[0]))) out.push({ period: m, n, first: m, last: m });
    }
  }
  return out;
}

/** A timeline page's period as a range, with the ranges whose counts decide whether the page should exist. */
function periodRange(period: string): { start: string; end: string; grain: 'all' | 'decade' | 'year' | 'month'; decade: [string, string]; year: [string, string] | null } | null {
  const iso = (y: number, m = 0) => new Date(Date.UTC(y, m, 1)).toISOString();
  if (period === 'all') return { start: iso(-271820), end: iso(275759), grain: 'all', decade: [iso(-271820), iso(275759)], year: null };
  let m = /^(\d{3})0s$/.exec(period);
  if (m) {
    const y = Number(m[1]) * 10;
    return { start: iso(y), end: iso(y + 10), grain: 'decade', decade: [iso(y), iso(y + 10)], year: null };
  }
  m = /^(\d{4})(?:-(\d{2}))?$/.exec(period);
  if (!m) return null;
  const y = Number(m[1]);
  const d = Math.floor(y / 10) * 10;
  const decade: [string, string] = [iso(d), iso(d + 10)];
  if (!m[2]) return { start: iso(y), end: iso(y + 1), grain: 'year', decade, year: [iso(y), iso(y + 1)] };
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { start: iso(y, month - 1), end: iso(y, month), grain: 'month', decade, year: [iso(y), iso(y + 1)] };
}

interface TimelineClaim {
  id: string; statement: string; status: string; kind: string; event_at: string | null; valid_from: string | null;
  superseded_by: string | null; fold_sha: string; path: string | null; subject: string; subject_page: string | null;
}

const timeline: PageGenerator = {
  kind: 'timeline',
  version: 1,
  llm: false,
  mode: 'file',
  async plan(ctx, pagePath) {
    const period = path.posix.basename(pagePath, '.md');
    const range = periodRange(period);
    if (!range) return null;
    const { start, end } = range;
    const dated = `COALESCE(cl.event_at, cl.valid_from)`;
    const count = async (from: string, to: string) => (await ctx.store.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM claims cl WHERE cl.tx_to IS NULL AND cl.canonical_id IS NULL AND ${dated} >= $1::timestamptz AND ${dated} < $2::timestamptz`,
      [from, to],
    ))[0].n;
    // the page exists at the coarsest grain that fits (`timelinePeriods`); at any other it is archived
    const everything = await ctx.store.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM claims cl WHERE cl.tx_to IS NULL AND cl.canonical_id IS NULL AND ${dated} IS NOT NULL`,
    );
    const fitsOne = everything[0].n <= TIMELINE_PAGE_CLAIMS;
    if ((range.grain === 'all') !== fitsOne) return null;
    const inDecade = range.grain === 'all' ? everything[0].n : await count(...range.decade);
    if (range.grain === 'decade' && inDecade > TIMELINE_PAGE_CLAIMS) return null;
    if (range.grain === 'year' || range.grain === 'month') {
      if (inDecade <= TIMELINE_PAGE_CLAIMS) return null;
      const inYear = await count(...range.year!);
      if ((range.grain === 'year') !== (inYear <= TIMELINE_PAGE_CLAIMS)) return null;
    }
    const window = range.grain === 'all' ? `${dated} IS NOT NULL AND $1::text IS NOT NULL AND $2::text IS NOT NULL` : `${dated} >= $1::timestamptz AND ${dated} < $2::timestamptz`;
    const claims = await ctx.store.query<TimelineClaim>(
      `SELECT cl.id, cl.statement, cl.status, cl.kind, cl.event_at, cl.valid_from, cl.superseded_by, cl.fold_sha, s.key AS path,
              se.name AS subject, se.wiki_path AS subject_page
       FROM claims cl JOIN entities se ON se.id = cl.subject_id LEFT JOIN scopes s ON s.id = cl.primary_scope_id
       WHERE cl.tx_to IS NULL AND cl.canonical_id IS NULL AND ${window}
       ORDER BY ${dated}, se.name, cl.id LIMIT $3`,
      [start, end, TIMELINE_PAGE_CLAIMS],
    );
    if (claims.length === 0) return null;
    const total = range.grain === 'all' ? everything[0].n : await count(start, end);
    return {
      deps: claims.map((c) => ({ kind: 'claim' as const, id: c.id, sha: c.fold_sha })),
      inputsSha: sha16(['timeline@1', period, total, claims.map((c) => [c.fold_sha, c.superseded_by, c.path, c.subject, c.subject_page])]),
      data: { period, claims: claims.map((c) => ({ ...c, event_at: toIso(c.event_at), valid_from: toIso(c.valid_from) })), total },
    };
  },
  async render(_ctx, _pagePath, plan) {
    const period = plan.data.period as string;
    const claims = plan.data.claims as TimelineClaim[];
    const total = plan.data.total as number;
    const lines = [
      `# Timeline${period === 'all' ? '' : ` ${period}`}`,
      '',
      total > claims.length
        ? `_${total} dated claims; the oldest ${claims.length} are listed — \`knode_claims\` with a date range returns the rest._`
        : `_${total} dated ${total === 1 ? 'claim' : 'claims'} of every entity, in order: what happened on the day, or the day a statement starts to hold._`,
    ];
    let heading = '';
    for (const c of claims) {
      const day = toDateString(c.event_at) ?? toDateString(c.valid_from)!;
      // everything and a decade in years, a year in months, a month in days
      const h = period === 'all' || period.endsWith('0s') ? day.slice(0, 4) : period.length === 4 ? day.slice(0, 7) : day;
      if (h !== heading) {
        lines.push('', `## ${h}`, '');
        heading = h;
      }
      const kind = c.kind && c.kind !== 'fact' ? ` \`${c.kind}\`` : '';
      lines.push(`- ${day} · ${linked(c.subject, c.subject_page)}: ${oneLine(c.statement)} \`${c.status}\`${kind}${c.superseded_by ? ' _(superseded)_' : ''}${from(c.path)}`);
    }
    return {
      frontmatter: {
        title: period === 'all' ? 'Timeline' : `Timeline ${period}`,
        type: 'timeline',
        description: period === 'all' ? 'Every dated claim, in order, with its source.' : `Every dated claim in ${period}, with its source.`,
        generated: okfGenerated('knode-os/timeline'),
        knode: meta('timeline', { periods: [period] }),
      },
      regions: { body: lines.join('\n') },
    };
  },
};

/** `wiki/timelines/index.md#timelines`: the timeline pages, oldest first, with how much each holds. */
const timelinesIndex: PageGenerator = {
  kind: 'timelines_index',
  version: 1,
  llm: false,
  mode: 'region',
  async plan(ctx) {
    const years = await datedClaimCounts(ctx.store);
    const periods = timelinePeriods(years);
    if (periods.length === 0) return null;
    const rows = periods.map((p) => (p.period.length === 7 ? { ...p, first: null, last: null } : p));
    const setSha = sha16(rows);
    return { deps: [{ kind: 'set', id: 'timeline-pages', sha: setSha }], inputsSha: sha16(['timelines_index@1', setSha]), data: { rows } };
  },
  async render(_ctx, _pagePath, plan) {
    const rows = plan.data.rows as { period: string; n: number; first: string | null; last: string | null }[];
    const lines = [
      '## Timelines',
      '',
      `Every dated claim of every entity, in order, each line with its source: a page per decade, or per year, or per month, whichever holds at most ${TIMELINE_PAGE_CLAIMS}.`,
      '',
      ...rows.map((r) => `* [${r.period}](${r.period}.md) \`${r.n} ${r.n === 1 ? 'claim' : 'claims'}\`${r.first ? ` ${r.first} … ${r.last}` : ''}`),
    ];
    return { frontmatter: {}, regions: { timelines: lines.join('\n') } };
  },
};

/* ------------------------------ disagreements ---------------------------- */

/** Disagreements one page lists. */
export const DISAGREEMENTS_PAGE = 200;

export interface Disagreement {
  kind: 'conflict' | 'disputed';
  subject: string; subject_page: string | null;
  a: string; a_id: string; a_sha: string; a_path: string | null;
  b: string | null; b_id: string | null; b_sha: string | null; b_path: string | null;
  reason: string;
}

/**
 * Every disagreement the knowledge base holds, by subject: the pairs the
 * Judge found in conflict (`claim_pair_verdicts`), then the claims extracted
 * as disputed. The claim audit's other findings stay in the suggestions
 * queue: near-duplicate wordings and expired facts are leads for a person to
 * check (207 and 1,710 of them on two benchmark builds), not statements that
 * two sources disagree.
 */
export async function disagreements(store: Store): Promise<Disagreement[]> {
  const [conflicts, disputed] = await Promise.all([
    store.query<Disagreement>(
      `SELECT 'conflict' AS kind, se.name AS subject, se.wiki_path AS subject_page,
              a.statement AS a, a.id AS a_id, a.fold_sha AS a_sha, sa.key AS a_path,
              b.statement AS b, b.id AS b_id, b.fold_sha AS b_sha, sb.key AS b_path, v.reason
       FROM claim_pair_verdicts v
       JOIN claims a ON a.id = v.a_id AND a.tx_to IS NULL
       JOIN claims b ON b.id = v.b_id AND b.tx_to IS NULL
       JOIN entities se ON se.id = a.subject_id
       LEFT JOIN scopes sa ON sa.id = a.primary_scope_id LEFT JOIN scopes sb ON sb.id = b.primary_scope_id
       WHERE v.relation = 'conflict'`,
    ),
    store.query<Disagreement>(
      `SELECT 'disputed' AS kind, se.name AS subject, se.wiki_path AS subject_page,
              cl.statement AS a, cl.id AS a_id, cl.fold_sha AS a_sha, s.key AS a_path,
              NULL AS b, NULL AS b_id, NULL AS b_sha, NULL AS b_path, '' AS reason
       FROM claims cl JOIN entities se ON se.id = cl.subject_id LEFT JOIN scopes s ON s.id = cl.primary_scope_id
       WHERE cl.tx_to IS NULL AND cl.canonical_id IS NULL AND cl.status = 'disputed'`,
    ),
  ]);
  return [...conflicts, ...disputed].sort((x, y) =>
    x.subject.localeCompare(y.subject) || (x.kind === y.kind ? 0 : x.kind === 'conflict' ? -1 : 1) || x.a.localeCompare(y.a) || (x.b ?? '').localeCompare(y.b ?? ''));
}

const disagreementsPage: PageGenerator = {
  kind: 'disagreements',
  version: 1,
  llm: false,
  mode: 'file',
  async plan(ctx, pagePath) {
    const n = Number(path.posix.basename(pagePath, '.md'));
    if (!Number.isInteger(n) || n < 1) return null;
    const all = await disagreements(ctx.store);
    const slice = all.slice((n - 1) * DISAGREEMENTS_PAGE, n * DISAGREEMENTS_PAGE);
    if (slice.length === 0) return null;
    return {
      deps: slice.flatMap((d) => [
        { kind: 'claim' as const, id: d.a_id, sha: d.a_sha },
        ...(d.b_id ? [{ kind: 'claim' as const, id: d.b_id, sha: d.b_sha }] : []),
      ]),
      inputsSha: sha16(['disagreements@1', n, all.length, slice.map((d) => [d.kind, d.subject, d.subject_page, d.a_sha, d.a_path, d.b_sha, d.b_path, d.reason])]),
      data: { n, pages: Math.ceil(all.length / DISAGREEMENTS_PAGE), total: all.length, slice },
    };
  },
  async render(_ctx, _pagePath, plan) {
    const n = plan.data.n as number;
    const pages = plan.data.pages as number;
    const total = plan.data.total as number;
    const slice = plan.data.slice as Disagreement[];
    const lines = [
      `# Disagreements${pages > 1 ? ` (${n} of ${pages})` : ''}`,
      '',
      `_${total} ${total === 1 ? 'disagreement' : 'disagreements'} in all, by subject: two claims the Judge found in conflict (⟷, with its reason), and claims extracted as disputed. Each side names its source._`,
    ];
    let subject = '';
    for (const d of slice) {
      if (d.subject !== subject) {
        lines.push('', `## ${d.subject}`, '');
        subject = d.subject;
        if (d.subject_page) lines.push(`See [[${d.subject}]].`, '');
      }
      lines.push(d.kind === 'conflict'
        ? `- ${oneLine(d.a)}${from(d.a_path)} ⟷ ${oneLine(d.b ?? '')}${from(d.b_path)}${d.reason ? ` (${oneLine(d.reason)})` : ''}`
        : `- ${oneLine(d.a)} \`disputed\`${from(d.a_path)}`);
    }
    return {
      frontmatter: {
        title: pages > 1 ? `Disagreements ${n}` : 'Disagreements',
        type: 'disagreements',
        description: 'Statements the sources disagree on, by subject, each side with its source.',
        generated: okfGenerated('knode-os/disagreements'),
        knode: meta('disagreements', { pages: [String(n)] }),
      },
      regions: { body: lines.join('\n') },
    };
  },
};

/** `wiki/disagreements/index.md#disagreements`: the disagreement pages and the subjects on each. */
const disagreementsIndex: PageGenerator = {
  kind: 'disagreements_index',
  version: 1,
  llm: false,
  mode: 'region',
  async plan(ctx) {
    const all = await disagreements(ctx.store);
    if (all.length === 0) return null;
    const rows: { n: number; count: number; subjects: string[] }[] = [];
    for (let i = 0; i < all.length; i += DISAGREEMENTS_PAGE) {
      const slice = all.slice(i, i + DISAGREEMENTS_PAGE);
      rows.push({ n: i / DISAGREEMENTS_PAGE + 1, count: slice.length, subjects: [...new Set(slice.map((d) => d.subject))] });
    }
    const setSha = sha16(rows);
    return { deps: [{ kind: 'set', id: 'disagreement-pages', sha: setSha }], inputsSha: sha16(['disagreements_index@1', setSha]), data: { rows } };
  },
  async render(_ctx, _pagePath, plan) {
    const rows = plan.data.rows as { n: number; count: number; subjects: string[] }[];
    const lines = [
      '## Disagreements',
      '',
      'Where the sources disagree: claims the Judge found in conflict, and claims extracted as disputed, by subject, each side with its source. The claim audit\'s leads (similar wordings, expired facts) are review suggestions, not here.',
      '',
      ...rows.map((r) => `* [Page ${r.n}](${r.n}.md) \`${r.count}\` — ${r.subjects.slice(0, 30).join(', ')}${r.subjects.length > 30 ? `, … (${r.subjects.length} subjects)` : ''}`),
    ];
    return { frontmatter: {}, regions: { disagreements: lines.join('\n') } };
  },
};

export const CORPUS_GENERATORS: Record<CorpusPageKind, PageGenerator> = {
  mentions,
  mentions_index: mentionsIndex,
  timeline,
  timelines_index: timelinesIndex,
  disagreements: disagreementsPage,
  disagreements_index: disagreementsIndex,
};
