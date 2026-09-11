/**
 * Ingestion entry points. The pipeline is now the lineage-aware `sync`
 * (declared-vs-running reconciliation) with `applyDocScope` as the per-file
 * applier; this module re-exports them for existing imports.
 */
export { runIngest, sync, type IngestOptions, type SyncOptions, type SyncStats, type SyncContext } from './sync.js';
export { applyDocScope, documentIdFor, chunkIdFor } from './apply.js';
