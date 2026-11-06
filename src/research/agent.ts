import { isCliProvider, KnodeConfig, LlmConfig, llmTargets, LlmProtocol, modelConnectionFor } from '../config.js';
import { AgentDefinition, loadAgent } from './agents.js';

/** The coding-agent CLIs a session can be launched on. */
export type AgentProvider = 'claude-cli' | 'codex-cli' | 'cursor-cli' | 'opencode-cli';

export const AGENT_PROVIDERS: AgentProvider[] = ['claude-cli', 'codex-cli', 'cursor-cli', 'opencode-cli'];

/** The in-process executor's stable name — what `actor:` and the page's `agent:` record. */
export const BUILTIN_AGENT = 'deep-agents';

/** What ran a session, as recorded on a phase, a transcript or a page. */
export type ExecutorId = AgentProvider | typeof BUILTIN_AGENT;

/**
 * The model endpoint a CLI runs on when it brings no login of its own
 * (opencode-cli): a connection's URL, key and wire.
 */
export interface CliEndpoint {
  baseUrl: string;
  /** Kept in its raw `env:VAR` form; resolved only into the process environment, never logged. */
  apiKey: string;
  protocol?: LlmProtocol;
}

/** One coding-agent CLI, launched headlessly once per session. */
export interface CliAgent {
  kind: 'cli';
  provider: AgentProvider;
  cliPath: string;
  model: string;
  /** opencode-cli: the connection it loops on. The other CLIs log in themselves and carry none. */
  endpoint?: CliEndpoint;
}

/** An in-process agent loop driven by an OpenAI-compatible endpoint. */
export interface BuiltinAgent {
  kind: 'builtin';
  provider: typeof BUILTIN_AGENT;
  baseUrl: string;
  /** Kept in its raw `env:VAR` form; resolved inside the executor, never logged. */
  apiKey: string;
  /** Which wire to speak on. Absent = 'auto' (prefer Responses, fall back). */
  protocol?: LlmProtocol;
  model: string;
}

/**
 * What a research or chat session runs on. A union rather than a flat
 * `provider` string so that every launch branch becomes a compile error when a
 * new kind appears, instead of falling through to whatever the last `else`
 * happened to be.
 */
export type ResearchAgent = CliAgent | BuiltinAgent;

/** Apply a per-role or per-conversation model override without losing the kind. */
export function withModel(agent: ResearchAgent, model: string): ResearchAgent {
  if (!model) return agent;
  return agent.kind === 'cli' ? { ...agent, model } : { ...agent, model };
}

/** The spec that names the default LLM connection (section 01) rather than a named one. */
export const DEFAULT_CONNECTION = 'default';

/** What an opencode agent row carries of its connection, or null when it has none to run on. */
function endpointOf(cfg: Pick<LlmConfig, 'baseUrl' | 'apiKey' | 'protocol'> | null | undefined): CliEndpoint | null {
  return cfg?.baseUrl ? { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, protocol: cfg.protocol } : null;
}

function fromLlm(cfg: LlmConfig, model: string): ResearchAgent | null {
  if (cfg.provider === 'opencode-cli') {
    // OpenCode is a loop without a model: no connection, or none with a model, nothing to run
    const endpoint = endpointOf(cfg);
    const chosen = model || cfg.model;
    return endpoint && chosen ? { kind: 'cli', provider: 'opencode-cli', cliPath: cfg.cliPath, model: chosen, endpoint } : null;
  }
  if ((AGENT_PROVIDERS as string[]).includes(cfg.provider)) {
    return { kind: 'cli', provider: cfg.provider as AgentProvider, cliPath: cfg.cliPath, model: model || cfg.model };
  }
  if (cfg.provider === 'openai') {
    // an endpoint with no model (or no URL) cannot run a session; returning null
    // makes that a visible "not configured" rather than a queue that stalls
    const chosen = model || cfg.model;
    if (!chosen || !cfg.baseUrl) return null;
    return { kind: 'builtin', provider: BUILTIN_AGENT, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, protocol: cfg.protocol, model: chosen };
  }
  return null;
}

/**
 * Resolve an agent spec to a launchable agent:
 *
 *   ''                 → null (not configured)
 *   <agent name>       → that agent: its CLI with its own path and model, or
 *                        the built-in agent on the model its executor names
 *                        (needs `dataDir`; without it a CLI agent still
 *                        resolves, through `llmTargets`)
 *   'default'          → the default LLM, whatever kind it is
 *   <connection id>    → the built-in agent on that model endpoint
 *   'claude-cli' | 'codex-cli' | 'cursor-cli' → that CLI, found on PATH
 *   'opencode-cli'     → OpenCode, borrowing the path, model and connection of
 *                        an opencode agent (it has no login of its own)
 *
 * There is deliberately no bare 'deep-agents' spec: a CLI name is meaningful on
 * its own, but a built-in agent without an endpoint is not an executor.
 * Anything else returns null so the caller can say so instead of guessing.
 *
 * `dataDir` is optional so a caller with only a config keeps resolving the
 * bare specs, which is also what a config written before named agents holds.
 */
