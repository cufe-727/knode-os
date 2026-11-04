import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  CorpusDoc, CorpusDocSchema, GoldAlias, GoldAliasSchema, GoldFact, GoldFactSchema, GoldLink, GoldLinkSchema,
  PackManifest, PackManifestSchema, Task, TaskSchema,
} from './types.js';

/**
 * Benchmark packs on disk (docs/design/23 §1).
 *
 *   pack.json  corpus/ corpus.jsonl  holdout/  gold/{facts,links,aliases}.jsonl gold/profile.json
 *   tasks/*.jsonl  updates/NN/  injections/
 *
 * Packs live outside the repository (`~/knode-eval/packs`): they hold
 * downloaded third-party text. A system under test never reads the pack
 * directory — `stageCorpus` copies the documents somewhere with nothing
 * else beside them, so an agent cannot wander from the corpus into the gold.
 */

export const EVAL_HOME = process.env.KNODE_EVAL_HOME || path.join(os.homedir(), 'knode-eval');
export const packsDir = () => path.join(EVAL_HOME, 'packs');
export const runsDir = () => path.join(EVAL_HOME, 'runs');
export const sourcesDir = () => path.join(EVAL_HOME, 'sources');

export interface LoadedPack {
  dir: string;
  manifest: PackManifest;
  docs: CorpusDoc[];
  tasks: Task[];
  facts: GoldFact[];
  links: GoldLink[];
  aliases: GoldAlias[];
  profile: Record<string, unknown>;
  /** Update batches, in order: updates/01, updates/02 … */
  updates: string[];
  /** Documents planted to attack the system (prompt injection), relative to injections/. */
  injections: string[];
}

export function readJsonl<T>(file: string, schema: z.ZodType<T>): T[] {
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    const parsed = schema.safeParse(JSON.parse(line));
    if (!parsed.success) throw new Error(`${file}:${i + 1}: ${parsed.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('; ')}`);
    out.push(parsed.data);
  });
  return out;
}

export function writeJsonl(file: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

/** Text files under `dir`, relative and sorted, hidden entries skipped. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out.push(r);
    }
  };
  if (fs.existsSync(dir)) walk('');
  return out.sort();
}

export function loadPack(dir: string): LoadedPack {
  const abs = path.resolve(dir);
  const manifestFile = path.join(abs, 'pack.json');
  if (!fs.existsSync(manifestFile)) throw new Error(`not a benchmark pack (no pack.json): ${abs}`);
  const manifest = PackManifestSchema.parse(JSON.parse(fs.readFileSync(manifestFile, 'utf8')));
  const corpusDir = path.join(abs, 'corpus');
  const listed = readJsonl(path.join(abs, 'corpus.jsonl'), CorpusDocSchema);
  const known = new Set(listed.map((d) => d.path));
  // a file in corpus/ that corpus.jsonl does not list is still a document
  const docs = [...listed, ...listFiles(corpusDir).filter((p) => !known.has(p)).map((p) => ({ path: p }))];
  const tasks = listFiles(path.join(abs, 'tasks')).filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => readJsonl(path.join(abs, 'tasks', f), TaskSchema));
  const profileFile = path.join(abs, 'gold', 'profile.json');
  const updatesDir = path.join(abs, 'updates');
  return {
    dir: abs,
    manifest,
    docs,
    tasks,
    facts: readJsonl(path.join(abs, 'gold', 'facts.jsonl'), GoldFactSchema),
    links: readJsonl(path.join(abs, 'gold', 'links.jsonl'), GoldLinkSchema),
    aliases: readJsonl(path.join(abs, 'gold', 'aliases.jsonl'), GoldAliasSchema),
    profile: fs.existsSync(profileFile) ? (JSON.parse(fs.readFileSync(profileFile, 'utf8')) as Record<string, unknown>) : {},
    updates: fs.existsSync(updatesDir)
      ? fs.readdirSync(updatesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
      : [],
    injections: listFiles(path.join(abs, 'injections')),
  };
}

export function docText(pack: LoadedPack, doc: string): string {
  const file = path.join(pack.dir, 'corpus', doc);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/** Whitespace folded, for checking that a quote occurs in its document. */
export function foldSpace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export interface PackIssues {
  errors: string[];
  warnings: string[];
}

/**
 * What would make a pack's scores meaningless: evidence pointing at missing
 * documents or quotes that are not in them, duplicate ids, tasks without
 * the gold their scoring needs, and gold that leaks into the corpus.
 */
export function validatePack(pack: LoadedPack): PackIssues {
  const errors: string[] = [];
  const warnings: string[] = [];
  const docs = new Set(pack.docs.map((d) => d.path));
  const texts = new Map<string, string>();
  const text = (doc: string) => {
    if (!texts.has(doc)) texts.set(doc, foldSpace(docText(pack, doc)));
    return texts.get(doc)!;
  };

  if (pack.docs.length === 0) errors.push('corpus/ holds no documents');
  for (const d of pack.docs) if (!fs.existsSync(path.join(pack.dir, 'corpus', d.path))) errors.push(`corpus.jsonl lists ${d.path}, which is not in corpus/`);

  const ids = new Set<string>();
  for (const t of pack.tasks) {
    if (ids.has(t.id)) errors.push(`duplicate task id ${t.id}`);
    ids.add(t.id);
    for (const e of t.evidence) {
      // update tasks may cite a document that only an update batch adds
      if (!docs.has(e.doc)) {
        if (!t.afterUpdate) errors.push(`task ${t.id}: evidence doc ${e.doc} is not in the corpus`);
        continue;
      }
      if (e.quote && !text(e.doc).includes(foldSpace(e.quote))) errors.push(`task ${t.id}: quote not found in ${e.doc}: "${e.quote.slice(0, 60)}"`);
    }
    if ((t.scoring === 'judge' || t.scoring === 'exact') && !t.answer && !t.answers?.length) errors.push(`task ${t.id}: ${t.scoring} scoring needs an answer`);
    if (t.scoring === 'set' && !t.items?.length) errors.push(`task ${t.id}: set scoring needs items`);
    if (t.scoring === 'choice' && (!t.choices?.length || !t.answer || !t.choices.includes(t.answer))) errors.push(`task ${t.id}: choice scoring needs choices that include the answer`);
    if (t.scoring === 'keypoints' && !t.keypoints?.length) errors.push(`task ${t.id}: keypoints scoring needs keypoints`);
    if (t.scoring === 'label' && !t.answer) errors.push(`task ${t.id}: label scoring needs an answer`);
    if (t.afterUpdate && !pack.updates.includes(t.afterUpdate)) errors.push(`task ${t.id}: update batch ${t.afterUpdate} does not exist`);
    if (t.type === 'unanswerable' && t.scoring !== 'abstain') warnings.push(`task ${t.id}: unanswerable but scored ${t.scoring}`);
  }

  const factIds = new Set<string>();
  for (const f of pack.facts) {
    if (factIds.has(f.id)) errors.push(`duplicate fact id ${f.id}`);
    factIds.add(f.id);
    if (!docs.has(f.doc)) errors.push(`fact ${f.id}: doc ${f.doc} is not in the corpus`);
    else if (f.quote && !text(f.doc).includes(foldSpace(f.quote))) errors.push(`fact ${f.id}: quote not found in ${f.doc}`);
  }

  // the holdout must not be readable from the corpus: a holdout file copied into corpus/ by mistake
  const holdout = listFiles(path.join(pack.dir, 'holdout'));
  const corpusNames = new Set(pack.docs.map((d) => path.basename(d.path)));
  for (const h of holdout) if (corpusNames.has(path.basename(h))) warnings.push(`holdout/${h} shares a file name with a corpus document`);

  if (pack.tasks.length === 0) warnings.push('the pack has no tasks');
  const suites = new Set(pack.tasks.map((t) => t.suite));
  if (pack.facts.length === 0 && !suites.has('generation')) warnings.push('no gold facts: generation coverage cannot be scored');
  return { errors, warnings };
}

export function writeManifest(dir: string, manifest: PackManifest): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(PackManifestSchema.parse(manifest), null, 2) + '\n');
}

