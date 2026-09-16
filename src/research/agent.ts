import { KnodeConfig, LlmConfig, resolveRoutedLlmConfig } from '../config.js';
import { AGENT_PROVIDERS, AgentProvider } from './launch.js';

/** A coding-agent CLI a research session runs on. */
export interface ResearchAgent {
  provider: AgentProvider;
  cliPath: string;
  model: string;
}

function fromLlm(cfg: LlmConfig, model: string): ResearchAgent | null {
  return (AGENT_PROVIDERS as string[]).includes(cfg.provider) ? { provider: cfg.provider as AgentProvider, cliPath: cfg.cliPath, model: model || cfg.model } : null;
}

/**
 * Resolve an agent spec — a connection id from `connections` or a provider
 * name ('claude-cli' | 'codex-cli' | 'cursor-cli') — to a launchable CLI.
 * Unknown specs return null so the caller can fall back and say so.
 */
export function agentForSpec(config: KnodeConfig, spec: string, model = ''): ResearchAgent | null {
  const wanted = spec.trim();
  if (!wanted) return null;
  const connection = config.connections.find((c) => c.id === wanted);
  if (connection) return fromLlm(connection, model);
  if ((AGENT_PROVIDERS as string[]).includes(wanted)) {
    const same = config.llm.provider === wanted ? config.llm : config.connections.find((c) => c.provider === wanted);
    return { provider: wanted as AgentProvider, cliPath: same?.cliPath ?? '', model: model || same?.model || '' };
  }
  return null;
}

/** Which CLI runs research: `research.agent`, else the default llm when it is a CLI provider. */
export function resolveResearchAgent(config: KnodeConfig): ResearchAgent | null {
  const research = config.research;
  const wanted = research?.agent?.trim();
  if (wanted) return agentForSpec(config, wanted, research.model);
  return fromLlm(resolveRoutedLlmConfig(config.llm, { use: 'default', provider: 'inherit', baseUrl: '', apiKey: '', model: '', cliPath: '', cliTimeoutMs: 0 }, config.connections), research?.model ?? '');
}
