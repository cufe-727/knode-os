import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { citationKeys, pageCitations, rawDocTarget, rawDocValue, relationCitation } from '../src/graph/citations.js';
import { frontmatterExtraction } from '../src/graph/frontmatter.js';
import { loadOntology, normalizePredicate, promptFragment } from '../src/graph/ontology.js';
import { extractObsidianLinks } from '../src/graph/wire.js';
import { sync } from '../src/ingest/sync.js';
import { citedBy, CitingPage, citesOf } from '../src/lineage/citations.js';
import { lineageOf } from '../src/lineage/inspect.js';
import { setScopeTrust } from '../src/lineage/trust.js';
import { createApp } from '../src/server/app.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';
import { lintWiki } from '../src/wiki/lint.js';

/**
 * A wiki page citing raw/docs files (src/graph/citations.ts): every way of
 * writing it becomes a citation of the file instead of an entity named after
 * the file; the file lists the pages citing it (GET /api/file/citations,
 * lineage); citations follow the page through edits and removal, `as_of`
 * included; a page indexed before citations existed is read once more.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-citations-'));
const root = path.join(tmp, 'data');

const headers = {
  'x-knode-user': 'admin',
  'x-knode-workspace-kind': 'personal',
  'x-knode-workspace-id': 'default',
  'x-knode-workspace-name': 'Default',
};
const scope = { user: 'admin', kind: 'personal' as const, id: 'default', name: 'Default', slug: 'default', relativeDir: 'users/admin/workspaces/default' };

let rootCtx: AppContext;
let registry: WorkspaceContextRegistry;
let app: ReturnType<typeof createApp>;
let ws: AppContext;

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const D1 = 'raw/docs/papers/d1.md';
const D2 = 'raw/docs/backtests/K1/2026-10-27.md';

const K1 = [
  '---',
  'type: concept',
  'title: K1',
  'sources:',
  `  - ${D1}`,
  'relations:',
  `  tested_by: [${D2}]`,
  '  derived_from: ["[[K0]]"]',
  '---',
  '# K1 动量轮动',
  '',
  'Derived from [[raw/docs/papers/d1]], see [the appendix](../../raw/docs/papers/d1-appendix.md#e-4171ba2c).',
  '',
  '| claim | source |',
  '| --- | --- |',
  '| momentum | [[raw/docs/papers/d1-table\\|table]] |',
  '',
  'Written as code, `[[raw/docs/not-a-link]]` is an example.',
  '',
  '```md',
  '[[raw/docs/also-not-a-link]]',
  '```',
  '',
].join('\n');

const byPath = (pages: CitingPage[]) => new Map(pages.map((p) => [p.path, p]));

beforeAll(async () => {
  rootCtx = await createContext(root);
  registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
  app = createApp(rootCtx, () => {}, registry);
  await app.request('/api/workspaces', { headers: { 'x-knode-user': 'admin' } });
  ws = await registry.get(scope);

  write(ws.dataDir, D1, '# d1 动量论文\n\n过去 12 个月涨得多的股票，之后 3 个月继续跑赢。\n');
  write(ws.dataDir, 'raw/docs/papers/d1-table.md', '# d1 表\n\n回测用的表格。\n');
  write(ws.dataDir, D2, '# K1 回测 2026-10\n\n对 [[K1]] 的回测：年化 12%，最大回撤 25%。数据见 [[raw/docs/papers/d1]]。\n');
  write(ws.dataDir, 'wiki/concepts/K0.md', '---\ntitle: K0\n---\n# K0\n\nThe idea K1 builds on: buy what went up recently.\n');
  write(ws.dataDir, 'wiki/concepts/K1.md', K1);
  // an inverse spelling (K3 is the basis of d1), and a relation between another entity and a file
  write(ws.dataDir, 'wiki/concepts/K3.md', [
    '---',
    'title: K3',
    'relations:',
    `  - { target: ${D1}, type: basis_of }`,
    `  - { source: 宁德时代, target: ${D1}, type: tested_by }`,
    '---',
    '# K3',
    '',
    'An idea the paper later took up.',
    '',
  ].join('\n'));
  // a hub page has no entity of its own; it still cites
  write(ws.dataDir, 'wiki/hub.md', `---\ntitle: Hub\nselfEntity: false\nrelations:\n  cites: [${D1}]\n---\n# Hub\n\nWhere to start reading.\n`);
  write(ws.dataDir, 'wiki/concepts/agent-page.md', `---\ntitle: Agent page\nactor: agent/claude-code\nsources:\n  - ${D1}\n---\n# Agent page\n\nWritten by an agent from the paper.\n`);
  write(ws.dataDir, 'wiki/concepts/index.md', `# Concepts\n\nThe paper is ${D1}.\n`);
  write(ws.dataDir, 'wiki/generated.md', '---\ntitle: Generated\ngenerated: { by: "knode-os/test", at: "2026-10-01T00:00:00Z" }\n---\n# Generated\n\nSummary of [[raw/docs/papers/d1]].\n');
  await sync(ws, { llmGraph: false });
});

afterAll(async () => {
  await registry.closeAll();
  await rootCtx.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('what names a raw/docs file', () => {
  it('reads link targets lexically, as the app opens them', () => {
    expect(rawDocTarget('wiki/concepts/K1.md', 'raw/docs/papers/d1')).toEqual({ path: 'raw/docs/papers/d1', fragment: null });
    expect(rawDocTarget('wiki/concepts/K1.md', '/raw/docs/papers/d1.md#e-1')).toEqual({ path: D1, fragment: 'e-1' });
    expect(rawDocTarget('wiki/concepts/K1.md', 'raw/docs/papers/d1\\|table')).toEqual({ path: 'raw/docs/papers/d1', fragment: null });
    expect(rawDocTarget('wiki/concepts/K1.md', 'raw\\docs\\papers\\d1.md')).toEqual({ path: D1, fragment: null });
    expect(rawDocTarget('wiki/concepts/K1.md', '../../raw/docs/papers/d%201.md?x=1#e-2', { markdown: true }))
      .toEqual({ path: 'raw/docs/papers/d 1.md', fragment: 'e-2' });
    // Obsidian never reads a wikilink relative to the page
    expect(rawDocTarget('wiki/concepts/K1.md', '../../raw/docs/papers/d1')).toBeNull();
    for (const t of ['raw/docs/../../etc/passwd', 'raw/docs/', 'raw/skills/x.md', 'https://example.com/raw/docs/x.md', 'K1', '']) {
      expect(rawDocTarget('wiki/a.md', t, { markdown: true })).toBeNull();
    }
    expect(rawDocValue('wiki/a.md', '[[raw/docs/x#^b|label]]')).toEqual({ path: 'raw/docs/x', fragment: '^b' });
    expect(citationKeys('raw/docs/Papers/D1.md')).toEqual(['raw/docs/papers/d1.md', 'raw/docs/papers/d1']);
  });

  it('drops the escaping backslash of a table cell from a wikilink', () => {
    expect(extractObsidianLinks('| [[K1\\|策略]] |')).toEqual([{ target: 'K1', label: '策略', embed: false }]);
  });

  it('finds links in the body and frontmatter, not in code, and lets a specific predicate win', () => {
    const found = pageCitations('wiki/k.md', {
      sources: ['raw/docs/a.md', { resource: 'raw/docs/b.md' }, 'https://example.com/c'],
      related: '[[raw/docs/c]]',
    }, 'See [[raw/docs/d]] and [[raw/docs/a]], `[[raw/docs/e]]`.\n\n```\n[[raw/docs/f]]\n```\n', { frontmatter: true });
    expect(found.map((c) => `${c.via}:${c.type}:${c.path}`)).toEqual([
      'wikilink:cites:raw/docs/d',
      'wikilink:cites:raw/docs/a',
      'wikilink:cites:raw/docs/c',
      'sources:derived_from:raw/docs/a.md',
      'sources:derived_from:raw/docs/b.md',
    ]);
  });

  it('turns a relation between the page and a file into a citation and mints no entity for the file', () => {
    const declared = frontmatterExtraction({
      relations: [
        { target: 'raw/docs/bt.md', type: 'tested_by' },
        { source: 'raw/docs/p.md', target: 'K1', type: 'basis_of' },
        { source: '宁德时代', target: 'raw/docs/x.md', type: 'tested_by' },
        { source: 'raw/docs/a.md', target: 'raw/docs/b.md', type: 'cites' },
        { target: '[[K0]]', type: 'derived_from' },
      ],
    }, { defaultSource: 'K1', citationTarget: (v) => rawDocValue('wiki/K1.md', v) });
    expect(declared!.citations).toEqual([
      { path: 'raw/docs/bt.md', fragment: null, type: 'tested_by', fileIsSource: false },
      { path: 'raw/docs/p.md', fragment: null, type: 'basis_of', fileIsSource: true },
    ]);
    expect(declared!.relations.map((r) => `${r.source} ${r.type} ${r.target}`)).toEqual(['K1 derived_from K0']);
    expect(declared!.entities.map((e) => e.name)).toEqual(['K1', 'K0']);

    const ont = loadOntology(path.join(tmp, 'no-packs'));
    // "p is the basis of K1" is "K1 derived from p": the page's own reading
    expect(relationCitation(ont, declared!.citations[1])).toMatchObject({ type: 'derived_from', inverse: false });
    expect(relationCitation(ont, { path: 'raw/docs/p.md', fragment: null, type: 'tests', fileIsSource: false })).toMatchObject({ type: 'tested_by', inverse: true });
  });

  it('has the document predicates in every workspace, out of the extraction prompt and in the research brief', () => {
    const ont = loadOntology(path.join(tmp, 'no-packs'));
    expect(normalizePredicate(ont, 'tests')).toEqual({ type: 'tested_by', flip: true });
    expect(normalizePredicate(ont, '回测')).toEqual({ type: 'tested_by', flip: true });
    expect(normalizePredicate(ont, 'based_on')).toEqual({ type: 'derived_from', flip: false });
    expect(promptFragment(ont).relationTypes).not.toMatch(/derived_from|tested_by|cites/);
    expect(promptFragment(ont, { documentLinks: true }).relationTypes).toMatch(/- tested_by: .*inverse: tests/);
    // the workspace's own core.yaml was written before them and is never rewritten
    const own = loadOntology(ws.dataDir);
    expect(fs.readFileSync(path.join(ws.dataDir, 'playbooks/ontology/core.yaml'), 'utf8')).not.toContain('derived_from');
    expect(own.relationTypes.map((r) => r.id)).toEqual(expect.arrayContaining(['cites', 'derived_from', 'tested_by']));
  });
});

describe('citations of raw/docs files', () => {
  it('lists the pages citing a file, each with how it cites it and its tier', async () => {
    const pages = byPath(await citedBy(ws.store, D1));
    expect([...pages.keys()].sort()).toEqual(['wiki/concepts/K1.md', 'wiki/concepts/K3.md', 'wiki/concepts/agent-page.md', 'wiki/hub.md']);
    // the body's [[raw/docs/papers/d1]] is the same file as the sources entry: derived_from says more
    expect(pages.get('wiki/concepts/K1.md')).toEqual({
      path: 'wiki/concepts/K1.md',
      title: 'K1',
      trust: 'trusted',
      links: [{ type: 'derived_from', inverse: false, label: 'derived_from', via: 'sources', fragment: null }],
    });
    expect(pages.get('wiki/concepts/K3.md')!.links).toEqual([{ type: 'derived_from', inverse: true, label: 'basis_of', via: 'relations', fragment: null }]);
    expect(pages.get('wiki/hub.md')!.links).toEqual([expect.objectContaining({ type: 'cites', via: 'relations' })]);
    expect(pages.get('wiki/concepts/agent-page.md')).toMatchObject({ trust: 'quarantined', links: [expect.objectContaining({ type: 'derived_from' })] });

    expect(await citedBy(ws.store, D2)).toEqual([expect.objectContaining({
      path: 'wiki/concepts/K1.md',
      links: [{ type: 'tested_by', inverse: false, label: 'tested_by', via: 'relations', fragment: null }],
    })]);
    // written without .md, inside a table cell
    expect((await citedBy(ws.store, 'raw/docs/papers/d1-table.md'))[0]?.links).toEqual([expect.objectContaining({ type: 'cites', via: 'wikilink' })]);
    // a file that is not there yet is cited all the same
    expect((await citedBy(ws.store, 'raw/docs/papers/d1-appendix.md'))[0]?.links)
      .toEqual([expect.objectContaining({ type: 'cites', via: 'markdown', fragment: 'e-4171ba2c' })]);

    const targets = (await ws.store.query<{ target_path: string }>(`SELECT DISTINCT target_path FROM citations WHERE tx_to IS NULL`)).map((r) => r.target_path);
    // links in code, a raw document's own link, a generated page's text and a reserved file cite nothing
    expect(targets.sort()).toEqual([D2, 'raw/docs/papers/d1-appendix.md', D1, 'raw/docs/papers/d1-table'].sort());
    const writers = (await ws.store.query<{ source_path: string }>(`SELECT DISTINCT source_path FROM citations WHERE tx_to IS NULL`)).map((r) => r.source_path);
    expect(writers).not.toEqual(expect.arrayContaining([D2]));
    expect(writers).not.toContain('wiki/generated.md');
    expect(writers).not.toContain('wiki/concepts/index.md');
  });

  it('mints no entity for a file, keeps relations between entities typed, and keeps raw → wiki mentions', async () => {
    const junk = await ws.store.query<{ name: string }>(
      `SELECT name FROM entities WHERE tx_to IS NULL AND (name ILIKE '%raw/docs%' OR lower(name) IN ('d1', 'd1-table', 'd1-appendix.md', '2026-10-27', '宁德时代'))`,
    );
    expect(junk).toEqual([]);
    const edges = await ws.store.query<{ type: string }>(
      `SELECT r.type FROM relations r JOIN entities s ON s.id = r.source_id JOIN entities t ON t.id = r.target_id
       WHERE s.name = 'K1' AND t.name = 'K0' AND r.tx_to IS NULL`,
    );
    expect(edges.map((e) => e.type)).toContain('derived_from');
    const mentioned = await ws.store.query<{ path: string }>(
      `SELECT DISTINCT d.path FROM entity_mentions m JOIN entities e ON e.id = m.entity_id JOIN documents d ON d.id = m.document_id WHERE e.name = 'K1'`,
    );
    expect(mentioned.map((m) => m.path)).toContain(D2);
  });

  it('answers GET /api/file/citations and document lineage', async () => {
    const res = await app.request(`/api/file/citations?path=${encodeURIComponent(D1)}`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; citedBy: CitingPage[] };
    expect(body.path).toBe(D1);
    expect(body.citedBy.map((p) => p.path).sort()).toEqual(['wiki/concepts/K1.md', 'wiki/concepts/K3.md', 'wiki/concepts/agent-page.md', 'wiki/hub.md']);
    expect((await app.request('/api/file/citations', { headers })).status).toBe(400);

    expect((await lineageOf(ws.store, 'document', D1)).citedBy).toHaveLength(4);
    const cites = (await lineageOf(ws.store, 'document', 'wiki/concepts/K1.md')).cites ?? [];
    expect(cites.map((c) => `${c.type} ${c.target}`).sort()).toEqual([
      `derived_from ${D1}`,
      `tested_by ${D2}`,
      'cites raw/docs/papers/d1-appendix.md',
      'cites raw/docs/papers/d1-table',
    ].sort());
  });

  it('reports citations of missing files in lint and no longer calls raw links broken', async () => {
    const report = await lintWiki(ws, { report: false, file: false });
    const broken = report.issues.filter((i) => i.kind === 'broken_link').map((i) => `${i.path}: ${i.detail}`);
    expect(broken).toContain('wiki/concepts/K1.md: Markdown link to raw/docs/papers/d1-appendix.md names no file');
    expect(broken.filter((b) => b.includes('raw/docs/papers/d1]]') || b.includes('d1-table'))).toEqual([]);
  });

  it('reads a page indexed before citations existed once more, keeping a promoted tier, and skips views and reserved files', async () => {
    const scopeOf = async (key: string) => (await ws.store.query<{ id: string; trust: string; meta: Record<string, unknown> }>(
      `SELECT id, trust, meta FROM scopes WHERE kind = 'doc' AND key = $1 AND status <> 'disposed'`,
      [key],
    ))[0];
    const page = 'wiki/concepts/agent-page.md';
    await setScopeTrust(ws.store, { key: page, to: 'trusted' });
    // as they were before v16: no stamp, no rows
    for (const key of [page, 'wiki/generated.md', 'wiki/concepts/index.md']) {
      await ws.store.query(`UPDATE scopes SET meta = meta - 'citations' WHERE kind = 'doc' AND key = $1 AND status <> 'disposed'`, [key]);
    }
    await ws.store.query(`DELETE FROM citations WHERE source_path = $1`, [page]);
    const before = { page: await scopeOf(page), view: await scopeOf('wiki/generated.md'), index: await scopeOf('wiki/concepts/index.md') };

    await sync(ws, { llmGraph: false });
    const after = { page: await scopeOf(page), view: await scopeOf('wiki/generated.md'), index: await scopeOf('wiki/concepts/index.md') };
    expect(after.page.id).not.toBe(before.page.id);
    expect(after.page.meta.citations).toBe(1);
    expect(after.page.trust).toBe('trusted');
    expect(after.view.id).toBe(before.view.id);
    expect(after.index.id).toBe(before.index.id);
    expect(byPath(await citedBy(ws.store, D1)).get(page)).toMatchObject({ trust: 'trusted', links: [expect.objectContaining({ type: 'derived_from', via: 'sources' })] });

    await sync(ws, { llmGraph: false });
    expect((await scopeOf(page)).id).toBe(after.page.id);
  });

  it('follows the page: an edit replaces its citations, as_of still sees the old ones, removal retires them', async () => {
    const before = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 20));
    write(ws.dataDir, 'wiki/concepts/K1.md', K1.replace(`sources:\n  - ${D1}\n`, ''));
    await sync(ws, { llmGraph: false });

    // without the sources entry, the body's link is what remains
    expect(byPath(await citedBy(ws.store, D1)).get('wiki/concepts/K1.md')!.links).toEqual([
      { type: 'cites', inverse: false, label: 'cites', via: 'wikilink', fragment: null },
    ]);
    expect(byPath(await citedBy(ws.store, D1, { asOf: before })).get('wiki/concepts/K1.md')!.links).toEqual([
      expect.objectContaining({ type: 'derived_from', via: 'sources' }),
    ]);

    fs.rmSync(path.join(ws.dataDir, 'wiki/concepts/K1.md'));
    await sync(ws, { llmGraph: false });
    expect(await citedBy(ws.store, D2)).toEqual([]);
    expect(await citesOf(ws.store, 'wiki/concepts/K1.md')).toEqual([]);
    expect(await citedBy(ws.store, D2, { asOf: before })).toHaveLength(1);
  });
});
