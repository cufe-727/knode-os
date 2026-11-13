import crypto from 'node:crypto';
import { Context, Hono } from 'hono';
import type { KnodeConfig } from '../config.js';
import { clientInfo } from '../server/public-guard.js';
import type { EvalAgent } from '../work/broker.js';
import { readArchive } from '../work/eval-archive.js';
import { EVAL_FAMILIES, EvalFamily, EvalSpec, EvalWork } from '../work/eval.js';
import { offeredRemotely } from '../work/config.js';

/**
 * The producer channel of evaluation work (docs/design/27 §8): how a
 * `knode-os eval run` on this machine offers its model work to remote workers
 * through `serve`, and gets the outcome back.
 *
 *   GET  /eval/v1/status                 whether eval work is offered, and the worker slots online per kind and CLI
 *   POST /eval/v1/offer                  {spec, offerSeconds}: held open (whitespace every 10 s) until the piece
 *                                        is answered, withdrawn, failed or cancelled; closing it cancels the piece
 *   HEAD|PUT /eval/v1/archives/<sha256>  a file agent's folder (src/work/eval-archive.ts), before its session is offered
 *   POST /eval/v1/runs/<run>/cancel      every piece of a run: leases end at the next renewal, session tokens now
 *
 * This machine only, as `/mcp` is: a request from anywhere else gets a 404,
 * and every request carries the data root's MCP token (`.knode/mcp-token`),
 * which only this machine's own clients can read.
 */

const KEEPALIVE_MS = 10_000;
const MAX_ARCHIVE_UPLOAD = 1024 ** 3;
const MAX_TIMEOUT_MS = 6 * 3_600_000;

export interface EvalProducerDeps {
  work: EvalWork;
  /** The data root's MCP token. */
  token: string;
  /** The server's settings (eval work is the server's, not a workspace's). */
  config: () => KnodeConfig;
  log?: (msg: string) => void;
}

class BadSpec extends Error {}

const text = (v: unknown, max: number) => String(v ?? '').slice(0, max);
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@\[\]=,-]{0,119}$/;
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const TOOL_RE = /^[a-z][a-z0-9_]{0,63}$/;

function agentOf(v: unknown): EvalAgent {
  const a = (v ?? {}) as Record<string, unknown>;
  const family = String(a.family ?? '') as EvalFamily;
  if (!EVAL_FAMILIES.includes(family)) throw new BadSpec(`agent.family must be ${EVAL_FAMILIES.join(' or ')}`);
  const model = String(a.model ?? '');
  // a run offers only work whose model it names: another machine's CLI default may be another model
  if (!MODEL_RE.test(model)) throw new BadSpec('agent.model must name a model');
  const effort = a.effort == null ? null : String(a.effort);
  if (effort !== null && !EFFORTS.has(effort)) throw new BadSpec(`unknown effort "${effort}"`);
  const speed = a.speed == null ? null : String(a.speed);
  if (speed !== null && !/^[a-z][a-z0-9_-]{0,30}$/.test(speed)) throw new BadSpec('agent.speed is not one');
  return { family, model, effort, speed };
}

/** A spec as the run sent it, checked field by field. */
export function evalSpecOf(body: Record<string, unknown>): EvalSpec {
  const s = (body.spec ?? {}) as Record<string, unknown>;
  const run = text(s.run, 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(run)) throw new BadSpec('spec.run must be a run id');
  const label = text(s.label, 300);
  const agent = agentOf(s.agent);
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.trunc(Number(s.timeoutMs) || 15 * 60_000)));
  if (typeof s.prompt !== 'string' || !s.prompt.trim()) throw new BadSpec('spec.prompt required');
  if (s.kind === 'eval-call') {
    return { kind: 'eval-call', run, label, agent, prompt: s.prompt, schema: s.schema ?? null, timeoutMs };
  }
  if (s.kind !== 'eval-session') throw new BadSpec('spec.kind must be eval-call or eval-session');
  if (agent.family !== 'codex') throw new BadSpec('eval sessions run on codex');
  if (s.sandbox !== 'read-only') throw new BadSpec('only read-only sessions leave this machine');
  const maxSteps = Math.trunc(Number(s.maxSteps));
  if (!(maxSteps >= 1 && maxSteps <= 1000)) throw new BadSpec('spec.maxSteps out of range');
  const a = s.archive as Record<string, unknown> | null | undefined;
  const archive = a ? { sha256: text(a.sha256, 64), bytes: Math.max(0, Math.trunc(Number(a.bytes) || 0)) } : null;
  if (archive && !/^[0-9a-f]{64}$/.test(archive.sha256)) throw new BadSpec('spec.archive.sha256 must be a SHA-256');
  const m = s.mcp as Record<string, unknown> | null | undefined;
  let mcp: { url: string; secret: string; tools: string[] } | null = null;
  if (m) {
    const url = text(m.url, 300);
    // the bridge is the run's, on this machine: never anywhere else
    if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9/_-]*$/.test(url)) throw new BadSpec('spec.mcp.url must be a loopback http URL');
    const tools = Array.isArray(m.tools) ? m.tools.map(String) : [];
    if (!tools.length || tools.length > 64 || !tools.every((t) => TOOL_RE.test(t))) throw new BadSpec('spec.mcp.tools must name the tools');
    const secret = text(m.secret, 200);
    if (secret.length < 16) throw new BadSpec('spec.mcp.secret required');
    mcp = { url, secret, tools };
  }
  return { kind: 'eval-session', run, label, agent, sandbox: 'read-only', maxSteps, timeoutMs, prompt: s.prompt, archive, mcp };
}

