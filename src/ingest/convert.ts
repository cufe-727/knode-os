import crypto from 'node:crypto';
import path from 'node:path';
import { MAX_CONVERTIBLE_FILE_BYTES } from '../constants.js';
import { pluginRegistry } from '../plugins/registry.js';
import type { ConverterInput, DocumentConverterPlugin } from '../plugins/types.js';
import { ConversionResult, DEFAULT_MAX_IMAGE_DIMENSION, DEFAULT_MAX_PDF_PAGES, VisionModel, withProvenance } from './converters/shared.js';

/**
 * The Convert stage's front door. Which file types can be converted, and how,
 * is decided by the converters in the plugin registry: the built-in PDF,
 * image, HTML and EPUB converters (src/ingest/converters), and whatever a plugin adds
 * (docs/design/11). Everything that asks "is this a convertible original?" —
 * prepare, the source reader, folder import, grep — asks here.
 */

export type { ConversionKind, ConversionResult, VisionModel } from './converters/shared.js';
export { withProvenance } from './converters/shared.js';
export { isPdfFile } from './converters/pdf.js';
export { IMAGE_EXTENSIONS, isImageFile } from './converters/image.js';
export { isEpubFile } from './converters/epub.js';

export interface ConversionOptions {
  vision?: VisionModel;
  maxPdfPages?: number;
  maxImageDimension?: number;
}

/**
 * The built-in converters keep the cache-key format conversions were stored
 * under before converters were plugins (`v1|…`), so an upgrade re-converts
 * nothing. A plugin converter's key names it, so it never collides with them.
 */
const LEGACY_KEY_CONVERTERS = new Set(['pdf', 'image']);

export function isConvertibleFile(file: string): boolean {
  return pluginRegistry().hasConverter(file);
}

/** The converter that owns a source key's extension, if any. */
export function converterFor(file: string): DocumentConverterPlugin | undefined {
  return pluginRegistry().converterFor(file);
}

/** The largest original of this type the Convert stage takes (its converter's `maxBytes`, else 50 MB). */
export function maxConvertibleBytes(file: string): number {
  const own = converterFor(file)?.maxBytes;
  return typeof own === 'number' && Number.isFinite(own) && own > 0 ? own : MAX_CONVERTIBLE_FILE_BYTES;
}

/** Keep the original extension in the generated name to avoid foo.pdf/foo.md collisions. */
export function convertedPathForRaw(rawRel: string): string {
  return isConvertibleFile(rawRel) ? `${rawRel}.md` : rawRel;
}

/**
 * A reviewed transcript (docs/design/19-mind-maps.md): Markdown a person or an
 * agent wrote for a converted original, kept beside it under the name its
 * converted Markdown has — `华为产业链.webp.md` for `华为产业链.webp`. While it
 * is there it is the original's text: prepare reads it instead of asking a
 * model, a vision model's misreading is corrected by editing a file, and the
 * transcript is not a document of its own.
 */
export function transcriptPathFor(rawRel: string): string | null {
  return isConvertibleFile(rawRel) ? `${rawRel}.md` : null;
}

/** The original a transcript path belongs to, by name alone (whether either exists is the caller's question). */
export function originalOfTranscript(rel: string): string | null {
  if (!/\.md$/i.test(rel)) return null;
  const original = rel.slice(0, -3);
  return isConvertibleFile(original) ? original : null;
}

/** Material research captured (src/research/capture.ts): kept whole, because what a study came for is often at the end. */
const RESEARCH_CAPTURES = 'raw/docs/research/';
export const RESEARCH_MAX_PDF_PAGES = 1000;

/**
 * Pages a PDF is converted up to. A prospectus or an annual report puts its
 * financial statements last, so a captured PDF is read to the end (up to
 * RESEARCH_MAX_PDF_PAGES); everything else keeps the default, and with it the
 * cache key it was converted under.
 */
export function pdfPageLimit(rawRel: string | undefined, opts: ConversionOptions): number {
  if (opts.maxPdfPages !== undefined) return opts.maxPdfPages;
  return rawRel?.replace(/\\/g, '/').startsWith(RESEARCH_CAPTURES) ? RESEARCH_MAX_PDF_PAGES : DEFAULT_MAX_PDF_PAGES;
}

