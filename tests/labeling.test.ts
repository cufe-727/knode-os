import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, defaultRoutedLlmConfig, ExtractionWorkerConfig, KnodeConfig, LlmConnection } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { readSidecarPart, readSourceSummary, readSourceSummaryFailure } from '../src/fs/sidecar.js';
import { runTier1Pass } from '../src/graph/tier1.js';
import { sync } from '../src/ingest/sync.js';
import { classifyFailure, newBackendHealth, recordBackendOutcome } from '../src/labeling/failures.js';
import { LocalLabelingWorkers, localSummarySpec, localWorkerSpecs } from '../src/labeling/local.js';
import { FINISHED_KEEP, keepNewest, LabelingScheduler, LabelingTask, WorkerIdentity } from '../src/labeling/scheduler.js';
import { ensureDefaultAgents } from '../src/research/agents.js';
import { WorkBroker, WorkSource, WorkTask } from '../src/work/broker.js';
import { workerHints } from '../src/work/config.js';
import { WorkKind } from '../src/work/kinds.js';
import { SummarySource } from '../src/work/summarize.js';
import { ensureSourceSummaries } from '../src/wiki/pages.js';
import { startFakeOpenAi, type ChatRequest, type FakeOpenAi } from './helpers/fake-openai.js';

/**
 * Leased work (src/labeling, src/work): the scheduler hands extraction
 * segments to whoever asks — `serve`'s own slots or a remote worker — checks
 * and records every answer, and writes a document once its last segment is
 * in; the summary source does the same with summary pages; the broker puts
 * the two behind one lease protocol and shares a slot that takes both.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-labeling-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

async function until(check: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (p as { text?: string })?.text ?? '').join('') : '';

/** What a model would answer for one segment: an entity named after the document and part. */
function replyFor(user: string): string {
  const doc = /\((raw\/docs\/[^)]+)\)/.exec(user)?.[1] ?? 'unknown';
  const part = /part (\d+) of (\d+)/.exec(user);
  const name = `实体-${path.basename(doc, '.md')}${part ? `-${part[1]}` : ''}`;
  return JSON.stringify({
    ...(part?.[1] === '1' ? { subject: { name: '长文主体', type: 'organization' } } : {}),
    entities: [{ name, type: 'organization', description: '测试实体', aliases: [] }],
    relations: [],
    claims: [],
  });
}

const extractAnswer = (request: ChatRequest) => {
  const system = textOf(request.messages?.find((m) => m.role === 'system')?.content);
  const user = textOf(request.messages?.filter((m) => m.role === 'user').at(-1)?.content);
  if (system.includes('Summarize the document')) return 'Summary.\n\n## Key points\n\n- 要点';
  return replyFor(user);
};

/** A long document: several sections, so a 1000-character segment size cuts it in parts. */
const longDoc = () => ['# 长文', ...Array.from({ length: 4 }, (_, i) => `## 第${i + 1}节\n\n${`第${i + 1}节的内容，讨论储能与电池。`.repeat(40)}`)].join('\n\n');

async function workspace(name: string, fake: FakeOpenAi, opts: { workers?: ExtractionWorkerConfig[] } = {}): Promise<AppContext> {
  const dataDir = path.join(tmp, name);
  const model: LlmConnection = {
    id: 'connection-1', label: 'fake', provider: 'openai', baseUrl: fake.url, apiKey: 'sk-test',
    protocol: 'chat', model: 'fake-model', cliPath: '', effort: 'default', cliTimeoutMs: 30_000,
  };
  const base = defaultConfig();
  const route = { ...defaultRoutedLlmConfig(), use: 'connection-1' };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'knode.config.json'), JSON.stringify({
    ...base,
    connections: [model],
    llmUse: 'connection-1',
    // one-line documents: no size threshold, or none would be due a summary
    extraction: { ...base.extraction, entityLlm: route, documentLlm: route, summaryLlm: route, judgeLlm: route, segmentChars: 1000, summaryMinChars: 0, workers: opts.workers },
  }));
  ensureDefaultAgents(dataDir);
  write(dataDir, 'raw/docs/a.md', '# 甲\n\n宁德时代发布季度报告。\n');
  write(dataDir, 'raw/docs/b.md', '# 乙\n\n比亚迪出货量增长。\n');
  write(dataDir, 'raw/docs/long.md', longDoc());
  const ctx = await createContext(dataDir);
  await sync(ctx, {});
  return ctx;
}

