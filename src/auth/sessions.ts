import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Sessions — what a signed-in browser, app or script presents instead of a
 * password.
 *
 *   browser  an HttpOnly cookie set by POST /api/auth/login
 *   app      a bearer token the macOS app keeps in the Keychain
 *   token    a bearer token for a script, made with `knode-os user token`
 *
 * A token is `knu_` + 43 base64url characters (256 bits); only its SHA-256 is
 * stored, in `.knode/sessions.json` (0600). Browser and app sessions slide:
 * each use pushes the expiry out again, up to `idleDays` without use. Script
 * tokens keep the expiry they were made with.
 *
 * The file is shared by `serve` and the CLI; both re-read it when it changes
 * and write it whole, atomically. Last-use times are kept in memory and folded
 * in at most once a minute, so signing in from the CLI (`user token`) and a
 * running server do not overwrite each other's sessions.
 *
 * Whether a session still counts also depends on its account (src/auth/
 * service.ts): a password change, "sign out everywhere", disabling or
 * removing the user voids the sessions made before it.
 */

export type SessionKind = 'browser' | 'app' | 'token';

export interface SessionRecord {
  /** Public id: the first 16 hex digits of the token's hash. */
  id: string;
  hash: string;
  username: string;
  kind: SessionKind;
  /** The device, browser or script it was made for. */
  label: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  /** Sliding sessions: how long an unused session lives. */
  idleDays?: number;
  /** The address it was last used from. */
  ip?: string;
}

export type PublicSession = Omit<SessionRecord, 'hash'>;

interface SessionsFile {
  version: 1;
  sessions: SessionRecord[];
}

export const SESSIONS_FILE = '.knode/sessions.json';
export const TOKEN_PREFIX = 'knu_';
const MAX_SESSIONS_PER_USER = 50;
const TOUCH_FLUSH_MS = 60_000;
const DAY_MS = 86_400_000;

export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export function looksLikeSessionToken(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith(TOKEN_PREFIX) && value.length === TOKEN_PREFIX.length + 43;
}

