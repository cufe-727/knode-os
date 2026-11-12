import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { sync } from '../src/ingest/sync.js';
import { classifyFailure } from '../src/research/failure.js';
import { getJob, queueJob } from '../src/research/jobs.js';
import { JobCancelledError, killAgentsFor, SessionInput, SessionResult } from '../src/research/launch.js';
import { classifySessionAnswer, RemoteSessions, remotePrompt } from '../src/research/remote.js';
import { runResearchJob } from '../src/research/runner.js';
import { RemoteTokenStore } from '../src/remote/tokens.js';
import { createApp } from '../src/server/app.js';
import { MCP_TOKEN_FILE } from '../src/server/mcp-http.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';
import { WorkBroker } from '../src/work/broker.js';
import { SessionSource, SessionSpec } from '../src/work/session.js';

/**
 * Research sessions on remote workers (docs/design/27): the session source and
 * where a session is placed; the session's own MCP route (its token, its tool
 * set, writes bound to its job); and a research job end to end whose session
 * a spawned worker runs with the fake claude CLI, reaching knode through that
 * route while the job stays here.
 */

const helpers = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers');
const fakeClaude = path.join(helpers, 'fake-claude.sh');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-sessions-'));
const root = path.join(tmp, 'data');
const wsDir = path.join(root, 'users', 'admin', 'workspaces', 'default');
const scope = { user: 'admin', kind: 'personal' as const, id: 'default', name: 'Default', slug: 'default', relativeDir: 'users/admin/workspaces/default' };
const headers = { 'x-knode-user': 'admin', 'x-knode-workspace-kind': 'personal', 'x-knode-workspace-id': 'default', 'x-knode-workspace-name': 'Default' };
const agent = { kind: 'cli' as const, provider: 'claude-cli' as const, cliPath: fakeClaude, model: '' };

let rootCtx: AppContext;
let registry: WorkspaceContextRegistry;
let ctx: AppContext;
let httpServer: Server;
let base = '';
let mcp: { url: string; token: string; headers: Record<string, string> };
const sources = new Map<string, SessionSource>();
const brokers = new Map<string, WorkBroker>();
let researchToken = '';
let labelToken = '';