const queued = async (ctx: AppContext) => (await ctx.store.query<{ path: string }>(
  `SELECT d.path FROM extraction_queue q JOIN documents d ON d.id = q.document_id ORDER BY d.path`,
)).map((r) => r.path);

/** Summary pages written, by the document each one summarizes. */
const summaryPages = async (ctx: AppContext) => new Map((await ctx.store.query<{ path: string; doc: string }>(
  `SELECT p.path, d.input_id AS doc FROM pages p JOIN deps d ON d.artifact_kind = 'page' AND d.artifact_id = p.path AND d.input_kind = 'document'
   WHERE p.kind = 'source_summary' AND p.status <> 'archived'`,
)).map((r) => [r.doc, r.path]));

const reply = (task: LabelingTask) => replyFor(task.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '');

describe('the labeling scheduler', () => {
  let fake: FakeOpenAi;
  let ctx: AppContext;
  let scheduler: LabelingScheduler;
  const mac: WorkerIdentity = { worker: 'macbook/codex#1', backend: 'codex', remote: true };
  const server: WorkerIdentity = { worker: 'aliyun/api#1', backend: 'api', remote: true };

  beforeAll(async () => {
    fake = await startFakeOpenAi({ answer: extractAnswer });
    ctx = await workspace('scheduler', fake);
    scheduler = new LabelingScheduler({ dataDir: ctx.dataDir, store: ctx.store, config: () => ctx.config }, { modelRetryMs: 0, transientRetryMs: 0, priorityRefreshMs: 0, leaseMs: 1_000 });
  });
  afterAll(async () => {
    await scheduler?.stop();
    await ctx?.store.close();
    await fake?.close();
  });

  it('sends a long document\'s lead segment first, then its followers to several workers at once, and writes each document when its last part is in', async () => {
    expect(await queued(ctx)).toEqual(['raw/docs/a.md', 'raw/docs/b.md', 'raw/docs/long.md']);
    const first = await scheduler.lease(mac, 8);
    const byPath = new Map(first.map((t) => [t.document.path, t]));
    expect([...byPath.keys()].sort()).toEqual(['raw/docs/a.md', 'raw/docs/b.md', 'raw/docs/long.md']);
    const lead = byPath.get('raw/docs/long.md')!;
    expect(lead.document.part).toBe(1);
    expect(lead.document.parts).toBeGreaterThan(2);
    // the prompt a worker gets is the whole call: system rules, the text, the JSON directive
    expect(lead.messages[0].role).toBe('system');
    expect(lead.prompt).toContain('knowledge-graph extraction engine');
    expect(lead.prompt).toContain('single JSON object');

    for (const p of ['raw/docs/a.md', 'raw/docs/b.md']) {
      const task = byPath.get(p)!;
      expect(await scheduler.complete(task.id, mac, { ok: true, text: reply(task), model: 'codex:gpt-test' })).toEqual({ accepted: true, documentWritten: true });
    }
    // nothing of the long document but its lead was out; its followers wait for the lead's answer
    expect(await scheduler.lease(server, 8)).toEqual([]);
    expect(await scheduler.complete(lead.id, mac, { ok: true, text: reply(lead) })).toEqual({ accepted: true });

    const followers = await scheduler.lease(server, 8);
    expect(followers.map((t) => t.document.part)).toEqual(Array.from({ length: lead.document.parts - 1 }, (_, i) => i + 2));
    // the lead named the subject; every follower's prompt says so
    for (const t of followers) expect(t.messages.at(-1)!.content).toContain('Main subject of this document: 长文主体');
    const results = [];
    for (const t of followers) results.push(await scheduler.complete(t.id, server, { ok: true, text: reply(t), model: 'api:fake' }));
    expect(results.at(-1)).toEqual({ accepted: true, documentWritten: true });

    expect(await queued(ctx)).toEqual([]);
    const t1 = readSidecarPart(ctx.dataDir, 'raw/docs/long.md', 'tier1');
    expect(t1?.status).toBe('done');
    expect(t1?.segments?.map((s) => s.model)).toEqual(['remote:codex', ...followers.map(() => 'remote:api:fake')]);
    const names = (await ctx.store.query<{ name: string }>(`SELECT name FROM entities WHERE tx_to IS NULL ORDER BY name`)).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['实体-a', '实体-b', '实体-long-1', `实体-long-${lead.document.parts}`]));

    const finished = scheduler.takeFinished();
    expect(finished).toMatchObject({ written: 3, failed: 0 });
    expect([...finished.documents].sort()).toEqual(['raw/docs/a.md', 'raw/docs/b.md', 'raw/docs/long.md']);
    const status = await scheduler.status();
    expect(status).toMatchObject({ queued: 0, openDocuments: 0, leases: [] });
    expect(status.totals).toMatchObject({ documentsWritten: 3, calls: 2 + lead.document.parts });
  });

  it('keeps a segment\'s attempts through rate limits and lost connections, and gives up after three bad answers', async () => {
    write(ctx.dataDir, 'raw/docs/c.md', '# 丙\n\n一段会失败的文本。\n');
    await sync(ctx, { only: ['raw/docs/c.md'] });
    let [task] = await scheduler.lease(mac, 1);
    expect(task.document.path).toBe('raw/docs/c.md');
    expect(await scheduler.complete(task.id, mac, { ok: false, error: 'HTTP 429 Too Many Requests' })).toEqual({ accepted: true });
    expect(readSidecarPart(ctx.dataDir, 'raw/docs/c.md', 'tier1')?.segments ?? []).toEqual([]);

    for (const outcome of [
      { ok: true as const, text: 'Sorry, I cannot help with that.' },
      { ok: false as const, error: 'unusable reply: Unexpected end of JSON input' },
      { ok: false as const, error: 'the model refused', kind: 'model' as const },
    ]) {
      [task] = await scheduler.lease(server, 1);
      expect(task.document.path).toBe('raw/docs/c.md');
      await scheduler.complete(task.id, server, outcome);
    }
    const t1 = readSidecarPart(ctx.dataDir, 'raw/docs/c.md', 'tier1');
    expect(t1?.status).toBe('failed');
    expect(t1?.segments?.[0]).toMatchObject({ status: 'failed', attempts: 3 });
    expect(await queued(ctx)).toEqual([]);
    expect(scheduler.takeFinished()).toMatchObject({ written: 0, failed: 1 });
  });

  it('puts a lapsed lease back in line and refuses the late answer once someone else has the segment', async () => {
    write(ctx.dataDir, 'raw/docs/d.md', '# 丁\n\n一份会被转手的文档。\n');
    await sync(ctx, { only: ['raw/docs/d.md'] });
    const [stale] = await scheduler.lease(mac, 1);
    await sleep(1_100);
    const [fresh] = await scheduler.lease(server, 1);
    expect(fresh.document.path).toBe('raw/docs/d.md');
    expect(fresh.id).not.toBe(stale.id);
    expect(await scheduler.complete(stale.id, mac, { ok: true, text: reply(stale) })).toMatchObject({ accepted: false });
    expect(await scheduler.complete(fresh.id, server, { ok: true, text: reply(fresh) })).toEqual({ accepted: true, documentWritten: true });
    expect((await scheduler.status()).totals.leasesExpired).toBeGreaterThanOrEqual(1);
  });

  it('does not write a document over text that changed while it was being read; the new text goes back in line', async () => {
    write(ctx.dataDir, 'raw/docs/e.md', '# 戊\n\n第一版。\n');
    await sync(ctx, { only: ['raw/docs/e.md'] });
    const [task] = await scheduler.lease(mac, 1);
    write(ctx.dataDir, 'raw/docs/e.md', '# 戊\n\n第二版，内容变了。\n');
    await sync(ctx, { only: ['raw/docs/e.md'] });
    expect(await scheduler.complete(task.id, mac, { ok: true, text: reply(task) })).toEqual({ accepted: true, documentWritten: false });
    expect((await scheduler.status()).totals.stale).toBe(1);
    expect(await queued(ctx)).toEqual(['raw/docs/e.md']);
    const [again] = await scheduler.lease(mac, 1);
    expect(again.messages.at(-1)!.content).toContain('第二版');
    expect(await scheduler.complete(again.id, mac, { ok: true, text: reply(again) })).toEqual({ accepted: true, documentWritten: true });
  });

  it('shares the queue with the batch pass without either taking the other\'s document', async () => {
    write(ctx.dataDir, 'raw/docs/f.md', '# 己\n\n一份。\n');
    write(ctx.dataDir, 'raw/docs/g.md', '# 庚\n\n另一份。\n');
    await sync(ctx, { only: ['raw/docs/f.md', 'raw/docs/g.md'] });
    // a scheduler that opens one document at a time holds exactly the one it leased
    const solo = new LabelingScheduler({ dataDir: ctx.dataDir, store: ctx.store, config: () => ctx.config }, { openPerRound: 1, priorityRefreshMs: 0 });
    try {
      const [held] = await solo.lease(mac, 1);
      const pass = await runTier1Pass(ctx.store, ctx.config, ctx.llm, { batchSize: 8 });
      const other = held.document.path === 'raw/docs/f.md' ? 'raw/docs/g.md' : 'raw/docs/f.md';
      expect(pass.documents).toEqual([other]);
      expect(await queued(ctx)).toEqual([held.document.path]);
      expect(await solo.complete(held.id, mac, { ok: true, text: reply(held) })).toEqual({ accepted: true, documentWritten: true });
      expect(await queued(ctx)).toEqual([]);
    } finally {
      await solo.stop();
    }
  });
});

