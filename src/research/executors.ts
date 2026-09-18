import { KnodeConfig, llmProviderLabel } from '../config.js';
import { cliToolStatus } from '../llm/models.js';
import { AGENT_PROVIDERS, agentForSpec, DEFAULT_CONNECTION } from './agent.js';
import { builtinAvailable } from './launch.js';

/**
 * What can actually run a research or chat session on this machine, and which
 * of them to preselect when nothing is configured yet.
 *
 * Both clients read this rather than working out a preference order of their
 * own: "is this CLI on PATH" is a fact only the service knows (the PATH is the
 * service process's), and two UIs deciding it separately would drift.
 */

export interface AvailableAgent {
  /** The spec to store in `research.agent` / `chat.agent`. */
  id: string;
  kind: 'cli' | 'builtin';
  label: string;
  available: boolean;
  /** CLI only: the command, and where it resolved on PATH (null = not found). */
  command?: string;
  path?: string | null;
  /** Why it cannot run, when it cannot. */
  reason?: string;
}

export async function availableAgents(config: KnodeConfig): Promise<AvailableAgent[]> {
  const onPath = new Map(cliToolStatus().map((t) => [t.provider, t]));
  const agents: AvailableAgent[] = [];

  for (const provider of AGENT_PROVIDERS) {
    const tool = onPath.get(provider);
    agents.push({
      id: provider,
      kind: 'cli',
      label: `${llmProviderLabel(provider)} · from PATH`,
      available: Boolean(tool?.path),
      command: tool?.command,
      path: tool?.path ?? null,
      ...(tool?.path ? {} : { reason: `${tool?.command ?? provider} was not found on the service PATH` }),
    });
  }

  const builtin = await builtinAvailable();
  const asBuiltin = (id: string, label: string, hasModel: boolean): AvailableAgent => ({
    id,
    kind: 'builtin',
    label: `${label} · built-in agent`,
    available: builtin && hasModel,
    ...(builtin ? {} : { reason: 'the built-in agent packages are not installed' }),
    ...(builtin && !hasModel ? { reason: 'this connection has no model set' } : {}),
  });

  if (config.llm.provider === 'openai') {
    agents.push(asBuiltin(DEFAULT_CONNECTION, 'Default LLM provider', Boolean(config.llm.model && config.llm.baseUrl)));
  }
  for (const connection of config.connections) {
    const label = connection.label || connection.id;
    if (connection.provider === 'openai') {
      agents.push(asBuiltin(connection.id, label, Boolean(connection.model && connection.baseUrl)));
    } else {
      const tool = onPath.get(connection.provider);
      const resolved = connection.cliPath || tool?.path;
      agents.push({
        id: connection.id,
        kind: 'cli',
        label: `${label} · ${llmProviderLabel(connection.provider)}`,
        available: Boolean(resolved),
        command: connection.cliPath || tool?.command,
        path: resolved ?? null,
        ...(resolved ? {} : { reason: `${tool?.command ?? connection.provider} was not found on the service PATH` }),
      });
    }
  }
  return agents;
}

/**
 * What to preselect when `research.agent` is empty. Clients pre-fill this into
 * the form; the user still has to save, so "not configured" never turns into a
 * setting nobody chose.
 *
 * The second rule is the migration: someone running on the old inherit-from-llm
 * fallback gets their current effective behaviour written down explicitly, and
 * nothing changes for them.
 */
export function suggestResearchAgent(config: KnodeConfig, agents: AvailableAgent[]): string | null {
  if (config.research?.agent?.trim()) return null; // already configured
  const usable = (id: string) => agents.find((a) => a.id === id && a.available) && agentForSpec(config, id);

  if ((AGENT_PROVIDERS as string[]).includes(config.llm.provider) && usable(config.llm.provider)) return config.llm.provider;
  for (const provider of AGENT_PROVIDERS) if (usable(provider)) return provider;
  if (usable(DEFAULT_CONNECTION)) return DEFAULT_CONNECTION;
  for (const connection of config.connections) if (usable(connection.id)) return connection.id;
  return null;
}
