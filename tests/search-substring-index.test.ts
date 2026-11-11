import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { graphSearch } from '../src/graph/query.js';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import { keywordTerms, queryTerms, search, termCount } from '../src/search/search.js';
import { Store } from '../src/store/db.js';
import { gramQuery, MATCH_INDEXES, termGrams } from '../src/store/grams.js';

/**
 * Substring matching through the gram index (src/store/grams.ts): the
 * candidates of keyword recall, and the entity name / alias matching of the
 * graph signal, SAG and graph search. The index only narrows; the text
 * decides. So with the index and without it, keyword recall finds the same
 * chunks, and entity matching the ones `ILIKE '%term%'` gave.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-substring-index-'));

class FixtureEmbedder implements EmbeddingProvider {
  readonly model = 'fixture-v1';
  readonly dimensions = 4;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0, 0, 0]);
  }
}

const embedder = new FixtureEmbedder();
let store: Store;
const corpus: { id: string; content: string }[] = [];

async function addChunk(id: string, content: string, status = 'indexed'): Promise<void> {
  const doc = `d-${id}`;
  await store.query(
    `INSERT INTO documents (id, path, root, title, sha256, bytes, status) VALUES ($1, $2, 'docs', $1, $3, 10, $4)`,
    [doc, `raw/docs/${doc}.md`, `sha-${doc}`, status],
  );
  await store.query(
    `INSERT INTO chunks (id, document_id, seq, content, token_count, tsv) VALUES ($1, $2, 0, $3, 3, to_tsvector('simple', $3))`,
    [id, doc, content],
  );
  if (status === 'indexed') corpus.push({ id, content });
}

/** The chunks keyword recall can return for a query: the ones holding at least one of its terms. */
function holders(query: string): string[] {
  const terms = keywordTerms(query);
  return corpus.filter((c) => terms.some((t) => termCount(c.content.toLowerCase(), t) > 0)).map((c) => c.id).sort();
}

async function keywordRanking(query: string, k: number): Promise<{ id: string; score: number }[]> {
  const results = await search(store, embedder, query, { mode: 'keyword', k, track: false });
  return results.map((r) => ({ id: r.chunkId, score: r.signals.keyword! }));
}

const idsOf = (ranked: { id: string }[]) => ranked.map((r) => r.id);

/** Run `fn` as if the indexes were still being built. */
async function withoutIndexes<T>(fn: () => Promise<T>): Promise<T> {
  const ready = [...store.matchIndexes];
  store.matchIndexes.clear();
  try {
    return await fn();
  } finally {
    for (const name of ready) store.matchIndexes.add(name);
  }
}

/** The plan of every statement `fn` sends that matches `pattern`, with sequential scans priced out. */
async function plansOf(pattern: string, fn: () => Promise<unknown>): Promise<string[]> {
  const sent: { sql: string; params?: unknown[] }[] = [];
  const query = store.query.bind(store);
  store.query = (async (sql: string, params?: unknown[]) => {
    sent.push({ sql, params });
    return query(sql, params);
  }) as typeof store.query;
  try {
    await fn();
  } finally {
    store.query = query;
  }
  const plans: string[] = [];
  // the state autovacuum keeps a workspace in: statistics (a table the planner believes empty is
  // read any way at all) and the rows inserted since the indexes were built merged into them
  await store.query(`VACUUM ANALYZE chunks, documents, entities, entity_mentions, entity_alias_keys`);
  await store.query(`SET enable_seqscan = off`);
  try {
    for (const { sql, params } of sent.filter((s) => s.sql.includes(pattern))) {
      const rows = await store.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params);
      plans.push(rows.map((r) => r['QUERY PLAN']).join('\n'));
    }
  } finally {
    await store.query(`RESET enable_seqscan`);
  }
  return plans;
}

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, '.knode'), { recursive: true });
  store = await Store.open(tmp, embedder.dimensions);
  expect(await store.indexing).toEqual({ built: [MATCH_INDEXES.entities.name, MATCH_INDEXES.chunks.name], seconds: expect.any(Number) });

  // CJK text in runs no query term spells out whole, so full-text search finds nothing and the substring fallback answers
  await addChunk('k01', '据报道，宁德时代的储能业务增长很快，订单饱满。');
  await addChunk('k02', '宁德时代发布了新电池。');
  await addChunk('k03', '公司储能业务是重点方向。');
  await addChunk('k04', '新时代的变化。');
  await addChunk('k05', '海力士的HBM3E通过认证，HBM4在量产。');
  await addChunk('k06', '海力士扩产，hbm4订单增加。');
  await addChunk('k07', '三星的Hbm3e认证延后。');
  await addChunk('k08', '编号r_6f406e239a的课题。');
  await addChunk('k09', '编号rx6f406e239a的课题。');
  await addChunk('k10', '天气晴朗，无关的内容。');
  // the same text in a document that is not indexed never answers
  await addChunk('k11', '据报道，宁德时代的储能业务增长很快。', 'pending');
  // an English question's one rare name, and 40 chunks that repeat the rest of its words
  await addChunk('n01', 'The Nintendo Entertainment System held each developer to five games a year.');
  for (let i = 0; i < 40; i++) await addChunk(`n1${String(i).padStart(2, '0')}`, `Report ${i}: what was the limit on items per year for the platform, and who set the limit for the year.`);
  // 60 chunks holding one common term each
  for (let i = 0; i < 60; i++) await addChunk(`t${String(60 - i).padStart(3, '0')}`, `第${i}条：业务往来记录。`);
});