describe('what the scheduler keeps for the next review', () => {
  it('keeps an id once, as the newest, and drops the oldest past the limit — reviews may not come while processing is stopped', () => {
    const kept = new Set<string>();
    keepNewest(kept, ['e1', 'e2', 'e1']);
    expect([...kept]).toEqual(['e2', 'e1']);
    keepNewest(kept, Array.from({ length: FINISHED_KEEP - 1 }, (_, i) => `c${i}`));
    expect(kept.size).toBe(FINISHED_KEEP);
    expect([...kept].slice(0, 2)).toEqual(['e1', 'c0']);
    expect([...kept].at(-1)).toBe(`c${FINISHED_KEEP - 2}`);
  });
});

describe('local labeling workers', () => {
  let fake: FakeOpenAi;
  let ctx: AppContext;

  beforeAll(async () => {
    fake = await startFakeOpenAi({ answer: extractAnswer, delayMs: 30 });
    ctx = await workspace('local', fake, { workers: [{ use: 'connection-1', slots: 3 }, { use: 'no-such-agent', slots: 2 }] });
  });
  afterAll(async () => {
    await ctx?.store.close();
    await fake?.close();
  });

  it('read their slots from extraction.workers, skipping a target that does not exist', () => {
    const warnings: string[] = [];
    const specs = localWorkerSpecs(ctx.config, (m) => warnings.push(m));
    expect(specs.map((s) => [s.id, s.slots, s.llm.model])).toEqual([['connection-1', 3, 'fake-model']]);
    expect(warnings.join()).toContain('no-such-agent');
    // without workers: the Extract stage's own route, `concurrency` slots
    const plain = localWorkerSpecs({ ...ctx.config, extraction: { ...ctx.config.extraction, workers: undefined, concurrency: 2 } });
    expect(plain.map((s) => [s.id, s.slots])).toEqual([['connection-1', 2]]);
    // listed with no slots: this machine only hands out work
    expect(localWorkerSpecs({ ...ctx.config, extraction: { ...ctx.config.extraction, workers: [{ use: 'connection-1', slots: 0 }] } })).toEqual([]);
  });

  it('drain the queue on their own slots, several calls at a time, and write every summary page after it', async () => {
    let summaries: SummarySource | null = null;
    const scheduler = new LabelingScheduler({ dataDir: ctx.dataDir, store: ctx.store, config: () => ctx.config, onWritten: (p) => summaries?.prefer(p) }, { priorityRefreshMs: 0 });
    summaries = new SummarySource(ctx, {}, { idleScanMs: 50 });
    const broker = new WorkBroker([scheduler, summaries]);
    const workers = new LocalLabelingWorkers(broker, () => ctx.config, { idleMs: 50 });
    workers.start();
    try {
      await until(async () => (await queued(ctx)).length === 0 && (await scheduler.status()).openDocuments === 0, 30_000, 'the queue to drain');
      await until(async () => (await summaryPages(ctx)).size === 3, 30_000, 'the summary pages');
      const [backend, summarize] = workers.status();
      expect(backend).toMatchObject({ id: 'connection-1', slots: 3, failed: { model: 0, transient: 0, fatal: 0 } });
      expect(backend.ok).toBe(backend.calls);
      // the summaries ran on the Summarize stage's own slots, not on the extraction ones
      expect(summarize).toMatchObject({ id: 'summarize', slots: 1, calls: 3, ok: 3 });
      expect(readSidecarPart(ctx.dataDir, 'raw/docs/long.md', 'tier1')?.status).toBe('done');
      expect((await scheduler.status()).totals.documentsWritten).toBe(3);
      expect(readSourceSummary(ctx.dataDir, 'raw/docs/a.md')?.model).toBe('fake-model');
    } finally {
      workers.stop();
      await broker.stop();
    }
  });

  it('run summaries on the Summarize stage\'s route, `summaryConcurrency` at a time, or none', () => {
    expect(localSummarySpec(ctx.config)).toMatchObject({ id: 'summarize', kinds: ['summarize'], slots: 1 });
    expect(localSummarySpec({ ...ctx.config, extraction: { ...ctx.config.extraction, summaryConcurrency: 4 } })?.slots).toBe(4);
    // 0: only remote workers write summaries
    expect(localSummarySpec({ ...ctx.config, extraction: { ...ctx.config.extraction, summaryConcurrency: 0 } })).toBeNull();
  });
});

