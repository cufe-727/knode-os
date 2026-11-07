import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmbeddingProvider } from '../src/ingest/embeddings.js';
import type { LlmClient } from '../src/llm/client.js';
import { leakedPaths, pathTokens } from '../src/eval/agent.js';
import { Meter, parseTag, formatTag } from '../src/eval/meter.js';
import { docText, loadPack, stageCorpus, validatePack } from '../src/eval/pack.js';
import { buildFixturePack } from '../src/eval/packs/fixture.js';
import { buildReportData, writeReport } from '../src/eval/report.js';
import { runEval } from '../src/eval/run.js';
import { fileLines, RunStore } from '../src/eval/runstore.js';
import { ChatBackend, ChatRequest, decodeVector, retryableFailure, startShim, VectorCache, vectorKey } from '../src/eval/shim.js';
import { retrievalScores } from '../src/eval/metrics/retrieval.js';
import { bootstrapMean, holm, pairedBootstrap, wilson } from '../src/eval/metrics/stats.js';
import { characteristicTerms, directions, profileText } from '../src/eval/metrics/stylometry.js';
import { exactMatch, extractFinalAnswer, stripMarkers, tokenF1 } from '../src/eval/metrics/text.js';
import { checkEndpoint, endpointUnder } from '../src/eval/endpoint.js';
import { EmbeddingBudget, QuotaGuard } from '../src/eval/quota.js';
import { chunkDocs } from '../src/eval/retrieval.js';
import { evalTempDir, removeHeldTempDirs, sweepStaleTempDirs } from '../src/eval/tmp.js';
import { byFileName } from '../src/eval/systems/external.js';
import { llmWikiBuild } from '../src/eval/systems/llm-wiki.js';
import { citationsIn } from '../src/eval/prompts.js';
import type { SystemEnv } from '../src/eval/systems/types.js';
import type { CodexAccount } from '../src/estimate/codex.js';
import { Judge } from '../src/eval/judge.js';
import { containsTerm, matchByAlias, matchByDocs, orderAccuracy, sameDate, scoreLists } from '../src/eval/score/lists.js';
import { firstNumber } from '../src/eval/score/usage.js';
import { buildScaleData, efficiencyOf, renderScale } from '../src/eval/report.js';
import { recipe, registerRecipe } from '../src/eval/packs/index.js';
import { extendPack } from '../src/eval/packs/extend.js';
import '../src/eval/packs/recipes.js';
import { draftCorpusTasks } from '../src/eval/packs/corpus-tasks.js';
import { PackWriter } from '../src/eval/packs/writer.js';
import { CORPUS_TASK_TYPES, emptyUsage, type GoldFact, type ListSpec, type Task } from '../src/eval/types.js';

/** An author that renders each planted event as its own document, adds plain fillers (or `filler`), and drafts nothing. */
function standInAuthor(lang: 'zh' | 'en', filler?: string): LlmClient {
  return {
    label: 'stand-in', model: 'stand-in', enabled: true,
    async completeJson(messages: { role: string; content: string }[]) {
      const system = messages[0].content;
      const user = messages[1]?.content ?? '';
      if (system.includes('realistic personal documents')) {
        const p = JSON.parse(user) as { events: { type: string; date: string; what: string; phrase: string }[] };
        const fillers = Number(system.match(/plus (\d+) ordinary documents/)?.[1] ?? 0);
        const docs = p.events.map((e, i) => ({ type: e.type, date: e.date, title: `event ${i}`, text: `${e.what}\n\n${e.phrase}` }));
        for (let i = 0; i < fillers; i++) docs.push({ type: 'chat', date: p.events[0]?.date ?? '2026-03-02', title: `filler ${i}`, text: filler ?? (lang === 'zh' ? '今天下雨了，在家做饭。' : 'It rained; cooked at home.') });
        return { docs };
      }
      if (system.includes('background noise')) {
        const n = Number(system.match(/Write (\d+) documents/)?.[1] ?? 1);
        return { docs: Array.from({ length: n }, (_, i) => ({ type: i % 2 ? 'email' : 'chat', date: '2026-03-02', title: `notice ${i}`, text: `快递已签收，单号${1000 + i}。` })) };
      }
      return {};
    },
  } as unknown as LlmClient;
}

