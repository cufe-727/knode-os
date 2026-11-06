/**
 * The kinds of work `serve` hands out as leases (docs/design/12): extraction
 * segments, summary pages, the Judge stage's review calls, translated
 * segments (docs/design/17) and batches of texts to embed. A worker names the
 * kinds each of its slots takes, the server says which it offers, and a token
 * may be narrowed to some.
 */
export const WORK_KINDS = ['extract', 'summarize', 'judge', 'translate', 'embed'] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

/**
 * The kinds answered by a language model, which the `label` scope covers and
 * a token's `kinds` narrow. `embed` is not one of them: it has a scope of its
 * own (`embed`), and only an embed slot takes it.
 */
export const LLM_KINDS = ['extract', 'summarize', 'judge', 'translate'] as const;
export type LlmKind = (typeof LLM_KINDS)[number];

/**
 * The kinds that share a slot by weight (`server.remote.shares`). The others
 * go first: a review is waiting on its judge calls, and a round has only a
 * bounded number of them.
 */
export const SHARED_KINDS = ['extract', 'summarize', 'translate'] as const;
export type SharedKind = (typeof SHARED_KINDS)[number];

export function isWorkKind(value: unknown): value is WorkKind {
  return typeof value === 'string' && (WORK_KINDS as readonly string[]).includes(value);
}

export function isLlmKind(value: unknown): value is LlmKind {
  return typeof value === 'string' && (LLM_KINDS as readonly string[]).includes(value);
}

export function isSharedKind(kind: WorkKind): kind is SharedKind {
  return (SHARED_KINDS as readonly string[]).includes(kind);
}
