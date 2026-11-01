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

/**
 * The derivation reads the seeds' recent documents' own mention rows; this is
 * what it must equal — the same counts joined against every mention row.
 */
const JOIN_EVERY_MENTION = (among: boolean) => `
  WITH seed_docs AS (
    SELECT entity_id, document_id FROM (
      SELECT x.entity_id, x.document_id,
             row_number() OVER (PARTITION BY x.entity_id ORDER BY x.doc_date DESC NULLS LAST, x.updated_at DESC, x.document_id) AS rn
      FROM (
        SELECT DISTINCT m.entity_id, m.document_id, d.doc_date, d.updated_at
        FROM entity_mentions m JOIN documents d ON d.id = m.document_id
        WHERE m.entity_id = ANY($1::text[]) AND d.status = 'indexed'
      ) x
    ) recent
    WHERE rn <= $2
  ),
  seed AS (
    SELECT DISTINCT m.entity_id, m.chunk_id, m.document_id
    FROM seed_docs sd JOIN entity_mentions m ON m.entity_id = sd.entity_id AND m.document_id = sd.document_id
  ),
  by_chunk AS (
    SELECT s.entity_id AS source, o.entity_id AS target, count(DISTINCT s.chunk_id)::int AS chunks
    FROM seed s JOIN entity_mentions o ON o.chunk_id = s.chunk_id AND o.entity_id <> s.entity_id ${among ? 'AND o.entity_id = ANY($4::text[])' : ''}
    GROUP BY s.entity_id, o.entity_id
  ),
  by_document AS (
    SELECT s.entity_id AS source, o.entity_id AS target, count(DISTINCT s.document_id)::int AS documents
    FROM seed_docs s JOIN entity_mentions o ON o.document_id = s.document_id AND o.entity_id <> s.entity_id ${among ? 'AND o.entity_id = ANY($4::text[])' : ''}
    GROUP BY s.entity_id, o.entity_id
  ),
  scored AS (
    SELECT bd.source, bd.target, bd.documents, COALESCE(bc.chunks, 0) AS chunks,
           COALESCE(bc.chunks, 0) * ${CO_OCCURS_CHUNK_WEIGHT} + bd.documents * ${CO_OCCURS_DOCUMENT_WEIGHT} AS weight
    FROM by_document bd LEFT JOIN by_chunk bc ON bc.source = bd.source AND bc.target = bd.target
    JOIN entities e ON e.id = bd.target
    WHERE e.tx_to IS NULL
  ),
  ranked AS (
    SELECT source, target, chunks, documents, row_number() OVER (PARTITION BY source ORDER BY weight DESC, target) AS rn
    FROM scored
  )
  SELECT source, target, chunks, documents FROM ranked WHERE rn <= $3 ORDER BY source, rn`;

describe('derived co-occurrence, against every mention row', () => {
  const dataDir = path.join(tmp, 'ws-many');
  let ctx: AppContext;

  beforeAll(async () => {
    initDataDir(dataDir);
    // five dated reports on the same hubs, each over several chunks, so the
    // per-source document cap, the shared-chunk counts and the ranking all bite
    const cast = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'];
    for (let day = 1; day <= 5; day++) {
      const a = cast[day % cast.length];
      const b = cast[(day + 1) % cast.length];
      const c = cast[(day * 2) % cast.length];
      write(dataDir, `raw/docs/2026-10-0${day}-report.md`, `# report ${day}\n\n[[Alpha]] and [[${a}]] open it. ${filler('first')}\n\n${filler('second')} [[${b}]] and [[Hub]] close the middle.\n\n${filler('third')} [[Hub]], [[${c}]] and [[Alpha]] end it.\n`);
    }
    write(dataDir, 'raw/docs/undated.md', '# undated\n\n[[Hub]] with [[Omega]] and [[Alpha]], no date at all.\n');
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });
    await ctx.store.query(`UPDATE entities SET tx_to = now() WHERE id = 'omega'`);
  });
  afterAll(async () => {
    await ctx?.store.close();
  });

  it('counts and ranks exactly as the full join does, under every cap', async () => {
    const { store } = ctx;
    const [{ n }] = await store.query<{ n: number }>(`SELECT count(DISTINCT chunk_id)::int AS n FROM entity_mentions WHERE entity_id = 'hub'`);
    expect(n).toBeGreaterThanOrEqual(5);
    const cases: { seeds: string[]; maxDocuments?: number; perEntity?: number; among?: string[] }[] = [
      { seeds: ['alpha'] },
      { seeds: ['alpha', 'hub'] },
      { seeds: ['alpha', 'hub', 'beta'], maxDocuments: 2 },
      { seeds: ['hub'], maxDocuments: 1 },
      { seeds: ['alpha', 'hub'], perEntity: 2 },
      { seeds: ['alpha', 'hub', 'gamma'], among: ['beta', 'gamma', 'hub', 'omega'] },
      { seeds: ['alpha', 'hub'], maxDocuments: 3, perEntity: 3, among: ['alpha', 'hub', 'delta', 'zeta'] },
    ];
    for (const c of cases) {
      const params: unknown[] = [c.seeds, c.maxDocuments ?? 200, c.perEntity ?? 50];
      if (c.among) params.push(c.among);
      const expected = await store.query<{ source: string; target: string; chunks: number; documents: number }>(JOIN_EVERY_MENTION(Boolean(c.among)), params);
      const got = await coOccurringEntities(store, c.seeds, { maxDocuments: c.maxDocuments, perEntity: c.perEntity, among: c.among });
      expect(got.map(({ source, target, chunks, documents }) => ({ source, target, chunks, documents })), JSON.stringify(c))
        .toEqual(expected.map((r) => ({ source: r.source, target: r.target, chunks: Number(r.chunks), documents: Number(r.documents) })));
      expect(got.length, JSON.stringify(c)).toBeGreaterThan(0);
    }
  });
});
