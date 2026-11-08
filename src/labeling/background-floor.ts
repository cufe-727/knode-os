import { KnodeConfig, processingSettings, resolveRoutedLlmConfig, routeTargets } from '../config.js';
import { cliCommand } from '../llm/cli.js';
import { PlanReadings, QuotaHold } from './plan-quota.js';

/**
 * The quota floor over background work (`processing.minQuotaPercent`, one
 * setting for the server): while a Codex or Claude plan has less than the
 * floor left in any window, nothing that runs on its own spends it — the
 * processing slots (src/labeling/local.ts), the research jobs and studies
 * (src/research/service.ts), the nightly Dream and the tier-2 pass. What a
 * person waits on — Ask — is never held, and nor are import-time image
 * conversions, which run as part of an import someone started.
 *
 * Every check goes through the readings `serve` shares (`PlanReadings`), so a
 * plan is read at most every two minutes however many workspaces ask.
 */

/** What runs on a plan: a provider, and the CLI it is reached through. */
export interface PlanUser {
  provider: string;
  cliPath?: string;
}

/** Whether background work on `user` must wait now, and why (null: it may run). */
export type BackgroundHold = (user: PlanUser) => Promise<QuotaHold | null>;

/** The floor as `config` sets it now, over the readings `plans` keeps. */
export function backgroundHold(plans: PlanReadings, config: () => Pick<KnodeConfig, 'processing'>): BackgroundHold {
  return (user) => plans.hold(user.provider, cliCommand(user.provider, user.cliPath ?? ''), processingSettings(config()).minQuotaPercent);
}

type StageRoute = 'entityLlm' | 'documentLlm' | 'summaryLlm' | 'judgeLlm' | 'translateLlm';

/** The hold on the first of the stage routes `keys` whose plan is under the floor, or null. */
export async function routesHold(config: KnodeConfig, keys: readonly StageRoute[], hold: BackgroundHold): Promise<QuotaHold | null> {
  const targets = routeTargets(config);
  for (const key of keys) {
    const llm = resolveRoutedLlmConfig(config.llm, config.extraction[key], targets);
    const held = await hold({ provider: llm.provider, cliPath: llm.cliPath });
    if (held) return held;
  }
  return null;
}
