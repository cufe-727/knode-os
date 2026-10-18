import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { graphInsights, graphSearch } from '../src/graph/query.js';
import { buildOntology, CORE_PACK_YAML, loadOntology, normalizePredicate, ORGANIZATION_PACK_YAML, promptFragment, typePrecedence } from '../src/graph/ontology.js';
import { frontmatterExtraction } from '../src/graph/frontmatter.js';
import { sync } from '../src/ingest/sync.js';
import { ONTOLOGY_DIR } from '../src/fs/layout.js';
import { toDateString } from '../src/store/temporal.js';

/**
 * The configurable ontology: packs seeded on init, predicate normalization
 * (synonyms, inverse readings, symmetry), frontmatter-declared typed relations
 * with validity windows, and graph search honouring world time on edges.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-ontology-'));
let ctx: AppContext | undefined;
afterAll(async () => {
  await ctx?.datasources.closeAll();
  await ctx?.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('ontology packs', () => {
  it('normalizes synonyms, inverse readings and symmetric predicates', () => {
    const ont = buildOntology([]); // system predicates only
    expect(normalizePredicate(ont, 'co_occurs')).toEqual({ type: 'co_occurs', flip: false });
    expect(normalizePredicate(ont, 'subsidiary_of').unknown).toBe('subsidiary_of');

    const full = buildOntology([{ name: 'core', text: CORE_PACK_YAML }, { name: 'organization', text: ORGANIZATION_PACK_YAML }]);
    expect(normalizePredicate(full, 'subsidiary_of')).toEqual({ type: 'subsidiary_of', flip: false });
    expect(normalizePredicate(full, 'parent_of')).toEqual({ type: 'subsidiary_of', flip: true });
    expect(normalizePredicate(full, '子公司')).toEqual({ type: 'subsidiary_of', flip: false });
    expect(normalizePredicate(full, '母公司')).toEqual({ type: 'subsidiary_of', flip: true });
    expect(normalizePredicate(full, 'Supplier Of')).toEqual({ type: 'supplies_to', flip: false });
    expect(normalizePredicate(full, 'buys-from')).toEqual({ type: 'supplies_to', flip: true });
    expect(normalizePredicate(full, 'rival_of')).toEqual({ type: 'competes_with', flip: false });
    expect(normalizePredicate(full, 'employs')).toEqual({ type: 'works_at', flip: true });
    expect(normalizePredicate(full, 'sponsors')).toMatchObject({ type: 'related_to', flip: false, unknown: 'sponsors' });
    expect(typePrecedence(full).at(-1)).toBe('concept');
    expect(typePrecedence(full)[0]).toBe('person');
    const prompt = promptFragment(full);
    expect(prompt.relationTypes).toContain('subsidiary_of');
    expect(prompt.relationTypes).toContain('inverse: parent_of');
    expect(prompt.relationTypes).not.toContain('co_occurs');
  });

  it('parses frontmatter relations in list and map form with validity windows', () => {
    const list = frontmatterExtraction({
      relations: [
        { source: '宁德时代', target: '时代上汽', type: 'parent_of', from: '2017-05-01' },
        { target: '[[比亚迪|BYD]]', type: 'competes_with' },
      ],
    }, { defaultSource: '宁德时代' });
    expect(list?.relations).toEqual([
      expect.objectContaining({ source: '宁德时代', target: '时代上汽', type: 'parent_of', validFrom: '2017-05-01', validTo: null }),
      expect.objectContaining({ source: '宁德时代', target: '比亚迪', type: 'competes_with' }),
    ]);
    expect(list?.entities.map((e) => e.name)).toEqual(['宁德时代', '时代上汽', '比亚迪']);

    const map = frontmatterExtraction({ relations: { supplies_to: ['[[特斯拉]]', { target: '蔚来', validFrom: '2020-01-01', validTo: '2023-12-31' }] } }, { defaultSource: '宁德时代' });
    expect(map?.relations).toEqual([
      expect.objectContaining({ source: '宁德时代', target: '特斯拉', type: 'supplies_to' }),
      expect.objectContaining({ source: '宁德时代', target: '蔚来', type: 'supplies_to', validFrom: '2020-01-01', validTo: '2023-12-31' }),
    ]);
    expect(frontmatterExtraction({ title: 'no facts here' })).toBeNull();
  });

  it('seeds the packs on init, stores normalized time-bound edges, and filters them by world time', async () => {
    const dataDir = path.join(tmp, 'ws');
    write(dataDir, 'raw/docs/catl.md', `---
title: 宁德时代供应链
entities:
  - { name: 宁德时代, type: organization, aliases: ["CATL", "300750"] }
  - { name: 特斯拉, type: organization }
  - { name: 时代上汽, type: organization }
relations:
  - { source: 宁德时代, target: 特斯拉, type: 供应商, from: "2020-02-01" }
  - { source: 时代上汽, target: 宁德时代, type: subsidiary_of, from: "2017-05-01" }
  - { source: 宁德时代, target: 时代上汽, type: parent_of, from: "2017-05-01" }
  - { source: 宁德时代, target: 比亚迪, type: rival_of }
  - { source: 宁德时代, target: 蔚来, type: supplies_to, from: "2018-01-01", to: "2019-12-31" }
  - { source: 宁德时代, target: 某某赞助商, type: sponsors }
---
宁德时代（CATL）是动力电池供应商，2020 年起向特斯拉供货；时代上汽是其控股子公司。
`);
    ctx = await createContext(dataDir);
    expect(fs.existsSync(path.join(dataDir, ONTOLOGY_DIR, 'core.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, ONTOLOGY_DIR, 'organization.yaml'))).toBe(true);
    const ont = loadOntology(dataDir);
    expect(ont.packs).toEqual(['core', 'organization']);

    const stats = await sync(ctx, { llmGraph: false });
    expect(stats.indexed).toBeGreaterThanOrEqual(1);

    const rels = await ctx.store.query<{ source_id: string; target_id: string; type: string; valid_from: string | null; valid_to: string | null; weight: number }>(
      `SELECT source_id, target_id, type, valid_from, valid_to, weight FROM relations WHERE tx_to IS NULL ORDER BY type, source_id`,
    );
    // only typed predicates are rows; co-occurrence is derived from mentions on read
    expect(rels.map((r) => r.type)).not.toContain('co_occurs');
    const by = (type: string) => rels.filter((r) => r.type === type);
    // synonym → canonical, direction kept
    expect(by('supplies_to').map((r) => [r.source_id, r.target_id])).toEqual(expect.arrayContaining([['宁德时代', '特斯拉'], ['宁德时代', '蔚来']]));
    // inverse reading flipped into the canonical direction; both spellings from one source collapse to one row
    // (evidence is de-duplicated per scope + extractor, so the weight does not inflate)
    const sub = by('subsidiary_of');
    expect(sub).toHaveLength(1);
    expect(sub[0]).toMatchObject({ source_id: '时代上汽', target_id: '宁德时代', weight: 1 });
    expect(toDateString(sub[0].valid_from)).toBe('2017-05-01');
    // symmetric → endpoints ordered
    const comp = by('competes_with');
    expect(comp).toHaveLength(1);
    expect(comp[0].source_id < comp[0].target_id).toBe(true);
    // unknown predicate → related_to, counted in insights
    expect(by('related_to').some((r) => r.target_id === '某某赞助商')).toBe(true);
    const insights = await graphInsights(ctx.store);
    expect(insights.unknownPredicates).toEqual([{ raw: 'sponsors', n: 1 }]);
    expect(insights.relationTypeCounts.map((r) => r.type)).toEqual(expect.arrayContaining(['supplies_to', 'subsidiary_of']));
    expect(insights.relationTypeCounts.map((r) => r.type)).not.toContain('co_occurs');

    // world-time filtering on edges: the 蔚来 contract ended in 2019
    const now = await graphSearch(ctx.store, '宁德时代', { depth: 1, validAt: '2024-06-01', track: false });
    const targets = (r: typeof now) => r.edges.filter((e) => e.type === 'supplies_to').map((e) => e.target);
    expect(targets(now)).toContain('特斯拉');
    expect(targets(now)).not.toContain('蔚来');
    const then = await graphSearch(ctx.store, '宁德时代', { depth: 1, validAt: '2019-06-01', track: false });
    expect(targets(then)).toContain('蔚来');
    expect(targets(then)).not.toContain('特斯拉');
    const edge = now.edges.find((e) => e.type === 'supplies_to' && e.target === '特斯拉');
    expect(edge?.validFrom).toBe('2020-02-01');
  });
});
