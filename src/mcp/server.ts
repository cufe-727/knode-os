import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AppContext } from '../context.js';
import { mcpInstructions } from './instructions.js';
import { registerKnodeTools } from './tools.js';

export const MCP_SERVER_INFO = { name: 'knode-os', version: '0.2.0' } as const;

/**
 * MCP server over stdio. Register with:
 *   Claude Code:  claude mcp add knode-os -- knode-os mcp --data ~/.knode-os
 *   Codex CLI:    [mcp_servers.knode-os] command = "knode-os", args = ["mcp", "--data", "~/.knode-os"]
 *
 * This process opens the data directory itself, so it should not run beside a
 * `knode-os serve` on the same workspace: on PostgreSQL it would bypass serve's
 * watchers, locks and sign-in, and with the opt-in PGlite index, which is
 * single-process, it must not. Connect to the HTTP endpoint serve mounts
 * instead (`knode-os connect <client> --http`).
 */
export async function startMcpServer(ctx: AppContext): Promise<void> {
  const server = new McpServer(MCP_SERVER_INFO, { instructions: mcpInstructions(ctx.dataDir) });
  registerKnodeTools(server, ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[knode-os] MCP server ready (stdio), data: ${ctx.dataDir}`);
}
