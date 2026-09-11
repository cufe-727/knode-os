import crypto from 'node:crypto';
import { EmbeddingConfig, resolveSecret } from '../config.js';
import { EMBED_INPUT_CHARS } from '../constants.js';

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Calls any OpenAI-compatible `/embeddings` endpoint (OpenAI, Azure, Ollama,
 * vLLM, SiliconFlow, …). Configure baseUrl/model/dimensions in knode.config.json.
 */
class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly batchSize: number;
  private readonly sendDimensions: boolean;

  constructor(cfg: EmbeddingConfig) {
    this.model = cfg.model;
    this.dimensions = cfg.dimensions;
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.apiKey = resolveSecret(cfg.apiKey);
    this.batchSize = Math.max(1, cfg.batchSize);
    this.sendDimensions = Boolean(cfg.sendDimensions);
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize).map((t) => t.slice(0, EMBED_INPUT_CHARS) || ' ');
      const json = await this.embedBatch(batch);
      const sorted = [...json.data].sort((a, b) => a.index - b.index);
      for (const d of sorted) out.push(d.embedding);
    }
    return out;
  }

  /** One batch request, with exponential backoff on rate limits / transient 5xx. */
  private async embedBatch(batch: string[]): Promise<{ data: { index: number; embedding: number[] }[] }> {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.model, input: batch, ...(this.sendDimensions ? { dimensions: this.dimensions } : {}) }),
      });
      if (res.ok) return (await res.json()) as { data: { index: number; embedding: number[] }[] };
      const body = await res.text();
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= MAX_ATTEMPTS) {
        throw new Error(`embedding request failed (${res.status}): ${body.slice(0, 300)}`);
      }
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt)));
    }
  }
}

/**
 * Offline fallback: feature-hashing bag-of-words embedding (words + character
 * bigrams for CJK), L2-normalized. No network, no key, deterministic. Quality
 * is far below a real model — configure `embedding.provider: "openai"` for
 * production use — but it keeps vector recall working out of the box.
 */
export class LocalHashEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'local-hash-v1';
  readonly dimensions: number;

  constructor(dimensions: number) {
    this.dimensions = dimensions;
  }

  private tokens(text: string): string[] {
    const lower = text.toLowerCase();
    const words = lower.match(/[a-z0-9_]+/g) ?? [];
    const cjk = lower.match(/[一-鿿぀-ヿ가-힯]/g) ?? [];
    const bigrams: string[] = [];
    for (let i = 0; i < cjk.length; i++) {
      bigrams.push(cjk[i]);
      if (i + 1 < cjk.length) bigrams.push(cjk[i] + cjk[i + 1]);
    }
    return [...words, ...bigrams];
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const v = new Float64Array(this.dimensions);
      for (const tok of this.tokens(text)) {
        const h = crypto.createHash('md5').update(tok).digest();
        const idx = h.readUInt32BE(0) % this.dimensions;
        const sign = h[4] & 1 ? 1 : -1;
        v[idx] += sign;
      }
      let norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      if (norm === 0) norm = 1;
      return Array.from(v, (x) => x / norm);
    });
  }
}

export function createEmbeddingProvider(cfg: EmbeddingConfig): EmbeddingProvider {
  if (cfg.provider === 'openai') return new OpenAIEmbeddingProvider(cfg);
  return new LocalHashEmbeddingProvider(cfg.dimensions);
}
