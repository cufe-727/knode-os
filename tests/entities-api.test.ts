import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { applyMerge } from '../src/graph/merge.js';
import { sync } from '../src/ingest/sync.js';
import { createApp } from '../src/server/app.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';
import { EntityPage, extractorFamily } from '../src/store/entities.js';
import { listEntities } from '../src/store/queries.js';

/** Knowledge → Entities: the paged, filtered, sorted entity table behind GET /api/entities. */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-entities-api-'));
const root = path.join(tmp, 'data');

const headers = {
  'x-knode-user': 'admin',
  'x-knode-workspace-kind': 'personal',
  'x-knode-workspace-id': 'default',
  'x-knode-workspace-name': 'Default',
};
const scope = { user: 'admin', kind: 'personal' as const, id: 'default', name: 'Default', slug: 'default', relativeDir: 'users/admin/workspaces/default' };

const TYPES = ['organization', 'person', 'product'];
const name = (i: number) => `Entity ${String(i).padStart(2, '0')}`;
const alias = (i: number) => `E${String(i).padStart(2, '0')}`;

let rootCtx: AppContext;
let registry: WorkspaceContextRegistry;
let app: ReturnType<typeof createApp>;
let ws: AppContext;
let mergedId = '';

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const page = async (params: Record<string, string> = {}): Promise<EntityPage> => {
  const qs = new URLSearchParams(params).toString();
  const res = await app.request(`/api/entities${qs ? `?${qs}` : ''}`, { headers });
  expect(res.status).toBe(200);
  return (await res.json()) as EntityPage;
};

const nonIncreasing = (values: (string | number | null)[]) => {
  for (let i = 1; i < values.length; i++) expect(values[i - 1]! >= values[i]!).toBe(true);
};
const nonDecreasing = (values: (string | number | null)[]) => {
  for (let i = 1; i < values.length; i++) expect(values[i - 1]! <= values[i]!).toBe(true);
};

beforeAll(async () => {
  rootCtx = await createContext(root);
  registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
  app = createApp(rootCtx, () => {}, registry);
  await app.request('/api/workspaces', { headers: { 'x-knode-user': 'admin' } });
  ws = await registry.get(scope);

  // 39 declared entities over three types, plus one whose name holds a LIKE wildcard
  const entities = Array.from({ length: 39 }, (_, i) => `  - { name: "${name(i)}", type: ${TYPES[i % 3]}, aliases: ["${alias(i)}"] }`);
  entities.push('  - { name: "Pct 100% Fund", type: product, aliases: ["PCT"] }');
  write(ws.dataDir, 'raw/docs/seed.md', `---
title: seed
entities:
${entities.join('\n')}
relations:
  - { source: "${name(0)}", target: "${name(1)}", type: partner_of }
  - { source: "${name(0)}", target: "${name(2)}", type: supplies_to }
  - { source: "${name(3)}", target: "${name(4)}", type: rival_of }
---
[[${name(0)}]] works with [[${name(1)}]] and [[${name(2)}]] on the seed.
`);
  write(ws.dataDir, 'raw/docs/second.md', `# second\n\n[[${name(0)}]] appears again here, as do [[${name(1)}]] and [[${name(5)}]].\n`);
  await sync(ws, { llmGraph: false });

  // fold one entity into another: the table hides it unless asked
  const [into, from] = await ws.store.query<{ id: string }>(`SELECT id FROM entities WHERE name IN ($1, $2) ORDER BY name`, [name(37), name(38)]);
  await applyMerge(ws.store, { entityId: from.id, canonicalId: into.id, actor: 'test', log: false });
  mergedId = from.id;
});

