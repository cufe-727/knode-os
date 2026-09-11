/**
 * Managed regions inside generated wiki pages.
 *
 *   <!-- knode:begin body -->
 *   …generated text, regenerated whenever the page's inputs change…
 *   <!-- knode:end body -->
 *
 * Text outside the markers belongs to the human and survives regeneration;
 * it is also the only part of a generated page that counts as a knowledge
 * source (prose written on a stub asserts the entity). Legacy pages that were
 * fully generated without markers are treated as one region named `body`.
 */

const BEGIN = (id: string) => `<!-- knode:begin ${id} -->`;
const END = (id: string) => `<!-- knode:end ${id} -->`;
const REGION_RE = /<!-- knode:begin ([\w.-]+) -->\n?([\s\S]*?)\n?<!-- knode:end \1 -->/g;
const LEGACY_HOT_RE = /<!-- hot-topics:start -->\n?([\s\S]*?)\n?<!-- hot-topics:end -->/;

export interface SplitRegions {
  /** Text with every managed region removed. */
  human: string;
  regions: Map<string, string>;
}

export function splitRegions(markdown: string): SplitRegions {
  const regions = new Map<string, string>();
  let human = markdown.replace(REGION_RE, (_m, id: string, content: string) => {
    regions.set(id, content);
    return '';
  });
  const legacy = LEGACY_HOT_RE.exec(human);
  if (legacy) {
    regions.set('hot-topics', legacy[1]);
    human = human.replace(LEGACY_HOT_RE, '');
  }
  return { human, regions };
}

export function stripRegions(markdown: string): string {
  return splitRegions(markdown).human;
}

export function renderRegion(id: string, content: string): string {
  return `${BEGIN(id)}\n${content.replace(/\s+$/, '')}\n${END(id)}`;
}

/** Replace (or append) one region. `content === null` removes it. */
export function replaceRegion(markdown: string, id: string, content: string | null): string {
  const re = new RegExp(`<!-- knode:begin ${escapeRe(id)} -->\\n?[\\s\\S]*?\\n?<!-- knode:end ${escapeRe(id)} -->`);
  const legacy = id === 'hot-topics' ? LEGACY_HOT_RE : null;
  if (re.test(markdown)) {
    return markdown.replace(re, content === null ? '' : renderRegion(id, content)).replace(/\n{3,}/g, '\n\n');
  }
  if (legacy && legacy.test(markdown)) {
    return markdown.replace(legacy, content === null ? '' : renderRegion(id, content)).replace(/\n{3,}/g, '\n\n');
  }
  if (content === null) return markdown;
  const base = markdown.replace(/\s+$/, '');
  return `${base}${base ? '\n\n' : ''}${renderRegion(id, content)}\n`;
}

export function hasRegions(markdown: string): boolean {
  return /<!-- knode:begin [\w.-]+ -->/.test(markdown) || LEGACY_HOT_RE.test(markdown);
}

/** True when text carries real prose (not just headings / whitespace / links to nothing). */
export function hasProse(text: string): boolean {
  const stripped = text
    .replace(/^#+\s.*$/gm, '')
    .replace(/^\s*[-*]\s*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > 0;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
