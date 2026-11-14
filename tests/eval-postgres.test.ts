import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, type DatabaseConfig } from '../src/config.js';
import { createEmbeddingProvider } from '../src/ingest/embeddings.js';
import { describeDatabase, dropRun, EVAL_DATABASE, evalDatabase, listEvalSchemas, orphanedEvalSchemas, sameDatabase, storableDatabase } from '../src/eval/database.js';
import { buildFixturePack } from '../src/eval/packs/fixture.js';
import { writeReport } from '../src/eval/report.js';
import { runEval } from '../src/eval/run.js';
import { RunStore } from '../src/eval/runstore.js';
import { ScriptedBackend, scriptedJudge } from './helpers/eval-scripted.js';

/**
 * docs/design/31 D1: evaluation workspaces on the product's backend, in a
 * database of their own. The config rules and the refusal need no server; the
 * runs need a PostgreSQL with pgvector, reached as tests/backend-postgres*.ts
 * reach one (KNODE_TEST_PG_HOST / _PORT / _USER / _PASSWORD), and are skipped
 * without it. Each file run uses a throwaway database of its own and drops it.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-eval-pg-'));
const pgBase: DatabaseConfig = {
  kind: 'postgres', host: '127.0.0.1', port: 5434, user: 'me', password: 'hunter2', database: 'knode', schemaPrefix: 'ws',
};
const fakeBin = path.join(tmp, 'fake-bin');
const realPath = process.env.PATH;
beforeAll(() => {
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'codex'), `#!/bin/sh\nexec node "${path.resolve('tests/helpers/fake-codex.mjs')}" "$@"\n`);
  fs.chmodSync(path.join(fakeBin, 'codex'), 0o755);
  process.env.PATH = `${fakeBin}:${realPath}`;
});
afterAll(() => {
  process.env.PATH = realPath;
});

describe('the evaluation database', () => {
  it('stays on PGlite for a PGlite config, and moves a PostgreSQL one to knode_eval with the eval prefix', () => {
    const lite = evalDatabase({ ...pgBase, kind: 'pglite', path: '/live/.knode/db' });
    expect(lite).toEqual({ ...defaultConfig().database, kind: 'pglite' });
    expect(lite.path).toBeUndefined();
    const onServer = evalDatabase(pgBase, { poolSize: 40 });
    expect(onServer).toMatchObject({ kind: 'postgres', host: '127.0.0.1', port: 5434, database: EVAL_DATABASE, schemaPrefix: 'eval', poolSize: 16 });
    expect(evalDatabase({ ...pgBase, url: 'postgres://me:pw@db.local:6543/knode' }).url).toBe('postgres://me:pw@db.local:6543/knode_eval');
    // a URL names the server, and the database when it names one
    expect(evalDatabase(pgBase, { url: 'postgres://me@127.0.0.1:55433' })).toMatchObject({ database: EVAL_DATABASE, url: 'postgres://me@127.0.0.1:55433/knode_eval' });
    expect(evalDatabase(pgBase, { url: 'postgres://me@127.0.0.1:55433/bench' }).database).toBe('bench');
    expect(() => evalDatabase({ ...pgBase, kind: 'plugin-store' })).toThrow(/pglite or postgres/);
  });

  it('writes no credential into a workspace config, and names servers without one', () => {
    const stored = storableDatabase(evalDatabase(pgBase, { url: 'postgres://me:secret@127.0.0.1:55433/bench' }));
    expect(JSON.stringify(stored)).not.toContain('secret');
    expect(stored.url).toMatch(/^env:/);
    expect(process.env[stored.url!.slice(4)]).toContain('secret');
    const plain = storableDatabase(evalDatabase(pgBase));
    expect(JSON.stringify(plain)).not.toContain('hunter2');
    expect(describeDatabase(evalDatabase(pgBase, { url: 'postgres://me:secret@localhost:55433/bench' }))).toBe('postgres 127.0.0.1:55433/bench');
  });

  it('tells the same database on one server apart from another database or server', () => {
    expect(sameDatabase(pgBase, { ...pgBase, host: 'localhost', user: 'other' })).toBe(true);
    expect(sameDatabase(pgBase, { ...pgBase, url: 'postgres://x@127.0.0.1:5434/knode' })).toBe(true);
    expect(sameDatabase(pgBase, evalDatabase(pgBase))).toBe(false);
    expect(sameDatabase(pgBase, { ...pgBase, port: 5432 })).toBe(false);
    expect(sameDatabase({ ...pgBase, kind: 'pglite' }, { ...pgBase, kind: 'pglite' })).toBe(false);
  });

  it("refuses to start a run on the --config-from workspace's own database, before anything is spent", async () => {
    const ws = path.join(tmp, 'live-ws');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'knode.config.json'), JSON.stringify({ database: { ...pgBase, password: '' } }));
    const backend = new ScriptedBackend();
    const common = { packs: [path.join(tmp, 'no-pack')], systems: ['knode-ask'], quota: false, configFrom: ws, overrides: { chat: backend, judge: scriptedJudge() } };
    await expect(runEval({ ...common, runDir: path.join(tmp, 'runs', 'refused'), databaseUrl: 'postgres://me@localhost:5434/knode' })).rejects.toThrow(/the --config-from workspace .* uses/);
    expect(backend.calls).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'runs', 'refused', 'run.json'))).toBe(false);
  });
});

/* -------------------------- on a PostgreSQL server -------------------------- */

