import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../store/db.js';

/**
 * Context-pack evaluation.
 *
 * Retrieval benchmarks ask "did the right document come back". That is the
 * wrong question for a context pack, which is judged by what the agent *kept*:
 * a pack that returns twenty documents to get the two that mattered has burned
 * eighteen documents' worth of context on nothing, and no recall metric will
 * say so. So the headline number here is precision — used over returned —
 * measured from receipts rather than from a fixture set, because the only
 * honest judge of whether context was useful is the caller that had it.
 *
 * Everything is computed from receipts that carry feedback. Unreported
 * resolves are counted separately rather than assumed successful: an agent
 * that never reports back is a measurement gap, not a perfect score.
 */

export interface EvalRow {
  intent: string;
  resolves: number;
  reported: number;
  /** Calls whose result the caller kept, over calls made. */
  precision: number;
  /** Required slots filled (locally or by a plan node), over required slots. */
  slotCoverage: number;
  /** Resolves that reported at least one unfillable required slot. */
  withUnknowns: number;
  avgPlanNodes: number;
  avgDocs: number;
  failures: number;
}

export interface EvalReport {
  generatedAt: string;
  lookbackDays: number;
  totals: {
    resolves: number;
    reported: number;
    precision: number;
    /** Reported resolves over all resolves — how much of this report is evidence. */
    reportingRate: number;
  };
  byIntent: EvalRow[];
  /** Capabilities whose results are consistently ignored: candidates for removal. */
  ignoredCapabilities: { capability: string; slot: string; attempts: number; used: number }[];
  path?: string;
}

interface Row {
  intent: string | null;
  plan: { nodes?: unknown[]; slots?: { required?: string[]; filledLocally?: string[] } } | null;
  calls: { nodeId?: string; slot?: string; capability?: string; ok?: boolean }[] | null;
  used_ids: string[] | null;
  gaps: string[] | null;
  summary: { docCount?: number; slotsUnfilled?: number } | null;
  outcome: string | null;
  feedback_at: string | null;
}

