import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { sync } from '../src/ingest/sync.js';
import { recordAbsence, liveAbsences } from '../src/compiler/absence.js';
import { clusterShapes, distillRecipes, renderRecipe, replay, safetyProblem, signatureOf } from '../src/compiler/distill.js';
import { evaluatePacks, writeEvalReport } from '../src/compiler/evaluate.js';
import { sampleBeta, score, writeRankerReport } from '../src/compiler/ranker.js';
import { changesSince, listSubscriptions, subscribe, unsubscribe } from '../src/compiler/subscribe.js';
import { checkout, commitWorkset, getWorkset, temporalFor } from '../src/compiler/workset.js';
import { parseRecipe } from '../src/compiler/recipes.js';
import { PlanNode } from '../src/compiler/plan.js';
import { aclAllows, intersectAcl, listDisputes, setScopeTrust, tierForActor } from '../src/lineage/trust.js';
import { resolveScopeFilter, resolveTemporal } from '../src/store/resolver.js';
import { search } from '../src/search/search.js';
import { queryClaims } from '../src/store/claims.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-learning-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Deterministic generator, so exploration is reproducible in tests. */
function seeded(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 0x100000000;
  };
}

describe('ranker', () => {
  it('separates the posterior from the draw, and keeps both explainable', () => {
    const stat = (attempts: number, used: number) =>
      ({ intent: null, slot: 's', capability: 'c', attempts, used, ok: used, avgLatencyMs: 0, lastSeen: null });

    const cold = score(undefined, seeded(1));
    expect(cold.mean).toBeCloseTo(0.6, 5);
    expect(cold.explain).toContain('never tried');

    // `used`, not `ok`, is the success signal: rows nobody keeps are not a win
    const responded = score(stat(10, 0), seeded(1));
    expect(responded.mean).toBeLessThan(0.2);
    expect(score(stat(10, 10), seeded(1)).mean).toBeGreaterThan(0.9);
    expect(score(stat(4, 3), seeded(1)).explain).toContain('3/4 kept');
  });

  it('draws inside [0,1] and concentrates as evidence accumulates', () => {
    const rng = seeded(7);
    const draws = Array.from({ length: 400 }, () => sampleBeta(1.2, 0.8, rng));
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...draws)).toBeLessThanOrEqual(1);

    const spread = (a: number, b: number) => {
      const g = seeded(3);
      const xs = Array.from({ length: 400 }, () => sampleBeta(a, b, g));
      const mean = xs.reduce((n, x) => n + x, 0) / xs.length;
      return Math.sqrt(xs.reduce((n, x) => n + (x - mean) ** 2, 0) / xs.length);
    };
    // a well-evidenced arm is drawn tightly; an untried one is drawn widely,
    // which is exactly what gives it the occasional chance to prove itself
    expect(spread(101.2, 0.8)).toBeLessThan(spread(1.2, 0.8));
  });
});

