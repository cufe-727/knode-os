/** Shared size limits — single source of truth for the pipeline and LLM calls. */

/** Files larger than this are skipped by cook and ingest. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Binary originals may be larger; their normalized Markdown is still bounded by MAX_FILE_BYTES at ingest. */
export const MAX_CONVERTIBLE_FILE_BYTES = 50 * 1024 * 1024;

/** Document text sent to tier-1 entity/relation extraction is truncated here. */
export const LLM_EXTRACT_INPUT_CHARS = 12_000;

/** Document text sent to wiki source-page summarization is truncated here. */
export const LLM_WIKI_INPUT_CHARS = 14_000;

/** Per-chunk text sent to the embeddings endpoint is truncated here. */
export const EMBED_INPUT_CHARS = 8_000;

/** Preview reads (`GET /api/file`) stop here; larger files come back truncated and read-only. */
export const MAX_PREVIEW_BYTES = 256 * 1024;
