import { spawn } from 'node:child_process';
import path from 'node:path';
import { resolveSecret } from '../../config.js';

/**
 * Running another program as part of a feed (docs/design/26 §6): a command
 * connector (`knode-feed/1`, JSON Lines out) or a command stage
 * (`knode-feed-stage/1`, one JSON object out). The program gets one JSON
 * object on stdin and a small environment — PATH, HOME, LANG, TZ and what
 * the feed's `env` names, with "env:VAR" resolved — never the server's own
 * secrets. It runs in the data directory.
 */

export interface CommandSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface CommandOptions {
  cwd: string;
  signal?: AbortSignal;
  /** Called with each complete stdout line as it arrives (JSON Lines). */
  onLine?: (line: string) => void;
  /** Largest stdout kept when there is no onLine (default 32 MB). */
  maxBytes?: number;
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const KEEP_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'USER', 'SHELL', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy'];

export function commandEnv(env: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of KEEP_ENV) if (process.env[key] !== undefined) out[key] = process.env[key];
  for (const [k, v] of Object.entries(env)) out[k] = resolveSecret(String(v));
  return out;
}

/** "~/x" and paths relative to the data directory; a bare name is looked up on PATH. */
export function resolveCommand(command: string, cwd: string): string {
  if (command.startsWith('~/')) return path.join(process.env.HOME ?? '', command.slice(2));
  if (command.startsWith('./') || command.startsWith('../')) return path.resolve(cwd, command);
  return command;
}

export function runCommand(spec: CommandSpec, input: unknown, opts: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveCommand(spec.command, opts.cwd), spec.args ?? [], {
      cwd: opts.cwd,
      env: commandEnv(spec.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const max = opts.maxBytes ?? 32 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let pending = '';
    let killed: string | null = null;
    const kill = (why: string) => {
      if (killed) return;
      killed = why;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref?.();
    };
    const timer = setTimeout(() => kill(`timed out after ${Math.round((spec.timeoutMs ?? 300_000) / 1000)} s`), spec.timeoutMs ?? 300_000);
    const onAbort = () => kill('cancelled');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (opts.onLine) {
        pending += chunk;
        let at: number;
        while ((at = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, at).trim();
          pending = pending.slice(at + 1);
          if (line) opts.onLine(line);
        }
        return;
      }
      stdout += chunk;
      if (stdout.length > max) kill(`wrote more than ${max} bytes`);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(new Error(`${spec.command}: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.onLine && pending.trim()) opts.onLine(pending.trim());
      if (killed) return reject(new Error(`${spec.command} ${killed}${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ''}`));
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {
      // a program that does not read its input closes the pipe early; its answer still counts
    });
    child.stdin.end(JSON.stringify(input));
  });
}

/** Run a program that answers one JSON object; a non-zero exit or an unparsable answer is an error naming the program. */
export async function runJsonCommand<T>(spec: CommandSpec, input: unknown, opts: CommandOptions): Promise<T> {
  const res = await runCommand(spec, input, opts);
  if (res.code !== 0) throw new Error(`${spec.command} exited with ${res.code}${res.stderr.trim() ? `: ${res.stderr.trim().slice(-500)}` : ''}`);
  const text = res.stdout.trim();
  const start = text.indexOf('{');
  try {
    return JSON.parse(start > 0 ? text.slice(start) : text) as T;
  } catch {
    throw new Error(`${spec.command} did not answer a JSON object: ${text.slice(0, 200)}`);
  }
}
