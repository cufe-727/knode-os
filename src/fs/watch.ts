import fs from 'node:fs';
import path from 'node:path';

/**
 * One watcher for a whole directory tree: `fs.watch` in recursive mode —
 * FSEvents on macOS, inotify on Linux, ReadDirectoryChangesW on Windows.
 *
 * chokidar watches every file on its own, and on macOS each of those watches
 * holds a file descriptor. A workspace with a mirrored export of tens of
 * thousands of files then pushes the descriptors of every new pipe past
 * OPEN_MAX (10240), where posix_spawn rejects them with EBADF: no CLI agent
 * (Codex, Claude Code, Cursor) can be started any more, in any workspace of
 * the process. This holds one handle per tree, whatever its size.
 *
 * It reports paths, not event kinds: a caller stats or re-walks to learn what
 * happened. An event the OS could not attribute to a path reports the root.
 *
 * Nothing is reported until a moment after this returns (FSEvents opens its
 * stream on another thread), and opening or closing a watcher blinds the
 * others in the process for that moment too (libuv runs them all on one
 * stream, rebuilt on each open and close). A caller that must not miss a
 * change re-walks once the watch is up, and again after `onBlinded`.
 */
export interface TreeWatcher {
  close(): void;
}

export interface WatchTreeOptions {
  /** Drop a path (posix, relative to the root) before it is reported. */
  ignore?: (rel: string) => boolean;
  onError?: (err: Error) => void;
  /**
   * Another watcher of this process opened or closed, so a change made here
   * in that moment may never be reported. Called inside that open or close:
   * keep it cheap, and look again a while later, once the stream is back.
   */
  onBlinded?: () => void;
}

/** The watchers this process has open, as told when another one opens or closes. */
const openWatchers = new Set<{ onBlinded?: () => void }>();

function blindOthers(self: { onBlinded?: () => void }): void {
  for (const other of [...openWatchers]) if (other !== self) other.onBlinded?.();
}

/** Throws when `root` cannot be watched (missing, not a directory). */
export function watchTree(root: string, onPath: (abs: string, rel: string) => void, opts: WatchTreeOptions = {}): TreeWatcher {
  const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
    const rel = filename ? String(filename).split(path.sep).join('/') : '';
    if (rel && opts.ignore?.(rel)) return;
    onPath(rel ? path.join(root, rel) : root, rel);
  });
  const self = { onBlinded: opts.onBlinded };
  watcher.on('error', (err) => {
    // node has closed the handle by now
    if (openWatchers.delete(self)) blindOthers(self);
    opts.onError?.(err);
  });
  openWatchers.add(self);
  blindOthers(self);
  return {
    close: () => {
      if (!openWatchers.delete(self)) return;
      watcher.close();
      blindOthers(self);
    },
  };
}
