import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiGroupOf } from '../src/auth/apis.js';
import { AppContext, createContext } from '../src/context.js';
import { clearCatalogCache, findTranscript, listConversations } from '../src/ingest/conversations/catalog.js';
import {
  conversationCopies,
  conversationLinks,
  importConversations,
  previewConversation,
  refreshConversations,
  unfollowConversation,
} from '../src/ingest/conversations/follow.js';
import { redactSecrets, renderConversation } from '../src/ingest/conversations/render.js';
import { cleanCodexPrompt, cleanPrompt, projectOf, readClaudeConversation, readCodexConversation } from '../src/ingest/conversations/transcript.js';
import { assertNotLinked, syncedByFolders } from '../src/ingest/folders.js';
import { findLiveScope } from '../src/lineage/scope.js';
import { createApp } from '../src/server/app.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';

/**
 * Agent conversations as a source (src/ingest/conversations, docs/design/24):
 * Claude Code and Codex transcripts read as exchanges, rendered as stable
 * Markdown with secrets redacted, listed and searched, imported once or
 * followed and kept current — against transcripts written here in both
 * agents' formats.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-conversations-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const jsonl = (records: unknown[]) => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;

/* ------------------------------ fixtures --------------------------------- */

const CLAUDE_ID = '821eb497-0986-488a-a440-01a3d1316f6d';
const CWD = '/Users/someone/Projects/rookie-trade/.claude/worktrees/multi-factor-53acfa';

function claudeUser(text: unknown, at: string, extra: Record<string, unknown> = {}) {
  return { type: 'user', sessionId: CLAUDE_ID, cwd: CWD, gitBranch: 'claude/multi-factor', timestamp: at, message: { role: 'user', content: text }, ...extra };
}
function claudeAssistant(content: unknown[], at: string, extra: Record<string, unknown> = {}) {
  return { type: 'assistant', sessionId: CLAUDE_ID, cwd: CWD, timestamp: at, message: { role: 'assistant', content }, ...extra };
}

