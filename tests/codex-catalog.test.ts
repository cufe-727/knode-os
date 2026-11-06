import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { LlmConfig } from '../src/config.js';
import { readCodexAccount } from '../src/estimate/codex.js';
import { agentArgs, runAgent } from '../src/eval/agent.js';
import { CodexBackend } from '../src/eval/shim.js';
import { codexExecArgs, completeViaCli, runProcess } from '../src/llm/cli.js';
import { ANY_MODEL, catalogHoursFromEnv, CodexCatalog, configuredCodexModel, exitFailure, modelFromCodexConfig, withCodexCatalog } from '../src/llm/codex-catalog.js';
import type { NativeAgentSpec } from '../src/research/profile.js';
import { codexStartFailure, launchSession, type SessionInput } from '../src/research/launch.js';

/**
 * Codex calls read Codex's model catalog from a local copy instead of
 * downloading it on every start (src/llm/codex-catalog.ts), and turn ChatGPT's
 * apps off; research sessions, which keep the person's config, turn plugins,
 * apps and analytics off too. A fake codex stands in: it answers --version,
 * and a run without `-c model_catalog_json` "downloads" the catalog by
 * rewriting $CODEX_HOME/models_cache.json, as Codex does. No model, no network.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-codex-catalog-'));
// the account read remembers what it read: not in the real ~/.knode-os
process.env.KNODE_CODEX_LIMITS_FILE = path.join(root, 'codex-limits.json');
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const MODELS = [{ slug: 'm', model_messages: 'instructions' }, { slug: 'helper' }];
const HOUR = 3_600_000;
const OFF = '-c features.plugins=false -c features.apps=false -c analytics.enabled=false';

const FAKE = (version: string) => `#!${process.execPath}
// a fake codex: --version, exec and app-server, as far as knode's catalog copy needs them
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  console.log('codex-cli ${version}');
  process.exit(0);
}
if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(argv) + '\\n');
const flag = argv.find((a) => a.startsWith('model_catalog_json='));
if (flag) {
  const file = JSON.parse(flag.slice('model_catalog_json='.length));
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    process.stderr.write('Error: No such file or directory (os error 2)\\n');
    process.exit(1);
  }
  let models;
  try {
    models = JSON.parse(text).models;
  } catch {}
  if (!Array.isArray(models)) {
    process.stderr.write('Error: failed to parse model_catalog_json path \`' + file + '\` as JSON: missing field \`models\` at line 1 column 2\\n');
    process.exit(1);
  }
} else if (!process.env.FAKE_CODEX_NO_DOWNLOAD) {
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'models_cache.json'), JSON.stringify({
    fetched_at: new Date().toISOString(), etag: 'W/"e"', client_version: process.env.FAKE_CODEX_CACHE_VERSION || '${version}', identity: 'i',
    models: JSON.parse(process.env.FAKE_CODEX_MODELS || '[]'),
  }));
}
const queue = process.env.FAKE_CODEX_FAILURES;
if (queue && fs.existsSync(queue)) {
  const failures = JSON.parse(fs.readFileSync(queue, 'utf8'));
  if (failures.length) {
    const failure = failures.shift();
    fs.writeFileSync(queue, JSON.stringify(failures));
    process.stderr.write(failure.stderr + '\\n');
    process.exit(failure.code);
  }
}
if (argv[0] === 'app-server') {
  require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const m = JSON.parse(line);
    if (m.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));
    if (m.id === 2) console.log(JSON.stringify({ id: 2, result: { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1790000000 }, planType: 'pro' } } }));
    if (m.id === 3) console.log(JSON.stringify({ id: 3, result: { dailyUsageBuckets: [] } }));
  });
} else {
  process.stdin.resume();
  process.stdin.on('end', () => {
    setTimeout(() => {
      // a session that ran past the ten minutes its cache counts as fresh
      const cache = path.join(process.env.CODEX_HOME, 'models_cache.json');
      if (process.env.FAKE_CODEX_AGE_CACHE && fs.existsSync(cache)) {
        const hourAgo = new Date(Date.now() - 3600000);
        fs.utimesSync(cache, hourAgo, hourAgo);
      }
      fs.writeFileSync(argv[argv.indexOf('--output-last-message') + 1], 'answer');
      console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } }));
    }, Number(process.env.FAKE_CODEX_SESSION_MS || 0));
  });
}
`;

let fakes = 0;

class FakeCodex {
  readonly dir: string;
  readonly binary: string;
  readonly home: string;
  readonly catalogDir: string;
  readonly log: string;
  readonly failures: string;

  constructor() {
    this.dir = path.join(root, `fake-${++fakes}`);
    this.binary = path.join(this.dir, 'bin', 'codex');
    this.home = path.join(this.dir, 'codex-home');
    this.catalogDir = path.join(this.dir, 'knode', 'codex-catalog');
    this.log = path.join(this.dir, 'calls.jsonl');
    this.failures = path.join(this.dir, 'failures.json');
    fs.mkdirSync(path.dirname(this.binary), { recursive: true });
    fs.mkdirSync(this.home, { recursive: true });
    this.setVersion('0.166.0');
    Object.assign(process.env, {
      CODEX_HOME: this.home,
      KNODE_CODEX_CATALOG_DIR: this.catalogDir,
      KNODE_CODEX_CATALOG_HOURS: '24',
      FAKE_CODEX_LOG: this.log,
      FAKE_CODEX_MODELS: JSON.stringify(MODELS),
      FAKE_CODEX_FAILURES: this.failures,
    });
  }

  /** A Codex update: another binary (size or mtime), another version. */
  setVersion(version: string): void {
    const before = fs.existsSync(this.binary) ? fs.statSync(this.binary).mtimeMs : Date.now() - 60_000;
    fs.writeFileSync(this.binary, FAKE(version), { mode: 0o755 });
    const after = new Date(before + 1000);
    fs.utimesSync(this.binary, after, after);
  }

  calls(): string[][] {
    return fs.existsSync(this.log) ? fs.readFileSync(this.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]) : [];
  }

  /** The copy a call pinned, or null when it downloaded the catalog. */
  static pinned(argv: string[]): string | null {
    const flag = argv.find((a) => a.startsWith('model_catalog_json='));
    return flag ? (JSON.parse(flag.slice('model_catalog_json='.length)) as string) : null;
  }

  pins(): (string | null)[] {
    return this.calls().map((argv) => FakeCodex.pinned(argv));
  }

  saved(): string[] {
    return fs.existsSync(this.catalogDir) ? fs.readdirSync(this.catalogDir).filter((n) => n.startsWith('codex-models-')).sort().map((n) => path.join(this.catalogDir, n)) : [];
  }

  fail(...failures: { code: number; stderr: string }[]): void {
    fs.writeFileSync(this.failures, JSON.stringify(failures));
  }

  /** Codex's cache as Codex itself would have left it, `ageMs` ago. */
  writeCache(text: string, ageMs = 0): void {
    const file = path.join(this.home, 'models_cache.json');
    fs.writeFileSync(file, text);
    const at = new Date(Date.now() - ageMs);
    fs.utimesSync(file, at, at);
  }

  config(model = 'm'): LlmConfig {
    return { provider: 'codex-cli', baseUrl: '', apiKey: '', model, cliPath: this.binary, effort: 'default', speed: 'default', cliTimeoutMs: 20_000 } as LlmConfig;
  }

  ask(model = 'm'): Promise<string> {
    return completeViaCli(this.config(model), [{ role: 'user', content: 'say ok' }]);
  }
}

