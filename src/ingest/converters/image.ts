import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { ConverterInput, DocumentConverterPlugin } from '../../plugins/types.js';
import { MINDMAP_TYPE, parseMindMap, serializeMindMap } from '../../mindmap/outline.js';
import { ConversionResult, DEFAULT_MAX_IMAGE_DIMENSION, MINDMAP_MARK, requireVision, stripOuterFence, transcribeImage, withProvenance } from './shared.js';

/**
 * The built-in image converter: the image is normalized (rotated upright,
 * bounded, flattened to PNG) and transcribed by the Convert stage's vision
 * model, which it requires. A mind map comes back as its outline and is kept
 * in the canonical form (src/mindmap/outline.ts), typed `MindMap`
 * (docs/design/19-mind-maps.md).
 */

export const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff',
  '.avif', '.heic', '.heif', '.svg',
]);

export function isImageFile(file: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

export async function convertImage(input: ConverterInput): Promise<ConversionResult> {
  const { absPath: sourcePath, rel: rawRel } = input;
  const vision = requireVision(input.vision, rawRel);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-image-'));
  const normalized = path.join(tempDir, 'image.png');
  try {
    await normalizeImage(sourcePath, normalized, input.maxImageDimension);
    const body = await transcribeImage(vision, normalized, `Source image: ${path.basename(rawRel)}`, { mindMaps: true });
    const mindMap = mindMapTranscription(body);
    if (mindMap.outline) {
      return {
        markdown: withProvenance(rawRel, 'image-mindmap', vision.label, mindMap.outline, { type: MINDMAP_TYPE }),
        kind: 'image-mindmap',
        model: vision.label,
        warnings: [],
      };
    }
    return {
      markdown: withProvenance(rawRel, 'image-vision', vision.label, mindMap.body),
      kind: 'image-vision',
      model: vision.label,
      warnings: mindMap.warning ? [mindMap.warning] : [],
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Read what the model returned for a picture: a marked outline that holds a
 * tree becomes the canonical outline; a mark over something that is no tree
 * is dropped and the text kept as a description.
 */
export function mindMapTranscription(markdown: string): { outline: string | null; body: string; warning?: string } {
  const text = stripOuterFence(markdown).trim();
  if (!text.startsWith(MINDMAP_MARK)) return { outline: null, body: text };
  const rest = stripOuterFence(text.slice(MINDMAP_MARK.length)).trim();
  const map = parseMindMap(rest);
  if (map) return { outline: serializeMindMap(map), body: rest };
  return { outline: null, body: rest, warning: 'the image read as a mind map, but its outline held no tree' };
}

async function normalizeImage(sourcePath: string, outputPath: string, maxDimension = DEFAULT_MAX_IMAGE_DIMENSION): Promise<void> {
  const dimension = Math.max(256, maxDimension);
  await sharp(sourcePath, { pages: 1 })
    .rotate()
    .resize({ width: dimension, height: dimension, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .png()
    .toFile(outputPath);
}

export const imageConverter: DocumentConverterPlugin = {
  id: 'image',
  label: 'Images · vision model transcription',
  extensions: [...IMAGE_EXTENSIONS],
  // 2: mind maps come back as outlines (docs/design/19)
  version: 2,
  usesVision: true,
  convert: convertImage,
};
