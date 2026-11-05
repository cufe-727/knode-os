import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig, defaultRoutedLlmConfig, KnodeConfig, LlmConnection } from '../../config.js';
import { AppContext, createContext } from '../../context.js';
import { runDocumentPass } from '../../ingest/background.js';
import { sync } from '../../ingest/sync.js';
import { parseFrontmatter } from '../../markdown.js';
import { ask } from '../../search/ask.js';
import { search } from '../../search/search.js';
import type { ChatMessage, LlmClient } from '../../llm/client.js';
import { generateWiki } from '../../wiki/generate.js';
import { refineWiki } from '../../wiki/refine.js';
import { isolatedCopy, runAgent } from '../agent.js';
import { formatTag } from '../meter.js';
import { dirBytes, listFiles } from '../pack.js';
import { citationsIn } from '../prompts.js';
import type { Citation, KnowledgeUnit } from '../types.js';
import { AGENT_BRIEF } from './agents.js';
import { recordAgent, shimClient, SystemEnv, SystemUnderTest } from './types.js';

/**
 * knode-os as a system under test (docs/design/23 §3): a fresh workspace per
 * pack with the embedded PGlite index, every model route and the embedder
 * pointed at the run's shim (so its build is metered like everyone else's),
 * built the way `serve` builds — sync, then document passes until the queue
 * and the summaries are done, then wiki generation and refinement.
 *
 * One build, four ways to use it: `knode-ask` (the cited-answer pipeline),
 * `knode-sag` (multi-hop retrieval, scored on retrieval), `agent-knode` (the
 * same Codex agent as the grep baseline, given knode's MCP retrieval tools
 * instead of the files), and `agent-knode-wiki` (that agent reading the
 * generated wiki). PGlite admits one process at a time, so the in-process
 * context is closed before an MCP agent opens the index.
 */

interface KnodeState {
  ws: string;
  ctx: AppContext | null;
  /** wiki page path → the corpus documents it was generated from. */
  pageSources: Map<string, string[]>;
}

const states = new Map<string, KnodeState>();

/** Tools an agent may use against the knowledge base — retrieval and reading only, nothing that calls a model or writes. */
export const KNODE_AGENT_TOOLS = ['knode_search', 'knode_graph_search', 'knode_read', 'knode_ls', 'knode_grep', 'knode_claims'];

const STAGES = ['extract', 'summary', 'kb-judge', 'document', 'translate'] as const;

/** Document-pass settings of the workspaces under test, recorded in every build's notes. */
export const KNODE_EVAL_CONCURRENCY = Number(process.env.KNODE_EVAL_KNODE_CONCURRENCY ?? 6);
export const KNODE_EVAL_BATCH = Number(process.env.KNODE_EVAL_KNODE_BATCH ?? 16);

/** One state per working directory: a run's pack, never another run's of the same pack. */
function stateFor(env: SystemEnv): KnodeState {
  let s = states.get(env.workDir);
  if (!s) {
    s = { ws: path.join(env.workDir, 'ws'), ctx: null, pageSources: new Map() };
    states.set(env.workDir, s);
  }
  return s;
}

/** The workspace config: PGlite, the shim for every stage and for embeddings, nothing that reaches out on its own. */
export function evalWorkspaceConfig(env: Pick<SystemEnv, 'shim' | 'pack'>, system = 'knode'): KnodeConfig {
  const base = defaultConfig();
  const connection = (stage: string): LlmConnection => ({
    id: `eval-${stage}`,
    label: `eval ${stage}`,
    provider: 'openai',
    baseUrl: env.shim.baseUrl,
    apiKey: formatTag({ system, stage }),
    protocol: 'chat',
    model: `codex@${stage}`,
    cliPath: '',
    effort: 'default',
    cliTimeoutMs: 900_000,
  });
  const route = (stage: string) => ({ ...defaultRoutedLlmConfig(), use: `eval-${stage}` });
  const embedder = env.shim.embedder;
  return {
    ...base,
    database: { ...base.database, kind: 'pglite' },
    embedding: embedder
      ? { provider: 'openai', baseUrl: env.shim.baseUrl, apiKey: formatTag({ system, stage: 'embed' }), model: embedder.model, dimensions: embedder.dimensions, batchSize: 16, sendDimensions: false }
      : base.embedding,
    embeddingProviders: [],
    connections: STAGES.map(connection),
    llmUse: 'eval-kb-judge',
    extraction: {
      ...base.extraction,
      entityLlm: route('extract'),
      documentLlm: route('document'),
      summaryLlm: route('summary'),
      judgeLlm: route('kb-judge'),
      translateLlm: route('translate'),
      workers: [],
      // a benchmark build may use more of the shim's slots than the product default (3 calls, 8 documents a pass)
      concurrency: KNODE_EVAL_CONCURRENCY,
      batchSize: KNODE_EVAL_BATCH,
    },
  } as KnodeConfig;
}

