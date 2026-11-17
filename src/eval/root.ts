import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, DatabaseConfig, defaultConfig, KnodeConfig, loadConfig, resolveDataDir, saveConfig } from '../config.js';
import { workspaceSlug } from '../server/workspaces.js';
import { describeDatabase, EVAL_DATABASE_URL_ENV, sameDatabase } from './database.js';
import { EVAL_HOME } from './pack.js';

/**
 * The evaluation root (docs/design/35 §2): a data root of its own where every
 * knode build of a run is a workspace, one per run and pack, filed under one
 * owner (`evaluation.owner`, default `eval`) and listed to every account of
 * the root. `server.evaluation: true` marks it: a run writes its builds only
 * into a root so marked, and `serve` on it is a viewer that changes none of
 * them (src/server/serve.ts).
 *
 * The root is never a live root: settings are server-wide there, and a build
 * keeps its run's pinned models. A root whose database is a live root's is
 * refused.
 */

/** `--root`'s environment variable. */
export const EVAL_ROOT_ENV = 'KNODE_EVAL_ROOT';
/** Where an evaluation root's viewer listens (knode-os's block of the port registry). */
export const EVAL_VIEW_PORT = 12040;
export const DEFAULT_EVAL_OWNER = 'eval';
const ROOT_PASSWORD_ENV = 'KNODE_EVAL_DATABASE_PASSWORD';

/** `--root`, else `KNODE_EVAL_ROOT`, else `<KNODE_EVAL_HOME>/server`. */
export function evalRootDir(explicit?: string): string {
  return path.resolve(explicit || process.env[EVAL_ROOT_ENV] || path.join(EVAL_HOME, 'server'));
}

export interface EvalRoot {
  dir: string;
  owner: string;
  config: KnodeConfig;
}

/** Whether `dir` holds a root config marked `server.evaluation`. */
export function isEvaluationRoot(dir: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILE), 'utf8')) as { server?: { evaluation?: unknown } };
    return raw.server?.evaluation === true;
  } catch {
    return false;
  }
}

/** The owner an evaluation root files its builds under. */
export function evalOwner(config: Pick<KnodeConfig, 'evaluation'>): string {
  return workspaceSlug(config.evaluation?.owner || DEFAULT_EVAL_OWNER, 'evaluation.owner');
}

/**
 * The database a live root uses: `--config-from`'s workspace's, else the
 * default data root's (read, never changed), else the default config's.
 */
export function liveDatabase(configFrom?: string): DatabaseConfig {
  if (configFrom) return loadConfig(configFrom, { readOnly: true }).database;
  const live = resolveDataDir();
  if (fs.existsSync(path.join(live, CONFIG_FILE))) return loadConfig(live, { readOnly: true }).database;
  return defaultConfig().database;
}

/** A root's database as its config holds it: no credential, only the environment variable that carries it. */
function rootDatabase(cfg: DatabaseConfig): DatabaseConfig {
  if (cfg.kind !== 'postgres') return { ...defaultConfig().database, kind: 'pglite' };
  const { readOnly: _readOnly, poolSize: _poolSize, ...out } = cfg;
  if (out.url && !out.url.startsWith('env:')) {
    let secret = false;
    try {
      secret = Boolean(new URL(out.url).password);
    } catch {
      secret = true;
    }
    if (secret) out.url = `env:${EVAL_DATABASE_URL_ENV}`;
  }
  if (out.password && !out.password.startsWith('env:')) out.password = `env:${ROOT_PASSWORD_ENV}`;
  return out;
}

/** What a new evaluation root's config holds (§2): the marker, the viewer's port, and nothing that reaches out or runs on its own. */
export function evalRootConfig(database: DatabaseConfig): KnodeConfig {
  const base = defaultConfig();
  return {
    ...base,
    database: rootDatabase(database),
    server: {
      ...base.server,
      host: '127.0.0.1',
      port: EVAL_VIEW_PORT,
      evaluation: true,
      // no remote workers' API: nothing is offered from here
      remote: { ...base.server.remote!, enabled: false },
      tls: null,
    },
    evaluation: { owner: DEFAULT_EVAL_OWNER },
    datasources: [],
    dream: { ...base.dream, schedule: 'off' },
    ingest: { ...base.ingest, watch: false },
  } as KnodeConfig;
}

