import { CLI_PROVIDERS, CliProvider, LlmConfig, llmProviderLabel } from '../../config.js';
import type { LlmBackend, LlmProviderPlugin } from '../../plugins/types.js';
import type { ChatMessage, CompletionOptions } from '../client.js';
import { CLI_COMMANDS, completeViaCli } from '../cli.js';

/**
 * The built-in coding-agent CLI providers (`codex-cli`, `claude-cli`,
 * `cursor-cli`): one non-interactive turn of a locally installed CLI, on its
 * own login (src/llm/cli.ts). They work without a model — the CLI's default
 * is used — so a configuration is always enabled.
 */
class CliBackend implements LlmBackend {
  constructor(private readonly cfg: LlmConfig) {}

  get enabled(): boolean {
    return true;
  }

  /** "codex-cli", or "claude-cli:opus" with a model. */
  get label(): string {
    return this.cfg.model ? `${this.cfg.provider}:${this.cfg.model}` : this.cfg.provider;
  }

  complete(messages: ChatMessage[], opts: CompletionOptions = {}): Promise<string> {
    // maxTokens is not controllable through the CLIs; the prompts already bound output size
    return completeViaCli(this.cfg, messages, { json: opts.json, model: opts.model, images: opts.images?.map((image) => image.path) });
  }
}

const NOTES: Record<CliProvider, string> = {
  'codex-cli': 'Uses your existing Codex login in read-only one-shot mode (`codex exec`).',
  'claude-cli': 'Uses your existing Claude Code login for one non-interactive turn (`claude -p`).',
  'cursor-cli': 'Uses your existing Cursor Agent login in headless print mode (`cursor-agent -p`).',
};

export function cliProviders(): LlmProviderPlugin[] {
  return CLI_PROVIDERS.map((id) => ({
    id,
    label: llmProviderLabel(id),
    kind: 'cli' as const,
    fields: ['cliPath', 'model', 'effort', 'speed', 'cliTimeoutMs'],
    note: `${NOTES[id]} Default executable: ${CLI_COMMANDS[id]} from PATH.`,
    create: (cfg: LlmConfig) => new CliBackend(cfg),
  }));
}