/** A source with as many tasks as `supply` says, for the broker's own rules. */
class FakeSource implements WorkSource {
  readonly leaseDurationMs = 60_000;
  readonly issued = new Set<string>();
  readonly completed: string[] = [];
  private n = 0;
  constructor(readonly kind: WorkKind, public supply = Infinity) {}
  async lease(): Promise<WorkTask[]> {
    if (this.supply <= 0) return [];
    this.supply--;
    const id = `${this.kind}-${++this.n}`;
    this.issued.add(id);
    return [{ id, kind: this.kind, label: id, messages: [], prompt: '', json: this.kind === 'extract', maxTokens: 1, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }];
  }
  async complete(id: string) {
    this.completed.push(id);
    return { accepted: true };
  }
  renew(ids: string[]) {
    return { renewed: ids, lost: [] };
  }
  async release(ids: string[]) {
    return ids.length;
  }
  holds(id: string) {
    return this.issued.has(id);
  }
  async status() {
    return { leases: [] };
  }
  async stop() {}
}

describe('the work broker', () => {
  const slot: WorkerIdentity = { worker: 'macbook/codex#1', backend: 'codex', remote: true };
  const both: WorkKind[] = ['extract', 'summarize'];
  const kindsOf = async (broker: WorkBroker, n: number, kinds = both) => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push((await broker.lease(slot, kinds))[0]?.kind ?? 'none');
    return out;
  };

  it('shares a slot that takes both kinds three segments to one summary', async () => {
    const broker = new WorkBroker([new FakeSource('extract'), new FakeSource('summarize')]);
    expect(await kindsOf(broker, 12)).toEqual(['extract', 'summarize', 'extract', 'extract', 'extract', 'summarize', 'extract', 'extract', 'extract', 'summarize', 'extract', 'extract']);
  });

  it('banks no credit for a kind that had nothing to give', async () => {
    const summaries = new FakeSource('summarize', 0);
    const broker = new WorkBroker([new FakeSource('extract'), summaries]);
    expect(await kindsOf(broker, 9)).toEqual(Array(9).fill('extract'));
    // summaries come due: they take their share from here on, not everything until they catch up
    summaries.supply = Infinity;
    expect(await kindsOf(broker, 8)).toEqual(['summarize', 'extract', 'extract', 'extract', 'summarize', 'extract', 'extract', 'extract']);
  });

  it('takes the shares from the config, and serves a slot only the kinds it asks for', async () => {
    const broker = new WorkBroker([new FakeSource('extract'), new FakeSource('summarize')], { shares: () => ({ extract: 1, summarize: 1 }) });
    expect(await kindsOf(broker, 4)).toEqual(['extract', 'summarize', 'extract', 'summarize']);
    expect(await kindsOf(broker, 3, ['summarize'])).toEqual(['summarize', 'summarize', 'summarize']);
    expect(await kindsOf(broker, 1, [])).toEqual(['none']);
    // an unusable weight falls back to its default
    expect(new WorkBroker([], { shares: () => ({ extract: 0, summarize: -2 }) }).shares()).toEqual({ extract: 3, summarize: 1, translate: 1 });
  });

  it('puts the judge calls a review waits on before both, and leaves their shares as they were', async () => {
    const judge = new FakeSource('judge', 2);
    const broker = new WorkBroker([new FakeSource('extract'), new FakeSource('summarize'), judge]);
    expect(broker.askedLately('judge', 60_000)).toBe(false);
    expect(await kindsOf(broker, 6, ['extract', 'summarize', 'judge'])).toEqual(['judge', 'judge', 'extract', 'summarize', 'extract', 'extract']);
    expect(broker.askedLately('judge', 60_000)).toBe(true);
    // a slot that does not take judge calls never gets one
    judge.supply = Infinity;
    expect(await kindsOf(broker, 2)).toEqual(['extract', 'summarize']);
  });

  it('sends answers, renewals and releases back to the source that issued the lease', async () => {
    const extract = new FakeSource('extract');
    const summarize = new FakeSource('summarize');
    const broker = new WorkBroker([extract, summarize]);
    const [a] = await broker.lease(slot, ['extract']);
    const [b] = await broker.lease(slot, ['summarize']);
    expect(await broker.complete(a.id, slot, { ok: true, text: '{}' })).toEqual({ accepted: true });
    expect(await broker.complete(b.id, slot, { ok: false, error: 'HTTP 429' })).toEqual({ accepted: true });
    expect([extract.completed, summarize.completed]).toEqual([[a.id], [b.id]]);
    expect(await broker.complete('no-such-lease', slot, { ok: true, text: '' })).toMatchObject({ accepted: false });
    expect(broker.renew([a.id, b.id, 'no-such-lease'], slot)).toEqual({ renewed: [a.id, b.id], lost: ['no-such-lease'] });
    expect(await broker.release([a.id, b.id], slot)).toBe(2);
    const [worker] = (await broker.status()).workers;
    expect(worker).toMatchObject({ worker: 'macbook/codex#1', kinds: ['summarize'], ok: 1, failed: 1 });
  });
});

