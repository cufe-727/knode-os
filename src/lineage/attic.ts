import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readSidecar, Sidecar } from '../fs/sidecar.js';
import { safePath } from '../fs/files.js';

/**
 * The attic keeps what a dispose would otherwise destroy but a later rebuild
 * or restore may need: the sidecar of a removed document (paid LLM
 * extraction) and the previous bytes of files a scope overwrote. `purge`
 * deletes attic entries; nothing else does.
 */

const ATTIC_DIR = 'ledger/attic';

export function atticSidecarRel(scopeId: string): string {
  return `${ATTIC_DIR}/${scopeId}.knode.json`;
}

export function moveSidecarToAttic(dataDir: string, cookedRel: string, scopeId: string): boolean {
  const src = safePath(dataDir, `${cookedRel}.knode.json`);
  if (!fs.existsSync(src)) return false;
  const dst = safePath(dataDir, atticSidecarRel(scopeId));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst);
  return true;
}

export function readAtticSidecar(dataDir: string, scopeId: string): Sidecar | null {
  const abs = safePath(dataDir, atticSidecarRel(scopeId));
  if (!fs.existsSync(abs)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf8')) as Sidecar;
    return parsed?.version === 1 && parsed.meta ? parsed : null;
  } catch {
    return null;
  }
}

export function removeAtticSidecar(dataDir: string, scopeId: string): void {
  fs.rmSync(safePath(dataDir, atticSidecarRel(scopeId)), { force: true });
}

/** Content-addressed blob store for previous file versions. Returns the blob id. */
export function storeBlob(dataDir: string, content: string): string {
  const sha = crypto.createHash('sha256').update(content).digest('hex');
  const abs = safePath(dataDir, `${ATTIC_DIR}/blobs/${sha}`);
  if (!fs.existsSync(abs)) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return sha;
}

export function readBlob(dataDir: string, sha: string): string | null {
  const abs = safePath(dataDir, `${ATTIC_DIR}/blobs/${sha}`);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
}

export function removeBlob(dataDir: string, sha: string): void {
  fs.rmSync(safePath(dataDir, `${ATTIC_DIR}/blobs/${sha}`), { force: true });
}

/** Sidecar of a live cooked document, or null. Re-exported for rebuild convenience. */
export function liveSidecar(dataDir: string, cookedRel: string): Sidecar | null {
  return readSidecar(dataDir, cookedRel);
}
