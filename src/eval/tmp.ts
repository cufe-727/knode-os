import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The temp directories a run makes — staged corpora, agents' copies, a Codex
 * call's directory — named for the process that made them
 * (`knode-eval-<kind>-<pid>-XXXXXX`), since an agent's directory must hold
 * nothing but what it is given. Each is removed when its work is done; a run
 * stopped by a signal removes those it still holds, and every run starts by
 * removing those of processes that are gone, so a killed run leaves them only
 * until the next one.
 */

const held = new Set<string>();

export function evalTempDir(kind: string): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `knode-eval-${kind}-${process.pid}-`));
  held.add(root);
  return {
    root,
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
      held.delete(root);
    },
  };
}

/** Remove every temp directory this process still holds. */
export function removeHeldTempDirs(): void {
  for (const root of held) fs.rmSync(root, { recursive: true, force: true });
  held.clear();
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: alive, someone else's
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Remove the temp directories of processes that are gone. Returns how many. */
export function sweepStaleTempDirs(dir = os.tmpdir()): number {
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    const m = /^knode-eval-[a-z]+(?:-[a-z]+)*-(\d+)-[A-Za-z0-9]{6}$/.exec(name);
    if (!m || alive(Number(m[1]))) continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}
