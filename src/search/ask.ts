import { KnodeConfig } from '../config.js';
import { EmbeddingProvider } from '../ingest/embeddings.js';
import { LlmClient } from '../llm/client.js';
import { Store } from '../store/db.js';
import { SearchResult } from '../types.js';
import { graphSearch } from '../graph/query.js';
import { search } from './search.js';

export interface AskResult {
  answer: string;
  citations: { ref: number; path: string; chunkId: string }[];
  gaps: string[];
  contexts: SearchResult[];
}

const ASK_SYSTEM = `You answer questions from a personal knowledge base. You are given retrieved context chunks, each tagged [n].

Rules:
- Answer in the question's language, concise but complete.
- Cite evidence inline as [n] after the claims it supports. Only cite chunks you actually used.
- If the context is insufficient or contradictory, say so explicitly.
- End with a JSON line: {"citations":[n,...],"gaps":["what the knowledge base is missing to answer better", ...]} (gaps may be empty).`;

/**
 * RAG answer with citations and explicit gap analysis (gbrain's `think`):
 * hybrid retrieval + graph expansion → budgeted context → cited synthesis.
 */
export async function ask(
  store: Store,
  config: KnodeConfig,
  embedder: EmbeddingProvider,
  llm: LlmClient,
  question: string,
  opts: { k?: number } = {},
): Promise<AskResult> {
  const k = opts.k ?? 8;
  const [hybrid, graph] = await Promise.all([
    search(store, embedder, question, { k, mode: 'hybrid' }),
    graphSearch(store, question, { depth: 2, chunkLimit: 4 }),
  ]);
  const seen = new Set(hybrid.map((r) => r.chunkId));
  const contexts = [...hybrid, ...graph.chunks.filter((c) => !seen.has(c.chunkId))].slice(0, k + 4);

  if (!llm.enabled) {
    return {
      answer: 'LLM is not configured (set llm.model in knode.config.json) — returning retrieved context only.',
      citations: contexts.map((c, i) => ({ ref: i + 1, path: c.path, chunkId: c.chunkId })),
      gaps: [],
      contexts,
    };
  }

  const contextBlock = contexts
    .map((c, i) => `[${i + 1}] (${c.path})\n${c.content.slice(0, 1500)}`)
    .join('\n\n');
  const raw = await llm.complete([
    { role: 'system', content: ASK_SYSTEM },
    { role: 'user', content: `# Context\n${contextBlock}\n\n# Question\n${question}` },
  ], { maxTokens: 1500 });

  let answer = raw.trim();
  let gaps: string[] = [];
  let cited: number[] = [];
  const jsonMatch = answer.match(/\{["']citations["'][\s\S]*\}\s*$/);
  if (jsonMatch) {
    try {
      const meta = JSON.parse(jsonMatch[0]) as { citations?: number[]; gaps?: string[] };
      cited = (meta.citations ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= contexts.length);
      gaps = (meta.gaps ?? []).map(String).slice(0, 5);
      answer = answer.slice(0, jsonMatch.index).trim();
    } catch {
      /* keep raw answer */
    }
  }
  if (cited.length === 0) {
    cited = [...new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))].filter((n) => n >= 1 && n <= contexts.length);
  }
  return {
    answer,
    citations: cited.map((n) => ({ ref: n, path: contexts[n - 1].path, chunkId: contexts[n - 1].chunkId })),
    gaps,
    contexts,
  };
}