const DB_PREFIX = 'knode_eval_test_';
const runDatabase = `${DB_PREFIX}${Math.floor(Date.now() / 1000)}_${crypto.randomBytes(4).toString('hex')}`;
const server = {
  host: process.env.KNODE_TEST_PG_HOST ?? '127.0.0.1',
  port: Number(process.env.KNODE_TEST_PG_PORT ?? 5432),
  user: process.env.KNODE_TEST_PG_USER ?? os.userInfo().username,
  password: process.env.KNODE_TEST_PG_PASSWORD ?? '',
};
const databaseUrl = `postgres://${encodeURIComponent(server.user)}${server.password ? `:${encodeURIComponent(server.password)}` : ''}@${server.host}:${server.port}/${runDatabase}`;

function adminPool(database = 'postgres'): pg.Pool {
  return new pg.Pool({ ...server, user: server.user || undefined, ...(server.password ? {} : { password: undefined }), database, max: 1, connectionTimeoutMillis: 2000 });
}

async function postgresReady(): Promise<boolean> {
  const pool = adminPool();
  try {
    return (await pool.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)).rows.length > 0;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
}

const ready = await postgresReady();

async function inRunDatabase<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const pool = adminPool(runDatabase);
  try {
    return (await pool.query(sql, params)).rows as T[];
  } finally {
    await pool.end();
  }
}

