import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { sync } from '../src/ingest/sync.js';
import { recountAll } from '../src/lineage/fold.js';
import { fillRelationSources, RELATION_SOURCES_META } from '../src/store/migrations.js';
import { relationSource } from '../src/store/temporal.js';

/**
 * A relation names the document it was read from (relations.document_id) and
 * the passage (relations.chunk_id), as a claim does: of its live supporters
 * whose scope read a document, the earliest. The writer grounds a relation
 * the extractor gave no passage to in the first chunk mentioning both ends.
 * Rows written before get their document from a batched fill at open.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-relation-sources-'));
let ctx: AppContext | undefined;
afterAll(async () => {
  await ctx?.datasources.closeAll();
  await ctx?.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const report = (date: string, body: string) => `---
title: 支付组周报
date: ${date}
entities:
  - { name: 支付组, type: organization }
  - { name: 结算中台, type: project }
  - { name: 孙欣, type: person }
relations:
  - { source: 支付组, target: 结算中台, type: related_to, description: 支付组推进结算中台 }
  - { source: 孙欣, target: 支付组, type: member_of }
---
${body}
`;

type Rel = { id: string; source_id: string; target_id: string; document_id: string | null; chunk_id: string | null; fold_sha: string };
const relations = (c: AppContext) =>
  c.store.query<Rel>(`SELECT id, source_id, target_id, document_id, chunk_id, fold_sha FROM relations WHERE tx_to IS NULL ORDER BY source_id, target_id`);

describe('the source of a relation', () => {
  it('is the earliest document that states it, grounded to the passage naming both ends', async () => {
    const dataDir = path.join(tmp, 'ws');
    write(dataDir, 'raw/docs/周报/支付组/2025-03-07.md', report('2025-03-07', '支付组推进结算中台。孙欣在支付组。'));
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });
    // a later report repeating both links: the relations keep the first one as their source
    write(dataDir, 'raw/docs/周报/支付组/2025-03-14.md', report('2025-03-14', '支付组继续推进结算中台。孙欣在支付组。'));
    await sync(ctx, { llmGraph: false });

    const docs = new Map((await ctx.store.query<{ id: string; path: string }>(`SELECT id, path FROM documents`)).map((d) => [d.path, d.id]));
    const first = docs.get('raw/docs/周报/支付组/2025-03-07.md')!;
    const rows = await relations(ctx);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.document_id).toBe(first);
      // the passage is a chunk of that document
      const [chunk] = await ctx.store.query<{ document_id: string; content: string }>(`SELECT document_id, content FROM chunks WHERE id = $1`, [r.chunk_id]);
      expect(chunk.document_id).toBe(first);
      expect(chunk.content).toContain('结算中台');
    }
    // the view says it by path
    const view = await ctx.store.query<{ source_path: string; document_id: string }>(`SELECT source_path, document_id FROM v_relations`);
    expect(view.map((v) => v.source_path)).toEqual(['raw/docs/周报/支付组/2025-03-07.md', 'raw/docs/周报/支付组/2025-03-07.md']);

    // the first report goes: the relation is read from the second now
    fs.rmSync(path.join(dataDir, 'raw/docs/周报/支付组/2025-03-07.md'));
    await sync(ctx, { llmGraph: false });
    const after = await relations(ctx);
    expect(after.map((r) => r.document_id)).toEqual([docs.get('raw/docs/周报/支付组/2025-03-14.md'), docs.get('raw/docs/周报/支付组/2025-03-14.md')]);
    expect(after.every((r) => r.chunk_id)).toBe(true);
  });

  it('is filled in for relations written before, without touching what pages render', async () => {
    const c = ctx!;
    const before = await relations(c);
    // a workspace from before v20: no document or passage on the rows, and evidence written without a passage
    await c.store.query(`UPDATE relations SET document_id = NULL, chunk_id = NULL`);
    await c.store.query(`UPDATE evidence SET segment_id = NULL WHERE kind = 'relation'`);
    await c.store.setMeta(RELATION_SOURCES_META, { pending: true });
    const res = await fillRelationSources(c.store, { batch: 1, log: () => {} });
    expect(res).toMatchObject({ relations: 2 });
    const filled = await relations(c);
    expect(filled.map((r) => r.document_id)).toEqual(before.map((r) => r.document_id));
    // the passage was never recorded for those: it stays empty until the document is applied again
    expect(filled.map((r) => r.chunk_id)).toEqual([null, null]);
    expect(filled.map((r) => r.fold_sha)).toEqual(before.map((r) => r.fold_sha));
    // done: a second open does nothing
    expect(await fillRelationSources(c.store, { log: () => {} })).toBeNull();
    // a full refold agrees with the fill
    await c.store.tx((q) => recountAll(q));
    expect((await relations(c)).map((r) => [r.document_id, r.fold_sha])).toEqual(before.map((r) => [r.document_id, r.fold_sha]));
  });

  it('picks the earliest supporter that read a document', () => {
    const ev = (scope: string, tx: string, segment: string | null) => ({ kind: 'relation', target_id: 'r', scope_id: scope, segment_id: segment, weight: 1, extractor: 'x', attrs: {}, tx_from: tx });
    const docs = new Map([
      ['a', { documentId: 'da', docDate: null, key: 'raw/docs/b.md' }],
      ['b', { documentId: 'db', docDate: null, key: 'raw/docs/a.md' }],
    ]);
    // a merge or a person's edit read no document: never the source
    expect(relationSource([ev('m', '2025-01-01T00:00:00Z', null), ev('a', '2025-02-01T00:00:00Z', 'c1')], docs)).toEqual({ documentId: 'da', chunkId: 'c1' });
    // one instant: the scope key orders them
    expect(relationSource([ev('a', '2025-02-01T00:00:00Z', 'c1'), ev('b', '2025-02-01T00:00:00Z', null)], docs)).toEqual({ documentId: 'db', chunkId: null });
    expect(relationSource([ev('m', '2025-01-01T00:00:00Z', null)], docs)).toBeNull();
  });
});
