/**
 * What an agent session did, kept on its answer record (docs/design/23 §8):
 * the command lines and MCP tool calls `runAgent` saw, in order. A count of
 * tool calls cannot tell an agent that used knode's knowledge tools from one
 * that grepped through them, or a grep agent that read three files from one
 * that listed the tree twenty times; the trace can.
 *
 * Entries are what `runAgent` collects: a shell command line as Codex ran it
 * (often wrapped, `/bin/zsh -lc '…'`), or `mcp:<server>.<tool> <json args>`.
 */

/** Entries kept per answer: above the step cap (25) and what streams in while the session stops, so in practice all of them. */
export const TRACE_MAX_ENTRIES = 50;
/** Characters kept per entry: MCP arguments are already cut there; a long shell heredoc is cut the same way. */
export const TRACE_MAX_CHARS = 300;

/** The trace stored on an answer record: the first entries, each cut. The record's `toolCalls` keeps the full count. */
export function boundedTrace(commands: string[]): string[] {
  return commands.slice(0, TRACE_MAX_ENTRIES).map((c) => (c.length > TRACE_MAX_CHARS ? c.slice(0, TRACE_MAX_CHARS) : c));
}

/** Characters of a command's or tool call's output kept on the answer (docs/design/33 §2, D7). */
export const TOOL_OUTPUT_HEAD = 2000;

/**
 * What one trace entry returned: the first `TOOL_OUTPUT_HEAD` characters of
 * its output (a command's stdout and stderr as Codex aggregated them, an MCP
 * call's text content or its error) and the full length. `failed`: a
 * command that exited non-zero, a tool call that returned an error.
 */
export interface ToolOutput {
  text: string;
  chars: number;
  failed?: boolean;
}

/** A tool output as kept: its head and full length (`chars` when the text was already cut, by a worker). */
export function toolOutput(text: string, opts: { chars?: number; failed?: boolean } = {}): ToolOutput {
  const chars = Math.max(opts.chars ?? 0, text.length);
  return { text: text.length > TOOL_OUTPUT_HEAD ? text.slice(0, TOOL_OUTPUT_HEAD) : text, chars, ...(opts.failed ? { failed: true } : {}) };
}

/** The outputs stored beside a bounded trace: entry for entry (null where none came back), each head cut again. */
export function boundedOutputs(outputs: (ToolOutput | null)[]): (ToolOutput | null)[] {
  return outputs.slice(0, TRACE_MAX_ENTRIES).map((o) => (o ? toolOutput(o.text, { chars: o.chars, failed: o.failed }) : null));
}

/** Words of a shell string, quotes removed; an unclosed quote runs to the end (the entry may have been cut). */
function words(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let started = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") {
      const end = s.indexOf("'", i + 1);
      cur += end < 0 ? s.slice(i + 1) : s.slice(i + 1, end);
      started = true;
      i = end < 0 ? s.length : end;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length) j++;
        cur += s[j];
        j++;
      }
      started = true;
      i = j;
    } else if (ch === '\\' && i + 1 < s.length) {
      cur += s[++i];
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

/** A script cut at its unquoted `|`, `||`, `&&`, `;`, `&` and newlines, quotes kept. */
function segments(script: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < script.length) {
        cur += ch + script[++i];
        continue;
      }
      if (ch === quote) quote = null;
      cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (ch === '|' || ch === ';' || ch === '&' || ch === '\n') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
const base = (w: string) => w.slice(w.lastIndexOf('/') + 1);

/** The script a `sh -c` / `bash -lc` wrapper runs, or the command line itself. */
function unwrap(command: string): string {
  const w = words(command);
  if (w.length >= 3 && SHELLS.has(base(w[0])) && /^-[a-z]*c[a-z]*$/.test(w[1])) return w[2];
  return command;
}

/**
 * The tools one trace entry used: the knode (or other MCP) tool it called,
 * or each program in the command line — `rg -n x . | head` is `rg` and
 * `head`, a shell wrapper and leading `VAR=value`s skipped.
 */
export function toolsOf(entry: string): string[] {
  if (entry.startsWith('mcp:')) {
    const name = entry.slice(4).split(/\s/, 1)[0];
    const dot = name.indexOf('.');
    const tool = dot >= 0 ? name.slice(dot + 1) : name;
    return [tool || `mcp:${name}`];
  }
  const out: string[] = [];
  for (const seg of segments(unwrap(entry))) {
    const w = words(seg.replace(/^[({!\s]+/, ''));
    const prog = w.find((x) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x));
    // `(ls x || true)` cuts into `(ls x` and `true)`: the subshell's brackets are not part of a name
    const name = prog ? base(prog).replace(/[)}]+$/, '') : '';
    if (name) out.push(name);
  }
  return out;
}

export interface ToolUse {
  /** Answers of this system. */
  n: number;
  /** Answers that carry a trace (records written before traces were kept have none). */
  traced: number;
  /** Tool calls per traced answer (the record's full count, not the bounded trace). */
  calls: number;
  /** Uses of each program or MCP tool per traced answer, most used first. */
  perTool: Record<string, number>;
}

/** Tool use over a system's answers, averaged over those that carry a trace. */
export function toolUse(answers: { toolCalls: number; commands?: string[] }[]): ToolUse {
  const traced = answers.filter((a) => Array.isArray(a.commands));
  const counts = new Map<string, number>();
  for (const a of traced) for (const c of a.commands!) for (const t of toolsOf(c)) counts.set(t, (counts.get(t) ?? 0) + 1);
  const per = (x: number) => (traced.length ? x / traced.length : 0);
  return {
    n: answers.length,
    traced: traced.length,
    calls: per(traced.reduce((s, a) => s + a.toolCalls, 0)),
    perTool: Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t, c]) => [t, per(c)])),
  };
}