/** An author for drafted corpus tasks over the test's documents: real quotes where they exist, and one invented quote per document. */
function draftingAuthor(docs: { path: string; text: string }[]): LlmClient {
  return {
    label: 'drafting', model: 'drafting', enabled: true,
    async completeJson(messages: { role: string; content: string }[]) {
      const system = messages[0].content;
      const user = messages[1]?.content ?? '';
      const paths = [...user.matchAll(/path="([^"]+)"/g)].map((m) => m[1]).filter((p, i, xs) => xs.indexOf(p) === i);
      if (system.startsWith('These names were extracted')) return { entities: [{ name: '星河资本', aliases: ['星河'], type: 'company' }, { name: '顾明', aliases: [], type: 'person' }, { name: '市场', aliases: [], type: 'other' }] };
      if (system.startsWith('For each document excerpt')) {
        return { statements: paths.flatMap((p) => {
          const text = docs.find((d) => d.path === p)!.text;
          const target = text.match(/目标价定为\d+元/)![0];
          const hq = text.match(/总部在\S{2}/)![0];
          return [
            { doc: p, entity: '星河资本', text: target, quote: target, date: p.slice(6, 13) },
            { doc: p, entity: '星河', text: hq, quote: hq, date: '' },
            { doc: p, entity: '星河资本', text: '编造', quote: '这句话不在文档里', date: '' },
          ];
        }) };
      }
      if (system.startsWith('Each entity comes with the statements')) {
        const input = JSON.parse(user) as { entity: string; statements: { id: string; doc: string; date: string; text: string }[] }[];
        return { entities: input.map((e) => {
          const targets = e.statements.filter((s) => s.text.includes('目标价'));
          const hq = e.statements.filter((s) => s.text.includes('总部'));
          return {
            entity: e.entity,
            facts: [...targets.map((s) => ({ label: s.text, statements: [s.id] })), { label: '总部', statements: hq.map((s) => s.id) }],
            timeline: [...targets].reverse().map((s) => ({ label: s.text, date: s.date, statements: [s.id] })),
            conflicts: [{ about: '总部', sides: [{ label: '苏州', statements: hq.filter((s) => s.text.includes('苏州')).map((s) => s.id) }, { label: '上海', statements: hq.filter((s) => s.text.includes('上海')).map((s) => s.id) }] }],
          };
        }) };
      }
      if (system.startsWith('Propose')) return { questions: [{ question: '列出每一个增持计划。', predicate: '提到增持计划', keywords: ['增持计划'], item: '计划编号' }, { question: '列出每一个火星基地。', predicate: '火星', keywords: ['火星基地'], item: '基地' }] };
      if (system.startsWith('For each excerpt, check each predicate')) {
        return { items: paths.map((p) => ({ doc: p, predicate: 'q0', name: docs.find((d) => d.path === p)!.text.match(/增持计划\d号/)![0], quote: docs.find((d) => d.path === p)!.text.match(/增持计划\d号/)![0] })) };
      }
      if (system.startsWith('For each predicate, merge')) return { predicates: [] };
      if (system.startsWith('Each chain is a sequence')) {
        const chains = JSON.parse(user) as { chain: number; bridges: string[] }[];
        return { tasks: chains.flatMap((c) => [{ chain: c.chain, question: `从${c.bridges[0]}出发的问题？`, answer: 'x' }, { chain: c.chain, question: '不点名的问题？', answer: 'y' }]) };
      }
      if (system.startsWith('For each item, read only the evidence')) return { verdicts: (JSON.parse(user) as { i: number }[]).map((it) => ({ i: it.i, consistent: true })) };
      return {};
    },
  } as unknown as LlmClient;
}

/** docs/design/23: the benchmark suite end to end on the fixture pack, with no network and no real model. */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-eval-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

