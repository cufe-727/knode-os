import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { AppContext } from '../context.js';
import { mountMcp } from '../server/mcp-http.js';

/**
 * One build's knode tools for every agent session that answers on it
 * (docs/design/31 D4): served by the run itself over loopback Streamable HTTP,
 * on the index the run already holds open — the same endpoint `serve` mounts
 * at /mcp (src/server/mcp-http.ts), in single-context mode.
 *
 * Before, each session started its own `knode-os mcp` child on the index, so
 * the run closed its context first and the sessions went one at a time: two
 * processes on one embedded PGlite directory do not work. Here only the run
 * opens the index, and sessions are as wide as the run's session slots.
 *
 * The sessions get the same tool listing and server instructions a stdio
 * `knode-os mcp` gives (its tools, narrowed to `tools`, as Codex's
 * `enabled_tools` narrowed them), as an agent (`caller: 'agent'`, no review
 * of quarantined writes) and without hit tracking, so answers leave the index
 * as built (D3). A local session connects by URL with the bearer token in its
 * environment (`mcp_servers.knode.url`, `bearer_token_env_var`); a remote
 * one through `serve`'s lease-bound proxy, which presents the same secret.
 */

export interface ToolHost {
  /** http://127.0.0.1:<port>/mcp */
  url: string;
  /** The bearer token: per host, never on a command line or in a record. */
  secret: string;
  tools: string[];
  close(): Promise<void>;
}

/** The env var a local session's Codex reads the host's token from (the remote worker uses the same name). */
export const AGENT_MCP_TOKEN_ENV = 'KNODE_EVAL_MCP_TOKEN';

export async function startToolHost(context: () => Promise<AppContext>, tools: string[]): Promise<ToolHost> {
  if (!tools.length) throw new Error('a tool host serves named tools only');
  const secret = crypto.randomBytes(24).toString('base64url');
  const app = new Hono();
  mountMcp(app, { path: '/mcp', token: secret, context, tools: { caller: 'agent', only: new Set(tools), track: false } });
  return listen(app, secret, tools);
}

/**
 * Tools of the run's own over the same kind of endpoint (docs/design/33 §2:
 * arm B's `search` over the RAG index): `register` adds them to a fresh MCP
 * server for each request, stateless as `serve`'s /mcp is, behind the same
 * per-host bearer secret. A remote session reaches it through `serve`'s
 * lease-bound proxy exactly as it reaches knode's (src/remote/api.ts), which
 * passes only the calls of the tools named here.
 */
export async function startServedTools(info: { name: string; version: string; instructions?: string }, tools: string[], register: (server: McpServer) => void): Promise<ToolHost> {
  if (!tools.length) throw new Error('a tool host serves named tools only');
  const secret = crypto.randomBytes(24).toString('base64url');
  const app = new Hono();
  app.all('/mcp', async (c) => {
    if (!tokenMatches(bearerOf(c.req.raw), secret)) return c.json({ error: 'mcp: missing or invalid bearer token' }, 401);
    const server = new McpServer({ name: info.name, version: info.version }, info.instructions ? { instructions: info.instructions } : {});
    register(server);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close().catch(() => {});
    }
  });
  return listen(app, secret, tools);
}

function bearerOf(req: Request): string | null {
  const auth = req.headers.get('authorization');
  return auth && /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, '').trim() : null;
}

function tokenMatches(presented: string | null, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function listen(app: Hono, secret: string, tools: string[]): Promise<ToolHost> {
  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve(s as Server)) as Server;
  });
  // a session's tool call runs as long as it runs (the agent's own timeout bounds it); the host never keeps a process alive
  server.requestTimeout = 0;
  server.unref();
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    secret,
    tools: [...tools],
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