describe('worker hints', () => {
  it('tell a worker how the server runs each kind on each CLI', () => {
    const base = defaultConfig();
    const agent = (id: string, provider: LlmConnection['provider'], model: string, effort: LlmConnection['effort'], speed: LlmConnection['speed'] = 'default'): LlmConnection => ({
      id, label: id, provider, baseUrl: '', apiKey: '', model, cliPath: '', effort, speed, cliTimeoutMs: 60_000,
    });
    const config: KnodeConfig = {
      ...base,
      agentLlms: [agent('codex-agent', 'codex-cli', 'gpt-agent', 'high', 'fast'), agent('cursor-agent', 'cursor-cli', 'grok', 'max')],
      extraction: {
        ...base.extraction,
        entityLlm: { ...defaultRoutedLlmConfig(), use: 'codex-agent' },
        summaryLlm: { ...defaultRoutedLlmConfig(), use: 'codex-agent', model: 'gpt-summary' },
        // listed with no slots, a worker entry still says how extraction runs on that agent
        workers: [{ use: 'codex-agent', slots: 0, model: 'gpt-extract', effort: 'medium' }, { use: 'cursor-agent', slots: 2 }],
      },
    };
    expect(workerHints({ ...config, extraction: { ...config.extraction, judgeLlm: { ...defaultRoutedLlmConfig(), use: 'cursor-agent', effort: 'low' } } })).toEqual({
      extract: { codex: { model: 'gpt-extract', effort: 'medium', speed: 'fast' }, cursor: { model: 'grok[effort=high]' } },
      summarize: { codex: { model: 'gpt-summary', effort: 'high', speed: 'fast' } },
      judge: { cursor: { model: 'grok[effort=low]' } },
      translate: {},
    });
    // an endpoint gets no hints: model names differ between them
    expect(workerHints(base)).toEqual({ extract: {}, summarize: {}, judge: {}, translate: {} });
  });
});

