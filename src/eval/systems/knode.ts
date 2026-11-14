import fs from 'node:fs';
import path from 'node:path';
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
import { currentRemote } from '../placement.js';
import { dirBytes, listFiles } from '../pack.js';
import { citationsIn } from '../prompts.js';
import type { Citation, KnowledgeUnit } from '../types.js';
import { AGENT_BRIEF } from './agents.js';
import { catalogGuide } from '../../mcp/catalog-guide.js';
import { WIKI_SOURCES_BRIEF, wikiWithSources } from './llm-wiki.js';
import { recordAgent, shimClient, SystemEnv, SystemUnderTest } from './types.js';
import { evalTempDir } from '../tmp.js';
import { startToolHost, ToolHost } from '../toolhost.js';
import { cloneSchema, describeDatabase, dropEvalWorkspace, evalDatabase, markSchema, storableDatabase } from '../database.js';

/**
 * knode-os as a system under test (docs/design/23 §3): a fresh workspace per
 * pack with its index on the product's backend — a schema of its own in the
 * evaluation database on PostgreSQL, an embedded database on PGlite
 * (src/eval/database.ts, docs/design/31 D1) — every model route and the embedder
 * pointed at the run's shim (so its build is metered like everyone else's),
 * built the way `serve` builds — sync, then document passes until the queue
 * and the summaries are done, then wiki generation and refinement.
 *
 * One build, five ways to use it: `knode-ask` (the cited-answer pipeline),
 * `knode-sag` (multi-hop retrieval, scored on retrieval), `agent-knode` (the
 * same Codex agent as the grep baseline, given knode's MCP retrieval tools
 * instead of the files), `agent-knode-wiki` (that agent reading the
 * generated wiki) and `agent-knode-wiki-sources` (reading the wiki with the
 * sources beside it, the wiki as a navigation layer). The run opens the
 * index once per build and everything shares it: answers, retrieval probes,
 * and the agent sessions' tools, which the run serves itself
 * (src/eval/toolhost.ts, docs/design/31 D4).
 */

interface KnodeState {
  ws: string;
  /**
   * The open context, held as the promise of it: answers that start together
   * share one open instead of each opening the index (docs/design/31 F2 — on
   * PGlite several instances on one directory stalled the process).
   */
  ctx: Promise<AppContext> | null;
  /** A close in flight: the next open waits for it. */
  closing: Promise<void> | null;
  /** The build's tool host for agent sessions, started once with the first session. */
  host: Promise<ToolHost> | null;
  /** wiki page path → the corpus documents it was generated from. */
  pageSources: Map<string, string[]>;
}

const states = new Map<string, KnodeState>();

/**
 * Tools an agent may use against the knowledge base — retrieval and reading
 * only, nothing that calls a model or writes knowledge. `knode_resolve` is the
 * call the server's own instructions name for "who or what is X" and
 * `knode_survey` the one they name for orientation: an agent told to start
 * with tools it was not given searched and grepped instead, 11 calls a
 * question against grep's 5. `knode_query` (read-only SQL; the agent gets the
 * catalog source only, there being no live datasource in an eval workspace)
 * answers lists, counts and date ranges in one call: without it, in the
 * 2026-11 corpus run, the agent read raw documents one per call, 8.1 calls and
 * 49.6k weighted tokens a question on the reports pack against grep's 3.7 and
 * 30.5k (docs/design/30).
 */
export const KNODE_AGENT_TOOLS = ['knode_resolve', 'knode_survey', 'knode_search', 'knode_graph_search', 'knode_read', 'knode_ls', 'knode_grep', 'knode_claims', 'knode_query'];

/**
 * The knode agent's brief: the grep baseline's (same opening, same budget)
 * with the tools routed by the kind of question, and the catalog's schema,
 * which an agent cannot guess. The shared brief's "search and read the files
 * with shell commands" does not apply here: there are no files to run them on.
 */
