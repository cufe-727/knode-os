#!/usr/bin/env node
// knode-os remote labeling worker — one file, no dependencies, Node 20+.
//
// Takes extraction segments from a knode-os server (POST /remote/v1/.../labeling/lease),
// runs each on a model available on this machine, and hands back the raw reply
// (…/labeling/complete). The server builds every prompt and checks every reply; this
// script only runs the calls. Leases are renewed while a call runs and handed back
// when the worker stops, so a stopped or crashed worker never strands work.
//
//   KNODE_TOKEN=knr_… node knode-worker.mjs --server https://knode-os.example \
//     --workspace admin/finance --backends codex:2,cursor:2
//
// Backends (slots after the colon):
//   codex   codex exec, read-only sandbox, ~/.codex/config.toml ignored (--codex-model, --codex-effort)
//   cursor  cursor-agent -p in ask mode (--cursor-model)
//   claude  claude -p, one turn (--claude-model)
//   api     an OpenAI-compatible /chat/completions endpoint (--api-base-url, --api-model;
//           the key comes from the variable named by --api-key-env, default OPENAI_API_KEY)
//
// Other options: --name <worker> (default: hostname), --timeout-ms <ms> (default 600000), --idle-ms <ms> (poll wait),
// --header "Name: value" (repeatable; e.g. a Cloudflare Access service token),
// --token-file <path> (instead of KNODE_TOKEN), --once (exit when there is no work),
// --check (show what the token may do and which backends are installed, then exit).

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* ------------------------------- options -------------------------------- */

function parseArgs(argv) {
  const opts = { headers: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const [key, inline] = arg.slice(2).split(/=(.*)/s, 2);
    const flag = ['once', 'check', 'help'].includes(key);
    const value = flag ? true : inline ?? argv[++i];
    if (value === undefined) throw new Error(`--${key} needs a value`);
    if (key === 'header') opts.headers.push(value);
    else opts[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  return opts;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}

const server = String(args.server ?? process.env.KNODE_SERVER ?? '').replace(/\/+$/, '');
const workspace = String(args.workspace ?? process.env.KNODE_WORKSPACE ?? '');
const token = (args.tokenFile ? fs.readFileSync(String(args.tokenFile), 'utf8') : process.env.KNODE_TOKEN ?? '').trim();
const workerName = String(args.name ?? process.env.KNODE_WORKER_NAME ?? os.hostname());
const timeoutMs = Number(args.timeoutMs ?? 600_000);
const backendSpec = String(args.backends ?? process.env.KNODE_BACKENDS ?? 'codex:1');
const idleMs = Math.max(100, Number(args.idleMs ?? 20_000));
if (!server || !/^https?:\/\//.test(server)) throw new Error('--server http(s)://… required (or KNODE_SERVER)');
if (!/^[^/]+\/[^/]+$/.test(workspace)) throw new Error('--workspace <user>/<workspace-id> required (or KNODE_WORKSPACE)');
if (!token) throw new Error('a token is required: KNODE_TOKEN=knr_… or --token-file <path>');
if (server.startsWith('http://') && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(server)) {
  throw new Error('refusing to send the token over plain http to a remote host — use https, or an SSH tunnel to 127.0.0.1');
}
const extraHeaders = Object.fromEntries(args.headers.map((h) => {
  const i = h.indexOf(':');
  if (i < 1) throw new Error(`--header "Name: value", got ${h}`);
  return [h.slice(0, i).trim(), h.slice(i + 1).trim()];
}));
const base = `${server}/remote/v1/w/${workspace.split('/').map(encodeURIComponent).join('/')}`;

/* ------------------------------- logging -------------------------------- */

const log = (msg) => console.log(`${new Date().toISOString().slice(0, 19).replace('T', ' ')} ${msg}`);

/* ----------------------------- server calls ----------------------------- */

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 200) };
  }
  if (!res.ok && res.status !== 409) {
    const err = new Error(`${method} ${url.replace(server, '')} → ${res.status}: ${data.error ?? res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return { status: res.status, data };
}

/* ------------------------- failures and backoff ------------------------- */
// a copy of src/labeling/failures.ts

const FATAL = /cli not found|\benoent\b|not logged in|login required|please (log|sign) ?in|unauthori[sz]ed|authentication (failed|required)|invalid api key|incorrect api key|\b401\b|\b403\b|forbidden|subscription (has )?expired/;
const TRANSIENT = /rate.?limit|usage limit|quota|too many requests|\b429\b|overloaded|over capacity|try again (later|in)|\b50[234]\b|econnreset|econnrefused|etimedout|enotfound|eai_again|socket hang up|network|fetch failed|timed? ?out|reconnecting|transport channel closed|error sending request|http\/request failed|stream (disconnected|error)|connection (reset|closed|refused|error)|failed to refresh available models|\bebadf\b|\bemfile\b|\benfile\b|spawn \S+ e[a-z]+/;
const classify = (message) => {
  const m = String(message).toLowerCase();
  return FATAL.test(m) ? 'fatal' : TRANSIENT.test(m) ? 'transient' : 'model';
};

function newHealth() {
  return { transientStreak: 0, modelStreak: 0, cooldowns: 0, fatalStreak: 0, pausedUntil: 0, calls: 0, ok: 0, failed: 0 };
}

function rest(health, kind) {
  let ms = 0;
  if (kind === 'transient') ms = Math.min(600_000, 60_000 * 2 ** health.transientStreak++);
  else if (kind === 'fatal') ms = Math.min(6 * 3_600_000, 1_800_000 * 2 ** health.fatalStreak++);
  else if (++health.modelStreak >= 5) {
    health.modelStreak = 0;
    ms = Math.min(4 * 3_600_000, 1_800_000 * 2 ** health.cooldowns++);
  }
  if (ms) health.pausedUntil = Math.max(health.pausedUntil, Date.now() + ms);
  return ms;
}

/* ------------------------------- backends ------------------------------- */

const children = new Set();

function run(cmd, argv, stdin, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      children.delete(child);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`)));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => finish(() => reject(err.code === 'ENOENT' ? new Error(`${cmd} CLI not found`) : err)));
    child.on('close', (code) => finish(() => resolve({ code: code ?? -1, stdout, stderr })));
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

