import fs from 'node:fs';
import path from 'node:path';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { ChatOpenAI } from '@langchain/openai';
import { createDeepAgent, createFilesystemMiddleware, type SubAgent } from 'deepagents';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { resolveSecret } from '../config.js';
import { BuiltinAgent } from './agent.js';
import {
  abortSession,
  isCancelled,
  JobCancelledError,
  READ_TOOLS,
  registerSession,
  SessionInput,
  SessionResult,
  stderrPathFor,
  transcriptPathFor,
} from './launch.js';
import { NativeAgentSpec } from './profile.js';
import { TranscriptWriter } from './transcript.js';

/**
 * The in-process executor: a LangChain `deepagents` loop driven by an
 * OpenAI-compatible endpoint, for machines with no coding-agent CLI installed.
 *
 * It honours the same contract as a CLI session (see `launchSession`): the
 * prompt is the whole instruction, the page travels back through `knode_write`
 * over the same HTTP MCP endpoint the CLIs use, the transcript is written
 * incrementally in claude's stream-json shape so the Chat tab's live activity
 * view needs no special case, and the session is registered for cancellation
 * under its job id.
 *
 * Two deliberate differences from the CLIs, both about telling the truth:
 * there is no web tool (an OpenAI-compatible endpoint has none, and inventing
 * an egress path to a search vendor the user never configured is not ours to
 * make), and `costUsd` is null because token counts are not dollars.
 */

export interface BuiltinSessionInput extends Omit<SessionInput, 'agent'> {
  agent: BuiltinAgent;
}

/**
 * LangChain ships traces to LangSmith when the tracing flag is on. knode-os is
 * a local-first knowledge base, so research content must not leave the machine
 * by accident: pin the flags off unless the operator set them deliberately.
 */
function pinTracingOff(): void {
  for (const key of ['LANGSMITH_TRACING', 'LANGCHAIN_TRACING_V2']) {
    if (process.env[key] === undefined) process.env[key] = 'false';
  }
}

/** A model handle on the session's endpoint; `model` overrides the agent's own. */
function chatModel(agent: BuiltinAgent, model?: string): ChatOpenAI {
  return new ChatOpenAI({
    model: model || agent.model,
    apiKey: resolveSecret(agent.apiKey) || 'unused', // some local endpoints want no key; the client still wants a string
    configuration: { baseURL: agent.baseUrl },
  });
}

/**
 * The knode tools this session may call. Unlike the CLIs — where the read-only
 * scope is merely described to codex and cursor in the prompt — a tool left out
 * here simply does not exist for the model.
 */
export function allowedTools(tools: StructuredToolInterface[], scope: 'read' | 'write'): StructuredToolInterface[] {
  if (scope === 'write') return tools;
  const allowed = new Set(READ_TOOLS);
  return tools.filter((t) => allowed.has(t.name));
}

/** A profile role marked `native` becomes one of the agent's own sub-agents. */
function toSubAgent(spec: NativeAgentSpec, agent: BuiltinAgent, tools: StructuredToolInterface[]): SubAgent {
  return {
    name: spec.id,
    description: spec.description || spec.title || spec.id,
    systemPrompt: spec.prompt,
    // sub-agents never write the page: the orchestrator does, through knode_write
    tools: allowedTools(tools, 'read') as SubAgent['tools'],
    ...(spec.model ? { model: chatModel(agent, spec.model) } : {}),
  };
}

function isRecursionLimit(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? '';
  const message = err instanceof Error ? err.message : String(err);
  return name === 'GraphRecursionError' || /recursion limit/i.test(message);
}