afterAll(async () => {
  if (store) await store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the grams a term needs', () => {
  it('are bigrams of a CJK term, trigrams of a longer Latin one, and a two-letter token itself', () => {
    expect(termGrams('宁德时代')).toEqual(['宁德', '德时', '时代']);
    expect(termGrams('HBM3E')).toEqual(['hbm', 'bm3', 'm3e']);
    expect(termGrams('AI')).toEqual(['ai']);
    expect(termGrams('2026-10-28')).toEqual(['202', '026', '26-', '6-1', '-10', '10-', '0-2', '-28']);
    // outside the classes match_grams indexes: nothing an index could look up
    expect(termGrams('ＡＢ')).toEqual([]);
    expect(termGrams('a b')).toEqual([]);
    expect(termGrams('x')).toEqual([]);
  });

  it('are among the grams match_grams indexes for every text that holds the term', async () => {
    const texts = [
      '2026年以来存储芯片行业评论的观点演变与事后核验',
      'HBM认证、产能与竞争格局：2026年评论中三星、海力士、美光HBM3E/HBM4认证与量产',
      'Anthropic public prospectus SEC S-1 latest disclosures as of 2026-10-27',
      '截至2026-10-28，海力士、长江存储、UP Chemical的价格；对照课题r_6f406e239a',
      'Vito的行研札记与Serenity在2026年的存储行业评论时间线 $NVDA GB300 a.b-c_d',
    ];
    for (const text of texts) {
      for (const variant of [text, text.toUpperCase(), text.toLowerCase()]) {
        for (const term of queryTerms(text, 64)) {
          const [{ hit }] = await store.query<{ hit: boolean }>(`SELECT match_grams($1) @@ $2::tsquery AS hit`, [variant, gramQuery([termGrams(term)], 1)]);
          expect({ variant, term, hit }).toEqual({ variant, term, hit: true });
        }
      }
    }
  });

  it('hold for at least m of the terms', async () => {
    const terms = [['aa'], ['bb'], ['cc', 'cd'], ['dd']];
    const present = (mask: number) => ['aa', 'bb', 'cc', 'cd', 'dd'].filter((_, i) => mask & (1 << i));
    for (let m = 1; m <= terms.length; m++) {
      for (let mask = 0; mask < 32; mask++) {
        const grams = present(mask);
        const held = terms.filter((t) => t.every((g) => grams.includes(g))).length;
        const [{ hit }] = await store.query<{ hit: boolean }>(
          `SELECT array_to_tsvector($1::text[]) @@ $2::tsquery AS hit`,
          [grams, gramQuery(terms, m)],
        );
        expect({ m, grams, hit }).toEqual({ m, grams, hit: held >= m });
      }
    }
  });
});

