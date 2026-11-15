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
import { parseLocal, runEval, scoreRun } from './run.js';
import { Meter, sumEvents } from './meter.js';
import { RunStore } from './runstore.js';
import { DEFAULT_SYSTEMS, SYSTEMS } from './systems/index.js';
import { EXTERNAL_SYSTEMS, externalPacks, venvPython } from './systems/external.js';
import { Suite, SUITES, TASK_TYPES, TaskType } from './types.js';
import { loadConfig, resolveDataDir } from '../config.js';
import { ModelChain, parseChain, SpendLedger } from './chain.js';
import { localServe, RunStoppedError } from './remote.js';

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

/** `--remote`: serve on this machine (docs/design/27 §8), found through the data root's config and MCP token. */
function remoteOption(program: Command, opts: { remote?: boolean; serveUrl?: string; offerSeconds?: string }) {
  if (!opts.remote) return null;
  const at = localServe(resolveDataDir(program.opts().data), opts.serveUrl);
  if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(at.serveUrl)) throw new Error('--serve-url: the run reaches serve on this machine only (http://127.0.0.1:<port>)');
  return at;
}

/**
 * `--local`, `--slots` (docs/design/32 §3): the run's own slots. Without
 * `--local` and `--remote` an old command line runs here on slots sized from
 * `--slots`; with either, `--slots` no longer says anything.
 */
function localOption(opts: { local?: string; slots?: string; remote?: boolean }): { local?: ReturnType<typeof parseLocal> | null; slots?: number } {
  if (opts.local !== undefined) {
    if (opts.slots !== undefined) console.log('  warning: --slots is ignored with --local, which says how many slots this run has');
    return { local: parseLocal(opts.local) };
  }
  if (opts.remote && opts.slots !== undefined) console.log('  warning: --slots is ignored with --remote: only --local starts slots on this machine (none now: the run\'s work waits for workers)');
  return opts.slots !== undefined ? { slots: Number(opts.slots) } : {};
}

/** `--wait-minutes` (docs/design/32 §3), and `--offer-seconds` said to be gone. */
function waitMinutesOption(opts: { waitMinutes?: string; offerSeconds?: string }): number {
  if (opts.offerSeconds !== undefined) console.log('  warning: --offer-seconds no longer applies: a piece waits until a slot takes it, at most --wait-minutes while none online does');
  const n = Number(opts.waitMinutes ?? 30);
  if (!Number.isFinite(n) || n < 0) throw new Error('--wait-minutes: a number of minutes, 0 for no limit');
  return n;
}

/** `--pool` (docs/design/32 §2): a name a worker can declare. */
function poolOption(opts: { pool?: string }): string | undefined {
  if (opts.pool === undefined) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(opts.pool)) throw new Error('--pool: a name of letters, digits, ".", "_" and "-" (at most 64)');
  return opts.pool;
}

/** `--repeat-sample`: how many tasks per pack repeats after the first ask; needs --repeat 2 or more. */
function repeatSampleOption(opts: { repeatSample?: string; repeat?: string }): number | undefined {
  if (opts.repeatSample === undefined) return undefined;
  const n = Number(opts.repeatSample);
  if (!Number.isInteger(n) || n < 1) throw new Error('--repeat-sample: a whole number of tasks, 1 or more');
  if (!(Number(opts.repeat) > 1)) throw new Error('--repeat-sample: needs --repeat 2 or more');
  return n;
}

/** `--judge-audit`: the share of judge verdicts judged a second time (none given: 5%; 0: off). */
function judgeAuditOption(opts: { judgeAudit?: string }): number | undefined {
  if (opts.judgeAudit === undefined) return undefined;
  const n = Number(opts.judgeAudit);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error('--judge-audit: a share between 0 and 1, e.g. 0.05 (0 turns the audit off)');
  return n;
}

