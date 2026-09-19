import crypto from 'node:crypto';
import { Store } from '../store/db.js';
import { toIso } from '../store/temporal.js';

/**
 * Conversations and messages of the chat entry (tables chat_conversations /
 * chat_messages, migration v9). A conversation is `running` while a turn is
 * in flight; an assistant message carries the tool activity parsed from the
 * session transcript, the turn count and cost, and any error (`cancelled`
 * when the person stopped it).
 */

export type ChatStatus = 'idle' | 'running';
export type ChatRole = 'user' | 'assistant';
/** How a turn is answered: one retrieval pass, or a session of the agent CLI. */
export type ChatMode = 'quick' | 'agent';

export interface ChatEvent {
  /** knode tool name without the mcp prefix, or `wrote` for a file the reply says it wrote. */
  tool: string;
  summary: string;
  path?: string;
  ok?: boolean;
}

/**
 * What a quick (retrieval) answer knows about itself. Agent replies leave it
 * empty and carry their tool activity in `events` instead.
 */
export interface ChatAnswerPayload {
  mode?: ChatMode;
  citations?: { ref: number; path: string; chunkId?: string }[];
  gaps?: string[];
  facts?: { statement: string; subject?: string; status?: string }[];
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  seq: number;
  role: ChatRole;
  content: string;
  events: ChatEvent[];
  payload: ChatAnswerPayload;
  turns: number | null;
  costUsd: number | null;
  error: string | null;
  createdAt: string;
}

export interface ChatConversation {
  id: string;
  title: string;
  agent: string | null;
  model: string | null;
  status: ChatStatus;
  createdBy: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  messages?: ChatMessage[];
}

interface ConversationRow {
  id: string; title: string; agent: string | null; model: string | null; status: string; created_by: string | null;
  payload: Record<string, unknown> | null; created_at: string | Date; updated_at: string | Date;
}

interface MessageRow {
  id: string; conversation_id: string; seq: number; role: string; content: string; events: ChatEvent[] | null;
  payload: ChatAnswerPayload | null; turns: number | null; cost_usd: number | null; error: string | null; created_at: string | Date;
}

const CONV_COLS = 'id, title, agent, model, status, created_by, payload, created_at, updated_at';
const MSG_COLS = 'id, conversation_id, seq, role, content, events, payload, turns, cost_usd, error, created_at';

function conversation(r: ConversationRow): ChatConversation {
  return {
    id: r.id,
    title: r.title,
    agent: r.agent,
    model: r.model,
    status: r.status === 'running' ? 'running' : 'idle',
    createdBy: r.created_by,
    payload: r.payload ?? {},
    createdAt: toIso(r.created_at)!,
    updatedAt: toIso(r.updated_at)!,
  };
}

function message(r: MessageRow): ChatMessage {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    seq: r.seq,
    role: r.role === 'assistant' ? 'assistant' : 'user',
    content: r.content,
    events: Array.isArray(r.events) ? r.events : [],
    payload: r.payload ?? {},
    turns: r.turns,
    costUsd: r.cost_usd,
    error: r.error,
    createdAt: toIso(r.created_at)!,
  };
}

