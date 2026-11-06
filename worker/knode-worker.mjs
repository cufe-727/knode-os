#!/usr/bin/env node
// knode-os remote labeling worker — one file, no dependencies, Node 20+.
//
// Takes work from a knode-os server (POST /remote/v1/.../work/lease) — extraction segments,
// summary pages, judge calls, translations and batches of texts to embed — runs each call on
// a model available on this machine, and hands back the raw reply or the raw vectors
// (…/work/complete). The server builds every prompt and every embedding input, and checks
// every reply and vector; this script only runs the calls. Leases are renewed while a call
// runs and handed back when the worker stops, so a stopped or crashed worker never strands work.
//
//   KNODE_TOKEN=knr_… node knode-worker.mjs --server https://knode-os.example \
//     --workspace admin/finance --backends codex:2,cursor:2
//
// Backends (slots after the colon):
//   codex   codex exec, read-only sandbox, ~/.codex/config.toml ignored, plugins, apps and analytics off,
//           Codex's model catalog read from a local copy (--codex-model, --codex-effort, --codex-speed,
//           --codex-catalog-hours: how long a copy lasts, default 24, 0 = download it on every call)
//   cursor  cursor-agent -p in ask mode (--cursor-model)
//   claude  claude -p, one turn (--claude-model, --claude-effort)
//   api     an OpenAI-compatible /chat/completions endpoint (--api-base-url, --api-model;
//           the key comes from the variable named by --api-key-env, default OPENAI_API_KEY)
//   embed   batches of texts to embed, on an OpenAI-compatible /embeddings endpoint of this machine's
//           own: --embed-base-url http://127.0.0.1:12020/v1 --embed-model BAAI/bge-m3 (a local
//           bge-m3, TEI, vLLM, Ollama, or an account of your own; a key, if it needs one, from the
//           variable named by --embed-key-env). The token needs the "embed" scope, and the server
//           takes the vectors only for its pool's model (canonical name: BAAI/bge-m3 = bge-m3) and
//           only once the endpoint passes calibration: it embeds the server's 16 probe texts at
//           startup and after every configuration change, and every vector must come within the
//           server's cosine (0.98) of the server's own. Spot checks follow; a miss parks the slots.
//
// Kinds of work (--kinds extract,summarize,judge,translate; default: every kind the server offers this token):
//   extract    extraction segments, answered with a JSON object
//   summarize  summary pages, answered in Markdown
//   judge      a review's judge calls (are two entities, or two claims, the same?), answered with
//              a JSON object; offered only where the server turned them on
//   translate  a document's segments translated into a content language, answered in Markdown;
//              offered where the workspace has content languages on (docs/design/17)
// The rest comes from the server (GET …/work/config): the kinds it offers, how long a lease
// lasts, and how it runs each kind on codex, claude and cursor — model, effort, speed. A CLI
// backend follows those unless its model is given here. A server that predates work/* hands
// out extraction only, over …/labeling/*.
//
// Other options: --name <worker> (default: hostname), --timeout-ms <ms> (default 600000), --idle-ms <ms> (poll wait),
// --header "Name: value" (repeatable; e.g. a Cloudflare Access service token),
// --token-file <path> (instead of KNODE_TOKEN), --once (exit when there is no work),
// --check (show what the token may do, what the server offers, which backends are installed and — for embed —
// the embedding identity and whether the endpoint passes calibration, then exit).

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
const KINDS = ['extract', 'summarize', 'judge', 'translate'];
const kindSpec = args.kinds ?? process.env.KNODE_KINDS;
const askedKinds = kindSpec ? String(kindSpec).split(',').map((k) => k.trim()).filter(Boolean) : null;
for (const k of askedKinds ?? []) {
  if (k === 'embed') throw new Error('embed work is taken by embed slots: use --backends embed:N with --embed-base-url and --embed-model');
  if (!KINDS.includes(k)) throw new Error(`unknown kind of work "${k}" — use ${KINDS.join(', ')}`);
}
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

