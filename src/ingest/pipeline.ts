import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { KnodeConfig } from '../config.js';
import { isTextFile, safePath, walkFiles } from '../fs/files.js';
import { LlmClient } from '../llm/client.js';
import { Store, toVectorLiteral } from '../store/db.js';
import { DocRoot, DocumentRow, IngestStats } from '../types.js';
import { clearDocumentGraph, extractWithLlm, wireFromMarkdown } from '../graph/extract.js';
import { chunkText } from './chunker.js';
import { EmbeddingProvider } from './embeddings.js';

/**
 * Ingestion pipeline: scan → hash-diff → chunk (LangChain) → embed → pgvector
 * + tsvector → graph wiring. Incremental by content hash; deleting .knode and
 * re-running rebuilds everything from the files.
 */

const ROOTS: { rel: string; root: DocRoot }[] = [
  { rel: 'raw/docs', root: 'docs' },
  { rel: 'raw/skills', root: 'skills' },
  { rel: 'wiki', root: 'wiki' },
];

const MAX_FILE_BYTES = 4 * 1024 * 1024;

export interface IngestOptions {
  /** Restrict ingest to paths starting with one of these prefixes. */
  only?: string[];
  /** Run the LLM entity-extraction pass on changed docs (default: true when llm configured). */
  llmGraph?: boolean;
  onProgress?: (msg: string) => void;
}

export async function runIngest(
  store: Store,
  config: KnodeConfig,
  embedder: EmbeddingProvider,
  llm: LlmClient,
  opts: IngestOptions = {},
): Promise<IngestStats> {
  const stats: IngestStats = { scanned: 0, indexed: 0, unchanged: 0, removed: 0, skipped: 0, errors: 0, chunks: 0, entities: 0, relations: 0 };
  const progress = opts.onProgress ?? (() => {});
  const seen = new Set<string>();
  const useLlm = (opts.llmGraph ?? true) && llm.enabled;

  // top-level anchor files are part of the wiki corpus
  const anchorFiles = ['purpose.md', 'schema.md'].filter((f) => fs.existsSync(safePath(store.dataDir, f)));

  for (const { rel, root } of ROOTS) {
    const files = walkFiles(store.dataDir, rel).concat(root === 'wiki' ? anchorFiles : []);
    for (const file of files) {
      if (opts.only && !opts.only.some((p) => file.startsWith(p))) continue;
      stats.scanned++;
      seen.add(file);
      try {
        const r = await ingestFile(store, config, embedder, llm, file, root, useLlm, progress);
        stats[r.outcome]++;
        stats.chunks += r.chunks;
        stats.entities += r.entities;
        stats.relations += r.relations;
      } catch (err) {
        stats.errors++;
        const msg = err instanceof Error ? err.message : String(err);
        progress(`error ${file}: ${msg}`);
        await store.query(
          `UPDATE documents SET status = 'error', error = $2, updated_at = now() WHERE path = $1`,
          [file, msg.slice(0, 500)],
        );
      }
    }
  }

  // remove rows for files that no longer exist
  if (!opts.only) {
    const known = await store.query<{ id: string; path: string }>(`SELECT id, path FROM documents WHERE root != 'traces'`);
    for (const row of known) {
      if (!seen.has(row.path)) {
        await clearDocumentGraph(store, row.id);
        await store.query(`DELETE FROM documents WHERE id = $1`, [row.id]);
        stats.removed++;
      }
    }
  }

  // NOTE: routine ingests are deliberately not written to wiki/log.md — the log
  // is itself indexed, so logging every ingest would make ingest never converge.
  return stats;
}

type FileOutcome = { outcome: 'indexed' | 'unchanged' | 'skipped'; chunks: number; entities: number; relations: number };

