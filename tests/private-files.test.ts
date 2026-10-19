import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { defaultConfig, redactConfig } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { isPrivatePath, isWritablePath } from '../src/fs/files.js';
import { MCP_SERVER_INFO } from '../src/mcp/server.js';
import { registerKnodeTools } from '../src/mcp/tools.js';
import { createApp } from '../src/server/app.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';

/**
 * A workspace's config holds literal API keys, and its dot-entries hold the
 * index, tokens and agent run workspaces. None of it is a file the file API,
 * grep or MCP hands out — to a member or anyone else; Settings reads the
 * config through the redacted GET /api/config.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-private-files-'));
const root = path.join(tmp, 'data');
const workspaceDir = path.join(root, 'users', 'alice', 'workspaces', 'default');
const SECRET = 'sk-literal-secret-0123456789';

const headers = {
  'x-knode-user': 'alice',
  'x-knode-workspace-kind': 'personal',
  'x-knode-workspace-id': 'default',
  'x-knode-workspace-name': 'Default',
};
const jsonHeaders = { ...headers, 'content-type': 'application/json' };

let rootCtx: AppContext;
let registry: WorkspaceContextRegistry;
let app: ReturnType<typeof createApp>;
let mcp: Client;
let mcpServer: McpServer;

const call = async (name: string, args: Record<string, unknown>) => {
  const res = await mcp.callTool({ name, arguments: args });
  return { isError: Boolean(res.isError), text: JSON.stringify(res.content) };
};

beforeAll(async () => {
  rootCtx = await createContext(root);
  // the root config carries a literal key, and every workspace gets a copy of it
  rootCtx.config.connections = [{ ...rootCtx.config.llm, id: 'main', label: 'main', apiKey: SECRET }];
  registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
  app = createApp(rootCtx, () => {}, registry);
  await app.request('/api/workspaces', { headers: { 'x-knode-user': 'alice' } });
  expect(fs.readFileSync(path.join(workspaceDir, 'knode.config.json'), 'utf8')).toContain(SECRET);

  fs.mkdirSync(path.join(workspaceDir, '.runs', 'job1'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.runs', 'job1', '.mcp.json'), JSON.stringify({ token: SECRET }));
  fs.writeFileSync(path.join(workspaceDir, '.runs', 'job1', 'brief.md'), `# brief ${SECRET}\n`);
  fs.mkdirSync(path.join(workspaceDir, '.sidecar', 'raw', 'docs', 'r.pdf'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.sidecar', 'raw', 'docs', 'r.pdf', 'content.md'), '# derived text\n');

  const ctx = await registry.get({ user: 'alice', kind: 'personal', id: 'default', name: 'Default', slug: 'default', relativeDir: 'users/alice/workspaces/default' });
  mcpServer = new McpServer(MCP_SERVER_INFO);
  registerKnodeTools(mcpServer, ctx);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverSide);
  mcp = new Client({ name: 'test', version: '0' });
  await mcp.connect(clientSide);
});

afterAll(async () => {
  await mcp.close();
  await mcpServer.close();
  await registry.closeAll();
  await rootCtx.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const SPELLINGS = [
  'knode.config.json',
  'Knode.Config.JSON',
  './knode.config.json',
  'wiki/../knode.config.json',
  '/knode.config.json',
  '.knode/mcp-token',
  '.KNODE/db',
  '.runs/job1/.mcp.json',
  '.runs/job1/brief.md',
  'raw/../.runs/job1/brief.md',
  '.workspace.json',
];

describe('which paths are private', () => {
  it('is the config, however it is spelled, and every dot-entry but the sidecar tree', () => {
    for (const p of SPELLINGS) expect(isPrivatePath(p), p).toBe(true);
    for (const p of ['wiki/index.md', 'raw/docs/a.md', 'purpose.md', 'ledger/events.jsonl', '.sidecar/raw/docs/r.pdf/content.md', 'raw/docs/knode.config.json']) {
      expect(isPrivatePath(p), p).toBe(false);
    }
    expect(isPrivatePath('.sidecar/raw/docs/.hidden/content.md')).toBe(true);
    expect(isWritablePath('wiki/.obsidian/workspace.json')).toBe(false);
    expect(isWritablePath('wiki/page.md')).toBe(true);
  });
});

describe('the REST file API', () => {
  it('refuses to read the config or private state, however the path is spelled', async () => {
    for (const p of SPELLINGS) {
      const res = await app.request(`/api/file?path=${encodeURIComponent(p)}`, { headers });
      expect(res.status, p).toBe(403);
      expect(await res.text(), p).not.toContain(SECRET);
    }
    // derived Markdown in the sidecar stays readable
    const derived = await app.request(`/api/file?path=${encodeURIComponent('.sidecar/raw/docs/r.pdf/content.md')}`, { headers });
    expect(derived.status).toBe(200);
  });

  it('does not list the config, or list a private folder', async () => {
    const tree = await (await app.request('/api/tree', { headers })).json() as { children: { name: string }[] };
    expect(tree.children.map((c) => c.name)).not.toContain('knode.config.json');
    expect(tree.children.map((c) => c.name)).toContain('wiki');
    expect((await app.request('/api/tree?path=.knode', { headers })).status).toBe(400);
    expect((await app.request('/api/tree?path=.runs', { headers })).status).toBe(400);
    expect((await app.request('/api/okf/validate?path=.runs', { headers })).status).toBe(400);
  });

  it('does not grep the config, from the root or by name', async () => {
    for (const q of ['', '&path=.', '&path=knode.config.json', '&path=.runs']) {
      const res = await app.request(`/api/grep?pattern=${encodeURIComponent(SECRET)}${q}`, { headers });
      expect(res.status).toBe(200);
      expect(await res.json(), q).toEqual([]);
    }
  });

  it('refuses to write, move or delete it', async () => {
    const put = await app.request('/api/file', { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ path: 'knode.config.json', content: '{}' }) });
    expect(put.status).toBe(400);
    const putDot = await app.request('/api/file', { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ path: '.knode/x', content: 'x' }) });
    expect(putDot.status).toBe(400);
    const moveOut = await app.request('/api/mv', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ from: 'knode.config.json', to: 'wiki/config.json' }) });
    expect(moveOut.status).toBe(400);
    const moveIn = await app.request('/api/mv', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ from: 'wiki/index.md', to: 'knode.config.json' }) });
    expect(moveIn.status).toBe(400);
    expect((await app.request('/api/file?path=knode.config.json', { method: 'DELETE', headers })).status).toBe(400);
    expect(fs.readFileSync(path.join(workspaceDir, 'knode.config.json'), 'utf8')).toContain(SECRET);
  });

  it('still answers the config through Settings, with its keys redacted', async () => {
    const res = await app.request('/api/config', { headers });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(text).toContain('"apiKey":"***"');
  });
});

describe('MCP', () => {
  it('refuses knode_read, knode_ls and knode_okf_validate on private paths', async () => {
    for (const p of SPELLINGS) {
      const res = await call('knode_read', { path: p });
      expect(res.isError, p).toBe(true);
      expect(res.text, p).not.toContain(SECRET);
    }
    expect((await call('knode_ls', { path: '.knode' })).isError).toBe(true);
    expect((await call('knode_ls', { path: '.runs/job1' })).isError).toBe(true);
    expect((await call('knode_ls', {})).text).not.toContain('knode.config.json');
    expect((await call('knode_okf_validate', { path: '.runs' })).isError).toBe(true);
    // the derived Markdown agents are told to read is still there
    const derived = await call('knode_read', { path: '.sidecar/raw/docs/r.pdf/content.md' });
    expect(derived.isError).toBe(false);
    expect(derived.text).toContain('derived text');
  });

  it('greps around the config', async () => {
    for (const args of [{ pattern: SECRET }, { pattern: SECRET, path: 'knode.config.json' }, { pattern: SECRET, path: '.runs' }]) {
      const res = await call('knode_grep', args);
      expect(res.isError).toBe(false);
      expect(res.text).not.toContain(SECRET);
    }
  });

  it('refuses knode_write over the config or into private state', async () => {
    for (const p of ['knode.config.json', 'Knode.Config.json', '.knode/accounts.json', '.runs/job1/.mcp.json', 'wiki/../knode.config.json']) {
      expect((await call('knode_write', { path: p, content: '{}' })).isError, p).toBe(true);
    }
    expect(fs.readFileSync(path.join(workspaceDir, 'knode.config.json'), 'utf8')).toContain(SECRET);
  });
});

describe('GET /api/config redaction', () => {
  it('masks datasource headers, credentials in a datasource URL and plugin options', () => {
    const config = defaultConfig();
    config.datasources = [{
      id: 'api', kind: 'http-json', baseUrl: 'https://user:hunter2@api.example/v1',
      headers: { Authorization: `Bearer ${SECRET}`, 'X-Key': 'env:API_KEY', Accept: '' },
    }];
    config.plugins = [{ module: './plugins/x.mjs', options: { token: SECRET, region: 'eu', fromEnv: 'env:X_TOKEN' } }];
    const redacted = JSON.stringify(redactConfig(config));
    expect(redacted).not.toContain(SECRET);
    expect(redacted).not.toContain('hunter2');
    const ds = redactConfig(config).datasources[0];
    expect(ds.headers).toEqual({ Authorization: '***', 'X-Key': 'env:API_KEY', Accept: '' });
    expect(ds.baseUrl).toBe('https://user:***@api.example/v1');
    expect(redactConfig(config).plugins?.[0].options).toEqual({ token: '***', region: '***', fromEnv: 'env:X_TOKEN' });
  });
});
