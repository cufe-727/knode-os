import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AppContext, createContext } from '../src/context.js';
import { registerKnodeTools } from '../src/mcp/tools.js';
import { MCP_SERVER_INFO } from '../src/mcp/server.js';
import { createApp } from '../src/server/app.js';
import { MCP_TOKEN_FILE } from '../src/server/mcp-http.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';

/**
 * MCP over Streamable HTTP: the endpoint `serve` mounts must expose exactly
 * the stdio tool set, gate on the data root's bearer token, and bind every
 * request to the workspace named in the headers (or, for URL-only clients,
 * the query string).
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-mcp-http-'));
const root = path.join(tmp, 'data');
const workspaceDir = path.join(root, 'users', 'admin', 'workspaces', 'default');

let rootCtx: AppContext;
let registry: WorkspaceContextRegistry;
let httpServer: Server;
let baseUrl: string;
let token: string;

const workspaceHeaders = {
  'x-knode-user': 'admin',
  'x-knode-workspace-kind': 'personal',
  'x-knode-workspace-id': 'default',
  'x-knode-workspace-name': 'Default',
};

async function connect(headers: Record<string, string>, url = `${baseUrl}/mcp`): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}

beforeAll(async () => {
  rootCtx = await createContext(root);
  registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
  const app = createApp(rootCtx, () => {}, registry);
  await app.request('/api/workspaces', { headers: { 'x-knode-user': 'admin' } }); // creates users/admin/workspaces/default
  token = fs.readFileSync(path.join(root, MCP_TOKEN_FILE), 'utf8').trim();
  await new Promise<void>((resolve) => {
    httpServer = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      baseUrl = `http://127.0.0.1:${info.port}`;
      resolve();
    }) as Server;
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await registry.closeAll();
  await rootCtx.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('POST /mcp', () => {
  it('creates the bearer token once and refuses requests without it', async () => {
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...workspaceHeaders },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }),
    });
    expect(res.status).toBe(401);
  });

  it('exposes the same tools as the stdio server', async () => {
    const client = await connect({ authorization: `Bearer ${token}`, ...workspaceHeaders });
    const http = (await client.listTools()).tools.map((t) => t.name).sort();
    await client.close();

    const server = new McpServer(MCP_SERVER_INFO);
    registerKnodeTools(server, await registry.get({ user: 'admin', kind: 'personal', id: 'default', name: 'Default', slug: 'default', relativeDir: 'users/admin/workspaces/default' }));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const local = new Client({ name: 'local', version: '0' });
    await local.connect(clientSide);
    const stdio = (await local.listTools()).tools.map((t) => t.name).sort();
    await local.close();
    await server.close();

    expect(http).toEqual(stdio);
    expect(http).toEqual(expect.arrayContaining(['knode_search', 'knode_write', 'knode_checkout', 'knode_commit', 'knode_claims']));
  });

  it('writes through knode_write into the request workspace only under writable roots', async () => {
    const client = await connect({ authorization: `Bearer ${token}`, ...workspaceHeaders });
    const ok = await client.callTool({ name: 'knode_write', arguments: { path: 'wiki/notes/hello.md', content: '# Hello\n\nfrom mcp over http\n' } });
    expect(ok.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(workspaceDir, 'wiki', 'notes', 'hello.md'), 'utf8')).toContain('from mcp over http');

    const refused = await client.callTool({ name: 'knode_write', arguments: { path: 'raw/traces/x.md', content: 'nope' } });
    expect(refused.isError).toBe(true);
    expect(fs.existsSync(path.join(workspaceDir, 'raw', 'traces', 'x.md'))).toBe(false);
    await client.close();
  });

  it('accepts the token and workspace as query parameters for URL-only clients', async () => {
    const q = new URLSearchParams({ token, user: 'admin', kind: 'personal', id: 'default' });
    const client = await connect({}, `${baseUrl}/mcp?${q.toString()}`);
    const res = await client.callTool({ name: 'knode_ls', arguments: { path: 'wiki' } });
    expect(res.isError).toBeFalsy();
    expect(JSON.stringify(res.content)).toContain('notes');
    await client.close();
  });

  it('rejects an unknown workspace instead of creating it', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        ...workspaceHeaders,
        'x-knode-workspace-id': 'ghost',
        'x-knode-workspace-name': 'Ghost',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }),
    });
    expect(res.status).toBe(404);
    expect(fs.existsSync(path.join(root, 'users', 'admin', 'workspaces', 'ghost'))).toBe(false);
  });
});
