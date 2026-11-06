import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, EmbeddingConnection } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { pendingEmbeddings } from '../src/ingest/embed-backfill.js';
import { DEFAULT_EMBEDDING_LIMITS } from '../src/ingest/embedding-router.js';
import { EmbeddingProvider, LocalHashEmbeddingProvider } from '../src/ingest/embeddings.js';
import { sync } from '../src/ingest/sync.js';
import { WorkerIdentity } from '../src/labeling/scheduler.js';
import { search } from '../src/search/search.js';
import { WorkBroker } from '../src/work/broker.js';
import { offeredRemotely } from '../src/work/config.js';
import {
  BrokeredEmbedder, checkEmbedEndpoint, checkVectors, cosine, cutBatches, decodeVectors, embedBatchPlan, EmbedSource, encodeVectors,
  LocalEmbedSlots, localEmbedSlots, PROBE_FILE, PROBE_TEXTS, sameEmbeddingModel,
} from '../src/work/embed.js';
import { fakeVector, startFakeEmbeddings, type FakeEmbeddings } from './helpers/fake-embeddings.js';

/**
 * Embedding as leased work (src/work/embed.ts, docs/design/12 §3.3, §4.3):
 * a deferred sync leaves its vectors to a backlog that embed slots drain, the
 * audits' vectors go on the same queue, every vector is checked and finished
 * by the server, and an own endpoint's vectors are taken only after it passes
 * calibration — and only while its spot checks keep passing.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-embed-work-'));
// the pool's quota ledger is machine-wide: never the real one
process.env.KNODE_EMBEDDING_USAGE_FILE = path.join(tmp, 'embedding-usage.json');
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(30);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const unit = (v: number[]) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

/** A workspace on a bge-m3 pool whose one key is `fake`, vectors deferred or inline. */
function workspace(name: string, fake: FakeEmbeddings, mode: 'inline' | 'deferred'): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const base = defaultConfig();
  const key: EmbeddingConnection = {
    id: 'pool-a', label: 'pool a', provider: 'openai', baseUrl: fake.url, apiKey: 'sk-pool', model: 'BAAI/bge-m3',
    dimensions: 1024, batchSize: 16, sendDimensions: false, limits: { ...DEFAULT_EMBEDDING_LIMITS, requestsPerMinute: 10_000, concurrency: 8 },
  };
  fs.writeFileSync(path.join(dir, 'knode.config.json'), JSON.stringify({
    ...base,
    embeddingProviders: [key], embeddingUse: 'pool-a',
    embeddingPool: { enabled: true, model: 'bge-m3', dimensions: 1024, batchSize: 4 },
    ingest: { ...base.ingest, watch: false, embedding: mode, embedSlots: 2 },
  }));
  return dir;
}

const local: WorkerIdentity = { worker: 'mini/embed#1', backend: 'embed:local', remote: false };
const remote = (n = 1): WorkerIdentity => ({ worker: `box/gpu-1/embed#${n}`, backend: 'embed:BAAI/bge-m3', remote: true });

async function vectorRows(ctx: AppContext): Promise<{ chunk_id: string; model: string; embedding: string }[]> {
  return ctx.store.query(`SELECT chunk_id, model, embedding::text AS embedding FROM embeddings ORDER BY chunk_id`);
}

const parseVector = (literal: string) => JSON.parse(literal) as number[];

/** A document's first chunk, word for word: fake vectors match only on the very same text. */
async function chunkText(ctx: AppContext, file: string): Promise<string> {
  const [row] = await ctx.store.query<{ content: string }>(`SELECT c.content FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = $1 ORDER BY c.seq LIMIT 1`, [file]);
  return row.content;
}

