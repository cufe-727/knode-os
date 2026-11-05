import fs from 'node:fs';
import path from 'node:path';
import { Bm25, Chunk, chunkDocs, rrf, VectorIndex } from '../retrieval.js';
import { chat, SystemEnv, SystemUnderTest, taggedEmbedder } from './types.js';

/**
 * Traditional RAG: chunk the sources, retrieve the top chunks for a question
 * (BM25 with CJK bigrams, bge-m3 cosine, or both fused by RRF), and answer
 * in one call. One index per pack serves the three variants; only the hybrid
 * one answers — BM25 and vector alone are scored on retrieval.
 */

interface RagIndex {
  chunks: Chunk[];
  bm25: Bm25<Chunk>;
  vectors: VectorIndex<Chunk>;
}

const indexes = new Map<string, RagIndex>();

async function buildIndex(env: SystemEnv): Promise<RagIndex> {
  const docs = env.staged.docs.map((d) => ({ path: d.path, text: fs.readFileSync(path.join(env.staged.dir, d.path), 'utf8') }));
  const chunks = chunkDocs(docs);
  const bm25 = new Bm25(chunks, (c) => c.text);
  const vectors = await VectorIndex.build(chunks, (c) => c.text, taggedEmbedder(env, { system: 'rag', stage: 'embed' }));
  const idx = { chunks, bm25, vectors };
  indexes.set(env.workDir, idx);
  return idx;
}

async function ranked(mode: 'bm25' | 'vector' | 'hybrid', query: string, k: number, env: SystemEnv): Promise<Chunk[]> {
  const idx = indexes.get(env.workDir) ?? (await buildIndex(env));
  const byId = new Map(idx.chunks.map((c) => [c.id, c]));
  const lexical = idx.bm25.search(query, k * 3).map((h) => h.item.id);
  if (mode === 'bm25') return lexical.slice(0, k).map((id) => byId.get(id)!);
  const dense = (await idx.vectors.search(query, k * 3)).map((h) => h.item.id);
  if (mode === 'vector') return dense.slice(0, k).map((id) => byId.get(id)!);
  return rrf([lexical, dense]).slice(0, k).map((id) => byId.get(id)!);
}

function rag(mode: 'bm25' | 'vector' | 'hybrid'): SystemUnderTest {
  const id = `rag-${mode}`;
  return {
    id,
    label: { bm25: 'RAG: BM25', vector: 'RAG: dense vectors (bge-m3)', hybrid: 'RAG: BM25 + vectors (RRF)' }[mode],
    group: 'rag',
    kind: 'pipeline',
    answers: mode === 'hybrid',
    async build(env) {
      const idx = await buildIndex(env);
      return { notes: { chunks: idx.chunks.length } };
    },
    async reopen(env) {
      await buildIndex(env);
    },
    async retrieve(query, k, env) {
      return [...new Set((await ranked(mode, query, k * 2, env)).map((c) => c.doc))].slice(0, k);
    },
    async answer(task, prompt, env) {
      const top = await ranked(mode, task.question, 8, env);
      const context = top.map((c, i) => `[${i + 1}] (doc: ${c.doc})\n${c.text}`).join('\n\n');
      const text = await chat(env, { system: id, stage: 'answer', task: task.id }, [
        { role: 'system', content: `You answer questions about a document collection using the retrieved passages below. Each passage names its document.\n\n${context}` },
        { role: 'user', content: prompt },
      ]);
      return { text, retrieved: [...new Set(top.map((c) => c.doc))] };
    },
  };
}

export const ragBm25 = () => rag('bm25');
export const ragVector = () => rag('vector');
export const ragHybrid = () => rag('hybrid');
