import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { createEmbeddingProvider } from '../src/ingest/embeddings.js';
import { dropRun } from '../src/eval/database.js';
import { leakedFiles } from '../src/eval/leak.js';
import { Meter } from '../src/eval/meter.js';
import { loadPack, stageCorpus } from '../src/eval/pack.js';
import { buildFixturePack } from '../src/eval/packs/fixture.js';
import { QuotaGuard } from '../src/eval/quota.js';
import { evalRootDir, evalRunId, evalWorkspaceId, initEvalRoot, isEvaluationRoot, readEvalManifest, readWorkspacePointer, runWorkspaceDir, writeWorkspacePointer } from '../src/eval/root.js';
import { runEval } from '../src/eval/run.js';
import { RunStore } from '../src/eval/runstore.js';
import { startShim } from '../src/eval/shim.js';
import { knodeAsk } from '../src/eval/systems/knode.js';
import type { SystemEnv } from '../src/eval/systems/types.js';
import { createContext } from '../src/context.js';
import { SCHEMA_VERSION } from '../src/store/migrations.js';
import { ScriptedBackend, scriptedJudge } from './helpers/eval-scripted.js';
import { tableDigest } from './helpers/table-digest.js';

/*
 * docs/design/35 stage 1: a run's knode builds are workspaces of an evaluation
 * root — one per run and pack, with a manifest that says what built it and
 * what state it is in — and the run directory keeps only a pointer to each.
 * Resume, reuse, update batches and drop work on that layout, a run made
 * before it resumes on its own, and gold never enters a build.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-workspaces-'));
const packDir = path.join(tmp, 'packs', 'fixture-life');
const embedder = createEmbeddingProvider({ provider: 'local', baseUrl: '', apiKey: '', model: '', dimensions: 384, batchSize: 64, sendDimensions: false });
const runs = path.join(tmp, 'runs');
const root = evalRootDir();
// no agent arm runs here; should one ever be added, it meets the suite's Codex stand-in, never a real Codex
const fakeBin = path.join(tmp, 'fake-bin');
const realPath = process.env.PATH;
beforeAll(() => {
  buildFixturePack(packDir);
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'codex'), `#!/bin/sh\nexec node "${path.resolve('tests/helpers/fake-codex.mjs')}" "$@"\n`);
  fs.chmodSync(path.join(fakeBin, 'codex'), 0o755);
  process.env.PATH = `${fakeBin}:${realPath}`;
});
afterAll(() => {
  process.env.PATH = realPath;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const run = (runDir: string, extra: Partial<Parameters<typeof runEval>[0]> = {}) => runEval({
  packs: [packDir], systems: ['knode-ask', 'knode-sag'], runDir, quota: false, suites: ['usage'], judgeAudit: 0,
  overrides: { chat: new ScriptedBackend(), judge: scriptedJudge(), embedder }, ...extra,
});

/** A run's answers and scores, keyed and without timings: what must not depend on where the build lives. */
function results(runDir: string): { answers: Record<string, unknown>; scores: Record<string, number> } {
  const store = new RunStore(runDir);
  const answers = Object.fromEntries(store.allAnswers().map((a) => [`${a.system}|${a.taskId}|${a.batch ?? ''}`, { text: a.text, citations: a.citations, retrieved: a.retrieved, error: a.error ?? null }]));
  const scores = Object.fromEntries(store.allScores().filter((s) => s.metric !== 'latency_ms').map((s) => [`${s.system}|${s.taskId ?? ''}|${s.metric}|${s.batch ?? ''}`, s.value]));
  return { answers, scores };
}

describe('the evaluation root', () => {
  it('is made marked, with nothing that runs or reaches out on its own, and refuses a live root or a live database', () => {
    const dir = path.join(tmp, 'roots', 'made');
    const { root: made, created } = initEvalRoot(dir, { database: { ...defaultConfig().database, kind: 'pglite' }, live: defaultConfig().database });
    expect(created).toBe(true);
    expect(isEvaluationRoot(dir)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'knode.config.json'), 'utf8'));
    expect(raw.server).toMatchObject({ evaluation: true, port: 12040, host: '127.0.0.1', remote: { enabled: false } });
    expect(raw.dream.schedule).toBe('off');
    expect(raw.ingest.watch).toBe(false);
    expect(raw.datasources).toEqual([]);
    expect(made.owner).toBe('eval');
    // made again: what is there is kept
    expect(initEvalRoot(dir, { database: { ...defaultConfig().database, kind: 'pglite' }, live: defaultConfig().database }).created).toBe(false);

    // a data root that is not an evaluation root is never turned into one
    const live = path.join(tmp, 'roots', 'live');
    fs.mkdirSync(live, { recursive: true });
    fs.writeFileSync(path.join(live, 'knode.config.json'), JSON.stringify({ server: { port: 12000 } }));
    expect(() => initEvalRoot(live, { database: { ...defaultConfig().database, kind: 'pglite' }, live: defaultConfig().database })).toThrow(/not an evaluation root/);
    // nor is a root made on the live database
    const pg = { kind: 'postgres', host: '127.0.0.1', port: 5434, user: 'me', password: '', database: 'knode', schemaPrefix: 'ws' };
    expect(() => initEvalRoot(path.join(tmp, 'roots', 'on-live'), { database: { ...pg, schemaPrefix: 'eval' }, live: pg })).toThrow(/never shares a live root's database/);
    expect(fs.existsSync(path.join(tmp, 'roots', 'on-live'))).toBe(false);
  });

  it('names a build after its run (with its parent when that is not runs) and its pack', () => {
    expect(evalRunId('/x/runs/2026-11-17-08-00-00')).toBe('2026-11-17-08-00-00');
    expect(evalRunId('/x/runs/separation-2026-11/run-10x')).toBe('separation-2026-11-run-10x');
    expect(evalWorkspaceId('separation-2026-11-run-10x', 'synthetic-reports-zh-x10')).toBe('separation-2026-11-run-10x-synthetic-reports-zh-x10');
    const long = evalWorkspaceId('a'.repeat(50), 'b'.repeat(40));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).not.toBe(evalWorkspaceId('a'.repeat(50), `${'b'.repeat(39)}c`));
  });
});

