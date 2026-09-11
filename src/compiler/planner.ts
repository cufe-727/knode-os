import { sqlStringLiteral } from '../datasource/guard.js';
import { CapabilityRecord, Locator } from '../capability/store.js';
import { CapabilityStat, RankerScore, score, statsKey } from './ranker.js';
import { SlotSpec } from './intents.js';
import { PlanNode } from './plan.js';

/**
 * Slot planning: for each slot the intent declares, enumerate what could fill
 * it and score the options.
 *
 * The scoring is intentionally a small, readable formula rather than a model.
 * A planner that cannot explain "I chose the parquet table over MySQL because
 * it was cheaper and has answered this slot 4/5 times" is one nobody can
 * debug, and the numbers it needs — success rate, cost, latency — are all
 * things receipts already record.
 */

/**
 * Per-(intent, slot, capability) outcomes from past receipts, and the Thompson
 * draw the planner scores with. Both live in `ranker.ts`; this module only
 * decides what to do with the number.
 */
export { loadCapabilityStats as loadCandidateStats } from './ranker.js';

export interface SlotCandidate {
  slot: SlotSpec;
  /** `local` fills inside the database; `capability` becomes a plan node. */
  kind: 'local' | 'capability';
  capability?: CapabilityRecord;
  locator?: Locator;
  expectedGain: number;
  estCost: number;
  estLatencyMs: number;
  /**
   * Is this call worth making at all — computed from the posterior *mean*, so
   * a required slot with one candidate is never dropped because a draw came
   * out low. Thompson sampling decides which arm to pull, not whether to pull.
   */
  utility: number;
  /** Ordering among candidates for the same slot; this is where exploration lives. */
  explorationScore: number;
  /** The source is staler than the caller's freshness ceiling. */
  staler: boolean;
  /** The ranker's view of this pair — posterior, sample, whether it is exploring. */
  ranking: RankerScore;
  reason: string;
}

/** How well a capability matches a slot's hints — 0 when nothing lines up. */
function affinity(slot: SlotSpec, cap: CapabilityRecord): number {
  const hints = slot.capabilityHints ?? [];
  if (hints.length === 0) return 0.5;
  const haystack = `${cap.id} ${cap.name} ${cap.title} ${cap.semantics}`.toLowerCase();
  const hits = hints.filter((h) => haystack.includes(h.toLowerCase())).length;
  return hits === 0 ? 0 : Math.min(1, 0.5 + hits / hints.length / 2);
}

export interface PlanSlotsInput {
  slots: SlotSpec[];
  capabilities: CapabilityRecord[];
  locators: Locator[];
  /** Bindings that came back empty and are still believed empty — do not re-ask. */
  absences?: { capabilityId: string; param: string; value: string }[];
  /** Slots already satisfied from the materialized layer. */
  filledLocally: Set<string>;
  stats: Map<string, CapabilityStat>;
  /** The caller's freshness ceiling, if any. */
  freshnessSeconds: number | null;
  /** Seeded generator for the exploration draw — tests pass one to pin it. */
  rng?: () => number;
}

/**
 * Rank the ways each unfilled slot could be filled.
 *
 * A capability with no locator for any matched entity is kept but heavily
 * penalized: it might still answer, but "this table exists somewhere" is much
 * weaker evidence than "this table has a row keyed by exactly this company".
 */
export function planSlots(input: PlanSlotsInput): SlotCandidate[] {
  const byCapability = new Map<string, Locator[]>();
  for (const l of input.locators) {
    (byCapability.get(l.capabilityId) ?? byCapability.set(l.capabilityId, []).get(l.capabilityId)!).push(l);
  }

  const absent = new Set((input.absences ?? []).map((a) => `${a.capabilityId}|${a.param}=${a.value}`));

  const out: SlotCandidate[] = [];
  for (const slot of input.slots) {
    if (slot.fill === 'local' || input.filledLocally.has(slot.id)) continue;

    for (const cap of input.capabilities) {
      if (slot.capabilityKinds?.length && !slot.capabilityKinds.includes(cap.kind)) continue;
      const fit = affinity(slot, cap);
      if (fit === 0) continue;

      const locator = byCapability.get(cap.id)?.[0];
      // we asked this exact question recently and it came back empty; the
      // absence has its own expiry, so this suppression lifts on its own
      if (locator && absent.has(`${cap.id}|${locator.param}=${locator.value}`)) continue;
      // Thompson draw, not the posterior mean: a capability nobody has tried
      // has a wide posterior and so gets picked occasionally, which is the only
      // way it ever earns the evidence to be picked on merit
      const ranking = score(input.stats.get(statsKey(slot.id, cap.id)), input.rng);
      const weight = fit * (slot.required ? 1 : 0.5);
      // the mean answers "is this worth a call"; the draw answers "which one"
      const expectedGain = ranking.mean * weight;
      const explorationGain = ranking.sample * weight;

      const estCost = cap.cost;
      const estLatencyMs = cap.kind === 'tool' ? 50 : 400;
      const costPenalty = estCost * 0.1;
      const latencyPenalty = estLatencyMs / 10_000;
      // no way to bind an entity here: the call would be a guess
      const noisePenalty = locator || cap.kind === 'tool' ? 0 : 0.35;
      // the source is staler than the caller asked for
      const wanted = slot.freshnessSeconds ?? input.freshnessSeconds;
      const staler = wanted !== null && cap.freshnessSeconds !== null && cap.freshnessSeconds > wanted;
      const stalePenalty = staler ? 0.3 : 0;

      const penalties = costPenalty + latencyPenalty + noisePenalty + stalePenalty;
      const utility = expectedGain - penalties;
      const explorationScore = explorationGain - penalties;
      const reasons = [
        ranking.explain,
        locator ? `bound by ${locator.param}` : 'no locator for this entity',
        cap.freshnessSeconds !== null ? `≤${cap.freshnessSeconds}s stale` : 'freshness unknown',
        ...(staler ? ['staler than requested'] : []),
      ];
      out.push({
        slot, kind: 'capability', capability: cap, locator, staler,
        expectedGain, estCost, estLatencyMs, utility, explorationScore, ranking,
        reason: `${cap.id}: ${reasons.join(', ')}`,
      });
    }
  }
  // Freshness the caller asked for is a constraint, not a preference: a source
  // staler than the ceiling sorts behind every compliant one, and exploration
  // happens within each group. Trying a stale source "to learn" would be
  // answering a different question than the one asked.
  return out.sort((a, b) => Number(a.staler) - Number(b.staler) || b.explorationScore - a.explorationScore);
}

