import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EmbeddingConfig, isCliProvider, LlmConfig, resolveSecret } from '../config.js';
import { pluginRegistry } from '../plugins/registry.js';
import { CLI_COMMANDS, cliCommand, resolveExecutable, runProcess } from './cli.js';

/**
 * Model discovery for the Settings UI: what can actually be typed into a
 * `model` field for the provider that field is pointed at.
 *
 * Three sources, in descending order of truth:
 *   - `api`     — the provider's own `GET /models` (OpenAI-compatible endpoints)
 *   - `cli`     — the coding-agent CLI listed them (`cursor-agent --list-models`,
 *                 `codex debug models`)
 *   - `builtin` — neither exists, so these are hints knode reads off the CLI's
 *                 own help text or config file. The field stays free text.
 */

export interface ModelOption {
  id: string;
  label?: string;
  /**
   * The reasoning efforts this model accepts, lowest first, when the provider
   * says — today only `codex debug models` does. Absent = unknown, and the
   * client offers the CLI's whole ladder instead.
   */
  efforts?: Array<{ id: string; description?: string }>;
  /** The effort it runs at when none is set. */
  defaultEffort?: string;
  /** Speeds beyond standard it offers, e.g. `{ id: 'fast', name: 'Fast', description: '2x speed, increased usage' }`. */
  speeds?: Array<{ id: string; name?: string; description?: string }>;
}

export interface ModelListResult {
  ok: boolean;
  source: 'api' | 'cli' | 'builtin';
  models: ModelOption[];
  /** CLI providers: the command that would run, and where it resolved to. */
  command?: string;
  resolvedPath?: string;
  note?: string;
  error?: string;
  /**
   * What the CLI runs when knode names nothing, read off its own config — so
   * an empty field or a "default" effort can say what it amounts to. Only
   * codex has a file that says (`~/.codex/config.toml`).
   */
  defaults?: CliDefaults;
}

export interface CliDefaults {
  model?: string;
  effort?: string;
  /** 'fast' when the CLI asks for its priority tier on its own. */
  speed?: string;
}

const LIST_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 20_000;

/** The `claude --model` family aliases. Its help text names two or three of them as examples. */
const CLAUDE_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'];

export async function listChatModels(cfg: LlmConfig): Promise<ModelListResult> {
  // a plugin provider says what it offers, or says nothing and the field stays free text
  const plugin = pluginRegistry().llmProvider(cfg.provider);
  if (plugin?.listModels) {
    try {
      return await plugin.listModels(cfg);
    } catch (e) {
      return { ok: false, source: 'api', models: [], error: message(e) };
    }
  }
  if (cfg.provider === 'openai') {
    try {
      return await listOpenAiModels(cfg.baseUrl, cfg.apiKey);
    } catch (e) {
      return { ok: false, source: 'api', models: [], error: message(e) };
    }
  }
  if (cfg.provider === 'command') {
    return { ok: true, source: 'builtin', models: [], note: 'A command takes any model name: it is passed through as `model` in the request and as $KNODE_LLM_MODEL.' };
  }
  if (!isCliProvider(cfg.provider)) {
    return plugin
      ? { ok: true, source: 'builtin', models: [], note: `${plugin.label} lists no models — type a model id.` }
      : { ok: false, source: 'builtin', models: [], error: `unknown provider: ${cfg.provider}` };
  }
  const command = cliCommand(cfg.provider, cfg.cliPath);
  const resolvedPath = resolveExecutable(command);
  const base = { command, resolvedPath: resolvedPath ?? undefined };
  if (!resolvedPath) {
    return {
      ...base,
      ok: false,
      source: 'cli',
      models: [],
      error: command.includes('/')
        ? `${command} is not an executable file`
        : `${command} was not found on the service PATH — install it, or point the CLI executable field at it`,
    };
  }
  try {
    if (cfg.provider === 'cursor-cli') return { ...base, ...(await listCursorModels(resolvedPath)) };
    if (cfg.provider === 'claude-cli') return { ...base, ...(await listClaudeAliases(resolvedPath)) };
    if (cfg.provider === 'codex-cli') return { ...base, ...(await listCodexModels(resolvedPath)) };
    return { ...base, ok: false, source: 'builtin', models: [], error: `unknown provider: ${cfg.provider}` };
  } catch (e) {
    return { ...base, ok: false, source: 'cli', models: [], error: message(e) };
  }
}

