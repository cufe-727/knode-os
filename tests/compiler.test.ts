import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { loadConfig, saveConfig } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { sync } from '../src/ingest/sync.js';
import { DEFAULT_INTENT, matchIntent, parseIntent, parseYaml } from '../src/compiler/intents.js';
import { phasesOf, renderTsProgram, Plan } from '../src/compiler/plan.js';
import { compileNodes, planSlots } from '../src/compiler/planner.js';
import { sampleBeta, score } from '../src/compiler/ranker.js';
import { instantiate, parseRecipe, resolveRecipe, upgradePlaybook } from '../src/compiler/recipes.js';
import { parsePlaybook } from '../src/pack/playbook.js';
import { listReceipts, recordFeedback } from '../src/compiler/receipts.js';
import { planOnly, resolve } from '../src/compiler/resolve.js';
import { CapabilityRecord } from '../src/capability/store.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-compiler-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const INTENT_YAML = `id: stock_analysis
title: 个股分析
match:
  keywords: ["分析", "怎么样"]
  patterns: ["行情|估值"]
  entityTypes: [organization]
slots:
  - id: canonical_identity
    required: true
    fill: local
    from: [entity]
  - id: latest_quote
    required: true
    fill: live
    capabilityKinds: [table]
    capabilityHints: ["quote", "bars"]
  - id: analyst_view
    required: true
    fill: live
    capabilityKinds: [table]
    capabilityHints: ["nothing-matches-this"]
budget:
  max_tool_calls: 3
guidance: |
  Quote the asOf with any live number.