export async function evaluatePacks(store: Store, opts: { lookbackDays?: number } = {}): Promise<EvalReport> {
  const lookbackDays = opts.lookbackDays ?? 30;
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
  const rows = await store.query<Row>(
    `SELECT intent, plan, calls, used_ids, gaps, summary, outcome, feedback_at
     FROM receipts WHERE kind = 'resolve' AND created_at >= $1`,
    [since],
  );

  const byIntent = new Map<string, EvalRow & { keptCalls: number; totalCalls: number; requiredSlots: number; filledSlots: number; docs: number; planNodes: number }>();
  const ignored = new Map<string, { capability: string; slot: string; attempts: number; used: number }>();

  for (const row of rows) {
    const intent = row.intent ?? 'default';
    const agg = byIntent.get(intent) ?? {
      intent, resolves: 0, reported: 0, precision: 0, slotCoverage: 0, withUnknowns: 0,
      avgPlanNodes: 0, avgDocs: 0, failures: 0,
      keptCalls: 0, totalCalls: 0, requiredSlots: 0, filledSlots: 0, docs: 0, planNodes: 0,
    };
    agg.resolves++;
    agg.docs += row.summary?.docCount ?? 0;
    agg.planNodes += Array.isArray(row.plan?.nodes) ? row.plan!.nodes!.length : 0;
    if ((row.gaps ?? []).length > 0) agg.withUnknowns++;

    const required = row.plan?.slots?.required ?? [];
    const filledLocally = new Set(row.plan?.slots?.filledLocally ?? []);
    const plannedSlots = new Set((row.calls ?? []).map((c) => c.slot).filter(Boolean) as string[]);
    agg.requiredSlots += required.length;
    agg.filledSlots += required.filter((s) => filledLocally.has(s) || plannedSlots.has(s)).length;

    if (row.feedback_at) {
      agg.reported++;
      if (row.outcome === 'failed') agg.failures++;
      const used = new Set(row.used_ids ?? []);
      for (const call of row.calls ?? []) {
        agg.totalCalls++;
        const kept = call.ok !== false && used.has(call.nodeId ?? '');
        if (kept) agg.keptCalls++;
        if (call.capability && call.slot) {
          const key = `${call.slot}|${call.capability}`;
          const cur = ignored.get(key) ?? { capability: call.capability, slot: call.slot, attempts: 0, used: 0 };
          cur.attempts++;
          if (kept) cur.used++;
          ignored.set(key, cur);
        }
      }
    }
    byIntent.set(intent, agg);
  }

  const finalized: EvalRow[] = [...byIntent.values()].map((a) => ({
    intent: a.intent,
    resolves: a.resolves,
    reported: a.reported,
    precision: a.totalCalls === 0 ? 0 : a.keptCalls / a.totalCalls,
    slotCoverage: a.requiredSlots === 0 ? 1 : a.filledSlots / a.requiredSlots,
    withUnknowns: a.withUnknowns,
    avgPlanNodes: a.resolves === 0 ? 0 : a.planNodes / a.resolves,
    avgDocs: a.resolves === 0 ? 0 : a.docs / a.resolves,
    failures: a.failures,
  })).sort((x, y) => y.resolves - x.resolves);

  const totalCalls = [...byIntent.values()].reduce((n, a) => n + a.totalCalls, 0);
  const keptCalls = [...byIntent.values()].reduce((n, a) => n + a.keptCalls, 0);
  const resolves = rows.length;
  const reported = rows.filter((r) => r.feedback_at).length;

  return {
    generatedAt: new Date().toISOString(),
    lookbackDays,
    totals: {
      resolves,
      reported,
      precision: totalCalls === 0 ? 0 : keptCalls / totalCalls,
      reportingRate: resolves === 0 ? 0 : reported / resolves,
    },
    byIntent: finalized,
    // three chances is enough to distinguish "unlucky" from "nobody wants this"
    ignoredCapabilities: [...ignored.values()]
      .filter((c) => c.attempts >= 3 && c.used === 0)
      .sort((a, b) => b.attempts - a.attempts),
  };
}

/** Write the evaluation as a wiki page, next to the ranking it explains. */
export function writeEvalReport(dataDir: string, report: EvalReport): string {
  const rel = 'wiki/learning/pack-evaluation.md';
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  const body = [
    '---',
    'title: Context pack evaluation',
    'generated: true',
    '---',
    '',
    '# Context pack evaluation',
    '',
    'Precision is `used / returned`: of the calls a plan made, how many produced',
    'something the caller kept. A pack that returns twenty documents to deliver two',
    'has spent eighteen documents of context on nothing, and recall would not say so.',
    '',
    `_Last ${report.lookbackDays} days, regenerated ${report.generatedAt}._`,
    '',
    `- resolves: **${report.totals.resolves}**, of which **${report.totals.reported}** reported back (${pct(report.totals.reportingRate)})`,
    `- precision across reported calls: **${pct(report.totals.precision)}**`,
    '',
    report.totals.reportingRate < 0.5
      ? '> Fewer than half of resolves reported back, so these numbers describe a minority of runs. Call `knode_feedback` after executing a plan.\n'
      : '',
    '| intent | resolves | reported | precision | required slots covered | with unknowns | avg plan nodes |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.byIntent.map((r) =>
      `| ${r.intent} | ${r.resolves} | ${r.reported} | ${pct(r.precision)} | ${pct(r.slotCoverage)} | ${r.withUnknowns} | ${r.avgPlanNodes.toFixed(1)} |`),
    '',
    ...(report.ignoredCapabilities.length
      ? [
        '## Capabilities nobody keeps',
        '',
        'Called repeatedly, never used. Either the slot hint points at the wrong',
        'source, or the source has nothing to say about these entities.',
        '',
        ...report.ignoredCapabilities.map((c) => `- \`${c.capability}\` for **${c.slot}** — ${c.attempts} calls, 0 kept`),
        '',
      ]
      : []),
  ].join('\n');

  const abs = path.join(dataDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return rel;
}
