import fs from 'node:fs';
import path from 'node:path';
import { AppContext, createContext } from '../context.js';
import { CONFIG_FILE, KnodeConfig, saveConfig } from '../config.js';
import { initDataDir } from '../fs/datadir.js';

export type WorkspaceKind = 'personal' | 'team';

export interface WorkspaceScope {
  user: string;
  kind: WorkspaceKind;
  id: string;
  name: string;
  slug: string;
  relativeDir: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  kind: 'personal';
  createdAt: string;
}

export interface WorkspaceHeaders {
  user?: string;
  kind?: string;
  id?: string;
  name?: string;
}

type WorkspaceCleanup = () => void | Promise<void>;

export interface WorkspaceContextRegistryOptions {
  templateConfig?: KnodeConfig;
  onCreate?: (ctx: AppContext, scope: WorkspaceScope) => void | WorkspaceCleanup | Promise<void | WorkspaceCleanup>;
}

interface WorkspaceManifest extends WorkspaceSummary {
  owner: string;
}

const WORKSPACE_MANIFEST = '.workspace.json';
const DEFAULT_WORKSPACE_NAME = 'Default';
const TRACE_SYNC_SINCE_FILE = '.knode/trace-sync-since';

/**
 * Convert a user-visible username, workspace name, or Team name into a
 * readable, path-safe directory segment.
 */
export function workspaceSlug(value: string, label = 'workspace name'): string {
  const raw = String(value || '').normalize('NFKC').trim().toLowerCase();
  if (!raw || raw.length > 128) throw new Error(`${label} is missing or too long`);
  const slug = raw
    .replace(/[\s/\\]+/g, '-')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 64)
    .replace(/[._-]+$/g, '');
  if (!slug || slug === '.' || slug === '..') throw new Error(`${label} has no usable characters`);
  return slug;
}

export function resolveWorkspaceScope(headers: WorkspaceHeaders): WorkspaceScope {
  const user = workspaceSlug(headers.user || '', 'username');
  const kind = headers.kind;
  if (kind !== 'personal' && kind !== 'team') throw new Error('workspace kind must be personal or team');

  if (kind === 'personal') {
    // Older clients identified the sole personal workspace with the username.
    // Keep those clients on the new default workspace until they send an id.
    const legacyPersonal = !headers.id && workspaceSlug(headers.name || user, 'workspace name') === user;
    const name = legacyPersonal
      ? DEFAULT_WORKSPACE_NAME
      : String(headers.name || DEFAULT_WORKSPACE_NAME).normalize('NFKC').trim();
    const id = workspaceSlug(headers.id || name, 'workspace id');
    return {
      user,
      kind,
      id,
      name,
      slug: id,
      relativeDir: `users/${user}/workspaces/${id}`,
    };
  }

  const name = String(headers.name || '').normalize('NFKC').trim();
  // Team storage remains keyed by the normalized Team name so users with
  // differently shaped local menu ids still resolve the same shared folder.
  const slug = workspaceSlug(name, 'Team name');
  return {
    user,
    kind,
    id: slug,
    name,
    slug,
    relativeDir: `teams/${slug}`,
  };
}

export function workspaceDataDir(rootDataDir: string, scope: WorkspaceScope): string {
  const parent = scope.kind === 'personal'
    ? path.resolve(rootDataDir, 'users', scope.user, 'workspaces')
    : path.resolve(rootDataDir, 'teams');
  const resolved = path.resolve(parent, scope.slug);
  if (!resolved.startsWith(parent + path.sep)) throw new Error('workspace path escapes the data root');
  return resolved;
}

function userWorkspacesDir(rootDataDir: string, username: string): string {
  const user = workspaceSlug(username, 'username');
  const usersRoot = path.resolve(rootDataDir, 'users');
  const resolved = path.resolve(usersRoot, user, 'workspaces');
  if (!resolved.startsWith(usersRoot + path.sep)) throw new Error('user workspace path escapes the data root');
  return resolved;
}

function manifestPath(dataDir: string): string {
  return path.join(dataDir, WORKSPACE_MANIFEST);
}

function readManifest(dataDir: string, owner: string, fallbackId: string): WorkspaceManifest {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath(dataDir), 'utf8')) as Partial<WorkspaceManifest>;
    if (parsed.id && parsed.name && parsed.kind === 'personal' && workspaceSlug(parsed.id, 'workspace id') === fallbackId) {
      return {
        id: workspaceSlug(parsed.id, 'workspace id'),
        name: String(parsed.name).normalize('NFKC').trim(),
        kind: 'personal',
        owner,
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : fs.statSync(dataDir).birthtime.toISOString(),
      };
    }
  } catch {
    // A missing/corrupt manifest is repaired from the safe directory id.
  }
  return {
    id: fallbackId,
    name: fallbackId === 'default' ? DEFAULT_WORKSPACE_NAME : fallbackId,
    kind: 'personal',
    owner,
    createdAt: fs.statSync(dataDir).birthtime.toISOString(),
  };
}

/** Lazily opens one independent knode-os context per workspace folder. */
export class WorkspaceContextRegistry {
  private readonly contexts = new Map<string, Promise<AppContext>>();
  private readonly cleanups = new Map<string, WorkspaceCleanup>();
  private readonly resetting = new Set<string>();

