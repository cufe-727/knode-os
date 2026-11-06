import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmbeddingProvider } from '../src/ingest/embeddings.js';
import type { LlmClient } from '../src/llm/client.js';
import { leakedPaths, pathTokens } from '../src/eval/agent.js';
import { Meter, parseTag, formatTag } from '../src/eval/meter.js';
import { loadPack, stageCorpus, validatePack } from '../src/eval/pack.js';
import { buildFixturePack } from '../src/eval/packs/fixture.js';
import { buildReportData, writeReport } from '../src/eval/report.js';
import { runEval } from '../src/eval/run.js';
import { RunStore } from '../src/eval/runstore.js';
import { ChatBackend, ChatRequest, decodeVector, retryableFailure, startShim } from '../src/eval/shim.js';
import { retrievalScores } from '../src/eval/metrics/retrieval.js';
import { bootstrapMean, holm, pairedBootstrap, wilson } from '../src/eval/metrics/stats.js';
import { characteristicTerms, directions, profileText } from '../src/eval/metrics/stylometry.js';
import { exactMatch, extractFinalAnswer, stripMarkers, tokenF1 } from '../src/eval/metrics/text.js';
import { EmbeddingBudget, QuotaGuard } from '../src/eval/quota.js';
import { byFileName } from '../src/eval/systems/external.js';
import { llmWikiBuild } from '../src/eval/systems/llm-wiki.js';
import { citationsIn } from '../src/eval/prompts.js';
import type { SystemEnv } from '../src/eval/systems/types.js';
import type { CodexAccount } from '../src/estimate/codex.js';

/** docs/design/23: the benchmark suite end to end on the fixture pack, with no network and no real model. */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-eval-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Answers every prompt the systems send, by what the prompt is for. */
class ScriptedBackend implements ChatBackend {
  readonly label = 'scripted';
  calls = 0;
  async complete(req: ChatRequest) {
    this.calls++;
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const user = req.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    let text: string;
    if (system.includes('knowledge-graph extraction engine')) {
      text = JSON.stringify({
        entities: [
          { name: '林晓', type: 'person', description: '数据工程师', aliases: [] },
          { name: '澜舟科技', type: 'organization', description: '林晓的新公司', aliases: ['澜舟'] },
        ],
        relations: [{ source: '林晓', target: '澜舟科技', type: 'works_at', description: '入职' }],
        claims: user.includes('岗位为高级数据工程师')
          ? [{ subject: '林晓', statement: '林晓在澜舟科技的岗位是高级数据工程师', type: 'event', status: 'fact', kind: 'fact' }]
          : [],
      });
    } else if (system.includes('Summarize the document')) {
      text = '林晓的近况。\n\n## Key points\n\n- 林晓将入职澜舟科技';
    } else if (system.includes('You answer questions from a personal knowledge base')) {
      text = '林晓的岗位是高级数据工程师 [1]。\nFinal answer: 高级数据工程师\n{"citations":[1],"gaps":[]}';
    } else if (req.json) {
      text = '{}';
    } else {
      text = '林晓在澜舟科技担任高级数据工程师 [doc: email/2026-03-05.md]。\nFinal answer: 高级数据工程师';
    }
    return { text, usage: { inputTokens: 100, cachedInputTokens: 40, cacheWriteTokens: 0, outputTokens: 20, reasoningTokens: 0 }, model: 'scripted' };
  }
}

/** A judge that agrees with everything, answering every verdict kind at once. */
function scriptedJudge(): LlmClient & { calls: number } {
  const judge = {
    calls: 0,
    label: 'scripted-judge',
    model: 'scripted-judge',
    enabled: true,
    async completeJson<T>(messages: { role: string; content: string }[], opts: { onUsage?: (u: unknown) => void } = {}): Promise<T> {
      judge.calls++;
      const items = (JSON.parse(messages.find((m) => m.role === 'user')!.content) as { items: { id: string }[] }).items;
      opts.onUsage?.({ inputTokens: 50, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0 });
      return { verdicts: items.map((i) => ({ id: i.id, score: 2, keypoints: [0], abstained: false, hallucinated: false, present: true, unit: 0, verdict: 'supported', claims: ['林晓将入职澜舟科技'], pairs: [[0, 0]], correct: true, same: false, contradict: false })) } as T;
    },
  };
  return judge as unknown as LlmClient & { calls: number };
}

