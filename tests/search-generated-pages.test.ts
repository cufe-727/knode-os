import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import { cutWithSources, GENERATED_SHARE, search, SearchMode } from '../src/search/search.js';
import { Store, toVectorLiteral } from '../src/store/db.js';
import { MATCH_INDEXES } from '../src/store/grams.js';
import { resolveScopeFilter } from '../src/store/resolver.js';

/**
 * Generated pages (entity pages, mentions pages, navigation lists) restate
 * the sources and outnumber them, so as one ranked list they took a search's
 * places: on the 2026-11 separation benchmark's 10× index the top 8 held a
 * source chunk for under half the questions. Each channel now lists its best
 * sources and its best pages separately, and the cut gives pages at most
 * `GENERATED_SHARE` of the places.
 *
 * The fixture is that index in small: eight weekly reports that each state
 * the figure once, and thirty generated pages that repeat the name and sit
 * nearer the question's vector — every channel prefers every page to every
 * source.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-generated-pages-'));

class FixtureEmbedder implements EmbeddingProvider {
  readonly model = 'fixture-v1';
  readonly dimensions = 4;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0, 0, 0]);
  }
}

const embedder = new FixtureEmbedder();
let store: Store;

const SOURCES = Array.from({ length: 8 }, (_, i) => `s${i + 1}`);
const PAGES = Array.from({ length: 30 }, (_, i) => `p${String(i + 1).padStart(2, '0')}`);

/** One document of one chunk; `lean` is how far its vector leans away from the question's. */
async function addChunk(id: string, file: string, root: string, kind: 'source' | 'view', content: string, lean: number): Promise<void> {
  const doc = `d-${id}`;
  await store.query(
    `INSERT INTO documents (id, path, root, kind, title, sha256, bytes, status) VALUES ($1, $2, $3, $4, $1, $5, 10, 'indexed')`,
    [doc, file, root, kind, `sha-${doc}`],
  );
  await store.query(
    `INSERT INTO chunks (id, document_id, seq, content, token_count, tsv) VALUES ($1, $2, 0, $3, 3, to_tsvector('simple', $3))`,
    [id, doc, content],
  );
  await store.query(`INSERT INTO embeddings (chunk_id, model, embedding) VALUES ($1, 'fixture-v1', $2)`, [id, toVectorLiteral([1, lean, 0, 0])]);
}

const QUESTION = 'Halcyon availability';

const sidesOf = (ids: string[]) => ({
  sources: ids.filter((id) => !PAGES.includes(id) && id !== 'nav'),
  pages: ids.filter((id) => PAGES.includes(id) || id === 'nav'),
});

async function ids(mode: SearchMode, opts: { k?: number; generatedShare?: number; kinds?: string[]; query?: string } = {}): Promise<string[]> {
  const results = await search(store, embedder, opts.query ?? QUESTION, {
    k: opts.k ?? 8, mode, track: false, current: false, generatedShare: opts.generatedShare,
    filter: opts.kinds ? resolveScopeFilter({ kinds: opts.kinds }) : undefined,
  });
  return results.map((r) => r.chunkId);
}

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, '.knode'), { recursive: true });
  store = await Store.open(tmp, embedder.dimensions);
  await store.indexing;
  for (const [i, id] of SOURCES.entries()) {
    await addChunk(id, `raw/docs/weekly/${id}.md`, 'docs', 'source', `Week ${i + 1} report of the platform team: Halcyon availability was 99.9${i}%.`, 0.5 + i / 100);
  }
  for (const [i, id] of PAGES.entries()) {
    await addChunk(id, `wiki/entities/${id}.md`, 'wiki', 'view', `Halcyon availability. Halcyon availability, Halcyon availability: what the sources say of Halcyon, page ${i + 1}.`, 0.01 + i / 1000);
  }
  // a navigation list: filed as a source the graph does not read, generated all the same
  await addChunk('nav', 'wiki/entities/index.md', 'wiki', 'source', 'Halcyon availability Halcyon availability Halcyon availability: entity pages A to Z.', 0.001);
  // a page a person wrote in the wiki is a source
  await addChunk('note', 'wiki/notes/halcyon-review.md', 'wiki', 'source', 'My review of the quarter: Halcyon availability held above target.', 0.6);
  // names only the pages hold
  await addChunk('p-only', 'wiki/mentions/zephyr.md', 'wiki', 'view', 'Zephyrine is mentioned in two documents.', 0.9);
  PAGES.push('p-only');
});

