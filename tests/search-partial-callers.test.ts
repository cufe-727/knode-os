import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AppContext, createContext } from '../src/context.js';
import { registerKnodeTools } from '../src/mcp/tools.js';
import { MCP_SERVER_INFO } from '../src/mcp/server.js';
import { search } from '../src/search/search.js';
import { createApp, SEARCH_PARTIAL_HEADER } from '../src/server/app.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';
import { VECTOR_TYPE } from '../src/store/db.js';
import { resolveScopeFilter } from '../src/store/resolver.js';

/**
 * A search whose vector channel came back short says so to whoever called
 * it: `search()` (the results carry `partial`), the `knode_search` tool (a
 * second block beside the results) and `GET /api/search` (a response
 * header). An agent can then tell "semantic recall stopped early" from
 * "nothing there". Nothing a reader of the results already reads changes
 * shape.
 *
 * The workspace holds one folder, 3,100 chunks: more than a narrowed search
 * reads on an index this size (3,000), so it is walked for — and here the
 * statements that walk the index are answered with no row, as a walk that
 * ends at its limit short of the folder is.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-partial-callers-'));
const root = path.join(tmp, 'data');
const headers = {
  'x-knode-user': 'admin',
  'x-knode-workspace-kind': 'personal',
  'x-knode-workspace-id': 'default',
  'x-knode-workspace-name': 'Default',
};

let rootCtx: AppContext;
let registry: WorkspaceContextRegistry;
let app: ReturnType<typeof createApp>;
let ctx: AppContext;
let client: Client;
let server: McpServer;
/** Set to answer the statements that walk the vector index with no row. */
let walksFindNothing = true;