// every test, in every block, reaches the stand-in codex: an agent system must never start the real CLI from a test
const fakeBin = path.join(tmp, 'fake-bin');
fs.mkdirSync(fakeBin, { recursive: true });
fs.writeFileSync(path.join(fakeBin, 'codex'), `#!/bin/sh\nexec node "${path.resolve('tests/helpers/fake-codex.mjs')}" "$@"\n`);
fs.chmodSync(path.join(fakeBin, 'codex'), 0o755);
const realPath = process.env.PATH;
beforeAll(() => {
  process.env.PATH = `${fakeBin}:${realPath}`;
});
afterAll(() => {
  process.env.PATH = realPath;
});

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
    } else if (user.includes('"items":[{"label"')) {
      // a list: two of March's runs, and the left knee with a document that says so
      text = '三月的记录如下。\n{"items":[{"label":"5公里","confidence":0.9,"evidence":["diary/2026-03-04.md"]},{"label":"8公里","confidence":0.8,"evidence":["chat/2026-03-09.md"]},{"label":"左膝","confidence":0.7,"evidence":["diary/2026-03-04.md"]}]}';
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

  it('reads a file line by line across read blocks', () => {
    const file = path.join(tmp, 'lines.jsonl');
    const lines = ['{"k":"第一行"}', '', 'x'.repeat(40), '民法典第十六条', 'last without newline'];
    fs.writeFileSync(file, lines.join('\n'));
    // blocks of 7 bytes split lines and the three bytes of a Chinese character alike
    expect([...fileLines(file, 7)]).toEqual(lines);
    fs.writeFileSync(file, 'a\nb\n');
    expect([...fileLines(file, 7)]).toEqual(['a', 'b']);
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
  const systems = ['knode-ask', 'knode-sag', 'agent-knode-wiki', 'agent-knode-wiki-sources', 'agent-wiki', 'agent-wiki-sources', 'agent-grep', 'rag-hybrid', 'rag-bm25', 'closed-book', 'long-context'];
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
    expect(pack.docs.length).toBe(12);
    expect(pack.updates).toEqual(['01', '02']);
    expect(pack.padding).toHaveLength(12);
    expect(validatePack(pack)).toEqual({ errors: [], warnings: [] });
    for (const type of ['aggregate', 'timeline', 'contradiction', 'profile', 'deep-hop'] as const) expect(pack.tasks.some((t) => t.type === type), type).toBe(true);
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
    for (const s of ['knode-ask', 'agent-knode-wiki', 'agent-knode-wiki-sources', 'agent-wiki', 'agent-wiki-sources', 'agent-grep', 'rag-hybrid', 'closed-book', 'long-context']) {
      expect(answers.filter((a) => a.system === s).length, s).toBeGreaterThan(0);
    }
    expect(answers.some((a) => a.taskId === 'u1')).toBe(true);
    // the update stream: both batches applied in order, each answer marked with the batch before it, each group's cost per batch
    expect(answers.filter((a) => a.system === 'rag-hybrid' && a.batch).map((a) => `${a.taskId}@${a.batch}`).sort()).toEqual(['u1@01', 'u2@02', 'u3@02']);
    expect(builds.filter((b) => b.system.includes('@')).map((b) => b.system).sort()).toEqual(expect.arrayContaining(['knode@01', 'knode@02', 'llm-wiki@01', 'llm-wiki@02', 'rag@01', 'rag@02']));
    expect(builds.filter((b) => b.system.includes('@')).every((b) => b.ok)).toBe(true);
    expect(builds.find((b) => b.system === 'knode@02')!.usage.calls).toBeGreaterThan(0);
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
    // corpus-level lists, without a model: two of five runs, every listed item a run; one side of the knee, cited
    const list = (system: string, task: string, m: string) => scores.find((s) => s.system === system && s.taskId === task && s.metric === m)?.value;
    expect(list('rag-hybrid', 'c-runs', 'set_recall')).toBeCloseTo(0.4, 6);
    expect(list('rag-hybrid', 'c-runs', 'set_precision')).toBeCloseTo(2 / 3, 6);
    expect(list('rag-hybrid', 'c-runs', 'correctness')).toBeCloseTo(0.5, 6);
    expect(list('rag-hybrid', 'c-knee', 'set_recall')).toBeCloseTo(0.5, 6);
    expect(list('rag-hybrid', 'c-knee', 'attribution_recall')).toBeCloseTo(0.25, 6);
    expect(list('rag-hybrid', 'c-bp', 'correctness')).toBe(0);
    expect(scores.some((s) => s.taskId === 'c-runs-count' && s.metric === 'em')).toBe(true);
    expect(scores.some((s) => s.taskId === 'c-chain' && s.metric === 'correctness')).toBe(true);

    const report = writeReport(res.runDir);
    const md = fs.readFileSync(report.md, 'utf8');
    expect(md).toContain('## fixture-life');
    expect(md).toContain('Build cost');
    expect(md).toContain('Use: corpus-level lists');
    expect(md).toContain('Correctness for its cost');
    expect(md).toContain('Update stream');
    const eff = report.data.efficiency['fixture-life'];
    expect(eff['agent-grep'].per1k).toBeGreaterThan(0);
    expect(eff['agent-wiki-sources'].buildTokens).toBe(eff['agent-wiki'].buildTokens);
    expect(eff['agent-wiki'].buildTokens).toBeGreaterThan(0);
    expect(buildReportData(res.runDir).pooled.some((p) => p.system === 'knode-ask')).toBe(true);
  }, 120_000);

  it('goes on with an LLM-wiki build from its last finished session', async () => {
    const pack = loadPack(packDir);
    const workDir = path.join(tmp, 'wiki-resume');
    const meter = new Meter();
    const lines: string[] = [];
    const staged = stageCorpus(pack);
    const env = (quota: QuotaGuard) => ({ runId: 'resume', pack, staged, workDir, meter, quota, models: { model: '', buildEffort: 'low' }, log: (m: string) => lines.push(m) }) as unknown as SystemEnv;
    // the quota runs out before the third session: the build stops with two done
    let reads = 0;
    const tight = new QuotaGuard({ policy: { maxWaitMs: -1 }, sleep: async () => {}, read: async () => ({ windows: [{ minutes: 10080, usedPercent: ++reads > 2 ? 99 : 0, resetsAt: null }], limitReached: null }) as unknown as CodexAccount });
    const wiki = llmWikiBuild;
    await expect(wiki(env(tight), 2)).rejects.toThrow(/quota guard gave up/);
    expect(meter.all((e) => e.system === 'llm-wiki' && !e.replayed)).toHaveLength(2);
    const res = await wiki(env(new QuotaGuard({ enabled: false })), 2);
    expect(lines).toContain('llm-wiki: resuming at 4/12 sources');
    expect(res.notes.sessions).toBe(6);
    expect(meter.all((e) => e.system === 'llm-wiki' && e.replayed)).toHaveLength(2);
    expect(meter.all((e) => e.system === 'llm-wiki' && !e.replayed)).toHaveLength(6);
    expect(fs.readdirSync(path.join(res.kbDir, 'sources'))).toHaveLength(12);
    staged.cleanup();
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

const answersOf = (dir: string) => new RunStore(dir).allAnswers();

describe('reusing builds', () => {
  it("starts a new run from an earlier run's builds of the same pack, and refuses one embedded differently", async () => {
    const packDir = path.join(tmp, 'packs', 'fixture-life');
    const first = path.join(tmp, 'runs', 'r1');
    const backend = new ScriptedBackend();
    const judge = scriptedJudge();
    const embedder = createEmbeddingProvider({ provider: 'local', baseUrl: '', apiKey: '', model: '', dimensions: 384, batchSize: 64, sendDimensions: false });
    const res = await runEval({ packs: [packDir], systems: ['knode-ask', 'agent-wiki-sources', 'rag-hybrid'], runDir: path.join(tmp, 'runs', 'reuse'), quota: false, types: ['aggregate', 'single-hop'], suites: ['usage'], reuseBuildsFrom: first, overrides: { chat: backend, judge, embedder } });
    // the stand-in codex answered, not the real one
    expect(answersOf(res.runDir).filter((a) => a.system === 'agent-wiki-sources').every((a) => a.text.includes('Final answer: 高级数据工程师'))).toBe(true);
    const store = new RunStore(res.runDir);
    const builds = store.allBuilds();
    expect(builds.map((b) => b.system).sort()).toEqual(['knode', 'llm-wiki', 'rag']);
    expect(builds.every((b) => (b.notes as { reusedFrom?: string }).reusedFrom === 'r1')).toBe(true);
    // nothing was built again: every model call answered a question
    const answered = store.allAnswers().filter((a) => a.system !== 'agent-wiki-sources').length;
    expect(backend.calls).toBe(answered);
    expect(store.allAnswers().some((a) => a.system === 'agent-wiki-sources' && !a.error)).toBe(true);
    const small = createEmbeddingProvider({ provider: 'local', baseUrl: '', apiKey: '', model: '', dimensions: 64, batchSize: 64, sendDimensions: false });
    await expect(runEval({ packs: [packDir], systems: ['rag-hybrid'], runDir: path.join(tmp, 'runs', 'reuse-64'), quota: false, reuseBuildsFrom: first, overrides: { chat: backend, judge, embedder: small } })).rejects.toThrow(/embedded with .*\(384\); this run embeds with .*\(64\)/);
  }, 120_000);
});

describe("an embedding endpoint of the run's own", () => {
  it('embeds under the identity once it reproduces the vectors the run holds, and is refused otherwise', async () => {
    const dir = path.join(tmp, 'endpoint-pack');
    buildFixturePack(dir);
    const pack = loadPack(dir);
    // a text's vector, or a different model's: half its coordinates flipped
    let other = false;
    const vector = (text: string) => [...crypto.createHash('sha256').update(text).digest().subarray(0, 8)].map((b, i) => (b - 127.5) * (other && i % 2 ? -1 : 1));
    const app = new Hono();
    app.post('/v1/embeddings', async (c) => {
      const body = (await c.req.json()) as { input: string[] };
      return c.json({ data: body.input.map((t, index) => ({ index, embedding: vector(t) })) });
    });
    let server: Server;
    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve(info.port)) as Server;
    });
    try {
      const identity = { model: 'pool:fake:8:l2-v1', dimensions: 8, embed: async (): Promise<number[][]> => { throw new Error('the pool is not called'); } };
      const held = new VectorCache(null);
      for (const c of chunkDocs(pack.docs.map((d) => ({ path: d.path, text: docText(pack, d.path) })))) held.put(vectorKey(identity.model, c.text), vector(c.text));
      const embedder = endpointUnder(identity, `http://127.0.0.1:${port}/v1`);
      expect(embedder.model).toBe(identity.model);
      const check = await checkEndpoint(embedder, held, [pack]);
      expect(check.texts).toBeGreaterThanOrEqual(5);
      expect(check.lowest).toBeGreaterThan(0.9999);
      // what comes back is a unit vector, as a pool's is
      const [v] = await embedder.embed(['anything']);
      expect(Math.hypot(...v)).toBeCloseTo(1, 6);
      other = true;
      await expect(checkEndpoint(embedder, held, [pack])).rejects.toThrow(/does not reproduce pool:fake:8:l2-v1/);
      await expect(checkEndpoint(embedder, new VectorCache(null), [pack])).rejects.toThrow(/only 0 texts/);
    } finally {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  });
});

describe("a run's temp directories", () => {
  it('are named for their process, and a sweep removes only those whose process is gone', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'sweep-'));
    const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)']).stdout.toString().trim();
    const kept = [`knode-eval-ro-${process.pid}-AbC123`, 'knode-eval-test-AbC123', 'knode-eval-wiki-0123456789abcdef'];
    for (const name of [`knode-eval-corpus-${dead}-AbC123`, `knode-eval-agent-out-${dead}-xyz789`, ...kept]) fs.mkdirSync(path.join(dir, name));
    expect(sweepStaleTempDirs(dir)).toBe(2);
    expect(fs.readdirSync(dir).sort()).toEqual([...kept].sort());

    const held = evalTempDir('corpus');
    expect(path.basename(held.root)).toMatch(new RegExp(`^knode-eval-corpus-${process.pid}-[A-Za-z0-9]{6}$`));
    const done = evalTempDir('ro');
    done.cleanup();
    expect(fs.existsSync(done.root)).toBe(false);
    // what is still held goes when a stopped run lets go of everything
    removeHeldTempDirs();
    expect(fs.existsSync(held.root)).toBe(false);
  });
});

