import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { sync } from '../src/ingest/sync.js';
import { parseActivity } from '../src/chat/runner.js';
import { getJob, queueJob } from '../src/research/jobs.js';
import { activeSessions, killAgentsFor } from '../src/research/launch.js';
import { cancelJob } from '../src/research/jobs.js';
import { runResearchJob } from '../src/research/runner.js';
import { createApp } from '../src/server/app.js';
import { MCP_TOKEN_FILE } from '../src/server/mcp-http.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';
import { startFakeOpenAi, type FakeOpenAi } from './helpers/fake-openai.js';

/**
 * The built-in research agent end to end, with no coding-agent CLI anywhere:
 * a fake OpenAI-compatible endpoint plays the model, while the real deepagents
 * loop reaches the real MCP endpoint and writes the page through knode_write.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-builtin-'));
const root = path.join(tmp, 'data');
const wsDir = path.join(root, 'users', 'admin', 'workspaces', 'default');
const scope = { user: 'admin', kind: 'personal' as const, id: 'default', name: 'Default', slug: 'default', relativeDir: 'users/admin/workspaces/default' };
const headers = { 'x-knode-user': 'admin', 'x-knode-workspace-kind': 'personal', 'x-knode-workspace-id': 'default', 'x-knode-workspace-name': 'Default' };

let rootCtx: AppContext;
let registry: WorkspaceContextRegistry;
let ctx: AppContext;
let httpServer: Server;
let mcp: { url: string; token: string; headers: Record<string, string> };
let llm: FakeOpenAi;
let app: ReturnType<typeof createApp>;
/** The first job's id, so the transcript assertion reads that run and not a later one. */
let firstJobId = '';

const agentFor = (url: string) => ({ kind: 'builtin' as const, provider: 'deep-agents' as const, baseUrl: url, apiKey: 'sk-test', model: 'fake-model' });

function write(rel: string, content: string): void {
  const abs = path.join(wsDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeAll(async () => {
  rootCtx = await createContext(root);
  registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
  app = createApp(rootCtx, () => {}, registry);
  await app.request('/api/workspaces', { headers: { 'x-knode-user': 'admin' } });
  ctx = await registry.get(scope);
  ctx.config.research.pipeline = 'single';
  const token = fs.readFileSync(path.join(root, MCP_TOKEN_FILE), 'utf8').trim();
  await new Promise<void>((resolve) => {
    httpServer = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      mcp = { url: `http://127.0.0.1:${info.port}/mcp`, token, headers };
      resolve();
    }) as Server;
  });
  llm = await startFakeOpenAi();
  write('raw/docs/trusted.md', `---
title: 宁德时代 2025 年报摘要
date: 2026-03-30
entities:
  - { name: 宁德时代, type: organization, aliases: ["CATL"] }
claims:
  - { subject: 宁德时代, type: revenue, statement: 2025 年营业收入 4000 亿元, eventDate: "2025" }
---
宁德时代 2025 年营业收入 4000 亿元，同比增长 20%。
`);
  await sync(ctx, { llmGraph: false });
}, 60_000);

