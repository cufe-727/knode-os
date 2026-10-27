import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { saveAgent } from '../src/research/agents.js';
import { readManifest, registerPath, waitForCaptureIndexing } from '../src/research/capture.js';
import { checkCharts, parseChart } from '../src/research/chart.js';
import { claimNextJob, getJob, listJobs } from '../src/research/jobs.js';
import { localizeNoteHeadings, normalizeBrief, noteHeadings, refineBrief, sourceMarker, sourcesHeading } from '../src/research/refine.js';
import { runResearchJob } from '../src/research/runner.js';
import { continueStudies, createStudy, refineStudy, startProblem, startStudy, studyPayload, studyView, updateStudy } from '../src/research/study.js';
import { createApp } from '../src/server/app.js';
import { MCP_TOKEN_FILE } from '../src/server/mcp-http.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';

/**
 * A study end to end with a fake agent CLI: a draft brief, started; the
 * collect stage captures the seed URL and a page per collector into
 * raw/docs/research/<study>/ and writes notes; one page job per planned page
 * runs through the ordinary runner (planned sections, chart blocks, study
 * stamped); the report closes it.
 */

const helpers = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers');
const fakeClaude = path.join(helpers, 'fake-claude.sh');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-study-'));
const root = path.join(tmp, 'data');
const wsDir = path.join(root, 'users', 'admin', 'workspaces', 'default');
const scope = { user: 'admin', kind: 'personal' as const, id: 'default', name: 'Default', slug: 'default', relativeDir: 'users/admin/workspaces/default' };
const headers = { 'x-knode-user': 'admin', 'x-knode-workspace-kind': 'personal', 'x-knode-workspace-id': 'default', 'x-knode-workspace-name': 'Default' };

let rootCtx: AppContext;
let registry: WorkspaceContextRegistry;
let ctx: AppContext;
let httpServer: Server;
let web: http.Server;
let webBase = '';
let mcp: { url: string; token: string; headers: Record<string, string> };
let app: ReturnType<typeof createApp>;

const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title><meta name="date" content="2026-05-20"></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

beforeAll(async () => {
  rootCtx = await createContext(root);
  registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
  app = createApp(rootCtx, () => {}, registry);
  await app.request('/api/workspaces', { headers: { 'x-knode-user': 'admin' } });
  ctx = await registry.get(scope);
  ctx.config.research.pipeline = 'single';
  ctx.config.research.web.allowPrivateHosts = true;
  ctx.config.research.web.proxy = 'none';
  saveAgent(ctx.dataDir, { name: 'fake', title: 'Fake CLI', executor: 'claude-cli', cliPath: fakeClaude });
  const token = fs.readFileSync(path.join(root, MCP_TOKEN_FILE), 'utf8').trim();
  await new Promise<void>((resolve) => {
    httpServer = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      mcp = { url: `http://127.0.0.1:${info.port}/mcp`, token, headers };
      resolve();
    }) as Server;
  });
  web = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const part = url.searchParams.get('part');
    const text = `<p>${'Anthropic sells API access and subscriptions; 2025 revenue was about 4.5 billion dollars and compute is its largest cost. '.repeat(5)}</p><h2>Details ${part ?? ''}</h2><p>${'Customers include enterprises and developers. '.repeat(8)}</p>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page(part ? `Anthropic ${part}` : 'Anthropic prospectus summary', text));
  });
  await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', () => resolve()));
  webBase = `http://127.0.0.1:${(web.address() as { port: number }).port}`;
  process.env.FAKE_CAPTURE_URL = `${webBase}/collect`;
}, 60_000);

