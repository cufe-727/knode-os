import type { LlmClient } from '../../llm/client.js';
import type { PackIssues } from '../pack.js';
import type { CorpusPlan } from './corpus-tasks.js';
import { buildFixturePack } from './fixture.js';

/**
 * Pack recipes (docs/design/23 §2): each knows where its sources come from,
 * how to fetch them into the download cache, and how to write the corpus,
 * the gold and the tasks. `knode-os eval pack build <recipe>` runs one.
 */

export interface RecipeContext {
  /** At most this many documents. */
  limit?: number;
  /** The model that drafts gold facts, tasks and synthetic sources (Claude: not the answerer's family). */
  author?: LlmClient;
  seed?: string | number;
  log: (msg: string) => void;
  options: Record<string, unknown>;
}

export interface Recipe {
  id: string;
  title: string;
  domain: string;
  /** Downloads public material (into ~/knode-eval/sources). */
  network: boolean;
  /** Needs a model to write gold or tasks. */
  needsAuthor: boolean;
  build(dir: string, ctx: RecipeContext): Promise<PackIssues>;
  /** Corpus-level tasks `eval pack extend` drafts for a built pack of this recipe. */
  corpusPlan?: CorpusPlan;
  /** A build without an author already writes corpus-level tasks (law-cn's statutes): `extend` takes them from one. */
  modelFreeCorpus?: boolean;
  /** `extend` can take padding from a build with `padding` set, without a model (local or cached sources). */
  padding?: 'local' | 'download' | 'author';
}

const recipes: Recipe[] = [
  { id: 'fixture', title: 'Tiny template-written synthetic life (tests, smoke runs)', domain: 'fixture', network: false, needsAuthor: false, build: async (dir) => buildFixturePack(dir) },
];

export function registerRecipe(r: Recipe): void {
  const i = recipes.findIndex((x) => x.id === r.id);
  if (i >= 0) recipes[i] = r;
  else recipes.push(r);
}

export function listRecipes(): Recipe[] {
  return [...recipes];
}

export function recipe(id: string): Recipe {
  const r = recipes.find((x) => x.id === id);
  if (!r) throw new Error(`unknown pack recipe "${id}" (known: ${recipes.map((x) => x.id).join(', ')})`);
  return r;
}
