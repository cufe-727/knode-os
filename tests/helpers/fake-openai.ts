import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

/**
 * A stand-in for an OpenAI-compatible endpoint, for testing the built-in
 * research agent. It plays only the model: it reads the brief out of the user
 * message and answers with `tool_calls`, while the real deepagents loop, the
 * real MCP client and the real `/mcp` endpoint carry them out. So a test that
 * passes here proves the wiring, not a mock of it.
 *
 * It scripts on how many tool results are already in the conversation, which is
 * stateless — sub-agents may run concurrently, so a counter on the server would
 * interleave.
 */

export interface FakeOpenAi {
  url: string;
  /** Every request body received, for asserting what the model was offered. */
  calls: ChatRequest[];
  close: () => Promise<void>;
}

interface ChatRequest {
  model?: string;
  stream?: boolean;
  messages?: { role: string; content?: unknown; tool_calls?: { function?: { name?: string } }[] }[];
  tools?: { function?: { name?: string } }[];
}

export interface FakeOpenAiOptions {
  /** Stall every completion this long — for the cancellation and timeout tests. */
  delayMs?: number;
  /** Page body to write; defaults to a page that satisfies the entity template. */
  page?: (input: { target: string; sections: string[]; sources: string[] }) => string;
}

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((p) => (typeof p === 'string' ? p : ((p as { text?: string })?.text ?? ''))).join('')
      : '';

/** A page that passes validateResearchPage for the built-in entity template. */
function defaultPage(input: { target: string; sections: string[]; sources: string[] }): string {
  const { target, sections, sources } = input;
  const body = sections
    .map((heading) => {
      if (/来源|sources/i.test(heading)) return `${heading}\n\n${sources.map((s) => `- ${s}`).join('\n')}`;
      if (/关键事实/.test(heading)) return `${heading}\n\n- 2025 年营业收入 4000 亿元（来源：${sources[0]}）`;
      if (/关系/.test(heading)) return `${heading}\n\n- 向 [[特斯拉]] 供货（supplies_to）`;
      if (/时间线/.test(heading)) return `${heading}\n\n- 2011-12-16 · 公司成立`;
      return `${heading}\n\n${target} 的${heading.replace(/^#+\s*/, '')}（来源：${sources[0]}）。`;
    })
    .join('\n\n');
  // `actor` and `research` are stamped by the validator, not the agent
  return `---\ntype: entity\ntitle: ${target}\naliases: []\nsources: [${sources.map((s) => JSON.stringify(s)).join(', ')}]\n---\n# ${target}\n\n${body}\n`;
}

let completionSeq = 0;

