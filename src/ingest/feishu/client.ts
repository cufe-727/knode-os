import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * How knode-os reaches Feishu (Lark): through lark-cli
 * (https://github.com/larksuite/cli), the Open Platform's own command line.
 *
 * lark-cli holds the authorization. A person signs in once with the OAuth
 * device flow (`auth login`: a verification link opened on any device), and
 * lark-cli keeps the user access token fresh with the refresh token Feishu
 * hands out under `offline_access` — each refresh token is single-use and
 * comes back renewed, so a token used at least once inside its window (a week
 * as Feishu issues them today) stays alive until Feishu asks for a new sign-in
 * after 365 days. knode-os stores no Feishu secret of its own: it asks
 * lark-cli, as the signed-in user, for what that user can read.
 *
 * Every call goes out as `--as user`: a document someone shared with that
 * person is readable, where an app (bot) identity would need the owner to
 * add the app to the document first.
 *
 * The runner is injectable so the tests drive a fake lark-cli.
 */

/** What knode-os needs to read a document, its pictures and attachments, and to see when it changed. */
export const FEISHU_SCOPES = [
  'docx:document:readonly',
  'docs:document.content:read',
  'docs:document.media:download',
  'drive:drive.metadata:readonly',
  'wiki:node:read',
  'offline_access',
] as const;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type LarkRunner = (args: string[], opts: { timeoutMs: number; cwd?: string }) => Promise<RunResult>;

export type FeishuErrorKind =
  /** lark-cli is not installed (or not where the config says). */
  | 'not-installed'
  /** No signed-in user, an expired authorization, or a scope the user never granted. */
  | 'auth'
  /** The signed-in user may not read the document. */
  | 'forbidden'
  /** No such document (deleted, or a mistyped link). */
  | 'not-found'
  | 'other';

export class FeishuError extends Error {
  constructor(message: string, readonly kind: FeishuErrorKind, readonly hint?: string) {
    super(hint ? `${message} — ${hint}` : message);
    this.name = 'FeishuError';
  }
}

export interface FeishuAuthStatus {
  /** lark-cli runs at all. */
  installed: boolean;
  cli: string;
  appId: string | null;
  brand: string | null;
  /** A user is signed in and the token is usable (refreshed on the next call if it lapsed). */
  signedIn: boolean;
  user: { name: string; openId: string } | null;
  scopes: string[];
  /** Scopes knode-os needs that the signed-in user has not granted. */
  missingScopes: string[];
  tokenStatus: string | null;
  /** When the refresh token lapses unless it is used before then. */
  refreshExpiresAt: string | null;
  error: string | null;
}

export interface FetchedDocument {
  documentId: string;
  revisionId: number;
  /** Lark-flavored Markdown (src/ingest/feishu/markdown.ts reads it). */
  content: string;
}

export interface DocumentMeta {
  token: string;
  type: string;
  title: string;
  url: string | null;
  /** ISO time of the last edit. */
  modifiedAt: string | null;
  ownerId: string | null;
}

export interface WikiNode {
  objToken: string;
  objType: string;
  title: string;
}

export interface DeviceLogin {
  deviceCode: string;
  verificationUrl: string;
  expiresIn: number;
}

/** The lark-cli to run: the configured one, else the one on PATH, else the installer's default place. */
export function resolveLarkCli(configured?: string): string {
  if (configured?.trim()) return configured.trim();
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const name of ['lark-cli', 'larkcli']) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  const fallback = path.join(os.homedir(), '.local', 'bin', 'lark-cli');
  return fs.existsSync(fallback) ? fallback : 'lark-cli';
}

export function execRunner(cli: string): LarkRunner {
  return (args, opts) =>
    new Promise((resolve) => {
      execFile(cli, args, { timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024, env: process.env, cwd: opts.cwd }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : (err as { code?: unknown }).code === 'ENOENT' ? 127 : 1) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err && !stdout ? err.message : '') });
      });
    });
}

