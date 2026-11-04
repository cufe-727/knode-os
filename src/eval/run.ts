import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapLimit } from '../bench/util.js';
import { LlmEffort, loadConfig } from '../config.js';
import { createEmbeddingProvider, EmbeddingProvider } from '../ingest/embeddings.js';
import { createConfiguredEmbeddingProvider } from '../ingest/embedding-router.js';
import { LlmClient } from '../llm/client.js';
import { Judge } from './judge.js';
import { Meter } from './meter.js';
import { dirBytes, loadPack, LoadedPack, runsDir, seededKey, stageCorpus, StagedCorpus, stageUpdate, validatePack } from './pack.js';
import { citationsIn, taskPrompt } from './prompts.js';
import { QuotaGuard } from './quota.js';
import { recordKey, RunMeta, RunStore } from './runstore.js';
import { scoreEmergence } from './score/emergence.js';
import { scoreGeneration } from './score/generation.js';
import { scoreUsage } from './score/usage.js';
import { ChatBackend, CodexBackend, startShim } from './shim.js';
import { makeSystems } from './systems/index.js';
import { SystemEnv, SystemUnderTest, taggedEmbedder } from './systems/types.js';
import { extractFinalAnswer } from './metrics/text.js';
import { AnswerRecord, BuildRecord, emptyUsage, Suite, SUITES, Task } from './types.js';

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
  /** A knode workspace whose config supplies the embedder (and, read-only, nothing else). */
  configFrom?: string;
  /** The Codex model every system builds and answers with ('' = Codex's default). */
  model?: string;
  buildEffort?: LlmEffort;
  answerEffort?: LlmEffort;
  /** Judge: a CLI provider ('claude-cli') and model. */
  judgeProvider?: string;
  judgeModel?: string;
  embedding?: 'workspace' | 'local';
  /** At most this many tasks per pack (stratified by type), and fewer for agents. */
  limit?: number;
  agentLimit?: number;
  fraction?: number;
  seed?: string | number;
  slots?: number;
  answerConcurrency?: number;
  /** Packs worked on at once (each builds and answers on its own; the shim's slots bound the model calls). */
  packConcurrency?: number;
  quota?: boolean;
  embeddingTokenCap?: number;
  /** Skip scoring (answers only) or answering (score what is there). */
  skipScoring?: boolean;
  /** Tests: stand-ins for Codex, the judge and the embedder. */
  overrides?: { chat?: ChatBackend; judge?: LlmClient; embedder?: EmbeddingProvider };
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

  const workspaceConfig = opts.configFrom ? loadConfig(opts.configFrom) : null;
  const embedder = opts.overrides?.embedder
    ?? (opts.embedding === 'local' || !workspaceConfig
      ? createEmbeddingProvider({ provider: 'local', baseUrl: '', apiKey: '', model: '', dimensions: 384, batchSize: 64, sendDimensions: false })
      : createConfiguredEmbeddingProvider(workspaceConfig));
  const backend = opts.overrides?.chat ?? new CodexBackend({ model: opts.model });
  const judgeClient = opts.overrides?.judge ?? new LlmClient({ provider: opts.judgeProvider ?? 'claude-cli', baseUrl: '', apiKey: '', model: opts.judgeModel ?? '', cliPath: '', cliTimeoutMs: 600_000 });
  const judge = new Judge({ client: judgeClient, meter, quota, cacheFile: path.join(store.cacheDir(), 'judge.jsonl') });
  const models = { model: opts.model ?? '', buildEffort: opts.buildEffort ?? 'low', answerEffort: opts.answerEffort ?? 'medium' };

  const shim = await startShim({
    backend,
    embedder,
    meter,
    cacheDir: store.cacheDir(),
    slots: opts.slots ?? 6,
    buildEffort: models.buildEffort,
    answerEffort: models.answerEffort,
    embeddingTokenCap: opts.embeddingTokenCap,
  });

  const meta: RunMeta = store.meta() ?? {
    id: path.basename(runDir),
    createdAt: new Date().toISOString(),
    gitSha: gitSha(),
    knodeVersion: knodeVersion(),
    packs: opts.packs.map((p) => path.basename(p)),
    systems: opts.systems,
    suites: [...suites],
    model: { connection: 'codex-cli', label: backend.label, buildEffort: models.buildEffort, answerEffort: models.answerEffort },
    judge: { connection: opts.judgeProvider ?? 'claude-cli', label: judgeClient.label },
    embedding: `${embedder.model} (${embedder.dimensions})`,
    fraction,
    seed,
    limit: opts.limit ?? null,
    versions: {},
  };
  store.writeMeta(meta);

  const tasksByKey = new Map<string, Task>();
  const corpusDocs = new Map<string, Set<string>>();
  const citing = new Set<string>();
  const loaded: { pack: LoadedPack; staged: StagedCorpus }[] = [];

  try {
    // every pack is validated before anything is spent on any of them
    const packs = opts.packs.map((dir) => {
      const pack = loadPack(dir);
      const issues = validatePack(pack);
      if (issues.errors.length) throw new Error(`pack ${pack.manifest.id} is invalid:\n- ${issues.errors.slice(0, 20).join('\n- ')}`);
      for (const w of issues.warnings) store.log('pack warning', { pack: pack.manifest.id, warning: w });
      return pack;
    });
    const runPack = async (pack: LoadedPack) => {
      const staged = stageCorpus(pack, { fraction, seed });
      loaded.push({ pack, staged });
      corpusDocs.set(pack.manifest.id, new Set(staged.docs.map((d) => d.path)));
      for (const t of pack.tasks) tasksByKey.set(`${pack.manifest.id}|${t.id}`, t);
      progress(`pack ${pack.manifest.id}: ${staged.docs.length} documents, ${staged.tasks.length} tasks`);

      const systems = makeSystems(opts.systems).filter((s) => s.applicable?.(pack) ?? true);
      for (const s of systems) if (s.answers && s.kind !== 'reference') citing.add(s.id);
      const groups = new Map<string, SystemUnderTest[]>();
      for (const s of systems) (groups.get(s.group) ?? groups.set(s.group, []).get(s.group)!).push(s);

      const failed = new Set<string>();
      const allTasks = selectTasks(staged.tasks.filter((t) => !t.afterUpdate), suites, opts.limit, seed);
      const updateTasks = suites.has('update') ? staged.tasks.filter((t) => t.afterUpdate) : [];

      for (const [group, members] of groups) {
        const env: SystemEnv = {
          runId: meta.id,
          pack,
          staged,
          workDir: store.workDir(pack.manifest.id, group),
          shim,
          meter,
          quota,
          models,
          log: (m) => progress(`[${pack.manifest.id}/${group}] ${m}`),
        };
        if (!(await buildGroup(store, meter, env, group, members, fraction, seed, progress))) {
          failed.add(group);
          continue;
        }
        for (const s of members) {
          for (const other of members) if (other !== s) await other.release?.();
          await answerAll(store, meter, env, s, isAgent(s) ? selectTasks(allTasks, suites, opts.agentLimit ?? 30, seed) : allTasks, fraction, seed, opts.answerConcurrency ?? 3, progress);
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
        for (const s of members) await s.release?.();
      }

      // update batches: apply each to the staged corpus, let every system that can update, then ask its tasks
      const batches = [...new Set(updateTasks.map((t) => t.afterUpdate!))].sort();
      for (const batch of batches) {
        const files = stageUpdate(pack, staged, batch);
        for (const f of files) corpusDocs.get(pack.manifest.id)!.add(f);
        const tasks = updateTasks.filter((t) => t.afterUpdate === batch);
        for (const [group, members] of groups) {
          if (failed.has(group)) continue;
          const env: SystemEnv = { runId: meta.id, pack, staged, workDir: store.workDir(pack.manifest.id, group), shim, meter, quota, models, log: (m) => progress(`[${pack.manifest.id}/${group}] ${m}`) };
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
            store.putBuild({ key, pack: pack.manifest.id, system: `${group}@${batch}`, ok, error, ms: Date.now() - t0, usage: meter.usage((e) => e.system === group, mark), stages: meter.stages(group, mark), bytes: 0, notes: { batch, files: files.length }, at: new Date().toISOString() });
          } else if (!updater) {
            for (const s of members) await s.reopen?.(env).catch(() => {});
          }
          for (const s of members) await answerAll(store, meter, env, s, tasks, fraction, seed, 1, progress, batch);
          for (const s of members) await s.release?.();
        }
      }
    };
    await mapLimit(packs, opts.packConcurrency ?? 1, runPack, (err, pack) => {
      progress(`pack ${pack.manifest.id} stopped: ${err instanceof Error ? err.message : String(err)}`);
      store.log('pack failed', { pack: pack.manifest.id, error: err instanceof Error ? err.message : String(err) });
    });

    if (!opts.skipScoring) {
      const answers = store.allAnswers().filter((a) => !store.score(recordKey('score', a.pack, a.system, a.taskId, 'latency_ms')));
      if (answers.length) {
        progress(`scoring ${answers.length} answers`);
        for (const r of await scoreUsage({ answers, tasks: tasksByKey, citing }, judge)) store.putScore(r);
        for (const r of await scoreEmergence({ answers, tasks: tasksByKey, corpusDocs }, judge)) store.putScore(r);
      }
    }
  } finally {
    await shim.close();
    for (const l of loaded) l.staged.cleanup();
  }
  return { runDir, builds: store.allBuilds().length, answers: store.allAnswers().length, scores: store.allScores().length };
}

