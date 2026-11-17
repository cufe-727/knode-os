import fs from 'node:fs';
import path from 'node:path';
import type { DocumentedEntity, KbHoldings } from '../research/survey.js';
import type { Store } from '../store/db.js';
import { toIso } from '../store/temporal.js';
import type { PageGenerator, PagePlan, PagesContext } from './pages.js';
import { shortByRow, summaryMinChars } from './summary.js';
import { sha16 } from '../digest.js';

/**
 * The wiki's navigation as model-free views: what `wiki/index.md` leads to,
 * paged so that every generated page is three links from it at any size.
 *
 *   wiki/index.md#contents            the overview, every index, the best documented entities
 *   wiki/overview.md#holdings         what the knowledge base holds, in numbers (knode_survey's)
 *   wiki/sources/index.md#sources     every document — inline up to SHELF_ROWS, else one row per folder
 *     by-folder/<folder>/index.md     that folder's documents, or the list of its pages
 *     by-folder/<folder>/<n>/index.md SHELF_ROWS documents each, in the order they were dated or added
 *   wiki/entities/index.md#entities   every entity page — inline, else one row per type
 *     by-type/<type>/[<n>/]index.md   SHELF_ROWS pages each, the best documented first
 *   wiki/<dir>/index.md#pages         every page of another wiki folder (concepts, dreams, datasets, research…)
 *     pages/<n>/index.md              SHELF_ROWS pages each, by path
 *
 * The list used to be one region per index cut at 2,000 rows: on a workspace
 * of 26,878 documents and 17,250 summary pages the sources index held a
 * fifteenth of them in a 400 KB file, and the rest were linked from nowhere.
 * Paged here, no index file holds more than SHELF_ROWS rows or HUB_LINKS
 * links, and a hub links every page of its tree directly while the tree has
 * at most HUB_LINKS pages: SHELF_ROWS × HUB_LINKS = 80,000 documents (or
 * entity pages) stay three steps from the front page — index.md → hub →
 * page of the list → the page itself. Past that a hub links each folder's
 * own list, one step more.
 *
 * Every paged file is an `index.md`: OKF reserves the name for navigation
 * (no frontmatter, so they are region views like the hubs), the lint and the
 * evaluation count no index as knowledge, and a link to a folder (`dir/`)
 * opens it.
 *
 * Documents are paged in the order they were dated (or, undated, added), so a
 * document that arrives rewrites only the last page of its folder and the
 * hub's counts, not every page after it; a back-dated one shifts the pages
 * after its own.
 */

/** Rows one index file lists at most. */
export const SHELF_ROWS = 200;
/** Links a hub carries at most; past it, a hub links each group's own list instead of its pages. */
export const HUB_LINKS = 400;
/** Groups (folders, types) a hub names; the smallest of the rest share one `_other` list. */
export const HUB_GROUPS = 200;
const OTHER = '_other';

export type NavPageKind = 'sources_shelf' | 'entities_shelf' | 'pages_index' | 'pages_shelf' | 'wiki_contents' | 'overview_holdings';

/** Top-level wiki folders listed by trees of their own, or not pages at all. */
const NOT_PAGE_DIRS = new Set(['sources', 'entities', 'attachments', '.obsidian', '.archive']);

const fmt = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
const day = (v: string | Date | null | undefined) => toIso(v ?? null)?.slice(0, 10) ?? null;
/** A label inside `[…]`: brackets would end the link. */
const label = (s: string) => s.replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim() || '(untitled)';

