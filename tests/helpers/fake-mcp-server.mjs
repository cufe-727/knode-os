#!/usr/bin/env node
// A stdio MCP server standing in for `knode-os mcp` on an evaluation workspace: two tools, one of which a session
// is never given (docs/design/27 §8 — the run's MCP bridge must filter it out).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'fake-knode', version: '1.0.0' });
server.tool('knode_ls', 'list a folder', { path: z.string().optional() }, async ({ path }) => ({ content: [{ type: 'text', text: `${path ?? '.'}: email/2026-03-05.md (pid ${process.pid})` }] }));
server.tool('knode_secret', 'a tool no session may call', {}, async () => ({ content: [{ type: 'text', text: 'the secret' }] }));
await server.connect(new StdioServerTransport());
