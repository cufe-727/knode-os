import fs from 'node:fs';
import path from 'node:path';
import { DatabaseConfig, KnodeConfig, loadConfig } from '../config.js';
import { AppContext, createContext } from '../context.js';
import type { EmbeddingProvider } from '../ingest/embeddings.js';
import { schemaNameFor } from '../store/backend.js';
import { SchemaVersionError } from '../store/db.js';
import { SCHEMA_VERSION } from '../store/migrations.js';
import { EvaluationInfo, liveWriter, readEvalManifest } from '../eval/root.js';
import type { KnodeToolOptions } from '../mcp/tools.js';
import type { WorkspaceSummary } from './workspaces.js';

/**
 * The viewer's side of an evaluation root (docs/design/35 §4): which builds
 * there are, which of them can be opened, and opening one without changing
 * it — read-only, no settings shared into it, no model behind its search.
 *
 * A build is listed and not opened when
 * - its run is still building it (`state: building`);
 * - on PGlite, a live process holds it (`writer`): an embedded index has one
 *   opener at a time (design 31 D2), and the run's is the one that counts;
 * - its index is not the one its folder names (D5): a PostgreSQL schema is
 *   named after the folder, and a name derived again from elsewhere could open
 *   an empty schema;
 * - it was built at another schema version than this viewer reads: a
 *   read-only index is never migrated.
 * A build on PostgreSQL that a run is updating opens, read-only, and says so.
 */

export interface EvaluationView extends Omit<EvaluationInfo, 'writer'> {
  /** Bytes of the workspace folder (its embedded index included; a PostgreSQL schema is not counted). */
  bytes: number;
  index: { kind: string; schema?: string };
  openable: boolean;
  /** Why it is not opened, when it is not. */
  why?: string;
  /** The process holding it now. */
  heldBy?: { pid: number; since: string };
}

interface IndexRecord {
  kind?: string;
  schema?: string;
  workspace?: string;
}

function readIndexRecord(dir: string): IndexRecord | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, '.knode', 'eval-index.json'), 'utf8')) as IndexRecord;
  } catch {
    return null;
  }
}

/** A build's database as its config file says, read without changing anything. */
function databaseOf(dir: string): DatabaseConfig | null {
  try {
    return loadConfig(dir, { readOnly: true }).database;
  } catch {
    return null;
  }
}

const sizes = new Map<string, { at: number; bytes: number }>();
const SIZE_TTL_MS = 60_000;

/** Bytes under `dir`, walked at most once a minute per folder (a large build is many files). */
function folderBytes(dir: string): number {
  const cached = sizes.get(dir);
  if (cached && Date.now() - cached.at < SIZE_TTL_MS) return cached.bytes;
  let bytes = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          bytes += fs.statSync(p).size;
        } catch {
          // gone meanwhile
        }
      }
    }
  };
  walk(dir);
  sizes.set(dir, { at: Date.now(), bytes });
  return bytes;
}

/** Whether the viewer opens the build at `dir`, and why not. */
export function evaluationOpenable(dir: string): { openable: boolean; why?: string; index: { kind: string; schema?: string }; heldBy?: { pid: number; since: string } } {
  const manifest = readEvalManifest(dir);
  const database = databaseOf(dir);
  const record = readIndexRecord(dir);
  const index = { kind: record?.kind ?? database?.kind ?? 'unknown', ...(record?.schema ? { schema: record.schema } : {}) };
  if (!manifest) return { openable: false, why: 'not an evaluation build: it has no evaluation manifest', index };
  const e = manifest.evaluation;
  const held = liveWriter(e);
  const heldBy = held ? { heldBy: held } : {};
  if (e.state === 'building') return { openable: false, why: `still being built by the run ${e.runId}${held ? ` (process ${held.pid})` : ''}`, index, ...heldBy };
  if (!database) return { openable: false, why: 'its knode.config.json cannot be read', index, ...heldBy };
  if (database.kind === 'pglite' && held) return { openable: false, why: `held by the run ${e.runId} (process ${held.pid}, since ${held.since}): an embedded index has one opener at a time`, index, ...heldBy };
  if (database.kind === 'postgres') {
    const own = schemaNameFor(dir, database.schemaPrefix || 'ws');
    if (!record?.schema) return { openable: false, why: 'it records no index (.knode/eval-index.json)', index, ...heldBy };
    if (record.schema !== own) return { openable: false, why: `its index is recorded as schema ${record.schema}, not ${own}, the schema of this folder: a copy whose index was never made its own`, index, ...heldBy };
  } else if (database.kind !== 'pglite') {
    return { openable: false, why: `database.kind "${database.kind}" cannot be opened read-only`, index, ...heldBy };
  }
  if (e.builtWith?.schema !== undefined && e.builtWith.schema !== SCHEMA_VERSION) {
    return { openable: false, why: `built at schema version ${e.builtWith.schema} (knode-os ${e.builtWith.version}${e.builtWith.commit ? `, ${e.builtWith.commit}` : ''}); this viewer reads ${SCHEMA_VERSION} and does not migrate a build`, index, ...heldBy };
  }
  return { openable: true, index, ...heldBy };
}

