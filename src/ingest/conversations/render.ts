import os from 'node:os';
import { MAX_FILE_BYTES } from '../../constants.js';
import { AGENT_NAMES, Conversation, Exchange, isTemporaryDir, projectOf } from './transcript.js';

/**
 * A conversation as the Markdown knode-os keeps (docs/design/24 §2): one `##`
 * section per exchange — the prompt, the agent's replies, the person's
 * answers, a line naming the tools used and the files changed.
 *
 * **Stable bytes.** An exchange renders the same whenever it is rendered:
 * nothing in it depends on the time of rendering or on the exchanges after
 * it. A followed conversation that grows keeps every earlier section
 * byte-identical, so their chunks keep their ids and embeddings and their
 * extraction segments their cached results; only what is new is paid for.
 * The frontmatter (last activity, exchange count) changes, and is not chunked.
 *
 * **Secrets** are redacted before anything is written (D10).
 */

/** Part of the follow state: a change here renders every followed conversation again. */
export const RENDER_VERSION = 1;

/** Longest message kept whole; longer ones are clipped, saying how much was left out. */
export const MAX_MESSAGE_CHARS = 12_000;

export const PLATFORM: Record<Conversation['agent'], string> = { claude: 'claude-code', codex: 'codex' };

/* ------------------------------ redaction -------------------------------- */

const SECRET_PATTERNS: { re: RegExp; keep?: (m: string, ...groups: string[]) => string }[] = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { re: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  { re: /\bgithub_pat_[A-Za-z0-9_]{40,}/g },
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { re: /\bAKIA[0-9A-Z]{16}\b/g },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi, keep: (_m, prefix) => `${prefix}[redacted]` },
  // key = value: a name that says secret, and a value that looks like one (12+ characters, a digit among them)
  {
    re: /\b((?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?key|auth[_-]?token|token|password|passwd)["']?\s*[:=]\s*["']?)((?=[^\s"',;]*\d)[^\s"',;<>]{12,})/gi,
    keep: (_m, prefix) => `${prefix}[redacted]`,
  },
];

/** The text with credentials replaced by `[redacted]`, and how many were. */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const { re, keep } of SECRET_PATTERNS) {
    out = out.replace(re, (...args: unknown[]) => {
      count++;
      const groups = args.slice(1, -2).map((g) => (typeof g === 'string' ? g : ''));
      return keep ? keep(String(args[0]), ...groups) : '[redacted]';
    });
  }
  return { text: out, count };
}

/* ------------------------------ text shaping ----------------------------- */

/**
 * Headings inside a message moved two levels down, so a reply's own `##`
 * does not read as the next exchange; code blocks are left as written.
 */
