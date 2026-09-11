import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { assertReadOnlySql } from '../datasource/guard.js';
import { assertWritablePath } from '../fs/files.js';
import { Store } from '../store/db.js';
import { SuggestionRow } from '../types.js';
import { Plan, PlanNode } from './plan.js';
import { parseRecipe } from './recipes.js';

/**
 * Recipe distillation: turn plans that worked into plans that are reused.
 *
 * A plan is a one-off answer to one question. When the same shape of plan
 * keeps succeeding for the same intent, that shape is knowledge — and leaving
 * it implicit means re-deriving it, and re-paying for the exploration, every
 * time. Distillation lifts it into `packs/*.md`.
 *
 * Nothing is published automatically. A candidate has to survive three checks
 * before it is even *proposed*:
 *
 *   1. replay   — does it hold up against the receipts it was derived from?
 *   2. safety   — is every statement in it read-only, against a known source?
 *   3. approval — a human accepts the suggestion, same as any other
 *
 * That ordering matters. Auto-publishing a recipe means a mistake in one
 * lucky plan silently becomes the default for every future question of that
 * kind, and the receipts that would reveal it are now measuring the mistake.
 */

export interface PlanShape {
  intent: string;
  /** Sorted `slot:capability` pairs — the shape, independent of bound values. */
  signature: string;
  nodes: PlanNode[];
  receiptIds: string[];
  /** Receipts with this shape that the caller reported as successful. */
  successes: number;
  attempts: number;
}

export interface ReplayResult {
  shape: PlanShape;
  /** Fraction of historical receipts with this shape whose nodes were all kept. */
  precision: number;
  /** Slots this shape filled that the alternatives did not. */
  coverage: number;
  ok: boolean;
  reason: string;
}

export interface DistillResult {
  shapes: number;
  candidates: ReplayResult[];
  suggestions: SuggestionRow[];
}

interface ReceiptRow {
  id: string;
  intent: string | null;
  plan: Plan | null;
  calls: { nodeId?: string; slot?: string; capability?: string; ok?: boolean }[] | null;
  used_ids: string[] | null;
  outcome: string | null;
}

/** The shape of a plan: which capability filled which slot, values stripped. */
export function signatureOf(nodes: PlanNode[]): string {
  return nodes
    .map((n) => `${n.fills}:${n.capability ?? n.tool.name}`)
    .sort()
    .join('|');
}

/**
 * Group recent successful receipts by plan shape. A revised plan the agent
 * sent back counts as its own shape — that is the most valuable signal there
 * is, because somebody had to fix our plan to get an answer.
 */
export async function clusterShapes(store: Store, opts: { lookbackDays?: number; intent?: string } = {}): Promise<PlanShape[]> {
  const since = new Date(Date.now() - (opts.lookbackDays ?? 30) * 86_400_000).toISOString();
  const rows = await store.query<ReceiptRow>(
    `SELECT id, intent, plan, calls, used_ids, outcome
     FROM receipts
     WHERE kind = 'resolve' AND feedback_at IS NOT NULL AND created_at >= $1
       AND ($2::text IS NULL OR intent = $2)
     ORDER BY created_at DESC LIMIT 500`,
    [since, opts.intent ?? null],
  );

  const shapes = new Map<string, PlanShape>();
  for (const row of rows) {
    const revised = (row.plan as unknown as { revised?: Plan })?.revised;
    const plan = revised ?? row.plan;
    const nodes = plan?.nodes ?? [];
    if (nodes.length === 0) continue;
    const intent = row.intent ?? 'default';
    const signature = signatureOf(nodes);
    const key = `${intent}::${signature}`;

    const shape = shapes.get(key) ?? { intent, signature, nodes, receiptIds: [], successes: 0, attempts: 0 };
    shape.receiptIds.push(row.id);
    shape.attempts++;
    // `used_ids: []` means the caller kept nothing. Reading it as "kept
    // everything" is how a plan that reliably returns ignored rows gets
    // promoted into a recipe and then chosen ahead of exploration.
    const used = new Set(row.used_ids ?? []);
    const calls = row.calls ?? [];
    const worked = calls.length > 0
      && calls.every((c) => c.ok !== false)
      && calls.some((c) => used.has(c.nodeId ?? ''));
    if (worked && row.outcome !== 'failed') shape.successes++;
    shapes.set(key, shape);
  }
  return [...shapes.values()].sort((a, b) => b.successes - a.successes);
}

