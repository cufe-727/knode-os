import { foldSpace, seededKey, type PackIssues } from '../pack.js';
import { CorpusPlan, draftCorpusTasks } from './corpus-tasks.js';
import { extractFacts, generateTasks, TaskPlan } from './gold.js';
import type { RecipeContext } from './index.js';
import { PackWriter } from './writer.js';
import type { CorpusDoc } from '../types.js';

/**
 * The common tail of a document-based recipe (docs/design/23 §2): write the
 * documents, have the author model draft gold facts and tasks from them,
 * add the recipe's own model-free tasks (a dataset's published questions,
 * regex-derived links), and validate. A recipe only has to fetch and shape
 * its sources.
 */

export interface DocpackInput {
  writer: PackWriter;
  docs: (CorpusDoc & { text: string })[];
  lang: string;
  /** Tasks the recipe brings itself (published questions with gold answers). */
  tasks?: Parameters<PackWriter['addTask']>[0][];
  /** Tasks to draft from gold facts (none when the dataset brings enough). */
  plan?: TaskPlan;
  /** Documents gold facts are drafted from (default: all). */
  factDocs?: number;
  perDoc?: number;
  /** Corpus-level tasks to draft (aggregate, timeline, contradiction, profile, deep chains). */
  corpus?: CorpusPlan;
  /**
   * Scale curves: more documents of the same kind, of which up to
   * `multiple − 1` times the corpus is kept as padding — none that names a
   * closed-world task's term (checked here, and again by validatePack).
   */
  padding?: { candidates: (CorpusDoc & { text: string })[]; multiple: number };
}

export async function finishDocpack(input: DocpackInput, ctx: RecipeContext): Promise<PackIssues> {
  const { writer, docs } = input;
  for (const { text, ...doc } of docs) writer.addDoc(doc, text);
  for (const t of input.tasks ?? []) writer.addTask(t);
  if (ctx.author) {
    const factSource = docs.slice(0, input.factDocs ?? docs.length).map((d) => ({ path: d.path, text: d.text, date: d.date }));
    ctx.log(`drafting gold facts from ${factSource.length} documents`);
    const facts = await extractFacts(ctx.author, factSource, { lang: input.lang, perDoc: input.perDoc, log: ctx.log });
    for (const f of facts) writer.addFact(f);
    if (input.plan) {
      ctx.log(`drafting tasks from ${facts.length} facts`);
      for (const t of await generateTasks(ctx.author, facts, factSource, { lang: input.lang, plan: input.plan, seed: ctx.seed, log: ctx.log })) writer.addTask(t);
    }
    if (input.corpus) {
      ctx.log('drafting corpus-level tasks');
      for (const t of await draftCorpusTasks(ctx.author, facts, factSource, { lang: input.lang, plan: input.corpus, seed: ctx.seed, log: ctx.log })) writer.addTask(t);
    }
  } else if (input.plan || input.corpus) {
    ctx.log('no author model: gold facts and drafted tasks skipped');
  }
  if (input.padding && input.padding.multiple > 1) addPadding(writer, input.padding, docs.length, ctx);
  return writer.finish();
}

/** Padding that leaves every closed-world task's gold as it is: candidates naming a term are passed over. */
function addPadding(writer: PackWriter, padding: NonNullable<DocpackInput['padding']>, core: number, ctx: RecipeContext): void {
  const want = Math.round(core * (padding.multiple - 1));
  const tasks = writer.taskList.filter((t) => t.closedWorld);
  const terms = [...new Set(tasks.flatMap((t) => t.closedWorld!.terms))].map(foldSpace).filter(Boolean);
  const prefixes = [...new Set(tasks.flatMap((t) => t.closedWorld!.prefixes))];
  let kept = 0;
  let passed = 0;
  for (const c of [...padding.candidates].sort((a, b) => seededKey(ctx.seed ?? 0, a.path).localeCompare(seededKey(ctx.seed ?? 0, b.path)))) {
    if (kept >= want) break;
    const text = foldSpace(c.text);
    if (writer.hasDoc(c.path) || prefixes.some((p) => c.path.startsWith(p)) || terms.some((t) => text.includes(t))) {
      passed++;
      continue;
    }
    const { text: raw, ...doc } = c;
    writer.addPadding(doc, raw);
    kept++;
  }
  ctx.log(`padding: ${kept} of ${want} documents (${passed} candidates passed over for a closed-world term or prefix)`);
  if (kept < want) ctx.log(`padding: only ${kept} of ${want}: --fraction above ${(1 + kept / core).toFixed(1)} will be refused for this pack`);
}
