import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from '../compiler/intents.js';
import { isCliProvider, KnodeConfig, LlmProvider } from '../config.js';
import { AGENTS_DIR } from '../fs/layout.js';
import { agentFilePath, agentYamlText, isValidAgentName } from './agent-file.js';
import { Effort, EFFORTS, RoleTools, WEB_ACCESS, WebAccess } from './profile.js';

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
 * the reasoning effort, which tools it may use, and its system prompt. What a
 * *research run* looks like — pipeline mode, sub-agent roles, verification
 * bar — stays in the research profile, because that is what the runner already
 * reads, and because it is a property of the research, not of who runs it.
 *
 * `kind` only orders the pickers now: Research lists the deep-research ones
 * first, Ask the general ones.
 *
 * Stored one YAML file each under `playbooks/agents/`, like profiles, so an
 * agent can be edited in the UI or in the file and diffed like any playbook.
 */

export const AGENT_KINDS = ['general', 'deep-research'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export interface AgentDefinition {
  /** File stem, and the id `research.agent` / `chat.agent` reference. */
  name: string;
  title: string;
  description: string;
  /**
   * 'general': one session answers, the way Chat uses it. 'deep-research':
   * the research runner drives it through a profile's phases and roles.
   */
  kind: AgentKind;
  /**
   * What actually runs it. 'claude-cli' | 'codex-cli' | 'cursor-cli': that CLI,
   * from `cliPath`. Anything else runs the built-in deepagents loop on a model:
   * 'default' follows the default LLM, a connection id pins one. Empty = not
   * runnable, which the UI states.
   */
  executor: string;
  /** A CLI agent's executable, path or name. Empty = the CLI's own name on PATH. */
  cliPath: string;
  /** Empty = the CLI's own default, or the connection's model. */
  model: string;
  effort: Effort;
  tools: RoleTools;
  /** Turn cap per session. 0 = the caller's own default. */
  maxTurns: number;
  /** 0 = the caller's own default. */
  timeoutMs: number;
  /** System prompt. Empty = the protocol the run workspace already carries. */
  prompt: string;
  path: string;
}

export const BUILTIN_AGENT_NAMES = ['deep-agent', 'deep-research'] as const;

function agent(patch: Partial<AgentDefinition> & Pick<AgentDefinition, 'name' | 'kind'>): AgentDefinition {
  return {
    title: patch.name,
    description: '',
    executor: 'default',
    cliPath: '',
    model: '',
    effort: 'default',
    tools: { write: false, files: true, web: 'inherit' },
    maxTurns: 0,
    timeoutMs: 0,
    prompt: '',
    path: '',
    ...patch,
  };
}

/**
 * The two starting points. `deep-agent` is the LangChain `deepagents` loop
 * knode already runs in-process on an OpenAI-compatible connection; it is
 * modelled here so it can be copied and tuned like anything else. Deleting a
 * built-in resets it, the way a built-in profile behaves.
 */
export const BUILTIN_AGENTS: Record<string, AgentDefinition> = {
  'deep-agent': agent({
    name: 'deep-agent',
    kind: 'general',
    title: '通用 deep agent',
    description: 'LangChain deepagents 循环，跑在 OpenAI 兼容连接上；单会话回答，可读知识库、可写隔离笔记。没装任何 CLI 的机器用它。',
    tools: { write: true, files: true, web: 'inherit' },
  }),
  'deep-research': agent({
    name: 'deep-research',
    kind: 'deep-research',
    title: '深度研究 agent',
    description: '按 research profile 的阶段与子代理跑：规划 → 并行调查 → 综合 → 评审 → 修订，把页面写回 wiki。',
    tools: { write: true, files: true, web: 'inherit' },
  }),
};

/** Which runtime a definition runs on: a coding-agent CLI, or the built-in deepagents loop. */
export function agentRuntime(definition: Pick<AgentDefinition, 'executor'>): LlmProvider | 'deepagents' {
  return isCliProvider(definition.executor) ? definition.executor : 'deepagents';
}

function agentFile(dataDir: string, name: string): string {
  return agentFilePath(dataDir, name);
}

export function agentYaml(definition: AgentDefinition): string {
  const { path: _path, ...data } = definition;
  return agentYamlText(data);
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

function int(v: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

export function normalizeAgent(raw: Record<string, unknown>, name: string, filePath: string): AgentDefinition {
  const builtin = BUILTIN_AGENTS[name];
  const kind = oneOf(raw.kind, AGENT_KINDS, builtin?.kind ?? 'general');
  const base = builtin ?? agent({ name, kind });
  const tools = (raw.tools ?? {}) as Record<string, unknown>;
  return {
    name,
    title: str(raw.title, base.title),
    description: str(raw.description, base.description),
    kind,
    executor: str(raw.executor, base.executor).trim(),
    cliPath: str(raw.cliPath, base.cliPath).trim(),
    model: str(raw.model, base.model).trim(),
    effort: oneOf(raw.effort, EFFORTS, base.effort),
    tools: {
      write: typeof tools.write === 'boolean' ? tools.write : base.tools.write,
      files: typeof tools.files === 'boolean' ? tools.files : base.tools.files,
      web: oneOf(tools.web, WEB_ACCESS, base.tools.web) as WebAccess,
    },
    maxTurns: int(raw.maxTurns, base.maxTurns, 0, 500),
    timeoutMs: int(raw.timeoutMs, base.timeoutMs, 0, 24 * 3600_000),
    prompt: str(raw.prompt, base.prompt),
    path: filePath,
  };
}