const saved = { env: { ...process.env } };
let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  saved.env = { ...process.env };
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  for (const key of Object.keys(process.env)) if (!(key in saved.env)) delete process.env[key];
  Object.assign(process.env, saved.env);
});

const age = (file: string, ms: number) => {
  const at = new Date(Date.now() - ms);
  fs.utimesSync(file, at, at);
};

describe('the Codex model catalog copy', () => {
  it('the first call downloads the catalog and later calls read the copy', async () => {
    const codex = new FakeCodex();
    expect(await codex.ask()).toBe('answer');
    expect(codex.pins()).toEqual([null]);
    const [copy] = codex.saved();
    expect(codex.saved()).toHaveLength(1);
    // every model, the cache's own fields left out
    expect(JSON.parse(fs.readFileSync(copy, 'utf8'))).toEqual({ models: MODELS });
    expect(copy.startsWith(codex.catalogDir + path.sep)).toBe(true);
    expect(await codex.ask()).toBe('answer');
    expect(await codex.ask()).toBe('answer');
    expect(codex.pins()).toEqual([null, copy, copy]);
    const flags = codex.calls()[1].join(' ');
    expect(flags).toContain(OFF);
    expect(flags).toContain(`-c model_catalog_json="${copy}"`);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/codex model catalog saved for 24 h: 2 models for m, codex 0\.166\.0/);
  });

  it('renews a copy after its hours, starts over after a Codex update, and keeps one per model', async () => {
    const codex = new FakeCodex();
    await codex.ask();
    const [copy] = codex.saved();
    age(copy, 25 * HOUR);
    await codex.ask(); // too old: downloads again and renews the copy in place
    expect(codex.pins()).toEqual([null, null]);
    expect(codex.saved()).toEqual([copy]);
    expect(Date.now() - fs.statSync(copy).mtimeMs).toBeLessThan(60_000);
    await codex.ask();
    expect(codex.pins()[2]).toBe(copy);

    await codex.ask('helper'); // another model: a copy of its own
    await codex.ask('helper');
    const helper = codex.pins()[4];
    expect(codex.pins()[3]).toBeNull();
    expect(helper).not.toBeNull();
    expect(helper).not.toBe(copy);
    await codex.ask();
    expect(codex.pins()[5]).toBe(copy);

    codex.setVersion('0.167.0'); // a Codex update: another binary, another copy
    await codex.ask();
    expect(codex.pins()[6]).toBeNull();
    const renewed = codex.saved().find((f) => f !== copy && f !== helper)!;
    expect(renewed).toBeDefined();
    await codex.ask();
    expect(codex.pins()[7]).toBe(renewed);
    // the old binary's copies are never pinned again, and go once well past their lifetime
    age(copy, 49 * HOUR);
    age(helper!, 47 * HOUR);
    codex.setVersion('0.168.0');
    await codex.ask();
    expect(codex.saved()).not.toContain(copy);
    expect(codex.saved()).toContain(helper);
  });

  it.each(['stale', 'other version', 'model missing', 'not json'])('does not copy a cache that is %s', async (spoil) => {
    const codex = new FakeCodex();
    if (spoil === 'other version') process.env.FAKE_CODEX_CACHE_VERSION = '0.165.0'; // e.g. the desktop app's own Codex
    if (spoil === 'model missing') process.env.FAKE_CODEX_MODELS = JSON.stringify([{ slug: 'helper' }]);
    if (spoil === 'stale' || spoil === 'not json') {
      process.env.FAKE_CODEX_NO_DOWNLOAD = '1'; // Codex used a cache it did not rewrite
      if (spoil === 'stale') codex.writeCache(JSON.stringify({ client_version: '0.166.0', models: MODELS }), HOUR);
      else codex.writeCache('{');
    }
    await codex.ask();
    await codex.ask();
    expect(codex.saved()).toEqual([]);
    expect(codex.pins()).toEqual([null, null]);
  });

  it('drops a copy Codex cannot read and repeats the call once without it', async () => {
    const codex = new FakeCodex();
    await codex.ask();
    const [copy] = codex.saved();
    fs.writeFileSync(copy, '{}');
    expect(await codex.ask()).toBe('answer');
    expect(codex.pins()).toEqual([null, copy, null]);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/could not read the saved model catalog, calling without it: .*failed to parse model_catalog_json/);
    expect(JSON.parse(fs.readFileSync(copy, 'utf8'))).toEqual({ models: MODELS }); // the repeat saved a new copy

    // gone between the check and the call: Codex says only "No such file or directory"
    const catalog = new CodexCatalog({ log: () => {} });
    const gone = path.join(codex.catalogDir, 'codex-models-gone.json');
    vi.spyOn(catalog, 'pinned').mockReturnValue(gone);
    const outFile = path.join(codex.dir, 'out.txt');
    const r = await withCodexCatalog(codex.binary, 'm', (file) => runProcess(codex.binary, codexExecArgs({ outFile, cwd: codex.dir, model: 'm', catalog: file }), 'say ok', 20_000), exitFailure, catalog);
    expect(r.code).toBe(0);
    expect(codex.pins().slice(3)).toEqual([gone, null]);
  });

  it('keeps the copy through any other failure, and does not repeat the call', async () => {
    const codex = new FakeCodex();
    await codex.ask();
    const [copy] = codex.saved();
    codex.fail({ code: 1, stderr: 'stream disconnected before completion: error sending request' });
    await expect(codex.ask()).rejects.toThrow(/stream disconnected/);
    expect(codex.pins()).toEqual([null, copy]);
    expect(codex.saved()).toEqual([copy]);
    await codex.ask();
    expect(codex.pins()[2]).toBe(copy);
  });

  it('downloads every time with 0 hours, and pins nothing for a call that names no model', async () => {
    const codex = new FakeCodex();
    process.env.KNODE_CODEX_CATALOG_HOURS = '0';
    await codex.ask();
    await codex.ask();
    expect(codex.saved()).toEqual([]);
    process.env.KNODE_CODEX_CATALOG_HOURS = '24';
    await codex.ask('');
    await codex.ask('');
    expect(codex.saved()).toEqual([]);
    expect(codex.pins()).toEqual([null, null, null, null]);
    expect(codex.calls().every((argv) => argv.join(' ').includes(OFF))).toBe(true);

    expect(catalogHoursFromEnv(undefined)).toBe(24);
    expect(catalogHoursFromEnv('')).toBe(24);
    expect(catalogHoursFromEnv('0')).toBe(0);
    expect(catalogHoursFromEnv('6.5')).toBe(6.5);
    expect(catalogHoursFromEnv('-1')).toBe(24);
    expect(catalogHoursFromEnv('off')).toBe(24);
  });

  it('writes whole copies when many calls refresh at once', async () => {
    const codex = new FakeCodex();
    const catalog = new CodexCatalog({ log: () => {} });
    codex.writeCache(JSON.stringify({ client_version: '0.166.0', models: MODELS }));
    await Promise.all(Array.from({ length: 12 }, () => catalog.refresh(codex.binary, 'm')));
    const files = fs.readdirSync(codex.catalogDir);
    expect(files).toHaveLength(1); // no temp file left behind
    expect(JSON.parse(fs.readFileSync(path.join(codex.catalogDir, files[0]), 'utf8'))).toEqual({ models: MODELS });
    expect(catalog.pinned(codex.binary, 'm')).toBe(path.join(codex.catalogDir, files[0]));
  });
});

