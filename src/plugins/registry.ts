import path from 'node:path';
import { registerBuiltins } from './builtin.js';
import {
  DocumentConverterPlugin,
  EmbeddingProviderPlugin,
  HOOK_NAMES,
  HookName,
  KnodePlugin,
  LlmProviderPlugin,
  PipelineHooks,
  PluginApi,
  PluginSummary,
  StorageBackendPlugin,
  SYNC_HOOKS,
} from './types.js';

/**
 * The plugin registry — one per process. Providers, backends, converters and
 * hook handlers are looked up here by every facade that used to hard-code
 * them: `LlmClient`, `createEmbeddingProvider`, `openBackend`,
 * `convertDocumentToMarkdown`, and the processing stages (docs/design/11).
 *
 * Built-ins are installed on first use (src/plugins/builtin.ts); plugins named
 * in a config are installed by the loader when a context opens. A plugin that
 * registers an id a built-in holds replaces it, on purpose — that is how an
 * installation swaps, say, the OpenAI-compatible client for its own — and the
 * replacement is noted in `warnings` so `knode-os plugins` can say so.
 *
 * Nothing here runs at module-evaluation time: the registry sits in the middle
 * of the import graph (the facades import it, the built-ins it installs are
 * those facades' own implementations), and ESM only tolerates that cycle as
 * long as no module reads another's bindings while they are still loading.
 */

type AnyHandler = (...args: unknown[]) => unknown;

interface HookHandler {
  plugin: string;
  fn: AnyHandler;
}

export class PluginRegistry {
  private readonly llm = new Map<string, LlmProviderPlugin>();
  private readonly embedding = new Map<string, EmbeddingProviderPlugin>();
  private readonly storage = new Map<string, StorageBackendPlugin>();
  private readonly converters = new Map<string, DocumentConverterPlugin>();
  private readonly byExtension = new Map<string, DocumentConverterPlugin>();
  private readonly handlers = new Map<HookName, HookHandler[]>();
  private readonly summaries = new Map<string, PluginSummary>();
  /** Where a provider id came from, so a replacement can name what it replaced. */
  private readonly owners = new Map<string, string>();
  /** Replacements and other things worth a line in `knode-os plugins`. */
  readonly warnings: string[] = [];

  /* ------------------------------- lookup ------------------------------- */

  llmProvider(id: string): LlmProviderPlugin | undefined {
    return this.llm.get(id);
  }

  llmProviders(): LlmProviderPlugin[] {
    return [...this.llm.values()];
  }

  embeddingProvider(id: string): EmbeddingProviderPlugin | undefined {
    return this.embedding.get(id);
  }

  embeddingProviders(): EmbeddingProviderPlugin[] {
    return [...this.embedding.values()];
  }

  storageBackend(id: string): StorageBackendPlugin | undefined {
    return this.storage.get(id);
  }

  storageBackends(): StorageBackendPlugin[] {
    return [...this.storage.values()];
  }

  /** The converter for a source key, by its extension. */
  converterFor(rel: string): DocumentConverterPlugin | undefined {
    return this.byExtension.get(path.extname(rel).toLowerCase());
  }

  hasConverter(rel: string): boolean {
    return this.converterFor(rel) !== undefined;
  }

  converterList(): DocumentConverterPlugin[] {
    return [...this.converters.values()];
  }

  /** Every extension some converter owns. */
  convertibleExtensions(): string[] {
    return [...this.byExtension.keys()].sort();
  }

  hasHandlers(hook: HookName): boolean {
    return (this.handlers.get(hook)?.length ?? 0) > 0;
  }

  /** What was registered, in installation order (built-ins first). */
  describe(): PluginSummary[] {
    return [...this.summaries.values()].map((s) => ({ ...s, hooks: [...s.hooks] }));
  }

  /* ---------------------------- registration ---------------------------- */

  /** An API bound to one plugin, so every registration is attributed to it. */
  api(pluginName: string, log: (msg: string) => void = (msg) => console.log(`[knode-os] ${msg}`)): PluginApi {
    return {
      registerLlmProvider: (plugin) => this.registerLlmProvider(plugin, pluginName),
      registerEmbeddingProvider: (plugin) => this.registerEmbeddingProvider(plugin, pluginName),
      registerStorageBackend: (plugin) => this.registerStorageBackend(plugin, pluginName),
      registerConverter: (plugin) => this.registerConverter(plugin, pluginName),
      on: (hook, handler) => this.on(hook, handler, pluginName),
      log: (message) => log(`plugin ${pluginName}: ${message}`),
    };
  }

