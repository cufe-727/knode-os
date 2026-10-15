/**
 * Documents an extraction run holds right now, per data dir.
 *
 * Two things take documents off the extraction queue inside one process: the
 * batch pass (`runTier1Pass` — `knode-os extract`, an initialization draining
 * the queue) and the labeling scheduler `serve` runs (src/labeling). Each
 * claims a document before planning it and skips one the other holds, so no
 * segment is extracted twice and no sidecar is written from two places.
 */

const held = new Map<string, Map<string, string>>();

function holdersOf(dataDir: string): Map<string, string> {
  let docs = held.get(dataDir);
  if (!docs) {
    docs = new Map();
    held.set(dataDir, docs);
  }
  return docs;
}

/** Take a document for `owner`. False when another owner holds it; true again for the same owner. */
export function claimDocument(dataDir: string, documentId: string, owner: string): boolean {
  const docs = holdersOf(dataDir);
  const current = docs.get(documentId);
  if (current && current !== owner) return false;
  docs.set(documentId, owner);
  return true;
}

/** Give a document back. Only its holder can. */
export function releaseDocument(dataDir: string, documentId: string, owner: string): void {
  const docs = held.get(dataDir);
  if (docs?.get(documentId) === owner) docs.delete(documentId);
}

/** Every document held in this data dir, by any owner. */
export function heldDocuments(dataDir: string): string[] {
  return [...(held.get(dataDir)?.keys() ?? [])];
}

export function isDocumentHeld(dataDir: string, documentId: string): boolean {
  return held.get(dataDir)?.has(documentId) ?? false;
}