describe('corpus-level tasks: matching without a model', () => {
  it('finds a term as a whole number or word, not inside a longer one', () => {
    expect(containsTerm('4月12日 跑了 18 公里', '18公里')).toBe(true);
    expect(containsTerm('跑了18公里', '8公里')).toBe(false);
    expect(containsTerm('血压150/95，好多了', '150/95')).toBe(true);
    expect(containsTerm('血压150/950', '150/95')).toBe(false);
    expect(containsTerm('Dinner with Tom Becker', 'Tom')).toBe(true);
    expect(containsTerm('Tomas came', 'Tom')).toBe(false);
    expect(containsTerm('ran 12 km on Sunday', '12km')).toBe(true);
    expect(containsTerm('第一百一十条', '第十条')).toBe(false);
    expect(containsTerm('见第110条', '第10条')).toBe(false);
  });

  it('pairs items by alias, by documents, and reads order and dates', () => {
    const gold = [
      { label: '5公里', aliases: [], weight: 1, date: '2026-03-04', docs: ['a.md'] },
      { label: '15公里', aliases: [], weight: 1, date: '2026-03-23', docs: ['b.md'] },
      { label: '8公里', aliases: ['8 km'], weight: 1, date: '2026-03-09', docs: ['c.md'] },
    ];
    expect(matchByAlias(['3月23日 15公里', '3月4日 5公里', '18公里'], gold)).toEqual([[0, 1], [1, 0]]);
    expect(matchByDocs([['raw/c.md'], ['corpus/a.md', 'x.md']], gold, new Set(['a.md', 'b.md', 'c.md']))).toEqual([[0, 2], [1, 0]]);
    // listed 15 before 5: one of the three dated pairs out of order
    expect(orderAccuracy([[0, 1], [1, 0], [2, 2]], gold)).toBeCloseTo(1 / 3, 6);
    expect(sameDate('3月23日', '2026-03-23')).toBe(true);
    expect(sameDate('2026年3月23日', '2026-03-23')).toBe(true);
    expect(sameDate('March 23, 2026', '2026-03-23')).toBe(true);
    expect(sameDate('2026-03', '2026-03')).toBe(true);
    expect(sameDate('3月24日', '2026-03-23')).toBe(false);
    expect(firstNumber('一共 5 次')).toBe(5);
    expect(firstNumber('十二次')).toBe(12);
    expect(firstNumber('二十三条')).toBe(23);
    expect(firstNumber('没有')).toBeNull();
    expect(firstNumber('一共五次')).toBe(5);
  });

  it('scores a list: F1, recall where the gold is a sample, order for a timeline, sides only with their documents', async () => {
    const meter = new Meter();
    const judge = new Judge({ client: scriptedJudge(), meter });
    const task = (id: string, type: Task['type'], list: Partial<ListSpec>): Task => ({
      id, suite: 'usage', type, question: '?', scoring: 'set', evidence: [],
      items: [
        { label: '左膝', aliases: ['left knee'], weight: 1, date: '2026-03-04', docs: ['a.md', 'b.md'] },
        { label: '右膝', aliases: [], weight: 1, date: '2026-03-09', docs: ['c.md'] },
      ],
      list: { match: 'alias', ordered: false, maxItems: 10, requireDocs: false, primary: 'f1', ...list },
    });
    const tasks = new Map([['p|k1', task('k1', 'contradiction', { requireDocs: true })], ['p|k2', task('k2', 'profile', { primary: 'recall' })], ['p|k3', task('k3', 'timeline', { ordered: true })]]);
    const answer = (taskId: string, text: string) => ({ key: taskId, pack: 'p', system: 's', taskId, at: '', text, finalAnswer: '', citations: [], retrieved: [], toolCalls: 0, usage: emptyUsage(), ms: 1 });
    const items = '{"items":[{"label":"右膝","date":"3月9日","evidence":["corpus/c.md"]},{"label":"左膝","date":"2026-03-04","evidence":["x.md"]},{"label":"脚踝","evidence":[]}]}';
    const scores = await scoreLists({ answers: [answer('k1', items), answer('k2', items), answer('k3', items)], tasks, corpusDocs: new Map([['p', new Set(['a.md', 'b.md', 'c.md', 'x.md'])]]) }, judge);
    const v = (task: string, m: string) => scores.find((s) => s.taskId === task && s.metric === m)?.value;
    // the left knee was named without one of its documents: not found
    expect(v('k1', 'set_recall')).toBe(0.5);
    expect(v('k1', 'correctness')).toBeCloseTo((2 * (1 / 3) * 0.5) / (1 / 3 + 0.5), 6);
    expect(v('k2', 'correctness')).toBe(1);
    expect(v('k3', 'order_accuracy')).toBe(0);
    expect(v('k3', 'correctness')).toBe(0);
    expect(v('k3', 'date_accuracy')).toBe(1);
  });
});

