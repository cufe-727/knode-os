import fs from 'node:fs';
import path from 'node:path';
import { AppContext } from '../context.js';
import { ask } from '../search/ask.js';
import { SearchMode } from '../search/search.js';
import { appendMessage, ChatAnswerPayload, ChatMessage, getConversation, pruneConversations, setConversationStatus, titleFrom } from './store.js';
import { chatRunsRoot } from './workspace.js';

/**
 * Ask's quick mode: the same one-shot retrieval answer `POST /api/ask` gives,
 * but written into a conversation so both kinds of reply share one list.
 *
 * Deliberately unlike `startChatTurn`: no agent CLI, no run workspace, no MCP
 * endpoint, no busy slot and no history replay — one retrieval pass answers
 * one question. That is what makes Ask usable on a machine with no coding
 * agent installed, and why this path finishes inside the request instead of
 * handing the client a turn to poll.
 */

export interface QuickTurnResult {
  user: ChatMessage;
  assistant: ChatMessage;
}

/** `contexts` are left out on purpose: whole chunks are large, and re-derivable by asking again. */
function payloadOf(result: Awaited<ReturnType<typeof ask>>): ChatAnswerPayload {
  return {
    mode: 'quick',
    citations: result.citations.map((c) => ({ ref: c.ref, path: c.path, chunkId: c.chunkId })),
    gaps: result.gaps,
    facts: result.facts.slice(0, 8).map((f) => ({ statement: f.statement, subject: f.subject, status: f.status })),
  };
}

export async function runQuickTurn(
  ctx: AppContext,
  conversationId: string,
  text: string,
  opts: { mode?: SearchMode } = {},
): Promise<QuickTurnResult> {
  const existing = await getConversation(ctx.store, conversationId);
  if (!existing) throw new Error(`no conversation ${conversationId}`);
  const content = text.trim();
  if (!content) throw new Error('an empty message');

  const user = await appendMessage(ctx.store, { conversationId, role: 'user', content, events: [], turns: null, costUsd: null, error: null });

  let answer = '';
  let payload: ChatAnswerPayload = { mode: 'quick' };
  let error: string | null = null;
  try {
    const result = await ask(ctx.store, ctx.config, ctx.embedder, ctx.llm, content, { mode: opts.mode });
    answer = result.answer;
    payload = payloadOf(result);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const assistant = await appendMessage(ctx.store, {
    conversationId,
    role: 'assistant',
    content: answer,
    events: [],
    payload,
    turns: null,
    costUsd: null,
    error,
  });
  // the row never goes `running` — a quick turn is over before the response is written.
  // The mode is only claimed for a conversation that has none: a quick message
  // posted into an agent thread must not silently retag the whole thread.
  await setConversationStatus(ctx.store, conversationId, 'idle', {
    ...(existing.title ? {} : { title: titleFrom(content) }),
    ...(existing.payload?.mode ? {} : { payload: { ...existing.payload, mode: 'quick' } }),
  });

  // Every quick ask is its own conversation, so this path — not just the agent
  // turn in `runner.ts` — has to keep the list from growing without bound.
  try {
    for (const removed of await pruneConversations(ctx.store, ctx.config.chat?.keep ?? 200)) {
      fs.rmSync(path.join(chatRunsRoot(ctx), removed), { recursive: true, force: true });
    }
  } catch {
    /* housekeeping only */
  }
  return { user, assistant };
}