describe('every knode Codex call site', () => {
  it('the eval shim pins the copy, with the reply schema still before the prompt', async () => {
    const codex = new FakeCodex();
    const backend = new CodexBackend({ model: 'm', command: codex.binary, timeoutMs: 20_000 });
    const request = { messages: [{ role: 'user' as const, content: 'say ok' }], json: true, schema: { type: 'object' } };
    expect((await backend.complete(request)).text).toBe('answer');
    expect((await backend.complete(request)).text).toBe('answer');
    const [first, second] = codex.calls();
    const [copy] = codex.saved();
    expect([FakeCodex.pinned(first), FakeCodex.pinned(second)]).toEqual([null, copy]);
    expect(second.join(' ')).toContain(OFF);
    expect(second.slice(-3, -1)[0]).toBe('--output-schema');
    expect(second[second.length - 1]).toBe('-');
  });

  it('the eval agent runner pins the copy and turns apps off', async () => {
    const codex = new FakeCodex();
    const cwd = fs.mkdtempSync(path.join(codex.dir, 'kb-'));
    const run = () => runAgent({ cwd, prompt: 'say ok', sandbox: 'read-only', model: 'm', command: codex.binary, timeoutMs: 20_000 });
    expect((await run()).text).toBe('answer');
    expect((await run()).text).toBe('answer');
    const [copy] = codex.saved();
    expect(codex.pins()).toEqual([null, copy]);
    expect(codex.calls()[1].join(' ')).toContain(OFF);
    expect(agentArgs({ cwd, prompt: '', sandbox: 'read-only' }, '/tmp/out.txt').join(' ')).toContain(OFF);

    // a copy Codex cannot read: the session runs once more without it, from nothing
    fs.writeFileSync(copy, '{}');
    const third = await run();
    expect(third).toMatchObject({ text: 'answer', commands: [], toolCalls: 0, capped: false });
    expect(codex.pins().slice(2)).toEqual([copy, null]);
  });

  it('the account read pins any copy of its binary, and makes one of its own', async () => {
    const codex = new FakeCodex();
    const read = () => readCodexAccount(codex.binary, { fresh: true, timeoutMs: 20_000 });
    expect((await read()).windows).toEqual([{ minutes: 300, usedPercent: 12, resetsAt: new Date(1790000000 * 1000).toISOString() }]);
    // no model named: any list of this binary's version will do
    const [own] = codex.saved();
    expect(own).toBeDefined();
    await read();
    expect(codex.pins()).toEqual([null, own]);
    const [, second] = codex.calls();
    expect(second.slice(0, 7).join(' ')).toBe(`app-server ${OFF}`);

    // an exec call's copy serves too
    const catalog = new CodexCatalog({ log: () => {} });
    fs.rmSync(own);
    await codex.ask();
    const [exec] = codex.saved();
    expect(catalog.pinned(codex.binary, ANY_MODEL)).toBe(exec);
    await read();
    expect(codex.pins()[3]).toBe(exec);

    // a copy it cannot read: dropped, and read once more without it
    fs.writeFileSync(exec, 'not json');
    expect((await read()).plan).toBe('pro');
    expect(codex.pins().slice(4)).toEqual([exec, null]);
  });
});

