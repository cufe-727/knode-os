import crypto from 'node:crypto';
import { Budget } from './intents.js';

/**
 * The Plan DSL: what the knowledge base could not answer by itself, written
 * down as work the *agent* performs.
 *
 * The split is deliberate. Rendering happens here; execution happens on the
 * agent side, because a knowledge base that runs arbitrary tool calls is a
 * sandbox problem nobody asked for. Budgets are therefore two different
 * things: a hard constraint on knode's own tools (read-only SQL, row caps,
 * ACL) and an *annotation* on the plan, which the agent is free to overrun —
 * and which the receipt will record it having overrun.
 */

export type ToolKind = 'mcp' | 'cli' | 'http';

export interface PlanTool {
  kind: ToolKind;
  /** MCP server name, CLI binary, or HTTP base — depending on `kind`. */
  server?: string;
  name: string;
}

export interface PlanNode {
  id: string;
  /** Slot this node fills. */
  fills: string;
  tool: PlanTool;
  args: Record<string, unknown>;
  /** Capability this node calls, when it calls one. */
  capability?: string;
  /** Nodes that must complete first — this is what makes parallel vs serial explicit. */
  after?: string[];
  /** Max acceptable age of the answer, in seconds. */
  freshness?: number | null;
  /**
   * The entity binding this node was built from. Kept on the node so a later
   * "it returned nothing" can be recorded against the exact question asked,
   * rather than reverse-engineered out of the rendered statement.
   */
  binding?: { entityId: string; param: string; value: string };
  /** Node to run instead when this one fails. */
  onError?: { fallback: string };
  /** Why the planner chose this node — expected gain, cost, latency, and the
   * ranker's posterior. `exploring` marks a call made to *learn* whether this
   * capability works, not because it is currently the best bet. */
  why?: {
    expectedGain: number;
    estCost: number;
    estLatencyMs: number;
    reason: string;
    posterior?: number;
    exploring?: boolean;
  };
}

export interface Plan {
  /** Same id as the receipt, so execution can be tied back to what was handed out. */
  planId: string;
  intent: string;
  budget: Budget;
  slots: { required: string[]; optional: string[]; filledLocally: string[] };
  nodes: PlanNode[];
  render: 'json-graph' | 'ts-program';
}

export function planSha(plan: Plan): string {
  const canonical = JSON.stringify({ intent: plan.intent, nodes: plan.nodes.map((n) => ({ ...n, why: undefined })) });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Execution order as phases: everything in a phase can run in parallel, phases
 * run in sequence. This is the same shape a workflow runner wants, computed
 * once here so every consumer agrees on it.
 */
export function phasesOf(plan: Plan): string[][] {
  const byId = new Map(plan.nodes.map((n) => [n.id, n]));
  const done = new Set<string>();
  const phases: string[][] = [];
  let remaining = plan.nodes.map((n) => n.id);

  while (remaining.length > 0) {
    const ready = remaining.filter((id) => (byId.get(id)?.after ?? []).every((dep) => done.has(dep) || !byId.has(dep)));
    if (ready.length === 0) {
      // a cycle, or a dependency on a node that is not in the plan: run the
      // rest in one phase rather than looping forever
      phases.push([...remaining]);
      break;
    }
    phases.push(ready);
    ready.forEach((id) => done.add(id));
    remaining = remaining.filter((id) => !done.has(id));
  }
  return phases;
}

/** The plan as data: an agent walks the nodes and calls the named tools. */
export function renderJsonGraph(plan: Plan): { plan: Plan; phases: string[][] } {
  return { plan, phases: phasesOf(plan) };
}

function literal(v: unknown): string {
  return JSON.stringify(v ?? null);
}

/**
 * The plan as a program, for agents that would rather run code than walk a
 * graph. Phases become `await Promise.all([...])` blocks, so the parallelism
 * the `after` edges describe survives the translation.
 */
export function renderTsProgram(plan: Plan): string {
  const byId = new Map(plan.nodes.map((n) => [n.id, n]));
  const lines: string[] = [
    `// knode-os plan ${plan.planId} — intent: ${plan.intent}`,
    `// Budget (advisory): ${plan.budget.maxToolCalls} calls, ${plan.budget.maxLatencyMs}ms, ${plan.budget.maxTokens} tokens.`,
    '// Every knode tool enforces its own read-only / row-cap limits regardless.',
    '',
    'import { tools } from "knode-os/sdk";',
    '',
    'export async function run() {',
    '  const filled: Record<string, unknown> = {};',
  ];

  for (const phase of phasesOf(plan)) {
    const nodes = phase.map((id) => byId.get(id)!).filter(Boolean);
    if (nodes.length === 0) continue;
    lines.push('');
    for (const n of nodes) {
      if (n.why) lines.push(`  // ${n.id}: ${n.why.reason} (gain ${n.why.expectedGain.toFixed(2)}, cost ${n.why.estCost})`);
    }
    if (nodes.length === 1) {
      lines.push(`  ${assignment(nodes[0])}`);
    } else {
      lines.push('  await Promise.all([');
      for (const n of nodes) lines.push(`    (async () => { ${assignment(n)} })(),`);
      lines.push('  ]);');
    }
  }

  lines.push('', '  return filled;', '}', '');
  return lines.join('\n');
}

function assignment(n: PlanNode): string {
  const call = `tools.${n.tool.name}(${literal(n.args)})`;
  const guarded = n.onError
    ? `await ${call}.catch(() => tools.${n.tool.name}(${literal(n.args)}))`
    : `await ${call}`;
  return `filled[${literal(n.fills)}] = ${guarded};`;
}

/** What an agent may still run after the pack, ranked by expected gain. */
export interface NextQuery {
  nodeId: string;
  capability: string;
  args: Record<string, unknown>;
  estCost: number;
  estLatencyMs: number;
  expectedGain: number;
  reason: string;
}

export function nextQueriesOf(plan: Plan): NextQuery[] {
  return plan.nodes
    .filter((n) => n.why)
    .map((n) => ({
      nodeId: n.id,
      capability: n.capability ?? n.tool.name,
      args: n.args,
      estCost: n.why!.estCost,
      estLatencyMs: n.why!.estLatencyMs,
      expectedGain: n.why!.expectedGain,
      reason: n.why!.reason,
    }))
    .sort((a, b) => b.expectedGain - a.expectedGain);
}
