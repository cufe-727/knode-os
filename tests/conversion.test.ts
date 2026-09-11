import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultConfig, saveConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { readSidecar } from '../src/fs/sidecar.js';
import { convertDocumentToMarkdown } from '../src/ingest/convert.js';
import { runIngest } from '../src/ingest/pipeline.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-conversion-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function writeExecutable(file: string, body: string): void {
  fs.writeFileSync(file, `#!/bin/bash\n${body}`, { mode: 0o755 });
}

/** Tiny one-page PDF with a built-in Helvetica text stream. */
function textPdf(text: string): Buffer {
  const escaped = text.replace(/([\\()])/g, '\\$1');
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

describe('PDF and image conversion', () => {
  it('extracts text PDFs into page-structured Markdown without an LLM', async () => {
    const file = path.join(tmp, 'text.pdf');
    fs.writeFileSync(file, textPdf('Quarterly revenue increased by 42 percent.'));

    const result = await convertDocumentToMarkdown(file, 'raw/docs/text.pdf');

    expect(result.kind).toBe('pdf-text');
    expect(result.markdown).toContain('source_type: "pdf"');
    expect(result.markdown).toContain('## Page 1');
    expect(result.markdown).toContain('Quarterly revenue increased by 42 percent.');
  });

  it('renders scanned PDF pages and sends them through the vision route', async () => {
    const file = path.join(tmp, 'scan.pdf');
    fs.writeFileSync(file, textPdf(''));
    let receivedImage = false;

    const result = await convertDocumentToMarkdown(file, 'raw/docs/scan.pdf', {
      vision: {
        enabled: true,
        label: 'fake-vision',
        complete: async (_messages, options) => {
          const image = options.images?.[0]?.path;
          receivedImage = Boolean(image && fs.existsSync(image));
          return '# Scanned page\n\nInvoice total: $123.00';
        },
      },
    });

    expect(receivedImage).toBe(true);
    expect(result.kind).toBe('pdf-vision');
    expect(result.markdown).toContain('Invoice total: $123.00');
  });

  it('converts an image through codex-cli and indexes the generated Markdown', async () => {
    const dataDir = path.join(tmp, 'image-workspace');
    initDataDir(dataDir);
    const imagePath = path.join(dataDir, 'raw/docs/pixel.png');
    fs.writeFileSync(imagePath, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ));

    const stub = path.join(tmp, 'vision-codex.sh');
    writeExecutable(stub, `
out=""; image=""; prev=""
for arg in "$@"; do
  [ "$prev" = "--output-last-message" ] && out="$arg"
  [ "$prev" = "--image" ] && image="$arg"
  prev="$arg"
done
[ -f "$image" ] || exit 9
cat > /dev/null
printf '# Visual transcription\\n\\nThe image contains a green status indicator.' > "$out"
`);

    const config = defaultConfig();
    config.extraction.documentLlm = {
      ...config.extraction.documentLlm,
      provider: 'codex-cli',
      cliPath: stub,
    };
    saveConfig(dataDir, config);

    const ctx = await createContext(dataDir);
    try {
      const stats = await runIngest(ctx.store, ctx.config, ctx.embedder, ctx.llm, { llmGraph: false });
      const [doc] = await ctx.store.query<{ path: string; status: string }>(
        `SELECT path, status FROM documents WHERE path = 'cooked/docs/pixel.png.md'`,
      );
      const [chunk] = await ctx.store.query<{ content: string }>(
        `SELECT c.content FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = 'cooked/docs/pixel.png.md' LIMIT 1`,
      );
      const sidecar = readSidecar(dataDir, 'cooked/docs/pixel.png.md');

      expect(stats.errors).toBe(0);
      expect(doc).toMatchObject({ path: 'cooked/docs/pixel.png.md', status: 'indexed' });
      expect(chunk.content).toContain('green status indicator');
      expect(sidecar?.meta.rawPath).toBe('raw/docs/pixel.png');
      expect(sidecar?.meta.conversion?.kind).toBe('image-vision');
      expect(fs.readFileSync(imagePath).subarray(1, 4).toString()).toBe('PNG');
    } finally {
      await ctx.store.close();
    }
  }, 20_000);
});
