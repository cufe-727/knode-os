/**
 * How alike two statements are worded, for the near-duplicate checks
 * (graph/claim-dedupe.ts without real vectors, wiki/refine.ts): the share of
 * the shorter statement's words the other one has too.
 *
 * A statement's words are its Latin and number tokens of two or more
 * characters, and the bigrams of each CJK run (the character classes
 * `match_grams` takes, src/store/grams.ts). A CJK run has no spaces, so taken
 * whole it is a clause: two Chinese statements shared a word only where they
 * repeated a clause verbatim, and a restatement in other words never came up.
 *
 * Bigrams are many more and more often shared than words, so a pair with CJK
 * text needs a higher overlap. Measured on finance (2026-11-04): of the pairs
 * 3,000 sampled claims made with their subject's claims, 58% of those at 0.8
 * had an embedding cosine of 0.85 or more, against 45% of those whole-clause
 * words brought up at 0.6, and 33% for bigrams at 0.6. Of the 16,639 pairs the
 * Judge had called the same or contained, 85% reach 0.8 (31% before); of the
 * judged pairs that reach it, 89% were such (94% before).
 */

const CJK_RUN = /[一-鿿㐀-䶿]+/g;

/** The overlap a pair of Latin-only statements needs. */
export const WORDING_OVERLAP = 0.6;
/** The overlap a pair needs once either statement has CJK text. */
export const CJK_WORDING_OVERLAP = 0.8;

export interface Wording {
  words: Set<string>;
  /** Some of the words are CJK bigrams. */
  cjk: boolean;
}

export function wordingOf(statement: string): Wording {
  const words = new Set<string>();
  const rest = statement.normalize('NFKC').toLowerCase().replace(CJK_RUN, (run) => {
    for (let i = 0; i + 2 <= run.length; i++) words.add(run.slice(i, i + 2));
    return ' ';
  });
  const cjk = words.size > 0;
  for (const t of rest.split(/[^\p{L}\p{N}]+/u)) if (t.length >= 2) words.add(t);
  return { words, cjk };
}

function wordingOverlap(a: Wording, b: Wording): number {
  const [small, large] = a.words.size <= b.words.size ? [a.words, b.words] : [b.words, a.words];
  let shared = 0;
  for (const w of small) if (large.has(w)) shared++;
  return shared / Math.max(1, small.size);
}

/** The overlap at which a pair counts as worded alike. */
function wordingThreshold(a: Wording, b: Wording): number {
  return a.cjk || b.cjk ? CJK_WORDING_OVERLAP : WORDING_OVERLAP;
}

/** The overlap of a pair worded alike, or null. */
export function alikeWording(a: Wording, b: Wording): number | null {
  const o = wordingOverlap(a, b);
  return o >= wordingThreshold(a, b) ? o : null;
}

/**
 * How many of `w`'s words lead its prefix: any statement worded alike with a
 * statement at least as long as `w` shares one of them, when both order their
 * words the same way (prefix filtering). A pair shares at least the threshold
 * times the shorter one's words, and the threshold is at least `w`'s own.
 */
export function wordingPrefixLength(w: Wording): number {
  const n = w.words.size;
  const t = w.cjk ? CJK_WORDING_OVERLAP : WORDING_OVERLAP;
  return n === 0 ? 0 : n - Math.max(1, Math.ceil(t * n - 1e-9)) + 1;
}