function tokenMatches(presented: string | null, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function mountEvalProducer(app: Hono<any>, deps: EvalProducerDeps): void {
  const log = deps.log ?? (() => {});
  const api = new Hono();

  api.use('*', async (c, next) => {
    if (!clientInfo(c).local) return c.json({ error: 'not found' }, 404);
    const presented = /^bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? null;
    if (!tokenMatches(presented, deps.token)) return c.json({ error: 'eval: missing or invalid bearer token (the data root\'s .knode/mcp-token)' }, 401);
    await next();
  });
  api.onError((err, c) => c.json({ error: err instanceof Error ? err.message : String(err) }, err instanceof BadSpec ? 400 : 500));

  const offered = () => offeredRemotely(deps.config(), 'eval-call');
  const offerSeconds = () => {
    const n = Number(deps.config().server.remote?.evalOfferSeconds);
    return Number.isFinite(n) && n >= 0 ? n : 30;
  };

  api.get('/status', (c) => c.json({
    offered: offered(),
    offerSeconds: offerSeconds(),
    online: {
      'eval-call': Object.fromEntries(EVAL_FAMILIES.map((f) => [f, deps.work.calls.online(f)])),
      'eval-session': Object.fromEntries(EVAL_FAMILIES.map((f) => [f, deps.work.sessions.online(f)])),
    },
  }));

  api.post('/offer', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') throw new BadSpec('expected a JSON object');
    const spec = evalSpecOf(body);
    if (!offered()) return c.json({ outcome: 'withdrawn', reason: 'this server does not offer evaluation work (server.remote.offer.eval is off)' });
    if (spec.kind === 'eval-session' && spec.archive && !deps.work.archives.file(spec.archive.sha256)) {
      throw new BadSpec(`archive ${spec.archive.sha256.slice(0, 12)} is not here: upload it first`);
    }
    const asked = Number(body.offerSeconds);
    const offerMs = (Number.isFinite(asked) && asked >= 0 ? asked : offerSeconds()) * 1000;
    const abort = new AbortController();
    const offer = deps.work.source(spec.kind).offer(spec, { offerMs, signal: abort.signal });
    // the answer can take as long as the piece: headers now, whitespace while it waits, the outcome last
    const enc = new TextEncoder();
    let timer: NodeJS.Timeout | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        timer = setInterval(() => {
          try {
            controller.enqueue(enc.encode(' '));
          } catch {
            abort.abort();
          }
        }, KEEPALIVE_MS);
        timer.unref?.();
        void offer.result.then((outcome) => {
          if (timer) clearInterval(timer);
          try {
            controller.enqueue(enc.encode(JSON.stringify(outcome)));
            controller.close();
          } catch {
            // the run went away first
          }
        });
      },
      cancel() {
        // the run closed the request (stopped, killed): the piece is no longer wanted
        if (timer) clearInterval(timer);
        abort.abort();
      },
    });
    c.req.raw.signal?.addEventListener('abort', () => abort.abort(), { once: true });
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  });

  api.on('HEAD', '/archives/:sha', (c) => {
    const f = deps.work.archives.file(c.req.param('sha'));
    return c.body(null, f ? 200 : 404);
  });

  api.put('/archives/:sha', async (c) => {
    const sha = c.req.param('sha');
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > MAX_ARCHIVE_UPLOAD) return c.json({ error: `an archive above ${MAX_ARCHIVE_UPLOAD} bytes` }, 413);
    const gzip = Buffer.from(await c.req.arrayBuffer());
    if (gzip.length > MAX_ARCHIVE_UPLOAD) return c.json({ error: `an archive above ${MAX_ARCHIVE_UPLOAD} bytes` }, 413);
    try {
      await deps.work.archives.put(sha, gzip, readArchive);
    } catch (err) {
      throw new BadSpec(err instanceof Error ? err.message : String(err));
    }
    return c.json({ ok: true, sha256: sha, bytes: gzip.length });
  });

  api.post('/runs/:run/cancel', (c) => {
    const run = c.req.param('run');
    const n = deps.work.calls.cancelRun(run) + deps.work.sessions.cancelRun(run);
    if (n) log(`eval run ${run} cancelled: ${n} piece(s) withdrawn`);
    return c.json({ cancelled: n });
  });

  api.all('*', (c: Context) => c.json({ error: 'not found' }, 404));

  app.route('/eval/v1', api);
}
