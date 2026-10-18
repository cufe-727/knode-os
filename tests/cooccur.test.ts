import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { CO_OCCURS_CHUNK_WEIGHT, CO_OCCURS_DOCUMENT_WEIGHT, coOccurringEntities } from '../src/graph/cooccur.js';
import { graphInsights, graphOverview, graphSearch } from '../src/graph/query.js';
import { sync } from '../src/ingest/sync.js';
import { resolveScopeFilter } from '../src/store/resolver.js';

/**
 * Co-occurrence is derived from entity_mentions at read time (src/graph/cooccur.ts),
 * never stored as relation rows: two entities sharing a chunk score above two
 * sharing only a document, graph reads use it as the weak signal the stored
 * co_occurs edges used to be, and it goes with the source that carried the
 * mentions.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-cooccur-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// lowercase prose gives the tier-0 concept miner nothing to pick up, and two
// paragraphs of it are more than one 1200-character chunk holds
const filler = (word: string) =>
  Array.from({ length: 8 }, (_, i) => `${word} paragraph sentence number ${i} keeps going about nothing in particular until the chunker has to break somewhere.`).join(' ');

const REPORT = `# alpha report

[[Alpha]] works with [[Gamma]] on the first topic. ${filler('first')}

${filler('second')} The second topic closes with [[Beta]].
`;

describe('derived co-occurrence', () => {
  const dataDir = path.join(tmp, 'ws');
  let ctx: AppContext;

  beforeAll(async () => {
    initDataDir(dataDir);
    write(dataDir, 'raw/docs/a.md', REPORT);
    write(dataDir, 'raw/docs/lonely.md', '# lonely\n\n[[Delta]] stands alone in this note.\n');
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });
  });
  afterAll(async () => {
    await ctx?.store.close();
  });

  it('scores a shared chunk above a shared document, and stores no co_occurs rows', async () => {
    const { store } = ctx;
    expect(await store.query(`SELECT id FROM relations WHERE type = 'co_occurs'`)).toEqual([]);
    const [{ n: chunks }] = await store.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = 'raw/docs/a.md'`,
    );
    expect(chunks).toBeGreaterThanOrEqual(2);

    const co = await coOccurringEntities(store, ['alpha']);
    expect(co.map((x) => x.target)).toEqual(['gamma', 'beta']);
    const [gamma, beta] = co;
    expect(gamma).toMatchObject({ source: 'alpha', documents: 1, chunks: 1, weight: CO_OCCURS_CHUNK_WEIGHT + CO_OCCURS_DOCUMENT_WEIGHT });
    expect(beta).toMatchObject({ source: 'alpha', documents: 1, chunks: 0, weight: CO_OCCURS_DOCUMENT_WEIGHT });
    expect(gamma.weight).toBeGreaterThan(beta.weight);

    // restricted to a target set, capped per source, and the same pair from the other side
    expect((await coOccurringEntities(store, ['alpha'], { among: ['beta'] })).map((x) => x.target)).toEqual(['beta']);
    expect((await coOccurringEntities(store, ['alpha'], { perEntity: 1 })).map((x) => x.target)).toEqual(['gamma']);
    expect((await coOccurringEntities(store, ['beta'])).find((x) => x.target === 'alpha')).toMatchObject({ documents: 1, chunks: 0 });
    expect(await coOccurringEntities(store, [])).toEqual([]);
  });

  it("expands graph search at half a typed edge's gain, strongest pair first", async () => {
    const res = await graphSearch(ctx.store, 'Alpha', { depth: 1, track: false });
    const byId = new Map(res.nodes.map((n) => [n.id, n]));
    expect(byId.get('alpha')?.score).toBe(2);
    const gamma = byId.get('gamma');
    const beta = byId.get('beta');
    expect(gamma).toBeDefined();
    expect(beta).toBeDefined();
    // base 2 × hop decay 0.5 × min(1, w / 2 + 0.5) × co_occurs discount 0.5
    expect(gamma!.score).toBeCloseTo(2 * 0.5 * (0.5 / 2 + 0.5) * 0.5, 6);
    expect(beta!.score).toBeCloseTo(2 * 0.5 * (0.2 / 2 + 0.5) * 0.5, 6);
    const co = res.edges.filter((e) => e.type === 'co_occurs');
    expect(co.map((e) => `${e.source}|${e.target}`).sort()).toEqual(['alpha|beta', 'alpha|gamma']);
    expect(co.find((e) => e.target === 'gamma')).toMatchObject({ weight: 0.5, description: '1 shared document, 1 shared chunk' });
  });

  it('draws each pair once in the overview and keeps a mention-only entity out of the isolated list', async () => {
    const overview = await graphOverview(ctx.store);
    const pairs = overview.edges.filter((e) => e.type === 'co_occurs').map((e) => `${e.source}|${e.target}`);
    expect(pairs).toEqual(expect.arrayContaining(['alpha|beta', 'alpha|gamma', 'beta|gamma']));
    expect(new Set(pairs).size).toBe(pairs.length);

    const insights = await graphInsights(ctx.store);
    const isolated = insights.isolated.map((e) => e.id);
    expect(isolated).toContain('delta');
    for (const id of ['alpha', 'beta', 'gamma']) {
      expect(isolated).not.toContain(id);
      expect(insights.hubs.map((h) => h.id)).not.toContain(id);
    }
  });

  it('follows the mentions: another source raises it, as_of and source filters see their documents only, a removed source takes it away', async () => {
    const { store } = ctx;
    await sleep(20);
    const beforeB = new Date().toISOString();
    await sleep(20);
    write(dataDir, 'raw/docs/b.md', '# beta note\n\n[[Alpha]] and [[Beta]] together in one paragraph.\n');
    await sync(ctx, { llmGraph: false });

    const now = await coOccurringEntities(store, ['alpha']);
    expect(now.map((x) => x.target)).toEqual(['beta', 'gamma']);
    expect(now[0]).toMatchObject({ documents: 2, chunks: 1, weight: Number((CO_OCCURS_CHUNK_WEIGHT + 2 * CO_OCCURS_DOCUMENT_WEIGHT).toFixed(4)) });

    // as_of: b.md was not live yet
    const then = await coOccurringEntities(store, ['alpha'], { asOf: beforeB });
    expect(then.find((x) => x.target === 'beta')).toMatchObject({ documents: 1, chunks: 0 });

    // a source filter counts only the documents that pass it
    const onlyB = await coOccurringEntities(store, ['alpha'], { filter: resolveScopeFilter({ sources: ['raw/docs/b.md'] }) });
    expect(onlyB).toEqual([expect.objectContaining({ target: 'beta', documents: 1, chunks: 1 })]);

    fs.rmSync(path.join(dataDir, 'raw/docs/b.md'));
    await sync(ctx, { llmGraph: false });
    expect((await coOccurringEntities(store, ['alpha'])).find((x) => x.target === 'beta')).toMatchObject({ documents: 1, chunks: 0 });
  });
});
