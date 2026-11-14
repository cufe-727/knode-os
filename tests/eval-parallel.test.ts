import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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
import { startToolHost } from '../src/eval/toolhost.js';
import { ScriptedBackend, scriptedJudge } from './helpers/eval-scripted.js';

/**
 * docs/design/31 D2: knode's answers run in parallel on one open context.
 * Every open of a workspace is counted: the stall behind `serial` was several
 * PGlite instances opened on one directory by answers that started together.
 * D3: answering, and the agent's tools, leave the index as built.
 * D4: agent-knode's sessions share one tool host per build.
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

  for (const system of ['knode-ask', 'agent-knode']) {
    it(`answers with ${system} at width ${WIDTH}, ${REPS} runs, without a stall or a second open`, async () => {
      const lines: string[] = [];
      let answered = 0;
      let ms = 0;
      let widest = 0;
      // emulated model time (KNODE_EVAL_PARALLEL_DELAY_MS): a knode-ask answer's call, an agent's whole session
      const delay = Number(process.env.KNODE_EVAL_PARALLEL_DELAY_MS ?? 0);
      const sessions = path.join(tmp, `sessions-${system}.log`);
      const calls = path.join(tmp, `calls-${system}.log`);
      process.env.FAKE_CODEX_SESSION_LOG = sessions;
      process.env.FAKE_CODEX_MCP_LOG = calls;
      process.env.FAKE_CODEX_SESSION_MS = String(delay);
      try {
        for (let r = 1; r <= REPS; r++) {
          const runDir = path.join(tmp, 'runs', `wide-${system}-${r}`);
          fs.rmSync(sessions, { force: true });
          fs.rmSync(calls, { force: true });
          const before = opens.n;
          const t0 = Date.now();
          await runEval({
            packs: [packDir], systems: [system], runDir, quota: false, suites: ['usage'], skipScoring: true, answerConcurrency: WIDTH,
            reuseBuildsFrom: base, overrides: { chat: new ScriptedBackend(delay), judge, embedder },
          });
          const took = Date.now() - t0;
          ms += took;
          const answers = new RunStore(runDir).allAnswers().filter((a) => a.system === system);
          expect(answers.filter((a) => a.error).map((a) => `${a.taskId}: ${a.error}`)).toEqual([]);
          expect(answers.length).toBeGreaterThan(8);
          // answers (and for knode-ask the retrieval probes, for agent-knode every session's tools): one open in all
          expect(opens.n - before, `run ${r}`).toBe(1);
          if (system === 'agent-knode') {
            // each session's two tool calls reached the build's host
            expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(answers.length * 2);
            const events = fs.readFileSync(sessions, 'utf8').trim().split('\n').map((l) => l.split(' ')).map(([k, t]) => [Number(t), k === 'start' ? 1 : -1] as const).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
            let open = 0;
            for (const [, d] of events) widest = Math.max(widest, (open += d));
          }
          answered += answers.length;
          lines.push(`run ${r}: ${answers.length} answers in ${took} ms`);
        }
      } finally {
        delete process.env.FAKE_CODEX_SESSION_LOG;
        delete process.env.FAKE_CODEX_MCP_LOG;
        delete process.env.FAKE_CODEX_SESSION_MS;
      }
      // sessions ran side by side, not one at a time
      if (system === 'agent-knode' && WIDTH > 1) expect(widest).toBeGreaterThan(1);
      report(`${system} width ${WIDTH}${delay ? `, ${delay} ms a model turn` : ''} on ${new RunStore(path.join(tmp, 'runs', `wide-${system}-1`)).meta()?.database?.at}: ${answered} answers in ${ms} ms (${((answered / ms) * 60_000).toFixed(0)} a minute, runs included)${system === 'agent-knode' ? `, at most ${widest} sessions at once` : ''}\n${lines.join('\n')}`);
    }, 600_000);
  }
});

/** A context once the store's own upkeep after opening is done, as the harness hands it out. */
async function ready(ctx: AppContext): Promise<AppContext> {
  await Promise.all([ctx.store.indexing, ctx.store.retype]);
  return ctx;
}

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
      let ctx = await ready(await createContext(ws));
      const before = await traces(ctx);
      await ctx.store.close();

      const task = staged.tasks.find((t) => t.id === 'q1')!;
      const first = await sys.answer!(task, taskPrompt(task), env);
      const second = await sys.answer!(task, taskPrompt(task), env);
      expect(first.retrieved!.length).toBeGreaterThan(0);
      expect(second.retrieved).toEqual(first.retrieved);
      expect(second.citations).toEqual(first.citations);
      await sys.release!(env);

      ctx = await ready(await createContext(ws));
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

describe("the build's tool host", () => {
  it('lists exactly what the stdio server gives an agent, answers only its token, and leaves the index as built', async () => {
    const ws = path.join(new RunStore(base).workDir('fixture-life', 'knode'), 'ws');
    // `knode-os mcp` as a session used to start it, narrowed the way Codex's enabled_tools narrowed it
    const stdio = new Client({ name: 'test', version: '0' });
    await stdio.connect(new StdioClientTransport({
      command: process.execPath, args: [path.resolve('node_modules/tsx/dist/cli.mjs'), path.resolve('src/cli.ts'), '--data', ws, 'mcp'],
      env: { ...getDefaultEnvironment(), KNODE_DATABASE_KIND: process.env.KNODE_DATABASE_KIND ?? 'pglite', ...(process.env.KNODE_DATABASE_URL ? { KNODE_DATABASE_URL: process.env.KNODE_DATABASE_URL } : {}) },
      stderr: 'ignore',
    }));
    const expected = {
      tools: (await stdio.listTools()).tools.filter((t) => KNODE_AGENT_TOOLS.includes(t.name)),
      instructions: stdio.getInstructions(),
      server: stdio.getServerVersion(),
    };
    const child = (stdio.transport as StdioClientTransport | undefined)?.pid ?? null;
    await stdio.close();
    // the server process is gone before the workspace is opened here: one process at a time on a PGlite index
    for (let i = 0; child && i < 100; i++) {
      try {
        process.kill(child, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        break;
      }
    }
    expect(expected.tools.map((t) => t.name).sort()).toEqual([...KNODE_AGENT_TOOLS].sort());

    const ctx = await ready(await createContext(ws));
    const host = await startToolHost(async () => ctx, KNODE_AGENT_TOOLS);
    try {
      const connect = async (token: string) => {
        const c = new Client({ name: 'test', version: '0' });
        await c.connect(new StreamableHTTPClientTransport(new URL(host.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
        return c;
      };
      const client = await connect(host.secret);
      expect({ tools: (await client.listTools()).tools, instructions: client.getInstructions(), server: client.getServerVersion() }).toEqual(expected);
      const before = await traces(ctx);
      const search = async () => JSON.stringify((await client.callTool({ name: 'knode_search', arguments: { query: '林晓的岗位' } })).content);
      const first = await search();
      expect(first).toContain('raw/docs/');
      // overlapping calls on the one context, and the same ranking every time
      expect(await Promise.all(Array.from({ length: 8 }, search))).toEqual(Array.from({ length: 8 }, () => first));
      expect(await traces(ctx)).toEqual(before);
      // a tool outside the agent's set is not there to call
      const outside = await client.callTool({ name: 'knode_ask', arguments: { question: 'x' } }).catch((e: unknown) => ({ isError: true, content: [{ text: String(e) }] }));
      expect(outside.isError).toBe(true);
      await client.close();
      await expect(connect('not-the-token')).rejects.toThrow();
    } finally {
      await host.close();
      await ctx.store.close();
    }
  }, 120_000);
});