/** Build (or reopen) a group's knowledge base; false when it failed, so the run goes on without it. */
async function buildGroup(store: RunStore, meter: Meter, env: SystemEnv, group: string, members: SystemUnderTest[], fraction: number, seed: string | number, progress: (m: string) => void): Promise<boolean> {
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
    };
  } catch (err) {
    rec = {
      key, pack: env.pack.manifest.id, system: group, ok: false, error: err instanceof Error ? err.message : String(err), ms: Date.now() - t0,
      usage: meter.usage((e) => e.system === group && !e.task, mark), stages: meter.stages(group, mark), bytes: 0, peakRssBytes: peak, at: new Date().toISOString(),
    };
    progress(`[${env.pack.manifest.id}/${group}] build failed: ${rec.error}`);
  } finally {
    clearInterval(sampler);
  }
  store.putBuild(rec);
  if (!rec.ok) {
    store.log('build failed', { pack: env.pack.manifest.id, group, error: rec.error });
    for (const s of members) await s.release?.();
  }
  return rec.ok;
}

function kbBytes(group: string, dir: string): number {
  if (group === 'knode') return dirBytes(path.join(dir, '.knode')) + dirBytes(path.join(dir, 'wiki')) + dirBytes(path.join(dir, '.sidecar'));
  return dirBytes(dir);
}

