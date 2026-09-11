import { Store } from '../store/db.js';

/**
 * Daily LLM token budget ledger, shared by tier-1 extraction and tier-2
 * refinement. Spend is tracked per calendar day in the meta table against
 * `extraction.dailyTokenBudget`.
 */

function budgetKey(): string {
  return `extraction_budget:${new Date().toISOString().slice(0, 10)}`;
}

/** LLM tokens spent today against extraction.dailyTokenBudget (tier 1 + tier 2). */
export async function budgetUsedToday(store: Store): Promise<number> {
  const v = await store.getMeta<{ tokens: number }>(budgetKey());
  return v?.tokens ?? 0;
}

export async function addBudgetUse(store: Store, tokens: number): Promise<void> {
  const used = await budgetUsedToday(store);
  await store.setMeta(budgetKey(), { tokens: used + tokens });
}
