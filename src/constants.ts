/** Shared size limits — single source of truth for the pipeline and LLM calls. */

/** Files larger than this are skipped by cook and ingest. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Binary originals may be larger; their normalized Markdown is still bounded by MAX_FILE_BYTES at ingest. */
export const MAX_CONVERTIBLE_FILE_BYTES = 50 * 1024 * 1024;

/**
 * One tier-1 extraction call reads at most this much text when no segment
 * size is given (bench runs); the background pass cuts longer documents into
 * `extraction.segmentChars` segments instead (src/graph/segment.ts).
 */
export const LLM_EXTRACT_INPUT_CHARS = 12_000;

/**
 * Before segmented extraction a tier-1 call read only this much of a
 * document, so a sidecar written then (no `segmenter`) covers the whole
 * document only when it was no longer than this.
 */
export const LEGACY_EXTRACT_CHARS = 12_000;

/** Version of the segment cutter; a tier-1 sidecar that carries it covers the whole document. */
export const SEGMENTER_VERSION = 1;

/** Document text sent to wiki source-page summarization is truncated here. */
export const LLM_WIKI_INPUT_CHARS = 14_000;

/** Per-chunk text sent to the embeddings endpoint is truncated here. */
export const EMBED_INPUT_CHARS = 8_000;

/** Preview reads (`GET /api/file`) stop here; larger files come back truncated and read-only. */
export const MAX_PREVIEW_BYTES = 256 * 1024;
