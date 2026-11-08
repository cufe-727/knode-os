import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, isCliProvider, KnodeConfig, loadConfig, processingSettings, readAgentLlms, readModelAgents, saveConfig } from './config.js';
import { AppContext, judgeLlmClient } from './context.js';
import { AGENTS_DIR } from './fs/layout.js';
import { isValidAgentName, readAgentFile } from './research/agent-file.js';

/**
 * The settings every workspace on a server shares (docs/design/12 §6.1): how
 * this machine processes — the cap on model calls at once and the quota floor
 * (`processing`) — and what each pipeline stage runs on and with how many
 * slots (the five stage routes, `extraction.workers`, the stage concurrencies
 * and the review's). Content settings — data sources, research, languages,
 * embedding, `summaryAfterExtraction` — stay each workspace's own.
 *
 * The server root's `knode.config.json` holds them. Every workspace's own file
 * carries a copy, written when the workspace opens, and again in every
 * workspace when an administrator changes one of them in any workspace's
 * settings. So whatever reads a workspace's config — the service, the CLI, a
 * test — reads the shared values, and a new workspace, made from the root's
 * config, starts with them.
 *
 * A stage names what it runs on by id: an agent under `playbooks/agents/` or a
 * connection row. Those it names travel with the settings — the agent file is
 * copied, the connection row merged, and so is a row an agent loops on — so
 * the id resolves in every workspace; `loadConfig` would otherwise pin a route
 * whose target is missing back to the workspace's default. A workspace's own
 * agent or connection with the same id is replaced by the shared one — unless
 * the workspace uses it for itself (its default model, research's or Ask's
 * agent): ids like `openai-1` are made per workspace and mean something else
 * in each. Then the shared one gets an id of its own when it is published
 * (`settleSharedIds`), and a workspace's own is moved aside when the shared
 * one arrives under its id all the same (`syncWorkspaceSettings`).
 */

export const SHARED_PATHS: readonly (readonly string[])[] = [
  ['processing'],
  ['extraction', 'entityLlm'],
  ['extraction', 'documentLlm'],
  ['extraction', 'summaryLlm'],
  ['extraction', 'judgeLlm'],
  ['extraction', 'translateLlm'],
  ['extraction', 'tier1Model'],
  ['extraction', 'workers'],
  ['extraction', 'concurrency'],
  ['extraction', 'summaryConcurrency'],
  ['extraction', 'translateConcurrency'],
  ['review', 'concurrency'],
];

const STAGE_ROUTES = ['entityLlm', 'documentLlm', 'summaryLlm', 'judgeLlm', 'translateLlm'] as const;

/** JSON with every object's keys sorted: two configs that hold the same value compare equal whatever order a save wrote it in. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
    : v));
}

function get(obj: unknown, keys: readonly string[]): unknown {
  let cur = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function set(obj: Record<string, unknown>, keys: readonly string[], value: unknown): void {
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1];
  if (value === undefined) delete cur[last];
  else cur[last] = JSON.parse(JSON.stringify(value));
}

/** One shared value as it travels: `processing` normalized (an old `autoStart` stays behind). */
function sharedValue(config: KnodeConfig, keys: readonly string[]): unknown {
  if (keys.length === 1 && keys[0] === 'processing') return processingSettings(config);
  return get(config, keys);
}

/** The shared settings of a config, by dotted path. */
export function sharedSettingsOf(config: KnodeConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const keys of SHARED_PATHS) out[keys.join('.')] = sharedValue(config, keys);
  return out;
}

export function sharedSettingsDiffer(a: KnodeConfig, b: KnodeConfig): boolean {
  return stable(sharedSettingsOf(a)) !== stable(sharedSettingsOf(b));
}

/** Write `from`'s shared settings into `to`. Returns whether `to` changed. */
export function copySharedSettings(from: KnodeConfig, to: KnodeConfig): boolean {
  const before = stable(sharedSettingsOf(to)) + JSON.stringify(to.processing ?? null);
  for (const keys of SHARED_PATHS) set(to as unknown as Record<string, unknown>, keys, sharedValue(from, keys));
  return stable(sharedSettingsOf(to)) + JSON.stringify(to.processing ?? null) !== before;
}

/**
 * What the shared stages name, as it lives in `dir`: agent files, and the
 * connection rows a stage names directly or an agent there runs on (a
 * deepagents agent's `executor`, an OpenCode agent's `connection`).
 */