describe('the summary source', () => {
  let fake: FakeOpenAi;
  let ctx: AppContext;
  let source: SummarySource;
  const mac: WorkerIdentity = { worker: 'macbook/codex#1', backend: 'codex', remote: true };
  const box: WorkerIdentity = { worker: 'aliyun/api#1', backend: 'api', remote: true };
  const extractAll = async () => runTier1Pass(ctx.store, ctx.config, ctx.llm, { batchSize: 32 });

  beforeAll(async () => {
    fake = await startFakeOpenAi({ answer: extractAnswer });
    ctx = await workspace('summary-source', fake);
    expect((await extractAll()).processed).toBe(3);
    source = new SummarySource(ctx, {}, { leaseMs: 1_000, modelRetryMs: 0, transientRetryMs: 0, idleScanMs: 0 });
  });
  afterAll(async () => {
    await source?.stop();
    await ctx?.store.close();
    await fake?.close();
  });

  it('hands out the documents due a summary, the latest extracted first, and writes each page from the answer with no model call of its own', async () => {
    write(ctx.dataDir, 'raw/docs/q.md', '# 待抽取\n\n还没抽取的文档。\n');
    await sync(ctx, { only: ['raw/docs/q.md'] });
    source.prefer('raw/docs/b.md');
    const tasks = await source.lease(mac, 8);
    // a document still waiting for extraction is not due: its summary would miss what extraction finds
    expect(tasks.map((t) => t.label)[0]).toBe('raw/docs/b.md');
    expect(tasks.map((t) => t.label).sort()).toEqual(['raw/docs/a.md', 'raw/docs/b.md', 'raw/docs/long.md']);
    const [first] = tasks;
    expect(first).toMatchObject({ kind: 'summarize', json: false, maxTokens: 1200 });
    expect(first.messages[0].content).toContain('Summarize the document');
    expect(first.prompt).toContain('Source file: raw/docs/b.md');
    expect(first.prompt).not.toContain('single JSON object');

    const calls = fake.calls.length;
    for (const t of tasks) {
      expect(await source.complete(t.id, mac, { ok: true, text: `# 摘要\n\n${t.label} 的摘要。`, model: 'codex:gpt-test' })).toEqual({ accepted: true });
    }
    await until(async () => (await summaryPages(ctx)).size === 3, 10_000, 'the summary pages');
    expect(fake.calls.length).toBe(calls);
    const page = fs.readFileSync(path.join(ctx.dataDir, (await summaryPages(ctx)).get('raw/docs/b.md')!), 'utf8');
    expect(page).toContain('raw/docs/b.md 的摘要。');
    expect(page).toContain('knode-os/remote:codex:gpt-test');
    expect(readSourceSummary(ctx.dataDir, 'raw/docs/b.md')).toMatchObject({ model: 'remote:codex:gpt-test' });
    expect(await source.lease(box, 8)).toEqual([]);
    expect((await source.status()).totals).toMatchObject({ calls: 3, ok: 3, pagesWritten: 3 });

    fs.rmSync(path.join(ctx.dataDir, 'raw/docs/q.md'));
    await sync(ctx, { only: ['raw/docs/q.md'] });
  });

  it('keeps a document\'s attempts through busy backends, and gives up after three bad answers', async () => {
    write(ctx.dataDir, 'raw/docs/c.md', '# 丙\n\n一段会失败的文本。\n');
    await sync(ctx, { only: ['raw/docs/c.md'] });
    await extractAll();
    let [task] = await source.lease(mac, 1);
    expect(task.label).toBe('raw/docs/c.md');
    expect(await source.complete(task.id, mac, { ok: false, error: 'HTTP 429 Too Many Requests' })).toEqual({ accepted: true });
    expect(readSourceSummaryFailure(ctx.dataDir, 'raw/docs/c.md')).toBeNull();
    for (const outcome of [
      { ok: true as const, text: '   ' },
      { ok: false as const, error: 'the model refused', kind: 'model' as const },
      { ok: false as const, error: 'unusable reply' },
    ]) {
      [task] = await source.lease(box, 1);
      expect(task.label).toBe('raw/docs/c.md');
      expect(await source.complete(task.id, box, outcome)).toEqual({ accepted: true });
    }
    expect(readSourceSummaryFailure(ctx.dataDir, 'raw/docs/c.md')).toMatchObject({ attempts: 3 });
    expect(await source.lease(mac, 1)).toEqual([]);
  });

  it('puts a lapsed lease back in line and refuses the late answer once someone else has the document', async () => {
    write(ctx.dataDir, 'raw/docs/d.md', '# 丁\n\n一份会被转手的文档。\n');
    await sync(ctx, { only: ['raw/docs/d.md'] });
    await extractAll();
    const [stale] = await source.lease(mac, 1);
    expect(stale.label).toBe('raw/docs/d.md');
    await sleep(1_100);
    const [fresh] = await source.lease(box, 1);
    expect(fresh.label).toBe('raw/docs/d.md');
    expect(await source.complete(stale.id, mac, { ok: true, text: '迟到的摘要。' })).toMatchObject({ accepted: false });
    expect(await source.complete(fresh.id, box, { ok: true, text: '# 丁\n\n摘要。' })).toEqual({ accepted: true });
    expect(readSourceSummary(ctx.dataDir, 'raw/docs/d.md')?.body.trim()).toBe('# 丁\n\n摘要。');
    expect((await source.status()).totals.leasesExpired).toBeGreaterThanOrEqual(1);
  });

  it('drops an answer for a document that changed while it was out; the new text waits for its extraction', async () => {
    write(ctx.dataDir, 'raw/docs/e.md', '# 戊\n\n第一版。\n');
    await sync(ctx, { only: ['raw/docs/e.md'] });
    await extractAll();
    const [task] = await source.lease(mac, 1);
    expect(task.label).toBe('raw/docs/e.md');
    write(ctx.dataDir, 'raw/docs/e.md', '# 戊\n\n第二版，内容变了。\n');
    await sync(ctx, { only: ['raw/docs/e.md'] });
    const stale = (await source.status()).totals.stale;
    expect(await source.complete(task.id, mac, { ok: true, text: '第一版的摘要。' })).toEqual({ accepted: true });
    expect((await source.status()).totals.stale).toBe(stale + 1);
    expect(readSourceSummary(ctx.dataDir, 'raw/docs/e.md')).toBeNull();
    expect(await source.lease(mac, 8)).toEqual([]);
  });
});

