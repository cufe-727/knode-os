import fs from 'node:fs';
import path from 'node:path';
import { safePath } from '../fs/files.js';
import { archivedPath } from '../lineage/scope.js';
import { Store } from '../store/db.js';
import { toDateString } from '../store/temporal.js';
import {
  datedClaimCounts, DISAGREEMENTS_PAGE, disagreements, extendsName, MENTION_BROAD_CORPUS, MENTION_BROAD_SHARE, MENTION_MIN_DOCS, rootsOf, timelinePeriods, usableName,
} from './corpus-views.js';
import { archivePage, PagesContext, regeneratePage } from './pages.js';

/**
 * Creating and refreshing the pages across documents (./corpus-views.ts):
 * `generateWiki` runs the full pass, the background document pass a focused
 * one over what it has just written. Pages already written are also kept
 * current through their deps (an entity, claim or document they list
 * changes) by `reconcileViews`; what deps cannot see — a new document naming
 * the family, a new dated claim, a new verdict — is what these passes add.
 */

export interface CorpusPassOptions {
  actor?: string;
  /** What a document pass has just written: only the pages those can change are planned again. */
  focus?: { entities?: string[]; claims?: string[] };
  /** Mention pages created at most; default one per four documents, 30 to 300, as entity pages. */
  maxMentions?: number;
}

/** Mention pages a focused pass creates at most: each is a file the next sync indexes and embeds. */
const MENTION_PAGES_PER_PASS = 30;

/** Bring an archived copy back so human-written parts survive re-creation (as pages.ts does for its own). */
function restoreArchived(dataDir: string, pagePath: string): void {
  const abs = safePath(dataDir, pagePath);
  const archived = safePath(dataDir, archivedPath(pagePath));
  if (!fs.existsSync(abs) && fs.existsSync(archived)) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.renameSync(archived, abs);
  }
}

async function livePages(store: Store, kind: string): Promise<string[]> {
  return (await store.query<{ path: string }>(`SELECT path FROM pages WHERE kind = $1 AND status <> 'archived' ORDER BY path`, [kind])).map((r) => r.path);
}

/** Write (or bring up to date) each path; returns the ones written. */
async function writeAll(ctx: PagesContext, paths: string[], kind: Parameters<typeof regeneratePage>[2], actor: string): Promise<string[]> {
  const written: string[] = [];
  for (const p of paths) {
    restoreArchived(ctx.dataDir, p);
    if ((await regeneratePage(ctx, p, kind, { actor })) === 'regenerated') written.push(p);
  }
  return written;
}

/**
 * The timeline pages: one per year, or per month of a year with more dated
 * claims than a page lists. A focused pass plans again only the periods its
 * claims fall in; a full one also archives the pages of periods that no
 * longer exist (a year split into months, or emptied).
 */
export async function ensureTimelines(ctx: PagesContext, opts: CorpusPassOptions = {}): Promise<string[]> {
  const actor = opts.actor ?? 'wiki';
  const years = await datedClaimCounts(ctx.store);
  const wanted = timelinePeriods(years).map((p) => `wiki/timelines/${p.period}.md`);
  let paths = wanted;
  if (opts.focus) {
    const ids = opts.focus.claims ?? [];
    if (ids.length === 0) return [];
    const rows = await ctx.store.query<{ d: string | Date }>(
      `SELECT COALESCE(event_at, valid_from) AS d FROM claims WHERE id = ANY($1::text[]) AND COALESCE(event_at, valid_from) IS NOT NULL`,
      [ids],
    );
    const days = rows.map((r) => toDateString(r.d)).filter((d): d is string => Boolean(d));
    if (days.length === 0) return [];
    const covers = (p: string, d: string) => {
      const period = path.posix.basename(p, '.md');
      return period === 'all' ? true : period.endsWith('0s') ? d.startsWith(period.slice(0, 3)) : d.startsWith(period);
    };
    paths = wanted.filter((p) => days.some((d) => covers(p, d)));
  }
  const written = await writeAll(ctx, paths, 'timeline', actor);
  // a year split into months: its page goes (plan returns null), and the other way round
  for (const p of await livePages(ctx.store, 'timeline')) {
    // a focused pass re-plans the stale pages near what it wrote; a full pass all of them
    if (!wanted.includes(p) && (!opts.focus || paths.length > 0)) {
      await regeneratePage(ctx, p, 'timeline', { actor });
    }
  }
  await regeneratePage(ctx, 'wiki/timelines/index.md#timelines', 'timelines_index', { actor });
  return written;
}

/**
 * The disagreement pages, DISAGREEMENTS_PAGE to a page. A focused pass
 * writes them only when one of its claims is in a conflict or disputed.
 */