/**
 * Turn the winning candidates into plan nodes, one per slot, within budget.
 *
 * Nodes are emitted in utility order and stop at `maxToolCalls` — the cut is
 * reported in the pack's budget report rather than silently applied, because a
 * slot dropped for budget is a different thing from a slot nothing could fill.
 */
export function compileNodes(
  candidates: SlotCandidate[],
  maxNodes: number,
): { nodes: PlanNode[]; cut: { slot: string; capability: string; reason: string }[] } {
  const nodes: PlanNode[] = [];
  const cut: { slot: string; capability: string; reason: string }[] = [];
  const seenSlots = new Set<string>();
  const fallbacks = new Map<string, SlotCandidate[]>();

  for (const c of candidates) {
    if (!c.capability) continue;
    const list = fallbacks.get(c.slot.id) ?? fallbacks.set(c.slot.id, []).get(c.slot.id)!;
    list.push(c);
  }

  for (const c of candidates) {
    if (!c.capability || seenSlots.has(c.slot.id)) continue;
    if (nodes.length >= maxNodes) {
      cut.push({ slot: c.slot.id, capability: c.capability.id, reason: 'budget: max_tool_calls reached' });
      continue;
    }
    if (c.utility <= 0) {
      cut.push({ slot: c.slot.id, capability: c.capability.id, reason: `utility ${c.utility.toFixed(2)} — not worth the call` });
      continue;
    }
    seenSlots.add(c.slot.id);
    const id = `${c.slot.id}_${c.capability.sourceId}`.replace(/[^A-Za-z0-9_]/g, '_');
    const alternative = (fallbacks.get(c.slot.id) ?? []).find((x) => x.capability && x.capability.id !== c.capability!.id);
    nodes.push({
      id,
      fills: c.slot.id,
      capability: c.capability.id,
      tool: toolFor(c.capability),
      args: argsFor(c),
      binding: c.locator
        ? { entityId: c.locator.entityId, param: c.locator.param, value: c.locator.value }
        : undefined,
      freshness: c.slot.freshnessSeconds ?? c.capability.freshnessSeconds,
      onError: alternative?.capability
        ? { fallback: `${c.slot.id}_${alternative.capability.sourceId}`.replace(/[^A-Za-z0-9_]/g, '_') }
        : undefined,
      why: {
        expectedGain: Number(c.expectedGain.toFixed(3)),
        estCost: c.estCost,
        estLatencyMs: c.estLatencyMs,
        reason: c.reason,
        posterior: Number(c.ranking.mean.toFixed(3)),
        exploring: c.ranking.exploring,
      },
    });
  }
  return { nodes, cut };
}

function toolFor(cap: CapabilityRecord): PlanNode['tool'] {
  if (cap.kind === 'tool') return { kind: 'mcp', server: 'knode-os', name: cap.name };
  return { kind: 'mcp', server: 'knode-os', name: 'knode_query' };
}

/**
 * The request to send, written in the capability's own dialect and bound to
 * the entity through its locator. Written sample queries win when there are
 * any — someone who documented the query knows the table's quirks.
 */
function argsFor(c: SlotCandidate): Record<string, unknown> {
  const cap = c.capability!;
  if (cap.kind === 'tool') {
    return cap.name === 'knode_claims'
      ? { subject: c.locator?.value, types: c.slot.claimTypes?.length ? c.slot.claimTypes : undefined }
      : { query: c.locator?.value ?? c.slot.id, k: 6 };
  }

  const sample = cap.sampleQueries[0];
  const bound = c.locator;
  if (sample && bound) {
    return { source: cap.sourceId, sql: sample.replace(/\{(symbol|value|name|alias)\}/g, sqlStringLiteral(bound.value)) };
  }

  switch (cap.dialect) {
    case 'sql':
      return {
        source: cap.sourceId,
        sql: bound
          ? `SELECT * FROM ${cap.name} WHERE ${bound.param} = ${sqlStringLiteral(bound.value)} LIMIT 20`
          : `SELECT * FROM ${cap.name} LIMIT 20`,
      };
    case 'http':
      return {
        source: cap.sourceId,
        sql: bound ? `${cap.name}?${encodeURIComponent(bound.param)}=${encodeURIComponent(bound.value)}` : cap.name,
      };
    case 'promql':
      return {
        source: cap.sourceId,
        sql: bound ? `${cap.name}{${bound.param}="${bound.value.replace(/"/g, '\\"')}"}` : cap.name,
      };
    case 'object':
      return { source: cap.sourceId, sql: `list ${bound?.value ?? cap.name}` };
    default:
      return { source: cap.sourceId, sql: cap.name };
  }
}
