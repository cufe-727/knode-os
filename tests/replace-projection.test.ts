import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { readSidecarPart, updateSidecarPart } from '../src/fs/sidecar.js';
import { applyTier1Scope } from '../src/graph/tier1.js';
import { documentIdFor } from '../src/ingest/apply.js';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import { sync } from '../src/ingest/sync.js';
import { findLiveScope } from '../src/lineage/scope.js';
import { Store } from '../src/store/db.js';

/**
 * The document projection (chunks, their embeddings, the documents row) belongs
 * to the doc scope. Child scopes — a tier-1 extraction, human prose on a
 * generated page — name the document only to find it. Disposing a child, or
 * replacing it with a fresh extraction, must leave the projection alone:
 * embeddings cascade from chunks, and every vector lost here is paid for again
 * through the embedding pool.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-replace-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

class CountingEmbedder implements EmbeddingProvider {
  texts = 0;
  constructor(private readonly inner: EmbeddingProvider) {}
  get model() { return this.inner.model; }
  get dimensions() { return this.inner.dimensions; }
  async embed(texts: string[]): Promise<number[][]> {
    this.texts += texts.length;
    return this.inner.embed(texts);
  }
}

async function count(store: Store, from: string): Promise<number> {
  const [row] = await store.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${from}`);
  return row.n;
}

const para = (i: number) => `Paragraph ${i}: ` + 'knowledge graphs compose lineage and evidence over time. '.repeat(12);

function tier1Part(contentSha: string, extractedAt: string) {
  return {
    status: 'done' as const,
    entities: [{ name: '宁德时代', type: 'organization' }],
    relations: [],
    claims: [],
    model: 'test-model',
    contentSha,
    extractedAt,
  };
}

describe('replacing a scope keeps the document projection', () => {
  it('a changed document with a tier-1 child re-embeds only its new chunks', async () => {
    const dataDir = path.join(tmp, 'edit');
    initDataDir(dataDir);
    const file = 'raw/docs/long.md';
    write(dataDir, file, `# Long\n\n宁德时代。\n\n${Array.from({ length: 6 }, (_, i) => para(i)).join('\n\n')}\n`);
    const ctx = await createContext(dataDir);
    const counting = new CountingEmbedder(ctx.embedder);
    ctx.embedder = counting;
    try {
      await sync(ctx, { llmGraph: false });
      const meta = readSidecarPart(dataDir, file, 'meta')!;
      updateSidecarPart(dataDir, file, 'tier1', () => tier1Part(meta.contentSha256, new Date().toISOString()));
      // the unchanged document picks the sidecar extraction up as a child scope
      await sync(ctx, { llmGraph: false });
      expect(await findLiveScope(ctx.store, 'tier1', file)).not.toBeNull();
      const chunks = await count(ctx.store, 'chunks');
      expect(chunks).toBeGreaterThan(1);
      expect(await count(ctx.store, 'embeddings')).toBe(chunks);

      counting.texts = 0;
      fs.appendFileSync(path.join(dataDir, file), `\n\n${para(99)}\n`);
      await sync(ctx, { llmGraph: false });
      const after = await count(ctx.store, 'chunks');
      expect(after).toBeGreaterThanOrEqual(chunks);
      // the unchanged chunks were neither embedded again nor left without a vector
      expect(counting.texts).toBeLessThan(chunks);
      expect(await count(ctx.store, 'embeddings')).toBe(after);
    } finally {
      await ctx.store.close();
    }
  });

  it('a fresh tier-1 result replacing an older one leaves the document indexed with its chunks', async () => {
    const dataDir = path.join(tmp, 'tier1');
    initDataDir(dataDir);
    const file = 'raw/docs/a.md';
    write(dataDir, file, `# A\n\n宁德时代。\n\n${para(1)}\n`);
    const ctx = await createContext(dataDir);
    try {
      await sync(ctx, { llmGraph: false });
      const meta = readSidecarPart(dataDir, file, 'meta')!;
      updateSidecarPart(dataDir, file, 'tier1', () => tier1Part(meta.contentSha256, '2026-10-18T00:00:00.000Z'));
      await sync(ctx, { llmGraph: false });
      const first = await findLiveScope(ctx.store, 'tier1', file);
      expect(first).not.toBeNull();
      const chunks = await count(ctx.store, 'chunks');
      const embeddings = await count(ctx.store, 'embeddings');
      expect(chunks).toBeGreaterThan(0);
      expect(embeddings).toBe(chunks);

      // a fresh extraction of the same content replaces the child scope directly
      const documentId = documentIdFor(file);
      const rows = await ctx.store.query<{ id: string; content: string }>(`SELECT id, content FROM chunks WHERE document_id = $1 ORDER BY seq`, [documentId]);
      const res = await applyTier1Scope(
        ctx.store,
        { path: file, sha256: meta.contentSha256 },
        { documentId, path: file, title: 'A', chunkIds: rows },
        { entities: [{ name: '曾毓群', type: 'person' }], relations: [] },
        { model: 'test-model-2', force: true, extractedAt: '2026-10-18T01:00:00.000Z' },
      );
      expect(res.outcome).toBe('applied');
      const second = await findLiveScope(ctx.store, 'tier1', file);
      expect(second!.id).not.toBe(first!.id);

      const [doc] = await ctx.store.query<{ status: string }>(`SELECT status FROM documents WHERE path = $1`, [file]);
      expect(doc.status).toBe('indexed');
      expect(await count(ctx.store, 'chunks')).toBe(chunks);
      expect(await count(ctx.store, 'embeddings')).toBe(embeddings);
    } finally {
      await ctx.store.close();
    }
  });
});