async function ingestFile(
  store: Store,
  config: KnodeConfig,
  embedder: EmbeddingProvider,
  llm: LlmClient,
  file: string,
  root: DocRoot,
  useLlm: boolean,
  progress: (msg: string) => void,
): Promise<FileOutcome> {
  const none = { chunks: 0, entities: 0, relations: 0 };
  const abs = safePath(store.dataDir, file);
  const stat = fs.statSync(abs);
  if (!isTextFile(file) || stat.size > MAX_FILE_BYTES) {
    await upsertDocument(store, file, root, '', stat.size, 'skipped', null);
    return { outcome: 'skipped', ...none };
  }

  const raw = fs.readFileSync(abs, 'utf8');
  const sha = crypto.createHash('sha256').update(raw).digest('hex');
  const docId = crypto.createHash('sha256').update(file).digest('hex').slice(0, 24);

  const existing = await store.query<DocumentRow>(`SELECT * FROM documents WHERE id = $1`, [docId]);
  if (existing[0] && existing[0].sha256 === sha && existing[0].status === 'indexed') {
    return { outcome: 'unchanged', ...none };
  }

  progress(`indexing ${file}`);
  const title = extractTitle(file, raw);
  await upsertDocument(store, file, root, sha, stat.size, 'pending', title);

  // replace chunks + derived graph facts
  await clearDocumentGraph(store, docId);
  await store.query(`DELETE FROM chunks WHERE document_id = $1`, [docId]);

  const body = stripFrontmatter(raw);
  const pieces = await chunkText(file, body, config.ingest);
  const chunkRows = pieces.map((p, i) => ({
    id: crypto.createHash('sha256').update(`${docId}|${i}|${p.content}`).digest('hex').slice(0, 32),
    seq: i,
    content: p.content,
    tokenCount: p.tokenCount,
  }));

  for (const c of chunkRows) {
    await store.query(
      `INSERT INTO chunks (id, document_id, seq, content, token_count, metadata, tsv)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, to_tsvector('simple', $4))`,
      [c.id, docId, c.seq, c.content, c.tokenCount, JSON.stringify({ path: file, title })],
    );
  }

  // embeddings
  const vectors = await embedder.embed(chunkRows.map((c) => c.content));
  for (let i = 0; i < chunkRows.length; i++) {
    await store.query(
      `INSERT INTO embeddings (chunk_id, model, embedding) VALUES ($1, $2, $3::vector)
       ON CONFLICT (chunk_id) DO UPDATE SET model = EXCLUDED.model, embedding = EXCLUDED.embedding`,
      [chunkRows[i].id, embedder.model, toVectorLiteral(vectors[i])],
    );
  }

  // graph wiring
  const page = { documentId: docId, path: file, title: title ?? path.basename(file), chunkIds: chunkRows.map((c) => ({ id: c.id, content: c.content })) };
  let g = await wireFromMarkdown(store, page, raw);
  if (useLlm && root === 'docs') {
    try {
      const lg = await extractWithLlm(store, llm, page, body);
      g = { entities: g.entities + lg.entities, relations: g.relations + lg.relations };
    } catch (err) {
      progress(`llm extraction failed for ${file}: ${err instanceof Error ? err.message : err}`);
    }
  }

  await store.query(`UPDATE documents SET status = 'indexed', error = NULL, updated_at = now() WHERE id = $1`, [docId]);
  return { outcome: 'indexed', chunks: chunkRows.length, entities: g.entities, relations: g.relations };
}

async function upsertDocument(
  store: Store,
  file: string,
  root: DocRoot,
  sha: string,
  bytes: number,
  status: string,
  title: string | null,
): Promise<void> {
  const docId = crypto.createHash('sha256').update(file).digest('hex').slice(0, 24);
  const mime = guessMime(file);
  await store.query(
    `INSERT INTO documents (id, path, root, title, sha256, mime, bytes, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title, sha256 = EXCLUDED.sha256, bytes = EXCLUDED.bytes,
       status = EXCLUDED.status, updated_at = now()`,
    [docId, file, root, title, sha, mime, bytes, status],
  );
}

function stripFrontmatter(raw: string): string {
  try {
    return matter(raw).content;
  } catch {
    return raw;
  }
}

function extractTitle(file: string, raw: string): string | null {
  try {
    const fm = matter(raw).data as Record<string, unknown>;
    if (typeof fm.title === 'string' && fm.title.trim()) return fm.title.trim();
  } catch {
    /* fall through */
  }
  const h1 = raw.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return path.basename(file).replace(/\.[^.]+$/, '');
}

function guessMime(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
    '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain',
    '.json': 'application/json', '.jsonl': 'application/jsonl', '.yaml': 'text/yaml',
    '.yml': 'text/yaml', '.csv': 'text/csv', '.html': 'text/html', '.pdf': 'application/pdf',
  };
  return map[ext] ?? 'application/octet-stream';
}
