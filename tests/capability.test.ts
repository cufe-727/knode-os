import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { loadConfig, saveConfig } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { sync } from '../src/ingest/sync.js';
import { listCapabilities, locatorsForEntities } from '../src/capability/store.js';
import { renderCapabilityDts } from '../src/capability/dts.js';
import { parseCapabilityNotes } from '../src/capability/notes.js';
import { parseFrontmatter } from '../src/markdown.js';
import { extractRecords, parseStatement } from '../src/datasource/http.js';
import { splitInstant } from '../src/datasource/prometheus.js';
import { ObjectConnector } from '../src/datasource/object.js';
import { parseEpisode, renderEpisode } from '../src/ingest/episode.js';
import { readVirtual } from '../src/compiler/vfs.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-capability-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('connector dialects', () => {
  it('parses http statements in both forms and refuses undeclared endpoints', async () => {
    expect(parseStatement('quote?symbol=300750&window=5d')).toEqual({ endpoint: 'quote', params: { symbol: '300750', window: '5d' } });
    expect(parseStatement('{"endpoint":"quote","params":{"symbol":300750}}')).toEqual({ endpoint: 'quote', params: { symbol: '300750' } });
    expect(parseStatement('health')).toEqual({ endpoint: 'health', params: {} });

    const { HttpJsonConnector } = await import('../src/datasource/http.js');
    const connector = new HttpJsonConnector({
      id: 'api', kind: 'http-json', baseUrl: 'https://example.invalid',
      endpoints: [{ name: 'quote', path: 'v1/quote', params: [{ name: 'symbol' }] }],
    });
    // the allowlist is the whole point: an HTTP source must not become a proxy
    await expect(connector.query('anything-else')).rejects.toThrow(/unknown endpoint/);
    await expect(connector.query('quote?evil=1')).rejects.toThrow(/does not accept parameter/);
  });

  it('extracts records from a nested JSON body', () => {
    expect(extractRecords({ data: { items: [{ a: 1 }, { a: 2 }] } }, 'data.items')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(extractRecords({ a: 1 })).toEqual([{ a: 1 }]);
    expect(extractRecords({ data: { items: 'x' } }, 'data.items')).toEqual([{ value: 'x' }]);
    expect(extractRecords(null)).toEqual([]);
  });

  it('splits a PromQL instant suffix', () => {
    expect(splitInstant('up{job="api"}')).toEqual({ expr: 'up{job="api"}', time: null });
    const at = splitInstant('rate(http_total[5m]) @ 2026-09-01T00:00:00Z');
    expect(at.expr).toBe('rate(http_total[5m])');
    expect(at.time).toBe(String(Date.parse('2026-09-01T00:00:00Z') / 1000));
  });

  it('lists and reads objects without leaving its root', async () => {
    const root = path.join(tmp, 'objects');
    write(root, 'reports/a.txt', 'hello world');
    write(root, 'reports/b.bin', 'x');
    const connector = new ObjectConnector({ id: 'blobs', kind: 'object', path: root }, tmp);

    const listed = await connector.query('list reports');
    expect(listed.rows.map((r) => r.key)).toEqual(['reports/a.txt', 'reports/b.bin']);
    const head = await connector.query('head reports/a.txt');
    expect(head.rows[0]).toMatchObject({ key: 'reports/a.txt', binary: false, preview: 'hello world' });
    await expect(connector.query('head ../../etc/passwd')).rejects.toThrow();
    await expect(connector.query('rm reports/a.txt')).rejects.toThrow(/unknown verb/);

    const schemas = await connector.introspect();
    expect(schemas.map((s) => s.name)).toContain('reports');
  });
});

