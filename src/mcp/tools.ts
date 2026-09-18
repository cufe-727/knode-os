import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AppContext } from '../context.js';
import { runSourceQuery } from '../datasource/execute.js';
import { MAX_FILE_BYTES } from '../constants.js';
import { assertSourcePath, assertWritablePath, grepFiles, listTree, safePath, writeFileText } from '../fs/files.js';
import { assertNotConvertedOriginal, readSourceTextCapped } from '../ingest/source.js';
import { graphInsights, graphSearch } from '../graph/query.js';
import { sync } from '../ingest/sync.js';
import { historyOf, lineageOf } from '../lineage/inspect.js';
import { forgetSource } from '../lineage/purge.js';
import { buildContextPack } from '../pack/pack.js';
import { search } from '../search/search.js';
import { ask } from '../search/ask.js';
import { planOnly, resolve } from '../compiler/resolve.js';
import { liveAbsences } from '../compiler/absence.js';
import { distillRecipes } from '../compiler/distill.js';
import { evaluatePacks } from '../compiler/evaluate.js';
import { writeRankerReport } from '../compiler/ranker.js';
import { changesSince, listSubscriptions, subscribe, unsubscribe } from '../compiler/subscribe.js';
import { checkout, commitWorkset, envelopeFor, listWorksets } from '../compiler/workset.js';
import { listDisputes, resolveDispute, setScopeTrust } from '../lineage/trust.js';
import { recordFeedback } from '../compiler/receipts.js';
import { isVirtualPath, readVirtual } from '../compiler/vfs.js';
import { renderCapabilityDts } from '../capability/dts.js';
import { listCapabilities, locatorsForEntities } from '../capability/store.js';
import { queryClaims } from '../store/claims.js';
import { CATALOG_SOURCE, CATALOG_VIEWS, catalogQuery } from '../store/catalog.js';
import { resolveScopeFilter, resolveTemporal } from '../store/resolver.js';
import { listDatasets, listSuggestions } from '../store/queries.js';
import { validateOkfBundle } from '../okf/index.js';
import { cancelJob, getJob, listJobs, queueJob } from '../research/jobs.js';
import { killAgentsFor } from '../research/launch.js';
import { surveyKnowledgeBase } from '../research/survey.js';
import { loadResearchTemplates, RESEARCH_KINDS, ResearchKind } from '../research/templates.js';

/**
 * The knode-os tool surface, independent of transport. The stdio server
 * (`knode-os mcp`) and the Streamable HTTP endpoint `serve` mounts at /mcp
 * both register exactly this set, so an agent sees the same tools whichever
 * way it connects.
 */