describe('corpus-level tasks: packs', () => {
  const dir = path.join(tmp, 'corpus-pack');
  beforeAll(() => {
    buildFixturePack(dir);
  });

  it('refuses corpus-level gold that is too narrow, undated, shallow or open to padding', () => {
    const pack = loadPack(dir);
    const runs = pack.tasks.find((t) => t.id === 'c-runs')!;
    const narrow = { ...runs, id: 'narrow', evidence: runs.evidence.slice(0, 3) };
    const undated = { ...pack.tasks.find((t) => t.id === 'c-bp')!, id: 'undated', items: pack.tasks.find((t) => t.id === 'c-bp')!.items!.map(({ date: _d, ...it }) => it) };
    const shallow = { ...pack.tasks.find((t) => t.id === 'c-chain')!, id: 'shallow', evidence: pack.tasks.find((t) => t.id === 'c-chain')!.evidence.slice(0, 2) };
    const count = { ...pack.tasks.find((t) => t.id === 'c-runs-count')!, id: 'count', answer: '五次' };
    fs.mkdirSync(path.join(dir, 'padding', 'diary'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'padding', 'diary', 'extra.md'), '# 日记\n\n今天又跑了20公里。\n');
    const errors = validatePack({ ...pack, tasks: [...pack.tasks, narrow, undated, shallow, count], padding: [...pack.padding, { path: 'diary/extra.md' }] }).errors.join('\n');
    expect(errors).toContain('task narrow: a aggregate task needs evidence in at least 5 documents (has 3)');
    expect(errors).toContain('task undated: every timeline item needs a date');
    expect(errors).toContain("task shallow: a deep-hop task's hops lie in at least 3 different documents");
    expect(errors).toContain('task count: count scoring needs a number as the answer');
    expect(errors).toContain('task c-runs: padding document diary/extra.md mentions its closed-world term "公里"');
    fs.rmSync(path.join(dir, 'padding', 'diary'), { recursive: true });
  });

  it('stages padding above fraction 1 and refuses a fraction the padding cannot fill', () => {
    const pack = loadPack(dir);
    const two = stageCorpus(pack, { fraction: 2, seed: 1 });
    expect(two.docs).toHaveLength(24);
    expect(two.padded).toBe(12);
    expect(two.tasks.length).toBe(pack.tasks.length);
    expect(fs.existsSync(path.join(two.dir, 'newsletter'))).toBe(true);
    two.cleanup();
    expect(() => stageCorpus(pack, { fraction: 3 })).toThrow(/has 12 padding documents; --fraction 3 needs 24/);
  });

  it('builds a synthetic life whose corpus-level gold comes from its script', async () => {
    const out = path.join(tmp, 'synthetic');
    const logs: string[] = [];
    const issues = await recipe('synthetic-life-zh').build(out, { author: standInAuthor('zh'), seed: 7, log: (m) => logs.push(m), options: { padding: 2 } });
    expect(issues.errors).toEqual([]);
    const pack = loadPack(out);
    const corpus = pack.tasks.filter((t) => (CORPUS_TASK_TYPES as readonly string[]).includes(t.type));
    expect(corpus.length).toBeGreaterThanOrEqual(40);
    for (const type of CORPUS_TASK_TYPES) expect(corpus.some((t) => t.type === type), type).toBe(true);
    expect(Math.min(...corpus.map((t) => new Set(t.evidence.map((e) => e.doc)).size))).toBeGreaterThanOrEqual(5);
    expect(pack.tasks.filter((t) => t.type === 'deep-hop').length).toBeGreaterThanOrEqual(4);
    expect(pack.updates).toEqual(['01', '02', '03', '04']);
    expect(pack.tasks.filter((t) => t.afterUpdate).map((t) => t.afterUpdate)).toEqual(expect.arrayContaining(['01', '02', '03', '04']));
    expect(pack.padding.length).toBe(pack.docs.length);
    // what the script says: the runs of March, the blood-pressure readings, the knee
    const marchRuns = pack.tasks.find((t) => t.id === 'l-runs-3')!;
    expect(marchRuns.items!.every((it) => /^\d+公里$/.test(it.label))).toBe(true);
    expect(pack.tasks.find((t) => t.id === 'n-runs-3')!.answer).toBe(String(marchRuns.items!.length));
    expect(pack.tasks.find((t) => t.id === 't-bp')!.items!.map((it) => it.label)[0]).toBe('152/96');
    expect(pack.tasks.find((t) => t.id === 'c-knee')!.items!.map((it) => [it.label, it.docs!.length])).toEqual([['右膝', 1], ['左膝', 4]]);
  }, 60_000);

  it('drops the runs a filler adds to, and keeps the rest', async () => {
    const out = path.join(tmp, 'synthetic-broken');
    const logs: string[] = [];
    await recipe('synthetic-life-zh').build(out, { author: standInAuthor('zh', '晚上又跑了3公里。'), seed: 7, log: (m) => logs.push(m), options: {} });
    const pack = loadPack(out);
    expect(pack.tasks.some((t) => /^(l-runs|n-runs|t-long-runs)/.test(t.id))).toBe(false);
    expect(pack.tasks.some((t) => t.id === 't-bp')).toBe(true);
    expect(logs.some((l) => l.includes('dropped') && l.includes('3公里'))).toBe(true);
  }, 60_000);

  it('drafts profiles, timelines, contradictions, aggregates and chains with every quote checked', async () => {
    const docs = Array.from({ length: 7 }, (_, i) => ({
      path: `notes/2026-0${i + 1}-01.md`, date: `2026-0${i + 1}-01`,
      text: `# 第${i + 1}期\n\n星河资本在${i + 1}月把目标价定为${100 + i * 10}元。${i % 2 ? '分析师看多。' : '分析师看空。'}本期还提到了增持计划${i}号。顾明说星河资本的总部在${i < 3 ? '苏州' : '上海'}。`,
    }));
    const facts: GoldFact[] = docs.map((d, i) => ({ id: `f${i}`, text: `星河资本目标价${100 + i * 10}元`, doc: d.path, quote: `目标价定为${100 + i * 10}元`, entities: ['星河资本', i < 3 ? '顾明' : '上海', i < 3 ? '苏州' : '增持计划'] }));
    const author = draftingAuthor(docs);
    const logs: string[] = [];
    const tasks = await draftCorpusTasks(author, facts, docs, { lang: 'zh', plan: { profile: 2, timeline: 2, contradiction: 2, aggregate: 2, deep: 2, maxDocs: 10 }, seed: 1, log: (m) => logs.push(m) });
    const byType = (t: string) => tasks.filter((x) => x.type === t);
    expect(byType('profile')).toHaveLength(1);
    expect(byType('timeline')).toHaveLength(1);
    expect(byType('contradiction')).toHaveLength(1);
    expect(byType('aggregate')).toHaveLength(1);
    expect(logs.some((l) => l.includes('(7 quotes not in their document)'))).toBe(true);
    expect(byType('timeline')[0].items!.map((it) => it.date)).toEqual([...byType('timeline')[0].items!.map((it) => it.date)].sort());
    expect(byType('contradiction')[0].list?.requireDocs).toBe(true);
    expect(byType('aggregate')[0].closedWorld?.terms).toEqual(['增持计划']);
    // a chain whose question names its bridge is not a chain
    expect(byType('deep-hop').every((t) => !String(t.question).includes('苏州'))).toBe(true);
    // what was drafted holds up in a pack
    const out = path.join(tmp, 'drafted');
    const w = new PackWriter(out, { id: 'drafted', version: 1, title: 't', domain: 'fixture', languages: ['zh'], description: 'd', builder: { recipe: 'test' } });
    for (const d of docs) w.addDoc({ path: d.path, date: d.date }, d.text);
    for (const f of facts) w.addFact(f);
    for (const t of tasks) w.addTask(t);
    expect(w.finish().errors).toEqual([]);
  });
});

