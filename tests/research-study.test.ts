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
import { checkCharts, parseChart, timelineDate } from '../src/research/chart.js';
import { RunPause } from '../src/research/failure.js';
import { claimNextJob, getJob, listJobs, NOT_PAUSED, requeueStale, updateJob } from '../src/research/jobs.js';
import { activeSessions, killActiveAgents } from '../src/research/launch.js';
import { localizeNoteHeadings, normalizeBrief, noteHeadings, refineBrief, sourceMarker, sourcesHeading } from '../src/research/refine.js';
import { runResearchJob } from '../src/research/runner.js';
import { continueStudies, createStudy, refineStudy, startProblem, startStudy, studyPause, studyPayload, studyView, updateStudy } from '../src/research/study.js';
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

  const check = (o: Record<string, unknown>) => parseChart(JSON.stringify({ title: 'T', source: 'raw/docs/x.md', ...o }));

  it('reads market shares, and warns when percentages lose a part', () => {
    const shares = { type: 'share', unit: '%', x: ['2024', '2025'], series: [{ name: 'Samsung', values: [41, 34.1] }, { name: 'SK hynix', values: [34.5, 36.5] }, { name: 'Micron', values: [21.5, 23.5] }, { name: 'Others', values: [3, 5.9] }] };
    expect(check(shares)).toMatchObject({ errors: [], warnings: [] });
    const short = check({ ...shares, series: shares.series.slice(0, 3) });
    expect(short.errors).toEqual([]);
    expect(short.warnings[0]).toMatch(/the 2024 shares add up to 97%, not 100 — add an "Other" series/);
    // amounts are fine (the chart works the shares out); negatives and an empty column are not
    expect(check({ ...shares, unit: 'USD bn', series: shares.series.slice(0, 2) }).warnings).toEqual([]);
    expect(check({ ...shares, unit: 'USD bn', series: shares.series.slice(0, 1) }).warnings).toEqual(['"T": a share chart of one series fills every column — add the others, or draw it as bars']);
    expect(check({ type: 'share', x: ['a', 'b'], series: [{ name: 'A', values: [-1, 0] }, { name: 'B', values: [2, null] }] }).errors).toEqual(['share values must not be negative', 'share: "b" has nothing to share out (every value is empty or zero)']);
  });

  it('takes a scatter as two measures over named points', () => {
    const scatter = { type: 'scatter', x: ['SK hynix', 'Samsung', 'Micron'], series: [{ name: 'Revenue growth, %', values: [48, 22, null] }, { name: 'Forward P/E', values: [7.5, 11.2, 9.8] }] };
    const ok = check(scatter);
    expect(ok.errors).toEqual([]);
    expect(ok.warnings).toEqual(['scatter: 1 of 3 points lack one of the two values and are left out']);
    expect(check({ ...scatter, series: scatter.series.slice(0, 1) }).errors).toEqual(['a scatter takes two series, the horizontal measure first and then the vertical one (1 given)']);
    expect(check({ ...scatter, series: [scatter.series[0], { name: 'P/E', values: [null, 1, 2] }] }).errors).toEqual(['a scatter needs at least two points with both values']);
  });

  it('checks that a waterfall\'s steps add up to its levels', () => {
    const walk = { type: 'waterfall', unit: 'pp', x: ['Q2', 'Price', 'Mix', 'Cost', 'Q3'], series: [{ name: 'Gross margin', values: [38.5, 6.2, 2.1, -1.4, 45.4] }] };
    expect(check(walk)).toMatchObject({ errors: [], warnings: [] });
    // one decimal each: four values carry 0.2 of rounding between them, no more
    expect(check({ ...walk, series: [{ name: 'Gross margin', values: [38.5, 6.2, 2.1, -1.4, 45.6] }] }).warnings).toEqual([]);
    expect(check({ ...walk, series: [{ name: 'Gross margin', values: [38.5, 6.2, 2.1, -1.4, 46] }] }).warnings).toEqual(['"T": the steps up to "Q3" add up to 45.4, but that bar says 46']);
    // subtotals by label
    const pnl = check({ type: 'waterfall', x: ['Revenue', 'Costs', 'Gross', 'Opex', 'EBIT'], totals: ['Revenue', 'Gross', 'EBIT'], series: [{ name: 'USD bn', values: [10, -6, 4, -1.5, 2.5] }] });
    expect(pnl).toMatchObject({ errors: [], warnings: [] });
    expect(pnl.spec?.totals).toEqual(['Revenue', 'Gross', 'EBIT']);
    expect(check({ ...walk, totals: ['Q2', 'Q4'] }).errors).toEqual(['totals names "Q4", which is not one of the x labels']);
    expect(check({ ...walk, series: [{ name: 'A', values: [1, null, 2, 3, 6] }] }).errors).toEqual(['a waterfall has no gaps — every bar is a level or a change (value 2 is null)']);
    expect(check({ ...walk, series: [...walk.series, walk.series[0]] }).errors).toEqual(['a waterfall takes one series, its steps (2 given)']);
  });

  it('reads a timeline\'s values as dates and keeps them as written', () => {
    const hbm = { type: 'timeline', x: ['HBM3E', 'HBM4', 'HBM4E'], series: [{ name: 'SK hynix', values: ['2024-03', 'Q4 2025', 2027] }, { name: 'Samsung', values: ['2024-Q4', '2026-h1', null] }] };
    const ok = check(hbm);
    expect(ok).toMatchObject({ errors: [], warnings: [] });
    expect(ok.spec?.series.map((s) => s.values)).toEqual([['2024-03', '2025-Q4', 2027], ['2024-Q4', '2026-H1', null]]);
    expect(timelineDate('2025-Q4')).toEqual({ at: 2025.75, text: '2025-Q4' });
    expect(timelineDate('2026-H2')).toEqual({ at: 2026.5, text: '2026-H2' });
    for (const bad of ['Mar 2024', '2026-13', '2026-H3', 1850, true]) expect(timelineDate(bad), String(bad)).toBeUndefined();
    expect(check({ ...hbm, series: [{ name: 'Micron', values: ['2024-02', 'next year', null] }] }).errors).toEqual([
      'series "Micron": a timeline\'s values are dates — a year (2025), "2025-03", "2025-Q4", "2026-H1" — or null',
    ]);
    expect(check({ ...hbm, series: [{ name: 'Micron', values: ['2026', '2025-Q2', null] }] }).warnings[0]).toMatch(/Micron reaches "HBM4" \(2025-Q2\) before "HBM3E" \(2026\)/);
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
    expect(collectPrompt).not.toContain('### 图表'); // collectors write notes, not charts
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
      // the chart types, the newer ones too: a workspace's seeded templates may predate them
      expect(brief).toContain('### 图表（```chart 块）');
      for (const type of ['- share：', '- scatter：', '- waterfall：', '- timeline：']) expect(brief).toContain(type);
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

  it('exports the finished study as one HTML file: the report, then the pages, figures numbered', async () => {
    const res = await app.request(`/api/research/studies/${studyId}/export`, { headers });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe(`inline; filename="anthropic-ipo-deep-dive.html"; filename*=UTF-8''anthropic-ipo-deep-dive.html`);
    expect(res.headers.get('content-security-policy')).toMatch(/^sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; style-src 'unsafe-inline'/);
    const html = await res.text();
    expect(html.startsWith('<!doctype html>\n<html lang="en">')).toBe(true);
    expect(html).toContain('<title>Anthropic IPO deep dive</title>');
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;;`);
    // self-contained and inert: styles inline, no script, nothing fetched
    expect(html).not.toMatch(/<script|<link |<iframe| on[a-z]+=|javascript:/i);
    expect(html).toContain('@media print');
    // the report first, then the pages in the brief's order
    const order = ['wiki/research/anthropic-ipo-deep-dive.md', 'wiki/research/anthropic-ipo-deep-dive/revenue-and-costs.md', 'wiki/research/anthropic-ipo-deep-dive/competitors.md'].map((p) => html.indexOf(`<code>${p}</code>`));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('<nav class="toc" aria-labelledby="toc-title"><h2 id="toc-title">Contents</h2><ol><li><a href="#d0">');
    expect(html).toContain('<a href="#d1-2">Revenue model</a>');
    // a figure per chart, numbered through the file, drawn as SVG with its source under it
    expect(html.match(/<figure class="kchart kchart-bar" data-kchart="bar" id="fig-\d+">/g)).toHaveLength(3);
    expect(html).toContain('<figcaption class="kchart-head"><span class="kchart-num">Figure 1</span><span class="kchart-title">Revenue by year</span></figcaption>');
    expect(html).toContain('<svg class="kchart-svg"');
    expect(html).not.toContain('class="kc-hits"');
    expect(html).toMatch(/<p class="kchart-source"><span class="kchart-label">Source<\/span> raw\/docs\/research\/anthropic-ipo-deep-dive\//);
    expect(html).toContain('<li><a href="#fig-3">Figure 3</a> Revenue by year');
    // what was captured, numbered, and how much of it a person has reviewed: nothing yet
    expect(html.match(/<li id="src-\d+">/g)).toHaveLength(3);
    expect(html).toContain('3 of the 3 documents are not reviewed');
    // a capture the text cites as a path links to its entry there
    const report = path.join(wsDir, 'wiki/research/anthropic-ipo-deep-dive.md');
    const written = fs.readFileSync(report, 'utf8');
    const { captures } = await studyView(ctx, (await getJob(ctx.store, studyId))!);
    try {
      fs.writeFileSync(report, `${written}\nAs filed (Source: \`${captures[1].path}#e-1\`).\n`);
      const cited = await (await app.request(`/api/research/studies/${studyId}/export`, { headers })).text();
      expect(cited).toContain(`<a class="path-link" href="#src-2" title="${captures[1].path}#e-1"><code>…/${captures[1].path.split('/').slice(-2).join('/')}#e-1</code></a>`);
      expect(cited).toContain(`<li id="src-2"><span class="src-title">`);
    } finally {
      fs.writeFileSync(report, written);
    }

    // a link opened in a tab names its workspace in the query, as an original's does; ?download=1 saves it
    const linked = await app.request(`/api/research/studies/${studyId}/export?user=admin&kind=personal&id=default&name=Default&download=1`);
    expect(linked.status).toBe(200);
    expect(linked.headers.get('content-disposition')).toMatch(/^attachment; filename="anthropic-ipo-deep-dive.html"/);
    expect((await app.request('/api/research/studies/r_0000000000/export', { headers })).status).toBe(404);
    const draft = await createStudy(ctx, { topic: 'A study that has written nothing yet, to export.', refine: false, runner: { agent: 'fake' } });
    const empty = await app.request(`/api/research/studies/${draft.id}/export`, { headers });
    expect(empty.status).toBe(409);
    expect(((await empty.json()) as { error: string }).error).toMatch(/nothing to export yet/);
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

describe('a study export', () => {
  it('makes a page\'s links work inside the file, and leaves out what has nowhere to go', async () => {
    const draft = await createStudy(ctx, { topic: '内存芯片行业：份额、估值与 HBM 路线图。', refine: false, runner: { agent: 'fake' } });
    const brief = normalizeBrief({
      title: '内存芯片行业', language: 'zh', objective: '看清三家内存厂的份额、估值与 HBM 节奏。',
      pages: [{ id: 'p1', title: '市场份额', slug: 'share', sections: ['## 份额'] }, { id: 'p2', title: 'HBM 路线图', slug: 'hbm', sections: ['## 路线图'] }],
      questions: [{ id: 'q1', text: '谁的份额在涨？', page: 'p1' }, { id: 'q2', text: '谁先量产 HBM4？', page: 'p2' }],
    }, { topic: 'x', maxPages: 4 });
    const job = await updateStudy(ctx, draft.id, { brief });
    const slug = job.target!;
    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(wsDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(wsDir, rel), text);
    };
    const share = JSON.stringify({ type: 'share', title: 'DRAM 份额', unit: '%', x: ['2024', '2025'], series: [{ name: '三星', values: [41, 34] }, { name: 'SK 海力士', values: [35, 37] }, { name: '其他', values: [24, 29] }], source: 'raw/docs/research/x/files/trendforce.pdf' });
    write(`wiki/research/${slug}/share.md`, `---\ntitle: 市场份额\n---\n# 市场份额\n\n## 份额\n\n海力士领先[^a]，见 [[research/${slug}/hbm|HBM 路线图]] 与 [[research/${slug}|总报告]]，也见 [[entities/samsung|三星]]（来源：\`raw/docs/research/${slug}/web/a.html#p3\`；\`raw/docs/other.md\`）。\n\n| 厂商 | 份额 |\n| --- | ---: |\n| 三星 | 34% |\n\n[官网](https://example.com/a) · [内部](../notes.md) · ![图](local.png)\n\n\`\`\`chart\n${share}\n\`\`\`\n\n[^a]: TrendForce 2025 年数据。\n`);
    // the report is not written yet; the export still carries the page, and says what is missing
    const { exportStudy } = await import('../src/research/export.js');
    const { html, figures, documents } = await exportStudy(ctx, job, new Date('2026-10-28T09:30:00Z'));
    expect({ figures, documents }).toEqual({ figures: 1, documents: 1 });
    expect(html.startsWith('<!doctype html>\n<html lang="zh">')).toBe(true);
    expect(html).toContain('<h2 id="toc-title">目录</h2>');
    expect(html).toContain('<p class="notice">尚未写成：');
    expect(html).toContain('导出于');
    expect(html).toContain('2026-10-28 09:30 UTC');
    // the study's own pages land inside the file; a page not exported, and any other note, read as text
    expect(html).toContain('<span class="wikilink">HBM 路线图</span>');
    expect(html).toContain('<span class="wikilink">总报告</span>');
    expect(html).toContain('<span class="wikilink">三星</span>');
    // a path not among the captures is shown whole; footnotes link both ways inside the document
    expect(html).toContain(`<code title="raw/docs/other.md">raw/docs/other.md</code>`);
    expect(html).toContain('<sup class="fn-ref" id="d0-fnref-1"><a href="#d0-fn-1" title="TrendForce 2025 年数据。">[1]</a></sup>');
    expect(html).toContain('<li class="fn" id="d0-fn-1"><span class="fn-num">[1]</span>');
    expect(html).toContain('<a href="#d0-fnref-1" class="fn-back">↩</a>');
    // the web opens in a tab; a workspace-relative link or picture has nothing to point at here
    expect(html).toContain('<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">官网</a>');
    expect(html).toContain('<span class="link">内部</span>');
    expect(html).toContain('<span class="image-missing">[图]</span>');
    expect(html).toContain('<td align="right">34%</td>');
    expect(html).toContain('<figcaption class="kchart-head"><span class="kchart-num">图 1</span><span class="kchart-title">DRAM 份额</span></figcaption>');
    expect(html).toContain('<span class="kchart-label">来源</span> raw/docs/research/x/files/trendforce.pdf');
    expect(html).not.toMatch(/data-wikilink|data-fn=|href="#"[ >]/);

    // once the second page and the report exist, the links between them land on them
    write(`wiki/research/${slug}/hbm.md`, `# HBM 路线图\n\n## 路线图\n\n回到 [[research/${slug}/share|份额]]。\n`);
    write(`wiki/research/${slug}.md`, `# 总报告\n\n## 结论\n\n见 [[research/${slug}/hbm]]。\n`);
    const full = (await exportStudy(ctx, job)).html;
    expect(full.indexOf('<article class="doc" id="d0">')).toBeLessThan(full.indexOf('<code>wiki/research/'));
    expect(full).toContain(`<code>wiki/research/${slug}.md</code>`);
    expect(full).toContain('<a class="wikilink" href="#d2">hbm</a>');
    expect(full).toContain('<a class="wikilink" href="#d1">份额</a>');
    expect(full).toContain('<a class="wikilink" href="#d2">HBM 路线图</a>');
    expect(full).not.toContain('尚未写成');
  });
});

describe('a study the agent could not finish', () => {
  const twoPages = (title: string, seed?: string) => normalizeBrief({
    title, language: 'en', objective: 'Check that a failed run picks up where it stopped.',
    pages: [{ id: 'p1', title: 'First page', slug: 'first', sections: ['## Numbers'] }, { id: 'p2', title: 'Second page', slug: 'second', sections: ['## More'] }],
    questions: [{ id: 'q1', text: 'What are the numbers?', page: 'p1' }, { id: 'q2', text: 'What else?', page: 'p2' }],
    seedUrls: seed ? [{ url: seed, why: 'a seed' }] : [],
  }, { topic: 'x', maxPages: 4 });
  const retry = (id: string) => app.request(`/api/research/studies/${id}/retry`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'x-knode-csrf': '1' }, body: '{}' });

  const post = (url: string) => app.request(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'x-knode-csrf': '1' }, body: '{}' });
  const fakeKey = `claude-cli:${fakeClaude}`;
  /** The wall clock in Shanghai at an instant, as the limit message names its reset. */
  const shanghai = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  const claimable = async (id: string) => (await ctx.store.query(`SELECT id FROM research_jobs WHERE id = $1 AND status = 'queued' AND ${NOT_PAUSED}`, [id])).length > 0;
  const withMode = async <T,>(mode: string, match: string | null, fn: () => Promise<T>): Promise<T> => {
    process.env.FAKE_AGENT_MODE = mode;
    if (match) process.env.FAKE_AGENT_LIMIT_MATCH = match;
    try {
      return await fn();
    } finally {
      delete process.env.FAKE_AGENT_MODE;
      delete process.env.FAKE_AGENT_LIMIT_MATCH;
    }
  };

  it('waits at collect when the collectors hit the usage limit, until the reset the agent named, and collects on resume', async () => {
    const draft = await createStudy(ctx, { topic: 'A study whose collectors all ran out of usage.', refine: false, runner: { agent: 'fake' }, sources: { web: true } });
    const job = await updateStudy(ctx, draft.id, { brief: twoPages('Usage limit', `${webBase}/limit-seed`) });
    await startStudy(ctx, draft.id);
    const paused = await withMode('limit', null, async () => runResearchJob(ctx, (await getJob(ctx.store, draft.id))!, { mcp, log: () => {} }));
    // not failed: queued again, the attempt handed back, until 1:30 in Shanghai and a margin
    expect(paused.status).toBe('queued');
    expect(paused.attempts).toBe(0);
    expect(paused.error).toMatch(/^claude: You've hit your 5-hour limit/);
    const pause = paused.payload.pause as RunPause;
    expect(pause).toMatchObject({ kind: 'quota', resetKnown: true, agent: fakeKey, count: 1 });
    expect(shanghai(pause.until)).toBe('01:32');
    expect(Date.parse(pause.until)).toBeGreaterThan(Date.now());
    expect(await claimable(draft.id)).toBe(false);
    const p = studyPayload(paused);
    expect(p.stage).toBe('collect');
    expect(p.steps.find((s) => s.name === 'seed')?.status).toBe('done');
    expect(p.steps.find((s) => s.name === 'collect')).toMatchObject({ status: 'paused', detail: expect.stringMatching(/^0\/2 page\(s\) collected; 2 waiting — claude: You've hit/) });
    // the error is the CLI's, and no note of it was kept
    expect(fs.existsSync(path.join(wsDir, 'raw/docs/research', job.target!, 'notes'))).toBe(false);
    expect(await listJobs(ctx.store, { study: draft.id })).toHaveLength(0);
    expect((await studyPause(ctx, paused))?.until).toBe(pause.until);

    // the person knows the limit is lifted: resume runs it now; the seed is not fetched again
    const res = await post(`/api/research/studies/${draft.id}/resume`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { resumed: number }).resumed).toBe(1);
    expect(await claimable(draft.id)).toBe(true);
    // the limit it waited on is no error any more
    expect((await getJob(ctx.store, draft.id))!.error).toBeNull();
    const collected = await runResearchJob(ctx, (await getJob(ctx.store, draft.id))!, { mcp, log: () => {} });
    expect(collected.status).toBe('waiting');
    expect(studyPayload(collected).notes).toHaveLength(2);
    expect(collected.payload.pause).toBeUndefined();
    expect((await post(`/api/research/studies/${draft.id}/resume`)).status).toBe(400);
  });

  it('keeps what one collector gathered when another hits the limit, and collects only the rest on resume; the agent\'s queue waits with it', async () => {
    const draft = await createStudy(ctx, { topic: 'A study one of whose collectors ran out of usage.', refine: false, runner: { agent: 'fake' }, sources: { web: false } });
    const job = await updateStudy(ctx, draft.id, { brief: twoPages('Half collected') });
    await startStudy(ctx, draft.id);
    // another study, queued on the same agent: it would only fail the same way, so it waits too
    const other = await createStudy(ctx, { topic: 'A study queued behind the one that ran out.', refine: false, runner: { agent: 'fake' }, sources: { web: false } });
    await updateStudy(ctx, other.id, { brief: twoPages('Queued behind') });
    await startStudy(ctx, other.id);
    const paused = await withMode('limit', '收集资料：「Second page」', async () => runResearchJob(ctx, (await getJob(ctx.store, draft.id))!, { mcp, log: () => {} }));
    expect(paused.status).toBe('queued');
    const p = studyPayload(paused);
    expect(p.steps.find((s) => s.name === 'collect')?.detail).toMatch(/^1\/2 page\(s\) collected; 1 waiting/);
    const notesDir = path.join(wsDir, 'raw/docs/research', job.target!, 'notes');
    expect(fs.readdirSync(notesDir)).toEqual(['01-first.md']);
    const firstNote = fs.statSync(path.join(notesDir, '01-first.md')).mtimeMs;
    const queuedBehind = (await getJob(ctx.store, other.id))!;
    expect(queuedBehind.status).toBe('queued');
    expect((queuedBehind.payload.pause as RunPause).until).toBe((paused.payload.pause as RunPause).until);
    expect(await claimable(other.id)).toBe(false);

    await post(`/api/research/studies/${draft.id}/resume`);
    const prompts: string[] = [];
    const collected = await runResearchJob(ctx, (await getJob(ctx.store, draft.id))!, { mcp, log: (m) => prompts.push(m) });
    expect(collected.status).toBe('waiting');
    expect(prompts.some((m) => /1\/2 page\(s\) collected before/.test(m))).toBe(true);
    expect(fs.readdirSync(notesDir).sort()).toEqual(['01-first.md', '02-second.md']);
    // the first page was not collected again
    expect(fs.statSync(path.join(notesDir, '01-first.md')).mtimeMs).toBe(firstNote);
    expect(studyPayload(collected).collect.map((ph) => ph.label).sort()).toEqual(['collect-1', 'collect-2']);
    // the study queued behind it is the person's to resume (or waits out its own pause)
    expect(await claimable(other.id)).toBe(false);
    expect((await post(`/api/research/studies/${other.id}/cancel`)).status).toBe(200);
  });

  it('pauses a page that hit the limit with its attempts and brief untouched, and the study waits on it', async () => {
    const draft = await createStudy(ctx, { topic: 'A study whose page ran out of usage.', refine: false, runner: { agent: 'fake' }, sources: { web: false } });
    await updateStudy(ctx, draft.id, { brief: twoPages('Page limit') });
    await startStudy(ctx, draft.id);
    await runResearchJob(ctx, (await getJob(ctx.store, draft.id))!, { mcp, log: () => {} });
    const [second, first] = await listJobs(ctx.store, { study: draft.id });
    const claimed = (await updateJob(ctx.store, first.id, { status: 'running', attempts: 1 }))!;
    const paused = await withMode('limit', null, () => runResearchJob(ctx, claimed, { mcp, log: () => {} }));
    expect(paused.status).toBe('queued');
    expect(paused.attempts).toBe(0);
    // a usage limit is no reason to change the page: nothing is added to the brief's rejections
    expect(paused.payload.rejections ?? []).toEqual([]);
    expect((paused.payload.pause as RunPause).kind).toBe('quota');
    // its sibling waits with it, and so does the study
    expect(((await getJob(ctx.store, second.id))!.payload.pause as RunPause | undefined)?.until).toBe((paused.payload.pause as RunPause).until);
    const study = (await getJob(ctx.store, draft.id))!;
    expect((await studyPause(ctx, study))?.kind).toBe('quota');
    const list = await (await app.request('/api/research/studies?limit=200', { headers })).json() as { id: string; pause: RunPause | null }[];
    expect(list.find((r) => r.id === draft.id)?.pause?.kind).toBe('quota');
    const view = await (await app.request(`/api/research/studies/${draft.id}`, { headers })).json() as { pause: RunPause | null; pages: { job: string; pause: RunPause | null }[] };
    expect(view.pause?.kind).toBe('quota');
    expect(view.pages.find((pg) => pg.job === first.id)?.pause?.kind).toBe('quota');
    // resume clears both pages
    expect(((await (await post(`/api/research/studies/${draft.id}/resume`)).json()) as { resumed: number }).resumed).toBe(2);
    expect(await claimable(first.id)).toBe(true);
    expect(await claimable(second.id)).toBe(true);
    await post(`/api/research/studies/${draft.id}/cancel`);
  });

  it('hands a run a restart stopped back to the queue with its attempt, whether serve stopped it or crashed', async () => {
    const draft = await createStudy(ctx, { topic: 'A study whose page a restart stopped.', refine: false, runner: { agent: 'fake' }, sources: { web: false } });
    await updateStudy(ctx, draft.id, { brief: twoPages('Restarted') });
    await startStudy(ctx, draft.id);
    await runResearchJob(ctx, (await getJob(ctx.store, draft.id))!, { mcp, log: () => {} });
    const [second, first] = await listJobs(ctx.store, { study: draft.id });
    const claimed = (await updateJob(ctx.store, first.id, { status: 'running', attempts: 1 }))!;
    const stopped = await withMode('slow', null, async () => {
      const run = runResearchJob(ctx, claimed, { mcp, log: () => {} });
      const t0 = Date.now();
      while (activeSessions(first.id) === 0 && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 50));
      expect(killActiveAgents()).toBe(1);
      return run;
    });
    expect(stopped.status).toBe('queued');
    expect(stopped.attempts).toBe(0);
    expect(stopped.error).toBeNull();
    expect(stopped.payload.rejections ?? []).toEqual([]);

    // a crash leaves the job running: the next start queues it with its attempt handed back, three times at most
    await updateJob(ctx.store, second.id, { status: 'running', attempts: 2 });
    expect(await requeueStale(ctx.store)).toBeGreaterThanOrEqual(1);
    const requeued = (await getJob(ctx.store, second.id))!;
    expect(requeued).toMatchObject({ status: 'queued', attempts: 1 });
    expect(requeued.payload.interruptions).toBe(1);
    await updateJob(ctx.store, second.id, { status: 'running', attempts: 2, payload: { ...requeued.payload, interruptions: 3 } });
    await requeueStale(ctx.store);
    expect((await getJob(ctx.store, second.id))!.attempts).toBe(2);
    await post(`/api/research/studies/${draft.id}/cancel`);
  });

  it('archives a finished study out of the list and back, and removes a failed one but not what it wrote', async () => {
    const draft = await createStudy(ctx, { topic: 'A study to archive and one to remove.', refine: false, runner: { agent: 'fake' }, sources: { web: false } });
    await updateStudy(ctx, draft.id, { brief: twoPages('Archived') });
    await startStudy(ctx, draft.id);
    const collected = await runResearchJob(ctx, (await getJob(ctx.store, draft.id))!, { mcp, log: () => {} });
    const titles = async (q = '') => ((await (await app.request(`/api/research/studies?limit=200${q}`, { headers })).json()) as { id: string; archivedAt: string | null }[]);
    // a study under way is not archived, nor removed
    expect((await post(`/api/research/studies/${draft.id}/archive`)).status).toBe(400);
    expect((await app.request(`/api/research/studies/${draft.id}`, { method: 'DELETE', headers: { ...headers, 'x-knode-csrf': '1' } })).status).toBe(400);

    const children = await listJobs(ctx.store, { study: draft.id });
    for (const c of children) await updateJob(ctx.store, c.id, { status: 'done', finishedAt: new Date().toISOString() });
    await updateJob(ctx.store, draft.id, { status: 'done', finishedAt: new Date().toISOString(), payload: { ...collected.payload, stage: 'done' } });
    const archived = await post(`/api/research/studies/${draft.id}/archive`);
    expect(archived.status).toBe(200);
    expect(((await archived.json()) as { archivedAt: string | null }).archivedAt).toBeTruthy();
    expect((await titles()).some((r) => r.id === draft.id)).toBe(false);
    expect((await titles('&archived=1')).find((r) => r.id === draft.id)?.archivedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    // its pages' jobs go with it, out of the jobs list too
    const jobs = (await (await app.request('/api/research/jobs?limit=500', { headers })).json()) as { id: string }[];
    expect(jobs.some((j) => children.some((c) => c.id === j.id))).toBe(false);
    expect((await post(`/api/research/jobs/${children[0].id}/archive`)).status).toBe(400);
    expect((await post(`/api/research/studies/${draft.id}/unarchive`)).status).toBe(200);
    expect((await titles()).some((r) => r.id === draft.id)).toBe(true);

    // a failed study goes, with its jobs and run logs; its notes stay in the knowledge base
    const failed = await createStudy(ctx, { topic: 'A study that failed and is removed.', refine: false, runner: { agent: 'fake' }, sources: { web: false } });
    const fj = await updateStudy(ctx, failed.id, { brief: twoPages('Removed') });
    await startStudy(ctx, failed.id);
    const fc = await runResearchJob(ctx, (await getJob(ctx.store, failed.id))!, { mcp, log: () => {} });
    const pages = await listJobs(ctx.store, { study: failed.id });
    await updateJob(ctx.store, pages[0].id, { status: 'failed', error: 'x' });
    await updateJob(ctx.store, failed.id, { status: 'failed', error: 'x', payload: { ...fc.payload } });
    const runs = path.join(wsDir, '.runs');
    expect(fs.existsSync(path.join(runs, `${failed.id}-collect`))).toBe(true);
    const del = await app.request(`/api/research/studies/${failed.id}`, { method: 'DELETE', headers: { ...headers, 'x-knode-csrf': '1' } });
    expect(del.status).toBe(200);
    const body = (await del.json()) as { removed: string[]; kept: string[] };
    expect(body.removed.sort()).toEqual([failed.id, ...pages.map((pg) => pg.id)].sort());
    expect(body.kept).toContain(`raw/docs/research/${fj.target}`);
    expect(await getJob(ctx.store, failed.id)).toBeNull();
    for (const pg of pages) expect(await getJob(ctx.store, pg.id)).toBeNull();
    expect(fs.existsSync(path.join(runs, `${failed.id}-collect`))).toBe(false);
    expect(fs.readdirSync(path.join(wsDir, 'raw/docs/research', fj.target!, 'notes'))).toHaveLength(2);
  });

  it('sends a study whose report failed with a page missing back to its pages, so the report is written last', async () => {
    const draft = await createStudy(ctx, { topic: 'A study whose report failed with a page missing.', refine: false, runner: { agent: 'fake' }, sources: { web: false } });
    await updateStudy(ctx, draft.id, { brief: twoPages('Report retry') });
    await startStudy(ctx, draft.id);
    const collected = await runResearchJob(ctx, (await getJob(ctx.store, draft.id))!, { mcp, log: () => {} });
    expect(collected.status).toBe('waiting');
    const [written, missing] = await listJobs(ctx.store, { study: draft.id });
    // the night the usage ran out: one page written, the other and then the report failed
    await updateJob(ctx.store, written.id, { status: 'done' });
    await updateJob(ctx.store, missing.id, { status: 'failed', error: 'claude: limit', attempts: 2, payload: { ...missing.payload, rejections: ['claude: limit', 'claude: limit'] } });
    await updateJob(ctx.store, draft.id, { status: 'failed', error: 'claude: limit', payload: { ...collected.payload, stage: 'report' } });

    expect((await retry(draft.id)).status).toBe(200);
    const waiting = (await getJob(ctx.store, draft.id))!;
    expect(waiting.status).toBe('waiting');
    const p = studyPayload(waiting);
    expect(p.stage).toBe('pages');
    expect(p.steps.find((s) => s.name === 'pages')).toEqual({ name: 'pages', status: 'running', detail: '1/2 page(s) written' });
    expect(p.steps.find((s) => s.name === 'report')?.status).toBe('pending');
    const page = (await getJob(ctx.store, missing.id))!;
    expect(page.status).toBe('queued');
    expect(page.attempts).toBe(0);
    expect(page.payload.rejections).toEqual([]);
    expect((await getJob(ctx.store, written.id))!.status).toBe('done');
    // the report waits for the page, and is queued once the page is written
    expect(await continueStudies(ctx)).toBe(0);
    await updateJob(ctx.store, missing.id, { status: 'done' });
    expect(await continueStudies(ctx)).toBe(1);
    const report = (await getJob(ctx.store, draft.id))!;
    expect(report.status).toBe('queued');
    expect(studyPayload(report).stage).toBe('report');
  });
});
