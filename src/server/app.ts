import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { AppContext } from '../context.js';
import { redactConfig } from '../config.js';
import { listTree, makeDir, movePath, pathExists, readFileText, removePath, writeFileBytes, writeFileText } from '../fs/files.js';
import { graphInsights, graphOverview, graphSearch } from '../graph/query.js';
import { runIngest } from '../ingest/pipeline.js';
import { ask } from '../search/ask.js';
import { search, SearchMode } from '../search/search.js';
import { syncTraces } from '../traces/sync.js';
import { runDream } from '../dream/dream.js';
import { generateWiki } from '../wiki/generate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(ctx: AppContext, log: (msg: string) => void = console.log) {
  const app = new Hono();
  let ingestRunning = false;

  const err = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) });

  /* ------------------------------- system ------------------------------- */

  app.get('/api/health', (c) => c.json({ ok: true, dataDir: ctx.dataDir }));
  app.get('/api/config', (c) => c.json(redactConfig(ctx.config)));

  app.get('/api/stats', async (c) => {
    const [row] = await ctx.store.query<Record<string, number>>(`
      SELECT (SELECT count(*)::int FROM documents WHERE root != 'traces') AS documents,
             (SELECT count(*)::int FROM chunks) AS chunks,
             (SELECT count(*)::int FROM embeddings) AS embeddings,
             (SELECT count(*)::int FROM entities) AS entities,
             (SELECT count(*)::int FROM relations) AS relations,
             (SELECT count(*)::int FROM traces) AS traces,
             (SELECT count(*)::int FROM suggestions WHERE status = 'pending') AS pending_suggestions`);
    const lastDream = await ctx.store.getMeta('last_dream');
    return c.json({ ...row, lastDream: lastDream ?? null, embeddingModel: ctx.embedder.model, llmModel: ctx.llm.model || null });
  });

  /* ------------------------------- files -------------------------------- */

  app.get('/api/tree', (c) => {
    try {
      return c.json(listTree(ctx.dataDir, c.req.query('path') ?? '.'));
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.get('/api/file', (c) => {
    try {
      const p = c.req.query('path');
      if (!p) return c.json({ error: 'path required' }, 400);
      return c.json({ path: p, content: readFileText(ctx.dataDir, p) });
    } catch (e) {
      return c.json(err(e), 404);
    }
  });

  app.put('/api/file', async (c) => {
    try {
      const { path: p, content } = await c.req.json<{ path: string; content: string }>();
      if (!p || typeof content !== 'string') return c.json({ error: 'path and content required' }, 400);
      writeFileText(ctx.dataDir, p, content);
      return c.json({ ok: true });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.delete('/api/file', (c) => {
    try {
      const p = c.req.query('path');
      if (!p) return c.json({ error: 'path required' }, 400);
      if (['wiki', 'raw', '.', '', 'purpose.md', 'schema.md', 'knode.config.json'].includes(p)) {
        return c.json({ error: 'refusing to delete a root path' }, 400);
      }
      removePath(ctx.dataDir, p);
      return c.json({ ok: true });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.post('/api/mkdir', async (c) => {
    try {
      const { path: p } = await c.req.json<{ path: string }>();
      makeDir(ctx.dataDir, p);
      return c.json({ ok: true });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.post('/api/mv', async (c) => {
    try {
      const { from, to } = await c.req.json<{ from: string; to: string }>();
      movePath(ctx.dataDir, from, to);
      return c.json({ ok: true });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  app.post('/api/upload', async (c) => {
    try {
      const form = await c.req.formData();
      const dir = (form.get('dir') as string) || 'raw/docs';
      if (!/^(raw\/docs|wiki)(\/|$)/.test(dir)) return c.json({ error: 'uploads go to raw/docs or wiki' }, 400);
      const saved: string[] = [];
      for (const [, v] of form.entries()) {
        if (v instanceof File) {
          const rel = `${dir}/${v.name}`.replace(/\/+/g, '/');
          if (pathExists(ctx.dataDir, rel)) {
            const ext = path.extname(v.name);
            const stem = v.name.slice(0, v.name.length - ext.length);
            const alt = `${dir}/${stem}-${Date.now()}${ext}`;
            writeFileBytes(ctx.dataDir, alt, new Uint8Array(await v.arrayBuffer()));
            saved.push(alt);
          } else {
            writeFileBytes(ctx.dataDir, rel, new Uint8Array(await v.arrayBuffer()));
            saved.push(rel);
          }
        }
      }
      return c.json({ ok: true, saved });
    } catch (e) {
      return c.json(err(e), 400);
    }
  });

  /* ----------------------------- knowledge ------------------------------ */

  app.post('/api/ingest', async (c) => {
    if (ingestRunning) return c.json({ error: 'ingest already running' }, 409);
    ingestRunning = true;
    try {
      const stats = await runIngest(ctx.store, ctx.config, ctx.embedder, ctx.llm, { onProgress: log });
      return c.json(stats);
    } catch (e) {
      return c.json(err(e), 500);
    } finally {
      ingestRunning = false;
    }
  });

  app.get('/api/search', async (c) => {
    const q = c.req.query('q');
    if (!q) return c.json({ error: 'q required' }, 400);
    const k = Number(c.req.query('k') ?? 8);
    const mode = (c.req.query('mode') ?? 'hybrid') as SearchMode;
    try {
      return c.json(await search(ctx.store, ctx.embedder, q, { k, mode }));
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  app.post('/api/ask', async (c) => {
    try {
      const { question } = await c.req.json<{ question: string }>();
      if (!question) return c.json({ error: 'question required' }, 400);
      return c.json(await ask(ctx.store, ctx.config, ctx.embedder, ctx.llm, question));
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  app.get('/api/graph', async (c) => {
    try {
      const q = c.req.query('q');
      const depth = Number(c.req.query('depth') ?? 2);
      if (q) return c.json(await graphSearch(ctx.store, q, { depth }));
      return c.json(await graphOverview(ctx.store, Number(c.req.query('limit') ?? 120)));
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  app.get('/api/graph/insights', async (c) => c.json(await graphInsights(ctx.store)));

  app.get('/api/entities', async (c) => {
    const q = c.req.query('q');
    if (q) {
      return c.json(await ctx.store.query(
        `SELECT * FROM entities WHERE name ILIKE $1 OR aliases::text ILIKE $1 ORDER BY mention_count DESC LIMIT 100`,
        [`%${q}%`],
      ));
    }
    return c.json(await ctx.store.query(`SELECT * FROM entities ORDER BY mention_count DESC LIMIT 200`));
  });

  app.get('/api/documents', async (c) =>
    c.json(await ctx.store.query(`SELECT * FROM documents WHERE root != 'traces' ORDER BY updated_at DESC LIMIT 500`)));

  app.post('/api/wiki/generate', async (c) => {
    try {
      return c.json({ created: await generateWiki(ctx.store, ctx.llm, { onProgress: log }) });
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  /* --------------------------- traces & dream --------------------------- */

  app.get('/api/traces', async (c) =>
    c.json(await ctx.store.query(`SELECT * FROM traces ORDER BY started_at DESC NULLS LAST LIMIT 300`)));

  app.post('/api/traces/sync', async (c) => {
    try {
      return c.json(await syncTraces(ctx.store, ctx.config));
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  app.get('/api/suggestions', async (c) => {
    const status = c.req.query('status');
    if (status) {
      return c.json(await ctx.store.query(`SELECT * FROM suggestions WHERE status = $1 ORDER BY created_at DESC LIMIT 200`, [status]));
    }
    return c.json(await ctx.store.query(`SELECT * FROM suggestions ORDER BY created_at DESC LIMIT 200`));
  });

  app.post('/api/suggestions/:id/status', async (c) => {
    const { status } = await c.req.json<{ status: string }>();
    if (!['pending', 'accepted', 'rejected'].includes(status)) return c.json({ error: 'bad status' }, 400);
    await ctx.store.query(`UPDATE suggestions SET status = $2 WHERE id = $1`, [c.req.param('id'), status]);
    return c.json({ ok: true });
  });

  app.post('/api/dream', async (c) => {
    try {
      const res = await runDream(ctx.store, ctx.config, ctx.llm, { onProgress: log });
      return c.json(res);
    } catch (e) {
      return c.json(err(e), 500);
    }
  });

  /* ------------------------------ static UI ----------------------------- */

  const webDir = findWebDir();
  const markedJs = findMarkedUmd();
  app.get('/vendor/marked.js', (c) => {
    if (!markedJs) return c.text('window.marked=null;', 200, { 'content-type': 'text/javascript' });
    return c.text(fs.readFileSync(markedJs, 'utf8'), 200, { 'content-type': 'text/javascript' });
  });
  app.get('/*', (c) => {
    if (!webDir) return c.text('web UI assets not found', 404);
    let rel = c.req.path.replace(/^\/+/, '') || 'index.html';
    if (!fs.existsSync(path.join(webDir, rel)) || fs.statSync(path.join(webDir, rel)).isDirectory()) rel = 'index.html';
    const abs = path.resolve(webDir, rel);
    if (!abs.startsWith(path.resolve(webDir))) return c.text('forbidden', 403);
    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
      '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
    };
    const ct = types[path.extname(abs)] ?? 'application/octet-stream';
    return c.body(fs.readFileSync(abs), 200, { 'content-type': ct });
  });

  return app;
}

function findWebDir(): string | null {
  for (const candidate of [
    path.resolve(__dirname, '../../web'), // dist/server → package root
    path.resolve(__dirname, '../../../web'),
    path.resolve(process.cwd(), 'web'),
  ]) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

function findMarkedUmd(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('marked'); // .../marked/lib/marked.cjs
    for (const name of ['marked.umd.js', 'marked.cjs']) {
      const p = path.join(path.dirname(entry), name);
      if (fs.existsSync(p)) return p;
    }
  } catch {
    /* not installed */
  }
  return null;
}
