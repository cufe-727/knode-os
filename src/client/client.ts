import type { PublicAccount } from '../auth/accounts.js';
import type { PublicSession } from '../auth/sessions.js';
import type { SavedServer, SavedWorkspace } from './signins.js';

/**
 * The CLI's side of `serve`'s REST API: the same routes the web UI and the
 * macOS app call, with the session token `knode-os login` saved and the
 * workspace it chose. The server decides what the account may do; this only
 * carries the request and words its refusals.
 */

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface TeamView {
  id: string;
  name: string;
  kind: 'team';
  slug: string;
}

/** GET /api/auth/me, and what POST /api/auth/login answers beside the token. */
export interface AccountView {
  account: PublicAccount;
  /** Whether the server counts this client as its own machine. */
  local: boolean;
  /** Each API group, and whether this account may use it from where this client is. */
  groups: Record<string, boolean>;
  teams: TeamView[];
  session?: PublicSession;
}

export interface AuthState {
  auth: boolean;
  setupRequired: boolean;
  https?: boolean;
  signedIn?: boolean;
}

export interface PersonalWorkspace {
  id: string;
  name: string;
  kind: 'personal';
}

export class ServerError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: string) {
    super(message);
  }
}

export type Query = Record<string, string | number | boolean | undefined>;
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface SendOptions {
  query?: Query;
  /** Sent as JSON. */
  body?: unknown;
  /** Sent as multipart, instead of a JSON body. */
  form?: FormData;
  /** Add the chosen workspace's headers: every route that reads or writes a workspace needs them. */
  workspace?: boolean;
  accept?: string;
}

/** Fetch's headers are bytes: a name outside Latin-1 cannot go in one. */
const headerSafe = (value: string) => /^[\x20-\x7e\x80-\xff]*$/.test(value);

export class KnodeClient {
  readonly url: string;
  private readonly token?: string;
  readonly workspace?: SavedWorkspace;
  private readonly fetchImpl: Fetch;

  constructor(url: string, opts: { token?: string; workspace?: SavedWorkspace; fetch?: Fetch } = {}) {
    this.url = url;
    this.token = opts.token;
    this.workspace = opts.workspace;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  static forSaved(saved: SavedServer, fetchImpl?: Fetch): KnodeClient {
    return new KnodeClient(saved.url, { token: saved.token, workspace: saved.workspace, fetch: fetchImpl });
  }

  withWorkspace(workspace: SavedWorkspace): KnodeClient {
    return new KnodeClient(this.url, { token: this.token, workspace, fetch: this.fetchImpl });
  }

  withToken(token: string): KnodeClient {
    return new KnodeClient(this.url, { token, workspace: this.workspace, fetch: this.fetchImpl });
  }

  /** A route of a workspace: search, files, the graph. */
  get<T>(route: string, query: Query = {}): Promise<T> {
    return this.call<T>('GET', route, { query, workspace: true });
  }

  post<T>(route: string, body: unknown = {}): Promise<T> {
    return this.call<T>('POST', route, { body, workspace: true });
  }

  put<T>(route: string, body: unknown): Promise<T> {
    return this.call<T>('PUT', route, { body, workspace: true });
  }

  delete<T>(route: string, query: Query = {}): Promise<T> {
    return this.call<T>('DELETE', route, { query, workspace: true });
  }

  /** A file's bytes as the server sends them, e.g. GET /api/file/original. */
  async download(route: string, query: Query = {}): Promise<{ bytes: Uint8Array; contentType: string }> {
    const res = await this.send('GET', route, { query, workspace: true, accept: '*/*' });
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? '' };
  }

  /** POST a multipart form, e.g. files to /api/upload. */
  upload<T>(route: string, form: FormData): Promise<T> {
    return this.call<T>('POST', route, { form, workspace: true });
  }

  /* -------------------------------- sign-in -------------------------------- */

  state(): Promise<AuthState> {
    return this.call<AuthState>('GET', '/api/auth/state');
  }

  login(username: string, password: string, label: string): Promise<AccountView & { token: string }> {
    return this.call('POST', '/api/auth/login', { body: { username, password, client: 'app', label, remember: true } });
  }

  me(): Promise<AccountView> {
    return this.call<AccountView>('GET', '/api/auth/me');
  }

  logout(): Promise<{ ok: boolean }> {
    return this.call('POST', '/api/auth/logout', { body: {} });
  }

  personalWorkspaces(): Promise<PersonalWorkspace[]> {
    return this.call<PersonalWorkspace[]>('GET', '/api/workspaces');
  }

  /* -------------------------------- the wire -------------------------------- */

  private workspaceHeaders(): Record<string, string> {
    const ws = this.workspace;
    if (!ws) throw new Error(`no workspace chosen on ${this.url} — \`knode-os workspaces\` lists them, \`knode-os use <name>\` picks one`);
    if (![ws.id, ws.name].every(headerSafe)) {
      throw new Error(`the workspace "${ws.name}" has a name that cannot travel in an HTTP header — rename it, or use it in the web UI`);
    }
    return { 'x-knode-workspace-kind': ws.kind, 'x-knode-workspace-id': ws.id, 'x-knode-workspace-name': ws.name };
  }

  /** A JSON route. */
  async call<T>(method: Method, route: string, opts: SendOptions = {}): Promise<T> {
    const res = await this.send(method, route, opts);
    const text = await res.text();
    try {
      return (text ? JSON.parse(text) : null) as T;
    } catch {
      throw new Error(`${this.url}${route} did not answer with JSON — is this a knode-os server?`);
    }
  }

  /** Any route: the response when it is a success, a worded error otherwise. */
  async send(method: Method, route: string, opts: SendOptions = {}): Promise<Response> {
    const target = new URL(route, this.url);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined && value !== '') target.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { accept: opts.accept ?? 'application/json', 'user-agent': 'knode-os-cli' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (opts.workspace) Object.assign(headers, this.workspaceHeaders());
    let body: string | FormData | undefined;
    if (opts.form) body = opts.form;
    else if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(target.toString(), { method, headers, body });
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      throw new Error(`cannot reach ${this.url}: ${cause?.code ?? cause?.message ?? (e instanceof Error ? e.message : String(e))}`);
    }
    if (res.ok) return res;
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = undefined;
    }
    const answer = (parsed && typeof parsed === 'object' ? parsed : {}) as { error?: string; reason?: string };
    if (res.status === 401 && answer.reason === 'auth') {
      // the server says which: "sign in first", or "your session has ended — sign in again"
      throw new ServerError(`${answer.error ?? 'sign in first'}: knode-os login ${this.url}`, 401, 'auth');
    }
    // Cloudflare's own pages: the tunnel gave up waiting, or could not reach serve
    if (res.status === 524) throw new ServerError(`${this.url} took longer than its tunnel waits (about 100 s) to answer`, 524);
    if (res.status === 502 || res.status === 530) throw new ServerError(`${this.url} is not answering behind its tunnel (${res.status}) — is serve running?`, res.status);
    throw new ServerError(answer.error ?? `${res.status} ${res.statusText} from ${this.url}${route}`, res.status, answer.reason);
  }
}
