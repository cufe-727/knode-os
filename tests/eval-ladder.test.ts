import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmbeddingProvider } from '../src/ingest/embeddings.js';
import { buildFixturePack } from '../src/eval/packs/fixture.js';
import { runEval } from '../src/eval/run.js';
import { RunStore } from '../src/eval/runstore.js';
import { KNODE_FULL_TOOLS } from '../src/eval/systems/knode.js';
import { LADDER_ARMS, ladderBriefs } from '../src/eval/systems/briefs.js';
import { taskPrompt } from '../src/eval/prompts.js';
import { loadPack } from '../src/eval/pack.js';
import { writeReport } from '../src/eval/report.js';
import { DEFAULT_SYSTEMS, expandSystems, makeSystems, SYSTEM_TRACKS } from '../src/eval/systems/index.js';
import { Command } from 'commander';
import { registerEvalCommands } from '../src/eval/cli.js';
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
const promptLog = path.join(tmp, 'prompts.jsonl');
const oldPath = process.env.PATH;

beforeAll(() => {
  buildFixturePack(packDir);
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nexec node "${path.resolve('tests/helpers/fake-codex.mjs')}" "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.FAKE_CODEX_TOOLS_LOG = toolsLog;
  process.env.FAKE_CODEX_PROMPT_LOG = promptLog;
});
afterAll(() => {
  process.env.PATH = oldPath;
  delete process.env.FAKE_CODEX_TOOLS_LOG;
  delete process.env.FAKE_CODEX_PROMPT_LOG;
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

describe('the ladder track', () => {
  it('is the four arms and the single-call track; the diagnostics leave the default set but stay available', () => {
    expect(expandSystems(['ladder'])).toEqual(['agent-grep', 'agent-rag', 'agent-knode-wiki-sources', 'agent-knode-full', 'knode-ask', 'rag-hybrid']);
    expect(SYSTEM_TRACKS['single-call']).toEqual(['knode-ask', 'rag-hybrid']);
    // a track beside ids: in order, each system once
    expect(expandSystems(['closed-book', 'ladder', 'agent-grep', 'agent-knode'])).toEqual(['closed-book', 'agent-grep', 'agent-rag', 'agent-knode-wiki-sources', 'agent-knode-full', 'knode-ask', 'rag-hybrid', 'agent-knode']);
    expect(makeSystems(['ladder']).map((s) => s.id)).toEqual(expandSystems(['ladder']));
    for (const id of expandSystems(['ladder'])) expect(DEFAULT_SYSTEMS, id).toContain(id);
    expect(DEFAULT_SYSTEMS).not.toContain('agent-knode');
    expect(DEFAULT_SYSTEMS).not.toContain('agent-knode-wiki');
    expect(makeSystems(['agent-knode', 'agent-knode-wiki']).map((s) => s.kind)).toEqual(['agent', 'agent']);
    expect(() => makeSystems(['nope'])).toThrow(/tracks: ladder, single-call/);
  });

  it('is listed by `eval systems list` and named in `eval run --help`', async () => {
    const program = new Command().exitOverride();
    registerEvalCommands(program);
    const out: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void out.push(a.join(' '));
    try {
      await program.parseAsync(['node', 'knode-os', 'eval', 'systems', 'list']);
    } finally {
      console.log = log;
    }
    expect(out.join('\n')).toMatch(/^ladder\s+agent-grep, agent-rag, agent-knode-wiki-sources, agent-knode-full, knode-ask, rag-hybrid$/m);
    const run = program.commands.find((c) => c.name() === 'eval')!.commands.find((c) => c.name() === 'run')!;
    expect(run.options.find((o) => o.long === '--systems')!.description).toContain('ladder = agent-grep,agent-rag,agent-knode-wiki-sources,agent-knode-full,knode-ask,rag-hybrid');
  });
});

describe('the four arms', () => {
  it('ask every question with the same brief, apart from what each arm has; the report opens with all five differences', async () => {
    fs.rmSync(promptLog, { force: true });
    const res = await runEval({
      packs: [packDir], systems: ['ladder'], runDir: path.join(tmp, 'runs', 'arms'), quota: false, suites: ['usage'], judgeAudit: 0,
      overrides: { chat: new ScriptedBackend(), judge: scriptedJudge(), embedder },
    });
    const store = new RunStore(res.runDir);
    expect(store.allAnswers().filter((a) => a.error).map((a) => `${a.system} ${a.taskId}: ${a.error}`)).toEqual([]);
    const briefs = ladderBriefs();
    const prompts = fs.readFileSync(promptLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string);
    const questions = new Set(loadPack(packDir).tasks.map((t) => taskPrompt(t)));
    // every session's prompt is one arm's brief, then the question as every system gets it
    const byArm = new Map<string, number>();
    for (const p of prompts) {
      const arm = LADDER_ARMS.find((a) => p.startsWith(`${briefs[a].text}\n\n`) && questions.has(p.slice(briefs[a].text.length + 2)));
      expect(arm, p.slice(0, 200)).toBeDefined();
      byArm.set(arm!, (byArm.get(arm!) ?? 0) + 1);
    }
    for (const arm of LADDER_ARMS) expect(byArm.get(arm), arm).toBe(store.allAnswers().filter((a) => a.system === arm).length);
    // the single-call track answered beside them, on the same two builds
    for (const s of ['knode-ask', 'rag-hybrid']) expect(store.allAnswers().some((a) => a.system === s), s).toBe(true);
    expect(store.allBuilds().filter((b) => !b.system.includes('@')).map((b) => b.system).sort()).toEqual(['knode', 'rag']);
    const report = writeReport(res.runDir);
    expect(report.data.ladder!.map((r) => r.name)).toEqual(['B − A', 'C − A', 'D − C', 'D − A', 'D − B']);
    expect(report.data.ladder!.every((r) => r.n > 0)).toBe(true);
    expect(report.data.discrimination!.systems).toEqual([...LADDER_ARMS].sort());
    expect(report.data.knodeTools!['fixture-life']['agent-knode-full'].map((t) => t.tool).sort()).toEqual(['knode_resolve', 'knode_search']);
    const md = fs.readFileSync(report.md, 'utf8');
    expect(md.indexOf('## The ladder')).toBeLessThan(md.indexOf('## Which questions tell the agents apart'));
  }, 180_000);
});
