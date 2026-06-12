import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AppContext } from '../context.js';
import { listTree, readFileText, writeFileText } from '../fs/files.js';
import { graphInsights, graphSearch } from '../graph/query.js';
import { runIngest } from '../ingest/pipeline.js';
import { search } from '../search/search.js';
import { ask } from '../search/ask.js';

/**
 * MCP server over stdio. Register with:
 *   Claude Code:  claude mcp add knode-os -- knode-os mcp --data ~/.knode-os
 *   Codex CLI:    [mcp_servers.knode-os] command = "knode-os", args = ["mcp", "--data", "~/.knode-os"]
 */
export async function startMcpServer(ctx: AppContext): Promise<void> {
  const server = new McpServer({ name: 'knode-os', version: '0.1.0' });
  const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });

  server.registerTool(
    'knode_search',
    {
      title: 'Search the knowledge base',
      description: 'Hybrid search (vector + keyword + graph signals) over docs, wiki, skills. Returns chunks with paths and scores.',
      inputSchema: {
        query: z.string().describe('Natural-language or keyword query'),
        k: z.number().int().min(1).max(50).optional().describe('Max results (default 8)'),
        mode: z.enum(['hybrid', 'vector', 'keyword']).optional(),
      },
    },
    async ({ query, k, mode }) => {
      const results = await search(ctx.store, ctx.embedder, query, { k: k ?? 8, mode: mode ?? 'hybrid' });
      return json(results.map((r) => ({ path: r.path, title: r.title, score: +r.score.toFixed(4), content: r.content })));
    },
  );

  server.registerTool(
    'knode_graph_search',
    {
      title: 'Search the knowledge graph',
      description: 'Find entities matching the query and expand the graph around them (multi-hop). Returns nodes, typed edges and grounding chunks.',
      inputSchema: {
        query: z.string(),
        depth: z.number().int().min(1).max(4).optional().describe('Expansion hops (default 2)'),
      },
    },
    async ({ query, depth }) => json(await graphSearch(ctx.store, query, { depth: depth ?? 2 })),
  );

  server.registerTool(
    'knode_ask',
    {
      title: 'Ask the knowledge base',
      description: 'RAG answer with [n] citations and explicit gaps. Requires llm.model configured; otherwise returns retrieved context.',
      inputSchema: { question: z.string() },
    },
    async ({ question }) => {
      const res = await ask(ctx.store, ctx.config, ctx.embedder, ctx.llm, question);
      return json({ answer: res.answer, citations: res.citations, gaps: res.gaps });
    },
  );

  server.registerTool(
    'knode_ls',
    {
      title: 'List knowledge files',
      description: 'List the data directory tree (raw/docs, raw/traces, raw/skills, wiki).',
      inputSchema: { path: z.string().optional().describe('Subdirectory, e.g. "wiki" (default: root)') },
    },
    async ({ path: p }) => json(listTree(ctx.dataDir, p ?? '.')),
  );

  server.registerTool(
    'knode_read',
    {
      title: 'Read a knowledge file',
      description: 'Read a file by its path relative to the data directory, e.g. "wiki/index.md".',
      inputSchema: { path: z.string() },
    },
    async ({ path: p }) => ({ content: [{ type: 'text' as const, text: readFileText(ctx.dataDir, p) }] }),
  );

  server.registerTool(
    'knode_write',
    {
      title: 'Write a knowledge file',
      description: 'Create or overwrite a file under wiki/ or raw/docs/ (other roots are read-only). New knowledge is indexed on the next ingest.',
      inputSchema: { path: z.string(), content: z.string() },
    },
    async ({ path: p, content }) => {
      if (!/^(wiki|raw\/docs)\//.test(p)) throw new Error('writes are restricted to wiki/ and raw/docs/');
      writeFileText(ctx.dataDir, p, content);
      return json({ ok: true, path: p });
    },
  );

  server.registerTool(
    'knode_ingest',
    {
      title: 'Reindex the knowledge base',
      description: 'Scan docs/wiki/skills, chunk + embed changed files, rewire the graph. Incremental by content hash.',
      inputSchema: {},
    },
    async () => json(await runIngest(ctx.store, ctx.config, ctx.embedder, ctx.llm)),
  );

  server.registerTool(
    'knode_graph_insights',
    {
      title: 'Knowledge graph insights',
      description: 'Graph health: totals, hub entities, isolated entities, type distribution.',
      inputSchema: {},
    },
    async () => json(await graphInsights(ctx.store)),
  );

  server.registerTool(
    'knode_suggestions',
    {
      title: 'Dream suggestions',
      description: 'Pending improvement suggestions from the nightly dream (skills / memory / knowledge gaps).',
      inputSchema: { status: z.enum(['pending', 'accepted', 'rejected']).optional() },
    },
    async ({ status }) =>
      json(await ctx.store.query(
        `SELECT id, kind, title, body, evidence, status, report_path, created_at FROM suggestions WHERE status = $1 ORDER BY created_at DESC LIMIT 50`,
        [status ?? 'pending'],
      )),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[knode-os] MCP server ready (stdio), data: ${ctx.dataDir}`);
}
