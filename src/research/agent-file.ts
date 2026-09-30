import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { parseYaml } from '../compiler/intents.js';
import { AGENTS_DIR, RESEARCH_DIR } from '../fs/layout.js';

/**
 * The files under `playbooks/agents/`, read and written as plain records.
 *
 * Kept free of any knode-os config import so `config.ts` can use it: the
 * pipeline and the default LLM may run on a CLI agent, so loading the config
 * has to see those files, and `agents.ts` — which builds the typed definition
 * on top of this — imports the config itself.
 */

export function isValidAgentName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,40}$/i.test(name);
}

export function agentFilePath(dataDir: string, name: string): string {
  return path.join(dataDir, AGENTS_DIR, `${name}.yaml`);
}

/** Every agent file's name, sorted; files whose stem is not a valid name are skipped. */
export function agentFileNames(dataDir: string): string[] {
  const dir = path.join(dataDir, AGENTS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((entry) => /\.ya?ml$/i.test(entry))
    .sort()
    .map((entry) => entry.replace(/\.ya?ml$/i, ''))
    .filter(isValidAgentName);
}

/** One file's raw fields, or null when there is no such file. A `.yml` twin is read too. */
export function readAgentFile(dataDir: string, name: string): Record<string, unknown> | null {
  if (!isValidAgentName(name)) return null;
  for (const ext of ['yaml', 'yml']) {
    const file = path.join(dataDir, AGENTS_DIR, `${name}.${ext}`);
    if (fs.existsSync(file)) return parseYaml(fs.readFileSync(file, 'utf8'));
  }
  return null;
}

/** YAML without the front-matter fences, the way every agent file is written. */
export function agentYamlText(data: Record<string, unknown>): string {
  return matter.stringify('', data).replace(/^---\n/, '').replace(/---\n*$/, '');
}

export function writeAgentFile(dataDir: string, name: string, data: Record<string, unknown>): void {
  const file = agentFilePath(dataDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, agentYamlText(data));
}

function removeAgentFile(dataDir: string, name: string): void {
  for (const ext of ['yaml', 'yml']) fs.rmSync(path.join(dataDir, AGENTS_DIR, `${name}.${ext}`), { force: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ built-ins */

/**
 * The one built-in agent: the deepagents loop on the default model.
 *
 * Its wording lives here rather than in `agents.ts`, which builds the template
 * from it, because loading the config rewords a file that still says what the
 * template used to (`upgradeAgentFiles`), and `config.ts` cannot import
 * `agents.ts`.
 */
export const DEEP_AGENT = { name: 'deep-agent', title: 'deep agent' } as const;

/** What every template was seeded with besides its name and wording. */
const SEEDED: Record<string, unknown> = {
  executor: 'default',
  cliPath: '',
  model: '',
  effort: 'default',
  tools: { write: true, files: true, web: 'inherit' },
  maxTurns: 0,
  timeoutMs: 0,
  prompt: '',
};

/**
 * Built-ins that no longer ship: how each was seeded, and what replaces it.
 *
 * `deep-research` was `deep-agent` under a second name — the same runtime,
 * model, tools and empty prompt, told apart only by its title and a `kind`
 * that ordered the pickers. A research run takes its effort, tools and prompts
 * from the profile, and a stage calls an agent one-shot, so the two never ran
 * differently: two rows and two picker entries for one agent.
 */
const RETIRED: Record<string, { replacement: string; seeded: Record<string, unknown> }> = {
  'deep-research': {
    replacement: DEEP_AGENT.name,
    seeded: { ...SEEDED, title: '深度研究 agent', description: '按 research profile 的阶段与子代理跑：规划 → 并行调查 → 综合 → 评审 → 修订，把页面写回 wiki。' },
  },
};

/** A built-in's wording from before it changed, and what it says now. */
const REWORDED: Record<string, Record<string, { was: string; now: string }>> = {
  [DEEP_AGENT.name]: { title: { was: '通用 deep agent', now: DEEP_AGENT.title } },
};

/**
 * What only Ask ever read, and a description nothing read. Ask runs every
 * agent with the same turn cap, timeout and tools now, and takes its
 * instructions from the workspace's chat protocol (see `chatRuntimeFor`).
 */
const ASK_ONLY_FIELDS = ['description', 'maxTurns', 'timeoutMs', 'prompt'] as const;
const ASK_ONLY_TOOLS = ['write', 'files'] as const;

/** Whether a file still says what it was seeded with; a field it leaves out was the template's. */
function asSeeded(raw: Record<string, unknown>, seeded: Record<string, unknown>): boolean {
  return Object.entries(seeded).every(([field, value]) => {
    if (isRecord(value)) {
      const own = isRecord(raw[field]) ? raw[field] : {};
      return Object.entries(value).every(([key, v]) => (own[key] ?? v) === v);
    }
    const own = raw[field] ?? value;
    return (typeof own === 'string' ? own.trim() : own) === value;
  });
}

/**
 * Bring `playbooks/agents/` up to the current built-ins. `loadConfig` runs it
 * before anything reads the agents; running it again changes nothing.
 *
 * - A retired built-in still as it was seeded is deleted. One someone edited
 *   stays as an ordinary agent, with the template's values written in for the
 *   fields it was inheriting, so it runs as it did.
 * - A built-in whose title still reads as it shipped takes the current
 *   wording; an edited one is left alone.
 * - `kind` goes from every file: it only ever ordered the pickers.
 * - So do `description`, `maxTurns`, `timeoutMs`, `prompt` and the `write` /
 *   `files` tools (`ASK_ONLY_FIELDS`); `tools.web` stays.
 *
 * Returns each retired name that has no file now, mapped to its replacement,
 * so whatever still names it can follow.
 */
export function upgradeAgentFiles(dataDir: string): Map<string, string> {
  const renamed = new Map<string, string>();
  for (const [name, { replacement, seeded }] of Object.entries(RETIRED)) {
    const raw = readAgentFile(dataDir, name);
    if (raw && asSeeded(raw, seeded)) {
      removeAgentFile(dataDir, name);
    } else if (raw) {
      const { kind: _kind, ...own } = raw;
      const tools = { ...(seeded.tools as Record<string, unknown>), ...(isRecord(raw.tools) ? raw.tools : {}) };
      const kept = { ...seeded, ...own, name, tools };
      if (JSON.stringify(kept) !== JSON.stringify(raw)) writeAgentFile(dataDir, name, kept);
    }
    if (!readAgentFile(dataDir, name)) renamed.set(name, replacement);
  }
  for (const name of agentFileNames(dataDir)) {
    // only the `.yaml` form is rewritten: writing one beside a `.yml` would make two
    if (!fs.existsSync(agentFilePath(dataDir, name))) continue;
    const raw = readAgentFile(dataDir, name);
    if (!raw) continue;
    const next: Record<string, unknown> = { ...raw };
    for (const [field, { was, now }] of Object.entries(REWORDED[name] ?? {})) {
      if (typeof next[field] === 'string' && (next[field] as string).trim() === was) next[field] = now;
    }
    delete next.kind;
    for (const field of ASK_ONLY_FIELDS) delete next[field];
    if (isRecord(next.tools)) {
      // a new object: `raw` came from the parse cache (see `renameProfileAgents`)
      const tools = Object.fromEntries(Object.entries(next.tools).filter(([key]) => !(ASK_ONLY_TOOLS as readonly string[]).includes(key)));
      if (Object.keys(tools).length > 0) next.tools = tools;
      else delete next.tools;
    }
    if (JSON.stringify(next) !== JSON.stringify(raw)) writeAgentFile(dataDir, name, next);
  }
  return renamed;
}

/**
 * Point the profile roles that pin an agent by a retired name at its
 * replacement. It sits with the agent files because `config.ts`, which runs it
 * on load, cannot import `profile.ts`; it writes with the same serializer as
 * `profileYaml`, so the file reads as if the UI had saved it.
 */
export function renameProfileAgents(dataDir: string, renamed: Map<string, string>): void {
  // `PROFILES_DIR`
  const dir = path.join(dataDir, RESEARCH_DIR, 'profiles');
  if (renamed.size === 0 || !fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (!/\.ya?ml$/i.test(entry)) continue;
    const file = path.join(dir, entry);
    // a copy: gray-matter caches what it parses by content, so editing its
    // result in place would change every later parse of the same text
    const profile = structuredClone(parseYaml(fs.readFileSync(file, 'utf8')));
    let moved = false;
    for (const role of Array.isArray(profile.roles) ? profile.roles : []) {
      const to = isRecord(role) && typeof role.agent === 'string' ? renamed.get(role.agent.trim()) : undefined;
      if (to && isRecord(role)) {
        role.agent = to;
        moved = true;
      }
    }
    if (moved) fs.writeFileSync(file, agentYamlText(profile));
  }
}