export class SessionStore {
  private cache: { mtimeMs: number; size: number; file: SessionsFile } | null = null;
  /** Last use seen since the last write: hash → time and address. */
  private touched = new Map<string, { at: number; ip?: string }>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly rootDataDir: string) {}

  get file(): string {
    return path.join(this.rootDataDir, SESSIONS_FILE);
  }

  create(input: { username: string; kind: SessionKind; label?: string; ip?: string; idleDays?: number; expiresInDays?: number }): { token: string; session: PublicSession } {
    const token = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
    const hash = hashToken(token);
    const now = Date.now();
    const sliding = input.kind !== 'token';
    const days = sliding ? Math.max(1 / 24, input.idleDays ?? 30) : Math.max(1, input.expiresInDays ?? 365);
    const record: SessionRecord = {
      id: hash.slice(0, 16),
      hash,
      username: input.username,
      kind: input.kind,
      label: String(input.label ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120) || input.kind,
      createdAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      expiresAt: new Date(now + days * DAY_MS).toISOString(),
      ...(sliding ? { idleDays: days } : {}),
      ...(input.ip ? { ip: input.ip } : {}),
    };
    this.mutate((file) => {
      file.sessions.push(record);
      // the oldest of a user's sessions go first once there are too many
      const mine = file.sessions.filter((s) => s.username === record.username).sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt));
      const excess = new Set(mine.slice(0, Math.max(0, mine.length - MAX_SESSIONS_PER_USER)).map((s) => s.hash));
      file.sessions = file.sessions.filter((s) => !excess.has(s.hash));
    });
    return { token, session: publicSession(record) };
  }

  /** The live session for a token, or null; a hit counts as use. */
  verify(token: string | null | undefined, ip?: string): PublicSession | null {
    if (!looksLikeSessionToken(token)) return null;
    const hash = hashToken(token);
    const record = this.snapshot().sessions.find((s) => s.hash.length === hash.length && crypto.timingSafeEqual(Buffer.from(s.hash), Buffer.from(hash)));
    if (!record) return null;
    const now = Date.now();
    const touched = this.touched.get(hash);
    const seen = Math.max(Date.parse(record.lastSeenAt) || 0, touched?.at ?? 0);
    const expires = record.idleDays ? seen + record.idleDays * DAY_MS : Date.parse(record.expiresAt);
    if (!(expires > now)) return null;
    this.touched.set(hash, { at: now, ip });
    this.scheduleFlush();
    return publicSession({
      ...record,
      lastSeenAt: new Date(now).toISOString(),
      ...(record.idleDays ? { expiresAt: new Date(now + record.idleDays * DAY_MS).toISOString() } : {}),
      ...(ip ? { ip } : {}),
    });
  }

  list(username?: string): PublicSession[] {
    const now = Date.now();
    return this.snapshot().sessions
      .filter((s) => !username || s.username === username)
      .map((s) => this.withTouch(s))
      .filter((s) => Date.parse(s.expiresAt) > now)
      .map(publicSession);
  }

  /** Remove one session by its public id (and, when given, only if it is that user's). */
  revoke(id: string, username?: string): boolean {
    let found = false;
    this.mutate((file) => {
      const before = file.sessions.length;
      file.sessions = file.sessions.filter((s) => !(s.id === id && (!username || s.username === username)));
      found = file.sessions.length < before;
    });
    return found;
  }

  revokeToken(token: string): boolean {
    if (!looksLikeSessionToken(token)) return false;
    const hash = hashToken(token);
    let found = false;
    this.mutate((file) => {
      const before = file.sessions.length;
      file.sessions = file.sessions.filter((s) => s.hash !== hash);
      found = file.sessions.length < before;
    });
    return found;
  }

  /** Remove every session of a user (they were voided already by the account; this just tidies the file). */
  revokeUser(username: string, keepId?: string): number {
    let removed = 0;
    this.mutate((file) => {
      const before = file.sessions.length;
      file.sessions = file.sessions.filter((s) => s.username !== username || s.id === keepId);
      removed = before - file.sessions.length;
    });
    return removed;
  }

  /** Write last-use times now (shutdown). */
  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.touched.size === 0) return;
    this.mutate(() => {});
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      try {
        this.flush();
      } catch {
        // the next use tries again
      }
    }, TOUCH_FLUSH_MS);
    this.flushTimer.unref?.();
  }

  private withTouch(s: SessionRecord): SessionRecord {
    const t = this.touched.get(s.hash);
    if (!t || t.at <= (Date.parse(s.lastSeenAt) || 0)) return s;
    return {
      ...s,
      lastSeenAt: new Date(t.at).toISOString(),
      ...(s.idleDays ? { expiresAt: new Date(t.at + s.idleDays * DAY_MS).toISOString() } : {}),
      ...(t.ip ? { ip: t.ip } : {}),
    };
  }

  /** Read the newest file, apply a change and the pending last-use times, drop the expired, write. */
  private mutate(change: (file: SessionsFile) => void): void {
    const file = this.read();
    file.sessions = file.sessions.map((s) => this.withTouch(s));
    change(file);
    const now = Date.now();
    file.sessions = file.sessions.filter((s) => Date.parse(s.expiresAt) > now);
    this.write(file);
    this.touched.clear();
  }

  /** A copy to change. */
  private read(): SessionsFile {
    return structuredClone(this.snapshot());
  }

  /** The current file, shared: never changed in place. */
  private snapshot(): SessionsFile {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.file);
    } catch {
      this.cache = null;
      return { version: 1, sessions: [] };
    }
    if (this.cache && this.cache.mtimeMs === st.mtimeMs && this.cache.size === st.size) return this.cache.file;
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as SessionsFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) throw new Error(`${SESSIONS_FILE} is not a sessions file`);
    this.cache = { mtimeMs: st.mtimeMs, size: st.size, file: parsed };
    return parsed;
  }

  private write(file: SessionsFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.cache = null;
  }
}

function publicSession(s: SessionRecord): PublicSession {
  const { hash: _hash, ...rest } = s;
  return rest;
}
