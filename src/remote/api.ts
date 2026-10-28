import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { RemoteApiConfig } from '../config.js';
import { MAX_FILE_BYTES } from '../constants.js';
import { AppContext } from '../context.js';
import { assertSourcePath, cleanRelPath, removePath, safePath, writeFileText } from '../fs/files.js';
import { graphOverview, graphSearch } from '../graph/query.js';
import { assertNotLinked } from '../ingest/folders.js';
import { assertNotConvertedOriginal, readSourceTextCapped } from '../ingest/source.js';
import { sync } from '../ingest/sync.js';
import { FailureKind } from '../labeling/failures.js';
import { TaskOutcome, WorkerIdentity } from '../labeling/scheduler.js';
import { sanitizeUsage } from '../llm/usage.js';
import { search, SearchMode } from '../search/search.js';
import { WorkspaceContextRegistry, resolveWorkspaceScope, WorkspaceScope } from '../server/workspaces.js';
import { CATALOG_VIEWS, catalogQuery } from '../store/catalog.js';
import { queryClaims } from '../store/claims.js';
import { listEntities } from '../store/queries.js';
import { clientInfo } from '../server/public-guard.js';
import { WorkBroker } from '../work/broker.js';
import { offeredRemotely, workerConfig } from '../work/config.js';
import { isWorkKind, WORK_KINDS, WorkKind } from '../work/kinds.js';
import { RemoteScope, RemoteTokenRecord, RemoteTokenStore, tokenAllows, tokenAllowsKind } from './tokens.js';

/**
 * The remote API: what other machines may do with this knowledge base,
 * under /remote/v1 on `serve`'s own port.
 *
 *   GET  /health                                   no auth
 *   GET  /whoami                                   the token's name, scopes and workspaces
 *   GET  /worker.mjs                               the remote worker script (worker/knode-worker.mjs)
 *   /w/<owner>/<workspace>/…                       <owner> = a username, or "team" for a team workspace
 *     work       GET work/config, POST work/lease | complete | renew | release,
 *                GET work/status — every kind of leased work (docs/design/12)       (scope label)
 *     labeling   POST labeling/lease | complete | renew | release, GET labeling/status:
 *                the same for extraction only, as workers before work/* speak it    (scope label)
 *     documents  GET documents, GET document?path=                                      (scope read)
 *                PUT document?path= {content}, DELETE document?path=, POST sync          (scope write)
 *     knowledge  GET search?q=, graph?q=, claims?…, entities?q=                          (scope read)
 *     sql        POST sql {sql, maxRows}, GET sql/views                                  (scope sql)
 *
 * Every other route needs `Authorization: Bearer knr_…` (src/remote/tokens.ts).
 * Reads are limited to the knowledge — documents, wiki, playbook content — and
 * never reach the config, the token files or the ledger. Writes go to files
 * and through a scoped sync like any other edit, attributed to the token, so
 * the files stay the record and a rebuild loses nothing. SQL runs read-only,
 * as the workspace's catalog reader (src/store/catalog.ts). Each request is
 * logged to .knode/remote-audit.jsonl.
 */

export interface RemoteApiDeps {
  rootDataDir: string;
  registry: WorkspaceContextRegistry;
  /** The work broker `serve` runs for a workspace (src/work/broker.ts); null outside `serve`. */
  work: (ctx: AppContext) => WorkBroker | null;
  config?: RemoteApiConfig;
  log?: (msg: string) => void;
}

type RemoteEnv = {
  Variables: {
    token: RemoteTokenRecord;
    workspace: string;
    ctx: AppContext;
  };
};

const READABLE_ROOTS = ['raw/docs', 'raw/skills', 'wiki', 'playbooks/packs', 'playbooks/intents', 'playbooks/ontology', 'playbooks/capabilities'];
const READABLE_FILES = new Set(['purpose.md', 'schema.md', 'AGENTS.md', 'CLAUDE.md']);
const READ_MAX_BYTES = 2 * 1024 * 1024;
const AUDIT_FILE = '.knode/remote-audit.jsonl';
const AUDIT_ROTATE_BYTES = 20 * 1024 * 1024;
/** Failed authentications per client before it is turned away for a while. */
const AUTH_FAILURE_LIMIT = 10;
const AUTH_WINDOW_MS = 10 * 60_000;
const AUTH_BLOCK_MS = 15 * 60_000;

