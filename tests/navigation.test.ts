import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { isSeedTemplate } from '../src/fs/datadir.js';
import { sync } from '../src/ingest/sync.js';
import { extractMarkdownLinks, resolveOkfLink } from '../src/okf/index.js';
import { surveyKnowledgeBase } from '../src/research/survey.js';
import { listNotices } from '../src/server/notices.js';
import { HUB_GROUPS, HUB_LINKS, layoutTree, relLink, renderHub, SHELF_ROWS, ShelfRow, sourcesTree } from '../src/wiki/nav-views.js';
import { ensureNavigation, refreshNavigationIfChanged } from '../src/wiki/navigation.js';
import { ensureSourcesIndex } from '../src/wiki/pages.js';

/**
 * The wiki's navigation (src/wiki/nav-views.ts, navigation.ts): indexes paged
 * so that every page is three links from wiki/index.md and no index file
 * holds more than SHELF_ROWS rows, the contents of index.md, and the
 * overview's generated holdings, which must not make a workspace nobody
 * initialized look initialized.
 */

const rowsOf = (groups: Record<string, number>): ShelfRow[] =>
  Object.entries(groups).flatMap(([group, n]) =>
    Array.from({ length: n }, (_, i) => ({ group, target: `wiki/sources/${group.replace(/\W/g, '-')}-${i}.md`, label: `${group} ${i}`, tail: '', when: '2026-01-01' })));

describe('the layout of a paged index', () => {
  it('lists a small tree inline and pages a large one, every row on exactly one page of at most SHELF_ROWS', () => {
    expect(layoutTree(sourcesTree, rowsOf({ 'raw/docs/a': 120, 'raw/docs': 80 })).inline).toBe(true);

    const rows = rowsOf({ 'raw/docs/a': 450, 'raw/docs/b': 30, 'raw/docs': 1 });
    const layout = layoutTree(sourcesTree, rows);
    expect(layout.inline).toBe(false);
    expect(layout.direct).toBe(true);
    expect([...layout.shelves.keys()].sort()).toEqual([
      'wiki/sources/by-folder/_top/index.md',
      'wiki/sources/by-folder/a/1/index.md',
      'wiki/sources/by-folder/a/2/index.md',
      'wiki/sources/by-folder/a/3/index.md',
      'wiki/sources/by-folder/a/index.md',
      'wiki/sources/by-folder/b/index.md',
    ]);
    const listed = [...layout.shelves.values()].flatMap((s) => s.rows.map((r) => r.target));
    expect(listed.sort()).toEqual(rows.map((r) => r.target).sort());
    for (const s of layout.shelves.values()) expect(s.rows.length).toBeLessThanOrEqual(SHELF_ROWS);
    // the hub links every page of the list itself: index.md → hub → page → document's page
    const hub = renderHub(sourcesTree, layout, rows);
    for (const n of [1, 2, 3]) expect(hub).toContain(`(by-folder/a/${n}/index.md)`);
  });

  it('gives the smallest folders past HUB_GROUPS one shared list, and links only folder lists past HUB_LINKS pages', () => {
    const many = Object.fromEntries(Array.from({ length: HUB_GROUPS + 20 }, (_, i) => [`raw/docs/f${String(i).padStart(3, '0')}`, i < 10 ? 300 : 2]));
    const layout = layoutTree(sourcesTree, rowsOf(many));
    expect(layout.groups).toHaveLength(HUB_GROUPS);
    expect(layout.groups.at(-1)!.group).toBe('_other');
    expect(layout.groups.at(-1)!.rows).toHaveLength(21 * 2);

    const huge = layoutTree(sourcesTree, rowsOf({ 'raw/docs/a': SHELF_ROWS * (HUB_LINKS + 1) }));
    expect(huge.direct).toBe(false);
    expect(renderHub(sourcesTree, huge, [])).not.toContain('/1/index.md');
  });

  it('writes links a Markdown reader can follow', () => {
    expect(relLink('wiki/sources/by-folder/a b/1/index.md', 'wiki/sources/x (1).md')).toBe('../../../x%20%281%29.md');
    expect(resolveOkfLink('sources/by-folder/a b/1/index.md', '../../../x%20%281%29.md')).toBe('sources/x (1).md');
    expect(relLink('wiki/index.md', 'wiki/entities/中文.md')).toBe('entities/中文.md');
  });
});

