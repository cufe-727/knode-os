import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_CONVERTIBLE_FILE_BYTES, MAX_FILE_BYTES } from '../constants.js';
import { isTextFile, safePath, walkFiles } from '../fs/files.js';
import { emptyUsage, readSidecar, Sidecar, writeSidecar } from '../fs/sidecar.js';
import { Store } from '../store/db.js';
import {
  ConversionOptions,
  conversionCacheKey,
  convertDocumentToMarkdown,
  convertedPathForRaw,
  isConvertibleFile,
} from './convert.js';

/**
 * Cooking — the raw → cooked normalization step (L0 → L1).
 *
 * Every text document under raw/docs gets a normalized copy under cooked/docs
 * plus a `.knode.json` sidecar holding metadata, extraction results and usage
 * stats. raw/ stays byte-identical to what the user uploaded; cooked/ is the
 * system-managed layer the sync pipeline actually indexes.
 *
 * Text is copied as UTF-8. PDFs are converted with local text extraction plus
 * vision fallback for scanned pages; images are transcribed by the configured
 * document-vision route. Unsupported and oversized files are skipped.
 *
 * Cooking only creates and updates. Removal of cooked files whose raw source
 * disappeared is a *dispose* of the document's scope (src/ingest/sync.ts), so
 * the paid extraction in the sidecar moves to the attic instead of vanishing.
 */

const RAW_DOCS = 'raw/docs';
const COOKED_DOCS = 'cooked/docs';

export interface CookStats {
  cooked: number;
  unchanged: number;
  removed: number;
  skipped: number;
  errors: number;
  /** Derived paths excluded from this ingest because their latest conversion failed. */
  failed: string[];
  /** Cooked paths whose raw original exists — the declared document set. */
  wanted: string[];
}

export interface CookOptions extends ConversionOptions {
  onProgress?: (message: string) => void;
}

export function rawToCookedPath(rawRel: string): string {
  const sameExtensionPath = COOKED_DOCS + rawRel.slice(RAW_DOCS.length);
  return convertedPathForRaw(sameExtensionPath);
}

export function cookedRoot(): string {
  return COOKED_DOCS;
}

function sha256(content: string | Uint8Array): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export async function cookDocs(dataDir: string, _store?: Store, opts: CookOptions = {}): Promise<CookStats> {
  const stats: CookStats = { cooked: 0, unchanged: 0, removed: 0, skipped: 0, errors: 0, failed: [], wanted: [] };
  const wanted = new Set<string>();
  const progress = opts.onProgress ?? (() => {});

  for (const rawRel of walkFiles(dataDir, RAW_DOCS)) {
    const abs = safePath(dataDir, rawRel);
    const st = fs.statSync(abs);
    const text = isTextFile(rawRel);
    const convertible = isConvertibleFile(rawRel);
    const maxBytes = convertible ? MAX_CONVERTIBLE_FILE_BYTES : MAX_FILE_BYTES;
    if ((!text && !convertible) || st.size > maxBytes) {
      stats.skipped++;
      continue;
    }
    const cookedRel = rawToCookedPath(rawRel);
    wanted.add(cookedRel);

    const sourceBytes = fs.readFileSync(abs);
    const sourceSha = sha256(sourceBytes);
    const existing = readSidecar(dataDir, cookedRel);
    const cookedAbs = safePath(dataDir, cookedRel);
    const cacheKey = convertible ? conversionCacheKey(opts) : undefined;
    const existingSourceSha = existing?.meta.sourceSha256 ?? existing?.meta.sha256;
    const cacheMatches = !convertible || existing?.meta.conversionKey === cacheKey;
    if (existing && existingSourceSha === sourceSha && cacheMatches && fs.existsSync(cookedAbs)) {
      stats.unchanged++;
      continue;
    }

    let content: string;
    let conversion: Sidecar['meta']['conversion'];
    try {
      if (convertible) {
        progress(`converting ${rawRel}`);
        const result = await convertDocumentToMarkdown(abs, rawRel, opts);
        content = result.markdown;
        conversion = { kind: result.kind, model: result.model, warnings: result.warnings.length ? result.warnings : undefined };
      } else {
        content = sourceBytes.toString('utf8');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stats.errors++;
      stats.failed.push(cookedRel);
      progress(`conversion error ${rawRel}: ${message}`);
      continue;
    }

    const cookedSha = sha256(content);
    fs.mkdirSync(path.dirname(cookedAbs), { recursive: true });
    const temp = `${cookedAbs}.tmp`;
    fs.writeFileSync(temp, content);
    fs.renameSync(temp, cookedAbs);

    const now = new Date().toISOString();
    const sidecar: Sidecar = {
      version: 1,
      meta: {
        sha256: cookedSha,
        sourceSha256: sourceSha,
        title: existing?.meta.title ?? null,
        sourceType: path.extname(rawRel).replace(/^\./, '') || 'txt',
        rawPath: rawRel,
        conversionKey: cacheKey,
        conversion,
        ingestedAt: now,
        chunks: [],
      },
      // keep prior extraction — tier1 replay is gated by contentSha, so stale
      // results are ignored automatically after a content change
      extraction: existing?.extraction ?? {},
      usage: existing?.usage ?? emptyUsage(now),
      views: existing?.views,
    };
    writeSidecar(dataDir, cookedRel, sidecar);
    stats.cooked++;
  }

  stats.wanted = [...wanted];
  return stats;
}