async function open(s: KnodeState): Promise<AppContext> {
  if (!s.ctx) s.ctx = await createContext(s.ws);
  return s.ctx;
}

async function close(s: KnodeState): Promise<void> {
  if (!s.ctx) return;
  await s.ctx.datasources.closeAll();
  await s.ctx.store.close();
  s.ctx = null;
}

/** `raw/docs/<x>` → corpus path `<x>`; a generated page → the documents it was made from. */
function toCorpus(s: KnodeState, p: string): string[] {
  if (p.startsWith('raw/docs/')) return [p.slice('raw/docs/'.length)];
  return s.pageSources.get(p) ?? [];
}

function readPageSources(s: KnodeState): void {
  s.pageSources.clear();
  const wiki = path.join(s.ws, 'wiki');
  for (const rel of listFiles(wiki).filter((f) => f.endsWith('.md'))) {
    const raw = fs.readFileSync(path.join(wiki, rel), 'utf8');
    const fm = parseFrontmatter(raw).frontmatter;
    const declared = [fm.source, ...(((fm.knode as { inputs?: { documents?: unknown[] } } | undefined)?.inputs?.documents) ?? [])]
      .filter((x): x is string => typeof x === 'string');
    const cited = [...raw.matchAll(/raw\/docs\/[^\s)\]'"`，。]+/g)].map((m) => m[0]);
    const docs = [...new Set([...declared, ...cited].filter((p) => p.startsWith('raw/docs/')).map((p) => p.slice('raw/docs/'.length)))];
    s.pageSources.set(`wiki/${rel}`, docs);
  }
}

async function drain(ctx: AppContext, env: SystemEnv): Promise<Record<string, number>> {
  const totals = { passes: 0, processed: 0, failed: 0, calls: 0, callsFailed: 0, summaries: 0 };
  for (let i = 0; i < 2000; i++) {
    await env.quota.wait();
    const pass = await runDocumentPass(ctx);
    totals.passes++;
    totals.processed += pass.processed;
    totals.failed += pass.failed;
    totals.calls += pass.calls;
    totals.callsFailed += pass.callsFailed;
    totals.summaries += pass.summaries.length;
    if (i % 10 === 0) env.log(`knode pass ${i + 1}: processed ${totals.processed}, queued ${pass.queued}, summaries ${totals.summaries}`);
    if ((pass.queued === 0 || !pass.progressed) && pass.summaries.length === 0) break;
  }
  return totals;
}

function knodeSystem(id: string, label: string, kind: SystemUnderTest['kind'], answers: boolean, extra: Partial<SystemUnderTest>): SystemUnderTest {
  return {
    id,
    label,
    group: 'knode',
    kind,
    answers,
    async build(env) {
      const s = stateFor(env);
      await close(s);
      fs.rmSync(s.ws, { recursive: true, force: true });
      fs.mkdirSync(s.ws, { recursive: true });
      fs.writeFileSync(path.join(s.ws, 'knode.config.json'), JSON.stringify(evalWorkspaceConfig(env), null, 2));
      fs.cpSync(env.staged.dir, path.join(s.ws, 'raw', 'docs'), { recursive: true });
      const ctx = await open(s);
      const t0 = Date.now();
      const synced = await sync(ctx, { datasources: false, onProgress: (m) => env.log(`knode sync: ${m}`) });
      const tSync = Date.now() - t0;
      const passes = await drain(ctx, env);
      const tPasses = Date.now() - t0 - tSync;
      const pages = await generateWiki(ctx.store, ctx.llm, { config: ctx.config, embedder: ctx.embedder, onProgress: (m) => env.log(`knode wiki: ${m}`) });
      const refined = await refineWiki(ctx.store, ctx.config, ctx.llm, { embedder: ctx.embedder });
      // the generated pages are searchable too, as in a live workspace
      await sync(ctx, { datasources: false, llmGraph: false });
      readPageSources(s);
      const [counts] = await ctx.store.query<Record<string, number>>(
        `SELECT (SELECT count(*)::int FROM documents WHERE status = 'indexed') AS documents,
                (SELECT count(*)::int FROM chunks) AS chunks,
                (SELECT count(*)::int FROM entities WHERE tx_to IS NULL AND canonical_id IS NULL) AS entities,
                (SELECT count(*)::int FROM relations WHERE tx_to IS NULL) AS relations,
                (SELECT count(*)::int FROM claims WHERE tx_to IS NULL AND canonical_id IS NULL) AS claims`,
      );
      return {
        kbDir: s.ws,
        notes: { ...counts, ...passes, passConcurrency: KNODE_EVAL_CONCURRENCY, passBatch: KNODE_EVAL_BATCH, wikiPages: pages.length, refined, indexed: synced.indexed, stageMs: { sync: tSync, documentPasses: tPasses, wiki: Date.now() - t0 - tSync - tPasses } },
      };
    },
    async reopen(env) {
      const s = stateFor(env);
      if (!fs.existsSync(path.join(s.ws, 'knode.config.json'))) throw new Error(`no knode workspace to reopen at ${s.ws}`);
      // the shim's port changed since the build: repoint the workspace at this run's shim
      fs.writeFileSync(path.join(s.ws, 'knode.config.json'), JSON.stringify(evalWorkspaceConfig(env), null, 2));
      readPageSources(s);
    },
    async release(env) {
      await close(stateFor(env));
    },
    ...extra,
  };
}

export function knodeAsk(): SystemUnderTest {
  return knodeSystem('knode-ask', 'knode-os ask (hybrid retrieval, cited answer)', 'kb', true, {
    // the embedded PGlite index blocks the process under overlapping ask() queries now and then: one at a time
    serial: true,
    async answer(task, prompt, env) {
      const s = stateFor(env);
      const ctx = await open(s);
      // ask retrieves with its question: give it the question alone, and the shared output rules to its model call
      const rules = prompt.startsWith(task.question) ? prompt.slice(task.question.length) : '';
      const llm = withAppendedRules(shimClient(env, { system: 'knode-ask', stage: 'answer', task: task.id }), rules);
      const res = await ask(ctx.store, ctx.config, ctx.embedder, llm, task.question, { mode: 'hybrid' });
      // ask's own [n] citations, and any [doc: path] the answer wrote under the shared output rules
      const docs = new Set(env.staged.docs.map((d) => d.path));
      const citations: Citation[] = [...new Set([...res.citations.flatMap((c) => toCorpus(s, c.path)), ...citationsIn(res.answer, docs).map((c) => c.doc)])].map((doc) => ({ doc }));
      return { text: res.answer, citations, retrieved: [...new Set(res.contexts.flatMap((c) => toCorpus(s, c.path)))] };
    },
    async retrieve(query, k, env) {
      const ctx = await open(stateFor(env));
      const hits = await search(ctx.store, ctx.embedder, query, { k: k * 3, mode: 'hybrid', track: false, heat: ctx.config.heat });
      return [...new Set(hits.flatMap((h) => toCorpus(stateFor(env), h.path)))].slice(0, k);
    },
    async exportKnowledge(env) {
      return exportUnits(stateFor(env));
    },
    async update(_files, env) {
      const s = stateFor(env);
      const ctx = await open(s);
      fs.cpSync(env.staged.dir, path.join(s.ws, 'raw', 'docs'), { recursive: true });
      await sync(ctx, { datasources: false });
      await drain(ctx, env);
      readPageSources(s);
    },
  });
}

export function knodeSag(): SystemUnderTest {
  return knodeSystem('knode-sag', 'knode-os SAG multi-hop retrieval', 'kb', false, {
    async retrieve(query, k, env) {
      const s = stateFor(env);
      const ctx = await open(s);
      const hits = await search(ctx.store, ctx.embedder, query, { k: k * 3, mode: 'sag', track: false, heat: ctx.config.heat, sag: ctx.config.retrieval.sag });
      return [...new Set(hits.flatMap((h) => toCorpus(s, h.path)))].slice(0, k);
    },
  });
}

const CLI_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli.js');

export function agentKnode(): SystemUnderTest {
  return knodeSystem('agent-knode', 'Codex agent with knode MCP retrieval tools', 'agent', true, {
    serial: true,
    async answer(task, prompt, env) {
      const s = stateFor(env);
      await close(s);
      await env.quota.wait();
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-eval-mcp-'));
      try {
        const r = await runAgent({
          cwd: empty,
          sandbox: 'read-only',
          model: env.models.model,
          effort: env.models.answerEffort,
          prompt: `${AGENT_BRIEF('The documents are not in the current directory: search them with the knode MCP tools (knode_search, knode_graph_search, knode_claims, knode_read, knode_grep, knode_ls). Source documents live under raw/docs/; generated pages under wiki/.')}\n\n${prompt}`,
          mcp: { name: 'knode', command: process.execPath, args: [CLI_JS, '--data', s.ws, 'mcp'], enabledTools: KNODE_AGENT_TOOLS },
        });
        recordAgent(env.meter, { system: 'agent-knode', stage: 'agent', task: task.id }, env.models.model, r);
        const docs = new Set(env.staged.docs.map((d) => d.path));
        const citations = [...new Set([
          ...citationsIn(r.text, docs).map((c) => c.doc),
          ...[...r.text.matchAll(/wiki\/[^\s)\]'"`，。]+\.md/g)].flatMap((m) => toCorpus(s, m[0])),
        ])].map((doc) => ({ doc }));
        return { text: r.text, citations, toolCalls: r.toolCalls, capped: r.capped, leaked: r.leaked, error: r.error };
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    },
  });
}

export function agentKnodeWiki(): SystemUnderTest {
  return knodeSystem('agent-knode-wiki', 'Codex agent reading the knode-generated wiki', 'agent', true, {
    async answer(task, prompt, env) {
      const s = stateFor(env);
      await env.quota.wait();
      const copy = isolatedCopy(path.join(s.ws, 'wiki'), 'wiki');
      try {
        const r = await runAgent({
          cwd: copy.dir,
          sandbox: 'read-only',
          model: env.models.model,
          effort: env.models.answerEffort,
          prompt: `${AGENT_BRIEF('The current directory is a wiki generated from the documents (start from index.md and sources/). The source documents themselves are not here; pages cite them as raw/docs/<path> — cite those paths.')}\n\n${prompt}`,
        });
        recordAgent(env.meter, { system: 'agent-knode-wiki', stage: 'agent', task: task.id }, env.models.model, r);
        const docs = new Set(env.staged.docs.map((d) => d.path));
        const viaPages = r.filesTouched.flatMap((f) => toCorpus(s, `wiki/${f}`));
        return {
          text: r.text,
          citations: citationsIn(r.text, docs),
          retrieved: [...new Set(viaPages)],
          toolCalls: r.toolCalls,
          capped: r.capped,
          leaked: r.leaked,
          error: r.error,
        };
      } finally {
        copy.cleanup();
      }
    },
  });
}

/** A client that adds `rules` to the last user message of every call — the output contract every system answers under. */
function withAppendedRules(client: LlmClient, rules: string): LlmClient {
  if (!rules.trim()) return client;
  const add = (messages: ChatMessage[]): ChatMessage[] => {
    const i = messages.map((m) => m.role).lastIndexOf('user');
    return i < 0 ? [...messages, { role: 'user', content: rules.trim() }] : messages.map((m, k) => (k === i ? { ...m, content: `${m.content}${rules}` } : m));
  };
  const complete = client.complete.bind(client);
  const completeJson = client.completeJson.bind(client);
  return Object.assign(Object.create(client) as LlmClient, {
    complete: (messages: ChatMessage[], opts?: Parameters<LlmClient['complete']>[1]) => complete(add(messages), opts),
    completeJson: <T>(messages: ChatMessage[], opts?: Parameters<LlmClient['completeJson']>[1]) => completeJson<T>(add(messages), opts),
  });
}

/** Everything the build generated, as units: entities, relations, claims and pages — never the source chunks. */
async function exportUnits(s: KnodeState): Promise<KnowledgeUnit[]> {
  const ctx = await open(s);
  const strip = (p: string | null) => (p && p.startsWith('raw/docs/') ? [p.slice('raw/docs/'.length)] : []);
  const units: KnowledgeUnit[] = [];

  const sourcesOf = new Map<string, string[]>();
  for (const r of await ctx.store.query<{ entity_id: string; path: string }>(
    `SELECT DISTINCT m.entity_id, d.path FROM entity_mentions m JOIN documents d ON d.id = m.document_id WHERE d.root = 'docs'`,
  )) (sourcesOf.get(r.entity_id) ?? sourcesOf.set(r.entity_id, []).get(r.entity_id)!).push(...strip(r.path));

  for (const e of await ctx.store.query<{ id: string; name: string; type: string; description: string; aliases: unknown }>(
    `SELECT id, name, type, description, aliases FROM entities WHERE tx_to IS NULL AND canonical_id IS NULL`,
  )) {
    const aliases = Array.isArray(e.aliases) ? (e.aliases as string[]) : [];
    units.push({ id: `entity:${e.id}`, kind: 'entity', title: e.name, text: `${e.name} (${e.type})${aliases.length ? ` — also ${aliases.join(', ')}` : ''}: ${e.description}`.trim(), sources: sourcesOf.get(e.id) ?? [], links: [] });
  }
  for (const r of await ctx.store.query<{ id: string; head: string; tail: string; type: string; description: string; path: string | null; source_id: string; target_id: string }>(
    `SELECT r.id, s.name AS head, t.name AS tail, r.type, r.description, d.path, r.source_id, r.target_id
     FROM relations r JOIN entities s ON s.id = r.source_id JOIN entities t ON t.id = r.target_id
     LEFT JOIN documents d ON d.id = r.document_id WHERE r.tx_to IS NULL`,
  )) {
    units.push({ id: `relation:${r.id}`, kind: 'relation', head: r.head, tail: r.tail, relation: r.type, text: `${r.head} —${r.type}→ ${r.tail}${r.description ? `: ${r.description}` : ''}`, sources: strip(r.path), links: [`entity:${r.source_id}`, `entity:${r.target_id}`] });
  }
  for (const c of await ctx.store.query<{ id: string; subject: string; statement: string; kind: string; valid_from: string | null; valid_to: string | null; path: string | null; subject_id: string }>(
    `SELECT c.id, e.name AS subject, c.statement, c.kind, c.valid_from, c.valid_to, d.path, c.subject_id
     FROM claims c JOIN entities e ON e.id = c.subject_id
     LEFT JOIN chunks ch ON ch.id = c.chunk_id LEFT JOIN documents d ON d.id = ch.document_id
     WHERE c.tx_to IS NULL AND c.canonical_id IS NULL`,
  )) {
    const when = c.valid_from || c.valid_to ? ` (${c.valid_from ? String(c.valid_from).slice(0, 10) : '?'} – ${c.valid_to ? String(c.valid_to).slice(0, 10) : ''})` : '';
    units.push({ id: `claim:${c.id}`, kind: 'claim', title: c.subject, text: `${c.statement}${when}${c.kind && c.kind !== 'fact' ? ` [${c.kind}]` : ''}`, sources: strip(c.path), links: [`entity:${c.subject_id}`] });
  }
  const wiki = path.join(s.ws, 'wiki');
  for (const rel of listFiles(wiki).filter((f) => f.endsWith('.md'))) {
    // navigation pages (the generated indexes, the overview) are not knowledge units
    if (rel.startsWith('.obsidian') || /(^|\/)(index|log|overview)\.md$/.test(rel)) continue;
    const kind: KnowledgeUnit['kind'] = rel.startsWith('sources/') ? 'summary' : rel.startsWith('concepts/') ? 'community' : 'page';
    const body = parseFrontmatter(fs.readFileSync(path.join(wiki, rel), 'utf8')).body.replace(/<!--[^>]*-->/g, '').trim();
    if (!body) continue;
    const links = [...body.matchAll(/\[\[([^\]|#]+)/g)].map((m) => `page:${m[1].trim()}`);
    units.push({ id: `page:wiki/${rel}`, kind, title: rel, text: body, sources: s.pageSources.get(`wiki/${rel}`) ?? [], links });
  }
  return units;
}

/** Bytes of the knowledge base a knode build left (index, wiki and sidecars, not the copied sources). */
export function knodeKbBytes(ws: string): number {
  return dirBytes(path.join(ws, '.knode')) + dirBytes(path.join(ws, 'wiki')) + dirBytes(path.join(ws, '.sidecar'));
}