function refuseLive(dir: string, rootDb: DatabaseConfig, live: DatabaseConfig, liveLabel: string): void {
  if (sameDatabase(rootDb, live)) {
    throw new Error(`the evaluation root ${dir} keeps its indexes in ${describeDatabase(rootDb)}, the database ${liveLabel} uses — an evaluation root never shares a live root's database`);
  }
}

/**
 * `knode-os eval root init`, and a run's first use of a root: make the root
 * when it is not there; refuse a folder with a config that is not an
 * evaluation root's, and a root whose database is the live one.
 */
export function initEvalRoot(dir: string, opts: { database: DatabaseConfig; live: DatabaseConfig; liveLabel?: string }): { root: EvalRoot; created: boolean } {
  const abs = path.resolve(dir);
  const liveLabel = opts.liveLabel ?? 'the live root';
  const file = path.join(abs, CONFIG_FILE);
  let created = false;
  if (fs.existsSync(file)) {
    if (!isEvaluationRoot(abs)) throw new Error(`${abs} is a data root, not an evaluation root (its ${CONFIG_FILE} has no server.evaluation: true) — evaluation builds go into a root of their own`);
  } else {
    if (fs.existsSync(abs) && fs.readdirSync(abs).some((n) => !n.startsWith('.'))) {
      throw new Error(`${abs} is not empty and holds no ${CONFIG_FILE}: name an empty folder for the evaluation root`);
    }
    const config = evalRootConfig(opts.database);
    refuseLive(abs, config.database, opts.live, liveLabel);
    fs.mkdirSync(abs, { recursive: true });
    saveConfig(abs, config);
    created = true;
  }
  const config = loadConfig(abs, { readOnly: true });
  refuseLive(abs, config.database, opts.live, liveLabel);
  const owner = evalOwner(config);
  fs.mkdirSync(path.join(abs, 'users', owner, 'workspaces'), { recursive: true });
  return { root: { dir: abs, owner, config }, created };
}

/** The root a command reads (`eval drop`, `eval adopt`'s target): it must be one. */
export function openEvalRoot(dir: string): EvalRoot {
  const abs = path.resolve(dir);
  if (!isEvaluationRoot(abs)) throw new Error(`${abs} is not an evaluation root (no ${CONFIG_FILE} with server.evaluation: true) — \`knode-os eval root init\` makes one`);
  const config = loadConfig(abs, { readOnly: true });
  return { dir: abs, owner: evalOwner(config), config };
}

/* ------------------------------ naming ------------------------------ */

/** A run's id in workspace names: its directory's name, with its parent's when that is not `runs` (`separation-2026-11/run-10x`). */
export function evalRunId(runDir: string): string {
  const abs = path.resolve(runDir);
  const base = path.basename(abs);
  const parent = path.basename(path.dirname(abs));
  return parent && parent !== 'runs' ? `${parent}-${base}` : base;
}

/** A build workspace's readable name: `<run id> · <pack>`, and the group when it is not `knode`. */
export function evalWorkspaceName(runId: string, pack: string, group = 'knode'): string {
  return [runId, pack, ...(group === 'knode' ? [] : [group])].join(' · ');
}

/**
 * A build workspace's id (its folder): `<run id>--<pack>[--<group>]` slugged as
 * `workspaceSlug` slugs; one too long for a folder name keeps its head and a
 * hash of the whole, so two long names never fold into one.
 */
