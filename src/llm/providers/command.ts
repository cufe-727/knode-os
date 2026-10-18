import path from 'node:path';
import { LlmConfig, resolveSecret } from '../../config.js';
import type { LlmBackend, LlmProviderPlugin } from '../../plugins/types.js';
import type { ChatMessage, CompletionOptions } from '../client.js';
import { cliFailureText, runProcess } from '../cli.js';

/**
 * The built-in `command` provider: any executable as a model, with no plugin
 * code to write. One call is one process:
 *
 *   stdin   one JSON object — { messages, model, json, maxTokens, images }
 *   stdout  the reply text (for a `json` request: the JSON object itself)
 *   exit 0  success; anything else fails the call with stderr's tail
 *
 * `cliPath` names the executable, `model` is passed through as `model` and
 * `$KNODE_LLM_MODEL`, and the connection's `baseUrl` / `apiKey` reach the
 * process as `$KNODE_LLM_BASE_URL` / `$KNODE_LLM_API_KEY` (with "env:VAR"
 * resolved), so a script can speak to a vendor whose wire knode-os does not
 * know while the key still lives in knode's config or environment. The
 * process runs with the OS temp directory as its working directory, like the
 * coding-agent CLIs, and is killed after `cliTimeoutMs`.
 */
class CommandBackend implements LlmBackend {
  constructor(private readonly cfg: LlmConfig) {}

  get command(): string {
    return (this.cfg.cliPath ?? '').trim();
  }

  get enabled(): boolean {
    return Boolean(this.command);
  }

  /** "command:my-model.py", or "command:my-model.py:fast" with a model. */
  get label(): string {
    const base = path.basename(this.command) || 'command';
    return this.cfg.model ? `command:${base}:${this.cfg.model}` : `command:${base}`;
  }

  async complete(messages: ChatMessage[], opts: CompletionOptions = {}): Promise<string> {
    const command = this.command;
    if (!command) throw new Error('command provider: set the executable to run (the CLI executable field)');
    const model = opts.model || this.cfg.model || null;
    const request = {
      messages,
      model,
      json: Boolean(opts.json),
      maxTokens: opts.maxTokens ?? null,
      images: (opts.images ?? []).map((image) => ({ path: image.path, mimeType: image.mimeType ?? null })),
    };
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      KNODE_LLM_MODEL: model ?? '',
      KNODE_LLM_JSON: request.json ? '1' : '0',
      KNODE_LLM_BASE_URL: this.cfg.baseUrl ?? '',
      KNODE_LLM_API_KEY: resolveSecret(this.cfg.apiKey ?? ''),
    };
    const { code, stdout, stderr } = await runProcess(command, [], JSON.stringify(request), this.cfg.cliTimeoutMs, { env });
    if (code !== 0) throw new Error(`${command} exited with code ${code}: ${cliFailureText(stderr, stdout)}`);
    const text = stdout.trim();
    if (!text) throw new Error(`${command} finished but produced no output`);
    return text;
  }
}

export function commandProvider(): LlmProviderPlugin {
  return {
    id: 'command',
    label: 'Command · any executable',
    kind: 'custom',
    fields: ['cliPath', 'model', 'baseUrl', 'apiKey', 'cliTimeoutMs'],
    note: 'Runs the executable once per call: a JSON request on stdin ({ messages, model, json, maxTokens, images }), the reply on stdout. baseUrl and apiKey reach it as KNODE_LLM_BASE_URL / KNODE_LLM_API_KEY.',
    create: (cfg) => new CommandBackend(cfg),
  };
}
