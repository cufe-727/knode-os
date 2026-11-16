import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentTrace, runAgent } from '../src/eval/agent.js';
import { boundedOutputs, TOOL_OUTPUT_HEAD, toolOutput } from '../src/eval/trace.js';

/**
 * Tool outputs on agent answers (docs/design/33 §2, D7): every command and
 * MCP call keeps the first 2,000 characters of what it returned and the full
 * length, beside the command — read from Codex's `item.completed` events, for
 * a session run here and one a worker ran (whose events are the same lines,
 * long outputs cut to the head by the worker).
 */

const line = (e: unknown) => JSON.stringify(e);

function trace(lines: unknown[]): AgentTrace {
  const t = new AgentTrace({ cwd: os.tmpdir(), maxSteps: 25 });
  for (const l of lines) t.line(line(l));
  return t;
}

describe('the trace keeps what each command returned', () => {
  it('pairs a finished item with its start by id, cut to the head with the full length', () => {
    const long = 'x'.repeat(TOOL_OUTPUT_HEAD + 500);
    const t = trace([
      { type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'rg -n a .', status: 'in_progress' } },
      { type: 'item.started', item: { id: 'item_1', type: 'mcp_tool_call', server: 'knode', tool: 'search', arguments: { query: 'a' } } },
      { type: 'item.completed', item: { id: 'item_1', type: 'mcp_tool_call', server: 'knode', tool: 'search', status: 'completed', result: { content: [{ type: 'text', text: 'hit one' }, { type: 'text', text: 'hit two' }] }, error: null } },
      { type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'rg -n a .', aggregated_output: long, exit_code: 0, status: 'completed' } },
      { type: 'item.started', item: { id: 'item_2', type: 'command_execution', command: 'cat missing' } },
      { type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: 'cat missing', aggregated_output: 'cat: missing: No such file', exit_code: 1, status: 'failed' } },
      // a session stopped before this one finished: its entry has no output
      { type: 'item.started', item: { id: 'item_3', type: 'command_execution', command: 'ls' } },
      { type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: 'done' } },
    ]);
    expect(t.commands).toEqual(['rg -n a .', 'mcp:knode.search {"query":"a"}', 'cat missing', 'ls']);
    expect(t.outputs).toEqual([
      { text: 'x'.repeat(TOOL_OUTPUT_HEAD), chars: TOOL_OUTPUT_HEAD + 500 },
      { text: 'hit one\nhit two', chars: 15 },
      { text: 'cat: missing: No such file', chars: 26, failed: true },
      null,
    ]);
    expect(t.steps).toBe(4);
  });

  it('pairs events without ids by kind, oldest first; takes a worker\'s cut length; keeps an MCP error', () => {
    const t = trace([
      { type: 'item.started', item: { type: 'command_execution', command: 'a' } },
      { type: 'item.started', item: { type: 'mcp_tool_call', server: 'knode', tool: 'knode_claims', arguments: {} } },
      { type: 'item.started', item: { type: 'command_execution', command: 'b' } },
      { type: 'item.completed', item: { type: 'command_execution', command: 'a', aggregated_output: 'A'.repeat(2000), knode_output_chars: 90_000, exit_code: 0 } },
      { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'knode', tool: 'knode_claims', status: 'failed', result: null, error: { message: 'no such subject' } } },
      { type: 'item.completed', item: { type: 'command_execution', command: 'b', aggregated_output: 'B', exit_code: 0 } },
    ]);
    expect(t.outputs).toEqual([
      { text: 'A'.repeat(2000), chars: 90_000 },
      { text: 'no such subject', chars: 15, failed: true },
      { text: 'B', chars: 1 },
    ]);
  });

  it('bounds the outputs with the trace: the first 50 entries, each head cut', () => {
    const outs = Array.from({ length: 60 }, (_, i) => (i % 7 ? toolOutput('y'.repeat(3000)) : null));
    const b = boundedOutputs(outs);
    expect(b).toHaveLength(50);
    expect(b[0]).toBeNull();
    expect(b[1]).toEqual({ text: 'y'.repeat(2000), chars: 3000 });
  });

  it('a session run here records them (a stand-in Codex)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-outputs-'));
    try {
      const cwd = path.join(tmp, 'corpus');
      fs.mkdirSync(path.join(cwd, 'email'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'email', '2026-03-05.md'), '# 入职\n\n林晓将入职澜舟科技。\n');
      const cli = path.join(tmp, 'codex');
      fs.writeFileSync(cli, `#!/bin/sh\nexec node "${path.resolve('tests/helpers/fake-eval-cli.mjs')}" "$@"\n`, { mode: 0o755 });
      const r = await runAgent({ cwd, prompt: 'who is 林晓', sandbox: 'read-only', command: cli, timeoutMs: 20_000 });
      expect(r.error).toBeUndefined();
      expect(r.commands).toHaveLength(2);
      const rg = 'email/2026-03-05.md:3:林晓将入职澜舟科技\n';
      expect(r.outputs[0]).toEqual({ text: rg, chars: rg.length });
      expect(r.outputs[1]!.text.startsWith('# 入职')).toBe(true);
      expect(r.outputs[1]!.text).toHaveLength(2000);
      expect(r.outputs[1]!.chars).toBe('# 入职\n\n林晓将入职澜舟科技。\n'.length + 1 + 5000);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("the worker sends a session's long outputs cut to the head", () => {
  // the worker is one dependency-free file run on other machines: its line rewriter, taken out of it as it is
  const source = fs.readFileSync(path.resolve('worker/knode-worker.mjs'), 'utf8');
  const head = Number(/const EVAL_OUTPUT_HEAD = (\d+);/.exec(source)![1]);
  const body = /function cutEvalEvent\(line\) \{[\s\S]*?\n\}\n/.exec(source)![0];
  const cutEvalEvent = new Function('EVAL_OUTPUT_HEAD', `${body}\nreturn cutEvalEvent;`)(head) as (l: string) => string;

  it('keeps the same head the run keeps', () => {
    expect(head).toBe(TOOL_OUTPUT_HEAD);
  });

  it('cuts a long command or MCP output, with its length, and leaves every other line as Codex wrote it', () => {
    const cmd = line({ type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'cat a', aggregated_output: 'z'.repeat(9000), exit_code: 0, status: 'completed' } });
    const cut = JSON.parse(cutEvalEvent(cmd));
    expect(cut.item).toEqual({ id: 'item_0', type: 'command_execution', command: 'cat a', aggregated_output: 'z'.repeat(2000), exit_code: 0, status: 'completed', knode_output_chars: 9000 });
    const mcp = line({ type: 'item.completed', item: { id: 'item_1', type: 'mcp_tool_call', server: 'knode', tool: 'search', result: { content: [{ type: 'text', text: 'p'.repeat(1500) }, { type: 'text', text: 'q'.repeat(1500) }] }, status: 'completed' } });
    const m = JSON.parse(cutEvalEvent(mcp));
    expect(m.item.result.content).toEqual([{ type: 'text', text: `${'p'.repeat(1500)}\n${'q'.repeat(499)}` }]);
    expect(m.item.knode_output_chars).toBe(3001);
    // what the run reads from the cut line is what it would have kept of the whole one
    const fromCut = trace([{ type: 'item.started', item: { id: 'item_1', type: 'mcp_tool_call', server: 'knode', tool: 'search', arguments: {} } }]);
    fromCut.line(cutEvalEvent(mcp));
    const fromWhole = trace([{ type: 'item.started', item: { id: 'item_1', type: 'mcp_tool_call', server: 'knode', tool: 'search', arguments: {} } }]);
    fromWhole.line(mcp);
    expect(fromCut.outputs).toEqual(fromWhole.outputs);
    for (const l of [
      line({ type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: 'ls', aggregated_output: 'short', exit_code: 0 } }),
      line({ type: 'item.started', item: { id: 'item_3', type: 'command_execution', command: 'x'.repeat(5000) } }),
      line({ type: 'turn.completed', usage: { input_tokens: 1 } }),
      'not json',
    ]) expect(cutEvalEvent(l)).toBe(l);
  });
});
