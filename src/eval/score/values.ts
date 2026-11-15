import { extractFinalAnswer } from '../metrics/text.js';
import type { Task } from '../types.js';
import { containsTerm, foldThousands } from './lists.js';

/**
 * Model-free reading of a short answer (docs/design/28 §4): does the
 * `Final answer:` line name the gold value, a stale value the corpus once
 * stated for the same thing, or neither — and did the answer decline? This is
 * how `value` tasks are scored, and how any task that names its stale values
 * (`meta.stale`) gets a stale-answer rate beside its correctness.
 */

/** Phrases that decline to answer, in the languages the packs use. */
const ABSTAIN = /(无法确定|无法判断|不能确定|没有(提到|记载|说明|信息|相关)|未(提及|提到|说明)|不清楚|不知道|资料中没有|材料中没有|not (stated|mentioned|specified|given|in the (sources|documents|materials))|cannot (determine|tell|find)|can't (determine|tell|find)|no (information|record|mention)|unknown|unable to (determine|find)|do not know|don't know)/i;

export function declines(text: string): boolean {
  return ABSTAIN.test(text);
}

/** A number as an answer writes it: thousands separators allowed, and a 万 / 亿 right after it. */
const NUMBER = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g;
const MAGNITUDE: Record<string, number> = { 万: 1e4, 亿: 1e8 };

/**
 * The numbers a text states, each as written ("134.7" of "134.7万") and, after
 * a 万 or 亿, at its full size (1,347,000).
 */
export function numbersIn(text: string): { value: number; scaled: number }[] {
  const t = text.normalize('NFKC');
  return [...t.matchAll(NUMBER)].map((m) => {
    const value = Number(m[0].replace(/,/g, ''));
    const unit = t.slice(m.index! + m[0].length).match(/^\s*([万亿])/)?.[1];
    return { value, scaled: unit ? value * MAGNITUDE[unit] : value };
  });
}

/** The magnitudes (万, 亿) a text works in: a reading in one of them may be given at full size, and the other way round. */
export function magnitudesIn(text: string): number[] {
  return Object.entries(MAGNITUDE).filter(([u]) => text.includes(u)).map(([, m]) => m);
}

/**
 * Is one of `values` named in `text`: as a whole term, or (numbers, with
 * `tolerance`) as a number within it.
 *
 * Rounded gold (docs/design/33 §5): a numeric gold is the figure in the unit
 * the corpus states it in, rounded as the question asks, and `tolerance`,
 * in that unit, is what the pack allows for the rounding of both sides (1.01
 * for a whole number, 0.0101 for two decimals). An answer may give the same
 * figure in another magnitude: "1,347,308人" for a gold of 135 when the
 * corpus counts in 万人. Such a reading is converted to the gold's unit and
 * held to the same tolerance, with no slack of its own, and only when (a) the
 * answer itself works in that magnitude (`magnitudes`, read from its whole
 * text: "单位为万人", a table in 万) and (b) the gold is large against its
 * tolerance (at least ten times it), so a converted number has to agree with
 * the gold in two or more significant figures and a stray large number in an
 * answer does not match a small gold by accident.
 */
export function namesValue(text: string, values: string[], tolerance?: number, magnitudes: number[] = []): boolean {
  if (values.some((v) => v && containsTerm(text, v))) return true;
  if (tolerance === undefined || !(tolerance > 0)) return false;
  const nums = numbersIn(text);
  return values.some((v) => {
    const plain = foldThousands(v).trim();
    if (!/^-?\d+(?:\.\d+)?$/.test(plain)) return false;
    const gold = Number(plain);
    const near = (x: number) => Math.abs(x - gold) <= tolerance;
    const convertible = Math.abs(gold) >= 10 * tolerance;
    return nums.some((n) => near(n.value) || near(n.scaled) || (convertible && magnitudes.some((m) => near(n.scaled / m))));
  });
}

export interface ValueReading {
  /** The gold value is named. */
  gold: boolean;
  /** A stale value is named and the gold is not: answered with what used to be true (or what a look-alike holds). */
  stale: boolean;
  /** The answer declines. */
  declined: boolean;
}

/** The gold values of a task as a short answer may give them: `meta.goldTerms`, else the answer and its variants. */
export function goldTerms(t: Task): string[] {
  const own = t.meta?.goldTerms;
  if (Array.isArray(own) && own.length) return own.map(String);
  return [t.answer ?? '', ...(t.answers ?? [])].filter(Boolean);
}

/** The values the corpus once stated for what the task asks, as an answer may write them. */
export function staleTerms(t: Task): string[] {
  const stale = [...(Array.isArray(t.meta?.stale) ? t.meta!.stale : []), ...(Array.isArray(t.meta?.staleText) ? t.meta!.staleText : [])];
  return [...new Set(stale.map(String).filter(Boolean))];
}

export function readValue(t: Task, answerText: string): ValueReading {
  const final = extractFinalAnswer(answerText);
  const tolerance = typeof t.meta?.tolerance === 'number' ? t.meta.tolerance : undefined;
  // the magnitudes the whole answer works in, not only its final line ("单位为万人" above a table)
  const gold = namesValue(final, goldTerms(t), tolerance, magnitudesIn(answerText));
  const stale = !gold && namesValue(final, staleTerms(t));
  return { gold, stale, declined: !gold && declines(final) };
}
