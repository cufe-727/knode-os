import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AppContext, createContext } from '../src/context.js';
import { createEmbeddingProvider } from '../src/ingest/embeddings.js';
import { registerKnodeTools } from '../src/mcp/tools.js';
import { Meter } from '../src/eval/meter.js';
import { loadPack, stageCorpus } from '../src/eval/pack.js';
import { buildFixturePack } from '../src/eval/packs/fixture.js';
import { taskPrompt } from '../src/eval/prompts.js';
import { QuotaGuard } from '../src/eval/quota.js';
import { runEval } from '../src/eval/run.js';
import { RunStore } from '../src/eval/runstore.js';
import { startShim } from '../src/eval/shim.js';
import { KNODE_AGENT_TOOLS, knodeAsk } from '../src/eval/systems/knode.js';
import type { SystemEnv } from '../src/eval/systems/types.js';
import { ScriptedBackend, scriptedJudge } from './helpers/eval-scripted.js';

/**
 * docs/design/31 D2: knode's answers run in parallel on one open context.
 * Every open of a workspace is counted: the stall behind `serial` was several
 * PGlite instances opened on one directory by answers that started together.
 * D3: answering, and the agent's tools, leave the index as built.
 */

const opens = vi.hoisted(() => ({ n: 0 }));
vi.mock('../src/context.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/context.js')>();
  return { ...m, createContext: (...args: Parameters<typeof m.createContext>) => (opens.n++, m.createContext(...args)) };
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-eval-parallel-'));
const packDir = path.join(tmp, 'packs', 'fixture-life');
const base = path.join(tmp, 'runs', 'base');
const embedder = createEmbeddingProvider({ provider: 'local', baseUrl: '', apiKey: '', model: '', dimensions: 384, batchSize: 64, sendDimensions: false });
const judge = scriptedJudge();
/** Repetitions of the width-8 runs (docs/design/31 D5 step 3 asks for 20). */
const WIDTH = Number(process.env.KNODE_EVAL_PARALLEL_WIDTH ?? 8);
const REPS = Number(process.env.KNODE_EVAL_PARALLEL_REPS ?? 6);
/** Timings go to this file when it is set (the reporter keeps a passing test's output to itself). */
const report = (text: string) => {
  if (process.env.KNODE_EVAL_PARALLEL_LOG) fs.appendFileSync(process.env.KNODE_EVAL_PARALLEL_LOG, `${text}\n`);
};