export function sharedTargets(dir: string, config: KnodeConfig): { agents: string[]; rows: string[] } {
  const agents: string[] = [];
  const rows = new Set<string>();
  for (const id of directTargets(config)) {
    const raw = agentText(dir, id) !== null ? readAgentFile(dir, id) : null;
    if (!raw) {
      rows.add(id);
      continue;
    }
    agents.push(id);
    const executor = typeof raw.executor === 'string' ? raw.executor.trim() : 'default';
    if (executor && executor !== 'default' && !isCliProvider(executor)) rows.add(executor);
    const connection = typeof raw.connection === 'string' ? raw.connection.trim() : '';
    if (connection) rows.add(connection);
  }
  return { agents, rows: [...rows] };
}

/**
 * The shared settings of the workspace at `dir` with everything they name —
 * the agent files' text, the rows — as one string: a save changed something
 * every workspace shares when this differs before and after it. It holds
 * secrets (a row's key): compare it, never show it.
 */
export function sharedSnapshot(dir: string, config: KnodeConfig): string {
  const targets = sharedTargets(dir, config);
  return stable({
    settings: sharedSettingsOf(config),
    agents: targets.agents.map((id) => [id, agentText(dir, id)]),
    rows: targets.rows.map((id) => (config.connections ?? []).find((c) => c.id === id) ?? null),
  });
}

/** Ids a workspace names for itself, outside the shared settings: its default model, research's and Ask's agents, the study refiner. */
function ownUses(config: KnodeConfig): Set<string> {
  const ids = [config.llmUse, config.research?.agent, config.chat?.agent, config.research?.study?.refiner];
  return new Set(ids.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean));
}

/** What `id` is in a workspace, to compare: its agent file's text or its row; null when it has neither. */
function itemOf(dir: string, config: KnodeConfig, id: string): string | null {
  const text = agentText(dir, id);
  if (text !== null) return `agent:${text}`;
  const row = (config.connections ?? []).find((c) => c.id === id);
  return row ? `row:${stable(row)}` : null;
}

/** The ids the stages and the slots name directly. */
function directTargets(config: KnodeConfig): string[] {
  const ids = new Set<string>();
  for (const key of STAGE_ROUTES) {
    const use = config.extraction?.[key]?.use?.trim();
    // 'default' follows each workspace's own default; it names nothing to carry
    if (use && use !== 'default') ids.add(use);
  }
  for (const w of config.extraction?.workers ?? []) if (typeof w?.use === 'string' && w.use.trim()) ids.add(w.use.trim());
  return [...ids];
}