describe('research sessions', () => {
  let jobs = 0;
  /** One research session on the fake codex, as the study, pipeline and chat runners launch them. */
  const session = (codex: FakeCodex, over: Partial<SessionInput> = {}) => launchSession({
    agent: { kind: 'cli', provider: 'codex-cli', cliPath: codex.binary, model: 'm' },
    maxTurns: 5,
    timeoutMs: 20_000,
    cwd: fs.mkdtempSync(path.join(codex.dir, 'run-')),
    prompt: 'say ok',
    mcp: { url: 'http://127.0.0.1:9/mcp', token: 'tok', headers: {} },
    readDirs: [],
    jobId: `r_catalog_${++jobs}`,
    outputPath: '',
    worksetId: 'w',
    tools: 'read',
    label: 'agent',
    ...over,
  });
  const subAgent = (model: string): NativeAgentSpec => ({ id: 'critic', title: 'critic', description: 'd', prompt: 'p', write: false, files: false, web: false, model, effort: 'default', speed: 'default' });

  it('keep the person\'s config, turn plugins, apps and analytics off, and pin the copy', async () => {
    const codex = new FakeCodex();
    expect(await session(codex)).toMatchObject({ text: 'answer', error: null, exitCode: 0 });
    expect(await session(codex)).toMatchObject({ text: 'answer', error: null });
    const [copy] = codex.saved();
    expect(codex.pins()).toEqual([null, copy]);
    for (const argv of codex.calls()) {
      const flags = argv.join(' ');
      expect(flags).toContain(OFF);
      // ~/.codex/config.toml still applies (its approval policy), and the session is kept
      expect(flags).not.toContain('--ignore-user-config');
      expect(flags).not.toContain('--ephemeral');
    }
    expect(codex.calls()[1].join(' ')).toContain(`-c model_catalog_json="${copy}"`);
  });

  it('a session that names no model pins the copy of the model config.toml names, and none when it names none', async () => {
    const codex = new FakeCodex();
    const config = path.join(codex.home, 'config.toml');
    fs.writeFileSync(config, 'approval_policy = "never"\nmodel = "helper"  # the person\'s own\n\n[features]\nmemories = true\n');
    expect(configuredCodexModel()).toBe('helper');
    await session(codex, { agent: { kind: 'cli', provider: 'codex-cli', cliPath: codex.binary, model: '' } });
    await session(codex, { agent: { kind: 'cli', provider: 'codex-cli', cliPath: codex.binary, model: '' } });
    const [helper] = codex.saved();
    expect(codex.pins()).toEqual([null, helper]);
    // the agent's own model goes first: a copy of its own
    await session(codex);
    expect(codex.pins()[2]).toBeNull();
    expect(codex.saved()).toHaveLength(2);

    // a profile's model wins over the top-level one
    fs.writeFileSync(config, 'profile = "deep"\nmodel = "helper"\n[profiles.deep]\nmodel = "m"\n');
    await session(codex, { agent: { kind: 'cli', provider: 'codex-cli', cliPath: codex.binary, model: '' } });
    const m = codex.saved().find((f) => f !== helper);
    expect(codex.pins()[3]).toBe(m);

    // no model anywhere: Codex runs a default of its own, so nothing is pinned or saved
    fs.writeFileSync(config, 'approval_policy = "never"\n');
    for (const f of codex.saved()) fs.rmSync(f);
    await session(codex, { agent: { kind: 'cli', provider: 'codex-cli', cliPath: codex.binary, model: '' } });
    await session(codex, { agent: { kind: 'cli', provider: 'codex-cli', cliPath: codex.binary, model: '' } });
    expect(codex.pins().slice(4)).toEqual([null, null]);
    expect(codex.saved()).toEqual([]);
  });

  it('reads the model out of config.toml the way Codex picks it', () => {
    expect(modelFromCodexConfig('model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\n')).toBe('gpt-6-astra');
    expect(modelFromCodexConfig("model = 'literal'")).toBe('literal');
    // only the top level: a table's `model` is somebody else's
    expect(modelFromCodexConfig('[mcp_servers.x]\nmodel = "not-this"\n')).toBeNull();
    expect(modelFromCodexConfig('[[skills]]\nmodel = "not-this"\n[tui]\nx = 1\n')).toBeNull();
    expect(modelFromCodexConfig('profile = "fast one"\nmodel = "base"\n[profiles."fast one"]\nmodel = "quick"\n')).toBe('quick');
    // a profile without a model of its own runs the top-level one
    expect(modelFromCodexConfig('profile = "p"\nmodel = "base"\n[profiles.p]\nmodel_reasoning_effort = "low"\n')).toBe('base');
    // a profile the file does not hold: cannot tell
    expect(modelFromCodexConfig('profile = "elsewhere"\nmodel = "base"\n')).toBeNull();
    expect(modelFromCodexConfig('')).toBeNull();
    expect(configuredCodexModel(path.join(root, 'no-such-codex-home'))).toBeNull();
  });

  it('copies the cache as soon as Codex has written it, for a session that outlives its freshness', async () => {
    // the session rewrites the cache as it starts, and has run past its ten minutes when it ends;
    // it lasts past the checks at 1 and 3 s
    Object.assign(process.env, { FAKE_CODEX_SESSION_MS: '3500', FAKE_CODEX_AGE_CACHE: '1' });
    const codex = new FakeCodex();
    await session(codex);
    const [copy] = codex.saved();
    expect(copy).toBeDefined();
    delete process.env.FAKE_CODEX_SESSION_MS;
    await session(codex);
    expect(codex.pins()).toEqual([null, copy]);

    // what a call that copies only at its end makes of the same session: nothing
    const late = new FakeCodex();
    const outFile = path.join(late.dir, 'out.txt');
    const r = await withCodexCatalog(late.binary, 'm', (file) => runProcess(late.binary, codexExecArgs({ outFile, cwd: late.dir, model: 'm', catalog: file }), 'say ok', 20_000), exitFailure);
    expect(r.code).toBe(0);
    expect(late.saved()).toEqual([]);
  });

  it('runs a session Codex refused at start once more without the copy, and never one that ran', async () => {
    const codex = new FakeCodex();
    await session(codex);
    const [copy] = codex.saved();
    fs.writeFileSync(copy, '{}');
    const repeated = await session(codex);
    expect(repeated).toMatchObject({ text: 'answer', error: null, exitCode: 0 });
    expect(codex.pins()).toEqual([null, copy, null]);
    expect(fs.readFileSync(repeated.transcriptPath, 'utf8')).toContain('turn.completed'); // the repeat's own transcript
    expect(JSON.parse(fs.readFileSync(copy, 'utf8'))).toEqual({ models: MODELS });

    // a session that started and then failed keeps its copy, though its transcript names the flag
    codex.fail({ code: 1, stderr: 'OpenAI Codex v0.166.0\n--------\nuser\nWhy does knode pass model_catalog_json?\nERROR: You\'ve hit your usage limit. Try again in 3 hours.' });
    const failed = await session(codex);
    expect(failed.error).toMatch(/usage limit/);
    expect(codex.pins().slice(3)).toEqual([copy]);
    expect(codex.saved()).toEqual([copy]);

    // a timeout is the session's own too, even with its copy gone meanwhile
    process.env.FAKE_CODEX_SESSION_MS = '5000';
    const removed = setTimeout(() => fs.rmSync(copy, { force: true }), 400);
    await expect(session(codex, { timeoutMs: 1000 })).rejects.toThrow(/timed out/);
    clearTimeout(removed);
    expect(codex.pins().slice(4)).toEqual([copy]);

    expect(codexStartFailure({ code: 1, stderr: 'Error: No such file or directory (os error 2)\n' })).toMatch(/os error 2/);
    expect(codexStartFailure({ code: 1, stderr: 'OpenAI Codex v0.166.0\n--------\nERROR: stream disconnected\n' })).toBeNull();
    expect(codexStartFailure({ code: 0, stderr: '' })).toBeNull();
  });

  it('pins no copy for sub-agents on a model the copy does not list', async () => {
    const codex = new FakeCodex();
    await session(codex);
    const [copy] = codex.saved();
    await session(codex, { agents: [subAgent('helper')] });
    await session(codex, { agents: [subAgent('newer-than-the-copy')] });
    await session(codex, { agents: [subAgent('')] });
    expect(codex.pins()).toEqual([null, copy, null, copy]);
  });
});

