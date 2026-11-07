import fs from 'node:fs';
import path from 'node:path';
import { docText, foldSpace, loadPack, PackIssues, seededKey, validatePack, writeJsonl } from '../pack.js';
import { CORPUS_TASK_TYPES, CorpusDoc, PackManifestSchema, Task, TaskSchema } from '../types.js';
import { CorpusPlan, draftCorpusTasks } from './corpus-tasks.js';
import { recipe, RecipeContext } from './index.js';
import { evalTempDir } from '../tmp.js';

/**
 * `knode-os eval pack extend <pack>` (docs/design/23 §2.1): add corpus-level
 * tasks and padding to a pack that is already built, leaving its corpus as it
 * is — so the builds an earlier run made of it (keyed by pack id and version)
 * still serve, and a pack drawn from a live source (finance-cn's workspace)
 * is not re-sampled.
 *
 * - drafted tasks: profiles, timelines, contradictions, aggregates and chains
 *   from the pack's own gold facts and documents (the author model);
 * - model-free tasks: a recipe that writes them without an author (law-cn's
 *   statutes) is built again into a temporary directory, and its corpus-level
 *   tasks are taken when every document they cite is in the pack, unchanged;
 * - padding: from that temporary build's padding and from its documents the
 *   pack does not hold (a workspace that grew), none naming a closed-world
 *   term of any task.
 *
 * Tasks with the ids of earlier corpus-level tasks are replaced; nothing else
 * in the pack changes.
 */

export interface ExtendOptions extends RecipeContext {
  /** Override the recipe's corpus plan ({} drafts nothing). */
  corpus?: CorpusPlan;
  /** Padding to add, as a multiple of the corpus (10 → nine times the documents again). */
  padding?: number;
}

export async function extendPack(dir: string, opts: ExtendOptions): Promise<PackIssues & { added: number; padded: number }> {
  const pack = loadPack(dir);
  const r = recipe(pack.manifest.builder.recipe);
  const plan = opts.corpus ?? r.corpusPlan ?? {};
  const padding = opts.padding ?? 0;
  const log = opts.log;
  const corpusTexts = new Map(pack.docs.map((d) => [d.path, docText(pack, d.path)]));
  const fresh: Task[] = [];

  // a build without an author, for the model-free tasks and the padding candidates
  let candidates: (CorpusDoc & { text: string })[] = [];
  const wantsBuild = (r.modelFreeCorpus === true) || (padding > 1 && (r.padding === 'local' || r.padding === 'download'));
  if (wantsBuild) {
    if (padding > 1 && r.padding === 'download') log(`padding for ${pack.manifest.id} fetches more source material (cached once fetched)`);
    const tmp = evalTempDir('extend');
    try {
      const out = path.join(tmp.root, 'pack');
      await r.build(out, { ...opts, author: undefined, options: { ...pack.manifest.builder.options, ...opts.options, ...(padding > 1 ? { padding } : {}) } });
      const built = loadPack(out);
      const same = (doc: string) => corpusTexts.has(doc) && foldSpace(corpusTexts.get(doc)!) === foldSpace(docText(built, doc));
      if (r.modelFreeCorpus) {
        for (const t of built.tasks.filter((x) => CORPUS_TASK_TYPES.includes(x.type) || x.type === 'deep-hop')) {
          if (t.evidence.every((e) => same(e.doc)) && (t.items ?? []).every((it) => (it.docs ?? []).every(same))) fresh.push(t);
          else log(`model-free task ${t.id} left out: it cites a document the pack does not hold as built`);
        }
      }
      if (padding > 1) {
        const read = (sub: string, d: CorpusDoc) => ({ ...d, text: fs.readFileSync(path.join(out, sub, d.path), 'utf8') });
        candidates = [...built.padding.map((d) => read('padding', d)), ...built.docs.filter((d) => !corpusTexts.has(d.path)).map((d) => read('corpus', d))];
      }
    } finally {
      tmp.cleanup();
    }
  }

  // drafted tasks from the pack's own facts and documents
  if (opts.author && Object.values(plan).some((n) => Number(n) > 0)) {
    const lang = pack.manifest.languages[0] ?? 'en';
    const docs = pack.docs.map((d) => ({ path: d.path, text: corpusTexts.get(d.path) ?? '', date: d.date }));
    fresh.push(...await draftCorpusTasks(opts.author, pack.facts, docs, { lang, plan, seed: opts.seed, log }));
  } else if (Object.values(plan).some((n) => Number(n) > 0)) {
    log('no author model: drafted corpus-level tasks skipped');
  }

  // replace earlier tasks of the same ids, keep everything else
  const ids = new Set(fresh.map((t) => t.id));
  const tasks = [...pack.tasks.filter((t) => !ids.has(t.id)), ...fresh.map((t) => TaskSchema.parse(t))];
  const bySuite = new Map<string, Task[]>();
  for (const t of tasks) (bySuite.get(t.suite) ?? bySuite.set(t.suite, []).get(t.suite)!).push(t);
  for (const f of fs.existsSync(path.join(pack.dir, 'tasks')) ? fs.readdirSync(path.join(pack.dir, 'tasks')) : []) if (f.endsWith('.jsonl')) fs.rmSync(path.join(pack.dir, 'tasks', f));
  for (const [suite, list] of bySuite) writeJsonl(path.join(pack.dir, 'tasks', `${suite}.jsonl`), list);

  // padding: none that names a closed-world term or lies under a closed-world prefix of any task
  let padded = 0;
  if (padding > 1) {
    const closed = tasks.filter((t) => t.closedWorld);
    const terms = [...new Set(closed.flatMap((t) => t.closedWorld!.terms))].map(foldSpace).filter(Boolean);
    const prefixes = [...new Set(closed.flatMap((t) => t.closedWorld!.prefixes))];
    const want = Math.round(pack.docs.length * (padding - 1));
    fs.rmSync(path.join(pack.dir, 'padding'), { recursive: true, force: true });
    const kept: CorpusDoc[] = [];
    for (const c of [...candidates].sort((a, b) => seededKey(opts.seed ?? 0, a.path).localeCompare(seededKey(opts.seed ?? 0, b.path)))) {
      if (kept.length >= want) break;
      const text = foldSpace(c.text);
      if (corpusTexts.has(c.path) || kept.some((k) => k.path === c.path) || prefixes.some((p) => c.path.startsWith(p)) || terms.some((t) => text.includes(t))) continue;
      const { text: raw, ...doc } = c;
      const file = path.join(pack.dir, 'padding', doc.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, raw);
      kept.push(doc);
    }
    writeJsonl(path.join(pack.dir, 'padding.jsonl'), kept);
    padded = kept.length;
    log(`padding: ${padded} of ${want} documents from ${candidates.length} candidates`);
    if (padded < want) log(`padding: only ${padded} of ${want}: --fraction above ${(1 + padded / pack.docs.length).toFixed(1)} will be refused for this pack`);
  }

  const manifest = PackManifestSchema.parse({
    ...pack.manifest,
    builder: { ...pack.manifest.builder, options: { ...pack.manifest.builder.options, extended: { at: new Date().toISOString(), corpus: plan, padding, added: fresh.length } } },
    stats: { ...pack.manifest.stats, tasks: tasks.length, ...(padded ? { paddingDocuments: padded } : {}) },
  });
  fs.writeFileSync(path.join(pack.dir, 'pack.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { ...validatePack(loadPack(pack.dir)), added: fresh.length, padded };
}
