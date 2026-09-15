import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EmbeddingConfig, LlmConfig, resolveSecret } from '../config.js';
import { CLI_COMMANDS, cliCommand, resolveExecutable, runProcess } from './cli.js';

/**
 * Model discovery for the Settings UI: what can actually be typed into a
 * `model` field for the provider that field is pointed at.
 *
 * Three sources, in descending order of truth:
 *   - `api`     — the provider's own `GET /models` (OpenAI-compatible endpoints)
 *   - `cli`     — the coding-agent CLI listed them (`cursor-agent --list-models`)
 *   - `builtin` — neither exists, so these are hints knode reads off the CLI's
 *                 own help text or config file. The field stays free text.
 */

export interface ModelOption {
  id: string;
  label?: string;
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
}

const LIST_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 20_000;

/** Documented `claude --model` aliases, used when its help text can't be parsed. */
const CLAUDE_FALLBACK_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'];

export async function listChatModels(cfg: LlmConfig): Promise<ModelListResult> {
  if (cfg.provider === 'openai') {
    try {
      return await listOpenAiModels(cfg.baseUrl, cfg.apiKey);
    } catch (e) {
      return { ok: false, source: 'api', models: [], error: message(e) };
    }
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
    if (cfg.provider === 'codex-cli') return { ...base, ...codexConfiguredModels() };
    return { ...base, ok: false, source: 'builtin', models: [], error: `unknown provider: ${cfg.provider}` };
  } catch (e) {
    return { ...base, ok: false, source: 'cli', models: [], error: message(e) };
  }
}

export async function listEmbeddingModels(cfg: EmbeddingConfig): Promise<ModelListResult> {
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
  try {
    const all = await listOpenAiModels(cfg.baseUrl, cfg.apiKey);
    const embedding = all.models.filter((m) => /embed/i.test(m.id));
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
 * aliases, so read them from there and fall back to the known set.
 */
async function listClaudeAliases(command: string): Promise<ModelListResult> {
  let aliases: string[] = [];
  try {
    const { stdout } = await runProcess(command, ['--help'], '', LIST_TIMEOUT_MS);
    const description = /--model <model>([\s\S]*?)\n\s*(?:-\w,|--\w)/.exec(stdout)?.[1] ?? '';
    aliases = [...description.matchAll(/'([a-z][a-z0-9.\-]*)'/g)].map((m) => m[1]).filter((a) => !a.includes('-'));
  } catch {
    // fall through to the documented set
  }
  const unique = [...new Set(aliases.length ? aliases : CLAUDE_FALLBACK_ALIASES)];
  return {
    ok: true,
    source: aliases.length ? 'cli' : 'builtin',
    models: unique.map((id) => ({ id, label: 'alias · latest model of the family' })),
    note: 'Claude Code takes a family alias or any full model id (e.g. claude-fable-5). Leave the field empty to use the CLI default.',
  };
}

/** Codex has no list command either — surface what its own config file selects. */
function codexConfiguredModels(): ModelListResult {
  const file = path.join(os.homedir(), '.codex', 'config.toml');
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
      ? 'Codex CLI has no list command; these are the models its own config selects. Leave the field empty to use the CLI default.'
      : 'Codex CLI has no list command and ~/.codex/config.toml sets no model. Leave the field empty to use the CLI default.',
  };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
