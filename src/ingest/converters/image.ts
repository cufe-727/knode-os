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
 * (docs/design/19-mind-maps.md). A long screenshot too tall for the frame is
 * read in bands, top to bottom (docs/design/21-feishu-documents.md D7).
 */

export const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff',
  '.avif', '.heic', '.heif', '.svg',
]);

export function isImageFile(file: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

/**
 * Taller than this many times its width, an image is read in bands: a long
 * phone screenshot (a 知识星球 post, a chat thread, an article — 1152 × 27 000
 * pixels is common) squeezed whole into the model's frame would arrive a few
 * dozen pixels wide, and not one word of it legible.
 */
export const TALL_IMAGE_RATIO = 2.5;
/** A band is at most this many times as tall as it is wide — a page the model reads like a phone screen. */
const BAND_RATIO = 1.5;
/** Bands read together in one call: consecutive, so a line cut at a band's edge is finished in the next. */
const BANDS_PER_CALL = 3;
/** Width the rows are sampled at to find a quiet place to cut. */
const SAMPLE_WIDTH = 160;

/**
 * Where to cut an image `height` rows tall into bands of about `band` rows:
 * each cut moves up — by up to a quarter band — to the quietest row near it
 * (`busy(row)` is how much changes along the row: 0 on a blank line), so a
 * cut falls between lines of text rather than through one. Returns the
 * bands' tops and heights, covering every row once.
 */
export function bandsFor(height: number, band: number, busy: (row: number) => number): { top: number; height: number }[] {
  const out: { top: number; height: number }[] = [];
  const step = Math.max(1, Math.floor(band));
  let top = 0;
  while (height - top > step * 1.15) {
    const nominal = top + step;
    let cut = nominal;
    let best = Infinity;
    for (let row = nominal; row >= nominal - Math.floor(step / 4) && row > top + step / 2; row--) {
      const b = busy(row);
      if (b < best) {
        best = b;
        cut = row;
        if (b === 0) break;
      }
    }
    out.push({ top, height: cut - top });
    top = cut;
  }
  out.push({ top, height: height - top });
  return out;
}

/**
 * True when an image must be read in bands: tall for its width, and too tall
 * to reach the model unscaled. A tall picture that fits the frame as it is —
 * a vertical mind map 600 × 2000 — is read whole, so a tree is still read as
 * one.
 */
export function readInBands(size: { width: number; height: number }, maxDimension = DEFAULT_MAX_IMAGE_DIMENSION): boolean {
  return size.width > 0 && size.height > size.width * TALL_IMAGE_RATIO && size.height > Math.max(256, maxDimension);
}

/** The image's size once turned upright (EXIF orientations 5–8 swap width and height). */
async function uprightSize(sourcePath: string): Promise<{ width: number; height: number }> {
  const meta = await sharp(sourcePath, { pages: 1 }).metadata();
  const swap = (meta.orientation ?? 1) >= 5;
  return { width: (swap ? meta.height : meta.width) ?? 0, height: (swap ? meta.width : meta.height) ?? 0 };
}

/** Read a tall image band by band, a few bands a call, and join what the model read, top to bottom. */
async function transcribeTall(input: ConverterInput, vision: NonNullable<ConverterInput['vision']>, tempDir: string, size: { width: number; height: number }): Promise<{ body: string; parts: number }> {
  const { absPath: sourcePath, rel: rawRel } = input;
  const sample = await sharp(sourcePath, { pages: 1 }).rotate().resize({ width: Math.min(SAMPLE_WIDTH, size.width) }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const scale = sample.info.height / size.height;
  const busy = (row: number): number => {
    const y = Math.min(sample.info.height - 1, Math.max(0, Math.round(row * scale)));
    let min = 255;
    let max = 0;
    for (let x = 0; x < sample.info.width; x++) {
      const v = sample.data[y * sample.info.width * sample.info.channels + x * sample.info.channels];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    // a little noise (JPEG, a watermark's faint grey) still counts as blank
    return max - min <= 24 ? 0 : max - min;
  };
  const bands = bandsFor(size.height, size.width * BAND_RATIO, busy);
  const dimension = Math.max(256, input.maxImageDimension ?? DEFAULT_MAX_IMAGE_DIMENSION);
  const tiles: string[] = [];
  for (const [i, b] of bands.entries()) {
    const tile = path.join(tempDir, `part-${String(i + 1).padStart(3, '0')}.png`);
    await sharp(sourcePath, { pages: 1 })
      .rotate()
      .extract({ left: 0, top: b.top, width: size.width, height: b.height })
      .resize({ width: dimension, height: dimension, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .png()
      .toFile(tile);
    tiles.push(tile);
  }
  const bodies: string[] = [];
  for (let i = 0; i < tiles.length; i += BANDS_PER_CALL) {
    const group = tiles.slice(i, i + BANDS_PER_CALL);
    const first = i + 1;
    const last = i + group.length;
    const context = [
      `Source image: ${path.basename(rawRel)} — one long screenshot, cut into ${tiles.length} parts read top to bottom.`,
      `These are parts ${first}${last > first ? `–${last}` : ''}, in order. Transcribe only what they show, as one continuous text:`,
      'a line cut at the edge of a part is finished in the next, so write it once. Describe each chart or drawing where it appears.',
    ].join(' ');
    bodies.push(await transcribeImage(vision, group, context));
  }
  return { body: bodies.join('\n\n'), parts: tiles.length };
}

export async function convertImage(input: ConverterInput): Promise<ConversionResult> {
  const { absPath: sourcePath, rel: rawRel } = input;
  const vision = requireVision(input.vision, rawRel);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-image-'));
  const normalized = path.join(tempDir, 'image.png');
  try {
    const size = await uprightSize(sourcePath);
    if (readInBands(size, input.maxImageDimension)) {
      const tall = await transcribeTall(input, vision, tempDir, size);
      return {
        markdown: withProvenance(rawRel, 'image-vision', vision.label, tall.body, { read_in_parts: String(tall.parts) }),
        kind: 'image-vision',
        model: vision.label,
        warnings: [],
      };
    }
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
  // a long screenshot read in bands has a key of its own: one squeezed whole before bands existed is read again
  variant: async ({ absPath, maxImageDimension }) => (readInBands(await uprightSize(absPath), maxImageDimension) ? 'bands' : null),
  convert: convertImage,
};
