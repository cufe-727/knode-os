import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SagSearchConfig } from '../src/config.js';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import { scoreBridgeTerms, seedTerms, sentenceTerms } from '../src/search/bridge.js';
import { search } from '../src/search/search.js';
import { Store, toVectorLiteral } from '../src/store/db.js';

describe('the terms of a sentence', () => {
  it('takes names of several words, words and codes, and leaves stopwords and bare numbers', () => {
    const terms = sentenceTerms('In 1998 the Halvard Lindqvist Foundation closed incident INC-014-D6T1 with AWS.');
    expect(terms).toEqual(expect.arrayContaining(['Halvard Lindqvist Foundation', 'Halvard', 'Lindqvist', 'Foundation', 'closed', 'incident', 'INC-014-D6T1', 'AWS']));
    expect(terms).not.toContain('1998');
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('In');
    expect(terms).not.toContain('with');
  });

  it('takes a name of several words without the small word before it', () => {
    expect(sentenceTerms('The University of Tromso opened.')).toContain('University of Tromso');
  });

  it('cuts Chinese into words and keeps a name the segmenter does not know together', () => {
    const terms = sentenceTerms('华鼎零售升级的事故由陈伟修复。');
    expect(terms).toEqual(expect.arrayContaining(['升级', '事故', '修复']));
    // whatever the segmenter makes of the two names, no term is a single character
    expect(terms.every((t) => t.length >= 2)).toBe(true);
    expect(terms.some((t) => t.includes('陈伟'))).toBe(true);
  });
});

describe('the terms of the seeds', () => {
  const seeds = [
    { chunkId: 'a', content: 'The Kestrel project is led by Halvard Lindqvist. Halvard Lindqvist joined in March.', weight: 1 },
    { chunkId: 'b', content: 'Lunch was served. The Kestrel project slipped a week.', weight: 0.5 },
  ];

  it('leaves out what the question already holds and counts sentences', () => {
    const terms = seedTerms('Who leads the Kestrel project?', seeds);
    const names = terms.map((t) => t.term);
    expect(names).not.toContain('kestrel');
    expect(names).not.toContain('project');
    const name = terms.find((t) => t.term === 'halvard lindqvist')!;
    expect(name).toMatchObject({ shown: 'Halvard Lindqvist', tf: 2, weight: 1 });
    // one of its sentences holds the question's terms, the other none
    expect(name.contexts.some((mask) => mask !== 0)).toBe(true);
    expect(name.contexts).toContain(0);
  });

  it('prefers a rare term beside the question to a rare term apart from it, and drops a term only the seed holds', () => {
    const terms = seedTerms('Who leads the Kestrel project?', seeds);
    const at = (t: string) => terms.findIndex((x) => x.term === t);
    const df = terms.map(() => 5);
    const idf = terms.map(() => 2);
    df[at('march')] = 1;
    const chosen = scoreBridgeTerms(terms, { df, idf }, [3, 3, 3], 10);
    const order = chosen.map((t) => t.term);
    expect(order).not.toContain('march');
    expect(order.indexOf('halvard lindqvist')).toBeLessThan(order.indexOf('lunch'));
    expect(scoreBridgeTerms(terms, { df, idf }, [3, 3, 3], 2)).toHaveLength(2);
  });
});

/**
 * A chain extraction made no link for. The seed names a person no entity
 * stands for; the passage that answers holds the name and none of the
 * question's words, and has no vector, so neither the direct route nor the
 * entity walk can reach it.
 *
 *   s1  the seed: the Kestrel project and its lead, Halvard Lindqvist
 *   s2  the direct route's second: the project again, not a seed
 *   a1  Halvard Lindqvist's earlier post       reached by the name only
 *   e1  a passage about him without the name   reached by the one entity extraction did link
 *   x1  a passage with none of it
 *   w1  a generated page that holds the name   never put forward by a term
 */
