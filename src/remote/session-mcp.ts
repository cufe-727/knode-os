import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { AppContext } from '../context.js';
import { cleanRelPath } from '../fs/files.js';
import { mcpInstructions } from '../mcp/instructions.js';
import { MCP_SERVER_INFO } from '../mcp/server.js';
import { registerKnodeTools } from '../mcp/tools.js';
import { READ_TOOLS } from '../research/launch.js';
import { SessionBinding } from '../work/session.js';

/**
 * knode's tools for one remote research session (docs/design/27 §4), at
 * `/remote/v1/w/<owner>/<workspace>/sessions/<id>/mcp`. `/mcp` stays this
 * machine's alone; this route answers a session's own token while its lease
 * lives, and nothing else.
 *
 *   - tools: a reader or collector gets the read tools a local read session
 *     gets (READ_TOOLS, knode_capture among them); a writer also gets
 *     knode_write, knode_checkout and knode_commit — never the rest of the
 *     agent surface (sync, forget, queuing research …);
 *   - writes: knode_write takes the job's output path and its companions only,
 *     knode_commit the job's own workset only, to the default notes folder;
 *   - answers come as an event stream with a comment every 20 s, so a tool
 *     call that takes minutes (a capture of a filing) is not cut by a proxy
 *     that drops a response with nothing sent for 100 s (Cloudflare's edge).
 */

const KNODE_PREFIX = 'mcp__knode-os__';
const WRITE_TOOLS = ['knode_write', 'knode_checkout', 'knode_commit'];
const KEEPALIVE_MS = 20_000;

/** The tools a remote session gets. */
export function sessionTools(tools: 'read' | 'write'): ReadonlySet<string> {
  const read = READ_TOOLS.map((t) => t.slice(KNODE_PREFIX.length));
  return new Set(tools === 'write' ? [...read, ...WRITE_TOOLS] : read);
}

/** Refuses a write outside the session's job. */
export function sessionGuard(binding: SessionBinding): (tool: string, args: Record<string, unknown>) => void {
  const paths = new Set(binding.writePaths.map((p) => cleanRelPath(p)).filter(Boolean));
  return (tool, args) => {
    if (tool === 'knode_write') {
      const p = cleanRelPath(String(args.path ?? ''));
      if (!paths.has(p)) {
        throw new Error(`this session may write only ${[...paths].map((x) => `"${x}"`).join(', ') || 'nothing'}: a research session on another machine writes its own job's page`);
      }
    }
    if (tool === 'knode_commit') {
      if (String(args.workset ?? '') !== binding.workset) throw new Error(`this session commits only its own workset ${binding.workset}`);
      if (args.path !== undefined && args.path !== null && String(args.path).trim() !== '') {
        throw new Error('a research session on another machine commits to the default notes folder: leave path out');
      }
    }
  };
}

/** What a request asks, for the audit log: the method, and for a tool call its name and the path it names — never content. */
export async function describeMcpRequest(req: Request): Promise<{ rpc?: string; tool?: string; path?: string }> {
  if (req.method !== 'POST') return {};
  try {
    const body = (await req.clone().json()) as unknown;
    const first = (Array.isArray(body) ? body[0] : body) as { method?: unknown; params?: { name?: unknown; arguments?: { path?: unknown } } } | null;
    const out: { rpc?: string; tool?: string; path?: string } = {};
    if (typeof first?.method === 'string') out.rpc = first.method.slice(0, 60);
    if (typeof first?.params?.name === 'string') out.tool = first.params.name.slice(0, 60);
    if (typeof first?.params?.arguments?.path === 'string') out.path = first.params.arguments.path.slice(0, 300);
    return out;
  } catch {
    return {};
  }
}

/** Answer one MCP request for a session: a fresh server bound to its tools, answering as an event stream. */
export async function answerSessionMcp(req: Request, ctx: AppContext, binding: SessionBinding): Promise<Response> {
  // stateless, as /mcp is: no standalone stream to open, no session to end
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: { allow: 'POST', 'content-type': 'application/json' } });
  const server = new McpServer(MCP_SERVER_INFO, { instructions: mcpInstructions(ctx.dataDir) });
  registerKnodeTools(server, ctx, { caller: 'agent', only: sessionTools(binding.tools), guard: sessionGuard(binding) });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: false });
  await server.connect(transport);
  const close = () => void server.close().catch(() => {});
  let res: Response;
  try {
    res = await transport.handleRequest(req);
  } catch (err) {
    close();
    throw err;
  }
  return withKeepalive(res, close);
}

/**
 * An event stream with a comment every `everyMs` while it stays open, and
 * `done` once it ends. Any other answer (an error, a notification's 202)
 * passes through, and is done at once.
 */
export function withKeepalive(res: Response, done: () => void, everyMs = KEEPALIVE_MS): Response {
  if (!res.body || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    done();
    return res;
  }
  const reader = res.body.getReader();
  const ping = new TextEncoder().encode(': keepalive\n\n');
  let timer: NodeJS.Timeout | null = null;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (timer) clearInterval(timer);
    done();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        try {
          controller.enqueue(ping);
        } catch {
          finish();
        }
      }, everyMs);
      timer.unref?.();
    },
    async pull(controller) {
      try {
        const { done: end, value } = await reader.read();
        if (end) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        finish();
        controller.error(err);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
  return new Response(stream, { status: res.status, headers: res.headers });
}
