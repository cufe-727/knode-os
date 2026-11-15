import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LlmClient } from '../src/llm/client.js';

/**
 * A text completion on the Claude CLI runs with no tools and no MCP servers:
 * with tools on offer the model now and then spends its one turn calling one,
 * and the call fails on "Reached maximum number of turns (1)".
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-claude-args-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A stand-in `claude` that records each call's arguments (one JSON array a line) and answers with a result wrapper. */
function fakeClaude(name: string, opts: { rejects?: string } = {}): { bin: string; calls: () => string[][] } {
  const log = path.join(tmp, `${name}.calls`);
  const bin = path.join(tmp, name);
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + '\\n');
const rejects = ${JSON.stringify(opts.rejects ?? '')};
if (rejects && argv.includes(rejects)) {
  process.stderr.write("error: unknown option '" + rejects + "'\\n");
  process.exit(1);
}
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'fine' }) + '\\n');
});
`);
  fs.chmodSync(bin, 0o755);
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]) : []) };
}

const client = (bin: string) => new LlmClient({ provider: 'claude-cli', baseUrl: '', apiKey: '', model: 'claude-sonnet-5-5', cliPath: bin, cliTimeoutMs: 20_000 });

describe('a text completion on the Claude CLI', () => {
  it('runs with no built-in tools and no MCP servers, in one turn', async () => {
    const claude = fakeClaude('claude-new');
    expect(await client(claude.bin).complete([{ role: 'user', content: 'grade this' }])).toBe('fine');
    const [argv] = claude.calls();
    expect(argv[argv.indexOf('--max-turns') + 1]).toBe('1');
    expect(argv[argv.indexOf('--tools') + 1]).toBe('');
    expect(argv).toContain('--strict-mcp-config');
  });

  it('runs a CLI too old to know those flags without them, and does not offer them to it again', async () => {
    const claude = fakeClaude('claude-old', { rejects: '--tools' });
    const llm = client(claude.bin);
    expect(await llm.complete([{ role: 'user', content: 'grade this' }])).toBe('fine');
    expect(await llm.complete([{ role: 'user', content: 'and this' }])).toBe('fine');
    const calls = claude.calls();
    // refused once, then asked again without the flags; the second completion goes straight without them
    expect(calls.map((argv) => argv.includes('--tools'))).toEqual([true, false, false]);
    expect(calls[1]).not.toContain('--strict-mcp-config');
  });
});
