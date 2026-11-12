import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, embeddingIdentity, KnodeConfig, loadConfig, processingSettings, readAgentLlms, readModelAgents, saveConfig } from './config.js';
import { AppContext, judgeLlmClient } from './context.js';
import { AGENTS_DIR } from './fs/layout.js';
import { createConfiguredEmbeddingProvider } from './ingest/embedding-router.js';
import { isValidAgentName } from './research/agent-file.js';

/**
 * One set of settings for every workspace on a server (docs/design/12 §6.1):
 * the models and connections, embedding, processing, every stage, research,
 * Ask, languages, retrieval, the graph, the server's own — everything in
 * `knode.config.json` but what a workspace contains (`OWN_PATHS`): its data
 * sources, its linked folders and its code repositories.
 *
 * The server root's `knode.config.json` holds them. Every workspace's own file
 * carries a copy, written when the workspace opens, and again in every
 * workspace when an administrator changes a setting in any workspace's
 * settings. So whatever reads a workspace's config — the service, the CLI, a
 * test — reads the shared values, and a new workspace, made from the root's
 * config, starts with them.
 *
 * Settings name agents by id: the stages, the default model, research's and
 * Ask's agents, the study refiner. A named agent under `playbooks/agents/`
 * travels with the settings, so the id resolves in every workspace —
 * `loadConfig` would otherwise pin a route whose target is missing back to the
 * default. Connection rows need no carrying: `connections` is shared whole.
 */

/** What stays each workspace's own: what it contains, not how it runs. */
export const OWN_PATHS: readonly (readonly string[])[] = [
  ['datasources'],
  ['ingest', 'linkedFolders'],
  ['ingest', 'codebases'],
];

/** Read from the agent files by `loadConfig`, never written (`saveConfig`). */
const DERIVED = new Set(['agentLlms', 'modelAgents']);

const STAGE_ROUTES = ['entityLlm', 'documentLlm', 'summaryLlm', 'judgeLlm', 'translateLlm'] as const;

/** JSON with every object's keys sorted: two configs that hold the same value compare equal whatever order a save wrote it in. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
    : v));
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function get(obj: unknown, keys: readonly string[]): unknown {
  let cur = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** Set `value` at `keys` (undefined removes it); a missing parent is made only to hold a value. */
function set(obj: Record<string, unknown>, keys: readonly string[], value: unknown): void {
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== 'object') {
      if (value === undefined) return;
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1];
  if (value === undefined) delete cur[last];
  else cur[last] = clone(value);
}

/** The shared settings of a config: all of it but `OWN_PATHS`, `processing` normalized (an old `autoStart` stays behind). */
export function sharedSettingsOf(config: KnodeConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (DERIVED.has(key) || value === undefined) continue;
    out[key] = key === 'processing' ? processingSettings(config) : clone(value);
  }
  for (const keys of OWN_PATHS) set(out, keys, undefined);
  return out;
}

export function sharedSettingsDiffer(a: KnodeConfig, b: KnodeConfig): boolean {
  return stable(sharedSettingsOf(a)) !== stable(sharedSettingsOf(b));
}

/** Write `from`'s shared settings into `to`, keeping `to`'s own. Returns whether `to` changed. */
export function copySharedSettings(from: KnodeConfig, to: KnodeConfig): boolean {
  const target = to as unknown as Record<string, unknown>;
  const before = stable(sharedSettingsOf(to)) + JSON.stringify(to.processing ?? null);
  const own = OWN_PATHS.map((keys) => [keys, get(to, keys)] as const);
  const shared = sharedSettingsOf(from);
  for (const key of Object.keys(target)) if (!DERIVED.has(key) && !(key in shared)) delete target[key];
  for (const [key, value] of Object.entries(shared)) target[key] = value;
  for (const [keys, value] of own) set(target, keys, value);
  return stable(sharedSettingsOf(to)) + JSON.stringify(to.processing ?? null) !== before;
}

/** Every id the shared settings name: the stages, the slots, the default model, research's and Ask's agents, the study refiner. */
function namedIds(config: KnodeConfig): string[] {
  const ids = new Set<string>();
  const add = (v: unknown) => {
    const id = typeof v === 'string' ? v.trim() : '';
    // 'default' follows the default model; it names nothing to carry
    if (id && id !== 'default') ids.add(id);
  };
  for (const key of STAGE_ROUTES) add(config.extraction?.[key]?.use);
  for (const w of config.extraction?.workers ?? []) add(w?.use);
  for (const v of [config.llmUse, config.research?.agent, config.chat?.agent, config.research?.study?.refiner]) add(v);
  return [...ids];
}

/** The agent files the shared settings name, as they live in `dir`. */
export function sharedTargets(dir: string, config: KnodeConfig): string[] {
  return namedIds(config).filter((id) => agentText(dir, id) !== null);
}

/**
 * The shared settings of the workspace at `dir` with the text of the agents
 * they name, as one string: a save changed what every workspace shares when
 * this differs before and after it. It holds secrets (a row's key): compare
 * it, never show it.
 */
export function sharedSnapshot(dir: string, config: KnodeConfig): string {
  return stable({
    settings: sharedSettingsOf(config),
    agents: sharedTargets(dir, config).map((id) => [id, agentText(dir, id)]),
  });
}

function agentText(dataDir: string, name: string): string | null {
  if (!isValidAgentName(name)) return null;
  for (const ext of ['yaml', 'yml']) {
    const file = path.join(dataDir, AGENTS_DIR, `${name}.${ext}`);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  }
  return null;
}

