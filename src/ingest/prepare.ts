import fs from 'node:fs';
import path from 'node:path';
import { MAX_FILE_BYTES } from '../constants.js';
import { isTextFile, safePath, walkFilesUnder } from '../fs/files.js';
import { RAW_DOCS } from '../fs/layout.js';
import { hasContent, readContent, readSidecarPart, SidecarConversion, writeContent, writeSidecarPart } from '../fs/sidecar.js';
import { NORMALIZER_VERSION, normalizeCookedFrontmatter } from '../okf/normalize.js';
import {
  ConversionOptions,
  conversionCacheKey,
  conversionVariant,
  convertDocumentToMarkdown,
  convertedPathForRaw,
  isConvertibleFile,
  maxConvertibleBytes,
  originalOfTranscript,
  transcriptCacheKey,
  transcriptPathFor,
  transcriptToMarkdown,
} from './convert.js';
import { pool } from '../pool.js';
import { loadSourceText, sha256, sha256File } from './source.js';

/**
 * Prepare — the raw → derived step that runs before every sync touching
 * `raw/docs`. For each supported original it makes sure the sidecar's
 * `meta.json` describes the text that will be indexed:
 *
 *   - text files are never copied; their normalized text is hashed in memory
 *     (see src/ingest/source.ts) and only the hash is recorded;
 *   - PDFs and images are converted to Markdown once (`content.md`), with a
 *     vision-model fallback for pages without text; the conversion cache key
 *     (converter version + model + limits) decides when a redo is due.
 *
 * Unchanged means: same raw bytes, same normalizer version and, for converted
 * sources, same conversion key with the `content.md` still present. A failed
 * conversion keeps the previous state and is reported so sync leaves the
 * document's live scope alone.
 *
 * Only `meta.json` is written here. Tier-0/1 results, usage and cached views
 * are separate files that survive a re-prepare (tier-1 replay is gated by
 * `contentSha`, so a stale extraction is ignored automatically).
 */

export interface PrepareStats {
  prepared: number;
  unchanged: number;
  skipped: number;
  errors: number;
}

export interface PrepareResult {
  stats: PrepareStats;
  /** Every declared source under raw/docs → sha256 of its indexed text. */
  wanted: Map<string, string>;
  /** Sources whose conversion failed this run — sync keeps their last good state. */
  failed: Set<string>;
}

export interface PrepareOptions extends ConversionOptions {
  onProgress?: (message: string) => void;
  /**
   * Conversions in flight at once. Each one is a vision call or more, so this
   * is the Convert stage's rate against the document model. Default 1, which
   * is also the order the progress messages come out in.
   */
  concurrency?: number;
  /** Test hook: pretend the normalizer is at this version. */
  normalizerVersion?: number;
  /**
   * Prepare only the sources under these keys — a scoped sync (a watcher
   * event, one linked folder's changes). Default: all of raw/docs. Keys are
   * normalized the way `sync` normalizes `only`.
   */
  prefixes?: string[];
}

/**
 * The raw/docs sources a prepare pass looks at. Without prefixes, all of
 * them; with prefixes, only what sits under one — a prefix above raw/docs
 * covers it whole, a directory is walked, a file is taken as it is. A key
 * that no longer exists has nothing to prepare (sync disposes it), and a
 * hidden path is never a source.
 */
export function rawDocsUnder(dataDir: string, prefixes: string[] | undefined): string[] {
  return walkFilesUnder(dataDir, RAW_DOCS, prefixes);
}

function isFile(dataDir: string, rel: string): boolean {
  try {
    return fs.statSync(safePath(dataDir, rel)).isFile();
  } catch {
    return false;
  }
}

function producedBy(conversion: SidecarConversion | undefined): string | undefined {
  // a transcript is its author's, whoever that was: knode-os produced none of it
  if (conversion?.kind === 'transcript') return undefined;
  return conversion ? `knode-os/${conversion.model || conversion.kind}` : undefined;
}

