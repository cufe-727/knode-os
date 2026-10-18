import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isWorkKind, WORK_KINDS, WorkKind } from '../work/kinds.js';

/**
 * Tokens for the remote API (src/remote/api.ts) — one per machine or
 * application, each with its own scopes and workspaces, revocable on its own.
 *
 * A token reads `knr_<id>_<secret>`. The id is public (it names the token in
 * logs and listings); only a SHA-256 of the secret is stored, in
 * `<data root>/.knode/remote-tokens.json` (0600), and a presented secret is
 * compared in constant time. The file is re-read when it changes, so a token
 * created or revoked with the CLI takes effect in a running `serve` at once.
 */

export const REMOTE_SCOPES = ['label', 'read', 'write', 'sql'] as const;
export type RemoteScope = (typeof REMOTE_SCOPES)[number];

export const REMOTE_SCOPE_HELP: Record<RemoteScope, string> = {
  label: `take leased work and hand back results (remote workers): ${WORK_KINDS.join(', ')}, or the kinds the token names`,
  read: 'list, read and search documents; read the graph and claims',
  write: 'write and delete documents under raw/docs, wiki and playbooks/packs; trigger a sync',
  sql: 'read-only SQL over the catalog views (v_*)',
};

export interface RemoteTokenRecord {
  id: string;
  name: string;
  /** SHA-256 of the secret, hex. */
  hash: string;
  scopes: RemoteScope[];
  /** Workspaces it may use: "<user>/<workspace-id>", "team/<name>", or "*". */
  workspaces: string[];
  /** The kinds of work `label` covers for it; absent, every kind (src/work/kinds.ts). */
  kinds?: WorkKind[];
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

interface TokenFile {
  version: 1;
  tokens: RemoteTokenRecord[];
}

export const REMOTE_TOKENS_FILE = '.knode/remote-tokens.json';
const TOKEN_RE = /^knr_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
/** lastUsedAt is written at most this often per token. */
const TOUCH_EVERY_MS = 10 * 60_000;

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

/** A workspace spec as tokens store it: lower-case "<owner>/<id>", or "*". */
export function normalizeWorkspaceSpec(spec: string): string {
  const s = spec.trim().toLowerCase();
  if (s === '*') return s;
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(s);
  if (!m) throw new Error(`workspace "${spec}" must look like <user>/<workspace-id>, team/<name>, or *`);
  return `${m[1]}/${m[2]}`;
}

export class RemoteTokenStore {
  private cache: { mtimeMs: number; size: number; file: TokenFile } | null = null;
  private readonly touched = new Map<string, number>();

  constructor(private readonly rootDataDir: string) {}

  get file(): string {
    return path.join(this.rootDataDir, REMOTE_TOKENS_FILE);
  }

  list(): RemoteTokenRecord[] {
    return this.read().tokens.map((t) => ({ ...t }));
  }

  /** Mint a token; the secret is shown once and never stored. */
  create(opts: { name: string; scopes: RemoteScope[]; workspaces: string[]; kinds?: string[] }): { token: string; record: RemoteTokenRecord } {
    const name = opts.name.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new Error('token name: 1-64 letters, digits, dot, dash or underscore');
    const scopes = [...new Set(opts.scopes)];
    if (scopes.length === 0) throw new Error(`give the token at least one scope: ${REMOTE_SCOPES.join(', ')}`);
    for (const s of scopes) if (!(REMOTE_SCOPES as readonly string[]).includes(s)) throw new Error(`unknown scope "${s}" — scopes are ${REMOTE_SCOPES.join(', ')}`);
    const workspaces = [...new Set(opts.workspaces.map(normalizeWorkspaceSpec))];
    if (workspaces.length === 0) throw new Error('name the workspaces the token may use (e.g. admin/finance), or *');
    const kinds = [...new Set(opts.kinds ?? [])];
    for (const k of kinds) if (!isWorkKind(k)) throw new Error(`unknown kind of work "${k}" — kinds are ${WORK_KINDS.join(', ')}`);
    if (kinds.length > 0 && !scopes.includes('label')) throw new Error('kinds narrow the "label" scope — give the token that scope too');
    const file = this.read();
    if (file.tokens.some((t) => t.name === name && !t.revokedAt)) throw new Error(`a live token named "${name}" exists — revoke it first or pick another name`);
    const id = crypto.randomBytes(6).toString('hex');
    const secret = crypto.randomBytes(32).toString('base64url');
    const record: RemoteTokenRecord = {
      id, name, hash: sha256(secret), scopes, workspaces,
      ...(kinds.length ? { kinds: kinds as WorkKind[] } : {}),
      createdAt: new Date().toISOString(),
    };
    file.tokens.push(record);
    this.write(file);
    return { token: `knr_${id}_${secret}`, record: { ...record } };
  }

  /** Revoke by id or name. */
  revoke(idOrName: string): RemoteTokenRecord {
    const file = this.read();
    const record = file.tokens.find((t) => !t.revokedAt && (t.id === idOrName || t.name === idOrName));
    if (!record) throw new Error(`no live token "${idOrName}"`);
    record.revokedAt = new Date().toISOString();
    this.write(file);
    return { ...record };
  }

  /** The live record a presented token belongs to, or null. */
  verify(presented: string | null | undefined): RemoteTokenRecord | null {
    const m = TOKEN_RE.exec((presented ?? '').trim());
    if (!m) return null;
    const record = this.read().tokens.find((t) => t.id === m[1]);
    if (!record || record.revokedAt) return null;
    const a = Buffer.from(record.hash, 'hex');
    const b = Buffer.from(sha256(m[2]), 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    this.touch(record.id);
    return { ...record };
  }

  private touch(id: string): void {
    const now = Date.now();
    if (now - (this.touched.get(id) ?? 0) < TOUCH_EVERY_MS) return;
    this.touched.set(id, now);
    try {
      const file = this.read();
      const record = file.tokens.find((t) => t.id === id);
      if (!record) return;
      record.lastUsedAt = new Date(now).toISOString();
      this.write(file);
    } catch {
      // bookkeeping only
    }
  }

  private read(): TokenFile {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.file);
    } catch {
      this.cache = null;
      return { version: 1, tokens: [] };
    }
    if (this.cache && this.cache.mtimeMs === st.mtimeMs && this.cache.size === st.size) return structuredClone(this.cache.file);
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as TokenFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.tokens)) throw new Error(`${REMOTE_TOKENS_FILE} is not a token file`);
    this.cache = { mtimeMs: st.mtimeMs, size: st.size, file: parsed };
    return structuredClone(parsed);
  }

  private write(file: TokenFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.cache = null;
  }
}

/** Does the token allow this scope in this workspace? */
export function tokenAllows(record: RemoteTokenRecord, scope: RemoteScope, workspace: string): boolean {
  if (!record.scopes.includes(scope)) return false;
  const ws = workspace.toLowerCase();
  return record.workspaces.some((w) => w === '*' || w === ws);
}

/** May the token take this kind of work in this workspace? `label`, narrowed by its kinds when it names any. */
export function tokenAllowsKind(record: RemoteTokenRecord, kind: WorkKind, workspace: string): boolean {
  return tokenAllows(record, 'label', workspace) && (!record.kinds?.length || record.kinds.includes(kind));
}
