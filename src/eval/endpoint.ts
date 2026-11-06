import { createEmbeddingProvider, EmbeddingProvider } from '../ingest/embeddings.js';
import { docText, LoadedPack } from './pack.js';
import { chunkDocs } from './retrieval.js';
import { VectorCache, vectorKey } from './shim.js';

/**
 * An OpenAI-compatible embedding endpoint of the run's own (`--embedding-endpoint`,
 * a local bge-m3, say) standing in for the workspace's embedder: it embeds under
 * that embedder's identity, so the vectors the run already holds stay valid, and
 * only once it has shown that it reproduces them (`checkEndpoint`).
 */

/** Cosine every check text must reach. bge-m3 on its own hardware reaches 0.9999 against the pool. */
export const ENDPOINT_MIN_COSINE = 0.999;

/** Texts with held vectors a check needs, so that it says something. */
const MIN_CHECK_TEXTS = 5;

function unit(v: number[]): number[] {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

/** The endpoint as an embedder under `identity`'s model and dimensions, L2-normalized as a pool's vectors are. */
export function endpointUnder(identity: EmbeddingProvider, baseUrl: string, model = 'bge-m3'): EmbeddingProvider {
  const endpoint = createEmbeddingProvider({ provider: 'openai', baseUrl, apiKey: '', model, dimensions: identity.dimensions, batchSize: 32, sendDimensions: false });
  return {
    model: identity.model,
    dimensions: identity.dimensions,
    embed: async (texts) => (await endpoint.embed(texts)).map(unit),
  };
}

/**
 * Refuse an endpoint that does not reproduce the run's vectors: chunk texts the
 * run embedded under the identity, up to 8 from each pack, must each come back at
 * `ENDPOINT_MIN_COSINE` or more. Returns the lowest cosine.
 */
export async function checkEndpoint(embedder: EmbeddingProvider, vectors: VectorCache, packs: LoadedPack[], minCosine = ENDPOINT_MIN_COSINE): Promise<{ texts: number; lowest: number }> {
  const probes: { text: string; v: number[] }[] = [];
  for (const pack of packs) {
    let taken = 0;
    for (const c of chunkDocs(pack.docs.slice(0, 40).map((d) => ({ path: d.path, text: docText(pack, d.path) })))) {
      const v = vectors.get(vectorKey(embedder.model, c.text));
      if (!v) continue;
      probes.push({ text: c.text, v });
      if (++taken === 8) break;
    }
  }
  if (probes.length < MIN_CHECK_TEXTS) throw new Error(`the embedding endpoint can be checked against only ${probes.length} texts with vectors under ${embedder.model}; it needs ${MIN_CHECK_TEXTS}`);
  const mine = await embedder.embed(probes.map((p) => p.text));
  const cosines = probes.map((p, i) => {
    const a = unit(p.v);
    return unit(mine[i]).reduce((s, x, j) => s + x * a[j], 0);
  });
  const lowest = Math.min(...cosines);
  if (!(lowest >= minCosine)) throw new Error(`the embedding endpoint does not reproduce ${embedder.model}: cosine ${lowest.toFixed(4)} on one of ${probes.length} texts, under ${minCosine}`);
  return { texts: probes.length, lowest };
}