export function knodeAgentBrief(): string {
  return `You are answering a question about a document collection. The documents are not in the current directory: they are in a knowledge base you reach through the knode MCP tools (source documents under raw/docs/, generated pages under wiki/). Work read-only. You have a budget of about 20 tool calls; answer before you run out — most questions need 2 to 5. Do not use the network.

Pick the tool by the kind of question:
- Lists, counts, filters, time ranges ("which…", "how many…", "every…", "in 2025…", "in order"): knode_claims (every claim about an entity, each with its date and source; order="timeline", event_range="2025") or knode_query with source="catalog" (SQL, schema below). One call returns the whole set; then read only the documents you need to confirm or quote.
- "Who or what is X": knode_resolve on the question (the entities it names, their claims and the best passages in one call), then the entity's page under wiki/.
- A passage that says something: knode_search (mode="sag" when the answer crosses a relation: "the CEO of the company that acquired…").
- An exact string, name or number: knode_grep with context=3 (the lines around each match, grouped by file) — often enough without reading the file.
- Reading: knode_read with paths=[…] reads several documents, sections or line ranges in one call. Never read one document per call.

${catalogGuide()}`;
}

const STAGES = ['extract', 'summary', 'kb-judge', 'document', 'translate'] as const;

/** Document-pass settings of the workspaces under test, recorded in every build's notes. */
export const KNODE_EVAL_CONCURRENCY = Number(process.env.KNODE_EVAL_KNODE_CONCURRENCY ?? 6);
export const KNODE_EVAL_BATCH = Number(process.env.KNODE_EVAL_KNODE_BATCH ?? 16);

/**
 * A build's document-pass settings: as wide as the slots online for its model
 * calls when the build starts (docs/design/32 §3), and never narrower than
 * `KNODE_EVAL_CONCURRENCY` — calls beyond the slots wait in the queue, and a
 * build on the six slots an old command line has keeps the batches it always
 * had, so its reply cache still answers it. A pass's batch grows in proportion
 * to the width, so a pass has enough calls to fill the slots.
 */
export function evalPassSettings(): { concurrency: number; batchSize: number } {
  const slots = currentRemote<{ callSlots(): number }>()?.callSlots() ?? 0;
  if (slots <= KNODE_EVAL_CONCURRENCY) return { concurrency: KNODE_EVAL_CONCURRENCY, batchSize: KNODE_EVAL_BATCH };
  const concurrency = slots;
  return { concurrency, batchSize: Math.max(KNODE_EVAL_BATCH, Math.ceil((concurrency * KNODE_EVAL_BATCH) / Math.max(1, KNODE_EVAL_CONCURRENCY))) };
}

/** One state per working directory: a run's pack, never another run's of the same pack. */
function stateFor(env: SystemEnv): KnodeState {
  let s = states.get(env.workDir);
  if (!s) {
    s = { ws: path.join(env.workDir, 'ws'), ctx: null, closing: null, host: null, pageSources: new Map() };
    states.set(env.workDir, s);
  }
  return s;
}

/**
 * The workspace config: the run's evaluation database (PGlite in the workspace, or a schema of its own on
 * PostgreSQL — never a live workspace's database), the shim for every stage and for embeddings, nothing that
 * reaches out on its own.
 */
export function evalWorkspaceConfig(env: Pick<SystemEnv, 'shim' | 'pack'> & Partial<Pick<SystemEnv, 'database'>>, system = 'knode'): KnodeConfig {
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
  const pass = evalPassSettings();
  return {
    ...base,
    database: storableDatabase(env.database ?? evalDatabase(base.database)),
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
      // a benchmark build may use more of the shim's slots than the product default (3 calls, 8 documents a pass),
      // and the remote workers' beside them
      ...pass,
    },
    // the reviews inside a build call the Judge route themselves, one call at a time by default; a build's
    // calls go through the shim (and to the workers), so they go out as wide as its extraction does
    review: { ...base.review, directConcurrency: pass.concurrency },
  } as KnodeConfig;
}

/** The workspace's context, opened once however many callers ask at the same time (single-flight). */
function open(s: KnodeState): Promise<AppContext> {
  if (s.ctx) return s.ctx;
  const closing = s.closing;
  const opening = (async () => {
    if (closing) await closing;
    const ctx = await createContext(s.ws);
    // the index as built, for every answer: the store finishes its own upkeep in the background after it opens, and
    // until the substring indexes are marked ready the keyword channel takes another path that scores differently
    // (on PostgreSQL the first answers after an open did; on PGlite the upkeep ran first anyway)
    await Promise.all([ctx.store.indexing, ctx.store.retype]);
    return ctx;
  })();
  s.ctx = opening;
  // a failed open is not kept: the next caller tries again
  opening.catch(() => {
    if (s.ctx === opening) s.ctx = null;
  });
  return opening;
}

