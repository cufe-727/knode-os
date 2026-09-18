import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { sync } from '../src/ingest/sync.js';
import { cancelJob, claimNextJob, getJob, queueJob } from '../src/research/jobs.js';
import { activeSessions, isCancelled, killAgentsFor } from '../src/research/launch.js';
import { runResearchJob } from '../src/research/runner.js';
import { createApp } from '../src/server/app.js';
import { MCP_TOKEN_FILE } from '../src/server/mcp-http.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';

/** Cancelling a running job kills its CLI session and ends the job as `cancelled` — no retry, no `failed`. */

const helpers = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers');
const fakeClaude = path.join(helpers, 'fake-claude.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-research-cancel-'));
const root = path.join(tmp, 'data');
const wsDir = path.join(root, 'users', 'admin', 'workspaces', 'default');
const scope = { user: 'admin', kind: 'personal' as const, id: 'default', name: 'Default', slug: 'default', relativeDir: 'users/admin/workspaces/default' };
const headers = { 'x-knode-user': 'admin', 'x-knode-workspace-kind': 'personal', 'x-knode-workspace-id': 'default', 'x-knode-workspace-name': 'Default' };

let rootCtx: AppContext;
let registry: WorkspaceContextRegistry;
let ctx: AppContext;
let httpServer: Server;
let mcp: { url: string; token: string; headers: Record<string, string> };
const agent = { kind: 'cli' as const, provider: 'claude-cli' as const, cliPath: fakeClaude, model: '' };

beforeAll(async () => {
  rootCtx = await createContext(root);
  registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
  const app = createApp(rootCtx, () => {}, registry);
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
  const abs = path.join(wsDir, 'raw', 'docs', 'trusted.md');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '---\ntitle: 宁德时代\nentities:\n  - { name: 宁德时代, type: organization }\n---\n宁德时代是电池厂。\n');
  await sync(ctx, { llmGraph: false });
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await registry.closeAll();
  await rootCtx.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('cancelling a running research job', () => {
  it('kills the session and ends the job as cancelled without a retry', async () => {
    const { job } = await queueJob(ctx.store, { kind: 'entity', target: '宁德时代', requestedBy: 'test' });
    process.env.FAKE_AGENT_MODE = 'slow';
    process.env.FAKE_AGENT_SLEEP_MS = '8000';
    const running = runResearchJob(ctx, job, { mcp, agent, log: () => {} });
    // wait for the CLI to be spawned
    for (let i = 0; i < 100 && activeSessions(job.id) === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(activeSessions(job.id)).toBe(1);
    expect(await cancelJob(ctx.store, job.id)).toBe(true);
    expect(killAgentsFor(job.id)).toBe(1);
    const t0 = Date.now();
    const done = await running;
    expect(Date.now() - t0).toBeLessThan(5000); // the sleep was not waited out
    expect(done.status).toBe('cancelled');
    expect(done.payload.rejections).toBeUndefined();
    expect((await getJob(ctx.store, job.id))?.status).toBe('cancelled');
    expect(isCancelled(job.id)).toBe(false); // cleared, so a retry can run
    expect(fs.existsSync(path.join(wsDir, '.runs', job.id, 'rejected.md'))).toBe(false);
    delete process.env.FAKE_AGENT_SLEEP_MS;
    process.env.FAKE_AGENT_MODE = 'good';
  }, 60_000);

  it('a cancelled job is never claimed by the loop, but an explicit re-run (research run <id>) starts it fresh', async () => {
    const { job } = await queueJob(ctx.store, { kind: 'entity', target: '宁德时代', requestedBy: 'test', template: 'entity' });
    killAgentsFor(job.id); // as the cancel route would, before any session exists
    expect(await cancelJob(ctx.store, job.id)).toBe(true);
    expect(await claimNextJob(ctx.store)).toBeNull();
    process.env.FAKE_AGENT_MODE = 'good';
    // a run that starts is by definition not cancelled: the in-process flag is cleared and the row goes back to running
    const done = await runResearchJob(ctx, job, { mcp, agent, log: () => {} });
    expect(done.status).toBe('done');
    expect(isCancelled(job.id)).toBe(false);
  }, 60_000);
});
