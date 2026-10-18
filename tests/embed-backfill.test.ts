import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { EmbeddingBackfill, pendingEmbeddings } from '../src/ingest/embed-backfill.js';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import { sync } from '../src/ingest/sync.js';
import { findLiveScope } from '../src/lineage/scope.js';
import { search } from '../src/search/search.js';

/**
 * Embedding after indexing (src/ingest/embed-backfill.ts): under `serve` a
 * document is applied — chunks, keyword index, graph — without waiting for
 * vectors, and a background pass embeds what is missing. A provider that
 * cannot serve (a spent daily quota) leaves chunks pending instead of the
 * document unindexed.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-embed-backfill-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

async function eventually(check: () => Promise<boolean>, label: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Counts calls; fails them all while `down` is set, the way a pool with a spent quota does. */
class SwitchableEmbedder implements EmbeddingProvider {
  calls = 0;
  down = false;
  constructor(private readonly inner: EmbeddingProvider) {}
  get model() { return this.inner.model; }
  get dimensions() { return this.inner.dimensions; }
  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    if (this.down) throw new Error('Embedding pool unavailable: every key: daily quota reached');
    return this.inner.embed(texts);
  }
}

const REPORT = (n: number) => `---
title: 宁德时代研报 ${n}
---
# 宁德时代研报 ${n}

宁德时代与比亚迪在动力电池市场竞争，动力电池出货量全球第一。第 ${n} 份报告讨论储能业务与海外工厂的产能爬坡。
`;

describe('embedding after indexing', () => {
  const dataDir = path.join(tmp, 'ws');
  let ctx: AppContext;
  let embedder: SwitchableEmbedder;
  let backfill: EmbeddingBackfill;
  const vectors = async (key: string) =>
    (await ctx.store.query<{ n: number }>(
      `SELECT count(e.chunk_id)::int AS n FROM chunks c JOIN documents d ON d.id = c.document_id LEFT JOIN embeddings e ON e.chunk_id = c.id WHERE d.path = $1`,
      [key],
    ))[0].n;
  const chunks = async (key: string) =>
    (await ctx.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = $1`, [key]))[0].n;

  beforeAll(async () => {
    initDataDir(dataDir);
    ctx = await createContext(dataDir);
    embedder = new SwitchableEmbedder(ctx.embedder);
    ctx.embedder = embedder;
    // driven by hand here; serve starts it and lets every sync kick it
    backfill = new EmbeddingBackfill(ctx, { batch: 4, concurrency: 2, retryMs: 1000 });
    ctx.embeddings = backfill;
  });
  afterAll(async () => {
    await backfill.stop();
    await ctx?.store.close();
  });

  it('indexes a document without waiting for its vectors, and embeds it afterwards', async () => {
    write(dataDir, 'raw/docs/a.md', REPORT(1));
    const stats = await sync(ctx, { llmGraph: false });
    expect(stats.errors).toBe(0);
    expect(await findLiveScope(ctx.store, 'doc', 'raw/docs/a.md')).not.toBeNull();
    expect(await chunks('raw/docs/a.md')).toBeGreaterThan(0);
    expect(await vectors('raw/docs/a.md')).toBe(0);
    expect(embedder.calls).toBe(0);
    // searchable by keyword at once
    const kw = await search(ctx.store, embedder, '储能业务', { k: 5, mode: 'keyword', track: false });
    expect(kw.map((h) => h.path)).toContain('raw/docs/a.md');

    while ((await backfill.runOnce()) !== 0) { /* until nothing is missing */ }
    expect(await vectors('raw/docs/a.md')).toBe(await chunks('raw/docs/a.md'));
    expect(await pendingEmbeddings(ctx.store, embedder.model)).toBe(0);
    const vec = await search(ctx.store, embedder, '宁德时代研报 1 储能业务', { k: 5, mode: 'vector', track: false });
    expect(vec.map((h) => h.path)).toContain('raw/docs/a.md');
  });

  it('leaves chunks pending, not the document unindexed, while the provider cannot serve', async () => {
    embedder.down = true;
    write(dataDir, 'raw/docs/b.md', REPORT(2));
    const stats = await sync(ctx, { llmGraph: false });
    expect(stats.errors).toBe(0);
    expect(stats.applied).toBeGreaterThanOrEqual(1);
    expect(await findLiveScope(ctx.store, 'doc', 'raw/docs/b.md')).not.toBeNull();
    const [doc] = await ctx.store.query<{ status: string }>(`SELECT status FROM documents WHERE path = 'raw/docs/b.md'`);
    expect(doc.status).toBe('indexed');

    expect(await backfill.runOnce()).toBeNull();
    expect(backfill.status().lastError).toMatch(/daily quota/);
    expect(await vectors('raw/docs/b.md')).toBe(0);

    embedder.down = false;
    while ((await backfill.runOnce()) !== 0) { /* the quota is back */ }
    expect(await vectors('raw/docs/b.md')).toBe(await chunks('raw/docs/b.md'));
  });

  it('still answers a hybrid search when the query itself cannot be embedded', async () => {
    embedder.down = true;
    try {
      const hits = await search(ctx.store, embedder, '储能业务', { k: 5, mode: 'hybrid', track: false });
      expect(hits.map((h) => h.path)).toContain('raw/docs/a.md');
      await expect(search(ctx.store, embedder, '储能业务', { k: 5, mode: 'vector', track: false })).rejects.toThrow(/daily quota/);
    } finally {
      embedder.down = false;
    }
  });

  it('skips a chunk whose document went while its vector was computed', async () => {
    write(dataDir, 'raw/docs/c.md', REPORT(3));
    await sync(ctx, { llmGraph: false });
    const pending = await pendingEmbeddings(ctx.store, embedder.model);
    expect(pending).toBeGreaterThan(0);
    const inner = ctx.embedder;
    ctx.embedder = {
      model: inner.model,
      dimensions: inner.dimensions,
      embed: async (texts: string[]) => {
        await ctx.store.query(`DELETE FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE path = 'raw/docs/c.md')`);
        return inner.embed(texts);
      },
    };
    try {
      expect(await backfill.runOnce()).toBe(0);
    } finally {
      ctx.embedder = inner;
    }
    expect(await pendingEmbeddings(ctx.store, embedder.model)).toBe(0);
  });

  it('is kicked as each document is applied, not only when a long pass ends', async () => {
    const kicks: number[] = [];
    const saved = ctx.embeddings;
    ctx.embeddings = { kick: () => kicks.push(Date.now()) };
    try {
      for (let i = 10; i < 13; i++) write(dataDir, `raw/docs/batch/r${i}.md`, REPORT(i));
      const stats = await sync(ctx, { llmGraph: false, only: ['raw/docs/batch'] });
      expect(stats.applied).toBe(3);
      // one kick per applied document, and one more as the pass ends
      expect(kicks.length).toBeGreaterThanOrEqual(4);
    } finally {
      ctx.embeddings = saved;
    }
    while ((await backfill.runOnce()) !== 0) { /* leave nothing pending for the next case */ }
  });

  it('works through what is pending on its own once started, and picks up what a sync adds', async () => {
    backfill.start();
    write(dataDir, 'raw/docs/d.md', REPORT(4));
    await sync(ctx, { llmGraph: false }); // kicks the running pass
    await eventually(async () => (await vectors('raw/docs/d.md')) > 0 && (await pendingEmbeddings(ctx.store, embedder.model)) === 0, 'd.md to be embedded');
    await backfill.stop();
    expect(backfill.status().running).toBe(false);
  });
});
