import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import type { LlmEffort } from '../config.js';
import { LlmClient } from '../llm/client.js';
import { exportAudit, importAudit } from './audit.js';
import { installExternal } from './install.js';
import { loadPack, packsDir, validatePack } from './pack.js';
import { listRecipes, recipe } from './packs/index.js';
import './packs/recipes.js';
import { writeReport } from './report.js';
import { runEval } from './run.js';
import { DEFAULT_SYSTEMS, SYSTEMS } from './systems/index.js';
import { EXTERNAL_SYSTEMS, externalPacks, venvPython } from './systems/external.js';
import { Suite, SUITES } from './types.js';

/**
 * `knode-os eval …` (docs/design/23 §7): build and validate benchmark packs,
 * install the external systems, run a benchmark and render its report.
 */

const csv = (v: string | undefined) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

function resolvePack(arg: string): string {
  if (fs.existsSync(path.join(arg, 'pack.json'))) return path.resolve(arg);
  const named = path.join(packsDir(), arg);
  if (fs.existsSync(path.join(named, 'pack.json'))) return named;
  throw new Error(`no pack at ${arg} or ${named}`);
}

export function registerEvalCommands(program: Command): void {
  const evalCmd = program.command('eval').description('knowledge benchmark suite: packs, systems, runs, reports (docs/design/23; data in ~/knode-eval)');

  const pack = evalCmd.command('pack').description('benchmark packs');
  pack
    .command('list')
    .description('list pack recipes and the packs already built')
    .action(() => {
      for (const r of listRecipes()) console.log(`${r.id.padEnd(22)} ${r.domain.padEnd(11)} ${r.network ? 'downloads ' : '          '}${r.needsAuthor ? 'author-model ' : '             '}${r.title}`);
      const dir = packsDir();
      const built = fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'pack.json'))) : [];
      console.log(`\nbuilt packs in ${dir}: ${built.length ? built.join(', ') : '(none)'}`);
    });
  pack
    .command('build <recipe>')
    .description('build a pack from a recipe (downloads into ~/knode-eval/sources; gold drafted by the author model)')
    .option('--out <dir>', 'pack directory (default ~/knode-eval/packs/<recipe>)')
    .option('--limit <n>', 'at most this many documents')
    .option('--seed <seed>', 'sampling seed', '0')
    .option('--author <provider>', 'model that drafts gold and tasks: claude-cli | codex-cli', 'claude-cli')
    .option('--author-model <model>', 'its model (default: the CLI default)', '')
    .option('--options <json>', 'recipe options as JSON', '{}')
    .action(async (id: string, opts) => {
      const r = recipe(id);
      const out = path.resolve(opts.out ?? path.join(packsDir(), id));
      const author = r.needsAuthor ? new LlmClient({ provider: opts.author, baseUrl: '', apiKey: '', model: opts.authorModel, cliPath: '', cliTimeoutMs: 900_000 }) : undefined;
      const issues = await r.build(out, { limit: opts.limit ? Number(opts.limit) : undefined, seed: opts.seed, author, options: JSON.parse(opts.options), log: (m) => console.log(`  ${m}`) });
      for (const w of issues.warnings) console.log(`  warning: ${w}`);
      if (issues.errors.length) {
        for (const e of issues.errors.slice(0, 30)) console.log(`  error: ${e}`);
        process.exitCode = 1;
      }
      const p = loadPack(out);
      console.log(`\n${p.manifest.id}: ${p.docs.length} documents, ${p.tasks.length} tasks, ${p.facts.length} gold facts → ${out}`);
    });
  pack
    .command('validate <dir>')
    .description('check a pack: evidence quotes, duplicate ids, scoring gold')
    .action((dir: string) => {
      const p = loadPack(resolvePack(dir));
      const issues = validatePack(p);
      for (const w of issues.warnings) console.log(`warning: ${w}`);
      for (const e of issues.errors) console.log(`error: ${e}`);
      console.log(`${p.manifest.id}: ${p.docs.length} documents, ${p.tasks.length} tasks, ${p.facts.length} facts — ${issues.errors.length ? 'INVALID' : 'ok'}`);
      if (issues.errors.length) process.exitCode = 1;
    });

  const systems = evalCmd.command('systems').description('systems under test');
  systems
    .command('list')
    .description('list the systems a run can compare')
    .action(() => {
      for (const id of Object.keys(SYSTEMS)) {
        const s = SYSTEMS[id]();
        const ext = (EXTERNAL_SYSTEMS as readonly string[]).includes(id);
        console.log(`${id.padEnd(18)} ${s.kind.padEnd(9)} ${s.answers ? 'answers ' : 'retrieval'} ${s.label}${ext ? ` — ${fs.existsSync(venvPython(id)) ? 'installed' : 'not installed'}, packs: ${externalPacks().join(', ')}` : ''}`);
      }
    });
  systems
    .command('install <id>')
    .description('install an external system (graphrag | lightrag | hipporag) into ~/knode-eval/venvs/<id> with uv')
    .option('--pin <version>', 'package version to install (default: the newest release at least two weeks old)')
    .action(async (id: string, opts) => {
      const r = await installExternal(id, { version: opts.pin, log: (m) => console.log(`  ${m}`) });
      console.log(`\n${id} ${r.version} installed in ${r.dir}`);
    });

  evalCmd
    .command('run')
    .description('run a benchmark: build every system on each pack, answer, score, report')
    .requiredOption('--pack <packs>', 'comma-separated pack directories or names under ~/knode-eval/packs')
    .option('--systems <list>', `comma-separated (default: ${DEFAULT_SYSTEMS.join(',')})`)
    .option('--suites <list>', `comma-separated: ${SUITES.join(',')}`)
    .option('--run-dir <dir>', 'resume this run directory')
    .option('--config-from <workspace>', 'knode workspace whose embedder the run uses (read-only)')
    .option('--embedding <kind>', 'workspace | local', 'workspace')
    .option('--model <model>', 'Codex model every system uses', '')
    .option('--build-effort <e>', 'reasoning effort for building', 'low')
    .option('--answer-effort <e>', 'reasoning effort for answering', 'medium')
    .option('--judge <provider>', 'judge CLI provider', 'claude-cli')
    .option('--judge-model <model>', 'judge model', '')
    .option('--limit <n>', 'tasks per pack (stratified by type)')
    .option('--agent-limit <n>', 'tasks per pack for agent systems', '30')
    .option('--fraction <f>', 'share of the corpus to use (scale curves)', '1')
    .option('--seed <seed>', 'sampling seed', '0')
    .option('--slots <n>', 'concurrent model calls', '6')
    .option('--embedding-cap <tokens>', 'stop embedding after this many tokens in the run')
    .option('--no-quota', 'do not pause for Codex plan windows')
    .option('--skip-scoring', 'answer only; score later with `eval run --run-dir`')
    .action(async (opts) => {
      const res = await runEval({
        packs: csv(opts.pack)!.map(resolvePack),
        systems: csv(opts.systems) ?? DEFAULT_SYSTEMS,
        suites: (csv(opts.suites) as Suite[] | undefined) ?? [...SUITES],
        runDir: opts.runDir,
        configFrom: opts.configFrom,
        embedding: opts.embedding,
        model: opts.model,
        buildEffort: opts.buildEffort as LlmEffort,
        answerEffort: opts.answerEffort as LlmEffort,
        judgeProvider: opts.judge,
        judgeModel: opts.judgeModel,
        limit: opts.limit ? Number(opts.limit) : undefined,
        agentLimit: Number(opts.agentLimit),
        fraction: Number(opts.fraction),
        seed: opts.seed,
        slots: Number(opts.slots),
        embeddingTokenCap: opts.embeddingCap ? Number(opts.embeddingCap) : undefined,
        quota: opts.quota,
        skipScoring: opts.skipScoring,
        onProgress: (m) => console.log(`  ${m}`),
      });
      const report = writeReport(res.runDir);
      console.log(`\n${res.builds} builds, ${res.answers} answers, ${res.scores} scores\nreport: ${report.md}`);
    });
  evalCmd
    .command('report <runDir>')
    .description('render report.md and report.json from a run directory')
    .action((runDir: string) => {
      const r = writeReport(path.resolve(runDir));
      console.log(r.md);
    });
  const audit = evalCmd.command('audit').description('human audit of judge verdicts');
  audit
    .command('export <runDir>')
    .description('write a CSV of sampled judged answers for a person to label')
    .option('--n <n>', 'items', '60')
    .action((runDir: string, opts) => console.log(exportAudit(path.resolve(runDir), Number(opts.n))));
  audit
    .command('import <runDir> <csv>')
    .description('read the labelled CSV back and report agreement with the judge')
    .action((runDir: string, file: string) => console.log(JSON.stringify(importAudit(path.resolve(runDir), file), null, 2)));
}
