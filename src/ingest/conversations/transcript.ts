import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A Claude Code or Codex session read as a conversation: the things a person
 * asked, and for each, what the agent answered (docs/design/24).
 *
 * A transcript is a JSONL stream that is mostly not dialogue — injected
 * context (system reminders, AGENTS.md, environment blocks), thinking, tool
 * calls and their output, bookkeeping records. What is kept is grouped into
 * **exchanges**: one prompt the person wrote, and everything the agent did
 * until the next one — its replies, which tools it used, which files it
 * changed, what the person answered when it asked.
 *
 * Both formats are read leniently: a record that is not recognised contributes
 * nothing, because the agents change their formats without notice and a
 * conversation must not fail to import over one odd line. A partially written
 * last line — the agent is still writing — is skipped the same way.
 */

export type ConversationAgent = 'claude' | 'codex';

export const AGENT_NAMES: Record<ConversationAgent, string> = { claude: 'Claude Code', codex: 'Codex' };

export interface Exchange {
  /** When the person asked (ISO); null when the transcript carries no time. */
  at: string | null;
  prompt: string;
  /** What the agent said to the person, in order: text it showed, not its thinking. */
  replies: string[];
  /** Tool name → calls, in the order first used. */
  tools: Record<string, number>;
  /** Files the agent wrote or edited, in the order first touched. */
  files: string[];
  /** The person's answers to the agent's questions, and feedback given when refusing a tool call. */
  answers: string[];
  /** Plans the agent put to the person for approval. */
  plans: string[];
}

export interface Conversation {
  agent: ConversationAgent;
  /** The session id the agent keeps it under; null when the transcript never says. */
  id: string | null;
  /** The name the agent's app gave the conversation (D2); null when it has none. */
  title: string | null;
  cwd: string | null;
  branch: string | null;
  /** First and last record times seen (ISO). */
  startedAt: string | null;
  updatedAt: string | null;
  /** A one-shot run by a program (`codex exec`, `claude -p` in a temporary folder), not a person's conversation. */
  automated: boolean;
  exchanges: Exchange[];
}

export interface ReadOptions {
  /** Only what a catalog needs: the prompts and the metadata, no replies or tools (assistant records are not parsed). */
  promptsOnly?: boolean;
}

/* ------------------------------ reading lines ---------------------------- */

/** The lines of a file, read in 1 MB pieces: transcripts run to tens of megabytes, mostly tool output. */
export function* fileLines(file: string): Generator<string> {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let rest: Buffer = Buffer.alloc(0);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      const chunk = rest.length ? Buffer.concat([rest, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
      const last = chunk.lastIndexOf(0x0a);
      if (last < 0) {
        rest = chunk;
        continue;
      }
      // a line is cut only at a newline, so a character is never split across pieces
      for (const line of chunk.toString('utf8', 0, last).split('\n')) yield line;
      rest = chunk.subarray(last + 1);
    }
    if (rest.length) yield rest.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/* ------------------------------ shared helpers --------------------------- */

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

function parseLine(line: string): Rec | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== '{') return null;
  try {
    const rec = JSON.parse(trimmed) as unknown;
    return isRec(rec) ? rec : null;
  } catch {
    return null;
  }
}