  registerLlmProvider(plugin: LlmProviderPlugin, owner = 'api'): void {
    const id = this.validId(plugin.id, 'LLM provider', owner);
    if (typeof plugin.create !== 'function') throw new Error(`plugin ${owner}: LLM provider "${id}" has no create()`);
    this.replacing('llm', id, owner);
    this.llm.set(id, { ...plugin, id });
    this.summary(owner).llmProviders.push(id);
  }

  registerEmbeddingProvider(plugin: EmbeddingProviderPlugin, owner = 'api'): void {
    const id = this.validId(plugin.id, 'embedding provider', owner);
    if (typeof plugin.create !== 'function') throw new Error(`plugin ${owner}: embedding provider "${id}" has no create()`);
    this.replacing('embedding', id, owner);
    this.embedding.set(id, { ...plugin, id });
    this.summary(owner).embeddingProviders.push(id);
  }

  registerStorageBackend(plugin: StorageBackendPlugin, owner = 'api'): void {
    const id = this.validId(plugin.id, 'storage backend', owner);
    if (typeof plugin.open !== 'function') throw new Error(`plugin ${owner}: storage backend "${id}" has no open()`);
    if (plugin.drop !== undefined && typeof plugin.drop !== 'function') throw new Error(`plugin ${owner}: storage backend "${id}" has a drop that is not a function`);
    this.replacing('storage', id, owner);
    this.storage.set(id, { ...plugin, id });
    this.summary(owner).storageBackends.push(id);
  }

  registerConverter(plugin: DocumentConverterPlugin, owner = 'api'): void {
    const id = this.validId(plugin.id, 'converter', owner);
    if (typeof plugin.convert !== 'function') throw new Error(`plugin ${owner}: converter "${id}" has no convert()`);
    const extensions = (Array.isArray(plugin.extensions) ? plugin.extensions : [])
      .map((e) => String(e).trim().toLowerCase())
      .filter(Boolean)
      .map((e) => (e.startsWith('.') ? e : `.${e}`));
    if (extensions.length === 0) throw new Error(`plugin ${owner}: converter "${id}" names no extensions`);
    this.replacing('converter', id, owner);
    const previous = this.converters.get(id);
    if (previous) for (const ext of previous.extensions) if (this.byExtension.get(ext) === previous) this.byExtension.delete(ext);
    const entry = { ...plugin, id, extensions };
    this.converters.set(id, entry);
    for (const ext of extensions) {
      const holder = this.byExtension.get(ext);
      if (holder && holder.id !== id) this.warnings.push(`${owner}: converter "${id}" takes ${ext} over from "${holder.id}"`);
      this.byExtension.set(ext, entry);
    }
    this.summary(owner).converters.push(id);
  }

  on<K extends HookName>(hook: K, handler: PipelineHooks[K], owner = 'api'): void {
    if (!HOOK_NAMES.includes(hook)) throw new Error(`plugin ${owner}: unknown hook "${String(hook)}" (known: ${HOOK_NAMES.join(', ')})`);
    if (typeof handler !== 'function') throw new Error(`plugin ${owner}: the handler for "${hook}" is not a function`);
    const list = this.handlers.get(hook) ?? [];
    list.push({ plugin: owner, fn: handler as AnyHandler });
    this.handlers.set(hook, list);
    const summary = this.summary(owner);
    if (!summary.hooks.includes(hook)) summary.hooks.push(hook);
  }

  /** Register what a plugin declares, without running its `setup`. */
  installSync(plugin: KnodePlugin, source: string): void {
    const name = typeof plugin?.name === 'string' ? plugin.name.trim() : '';
    if (!name) throw new Error(`plugin ${source}: a plugin needs a name`);
    const summary = this.summary(name);
    summary.source = source;
    if (plugin.version) summary.version = String(plugin.version);
    if (plugin.description) summary.description = String(plugin.description);
    for (const p of plugin.llmProviders ?? []) this.registerLlmProvider(p, name);
    for (const p of plugin.embeddingProviders ?? []) this.registerEmbeddingProvider(p, name);
    for (const p of plugin.storageBackends ?? []) this.registerStorageBackend(p, name);
    for (const p of plugin.converters ?? []) this.registerConverter(p, name);
    for (const [hook, handler] of Object.entries(plugin.hooks ?? {})) {
      if (handler) this.on(hook as HookName, handler as PipelineHooks[HookName], name);
    }
  }