describe('capability notes', () => {
  it('reads the structured half of a capabilities doc and keeps the prose', () => {
    const parsed = parseFrontmatter(`---
capability: lake.daily_quotes
cost: 2
freshness: 15m
sampleQueries:
  - "SELECT close FROM daily_quotes WHERE symbol = {symbol}"
pitfalls:
  - "close 是未复权价"
joins:
  - "daily_quotes.symbol = companies.symbol"
---
每个交易日一行，收盘后 T+1 落库。
`);
    const [note] = parseCapabilityNotes(parsed);
    expect(note).toMatchObject({
      capability_id: 'lake.daily_quotes',
      cost: 2,
      freshness_seconds: 900,
      pitfalls: ['close 是未复权价'],
      joins: ['daily_quotes.symbol = companies.symbol'],
    });
    expect(note.semantics).toContain('T+1 落库');
  });

  it('is inert for a document that names no capability', () => {
    expect(parseCapabilityNotes(parseFrontmatter('# just a doc\n\nbody'))).toEqual([]);
  });

  it('keeps a note whose duration is a typo rather than dropping the semantics', () => {
    const [note] = parseCapabilityNotes(parseFrontmatter('---\ncapability: a.b\nfreshness: soon\n---\nprose'));
    expect(note.freshness_seconds).toBeNull();
    expect(note.semantics).toBe('prose');
  });
});

describe('episodes', () => {
  it('turns a transcript into turns with their tool calls and observations', () => {
    const raw = [
      JSON.stringify({ type: 'user', sessionId: 's1', timestamp: '2026-09-01T00:00:00Z', message: { role: 'user', content: '查一下宁德时代' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '好的' }, { type: 'tool_use', name: 'knode_search', input: { query: '宁德时代' } }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: '3 hits' }] } }),
      'not json at all',
    ].join('\n');

    const episode = parseEpisode(raw, { source: 'claude' });
    expect(episode.sessionId).toBe('s1');
    expect(episode.turns).toHaveLength(3);
    expect(episode.turns[1].toolCalls[0].name).toBe('knode_search');
    expect(episode.turns[2].observations).toEqual(['3 hits']);

    const md = renderEpisode(episode, 'raw/traces/claude/s1.jsonl');
    expect(md).toContain('sessionId: "s1"');
    expect(md).toContain('**tool call** `knode_search`');
    expect(md).toContain('**observation**');
  });
});

