/**
 * Text handling shared by the scorers: the `Final answer:` line every prompt
 * asks for, normalization for exact match, token F1 that treats CJK
 * characters as tokens (whitespace F1 is meaningless for Chinese), and the
 * markers a system leaves in its answers that would let a judge tell
 * systems apart.
 */

const CJK = /[㐀-䶿一-鿿぀-ヿ가-힯]/;

export function hasCjk(s: string): boolean {
  return CJK.test(s);
}

/** The text after the last `Final answer:` (or `最终答案：`) line, else the whole answer. */
export function extractFinalAnswer(text: string): string {
  const m = [...text.matchAll(/(?:^|\n)\s*(?:\*\*)?(?:final answer|最终答案)(?:\*\*)?\s*[:：]\s*([\s\S]*?)(?=\n\s*\n|$)/gi)];
  const last = m.at(-1)?.[1]?.trim();
  return last && last.length ? last : text.trim();
}

/**
 * Remove what identifies a system from an answer before a judge sees it:
 * knode's trailing citations/gaps JSON line, GraphRAG's `[Data: …]` refs,
 * citation brackets, and file paths.
 */
export function stripMarkers(text: string): string {
  return text
    .replace(/\n\s*\{"citations"[\s\S]*$/m, '')
    .replace(/\[Data:[^\]]*\]/g, '')
    .replace(/\[(?:\d+(?:\s*,\s*\d+)*)\]/g, '')
    .replace(/\b(?:raw\/docs|wiki|corpus)\/[^\s)\]，。]+/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

export function normalizeAnswer(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\b(a|an|the)\b/g, ' ')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokens for F1: words for Latin text, single characters for CJK runs. */
export function answerTokens(s: string): string[] {
  const out: string[] = [];
  for (const w of normalizeAnswer(s).split(' ')) {
    if (!w) continue;
    if (hasCjk(w)) {
      for (const part of w.split(/([㐀-䶿一-鿿぀-ヿ가-힯])/u)) if (part) out.push(part);
    } else out.push(w);
  }
  return out;
}

export function exactMatch(pred: string, golds: string[]): boolean {
  const p = normalizeAnswer(pred);
  return golds.some((g) => normalizeAnswer(g) === p);
}

export function tokenF1(pred: string, golds: string[]): number {
  const p = answerTokens(pred);
  let best = 0;
  for (const g of golds) {
    const t = answerTokens(g);
    if (!p.length || !t.length) continue;
    const counts = new Map<string, number>();
    for (const x of t) counts.set(x, (counts.get(x) ?? 0) + 1);
    let common = 0;
    for (const x of p) {
      const c = counts.get(x) ?? 0;
      if (c > 0) {
        common++;
        counts.set(x, c - 1);
      }
    }
    if (common === 0) continue;
    const precision = common / p.length;
    const recall = common / t.length;
    best = Math.max(best, (2 * precision * recall) / (precision + recall));
  }
  return best;
}

/** Character bigrams of CJK runs and lowercased words otherwise — the tokens BM25 and coverage retrieval use. */
export function searchTokens(s: string): string[] {
  const out: string[] = [];
  const lower = s.toLowerCase().normalize('NFKC');
  for (const run of lower.match(/[㐀-䶿一-鿿]+|[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) ?? []) {
    if (/[㐀-䶿一-鿿]/.test(run)) {
      if (run.length === 1) out.push(run);
      for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2));
    } else if (run.length >= 2 || /\d/.test(run)) out.push(run);
  }
  return out;
}

/** The JSON object inside a reply (fenced or not), or null. */
export function jsonIn(text: string): Record<string, unknown> | null {
  const stripped = text.replace(/```(?:json)?/gi, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}
