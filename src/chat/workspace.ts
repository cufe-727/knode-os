import fs from 'node:fs';
import path from 'node:path';
import { AppContext } from '../context.js';
import { renderSurvey, surveyKnowledgeBase } from '../research/survey.js';
import { knowledgeNotes, McpEndpoint, runsRoot, writeAgentFiles } from '../research/workspace.js';
import { ChatMessage } from './store.js';
import { CHAT_NOTES_DIR, loadChatProtocol, loadChatTurnPrompt } from './templates.js';

/**
 * A conversation's workspace: `<data>/<runsDir>/chat/<conversationId>/`,
 * rewritten every turn so protocol and guide edits apply at once. The same
 * files a research run gets (CLAUDE.md / AGENTS.md = protocol + the base's
 * notes + a survey; .mcp.json; .cursor/mcp.json), plus one prompt and one
 * transcript per turn (`prompt-turn-<seq>.md`, `transcript-turn-<seq>.jsonl`).
 */

export function chatRunsRoot(ctx: AppContext): string {
  return path.join(runsRoot(ctx.dataDir, ctx.config.research?.runsDir ?? '.runs'), 'chat');
}

export function chatWorkspaceDir(ctx: AppContext, conversationId: string): string {
  return path.join(chatRunsRoot(ctx), conversationId);
}

export async function prepareChatWorkspace(
  ctx: AppContext,
  conversationId: string,
  opts: { mcp: McpEndpoint },
): Promise<{ dir: string }> {
  const dir = chatWorkspaceDir(ctx, conversationId);
  fs.mkdirSync(dir, { recursive: true });
  let survey = '';
  try {
    survey = renderSurvey(await surveyKnowledgeBase(ctx));
  } catch {
    survey = '';
  }
  const schema = [
    loadChatProtocol(ctx.dataDir).trim(),
    '',
    knowledgeNotes(ctx.dataDir),
    '',
    survey,
  ].filter(Boolean).join('\n');
  writeAgentFiles(dir, { schema, mcp: opts.mcp, readme: `Chat workspace for conversation ${conversationId}. CLAUDE.md / AGENTS.md is the schema; prompt-turn-<n>.md and transcript-turn-<n>.jsonl are one turn each.\n` });
  return { dir };
}

const ASSISTANT_CHARS = 2_000;
const HISTORY_CHARS = 40_000;

/** The turn prompt: recent history (bounded), the new message, the conventions. */
export function renderChatPrompt(
  dataDir: string,
  input: { conversationId: string; history: ChatMessage[]; message: string; allowNetwork: boolean },
): string {
  const blocks: string[] = [];
  let total = 0;
  for (const m of [...input.history].reverse()) {
    const text = m.role === 'assistant' && m.content.length > ASSISTANT_CHARS ? `${m.content.slice(0, ASSISTANT_CHARS)}\n…（已截断）` : m.content;
    const block = `[${m.role === 'user' ? '用户' : '助手'} #${m.seq}]\n${text.trim() || (m.error ? `（本轮失败：${m.error}）` : '（空）')}`;
    if (total + block.length > HISTORY_CHARS) break;
    blocks.unshift(block);
    total += block.length;
  }
  const history = blocks.length ? blocks.join('\n\n') : '（这是对话的第一条消息）';
  const vars: Record<string, string> = {
    conversation: input.conversationId,
    history,
    message: input.message.trim(),
    notesDir: CHAT_NOTES_DIR,
    network: input.allowNetwork ? '允许（WebSearch / WebFetch 可用；外部来源写完整 URL，单一来源的断言用 suspected）' : '不允许（只用知识库与只读资料）',
  };
  return loadChatTurnPrompt(dataDir).replace(/\{(\w+)\}/g, (m, key: string) => vars[key] ?? m);
}
