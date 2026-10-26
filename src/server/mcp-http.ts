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
import { resolveWorkspaceScope, WorkspaceContextRegistry, WorkspaceScope } from './workspaces.js';

/**
 * MCP over Streamable HTTP, mounted on the same Hono app as the REST API.
 *
 * Why HTTP and not another stdio process: a `knode-os mcp` child launched next
 * to a running `serve` would open the workspace's index a second time — on
 * PostgreSQL bypassing serve's watchers, locks and sign-in, and on the opt-in
 * PGlite index, which is single-process, fighting serve for it. Hosting the
 * transport inside serve means every agent — the research runner's headless
 * CLI, or an interactive Claude Code / Codex / Cursor session — reads and
 * writes the one live index, with the same workspace isolation the REST routes
 * enforce.
 *
 * Stateless: each request gets a fresh McpServer bound to the request's
 * workspace context (tool registration is a handful of closures), and replies
 * as plain JSON. Nothing here needs server-initiated streams.
 *
 * Auth, two kinds of bearer token:
 *
 *   - the data root's, generated once and kept in `.knode/mcp-token` (0600):
 *     this machine's own clients (`knode-os connect`), which name the
 *     workspace in headers — with sign-in on, an account that exists and, for
 *     a team, has been given it;
 *   - a workspace's (`McpWorkspaceTokens`), minted by `serve` for the agents
 *     it launches there — research jobs, Ask turns — and held in memory only.
 *     It opens that workspace and no other: headers may repeat it, never pick
 *     another. Its sessions get the tools an agent may use
 *     (registerKnodeTools `caller: 'agent'`).
 *
 * Clients that cannot set headers (some CLIs only take a URL) may pass `token`
 * and the workspace fields as query parameters — the endpoint answers this
 * machine only, so the URL never leaves it.
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

/**
 * The tokens `serve` hands the agents it launches in a workspace: one per open
 * workspace, minted when its services start and revoked when they stop, never
 * written anywhere but the run directories that need them. A leaked one opens
 * the workspace it was made for, and only as an agent.
 */
export class McpWorkspaceTokens {
  private readonly scopes = new Map<string, WorkspaceScope>();

  mint(scope: WorkspaceScope): string {
    const token = `kmw_${crypto.randomBytes(24).toString('base64url')}`;
    this.scopes.set(token, scope);
    return token;
  }

  revoke(token: string): void {
    this.scopes.delete(token);
  }

  /** The workspace a presented token was made for, or null. */
  scopeOf(presented: string | null): WorkspaceScope | null {
    if (!presented) return null;
    for (const [token, scope] of this.scopes) if (tokenMatches(presented, token)) return scope;
    return null;
  }
}

export interface MountMcpOptions {
  path: string;
  /** The data root's token: this machine's own clients. */
  token: string;
  /** Multi-workspace mode: the request's headers / query pick the workspace. */
  registry?: WorkspaceContextRegistry;
  /** Workspace tokens: a request presenting one is bound to its workspace (multi-workspace mode only). */
  workspaceTokens?: McpWorkspaceTokens;
  /** For a request on the data root's token: why the workspace it names is not open to it, or null when it is. */
  authorize?: (scope: WorkspaceScope) => string | null;
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

/** Whether the request names a workspace at all (an agent's token needs none). */
function namesWorkspace(req: Request): boolean {
  const q = new URL(req.url).searchParams;
  return ['x-knode-user', 'x-knode-workspace-kind', 'x-knode-workspace-id', 'x-knode-workspace-name'].some((h) => req.headers.has(h))
    || ['user', 'kind', 'id', 'name'].some((p) => q.has(p));
}

export function mountMcp(app: Hono<any>, opts: MountMcpOptions): void {
  app.all(opts.path, async (c) => {
    const req = c.req.raw;
    const presented = presentedToken(req);
    const bound = opts.registry ? opts.workspaceTokens?.scopeOf(presented) ?? null : null;
    if (!bound && !tokenMatches(presented, opts.token)) {
      return c.json({ error: 'mcp: missing or invalid bearer token' }, 401);
    }
    let ctx: AppContext;
    if (opts.context) ctx = opts.context;
    else if (opts.registry) {
      try {
        let scope: WorkspaceScope;
        if (bound) {
          // the token is the workspace: what the request names may only agree with it
          if (namesWorkspace(req) && resolveWorkspaceScope(mcpWorkspaceHeaders(req)).relativeDir !== bound.relativeDir) {
            return c.json({ error: `mcp: this token belongs to the workspace "${bound.name}", not the one this request names` }, 403);
          }
          scope = bound;
        } else {
          scope = resolveWorkspaceScope(mcpWorkspaceHeaders(req));
          const refusal = opts.authorize?.(scope);
          if (refusal) return c.json({ error: `mcp: ${refusal}` }, 403);
          if (scope.kind === 'personal' && !opts.registry.exists(scope)) {
            return c.json({ error: `workspace "${scope.name}" does not exist` }, 404);
          }
        }
        ctx = await opts.registry.get(scope);
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, bound ? 403 : 401);
      }
    } else {
      return c.json({ error: 'mcp: no workspace registry or context mounted' }, 500);
    }

    // the base's own guide rides along as server instructions (cached by the file's mtime)
    const server = new McpServer(MCP_SERVER_INFO, { instructions: mcpInstructions(ctx.dataDir) });
    registerKnodeTools(server, ctx, { caller: bound ? 'agent' : 'owner' });
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
