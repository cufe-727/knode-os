/**
 * Requests that fail before any response comes back, for a reason that should
 * pass: the connection was reset, refused, dropped or timed out while
 * connecting. Node's fetch reports them all as `TypeError: fetch failed` with
 * the socket's error as its cause. A benchmark build makes tens of thousands
 * of model and embedding calls over hours, and one such failure stopped the
 * 10× build after five of them (ECONNRESET on the evaluation's loopback
 * endpoint): they are tried again, with backoff, where the request is made.
 *
 * Only failures before a response: once a status came back, the endpoint
 * answered, and what it said is the caller's to handle (a 429 or 5xx has its
 * own retries where they apply). A request the caller aborted is never retried.
 */

/** Socket errors that pass; DNS names that do not exist do not. */
const DROPPED = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_CLOSED',
]);

/** Attempts in all, and the waits between them (the first, doubling up to the last). Tests shorten them. */
export const NETWORK_RETRY = { attempts: 5, baseMs: 1_000, maxMs: 30_000 };

/** The socket error code under a fetch failure, if any. */
function codeOf(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** A request that got no response because its connection failed in a way that should pass. */
export function droppedConnection(err: unknown): boolean {
  if (!(err instanceof Error) || err.name === 'AbortError' || err.name === 'TimeoutError') return false;
  const code = codeOf(err);
  if (code) return DROPPED.has(code);
  // undici's own wording when the cause carries no code
  return err instanceof TypeError && /^fetch failed$/i.test(err.message) && /other side closed|socket hang up|terminated/i.test(String((err as { cause?: unknown }).cause ?? ''));
}

/** One line per retry, to stderr: where, which try, why, and the wait (never the request's body or headers). */
function logRetry(err: unknown, attempt: number, waitMs: number, url: string): void {
  let where = url;
  try {
    const u = new URL(url);
    where = `${u.host}${u.pathname}`;
  } catch {
    /* as given */
  }
  console.error(`connection failed (${codeOf(err) ?? (err instanceof Error ? err.message : String(err))}) on ${where}, try ${attempt}: retrying in ${Math.round(waitMs / 1000)} s`);
}

/**
 * `fetch`, tried again while it fails with `droppedConnection`: up to
 * `NETWORK_RETRY.attempts` in all, waiting `baseMs`, then twice that, up to
 * `maxMs`. `onRetry` hears each failure that is tried again (default: a line on stderr).
 */
export async function fetchRetrying(
  url: string, init: RequestInit = {}, onRetry?: (err: unknown, attempt: number, waitMs: number, url: string) => void,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (init.signal?.aborted || attempt >= NETWORK_RETRY.attempts || !droppedConnection(err)) throw err;
      const wait = Math.min(NETWORK_RETRY.maxMs, NETWORK_RETRY.baseMs * 2 ** (attempt - 1));
      (onRetry ?? logRetry)(err, attempt, wait, url);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
