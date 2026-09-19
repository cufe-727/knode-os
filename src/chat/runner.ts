import fs from 'node:fs';
import path from 'node:path';
import { KnodeConfig } from '../config.js';
import { AppContext } from '../context.js';
import { safePath } from '../fs/files.js';
import { agentForSpec, agentWebCapable, ExecutorId, ResearchAgent, resolveResearchAgent, withModel } from '../research/agent.js';
import { clearCancelled, JobCancelledError, killAgentsFor, launchSession, SessionResult, transcriptPathFor } from '../research/launch.js';
import { McpEndpoint } from '../research/workspace.js';
import { appendMessage, ChatConversation, ChatEvent, ChatMessage, ChatStatus, getConversation, pruneConversations, recentMessages, setConversationStatus, titleFrom } from './store.js';
import { writtenPaths } from './templates.js';
import { chatRunsRoot, prepareChatWorkspace, renderChatPrompt } from './workspace.js';

/**
 * One chat turn = one headless session of the configured CLI in the
 * conversation's workspace: the prompt replays recent history and carries
 * the new message; the agent answers from the knowledge base over MCP (and
 * may write a note when taught something); the reply lands as an assistant
 * message with the tool activity parsed from the transcript.
 *
 * No CLI session persistence: every turn is a fresh process (persisted
 * Claude Code sessions would be mirrored into raw/traces by the trace sync).
 * While a turn runs, the conversation is `running`; `chatActivity` reads the
 * live transcript, `cancelChatTurn` kills the process.
 */

export interface ChatTurnResult {
  conversation: ChatConversation;
  message: ChatMessage;
}

export interface ChatActivity {
  status: ChatStatus;
  seq: number | null;
  startedAt: string | null;
  activity: ChatEvent[];
}

export class ChatBusyError extends Error {
  constructor(public readonly conversationId: string) {
    super(`conversation ${conversationId} is already answering`);
    this.name = 'ChatBusyError';
  }
}

interface RunningTurn {
  seq: number;
  startedAt: string;
  transcriptPath: string;
  provider: ExecutorId;
}

const running = new Map<string, RunningTurn>();

const key = (ctx: AppContext, conversationId: string) => `${ctx.dataDir}::${conversationId}`;
const jobIdOf = (conversationId: string) => `chat:${conversationId}`;

/** Which CLI answers chat: chat.agent (connection id / provider), else the research agent; chat.model overrides. */
export function resolveChatAgent(config: KnodeConfig, dataDir?: string): ResearchAgent | null {
  const chat = config.chat;
  if (chat?.agent?.trim()) return agentForSpec(config, chat.agent, chat.model, dataDir);
  const base = resolveResearchAgent(config, dataDir);
  if (!base) return null;
  return withModel(base, chat?.model ?? '');
}

/**
 * Web tools for chat: review.external stays the master switch; chat.web only
 * narrows or, within it, widens. The agent has the final say — the built-in
 * agent has no web tool, so no setting can give it one.
 */
export function chatWebAllowed(config: KnodeConfig, agent?: ResearchAgent | null): boolean {
  const gate = config.review?.external ?? 'verify';
  const web = config.chat?.web ?? 'inherit';
  if (gate === 'off' || web === 'off') return false;
  if (agent !== undefined && !agentWebCapable(agent)) return false;
  if (web === 'on') return true;
  return gate === 'research';
}

function summarize(input: unknown): { summary: string; path?: string } {
  if (!input || typeof input !== 'object') return { summary: '' };
  const o = input as Record<string, unknown>;
  const pick = ['query', 'question', 'utterance', 'path', 'pattern', 'subject', 'target', 'id'].map((k) => o[k]).find((v) => typeof v === 'string' && v.trim()) as string | undefined;
  const only = Array.isArray(o.only) && typeof o.only[0] === 'string' ? (o.only[0] as string) : undefined;
  const summary = (pick ?? only ?? JSON.stringify(o)).slice(0, 80);
  const p = typeof o.path === 'string' ? o.path : only;
  return p ? { summary, path: p } : { summary };
}