describe('metrics', () => {
  it('scores multi-gold retrieval', () => {
    const r = retrievalScores(['a', 'x', 'b', 'y'], ['a', 'b']);
    expect(r.recall[2]).toBe(0.5);
    expect(r.recall[5]).toBe(1);
    expect(r.all[2]).toBe(0);
    expect(r.all[5]).toBe(1);
    expect(r.mrr10).toBe(1);
    expect(r.ndcg10).toBeCloseTo((1 + 1 / Math.log2(4)) / (1 + 1 / Math.log2(3)), 6);
  });

  it('reads final answers, matches and F1 in Chinese and English', () => {
    expect(extractFinalAnswer('reasoning…\nFinal answer: 4800 元')).toBe('4800 元');
    expect(extractFinalAnswer('最终答案：陈刚')).toBe('陈刚');
    expect(exactMatch('The Hive', ['hive'])).toBe(true);
    expect(tokenF1('高级数据工程师', ['数据工程师'])).toBeGreaterThan(0.8);
    expect(stripMarkers('答案 [1][2] raw/docs/a.md\n{"citations":[1],"gaps":[]}')).toBe('答案');
  });

  it('computes intervals, paired bootstrap and Holm', () => {
    const [lo, hi] = wilson(55, 60);
    expect(lo).toBeCloseTo(0.82, 2);
    expect(hi).toBeCloseTo(0.96, 2);
    const ci = bootstrapMean([1, 1, 0, 1, 0, 1, 1, 1]);
    expect(ci[0]).toBeLessThan(0.75);
    expect(ci[1]).toBeGreaterThan(0.75);
    const better = pairedBootstrap(Array(40).fill(1), Array(40).fill(0).map((_, i) => (i % 4 === 0 ? 1 : 0)));
    expect(better.diff).toBeCloseTo(0.75, 6);
    expect(better.p).toBeLessThan(0.01);
    expect(holm([0.001, 0.04, 0.03])).toEqual([true, false, false]);
  });

  it('profiles style and finds characteristic terms', () => {
    const austen = 'It is a truth universally acknowledged. "Indeed!" said she. Her sister was very much obliged. '.repeat(40);
    const other = 'The ship sailed at dawn. Men shouted on deck. The sea was grey and cold. '.repeat(40);
    const pa = profileText(austen, 'en');
    const pb = profileText(other, 'en');
    expect(pa.dialogueShare).toBeGreaterThan(pb.dialogueShare);
    expect(directions(pa, pb).dialogue).toBe('higher');
    const terms = characteristicTerms(austen, other, { lang: 'en', k: 5 }).map((t) => t.term);
    expect(terms.some((t) => ['sister', 'obliged', 'truth', 'universally', 'acknowledged', 'indeed'].includes(t))).toBe(true);
    const zh = characteristicTerms('宝玉笑道：“好妹妹。”黛玉听了。'.repeat(30), '曹操大怒，引兵而去。'.repeat(30), { lang: 'zh', k: 5 }).map((t) => t.term);
    expect(zh.some((t) => ['宝玉', '黛玉', '妹妹'].includes(t))).toBe(true);
  });

  it('reads citations that name a document by its file name alone', () => {
    // LightRAG shows its model basenames, and law-cn has an 01-总则.md for each law
    const docs = new Set(['民法典/01-总则/01-基本规定.md', '证券法/01-总则.md', '公司法/01-总则.md', 'chat/w01-2026-03-03-1.md']);
    const text = '依照规定。[doc: 01-基本规定.md] 另见 [doc: 01-总则.md]\n\n### References\n* [1] w01-2026-03-03-1.md\n* [2] 02-附则.md';
    expect(citationsIn(text, docs).map((c) => c.doc)).toEqual([]);
    expect(citationsIn(text, docs, byFileName(docs, [])).map((c) => c.doc)).toEqual(['民法典/01-总则/01-基本规定.md', 'chat/w01-2026-03-03-1.md']);
    // a shared name resolves to the one document of that name the answer retrieved
    expect(citationsIn(text, docs, byFileName(docs, ['证券法/01-总则.md'])).map((c) => c.doc)).toEqual(['民法典/01-总则/01-基本规定.md', '证券法/01-总则.md', 'chat/w01-2026-03-03-1.md']);
    expect(byFileName(docs, ['证券法/01-总则.md', '公司法/01-总则.md'])('01-总则.md')).toBeUndefined();
    expect(byFileName(docs, [])('x/01-基本规定.md')).toBeUndefined();
  });
});

