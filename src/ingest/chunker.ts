import path from 'node:path';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { estimateTokens } from '../llm/tokens.js';

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
    (extra.markdown ?? (ext === '.md' || ext === '.markdown'))
      ? RecursiveCharacterTextSplitter.fromLanguage('markdown', opts)
      : new RecursiveCharacterTextSplitter(opts);
  const pieces = await splitter.splitText(content);
  return pieces
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => ({ content: p, tokenCount: estimateTokens(p) }));
}