describe('keyword recall', () => {
  it('looks its terms up in the index in a workspace never analyzed, as PGlite leaves one', async () => {
    // before any test here runs ANALYZE: without statistics a planner joining documents first read every chunk
    const sent: { sql: string; params?: unknown[] }[] = [];
    const query = store.query.bind(store);
    store.query = (async (sql: string, params?: unknown[]) => {
      sent.push({ sql, params });
      return query(sql, params);
    }) as typeof store.query;
    try {
      await keywordRanking('宁德时代的储能业务', 8);
    } finally {
      store.query = query;
    }
    const lookups = sent.filter((x) => x.sql.includes('match_grams(c.content)'));
    // one statement counts each term's chunks and lists the rarest terms'
    expect(lookups).toHaveLength(1);
    for (const { sql, params } of lookups) {
      const plan = (await store.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params)).map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toContain(MATCH_INDEXES.chunks.name);
      expect(plan).not.toMatch(/Seq Scan on chunks/);
      expect(plan).not.toMatch(/Filter: \(match_grams/);
    }
  });

  it.each([
    ['宁德时代的储能业务'],
    ['海力士 HBM3E 认证'],
    ['hbm4 量产'],
  ])('finds every chunk holding a term of %s, through the index and without it', async (query) => {
    // k = 100 asks the channel for 300, more than hold a term
    expect(idsOf(await keywordRanking(query, 100)).sort()).toEqual(holders(query));
    expect(idsOf(await withoutIndexes(() => keywordRanking(query, 100))).sort()).toEqual(holders(query));
  });

  it('puts the chunks holding the rare terms above the ones holding a common one', async () => {
    // 业务 is in 63 chunks; the company's name and 储能 in two or three
    for (const ranked of [await keywordRanking('宁德时代的储能业务', 8), await withoutIndexes(() => keywordRanking('宁德时代的储能业务', 8))]) {
      expect(ranked[0].id).toBe('k01');
      expect(idsOf(ranked.slice(0, 4)).sort()).toEqual(['k01', 'k02', 'k03', 'k04']);
      for (const r of ranked.slice(4)) expect(r.id).toMatch(/^t\d+$/);
    }
  });

  it('scores best first, and equal scores in id order', async () => {
    const ranked = await keywordRanking('宁德时代的储能业务', 100);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
      if (ranked[i - 1].score === ranked[i].score) expect(ranked[i - 1].id < ranked[i].id).toBe(true);
    }
    // the two-digit rows are one length, so they tie
    expect(new Set(ranked.filter((r) => /^t0[0-4]\d$/.test(r.id)).map((r) => r.score)).size).toBe(1);
  });

  it('answers an English question by its rare word, not by the words every chunk has', async () => {
    const question = "What was Nintendo's limit on games per developer per year for the platform?";
    expect(keywordTerms(question)).toEqual(['nintendo', 'limit', 'games', 'per', 'developer', 'year', 'platform']);
    for (const ranked of [await keywordRanking(question, 8), await withoutIndexes(() => keywordRanking(question, 8))]) {
      expect(ranked[0].id).toBe('n01');
    }
  });

  it('reads a term as literal text, an underscore included', async () => {
    // ILIKE took the underscore for any character and matched k09's x as well
    expect(idsOf(await keywordRanking('r_6f406e239a', 8))).toEqual(['k08']);
    expect(idsOf(await withoutIndexes(() => keywordRanking('r_6f406e239a', 8)))).toEqual(['k08']);
  });

  it('keeps what an exclusion or a quoted phrase matched in front', async () => {
    // the reports say "year" twice and n01 once: scored alone, they come first
    expect((await keywordRanking('year', 8))[0].id).toMatch(/^n1\d\d$/);
    expect(keywordTerms('year -report')).toEqual(['year']);
    expect((await keywordRanking('year -report', 8))[0].id).toBe('n01');
    // only n01 holds the phrase; "year" alone would again put the reports first
    expect((await keywordRanking('"games a year" year', 8))[0].id).toBe('n01');
  });

  it('answers from the index with statistics too', async () => {
    const plans = await plansOf('match_grams(c.content)', () => keywordRanking('宁德时代的储能业务', 8));
    expect(plans).toHaveLength(1);
    for (const plan of plans) {
      expect(plan).toContain(MATCH_INDEXES.chunks.name);
      expect(plan).not.toMatch(/Seq Scan on chunks/);
    }
  });
});

