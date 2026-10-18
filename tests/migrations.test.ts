import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { Store } from '../src/store/db.js';
import { COOCCURS_CLEANUP_META, dropStoredCoOccurrence, MIGRATIONS, SCHEMA_VERSION } from '../src/store/migrations.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-migrations-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('upgrading early desktop databases', () => {
  it.each(['unversioned', 'v1'])('completes the %s baseline and preserves stored content', async (version) => {
    const dataDir = path.join(tmp, version);
    fs.mkdirSync(path.join(dataDir, '.knode'), { recursive: true });
    const db = await PGlite.create(path.join(dataDir, '.knode/db'), { extensions: { vector } });
    try {
      await db.exec(`
        CREATE EXTENSION vector;
        CREATE TABLE meta (key TEXT PRIMARY KEY, value JSONB NOT NULL);
      `);
      await MIGRATIONS[0].up({
        query: async <T>(sql: string, params?: unknown[]) => (await db.query<T>(sql, params)).rows,
        exec: async (sql) => { await db.exec(sql); },
      }, { from: 0 });
      // The shipped early desktop schema predates these baseline additions.
      await db.exec(`
        DROP TABLE datasets;
        DROP TABLE pack_events;
        ALTER TABLE suggestions DROP COLUMN payload;
        CREATE TABLE embeddings (
          chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
          model TEXT NOT NULL,
          embedding vector(3) NOT NULL
        );
        INSERT INTO meta VALUES ('embedding', '{"dim":3}');
        INSERT INTO documents (id, path, root, sha256, status)
          VALUES ('doc', 'raw/docs/existing.md', 'docs', 'sha', 'indexed');
        INSERT INTO chunks (id, document_id, seq, content)
          VALUES ('chunk', 'doc', 0, 'Existing knowledge');
        INSERT INTO embeddings VALUES ('chunk', 'existing-model', '[1,0,0]');
        INSERT INTO suggestions (id, kind, title, body, status)
          VALUES ('suggestion', 'skill', 'Existing suggestion', 'Keep this content', 'accepted');
      `);
      if (version === 'v1') {
        await db.query(`INSERT INTO meta VALUES ('schema_version', '{"v":1}')`);
      }
    } finally {
      await db.close();
    }

    const store = await Store.open(dataDir, 3);
    try {
      expect(store.migration).toEqual({ from: 1, to: SCHEMA_VERSION });
      expect(await store.query(`SELECT id, status FROM documents`)).toEqual([{ id: 'doc', status: 'pending' }]);
      expect(await store.query(`SELECT content FROM chunks`)).toEqual([{ content: 'Existing knowledge' }]);
      expect(await store.query(`SELECT model, embedding::text FROM embeddings`)).toEqual([
        { model: 'existing-model', embedding: '[1,0,0]' },
      ]);
      expect(await store.query(`SELECT body, status, payload FROM suggestions`)).toEqual([
        { body: 'Keep this content', status: 'accepted', payload: null },
      ]);
      expect(await store.query(`SELECT scope_id, tx_from, tx_to FROM datasets`)).toEqual([]);
      expect(await store.query(`SELECT * FROM receipts`)).toEqual([]);
      // v10: a chat message carries what a quick (retrieval) answer knows about itself
      await store.query(`INSERT INTO chat_conversations (id) VALUES ('c_x')`);
      await store.query(`INSERT INTO chat_messages (id, conversation_id, seq, role, content) VALUES ('m_x', 'c_x', 1, 'user', 'hi')`);
      expect(await store.query(`SELECT payload FROM chat_messages WHERE id = 'm_x'`)).toEqual([{ payload: {} }]);
    } finally {
      await store.close();
    }

    const reopened = await Store.open(dataDir, 3);
    try {
      expect(reopened.migration).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
      expect(await reopened.query(`SELECT content FROM chunks`)).toEqual([{ content: 'Existing knowledge' }]);
    } finally {
      await reopened.close();
    }
  });
});

