import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { ConverterInput, DocumentConverterPlugin } from '../../plugins/types.js';
import { ConversionResult, DEFAULT_MAX_IMAGE_DIMENSION, requireVision, transcribeImage, withProvenance } from './shared.js';

/**
 * The built-in image converter: the image is normalized (rotated upright,
 * bounded, flattened to PNG) and transcribed by the Convert stage's vision
 * model, which it requires.
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
    const body = await transcribeImage(vision, normalized, `Source image: ${path.basename(rawRel)}`);
    return {
      markdown: withProvenance(rawRel, 'image-vision', vision.label, body),
      kind: 'image-vision',
      model: vision.label,
      warnings: [],
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
  version: 1,
  usesVision: true,
  convert: convertImage,
};
