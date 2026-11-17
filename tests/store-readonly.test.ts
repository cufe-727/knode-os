import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createContext } from '../src/context.js';
import { search } from '../src/search/search.js';
import { SchemaVersionError, Store } from '../src/store/db.js';
import { MATCH_INDEXES } from '../src/store/grams.js';
import { SCHEMA_VERSION } from '../src/store/migrations.js';
import { FixedEmbedder, KEYWORD_CORPUS_DIM, seedKeywordCorpus } from './helpers/keyword-corpus.js';
import { tableDigest } from './helpers/table-digest.js';

/*
 * docs/design/35 §4: an evaluation build opened in the viewer is read, never
 * changed — no migration, no upkeep after the open, a backend that refuses
 * writes, and no hit counted by a search.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'store-readonly-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Every file under `dir` (but the embedded database and its lock) with its bytes. */
function filesOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (r === '.knode/db' || r === '.knode/db.lock') continue;
      if (e.isDirectory()) walk(r);
      else out[r] = fs.readFileSync(path.join(dir, r)).toString('base64');
    }
  };
  walk('');
  return out;
}

describe('Store.open read-only', () => {
  it('opens an index as it is, refuses every write, and counts no search hit', async () => {
    const ws = path.join(tmp, 'ws');
    const store = await Store.open(ws, KEYWORD_CORPUS_DIM);
    await Promise.all([store.cleanup, store.indexing]);
    await seedKeywordCorpus(store);
    await store.close();
    const files = filesOf(ws);

    const ro = await Store.open(ws, KEYWORD_CORPUS_DIM, { kind: 'pglite', host: '', port: 0, user: '', password: '', database: '', schemaPrefix: 'ws' }, { readOnly: true });
    try {
      expect(ro.readOnly).toBe(true);
      expect(ro.migration).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
      // the substring indexes the writable open built are read, not built again
      expect([...ro.matchIndexes].sort()).toEqual(Object.values(MATCH_INDEXES).map((s) => s.name).sort());
      const before = await tableDigest(ro);
      await expect(ro.query(`INSERT INTO meta (key, value) VALUES ('x', '1'::jsonb)`)).rejects.toThrow(/read-only transaction/);
      await expect(ro.tx((q) => q.query(`DELETE FROM chunks`))).rejects.toThrow(/read-only transaction/);
      // a search that would note its hits notes none
      const hits = await search(ro, new FixedEmbedder(), '宁德时代', { k: 3, mode: 'keyword' });
      expect(hits.length).toBeGreaterThan(0);
      expect(await tableDigest(ro)).toEqual(before);
    } finally {
      await ro.close();
    }
    expect(filesOf(ws)).toEqual(files);
  });

  it('opens a whole workspace without touching its files', async () => {
    const ws = path.join(tmp, 'whole');
    const made = await createContext(ws);
    await Promise.all([made.store.cleanup, made.store.indexing]);
    await made.store.close();
    const files = filesOf(ws);
    const ctx = await createContext(ws, { readOnly: true });
    try {
      expect(ctx.store.readOnly).toBe(true);
    } finally {
      await ctx.store.close();
    }
    expect(filesOf(ws)).toEqual(files);
  });

  it('refuses an index of another schema version, and one that is not there, instead of migrating or making it', async () => {
    const ws = path.join(tmp, 'old');
    const store = await Store.open(ws, KEYWORD_CORPUS_DIM);
    await Promise.all([store.cleanup, store.indexing]);
    // written by a later version than this one
    await store.query(`UPDATE meta SET value = $1::jsonb WHERE key = 'schema_version'`, [JSON.stringify({ v: SCHEMA_VERSION + 1 })]);
    await store.close();
    const lite = { kind: 'pglite', host: '', port: 0, user: '', password: '', database: '', schemaPrefix: 'ws' };
    const err = await Store.open(ws, KEYWORD_CORPUS_DIM, lite, { readOnly: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchemaVersionError);
    expect((err as SchemaVersionError).found).toBe(SCHEMA_VERSION + 1);

    const none = path.join(tmp, 'none');
    await expect(Store.open(none, KEYWORD_CORPUS_DIM, lite, { readOnly: true })).rejects.toThrow(/no embedded index/);
    expect(fs.existsSync(path.join(none, '.knode', 'db'))).toBe(false);
  });
});