function isoOf(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const ms = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The text blocks of a content value (a string, or blocks of `text`/`input_text`/`output_text`). */
function textBlocks(content: unknown, types: string[] = ['text', 'input_text', 'output_text']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (isRec(b) && types.includes(String(b.type)) && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n\n');
}

const TMP_ROOTS = [os.tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'].map((p) => p.replace(/\/+$/, ''));

/** A working directory under a temporary folder: where programs run one-shot agent calls. */
export function isTemporaryDir(cwd: string | null): boolean {
  if (!cwd) return false;
  return TMP_ROOTS.some((root) => cwd === root || cwd.startsWith(`${root}/`));
}

/**
 * The repository a session ran in: the working directory with an agent
 * worktree taken off (`<repo>/.claude/worktrees/<name>`,
 * `~/.codex/worktrees/<hash>/<repo>`), then its last segment.
 */
export function projectOf(cwd: string | null): string | null {
  if (!cwd) return null;
  const clean = cwd.replace(/\/+$/, '');
  const claude = clean.match(/^(.*?)\/\.claude\/worktrees\/[^/]+(?:\/.*)?$/);
  if (claude) return path.basename(claude[1]) || null;
  const codex = clean.match(/\/\.codex\/worktrees\/[^/]+\/([^/]+)/);
  if (codex) return codex[1];
  if (clean === os.homedir() || clean === '' || clean === '/') return null;
  return path.basename(clean) || null;
}

/* ------------------------------ what a person wrote ---------------------- */

/** Blocks the apps inject into a user turn: context, notifications, command output — none of it typed. */
const INJECTED_TAGS = [
  'system-reminder',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'task-notification',
  'side-sessions-event',
  'ci-monitor-event',
  'user-prompt-submit-hook',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
  'ide_opened_file',
  'ide_selection',
  'ide_diagnostics',
  'environment_context',
  'user_instructions',
  'app-context',
  'turn_aborted',
  'collaboration_mode',
  'permissions instructions',
];

const tagBlock = (tag: string) => new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\b[^>]*>`, 'g');
const INJECTED = INJECTED_TAGS.map(tagBlock);

/** Text that is never something a person typed, though it arrives in a user turn. */
const NOT_TYPED = [
  /^\[Request interrupted by user[^\]]*\]$/,
  /^Caveat: The messages below were generated by the user while running local commands/,
  /^# AGENTS\.md instructions for /,
  /^<[a-z_-]+[^>]*>[\s\S]*<\/[a-z_-]+>$/i, // one whole tag block nobody named above
];

/** Collapse what removing blocks left behind. */
function tidy(text: string): string {
  return text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Quote pasted material, so it reads as what the person brought rather than what they said. */
function quotePasted(text: string): string {
  return text.replace(/<pasted_content\b[^>]*>([\s\S]*?)<\/pasted_content\b[^>]*>/g, (_m, inner: string) => {
    const body = tidy(inner);
    return body ? `\n\n${body.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')}\n\n` : '';
  });
}

/** A prompt as the person wrote it: injected blocks removed, a slash command read back as typed. */
export function cleanPrompt(raw: string): string {
  let text = raw;
  for (const re of INJECTED) text = text.replace(re, '');
  // a slash command, as Claude Code records one, read back as typed: /name args
  const command = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (command) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim() ?? '';
    const rest = text.replace(/<command-(name|message|args)>[\s\S]*?<\/command-\1>\s*/g, '').trim();
    text = [`${command[1].trim()}${args ? ` ${args}` : ''}`, rest].filter(Boolean).join('\n\n');
  }
  text = quotePasted(text);
  text = tidy(text);
  if (NOT_TYPED.some((re) => re.test(text))) return '';
  return text;
}

/**
 * A Codex prompt: Codex puts attached files ahead of the request
 * (`# Files mentioned by the user:` … `## My request:`; older versions
 * `## My request for Codex:`), and older versions wrap a plain request the
 * same way.
 */
