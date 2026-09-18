import fs from 'node:fs';

/**
 * The transcript an executor leaves behind, in the shape claude's
 * `--output-format stream-json` produces. `parseActivity` (src/chat/runner.ts)
 * and the Chat tab's live activity view read this, and `chatActivity` re-reads
 * the file *while the session runs* — so every line is flushed as it happens
 * rather than buffered to the end.
 *
 * The built-in agent writes the same shape as the CLIs, which is why nothing
 * downstream has to know which executor produced a run.
 */
export class TranscriptWriter {
  private readonly fd: number;
  private closed = false;

  constructor(readonly path: string) {
    this.fd = fs.openSync(path, 'w');
  }

  private write(line: unknown): void {
    if (this.closed) return;
    fs.writeSync(this.fd, JSON.stringify(line) + '\n');
  }

  init(cwd: string, label: string): void {
    this.write({ type: 'system', subtype: 'init', cwd, label });
  }

  toolUse(id: string, name: string, input: unknown): void {
    this.write({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  }

  toolResult(id: string, isError: boolean): void {
    this.write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] } });
  }

  /** The final message. `costUsd` is null for executors that cannot price a run honestly. */
  result(input: { text: string; turns: number; isError: boolean }): void {
    this.write({
      type: 'result',
      subtype: input.isError ? 'error' : 'success',
      is_error: input.isError,
      result: input.text,
      num_turns: input.turns,
      total_cost_usd: null,
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    fs.closeSync(this.fd);
  }
}
