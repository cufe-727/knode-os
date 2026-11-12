/**
 * Entity-name normalization for resolution. Two keys per name:
 *
 *   key   the spelling itself, reduced to letters and digits (NFKC folds
 *         full-width forms, case and punctuation away): "Ｃ.A.T.L" == "catl"
 *   bare  the same with a corporate-form suffix removed, so 宁德时代 and
 *         宁德时代股份有限公司 meet, and "Tesla, Inc." meets "Tesla"
 *
 * Deliberately conservative: only exact key equality is ever used to merge
 * automatically; anything fuzzier goes through the nightly candidate audit and
 * a person.
 */

const CJK_SUFFIXES = [
  '集团股份有限公司', '集团有限公司', '股份有限公司', '有限责任公司', '控股有限公司',
  '控股集团', '集团公司', '有限公司', '集团', '控股', '公司', '股份',
];

const LATIN_SUFFIX = /[\s,.]*\b(?:incorporated|inc|corporation|corp|company|co|limited|ltd|llc|plc|gmbh|ag|s\.?a|n\.?v|pty|holdings?|group)\.?\s*$/i;

const WRAPPERS = /[「」『』【】《》〈〉"“”‘’']/g;

/** Letters and digits only, NFKC-folded and lower-cased. */
export function keyOf(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function hasCjk(s: string): boolean {
  return /[㐀-鿿]/.test(s);
}

/** Strip trailing corporate-form suffixes (up to three layers: "… Co., Ltd." → "…"). */
export function stripCorporateSuffix(name: string): string {
  let s = name.normalize('NFKC').replace(WRAPPERS, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) {
    let next = s;
    for (const suffix of CJK_SUFFIXES) {
      if (next.endsWith(suffix) && keyOf(next.slice(0, -suffix.length)).length >= 2) {
        next = next.slice(0, -suffix.length).trim();
        break;
      }
    }
    const m = LATIN_SUFFIX.exec(next);
    if (m && keyOf(next.slice(0, m.index)).length >= 3) next = next.slice(0, m.index).trim();
    next = next.replace(/[\s,.·•\-–—_()（）]+$/u, '').trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

export interface NameKeys {
  key: string;
  bare: string;
}

/** The two lookup keys of a name. `bare` equals `key` when no suffix was stripped or the remainder is too short. */
export function nameKey(name: string): NameKeys {
  const cleaned = name.normalize('NFKC').replace(WRAPPERS, ' ');
  const key = keyOf(cleaned);
  const stripped = stripCorporateSuffix(cleaned);
  const bare = keyOf(stripped);
  const minLen = hasCjk(bare) ? 2 : 3;
  return { key, bare: bare && bare !== key && bare.length >= minLen ? bare : key };
}

export type KeyKind = 'exact' | 'bare';

/**
 * Every lookup key an entity answers to, tagged: 'exact' = the spelling of
 * its name or an alias (folded), 'bare' = that spelling with a corporate
 * suffix removed. A key that is exact for one spelling stays exact.
 */
export function entityKeyKinds(name: string, aliases: readonly string[] = []): Map<string, KeyKind> {
  const out = new Map<string, KeyKind>();
  for (const raw of [name, ...aliases]) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const { key, bare } = nameKey(raw);
    if (key.length >= 2) out.set(key, 'exact');
    if (bare !== key && bare.length >= (hasCjk(bare) ? 2 : 3) && !out.has(bare)) out.set(bare, 'bare');
  }
  return out;
}

/** Every lookup key an entity answers to: its name and aliases, with and without corporate suffixes. */
export function entityKeys(name: string, aliases: readonly string[] = []): Set<string> {
  return new Set(entityKeyKinds(name, aliases).keys());
}

/** The keys a *mention* may match with: exact spellings only, or also its suffix-stripped form. */
export function mentionKeys(name: string, aliases: readonly string[], mode: 'exact' | 'suffix'): Set<string> {
  const out = new Set<string>();
  for (const [k, kind] of entityKeyKinds(name, aliases)) if (mode === 'suffix' || kind === 'exact') out.add(k);
  return out;
}

/** Same type, or either side is an untyped placeholder (concept / other / unknown). */
export function typesCompatible(a?: string | null, b?: string | null): boolean {
  if (!a || !b || a === b) return true;
  return a === 'concept' || a === 'other' || b === 'concept' || b === 'other';
}

/* ──────────────────── spellings as they stand in a text ──────────────────── */

/** The longest key a spelling is looked up by (link index, the graph recall channel). */
export const SPELLING_MAX_CHARS = 32;

/** A Han character, or a run of other letters and digits: the atoms a key is matched from (NFKC-folded per atom, offsets kept). */
const UNIT_RE = /\p{Script=Han}|(?:(?!\p{Script=Han})[\p{L}\p{N}])+/gu;
const HAN_UNIT_RE = /\p{Script=Han}/u;
/** Latin words of one name may be separated by this much (a space, a hyphen, "C. A. T. L"). CJK keys match without gaps. */
const LATIN_GAP = 2;
const GAP_RE = /^[\s\-.·'’&]*$/;

export interface TextUnit {
  key: string;
  start: number;
  end: number;
  han: boolean;
}

export function textUnits(text: string): TextUnit[] {
  const out: TextUnit[] = [];
  for (const m of text.matchAll(UNIT_RE)) {
    const raw = m[0];
    const key = keyOf(raw);
    if (!key) continue;
    out.push({ key, start: m.index!, end: m.index! + raw.length, han: HAN_UNIT_RE.test(raw) });
  }
  return out;
}

/** Whether `next` continues a spelling that reached `prev`: CJK without a gap, Latin words across a space, a hyphen or a dot. */
export function unitsJoin(text: string, prev: TextUnit, next: TextUnit): boolean {
  const gap = next.start - prev.end;
  if (gap <= 0) return true;
  return !next.han && !prev.han && gap <= LATIN_GAP && GAP_RE.test(text.slice(prev.end, next.start));
}

/** Of overlapping spans the longest, then the earliest, in text order. */
export function longestSpans<T extends { start: number; end: number }>(spans: T[]): T[] {
  const sorted = [...spans].sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const taken: T[] = [];
  for (const s of sorted) if (!taken.some((t) => s.start < t.end && t.start < s.end)) taken.push(s);
  return taken.sort((a, b) => a.start - b.start);
}

/**
 * Every run of a text's units that a spelling could be, with where it stands:
 * the keys `findLinks` tries, without a link index to stop at the ones no
 * spelling continues. From the first `maxUnits` units.
 */
export function spellingSpans(text: string, maxUnits = Infinity, maxChars = SPELLING_MAX_CHARS): { key: string; start: number; end: number }[] {
  const units = textUnits(text).slice(0, maxUnits);
  const out: { key: string; start: number; end: number }[] = [];
  for (let i = 0; i < units.length; i++) {
    let acc = '';
    for (let j = i; j < units.length; j++) {
      if (j > i && !unitsJoin(text, units[j - 1], units[j])) break;
      acc += units[j].key;
      if (acc.length > maxChars) break;
      if (acc.length >= 2) out.push({ key: acc, start: units[i].start, end: units[j].end });
    }
  }
  return out;
}

/**
 * A spelling too weak to name anything on its own: a number of fewer than five
 * digits (a date, a count or a price before it is a ticker), a Latin one of
 * fewer than three letters (an abbreviation found inside any text).
 */
export function weakSpelling(key: string): boolean {
  if (/^\d+$/.test(key)) return key.length < 5;
  return /^[a-z0-9]+$/.test(key) && key.length < 3;
}
