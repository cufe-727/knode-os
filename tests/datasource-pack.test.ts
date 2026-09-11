import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { createContext } from '../src/context.js';
import { assertReadOnlySql, sqlStringLiteral } from '../src/datasource/guard.js';
import { syncDatasources } from '../src/datasource/sync.js';
import { grepFiles } from '../src/fs/files.js';
import { initDataDir } from '../src/fs/datadir.js';
import { frontmatterExtraction } from '../src/graph/frontmatter.js';
import { runIngest } from '../src/ingest/pipeline.js';
import { optimizePacks, applySuggestion } from '../src/pack/learn.js';
import { annotateClaims, buildContextPack } from '../src/pack/pack.js';
import { entitySymbol, parsePlaybook, renderProbeSql, resolvePlaybook } from '../src/pack/playbook.js';
import { loadConfig, saveConfig } from '../src/config.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-dspack-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('read-only SQL guard', () => {
  it('allows read statements', () => {
    expect(() => assertReadOnlySql('SELECT * FROM t WHERE a = 1')).not.toThrow();
    expect(() => assertReadOnlySql('  select 1;')).not.toThrow();
    expect(() => assertReadOnlySql('WITH x AS (SELECT 1) SELECT * FROM x')).not.toThrow();
    expect(() => assertReadOnlySql('EXPLAIN SELECT 1')).not.toThrow();
    expect(() => assertReadOnlySql('SHOW TABLES')).not.toThrow();
    expect(() => assertReadOnlySql('DESCRIBE daily_quotes')).not.toThrow();
  });

  it('rejects writes, DDL and multi-statements', () => {
    expect(() => assertReadOnlySql('DELETE FROM t')).toThrow(/read-only/);
    expect(() => assertReadOnlySql('DROP TABLE t')).toThrow(/read-only/);
    expect(() => assertReadOnlySql('SELECT 1; DROP TABLE t')).toThrow(/multiple/);
    expect(() => assertReadOnlySql('WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x')).toThrow(/DELETE/);
    expect(() => assertReadOnlySql('INSERT INTO t VALUES (1)')).toThrow(/read-only/);
    expect(() => assertReadOnlySql('SELECT * FROM t INTO OUTFILE "/tmp/x" -- copy')).not.toThrow(); // comment stripped, no banned keyword
    expect(() => assertReadOnlySql('COPY t TO stdout')).toThrow(/read-only/);
  });

  it('ignores keywords inside string literals and comments', () => {
    expect(() => assertReadOnlySql("SELECT * FROM t WHERE name = 'drop table; delete'")).not.toThrow();
    expect(() => assertReadOnlySql('SELECT 1 -- delete everything\n')).not.toThrow();
    expect(() => assertReadOnlySql('SELECT 1 /* insert */')).not.toThrow();
  });

  it('escapes string literals safely', () => {
    expect(sqlStringLiteral("宁德时代")).toBe("'宁德时代'");
    expect(sqlStringLiteral("O'Neil")).toBe("'O''Neil'");
    expect(sqlStringLiteral("a\\'b")).toBe("'a''b'");
  });
});

describe('playbook', () => {
  const raw = `---
type: playbook
appliesTo: organization
retrieval: { k: 4, mode: hybrid }
probes:
  - id: quote
    source: market-mysql
    table: daily_quotes
    sql: "SELECT * FROM daily_quotes WHERE symbol = {symbol} LIMIT 5"
suggestions:
  - "check hist-parquet for history"
---

Guidance body.
`;

  it('parses frontmatter probes and guidance', () => {
    const pb = parsePlaybook(raw, 'packs/organization.md');
    expect(pb).not.toBeNull();
    expect(pb!.appliesTo).toBe('organization');
    expect(pb!.retrieval.k).toBe(4);
    expect(pb!.probes).toHaveLength(1);
    expect(pb!.suggestions).toHaveLength(1);
    expect(pb!.guidance).toContain('Guidance body');
  });

  it('resolves the most specific playbook', () => {
    const type = parsePlaybook(raw, 'packs/organization.md')!;
    const specific = parsePlaybook(raw.replace('appliesTo: organization', 'appliesTo: entity:宁德时代'), 'packs/entity.md')!;
    const fallback = parsePlaybook(raw.replace('appliesTo: organization', 'appliesTo: default'), 'packs/default.md')!;
    const all = [fallback, type, specific];
    expect(resolvePlaybook(all, { id: '宁德时代', type: 'organization' })!.path).toBe('packs/entity.md');
    expect(resolvePlaybook(all, { id: 'x', type: 'organization' })!.path).toBe('packs/organization.md');
    expect(resolvePlaybook(all, { id: 'x', type: 'person' })!.path).toBe('packs/default.md');
  });

  it('renders {symbol}/{name} with ticker-preferring alias choice', () => {
    const entity = { name: '宁德时代', aliases: ['CATL', '300750'] };
    expect(entitySymbol(entity)).toBe('300750');
    const sql = renderProbeSql('SELECT * FROM q WHERE symbol = {symbol} AND name = {name}', entity, sqlStringLiteral);
    expect(sql).toBe("SELECT * FROM q WHERE symbol = '300750' AND name = '宁德时代'");
  });
});

