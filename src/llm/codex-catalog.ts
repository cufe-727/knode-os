import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A local copy of Codex's model catalog, passed as `-c model_catalog_json`, so
 * a Codex process does not download it.
 *
 * Every Codex process (CLI 0.166) downloads the whole catalog as it starts,
 * from chatgpt.com/backend-api/codex/models: 655 KB of uncompressed JSON sent
 * `no-store`, nearly all of it the models' built-in instructions. `codex exec`
 * downloads it even when Codex's own cache ($CODEX_HOME/models_cache.json,
 * five minutes) is fresh, and twice when another Codex process wrote that
 * cache; `codex app-server` downloads it as it starts too. The catalog changes
 * about once a day. On 2026-11-04 and 11-05 Codex was 73–94% of the Mac mini's
 * traffic through its paid proxy, about 8 GB a day, nearly all of it
 * knode-eval's calls.
 *
 * A copy belongs to one codex binary (its real path, size and mtime) and one
 * model, which name its file, so a Codex update or another model starts over.
 * It holds the cache's whole model list: a list with the call's model alone
 * makes Codex warn "Unknown model … fallback metadata". It lasts
 * KNODE_CODEX_CATALOG_HOURS (default 24; 0 turns copies off) and lives in
 * ~/.knode-os/codex-catalog (KNODE_CODEX_CATALOG_DIR), per machine like
 * codex-limits.json: the binary and its login are the machine's.
 *
 * A call without a copy runs as it always did: Codex downloads the catalog and
 * rewrites its cache. `refresh` then copies that cache's model list if Codex
 * wrote it in the last ten minutes, for this binary's version (the desktop
 * app's own Codex writes the same file at its own version), with the model in
 * it. A copy Codex cannot read is dropped and the call repeated once without
 * it (`withCodexCatalog`). A research session can run for an hour, long past
 * those ten minutes, so it copies the cache as soon as Codex has rewritten it.
 * A session that names no model runs the one the person's config.toml names
 * (`configuredCodexModel`), and pins that model's copy: a copy made for
 * another model (ANY_MODEL) would only prove that model was listed, and a
 * model that came out since would run on Codex's fallback metadata.
 *
 * worker/knode-worker.mjs keeps its own copy of this for remote workers, which
 * run without the rest of knode.
 */

/** How recently Codex must have written its cache for it to be copied. */
export const CODEX_CACHE_FRESH_MS = 10 * 60_000;
export const DEFAULT_CATALOG_HOURS = 24;
/** For a process that runs no model (the app-server's account read): any copy of the binary will do. */
export const ANY_MODEL = '*';
/** When a long process without a copy checks whether Codex has rewritten its cache: after 1, 2, 4 … 64 s. */
const EARLY_COPY_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000];

const PREFIX = 'codex-models-';
const HOUR_MS = 3_600_000;

const defaultCodexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

export interface CodexCatalogOptions {
  /** Where copies are kept (default $KNODE_CODEX_CATALOG_DIR, else ~/.knode-os/codex-catalog). */
  dir?: string;
  /** How long a copy lasts, in hours; 0 turns copies off (default $KNODE_CODEX_CATALOG_HOURS, else 24). */
  hours?: number;
  /** Codex's home, whose models_cache.json is copied (default $CODEX_HOME, else ~/.codex). */
  codexHome?: string;
  log?: (message: string) => void;
}

/** Lifetime in hours from KNODE_CODEX_CATALOG_HOURS: unset or unreadable is the default, 0 is off. */
export function catalogHoursFromEnv(value = process.env.KNODE_CODEX_CATALOG_HOURS): number {
  const hours = value === undefined || value.trim() === '' ? NaN : Number(value);
  return Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_CATALOG_HOURS;
}

/** The arguments that pin a copy: a TOML string, so any path survives. */
export function catalogArgs(file: string | null): string[] {
  return file ? ['-c', `model_catalog_json=${JSON.stringify(file)}`] : [];
}

const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