export function registerKnodeTools(server: McpServer, ctx: AppContext): void {
  const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
  const asOfSchema = z.string().optional().describe('System time (ISO 8601): answer from what the knowledge base contained at that instant');
  const validAtSchema = z.string().optional().describe('World time (ISO 8601): only claims whose validity window contains this instant');
  const validRangeSchema = z.string().optional().describe('World time window instead of an instant: "2026-01-01..2026-06-30", "2026-08" (that month), "2026" (that year), or "2026-03-01.." (open ended). Mutually exclusive with valid_at.');
  const kindsSchema = z.array(z.enum(['doc', 'wiki', 'view', 'skill'])).optional()
    .describe('Restrict to source kinds: doc = raw/docs, wiki = human-written wiki prose, view = generated wiki page, skill = raw/skills');
  const sourcesSchema = z.array(z.string()).optional()
    .describe('Restrict to path prefixes, e.g. ["raw/docs/reports"]');
  const freshnessSchema = z.string().optional().describe('Max age of live/federated reads: "30s", "15m", "2h", "7d". Cached probe answers older than this are re-run.');
  const actorSchema = z.string().optional().describe('Who is asking — restricted sources answer only to actors named on their ACL');
  const trustSchema = z.enum(['trusted', 'quarantined', 'any']).optional()
    .describe('Trust tier: agent writes land quarantined until promoted. Default any — pass "trusted" to exclude unreviewed agent writes.');

  server.registerTool(
    'knode_search',
    {
      title: 'Search the knowledge base',
      description: 'Search docs, wiki and skills. Mode sag adds query-time chunk/entity multi-hop expansion with retrieval traces. as_of restricts to documents that were live at that system time; kinds/sources restrict which sources may answer (the sag expansion honours them too, so a scoped walk cannot escape through a shared entity).',
      inputSchema: {
        query: z.string().describe('Natural-language or keyword query'),
        k: z.number().int().min(1).max(50).optional().describe('Max results (default 8)'),
        mode: z.enum(['hybrid', 'vector', 'keyword', 'sag']).optional(),
        as_of: asOfSchema,
        kinds: kindsSchema,
        sources: sourcesSchema,
        trust: trustSchema,
        actor: actorSchema,
      },
    },
    async ({ query, k, mode, as_of, kinds, sources, trust, actor }) => {
      const results = await search(ctx.store, ctx.embedder, query, {
        k: k ?? 8,
        mode: mode ?? 'hybrid',
        heat: ctx.config.heat,
        sag: ctx.config.retrieval.sag,
        asOf: as_of,
        filter: resolveScopeFilter({ kinds, sources, trust, actor }),
      });
      return json(results.map((r) => ({
        path: r.path,
        title: r.title,
        score: +r.score.toFixed(4),
        signals: r.signals,
        trace: r.trace,
        content: r.content,
      })));
    },
  );

  server.registerTool(
    'knode_graph_search',
    {
      title: 'Search the knowledge graph',
      description: 'Find entities matching the query and expand the graph around them (multi-hop). Returns nodes, typed edges (with their validity window when known), grounding chunks and claims. as_of recomputes nodes/edges from evidence at that system time; valid_at / valid_range filter claims and time-bound edges by world time; kinds/sources restrict which sources may support a node or edge.',
      inputSchema: {
        query: z.string(),
        depth: z.number().int().min(1).max(4).optional().describe('Expansion hops (default 2)'),
        as_of: asOfSchema,
        valid_at: validAtSchema,
        valid_range: validRangeSchema,
        kinds: kindsSchema,
        sources: sourcesSchema,
        trust: trustSchema,
        actor: actorSchema,
      },
    },
    async ({ query, depth, as_of, valid_at, valid_range, kinds, sources, trust, actor }) =>
      json(await graphSearch(ctx.store, query, {
        depth: depth ?? 2,
        heat: ctx.config.heat,
        temporal: resolveTemporal({ asOf: as_of, validAt: valid_at, validRange: valid_range }),
        filter: resolveScopeFilter({ kinds, sources, trust, actor }),
      })),
  );

  server.registerTool(
    'knode_ask',
    {
      title: 'Ask the knowledge base',
      description: 'RAG answer with [n] citations and explicit gaps. Requires llm.model configured; otherwise returns retrieved context.',
      inputSchema: {
        question: z.string(),
        mode: z.enum(['hybrid', 'vector', 'keyword', 'sag']).optional().describe('Retrieval mode (default hybrid)'),
      },
    },
    async ({ question, mode }) => {
      const res = await ask(ctx.store, ctx.config, ctx.embedder, ctx.llm, question, { mode: mode ?? 'hybrid' });
      return json({ answer: res.answer, citations: res.citations, gaps: res.gaps });
    },
  );

  server.registerTool(
    'knode_ls',
    {
      title: 'List knowledge files',
      description: 'List the data directory tree (raw/docs, raw/traces, raw/skills, wiki, playbooks, ledger).',
      inputSchema: { path: z.string().optional().describe('Subdirectory, e.g. "wiki" (default: root)') },
    },
    async ({ path: p }) => json(listTree(ctx.dataDir, p ?? '.')),
  );

  server.registerTool(
    'knode_read',
    {
      title: 'Read a knowledge file',
      description: 'Read a file by its path relative to the data directory, e.g. "wiki/index.md". A PDF or image under raw/docs returns the Markdown knode-os derived from it. A path starting with "/" reads the virtual filesystem instead — /entities/<id>.md, /claims/<subject>.md, /capabilities/<source>/<name>.md, /live/<capability>?<param>=<value> — rendered on read, and every one of them accepts ?as_of=<iso>. Read "/" for the roots.',
      inputSchema: { path: z.string() },
    },
    async ({ path: p }) => {
      if (isVirtualPath(p)) return { content: [{ type: 'text' as const, text: await readVirtual(ctx, p) }] };
      const file = readSourceTextCapped(ctx.dataDir, p, MAX_FILE_BYTES);
      if (!file) throw new Error(`no derived text for ${p} yet — run knode_sync first`);
      return { content: [{ type: 'text' as const, text: file.content }] };
    },
  );

  server.registerTool(
    'knode_write',
    {
      title: 'Write a knowledge file',
      description: 'Create or overwrite a file under wiki/, raw/docs/ or playbooks/packs/, or the root AGENTS.md / CLAUDE.md knowledge-base guide (other roots are read-only). A source file is applied as a new scope on the next sync; the guide is never indexed.',
      inputSchema: { path: z.string(), content: z.string() },
    },
    async ({ path: p, content }) => {
      assertWritablePath(p);
      assertNotConvertedOriginal(p);
      writeFileText(ctx.dataDir, p, content);
      return json({ ok: true, path: p });
    },
  );

  server.registerTool(
    'knode_ingest',
    {
      title: 'Sync the knowledge base',
      description: 'Reconcile declared sources (docs/wiki/skills/datasources) with the index: apply changed files, dispose removed ones (reverting everything they produced), regenerate dependent wiki pages.',
      inputSchema: {},
    },
    async () => json(await sync(ctx)),
  );

  server.registerTool(
    'knode_sync',
    {
      title: 'Sync sources (scoped)',
      description: 'Same as knode_ingest but optionally restricted to path prefixes (e.g. ["raw/docs/reports"]) or "datasources"; verify=true recounts folds and repairs ledger/pages drift.',
      inputSchema: {
        only: z.array(z.string()).optional(),
        verify: z.boolean().optional(),
      },
    },
    async ({ only, verify }) => json(await sync(ctx, { only, verify })),
  );

  server.registerTool(
    'knode_lineage',
    {
      title: 'Lineage of a graph row or page',
      description: 'Why does the knowledge base believe this? Lists every live and historical evidence row (source scope, extractor, weight, system-time window) behind an entity/relation/claim, the inputs a page was built from, or the scope history of a document.',
      inputSchema: {
        kind: z.enum(['entity', 'relation', 'claim', 'page', 'document']),
        id: z.string().describe('Entity slug, relation/claim id, page path (wiki/…), or document path'),
      },
    },
    async ({ kind, id }) => json(await lineageOf(ctx.store, kind, id)),
  );

  server.registerTool(
    'knode_history',
    {
      title: 'Apply/dispose history of a source',
      description: 'Scopes and ledger events for a document path, datasource id or page path — when it was applied, replaced, removed or purged.',
      inputSchema: { path: z.string() },
    },
    async ({ path: p }) => json(await historyOf(ctx.store, ctx.dataDir, p)),
  );

  server.registerTool(
    'knode_forget',
    {
      title: 'Forget a source',
      description: 'Delete a file under raw/docs/ or wiki/, dispose everything it produced (entities, edges, claims it alone supported, generated pages), and purge its history so it cannot be reconstructed. Use knode_write/delete + sync for a reversible removal instead.',
      inputSchema: { path: z.string() },
    },
    async ({ path: p }) => {
      assertSourcePath(p);
      return json(await forgetSource(ctx, p));
    },
  );

  server.registerTool(
    'knode_okf_validate',
    {
      title: 'Validate an OKF knowledge bundle',
      description: 'Validate Google Open Knowledge Format conformance. Defaults to the native wiki/ bundle; path must be relative to the data directory. as_indexed validates the view knode-os indexes (frontmatter normalizer applied in memory) — what an unannotated raw/docs subtree looks like to the pipeline.',
      inputSchema: {
        path: z.string().optional().describe('Bundle directory, e.g. "wiki" or "raw/docs/okf/team"'),
        as_indexed: z.boolean().optional(),
      },
    },
    async ({ path: p, as_indexed }) => json(validateOkfBundle(safePath(ctx.dataDir, p ?? 'wiki'), { asIndexed: Boolean(as_indexed) })),
  );

  server.registerTool(
    'knode_graph_insights',
    {
      title: 'Knowledge graph insights',
      description: 'Graph health: totals, hub entities, isolated entities, type distribution.',
      inputSchema: {},
    },
    async () => json(await graphInsights(ctx.store)),
  );

  server.registerTool(
    'knode_survey',
    {
      title: 'Survey the knowledge base',
      description: 'What this knowledge base holds, in numbers: documents by folder and date range, entities by type with the top ones, relation predicates (and unknown ones), claims by status, wiki pages (generated / written / researched), the ontology packs in force, live datasources, the extraction backlog, and whether an AGENTS.md guide exists. The orientation call for an agent that has not seen this base before; read the guide itself with knode_read "AGENTS.md".',
      inputSchema: {},
    },
    async () => json(await surveyKnowledgeBase(ctx)),
  );

  server.registerTool(
    'knode_suggestions',
    {
      title: 'Dream suggestions',
      description: 'Improvement suggestions from the nightly dream (skills / memory / knowledge / playbook revisions). Status stale = an input the suggestion relied on was removed.',
      inputSchema: { status: z.enum(['pending', 'accepted', 'rejected', 'stale']).optional() },
    },
    async ({ status }) => json(await listSuggestions(ctx.store, { status: status ?? 'pending', limit: 50 })),
  );

  server.registerTool(
    'knode_context_pack',
    {
      title: 'Build a context pack',
      description:
        'One-shot context assembly for an utterance: matches entities, pulls the docs/claims/live-tables linked to them in the knowledge graph, runs playbook probe queries against live sources (with asOf timestamps), and returns gap analysis + concrete next queries. Call this FIRST when a user mentions a company/product/entity. as_of / valid_at answer from an earlier state.',
      inputSchema: {
        utterance: z.string().describe('The user request, verbatim'),
        as_of: asOfSchema,
        valid_at: validAtSchema,
        valid_range: validRangeSchema,
        freshness: freshnessSchema,
        kinds: kindsSchema,
        sources: sourcesSchema,
      },
    },
    async ({ utterance, as_of, valid_at, valid_range, freshness, kinds, sources }) => json(await buildContextPack(ctx, utterance, {
      temporal: resolveTemporal({ asOf: as_of, validAt: valid_at, validRange: valid_range, freshness }),
      filter: resolveScopeFilter({ kinds, sources }),
    })),
  );

  server.registerTool(
    'knode_claims',
    {
      title: 'Query claims directly',
      description:
        'Time-bound assertions as structured rows, instead of prose you have to read and trust. Each claim carries its world-time validity window, its status among conflicting sources (fact / suspected / disputed), the source path that supports it and how many evidence rows back it. Use this when the question is "what do we hold about X, and since when" — as_of asks what was believed then, valid_at / valid_range ask what holds in the world, and stale=true means the validity window has already closed.',
      inputSchema: {
        subject: z.string().optional().describe('Entity id, name or alias the claim is about'),
        object: z.string().optional().describe('Entity id, name or alias on the other side of the claim'),
        types: z.array(z.string()).optional().describe('Claim types, e.g. ["earnings", "guidance"]'),
        statuses: z.array(z.enum(['fact', 'suspected', 'disputed', 'absent'])).optional()
          .describe('absent = negative knowledge: a lookup that came back empty, with the window it holds for'),
        text: z.string().optional().describe('Substring of the statement'),
        event_range: z.string().optional().describe('Only claims whose event time falls in this window: "2026-01-01..2026-06-30", "2026Q2", "2026"'),
        include_superseded: z.boolean().optional().describe('Also return facts a newer fact of the same subject and type replaced (hidden by default)'),
        order: z.enum(['recent', 'timeline']).optional().describe('timeline = by event time ascending, for building a chronology'),
        limit: z.number().int().min(1).max(500).optional().describe('Default 50'),
        as_of: asOfSchema,
        valid_at: validAtSchema,
        valid_range: validRangeSchema,
        kinds: kindsSchema,
        sources: sourcesSchema,
        trust: trustSchema,
        actor: actorSchema,
      },
    },
    async ({ subject, object, types, statuses, text, event_range, include_superseded, order, limit, as_of, valid_at, valid_range, kinds, sources, trust, actor }) =>
      json(await queryClaims(ctx.store, {
        subject, object, types, statuses, text, limit,
        eventRange: event_range ? (({ validFrom, validTo }) => ({ from: validFrom, to: validTo }))(resolveTemporal({ validRange: event_range })) : undefined,
        includeSuperseded: include_superseded,
        order,
        temporal: resolveTemporal({ asOf: as_of, validAt: valid_at, validRange: valid_range }),
        filter: resolveScopeFilter({ kinds, sources, trust, actor }),
      })),
  );

  server.registerTool(
    'knode_resolve',
    {
      title: 'Resolve a question into ready context plus a plan',
      description:
        'The one call to make before answering. Instead of returning whatever text matches, it works out what an answer to this kind of question NEEDS (the intent\'s slots), fills everything the local index can answer, and compiles what is left into a plan of tool calls for you to execute. Read `slots` to see what is covered, `unknowns` for required things nothing can fill (answer around them and say so — do not invent them), `plan.nodes` for the work to do, and `availableNextQueries` for what is worth running first. Report back with knode_feedback and the returned receiptId so the next resolve for this kind of question is better.',
      inputSchema: {
        query: z.string().describe('The user request, verbatim'),
        actor: z.string().optional().describe('Who is asking — recorded on the receipt, and used for ACL checks'),
        workset: z.string().optional().describe('Workset id from knode_checkout: answers at the instant it pinned'),
        render: z.enum(['json-graph', 'ts-program']).optional().describe('ts-program also returns the plan as runnable code'),
        max_tool_calls: z.number().int().min(1).max(32).optional(),
        as_of: asOfSchema,
        valid_at: validAtSchema,
        valid_range: validRangeSchema,
        freshness: freshnessSchema,
        kinds: kindsSchema,
        sources: sourcesSchema,
        trust: trustSchema,
      },
    },
    async ({ query, actor, workset, render, max_tool_calls, as_of, valid_at, valid_range, freshness, kinds, sources, trust }) =>
      json(await resolve(ctx, query, {
        actor,
        render,
        budget: max_tool_calls ? { maxToolCalls: max_tool_calls } : undefined,
        temporal: await envelopeFor(ctx.store, { workset, asOf: as_of, validAt: valid_at, validRange: valid_range, freshness }),
        filter: resolveScopeFilter({ kinds, sources, trust, actor }),
      })),
  );

  server.registerTool(
    'knode_plan',
    {
      title: 'Just the plan for a question',
      description:
        'The plan knode_resolve would hand you, without the context pack — for when you already have the context and want the remaining work. `phases` groups nodes that can run in parallel; nodes in a later phase depend on an earlier one. Budgets on the plan are advisory: knode enforces its own read-only, row-cap and ACL limits on every call regardless.',
      inputSchema: {
        query: z.string(),
        render: z.enum(['json-graph', 'ts-program']).optional(),
        max_tool_calls: z.number().int().min(1).max(32).optional(),
        as_of: asOfSchema,
        freshness: freshnessSchema,
      },
    },
    async ({ query, render, max_tool_calls, as_of, freshness }) =>
      json(await planOnly(ctx, query, {
        render,
        budget: max_tool_calls ? { maxToolCalls: max_tool_calls } : undefined,
        temporal: resolveTemporal({ asOf: as_of, freshness }),
      })),
  );

  server.registerTool(
    'knode_feedback',
    {
      title: 'Report what a plan actually did',
      description:
        'Close the loop on a knode_resolve: which nodes you ran, whether they worked, and which returned ids you actually used. This is what teaches the planner which source answers a slot rather than merely responding to it — an unreported resolve teaches nothing. If you had to rewrite the plan to make it work, send the rewrite as revised_plan; it becomes a candidate recipe rather than being applied blindly.',
      inputSchema: {
        receipt_id: z.string().describe('The receiptId from knode_resolve'),
        executed: z.array(z.object({
          nodeId: z.string(),
          slot: z.string().optional(),
          capability: z.string().optional(),
          ok: z.boolean(),
          elapsedMs: z.number().optional(),
          rows: z.number().optional(),
          tokens: z.number().optional(),
          error: z.string().optional(),
        })).optional(),
        used_ids: z.array(z.string()).optional().describe('Node ids / chunk ids whose results made it into the answer'),
        ignored_ids: z.array(z.string()).optional(),
        outcome: z.string().optional().describe('answered | partial | failed, or a short note'),
        revised_plan: z.unknown().optional(),
      },
    },
    async ({ receipt_id, executed, used_ids, ignored_ids, outcome, revised_plan }) =>
      json(await recordFeedback(ctx.store, {
        receiptId: receipt_id,
        executed,
        usedIds: used_ids,
        ignoredIds: ignored_ids,
        outcome,
        revisedPlan: revised_plan,
      })),
  );

  server.registerTool(
    'knode_checkout',
    {
      title: 'Pin a consistent view for a long task',
      description:
        'Freeze system time so every later call answers from the same instant. A research session that spans a sync would otherwise see the knowledge base change under it, and report a contradiction that is really two reads taken either side of an ingest. Pass the returned id as `workset` to knode_resolve / knode_search. Finish with knode_commit to write your conclusions back as a source.',
      inputSchema: {
        actor: z.string().optional(),
        note: z.string().optional().describe('What this session is for'),
        entities: z.array(z.string()).optional(),
        as_of: asOfSchema,
      },
    },
    async ({ actor, note, entities, as_of }) => json(await checkout(ctx.store, { actor, note, entities, asOf: as_of })),
  );

  server.registerTool(
    'knode_commit',
    {
      title: 'Write a workset\'s conclusions back as a source',
      description:
        'Save what the task concluded as an ordinary document under raw/docs/notes/ — chunked, attributable and revertible like any other source on the next sync. Agent-written sources land quarantined: searchable and cited, but they cannot silently override a trusted claim; where they disagree, a dispute is opened for review.',
      inputSchema: {
        workset: z.string().describe('Workset id from knode_checkout'),
        content: z.string().describe('Markdown body'),
        title: z.string().optional(),
        path: z.string().optional().describe('Override the destination (must be a writable root)'),
        keep_open: z.boolean().optional(),
      },
    },
    async ({ workset, content, title, path: p, keep_open }) =>
      json(await commitWorkset(ctx, { worksetId: workset, content, title, path: p, keepOpen: keep_open })),
  );

  server.registerTool(
    'knode_worksets',
    {
      title: 'List worksets',
      description: 'Pinned views, open and committed.',
      inputSchema: { actor: z.string().optional(), open: z.boolean().optional() },
    },
    async ({ actor, open }) => json(await listWorksets(ctx.store, { actor, open })),
  );

  server.registerTool(
    'knode_subscribe',
    {
      title: 'Watch an entity, source or intent for changes',
      description:
        'Register interest and poll it. The cursor is a system time, not a queue position, so a subscriber that was away still sees everything since — and two subscribers never consume each other\'s events. Call with action="changes" to read (and advance); peek=true reads without advancing, for when you might not finish handling them.',
      inputSchema: {
        action: z.enum(['subscribe', 'unsubscribe', 'list', 'changes']).describe('What to do'),
        kind: z.enum(['entity', 'source', 'intent']).optional().describe('For subscribe: what to watch'),
        target: z.string().optional().describe('For subscribe: entity id, path prefix or intent id'),
        id: z.string().optional().describe('For unsubscribe / changes'),
        actor: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        peek: z.boolean().optional().describe('For changes: do not advance the cursor'),
      },
    },
    async ({ action, kind, target, id, actor, limit, peek }) => {
      if (action === 'subscribe') {
        if (!kind || !target) throw new Error('subscribe needs kind and target');
        return json(await subscribe(ctx.store, { kind, target, actor }));
      }
      if (action === 'unsubscribe') {
        if (!id) throw new Error('unsubscribe needs id');
        return json({ removed: await unsubscribe(ctx.store, id) });
      }
      if (action === 'changes') {
        if (!id) throw new Error('changes needs id');
        return json(await changesSince(ctx.store, id, { limit, advance: !peek }));
      }
      return json(await listSubscriptions(ctx.store, actor));
    },
  );

  server.registerTool(
    'knode_absences',
    {
      title: 'What we looked for and did not find',
      description:
        'Negative knowledge: bindings that came back empty, with the window they are believed empty for. Check this before spending a call on something the knowledge base already knows is not there — and note the expiry: "nothing there" is true of a moment, not forever.',
      inputSchema: { entities: z.array(z.string()).describe('Entity ids'), as_of: asOfSchema },
    },
    async ({ entities, as_of }) => json(await liveAbsences(ctx.store, entities, as_of)),
  );

  server.registerTool(
    'knode_disputes',
    {
      title: 'Contradictions between sources',
      description:
        'Where a quarantined write disagrees with a trusted claim, the disagreement is recorded rather than resolved by overwriting. List them, or resolve one once a person has decided. Promoting the quarantined source (knode_trust) resolves the disputes it opened.',
      inputSchema: {
        action: z.enum(['list', 'resolve']).optional(),
        id: z.string().optional().describe('For resolve'),
        status: z.string().optional().describe('open | resolved (list only)'),
        actor: z.string().optional(),
      },
    },
    async ({ action, id, status, actor }) => {
      if (action === 'resolve') {
        if (!id) throw new Error('resolve needs id');
        return json({ resolved: await resolveDispute(ctx.store, id, actor) });
      }
      return json(await listDisputes(ctx.store, { status: status ?? 'open' }));
    },
  );

  server.registerTool(
    'knode_trust',
    {
      title: 'Promote or demote a source',
      description:
        'Move a source between trust tiers. Agent writes start quarantined — visible and attributable, but excluded when a caller asks for trusted-only, and unable to override a trusted claim. Promoting resolves the disputes that source opened, because the review is what the quarantine was waiting for.',
      inputSchema: {
        path: z.string().describe('Source key, e.g. "raw/docs/notes/w_ab12.md"'),
        to: z.enum(['trusted', 'quarantined']),
        actor: z.string().optional(),
      },
    },
    async ({ path: p, to, actor }) => json(await setScopeTrust(ctx.store, { key: p, to, actor })),
  );

  server.registerTool(
    'knode_learning',
    {
      title: 'What the planner has learned',
      description:
        'The capability ranking (which source actually answers which slot, from receipts), pack precision (used over returned), and the recipe candidates distillation would propose. Regenerates wiki/learning/ so the numbers steering the planner stay reviewable by a person.',
      inputSchema: {
        lookback_days: z.number().int().min(1).max(365).optional(),
        intent: z.string().optional(),
        distill: z.boolean().optional().describe('Also propose recipes for plan shapes that keep working'),
      },
    },
    async ({ lookback_days, intent, distill }) => {
      const ranking = await writeRankerReport(ctx.store, { intent });
      const evaluation = await evaluatePacks(ctx.store, { lookbackDays: lookback_days });
      const distilled = distill ? await distillRecipes(ctx.store, { lookbackDays: lookback_days, intent }) : null;
      return json({
        ranking: { path: ranking.path, rows: ranking.rows },
        evaluation,
        distilled: distilled && {
          shapes: distilled.shapes,
          proposed: distilled.suggestions.map((s) => ({ id: s.id, title: s.title, body: s.body })),
          rejected: distilled.candidates.filter((c) => !c.ok).map((c) => ({ signature: c.shape.signature, reason: c.reason })),
        },
      });
    },
  );

  server.registerTool(
    'knode_research',
    {
      title: 'Deep-research wiki pages',
      description:
        'Ask knode-os to have a coding-agent CLI research a topic and write a wiki page (entity / concept / comparison / timeline / question / refresh). action=queue adds a job (deduplicated; runs while `serve` is up and research.agent is configured), init queues a knowledge-base initialization (extraction, then an overview page plus the AGENTS.md guide, with follow-up topic pages queued), list shows recent jobs, status shows one job with its outcome and warnings, cancel stops a job and kills its running sessions, templates lists the page templates under playbooks/research. Pages written this way land quarantined until a person promotes them.',
      inputSchema: {
        action: z.enum(['queue', 'init', 'list', 'status', 'cancel', 'templates']),
        kind: z.enum(RESEARCH_KINDS as [ResearchKind, ...ResearchKind[]]).optional().describe('For queue (default entity; question uses `query`)'),
        target: z.string().optional().describe('Entity / concept name, "A vs B" for comparison, or a wiki page path for refresh'),
        query: z.string().optional().describe('For kind=question: the question to answer and file as a page'),
        template: z.string().optional().describe('Template file stem under playbooks/research (default: the kind)'),
        id: z.string().optional().describe('Job id for status / cancel'),
        status: z.enum(['queued', 'running', 'validating', 'done', 'failed', 'cancelled']).optional().describe('For list'),
      },
    },
    async ({ action, kind, target, query, template, id, status }) => {
      if (action === 'queue') {
        const k = kind ?? (query && !target ? 'question' : 'entity');
        return json(await queueJob(ctx.store, { kind: k, target, query, template, requestedBy: 'mcp' }));
      }
      if (action === 'init') {
        return json(await queueJob(ctx.store, { kind: 'init', requestedBy: 'mcp' }));
      }
      if (action === 'status') {
        if (!id) throw new Error('status needs id');
        return json(await getJob(ctx.store, id));
      }
      if (action === 'cancel') {
        if (!id) throw new Error('cancel needs id');
        const cancelled = await cancelJob(ctx.store, id);
        return json({ cancelled, killed: cancelled ? killAgentsFor(id) : 0 });
      }
      if (action === 'templates') {
        return json([...loadResearchTemplates(ctx.dataDir).values()].map((t) => ({ name: t.name, kind: t.kind, output: t.output, requires: t.requires, path: t.path })));
      }
      return json(await listJobs(ctx.store, { status, limit: 50 }));
    },
  );

  server.registerTool(
    'knode_capabilities',
    {
      title: 'What can be asked, and of which source',
      description:
        'The capability catalog: every table, endpoint, metric and built-in tool this knowledge base can reach, with its schema, the semantics people wrote about it (metric definitions, join paths, pitfalls), its typical freshness and its relative cost. Ask for format="dts" to get a TypeScript declaration to write a program against. Pass an entity to see only what can actually be reached for it, together with the locators — the parameter and value to bind, e.g. symbol = "300750".',
      inputSchema: {
        source: z.string().optional().describe('Restrict to one datasource id'),
        kind: z.enum(['table', 'endpoint', 'metric', 'tool']).optional(),
        entity: z.string().optional().describe('Entity id: only capabilities reachable for it, plus how to bind them'),
        format: z.enum(['json', 'dts']).optional().describe('dts returns a TypeScript declaration instead of JSON'),
        as_of: asOfSchema,
      },
    },
    async ({ source, kind, entity, format, as_of }) => {
      const capabilities = await listCapabilities(ctx.store, {
        sourceIds: source ? [source] : undefined,
        kinds: kind ? [kind] : undefined,
        entityIds: entity ? [entity] : undefined,
        asOf: as_of,
      });
      if (format === 'dts') {
        return { content: [{ type: 'text' as const, text: renderCapabilityDts(capabilities) }] };
      }
      const locators = entity ? await locatorsForEntities(ctx.store, [entity], as_of) : [];
      return json({ capabilities, locators });
    },
  );

  server.registerTool(
    'knode_datasources',
    {
      title: 'List live data sources',
      description: 'Configured external sources (mysql/timescale/duckdb) and their registered tables: schema columns, row counts, linked entity counts, freshness. Rows are never indexed — query them with knode_query. Also lists the built-in "catalog" source: read-only views over the knowledge base itself, for shapes the fixed tools do not expose.',
      inputSchema: {},
    },
    async () => {
      const datasets = await listDatasets(ctx.store);
      return json({
        sources: [
          ...ctx.datasources.list().map((d) => ({ id: d.id, kind: d.kind, description: d.description ?? '' })),
          { id: CATALOG_SOURCE, kind: 'catalog', description: 'the knowledge base itself, as read-only SQL views' },
        ],
        catalog: CATALOG_VIEWS,
        datasets: datasets.map((d) => ({
          id: d.id,
          source: d.source_id,
          table: d.table_name,
          kind: d.kind,
          columns: d.columns,
          rowCount: d.row_count === null ? null : Number(d.row_count),
          linkedEntities: d.entity_count,
          refreshedAt: d.refreshed_at,
          description: d.description,
          wikiPage: `wiki/datasets/${d.id}.md`,
        })),
      });
    },
  );

  server.registerTool(
    'knode_query',
    {
      title: 'Native query against a live data source',
      description: 'Run a read-only SQL statement (SELECT/SHOW/DESCRIBE/EXPLAIN) directly against a configured source in its native dialect. Returns rows plus an asOf timestamp; results are live, never from the index. source="catalog" queries the knowledge base itself through the v_* views (v_claims, v_entities, v_evidence, v_scopes, …; see knode_datasources) — Postgres dialect, SELECT/WITH only, with an enforced row cap.',
      inputSchema: {
        source: z.string().describe('Datasource id, e.g. "market-mysql", or "catalog" for the knowledge base itself (see knode_datasources)'),
        sql: z.string().describe('A single read-only SQL statement in the source\'s dialect'),
        maxRows: z.number().int().min(1).max(1000).optional().describe('Row cap (default from source config)'),
      },
    },
    async ({ source, sql, maxRows }) => {
      if (source === CATALOG_SOURCE) return json(await catalogQuery(ctx.store, sql, { maxRows }));
      return json(await runSourceQuery(ctx.datasources, source, sql, { maxRows }));
    },
  );

  server.registerTool(
    'knode_grep',
    {
      title: 'Grep the knowledge files',
      description: 'Regex search across wiki, raw/docs (including the Markdown derived from PDFs and images), raw/skills and playbooks/packs (like grep -rn). Complements knode_search for exact strings, symbols and tickers.',
      inputSchema: {
        pattern: z.string().describe('JavaScript regular expression'),
        path: z.string().optional().describe('Restrict to a subtree, e.g. "wiki/datasets"'),
        maxMatches: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({ pattern, path: p, maxMatches }) => json(grepFiles(ctx.dataDir, pattern, { path: p, maxMatches })),
  );
}
