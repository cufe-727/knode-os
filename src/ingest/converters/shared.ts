import path from 'node:path';
import type { LlmClient } from '../../llm/client.js';

/**
 * What every document converter shares: the result shape, the vision model
 * handed to converters that need one, and the Markdown provenance header.
 * Converters themselves are plugins (src/plugins/types.ts); the built-in PDF
 * and image ones live beside this file.
 */

export interface VisionModel {
  enabled: boolean;
  label: string;
  complete: LlmClient['complete'];
}

/** The built-in kinds, open to whatever a plugin converter reports. */
export type ConversionKind = 'image-vision' | 'pdf-text' | 'pdf-vision' | 'pdf-hybrid' | (string & {});

export interface ConversionResult {
  markdown: string;
  kind: ConversionKind;
  /** What produced the text: a vision model's label, or the converter's own name (e.g. "pdfjs"). */
  model: string;
  warnings: string[];
}

export const DEFAULT_MAX_PDF_PAGES = 100;
export const DEFAULT_MAX_IMAGE_DIMENSION = 2048;

/** The first line of a transcription that is a mind map's outline (src/mindmap/outline.ts), when the converter asked for one. */
export const MINDMAP_MARK = '<!-- knode:mindmap -->';

const MINDMAP_INSTRUCTIONS = [
  'If the image is a mind map, tree diagram, org chart or outline (labelled nodes joined by lines into one hierarchy), do not describe it:',
  `reply with the line ${MINDMAP_MARK}, then the root label as a level-1 heading (# label), a blank line, and every other node as a nested bullet list,`,
  '"- " bullets with two spaces of indentation per level, each node under its parent, in the order drawn from top to bottom.',
  'Copy every label exactly as written, numbering and parenthetical notes included; wrap a label drawn in bold in **…**;',
  'a chain of single nodes joined by lines (A — B — C) nests, each under the one before. Write nothing else.',
].join(' ');

/**
 * Ask the Convert stage's vision model for the Markdown of one image.
 * `mindMaps`: a picture of a hierarchy comes back as a marked outline instead of a description.
 */
export async function transcribeImage(vision: VisionModel, imagePath: string, context: string, opts: { mindMaps?: boolean } = {}): Promise<string> {
  const response = await vision.complete([
    {
      role: 'system',
      content: [
        'Convert images into faithful, standalone Markdown for a searchable knowledge base.',
        'Preserve every legible word in its original language. Recreate headings, lists and tables with Markdown.',
        'Describe charts, diagrams, screenshots and spatial relationships needed to understand the content.',
        'Do not invent missing facts. Do not discuss the conversion process. Return Markdown only.',
        ...(opts.mindMaps ? [MINDMAP_INSTRUCTIONS] : []),
      ].join(' '),
    },
    { role: 'user', content: `${context}\n\nTranscribe and describe this image as Markdown.` },
    // an outline of a few hundred nodes runs past what a page of prose needs
  ], { images: [{ path: imagePath, mimeType: 'image/png' }], maxTokens: opts.mindMaps ? 16_000 : 8_000 });
  const markdown = stripOuterFence(response).trim();
  if (!markdown) throw new Error(`vision model ${vision.label} returned empty Markdown`);
  return markdown;
}

/**
 * The frontmatter every converted document starts with: where it came from and what made it.
 * `extra` adds what a converter read from the document itself — a web page's own title, its
 * address and dates — after the fixed keys; a key whose value is empty is left out.
 */
export function withProvenance(rawRel: string, kind: ConversionKind, model: string, body: string, extra: Record<string, string | null | undefined> = {}): string {
  const { title: ownTitle, ...rest } = extra;
  const title = ownTitle?.trim() || path.basename(rawRel, path.extname(rawRel));
  return [
    '---',
    `title: ${JSON.stringify(title)}`,
    `source: ${JSON.stringify(rawRel)}`,
    `source_type: ${JSON.stringify(path.extname(rawRel).slice(1).toLowerCase())}`,
    `conversion: ${JSON.stringify(kind)}`,
    `conversion_model: ${JSON.stringify(model)}`,
    ...Object.entries(rest).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => `${k}: ${JSON.stringify(v!.trim())}`),
    '---',
    '',
    body.trim(),
    '',
  ].join('\n');
}

export function stripOuterFence(value: string): string {
  return value.replace(/^\s*```(?:markdown|md)?\s*/i, '').replace(/\s*```\s*$/i, '');
}

export function meaningfulLength(value: string): number {
  return value.replace(/\s+/g, '').length;
}

export function requireVision(vision: VisionModel | undefined, rawRel: string): VisionModel {
  if (!vision?.enabled) {
    throw new Error(`image conversion requires a vision model (OpenAI-compatible, codex-cli, or claude-cli): ${rawRel}`);
  }
  return vision;
}
