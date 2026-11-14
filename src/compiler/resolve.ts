import { AppContext } from '../context.js';
import { listCapabilities, locatorsForEntities, CapabilityRecord, Locator } from '../capability/store.js';
import { claimsForEntities } from '../graph/query.js';
import { claimTypeOf } from '../graph/store.js';
import { liveAbsences } from './absence.js';
import { buildContextPack, ContextPack, PackClaim, PackEntity, matchEntities } from '../pack/pack.js';
import { NO_FILTER, ResolvedScopeFilter, ResolvedTemporal, resolveTemporal } from '../store/resolver.js';
import { Budget, DEFAULT_INTENT, IntentSpec, SlotSpec, loadIntents, matchIntent } from './intents.js';
import { Plan, NextQuery, nextQueriesOf, planSha, renderJsonGraph, renderTsProgram } from './plan.js';
import { compileNodes, loadCandidateStats, planSlots } from './planner.js';
import { instantiate, loadRecipes, resolveRecipe } from './recipes.js';
import { recordReceipt } from './receipts.js';

/**
 * The Context Compiler.
 *
 * `search` answers "what text looks like this question". `resolve` answers
 * "what does an answer to this question need, what do I already have, and what
 * is left to run" — and says so explicitly, slot by slot. The difference shows
 * up as `unknowns`: a resolve that cannot fill a required slot reports the
 * hole instead of returning six plausible documents and letting the agent
 * discover it.
 *
 *   1. intent      match the utterance against intents/*.yaml
 *   2. ground      match entities, then look up how to reach them (locators)
 *   3. plan        enumerate local vs live candidates per slot, score them
 *   4. fill local  everything the materialized layer can answer, answered here
 *   5. compile     the rest becomes a Plan the agent executes
 *   6. assemble    ContextPack v2 + a receipt id to report back against
 */

export interface SlotReport {
  id: string;
  required: boolean;
  description?: string;
  filled: boolean;
  /** Where it was filled from, or why it could not be. */
  source: string;
}

export interface Unknown {
  question: string;
  defaultAssumption: string;
  risk: 'low' | 'medium' | 'high';
}

export interface BudgetReport {
  budget: Budget;
  planned: number;
  cut: { slot: string; capability: string; reason: string }[];
}

export interface ContextPackV2 {
  version: 2;
  receiptId: string;
  intent: { type: string; title: string; matchedBy: string[]; entities: PackEntity[]; timeRange: { asOf: string; validAt: string | null; validRange: { from: string | null; to: string | null } | null } };
  slots: SlotReport[];
  facts: PackClaim[];
  documents: ContextPack['evidence']['docs'];
  graphContext: { capabilities: { id: string; title: string; dialect: string; freshnessSeconds: number | null }[]; locators: Locator[] };
  datasets: ContextPack['evidence']['datasets'];
  /** Filled by the agent through knode_feedback after it executes the plan. */
  liveResults: never[];
  unknowns: Unknown[];
  plan: Plan;
  planProgram: string;
  availableNextQueries: NextQuery[];
  budgetReport: BudgetReport;
  guidance: string[];
  applied: string[];
}

export interface ResolveOptions {
  actor?: string;
  temporal?: ResolvedTemporal;
  filter?: ResolvedScopeFilter;
  budget?: Partial<Budget>;
  /** Skip writing a receipt (benchmarks, dry runs — it skews the learning loop). */
  record?: boolean;
  /** false: the context pack's search records no hits (src/stats/heat.ts). */
  track?: boolean;
  /** `ts-program` renders the plan as code instead of a node graph. */
  render?: Plan['render'];
  /**
   * Generator behind the ranker's exploration draw. Injectable so a caller —
   * a test, a benchmark, a replay — can pin the choice; an exploration
   * strategy nobody can reproduce is one nobody can debug.
   */
  rng?: () => number;
}

/** Local evidence the pack already gathered, mapped onto the intent's slots. */
function fillLocally(slot: SlotSpec, pack: ContextPack, claims: PackClaim[]): { filled: boolean; source: string } {
  if (slot.fill === 'live') return { filled: false, source: 'declared live-only' };
  for (const from of slot.from) {
    if (from === 'entity' && pack.matchedEntities.length > 0) return { filled: true, source: `entity ${pack.matchedEntities[0].name}` };
    if (from === 'graph' && pack.matchedEntities.length > 0) return { filled: true, source: 'graph neighbourhood' };
    if (from === 'documents' && pack.evidence.docs.length > 0) return { filled: true, source: `${pack.evidence.docs.length} indexed chunks` };
    if (from === 'claims') {
      const asked = new Set((slot.claimTypes ?? []).map((t) => claimTypeOf(t) ?? t));
      const wanted = asked.size > 0 ? claims.filter((c) => asked.has(c.type)) : claims;
      if (wanted.length > 0) return { filled: true, source: `${wanted.length} claims` };
    }
    if (from === 'datasets' && pack.evidence.datasets.length > 0) return { filled: true, source: `${pack.evidence.datasets.length} linked tables` };
  }
  return { filled: false, source: 'nothing local matched' };
}