describe('the navigation of a workspace', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-navigation-'));
  const dataDir = path.join(tmp, 'ws');
  let ctx: AppContext;
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dataDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dataDir, rel), content);
  };
  const read = (rel: string) => fs.readFileSync(path.join(dataDir, rel), 'utf8');
  const exists = (rel: string) => fs.existsSync(path.join(dataDir, rel));
  const NOTES = SHELF_ROWS + 30;

  beforeAll(async () => {
    for (let i = 0; i < NOTES; i++) write(`raw/docs/notes/n${String(i).padStart(3, '0')}.md`, `# Note ${i}\n\nA short note about harbour ${i}.\n`);
    write('raw/docs/readme.md', '# Read me\n\nWhat this is.\n');
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });
  }, 180_000);
  afterAll(async () => {
    await ctx?.store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Pages reachable from wiki/index.md by Markdown links, with the steps each took. */
  const reach = () => {
    const depth = new Map<string, number>([['index.md', 0]]);
    let frontier = ['index.md'];
    while (frontier.length) {
      const next: string[] = [];
      for (const f of frontier) {
        const abs = path.join(dataDir, 'wiki', f);
        if (!fs.existsSync(abs)) continue;
        for (const l of extractMarkdownLinks(fs.readFileSync(abs, 'utf8'))) {
          const t = resolveOkfLink(f, l.href);
          if (t && !depth.has(t) && fs.existsSync(path.join(dataDir, 'wiki', t))) {
            depth.set(t, depth.get(f)! + 1);
            next.push(t);
          }
        }
      }
      frontier = next;
    }
    return depth;
  };

  it('pages the sources index by folder and reaches every page within three links', async () => {
    const stats = await ensureNavigation(ctx);
    expect(stats.written).toContain('wiki/sources/by-folder/notes/1/index.md');
    const hub = read('wiki/sources/index.md');
    expect(hub).toContain('# Sources'); // the seeded prose around the region stays
    expect(hub).toContain(`${NOTES + 1} indexed documents in 2 folders`);
    expect(hub).toMatch(/\*\*\[raw\/docs\/notes\]\(by-folder\/notes\/index\.md\)\*\* — 230 documents.*\[[^\]]+\]\(by-folder\/notes\/2\/index\.md\) · \[[^\]]+\]\(by-folder\/notes\/1\/index\.md\)/);
    const first = read('wiki/sources/by-folder/notes/1/index.md');
    expect(first.split('\n').filter((l) => l.startsWith('* '))).toHaveLength(SHELF_ROWS);
    expect(first).toContain('↑ [raw/docs/notes](../index.md) · page 1 of 2');
    // the documents, each once; read me sits in the top folder's list
    const listed = [1, 2].flatMap((n) => read(`wiki/sources/by-folder/notes/${n}/index.md`).match(/`raw\/docs\/notes\/n\d+\.md`/g) ?? []);
    expect(new Set(listed).size).toBe(NOTES);
    expect(listed).toHaveLength(NOTES);
    expect(read('wiki/sources/by-folder/_top/index.md')).toContain('`raw/docs/readme.md`');

    const depth = reach();
    for (const f of ['overview.md', 'sources/index.md', 'sources/by-folder/notes/1/index.md', 'sources/by-folder/notes/2/index.md', 'sources/by-folder/_top/index.md', 'datasets/index.md']) {
      expect(depth.get(f), f).toBeLessThanOrEqual(3);
    }
  });

  it('gives index.md its contents with real numbers', () => {
    const index = read('wiki/index.md');
    expect(index).toContain('* [Overview](overview.md) — what this knowledge base holds');
    expect(index).toContain(`* [Sources](sources/index.md) — ${NOTES + 1} documents in 2 folders, 0 with a summary page`);
    expect(index).toContain('* [datasets](datasets/index.md) — no pages yet');
    expect(index).toContain('* [Overview](overview.md) - Rolling global summary.'); // the seeded lines stay
  });

  it('writes what the base holds into the overview, which stays the seed until initialization writes it', async () => {
    const overview = read('wiki/overview.md');
    expect(overview).toContain('<!-- knode:begin holdings -->');
    expect(overview).toContain(`* **Documents:** ${NOTES + 1}`);
    expect(overview).toContain('[raw/docs/notes](sources/by-folder/notes/index.md) 230');
    expect(overview).toContain('* **Kinds:** md 231');
    expect(isSeedTemplate('wiki/overview.md', overview)).toBe(true);
    expect((await surveyKnowledgeBase(ctx)).wiki.overview.seeded).toBe(true);
    const notice = (await listNotices(ctx)).find((n) => n.id === 'initialize') as { overview: boolean } | undefined;
    expect(notice?.overview).toBe(false);

    // initialization writes its own overview without the region: it comes back around that prose
    write('wiki/overview.md', '---\ntype: overview\ntitle: 知识库总览\nselfEntity: false\nactor: agent/claude\n---\n# 知识库总览\n\n## 知识库是什么\n\n一个关于港口的笔记库。\n');
    await sync(ctx, { only: ['wiki/overview.md'], llmGraph: false });
    const written = read('wiki/overview.md');
    expect(written).toContain('一个关于港口的笔记库。');
    expect(written).toContain('<!-- knode:begin holdings -->');
    expect(written.indexOf('一个关于港口')).toBeLessThan(written.indexOf('knode:begin holdings'));
    expect(isSeedTemplate('wiki/overview.md', written)).toBe(false);
    expect((await surveyKnowledgeBase(ctx)).wiki.overview.seeded).toBe(false);
  });

  it('rewrites only the last page of a folder when a document arrives, and nothing when nothing changed', async () => {
    await refreshNavigationIfChanged(ctx); // the overview's sync above moved the counts
    expect((await refreshNavigationIfChanged(ctx)).skipped).toBe(true);
    const before = read('wiki/sources/by-folder/notes/1/index.md');
    write('raw/docs/notes/zz-new.md', '# A new note\n\nArrived later.\n');
    await sync(ctx, { llmGraph: false });
    const stats = await refreshNavigationIfChanged(ctx);
    expect(stats.skipped).toBeUndefined();
    expect(stats.written).toContain('wiki/sources/by-folder/notes/2/index.md');
    expect(stats.written).not.toContain('wiki/sources/by-folder/notes/1/index.md');
    expect(read('wiki/sources/by-folder/notes/1/index.md')).toBe(before);
    expect(read('wiki/sources/by-folder/notes/2/index.md')).toContain('`raw/docs/notes/zz-new.md`');
  });

  it('archives the pages a shrunk tree no longer needs and lists it inline again', async () => {
    for (let i = 0; i < 40; i++) fs.rmSync(path.join(dataDir, `raw/docs/notes/n${String(i).padStart(3, '0')}.md`));
    await sync(ctx, { llmGraph: false });
    await ensureSourcesIndex(ctx);
    // 192 documents: one list again, and the folder's pages are gone with their search projection
    expect(exists('wiki/sources/by-folder')).toBe(false);
    expect(read('wiki/sources/index.md').split('\n').filter((l) => l.startsWith('* '))).toHaveLength(NOTES - 40 + 2);
    const [{ n }] = await ctx.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM documents WHERE path LIKE 'wiki/sources/by-folder/%' AND status = 'indexed'`);
    expect(n).toBe(0);
    const [{ live }] = await ctx.store.query<{ live: number }>(`SELECT count(*)::int AS live FROM pages WHERE kind = 'sources_shelf' AND status <> 'archived'`);
    expect(live).toBe(0);
  });

  it('pages the entities index by type, the best documented first', async () => {
    await ctx.store.query(
      `INSERT INTO entities (id, name, type, wiki_path)
       SELECT 'place-' || i, 'Place ' || lpad(i::text, 3, '0'), 'location', 'wiki/entities/place-' || i || '.md' FROM generate_series(1, $1::int) i
       UNION ALL SELECT 'person-' || i, 'Person ' || i, 'person', 'wiki/entities/person-' || i || '.md' FROM generate_series(1, 3) i`,
      [SHELF_ROWS + 5],
    );
    await ensureNavigation(ctx);
    const hub = read('wiki/entities/index.md');
    expect(hub).toContain(`${SHELF_ROWS + 8} entity pages in 2 types`);
    expect(hub).toMatch(/\*\*\[location\]\(by-type\/location\/index\.md\)\*\* — 205 pages: \[201–205\]\(by-type\/location\/2\/index\.md\) · \[1–200\]\(by-type\/location\/1\/index\.md\)/);
    expect(read('wiki/entities/by-type/location/1/index.md')).toContain('* [Place 001](../../../place-1.md) (location)');
    expect(read('wiki/entities/by-type/person/index.md').split('\n').filter((l) => l.startsWith('* '))).toHaveLength(3);
    const depth = reach();
    expect(depth.get('entities/by-type/location/2/index.md')).toBeLessThanOrEqual(2);
  });
});
