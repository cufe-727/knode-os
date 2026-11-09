import path from 'node:path';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { estimateTokens } from '../llm/tokens.js';
import { codeLanguageOf, splitCodebaseKey } from './codebase/files.js';

export interface ChunkPiece {
  content: string;
  tokenCount: number;
}

/**
 * Split a document into chunks using LangChain's RecursiveCharacterTextSplitter.
 * Markdown files use the markdown-aware separator set so headings stay intact;
 * `markdown` overrides the extension check for derived Markdown whose source
 * key ends in .pdf / .png / .jsonl.
 */
export async function chunkText(
  filePath: string,
  content: string,
  opts: { chunkSize: number; chunkOverlap: number },
  extra: { markdown?: boolean } = {},
): Promise<ChunkPiece[]> {
  const ext = path.extname(filePath).toLowerCase();
  const splitter =
    (extra.markdown ?? (ext === '.md' || ext === '.markdown' || ext === '.mdx'))
      ? RecursiveCharacterTextSplitter.fromLanguage('markdown', opts)
      : new RecursiveCharacterTextSplitter(opts);
  const pieces = await splitter.splitText(content);
  return pieces
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => ({ content: p, tokenCount: estimateTokens(p) }));
}

/**
 * Split a repository file along its language's definitions (docs/design/25):
 * the recursive splitter tries the coarsest separator first — a top-level
 * `fn`, `class`, `def`, `export` — so a chunk is a whole definition where one
 * fits, and only a definition longer than a chunk is cut inside.
 *
 * Every chunk opens with the file it came from and the definition it sits in,
 * when that is not its own first line: code read out of context says little
 * (a `fn new()` could be anything), and the path is what tells an embedding,
 * a keyword search and a reader which `new` this is.
 */
export async function chunkCode(
  filePath: string,
  content: string,
  opts: { chunkSize: number; chunkOverlap: number },
): Promise<ChunkPiece[]> {
  const lang = codeLanguageOf(filePath);
  const key = splitCodebaseKey(filePath);
  const shown = key ? `${key.name}/${key.path}` : filePath;
  const header = `File: ${shown}${lang ? ` (${lang.name})` : ''}`;
  // code is denser than prose: smaller pieces keep one definition per chunk
  const size = Math.max(400, Math.min(opts.chunkSize, 1600));
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: size,
    chunkOverlap: Math.min(opts.chunkOverlap, Math.floor(size / 8)),
    ...(lang?.separators ? { separators: lang.separators } : {}),
    keepSeparator: true,
  });
  const pieces = (await splitter.splitText(content)).map((p) => p.replace(/^\n+|\s+$/g, '')).filter((p) => p.trim().length > 0);
  let lastDefinition: string | null = null;
  return pieces.map((piece) => {
    const first = piece.split('\n', 1)[0];
    const opensDefinition = DEFINITION_LINE.test(first);
    const context = !opensDefinition && lastDefinition ? `${header} — in ${lastDefinition}` : header;
    // the last top-level definition this piece reaches into is where the next one continues
    for (const line of piece.split('\n')) if (DEFINITION_LINE.test(line)) lastDefinition = shorten(line.trim());
    const text = `${context}\n\n${piece}`;
    return { content: text, tokenCount: estimateTokens(text) };
  });
}

/** A top-level declaration in the common languages: what a chunk that continues it belongs to. */
const DEFINITION_LINE = /^(?:export\s+|pub(?:\([^)]*\))?\s+|public\s+|private\s+|protected\s+|internal\s+|async\s+|static\s+|abstract\s+|final\s+)*(?:function\*?|class|interface|type|enum|struct|trait|impl(?:<[^>]*>)?|fn|def|func|module|namespace|object|protocol|extension|actor|defmodule)\s+[A-Za-z_$]/;

function shorten(line: string): string {
  const clean = line.replace(/\s*\{\s*$/, '').replace(/\s+/g, ' ');
  return clean.length > 100 ? `${clean.slice(0, 99)}…` : clean;
}