export async function resolve(ctx: AppContext, query: string, opts: ResolveOptions = {}): Promise<ContextPackV2> {
  const temporal = opts.temporal ?? resolveTemporal({});
  const filter = opts.filter ?? NO_FILTER;

  /* 1 ── intent */
  const entities = await matchEntities(ctx, query, ctx.config.pack.maxEntities, { temporal, filter });
  const intents = loadIntents(ctx.dataDir);
  const matched = matchIntent(intents, query, entities.map((e) => e.type));
  const intent: IntentSpec = matched.intent ?? DEFAULT_INTENT;
  const budget: Budget = { ...intent.budget, ...clean(opts.budget) };

  /* 2 ── ground: how can these entities be reached, and through what */
  const entityIds = entities.map((e) => e.id);
  const [locators, capabilities, absences] = await Promise.all([
    locatorsForEntities(ctx.store, entityIds, temporal.txTime),
    listCapabilities(ctx.store, { asOf: temporal.txTime }),
    liveAbsences(ctx.store, entityIds, temporal.txTime ?? undefined),
  ]);

  /* 4 ── local fill: everything the materialized layer can answer, answered here */
  const pack = await buildContextPack(ctx, query, { record: false, track: opts.track, temporal, filter });
  const claims = await claimsForEntities(ctx.store, entityIds, ctx.config.pack.maxClaims, { temporal, filter });
  const slotReports: SlotReport[] = [];
  const filledLocally = new Set<string>();
  for (const slot of intent.slots) {
    const local = fillLocally(slot, pack, pack.evidence.claims);
    if (local.filled) filledLocally.add(slot.id);
    slotReports.push({ id: slot.id, required: slot.required, description: slot.description, filled: local.filled, source: local.source });
  }

  /* 3 + 5 ── score the remaining slots and compile them into a plan */
  const stats = await loadCandidateStats(ctx.store, intent.id);
  const candidates = planSlots({
    slots: intent.slots,
    capabilities,
    locators,
    filledLocally,
    stats,
    absences,
    freshnessSeconds: temporal.freshnessSeconds,
    rng: opts.rng,
  });
  const { nodes: plannedNodes, cut } = compileNodes(candidates, budget.maxToolCalls);

  // A recipe is what happens when somebody has already said how to answer this
  // question; the planner is what happens when nobody has. So recipe nodes go
  // first and the planner only fills the slots they leave open.
  const recipes = loadRecipes(ctx.dataDir);
  const recipe = entities[0]
    ? resolveRecipe(recipes, { intent: intent.id, entityId: entities[0].id, entityType: entities[0].type })
    : resolveRecipe(recipes, { intent: intent.id });
  // A recipe node for a slot the materialized layer already answered would
  // re-run work whose result is in this very pack, so drop it — the recipe
  // still owns every slot local evidence could not fill.
  const recipeNodes = (recipe && entities[0]
    ? instantiate(recipe, { id: entities[0].id, name: entities[0].name, aliases: entities[0].aliases }, locators)
    : []
  ).filter((n) => !filledLocally.has(n.fills));
  const recipeSlots = new Set(recipeNodes.map((n) => n.fills));
  const nodes = [...recipeNodes, ...plannedNodes.filter((n) => !recipeSlots.has(n.fills))].slice(0, budget.maxToolCalls);
  for (const dropped of plannedNodes.filter((n) => !nodes.includes(n))) {
    cut.push({ slot: dropped.fills, capability: dropped.capability ?? '?', reason: recipeSlots.has(dropped.fills) ? `recipe ${recipe?.path} already fills it` : 'budget: max_tool_calls reached' });
  }
  for (const node of nodes) {
    const report = slotReports.find((s) => s.id === node.fills);
    if (report) report.source = `${report.source}; planned via ${node.capability ?? node.tool.name}`;
  }

  const plan: Plan = {
    planId: '',
    intent: intent.id,
    budget,
    slots: {
      required: intent.slots.filter((s) => s.required).map((s) => s.id),
      optional: intent.slots.filter((s) => !s.required).map((s) => s.id),
      filledLocally: [...filledLocally],
    },
    nodes,
    render: opts.render ?? 'json-graph',
  };

  /* 6 ── assemble */
  const plannedSlots = new Set(nodes.map((n) => n.fills));
  const unknowns: Unknown[] = slotReports
    .filter((s) => !s.filled && !plannedSlots.has(s.id))
    .map((s) => ({
      question: `${s.description ?? s.id} — nothing local answers it and no capability can be planned for it`,
      defaultAssumption: s.required
        ? 'answer without it and say so, or ask the user for the missing source'
        : 'proceed without it',
      risk: s.required ? 'high' : 'low',
    }));
  const gaps = [...pack.gaps, ...unknowns.map((u) => u.question)];

  const receiptId = opts.record === false
    ? 'r_unrecorded'
    : await recordReceipt(ctx.store, {
      kind: 'resolve',
      query,
      actor: opts.actor,
      intent: intent.id,
      recipePath: recipe?.path ?? intent.path,
      entities: entityIds,
      playbooks: pack.playbooksUsed,
      datasets: pack.evidence.datasets.map((d) => d.id),
      gaps,
      plan: { ...plan, planId: 'pending' },
      budget,
      summary: {
        docCount: pack.evidence.docs.length,
        claimCount: claims.length,
        staleCount: pack.evidence.claims.filter((c) => c.stale).length,
        conflictCount: pack.evidence.claims.filter((c) => c.conflictsWith.length > 0).length,
        slotsFilled: filledLocally.size,
        slotsUnfilled: intent.slots.length - filledLocally.size,
      },
      asOf: temporal.txTime,
      validAt: temporal.validPoint ? temporal.validFrom : null,
    });
  // the plan id is the receipt id: executing a plan and reporting on it are
  // the same transaction as far as the learning loop is concerned
  plan.planId = receiptId;

  return {
    version: 2,
    receiptId,
    intent: {
      type: intent.id,
      title: intent.title,
      matchedBy: [...matched.reasons, ...(recipe ? [`recipe ${recipe.path}`] : [])],
      entities,
      timeRange: {
        asOf: temporal.txTime ?? pack.asOf,
        validAt: pack.validAt,
        validRange: pack.validRange,
      },
    },
    slots: slotReports,
    facts: pack.evidence.claims,
    documents: pack.evidence.docs,
    graphContext: {
      capabilities: capabilities.map((c) => ({ id: c.id, title: c.title || c.name, dialect: c.dialect, freshnessSeconds: c.freshnessSeconds })),
      locators,
    },
    datasets: pack.evidence.datasets,
    liveResults: [],
    unknowns,
    plan,
    planProgram: plan.render === 'ts-program' ? renderTsProgram(plan) : '',
    availableNextQueries: nextQueriesOf(plan),
    budgetReport: {
      budget,
      planned: nodes.length,
      cut: [
        ...cut,
        ...absences.map((a) => ({
          slot: '(any)',
          capability: a.capabilityId,
          reason: `known absence until ${a.validTo ?? 'further notice'}: ${a.statement}`,
        })),
      ],
    },
    guidance: [...pack.guidance, intent.guidance, recipe?.guidance ?? ''].filter(Boolean),
    applied: pack.applied,
  };
}

function clean(b: Partial<Budget> | undefined): Partial<Budget> {
  if (!b) return {};
  const out: Partial<Budget> = {};
  if (Number.isFinite(b.maxToolCalls) && (b.maxToolCalls ?? 0) > 0) out.maxToolCalls = Math.floor(b.maxToolCalls!);
  if (Number.isFinite(b.maxLatencyMs) && (b.maxLatencyMs ?? 0) > 0) out.maxLatencyMs = Math.floor(b.maxLatencyMs!);
  if (Number.isFinite(b.maxTokens) && (b.maxTokens ?? 0) > 0) out.maxTokens = Math.floor(b.maxTokens!);
  return out;
}

/** Just the plan, for an agent that already has its context and wants the work. */
export async function planOnly(ctx: AppContext, query: string, opts: ResolveOptions = {}): Promise<{ plan: Plan; phases: string[][]; program: string; sha: string }> {
  const pack = await resolve(ctx, query, opts);
  return {
    ...renderJsonGraph(pack.plan),
    program: renderTsProgram(pack.plan),
    sha: planSha(pack.plan),
  };
}

export type { CapabilityRecord };