/**
 * Tool activity from a claude / cursor stream-json transcript: every
 * `tool_use` block of an assistant message, with `ok` filled in from the
 * matching `tool_result`. Other providers give no event stream → []. The
 * built-in agent writes the same shape, so it parses like claude does.
 */
export function parseActivity(transcriptPath: string, provider: ExecutorId): ChatEvent[] {
  if (provider === 'codex-cli' || !fs.existsSync(transcriptPath)) return [];
  const events: ChatEvent[] = [];
  const byId = new Map<string, ChatEvent>();
  for (const line of fs.readFileSync(transcriptPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let ev: { type?: string; message?: { content?: unknown } };
    try {
      ev = JSON.parse(line) as typeof ev;
    } catch {
      continue;
    }
    const content = Array.isArray(ev.message?.content) ? (ev.message!.content as Record<string, unknown>[]) : [];
    if (ev.type === 'assistant') {
      for (const block of content) {
        if (block.type !== 'tool_use' || typeof block.name !== 'string') continue;
        const { summary, path: p } = summarize(block.input);
        const event: ChatEvent = { tool: block.name.replace(/^mcp__knode-os__/, ''), summary, ...(p ? { path: p } : {}) };
        events.push(event);
        if (typeof block.id === 'string') byId.set(block.id, event);
      }
    } else if (ev.type === 'user') {
      for (const block of content) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const event = byId.get(block.tool_use_id);
        if (event) event.ok = !block.is_error;
      }
    }
  }
  return events;
}

/** What a running turn has done so far (idle → empty). */
export function chatActivity(ctx: AppContext, conversationId: string): ChatActivity {
  const turn = running.get(key(ctx, conversationId));
  if (!turn) return { status: 'idle', seq: null, startedAt: null, activity: [] };
  return { status: 'running', seq: turn.seq, startedAt: turn.startedAt, activity: parseActivity(turn.transcriptPath, turn.provider) };
}

export function isChatRunning(ctx: AppContext, conversationId: string): boolean {
  return running.has(key(ctx, conversationId));
}

/** Kill the running turn's process; the turn ends with error `cancelled`. */
export function cancelChatTurn(ctx: AppContext, conversationId: string): boolean {
  if (!running.has(key(ctx, conversationId))) return false;
  killAgentsFor(jobIdOf(conversationId));
  return true;
}

export interface StartChatOptions {
  mcp: McpEndpoint;
  /** Override the agent (tests point it at a fake CLI). */
  agent?: ResearchAgent;
  log?: (m: string) => void;
}

/**
 * Record the person's message, mark the conversation running and start the
 * agent. Returns the user message's seq at once and the turn as a promise, so
 * a route can answer 202 and let the turn finish in the background.
 */
