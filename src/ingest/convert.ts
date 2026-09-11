import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import sharp from 'sharp';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { LlmClient } from '../llm/client.js';

const CONVERSION_VERSION = 1;
const DEFAULT_MAX_PDF_PAGES = 100;
const DEFAULT_MAX_IMAGE_DIMENSION = 2048;

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff',
  '.avif', '.heic', '.heif', '.svg',
]);

export interface VisionModel {
  enabled: boolean;
  label: string;
  complete: LlmClient['complete'];
}

export interface ConversionOptions {
  vision?: VisionModel;
  maxPdfPages?: number;
  maxImageDimension?: number;
}

export interface ConversionResult {
  markdown: string;
  kind: 'image-vision' | 'pdf-text' | 'pdf-vision' | 'pdf-hybrid';
  model: string;
  warnings: string[];
}

export function isPdfFile(file: string): boolean {
  return path.extname(file).toLowerCase() === '.pdf';
}

export function isImageFile(file: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

export function isConvertibleFile(file: string): boolean {
  return isPdfFile(file) || isImageFile(file);
}

/** Keep the original extension in the generated name to avoid foo.pdf/foo.md collisions. */
export function convertedPathForRaw(rawRel: string): string {
  return isConvertibleFile(rawRel) ? `${rawRel}.md` : rawRel;
}

export function conversionCacheKey(opts: ConversionOptions): string {
  const vision = opts.vision?.enabled ? opts.vision.label : 'no-vision';
  return [
    `v${CONVERSION_VERSION}`,
    vision,
    `pages:${opts.maxPdfPages ?? DEFAULT_MAX_PDF_PAGES}`,
    `image:${opts.maxImageDimension ?? DEFAULT_MAX_IMAGE_DIMENSION}`,
  ].join('|');
}

export async function convertDocumentToMarkdown(
  sourcePath: string,
  rawRel: string,
  opts: ConversionOptions = {},
): Promise<ConversionResult> {
  if (isImageFile(rawRel)) return convertImage(sourcePath, rawRel, opts);
  if (isPdfFile(rawRel)) return convertPdf(sourcePath, rawRel, opts);
  throw new Error(`unsupported conversion source: ${rawRel}`);
}

async function convertImage(sourcePath: string, rawRel: string, opts: ConversionOptions): Promise<ConversionResult> {
  const vision = requireVision(opts.vision, rawRel);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-image-'));
  const normalized = path.join(tempDir, 'image.png');
  try {
    await normalizeImage(sourcePath, normalized, opts.maxImageDimension);
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

async function convertPdf(sourcePath: string, rawRel: string, opts: ConversionOptions): Promise<ConversionResult> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(sourcePath));
  const loadingTask = pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false });
  const pdf = await loadingTask.promise;
  const maxPages = Math.max(1, opts.maxPdfPages ?? DEFAULT_MAX_PDF_PAGES);
  const pageCount = Math.min(pdf.numPages, maxPages);
  const sections: string[] = [];
  const warnings: string[] = [];
  let textPages = 0;
  let visionPages = 0;

  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const text = await extractPdfPageText(page);
      const textLength = meaningfulLength(text);
      if (textLength >= 20 || (textLength > 0 && !opts.vision?.enabled)) {
        textPages++;
        sections.push(`## Page ${pageNumber}\n\n${text}`);
        page.cleanup();
        continue;
      }

      if (!opts.vision?.enabled) {
        warnings.push(`page ${pageNumber} has no extractable text and no vision model is configured`);
        sections.push(`## Page ${pageNumber}\n\n> This page has no extractable text. Configure a vision-capable document model to transcribe it.`);
        page.cleanup();
        continue;
      }

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-pdf-page-'));
      const rendered = path.join(tempDir, `page-${pageNumber}.png`);
      try {
        await renderPdfPage(page, rendered, opts.maxImageDimension);
        const body = await transcribeImage(opts.vision, rendered, `PDF page ${pageNumber} of ${pdf.numPages}: ${path.basename(rawRel)}`);
        sections.push(`## Page ${pageNumber}\n\n${body}`);
        visionPages++;
      } finally {
        page.cleanup();
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  } finally {
    await pdf.destroy();
  }

  if (pdf.numPages > pageCount) warnings.push(`only the first ${pageCount} of ${pdf.numPages} pages were converted`);
  if (textPages === 0 && visionPages === 0) {
    throw new Error(`PDF has no extractable text and vision conversion is unavailable: ${rawRel}`);
  }

  const kind = visionPages === 0 ? 'pdf-text' : textPages === 0 ? 'pdf-vision' : 'pdf-hybrid';
  const model = visionPages ? opts.vision!.label : 'pdfjs';
  const warningBlock = warnings.length ? `\n\n## Conversion warnings\n\n${warnings.map((warning) => `- ${warning}`).join('\n')}` : '';
  return {
    markdown: withProvenance(rawRel, kind, model, sections.join('\n\n') + warningBlock),
    kind,
    model,
    warnings,
  };
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