export async function listEmbeddingModels(cfg: EmbeddingConfig): Promise<ModelListResult> {
  const plugin = pluginRegistry().embeddingProvider(cfg.provider);
  if (plugin?.listModels) {
    try {
      return await plugin.listModels(cfg);
    } catch (e) {
      return { ok: false, source: 'api', models: [], error: message(e) };
    }
  }
  if (cfg.provider === 'local') {
    return { ok: true, source: 'builtin', models: [], note: 'The local hashing embedder has no model to choose.' };
  }
  if (cfg.provider === 'ark-multimodal') {
    return {
      ok: false,
      source: 'builtin',
      models: [],
      note: 'Ark endpoints are created in the Ark console and are not listable — paste the endpoint id (ep-…).',
    };
  }
  if (cfg.provider !== 'openai') {
    return plugin
      ? { ok: true, source: 'builtin', models: [], note: `${plugin.label} lists no models — type a model id.` }
      : { ok: false, source: 'builtin', models: [], error: `unknown provider: ${cfg.provider}` };
  }
  try {
    const base = cfg.baseUrl.replace(/\/+$/, '');
    const url = new URL(base);
    let catalogUrl: string | undefined;
    let cloudflare = false;
    if (url.hostname === 'api.siliconflow.cn' || url.hostname === 'api.siliconflow.com') catalogUrl = `${base}/models?sub_type=embedding`;
    if (url.hostname === 'openrouter.ai') catalogUrl = `${base}/embeddings/models`;
    if (url.hostname === 'api.cloudflare.com' && /\/accounts\/[^/]+\/ai\/v1$/.test(url.pathname)) {
      catalogUrl = base.replace(/\/ai\/v1$/, '/ai/models/search?per_page=100');
      cloudflare = true;
    }
    if (catalogUrl) {
      const response = await fetch(catalogUrl, {
        headers: { Authorization: `Bearer ${resolveSecret(cfg.apiKey)}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Embedding model discovery returned HTTP ${response.status}`);
      const body = await response.json() as { data?: { id: string; name?: string }[];
        result?: { name: string; task?: { name?: string } }[] };
      const models = cloudflare
        ? (body.result ?? []).filter((m) => /text.embeddings/i.test(m.task?.name ?? '')).map((m) => ({ id: m.name }))
        : (body.data ?? []).filter((m) => typeof m.id === 'string').map((m) => ({ id: m.id, label: m.name }));
      return { ok: true, source: 'api', models: models.sort((a, b) => a.id.localeCompare(b.id)) };
    }
    const all = await listOpenAiModels(cfg.baseUrl, cfg.apiKey);
    const embedding = all.models.filter((m) => /embed|(?:^|\/)bge-(?!reranker)|(?:^|\/)e5-/i.test(m.id));
    if (embedding.length) return { ...all, models: embedding };
    return { ...all, note: 'No model id looked like an embedding model, so every model the endpoint returned is listed.' };
  } catch (e) {
    return { ok: false, source: 'api', models: [], error: message(e) };
  }
}

/** PATH resolution for every CLI provider, so Settings can hide the path field when it is redundant. */
export function cliToolStatus(): Array<{ provider: string; command: string; path: string | null }> {
  return Object.entries(CLI_COMMANDS).map(([provider, command]) => ({
    provider,
    command,
    path: resolveExecutable(command),
  }));
}

async function listOpenAiModels(baseUrl: string, apiKey: string): Promise<ModelListResult> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const key = resolveSecret(apiKey);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : '';
    throw new Error(`GET ${url} failed — ${message(e)}${cause}`);
  }
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${(await res.text()).trim().slice(0, 200)}`);
  const body = (await res.json()) as { data?: Array<{ id?: unknown; owned_by?: unknown }> };
  const models: ModelOption[] = (body.data ?? [])
    .flatMap((m): ModelOption[] => {
      if (typeof m.id !== 'string' || !m.id) return [];
      const owner = typeof m.owned_by === 'string' && m.owned_by !== 'system' ? m.owned_by : undefined;
      return [owner ? { id: m.id, label: owner } : { id: m.id }];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return { ok: true, source: 'api', models };
}

/** `cursor-agent --list-models` prints `<id> - <label>` lines under a header. */
async function listCursorModels(command: string): Promise<ModelListResult> {
  const { code, stdout, stderr } = await runProcess(command, ['--list-models'], '', LIST_TIMEOUT_MS);
  if (code !== 0) throw new Error(`cursor-agent --list-models exited with code ${code}: ${(stderr || stdout).trim().slice(0, 300)}`);
  const models: ModelOption[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\S+)\s+-\s+(.+?)\s*$/.exec(line);
    if (match) models.push({ id: match[1], label: match[2] });
  }
  if (!models.length) throw new Error('cursor-agent --list-models returned no models');
  return { ok: true, source: 'cli', models };
}

/**
 * Claude Code has no list command; its `--model` help documents the family
 * aliases, so read them from there.
 *
 * What that text carries is examples — "an alias for the latest model (e.g.
 * 'fable', 'opus', or 'sonnet')" — not the catalog, so the families knode
 * knows about are merged in behind whatever it named rather than replaced by
 * them. The CLI's own order comes first, since it reflects that CLI.
 */
async function listClaudeAliases(command: string): Promise<ModelListResult> {
  let aliases: string[] = [];
  try {
    const { stdout } = await runProcess(command, ['--help'], '', LIST_TIMEOUT_MS);
    aliases = parseClaudeAliases(stdout);
  } catch {
    // fall through to the documented set
  }
  const unique = [...new Set([...aliases, ...CLAUDE_ALIASES])];
  return {
    ok: true,
    source: aliases.length ? 'cli' : 'builtin',
    models: unique.map((id) => ({ id, label: 'alias · latest model of the family' })),
    note: 'Claude Code takes a family alias or any full model id (e.g. claude-fable-5). Leave the field empty to use the CLI default.',
  };
}

/** The quoted aliases in `claude --help`, minus the full model ids it also shows. */
export function parseClaudeAliases(help: string): string[] {
  const description = /--model <model>([\s\S]*?)\n\s*(?:-\w,|--\w)/.exec(help)?.[1] ?? '';
  return [...description.matchAll(/'([a-z][a-z0-9.\-]*)'/g)].map((m) => m[1]).filter((a) => !a.includes('-'));
}

/**
 * `codex debug models` renders the catalog the CLI itself picks from, which is
 * the whole answer when it is there. It arrived in a 2026 release, so an older
 * CLI (or one that cannot reach its catalog) still falls back to the models
 * `~/.codex/config.toml` names — which is all knode could ever see before.
 */
async function listCodexModels(command: string): Promise<ModelListResult> {
  const defaults = codexDefaults();
  try {
    const { code, stdout, stderr } = await runProcess(command, ['debug', 'models'], '', LIST_TIMEOUT_MS);
    if (code !== 0) throw new Error((stderr || stdout).trim().slice(0, 200) || `exited with code ${code}`);
    const models = parseCodexCatalog(stdout);
    if (!models.length) throw new Error('the catalog listed no model this CLI offers');
    return {
      ok: true,
      source: 'cli',
      models,
      // no note: the source says where the list came from, and the list's
      // first row says what an empty field runs
      ...(defaults ? { defaults } : {}),
    };
  } catch (e) {
    return { ...codexConfiguredModels(message(e)), ...(defaults ? { defaults } : {}) };
  }
}

const CODEX_CONFIG = () => path.join(os.homedir(), '.codex', 'config.toml');

function codexDefaults(): CliDefaults | undefined {
  try {
    return parseCodexDefaults(fs.readFileSync(CODEX_CONFIG(), 'utf8'));
  } catch {
    return undefined; // no config file: the CLI's built-in defaults, which nothing here can name
  }
}

/**
 * The model, effort and tier `codex exec` falls back to, from its config: the
 * top-level keys, overridden by the `[profiles.<name>]` a top-level `profile`
 * selects. Undefined when the file sets none of them.
 */
export function parseCodexDefaults(toml: string): CliDefaults | undefined {
  const top: Record<string, string> = {};
  const profiles: Record<string, Record<string, string>> = {};
  let section: Record<string, string> | null = top;
  for (const line of toml.split('\n')) {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) {
      const profile = /^profiles\.(.+)$/.exec(header[1].trim());
      section = profile ? (profiles[profile[1].replace(/^["']|["']$/g, '')] ??= {}) : null;
      continue;
    }
    const pair = /^\s*([A-Za-z_]+)\s*=\s*["']([^"']*)["']/.exec(line);
    if (pair && section) section[pair[1]] = pair[2];
  }
  const merged = { ...top, ...(top.profile ? profiles[top.profile] : undefined) };
  const out: CliDefaults = {};
  if (merged.model) out.model = merged.model;
  if (merged.model_reasoning_effort) out.effort = merged.model_reasoning_effort;
  // 'priority' is the id the catalog gives the tier it names Fast
  if (merged.service_tier === 'fast' || merged.service_tier === 'priority') out.speed = 'fast';
  return Object.keys(out).length ? out : undefined;
}

/**
 * The listable models in a `codex debug models` payload, in the order the CLI
 * ranks them. `hide` covers the catalog's internal entries — a reserve model,
 * the one auto-review runs on — which the CLI does not offer either.
 *
 * Each keeps what the effort control needs from its entry: the levels it
 * accepts, the one it defaults to, and the speed tiers beyond standard. The
 * tier is named the way `additional_speed_tiers` names it (`fast`) — what
 * `service_tier` takes — and described by the matching `service_tiers` entry.
 */
export function parseCodexCatalog(stdout: string): ModelOption[] {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON object in the output');
  const body = JSON.parse(stdout.slice(start, end + 1)) as { models?: unknown };
  const rows = Array.isArray(body.models) ? body.models : [];
  const ranked: Array<{ option: ModelOption; priority: number }> = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const model = row as Record<string, unknown>;
    const id = typeof model.slug === 'string' ? model.slug : '';
    if (!id || model.visibility === 'hide') continue;
    const label = typeof model.display_name === 'string' && model.display_name ? model.display_name : id;
    const option: ModelOption = { id, label };
    const efforts = records(model.supported_reasoning_levels).flatMap((level) =>
      typeof level.effort === 'string' && level.effort
        ? [{ id: level.effort, ...(typeof level.description === 'string' && level.description ? { description: level.description } : {}) }]
        : [],
    );
    if (efforts.length) option.efforts = efforts;
    if (typeof model.default_reasoning_level === 'string' && model.default_reasoning_level) option.defaultEffort = model.default_reasoning_level;
    const tiers = records(model.service_tiers);
    const speeds = (Array.isArray(model.additional_speed_tiers) ? model.additional_speed_tiers : []).flatMap((speed) => {
      if (typeof speed !== 'string' || !speed) return [];
      const tier = tiers.find((t) => typeof t.name === 'string' && t.name.toLowerCase() === speed.toLowerCase());
      return [{
        id: speed,
        ...(typeof tier?.name === 'string' ? { name: tier.name } : {}),
        ...(typeof tier?.description === 'string' && tier.description ? { description: tier.description } : {}),
      }];
    });
    if (speeds.length) option.speeds = speeds;
    ranked.push({ option, priority: typeof model.priority === 'number' ? model.priority : Number.MAX_SAFE_INTEGER });
  }
  ranked.sort((a, b) => a.priority - b.priority || a.option.id.localeCompare(b.option.id));
  return ranked.map((r) => r.option);
}

/** What `~/.codex/config.toml` selects: the default model and any per-profile one. */
function codexConfiguredModels(reason: string): ModelListResult {
  const file = CODEX_CONFIG();
  const models: ModelOption[] = [];
  try {
    const toml = fs.readFileSync(file, 'utf8');
    let profile = '';
    for (const line of toml.split('\n')) {
      const section = /^\s*\[profiles\.([^\]]+)\]/.exec(line);
      if (section) profile = section[1];
      else if (/^\s*\[/.test(line)) profile = '';
      const model = /^\s*model\s*=\s*["']([^"']+)["']/.exec(line);
      if (model && !models.some((m) => m.id === model[1])) {
        models.push({ id: model[1], label: profile ? `profile ${profile}` : 'default in ~/.codex/config.toml' });
      }
    }
  } catch {
    // no config file — the CLI still has its own built-in default
  }
  return {
    ok: true,
    source: 'builtin',
    models,
    note: models.length
      ? `\`codex debug models\` did not answer (${reason}), so these are the models ~/.codex/config.toml selects. Leave the field empty to use the CLI default.`
      : `\`codex debug models\` did not answer (${reason}) and ~/.codex/config.toml sets no model. Leave the field empty to use the CLI default.`,
  };
}

/** The objects in what should be an array of them. */
function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object') : [];
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