describe('summaries while the model is out of reach', () => {
  let fake: FakeOpenAi;
  let ctx: AppContext;

  beforeAll(async () => {
    fake = await startFakeOpenAi({ answer: extractAnswer });
    ctx = await workspace('unreachable', fake);
    // extraction done, so summaries are due
    const pass = await runTier1Pass(ctx.store, ctx.config, ctx.llm, { batchSize: 32 });
    expect(pass.processed).toBe(3);
  });
  afterAll(async () => {
    await ctx?.store.close();
    await fake?.close();
  });

  it('are put off without using up the documents\' attempts', async () => {
    const dead: LlmConnection = {
      id: 'connection-dead', label: 'dead', provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-test',
      protocol: 'chat', model: 'fake-model', cliPath: '', effort: 'default', cliTimeoutMs: 5_000,
    };
    const config = {
      ...ctx.config,
      connections: [...ctx.config.connections, dead],
      extraction: { ...ctx.config.extraction, summaryLlm: { ...ctx.config.extraction.summaryLlm, use: 'connection-dead' } },
    };
    const stats = { deferred: 0 };
    const written = await ensureSourceSummaries({ ...ctx, config }, { limit: 10, skipQueued: true, stats });
    expect(written).toEqual([]);
    expect(stats.deferred).toBe(3);
    for (const p of ['raw/docs/a.md', 'raw/docs/b.md', 'raw/docs/long.md']) expect(readSourceSummaryFailure(ctx.dataDir, p)).toBeNull();
    // once the model answers again, the same documents are summarized
    expect((await ensureSourceSummaries(ctx, { limit: 10, skipQueued: true })).length).toBe(3);
  });
});

