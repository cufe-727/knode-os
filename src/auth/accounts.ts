import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { workspaceSlug } from '../server/workspaces.js';
import { ApiGroup, API_GROUP_NAMES, DEFAULT_MEMBER_REMOTE_APIS } from './apis.js';

/**
 * Accounts — who may sign in to `serve`, and what each may do.
 *
 * One file per data root, `.knode/accounts.json` (0600), re-read whenever it
 * changes so the CLI (`knode-os user …`) and a running `serve` never disagree.
 * Passwords are stored as scrypt hashes; verification costs the same whether
 * or not the user exists, so timing does not tell which names are taken.
 *
 *   admin   every workspace, every API group, user management, the gateway
 *   member  their own personal workspaces and the teams listed for them;
 *           every group but `settings`, and from outside this machine only
 *           the groups in `remoteApis`
 */

export type Role = 'admin' | 'member';

export interface PasswordHash {
  algo: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  hash: string;
}

export interface AccountRecord {
  username: string;
  name: string;
  role: Role;
  password: PasswordHash;
  /** Team workspaces (by slug) a member may open; "*" = all. Admins open every team. */
  teams: string[];
  /** API groups usable from outside this machine; "*" = all a role allows. */
  remoteApis: string[];
  /** Gateway ids (local services) the user may reach; "*" = all. */
  gateways: string[];
  disabled?: boolean;
  createdAt: string;
  passwordChangedAt: string;
  /** Sessions started before this are void ("sign out everywhere"); a password change does the same. */
  sessionsRevokedAt?: string;
}

export type PublicAccount = Omit<AccountRecord, 'password'>;

interface AccountsFile {
  version: 1;
  users: AccountRecord[];
}

export const ACCOUNTS_FILE = '.knode/accounts.json';
export const MIN_PASSWORD_LENGTH = 8;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
const scrypt = promisify(crypto.scrypt) as (password: string, salt: Buffer, keylen: number, options: crypto.ScryptOptions) => Promise<Buffer>;
/** Hashed against when a user does not exist, so a miss takes as long as a hit. */
const DUMMY: PasswordHash = { algo: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: '00'.repeat(16), hash: '00'.repeat(64) };

export function normalizeUsername(value: string): string {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase();
}

export function assertUsername(username: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(username)) {
    throw new Error('usernames are 1–32 lower-case letters, digits, dots, dashes or underscores, starting with a letter or digit');
  }
}

export function assertPassword(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) throw new Error(`passwords need at least ${MIN_PASSWORD_LENGTH} characters`);
  if (password.length > 1024) throw new Error('password too long');
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  assertPassword(password);
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return { algo: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('hex'), hash: hash.toString('hex') };
}

