import fs from 'node:fs';
import path from 'node:path';
import { defaultConfig, loadConfig } from '../config.js';
import { pgliteLockPath } from '../store/backend.js';
import { SchemaVersionError, Store } from '../store/db.js';
import { SCHEMA_VERSION } from '../store/migrations.js';
import { cloneSchema, describeDatabase, evalDatabase } from './database.js';
import { packsDir } from './pack.js';
import { EvalManifest, evalRootDir, evalRunId, evalWorkspaceName, initEvalRoot, liveDatabase, processAlive, placeEvalWorkspace, readEvalManifest, writeEvalManifest } from './root.js';
import { RunStore } from './runstore.js';

/**
 * `knode-os eval adopt <runDir>` (docs/design/35 §3): the knode builds of a
 * run made before evaluation roots — `work/<pack>/<group>/ws` — copied into
 * the root as workspaces, so the viewer can open them. The run directory is
 * not changed: the run still resumes on its own layout, and its builds stay
 * where they are. A build is copied whole (an embedded index with its
 * folder; a PostgreSQL schema cloned into the copy's own), and a build
 * already adopted is left as it is.
 */

interface IndexRecord {
  kind?: string;
  schema?: string;
  workspace?: string;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** The schema version an embedded index was written at, read without changing it. */
async function pgliteSchemaVersion(ws: string, dimensions: number): Promise<number | null> {
  try {
    const store = await Store.open(ws, dimensions, { ...defaultConfig().database, kind: 'pglite' }, { readOnly: true });
    await store.close();
    return SCHEMA_VERSION;
  } catch (err) {
    return err instanceof SchemaVersionError ? err.found : null;
  }
}

export async function adoptRun(runDir: string, opts: { root?: string; url?: string; log?: (m: string) => void } = {}): Promise<string[]> {
  const log = opts.log ?? (() => {});
  const run = path.resolve(runDir);
  const store = new RunStore(run);
  const meta = store.meta();
  if (!meta) throw new Error(`not a run directory: ${run}`);
  if (meta.workspaces === 'root') throw new Error(`run ${meta.id} keeps its builds in the evaluation root already (${meta.evalRoot})`);
  const onPostgres = meta.database?.kind === 'postgres';
  const { root } = initEvalRoot(evalRootDir(opts.root), {
    database: onPostgres ? evalDatabase(defaultConfig().database, { url: opts.url }) : { ...defaultConfig().database, kind: 'pglite' },
    live: liveDatabase(),
    liveLabel: 'the default data root',
  });
  const runId = evalRunId(run);
  const place = { root: root.dir, owner: root.owner, run, runId };
  const adopted: string[] = [];
  const work = path.join(run, 'work');
  if (!fs.existsSync(work)) return adopted;
  for (const pack of fs.readdirSync(work).sort()) {
    for (const group of fs.readdirSync(path.join(work, pack)).sort()) {
      const source = path.join(work, pack, group, 'ws');
      if (!fs.existsSync(path.join(source, 'knode.config.json'))) continue;
      const dest = placeEvalWorkspace(place, pack, group);
      if (readEvalManifest(dest)?.evaluation.adoptedFrom === source) {
        log(`${pack}/${group}: adopted already, as ${path.basename(dest)}`);
        adopted.push(dest);
        continue;
      }
      const config = loadConfig(source, { readOnly: true });
      // a build its run has open is mid-write: not copied
      const lock = readJson<{ pid?: number }>(pgliteLockPath(source, config.database));
      if (config.database.kind === 'pglite' && lock?.pid && processAlive(lock.pid)) {
        throw new Error(`${source} is open in process ${lock.pid}: stop that run before adopting its builds`);
      }
      // copied beside the target and renamed into place: a viewer never sees half a build
      const staging = path.join(path.dirname(dest), `.adopting-${path.basename(dest)}-${process.pid}`);
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(source, staging, { recursive: true, filter: (src) => path.basename(src) !== 'db.lock' });
      const record = readJson<IndexRecord>(path.join(source, '.knode', 'eval-index.json'));
      let schemaVersion: number | null;
      let index: IndexRecord;
      try {
        fs.rmSync(dest, { recursive: true, force: true });
        fs.renameSync(staging, dest);
        if (config.database.kind === 'postgres') {
          if (!record?.schema) throw new Error(`${source} records no schema (.knode/eval-index.json): nothing to clone`);
          const cfg = opts.url ? evalDatabase(config.database, { url: opts.url }) : config.database;
          if (cfg.url?.startsWith('env:') && !process.env[cfg.url.slice(4)]) throw new Error(`${source}: its database URL was in the run's environment (${cfg.url.slice(4)}) — pass --database-url`);
          const cloned = await cloneSchema(cfg, record.schema, dest, config.embedding.dimensions);
          log(`${pack}/${group}: cloned schema ${record.schema} into ${cloned.schema} in ${describeDatabase(cfg)} (${cloned.rows} rows)`);
          index = { kind: 'postgres', schema: cloned.schema, workspace: dest };
          schemaVersion = SCHEMA_VERSION;
        } else {
          index = { kind: config.database.kind, workspace: dest };
          schemaVersion = await pgliteSchemaVersion(dest, config.embedding.dimensions);
        }
      } catch (err) {
        fs.rmSync(staging, { recursive: true, force: true });
        fs.rmSync(dest, { recursive: true, force: true });
        throw err;
      }
      // the copy's index is its own: what the viewer checks the folder against
      fs.writeFileSync(path.join(dest, '.knode', 'eval-index.json'), JSON.stringify(index, null, 2));
      const progress = readJson<{ fingerprint?: string }>(path.join(source, '.knode', 'eval-build.json'));
      const packVersion = readJson<{ version?: number | string }>(path.join(packsDir(), pack, 'pack.json'))?.version ?? 'unknown';
      const batches = store.allBuilds().filter((b) => b.pack === pack && b.ok && b.system.startsWith(`${group}@`)).map((b) => b.system.slice(group.length + 1)).sort();
      const manifest: EvalManifest = {
        id: path.basename(dest),
        name: evalWorkspaceName(runId, pack, group),
        kind: 'personal',
        owner: root.owner,
        createdAt: store.allBuilds().find((b) => b.pack === pack && b.system === group)?.at ?? meta.createdAt,
        evaluation: {
          run, runId, pack, packVersion, group, fraction: meta.fraction, seed: meta.seed,
          ...(progress?.fingerprint ? { fingerprint: progress.fingerprint } : {}),
          state: 'built', batchesApplied: [...new Set(batches)],
          builtWith: { version: meta.knodeVersion, commit: meta.gitSha?.slice(0, 12) ?? null, schema: schemaVersion ?? -1 },
          models: { build: meta.model.label || meta.model.connection, embedding: meta.embedding },
          adoptedFrom: source,
        },
      };
      writeEvalManifest(dest, manifest);
      log(`${pack}/${group}: adopted as ${manifest.id}${schemaVersion !== null && schemaVersion !== SCHEMA_VERSION ? ` (built at schema version ${schemaVersion}: this version's viewer lists it and does not open it)` : ''}`);
      adopted.push(dest);
    }
  }
  return adopted;
}
