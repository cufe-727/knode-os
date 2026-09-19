import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { sync } from '../src/ingest/sync.js';
import { chatWebAllowed, parseActivity, resolveChatAgent, runChatTurn } from '../src/chat/runner.js';
import { createConversation, getConversation, recentMessages, resetRunningConversations, setConversationStatus } from '../src/chat/store.js';
import { writtenPaths } from '../src/chat/templates.js';
import { createApp } from '../src/server/app.js';
import { MCP_TOKEN_FILE } from '../src/server/mcp-http.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';
import { queryClaims } from '../src/store/claims.js';
import { pruneRuns } from '../src/research/workspace.js';

/**
 * The chat entry: a conversation's turns run the (fake) CLI in the
 * conversation's workspace with recent history replayed; the reply lands as
 * an assistant message with the tool activity parsed from the transcript;
 * a taught fact becomes a quarantined note; a running turn can be cancelled.
 */

const helpers = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers');
const fakeClaude = path.join(helpers, 'fake-claude.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-chat-'));
const root = path.join(tmp, 'data');
const wsDir = path.join(root, 'users', 'admin', 'workspaces', 'default');
const scope = { user: 'admin', kind: 'personal' as const, id: 'default', name: 'Default', slug: 'default', relativeDir: 'users/admin/workspaces/default' };
const headers = { 'x-knode-user': 'admin', 'x-knode-workspace-kind': 'personal', 'x-knode-workspace-id': 'default', 'x-knode-workspace-name': 'Default' };

let rootCtx: AppContext;
let registry: WorkspaceContextRegistry;
let ctx: AppContext;
let app: ReturnType<typeof createApp>;
let httpServer: Server;
let mcp: { url: string; token: string; headers: Record<string, string> };
const agent = { kind: 'cli' as const, provider: 'claude-cli' as const, cliPath: fakeClaude, model: '' };
const tracked: Promise<unknown>[] = [];

const api = (p: string, init: RequestInit = {}) => app.request(p, { ...init, headers: { 'content-type': 'application/json', ...headers, ...(init.headers as Record<string, string> | undefined) } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function untilIdle(id: string, maxMs = 30_000): Promise<{ status: string; activity: { tool: string }[] }> {
  const t0 = Date.now();
  let last: { status: string; activity: { tool: string }[] } = { status: 'running', activity: [] };
  while (Date.now() - t0 < maxMs) {
    last = await (await api(`/api/chat/conversations/${id}/status`)).json() as typeof last;
    if (last.status === 'idle') return last;
    await sleep(100);
  }
  return last;
}

beforeAll(async () => {
  rootCtx = await createContext(root);
  registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
  app = createApp(rootCtx, () => {}, registry, {
    services: () => ({ mcp: () => mcp ?? null, kickResearch: () => {}, track: <T>(p: Promise<T>) => { tracked.push(p); return p; } }),
  });
  await app.request('/api/workspaces', { headers: { 'x-knode-user': 'admin' } });
  ctx = await registry.get(scope);
  ctx.config.connections = [{ id: 'fake', label: 'Fake CLI', provider: 'claude-cli', baseUrl: '', apiKey: '', model: '', cliPath: fakeClaude, cliTimeoutMs: 300_000 }];
  ctx.config.chat.agent = 'fake';
  const token = fs.readFileSync(path.join(root, MCP_TOKEN_FILE), 'utf8').trim();
  await new Promise<void>((resolve) => {
    httpServer = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      mcp = { url: `http://127.0.0.1:${info.port}/mcp`, token, headers };
      resolve();
    }) as Server;
  });
  const abs = path.join(wsDir, 'raw', 'docs', 'trusted.md');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `---
title: 宁德时代 2025 年报摘要
date: 2026-03-30
entities:
  - { name: 宁德时代, type: organization, aliases: ["CATL", "300750"] }
claims:
  - { subject: 宁德时代, type: revenue, statement: 2025 年营业收入 4000 亿元, eventDate: "2025" }
---
宁德时代 2025 年营业收入 4000 亿元。
`);
  await sync(ctx, { llmGraph: false });
}, 60_000);

