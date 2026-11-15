import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { ConverterInput, DocumentConverterPlugin } from '../../plugins/types.js';
import { ConversionResult, DEFAULT_MAX_IMAGE_DIMENSION, DEFAULT_MAX_PDF_PAGES, meaningfulLength, transcribeImage, withProvenance } from './shared.js';

/**
 * The built-in PDF converter: text pages are read with pdf.js, pages without
 * extractable text are rendered and sent through the Convert stage's vision
 * model when one is configured.
 */

export function isPdfFile(file: string): boolean {
  return path.extname(file).toLowerCase() === '.pdf';
}

export async function convertPdf(input: ConverterInput): Promise<ConversionResult> {
  const { absPath: sourcePath, rel: rawRel, vision } = input;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(sourcePath));
  const loadingTask = pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false });
  const pdf = await loadingTask.promise;
  const maxPages = Math.max(1, input.maxPdfPages ?? DEFAULT_MAX_PDF_PAGES);
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
      if (textLength >= 20 || (textLength > 0 && !vision?.enabled)) {
        textPages++;
        sections.push(`## Page ${pageNumber}\n\n${text}`);
        page.cleanup();
        continue;
      }

      if (!vision?.enabled) {
        warnings.push(`page ${pageNumber} has no extractable text and no vision model is configured`);
        sections.push(`## Page ${pageNumber}\n\n> This page has no extractable text. Configure a vision-capable document model to transcribe it.`);
        page.cleanup();
        continue;
      }

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-pdf-page-'));
      const rendered = path.join(tempDir, `page-${pageNumber}.png`);
      try {
        await renderPdfPage(page, rendered, input.maxImageDimension);
        const body = await transcribeImage(vision, rendered, `PDF page ${pageNumber} of ${pdf.numPages}: ${path.basename(rawRel)}`);
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
  const model = visionPages ? vision!.label : 'pdfjs';
  const warningBlock = warnings.length ? `\n\n## Conversion warnings\n\n${warnings.map((warning) => `- ${warning}`).join('\n')}` : '';
  return {
    markdown: withProvenance(rawRel, kind, model, sections.join('\n\n') + warningBlock),
    kind,
    model,
    warnings,
  };
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

export async function extractPdfPageText(
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

export const pdfConverter: DocumentConverterPlugin = {
  id: 'pdf',
  label: 'PDF · pdf.js text, vision for scanned pages',
  extensions: ['.pdf'],
  version: 1,
  usesVision: true,
  convert: convertPdf,
};
