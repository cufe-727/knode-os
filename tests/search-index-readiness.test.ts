import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { ensureMatchIndexes, MATCH_INDEXES } from '../src/store/grams.js';
import { FixedEmbedder, KEYWORD_CORPUS_DIM, rankAll, seedKeywordCorpus } from './helpers/keyword-corpus.js';

/**
 * Store.open returns before the substring indexes are built (src/store/grams.ts),
 * which takes minutes on a large workspace, and searches scan until they are
 * ready. A search must rank the same either way: the scan once weighted each
 * term by how many of its own candidates held it, the index lookup by how many
 * chunks in the corpus do, and picked its candidates by another rule, so a
 * chunk scored a fraction of its later score until the index was ready.
 * tests/backend-postgres.test.ts runs the same comparison on PostgreSQL, with a
 * store opened while another process holds the build.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-index-readiness-'));
const embedder = new FixedEmbedder();
let store: Store;

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, '.knode'), { recursive: true });
  store = await Store.open(tmp, KEYWORD_CORPUS_DIM);
  await store.indexing;
  await seedKeywordCorpus(store);
});

afterAll(async () => {
  if (store) await store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('search before and after the substring indexes are ready', () => {
  it('scores and orders every result alike, in keyword and hybrid mode', async () => {
    // as before a build: no index, and none marked ready
    await store.query(`DROP INDEX ${MATCH_INDEXES.chunks.name}`);
    await store.query(`DROP INDEX ${MATCH_INDEXES.entities.name}`);
    store.matchIndexes.clear();
    const before = await rankAll(store, embedder);

    expect((await ensureMatchIndexes(store, { log: () => {} })).built).toEqual([MATCH_INDEXES.entities.name, MATCH_INDEXES.chunks.name]);
    const after = await rankAll(store, embedder);

    expect(after).toEqual(before);
    // the comparison has something in it: every query finds chunks by keyword
    for (const r of after.filter((x) => x.mode === 'keyword')) expect(r.results.length, r.query).toBeGreaterThan(0);
    const top = after.find((x) => x.query === '海力士 HBM3E 认证' && x.mode === 'keyword')!;
    expect(top.results.map((x) => x.id)).toEqual(['k05', 'k06', 'k07']);
  });

  it('weighs a term by the chunks of the corpus that hold it, as BM25 does', async () => {
    // HBM3E is in two of the 90 chunks, so it weighs as a rare term: weighted among the three candidates holding
    // a query term, as the scan once did, it weighed next to nothing and k05 scored about 2
    const [r] = (await rankAll(store, embedder)).filter((x) => x.query === '海力士 HBM3E 认证' && x.mode === 'keyword');
    const ready = r.results[0].keyword!;
    store.matchIndexes.clear();
    try {
      const [s] = (await rankAll(store, embedder)).filter((x) => x.query === '海力士 HBM3E 认证' && x.mode === 'keyword');
      expect(s.results[0].keyword).toBe(ready);
    } finally {
      for (const spec of Object.values(MATCH_INDEXES)) store.matchIndexes.add(spec.name);
    }
    expect(ready).toBeGreaterThan(10);
  });
});
