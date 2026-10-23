import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { SCHEMA_VERSION } from '../src/store/migrations.js';
import { CATALOG_VIEWS } from '../src/store/catalog.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-schema-v7-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('schema v7/v8/v10/v11/v12/v13 (wiki research + review + quick answers + claim merges + dispose indexes + derived co-occurrence)', () => {
  it('adds the temporal relation / claim columns, resolution tables and research jobs, and every catalog view resolves', async () => {
    fs.mkdirSync(path.join(tmp, 'ws', '.knode'), { recursive: true });
    const store = await Store.open(path.join(tmp, 'ws'), 3);
    try {
      expect(SCHEMA_VERSION).toBe(14);
      expect(store.migration.to).toBe(14);
      // every foreign key a disposal fires, the merged-entity lookup of the fold, and the
      // document side of derived co-occurrence (v13) have an index to use
      const indexes = (await store.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`)).map((r) => r.indexname);
      expect(indexes).toEqual(expect.arrayContaining(['claims_chunk_idx', 'claims_object_idx', 'pages_scope_idx', 'entities_canonical_idx', 'mentions_document_idx']));
      const columns = async (table: string) =>
        (await store.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`,
          [table],
        )).map((r) => r.column_name);
      expect(await columns('relations')).toEqual(expect.arrayContaining(['valid_from', 'valid_to']));
      expect(await columns('claims')).toEqual(expect.arrayContaining(['event_at', 'observed_at', 'superseded_by']));
      expect(await columns('documents')).toContain('doc_date');
      // v14: the indexed text's length, read by the Summarize stage's size threshold (docs/design/14)
      expect(await columns('documents')).toContain('chars');
      expect(await columns('entities')).toEqual(expect.arrayContaining(['canonical_id', 'name_key']));
      expect(await columns('entity_alias_keys')).toEqual(expect.arrayContaining(['entity_id', 'alias_key', 'kind']));
      expect(await columns('entity_links')).toEqual(expect.arrayContaining(['entity_id', 'canonical_id', 'scope_id']));
      expect(await columns('entity_embeddings')).toEqual(expect.arrayContaining(['entity_id', 'fold_sha', 'embedding']));
      expect(await columns('research_jobs')).toEqual(expect.arrayContaining(['kind', 'template', 'status', 'output_path']));
      expect(await columns('chat_conversations')).toEqual(expect.arrayContaining(['title', 'agent', 'status', 'payload']));
      expect(await columns('chat_messages')).toEqual(expect.arrayContaining(['conversation_id', 'seq', 'role', 'content', 'events', 'payload', 'turns', 'cost_usd', 'error']));
      expect(await columns('claims')).toContain('canonical_id');
      expect(await columns('claim_links')).toEqual(expect.arrayContaining(['claim_id', 'canonical_id', 'kind', 'scope_id', 'confidence']));
      expect(await columns('claim_pair_verdicts')).toEqual(expect.arrayContaining(['pair_id', 'relation', 'confidence', 'model']));
      expect(await columns('claim_embeddings')).toEqual(expect.arrayContaining(['claim_id', 'model', 'embedding']));
      expect(await columns('extraction_queue')).toEqual(expect.arrayContaining(['segments_total', 'segments_done']));
      for (const view of CATALOG_VIEWS) {
        await expect(store.query(`SELECT * FROM ${view.name} LIMIT 1`)).resolves.toBeDefined();
      }
    } finally {
      await store.close();
    }
  });
});
