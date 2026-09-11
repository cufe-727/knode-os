import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig, KnodeConfig } from '../src/config.js';
import { resolve } from '../src/compiler/resolve.js';
import { AppContext, createContext } from '../src/context.js';
import { runSourceQuery } from '../src/datasource/execute.js';
import { initDataDir } from '../src/fs/datadir.js';
import { sync } from '../src/ingest/sync.js';
import { buildContextPack } from '../src/pack/pack.js';
import { listDatasets } from '../src/store/queries.js';

// the planner explores with a Thompson draw; pin it so the plan is reproducible
const rng = () => 0.5;

/**
 * The scenario from the design doc, end to end: one stock — research reports
 * (markdown), a local CSV of daily bars (DuckDB) and a live quote API
 * (http-json, mocked locally) — all reachable from the same entity, with the
 * API bound through a locator it could never sample by itself.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-quote-'));
const dataDir = path.join(tmp, 'data');
const calls: string[] = [];
let server: http.Server;
let port = 0;
let ctx: AppContext;

const REPORT = `---
title: 宁德时代研报
entities:
  - { name: 宁德时代, type: organization, aliases: ["300750", "CATL"] }
claims:
  - { subject: 宁德时代, type: earnings, statement: 2026Q2 净利润 120 亿元, status: fact, startDate: "2026-08-10" }
---
# 宁德时代研报

宁德时代动力电池全球第一，[[比亚迪]] 是主要竞争对手。
`;

const INTENT = `id: stock_analysis
title: 分析一只股票
match:
  keywords: ["分析", "表现", "走势"]
  entityTypes: [organization]
slots:
  - { id: identity, required: true, fill: local, from: [entity] }
  - { id: background, required: true, fill: local, from: [documents, claims] }
  - { id: latest_quote, required: true, fill: live, capabilityKinds: [endpoint], capabilityHints: [quote], freshnessSeconds: 60, description: 最新报价 }
  - { id: history, required: false, fill: live, capabilityKinds: [table], capabilityHints: [bars, daily], description: 历史日线 }
budget: { maxToolCalls: 4 }
`;

function configWith(sources: KnodeConfig['datasources']): void {
  const config = loadConfig(dataDir);
  config.datasources = sources;
  saveConfig(dataDir, config);
}

function quoteApi(): KnodeConfig['datasources'][number] {
  return {
    id: 'quote-api',
    kind: 'http-json',
    baseUrl: `http://127.0.0.1:${port}`,
    freshness: '15s',
    cost: 2,
    endpoints: [{
      name: 'quote',
      path: '/v1/quote',
      description: '实时行情 quote',
      params: [{ name: 'symbol', required: true }],
      resultPath: 'data',
      fields: [{ name: 'symbol', type: 'text' }, { name: 'price', type: 'double' }, { name: 'ts', type: 'timestamp' }],
      entityParams: [{ column: 'symbol', entityType: 'organization' }],
    }],
  };
}

function histCsv(): KnodeConfig['datasources'][number] {
  return {
    id: 'hist',
    kind: 'duckdb',
    path: 'datasets/quotes',
    tables: [{ name: 'daily_bars', description: '日线历史 daily bars', entityColumns: [{ column: 'symbol', entityType: 'organization' }] }],
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    calls.push(url.pathname + url.search);
    if (url.pathname === '/v1/quote') {
      const symbol = url.searchParams.get('symbol');
      if (!symbol) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'symbol required' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ symbol, price: symbol === '300750' ? 245.1 : 1, ts: '2026-09-09T01:00:00Z' }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;

  initDataDir(dataDir);
  fs.writeFileSync(path.join(dataDir, 'raw/docs/report.md'), REPORT);
  fs.mkdirSync(path.join(dataDir, 'datasets/quotes'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'datasets/quotes/daily_bars.csv'), 'symbol,trade_date,close\n300750,2026-08-27,243.68\n300750,2026-08-28,245.10\n600519,2026-08-28,1500.00\n');
  fs.mkdirSync(path.join(dataDir, 'intents'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'intents/stock_analysis.yaml'), INTENT);
  // the API is listed first on purpose: bindings must not depend on config order
  configWith([quoteApi(), histCsv()]);
  ctx = await createContext(dataDir);
});

afterAll(async () => {
  await ctx?.datasources.closeAll();
  await ctx?.store.close();
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('quote API + CSV history + research report around one entity', () => {
  it('registers the CSV as a table and the endpoint as a capability, both bound to the company', async () => {
    const stats = await sync(ctx, { llmGraph: false });
    expect(stats.errors).toBe(0);
    expect(stats.datasourceErrors).toEqual([]);

    expect((await listDatasets(ctx.store)).map((d) => d.id).sort()).toEqual(['hist.daily_bars', 'quote-api.quote']);
    const caps = await ctx.store.query<{ id: string; kind: string; dialect: string; freshness_seconds: number | null; cost: number }>(
      `SELECT id, kind, dialect, freshness_seconds, cost FROM capabilities WHERE tx_to IS NULL ORDER BY id`,
    );
    expect(caps).toEqual([
      { id: 'hist.daily_bars', kind: 'table', dialect: 'sql', freshness_seconds: null, cost: 1 },
      { id: 'quote-api.quote', kind: 'endpoint', dialect: 'http', freshness_seconds: 15, cost: 2 },
    ]);

    // the entity is reachable through both: sampled from the CSV, derived for the endpoint
    const locators = await ctx.store.query<{ capability_id: string; param: string; value: string }>(
      `SELECT capability_id, param, value FROM locators WHERE entity_id = '宁德时代' AND tx_to IS NULL ORDER BY capability_id, value`,
    );
    expect(locators).toEqual([
      { capability_id: 'hist.daily_bars', param: 'symbol', value: '300750' },
      { capability_id: 'quote-api.quote', param: 'symbol', value: '300750' },
    ]);
    const links = await ctx.store.query<{ target_id: string; description: string }>(
      `SELECT target_id, description FROM relations WHERE source_id = '宁德时代' AND type = 'appears_in' AND tx_to IS NULL ORDER BY target_id`,
    );
    expect(links.map((l) => l.target_id)).toEqual(['hist.daily_bars', 'quote-api.quote']);
    expect(links[1].description).toMatch(/bound by param quote\.symbol/);

    // the CSV really is queryable, with the symbol column bound the SQL way
    const bars = await runSourceQuery(ctx.datasources, 'hist', "SELECT close FROM daily_bars WHERE symbol = '300750' ORDER BY trade_date DESC LIMIT 3");
    expect(bars.rows.map((r) => Number(r.close))).toEqual([245.1, 243.68]);
    // a second sync changes nothing
    const again = await sync(ctx, { llmGraph: false });
    expect(again.applied).toBe(0);
    expect(again.disposed).toBe(0);
  });

  it('resolve plans a bound quote call and a bound history query, and both run', async () => {
    const pack = await resolve(ctx, '分析宁德时代最近的表现', { record: false, rng });
    expect(pack.intent.type).toBe('stock_analysis');
    expect(pack.intent.entities.map((e) => e.name)).toContain('宁德时代');
    expect(pack.facts.map((f) => f.statement)).toContain('2026Q2 净利润 120 亿元');

    const quote = pack.plan.nodes.find((n) => n.capability === 'quote-api.quote');
    expect(quote).toBeDefined();
    expect(quote!.tool).toEqual({ kind: 'mcp', server: 'knode-os', name: 'knode_query' });
    expect(quote!.args).toEqual({ source: 'quote-api', sql: 'quote?symbol=300750' });
    expect(quote!.fills).toBe('latest_quote');
    expect(quote!.freshness).toBe(60);

    const bars = pack.plan.nodes.find((n) => n.capability === 'hist.daily_bars');
    expect(bars).toBeDefined();
    expect(String(bars!.args.sql)).toContain("'300750'");
    expect(pack.availableNextQueries.map((q) => q.capability)).toEqual(expect.arrayContaining(['quote-api.quote', 'hist.daily_bars']));
    expect(pack.unknowns).toEqual([]);

    // the agent executes the plan nodes through knode_query
    for (const node of [quote!, bars!]) {
      const res = await runSourceQuery(ctx.datasources, String(node.args.source), String(node.args.sql));
      expect(res.rows.length).toBeGreaterThan(0);
      if (node === quote) expect(res.rows[0]).toMatchObject({ symbol: '300750', price: 245.1 });
    }
    expect(calls).toContain('/v1/quote?symbol=300750');
  });

  it('runs playbook probes in each source dialect and suggests the unprobed endpoint as a ready request', async () => {
    fs.writeFileSync(path.join(dataDir, 'packs/organization.md'), `---
type: playbook
appliesTo: organization
retrieval: { k: 4, mode: keyword }
probes:
  - id: quote
    source: quote-api
    table: quote
    sql: "quote?symbol={symbol}"
  - id: bars
    source: hist
    table: daily_bars
    sql: "SELECT * FROM daily_bars WHERE symbol = {symbol} ORDER BY trade_date DESC LIMIT 3"
---
行情以 quote-api 为准。
`);
    const before = calls.length;
    const pack = await buildContextPack(ctx, '宁德时代最近走势如何', { record: false });
    expect(pack.evidence.datasets.map((d) => d.id).sort()).toEqual(['hist.daily_bars', 'quote-api.quote']);
    const quote = pack.liveData.find((p) => p.id === 'quote');
    expect(quote?.ok).toBe(true);
    expect(quote?.sql).toBe('quote?symbol=300750');
    expect(quote?.rows?.[0]).toMatchObject({ price: 245.1 });
    expect(calls.slice(before)).toContain('/v1/quote?symbol=300750');
    const bars = pack.liveData.find((p) => p.id === 'bars');
    expect(bars?.ok).toBe(true);
    expect(bars?.rows?.length).toBe(2);
    expect(pack.suggestions.filter((s) => s.kind === 'query')).toEqual([]);

    // drop the quote probe: the pack now hands the endpoint over as a next query in its own dialect
    fs.writeFileSync(path.join(dataDir, 'packs/organization.md'), `---
type: playbook
appliesTo: organization
probes:
  - id: bars
    source: hist
    table: daily_bars
    sql: "SELECT * FROM daily_bars WHERE symbol = {symbol} ORDER BY trade_date DESC LIMIT 3"
---
`);
    const next = await buildContextPack(ctx, '宁德时代最近走势如何', { record: false });
    const suggestion = next.suggestions.find((s) => s.kind === 'query' && s.source === 'quote-api');
    expect(suggestion?.sql).toBe('quote?symbol=300750');
  });

  it('removing the API from the config retires its capability, locators and plan node', async () => {
    await ctx.datasources.closeAll();
    await ctx.store.close();
    configWith([histCsv()]);
    ctx = await createContext(dataDir);
    const stats = await sync(ctx, { llmGraph: false });
    expect(stats.disposed).toBe(1);

    const caps = await ctx.store.query<{ id: string }>(`SELECT id FROM capabilities WHERE tx_to IS NULL ORDER BY id`);
    expect(caps.map((c) => c.id)).toEqual(['hist.daily_bars']);
    const dead = await ctx.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM locators WHERE capability_id = 'quote-api.quote' AND tx_to IS NULL`);
    expect(dead[0].n).toBe(0);
    expect((await listDatasets(ctx.store)).map((d) => d.id)).toEqual(['hist.daily_bars']);

    const pack = await resolve(ctx, '分析宁德时代最近的表现', { record: false, rng });
    expect(pack.plan.nodes.find((n) => n.capability === 'quote-api.quote')).toBeUndefined();
    expect(pack.plan.nodes.find((n) => n.capability === 'hist.daily_bars')).toBeDefined();
    expect(pack.unknowns.some((u) => u.question.includes('最新报价'))).toBe(true);
    expect(pack.slots.find((s) => s.id === 'latest_quote')?.filled).toBe(false);
  });
});
