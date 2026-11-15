import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultRerankConfig } from '../src/config.js';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import { cutWithSources, describeVectorScan, docLiveAt, GENERATED_SHARE, search, searchExplained, SearchMode, sideBudget, vectorScan } from '../src/search/search.js';
import { Store, toVectorLiteral } from '../src/store/db.js';
import { MATCH_INDEXES } from '../src/store/grams.js';
import { resolveScopeFilter } from '../src/store/resolver.js';
import { Params } from '../src/store/temporal.js';

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
  // what makes the navigation list the generator's: a region it keeps in the file
  await store.query(`INSERT INTO pages (path, kind, generator, inputs_sha, tx_from) VALUES ('wiki/entities/index.md#entities', 'entities_index', 'entities_index@1', 'sha', now())`);
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

  it('ranks a side alike whether its vectors are read or the index is walked for it', async () => {
    // an index this small is read side by side; `exactSide: 0` sends the walk's statement instead
    const read = await search(store, embedder, QUESTION, { k: 8, mode: 'vector', track: false, current: false });
    const walked = await search(store, embedder, QUESTION, { k: 8, mode: 'vector', track: false, current: false, exactSide: 0 });
    expect(walked.map((r) => [r.chunkId, r.signals.vector])).toEqual(read.map((r) => [r.chunkId, r.signals.vector]));
    expect(sidesOf(read.map((r) => r.chunkId)).sources).toHaveLength(6);
    // a filter that leaves a side nothing sends no branch for it, and one that leaves neither side anything no statement
    expect(await ids('vector', { sources: ['raw/docs/weekly/s3.md'] })).toEqual(['s3']);
    expect(await ids('vector', { sources: ['raw/docs/nowhere'] })).toEqual([]);
  });

  it('gives a side a budget of rows that grows with the root of the index', () => {
    expect(sideBudget(24, 8016)).toBe(2000);
    expect(sideBudget(24, 200_400)).toBe(6203);
    expect(sideBudget(24, 456_000)).toBe(9357);
    expect(sideBudget(300, 2_000_000)).toBe(20_000);
    expect(sideBudget(24, 0)).toBe(2000);
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

describe('lists the generator keeps, and pages a person wrote under the same names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-generated-lists-'));
  let lists: Store;

  beforeAll(async () => {
    fs.mkdirSync(path.join(dir, '.knode'), { recursive: true });
    lists = await Store.open(dir, embedder.dimensions);
    await lists.indexing;
    const add = async (id: string, file: string, kind: string, content: string) => {
      await lists.query(`INSERT INTO documents (id, path, root, kind, title, sha256, bytes, status) VALUES ($1, $2, 'wiki', $3, $1, $4, 10, 'indexed')`, [`d-${id}`, file, kind, `sha-${id}`]);
      await lists.query(`INSERT INTO chunks (id, document_id, seq, content, token_count, tsv) VALUES ($1, $2, 0, $3, 3, to_tsvector('simple', $3))`, [id, `d-${id}`, content]);
    };
    // ingest files every index.md of the wiki as a source the graph does not read, whoever wrote it
    await add('hub', 'wiki/projects/index.md', 'source', 'Quillon roadmap: my own index of the projects, written by hand.');
    await add('shelf', 'wiki/sources/by-folder/reports/index.md', 'source', 'Quillon roadmap, Quillon roadmap: documents 1 to 200.');
    // what makes the shelf the generator's: a region it keeps in the file
    await lists.query(`INSERT INTO pages (path, kind, generator, inputs_sha, tx_from) VALUES ('wiki/sources/by-folder/reports/index.md#shelf', 'sources_shelf', 'sources_shelf@1', 'sha', now())`);
    // a page a person keeps under wiki/mentions is theirs: only a view there is a mentions page
    await add('my-mentions', 'wiki/mentions/quillon-notes.md', 'source', 'Quillon roadmap: where I have seen it mentioned.');
    await add('mentions-view', 'wiki/mentions/quillon.md', 'view', 'Quillon roadmap. Quillon roadmap: 3 documents name Quillon.');
    await add('entity', 'wiki/entities/quillon.md', 'view', 'Quillon roadmap: what the sources say of Quillon.');
  });

  afterAll(async () => {
    if (lists) await lists.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const found = (opts: { kinds?: string[]; generatedShare?: number; k?: number } = {}) =>
    search(lists, embedder, 'Quillon roadmap', { k: opts.k ?? 8, mode: 'keyword', track: false, current: false, generatedShare: opts.generatedShare, filter: opts.kinds ? resolveScopeFilter({ kinds: opts.kinds }) : undefined })
      .then((rs) => rs.map((r) => r.chunkId));

  it('answers from a person\'s index.md and notes, not from the generator\'s shelf or mentions page', async () => {
    expect((await found()).sort()).toEqual(['entity', 'hub', 'my-mentions']);
    // asked for the wiki's pages, the lists are among them
    expect((await found({ kinds: ['wiki'] })).sort()).toEqual(['hub', 'my-mentions', 'shelf']);
    expect((await found({ kinds: ['view'] })).sort()).toEqual(['entity', 'mentions-view']);
  });

  it('counts the person\'s pages as sources and the generator\'s as pages', async () => {
    // no place for pages: the person's two pages are what is left
    expect((await found({ generatedShare: 0, k: 2 })).sort()).toEqual(['hub', 'my-mentions']);
    // among the wiki's pages the shelf is a generated one: it gets a page's share, the person's pages the rest
    expect((await found({ kinds: ['wiki'], generatedShare: 0, k: 2 })).sort()).toEqual(['hub', 'my-mentions']);
  });

  it('leaves every other reader of live documents as it was', () => {
    // the graph routes, the walk, context packs and excerpts go through docLiveAt: it says nothing of lists
    const sql = docLiveAt('d', new Params());
    expect(sql).toBe("d.status = 'indexed' AND d.root <> 'codebase'");
  });
});

describe('which way the vector index is walked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-vector-scan-'));
  let plain: Store;

  beforeAll(async () => {
    fs.mkdirSync(path.join(dir, '.knode'), { recursive: true });
    plain = await Store.open(dir, embedder.dimensions);
    await plain.indexing;
    await plain.query(`INSERT INTO documents (id, path, root, kind, title, sha256, bytes, status) VALUES ('d1', 'raw/docs/a.md', 'docs', 'source', 'a', 'sha', 10, 'indexed')`);
    await plain.query(`INSERT INTO chunks (id, document_id, seq, content, token_count, tsv) VALUES ('c1', 'd1', 0, 'text', 1, to_tsvector('simple', 'text'))`);
    await plain.query(`INSERT INTO embeddings (chunk_id, model, embedding) VALUES ('c1', 'fixture-v1', $1)`, [toVectorLiteral([1, 0.1, 0, 0])]);
  });

  afterAll(async () => {
    if (plain) await plain.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A store whose server answers the library check as given. */
  const serverSaying = (mode: string | null, catalog: string | null) => ({ query: async () => [{ mode, catalog }] }) as unknown as Store;

  it('is decided by the library the server has loaded, not by the version in the catalog', async () => {
    // the library was upgraded and ALTER EXTENSION never run: the catalog still says 0.7.4, the setting exists
    expect(await vectorScan(serverSaying('off', '0.7.4'))).toEqual({ iterative: true, catalog: '0.7.4' });
    expect(await vectorScan(serverSaying(null, '0.7.4'))).toEqual({ iterative: false, catalog: '0.7.4' });
    // the embedded index carries a library that has it
    expect((await vectorScan(plain)).iterative).toBe(true);
  });

  it('says in one line which behaviour is in effect, why, and what an operator runs', async () => {
    expect(await describeVectorScan(serverSaying('off', '0.8.7'))).toBe(
      'vector search: the index is walked on until each side of a search has its candidates (pgvector 0.8.7 in the catalog; the library has hnsw.iterative_scan).',
    );
    const behind = await describeVectorScan(serverSaying('off', '0.7.4'));
    expect(behind).toContain('the index is walked on');
    expect(behind).toContain('The catalog is behind the library: ALTER EXTENSION vector UPDATE');
    const old = await describeVectorScan(serverSaying(null, '0.7.4'));
    expect(old).toContain('one walk of the index per search (pgvector 0.7.4 in the catalog; the library on this server has no hnsw.iterative_scan');
    expect(old).toContain('install pgvector 0.8.0 or later on the database server, restart it, then run ALTER EXTENSION vector UPDATE');
  });

  it('sends the walk without the setting to a library that has none, and answers', async () => {
    const sent: string[] = [];
    const query = plain.query.bind(plain);
    plain.query = ((sql: string, params?: unknown[]) => {
      sent.push(sql);
      if (sql.includes(`current_setting('hnsw.iterative_scan'`)) return Promise.resolve([{ mode: null, catalog: '0.7.4' }]);
      return query(sql, params);
    }) as typeof plain.query;
    try {
      // a store's answer is kept: this one is asked for the first time here
      const unasked = Object.create(plain) as Store;
      const results = await search(unasked, embedder, 'anything', { k: 4, mode: 'vector', track: false, current: false, exactSide: 0 });
      expect(results.map((r) => r.chunkId)).toEqual(['c1']);
    } finally {
      plain.query = query;
    }
    const vector = sent.filter((sql) => sql.includes('<=>'));
    expect(vector).toHaveLength(1);
    expect(vector[0]).not.toContain('set_config');
  });
});