async function renderPdfPage(
  page: PDFPageProxy,
  outputPath: string,
  maxDimension = DEFAULT_MAX_IMAGE_DIMENSION,
): Promise<void> {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2, Math.max(1, maxDimension / Math.max(base.width, base.height)));
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext('2d');
  await page.render({ canvasContext: context as never, viewport }).promise;
  fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
}

async function extractPdfPageText(
  page: PDFPageProxy,
): Promise<string> {
  const content = await page.getTextContent();
  const lines: string[] = [];
  let line = '';
  let lastY: number | null = null;
  let lastEndX = 0;

  for (const raw of content.items) {
    if (!('str' in raw) || !raw.str) continue;
    const item = raw as { str: string; transform: number[]; width: number; hasEOL?: boolean };
    const x = item.transform[4] ?? 0;
    const y = item.transform[5] ?? 0;
    const newLine = lastY !== null && Math.abs(y - lastY) > 2;
    if (newLine && line.trim()) {
      lines.push(line.trim());
      line = '';
    }
    if (line && x - lastEndX > 1) line += ' ';
    line += item.str;
    lastY = y;
    lastEndX = x + (item.width ?? 0);
    if (item.hasEOL && line.trim()) {
      lines.push(line.trim());
      line = '';
      lastY = null;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function transcribeImage(vision: VisionModel, imagePath: string, context: string): Promise<string> {
  const response = await vision.complete([
    {
      role: 'system',
      content: [
        'Convert images into faithful, standalone Markdown for a searchable knowledge base.',
        'Preserve every legible word in its original language. Recreate headings, lists and tables with Markdown.',
        'Describe charts, diagrams, screenshots and spatial relationships needed to understand the content.',
        'Do not invent missing facts. Do not discuss the conversion process. Return Markdown only.',
      ].join(' '),
    },
    { role: 'user', content: `${context}\n\nTranscribe and describe this image as Markdown.` },
  ], { images: [{ path: imagePath, mimeType: 'image/png' }], maxTokens: 8_000 });
  const markdown = stripOuterFence(response).trim();
  if (!markdown) throw new Error(`vision model ${vision.label} returned empty Markdown`);
  return markdown;
}

function withProvenance(rawRel: string, kind: ConversionResult['kind'], model: string, body: string): string {
  const title = path.basename(rawRel, path.extname(rawRel));
  return [
    '---',
    `title: ${JSON.stringify(title)}`,
    `source: ${JSON.stringify(rawRel)}`,
    `source_type: ${JSON.stringify(path.extname(rawRel).slice(1).toLowerCase())}`,
    `conversion: ${JSON.stringify(kind)}`,
    `conversion_model: ${JSON.stringify(model)}`,
    '---',
    '',
    body.trim(),
    '',
  ].join('\n');
}

function stripOuterFence(value: string): string {
  return value.replace(/^\s*```(?:markdown|md)?\s*/i, '').replace(/\s*```\s*$/i, '');
}

function meaningfulLength(value: string): number {
  return value.replace(/\s+/g, '').length;
}

function requireVision(vision: VisionModel | undefined, rawRel: string): VisionModel {
  if (!vision?.enabled) {
    throw new Error(`image conversion requires a vision model (OpenAI-compatible, codex-cli, or claude-cli): ${rawRel}`);
  }
  return vision;
}
