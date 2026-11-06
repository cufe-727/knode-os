import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from '../compiler/intents.js';
import { isCliProvider, KnodeConfig, LlmProvider } from '../config.js';
import { AGENTS_DIR } from '../fs/layout.js';
import { agentFilePath, agentYamlText, DEEP_AGENT, isValidAgentName } from './agent-file.js';
import { Effort, EFFORTS, Speed, SPEEDS, WEB_ACCESS, WebAccess } from './profile.js';

export { isValidAgentName } from './agent-file.js';

/**
 * Named agents — the thing a person adds, names and points research or chat
 * at, instead of picking a bare CLI name every time.
 *
 * An agent answers "who runs this and how hard do they think". It is one of
 * two runtimes: the in-process deepagents loop on one of the models in
 * `connections`, or a coding-agent CLI on this machine that brings its own
 * loop (and its own path, model and effort — a CLI is an agent, not a model
 * endpoint, so it lives here and not in `connections`). On top of either sit
 * the reasoning effort and whether Ask may give it web tools. What a
 * *research run* looks like — pipeline mode, sub-agent roles, verification
 * bar — stays in the research profile, because that is what the runner already
 * reads, and because it is a property of the research, not of who runs it.
 *
 * There is no kind of agent: the same one can answer Ask and run research.
 * The `kind` agents used to carry only ordered the pickers, and loading the
 * config drops it from the files (`upgradeAgentFiles`). So does what only Ask
 * read — a turn cap, a timeout, page and file tools, a system prompt — and a
 * description nothing read: Ask runs every agent the same way (see
 * `chatRuntimeFor`), and the workspace's chat protocol is where its
 * instructions live.
 *
 * Stored one YAML file each under `playbooks/agents/`, like profiles, so an
 * agent can be edited in the UI or in the file and diffed like any playbook.
 */

export interface AgentDefinition {
  /** File stem, and the id `research.agent` / `chat.agent` reference. */
  name: string;
  title: string;
  /**
   * What actually runs it. 'claude-cli' | 'codex-cli' | 'cursor-cli' |
   * 'opencode-cli': that CLI, from `cliPath`. Anything else runs the built-in
   * deepagents loop on a model: 'default' follows the default LLM, a
   * connection id pins one. Empty = not runnable, which the UI states.
   */
  executor: string;
  /** A CLI agent's executable, path or name. Empty = the CLI's own name on PATH. */
  cliPath: string;
  /**
   * opencode-cli only: the model connection OpenCode runs on — its endpoint,
   * key and wire. '' or 'default' = the default LLM's connection. The other
   * CLIs bring their own login and ignore it.
   */
  connection: string;
  /** Empty = the CLI's own default, or the connection's model. */
  model: string;
  effort: Effort;
  /** `fast` = a codex agent's priority tier (`service_tier`); the other CLIs ignore it. */
  speed: Speed;
  /** Web tools in Ask, within `review.external`. Research takes its own from the profile. */
  tools: { web: WebAccess };
  path: string;
}

export const BUILTIN_AGENT_NAMES = [DEEP_AGENT.name] as const;

function agent(patch: Partial<AgentDefinition> & Pick<AgentDefinition, 'name'>): AgentDefinition {
  return {
    title: patch.name,
    executor: 'default',
    cliPath: '',
    connection: '',
    model: '',
    effort: 'default',
    speed: 'default',
    tools: { web: 'inherit' },
    path: '',
    ...patch,
  };
}

/**
 * The starting point: the LangChain `deepagents` loop knode runs in-process on
 * an OpenAI-compatible connection, modelled here so it can be copied and tuned
 * like anything else. One is enough — Ask and research both run it, and a
 * second template, `deep-research`, differed from it in nothing but its name
 * (see `upgradeAgentFiles`). Deleting a built-in resets it, the way a built-in
 * profile behaves.
 */
export const BUILTIN_AGENTS: Record<string, AgentDefinition> = {
  [DEEP_AGENT.name]: agent({ name: DEEP_AGENT.name, title: DEEP_AGENT.title }),
};