export async function ensureDisagreements(ctx: PagesContext, opts: CorpusPassOptions = {}): Promise<string[]> {
  const actor = opts.actor ?? 'wiki';
  const all = await disagreements(ctx.store);
  if (opts.focus) {
    const ids = new Set(opts.focus.claims ?? []);
    if (!all.some((d) => ids.has(d.a_id) || (d.b_id !== null && ids.has(d.b_id)))) return [];
  }
  const pages = Math.ceil(all.length / DISAGREEMENTS_PAGE);
  const written = await writeAll(ctx, Array.from({ length: pages }, (_, i) => `wiki/disagreements/${i + 1}.md`), 'disagreements', actor);
  // pages past the last are archived by their plan
  for (const p of await livePages(ctx.store, 'disagreements')) {
    if (Number(path.posix.basename(p, '.md')) > pages) await regeneratePage(ctx, p, 'disagreements', { actor });
  }
  await regeneratePage(ctx, 'wiki/disagreements/index.md#disagreements', 'disagreements_index', { actor });
  return written;
}

interface Candidate { id: string; name: string; docs: number }

/**
 * Entity families worth a mention page, the most documented first: an entity
 * with the entities whose names extend it ("Gemini" with "Gemini 1.5"), a
 * variant standing under its root rather than on a page of its own. Ranked by
 * the documents the graph's mentions put them in, summed over the family (an
 * upper bound: one document mentioning two variants counts twice); the page
 * itself finds its documents in the text. A family in more than half of a
 * corpus of twenty documents or more gets none: a list of nearly every
 * document says nothing the sources index does not.
 */
export async function mentionCandidates(store: Store, opts: { focus?: string[] } = {}): Promise<Candidate[]> {
  const [{ n: total }] = await store.query<{ n: number }>(`SELECT count(*)::int AS n FROM documents WHERE root = 'docs' AND status = 'indexed'`);
  let names: string[] | null = null;
  if (opts.focus) {
    if (opts.focus.length === 0) return [];
    const touched = await store.query<{ name: string }>(`SELECT name FROM entities WHERE id = ANY($1::text[])`, [opts.focus]);
    names = [...new Set(touched.flatMap((e) => [e.name.toLowerCase(), ...rootsOf(e.name)]))];
  }
  const rows = await store.query<Candidate & { lname: string }>(
    `SELECT e.id, e.name, lower(e.name) AS lname, count(DISTINCT m.document_id)::int AS docs
     FROM entities e JOIN entity_mentions m ON m.entity_id = e.id JOIN documents d ON d.id = m.document_id AND d.root = 'docs'
     WHERE e.tx_to IS NULL AND e.canonical_id IS NULL
     GROUP BY e.id, e.name`,
  );
  const sorted = rows.filter((r) => usableName(r.name)).sort((a, b) => (a.lname < b.lname ? -1 : a.lname > b.lname ? 1 : a.id < b.id ? -1 : 1));
  const byName = new Map<string, Candidate & { lname: string }>();
  for (const r of sorted) if (!byName.has(r.lname)) byName.set(r.lname, r);
  const out: Candidate[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    if (byName.get(r.lname) !== r) continue;
    // a variant stands under the family it extends
    if (rootsOf(r.name).some((root) => byName.has(root))) continue;
    if (names && !names.includes(r.lname)) continue;
    let docs = r.docs;
    // the variants follow their root in name order
    for (let j = i + 1; j < sorted.length && sorted[j].lname.startsWith(r.lname); j++) if (extendsName(sorted[j].name, r.name)) docs += sorted[j].docs;
    if (docs < MENTION_MIN_DOCS) continue;
    if (total >= MENTION_BROAD_CORPUS && docs > total * MENTION_BROAD_SHARE) continue;
    out.push({ id: r.id, name: r.name, docs });
  }
  return out.sort((a, b) => b.docs - a.docs || (a.id < b.id ? -1 : 1));
}

/**
 * Mention pages: brought up to date for the families a pass touches, and
 * created for the best documented ones that have none, up to `maxMentions`.
 */
export async function ensureMentionPages(ctx: PagesContext, opts: CorpusPassOptions = {}): Promise<string[]> {
  const actor = opts.actor ?? 'wiki';
  const focus = opts.focus ? opts.focus.entities ?? [] : undefined;
  let max = opts.maxMentions;
  if (max === undefined) {
    if (focus) max = MENTION_PAGES_PER_PASS;
    else {
      const [{ n }] = await ctx.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM documents WHERE root = 'docs' AND status = 'indexed'`);
      max = Math.min(300, Math.max(30, Math.ceil(n / 4)));
    }
  }
  const existing = new Set(await livePages(ctx.store, 'mentions'));
  const candidates = await mentionCandidates(ctx.store, { focus });
  const paths: string[] = [];
  let fresh = 0;
  for (const c of candidates) {
    const p = `wiki/mentions/${c.id}.md`;
    if (existing.has(p)) paths.push(p);
    else if (fresh < max) {
      paths.push(p);
      fresh++;
    }
  }
  const written = await writeAll(ctx, paths, 'mentions', actor);
  if (written.length > 0 || !focus) await regeneratePage(ctx, 'wiki/mentions/index.md#mentions', 'mentions_index', { actor });
  return written;
}

/** Every kind of page across documents, in one pass; returns the paths written. */
export async function ensureCorpusPages(ctx: PagesContext, opts: CorpusPassOptions = {}): Promise<string[]> {
  return [
    ...await ensureMentionPages(ctx, opts),
    ...await ensureTimelines(ctx, opts),
    ...await ensureDisagreements(ctx, opts),
  ];
}
