import crypto from 'node:crypto';

/** The first 16 hex characters of the SHA-256 of a value's JSON: the fingerprint of a fold, or of a page's inputs. */
export function sha16(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

/** Whether a presented secret is the expected one, compared in constant time. Nothing presented never matches. */
export function tokenMatches(presented: string | null | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
