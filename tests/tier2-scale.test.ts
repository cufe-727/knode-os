import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { mergeSuggestionId } from '../src/graph/dedupe.js';
import { createApp } from '../src/server/app.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';
import { refineWiki } from '../src/wiki/refine.js';

/**
 * The nightly tier-2 pass (src/wiki/refine.ts) at the size of a real
 * workspace, with the server up. Its duplicate audits used to compare every
 * claim with every other claim of its subject, normalizing both statements
 * again each time, and every typed entity with every other, in long
 * synchronous stretches: on finance (2026-10-26: 499,865 claims, 10,171 of them
 * about A股; 51,349 typed entities) that held the event loop for over an hour a
 * night, /api/health timed out and files written meanwhile waited for the pass
 * to be indexed.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-tier2-scale-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('the tier-2 pass at scale', () => {
  let rootCtx: AppContext;
  let registry: WorkspaceContextRegistry;
  let ctx: AppContext;
  let server: Server;
  let base = '';
  // one subject with this many claims: 16 million pairs to compare one by one
  const n = 4000;
  // typed entities, none a prefix of another but one pair
  const organizations = 20_000;

  beforeAll(async () => {
    rootCtx = await createContext(path.join(tmp, 'root'));
    registry = new WorkspaceContextRegistry(rootCtx.dataDir, { templateConfig: rootCtx.config });
    const app = createApp(rootCtx, () => {}, registry);
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        base = `http://127.0.0.1:${info.port}`;
        resolve();
      }) as Server;
    });

    ctx = await createContext(path.join(tmp, 'ws'));
    const { store } = ctx;
    await store.query(
      `INSERT INTO entities (id, name, type, name_key)
       SELECT k, k, 'organization', k FROM (SELECT '公司' || lpad(g::text, 5, '0') AS k FROM generate_series(1, $1::int) AS g) AS t`,
      [organizations],
    );
    await store.query(
      `INSERT INTO entities (id, name, type, name_key) SELECT k, k, 'organization', k FROM unnest($1::text[]) AS k`,
      [['丙公司', '宁德时代', '宁德时代新能源科技']],
    );
    // claims about 丙公司 that share no wording and no figure, and four that do: two wordings
    // of one plan (identical once normalized) and one revenue figure rounded two ways. Each of
    // the n has three characters of its own, so it shares only the bigrams of 丙公司 with another.
    const own = (i: number) => String.fromCodePoint(...[0, 1, 2].map((k) => 0x4e00 + 3 * i + k));
    const statements = [
      ...Array.from({ length: n }, (_, i) => `丙公司${own(i)}`),
      '丙公司计划回购股份。', '丙公司 计划回购股份',
      '丙公司2025年营收36.19亿元', '丙公司全年收入36.2亿',
    ];
    await store.query(
      `INSERT INTO claims (id, subject_id, statement, evidence_count)
       SELECT 'claim-' || i, '丙公司', s, 1 FROM unnest($1::text[]) WITH ORDINALITY AS t(s, i)`,
      [statements],
    );
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await ctx?.datasources.closeAll();
    await ctx?.store.close();
    await registry?.closeAll();
    await rootCtx?.store.close();
  });

  it('keeps answering /api/health while it runs, and still finds the duplicates', async () => {
    // a health request always in flight, and a timer that notices any stretch the event loop was held
    let running = true;
    let answered = 0;
    let slowest = 0;
    const poll = (async () => {
      while (running) {
        const t0 = performance.now();
        const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(30_000) });
        expect(await res.json()).toMatchObject({ ok: true });
        slowest = Math.max(slowest, performance.now() - t0);
        answered++;
      }
    })();
    let tick = performance.now();
    let held = 0;
    const ticker = setInterval(() => {
      held = Math.max(held, performance.now() - tick);
      tick = performance.now();
    }, 10);

    const t0 = performance.now();
    const lines: string[] = [];
    const stats = await refineWiki(ctx.store, ctx.config, ctx.llm, { embedder: ctx.embedder, onProgress: (m) => lines.push(m) });
    const took = performance.now() - t0;
    held = Math.max(held, performance.now() - tick);
    clearInterval(ticker);
    running = false;
    await poll;

    // the two wordings merged, the rounded figures came up as a pair (no judge here to settle it),
    // the prefix as a merge suggestion
    expect(stats).toMatchObject({ claimsMerged: 1, mergeCandidates: 1 });
    expect(lines).toContain('claims: 1 merged, 0 merge suggestions, 0 contradictions (2 pairs, 0 judged)');
    const [suggestion] = await ctx.store.query<{ id: string }>(`SELECT id FROM suggestions WHERE kind = 'merge'`);
    expect(suggestion.id).toBe(mergeSuggestionId('宁德时代', '宁德时代新能源科技'));
    const [merged] = await ctx.store.query<{ statement: string; canonical: string }>(
      `SELECT c.statement, r.statement AS canonical FROM claims c JOIN claims r ON r.id = c.canonical_id`,
    );
    expect([merged.statement, merged.canonical].sort()).toEqual(['丙公司 计划回购股份', '丙公司计划回购股份。']);

    // Compared pair by pair this took minutes, all of them on the event loop. PGlite answers
    // queries on the event loop too, so here a run of queries holds it as well (a few hundred ms
    // in all); against a Postgres server every query hands it back.
    expect(answered).toBeGreaterThan(0);
    expect(slowest).toBeLessThan(2_000);
    expect(held).toBeLessThan(2_000);
    expect(took).toBeLessThan(15_000);
  });
});
