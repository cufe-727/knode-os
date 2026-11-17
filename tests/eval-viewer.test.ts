import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { createEmbeddingProvider } from '../src/ingest/embeddings.js';
import { buildFixturePack } from '../src/eval/packs/fixture.js';
import { evalRootDir, readEvalManifest, runWorkspaceDir, updateEvaluation, writeEvalManifest } from '../src/eval/root.js';
import { runEval } from '../src/eval/run.js';
import { createApp, EVALUATION_READ_ONLY, viewerRefuses } from '../src/server/app.js';
import { VIEWER_TOOLS } from '../src/server/evaluation.js';
import { MCP_TOKEN_FILE } from '../src/server/mcp-http.js';
import { assertViewerListeners } from '../src/server/serve.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';
import { ScriptedBackend, scriptedJudge } from './helpers/eval-scripted.js';
import { tableDigest } from './helpers/table-digest.js';

/*
 * docs/design/35 stage 2: `serve` on an evaluation root is a viewer. It lists
 * every build to every account, grouped by run; it opens one read-only and
 * serves its reading pages; it refuses every write with 409; its /mcp has the
 * reading tools only; and a build looked at is the same build afterwards —
 * every table's rows and the workspace's files. A build its run still holds
 * on PGlite is listed and not opened.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-viewer-'));
const packDir = path.join(tmp, 'packs', 'fixture-life');
const runDir = path.join(tmp, 'runs', 'viewed');
const root = evalRootDir();
const embedder = createEmbeddingProvider({ provider: 'local', baseUrl: '', apiKey: '', model: '', dimensions: 384, batchSize: 64, sendDimensions: false });

let rootCtx: AppContext;
let registry: WorkspaceContextRegistry;
let app: ReturnType<typeof createApp>;
let ws: string;
let id: string;
let holder: ChildProcess | null = null;

/** Every file of the workspace (its embedded database and lock aside) with a hash of its bytes. */
function filesOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (r === '.knode/db' || r === '.knode/db.lock') continue;
      if (e.isDirectory()) walk(r);
      else out[r] = crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, r))).digest('hex');
    }
  };
  walk('');
  return out;
}

async function digest(dir: string) {
  const ctx = await createContext(dir, { readOnly: true });
  try {
    return await tableDigest(ctx.store);
  } finally {
    await ctx.store.close();
  }
}

const headers = (workspace: string, user = 'anyone') => ({ 'x-knode-user': user, 'x-knode-workspace-kind': 'personal', 'x-knode-workspace-id': workspace, 'x-knode-workspace-name': workspace });

beforeAll(async () => {
  buildFixturePack(packDir);
  await runEval({
    packs: [packDir], systems: ['knode-ask'], runDir, quota: false, suites: ['usage'], skipScoring: true,
    overrides: { chat: new ScriptedBackend(), judge: scriptedJudge(), embedder },
  });
  ws = runWorkspaceDir(runDir, 'fixture-life');
  id = path.basename(ws);
  rootCtx = await createContext(root);
  // sign-in off for the test: the routes are what is under test, not the accounts
  rootCtx.config.server.auth = { ...rootCtx.config.server.auth!, enabled: false };
  registry = new WorkspaceContextRegistry(root, { templateConfig: () => rootCtx.config, evaluation: { owner: 'eval' } });
  app = createApp(rootCtx, () => {}, registry, { evaluation: true });
}, 300_000);