describe('the graph channel with generated pages', () => {
  // No chunk text holds the query and no chunk has a vector: only the graph channel answers. Thirty
  // pages mention both entities the question names, six reports mention one — every page outweighs
  // every report, and the channel's 24 candidates were pages.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-generated-graph-'));
  let graph: Store;
  const pages = Array.from({ length: 30 }, (_, i) => `g${String(i + 1).padStart(2, '0')}`);
  const reports = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];

  beforeAll(async () => {
    fs.mkdirSync(path.join(dir, '.knode'), { recursive: true });
    graph = await Store.open(dir, embedder.dimensions);
    await graph.indexing;
    const add = async (id: string, file: string, root: string, kind: string) => {
      await graph.query(`INSERT INTO documents (id, path, root, kind, title, sha256, bytes, status) VALUES ($1, $2, $3, $4, $1, $5, 10, 'indexed')`, [`d-${id}`, file, root, kind, `sha-${id}`]);
      await graph.query(`INSERT INTO chunks (id, document_id, seq, content, token_count, tsv) VALUES ($1, $2, 0, $3, 3, to_tsvector('simple', $3))`, [id, `d-${id}`, `Field notes ${id}.`]);
    };
    for (const id of pages) await add(id, `wiki/entities/${id}.md`, 'wiki', 'view');
    for (const id of reports) await add(id, `raw/docs/${id}.md`, 'docs', 'source');
    const entity = async (id: string, name: string, chunks: string[]) => {
      await graph.query(`INSERT INTO entities (id, name, type, mention_count) VALUES ($1, $2, 'concept', $3)`, [id, name, chunks.length]);
      await graph.query(`INSERT INTO entity_alias_keys (entity_id, alias_key) VALUES ($1, $2)`, [id, name.toLowerCase()]);
      for (const c of chunks) await graph.query(`INSERT INTO entity_mentions (entity_id, chunk_id, document_id) VALUES ($1, $2, $3)`, [id, c, `d-${c}`]);
    };
    await entity('e-kestrel', 'Kestrel', [...pages, ...reports]);
    await entity('e-borealis', 'Borealis', pages);
  });

  afterAll(async () => {
    if (graph) await graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists the chunks of sources that mention the named entities beside the pages that do', async () => {
    const results = await search(graph, embedder, 'Kestrel and Borealis', { k: 8, track: false, current: false, explain: true });
    const found = results.map((r) => r.chunkId);
    // the two best pages by id, where the channel ranks them, then the six reports by id
    expect(found).toEqual(['g01', 'g02', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
    // one list by the channel's own weight: a report ranks behind all 24 pages listed, not behind the two shown
    expect(results.map((r) => r.ranks?.graph)).toEqual([1, 2, 25, 26, 27, 28, 29, 30]);
    expect(results[0].signals.graph!).toBeGreaterThan(results[2].signals.graph!);
    expect(new Set(results.slice(2).map((r) => r.signals.graph)).size).toBe(1);
  });

  it('lists 24 of each side at most, and the pages alone when pages are asked for', async () => {
    const wide = await search(graph, embedder, 'Kestrel and Borealis', { k: 40, track: false, current: false, generatedShare: 1 });
    // a search for 40 asks each side for 120: all thirty pages and the six reports
    expect(wide).toHaveLength(36);
    const views = await search(graph, embedder, 'Kestrel and Borealis', { k: 8, track: false, current: false, filter: resolveScopeFilter({ kinds: ['view'] }) });
    expect(views.map((r) => r.chunkId)).toEqual(pages.slice(0, 8));
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
