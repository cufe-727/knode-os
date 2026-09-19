import { KnodeConfig, LlmConfig } from '../config.js';
import { executorForAgent } from './agents.js';

/** The coding-agent CLIs a session can be launched on. */
export type AgentProvider = 'claude-cli' | 'codex-cli' | 'cursor-cli';

export const AGENT_PROVIDERS: AgentProvider[] = ['claude-cli', 'codex-cli', 'cursor-cli'];

/** The in-process executor's stable name — what `actor:` and the page's `agent:` record. */
export const BUILTIN_AGENT = 'deep-agents';

/** What ran a session, as recorded on a phase, a transcript or a page. */
export type ExecutorId = AgentProvider | typeof BUILTIN_AGENT;

/** One coding-agent CLI, launched headlessly once per session. */
export interface CliAgent {
  kind: 'cli';
  provider: AgentProvider;
  cliPath: string;
  model: string;
}

/** An in-process agent loop driven by an OpenAI-compatible endpoint. */
export interface BuiltinAgent {
  kind: 'builtin';
  provider: typeof BUILTIN_AGENT;
  baseUrl: string;
  /** Kept in its raw `env:VAR` form; resolved inside the executor, never logged. */
  apiKey: string;
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

function fromLlm(cfg: LlmConfig, model: string): ResearchAgent | null {
  if ((AGENT_PROVIDERS as string[]).includes(cfg.provider)) {
    return { kind: 'cli', provider: cfg.provider as AgentProvider, cliPath: cfg.cliPath, model: model || cfg.model };
  }
  if (cfg.provider === 'openai') {
    // an endpoint with no model (or no URL) cannot run a session; returning null
    // makes that a visible "not configured" rather than a queue that stalls
    const chosen = model || cfg.model;
    if (!chosen || !cfg.baseUrl) return null;
    return { kind: 'builtin', provider: BUILTIN_AGENT, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: chosen };
  }
  return null;
}

/**
 * Resolve an agent spec to a launchable agent:
 *
 *   ''                 → null (not configured)
 *   <agent name>       → that agent's executor and model (needs `dataDir`)
 *   'default'          → the section-01 connection, whatever kind it is
 *   <connection id>    → that connection: a CLI, or the built-in agent for an
 *                        OpenAI-compatible endpoint
 *   'claude-cli' | 'codex-cli' | 'cursor-cli' → that CLI, found on PATH
 *
 * There is deliberately no bare 'deep-agents' spec: a CLI name is meaningful on
 * its own, but a built-in agent without an endpoint is not an executor.
 * Anything else returns null so the caller can say so instead of guessing.
 *
 * `dataDir` is optional so a caller with only a config keeps resolving the
 * bare specs, which is also what a config written before named agents holds.
 */
export function agentForSpec(config: KnodeConfig, spec: string, model = '', dataDir?: string): ResearchAgent | null {
  const wanted = spec.trim();
  if (!wanted) return null;
  if (dataDir) {
    const named = executorForAgent(dataDir, wanted);
    if (named) return agentForSpec(config, named.executor, model || named.model);
  }
  if (wanted === DEFAULT_CONNECTION) return fromLlm(config.llm, model);
  const connection = config.connections.find((c) => c.id === wanted);
  if (connection) return fromLlm(connection, model);
  if ((AGENT_PROVIDERS as string[]).includes(wanted)) {
    const same = config.llm.provider === wanted ? config.llm : config.connections.find((c) => c.provider === wanted);
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
 * the built-in agent has none, so `allowNetwork` must be masked rather than
 * letting the brief promise external verification that cannot happen.
 */
export function agentWebCapable(agent: ResearchAgent | null | undefined): boolean {
  return agent?.kind === 'cli';
}