`;

function capability(over: Partial<CapabilityRecord> = {}): CapabilityRecord {
  return {
    id: 'lake.daily_quotes', kind: 'table', sourceId: 'lake', name: 'daily_quotes', title: '日行情',
    dialect: 'sql', entityId: null, schema: { columns: [{ name: 'close', type: 'DOUBLE' }] },
    semantics: '', sampleQueries: [], pitfalls: [], joins: [],
    freshnessSeconds: null, cost: 1, placement: 'federate', notes: [], ...over,
  };
}

describe('intent specs', () => {
  it('parses a spec and explains why it matched', () => {
    const spec = parseIntent(INTENT_YAML, 'intents/stock.yaml')!;
    expect(spec.id).toBe('stock_analysis');
    expect(spec.budget.maxToolCalls).toBe(3);
    expect(spec.slots.map((s) => s.id)).toEqual(['canonical_identity', 'latest_quote', 'analyst_view']);
    expect(spec.slots[0]).toMatchObject({ fill: 'local', required: true });

    const match = matchIntent([spec], '帮我分析一下这家公司的行情', ['organization']);
    expect(match.intent.id).toBe('stock_analysis');
    expect(match.reasons).toEqual(expect.arrayContaining(['keyword "分析"', 'pattern /行情|估值/', 'entity type organization']));
  });

  it('falls back to the built-in intent, and survives an unparsable pattern', () => {
    const broken = parseIntent(`${INTENT_YAML}`.replace('patterns: ["行情|估值"]', 'patterns: ["[unclosed"]'), 'intents/broken.yaml')!;
    const match = matchIntent([broken], '完全无关的问题');
    expect(match.intent.id).toBe(DEFAULT_INTENT.id);
    expect(match.score).toBe(0);
    // a spec with no slots declares nothing and is not an intent
    expect(parseIntent('id: empty\n', 'intents/empty.yaml')).toBeNull();
    expect(parseYaml('a: 1\nb: [x]')).toEqual({ a: 1, b: ['x'] });
  });
});

describe('planner', () => {
  it('smooths the posterior toward a prior instead of trusting one call', () => {
    const stat = (attempts: number, used: number) => ({ intent: null, slot: 's', capability: 'c', attempts, used, ok: used, avgLatencyMs: 0, lastSeen: null });
    expect(score(undefined).mean).toBeCloseTo(0.6, 5);
    expect(score(stat(1, 1)).mean).toBeCloseTo(2.2 / 3, 5);
    expect(score(stat(1, 0)).mean).toBeCloseTo(1.2 / 3, 5);
    // enough evidence eventually overrides the prior
    expect(score(stat(100, 100)).mean).toBeGreaterThan(0.97);
  });

  it('prefers a bound, cheap, fresh capability and explains the choice', () => {
    const spec = parseIntent(INTENT_YAML, 'intents/stock.yaml')!;
    const quoteSlot = spec.slots.find((s) => s.id === 'latest_quote')!;
    const bound = capability({ id: 'lake.quotes', name: 'quotes' });
    const unbound = capability({ id: 'other.quotes_archive', sourceId: 'other', name: 'quotes_archive', cost: 5 });

    const candidates = planSlots({
      slots: [quoteSlot],
      capabilities: [unbound, bound],
      locators: [{ entityId: 'e', capabilityId: 'lake.quotes', param: 'symbol', value: '300750' }],
      filledLocally: new Set(),
      stats: new Map(),
      freshnessSeconds: null,
    });
    expect(candidates[0].capability!.id).toBe('lake.quotes');
    expect(candidates[0].reason).toContain('bound by symbol');
    // the unbound alternative is kept but scored below it
    expect(candidates[1].utility).toBeLessThan(candidates[0].utility);
  });

  it('penalizes a source staler than the caller asked for', () => {
    const spec = parseIntent(INTENT_YAML, 'intents/stock.yaml')!;
    const slot = spec.slots.find((s) => s.id === 'latest_quote')!;
    const fresh = capability({ id: 'a.quotes', sourceId: 'a', name: 'quotes', freshnessSeconds: 30 });
    const stale = capability({ id: 'b.quotes', sourceId: 'b', name: 'quotes', freshnessSeconds: 86400 });
    const locators = [
      { entityId: 'e', capabilityId: 'a.quotes', param: 'symbol', value: '1' },
      { entityId: 'e', capabilityId: 'b.quotes', param: 'symbol', value: '1' },
    ];
    const candidates = planSlots({ slots: [slot], capabilities: [stale, fresh], locators, filledLocally: new Set(), stats: new Map(), freshnessSeconds: 60 });
    expect(candidates[0].capability!.id).toBe('a.quotes');
  });

  it('reports what it cut rather than silently dropping it', () => {
    const spec = parseIntent(INTENT_YAML, 'intents/stock.yaml')!;
    const caps = ['q1', 'q2', 'q3'].map((n, i) => capability({ id: `s${i}.${n}`, sourceId: `s${i}`, name: `quotes_${n}` }));
    const slots = caps.map((_, i) => ({ ...spec.slots[1], id: `slot_${i}` }));
    const candidates = planSlots({
      slots,
      capabilities: caps,
      locators: caps.map((c) => ({ entityId: 'e', capabilityId: c.id, param: 'symbol', value: '1' })),
      filledLocally: new Set(),
      stats: new Map(),
      freshnessSeconds: null,
    });
    const { nodes, cut } = compileNodes(candidates, 1);
    expect(nodes).toHaveLength(1);
    expect(cut.length).toBeGreaterThan(0);
    expect(cut.some((c) => c.reason.includes('max_tool_calls'))).toBe(true);
  });
});

describe('plan rendering', () => {
  const plan: Plan = {
    planId: 'r_test', intent: 'x',
    budget: { maxToolCalls: 4, maxLatencyMs: 1000, maxTokens: 100 },
    slots: { required: [], optional: [], filledLocally: [] },
    nodes: [
      { id: 'a', fills: 'a', tool: { kind: 'mcp', name: 'knode_query' }, args: { source: 's', sql: 'SELECT 1' } },
      { id: 'b', fills: 'b', tool: { kind: 'mcp', name: 'knode_query' }, args: { source: 's', sql: 'SELECT 2' } },
      { id: 'c', fills: 'c', tool: { kind: 'mcp', name: 'knode_search' }, args: { query: 'x' }, after: ['a', 'b'] },
    ],
    render: 'json-graph',
  };

  it('groups independent nodes into one phase and dependents into the next', () => {
    expect(phasesOf(plan)).toEqual([['a', 'b'], ['c']]);
  });

  it('does not loop on a cycle or a dangling dependency', () => {
    const cyclic: Plan = { ...plan, nodes: [
      { id: 'a', fills: 'a', tool: { kind: 'mcp', name: 't' }, args: {}, after: ['b'] },
      { id: 'b', fills: 'b', tool: { kind: 'mcp', name: 't' }, args: {}, after: ['a'] },
    ] };
    expect(phasesOf(cyclic)).toEqual([['a', 'b']]);
    const dangling: Plan = { ...plan, nodes: [{ id: 'a', fills: 'a', tool: { kind: 'mcp', name: 't' }, args: {}, after: ['gone'] }] };
    expect(phasesOf(dangling)).toEqual([['a']]);
  });

  it('renders parallel phases as Promise.all in the program form', () => {
    const program = renderTsProgram(plan);
    expect(program).toContain('await Promise.all([');
    expect(program).toContain('filled["c"] = await tools.knode_search');
    expect(program).toContain('Budget (advisory)');
  });
});

describe('recipes', () => {
  it('reads a playbook as the recipe it always was', () => {
    const pb = parsePlaybook(`---