describe('extending a built pack', () => {
  it('adds model-free corpus tasks and padding from a rebuild, leaving the corpus and the other tasks as they are', async () => {
    const dir = path.join(tmp, 'old-pack');
    buildFixturePack(dir);
    // an older pack: no corpus-level tasks, no padding
    const usage = fs.readFileSync(path.join(dir, 'tasks', 'usage.jsonl'), 'utf8').split('\n').filter((l) => l && !/"type":"(aggregate|timeline|contradiction|profile|deep-hop)"/.test(l));
    fs.writeFileSync(path.join(dir, 'tasks', 'usage.jsonl'), usage.join('\n') + '\n');
    fs.rmSync(path.join(dir, 'padding'), { recursive: true });
    fs.rmSync(path.join(dir, 'padding.jsonl'));
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ ...manifest, builder: { ...manifest.builder, recipe: 'fixture-rebuilt' } }));
    registerRecipe({ id: 'fixture-rebuilt', title: 't', domain: 'fixture', network: false, needsAuthor: false, modelFreeCorpus: true, padding: 'local', build: async (out) => buildFixturePack(out) });
    const before = loadPack(dir);
    const logs: string[] = [];
    const r = await extendPack(dir, { seed: 0, options: {}, log: (m) => logs.push(m), padding: 2 });
    expect(r.errors).toEqual([]);
    const after = loadPack(dir);
    expect(r.added).toBe(6);
    expect(after.tasks.length).toBe(before.tasks.length + 6);
    expect(after.docs.map((d) => d.path)).toEqual(before.docs.map((d) => d.path));
    expect(after.padding).toHaveLength(12);
    expect(after.manifest.stats?.paddingDocuments).toBe(12);
    // extending again replaces, never duplicates
    const again = await extendPack(dir, { seed: 0, options: {}, log: () => {}, padding: 2 });
    expect(again.errors).toEqual([]);
    expect(loadPack(dir).tasks.length).toBe(after.tasks.length);
  });
});