function readdir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** The last word `<binary> --version` prints ("codex-cli 0.166.0"), or null. Stdin is closed: nothing may wait on it. */
function codexVersion(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const words = out.trim().split(/\s+/).filter(Boolean);
      resolve(code === 0 && words.length ? words[words.length - 1] : null);
    });
  });
}

export class CodexCatalog {
  /** `codex --version` per binary stamp; a failed lookup is not kept. */
  private readonly versions = new Map<string, Promise<string | null>>();

  constructor(private readonly opts: CodexCatalogOptions = {}) {}

  get dir(): string {
    return this.opts.dir ?? (process.env.KNODE_CODEX_CATALOG_DIR || path.join(os.homedir(), '.knode-os', 'codex-catalog'));
  }

  get maxAgeMs(): number {
    const hours = this.opts.hours ?? catalogHoursFromEnv();
    return hours > 0 ? hours * HOUR_MS : 0;
  }

  private get codexHome(): string {
    return this.opts.codexHome ?? defaultCodexHome();
  }

  log(message: string): void {
    (this.opts.log ?? ((m: string) => console.warn(`[knode-os] ${m}`)))(message);
  }

  /** The binary's real path and a stamp of it (real path, size, mtime); null when it cannot be read. */
  private stamp(binary: string): { real: string; stamp: string } | null {
    try {
      const real = fs.realpathSync(binary);
      const st = fs.statSync(real, { bigint: true });
      return { real, stamp: hash(`${real}\0${st.size}\0${st.mtimeNs}`).slice(0, 16) };
    } catch {
      return null;
    }
  }

  private file(stamp: string, model: string): string {
    return path.join(this.dir, `${PREFIX}${stamp}-${hash(model).slice(0, 8)}.json`);
  }

  /** A copy's age if it is within its lifetime; a second ahead is the clock's grain (mtimes are finer), more is no copy of ours. */
  private fresh(file: string, maxAge: number): number | null {
    try {
      const age = Date.now() - fs.statSync(file).mtimeMs;
      return age > -1000 && age < maxAge ? age : null;
    } catch {
      return null;
    }
  }

  /**
   * The copy to pin for a call of `model` through `binary` (a resolved path),
   * or null: the call then downloads the catalog, and `refresh` follows. No
   * model named, nothing pinned. ANY_MODEL takes the newest copy of the binary.
   */
  pinned(binary: string | null, model: string | undefined): string | null {
    const maxAge = this.maxAgeMs;
    if (!binary || !model || maxAge <= 0) return null;
    const resolved = this.stamp(binary);
    if (!resolved) return null;
    if (model !== ANY_MODEL) {
      const file = this.file(resolved.stamp, model);
      return this.fresh(file, maxAge) === null ? null : file;
    }
    let best: { file: string; age: number } | null = null;
    for (const name of readdir(this.dir)) {
      if (!name.startsWith(`${PREFIX}${resolved.stamp}-`) || !name.endsWith('.json')) continue;
      const file = path.join(this.dir, name);
      const age = this.fresh(file, maxAge);
      if (age !== null && (!best || age < best.age)) best = { file, age };
    }
    return best?.file ?? null;
  }

  private version(real: string, stamp: string): Promise<string | null> {
    let version = this.versions.get(stamp);
    if (!version) {
      version = codexVersion(real);
      this.versions.set(stamp, version);
      void version.then((v) => {
        if (v === null) this.versions.delete(stamp);
      });
    }
    return version;
  }