/** A link from one wiki file to another, relative as OKF and Obsidian read it, with the characters a Markdown link cannot hold escaped. */
export function relLink(fromFile: string, toFile: string): string {
  const rel = path.posix.relative(path.posix.dirname(fromFile), toFile) || path.posix.basename(toFile);
  return rel.replace(/[ ()<>%#?[\]]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/** The first and last titles of a page of a list, cut short. */
function titleSpan(rows: { label: string }[]): string {
  const cut = (s: string) => (s.length > 24 ? `${s.slice(0, 23)}…` : s);
  return `${cut(label(rows[0]?.label ?? ''))} … ${cut(label(rows[rows.length - 1]?.label ?? ''))}`;
}

/* --------------------------------- trees --------------------------------- */

export interface ShelfRow {
  group: string;
  /** The wiki file the row links, or null for a row without a page (a short document). */
  target: string | null;
  label: string;
  /** Text after the link. */
  tail: string;
  /** A day this row stands at, for the range a page of the list is labelled with. */
  when?: string | null;
  /** The document a row stands for: a change to it dirties the page that lists it. */
  doc?: { path: string; sha: string };
}

export interface Shelf {
  file: string;
  group: string;
  /** 0: the group's own page (its rows, or the list of its pages); n ≥ 1: its n-th page. */
  part: number;
  rows: ShelfRow[];
  parts: Shelf[];
  label: string;
}

export interface TreeLayout {
  inline: boolean;
  total: number;
  groups: { group: string; rows: ShelfRow[]; page: Shelf }[];
  /** Every paged file of the tree, by file. */
  shelves: Map<string, Shelf>;
  /** The hub links each group's pages, not only the group's own list. */
  direct: boolean;
}

export interface TreeSpec {
  /** Cache key. */
  id: string;
  shelfKind: NavPageKind;
  hubKind: 'sources_index' | 'entities_index' | 'pages_index';
  hubFile: string;
  hubRegion: string;
  /** Where the paged files go. */
  base: string;
  /** One group whose list is the hub itself (a wiki folder's pages). */
  single?: boolean;
  noun: [string, string];
  /** What the hub is called, for the way back up from a page of the list. */
  hubName: string;
  groupName(group: string): string;
  segment(group: string): string;
  rows(ctx: PagesContext): Promise<ShelfRow[]>;
  partLabel(rows: ShelfRow[], start: number): string;
  /** The order a list shows its rows in (they are paged in the order `rows` returns them). */
  display?(rows: ShelfRow[]): ShelfRow[];
  /** The hub's text above its list. */
  intro(layout: TreeLayout, rows: ShelfRow[]): string[];
  groupTail?(rows: ShelfRow[]): string;
}

export const SHELF_REGION = 'shelf';

/** Cut a tree's rows into groups and pages. Pure: the same rows give the same files. */
export function layoutTree(spec: TreeSpec, rows: ShelfRow[]): TreeLayout {
  const byGroup = new Map<string, ShelfRow[]>();
  for (const r of rows) (byGroup.get(r.group) ?? byGroup.set(r.group, []).get(r.group)!).push(r);
  let groups = [...byGroup].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  if (groups.length > HUB_GROUPS) {
    const rest = groups.slice(HUB_GROUPS - 1).sort((a, b) => a[0].localeCompare(b[0]));
    groups = [...groups.slice(0, HUB_GROUPS - 1), [OTHER, rest.flatMap(([, r]) => r)]];
  }
  const inline = rows.length <= SHELF_ROWS;
  const shelves = new Map<string, Shelf>();
  const out: TreeLayout['groups'] = [];
  for (const [group, list] of groups) {
    const dir = spec.single ? spec.base : `${spec.base}/${spec.segment(group)}`;
    const own = spec.single ? spec.hubFile : `${dir}/index.md`;
    const page: Shelf = { file: own, group, part: 0, rows: [], parts: [], label: spec.groupName(group) };
    if (list.length <= SHELF_ROWS) page.rows = list;
    else {
      for (let start = 0, n = 1; start < list.length; start += SHELF_ROWS, n++) {
        const slice = list.slice(start, start + SHELF_ROWS);
        page.parts.push({ file: `${dir}/${n}/index.md`, group, part: n, rows: slice, parts: [], label: spec.partLabel(slice, start) });
      }
    }
    out.push({ group, rows: list, page });
    if (!inline) {
      if (!spec.single) shelves.set(page.file, page);
      for (const p of page.parts) shelves.set(p.file, p);
    }
  }
  const links = out.reduce((n, g) => n + 1 + g.page.parts.length, 0);
  return { inline, total: rows.length, groups: out, shelves, direct: links <= HUB_LINKS };
}

function rowLine(file: string, r: ShelfRow): string {
  return `* ${r.target ? `[${label(r.label)}](${relLink(file, r.target)})` : label(r.label)}${r.tail}`;
}

/** The hub region's text. */
export function renderHub(spec: TreeSpec, layout: TreeLayout, rows: ShelfRow[]): string {
  const lines = [...spec.intro(layout, rows), ''];
  const show = spec.display ?? ((r: ShelfRow[]) => r);
  if (layout.inline) {
    lines.push(...show(rows).map((r) => rowLine(spec.hubFile, r)));
  } else if (spec.single) {
    for (const p of layout.groups[0]?.page.parts ?? []) lines.push(`* [${label(p.label)}](${relLink(spec.hubFile, p.file)}) — ${plural(p.rows.length, spec.noun[0], spec.noun[1])}`);
  } else {
    for (const g of layout.groups) {
      const parts = layout.direct && g.page.parts.length
        ? `: ${[...g.page.parts].reverse().map((p) => `[${label(p.label)}](${relLink(spec.hubFile, p.file)})`).join(' · ')}`
        : '';
      lines.push(`* **[${label(spec.groupName(g.group))}](${relLink(spec.hubFile, g.page.file)})** — ${plural(g.rows.length, spec.noun[0], spec.noun[1])}${spec.groupTail?.(g.rows) ?? ''}${parts}`);
    }
  }
  return lines.join('\n');
}

/** A paged file's region: a heading, the way back up, and its rows or the list of its pages. */
export function renderShelf(spec: TreeSpec, shelf: Shelf, layout: TreeLayout): string {
  const name = spec.groupName(shelf.group);
  const group = layout.groups.find((g) => g.group === shelf.group)!;
  const show = spec.display ?? ((r: ShelfRow[]) => r);
  const up = shelf.part === 0 || spec.single ? spec.hubFile : group.page.file;
  const upName = shelf.part === 0 || spec.single ? spec.hubName : name;
  const lines = [
    `# ${name}${shelf.part ? ` — ${shelf.label}` : ''}`,
    '',
    `↑ [${label(upName)}](${relLink(shelf.file, up)})${shelf.part ? ` · page ${shelf.part} of ${group.page.parts.length}` : ''} · ${plural(shelf.part ? shelf.rows.length : group.rows.length, spec.noun[0], spec.noun[1])}`,
    '',
  ];
  if (shelf.part === 0 && shelf.parts.length) {
    lines.push(`Listed ${SHELF_ROWS} to a page:`, '');
    for (const p of [...shelf.parts].reverse()) lines.push(`* [${label(p.label)}](${relLink(shelf.file, p.file)}) — ${plural(p.rows.length, spec.noun[0], spec.noun[1])}`);
  } else {
    lines.push(...show(shelf.rows).map((r) => rowLine(shelf.file, r)));
  }
  return lines.join('\n');
}

/* ------------------------------- row caches ------------------------------ */

/**
 * The rows of a tree, read once per refresh: a refresh plans a hub and every
 * page of its list one after another, and each would read the same rows
 * again. Only inside a refresh (`withTreeRows`): a page planned on its own —
 * `reconcileViews` after a document it lists changed — reads them fresh, or
 * it would render the rows from before the change.
 */
const rowCache = new WeakMap<Store, Map<string, Promise<unknown>>>();
const refreshing = new WeakMap<Store, number>();

export async function withTreeRows<T>(store: Store, fn: () => Promise<T>): Promise<T> {
  const depth = refreshing.get(store) ?? 0;
  if (depth === 0) rowCache.set(store, new Map());
  refreshing.set(store, depth + 1);
  try {
    return await fn();
  } finally {
    refreshing.set(store, depth);
    if (depth === 0) rowCache.delete(store);
  }
}

function cached<T>(store: Store, key: string, read: () => Promise<T>): Promise<T> {
  const byStore = rowCache.get(store);
  if (!byStore) return read();
  const hit = byStore.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const rows = read();
  byStore.set(key, rows);
  rows.catch(() => byStore.delete(key));
  return rows;
}

export function treeRows(ctx: PagesContext, spec: TreeSpec): Promise<ShelfRow[]> {
  return cached(ctx.store, spec.id, () => spec.rows(ctx));
}

/* --------------------------------- specs --------------------------------- */

/** `folderOf` (src/research/survey.ts), for raw/docs paths: `raw/docs/a/b/c.md` → `raw/docs/a`, `raw/docs/x.md` → `raw/docs`. */
function docFolder(p: string): string {
  const parts = p.split('/');
  return parts.length > 3 ? parts.slice(0, 3).join('/') : 'raw/docs';
}

/** Summary pages by the document they summarize (pages.ts `summaryPagesByDocument`, not imported: pages.ts imports this module). */
async function summaryPages(store: Store): Promise<Map<string, string>> {
  const rows = await store.query<{ path: string; doc: string }>(
    `SELECT p.path, d.input_id AS doc
     FROM pages p JOIN deps d ON d.artifact_kind = 'page' AND d.artifact_id = p.path AND d.input_kind = 'document'
     WHERE p.kind = 'source_summary' AND p.status <> 'archived'`,
  );
  return new Map(rows.map((r) => [r.doc, r.path]));
}

interface SourceRowData { path: string; title: string | null; sha256: string; bytes: number; chars: number | null; doc_date: string | Date | null; created_at: string | Date }

export const sourcesTree: TreeSpec = {
  id: 'sources',
  shelfKind: 'sources_shelf',
  hubKind: 'sources_index',
  hubFile: 'wiki/sources/index.md',
  hubRegion: 'sources',
  base: 'wiki/sources/by-folder',
  noun: ['document', 'documents'],
  hubName: 'Sources index',
  groupName: (g) => (g === OTHER ? 'other folders' : g),
  segment: (g) => (g === OTHER ? OTHER : g === 'raw/docs' ? '_top' : g.slice('raw/docs/'.length)),
  async rows(ctx) {
    const docs = await ctx.store.query<SourceRowData>(
      `SELECT path, title, sha256, bytes, chars, doc_date, created_at FROM documents
       WHERE root = 'docs' AND status = 'indexed' AND kind = 'source'`,
    );
    const pages = await summaryPages(ctx.store);
    const minChars = summaryMinChars(ctx.config);
    const rows = docs.map((d) => {
      const page = pages.get(d.path) ?? null;
      const dated = day(d.doc_date);
      // under the size threshold by its row alone (src/wiki/summary.ts `shortByRow`)
      const short = !page && shortByRow({ bytes: d.bytes, chars: d.chars }, minChars) === true;
      return {
        group: docFolder(d.path),
        target: page,
        label: d.title ?? path.posix.basename(d.path),
        tail: ` - \`${d.path}\`${dated ? ` · ${dated}` : ''}${short ? ' `short`' : ''}`,
        when: dated ?? day(d.created_at),
        doc: { path: d.path, sha: d.sha256 },
        order: toIso(d.doc_date ?? d.created_at) ?? '',
      };
    });
    rows.sort((a, b) => a.group.localeCompare(b.group) || a.order.localeCompare(b.order) || a.doc.path.localeCompare(b.doc.path));
    return rows.map(({ order: _order, ...r }) => r);
  },
  partLabel: (rows) => {
    const from = rows[0]?.when ?? '?';
    const to = rows[rows.length - 1]?.when ?? '?';
    // a folder imported in one go is all one day: the titles tell its pages apart (they run in path order there)
    return from === to ? `${from}: ${titleSpan(rows)}` : `${from} → ${to}`;
  },
  // newest first, as the index has always read
  display: (rows) => [...rows].sort((a, b) => (b.when ?? '').localeCompare(a.when ?? '') || (a.doc?.path ?? '').localeCompare(b.doc?.path ?? '')),
  intro(layout, rows) {
    const pages = rows.filter((r) => r.target).length;
    const short = rows.filter((r) => r.tail.endsWith('`short`')).length;
    const lines = [
      '## Sources index',
      '',
      `${plural(rows.length, 'indexed document')}${layout.groups.length > 1 ? ` in ${plural(layout.groups.length, 'folder')}` : ''}, ${fmt(pages)} with a summary page${short ? `, ${fmt(short)} short` : ''}. A document under \`extraction.summaryMinChars\` (\`short\`) gets none: search finds the document itself.`,
    ];
    if (!layout.inline) {
      lines.push('', `Each folder's documents are listed ${SHELF_ROWS} to a page, in the order they were dated (or, undated, added); the newest page first.`);
    }
    return lines;
  },
  groupTail(rows) {
    const pages = rows.filter((r) => r.target).length;
    const days = rows.map((r) => r.when).filter((d): d is string => Boolean(d)).sort();
    return `, ${fmt(pages)} with a summary${days.length ? `, ${days[0]} → ${days[days.length - 1]}` : ''}`;
  },
};

export interface EntityPageRow extends DocumentedEntity { description: string; fold_sha: string }

/** Every entity page with how many claims from how many documents stand on it, the best documented first. */
export async function entityPageRows(store: Store): Promise<EntityPageRow[]> {
  return store.query<EntityPageRow>(
    `SELECT e.id, e.name, e.type, e.description, e.wiki_path AS "wikiPath", e.fold_sha, COALESCE(c.claims, 0)::int AS claims, COALESCE(c.docs, 0)::int AS docs
     FROM entities e
     LEFT JOIN LATERAL (
       SELECT count(*) AS claims, count(DISTINCT cl.primary_scope_id) AS docs
       FROM claims cl WHERE cl.subject_id = e.id AND cl.tx_to IS NULL AND cl.canonical_id IS NULL
     ) c ON true
     WHERE e.wiki_path LIKE 'wiki/entities/%' AND e.tx_to IS NULL AND e.canonical_id IS NULL
     ORDER BY COALESCE(c.docs, 0) DESC, COALESCE(c.claims, 0) DESC, e.name, e.id`,
  );
}

/** `entityPageRows`, read once per refresh: the entities tree, the contents and the overview all use it. */
export function cachedEntityPageRows(store: Store): Promise<EntityPageRow[]> {
  return cached(store, 'entity-pages', () => entityPageRows(store));
}

export const entitiesTree: TreeSpec = {
  id: 'entities',
  shelfKind: 'entities_shelf',
  hubKind: 'entities_index',
  hubFile: 'wiki/entities/index.md',
  hubRegion: 'entities',
  base: 'wiki/entities/by-type',
  noun: ['page', 'pages'],
  hubName: 'Entity pages',
  groupName: (g) => (g === OTHER ? 'other types' : g),
  segment: (g) => g,
  async rows(ctx) {
    const rows = await cachedEntityPageRows(ctx.store);
    const byType = new Map<string, ShelfRow[]>();
    for (const r of rows) {
      const about = r.description ? ` — ${r.description.replace(/\s+/g, ' ').slice(0, 160)}` : '';
      const held = r.claims > 0 ? ` \`${plural(r.claims, 'claim')}, ${plural(r.docs, 'document')}\`` : '';
      const row: ShelfRow = { group: r.type, target: r.wikiPath, label: r.name, tail: ` (${r.type})${about}${held}` };
      (byType.get(r.type) ?? byType.set(r.type, []).get(r.type)!).push(row);
    }
    return [...byType.values()].flat();
  },
  partLabel: (rows, start) => `${fmt(start + 1)}–${fmt(start + rows.length)}`,
  intro(layout) {
    const lines = [
      '## Entity pages',
      '',
      layout.inline
        ? 'Every entity with a page, the ones the most documents speak of first. A page lists what the knowledge base holds about its entity — facts, dated history, disagreements, relations — each with the document it comes from.'
        : `${plural(layout.total, 'entity page')} in ${plural(layout.groups.length, 'type')}. A page lists what the knowledge base holds about its entity — facts, dated history, disagreements, relations — each with the document it comes from. Each type's pages are listed ${SHELF_ROWS} to a page, the ones the most documents speak of first.`,
    ];
    return lines;
  },
};

/** The tree of one other wiki folder's pages (concepts, dreams, datasets, research, …). */
export function pagesTree(dir: string): TreeSpec {
  return {
    id: `pages:${dir}`,
    shelfKind: 'pages_shelf',
    hubKind: 'pages_index',
    hubFile: `wiki/${dir}/index.md`,
    hubRegion: 'pages',
    base: `wiki/${dir}/pages`,
    single: true,
    noun: ['page', 'pages'],
    hubName: `wiki/${dir}`,
    groupName: () => `wiki/${dir}`,
    segment: () => '',
    async rows(ctx) {
      const docs = await ctx.store.query<{ path: string; title: string | null; doc_date: string | Date | null }>(
        `SELECT path, title, doc_date FROM documents
         WHERE root = 'wiki' AND status = 'indexed' AND path LIKE $1 AND path !~ '(^|/)(index|log)\\.md$'
         ORDER BY path`,
        [`wiki/${dir.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`],
      );
      return docs.map((d) => {
        const dated = day(d.doc_date);
        return { group: dir, target: d.path, label: d.title ?? path.posix.basename(d.path, '.md'), tail: dated ? ` · ${dated}` : '', when: dated };
      });
    },
    partLabel: (rows) => titleSpan(rows),
    intro: (layout) => [
      '## Pages',
      '',
      `${plural(layout.total, 'page')} in \`wiki/${dir}/\`${layout.inline ? '' : `, listed ${SHELF_ROWS} to a page by path`}.`,
    ],
  };
}

/** The other top-level wiki folders that hold pages, from the indexed documents. */
export async function pageDirs(store: Store): Promise<{ dir: string; n: number }[]> {
  const rows = await store.query<{ dir: string; n: number }>(
    `SELECT split_part(path, '/', 2) AS dir, count(*)::int AS n FROM documents
     WHERE root = 'wiki' AND status = 'indexed' AND path ~ '^wiki/[^/]+/.+' AND path !~ '(^|/)(index|log)\\.md$'
     GROUP BY 1 ORDER BY n DESC, dir`,
  );
  return rows.filter((r) => !NOT_PAGE_DIRS.has(r.dir) && !r.dir.startsWith('.'));
}

/** Top-level wiki folders with an index.md on disk, other than the sources and entities. */
function indexedDirs(dataDir: string): string[] {
  const wiki = path.join(dataDir, 'wiki');
  try {
    return fs.readdirSync(wiki, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !NOT_PAGE_DIRS.has(e.name) && !e.name.startsWith('.') && fs.existsSync(path.join(wiki, e.name, 'index.md')))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** The tree a paged file or hub belongs to, from its path alone (a plan gets nothing else). */
export function treeOf(file: string): TreeSpec | null {
  if (file === sourcesTree.hubFile || file.startsWith(`${sourcesTree.base}/`)) return sourcesTree;
  if (file === entitiesTree.hubFile || file.startsWith(`${entitiesTree.base}/`)) return entitiesTree;
  const m = /^wiki\/([^/]+)\/(index\.md|pages\/)/.exec(file);
  return m && !NOT_PAGE_DIRS.has(m[1]) ? pagesTree(m[1]) : null;
}

/* ------------------------------- generators ------------------------------ */

const fileOf = (pagePath: string) => pagePath.split('#', 1)[0];

async function planHub(ctx: PagesContext, spec: TreeSpec, kindVersion: string): Promise<PagePlan | null> {
  const rows = await treeRows(ctx, spec);
  if (rows.length === 0) return null;
  const layout = layoutTree(spec, rows);
  const text = renderHub(spec, layout, rows);
  const setSha = sha16(text);
  return {
    // inline, a change to a listed document dirties the hub; paged, the page that lists it
    deps: [
      { kind: 'set', id: spec.id, sha: setSha },
      ...(layout.inline ? rows.flatMap((r) => (r.doc ? [{ kind: 'document' as const, id: r.doc.path, sha: r.doc.sha }] : [])) : []),
    ],
    inputsSha: sha16([kindVersion, setSha]),
    data: { text },
  };
}

function hubGenerator(kind: TreeSpec['hubKind'], version: number, specFor: (pagePath: string) => TreeSpec | null): PageGenerator {
  return {
    kind,
    version,
    llm: false,
    mode: 'region',
    async plan(ctx, pagePath) {
      const spec = specFor(pagePath);
      return spec ? planHub(ctx, spec, `${kind}@${version}`) : null;
    },
    async render(_ctx, pagePath, plan) {
      const spec = specFor(pagePath)!;
      return { frontmatter: {}, regions: { [spec.hubRegion]: plan.data.text as string } };
    },
  };
}

function shelfGenerator(kind: NavPageKind, version: number): PageGenerator {
  return {
    kind,
    version,
    llm: false,
    mode: 'region',
    async plan(ctx, pagePath) {
      const file = fileOf(pagePath);
      const spec = treeOf(file);
      if (!spec || spec.shelfKind !== kind) return null;
      const rows = await treeRows(ctx, spec);
      const layout = layoutTree(spec, rows);
      const shelf = layout.shelves.get(file);
      // a page the tree no longer has (it shrank, or a folder was re-paged) is archived
      if (!shelf) return null;
      const text = renderShelf(spec, shelf, layout);
      return {
        deps: [
          { kind: 'set', id: `${spec.id}:${file}`, sha: sha16(text) },
          ...shelf.rows.flatMap((r) => (r.doc ? [{ kind: 'document' as const, id: r.doc.path, sha: r.doc.sha }] : [])),
        ],
        inputsSha: sha16([`${kind}@${version}`, text]),
        data: { text },
      };
    },
    async render(_ctx, _pagePath, plan) {
      return { frontmatter: {}, regions: { [SHELF_REGION]: plan.data.text as string } };
    },
  };
}

export const sourcesIndex = hubGenerator('sources_index', 3, (p) => (fileOf(p) === sourcesTree.hubFile ? sourcesTree : null));
export const entitiesIndex = hubGenerator('entities_index', 2, (p) => (fileOf(p) === entitiesTree.hubFile ? entitiesTree : null));
export const pagesIndex = hubGenerator('pages_index', 1, (p) => {
  const spec = treeOf(fileOf(p));
  return spec?.hubKind === 'pages_index' && spec.hubFile === fileOf(p) ? spec : null;
});
export const sourcesShelf = shelfGenerator('sources_shelf', 1);
export const entitiesShelf = shelfGenerator('entities_shelf', 1);
export const pagesShelf = shelfGenerator('pages_shelf', 1);

/** Where a tree's list of one group starts: the group's own page when paged, else the hub. */
function groupPage(spec: TreeSpec, layout: TreeLayout, group: string): string {
  if (layout.inline) return spec.hubFile;
  return layout.groups.find((g) => g.group === group)?.page.file ?? spec.hubFile;
}

/** Entity pages `wiki/index.md` names as the best documented. */
const CONTENTS_TOP = 20;

/**
 * `wiki/index.md#contents`: where everything is, with real numbers. The hot
 * topics beside it rank by reading heat, which is zero on a knowledge base
 * nobody has read through knode yet; this ranks by how many documents stand
 * on a page.
 */
export const wikiContents: PageGenerator = {
  kind: 'wiki_contents',
  version: 1,
  llm: false,
  mode: 'region',
  async plan(ctx) {
    const sources = await treeRows(ctx, sourcesTree);
    const entities = await cachedEntityPageRows(ctx.store);
    const dirs = await pageDirs(ctx.store);
    if (sources.length === 0 && entities.length === 0 && dirs.length === 0) return null;
    const file = 'wiki/index.md';
    const summaries = sources.filter((r) => r.target).length;
    const folders = new Set(sources.map((r) => r.group)).size;
    const types = new Set(entities.map((e) => e.type)).size;
    const lines = ['## Contents', ''];
    lines.push(`* [Overview](${relLink(file, 'wiki/overview.md')}) — what this knowledge base holds: ${plural(sources.length, 'document')}, ${plural(entities.length, 'entity page')}, the kinds of claims, the dates they cover`);
    if (sources.length) lines.push(`* [Sources](${relLink(file, sourcesTree.hubFile)}) — ${plural(sources.length, 'document')} in ${plural(folders, 'folder')}, ${fmt(summaries)} with a summary page`);
    if (entities.length) lines.push(`* [Entities](${relLink(file, entitiesTree.hubFile)}) — ${plural(entities.length, 'entity page')} in ${plural(types, 'type')}`);
    // and the folders initDataDir seeded with an index that hold no page yet (datasets, dreams, …)
    const seeded = indexedDirs(ctx.dataDir).filter((d) => !dirs.some((x) => x.dir === d)).map((dir) => ({ dir, n: 0 }));
    for (const d of [...dirs, ...seeded]) lines.push(`* [${d.dir}](${relLink(file, `wiki/${d.dir}/index.md`)}) — ${d.n ? plural(d.n, 'page') : 'no pages yet'}`);
    lines.push(`* [Operation log](${relLink(file, 'wiki/log.md')})`);
    const top = entities.filter((e) => e.claims > 0).slice(0, CONTENTS_TOP);
    if (top.length) {
      lines.push('', '### Best documented', '');
      for (const e of top) lines.push(`* [${label(e.name)}](${relLink(file, e.wikiPath)}) — ${e.type}, ${plural(e.claims, 'claim')} from ${plural(e.docs, 'document')}`);
    }
    const text = lines.join('\n');
    return { deps: [{ kind: 'set', id: 'contents', sha: sha16(text) }], inputsSha: sha16(['wiki_contents@1', text]), data: { text } };
  },
  async render(_ctx, _pagePath, plan) {
    return { frontmatter: {}, regions: { contents: plan.data.text as string } };
  },
};

/** Folders and types the overview names before it says "and N more". */
const HOLDINGS_LIST = 30;

/** The overview's account of what the knowledge base holds, from `surveyHoldings`. Exported for the tests. */
export function renderHoldings(h: KbHoldings, links: { folder: (folder: string) => string | null; dirs: { dir: string; n: number }[]; queued: number }): string {
  const file = 'wiki/overview.md';
  const list = <T>(xs: T[], f: (x: T) => string, max = HOLDINGS_LIST) => `${xs.slice(0, max).map(f).join(' · ')}${xs.length > max ? ` · and ${fmt(xs.length - max)} more` : ''}`;
  const docs = h.documents;
  const lines = [
    '## What this knowledge base holds',
    '',
    '_Counted from the knowledge base (`knode_survey`) and kept current as documents arrive; the rest of this page is written by initialization or by you._',
    '',
    `* **Documents:** ${fmt(docs.total)}${docs.dateRange.from ? `, dated ${docs.dateRange.from} → ${docs.dateRange.to}` : ''} — ${fmt(h.stats.chunks)} chunks. Every one is listed in the [sources index](${relLink(file, sourcesTree.hubFile)}).`,
  ];
  if (docs.byType.length) lines.push(`* **Kinds:** ${list(docs.byType, (t) => `${t.type} ${fmt(t.n)}`)}`);
  const folders = docs.byFolder.filter((f) => f.folder.startsWith('raw/docs'));
  if (folders.length) {
    lines.push(`* **Folders:** ${list(folders, (f) => {
      const page = links.folder(f.folder);
      const name = page ? `[${label(f.folder)}](${relLink(file, page)})` : f.folder;
      return `${name} ${fmt(f.n)}${f.latest ? ` (latest ${f.latest})` : ''}`;
    })}`);
  }
  lines.push(`* **Entities:** ${fmt(h.entities.total)}${h.entities.byType.length ? ` — ${list(h.entities.byType, (t) => `${t.type} ${fmt(t.n)}`, 12)}` : ''}; ${fmt(h.entities.pages)} with a page, listed in the [entities index](${relLink(file, entitiesTree.hubFile)}).`);
  if (h.entities.topByDocuments.length) {
    lines.push(`* **Spoken of by the most documents:** ${h.entities.topByDocuments.map((e) => `[${label(e.name)}](${relLink(file, e.wikiPath)}) ${fmt(e.docs)}`).join(' · ')}`);
  }
  if (h.claims.total) {
    const kinds = h.claims.byKind.map((k) => `${k.kind} ${fmt(k.n)}`).join(' · ');
    const status = h.claims.byStatus.map((s) => `${s.status} ${fmt(s.n)}`).join(' · ');
    lines.push(`* **Claims:** ${fmt(h.claims.total)} — ${kinds}; ${status}${h.claims.eventRange.from ? `; events ${h.claims.eventRange.from} → ${h.claims.eventRange.to}` : ''}${h.claims.openDisputes ? `; ${plural(h.claims.openDisputes, 'open disagreement')}` : ''}.`);
  }
  if (h.relations.total) lines.push(`* **Relations:** ${fmt(h.relations.total)} — ${list(h.relations.byType, (t) => `${t.type.replace(/_/g, ' ')} ${fmt(t.n)}`, 12)}`);
  if (links.dirs.length) lines.push(`* **Other pages:** ${links.dirs.map((d) => `[${d.dir}](${relLink(file, `wiki/${d.dir}/index.md`)}) ${fmt(d.n)}`).join(' · ')}`);
  if (links.queued) lines.push(`* **Waiting for extraction:** ${plural(links.queued, 'document')}; what they hold is not counted yet.`);
  return lines.join('\n');
}

/**
 * `wiki/overview.md#holdings`. A region, not the page: the overview's prose
 * is initialization's (docs/design/07), and `isSeedTemplate` reads a seed
 * overview with only this region in it as still the seed, so the
 * "initialize" notice and the survey's `overview.seeded` keep their meaning.
 * When the agent rewrites the page without the region, the drift check marks
 * it dirty and the next refresh appends it again.
 */
export const overviewHoldings: PageGenerator = {
  kind: 'overview_holdings',
  version: 1,
  llm: false,
  mode: 'region',
  async plan(ctx) {
    const { surveyHoldings } = await import('../research/survey.js');
    const entities = await cachedEntityPageRows(ctx.store);
    const h = await surveyHoldings(ctx.store, { topByDocuments: entities.filter((e) => e.claims > 0) });
    if (h.documents.total === 0) return null;
    const sources = await treeRows(ctx, sourcesTree);
    const layout = layoutTree(sourcesTree, sources);
    const text = renderHoldings(h, {
      folder: (f) => (layout.groups.some((g) => g.group === f) ? groupPage(sourcesTree, layout, f) : null),
      dirs: await pageDirs(ctx.store),
      queued: h.stats.extraction_queue,
    });
    return { deps: [{ kind: 'set', id: 'holdings', sha: sha16(text) }], inputsSha: sha16(['overview_holdings@1', text]), data: { text } };
  },
  async render(_ctx, _pagePath, plan) {
    return { frontmatter: {}, regions: { holdings: plan.data.text as string } };
  },
};