describe('corpus-level tasks: cost and scale', () => {
  it('counts the build in correctness per token and in break-even', () => {
    const perQuery = { p: {
      'agent-grep': { latencyP50: 0, toolCalls: 0, weightedTokens: 20_000, costUsd: 0, n: 30, capped: 0, leaked: 0, errors: 0 },
      'agent-wiki': { latencyP50: 0, toolCalls: 0, weightedTokens: 15_000, costUsd: 0, n: 30, capped: 0, leaked: 0, errors: 0 },
      'agent-wiki-sources': { latencyP50: 0, toolCalls: 0, weightedTokens: 25_000, costUsd: 0, n: 30, capped: 0, leaked: 0, errors: 0 },
    } };
    const usage = { p: { 'agent-grep': { correctness: { value: 0.6, n: 30 } }, 'agent-wiki': { correctness: { value: 0.6, n: 30 } }, 'agent-wiki-sources': { correctness: { value: 0.75, n: 30 } } } };
    const build = { key: 'b', pack: 'p', system: 'llm-wiki', ok: true, ms: 1, usage: { ...emptyUsage(), weightedTokens: 1_000_000 }, stages: {}, bytes: 0, at: '' };
    const e = efficiencyOf(usage, perQuery, [build]).p;
    expect(e['agent-grep'].per1k).toBeCloseTo(0.03, 6);
    expect(e['agent-wiki'].breakEven).toBeCloseTo(200, 6);
    expect(e['agent-wiki'].amortized['100']).toBeCloseTo(0.6 / 25, 6);
    expect(e['agent-wiki-sources'].buildTokens).toBe(1_000_000);
    expect(e['agent-wiki-sources'].breakEven).toBeNull();
  });

  it('reads runs at two corpus sizes side by side', async () => {
    const packDir = path.join(tmp, 'scale-pack');
    buildFixturePack(packDir);
    const backend = new ScriptedBackend();
    const judge = scriptedJudge();
    const embedder = createEmbeddingProvider({ provider: 'local', baseUrl: '', apiKey: '', model: '', dimensions: 64, batchSize: 64, sendDimensions: false });
    const dirs: string[] = [];
    for (const fraction of [1, 2]) {
      const res = await runEval({ packs: [packDir], systems: ['rag-hybrid', 'long-context', 'closed-book'], runDir: path.join(tmp, 'runs', `scale-${fraction}`), quota: false, fraction, types: ['aggregate', 'timeline', 'contradiction', 'profile', 'single-hop'], overrides: { chat: backend, judge, embedder } });
      dirs.push(res.runDir);
    }
    expect(new RunStore(dirs[1]).meta()!.staged!['fixture-life']).toMatchObject({ documents: 24, padded: 12 });
    expect(new RunStore(dirs[1]).allAnswers().every((a) => ['aggregate', 'timeline', 'contradiction', 'profile', 'single-hop'].includes(loadPack(packDir).tasks.find((t) => t.id === a.taskId)!.type))).toBe(true);
    const data = buildScaleData(dirs);
    expect(data['fixture-life']['rag-hybrid'].map((p) => p.fraction)).toEqual([1, 2]);
    const md = renderScale(data);
    expect(md).toContain('correctness @2×');
    expect(md).toContain('24 documents');
  }, 120_000);
});
