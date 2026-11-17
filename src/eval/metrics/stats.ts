/**
 * Small, dependency-free statistics for benchmark reports: intervals for
 * rates and means, paired comparisons against a baseline, and Holm's
 * correction when one comparison is made per system.
 */

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;
}

/** Wilson score interval for k successes in n trials (95% by default). */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [NaN, NaN];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** A seeded PRNG (mulberry32), so a report's intervals are the same on every render. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile bootstrap interval of the mean. */
export function bootstrapMean(xs: number[], opts: { iters?: number; seed?: number; alpha?: number } = {}): [number, number] {
  if (xs.length === 0) return [NaN, NaN];
  if (xs.length === 1) return [xs[0], xs[0]];
  const iters = opts.iters ?? 2000;
  const r = rng(opts.seed ?? 7);
  const means: number[] = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < xs.length; j++) s += xs[Math.floor(r() * xs.length)];
    means.push(s / xs.length);
  }
  means.sort((a, b) => a - b);
  const alpha = opts.alpha ?? 0.05;
  return [means[Math.floor((alpha / 2) * iters)], means[Math.min(iters - 1, Math.floor((1 - alpha / 2) * iters))]];
}

export interface PairedResult {
  /** Mean of a − b over paired items. */
  diff: number;
  ci: [number, number];
  /** Two-sided bootstrap p-value of "no difference". */
  p: number;
  n: number;
}

/** Paired bootstrap of a − b over the items both systems answered. */
export function pairedBootstrap(a: number[], b: number[], opts: { iters?: number; seed?: number } = {}): PairedResult {
  const n = Math.min(a.length, b.length);
  const d = Array.from({ length: n }, (_, i) => a[i] - b[i]);
  const diff = mean(d);
  if (n < 2) return { diff, ci: [diff, diff], p: 1, n };
  const iters = opts.iters ?? 2000;
  const r = rng(opts.seed ?? 11);
  const centred = d.map((x) => x - diff);
  let extreme = 0;
  const boots: number[] = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    let s0 = 0;
    for (let j = 0; j < n; j++) {
      const k = Math.floor(r() * n);
      s += d[k];
      s0 += centred[k];
    }
    boots.push(s / n);
    if (Math.abs(s0 / n) >= Math.abs(diff)) extreme++;
  }
  boots.sort((x, y) => x - y);
  return { diff, ci: [boots[Math.floor(0.025 * iters)], boots[Math.floor(0.975 * iters)]], p: (extreme + 1) / (iters + 1), n };
}

/** Holm–Bonferroni: which of the p-values stay significant at `alpha` when tested together. */
export function holm(ps: number[], alpha = 0.05): boolean[] {
  const order = ps.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
  const out = new Array<boolean>(ps.length).fill(false);
  for (let k = 0; k < order.length; k++) {
    if (order[k].p > alpha / (order.length - k)) break;
    out[order[k].i] = true;
  }
  return out;
}

export function round(x: number, digits = 3): number {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** Sample standard deviation (n − 1). */
export function sd(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/**
 * Minimum detectable effect of a paired comparison: the smallest mean
 * difference a two-sided test at `alpha` finds with probability `power`,
 * given the spread of the paired differences — (z₁₋α/₂ + z_power) · sd / √n.
 * A delta smaller than this is not evidence of no difference: the benchmark
 * could not have told.
 */
export function minimumDetectableEffect(diffs: number[], opts: { alpha?: number; power?: number } = {}): number {
  const n = diffs.length;
  if (n < 2) return NaN;
  const z = (p: number) => normalQuantile(p);
  const s = sd(diffs);
  // all differences equal: any nonzero effect is seen, but say so as the smallest step a task can move
  const spread = s > 0 ? s : 1 / n;
  return (z(1 - (opts.alpha ?? 0.05) / 2) + z(opts.power ?? 0.8)) * spread / Math.sqrt(n);
}

/** Inverse of the standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9). */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