/** Deterministic order and selection from a seed: the same seed picks the same documents. */
export function seededKey(seed: string | number, id: string): string {
  return crypto.createHash('sha256').update(`${seed}|${id}`).digest('hex');
}

export interface StagedCorpus {
  /** The directory a system reads — a fresh temp directory with nothing else in its parent. */
  dir: string;
  docs: CorpusDoc[];
  /** Tasks whose evidence is all inside the staged documents. */
  tasks: Task[];
  cleanup: () => void;
}

/**
 * Copy the corpus — or a seeded fraction of it — to a new directory under the
 * OS temp dir. Tasks whose evidence falls outside the fraction are dropped
 * (an unanswerable task stays: it has none). Update batches are not copied;
 * `stageUpdate` adds one when an update suite asks for it.
 */
export function stageCorpus(pack: LoadedPack, opts: { fraction?: number; seed?: string | number } = {}): StagedCorpus {
  const fraction = opts.fraction ?? 1;
  const seed = opts.seed ?? 0;
  const keep = fraction >= 1
    ? pack.docs
    : [...pack.docs].sort((a, b) => seededKey(seed, a.path).localeCompare(seededKey(seed, b.path)))
      .slice(0, Math.max(1, Math.round(pack.docs.length * fraction)));
  const kept = new Set(keep.map((d) => d.path));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-eval-'));
  const dir = path.join(root, 'corpus');
  for (const d of keep) {
    const to = path.join(dir, d.path);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(pack.dir, 'corpus', d.path), to);
  }
  const tasks = pack.tasks.filter((t) => t.afterUpdate || t.evidence.every((e) => kept.has(e.doc)));
  return { dir, docs: keep, tasks, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Copy an update batch into a staged corpus; returns the documents it added or replaced. */
export function stageUpdate(pack: LoadedPack, staged: StagedCorpus, batch: string): string[] {
  const from = path.join(pack.dir, 'updates', batch);
  const files = listFiles(from);
  for (const f of files) {
    const to = path.join(staged.dir, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(from, f), to);
  }
  return files;
}

/** Copy planted injection documents into a staged corpus (robustness suite). */
export function stageInjections(pack: LoadedPack, staged: StagedCorpus): string[] {
  for (const f of pack.injections) {
    const to = path.join(staged.dir, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(pack.dir, 'injections', f), to);
  }
  return pack.injections;
}

/** Bytes a directory takes, recursively. */
export function dirBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const walk = (p: string) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const abs = path.join(p, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) total += fs.statSync(abs).size;
    }
  };
  walk(dir);
  return total;
}