describe('what a failure means', () => {
  it('tells a bad answer from a busy backend and a broken one', () => {
    expect(classifyFailure('codex exec exited with code 1: …You\'ve hit your usage limit. Try again in 2 hours.')).toBe('transient');
    expect(classifyFailure('chat request failed (429): rate limited')).toBe('transient');
    expect(classifyFailure('spawn codex EBADF')).toBe('transient');
    expect(classifyFailure('fetch failed')).toBe('transient');
    expect(classifyFailure('codex CLI not found — install it')).toBe('fatal');
    expect(classifyFailure('cursor CLI error: Not logged in. Run cursor-agent login')).toBe('fatal');
    expect(classifyFailure('codex timed out after 600s')).toBe('transient');
    expect(classifyFailure('codex exec exited with code 1: …worker quit with fatal: Transport channel closed, when Client(HttpRequest("http/request failed: error sending request"))')).toBe('transient');
    expect(classifyFailure('unusable reply: Unexpected end of JSON input')).toBe('model');
    expect(classifyFailure('Unexpected token S in JSON at position 0')).toBe('model');
  });

  it('pauses a backend on transient failures, rests it after five bad answers in a row, and lets it go on a success', () => {
    const h = newBackendHealth();
    const now = 1_000_000;
    expect(recordBackendOutcome(h, { ok: false, kind: 'transient', error: '429' }, now)).toBe(60_000);
    expect(recordBackendOutcome(h, { ok: false, kind: 'transient', error: '429' }, now)).toBe(120_000);
    expect(recordBackendOutcome(h, { ok: true }, now)).toBe(0);
    for (let i = 0; i < 4; i++) expect(recordBackendOutcome(h, { ok: false, kind: 'model', error: 'bad json' }, now)).toBe(0);
    expect(recordBackendOutcome(h, { ok: false, kind: 'model', error: 'bad json' }, now)).toBe(30 * 60_000);
    expect(recordBackendOutcome(h, { ok: false, kind: 'fatal', error: 'not logged in' }, now)).toBe(30 * 60_000);
    expect(h).toMatchObject({ calls: 9, ok: 1, failed: { transient: 2, model: 5, fatal: 1 } });
  });
});
