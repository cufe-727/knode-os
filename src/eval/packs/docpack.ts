import type { PackIssues } from '../pack.js';
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
  } else if (input.plan) {
    ctx.log('no author model: gold facts and drafted tasks skipped');
  }
  return writer.finish();
}