/**
 * Replay a candidate against the receipts it came from, offline — no source is
 * contacted. The question is not "would this run" but "when this shape ran
 * before, did the caller keep what it produced": a shape that reliably returns
 * rows nobody uses is worse than no recipe at all, because it would then be
 * chosen ahead of exploration.
 */
export async function replay(store: Store, shape: PlanShape, opts: { minAttempts?: number; minPrecision?: number } = {}): Promise<ReplayResult> {
  const minAttempts = opts.minAttempts ?? 3;
  const minPrecision = opts.minPrecision ?? 0.6;

  const rows = await store.query<ReceiptRow>(
    `SELECT id, intent, plan, calls, used_ids, outcome FROM receipts WHERE id = ANY($1::text[])`,
    [shape.receiptIds],
  );
  let kept = 0;
  let total = 0;
  const slots = new Set<string>();
  for (const row of rows) {
    const used = new Set(row.used_ids ?? []);
    for (const call of row.calls ?? []) {
      total++;
      if (call.slot) slots.add(call.slot);
      if (call.ok !== false && used.has(call.nodeId ?? '')) kept++;
    }
  }
  const precision = total === 0 ? 0 : kept / total;
  const coverage = slots.size;

  if (shape.attempts < minAttempts) {
    return { shape, precision, coverage, ok: false, reason: `only ${shape.attempts} runs — need ${minAttempts} before this is a pattern rather than a coincidence` };
  }
  if (precision < minPrecision) {
    return { shape, precision, coverage, ok: false, reason: `${(precision * 100).toFixed(0)}% of its calls were kept — below the ${(minPrecision * 100).toFixed(0)}% bar` };
  }
  const unsafe = safetyProblem(shape.nodes);
  if (unsafe) return { shape, precision, coverage, ok: false, reason: unsafe };
  return { shape, precision, coverage, ok: true, reason: `${shape.successes}/${shape.attempts} successful runs, ${(precision * 100).toFixed(0)}% of calls kept` };
}

/**
 * Every statement a candidate would run has to be read-only. A recipe is
 * published configuration: once accepted it runs unattended, so "the agent
 * only ever sent SELECTs before" is not an argument.
 */
export function safetyProblem(nodes: PlanNode[]): string | null {
  for (const n of nodes) {
    const args = n.args ?? {};
    const statement = typeof args.sql === 'string' ? args.sql : null;
    if (!statement) continue;
    // only SQL sources get keyword-checked; the other dialects cannot write
    const dialectIsSql = !n.capability || !/^(prometheus|object|http)/.test(String(args.source ?? ''));
    if (!dialectIsSql) continue;
    try {
      assertReadOnlySql(statement);
    } catch (err) {
      return `node ${n.id} would run a non-read-only statement: ${err instanceof Error ? err.message : err}`;
    }
  }
  return null;
}

/** Render a distilled shape as a recipe file, with the values stripped back to placeholders. */
export function renderRecipe(shape: PlanShape, result: ReplayResult): string {
  // YAML cannot serialize `undefined`, and a recipe file with holes in it is
  // not a file anyone can edit — drop absent fields rather than emitting them
  const nodes = shape.nodes.map((n) => ({
    id: n.id.replace(/_[0-9a-f]{8}$/, '').replace(/_[A-Za-z0-9]+$/, ''),
    fills: n.fills,
    ...(n.capability ? { capability: n.capability } : {}),
    tool: { kind: n.tool.kind, ...(n.tool.server ? { server: n.tool.server } : {}), name: n.tool.name },
    args: generalize(n.args),
    ...(n.after?.length ? { after: n.after.map((a) => a.replace(/_[0-9a-f]{8}$/, '')) } : {}),
  }));

  const frontmatter = {
    type: 'recipe',
    appliesTo: 'default',
    intent: shape.intent,
    slots: { required: [...new Set(shape.nodes.map((n) => n.fills))], optional: [] },
    nodes,
    distilled: {
      from: shape.receiptIds.slice(0, 10),
      runs: shape.attempts,
      successes: shape.successes,
      precision: Number(result.precision.toFixed(3)),
    },
  };

  const body = `# ${shape.intent} — distilled recipe

Derived from ${shape.attempts} runs of this plan shape (${result.reason}).

Edit freely: this is a starting point taken from what worked, not a rule. The
placeholders \`{name}\` / \`{symbol}\` / \`{locator}\` are bound per entity when the
recipe runs.
`;
  return matter.stringify(body, frontmatter);
}

