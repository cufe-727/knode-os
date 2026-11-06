import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The servers `knode-os login` signed this machine in to: one file, mode 0600,
 * holding each server's session token and the workspace its commands use. The
 * one named `current` is where `search`, `ask`, `graph`, `claims`, `ls`, `read`
 * and `grep` go, unless `--data` or KNODE_OS_DATA names a data directory here.
 *
 * It lives beside the user's other CLI settings, not under a data directory: a
 * machine that only talks to a server has none.
 */

export interface SavedWorkspace {
  kind: 'personal' | 'team';
  /** A personal workspace's id, or a Team's `team-<slug>`. */
  id: string;
  /** What the server calls it; a Team is found by this name. */
  name: string;
}

export interface SavedServer {
  /** The server's origin, e.g. https://knode.example.com. */
  url: string;
  username: string;
  /** The `knu_…` bearer token the server issued, or a script token given with --token-stdin. */
  token: string;
  sessionId?: string;
  workspace?: SavedWorkspace;
  signedInAt: string;
}

interface SignInsFile {
  version: 1;
  current?: string;
  servers: Record<string, SavedServer>;
}

/** KNODE_OS_SIGNINS, or $XDG_CONFIG_HOME/knode-os/servers.json, or ~/.config/knode-os/servers.json. */
export function signInsFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.KNODE_OS_SIGNINS) return path.resolve(env.KNODE_OS_SIGNINS);
  const base = env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(os.homedir(), '.config');
  return path.join(base, 'knode-os', 'servers.json');
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * A server as the user typed it → its origin. No scheme means HTTPS. Plain
 * HTTP is refused for anything but this machine (an SSH tunnel's local end):
 * the password would cross the network in the clear, and the server answers
 * other machines over HTTPS only anyway.
 */
export function normalizeServerUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error('name the server, e.g. https://knode.example.com');
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error(`not a server address: ${input}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`a server is reached over https:// (got ${url.protocol}//)`);
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
    throw new Error(`${url.origin} is plain HTTP: the password would cross the network in the clear — use https://${url.host}, or an SSH tunnel to http://127.0.0.1:<port>`);
  }
  if (url.pathname !== '/' && url.pathname !== '') throw new Error(`give the server's address without a path: ${url.origin}`);
  return url.origin;
}

export class SignInStore {
  readonly file: string;

  constructor(file = signInsFile()) {
    this.file = file;
  }

  private read(): SignInsFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<SignInsFile>;
      return { version: 1, current: parsed.current, servers: parsed.servers && typeof parsed.servers === 'object' ? parsed.servers : {} };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, servers: {} };
      throw new Error(`cannot read ${this.file}: ${e instanceof Error ? e.message : e}`);
    }
  }

  private write(state: SignInsFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    // a file made before by hand, or by an older umask, still ends up private
    fs.chmodSync(this.file, 0o600);
  }

  /** The server commands go to, if this machine is signed in to one. */
  current(): SavedServer | null {
    const state = this.read();
    return (state.current && state.servers[state.current]) || null;
  }

  get(url: string): SavedServer | null {
    return this.read().servers[url] ?? null;
  }

  list(): { current?: string; servers: SavedServer[] } {
    const state = this.read();
    return { current: state.current, servers: Object.values(state.servers) };
  }

  /** Keep a sign-in, and make it the one commands use. */
  save(server: SavedServer): void {
    const state = this.read();
    state.servers[server.url] = server;
    state.current = server.url;
    this.write(state);
  }

  setWorkspace(url: string, workspace: SavedWorkspace): void {
    const state = this.read();
    const server = state.servers[url];
    if (!server) throw new Error(`not signed in to ${url}`);
    server.workspace = workspace;
    this.write(state);
  }

  makeCurrent(url: string): void {
    const state = this.read();
    if (!state.servers[url]) throw new Error(`not signed in to ${url}`);
    state.current = url;
    this.write(state);
  }

  /**
   * Forget a sign-in. Signing out of the current server leaves none current,
   * so commands work on this machine again rather than moving to another
   * server unasked; `knode-os login <url>` picks a kept one back up.
   */
  remove(url: string): void {
    const state = this.read();
    delete state.servers[url];
    if (state.current === url) delete state.current;
    this.write(state);
  }
}
