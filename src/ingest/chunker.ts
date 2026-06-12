import path from 'node:path';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

export interface ChunkPiece {
  content: string;
  tokenCount: number;
}

/** Rough token estimate (≈4 chars/token for English, ~1.6 for CJK — good enough for budgeting). */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[一-鿿぀-ヿ가-힯]/g) ?? []).length;
  const rest = text.length - cjk;
  return Math.ceil(rest / 4 + cjk / 1.6);
}

/**
 * Split a document into chunks using LangChain's RecursiveCharacterTextSplitter.
 * Markdown files use the markdown-aware separator set so headings stay intact.
 */
export async function chunkText(
  filePath: string,
  content: string,
  opts: { chunkSize: number; chunkOverlap: number },
): Promise<ChunkPiece[]> {
  const ext = path.extname(filePath).toLowerCase();
  const splitter =
    ext === '.md' || ext === '.markdown'
      ? RecursiveCharacterTextSplitter.fromLanguage('markdown', opts)
      : new RecursiveCharacterTextSplitter(opts);
  const pieces = await splitter.splitText(content);
  return pieces
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => ({ content: p, tokenCount: estimateTokens(p) }));
}
