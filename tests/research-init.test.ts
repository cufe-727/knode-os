import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { isSeedTemplate } from '../src/fs/datadir.js';
import { sync } from '../src/ingest/sync.js';
import { carryOverHumanNotes, stampGuide, topicsFrom } from '../src/research/init.js';
import { getJob, listJobs, queueJob } from '../src/research/jobs.js';
import { runResearchJob } from '../src/research/runner.js';
import { folderOf, readGuideStamp, surveyKnowledgeBase } from '../src/research/survey.js';
import { createApp } from '../src/server/app.js';
import { MCP_TOKEN_FILE } from '../src/server/mcp-http.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';

/**
 * Knowledge-base initialization (research kind `init`): the pre-flight steps,
 * a team run that writes the overview page and the AGENTS.md guide through
 * MCP, validation of both, the guide's stamp / CLAUDE.md copy / carried-over
 * human notes, the follow-up topic jobs, and the HTTP surface around it.
 */

const helpers = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers');
const fakeClaude = path.join(helpers, 'fake-claude.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-research-init-'));
const root = path.join(tmp, 'data');
const wsDir = path.join(root, 'users', 'admin', 'workspaces', 'default');
const scope = { user: 'admin', kind: 'personal' as const, id: 'default', name: 'Default', slug: 'default', relativeDir: 'users/admin/workspaces/default' };
const headers = { 'x-knode-user': 'admin', 'x-knode-workspace-kind': 'personal', 'x-knode-workspace-id': 'default', 'x-knode-workspace-name': 'Default' };

let rootCtx: AppContext;
let registry: WorkspaceContextRegistry;
let ctx: AppContext;
let app: ReturnType<typeof createApp>;
let httpServer: Server;
let mcp: { url: string; token: string; headers: Record<string, string> };
const agent = { kind: 'cli' as const, provider: 'claude-cli' as const, cliPath: fakeClaude, model: '' };