/** The JSON object a lark-cli call wrote, from stdout or (for failures) stderr. */
function parseEnvelope(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // a failure can print a line of prose before its envelope
    const start = trimmed.indexOf('{');
    if (start < 0) return null;
    try {
      return JSON.parse(trimmed.slice(start)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

/** Feishu's own codes that say "you may not read this" or "there is nothing there". */
const FORBIDDEN_CODES = new Set([1770032, 1069603, 131006, 91403, 99991672, 99991679]);
const NOT_FOUND_CODES = new Set([1770002, 1069604, 131005, 91402]);

function errorFrom(result: RunResult, what: string): FeishuError {
  if (result.code === 127) return new FeishuError('lark-cli is not installed', 'not-installed', 'install it (https://github.com/larksuite/cli), or set ingest.feishu.cli to where it is');
  const env = parseEnvelope(result.stderr) ?? parseEnvelope(result.stdout);
  const error = (env?.error ?? null) as { type?: string; subtype?: string; message?: string; hint?: string; code?: number; missing_scopes?: string[] } | null;
  const message = error?.message || result.stderr.trim().split('\n').pop() || `exit code ${result.code}`;
  const code = typeof error?.code === 'number' ? error.code : Number(/\b(\d{5,8})\b/.exec(message)?.[1] ?? NaN);
  if (result.code === 3 || error?.type === 'auth' || error?.subtype === 'missing_scope' || /token|unauthori[sz]ed|not logged in|login/i.test(error?.type ?? '')) {
    const scopes = error?.missing_scopes?.length ? ` (missing ${error.missing_scopes.join(', ')})` : '';
    return new FeishuError(`${what}: Feishu authorization needed${scopes}`, 'auth', 'sign in to Feishu again (Import → Feishu → Connect, or `knode-os feishu login`)');
  }
  if (FORBIDDEN_CODES.has(code) || /permission|forbidden|no access|无权限/i.test(message)) {
    return new FeishuError(`${what}: the signed-in Feishu user may not read it`, 'forbidden', 'ask its owner to share it with that account');
  }
  if (NOT_FOUND_CODES.has(code) || /not ?found|not exist|不存在/i.test(message)) return new FeishuError(`${what}: no such document`, 'not-found');
  return new FeishuError(`${what}: ${message}`, 'other', error?.hint);
}

const secondsToIso = (value: unknown): string | null => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
};

/** A Feishu client that drives lark-cli. */
export class LarkCli {
  readonly cli: string;
  private readonly run: LarkRunner;

  constructor(opts: { cli?: string; runner?: LarkRunner } = {}) {
    this.cli = resolveLarkCli(opts.cli);
    this.run = opts.runner ?? execRunner(this.cli);
  }

  /** Run one call and return its `data`; a failure becomes a FeishuError saying what to do. */
  private async call(args: string[], what: string, timeoutMs = 120_000, cwd?: string): Promise<Record<string, unknown>> {
    const result = await this.run(args, { timeoutMs, cwd });
    const env = result.code === 0 ? parseEnvelope(result.stdout) : null;
    if (!env || env.ok === false) throw errorFrom(result, what);
    return (env.data ?? {}) as Record<string, unknown>;
  }

  async status(): Promise<FeishuAuthStatus> {
    const base: FeishuAuthStatus = {
      installed: false,
      cli: this.cli,
      appId: null,
      brand: null,
      signedIn: false,
      user: null,
      scopes: [],
      missingScopes: [...FEISHU_SCOPES],
      tokenStatus: null,
      refreshExpiresAt: null,
      error: null,
    };
    const result = await this.run(['auth', 'status'], { timeoutMs: 30_000 });
    if (result.code === 127) return { ...base, error: errorFrom(result, 'lark-cli').message };
    const env = parseEnvelope(result.stdout) ?? parseEnvelope(result.stderr);
    if (!env) return { ...base, installed: true, error: result.stderr.trim() || 'lark-cli auth status printed nothing' };
    if (env.ok === false) {
      const e = env.error as { message?: string; hint?: string } | undefined;
      return { ...base, installed: true, error: [e?.message, e?.hint].filter(Boolean).join(' — ') || 'not configured' };
    }
    const user = ((env.identities as Record<string, unknown> | undefined)?.user ?? {}) as Record<string, unknown>;
    const scopes = String(user.scope ?? '').split(/\s+/).filter(Boolean);
    const signedIn = user.available === true && user.status === 'ready';
    return {
      ...base,
      installed: true,
      appId: typeof env.appId === 'string' ? env.appId : null,
      brand: typeof env.brand === 'string' ? env.brand : null,
      signedIn,
      user: signedIn && typeof user.openId === 'string' ? { name: String(user.userName ?? ''), openId: user.openId } : null,
      scopes,
      missingScopes: FEISHU_SCOPES.filter((s) => !scopes.includes(s)),
      tokenStatus: typeof user.tokenStatus === 'string' ? user.tokenStatus : null,
      refreshExpiresAt: typeof user.refreshExpiresAt === 'string' ? user.refreshExpiresAt : null,
      error: signedIn ? null : typeof user.message === 'string' ? user.message : 'no Feishu user signed in',
    };
  }

  /**
   * Start a device-flow sign-in: a link the person opens (on any device) to
   * approve knode-os's scopes. `keep` are scopes the signed-in user already
   * granted, asked again so lark-cli's other uses keep them.
   */
  async beginLogin(keep: string[] = []): Promise<DeviceLogin> {
    const scopes = [...new Set([...keep, ...FEISHU_SCOPES])].join(' ');
    const data = await this.callLogin(['auth', 'login', '--no-wait', '--json', '--scope', scopes], 'start the Feishu sign-in');
    const deviceCode = String(data.device_code ?? '');
    const verificationUrl = String(data.verification_url ?? data.verification_uri_complete ?? data.verification_uri ?? '');
    if (!deviceCode || !verificationUrl) throw new FeishuError('lark-cli did not return a sign-in link', 'other');
    return { deviceCode, verificationUrl, expiresIn: Number(data.expires_in) || 600 };
  }

  /** Wait for the person to approve a device-flow sign-in; resolves once lark-cli holds the token. */
  async completeLogin(login: DeviceLogin): Promise<void> {
    const result = await this.run(['auth', 'login', '--device-code', login.deviceCode, '--json'], { timeoutMs: (login.expiresIn + 30) * 1000 });
    if (result.code !== 0) throw errorFrom(result, 'Feishu sign-in');
    const env = parseEnvelope(result.stdout);
    if (env && env.ok === false) throw errorFrom({ ...result, stderr: result.stdout }, 'Feishu sign-in');
  }

  /** `auth login --no-wait --json` prints its fields at the top level, not under `data`. */
  private async callLogin(args: string[], what: string): Promise<Record<string, unknown>> {
    const result = await this.run(args, { timeoutMs: 60_000 });
    const env = result.code === 0 ? parseEnvelope(result.stdout) : null;
    if (!env || env.ok === false) throw errorFrom(result, what);
    return (env.data ?? env) as Record<string, unknown>;
  }

  /** A document as Lark-flavored Markdown, with its revision. `ref` is a docx token or URL. */
  async fetchDocument(ref: string): Promise<FetchedDocument> {
    const data = await this.call(['docs', '+fetch', '--doc', ref, '--doc-format', 'markdown', '--as', 'user'], `read ${ref}`, 300_000);
    const doc = (data.document ?? {}) as Record<string, unknown>;
    if (typeof doc.content !== 'string') throw new FeishuError(`read ${ref}: lark-cli returned no content`, 'other');
    return { documentId: String(doc.document_id ?? ref), revisionId: Number(doc.revision_id ?? 0), content: doc.content };
  }

  /** The document a wiki node holds. */
  async wikiNode(token: string): Promise<WikiNode> {
    const data = await this.call(['wiki', 'spaces', 'get_node', '--params', JSON.stringify({ token }), '--as', 'user'], `resolve wiki node ${token}`);
    const node = (data.node ?? data) as Record<string, unknown>;
    const objToken = String(node.obj_token ?? '');
    if (!objToken) throw new FeishuError(`resolve wiki node ${token}: no document behind it`, 'not-found');
    return { objToken, objType: String(node.obj_type ?? ''), title: String(node.title ?? '') };
  }

  /**
   * Titles and last-edit times, 200 documents a call — what change tracking
   * polls. A document the user can no longer read comes back in `failed`.
   */
  async metas(docs: { token: string; type: string }[]): Promise<{ metas: Map<string, DocumentMeta>; failed: Map<string, number> }> {
    const metas = new Map<string, DocumentMeta>();
    const failed = new Map<string, number>();
    for (let i = 0; i < docs.length; i += 200) {
      const batch = docs.slice(i, i + 200);
      const body = { request_docs: batch.map((d) => ({ doc_token: d.token, doc_type: d.type })), with_url: true };
      const data = await this.call(['drive', 'metas', 'batch_query', '--data', JSON.stringify(body), '--as', 'user'], 'read document metadata');
      for (const m of (data.metas ?? []) as Record<string, unknown>[]) {
        const token = String(m.doc_token ?? '');
        metas.set(token, {
          token,
          type: String(m.doc_type ?? ''),
          title: String(m.title ?? ''),
          url: typeof m.url === 'string' ? m.url : null,
          modifiedAt: secondsToIso(m.latest_modify_time),
          ownerId: typeof m.owner_id === 'string' ? m.owner_id : null,
        });
      }
      for (const f of (data.failed_list ?? []) as Record<string, unknown>[]) failed.set(String(f.token ?? ''), Number(f.code ?? 0));
    }
    return { metas, failed };
  }

  /**
   * Download a picture, attachment or whiteboard of a document. lark-cli
   * names the file's extension from its content type, so the path written is
   * returned, not assumed. lark-cli writes only under its working directory,
   * /tmp or ~/files, so it runs in the folder the file goes to and is given
   * the name alone.
   */
  async download(token: string, outBase: string, type: 'media' | 'whiteboard' = 'media'): Promise<{ path: string; bytes: number; contentType: string }> {
    const dir = path.dirname(outBase);
    fs.mkdirSync(dir, { recursive: true });
    const args = ['docs', '+media-download', '--token', token, '--type', type, '--output', path.basename(outBase), '--overwrite', '--as', 'user'];
    const data = await this.call(args, `download ${token}`, 600_000, dir);
    const saved = data.saved_path ? path.resolve(dir, String(data.saved_path)) : '';
    if (!saved || !fs.existsSync(saved)) throw new FeishuError(`download ${token}: lark-cli saved nothing`, 'other');
    return { path: saved, bytes: Number(data.size_bytes ?? fs.statSync(saved).size), contentType: String(data.content_type ?? '') };
  }
}
