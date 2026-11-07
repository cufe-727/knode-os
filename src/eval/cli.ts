import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import type { LlmEffort } from '../config.js';
import { LlmClient } from '../llm/client.js';
import { exportAudit, importAudit } from './audit.js';
import { installExternal } from './install.js';
import { QuotaGuard, withRefusalRetry } from './quota.js';
import { loadPack, packsDir, validatePack } from './pack.js';
import { listRecipes, recipe } from './packs/index.js';
import { extendPack } from './packs/extend.js';
import './packs/recipes.js';
import { buildScaleData, renderScale, writeReport } from './report.js';
import { runEval, scoreRun } from './run.js';
import { Meter, sumEvents } from './meter.js';
import { RunStore } from './runstore.js';
import { DEFAULT_SYSTEMS, SYSTEMS } from './systems/index.js';
import { EXTERNAL_SYSTEMS, externalPacks, venvPython } from './systems/external.js';
import { Suite, SUITES, TASK_TYPES, TaskType } from './types.js';
import { loadConfig } from '../config.js';
import { ModelChain, parseChain, SpendLedger } from './chain.js';

/** The author model: a budgeted chain over a workspace's connections, or one CLI (docs/design/23 D18). */
function authorClient(opts: { author: string | false; authorModel?: string; authorChain?: string; configFrom?: string }, guard: QuotaGuard): LlmClient | undefined {
  if (opts.author === false) return undefined;
  if (opts.authorChain) {
    const ledger = new SpendLedger();
    const config = opts.configFrom ? loadConfig(opts.configFrom) : null;
    return new ModelChain(parseChain(opts.authorChain, config, { ledger }), ledger, (m) => console.log(`  ${m}`)).asClient();
  }
  return withRefusalRetry(new LlmClient({ provider: opts.author, baseUrl: '', apiKey: '', model: opts.authorModel ?? '', cliPath: '', cliTimeoutMs: 900_000 }), guard);
}

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
    .option('--author-chain <chain>', 'budgeted chain instead, e.g. anthropic-api:100,codex-cli (connections of --config-from)')
    .option('--config-from <workspace>', 'workspace whose connections the author chain uses (read-only)')
    .option('--options <json>', 'recipe options as JSON', '{}')
    .action(async (id: string, opts) => {
      const r = recipe(id);
      const out = path.resolve(opts.out ?? path.join(packsDir(), id));
      const guard = new QuotaGuard({ enabled: false, log: (m) => console.log(`  ${m}`) });
      const author = r.needsAuthor ? authorClient(opts, guard) : undefined;
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
    .command('extend <pack>')
    .description('add corpus-level tasks (aggregate, timeline, contradiction, profile, deep chains) and padding to a built pack, leaving its corpus as it is')
    .option('--author <provider>', 'model that drafts the tasks: claude-cli | codex-cli', 'claude-cli')
    .option('--author-model <model>', 'its model (default: the CLI default)', '')
    .option('--corpus <json>', 'corpus plan, e.g. {"profile":12,"timeline":10,"contradiction":10,"aggregate":12,"deep":10} (default: the recipe\'s; {} drafts nothing)')
    .option('--padding <multiple>', 'padding for scale curves, as a multiple of the corpus (10 = nine times its documents again)', '0')
    .option('--no-author', 'draft nothing: model-free tasks and padding only')
    .option('--author-chain <chain>', 'budgeted chain instead, e.g. anthropic-api:100,codex-cli (connections of --config-from)')
    .option('--config-from <workspace>', 'workspace whose connections the author chain uses (read-only)')
    .option('--seed <seed>', 'sampling seed', '0')
    .option('--options <json>', 'recipe options for the rebuild that supplies model-free tasks and padding', '{}')
    .action(async (arg: string, opts) => {
      const dir = resolvePack(arg);
      const guard = new QuotaGuard({ enabled: false, log: (m) => console.log(`  ${m}`) });
      const author = authorClient(opts, guard);
      const r = await extendPack(dir, {
        author, seed: opts.seed, options: JSON.parse(opts.options), log: (m) => console.log(`  ${m}`),
        corpus: opts.corpus ? JSON.parse(opts.corpus) : undefined, padding: Number(opts.padding),
      });
      for (const w of r.warnings) console.log(`  warning: ${w}`);
      for (const e of r.errors.slice(0, 30)) console.log(`  error: ${e}`);
      if (r.errors.length) process.exitCode = 1;
      console.log(`\n${path.basename(dir)}: ${r.added} corpus-level tasks added, ${r.padded} padding documents`);
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
    .option('--embedding-endpoint <url>', "embed on this OpenAI-compatible endpoint (a local bge-m3, say) under the workspace embedder's identity, once it reproduces the vectors the run holds")
    .option('--embedding-fallback', "with --embedding-endpoint: use the workspace's embedder while the endpoint is unreachable")
    .option('--chat-connection <id>', 'answer model calls from this connection of the --config-from workspace (an API endpoint) instead of codex exec')
    .option('--model <model>', 'model every system uses (Codex\'s, or the connection\'s)', '')
    .option('--build-effort <e>', 'reasoning effort for building', 'low')
    .option('--answer-effort <e>', 'reasoning effort for answering', 'medium')
    .option('--judge <provider>', 'judge CLI provider', 'claude-cli')
    .option('--judge-model <model>', 'judge model', '')
    .option('--chat-chain <chain>', 'budgeted chain for every model call, e.g. openai-api:200,codex-cli (connections of --config-from; budgets also in ~/knode-eval/budgets.json)')
    .option('--agent-chain <chain>', 'budgeted chain for agent sessions: API connections billed through Codex, then codex-cli')
    .option('--judge-chain <chain>', 'budgeted chain for the judge, e.g. anthropic-api:100,codex-cli')
    .option('--limit <n>', 'tasks per pack (stratified by type)')
    .option('--types <list>', `only these task types, comma-separated (e.g. aggregate,timeline,contradiction,profile,deep-hop,update)`)
    .option('--agent-limit <n>', 'tasks per pack for agent systems', '30')
    .option('--fraction <f>', 'share of the corpus to use; above 1, that many times its size with the pack\'s padding (scale curves)', '1')
    .option('--seed <seed>', 'sampling seed', '0')
    .option('--slots <n>', 'concurrent model calls', '6')
    .option('--pack-concurrency <n>', 'packs worked on at once', '1')
    .option('--answer-concurrency <n>', 'tasks one system answers at once in each pack (update batches too)', '3')
    .option('--embedding-cap <tokens>', 'stop embedding after this many tokens in the run')
    .option('--embedding-daily-cap <tokens>', 'embed at most this many tokens per UTC day; past it, packs wait for the next day')
    .option('--no-quota', 'do not pause for Codex plan windows')
    .option('--skip-scoring', 'answer only; score later with `eval run --run-dir`')
    .option('--reuse-builds-from <runDir>', "start from another run's builds of the same pack versions (and its embedding vectors), instead of building again")
    .action(async (opts) => {
      const res = await runEval({
        packs: csv(opts.pack)!.map(resolvePack),
        systems: csv(opts.systems) ?? DEFAULT_SYSTEMS,
        suites: (csv(opts.suites) as Suite[] | undefined) ?? [...SUITES],
        runDir: opts.runDir,
        configFrom: opts.configFrom,
        chatConnection: opts.chatConnection,
        embedding: opts.embedding,
        embeddingEndpoint: opts.embeddingEndpoint,
        embeddingFallback: opts.embeddingFallback,
        model: opts.model,
        buildEffort: opts.buildEffort as LlmEffort,
        answerEffort: opts.answerEffort as LlmEffort,
        judgeProvider: opts.judge,
        judgeModel: opts.judgeModel,
        chatChain: opts.chatChain,
        agentChain: opts.agentChain,
        judgeChain: opts.judgeChain,
        limit: opts.limit ? Number(opts.limit) : undefined,
        types: (() => {
          const types = csv(opts.types);
          const unknown = types?.filter((t) => !(TASK_TYPES as readonly string[]).includes(t)) ?? [];
          if (unknown.length) throw new Error(`unknown task types: ${unknown.join(', ')} (known: ${TASK_TYPES.join(', ')})`);
          return types as TaskType[] | undefined;
        })(),
        agentLimit: Number(opts.agentLimit),
        fraction: Number(opts.fraction),
        seed: opts.seed,
        slots: Number(opts.slots),
        packConcurrency: Number(opts.packConcurrency),
        answerConcurrency: Number(opts.answerConcurrency),
        embeddingTokenCap: opts.embeddingCap ? Number(opts.embeddingCap) : undefined,
        embeddingDailyCap: opts.embeddingDailyCap ? Number(opts.embeddingDailyCap) : undefined,
        quota: opts.quota,
        skipScoring: opts.skipScoring,
        reuseBuildsFrom: opts.reuseBuildsFrom,
        onProgress: (m) => console.log(`  ${m}`),
      });
      const report = writeReport(res.runDir);
      console.log(`\n${res.builds} builds, ${res.answers} answers, ${res.scores} scores\nreport: ${report.md}`);
      // child processes and embedder timers can keep the loop alive after a run: it is over
      process.exit(process.exitCode ?? 0);
    });
  evalCmd
    .command('score <runDir>')
    .description('judge what a stopped run has answered so far (Claude), then render its report')
    .option('--judge <provider>', 'judge CLI provider', 'claude-cli')
    .option('--judge-model <model>', 'judge model', '')
    .action(async (runDir: string, opts) => {
      const n = await scoreRun(path.resolve(runDir), { judgeProvider: opts.judge, judgeModel: opts.judgeModel, onProgress: (m) => console.log(`  ${m}`) });
      const r = writeReport(path.resolve(runDir));
      console.log(`\n${n} answers scored\nreport: ${r.md}`);
      process.exit(0);
    });
  evalCmd
    .command('status <runDir>')
    .description('how far a run has got: builds, answers and scores per pack and system, and what it has used')
    .action((runDir: string) => {
      const store = new RunStore(path.resolve(runDir));
      const meter = new Meter(path.join(path.resolve(runDir), 'meter.jsonl'));
      const builds = store.allBuilds();
      const answers = store.allAnswers();
      const packs = [...new Set([...builds.map((b) => b.pack), ...answers.map((a) => a.pack)])].sort();
      for (const pack of packs) {
        const b = builds.filter((x) => x.pack === pack).map((x) => `${x.system}${x.ok ? '' : ' (failed)'}`);
        const bySystem = new Map<string, { n: number; errors: number }>();
        for (const a of answers.filter((x) => x.pack === pack)) {
          const c = bySystem.get(a.system) ?? { n: 0, errors: 0 };
          c.n++;
          if (a.error) c.errors++;
          bySystem.set(a.system, c);
        }
        console.log(`${pack}\n  built: ${b.join(', ') || '—'}\n  answered: ${[...bySystem].map(([sys, c]) => `${sys} ${c.n}${c.errors ? ` (${c.errors} errors)` : ''}`).join(', ') || '—'}`);
      }
      const all = meter.all();
      const codex = sumEvents(all.filter((e) => e.system !== '__judge__'));
      const judge = sumEvents(all.filter((e) => e.system === '__judge__'));
      console.log(`\nmodel calls ${codex.calls} (${codex.failedCalls} failed, ${codex.replayedCalls} replayed), weighted tokens ${Math.round(codex.weightedTokens).toLocaleString()}, embedding tokens ${codex.embeddingTokens.toLocaleString()}`);
      console.log(`judge calls ${judge.calls}, weighted tokens ${Math.round(judge.weightedTokens).toLocaleString()}; scores ${store.allScores().length}`);
      if (all.length) console.log(`last activity ${all[all.length - 1].at}`);
    });
  evalCmd
    .command('report <runDir>')
    .description('render report.md and report.json from a run directory')
    .action((runDir: string) => {
      const r = writeReport(path.resolve(runDir));
      console.log(r.md);
    });
  evalCmd
    .command('scale <runDirs...>')
    .description('scale curves: read runs of the same packs at several --fraction values side by side')
    .option('--out <file>', 'write the Markdown here (default: print it)')
    .action((runDirs: string[], opts) => {
      const md = renderScale(buildScaleData(runDirs.map((d) => path.resolve(d))));
      if (opts.out) {
        fs.writeFileSync(path.resolve(opts.out), md);
        console.log(path.resolve(opts.out));
      } else console.log(md);
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