describe('vectors on the wire and in the checks', () => {
  it('travel as base64 float32 and come back as they went', () => {
    const v = [[0.5, -1.25, 3], [1e-3, 2, -4]];
    expect(decodeVectors(encodeVectors(v), 2, 3).map((r) => r.map((x) => Number(x.toFixed(6))))).toEqual(v);
    expect(() => decodeVectors(encodeVectors(v), 3, 3)).toThrow(/expected 3 × 3/);
  });

  it('are checked for count, dimension, finite values and a norm, and L2-finished for a pool', () => {
    expect(checkVectors([[3, 4]], 1, 2, 'l2')).toEqual([[0.6, 0.8]]);
    expect(checkVectors([[3, 4]], 1, 2, 'none')).toEqual([[3, 4]]);
    expect(() => checkVectors([[3, 4]], 2, 2, 'l2')).toThrow(/expected 2 vectors/);
    expect(() => checkVectors([[3, 4, 5]], 1, 2, 'l2')).toThrow(/dimensions/);
    expect(() => checkVectors([[3, Number.NaN]], 1, 2, 'l2')).toThrow(/finite/);
    expect(() => checkVectors([[0, 0]], 1, 2, 'l2')).toThrow(/norm/);
  });

  it('know the pool model by its canonical name only', () => {
    for (const name of ['bge-m3', 'BAAI/bge-m3', '@cf/baai/bge-m3', 'bge-m3:latest']) expect(sameEmbeddingModel(name, 'bge-m3'), name).toBe(true);
    for (const name of ['BAAI/bge-reranker-v2-m3', 'text-embedding-3-small', 'nomic-embed-text', '']) expect(sameEmbeddingModel(name, 'bge-m3'), name).toBe(false);
  });

  it('are cut into batches the way the pool cuts them', () => {
    const plan = embedBatchPlan({
      embedding: defaultConfig().embedding,
      embeddingPool: { enabled: true, model: 'bge-m3', dimensions: 1024, batchSize: 16 },
      embeddingProviders: [
        { id: 'a', label: 'a', provider: 'openai', baseUrl: 'https://a.example/v1', apiKey: 'k', model: 'BAAI/bge-m3', dimensions: 1024, batchSize: 8, sendDimensions: false, limits: { ...DEFAULT_EMBEDDING_LIMITS, tokensPerMinute: 200 } },
        { id: 'b', label: 'b', provider: 'openai', baseUrl: 'https://b.example/v1', apiKey: 'k', model: '@cf/baai/bge-m3', dimensions: 1024, batchSize: 32, sendDimensions: false },
      ],
    });
    // the smallest member's batch size, within the smallest minute-token allowance
    expect(plan).toEqual({ batchSize: 8, tokenCeiling: 200, inputChars: 8000 });
    const batches = cutBatches(Array.from({ length: 20 }, (_, i) => `text ${i}`), plan);
    expect(batches.map((b) => b.end - b.start)).toEqual([8, 8, 4]);
    const long = cutBatches(['x'.repeat(400), 'y'.repeat(400), 'z'], plan);
    expect(long.map((b) => b.end - b.start)).toEqual([1, 2]);
  });
});

