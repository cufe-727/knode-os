import { hasCjk } from './text.js';

/**
 * Stylometry (docs/design/23 §2, §5): measurable gold for "does the knowledge
 * base know how this author writes". A profile holds the numbers a reader
 * could check — sentence and paragraph length, vocabulary richness, dialogue
 * share, punctuation and function-word rates — and characteristic terms are
 * the author's words that stand out against the rest of the collection by
 * log-odds with an informative Dirichlet prior (Monroe et al. 2008). For
 * Chinese the terms are character bigrams, since words carry no spaces.
 */

export interface StyleProfile {
  lang: 'zh' | 'en';
  chars: number;
  sentences: number;
  meanSentenceLength: number;
  medianSentenceLength: number;
  meanParagraphLength: number;
  /** Type–token ratio over consecutive 1,000-token windows, averaged (length-independent). */
  typeTokenRatio: number;
  /** Share of characters inside quotation marks. */
  dialogueShare: number;
  /** Per 1,000 characters. */
  punctuation: Record<string, number>;
  /** Per 1,000 tokens. */
  functionWords: Record<string, number>;
}

const EN_FUNCTION = ['the', 'of', 'and', 'to', 'a', 'in', 'that', 'it', 'was', 'he', 'she', 'i', 'his', 'her', 'but', 'not', 'with', 'as', 'had', 'for', 'be', 'on', 'at', 'by', 'which', 'have', 'so', 'all', 'this', 'very', 'upon', 'would', 'could', 'must', 'said'];
const ZH_FUNCTION = ['的', '了', '着', '过', '是', '在', '也', '都', '就', '又', '便', '却', '道', '说', '之', '乎', '者', '矣', '焉', '哉', '而', '与', '以', '于', '其', '此', '那', '这', '么', '呢', '吗', '吧', '啊'];
const PUNCT = ['，', '。', '！', '？', '；', '：', '、', '…', '—', ',', '.', '!', '?', ';', ':', '-'];

export function detectStyleLang(text: string): 'zh' | 'en' {
  const sample = text.slice(0, 20_000);
  const cjk = (sample.match(/[一-鿿]/g) ?? []).length;
  return cjk > sample.length * 0.2 || (hasCjk(sample) && cjk > 500) ? 'zh' : 'en';
}

