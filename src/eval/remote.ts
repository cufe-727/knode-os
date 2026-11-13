import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../config.js';
import { effortFor, renderCliPrompt, speedFor } from '../llm/cli.js';
import type { ChatMessage, LlmClient } from '../llm/client.js';
import type { CallUsage } from '../llm/usage.js';
import { readCodexEvents } from '../llm/usage.js';
import { MCP_TOKEN_FILE } from '../server/mcp-http.js';
import type { EvalAgent } from '../work/broker.js';
import { packFolder } from '../work/eval-archive.js';
import type { EvalFamily, EvalOutcome, EvalSessionAnswer } from '../work/eval.js';
import type { EvalKind } from '../work/kinds.js';
import type { AgentRunOptions, AgentRunResult, McpServerSpec } from './agent.js';
import { AgentTrace } from './agent.js';
import type { LoadedPack } from './pack.js';
import { notePlacement } from './placement.js';
import type { QuotaGuard } from './quota.js';
import type { ChatBackend, ChatRequest, ChatResult, Slots } from './shim.js';

/**
 * An evaluation run's side of remote work (docs/design/27 §8).
 *
 * The run stays here; it offers model work to `serve` over its loopback
 * producer channel (src/remote/eval-producer.ts), which leases it to remote
 * workers and hands back what became of it. Three kinds of work leave:
 *
 *   - every system's build and single-shot answers, through the shim's
 *     backend (`PlacedChatBackend`): an `eval-call` per model call;
 *   - the judge's calls (`remoteJudgeClient`): an `eval-call` on Claude;
 *   - agent answers (`runAgent`, src/eval/agent.ts): an `eval-session`, its
 *     folder as an archive, or its knode tools through an MCP bridge kept here
 *     on the run's own copy of the workspace (`startMcpBridge`).
 *
 * A piece is offered only while a worker for its kind and CLI asked lately,
 * and only when the run names its model (a CLI default may differ between
 * machines); it runs here when nobody takes it in time or after three worker
 * failures (D3, D11). A pack with a `private:` source never leaves
 * (`packMayLeave`). With `serve` not running, nothing changes: everything
 * runs here.
 */

export type RemoteOutcome = EvalOutcome | { outcome: 'unreachable'; error: string };

interface ProducerStatus {
  offered: boolean;
  offerSeconds: number;
  online: Record<EvalKind, Record<EvalFamily, number>>;
}

export interface RemoteEvalOptions {
  /** `serve`'s own origin on this machine, e.g. http://127.0.0.1:12000. */
  serveUrl: string;
  /** The data root's MCP token. */
  token: string;
  /** The run's id: offers carry it, and cancelling the run withdraws them. */
  run: string;
  /** How long a piece waits for a worker before it runs here (default: the server's, 30 s). */
  offerSeconds?: number;
  /** The run's quota guard: a piece that falls back here waits for this machine's plan. */
  quota?: QuotaGuard | null;
  /** How often the worker slots online are read again (default 15 s). */
  refreshMs?: number;
  log?: (msg: string) => void;
}

/** Whether a pack's work may leave this machine: none of its sources is private. */
export function packMayLeave(pack: Pick<LoadedPack, 'manifest'>): boolean {
  return !pack.manifest.sources.some((s) => s.license.trim().toLowerCase().startsWith('private:'));
}

/** `serve`'s origin and token for this machine's data root (`--serve-url` overrides the origin). */
export function localServe(dataRoot: string, serveUrl?: string): { serveUrl: string; token: string } {
  const tokenFile = path.join(dataRoot, MCP_TOKEN_FILE);
  if (!fs.existsSync(tokenFile)) throw new Error(`--remote: no ${MCP_TOKEN_FILE} under ${dataRoot} — start \`knode-os serve\` once, or pass --data`);
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  if (serveUrl) return { serveUrl: serveUrl.replace(/\/+$/, ''), token };
  const config = loadConfig(dataRoot);
  const host = !config.server.host || config.server.host === '0.0.0.0' || config.server.host === '::' ? '127.0.0.1' : config.server.host;
  return { serveUrl: `http://${host}:${config.server.port}`, token };
}

