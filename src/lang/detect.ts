import { normalizeLanguage } from './languages.js';
import { DOCUMENT_PATH, FENCED_CODE } from './protect.js';

/**
 * The language a text is written in — from its script, and for Latin script
 * from its commonest words (docs/design/17 §2).
 *
 * What a reader never reads is taken out first: frontmatter, code, HTML tags,
 * URLs, link targets, paths. A digest of Chinese posts carries an image URL
 * per post, and counted as letters those made 1,138 of the finance
 * workspace's 22,600 Chinese documents read as English (2026-10-28).
 *
 * A CJK character carries about a word, a Latin word five or six letters, so
 * the two are compared as words, and a Chinese post full of tickers and
 * English terms still reads as Chinese. Kana among the CJK makes it
 * Japanese, Hangul Korean. Latin-script text is told apart by its function
 * words — the, der, le, el, il … — and is English when nothing stands out;
 * Cyrillic is Russian. No letters at all (a table of numbers, a data dump):
 * no language.
 */

const FRONTMATTER = /^﻿?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const NOISE: RegExp[] = [
  FENCED_CODE,
  /<!--[\s\S]*?-->/g,
  /`[^`\n]+`/g,
  /\]\([^)\n]*\)/g, // Markdown link and image targets
  /\[\[[^\]\n]*\/[^\]\n]*\]\]/g, // wikilinks to paths
  /(?:https?|ftp):\/\/[^\s<>()\]]+/gi,
  /\bwww\.[^\s<>()\]]+/gi,
  DOCUMENT_PATH,
  /<[^>\n]{1,400}>/g, // HTML tags, anchors
  /[\w.+-]+@[\w-]+\.[\w.-]+/g, // e-mail addresses
  /\{#[^}\n]*\}/g, // heading ids
];

/** A text with what readers never read taken out, the way detection sees it. */
export function readableText(text: string): string {
  let t = text.replace(FRONTMATTER, '');
  for (const re of NOISE) t = t.replace(re, ' ');
  t = t.replace(/^#[ \t]*%%(?![ \t]*\[markdown\])[^\n]*/gm, ' '); // notebook code-cell headings flattened into a line
  // A copied minified block or a repeated Latin filler is not running
  // prose. Long unbroken identifiers must not outvote Chinese paragraphs.
  t = t.replace(/[A-Za-z][A-Za-z0-9_]{119,}/g, ' ');
  return t;
}

export interface ScriptCounts {
  han: number;
  kana: number;
  hangul: number;
  latin: number;
  cyrillic: number;
}

export function scriptCounts(text: string): ScriptCounts {
  const c: ScriptCounts = { han: 0, kana: 0, hangul: 0, latin: 0, cyrillic: 0 };
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x20000 && cp <= 0x2a6df)) c.han++;
    else if ((cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x31f0 && cp <= 0x31ff)) c.kana++;
    else if ((cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x3130 && cp <= 0x318f)) c.hangul++;
    else if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0x24f)) c.latin++;
    else if (cp >= 0x400 && cp <= 0x4ff) c.cyrillic++;
  }
  return c;
}

/** Less text than this, in words, has no language: a heading letter, a unit, a ticker. */
const MIN_WORDS = 2;

/** About how many words a text holds, whatever its script: what a translation should keep. */
export function wordCount(counts: ScriptCounts): number {
  return counts.han + counts.kana + counts.hangul + counts.latin / 5.5 + counts.cyrillic / 6;
}

/** Function words, which every text in the language is full of and few texts in another one are. */
const FUNCTION_WORDS: Record<string, string[]> = {
  en: ['the', 'and', 'of', 'to', 'is', 'that', 'for', 'with', 'are', 'was', 'this', 'it', 'be', 'by', 'not', 'have', 'from', 'which', 'were', 'their'],
  fr: ['le', 'les', 'des', 'et', 'est', 'une', 'du', 'que', 'qui', 'dans', 'pour', 'pas', 'sur', 'au', 'avec', 'ce', 'sont', 'par', 'aux', 'été'],
  de: ['der', 'die', 'und', 'das', 'ist', 'nicht', 'mit', 'den', 'ein', 'eine', 'zu', 'von', 'auf', 'für', 'sich', 'dem', 'auch', 'im', 'wird', 'werden'],
  es: ['el', 'los', 'las', 'que', 'y', 'en', 'una', 'es', 'por', 'con', 'para', 'se', 'del', 'al', 'lo', 'como', 'más', 'pero', 'sus', 'fue'],
  pt: ['os', 'que', 'do', 'da', 'em', 'um', 'uma', 'para', 'com', 'não', 'é', 'se', 'por', 'mais', 'dos', 'das', 'ao', 'foi', 'pelo', 'são'],
  it: ['il', 'di', 'che', 'è', 'un', 'una', 'per', 'non', 'del', 'della', 'sono', 'con', 'si', 'gli', 'al', 'lo', 'nel', 'alla', 'anche', 'più'],
};
const WORD_LANG = new Map<string, string[]>();
for (const [lang, words] of Object.entries(FUNCTION_WORDS)) {
  for (const w of words) WORD_LANG.set(w, [...(WORD_LANG.get(w) ?? []), lang]);
}

/** Grammar words left in a translation, excluding names and other identifiers. */
export function functionWordCount(text: string, language: string): number | null {
  const words = FUNCTION_WORDS[normalizeLanguage(language) ?? language];
  if (!words) return null;
  const vocabulary = new Set(words);
  let count = 0;
  // Converted PDFs and fetched source files sometimes contain unfenced
  // code. Its keywords ("for", "with", "is", "not", "from") are not
  // untranslated grammar. Keep comments and docstring prose in the check.
  const narrative = text.split('\n').filter((line) => {
    const code = line.replace(/^\s*[+-]{1,3}\s*/, '').trim().replace(/^\d+\s+/, '');
    if (/^,→/.test(code)) return false; // wrapped code lines in converted PDFs
    if (/^(?:from\s+[\w.]+\s+import\b|import\s+[\w.,]+(?:\s+as\s+\w+)?\s*$)/.test(code)) return false;
    if (/^(?:(?:async\s+)?def\s+\w+\s*\(|class\s+\w+\s*[:(])/.test(code)) return false;
    if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\[[^\]\n]+\])*\s*[+*/|&-]?=(?!=)/.test(code)) return false;
    if (/^[A-Za-z_][\w.]*\(/.test(code)) return false;
    if (/^(?:if|elif|for|while|with|except|return|yield|raise|assert)\b/.test(code) && /[()[\]{}:=]/.test(code)) return false;
    return true;
  }).join('\n');
  for (const m of narrative.toLowerCase().matchAll(/(?<![\p{L}\p{N}_.])[a-zàâäçéèêëîïôöùûüÿñãõáíóúœß]+(?![\p{L}\p{N}_])/gu)) {
    if (vocabulary.has(m[0])) count++;
  }
  return count;
}

/** Whether a segment is a source-code listing with no foreign narrative. */
export function isCodeListing(text: string): boolean {
  const lines = readableText(text).split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length < 4) return false;
  let code = 0;
  for (const line of lines) {
    if (/^\\?\/\//.test(line) || /^\\?#+/.test(line)) {
      const comment = line.replace(/^\\?(?:\/\/|#+)\s*/, '');
      if (!comment || /^[\d\s#*_=-]+$/.test(comment) || /^alpha\s*[_-]?\d*\b/i.test(comment)
        || /[()[\]=<>+*/|&]/.test(comment) || scriptCounts(comment).han > 0) continue;
      return false;
    }
    if (/^[{}()[\],.;]+$/.test(line)) continue;
    if (/^(?:(?:async\s+)?def\s+\w+\s*\(|class\s+\w+\s*[:(]|module\s+\w+\s*$)/.test(line)
      || /^(?:from\s+[\w.]+\s+import\b|import\s+[\w.,]+)/.test(line)
      || /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\[[^\]\n]+\])*\s*[+*/|&-]?=(?!=)/.test(line)
      || /^[A-Za-z_][\w.]*\(/.test(line)
      || /^(?:if|elif|for|while|with|except|return|yield|raise|assert|break|continue|pass)\b/.test(line)) {
      code++;
      continue;
    }
    return false;
  }
  return code >= 4;
}

function latinLanguage(text: string): string {
  const score: Record<string, number> = {};
  let seen = 0;
  for (const m of text.toLowerCase().matchAll(/[a-zàâäçéèêëîïôöùûüÿñãõáíóúœß]+/g)) {
    const langs = WORD_LANG.get(m[0]);
    if (!langs) continue;
    seen++;
    // a word several languages share counts for each of them a little
    for (const l of langs) score[l] = (score[l] ?? 0) + 1 / langs.length;
    if (seen >= 4000) break;
  }
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return 'en';
  const [best, top] = ranked[0];
  // too little to go on, or nothing standing out: English, the commonest Latin-script language here
  if (best !== 'en' && (top < 3 || top < (score.en ?? 0) * 1.5)) return 'en';
  return best;
}

/** The detected language of a text, as a `LANGUAGES` code; null when it has no letters. */
export function detectTextLanguage(text: string): string | null {
  // the start and the end of a long text, cut before the stripping so a filing of a million characters costs no more than a post
  const head = text.length > 60_000 ? `${text.slice(0, 30_000)}\n${text.slice(-30_000)}` : text;
  let sample = readableText(head);
  if (sample.length > 40_000) sample = sample.slice(0, 20_000) + sample.slice(-20_000);
  const c = scriptCounts(sample);
  const cjk = c.han + c.kana + c.hangul;
  // a table of numbers with a header letter or two is in no language anyone would translate
  if (wordCount(c) < MIN_WORDS) return null;
  if (cjk > 0 && cjk >= (c.latin + c.cyrillic) * 0.3) {
    if (c.kana >= cjk * 0.1) return 'ja';
    if (c.hangul >= cjk * 0.3) return 'ko';
    return 'zh';
  }
  if (c.cyrillic > c.latin) return 'ru';
  return latinLanguage(sample);
}

/**
 * A document's language: what its frontmatter declares (`lang` /
 * `language`) when knode-os knows that language, else what its text reads as.
 */
export function detectLanguage(text: string, frontmatter: Record<string, unknown> = {}): string | null {
  for (const key of ['lang', 'language']) {
    const declared = normalizeLanguage(frontmatter[key]);
    if (declared) return declared;
  }
  return detectTextLanguage(text);
}
