/**
 * Content languages (docs/design/17): the languages a workspace's knowledge is
 * read in, as opposed to the interface language of a client, which is each
 * reader's own preference and never part of the workspace.
 *
 * A workspace with content languages on names a primary language and any
 * secondary ones. Every document under raw/docs in another language is
 * translated into the primary one in the background (src/work/translate.ts);
 * a secondary language is offered in the readers' switcher and translated
 * into when someone asks for it. Summary pages are written in the primary
 * language. Nothing is ever written over an original.
 */

export interface LanguageInfo {
  code: string;
  /** In English, for prompts and logs. */
  english: string;
  /** In the language itself, for a switcher. */
  native: string;
  /** How a prompt names the language it is to write. */
  prompt: string;
}

/**
 * The languages knode-os can detect and name. Codes are BCP 47: the primary
 * subtag, and a script for traditional Chinese, which a reader would not want
 * to read as simplified.
 */
export const LANGUAGES: readonly LanguageInfo[] = [
  { code: 'zh', english: 'Chinese (Simplified)', native: '简体中文', prompt: 'Simplified Chinese' },
  { code: 'zh-Hant', english: 'Chinese (Traditional)', native: '繁體中文', prompt: 'Traditional Chinese' },
  { code: 'en', english: 'English', native: 'English', prompt: 'English' },
  { code: 'ja', english: 'Japanese', native: '日本語', prompt: 'Japanese' },
  { code: 'ko', english: 'Korean', native: '한국어', prompt: 'Korean' },
  { code: 'fr', english: 'French', native: 'Français', prompt: 'French' },
  { code: 'de', english: 'German', native: 'Deutsch', prompt: 'German' },
  { code: 'es', english: 'Spanish', native: 'Español', prompt: 'Spanish' },
  { code: 'pt', english: 'Portuguese', native: 'Português', prompt: 'Portuguese' },
  { code: 'it', english: 'Italian', native: 'Italiano', prompt: 'Italian' },
  { code: 'ru', english: 'Russian', native: 'Русский', prompt: 'Russian' },
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code.toLowerCase(), l]));
const TRADITIONAL = new Set(['zh-hant', 'zh-tw', 'zh-hk', 'zh-mo']);

/**
 * A language tag as one of `LANGUAGES`' codes, or null: `zh-CN` and `zh-Hans`
 * are `zh`, `zh-TW` and `zh-Hant-HK` are `zh-Hant`, `en-US` is `en`, `pt_BR`
 * is `pt`. Case and `_` separators are forgiven; an unknown language is null.
 */
export function normalizeLanguage(tag: unknown): string | null {
  if (typeof tag !== 'string') return null;
  const t = tag.trim().toLowerCase().replace(/_/g, '-');
  if (!t) return null;
  const parts = t.split('-');
  if (parts[0] === 'zh') return parts.slice(1).some((p) => TRADITIONAL.has(`zh-${p}`)) ? 'zh-Hant' : 'zh';
  return BY_CODE.get(parts[0])?.code ?? null;
}

export function languageInfo(code: string): LanguageInfo | null {
  return BY_CODE.get(code.toLowerCase()) ?? null;
}

/** The language a prompt asks for, or the code itself for one knode-os does not know. */
export function promptLanguage(code: string): string {
  return languageInfo(code)?.prompt ?? code;
}

/**
 * Whether text in `a` needs no translation into `b`: the same language, the
 * Chinese scripts counted as one — detection reads the script, and cannot
 * tell simplified from traditional characters (docs/design/17 §6).
 */
export function sameLanguage(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const base = (code: string) => code.split('-')[0].toLowerCase();
  return base(a) === base(b);
}

/* ------------------------------ the config ------------------------------ */

export interface LanguagesConfig {
  /** Off: nothing is translated, summaries keep the document's language, readers see no switcher. */
  enabled: boolean;
  /** The language the knowledge base is read in: what every other document is translated into. Empty = not chosen. */
  primary: string;
  /** Offered in the readers' switcher; a document is translated into one of them when someone asks. */
  secondary: string[];
  /**
   * Longest document translated without being asked, in characters of its
   * indexed text; a longer one is translated when someone opens it and asks.
   * 0 = no limit.
   */
  maxChars: number;
}

export const DEFAULT_LANGUAGES: LanguagesConfig = { enabled: false, primary: '', secondary: [], maxChars: 200_000 };

/** What the rest of knode-os reads: normalized, the switcher's order fixed. */
export interface ContentLanguages {
  /** On, with a primary language knode-os knows. */
  on: boolean;
  primary: string | null;
  secondary: string[];
  /** The primary first, then the secondary ones: the languages a reader may pick. */
  offered: string[];
  maxChars: number;
}

/** A `languages` block from a file or a request, held to what knode-os can act on. */
export function normalizeLanguagesConfig(raw: unknown): LanguagesConfig {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const primary = normalizeLanguage(r.primary) ?? '';
  const secondary: string[] = [];
  for (const tag of Array.isArray(r.secondary) ? r.secondary : []) {
    const code = normalizeLanguage(tag);
    if (code && code !== primary && !secondary.includes(code)) secondary.push(code);
  }
  const maxChars = Number(r.maxChars);
  return {
    enabled: r.enabled === true,
    primary,
    secondary,
    maxChars: Number.isFinite(maxChars) && maxChars >= 0 ? Math.floor(maxChars) : DEFAULT_LANGUAGES.maxChars,
  };
}

export function contentLanguages(config: { languages?: unknown }): ContentLanguages {
  const c = normalizeLanguagesConfig(config.languages);
  const on = c.enabled && c.primary !== '';
  return {
    on,
    primary: c.primary || null,
    secondary: c.secondary,
    offered: on ? [c.primary, ...c.secondary] : [],
    maxChars: c.maxChars,
  };
}
