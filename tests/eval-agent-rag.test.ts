import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmbeddingProvider } from '../src/ingest/embeddings.js';
import { buildFixturePack } from '../src/eval/packs/fixture.js';
import { runEval } from '../src/eval/run.js';
import { RunStore } from '../src/eval/runstore.js';
import { startServedTools } from '../src/eval/toolhost.js';
import { ScriptedBackend, scriptedJudge } from './helpers/eval-scripted.js';

/**
 * Arm B, `agent-rag` (docs/design/33 §2): the grep agent plus one tool,
 * `search(query, k)`, over the chunk index `rag-hybrid` builds — the same
 * build, served to the agent's sessions by the run as knode's tools are.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rag-'));
const packDir = path.join(tmp, 'pack');
const embedder = createEmbeddingProvider({ provider: 'local', baseUrl: '', apiKey: '', model: '', dimensions: 384, batchSize: 64, sendDimensions: false });
const toolsLog = path.join(tmp, 'tools.log');
const oldPath = process.env.PATH;

beforeAll(() => {
  buildFixturePack(packDir);
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nexec node "${path.resolve('tests/helpers/fake-codex.mjs')}" "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.FAKE_CODEX_TOOLS_LOG = toolsLog;
});
afterAll(() => {
  process.env.PATH = oldPath;
  delete process.env.FAKE_CODEX_TOOLS_LOG;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const run = (name: string, systems: string[]) => runEval({
  packs: [packDir], systems, runDir: path.join(tmp, 'runs', name), quota: false, suites: ['usage'], judgeAudit: 0,
  overrides: { chat: new ScriptedBackend(), judge: scriptedJudge(), embedder },
});

describe('agent-rag', () => {
  it('shares the rag build and answers with the shell and the search tool', async () => {
    const res = await run('with-rag', ['rag-hybrid', 'agent-rag']);
    const store = new RunStore(res.runDir);
    // one index per pack: a single rag build serves both
    expect(store.allBuilds().filter((b) => !b.system.includes('@')).map((b) => b.system)).toEqual(['rag']);
    const answers = store.allAnswers().filter((a) => a.system === 'agent-rag');
    expect(answers.length).toBeGreaterThan(0);
    expect(answers.filter((a) => a.error).map((a) => `${a.taskId}: ${a.error}`)).toEqual([]);
    const a = answers.find((x) => x.taskId === 'q1')!;
    // its trace: the search call, then the shell over its copy of the sources
    expect(a.commands).toEqual(['mcp:knode.search {"query":"林晓 澜舟科技 岗位","k":3}', 'rg -n 林晓 .', `/bin/zsh -lc "rg -l '林晓' . | head -n 5"`]);
    expect(a.toolCalls).toBe(3);
    // what search returned: each hit's document path, a passage and a score, from the rag index
    const hits = JSON.parse(a.outputs![0]!.text) as { doc: string; passage: string; score: number }[];
    expect(hits).toHaveLength(3);
    for (const h of hits) {
      expect(fs.existsSync(path.join(packDir, 'corpus', h.doc)), h.doc).toBe(true);
      expect(h.passage.length).toBeGreaterThan(0);
      expect(h.passage.length).toBeLessThanOrEqual(1200);
      expect(h.score).toBeGreaterThan(0);
    }
    expect(hits.map((h) => h.score)).toEqual([...hits.map((h) => h.score)].sort((x, y) => y - x));
    expect(hits.map((h) => h.doc)).toContain('email/2026-03-05.md');
    expect(a.outputs![0]!.chars).toBe(a.outputs![0]!.text.length);
    // the documents search named are among those it looked at
    expect(a.retrieved).toEqual(expect.arrayContaining(hits.map((h) => h.doc)));
    // the session's server offered search alone
    expect(new Set(fs.readFileSync(toolsLog, 'utf8').trim().split('\n'))).toEqual(new Set(['search']));
  }, 120_000);

  it('builds the index itself when rag-hybrid is not in the run', async () => {
    const res = await run('alone', ['agent-rag']);
    const store = new RunStore(res.runDir);
    expect(store.allBuilds().filter((b) => !b.system.includes('@')).map((b) => [b.system, b.ok])).toEqual([['rag', true]]);
    expect(store.allBuilds().find((b) => b.system === 'rag')!.usage.embeddingTokens).toBeGreaterThan(0);
    const answers = store.allAnswers().filter((a) => a.system === 'agent-rag');
    expect(answers.length).toBeGreaterThan(0);
    expect(answers.filter((a) => a.error)).toEqual([]);
  }, 120_000);
});

describe('a tool host of the run\'s own', () => {
  it('serves the named tools behind its bearer secret', async () => {
    const host = await startServedTools({ name: 't', version: '1' }, ['echo'], (server) => {
      server.registerTool('echo', { description: 'echo' }, async () => ({ content: [{ type: 'text' as const, text: 'hi' }] }));
    });
    try {
      const refused = await fetch(host.url, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
      expect(refused.status).toBe(401);
      const client = new Client({ name: 'test', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(host.url), { requestInit: { headers: { Authorization: `Bearer ${host.secret}` } } }));
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['echo']);
      expect((await client.callTool({ name: 'echo', arguments: {} })).content).toEqual([{ type: 'text', text: 'hi' }]);
      await client.close();
    } finally {
      await host.close();
    }
  });
});