describe('agent audit and metering', () => {
  it('flags paths that reach the benchmark files and lets the folder be', () => {
    const cwd = path.join(os.tmpdir(), 'knode-eval-x', 'corpus');
    expect(pathTokens('rg -n foo ../tasks/usage.jsonl')).toEqual(['../tasks/usage.jsonl']);
    expect(leakedPaths('rg -n 林晓 .', cwd)).toEqual([]);
    expect(leakedPaths('cat chat/a.md', cwd)).toEqual([]);
    expect(leakedPaths(`cat ${os.homedir()}/knode-eval/packs/p/tasks/usage.jsonl`, cwd)).toHaveLength(1);
    expect(leakedPaths('ls /usr/bin', cwd)).toEqual([]);
  });

  it('round-trips meter tags', () => {
    expect(parseTag(formatTag({ system: 'knode', stage: 'extract', task: 'q1' }))).toEqual({ system: 'knode', stage: 'extract', task: 'q1' });
    expect(parseTag('nonsense', 'call').stage).toBe('call');
    const zh = formatTag({ system: 'knode-ask', stage: 'answer', task: 'q-e1-chat-远帆数据的高' });
    expect(/^[\x20-\x7e]+$/.test(zh)).toBe(true);
    expect(parseTag(zh).task).toBe('q-e1-chat-远帆数据的高');
  });

  it('pauses on a full window and goes on after it resets', async () => {
    let reads = 0;
    const slept: number[] = [];
    const guard = new QuotaGuard({
      read: async () => ({ readAt: '', plan: 'pro', windows: [{ minutes: 300, usedPercent: reads++ === 0 ? 97 : 10, resetsAt: new Date(Date.now() + 60_000).toISOString() }], credits: null, limitReached: null, daily: [] }),
      sleep: async (ms) => void slept.push(ms),
    });
    await guard.wait();
    expect(reads).toBe(2);
    expect(slept).toHaveLength(1);
  });

  it('keeps embeddings inside a daily budget and waits for the next UTC day', async () => {
    let now = Date.parse('2026-11-04T18:00:00Z');
    const slept: number[] = [];
    const meter = new Meter();
    const budget = new EmbeddingBudget({
      dailyTokens: 30,
      usedToday: (day) => meter.all((e) => e.at.startsWith(day)).reduce((s, e) => s + (e.embeddingTokens ?? 0), 0),
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });
    let poolSays: string | null = null;
    const inner = createEmbeddingProvider({ provider: 'local', baseUrl: '', apiKey: '', model: '', dimensions: 8, batchSize: 8, sendDimensions: false });
    const pool = { ...inner, model: inner.model, dimensions: inner.dimensions, embed: async (t: string[]) => {
      if (poolSays) throw new Error(poolSays);
      return inner.embed(t);
    } } as typeof inner;
    const shim = await startShim({ backend: new ScriptedBackend(), embedder: pool, meter, embeddingBudget: budget });
    try {
      const embed = (texts: string[]) => shim.embedder!.embedAs({ system: 's', stage: 'embed' }, texts);
      await embed(['alpha beta gamma delta epsilon zeta eta theta']);
      await expect(embed(Array.from({ length: 20 }, (_, i) => `text number ${i} with several words in it`))).rejects.toThrow(/daily budget reached/);
      expect(budget.refusals).toBe(1);
      await budget.wait();
      expect(new Date(now).toISOString()).toBe('2026-11-05T00:05:00.000Z');
      // the pool's own refusal: a spent daily quota closes it until the next day too
      poolSays = 'embedding request failed (429): Embedding pool unavailable: Cloudflare · a: daily quota reached';
      await expect(embed(['one more'])).rejects.toThrow(/429/);
      expect(budget.refusals).toBe(2);
      poolSays = null;
      await expect(embed(['and another'])).rejects.toThrow(/closed until 2026-11-06T00:05/);
      await budget.wait();
      expect(await embed(['and another'])).toHaveLength(1);
      expect(slept).toHaveLength(2);
    } finally {
      await shim.close();
    }
  });

  it('serves chat and embeddings through the shim, metered by tag', async () => {
    const meter = new Meter();
    const backend = new ScriptedBackend();
    const shim = await startShim({ backend, embedder: createEmbeddingProvider({ provider: 'local', baseUrl: '', apiKey: '', model: '', dimensions: 64, batchSize: 8, sendDimensions: false }), meter, keepAliveMs: 5 });
    try {
      const auth = { authorization: `Bearer ${formatTag({ system: 's1', stage: 'answer', task: 't1' })}`, 'content-type': 'application/json' };
      const chat = await fetch(`${shim.baseUrl}/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }) });
      const body = JSON.parse(await chat.text()) as { choices: { message: { content: string } }[] };
      expect(body.choices[0].message.content).toContain('Final answer');
      const tools = await fetch(`${shim.baseUrl}/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ messages: [], tools: [{ type: 'function' }] }) });
      expect(tools.status).toBe(400);
      const emb = await fetch(`${shim.baseUrl}/embeddings`, { method: 'POST', headers: auth, body: JSON.stringify({ input: ['a', 'b'], encoding_format: 'base64' }) });
      const ej = (await emb.json()) as { data: { embedding: string }[] };
      expect(decodeVector(ej.data[0].embedding).length).toBe(64);
      const u = meter.usage((e) => e.system === 's1');
      expect(u.calls).toBe(1);
      expect(u.embeddingCalls).toBe(1);
      expect(meter.all((e) => e.task === 't1')).toHaveLength(2);
    } finally {
      await shim.close();
    }
  });

  it('tries a call again when the model is at capacity, not when the quota is spent', async () => {
    const meter = new Meter();
    const failures = ['codex exec failed (1): Selected model is at capacity. Please try a different model.', 'codex exec failed (1): You have hit your usage limit.'];
    let calls = 0;
    const backend: ChatBackend = {
      label: 'flaky',
      async complete() {
        calls++;
        if (calls === 1) throw new Error(failures[0]);
        if (calls === 3) throw new Error(failures[1]);
        return { text: `reply ${calls}`, usage: null, model: 'flaky' };
      },
    };
    expect(retryableFailure(new Error(failures[0]))).toBe(true);
    expect(retryableFailure(Object.assign(new Error('codex exec failed (1): stream disconnected'), { usage: { inputTokens: 10 } }))).toBe(false);
    const shim = await startShim({ backend, meter, keepAliveMs: 5, retryBaseMs: 1 });
    try {
      const ask = async (content: string) => {
        const res = await fetch(`${shim.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${formatTag({ system: 's1', stage: 'answer' })}`, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content }] }) });
        return JSON.parse(await res.text()) as { choices?: { message: { content: string } }[]; error?: { message: string } };
      };
      expect((await ask('one')).choices?.[0].message.content).toBe('reply 2');
      expect((await ask('two')).error?.message).toContain('usage limit');
      expect(calls).toBe(3);
      expect(meter.usage(() => true).failedCalls).toBe(2);
    } finally {
      await shim.close();
    }
  });
});