afterAll(async () => {
  await Promise.allSettled(tracked);
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await registry.closeAll();
  await rootCtx.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('chat', () => {
  it('resolves the chat agent from config and gates web access on review.external', () => {
    expect(resolveChatAgent(ctx.config)).toEqual({ kind: 'cli', provider: 'claude-cli', cliPath: fakeClaude, model: '' });
    expect(resolveChatAgent({ ...ctx.config, chat: { ...ctx.config.chat, agent: '', model: 'm' }, research: { ...ctx.config.research, agent: 'fake' } })).toMatchObject({ provider: 'claude-cli', model: 'm' });
    expect(chatWebAllowed(ctx.config)).toBe(false); // verify + inherit
    expect(chatWebAllowed({ ...ctx.config, review: { ...ctx.config.review, external: 'research' } })).toBe(true);
    expect(chatWebAllowed({ ...ctx.config, chat: { ...ctx.config.chat, web: 'on' } })).toBe(true);
    expect(chatWebAllowed({ ...ctx.config, chat: { ...ctx.config.chat, web: 'on' }, review: { ...ctx.config.review, external: 'off' } })).toBe(false);
  });

  it('answers a question over HTTP: 202, polled status, the reply with its tool activity', async () => {
    process.env.FAKE_AGENT_MODE = 'good';
    const created = await api('/api/chat/conversations', { method: 'POST', body: JSON.stringify({}) });
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };
    const sent = await api(`/api/chat/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ text: '宁德时代 2025 年营收是多少？' }) });
    expect(sent.status).toBe(202);
    expect(await sent.json()).toMatchObject({ ok: true, seq: 2, status: 'running' });
    const empty = await api(`/api/chat/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ text: '  ' }) });
    expect(empty.status).toBe(400);
    const status = await untilIdle(id);
    expect(status.status).toBe('idle');
    const conv = await (await api(`/api/chat/conversations/${id}`)).json() as { title: string; status: string; messages: { role: string; content: string; events: { tool: string; ok?: boolean }[]; turns: number | null }[] };
    expect(conv.status).toBe('idle');
    expect(conv.title).toBe('宁德时代 2025 年营收是多少？');
    expect(conv.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const reply = conv.messages[1];
    expect(reply.content).toContain('关于「宁德时代 2025 年营收是多少？」');
    expect(reply.content).toContain('raw/docs/trusted.md');
    expect(reply.events[0]).toMatchObject({ tool: 'knode_search', ok: true });
    expect(reply.turns).toBeGreaterThanOrEqual(2);
    const argv = JSON.parse(fs.readFileSync(path.join(wsDir, '.runs', 'chat', id, 'argv-chat.json'), 'utf8')) as string[];
    expect(argv).toContain('--no-session-persistence');
    expect(argv).toContain('mcp__knode-os__*');
    expect(argv).not.toContain('--resume');
    expect(fs.readFileSync(path.join(wsDir, '.runs', 'chat', id, 'CLAUDE.md'), 'utf8')).toContain('# knode-os 对话协议');
    const list = await (await api('/api/chat/conversations')).json() as { id: string }[];
    expect(list.map((c) => c.id)).toContain(id);
  }, 60_000);

  /**
   * The gate a machine with nothing configured hits. This used to be one
   * assertion inside the quick-mode test; quick mode is gone, and the gate it
   * happened to exercise is now the only thing standing between a typed
   * question and a confusing silence, so it gets a test of its own.
   */
  it('refuses a turn when nothing can run it, and says which', async () => {
    const savedChat = ctx.config.chat.agent;
    const savedResearch = ctx.config.research.agent;
    ctx.config.chat.agent = '';
    ctx.config.research.agent = '';
    try {
      // the default connection is OpenAI-compatible with no model, so the
      // last-resort arm cannot resolve it either
      expect(ctx.config.llm.provider).toBe('openai');
      expect(ctx.config.llm.model).toBe('');
      expect(resolveChatAgent(ctx.config)).toBeNull();

      const ready = await (await api('/api/chat/readiness')).json() as { ready: boolean; reason?: string; hint?: string };
      expect(ready).toMatchObject({ ready: false, reason: 'no-agent' });
      expect(ready.hint).toContain('Providers & Agents');

      const { id } = await (await api('/api/chat/conversations', { method: 'POST', body: JSON.stringify({}) })).json() as { id: string };
      const refused = await api(`/api/chat/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ text: '宁德时代 2025 年营收是多少？' }) });
      expect(refused.status).toBe(503);
      expect(await refused.json()).toMatchObject({ reason: 'no-agent' });
    } finally {
      ctx.config.chat.agent = savedChat;
      ctx.config.research.agent = savedResearch;
    }
  });

  it('falls back to the default connection when nothing names an agent', async () => {
    const savedChat = ctx.config.chat.agent;
    const savedResearch = ctx.config.research.agent;
    const savedLlm = ctx.config.llm;
    ctx.config.chat.agent = '';
    ctx.config.research.agent = '';
    ctx.config.llm = { ...savedLlm, provider: 'claude-cli', cliPath: fakeClaude };
    try {
      expect(resolveChatAgent(ctx.config)).toEqual({ kind: 'cli', provider: 'claude-cli', cliPath: fakeClaude, model: '' });
      expect(await (await api('/api/chat/readiness')).json()).toMatchObject({ ready: true, provider: 'claude-cli' });
    } finally {
      ctx.config.chat.agent = savedChat;
      ctx.config.research.agent = savedResearch;
      ctx.config.llm = savedLlm;
    }
  });

  it('replays recent history into the next turn, bounded by chat.historyTurns', async () => {
    const conversation = await createConversation(ctx.store, { createdBy: 'test' });
    process.env.FAKE_AGENT_MODE = 'good';
    await runChatTurn(ctx, conversation.id, '第一个问题：宁德时代是做什么的？', { mcp, agent });
    await runChatTurn(ctx, conversation.id, '第二个问题：营收多少？', { mcp, agent });
    const dir = path.join(wsDir, '.runs', 'chat', conversation.id);
    const second = fs.readFileSync(path.join(dir, 'prompt-turn-4.md'), 'utf8');
    expect(second).toContain('[用户 #1]\n第一个问题：宁德时代是做什么的？');
    expect(second).toContain('[助手 #2]');
    expect(second).toContain('## 本轮消息\n\n第二个问题：营收多少？');
    expect(second).toContain(`source: chat/${conversation.id}`);
    ctx.config.chat.historyTurns = 1;
    await runChatTurn(ctx, conversation.id, '第三个问题', { mcp, agent });
    const third = fs.readFileSync(path.join(dir, 'prompt-turn-6.md'), 'utf8');
    expect(third).not.toContain('第一个问题');
    expect(third).toContain('[助手 #4]');
    ctx.config.chat.historyTurns = 12;
    expect((await recentMessages(ctx.store, conversation.id, 100)).length).toBe(6);
  }, 90_000);

  it('files what it is taught as a quarantined note the person can promote', async () => {
    const conversation = await createConversation(ctx.store, { createdBy: 'test' });
    process.env.FAKE_AGENT_MODE = 'teach';
    const res = await runChatTurn(ctx, conversation.id, '记住：宁德时代 2026 年营业收入 5000 亿元', { mcp, agent });
    process.env.FAKE_AGENT_MODE = 'good';
    expect(res.message.error).toBeNull();
    const wrote = res.message.events.find((e) => e.tool === 'wrote');
    expect(wrote?.path).toMatch(/^raw\/docs\/notes\/\d{4}-\d{2}-\d{2}-chat-c_[0-9a-f]+\.md$/);
    expect(res.message.events.map((e) => e.tool)).toEqual(['knode_search', 'knode_write', 'knode_sync', 'wrote']);
    expect(fs.existsSync(path.join(wsDir, wrote!.path!))).toBe(true);
    const [scopeRow] = await ctx.store.query<{ trust: string }>(`SELECT trust FROM scopes WHERE key = $1 AND status = 'active'`, [wrote!.path]);
    expect(scopeRow.trust).toBe('quarantined');
    const claims = await queryClaims(ctx.store, { subject: '宁德时代', types: ['revenue'] });
    expect(claims.claims.map((c) => c.statement)).toContain('2026 年营业收入 5000 亿元');
    const promoted = await api('/api/trust', { method: 'POST', body: JSON.stringify({ path: wrote!.path, to: 'trusted' }) });
    expect(promoted.status).toBe(200);
    const [after] = await ctx.store.query<{ trust: string }>(`SELECT trust FROM scopes WHERE key = $1 AND status = 'active'`, [wrote!.path]);
    expect(after.trust).toBe('trusted');
    expect(writtenPaths('x\n<!-- knode:wrote a.md -->\n<!-- knode:wrote a.md --><!-- knode:wrote b.md -->')).toEqual(['a.md', 'b.md']);
  }, 60_000);

  it('refuses a second message while answering, and a cancel ends the turn as cancelled', async () => {
    const created = await api('/api/chat/conversations', { method: 'POST', body: JSON.stringify({ title: 'slow one' }) });
    const { id } = await created.json() as { id: string };
    process.env.FAKE_AGENT_MODE = 'slow';
    process.env.FAKE_AGENT_SLEEP_MS = '8000';
    const sent = await api(`/api/chat/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ text: '慢一点' }) });
    expect(sent.status).toBe(202);
    const busy = await api(`/api/chat/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ text: '再来' }) });
    expect(busy.status).toBe(409);
    const blocked = await api(`/api/chat/conversations/${id}`, { method: 'DELETE' });
    expect(blocked.status).toBe(409);
    await sleep(700); // let the CLI spawn
    const status = await (await api(`/api/chat/conversations/${id}/status`)).json() as { status: string };
    expect(status.status).toBe('running');
    const cancel = await api(`/api/chat/conversations/${id}/cancel`, { method: 'POST' });
    expect(await cancel.json()).toEqual({ cancelled: true });
    const t0 = Date.now();
    const idle = await untilIdle(id);
    expect(idle.status).toBe('idle');
    expect(Date.now() - t0).toBeLessThan(5000);
    const conv = await (await api(`/api/chat/conversations/${id}`)).json() as { title: string; messages: { role: string; error: string | null }[] };
    expect(conv.title).toBe('slow one');
    expect(conv.messages[1]).toMatchObject({ role: 'assistant', error: 'cancelled' });
    expect((await api(`/api/chat/conversations/${id}/cancel`, { method: 'POST' })).status).toBe(200);
    delete process.env.FAKE_AGENT_SLEEP_MS;
    process.env.FAKE_AGENT_MODE = 'good';
  }, 60_000);

  it('deletes a conversation with its workspace, keeps .runs/chat out of run pruning, edits the protocol and config', async () => {
    const conversation = await createConversation(ctx.store, { createdBy: 'test' });
    await runChatTurn(ctx, conversation.id, '你好', { mcp, agent });
    const dir = path.join(wsDir, '.runs', 'chat', conversation.id);
    expect(fs.existsSync(dir)).toBe(true);
    expect(pruneRuns(wsDir, '.runs', 0)).toBe(0); // nothing else there; chat/ is not a run
    expect(fs.existsSync(dir)).toBe(true);
    const del = await api(`/api/chat/conversations/${conversation.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(fs.existsSync(dir)).toBe(false);
    expect((await api(`/api/chat/conversations/${conversation.id}`)).status).toBe(404);
    expect(await getConversation(ctx.store, conversation.id)).toBeNull();

    const protocol = await (await api('/api/chat/protocol')).json() as { path: string; text: string };
    expect(protocol.path).toBe('playbooks/chat/AGENTS.md');
    expect(protocol.text).toContain('# knode-os 对话协议');
    const saved = await api('/api/chat/protocol', { method: 'PUT', body: JSON.stringify({ text: '# 自定义协议\n\n只用中文回答。' }) });
    expect(saved.status).toBe(200);
    expect(fs.readFileSync(path.join(wsDir, 'playbooks', 'chat', 'AGENTS.md'), 'utf8')).toContain('只用中文回答');

    const cfg = await api('/api/config', { method: 'PUT', body: JSON.stringify({ chat: { agent: 'fake', model: 'sonnet', effort: 'high', maxTurns: 999, timeoutMs: 1, web: 'on', historyTurns: 3, keep: 7 } }) });
    expect(cfg.status).toBe(200);
    const { config } = await cfg.json() as { config: { chat: Record<string, unknown> } };
    expect(config.chat).toMatchObject({ agent: 'fake', model: 'sonnet', effort: 'high', maxTurns: 200, timeoutMs: 60_000, web: 'on', historyTurns: 3, keep: 7 });
    expect(ctx.config.chat.keep).toBe(7);
    ctx.config.chat = { ...ctx.config.chat, model: '', effort: 'default', maxTurns: 30, timeoutMs: 600_000, web: 'inherit', historyTurns: 12, keep: 200 };
  }, 60_000);

  it('frees a conversation a crashed serve left answering', async () => {
    const conversation = await createConversation(ctx.store, { createdBy: 'test' });
    await setConversationStatus(ctx.store, conversation.id, 'running');
    expect((await getConversation(ctx.store, conversation.id))?.status).toBe('running');
    expect(await resetRunningConversations(ctx.store)).toBeGreaterThanOrEqual(1);
    expect((await getConversation(ctx.store, conversation.id))?.status).toBe('idle');
    // and the client sees it as idle, so the composer is usable again
    const body = await (await api(`/api/chat/conversations/${conversation.id}`)).json() as { status: string; running: boolean };
    expect(body).toMatchObject({ status: 'idle', running: false });
  });

  it('parses tool activity from a stream-json transcript', () => {
    const file = path.join(tmp, 'transcript.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'mcp__knode-os__knode_search', input: { query: '宁德时代 营收', k: 3 } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'mcp__knode-os__knode_sync', input: { only: ['raw/docs/notes/x.md'] } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true }] } }),
      'not json',
      JSON.stringify({ type: 'result', result: 'done' }),
    ].join('\n'));
    expect(parseActivity(file, 'claude-cli')).toEqual([
      { tool: 'knode_search', summary: '宁德时代 营收', ok: true },
      { tool: 'knode_sync', summary: 'raw/docs/notes/x.md', path: 'raw/docs/notes/x.md', ok: false },
    ]);
    expect(parseActivity(file, 'codex-cli')).toEqual([]);
    expect(parseActivity(path.join(tmp, 'missing.jsonl'), 'claude-cli')).toEqual([]);
  });
});