export async function startChatTurn(ctx: AppContext, conversationId: string, text: string, opts: StartChatOptions): Promise<{ seq: number; turn: Promise<ChatTurnResult> }> {
  const log = opts.log ?? (() => {});
  const chat = ctx.config.chat;
  const k = key(ctx, conversationId);
  // the slot is taken synchronously: the setup below awaits, and two clients
  // posting at once must not both get past the busy check
  if (running.has(k)) throw new ChatBusyError(conversationId);
  const entry: RunningTurn = { seq: 0, startedAt: new Date().toISOString(), transcriptPath: '', provider: 'claude-cli' };
  running.set(k, entry);

  let agent: ResearchAgent;
  let history: ChatMessage[];
  let seq: number;
  try {
    const existing = await getConversation(ctx.store, conversationId);
    if (!existing) throw new Error(`no conversation ${conversationId}`);
    const resolved = opts.agent ?? resolveChatAgent(ctx.config, ctx.dataDir);
    if (!resolved) throw new Error(`no chat agent configured: set chat.agent or research.agent to a CLI (claude-cli / codex-cli / cursor-cli), a connection id, or 'default' to run the built-in agent on the default LLM connection`);
    agent = resolved;
    const content = text.trim();
    if (!content) throw new Error('an empty message');
    history = await recentMessages(ctx.store, conversationId, chat?.historyTurns ?? 12);
    const user = await appendMessage(ctx.store, { conversationId, role: 'user', content, events: [], turns: null, costUsd: null, error: null });
    await setConversationStatus(ctx.store, conversationId, 'running', {
      agent: agent.provider,
      model: agent.model || null,
      ...(existing.title ? {} : { title: titleFrom(content) }),
    });
    seq = user.seq + 1;
    entry.seq = seq;
    entry.provider = agent.provider;
  } catch (err) {
    running.delete(k);
    throw err;
  }
  const content = text.trim();
  const label = `turn-${seq}`;
  const jobId = jobIdOf(conversationId);
  clearCancelled(jobId);

  const turn = (async (): Promise<ChatTurnResult> => {
    let result: SessionResult | null = null;
    let error: string | null = null;
    try {
      const ws = await prepareChatWorkspace(ctx, conversationId, { mcp: opts.mcp });
      entry.transcriptPath = transcriptPathFor(ws.dir, label);
      const allowNetwork = chatWebAllowed(ctx.config, agent);
      const prompt = renderChatPrompt(ctx.dataDir, { conversationId, history, message: content, allowNetwork });
      fs.writeFileSync(path.join(ws.dir, `prompt-${label}.md`), prompt);
      const readDirs = (ctx.config.research?.readDirs ?? ['raw/docs', 'wiki', '.sidecar']).map((d) => safePath(ctx.dataDir, d)).filter((d) => fs.existsSync(d));
      log(`chat ${conversationId}: turn ${seq} on ${agent.provider}${agent.model ? ` ${agent.model}` : ''}`);
      result = await launchSession({
        agent,
        maxTurns: chat?.maxTurns ?? 30,
        timeoutMs: chat?.timeoutMs ?? 600_000,
        cwd: ws.dir,
        prompt,
        mcp: opts.mcp,
        readDirs,
        jobId,
        outputPath: '',
        worksetId: '',
        allowNetwork,
        tools: 'write',
        files: true,
        effort: chat?.effort ?? 'default',
        label,
      });
      error = result.error;
    } catch (err) {
      error = err instanceof JobCancelledError ? 'cancelled' : err instanceof Error ? err.message : String(err);
    }
    const events = entry.transcriptPath ? parseActivity(entry.transcriptPath, agent.provider) : [];
    const reply = result?.text ?? '';
    for (const p of writtenPaths(reply)) events.push({ tool: 'wrote', summary: p, path: p, ok: true });
    const assistant = await appendMessage(ctx.store, {
      conversationId,
      role: 'assistant',
      content: reply,
      events,
      turns: result?.turns ?? null,
      costUsd: result?.costUsd ?? null,
      error,
    });
    await setConversationStatus(ctx.store, conversationId, 'idle');
    clearCancelled(jobId);
    running.delete(k);
    log(`chat ${conversationId}: turn ${seq} ${error ? `ended with ${error}` : 'answered'}${result?.turns ? ` (${result.turns} turns)` : ''}`);
    try {
      for (const removed of await pruneConversations(ctx.store, chat?.keep ?? 50)) {
        fs.rmSync(path.join(chatRunsRoot(ctx), removed), { recursive: true, force: true });
      }
    } catch {
      /* housekeeping only */
    }
    const conversation = (await getConversation(ctx.store, conversationId, { messages: true }))!;
    return { conversation, message: assistant };
  })();
  turn.catch(() => running.delete(k));
  return { seq, turn };
}

/** Run one turn to completion (CLI, tests). */
export async function runChatTurn(ctx: AppContext, conversationId: string, text: string, opts: StartChatOptions): Promise<ChatTurnResult> {
  return (await startChatTurn(ctx, conversationId, text, opts)).turn;
}

/** Remove a conversation's run directory (after its rows are gone). */
export function removeChatWorkspace(ctx: AppContext, conversationId: string): void {
  fs.rmSync(path.join(chatRunsRoot(ctx), conversationId), { recursive: true, force: true });
}