/**
 * Every build filed under `owner`, as the workspace list shows them: grouped
 * by run, the newest run first, each with its state, the batches it holds,
 * what built it, its size and whether it opens. Nothing is written.
 */
export function evaluationListing(root: string, owner: string): WorkspaceSummary[] {
  const parent = path.join(root, 'users', owner, 'workspaces');
  let names: string[];
  try {
    names = fs.readdirSync(parent, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  } catch {
    return [];
  }
  const items: WorkspaceSummary[] = [];
  for (const id of names) {
    const dir = path.join(parent, id);
    const manifest = readEvalManifest(dir);
    if (!manifest) continue;
    const { writer: _writer, ...info } = manifest.evaluation;
    const open = evaluationOpenable(dir);
    items.push({
      id,
      name: manifest.name || id,
      kind: 'personal',
      createdAt: manifest.createdAt,
      evaluation: { ...info, bytes: folderBytes(dir), index: open.index, openable: open.openable, ...(open.why ? { why: open.why } : {}), ...(open.heldBy ? { heldBy: open.heldBy } : {}) },
    });
  }
  // a run's builds together, the run built last first
  const newest = new Map<string, string>();
  for (const w of items) {
    const run = w.evaluation!.run;
    if ((newest.get(run) ?? '') < w.createdAt) newest.set(run, w.createdAt);
  }
  return items.sort((a, b) => {
    const ra = a.evaluation!.run;
    const rb = b.evaluation!.run;
    return (newest.get(rb) ?? '').localeCompare(newest.get(ra) ?? '') || ra.localeCompare(rb) || a.name.localeCompare(b.name);
  });
}

/** In place of the build's embedder, whose endpoint was the run's shim: query vectors come at stage 3 (§5). */
function noQueryEmbedding(model: string, dimensions: number): EmbeddingProvider {
  return {
    model,
    dimensions,
    embed: async () => {
      throw new Error('the evaluation viewer embeds no queries: search by meaning needs a model the build can no longer reach (docs/design/35 §5)');
    },
  };
}

/** A PostgreSQL build whose credential lived only in its run's environment: reached through the root's database instead. */
function reachableDatabase(own: DatabaseConfig, rootConfig: KnodeConfig | undefined): DatabaseConfig | undefined {
  if (own.kind !== 'postgres') return undefined;
  const missing = (v: string | undefined) => Boolean(v?.startsWith('env:') && !process.env[v.slice(4)]);
  if (!missing(own.url) && !missing(own.password)) return undefined;
  const root = rootConfig?.database;
  if (root?.kind !== 'postgres') throw new Error(`its database credential was in the run's environment (${[own.url, own.password].filter((v) => missing(v)).join(', ')}) and the evaluation root names no PostgreSQL to reach it with`);
  return { ...root, schemaPrefix: own.schemaPrefix, poolSize: Math.min(4, own.poolSize ?? 4) };
}

/** Open a build of the root for reading: refused when `evaluationOpenable` says no. */
export async function openEvaluationWorkspace(root: string, dir: string, rootConfig?: KnodeConfig): Promise<AppContext> {
  const open = evaluationOpenable(dir);
  if (!open.openable) throw new Error(`${path.basename(dir)} is not opened: ${open.why}`);
  const own = loadConfig(dir, { readOnly: true });
  let ctx: AppContext;
  try {
    ctx = await createContext(dir, { readOnly: true, pluginRoots: [root], database: reachableDatabase(own.database, rootConfig) });
  } catch (err) {
    if (err instanceof SchemaVersionError) {
      const e = readEvalManifest(dir)?.evaluation;
      throw new Error(`${path.basename(dir)} is not opened: ${err.message}${e?.builtWith ? ` (built with knode-os ${e.builtWith.version}${e.builtWith.commit ? `, ${e.builtWith.commit}` : ''})` : ''}`);
    }
    throw err;
  }
  ctx.embedder = noQueryEmbedding(ctx.embedder.model, ctx.embedder.dimensions);
  return ctx;
}

/**
 * The tools `/mcp` offers on an evaluation root (docs/design/35 §4): reading
 * only — search, the graph, files, claims, lineage, read-only SQL, the
 * numbers — and none that writes, asks a model or reaches out. Reading
 * records nothing (`track: false`). `knode_disputes` lists; it does not
 * resolve.
 */
export const VIEWER_TOOLS: readonly string[] = [
  'knode_search', 'knode_graph_search', 'knode_ls', 'knode_read', 'knode_grep', 'knode_lineage', 'knode_history', 'knode_okf_validate',
  'knode_graph_insights', 'knode_survey', 'knode_suggestions', 'knode_claims', 'knode_resolve', 'knode_absences', 'knode_disputes',
  'knode_capabilities', 'knode_datasources', 'knode_query',
];

export function viewerToolOptions(): KnodeToolOptions {
  return {
    only: new Set(VIEWER_TOOLS),
    track: false,
    guard: (tool, args) => {
      if (tool === 'knode_disputes' && args.action === 'resolve') throw new Error('evaluation workspaces are read-only: a dispute is not resolved here');
    },
  };
}
