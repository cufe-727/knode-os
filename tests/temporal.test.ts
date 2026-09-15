import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { claimsForEntities, graphSearch } from '../src/graph/query.js';
import { sync } from '../src/ingest/sync.js';
import { buildContextPack } from '../src/pack/pack.js';
import { search } from '../src/search/search.js';
import { catalogQuery, assertCatalogTables } from '../src/store/catalog.js';
import { queryClaims } from '../src/store/claims.js';
import {
  TemporalError,
  parseDuration,
  resolveScopeFilter,
  resolveTemporal,
} from '../src/store/resolver.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-temporal-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/* Two reports about the same company in different quarters, plus a skill file
   and a hand-written wiki note — enough to tell the axes and the source kinds
   apart. */
const REPORT_Q1 = `---
title: 宁德时代 2026Q1 研报
entities:
  - { name: 宁德时代, type: organization, aliases: ["300750"] }
claims:
  - { subject: 宁德时代, type: earnings, statement: 2026Q1 净利润 90 亿元, status: fact, startDate: "2026-01-01", endDate: "2026-03-31" }
---
# 宁德时代 2026Q1 研报

宁德时代一季度动力电池出货量保持第一。
`;

const REPORT_Q2 = `---
title: 宁德时代 2026Q2 研报
entities:
  - { name: 宁德时代, type: organization }
  - { name: 比亚迪, type: organization }
claims:
  - { subject: 宁德时代, type: earnings, statement: 2026Q2 净利润 120 亿元, status: fact, startDate: "2026-04-01" }
---
# 宁德时代 2026Q2 研报

宁德时代与 [[比亚迪]] 在 [[动力电池]] 市场竞争。
`;

const SKILL = `# 动力电池尽调

查动力电池公司时，先看宁德时代的出货量口径。
`;

const WIKI_NOTE = `# 动力电池笔记

关于宁德时代的手写笔记：口径以年报为准。
`;

describe('temporal resolver', () => {
  it('keeps the three time axes apart and validates each one', () => {
    const t = resolveTemporal({ asOf: '2026-05-01', validRange: '2026-02', freshness: '15m' });
    // the axes do not contaminate each other: system time, world time, live-read age
    expect(t.txTime).toBe('2026-05-01T00:00:00.000Z');
    expect(t.validFrom).toBe('2026-02-01T00:00:00.000Z');
    expect(t.freshnessSeconds).toBe(900);
    expect(t.notes).toHaveLength(3);
    expect(() => resolveTemporal({ validRange: 'not-a-date' })).toThrow(TemporalError);
    expect(() => resolveTemporal({ asOf: 'yesterday' })).toThrow(TemporalError);
    expect(() => resolveTemporal({ validAt: '2026-01-01', validRange: '2026' })).toThrow(TemporalError);
    expect(() => resolveTemporal({ validRange: '2026-06-01..2026-01-01' })).toThrow(/inverted/);
  });

  it('widens calendar shorthand and honours open-ended ranges', () => {
    expect(resolveTemporal({ validRange: '2026' })).toMatchObject({
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: '2026-12-31T23:59:59.999Z',
      validPoint: false,
    });
    expect(resolveTemporal({ validRange: '2026-02' })).toMatchObject({
      validFrom: '2026-02-01T00:00:00.000Z',
      validTo: '2026-02-28T23:59:59.999Z',
    });
    // a bare date widens to the whole day, and each end widens to its own side
    expect(resolveTemporal({ validRange: '2026-03-01..2026-03-01' })).toMatchObject({
      validFrom: '2026-03-01T00:00:00.000Z',
      validTo: '2026-03-01T23:59:59.999Z',
    });
    expect(resolveTemporal({ validRange: '2026-03-01..' })).toMatchObject({ validTo: null });
    expect(resolveTemporal({ validRange: { from: null, to: '2026-06' } })).toMatchObject({
      validFrom: null,
      validTo: '2026-06-30T23:59:59.999Z',
    });
    // valid_at stays a point, which is what the claim window must contain
    expect(resolveTemporal({ validAt: '2026-03-15T00:00:00Z' })).toMatchObject({
      validFrom: '2026-03-15T00:00:00.000Z',
      validTo: '2026-03-15T00:00:00.000Z',
      validPoint: true,
    });
  });

  it('parses durations and rejects unknown source kinds', () => {
    expect([parseDuration('30s'), parseDuration('15m'), parseDuration('2h'), parseDuration('1w'), parseDuration(90)])
      .toEqual([30, 900, 7200, 604800, 90]);
    expect(() => parseDuration('soon')).toThrow(TemporalError);
    expect(resolveScopeFilter({ kinds: ['docs', 'Skill'] }).kinds).toEqual(['doc', 'skill']);
    expect(() => resolveScopeFilter({ kinds: ['dataset'] })).toThrow(/unknown source kind/);
    // raw paths are the keys the pipeline indexes: prefixes pass through cleaned, nothing is added
    expect(resolveScopeFilter({ sources: ['/raw/docs/reports/'] }).sources).toEqual(['raw/docs/reports']);
  });
});