// an agent system must never start the real CLI from a test
const fakeBin = path.join(tmp, 'fake-bin');
const realPath = process.env.PATH;
beforeAll(async () => {
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'codex'), `#!/bin/sh\nexec node "${path.resolve('tests/helpers/fake-codex.mjs')}" "$@"\n`);
  fs.chmodSync(path.join(fakeBin, 'codex'), 0o755);
  process.env.PATH = `${fakeBin}:${realPath}`;
  buildFixturePack(packDir);
  // one build, reused by every run below
  await runEval({ packs: [packDir], systems: ['knode-ask'], runDir: base, quota: false, suites: ['usage'], skipScoring: true, overrides: { chat: new ScriptedBackend(), judge, embedder } });
}, 180_000);
afterAll(() => {
  process.env.PATH = realPath;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('knode answers in parallel', () => {
  it('opens the workspace once for answers that start together with no context open', async () => {
    const pack = loadPack(packDir);
    const staged = stageCorpus(pack);
    const meter = new Meter();
    const shim = await startShim({ backend: new ScriptedBackend(), embedder, meter });
    const env: SystemEnv = {
      runId: 'single-flight', pack, staged, workDir: new RunStore(base).workDir(pack.manifest.id, 'knode'), shim, meter,
      quota: new QuotaGuard({ enabled: false }), models: { model: '', buildEffort: 'low', answerEffort: 'medium' }, log: () => {},
    };
    const sys = knodeAsk();
    try {
      await sys.reopen!(env);
      const tasks = staged.tasks.filter((t) => !t.afterUpdate).slice(0, 8);
      const before = opens.n;
      const answers = await Promise.all(tasks.map((t) => sys.answer!(t, taskPrompt(t), env)));
      expect(opens.n - before).toBe(1);
      expect(answers.every((a) => a.text.length > 0)).toBe(true);
      // released, the next caller opens a fresh context, once however many ask together
      await sys.release!(env);
      const again = await Promise.all([sys.retrieve!('林晓', 5, env), sys.retrieve!('澜舟科技', 5, env)]);
      expect(again[0].length).toBeGreaterThan(0);
      expect(opens.n - before).toBe(2);
    } finally {
      await sys.release!(env);
      await shim.close();
      staged.cleanup();
    }
  }, 120_000);

  it(`answers with knode-ask at width ${WIDTH}, ${REPS} runs, without a stall or a second open`, async () => {
    const lines: string[] = [];
    let answered = 0;
    let ms = 0;
    for (let r = 1; r <= REPS; r++) {
      const runDir = path.join(tmp, 'runs', `wide-${r}`);
      const before = opens.n;
      const t0 = Date.now();
      await runEval({
        packs: [packDir], systems: ['knode-ask'], runDir, quota: false, suites: ['usage'], skipScoring: true, answerConcurrency: WIDTH,
        reuseBuildsFrom: base, overrides: { chat: new ScriptedBackend(), judge, embedder },
      });
      ms += Date.now() - t0;
      const answers = new RunStore(runDir).allAnswers().filter((a) => a.system === 'knode-ask');
      expect(answers.filter((a) => a.error).map((a) => `${a.taskId}: ${a.error}`)).toEqual([]);
      expect(answers.length).toBeGreaterThan(8);
      // answers, then the retrieval probes: one open in all
      expect(opens.n - before, `run ${r}`).toBe(1);
      answered += answers.length;
      lines.push(`run ${r}: ${answers.length} answers in ${Date.now() - t0} ms`);
    }
    report(`knode-ask width ${WIDTH}: ${answered} answers in ${ms} ms (${((answered / ms) * 60_000).toFixed(0)} a minute, runs included)\n${lines.join('\n')}`);
  }, 600_000);
});

/** What reading may write: the hit counts behind heat, resolve receipts and context-pack events. */
async function traces(ctx: AppContext): Promise<Record<string, unknown>> {
  const [row] = await ctx.store.query<Record<string, unknown>>(
    `SELECT (SELECT count(*)::int FROM chunk_stats) AS chunks, (SELECT coalesce(sum(hit_count), 0)::int FROM chunk_stats) AS chunk_hits,
            (SELECT count(*)::int FROM doc_stats) AS docs, (SELECT coalesce(sum(hit_count), 0)::int FROM doc_stats) AS doc_hits,
            (SELECT coalesce(sum(heat), 0)::float FROM doc_stats) AS heat,
            (SELECT count(*)::int FROM receipts) AS receipts, (SELECT count(*)::int FROM pack_events) AS pack_events`,
  );
  return row;
}

describe('answering leaves the index as built', () => {
  it('records no hits for knode-ask answers or the agent tools, and ranks the same question the same way twice', async () => {
    const pack = loadPack(packDir);
    const staged = stageCorpus(pack);
    const meter = new Meter();
    const shim = await startShim({ backend: new ScriptedBackend(), embedder, meter });
    const env: SystemEnv = {
      runId: 'no-tracking', pack, staged, workDir: new RunStore(base).workDir(pack.manifest.id, 'knode'), shim, meter,
      quota: new QuotaGuard({ enabled: false }), models: { model: '', buildEffort: 'low', answerEffort: 'medium' }, log: () => {},
    };
    const ws = path.join(env.workDir, 'ws');
    const sys = knodeAsk();
    try {
      await sys.reopen!(env);
      // one context at a time on the workspace: the system's, then this test's
      let ctx = await createContext(ws);
      const before = await traces(ctx);
      await ctx.store.close();

      const task = staged.tasks.find((t) => t.id === 'q1')!;
      const first = await sys.answer!(task, taskPrompt(task), env);
      const second = await sys.answer!(task, taskPrompt(task), env);
      expect(first.retrieved!.length).toBeGreaterThan(0);
      expect(second.retrieved).toEqual(first.retrieved);
      expect(second.citations).toEqual(first.citations);
      await sys.release!(env);

      ctx = await createContext(ws);
      try {
        expect(await traces(ctx)).toEqual(before);
        // the agent's tools as the evaluation hosts them
        const call = async (opts: { track?: boolean }, name: string, args: Record<string, unknown>) => {
          const server = new McpServer({ name: 'knode-os', version: '0' });
          registerKnodeTools(server, ctx, { caller: 'agent', only: new Set(KNODE_AGENT_TOOLS), ...opts });
          const [a, b] = InMemoryTransport.createLinkedPair();
          const client = new Client({ name: 'test', version: '0' });
          await Promise.all([server.connect(a), client.connect(b)]);
          const r = await client.callTool({ name, arguments: args });
          await client.close();
          // the instant a call answers at is the clock's, not the index's
          return (r.content as { text: string }[])[0].text.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '<now>');
        };
        const reads: [string, Record<string, unknown>][] = [
          ['knode_search', { query: '林晓的岗位' }],
          ['knode_graph_search', { query: '林晓' }],
          ['knode_resolve', { query: '林晓在哪家公司工作？' }],
        ];
        const once = [];
        for (const [name, args] of reads) once.push(await call({ track: false }, name, args));
        for (const [i, [name, args]] of reads.entries()) expect(await call({ track: false }, name, args), name).toBe(once[i]);
        expect(await traces(ctx)).toEqual(before);
        // the default still counts: the same calls with tracking on leave hits and a receipt
        for (const [name, args] of reads) await call({}, name, args);
        const after = await traces(ctx);
        expect(after.chunk_hits as number).toBeGreaterThan(before.chunk_hits as number);
        expect(after.receipts as number).toBeGreaterThan(before.receipts as number);
      } finally {
        await ctx.store.close();
      }
    } finally {
      await sys.release!(env);
      await shim.close();
      staged.cleanup();
    }
  }, 120_000);
});
