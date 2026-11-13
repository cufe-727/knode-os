import { extractFinalAnswer } from '../metrics/text.js';
import type { Task } from '../types.js';
import { containsTerm } from './lists.js';

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

const NUMBER = /-?\d+(?:\.\d+)?/g;

/** Is one of `values` named in `text`: as a whole term, or (numbers, with `tolerance`) as a number within it. */
export function namesValue(text: string, values: string[], tolerance?: number): boolean {
  if (values.some((v) => v && containsTerm(text, v))) return true;
  if (tolerance === undefined || !(tolerance > 0)) return false;
  const nums = [...text.normalize('NFKC').matchAll(NUMBER)].map((m) => Number(m[0]));
  return values.some((v) => /^-?\d+(?:\.\d+)?$/.test(v.trim()) && nums.some((n) => Math.abs(n - Number(v)) <= tolerance));
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
  const gold = namesValue(final, goldTerms(t), tolerance);
  const stale = !gold && namesValue(final, staleTerms(t));
  return { gold, stale, declined: !gold && declines(final) };
}