export function sentencesOf(text: string, lang: 'zh' | 'en'): string[] {
  const parts = lang === 'zh' ? text.split(/(?<=[。！？!?])[”’」』]?\s*/u) : text.split(/(?<=[.!?])["'”’]?\s+(?=[A-Z“"'])/u);
  return parts.map((s) => s.trim()).filter((s) => s.length > 1);
}

/** Tokens for profiles and term statistics: lowercased words, or CJK characters for Chinese. */
export function styleTokens(text: string, lang: 'zh' | 'en'): string[] {
  if (lang === 'zh') return text.match(/[一-鿿]/g) ?? [];
  return (text.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) ?? []);
}

/** Terms for characteristic-word statistics: words, or CJK character bigrams. */
export function styleTerms(text: string, lang: 'zh' | 'en'): string[] {
  if (lang === 'en') return styleTokens(text, 'en').filter((w) => w.length > 2);
  const out: string[] = [];
  for (const run of text.match(/[一-鿿]+/g) ?? []) for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2));
  return out;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function profileText(text: string, lang: 'zh' | 'en' = detectStyleLang(text)): StyleProfile {
  const sentences = sentencesOf(text, lang);
  const lengthOf = (s: string) => (lang === 'zh' ? (s.match(/[一-鿿]/g) ?? []).length : styleTokens(s, 'en').length);
  const lens = sentences.map(lengthOf).filter((n) => n > 0);
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const tokens = styleTokens(text, lang);
  const windows: number[] = [];
  for (let i = 0; i + 1000 <= tokens.length; i += 1000) windows.push(new Set(tokens.slice(i, i + 1000)).size / 1000);
  const quoted = (text.match(/“[^”]*”|「[^」]*」|"[^"\n]*"/g) ?? []).reduce((s, q) => s + q.length, 0);
  const per1kChars = (n: number) => (text.length ? (n * 1000) / text.length : 0);
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  const fw = lang === 'zh' ? ZH_FUNCTION : EN_FUNCTION;
  return {
    lang,
    chars: text.length,
    sentences: sentences.length,
    meanSentenceLength: lens.length ? lens.reduce((s, x) => s + x, 0) / lens.length : 0,
    medianSentenceLength: median(lens),
    meanParagraphLength: paragraphs.length ? paragraphs.reduce((s, p) => s + lengthOf(p), 0) / paragraphs.length : 0,
    typeTokenRatio: windows.length ? windows.reduce((s, x) => s + x, 0) / windows.length : tokens.length ? new Set(tokens).size / tokens.length : 0,
    dialogueShare: text.length ? quoted / text.length : 0,
    punctuation: Object.fromEntries(PUNCT.map((p) => [p, per1kChars(text.split(p).length - 1)])),
    functionWords: Object.fromEntries(fw.map((w) => [w, tokens.length ? ((counts.get(w) ?? 0) * 1000) / tokens.length : 0])),
  };
}

export interface CharacteristicTerm {
  term: string;
  /** Prior-weighted log-odds z-score against the background. */
  z: number;
  count: number;
}

/**
 * The author's characteristic terms: log-odds ratio of each term in the
 * author's text versus the background, with an informative Dirichlet prior
 * from the pooled counts, as a z-score. Terms rarer than `minCount` are
 * dropped (names and one-off words would dominate otherwise).
 */
export function characteristicTerms(target: string, background: string, opts: { lang?: 'zh' | 'en'; k?: number; minCount?: number; exclude?: Set<string> } = {}): CharacteristicTerm[] {
  const lang = opts.lang ?? detectStyleLang(target);
  const count = (text: string) => {
    const m = new Map<string, number>();
    for (const t of styleTerms(text, lang)) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  };
  const a = count(target);
  const b = count(background);
  const prior = new Map<string, number>();
  for (const [t, n] of a) prior.set(t, n);
  for (const [t, n] of b) prior.set(t, (prior.get(t) ?? 0) + n);
  const na = [...a.values()].reduce((s, x) => s + x, 0);
  const nb = [...b.values()].reduce((s, x) => s + x, 0);
  const a0 = [...prior.values()].reduce((s, x) => s + x, 0);
  // scale the prior to a modest total so it shrinks rare terms without swamping frequent ones
  const scale = 1000 / Math.max(1, a0);
  const minCount = opts.minCount ?? 5;
  const out: CharacteristicTerm[] = [];
  for (const [t, ya] of a) {
    if (ya < minCount || opts.exclude?.has(t)) continue;
    const alpha = Math.max(0.01, (prior.get(t) ?? 0) * scale);
    const alpha0 = 1000;
    const yb = b.get(t) ?? 0;
    const la = Math.log((ya + alpha) / (na + alpha0 - ya - alpha));
    const lb = Math.log((yb + alpha) / (nb + alpha0 - yb - alpha));
    const variance = 1 / (ya + alpha) + 1 / (yb + alpha);
    out.push({ term: t, z: (la - lb) / Math.sqrt(variance), count: ya });
  }
  return out.sort((x, y) => y.z - x.z).slice(0, opts.k ?? 50);
}

export type Direction = 'higher' | 'lower' | 'similar';

/** How an author's profile differs from the collection's, feature by feature (±10% is "similar"). */
export function directions(author: StyleProfile, collection: StyleProfile, tolerance = 0.1): Record<string, Direction> {
  const cmp = (x: number, y: number): Direction => (y === 0 ? (x === 0 ? 'similar' : 'higher') : x > y * (1 + tolerance) ? 'higher' : x < y * (1 - tolerance) ? 'lower' : 'similar');
  return {
    sentenceLength: cmp(author.meanSentenceLength, collection.meanSentenceLength),
    paragraphLength: cmp(author.meanParagraphLength, collection.meanParagraphLength),
    vocabularyRichness: cmp(author.typeTokenRatio, collection.typeTokenRatio),
    dialogue: cmp(author.dialogueShare, collection.dialogueShare),
    exclamations: cmp((author.punctuation['！'] ?? 0) + (author.punctuation['!'] ?? 0), (collection.punctuation['！'] ?? 0) + (collection.punctuation['!'] ?? 0)),
    questions: cmp((author.punctuation['？'] ?? 0) + (author.punctuation['?'] ?? 0), (collection.punctuation['？'] ?? 0) + (collection.punctuation['?'] ?? 0)),
  };
}

export const STYLE_FEATURES: Record<string, { en: string; zh: string }> = {
  sentenceLength: { en: 'sentence length', zh: '句子长度' },
  paragraphLength: { en: 'paragraph length', zh: '段落长度' },
  vocabularyRichness: { en: 'vocabulary richness (type–token ratio)', zh: '用词丰富度（型例比）' },
  dialogue: { en: 'share of dialogue', zh: '对话所占比例' },
  exclamations: { en: 'use of exclamation marks', zh: '感叹号的使用' },
  questions: { en: 'use of question marks', zh: '问号的使用' },
};

/** Does a predicted term name a gold characteristic term? Exact for words; bigram overlap for Chinese. */
export function termMatches(predicted: string, gold: string, lang: 'zh' | 'en'): boolean {
  const p = predicted.toLowerCase().trim();
  const g = gold.toLowerCase().trim();
  if (!p || !g) return false;
  if (lang === 'en') return p === g || p.replace(/s$/, '') === g.replace(/s$/, '');
  return p.includes(g) || (p.length >= 2 && g.includes(p));
}
