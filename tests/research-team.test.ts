import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { sync } from '../src/ingest/sync.js';
import { queueJob } from '../src/research/jobs.js';
import { extractJson } from '../src/research/pipeline.js';
import { runResearchJob } from '../src/research/runner.js';
import { createApp } from '../src/server/app.js';
import { MCP_TOKEN_FILE } from '../src/server/mcp-http.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';

/**
 * The team pipeline: plan → parallel research → synthesize → review → revise,
 * each a separate session of the (fake) CLI with its own tool scope, state
 * carried as files under the run directory.
 */

const helpers = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers');
const fakeClaude = path.join(helpers, 'fake-claude.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-research-team-'));
const root = path.join(tmp, 'data');
const wsDir = path.join(root, 'users', 'admin', 'workspaces', 'default');
const scope = { user: 'admin', kind: 'personal' as const, id: 'default', name: 'Default', slug: 'default', relativeDir: 'users/admin/workspaces/default' };
const headers = { 'x-knode-user': 'admin', 'x-knode-workspace-kind': 'personal', 'x-knode-workspace-id': 'default', 'x-knode-workspace-name': 'Default' };

let rootCtx: AppContext;
let registry: WorkspaceContextRegistry;
let ctx: AppContext;
let httpServer: Server;
let mcp: { url: string; token: string; headers: Record<string, string> };
const agent = { provider: 'claude-cli' as const, cliPath: fakeClaude, model: '' };

beforeAll(async () => {
  rootCtx = await createContext(root);
  registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
  const app = createApp(rootCtx, () => {}, registry);
  await app.request('/api/workspaces', { headers: { 'x-knode-user': 'admin' } });
  ctx = await registry.get(scope);
  ctx.config.research.pipeline = 'team';
  ctx.config.research.researchers = 2;
  ctx.config.research.reviewRounds = 1;
  const token = fs.readFileSync(path.join(root, MCP_TOKEN_FILE), 'utf8').trim();
  await new Promise<void>((resolve) => {
    httpServer = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      mcp = { url: `http://127.0.0.1:${info.port}/mcp`, token, headers };
      resolve();
    }) as Server;
  });
  const abs = path.join(wsDir, 'raw', 'docs', 'trusted.md');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `---
title: 宁德时代 2025 年报摘要
date: 2026-03-30
entities:
  - { name: 宁德时代, type: organization, aliases: ["CATL", "300750"] }
claims:
  - { subject: 宁德时代, type: revenue, statement: 2025 年营业收入 4000 亿元, eventDate: "2025" }
---
宁德时代 2025 年营业收入 4000 亿元。
`);
  await sync(ctx, { llmGraph: false });
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await registry.closeAll();
  await rootCtx.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('team pipeline', () => {
  it('plans, researches in parallel, synthesizes, gets critiqued once and revises', async () => {
    const { job } = await queueJob(ctx.store, { kind: 'entity', target: '宁德时代', requestedBy: 'test' });
    process.env.FAKE_AGENT_MODE = 'good';
    process.env.FAKE_AGENT_REVIEW = 'critique';
    const done = await runResearchJob(ctx, job, { mcp, agent, log: () => {} });
    delete process.env.FAKE_AGENT_REVIEW;
    expect(done.status).toBe('done');
    const runDir = path.join(wsDir, '.runs', job.id);
    const plan = JSON.parse(fs.readFileSync(path.join(runDir, 'plan.json'), 'utf8'));
    expect(plan.sections.length).toBeGreaterThanOrEqual(2);
    expect(plan.sections.map((s: { title: string }) => s.title)).toEqual(expect.arrayContaining(['## 概要', '## 关键事实']));
    const findings = fs.readdirSync(path.join(runDir, 'findings'));
    expect(findings.length).toBe(plan.sections.length);
    expect(fs.readFileSync(path.join(runDir, 'findings', findings[0]), 'utf8')).toContain('## 发现');
    const phases = (done.payload.phases as { name: string; label: string }[]).map((p) => p.label);
    expect(phases.slice(0, 1)).toEqual(['plan']);
    expect(phases).toEqual(expect.arrayContaining(['synthesize', 'review-1', 'revise-1', 'review-2']));
    expect(phases.filter((p) => p.startsWith('research-')).length).toBe(plan.sections.length);
    expect(done.payload.reviewRounds).toBe(1);
    expect(done.turns).toBeGreaterThan(5);
    const page = fs.readFileSync(path.join(wsDir, 'wiki', 'entities', '宁德时代.md'), 'utf8');
    expect(page).toContain('（已修订）');
    expect(page).toContain('actor: agent/claude-cli');
    expect(fs.existsSync(path.join(runDir, 'transcript-plan.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'transcript-synthesize.jsonl'))).toBe(true);
    const [scopeRow] = await ctx.store.query<{ trust: string }>(`SELECT trust FROM scopes WHERE key = 'wiki/entities/宁德时代.md' AND status = 'active'`);
    expect(scopeRow.trust).toBe('quarantined');
  }, 180_000);

  it('extracts JSON from chatty replies', () => {
    expect(extractJson<{ a: number }>('Sure! ```json\n{"a": 1}\n``` done')).toEqual({ a: 1 });
    expect(extractJson('no json here')).toBeNull();
  });
});