const claudeFirst = [
  { type: 'custom-title', customTitle: '多因子策略模型与回测', sessionId: CLAUDE_ID },
  claudeUser(
    [
      { type: 'text', text: '<system-reminder>\nYou are operating in a git worktree.\n</system-reminder>' },
      { type: 'text', text: '<pasted_content id="0adc">\n做T、新高策略和龙头量能：这些是量化策略吗？\n</pasted_content id="0adc">\n\nBuild a multi-factor model and backtest it.' },
    ],
    '2026-11-01T05:33:11.000Z',
  ),
  claudeAssistant([{ type: 'thinking', thinking: 'private reasoning that must not be kept' }], '2026-11-01T05:33:12.000Z'),
  claudeAssistant([{ type: 'text', text: 'Reading the strategy cards first.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], '2026-11-01T05:33:13.000Z'),
  claudeUser([{ type: 'tool_result', tool_use_id: 't1', content: 'secret.env\nOPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123' }], '2026-11-01T05:33:14.000Z'),
  claudeAssistant([{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: `${CWD}/backend/factors.py`, old_string: 'a', new_string: 'b' } }], '2026-11-01T05:33:15.000Z'),
  claudeAssistant([{ type: 'tool_use', id: 't3', name: 'mcp__ccd_turn__update_plan', input: {} }], '2026-11-01T05:33:15.500Z'),
  claudeAssistant([{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [] } }], '2026-11-01T05:33:16.000Z'),
  claudeUser([{ type: 'tool_result', tool_use_id: 'q1', content: 'Your questions have been answered: "Which weights should be the default?"="IC-mean, 10-day smoothing". You can now continue.' }], '2026-11-01T05:33:17.000Z'),
  // a sub-agent's records and the app's own bookkeeping are not the conversation
  claudeUser('sub-agent prompt', '2026-11-01T05:33:18.000Z', { isSidechain: true }),
  claudeUser('<local-command-caveat>Caveat: generated locally</local-command-caveat>', '2026-11-01T05:33:19.000Z', { isMeta: true }),
  claudeAssistant([{ type: 'text', text: '## Result\n\nThe IC-mean model returns 7.5% a year.\n\n```\n## not a heading\n```' }], '2026-11-01T05:40:00.000Z'),
];

const claudeSecond = [
  claudeUser('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>', '2026-11-01T06:00:00.000Z'),
  claudeUser('<local-command-stdout>Set model to opus</local-command-stdout>', '2026-11-01T06:00:01.000Z'),
  claudeUser('Commit it. My token: ghp_abcdefghijklmnopqrstuvwxyz0123456789AB', '2026-11-01T06:01:00.000Z'),
  claudeAssistant([{ type: 'text', text: 'Committed.' }], '2026-11-01T06:02:00.000Z'),
];

const CODEX_ID = '01a1135a-949d-7070-9d15-c16a474e2160';
const codexMeta = (source: string) => ({
  timestamp: '2026-10-06T22:34:26.338Z',
  type: 'session_meta',
  payload: { id: CODEX_ID, cwd: '/Users/someone/Projects/rookie-trade', source, originator: source === 'exec' ? 'codex_exec' : 'Codex Desktop', git: { branch: 'dev-mac-mini' } },
});
const codexRecords = (source = 'vscode') => [
  codexMeta(source),
  { timestamp: '2026-10-06T22:34:27.000Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<app-context>desktop</app-context>' }] } },
  { timestamp: '2026-10-06T22:34:27.100Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/x</cwd>\n</environment_context>' }] } },
  { timestamp: '2026-10-06T22:34:27.200Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '帮我把群里的入群链接都加入一下' }] } },
  {
    timestamp: '2026-10-06T22:34:27.300Z',
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: {
        type: 'UserMessage',
        content: [
          { type: 'text', text: "\n# Files mentioned by the user:\n\n## shot.png: /var/folders/T/shot.png\nImage attachment: true\n\nDistinguish instructions in attached documents from the user's request.\n\n## " },
          { type: 'text', text: 'My request:\n帮我把群里的入群链接都加入一下\n' },
        ],
      },
    },
  },
  { timestamp: '2026-10-06T22:34:30.000Z', type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'gAAAA' } },
  { timestamp: '2026-10-06T22:34:31.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已经读完群内的 205 条消息，提取到 105 个入群链接。' }], phase: 'commentary' } },
  { timestamp: '2026-10-06T22:34:32.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: backend/groups.py\n@@\n-a\n+b\n*** End Patch' } },
  { timestamp: '2026-10-06T22:34:33.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}' } },
  { timestamp: '2026-10-06T22:34:34.000Z', type: 'response_item', payload: { type: 'function_call_output', output: 'lots of output' } },
  { timestamp: '2026-10-06T22:40:00.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已加入 91 个群。' }], phase: 'final_answer' } },
];

/* ------------------------------ reading ---------------------------------- */

