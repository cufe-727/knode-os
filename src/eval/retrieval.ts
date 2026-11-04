import type { EmbeddingProvider } from '../ingest/embeddings.js';
import { searchTokens } from './metrics/text.js';

/**
 * In-memory retrieval for the RAG baselines and for scoring (coverage looks
 * up the units of a generated knowledge base with the same retrievers, so no
 * system's own index decides what counts as covered). BM25 tokenizes CJK as
 * character bigrams, like knode's own keyword channel.
 */

export interface Chunk {
  id: string;
  doc: string;
  seq: number;
  text: string;
}

/** Split documents into chunks of about `size` characters, cutting at paragraph and sentence ends. */
export function chunkDocs(docs: { path: string; text: string }[], opts: { size?: number; overlap?: number } = {}): Chunk[] {
  const size = opts.size ?? 1200;
  const overlap = opts.overlap ?? 150;
  const out: Chunk[] = [];
  for (const d of docs) {
    const text = d.text.replace(/\r\n/g, '\n');
    let start = 0;
    let seq = 0;
    while (start < text.length) {
      let end = Math.min(text.length, start + size);
      if (end < text.length) {
        const window = text.slice(start, end);
        const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('。'), window.lastIndexOf('. '), window.lastIndexOf('\n'));
        if (cut > size * 0.5) end = start + cut + 1;
      }
      const piece = text.slice(start, end).trim();
      if (piece) out.push({ id: `${d.path}#${seq}`, doc: d.path, seq: seq++, text: piece });
      if (end >= text.length) break;
      start = Math.max(end - overlap, start + 1);
    }
  }
  return out;
}

export interface Hit<T> {
  item: T;
  score: number;
}

export class Bm25<T> {
  private readonly docs: { item: T; tf: Map<string, number>; len: number }[] = [];
  private readonly df = new Map<string, number>();
  private avgLen = 0;

  constructor(items: T[], text: (item: T) => string, private readonly k1 = 1.2, private readonly b = 0.75) {
    let total = 0;
    for (const item of items) {
      const toks = searchTokens(text(item));
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ item, tf, len: toks.length });
      total += toks.length;
    }
    this.avgLen = this.docs.length ? total / this.docs.length : 0;
  }

  search(query: string, k = 10): Hit<T>[] {
    const q = [...new Set(searchTokens(query))];
    const n = this.docs.length;
    const scored: Hit<T>[] = [];
    for (const d of this.docs) {
      let s = 0;
      for (const t of q) {
        const f = d.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        s += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / (this.avgLen || 1)));
      }
      if (s > 0) scored.push({ item: d.item, score: s });
    }
    return scored.sort((x, y) => y.score - x.score).slice(0, k);
  }
}

export class VectorIndex<T> {
  private constructor(private readonly items: T[], private readonly vectors: number[][], private readonly embedder: EmbeddingProvider) {}

  static async build<T>(items: T[], text: (item: T) => string, embedder: EmbeddingProvider, batch = 16): Promise<VectorIndex<T>> {
    const vectors: number[][] = [];
    for (let i = 0; i < items.length; i += batch) vectors.push(...(await embedder.embed(items.slice(i, i + batch).map(text))));
    return new VectorIndex(items, vectors.map(normalize), embedder);
  }

  async search(query: string, k = 10): Promise<Hit<T>[]> {
    const [q] = await this.embedder.embed([query]);
    const qv = normalize(q);
    return this.items
      .map((item, i) => ({ item, score: dot(qv, this.vectors[i]) }))
      .sort((x, y) => y.score - x.score)
      .slice(0, k);
  }
}

function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Reciprocal rank fusion of ranked id lists (k = 60, as knode's hybrid search). */
export function rrf(lists: string[][], k = 60): string[] {
  const score = new Map<string, number>();
  for (const list of lists) list.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
