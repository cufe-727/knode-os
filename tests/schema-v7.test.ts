import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { SCHEMA_VERSION } from '../src/store/migrations.js';
import { CATALOG_VIEWS } from '../src/store/catalog.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-schema-v7-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('schema v7/v8 (wiki research + review)', () => {
  it('adds the temporal relation / claim columns, resolution tables and research jobs, and every catalog view resolves', async () => {
    fs.mkdirSync(path.join(tmp, 'ws', '.knode'), { recursive: true });
    const store = await Store.open(path.join(tmp, 'ws'), 3);
    try {
      expect(SCHEMA_VERSION).toBe(9);
      expect(store.migration.to).toBe(9);
      const columns = async (table: string) =>
        (await store.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`,
          [table],
        )).map((r) => r.column_name);
      expect(await columns('relations')).toEqual(expect.arrayContaining(['valid_from', 'valid_to']));
      expect(await columns('claims')).toEqual(expect.arrayContaining(['event_at', 'observed_at', 'superseded_by']));
      expect(await columns('documents')).toContain('doc_date');
      expect(await columns('entities')).toEqual(expect.arrayContaining(['canonical_id', 'name_key']));
      expect(await columns('entity_alias_keys')).toEqual(expect.arrayContaining(['entity_id', 'alias_key', 'kind']));
      expect(await columns('entity_links')).toEqual(expect.arrayContaining(['entity_id', 'canonical_id', 'scope_id']));
      expect(await columns('entity_embeddings')).toEqual(expect.arrayContaining(['entity_id', 'fold_sha', 'embedding']));
      expect(await columns('research_jobs')).toEqual(expect.arrayContaining(['kind', 'template', 'status', 'output_path']));
      expect(await columns('chat_conversations')).toEqual(expect.arrayContaining(['title', 'agent', 'status', 'payload']));
      expect(await columns('chat_messages')).toEqual(expect.arrayContaining(['conversation_id', 'seq', 'role', 'content', 'events', 'turns', 'cost_usd', 'error']));
      for (const view of CATALOG_VIEWS) {
        await expect(store.query(`SELECT * FROM ${view.name} LIMIT 1`)).resolves.toBeDefined();
      }
    } finally {
      await store.close();
    }
  });
});