// an own embedding endpoint (the embed backend)
const isLoopback = (url) => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);
const embedBaseUrl = String(args.embedBaseUrl ?? process.env.KNODE_EMBED_BASE_URL ?? '').replace(/\/+$/, '');
const embedModel = String(args.embedModel ?? process.env.KNODE_EMBED_MODEL ?? '');
const embedKey = args.embedKeyEnv ? String(process.env[String(args.embedKeyEnv)] ?? '') : '';
if (embedBaseUrl && !/^https?:\/\//.test(embedBaseUrl)) throw new Error('--embed-base-url http(s)://…/v1 required');
if (embedBaseUrl && !embedModel) throw new Error('--embed-base-url needs --embed-model (the model the endpoint serves, e.g. BAAI/bge-m3)');
if (args.embedKeyEnv && !embedKey) throw new Error(`--embed-key-env names ${args.embedKeyEnv}, which is not set`);
if (embedKey && embedBaseUrl.startsWith('http://') && !isLoopback(embedBaseUrl)) {
  throw new Error('refusing to send the embedding key over plain http to a remote host — use https');
}

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

/* ------------------------ the server's configuration ------------------------ */

// GET …/work/config: the kinds this token may take here, lease length, model hints per kind and CLI.
// null for a server that predates work/*: extraction only, over …/labeling/*.
let work = null;
let reading = null;

async function readWorkConfig() {
  try {
    work = (await call('GET', `${base}/work/config`)).data;
  } catch (err) {
    // an older server answers a path it does not know with a bare 404; a missing workspace says so
    if (err.status !== 404 || /no workspace/.test(err.message)) throw err;
    work = null;
  }
}

/** Read the config again (a lease answer said it changed); one read at a time, failures logged. */
function rereadWorkConfig() {
  reading ??= readWorkConfig()
    .then(() => {
      // every configuration change means calibrating again before the next embed batch
      calibration = null;
      log(`server configuration changed: ${describeKinds()}`);
    })
    .catch((err) => log(`could not read the server configuration: ${err.message}`))
    .finally(() => (reading = null));
  return reading;
}

/** The kinds the LLM slots ask for: those given with --kinds, of the ones the server offers. */
function kindsNow() {
  const offered = work ? KINDS.filter((k) => work.kinds?.[k] === true) : ['extract'];
  return askedKinds ? askedKinds.filter((k) => offered.includes(k)) : offered;
}

function describeKinds() {
  if (!work) return 'a server from before work/* — extraction only';
  const offered = [...KINDS, 'embed'].filter((k) => work.kinds?.[k] === true);
  const takes = [...kindsNow(), ...(hasEmbedSlots && work.kinds?.embed === true ? ['embed'] : [])];
  return `offers ${offered.join(', ') || 'nothing to this token'}; this worker takes ${takes.join(', ') || 'nothing'}`;
}

/** How the server runs this kind of work on this CLI, unless this worker was given a model of its own. */
const hintFor = (kind, backend) => work?.hints?.[kind ?? 'extract']?.[backend] ?? null;

/* ------------------------- failures and backoff ------------------------- */
// a copy of src/labeling/failures.ts

const FATAL = /cli not found|\benoent\b|not logged in|login required|please (log|sign) ?in|unauthori[sz]ed|authentication (failed|required)|invalid api key|incorrect api key|\b401\b|\b403\b|forbidden|subscription (has )?expired/;
const TRANSIENT = /rate.?limit|usage limit|out of usage|hit your \w+ limit|quota|too many requests|\b429\b|overloaded|over capacity|try again (later|in)|\b50[234]\b|econnreset|econnrefused|etimedout|enotfound|eai_again|socket hang up|network|fetch failed|timed? ?out|reconnecting|transport channel closed|error sending request|http\/request failed|stream (disconnected|error)|connection (reset|closed|refused|error)|failed to refresh available models|\bebadf\b|\bemfile\b|\benfile\b|spawn \S+ e[a-z]+/;
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

/* ------------------------------- embedding ------------------------------- */
// An embed slot's call: OpenAI-compatible /embeddings with encoding_format "float", `dimensions` when the key
// sends them and OpenRouter's provider pin when it has an upstream — a copy of PooledEmbeddingProvider's
// request (src/ingest/embedding-router.ts). The vectors go back raw, as little-endian float32 in base64;
// the server checks and finishes them. An error body is never read: it may echo the key.

async function embedRequest(endpoint, inputs) {
  const res = await fetch(`${endpoint.baseUrl.replace(/\/+$/, '')}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}) },
    body: JSON.stringify({
      model: endpoint.model, input: inputs, encoding_format: 'float',
      ...(endpoint.sendDimensions ? { dimensions: endpoint.dimensions } : {}),
      ...(endpoint.upstream ? { provider: { only: [endpoint.upstream], allow_fallbacks: false } } : {}),
    }),
    signal: AbortSignal.timeout(Math.min(timeoutMs, 120_000)),
  });
  if (!res.ok) {
    await res.body?.cancel();
    const err = new Error(`embedding endpoint returned HTTP ${res.status}`);
    err.http = { status: res.status };
    throw err;
  }
  const body = await res.json();
  const data = Array.isArray(body?.data) ? [...body.data].sort((a, b) => a.index - b.index) : null;
  if (!data || data.length !== inputs.length) throw new Error(`embedding response has ${data?.length ?? 'no'} vectors for ${inputs.length} inputs`);
  const vectors = data.map((d) => d?.embedding);
  if (!vectors.every((v) => Array.isArray(v) && v.length > 0)) throw new Error('embedding response has a vector that is no array of numbers');
  const tokens = body.usage?.prompt_tokens ?? body.usage?.total_tokens;
  return { vectors, endpointModel: typeof body.model === 'string' ? body.model : null, tokens: count(tokens) || null };
}

/** Vectors as the server takes them: little-endian float32, n × dimensions, base64. */
function encodeVectors(vectors) {
  const dims = vectors[0]?.length ?? 0;
  const buf = Buffer.alloc(vectors.length * dims * 4);
  vectors.forEach((v, i) => v.forEach((x, j) => buf.writeFloatLE(Number(x), (i * dims + j) * 4)));
  return { vectors: buf.toString('base64'), dimensions: dims };
}

const ownEndpoint = embedBaseUrl ? { baseUrl: embedBaseUrl, model: embedModel, apiKey: embedKey, sendDimensions: false, upstream: null } : null;
let calibration = null; // the id the server gave this endpoint's calibration; null until it passes
let calibrating = null;
let embedParkedUntil = 0;
let embedNote = '';

/** Embed the server's probe set on the own endpoint and hand it in; true when the server takes the endpoint. */
async function calibrate() {
  const probe = work?.embedding?.probe;
  if (!ownEndpoint || !probe?.texts?.length) return false;
  let made;
  try {
    made = await embedRequest(ownEndpoint, probe.texts);
  } catch (err) {
    log(`embed: calibration could not reach ${ownEndpoint.baseUrl}: ${err.message} — trying again in 1 min`);
    embedParkedUntil = Date.now() + 60_000;
    return false;
  }
  const { data } = await call('POST', `${base}/work/calibrate`, {
    worker: workerName, model: ownEndpoint.model, ...(made.endpointModel ? { endpointModel: made.endpointModel } : {}), ...encodeVectors(made.vectors),
  });
  if (data.ok) {
    calibration = data.calibration;
    log(`embed: ${ownEndpoint.model} passed calibration for ${work.embedding.vectorModel} (cosine ≥ ${Number(data.minCosine).toFixed(4)}, mean ${Number(data.meanCosine).toFixed(4)})`);
    return true;
  }
  calibration = null;
  const waitMs = Math.max(60_000, Number(data.retryAfterSeconds ?? 900) * 1000);
  embedParkedUntil = Date.now() + waitMs;
  embedNote = data.reason ?? 'refused';
  log(`embed: the server refused ${ownEndpoint.model} at ${ownEndpoint.baseUrl}: ${embedNote}${Number.isFinite(data.minCosine) ? ` (lowest cosine ${Number(data.minCosine).toFixed(4)})` : ''} — calibrating again in ${Math.round(waitMs / 60_000)} min`);
  return false;
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

/* ------------------------ codex's model catalog ------------------------- */
// A copy of src/llm/codex-catalog.ts. Every codex exec downloads Codex's whole model catalog as it starts (650 KB,
// once or twice a call; it changes about once a day), so a call reads it from a local copy instead, passed as
// -c model_catalog_json. The copy is Codex's own cache ($CODEX_HOME/models_cache.json) — its whole model list —
// taken after a call without a copy, if Codex wrote it in the last ten minutes, for this binary's version, with
// the call's model in it. It belongs to one binary (real path, size, mtime) and model, lasts --codex-catalog-hours
// (default 24; 0 = off) and lives in ~/.knode-os/codex-catalog (KNODE_CODEX_CATALOG_DIR). A copy Codex cannot read
// is dropped and the call repeated once without it.

const catalogHours = (() => {
  const v = args.codexCatalogHours ?? process.env.KNODE_CODEX_CATALOG_HOURS;
  const h = v === undefined || String(v).trim() === '' ? NaN : Number(v);
  return Number.isFinite(h) && h >= 0 ? h : 24;
})();
const catalogDir = process.env.KNODE_CODEX_CATALOG_DIR || path.join(os.homedir(), '.knode-os', 'codex-catalog');
const codexVersions = new Map(); // binary stamp → Promise<last word of `codex --version`>
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

function which(bin) {
  const candidates = bin.includes('/') ? [path.resolve(bin)] : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, bin));
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      if (fs.statSync(c).isFile()) return c;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Where the copy for this binary and model lives, or null (no model named, copies off, binary not found). */
function codexCatalog(bin, model) {
  if (!model || catalogHours <= 0) return null;
  const found = which(bin);
  if (!found) return null;
  try {
    const real = fs.realpathSync(found);
    const st = fs.statSync(real, { bigint: true });
    const stamp = sha(`${real}\0${st.size}\0${st.mtimeNs}`).slice(0, 16);
    return { real, stamp, model, file: path.join(catalogDir, `codex-models-${stamp}-${sha(model).slice(0, 8)}.json`) };
  } catch {
    return null;
  }
}

function pinnedCatalog(catalog) {
  if (!catalog) return null;
  try {
    const age = Date.now() - fs.statSync(catalog.file).mtimeMs;
    return age > -1000 && age < catalogHours * 3_600_000 ? catalog.file : null;
  } catch {
    return null;
  }
}

function codexVersion(real) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(real, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const words = out.trim().split(/\s+/).filter(Boolean);
      resolve(code === 0 && words.length ? words[words.length - 1] : null);
    });
  });
}

/** After a call without a copy: copy Codex's cache if it is usable. */
async function refreshCatalog(catalog) {
  if (!catalog) return;
  let cache;
  try {
    const source = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json');
    if (Date.now() - fs.statSync(source).mtimeMs > 600_000) return;
    cache = JSON.parse(fs.readFileSync(source, 'utf8'));
  } catch {
    return;
  }
  const models = cache?.models;
  if (!Array.isArray(models) || !models.some((m) => m?.slug === catalog.model)) return;
  if (!codexVersions.has(catalog.stamp)) codexVersions.set(catalog.stamp, codexVersion(catalog.real));
  const version = await codexVersions.get(catalog.stamp);
  if (!version) codexVersions.delete(catalog.stamp);
  if (!version || cache.client_version !== version) return;
  // a temp file and a rename: other slots may be starting codex with this copy right now
  const partial = `${catalog.file}.${process.pid}-${crypto.randomUUID().slice(0, 8)}.part`;
  try {
    fs.mkdirSync(catalogDir, { recursive: true });
    fs.writeFileSync(partial, JSON.stringify({ models }));
    fs.renameSync(partial, catalog.file);
  } catch (err) {
    fs.rmSync(partial, { force: true });
    log(`codex model catalog not saved: ${err.message}`);
    return;
  }
  // copies long past their lifetime (another binary's or model's), and temp files a crashed writer left
  const keep = Math.max(2 * catalogHours, catalogHours + 1) * 3_600_000;
  for (const name of fs.readdirSync(catalogDir)) {
    if (!name.startsWith('codex-models-')) continue;
    try {
      const age = Date.now() - fs.statSync(path.join(catalogDir, name)).mtimeMs;
      if (age > (name.endsWith('.part') ? 3_600_000 : keep)) fs.rmSync(path.join(catalogDir, name), { force: true });
    } catch {
      // gone already
    }
  }
  log(`codex model catalog saved for ${catalogHours} h: ${models.length} models for ${catalog.model}, codex ${version}`);
}

/** Whether a failed call failed because of its copy: Codex could not parse it (dropped) or it was gone. */
function catalogRejected(file, stderr) {
  if (stderr.includes('model_catalog_json')) {
    fs.rmSync(file, { force: true });
    return true;
  }
  return !fs.existsSync(file);
}

/* --------------------------------- usage --------------------------------- */
// What a call used, as its CLI or endpoint reported it (a copy of src/llm/usage.ts): every token read — cache
// reads and writes included — as inputTokens, every token written, reasoning included, as outputTokens. It goes
// back with the answer, so the server's estimates learn from this machine's calls too (docs/design/18).

const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const counted = (u) => (u.inputTokens > 0 || u.outputTokens > 0 ? u : null);

/** codex exec --json: each turn.completed's usage added up, and a failed turn's reason. */
function readCodexEvents(stdout) {
  const u = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  let error = null;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'turn.completed') {
      const t = event.usage ?? {};
      u.inputTokens += count(t.input_tokens);
      u.cachedInputTokens += count(t.cached_input_tokens);
      u.cacheWriteTokens += count(t.cache_write_input_tokens);
      u.outputTokens += count(t.output_tokens);
      u.reasoningTokens += count(t.reasoning_output_tokens);
    } else if (event.type === 'turn.failed' && typeof event.error?.message === 'string') error = event.error.message.trim();
    else if (event.type === 'error' && typeof event.message === 'string') error ??= event.message.trim();
  }
  return { usage: counted(u), error };
}

/** Claude's and Cursor's counts: cache reads and writes beside the input. */
function cachedUsage(input, read, write, output, cost) {
  const u = counted({ inputTokens: count(input) + count(read) + count(write), cachedInputTokens: count(read), cacheWriteTokens: count(write), outputTokens: count(output), reasoningTokens: 0 });
  if (u && count(cost)) u.costUsd = cost;
  return u;
}

/** Chat Completions' usage. */
function chatUsage(body) {
  const t = body?.usage ?? {};
  return counted({
    inputTokens: count(t.prompt_tokens), cachedInputTokens: count(t.prompt_tokens_details?.cached_tokens), cacheWriteTokens: 0,
    outputTokens: count(t.completion_tokens), reasoningTokens: count(t.completion_tokens_details?.reasoning_tokens),
  });
}

/** cursor-agent's NDJSON stream → the answer after its last tool call (a copy of src/llm/cli.ts readCursorStream). */
function readCursorStream(stdout) {
  const chunks = [];
  let result = '';
  let error;
  let usage = null;
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
      const t = event.usage ?? {};
      usage = cachedUsage(t.inputTokens, t.cacheReadTokens, t.cacheWriteTokens, t.outputTokens) ?? usage;
    }
  }
  return { text: chunks.join('\n').trim() || result.trim(), error, usage };
}

// A backend given a model here ignores the server's hint for it (an effort chosen for another model);
// otherwise the hint's model, effort and speed apply, each unless given here.
const own = (model, hint) => (model ? null : hint);

const BACKENDS = {
  codex: {
    bin: () => String(args.codexBin ?? 'codex'),
    label: (hint) => `codex:${args.codexModel ?? own(args.codexModel, hint)?.model ?? 'default'}`,
    async complete(task, hint, report) {
      const h = own(args.codexModel, hint);
      const model = args.codexModel ?? h?.model;
      const effort = args.codexEffort ?? h?.effort;
      const speed = args.codexSpeed ?? h?.speed;
      const dir = scratch();
      const out = path.join(dir, 'answer.txt');
      const ws = path.join(dir, 'workspace');
      fs.mkdirSync(ws);
      const catalog = codexCatalog(this.bin(), model ? String(model) : '');
      let pinned = pinnedCatalog(catalog);
      try {
        // plugins on would download ChatGPT's whole plugin catalog (~15 MB) on every call, apps on the apps
        // listing (~1 MB); analytics on uploads ~0.65 MB of metrics at exit. `-c`, unlike --disable, is ignored
        // by a Codex without them. The model catalog comes from the local copy when there is one (above).
        // --json prints the turn's token usage; the answer still comes from --output-last-message.
        const argv = () => [
          'exec', '--ignore-user-config', '--ephemeral', '-c', 'features.plugins=false', '-c', 'features.apps=false',
          '-c', 'analytics.enabled=false', ...(pinned ? ['-c', `model_catalog_json=${JSON.stringify(pinned)}`] : []),
          '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', ws, '--output-last-message', out, '--json',
          ...(model ? ['--model', String(model)] : []),
          ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
          ...(speed ? ['-c', `service_tier="${speed}"`] : []),
          '-',
        ];
        let r;
        for (;;) {
          try {
            r = await run(this.bin(), argv(), task.prompt, ws);
          } finally {
            if (!pinned) await refreshCatalog(catalog);
          }
          if (!pinned || r.code === 0 || !catalogRejected(pinned, r.stderr)) break;
          log(`codex could not read the saved model catalog, calling without it: ${tail(r.stderr, '')}`);
          pinned = null;
        }
        const events = readCodexEvents(r.stdout);
        if (events.usage) report(events.usage);
        if (r.code !== 0) throw new Error(`codex exec exited with code ${r.code}: ${events.error ?? tail(r.stderr, r.stdout)}`);
        const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim() : '';
        if (!text) throw new Error(`codex exec finished but produced no message${events.error ? `: ${events.error}` : ''}`);
        return text;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  cursor: {
    bin: () => String(args.cursorBin ?? 'cursor-agent'),
    label: (hint) => `cursor:${args.cursorModel ?? hint?.model ?? 'default'}`,
    async complete(task, hint, report) {
      const model = args.cursorModel ?? hint?.model;
      const dir = scratch();
      try {
        const argv = ['-p', '--output-format', 'stream-json', '--trust', '--mode', 'ask', '--sandbox', 'enabled', '--workspace', dir];
        if (model) argv.push('--model', String(model));
        const r = await run(this.bin(), argv, task.prompt, dir);
        const { text, error, usage } = readCursorStream(r.stdout);
        if (usage) report(usage);
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
    label: (hint) => `claude:${args.claudeModel ?? own(args.claudeModel, hint)?.model ?? 'default'}`,
    async complete(task, hint, report) {
      const h = own(args.claudeModel, hint);
      const model = args.claudeModel ?? h?.model;
      const effort = args.claudeEffort ?? h?.effort;
      const dir = scratch();
      try {
        const argv = ['-p', '--output-format', 'json', '--max-turns', '1', '--no-session-persistence'];
        if (model) argv.push('--model', String(model));
        if (effort) argv.push('--effort', String(effort));
        const r = await run(this.bin(), argv, task.prompt, dir);
        let wrapper = null;
        try {
          wrapper = JSON.parse(r.stdout);
        } catch {
          // fall through
        }
        if (wrapper && typeof wrapper === 'object' && 'result' in wrapper) {
          const t = wrapper.usage ?? {};
          const usage = cachedUsage(t.input_tokens, t.cache_read_input_tokens, t.cache_creation_input_tokens, t.output_tokens, wrapper.total_cost_usd);
          if (usage) report(usage);
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
  embed: {
    bin: () => null,
    label: () => `embed:${embedModel || 'no endpoint'}`,
    complete() {
      throw new Error('embed slots take only embed batches');
    },
  },
  api: {
    bin: () => null,
    label: () => `api:${args.apiModel ?? process.env.KNODE_API_MODEL ?? '?'}`,
    async complete(task, hint, report) {
      const baseUrl = String(args.apiBaseUrl ?? process.env.KNODE_API_BASE_URL ?? process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
      const model = String(args.apiModel ?? process.env.KNODE_API_MODEL ?? '');
      const key = process.env[String(args.apiKeyEnv ?? 'OPENAI_API_KEY')] ?? '';
      if (!baseUrl || !model) throw new Error('api backend needs --api-base-url and --api-model (CLI not found)');
      // a summary is Markdown; only a task that wants JSON (every one from an older server) asks for JSON mode
      const json = task.json !== false;
      const request = JSON.stringify({ model, messages: task.messages, temperature: 0.2, max_tokens: task.maxTokens, ...(json ? { response_format: { type: 'json_object' } } : {}) });
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: request,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`chat request failed (${res.status}): ${body.slice(0, 300)}`);
      const parsed = JSON.parse(body);
      const usage = chatUsage(parsed);
      if (usage) report({ ...usage, bytesUp: Buffer.byteLength(request), bytesDown: Buffer.byteLength(body) });
      const content = parsed?.choices?.[0]?.message?.content;
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
const hasEmbedSlots = backends.some((b) => b.name === 'embed');
if (hasEmbedSlots && !ownEndpoint) {
  throw new Error('embed slots need an endpoint of this machine\'s own: --embed-base-url http://…/v1 --embed-model <model> (lent keys are not taken yet)');
}

/* ------------------------------ check mode ------------------------------ */

function onPath(bin) {
  if (!bin) return true;
  if (bin.includes('/')) return fs.existsSync(bin);
  return (process.env.PATH ?? '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, bin)));
}

if (args.check) {
  const { data } = await call('GET', `${server}/remote/v1/whoami`);
  log(`token ${data.name} (${data.id}): scopes ${data.scopes?.join(', ')}${data.kinds ? ` (work: ${data.kinds.join(', ')})` : ''}; workspaces ${data.workspaces?.join(', ')}`);
  await readWorkConfig();
  log(`${workspace}: ${describeKinds()}`);
  if (work) {
    const { data: status } = await call('GET', `${base}/work/status`);
    const extract = status.kinds?.extract;
    const summaries = status.kinds?.summarize;
    if (extract) log(`extraction: ${extract.queued} documents queued, ${extract.leases?.length ?? 0} segments out`);
    if (summaries) log(`summaries: ${summaries.due} documents due at the last look, ${summaries.leases?.length ?? 0} out`);
    const judge = status.kinds?.judge;
    if (judge) log(`judge calls: ${judge.waiting} waiting on a review, ${judge.leases?.length ?? 0} out`);
    const translations = status.kinds?.translate;
    if (translations?.enabled) log(`translations into ${translations.primary}: ${translations.due} due at the last look, ${translations.leases?.length ?? 0} segments out`);
    const vectors = status.kinds?.embed;
    if (vectors?.mode === 'deferred') log(`embedding: ${vectors.backlog ?? '?'} chunks without a vector, ${vectors.leases?.length ?? 0} batches out`);
    log(`${status.workers?.length ?? 0} workers seen`);
    const emb = work.embedding;
    if (hasEmbedSlots) {
      if (!emb) log('embed: not offered to this token here (it needs the "embed" scope, and the workspace ingest.embedding "deferred")');
      else {
        log(`embed: vectors as ${emb.vectorModel} (${emb.dimensions} dimensions, batches of ${emb.batchSize}); own endpoints ${emb.ownEndpoints ? 'taken' : 'not taken for this identity'}`);
        if (emb.ownEndpoints) await calibrate();
      }
    }
  } else {
    const { data: status } = await call('GET', `${base}/labeling/status`);
    log(`${workspace}: ${status.queued} documents queued, ${status.leases?.length ?? 0} segments out, ${status.workers?.length ?? 0} workers seen`);
  }
  for (const b of backends) {
    if (b.name === 'embed') {
      log(`backend embed × ${b.slots}: ${ownEndpoint.baseUrl} (${ownEndpoint.model})${calibration ? ' — calibrated' : embedNote ? ` — refused: ${embedNote}` : ''}`);
      continue;
    }
    const runs = kindsNow().map((kind) => `${kind} on ${b.impl.label(hintFor(kind, b.name))}`);
    log(`backend ${b.name} × ${b.slots}: ${onPath(b.impl.bin()) ? 'installed' : 'NOT FOUND on PATH'} (${runs.join(', ') || b.impl.label(null)})`);
  }
  process.exit(0);
}

/* -------------------------------- slots --------------------------------- */

let stopping = false;
const held = new Map(); // lease id → { identity, route }, for release on shutdown
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

/** A task for the log: the document (and part), and what is asked of it. */
function describeTask(task) {
  const doc = task.document;
  const label = task.label ?? (doc ? `${doc.path}${doc.parts > 1 ? ` [${doc.part}/${doc.parts}]` : ''}` : task.id);
  if (task.kind === 'translate') return `translation of ${label}`;
  return task.kind === 'summarize' ? `summary of ${label}` : task.kind === 'judge' ? `judge call on ${label}` : label;
}

async function slot(backend, n) {
  const identity = { worker: `${workerName}/${backend.name}#${n}`, backend: backend.impl.label(null) };
  let idleRounds = 0;
  while (!stopping) {
    const pause = backend.health.pausedUntil - Date.now();
    if (pause > 0) {
      await sleep(Math.min(pause, 15_000));
      continue;
    }
    if (reading) await reading;
    // work/* on a server that has it; extraction over labeling/* on one from before
    const route = work ? 'work' : 'labeling';
    const kinds = kindsNow();
    let task;
    let leaseSeconds = 900;
    try {
      if (kinds.length) {
        const { data } = await call('POST', `${base}/${route}/lease`, route === 'work' ? { ...identity, kinds, max: 1 } : { ...identity, max: 1 });
        task = data.tasks?.[0];
        leaseSeconds = data.leaseSeconds ?? leaseSeconds;
        if (work && data.configVersion && data.configVersion !== work.version) void rereadWorkConfig();
      }
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
    held.set(task.id, { identity, route });
    const renew = setInterval(() => {
      call('POST', `${base}/${route}/renew`, { ...identity, ids: [task.id] }).catch((err) => log(`${identity.worker}: renew failed: ${err.message}`));
    }, Math.max(10_000, (leaseSeconds * 1000) / 3));
    const started = Date.now();
    const where = describeTask(task);
    const hint = hintFor(task.kind, backend.name);
    let outcome;
    let usage = null;
    const report = (u) => { usage = u; };
    try {
      const text = await backend.impl.complete(task, hint, report);
      outcome = { ok: true, text, model: backend.impl.label(hint) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcome = { ok: false, error: message, kind: classify(message), model: backend.impl.label(hint) };
    } finally {
      clearInterval(renew);
    }
    if (usage) outcome.usage = usage;
    if (stopping && !outcome.ok) break; // killed on shutdown: released below
    backend.health.calls++;
    try {
      const { data } = await call('POST', `${base}/${route}/complete`, { ...identity, id: task.id, ...outcome });
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

/** An embed slot: lease a batch, embed it on the own endpoint, hand back the raw vectors. */
async function embedSlot(backend, n) {
  const identity = { worker: `${workerName}/embed#${n}`, backend: backend.impl.label() };
  let idleRounds = 0;
  while (!stopping) {
    const pause = Math.max(backend.health.pausedUntil, embedParkedUntil) - Date.now();
    if (pause > 0) {
      if (args.once && embedParkedUntil > Date.now()) break;
      await sleep(Math.min(pause, 15_000));
      continue;
    }
    if (reading) await reading;
    if (!work?.kinds?.embed || !work.embedding) {
      if (args.once && ++idleRounds >= 2) break;
      await sleep(idleMs * (0.75 + Math.random() * 0.5));
      continue;
    }
    if (!calibration) {
      calibrating ??= calibrate().catch((err) => {
        log(`embed: calibration failed: ${err.message}`);
        embedParkedUntil = Date.now() + 60_000;
        return false;
      }).finally(() => (calibrating = null));
      if (!(await calibrating)) continue;
    }
    let task;
    let leaseSeconds = 120;
    try {
      const { data } = await call('POST', `${base}/work/lease`, { ...identity, kinds: ['embed'], max: 1, calibration });
      if (data.configVersion && data.configVersion !== work.version) void rereadWorkConfig();
      if (data.embed?.calibrate) {
        log(`embed: ${data.embed.reason}${data.embed.parkedUntil ? ` (until ${data.embed.parkedUntil})` : ''}`);
        calibration = null;
        // parked: wait it out; otherwise calibrate again, a moment later (a server that restarted forgot the calibration)
        embedParkedUntil = data.embed.parkedUntil ? Math.max(Date.now() + 60_000, Date.parse(data.embed.parkedUntil) || 0) : Date.now() + 5_000;
        if (args.once && ++idleRounds >= 2) break;
        continue;
      }
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
    held.set(task.id, { identity, route: 'work' });
    const renew = setInterval(() => {
      call('POST', `${base}/work/renew`, { ...identity, ids: [task.id] }).catch((err) => log(`${identity.worker}: renew failed: ${err.message}`));
    }, Math.max(10_000, (leaseSeconds * 1000) / 3));
    const started = Date.now();
    let outcome;
    try {
      const made = await embedRequest(ownEndpoint, task.inputs);
      outcome = {
        ok: true, text: '', model: ownEndpoint.model, ...(made.endpointModel ? { endpointModel: made.endpointModel } : {}), ...encodeVectors(made.vectors),
        ...(made.tokens ? { usage: { inputTokens: made.tokens, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 } } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err?.http?.status;
      const kind = status === 401 || status === 403 ? 'fatal' : status === 429 || status >= 500 ? 'transient' : classify(message);
      outcome = { ok: false, error: message, kind, model: ownEndpoint.model };
    } finally {
      clearInterval(renew);
    }
    if (stopping && !outcome.ok) break;
    backend.health.calls++;
    try {
      const { data } = await call('POST', `${base}/work/complete`, { ...identity, id: task.id, ...outcome });
      held.delete(task.id);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (!data.accepted) {
        log(`${identity.worker}: ${task.label} not taken back: ${data.reason}`);
        if (/parked/.test(data.reason ?? '')) calibration = null;
      } else if (outcome.ok) log(`${identity.worker}: ${task.label} embedded in ${secs}s${data.vectorsWritten !== undefined ? ` — ${data.vectorsWritten} vectors written` : ''}`);
      else log(`${identity.worker}: ${task.label} failed (${outcome.kind}) in ${secs}s: ${outcome.error.slice(0, 200)}`);
    } catch (err) {
      log(`${identity.worker}: could not hand back ${task.label}: ${err.message}`);
    }
    if (outcome.ok) {
      backend.health.ok++;
      Object.assign(backend.health, { transientStreak: 0, modelStreak: 0, fatalStreak: 0 });
    } else {
      backend.health.failed++;
      const ms = rest(backend.health, outcome.kind);
      if (ms) log(`embed: resting ${Math.ceil(ms / 60_000)} min after a ${outcome.kind} failure`);
    }
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal}: stopping — handing back ${held.size} task(s)`);
  for (const child of children) child.kill('SIGTERM');
  for (const wake of sleepers) wake();
  const byWorker = new Map();
  for (const [id, { identity, route }] of held) {
    const key = `${route} ${identity.worker}`;
    const list = byWorker.get(key) ?? { identity, route, ids: [] };
    list.ids.push(id);
    byWorker.set(key, list);
  }
  await Promise.allSettled([...byWorker.values()].map(({ identity, route, ids }) => call('POST', `${base}/${route}/release`, { ...identity, ids })));
}
process.on('SIGINT', () => void shutdown('SIGINT').then(() => process.exit(130)));
process.on('SIGTERM', () => void shutdown('SIGTERM').then(() => process.exit(143)));

// a server that cannot be reached yet is waited for; a token or workspace it refuses is not
for (;;) {
  try {
    await readWorkConfig();
    break;
  } catch (err) {
    if (err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) throw err;
    log(`could not read the server configuration: ${err.message} — trying again in 30s`);
    await sleep(30_000);
    if (stopping) process.exit(0);
  }
}
log(`knode worker ${workerName} → ${server} ${workspace}: ${backends.map((b) => `${b.name} × ${b.slots}`).join(', ')} (session ${crypto.randomUUID().slice(0, 8)})`);
log(`${workspace}: ${describeKinds()}`);
const llmSlots = backends.some((b) => b.name !== 'embed');
if (llmSlots && kindsNow().length === 0) log('nothing to take here — check --kinds, the token\'s kinds and what the server offers');
if (hasEmbedSlots && !work?.kinds?.embed) log('embed: not offered to this token here — it needs the "embed" scope, and the workspace ingest.embedding "deferred"');
await Promise.all(backends.flatMap((b) => Array.from({ length: b.slots }, (_, i) => (b.name === 'embed' ? embedSlot(b, i + 1) : slot(b, i + 1)))));
log('no more work — exiting');