describe('frontmatter extraction (tier 0.5)', () => {
  it('parses declared entities and claims', () => {
    const res = frontmatterExtraction({
      entities: [{ name: '宁德时代', type: 'organization', aliases: ['300750'] }],
      claims: [
        { subject: '宁德时代', type: 'earnings', statement: 'Q2 净利润 120 亿', status: 'fact', startDate: '2026-08-10' },
        { subject: '贵州茅台', statement: '窗口期', endDate: new Date('2026-07-31') },
      ],
    });
    expect(res).not.toBeNull();
    expect(res!.entities.map((e) => e.name)).toEqual(['宁德时代', '贵州茅台']);
    expect(res!.claims[0].status).toBe('fact');
    expect(res!.claims[1].endDate).toBe('2026-07-31');
  });

  it('returns null without declarations', () => {
    expect(frontmatterExtraction({ title: 'x' })).toBeNull();
  });
});

describe('claim annotation', () => {
  it('flags stale and conflicting claims', () => {
    const base = { object: null, type: 'earnings', startDate: '2026-08-10', endDate: null, path: 'a.md' };
    const claims = annotateClaims(
      [
        { ...base, id: 'c1', subject: '宁德时代', statement: '2026Q2 净利润 120 亿元，同比增长 20%', status: 'fact' },
        { ...base, id: 'c2', subject: '宁德时代', statement: '2026Q2 净利润修正为 110 亿元', status: 'disputed', startDate: '2026-08-12', path: 'b.md' },
        { ...base, id: 'c3', subject: '贵州茅台', type: 'pricing', statement: '提价窗口期', endDate: '2026-07-31' },
      ],
      '2026-08-30',
    );
    expect(claims.find((c) => c.id === 'c1')!.conflictsWith).toContain('c2');
    expect(claims.find((c) => c.id === 'c2')!.conflictsWith).toContain('c1');
    expect(claims.find((c) => c.id === 'c3')!.stale).toBe(true);
    expect(claims.find((c) => c.id === 'c1')!.stale).toBe(false);
  });
});

describe('grep', () => {
  it('finds regex matches with line numbers', () => {
    const dir = path.join(tmp, 'grep');
    fs.mkdirSync(path.join(dir, 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'wiki', 'a.md'), 'line one\n净利润 120 亿元\nline three\n');
    const hits = grepFiles(dir, '净利润.*亿');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ path: 'wiki/a.md', line: 2 });
  });
});

