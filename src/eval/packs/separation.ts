import type { ListSpec, Task } from '../types.js';

/**
 * Shared pieces of the separation families (docs/design/28): what a recipe
 * needs to plant a task a grep agent cannot solve by pattern alone and to
 * check, without a model, that it is planted the way it claims.
 *
 * - lexical tokens and overlap: a non-lexical hop or a planted connection is
 *   only that when the question and the bridge's evidence share no words
 *   (Chinese: no two-character sequence; English: no content word)
 * - paraphrased and cross-lingual copies of an existing task, gold unchanged
 * - the ways an answer may write a quarter, for structured (fields) matching
 */

export type Lang = 'zh' | 'en';
export type Draft = Omit<Task, 'evidence'> & { evidence: Task['evidence'] };

const EN_STOP = new Set([
  'about', 'after', 'again', 'also', 'been', 'before', 'being', 'both', 'does', 'down', 'each', 'even', 'every', 'from', 'have', 'here', 'into', 'just', 'last',
  'like', 'made', 'more', 'most', 'much', 'once', 'only', 'other', 'over', 'same', 'some', 'such', 'than', 'that', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'those', 'through', 'very', 'week', 'weeks', 'were', 'what', 'when', 'where', 'which', 'while', 'whom', 'whose', 'will', 'with', 'year', 'your',
]);
const CJK = /[㐀-鿿]/;

/** Content words (English, four letters or more, no stop words) or two-character sequences (Chinese) of a text. */
export function lexicalTokens(lang: Lang, text: string): Set<string> {
  const out = new Set<string>();
  if (lang === 'zh') {
    const t = text.normalize('NFKC');
    for (let i = 0; i + 1 < t.length; i++) if (CJK.test(t[i]) && CJK.test(t[i + 1])) out.add(t.slice(i, i + 2));
    return out;
  }
  for (const w of text.normalize('NFKC').toLowerCase().match(/[a-z][a-z'-]*/g) ?? []) {
    const word = w.replace(/'s$/, '').replace(/s$/, '');
    if (word.length >= 4 && !EN_STOP.has(w) && !EN_STOP.has(word)) out.add(word);
  }
  return out;
}

/** Tokens `question` shares with any of `lines`, ignoring the tokens of `allow` (an anchor the question may name). */
export function lexicalOverlap(lang: Lang, question: string, lines: string[], allow: string[] = []): string[] {
  const q = lexicalTokens(lang, question);
  const allowed = new Set(allow.flatMap((a) => [...lexicalTokens(lang, a)]));
  const hit = new Set<string>();
  for (const l of lines) for (const tok of lexicalTokens(lang, l)) if (q.has(tok) && !allowed.has(tok)) hit.add(tok);
  return [...hit].sort();
}

/** Do two texts share no token at all? */
export function lexicallyDisjoint(lang: Lang, a: string, b: string): boolean {
  const x = lexicalTokens(lang, a);
  for (const t of lexicalTokens(lang, b)) if (x.has(t)) return false;
  return true;
}

/** The same task asked in other words: gold, evidence and scoring unchanged. */
export function paraphraseOf(base: Draft, question: string, n = 1): Draft {
  return { ...base, id: `${base.id}-pp${n}`, type: 'paraphrase', question, primary: undefined, meta: { ...(base.meta ?? {}), of: base.id, family: 'paraphrase', baseType: base.type } };
}

/** The same task asked in another language: gold, evidence and scoring unchanged. */
export function crossLingualOf(base: Draft, question: string, lang: Lang): Draft {
  return { ...base, id: `${base.id}-xl`, type: 'cross-lingual', lang, question, primary: undefined, meta: { ...(base.meta ?? {}), of: base.id, family: 'cross-lingual', baseType: base.type } };
}

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** A Chinese numeral for 1–199 (一, 十二, 二十, 一百零五). */
export function cnNum(n: number): string {
  if (n < 10) return CN_DIGITS[n];
  if (n < 20) return `十${n % 10 ? CN_DIGITS[n % 10] : ''}`;
  if (n < 100) return `${CN_DIGITS[Math.floor(n / 10)]}十${n % 10 ? CN_DIGITS[n % 10] : ''}`;
  const rest = n % 100;
  return `${CN_DIGITS[Math.floor(n / 100)]}百${rest === 0 ? '' : rest < 10 ? `零${CN_DIGITS[rest]}` : rest < 20 ? `一${cnNum(rest)}` : cnNum(rest)}`;
}

const EN_ORD = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
export const enOrdinal = (n: number) => EN_ORD[n] ?? `${n}th`;

/** How an answer may name quarter q (structured matching). */
export function quarterForms(lang: Lang, q: number): string[] {
  return lang === 'zh' ? [`Q${q}`, `第${cnNum(q)}季度`, `${cnNum(q)}季度`, `第${q}季度`, `${q}季度`] : [`Q${q}`, `quarter ${q}`, `${enOrdinal(q)} quarter`];
}

/** The list spec of a structured query: matched by fields, the whole set or nothing. */
export function exactSetSpec(items: number): ListSpec {
  return { match: 'fields', ordered: false, maxItems: Math.min(60, Math.max(10, items + 5)), requireDocs: false, primary: 'exact' };
}