function demoteHeadings(text: string): string {
  let fence: string | null = null;
  return text
    .split('\n')
    .map((line) => {
      const f = line.match(/^\s*(`{3,}|~{3,})/);
      if (f) {
        if (!fence) fence = f[1][0];
        else if (f[1][0] === fence) fence = null;
        return line;
      }
      if (fence) return line;
      const h = line.match(/^(#{1,6})(\s+.*)$/);
      return h ? `${'#'.repeat(Math.min(6, h[1].length + 2))}${h[2]}` : line;
    })
    .join('\n');
}

/** Clip a long message, closing a code block left open and saying how much was left out. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let head = text.slice(0, max);
  const cut = head.lastIndexOf('\n');
  if (cut > max * 0.8) head = head.slice(0, cut);
  const fences = (head.match(/^\s*```/gm) ?? []).length;
  if (fences % 2 === 1) head += '\n```';
  return `${head}\n\n_… ${(text.length - head.length).toLocaleString('en-US')} more characters not kept_`;
}

function quote(text: string): string {
  return text.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
}

/** A heading's gist: the prompt's first line of words, without Markdown marks. */
function gist(prompt: string): string {
  const line = prompt
    .split('\n')
    .map((l) => l.replace(/^[>#*\-\s]+/, '').replace(/[`*_[\]]/g, '').trim())
    .find((l) => l && !/^_?Attached:/.test(l)) ?? '';
  const flat = line.replace(/\s+/g, ' ');
  return flat.length > 60 ? `${flat.slice(0, 59).trimEnd()}…` : flat;
}

/** Local `YYYY-MM-DD HH:MM`: the time a person would say the exchange happened, on this machine's clock. */
export function localStamp(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A path under the home folder written with `~`, so the copy does not spell out whose machine it is. */
export function homeRelative(p: string): string {
  const home = os.homedir();
  return p === home ? '~' : p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p;
}

/** The app's own bookkeeping — task lists, tool loading, session cards — says nothing about the subject. */
const BOOKKEEPING_TOOL = /^(?:mcp__ccd_|ToolSearch$|TodoWrite$|Task(?:Create|Update|List|Get|Output|Stop)$|update_plan$|EnterPlanMode$|ExitPlanMode$|AskUserQuestion$)/;

/** `mcp__<server>__<tool>` read as `<server>/<tool>`. */
const toolName = (n: string) => n.replace(/^mcp__(.+?)__(.+)$/, '$1/$2');

/** A changed file as the person would name it: relative to the session's folder, else to home. */
function fileName(f: string, cwd: string | null): string {
  if (cwd && f.startsWith(`${cwd.replace(/\/+$/, '')}/`)) return f.slice(cwd.replace(/\/+$/, '').length + 1);
  return homeRelative(f);
}

function toolLine(e: Exchange, cwd: string | null): string | null {
  const names = Object.entries(e.tools).filter(([n]) => !BOOKKEEPING_TOOL.test(n));
  if (names.length === 0) return null;
  const used = names.map(([n, c]) => (c > 1 ? `${toolName(n)} ×${c}` : toolName(n))).join(', ');
  // scratch files the agent wrote for itself are not what it changed
  const files = e.files.filter((f) => !isTemporaryDir(f)).map((f) => fileName(f, cwd));
  if (files.length === 0) return `_Tools: ${used}_`;
  const shown = files.slice(0, 6).join(', ');
  return `_Tools: ${used} — changed ${shown}${files.length > 6 ? ` and ${files.length - 6} more` : ''}_`;
}

function renderExchange(e: Exchange, n: number, speaker: string, max: number, redact: (s: string) => string, cwd: string | null): string {
  const stamp = localStamp(e.at);
  // the heading's words come from the redacted prompt: a key pasted on its first line stays out of the outline too
  const prompt = redact(demoteHeadings(clip(e.prompt, max)));
  const words = gist(prompt);
  const head = `## ${n}${stamp ? ` · ${stamp}` : ''}${words ? ` — ${words}` : ''}`;
  const parts = [head, '**User**', prompt];
  for (const a of e.answers) parts.push(`_Answered:_ ${redact(clip(a, 2000))}`);
  if (e.replies.length || e.plans.length) parts.push(`**${speaker}**`);
  for (const r of e.replies) parts.push(redact(demoteHeadings(clip(r, max))));
  for (const p of e.plans) parts.push(`_Plan put forward:_\n\n${quote(redact(demoteHeadings(clip(p, max))))}`);
  const tools = toolLine(e, cwd);
  if (tools) parts.push(tools);
  return parts.join('\n\n');
}

/* ------------------------------ the document ----------------------------- */

export interface RenderInput {
  conversation: Conversation;
  /** The title to show: the agent's name for it, or one made from the first prompt. */
  title: string;
  /** Where the transcript was read. */
  transcript: string;
}

export interface Rendered {
  markdown: string;
  redactions: number;
  exchanges: number;
  /** The last activity the copy holds (ISO). */
  asOf: string | null;
}

const yaml = (v: string) => JSON.stringify(v);

/** A slug for a tag: lower case, words joined by `-`, letters of any script kept. */
const tagSlug = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '') || 'other';

export function renderConversation(input: RenderInput, opts: { maxMessageChars?: number } = {}): Rendered {
  const c = input.conversation;
  const speaker = AGENT_NAMES[c.agent];
  const project = projectOf(c.cwd);
  const render = (max: number): Rendered => {
    let redactions = 0;
    const redact = (s: string) => {
      const r = redactSecrets(s);
      redactions += r.count;
      return r.text;
    };
    const sections = c.exchanges.map((e, i) => renderExchange(e, i + 1, speaker, max, redact, c.cwd));
    const asOf = c.updatedAt;
    const front = [
      '---',
      `title: ${yaml(input.title)}`,
      'type: Conversation',
      `platform: ${PLATFORM[c.agent]}`,
      c.id ? `session_id: ${yaml(c.id)}` : null,
      project ? `project: ${yaml(project)}` : null,
      c.cwd ? `cwd: ${yaml(homeRelative(c.cwd))}` : null,
      c.branch ? `branch: ${yaml(c.branch)}` : null,
      c.startedAt ? `started_at: ${yaml(c.startedAt)}` : null,
      asOf ? `as_of: ${yaml(asOf)}` : null,
      `exchanges: ${c.exchanges.length}`,
      `transcript: ${yaml(homeRelative(input.transcript))}`,
      redactions ? `redactions: ${redactions}` : null,
      'tags:',
      `  - ${yaml(`conversation/${PLATFORM[c.agent]}`)}`,
      project ? `  - ${yaml(`project/${tagSlug(project)}`)}` : null,
      '---',
    ].filter((l) => l !== null).join('\n');
    const body = sections.length ? sections.join('\n\n') : '_Nothing was asked in this conversation yet._';
    return { markdown: `${front}\n\n# ${input.title.replace(/\n/g, ' ')}\n\n${body}\n`, redactions, exchanges: c.exchanges.length, asOf };
  };
  // a conversation too long to index whole keeps every exchange, each clipped shorter
  let max = opts.maxMessageChars ?? MAX_MESSAGE_CHARS;
  let out = render(max);
  while (Buffer.byteLength(out.markdown) > MAX_FILE_BYTES * 0.95 && max > 1500) {
    max = Math.floor(max / 2);
    out = render(max);
  }
  return out;
}

/** The title to show for a conversation: the agent's own, else the first prompt's first line. */
export function titleOf(c: Pick<Conversation, 'title' | 'exchanges' | 'id'>, firstPrompt?: string | null): string {
  if (c.title?.trim()) return c.title.trim().replace(/\s+/g, ' ');
  const words = gist(firstPrompt ?? c.exchanges[0]?.prompt ?? '');
  return words || (c.id ? `Conversation ${c.id.slice(0, 8)}` : 'Conversation');
}