describe('trust, ACL and disputes', () => {
  const dataDir = path.join(tmp, 'trust');
  let ctx: AppContext;

  afterAll(async () => {
    await ctx?.store.close();
  });

  it('quarantines an agent write and leaves a human write trusted', async () => {
    expect(tierForActor('agent')).toBe('quarantined');
    expect(tierForActor('mcp:claude')).toBe('quarantined');
    expect(tierForActor('sync')).toBe('trusted');
    expect(tierForActor('user')).toBe('trusted');

    initDataDir(dataDir);
    write(dataDir, 'raw/docs/report.md', `---
title: 宁德时代研报
entities:
  - { name: 宁德时代, type: organization }
claims:
  - { subject: 宁德时代, type: earnings, statement: 2026Q2 净利润 120 亿元, status: fact, startDate: "2026-04-01" }
---
# 宁德时代研报

宁德时代动力电池全球第一。
`);
    ctx = await createContext(dataDir);
    expect((await sync(ctx, { llmGraph: false })).errors).toBe(0);

    const [trusted] = await ctx.store.query<{ trust: string }>(
      `SELECT trust FROM scopes WHERE key = 'raw/docs/report.md' AND status = 'active'`,
    );
    expect(trusted.trust).toBe('trusted');

    // now the same corpus gains an agent-written note
    write(dataDir, 'raw/docs/notes/agent.md', `---
title: agent 笔记
entities:
  - { name: 宁德时代, type: organization }
claims:
  - { subject: 宁德时代, type: earnings, statement: 2026Q2 净利润其实只有 60 亿元, status: fact, startDate: "2026-04-01" }
---
# agent 笔记

我推测利润被高估了。
`);
    await sync(ctx, { llmGraph: false, actor: 'agent' });
    const [note] = await ctx.store.query<{ trust: string }>(
      `SELECT trust FROM scopes WHERE key = 'raw/docs/notes/agent.md' AND status = 'active'`,
    );
    expect(note.trust).toBe('quarantined');
  });

  it('records a dispute instead of overwriting the trusted claim', async () => {
    const disputes = await listDisputes(ctx.store, { status: 'open' });
    expect(disputes.length).toBeGreaterThan(0);
    expect(disputes[0].reason).toContain('contradicts a trusted claim');
    // both claims are still there — nothing was silently replaced
    const claims = await queryClaims(ctx.store, { subject: '宁德时代', types: ['earnings'] });
    expect(claims.claims.length).toBe(2);
  });

  it('hides quarantined sources when the caller asks for trusted only', async () => {
    const all = await search(ctx.store, ctx.embedder, '宁德时代 利润', { k: 20, track: false });
    expect(all.some((r) => r.path.includes('notes/agent.md'))).toBe(true);

    const trustedOnly = await search(ctx.store, ctx.embedder, '宁德时代 利润', {
      k: 20,
      track: false,
      filter: resolveScopeFilter({ trust: 'trusted' }),
    });
    expect(trustedOnly.length).toBeGreaterThan(0);
    expect(trustedOnly.some((r) => r.path.includes('notes/agent.md'))).toBe(false);
    expect(resolveScopeFilter({ trust: 'trusted' }).notes).toContain('trust trusted only');
    expect(() => resolveScopeFilter({ trust: 'sort-of' })).toThrow(/unknown trust tier/);
  });

  it('promotes the note and resolves the disputes it opened', async () => {
    const before = await listDisputes(ctx.store, { status: 'open' });
    expect(before.length).toBeGreaterThan(0);

    const res = await setScopeTrust(ctx.store, { key: 'raw/docs/notes/agent.md', to: 'trusted', actor: 'user' });
    expect(res).toMatchObject({ from: 'quarantined', to: 'trusted' });
    expect(res.evidenceRows).toBeGreaterThan(0);
    expect(res.disputesResolved).toBe(before.length);
    expect(await listDisputes(ctx.store, { status: 'open' })).toHaveLength(0);

    const trustedOnly = await search(ctx.store, ctx.embedder, '宁德时代 利润', {
      k: 20, track: false, filter: resolveScopeFilter({ trust: 'trusted' }),
    });
    expect(trustedOnly.some((r) => r.path.includes('notes/agent.md'))).toBe(true);
  });

  it('intersects ACLs rather than unioning them, and treats empty as unrestricted', () => {
    expect(intersectAcl([[], []])).toEqual([]);
    // an unrestricted input must not wash out a restriction
    expect(intersectAcl([[], ['alice']])).toEqual(['alice']);
    expect(intersectAcl([['alice', 'bob'], ['bob', 'carol']])).toEqual(['bob']);
    expect(intersectAcl([['alice'], ['bob']])).toEqual([]);

    expect(aclAllows([], 'anyone')).toBe(true);
    expect(aclAllows(['alice'], 'alice')).toBe(true);
    expect(aclAllows(['alice'], 'bob')).toBe(false);
    // "who is asking" being unknown is not the same as "anyone may read this"
    expect(aclAllows(['alice'], undefined)).toBe(false);
    expect(aclAllows(['*'], 'anyone')).toBe(true);
  });
});