describe('capability graph over a live source', () => {
  const dataDir = path.join(tmp, 'graph');
  let ctx: AppContext;

  afterAll(async () => {
    await ctx?.datasources.closeAll();
    await ctx?.store.close();
  });

  it('registers a capability and a locator per linked entity value', async () => {
    initDataDir(dataDir);
    const lake = path.join(dataDir, 'lake');
    fs.mkdirSync(lake, { recursive: true });
    const instance = await DuckDBInstance.create(':memory:');
    const conn = await instance.connect();
    await conn.run(`CREATE TABLE daily_quotes (symbol VARCHAR, trade_date DATE, close DOUBLE)`);
    await conn.run(`INSERT INTO daily_quotes VALUES ('300750', DATE '2026-09-08', 243.68)`);
    await conn.run(`COPY daily_quotes TO '${path.join(lake, 'daily_quotes.parquet').replace(/'/g, "''")}' (FORMAT PARQUET)`);
    conn.disconnectSync();

    const config = loadConfig(dataDir);
    config.datasources = [{
      id: 'lake',
      kind: 'duckdb',
      path: 'lake',
      freshness: '1d',
      tables: [{ name: 'daily_quotes', description: '日行情', entityColumns: [{ column: 'symbol', entityType: 'organization' }] }],
    }];
    saveConfig(dataDir, config);

    write(dataDir, 'raw/docs/catl.md', `---
title: 宁德时代研报
entities:
  - { name: 宁德时代, type: organization, aliases: ["300750"] }
claims:
  - { subject: 宁德时代, type: earnings, statement: 2026Q2 净利润 120 亿元, status: fact, startDate: "2026-04-01" }
---
# 宁德时代研报

宁德时代动力电池出货量全球第一。
`);
    write(dataDir, 'capabilities/daily-quotes.md', `---
capability: lake.daily_quotes
cost: 2
freshness: 30s
sampleQueries:
  - "SELECT trade_date, close FROM daily_quotes WHERE symbol = {symbol} ORDER BY trade_date DESC LIMIT 5"
pitfalls:
  - "close 是未复权价"
---
每个交易日一行，收盘后 T+1 落库。
`);

    ctx = await createContext(dataDir);
    const res = await sync(ctx, { llmGraph: false });
    expect(res.errors).toBe(0);

    const caps = await listCapabilities(ctx.store, { excludeBuiltin: true });
    const quotes = caps.find((c) => c.id === 'lake.daily_quotes');
    expect(quotes).toBeDefined();
    expect(quotes).toMatchObject({ kind: 'table', dialect: 'sql', sourceId: 'lake' });
    // the written note wins over the introspection default on cost and freshness
    expect(quotes!.cost).toBe(2);
    expect(quotes!.freshnessSeconds).toBe(30);
    expect(quotes!.pitfalls).toEqual(['close 是未复权价']);
    expect(quotes!.semantics).toContain('T+1 落库');
    expect(quotes!.notes[0].sourcePath).toBe('capabilities/daily-quotes.md');

    // the doc's alias is what binds the entity to the table
    const locators = await locatorsForEntities(ctx.store, ['宁德时代']);
    expect(locators).toContainEqual({ entityId: '宁德时代', capabilityId: 'lake.daily_quotes', param: 'symbol', value: '300750' });
  });

  it('lists built-in tools alongside external sources, and renders a d.ts', async () => {
    const all = await listCapabilities(ctx.store);
    expect(all.map((c) => c.id)).toEqual(expect.arrayContaining(['lake.daily_quotes', 'knode.search', 'knode.claims']));

    const dts = renderCapabilityDts(all);
    expect(dts).toContain('export declare const live');
    expect(dts).toContain('daily_quotes');
    expect(dts).toContain('close: number');
    expect(dts).toContain('close 是未复权价');
  });

  it('renders entity, capability and claim pages on read', async () => {
    const entity = await readVirtual(ctx, '/entities/宁德时代.md');
    expect(entity).toContain('# 宁德时代');
    expect(entity).toContain('2026Q2 净利润 120 亿元');
    expect(entity).toContain('`symbol = 300750`');

    const capability = await readVirtual(ctx, '/capabilities/lake/daily_quotes.md');
    expect(capability).toContain('## Pitfalls');
    expect(capability).toContain('close 是未复权价');

    const claims = await readVirtual(ctx, '/claims/宁德时代.md');
    expect(claims).toContain('2026Q2 净利润 120 亿元');

    const live = await readVirtual(ctx, '/live/lake.daily_quotes?symbol=300750');
    expect(live).toContain('243.68');

    await expect(readVirtual(ctx, '/nope/x.md')).rejects.toThrow(/no such virtual path/);
    // built-ins are tools, not tables — /live would have nothing to query
    await expect(readVirtual(ctx, '/live/knode.search')).rejects.toThrow(/built-in tool/);
  });

  it('retires the capability, its notes and its locators when the source leaves the config', async () => {
    const config = loadConfig(dataDir);
    config.datasources = [];
    saveConfig(dataDir, config);
    const reopened = await createContext(dataDir);
    try {
      await sync(reopened, { llmGraph: false });
      expect(await listCapabilities(reopened.store, { excludeBuiltin: true })).toHaveLength(0);
      expect(await locatorsForEntities(reopened.store, ['宁德时代'])).toHaveLength(0);
      // the entity itself is still asserted by the document, so it survives
      const [entity] = await reopened.store.query<{ id: string }>(`SELECT id FROM entities WHERE id = '宁德时代' AND tx_to IS NULL`);
      expect(entity).toBeDefined();
    } finally {
      await reopened.datasources.closeAll();
      await reopened.store.close();
    }
  });
});
