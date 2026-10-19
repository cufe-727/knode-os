import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { safePath } from '../fs/files.js';
import { ATTIC_DIR } from '../fs/layout.js';
import { hasSidecar, readSidecarFromDir, Sidecar, sidecarDir } from '../fs/sidecar.js';

/**
 * The attic keeps what a dispose would otherwise destroy but a later rebuild
 * or restore may need: the sidecar directory of a removed document (paid LLM
 * extraction, usage history) and the previous bytes of files a scope
 * overwrote. `purge` deletes attic entries; nothing else does.
 */

/** Attic location of a disposed scope's sidecar directory. */
export function atticSidecarRel(scopeId: string): string {
  return `${ATTIC_DIR}/${scopeId}`;
}

/** Move a source's whole sidecar directory into the attic. */
export function moveSidecarToAttic(dataDir: string, key: string, scopeId: string): boolean {
  if (!hasSidecar(dataDir, key)) return false;
  const dst = safePath(dataDir, atticSidecarRel(scopeId));
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(sidecarDir(dataDir, key), dst);
  return true;
}

export function hasAtticSidecar(dataDir: string, scopeId: string): boolean {
  return fs.existsSync(safePath(dataDir, atticSidecarRel(scopeId)));
}

export function readAtticSidecar(dataDir: string, scopeId: string): Sidecar | null {
  return readSidecarFromDir(safePath(dataDir, atticSidecarRel(scopeId)));
}

export function removeAtticSidecar(dataDir: string, scopeId: string): void {
  fs.rmSync(safePath(dataDir, atticSidecarRel(scopeId)), { recursive: true, force: true });
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
