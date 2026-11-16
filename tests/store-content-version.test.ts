import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';

/**
 * `Store.contentVersion` moves when a statement sent through the store may
 * have changed which documents or chunks exist — what a count kept in memory
 * (the sides of a search, `src/search/search.ts`) was taken from.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-content-version-'));
let store: Store;

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, '.knode'), { recursive: true });
  store = await Store.open(tmp, 4);
  await store.indexing;
});

afterAll(async () => {
  if (store) await store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the store\'s content version', () => {
  const insert = `INSERT INTO documents (id, path, root, kind, title, sha256, bytes, status) VALUES ($1, $2, 'docs', 'source', $1, $1, 1, 'indexed')`;

  it('moves on a write to documents, chunks, pages or scopes, by statement or in a transaction', async () => {
    let before = store.contentVersion;
    await store.query(insert, ['d1', 'raw/docs/a.md']);
    expect(store.contentVersion).toBeGreaterThan(before);

    before = store.contentVersion;
    await store.tx(async (q) => {
      await q.query(`INSERT INTO chunks (id, document_id, seq, content, token_count, tsv) VALUES ('c1', 'd1', 0, 'text', 1, to_tsvector('simple', 'text'))`);
    });
    expect(store.contentVersion).toBeGreaterThan(before);

    for (const sql of [
      `UPDATE documents SET status = 'pending' WHERE id = 'd1'`,
      `DELETE FROM chunks WHERE id = 'c1'`,
      `WITH gone AS (DELETE FROM documents WHERE id = 'd1' RETURNING id) SELECT count(*) FROM gone`,
      `INSERT INTO pages (path, kind, generator, inputs_sha, tx_from) VALUES ('wiki/index.md#x', 'x_index', 'x@1', 'sha', now())`,
      `UPDATE scopes SET status = status WHERE false`,
    ]) {
      before = store.contentVersion;
      await store.query(sql);
      expect(store.contentVersion, sql).toBeGreaterThan(before);
    }
    before = store.contentVersion;
    await store.exec(`DELETE FROM pages; DELETE FROM documents;`);
    expect(store.contentVersion).toBeGreaterThan(before);
  });

  it('stays where it is on a read, and on a write to anything else', async () => {
    const before = store.contentVersion;
    await store.query(`SELECT count(*) FROM documents d JOIN chunks c ON c.document_id = d.id`);
    await store.query(`WITH held AS (SELECT id FROM documents) SELECT count(*) FROM held`);
    await store.query(`SELECT set_config('hnsw.ef_search', '40', true), updated_at FROM (SELECT now() AS updated_at) t`);
    await store.setMeta('content-version-test', { at: 1 });
    await store.tx(async (q) => q.query(`SELECT 1 FROM chunks LIMIT 1`));
    expect(store.contentVersion).toBe(before);
  });
});
