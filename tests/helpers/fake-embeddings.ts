import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

/**
 * A stand-in for an OpenAI-compatible `/embeddings` endpoint, for the embed
 * work tests (src/work/embed.ts, worker/knode-worker.mjs). Each text's vector
 * is a pure function of the text and the endpoint's `space`: two endpoints in
 * one space make the same vectors (up to `noise`), two spaces unrelated ones.
 * Vectors come back raw — scaled, not unit length — so a test sees the server
 * finish them.
 */

export interface EmbedRequest {
  model?: string;
  input?: string[] | string;
  encoding_format?: string;
  dimensions?: number;
  provider?: unknown;
}

export interface FakeEmbeddings {
  url: string;
  /** Every request body received. */
  calls: EmbedRequest[];
  /** Texts embedded so far. */
  texts: () => number;
  close: () => Promise<void>;
}

export interface FakeEmbeddingsOptions {
  dimensions?: number;
  /** Which vector space it embeds in: endpoints of one space agree. */
  space?: string;
  /** The model its answers name (default: the one asked for). */
  model?: string;
  /** Relative noise added to each vector, seeded by the text (default 0). */
  noise?: number;
  /** Answer with this HTTP status instead. */
  status?: () => number | undefined;
  /** Stall every request this long. */
  delayMs?: number;
}

/** The vector `space` gives `text`, raw (length about 3·√dims/√3). */
export function fakeVector(text: string, dims: number, space = 'bge-m3', noise = 0): number[] {
  const out: number[] = [];
  let block = 0;
  while (out.length < dims) {
    const h = crypto.createHash('sha256').update(`${space}\u0000${text}\u0000${block++}`).digest();
    for (let i = 0; i + 4 <= h.length && out.length < dims; i += 4) out.push(((h.readUInt32LE(i) / 0xffffffff) * 2 - 1) * 3);
  }
  if (noise > 0) {
    let block2 = 0;
    const n: number[] = [];
    while (n.length < dims) {
      const h = crypto.createHash('sha256').update(`noise\u0000${text}\u0000${block2++}`).digest();
      for (let i = 0; i + 4 <= h.length && n.length < dims; i += 4) n.push((h.readUInt32LE(i) / 0xffffffff) * 2 - 1);
    }
    return out.map((x, i) => x + noise * 3 * n[i]);
  }
  return out;
}

export async function startFakeEmbeddings(opts: FakeEmbeddingsOptions = {}): Promise<FakeEmbeddings> {
  const dims = opts.dimensions ?? 1024;
  const calls: EmbedRequest[] = [];
  let texts = 0;
  const app = new Hono();
  app.get('/v1/models', (c) => c.json({ object: 'list', data: [{ id: opts.model ?? 'bge-m3', object: 'model' }] }));
  app.post('/v1/embeddings', async (c) => {
    const body = (await c.req.json()) as EmbedRequest;
    calls.push(body);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const status = opts.status?.();
    if (status) return c.json({ error: { message: 'refused (and this body would echo sk-secret)' } }, status as 429);
    const input = Array.isArray(body.input) ? body.input : [String(body.input ?? '')];
    texts += input.length;
    const tokens = input.reduce((n, t) => n + Math.ceil(t.length / 2) + 2, 0);
    return c.json({
      object: 'list',
      model: opts.model ?? body.model,
      data: input.map((t, index) => ({ object: 'embedding', index, embedding: fakeVector(t, dims, opts.space, opts.noise) })),
      usage: { prompt_tokens: tokens, total_tokens: tokens },
    });
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    calls,
    texts: () => texts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