describe('the remote worker', () => {
  /** A knode server as far as the worker needs one: config, leases of the given tasks, completions. */
  async function fakeServer(tasks: number) {
    let leased = 0;
    const completed: Record<string, unknown>[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const url = req.url ?? '';
        const send = (data: unknown) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(data));
        };
        if (url.endsWith('/work/config')) return send({ version: 'v1', kinds: { extract: true }, leaseSeconds: 60, hints: {} });
        if (url.endsWith('/work/lease')) {
          if (leased >= tasks) return send({ tasks: [], leaseSeconds: 60, configVersion: 'v1' });
          leased++;
          return send({ tasks: [{ id: `t${leased}`, kind: 'extract', label: `doc-${leased}`, prompt: 'say ok' }], leaseSeconds: 60, configVersion: 'v1' });
        }
        if (url.endsWith('/work/complete')) {
          completed.push(JSON.parse(body) as Record<string, unknown>);
          return send({ accepted: true });
        }
        send({});
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, completed, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  async function runWorker(codex: FakeCodex, tasks: number) {
    const server = await fakeServer(tasks);
    try {
      const worker = spawn(process.execPath, [
        path.resolve('worker/knode-worker.mjs'), '--server', server.url, '--workspace', 'admin/finance', '--name', 'catalog-box',
        '--backends', 'codex:1', '--codex-bin', codex.binary, '--codex-model', 'm', '--once', '--idle-ms', '100',
      ], { env: { ...process.env, KNODE_TOKEN: 'knr_test' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      worker.stdout.on('data', (d) => (output += d));
      worker.stderr.on('data', (d) => (output += d));
      const code = await new Promise<number | null>((resolve) => worker.on('close', resolve));
      expect(code, output).toBe(0);
      return { output, completed: server.completed };
    } finally {
      await server.close();
    }
  }

  it('keeps its own copy: downloaded once, then pinned, dropped when Codex cannot read it', async () => {
    const codex = new FakeCodex();
    const first = await runWorker(codex, 2);
    expect(first.completed).toMatchObject([{ ok: true, text: 'answer' }, { ok: true, text: 'answer' }]);
    const [copy] = codex.saved();
    expect(codex.saved()).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(copy, 'utf8'))).toEqual({ models: MODELS });
    expect(codex.pins()).toEqual([null, copy]);
    expect(codex.calls()[1].join(' ')).toContain(OFF);
    expect(first.output).toContain('codex model catalog saved for 24 h: 2 models for m, codex 0.166.0');
    // the same file the server's own calls would pin: one copy per binary and model on a machine
    expect(new CodexCatalog({ log: () => {} }).pinned(codex.binary, 'm')).toBe(copy);

    fs.writeFileSync(copy, '{}');
    const second = await runWorker(codex, 1);
    expect(second.completed).toMatchObject([{ ok: true, text: 'answer' }]);
    expect(second.output).toContain('could not read the saved model catalog, calling without it');
    expect(codex.pins().slice(2)).toEqual([copy, null]);
    expect(JSON.parse(fs.readFileSync(copy, 'utf8'))).toEqual({ models: MODELS });
  });
});
