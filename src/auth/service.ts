import { AccountStore, PublicAccount, sessionCutoff } from './accounts.js';
import { GatewayStore } from './gateways.js';
import { PublicSession, SessionKind, SessionStore } from './sessions.js';

/**
 * Sign-in for `serve`: accounts (src/auth/accounts.ts), the sessions they
 * hold (src/auth/sessions.ts) and the local services they may reach
 * (src/auth/gateways.ts), under one data root. The HTTP side is
 * src/auth/http.ts.
 *
 * Password checks are throttled per client address and per username, and run
 * a few at a time: each costs ~32 MiB of scrypt memory, and a flood of them
 * must not take the server down.
 */

export interface AuthOptions {
  /** Days a browser or app session lives without use (default 30). */
  sessionDays?: number;
  /** Answer other machines over plain HTTP — only on a network that encrypts by itself (a VPN). */
  allowInsecureRemote?: boolean;
  /** The session cookie's name; per port, since browsers share cookies across the ports of a host. */
  cookieName?: string;
}

export interface Identity {
  account: PublicAccount;
  session: PublicSession;
}

export class AuthError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503, message: string, readonly retryAfter?: number) {
    super(message);
  }
}

const FAILURE_WINDOW_MS = 10 * 60_000;
const LIMITS = { ip: { failures: 10, blockMs: 15 * 60_000 }, user: { failures: 20, blockMs: 10 * 60_000 } };
const MAX_HASHING = 4;
const MAX_WAITING = 64;

class LoginLimiter {
  private entries = new Map<string, { count: number; since: number; blockedUntil: number }>();

  /** Seconds to wait before another try, or 0. */
  retryAfter(keys: string[], now = Date.now()): number {
    let wait = 0;
    for (const key of keys) {
      const e = this.entries.get(key);
      if (e && e.blockedUntil > now) wait = Math.max(wait, Math.ceil((e.blockedUntil - now) / 1000));
    }
    return wait;
  }

  fail(ipKey: string, userKey: string, now = Date.now()): void {
    for (const [key, limit] of [[ipKey, LIMITS.ip], [userKey, LIMITS.user]] as const) {
      const prev = this.entries.get(key);
      const e = prev && now - prev.since < FAILURE_WINDOW_MS ? prev : { count: 0, since: now, blockedUntil: 0 };
      e.count++;
      if (e.count >= limit.failures) e.blockedUntil = now + limit.blockMs;
      this.entries.set(key, e);
    }
    if (this.entries.size > 10_000) {
      for (const [key, e] of this.entries) if (e.blockedUntil < now && now - e.since > FAILURE_WINDOW_MS) this.entries.delete(key);
    }
  }

  succeed(ipKey: string, userKey: string): void {
    this.entries.delete(ipKey);
    this.entries.delete(userKey);
  }
}

class Semaphore {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(private readonly max: number, private readonly maxWaiting: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      if (this.waiting.length >= this.maxWaiting) throw new AuthError(503, 'too many sign-ins at once — try again in a moment');
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

export class AuthService {
  readonly accounts: AccountStore;
  readonly sessions: SessionStore;
  readonly gateways: GatewayStore;
  readonly cookieName: string;
  private readonly limiter = new LoginLimiter();
  private readonly hashing = new Semaphore(MAX_HASHING, MAX_WAITING);

  constructor(readonly rootDataDir: string, readonly options: AuthOptions = {}) {
    this.accounts = new AccountStore(rootDataDir);
    this.sessions = new SessionStore(rootDataDir);
    this.gateways = new GatewayStore(rootDataDir);
    this.cookieName = options.cookieName ?? 'knode_session';
  }

  get sessionDays(): number {
    const days = Number(this.options.sessionDays);
    return Number.isFinite(days) && days > 0 ? days : 30;
  }

  setupRequired(): boolean {
    return !this.accounts.hasUsers();
  }

  /** Check a password and start a session; throttled, and the same answer for every kind of miss. */
  async login(input: { username: string; password: string; kind: SessionKind; label?: string; ip: string; remember?: boolean }): Promise<{ token: string; session: PublicSession; account: PublicAccount }> {
    const name = String(input.username ?? '').trim().toLowerCase().slice(0, 64);
    const ipKey = `ip:${input.ip}`;
    const userKey = `user:${name}`;
    const wait = this.limiter.retryAfter([ipKey, userKey]);
    if (wait > 0) throw new AuthError(429, `too many failed sign-ins — try again in ${Math.ceil(wait / 60)} min`, wait);
    const account = await this.hashing.run(() => this.accounts.authenticate(name, String(input.password ?? '')));
    if (!account) {
      this.limiter.fail(ipKey, userKey);
      throw new AuthError(401, 'wrong username or password');
    }
    this.limiter.succeed(ipKey, userKey);
    return { ...this.issue(account, input), account };
  }

  /** A new session for an account that has proven itself already (sign-in, setup, a password change). */
  issue(account: PublicAccount, input: { kind: SessionKind; label?: string; ip?: string; remember?: boolean }): { token: string; session: PublicSession } {
    // a browser that is not to be remembered still needs a server-side end: half a day without use
    const idleDays = input.kind === 'browser' && input.remember === false ? 0.5 : this.sessionDays;
    return this.sessions.create({ username: account.username, kind: input.kind, label: input.label, ip: input.ip, idleDays });
  }

  /** Who a token belongs to, if its session and account are both still good. */
  identify(token: string | null | undefined, ip?: string): Identity | null {
    const session = this.sessions.verify(token, ip);
    if (!session) return null;
    const account = this.accounts.get(session.username);
    if (!account || account.disabled) return null;
    if (Date.parse(session.createdAt) < sessionCutoff(account)) return null;
    return { account, session };
  }

  /** Check a password without signing in (a password change); throttled like a sign-in. */
  async verifyPassword(username: string, password: string, ip: string): Promise<boolean> {
    const ipKey = `ip:${ip}`;
    const userKey = `user:${username}`;
    const wait = this.limiter.retryAfter([ipKey, userKey]);
    if (wait > 0) throw new AuthError(429, `too many failed attempts — try again in ${Math.ceil(wait / 60)} min`, wait);
    const ok = Boolean(await this.hashing.run(() => this.accounts.authenticate(username, password)));
    if (ok) this.limiter.succeed(ipKey, userKey);
    else this.limiter.fail(ipKey, userKey);
    return ok;
  }

  /** Hash under the same cap as sign-ins: an admin creating users is no exception. */
  hashed<T>(fn: () => Promise<T>): Promise<T> {
    return this.hashing.run(fn);
  }

  close(): void {
    try {
      this.sessions.flush();
    } catch {
      // last-use times are a convenience
    }
  }
}