const tail = (stderr, stdout) => {
  const t = (stderr || stdout).trim();
  return t.length > 400 ? `…${t.slice(-400)}` : t;
};

/** An empty folder for one call: no repo instructions to pick up, nothing to touch. */
function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knode-worker-'));
}

/** cursor-agent's NDJSON stream → the answer after its last tool call (a copy of src/llm/cli.ts readCursorStream). */
function readCursorStream(stdout) {
  const chunks = [];
  let result = '';
  let error;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'assistant') {
      const parts = Array.isArray(event.message?.content) ? event.message.content : [];
      const text = parts.map((p) => (p && typeof p === 'object' && 'text' in p ? String(p.text ?? '') : '')).join('');
      if (text.trim()) chunks.push(text);
    } else if (event.type === 'tool_call' && event.subtype === 'started') {
      chunks.length = 0;
    } else if (event.type === 'result') {
      if (event.is_error || event.subtype === 'error') error = String(event.result ?? 'unknown');
      else result = String(event.result ?? '');
    }
  }
  return { text: chunks.join('\n').trim() || result.trim(), error };
}

const BACKENDS = {
  codex: {
    bin: () => String(args.codexBin ?? 'codex'),
    label: () => `codex:${args.codexModel ?? 'default'}`,
    async complete(task) {
      const dir = scratch();
      const out = path.join(dir, 'answer.txt');
      const ws = path.join(dir, 'workspace');
      fs.mkdirSync(ws);
      try {
        const argv = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', ws, '--output-last-message', out];
        if (args.codexModel) argv.push('--model', String(args.codexModel));
        if (args.codexEffort) argv.push('-c', `model_reasoning_effort="${args.codexEffort}"`);
        argv.push('-');
        const r = await run(this.bin(), argv, task.prompt, ws);
        if (r.code !== 0) throw new Error(`codex exec exited with code ${r.code}: ${tail(r.stderr, r.stdout)}`);
        const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim() : '';
        if (!text) throw new Error('codex exec finished but produced no message');
        return text;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  cursor: {
    bin: () => String(args.cursorBin ?? 'cursor-agent'),
    label: () => `cursor:${args.cursorModel ?? 'default'}`,
    async complete(task) {
      const dir = scratch();
      try {
        const argv = ['-p', '--output-format', 'stream-json', '--trust', '--mode', 'ask', '--sandbox', 'enabled', '--workspace', dir];
        if (args.cursorModel) argv.push('--model', String(args.cursorModel));
        const r = await run(this.bin(), argv, task.prompt, dir);
        const { text, error } = readCursorStream(r.stdout);
        if (error || r.code !== 0) throw new Error(`cursor CLI error: ${error ? error.slice(0, 400) : tail(r.stderr, r.stdout)}`);
        if (!text) throw new Error('cursor-agent finished but produced no message');
        return text;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  claude: {
    bin: () => String(args.claudeBin ?? 'claude'),
    label: () => `claude:${args.claudeModel ?? 'default'}`,
    async complete(task) {
      const dir = scratch();
      try {
        const argv = ['-p', '--output-format', 'json', '--max-turns', '1', '--no-session-persistence'];
        if (args.claudeModel) argv.push('--model', String(args.claudeModel));
        const r = await run(this.bin(), argv, task.prompt, dir);
        let wrapper = null;
        try {
          wrapper = JSON.parse(r.stdout);
        } catch {
          // fall through
        }
        if (wrapper && typeof wrapper === 'object' && 'result' in wrapper) {
          if (wrapper.is_error || r.code !== 0) throw new Error(`claude CLI error: ${String(wrapper.result ?? 'unknown').slice(0, 400)}`);
          return String(wrapper.result ?? '').trim();
        }
        if (r.code !== 0) throw new Error(`claude exited with code ${r.code}: ${tail(r.stderr, r.stdout)}`);
        return r.stdout.trim();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  api: {
    bin: () => null,
    label: () => `api:${args.apiModel ?? process.env.KNODE_API_MODEL ?? '?'}`,
    async complete(task) {
      const baseUrl = String(args.apiBaseUrl ?? process.env.KNODE_API_BASE_URL ?? process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
      const model = String(args.apiModel ?? process.env.KNODE_API_MODEL ?? '');
      const key = process.env[String(args.apiKeyEnv ?? 'OPENAI_API_KEY')] ?? '';
      if (!baseUrl || !model) throw new Error('api backend needs --api-base-url and --api-model (CLI not found)');
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model, messages: task.messages, temperature: 0.2, max_tokens: task.maxTokens, response_format: { type: 'json_object' } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`chat request failed (${res.status}): ${body.slice(0, 300)}`);
      const content = JSON.parse(body)?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('chat response had no content');
      return content;
    },
  },
};

const backends = backendSpec.split(',').map((part) => {
  const [name, n] = part.trim().split(':');
  if (!BACKENDS[name]) throw new Error(`unknown backend "${name}" — use ${Object.keys(BACKENDS).join(', ')}`);
  const slots = Math.max(0, Math.min(16, Number(n ?? 1)));
  if (!Number.isFinite(slots)) throw new Error(`bad slot count in "${part}"`);
  return { name, slots, impl: BACKENDS[name], health: newHealth() };
}).filter((b) => b.slots > 0);
if (backends.length === 0) throw new Error('no backend has a slot');

/* ------------------------------ check mode ------------------------------ */

function onPath(bin) {
  if (!bin) return true;
  if (bin.includes('/')) return fs.existsSync(bin);
  return (process.env.PATH ?? '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, bin)));
}

if (args.check) {
  const { data } = await call('GET', `${server}/remote/v1/whoami`);
  log(`token ${data.name} (${data.id}): scopes ${data.scopes?.join(', ')}; workspaces ${data.workspaces?.join(', ')}`);
  const { data: status } = await call('GET', `${base}/labeling/status`);
  log(`${workspace}: ${status.queued} documents queued, ${status.leases?.length ?? 0} segments out, ${status.workers?.length ?? 0} workers seen`);
  for (const b of backends) log(`backend ${b.name} × ${b.slots}: ${onPath(b.impl.bin()) ? 'installed' : 'NOT FOUND on PATH'} (${b.impl.label()})`);
  process.exit(0);
}

/* -------------------------------- slots --------------------------------- */

let stopping = false;
const held = new Map(); // lease id → identity body, for release on shutdown
const sleepers = new Set();
const sleep = (ms) => new Promise((resolve) => {
  if (stopping) return resolve();
  const done = () => {
    clearTimeout(t);
    sleepers.delete(done);
    resolve();
  };
  const t = setTimeout(done, ms);
  sleepers.add(done);
});

async function slot(backend, n) {
  const identity = { worker: `${workerName}/${backend.name}#${n}`, backend: backend.impl.label() };
  let idleRounds = 0;
  while (!stopping) {
    const pause = backend.health.pausedUntil - Date.now();
    if (pause > 0) {
      await sleep(Math.min(pause, 15_000));
      continue;
    }
    let task;
    let leaseSeconds = 900;
    try {
      const { data } = await call('POST', `${base}/labeling/lease`, { ...identity, max: 1 });
      task = data.tasks?.[0];
      leaseSeconds = data.leaseSeconds ?? leaseSeconds;
    } catch (err) {
      log(`${identity.worker}: lease failed: ${err.message}`);
      if (err.status === 401 || err.status === 403) {
        stopping = true;
        break;
      }
      await sleep(30_000);
      continue;
    }
    if (!task) {
      if (args.once && ++idleRounds >= 2) break;
      await sleep(idleMs * (0.75 + Math.random() * 0.5));
      continue;
    }
    idleRounds = 0;
    held.set(task.id, identity);
    const renew = setInterval(() => {
      call('POST', `${base}/labeling/renew`, { ...identity, ids: [task.id] }).catch((err) => log(`${identity.worker}: renew failed: ${err.message}`));
    }, Math.max(10_000, (leaseSeconds * 1000) / 3));
    const started = Date.now();
    const where = `${task.document.path}${task.document.parts > 1 ? ` [${task.document.part}/${task.document.parts}]` : ''}`;
    let outcome;
    try {
      const text = await backend.impl.complete(task);
      outcome = { ok: true, text, model: backend.impl.label() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcome = { ok: false, error: message, kind: classify(message), model: backend.impl.label() };
    } finally {
      clearInterval(renew);
    }
    if (stopping && !outcome.ok) break; // killed on shutdown: released below
    backend.health.calls++;
    try {
      const { data } = await call('POST', `${base}/labeling/complete`, { ...identity, id: task.id, ...outcome });
      held.delete(task.id);
      const secs = Math.round((Date.now() - started) / 1000);
      if (!data.accepted) log(`${identity.worker}: ${where} not taken back: ${data.reason}`);
      else if (outcome.ok) log(`${identity.worker}: ${where} done in ${secs}s${data.documentWritten ? ' — document written' : ''}`);
      else log(`${identity.worker}: ${where} failed (${outcome.kind}) in ${secs}s: ${outcome.error.slice(0, 200)}`);
    } catch (err) {
      log(`${identity.worker}: could not hand back ${where}: ${err.message}`);
    }
    if (outcome.ok) {
      backend.health.ok++;
      Object.assign(backend.health, { transientStreak: 0, modelStreak: 0, fatalStreak: 0 });
    } else {
      backend.health.failed++;
      const ms = rest(backend.health, outcome.kind);
      if (ms) log(`${backend.name}: resting ${Math.ceil(ms / 60_000)} min after a ${outcome.kind} failure`);
    }
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal}: stopping — handing back ${held.size} segment(s)`);
  for (const child of children) child.kill('SIGTERM');
  for (const wake of sleepers) wake();
  const byWorker = new Map();
  for (const [id, identity] of held) {
    const list = byWorker.get(identity.worker) ?? { identity, ids: [] };
    list.ids.push(id);
    byWorker.set(identity.worker, list);
  }
  await Promise.allSettled([...byWorker.values()].map(({ identity, ids }) => call('POST', `${base}/labeling/release`, { ...identity, ids })));
}
process.on('SIGINT', () => void shutdown('SIGINT').then(() => process.exit(130)));
process.on('SIGTERM', () => void shutdown('SIGTERM').then(() => process.exit(143)));

log(`knode worker ${workerName} → ${server} ${workspace}: ${backends.map((b) => `${b.name} × ${b.slots}`).join(', ')} (session ${crypto.randomUUID().slice(0, 8)})`);
await Promise.all(backends.flatMap((b) => Array.from({ length: b.slots }, (_, i) => slot(b, i + 1))));
log('no more work — exiting');
