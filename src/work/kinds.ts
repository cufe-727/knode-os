/**
 * The kinds of work `serve` hands out as leases (docs/design/11): extraction
 * segments and summary pages. A worker names the kinds each of its slots
 * takes, the server says which it offers, and a token may be narrowed to some.
 */
export const WORK_KINDS = ['extract', 'summarize'] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export function isWorkKind(value: unknown): value is WorkKind {
  return typeof value === 'string' && (WORK_KINDS as readonly string[]).includes(value);
}
