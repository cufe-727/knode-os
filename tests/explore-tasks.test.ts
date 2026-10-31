import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActivityLog, activityOf } from '../src/activity.js';
import { apiGroupOf } from '../src/auth/apis.js';
import { AppContext, createContext } from '../src/context.js';
import { sync } from '../src/ingest/sync.js';
import { createJobRow } from '../src/research/jobs.js';
import { entityMatch, ExploreResult, SearchSuggestions } from '../src/search/explore.js';
import { createApp } from '../src/server/app.js';
import { nextDaily, TasksSnapshot } from '../src/server/tasks.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';

/**
 * Explore → Search and Tasks → Queue (docs/design/20): the search that says
 * which channel found each passage and which entities the query names, the
 * suggestions a search box offers while someone types, and the one read of
 * everything a workspace has under way.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-explore-tasks-'));
const root = path.join(tmp, 'data');

const headers = {
  'x-knode-user': 'admin',
  'x-knode-workspace-kind': 'personal',
  'x-knode-workspace-id': 'default',
  'x-knode-workspace-name': 'Default',
};
const scope = { user: 'admin', kind: 'personal' as const, id: 'default', name: 'Default', slug: 'default', relativeDir: 'users/admin/workspaces/default' };

let rootCtx: AppContext;
let registry: WorkspaceContextRegistry;
let app: ReturnType<typeof createApp>;
let ws: AppContext;

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

async function get<T>(url: string): Promise<T> {
  const res = await app.request(url, { headers });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

beforeAll(async () => {
  rootCtx = await createContext(root);
  registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
  app = createApp(rootCtx, () => {}, registry);
  await app.request('/api/workspaces', { headers: { 'x-knode-user': 'admin' } });
  ws = await registry.get(scope);

  write(ws.dataDir, 'raw/docs/aurora.md', `---
title: Aurora quarterly
entities:
  - { name: "Aurora Labs", type: organization, aliases: ["AURL"], description: "Maker of solar inverters" }
  - { name: "Borealis", type: organization, description: "A rival of Aurora in inverters" }
  - { name: "Inverter", type: product }
relations:
  - { source: "Aurora Labs", target: "Borealis", type: competes_with }
  - { source: "Aurora Labs", target: "Inverter", type: makes }
---
# Aurora quarterly

[[Aurora Labs]] shipped more inverters this quarter; [[Borealis]] cut prices in response.
`);
  write(ws.dataDir, 'raw/docs/notes/weather.md', '# Weather notes\n\nNothing about companies here, only clouds and rain.\n');
  await sync(ws, { llmGraph: false });
});

afterAll(async () => {
  await registry.closeAll();
  await rootCtx.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('GET /api/search/explore', () => {
  it('ranks passages per channel and names the entities the query matched, with the reason', async () => {
    const r = await get<ExploreResult>(`/api/search/explore?q=${encodeURIComponent('Aurora')}`);
    expect(r.mode).toBe('hybrid');
    expect(r.terms).toContain('Aurora');
    expect(r.passages.length).toBeGreaterThan(0);
    const top = r.passages[0];
    expect(top.path).toBe('raw/docs/aurora.md');
    // every channel that found the passage gave it a rank, and only those
    expect(top.ranks).toBeDefined();
    for (const name of Object.keys(top.signals)) expect(top.ranks?.[name as 'keyword']).toBeGreaterThanOrEqual(1);
    expect(r.channels.keyword?.hits).toBeGreaterThan(0);
    expect(r.channels.graph?.hits).toBeGreaterThan(0);

    const aurora = r.entities.find((e) => e.name === 'Aurora Labs');
    expect(aurora?.match).toEqual({ field: 'name', term: 'Aurora', text: 'Aurora Labs' });
    expect(aurora?.aliases).toContain('AURL');
    // Borealis says "Aurora" in its description: matched, and for that reason
    expect(r.entities.find((e) => e.name === 'Borealis')?.match?.field).toBe('description');
    // matched entities come before those only reached through a relation
    const firstUnmatched = r.entities.findIndex((e) => e.match === null);
    if (firstUnmatched >= 0) expect(r.entities.slice(firstUnmatched).every((e) => e.match === null)).toBe(true);
    expect(r.relations.some((e) => e.type === 'competes_with')).toBe(true);
    expect(r.errors).toEqual({});
  });

  it('does not count as use: the heat that ranks the next search stays where it was', async () => {
    const heat = async () => (await ws.store.query<{ n: number }>(`SELECT coalesce(sum(hit_count), 0)::int AS n FROM doc_stats`))[0].n;
    const before = await heat();
    for (let i = 0; i < 3; i++) await get<ExploreResult>(`/api/search/explore?q=${encodeURIComponent('Aurora')}`);
    expect(await heat()).toBe(before);
    // the agents' own search still records what it returned
    await get(`/api/search?q=${encodeURIComponent('Aurora')}`);
    expect(await heat()).toBeGreaterThan(before);
  });

  it('finds an entity by an alias and says so', async () => {
    const r = await get<ExploreResult>('/api/search/explore?q=AURL');
    expect(r.entities[0]?.name).toBe('Aurora Labs');
    expect(r.entities[0]?.match).toEqual({ field: 'alias', term: 'AURL', text: 'AURL' });
  });

  it('keeps a folder scope and refuses an unknown mode', async () => {
    const r = await get<ExploreResult>(`/api/search/explore?q=${encodeURIComponent('clouds')}&sources=raw/docs/notes`);
    expect(r.passages.every((p) => p.path.startsWith('raw/docs/notes/'))).toBe(true);
    const bad = await app.request('/api/search/explore?q=x&mode=telepathy', { headers });
    expect(bad.status).toBe(400);
    const empty = await app.request('/api/search/explore?q=%20', { headers });
    expect(empty.status).toBe(400);
  });

  it('reads the match field in the order a person reads the reason', () => {
    expect(entityMatch({ name: 'Acme', aliases: ['ACM'], description: 'acme corp' }, ['acme'])).toEqual({ field: 'name', term: 'acme', text: 'Acme' });
    expect(entityMatch({ name: 'Acme', aliases: ['ACM'], description: '' }, ['acm'])).toEqual({ field: 'name', term: 'acm', text: 'Acme' });
    expect(entityMatch({ name: 'X', aliases: ['ACM'], description: '' }, ['acm'])).toEqual({ field: 'alias', term: 'acm', text: 'ACM' });
    expect(entityMatch({ name: 'X', aliases: [], description: 'nothing' }, ['acm'])).toBeNull();
  });
});

describe('GET /api/search/suggest', () => {
  it('offers an exact name first, then names that start with the text, and matching documents', async () => {
    const r = await get<SearchSuggestions>('/api/search/suggest?q=aurora');
    expect(r.entities[0]).toMatchObject({ name: 'Aurora Labs', type: 'organization', alias: null });
    expect(r.documents.map((d) => d.path)).toContain('raw/docs/aurora.md');
    const byAlias = await get<SearchSuggestions>('/api/search/suggest?q=aurl');
    expect(byAlias.entities[0]).toMatchObject({ name: 'Aurora Labs', alias: 'AURL' });
    // a LIKE wildcard is a character, not a pattern
    expect((await get<SearchSuggestions>('/api/search/suggest?q=%25')).entities).toEqual([]);
    expect(await get<SearchSuggestions>('/api/search/suggest?q=')).toEqual({ entities: [], documents: [] });
  });
});

describe('GET /api/tasks', () => {
  it('reports the pipeline, the jobs and the activity of a workspace outside serve', async () => {
    await createJobRow(ws.store, { kind: 'entity', target: 'Aurora Labs', template: 'entity', status: 'queued' });
    const ingest = await app.request('/api/ingest', { method: 'POST', headers });
    expect(ingest.status).toBe(200);

    const t = await get<TasksSnapshot>('/api/tasks');
    expect(t.serving).toBe(false);
    expect(t.processing).toBeNull();
    expect(t.stages.map((s) => s.id)).toEqual(['index', 'embed', 'extract', 'summarize', 'translate', 'review']);
    expect(t.stages.find((s) => s.id === 'index')?.waiting).toBe(0);
    expect(t.inFlight).toEqual([]);
    expect(t.workers).toEqual([]);
    expect(t.jobs).toEqual([expect.objectContaining({ kind: 'research', title: 'Aurora Labs', status: 'queued', stage: 'entity' })]);
    // the index run just now is the latest finished activity
    expect(t.activity.running).toEqual([]);
    expect(t.activity.recent[0]).toMatchObject({ kind: 'ingest', ok: true });
    // without serve nothing runs on a clock here
    expect(t.scheduled.find((s) => s.id === 'dream')).toMatchObject({ next: null });
    expect(t.dream.pendingSuggestions).toBe(0);
  });

  it('belongs to the ingest group, as the labeling status does; explore and suggest to search', () => {
    expect(apiGroupOf('GET', '/api/tasks')).toBe('ingest');
    expect(apiGroupOf('GET', '/api/search/explore')).toBe('search');
    expect(apiGroupOf('GET', '/api/search/suggest')).toBe('search');
  });
});

describe('activity log', () => {
  it('keeps what runs, then what finished, with how it went', async () => {
    const log = new ActivityLog();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const run = log.run('sync', 'Changes to raw/docs', async () => { await held; return 3; }, (n) => `${n} applied`);
    expect(log.busy('sync')).toBe(true);
    expect(log.snapshot().running.map((a) => a.label)).toEqual(['Changes to raw/docs']);
    release();
    await run;
    await expect(log.run('dream', 'Dream', async () => { throw new Error('no model'); })).rejects.toThrow('no model');
    const { running, recent } = log.snapshot();
    expect(running).toEqual([]);
    expect(recent.map((a) => [a.kind, a.ok, a.detail])).toEqual([['dream', false, 'no model'], ['sync', true, '3 applied']]);
    expect(activityOf('/x')).toBe(activityOf('/x'));
  });

  it('finds the next time a daily run comes round', () => {
    const now = new Date(2026, 9, 30, 2, 0, 0);
    expect(new Date(nextDaily('03:10', now)).getHours()).toBe(3);
    expect(new Date(nextDaily('03:10', now)).getDate()).toBe(30);
    expect(new Date(nextDaily('01:00', now)).getDate()).toBe(31);
  });
});