describe('SAG with bridge terms', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-sag-bridge-'));
  const embedder: EmbeddingProvider = {
    model: 'fixture-v1',
    dimensions: 4,
    async embed(texts: string[]) {
      return texts.map(() => [1, 0, 0, 0]);
    },
  } as EmbeddingProvider;
  let store: Store;

  async function addChunk(id: string, content: string, opts: { vector?: number[]; kind?: string; root?: string } = {}): Promise<void> {
    const documentId = `d-${id}`;
    const root = opts.root ?? 'docs';
    await store.query(
      `INSERT INTO documents (id, path, root, kind, title, sha256, bytes, status)
       VALUES ($1, $2, $3, $4, $1, $5, $6, 'indexed')`,
      [documentId, `${root === 'wiki' ? 'wiki' : 'raw/docs'}/${documentId}.md`, root, opts.kind ?? 'doc', `sha-${documentId}`, content.length],
    );
    await store.query(
      `INSERT INTO chunks (id, document_id, seq, content, token_count, tsv)
       VALUES ($1, $2, 0, $3, 10, to_tsvector('simple', $3))`,
      [id, documentId, content],
    );
    if (opts.vector) {
      await store.query(`INSERT INTO embeddings (chunk_id, model, embedding) VALUES ($1, $2, $3::vector)`, [id, embedder.model, toVectorLiteral(opts.vector)]);
    }
  }

  const sag = (bridgeTerms: number): Partial<SagSearchConfig> => ({ seedChunks: 1, entityFrontier: 8, maxEventsPerEntity: 4, candidatePool: 16, maxHops: 2, directRatio: 0.5, bridgeTerms });

  beforeAll(async () => {
    fs.mkdirSync(path.join(tmp, '.knode'), { recursive: true });
    store = await Store.open(tmp, embedder.dimensions);
    await addChunk('s1', 'The Kestrel project is led by Halvard Lindqvist.', { vector: [1, 0, 0, 0] });
    await addChunk('s2', 'The Kestrel project slipped a week.');
    await addChunk('a1', 'Before that, Halvard Lindqvist ran the Oslo depot for six years.');
    await addChunk('e1', 'The depot in Bergen answers to him.');
    await addChunk('x1', 'Ferry timetables changed for the winter.');
    await addChunk('w1', 'Halvard Lindqvist: a person named in two documents.', { kind: 'view', root: 'wiki' });
    await store.query(`INSERT INTO entities (id, name, type, mention_count) VALUES ('p1', 'Halvard Lindqvist', 'person', 2)`);
    for (const id of ['s1', 'e1']) {
      await store.query(`INSERT INTO entity_mentions (entity_id, chunk_id, document_id) VALUES ('p1', $1, $2)`, [id, `d-${id}`]);
    }
    await store.indexing;
  });

  it('ranks what the entity walk reached after the direct route\'s places, with no bridge terms at all', async () => {
    const results = await search(store, embedder, 'Who leads the Kestrel project?', { mode: 'sag', k: 8, track: false, sag: sag(0) });
    expect(results.map((r) => r.chunkId)).toEqual(['s1', 's2', 'e1']);
    expect(results[2].trace).toMatchObject({ route: 'sag', bridgeEntities: ['Halvard Lindqvist'] });
  });

  afterAll(async () => {
    if (store) await store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('does not reach the passage without them', async () => {
    const results = await search(store, embedder, 'Who leads the Kestrel project?', { mode: 'sag', k: 8, track: false, sag: sag(0) });
    expect(results.map((r) => r.chunkId)).not.toContain('a1');
  });

  it('reaches it by the name the seed and the passage share, and says so', async () => {
    const results = await search(store, embedder, 'Who leads the Kestrel project?', { mode: 'sag', k: 8, track: false, sag: sag(10) });
    const reached = results.find((r) => r.chunkId === 'a1');
    expect(reached).toBeDefined();
    expect(reached!.trace).toMatchObject({ route: 'sag', hop: 1, bridgeEntities: [] });
    expect(reached!.trace!.bridgeTerms).toContain('Halvard Lindqvist');
    expect(reached!.signals.bridge).toBeGreaterThan(0);
    // the unrelated passage and the generated page are not put forward
    const bridged = results.filter((r) => r.trace?.bridgeTerms).map((r) => r.chunkId);
    expect(bridged).toEqual(['a1']);
  });

  it('ranks what a term reached after the direct route\'s places, not level with its first', async () => {
    const results = await search(store, embedder, 'Who leads the Kestrel project?', { mode: 'sag', k: 8, track: false, sag: sag(10) });
    const ids = results.map((r) => r.chunkId);
    expect(ids.slice(0, 2)).toEqual(['s1', 's2']);
    expect(ids.indexOf('a1')).toBeGreaterThan(ids.indexOf('s2'));
  });

  it('finds the same through the substring index and by a scan', async () => {
    const run = async () => (await search(store, embedder, 'Who leads the Kestrel project?', { mode: 'sag', k: 8, track: false, sag: sag(10) })).map((r) => [r.chunkId, r.trace?.bridgeTerms ?? null]);
    expect(store.matchIndexes.size).toBeGreaterThan(0);
    const indexed = await run();
    const ready = [...store.matchIndexes];
    store.matchIndexes.clear();
    try {
      expect(await run()).toEqual(indexed);
    } finally {
      for (const name of ready) store.matchIndexes.add(name);
    }
  });
});