/** An id no agent or row of `places` has: `<id>-<tag>`, then `-<tag>-2`, … (an agent name: at most 41 characters). */
function freshId(id: string, tag: string, places: { dir: string; config: KnodeConfig }[]): string {
  const taken = (candidate: string) => places.some((p) => itemOf(p.dir, p.config, candidate) !== null);
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? `-${tag}` : `-${tag}-${n}`;
    const candidate = `${id.slice(0, 41 - suffix.length)}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
}

/** Copy the agent or row `id` within one workspace as `to`. */
function copyItem(dir: string, config: KnodeConfig, id: string, to: string, label: string): void {
  const text = agentText(dir, id);
  if (text !== null) {
    const file = path.join(dir, AGENTS_DIR, `${to}.yaml`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, /^name:.*$/m.test(text) ? text.replace(/^name:.*$/m, `name: ${to}`) : `name: ${to}\n${text}`);
    return;
  }
  const row = (config.connections ?? []).find((c) => c.id === id);
  if (row) config.connections = [...config.connections, { ...(JSON.parse(JSON.stringify(row)) as typeof row), id: to, label: `${row.label || id} ${label}` }];
}

/** Point the stages and the slots that name an id of `renamed` at its new one. */
function renameTargets(config: KnodeConfig, renamed: Map<string, string>): void {
  for (const key of STAGE_ROUTES) {
    const to = renamed.get(config.extraction?.[key]?.use?.trim() ?? '');
    if (to) config.extraction[key] = { ...config.extraction[key], use: to };
  }
  if (config.extraction?.workers) config.extraction.workers = config.extraction.workers.map((w) => {
    const to = renamed.get(typeof w?.use === 'string' ? w.use.trim() : '');
    return to ? { ...w, use: to } : w;
  });
}

/** The root and every workspace but `except`, with their configs (one that cannot be read is left out). */
function otherPlaces(rootDir: string, root: KnodeConfig, except: string): { dir: string; config: KnodeConfig }[] {
  const out = [{ dir: rootDir, config: root }];
  for (const dir of workspaceDirs(rootDir)) {
    if (path.resolve(dir) === path.resolve(except) || !fs.existsSync(path.join(dir, CONFIG_FILE))) continue;
    try {
      out.push({ dir, config: loadConfig(dir) });
    } catch {
      // it cannot open either; it takes the settings once it can
    }
  }
  return out.filter((p) => path.resolve(p.dir) !== path.resolve(except));
}

/**
 * Before what `from` saved is published: a stage target whose id means
 * something else in the root or another workspace, which uses that id for
 * itself, is copied in `from` under an id nobody has, and the stages and slots
 * are pointed at the copy. So a shared stage never takes over another
 * workspace's default model. An agent another workspace's research or Ask
 * runs on is the server's own when it is the shared one as it stands: an edit
 * of it goes to everyone, research included. Returns the ids renamed (old →
 * new); `from` is saved, its agents re-read, when any is.
 */
export function settleSharedIds(rootDir: string, root: KnodeConfig, fromDir: string, from: KnodeConfig): Map<string, string> {
  const renamed = new Map<string, string>();
  let places: { dir: string; config: KnodeConfig }[] | null = null;
  for (const id of directTargets(from)) {
    const mine = itemOf(fromDir, from, id);
    if (mine === null) continue;
    places ??= otherPlaces(rootDir, root, fromDir);
    // the shared one as it stands: a place holding it holds the server's, and an edit of it is for everyone
    const sharedNow = directTargets(root).includes(id) ? itemOf(rootDir, root, id) : null;
    const clash = places.some((p) => {
      const theirs = itemOf(p.dir, p.config, id);
      if (theirs === null || theirs === mine) return false;
      // a default model is the workspace's own, whatever else runs on it
      if (p.config.llmUse === id) return true;
      return ownUses(p.config).has(id) && theirs !== sharedNow;
    });
    if (!clash) continue;
    const to = freshId(id, 'server', [{ dir: fromDir, config: from }, ...places]);
    copyItem(fromDir, from, id, to, '(server-wide)');
    renamed.set(id, to);
  }
  if (renamed.size > 0) {
    renameTargets(from, renamed);
    from.agentLlms = readAgentLlms(fromDir);
    from.modelAgents = readModelAgents(fromDir);
    saveConfig(fromDir, from);
  }
  return renamed;
}

/**
 * Move a workspace's own agent or row `id` aside to a new id, with what of its
 * own names it (its default model, research's and Ask's agents): the shared
 * one is about to arrive under `id`. Returns the new id.
 */
function moveOwnAside(dir: string, config: KnodeConfig, id: string, places: { dir: string; config: KnodeConfig }[]): string {
  const to = freshId(id, 'own', places);
  copyItem(dir, config, id, to, '(this workspace)');
  if (agentText(dir, id) !== null) {
    for (const ext of ['yaml', 'yml']) fs.rmSync(path.join(dir, AGENTS_DIR, `${id}.${ext}`), { force: true });
  } else {
    config.connections = (config.connections ?? []).filter((c) => c.id !== id);
  }
  if (config.llmUse === id) config.llmUse = to;
  if (config.research?.agent?.trim() === id) config.research.agent = to;
  if (config.chat?.agent?.trim() === id) config.chat.agent = to;
  if (config.research?.study?.refiner?.trim() === id) config.research.study.refiner = to;
  return to;
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
 * Merge `from`'s rows `rows` into `to` by id, and drop a row of `to` that has
 * the id of an agent carried with them (the agent replaces it). Returns
 * whether `to.connections` changed.
 */
function mergeRows(from: KnodeConfig, targets: { agents: string[]; rows: string[] }, to: KnodeConfig): boolean {
  let changed = false;
  let rows = [...(to.connections ?? [])];
  const carried = new Set(targets.agents);
  if (rows.some((c) => carried.has(c.id))) {
    rows = rows.filter((c) => !carried.has(c.id));
    changed = true;
  }
  for (const id of targets.rows) {
    const row = (from.connections ?? []).find((c) => c.id === id);
    if (!row) continue;
    const at = rows.findIndex((c) => c.id === id);
    if (at >= 0 && stable(rows[at]) === stable(row)) continue;
    const copy = JSON.parse(JSON.stringify(row)) as typeof row;
    rows = at >= 0 ? rows.map((c, i) => (i === at ? copy : c)) : [...rows, copy];
    changed = true;
  }
  if (changed) to.connections = rows;
  return changed;
}

/**
 * Write the shared settings `global` (the root's, at `globalDir`) into the
 * workspace at `dataDir`, with what its stages name. The agent files go first:
 * `loadConfig` reads them, and pins a route whose target it cannot find.
 * Returns whether the workspace's files changed. A folder without a config is
 * left alone, and so is the root itself.
 */
export function syncWorkspaceSettings(
  globalDir: string,
  global: KnodeConfig,
  dataDir: string,
  log: (msg: string) => void = () => {},
  was: ReadonlyMap<string, string | null> = new Map(),
): boolean {
  if (path.resolve(globalDir) === path.resolve(dataDir)) return false;
  if (!fs.existsSync(path.join(dataDir, CONFIG_FILE))) return false;
  const targets = sharedTargets(globalDir, global);
  // what of its own would the shared ones replace? an id it uses for itself, meaning something else, moves aside
  // first — its default model always; an agent its research or Ask runs on unless it is the shared one as it was
  // before this change (`was`), which the change is an edit of
  const own = loadConfig(dataDir);
  const uses = ownUses(own);
  let moved = false;
  for (const id of [...targets.agents, ...targets.rows]) {
    if (!uses.has(id)) continue;
    const theirs = itemOf(globalDir, global, id);
    const mine = itemOf(dataDir, own, id);
    if (theirs === null || mine === null || mine === theirs) continue;
    if (own.llmUse !== id && was.get(id) === mine) continue;
    const to = moveOwnAside(dataDir, own, id, [{ dir: dataDir, config: own }, { dir: globalDir, config: global }]);
    log(`its own "${id}" is "${to}" now: the server's stages run on another "${id}"`);
    moved = true;
  }
  if (moved) saveConfig(dataDir, own);
  const files = copyAgentFiles(globalDir, targets.agents, dataDir);
  const config = loadConfig(dataDir);
  const rows = mergeRows(global, targets, config);
  const settings = copySharedSettings(global, config);
  if (rows || settings) saveConfig(dataDir, config);
  return moved || files || rows || settings;
}

