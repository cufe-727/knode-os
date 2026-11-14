import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultRerankConfig } from '../src/config.js';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import { cutWithSources, GENERATED_SHARE, search, searchExplained, SearchMode } from '../src/search/search.js';
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
/** Lists of where to look: a navigation list and a mentions page. */
const LISTINGS = ['nav', 'mentions'];

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
  sources: ids.filter((id) => !PAGES.includes(id) && !LISTINGS.includes(id)),
  pages: ids.filter((id) => PAGES.includes(id) || LISTINGS.includes(id)),
});

async function ids(mode: SearchMode, opts: { k?: number; generatedShare?: number; kinds?: string[]; sources?: string[]; query?: string } = {}): Promise<string[]> {
  const results = await search(store, embedder, opts.query ?? QUESTION, {
    k: opts.k ?? 8, mode, track: false, current: false, generatedShare: opts.generatedShare,
    filter: opts.kinds || opts.sources ? resolveScopeFilter({ kinds: opts.kinds, sources: opts.sources }) : undefined,
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
  // lists of where to look, nearest the question and repeating its words: a navigation list (filed as a
  // source the graph does not read, generated all the same) and the page of where Halcyon is mentioned
  await addChunk('nav', 'wiki/entities/index.md', 'wiki', 'source', 'Halcyon availability Halcyon availability Halcyon availability: entity pages A to Z.', 0.001);
  await addChunk('mentions', 'wiki/mentions/halcyon.md', 'wiki', 'view', 'Halcyon availability Halcyon availability Halcyon availability: 8 documents name Halcyon.', 0.002);
  // a page a person wrote in the wiki is a source
  await addChunk('note', 'wiki/notes/halcyon-review.md', 'wiki', 'source', 'My review of the quarter: Halcyon availability held above target.', 0.6);
  // names only the pages hold
  await addChunk('p-only', 'wiki/timelines/zephyr.md', 'wiki', 'view', 'Zephyrine: what happened, by month.', 0.9);
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
    // the two pages are entity pages: the lists nearer the question take no place
    expect((await ids('vector')).slice(0, 2)).toEqual(['p01', 'p02']);
  });

  it('does not answer from lists of where to look, unless the search asks for the wiki\'s pages', async () => {
    for (const mode of ['hybrid', 'vector', 'keyword', 'sag'] as const) {
      const found = await ids(mode, { k: 20 });
      expect(found.filter((id) => LISTINGS.includes(id)), mode).toEqual([]);
      // not even to fill the places the sources leave
      expect(sidesOf(found).sources, mode).toHaveLength(9);
      expect(found, mode).toHaveLength(20);
    }
    // asked for generated pages, the mentions page is one; asked for a folder of the wiki, its lists are in it
    expect((await ids('vector', { kinds: ['view'] })).slice(0, 2)).toEqual(['mentions', 'p01']);
    expect(await ids('vector', { sources: ['wiki/mentions'] })).toEqual(['mentions']);
    expect((await ids('vector', { sources: ['wiki/entities'] }))[0]).toBe('nav');
    expect((await ids('keyword', { kinds: ['wiki'] }))).toContain('nav');
  });

  it('counts a page a person wrote in the wiki as a source', async () => {
    const found = await ids('hybrid', { k: 12 });
    const { sources, pages } = sidesOf(found);
    expect(pages).toHaveLength(3);
    expect(sources).toHaveLength(9);
    expect(sources).toContain('note');
    expect(new Set(sources)).toEqual(new Set([...SOURCES, 'note']));
  });

  it('gives each side its matches of a quoted phrase', async () => {
    // words of their own, and no vectors: 26 pages and 6 reports hold the phrase, 6 notes hold its words apart
    // and oftener. A phrase is the asker's filter and its matches lead — with one list of matches the 24
    // best were pages, and the sources that followed were the notes
    const add = async (id: string, file: string, root: string, kind: string, content: string) => {
      await store.query(`INSERT INTO documents (id, path, root, kind, title, sha256, bytes, status) VALUES ($1, $2, $3, $4, $1, $5, 10, 'indexed')`, [`d-${id}`, file, root, kind, `sha-${id}`]);
      await store.query(`INSERT INTO chunks (id, document_id, seq, content, token_count, tsv) VALUES ($1, $2, 0, $3, 3, to_tsvector('simple', $3))`, [id, `d-${id}`, content]);
    };
    for (let i = 1; i <= 26; i++) await add(`qp${i}`, `wiki/entities/quasar-${i}.md`, 'wiki', 'view', `Quasar uptime. Quasar uptime, Quasar uptime: page ${i}.`);
    for (let i = 1; i <= 6; i++) await add(`qs${i}`, `raw/docs/quasar/report-${i}.md`, 'docs', 'source', `Report ${i}: Quasar uptime was 99.${i}%.`);
    for (let i = 1; i <= 6; i++) await add(`qn${i}`, `raw/docs/quasar/note-${i}.md`, 'docs', 'source', `Uptime, uptime, uptime of the Quasar, Quasar, Quasar cluster: note ${i}.`);
    const found = await ids('keyword', { query: '"Quasar uptime"' });
    expect(found.filter((id) => id.startsWith('qp'))).toHaveLength(2);
    expect(found.filter((id) => id.startsWith('qs')).sort()).toEqual(['qs1', 'qs2', 'qs3', 'qs4', 'qs5', 'qs6']);
    // without the phrase the words decide, and the notes hold them oftener
    expect((await ids('keyword', { query: 'Quasar uptime' })).filter((id) => id.startsWith('qn')).length).toBeGreaterThan(0);
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

  it('keeps a place for the page that is the best candidate of all, in a search for one result too', async () => {
    // every channel puts the entity page first: a quarter of one place rounds to none, and the page keeps it
    for (const mode of ['hybrid', 'vector', 'keyword', 'sag'] as const) expect(await ids(mode, { k: 1 }), mode).toEqual(['p01']);
    expect(sidesOf(await ids('hybrid', { k: 4 })).pages).toHaveLength(1);
    // where a source is the best candidate, a search for one result is that source
    expect(await ids('keyword', { k: 1, query: 'availability 99.92' })).toEqual(['s3']);
    expect(await ids('hybrid', { k: 1, generatedShare: 0 })).toEqual(['s1']);
  });
});

describe('the rerank stage with generated pages', () => {
  let server: http.Server;
  let base = '';
  let sent: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        sent = (JSON.parse(raw) as { texts: string[] }).texts;
        // a page reads best of all, then the later week's report
        const scored = sent.map((t, index) => ({ index, score: /Week (\d+) report/.test(t) ? Number(/Week (\d+) report/.exec(t)![1]) : t.includes('My review') ? 0 : 100 }));
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(scored));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('sends the reranker the sources the cut will take, not a head of pages', async () => {
    // the fused head is pages: thirty of them were reranked, and the cut then took two and six sources no reranker had read
    const { results, channels } = await searchExplained(store, embedder, QUESTION, {
      k: 8, track: false, current: false, rerank: { ...defaultRerankConfig(), enabled: true, url: base, candidates: 12 },
    });
    expect(channels.rerank).toMatchObject({ hits: 12 });
    // twelve candidates: a quarter pages, the rest sources — every source that holds the words
    expect(sent.filter((t) => t.includes('what the sources say'))).toHaveLength(3);
    expect(sent.filter((t) => / report of the platform team/.test(t))).toHaveLength(8);
    // every result was read by the reranker, and the sources come in its order
    expect(results.every((r) => typeof r.signals.rerank === 'number')).toBe(true);
    // the reranker puts the three pages first: two keep their places, and the sources follow in its order
    const found = results.map((r) => r.chunkId);
    expect(sidesOf(found.slice(0, 2)).pages).toHaveLength(2);
    expect(found.slice(2)).toEqual(['s8', 's7', 's6', 's5', 's4', 's3']);
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