  /** Register what a plugin declares, then run its `setup` with the configured options. */
  async install(plugin: KnodePlugin, source: string, options: Record<string, unknown> = {}, log?: (msg: string) => void): Promise<void> {
    this.installSync(plugin, source);
    if (typeof plugin.setup === 'function') await plugin.setup(this.api(plugin.name.trim(), log), options);
  }

  /* -------------------------------- hooks ------------------------------- */

  /**
   * Run a filter hook: each handler receives the current value and returns the
   * next one (a handler that returns undefined leaves the value as it was, so
   * an observer needs no return). Errors propagate — a wrong answer from a
   * user function must fail the document, not be indexed quietly.
   */
  async filter<K extends Exclude<HookName, 'source.text' | 'document.applied'>>(
    hook: K,
    value: Parameters<PipelineHooks[K]>[0],
    ctx: Parameters<PipelineHooks[K]>[1],
  ): Promise<Parameters<PipelineHooks[K]>[0]> {
    let current = value;
    for (const handler of this.handlers.get(hook) ?? []) {
      const out = (await handler.fn(current, ctx)) as Parameters<PipelineHooks[K]>[0] | undefined;
      if (out !== undefined) current = out;
    }
    return current;
  }

  /** The synchronous hooks (`SYNC_HOOKS`): a handler that returns a promise is a bug, reported by name. */
  filterSync<K extends 'source.text'>(hook: K, value: Parameters<PipelineHooks[K]>[0], ctx: Parameters<PipelineHooks[K]>[1]): Parameters<PipelineHooks[K]>[0] {
    if (!SYNC_HOOKS.has(hook)) throw new Error(`hook "${hook}" is asynchronous; use filter()`);
    let current = value;
    for (const handler of this.handlers.get(hook) ?? []) {
      const out = handler.fn(current, ctx) as unknown;
      if (out && typeof (out as { then?: unknown }).then === 'function') {
        throw new Error(`plugin ${handler.plugin}: '${hook}' handlers must be synchronous`);
      }
      if (out !== undefined) current = out as Parameters<PipelineHooks[K]>[0];
    }
    return current;
  }

  /** Run a notification hook. A failing handler is logged, never fatal: the stage already did its work. */
  async emit(hook: 'document.applied', event: Parameters<PipelineHooks['document.applied']>[0]): Promise<void> {
    for (const handler of this.handlers.get(hook) ?? []) {
      try {
        await handler.fn(event);
      } catch (err) {
        console.warn(`[knode-os] plugin ${handler.plugin}: '${hook}' handler failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /* ------------------------------ internals ----------------------------- */

  private validId(id: unknown, what: string, owner: string): string {
    const value = typeof id === 'string' ? id.trim() : '';
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value)) throw new Error(`plugin ${owner}: ${what} id "${String(id)}" must be letters, digits, dots, dashes or underscores`);
    if (value === 'inherit' || value === 'default') throw new Error(`plugin ${owner}: "${value}" is reserved and cannot name a ${what}`);
    return value;
  }

  private replacing(kind: 'llm' | 'embedding' | 'storage' | 'converter', id: string, owner: string): void {
    const key = `${kind}:${id}`;
    const previous = this.owners.get(key);
    if (previous && previous !== owner) {
      this.warnings.push(`${owner} replaces ${kind === 'llm' ? 'LLM provider' : kind === 'embedding' ? 'embedding provider' : kind === 'storage' ? 'storage backend' : 'converter'} "${id}" from ${previous}`);
      const summary = this.summaries.get(previous);
      if (summary) {
        const list = kind === 'llm' ? summary.llmProviders : kind === 'embedding' ? summary.embeddingProviders : kind === 'storage' ? summary.storageBackends : summary.converters;
        const at = list.indexOf(id);
        if (at >= 0) list.splice(at, 1);
      }
    }
    this.owners.set(key, owner);
  }

  private summary(name: string): PluginSummary {
    let summary = this.summaries.get(name);
    if (!summary) {
      summary = { name, source: 'api', llmProviders: [], embeddingProviders: [], storageBackends: [], converters: [], hooks: [] };
      this.summaries.set(name, summary);
    }
    return summary;
  }
}

let instance: PluginRegistry | null = null;

/** The process's registry, with the built-ins installed on first use. */
export function pluginRegistry(): PluginRegistry {
  if (!instance) {
    const registry = new PluginRegistry();
    registerBuiltins(registry);
    instance = registry;
  }
  return instance;
}

/** Tests: start over with only the built-ins. Loaded modules stay loaded (the loader keys them by URL). */
export function resetPluginRegistry(): void {
  instance = null;
}