beforeAll(async () => {
  rootCtx = await createContext(root);
  registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
  app = createApp(rootCtx, () => {}, registry);
  await app.request('/api/workspaces', { headers: { 'x-knode-user': 'admin' } });
  ctx = await registry.get({ user: 'admin', kind: 'personal', id: 'default', name: 'Default', slug: 'default', relativeDir: 'users/admin/workspaces/default' });
  const store = ctx.store;
  await store.indexing;
  const dim = ctx.embedder.dimensions;
  const [{ indexdef }] = await store.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'embeddings_hnsw_idx'`);
  await store.query(`DROP INDEX embeddings_hnsw_idx`);
  await store.query(
    `INSERT INTO documents (id, path, root, kind, title, sha256, bytes, status)
     SELECT 'd-f' || i, 'raw/docs/far/f' || i || '.md', 'docs', 'source', 'f' || i, 'sha-f' || i, 10, 'indexed' FROM generate_series(1, 3100) i`,
  );
  await store.query(
    `INSERT INTO chunks (id, document_id, seq, content, token_count, tsv)
     SELECT 'f' || i, 'd-f' || i, 0, 'ledger entry ' || i, 3, to_tsvector('simple', 'ledger entry') FROM generate_series(1, 3100) i`,
  );
  await store.query(
    `INSERT INTO embeddings (chunk_id, model, embedding)
     SELECT 'f' || i, $1, ('[' || (1 + (hashtext('a' || i) % 1000) / 3333.0) || ',' || ((hashtext('b' || i) % 1000) / 3333.0) || repeat(',0', $2::int - 2) || ']')::${VECTOR_TYPE}
     FROM generate_series(1, 3100) i`,
    [ctx.embedder.model, dim],
  );
  await store.query(indexdef);
  await store.query(`ANALYZE`);
  const query = store.query.bind(store);
  store.query = ((sql: string, params?: unknown[]) =>
    (walksFindNothing && sql.includes('ORDER BY e.embedding <=>') ? Promise.resolve([]) : query(sql, params))) as typeof store.query;

  server = new McpServer(MCP_SERVER_INFO);
  registerKnodeTools(server, ctx);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'local', version: '0' });
  await client.connect(clientSide);
}, 120_000);

afterAll(async () => {
  await client?.close();
  await server?.close();
  await registry.closeAll();
  await rootCtx.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const folder = resolveScopeFilter({ sources: ['raw/docs/far'] });

describe('a search whose vector channel came back short', () => {
  it('says so on the results `search()` returns, in every mode that asks the channel', async () => {
    const vector = await search(ctx.store, ctx.embedder, 'ledger entry', { k: 8, mode: 'vector', track: false, filter: folder });
    expect(vector).toEqual([]);
    expect(vector.partial).toMatch(/the walk of the vector index ended at its limit of 2000 rows with 0 of the 24 sources asked for/);
    // the other channels answer, and the mark stays
    for (const mode of ['hybrid', 'sag'] as const) {
      const results = await search(ctx.store, ctx.embedder, 'ledger entry', { k: 8, mode, track: false, filter: folder });
      expect(results, mode).toHaveLength(8);
      expect(results.partial, mode).toMatch(/ended at its limit/);
      // a reader of the results reads what it read: an array of them, and the mark is no part of its JSON
      expect(Array.isArray(results)).toBe(true);
      expect(JSON.parse(JSON.stringify(results))).toHaveLength(8);
    }
    // the keyword channel is never the one cut short
    expect((await search(ctx.store, ctx.embedder, 'ledger entry', { k: 8, mode: 'keyword', track: false, filter: folder })).partial).toBeUndefined();
  });

  it('says so in a header of GET /api/search, beside the same array', async () => {
    const res = await app.request(`/api/search?q=${encodeURIComponent('ledger entry')}&sources=raw/docs/far`, { headers });
    expect(res.status).toBe(200);
    expect(res.headers.get(SEARCH_PARTIAL_HEADER)).toMatch(/ended at its limit of 2000 rows with 0 of the 24 sources asked for/);
    const body = await res.json() as { path: string }[];
    expect(body).toHaveLength(8);
    expect(body.every((r) => r.path.startsWith('raw/docs/far/'))).toBe(true);
  });

  it('says so in a second block of knode_search, after the results', async () => {
    const res = await client.callTool({ name: 'knode_search', arguments: { query: 'ledger entry', sources: ['raw/docs/far'] } });
    const blocks = res.content as { type: string; text: string }[];
    expect(blocks).toHaveLength(2);
    expect(JSON.parse(blocks[0].text)).toHaveLength(8);
    expect(JSON.parse(blocks[1].text)).toEqual({ partial: expect.stringMatching(/ended at its limit of 2000 rows with 0 of the 24 sources asked for/) });
  });

  it('says nothing where the channel returned what it was asked for', async () => {
    walksFindNothing = false;
    try {
      const results = await search(ctx.store, ctx.embedder, 'ledger entry', { k: 8, mode: 'hybrid', track: false, filter: folder });
      expect(results).toHaveLength(8);
      expect(results.partial).toBeUndefined();
      const res = await app.request(`/api/search?q=${encodeURIComponent('ledger entry')}&sources=raw/docs/far`, { headers });
      expect(res.headers.get(SEARCH_PARTIAL_HEADER)).toBeNull();
      expect(await res.json()).toHaveLength(8);
      const tool = await client.callTool({ name: 'knode_search', arguments: { query: 'ledger entry', sources: ['raw/docs/far'] } });
      expect(tool.content as unknown[]).toHaveLength(1);
    } finally {
      walksFindNothing = true;
    }
  });
});

describe('GET /api/search with a k that is not a number of results', () => {
  it('answers with the eight it answers with when none is given, not with a statement the server refuses', async () => {
    const count = async (k: string) => {
      const res = await app.request(`/api/search?q=${encodeURIComponent('ledger entry')}&mode=keyword&k=${k}`, { headers });
      expect(res.status, `k=${k}`).toBe(200);
      return (await res.json() as unknown[]).length;
    };
    // `k=abc` became NaN, and `LIMIT NaN`
    expect(await count('abc')).toBe(8);
    expect(await count('')).toBe(8);
    expect(await count('0')).toBe(8);
    expect(await count('-3')).toBe(8);
    expect(await count('3')).toBe(3);
    expect(await count('3.7')).toBe(3);
  });

  it('holds for any caller of search()', async () => {
    for (const k of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      expect(await search(ctx.store, ctx.embedder, 'ledger entry', { k, mode: 'keyword', track: false }), String(k)).toHaveLength(8);
    }
    expect(await search(ctx.store, ctx.embedder, 'ledger entry', { k: 2.9, mode: 'keyword', track: false })).toHaveLength(2);
  });
});