describe('builds as workspaces of the root', () => {
  const first = path.join(runs, 'first');
  const old = path.join(runs, 'old');
  const second = path.join(runs, 'second');

  it('builds in the root, with the same answers and scores as the old layout', async () => {
    await run(first);
    await run(old, { workspacesIn: 'run' });
    const store = new RunStore(first);
    expect(store.meta()).toMatchObject({ workspaces: 'root', evalRoot: root });
    expect(store.allBuilds().find((b) => b.system === 'knode')?.ok).toBe(true);

    // the build: a workspace of the root's owner, and only a pointer to it in the run directory
    const ws = path.join(root, 'users', 'eval', 'workspaces', evalWorkspaceId('first', 'fixture-life'));
    const workDir = store.workDir('fixture-life', 'knode');
    expect(readWorkspacePointer(workDir)).toEqual({ dir: ws, kind: 'pglite' });
    expect(fs.existsSync(path.join(workDir, 'ws'))).toBe(false);
    expect(fs.existsSync(path.join(ws, '.knode', 'db'))).toBe(true);
    const manifest = readEvalManifest(ws)!;
    expect(manifest).toMatchObject({ id: evalWorkspaceId('first', 'fixture-life'), name: 'first · fixture-life', kind: 'personal', owner: 'eval' });
    expect(manifest.evaluation).toMatchObject({
      run: first, runId: 'first', pack: 'fixture-life', group: 'knode', fraction: 1, seed: 0, state: 'built', batchesApplied: [],
      builtWith: { version: expect.any(String), schema: SCHEMA_VERSION },
    });
    expect(manifest.evaluation.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    // let go of when the run ended
    expect(manifest.evaluation.writer).toBeUndefined();
    // the old layout: the workspace in the run directory, nothing of it in the root
    expect(fs.existsSync(path.join(new RunStore(old).workDir('fixture-life', 'knode'), 'ws', '.knode', 'db'))).toBe(true);
    expect(new RunStore(old).meta()!.workspaces).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'users', 'eval', 'workspaces', evalWorkspaceId('old', 'fixture-life')))).toBe(false);

    const a = results(first);
    const b = results(old);
    expect(Object.keys(a.answers).length).toBeGreaterThan(0);
    expect(Object.keys(a.scores).length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  }, 300_000);

  it('resumes on the workspace it has, and an old-layout run resumes on its own', async () => {
    const built = new RunStore(first).allBuilds().find((b) => b.system === 'knode')!;
    const before = results(first);
    await run(first);
    expect(new RunStore(first).allBuilds().find((b) => b.system === 'knode')!.at).toBe(built.at);
    expect(results(first)).toEqual(before);

    // a run made before roots: resumed without saying so, it keeps its builds where they are and asks the update tasks there
    const oldBuilt = new RunStore(old).allBuilds().find((b) => b.system === 'knode')!;
    await run(old, { suites: ['usage', 'update'] });
    const resumed = new RunStore(old);
    expect(resumed.allBuilds().find((b) => b.system === 'knode')!.at).toBe(oldBuilt.at);
    expect(resumed.allBuilds().map((b) => b.system)).toEqual(expect.arrayContaining(['knode@01', 'knode@02']));
    expect(resumed.allAnswers().filter((a) => a.batch && a.system === 'knode-ask' && !a.error).length).toBeGreaterThan(0);
    expect(readWorkspacePointer(resumed.workDir('fixture-life', 'knode'))).toBeNull();
    expect(fs.existsSync(path.join(root, 'users', 'eval', 'workspaces', evalWorkspaceId('old', 'fixture-life')))).toBe(false);
  }, 300_000);

  it('reuses a build as a workspace of its own, applies update batches to it alone, and drops only its own', async () => {
    const source = runWorkspaceDir(first, 'fixture-life');
    const sourceManifest = fs.readFileSync(path.join(source, '.workspace.json'), 'utf8');
    const digestOf = async (ws: string) => {
      const ctx = await createContext(ws, { readOnly: true });
      try {
        return await tableDigest(ctx.store);
      } finally {
        await ctx.store.close();
      }
    };
    const sourceDigest = await digestOf(source);

    await run(second, { reuseBuildsFrom: first, suites: ['usage', 'update'] });
    const store = new RunStore(second);
    expect((store.allBuilds().find((b) => b.system === 'knode')!.notes as { reusedFrom?: string }).reusedFrom).toBe('first');
    expect(store.allAnswers().filter((a) => a.error)).toEqual([]);
    const ws = runWorkspaceDir(second, 'fixture-life');
    expect(ws).toBe(path.join(root, 'users', 'eval', 'workspaces', evalWorkspaceId('second', 'fixture-life')));
    expect(readEvalManifest(ws)!.evaluation).toMatchObject({ run: second, runId: 'second', state: 'built', batchesApplied: ['01', '02'], reusedFrom: first });
    expect(readEvalManifest(ws)!.evaluation.writer).toBeUndefined();
    // the batches grew the copy; the source is as it was
    expect(fs.readFileSync(path.join(source, '.workspace.json'), 'utf8')).toBe(sourceManifest);
    expect(await digestOf(source)).toEqual(sourceDigest);
    expect((await digestOf(ws)).chunks.rows).toBeGreaterThan(sourceDigest.chunks.rows);

    // a pointer to another run's workspace is never followed into a drop
    const stray = path.join(runs, 'stray');
    fs.mkdirSync(path.join(stray, 'work', 'fixture-life', 'knode'), { recursive: true });
    writeWorkspacePointer(path.join(stray, 'work', 'fixture-life', 'knode'), { dir: source, kind: 'pglite' });
    const said: string[] = [];
    expect(await dropRun(stray, { log: (m) => said.push(m) })).toEqual([]);
    expect(said.join('\n')).toMatch(/left .* alone — its manifest names .*first/);
    expect(fs.existsSync(source)).toBe(true);

    expect(await dropRun(second)).toEqual(['pglite']);
    expect(fs.existsSync(ws)).toBe(false);
    expect(readWorkspacePointer(store.workDir('fixture-life', 'knode'))).toBeNull();
    // its records stay; the other run's build is untouched
    expect(new RunStore(second).allAnswers().length).toBeGreaterThan(0);
    expect(fs.existsSync(source)).toBe(true);
    expect(await digestOf(source)).toEqual(sourceDigest);
  }, 300_000);
});