const source = () => sources.get(ctx.dataDir)!;
const ws = '/remote/v1/w/admin/default';
const post = async (p: string, token: string, body: unknown) => {
  const res = await fetch(`${base}${p}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) as Record<string, any> };
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(50);
  }
}

function spec(over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    job: 'r_test', label: 'agent', title: 'test', family: 'claude', model: '', effort: null, speed: null,
    maxTurns: 10, timeoutMs: 60_000, tools: 'write', web: false, webFreshness: null, schema: '# schema', prompt: 'do it', ...over,
  };
}

function write(rel: string, content: string): void {
  const abs = path.join(wsDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeAll(async () => {
  rootCtx = await createContext(root);
  registry = new WorkspaceContextRegistry(root, {
    templateConfig: rootCtx.config,
    // what `serve` wires per workspace for sessions: a source behind the broker
    onCreate: (wctx) => {
      const sessions = new SessionSource({ classify: classifySessionAnswer, retryMs: 0 });
      const broker = new WorkBroker([sessions]);
      sources.set(wctx.dataDir, sessions);
      brokers.set(wctx.dataDir, broker);
      return async () => {
        await broker.stop();
      };
    },
  });
  const app = createApp(rootCtx, () => {}, registry, {
    services: (wctx) => ({ mcp: () => null, kickResearch: () => {}, track: (job) => job, work: brokers.get(wctx.dataDir) ?? null }),
  });
  await app.request('/api/workspaces', { headers: { 'x-knode-user': 'admin' } });
  ctx = await registry.get(scope);
  ctx.config.research.pipeline = 'single';
  const token = fs.readFileSync(path.join(root, MCP_TOKEN_FILE), 'utf8').trim();
  await new Promise<void>((resolve) => {
    httpServer = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      base = `http://127.0.0.1:${info.port}`;
      mcp = { url: `${base}/mcp`, token, headers };
      resolve();
    }) as Server;
  });
  const tokens = new RemoteTokenStore(root);
  researchToken = tokens.create({ name: 'laptop', scopes: ['research'], workspaces: ['admin/default'] }).token;
  labelToken = tokens.create({ name: 'labeler', scopes: ['label'], workspaces: ['admin/default'] }).token;
  write('raw/docs/trusted.md', `---
title: 宁德时代 2025 年报摘要
date: 2026-03-30
entities:
  - { name: 宁德时代, type: organization, aliases: ["CATL", "300750"] }
claims:
  - { subject: 宁德时代, type: revenue, statement: 2025 年营业收入 4000 亿元, eventDate: "2025" }
---
宁德时代 2025 年营业收入 4000 亿元，同比增长 20%。
`);
  await sync(ctx, { llmGraph: false });
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await registry.closeAll();
  await rootCtx.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the session source', () => {
  it('leases a session to a slot of its CLI only, streams its output into the transcript, and settles with the answer', async () => {
    const s = new SessionSource({ classify: classifySessionAnswer, retryMs: 0 });
    const dir = fs.mkdtempSync(path.join(tmp, 'run-'));
    const files = { transcriptPath: path.join(dir, 'transcript.jsonl'), stderrPath: path.join(dir, 'stderr.log') };
    const offer = s.offer(spec(), { writePaths: ['wiki/x.md'], workset: 'w1' }, files);
    expect(await s.lease({ worker: 'w/codex', backend: 'codex', remote: true }, 1)).toEqual([]);
    expect(s.online('claude')).toBe(false);
    const [task] = await s.lease({ worker: 'w/claude', backend: 'claude', remote: true }, 1);
    expect(task).toMatchObject({ kind: 'session', job: 'r_test', tools: 'write', agent: { family: 'claude' } });
    expect(s.online('claude')).toBe(true);
    expect(offer.leased).toBe(true);
    const token = (task as { mcpToken: string }).mcpToken;
    expect(token).toMatch(/^kms_/);
    expect(s.authorize(task.id, 'kms_wrong')).toBeNull();
    expect(s.authorize(task.id, token)).toMatchObject({ job: 'r_test', tools: 'write', writePaths: ['wiki/x.md'], workset: 'w1' });
    expect(s.output(task.id, { worker: 'w/claude', backend: 'claude', remote: true }, '{"type":"system"}\n')).toBe(true);
    const result = JSON.stringify({ type: 'result', is_error: false, result: 'done', num_turns: 4, total_cost_usd: 0.5 });
    const done = await s.complete(task.id, { worker: 'w/claude', backend: 'claude', remote: true }, { ok: true, text: '', session: { exitCode: 0, output: `${result}\n`, stderr: '', lastMessage: null } });
    expect(done).toEqual({ accepted: true });
    expect(await offer.result).toMatchObject({ kind: 'answered', worker: 'w/claude' });
    expect(fs.readFileSync(files.transcriptPath, 'utf8')).toBe(`{"type":"system"}\n${result}\n`);
    // the token died with the lease
    expect(s.authorize(task.id, token)).toBeNull();
  });

  it('puts a session a worker could not serve back in line, the strike counted and the worker told to rest', async () => {
    const s = new SessionSource({ classify: classifySessionAnswer, retryMs: 0 });
    const dir = fs.mkdtempSync(path.join(tmp, 'run-'));
    const offer = s.offer(spec(), { writePaths: [], workset: 'w1' }, { transcriptPath: path.join(dir, 't.jsonl'), stderrPath: path.join(dir, 'e.log') });
    const who = { worker: 'w/claude', backend: 'claude', remote: true };
    // the CLI ran and said the account's limit is spent: the worker's failure, not the job's
    const [a] = await s.lease(who, 1);
    const limit = JSON.stringify({ type: 'result', is_error: true, result: "You've hit your 5-hour limit · resets 1:30am" });
    expect(await s.complete(a.id, who, { ok: true, text: '', session: { exitCode: 1, output: `${limit}\n`, stderr: '', lastMessage: null } })).toMatchObject({ accepted: true, failure: 'fatal' });
    expect(offer.strikes).toBe(1);
    expect(offer.leased).toBe(false);
    // a worker that could not start the CLI at all
    const [b] = await s.lease(who, 1);
    expect(await s.complete(b.id, who, { ok: false, error: 'claude CLI not found', kind: 'fatal' })).toMatchObject({ accepted: true, failure: 'fatal' });
    expect(offer.strikes).toBe(2);
    // an agent that ran and failed at the work is a result: the runner judges it
    const [c] = await s.lease(who, 1);
    const turns = JSON.stringify({ type: 'result', is_error: true, subtype: 'error_max_turns', result: 'max turns reached' });
    expect(await s.complete(c.id, who, { ok: true, text: '', session: { exitCode: 1, output: `${turns}\n`, stderr: '', lastMessage: null } })).toEqual({ accepted: true });
    expect(await offer.result).toMatchObject({ kind: 'answered' });
  });

  it('refuses a renewal once the session is cancelled, and lets a lapsed lease go back in line', async () => {
    const s = new SessionSource({ leaseMs: 1_000, retryMs: 0 });
    const dir = fs.mkdtempSync(path.join(tmp, 'run-'));
    const files = { transcriptPath: path.join(dir, 't.jsonl'), stderrPath: path.join(dir, 'e.log') };
    const who = { worker: 'w/codex', backend: 'codex', remote: true };
    const lapsing = s.offer(spec({ family: 'codex' }), { writePaths: [], workset: 'w' }, files);
    const [a] = await s.lease(who, 1);
    await sleep(1_100);
    expect(lapsing.leased).toBe(false);
    expect(lapsing.strikes).toBe(1);
    expect(s.renew([a.id], who)).toEqual({ renewed: [], lost: [a.id] });
    lapsing.cancel();
    const cancelled = s.offer(spec({ family: 'codex' }), { writePaths: [], workset: 'w' }, files);
    const [b] = await s.lease(who, 1);
    expect(s.renew([b.id], who)).toEqual({ renewed: [b.id], lost: [] });
    cancelled.cancel();
    expect(s.renew([b.id], who)).toEqual({ renewed: [], lost: [b.id] });
    expect(await cancelled.result).toEqual({ kind: 'cancelled' });
  });
});

