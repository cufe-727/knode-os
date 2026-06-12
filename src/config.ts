import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface EmbeddingConfig {
  /** 'openai' = any OpenAI-compatible /v1/embeddings endpoint; 'local' = built-in hashing embedder (offline, no key needed). */
  provider: 'openai' | 'local';
  baseUrl: string;
  /** Plain key, or "env:VAR_NAME" to read from the environment. */
  apiKey: string;
  model: string;
  dimensions: number;
  batchSize: number;
}

export interface LlmConfig {
  /** OpenAI-compatible /v1/chat/completions endpoint. Empty model disables LLM features (graph falls back to heuristics). */
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface KnodeConfig {
  embedding: EmbeddingConfig;
  llm: LlmConfig;
  server: { port: number; host: string };
  ingest: { chunkSize: number; chunkOverlap: number; watch: boolean };
  trace: {
    /** Where Claude Code stores session transcripts. */
    claudeProjectsDir: string;
    /** Where Codex CLI stores session rollouts. */
    codexSessionsDir: string;
    /** Extra skill source dirs to mirror into raw/skills. */
    skillDirs: string[];
    syncIntervalMinutes: number;
  };
  dream: {
    /** Local time "HH:MM" at which the nightly dream runs while `serve` is up. */
    schedule: string;
    lookbackDays: number;
    /** Max trace excerpt characters fed to the LLM per dream run. */
    maxContextChars: number;
  };
}

export const CONFIG_FILE = 'knode.config.json';

export function defaultConfig(): KnodeConfig {
  const home = os.homedir();
  return {
    embedding: {
      provider: 'local',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'env:OPENAI_API_KEY',
      model: 'text-embedding-3-small',
      dimensions: 384,
      batchSize: 32,
    },
    llm: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'env:OPENAI_API_KEY',
      model: '',
    },
    server: { port: 9100, host: '127.0.0.1' },
    ingest: { chunkSize: 1200, chunkOverlap: 150, watch: true },
    trace: {
      claudeProjectsDir: path.join(home, '.claude', 'projects'),
      codexSessionsDir: path.join(home, '.codex', 'sessions'),
      skillDirs: [path.join(home, '.claude', 'skills'), path.join(home, '.codex', 'prompts')],
      syncIntervalMinutes: 10,
    },
    dream: { schedule: '03:00', lookbackDays: 7, maxContextChars: 60_000 },
  };
}

function deepMerge<T>(base: T, override: Partial<T>): T {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return (override as T) ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    const cur = out[k];
    if (cur && typeof cur === 'object' && !Array.isArray(cur) && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(cur, v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

export function loadConfig(dataDir: string): KnodeConfig {
  const file = path.join(dataDir, CONFIG_FILE);
  const base = defaultConfig();
  if (!fs.existsSync(file)) return base;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<KnodeConfig>;
  return deepMerge(base, raw);
}

export function saveConfig(dataDir: string, config: KnodeConfig): void {
  const file = path.join(dataDir, CONFIG_FILE);
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
}

/** Resolve "env:VAR" indirection in API keys. */
export function resolveSecret(value: string): string {
  if (value.startsWith('env:')) return process.env[value.slice(4)] ?? '';
  return value;
}

/** Resolve the data directory from CLI flag > env > default ~/.knode-os. */
export function resolveDataDir(flag?: string): string {
  const dir = flag || process.env.KNODE_OS_DATA || path.join(os.homedir(), '.knode-os');
  return path.resolve(dir);
}

/** Redact secrets for API exposure. */
export function redactConfig(config: KnodeConfig): KnodeConfig {
  const clone = JSON.parse(JSON.stringify(config)) as KnodeConfig;
  for (const c of [clone.embedding, clone.llm]) {
    if (c.apiKey && !c.apiKey.startsWith('env:')) c.apiKey = '***';
  }
  return clone;
}
