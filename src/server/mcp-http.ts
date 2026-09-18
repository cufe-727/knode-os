import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { MCP_SERVER_INFO } from '../mcp/server.js';
import { mcpInstructions } from '../mcp/instructions.js';
import { registerKnodeTools } from '../mcp/tools.js';
import { AppContext } from '../context.js';
import { resolveWorkspaceScope, WorkspaceContextRegistry } from './workspaces.js';

/**
 * MCP over Streamable HTTP, mounted on the same Hono app as the REST API.
 *
 * Why HTTP and not another stdio process: the embedded PGlite index is
 * single-process, so a `knode-os mcp` child launched next to a running `serve`
 * would fight it for the workspace. Hosting the transport inside serve means
 * every agent — the research runner's headless CLI, or an interactive Claude
 * Code / Codex / Cursor session — reads and writes the one live index, with
 * the same workspace isolation the REST routes enforce.
 *
 * Stateless: each request gets a fresh McpServer bound to the request's
 * workspace context (tool registration is a handful of closures), and replies
 * as plain JSON. Nothing here needs server-initiated streams.
 *
 * Auth: a bearer token generated once per data root and kept in
 * `.knode/mcp-token` (0600). Clients that cannot set headers (some CLIs only
 * take a URL) may pass `token` and the workspace fields as query parameters —
 * the endpoint binds to loopback by default, so the URL never leaves the
 * machine.
 */

export const MCP_TOKEN_FILE = '.knode/mcp-token';

/** The data root's MCP bearer token, created on first use. */
export function loadOrCreateMcpToken(rootDataDir: string): string {
  const file = path.join(rootDataDir, MCP_TOKEN_FILE);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // first run
  }
  const token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  return token;
}

export interface MountMcpOptions {
  path: string;
  token: string;
  /** Multi-workspace mode: the request's headers / query pick the workspace. */
  registry?: WorkspaceContextRegistry;
  /** Single-context mode (a CLI run hosting the endpoint for itself): every request hits this context. */
  context?: AppContext;
}

function presentedToken(req: Request): string | null {
  const auth = req.headers.get('authorization');
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  const header = req.headers.get('x-knode-token');
  if (header) return header.trim();
  return new URL(req.url).searchParams.get('token');
}

function tokenMatches(presented: string | null, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Headers first (what Claude Code / Cursor send), query parameters as the fallback for URL-only clients. */
export function mcpWorkspaceHeaders(req: Request): { user?: string; kind?: string; id?: string; name?: string } {
  const q = new URL(req.url).searchParams;
  const pick = (header: string, param: string) => req.headers.get(header) ?? q.get(param) ?? undefined;
  return {
    user: pick('x-knode-user', 'user'),
    kind: pick('x-knode-workspace-kind', 'kind') ?? 'personal',
    id: pick('x-knode-workspace-id', 'id'),
    name: pick('x-knode-workspace-name', 'name'),
  };
}

export function mountMcp(app: Hono<any>, opts: MountMcpOptions): void {
  app.all(opts.path, async (c) => {
    const req = c.req.raw;
    if (!tokenMatches(presentedToken(req), opts.token)) {
      return c.json({ error: 'mcp: missing or invalid bearer token' }, 401);
    }
    let ctx: AppContext;
    if (opts.context) ctx = opts.context;
    else if (opts.registry) {
      try {
        const scope = resolveWorkspaceScope(mcpWorkspaceHeaders(req));
        if (scope.kind === 'personal' && !opts.registry.exists(scope)) {
          return c.json({ error: `workspace "${scope.name}" does not exist` }, 404);
        }
        ctx = await opts.registry.get(scope);
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 401);
      }
    } else {
      return c.json({ error: 'mcp: no workspace registry or context mounted' }, 500);
    }

    // the base's own guide rides along as server instructions (cached by the file's mtime)
    const server = new McpServer(MCP_SERVER_INFO, { instructions: mcpInstructions(ctx.dataDir) });
    registerKnodeTools(server, ctx);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      // JSON responses are complete once handleRequest resolves; nothing streams after this
      void server.close().catch(() => {});
    }
  });
}