/** A run the wait limit stopped: its report so far, the message, and a non-zero exit. */
async function waitedOut(run: typeof runEval, opts: Parameters<typeof runEval>[0]): Promise<Awaited<ReturnType<typeof runEval>> | null> {
  try {
    return await run(opts);
  } catch (err) {
    if (!(err instanceof RunStoppedError)) throw err;
    const report = err.runDir ? writeReport(err.runDir) : null;
    console.error(`\n${err.message}${report ? `\nreport so far: ${report.md}` : ''}`);
    process.exit(1);
  }
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
    .option('--database-url <url>', `PostgreSQL for knode's indexes, one schema per build (default: $KNODE_EVAL_DATABASE_URL, else the database knode_eval on the server the run's config names; PGlite when that config is on PGlite). Never the --config-from workspace's own database`)
    .option('--pglite', "keep knode's indexes in embedded PGlite whatever the config names (comparing with runs before 2026-11-14)")
    .option('--replay-only', "spend nothing: a model call or embedding not in the run's caches fails instead (rebuilding from another run's copied cache/; leave agents and scoring out)")
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
    .option('--local <slots>', "slots in this run's process that take its work like a worker, e.g. codex:6,claude:1 (Codex: model calls and agent sessions; claude: the judge). Without --local and without a worker nothing runs: the run waits")
    .option('--slots <n>', 'old command lines: with neither --remote nor --local, the run runs here as if given --local codex:<n>,claude:<n> (default 6)')
    .option('--pack-concurrency <n>', 'packs worked on at once', '1')
    .option('--answer-concurrency <n>', 'at most this many tasks one system answers at once in each pack (update batches too); otherwise as many as the slots online take (3 for an old command line)')
    .option('--embedding-cap <tokens>', 'stop embedding after this many tokens in the run')
    .option('--embedding-daily-cap <tokens>', 'embed at most this many tokens per UTC day; past it, packs wait for the next day')
    .option('--no-quota', 'do not pause for Codex plan windows')
    .option('--skip-scoring', 'answer only; score later with `eval run --run-dir`')
    .option('--reuse-builds-from <runDir>', "start from another run's builds of the same pack versions (and its embedding vectors), instead of building again")
    .option('--rebuild <groups>', 'with --reuse-builds-from: build these groups afresh (knode, llm-wiki, rag, …), e.g. after a change to how they build')
    .option('--remote', 'publish the run\'s work to `knode-os serve` on this machine, where remote workers take it (server.remote.offer.eval): model calls and agent sessions need --model, the judge --judge-model, and a pack with private sources goes to this machine\'s slots only; without --local nothing runs here')
    .option('--serve-url <url>', 'with --remote: serve\'s origin on this machine (default: from the data root\'s config)')
    .option('--offer-seconds <s>', 'no longer applies: a piece waits until a slot takes it (see --wait-minutes)')
    .option('--wait-minutes <n>', 'stop the run cleanly (non-zero, resumable) when a piece has waited this long while no slot online takes it; 0 = no limit', '30')
    .option('--pool <name>', "every piece of the run requires this pool: only workers started with --pool <name> (default: their token's name) take it, and this run's --local slots, which join it")
    .option('--repeat <n>', 'answer each task n times, for run-to-run variance (repeat 1 keeps the usual record keys)', '1')
    .option('--repeat-systems <list>', 'with --repeat: only these systems (default: every system that answers)')
    .option('--judge-audit <share>', 'judge this share of the verdicts a second time, in calls of their own with the items in another order, and list where the two disagree (default 0.05, at least 20 a pass; 0 = off)')
    .option('--repeat-sample <n>', 'with --repeat: repeat only a seeded sample of n tasks per pack, stratified by task type and the same for every repeated system (the first answer still covers every task)')
    .action(async (opts) => {
      const remote = remoteOption(program, opts);
      const res = await waitedOut(runEval, {
        remote,
        ...localOption(opts),
        waitMinutes: waitMinutesOption(opts),
        pool: poolOption(opts),
        repeat: Number(opts.repeat),
        repeatSystems: csv(opts.repeatSystems),
        repeatSample: repeatSampleOption(opts),
        judgeAudit: judgeAuditOption(opts),
        packs: csv(opts.pack)!.map(resolvePack),
        systems: csv(opts.systems) ?? DEFAULT_SYSTEMS,
        suites: (csv(opts.suites) as Suite[] | undefined) ?? [...SUITES],
        runDir: opts.runDir,
        configFrom: opts.configFrom,
        databaseUrl: opts.databaseUrl,
        pglite: opts.pglite,
        replayOnly: opts.replayOnly,
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
        packConcurrency: Number(opts.packConcurrency),
        answerConcurrency: opts.answerConcurrency !== undefined ? Number(opts.answerConcurrency) : undefined,
        embeddingTokenCap: opts.embeddingCap ? Number(opts.embeddingCap) : undefined,
        embeddingDailyCap: opts.embeddingDailyCap ? Number(opts.embeddingDailyCap) : undefined,
        quota: opts.quota,
        skipScoring: opts.skipScoring,
        reuseBuildsFrom: opts.reuseBuildsFrom,
        rebuild: csv(opts.rebuild),
        onProgress: (m) => console.log(`  ${m}`),
      });
      if (!res) return;
      const report = writeReport(res.runDir);
      console.log(`\n${res.builds} builds, ${res.answers} answers, ${res.scores} scores\nreport: ${report.md}`);
      // incomplete: pieces three different workers could not serve were left unanswered (docs/design/32 §3)
      if (res.stuck) {
        console.error(`incomplete: ${res.stuck} piece(s) stuck (listed in the report); resume with --run-dir ${res.runDir}`);
        process.exitCode = 1;
      }
      // child processes and embedder timers can keep the loop alive after a run: it is over
      process.exit(process.exitCode ?? 0);
    });
  evalCmd
    .command('drop [runDir]')
    .description("drop a run's knode indexes (its schemas in the evaluation database, or its embedded databases); its records stay. --orphaned: drop the evaluation schemas whose run directory is gone")
    .option('--database-url <url>', 'the evaluation database (default: what the run\'s workspaces name, or $KNODE_EVAL_DATABASE_URL)')
    .option('--config-from <workspace>', 'with --orphaned: the workspace whose server holds the evaluation database knode_eval')
    .option('--orphaned', 'drop evaluation schemas whose workspace directory no longer exists')
    .action(async (runDir: string | undefined, opts: { databaseUrl?: string; configFrom?: string; orphaned?: boolean }) => {
      const { defaultConfig, loadConfig } = await import('../config.js');
      const { describeDatabase, dropEvalSchema, dropRun, evalDatabase, orphanedEvalSchemas } = await import('./database.js');
      if (runDir) await dropRun(runDir, { url: opts.databaseUrl, log: (m) => console.log(`  ${m}`) });
      if (opts.orphaned) {
        const cfg = evalDatabase(opts.configFrom ? loadConfig(opts.configFrom).database : defaultConfig().database, { url: opts.databaseUrl });
        if (cfg.kind !== 'postgres') throw new Error('--orphaned: the evaluation database is PGlite here; its indexes live in the run directories');
        const orphans = await orphanedEvalSchemas(cfg);
        for (const o of orphans) {
          await dropEvalSchema(cfg, o.schema);
          console.log(`  dropped ${o.schema} (${o.workspace} is gone)`);
        }
        console.log(`${orphans.length} orphaned evaluation schemas dropped in ${describeDatabase(cfg)}`);
      }
      if (!runDir && !opts.orphaned) throw new Error('name a run directory, or pass --orphaned');
    });
  evalCmd
    .command('resolution <workspace>')
    .description('entity resolution without a model: re-apply a workspace\'s stored extractions under this build\'s rules and score the entities (src/eval/resolution.ts)')
    .option('--gold <file>', 'gold alias clusters (a pack\'s gold/aliases.jsonl) to score against')
    .option('--index', 'score the index in <workspace> as it stands; <workspace> must be a COPY of the .knode folder\'s parent, never a live workspace')
    .option('--scan', 'read the sidecars alone and list the names refine would part (no index is opened; an estimate)')
    .option('--identity <mode>', 'replay under these rules: context, name, or both', 'both')
    .option('--keep', 'keep the temporary replay folder')
    .option('--json', 'print the report as JSON')
    .action(async (workspace: string, opts) => {
      const { formatIndexScore, readGoldAliases, replayResolution, scanSidecars, scoreIndexCopy } = await import('./resolution.js');
      const dir = path.resolve(workspace);
      if (opts.scan) {
        const r = scanSidecars(dir);
        if (opts.json) console.log(JSON.stringify(r, null, 2));
        else {
          console.log(`${r.sidecars} extractions, ${r.names} names`);
          console.log(`coded (review.identity "context" only): ${r.codedCandidates} names of a type a code may part carry two or more codes of one kind; ${r.coded.length} would be parted into ${r.coded.reduce((n, c) => n + c.parts.length, 0)} more entities`);
          for (const c of r.coded.slice(0, 40)) console.log(`  ${c.name} (${c.documents} documents): ${c.parts.map((p) => `${p.code} ×${p.documents} [${p.anchors.join(', ')}]`).join('; ')}`);
          const by = (rules: string) => r.people.filter((p) => p.rules === rules).length;
          console.log(`people: ${r.peopleCandidates} names in 6+ documents; would be split — ${by('indexed')} by default as the index is now, ${by('reindexed')} more by default once documents are indexed again (datelines), ${by('context')} more only with review.identity "context"`);
          for (const p of r.people.slice(0, 40)) console.log(`  ${p.name} (${p.documents} documents): [${p.anchors[0].join(', ')}] / [${p.anchors[1].join(', ')}]  (${p.rules})`);
          const f = r.follow;
          console.log(`write time: nothing is parted when a document is written; of ${f.same + f.elsewhere + f.base} documents of the names above, arriving after the split ${f.same} would be filed where refine put them, ${f.base} with the entity that keeps the name, ${f.elsewhere} with another of its entities`);
        }
        return;
      }
      if (!opts.gold) throw new Error('--gold <aliases.jsonl> is required to score');
      const gold = readGoldAliases(path.resolve(opts.gold));
      if (opts.index) {
        const s = await scoreIndexCopy(dir, gold);
        console.log(opts.json ? JSON.stringify(s, null, 2) : formatIndexScore('index as it stands', s));
        return;
      }
      const modes = opts.identity === 'both' ? (['name', 'context'] as const) : [opts.identity === 'name' ? ('name' as const) : ('context' as const)];
      const reports = [];
      for (const identity of modes) {
        const r = await replayResolution(dir, gold, { identity, keep: Boolean(opts.keep), onProgress: (m) => (opts.json ? undefined : console.log(`  ${m}`)) });
        reports.push(r);
        if (!opts.json) {
          console.log(`\nreview.identity: ${identity} — ${r.documents} documents, ${r.seconds}s`);
          console.log(formatIndexScore('after indexing (write-time resolution)', r.written));
          console.log(formatIndexScore(`after refine's entity step (${r.refine.passes} passes: ${r.refine.merged} merged, ${r.refine.split} parted, ${r.refine.replayed} documents re-applied)`, r.refined));
        }
      }
      if (opts.json) console.log(JSON.stringify(reports, null, 2));
      process.exit(0);
    });
  evalCmd
    .command('score <runDir>')
    .description('judge what a stopped run has answered so far (Claude), then render its report')
    .option('--judge <provider>', 'judge CLI provider', 'claude-cli')
    .option('--judge-model <model>', 'judge model', '')
    .option('--remote', 'publish the judge\'s calls to `knode-os serve` on this machine, where remote workers take them (needs --judge-model; not for a run with a private pack)')
    .option('--serve-url <url>', 'with --remote: serve\'s origin on this machine')
    .option('--local <slots>', "slots in this process that take the judge's calls, e.g. claude:2; without it and --remote the judge runs here on --slots")
    .option('--slots <n>', 'old command lines: with neither --remote nor --local, the judge runs here on that many slots (default 6)')
    .option('--offer-seconds <s>', 'no longer applies: a call waits until a slot takes it (see --wait-minutes)')
    .option('--wait-minutes <n>', 'stop cleanly (non-zero) when a call has waited this long while no slot online takes it; 0 = no limit', '30')
    .option('--pool <name>', 'the judge\'s calls require this pool (workers started with --pool <name>, and --local slots)')
    .option('--judge-audit <share>', 'judge this share of the verdicts a second time, in calls of their own with the items in another order, and list where the two disagree (default 0.05, at least 20 a pass; 0 = off)')
    .action(async (runDir: string, opts) => {
      let n: number;
      try {
        n = await scoreRun(path.resolve(runDir), { judgeProvider: opts.judge, judgeModel: opts.judgeModel, onProgress: (m) => console.log(`  ${m}`), remote: remoteOption(program, opts), ...localOption(opts), waitMinutes: waitMinutesOption(opts), pool: poolOption(opts), judgeAudit: judgeAuditOption(opts) });
      } catch (err) {
        if (!(err instanceof RunStoppedError)) throw err;
        console.error(`\n${err.message}`);
        process.exit(1);
      }
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
      const placed = (worker: string | undefined) => (worker && worker !== 'local' ? (worker === 'mixed' ? 'mixed' : 'remote') : 'local');
      for (const pack of packs) {
        // where it ran (docs/design/27 §8): a build or answer by remote workers, or partly
        const b = builds.filter((x) => x.pack === pack).map((x) => `${x.system}${x.ok ? '' : ' (failed)'}${placed(x.worker) !== 'local' ? ` [${x.worker}]` : ''}`);
        const bySystem = new Map<string, { n: number; errors: number; remote: number; mixed: number; repeats: number; backends: Set<string> }>();
        for (const a of answers.filter((x) => x.pack === pack)) {
          const c = bySystem.get(a.system) ?? { n: 0, errors: 0, remote: 0, mixed: 0, repeats: 0, backends: new Set<string>() };
          c.n++;
          if (a.error) c.errors++;
          if (placed(a.worker) === 'remote') c.remote++;
          if (placed(a.worker) === 'mixed') c.mixed++;
          if (a.repeat && a.repeat > 1) c.repeats++;
          if (a.backend) c.backends.add(a.backend);
          bySystem.set(a.system, c);
        }
        const share = (c: { n: number; remote: number; mixed: number }) => (c.remote || c.mixed ? `, remote ${Math.round((100 * (c.remote + c.mixed / 2)) / c.n)}% (${c.remote} by workers${c.mixed ? `, ${c.mixed} mixed` : ''})` : '');
        const answered = [...bySystem].map(([sys, c]) => `${sys} ${c.n}${c.repeats ? ` (${c.repeats} repeats)` : ''}${c.errors ? ` (${c.errors} errors)` : ''}${share(c)}${c.backends.size > 1 ? ` — BACKENDS MIXED: ${[...c.backends].join(', ')}` : ''}`);
        console.log(`${pack}\n  built: ${b.join(', ') || '—'}\n  answered: ${answered.join('; ') || '—'}`);
      }
      const all = meter.all();
      const codex = sumEvents(all.filter((e) => e.system !== '__judge__'));
      const judge = sumEvents(all.filter((e) => e.system === '__judge__'));
      console.log(`\nmodel calls ${codex.calls} (${codex.failedCalls} failed, ${codex.replayedCalls} replayed), weighted tokens ${Math.round(codex.weightedTokens).toLocaleString()}, embedding tokens ${codex.embeddingTokens.toLocaleString()}`);
      console.log(`judge calls ${judge.calls}, weighted tokens ${Math.round(judge.weightedTokens).toLocaleString()}; scores ${store.allScores().length}`);
      const calls = all.filter((e) => !e.embeddingCalls && !e.embeddingTokens);
      const remoteCalls = calls.filter((e) => e.worker);
      if (remoteCalls.length) {
        const byWorker = new Map<string, number>();
        for (const e of remoteCalls) byWorker.set(e.worker!, (byWorker.get(e.worker!) ?? 0) + 1);
        console.log(`remote: ${remoteCalls.length} of ${calls.length} model calls and sessions ran on workers (${[...byWorker].map(([w, n]) => `${w} ${n}`).join(', ')}); backends ${[...new Set(calls.map((e) => e.backend ?? e.model))].join(', ')}`);
      }
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
