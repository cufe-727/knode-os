import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { createApp } from '../src/server/app.js';
import { listNotices, Notice } from '../src/server/notices.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';

/**
 * Notices: what the file tree no longer shows (lint reports, datasource
 * problems) and what no folder shows (trace collection waiting, an unwritten
 * purpose, a wiki never initialized), as data the clients word themselves.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-notices-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Only what listNotices reads: the data dir, the trace and datasource config, and two index lookups. */
function fakeCtx(dataDir: string, opts: { docs?: boolean; datasources?: number } = {}): AppContext {
  return {
    dataDir,
    config: {
      datasources: Array.from({ length: opts.datasources ?? 0 }, (_, i) => ({ id: `db${i}`, kind: 'mysql' })),
      trace: { claudeProjectsDir: path.join(tmp, 'claude'), codexSessionsDir: path.join(tmp, 'codex'), skillDirs: [], syncIntervalMinutes: 10 },
    },
    store: {
      query: async (sql: string) => (sql.includes('FROM documents') ? [{ any: Boolean(opts.docs) }] : []),
    },
  } as unknown as AppContext;
}

const ids = (notices: Notice[]) => notices.map((n) => n.id);
const lintReport = (date: string, pages: number, findings: number, kinds: string) =>
  `---\ntitle: Wiki lint ${date}\ntype: lint\n---\n\n# Wiki lint — ${date}\n\n> ${pages} pages · ${findings} findings: ${kinds} · 9 links to 4 entities without a page\n`;

describe('notices', () => {
  it('ask for a purpose, and for trace collection only when there is something to collect', async () => {
    const dataDir = path.join(tmp, 'fresh');
    initDataDir(dataDir);
    write(dataDir, '.knode/trace-sync-since', '2026-10-06T20:25:21.449Z\n');
    expect(ids(await listNotices(fakeCtx(dataDir)))).toEqual(['purpose']);

    write(tmp, 'claude/-Users-me-proj/session-1.jsonl', '{"type":"user"}\n');
    write(tmp, 'codex/2026/10/27/rollout.jsonl', '{"type":"session_meta"}\n{"type":"message"}\n');
    write(tmp, 'codex/2026/10/27/empty.jsonl', '');
    const traces = (await listNotices(fakeCtx(dataDir))).find((n) => n.id === 'traces-off');
    expect(traces).toMatchObject({ id: 'traces-off', sessions: 2 });
    expect(traces && 'bytes' in traces && traces.bytes).toBeGreaterThan(30);

    // collecting lifts the pause, and with it the notice
    fs.rmSync(path.join(dataDir, '.knode/trace-sync-since'));
    expect(ids(await listNotices(fakeCtx(dataDir)))).not.toContain('traces-off');

    write(dataDir, 'purpose.md', '# Purpose\n\nFollow the traders whose posts rookie-trade exports.\n');
    expect(ids(await listNotices(fakeCtx(dataDir)))).not.toContain('purpose');
  });

  it('offer initialization once documents are in, until the overview and the guide exist', async () => {
    const dataDir = path.join(tmp, 'init');
    initDataDir(dataDir);
    expect(ids(await listNotices(fakeCtx(dataDir)))).not.toContain('initialize');
    expect((await listNotices(fakeCtx(dataDir, { docs: true }))).find((n) => n.id === 'initialize')).toMatchObject({ overview: false, guide: false });

    write(dataDir, 'wiki/overview.md', '---\ntype: overview\n---\n\n# Overview\n\nTrader posts, daily reviews and backtests.\n');
    write(dataDir, 'AGENTS.md', '# Guide\n\nSearch with knode_resolve first.\n');
    expect(ids(await listNotices(fakeCtx(dataDir, { docs: true })))).not.toContain('initialize');
  });

  it('summarize the newest lint report against the one before it', async () => {
    const dataDir = path.join(tmp, 'lint');
    initDataDir(dataDir);
    write(dataDir, 'wiki/lint/2026-10-26.md', lintReport('2026-10-26', 5672, 18912, 'broken_link 18860, stale_research 52'));
    write(dataDir, 'wiki/lint/2026-10-27.md', lintReport('2026-10-27', 5679, 18510, 'orphan 1, broken_link 18447, stale_research 59, open_dispute 3'));
    write(dataDir, 'wiki/lint/notes.md', 'not a report\n');
    const lint = (await listNotices(fakeCtx(dataDir))).find((n) => n.id === 'lint');
    expect(lint).toEqual({
      id: 'lint',
      key: '2026-10-27',
      level: 'info',
      report: 'wiki/lint/2026-10-27.md',
      date: '2026-10-27',
      summary: { pages: 5679, findings: 18510, counts: { orphan: 1, broken_link: 18447, stale_research: 59, open_dispute: 3 } },
      previous: { date: '2026-10-26', summary: { pages: 5672, findings: 18912, counts: { broken_link: 18860, stale_research: 52 } } },
    });

    write(dataDir, 'wiki/lint/2026-10-28.md', lintReport('2026-10-28', 5680, 0, 'none'));
    expect(ids(await listNotices(fakeCtx(dataDir)))).not.toContain('lint');
  });

  it('warn about datasources the last pass could not read, while any are configured', async () => {
    const dataDir = path.join(tmp, 'datasources');
    initDataDir(dataDir);
    write(dataDir, '.knode/datasources.json', JSON.stringify({ at: '2026-10-28T03:00:00.000Z', sources: 1, errors: ['db0: connect ECONNREFUSED'] }));
    expect((await listNotices(fakeCtx(dataDir, { datasources: 1 }))).find((n) => n.id === 'datasources'))
      .toMatchObject({ level: 'warn', key: '2026-10-28T03:00:00.000Z', errors: ['db0: connect ECONNREFUSED'] });
    // the datasource was removed since: nothing left to warn about
    expect(ids(await listNotices(fakeCtx(dataDir)))).not.toContain('datasources');
    write(dataDir, '.knode/datasources.json', JSON.stringify({ at: '2026-10-28T04:00:00.000Z', sources: 1, errors: [] }));
    expect(ids(await listNotices(fakeCtx(dataDir, { datasources: 1 })))).not.toContain('datasources');
  });
});

describe('GET /api/notices', () => {
  const root = path.join(tmp, 'server');
  const headers = { 'x-knode-user': 'admin', 'x-knode-workspace-kind': 'personal', 'x-knode-workspace-id': 'default', 'x-knode-workspace-name': 'Default' };
  let rootCtx: AppContext;
  let registry: WorkspaceContextRegistry;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    rootCtx = await createContext(root);
    registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
    app = createApp(rootCtx, () => {}, registry);
    await app.request('/api/workspaces', { headers: { 'x-knode-user': 'admin' } });
  });

  afterAll(async () => {
    await registry.closeAll();
    await rootCtx.store.close();
  });

  it("lists the workspace's notices", async () => {
    const res = await app.request('/api/notices', { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notices: Notice[] };
    expect(ids(body.notices)).toContain('purpose');
  });
});
