import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapLimit } from '../bench/util.js';
import { isCliProvider, KnodeConfig, LlmEffort, loadConfig } from '../config.js';
import { createEmbeddingProvider, EmbeddingProvider } from '../ingest/embeddings.js';
import { createConfiguredEmbeddingProvider } from '../ingest/embedding-router.js';
import { LlmClient } from '../llm/client.js';
import { Judge, JUDGE_SYSTEM } from './judge.js';
import { ModelChain, parseChain, SpendLedger } from './chain.js';
import { setAgentRouting } from './agent.js';
import { Meter } from './meter.js';
import { dirBytes, listFiles, loadPack, LoadedPack, packsDir, runsDir, seededKey, stageCorpus, StagedCorpus, stageUpdate, validatePack } from './pack.js';
import { calibrateEndpoint, checkEndpoint, endpointUnder, preferEndpoint } from './endpoint.js';
import { citationsIn, taskPrompt } from './prompts.js';
import { EmbeddingBudget, QuotaGuard } from './quota.js';
import { fileLines, recordKey, RunMeta, RunStore } from './runstore.js';
import { scoreEmergence } from './score/emergence.js';
import { scoreGeneration } from './score/generation.js';
import { scoreLists } from './score/lists.js';
import { scoreKey, scoreUsage } from './score/usage.js';
import { ChatBackend, ClientBackend, CodexBackend, shimState, startShim } from './shim.js';
import { withRemote } from './placement.js';
import { judgeAgent, packMayLeave, PlacedChatBackend, RemoteEval, remoteJudgeClient, RunCancelledError } from './remote.js';
import type { Placed } from './meter.js';
import { closeAdapters } from './systems/external.js';
import { makeSystems } from './systems/index.js';
import { removeHeldTempDirs, sweepStaleTempDirs } from './tmp.js';
import { boundedTrace } from './trace.js';
import { SystemEnv, SystemUnderTest, taggedEmbedder } from './systems/types.js';
import { extractFinalAnswer } from './metrics/text.js';
import { AnswerRecord, BuildRecord, emptyUsage, ScoreRecord, Suite, SUITES, Task, TaskType } from './types.js';

/**
 * `knode-os eval run` (docs/design/23 §7). For each pack: stage the corpus,
 * build each system group once, answer the selected tasks, apply update
 * batches and answer the update tasks, then score — every answer of every
 * system judged in one blind pass, generated knowledge scored per build.
 * Every record is keyed, so a rerun of the same directory resumes.
 */

export interface RunOptions {
  packs: string[];
  systems: string[];
  suites?: Suite[];
  /** Resume this run directory instead of starting a new one. */
  runDir?: string;
  /** A knode workspace whose config supplies the embedder and, with `chatConnection`, the chat endpoint (read-only). */
  configFrom?: string;
  /**
   * A connection of that workspace — an API endpoint — that answers the shim's
   * chat calls instead of `codex exec`. Agents stay Codex sessions.
   */
  chatConnection?: string;
  /** The model every system builds and answers with ('' = Codex's default, or the connection's). */
  model?: string;
  /**
   * An OpenAI-compatible embedding endpoint (a local bge-m3, say) that embeds in
   * place of the workspace's embedder, under its identity, once it reproduces the
   * vectors the run holds (`checkEndpoint`).
   */
  embeddingEndpoint?: string;
  /** With `embeddingEndpoint`: embed on the workspace's embedder while the endpoint is unreachable (a local bge-m3 first, the pool after). */
  embeddingFallback?: boolean;
  buildEffort?: LlmEffort;
  answerEffort?: LlmEffort;
  /** Judge: a CLI provider ('claude-cli') and model. */
  judgeProvider?: string;
  judgeModel?: string;
  /**
   * Budgeted model chains (D18), e.g. `openai-api:200,codex-cli`: the model
   * calls of every system (`chatChain`), the agent sessions (`agentChain`,
   * API links billed through Codex, then the login) and the judge
   * (`judgeChain`). Connections come from `configFrom`.
   */
  chatChain?: string;
  agentChain?: string;
  judgeChain?: string;
  embedding?: 'workspace' | 'local';
  /** At most this many tasks per pack (stratified by type), and fewer for agents. */
  limit?: number;
  /** Only tasks of these types (a focused run: the corpus-level types, deep hops, updates). */
  types?: TaskType[];
  agentLimit?: number;
  fraction?: number;
  seed?: string | number;
  slots?: number;
  /** Tasks one system answers at once in each pack, update batches included (default 3). */
  answerConcurrency?: number;
  /** Packs worked on at once (each builds and answers on its own; the shim's slots bound the model calls). */
  packConcurrency?: number;
  quota?: boolean;
  embeddingTokenCap?: number;
  /** At most this many embedding tokens per UTC day (a shared pool's free quotas reset at 00:00 UTC). */
  embeddingDailyCap?: number;
  /** Skip scoring (answers only) or answering (score what is there). */
  skipScoring?: boolean;
  /**
   * Start from another run's builds of the same packs (same id, version,
   * fraction and seed) and its embedding vectors: their work directories are
   * copied and their build records kept, cost included — so a new task set
   * over an unchanged corpus does not pay for the builds again. A build the
   * other run went on to update is built again: update batches change its
   * work directory in place, so what is there is no longer the base build.
   */
  reuseBuildsFrom?: string;
  /**
   * Build groups (`knode`, `llm-wiki`, `rag`, …) not taken from
   * `reuseBuildsFrom`, built afresh: a build's key names the pack and its
   * version, not the code that built it, so after a change to how a group
   * builds (knode's retrieval, entity pages, summaries) its old build would
   * otherwise come back.
   */
  rebuild?: string[];
  /** Tests: stand-ins for Codex, the judge and the embedder. */
  overrides?: { chat?: ChatBackend; judge?: LlmClient; embedder?: EmbeddingProvider };
  /**
   * Offer the run's model work to remote workers through `serve` on this
   * machine (docs/design/27 §8): its origin and the data root's MCP token.
   * Only work whose CLI and model the run names leaves (`--model`, and
   * `--judge-model` for the judge); a pack with a `private:` source never does.
   */
  remote?: { serveUrl: string; token: string; offerSeconds?: number; refreshMs?: number } | null;
  /** Answer each task this many times, for run-to-run variance (default 1: today's keys). */
  repeat?: number;
  /** The systems answered `repeat` times (default: every system that answers). */
  repeatSystems?: string[];
  /** Cancels the run: what is out with workers is withdrawn and their session tokens revoked. */
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
}