export function evalWorkspaceId(runId: string, pack: string, group = 'knode'): string {
  const raw = [runId, pack, ...(group === 'knode' ? [] : [group])].join('--');
  const full = raw.normalize('NFKC').trim().toLowerCase()
    .replace(/[\s/\\]+/g, '-').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/-+/g, '-').replace(/^[._-]+|[._-]+$/g, '');
  if (full && full.length <= 64) return workspaceSlug(full);
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8);
  return workspaceSlug(`${full.slice(0, 55).replace(/[._-]+$/, '')}-${hash}`);
}

/** Where an owner's workspace `id` lives in a root. */
export function evalWorkspacePath(root: Pick<EvalRoot, 'dir' | 'owner'>, id: string): string {
  return path.join(root.dir, 'users', root.owner, 'workspaces', id);
}

/* ----------------------------- the manifest ----------------------------- */

export type EvalWorkspaceState = 'building' | 'built' | 'updating' | 'failed';

/** What `.workspace.json` says of a build (§3). */
export interface EvaluationInfo {
  run: string;
  runId: string;
  pack: string;
  packVersion: number | string;
  group: string;
  fraction: number;
  seed: string | number;
  fingerprint?: string;
  state: EvalWorkspaceState;
  batchesApplied: string[];
  builtWith: { version: string; commit: string | null; schema: number };
  models?: { build: string; embedding: string };
  /** The process that holds the workspace now; absent when none does. */
  writer?: { pid: number; since: string };
  /** Copied in by `eval adopt` from a run made before builds lived in a root. */
  adoptedFrom?: string;
  /** A copy of another run's build (`--reuse-builds-from`): that run's directory. */
  reusedFrom?: string;
  error?: string;
}

export interface EvalManifest {
  id: string;
  name: string;
  kind: 'personal';
  owner: string;
  createdAt: string;
  evaluation: EvaluationInfo;
}

const MANIFEST = '.workspace.json';

export function readEvalManifest(ws: string): EvalManifest | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(ws, MANIFEST), 'utf8')) as EvalManifest;
    return m && typeof m === 'object' && m.evaluation && typeof m.evaluation === 'object' ? m : null;
  } catch {
    return null;
  }
}