/** A conversation's title: the first line of its first message, trimmed. */
export function titleFrom(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

export async function createConversation(
  store: Store,
  input: { title?: string; createdBy?: string | null; mode?: ChatMode } = {},
): Promise<ChatConversation> {
  const id = `c_${crypto.randomBytes(5).toString('hex')}`;
  const [row] = await store.query<ConversationRow>(
    `INSERT INTO chat_conversations (id, title, created_by, payload) VALUES ($1, $2, $3, $4::jsonb) RETURNING ${CONV_COLS}`,
    [id, (input.title ?? '').trim().slice(0, 120), input.createdBy ?? null, JSON.stringify(input.mode ? { mode: input.mode } : {})],
  );
  return conversation(row);
}

export async function listConversations(store: Store, opts: { limit?: number } = {}): Promise<ChatConversation[]> {
  const rows = await store.query<ConversationRow>(`SELECT ${CONV_COLS} FROM chat_conversations ORDER BY updated_at DESC LIMIT $1`, [opts.limit ?? 50]);
  return rows.map(conversation);
}

export async function getConversation(store: Store, id: string, opts: { messages?: boolean } = {}): Promise<ChatConversation | null> {
  const [row] = await store.query<ConversationRow>(`SELECT ${CONV_COLS} FROM chat_conversations WHERE id = $1`, [id]);
  if (!row) return null;
  const out = conversation(row);
  if (opts.messages) {
    const rows = await store.query<MessageRow>(`SELECT ${MSG_COLS} FROM chat_messages WHERE conversation_id = $1 ORDER BY seq`, [id]);
    out.messages = rows.map(message);
  }
  return out;
}

/** The newest `limit` messages, oldest first (what a turn's prompt replays). */
export async function recentMessages(store: Store, id: string, limit: number): Promise<ChatMessage[]> {
  if (limit <= 0) return [];
  const rows = await store.query<MessageRow>(`SELECT ${MSG_COLS} FROM chat_messages WHERE conversation_id = $1 ORDER BY seq DESC LIMIT $2`, [id, limit]);
  return rows.map(message).reverse();
}

export async function appendMessage(
  store: Store,
  input: Omit<ChatMessage, 'id' | 'seq' | 'createdAt' | 'payload'> & { payload?: ChatAnswerPayload },
): Promise<ChatMessage> {
  const id = `m_${crypto.randomBytes(6).toString('hex')}`;
  const [row] = await store.query<MessageRow>(
    `INSERT INTO chat_messages (id, conversation_id, seq, role, content, events, payload, turns, cost_usd, error)
     VALUES ($1, $2, (SELECT COALESCE(max(seq), 0) + 1 FROM chat_messages WHERE conversation_id = $2), $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
     RETURNING ${MSG_COLS}`,
    [id, input.conversationId, input.role, input.content, JSON.stringify(input.events ?? []), JSON.stringify(input.payload ?? {}), input.turns, input.costUsd, input.error],
  );
  await store.query(`UPDATE chat_conversations SET updated_at = now() WHERE id = $1`, [input.conversationId]);
  return message(row);
}

export async function setConversationStatus(
  store: Store,
  id: string,
  status: ChatStatus,
  patch: { title?: string; agent?: string | null; model?: string | null; payload?: Record<string, unknown> } = {},
): Promise<void> {
  const sets = ['status = $2', 'updated_at = now()'];
  const params: unknown[] = [id, status];
  if (patch.title !== undefined) {
    params.push(patch.title);
    sets.push(`title = $${params.length}`);
  }
  if (patch.agent !== undefined) {
    params.push(patch.agent);
    sets.push(`agent = $${params.length}`);
  }
  if (patch.model !== undefined) {
    params.push(patch.model);
    sets.push(`model = $${params.length}`);
  }
  if (patch.payload !== undefined) {
    params.push(JSON.stringify(patch.payload));
    sets.push(`payload = $${params.length}::jsonb`);
  }
  await store.query(`UPDATE chat_conversations SET ${sets.join(', ')} WHERE id = $1`, params);
}

/**
 * A turn only lives in one process: a conversation left `running` by a crashed
 * or restarted `serve` would stay "answering" forever (and escape pruning).
 * Called once when a workspace's services start.
 */
export async function resetRunningConversations(store: Store): Promise<number> {
  const rows = await store.query<{ id: string }>(`UPDATE chat_conversations SET status = 'idle' WHERE status = 'running' RETURNING id`);
  return rows.length;
}

export async function deleteConversation(store: Store, id: string): Promise<boolean> {
  const rows = await store.query<{ id: string }>(`DELETE FROM chat_conversations WHERE id = $1 RETURNING id`, [id]);
  return rows.length > 0;
}

/** Keep the newest `keep` conversations (by activity); returns the ids removed so their run directories can go too. */
export async function pruneConversations(store: Store, keep: number): Promise<string[]> {
  const rows = await store.query<{ id: string }>(
    `DELETE FROM chat_conversations WHERE status <> 'running' AND id IN (
       SELECT id FROM chat_conversations ORDER BY updated_at DESC OFFSET $1
     ) RETURNING id`,
    [Math.max(0, keep)],
  );
  return rows.map((r) => r.id);
}