/** Which runtime a definition runs on: a coding-agent CLI, or the built-in deepagents loop. */
export function agentRuntime(definition: Pick<AgentDefinition, 'executor'>): LlmProvider | 'deepagents' {
  return isCliProvider(definition.executor) ? definition.executor : 'deepagents';
}

function agentFile(dataDir: string, name: string): string {
  return agentFilePath(dataDir, name);
}

export function agentYaml(definition: AgentDefinition): string {
  const { path: _path, connection, ...rest } = definition;
  // only an opencode agent runs on a connection; the others' files stay as they were
  if (!connection && definition.executor !== 'opencode-cli') return agentYamlText(rest);
  const { name, title, executor, cliPath, ...after } = rest;
  return agentYamlText({ name, title, executor, cliPath, connection, ...after });
}

/** Seed the built-ins once; a user edit is never overwritten. */
export function ensureDefaultAgents(dataDir: string): string[] {
  const created: string[] = [];
  for (const [name, definition] of Object.entries(BUILTIN_AGENTS)) {
    const file = agentFile(dataDir, name);
    if (fs.existsSync(file)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, agentYaml(definition));
    created.push(`${AGENTS_DIR}/${name}.yaml`);
  }
  return created;
}

export function loadAgents(dataDir: string): Map<string, AgentDefinition> {
  ensureDefaultAgents(dataDir);
  const out = new Map<string, AgentDefinition>();
  const dir = path.join(dataDir, AGENTS_DIR);
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir).sort()) {
    if (!/\.ya?ml$/i.test(entry)) continue;
    const name = entry.replace(/\.ya?ml$/i, '');
    if (!isValidAgentName(name)) continue;
    const raw = parseYaml(fs.readFileSync(path.join(dir, entry), 'utf8'));
    out.set(name, normalizeAgent(raw, name, `${AGENTS_DIR}/${entry}`));
  }
  return out;
}

export function loadAgent(dataDir: string, name: string): AgentDefinition | null {
  if (!isValidAgentName(name)) return null;
  const file = agentFile(dataDir, name);
  if (!fs.existsSync(file)) {
    ensureDefaultAgents(dataDir);
    if (!fs.existsSync(file)) return null;
  }
  return normalizeAgent(parseYaml(fs.readFileSync(file, 'utf8')), name, `${AGENTS_DIR}/${name}.yaml`);
}

export function saveAgent(dataDir: string, input: Partial<AgentDefinition> & { name: string }): AgentDefinition {
  if (!isValidAgentName(input.name)) throw new Error(`invalid agent name "${input.name}" (letters, digits, - and _ only)`);
  const definition = normalizeAgent(input as unknown as Record<string, unknown>, input.name, `${AGENTS_DIR}/${input.name}.yaml`);
  const file = agentFile(dataDir, input.name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, agentYaml(definition));
  return definition;
}

/** Remove an agent file. A built-in name comes back as its default. */
export function deleteAgent(dataDir: string, name: string): boolean {
  if (!isValidAgentName(name)) return false;
  const file = agentFile(dataDir, name);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

/** The agent `research.agent` names, if it is a name at all. */
export function activeAgent(dataDir: string, config: KnodeConfig): AgentDefinition | null {
  const name = config.research?.agent?.trim();
  return name ? loadAgent(dataDir, name) : null;
}

/* ------------------------------------------------------------------ normalization */

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

export function normalizeAgent(raw: Record<string, unknown>, name: string, filePath: string): AgentDefinition {
  const base = BUILTIN_AGENTS[name] ?? agent({ name });
  const tools = (raw.tools ?? {}) as Record<string, unknown>;
  return {
    name,
    title: str(raw.title, base.title),
    executor: str(raw.executor, base.executor).trim(),
    cliPath: str(raw.cliPath, base.cliPath).trim(),
    connection: str(raw.connection, base.connection).trim(),
    model: str(raw.model, base.model).trim(),
    effort: oneOf(raw.effort, EFFORTS, base.effort),
    speed: oneOf(raw.speed, SPEEDS, base.speed),
    tools: { web: oneOf(tools.web, WEB_ACCESS, base.tools.web) as WebAccess },
    path: filePath,
  };
}
