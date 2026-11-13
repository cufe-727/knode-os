import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Where a run's model work goes, carried along its async calls
 * (docs/design/27 §8).
 *
 * - `withRemote(remote, fn)`: a pack's work may be offered to remote workers
 *   (`remote` set) or must stay here (null: a private pack, or no `--remote`).
 *   `runAgent` reads it, since a system calls it with no word of its pack.
 * - `capturePlacements(fn)`: who answered the model calls made inside `fn`,
 *   for a caller that only gets text back (the judge's client).
 */

export interface Placement {
  /** The remote worker that answered; absent = this machine. */
  worker?: string;
  /** The CLI and model it ran on, as records keep it: `codex-cli:<model>`. */
  backend: string;
}

const remoteScope = new AsyncLocalStorage<unknown>();
const captured = new AsyncLocalStorage<Placement[]>();

export function withRemote<R, T>(remote: R | null, fn: () => Promise<T>): Promise<T> {
  return remoteScope.run(remote, fn);
}

export function currentRemote<R>(): R | null {
  return (remoteScope.getStore() as R | undefined) ?? null;
}

export function notePlacement(p: Placement): void {
  captured.getStore()?.push(p);
}

export async function capturePlacements<T>(fn: () => Promise<T>): Promise<{ value: T; placements: Placement[] }> {
  const placements: Placement[] = [];
  const value = await captured.run(placements, fn);
  return { value, placements };
}

/** The last placement noted inside a failed call too: `capturePlacements` with the error passed through. */
export async function captureEither<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; placements: Placement[] }> {
  const placements: Placement[] = [];
  try {
    const value = await captured.run(placements, fn);
    return { value, placements };
  } catch (error) {
    return { error, placements };
  }
}