  constructor(
    public readonly rootDataDir: string,
    private readonly options: WorkspaceContextRegistryOptions = {},
  ) {}

  listUserWorkspaces(username: string): WorkspaceSummary[] {
    const user = workspaceSlug(username, 'username');
    const parent = userWorkspacesDir(this.rootDataDir, user);
    fs.mkdirSync(parent, { recursive: true });
    const workspaces = fs.readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => {
        const id = workspaceSlug(entry.name, 'workspace id');
        const manifest = readManifest(path.join(parent, entry.name), user, id);
        this.writeManifest(path.join(parent, entry.name), manifest);
        return {
          id: manifest.id,
          name: manifest.name,
          kind: 'personal' as const,
          createdAt: manifest.createdAt,
        };
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));
    if (workspaces.length > 0) return workspaces;
    return [this.createUserWorkspace(user, DEFAULT_WORKSPACE_NAME)];
  }

  createUserWorkspace(username: string, workspaceName: string): WorkspaceSummary {
    const user = workspaceSlug(username, 'username');
    const name = String(workspaceName || '').normalize('NFKC').trim();
    const id = workspaceSlug(name, 'workspace name');
    const scope = resolveWorkspaceScope({ user, kind: 'personal', id, name });
    const dataDir = workspaceDataDir(this.rootDataDir, scope);
    if (fs.existsSync(dataDir)) throw new Error(`workspace "${name}" already exists`);
    const summary: WorkspaceSummary = {
      id,
      name,
      kind: 'personal',
      createdAt: new Date().toISOString(),
    };
    this.initialize(dataDir, scope, summary.createdAt);
    return summary;
  }

  get(scope: WorkspaceScope): Promise<AppContext> {
    const dataDir = workspaceDataDir(this.rootDataDir, scope);
    if (this.resetting.has(dataDir)) return Promise.reject(new Error('workspace is being cleared'));
    let pending = this.contexts.get(dataDir);
    if (!pending) {
      pending = this.open(dataDir, scope).catch((error) => {
        this.contexts.delete(dataDir);
        throw error;
      });
      this.contexts.set(dataDir, pending);
    }
    return pending;
  }

  exists(scope: WorkspaceScope): boolean {
    return fs.existsSync(workspaceDataDir(this.rootDataDir, scope));
  }

  /** Delete every byte in a workspace, then recreate only its empty skeleton. */
  async reset(scope: WorkspaceScope): Promise<void> {
    const dataDir = workspaceDataDir(this.rootDataDir, scope);
    if (this.resetting.has(dataDir)) throw new Error('workspace is already being cleared');
    this.resetting.add(dataDir);
    try {
      let createdAt = new Date().toISOString();
      let resetScope = scope;
      if (scope.kind === 'personal' && fs.existsSync(dataDir)) {
        const manifest = readManifest(dataDir, scope.user, scope.id);
        createdAt = manifest.createdAt;
        resetScope = { ...scope, name: manifest.name };
      }
      await this.closeDataDir(dataDir);
      fs.rmSync(dataDir, { recursive: true, force: true });
      this.initialize(dataDir, resetScope, createdAt);
      fs.writeFileSync(path.join(dataDir, TRACE_SYNC_SINCE_FILE), new Date().toISOString() + '\n');
    } finally {
      this.resetting.delete(dataDir);
    }
  }

  async closeAll(): Promise<void> {
    const dataDirs = [...this.contexts.keys()];
    await Promise.all(dataDirs.map((dataDir) => this.closeDataDir(dataDir)));
  }

  private initialize(dataDir: string, scope: WorkspaceScope, createdAt: string): void {
    const isNew = !fs.existsSync(dataDir);
    initDataDir(dataDir);
    if (this.options.templateConfig) {
      saveConfig(dataDir, JSON.parse(JSON.stringify(this.options.templateConfig)) as KnodeConfig);
    }
    if (scope.kind === 'personal') {
      this.writeManifest(dataDir, {
        id: scope.id,
        name: scope.name,
        kind: 'personal',
        owner: scope.user,
        createdAt,
      });
    }
    if (isNew) fs.writeFileSync(path.join(dataDir, TRACE_SYNC_SINCE_FILE), new Date().toISOString() + '\n');
  }

  private writeManifest(dataDir: string, manifest: WorkspaceManifest): void {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(manifestPath(dataDir), JSON.stringify(manifest, null, 2) + '\n');
  }

  private async closeDataDir(dataDir: string): Promise<void> {
    const pending = this.contexts.get(dataDir);
    this.contexts.delete(dataDir);
    const cleanup = this.cleanups.get(dataDir);
    this.cleanups.delete(dataDir);
    if (cleanup) await cleanup();
    if (!pending) return;
    try {
      const ctx = await pending;
      await ctx.store.close();
    } catch {
      // Failed opens have already released or never acquired their store.
    }
  }

  private async open(dataDir: string, scope: WorkspaceScope): Promise<AppContext> {
    const configFile = path.join(dataDir, CONFIG_FILE);
    if (!fs.existsSync(configFile)) this.initialize(dataDir, scope, new Date().toISOString());
    const ctx = await createContext(dataDir);
    const cleanup = await this.options.onCreate?.(ctx, scope);
    if (cleanup) this.cleanups.set(dataDir, cleanup);
    return ctx;
  }
}
