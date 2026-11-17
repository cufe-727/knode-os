import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Gold, holdout and task files never enter a build's workspace (docs/design/35
 * D7): the agent arms read that folder, and a gold file in it would hand them
 * the answers. A run copies only the staged corpus there; this check is what
 * holds it to that, after staging and after every update batch.
 *
 * A file of the workspace leaks when its content is byte for byte a file
 * under the pack's `gold/`, `holdout/` or `tasks/`. Sizes are compared first
 * (a stat each), so a workspace of many gigabytes is walked, not read: only a
 * file as long as some gold file is hashed.
 */

export const GUARDED_PACK_DIRS = ['gold', 'holdout', 'tasks'] as const;

export interface Leak {
  /** The workspace file, relative to the workspace. */
  file: string;
  /** The pack file it repeats, relative to the pack. */
  matches: string;
}

const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Every regular file under `dir`, relative to it; symbolic links are not followed. */
function* walk(dir: string, rel = ''): Generator<{ rel: string; abs: string; size: number }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) yield* walk(dir, r);
    else if (e.isFile()) {
      const abs = path.join(dir, r);
      try {
        yield { rel: r, abs, size: fs.statSync(abs).size };
      } catch {
        // gone meanwhile
      }
    }
  }
}

/** The files of `ws` whose content is a gold, holdout or task file of the pack at `packDir`. */
export function leakedFiles(ws: string, packDir: string): Leak[] {
  // pack files by size; hashed only when a workspace file of that size turns up
  const guarded = new Map<number, { rel: string; abs: string; hash?: string }[]>();
  for (const sub of GUARDED_PACK_DIRS) {
    for (const f of walk(path.join(packDir, sub))) {
      // an empty file is no content to leak
      if (f.size === 0) continue;
      (guarded.get(f.size) ?? guarded.set(f.size, []).get(f.size)!).push({ rel: `${sub}/${f.rel}`, abs: f.abs });
    }
  }
  if (!guarded.size) return [];
  const leaks: Leak[] = [];
  for (const f of walk(ws)) {
    const same = guarded.get(f.size);
    if (!same) continue;
    const hash = sha256(f.abs);
    for (const g of same) {
      g.hash ??= sha256(g.abs);
      if (g.hash === hash) {
        leaks.push({ file: f.rel, matches: g.rel });
        break;
      }
    }
  }
  return leaks;
}

/** Throw when the workspace holds a gold, holdout or task file of the pack: the build or batch fails. */
export function assertNoLeak(ws: string, packDir: string, when: string): void {
  const leaks = leakedFiles(ws, packDir);
  if (!leaks.length) return;
  const shown = leaks.slice(0, 5).map((l) => `${l.file} (= ${l.matches})`).join(', ');
  throw new Error(`gold leaked into the workspace ${when} (docs/design/35 D7): ${leaks.length} file(s) are the pack's own gold, holdout or task files: ${shown}${leaks.length > 5 ? ', …' : ''}`);
}
