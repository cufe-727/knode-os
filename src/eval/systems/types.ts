import type { LlmEffort } from '../../config.js';
import type { EmbeddingProvider } from '../../ingest/embeddings.js';
import { ChatMessage, LlmClient } from '../../llm/client.js';
import type { CallUsage } from '../../llm/usage.js';
import type { AgentRunResult } from '../agent.js';
import { formatTag, Meter, MeterTag } from '../meter.js';
import type { LoadedPack, StagedCorpus } from '../pack.js';
import type { QuotaGuard } from '../quota.js';
import type { Shim } from '../shim.js';
import type { Citation, KnowledgeUnit, Task } from '../types.js';

/**
 * What every system under test is given and must provide (docs/design/23 §3).
 *
 * Systems sharing a `group` share one build: knode's workspace serves
 * `knode-ask`, `knode-sag`, `agent-knode` and `agent-knode-wiki`; the
 * llm-wiki build serves `agent-wiki`; the RAG index serves the three RAG
 * variants. The runner builds a group once per pack and measures it there.
 */

export interface ModelSettings {
  /** Codex model every system answers and builds with ('' = Codex's default). */
  model: string;
  buildEffort: LlmEffort;
  answerEffort: LlmEffort;
}

export interface SystemEnv {
  runId: string;
  pack: LoadedPack;
  staged: StagedCorpus;
  /** Persistent per-group working directory under the run. */
  workDir: string;
  shim: Shim;
  meter: Meter;
  quota: QuotaGuard;
  models: ModelSettings;
  log: (msg: string) => void;
}

export interface SystemAnswer {
  text: string;
  citations?: Citation[];
  retrieved?: string[];
  toolCalls?: number;
  /** An agent's command lines and MCP tool calls, in order (src/eval/trace.ts); bounded when the record is written. */
  commands?: string[];
  capped?: boolean;
  leaked?: string[];
  error?: string;
}

export interface SystemUnderTest {
  id: string;
  label: string;
  /** Systems with the same group share a build. */
  group: string;
  kind: 'reference' | 'agent' | 'pipeline' | 'kb';
  /** Does it produce answers (false: scored on retrieval only). */
  answers: boolean;
  /** Do its answers cite corpus documents (false: they cite records of its own, and citation scores do not apply). */
  cites?: boolean;
  /** Can it run on this pack at all (a staged corpus too large for long context, an external system off this pack). */
  applicable?(pack: LoadedPack, staged?: StagedCorpus): boolean;
  /** Build the group's knowledge base; called once per pack for the first system of its group. */
  build?(env: SystemEnv): Promise<{ notes?: Record<string, unknown>; kbDir?: string }>;
  /** Reopen an earlier build (a resumed run) without rebuilding. */
  reopen?(env: SystemEnv): Promise<void>;
  answer?(task: Task, prompt: string, env: SystemEnv): Promise<SystemAnswer>;
  retrieve?(query: string, k: number, env: SystemEnv): Promise<string[]>;
  exportKnowledge?(env: SystemEnv): Promise<KnowledgeUnit[]>;
  /** Apply an update batch already copied into the staged corpus. */
  update?(files: string[], env: SystemEnv): Promise<void>;
  /** Close what it holds open for this pack once its group is done with it (packs run concurrently). */
  release?(env: SystemEnv): Promise<void>;
}

/** A client that reaches the run's model through the shim, tagged so the meter can attribute the call. */
export function shimClient(env: Pick<SystemEnv, 'shim'>, tag: MeterTag): LlmClient {
  return new LlmClient({
    provider: 'openai',
    baseUrl: env.shim.baseUrl,
    apiKey: formatTag(tag),
    protocol: 'chat',
    model: `codex@${tag.stage}`,
    cliPath: '',
    cliTimeoutMs: 900_000,
  });
}

export async function chat(env: Pick<SystemEnv, 'shim'>, tag: MeterTag, messages: ChatMessage[], opts: { json?: boolean } = {}): Promise<string> {
  return shimClient(env, tag).complete(messages, { json: opts.json });
}

/** An embedder whose calls are metered under this system's tag. */
export function taggedEmbedder(env: Pick<SystemEnv, 'shim'>, tag: MeterTag): EmbeddingProvider {
  const e = env.shim.embedder;
  if (!e) throw new Error('this run has no embedder (the shim was started without one)');
  return {
    model: e.model,
    dimensions: e.dimensions,
    embed: (texts) => e.embedAs(tag, texts),
  };
}

/** Record an agent session's usage (it ran Codex directly, not through the shim), and where it ran. */
export function recordAgent(meter: Meter, tag: MeterTag, model: string, r: Pick<AgentRunResult, 'usage' | 'ms' | 'error'> & Partial<Pick<AgentRunResult, 'worker' | 'backend'>>): void {
  meter.record({
    ...tag, model: model || 'codex', ms: r.ms, ok: !r.error, replayed: false, usage: r.usage as CallUsage | null,
    ...(r.worker ? { worker: r.worker } : {}), backend: r.backend ?? `codex-cli:${model || 'default'}`,
  });
}