/** The build's tool host (single-flight): every agent session of the build calls its tools on the one open index. */
function toolHost(s: KnodeState): Promise<ToolHost> {
  if (s.host) return s.host;
  const starting = startToolHost(() => open(s), KNODE_AGENT_TOOLS);
  s.host = starting;
  starting.catch(() => {
    if (s.host === starting) s.host = null;
  });
  return starting;
}

/** Close the tool host, then the context once an open still in flight has finished; an open after this waits for the close. */
async function close(s: KnodeState): Promise<void> {
  const host = s.host;
  s.host = null;
  if (host) await (await host.catch(() => null))?.close();
  const opened = s.ctx;
  if (!opened) return s.closing ?? undefined;
  s.ctx = null;
  const closing = (async () => {
    const ctx = await opened.catch(() => null);
    if (!ctx) return;
    await ctx.datasources.closeAll();
    await ctx.store.close();
  })();
  s.closing = closing;
  try {
    await closing;
  } finally {
    if (s.closing === closing) s.closing = null;
  }
}

/** What a build's index is and where, beside its workspace: what a reused copy of the workspace is reopened by. */
interface IndexRecord {
  kind: string;
  /** PostgreSQL: the build's schema in the evaluation database. */
  schema?: string;
  /** The workspace the index belongs to: a copy elsewhere (a reused build) does not own it. */
  workspace: string;
}

const indexRecordFile = (s: KnodeState) => path.join(s.ws, '.knode', 'eval-index.json');

function readIndexRecord(s: KnodeState): IndexRecord | null {
  try {
    return JSON.parse(fs.readFileSync(indexRecordFile(s), 'utf8')) as IndexRecord;
  } catch {
    return null;
  }
}

/** Note the build's index (and on PostgreSQL label its schema with the workspace, for `eval drop --orphaned`). */
async function recordIndex(s: KnodeState, ctx: AppContext): Promise<IndexRecord> {
  const cfg = ctx.config.database;
  const rec: IndexRecord = { kind: cfg.kind, workspace: path.resolve(s.ws), ...(cfg.kind === 'postgres' ? { schema: await markSchema(cfg, s.ws) } : {}) };
  fs.writeFileSync(indexRecordFile(s), JSON.stringify(rec, null, 2));
  return rec;
}

/**
 * A reused build's index, made this workspace's own: its work directory was copied, and with it an
 * embedded PGlite index; a PostgreSQL schema stays where it is, so it is cloned into this workspace's
 * (update batches change an index in place — two runs must not share one). Throws when it cannot be,
 * and the run builds afresh.
 */
async function adoptIndex(s: KnodeState, env: SystemEnv, cfg: KnodeConfig): Promise<void> {
  const rec = readIndexRecord(s);
  const kind = cfg.database.kind;
  if (kind !== 'postgres') {
    if (rec && rec.kind !== kind) throw new Error(`the build's index is on ${rec.kind}; this run keeps its indexes on ${kind}`);
    return;
  }
  if (!rec?.schema || rec.kind !== 'postgres') throw new Error(`the build's index is on ${rec?.kind ?? 'pglite (it has no index record)'}; this run keeps its indexes on ${describeDatabase(cfg.database)}`);
  if (rec.workspace === path.resolve(s.ws)) return;
  const t0 = Date.now();
  const cloned = await cloneSchema(cfg.database, rec.schema, s.ws, cfg.embedding.dimensions);
  fs.writeFileSync(indexRecordFile(s), JSON.stringify({ kind, schema: cloned.schema, workspace: path.resolve(s.ws) } satisfies IndexRecord, null, 2));
  env.log(`knode: cloned schema ${rec.schema} into ${cloned.schema} (${cloned.tables} tables, ${cloned.rows} rows, ${Date.now() - t0} ms)`);
}

