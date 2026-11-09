import path from 'node:path';
import { isReservedWikiFile } from '../lineage/declared.js';
import { readMatter } from '../markdown.js';

/**
 * OKF conformance for the indexed view (L0 → L1).
 *
 * raw/ keeps the bytes a producer uploaded. What the pipeline indexes is a
 * derived view: the file's own text normalized in memory, or the Markdown a
 * PDF / image was converted into (persisted in its sidecar). Giving that view
 * the one field OKF requires (`type`, SPEC §11) costs nothing and makes every
 * document a readable concept instead of something only knode-os can
 * interpret; `okf validate --as-indexed` checks exactly this view.
 *
 * Two rules keep this honest:
 *
 *   - **Only add.** Existing keys are never rewritten, reordered or dropped,
 *     so a producer's own fields round-trip untouched. That is what §11 asks
 *     of consumers, and it is also what makes re-cooking deterministic.
 *   - **Never invent provenance.** `generated` is written only when knode-os
 *     actually produced the content (a PDF or image conversion), or when the
 *     producer already said so in a private spelling we can translate.
 *     A human-written note stays unattributed rather than getting a fabricated
 *     actor — the same line `migrateWikiToOkf` draws.
 */

const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdx']);

/**
 * Version of the normalization rules, recorded in every sidecar's meta.json.
 * Bump it when the rules change: every text source is re-prepared (and its
 * indexed hash may change, which invalidates the tier-1 replay for that
 * document); converted sources are re-normalized without re-converting.
 */
export const NORMALIZER_VERSION = 1;

export interface OkfNormalizeOptions {
  /** `type` to declare when the document does not have one. Defaults to Document. */
  type?: string;
  /** Actor (SPEC §7) that produced this copy — set only when knode-os produced it. */
  producedBy?: string;
  /**
   * When the content last meaningfully changed (SPEC §5.2). Pass the raw
   * file's mtime rather than `now`: re-preparing unchanged bytes must produce
   * identical output, or every prepare would churn the hash and re-embed.
   */
  at?: string;
}

/** True for the source paths this normalizer will touch: Markdown that is not a reserved OKF file. */
export function isNormalizableCookedPath(rel: string): boolean {
  return MARKDOWN_EXT.has(path.extname(rel).toLowerCase()) && !isReservedWikiFile(rel);
}

/**
 * Add the missing OKF frontmatter to one Markdown document. Returns the
 * markdown unchanged when nothing is missing, when the path is reserved
 * (index.md / log.md must not carry frontmatter) or when the existing
 * frontmatter is unparseable — a broken YAML block is a human's problem, not
 * something to silently rewrite.
 */
export function normalizeCookedFrontmatter(rel: string, markdown: string, opts: OkfNormalizeOptions = {}): string {
  if (!isNormalizableCookedPath(rel)) return markdown;

  const parsed = parse(markdown);
  if (parsed === null) return markdown;
  const { frontmatter: fm, body, hasFrontmatter } = parsed;

  const additions: string[] = [];
  if (!isNonEmptyString(fm.type)) additions.push(`type: ${JSON.stringify(opts.type?.trim() || 'Document')}`);
  if (!isNonEmptyString(fm.title)) additions.push(`title: ${JSON.stringify(titleFor(rel, fm, body))}`);

  const generated = okfGeneratedLine(fm, opts);
  if (generated) additions.push(generated);

  if (additions.length === 0) return markdown;
  if (!hasFrontmatter) return `---\n${additions.join('\n')}\n---\n\n${markdown}`;

  // Insert directly after the opening fence so existing lines keep their
  // byte-for-byte spelling, including quoting style and key order.
  const eol = markdown.startsWith('---\r\n') ? '\r\n' : '\n';
  return markdown.replace(/^---\r?\n/, `---${eol}${additions.join(eol)}${eol}`);
}

/**
 * SPEC §5.2 `generated`. Produced here only from something the producer or the
 * pipeline actually knows: a conversion we ran, or a private spelling of the
 * same fact (`generator` + `generated_at`) that just needs the standard key.
 * The private keys are left in place — translating is additive, and dropping a
 * producer's field would break round-tripping.
 */
function okfGeneratedLine(fm: Record<string, unknown>, opts: OkfNormalizeOptions): string | null {
  if (fm.generated !== undefined) return null;

  const by = isNonEmptyString(fm.generator) ? fm.generator.trim() : opts.producedBy?.trim();
  if (!by) return null;
  const at = isNonEmptyString(fm.generated_at) ? fm.generated_at.trim() : opts.at;
  return at
    ? `generated: { by: ${JSON.stringify(by)}, at: ${JSON.stringify(at)} }`
    : `generated: { by: ${JSON.stringify(by)} }`;
}

/** Frontmatter title → first heading → filename stem, same order as ingest. */
function titleFor(rel: string, fm: Record<string, unknown>, body: string): string {
  if (isNonEmptyString(fm.title)) return fm.title.trim();
  const heading = /^#\s+(.+?)\s*$/m.exec(body);
  if (heading) return heading[1].trim();
  return path.basename(rel).replace(/\.[^.]+$/, '');
}

function parse(markdown: string): { frontmatter: Record<string, unknown>; body: string; hasFrontmatter: boolean } | null {
  const hasFrontmatter = /^---\r?\n/.test(markdown);
  if (!hasFrontmatter) return { frontmatter: {}, body: markdown, hasFrontmatter: false };
  if (!/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(markdown)) return null;
  try {
    const p = readMatter(markdown);
    return { frontmatter: p.data as Record<string, unknown>, body: p.content, hasFrontmatter: true };
  } catch {
    return null;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