export async function prepareDocs(dataDir: string, opts: PrepareOptions = {}): Promise<PrepareResult> {
  const stats: PrepareStats = { prepared: 0, unchanged: 0, skipped: 0, errors: 0 };
  const wanted = new Map<string, string>();
  const failed = new Set<string>();
  const progress = opts.onProgress ?? (() => {});
  const normalizer = opts.normalizerVersion ?? NORMALIZER_VERSION;

  // The whole per-file job, so the pool below can hold several conversions
  // open at once. Sharing the counters is safe: each `stats.x++` is a
  // read-modify-write with no await between the halves, which on the single JS
  // thread makes it atomic, and every sidecar write is keyed by its own
  // rawRel, so two workers never touch one file.
  const prepareOne = async (rawRel: string): Promise<void> => {
    const abs = safePath(dataDir, rawRel);
    const st = fs.statSync(abs);
    // a reviewed transcript is its original's text (prepared with it below), not a document of its own
    const original = originalOfTranscript(rawRel);
    if (original && isFile(dataDir, original)) return;
    const text = isTextFile(rawRel);
    const convertible = isConvertibleFile(rawRel);
    const maxBytes = convertible ? maxConvertibleBytes(rawRel) : MAX_FILE_BYTES;
    if ((!text && !convertible) || st.size > maxBytes) {
      stats.skipped++;
      return;
    }

    const sourceSha = sha256File(abs);
    const meta = readSidecarPart(dataDir, rawRel, 'meta');
    const transcriptRel = convertible ? transcriptPathFor(rawRel) : null;
    const transcript = transcriptRel && isFile(dataDir, transcriptRel) ? fs.readFileSync(safePath(dataDir, transcriptRel)) : null;
    const variant = convertible && !transcript ? await conversionVariant(abs, rawRel, opts) : null;
    const cacheKey = convertible ? (transcript ? transcriptCacheKey(transcript) : conversionCacheKey(opts, rawRel, variant)) : undefined;
    const sameSource = meta !== null && meta.sourceSha256 === sourceSha;
    const sameConversion = !convertible || (meta?.conversion?.key === cacheKey && hasContent(dataDir, rawRel));

    if (meta && sameSource && sameConversion && meta.normalizer === normalizer) {
      // a sidecar moved along with its file keeps everything but its rawPath
      if (meta.rawPath !== rawRel) writeSidecarPart(dataDir, rawRel, 'meta', { ...meta, rawPath: rawRel });
      if (meta.contentBytes > MAX_FILE_BYTES) {
        stats.skipped++;
        return;
      }
      stats.unchanged++;
      wanted.set(rawRel, meta.contentSha256);
      return;
    }

    let content: string;
    let conversion: SidecarConversion | undefined;
    try {
      if (convertible) {
        // the normalizer keys on the .md extension, so converted Markdown is
        // normalized under its virtual `<raw>.md` name; the raw mtime dates
        // the copy knode-os produced (idempotent for unchanged bytes)
        const normalizeAs = convertedPathForRaw(rawRel);
        const at = st.mtime.toISOString();
        if (meta && sameSource && sameConversion) {
          // only the normalizer changed: re-normalize the existing conversion, never re-convert
          conversion = meta.conversion;
          content = normalizeCookedFrontmatter(normalizeAs, readContent(dataDir, rawRel) ?? '', { producedBy: producedBy(conversion), at });
        } else if (transcript && transcriptRel) {
          // its author's text: never attributed to knode-os, and read with no model
          const result = transcriptToMarkdown(rawRel, transcriptRel, transcript.toString('utf8'));
          conversion = { key: cacheKey!, kind: result.kind, model: result.model };
          content = normalizeCookedFrontmatter(normalizeAs, result.markdown, { at });
        } else {
          progress(`converting ${rawRel}`);
          const result = await convertDocumentToMarkdown(abs, rawRel, opts);
          conversion = { key: cacheKey!, kind: result.kind, model: result.model, warnings: result.warnings.length ? result.warnings : undefined };
          content = normalizeCookedFrontmatter(normalizeAs, result.markdown, { producedBy: producedBy(conversion), at });
        }
        writeContent(dataDir, rawRel, content);
      } else {
        content = loadSourceText(dataDir, rawRel, 'docs')?.text ?? '';
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stats.errors++;
      failed.add(rawRel);
      progress(`conversion error ${rawRel}: ${message}`);
      return;
    }

    const contentSha = sha256(content);
    const contentBytes = Buffer.byteLength(content);
    writeSidecarPart(dataDir, rawRel, 'meta', {
      version: 2,
      rawPath: rawRel,
      sourceType: path.extname(rawRel).replace(/^\./, '') || 'txt',
      sourceSha256: sourceSha,
      contentSha256: contentSha,
      contentBytes,
      normalizer,
      conversion,
      title: meta?.title ?? null,
      ingestedAt: new Date().toISOString(),
      chunks: [],
    });
    if (contentBytes > MAX_FILE_BYTES) {
      stats.skipped++; // converted text too large to index; the conversion is kept so it is not paid again
      return;
    }
    wanted.set(rawRel, contentSha);
    stats.prepared++;
  };

  // Drained first: walkFiles is a generator, and pooled workers would race it.
  const raws = rawDocsUnder(dataDir, opts.prefixes);
  await pool(raws, Math.max(1, opts.concurrency ?? 1), prepareOne);

  return { stats, wanted, failed };
}
