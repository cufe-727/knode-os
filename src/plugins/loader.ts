import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pluginRegistry } from './registry.js';
import { KnodePlugin, PluginSpec } from './types.js';

/**
 * Loading the plugins a config names (`plugins` in knode.config.json, plus
 * the `KNODE_PLUGINS` environment variable: comma-separated module specs).
 *
 * A module is imported once per process, however many workspaces name it —
 * the registry is process-wide, and a provider or hook registered twice would
 * run twice. The first config to load a module hands it its `options`; the
 * others share that installation. A module that cannot be imported, or whose
 * default export is not a plugin, fails the context that asked for it: a
 * storage backend or embedding provider the config relies on cannot be
 * substituted quietly.
 */

/** Resolved module URL → the plugin's name, once installed. */
const loaded = new Map<string, Promise<string>>();

/**
 * Where a `module` spec points. A path (`./plugins/x.mjs`, `../shared/x.js`,
 * `/abs/x.mjs`, `~/x.mjs`) is taken relative to the data directory; a bare
 * package name is resolved from the data directory's own `node_modules`
 * first, and left to Node's resolution from knode-os's install otherwise.
 *
 * `roots` are tried after the data directory, in order, for a relative path or
 * package that is not there: a workspace under `serve` carries a copy of the
 * root data directory's config, and `./plugins/x.mjs` in that copy means the
 * file beside the root config, not one in every workspace.
 */
export function resolvePluginModule(dataDir: string, spec: string, roots: string[] = []): string {
  const module = spec.trim();
  if (!module) throw new Error('plugins[].module is empty');
  if (/^(file|node|data):/.test(module)) return module;
  if (module.startsWith('~/') || module === '~') return pathToFileURL(path.join(os.homedir(), module.slice(1))).href;
  const bases = [path.resolve(dataDir), ...roots.map((r) => path.resolve(r)).filter((r) => r !== path.resolve(dataDir))];
  if (module.startsWith('.') || path.isAbsolute(module)) {
    const candidates = bases.map((base) => path.resolve(base, module));
    return pathToFileURL(candidates.find((abs) => fs.existsSync(abs)) ?? candidates[0]).href;
  }
  for (const base of bases) {
    try {
      return pathToFileURL(createRequire(path.join(base, 'package.json')).resolve(module)).href;
    } catch {
      // not installed under this base
    }
  }
  return module;
}

/** The specs to load: the enabled config entries, then anything `KNODE_PLUGINS` adds. */
export function configuredPluginSpecs(specs: PluginSpec[] | undefined, env: NodeJS.ProcessEnv = process.env): PluginSpec[] {
  const out: PluginSpec[] = [];
  for (const spec of specs ?? []) {
    if (!spec || typeof spec.module !== 'string' || !spec.module.trim() || spec.enabled === false) continue;
    out.push({ module: spec.module.trim(), options: spec.options && typeof spec.options === 'object' ? spec.options : {} });
  }
  for (const module of (env.KNODE_PLUGINS ?? '').split(',').map((m) => m.trim()).filter(Boolean)) {
    if (!out.some((s) => s.module === module)) out.push({ module, options: {} });
  }
  return out;
}

export interface LoadPluginsOptions {
  log?: (msg: string) => void;
  /** Further directories a relative module path or a package is looked for in (see `resolvePluginModule`). */
  roots?: string[];
}

/** Load (once) and install every plugin the specs name. Returns their names in config order. */
export async function loadPlugins(dataDir: string, specs: PluginSpec[] | undefined, opts: LoadPluginsOptions = {}): Promise<string[]> {
  const names: string[] = [];
  for (const spec of configuredPluginSpecs(specs)) {
    const url = resolvePluginModule(dataDir, spec.module, opts.roots ?? []);
    let pending = loaded.get(url);
    if (!pending) {
      pending = importPlugin(url, spec, opts.log);
      loaded.set(url, pending);
      // a failed load is not remembered: fixing the file and reopening the workspace tries again
      pending.catch(() => loaded.delete(url));
    }
    names.push(await pending);
  }
  return names;
}

async function importPlugin(url: string, spec: PluginSpec, log?: (msg: string) => void): Promise<string> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(url)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`plugin ${spec.module}: cannot load — ${err instanceof Error ? err.message : String(err)}`);
  }
  const candidate = (mod.default ?? mod.plugin) as KnodePlugin | undefined;
  if (!candidate || typeof candidate !== 'object' || typeof candidate.name !== 'string' || !candidate.name.trim()) {
    throw new Error(`plugin ${spec.module}: the default export must be an object with a name (and any of llmProviders, embeddingProviders, storageBackends, converters, hooks, setup)`);
  }
  try {
    await pluginRegistry().install(candidate, spec.module, spec.options ?? {}, log);
  } catch (err) {
    throw new Error(`plugin ${spec.module}: ${err instanceof Error ? err.message : String(err)}`);
  }
  log?.(`plugin ${candidate.name} loaded from ${spec.module}`);
  return candidate.name.trim();
}