export async function runBuiltinSession(input: BuiltinSessionInput): Promise<SessionResult> {
  pinTracingOff();
  const transcriptPath = transcriptPathFor(input.cwd, input.label);
  const transcript = new TranscriptWriter(transcriptPath);
  transcript.init(input.cwd, input.label);
  const stderr = fs.openSync(stderrPathFor(input.cwd, input.label), 'w');
  const note = (m: string) => fs.writeSync(stderr, `${m}\n`);

  const client = new MultiServerMCPClient({
    mcpServers: {
      'knode-os': {
        transport: 'http',
        url: input.mcp.url,
        headers: { Authorization: `Bearer ${input.mcp.token}`, ...input.mcp.headers },
      },
    },
    // yields `mcp__knode-os__<tool>` — the same spelling the CLIs use, which
    // READ_TOOLS and parseActivity's prefix strip both depend on
    prefixToolNameWithServerName: true,
    additionalToolNamePrefix: 'mcp',
  });

  const result: SessionResult = { text: '', turns: null, costUsd: null, error: null, exitCode: 0, transcriptPath };
  const ac = new AbortController();
  const unregister = registerSession(input.jobId, abortSession(ac));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, input.timeoutMs);

  let turns = 0;
  try {
    const all = (await client.getTools()) as StructuredToolInterface[];
    const tools = allowedTools(all, input.tools);
    note(`tools: ${tools.length}/${all.length} (${input.tools})`);
    if (input.allowNetwork) note('note: the built-in agent has no web tool — this session searched the knowledge base only');

    const schemaFile = path.join(input.cwd, 'AGENTS.md');
    const systemPrompt = fs.existsSync(schemaFile) ? fs.readFileSync(schemaFile, 'utf8') : '';
    const subagents = input.agents?.length ? input.agents.map((a) => toSubAgent(a, input.agent, all)) : undefined;

    const agent = createDeepAgent({
      model: chatModel(input.agent),
      tools,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(subagents ? { subagents } : {}),
      // deepagents' own virtual filesystem otherwise offers write_file / edit_file /
      // delete, which would let the model "finish" by writing a report nobody reads.
      // The page has exactly one way out of a session: knode_write.
      middleware: [createFilesystemMiddleware({ tools: ['read_file'] })],
    });

    const run = await agent.streamEvents(
      { messages: [{ role: 'user', content: input.prompt }] },
      // a LangGraph step is model -> tools -> model, so a turn is two of them
      { version: 'v3', signal: ac.signal, recursionLimit: 2 * input.maxTurns + 1 },
    );

    const counting = (async () => {
      for await (const message of run.messages) {
        turns++;
        // the text has to be drained even though run.output carries the final
        // message: an unconsumed projection stalls the run behind back-pressure
        try {
          for await (const _ of message.text) void _;
        } catch {
          /* a message that errored is still a turn */
        }
      }
    })();

    const recording = (async () => {
      for await (const call of run.toolCalls) {
        const id = `toolu_${++toolSeq}`;
        transcript.toolUse(id, call.name, call.input);
        try {
          await call.output;
          transcript.toolResult(id, false);
        } catch {
          transcript.toolResult(id, true);
        }
      }
    })();

    const [, , output] = await Promise.all([counting, recording, run.output]);
    result.text = finalText(output);
  } catch (err) {
    if (isCancelled(input.jobId)) {
      // fall through: the post-flight check below reports it as a cancellation
    } else if (timedOut) {
      // same
    } else if (isRecursionLimit(err)) {
      // the CLI equivalent of --max-turns: reported on the phase, not a failure to start
      result.error = `built-in agent reached the turn cap (${input.maxTurns}) before finishing`;
      result.exitCode = 1;
    } else {
      result.error = `built-in agent: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`;
      result.exitCode = 1;
      note(err instanceof Error ? (err.stack ?? err.message) : String(err));
    }
  } finally {
    clearTimeout(timer);
    unregister();
    result.turns = turns || null;
    transcript.result({ text: result.text, turns, isError: Boolean(result.error) });
    transcript.close();
    fs.closeSync(stderr);
    await client.close().catch(() => {});
  }

  // Cancel wins over a timeout that raced it, exactly as on the CLI path, where
  // a killed process exits like any other and the flag says why.
  if (isCancelled(input.jobId)) throw new JobCancelledError(input.jobId);
  // A timeout throws rather than reporting: `runProcess` rejects too, and the
  // runner turns that into a failed job instead of a phase that carries on.
  if (timedOut) throw new Error(`built-in agent timed out after ${Math.round(input.timeoutMs / 1000)}s`);
  return result;
}

let toolSeq = 0;

/** The agent's last message, as text. */
function finalText(output: unknown): string {
  const messages = (output as { messages?: unknown[] })?.messages;
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { content?: unknown; getType?: () => string };
    if (typeof m?.getType === 'function' && m.getType() !== 'ai') continue;
    const text = textOf(m?.content);
    if (text) return text;
  }
  return '';
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : ((part as { text?: string })?.text ?? '')))
    .join('')
    .trim();
}