/**
 * What a cached conversion is keyed by: the converter and its version, the
 * vision model when the converter uses one, the size limits, and the file's
 * own variant when its converter reads it a way of its own (`variant` on the
 * converter). A different key means the conversion is redone; a knob that is
 * only a rate (concurrency) must never be part of it.
 */
export function conversionCacheKey(opts: ConversionOptions, rawRel?: string, variant?: string | null): string {
  const converter = rawRel ? converterFor(rawRel) : undefined;
  const version = converter?.version ?? 1;
  const head = !converter || LEGACY_KEY_CONVERTERS.has(converter.id) ? `v${version}` : `${converter.id}@${version}`;
  const usesVision = converter ? converter.usesVision === true : true;
  const vision = usesVision && opts.vision?.enabled ? opts.vision.label : 'no-vision';
  return [
    head,
    vision,
    `pages:${pdfPageLimit(rawRel, opts)}`,
    `image:${opts.maxImageDimension ?? DEFAULT_MAX_IMAGE_DIMENSION}`,
    ...(variant ? [variant] : []),
  ].join('|');
}

/** The file's own part of its conversion key (DocumentConverterPlugin.variant); null when it has none or it cannot be read. */
export async function conversionVariant(absPath: string, rawRel: string, opts: ConversionOptions): Promise<string | null> {
  const converter = converterFor(rawRel);
  if (!converter?.variant) return null;
  try {
    return await converter.variant({ absPath, rel: rawRel, maxImageDimension: opts.maxImageDimension });
  } catch {
    // an unreadable file fails in the conversion itself, with a message saying so
    return null;
  }
}

/** What a transcript's text is keyed by: its own bytes, so an edit is a new conversion and nothing else is. */
export function transcriptCacheKey(transcript: string | Uint8Array): string {
  return `transcript|${crypto.createHash('sha256').update(transcript).digest('hex').slice(0, 16)}`;
}

/**
 * The original's Markdown from its transcript: the transcript's own
 * frontmatter and body as written, with where it came from added — only
 * added, so whatever the author declared (`type: MindMap`, `subject`,
 * `entities`) is indexed as written.
 */
export function transcriptToMarkdown(rawRel: string, transcriptRel: string, text: string): ConversionResult {
  const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  const yaml = fm ? fm[1] : '';
  const by = /^transcribed_by:[ \t]*["']?([^"'\n]+?)["']?[ \t]*$/m.exec(yaml)?.[1].trim() || 'transcript';
  if (!fm) {
    return { markdown: withProvenance(rawRel, 'transcript', by, text, { transcript: transcriptRel }), kind: 'transcript', model: by, warnings: [] };
  }
  const has = (key: string) => new RegExp(`^${key}:`, 'm').test(yaml);
  const ext = path.extname(rawRel).slice(1).toLowerCase();
  const added = [
    !has('title') ? `title: ${JSON.stringify(path.basename(rawRel, path.extname(rawRel)))}` : null,
    !has('source') ? `source: ${JSON.stringify(rawRel)}` : null,
    !has('source_type') ? `source_type: ${JSON.stringify(ext)}` : null,
    !has('conversion') ? 'conversion: "transcript"' : null,
    !has('conversion_model') ? `conversion_model: ${JSON.stringify(by)}` : null,
    !has('transcript') ? `transcript: ${JSON.stringify(transcriptRel)}` : null,
  ].filter((l): l is string => l !== null);
  const markdown = `---\n${[...added, yaml].filter((s) => s.trim()).join('\n')}\n---\n\n${text.slice(fm[0].length).trim()}\n`;
  return { markdown, kind: 'transcript', model: by, warnings: [] };
}

export async function convertDocumentToMarkdown(
  sourcePath: string,
  rawRel: string,
  opts: ConversionOptions = {},
): Promise<ConversionResult> {
  const converter = converterFor(rawRel);
  if (!converter) throw new Error(`unsupported conversion source: ${rawRel}`);
  const input: ConverterInput = {
    absPath: sourcePath,
    rel: rawRel,
    vision: opts.vision,
    maxPdfPages: pdfPageLimit(rawRel, opts),
    maxImageDimension: opts.maxImageDimension,
  };
  const result = await converter.convert(input);
  if (!result || typeof result.markdown !== 'string') throw new Error(`converter ${converter.id} returned no Markdown for ${rawRel}`);
  return {
    markdown: result.markdown,
    kind: result.kind || converter.id,
    model: result.model || converter.id,
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
  };
}