  /**
   * After a call without a copy: copy the model list from Codex's cache, if
   * Codex wrote it in the last ten minutes, for this binary's version, with
   * `model` in it (ANY_MODEL: any list). Never throws.
   */
  async refresh(binary: string | null, model: string | undefined): Promise<void> {
    try {
      await this.save(binary, model);
    } catch (err) {
      this.log(`codex model catalog not saved: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async save(binary: string | null, model: string | undefined): Promise<void> {
    const maxAge = this.maxAgeMs;
    if (!binary || !model || maxAge <= 0) return;
    const resolved = this.stamp(binary);
    if (!resolved) return;
    const source = path.join(this.codexHome, 'models_cache.json');
    let cache: unknown;
    try {
      if (Date.now() - fs.statSync(source).mtimeMs > CODEX_CACHE_FRESH_MS) return;
      cache = JSON.parse(fs.readFileSync(source, 'utf8'));
    } catch {
      return;
    }
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return;
    const { models, client_version: written } = cache as { models?: unknown; client_version?: unknown };
    if (!Array.isArray(models) || models.length === 0) return;
    const named = (m: unknown) => Boolean(m) && typeof m === 'object' && (m as { slug?: unknown }).slug === model;
    if (model !== ANY_MODEL && !models.some(named)) return;
    const version = await this.version(resolved.real, resolved.stamp);
    if (!version || written !== version) return;
    const target = this.file(resolved.stamp, model);
    // a temp file and a rename: an eval run starts many Codex processes at once, and none may read half a copy
    const partial = `${target}.${process.pid}-${crypto.randomUUID().slice(0, 8)}.part`;
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      fs.writeFileSync(partial, JSON.stringify({ models }));
      fs.renameSync(partial, target);
    } catch (err) {
      fs.rmSync(partial, { force: true });
      throw err;
    }
    this.sweep(maxAge);
    this.log(`codex model catalog saved for ${maxAge / HOUR_MS} h: ${models.length} models for ${model === ANY_MODEL ? 'any model' : model}, codex ${version}`);
  }

  /**
   * For a process that may outlive the ten minutes a cache counts as fresh (a
   * research session runs up to an hour): copy Codex's cache as soon as Codex
   * has rewritten it, checking after 1, 2, 4 … 64 s, until a copy is there.
   * Returns what stops the checks.
   */
  copyWhenWritten(binary: string | null, model: string | undefined): () => void {
    if (!binary || !model || this.maxAgeMs <= 0) return () => {};
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    const next = (i: number) => {
      if (stopped || i >= EARLY_COPY_MS.length) return;
      timer = setTimeout(() => {
        void this.refresh(binary, model).then(() => {
          if (!this.pinned(binary, model)) next(i + 1);
        });
      }, EARLY_COPY_MS[i]);
      timer.unref();
    };
    next(0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }

  /** Whether a copy lists each of `models` (a session's sub-agents may run models of their own); false when it cannot be read. */
  lists(file: string, models: string[]): boolean {
    if (!models.length) return true;
    try {
      const { models: list } = JSON.parse(fs.readFileSync(file, 'utf8')) as { models?: unknown };
      if (!Array.isArray(list)) return false;
      const slugs = new Set(list.map((m) => (m && typeof m === 'object' ? (m as { slug?: unknown }).slug : undefined)));
      return models.every((m) => slugs.has(m));
    } catch {
      return false;
    }
  }

  /**
   * Drop copies long past their lifetime (another binary's or model's; twice
   * the lifetime, so none goes while a call that pinned it still runs) and
   * temp files a crashed writer left.
   */
  private sweep(maxAge: number): void {
    const now = Date.now();
    for (const name of readdir(this.dir)) {
      if (!name.startsWith(PREFIX)) continue;
      const limit = name.endsWith('.part') ? HOUR_MS : Math.max(2 * maxAge, maxAge + HOUR_MS);
      const file = path.join(this.dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > limit) fs.rmSync(file, { force: true });
      } catch {
        // gone already
      }
    }
  }

  /**
   * Whether a failed call failed because of its copy: Codex could not parse it
   * (its stderr names model_catalog_json; the copy is dropped) or the copy was
   * gone ("No such file or directory (os error 2)").
   */
  rejected(file: string, stderr: string): boolean {
    if (stderr.includes('model_catalog_json')) {
      fs.rmSync(file, { force: true });
      return true;
    }
    return !fs.existsSync(file);
  }
}

/** The copies every knode Codex call shares; settings come from the environment at each call. */
export const codexCatalog = new CodexCatalog();

const errorText = (err: unknown) =>
  (err && typeof err === 'object' && typeof (err as { stderr?: unknown }).stderr === 'string' ? (err as { stderr: string }).stderr : '') ||
  (err instanceof Error ? err.message : String(err));

/**
 * Run one Codex process with the catalog copy, if there is a usable one;
 * otherwise as before, then refresh the copy. `run` gets the copy's path, or
 * null, to pass on with `catalogArgs`. A run that failed because of the copy
 * is repeated once without it; any other failure is returned (or thrown) as
 * it is. `failed` says what a finished run printed on stderr if it failed,
 * null if it did not; a thrown error carries its stderr as `stderr` or in its
 * message. `binary` is the resolved codex path: null, nothing is pinned and
 * the run fails as it always did. `long`: the run may outlive the ten minutes
 * a cache counts as fresh, so the copy is made as soon as Codex rewrites its
 * cache (`copyWhenWritten`), and again at the end if that found none.
 */
export async function withCodexCatalog<R>(
  binary: string | null,
  model: string | undefined,
  run: (catalog: string | null) => Promise<R>,
  failed: (result: R) => string | null,
  catalog: CodexCatalog = codexCatalog,
  opts: { long?: boolean } = {},
): Promise<R> {
  const pinned = catalog.pinned(binary, model);
  const unpinned = async () => {
    const stop = opts.long ? catalog.copyWhenWritten(binary, model) : () => {};
    try {
      return await run(null);
    } finally {
      stop();
      await catalog.refresh(binary, model);
    }
  };
  if (!pinned) return unpinned();
  let stderr: string | null;
  try {
    const result = await run(pinned);
    stderr = failed(result);
    if (stderr === null || !catalog.rejected(pinned, stderr)) return result;
  } catch (err) {
    stderr = errorText(err);
    if (!catalog.rejected(pinned, stderr)) throw err;
  }
  const said = stderr.trim();
  catalog.log(`codex could not read the saved model catalog, calling without it: ${said.length > 300 ? `…${said.slice(-300)}` : said}`);
  return unpinned();
}

/** `withCodexCatalog` for a process result: failed when its exit code is not 0. */
export function exitFailure(result: { code: number; stderr: string }): string | null {
  return result.code === 0 ? null : result.stderr;
}

/**
 * The model a Codex process that names none runs, from the person's
 * configuration: `model` in $CODEX_HOME/config.toml, or in the
 * `[profiles.<name>]` table its `profile` picks. Null when the file names
 * none, or picks a profile it does not hold, or cannot be read: Codex then
 * runs a default of its own, which no copy can be checked for.
 */
export function configuredCodexModel(codexHome = defaultCodexHome()): string | null {
  try {
    return modelFromCodexConfig(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
  } catch {
    return null;
  }
}

/** A TOML basic string's escapes, as far as JSON shares them; anything else is kept as written. */
function unescapeBasic(text: string): string {
  try {
    return JSON.parse(`"${text}"`) as string;
  } catch {
    return text;
  }
}

/** `configuredCodexModel` for the text of a config.toml: the top-level keys and the profile tables, nothing else of TOML. */
export function modelFromCodexConfig(toml: string): string | null {
  const top: { model?: string; profile?: string } = {};
  const profiles = new Map<string, string | null>();
  let table: string | null = '';
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      const header = /^\[\s*([^[\]]+?)\s*\](?:\s*#.*)?$/.exec(line);
      // an array of tables, or a header this reader does not follow: nothing under it is read
      table = header ? header[1] : null;
      const profile = table ? /^profiles\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))$/.exec(table) : null;
      if (profile) {
        table = `profile:${profile[1] ?? profile[2] ?? profile[3]}`;
        if (!profiles.has(table)) profiles.set(table, null);
      }
      continue;
    }
    const kv = /^(model|profile)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
    if (!kv || table === null) continue;
    const value = kv[3] ?? unescapeBasic(kv[2]);
    if (table === '') top[kv[1] as 'model' | 'profile'] = value;
    else if (table.startsWith('profile:') && kv[1] === 'model') profiles.set(table, value);
  }
  if (top.profile) {
    const key = `profile:${top.profile}`;
    if (!profiles.has(key)) return null;
    return profiles.get(key) || top.model || null;
  }
  return top.model || null;
}