afterAll(async () => {
  await registry.closeAll();
  await rootCtx.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('GET /api/entities', () => {
  it('pages the live entities, most mentioned first, with the total and the counts per type', async () => {
    const [{ n: live }] = await ws.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM entities WHERE tx_to IS NULL AND canonical_id IS NULL`);
    const p = await page();
    expect(p).toMatchObject({ total: live, offset: 0, limit: 50, sort: 'mentions', order: 'desc' });
    expect(p.items).toHaveLength(Math.min(live, 50));
    expect(p.items.map((i) => i.id)).not.toContain(mergedId);
    nonIncreasing(p.items.map((i) => i.mentions));
    expect(p.typeCounts.reduce((n, t) => n + t.n, 0)).toBe(live);
    expect(p.typeCounts.map((t) => t.type)).toEqual(expect.arrayContaining(TYPES));
  });

  it('walks pages without overlap and answers an empty page past the end', async () => {
    const first = await page({ limit: '10' });
    const second = await page({ limit: '10', offset: '10' });
    expect(first.items).toHaveLength(10);
    expect(second.items).toHaveLength(10);
    expect(second.total).toBe(first.total);
    const seen = new Set(first.items.map((i) => i.id));
    for (const i of second.items) expect(seen.has(i.id)).toBe(false);
    const past = await page({ limit: '10', offset: '10000' });
    expect(past.items).toEqual([]);
    expect(past.total).toBe(first.total);
  });

  it('filters by one type or several, keeping the counts per type whole', async () => {
    const persons = await page({ type: 'person' });
    expect(persons.total).toBeGreaterThan(0);
    for (const i of persons.items) expect(i.type).toBe('person');
    expect(persons.typeCounts.find((t) => t.type === 'person')?.n).toBe(persons.total);
    const two = await page({ type: 'person,product', limit: '500' });
    for (const i of two.items) expect(['person', 'product']).toContain(i.type);
    expect(two.total).toBe(two.typeCounts.filter((t) => t.type === 'person' || t.type === 'product').reduce((n, t) => n + t.n, 0));
  });

  it('searches names and aliases, taking % and _ literally', async () => {
    expect((await page({ q: 'e07' })).items.map((i) => i.name)).toEqual([name(7)]);
    expect((await page({ q: '100%' })).items.map((i) => i.name)).toEqual(['Pct 100% Fund']);
    expect((await page({ q: '%' })).items.map((i) => i.name)).toEqual(['Pct 100% Fund']);
    expect((await page({ q: '_' })).total).toBe(0);
  });

  it('sorts by every column, in the order asked or the one that reads best', async () => {
    const all = { limit: '500' };
    // relative positions: the concept miner adds entities of its own (a bare "Entity"), and collations differ on spaces
    const byName = await page({ sort: 'name', ...all });
    expect(byName.order).toBe('asc');
    const asc = byName.items.map((i) => i.name);
    expect(asc.indexOf(name(0))).toBeLessThan(asc.indexOf(name(1)));
    expect(asc.indexOf(name(1))).toBeLessThan(asc.indexOf('Pct 100% Fund'));
    const desc = (await page({ sort: 'name', order: 'desc', ...all })).items.map((i) => i.name);
    expect(desc.indexOf('Pct 100% Fund')).toBeLessThan(desc.indexOf(name(0)));
    nonIncreasing((await page({ sort: 'mentions', ...all })).items.map((i) => i.mentions));
    nonDecreasing((await page({ sort: 'mentions', order: 'asc', ...all })).items.map((i) => i.mentions));
    nonIncreasing((await page({ sort: 'evidence', ...all })).items.map((i) => i.evidence));
    nonDecreasing((await page({ sort: 'type', ...all })).items.map((i) => i.type));
    nonIncreasing((await page({ sort: 'updated', ...all })).items.map((i) => i.updatedAt));
    nonIncreasing((await page({ sort: 'created', ...all })).items.map((i) => i.createdAt));
  });

  it('shows merged entities only when asked, with their survivor', async () => {
    const hidden = await page({ limit: '500' });
    const shown = await page({ merged: '1', limit: '500' });
    expect(shown.total).toBe(hidden.total + 1);
    expect(hidden.items.every((i) => i.canonicalId === null)).toBe(true);
    const merged = shown.items.find((i) => i.id === mergedId);
    expect(merged?.canonicalId).toBeTruthy();
    expect(shown.typeCounts.reduce((n, t) => n + t.n, 0)).toBe(shown.total);
  });

  it('counts documents, relations and evidence sources per row from the live graph', async () => {
    const hub = (await page({ q: name(0) })).items.find((i) => i.name === name(0))!;
    const [{ n: docs }] = await ws.store.query<{ n: number }>(`SELECT count(DISTINCT document_id)::int AS n FROM entity_mentions WHERE entity_id = $1`, [hub.id]);
    const [{ n: rels }] = await ws.store.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM relations WHERE tx_to IS NULL AND type <> 'co_occurs' AND (source_id = $1 OR target_id = $1)`,
      [hub.id],
    );
    expect(docs).toBe(2);
    expect(rels).toBeGreaterThanOrEqual(2);
    expect(hub).toMatchObject({ documents: docs, relations: rels, type: 'organization', wikiPath: null, canonicalId: null });
    expect(hub.aliases).toContain(alias(0));
    expect(hub.evidence).toBeGreaterThan(0);
    expect(hub.sources.frontmatter).toBeGreaterThanOrEqual(1);
    expect(hub.sources.wikilink).toBeGreaterThanOrEqual(1);
    expect(hub.mentions).toBeGreaterThan(0);

    // declared in the frontmatter only: no relation, and only the seed mentions it
    const lonely = (await page({ q: name(30) })).items[0];
    expect(lonely.name).toBe(name(30));
    expect(lonely.relations).toBe(0);
    expect(lonely.documents).toBe(1);
    expect(lonely.sources).toEqual({ frontmatter: 1 });
  });

  it('clamps what it is given', async () => {
    expect((await page({ limit: '9999' })).limit).toBe(500);
    expect((await page({ limit: 'abc' })).limit).toBe(50);
    expect((await page({ limit: '0' })).limit).toBe(50);
    expect((await page({ offset: '-3' })).offset).toBe(0);
    const odd = await page({ sort: 'bogus', order: 'sideways' });
    expect(odd.sort).toBe('mentions');
    expect(odd.order).toBe('desc');
  });

  it('leaves the bare list the remote API answers with alone', async () => {
    const rows = await listEntities(ws.store);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows[0]).toHaveProperty('mention_count');
  });
});

describe('extractorFamily', () => {
  it('names the family of every extractor label the table shows', () => {
    expect(extractorFamily('tier0.concept')).toBe('mined');
    expect(extractorFamily('tier0.link')).toBe('link');
    expect(extractorFamily('tier0.wikilink')).toBe('wikilink');
    expect(extractorFamily('tier0.frontmatter')).toBe('frontmatter');
    expect(extractorFamily('tier1.llm:codex-cli:gpt-6.1-sol')).toBe('llm');
    expect(extractorFamily('human')).toBe('human');
    expect(extractorFamily('datasource')).toBe('datasource');
    expect(extractorFamily('probe.absence')).toBe('probe');
    expect(extractorFamily('something.new')).toBe('other');
  });
});
