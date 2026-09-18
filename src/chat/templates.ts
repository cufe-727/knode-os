import fs from 'node:fs';
import path from 'node:path';
import { CHAT_DIR } from '../fs/layout.js';

/**
 * What the chat agent is told, as playbooks under playbooks/chat/ — edited
 * like the research templates:
 *
 *   AGENTS.md   the protocol (identity, how to answer, how to learn, limits);
 *               also the schema file of every chat workspace, together with
 *               the base's own guide
 *   turn.md     the per-turn prompt: recent history, the new message, the
 *               writing conventions
 */

export const CHAT_PROTOCOL_FILE = 'AGENTS.md';
export const CHAT_TURN_FILE = 'turn.md';
/** Where a taught fact lands: a quarantined note the person can promote. */
export const CHAT_NOTES_DIR = 'raw/docs/notes';
/** Marker an assistant reply ends with for every file it wrote. */
export const WROTE_MARKER = /<!--\s*knode:wrote\s+([^\s>]+)\s*-->/g;

export const CHAT_PROTOCOL = `# knode-os 对话协议

你是这个本地知识库（knode-os）的助手。知识库通过名为 \`knode-os\` 的 MCP 服务器暴露给你；\`raw/docs\`、\`wiki\`、\`.sidecar\` 以只读方式挂载。用户在和你聊天：问问题、纠正你、或者把新知识教给你。

## 先读什么

- 本文件末尾的「知识库自述」：AGENTS.md 指南（这个库有什么、怎么命名、哪类问题先调哪个工具）、purpose.md、schema.md；不熟悉时再 \`knode_survey\` 看当前数字。
- 对话历史只保留最近几轮。需要更早的事实就重新查知识库，不要凭记忆。

## 回答问题

1. 先 \`knode_resolve\`（query 用用户原话），看 facts / documents / unknowns；简单问题直接 \`knode_search\`（mode=sag）或 \`knode_claims\`（subject 传实体名，order=timeline）。
2. 每条事实标来源：\`（来源：raw/docs/…）\`，引用 wiki 页用 \`[[页面名]]\`；知识库里没有的就明说"知识库里没有"，不要编。
3. 日期用 ISO，并说明"截至 <最新资料日期>"；数字与口径以来源为准。
4. 结尾 \`knode_feedback\`（receipt_id 来自 knode_resolve；used_ids 填真正用到的 id；outcome 写 answered / partial）。

## 学习新知识（用户告诉你事实、纠正错误、贴一段资料）

1. 先复述你理解的内容并确认关键值（主体、数字、日期）；不确定就先问，确认后再写。
2. 用 \`knode_write\` 写一篇笔记：\`raw/docs/notes/<YYYY-MM-DD>-<slug>.md\`，frontmatter：
   \`title\`、\`date\`、\`actor: agent/<cli>\`、\`source: chat/<对话 id>\`、\`entities: [{ name, type, aliases }]\`、\`relations\`（本体谓词 id）、\`claims: [{ subject, statement, type, status: fact | suspected, eventDate }]\`；正文写用户的原话和你的整理。
3. 然后 \`knode_sync\`（only: [那条路径]）让它进入索引；告诉用户这条笔记处于 quarantined（隔离）状态，需要在界面里采纳（promote）才会覆盖已有事实；与已有事实冲突时会自动开 dispute。
4. 不改写 raw/docs 里已有的文件；不直接改 wiki 页——要改页面请建议用户发起研究任务（\`knode_research\`）。

## 禁止

- 不运行 shell；不访问互联网，除非本轮提示写明允许。
- 不在约定路径之外新建文件；不编造来源、数字、日期。
`;

export const CHAT_TURN = `<!-- knode-phase: chat -->
# 对话 {conversation}

下面是这段对话最近的历史（更早的内容已省略；需要更早的事实就重新查知识库，不要凭记忆）：

{history}

## 本轮消息

{message}

## 写入约定

- 只有用户明确让你记住 / 纠正 / 学习时才写入；路径 \`{notesDir}/<YYYY-MM-DD>-<slug>.md\`，frontmatter 里 \`source: chat/{conversation}\`，写完 \`knode_sync\`（only: [该路径]）。
- 回复末尾单独一行列出你写入的每个文件：\`<!-- knode:wrote <路径> -->\`；没有写入就不要写这一行。
- 回复用 Markdown，语言跟随用户；每条事实带来源（路径或 [[页面名]]）。
- 联网：{network}
`;

/** Seed the chat playbooks once (never overwrites edits). */
export function ensureDefaultChatPlaybooks(dataDir: string): string[] {
  const created: string[] = [];
  const dir = path.join(dataDir, CHAT_DIR);
  for (const [name, text] of [[CHAT_PROTOCOL_FILE, CHAT_PROTOCOL], [CHAT_TURN_FILE, CHAT_TURN]] as const) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, text);
    created.push(`${CHAT_DIR}/${name}`);
  }
  return created;
}

export function loadChatProtocol(dataDir: string): string {
  ensureDefaultChatPlaybooks(dataDir);
  return fs.readFileSync(path.join(dataDir, CHAT_DIR, CHAT_PROTOCOL_FILE), 'utf8');
}

export function saveChatProtocol(dataDir: string, text: string): string {
  const dir = path.join(dataDir, CHAT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, CHAT_PROTOCOL_FILE), text.endsWith('\n') ? text : `${text}\n`);
  return `${CHAT_DIR}/${CHAT_PROTOCOL_FILE}`;
}

export function loadChatTurnPrompt(dataDir: string): string {
  ensureDefaultChatPlaybooks(dataDir);
  const file = path.join(dataDir, CHAT_DIR, CHAT_TURN_FILE);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : CHAT_TURN;
}

/** Paths the reply claims to have written (`<!-- knode:wrote … -->` markers). */
export function writtenPaths(reply: string): string[] {
  const out: string[] = [];
  for (const m of reply.matchAll(WROTE_MARKER)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}