/** A worker slot's identity as a record keeps it: the machine (`<token>/<worker>`), not its slot (`…/eval-codex#2`). */
export function machineOf(worker: string): string {
  return worker.replace(/\/[^/]*#\d+$/, '');
}

export class RemoteEval {
  private status: ProducerStatus | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly abort = new AbortController();
  private readonly log: (msg: string) => void;
  private unreachableSaid = false;
  /** Pieces placed, for the run's log. */
  readonly counts = { offered: 0, remote: 0, here: 0 };
  /** Whether the run's model calls leave (the run sets it: its own Codex backend with a named model). */
  callsLeave = false;

  private constructor(private readonly opts: RemoteEvalOptions) {
    this.log = opts.log ?? (() => {});
  }

  /** Connect to `serve`; null (and a log line) when it is not running or offers no eval work: everything runs here. */
  static async connect(opts: RemoteEvalOptions): Promise<RemoteEval | null> {
    const r = new RemoteEval(opts);
    try {
      await r.refresh(true);
    } catch (err) {
      r.log(`remote: ${opts.serveUrl} is not answering (${err instanceof Error ? err.message : err}) — this run does all its work here`);
      return null;
    }
    if (!r.status?.offered) r.log('remote: serve does not offer evaluation work (server.remote.offer.eval is off) — this run does all its work here until it does');
    r.timer = setInterval(() => void r.refresh().catch(() => {}), Math.max(500, opts.refreshMs ?? 15_000));
    r.timer.unref?.();
    return r;
  }

  get run(): string {
    return this.opts.run;
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  /** Worker slots of this CLI that asked for this kind lately (0 while eval work is not offered). */
  online(kind: EvalKind, family: EvalFamily): number {
    if (!this.status?.offered || this.abort.signal.aborted) return 0;
    return this.status.online[kind]?.[family] ?? 0;
  }

  /** Worker slots a build's or a system's model calls can use beside this machine's: 0 while its calls stay here. */
  callSlots(): number {
    return this.callsLeave ? this.online('eval-call', 'codex') : 0;
  }

  /** Before a piece runs here: this machine's plan (the quota guard), read at most once a minute. */
  async localGate(): Promise<void> {
    await this.opts.quota?.waitLocal({ cacheMs: 60_000 });
  }

  /** Offer one piece and wait for what becomes of it. */
  async offer(spec: Omit<import('../work/eval.js').EvalCallSpec, 'run'> | Omit<import('../work/eval.js').EvalSessionSpec, 'run'>): Promise<RemoteOutcome> {
    if (this.abort.signal.aborted) return { outcome: 'cancelled' };
    this.counts.offered++;
    try {
      const res = await fetch(`${this.opts.serveUrl}/eval/v1/offer`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ spec: { ...spec, run: this.opts.run }, ...(this.opts.offerSeconds !== undefined ? { offerSeconds: this.opts.offerSeconds } : {}) }),
        signal: this.abort.signal,
      });
      const text = (await res.text()).trim();
      const body = text ? JSON.parse(text) as RemoteOutcome & { error?: string } : null;
      if (!res.ok || !body || !('outcome' in body)) throw new Error(`${res.status}: ${body?.error ?? text.slice(0, 200)}`);
      if (body.outcome === 'answered' || body.outcome === 'error') {
        this.counts.remote++;
        // records name the machine, not the slot on it: `<token>/<worker>`
        body.worker = machineOf(body.worker);
      }
      return body;
    } catch (err) {
      if (this.abort.signal.aborted) return { outcome: 'cancelled' };
      const error = err instanceof Error ? err.message : String(err);
      if (!this.unreachableSaid) {
        this.unreachableSaid = true;
        this.log(`remote: offering to serve failed (${error}) — such pieces run here`);
      }
      return { outcome: 'unreachable', error };
    }
  }

  /** A folder as an archive `serve` holds: packed, and uploaded unless it is there already. */
  async archive(dir: string): Promise<{ sha256: string; bytes: number }> {
    const packed = packFolder(dir);
    // a folder every question reads (a corpus copy) is uploaded once: the server says whether it holds it
    const head = await fetch(`${this.opts.serveUrl}/eval/v1/archives/${packed.sha256}`, { method: 'HEAD', headers: { authorization: `Bearer ${this.opts.token}` }, signal: this.abort.signal });
    if (head.ok) return { sha256: packed.sha256, bytes: packed.bytes };
    const res = await fetch(`${this.opts.serveUrl}/eval/v1/archives/${packed.sha256}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${this.opts.token}`, 'content-type': 'application/gzip' },
      body: packed.gzip(),
      signal: this.abort.signal,
    });
    if (!res.ok) throw new Error(`archive upload refused: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return { sha256: packed.sha256, bytes: packed.bytes };
  }

  /** The run is cancelled: what is offered or out is withdrawn, and session tokens die at once. */
  async cancel(): Promise<void> {
    if (this.abort.signal.aborted) return;
    this.abort.abort();
    await fetch(`${this.opts.serveUrl}/eval/v1/runs/${encodeURIComponent(this.opts.run)}/cancel`, {
      method: 'POST', headers: { authorization: `Bearer ${this.opts.token}` }, signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
    this.close();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async refresh(first = false): Promise<void> {
    const res = await fetch(`${this.opts.serveUrl}/eval/v1/status`, { headers: { authorization: `Bearer ${this.opts.token}` }, signal: AbortSignal.timeout(first ? 5_000 : 10_000) });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    this.status = await res.json() as ProducerStatus;
  }
}

/** Every call of this piece of work stopped because the run was cancelled. */
export class RunCancelledError extends Error {
  constructor() {
    super('the run was cancelled');
  }
}

/**
 * The shim's backend with remote workers beside it: a model call goes to a
 * worker while one that runs the run's CLI asked lately, and runs here — under
 * the run's `--slots` — when none takes it in time. Only a run on Codex with a
 * named model offers its calls: the worker runs exactly that model, so the
 * records stay on one backend (`codex-cli:<model>`) wherever a call ran.
 */
export class PlacedChatBackend implements ChatBackend {
  readonly selfLimiting = true;

  constructor(
    private readonly local: ChatBackend,
    private readonly slots: Slots,
    private readonly remote: RemoteEval,
    private readonly agent: { model: string; speed?: string | null },
  ) {}

  get label(): string {
    return this.local.label;
  }

  async complete(req: ChatRequest): Promise<ChatResult> {
    // a cancelled run starts nothing more, here or anywhere
    if (this.remote.signal.aborted) throw new RunCancelledError();
    if (this.remote.online('eval-call', 'codex') > 0) {
      const tag = req.tag;
      const o = await this.remote.offer({
        kind: 'eval-call',
        label: tag ? [tag.system, tag.stage, tag.task].filter(Boolean).join(' · ') : 'call',
        agent: { family: 'codex', model: this.agent.model, effort: effortFor('codex-cli', req.effort) ?? null, speed: this.agent.speed ?? null },
        prompt: renderCliPrompt(req.messages, req.json),
        schema: req.schema ?? null,
        timeoutMs: 900_000,
      });
      if (o.outcome === 'answered') return { text: o.text.trim(), usage: o.usage, model: o.model, worker: o.worker, backend: o.backend };
      if (o.outcome === 'error') throw Object.assign(new Error(`codex exec failed on ${o.worker}: ${o.error}`), { usage: o.usage });
      if (o.outcome === 'cancelled' || o.outcome === 'stopped') throw new RunCancelledError();
    }
    this.remote.counts.here++;
    await this.remote.localGate();
    return this.slots.run(() => this.local.complete(req));
  }
}

/**
 * The judge's client with remote workers beside it: its calls go to a worker
 * that runs the judge's CLI and model, and here otherwise. Who answered is
 * noted for the judge's meter (src/eval/placement.ts).
 */
export function remoteJudgeClient(client: LlmClient, remote: RemoteEval, agent: { family: EvalFamily; model: string; effort: string | null }): LlmClient {
  const local = client.complete.bind(client);
  const backend = `${agent.family}-cli:${agent.model}`;
  return Object.assign(Object.create(client) as LlmClient, {
    complete: async (messages: ChatMessage[], opts: Parameters<LlmClient['complete']>[1] = {}) => {
      if (remote.signal.aborted) throw new RunCancelledError();
      if (remote.online('eval-call', agent.family) > 0) {
        const o = await remote.offer({
          kind: 'eval-call', label: 'judge', agent: { family: agent.family, model: agent.model, effort: agent.effort, speed: null },
          prompt: renderCliPrompt(messages, Boolean(opts.json)), schema: null, timeoutMs: 600_000,
        });
        if (o.outcome === 'answered') {
          if (o.usage) opts.onUsage?.(o.usage);
          notePlacement({ worker: o.worker, backend: o.backend });
          return o.text.trim();
        }
        if (o.outcome === 'error') {
          if (o.usage) opts.onUsage?.(o.usage);
          notePlacement({ worker: o.worker, backend: o.backend });
          throw new Error(`${agent.family} CLI error on ${o.worker}: ${o.error}`);
        }
        if (o.outcome === 'cancelled' || o.outcome === 'stopped') throw new RunCancelledError();
      }
      remote.counts.here++;
      notePlacement({ backend });
      return local(messages, opts);
    },
  });
}

/** The judge's family and model as a remote worker would run them, or null when its calls stay here. */
export function judgeAgent(provider: string, model: string, effort?: string): { family: EvalFamily; model: string; effort: string | null } | null {
  const family: EvalFamily | null = provider === 'claude-cli' ? 'claude' : provider === 'codex-cli' ? 'codex' : null;
  if (!family || !model.trim()) return null;
  return { family, model: model.trim(), effort: effortFor(provider, effort as never) ?? null };
}

/* ------------------------------- MCP bridge ------------------------------- */

export interface McpBridge {
  /** http://127.0.0.1:<port>/mcp — `serve` proxies a session's calls here. */
  url: string;
  secret: string;
  tools: string[];
  close(): Promise<void>;
}

/**
 * knode's MCP server for an agent session, kept on this machine and reached
 * over loopback HTTP (docs/design/27 §8): the same stdio server a local
 * session would start (`McpServerSpec`), started on the first call — the
 * workspace's index stays here, and so do the query embeddings, so vectors
 * match — and filtered to the spec's enabled tools. `serve` proxies a worker's
 * calls to it with the bridge's own secret.
 */
export async function startMcpBridge(spec: McpServerSpec): Promise<McpBridge> {
  const tools = [...(spec.enabledTools ?? [])];
  if (!tools.length) throw new Error('an MCP agent leaves this machine only with its tools named (enabledTools)');
  const allowed = new Set(tools);
  const secret = crypto.randomBytes(24).toString('base64url');
  let connecting: Promise<Client> | null = null;
  let client: Client | null = null;
  const connect = () => (connecting ??= (async () => {
    const c = new Client({ name: 'knode-eval-bridge', version: '1.0.0' });
    await c.connect(new StdioClientTransport({ command: spec.command, args: spec.args, env: { ...getDefaultEnvironment(), ...(spec.env ?? {}) }, stderr: 'ignore' }));
    client = c;
    return c;
  })());
  const server = http.createServer((req, res) => {
    const presented = /^bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const ok = presented.length === secret.length && crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(secret));
    if (!ok || req.method !== 'POST') {
      res.writeHead(ok ? 405 : 401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: ok ? 'POST only' : 'unauthorized' }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => void (async () => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'expected JSON' }));
        return;
      }
      const mcp = new Server({ name: 'knode-os', version: '1.0.0' }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (await (await connect()).listTools()).tools.filter((t) => allowed.has(t.name)) }));
      mcp.setRequestHandler(CallToolRequestSchema, async (r) => {
        if (!allowed.has(r.params.name)) throw new McpError(ErrorCode.InvalidParams, `this session may not call ${r.params.name}`);
        return (await connect()).callTool(r.params) as never;
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close().catch(() => {});
        void mcp.close().catch(() => {});
      });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (err) {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    })());
  });
  server.requestTimeout = 0;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    secret,
    tools,
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await (client as Client | null)?.close().catch(() => {});
    },
  };
}

/* ------------------------------ agent sessions ----------------------------- */

/**
 * One `runAgent` session on a remote worker, or null when it runs here: a
 * session that writes (the llm-wiki build) stays, as does one whose model the
 * run does not name, one with no worker online for Codex sessions, and one
 * nobody takes in time or that three workers failed.
 */
export async function remoteAgent(remote: RemoteEval, opts: AgentRunOptions): Promise<AgentRunResult | null> {
  if (remote.signal.aborted) throw new RunCancelledError();
  if (opts.sandbox !== 'read-only' || !opts.model || remote.online('eval-session', 'codex') === 0) return null;
  if (opts.mcp && !opts.mcp.enabledTools?.length) return null;
  const t0 = Date.now();
  const hasFiles = fs.existsSync(opts.cwd) && fs.readdirSync(opts.cwd).length > 0;
  const archive = hasFiles ? await remote.archive(opts.cwd) : null;
  const bridge = opts.mcp ? await startMcpBridge(opts.mcp) : null;
  let o: RemoteOutcome;
  try {
    o = await remote.offer({
      kind: 'eval-session',
      label: `agent${opts.label ? ` · ${opts.label}` : ''}`,
      agent: { family: 'codex', model: opts.model, effort: effortFor('codex-cli', opts.effort) ?? null, speed: null },
      sandbox: 'read-only',
      maxSteps: opts.maxSteps ?? 25,
      timeoutMs: opts.timeoutMs ?? 15 * 60_000,
      prompt: opts.prompt,
      archive,
      mcp: bridge ? { url: bridge.url, secret: bridge.secret, tools: bridge.tools } : null,
    });
  } finally {
    await bridge?.close();
  }
  if (o.outcome === 'cancelled' || o.outcome === 'stopped') throw new RunCancelledError();
  if (o.outcome !== 'answered' || !o.session) return null;
  return agentResultOf(o.session, opts, { worker: o.worker, backend: o.backend, usage: o.usage, ms: Date.now() - t0 });
}

/** A worker's session parsed as `runAgentOnce` parses its own: the trace, the step cap, the leak audit (with the worker's folder and home). */
export function agentResultOf(s: EvalSessionAnswer, opts: AgentRunOptions, at: { worker: string; backend: string; usage: CallUsage | null; ms: number }): AgentRunResult {
  // the worker's folder stands for this one: its paths are read as the local copy's, everything else as the worker's home
  const rewrite = s.cwd ? (cmd: string) => cmd.split(s.cwd).join(opts.cwd) : (cmd: string) => cmd;
  const trace = new AgentTrace({ cwd: opts.cwd, maxSteps: opts.maxSteps ?? 25, allowRoots: opts.allowRoots, home: s.home || os.homedir(), rewrite });
  for (const line of s.stdout.split('\n')) trace.line(line);
  const capped = trace.capped || s.capped;
  const text = (s.lastMessage ?? '').trim();
  const error = s.exitCode !== 0 && !capped ? `codex exec exited with ${s.exitCode} on ${at.worker}: ${readCodexEvents(s.stdout).error ?? s.stderr.slice(-300)}` : undefined;
  return {
    text,
    usage: at.usage ?? readCodexEvents(s.stdout).usage,
    commands: trace.commands,
    toolCalls: trace.steps,
    capped,
    leaked: [...new Set(trace.leaked)],
    filesTouched: [...trace.touched],
    ms: at.ms,
    worker: at.worker,
    backend: at.backend,
    ...(error && !text ? { error } : {}),
  };
}

export type { EvalAgent };