afterAll(async () => {
  holder?.kill();
  await registry?.closeAll();
  await rootCtx?.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the evaluation viewer', () => {
  it('serves every reading page of a build and leaves it as it was, rows and files', async () => {
    const tablesBefore = await digest(ws);
    const filesBefore = filesOf(ws);
    const h = headers(id);

    // listed to any account, with what built it
    const listed = await (await app.request('/api/workspaces', { headers: { 'x-knode-user': 'someone-else' } })).json() as { id: string; evaluation: Record<string, unknown> }[];
    expect(listed.map((w) => w.id)).toEqual([id]);
    expect(listed[0].evaluation).toMatchObject({ run: runDir, pack: 'fixture-life', state: 'built', batchesApplied: [], openable: true, index: { kind: 'pglite' } });
    expect(listed[0].evaluation.bytes).toBeGreaterThan(0);

    const get = async (url: string) => {
      const res = await app.request(url, { headers: h });
      expect(res.status, `${url}: ${res.status} ${res.status === 200 ? '' : await res.clone().text()}`).toBe(200);
      return res.json() as Promise<unknown>;
    };
    const tree = await get('/api/tree?path=raw/docs') as unknown;
    expect(JSON.stringify(tree)).toContain('email');
    const doc = await get('/api/file?path=raw/docs/email/2026-03-05.md') as { content: string };
    expect(doc.content).toContain('林晓');
    await get('/api/file?path=wiki/index.md');
    // hybrid search: keyword and graph answer, the vector channel says it has no model here
    const hits = await get(`/api/search?q=${encodeURIComponent('林晓')}&mode=hybrid`) as unknown[];
    expect(hits.length).toBeGreaterThan(0);
    expect((await get(`/api/search?q=${encodeURIComponent('澜舟科技')}&mode=keyword`) as unknown[]).length).toBeGreaterThan(0);
    await get(`/api/graph?q=${encodeURIComponent('林晓')}`);
    await get('/api/graph');
    await get('/api/claims');
    await get(`/api/claims?subject=${encodeURIComponent('林晓')}`);
    await get('/api/entities');
    await get('/api/documents');
    await get('/api/stats');
    await get('/api/survey');
    await get('/api/suggestions');
    await get('/api/disputes');
    await get(`/api/search/suggest?q=${encodeURIComponent('林')}`);
    const mentions = await app.request('/api/entities/mentions', { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ text: '林晓入职澜舟科技' }) });
    expect(mentions.status).toBe(200);

    // every route that changes something answers 409, before the build is opened
    const writing = app.routes.filter((r) => r.path.startsWith('/api/') && !r.path.startsWith('/api/auth/') && viewerRefuses(r.method, r.path.replace(/:[a-z]+/gi, 'x')));
    expect(writing.length).toBeGreaterThan(60);
    for (const r of writing) {
      const method = r.method === 'ALL' ? 'POST' : r.method;
      const res = await app.request(r.path.replace(/:[a-z]+/gi, 'x'), { method, headers: { ...h, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
      expect(res.status, `${method} ${r.path}`).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe(EVALUATION_READ_ONLY);
    }
    for (const [method, url] of [['PUT', '/api/file'], ['POST', '/api/sync'], ['POST', '/api/ask'], ['DELETE', '/api/workspace'], ['POST', '/api/workspaces'], ['PUT', '/api/config'], ['POST', '/api/labeling/start']] as const) {
      expect((await app.request(url, { method, headers: { ...h, 'content-type': 'application/json' }, body: '{}' })).status, `${method} ${url}`).toBe(409);
    }

    // /mcp: the reading tools only, and they record nothing
    const token = fs.readFileSync(path.join(root, MCP_TOKEN_FILE), 'utf8').trim();
    let server: Server | null = null;
    const base = await new Promise<string>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve(`http://127.0.0.1:${info.port}`)) as Server;
    });
    const client = new Client({ name: 'test', version: '0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}`, ...h } } }));
      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(tools).toEqual([...VIEWER_TOOLS].sort());
      const found = await client.callTool({ name: 'knode_search', arguments: { query: '林晓', mode: 'keyword' } });
      expect(found.isError).toBeFalsy();
      await client.callTool({ name: 'knode_resolve', arguments: { query: '林晓' } });
      const refused = await client.callTool({ name: 'knode_disputes', arguments: { action: 'resolve', id: 'x' } });
      expect(JSON.stringify(refused.content)).toMatch(/read-only/);
    } finally {
      await client.close();
      await new Promise<void>((r) => server!.close(() => r()));
    }

    // looked at, searched, listed: the same build
    await registry.closeAll();
    expect(filesOf(ws)).toEqual(filesBefore);
    expect(await digest(ws)).toEqual(tablesBefore);
  }, 180_000);

  it('lists and does not open a build its run still holds on PGlite, or one still building', async () => {
    await registry.closeAll();
    // a live process stands in for the run that holds it
    holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    const manifest = readEvalManifest(ws)!;
    try {
      updateEvaluation(ws, (e) => ({ ...e, writer: { pid: holder!.pid!, since: new Date().toISOString() } }));
      const listed = await (await app.request('/api/workspaces', { headers: { 'x-knode-user': 'anyone' } })).json() as { evaluation: { openable: boolean; why: string; heldBy: { pid: number } } }[];
      expect(listed[0].evaluation).toMatchObject({ openable: false, heldBy: { pid: holder.pid } });
      expect(listed[0].evaluation.why).toMatch(/held by the run .* one opener at a time/);
      const res = await app.request('/api/stats', { headers: headers(id) });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/is not opened: held by the run/);
      // nothing opened it: the run's open would find the index free
      expect(fs.existsSync(path.join(ws, '.knode', 'db.lock'))).toBe(false);

      // a writer that is gone is stale: listed as openable, and the viewer does not write the manifest to say so
      holder.kill();
      await new Promise((r) => holder!.once('exit', r));
      const stale = fs.readFileSync(path.join(ws, '.workspace.json'), 'utf8');
      const after = await (await app.request('/api/workspaces', { headers: { 'x-knode-user': 'anyone' } })).json() as { evaluation: { openable: boolean } }[];
      expect(after[0].evaluation.openable).toBe(true);
      expect(fs.readFileSync(path.join(ws, '.workspace.json'), 'utf8')).toBe(stale);

      updateEvaluation(ws, (e) => ({ ...e, state: 'building' }));
      const building = await (await app.request('/api/workspaces', { headers: { 'x-knode-user': 'anyone' } })).json() as { evaluation: { openable: boolean; why: string } }[];
      expect(building[0].evaluation).toMatchObject({ openable: false });
      expect(building[0].evaluation.why).toMatch(/still being built/);
      expect((await app.request('/api/stats', { headers: headers(id) })).status).toBe(409);
    } finally {
      writeEvalManifest(ws, manifest);
    }
  });

  it('listens on loopback only, without HTTPS', () => {
    expect(() => assertViewerListeners({ ...rootCtx.config.server, host: '0.0.0.0' })).toThrow(/loopback only/);
    expect(() => assertViewerListeners({ ...rootCtx.config.server, tls: { port: 1, cert: 'c', key: 'k' } as never })).toThrow(/no HTTPS/);
    expect(() => assertViewerListeners({ ...rootCtx.config.server, host: '127.0.0.1', tls: null })).not.toThrow();
  });
});
