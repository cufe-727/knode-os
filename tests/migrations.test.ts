import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { Store } from '../src/store/db.js';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/store/migrations.js';

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