/** Written whole and renamed into place: a viewer reading it meanwhile sees the old one or the new one. */
export function writeEvalManifest(ws: string, manifest: EvalManifest): void {
  fs.mkdirSync(ws, { recursive: true });
  const tmp = path.join(ws, `${MANIFEST}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n');
  fs.renameSync(tmp, path.join(ws, MANIFEST));
}

/** Change the `evaluation` object of a build's manifest (nothing when it has none). */
export function updateEvaluation(ws: string, change: (e: EvaluationInfo) => EvaluationInfo | void): EvalManifest | null {
  const m = readEvalManifest(ws);
  if (!m) return null;
  const next = change(m.evaluation) ?? m.evaluation;
  const out = { ...m, evaluation: next };
  writeEvalManifest(ws, out);
  return out;
}

/** Whether a process is alive (a signal-0 probe: a process of another user still counts). */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The writer a manifest names, when its process is still alive; a stale one reads as none. */
export function liveWriter(e: Pick<EvaluationInfo, 'writer'>): { pid: number; since: string } | null {
  return e.writer && processAlive(e.writer.pid) ? e.writer : null;
}

/** Mark this process as the build's writer; refused while another live process holds it. */
export function claimWriter(ws: string): void {
  updateEvaluation(ws, (e) => {
    const held = liveWriter(e);
    if (held && held.pid !== process.pid) throw new Error(`the evaluation workspace ${ws} is held by process ${held.pid} since ${held.since}`);
    if (held?.pid === process.pid) return e;
    return { ...e, writer: { pid: process.pid, since: new Date().toISOString() } };
  });
}

/** Let go of the build: the writer is removed when it is this process (or a dead one). */
export function releaseWriter(ws: string): void {
  if (!fs.existsSync(path.join(ws, MANIFEST))) return;
  updateEvaluation(ws, (e) => {
    if (!e.writer || (e.writer.pid !== process.pid && liveWriter(e))) return e;
    const { writer: _writer, ...rest } = e;
    return rest as EvaluationInfo;
  });
}

/* ------------------------- a run's record of it ------------------------- */

/** `work/<pack>/<group>/workspace.json`: where a run's build is, beside the run's other records. */
export interface WorkspacePointer {
  dir: string;
  kind: string;
  schema?: string;
}

export const WORKSPACE_POINTER = 'workspace.json';

export function readWorkspacePointer(workDir: string): WorkspacePointer | null {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(workDir, WORKSPACE_POINTER), 'utf8')) as WorkspacePointer;
    return typeof p?.dir === 'string' ? p : null;
  } catch {
    return null;
  }
}

export function writeWorkspacePointer(workDir: string, pointer: WorkspacePointer): void {
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, WORKSPACE_POINTER), JSON.stringify(pointer, null, 2) + '\n');
}

/** Where a run puts its builds (docs/design/35 §3), handed to each pack's systems. */
export interface EvalRootPlacement {
  root: string;
  owner: string;
  /** The run directory, absolute: what a workspace's manifest names as its run. */
  run: string;
  runId: string;
  fraction: number;
  seed: string | number;
  builtWith: { version: string; commit: string | null; schema: number };
}

/**
 * The folder a run's build of `pack` gets in the root: its id's, unless that
 * folder is another run's (two run directories with one name), then the id
 * with a hash of this run's directory.
 */
export function placeEvalWorkspace(p: Pick<EvalRootPlacement, 'root' | 'owner' | 'run' | 'runId'>, pack: string, group = 'knode'): string {
  const id = evalWorkspaceId(p.runId, pack, group);
  const mine = (dir: string) => {
    if (!fs.existsSync(dir)) return true;
    const there = readEvalManifest(dir);
    return Boolean(there && path.resolve(there.evaluation.run) === path.resolve(p.run));
  };
  const dir = evalWorkspacePath({ dir: p.root, owner: p.owner }, id);
  if (mine(dir)) return dir;
  const alt = evalWorkspacePath({ dir: p.root, owner: p.owner }, workspaceSlug(`${id.slice(0, 57).replace(/[._-]+$/, '')}-${crypto.createHash('sha1').update(path.resolve(p.run)).digest('hex').slice(0, 6)}`));
  if (mine(alt)) return alt;
  throw new Error(`no folder for ${evalWorkspaceName(p.runId, pack, group)} in ${p.root}: ${dir} and ${alt} belong to other runs`);
}

/** A new build's manifest (state `building`, this process its writer). */
export function newEvalManifest(p: EvalRootPlacement, ws: string, info: { pack: string; packVersion: number | string; group: string; fingerprint?: string; models?: EvaluationInfo['models']; state?: EvalWorkspaceState }): EvalManifest {
  return {
    id: path.basename(ws),
    name: evalWorkspaceName(p.runId, info.pack, info.group),
    kind: 'personal',
    owner: p.owner,
    createdAt: new Date().toISOString(),
    evaluation: {
      run: path.resolve(p.run), runId: p.runId, pack: info.pack, packVersion: info.packVersion, group: info.group,
      fraction: p.fraction, seed: p.seed, ...(info.fingerprint ? { fingerprint: info.fingerprint } : {}),
      state: info.state ?? 'building', batchesApplied: [], builtWith: p.builtWith,
      ...(info.models ? { models: info.models } : {}),
      writer: { pid: process.pid, since: new Date().toISOString() },
    },
  };
}

/** Where a run's build of `pack` is: what its `workspace.json` names, else (a run made before roots) `work/<pack>/<group>/ws`. */
export function runWorkspaceDir(runDir: string, pack: string, group = 'knode'): string {
  const workDir = path.join(path.resolve(runDir), 'work', pack, group);
  return readWorkspacePointer(workDir)?.dir ?? path.join(workDir, 'ws');
}