describe('where a session runs', () => {
  const input = (over: Partial<SessionInput> = {}): SessionInput => {
    const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# the schema');
    return {
      agent, maxTurns: 5, timeoutMs: 60_000, cwd, prompt: '- 只读资料目录：/data/raw/docs\n开始吧', mcp, readDirs: [], jobId: `r_${Math.random().toString(16).slice(2, 10)}`,
      outputPath: 'wiki/entities/x.md', worksetId: 'w1', tools: 'write', label: 'agent', ...over,
    };
  };
  const here = (): Promise<SessionResult> => Promise.resolve({ text: 'here', turns: 1, costUsd: null, error: null, exitCode: 0, transcriptPath: '' });
  const remote = (over: Record<string, unknown> = {}) => {
    const config = structuredClone(ctx.config);
    config.server.remote = { ...config.server.remote!, offer: { ...config.server.remote!.offer, session: true }, sessionOfferSeconds: 30, sessionWaitMinutes: 0.03, ...over };
    return config;
  };

  it('runs here when sessions are not offered, when the agent cannot leave, or when no worker is online', async () => {
    const s = new SessionSource({ retryMs: 0 });
    const off = new RemoteSessions({ source: s, config: () => ctx.config });
    expect((await off.run(input(), here)).text).toBe('here');
    const on = new RemoteSessions({ source: s, config: () => remote() });
    expect((await on.run(input(), here)).text).toBe('here');
    expect((await on.run(input({ agents: [{ id: 'r', title: 'r', description: '', prompt: '', write: false, files: false, web: false, model: '', effort: 'default', speed: 'default' }] }), here)).text).toBe('here');
    expect(on.covers(agent)).toBe(false);
  });

  it('waits for a worker when this machine may not run it, and ends as a pause the runner understands', async () => {
    const s = new SessionSource({ retryMs: 0 });
    // no local sessions: nowhere to run once the wait is over → a transient pause
    const none = new RemoteSessions({ source: s, config: () => { const c = remote(); c.research.localSessions = 0; return c; } });
    const r1 = await none.run(input(), here);
    expect(r1.text).toBe('');
    expect(classifyFailure(r1.error!).kind).toBe('transient');
    // under the floor: a quota pause, so the job and its account's queue wait for the reset
    const floor = new RemoteSessions({ source: s, config: () => remote(), hold: async () => ({ reason: 'five-hour window 4% left', until: null }) });
    const r2 = await floor.run(input(), here);
    expect(classifyFailure(r2.error!).kind).toBe('quota');
    // a session that may not leave checks the floor itself, as the claim would have
    const r3 = await floor.run(input({ extraMcp: [{ id: 'src', tools: [], url: 'http://x' } as never] }), here);
    expect(classifyFailure(r3.error!).kind).toBe('quota');
  }, 20_000);

  it('goes to an online worker, and runs here after three worker failures in a row', async () => {
    const s = new SessionSource({ classify: classifySessionAnswer, retryMs: 0 });
    const who = { worker: 'w/claude', backend: 'claude', remote: true };
    await s.lease(who, 1); // the worker asks, so it is online
    const d = new RemoteSessions({ source: s, config: () => remote() });
    expect(d.covers(agent)).toBe(true);
    const running = d.run(input(), here);
    for (let i = 0; i < 3; i++) {
      let task;
      for (let tries = 0; !task && tries < 100; tries++) {
        [task] = await s.lease(who, 1);
        if (!task) await sleep(20);
      }
      expect(task!.kind).toBe('session');
      await s.complete(task!.id, who, { ok: false, error: 'rate limit', kind: 'transient' });
    }
    expect((await running).text).toBe('here');
  }, 20_000);

  it('stops waiting when the job is cancelled', async () => {
    const s = new SessionSource({ retryMs: 0 });
    await s.lease({ worker: 'w/claude', backend: 'claude', remote: true }, 1);
    const d = new RemoteSessions({ source: s, config: () => remote({ sessionWaitMinutes: 5 }) });
    const job = input();
    const running = d.run(job, here);
    await sleep(100);
    killAgentsFor(job.jobId);
    await expect(running).rejects.toBeInstanceOf(JobCancelledError);
  });

  it('tells a remote session it has no data folders to read', () => {
    expect(remotePrompt('- 只读资料目录：/a, /b\nrest')).toContain('只读资料目录：无');
    expect(remotePrompt('collect this')).toContain('knode_read');
  });
});

