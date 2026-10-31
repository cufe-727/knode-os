import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import { search } from '../src/search/search.js';
import { HALF_BOOST_HEAT, heatBoost, recordChunkHits } from '../src/stats/heat.js';
import { Store, toVectorLiteral } from '../src/store/db.js';

/**
 * Usage heat in search ranking. Every tracked search adds to the heat of the
 * documents it returned, so heat has to stay a tie-break: however hot a
 * document gets, it may only overtake results the recall channels scored
 * within `heat.searchWeight` of its own.
 *
 * Only the vector channel answers 'heron' (no chunk text holds it, and there
 * are no entities): chunk vN is the N-th nearest, so before heat it scores
 * exactly 1 / (60 + N); l3 comes 11th and e1 12th.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-search-heat-'));

class FixtureEmbedder implements EmbeddingProvider {
  readonly model = 'fixture-v1';
  readonly dimensions = 4;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0, 0, 0]);
  }
}

const embedder = new FixtureEmbedder();
const HEAT = defaultConfig().heat;
const W = HEAT.searchWeight;
let store: Store;

/** A chunk whose vector sits `degrees` away from every query's (none when null). */
async function addChunk(id: string, documentId: string, content: string, degrees: number | null): Promise<void> {
  await store.query(
    `INSERT INTO documents (id, path, root, title, sha256, bytes, status)
     VALUES ($1, $2, 'docs', $1, $3, 10, 'indexed') ON CONFLICT (id) DO NOTHING`,
    [documentId, `raw/docs/${documentId}.md`, `sha-${documentId}`],
  );
  const [{ seq }] = await store.query<{ seq: number }>(`SELECT count(*)::int AS seq FROM chunks WHERE document_id = $1`, [documentId]);
  await store.query(
    `INSERT INTO chunks (id, document_id, seq, content, token_count, tsv) VALUES ($1, $2, $3, $4, 4, to_tsvector('simple', $4))`,
    [id, documentId, seq, content],
  );
  if (degrees === null) return;
  const rad = (degrees * Math.PI) / 180;
  await store.query(
    `INSERT INTO embeddings (chunk_id, model, embedding) VALUES ($1, $2, $3::vector)`,
    [id, embedder.model, toVectorLiteral([Math.cos(rad), Math.sin(rad), 0, 0])],
  );
}

async function setHeat(documentId: string, heat: number): Promise<void> {
  await store.query(
    `INSERT INTO doc_stats (document_id, hit_count, last_hit_at, heat, heat_updated) VALUES ($1, 1, now(), $2, now())
     ON CONFLICT (document_id) DO UPDATE SET heat = $2, heat_updated = now()`,
    [documentId, heat],
  );
}

/** `n` searches that each returned `chunkId`. */
async function searchedFor(chunkId: string, documentId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await recordChunkHits(store, [{ chunkId, documentId }], HEAT);
}

const ids = (results: { chunkId: string }[]) => results.map((r) => r.chunkId);
const V = Array.from({ length: 10 }, (_, i) => `v${i + 1}`);

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, '.knode'), { recursive: true });
  store = await Store.open(tmp, embedder.dimensions);
  for (let n = 1; n <= 10; n++) await addChunk(`v${n}`, `d-v${n}`, `Field notes v${n}.`, n * 5);
  // one long document: three chunks a keyword search for 'sandpiper' returns together, one with a weak vector hit
  await addChunk('l1', 'd-long', 'Sandpiper manual, part one.', null);
  await addChunk('l2', 'd-long', 'Sandpiper manual, part two.', null);
  await addChunk('l3', 'd-long', 'Sandpiper manual, part three.', 52.5);
  await addChunk('e1', 'd-e1', 'Egret colony survey.', 60);
});

beforeEach(async () => {
  await store.query(`DELETE FROM doc_stats`);
  await store.query(`DELETE FROM chunk_stats`);
});