describe('negative knowledge', () => {
  const dataDir = path.join(tmp, 'absence');
  let ctx: AppContext;

  afterAll(async () => {
    await ctx?.store.close();
  });

  it('records an empty lookup with an expiry, and stops believing it after', async () => {
    initDataDir(dataDir);
    write(dataDir, 'raw/docs/a.md', `---
title: 宁德时代
entities:
  - { name: 宁德时代, type: organization }
---
# 宁德时代
`);
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });

    await recordAbsence(ctx.store, {
      capabilityId: 'sec.filings', entityId: '宁德时代', param: 'symbol', value: '300750', ttlSeconds: 3600,
    });
    const live = await liveAbsences(ctx.store, ['宁德时代']);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ capabilityId: 'sec.filings', param: 'symbol', value: '300750' });
    expect(live[0].statement).toContain('returned nothing');

    // "nothing there" is true of a moment: past the window it stops being believed
    const later = new Date(Date.now() + 7200_000).toISOString();
    expect(await liveAbsences(ctx.store, ['宁德时代'], later)).toHaveLength(0);
  });

  it('supersedes an earlier observation instead of accumulating', async () => {
    await recordAbsence(ctx.store, {
      capabilityId: 'sec.filings', entityId: '宁德时代', param: 'symbol', value: '300750', ttlSeconds: 7200,
    });
    expect(await liveAbsences(ctx.store, ['宁德时代'])).toHaveLength(1);
    const scopes = await ctx.store.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM scopes WHERE kind = 'absence' AND status = 'active'`,
    );
    expect(scopes[0].n).toBe(1);
  });
});

describe('worksets', () => {
  const dataDir = path.join(tmp, 'workset');
  let ctx: AppContext;

  afterAll(async () => {
    await ctx?.store.close();
  });

  it('pins a system time and hands it to every read that names it', async () => {
    initDataDir(dataDir);
    write(dataDir, 'raw/docs/a.md', '# a\n\ncontent\n');
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });

    const ws = await checkout(ctx.store, { actor: 'agent', note: '尽调宁德时代' });
    expect(ws.id).toMatch(/^w_/);

    const pinned = await temporalFor(ctx.store, ws.id, resolveTemporal({}));
    expect(pinned.txTime).toBe(ws.asOf);
    expect(pinned.notes.join(' ')).toContain(`workset ${ws.id} pinned`);

    // an explicit as_of still wins: a workset is a default, not a cage
    const override = await temporalFor(ctx.store, ws.id, resolveTemporal({ asOf: '2026-01-01' }));
    expect(override.txTime).toBe('2026-01-01T00:00:00.000Z');

    await expect(temporalFor(ctx.store, 'w_nope', resolveTemporal({}))).rejects.toThrow(/unknown workset/);
  });

  it('commits conclusions back as an ordinary source, quarantined like any agent write', async () => {
    const ws = await checkout(ctx.store, { actor: 'agent', note: '结论' });
    const res = await commitWorkset(ctx, { worksetId: ws.id, content: '宁德时代的结论是……', title: '尽调结论' });
    expect(res.path).toBe(`raw/docs/notes/${ws.id}.md`);
    expect(fs.readFileSync(path.join(dataDir, res.path), 'utf8')).toContain('尽调结论');
    expect(res.workset.closedAt).not.toBeNull();

    await sync(ctx, { llmGraph: false, actor: 'agent' });
    const [scope] = await ctx.store.query<{ trust: string }>(
      `SELECT trust FROM scopes WHERE key = $1 AND status = 'active'`,
      [`raw/docs/notes/${ws.id}.md`],
    );
    expect(scope.trust).toBe('quarantined');

    // a committed workset cannot be reused: check out a new one
    await expect(commitWorkset(ctx, { worksetId: ws.id, content: 'again' })).rejects.toThrow(/already committed/);
    expect((await getWorkset(ctx.store, ws.id))!.commitPath).toBe(res.path);
  });
});

describe('subscriptions', () => {
  const dataDir = path.join(tmp, 'subs');
  let ctx: AppContext;

  afterAll(async () => {
    await ctx?.store.close();
  });

  it('reports what changed since the cursor, and only advances when asked', async () => {
    initDataDir(dataDir);
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });

    const sub = await subscribe(ctx.store, { kind: 'entity', target: '宁德时代', actor: 'agent' });
    expect((await changesSince(ctx.store, sub.id)).changes).toHaveLength(0);

    await new Promise((r) => setTimeout(r, 20));
    write(dataDir, 'raw/docs/new.md', `---
title: 宁德时代快讯
entities:
  - { name: 宁德时代, type: organization }
claims:
  - { subject: 宁德时代, type: news, statement: 新增产能, status: fact }
---
# 快讯
`);
    await sync(ctx, { llmGraph: false });

    // peek leaves the cursor where it was, so a crash mid-handling loses nothing
    const peeked = await changesSince(ctx.store, sub.id, { advance: false });
    expect(peeked.changes.length).toBeGreaterThan(0);
    const again = await changesSince(ctx.store, sub.id, { advance: false });
    expect(again.changes.length).toBe(peeked.changes.length);

    const consumed = await changesSince(ctx.store, sub.id);
    expect(consumed.changes.length).toBe(peeked.changes.length);
    expect((await changesSince(ctx.store, sub.id)).changes).toHaveLength(0);

    expect(await listSubscriptions(ctx.store, 'agent')).toHaveLength(1);
    expect(await unsubscribe(ctx.store, sub.id)).toBe(true);
    await expect(changesSince(ctx.store, sub.id)).rejects.toThrow(/unknown subscription/);
  });

  it('watches a source prefix for applies and disposes', async () => {
    const sub = await subscribe(ctx.store, { kind: 'source', target: 'raw/docs', actor: 'ops' });
    await new Promise((r) => setTimeout(r, 20));
    fs.rmSync(path.join(dataDir, 'raw/docs/new.md'));
    await sync(ctx, { llmGraph: false });

    const { changes } = await changesSince(ctx.store, sub.id);
    expect(changes.some((c) => c.summary.includes('disposed'))).toBe(true);
  });
});

describe('distillation and evaluation', () => {
  const dataDir = path.join(tmp, 'distill');
  let ctx: AppContext;

  const nodes: PlanNode[] = [
    { id: 'quote_lake', fills: 'latest_quote', capability: 'lake.quotes', tool: { kind: 'mcp', name: 'knode_query' }, args: { source: 'lake', sql: "SELECT * FROM quotes WHERE symbol = '300750' LIMIT 20" } },
    { id: 'bg_knode', fills: 'background', capability: 'knode.search', tool: { kind: 'mcp', name: 'knode_search' }, args: { query: '宁德时代', k: 6 } },
  ];

  afterAll(async () => {
    await ctx?.store.close();
  });

  async function seedReceipt(id: string, opts: { used: boolean; outcome?: string }): Promise<void> {
    await ctx.store.query(
      `INSERT INTO receipts (id, kind, query, intent, plan, calls, used_ids, outcome, summary, feedback_at)
       VALUES ($1, 'resolve', '分析宁德时代', 'stock_analysis', $2::jsonb, $3::jsonb, $4::jsonb, $5, $6::jsonb, now())`,
      [
        id,
        JSON.stringify({ planId: id, intent: 'stock_analysis', nodes, budget: {}, slots: { required: ['latest_quote', 'background'], optional: [], filledLocally: [] }, render: 'json-graph' }),
        JSON.stringify(nodes.map((n) => ({ nodeId: n.id, slot: n.fills, capability: n.capability, ok: true, rows: 3 }))),
        JSON.stringify(opts.used ? nodes.map((n) => n.id) : []),
        opts.outcome ?? 'answered',
        JSON.stringify({ docCount: 4, claimCount: 1, staleCount: 0, conflictCount: 0 }),
      ],
    );
  }

  it('refuses to distil a shape that has not proven itself', async () => {
    initDataDir(dataDir);
    ctx = await createContext(dataDir);
    await seedReceipt('r_one', { used: true });

    const shapes = await clusterShapes(ctx.store);
    expect(shapes).toHaveLength(1);
    expect(shapes[0].signature).toBe(signatureOf(nodes));

    const result = await replay(ctx.store, shapes[0]);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('need 3');
    expect((await distillRecipes(ctx.store)).suggestions).toHaveLength(0);
  });

  it('refuses a shape whose calls nobody keeps, however often it ran', async () => {
    for (const id of ['r_a', 'r_b', 'r_c']) await seedReceipt(id, { used: false, outcome: 'partial' });
    const shapes = await clusterShapes(ctx.store);
    const result = await replay(ctx.store, shapes[0]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/of its calls were kept/);
  });

  it('proposes a recipe once the shape has a record, but never publishes it', async () => {
    for (const id of ['r_d', 'r_e', 'r_f', 'r_g']) await seedReceipt(id, { used: true });
    const res = await distillRecipes(ctx.store);
    expect(res.suggestions).toHaveLength(1);
    const s = res.suggestions[0];
    expect(s.kind).toBe('recipe');
    expect(s.status).toBe('pending');

    // the file is proposed, not written: publishing is a human decision
    expect(fs.existsSync(path.join(dataDir, s.payload!.path))).toBe(false);
    const recipe = parseRecipe(s.payload!.content, s.payload!.path)!;
    expect(recipe.intent).toBe('stock_analysis');
    expect(recipe.nodes.map((n) => n.fills).sort()).toEqual(['background', 'latest_quote']);
    // the bound value is generalized back to a placeholder
    expect(String(recipe.nodes.find((n) => n.fills === 'latest_quote')!.args.sql)).toContain('{locator}');
    expect(String(recipe.nodes.find((n) => n.fills === 'latest_quote')!.args.sql)).not.toContain('300750');
  });

  it('rejects a candidate that would run anything but a read', () => {
    expect(safetyProblem(nodes)).toBeNull();
    const bad: PlanNode[] = [{ ...nodes[0], args: { source: 'lake', sql: 'DELETE FROM quotes' } }];
    expect(safetyProblem(bad)).toMatch(/non-read-only/);
    const shape = { intent: 'x', signature: 'y', nodes: bad, receiptIds: [], successes: 5, attempts: 5 };
    expect(renderRecipe(shape, { shape, precision: 1, coverage: 1, ok: true, reason: '' })).toContain('type: recipe');
  });

  it('measures precision as used over returned, and names capabilities nobody keeps', async () => {
    const report = await evaluatePacks(ctx.store);
    expect(report.totals.resolves).toBe(8);
    expect(report.totals.reported).toBe(8);
    // 5 of 8 receipts kept both calls; 3 kept none
    expect(report.totals.precision).toBeCloseTo(10 / 16, 5);
    expect(report.byIntent[0].intent).toBe('stock_analysis');
    expect(report.byIntent[0].slotCoverage).toBe(1);

    const rel = writeEvalReport(dataDir, report);
    const page = fs.readFileSync(path.join(dataDir, rel), 'utf8');
    expect(page).toContain('Context pack evaluation');
    expect(page).toContain('63%');

    const ranking = await writeRankerReport(ctx.store);
    expect(ranking.rows.map((r) => r.capability).sort()).toEqual(['knode.search', 'lake.quotes']);
    expect(fs.readFileSync(path.join(dataDir, ranking.path), 'utf8')).toContain('Capability ranking');
  });
});
