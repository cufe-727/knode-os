import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../store/db.js';
import { AbsenceRecord, recordAbsencesFromFeedback } from './absence.js';
import { Plan } from './plan.js';

/**
 * Receipts: what was asked, what was handed out, what the agent did with it.
 *
 * A receipt is written when a plan is issued and completed when the agent
 * reports back. That is the whole learning loop's substrate — without the
 * second half there is no way to tell a capability that answers from one that
 * merely responds. They are appended to `ledger/receipts.jsonl` as well, so a
 * `rebuild` recovers the history the ranker was trained on.
 */

export interface ReceiptCall {
  nodeId: string;
  slot?: string;
  capability?: string;
  ok: boolean;
  elapsedMs?: number;
  rows?: number;
  tokens?: number;
  error?: string;
}

export interface ReceiptSummary {
  docCount: number;
  claimCount: number;
  staleCount: number;
  conflictCount: number;
  slotsFilled?: number;
  slotsUnfilled?: number;
}

export interface NewReceipt {
  kind: 'resolve' | 'pack';
  query: string;
  actor?: string;
  intent?: string | null;
  recipePath?: string | null;
  entities: string[];
  playbooks?: string[];
  datasets?: string[];
  probes?: unknown[];
  gaps: string[];
  plan?: Plan | null;
  budget?: unknown;
  summary: ReceiptSummary;
  asOf?: string | null;
  validAt?: string | null;
}

export function newReceiptId(): string {
  return `r_${crypto.randomBytes(9).toString('hex')}`;
}

const RECEIPT_LOG = 'ledger/receipts.jsonl';

function appendReceiptLog(dataDir: string, entry: Record<string, unknown>): void {
  try {
    const file = path.join(dataDir, RECEIPT_LOG);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // the ledger is a convenience for rebuild; never fail a resolve over it
  }
}

export async function recordReceipt(store: Store, r: NewReceipt): Promise<string> {
  const id = newReceiptId();
  await store.query(
    `INSERT INTO receipts (id, kind, query, actor, intent, recipe_path, program_sha, entities, playbooks, datasets,
                           probes, gaps, plan, budget, summary, as_of, valid_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb,
             $14::jsonb, $15::jsonb, $16::timestamptz, $17::timestamptz)`,
    [
      id, r.kind, r.query, r.actor ?? 'agent', r.intent ?? null, r.recipePath ?? null,
      r.plan ? JSON.stringify(r.plan.nodes.map((n) => n.id)) : null,
      JSON.stringify(r.entities), JSON.stringify(r.playbooks ?? []), JSON.stringify(r.datasets ?? []),
      JSON.stringify(r.probes ?? []), JSON.stringify(r.gaps), r.plan ? JSON.stringify(r.plan) : null,
      JSON.stringify(r.budget ?? {}), JSON.stringify(r.summary), r.asOf ?? null, r.validAt ?? null,
    ],
  );
  appendReceiptLog(store.dataDir, { ev: 'resolve', id, ts: new Date().toISOString(), kind: r.kind, query: r.query, intent: r.intent ?? null });
  return id;
}

export interface FeedbackInput {
  receiptId: string;
  executed?: ReceiptCall[];
  usedIds?: string[];
  ignoredIds?: string[];
  outcome?: string;
  /** A plan the agent rewrote to make it work — the seed of a future recipe. */
  revisedPlan?: unknown;
}

export interface FeedbackResult {
  receiptId: string;
  recorded: boolean;
  /** True when the agent sent back a plan different from the one it was given. */
  revised: boolean;
  /** Empty results recorded as negative knowledge, so they are not re-asked. */
  absences: AbsenceRecord[];
}

/**
 * Close a receipt with what actually happened. `revisedPlan` is stored rather
 * than acted on: promoting one into a reusable recipe means replaying it
 * against history and getting it approved, which is the Phase 5 distillation
 * step, not something a single feedback call should trigger.
 */
export async function recordFeedback(store: Store, input: FeedbackInput): Promise<FeedbackResult> {
  const [existing] = await store.query<{ id: string; plan: Plan | null }>(`SELECT id, plan FROM receipts WHERE id = $1`, [input.receiptId]);
  if (!existing) throw new Error(`unknown receipt ${input.receiptId}`);

  // a node that succeeded and returned zero rows is negative knowledge: record
  // it against the binding the plan actually asked about, so the next resolve
  // does not spend the call again before the absence expires
  const bindings = new Map<string, { entityId: string; param: string; value: string }>();
  for (const node of existing.plan?.nodes ?? []) {
    if (node.binding) bindings.set(node.id, node.binding);
  }
  const absences = await recordAbsencesFromFeedback(store, input.executed ?? [], bindings, { actor: 'agent' });

  await store.query(
    `UPDATE receipts SET calls = $2::jsonb, used_ids = $3::jsonb, ignored_ids = $4::jsonb,
            outcome = $5, feedback_at = now(),
            plan = CASE WHEN $6::jsonb IS NULL THEN plan ELSE jsonb_set(COALESCE(plan, '{}'::jsonb), '{revised}', $6::jsonb) END
     WHERE id = $1`,
    [
      input.receiptId,
      JSON.stringify(input.executed ?? []),
      JSON.stringify(input.usedIds ?? []),
      JSON.stringify(input.ignoredIds ?? []),
      input.outcome ?? null,
      input.revisedPlan ? JSON.stringify(input.revisedPlan) : null,
    ],
  );
  appendReceiptLog(store.dataDir, {
    ev: 'feedback',
    id: input.receiptId,
    ts: new Date().toISOString(),
    outcome: input.outcome ?? null,
    calls: (input.executed ?? []).length,
    used: (input.usedIds ?? []).length,
  });
  return { receiptId: input.receiptId, recorded: true, revised: Boolean(input.revisedPlan), absences };
}

export interface ReceiptRow {
  id: string;
  kind: string;
  query: string;
  intent: string | null;
  outcome: string | null;
  gaps: unknown;
  calls: unknown;
  used_ids: unknown;
  summary: unknown;
  created_at: string;
  feedback_at: string | null;
}

export async function listReceipts(store: Store, opts: { limit?: number; intent?: string } = {}): Promise<ReceiptRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  if (opts.intent) {
    return store.query<ReceiptRow>(
      `SELECT id, kind, query, intent, outcome, gaps, calls, used_ids, summary, created_at, feedback_at
       FROM receipts WHERE intent = $1 ORDER BY created_at DESC LIMIT $2`,
      [opts.intent, limit],
    );
  }
  return store.query<ReceiptRow>(
    `SELECT id, kind, query, intent, outcome, gaps, calls, used_ids, summary, created_at, feedback_at
     FROM receipts ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
}