afterAll(async () => {
  delete process.env.FAKE_CAPTURE_URL;
  delete process.env.FAKE_STUDY_CHART;
  await waitForCaptureIndexing(wsDir);
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await new Promise<void>((resolve) => web.close(() => resolve()));
  await registry.closeAll();
  await rootCtx.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const TOPIC = "Starting with Anthropic's latest prospectus, understand its revenue and cost structure and how it compares with competitors.";

describe('briefs', () => {
  it('normalizes whatever a model wrote into a brief a study can run', () => {
    const b = normalizeBrief({
      title: 'Anthropic: business and competition',
      pages: [
        { id: 'a', title: 'Revenue and costs', sections: ['Revenue model', '## Cost structure', 'Sources'], charts: ['revenue by year'] },
        { id: 'b', title: 'Revenue and costs', sections: [] },
        { title: '' },
      ],
      questions: [{ text: 'How does it make money?', page: 'a' }, { text: 'Who are its rivals?', page: 'zzz' }, { text: '' }],
      seedUrls: ['https://www.sec.gov/x', 'ftp://nope', { url: 'https://www.sec.gov/x' }],
      clarifications: [{ question: 'Which prospectus?', options: ['S-1', 'S-1/A'] }],
    }, { topic: TOPIC, maxPages: 6, answers: { 'Which prospectus?': 'the latest S-1/A' } });
    expect(b.language).toBe('en');
    expect(b.pages.map((p) => p.slug)).toEqual(['revenue-and-costs', 'revenue-and-costs-2']);
    expect(b.pages[0].sections).toEqual(['## Revenue model', '## Cost structure']); // the sources heading is the system's
    expect(b.pages[1].sections.length).toBeGreaterThan(0);
    expect(b.questions.map((q) => [q.id, q.page])).toEqual([['q1', 'p1'], ['q2', 'p2'], ['q3', 'p2']].slice(0, b.questions.length));
    expect(b.pages.every((p) => p.questions.length > 0)).toBe(true);
    expect(b.seedUrls).toEqual([{ url: 'https://www.sec.gov/x', why: '' }]);
    expect(b.clarifications[0].answer).toBe('the latest S-1/A');
    expect(b.report.sections[0]).toBe('## Executive summary');
    expect(sourcesHeading('zh')).toBe('## 来源');
    expect(normalizeBrief({}, { topic: '研究宁德时代的成本结构与竞争格局', maxPages: 4 }).language).toBe('zh');
  });

  it('refines with a model, and keeps going on a template brief when none is reachable', async () => {
    const answers: string[] = [];
    const fakeLlm = {
      enabled: true, label: 'fake-llm', provider: 'openai', model: 'fake',
      complete: async (messages: { content: string }[]) => {
        answers.push(messages[0].content);
        return JSON.stringify({
          title: 'Anthropic deep dive', language: 'en', objective: 'Understand the business.',
          pages: [{ id: 'p1', title: 'Revenue and costs', sections: ['## Revenue'] }, { id: 'p2', title: 'Competitors', sections: ['## Landscape'] }],
          questions: [{ id: 'q1', text: 'What is revenue?', page: 'p1' }, { id: 'q2', text: 'Who competes?', page: 'p2' }],
          seedUrls: [{ url: `${webBase}/seed`, why: 'the summary' }],
        });
      },
    };
    const saved = ctx.llm;
    (ctx as { llm: unknown }).llm = fakeLlm;
    try {
      const r = await refineBrief(ctx, { topic: TOPIC, sources: [], web: true, maxPages: 6 });
      expect(r.refiner).toBe('fake-llm');
      expect(r.brief.pages.map((p) => p.title)).toEqual(['Revenue and costs', 'Competitors']);
      expect(answers[0]).toContain(TOPIC);
      expect(answers[0]).toContain('知识库现状');
    } finally {
      (ctx as { llm: unknown }).llm = saved;
    }
    const none = await refineBrief({ ...ctx, llm: { enabled: false } as never, config: { ...ctx.config, research: { ...ctx.config.research, study: { ...ctx.config.research.study, refiner: '' } } } }, { topic: TOPIC, sources: [], web: true, maxPages: 6 });
    expect(none.refiner).toBe('template');
    expect(none.brief.pages).toHaveLength(1);
  });

  it('cites and heads notes in the study language, whichever language a collector used', () => {
    expect(sourceMarker('en')).toBe('(Source: raw/docs/…)');
    expect(sourceMarker('zh-CN')).toBe('（来源：raw/docs/…）');
    expect(sourceMarker('ja')).toBe('(Source: raw/docs/…)'); // like the sources heading, other languages get the English form
    expect(noteHeadings('en')).toEqual(['## Findings', '## Data', '## Views', '## Gaps']);
    const note = '## 发现\n- revenue rose\n\n##  数据 \n- 2025=4.5\n\n### 发现\n## 观点\n- bullish\n\n## 缺口\n- none\n## Other\n';
    expect(localizeNoteHeadings(note, 'en')).toBe('## Findings\n- revenue rose\n\n## Data\n- 2025=4.5\n\n### 发现\n## Views\n- bullish\n\n## Gaps\n- none\n## Other\n');
    expect(localizeNoteHeadings('## Findings\n- x\n## Gaps\n', 'zh')).toBe('## 发现\n- x\n## 缺口\n');
  });
});

describe('charts', () => {
  it('accepts a well-formed chart and names what is wrong with a broken one', () => {
    const ok = parseChart(JSON.stringify({ type: 'bar', title: 'Revenue', x: ['2024', '2025'], series: [{ name: 'Revenue', values: [0.9, '4.5'] }], source: 'raw/docs/x.md' }));
    expect(ok.errors).toEqual([]);
    expect(ok.spec?.series[0].values).toEqual([0.9, 4.5]);
    const bad = parseChart(JSON.stringify({ type: 'pie', x: ['a'], series: [{ name: 's', values: [1, 2] }] }));
    expect(bad.errors.join(' ')).toMatch(/type must be one of/);
    expect(bad.errors.join(' ')).toMatch(/title is required/);
    expect(bad.errors.join(' ')).toMatch(/2 values for 1 categories/);
    expect(bad.errors.join(' ')).toMatch(/source is required/);
    expect(checkCharts('# x\n\n```chart\n{not json\n```\n').errors[0]).toMatch(/line 3: not valid JSON/);
    expect(checkCharts('```json\n{"a":1}\n```').count).toBe(0);
  });
});

describe('a study, end to end', () => {
  let studyId = '';

  it('starts as a draft the person edits', async () => {
    const draft = await createStudy(ctx, { topic: TOPIC, refine: false, runner: { agent: 'fake' }, sources: { web: true } });
    studyId = draft.id;
    expect(draft.status).toBe('draft');
    expect(draft.kind).toBe('study');
    const brief = normalizeBrief({
      title: 'Anthropic IPO deep dive', language: 'en', objective: 'Understand how Anthropic makes and spends money.',
      pages: [
        { id: 'p1', title: 'Revenue and cost structure', slug: 'revenue-and-costs', sections: ['## Revenue model', '## Cost structure'] },
        { id: 'p2', title: 'Competitive landscape', slug: 'competitors', sections: ['## Peers', '## Comparison'] },
      ],
      questions: [{ id: 'q1', text: 'How does Anthropic make money?', page: 'p1' }, { id: 'q2', text: 'Who competes with it?', page: 'p2' }],
      seedUrls: [{ url: `${webBase}/seed`, why: 'the prospectus summary' }],
    }, { topic: TOPIC, maxPages: 6 });
    const edited = await updateStudy(ctx, studyId, { brief });
    expect(edited.target).toBe('anthropic-ipo-deep-dive');
    expect(edited.query).toBe('Anthropic IPO deep dive');
    expect(startProblem(ctx, edited)).toBeNull();
    await expect(refineStudy(ctx, 'r_nonexistent', {})).rejects.toThrow(/no study/);
  });

  it('collects: seed captured, one collector per page, notes written, pages queued', async () => {
    await startStudy(ctx, studyId);
    await expect(updateStudy(ctx, studyId, {})).rejects.toThrow(/only a draft/);
    const claimed = await claimNextJob(ctx.store);
    expect(claimed?.id).toBe(studyId);
    const after = await runResearchJob(ctx, claimed!, { mcp, log: () => {} });
    expect(after.status).toBe('waiting');
    const p = studyPayload(after);
    expect(p.stage).toBe('pages');
    expect(p.steps.find((s) => s.name === 'seed')?.status).toBe('done');
    expect(p.steps.find((s) => s.name === 'collect')?.status).toBe('done');
    expect(p.notes).toHaveLength(2);
    const note = fs.readFileSync(path.join(wsDir, p.notes[0]), 'utf8');
    expect(note).toContain('type: research-notes');
    // the collector headed its notes in Chinese (the fake copies the template); an English study keeps English ones
    expect(note).toContain('## Findings');
    expect(note).not.toContain('## 发现');
    const collectPrompt = fs.readFileSync(path.join(wsDir, '.runs', `${studyId}-collect`, 'prompt-collect.md'), 'utf8');
    expect(collectPrompt).toContain('正文出处写 `(Source: raw/docs/…)`');
    expect(collectPrompt).toContain('`## Findings` / `## Data` / `## Views` / `## Gaps`');
    expect(note).toMatch(/sources: \["raw\/docs\/research\/anthropic-ipo-deep-dive\/web\//);
    // the seed and both collectors' pages are captured, in the manifest and the register
    const captured = readManifest(wsDir).entries.filter((e) => e.studies.some((s) => s.id === studyId));
    expect(captured).toHaveLength(3);
    expect(fs.readFileSync(path.join(wsDir, registerPath('anthropic-ipo-deep-dive')), 'utf8')).toContain('the prospectus summary');
    // the collectors could capture and stay out of page-writing
    const argv = JSON.parse(fs.readFileSync(path.join(wsDir, '.runs', `${studyId}-collect`, 'argv-collect.json'), 'utf8')) as string[];
    expect(argv).toContain('mcp__knode-os__knode_capture');
    expect(argv).not.toContain('mcp__knode-os__*');
    const children = await listJobs(ctx.store, { study: studyId });
    expect(children.map((c) => c.kind)).toEqual(['section', 'section']);
    expect(children.map((c) => c.target).sort()).toEqual(['anthropic-ipo-deep-dive/competitors', 'anthropic-ipo-deep-dive/revenue-and-costs']);
    // nothing continues while the pages are pending
    expect(await continueStudies(ctx)).toBe(0);
  });

  it('writes each page through the ordinary runner, with the planned sections, and the report last', async () => {
    for (let i = 0; i < 2; i++) {
      const job = await claimNextJob(ctx.store);
      expect(job?.kind).toBe('section');
      const done = await runResearchJob(ctx, job!, { mcp, log: () => {} });
      expect(done.status, done.error ?? '').toBe('done');
      const text = fs.readFileSync(path.join(wsDir, done.outputPath!), 'utf8');
      expect(done.outputPath).toMatch(/^wiki\/research\/anthropic-ipo-deep-dive\/(revenue-and-costs|competitors)\.md$/);
      expect(text).toContain(`study: ${studyId}`);
      expect(text).toContain('## Sources');
      expect(text).toContain('```chart');
      const brief = fs.readFileSync(path.join(wsDir, '.runs', done.id, 'brief.md'), 'utf8');
      expect(brief).toContain('研究课题（study');
      expect(brief).toContain('raw/docs/research/anthropic-ipo-deep-dive/sources.md');
      expect(brief).toContain('正文出处写 `(Source: raw/docs/…)`');
      expect(brief).not.toContain('笔记的四个固定标题'); // a page writes no notes
    }
    expect(await continueStudies(ctx)).toBe(1);
    const study = await getJob(ctx.store, studyId);
    expect(study?.status).toBe('queued');
    expect(studyPayload(study!).stage).toBe('report');
    const claimed = await claimNextJob(ctx.store);
    expect(claimed?.id).toBe(studyId);
    const done = await runResearchJob(ctx, claimed!, { mcp, log: () => {} });
    expect(done.status, done.error ?? '').toBe('done');
    expect(done.outputPath).toBe('wiki/research/anthropic-ipo-deep-dive.md');
    expect(studyPayload(done).stage).toBe('done');
    const view = await studyView(ctx, done);
    expect(view.reportExists).toBe(true);
    expect(view.pages.map((p) => p.status)).toEqual(['done', 'done']);
    expect(view.pages.every((p) => p.trust === 'quarantined')).toBe(true);
    expect(view.captures.length).toBe(3);
  });

  it('refuses a page whose chart is broken, and retries it once with the reason', async () => {
    const draft = await createStudy(ctx, { topic: 'A second study about chart validation in research pages.', refine: false, runner: { agent: 'fake' }, sources: { web: false } });
    await updateStudy(ctx, draft.id, { brief: normalizeBrief({ title: 'Chart check', pages: [{ title: 'Only page', sections: ['## Numbers'] }], questions: [{ text: 'What are the numbers?' }] }, { topic: 'x', maxPages: 2 }) });
    await startStudy(ctx, draft.id);
    const collected = await runResearchJob(ctx, (await claimNextJob(ctx.store))!, { mcp, log: () => {} });
    expect(collected.status).toBe('waiting');
    process.env.FAKE_STUDY_CHART = 'bad';
    try {
      const job = (await claimNextJob(ctx.store))!;
      const first = await runResearchJob(ctx, job, { mcp, log: () => {} });
      expect(first.status).toBe('queued'); // rejected once, back in line with the reasons
      expect(first.error).toMatch(/chart at line \d+: type must be one of/);
    } finally {
      delete process.env.FAKE_STUDY_CHART;
    }
  });

  it('is reachable over HTTP: list, view, refine refusal once started', async () => {
    const list = await (await app.request('/api/research/studies', { headers })).json() as { id: string; status: string }[];
    expect(list.find((s) => s.id === studyId)?.status).toBe('done');
    const view = await (await app.request(`/api/research/studies/${studyId}`, { headers })).json() as { pages: unknown[]; captures: unknown[] };
    expect(view.pages).toHaveLength(2);
    const refused = await app.request(`/api/research/studies/${studyId}/refine`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'x-knode-csrf': '1' }, body: '{}' });
    expect(refused.status).toBe(400);
  });

  it('promotes what the study produced, says what changed, and offers nothing once all of it is trusted', async () => {
    type Tiers = { trusted: number; quarantined: number; unindexed: number };
    type View = { pages: { trust: string | null }[]; reportTrust: string | null; tiers: { pages: Tiers; sources: Tiers } };
    type Promotion = { to: string; changed: string[]; unchanged: string[]; notIndexed: string[]; failed: unknown[]; count: number };
    const view = async () => (await app.request(`/api/research/studies/${studyId}`, { headers })).json() as Promise<View>;
    const promote = (body: unknown) => app.request(`/api/research/studies/${studyId}/promote`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'x-knode-csrf': '1' }, body: JSON.stringify(body),
    });
    const before = await view();
    expect(before.tiers.pages).toEqual({ trusted: 0, quarantined: 3, unindexed: 0 }); // two pages and the report
    expect(before.tiers.sources.quarantined).toBeGreaterThan(0);
    const pages = await (await promote({ what: 'pages' })).json() as Promotion;
    expect(pages).toMatchObject({ to: 'trusted', unchanged: [], notIndexed: [], failed: [], count: 3 });
    expect(pages.changed.sort()).toEqual(['wiki/research/anthropic-ipo-deep-dive.md', 'wiki/research/anthropic-ipo-deep-dive/competitors.md', 'wiki/research/anthropic-ipo-deep-dive/revenue-and-costs.md']);
    const middle = await view();
    expect(middle.pages.map((p) => p.trust)).toEqual(['trusted', 'trusted']);
    expect(middle.reportTrust).toBe('trusted');
    expect(middle.tiers.pages).toEqual({ trusted: 3, quarantined: 0, unindexed: 0 });
    expect(middle.tiers.sources).toEqual(before.tiers.sources);
    // a second click changes nothing and says so
    const again = await (await promote({ what: 'pages' })).json() as Promotion;
    expect(again).toMatchObject({ changed: [], count: 0 });
    expect(again.unchanged).toHaveLength(3);
    const sources = await (await promote({ what: 'sources' })).json() as Promotion;
    expect(sources.changed).toHaveLength(before.tiers.sources.quarantined);
    expect(sources.changed.every((p) => p.startsWith('raw/docs/research/anthropic-ipo-deep-dive/'))).toBe(true);
    expect((await view()).tiers.sources).toMatchObject({ quarantined: 0, trusted: before.tiers.sources.trusted + before.tiers.sources.quarantined });
    expect((await promote({ what: 'everything' })).status).toBe(400);
    expect((await promote({ what: 'pages', to: 'public' })).status).toBe(400);
  });
});
