import type { EmbeddingProvider } from '../../src/ingest/embeddings.js';
import { search } from '../../src/search/search.js';
import { Store, toVectorLiteral } from '../../src/store/db.js';

/**
 * A small workspace for comparing search before and after a store's substring
 * indexes are ready (src/store/grams.ts): chunks of CJK and English text with
 * terms rare and common, vectors, and entities mentioned in them, so a hybrid
 * search runs all three channels. Used on PGlite and on PostgreSQL alike.
 */

export const KEYWORD_CORPUS_DIM = 4;

/** The query's vector; each chunk's leans away from it by its place in the corpus, so the vector channel has no ties. */
export class FixedEmbedder implements EmbeddingProvider {
  readonly model = 'fixture-v1';
  readonly dimensions = KEYWORD_CORPUS_DIM;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0, 0, 0]);
  }
}

const CHUNKS: [string, string][] = [
  ['k01', '据报道，宁德时代的储能业务增长很快，订单饱满。'],
  ['k02', '宁德时代发布了新电池。'],
  ['k03', '公司储能业务是重点方向。'],
  ['k04', '新时代的变化。'],
  ['k05', '海力士的HBM3E通过认证，HBM4在量产。'],
  ['k06', '海力士扩产，hbm4订单增加。'],
  ['k07', '三星的Hbm3e认证延后。'],
  ['k08', '编号r_6f406e239a的课题。'],
  ['k09', '编号rx6f406e239a的课题，在café里讨论。'],
  ['n01', 'The Nintendo Entertainment System held each developer to five games a year.'],
  ...Array.from({ length: 30 }, (_, i): [string, string] => [`n1${String(i).padStart(2, '0')}`, `Report ${i}: what was the limit on items per year for the platform, and who set the limit for the year.`]),
  ...Array.from({ length: 50 }, (_, i): [string, string] => [`t${String(50 - i).padStart(3, '0')}`, `第${i}条：业务往来记录${'。'.repeat(i % 7)}`]),
];

export async function seedKeywordCorpus(store: Store): Promise<void> {
  for (const [n, [id, content]] of CHUNKS.entries()) {
    const doc = `d-${id}`;
    await store.query(
      `INSERT INTO documents (id, path, root, title, sha256, bytes, status) VALUES ($1, $2, 'docs', $1, $3, 10, 'indexed')`,
      [doc, `raw/docs/${doc}.md`, `sha-${doc}`],
    );
    await store.query(
      `INSERT INTO chunks (id, document_id, seq, content, token_count, tsv) VALUES ($1, $2, 0, $3, 3, to_tsvector('simple', $3))`,
      [id, doc, content],
    );
    await store.query(`INSERT INTO embeddings (chunk_id, model, embedding) VALUES ($1, 'fixture-v1', $2)`, [id, toVectorLiteral([1, (n + 1) / 100, 0, 0])]);
  }
  const entities: [string, string, string[]][] = [
    ['e-catl', '宁德时代', ['k01', 'k02']],
    ['e-hbm', 'HBM', ['k05', 'k06', 'k07']],
    ['e-storage', '储能', ['k01', 'k03']],
  ];
  for (const [id, name, chunks] of entities) {
    await store.query(`INSERT INTO entities (id, name, type, mention_count) VALUES ($1, $2, 'concept', $3)`, [id, name, chunks.length]);
    for (const chunk of chunks) {
      await store.query(`INSERT INTO entity_mentions (entity_id, chunk_id, document_id) VALUES ($1, $2, $3)`, [id, chunk, `d-${chunk}`]);
    }
  }
}

export const KEYWORD_QUERIES = [
  '宁德时代的储能业务',
  '海力士 HBM3E 认证',
  'hbm4 量产',
  "What was Nintendo's limit on games per developer per year for the platform?",
  'year',
  'year -report',
  'r_6f406e239a',
  // a term no gram index serves: answered by a scan whichever indexes are ready
  'café 课题',
];

export interface Ranking {
  query: string;
  mode: 'keyword' | 'hybrid';
  results: { id: string; score: number; keyword?: number; graph?: number }[];
}

/** Every query, in keyword and in hybrid mode: each result's id, score and channel scores, in order. */
export async function rankAll(store: Store, embedder: EmbeddingProvider, k = 12): Promise<Ranking[]> {
  const out: Ranking[] = [];
  for (const query of KEYWORD_QUERIES) {
    for (const mode of ['keyword', 'hybrid'] as const) {
      const results = await search(store, embedder, query, { mode, k, track: false });
      out.push({ query, mode, results: results.map((r) => ({ id: r.chunkId, score: r.score, keyword: r.signals.keyword, graph: r.signals.graph })) });
    }
  }
  return out;
}