describe('catalog guard', () => {
  it('allows the v_* views and CTEs over them, and nothing else', () => {
    expect(() => assertCatalogTables('SELECT * FROM v_claims')).not.toThrow();
    expect(() => assertCatalogTables('WITH t AS (SELECT * FROM v_entities) SELECT * FROM t JOIN v_claims ON true')).not.toThrow();
    expect(() => assertCatalogTables('SELECT * FROM claims')).toThrow(/not readable/);
    expect(() => assertCatalogTables('SELECT * FROM pg_catalog.pg_tables')).toThrow(/not readable/);
    expect(() => assertCatalogTables('SELECT * FROM v_claims JOIN evidence ON true')).toThrow(/not readable/);
  });
});

describe('phase 2: temporal and scope filters across the query surfaces', () => {
  const dataDir = path.join(tmp, 'filters');
  let ctx: AppContext;

  afterAll(async () => {
    await ctx?.store.close();
  });

  it('indexes the corpus', async () => {
    initDataDir(dataDir);
    write(dataDir, 'raw/docs/reports/q1.md', REPORT_Q1);
    write(dataDir, 'raw/docs/news/q2.md', REPORT_Q2);
    write(dataDir, 'raw/skills/battery.md', SKILL);
    write(dataDir, 'wiki/notes/battery.md', WIKI_NOTE);
    ctx = await createContext(dataDir);
    const res = await sync(ctx, { llmGraph: false });
    expect(res.errors).toBe(0);
    expect(await ctx.store.query(`SELECT 1 FROM claims WHERE subject_id = '宁德时代' AND tx_to IS NULL`)).toHaveLength(2);
  });

  it('drops the legacy TEXT date columns and keeps the timestamp window', async () => {
    const cols = await ctx.store.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'claims'`,
    );
    const names = cols.map((c) => c.column_name);
    expect(names).not.toContain('start_date');
    expect(names).not.toContain('end_date');
    expect(names).toEqual(expect.arrayContaining(['valid_from', 'valid_to']));
  });

  it('filters claims by world time: an instant, a window, and an overlap', async () => {
    const all = await queryClaims(ctx.store, { subject: '宁德时代' });
    expect(all.claims).toHaveLength(2);

    // Q1 only: its window is closed on 2026-03-31, Q2's opens on 2026-04-01
    const q1 = await queryClaims(ctx.store, {
      subject: '宁德时代',
      temporal: resolveTemporal({ validAt: '2026-02-15' }),
    });
    expect(q1.claims.map((c) => c.statement)).toEqual(['2026Q1 净利润 90 亿元']);

    const q2 = await queryClaims(ctx.store, {
      subject: '宁德时代',
      temporal: resolveTemporal({ validAt: '2026-07-01' }),
    });
    expect(q2.claims.map((c) => c.statement)).toEqual(['2026Q2 净利润 120 亿元']);

    // a range overlaps both windows where a single instant could not
    const spanning = await queryClaims(ctx.store, {
      subject: '宁德时代',
      temporal: resolveTemporal({ validRange: '2026-03-01..2026-05-01' }),
    });
    expect(spanning.claims).toHaveLength(2);

    // a window entirely before either claim starts matches nothing
    const before = await queryClaims(ctx.store, {
      subject: '宁德时代',
      temporal: resolveTemporal({ validRange: '2025' }),
    });
    expect(before.claims).toHaveLength(0);
  });

  it('reports a closed validity window as stale, with its supporting source', async () => {
    const res = await queryClaims(ctx.store, { subject: '宁德时代', types: ['earnings'] });
    const q1 = res.claims.find((c) => c.statement.includes('Q1'))!;
    const q2 = res.claims.find((c) => c.statement.includes('Q2'))!;
    expect(q1).toMatchObject({ stale: true, validFrom: '2026-01-01', validTo: '2026-03-31' });
    expect(q2).toMatchObject({ stale: false, validTo: null });
    expect(q1.sourcePath).toBe('raw/docs/reports/q1.md');
    expect(q1.evidenceCount).toBeGreaterThan(0);
  });

  it('restricts claims to the sources that support them', async () => {
    const fromReports = await queryClaims(ctx.store, {
      subject: '宁德时代',
      filter: resolveScopeFilter({ sources: ['raw/docs/reports'] }),
    });
    expect(fromReports.claims.map((c) => c.statement)).toEqual(['2026Q1 净利润 90 亿元']);

    const fromSkills = await queryClaims(ctx.store, {
      subject: '宁德时代',
      filter: resolveScopeFilter({ kinds: ['skill'] }),
    });
    expect(fromSkills.claims).toHaveLength(0);
    expect(fromReports.applied).toContain('sources under raw/docs/reports');
  });

  it('restricts search recall by source kind and path prefix', async () => {
    const everywhere = await search(ctx.store, ctx.embedder, '宁德时代 动力电池', { k: 20, track: false });
    const roots = new Set(everywhere.map((r) => r.path.split('/')[0]));
    expect(roots.size).toBeGreaterThan(1);

    const onlySkills = await search(ctx.store, ctx.embedder, '宁德时代 动力电池', {
      k: 20,
      track: false,
      filter: resolveScopeFilter({ kinds: ['skill'] }),
    });
    expect(onlySkills.length).toBeGreaterThan(0);
    expect(onlySkills.every((r) => r.path.startsWith('raw/skills/'))).toBe(true);

    const onlyNews = await search(ctx.store, ctx.embedder, '宁德时代', {
      k: 20,
      track: false,
      filter: resolveScopeFilter({ sources: ['raw/docs/news'] }),
    });
    expect(onlyNews.length).toBeGreaterThan(0);
    expect(onlyNews.every((r) => r.path.startsWith('raw/docs/news/'))).toBe(true);
  });

  it('keeps the sag expansion inside the filter instead of escaping through a shared entity', async () => {
    // 宁德时代 appears in both reports, so an unfiltered walk bridges across them
    const wide = await search(ctx.store, ctx.embedder, '宁德时代', { k: 20, mode: 'sag', track: false });
    expect(new Set(wide.map((r) => r.path)).size).toBeGreaterThan(1);

    const scoped = await search(ctx.store, ctx.embedder, '宁德时代', {
      k: 20,
      mode: 'sag',
      track: false,
      filter: resolveScopeFilter({ sources: ['raw/docs/news'] }),
    });
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((r) => r.path.startsWith('raw/docs/news/'))).toBe(true);
  });

  it('applies the filter to graph nodes and to the claims hanging off them', async () => {
    const wide = await graphSearch(ctx.store, '宁德时代', { track: false });
    expect(wide.nodes.map((n) => n.id)).toContain('比亚迪');

    const scoped = await graphSearch(ctx.store, '宁德时代', {
      track: false,
      filter: resolveScopeFilter({ sources: ['raw/docs/reports'] }),
    });
    // 比亚迪 is only mentioned by the Q2 news report, so it is out of scope here
    expect(scoped.nodes.map((n) => n.id)).not.toContain('比亚迪');
    expect(scoped.chunks.every((c) => c.path.startsWith('raw/docs/reports/'))).toBe(true);
    expect((scoped.claims ?? []).map((c) => c.statement)).toEqual(['2026Q1 净利润 90 亿元']);
  });

  it('carries the world-time window into claimsForEntities', async () => {
    const point = await claimsForEntities(ctx.store, ['宁德时代'], 12, {
      temporal: resolveTemporal({ validAt: '2026-02-15' }),
    });
    expect(point.map((c) => c.statement)).toEqual(['2026Q1 净利润 90 亿元']);

    const window = await claimsForEntities(ctx.store, ['宁德时代'], 12, {
      temporal: resolveTemporal({ validRange: '2026' }),
    });
    expect(window).toHaveLength(2);
  });

  it('builds a context pack inside the requested window and reports what it applied', async () => {
    const pack = await buildContextPack(ctx, '宁德时代最近的业绩如何', {
      record: false,
      temporal: resolveTemporal({ validRange: '2026-01-01..2026-03-31', freshness: '15m' }),
      filter: resolveScopeFilter({ kinds: ['doc'] }),
    });
    expect(pack.evidence.claims.map((c) => c.statement)).toEqual(['2026Q1 净利润 90 亿元']);
    expect(pack.evidence.docs.every((d) => d.path.startsWith('raw/docs/'))).toBe(true);
    expect(pack.validRange).toEqual({ from: '2026-01-01T00:00:00.000Z', to: '2026-03-31T23:59:59.999Z' });
    expect(pack.validAt).toBeNull();
    expect(pack.applied.join(' ')).toMatch(/freshness ≤ 900s/);
  });

  it('answers catalog SQL through the views, with an enforced row cap', async () => {
    const res = await catalogQuery(ctx.store, `SELECT id, status FROM v_claims ORDER BY id`);
    expect(res.rowCount).toBe(2);
    expect(res.truncated).toBe(false);

    const capped = await catalogQuery(ctx.store, `SELECT id FROM v_entities`, { maxRows: 1 });
    expect(capped.rows).toHaveLength(1);
    expect(capped.truncated).toBe(true);

    // the views expose lineage, which is the point of opening SQL at all
    const perSource = await catalogQuery(
      ctx.store,
      `SELECT source_path, count(*)::int AS n FROM v_evidence WHERE kind = 'claim' GROUP BY source_path ORDER BY source_path`,
    );
    expect(perSource.rows.map((r) => r.source_path)).toEqual([
      'raw/docs/news/q2.md',
      'raw/docs/reports/q1.md',
    ]);

    await expect(catalogQuery(ctx.store, `SELECT * FROM claims`)).rejects.toThrow(/not readable/);
    await expect(catalogQuery(ctx.store, `DELETE FROM v_claims`)).rejects.toThrow(/read-only guard/);
    await expect(catalogQuery(ctx.store, `SHOW TABLES`)).rejects.toThrow(/only SELECT/);
  });

  it('answers as_of from the state before a source was removed, filter included', async () => {
    const before = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 20));
    fs.rmSync(path.join(dataDir, 'raw/docs/reports/q1.md'));
    await sync(ctx, { llmGraph: false });

    expect((await queryClaims(ctx.store, { subject: '宁德时代' })).claims).toHaveLength(1);

    const asOf = await queryClaims(ctx.store, {
      subject: '宁德时代',
      temporal: resolveTemporal({ asOf: before }),
    });
    expect(asOf.claims).toHaveLength(2);

    // the source filter still applies to the state as it was then
    const asOfScoped = await queryClaims(ctx.store, {
      subject: '宁德时代',
      temporal: resolveTemporal({ asOf: before }),
      filter: resolveScopeFilter({ sources: ['raw/docs/reports'] }),
    });
    expect(asOfScoped.claims.map((c) => c.statement)).toEqual(['2026Q1 净利润 90 亿元']);
    expect(asOfScoped.claims[0].sourcePath).toBe('raw/docs/reports/q1.md');

    // and the two axes compose: believed then, holding in Q2
    const composed = await queryClaims(ctx.store, {
      subject: '宁德时代',
      temporal: resolveTemporal({ asOf: before, validAt: '2026-07-01' }),
    });
    expect(composed.claims.map((c) => c.statement)).toEqual(['2026Q2 净利润 120 亿元']);
  });
});