class HttpError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503, message: string) {
    super(message);
  }
}

/** A path a remote reader may open: knowledge only, never config, tokens, ledger or derived state. */
export function assertRemoteReadable(rel: string): string {
  const clean = cleanRelPath(rel);
  if (!clean) throw rel.trim() ? new HttpError(403, `${rel} is not readable remotely`) : new HttpError(400, 'path required');
  if (clean.split('/').some((segment) => segment.startsWith('.'))) throw new HttpError(403, `${clean} is not readable remotely`);
  if (READABLE_FILES.has(clean)) return clean;
  if (!READABLE_ROOTS.some((root) => clean === root || clean.startsWith(`${root}/`))) {
    throw new HttpError(403, `${clean} is not readable remotely — documents live under ${READABLE_ROOTS.join(', ')}`);
  }
  return clean;
}

/** The caller's address: the edge's word only when a proxy on this machine forwarded the request (src/server/public-guard.ts). */
function clientOf(c: Context): string {
  return clientInfo(c).ip;
}

const text = (value: unknown, max: number) => String(value ?? '').slice(0, max);

export function mountRemoteApi(app: Hono<any>, deps: RemoteApiDeps): void {
  const log = deps.log ?? (() => {});
  const tokens = new RemoteTokenStore(deps.rootDataDir);
  const failures = new Map<string, { count: number; since: number; blockedUntil: number }>();
  const api = new Hono<RemoteEnv>();
  const maxBody = deps.config?.maxBodyBytes ?? 8 * 1024 * 1024;

  const audit = (entry: Record<string, unknown>) => {
    try {
      const file = path.join(deps.rootDataDir, AUDIT_FILE);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      try {
        if (fs.statSync(file).size > AUDIT_ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
      } catch {
        // first entry
      }
      fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
    } catch {
      // auditing never fails a request
    }
  };

  api.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  });

  api.use('*', bodyLimit({ maxSize: maxBody, onError: (c) => c.json({ error: `request body above ${maxBody} bytes` }, 413) }));

  api.get('/health', (c) => c.json({ ok: true, service: 'knode-os remote', version: 1 }));

  // authentication, rate-limited per client, and an audit line for every answer
  api.use('*', async (c, next) => {
    if (c.req.path.endsWith('/remote/v1/health')) return next();
    const client = clientOf(c);
    const now = Date.now();
    const f = failures.get(client);
    if (f && f.blockedUntil > now) return c.json({ error: 'too many failed authentications — try again later' }, 429);
    const header = c.req.header('authorization') ?? '';
    const presented = /^bearer\s+(.+)$/i.exec(header)?.[1] ?? c.req.header('x-knode-token') ?? null;
    let record: RemoteTokenRecord | null = null;
    try {
      record = tokens.verify(presented);
    } catch (err) {
      log(`remote: token store unreadable: ${err instanceof Error ? err.message : err}`);
      return c.json({ error: 'authentication unavailable' }, 503);
    }
    if (!record) {
      const entry = f && now - f.since < AUTH_WINDOW_MS ? f : { count: 0, since: now, blockedUntil: 0 };
      entry.count++;
      if (entry.count >= AUTH_FAILURE_LIMIT) {
        entry.blockedUntil = now + AUTH_BLOCK_MS;
        log(`remote: ${client} blocked for ${AUTH_BLOCK_MS / 60_000} min after ${entry.count} failed authentications`);
      }
      failures.set(client, entry);
      audit({ client, method: c.req.method, path: c.req.path, status: 401 });
      return c.json({ error: 'missing or invalid token' }, 401);
    }
    failures.delete(client);
    c.set('token', record);
    const started = Date.now();
    await next();
    audit({ client, token: record.id, name: record.name, method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - started });
  });

  // the worker script itself, so a new machine needs nothing but Node and its token
  api.get('/worker.mjs', (c) => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const file = [path.resolve(here, '../../worker/knode-worker.mjs'), path.resolve(here, '../../../worker/knode-worker.mjs')].find((f) => fs.existsSync(f));
    if (!file) throw new HttpError(404, 'worker script not found next to this installation');
    return c.body(fs.readFileSync(file), 200, { 'content-type': 'text/javascript; charset=utf-8', 'content-disposition': 'attachment; filename="knode-worker.mjs"' });
  });

  api.get('/whoami', (c) => {
    const t = c.get('token');
    return c.json({ id: t.id, name: t.name, scopes: t.scopes, workspaces: t.workspaces, ...(t.kinds ? { kinds: t.kinds } : {}), createdAt: t.createdAt });
  });

  // a workspace the token may use, opened through the same registry as the UI's
  api.use('/w/:owner/:workspace/*', async (c, next) => {
    const owner = c.req.param('owner');
    const workspace = c.req.param('workspace');
    const spec = `${owner}/${workspace}`.toLowerCase();
    const token = c.get('token');
    if (!token.workspaces.some((w) => w === '*' || w === spec)) throw new HttpError(403, `this token may not use ${spec}`);
    let scope: WorkspaceScope;
    try {
      scope = owner.toLowerCase() === 'team'
        ? resolveWorkspaceScope({ user: 'remote', kind: 'team', name: workspace })
        : resolveWorkspaceScope({ user: owner, kind: 'personal', id: workspace, name: workspace });
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    if (!deps.registry.exists(scope)) throw new HttpError(404, `no workspace ${spec}`);
    c.set('workspace', spec);
    c.set('ctx', await deps.registry.get(scope));
    await next();
  });

  const need = (c: Context<RemoteEnv>, scope: RemoteScope) => {
    if (!tokenAllows(c.get('token'), scope, c.get('workspace'))) throw new HttpError(403, `this token lacks the "${scope}" scope here`);
    return c.get('ctx');
  };
  const broker = (ctx: AppContext) => {
    const b = deps.work(ctx);
    if (!b) throw new HttpError(503, 'leased work runs only inside `knode-os serve`');
    return b;
  };
  /** The kinds the token may take here that the workspace offers remote workers. */
  const allowedKinds = (c: Context<RemoteEnv>): WorkKind[] =>
    WORK_KINDS.filter((k) => tokenAllowsKind(c.get('token'), k, c.get('workspace')) && offeredRemotely(c.get('ctx').config, k));
  const configFor = (c: Context<RemoteEnv>, b: WorkBroker) =>
    workerConfig(c.get('ctx').config, { allowed: allowedKinds(c), leaseMs: b.leaseDurationMs(), shares: b.shares() });
  const whoOf = (c: Context<RemoteEnv>, body: Record<string, unknown>): WorkerIdentity => ({
    worker: `${c.get('token').name}/${text(body.worker || 'worker', 80)}`,
    backend: text(body.backend || 'unknown', 80),
    remote: true,
  });
  const body = async (c: Context<RemoteEnv>): Promise<Record<string, unknown>> => {
    const parsed = await c.req.json().catch(() => null);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'expected a JSON object');
    return parsed as Record<string, unknown>;
  };
  const ids = (value: unknown): string[] => (Array.isArray(value) ? value.map((v) => text(v, 64)).filter(Boolean).slice(0, 64) : []);

  /* ----------------------------- leased work ---------------------------- */

  const complete = async (c: Context<RemoteEnv>) => {
    const ctx = need(c, 'label');
    const b = await body(c);
    const id = text(b.id, 64);
    if (!id) throw new HttpError(400, 'id required');
    const kind = ['model', 'transient', 'fatal'].includes(String(b.kind)) ? (b.kind as FailureKind) : undefined;
    // what the worker's CLI or endpoint said the call used (a worker from before this sends none)
    const usage = sanitizeUsage(b.usage) ?? undefined;
    const outcome: TaskOutcome = b.ok === true
      ? { ok: true, text: text(b.text, 2 * 1024 * 1024), model: b.model ? text(b.model, 120) : undefined, usage }
      : { ok: false, error: text(b.error || 'failed without a message', 2000), kind, model: b.model ? text(b.model, 120) : undefined, usage };
    const result = await broker(ctx).complete(id, whoOf(c, b), outcome);
    return c.json(result, result.accepted ? 200 : 409);
  };
  const renew = async (c: Context<RemoteEnv>) => {
    const ctx = need(c, 'label');
    const b = await body(c);
    return c.json(broker(ctx).renew(ids(b.ids), whoOf(c, b)));
  };
  const release = async (c: Context<RemoteEnv>) => {
    const ctx = need(c, 'label');
    const b = await body(c);
    return c.json({ released: await broker(ctx).release(ids(b.ids), whoOf(c, b)) });
  };
  const watching = (c: Context<RemoteEnv>) => {
    const token = c.get('token');
    if (!tokenAllows(token, 'label', c.get('workspace')) && !tokenAllows(token, 'read', c.get('workspace'))) {
      throw new HttpError(403, 'this token lacks the "label" or "read" scope here');
    }
    return broker(c.get('ctx'));
  };

  // what a worker reads instead of being told by hand: the kinds it may take, lease, shares, model hints
  api.get('/w/:owner/:workspace/work/config', (c) => c.json(configFor(c, broker(need(c, 'label')))));

  api.post('/w/:owner/:workspace/work/lease', async (c) => {
    const ctx = need(c, 'label');
    const b = await body(c);
    const s = broker(ctx);
    const allowed = allowedKinds(c);
    const asked = Array.isArray(b.kinds) ? b.kinds.filter(isWorkKind) : allowed;
    const kinds = asked.filter((k) => allowed.includes(k));
    const tasks = kinds.length ? await s.lease(whoOf(c, b), kinds, Number(b.max ?? 1) || 1) : [];
    return c.json({ configVersion: configFor(c, s).version, leaseSeconds: Math.round(s.leaseDurationMs() / 1000), tasks });
  });
  api.post('/w/:owner/:workspace/work/complete', complete);
  api.post('/w/:owner/:workspace/work/renew', renew);
  api.post('/w/:owner/:workspace/work/release', release);
  api.get('/w/:owner/:workspace/work/status', async (c) => c.json(await watching(c).status()));

  // extraction only, as workers that predate work/* speak it
  api.post('/w/:owner/:workspace/labeling/lease', async (c) => {
    const ctx = need(c, 'label');
    if (!tokenAllowsKind(c.get('token'), 'extract', c.get('workspace'))) throw new HttpError(403, 'this token may not take extraction work');
    const b = await body(c);
    const s = broker(ctx);
    const tasks = await s.lease(whoOf(c, b), ['extract'], Number(b.max ?? 1) || 1);
    return c.json({ leaseSeconds: Math.round(s.leaseDurationMs('extract') / 1000), tasks });
  });
  api.post('/w/:owner/:workspace/labeling/complete', complete);
  api.post('/w/:owner/:workspace/labeling/renew', renew);
  api.post('/w/:owner/:workspace/labeling/release', release);
  api.get('/w/:owner/:workspace/labeling/status', async (c) => {
    const extract = watching(c).source('extract');
    if (!extract) throw new HttpError(503, 'extraction is not leased here');
    return c.json(await extract.status());
  });

  /* ------------------------------ documents ----------------------------- */

  api.get('/w/:owner/:workspace/documents', async (c) => {
    const ctx = need(c, 'read');
    const prefix = cleanRelPath(c.req.query('prefix') ?? '') || '';
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100) || 100, 1), 1000);
    const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0);
    const like = `${prefix.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const rows = await ctx.store.query(
      `SELECT path, title, root, kind, status, sha256, doc_date, created_at, updated_at
       FROM documents WHERE root IN ('docs', 'wiki', 'skills') AND path LIKE $1
       ORDER BY path LIMIT $2 OFFSET $3`,
      [like, limit, offset],
    );
    return c.json({ prefix, limit, offset, documents: rows });
  });

  api.get('/w/:owner/:workspace/document', (c) => {
    const ctx = need(c, 'read');
    const rel = assertRemoteReadable(c.req.query('path') ?? '');
    if (!fs.existsSync(safePath(ctx.dataDir, rel))) throw new HttpError(404, `no file ${rel}`);
    const file = readSourceTextCapped(ctx.dataDir, rel, READ_MAX_BYTES);
    if (!file) throw new HttpError(404, `${rel} has no readable text yet`);
    return c.json({ path: rel, ...file });
  });

  api.put('/w/:owner/:workspace/document', async (c) => {
    const ctx = need(c, 'write');
    const rel = cleanRelPath(c.req.query('path') ?? '');
    const b = await body(c);
    if (typeof b.content !== 'string') throw new HttpError(400, 'content (a string) required');
    if (Buffer.byteLength(b.content) > MAX_FILE_BYTES) throw new HttpError(400, `content above ${MAX_FILE_BYTES} bytes`);
    assertSourcePath(rel);
    assertNotConvertedOriginal(rel);
    assertNotLinked(ctx.config, rel, 'write to');
    writeFileText(ctx.dataDir, rel, b.content);
    const stats = await sync(ctx, { only: [rel], actor: `remote:${c.get('token').name}` });
    return c.json({ ok: true, path: rel, indexed: stats.indexed, unchanged: stats.unchanged, errors: stats.errors });
  });

  api.delete('/w/:owner/:workspace/document', async (c) => {
    const ctx = need(c, 'write');
    const rel = cleanRelPath(c.req.query('path') ?? '');
    assertSourcePath(rel);
    assertNotLinked(ctx.config, rel, 'delete');
    if (!fs.existsSync(safePath(ctx.dataDir, rel))) throw new HttpError(404, `no file ${rel}`);
    removePath(ctx.dataDir, rel);
    const stats = await sync(ctx, { only: [rel], actor: `remote:${c.get('token').name}` });
    return c.json({ ok: true, path: rel, disposed: stats.disposed });
  });

  api.post('/w/:owner/:workspace/sync', async (c) => {
    const ctx = need(c, 'write');
    const b = await c.req.json().catch(() => ({})) as { only?: unknown };
    const only = Array.isArray(b.only) ? b.only.map((p) => cleanRelPath(String(p))).filter(Boolean) : undefined;
    const stats = await sync(ctx, { only, actor: `remote:${c.get('token').name}` });
    return c.json({ indexed: stats.indexed, unchanged: stats.unchanged, disposed: stats.disposed, errors: stats.errors, chunks: stats.chunks });
  });

  /* ------------------------------ knowledge ----------------------------- */

  api.get('/w/:owner/:workspace/search', async (c) => {
    const ctx = need(c, 'read');
    const q = c.req.query('q');
    if (!q) throw new HttpError(400, 'q required');
    const mode = (c.req.query('mode') ?? 'hybrid') as SearchMode;
    if (!['hybrid', 'vector', 'keyword', 'sag'].includes(mode)) throw new HttpError(400, `unsupported search mode: ${mode}`);
    const k = Math.min(Math.max(Number(c.req.query('k') ?? 8) || 8, 1), 50);
    return c.json(await search(ctx.store, ctx.embedder, q, { k, mode, heat: ctx.config.heat, sag: ctx.config.retrieval.sag, asOf: c.req.query('as_of') || undefined }));
  });

  api.get('/w/:owner/:workspace/graph', async (c) => {
    const ctx = need(c, 'read');
    const q = c.req.query('q');
    if (q) return c.json(await graphSearch(ctx.store, q, { depth: Math.min(Number(c.req.query('depth') ?? 2) || 2, 4), heat: ctx.config.heat }));
    return c.json(await graphOverview(ctx.store, Math.min(Number(c.req.query('limit') ?? 120) || 120, 500)));
  });

  api.get('/w/:owner/:workspace/claims', async (c) => {
    const ctx = need(c, 'read');
    return c.json(await queryClaims(ctx.store, {
      subject: c.req.query('subject') || undefined,
      object: c.req.query('object') || undefined,
      text: c.req.query('text') || undefined,
      limit: Math.min(Number(c.req.query('limit') ?? 50) || 50, 500),
    }));
  });

  api.get('/w/:owner/:workspace/entities', async (c) => {
    const ctx = need(c, 'read');
    return c.json(await listEntities(ctx.store, c.req.query('q') || undefined));
  });

  /* --------------------------------- sql -------------------------------- */

  api.get('/w/:owner/:workspace/sql/views', (c) => {
    need(c, 'sql');
    return c.json({ views: CATALOG_VIEWS });
  });

  api.post('/w/:owner/:workspace/sql', async (c) => {
    const ctx = need(c, 'sql');
    const b = await body(c);
    if (typeof b.sql !== 'string' || !b.sql.trim()) throw new HttpError(400, 'sql required');
    return c.json(await catalogQuery(ctx.store, b.sql, { maxRows: Number(b.maxRows) || undefined }));
  });

  // the UI's catch-all must not answer for an unknown API path
  api.all('*', (c) => c.json({ error: 'not found' }, 404));

  app.route('/remote/v1', api);
}