describe('entity matching', () => {
  const MENTIONED = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8'];

  async function addEntity(
    id: string,
    name: string,
    mentionCount: number,
    chunks: string[],
    extra: { aliases?: string[]; description?: string; retired?: boolean; keys?: string[] } = {},
  ): Promise<void> {
    await store.query(
      `INSERT INTO entities (id, name, type, mention_count, aliases, description, tx_to) VALUES ($1, $2, 'concept', $3, $4::jsonb, $5, $6)`,
      [id, name, mentionCount, JSON.stringify(extra.aliases ?? []), extra.description ?? '', extra.retired ? '2026-01-01T00:00:00Z' : null],
    );
    for (const chunk of chunks) {
      await store.query(`INSERT INTO entity_mentions (entity_id, chunk_id, document_id) VALUES ($1, $2, $3)`, [id, chunk, `d-${chunk}`]);
    }
    for (const key of extra.keys ?? []) await store.query(`INSERT INTO entity_alias_keys (entity_id, alias_key) VALUES ($1, $2)`, [id, key]);
  }

  beforeAll(async () => {
    for (const id of MENTIONED) await addChunk(id, `Field notes ${id}.`, id === 'g7' ? 'pending' : 'indexed');
    await addEntity('e-hbm', 'HBM', 50, ['g1', 'g2', 'g7']);
    await addEntity('e-storage', '储能电池', 30, ['g1', 'g3']);
    // a second scope's row for the same mention: the weight counts each row, as the join it replaces did
    await store.query(`INSERT INTO entity_mentions (entity_id, chunk_id, document_id, scope_id) VALUES ('e-storage', 'g3', 'd-g3', 'second')`);
    await addEntity('e-system', '储能系统', 45, ['g8']);
    await addEntity('e-battery', 'Battery Corp', 7, ['g4', 'g2'], { aliases: ['储能公司'] });
    await addEntity('e-hbm3e', 'HBM3E', 5, ['g5']);
    await addEntity('e-old', 'Old HBM', 99, ['g6'], { retired: true });
    await addEntity('e-other', '无关', 80, ['g1']);
    await addEntity('e-described', 'Cobalt', 3, [], { description: '储能 materials supplier' });
    // the entities no query here names, as a workspace has thousands of
    // the one entity here with lookup keys: the fixtures above are found by their terms alone
    await addEntity('e-cathode', 'Cathode Works', 2, ['g8'], { keys: ['cathodeworks'] });
    for (let i = 0; i < 300; i++) await addEntity(`e-filler-${i}`, `Filler ${i}`, 1, [], { keys: [`filler${i}`] });
  });

  /** The graph channel's order: the keyword fixtures above answer this query too, the mentioned chunks only through the graph. */
  async function graphRanking(query = '储能 HBM'): Promise<[string, number][]> {
    const results = await search(store, embedder, query, { k: 30, track: false });
    return results.filter((r) => r.signals.graph !== undefined).map((r) => [r.chunkId, r.signals.graph!]);
  }

  it('matches a query naming no entity by the entities holding its terms, the rarest first', async () => {
    // the summed IDF of the chunks each entity is mentioned in: g1 HBM (3 chunks) + 储能电池 (2);
    // g2 HBM + Battery Corp by alias (2); then HBM3E and 储能系统 (1 each, ties by id);
    // then 储能电池 and Battery Corp alone. 储能电池's two rows in g3 are one chunk;
    // g6's entity is retired, g7's document not indexed, Cobalt matches by description only
    const ranked = await graphRanking();
    expect(ranked.map(([id]) => id)).toEqual(['g1', 'g2', 'g5', 'g8', 'g3', 'g4']);
    for (let i = 1; i < ranked.length; i++) expect(ranked[i - 1][1]).toBeGreaterThanOrEqual(ranked[i][1]);
    expect(ranked[0][1]).toBeCloseTo(ranked[1][1], 12);
    expect(ranked[4][1]).toBeCloseTo(ranked[5][1], 12);
    expect(await withoutIndexes(graphRanking)).toEqual(ranked);
  });

  it('reads the entities a query names, as whole words, and only them', async () => {
    // "Works" alone is a term several fixtures could hold; the name is one entity's key
    expect((await graphRanking('Who supplies Cathode Works with HBM?')).map(([id]) => id)).toEqual(['g8']);
    expect(await graphRanking('Who supplies CathodeWorkshop?')).not.toContainEqual(['g8', expect.any(Number)]);
  });

  it('seeds graph search from a name, an alias or a description', async () => {
    const seeds = async () => (await graphSearch(store, '储能', { depth: 0, track: false })).nodes.map((n) => n.id).sort();
    expect(await seeds()).toEqual(['e-battery', 'e-described', 'e-storage', 'e-system']);
    expect(await withoutIndexes(seeds)).toEqual(await seeds());
  });

  it('looks entities up through the indexes', async () => {
    const plans = await plansOf('match_grams(e.name', () => graphRanking());
    expect(plans).toHaveLength(1);
    expect(plans[0]).toContain(MATCH_INDEXES.entities.name);
    const named = await plansOf('entity_alias_keys', () => graphRanking('Who supplies Cathode Works?'));
    expect(named).toHaveLength(1);
    expect(named[0]).toContain('entity_alias_keys_key_idx');
  });
});

describe('building the indexes', () => {
  it('builds them once: a store opened again finds them ready', async () => {
    const indexes = (await store.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`)).map((r) => r.indexname);
    expect(indexes).toEqual(expect.arrayContaining([MATCH_INDEXES.entities.name, MATCH_INDEXES.chunks.name]));
    const dir = path.join(tmp, 'again');
    fs.mkdirSync(path.join(dir, '.knode'), { recursive: true });
    const first = await Store.open(dir, embedder.dimensions);
    await first.indexing;
    await first.close();
    const second = await Store.open(dir, embedder.dimensions);
    try {
      expect(await second.indexing).toEqual({ built: [], seconds: expect.any(Number) });
      expect([...second.matchIndexes].sort()).toEqual([MATCH_INDEXES.chunks.name, MATCH_INDEXES.entities.name]);
    } finally {
      await second.close();
    }
  });
});