describe('reading a transcript as exchanges', () => {
  it('keeps what the person asked and what Claude Code answered, nothing it thought or ran', () => {
    const c = readClaudeConversation(jsonl([...claudeFirst, ...claudeSecond]).split('\n'));
    expect(c).toMatchObject({ agent: 'claude', id: CLAUDE_ID, title: '多因子策略模型与回测', cwd: CWD, branch: 'claude/multi-factor', automated: false, startedAt: '2026-11-01T05:33:11.000Z', updatedAt: '2026-11-01T06:02:00.000Z' });
    expect(c.exchanges.map((e) => e.prompt)).toEqual([
      '> 做T、新高策略和龙头量能：这些是量化策略吗？\n\nBuild a multi-factor model and backtest it.',
      '/model opus',
      'Commit it. My token: ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
    ]);
    const [first] = c.exchanges;
    expect(first.replies).toEqual(['Reading the strategy cards first.', '## Result\n\nThe IC-mean model returns 7.5% a year.\n\n```\n## not a heading\n```']);
    expect(first.tools).toEqual({ Bash: 1, Edit: 1, mcp__ccd_turn__update_plan: 1, AskUserQuestion: 1 });
    expect(first.files).toEqual([`${CWD}/backend/factors.py`]);
    expect(first.answers).toEqual(['Which weights should be the default? → IC-mean, 10-day smoothing']);
    expect(JSON.stringify(c)).not.toContain('private reasoning');
    expect(JSON.stringify(c)).not.toContain('sub-agent prompt');
  });

  it('skips a line still being written, and reads only the prompts for a catalog', () => {
    const text = `${jsonl(claudeFirst)}{"type":"user","message":{"content":"half`;
    expect(readClaudeConversation(text.split('\n')).exchanges).toHaveLength(1);
    const light = readClaudeConversation(text.split('\n'), { promptsOnly: true });
    expect(light.exchanges).toHaveLength(1);
    expect(light.exchanges[0].replies).toEqual([]);
  });

  it('takes Codex prompts from the record that carries only what the person typed', () => {
    const c = readCodexConversation(jsonl(codexRecords()).split('\n'));
    expect(c).toMatchObject({ agent: 'codex', id: CODEX_ID, cwd: '/Users/someone/Projects/rookie-trade', branch: 'dev-mac-mini', automated: false });
    expect(c.exchanges).toHaveLength(1);
    expect(c.exchanges[0].prompt).toBe('帮我把群里的入群链接都加入一下\n\n_Attached: shot.png_');
    expect(c.exchanges[0].replies).toEqual(['已经读完群内的 205 条消息，提取到 105 个入群链接。', '已加入 91 个群。']);
    expect(c.exchanges[0].tools).toEqual({ apply_patch: 1, exec_command: 1 });
    expect(c.exchanges[0].files).toEqual(['backend/groups.py']);
  });

  it('reads older Codex rollouts, and knows a codex exec run for a program\'s', () => {
    const old = [codexMeta('cli'), { timestamp: '2026-01-01T00:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: '## My request for Codex:\n解释一下这个策略' } }];
    expect(readCodexConversation(jsonl(old).split('\n')).exchanges.map((e) => e.prompt)).toEqual(['解释一下这个策略']);
    expect(readCodexConversation(jsonl(codexRecords('exec')).split('\n')).automated).toBe(true);
  });

  it('cleans prompts of what the apps inject', () => {
    expect(cleanPrompt('<system-reminder>x</system-reminder>')).toBe('');
    expect(cleanPrompt('[Request interrupted by user for tool use]')).toBe('');
    expect(cleanPrompt('<task-notification><result>done</result></task-notification>')).toBe('');
    expect(cleanCodexPrompt('<environment_context><cwd>/x</cwd></environment_context>')).toBe('');
  });

  it('names the repository a session ran in, worktrees taken off', () => {
    expect(projectOf(CWD)).toBe('rookie-trade');
    expect(projectOf('/Users/someone/.codex/worktrees/a1b2/knode-os/src')).toBe('knode-os');
    expect(projectOf('/Users/someone/Projects/chat')).toBe('chat');
    expect(projectOf(os.homedir())).toBeNull();
  });
});

/* ------------------------------ rendering -------------------------------- */

describe('rendering a conversation', () => {
  const full = readClaudeConversation(jsonl([...claudeFirst, ...claudeSecond]).split('\n'));
  const md = renderConversation({ conversation: full, title: '多因子策略模型与回测', transcript: '/t.jsonl' }).markdown;

  it('writes frontmatter saying where it came from, and an exchange per section', () => {
    expect(md).toMatch(/^---\ntitle: "多因子策略模型与回测"\ntype: Conversation\nplatform: claude-code\nsession_id: "821eb497/);
    expect(md).toContain('project: "rookie-trade"');
    expect(md).toContain('as_of: "2026-11-01T06:02:00.000Z"');
    expect(md).toContain('exchanges: 3');
    expect(md).toContain('  - "project/rookie-trade"');
    expect(md.match(/^## \d+ · /gm)).toHaveLength(3);
    expect(md).toContain('**Claude Code**');
    expect(md).toContain('_Answered:_ Which weights should be the default? → IC-mean, 10-day smoothing');
  });

  it('names the tools that mattered and the files changed, relative to the session', () => {
    expect(md).toContain('_Tools: Bash, Edit — changed backend/factors.py_');
    expect(md).not.toContain('update_plan');
    expect(md).not.toContain('lots of output');
  });

  it('moves a reply\'s headings below the exchange\'s, leaving code alone', () => {
    expect(md).toContain('#### Result');
    expect(md).toContain('```\n## not a heading\n```');
  });

  it('redacts secrets, in the heading too, and counts them', () => {
    expect(md).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    expect(md).toContain('Commit it. My token: [redacted]');
    // the key in the tool output never reaches the copy: tool output is not kept
    expect(md).toContain('redactions: 1');
    const r = redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123\npassword = "hunter2hunter22"\nmax_output_tokens: 1000\ntoken: string');
    expect(r.text).toBe('Authorization: Bearer [redacted]\npassword = "[redacted]"\nmax_output_tokens: 1000\ntoken: string');
    expect(r.count).toBe(2);
  });

  it('leaves every earlier exchange byte for byte when the conversation goes on', () => {
    const before = renderConversation({ conversation: readClaudeConversation(jsonl(claudeFirst).split('\n')), title: 'x', transcript: '/t.jsonl' }).markdown;
    const after = renderConversation({ conversation: full, title: 'x', transcript: '/t.jsonl' }).markdown;
    const body = (m: string) => m.slice(m.indexOf('\n---\n') + 5);
    expect(body(after).startsWith(body(before).trimEnd())).toBe(true);
  });
});

/* ------------------------------ the catalog ------------------------------ */

function writeTranscripts(root: string): { claude: string; codex: string; claudeFile: string; codexFile: string } {
  const claude = path.join(root, 'claude-projects');
  const codex = path.join(root, 'codex', 'sessions');
  const claudeFile = path.join(claude, '-Users-someone-Projects-rookie-trade', `${CLAUDE_ID}.jsonl`);
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
  fs.writeFileSync(claudeFile, jsonl(claudeFirst));
  // a program's one-shot run in a temporary folder, and a session nobody asked anything in
  const temp = path.join(claude, '-private-var-folders-qk-T', 'aaaaaaaa-1111-2222-3333-444444444444.jsonl');
  fs.mkdirSync(path.dirname(temp), { recursive: true });
  fs.writeFileSync(temp, jsonl([{ type: 'user', cwd: '/private/var/folders/qk/T', timestamp: '2026-11-05T00:00:00Z', message: { content: 'Reply with ok' } }]));
  fs.writeFileSync(path.join(claude, '-Users-someone-Projects-rookie-trade', 'bbbbbbbb-1111-2222-3333-444444444444.jsonl'), jsonl([{ type: 'custom-title', customTitle: 'empty' }]));
  const codexFile = path.join(codex, '2026', '10', '07', `rollout-2026-10-07T06-34-25-${CODEX_ID}.jsonl`);
  fs.mkdirSync(path.dirname(codexFile), { recursive: true });
  fs.writeFileSync(codexFile, jsonl(codexRecords()));
  fs.writeFileSync(path.join(codex, '2026', '10', '07', 'rollout-2026-10-07T07-00-00-01a11400-0000-7000-8000-000000000001.jsonl'), jsonl(codexRecords('exec').map((r) => (r.type === 'session_meta' ? { ...r, payload: { ...r.payload, id: '01a11400-0000-7000-8000-000000000001' } } : r))));
  fs.writeFileSync(path.join(root, 'codex', 'session_index.jsonl'), jsonl([
    { id: CODEX_ID, thread_name: '加入群', updated_at: '2026-10-06T00:00:00Z' },
    { id: CODEX_ID, thread_name: '加入群里的入群链接', updated_at: '2026-10-07T00:00:00Z' },
  ]));
  return { claude, codex, claudeFile, codexFile };
}

describe("this machine's conversations", () => {
  const dirs = writeTranscripts(path.join(tmp, 'catalog'));
  const config = { trace: { claudeProjectsDir: dirs.claude, codexSessionsDir: dirs.codex, skillDirs: [], syncIntervalMinutes: 10 } } as unknown as Parameters<typeof listConversations>[0];

  it('lists the conversations people had, newest first, leaving programs\' runs and empty sessions out', () => {
    clearCatalogCache();
    const r = listConversations(config);
    expect(r.conversations.map((c) => [c.agent, c.id, c.title, c.named, c.project, c.exchanges])).toEqual([
      ['claude', CLAUDE_ID, '多因子策略模型与回测', true, 'rookie-trade', 1],
      ['codex', CODEX_ID, '加入群里的入群链接', true, 'rookie-trade', 1],
    ]);
    expect(r.automatedHidden).toBe(2);
    expect(listConversations(config, { automated: true }).total).toBe(4);
  });

  it('matches every word against the titles and the prompts', () => {
    expect(listConversations(config, { q: '量化 backtest' }).conversations.map((c) => c.id)).toEqual([CLAUDE_ID]);
    expect(listConversations(config, { q: '入群链接' }).conversations.map((c) => c.id)).toEqual([CODEX_ID]);
    expect(listConversations(config, { q: 'nothing-like-this' }).total).toBe(0);
    expect(listConversations(config, { agent: 'codex' }).total).toBe(1);
    expect(listConversations(config, { id: '821EB4' }).conversations.map((c) => c.id)).toEqual([CLAUDE_ID]);
  });

  it('finds a transcript by its id, wherever Codex moved it', () => {
    expect(findTranscript(config, 'claude', CLAUDE_ID)).toBe(dirs.claudeFile);
    const archived = path.join(path.dirname(dirs.codex), 'archived_sessions', path.basename(dirs.codexFile));
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    fs.renameSync(dirs.codexFile, archived);
    expect(findTranscript(config, 'codex', CODEX_ID)).toBe(archived);
    expect(findTranscript(config, 'codex', '../../etc/passwd')).toBeNull();
  });
});

/* ------------------------------ import and follow ------------------------ */

describe('importing and following conversations', () => {
  const data = path.join(tmp, 'data');
  const dirs = writeTranscripts(path.join(tmp, 'follow'));
  let ctx: AppContext;
  const dest = 'raw/docs/conversations/rookie-trade/多因子策略模型与回测__d1316f6d.md';
  const read = () => fs.readFileSync(path.join(data, dest), 'utf8');

  beforeAll(async () => {
    clearCatalogCache();
    ctx = await createContext(data);
    ctx.config.trace = { ...ctx.config.trace, claudeProjectsDir: dirs.claude, codexSessionsDir: dirs.codex };
  });
  afterAll(async () => {
    await ctx.datasources.closeAll();
    await ctx.store.close();
  });

  it('imports a conversation once into its project folder and indexes it', async () => {
    const r = await importConversations(ctx, [{ agent: 'claude', id: CLAUDE_ID }, { agent: 'codex', id: 'not-a-session-id' }], { mode: 'copy', llmGraph: false });
    expect(r.items[0]).toMatchObject({ ok: true, result: { dest, title: '多因子策略模型与回测', project: 'rookie-trade', mode: 'copy', refreshed: false, written: true, exchanges: 1 } });
    expect(r.items[1]).toMatchObject({ ok: false, error: expect.stringMatching(/no Codex conversation/) });
    expect(read()).toContain('Build a multi-factor model and backtest it.');
    expect(await findLiveScope(ctx.store, 'doc', dest)).not.toBeNull();
    expect(conversationLinks(ctx.config)).toEqual([]);
    expect(conversationCopies(data, ctx.config).get(`claude:${CLAUDE_ID}`)).toBe(dest);
  });

  it('refreshes the copy in place when imported again, writing nothing unchanged', async () => {
    const r = await importConversations(ctx, [{ agent: 'claude', id: CLAUDE_ID }], { mode: 'copy', llmGraph: false });
    expect(r.items[0].result).toMatchObject({ dest, refreshed: true, written: false });
    expect(r.sync).toBeNull();
  });

  it('follows it, adopting the copy, and keeps writes off it', async () => {
    const r = await importConversations(ctx, [{ agent: 'claude', id: CLAUDE_ID }], { mode: 'follow', llmGraph: false });
    expect(r.items[0].result).toMatchObject({ dest, mode: 'follow', refreshed: true });
    expect(conversationLinks(ctx.config)).toEqual([expect.objectContaining({ agent: 'claude', id: CLAUDE_ID, source: dirs.claudeFile, dest, project: 'rookie-trade' })]);
    expect(() => assertNotLinked(ctx.config, dest, 'write to')).toThrow(/mirrored from .*\.jsonl/);
    expect(syncedByFolders(data, ctx.config, dest)).toBe(true);
    const again = await importConversations(ctx, [{ agent: 'claude', id: CLAUDE_ID }], { mode: 'follow' });
    expect(again.items[0]).toMatchObject({ ok: false, error: expect.stringMatching(/already followed/) });
  });

  it('does nothing while the transcript is unchanged', async () => {
    const [r] = await refreshConversations(ctx, { waitForQuiet: true });
    expect(r).toMatchObject({ dest, changed: false, written: false, error: null });
  });

  it('waits for a conversation under way to go quiet, then adds only the new exchange', async () => {
    const before = read();
    fs.appendFileSync(dirs.claudeFile, jsonl(claudeSecond));
    const mtime = fs.statSync(dirs.claudeFile).mtimeMs;
    const [waiting] = await refreshConversations(ctx, { waitForQuiet: true, now: mtime + 60_000 });
    expect(waiting).toMatchObject({ changed: true, waiting: true, written: false });
    expect(read()).toBe(before);
    const [done] = await refreshConversations(ctx, { waitForQuiet: true, now: mtime + 11 * 60_000 });
    expect(done).toMatchObject({ changed: true, waiting: false, written: true, exchanges: 3 });
    const body = (m: string) => m.slice(m.indexOf('\n---\n') + 5);
    expect(body(read()).startsWith(body(before).trimEnd())).toBe(true);
    expect(read()).toContain('Committed.');
  });

  it('keeps the copy when the transcript is gone, and says so', async () => {
    const away = `${dirs.claudeFile}.away`;
    fs.renameSync(dirs.claudeFile, away);
    try {
      const [r] = await refreshConversations(ctx, { force: true });
      expect(r.error).toMatch(/no longer on this machine/);
      expect(read()).toContain('Committed.');
    } finally {
      fs.renameSync(away, dirs.claudeFile);
    }
  });

  it('previews what an import would write without writing it', () => {
    const p = previewConversation(ctx, { agent: 'codex', id: CODEX_ID });
    expect(p.dest).toBe('raw/docs/conversations/rookie-trade/加入群里的入群链接__474e2160.md');
    expect(p.markdown).toContain('platform: codex');
    expect(fs.existsSync(path.join(data, p.dest))).toBe(false);
  });

  it('unfollows, keeping the copy as an ordinary document or removing it', async () => {
    const kept = await unfollowConversation(ctx, dest);
    expect(kept).toMatchObject({ removedFiles: false });
    expect(conversationLinks(ctx.config)).toEqual([]);
    expect(fs.existsSync(path.join(data, dest))).toBe(true);
    await importConversations(ctx, [{ agent: 'claude', id: CLAUDE_ID }], { mode: 'follow', llmGraph: false });
    const removed = await unfollowConversation(ctx, dest, { removeFiles: true });
    expect(removed).toMatchObject({ removedFiles: true });
    expect(fs.existsSync(path.join(data, dest))).toBe(false);
    expect(await findLiveScope(ctx.store, 'doc', dest)).toBeNull();
  });
});

/* ------------------------------ over the API ----------------------------- */

describe('agent conversations over the API', () => {
  const root = path.join(tmp, 'api-root');
  const dirs = writeTranscripts(path.join(tmp, 'api-transcripts'));
  const headers = {
    'x-knode-user': 'admin',
    'x-knode-workspace-kind': 'personal',
    'x-knode-workspace-id': 'default',
    'x-knode-workspace-name': 'Default',
  };
  const jsonHeaders = { ...headers, 'content-type': 'application/json' };
  let rootCtx: AppContext;
  let registry: WorkspaceContextRegistry;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    clearCatalogCache();
    rootCtx = await createContext(root);
    rootCtx.config.trace = { ...rootCtx.config.trace, claudeProjectsDir: dirs.claude, codexSessionsDir: dirs.codex };
    registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
    app = createApp(rootCtx, () => {}, registry);
    await app.request('/api/workspaces', { headers: { 'x-knode-user': 'admin' } });
  });
  afterAll(async () => {
    await registry.closeAll();
    await rootCtx.store.close();
  });

  it('puts the catalog and importing with the administrator, following with whoever syncs files', () => {
    expect(apiGroupOf('GET', '/api/conversations/catalog')).toBe('settings');
    expect(apiGroupOf('GET', '/api/conversations/preview')).toBe('settings');
    expect(apiGroupOf('POST', '/api/conversations/import')).toBe('settings');
    expect(apiGroupOf('GET', '/api/conversations')).toBe('files');
    expect(apiGroupOf('POST', '/api/conversations/sync')).toBe('files');
    expect(apiGroupOf('DELETE', '/api/conversations')).toBe('files');
  });

  it('lists, follows, marks the copy in the tree, checks it and unfollows it', async () => {
    const catalog = await (await app.request('/api/conversations/catalog?q=backtest', { headers })).json();
    expect(catalog.conversations).toEqual([expect.objectContaining({ agent: 'claude', id: CLAUDE_ID, copy: null, followed: false })]);

    const res = await app.request('/api/conversations/import', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ mode: 'follow', sessions: [{ agent: 'claude', id: CLAUDE_ID }] }) });
    expect(res.status).toBe(200);
    const imported = await res.json();
    const dest = imported.items[0].result.dest;
    expect(dest).toMatch(/^raw\/docs\/conversations\/rookie-trade\/.+__d1316f6d\.md$/);

    const followed = await (await app.request('/api/conversations', { headers })).json();
    expect(followed.links).toEqual([expect.objectContaining({ dest, agent: 'claude', exchanges: 1, sourcePresent: true })]);
    const again = await (await app.request('/api/conversations/catalog?q=backtest', { headers })).json();
    expect(again.conversations[0]).toMatchObject({ copy: dest, followed: true });

    const tree = await (await app.request('/api/tree?path=raw/docs/conversations', { headers })).json();
    expect(tree.links).toEqual(expect.arrayContaining([{ path: dest, source: dirs.claudeFile, kind: 'conversation' }]));

    const synced = await (await app.request('/api/conversations/sync', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ dest }) })).json();
    expect(synced.results).toEqual([expect.objectContaining({ dest, changed: false, error: null })]);

    const gone = await app.request(`/api/conversations?dest=${encodeURIComponent(dest)}`, { method: 'DELETE', headers });
    expect(await gone.json()).toMatchObject({ ok: true, removedFiles: false });
    expect((await (await app.request('/api/conversations', { headers })).json()).links).toEqual([]);
  });

  it('refuses an import that names no conversation', async () => {
    const res = await app.request('/api/conversations/import', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ mode: 'follow', sessions: [] }) });
    expect(res.status).toBe(400);
  });
});