describe('end-to-end: duckdb source → graph → context pack → learning', () => {
  const dataDir = path.join(tmp, 'e2e');

  it('links live-table values to doc entities and assembles a pack', async () => {
    initDataDir(dataDir);

    // a parquet "HDFS table" containing the company symbol
    const parquetDir = path.join(dataDir, 'lake');
    fs.mkdirSync(parquetDir, { recursive: true });
    const instance = await DuckDBInstance.create(':memory:');
    const conn = await instance.connect();
    await conn.run(`CREATE TABLE bars (symbol VARCHAR, trade_date DATE, close DOUBLE)`);
    await conn.run(`INSERT INTO bars VALUES ('300750', DATE '2026-08-27', 243.68), ('300750', DATE '2026-08-28', 245.10)`);
    await conn.run(`COPY bars TO '${path.join(parquetDir, 'bars.parquet').replace(/'/g, "''")}' (FORMAT PARQUET)`);
    conn.disconnectSync();

    const config = loadConfig(dataDir);
    config.datasources = [{
      id: 'lake',
      kind: 'duckdb',
      path: 'lake',
      tables: [{ name: 'bars', entityColumns: [{ column: 'symbol', entityType: 'organization' }] }],
    }];
    saveConfig(dataDir, config);

    // a doc declaring the entity (name + ticker alias) and one stale claim
    fs.writeFileSync(path.join(dataDir, 'raw/docs/report.md'), `---
title: 宁德时代研报
entities:
  - { name: 宁德时代, type: organization, aliases: ["300750"] }
claims:
  - { subject: 宁德时代, type: pricing, statement: 目标价 310 元有效期至七月底, status: fact, startDate: "2026-06-01", endDate: "2026-07-31" }
---
# 宁德时代研报

宁德时代动力电池全球第一。
`);

    // playbook probing the parquet table
    fs.writeFileSync(path.join(dataDir, 'packs/organization.md'), `---
type: playbook
appliesTo: organization
retrieval: { k: 4, mode: keyword }
probes:
  - id: bars
    source: lake
    table: bars
    sql: "SELECT * FROM bars WHERE symbol = {symbol} ORDER BY trade_date DESC LIMIT 3"
  - id: broken
    source: lake
    table: bars
    sql: "SELECT * FROM missing_table LIMIT 1"
---
Guidance here.
`);

    const ctx = await createContext(dataDir);
    try {
      await runIngest(ctx.store, ctx.config, ctx.embedder, ctx.llm, { llmGraph: false });
      const sync = await syncDatasources(ctx.store, ctx.config, ctx.datasources);
      expect(sync.tables).toBe(1);
      expect(sync.errors).toEqual([]);
      expect(sync.linkedEntities).toBe(1);

      // the sampled symbol resolved to the existing entity via its alias
      const rels = await ctx.store.query<{ source_id: string; target_id: string }>(
        `SELECT source_id, target_id FROM relations WHERE type = 'appears_in'`,
      );
      expect(rels).toHaveLength(1);
      expect(rels[0].source_id).toBe('宁德时代');
      expect(rels[0].target_id).toBe('lake.bars');
      expect(fs.existsSync(path.join(dataDir, 'wiki/datasets/lake.bars.md'))).toBe(true);

      const pack = await buildContextPack(ctx, '宁德时代最近走势如何');
      expect(pack.matchedEntities.map((e) => e.name)).toContain('宁德时代');
      expect(pack.evidence.datasets.map((d) => d.id)).toContain('lake.bars');
      expect(pack.evidence.claims.some((c) => c.stale)).toBe(true);

      const bars = pack.liveData.find((p) => p.id === 'bars');
      expect(bars?.ok).toBe(true);
      expect(bars?.rows?.length).toBe(2);
      expect(bars?.asOf).toBeTruthy();
      const broken = pack.liveData.find((p) => p.id === 'broken');
      expect(broken?.ok).toBe(false);

      expect(pack.playbooksUsed).toContain('packs/organization.md');
      expect(pack.suggestions.some((s) => s.kind === 'freshness')).toBe(true);
      expect(pack.gaps.some((g) => g.includes('broken'))).toBe(true);

      // learning loop: a second event, then the failing probe gets revised away
      await buildContextPack(ctx, '宁德时代股价');
      const opt = await optimizePacks(ctx.store, ctx.config, ctx.llm);
      expect(opt.events).toBe(2);
      const revision = opt.suggestions.find((s) => s.kind === 'pack');
      expect(revision).toBeTruthy();
      expect(revision!.payload?.path).toBe('packs/organization.md');

      const applied = await applySuggestion(ctx.store, dataDir, revision!.id);
      expect(applied.applied).toBe(true);
      const revised = fs.readFileSync(path.join(dataDir, 'packs/organization.md'), 'utf8');
      expect(revised).toContain('id: bars');
      expect(revised).not.toContain('id: broken');
    } finally {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  }, 60_000);
});
