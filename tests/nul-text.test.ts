import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { readContent, readSidecarPart, writeContent } from '../src/fs/sidecar.js';
import { prepareDocs } from '../src/ingest/prepare.js';
import { runIngest } from '../src/ingest/pipeline.js';
import { sha256 } from '../src/ingest/source.js';
import { parseFrontmatter, storableText } from '../src/markdown.js';
import { textPdf } from './helpers/pdf.js';

/**
 * PostgreSQL text cannot hold U+0000, and PDF text extraction emits it for
 * glyphs it cannot map (`su\0cient` for an "ffi" ligature). A document holding
 * one failed its whole scope with `invalid byte sequence for encoding "UTF8":
 * 0x00` on every sync, and was never indexed.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-nul-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function indexed(dataDir: string, file: string) {
  const ctx = await createContext(dataDir);
  try {
    const stats = await runIngest(ctx.store, ctx.config, ctx.embedder, ctx.llm, { llmGraph: false });
    const [doc] = await ctx.store.query<{ status: string; title: string; sha256: string; error: string | null }>(
      `SELECT status, title, sha256, error FROM documents WHERE path = $1`,
      [file],
    );
    const chunks = await ctx.store.query<{ content: string }>(
      `SELECT c.content FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = $1 ORDER BY c.seq`,
      [file],
    );
    return { stats, doc, text: chunks.map((c) => c.content).join('\n') };
  } finally {
    await ctx.store.close();
  }
}

describe('text PostgreSQL cannot store', () => {
  it('leaves text without U+0000 or a lone surrogate as it was', () => {
    const clean = '# Café 😀\n\nsufficient — 中文';
    expect(storableText(clean)).toBe(clean);
    expect(storableText('su\u0000ffi\u0000cient')).toBe('sufficient');
    expect(storableText('a\ud83db\ude00c')).toBe('a\ufffdb\ufffdc');
    // a YAML escape spells it too
    expect(parseFrontmatter('---\ntitle: "a\\0b"\ntags: ["c\\u0000d"]\n"e\\0f": 1\n---\nbody').frontmatter).toEqual({ title: 'ab', tags: ['cd'], ef: 1 });
  });

  it('indexes a text file containing U+0000', async () => {
    const dataDir = path.join(tmp, 'text');
    initDataDir(dataDir);
    const file = 'raw/docs/notes.md';
    fs.writeFileSync(path.join(dataDir, file), '# Asset pricing\u0000 notes\n\nThe factors are su\u0000fficient to price the cross-section.\n');

    const { stats, doc, text } = await indexed(dataDir, file);

    expect(stats.errors).toBe(0);
    expect(doc).toMatchObject({ status: 'indexed', title: 'Asset pricing notes', error: null });
    expect(text).toContain('The factors are sufficient to price the cross-section.');
    expect(text).not.toContain('\u0000');
  });

  it('indexes converted Markdown holding U+0000, converted now or before', async () => {
    const dataDir = path.join(tmp, 'converted');
    initDataDir(dataDir);
    fs.mkdirSync(path.join(dataDir, 'raw/docs/research/web/files'), { recursive: true });

    // converted now: the transcript stands in for the extraction, through the same prepare step
    const fresh = 'raw/docs/research/web/files/fresh.pdf';
    fs.writeFileSync(path.join(dataDir, fresh), textPdf('placeholder'));
    fs.writeFileSync(path.join(dataDir, `${fresh}.md`), '## Page 1\n\nVt = Vt\u00001 + e, which is su\u0000cient.\n');

    // converted before this fix: its content.md on disk still holds the NULs, and prepare finds it unchanged
    const before = 'raw/docs/research/web/files/before.pdf';
    fs.writeFileSync(path.join(dataDir, before), textPdf('Quarterly revenue increased.'));
    expect((await prepareDocs(dataDir)).stats).toMatchObject({ prepared: 2, errors: 0 });
    writeContent(dataDir, before, `${readContent(dataDir, before)}\nReturns were su\u0000cient to cover costs.\n`);

    const a = await indexed(dataDir, fresh);
    expect(a.stats.errors).toBe(0);
    expect(a.doc).toMatchObject({ status: 'indexed', error: null });
    expect(a.text).toContain('Vt = Vt1 + e, which is sucient.');
    // the sidecar holds the text as indexed, and its hash is the document's
    expect(readContent(dataDir, fresh)).not.toContain('\u0000');
    expect(readSidecarPart(dataDir, fresh, 'meta')?.contentSha256).toBe(a.doc.sha256);
    expect(a.doc.sha256).toBe(sha256(readContent(dataDir, fresh)!));

    const b = await indexed(dataDir, before);
    expect(b.stats.errors).toBe(0);
    expect(b.doc).toMatchObject({ status: 'indexed', error: null });
    expect(b.text).toContain('Quarterly revenue increased.');
    expect(b.text).toContain('Returns were sucient to cover costs.');
    expect(b.text).not.toContain('\u0000');
    expect(readSidecarPart(dataDir, before, 'meta')?.contentSha256).toBe(b.doc.sha256);
  });
});