export function agentForSpec(config: KnodeConfig, spec: string, model = '', dataDir?: string): ResearchAgent | null {
  return resolveAgentSpec(config, spec, model, dataDir)?.agent ?? null;
}

/** What will launch, and the definition it was named through (null for a bare spec). */
export interface ResolvedAgent {
  agent: ResearchAgent;
  /** The `playbooks/agents/` entry behind the spec, when the spec was a name. */
  definition: AgentDefinition | null;
}

/**
 * `agentForSpec`, keeping the definition a name resolved through.
 *
 * The recursion in `agentForSpec` used to throw the definition away and hand
 * on only `{ executor, model }`, which is why an agent's effort, tools, turn
 * cap and prompt were edited, saved, and then never read by anything. A caller
 * that wants to honour them asks for the whole thing.
 *
 * The executor is resolved **without** `dataDir`, so an executor that happens
 * to share a name with an agent file still means the bare spec — one level of
 * naming, as before.
 */
export function resolveAgentSpec(config: KnodeConfig, spec: string, model = '', dataDir?: string): ResolvedAgent | null {
  const wanted = spec.trim();
  if (!wanted) return null;
  if (dataDir) {
    const definition = loadAgent(dataDir, wanted);
    if (definition) {
      const agent = definition.executor === 'opencode-cli'
        ? opencodeAgent(config, definition, model)
        : isCliProvider(definition.executor)
          ? // a CLI agent carries its own path; it borrows nothing from anyone
            { kind: 'cli' as const, provider: definition.executor, cliPath: definition.cliPath, model: model || definition.model }
          : builtinOnly(bareAgentFor(config, definition.executor, model || definition.model));
      return agent ? { agent, definition } : null;
    }
  }
  const agent = bareAgentFor(config, wanted, model);
  return agent ? { agent, definition: null } : null;
}

/**
 * An opencode agent: its own path, on the model connection it names (the
 * default LLM's when it names none), with that connection's model unless it
 * pins one. Not runnable without a model endpoint — OpenCode has no login.
 */
function opencodeAgent(config: KnodeConfig, definition: Pick<AgentDefinition, 'connection' | 'cliPath' | 'model'>, model: string): CliAgent | null {
  const connection = modelConnectionFor(config.connections ?? [], definition.connection, config.llmUse ?? '');
  const endpoint = endpointOf(connection);
  const chosen = model || definition.model || connection?.model || '';
  if (!endpoint || !chosen) return null;
  return { kind: 'cli', provider: 'opencode-cli', cliPath: definition.cliPath, model: chosen, endpoint };
}

/**
 * A deepagents definition runs the built-in loop or nothing. When the model it
 * follows turns out to be a CLI agent — a default that is one — running that
 * CLI under this agent's name is exactly the confusion named agents exist to
 * end, so it is not runnable until it names a model.
 */
function builtinOnly(agent: ResearchAgent | null): BuiltinAgent | null {
  return agent?.kind === 'builtin' ? agent : null;
}

/**
 * A spec that is not an agent name: 'default', a model endpoint, a CLI agent
 * (by the id `llmTargets` gives it), or a bare CLI — which borrows the path and
 * model of a CLI agent running that CLI, the default's first.
 */
function bareAgentFor(config: KnodeConfig, spec: string, model: string): ResearchAgent | null {
  const wanted = spec.trim();
  if (!wanted) return null;
  if (wanted === DEFAULT_CONNECTION) return fromLlm(config.llm, model);
  const targets = llmTargets(config);
  const connection = targets.find((c) => c.id === wanted);
  if (connection) return fromLlm(connection, model);
  if ((AGENT_PROVIDERS as string[]).includes(wanted)) {
    const same = config.llm.provider === wanted ? config.llm : targets.find((c) => c.provider === wanted);
    if (wanted === 'opencode-cli') return same ? fromLlm(same, model) : null;
    return { kind: 'cli', provider: wanted as AgentProvider, cliPath: same?.cliPath ?? '', model: model || same?.model || '' };
  }
  return null;
}

/**
 * Which agent runs research: whatever `research.agent` names, and nothing else.
 *
 * There is no fallback to the default LLM provider. That fallback only ever
 * worked when the default happened to be a CLI, so the same configuration
 * silently did or did not have research depending on an unrelated setting.
 * An empty spec now means "not configured", which the UI states plainly.
 */
export function resolveResearchAgent(config: KnodeConfig, dataDir?: string): ResearchAgent | null {
  const research = config.research;
  const wanted = research?.agent?.trim();
  return wanted ? agentForSpec(config, wanted, research.model, dataDir) : null;
}

/**
 * Whether this agent can reach the web at all. Only the CLIs ship a web tool;
 * the built-in agent has none of its own, so `allowNetwork` must be masked
 * rather than letting the brief promise external verification that cannot
 * happen — unless a person configured knode's own search (`research.web.search`,
 * `searchConfigured`), which reaches every agent as `knode_web_search`.
 */
export function agentWebCapable(agent: ResearchAgent | null | undefined, searchConfigured = false): boolean {
  return agent?.kind === 'cli' || (agent?.kind === 'builtin' && searchConfigured);
}
