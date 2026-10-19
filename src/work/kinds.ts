/**
 * The kinds of work `serve` hands out as leases (docs/design/12): extraction
 * segments, summary pages and the Judge stage's review calls. A worker names
 * the kinds each of its slots takes, the server says which it offers, and a
 * token may be narrowed to some.
 */
export const WORK_KINDS = ['extract', 'summarize', 'judge'] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

/**
 * The kinds that share a slot by weight (`server.remote.shares`). The others
 * go first: a review is waiting on its judge calls, and a round has only a
 * bounded number of them.
 */
export const SHARED_KINDS = ['extract', 'summarize'] as const;
export type SharedKind = (typeof SHARED_KINDS)[number];

export function isWorkKind(value: unknown): value is WorkKind {
  return typeof value === 'string' && (WORK_KINDS as readonly string[]).includes(value);
}

export function isSharedKind(kind: WorkKind): kind is SharedKind {
  return (SHARED_KINDS as readonly string[]).includes(kind);
}