export interface RunResult {
  runDir: string;
  builds: number;
  answers: number;
  scores: number;
}

function gitSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function knodeVersion(): string {
  try {
    const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    return (JSON.parse(fs.readFileSync(pkg, 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

/** Tasks a system answers on a pack: the suites asked for, stratified by type, at most `limit`. */
export function selectTasks(tasks: Task[], suites: Set<string>, limit: number | undefined, seed: string | number): Task[] {
  const pool = tasks.filter((t) => suites.has(t.suite));
  if (!limit || pool.length <= limit) return pool;
  const byType = new Map<string, Task[]>();
  for (const t of [...pool].sort((a, b) => seededKey(seed, a.id).localeCompare(seededKey(seed, b.id)))) {
    (byType.get(t.type) ?? byType.set(t.type, []).get(t.type)!).push(t);
  }
  // primary tasks first within each type, then round-robin across types
  for (const list of byType.values()) list.sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)));
  const out: Task[] = [];
  const lists = [...byType.values()];
  for (let i = 0; out.length < limit; i++) {
    let added = false;
    for (const l of lists) {
      if (l[i] && out.length < limit) {
        out.push(l[i]);
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}

const isAgent = (s: SystemUnderTest) => s.kind === 'agent' || s.id.startsWith('agent-');

/** A workspace connection as the shim's backend, at the run's model when it names one. */
function connectionBackend(config: KnodeConfig | null, id: string, model?: string): ChatBackend {
  if (!config) throw new Error('--chat-connection names a connection of the --config-from workspace');
  const connection = config.connections.find((c) => c.id === id);
  if (!connection) throw new Error(`no connection "${id}" in the --config-from workspace (it has: ${config.connections.map((c) => c.id).join(', ')})`);
  if (isCliProvider(connection.provider)) throw new Error(`connection "${id}" is a CLI; --chat-connection takes an API endpoint`);
  return new ClientBackend(new LlmClient({ ...connection, model: model || connection.model }));
}

export async function runEval(opts: RunOptions): Promise<RunResult> {
  const progress = opts.onProgress ?? (() => {});
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const runDir = path.resolve(opts.runDir ?? path.join(runsDir(), stamp));
  const store = new RunStore(runDir);
  const suites = new Set<string>(opts.suites ?? SUITES);
  const fraction = opts.fraction ?? 1;
  const seed = opts.seed ?? 0;
  const meter = new Meter(path.join(runDir, 'meter.jsonl'));
  const quota = new QuotaGuard({ enabled: opts.quota ?? !opts.overrides?.chat, log: (m, d) => {
    progress(`${m}${d ? ` ${JSON.stringify(d)}` : ''}`);
    store.log(m, d);
  } });

  const budget = new EmbeddingBudget({
    dailyTokens: opts.embeddingDailyCap,
    usedToday: (day) => meter.all((e) => e.at.startsWith(day)).reduce((s, e) => s + (e.embeddingTokens ?? 0), 0),
    log: (m, d) => {
      progress(`${m}${d ? ` ${JSON.stringify(d)}` : ''}`);
      store.log(m, d);
    },
  });

  const workspaceConfig = opts.configFrom ? loadConfig(opts.configFrom) : null;
  const configured = opts.overrides?.embedder
    ?? (opts.embedding === 'local' || !workspaceConfig
      ? createEmbeddingProvider({ provider: 'local', baseUrl: '', apiKey: '', model: '', dimensions: 384, batchSize: 64, sendDimensions: false })
      : createConfiguredEmbeddingProvider(workspaceConfig));
  const onEndpoint = opts.embeddingEndpoint ? endpointUnder(configured, opts.embeddingEndpoint) : null;
  const embedder = !onEndpoint ? configured
    : opts.embeddingFallback ? preferEndpoint(onEndpoint, configured, (m) => {
      progress(m);
      store.log(m);
    }) : onEndpoint;
  const ledger = new SpendLedger();
  const chainLog = (m: string) => {
    progress(m);
    store.log(m);
  };
  const chain = (spec: string) => new ModelChain(parseChain(spec, workspaceConfig, { ledger, model: opts.model }), ledger, chainLog);
  const backend = opts.overrides?.chat
    ?? (opts.chatChain ? chain(opts.chatChain).asBackend()
      : opts.chatConnection ? connectionBackend(workspaceConfig, opts.chatConnection, opts.model) : new CodexBackend({ model: opts.model }));
  const localJudge = opts.overrides?.judge
    ?? (opts.judgeChain ? chain(opts.judgeChain).asClient()
      : new LlmClient({ provider: opts.judgeProvider ?? 'claude-cli', baseUrl: '', apiKey: '', model: opts.judgeModel ?? '', cliPath: '', cliTimeoutMs: 600_000 }));
  // remote workers beside this machine (docs/design/27 §8): only with `serve` running and offering eval work
  const runId = path.basename(runDir);
  const remote = opts.remote ? await RemoteEval.connect({ ...opts.remote, run: runId, quota, log: chainLog }) : null;
  const onAbort = () => void remote?.cancel();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  // a call leaves only on the run's own Codex backend with a named model: the worker runs exactly that one
  const callsLeave = Boolean(remote && !opts.overrides?.chat && !opts.chatChain && !opts.chatConnection && opts.model);
  if (remote && !callsLeave) chainLog(`remote: model calls stay here (${opts.model ? 'the run answers on a chain, a connection or a stand-in' : 'no --model: a worker runs the model the run names'}); agent sessions${opts.model ? '' : ' too'}`);
  const state = shimState({ cacheDir: store.cacheDir(), slots: opts.slots ?? 6, embeddingTokenCap: opts.embeddingTokenCap });
  const placed = callsLeave ? new PlacedChatBackend(backend, state.slots, remote!, { model: opts.model! }) : null;
  // a pack with a private source never leaves: its scoring neither, and the judge scores packs together
  const anyPrivate = remote ? opts.packs.some((dir) => !packMayLeave(loadPack(dir))) : false;
  const judgeRemote = remote && !opts.overrides?.judge && !opts.judgeChain ? judgeAgent(opts.judgeProvider ?? 'claude-cli', opts.judgeModel ?? '') : null;
  if (remote && judgeRemote && anyPrivate) chainLog('remote: the judge stays here (a pack in this run has private sources)');
  else if (remote && !judgeRemote) chainLog('remote: the judge stays here (no --judge-model, or a chain or stand-in judges)');
  const judgeClient = judgeRemote && !anyPrivate ? remoteJudgeClient(localJudge, remote!, judgeRemote) : localJudge;
  // this machine's plan holds only what runs here while workers take the rest
  if (remote) quota.setBypass(() => remote.online('eval-call', 'codex') + remote.online('eval-session', 'codex') > 0);
  if (opts.agentChain) {
    const agents = chain(opts.agentChain);
    const bad = agents.links.find((l) => !l.api && l.name !== 'codex-cli');
    if (bad) throw new Error(`--agent-chain: agents run in Codex; "${bad.name}" is neither an API connection nor codex-cli`);
    setAgentRouting({
      pick: () => agents.pick(),
      charge: (name, model, usage) => void agents.charge(agents.links.find((l) => l.name === name)!, model, usage, { role: 'agent' }),
      exhaust: (name, why) => agents.exhaust(agents.links.find((l) => l.name === name)!, why),
    });
  }
  const judge = new Judge({ client: judgeClient, meter, quota, cacheFile: path.join(store.cacheDir(), 'judge.jsonl') });
  const models = { model: opts.model ?? '', buildEffort: opts.buildEffort ?? 'low', answerEffort: opts.answerEffort ?? 'medium' };

  if (opts.reuseBuildsFrom) {
    const groups = new Set(makeSystems(opts.systems).map((sys) => sys.group).filter((g) => !opts.rebuild?.includes(g)));
    const n = reuseBuilds(store, path.resolve(opts.reuseBuildsFrom), opts.packs, `${embedder.model} (${embedder.dimensions})`, fraction, seed, groups);
    progress(`reusing ${n.builds} builds and ${n.vectors} embedding vectors from ${opts.reuseBuildsFrom}${opts.rebuild?.length ? `; building ${opts.rebuild.join(', ')} afresh` : ''}`);
    if (n.updated.length) progress(`building again, since ${opts.reuseBuildsFrom} updated them after building: ${n.updated.join(', ')}`);
    store.log('builds reused', { from: opts.reuseBuildsFrom, ...n });
  }

  const shimOptions = {
    embedder,
    meter,
    state,
    buildEffort: models.buildEffort,
    answerEffort: models.answerEffort,
    embeddingBudget: budget,
  };
  const shim = await startShim({ ...shimOptions, backend: placed ?? backend });
  // a private pack's calls go to a shim that never offers them (packs share the caches and this machine's slots)
  const localShim = placed ? await startShim({ ...shimOptions, backend }) : shim;

  const meta: RunMeta = store.meta() ?? {
    id: path.basename(runDir),
    createdAt: new Date().toISOString(),
    gitSha: gitSha(),
    knodeVersion: knodeVersion(),
    packs: opts.packs.map((p) => path.basename(p)),
    systems: opts.systems,
    suites: [...suites],
    model: { connection: opts.chatChain ?? opts.chatConnection ?? 'codex-cli', label: backend.label, buildEffort: models.buildEffort, answerEffort: models.answerEffort, ...(opts.agentChain ? { agents: opts.agentChain } : {}) },
    judge: { connection: opts.judgeChain ?? opts.judgeProvider ?? 'claude-cli', label: judgeClient.label },
    embedding: `${embedder.model} (${embedder.dimensions})`,
    fraction,
    seed,
    limit: opts.limit ?? null,
    versions: {},
    ...(opts.types?.length ? { types: opts.types } : {}),
  };
  store.writeMeta(meta);

  // remote slots add to this machine's: a system answers that many more tasks at once while workers are online (F)
  const concurrencyFor = (s: SystemUnderTest) => {
    const base = opts.answerConcurrency ?? 3;
    if (!remote) return base;
    return base + (isAgent(s) ? remote.online('eval-session', 'codex') : callsLeave ? remote.online('eval-call', 'codex') : 0);
  };
  const repeat = Math.max(1, Math.trunc(opts.repeat ?? 1));
  const repeatsOf = (s: SystemUnderTest) => (repeat > 1 && (!opts.repeatSystems?.length || opts.repeatSystems.includes(s.id)) ? repeat : 1);
  if (repeat > 1) meta.repeat = { n: repeat, systems: opts.repeatSystems?.length ? opts.repeatSystems : opts.systems };
  if (remote) meta.remote = { serve: opts.remote!.serveUrl, calls: callsLeave, judge: Boolean(judgeRemote && !anyPrivate) };
  store.writeMeta(meta);
  const tasksByKey = new Map<string, Task>();
  const corpusDocs = new Map<string, Set<string>>();
  const citing = new Set<string>();
  const loaded: { pack: LoadedPack; staged: StagedCorpus }[] = [];

  // a run stopped by a signal takes down what it started and the temp directories it holds;
  // one killed outright leaves them for the next run's sweep
  const swept = sweepStaleTempDirs();
  if (swept) progress(`removed ${swept} temp directories of runs that are gone`);
  const onSignal = (signal: NodeJS.Signals) => {
    closeAdapters();
    removeHeldTempDirs();
    // what is out with workers is withdrawn and its session tokens die before this process does
    void (remote ? remote.cancel() : Promise.resolve()).finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    // every pack is validated before anything is spent on any of them
    const packs = opts.packs.map((dir) => {
      const pack = loadPack(dir);
      const issues = validatePack(pack);
      if (issues.errors.length) throw new Error(`pack ${pack.manifest.id} is invalid:\n- ${issues.errors.slice(0, 20).join('\n- ')}`);
      for (const w of issues.warnings) store.log('pack warning', { pack: pack.manifest.id, warning: w });
      return pack;
    });
    if (opts.embeddingEndpoint && onEndpoint) {
      // against the vectors the run holds; a run that holds too few is checked against the workspace's embedder itself
      try {
        const check = await checkEndpoint(onEndpoint, shim.vectors, packs).catch(async (err) => {
          if (!/can be checked against only/.test(String(err))) throw err;
          return calibrateEndpoint(onEndpoint, configured, packs);
        });
        progress(`embedding on ${opts.embeddingEndpoint} as ${embedder.model}: ${check.texts} texts came back at cosine ${check.lowest.toFixed(5)} or more`);
        store.log('embedding endpoint', { url: opts.embeddingEndpoint, identity: embedder.model, ...check });
      } catch (err) {
        // unreachable: the fallback takes over; a model that does not reproduce the vectors is refused either way
        if (!opts.embeddingFallback || !/econnrefused|fetch failed|etimedout|enotfound|socket hang up|connection (refused|reset)|network/i.test(String(err))) throw err;
        progress(`embedding endpoint ${opts.embeddingEndpoint} unreachable: embedding on ${configured.model}`);
        store.log('embedding endpoint unreachable', { url: opts.embeddingEndpoint, error: String(err).slice(0, 200) });
      }
    }
    const runPack = async (pack: LoadedPack) => {
      const staged = stageCorpus(pack, { fraction, seed });
      loaded.push({ pack, staged });
      corpusDocs.set(pack.manifest.id, new Set(staged.docs.map((d) => d.path)));
      for (const t of pack.tasks) tasksByKey.set(`${pack.manifest.id}|${t.id}`, t);
      progress(`pack ${pack.manifest.id}: ${staged.docs.length} documents${staged.padded ? ` (${staged.padded} of them padding)` : ''}, ${staged.tasks.length} tasks`);
      const leaves = Boolean(remote) && packMayLeave(pack);
      if (remote && !leaves) progress(`pack ${pack.manifest.id} has private sources: all its work stays on this machine`);
      const packShim = leaves ? shim : localShim;
      const chars = staged.docs.reduce((n, d) => n + fs.readFileSync(path.join(staged.dir, d.path), 'utf8').length, 0);
      meta.staged = { ...meta.staged, [pack.manifest.id]: { documents: staged.docs.length, padded: staged.padded, chars, tasks: staged.tasks.length } };
      store.writeMeta(meta);

      const systems = makeSystems(opts.systems).filter((s) => s.applicable?.(pack, staged) ?? true);
      for (const s of systems) if (s.answers && s.kind !== 'reference' && s.cites !== false) citing.add(s.id);
      const groups = new Map<string, SystemUnderTest[]>();
      for (const s of systems) (groups.get(s.group) ?? groups.set(s.group, []).get(s.group)!).push(s);

      const failed = new Set<string>();
      const typed = opts.types?.length ? staged.tasks.filter((t) => opts.types!.includes(t.type)) : staged.tasks;
      const allTasks = selectTasks(typed.filter((t) => !t.afterUpdate), suites, opts.limit, seed);
      const updateTasks = suites.has('update') ? typed.filter((t) => t.afterUpdate) : [];

      for (const [group, members] of groups) {
        const env: SystemEnv = {
          runId: meta.id,
          pack,
          staged,
          workDir: store.workDir(pack.manifest.id, group),
          shim: packShim,
          meter,
          quota,
          models,
          log: (m) => progress(`[${pack.manifest.id}/${group}] ${m}`),
        };
        if (!(await buildGroup(store, meter, env, group, members, fraction, seed, progress, opts.signal))) {
          failed.add(group);
          continue;
        }
        for (const s of members) {
          for (const other of members) if (other !== s) await other.release?.(env);
          const tasks = isAgent(s) ? selectTasks(allTasks, suites, opts.agentLimit ?? 30, seed) : allTasks;
          for (let r = 1; r <= repeatsOf(s); r++) await answerAll(store, meter, env, s, tasks, fraction, seed, concurrencyFor(s), progress, undefined, r, opts.signal);
          await retrieveAll(store, env, s, allTasks, fraction, seed);
        }
        // generated knowledge, once per build
        const exporter = members.find((s) => s.exportKnowledge);
        if (exporter && suites.has('generation') && !opts.skipScoring) {
          const done = store.score(recordKey('gen', pack.manifest.id, exporter.id, 'units'));
          if (!done) {
            progress(`[${pack.manifest.id}/${group}] scoring generated knowledge`);
            const units = await exporter.exportKnowledge!(env);
            for (const r of await scoreGeneration(pack, exporter.id, units, judge, taggedEmbedder(env, { system: '__score__', stage: 'embed' }), { seed })) store.putScore(r);
          }
        }
        for (const s of members) await s.release?.(env);
      }

      // update batches, in order and cumulatively up to the last one a task asks after: apply each to the
      // staged corpus, let every system that can update (its cost recorded per batch), then ask that batch's tasks
      const last = updateTasks.map((t) => t.afterUpdate!).sort().at(-1);
      const batches = last ? pack.updates.filter((b) => b <= last) : [];
      for (const batch of batches) {
        const files = stageUpdate(pack, staged, batch);
        for (const f of files) corpusDocs.get(pack.manifest.id)!.add(f);
        const tasks = updateTasks.filter((t) => t.afterUpdate === batch);
        for (const [group, members] of groups) {
          if (failed.has(group)) continue;
          const env: SystemEnv = { runId: meta.id, pack, staged, workDir: store.workDir(pack.manifest.id, group), shim: packShim, meter, quota, models, log: (m) => progress(`[${pack.manifest.id}/${group}] ${m}`) };
          const updater = members.find((s) => s.update);
          const key = recordKey('update', pack.manifest.id, group, batch, fraction, seed);
          if (updater && !store.build(key)) {
            const mark = meter.mark();
            const t0 = Date.now();
            let ok = true;
            let error: string | undefined;
            try {
              await updater.update!(files, env);
            } catch (err) {
              ok = false;
              error = err instanceof Error ? err.message : String(err);
            }
            if (opts.signal?.aborted) throw new RunCancelledError();
            store.putBuild({ key, pack: pack.manifest.id, system: `${group}@${batch}`, ok, error, ms: Date.now() - t0, usage: meter.usage((e) => e.system === group, mark), stages: meter.stages(group, mark), bytes: 0, notes: { batch, files: files.length, tasks: tasks.length }, at: new Date().toISOString(), ...where(meter.placement((e) => e.system === group, mark)) });
          } else {
            // nothing to update, or a resumed run that updated already: reopen on the staged corpus as it now is
            for (const s of members) await s.reopen?.(env).catch(() => {});
          }
          for (const s of members) {
            for (let r = 1; r <= repeatsOf(s); r++) await answerAll(store, meter, env, s, tasks, fraction, seed, concurrencyFor(s), progress, batch, r, opts.signal);
          }
          for (const s of members) await s.release?.(env);
        }
      }
    };
    // a pack the embedding budget cut short waits for it to open, then goes on where it stopped
    const runPackWithinBudget = async (pack: LoadedPack) => {
      for (;;) {
        const before = budget.refusals;
        try {
          // a pack's agent sessions may leave unless a source of it is private (src/eval/placement.ts)
          await withRemote(remote && packMayLeave(pack) ? remote : null, () => runPack(pack));
        } catch (err) {
          if (budget.refusals === before) throw err;
        }
        if (budget.refusals === before) return;
        progress(`[${pack.manifest.id}] cut short by the embedding budget: going on once it opens`);
        await budget.wait();
      }
    };
    await mapLimit(packs, opts.packConcurrency ?? 1, runPackWithinBudget, (err, pack) => {
      progress(`pack ${pack.manifest.id} stopped: ${err instanceof Error ? err.message : String(err)}`);
      store.log('pack failed', { pack: pack.manifest.id, error: err instanceof Error ? err.message : String(err) });
    });

    if (opts.signal?.aborted) throw new RunCancelledError();
    if (!opts.skipScoring) await scoreAnswers(store, judge, { tasks: tasksByKey, corpusDocs, citing }, progress, meter);
    if (remote) {
      const c = remote.counts;
      progress(`remote: ${c.remote} of ${c.offered} pieces offered were answered by workers; ${c.here} ran here`);
      store.log('remote', { ...c });
    }
  } finally {
    setAgentRouting(null);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    opts.signal?.removeEventListener('abort', onAbort);
    if (opts.signal?.aborted) await remote?.cancel();
    remote?.close();
    quota.setBypass(null);
    closeAdapters();
    await shim.close();
    if (localShim !== shim) await localShim.close();
    for (const l of loaded) l.staged.cleanup();
  }
  return { runDir, builds: store.allBuilds().length, answers: store.allAnswers().length, scores: store.allScores().length };
}

/**
 * Copy another run's finished builds of these packs, and its embedding
 * vectors, into this run. Refused when the other run embedded with another
 * model: a knode index or a RAG index answers queries only in its own space.
 * A build the other run updated (`<group>@<batch>`, applied in place) is left
 * out and listed in `updated`: its work directory holds the updated corpus.
 */
export function reuseBuilds(store: RunStore, from: string, packDirs: string[], embedding: string, fraction: number, seed: string | number, groups?: Set<string>): { builds: number; vectors: number; updated: string[] } {
  const src = new RunStore(from);
  const meta = src.meta();
  if (!meta) throw new Error(`--reuse-builds-from: not a run directory: ${from}`);
  if (meta.embedding !== embedding) throw new Error(`--reuse-builds-from: ${meta.id} embedded with ${meta.embedding}; this run embeds with ${embedding}`);
  let builds = 0;
  const updated: string[] = [];
  for (const dir of packDirs) {
    const pack = loadPack(dir);
    const all = src.allBuilds().filter((x) => x.pack === pack.manifest.id);
    for (const b of all.filter((x) => x.ok && !x.system.includes('@') && (!groups || groups.has(x.system)))) {
      if (b.key !== recordKey('build', pack.manifest.id, pack.manifest.version, b.system, fraction, seed) || store.build(b.key)) continue;
      if (all.some((x) => x.system.startsWith(`${b.system}@`))) {
        updated.push(`${pack.manifest.id}/${b.system}`);
        continue;
      }
      const work = path.join(from, 'work', pack.manifest.id, b.system);
      if (fs.existsSync(work)) fs.cpSync(work, store.workDir(pack.manifest.id, b.system), { recursive: true });
      store.putBuild({ ...b, notes: { ...b.notes, reusedFrom: meta.id, builtAt: b.at } });
      builds++;
    }
  }
  // the vectors the reused indexes were built with, so a reopened RAG index embeds nothing again — and
  // also when no build is reused (`--rebuild knode` beside systems that build nothing): they are what
  // an embedding endpoint is checked against, and without them the check falls to the workspace's
  // embedder, which stopped a run cold on a day its pool was out of quota
  let vectors = 0;
  const from_ = path.join(from, 'cache', 'vectors.jsonl');
  const to = path.join(store.cacheDir(), 'vectors.jsonl');
  if (fs.existsSync(from_) && !fs.existsSync(to)) {
    fs.copyFileSync(from_, to);
    vectors = fileLineCount(to);
  }
  return { builds, vectors, updated };
}

function fileLineCount(file: string): number {
  let n = 0;
  for (const line of fileLines(file)) if (line.trim()) n++;
  return n;
}

/** Build (or reopen) a group's knowledge base; false when it failed, so the run goes on without it. */
/**
 * Judge every answer not scored yet, or answered again since its score: one
 * blind pass over all systems at once (usage), then the emergence probes.
 * The judge is Claude, so this runs while Codex is paused for its plan window.
 */
export async function scoreAnswers(
  store: RunStore, judge: Judge,
  ctx: { tasks: Map<string, Task>; corpusDocs: Map<string, Set<string>>; citing: Set<string> },
  progress: (m: string) => void = () => {},
  meter?: Meter,
): Promise<number> {
  // a repeated answer (`--repeat`) keeps its system; its scores carry `repeat` and keys of their own (score/keys.ts)
  const answers = store.allAnswers().filter((a) => {
    if (!ctx.tasks.has(`${a.pack}|${a.taskId}`)) return false;
    const scored = store.score(scoreKey(a, 'latency_ms'));
    return !scored || scored.at < a.at;
  });
  if (!answers.length) return 0;
  progress(`scoring ${answers.length} answers`);
  const citing = ctx.citing;
  // where the judge's calls ran, on every score of the pass (docs/design/27 §8)
  const mark = meter?.mark() ?? 0;
  const pending: ScoreRecord[] = [];
  const put = (r: ScoreRecord) => pending.push(r);
  for (const r of await scoreUsage({ answers, tasks: ctx.tasks, citing }, judge)) put(r);
  for (const r of await scoreLists({ answers, tasks: ctx.tasks, corpusDocs: ctx.corpusDocs }, judge)) put(r);
  for (const r of await scoreEmergence({ answers, tasks: ctx.tasks, corpusDocs: ctx.corpusDocs }, judge)) put(r);
  const placed = where(meter?.placement((e) => e.system === JUDGE_SYSTEM, mark) ?? null);
  for (const r of pending) store.putScore({ ...r, ...placed });
  return answers.length;
}

/** A record's `worker` and `backend` from where its model calls ran; nothing when it made none. */
function where(p: Placed | null): { worker?: string; backend?: string } {
  return p ? { worker: p.worker, backend: p.backend } : {};
}

/**
 * `knode-os eval score <runDir>`: judge what a run has answered so far, from
 * its records and the packs it names — with no model of its own running, so
 * only while the run itself is stopped.
 */
export async function scoreRun(runDir: string, opts: { judgeProvider?: string; judgeModel?: string; onProgress?: (m: string) => void; remote?: RunOptions['remote'] } = {}): Promise<number> {
  const store = new RunStore(runDir);
  const meta = store.meta();
  if (!meta) throw new Error(`not a run directory: ${runDir}`);
  const meter = new Meter(path.join(runDir, 'meter.jsonl'));
  const quota = new QuotaGuard({ enabled: false, log: (m, d) => opts.onProgress?.(`${m}${d ? ` ${JSON.stringify(d)}` : ''}`) });
  const local = new LlmClient({ provider: opts.judgeProvider ?? 'claude-cli', baseUrl: '', apiKey: '', model: opts.judgeModel ?? '', cliPath: '', cliTimeoutMs: 600_000 });
  const tasks = new Map<string, Task>();
  const corpusDocs = new Map<string, Set<string>>();
  const packs: LoadedPack[] = [];
  for (const name of meta.packs) {
    const dir = path.isAbsolute(name) ? name : path.join(packsDir(), name);
    if (!fs.existsSync(path.join(dir, 'pack.json'))) continue;
    packs.push(loadPack(dir));
  }
  // the judge's calls go to remote workers too (docs/design/27 §8) — never for a run with a private pack
  const agent = judgeAgent(opts.judgeProvider ?? 'claude-cli', opts.judgeModel ?? '');
  const remote = opts.remote && agent && packs.every(packMayLeave) ? await RemoteEval.connect({ ...opts.remote, run: `${meta.id}-score`, quota, log: (m) => opts.onProgress?.(m) }) : null;
  const client = remote && agent ? remoteJudgeClient(local, remote, agent) : local;
  const judge = new Judge({ client, meter, quota, cacheFile: path.join(store.cacheDir(), 'judge.jsonl') });
  for (const pack of packs) {
    for (const t of pack.tasks) tasks.set(`${pack.manifest.id}|${t.id}`, t);
    const docs = new Set(pack.docs.map((d) => d.path));
    for (const batch of pack.updates) for (const f of listFiles(path.join(pack.dir, 'updates', batch))) docs.add(f);
    corpusDocs.set(pack.manifest.id, docs);
  }
  const citing = new Set(makeSystems(meta.systems).filter((s) => s.answers && s.kind !== 'reference' && s.cites !== false).map((s) => s.id));
  try {
    return await scoreAnswers(store, judge, { tasks, corpusDocs, citing }, opts.onProgress, meter);
  } finally {
    remote?.close();
  }
}

async function buildGroup(store: RunStore, meter: Meter, env: SystemEnv, group: string, members: SystemUnderTest[], fraction: number, seed: string | number, progress: (m: string) => void, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) throw new RunCancelledError();
  const builder = members.find((s) => s.build);
  if (!builder) return true;
  const key = recordKey('build', env.pack.manifest.id, env.pack.manifest.version, group, fraction, seed);
  const done = store.build(key);
  if (done?.ok) {
    progress(`[${env.pack.manifest.id}/${group}] reusing build from ${done.at}`);
    await builder.reopen?.(env);
    return true;
  }
  progress(`[${env.pack.manifest.id}/${group}] building`);
  const mark = meter.mark();
  const t0 = Date.now();
  let peak = process.memoryUsage().rss;
  const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 1000);
  let rec: BuildRecord;
  try {
    const r = await builder.build!(env);
    rec = {
      key, pack: env.pack.manifest.id, system: group, ok: true, ms: Date.now() - t0,
      usage: meter.usage((e) => e.system === group && !e.task, mark), stages: meter.stages(group, mark),
      bytes: r.kbDir ? kbBytes(group, r.kbDir) : 0, peakRssBytes: peak, notes: r.notes, at: new Date().toISOString(),
      ...where(meter.placement((e) => e.system === group && !e.task, mark)),
    };
  } catch (err) {
    rec = {
      key, pack: env.pack.manifest.id, system: group, ok: false, error: err instanceof Error ? err.message : String(err), ms: Date.now() - t0,
      usage: meter.usage((e) => e.system === group && !e.task, mark), stages: meter.stages(group, mark), bytes: 0, peakRssBytes: peak, at: new Date().toISOString(),
      ...where(meter.placement((e) => e.system === group && !e.task, mark)),
    };
    progress(`[${env.pack.manifest.id}/${group}] build failed: ${rec.error}`);
  } finally {
    clearInterval(sampler);
  }
  // a cancelled run writes no record of what it stopped: a resumed run builds it whole
  if (signal?.aborted) throw new RunCancelledError();
  store.putBuild(rec);
  if (!rec.ok) {
    store.log('build failed', { pack: env.pack.manifest.id, group, error: rec.error });
    for (const s of members) await s.release?.(env);
  }
  return rec.ok;
}

function kbBytes(group: string, dir: string): number {
  if (group === 'knode') return dirBytes(path.join(dir, '.knode')) + dirBytes(path.join(dir, 'wiki')) + dirBytes(path.join(dir, '.sidecar'));
  return dirBytes(dir);
}

/**
 * An answer's key. Repeat 1 keeps the key every run has used; a repeat
 * (`--repeat`) adds its index, and its task id carries `~r<n>` while it is
 * answered, so the shim asks the model again instead of replaying.
 */
export function answerKey(pack: string, system: string, taskId: string, fraction: number, seed: string | number, batch?: string, repeat = 1): string {
  return repeat > 1 ? recordKey('answer', pack, system, taskId, fraction, seed, batch, `r${repeat}`) : recordKey('answer', pack, system, taskId, fraction, seed, batch);
}

async function answerAll(
  store: RunStore, meter: Meter, env: SystemEnv, s: SystemUnderTest, tasks: Task[], fraction: number, seed: string | number,
  concurrency: number, progress: (m: string) => void, batch?: string, repeat = 1, signal?: AbortSignal,
): Promise<void> {
  if (!s.answers || !s.answer) return;
  const docs = new Set(env.staged.docs.map((d) => d.path));
  // an answer that ended in an error is asked again on resume (a timeout, a backend that was down)
  const todo = tasks.filter((t) => {
    const prev = store.answer(answerKey(env.pack.manifest.id, s.id, t.id, fraction, seed, batch, repeat));
    return !prev || Boolean(prev.error);
  });
  if (!todo.length) return;
  progress(`[${env.pack.manifest.id}/${s.id}] answering ${todo.length} tasks${repeat > 1 ? ` (repeat ${repeat})` : ''}`);
  let done = 0;
  await mapLimit(todo, s.serial ? 1 : concurrency, async (task) => {
    if (signal?.aborted) return;
    const key = answerKey(env.pack.manifest.id, s.id, task.id, fraction, seed, batch, repeat);
    // a repeat is asked under `<task>~r<n>`: its own meter tag and reply-cache key
    const t = repeat > 1 ? { ...task, id: `${task.id}~r${repeat}` } : task;
    // every answer, not only agents': one-shot systems spend the same plan
    await env.quota.wait();
    const mark = meter.mark();
    const t0 = Date.now();
    let rec: AnswerRecord;
    const placed = () => ({ ...(repeat > 1 ? { repeat } : {}), ...where(meter.placement((e) => e.system === s.id && e.task === t.id, mark)) });
    try {
      const a = await s.answer!(t, taskPrompt(task), env);
      rec = {
        key, pack: env.pack.manifest.id, system: s.id, taskId: task.id, ...(batch ? { batch } : {}), at: new Date().toISOString(),
        text: a.text, finalAnswer: extractFinalAnswer(a.text),
        citations: a.citations ?? citationsIn(a.text, docs), retrieved: a.retrieved ?? [], toolCalls: a.toolCalls ?? 0,
        ...(a.commands ? { commands: boundedTrace(a.commands) } : {}),
        ...(a.capped ? { capped: true } : {}), ...(a.leaked?.length ? { leaked: a.leaked } : {}), ...(a.error ? { error: a.error } : {}),
        usage: meter.usage((e) => e.system === s.id && e.task === t.id, mark), ms: Date.now() - t0,
        ...placed(),
      };
    } catch (err) {
      rec = {
        key, pack: env.pack.manifest.id, system: s.id, taskId: task.id, ...(batch ? { batch } : {}), at: new Date().toISOString(),
        text: '', finalAnswer: '', citations: [], retrieved: [], toolCalls: 0, error: err instanceof Error ? err.message : String(err),
        usage: meter.usage((e) => e.system === s.id && e.task === t.id, mark), ms: Date.now() - t0,
        ...placed(),
      };
    }
    // a cancelled run writes no record of what it stopped: a resumed run asks it whole
    if (signal?.aborted) return;
    store.putAnswer(rec);
    if (++done % 10 === 0) progress(`[${env.pack.manifest.id}/${s.id}] ${done}/${todo.length}`);
  }, () => {});
}

async function retrieveAll(store: RunStore, env: SystemEnv, s: SystemUnderTest, tasks: Task[], fraction: number, seed: string | number): Promise<void> {
  if (!s.retrieve) return;
  const { retrievalScores } = await import('./metrics/retrieval.js');
  for (const t of tasks) {
    if (!t.evidence.length || t.scoring === 'abstain' || t.suite !== 'usage') continue;
    const probe = recordKey('score', env.pack.manifest.id, s.id, t.id, 'recall@5');
    if (store.score(probe)) continue;
    let ranked: string[] = [];
    try {
      ranked = await s.retrieve(t.question, 10, env);
    } catch (err) {
      store.log('retrieve failed', { system: s.id, task: t.id, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const r = retrievalScores(ranked, [...new Set(t.evidence.map((e) => e.doc))]);
    const at = new Date().toISOString();
    const put = (metric: string, value: number) => store.putScore({ key: recordKey('score', env.pack.manifest.id, s.id, t.id, metric), pack: env.pack.manifest.id, system: s.id, suite: 'usage', taskId: t.id, taskType: t.type, metric, value, at, detail: metric === 'recall@5' ? { ranked } : undefined });
    for (const k of [2, 5, 10]) put(`recall@${k}`, r.recall[k]);
    put('all@5', r.all[5]);
    put('mrr@10', r.mrr10);
    put('ndcg@10', r.ndcg10);
  }
}

export { emptyUsage };
