/**
 * The kinds of work `serve` hands out as leases (docs/design/12): extraction
 * segments, summary pages, the Judge stage's review calls, translated
 * segments (docs/design/17), batches of texts to embed, and research agent
 * sessions (docs/design/27). A worker names the kinds each of its slots
 * takes, the server says which it offers, and a token may be narrowed to some.
 */
export const WORK_KINDS = ['extract', 'summarize', 'judge', 'translate', 'embed', 'session'] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

/**
 * The kinds answered by a language model, which the `label` scope covers and
 * a token's `kinds` narrow. `embed` and `session` are not among them: each has
 * a scope of its own (`embed`, `research`), and only a slot that asks for it
 * takes it.
 */
export const LLM_KINDS = ['extract', 'summarize', 'judge', 'translate'] as const;
export type LlmKind = (typeof LLM_KINDS)[number];

/**
 * The kinds that share a slot by weight (`server.remote.shares`). The others
 * go first: a review is waiting on its judge calls, and a round has only a
 * bounded number of them; embed batches and sessions go only to slots that
 * take nothing else.
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

/** Kinds a slot gets only when it names them: an LLM slot that names no kinds takes neither. */
export const ASKED_ONLY_KINDS: readonly WorkKind[] = ['embed', 'session'];
