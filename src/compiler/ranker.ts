import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../store/db.js';

/**
 * The ranker: which capability actually answers a slot, learned from receipts.
 *
 * Two things have to be true at once. It must *exploit* — a source that has
 * answered this slot nine times running should keep getting the call — and it
 * must *explore*, because a capability that lost its first coin flip would
 * otherwise never be tried again, and the planner would happily converge on a
 * mediocre source forever.
 *
 * Thompson sampling gets both from one draw: score each candidate by sampling
 * its Beta posterior. A well-evidenced 90% capability almost always beats a
 * once-failed one, but the once-failed one has a wide posterior and so gets
 * picked occasionally — which is exactly the evidence it needs to prove itself
 * or be dropped for good.
 *
 * The counts stay visible (`wiki/learning/`) rather than living inside a model,
 * because "why did you query MySQL instead of the parquet lake" has to have an
 * answer a person can check.
 */

export interface CapabilityStat {
  intent: string | null;
  slot: string;
  capability: string;
  attempts: number;
  /** Calls that did not error. */
  ok: number;
  /** Calls whose result the caller actually kept — the signal that matters. */
  used: number;
  avgLatencyMs: number;
  lastSeen: string | null;
}

export interface RankerScore {
  /** Posterior mean: the honest estimate, used for reporting. */
  mean: number;
  /** One Thompson draw: the estimate used for *this* decision. */
  sample: number;
  attempts: number;
  used: number;
  /** True when the draw came out above the mean — this call is exploring. */
  exploring: boolean;
  explain: string;
}

/** Prior: a capability probably works, but we have not seen it work yet. */
const PRIOR_ALPHA = 1.2;
const PRIOR_BETA = 0.8;

export function statsKey(slot: string, capability: string): string {
  return `${slot}|${capability}`;
}

export async function loadCapabilityStats(store: Store, intent: string): Promise<Map<string, CapabilityStat>> {
  const rows = await store.query<{
    intent: string | null; slot: string; capability: string;
    attempts: number; ok: number; used: number; avg_latency_ms: number; last_seen: string | null;
  }>(
    `SELECT intent, slot, capability, attempts, ok, used, avg_latency_ms, last_seen
     FROM v_capability_stats WHERE intent = $1 OR intent IS NULL`,
    [intent],
  );
  const out = new Map<string, CapabilityStat>();
  for (const r of rows) {
    const key = statsKey(r.slot, r.capability);
    // an intent-specific row wins over a generic one for the same pair
    const existing = out.get(key);
    if (existing && existing.intent === intent) continue;
    out.set(key, {
      intent: r.intent,
      slot: r.slot,
      capability: r.capability,
      attempts: Number(r.attempts) || 0,
      ok: Number(r.ok) || 0,
      used: Number(r.used) || 0,
      avgLatencyMs: Number(r.avg_latency_ms) || 0,
      lastSeen: r.last_seen,
    });
  }
  return out;
}

/**
 * Sample from Beta(a, b) via two Gamma draws (Marsaglia–Tsang). Deterministic
 * when a seeded `rng` is supplied, which is what makes the planner testable —
 * an exploration strategy that cannot be reproduced cannot be debugged.
 */
export function sampleBeta(a: number, b: number, rng: () => number = Math.random): number {
  const x = sampleGamma(a, rng);
  const y = sampleGamma(b, rng);
  return x + y === 0 ? 0.5 : x / (x + y);
}

function sampleGamma(shape: number, rng: () => number): number {
  if (shape < 1) {
    // Johnk's boost for shape < 1, so a near-zero prior does not degenerate
    return sampleGamma(shape + 1, rng) * Math.pow(Math.max(rng(), 1e-12), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 200; i++) {
    let x: number;
    let v: number;
    do {
      x = gaussian(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.max(rng(), 1e-12);
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
  return d; // the loop practically always returns; fall back to the mean
}

function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/**
 * Score one (slot, capability) pair. `used` — not merely `ok` — is the success
 * signal: a source that returns rows nobody keeps is answering the wrong
 * question, and counting it as a win is how a planner learns to be confidently
 * useless.
 */
export function score(stat: CapabilityStat | undefined, rng: () => number = Math.random): RankerScore {
  const attempts = stat?.attempts ?? 0;
  const used = stat?.used ?? 0;
  const alpha = PRIOR_ALPHA + used;
  const beta = PRIOR_BETA + Math.max(0, attempts - used);
  const mean = alpha / (alpha + beta);
  const sample = sampleBeta(alpha, beta, rng);
  const exploring = sample > mean;
  const explain = attempts === 0
    ? 'never tried for this slot — exploring on the prior'
    : `${used}/${attempts} kept (${(mean * 100).toFixed(0)}% posterior)${exploring ? ', exploring above it' : ''}`;
  return { mean, sample, attempts, used, exploring, explain };
}

/* -------------------------------- reporting ------------------------------- */

export interface RankerReport {
  path: string;
  rows: (CapabilityStat & { mean: number })[];
}

/**
 * Write the ranking table to `wiki/learning/` as an ordinary wiki page, so the
 * thing steering the planner is reviewable — and correctable — by a person.
 * It is written outside a scope on purpose: it is a report about the system,
 * not knowledge the system derived, and it must not become evidence for
 * anything.
 */
export async function writeRankerReport(store: Store, opts: { intent?: string } = {}): Promise<RankerReport> {
  const rows = await store.query<{
    intent: string | null; slot: string; capability: string;
    attempts: number; ok: number; used: number; avg_latency_ms: number; last_seen: string | null;
  }>(
    opts.intent
      ? `SELECT * FROM v_capability_stats WHERE intent = $1 ORDER BY intent, slot, used DESC`
      : `SELECT * FROM v_capability_stats ORDER BY intent, slot, used DESC`,
    opts.intent ? [opts.intent] : [],
  );

  const enriched = rows.map((r) => {
    const stat: CapabilityStat = {
      intent: r.intent, slot: r.slot, capability: r.capability,
      attempts: Number(r.attempts) || 0, ok: Number(r.ok) || 0, used: Number(r.used) || 0,
      avgLatencyMs: Number(r.avg_latency_ms) || 0, lastSeen: r.last_seen,
    };
    const alpha = PRIOR_ALPHA + stat.used;
    const beta = PRIOR_BETA + Math.max(0, stat.attempts - stat.used);
    return { ...stat, mean: alpha / (alpha + beta) };
  });

  const rel = 'wiki/learning/capability-ranking.md';
  const body = [
    '---',
    'title: Capability ranking',
    'generated: true',
    '---',
    '',
    '# Capability ranking',
    '',
    'Which capability actually answers which slot, learned from receipts. `used`',
    'counts calls whose result the caller kept — a source that returns rows nobody',
    'uses is answering the wrong question. `posterior` is the Beta mean the planner',
    'samples around; a wide posterior is why a rarely-tried capability still gets',
    'picked occasionally.',
    '',
    `_${enriched.length} pairs, regenerated ${new Date().toISOString()}._`,
    '',
    '| intent | slot | capability | used / attempts | posterior | avg latency |',
    '| --- | --- | --- | --- | --- | --- |',
    ...enriched.map((r) =>
      `| ${r.intent ?? '(any)'} | ${r.slot} | \`${r.capability}\` | ${r.used}/${r.attempts} | ${(r.mean * 100).toFixed(0)}% | ${r.avgLatencyMs.toFixed(0)}ms |`),
    '',
  ].join('\n');

  const abs = path.join(store.dataDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return { path: rel, rows: enriched };
}