/** `raw/docs/<x>` → corpus path `<x>`; a generated page → the documents it was made from. */
function toCorpus(s: KnodeState, p: string): string[] {
  if (p.startsWith('raw/docs/')) return [p.slice('raw/docs/'.length)];
  return s.pageSources.get(p) ?? [];
}

/**
 * The document a search hit stands for when ranking documents: a source chunk's
 * own, a summary page's one source, and none for a page made from several (an
 * entity page cites every document that mentions the entity). Counting such a
 * page as all of them put a dozen documents the search never ranked ahead of
 * the ones it did: on the pilot's MuSiQue questions knode's vector channel
 * scored 0.47 recall@5 that way and 0.60 by its source chunks, against 0.58
 * for the RAG baseline on the same vectors.
 */
function rankedDocument(s: KnodeState, p: string): string[] {
  const docs = toCorpus(s, p);
  return p.startsWith('raw/docs/') || docs.length === 1 ? docs : [];
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
      const config = evalWorkspaceConfig(env);
      fs.writeFileSync(path.join(s.ws, 'knode.config.json'), JSON.stringify(config, null, 2));
      // a build starts empty: on PostgreSQL the workspace's schema outlives its directory (an earlier, failed build)
      if (config.database.kind === 'postgres') await dropEvalWorkspace(s.ws, config.database);
      fs.cpSync(env.staged.dir, path.join(s.ws, 'raw', 'docs'), { recursive: true });
      const ctx = await open(s);
      const index = await recordIndex(s, ctx);
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
        notes: { ...counts, database: describeDatabase(ctx.config.database), ...(index.schema ? { schema: index.schema } : {}), ...passes, passConcurrency: ctx.config.extraction.concurrency, judgeConcurrency: ctx.config.review?.directConcurrency ?? 1, passBatch: ctx.config.extraction.batchSize, wikiPages: pages.length, refined, indexed: synced.indexed, stageMs: { sync: tSync, documentPasses: tPasses, wiki: Date.now() - t0 - tSync - tPasses } },
      };
    },
    async reopen(env) {
      const s = stateFor(env);
      if (!fs.existsSync(path.join(s.ws, 'knode.config.json'))) throw new Error(`no knode workspace to reopen at ${s.ws}`);
      // the shim's port changed since the build: repoint the workspace at this run's shim (and its database)
      const config = evalWorkspaceConfig(env);
      fs.writeFileSync(path.join(s.ws, 'knode.config.json'), JSON.stringify(config, null, 2));
      await adoptIndex(s, env, config);
      readPageSources(s);
    },
    async release(env) {
      await close(stateFor(env));
    },
    ...extra,
  };
}

export function knodeAsk(): SystemUnderTest {
  // as wide as the run's answer concurrency: every answer shares the one open context (docs/design/31 D2)
  return knodeSystem('knode-ask', 'knode-os ask (hybrid retrieval, cited answer)', 'kb', true, {
    async answer(task, prompt, env) {
      const s = stateFor(env);
      const ctx = await open(s);
      // ask retrieves with its question: give it the question alone, and the shared output rules to its model call
      const rules = prompt.startsWith(task.question) ? prompt.slice(task.question.length) : '';
      const llm = withAppendedRules(shimClient(env, { system: 'knode-ask', stage: 'answer', task: task.id }), rules);
      // against the index as built: an answer records no hits, so no question moves another's ranking (docs/design/31 D3)
      const res = await ask(ctx.store, ctx.config, ctx.embedder, llm, task.question, { mode: 'hybrid', track: false });
      // ask's own [n] citations, and any [doc: path] the answer wrote under the shared output rules
      const docs = new Set(env.staged.docs.map((d) => d.path));
      const citations: Citation[] = [...new Set([...res.citations.flatMap((c) => toCorpus(s, c.path)), ...citationsIn(res.answer, docs).map((c) => c.doc)])].map((doc) => ({ doc }));
      return { text: res.answer, citations, retrieved: [...new Set(res.contexts.flatMap((c) => toCorpus(s, c.path)))] };
    },
    async retrieve(query, k, env) {
      const ctx = await open(stateFor(env));
      const hits = await search(ctx.store, ctx.embedder, query, { k: k * 3, mode: 'hybrid', track: false, heat: ctx.config.heat, rerank: ctx.config.retrieval.rerank, current: false });
      return [...new Set(hits.flatMap((h) => rankedDocument(stateFor(env), h.path)))].slice(0, k);
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
      const hits = await search(ctx.store, ctx.embedder, query, { k: k * 3, mode: 'sag', track: false, heat: ctx.config.heat, sag: ctx.config.retrieval.sag, rerank: ctx.config.retrieval.rerank, current: false });
      return [...new Set(hits.flatMap((h) => rankedDocument(s, h.path)))].slice(0, k);
    },
  });
}