function write(rel: string, content: string): void {
  const abs = path.join(wsDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const api = (p: string, init: RequestInit = {}) => app.request(p, { ...init, headers: { 'content-type': 'application/json', ...headers, ...(init.headers as Record<string, string> | undefined) } });

beforeAll(async () => {
  rootCtx = await createContext(root);
  registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
  app = createApp(rootCtx, () => {}, registry);
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
  write('raw/docs/reports/trusted.md', `---
title: 宁德时代 2025 年报摘要
date: 2026-03-30
entities:
  - { name: 宁德时代, type: organization, aliases: ["CATL", "300750"] }
claims:
  - { subject: 宁德时代, type: revenue, statement: 2025 年营业收入 4000 亿元, eventDate: "2025" }
---
宁德时代 2025 年营业收入 4000 亿元，动力电池出货量全球第一。
`);
  write('raw/docs/notes/memo.md', `---
title: 动力电池行业备忘
date: 2026-01-10
---
动力电池行业的主要玩家有宁德时代和比亚迪。
`);
  await sync(ctx, { llmGraph: false });
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await registry.closeAll();
  await rootCtx.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('knowledge-base initialization', () => {
  it('queues one init at a time and still requires a target for other kinds', async () => {
    const first = await queueJob(ctx.store, { kind: 'init', requestedBy: 'test' });
    expect(first.created).toBe(true);
    expect(first.job.target).toBeNull();
    const again = await queueJob(ctx.store, { kind: 'init', requestedBy: 'test' });
    expect(again.created).toBe(false);
    expect(again.job.id).toBe(first.job.id);
    await expect(queueJob(ctx.store, { kind: 'entity', requestedBy: 'test' })).rejects.toThrow(/needs a target/);
    // the row stays queued for the next test
  });

  it('surveys the base deterministically', async () => {
    const s = await surveyKnowledgeBase(ctx);
    expect(s.stats.documents).toBeGreaterThanOrEqual(2);
    expect(s.documents.byFolder.map((f) => f.folder)).toEqual(expect.arrayContaining(['raw/docs/reports', 'raw/docs/notes']));
    expect(s.documents.dateRange).toEqual({ from: '2026-01-10', to: '2026-03-30' });
    expect(s.entities.byType.find((t) => t.type === 'organization')?.n).toBeGreaterThanOrEqual(1);
    expect(s.entities.top.map((e) => e.name)).toContain('宁德时代');
    expect(s.claims.total).toBeGreaterThanOrEqual(1);
    expect(s.extraction.llmEnabled).toBe(false);
    expect(s.guide.exists).toBe(false);
    expect(s.wiki.overview).toMatchObject({ exists: true, seeded: true });
    expect(s.ontology.packs).toEqual(['core', 'organization']);
    expect(s.ontology.relationTypes).toContain('supplies_to');
    expect(s.notes.purposeIsTemplate).toBe(true);
    expect(folderOf('raw/docs/a/b/c.md')).toBe('raw/docs/a');
    expect(folderOf('raw/docs/x.md')).toBe('raw/docs');
    expect(folderOf('wiki/entities/x.md')).toBe('wiki/entities');
    expect(isSeedTemplate('wiki/overview.md', fs.readFileSync(path.join(wsDir, 'wiki', 'overview.md'), 'utf8'))).toBe(true);
    expect(isSeedTemplate('wiki/overview.md', '# something else')).toBe(false);
  });

  it('runs the pre-flight, writes the overview and the guide, stamps and copies the guide, queues topic pages', async () => {
    const [queued] = await listJobs(ctx.store, { kind: 'init', status: 'queued' });
    expect(queued).toBeDefined();
    process.env.FAKE_AGENT_MODE = 'good';
    const done = await runResearchJob(ctx, queued, { mcp, agent, log: () => {} });
    expect(done.error).toBeNull();
    expect(done.status).toBe('done');
    expect(done.outputPath).toBe('wiki/overview.md');

    const steps = done.payload.steps as { name: string; status: string; detail?: string }[];
    expect(steps.map((s) => s.name)).toEqual(['sync', 'extract', 'views', 'survey']);
    expect(steps.find((s) => s.name === 'extract')?.status).toBe('skipped'); // no extraction LLM in tests
    expect(steps.every((s) => s.status !== 'running' && s.status !== 'failed')).toBe(true);

    const runDir = path.join(wsDir, '.runs', queued.id);
    const brief = fs.readFileSync(path.join(runDir, 'brief.md'), 'utf8');
    expect(brief).toContain('## 知识库概况');
    expect(brief).toContain('- 目标：本知识库');
    expect(brief).toContain('- 附加输出');
    expect(brief).not.toContain('## 知识库预整理');
    const schema = fs.readFileSync(path.join(runDir, 'CLAUDE.md'), 'utf8');
    expect(schema).toContain('# 知识库初始化');
    const plan = JSON.parse(fs.readFileSync(path.join(runDir, 'plan.json'), 'utf8'));
    expect(plan.sections.length).toBeGreaterThanOrEqual(6); // the planner's two + the required rest, 来源 excluded
    const phases = (done.payload.phases as { label: string }[]).map((p) => p.label);
    expect(phases).toEqual(expect.arrayContaining(['plan', 'research-1', 'synthesize', 'review-1']));

    const overview = fs.readFileSync(path.join(wsDir, 'wiki', 'overview.md'), 'utf8');
    expect(overview).toContain('actor: agent/claude-cli');
    expect(overview).toContain('selfEntity: false');
    for (const h of ['## 知识库是什么', '## 主题地图', '## 核心实体', '## 资料概况', '## 时间范围与时效', '## 缺口与建议', '## 来源']) expect(overview).toContain(h);
    const [scopeRow] = await ctx.store.query<{ trust: string }>(`SELECT trust FROM scopes WHERE key = 'wiki/overview.md' AND status = 'active'`);
    expect(scopeRow.trust).toBe('quarantined');
    // the hub page is about the whole base: no entity named after it
    expect(await ctx.store.query(`SELECT id FROM entities WHERE name = '知识库总览' AND tx_to IS NULL`)).toEqual([]);

    const guide = fs.readFileSync(path.join(wsDir, 'AGENTS.md'), 'utf8');
    expect(guide.split('\n')[0]).toMatch(/^<!-- knode-init: /);
    expect(readGuideStamp(guide)).toMatchObject({ job: queued.id, agent: 'claude-cli' });
    for (const h of ['## 知识库是什么', '## 如何查询', '## 人工备注']) expect(guide).toContain(h);
    expect(fs.readFileSync(path.join(wsDir, 'CLAUDE.md'), 'utf8')).toBe(guide);
    // the guide is not a source
    expect(await ctx.store.query(`SELECT path FROM documents WHERE path IN ('AGENTS.md', 'CLAUDE.md')`)).toEqual([]);

    const topics = done.payload.topics as { kind: string; target: string; queued?: string }[];
    expect(topics.map((t) => `${t.kind}:${t.target}`)).toEqual(['entity:宁德时代', 'concept:动力电池']);
    expect(topics.every((t) => t.queued)).toBe(true);
    expect(done.payload.followUps).toHaveLength(2);
    const followUps = await listJobs(ctx.store, { requestedBy: 'init' });
    expect(followUps.map((j) => `${j.kind}:${j.target}:${j.status}`).sort()).toEqual(['concept:动力电池:queued', 'entity:宁德时代:queued']);
    expect(followUps[0].payload.from).toBe(queued.id);

    const survey = await surveyKnowledgeBase(ctx);
    expect(survey.guide).toMatchObject({ exists: true, stamp: { job: queued.id } });
    expect(survey.wiki.overview).toMatchObject({ exists: true, seeded: false, actor: 'agent/claude-cli' });
    expect(survey.lastInit).toMatchObject({ id: queued.id, status: 'done' });
  }, 180_000);

  it('keeps a person\'s 人工备注 across a re-initialization and backs the previous guide up', async () => {
    const guideFile = path.join(wsDir, 'AGENTS.md');
    const previous = fs.readFileSync(guideFile, 'utf8');
    fs.writeFileSync(guideFile, previous.replace(/## 人工备注\s*$/m, '## 人工备注\n\n财务口径以年报为准，季报只做参考。\n\n### 子备注\n\n保留这一段。'));
    const { job, created } = await queueJob(ctx.store, { kind: 'init', requestedBy: 'test' });
    expect(created).toBe(true);
    process.env.FAKE_AGENT_MODE = 'good';
    const done = await runResearchJob(ctx, job, { mcp, agent, log: () => {} });
    expect(done.status).toBe('done');
    const guide = fs.readFileSync(guideFile, 'utf8');
    expect(guide).toContain('财务口径以年报为准，季报只做参考。');
    expect(guide).toContain('### 子备注');
    expect(readGuideStamp(guide)?.job).toBe(job.id);
    expect(fs.existsSync(path.join(wsDir, '.runs', job.id, 'existing-AGENTS.md'))).toBe(true);
    const brief = fs.readFileSync(path.join(wsDir, '.runs', job.id, 'brief.md'), 'utf8');
    expect(brief).toContain('## AGENTS.md 上一版');
    // follow-ups were already queued by the first run: nothing new
    expect(done.payload.followUps).toEqual([]);
  }, 180_000);

  it('rejects a run that leaves the previous guide untouched', async () => {
    const guideFile = path.join(wsDir, 'AGENTS.md');
    const previous = fs.readFileSync(guideFile, 'utf8');
    const { job } = await queueJob(ctx.store, { kind: 'init', requestedBy: 'test' });
    process.env.FAKE_AGENT_MODE = 'no-guide';
    const first = await runResearchJob(ctx, job, { mcp, agent, log: () => {} });
    expect(first.status).toBe('queued');
    expect(first.error).toContain('AGENTS.md was not rewritten');
    expect(fs.readFileSync(guideFile, 'utf8')).toBe(previous);
    process.env.FAKE_AGENT_MODE = 'good';
    const second = await runResearchJob(ctx, first, { mcp, agent, log: () => {} });
    expect(second.status).toBe('done'); // the retry writes it and the guide is stamped again
    expect(fs.readFileSync(guideFile, 'utf8')).not.toBe(previous);
  }, 180_000);

  it('rejects a guide that misses a required section, restores the previous one, and fails after the retry', async () => {
    const guideFile = path.join(wsDir, 'AGENTS.md');
    const previous = fs.readFileSync(guideFile, 'utf8');
    const { job } = await queueJob(ctx.store, { kind: 'init', requestedBy: 'test' });
    process.env.FAKE_AGENT_MODE = 'bad-guide';
    const first = await runResearchJob(ctx, job, { mcp, agent, log: () => {} });
    expect(first.status).toBe('queued');
    expect(first.error).toContain('AGENTS.md: missing section ## 如何查询');
    expect(fs.readFileSync(guideFile, 'utf8')).toBe(previous);
    expect(fs.existsSync(path.join(wsDir, '.runs', job.id, 'rejected-AGENTS.md'))).toBe(true);
    const second = await runResearchJob(ctx, first, { mcp, agent, log: () => {} });
    expect(second.status).toBe('failed');
    expect(fs.readFileSync(guideFile, 'utf8')).toBe(previous);
    process.env.FAKE_AGENT_MODE = 'good';
  }, 180_000);

  it('serves the init card, the survey and the job detail over HTTP', async () => {
    const status = await api('/api/research/init');
    expect(status.status).toBe(200);
    const body = await status.json() as { survey: { stats: { documents: number } }; guide: { exists: boolean }; job: { kind: string; status: string }; followUps: unknown[] };
    expect(body.survey.stats.documents).toBeGreaterThanOrEqual(2);
    expect(body.guide.exists).toBe(true);
    expect(body.job.kind).toBe('init');
    expect(body.followUps.length).toBeGreaterThanOrEqual(2);

    const survey = await api('/api/survey');
    expect(survey.status).toBe(200);
    expect((await survey.json() as { entities: { total: number } }).entities.total).toBeGreaterThanOrEqual(1);

    const queued = await api('/api/research/init', { method: 'POST' });
    expect(queued.status).toBe(201);
    const { job } = await queued.json() as { job: { id: string } };
    const dup = await api('/api/research/init', { method: 'POST' });
    expect(dup.status).toBe(200);
    const cancel = await api(`/api/research/jobs/${job.id}/cancel`, { method: 'POST' });
    expect(await cancel.json()).toEqual({ cancelled: true, killed: 0 });
    expect((await getJob(ctx.store, job.id))?.status).toBe('cancelled');

    const [done] = await listJobs(ctx.store, { kind: 'init', status: 'done' });
    const detail = await api(`/api/research/jobs/${done.id}?log=plan`);
    const d = await detail.json() as { log: string | null; phases: unknown[]; plan: { topics: unknown[] } | null; steps: unknown[]; transcripts: string[] };
    expect(d.log).toContain('"type":"result"');
    expect(d.phases.length).toBeGreaterThan(0);
    expect(d.plan?.topics).toBeUndefined(); // plan.json carries sections; topics live on the job payload
    expect(d.steps.length).toBe(4);
    expect(d.transcripts).toEqual(expect.arrayContaining(['plan', 'synthesize']));
    const bad = await api(`/api/research/jobs/${done.id}?log=../x`);
    expect(bad.status).toBe(400);
  });

  it('parses topics, carries notes over and stamps guides (units)', () => {
    expect(topicsFrom('sure: ```json\n{"topics":[{"kind":"Entity","target":" A "},{"kind":"entity","target":"a"},{"kind":"nope","target":"b"},{"kind":"timeline","target":"c","why":"w"}]}\n```')).toEqual([
      { kind: 'entity', target: 'A', why: '' },
      { kind: 'timeline', target: 'c', why: 'w' },
    ]);
    expect(topicsFrom('no json')).toEqual([]);
    const next = '# 指南\n\n## 如何查询\n\n先 resolve。\n\n## 人工备注\n';
    const prev = '# 老指南\n\n## 人工备注\n\n人写的一段。\n\n### 细节\n\n更多。\n\n## 其他\n\n不搬。\n';
    const merged = carryOverHumanNotes(next, prev);
    expect(merged).toContain('## 人工备注\n\n人写的一段。\n\n### 细节\n\n更多。');
    expect(merged).not.toContain('不搬');
    expect(carryOverHumanNotes(next, null)).toBe(next);
    expect(carryOverHumanNotes('# 无备注章节\n', prev)).toContain('## 人工备注\n\n人写的一段。');
    const stamped = stampGuide('<!-- knode-init: {"job":"old"} -->\n# x\n', { job: 'r_1', at: '2026-09-18T00:00:00.000Z', agent: 'claude-cli' });
    expect(stamped.startsWith('<!-- knode-init: {"job":"r_1"')).toBe(true);
    expect(stamped.split('knode-init').length).toBe(2);
    expect(readGuideStamp(stamped)).toEqual({ job: 'r_1', at: '2026-09-18T00:00:00.000Z', agent: 'claude-cli' });
  });
});