/** Replace bound entity values with the placeholders a recipe binds per entity. */
function generalize(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (typeof v !== 'string') {
      out[k] = v;
      continue;
    }
    // a quoted literal in a bound statement is the entity value: give it back
    // its placeholder so the recipe is about the shape, not about one company
    out[k] = k === 'sql'
      ? v.replace(/= *'[^']*'/g, "= {locator}").replace(/\{[a-z_]+\}='[^']*'/g, '{param}={locator}')
      : v;
  }
  return out;
}

/**
 * Propose recipes for the shapes that survived replay. They land in the same
 * suggestions queue as everything else, so accepting one is the same gesture
 * as accepting a playbook revision — and rejecting one leaves a record.
 */
export async function distillRecipes(
  store: Store,
  opts: { lookbackDays?: number; intent?: string; minAttempts?: number; minPrecision?: number; onProgress?: (m: string) => void } = {},
): Promise<DistillResult> {
  const progress = opts.onProgress ?? (() => {});
  const shapes = await clusterShapes(store, opts);
  const candidates: ReplayResult[] = [];
  const suggestions: SuggestionRow[] = [];

  for (const shape of shapes) {
    const result = await replay(store, shape, opts);
    candidates.push(result);
    if (!result.ok) {
      progress(`skip ${shape.intent} [${shape.signature}]: ${result.reason}`);
      continue;
    }

    const content = renderRecipe(shape, result);
    const relPath = `packs/${shape.intent.replace(/[^A-Za-z0-9_-]/g, '-')}-distilled.md`;
    if (!parseRecipe(content, relPath)) {
      progress(`distilled recipe for ${shape.intent} does not parse — skipped`);
      continue;
    }
    if (fs.existsSync(path.join(store.dataDir, relPath))) {
      const current = fs.readFileSync(path.join(store.dataDir, relPath), 'utf8');
      if (current.trim() === content.trim()) continue;
    }

    const id = crypto.createHash('sha256').update(`recipe|${shape.intent}|${shape.signature}`).digest('hex').slice(0, 16);
    await store.query(
      `INSERT INTO suggestions (id, kind, title, body, evidence, status, payload)
       VALUES ($1, 'recipe', $2, $3, $4::jsonb, 'pending', $5::jsonb)
       ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, evidence = EXCLUDED.evidence,
                                      payload = EXCLUDED.payload, status = 'pending'`,
      [
        id,
        `Publish a distilled recipe for ${shape.intent}`,
        `${result.reason}. Shape: ${shape.signature}. Accepting writes ${relPath}, which future resolves for this intent will follow instead of re-planning from scratch.`,
        JSON.stringify(shape.receiptIds.slice(0, 5)),
        JSON.stringify({ path: relPath, content, signature: shape.signature, intent: shape.intent }),
      ],
    );
    suggestions.push({
      id, kind: 'recipe', status: 'pending', created_at: new Date().toISOString(), report_path: null,
      title: `Publish a distilled recipe for ${shape.intent}`,
      body: result.reason,
      evidence: shape.receiptIds.slice(0, 5),
      payload: { path: relPath, content },
    });
    progress(`candidate recipe ${relPath}: ${result.reason}`);
  }

  return { shapes: shapes.length, candidates, suggestions };
}

/**
 * A recipe file that disappears takes its suggestions with it: a proposal to
 * revise something that no longer exists is noise, not a decision waiting to
 * be made. Mirrors how a disposed source stales the suggestions built on it.
 */
export async function staleOrphanedRecipeSuggestions(store: Store): Promise<number> {
  const rows = await store.query<{ id: string; payload: { path?: string } | null }>(
    `SELECT id, payload FROM suggestions WHERE kind = 'recipe' AND status = 'pending'`,
  );
  let staled = 0;
  for (const row of rows) {
    const rel = row.payload?.path;
    if (!rel) continue;
    try {
      assertWritablePath(rel);
    } catch {
      continue;
    }
    // the suggestion proposes *creating* the file, so it is orphaned only when
    // the intent it was distilled for has itself gone away
    const [receipt] = await store.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM receipts WHERE intent = $1`,
      [(row.payload as { intent?: string })?.intent ?? ''],
    );
    if (receipt && receipt.n === 0) {
      await store.query(`UPDATE suggestions SET status = 'stale' WHERE id = $1`, [row.id]);
      staled++;
    }
  }
  return staled;
}
