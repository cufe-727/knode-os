import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmbeddingProvider } from '../src/ingest/embeddings.js';
import { buildFixturePack } from '../src/eval/packs/fixture.js';
import { runEval } from '../src/eval/run.js';
import { RunStore } from '../src/eval/runstore.js';
import { KNODE_FULL_TOOLS } from '../src/eval/systems/knode.js';
import { ScriptedBackend, scriptedJudge } from './helpers/eval-scripted.js';

/**
 * The evaluation ladder (docs/design/33 §2) end to end on the fixture pack,
 * with a stand-in Codex: arm D, `agent-knode-full`, is arm C's folder (the
 * knode wiki and the sources) plus knode's six retrieval tools, on the knode
 * build the other knode systems share.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-ladder-'));
const packDir = path.join(tmp, 'pack');
const embedder = createEmbeddingProvider({ provider: 'local', baseUrl: '', apiKey: '', model: '', dimensions: 384, batchSize: 64, sendDimensions: false });
const toolsLog = path.join(tmp, 'tools.log');
const oldPath = process.env.PATH;

beforeAll(() => {
  buildFixturePack(packDir);
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nexec node "${path.resolve('tests/helpers/fake-codex.mjs')}" "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.FAKE_CODEX_TOOLS_LOG = toolsLog;
});
afterAll(() => {
  process.env.PATH = oldPath;
  delete process.env.FAKE_CODEX_TOOLS_LOG;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('arm D: agent-knode-full', () => {
  it('reads the wiki and the sources with the shell and calls only knode\'s retrieval tools, on the shared knode build', async () => {
    const res = await runEval({
      packs: [packDir], systems: ['agent-knode-wiki-sources', 'agent-knode-full'], runDir: path.join(tmp, 'runs', 'd'), quota: false, suites: ['usage'], judgeAudit: 0,
      overrides: { chat: new ScriptedBackend(), judge: scriptedJudge(), embedder },
    });
    const store = new RunStore(res.runDir);
    expect(store.allBuilds().filter((b) => !b.system.includes('@')).map((b) => [b.system, b.ok])).toEqual([['knode', true]]);
    const answers = store.allAnswers().filter((a) => a.system === 'agent-knode-full');
    expect(answers.length).toBeGreaterThan(0);
    expect(answers.filter((a) => a.error).map((a) => `${a.taskId}: ${a.error}`)).toEqual([]);
    const a = answers.find((x) => x.taskId === 'q1')!;
    expect(a.commands).toEqual([
      'mcp:knode.knode_resolve {"query":"林晓的岗位"}', 'mcp:knode.knode_search {"query":"林晓 岗位","k":3}',
      'rg -n 林晓 .', `/bin/zsh -lc "rg -l '林晓' . | head -n 5"`,
    ]);
    // both calls reached the build's index and came back
    expect(a.outputs!.slice(0, 2).every((o) => o && o.chars > 0 && !o.failed)).toBe(true);
    // every session's server offered the six retrieval tools, and nothing the shell does
    const offered = new Set(fs.readFileSync(toolsLog, 'utf8').trim().split('\n'));
    expect(offered).toEqual(new Set([[...KNODE_FULL_TOOLS].sort().join(',')]));
    expect(KNODE_FULL_TOOLS).not.toContain('knode_grep');
    expect(KNODE_FULL_TOOLS).not.toContain('knode_read');
    expect(KNODE_FULL_TOOLS).not.toContain('knode_ls');
  }, 180_000);
});
