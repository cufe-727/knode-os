import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { CONCEPT_FREQUENT_FILE, writeFrequentTerms } from '../src/graph/concept-stoplist.js';
import { invalidateTier0Known } from '../src/graph/concepts.js';
import { applyMerge } from '../src/graph/merge.js';
import { DocumentMentions } from '../src/graph/mentions.js';
import { EntityDetail } from '../src/graph/query.js';
import { sync } from '../src/ingest/sync.js';
import { createApp } from '../src/server/app.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';

/**
 * What a Markdown view marks and opens: POST /api/entities/mentions finds the
 * known entities a text names, GET /api/entities/detail answers the panel a
 * marked name opens.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-entity-mentions-'));
const root = path.join(tmp, 'data');

const headers = {
  'x-knode-user': 'admin',
  'x-knode-workspace-kind': 'personal',
  'x-knode-workspace-id': 'default',
  'x-knode-workspace-name': 'Default',
  'content-type': 'application/json',
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

const idOf = async (name: string): Promise<string> => {
  const [row] = await ws.store.query<{ id: string }>(`SELECT id FROM entities WHERE name = $1 AND tx_to IS NULL`, [name]);
  expect(row, `entity ${name}`).toBeTruthy();
  return row.id;
};

const mentions = async (text: string, file?: string): Promise<DocumentMentions> => {
  const res = await app.request('/api/entities/mentions', { method: 'POST', headers, body: JSON.stringify({ text, path: file }) });
  expect(res.status).toBe(200);
  return (await res.json()) as DocumentMentions;
};

const detail = async (id: string): Promise<EntityDetail> => {
  const res = await app.request(`/api/entities/detail?id=${encodeURIComponent(id)}`, { headers });
  expect(res.status).toBe(200);
  return (await res.json()) as EntityDetail;
};

beforeAll(async () => {
  rootCtx = await createContext(root);
  registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
  app = createApp(rootCtx, () => {}, registry);
  await app.request('/api/workspaces', { headers: { 'x-knode-user': 'admin' } });
  ws = await registry.get(scope);

  write(ws.dataDir, 'raw/docs/seed.md', `---
title: seed
entities:
  - { name: "宁德时代", type: organization, aliases: ["CATL"] }
  - { name: "比亚迪", type: organization, aliases: ["BYD"] }
  - { name: "比亚迪汽车", type: product }
  - { name: "曾毓群", type: person }
  - { name: "Apple", type: organization }
  - { name: "宁王", type: organization }
  - { name: "2020", type: product }
  - { name: "TI", type: organization }
  - { name: "沪深指数", type: dataset }
relations:
  - { source: "宁德时代", target: "比亚迪", type: supplies_to }
  - { source: "比亚迪", target: "宁德时代", type: invested_in }
  - { source: "Apple", target: "宁德时代", type: owns }
---
宁德时代、比亚迪和曾毓群出现在同一段里，Apple 也在。
`);
  write(ws.dataDir, 'raw/docs/notes.md', `# 笔记\n\n[[动力电池]] 行业里，宁德时代与比亚迪都很强。固态电解质是新方向，固态电解质的成本在降，固态电解质值得跟踪。\n`);
  await sync(ws, { llmGraph: false });
  // one entity folded into another: either id opens the survivor
  await applyMerge(ws.store, { entityId: await idOf('宁王'), canonicalId: await idOf('宁德时代'), actor: 'test', log: false });
  invalidateTier0Known(ws.dataDir);
});

afterAll(async () => {
  await registry.closeAll();
  await rootCtx.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('POST /api/entities/mentions', () => {
  it('names each known entity once, in the order the text first names it, with the spellings it uses', async () => {
    const { mentions: found } = await mentions('CATL 给比亚迪汽车供货。宁德时代的曾毓群说，这和 Pineapple 无关，和 Apple 有关。宁德时代又说了一次。');
    expect(found.map((m) => m.name)).toEqual(['宁德时代', '比亚迪汽车', '曾毓群', 'Apple']);
    const catl = found[0];
    expect(catl).toMatchObject({ type: 'organization', count: 3, wikiPath: null });
    // longest spelling first, as the views match them
    expect([...catl.surfaces].sort()).toEqual(['CATL', '宁德时代']);
    for (let i = 1; i < catl.surfaces.length; i++) expect(catl.surfaces[i - 1].length).toBeGreaterThanOrEqual(catl.surfaces[i].length);
    // the longer name wins where two overlap: 比亚迪汽车 is not also 比亚迪
    expect(found.map((m) => m.name)).not.toContain('比亚迪');
    // Latin names match whole words only: Pineapple is not Apple
    expect(found.find((m) => m.name === 'Apple')?.count).toBe(1);
  });

  it('leaves the frontmatter out: the views fold it away', async () => {
    const { mentions: found } = await mentions('---\ntitle: 比亚迪\nentities: [比亚迪, 宁德时代]\n---\n正文只提到曾毓群。\n');
    expect(found.map((m) => m.name)).toEqual(['曾毓群']);
  });

  it('adds what the file was indexed with, whatever its type, and drops the entity the page belongs to', async () => {
    const text = fs.readFileSync(path.join(ws.dataDir, 'raw/docs/notes.md'), 'utf8');
    const [concept] = await ws.store.query<{ type: string }>(`SELECT type FROM entities WHERE name = '动力电池' AND tx_to IS NULL`);
    // a wikilinked concept is not in the typed link index, so text alone does not find it
    expect((await mentions(text)).mentions.map((m) => m.name)).not.toContain('动力电池');
    const withPath = await mentions(text, 'raw/docs/notes.md');
    expect(withPath.mentions.find((m) => m.name === '动力电池')).toMatchObject({ type: concept.type, surfaces: ['动力电池'] });
    // a term only the concept miner took from the file is an ordinary word as often as a name: not marked
    const mined = await ws.store.query<{ name: string }>(
      `SELECT DISTINCT e.name FROM evidence ev JOIN scopes s ON s.id = ev.scope_id JOIN entities e ON e.id = ev.target_id
       WHERE s.key = 'raw/docs/notes.md' AND ev.kind = 'entity' AND ev.tx_to IS NULL
       GROUP BY e.name HAVING bool_and(ev.extractor = 'tier0.concept')`,
    );
    expect(mined.length).toBeGreaterThan(0);
    for (const { name: term } of mined) expect(withPath.mentions.map((m) => m.name)).not.toContain(term);

    // a page bound to an entity does not mark its own subject
    await ws.store.query(`UPDATE entities SET wiki_path = 'raw/docs/notes.md' WHERE id = $1`, [await idOf('宁德时代')]);
    try {
      const own = await mentions(text, 'raw/docs/notes.md');
      expect(own.mentions.map((m) => m.name)).not.toContain('宁德时代');
      expect(own.mentions.map((m) => m.name)).toContain('比亚迪');
      // elsewhere it is marked, and says where its page is
      expect((await mentions('宁德时代')).mentions[0]).toMatchObject({ name: '宁德时代', wikiPath: 'raw/docs/notes.md' });
    } finally {
      await ws.store.query(`UPDATE entities SET wiki_path = NULL WHERE id = $1`, [await idOf('宁德时代')]);
    }
  });

  it('does not mark numbers, scraps of Latin, or kinds of entity a reader does not look up', async () => {
    for (const name of ['2020', 'TI', '沪深指数']) expect(await idOf(name)).toBeTruthy();
    const { mentions: found } = await mentions('2020 年 TI 的报告引用了沪深指数，曾毓群也在。');
    expect(found.map((m) => m.name)).toEqual(['曾毓群']);
    // the file that declares them marks them: its author named them
    const declared = await mentions('2020 年 TI 的报告引用了沪深指数。', 'raw/docs/seed.md');
    expect(declared.mentions.map((m) => m.name).sort()).toEqual(['2020', 'TI', '沪深指数'].sort());
  });

  it("leaves the corpus's frequent names unmarked unless the entity has a page", async () => {
    writeFrequentTerms(ws.dataDir, { docs: 100, threshold: 2, at: new Date().toISOString(), terms: [{ term: '宁德时代', docs: 60 }, { term: '比亚迪', docs: 50 }] });
    invalidateTier0Known(ws.dataDir);
    try {
      expect((await mentions('宁德时代与比亚迪都很强，曾毓群说。')).mentions.map((m) => m.name)).toEqual(['曾毓群']);
      await ws.store.query(`UPDATE entities SET wiki_path = 'wiki/entities/宁德时代.md' WHERE id = $1`, [await idOf('宁德时代')]);
      expect((await mentions('宁德时代与比亚迪都很强。')).mentions.map((m) => m.name)).toEqual(['宁德时代']);
    } finally {
      fs.rmSync(path.join(ws.dataDir, CONCEPT_FREQUENT_FILE), { force: true });
      invalidateTier0Known(ws.dataDir);
      await ws.store.query(`UPDATE entities SET wiki_path = NULL WHERE id = $1`, [await idOf('宁德时代')]);
    }
  });

  it('answers nothing for empty text and refuses a body without text', async () => {
    expect((await mentions('   ')).mentions).toEqual([]);
    const res = await app.request('/api/entities/mentions', { method: 'POST', headers, body: JSON.stringify({ path: 'raw/docs/seed.md' }) });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/entities/detail', () => {
  it('folds the typed relations per neighbour, each with its direction, strongest first', async () => {
    const d = await detail(await idOf('宁德时代'));
    expect(d.entity).toMatchObject({ name: '宁德时代', type: 'organization', aliases: expect.arrayContaining(['CATL']) });
    expect(d.entity.degree).toBeGreaterThanOrEqual(3);
    expect(d.entity.documentCount).toBeGreaterThanOrEqual(1);
    const byd = d.relations.find((g) => g.other.name === '比亚迪');
    expect(byd?.relations.map((r) => `${r.type}:${r.direction}`).sort()).toEqual(['invested_in:in', 'supplies_to:out']);
    const apple = d.relations.find((g) => g.other.name === 'Apple');
    expect(apple?.relations).toEqual([expect.objectContaining({ type: 'owns', direction: 'in' })]);
    for (let i = 1; i < d.relations.length; i++) expect(d.relations[i - 1].weight).toBeGreaterThanOrEqual(d.relations[i].weight);
    expect(d.moreRelations).toBe(0);
    expect(d.documents.map((doc) => doc.path)).toContain('raw/docs/seed.md');
  });

  it('lists who its documents mention alongside it, apart from its typed neighbours', async () => {
    const d = await detail(await idOf('宁德时代'));
    const co = d.cooccurring.map((x) => x.name);
    expect(co).toContain('曾毓群');
    for (const g of d.relations) expect(co).not.toContain(g.other.name);
  });

  it('opens a merged entity as its survivor', async () => {
    const [merged] = await ws.store.query<{ id: string }>(`SELECT id FROM entities WHERE name = '宁王'`);
    expect((await detail(merged.id)).entity.name).toBe('宁德时代');
  });

  it('answers 404 for an id with no live entity and 400 without one', async () => {
    expect((await app.request('/api/entities/detail?id=nope', { headers })).status).toBe(404);
    expect((await app.request('/api/entities/detail', { headers })).status).toBe(400);
  });
});