async function passwordMatches(password: string, stored: PasswordHash): Promise<boolean> {
  const expected = Buffer.from(stored.hash, 'hex');
  const actual = await scrypt(String(password ?? ''), Buffer.from(stored.salt, 'hex'), expected.length || SCRYPT.keylen, {
    N: stored.N, r: stored.r, p: stored.p, maxmem: SCRYPT.maxmem,
  });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

const cleanList = (values: unknown, allowed?: readonly string[]): string[] => {
  const list = Array.isArray(values) ? values : typeof values === 'string' ? values.split(',') : [];
  const out = [...new Set(list.map((v) => String(v).trim().toLowerCase()).filter(Boolean))];
  if (allowed) for (const v of out) if (v !== '*' && !allowed.includes(v)) throw new Error(`unknown API group "${v}" — groups are ${allowed.join(', ')}`);
  return out;
};

/** Team names as their workspaces are stored (teams/<slug>), so "Acme Labs" and "acme-labs" are one team. */
const cleanTeams = (values: unknown): string[] =>
  [...new Set(cleanList(values).map((v) => (v === '*' ? v : workspaceSlug(v, 'Team name'))))];

export interface AccountInput {
  username: string;
  name?: string;
  password: string;
  role?: Role;
  teams?: string[] | string;
  remoteApis?: string[] | string;
  gateways?: string[] | string;
}

export interface AccountUpdate {
  name?: string;
  password?: string;
  role?: Role;
  teams?: string[] | string;
  remoteApis?: string[] | string;
  gateways?: string[] | string;
  disabled?: boolean;
}

export class AccountStore {
  private cache: { mtimeMs: number; size: number; file: AccountsFile } | null = null;

  constructor(private readonly rootDataDir: string) {}

  get file(): string {
    return path.join(this.rootDataDir, ACCOUNTS_FILE);
  }

  hasUsers(): boolean {
    return this.read().users.length > 0;
  }

  list(): PublicAccount[] {
    return this.read().users.map(publicAccount);
  }

  get(username: string): PublicAccount | null {
    const u = this.read().users.find((x) => x.username === normalizeUsername(username));
    return u ? publicAccount(u) : null;
  }

  async create(input: AccountInput): Promise<PublicAccount> {
    const username = normalizeUsername(input.username);
    assertUsername(username);
    const file = this.read();
    if (file.users.some((u) => u.username === username)) throw new Error(`user "${username}" exists`);
    const role: Role = input.role === 'admin' ? 'admin' : 'member';
    const now = new Date().toISOString();
    const record: AccountRecord = {
      username,
      name: String(input.name ?? '').trim() || username,
      role,
      password: await hashPassword(input.password),
      teams: cleanTeams(input.teams),
      remoteApis: input.remoteApis === undefined ? (role === 'admin' ? ['*'] : [...DEFAULT_MEMBER_REMOTE_APIS]) : cleanList(input.remoteApis, API_GROUP_NAMES),
      gateways: cleanList(input.gateways),
      createdAt: now,
      passwordChangedAt: now,
    };
    // re-read: hashing took a moment, and another writer may have added the same name
    const fresh = this.read();
    if (fresh.users.some((u) => u.username === username)) throw new Error(`user "${username}" exists`);
    fresh.users.push(record);
    this.write(fresh);
    return publicAccount(record);
  }

  async update(username: string, changes: AccountUpdate): Promise<{ account: PublicAccount; credentialsChanged: boolean }> {
    const name = normalizeUsername(username);
    const password = changes.password !== undefined ? await hashPassword(changes.password) : undefined;
    const file = this.read();
    const u = file.users.find((x) => x.username === name);
    if (!u) throw new Error(`no user "${name}"`);
    const demoting = (changes.role !== undefined && changes.role !== 'admin' && u.role === 'admin') || (changes.disabled === true && u.role === 'admin');
    if (demoting && file.users.filter((x) => x.role === 'admin' && !x.disabled).length <= 1) throw new Error('the last administrator cannot be demoted or disabled');
    if (changes.name !== undefined) u.name = String(changes.name).trim() || u.username;
    if (changes.role !== undefined) u.role = changes.role === 'admin' ? 'admin' : 'member';
    if (changes.teams !== undefined) u.teams = cleanTeams(changes.teams);
    if (changes.remoteApis !== undefined) u.remoteApis = cleanList(changes.remoteApis, API_GROUP_NAMES);
    if (changes.gateways !== undefined) u.gateways = cleanList(changes.gateways);
    if (changes.disabled !== undefined) u.disabled = Boolean(changes.disabled) || undefined;
    if (password) {
      u.password = password;
      u.passwordChangedAt = new Date().toISOString();
    }
    this.write(file);
    return { account: publicAccount(u), credentialsChanged: Boolean(password) || changes.disabled === true };
  }

  /** Void every session the user holds, wherever it was started. */
  revokeSessions(username: string): PublicAccount {
    const name = normalizeUsername(username);
    const file = this.read();
    const u = file.users.find((x) => x.username === name);
    if (!u) throw new Error(`no user "${name}"`);
    u.sessionsRevokedAt = new Date().toISOString();
    this.write(file);
    return publicAccount(u);
  }

  remove(username: string): void {
    const name = normalizeUsername(username);
    const file = this.read();
    const u = file.users.find((x) => x.username === name);
    if (!u) throw new Error(`no user "${name}"`);
    if (u.role === 'admin' && file.users.filter((x) => x.role === 'admin' && !x.disabled).length <= 1) throw new Error('the last administrator cannot be removed');
    file.users = file.users.filter((x) => x !== u);
    this.write(file);
  }

  /** The account for these credentials, or null — same cost for a wrong password, an unknown or a disabled user. */
  async authenticate(username: string, password: string): Promise<PublicAccount | null> {
    const name = normalizeUsername(username);
    const u = this.read().users.find((x) => x.username === name);
    const ok = await passwordMatches(password, u?.password ?? DUMMY);
    if (!u || !ok || u.disabled) return null;
    return publicAccount(u);
  }

  private read(): AccountsFile {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.file);
    } catch {
      this.cache = null;
      return { version: 1, users: [] };
    }
    if (this.cache && this.cache.mtimeMs === st.mtimeMs && this.cache.size === st.size) return structuredClone(this.cache.file);
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as AccountsFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.users)) throw new Error(`${ACCOUNTS_FILE} is not an accounts file`);
    this.cache = { mtimeMs: st.mtimeMs, size: st.size, file: parsed };
    return structuredClone(parsed);
  }

  private write(file: AccountsFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.cache = null;
  }
}

function publicAccount(u: AccountRecord): PublicAccount {
  const { password: _password, ...rest } = u;
  return structuredClone(rest);
}

/** Sessions started before this moment are void: the last password change or "sign out everywhere". */
export function sessionCutoff(account: PublicAccount): number {
  return Math.max(Date.parse(account.passwordChangedAt) || 0, Date.parse(account.sessionsRevokedAt ?? '') || 0);
}

/** Whether an account may open a team workspace (by its stored slug). */
export function accountMayOpenTeam(account: PublicAccount, slug: string): boolean {
  return account.role === 'admin' || account.teams.includes('*') || account.teams.includes(slug);
}

/** Whether an account may reach a gateway (a local service published under /gw/<id>). */
export function accountMayUseGateway(account: PublicAccount, id: string): boolean {
  return account.role === 'admin' || account.gateways.includes('*') || account.gateways.includes(id);
}

/** Whether an account may use an API group, here or from outside this machine. */
export function accountAllows(account: PublicAccount, group: ApiGroup, remote: boolean): boolean {
  if (account.disabled) return false;
  if (account.role !== 'admin' && group === 'settings') return false;
  if (!remote) return true;
  return account.remoteApis.includes('*') || account.remoteApis.includes(group);
}