afterAll(async () => {
  if (store) await store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('usage heat in search ranking', () => {
  it('adds a fraction of the score that grows with heat and levels off below searchWeight', () => {
    expect(heatBoost(0, HEAT)).toBe(0);
    expect(heatBoost(1, HEAT)).toBeCloseTo(W / (1 + HALF_BOOST_HEAT), 12);
    expect(heatBoost(HALF_BOOST_HEAT, HEAT)).toBeCloseTo(W / 2, 12);
    expect(heatBoost(100, HEAT)).toBeGreaterThan(heatBoost(10, HEAT));
    expect(heatBoost(1e30, HEAT)).toBeLessThanOrEqual(W);
    expect(heatBoost(Infinity, HEAT)).toBe(W);
    expect(heatBoost(1e30, { ...HEAT, searchWeight: 0 })).toBe(0);
  });

  it('cannot lift a document above results the channels scored more than searchWeight higher, however hot', async () => {
    // far past anything a knowledge base accumulates (the finance workspace's hottest document is near 300)
    await setHeat('d-v10', 1e30);
    const results = await search(store, embedder, 'heron', { k: 10, track: false });
    // 1/70 * 1.05 = 0.0150 passes v7–v9 (within 5% above it), not v6 (1/66 = 0.01515)
    expect(ids(results)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v10', 'v7', 'v8', 'v9']);
    expect(results[6].score).toBeCloseTo((1 / 70) * (1 + W), 12);
  });

  it('keeps every pair the channels set more than searchWeight apart in order, even when the worse match is far hotter', async () => {
    const cold = await search(store, embedder, 'heron', { k: 12, track: false });
    // the worse the match, the hotter its document
    for (let n = 2; n <= 10; n++) await setHeat(`d-v${n}`, 10 ** (3 * (n - 2)));
    await setHeat('d-long', 1e30);
    await setHeat('d-e1', 1e30);
    const hot = await search(store, embedder, 'heron', { k: 12, track: false });

    expect(hot).toHaveLength(cold.length);
    const coldScore = new Map(cold.map((r) => [r.chunkId, r.score]));
    const place = new Map(hot.map((r, i) => [r.chunkId, i]));
    for (const r of hot) {
      expect(r.score).toBeGreaterThanOrEqual(coldScore.get(r.chunkId)!);
      expect(r.score).toBeLessThanOrEqual(coldScore.get(r.chunkId)! * (1 + W) + 1e-15);
    }
    // results within 5% may trade places (v3, at 1/63, passes v1); four ranks or more apart they may not
    let pairs = 0;
    for (const a of cold) {
      for (const b of cold) {
        if (a.score <= b.score * (1 + W)) continue;
        expect(place.get(a.chunkId)!).toBeLessThan(place.get(b.chunkId)!);
        pairs++;
      }
    }
    expect(pairs).toBeGreaterThan(30);
  });

  it('keeps a result two channels found, one of them first, above a hotter result only one found', async () => {
    await setHeat('d-v1', 1e30);
    const results = await search(store, embedder, 'egret', { k: 3, track: false });
    // e1: keyword #1 + vector #12; v1: vector #1 only, however hot
    expect(ids(results)).toEqual(['e1', 'v1', 'v2']);
  });

  it('still breaks a near-tie once a document keeps being returned', async () => {
    // v1 and v2 are one vector rank apart: 1/61 against 1/62, 1.6%
    await searchedFor('v2', 'd-v2', 1);
    expect(ids(await search(store, embedder, 'heron', { k: 3, track: false }))).toEqual(['v1', 'v2', 'v3']);
    await searchedFor('v2', 'd-v2', 2);
    const results = await search(store, embedder, 'heron', { k: 3, track: false });
    expect(ids(results)).toEqual(['v2', 'v1', 'v3']);
    expect(results[0].score).toBeCloseTo((1 / 62) * (1 + heatBoost(3, HEAT)), 8);
  });

  it('counts a document once per search, however many of its chunks came back', async () => {
    for (let i = 0; i < 2; i++) {
      const results = await search(store, embedder, 'sandpiper', { mode: 'keyword', k: 8, heat: HEAT });
      expect(ids(results).sort()).toEqual(['l1', 'l2', 'l3']);
    }
    const [doc] = await store.query<{ hit_count: number; heat: number }>(
      `SELECT hit_count, heat FROM doc_stats WHERE document_id = 'd-long'`,
    );
    expect(doc.hit_count).toBe(2);
    expect(doc.heat).toBeCloseTo(2, 4);
    const chunks = await store.query<{ chunk_id: string; hit_count: number }>(
      `SELECT chunk_id, hit_count FROM chunk_stats ORDER BY chunk_id`,
    );
    expect(chunks.map((c) => [c.chunk_id, c.hit_count])).toEqual([['l1', 2], ['l2', 2], ['l3', 2]]);
  });

  it('does not let searches that keep returning a long document carry it past better matches for other queries', async () => {
    // an agent researching one topic: the same long document comes back every time
    for (let i = 0; i < 30; i++) await search(store, embedder, 'sandpiper', { mode: 'keyword', k: 8, heat: HEAT });
    const results = await search(store, embedder, 'heron', { k: 12, track: false });
    // l3 is the 11th nearest (1/71); 30 searches buy it at most 5%, so it stays below v1–v7
    expect(ids(results).slice(0, 7)).toEqual(V.slice(0, 7));
    expect(results.find((r) => r.chunkId === 'l3')!.score).toBeLessThan((1 / 71) * (1 + W));
  });

  it('applies heat once in SAG mode, after the routes are merged', async () => {
    await searchedFor('v2', 'd-v2', 3);
    const results = await search(store, embedder, 'heron', { mode: 'sag', k: 4, track: false, sag: { seedChunks: 4 } });
    // no entities, so only the direct route answers and merging scores it by rank: 1/61, 1/62, …
    expect(ids(results)).toEqual(['v2', 'v1', 'v3', 'v4']);
    // had the direct route been ranked with heat as well, v2 would have merged as first: 1/61 * (1 + boost)
    expect(results[0].score).toBeCloseTo((1 / 62) * (1 + heatBoost(3, HEAT)), 8);
    expect(results[1].score).toBeCloseTo(1 / 61, 12);
  });
});
