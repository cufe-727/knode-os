import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { sync } from '../src/ingest/sync.js';
import { ensureEntitiesIndex, ensureEntityStubs, reconcileViews } from '../src/wiki/pages.js';

/**
 * Entity pages (src/wiki/pages.ts): everything the knowledge base holds about
 * an entity, each line with the document it comes from; written for the
 * entities several documents speak of first; listed in wiki/entities/index.md;
 * and written again when the generator that made them has changed.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-entity-pages-'));
const dataDir = path.join(tmp, 'ws');
let ctx: AppContext;

function write(rel: string, content: string): void {
  const abs = path.join(dataDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const page = (id: string) => fs.readFileSync(path.join(dataDir, 'wiki', 'entities', `${id}.md`), 'utf8');
const hasPage = (id: string) => fs.existsSync(path.join(dataDir, 'wiki', 'entities', `${id}.md`));

beforeAll(async () => {
  // Harbor Freight Lines: 40 claims in 40 weekly reports. Atlas Depot: three claims in one document.
  // Tidewater Port: named only as the other side of a claim and a relation. Quay Nine: mentioned, nothing claimed.
  for (let i = 1; i <= 40; i++) {
    const day = `2026-${String(Math.ceil(i / 4)).padStart(2, '0')}-${String(((i - 1) % 4) * 7 + 1).padStart(2, '0')}`;
    write(`raw/docs/reports/week-${String(i).padStart(2, '0')}.md`, `---
title: Week ${i}
date: ${day}
entities:
  - { name: Harbor Freight Lines, type: organization }
claims:
  - { subject: Harbor Freight Lines, type: event, statement: Harbor Freight Lines moved ${100 + i} containers in week ${i}, eventDate: "${day}" }
---
Harbor Freight Lines moved ${100 + i} containers in week ${i}.
`);
  }
  write('raw/docs/notes/atlas.md', `---
title: Atlas Depot
entities:
  - { name: Atlas Depot, type: organization }
  - { name: Harbor Freight Lines, type: organization }
  - { name: Tidewater Port, type: location }
relations:
  - { source: Atlas Depot, target: Tidewater Port, type: located_in, description: on the east quay }
claims:
  - { subject: Atlas Depot, type: other, statement: Atlas Depot has twelve loading bays }
  - { subject: Atlas Depot, type: other, statement: Atlas Depot expects a record quarter, kind: prediction }
  - { subject: Atlas Depot, object: Harbor Freight Lines, type: other, statement: Atlas Depot leases two bays to Harbor Freight Lines }
---
Atlas Depot has twelve loading bays at Tidewater Port. Quay Nine is next door. Quay Nine is busy.
`);
  ctx = await createContext(dataDir);
  await sync(ctx, { llmGraph: false });
});

afterAll(async () => {
  await ctx?.datasources.closeAll();
  await ctx?.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('entity pages', () => {
  it('are written for what the most documents speak of first', async () => {
    // as the document pass asks: of the entities it has just written, the ones a second document speaks of
    const touched = ['atlas-depot', 'harbor-freight-lines', 'tidewater-port'];
    expect(await ensureEntityStubs(ctx, { focus: touched, minClaims: null, minMentions: null })).toEqual(['wiki/entities/harbor-freight-lines.md']);
    // a full pass takes the entity with three claims next; one nothing is claimed about comes last, by its mentions
    expect(await ensureEntityStubs(ctx, { max: 1 })).toEqual(['wiki/entities/atlas-depot.md']);
    // a pass over what it has just written takes only what a second document speaks of
    expect(await ensureEntityStubs(ctx, { focus: ['tidewater-port'], minClaims: null, minMentions: null })).toEqual([]);
    expect(await ensureEntityStubs(ctx, { focus: [] })).toEqual([]);
  });

  it('list every claim with its source, the dated ones in order', async () => {
    const text = page('harbor-freight-lines');
    expect(text).toContain('_40 claims from 40 documents._');
    const timeline = text.slice(text.indexOf('## Timeline'), text.indexOf('## In claims about others'));
    const lines = timeline.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(40);
    expect(lines[0]).toBe('- 2026-01-01 · Harbor Freight Lines moved 101 containers in week 1 `fact` — raw/docs/reports/week-01.md');
    expect(lines[39]).toBe('- 2026-10-22 · Harbor Freight Lines moved 140 containers in week 40 `fact` — raw/docs/reports/week-40.md');
    // something that happened on a day is history, not a standing fact
    expect(text).not.toContain('## Facts (current)');
    // what a claim about another entity says of this one; no link while that entity has no page
    expect(text).toContain('## In claims about others');
    expect(text).toContain('- Atlas Depot: Atlas Depot leases two bays to Harbor Freight Lines `fact` — raw/docs/notes/atlas.md');
    // every line names its source: no list of them at the foot, no ids at the head
    expect(text).not.toContain('## Sources');
    expect(text.slice(0, text.indexOf('<!-- knode:begin body -->'))).not.toMatch(/claims:|documents:/);
  });

  it('keep views apart from facts and name relations, linking only pages that exist', async () => {
    const text = page('atlas-depot');
    expect(text).toContain('_3 claims from 1 document._');
    expect(text).toMatch(/## Facts \(current\)\n\n(- .*\n)*- Atlas Depot has twelve loading bays `fact` — raw\/docs\/notes\/atlas\.md/);
    expect(text).toMatch(/## Views and forecasts\n\n- Atlas Depot expects a record quarter `prediction` — raw\/docs\/notes\/atlas\.md/);
    expect(text).toContain('## Relations');
    expect(text).toContain('- located in → Tidewater Port: on the east quay — raw/docs/notes/atlas.md');
    expect(hasPage('tidewater-port')).toBe(false);
  });

  it('are listed with what each holds', async () => {
    await ensureEntitiesIndex(ctx);
    const index = fs.readFileSync(path.join(dataDir, 'wiki', 'entities', 'index.md'), 'utf8');
    const rows = index.split('\n').filter((l) => l.startsWith('* '));
    expect(rows[0]).toMatch(/^\* \[Harbor Freight Lines\]\(harbor-freight-lines\.md\) \(organization\).* `40 claims, 40 documents`$/);
    expect(rows[1]).toMatch(/^\* \[Atlas Depot\]\(atlas-depot\.md\) \(organization\).* `3 claims, 1 document`$/);
    expect(rows).toHaveLength(2);
  });

  it('are written again when their generator has changed, without a model', async () => {
    await ctx.store.query(`UPDATE pages SET generator = 'entity_stub@2' WHERE path = 'wiki/entities/atlas-depot.md'`);
    fs.writeFileSync(path.join(dataDir, 'wiki', 'entities', 'atlas-depot.md'), page('atlas-depot').replace('twelve loading bays', 'TWELVE'));
    await ctx.store.query(`UPDATE pages SET file_sha = NULL WHERE path = 'wiki/entities/atlas-depot.md'`);
    const stats = await reconcileViews(ctx, { llm: false });
    expect(stats.regenerated).toBeGreaterThanOrEqual(1);
    expect(page('atlas-depot')).toContain('Atlas Depot has twelve loading bays');
    const [row] = await ctx.store.query<{ generator: string; status: string }>(`SELECT generator, status FROM pages WHERE path = 'wiki/entities/atlas-depot.md'`);
    expect(row).toEqual({ generator: 'entity_stub@4', status: 'active' });
    // a page written before the entity it names had one links it once it is written again
    expect(page('harbor-freight-lines')).not.toContain('[[Atlas Depot]]');
    await ctx.store.query(`UPDATE pages SET generator = 'entity_stub@2' WHERE path = 'wiki/entities/harbor-freight-lines.md'`);
    await reconcileViews(ctx, { llm: false });
    expect(page('harbor-freight-lines')).toContain('- [[Atlas Depot]]: Atlas Depot leases two bays to Harbor Freight Lines `fact` — raw/docs/notes/atlas.md');
    // nothing left to do
    expect((await reconcileViews(ctx, { llm: false })).regenerated).toBe(0);
  });
});
