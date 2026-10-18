import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { readSidecarPart, updateSidecarPart } from '../src/fs/sidecar.js';
import { applyDocScope, documentIdFor } from '../src/ingest/apply.js';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import { sync } from '../src/ingest/sync.js';
import { findLiveScope } from '../src/lineage/scope.js';

/**
 * `knode-os sync --reapply`: documents whose content is unchanged are applied
 * again — tier-0 recomputed, tier-1 replayed from the sidecar — while their
 * content-addressed chunks keep their vectors, nothing is embedded when the
 * CLI defers embeddings to the server, and no new extraction is queued for a
 * document the model has already read.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-reapply-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

class CountingEmbedder implements EmbeddingProvider {
  calls = 0;
  constructor(private readonly inner: EmbeddingProvider) {}
  get model() {
    return this.inner.model;
  }
  get dimensions() {
    return this.inner.dimensions;
  }
  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    return this.inner.embed(texts);
  }
}

const DOC_A = `---
title: 甲
---
# 甲

宁德时代的动力电池出货量全球第一，动力电池价格下行；宁德时代与比亚迪在储能电池上竞争，储能电池的毛利更高。
`;

const DOC_B = `---
title: 乙
---
# 乙

比亚迪的刀片电池和宁德时代的麒麟电池是两条路线；刀片电池成本更低，麒麟电池能量密度更高。
`;

describe('sync --reapply', () => {
  const dataDir = path.join(tmp, 'ws');
  const A = 'raw/docs/a.md';
  const B = 'raw/docs/b.md';
  let ctx: AppContext;
  let embedder: CountingEmbedder;

  const count = async (sql: string, params: unknown[] = []) => {
    const [row] = await ctx.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params);
    return row.n;
  };
  const scopeId = async (key: string) => (await findLiveScope(ctx.store, 'doc', key))!.id;
  const vectorsOf = (key: string) => count(`embeddings e JOIN chunks c ON c.id = e.chunk_id WHERE c.document_id = $1`, [documentIdFor(key)]);
  const chunksOf = (key: string) => count(`chunks WHERE document_id = $1`, [documentIdFor(key)]);

  beforeAll(async () => {
    initDataDir(dataDir);
    write(dataDir, A, DOC_A);
    write(dataDir, B, DOC_B);
    ctx = await createContext(dataDir);
    embedder = new CountingEmbedder(ctx.embedder);
    ctx.embedder = embedder;
    await sync(ctx, { llmGraph: false });
  });

  afterAll(async () => {
    await ctx?.datasources.closeAll();
    await ctx?.store.close();
  });

  it('applies unchanged documents again without asking for their vectors', async () => {
    const before = { a: await scopeId(A), b: await scopeId(B), vectors: await count('embeddings'), chunks: await count('chunks') };
    expect(before.vectors).toBe(before.chunks);
    embedder.calls = 0;

    const stats = await sync(ctx, { llmGraph: false, reapply: true });
    // every declared source in scope is applied again (the seeded wiki pages included), none is skipped as unchanged
    expect(stats.applied).toBeGreaterThanOrEqual(2);
    expect(stats.unchanged).toBe(0);
    // the chunks are content-addressed: same ids, vectors still there, nothing embedded
    expect(embedder.calls).toBe(0);
    expect(await count('chunks')).toBe(before.chunks);
    expect(await count('embeddings')).toBe(before.vectors);
    // each document has a new live scope, the old one was replaced, and tier-0 evidence was written afresh
    const after = { a: await scopeId(A), b: await scopeId(B) };
    expect(after.a).not.toBe(before.a);
    expect(after.b).not.toBe(before.b);
    expect(await count(`scopes WHERE id = $1 AND status = 'disposed' AND meta ->> 'reason' = 'replaced'`, [before.a])).toBe(1);
    expect(await count(`documents WHERE path = $1 AND status = 'indexed'`, [A])).toBe(1);
    expect(await count(`evidence WHERE scope_id = $1 AND extractor = 'tier0.concept' AND tx_to IS NULL`, [after.a])).toBeGreaterThan(0);
    expect(await count(`evidence WHERE scope_id = $1 AND tx_to IS NULL`, [before.a])).toBe(0);
  });

  it('combines with --only and leaves the other documents alone', async () => {
    const a = await scopeId(A);
    const b = await scopeId(B);
    const stats = await sync(ctx, { llmGraph: false, reapply: true, only: [A] });
    expect(stats.scanned).toBe(1);
    expect(stats.applied).toBe(1);
    expect(await scopeId(A)).not.toBe(a);
    expect(await scopeId(B)).toBe(b);
  });

  it('leaves missing vectors to the server when embeddings are deferred, as the CLI does', async () => {
    // vectors a background backfill has not written yet
    await ctx.store.query(`DELETE FROM embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = $1)`, [documentIdFor(B)]);
    expect(await vectorsOf(B)).toBe(0);
    embedder.calls = 0;
    await sync({ ...ctx, embeddings: { kick() {} } }, { llmGraph: false, reapply: true, only: [B] });
    expect(embedder.calls).toBe(0);
    expect(await vectorsOf(B)).toBe(0);
    expect(await chunksOf(B)).toBeGreaterThan(0);
    // without the deferral an apply computes what is missing, as a plain CLI sync always has
    await sync(ctx, { llmGraph: false, reapply: true, only: [B] });
    expect(embedder.calls).toBe(1);
    expect(await vectorsOf(B)).toBe(await chunksOf(B));
  });

  it('replays a finished tier-1 from the sidecar and queues no new extraction for it', async () => {
    const meta = readSidecarPart(dataDir, A, 'meta')!;
    updateSidecarPart(dataDir, A, 'tier1', () => ({
      status: 'done',
      entities: [{ name: '宁德时代', type: 'organization' }, { name: '比亚迪', type: 'organization' }],
      relations: [],
      claims: [],
      model: 'test-model',
      contentSha: meta.contentSha256,
      extractedAt: new Date().toISOString(),
    }));
    const r = await applyDocScope(ctx, A, 'docs', { reapply: true, queueTier1: true });
    expect(r.outcome).toBe('applied');
    expect(await findLiveScope(ctx.store, 'tier1', A)).not.toBeNull();
    expect(await count(`extraction_queue WHERE document_id = $1`, [documentIdFor(A)])).toBe(0);
    // the retirement ran on the replay: no untyped placeholder of this document is left
    expect(await count(
      `evidence ev JOIN entities e ON e.id = ev.target_id WHERE ev.scope_id = $1 AND ev.extractor = 'tier0.concept' AND ev.kind = 'entity' AND ev.tx_to IS NULL AND e.type = 'concept'`,
      [r.scopeId],
    )).toBe(0);
    expect(await count(`entities WHERE id = '宁德时代' AND type = 'organization' AND tx_to IS NULL`)).toBe(1);

    // a document no model has read yet is queued, as on a first apply
    const rb = await applyDocScope(ctx, B, 'docs', { reapply: true, queueTier1: true });
    expect(rb.outcome).toBe('applied');
    expect(await count(`extraction_queue WHERE document_id = $1`, [documentIdFor(B)])).toBe(1);
  });
});
