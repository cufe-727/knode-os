import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import { chunksForTerms, search, termStats } from '../src/search/search.js';
import { excerptsForQuestion } from '../src/search/excerpts.js';
import { Store } from '../src/store/db.js';
import { resolveScopeFilter } from '../src/store/resolver.js';
import { MATCH_INDEXES } from '../src/store/grams.js';

/**
 * A term's chunks are listed off the gram index up to a cap (1,000 a term in
 * keyword recall, 400 for excerpts). The cap used to be taken before the
 * search's own conditions — live documents, the sources and kinds asked for,
 * no code unless asked — so a term that many chunks outside the search hold
 * could list none of the ones inside it: a word a repository is full of, or
 * one an archive folder repeats, found nothing in the prose or the folder the
 * search was for. The chunks outside come first here, as an import that came
 * first would leave them.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-keyword-scope-'));

const embedder = {
  model: 'fixture-v1',
  dimensions: 4,
  async embed(texts: string[]) {
    return texts.map(() => [1, 0, 0, 0]);
  },
} as EmbeddingProvider;
let store: Store;

/** `n` documents of one chunk each under `dir`, every one holding `text`. */
async function addMany(prefix: string, dir: string, root: string, n: number, text: string): Promise<void> {
  await store.query(
    `INSERT INTO documents (id, path, root, title, sha256, bytes, status)
     SELECT $1 || '-' || g, $2 || '/' || $1 || '-' || g || '.md', $3, $1 || '-' || g, 'sha-' || $1 || '-' || g, 10, 'indexed' FROM generate_series(1, $4::int) g`,
    [prefix, dir, root, n],
  );
  await store.query(
    `INSERT INTO chunks (id, document_id, seq, content, token_count, tsv)
     SELECT 'c-' || $1 || '-' || g, $1 || '-' || g, 0, $2 || ' ' || g, 3, to_tsvector('simple', $2 || ' ' || g) FROM generate_series(1, $3::int) g`,
    [prefix, text, n],
  );
}

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, '.knode'), { recursive: true });
  store = await Store.open(tmp, embedder.dimensions);
  expect((await store.indexing).built).toContain(MATCH_INDEXES.chunks.name);

  // a repository whose files all name the service, then one note about it
  await addMany('code', 'raw/codebase/harness', 'codebase', 1100, 'const kestrel = require("kestrel"); // module');
  await addMany('note', 'raw/docs/notes', 'docs', 1, 'The kestrel rollout moved to March.');
  // an archive folder that repeats a word, then one page of the team's that uses it
  await addMany('old', 'raw/docs/archive', 'docs', 1100, 'Closed ledger entry');
  await addMany('team', 'raw/docs/team', 'docs', 1, 'The ledger owner is Ana.');
  // two words that only meet outside the folder asked for, and once inside it
  await addMany('pair', 'raw/docs/archive', 'docs', 1100, 'quarterly forecast table');
  await addMany('plan', 'raw/docs/team', 'docs', 1, 'Our quarterly forecast is due Friday.');
});

afterAll(async () => {
  if (store) await store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const found = async (query: string, sources?: string[]) =>
  (await search(store, embedder, query, { mode: 'keyword', k: 5, track: false, filter: sources ? resolveScopeFilter({ sources }) : undefined })).map((r) => r.path);

describe('keyword recall for a term that is common outside the search', () => {
  it('finds the prose that holds a word a repository is full of', async () => {
    // "schedule" is in no chunk, so no chunk holds every word and the term's list is the only way in
    expect(await found('kestrel schedule')).toEqual(['raw/docs/notes/note-1.md']);
  });

  it('finds, in the folder asked for, a word another folder repeats', async () => {
    expect(await found('ledger responsibilities', ['raw/docs/team'])).toEqual(['raw/docs/team/team-1.md']);
  });

  it('finds the chunk holding two common words together in the folder asked for', async () => {
    // "budget" is in no chunk: full-text search finds nothing, and both listed terms are over the cap
    expect(await found('quarterly forecast budget', ['raw/docs/team'])).toEqual(['raw/docs/team/plan-1.md']);
  });

  it('still counts a term over every chunk: its weight is the corpus\'s, whatever the search is for', async () => {
    const { df } = await termStats(store, ['kestrel', 'ledger', 'rollout']);
    expect(df).toEqual([1000, 1000, 1]);
  });

  it('lists a bridge term\'s chunks within the search too', async () => {
    const { idf } = await termStats(store, ['ledger']);
    const rows = await chunksForTerms(store, ['ledger'], idf, 1, { exclude: [], perTerm: 2, filter: resolveScopeFilter({ sources: ['raw/docs/team'] }) });
    expect(rows.map((r) => r.path)).toEqual(['raw/docs/team/team-1.md']);
  });

  it('quotes the prose around a name a repository is full of', async () => {
    const excerpts = await excerptsForQuestion(store, 'When is the "kestrel" rollout?', [], { names: [], budget: 2000 });
    expect(excerpts.map((e) => e.path)).toEqual(['raw/docs/notes/note-1.md']);
  });
});