describe('gold never enters a build (D7)', () => {
  it('finds a workspace file that is a gold, holdout or task file', () => {
    const ws = path.join(tmp, 'leak-ws');
    fs.mkdirSync(path.join(ws, 'raw', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'raw', 'docs', 'fine.md'), 'nothing to see');
    expect(leakedFiles(ws, packDir)).toEqual([]);
    fs.copyFileSync(path.join(packDir, 'gold', 'facts.jsonl'), path.join(ws, 'raw', 'docs', 'notes.md'));
    const tasks = fs.readdirSync(path.join(packDir, 'tasks'))[0];
    fs.copyFileSync(path.join(packDir, 'tasks', tasks), path.join(ws, 'wiki-copy.txt'));
    expect(leakedFiles(ws, packDir).sort((x, y) => x.file.localeCompare(y.file))).toEqual([
      { file: 'raw/docs/notes.md', matches: 'gold/facts.jsonl' },
      { file: 'wiki-copy.txt', matches: `tasks/${tasks}` },
    ]);
  });

  it('fails a build whose staged corpus holds a planted gold file, and says so in its manifest', async () => {
    const pack = loadPack(packDir);
    const staged = stageCorpus(pack);
    // planted after staging, as a bug in staging would leave it
    fs.copyFileSync(path.join(packDir, 'gold', 'facts.jsonl'), path.join(staged.dir, 'planted.md'));
    const meter = new Meter();
    const shim = await startShim({ backend: new ScriptedBackend(), embedder, meter });
    const runDir = path.join(runs, 'leaky');
    const env: SystemEnv = {
      runId: 'leaky', pack, staged, workDir: new RunStore(runDir).workDir('fixture-life', 'knode'), shim, meter,
      quota: new QuotaGuard({ enabled: false }), models: { model: '', buildEffort: 'low', answerEffort: 'medium' }, log: () => {},
      evalRoot: { root, owner: 'eval', run: runDir, runId: 'leaky', fraction: 1, seed: 0, builtWith: { version: 'test', commit: null, schema: SCHEMA_VERSION } },
    };
    const sys = knodeAsk();
    try {
      await expect(sys.build!(env)).rejects.toThrow(/gold leaked into the workspace after staging.*raw\/docs\/planted\.md \(= gold\/facts\.jsonl\)/);
      const manifest = readEvalManifest(path.join(root, 'users', 'eval', 'workspaces', 'leaky-fixture-life'))!;
      expect(manifest.evaluation.state).toBe('failed');
      expect(manifest.evaluation.error).toMatch(/gold leaked/);
    } finally {
      await sys.finish!(env);
      await shim.close();
      staged.cleanup();
    }
  }, 120_000);
});