/** Close every knode workspace a run holds open under `dir` (a run that ends, or is cancelled, mid-pack). */
export async function closeKnodeStates(dir: string): Promise<void> {
  const root = path.resolve(dir) + path.sep;
  for (const [workDir, s] of states) if (path.resolve(workDir).startsWith(root)) await close(s).catch(() => {});
}

export function agentKnode(): SystemUnderTest {
  // as wide as the run's session slots: every session calls the build's one tool host (docs/design/31 D4)
  return knodeSystem('agent-knode', 'Codex agent with knode MCP retrieval tools', 'agent', true, {
    async answer(task, prompt, env) {
      const s = stateFor(env);
      const host = await toolHost(s);
      await env.quota.wait();
      const tmp = evalTempDir('mcp');
      const empty = tmp.root;
      try {
        const r = await runAgent({
          cwd: empty,
          sandbox: 'read-only',
          model: env.models.model,
          effort: env.models.answerEffort,
          prompt: `${knodeAgentBrief()}\n\n${prompt}`,
          mcp: { name: 'knode', url: host.url, token: host.secret, enabledTools: KNODE_AGENT_TOOLS },
        });
        recordAgent(env.meter, { system: 'agent-knode', stage: 'agent', task: task.id }, env.models.model, r);
        const docs = new Set(env.staged.docs.map((d) => d.path));
        const citations = [...new Set([
          ...citationsIn(r.text, docs).map((c) => c.doc),
          ...[...r.text.matchAll(/wiki\/[^\s)\]'"`，。]+\.md/g)].flatMap((m) => toCorpus(s, m[0])),
        ])].map((doc) => ({ doc }));
        return { text: r.text, citations, toolCalls: r.toolCalls, commands: r.commands, capped: r.capped, leaked: r.leaked, error: r.error };
      } finally {
        tmp.cleanup();
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
          toolCalls: r.toolCalls, commands: r.commands,
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

export function agentKnodeWikiSources(): SystemUnderTest {
  return knodeSystem('agent-knode-wiki-sources', 'Codex agent reading the knode-generated wiki and the sources', 'agent', true, {
    async answer(task, prompt, env) {
      const s = stateFor(env);
      await env.quota.wait();
      // the pages cite raw/docs/<path>: the sources sit where those links point
      const copy = wikiWithSources(path.join(s.ws, 'wiki'), env.staged.dir, 'wiki', 'raw/docs');
      try {
        const r = await runAgent({
          cwd: copy.dir,
          sandbox: 'read-only',
          model: env.models.model,
          effort: env.models.answerEffort,
          prompt: `${WIKI_SOURCES_BRIEF('wiki/, generated pages; sources/ holds one summary per document', 'raw/docs/')}\n\n${prompt}`,
        });
        recordAgent(env.meter, { system: 'agent-knode-wiki-sources', stage: 'agent', task: task.id }, env.models.model, r);
        const docs = new Set(env.staged.docs.map((d) => d.path));
        return {
          text: r.text,
          citations: citationsIn(r.text, docs),
          retrieved: [...new Set(r.filesTouched.flatMap((f) => toCorpus(s, f)))],
          toolCalls: r.toolCalls, commands: r.commands,
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
    units.push({ id: `entity:${e.id}`, kind: 'entity', title: e.name, text: `${e.name} (${e.type}): ${e.description}`.trim() + (aliases.length ? `\naliases: ${aliases.join(', ')}` : ''), sources: sourcesOf.get(e.id) ?? [], links: [] });
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
