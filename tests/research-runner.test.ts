import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { sync } from '../src/ingest/sync.js';
import { listDisputes } from '../src/lineage/trust.js';
import { getJob, queueJob } from '../src/research/jobs.js';
import { runResearchJob } from '../src/research/runner.js';
import { createApp } from '../src/server/app.js';
import { MCP_TOKEN_FILE } from '../src/server/mcp-http.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';
import { ensureEntityStubs } from '../src/wiki/pages.js';
import { queryClaims } from '../src/store/claims.js';

/**
 * The deep-research runner end to end, with a fake agent CLI standing in for
 * claude: the job gets a workspace + brief, the agent reaches the index over
 * MCP, writes its page through knode_write, the runner validates the page,
 * syncs it as a quarantined source, and a contradiction opens a dispute.
 */

const helpers = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers');
const fakeClaude = path.join(helpers, 'fake-claude.sh');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-research-'));
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

function write(rel: string, content: string): void {
  const abs = path.join(wsDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeAll(async () => {
  rootCtx = await createContext(root);
  registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
  const app = createApp(rootCtx, () => {}, registry);
  await app.request('/api/workspaces', { headers: { 'x-knode-user': 'admin' } });
  ctx = await registry.get(scope);
  ctx.config.research.pipeline = 'single'; // the team pipeline has its own test
  const token = fs.readFileSync(path.join(root, MCP_TOKEN_FILE), 'utf8').trim();
  await new Promise<void>((resolve) => {
    httpServer = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      mcp = { url: `http://127.0.0.1:${info.port}/mcp`, token, headers };
      resolve();
    }) as Server;
  });
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
  await ensureEntityStubs(ctx, { minMentions: 1 }); // a generated stub already sits at the output path
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await registry.closeAll();
  await rootCtx.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('research runner', () => {
  it('runs a job end to end: workspace, agent over MCP, validation, quarantined source', async () => {
    expect(fs.existsSync(path.join(wsDir, 'wiki', 'entities', '宁德时代.md'))).toBe(true); // the stub
    const { job } = await queueJob(ctx.store, { kind: 'entity', target: '宁德时代', requestedBy: 'test' });
    process.env.FAKE_AGENT_MODE = 'good';
    const done = await runResearchJob(ctx, job, { mcp, agent, log: () => {} });
    expect(done.status).toBe('done');
    expect(done.outputPath).toBe('wiki/entities/宁德时代.md');
    expect(done.turns).toBeGreaterThanOrEqual(3);
    expect(done.costUsd).toBeCloseTo(0.0123);

    const page = fs.readFileSync(path.join(wsDir, 'wiki', 'entities', '宁德时代.md'), 'utf8');
    expect(page).toContain('actor: agent/claude-cli');
    expect(page).toContain(`job: ${job.id}`);
    expect(page).toContain('## 时间线');
    // the old stub went to the archive; the page is now a Source of the agent's, quarantined
    expect(fs.existsSync(path.join(wsDir, 'wiki', '.archive', 'entities', '宁德时代.md'))).toBe(true);
    const [scopeRow] = await ctx.store.query<{ trust: string; kind: string }>(`SELECT trust, kind FROM scopes WHERE key = 'wiki/entities/宁德时代.md' AND status = 'active'`);
    expect(scopeRow).toMatchObject({ kind: 'doc', trust: 'quarantined' });
    expect(await ctx.store.query(`SELECT path FROM pages WHERE path = 'wiki/entities/宁德时代.md' AND tx_to IS NULL`)).toEqual([]);
    // frontmatter relations and claims entered the graph (quarantined)
    const rel = await ctx.store.query<{ source_id: string; target_id: string }>(`SELECT source_id, target_id FROM relations WHERE type = 'supplies_to' AND tx_to IS NULL`);
    expect(rel).toEqual([{ source_id: '宁德时代', target_id: '特斯拉' }]);
    const wikiPath = await ctx.store.query<{ wiki_path: string | null }>(`SELECT wiki_path FROM entities WHERE id = '宁德时代'`);
    expect(wikiPath).toEqual([{ wiki_path: 'wiki/entities/宁德时代.md' }]);
    const claims = await queryClaims(ctx.store, { subject: '宁德时代', types: ['revenue'] });
    expect(claims.claims).toHaveLength(1); // same statement as the trusted claim → one row, two supporters
    expect(claims.claims[0].evidenceCount).toBe(2);
    // run artefacts and the wiki log
    const runDir = path.join(wsDir, '.runs', job.id);
    expect(fs.existsSync(path.join(runDir, 'brief.md'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'transcript.jsonl'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'validation.json'), 'utf8')).ok).toBe(true);
    expect(fs.readFileSync(path.join(wsDir, 'wiki', 'log.md'), 'utf8')).toContain('research');
    const brief = fs.readFileSync(path.join(runDir, 'brief.md'), 'utf8');
    expect(brief).toContain('supplies_to');
    expect(brief).toContain('宁德时代');
    // the workset the agent used is closed
    const [ws] = await ctx.store.query<{ closed_at: string | null }>(`SELECT closed_at FROM worksets WHERE id = $1`, [done.worksetId]);
    expect(ws.closed_at).not.toBeNull();
  }, 120_000);

  it('opens a dispute when the agent contradicts a trusted claim', async () => {
    const { job } = await queueJob(ctx.store, { kind: 'entity', target: '宁德时代', requestedBy: 'test', payload: { variant: 'contradict' } });
    process.env.FAKE_AGENT_MODE = 'contradict';
    const done = await runResearchJob(ctx, job, { mcp, agent, log: () => {} });
    expect(done.status).toBe('done');
    const open = await listDisputes(ctx.store, { status: 'open' });
    expect(open.length).toBeGreaterThanOrEqual(1);
    expect(open[0].reason).toContain('wiki/entities/宁德时代.md');
    // both revenue claims are visible only when asking for any trust tier; the trusted one still stands
    const trusted = await queryClaims(ctx.store, { subject: '宁德时代', types: ['revenue'], filter: { kinds: undefined, sources: undefined, trust: 'trusted', actor: undefined, notes: [] } as never });
    expect(trusted.claims.map((c) => c.statement)).toEqual(['2025 年营业收入 4000 亿元']);
  }, 120_000);

  it('rejects a page that misses required sections, retries once, then fails', async () => {
    const { job } = await queueJob(ctx.store, { kind: 'entity', target: '比亚迪', requestedBy: 'test' });
    process.env.FAKE_AGENT_MODE = 'bad';
    const first = await runResearchJob(ctx, job, { mcp, agent, log: () => {} });
    expect(first.status).toBe('queued');
    expect(first.error).toContain('missing section');
    expect(fs.existsSync(path.join(wsDir, 'wiki', 'entities', '比亚迪.md'))).toBe(false);
    expect(fs.existsSync(path.join(wsDir, '.runs', job.id, 'rejected.md'))).toBe(true);
    const second = await runResearchJob(ctx, (await getJob(ctx.store, job.id))!, { mcp, agent, log: () => {} });
    expect(second.status).toBe('failed');
    expect((second.payload.rejections as string[]).length).toBe(2);
    expect(fs.readFileSync(path.join(wsDir, '.runs', job.id, 'brief.md'), 'utf8')).toContain('上一次提交被退回');
  }, 120_000);

  it('refuses to drop human-written prose on an existing page', async () => {
    write('wiki/entities/蔚来.md', `---
title: 蔚来
type: organization
---
# 蔚来

人工备注：这一段是人写的，任何自动改写都必须保留它，因为它记录了一个只有作者知道的背景。
`);
    await sync(ctx, { only: ['wiki/entities/蔚来.md'] });
    const { job } = await queueJob(ctx.store, { kind: 'entity', target: '蔚来', requestedBy: 'test' });
    process.env.FAKE_AGENT_MODE = 'drop-human';
    const first = await runResearchJob(ctx, job, { mcp, agent, log: () => {} });
    expect(first.status).toBe('queued');
    expect(first.error).toContain('human-written');
    process.env.FAKE_AGENT_MODE = 'good';
    const second = await runResearchJob(ctx, (await getJob(ctx.store, job.id))!, { mcp, agent, log: () => {} });
    expect(second.status).toBe('done');
    expect(fs.readFileSync(path.join(wsDir, 'wiki', 'entities', '蔚来.md'), 'utf8')).toContain('人工备注：这一段是人写的');
  }, 120_000);
});