describe('a run on the fixture pack', () => {
  const packDir = path.join(tmp, 'packs', 'fixture-life');
  const runDir = path.join(tmp, 'runs', 'r1');
  const bin = path.join(tmp, 'bin');
  const backend = new ScriptedBackend();
  const judge = scriptedJudge();
  const embedder = createEmbeddingProvider({ provider: 'local', baseUrl: '', apiKey: '', model: '', dimensions: 384, batchSize: 64, sendDimensions: false });
  const systems = ['knode-ask', 'knode-sag', 'agent-knode-wiki', 'agent-wiki', 'agent-grep', 'rag-hybrid', 'rag-bm25', 'closed-book', 'long-context'];
  let oldPath: string | undefined;

  beforeAll(() => {
    fs.mkdirSync(bin, { recursive: true });
    const codex = path.join(bin, 'codex');
    fs.writeFileSync(codex, `#!/bin/sh\nexec node "${path.resolve('tests/helpers/fake-codex.mjs')}" "$@"\n`);
    fs.chmodSync(codex, 0o755);
    oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${process.env.PATH}`;
  });
  afterAll(() => {
    process.env.PATH = oldPath;
  });

  it('builds a valid pack', () => {
    const issues = buildFixturePack(packDir);
    expect(issues.errors).toEqual([]);
    const pack = loadPack(packDir);
    expect(pack.docs.length).toBe(7);
    expect(pack.updates).toEqual(['01']);
    expect(validatePack(pack).errors).toEqual([]);
  });

  it('runs every native system, scores it and reports', async () => {
    const res = await runEval({
      packs: [packDir], systems, runDir, quota: false,
      overrides: { chat: backend, judge, embedder },
    });
    const store = new RunStore(res.runDir);
    const builds = store.allBuilds();
    expect(builds.map((b) => b.system).sort()).toEqual(expect.arrayContaining(['knode', 'llm-wiki', 'rag', 'long-context']));
    expect(builds.every((b) => b.ok)).toBe(true);
    const knode = builds.find((b) => b.system === 'knode')!;
    expect(knode.usage.calls).toBeGreaterThan(0);
    expect(knode.stages.extract?.calls).toBeGreaterThan(0);
    expect(knode.usage.embeddingTokens).toBeGreaterThan(0);
    const wiki = builds.find((b) => b.system === 'llm-wiki')!;
    expect(wiki.usage.calls).toBeGreaterThan(0);

    const answers = store.allAnswers();
    for (const s of ['knode-ask', 'agent-knode-wiki', 'agent-wiki', 'agent-grep', 'rag-hybrid', 'closed-book', 'long-context']) {
      expect(answers.filter((a) => a.system === s).length, s).toBeGreaterThan(0);
    }
    expect(answers.some((a) => a.taskId === 'u1')).toBe(true);
    expect(answers.filter((a) => a.leaked?.length)).toEqual([]);
    const grep = answers.find((a) => a.system === 'agent-grep' && a.taskId === 'q1')!;
    expect(grep.citations.map((c) => c.doc)).toContain('email/2026-03-05.md');
    expect(grep.usage.calls).toBe(1);

    const scores = store.allScores();
    const metric = (system: string, m: string) => scores.filter((s) => s.system === system && s.metric === m);
    expect(metric('knode-ask', 'correctness').length).toBeGreaterThan(0);
    expect(metric('agent-grep', 'em').find((s) => s.taskId === 'q1')?.value).toBe(1);
    expect(metric('rag-bm25', 'recall@5').length).toBeGreaterThan(0);
    expect(metric('knode-sag', 'recall@5').length).toBeGreaterThan(0);
    expect(metric('knode-ask', 'coverage')[0]?.value).toBe(1);
    expect(metric('agent-wiki', 'units')[0]?.value).toBeGreaterThan(0);
    expect(metric('closed-book', 'citation_precision').every((s) => s.value === null)).toBe(true);
    expect(scores.some((s) => s.metric === 'injection_success')).toBe(true);
    expect(scores.some((s) => s.metric === 'label_correct' && s.taskId === 'e1')).toBe(true);

    const report = writeReport(res.runDir);
    const md = fs.readFileSync(report.md, 'utf8');
    expect(md).toContain('## fixture-life');
    expect(md).toContain('Build cost');
    expect(buildReportData(res.runDir).pooled.some((p) => p.system === 'knode-ask')).toBe(true);
  }, 120_000);

  it('goes on with an LLM-wiki build from its last finished session', async () => {
    const pack = loadPack(packDir);
    const workDir = path.join(tmp, 'wiki-resume');
    const meter = new Meter();
    const lines: string[] = [];
    const env = (quota: QuotaGuard) => ({ runId: 'resume', pack, staged: stageCorpus(pack), workDir, meter, quota, models: { model: '', buildEffort: 'low' }, log: (m: string) => lines.push(m) }) as unknown as SystemEnv;
    // the quota runs out before the third session: the build stops with two done
    let reads = 0;
    const tight = new QuotaGuard({ policy: { maxWaitMs: -1 }, sleep: async () => {}, read: async () => ({ windows: [{ minutes: 10080, usedPercent: ++reads > 2 ? 99 : 0, resetsAt: null }], limitReached: null }) as unknown as CodexAccount });
    const wiki = llmWikiBuild;
    await expect(wiki(env(tight), 2)).rejects.toThrow(/quota guard gave up/);
    expect(meter.all((e) => e.system === 'llm-wiki' && !e.replayed)).toHaveLength(2);
    const res = await wiki(env(new QuotaGuard({ enabled: false })), 2);
    expect(lines).toContain('llm-wiki: resuming at 4/7 sources');
    expect(res.notes.sessions).toBe(4);
    expect(meter.all((e) => e.system === 'llm-wiki' && e.replayed)).toHaveLength(2);
    expect(meter.all((e) => e.system === 'llm-wiki' && !e.replayed)).toHaveLength(4);
    expect(fs.readdirSync(path.join(res.kbDir, 'sources'))).toHaveLength(7);
  });

  it('runs two packs at once without one closing the other\'s index', async () => {
    const twin = path.join(tmp, 'packs', 'fixture-twin');
    fs.cpSync(packDir, twin, { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(twin, 'pack.json'), 'utf8'));
    fs.writeFileSync(path.join(twin, 'pack.json'), JSON.stringify({ ...manifest, id: 'fixture-twin' }));
    const res = await runEval({
      packs: [packDir, twin], systems: ['knode-ask', 'rag-hybrid'], runDir: path.join(tmp, 'runs', 'two'), quota: false, packConcurrency: 2,
      overrides: { chat: backend, judge, embedder },
    });
    const store = new RunStore(res.runDir);
    expect(store.allBuilds().filter((b) => b.system === 'knode').map((b) => [b.pack, b.ok]).sort()).toEqual([['fixture-life', true], ['fixture-twin', true]]);
    expect(store.allAnswers().filter((a) => a.system === 'knode-ask' && !a.error).map((a) => a.pack).filter((p, i, xs) => xs.indexOf(p) === i).sort()).toEqual(['fixture-life', 'fixture-twin']);
  }, 120_000);

  it('resumes without asking anything again', async () => {
    const calls = backend.calls;
    const judged = judge.calls;
    const before = new RunStore(runDir).allAnswers().length;
    expect(new RunStore(runDir).allAnswers().filter((a) => a.error).map((a) => `${a.system}/${a.taskId}: ${a.error}`)).toEqual([]);
    await runEval({ packs: [packDir], systems, runDir, quota: false, overrides: { chat: backend, judge, embedder } });
    expect(new RunStore(runDir).allAnswers().length).toBe(before);
    expect(backend.calls).toBe(calls);
    expect(judge.calls).toBe(judged);
  }, 120_000);
});