describe('v13: co-occurrence is derived, not stored', () => {
  it('drops co_occurs rows with their evidence, keeps typed edges, and indexes mentions by document', async () => {
    const dataDir = path.join(tmp, 'v13');
    fs.mkdirSync(path.join(dataDir, '.knode'), { recursive: true });
    let store = await Store.open(dataDir, 3);
    try {
      await store.query(`INSERT INTO scopes (id, kind, key, sha, status, actor, applied_at) VALUES ('s1', 'doc', 'raw/docs/a.md', 'sha', 'active', 'test', now())`);
      await store.query(`INSERT INTO entities (id, name, type) VALUES ('a', 'A', 'concept'), ('b', 'B', 'concept'), ('c', 'C', 'concept')`);
      await store.query(
        `INSERT INTO relations (id, source_id, target_id, type, weight) VALUES ('co', 'a', 'b', 'co_occurs', 0.3), ('typed', 'a', 'c', 'related_to', 1)`,
      );
      await store.query(
        `INSERT INTO evidence (kind, target_id, scope_id, weight, extractor, attrs, tx_from) VALUES
           ('relation', 'co', 's1', 0.3, 'tier0.wikilink', '{}', now()),
           ('relation', 'typed', 's1', 1, 'tier0.frontmatter', '{}', now()),
           ('entity', 'a', 's1', 1, 'tier0.wikilink', '{}', now())`,
      );
      // a database that still has the rows is one that stopped at v12
      await store.query(`UPDATE meta SET value = '{"v":12}'::jsonb WHERE key = 'schema_version'`);
    } finally {
      await store.close();
    }

    store = await Store.open(dataDir, 3);
    try {
      expect(store.migration).toEqual({ from: 12, to: SCHEMA_VERSION });
      // the rows go in batches in the background once the migration committed, and the flag records it
      expect(await store.cleanup).toMatchObject({ relations: 1, evidence: 1, batches: 1 });
      expect(await store.query(`SELECT id FROM relations ORDER BY id`)).toEqual([{ id: 'typed' }]);
      expect(await store.query(`SELECT kind, target_id FROM evidence ORDER BY kind`)).toEqual([
        { kind: 'entity', target_id: 'a' },
        { kind: 'relation', target_id: 'typed' },
      ]);
      expect(await store.getMeta(COOCCURS_CLEANUP_META)).toMatchObject({ pending: false, relations: 1, evidence: 1, batches: 1 });
      expect(await store.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'entity_mentions' AND indexname = 'mentions_document_idx'`)).toEqual([
        { indexname: 'mentions_document_idx' },
      ]);
    } finally {
      await store.close();
    }
  });

  it('deletes in short batches, logs progress, stops when asked and resumes, and does nothing once the flag is down', async () => {
    const dataDir = path.join(tmp, 'v13-batches');
    fs.mkdirSync(path.join(dataDir, '.knode'), { recursive: true });
    const store = await Store.open(dataDir, 3);
    try {
      await store.cleanup; // the fresh database's own (empty) run
      await store.query(`INSERT INTO scopes (id, kind, key, sha, status, actor, applied_at) VALUES ('s1', 'doc', 'raw/docs/a.md', 'sha', 'active', 'test', now())`);
      await store.query(`INSERT INTO entities (id, name, type) VALUES ('a', 'A', 'concept'), ('b', 'B', 'concept')`);
      const ids = Array.from({ length: 25 }, (_, i) => `co-${String(i).padStart(2, '0')}`);
      await store.query(
        `INSERT INTO relations (id, source_id, target_id, type, weight) SELECT id, 'a', 'b', 'co_occurs', 0.3 FROM unnest($1::text[]) AS t(id)`,
        [ids],
      );
      await store.query(
        `INSERT INTO relations (id, source_id, target_id, type, weight) VALUES ('typed', 'a', 'b', 'related_to', 1)`,
      );
      // two evidence rows per co_occurs edge (two sources), one for the typed edge
      await store.query(
        `INSERT INTO evidence (kind, target_id, scope_id, weight, extractor, attrs, tx_from)
         SELECT 'relation', id, 's1', 0.3, x, '{}', now() FROM unnest($1::text[]) AS t(id), unnest(ARRAY['tier0.wikilink', 'tier1.llm']) AS e(x)`,
        [ids],
      );
      await store.query(`INSERT INTO evidence (kind, target_id, scope_id, weight, extractor, attrs, tx_from) VALUES ('relation', 'typed', 's1', 1, 'tier0.frontmatter', '{}', now())`);

      // nothing pending: a no-op
      expect(await dropStoredCoOccurrence(store)).toBeNull();
      expect(await store.query(`SELECT count(*)::int AS n FROM relations WHERE type = 'co_occurs'`)).toEqual([{ n: 25 }]);

      await store.setMeta(COOCCURS_CLEANUP_META, { pending: true });
      // stopped after the first statement (the floor is 100 relations per statement, so one batch takes all 25):
      // the flag stays up and the work done so far is kept
      let stopped = false;
      const paused: string[] = [];
      const partial = await dropStoredCoOccurrence(store, { stop: () => stopped, log: (line) => { paused.push(line); stopped = true; } });
      expect(partial).toMatchObject({ relations: 0, batches: 0 });
      expect(paused.at(-1)).toContain('paused at 0 / 25');
      expect(await store.getMeta(COOCCURS_CLEANUP_META)).toMatchObject({ pending: true });

      const lines: string[] = [];
      const res = await dropStoredCoOccurrence(store, { batch: 10, log: (line) => lines.push(line) });
      expect(res).toMatchObject({ relations: 25, evidence: 50, batches: 1 });
      expect(await store.query(`SELECT id FROM relations ORDER BY id`)).toEqual([{ id: 'typed' }]);
      expect(await store.query(`SELECT count(*)::int AS n FROM evidence WHERE kind = 'relation'`)).toEqual([{ n: 1 }]);
      expect(await store.getMeta(COOCCURS_CLEANUP_META)).toMatchObject({ pending: false, relations: 25, evidence: 50 });
      expect(lines[0]).toContain('dropping 25 stored co_occurs relation rows');
      expect(lines.at(-1)).toContain('dropped 25 stored co_occurs relation rows and 50 evidence rows');
      // idempotent: the flag is down, a second run touches nothing
      expect(await dropStoredCoOccurrence(store)).toBeNull();
    } finally {
      await store.close();
    }
  });
});
