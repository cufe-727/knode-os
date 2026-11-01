import { DocRoot } from '../types.js';
import { loadSourceText, sha256 } from './source.js';

/**
 * Files this process wrote and then indexed itself — a regenerated wiki page,
 * the managed region kept in a person's page — with the hash of the text it
 * indexed. The data-dir watcher reports those writes like anyone else's, and
 * a sync of them only finds the document unchanged; but every sync costs a
 * walk, the live-scope and orphan reads and a check of every page file, and
 * on a large workspace each small sync regenerated the index pages, whose
 * write the watcher then synced again (src/server/serve.ts).
 *
 * A path counts as an own write only while its indexed text is still exactly
 * what was noted: a person's edit since — or the file gone — makes it an
 * ordinary change again, and the note is dropped. One map per data dir, in
 * memory, like the activity log.
 */

/** Notes kept per data dir; the oldest go first past this. */
const MAX_NOTES = 20_000;

const notes = new Map<string, Map<string, { root: DocRoot; sha: string }>>();

/** Note that `rel` was written and indexed by this process, its indexed text hashing to `sha`. */
export function noteOwnWrite(dataDir: string, rel: string, root: DocRoot, sha: string): void {
  let byPath = notes.get(dataDir);
  if (!byPath) {
    byPath = new Map();
    notes.set(dataDir, byPath);
  }
  byPath.delete(rel);
  byPath.set(rel, { root, sha });
  if (byPath.size > MAX_NOTES) byPath.delete(byPath.keys().next().value!);
}

/** Whether `rel` holds what this process last wrote and indexed there: a sync of it would find nothing to do. */
export function isOwnWrite(dataDir: string, rel: string): boolean {
  const byPath = notes.get(dataDir);
  const note = byPath?.get(rel);
  if (!byPath || !note) return false;
  let current: string | null = null;
  try {
    const source = loadSourceText(dataDir, rel, note.root);
    current = source ? sha256(source.text) : null;
  } catch {
    current = null;
  }
  if (current === note.sha) return true;
  byPath.delete(rel);
  return false;
}
