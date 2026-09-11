import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LlmConfig } from '../config.js';
import type { ChatMessage } from './client.js';

/**
 * Chat-completion backends that shell out to a locally installed coding-agent
 * CLI instead of an HTTP API. They reuse the CLI's own login (ChatGPT plan /
 * Anthropic account), so no API key is configured in knode.
 *
 * All run in non-interactive one-shot mode with the OS temp dir as cwd so
 * the CLIs don't pick up repo instructions (AGENTS.md / CLAUDE.md) or try to
 * touch the workspace:
 *   - codex:  `codex exec --sandbox read-only --output-last-message <f> -`
 *   - claude: `claude -p --output-format json --max-turns 1`
 *   - cursor: `cursor-agent -p --output-format json <prompt>`
 */

const DEFAULT_TIMEOUT_MS = 300_000;

/** Flatten chat messages into a single prompt for one-shot CLI runs. */
export function renderCliPrompt(messages: ChatMessage[], json: boolean): string {
  const nonSystem = messages.filter((m) => m.role !== 'system');
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === 'system' || nonSystem.length === 1) parts.push(m.content);
    else parts.push(`[${m.role}]\n${m.content}`);
  }
  let prompt = parts.join('\n\n');
  if (json) prompt += '\n\nRespond with a single JSON object only — no prose, no markdown code fences.';
  return prompt;
}

export async function completeViaCli(
  cfg: LlmConfig,
  messages: ChatMessage[],
  opts: { json?: boolean; model?: string; images?: string[] } = {},
): Promise<string> {
  const images = opts.images ?? [];
  let prompt = renderCliPrompt(messages, Boolean(opts.json));
  const model = opts.model || cfg.model || undefined;
  if (cfg.provider === 'codex-cli') return runCodex(cfg, prompt, model, images);
  if (cfg.provider === 'claude-cli') {
    if (images.length) {
      prompt += `\n\nUse the Read tool to inspect these image files before answering:\n${images.map((image) => `- ${image}`).join('\n')}`;
    }
    return runClaude(cfg, prompt, model, images);
  }
  if (cfg.provider === 'cursor-cli') {
    if (images.length) throw new Error('cursor-cli does not support image attachments; use an OpenAI vision model, codex-cli, or claude-cli');
    return runCursor(cfg, prompt, model);
  }
  throw new Error(`not a CLI provider: ${cfg.provider}`);
}

async function runCodex(cfg: LlmConfig, prompt: string, model?: string, images: string[] = []): Promise<string> {
  const cmd = cfg.cliPath || 'codex';
  // --output-last-message gives the bare final message without parsing JSONL events
  const outFile = path.join(os.tmpdir(), `knode-codex-${crypto.randomUUID()}.txt`);
  const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', os.tmpdir(), '--output-last-message', outFile];
  if (model) args.push('--model', model);
  for (const image of images) args.push('--image', image);
  args.push('-'); // read the prompt from stdin
  try {
    const r = await runProcess(cmd, args, prompt, cfg.cliTimeoutMs);
    if (r.code !== 0) throw new Error(`codex exec exited with code ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    const out = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim() : '';
    if (!out) throw new Error('codex exec finished but produced no message');
    return out;
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}

async function runClaude(cfg: LlmConfig, prompt: string, model?: string, images: string[] = []): Promise<string> {
  const cmd = cfg.cliPath || 'claude';
  const args = ['-p', '--output-format', 'json', '--max-turns', images.length ? '3' : '1'];
  if (model) args.push('--model', model);
  if (images.length) {
    args.push('--tools', 'Read', '--permission-mode', 'dontAsk', '--no-session-persistence');
    const dirs = [...new Set(images.map((image) => path.dirname(path.resolve(image))))];
    args.push('--add-dir', ...dirs);
  }
  const { code, stdout, stderr } = await runProcess(cmd, args, prompt, cfg.cliTimeoutMs);
  // even on failure claude prints a result wrapper — prefer its message over raw output
  let wrapper: unknown;
  try {
    wrapper = JSON.parse(stdout);
  } catch {
    wrapper = null;
  }
  if (wrapper && typeof wrapper === 'object' && 'result' in wrapper) {
    const w = wrapper as { result?: unknown; is_error?: boolean };
    if (w.is_error || code !== 0) throw new Error(`claude CLI error: ${String(w.result ?? 'unknown').slice(0, 300)}`);
    return String(w.result ?? '').trim();
  }
  if (code !== 0) throw new Error(`claude exited with code ${code}: ${(stderr || stdout).trim().slice(0, 300)}`);
  return stdout.trim(); // older CLI or plain-text output
}

async function runCursor(cfg: LlmConfig, prompt: string, model?: string): Promise<string> {
  const cmd = cfg.cliPath || 'cursor-agent';
  const args = ['-p', '--output-format', 'json'];
  if (model) args.push('--model', model);
  args.push(prompt);
  const { code, stdout, stderr } = await runProcess(cmd, args, '', cfg.cliTimeoutMs);
  let wrapper: unknown;
  try {
    wrapper = JSON.parse(stdout);
  } catch {
    wrapper = null;
  }
  if (wrapper && typeof wrapper === 'object' && 'result' in wrapper) {
    const w = wrapper as { result?: unknown; is_error?: boolean; subtype?: string };
    if (w.is_error || w.subtype === 'error' || code !== 0) {
      throw new Error(`cursor CLI error: ${String(w.result ?? stderr ?? 'unknown').slice(0, 300)}`);
    }
    return String(w.result ?? '').trim();
  }
  if (code !== 0) throw new Error(`cursor-agent exited with code ${code}: ${(stderr || stdout).trim().slice(0, 300)}`);
  if (!stdout.trim()) throw new Error('cursor-agent finished but produced no message');
  return stdout.trim();
}

function runProcess(cmd: string, args: string[], stdin: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  const limit = timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: os.tmpdir(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    // reject on timeout without waiting for 'close' — grandchildren of the CLI
    // may hold the stdio pipes open even after the CLI itself is killed
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(`${cmd} timed out after ${Math.round(limit / 1000)}s`)));
    }, limit);

    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(() => {
        if (err.code === 'ENOENT') reject(new Error(`${cmd} CLI not found — install it or set a CLI path in knode.config.json`));
        else reject(err);
      });
    });
    child.on('close', (code) => {
      finish(() => resolve({ code: code ?? -1, stdout, stderr }));
    });

    child.stdin.on('error', () => {}); // CLI may exit before consuming stdin
    child.stdin.write(stdin);
    child.stdin.end();
  });
}