describe('a session\'s MCP route', () => {
  async function leased(tools: 'read' | 'write') {
    const dir = fs.mkdtempSync(path.join(tmp, 'run-'));
    const offer = source().offer(spec({ tools }), { writePaths: tools === 'write' ? ['wiki/research/mine.md'] : [], workset: 'w-own' }, { transcriptPath: path.join(dir, 't.jsonl'), stderrPath: path.join(dir, 'e.log') });
    const { data } = await post(`${ws}/work/lease`, researchToken, { worker: 'box', backend: 'claude', kinds: ['session'] });
    return { offer, task: data.tasks[0] as { id: string; mcpToken: string } };
  }
  async function client(id: string, token: string) {
    const c = new Client({ name: 'test', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}${ws}/sessions/${id}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return c;
  }

  it('is leased only to a token with the research scope, and only where sessions are offered', async () => {
    source().offer(spec(), { writePaths: [], workset: 'w' }, { transcriptPath: path.join(tmp, 'x.jsonl'), stderrPath: path.join(tmp, 'x.log') }).cancel();
    expect((await post(`${ws}/work/lease`, labelToken, { worker: 'box', backend: 'claude', kinds: ['session'] })).data.tasks).toEqual([]);
    const remote = ctx.config.server.remote!;
    ctx.config.server.remote = { ...remote, offer: { ...remote.offer, session: false } };
    const config = await fetch(`${base}${ws}/work/config`, { headers: { authorization: `Bearer ${researchToken}` } }).then((r) => r.json());
    expect(config.kinds.session).toBe(false);
    ctx.config.server.remote = { ...remote, offer: { ...remote.offer, session: true } };
    const on = await fetch(`${base}${ws}/work/config`, { headers: { authorization: `Bearer ${researchToken}` } }).then((r) => r.json());
    expect(on.kinds.session).toBe(true);
    expect(on.leaseSeconds.session).toBe(120);
  });

  it('answers the session\'s own token only, with its tool set, and writes only its job\'s page', async () => {
    const remote = ctx.config.server.remote!;
    ctx.config.server.remote = { ...remote, offer: { ...remote.offer, session: true } };
    const { offer, task } = await leased('write');
    expect(task.mcpToken).toMatch(/^kms_/);
    const refused = await fetch(`${base}${ws}/sessions/${task.id}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${researchToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(refused.status).toBe(401);
    const c = await client(task.id, task.mcpToken);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain('knode_write');
    expect(names).toContain('knode_read');
    expect(names).not.toContain('knode_sync');
    expect(names).not.toContain('knode_research');
    const elsewhere = await c.callTool({ name: 'knode_write', arguments: { path: 'wiki/other.md', content: '# other' } });
    expect(elsewhere.isError).toBe(true);
    expect(fs.existsSync(path.join(wsDir, 'wiki', 'other.md'))).toBe(false);
    const commit = await c.callTool({ name: 'knode_commit', arguments: { workset: 'someone-else', content: 'x' } });
    expect(commit.isError).toBe(true);
    const own = await c.callTool({ name: 'knode_write', arguments: { path: 'wiki/research/mine.md', content: '# mine\n' } });
    expect(own.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(wsDir, 'wiki', 'research', 'mine.md'), 'utf8')).toBe('# mine\n');
    await c.close();
    // cancelled: the token is refused at once
    offer.cancel();
    const after = await fetch(`${base}${ws}/sessions/${task.id}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${task.mcpToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(after.status).toBe(401);
    const audit = fs.readFileSync(path.join(root, '.knode', 'remote-audit.jsonl'), 'utf8');
    expect(audit).toContain('"tool":"knode_write"');
    expect(audit).toContain('"path":"wiki/research/mine.md"');
    expect(audit).not.toContain('# mine');
  });

  it('gives a reading session no write tool', async () => {
    const { offer, task } = await leased('read');
    const c = await client(task.id, task.mcpToken);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain('knode_capture');
    expect(names).not.toContain('knode_write');
    expect(names).not.toContain('knode_commit');
    await c.close();
    offer.cancel();
  });
});

describe('a research job whose session a remote worker runs', () => {
  let worker: ChildProcess | null = null;
  let output = '';

  afterAll(async () => {
    if (worker && worker.exitCode === null) {
      worker.kill('SIGTERM');
      await new Promise((resolve) => worker!.once('close', resolve));
    }
  });

  it('runs on the worker, reaches knode through its route, and the page is validated and kept here', async () => {
    const remote = ctx.config.server.remote!;
    ctx.config.server.remote = { ...remote, offer: { ...remote.offer, session: true }, sessionOfferSeconds: 20 };
    worker = spawn(process.execPath, [
      path.resolve('worker/knode-worker.mjs'), '--server', base, '--workspace', 'admin/default', '--name', 'laptop-box',
      '--sessions', 'claude:1', '--claude-bin', fakeClaude, '--idle-ms', '150', '--session-renew-ms', '300',
    ], { env: { ...process.env, KNODE_TOKEN: researchToken, FAKE_AGENT_MODE: 'good' }, stdio: ['ignore', 'pipe', 'pipe'] });
    worker.stdout!.on('data', (d) => (output += d));
    worker.stderr!.on('data', (d) => (output += d));
    await until(() => source().online('claude'));
    const sessions = new RemoteSessions({ source: source(), config: () => ctx.config });
    const { job } = await queueJob(ctx.store, { kind: 'entity', target: '宁德时代', requestedBy: 'test' });
    const done = await runResearchJob(ctx, job, { mcp, agent, sessions, log: () => {} });
    expect(done.status, `${done.error}\n${output}`).toBe('done');
    expect(done.payload.worker).toBe('laptop/laptop-box/session-claude#1');
    expect(done.turns).toBeGreaterThanOrEqual(3);
    const page = fs.readFileSync(path.join(wsDir, 'wiki', 'entities', '宁德时代.md'), 'utf8');
    expect(page).toContain('actor: agent/claude-cli');
    // the worker's output streamed into this machine's run folder, ending with the CLI's result
    const transcript = fs.readFileSync(path.join(wsDir, '.runs', job.id, 'transcript.jsonl'), 'utf8');
    expect(transcript).toContain('"subtype":"init"');
    expect(transcript).toContain('"result":"wrote wiki/entities/宁德时代.md"');
    expect(output).toContain('this worker takes session');
    // the worker logs once the server took its answer back, which may be just after the job ended here
    await until(() => /done in \d+s \(exit 0\)/.test(output), 10_000);
    const audit = fs.readFileSync(path.join(root, '.knode', 'remote-audit.jsonl'), 'utf8');
    expect(audit).toContain(`"job":"${job.id}"`);
    expect((await getJob(ctx.store, job.id))!.status).toBe('done');
  }, 120_000);

  it('refuses a session whose fields are not what it builds a command from', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'run-'));
    const offer = source().offer(spec({ model: '--dangerously-skip-permissions' }), { writePaths: [], workset: 'w' }, { transcriptPath: path.join(dir, 't.jsonl'), stderrPath: path.join(dir, 'e.log') });
    await until(() => offer.strikes >= 1);
    expect(offer.lastError).toContain('refused the session');
    offer.cancel();
  }, 30_000);
});

// keep the type import used for readers of this file: the port a worker reaches
export type { AddressInfo };