/** Copy the agent files `ids` from `fromDir` to `toDir`. Returns whether a file was written. */
function copyAgentFiles(fromDir: string, ids: string[], toDir: string): boolean {
  let wrote = false;
  for (const id of ids) {
    const text = agentText(fromDir, id);
    if (text === null || agentText(toDir, id) === text) continue;
    const file = path.join(toDir, AGENTS_DIR, `${id}.yaml`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    // one file per agent: a `.yml` twin would be read first by nothing, and disagree
    fs.rmSync(path.join(toDir, AGENTS_DIR, `${id}.yml`), { force: true });
    wrote = true;
  }
  return wrote;
}

/**
 * Write the shared settings `global` (the root's, at `globalDir`) into the
 * workspace at `dataDir`, with the agents they name. The agent files go
 * first: `loadConfig` reads them, and pins a route whose target it cannot
 * find. Returns whether the workspace's files changed. A folder without a
 * config is left alone, and so is the root itself.
 */
export function syncWorkspaceSettings(globalDir: string, global: KnodeConfig, dataDir: string): boolean {
  if (path.resolve(globalDir) === path.resolve(dataDir)) return false;
  if (!fs.existsSync(path.join(dataDir, CONFIG_FILE))) return false;
  const files = copyAgentFiles(globalDir, sharedTargets(globalDir, global), dataDir);
  const config = loadConfig(dataDir);
  const settings = copySharedSettings(global, config);
  if (settings) saveConfig(dataDir, config);
  return files || settings;
}

/**
 * Make what the workspace at `fromDir` just saved the shared settings: written
 * to the root's config at `globalDir`, with the agent files they name. `live`,
 * the root config `serve` holds in memory, takes them too.
 */
export function publishSharedSettings(globalDir: string, fromDir: string, from: KnodeConfig, live?: KnodeConfig): void {
  const same = path.resolve(globalDir) === path.resolve(fromDir);
  if (!same) {
    copyAgentFiles(fromDir, sharedTargets(fromDir, from), globalDir);
    const root = loadConfig(globalDir);
    copySharedSettings(from, root);
    saveConfig(globalDir, root);
  }
  if (live && live !== from) {
    copySharedSettings(from, live);
    // the agents it may name now, as `loadConfig` would have read them
    live.agentLlms = readAgentLlms(globalDir);
    live.modelAgents = readModelAgents(globalDir);
  }
}

/**
 * Every workspace folder under a server root: the personal ones, and a Team
 * that is a folder of its own. A Team shared from a personal workspace is a
 * symlink to it, and is left out: its target is listed already.
 */
export function workspaceDirs(rootDir: string): string[] {
  const out: string[] = [];
  const dirs = (abs: string) => {
    try {
      return fs.readdirSync(abs, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
    } catch {
      return [];
    }
  };
  for (const user of dirs(path.join(rootDir, 'users'))) {
    for (const id of dirs(path.join(rootDir, 'users', user, 'workspaces'))) out.push(path.join(rootDir, 'users', user, 'workspaces', id));
  }
  for (const team of dirs(path.join(rootDir, 'teams'))) out.push(path.join(rootDir, 'teams', team));
  return out;
}

export interface SharedSettingsChange {
  /** Workspace folders whose files took the new values. */
  written: string[];
  /** Open workspaces whose config was reloaded. */
  reloaded: string[];
  /** Open workspaces reloaded onto another embedding model: their embedder is new, their vectors are to follow. */
  reembedded: string[];
  /** Folders that could not take them, with why. */
  failed: { dataDir: string; error: string }[];
}

/**
 * An administrator changed a setting in the workspace `from` (already saved
 * there): publish it to the root, write it into every other workspace's
 * files, and reload every open workspace that took it, so its slots, stages,
 * embedder and nightly passes run on it (the slots within a minute).
 */
export function shareSettingsEverywhere(opts: {
  root: { dataDir: string; config: KnodeConfig };
  from: { dataDir: string; config: KnodeConfig };
  open: AppContext[];
  log?: (msg: string) => void;
}): SharedSettingsChange {
  const { root, from } = opts;
  publishSharedSettings(root.dataDir, from.dataDir, from.config, root.config);
  const change: SharedSettingsChange = { written: [], reloaded: [], reembedded: [], failed: [] };
  const fromDir = path.resolve(from.dataDir);
  for (const dir of workspaceDirs(root.dataDir)) {
    if (path.resolve(dir) === fromDir) continue;
    try {
      if (syncWorkspaceSettings(root.dataDir, root.config, dir)) change.written.push(dir);
    } catch (err) {
      change.failed.push({ dataDir: dir, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const written = new Set(change.written.map((d) => path.resolve(d)));
  for (const ctx of opts.open) {
    if (path.resolve(ctx.dataDir) === fromDir || path.resolve(ctx.dataDir) === path.resolve(root.dataDir)) continue;
    try {
      // its files took something (an agent file, maybe, which only a re-read shows), or what it holds is behind them
      const next = loadConfig(ctx.dataDir);
      if (!written.has(path.resolve(ctx.dataDir)) && !sharedSettingsDiffer(ctx.config, next)) continue;
      const embeddingBefore = embeddingIdentity(ctx.config.embedding);
      ctx.config = next;
      ctx.llm = judgeLlmClient(next);
      if (embeddingIdentity(next.embedding) !== embeddingBefore) {
        ctx.embedder = createConfiguredEmbeddingProvider(next);
        change.reembedded.push(ctx.dataDir);
      }
      change.reloaded.push(ctx.dataDir);
    } catch (err) {
      change.failed.push({ dataDir: ctx.dataDir, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return change;
}