describe('the embed backlog in deferred mode', () => {
  let pool: FakeEmbeddings;
  let ctx: AppContext;
  let source: EmbedSource;
  let broker: WorkBroker;
  const logs: string[] = [];

  beforeAll(async () => {
    pool = await startFakeEmbeddings({ space: 'bge-m3' });
    ctx = await createContext(workspace('deferred', pool, 'deferred'));
    for (let i = 1; i <= 6; i++) write(ctx.dataDir, `raw/docs/n${i}.md`, `# 笔记 ${i}\n\n第${i}份文档：宁德时代与比亚迪的季度出货量对比，第${i}节。\n`);
    write(ctx.dataDir, 'raw/docs/long.md', `# Long\n\n${Array.from({ length: 40 }, (_, i) => `Paragraph ${i} about lithium prices and battery supply contracts in quarter ${i}.`).join('\n\n')}\n`);
    source = new EmbedSource({ dataDir: ctx.dataDir, store: ctx.store, config: () => ctx.config, embedder: () => ctx.embedder, log: (m) => logs.push(m) }, { idleScanMs: 0, retryMs: 0, spotCheckEvery: 1 });
    broker = new WorkBroker([source]);
  });

  afterAll(async () => {
    await broker?.stop();
    await ctx?.store.close();
    await pool?.close();
  });

  it('a deferred sync returns before any vector is made', async () => {
    const stats = await sync(ctx, {});
    // the seven documents, and the workspace's own wiki pages
    expect(stats.indexed).toBeGreaterThanOrEqual(7);
    expect(stats.chunks).toBeGreaterThan(7);
    expect(pool.texts()).toBe(0);
    expect(await vectorRows(ctx)).toEqual([]);
    expect(await pendingEmbeddings(ctx.store, ctx.embedder.model)).toBe(stats.chunks);
    // the document is keyword-searchable at once
    expect((await search(ctx.store, ctx.embedder, '季度出货量', { mode: 'keyword', track: false })).length).toBeGreaterThan(0);
    expect(offeredRemotely(ctx.config, 'embed')).toBe(true);
    expect(localEmbedSlots(ctx.config)).toBe(2);
  });

  it('checks every batch, finishes its vectors and drops one whose identity changed', async () => {
    const [task] = await broker.lease(local, ['embed'], 1);
    expect(task).toMatchObject({ kind: 'embed', vectorModel: 'pool:bge-m3:1024:l2-v1', dimensions: 1024, credential: null });
    if (task.kind !== 'embed') throw new Error('not an embed task');
    expect(task.inputs.length).toBeLessThanOrEqual(4);
    // a short answer is a bad answer: the batch goes out again
    expect(await broker.complete(task.id, local, { ok: true, text: '', vectors: task.inputs.slice(1).map((t) => fakeVector(t, 1024)) })).toEqual({ accepted: true });
    const [again] = await broker.lease(local, ['embed'], 1);
    if (again.kind !== 'embed') throw new Error('not an embed task');
    expect(again.inputs).toEqual(task.inputs);
    // raw vectors are L2-finished as the pool would finish them
    const raw = again.inputs.map((t) => fakeVector(t, 1024));
    expect(await broker.complete(again.id, local, { ok: true, text: '', vectors: raw })).toEqual({ accepted: true, vectorsWritten: again.inputs.length });
    const rows = await vectorRows(ctx);
    expect(rows).toHaveLength(again.inputs.length);
    for (const row of rows) {
      const v = parseVector(row.embedding);
      expect(row.model).toBe('pool:bge-m3:1024:l2-v1');
      expect(Math.hypot(...v)).toBeCloseTo(1, 2);
    }
    const [first] = rows;
    const [{ content }] = await ctx.store.query<{ content: string }>(`SELECT content FROM chunks WHERE id = $1`, [first.chunk_id]);
    expect(cosine(parseVector(first.embedding), unit(fakeVector(content, 1024)))).toBeGreaterThan(0.999);

    // the workspace changes its embedding identity while a batch is out: the batch is dropped, nothing written
    const [stale] = await broker.lease(local, ['embed'], 1);
    if (stale.kind !== 'embed') throw new Error('not an embed task');
    const real = ctx.embedder;
    ctx.embedder = { model: 'pool:bge-m3:1024:l2-v2', dimensions: 1024, embed: real.embed.bind(real) };
    try {
      const result = await broker.complete(stale.id, local, { ok: true, text: '', vectors: stale.inputs.map((t) => fakeVector(t, 1024)) });
      expect(result).toMatchObject({ accepted: false, reason: expect.stringMatching(/embedding model changed/) });
    } finally {
      ctx.embedder = real;
    }
    expect(await vectorRows(ctx)).toHaveLength(again.inputs.length);
  });

  it('drains the backlog to zero through serve\'s own embed slots', async () => {
    const slots = new LocalEmbedSlots(broker, () => ctx.embedder, () => ctx.config, { idleMs: 50 });
    slots.start();
    try {
      await until(async () => (await pendingEmbeddings(ctx.store, ctx.embedder.model)) === 0, 20_000, 'the backlog to drain');
    } finally {
      slots.stop();
    }
    const [{ chunks }] = await ctx.store.query<{ chunks: number }>(`SELECT count(*)::int AS chunks FROM chunks`);
    expect(await vectorRows(ctx)).toHaveLength(chunks);
    expect(slots.status()).toMatchObject({ slots: 2, failed: 0 });
    // the pool made them, under its own batch size
    expect(pool.calls.every((c) => Array.isArray(c.input) && c.input.length <= 4)).toBe(true);
    const status = await source.status();
    expect(status).toMatchObject({ mode: 'deferred', backlog: 0, waiting: 0, leases: [] });
    expect(status.totals.written).toBe(chunks);
    // and vector search finds them
    const hits = await search(ctx.store, ctx.embedder, await chunkText(ctx, 'raw/docs/n3.md'), { mode: 'vector', track: false, k: 1 });
    expect(hits[0]?.path).toBe('raw/docs/n3.md');
  });

  it('puts an audit\'s texts ahead of the backlog and hands its vectors back in order', async () => {
    write(ctx.dataDir, 'raw/docs/n7.md', '# 笔记 7\n\n新的一份文档，等待向量。\n');
    await sync(ctx, { only: ['raw/docs/n7.md'] });
    const texts = ['甲公司：营业收入增长', '乙公司：净利润下降', 'Company C: revenue up', 'Company D: margin down', '戊公司：回购股份', 'Company F: split'];
    const answer = source.request(texts);
    const tasks = await broker.lease(local, ['embed'], 4);
    // the audit's two batches first, the backlog after
    expect(tasks.map((t) => t.label)).toEqual(['4 audit texts', '2 audit texts', expect.stringMatching(/^1 chunk of raw\/docs\/n7\.md/)]);
    for (const t of [...tasks].reverse()) {
      if (t.kind !== 'embed') throw new Error('not an embed task');
      await broker.complete(t.id, local, { ok: true, text: '', vectors: t.inputs.map((x) => fakeVector(x, 1024)) });
    }
    const vectors = await answer;
    expect(vectors).toHaveLength(6);
    vectors.forEach((v, i) => expect(cosine(v, fakeVector(texts[i], 1024))).toBeGreaterThan(0.9999));
    expect(Math.hypot(...vectors[0])).toBeCloseTo(1, 6);
  });

  it('fails an audit nobody serves at its deadline, and the brokered embedder embeds directly when nobody could', async () => {
    const lonely = new EmbedSource({ dataDir: ctx.dataDir, store: ctx.store, config: () => ctx.config, embedder: () => ctx.embedder }, { requestDeadlineMs: 1_000 });
    await expect(lonely.request(['nobody takes this'])).rejects.toThrow(/no vectors within 1 s/);
    await lonely.stop();
    let direct = 0;
    const counting: EmbeddingProvider = { model: ctx.embedder.model, dimensions: 1024, embed: async (t) => { direct += t.length; return t.map((x) => unit(fakeVector(x, 1024))); } };
    let canServe = false;
    const brokered = new BrokeredEmbedder(source, () => counting, () => canServe);
    expect(brokered.model).toBe('pool:bge-m3:1024:l2-v1');
    expect(await brokered.embed(['a', 'b'])).toHaveLength(2);
    expect(direct).toBe(2);
    canServe = true;
    const viaQueue = brokered.embed(['c']);
    const [t] = await broker.lease(local, ['embed'], 1);
    if (t.kind !== 'embed') throw new Error('not an embed task');
    await broker.complete(t.id, local, { ok: true, text: '', vectors: [fakeVector('c', 1024)] });
    expect(await viaQueue).toHaveLength(1);
    expect(direct).toBe(2);
  });

  describe('an own endpoint', () => {
    const probeVectors = (space: string, noise = 0) => PROBE_TEXTS.map((t) => fakeVector(t, 1024, space, noise));

    it('passes calibration against reference vectors this machine made with its pool, kept per identity', async () => {
      const before = pool.texts();
      const ok = await source.calibrate('box/gpu-1', { model: 'BAAI/bge-m3', endpointModel: 'bge-m3', vectors: probeVectors('bge-m3', 0.02) });
      expect(ok).toMatchObject({ ok: true, calibration: expect.any(String) });
      if (!ok.ok) throw new Error('refused');
      expect(ok.minCosine).toBeGreaterThan(0.98);
      expect(ok.minCosine).toBeLessThan(1);
      // the pool embedded the probe set once, and the reference is on disk for the identity
      expect(pool.texts() - before).toBe(PROBE_TEXTS.length);
      const file = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, PROBE_FILE), 'utf8'));
      expect(Object.keys(file.identities)).toEqual(['pool:bge-m3:1024:l2-v1']);
      await source.calibrate('box/gpu-1', { model: 'BAAI/bge-m3', vectors: probeVectors('bge-m3') });
      expect(pool.texts() - before).toBe(PROBE_TEXTS.length);
    });

    it('is refused when it serves another model, by name or by its vectors', async () => {
      const named = await source.calibrate('box/other', { model: 'text-embedding-3-small', vectors: probeVectors('bge-m3') });
      expect(named).toMatchObject({ ok: false, reason: expect.stringMatching(/serves text-embedding-3-small, not bge-m3/) });
      const answered = await source.calibrate('box/other', { model: 'BAAI/bge-m3', endpointModel: 'nomic-embed-text', vectors: probeVectors('bge-m3') });
      expect(answered).toMatchObject({ ok: false, reason: expect.stringMatching(/nomic-embed-text/) });
      const vectors = await source.calibrate('box/other', { model: 'BAAI/bge-m3', vectors: probeVectors('another-model') });
      expect(vectors).toMatchObject({ ok: false, reason: expect.stringMatching(/cosine .* below 0.98/) });
      if (vectors.ok) throw new Error('accepted');
      expect(vectors.minCosine).toBeLessThan(0.2);
      const short = await source.calibrate('box/other', { model: 'BAAI/bge-m3', vectors: probeVectors('bge-m3').slice(1) });
      expect(short).toMatchObject({ ok: false, reason: expect.stringMatching(/expected 16 vectors/) });
      // none of them gets a batch
      expect(await broker.lease({ worker: 'box/other/embed#1', backend: 'embed', remote: true }, ['embed'], 1, {})).toEqual([]);
    });

    it('gets batches once calibrated, each spot-checked here, and a missed spot check parks it', async () => {
      const files = Array.from({ length: 6 }, (_, i) => `raw/docs/r${i + 1}.md`);
      files.forEach((f, i) => write(ctx.dataDir, f, `# 远程 ${i + 1}\n\n远程工作者的第${i + 1}份文档。\n`));
      await sync(ctx, { only: files });
      const cal = await source.calibrate('box/gpu-1', { model: 'BAAI/bge-m3', vectors: probeVectors('bge-m3') });
      if (!cal.ok) throw new Error(cal.reason);
      // an uncalibrated or foreign slot gets nothing
      expect(await broker.lease(remote(), ['embed'], 1, {})).toEqual([]);
      expect(await broker.lease({ worker: 'thief/embed#1', backend: 'embed', remote: true }, ['embed'], 1, { calibration: cal.calibration })).toEqual([]);

      const [task] = await broker.lease(remote(), ['embed'], 1, { calibration: cal.calibration });
      if (task?.kind !== 'embed') throw new Error('no embed task');
      // one batch in `spotCheckEvery` (1 here) carries a probe text
      const probes = task.inputs.filter((t) => PROBE_TEXTS.includes(t));
      expect(probes).toHaveLength(1);
      const done = await broker.complete(task.id, remote(), { ok: true, text: '', model: 'BAAI/bge-m3', vectors: task.inputs.map((t) => fakeVector(t, 1024)) });
      // the probe's vector is checked and left out of what is written
      expect(done).toEqual({ accepted: true, vectorsWritten: task.inputs.length - 1 });

      const [next] = await broker.lease(remote(2), ['embed'], 1, { calibration: cal.calibration });
      if (next?.kind !== 'embed') throw new Error('no embed task');
      const wrong = await broker.complete(next.id, remote(2), {
        ok: true, text: '', model: 'BAAI/bge-m3',
        vectors: next.inputs.map((t) => fakeVector(t, 1024, PROBE_TEXTS.includes(t) ? 'drifted' : 'bge-m3')),
      });
      expect(wrong).toMatchObject({ accepted: false, reason: expect.stringMatching(/spot check missed/) });
      // parked: every slot of that worker, and no calibration while it lasts
      expect(await broker.lease(remote(1), ['embed'], 1, { calibration: cal.calibration })).toEqual([]);
      expect(source.calibrationProblem(remote(3), cal.calibration)).toMatchObject({ reason: expect.stringMatching(/^parked: a spot check/), parkedUntil: expect.any(String) });
      expect(await source.calibrate('box/gpu-1', { model: 'BAAI/bge-m3', vectors: probeVectors('bge-m3') })).toMatchObject({ ok: false, reason: expect.stringMatching(/^parked until/) });
      expect(logs.some((l) => /box\/gpu-1 parked for 30 min: a spot check reached cosine/.test(l))).toBe(true);
      const status = await source.status();
      expect(status.parked.map((p) => p.worker)).toEqual(['box/gpu-1']);
      expect(status.totals).toMatchObject({ spotChecks: 2, spotMisses: 1 });
      // the batch went back in line: this machine's slots still embed it
      const [mine] = await broker.lease(local, ['embed'], 1);
      if (mine?.kind !== 'embed') throw new Error('no embed task');
      expect(mine.inputs.some((t) => PROBE_TEXTS.includes(t))).toBe(false);
      expect(await broker.complete(mine.id, local, { ok: true, text: '', vectors: mine.inputs.map((t) => fakeVector(t, 1024)) })).toMatchObject({ accepted: true });
    });

    it('is taken only for a pool identity', async () => {
      const hashed = new EmbedSource({ dataDir: ctx.dataDir, store: ctx.store, config: () => ctx.config, embedder: () => new LocalHashEmbeddingProvider(1024) });
      expect(await hashed.calibrate('box/gpu-1', { model: 'BAAI/bge-m3', vectors: probeVectors('bge-m3') })).toMatchObject({ ok: false, reason: expect.stringMatching(/only for a model pool/) });
      await hashed.stop();
    });
  });

  describe('an endpoint of this machine\'s own', () => {
    it('is checked with the probe set before Settings saves it', async () => {
      const own = await startFakeEmbeddings({ space: 'bge-m3', noise: 0.01, model: 'BAAI/bge-m3' });
      const other = await startFakeEmbeddings({ space: 'another-model', model: 'bge-m3' });
      try {
        const ok = await checkEmbedEndpoint(ctx, { baseUrl: own.url, model: 'BAAI/bge-m3' });
        expect(ok).toMatchObject({ ok: true, vectorModel: 'pool:bge-m3:1024:l2-v1', dimensions: 1024, threshold: 0.98, endpointModel: 'BAAI/bge-m3' });
        expect(ok.minCosine).toBeGreaterThan(0.99);
        expect(own.calls[0]).toEqual({ model: 'BAAI/bge-m3', input: [...PROBE_TEXTS], encoding_format: 'float' });
        expect(await checkEmbedEndpoint(ctx, { baseUrl: other.url, model: 'BAAI/bge-m3' })).toMatchObject({ ok: false, reason: expect.stringMatching(/below 0\.98/) });
        expect(await checkEmbedEndpoint(ctx, { baseUrl: own.url, model: 'nomic-embed-text' })).toMatchObject({ ok: false, reason: 'nomic-embed-text is not bge-m3, the pool\'s model' });
        expect(await checkEmbedEndpoint(ctx, { baseUrl: 'http://127.0.0.1:1/v1', model: 'bge-m3' })).toMatchObject({ ok: false, reason: expect.stringMatching(/^could not embed on/) });
        const hashed = { ...ctx, embedder: new LocalHashEmbeddingProvider(1024) };
        expect(await checkEmbedEndpoint(hashed, { baseUrl: own.url, model: 'bge-m3' })).toMatchObject({ ok: false, reason: expect.stringMatching(/only with an embedding model pool/) });
      } finally {
        await own.close();
        await other.close();
      }
    });

    it('takes serve\'s embed slots off the pool once calibrated, and puts them back when a spot check misses', async () => {
      // the endpoint answers in the pool's space at first, then drifts
      let drift = false;
      const own = await startFakeEmbeddings({ space: 'bge-m3', model: 'BAAI/bge-m3' });
      const drifting: typeof fetch = async (url, init) => {
        if (!drift) return fetch(url, init);
        const body = JSON.parse(String(init?.body));
        return Response.json({ model: 'BAAI/bge-m3', data: body.input.map((t: string, index: number) => ({ index, embedding: fakeVector(t, 1024, 'drifted') })) });
      };
      const files = Array.from({ length: 8 }, (_, i) => `raw/docs/l${i + 1}.md`);
      files.forEach((f, i) => write(ctx.dataDir, f, `# 本机 ${i + 1}\n\n本机端点要嵌入的第${i + 1}份文档。\n`));
      await sync(ctx, { only: files });
      const config = ctx.config;
      ctx.config = { ...config, ingest: { ...config.ingest, embedSlots: 1, embedEndpoint: { baseUrl: own.url, model: 'BAAI/bge-m3' } } };
      const fromPool = pool.texts();
      const slots = new LocalEmbedSlots(broker, () => ctx.embedder, () => ctx.config, { idleMs: 30, source, fetch: drifting, log: (m) => logs.push(m) });
      try {
        slots.start();
        await until(async () => (await pendingEmbeddings(ctx.store, ctx.embedder.model)) === 0, 20_000, 'the endpoint to drain the backlog');
        // the pool made nothing: every vector came from the endpoint, checked and spot-checked here
        expect(pool.texts()).toBe(fromPool);
        expect(own.texts()).toBeGreaterThanOrEqual(PROBE_TEXTS.length + 8);
        expect(slots.status().endpoint).toMatchObject({ baseUrl: own.url, model: 'BAAI/bge-m3', calibrated: true });
        expect((await source.status()).endpoints.find((e) => e.worker.startsWith('local:'))).toMatchObject({ model: 'BAAI/bge-m3' });

        drift = true;
        const more = ['raw/docs/l9.md', 'raw/docs/l10.md'];
        more.forEach((f, i) => write(ctx.dataDir, f, `# 漂移 ${i}\n\n端点漂移之后写下的第${i + 1}份文档。\n`));
        await sync(ctx, { only: more });
        slots.kick();
        await until(async () => (await pendingEmbeddings(ctx.store, ctx.embedder.model)) === 0, 20_000, 'the pool to take over');
        expect(slots.status().endpoint).toMatchObject({ calibrated: false, note: expect.stringMatching(/^parked: a spot check/) });
        expect(pool.texts()).toBeGreaterThan(fromPool);
        expect(logs.some((l) => /embedding on the pool meanwhile/.test(l))).toBe(true);
      } finally {
        slots.stop();
        ctx.config = config;
        await own.close();
      }
    });
  });

  it('a new embedding model re-applies nothing: the backlog refills for it, and search reads only its vectors', async () => {
    const chunks = (await ctx.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM chunks`))[0].n;
    // drain whatever the tests above left, so every chunk has a pool vector
    const slots = new LocalEmbedSlots(broker, () => ctx.embedder, () => ctx.config, { idleMs: 50 });
    slots.start();
    await until(async () => (await pendingEmbeddings(ctx.store, ctx.embedder.model)) === 0, 20_000, 'the pool backlog');
    slots.stop();
    const query = await chunkText(ctx, 'raw/docs/n3.md');
    expect((await search(ctx.store, ctx.embedder, query, { mode: 'vector', track: false })).length).toBeGreaterThan(0);

    const pooled = ctx.embedder;
    ctx.config = { ...ctx.config, embeddingPool: { ...ctx.config.embeddingPool!, enabled: false }, embedding: { ...ctx.config.embedding, provider: 'local', dimensions: 1024 } };
    ctx.embedder = new LocalHashEmbeddingProvider(1024);
    try {
      const stats = await sync(ctx, {});
      expect(stats.indexed).toBe(0);
      expect(stats.unchanged).toBeGreaterThan(0);
      expect(await pendingEmbeddings(ctx.store, 'local-hash-v1')).toBe(chunks);
      // the table still holds only the pool's vectors: a query in the new space must not read them
      expect(await search(ctx.store, ctx.embedder, query, { mode: 'vector', track: false })).toEqual([]);
      const again = new LocalEmbedSlots(broker, () => ctx.embedder, () => ctx.config, { idleMs: 50 });
      again.start();
      await until(async () => (await pendingEmbeddings(ctx.store, 'local-hash-v1')) === 0, 20_000, 'the new backlog');
      again.stop();
      const hits = await search(ctx.store, ctx.embedder, query, { mode: 'vector', track: false, k: 1 });
      expect(hits[0]?.path).toBe('raw/docs/n3.md');
    } finally {
      ctx.embedder = pooled;
    }
  });
});

describe('inline mode, the default', () => {
  it('embeds while a document is applied, as before, and offers no embed work', async () => {
    const pool = await startFakeEmbeddings({ space: 'bge-m3' });
    const ctx = await createContext(workspace('inline', pool, 'inline'));
    try {
      write(ctx.dataDir, 'raw/docs/a.md', '# 甲\n\n宁德时代发布季度报告。\n');
      const stats = await sync(ctx, {});
      expect(stats.indexed).toBeGreaterThanOrEqual(1);
      expect(await pendingEmbeddings(ctx.store, ctx.embedder.model)).toBe(0);
      expect(pool.texts()).toBe(stats.chunks);
      expect(offeredRemotely(ctx.config, 'embed')).toBe(false);
      expect(localEmbedSlots(ctx.config)).toBe(0);
      expect(defaultConfig().ingest.embedding).toBe('inline');
    } finally {
      await ctx.store.close();
      await pool.close();
    }
  });
});
