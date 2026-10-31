/**
 * What a workspace is doing in the background right now, for the Tasks view
 * (GET /api/tasks): a sync the watcher started, an upload being indexed, the
 * nightly Dream, a linked folder catching up. Leased model work — extraction,
 * summaries, translations, judge calls — reports itself through the work
 * broker (src/work/broker.ts); this covers everything else that runs without
 * anyone waiting on a reply.
 *
 * One log per data dir, in memory: a restart begins a new one, the way the
 * processing switch and the broker's counters do. It is only a view — nothing
 * reads it to decide what runs.
 */

export type ActivityKind = 'sync' | 'ingest' | 'upload' | 'folder' | 'traces' | 'datasources' | 'dream' | 'tier2';

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  /** What it is, for a person: "Watch sync of raw/docs/a.md", "Nightly Dream". */
  label: string;
  startedAt: string;
  finishedAt?: string;
  ok?: boolean;
  /** One line on how it went: counts on success, the message on failure. */
  detail?: string;
}

/** Finished items kept for the Tasks view. */
const RECENT = 30;

export class ActivityLog {
  private readonly active = new Map<string, ActivityItem>();
  private readonly finished: ActivityItem[] = [];
  private seq = 0;

  /** Note something starting; the returned function ends it. */
  begin(kind: ActivityKind, label: string): (end?: { ok?: boolean; detail?: string }) => void {
    const id = `${kind}-${Date.now().toString(36)}-${(this.seq++).toString(36)}`;
    const item: ActivityItem = { id, kind, label, startedAt: new Date().toISOString() };
    this.active.set(id, item);
    let ended = false;
    return (end = {}) => {
      if (ended) return;
      ended = true;
      this.active.delete(id);
      this.finished.unshift({ ...item, finishedAt: new Date().toISOString(), ok: end.ok ?? true, ...(end.detail ? { detail: end.detail } : {}) });
      this.finished.length = Math.min(this.finished.length, RECENT);
    };
  }

  /** Run `fn` as an activity: ended when it settles, with `describe`'s line on success and the error's on failure. */
  async run<T>(kind: ActivityKind, label: string, fn: () => Promise<T>, describe?: (result: T) => string | null | undefined): Promise<T> {
    const end = this.begin(kind, label);
    try {
      const result = await fn();
      end({ ok: true, detail: describe?.(result) ?? undefined });
      return result;
    } catch (err) {
      end({ ok: false, detail: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  /** Whether something of this kind is running now. */
  busy(kind: ActivityKind): boolean {
    for (const item of this.active.values()) if (item.kind === kind) return true;
    return false;
  }

  snapshot(): { running: ActivityItem[]; recent: ActivityItem[] } {
    return {
      running: [...this.active.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
      recent: this.finished.map((item) => ({ ...item })),
    };
  }
}

const logs = new Map<string, ActivityLog>();

/** The activity log of the workspace at `dataDir`, made on first use. */
export function activityOf(dataDir: string): ActivityLog {
  let log = logs.get(dataDir);
  if (!log) {
    log = new ActivityLog();
    logs.set(dataDir, log);
  }
  return log;
}

/** Short label for a set of sync prefixes: "raw/docs/a.md", "raw/docs and 3 more", "everything". */
export function scopeLabel(only: string[] | undefined): string {
  if (!only || only.length === 0) return 'everything';
  return only.length === 1 ? only[0] : `${only[0]} and ${only.length - 1} more`;
}

/** One line for a finished sync. */
export function describeSync(s: { indexed: number; unchanged: number; disposed: number; errors?: number }): string {
  return `${s.indexed} applied, ${s.disposed} disposed, ${s.unchanged} unchanged${s.errors ? `, ${s.errors} errors` : ''}`;
}