afterAll(async () => {
  if (store) await store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('generated pages in search results', () => {
  it('ranked as one list, pages take every place', async () => {
    for (const mode of ['hybrid', 'vector', 'keyword'] as const) {
      const all = sidesOf(await ids(mode, { generatedShare: 1 }));
      expect(all.sources, mode).toEqual([]);
      expect(all.pages, mode).toHaveLength(8);
    }
  });

  it('gives pages a quarter of the places and sources the rest, in every mode', async () => {
    expect(GENERATED_SHARE).toBe(0.25);
    for (const mode of ['hybrid', 'vector', 'keyword'] as const) {
      const found = await ids(mode);
      const { sources, pages } = sidesOf(found);
      expect(pages, mode).toHaveLength(2);
      expect(sources, mode).toHaveLength(6);
      // the pages are the ones the channels rank best, where the channels rank them: first
      expect(found.slice(0, 2), mode).toEqual(pages);
    }
    // the navigation list is nearest the question and repeats its words: it is a page, and takes a page's place
    expect(await ids('vector')).toContain('nav');
    expect((await ids('vector')).slice(0, 2)).toEqual(['nav', 'p01']);
  });

  it('counts a page a person wrote in the wiki as a source', async () => {
    const found = await ids('hybrid', { k: 12 });
    const { sources, pages } = sidesOf(found);
    expect(pages).toHaveLength(3);
    expect(sources).toHaveLength(9);
    expect(sources).toContain('note');
    expect(new Set(sources)).toEqual(new Set([...SOURCES, 'note']));
  });

  it('lists sources as candidates while the substring index is being built, too', async () => {
    const ready = await ids('keyword');
    store.matchIndexes.clear();
    try {
      expect(await ids('keyword')).toEqual(ready);
    } finally {
      for (const spec of Object.values(MATCH_INDEXES)) store.matchIndexes.add(spec.name);
    }
  });

  it('fills the places sources leave with pages', async () => {
    // nine sources hold the words: a search for 20 returns them all, and pages after
    const wide = sidesOf(await ids('hybrid', { k: 20 }));
    expect(wide.sources).toHaveLength(9);
    expect(wide.pages).toHaveLength(11);
    // what only a page holds is found
    expect(await ids('keyword', { query: 'Zephyrine' })).toEqual(['p-only']);
  });

  it('returns pages to a search that asks for them', async () => {
    for (const mode of ['hybrid', 'vector', 'keyword'] as const) {
      const views = await ids(mode, { kinds: ['view'] });
      expect(views, mode).toHaveLength(8);
      expect(sidesOf(views).sources, mode).toEqual([]);
      const docs = await ids(mode, { kinds: ['doc'] });
      expect(new Set(docs), mode).toEqual(new Set(SOURCES));
    }
  });

  it('keeps pages to their places in sag mode too', async () => {
    // the walk's direct route searches for 12 and handed its first four on: three of them pages
    const found = await ids('sag');
    expect(found).toHaveLength(8);
    expect(sidesOf(found).pages).toHaveLength(2);
    expect(sidesOf(await ids('sag', { k: 4 })).pages).toHaveLength(1);
    // asked for pages, the walk returns pages
    expect(sidesOf(await ids('sag', { kinds: ['view'] })).sources).toEqual([]);
  });

  it('holds a search for one result to a source', async () => {
    expect(sidesOf(await ids('hybrid', { k: 1 })).sources).toHaveLength(1);
    expect(sidesOf(await ids('hybrid', { k: 4 })).pages).toHaveLength(1);
  });
});

describe('cutWithSources', () => {
  const page = (x: string) => x.startsWith('p');

  it('keeps the order, passes over pages past their places, and takes them when sources run out', () => {
    const ordered = ['p1', 'p2', 'p3', 's1', 'p4', 's2', 's3', 'p5'];
    expect(cutWithSources(ordered, 4, 1, page)).toEqual(['p1', 's1', 's2', 's3']);
    expect(cutWithSources(ordered, 4, 0, page)).toEqual(['p1', 's1', 's2', 's3']);
    expect(cutWithSources(ordered, 5, 2, page)).toEqual(['p1', 'p2', 's1', 's2', 's3']);
    expect(cutWithSources(ordered, 6, 1, page)).toEqual(['p1', 'p2', 'p3', 's1', 's2', 's3']);
    expect(cutWithSources(ordered, 3, 3, page)).toEqual(['p1', 'p2', 'p3']);
    expect(cutWithSources(['s1', 's2'], 5, 1, page)).toEqual(['s1', 's2']);
  });
});