async function answerAll(
  store: RunStore, meter: Meter, env: SystemEnv, s: SystemUnderTest, tasks: Task[], fraction: number, seed: string | number,
  concurrency: number, progress: (m: string) => void, batch?: string,
): Promise<void> {
  if (!s.answers || !s.answer) return;
  const docs = new Set(env.staged.docs.map((d) => d.path));
  const todo = tasks.filter((t) => !store.answer(recordKey('answer', env.pack.manifest.id, s.id, t.id, fraction, seed, batch)));
  if (!todo.length) return;
  progress(`[${env.pack.manifest.id}/${s.id}] answering ${todo.length} tasks`);
  let done = 0;
  await mapLimit(todo, s.serial ? 1 : concurrency, async (t) => {
    const key = recordKey('answer', env.pack.manifest.id, s.id, t.id, fraction, seed, batch);
    const mark = meter.mark();
    const t0 = Date.now();
    let rec: AnswerRecord;
    try {
      const a = await s.answer!(t, taskPrompt(t), env);
      rec = {
        key, pack: env.pack.manifest.id, system: s.id, taskId: t.id, at: new Date().toISOString(),
        text: a.text, finalAnswer: extractFinalAnswer(a.text),
        citations: a.citations ?? citationsIn(a.text, docs), retrieved: a.retrieved ?? [], toolCalls: a.toolCalls ?? 0,
        ...(a.capped ? { capped: true } : {}), ...(a.leaked?.length ? { leaked: a.leaked } : {}), ...(a.error ? { error: a.error } : {}),
        usage: meter.usage((e) => e.system === s.id && e.task === t.id, mark), ms: Date.now() - t0,
      };
    } catch (err) {
      rec = {
        key, pack: env.pack.manifest.id, system: s.id, taskId: t.id, at: new Date().toISOString(),
        text: '', finalAnswer: '', citations: [], retrieved: [], toolCalls: 0, error: err instanceof Error ? err.message : String(err),
        usage: meter.usage((e) => e.system === s.id && e.task === t.id, mark), ms: Date.now() - t0,
      };
    }
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
