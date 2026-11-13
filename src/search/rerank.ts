import { RerankConfig } from '../config.js';
import { SearchResult } from '../types.js';

/**
 * The optional rerank stage of hybrid search (docs/design/30 §4).
 *
 * Reciprocal-rank fusion orders candidates by where each channel put them,
 * never by reading the passage against the question. A cross-encoder does
 * read both, so the fused head is sent to one, and its order replaces the
 * fused order for those candidates. It is off unless configured
 * (`retrieval.rerank`), and knode-os never starts the server: point it at a
 * local bge-reranker under Hugging Face TEI, or anything that speaks the
 * Jina / Cohere `/rerank` shape (vLLM, Infinity, llama.cpp's server).
 *
 * Two request styles, either answer shape:
 *   tei     POST {url}/rerank {query, texts, truncate} → [{index, score}]
 *   openai  POST {url}/rerank {model, query, documents, top_n}
 *             → {results: [{index, relevance_score}]}
 *
 * A failure (no server, a timeout, an answer of the wrong shape) is reported
 * and the fused order stands: the stage can only reorder, never lose a hit.
 */

export interface RerankOutcome {
  results: SearchResult[];
  /** Candidates sent; 0 when the stage was off. */
  sent: number;
  ms: number;
  error?: string;
}

export function rerankEnabled(cfg: Partial<RerankConfig> | undefined): cfg is RerankConfig {
  return Boolean(cfg?.enabled && cfg.url);
}

function endpoint(url: string): string {
  const base = url.replace(/\/+$/, '');
  return /\/rerank$/.test(base) ? base : `${base}/rerank`;
}

/** `[index, score]` pairs from either answer shape. */
export function parseRerankResponse(body: unknown): [number, number][] {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === 'object'
      ? ((body as { results?: unknown; data?: unknown }).results ?? (body as { data?: unknown }).data)
      : undefined;
  if (!Array.isArray(list)) throw new Error('rerank: the answer holds no list of scores');
  return list.map((item) => {
    const o = item as { index?: unknown; score?: unknown; relevance_score?: unknown };
    const index = Number(o.index);
    const score = Number(o.relevance_score ?? o.score);
    if (!Number.isInteger(index) || !Number.isFinite(score)) throw new Error('rerank: an entry without index and score');
    return [index, score];
  });
}

/** Scores for `texts` against `query`, in the order of `texts`; NaN where the server gave none. */
export async function rerankScores(cfg: RerankConfig, query: string, texts: string[]): Promise<number[]> {
  const body = cfg.style === 'openai'
    ? { model: cfg.model || undefined, query, documents: texts, top_n: texts.length, return_documents: false }
    : { query, texts, truncate: true, raw_scores: false };
  const res = await fetch(endpoint(cfg.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(500, cfg.timeoutMs || 8000)),
  });
  if (!res.ok) throw new Error(`rerank: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const scores = new Array<number>(texts.length).fill(Number.NaN);
  for (const [i, s] of parseRerankResponse(await res.json())) if (i >= 0 && i < texts.length) scores[i] = s;
  return scores;
}

/**
 * `candidates` (in fused order) with the first `cfg.candidates` reordered by
 * the cross-encoder; the rest follow in their fused order. Each reranked hit
 * keeps its fused score and gains `signals.rerank`.
 */
export async function rerankResults(cfg: RerankConfig, query: string, candidates: SearchResult[]): Promise<RerankOutcome> {
  const started = Date.now();
  const n = Math.min(candidates.length, Math.max(1, Math.floor(cfg.candidates || 30)));
  if (n <= 1) return { results: candidates, sent: 0, ms: 0 };
  const head = candidates.slice(0, n);
  try {
    const scores = await rerankScores(cfg, query, head.map((c) => `${c.title ? `${c.title}\n` : ''}${c.content}`.slice(0, Math.max(200, cfg.maxChars || 2000))));
    if (scores.every((s) => Number.isNaN(s))) throw new Error('rerank: no candidate was scored');
    const order = head
      .map((c, i) => ({ c, i, s: scores[i] }))
      // an unscored candidate keeps its place behind the scored ones, in fused order
      .sort((a, b) => (Number.isNaN(b.s) ? -Infinity : b.s) - (Number.isNaN(a.s) ? -Infinity : a.s) || a.i - b.i);
    const reranked = order.map(({ c, s }) => (Number.isNaN(s) ? c : { ...c, signals: { ...c.signals, rerank: s } }));
    return { results: [...reranked, ...candidates.slice(n)], sent: n, ms: Date.now() - started };
  } catch (err) {
    return { results: candidates, sent: n, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}
