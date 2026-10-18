import crypto from 'node:crypto';
import { EmbeddingConfig, resolveSecret } from '../config.js';
import { EMBED_INPUT_CHARS } from '../constants.js';
import { pluginRegistry } from '../plugins/registry.js';

/**
 * What the Index stage, the duplicate audits and search embed with. The
 * built-in providers are below; `createEmbeddingProvider` picks one — or one a
 * plugin registered — by the config's `provider` (docs/design/11).
 */
export interface EmbeddingProvider {
  /** Identity of the vector space; vectors are only comparable within one model. */
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Calls any OpenAI-compatible `/embeddings` endpoint (OpenAI, Azure, Ollama,
 * vLLM, SiliconFlow, …). Configure baseUrl/model/dimensions in knode.config.json.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
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
    return (await postWithRetry(`${this.baseUrl}/embeddings`, this.apiKey, {
      model: this.model,
      input: batch,
      ...(this.sendDimensions ? { dimensions: this.dimensions } : {}),
    })) as { data: { index: number; embedding: number[] }[] };
  }
}

/**
 * Volcengine Ark's multimodal embedding endpoint (doubao-embedding-vision-*).
 *
 * Despite the family resemblance this is not an OpenAI-compatible batch API:
 *   - the path is `/embeddings/multimodal`, and the vision models are rejected
 *     by the plain `/embeddings` route;
 *   - `input` is a list of content parts (text and images) belonging to ONE
 *     item, and they are FUSED into a single vector — passing N texts returns
 *     one vector, not N;
 *   - the response carries `data.embedding`, not `data[].embedding`.
 *
 * So each text costs one request, and `batchSize` is reused as the concurrency
 * window over those requests. Keeping the same contract as the OpenAI provider
 * means images can later be embedded into the same space by sending an
 * `image_url` part instead.
 */
export class ArkMultimodalEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly concurrency: number;
  private readonly sendDimensions: boolean;

  constructor(cfg: EmbeddingConfig) {
    this.model = cfg.model;
    this.dimensions = cfg.dimensions;
    this.url = `${cfg.baseUrl.replace(/\/+$/, '')}/embeddings/multimodal`;
    this.apiKey = resolveSecret(cfg.apiKey);
    this.concurrency = Math.max(1, cfg.batchSize);
    this.sendDimensions = Boolean(cfg.sendDimensions);
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out = new Array<number[]>(texts.length);
    let cursor = 0;
    // `cursor++` is atomic between awaits on the single JS thread, so these
    // workers hand out each index exactly once.
    const worker = async () => {
      for (let i = cursor++; i < texts.length; i = cursor++) out[i] = await this.embedOne(texts[i]);
    };
    const workers = Math.min(this.concurrency, texts.length);
    await Promise.all(Array.from({ length: workers }, worker));
    return out;
  }

  private async embedOne(text: string): Promise<number[]> {
    const json = (await postWithRetry(this.url, this.apiKey, {
      model: this.model,
      input: [{ type: 'text', text: text.slice(0, EMBED_INPUT_CHARS) || ' ' }],
      ...(this.sendDimensions ? { dimensions: this.dimensions } : {}),
    })) as { data?: { embedding?: number[] } };
    const vec = json.data?.embedding;
    if (!Array.isArray(vec)) throw new Error('embedding response had no data.embedding array');
    return vec;
  }
}

/** POST JSON with exponential backoff on rate limits / transient 5xx. */
async function postWithRetry(url: string, apiKey: string, body: unknown): Promise<unknown> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return await res.json();
    const text = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      throw new Error(`embedding request failed (${res.status}): ${text.slice(0, 300)}`);
    }
    await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt)));
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

/**
 * The provider a config names, from the plugin registry. An unknown id is an
 * error rather than a quiet fallback to the hashing embedder: vectors from two
 * models in one table would make recall silently wrong.
 */
export function createEmbeddingProvider(cfg: EmbeddingConfig): EmbeddingProvider {
  const plugin = pluginRegistry().embeddingProvider(cfg.provider);
  if (!plugin) {
    const known = pluginRegistry().embeddingProviders().map((p) => p.id).join(', ');
    throw new Error(`unknown embedding provider "${cfg.provider}" (registered: ${known}) — a plugin that provides it must be listed under "plugins" in knode.config.json`);
  }
  return plugin.create(cfg);
}
