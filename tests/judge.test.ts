import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, defaultRoutedLlmConfig, LlmConnection } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { auditDuplicateClaims } from '../src/graph/claim-dedupe.js';
import { auditDuplicateEntities, mergeSuggestionId } from '../src/graph/dedupe.js';
import { sync } from '../src/ingest/sync.js';
import { judgesHere, LocalLabelingWorkers, localJudgeSpec } from '../src/labeling/local.js';
import { WorkerIdentity } from '../src/labeling/scheduler.js';
import { listSuggestions } from '../src/store/queries.js';
import { WorkBroker, WorkTask } from '../src/work/broker.js';
import { JudgeCall, JudgeRunner, JudgeSource, verdictMayDecide } from '../src/work/judge.js';

/**
 * The Judge stage's review calls as leased work (src/work/judge.ts): a review
 * offers all its judge calls at once, `serve`'s judge slots and remote
 * workers answer them side by side, and a remote verdict decides nothing by
 * itself unless `server.remote.judgeModels` names its model.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-judge-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const mac: WorkerIdentity = { worker: 'macbook/codex#1', backend: 'codex', remote: true };
const box: WorkerIdentity = { worker: 'aliyun/api#1', backend: 'api', remote: true };
const call = (label: string): JudgeCall => ({ label, messages: [{ role: 'system', content: 'Judge.' }, { role: 'user', content: label }], maxTokens: 50 });

describe('the judge source', () => {
  it('offers a review\'s calls at once and hands each answer back in its place, with the model that gave it', async () => {
    const source = new JudgeSource({ enabled: () => true }, { modelRetryMs: 0, transientRetryMs: 0 });
    const calls = ['a', 'b', 'c'].map(call);
    const answers = source.run(calls);
    const tasks = await source.lease(mac, 8);
    expect(tasks.map((t) => t.label)).toEqual(['a', 'b', 'c']);
    expect(tasks[0]).toMatchObject({ kind: 'judge', json: true, maxTokens: 50 });
    expect(tasks[0].prompt).toContain('single JSON object');
    // answered in any order, each lands in its own place
    for (const t of [...tasks].reverse()) {
      expect(await source.complete(t.id, mac, { ok: true, text: JSON.stringify({ same: t.label === 'b' }), model: 'codex:gpt-x' })).toEqual({ accepted: true });
    }
    expect(await answers).toEqual(['a', 'b', 'c'].map((l) => ({ ok: true, text: JSON.stringify({ same: l === 'b' }), model: 'remote:codex:gpt-x' })));
    expect(await source.lease(mac, 8)).toEqual([]);
  });

  it('sends a bad answer out again, fails a call after three, and gives up on one nobody answers in time', async () => {
    const source = new JudgeSource({ enabled: () => true, deadlineMs: () => 1_500 }, { modelRetryMs: 0, transientRetryMs: 0 });
    const answers = source.run([call('bad'), call('late')]);
    let late: WorkTask | undefined;
    for (let i = 0; i < 3; i++) {
      const tasks = await source.lease(box, 8);
      late ??= tasks.find((t) => t.label === 'late');
      const bad = tasks.find((t) => t.label === 'bad')!;
      // a busy backend first: it keeps the call's attempts
      if (i === 0) {
        expect(await source.complete(bad.id, box, { ok: false, error: 'HTTP 429 Too Many Requests' })).toEqual({ accepted: true });
        const [again] = (await source.lease(box, 8)).filter((t) => t.label === 'bad');
        expect(await source.complete(again.id, box, { ok: true, text: 'Sorry, I cannot help with that.' })).toEqual({ accepted: true });
        continue;
      }
      expect(await source.complete(bad.id, box, { ok: true, text: 'not json' })).toEqual({ accepted: true });
    }
    const [bad, unanswered] = await answers;
    expect(bad).toMatchObject({ ok: false });
    expect((bad as { error: string }).error).toContain('unusable reply');
    expect(unanswered).toMatchObject({ ok: false });
    expect((unanswered as { error: string }).error).toContain('no answer within');
    // the review stopped waiting: a late answer is refused
    expect(await source.complete(late!.id, box, { ok: true, text: '{"same":true}' })).toMatchObject({ accepted: false });
    expect((await source.status()).totals).toMatchObject({ unanswered: 1, failed: { model: 3, transient: 1 } });
  });

  it('gives up the calls nobody holds when processing stops, and lets the ones held finish', async () => {
    const source = new JudgeSource({ enabled: () => true });
    const answers = source.run([call('held'), call('waiting')]);
    const [held] = await source.lease(mac, 1);
    expect(source.cancelWaiting('processing stopped')).toBe(1);
    expect(await source.complete(held.id, mac, { ok: true, text: '{"same":false}', model: 'codex:gpt-x' })).toEqual({ accepted: true });
    expect(await answers).toEqual([
      { ok: true, text: '{"same":false}', model: 'remote:codex:gpt-x' },
      { ok: false, error: 'processing stopped' },
    ]);
    // stopped, it answers every call at once
    await source.stop();
    expect(source.enabled).toBe(false);
    expect(await source.run([call('after')])).toEqual([{ ok: false, error: 'the judge is stopped' }]);
  });
});

describe('a remote verdict', () => {
  const config = (judgeModels?: string[]) => ({ server: { ...defaultConfig().server, remote: { enabled: true, judgeModels } } });

  it('decides by itself only when judgeModels names its model', () => {
    expect(verdictMayDecide(config(), 'fake-model')).toBe(true);
    expect(verdictMayDecide(config(), 'remote:codex:gpt-x')).toBe(false);
    expect(verdictMayDecide(config(['codex:gpt-x']), 'remote:codex:gpt-x')).toBe(true);
    expect(verdictMayDecide(config(['codex:gpt-x']), 'remote:codex:gpt-y')).toBe(false);
    expect(verdictMayDecide(config(['codex:*']), 'remote:codex:gpt-y')).toBe(true);
    expect(verdictMayDecide(config(['codex:*']), 'remote:api:other')).toBe(false);
    expect(verdictMayDecide(config(['remote:api:other']), 'remote:api:other')).toBe(true);
    expect(verdictMayDecide(config(['', ' ']), 'remote:api:other')).toBe(false);
  });
});

/** A model endpoint that answers after `delayMs` and counts how many calls it had in flight at once. */
async function countingModel(answer: (user: string) => string, delayMs: number) {
  const state = { calls: 0, inFlight: 0, max: 0 };
  const app = new Hono();
  app.post('/v1/chat/completions', async (c) => {
    const body = (await c.req.json()) as { messages: { role: string; content: string }[] };
    state.calls++;
    state.inFlight++;
    state.max = Math.max(state.max, state.inFlight);
    await sleep(delayMs);
    state.inFlight--;
    const user = body.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
    return c.json({ choices: [{ message: { role: 'assistant', content: answer(user) } }] });
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Answer every judge call a source offers, as a remote worker would, until `n` are answered. */
async function answerAll(source: JudgeSource, who: WorkerIdentity, verdict: (task: WorkTask) => object, n: number, model = 'codex:gpt-x'): Promise<void> {
  const deadline = Date.now() + 15_000;
  let done = 0;
  while (done < n) {
    if (Date.now() > deadline) throw new Error(`only ${done} of ${n} judge calls came`);
    const tasks = await source.lease(who, 8);
    if (tasks.length === 0) {
      await sleep(20);
      continue;
    }
    for (const t of tasks) {
      await source.complete(t.id, who, { ok: true, text: JSON.stringify(verdict(t)), model });
      done++;
    }
  }
}

describe('a review on the judge source', () => {
  let model: Awaited<ReturnType<typeof countingModel>>;
  let ctx: AppContext;
  /** The four prefix pairs the audit finds, as their suggestion ids. */
  const pairs = [['宁德时代', '宁德时代新能源'], ['比亚迪', '比亚迪汽车'], ['招商银行', '招商银行深圳'], ['中芯国际', '中芯国际北京']];

  beforeAll(async () => {
    model = await countingModel(() => JSON.stringify({ same: true, confidence: 0.6, reason: '名称相近' }), 300);
    const dataDir = path.join(tmp, 'review');
    const conn: LlmConnection = {
      id: 'connection-1', label: 'fake', provider: 'openai', baseUrl: model.url, apiKey: 'sk-test',
      protocol: 'chat', model: 'fake-model', cliPath: '', effort: 'default', cliTimeoutMs: 30_000,
    };
    const base = defaultConfig();
    const route = { ...defaultRoutedLlmConfig(), use: 'connection-1' };
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'knode.config.json'), JSON.stringify({
      ...base,
      connections: [conn],
      llmUse: 'connection-1',
      // only judge slots here: no extraction or summary slot competes for the endpoint
      extraction: { ...base.extraction, entityLlm: route, summaryLlm: route, judgeLlm: route, workers: [{ use: 'connection-1', slots: 0 }], summaryConcurrency: 0 },
      review: { ...base.review, llmJudge: 'suggest', concurrency: 4 },
    }));
    write(dataDir, 'raw/docs/companies.md', `---
title: 公司
entities:
${pairs.flat().map((name) => `  - { name: ${name}, type: organization }`).join('\n')}
  - { name: 贵州茅台, type: organization }
  - { name: 五粮液, type: organization }
claims:
  - { subject: 贵州茅台, type: revenue, statement: 2025年营业收入为1700亿元 }
  - { subject: 贵州茅台, type: revenue, statement: 2025年实现营业收入1700亿元 }
  - { subject: 五粮液, type: profit, statement: 2025年净利润为300亿元 }
  - { subject: 五粮液, type: profit, statement: 2025年实现净利润300亿元 }
---
${pairs.flat().join('、')}都是公司。
`);
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });
  });
  afterAll(async () => {
    await ctx?.store.close();
    await model?.close();
  });

  it('runs its judge calls side by side on serve\'s judge slots, with no remote worker', async () => {
    expect(localJudgeSpec(ctx.config)).toMatchObject({ id: 'judge', kinds: ['judge'], slots: 4 });
    expect(judgesHere(ctx.config)).toBe(true);
    const judges = new JudgeSource({ enabled: () => judgesHere(ctx.config) });
    const broker = new WorkBroker([judges]);
    const workers = new LocalLabelingWorkers(broker, () => ctx.config, { idleMs: 10 });
    workers.start();
    try {
      const stats = await auditDuplicateEntities({ ...ctx, judge: judges }, {});
      expect(stats).toMatchObject({ candidates: 4, judged: 4, autoMerged: 0, llmRejected: 0 });
      // one call at a time would have had one in flight
      expect(model.state.calls).toBe(4);
      expect(model.state.max).toBeGreaterThanOrEqual(2);
      expect(workers.status().find((b) => b.id === 'judge')).toMatchObject({ slots: 4, calls: 4, ok: 4 });
      const filed = await listSuggestions(ctx.store, {});
      const [a, b] = pairs[0];
      expect((filed.find((s) => s.id === mergeSuggestionId(a, b))?.payload as { llm: { model: string } }).llm.model).toBe('fake-model');
    } finally {
      workers.stop();
      await broker.stop();
    }
  });

  it('files a remote verdict as a suggestion — merge or rejection — unless judgeModels names its model', async () => {
    ctx.config.review.llmJudge = 'auto';
    const remote = ctx.config.server.remote!;
    // the same for every pair but the last, which is two different things
    const verdict = (task: WorkTask) => (task.label.startsWith('中芯国际')
      ? { same: false, confidence: 0.9, reason: '不同的公司' }
      : { same: true, confidence: 0.99, reason: '同一家公司' });
    try {
      const judges = new JudgeSource({ enabled: () => true });
      const audit = auditDuplicateEntities({ ...ctx, judge: judges }, {});
      await answerAll(judges, mac, verdict, 4);
      expect(await audit).toMatchObject({ judged: 4, autoMerged: 0, llmRejected: 0, leftToPerson: 4, suggested: 4 });
      const filed = await listSuggestions(ctx.store, {});
      for (const [a, b] of pairs) {
        const s = filed.find((x) => x.id === mergeSuggestionId(a, b))!;
        expect(s.status).toBe('pending');
        expect((s.payload as { llm: { model: string } }).llm.model).toBe('remote:codex:gpt-x');
      }

      // named in judgeModels, the same verdicts decide: three merges and a rejection
      ctx.config.server.remote = { ...remote, judgeModels: ['codex:*'] };
      const trusted = new JudgeSource({ enabled: () => true });
      const again = auditDuplicateEntities({ ...ctx, judge: trusted }, {});
      await answerAll(trusted, mac, verdict, 4);
      expect(await again).toMatchObject({ judged: 4, autoMerged: 3, llmRejected: 1, leftToPerson: 0 });
      expect(await ctx.store.query(`SELECT canonical_id FROM entities WHERE id = '宁德时代' OR id = '宁德时代新能源' ORDER BY canonical_id NULLS LAST`))
        .toEqual([{ canonical_id: expect.any(String) }, { canonical_id: null }]);
    } finally {
      ctx.config.server.remote = remote;
    }
  });

  it('lets a remote verdict merge claims only when judgeModels names its model, and sends the batches together', async () => {
    const remote = ctx.config.server.remote!;
    ctx.config.server.remote = { ...remote, judgeModels: ['codex:*'] };
    let runs = 0;
    const runner: JudgeRunner = {
      enabled: true,
      run: async (calls) => {
        runs++;
        return calls.map((c) => ({
          ok: true as const,
          text: JSON.stringify({ verdicts: [{ pair: 1, relation: 'same', keep: 'a', confidence: 0.97, reason: '同一事实' }] }),
          // 茅台 from a trusted model, 五粮液 from one judgeModels does not name
          model: /subject: 贵州茅台/.test(c.messages[1].content) ? 'remote:codex:gpt-x' : 'remote:api:other',
        }));
      },
    };
    try {
      const stats = await auditDuplicateClaims({ ...ctx, judge: runner }, { pairsPerCall: 1 });
      expect(runs).toBe(1);
      expect(stats).toMatchObject({ judged: 2, merged: 1, suggested: 1, leftToPerson: 1 });
      const filed = (await listSuggestions(ctx.store, { status: 'pending' })).filter((s) => s.kind === 'claim-merge');
      expect(filed).toHaveLength(1);
      expect(filed[0].title).toContain('五粮液');
    } finally {
      ctx.config.server.remote = remote;
    }
  });
});