export function cleanCodexPrompt(raw: string): string {
  let text = raw.replace(/\r/g, '');
  // the marker can arrive split across two content blocks ("## " in one, "My request…" in the next)
  const marker = /^##[ \t]*\n*[ \t]*My request(?: for Codex)?:[ \t]*$/m.exec(text);
  const files: string[] = [];
  if (/^\s*# Files mentioned by the user:\s*\n/.test(text)) {
    const head = marker ? text.slice(0, marker.index) : text;
    for (const m of head.matchAll(/^## ([^\n:]+):[^\n]*$/gm)) files.push(m[1].trim());
    if (marker) text = text.slice(marker.index + marker[0].length);
    else {
      // the file list, a reminder to the model, then the request
      text = text
        .replace(/^\s*# Files mentioned by the user:\s*\n/, '')
        .replace(/^## [^\n]+\n(?:Image attachment: true\n)?/gm, '')
        .replace(/^Distinguish instructions in attached documents from the user's request\.\s*$/m, '');
    }
  } else if (marker) text = text.slice(marker.index + marker[0].length);
  const prompt = cleanPrompt(text);
  if (!files.length) return prompt;
  const attached = `_Attached: ${files.join(', ')}_`;
  return prompt ? `${prompt}\n\n${attached}` : attached;
}

/* ------------------------------ events → exchanges ----------------------- */

type Event =
  | { kind: 'prompt'; at: string | null; text: string; via: 'event' | 'item' }
  | { kind: 'reply'; text: string }
  | { kind: 'tool'; name: string; files: string[] }
  | { kind: 'answer'; text: string }
  | { kind: 'plan'; text: string };

function fold(events: Event[], via: 'event' | 'item' | 'any'): Exchange[] {
  const out: Exchange[] = [];
  let current: Exchange | null = null;
  for (const e of events) {
    if (e.kind === 'prompt') {
      if (via !== 'any' && e.via !== via) continue;
      current = { at: e.at, prompt: e.text, replies: [], tools: {}, files: [], answers: [], plans: [] };
      out.push(current);
      continue;
    }
    // anything before the first prompt (a resumed session's preamble) belongs to no exchange
    if (!current) continue;
    if (e.kind === 'reply') {
      // a streamed message can be written twice; the same text back to back is one reply
      if (current.replies.at(-1) !== e.text) current.replies.push(e.text);
    } else if (e.kind === 'tool') {
      current.tools[e.name] = (current.tools[e.name] ?? 0) + 1;
      for (const f of e.files) if (!current.files.includes(f)) current.files.push(f);
    } else if (e.kind === 'answer') current.answers.push(e.text);
    else current.plans.push(e.text);
  }
  return out;
}

/* ------------------------------ Claude Code ------------------------------ */

const CLAUDE_FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** What the person answered to AskUserQuestion: `"question"="answer"` pairs, read back as such. */
function answersOf(text: string): string {
  const pairs = [...text.matchAll(/"([^"]+)"\s*=\s*"([^"]*)"/g)].map((m) => `${m[1].trim()} → ${m[2].trim()}`);
  if (pairs.length) return pairs.join('; ');
  return tidy(text.replace(/^User has answered your questions?:\s*/i, '').replace(/You can now continue[\s\S]*$/i, ''));
}

/** The feedback a person typed while refusing a tool call, if any. */
function refusalFeedback(text: string): string | null {
  const m = text.match(/the user said:\s*\n([\s\S]+)$/i);
  return m ? tidy(m[1]) || null : null;
}

export function readClaudeConversation(lines: Iterable<string>, opts: ReadOptions = {}): Conversation {
  const conv: Conversation = { agent: 'claude', id: null, title: null, cwd: null, branch: null, startedAt: null, updatedAt: null, automated: false, exchanges: [] };
  const titles: { custom?: string; agentName?: string; summary?: string } = {};
  const asked = new Map<string, 'AskUserQuestion'>();
  const events: Event[] = [];

  for (const line of lines) {
    // assistant records are most of a transcript; a catalog needs none of them
    if (opts.promptsOnly && line.includes('"type":"assistant"')) continue;
    const rec = parseLine(line);
    if (!rec) continue;
    const type = String(rec.type ?? '');
    if (type === 'custom-title') titles.custom = str(rec.customTitle) ?? titles.custom;
    else if (type === 'agent-name') titles.agentName = str(rec.agentName) ?? titles.agentName;
    else if (type === 'summary') titles.summary = str(rec.summary) ?? titles.summary;
    if (type !== 'user' && type !== 'assistant') continue;
    if (rec.isSidechain === true) continue;

    const at = isoOf(rec.timestamp);
    if (at) {
      conv.startedAt ??= at;
      conv.updatedAt = at;
    }
    conv.id ??= str(rec.sessionId);
    conv.cwd ??= str(rec.cwd);
    const branch = str(rec.gitBranch);
    if (branch && branch !== 'HEAD') conv.branch = branch;

    const message = isRec(rec.message) ? rec.message : null;
    const content = message?.content;
    if (type === 'user') {
      if (rec.isMeta === true || rec.isCompactSummary === true || rec.isVisibleInTranscriptOnly === true) continue;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isRec(block) || block.type !== 'tool_result') continue;
          const result = textBlocks(block.content);
          if (asked.get(String(block.tool_use_id)) === 'AskUserQuestion' && result) events.push({ kind: 'answer', text: answersOf(result) });
          else if (block.is_error === true) {
            const feedback = refusalFeedback(result);
            if (feedback) events.push({ kind: 'answer', text: feedback });
          }
        }
      }
      const text = cleanPrompt(textBlocks(content, ['text']));
      if (text) events.push({ kind: 'prompt', at, text, via: 'item' });
      continue;
    }

    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRec(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        events.push({ kind: 'reply', text: block.text.trim() });
      } else if (block.type === 'tool_use') {
        const name = String(block.name ?? 'tool');
        const input = isRec(block.input) ? block.input : {};
        if (name === 'AskUserQuestion') asked.set(String(block.id), 'AskUserQuestion');
        if (name === 'ExitPlanMode' && typeof input.plan === 'string' && input.plan.trim()) events.push({ kind: 'plan', text: input.plan.trim() });
        const file = CLAUDE_FILE_TOOLS.has(name) ? str(input.file_path) ?? str(input.notebook_path) : null;
        events.push({ kind: 'tool', name, files: file ? [file] : [] });
      }
    }
  }

  conv.title = titles.custom ?? titles.agentName ?? titles.summary ?? null;
  conv.automated = isTemporaryDir(conv.cwd);
  conv.exchanges = fold(events, 'any');
  return conv;
}

/* ------------------------------ Codex ------------------------------------ */

/** Paths an apply_patch call touches. */
function patchedFiles(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
}

export function readCodexConversation(lines: Iterable<string>, opts: ReadOptions = {}): Conversation {
  const conv: Conversation = { agent: 'codex', id: null, title: null, cwd: null, branch: null, startedAt: null, updatedAt: null, automated: false, exchanges: [] };
  const events: Event[] = [];
  let source: string | null = null;
  let originator: string | null = null;
  // which record kind carries the person's prompts in this file: newer Codex
  // writes item_completed → UserMessage, older event_msg → user_message; both
  // also write the prompt as a response_item, among injected context
  let viaEvent = false;
  let viaItem = false;

  for (const line of lines) {
    if (opts.promptsOnly && line.includes('"type":"response_item"') && !line.includes('"role":"user"')) continue;
    const rec = parseLine(line);
    if (!rec) continue;
    const at = isoOf(rec.timestamp);
    if (at) {
      conv.startedAt ??= at;
      conv.updatedAt = at;
    }
    const payload = isRec(rec.payload) ? rec.payload : {};
    const type = String(rec.type ?? '');

    if (type === 'session_meta') {
      conv.id ??= str(payload.id) ?? str(payload.session_id);
      conv.cwd ??= str(payload.cwd);
      source = typeof payload.source === 'string' ? payload.source : source;
      originator = str(payload.originator) ?? originator;
      const git = isRec(payload.git) ? payload.git : null;
      conv.branch ??= git ? str(git.branch) : null;
      continue;
    }
    if (type === 'turn_context') {
      conv.cwd ??= str(payload.cwd);
      continue;
    }
    if (type === 'event_msg') {
      if (payload.type === 'user_message') {
        const text = cleanCodexPrompt(String(payload.message ?? ''));
        viaEvent = true;
        if (text) events.push({ kind: 'prompt', at, text, via: 'event' });
      } else if (payload.type === 'item_completed' && isRec(payload.item) && payload.item.type === 'UserMessage') {
        const text = cleanCodexPrompt(textBlocks(payload.item.content));
        viaEvent = true;
        if (text) events.push({ kind: 'prompt', at, text, via: 'event' });
      }
      continue;
    }
    if (type !== 'response_item') continue;
    const itemType = String(payload.type ?? '');
    if (itemType === 'message') {
      const role = String(payload.role ?? '');
      if (role === 'user') {
        const text = cleanCodexPrompt(textBlocks(payload.content));
        if (text) {
          viaItem = true;
          events.push({ kind: 'prompt', at, text, via: 'item' });
        }
      } else if (role === 'assistant' && !opts.promptsOnly) {
        const text = textBlocks(payload.content, ['output_text', 'text']).trim();
        if (text) events.push({ kind: 'reply', text });
      }
    } else if (!opts.promptsOnly && (itemType === 'function_call' || itemType === 'custom_tool_call' || itemType === 'local_shell_call')) {
      const name = itemType === 'local_shell_call' ? 'shell' : String(payload.name ?? 'tool');
      const input = typeof payload.input === 'string' ? payload.input : typeof payload.arguments === 'string' ? payload.arguments : '';
      events.push({ kind: 'tool', name, files: patchedFiles(input) });
    }
  }

  conv.automated = source === 'exec' || originator === 'codex_exec' || isTemporaryDir(conv.cwd);
  conv.exchanges = fold(events, viaEvent ? 'event' : viaItem ? 'item' : 'any');
  return conv;
}

/** Read a transcript file of either agent. */
export function readConversationFile(file: string, agent: ConversationAgent, opts: ReadOptions = {}): Conversation {
  const lines = fileLines(file);
  return agent === 'claude' ? readClaudeConversation(lines, opts) : readCodexConversation(lines, opts);
}