afterAll(async () => {
  await llm?.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await registry.closeAll();
  await rootCtx.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('built-in research agent', () => {
  it('runs a job end to end with no CLI: MCP tools, knode_write, validation', async () => {
    const { job } = await queueJob(ctx.store, { kind: 'entity', target: '宁德时代', requestedBy: 'test' });
    firstJobId = job.id;
    const done = await runResearchJob(ctx, job, { mcp, agent: agentFor(llm.url), log: () => {} });

    expect(done.error).toBeNull();
    expect(done.status).toBe('done');
    expect(done.outputPath).toBe('wiki/entities/宁德时代.md');
    // turns are counted model calls, not LangGraph super-steps
    expect(done.turns).toBe(3);
    // token counts are not dollars, so the job carries no invented price
    expect(done.costUsd).toBeNull();

    const page = fs.readFileSync(path.join(wsDir, 'wiki', 'entities', '宁德时代.md'), 'utf8');
    expect(page).toContain('actor: agent/deep-agents');
    expect(page).toContain(`job: ${job.id}`);
    expect(page).toContain('## 时间线');

    // the page went through knode_write, so it is a quarantined source like any agent page
    const [scopeRow] = await ctx.store.query<{ trust: string }>(`SELECT trust FROM scopes WHERE key = 'wiki/entities/宁德时代.md' AND status = 'active'`);
    expect(scopeRow).toMatchObject({ trust: 'quarantined' });
  }, 120_000);

  it('writes a claude-shaped transcript, so the Chat activity view needs no special case', () => {
    const transcript = path.join(wsDir, '.runs', firstJobId, 'transcript.jsonl');
    const events = parseActivity(transcript, 'deep-agents');
    expect(events.map((e) => e.tool)).toEqual(['knode_search', 'knode_write']);
    expect(events.every((e) => e.ok)).toBe(true);
  });

  it('enforces the read-only tool scope instead of merely asking for it', () => {
    const offered = (llm.calls[0]?.tools ?? []).map((t) => t.function?.name);
    expect(offered).toContain('mcp__knode-os__knode_write');
    expect(offered).toContain('mcp__knode-os__knode_search');
    // deepagents' own virtual filesystem must not offer a second way to "finish"
    expect(offered).not.toContain('write_file');
    expect(offered).not.toContain('edit_file');
    expect(offered).not.toContain('delete');
  });

  it('leaves LangSmith tracing off so research content stays on this machine', () => {
    expect(process.env.LANGSMITH_TRACING).toBe('false');
  });

  it('cancels a running session promptly', async () => {
    const slow = await startFakeOpenAi({ delayMs: 8_000 });
    try {
      const { job } = await queueJob(ctx.store, { kind: 'entity', target: '特斯拉', requestedBy: 'test' });
      const started = Date.now();
      const run = runResearchJob(ctx, job, { mcp, agent: agentFor(slow.url), log: () => {} });
      for (let i = 0; i < 100 && activeSessions(job.id) === 0; i++) await new Promise((r) => setTimeout(r, 50));
      expect(activeSessions(job.id)).toBe(1);
      await cancelJob(ctx.store, job.id);
      killAgentsFor(job.id);
      const done = await run;
      expect(Date.now() - started).toBeLessThan(6_000); // the 8 s stall was not waited out
      expect(done.status).toBe('cancelled');
      expect((await getJob(ctx.store, job.id))?.status).toBe('cancelled');
    } finally {
      await slow.close();
    }
  }, 60_000);

  it('runs the team pipeline, with a phase per role', async () => {
    ctx.config.research.pipeline = 'team';
    try {
      const { job } = await queueJob(ctx.store, { kind: 'entity', target: '蔚来', requestedBy: 'test' });
      const done = await runResearchJob(ctx, job, { mcp, agent: agentFor(llm.url), log: () => {} });
      expect(done.status).toBe('done');
      const phases = (done.payload?.phases ?? []) as { name: string; label: string; agent: string }[];
      expect(phases.map((p) => p.name)).toEqual(expect.arrayContaining(['plan', 'research', 'synthesize', 'review']));
      expect(phases.every((p) => p.agent === 'deep-agents')).toBe(true);
      // each phase is its own session, so each leaves its own transcript
      const runDir = path.join(wsDir, '.runs', job.id);
      expect(fs.existsSync(path.join(runDir, 'plan.json'))).toBe(true);
      expect(fs.readdirSync(path.join(runDir, 'findings')).length).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(runDir, 'transcript-synthesize.jsonl'))).toBe(true);
    } finally {
      ctx.config.research.pipeline = 'single';
    }
  }, 180_000);

  it('lists what can run here, and what to preselect when nothing is configured', async () => {
    const jsonHeaders = { ...headers, 'content-type': 'application/json' };
    const res = await app.request('/api/config/agents', { headers: jsonHeaders });
    const body = (await res.json()) as { agents: { id: string; kind: string; available: boolean }[]; suggested: string | null };
    expect(body.agents.map((a) => a.id)).toEqual(expect.arrayContaining(['claude-cli', 'codex-cli', 'cursor-cli']));
    // the default connection is an OpenAI-compatible one, so it appears as a built-in agent
    const fallback = body.agents.find((a) => a.id === 'default');
    expect(fallback).toMatchObject({ kind: 'builtin' });
  });

  it('refuses an agent spec that cannot resolve, instead of stalling the queue later', async () => {
    const jsonHeaders = { ...headers, 'content-type': 'application/json' };
    const bad = await app.request('/api/config', { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ research: { agent: 'nope-cli' } }) });
    expect(bad.status).toBe(400);
    expect((await bad.json()) as { error: string }).toMatchObject({ error: expect.stringContaining('nope-cli') });

    // an empty spec stays legal: it is the honest "not configured" state
    const empty = await app.request('/api/config', { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ research: { agent: '' } }) });
    expect(empty.status).toBe(200);
  });

  it('reports a timeout as a failure, not as a cancellation', async () => {
    const slow = await startFakeOpenAi({ delayMs: 8_000 });
    try {
      const { job } = await queueJob(ctx.store, { kind: 'entity', target: '比亚迪', requestedBy: 'test' });
      ctx.config.research.timeoutMs = 800;
      const done = await runResearchJob(ctx, job, { mcp, agent: agentFor(slow.url), log: () => {} });
      expect(done.status).toBe('failed');
      expect(done.error).toMatch(/timed out/);
    } finally {
      ctx.config.research.timeoutMs = 1_200_000;
      await slow.close();
    }
  }, 60_000);
});