type: playbook
appliesTo: organization
retrieval: { k: 4, mode: keyword }
probes:
  - id: bars
    source: lake
    table: daily_quotes
    sql: "SELECT * FROM daily_quotes WHERE symbol = {symbol} LIMIT 3"
---
Guidance.
`, 'packs/organization.md')!;
    const recipe = upgradePlaybook(pb);
    expect(recipe.upgraded).toBe(true);
    expect(recipe.nodes.map((n) => n.fills)).toEqual(['background', 'bars']);
    expect(recipe.nodes[1].capability).toBe('lake.daily_quotes');

    const nodes = instantiate(recipe, { id: '宁德时代', name: '宁德时代', aliases: ['300750'] }, []);
    // a CJK entity id must not collapse the node id to a row of underscores
    expect(nodes[0].id).toMatch(/^kb_search_[0-9a-f]{8}$/);
    expect(nodes[1].args.sql).toContain("symbol = '300750'");
    expect(nodes[0].args.query).toBe('宁德时代');
  });

  it('picks the most specific recipe', () => {
    const mk = (appliesTo: string, intent = '') => ({ ...parseRecipe(`---\ntype: recipe\nappliesTo: ${appliesTo}\nintent: ${intent}\nnodes: []\n---\n`, `packs/${appliesTo}.md`)! });
    const recipes = [mk('default'), mk('organization'), mk('entity:catl')];
    expect(resolveRecipe(recipes, { intent: 'x', entityId: 'catl', entityType: 'organization' })!.appliesTo).toBe('entity:catl');
    expect(resolveRecipe(recipes, { intent: 'x', entityType: 'organization' })!.appliesTo).toBe('organization');
    expect(resolveRecipe(recipes, { intent: 'x' })!.appliesTo).toBe('default');
  });
});

describe('resolve: end to end', () => {
  const dataDir = path.join(tmp, 'resolve');
  let ctx: AppContext;

  afterAll(async () => {
    await ctx?.datasources.closeAll();
    await ctx?.store.close();
  });

  it('indexes a corpus with one live table behind it', async () => {
    initDataDir(dataDir);
    const lake = path.join(dataDir, 'lake');
    fs.mkdirSync(lake, { recursive: true });
    const instance = await DuckDBInstance.create(':memory:');
    const conn = await instance.connect();
    await conn.run(`CREATE TABLE quotes (symbol VARCHAR, trade_date DATE, close DOUBLE)`);
    await conn.run(`INSERT INTO quotes VALUES ('300750', DATE '2026-09-08', 243.68)`);
    await conn.run(`COPY quotes TO '${path.join(lake, 'quotes.parquet').replace(/'/g, "''")}' (FORMAT PARQUET)`);
    conn.disconnectSync();

    const config = loadConfig(dataDir);
    config.datasources = [{
      id: 'lake', kind: 'duckdb', path: 'lake', freshness: '1d',
      tables: [{ name: 'quotes', description: '日行情', entityColumns: [{ column: 'symbol', entityType: 'organization' }] }],
    }];
    saveConfig(dataDir, config);
    write(dataDir, 'intents/stock.yaml', INTENT_YAML);
    write(dataDir, 'raw/docs/catl.md', `---
title: 宁德时代研报
entities:
  - { name: 宁德时代, type: organization, aliases: ["300750"] }
---
# 宁德时代研报

宁德时代动力电池出货量全球第一。
`);

    ctx = await createContext(dataDir);
    expect((await sync(ctx, { llmGraph: false })).errors).toBe(0);
  });

  it('fills local slots itself and plans only what is left', async () => {
    const pack = await resolve(ctx, '分析一下宁德时代的行情', { record: false });
    expect(pack.version).toBe(2);
    expect(pack.intent.type).toBe('stock_analysis');
    expect(pack.intent.entities.map((e) => e.name)).toContain('宁德时代');

    const identity = pack.slots.find((s) => s.id === 'canonical_identity')!;
    expect(identity.filled).toBe(true);

    // the live slot is not filled locally — it becomes a plan node bound by locator
    const quoteNode = pack.plan.nodes.find((n) => n.fills === 'latest_quote');
    expect(quoteNode).toBeDefined();
    expect(quoteNode!.capability).toBe('lake.quotes');
    expect(String(quoteNode!.args.sql)).toContain("symbol = '300750'");
    expect(quoteNode!.why!.reason).toContain('bound by symbol');
  });

  it('reports a required slot nothing can fill instead of pretending', async () => {
    const pack = await resolve(ctx, '分析一下宁德时代的行情', { record: false });
    const unknown = pack.unknowns.find((u) => u.question.includes('analyst_view'));
    expect(unknown).toBeDefined();
    expect(unknown!.risk).toBe('high');
    expect(pack.slots.find((s) => s.id === 'analyst_view')!.filled).toBe(false);
  });

  it('honours the budget and says what it cut', async () => {
    const pack = await resolve(ctx, '分析一下宁德时代的行情', { record: false, budget: { maxToolCalls: 1 } });
    expect(pack.plan.nodes.length).toBeLessThanOrEqual(1);
    expect(pack.budgetReport.budget.maxToolCalls).toBe(1);
  });

  it('answers from an earlier state when asked, and carries the envelope into the pack', async () => {
    const { resolveTemporal } = await import('../src/store/resolver.js');
    const before = new Date(Date.now() - 60_000).toISOString();
    const pack = await resolve(ctx, '分析一下宁德时代的行情', {
      record: false,
      temporal: resolveTemporal({ asOf: before, freshness: '15m' }),
    });
    // nothing existed a minute before the sync, so there is no entity to ground on
    expect(pack.intent.entities).toHaveLength(0);
    expect(pack.applied.join(' ')).toContain('as_of');
  });

  it('writes a receipt, closes it with feedback, and lets the outcome move the ranking', async () => {
    // pin the exploration draw: the assertion below is about what feedback does
    // to the posterior, not about which way a random sample happened to land
    const rng = () => 0.5;
    const first = await resolve(ctx, '分析一下宁德时代的行情', { rng });
    expect(first.receiptId).toMatch(/^r_/);
    const node = first.plan.nodes.find((n) => n.fills === 'latest_quote')!;
    const before = node.why!.posterior!;

    const fed = await recordFeedback(ctx.store, {
      receiptId: first.receiptId,
      executed: [{ nodeId: node.id, slot: 'latest_quote', capability: 'lake.quotes', ok: true, rows: 1 }],
      usedIds: [node.id],
      outcome: 'answered',
    });
    expect(fed).toMatchObject({ recorded: true, revised: false });

    const second = await resolve(ctx, '分析一下宁德时代的行情', { record: false, rng });
    const after = second.plan.nodes.find((n) => n.fills === 'latest_quote')!.why!.posterior!;
    expect(after).toBeGreaterThan(before);

    const receipts = await listReceipts(ctx.store, { limit: 5 });
    expect(receipts.some((r) => r.id === first.receiptId && r.feedback_at !== null)).toBe(true);
    await expect(recordFeedback(ctx.store, { receiptId: 'r_nope' })).rejects.toThrow(/unknown receipt/);
  });

  it('keeps the pack_events view readable for the existing learning loop', async () => {
    const { buildContextPack } = await import('../src/pack/pack.js');
    await buildContextPack(ctx, '宁德时代怎么样');
    const rows = await ctx.store.query<{ utterance: string; doc_count: number }>(
      `SELECT utterance, doc_count FROM pack_events ORDER BY created_at DESC LIMIT 5`,
    );
    expect(rows.some((r) => r.utterance === '宁德时代怎么样')).toBe(true);
  });

  it('renders the plan as a program with the same nodes', async () => {
    const { plan, phases, program, sha } = await planOnly(ctx, '分析一下宁德时代的行情', { record: false, render: 'ts-program' });
    expect(phases.flat()).toEqual(plan.nodes.map((n) => n.id));
    expect(program).toContain('tools.knode_query');
    expect(sha).toMatch(/^[0-9a-f]{16}$/);
  });
});