export async function startFakeOpenAi(opts: FakeOpenAiOptions = {}): Promise<FakeOpenAi> {
  const calls: ChatRequest[] = [];
  const app = new Hono();

  app.get('/v1/models', (c) => c.json({ object: 'list', data: [{ id: 'fake-model', object: 'model', owned_by: 'knode-test' }] }));

  app.post('/v1/chat/completions', async (c) => {
    const body = (await c.req.json()) as ChatRequest;
    calls.push(body);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));

    const messages = body.messages ?? [];
    const brief = messages.filter((m) => m.role === 'user').map((m) => textOf(m.content)).join('\n');
    const results = messages.filter((m) => m.role === 'tool');
    const outputPath = /输出路径[^`]*`([^`]+)`/.exec(brief)?.[1] ?? '';
    const target = /- 目标：(.+)/.exec(brief)?.[1]?.trim() ?? 'unknown';
    const sections = (/- 必需章节：(.+)/.exec(brief)?.[1] ?? '')
      .split(' / ')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('#'));

    // The team pipeline marks each phase in its prompt, the same marker the fake
    // CLI dispatches on. Phases that only return text never touch a tool.
    const phase = /<!--\s*knode-phase:\s*(\w+)\s*-->/.exec(brief)?.[1] ?? null;
    let message: Record<string, unknown>;
    if (phase === 'plan') {
      message = { role: 'assistant', content: planJson(target, sections) };
    } else if (phase === 'research') {
      const section = /阶段 2：调查「(.+?)」/.exec(brief)?.[1]?.trim() ?? sections[0] ?? '## 概要';
      const heading = section.startsWith('#') ? section : `## ${section}`;
      message = { role: 'assistant', content: `${heading}\n\n${target} 的这一部分（来源：raw/docs/trusted.md）。` };
    } else if (phase === 'review') {
      message = { role: 'assistant', content: JSON.stringify({ pass: true, summary: `${target} 的页面可用`, issues: [] }) };
    } else if (results.length === 0 && phase !== 'revise') {
      // step 0 of a writing phase: look the subject up
      message = toolCall(`call_search_${completionSeq}`, 'mcp__knode-os__knode_search', { query: target, k: 3 });
    } else if (outputPath && !alreadyCalled(messages, 'knode_write')) {
      const sources = pathsFrom(textOf(results[0]?.content ?? ''));
      const page = (opts.page ?? defaultPage)({ target, sections, sources });
      message = toolCall(`call_write_${completionSeq}`, 'mcp__knode-os__knode_write', { path: outputPath, content: page });
    } else {
      message = { role: 'assistant', content: `wrote ${outputPath || '(nothing)'} for ${target}` };
    }

    const finish = message.tool_calls ? 'tool_calls' : 'stop';
    const payload = {
      // a fresh id per completion, as a real endpoint gives: LangGraph's message
      // reducer merges by id, so a fixed one makes each reply overwrite the last
      id: `chatcmpl-${++completionSeq}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? 'fake-model',
      choices: [{ index: 0, message, finish_reason: finish }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    };
    if (!body.stream) return c.json(payload);
    return new Response(sse(payload, message, finish), { headers: { 'content-type': 'text/event-stream' } });
  });

  let server: Server;
  const port = await new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve(info.port)) as Server;
  });

  return {
    url: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Whether this conversation already asked for a tool — the reliable "done" signal. */
function alreadyCalled(messages: NonNullable<ChatRequest['messages']>, tool: string): boolean {
  return messages.some((m) => m.role === 'assistant' && (m.tool_calls ?? []).some((t) => t.function?.name?.endsWith(tool)));
}

/** The outline the planner is expected to return, as JSON. */
function planJson(target: string, sections: string[]): string {
  const usable = sections.filter((h) => !/来源|sources|证据表|evidence/i.test(h)).slice(0, 2);
  return JSON.stringify({
    sections: (usable.length ? usable : ['## 概要']).map((title) => ({
      title,
      questions: [`${target} 的${title.replace(/^#+\s*/, '')}是什么？`],
      queries: [target],
      entities: [target],
    })),
  });
}

function toolCall(id: string, name: string, args: unknown): Record<string, unknown> {
  return { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}

/** knode_search answers with JSON rows; fall back to the seeded doc when parsing fails. */
function pathsFrom(text: string): string[] {
  try {
    const rows = JSON.parse(text) as { path?: string }[];
    const paths = [...new Set(rows.map((r) => r.path).filter((p): p is string => Boolean(p)))].slice(0, 3);
    if (paths.length) return paths;
  } catch {
    /* not JSON */
  }
  return ['raw/docs/trusted.md'];
}

function sse(payload: { id: string; created: number; model: string; usage: unknown }, message: Record<string, unknown>, finish: string): string {
  const base = { id: payload.id, object: 'chat.completion.chunk', created: payload.created, model: payload.model };
  const chunks: string[] = [];
  const calls = message.tool_calls as { id: string; function: { name: string; arguments: string } }[] | undefined;
  if (calls) {
    chunks.push(JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: calls.map((t, index) => ({ index, id: t.id, type: 'function', function: { name: t.function.name, arguments: '' } })) }, finish_reason: null }] }));
    chunks.push(JSON.stringify({ ...base, choices: [{ index: 0, delta: { tool_calls: calls.map((t, index) => ({ index, function: { arguments: t.function.arguments } })) }, finish_reason: null }] }));
  } else {
    chunks.push(JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: String(message.content ?? '') }, finish_reason: null }] }));
  }
  chunks.push(JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: payload.usage }));
  return chunks.map((ch) => `data: ${ch}\n\n`).join('') + 'data: [DONE]\n\n';
}
