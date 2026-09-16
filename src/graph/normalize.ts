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