/**
 * Make what the workspace at `fromDir` just saved the shared settings: written
 * to the root's config at `globalDir`, with the agent files and rows its
 * stages name. `live`, the root config `serve` holds in memory, takes them too.
 */
export function publishSharedSettings(globalDir: string, fromDir: string, from: KnodeConfig, live?: KnodeConfig): void {
  const same = path.resolve(globalDir) === path.resolve(fromDir);
  const targets = sharedTargets(fromDir, from);
  if (!same) {
    copyAgentFiles(fromDir, targets.agents, globalDir);
    const root = loadConfig(globalDir);
    mergeRows(from, targets, root);
    copySharedSettings(from, root);
    saveConfig(globalDir, root);
  }
  if (live && live !== from) {
    mergeRows(from, targets, live);
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
  /** Stage targets of the saving workspace given an id of their own first (old → new). */
  renamed: Record<string, string>;
  /** Workspace folders whose files took the new values. */
  written: string[];
  /** Open workspaces whose config was reloaded. */
  reloaded: string[];
  /** Folders that could not take them, with why. */
  failed: { dataDir: string; error: string }[];
}

/**
 * An administrator changed a shared setting in the workspace `from` (already
 * saved there): publish it to the root, write it into every other workspace's
 * files, and reload every open workspace that took it, so its slots, stages
 * and nightly passes run on it (the slots within a minute).
 */
export function shareSettingsEverywhere(opts: {
  root: { dataDir: string; config: KnodeConfig };
  from: { dataDir: string; config: KnodeConfig };
  open: AppContext[];
  log?: (msg: string) => void;
}): SharedSettingsChange {
  const { root, from } = opts;
  const renamed = settleSharedIds(root.dataDir, root.config, from.dataDir, from.config);
  // the shared targets as they were: a workspace holding one of them holds the server's, and takes the change
  const was = new Map(directTargets(root.config).map((id) => [id, itemOf(root.dataDir, root.config, id)] as const));
  publishSharedSettings(root.dataDir, from.dataDir, from.config, root.config);
  const change: SharedSettingsChange = { renamed: Object.fromEntries(renamed), written: [], reloaded: [], failed: [] };
  const fromDir = path.resolve(from.dataDir);
  for (const dir of workspaceDirs(root.dataDir)) {
    if (path.resolve(dir) === fromDir) continue;
    try {
      const log = opts.log ? (m: string) => opts.log!(`${path.relative(root.dataDir, dir)}: ${m}`) : undefined;
      if (syncWorkspaceSettings(root.dataDir, root.config, dir, log, was)) change.written.push(dir);
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
      ctx.config = next;
      ctx.llm = judgeLlmClient(next);
      change.reloaded.push(ctx.dataDir);
    } catch (err) {
      change.failed.push({ dataDir: ctx.dataDir, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return change;
}