describe.skipIf(!ready)('an evaluation on PostgreSQL', () => {
  const packDir = path.join(tmp, 'packs', 'fixture-life');
  const embedder = createEmbeddingProvider({ provider: 'local', baseUrl: '', apiKey: '', model: '', dimensions: 384, batchSize: 64, sendDimensions: false });
  const judge = scriptedJudge();
  const first = path.join(tmp, 'runs', 'pg-first');
  const systems = ['knode-ask', 'knode-sag', 'agent-knode', 'agent-knode-wiki', 'agent-grep', 'rag-hybrid', 'closed-book'];
  const schemaOf = (runDir: string) => (new RunStore(runDir).allBuilds().find((b) => b.system === 'knode')!.notes as { schema?: string }).schema;
  const chunks = async (schema: string) => Number((await inRunDatabase<{ n: number }>(`SELECT count(*)::int AS n FROM "${schema}".chunks`))[0].n);

  beforeAll(() => {
    buildFixturePack(packDir);
  });
  afterAll(async () => {
    const pool = adminPool();
    try {
      await pool.query(`DROP DATABASE IF EXISTS "${runDatabase}" WITH (FORCE)`);
    } finally {
      await pool.end();
    }
  });

  it('builds, updates, answers and scores the fixture pack with every knode index in a schema of its own', async () => {
    const res = await runEval({ packs: [packDir], systems, runDir: first, quota: false, databaseUrl, overrides: { chat: new ScriptedBackend(), judge, embedder } });
    const store = new RunStore(res.runDir);
    expect(store.allBuilds().every((b) => b.ok)).toBe(true);
    expect(store.allBuilds().map((b) => b.system)).toEqual(expect.arrayContaining(['knode', 'knode@01', 'knode@02']));
    const answers = store.allAnswers();
    expect(answers.filter((a) => a.error).map((a) => `${a.system}/${a.taskId}: ${a.error}`)).toEqual([]);
    for (const s of ['knode-ask', 'agent-knode', 'agent-knode-wiki', 'rag-hybrid']) expect(answers.filter((a) => a.system === s).length, s).toBeGreaterThan(0);
    expect(answers.find((a) => a.system === 'agent-knode' && a.taskId === 'q1')!.commands).toEqual(['mcp:knode.knode_resolve {"query":"林晓的岗位"}', 'mcp:knode.knode_read {"path":"raw/docs/email/2026-03-05.md"}']);
    expect(store.allScores().some((s) => s.system === 'knode-ask' && s.metric === 'correctness')).toBe(true);
    // where the index was, on the run and on the build, and nothing of it in the workspace's own directory
    expect(store.meta()!.database).toEqual({ kind: 'postgres', at: `postgres ${server.host === 'localhost' ? '127.0.0.1' : server.host}:${server.port}/${runDatabase}`, poolSize: 3 });
    const schema = schemaOf(first)!;
    expect(schema).toMatch(/^eval_ws_[0-9a-f]{8}$/);
    const ws = path.join(store.workDir('fixture-life', 'knode'), 'ws');
    expect(fs.existsSync(path.join(ws, '.knode', 'db'))).toBe(false);
    expect(await chunks(schema)).toBeGreaterThan(0);
    expect((await listEvalSchemas(evalDatabase(defaultConfig().database, { url: databaseUrl }))).find((s) => s.schema === schema)?.workspace).toBe(path.resolve(ws));
    expect(fs.readFileSync(writeReport(res.runDir).md, 'utf8')).toContain(`knode index: postgres`);
  }, 300_000);

  it('clones a reused build\'s schema, so updating the new run leaves the old one\'s index as it was', async () => {
    // the first run updated its knode build, so build a base one that did not
    const base = path.join(tmp, 'runs', 'pg-base');
    await runEval({ packs: [packDir], systems: ['knode-ask'], runDir: base, quota: false, suites: ['usage'], skipScoring: true, databaseUrl, overrides: { chat: new ScriptedBackend(), judge, embedder } });
    const before = await chunks(schemaOf(base)!);
    const lines: string[] = [];
    const reuse = path.join(tmp, 'runs', 'pg-reuse');
    await runEval({ packs: [packDir], systems: ['knode-ask', 'agent-knode'], runDir: reuse, quota: false, suites: ['usage', 'update'], skipScoring: true, databaseUrl, reuseBuildsFrom: base, onProgress: (m) => lines.push(m), overrides: { chat: new ScriptedBackend(), judge, embedder } });
    expect(lines.some((l) => /cloned schema eval_ws_\w+ into eval_ws_\w+/.test(l))).toBe(true);
    const store = new RunStore(reuse);
    expect((store.allBuilds().find((b) => b.system === 'knode')!.notes as { reusedFrom?: string }).reusedFrom).toBe('pg-base');
    expect(store.allAnswers().filter((a) => a.error)).toEqual([]);
    expect(store.allAnswers().some((a) => a.system === 'knode-ask' && a.batch === '02')).toBe(true);
    const record = JSON.parse(fs.readFileSync(path.join(store.workDir('fixture-life', 'knode'), 'ws', '.knode', 'eval-index.json'), 'utf8')) as { schema: string };
    expect(record.schema).not.toBe(schemaOf(base));
    // the update batches grew the clone, not the base
    expect(await chunks(record.schema)).toBeGreaterThan(before);
    expect(await chunks(schemaOf(base)!)).toBe(before);
  }, 300_000);

  it('builds afresh, saying why, when the reused build\'s schema is gone', async () => {
    const gone = path.join(tmp, 'runs', 'pg-gone');
    await runEval({ packs: [packDir], systems: ['knode-ask'], runDir: gone, quota: false, suites: ['usage'], skipScoring: true, databaseUrl, overrides: { chat: new ScriptedBackend(), judge, embedder } });
    await inRunDatabase(`DROP SCHEMA "${schemaOf(gone)}" CASCADE`);
    const lines: string[] = [];
    const again = path.join(tmp, 'runs', 'pg-again');
    await runEval({ packs: [packDir], systems: ['knode-ask'], runDir: again, quota: false, suites: ['usage'], skipScoring: true, databaseUrl, reuseBuildsFrom: gone, onProgress: (m) => lines.push(m), overrides: { chat: new ScriptedBackend(), judge, embedder } });
    expect(lines.some((l) => /cannot reuse the build of pg-gone \(the reused build's schema eval_ws_\w+ is not in .*\): building afresh/.test(l))).toBe(true);
    const store = new RunStore(again);
    const build = store.allBuilds().find((b) => b.system === 'knode')!;
    expect(build.ok).toBe(true);
    expect((build.notes as { reusedFrom?: string }).reusedFrom).toBeUndefined();
    expect(store.allAnswers().filter((a) => a.system === 'knode-ask' && !a.error).length).toBeGreaterThan(0);
  }, 300_000);

  it('refuses to resume a run on another backend', async () => {
    await expect(runEval({ packs: [packDir], systems: ['knode-ask'], runDir: first, quota: false, overrides: { chat: new ScriptedBackend(), judge, embedder } }))
      .rejects.toThrow(/keeps its indexes on postgres .* results on two backends are not pooled/);
  });

  it('drops a run\'s schemas, and lists and drops the ones whose run directory is gone', async () => {
    const cfg = evalDatabase(defaultConfig().database, { url: databaseUrl });
    const schema = schemaOf(first)!;
    expect(await dropRun(first, { url: databaseUrl })).toContain(schema);
    expect((await listEvalSchemas(cfg)).map((s) => s.schema)).not.toContain(schema);
    // a run directory deleted outright: its schema is listed at the next run's start, and only dropped on request
    const other = schemaOf(path.join(tmp, 'runs', 'pg-reuse'));
    const otherRecord = JSON.parse(fs.readFileSync(path.join(new RunStore(path.join(tmp, 'runs', 'pg-reuse')).workDir('fixture-life', 'knode'), 'ws', '.knode', 'eval-index.json'), 'utf8')) as { schema: string };
    fs.rmSync(path.join(tmp, 'runs', 'pg-reuse'), { recursive: true, force: true });
    expect((await orphanedEvalSchemas(cfg)).map((s) => s.schema)).toEqual([otherRecord.schema]);
    expect(other).toBeDefined();
    const lines: string[] = [];
    await runEval({ packs: [packDir], systems: ['rag-bm25'], runDir: path.join(tmp, 'runs', 'pg-list'), quota: false, suites: ['usage'], skipScoring: true, databaseUrl, onProgress: (m) => lines.push(m), overrides: { chat: new ScriptedBackend(), judge, embedder } });
    expect(lines.some((l) => l.includes(`1 evaluation schemas in ${describeDatabase(cfg)} belong to workspaces that are gone (${otherRecord.schema})`))).toBe(true);
    expect((await listEvalSchemas(cfg)).map((s) => s.schema)).toContain(otherRecord.schema);
  }, 300_000);
});
