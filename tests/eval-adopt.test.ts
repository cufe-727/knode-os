import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContext } from '../src/context.js';
import { createEmbeddingProvider } from '../src/ingest/embeddings.js';
import { adoptRun } from '../src/eval/adopt.js';
import { buildFixturePack } from '../src/eval/packs/fixture.js';
import { evalRootDir, evalWorkspaceId, readEvalManifest } from '../src/eval/root.js';
import { runEval } from '../src/eval/run.js';
import { evaluationListing } from '../src/server/evaluation.js';
import { SCHEMA_VERSION } from '../src/store/migrations.js';
import { ScriptedBackend, scriptedJudge } from './helpers/eval-scripted.js';
import { tableDigest } from './helpers/table-digest.js';

/*
 * docs/design/35 §3: `eval adopt` copies the builds of a run made before
 * evaluation roots into the root, so the viewer can open them, and leaves the
 * run directory exactly as it was.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-adopt-'));
const packDir = path.join(tmp, 'packs', 'fixture-life');
const runDir = path.join(tmp, 'runs', 'before-roots');
const root = evalRootDir();
const embedder = createEmbeddingProvider({ provider: 'local', baseUrl: '', apiKey: '', model: '', dimensions: 384, batchSize: 64, sendDimensions: false });

/** Every file under `dir` with a hash of its bytes. */
function filesOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else out[r] = crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, r))).digest('hex');
    }
  };
  walk('');
  return out;
}

async function digest(dir: string) {
  const ctx = await createContext(dir, { readOnly: true });
  try {
    return await tableDigest(ctx.store);
  } finally {
    await ctx.store.close();
  }
}

beforeAll(async () => {
  buildFixturePack(packDir);
  // a run as runs were made before roots: its build in its own directory, updated by two batches
  await runEval({
    packs: [packDir], systems: ['knode-ask'], runDir, quota: false, suites: ['usage', 'update'], skipScoring: true, workspacesIn: 'run',
    overrides: { chat: new ScriptedBackend(), judge: scriptedJudge(), embedder },
  });
}, 300_000);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('eval adopt', () => {
  it("copies an old run's build into the root as a workspace the viewer opens, and changes nothing of the run", async () => {
    const source = path.join(runDir, 'work', 'fixture-life', 'knode', 'ws');
    const sourceTables = await digest(source);
    // after the look above: an embedded database's files change on any open (its rows do not)
    const runBefore = filesOf(runDir);
    const said: string[] = [];
    const [ws] = await adoptRun(runDir, { log: (m) => said.push(m) });
    expect(ws).toBe(path.join(root, 'users', 'eval', 'workspaces', evalWorkspaceId('before-roots', 'fixture-life')));
    expect(readEvalManifest(ws)).toMatchObject({
      name: 'before-roots · fixture-life', owner: 'eval',
      evaluation: { run: runDir, pack: 'fixture-life', state: 'built', batchesApplied: ['01', '02'], adoptedFrom: source, builtWith: { schema: SCHEMA_VERSION } },
    });
    expect(said.join('\n')).toMatch(/adopted as/);
    // the same index, now the copy's own
    expect(await digest(ws)).toEqual(sourceTables);
    expect(JSON.parse(fs.readFileSync(path.join(ws, '.knode', 'eval-index.json'), 'utf8'))).toEqual({ kind: 'pglite', workspace: ws });
    const listed = evaluationListing(root, 'eval').find((w) => w.id === path.basename(ws))!;
    expect(listed.evaluation).toMatchObject({ openable: true, batchesApplied: ['01', '02'] });

    // adopted again: left as it is
    expect(await adoptRun(runDir)).toEqual([ws]);
    expect(fs.readdirSync(path.dirname(ws)).filter((n) => n.startsWith(path.basename(ws)))).toEqual([path.basename(ws)]);
    // the run directory is as it was, byte for byte
    const after = filesOf(runDir);
    expect(Object.keys(after).filter((f) => after[f] !== runBefore[f])).toEqual([]);
    expect(after).toEqual(runBefore);
  }, 120_000);

  it('refuses a run whose builds are in a root already', async () => {
    const newer = path.join(tmp, 'runs', 'in-root');
    await runEval({ packs: [packDir], systems: ['knode-ask'], runDir: newer, quota: false, suites: ['usage'], skipScoring: true, overrides: { chat: new ScriptedBackend(), judge: scriptedJudge(), embedder } });
    await expect(adoptRun(newer)).rejects.toThrow(/keeps its builds in the evaluation root already/);
  }, 120_000);
});
