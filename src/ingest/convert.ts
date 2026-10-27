import { pluginRegistry } from '../plugins/registry.js';
import type { ConverterInput, DocumentConverterPlugin } from '../plugins/types.js';
import { ConversionResult, DEFAULT_MAX_IMAGE_DIMENSION, DEFAULT_MAX_PDF_PAGES, VisionModel } from './converters/shared.js';

/**
 * The Convert stage's front door. Which file types can be converted, and how,
 * is decided by the converters in the plugin registry: the built-in PDF and
 * image converters (src/ingest/converters), and whatever a plugin adds
 * (docs/design/11). Everything that asks "is this a convertible original?" —
 * prepare, the source reader, folder import, grep — asks here.
 */

export type { ConversionKind, ConversionResult, VisionModel } from './converters/shared.js';
export { withProvenance } from './converters/shared.js';
export { isPdfFile } from './converters/pdf.js';
export { IMAGE_EXTENSIONS, isImageFile } from './converters/image.js';

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

/** Keep the original extension in the generated name to avoid foo.pdf/foo.md collisions. */
export function convertedPathForRaw(rawRel: string): string {
  return isConvertibleFile(rawRel) ? `${rawRel}.md` : rawRel;
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
 * vision model when the converter uses one, and the size limits. A different
 * key means the conversion is redone; a knob that is only a rate (concurrency)
 * must never be part of it.
 */
export function conversionCacheKey(opts: ConversionOptions, rawRel?: string): string {
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
  ].join('|');
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
