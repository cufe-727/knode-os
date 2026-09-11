#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { redactConfig, resolveDataDir, CONFIG_FILE } from './config.js';
import { createContext } from './context.js';
import { initDataDir } from './fs/datadir.js';
import { benchAnswer } from './bench/answer.js';
import { benchBuild } from './bench/build.js';
import { benchExtractCompare } from './bench/extract-compare.js';
import { benchQaGen, benchRetrieval, RetrievalMode } from './bench/qa.js';
import { runSourceQuery } from './datasource/execute.js';
import { graphInsights, graphOverview, graphSearch } from './graph/query.js';
import { importArchive } from './importers/archive.js';
import { runTier1Pass } from './graph/tier1.js';
import { sync } from './ingest/sync.js';
import { historyOf, lineageOf } from './lineage/inspect.js';
import { forgetSource, purgeArchived, purgeDisposed } from './lineage/purge.js';
import { rebuild } from './lineage/rebuild.js';
import { reconcileViews } from './wiki/pages.js';
import { buildContextPack } from './pack/pack.js';
import { applySuggestion, optimizePacks } from './pack/learn.js';
import { listSuggestions, setSuggestionStatus } from './store/queries.js';
import { seedStockDemo } from './demo/stock.js';
import { refineWiki } from './wiki/refine.js';
import { startMcpServer } from './mcp/server.js';
import { ask } from './search/ask.js';
import { search, SearchMode } from './search/search.js';
import { planOnly, resolve } from './compiler/resolve.js';
import { liveAbsences } from './compiler/absence.js';
import { distillRecipes } from './compiler/distill.js';
import { evaluatePacks, writeEvalReport } from './compiler/evaluate.js';
import { writeRankerReport } from './compiler/ranker.js';
import { changesSince, listSubscriptions, subscribe, unsubscribe } from './compiler/subscribe.js';
import { checkout, commitWorkset, envelopeFor, listWorksets } from './compiler/workset.js';
import { listDisputes, resolveDispute, setScopeTrust } from './lineage/trust.js';
import { listReceipts, recordFeedback } from './compiler/receipts.js';
import { readVirtual } from './compiler/vfs.js';
import { renderCapabilityDts } from './capability/dts.js';
import { listCapabilities, locatorsForEntities } from './capability/store.js';
import { queryClaims } from './store/claims.js';
import { CATALOG_SOURCE, CATALOG_VIEWS, catalogQuery } from './store/catalog.js';
import { resolveScopeFilter, resolveTemporal } from './store/resolver.js';
import { startServer } from './server/serve.js';
import { syncTraces } from './traces/sync.js';
import { runDream } from './dream/dream.js';
import { generateWiki } from './wiki/generate.js';
import { exportOkfBundle, importOkfBundle, migrateWikiToOkf, validateOkfBundle } from './okf/index.js';
import { getObsidianVaultStatus, initObsidianVault } from './obsidian/vault.js';

/** Comma-separated CLI list option → array (empty/undefined stays undefined). */
function list(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const out = value.split(',').map((x) => x.trim()).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

const program = new Command();
program
  .name('knode-os')
  .description('Local-first knowledge OS for coding agents — wiki + knowledge graph + vector recall over your docs, traces and skills')
  .version('0.2.0')
  .option('-d, --data <path>', 'data directory (default: $KNODE_OS_DATA or ~/.knode-os)');

const dataDir = () => resolveDataDir(program.opts().data);

program
  .command('init')
  .description('initialize the data directory (raw/, wiki/, config) and the database')
  .action(async () => {
    const dir = dataDir();
    const res = initDataDir(dir);
    const ctx = await createContext(dir);
    await ctx.store.close();
    console.log(`data directory: ${dir}`);
    console.log(res.created.length ? `created:\n  ${res.created.join('\n  ')}` : 'already initialized, nothing to do');
  });

program
  .command('serve')
  .description('start the web UI + HTTP API, with trace sync, file watching and the nightly dream')
  .option('-p, --port <port>', 'override server port')
  .action(async (opts) => {
    const ctx = await createContext(dataDir());
    if (opts.port) ctx.config.server.port = Number(opts.port);
    await startServer(ctx);
  });

const syncCommand = async (opts: { llm?: boolean; datasources?: boolean; only?: string[]; verify?: boolean }) => {
  const ctx = await createContext(dataDir());
  const stats = await sync(ctx, {
    llmGraph: opts.llm,
    datasources: opts.datasources === false ? false : undefined,
    only: opts.only && opts.only.length ? opts.only : undefined,
    verify: opts.verify,
    onProgress: (m) => console.log(`  ${m}`),
  });
  console.log(JSON.stringify(stats, null, 2));
  await ctx.datasources.closeAll();
  await ctx.store.close();
};

program
  .command('sync')
  .description('reconcile declared sources with the index: cook raw/docs, apply changed files and datasource schemas, dispose removed ones (reverting every effect they produced), regenerate dependent wiki pages')
  .option('--no-llm', 'do not queue changed docs for tier-1 LLM extraction')
  .option('--no-datasources', 'skip live datasource schema sync')
  .option('--only <prefix...>', 'restrict to path prefixes (e.g. raw/docs/reports) or "datasources"')
  .option('--verify', 'recount folds and repair ledger / page drift')
  .action(syncCommand);

program
  .command('ingest')
  .description('alias of `sync`')
  .option('--no-llm', 'do not queue changed docs for tier-1 LLM extraction')
  .option('--no-datasources', 'skip live datasource schema sync')
  .action(syncCommand);

program
  .command('extract')
  .description('run one tier-1 extraction pass: drain the priority queue (heat × freshness × importance) within the daily token budget')
  .option('--batch <n>', 'max documents this pass')
  .option('--concurrency <n>', 'parallel LLM extraction calls')
  .action(async (opts) => {
    const ctx = await createContext(dataDir());
    const stats = await runTier1Pass(ctx.store, ctx.config, ctx.llm, {
      batchSize: opts.batch ? Number(opts.batch) : undefined,
      concurrency: opts.concurrency ? Number(opts.concurrency) : undefined,
      onProgress: (m) => console.log(`  ${m}`),
    });
    console.log(JSON.stringify(stats, null, 2));
    await ctx.store.close();
  });

program
  .command('search <query>')
  .description('search the knowledge base; sag adds query-time chunk/entity multi-hop expansion')
  .option('-k <n>', 'number of results', '8')
  .option('-m, --mode <mode>', 'hybrid | vector | keyword | sag', 'hybrid')
  .option('--as-of <iso>', 'system time: only documents that were live at that instant')
  .option('--kinds <list>', 'restrict to source kinds: doc,wiki,view,skill')
  .option('--sources <list>', 'restrict to path prefixes, e.g. raw/docs/reports')
  .option('--trust <tier>', 'trusted | quarantined | any (default any)')
  .option('--actor <name>', 'who is asking — restricted sources answer only to actors on their ACL')
  .option('--json', 'raw JSON output')
  .action(async (query, opts) => {
    const ctx = await createContext(dataDir());
    const results = await search(ctx.store, ctx.embedder, query, {
      k: Number(opts.k),
      mode: opts.mode as SearchMode,
      heat: ctx.config.heat,
      sag: ctx.config.retrieval.sag,
      asOf: opts.asOf,
      filter: resolveScopeFilter({ kinds: list(opts.kinds), sources: list(opts.sources), trust: opts.trust, actor: opts.actor }),
    });
    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      for (const r of results) {
        console.log(`\n— ${r.path}  (score ${r.score.toFixed(4)})`);
        console.log(`  ${r.content.replace(/\s+/g, ' ').slice(0, 240)}`);
      }
      if (results.length === 0) console.log('no results — did you run `knode-os ingest`?');
    }
    await ctx.store.close();
  });

program
  .command('ask <question>')
  .description('answer a question from the knowledge base with citations (needs llm.model configured)')
  .option('-m, --mode <mode>', 'retrieval mode: hybrid | vector | keyword | sag', 'hybrid')
  .action(async (question, opts) => {
    const ctx = await createContext(dataDir());
    const res = await ask(ctx.store, ctx.config, ctx.embedder, ctx.llm, question, { mode: opts.mode as SearchMode });
    console.log(`\n${res.answer}\n`);
    for (const c of res.citations) console.log(`  [${c.ref}] ${c.path}`);
    if (res.gaps.length) {
      console.log('\ngaps:');
      for (const g of res.gaps) console.log(`  - ${g}`);
    }
    await ctx.store.close();
  });

program
  .command('graph [query]')
  .description('search the knowledge graph (no query: top-entity overview; --insights for graph health)')
  .option('--depth <n>', 'expansion hops', '2')
  .option('--insights', 'show hubs / isolated entities / type distribution')
  .option('--as-of <iso>', 'system time: recompute nodes/edges from evidence as of that instant')
  .option('--valid-at <iso>', 'world time: only claims valid at that instant')
  .option('--valid-range <window>', 'world time window: 2026-01-01..2026-06-30 | 2026-08 | 2026')
  .option('--kinds <list>', 'restrict to source kinds: doc,wiki,view,skill')
  .option('--sources <list>', 'restrict to path prefixes, e.g. raw/docs/reports')
  .option('--trust <tier>', 'trusted | quarantined | any (default any)')
  .option('--actor <name>', 'who is asking (ACL)')
  .option('--json', 'raw JSON output')
  .action(async (query, opts) => {
    const ctx = await createContext(dataDir());
    if (opts.insights) {
      console.log(JSON.stringify(await graphInsights(ctx.store), null, 2));
    } else if (!query) {
      // same default as GET /api/graph and the web UI: top-entity overview
      console.log(JSON.stringify(await graphOverview(ctx.store), null, 2));
    } else {
      const res = await graphSearch(ctx.store, query, {
        depth: Number(opts.depth),
        heat: ctx.config.heat,
        temporal: resolveTemporal({ asOf: opts.asOf, validAt: opts.validAt, validRange: opts.validRange }),
        filter: resolveScopeFilter({ kinds: list(opts.kinds), sources: list(opts.sources), trust: opts.trust, actor: opts.actor }),
      });
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(`\nentities (${res.nodes.length}):`);
        for (const n of res.nodes.slice(0, 20)) {
          console.log(`  ${n.name}  [${n.type}]  score=${n.score.toFixed(2)} mentions=${n.mentionCount}${n.description ? '  — ' + n.description.slice(0, 80) : ''}`);
        }
        console.log(`\nrelations (${res.edges.length}):`);
        for (const e of res.edges.slice(0, 20)) console.log(`  ${e.source} —${e.type}→ ${e.target}`);
        console.log(`\ngrounding chunks: ${res.chunks.map((c) => c.path).join(', ') || '(none)'}`);
      }
    }
    await ctx.store.close();
  });

const datasource = program.command('datasource').description('live external data sources (mysql / timescale / duckdb-parquet)');
datasource
  .command('list')
  .description('configured sources and their registered tables (schema metadata from the last sync)')
  .action(async () => {
    const ctx = await createContext(dataDir());
    const { listDatasets } = await import('./store/queries.js');
    const datasets = await listDatasets(ctx.store);
    for (const ds of ctx.config.datasources) {
      console.log(`\n${ds.id}  [${ds.kind}]  ${ds.description ?? ''}`);
      for (const d of datasets.filter((x) => x.source_id === ds.id)) {
        console.log(`  ${d.table_name}  ${d.columns.length} cols, ~${d.row_count ?? '?'} rows, ${d.entity_count} linked entities, refreshed ${d.refreshed_at ?? 'never'}`);
      }
    }
    if (ctx.config.datasources.length === 0) console.log('no datasources configured — add a "datasources" block to knode.config.json');
    console.log(`\n${CATALOG_SOURCE}  [catalog]  the knowledge base itself, as read-only SQL views`);
    for (const v of CATALOG_VIEWS) console.log(`  ${v.name}  ${v.description}`);
    await ctx.datasources.closeAll();
    await ctx.store.close();
  });
datasource
  .command('sync')
  .description('introspect schemas, link entity columns into the graph, (re)generate wiki/datasets pages — a scoped `sync --only datasources`')
  .action(async () => {
    await syncCommand({ only: ['datasources'] });
  });
datasource
  .command('query <source> <sql>')
  .description('run a read-only native SQL statement against a configured source, or against "catalog" (the knowledge base\'s own v_* views)')
  .option('--max-rows <n>', 'row cap', '50')
  .action(async (source, sql, opts) => {
    const ctx = await createContext(dataDir());
    try {
      if (source === CATALOG_SOURCE) {
        console.log(JSON.stringify(await catalogQuery(ctx.store, sql, { maxRows: Number(opts.maxRows) }), null, 2));
        return;
      }
      const res = await runSourceQuery(ctx.datasources, source, sql, { maxRows: Number(opts.maxRows) });
      console.log(JSON.stringify(res, null, 2));
    } finally {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });

program
  .command('pack <utterance>')
  .description('build a context pack: matched entities + docs/claims/datasets from the graph + live probe data + gap suggestions')
  .option('--json', 'raw JSON output')
  .option('--no-record', 'do not record a pack_event (skews the learning loop)')
  .option('--as-of <iso>', 'system time: build the pack from what the knowledge base contained then')
  .option('--valid-at <iso>', 'world time: only claims valid at that instant')
  .option('--valid-range <window>', 'world time window: 2026-01-01..2026-06-30 | 2026-08 | 2026')
  .option('--freshness <duration>', 'max age of live probe answers: 30s | 15m | 2h')
  .option('--kinds <list>', 'restrict to source kinds: doc,wiki,view,skill')
  .option('--sources <list>', 'restrict to path prefixes, e.g. raw/docs/reports')
  .action(async (utterance, opts) => {
    const ctx = await createContext(dataDir());
    const pack = await buildContextPack(ctx, utterance, {
      record: opts.record,
      temporal: resolveTemporal({ asOf: opts.asOf, validAt: opts.validAt, validRange: opts.validRange, freshness: opts.freshness }),
      filter: resolveScopeFilter({ kinds: list(opts.kinds), sources: list(opts.sources) }),
    });
    if (opts.json) {
      console.log(JSON.stringify(pack, null, 2));
    } else {
      console.log(`\nentities: ${pack.matchedEntities.map((e) => `${e.name} [${e.type}]`).join(', ') || '(none)'}`);
      console.log(`\ndocs (${pack.evidence.docs.length}):`);
      for (const d of pack.evidence.docs) console.log(`  — ${d.path}  ${d.content.replace(/\s+/g, ' ').slice(0, 120)}`);
      console.log(`\nclaims (${pack.evidence.claims.length}):`);
      for (const c of pack.evidence.claims) {
        const flags = [c.status !== 'fact' ? c.status : '', c.stale ? 'STALE' : '', c.conflictsWith.length ? 'CONFLICT' : ''].filter(Boolean).join(',');
        console.log(`  — ${c.subject}: ${c.statement.slice(0, 100)}${flags ? `  [${flags}]` : ''}${c.startDate ? `  (${c.startDate}${c.endDate ? `→${c.endDate}` : ''})` : ''}`);
      }
      console.log(`\nlive tables (${pack.evidence.datasets.length}):`);
      for (const d of pack.evidence.datasets) console.log(`  — ${d.source}.${d.table}  [${d.kind}]  ~${d.rowCount ?? '?'} rows`);
      console.log(`\nlive data (${pack.liveData.length}):`);
      for (const p of pack.liveData) {
        if (p.ok) console.log(`  — ${p.id} (${p.source}, asOf ${p.asOf}${p.cached ? ', cached' : ''}): ${JSON.stringify(p.rows?.slice(0, 3))}`);
        else console.log(`  — ${p.id} (${p.source}) FAILED: ${p.error}`);
      }
      console.log(`\nsuggestions (${pack.suggestions.length}):`);
      for (const s of pack.suggestions) console.log(`  [${s.kind}] ${s.text}${s.sql ? `\n         SQL(${s.source}): ${s.sql}` : ''}`);
      if (pack.gaps.length) console.log(`\ngaps: ${pack.gaps.join(' | ')}`);
      console.log(`\nplaybooks: ${pack.playbooksUsed.join(', ') || '(none)'}`);
      if (pack.applied.length) console.log(`\napplied: ${pack.applied.join(' | ')}`);
    }
    await ctx.datasources.closeAll();
    await ctx.store.close();
  });

const suggestions = program.command('suggestions').description('improvement proposals from the dream and the learning loop');
suggestions
  .command('list')
  .description('pending proposals; kind "recipe" / "pack" carry a file that accepting will write')
  .option('--status <status>', 'pending | accepted | rejected | stale', 'pending')
  .option('-n, --limit <n>', 'max rows', '50')
  .action(async (opts) => {
    const ctx = await createContext(dataDir());
    const rows = await listSuggestions(ctx.store, { status: opts.status, limit: Number(opts.limit) });
    for (const r of rows) {
      console.log(`\n${r.id}  [${r.kind}]  ${r.title}`);
      console.log(`  ${r.body.replace(/\s+/g, ' ').slice(0, 200)}`);
      if (r.payload?.path) console.log(`  writes ${r.payload.path} on accept`);
    }
    if (rows.length === 0) console.log(`no ${opts.status} suggestions`);
    await ctx.store.close();
  });
suggestions
  .command('accept <id>')
  .description('accept a proposal; for kind pack/recipe this writes the file that changes what the next query does')
  .option('--actor <name>', 'who decided', 'user')
  .action(async (id, opts) => {
    const ctx = await createContext(dataDir());
    const applied = await applySuggestion(ctx.store, ctx.dataDir, id);
    await setSuggestionStatus(ctx.store, id, 'accepted', opts.actor);
    console.log(applied.applied ? `accepted — wrote ${applied.path} (run \`knode-os sync\` to index it)` : 'accepted (advisory: nothing to write)');
    await ctx.store.close();
  });
suggestions
  .command('reject <id>')
  .option('--actor <name>', 'who decided', 'user')
  .action(async (id, opts) => {
    const ctx = await createContext(dataDir());
    await setSuggestionStatus(ctx.store, id, 'rejected', opts.actor);
    console.log('rejected');
    await ctx.store.close();
  });

const workset = program.command('workset').description('pinned views for long tasks: freeze a system time, write conclusions back as a source');
workset
  .command('checkout')
  .description('pin the current instant so every later read answers from the same state')
  .option('--actor <name>', 'who is working')
  .option('--note <text>', 'what this session is for')
  .option('--as-of <iso>', 'pin an earlier instant instead of now')
  .action(async (opts) => {
    const ctx = await createContext(dataDir());
    console.log(JSON.stringify(await checkout(ctx.store, { actor: opts.actor, note: opts.note, asOf: opts.asOf }), null, 2));
    await ctx.store.close();
  });
workset
  .command('commit <id>')
  .description('write the workset\'s conclusions back as a source (quarantined until promoted)')
  .requiredOption('--content <markdown>', 'the note body')
  .option('--title <text>')
  .option('--path <rel>', 'override the destination')
  .option('--keep-open', 'do not close the workset')
  .action(async (id, opts) => {
    const ctx = await createContext(dataDir());
    const res = await commitWorkset(ctx, { worksetId: id, content: opts.content, title: opts.title, path: opts.path, keepOpen: opts.keepOpen });
    console.log(`wrote ${res.path} — run \`knode-os sync\` to index it`);
    await ctx.store.close();
  });
workset
  .command('list')
  .option('--open', 'only open worksets')
  .action(async (opts) => {
    const ctx = await createContext(dataDir());
    for (const w of await listWorksets(ctx.store, { open: opts.open })) {
      console.log(`${w.id}  ${w.actor}  pinned ${w.asOf}  ${w.closedAt ? `committed → ${w.commitPath}` : 'open'}  ${w.note}`);
    }
    await ctx.store.close();
  });

program
  .command('trust <path> <tier>')
  .description('promote or demote a source (trusted | quarantined); promoting resolves the disputes it opened')
  .option('--actor <name>', 'who decided', 'user')
  .action(async (p, tier, opts) => {
    if (tier !== 'trusted' && tier !== 'quarantined') throw new Error('tier must be trusted or quarantined');
    const ctx = await createContext(dataDir());
    console.log(JSON.stringify(await setScopeTrust(ctx.store, { key: p, to: tier, actor: opts.actor }), null, 2));
    await ctx.store.close();
  });

program
  .command('disputes [id]')
  .description('contradictions between a quarantined write and a trusted claim; pass an id with --resolve to close one')
  .option('--resolve', 'mark the given dispute resolved')
  .option('--status <status>', 'open | resolved', 'open')
  .option('--actor <name>', 'who decided', 'user')
  .action(async (id, opts) => {
    const ctx = await createContext(dataDir());
    if (opts.resolve && id) {
      console.log(JSON.stringify({ resolved: await resolveDispute(ctx.store, id, opts.actor) }, null, 2));
    } else {
      const rows = await listDisputes(ctx.store, { status: opts.status, claimId: id });
      for (const d of rows) console.log(`${d.id}  ${d.status}  ${d.reason}\n    ${d.claimId} vs ${d.againstId ?? '?'}`);
      if (rows.length === 0) console.log('no disputes');
    }
    await ctx.store.close();
  });

program
  .command('absences <entity...>')
  .description('what we looked for and did not find, with the window it is believed empty for')
  .action(async (entities) => {
    const ctx = await createContext(dataDir());
    const rows = await liveAbsences(ctx.store, entities);
    for (const a of rows) console.log(`${a.capabilityId}  ${a.param}=${a.value}  until ${a.validTo ?? '(open)'}`);
    if (rows.length === 0) console.log('none — nothing has been recorded as absent for these entities');
    await ctx.store.close();
  });

const subs = program.command('subscribe').description('watch an entity, source or intent for changes');
subs
  .command('add <kind> <target>')
  .description('kind: entity | source | intent')
  .option('--actor <name>', 'subscriber', 'agent')
  .action(async (kind, target, opts) => {
    const ctx = await createContext(dataDir());
    console.log(JSON.stringify(await subscribe(ctx.store, { kind: kind as 'entity', target, actor: opts.actor }), null, 2));
    await ctx.store.close();
  });
subs
  .command('changes <id>')
  .description('what changed since the cursor (advances it unless --peek)')
  .option('--peek', 'do not advance the cursor')
  .option('-n, --limit <n>', 'max changes', '50')
  .action(async (id, opts) => {
    const ctx = await createContext(dataDir());
    const res = await changesSince(ctx.store, id, { limit: Number(opts.limit), advance: !opts.peek });
    for (const c of res.changes) console.log(`${c.at}  [${c.kind}] ${c.summary}`);
    if (res.changes.length === 0) console.log('no changes since ' + res.subscription.lastSeenAt);
    await ctx.store.close();
  });
subs
  .command('list')
  .action(async () => {
    const ctx = await createContext(dataDir());
    for (const x of await listSubscriptions(ctx.store)) console.log(`${x.id}  ${x.kind}:${x.target}  ${x.actor}  since ${x.lastSeenAt}`);
    await ctx.store.close();
  });
subs
  .command('remove <id>')
  .action(async (id) => {
    const ctx = await createContext(dataDir());
    console.log(JSON.stringify({ removed: await unsubscribe(ctx.store, id) }, null, 2));
    await ctx.store.close();
  });

program
  .command('learning')
  .description('what the planner has learned: capability ranking, pack precision, and recipe candidates')
  .option('--lookback <days>', 'analysis window', '30')
  .option('--intent <id>', 'only this intent')
  .option('--distill', 'also propose recipes for plan shapes that keep working')
  .option('--json', 'raw JSON output')
  .action(async (opts) => {
    const ctx = await createContext(dataDir());
    const ranking = await writeRankerReport(ctx.store, { intent: opts.intent });
    const evaluation = await evaluatePacks(ctx.store, { lookbackDays: Number(opts.lookback) });
    const evalPath = writeEvalReport(ctx.dataDir, evaluation);
    const distilled = opts.distill ? await distillRecipes(ctx.store, { lookbackDays: Number(opts.lookback), intent: opts.intent }) : null;
    if (opts.json) {
      console.log(JSON.stringify({ ranking, evaluation, distilled }, null, 2));
    } else {
      console.log(`ranking → ${ranking.path}`);
      for (const r of ranking.rows.slice(0, 20)) {
        console.log(`  ${r.intent ?? '(any)'} / ${r.slot} / ${r.capability}: ${r.used}/${r.attempts} kept, posterior ${(r.mean * 100).toFixed(0)}%`);
      }
      if (ranking.rows.length === 0) console.log('  (no feedback yet — run `knode-os feedback <receipt>` after executing a plan)');
      console.log(`\nevaluation → ${evalPath}`);
      console.log(`  ${evaluation.totals.reported}/${evaluation.totals.resolves} resolves reported back, precision ${(evaluation.totals.precision * 100).toFixed(0)}%`);
      for (const c of evaluation.ignoredCapabilities) console.log(`  never used: ${c.capability} for ${c.slot} (${c.attempts} calls)`);
      if (distilled) {
        console.log(`\ndistillation: ${distilled.shapes} plan shapes`);
        for (const s of distilled.suggestions) console.log(`  proposed: ${s.title} — accept with \`knode-os suggestions accept ${s.id}\``);
        for (const c of distilled.candidates.filter((x) => !x.ok)) console.log(`  rejected: ${c.shape.signature} — ${c.reason}`);
      }
    }
    await ctx.store.close();
  });

program
  .command('resolve <query>')
  .description('turn a question into ready context plus a plan: which slots an answer needs, what is already covered, and what is left to run')
  .option('--actor <name>', 'who is asking (recorded on the receipt)')
  .option('--render <mode>', 'json-graph | ts-program', 'json-graph')
  .option('--max-tool-calls <n>', 'plan budget')
  .option('--as-of <iso>', 'system time')
  .option('--valid-at <iso>', 'world time instant')
  .option('--valid-range <window>', 'world time window')
  .option('--freshness <duration>', 'max age of live reads, e.g. 15m')
  .option('--kinds <list>', 'restrict to source kinds')
  .option('--sources <list>', 'restrict to path prefixes')
  .option('--trust <tier>', 'trusted | quarantined | any (default any)')
  .option('--workset <id>', 'answer at the instant this workset pinned')
  .option('--no-record', 'do not write a receipt (skews the learning loop)')
  .option('--json', 'raw JSON output')
  .action(async (query, opts) => {
    const ctx = await createContext(dataDir());
    const pack = await resolve(ctx, query, {
      actor: opts.actor,
      record: opts.record,
      render: opts.render === 'ts-program' ? 'ts-program' : 'json-graph',
      budget: opts.maxToolCalls ? { maxToolCalls: Number(opts.maxToolCalls) } : undefined,
      temporal: await envelopeFor(ctx.store, {
        workset: opts.workset, asOf: opts.asOf, validAt: opts.validAt, validRange: opts.validRange, freshness: opts.freshness,
      }),
      filter: resolveScopeFilter({ kinds: list(opts.kinds), sources: list(opts.sources), trust: opts.trust, actor: opts.actor }),
    });
    if (opts.json) {
      console.log(JSON.stringify(pack, null, 2));
    } else {
      console.log(`intent: ${pack.intent.type} — ${pack.intent.title}`);
      console.log(`matched by: ${pack.intent.matchedBy.join('; ')}`);
      console.log(`entities: ${pack.intent.entities.map((e) => e.name).join(', ') || '(none)'}`);
      console.log(`\nslots:`);
      for (const slot of pack.slots) {
        console.log(`  ${slot.filled ? '✓' : '·'} ${slot.id}${slot.required ? '' : ' (optional)'} — ${slot.source}`);
      }
      console.log(`\ndocs ${pack.documents.length}, claims ${pack.facts.length}, datasets ${pack.datasets.length}`);
      if (pack.unknowns.length) {
        console.log(`\nunknowns:`);
        for (const u of pack.unknowns) console.log(`  [${u.risk}] ${u.question}\n        → ${u.defaultAssumption}`);
      }
      console.log(`\nplan (${pack.plan.nodes.length} nodes, budget ${pack.budgetReport.budget.maxToolCalls} calls):`);
      for (const n of pack.plan.nodes) {
        console.log(`  ${n.id} fills ${n.fills} via ${n.tool.name}${n.capability ? ` [${n.capability}]` : ''}`);
        console.log(`      ${JSON.stringify(n.args)}`);
        if (n.why) console.log(`      why: ${n.why.reason}`);
      }
      if (pack.plan.nodes.length === 0) console.log('  (nothing left to run)');
      for (const c of pack.budgetReport.cut) console.log(`  cut: ${c.slot} via ${c.capability} — ${c.reason}`);
      if (pack.planProgram) console.log(`\n${pack.planProgram}`);
      console.log(`\nreceipt: ${pack.receiptId}  (report back with \`knode-os feedback ${pack.receiptId} …\`)`);
    }
    await ctx.datasources.closeAll();
    await ctx.store.close();
  });

program
  .command('plan <query>')
  .description('just the plan for a question: nodes grouped into parallel phases')
  .option('--render <mode>', 'json-graph | ts-program', 'json-graph')
  .option('--max-tool-calls <n>', 'plan budget')
  .option('--as-of <iso>', 'system time')
  .option('--freshness <duration>', 'max age of live reads')
  .action(async (query, opts) => {
    const ctx = await createContext(dataDir());
    const res = await planOnly(ctx, query, {
      render: opts.render === 'ts-program' ? 'ts-program' : 'json-graph',
      budget: opts.maxToolCalls ? { maxToolCalls: Number(opts.maxToolCalls) } : undefined,
      temporal: resolveTemporal({ asOf: opts.asOf, freshness: opts.freshness }),
    });
    console.log(opts.render === 'ts-program' ? res.program : JSON.stringify({ plan: res.plan, phases: res.phases, sha: res.sha }, null, 2));
    await ctx.datasources.closeAll();
    await ctx.store.close();
  });

program
  .command('feedback <receiptId>')
  .description('report what a plan actually did — the only thing that teaches the planner which source answers a slot')
  .option('--outcome <text>', 'answered | partial | failed, or a short note')
  .option('--used <list>', 'comma-separated node/chunk ids whose results were used')
  .option('--ignored <list>', 'comma-separated ids that were returned but not used')
  .option('--executed <json>', 'JSON array of {nodeId, slot, capability, ok, elapsedMs, rows}')
  .action(async (receiptId, opts) => {
    const ctx = await createContext(dataDir());
    const res = await recordFeedback(ctx.store, {
      receiptId,
      outcome: opts.outcome,
      usedIds: list(opts.used),
      ignoredIds: list(opts.ignored),
      executed: opts.executed ? JSON.parse(opts.executed) : undefined,
    });
    console.log(JSON.stringify(res, null, 2));
    await ctx.store.close();
  });

program
  .command('receipts')
  .description('recent resolves: what was asked, what was planned, what came back')
  .option('-n, --limit <n>', 'rows', '20')
  .option('--intent <id>', 'only this intent')
  .option('--json', 'raw JSON output')
  .action(async (opts) => {
    const ctx = await createContext(dataDir());
    const rows = await listReceipts(ctx.store, { limit: Number(opts.limit), intent: opts.intent });
    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      for (const r of rows) {
        const calls = Array.isArray(r.calls) ? r.calls.length : 0;
        console.log(`${r.id}  ${r.kind}  ${r.intent ?? '-'}  ${r.feedback_at ? `${calls} calls, ${r.outcome ?? 'no outcome'}` : 'awaiting feedback'}`);
        console.log(`    ${r.query.slice(0, 100)}`);
      }
      if (rows.length === 0) console.log('no receipts yet — run `knode-os resolve "<question>"`');
    }
    await ctx.store.close();
  });

program
  .command('vfs <path>')
  .description('read the virtual filesystem: /entities/<id>.md, /claims/<subject>.md, /capabilities/<source>/<name>.md, /live/<capability>?<param>=<value>')
  .action(async (p) => {
    const ctx = await createContext(dataDir());
    try {
      console.log(await readVirtual(ctx, p.startsWith('/') ? p : `/${p}`));
    } finally {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });

program
  .command('capabilities')
  .description('what can be asked, and of which source: tables, endpoints, metrics and built-in tools with their semantics, freshness and cost')
  .option('--source <id>', 'restrict to one datasource')
  .option('--kind <kind>', 'table | endpoint | metric | tool')
  .option('--entity <id>', 'only what is reachable for this entity, plus how to bind it')
  .option('--dts', 'print a TypeScript declaration to write a program against')
  .option('--json', 'raw JSON output')
  .action(async (opts) => {
    const ctx = await createContext(dataDir());
    const capabilities = await listCapabilities(ctx.store, {
      sourceIds: opts.source ? [opts.source] : undefined,
      kinds: opts.kind ? [opts.kind] : undefined,
      entityIds: opts.entity ? [opts.entity] : undefined,
    });
    if (opts.dts) {
      console.log(renderCapabilityDts(capabilities));
    } else if (opts.json) {
      const locators = opts.entity ? await locatorsForEntities(ctx.store, [opts.entity]) : [];
      console.log(JSON.stringify({ capabilities, locators }, null, 2));
    } else {
      for (const c of capabilities) {
        const tags = [c.kind, c.dialect, c.freshnessSeconds !== null ? `≤${c.freshnessSeconds}s` : null, c.cost !== 1 ? `cost ${c.cost}` : null]
          .filter(Boolean).join(', ');
        console.log(`\n${c.id}  [${tags}]`);
        if (c.title) console.log(`  ${c.title}`);
        for (const p of c.pitfalls) console.log(`  ! ${p}`);
        for (const j of c.joins) console.log(`  ⋈ ${j}`);
      }
      if (opts.entity) {
        const locators = await locatorsForEntities(ctx.store, [opts.entity]);
        console.log(`\nlocators for ${opts.entity}:`);
        for (const l of locators) console.log(`  ${l.capabilityId}: ${l.param} = ${JSON.stringify(l.value)}`);
        if (locators.length === 0) console.log('  (none — this entity is not reachable through any live source)');
      }
      if (capabilities.length === 0) console.log('no capabilities — configure a datasource, or run `knode-os datasource sync`');
    }
    await ctx.store.close();
  });

program
  .command('claims [subject]')
  .description('query time-bound claims directly: what the knowledge base asserts, when it holds, and which source says so')
  .option('--object <ref>', 'entity on the other side of the claim')
  .option('--types <list>', 'comma-separated claim types, e.g. earnings,guidance')
  .option('--status <list>', 'comma-separated: fact,suspected,disputed')
  .option('--text <substring>', 'substring of the statement')
  .option('-n, --limit <n>', 'max rows', '50')
  .option('--as-of <iso>', 'system time: what the knowledge base believed then')
  .option('--valid-at <iso>', 'world time: only claims valid at that instant')
  .option('--valid-range <window>', 'world time window: 2026-01-01..2026-06-30 | 2026-08 | 2026')
  .option('--kinds <list>', 'restrict to source kinds: doc,wiki,view,skill')
  .option('--sources <list>', 'restrict to path prefixes, e.g. raw/docs/reports')
  .option('--trust <tier>', 'trusted | quarantined | any (default any)')
  .option('--actor <name>', 'who is asking (ACL)')
  .option('--json', 'raw JSON output')
  .action(async (subject, opts) => {
    const ctx = await createContext(dataDir());
    const res = await queryClaims(ctx.store, {
      subject,
      object: opts.object,
      types: list(opts.types),
      statuses: list(opts.status),
      text: opts.text,
      limit: Number(opts.limit),
      temporal: resolveTemporal({ asOf: opts.asOf, validAt: opts.validAt, validRange: opts.validRange }),
      filter: resolveScopeFilter({ kinds: list(opts.kinds), sources: list(opts.sources), trust: opts.trust, actor: opts.actor }),
    });
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      if (res.applied.length) console.log(res.applied.map((a) => `· ${a}`).join('\n'));
      console.log(`\nclaims (${res.claims.length} of ${res.matched}):`);
      for (const c of res.claims) {
        const window = c.validFrom || c.validTo ? `  (${c.validFrom ?? '…'}${c.validTo ? `→${c.validTo}` : '→'})` : '';
        const flags = [c.status !== 'fact' ? c.status : '', c.stale ? 'STALE' : ''].filter(Boolean).join(',');
        console.log(`  — ${c.subject}: ${c.statement.slice(0, 110)}${window}${flags ? `  [${flags}]` : ''}`);
        console.log(`      ${c.sourcePath ?? '(source purged)'}  ·  ${c.evidenceCount} evidence`);
      }
      if (res.claims.length === 0) console.log('  (none)');
    }
    await ctx.store.close();
  });

program
  .command('pack-optimize')
  .description('analyze recent pack_events and propose playbook revisions as suggestions (kind "pack")')
  .option('--lookback <days>', 'analysis window in days', '14')
  .option('--apply', 'immediately accept + write every proposed revision to packs/')
  .action(async (opts) => {
    const ctx = await createContext(dataDir());
    const res = await optimizePacks(ctx.store, ctx.config, ctx.llm, {
      lookbackDays: Number(opts.lookback),
      onProgress: (m) => console.log(`  ${m}`),
    });
    console.log(`${res.events} pack events analyzed, ${res.suggestions.length} suggestions`);
    for (const s of res.suggestions) {
      console.log(`  [${s.kind}] ${s.title}`);
      if (opts.apply && s.kind === 'pack') {
        const { setSuggestionStatus } = await import('./store/queries.js');
        const applied = await applySuggestion(ctx.store, ctx.dataDir, s.id);
        if (applied.applied) {
          await setSuggestionStatus(ctx.store, s.id, 'accepted');
          console.log(`    → applied to ${applied.path}`);
        }
      }
    }
    await ctx.store.close();
  });

const demo = program.command('demo').description('runnable demo scenarios');
demo
  .command('seed-stock')
  .description('stock-analysis demo: research reports + news into raw/docs, quotes into MySQL/TimescaleDB/parquet, datasource config + playbook (needs demo/stock/docker-compose.yml up, or local servers via --mysql-port/--tsdb-port)')
  .option('--skip-db', 'only write files/config, skip MySQL + TimescaleDB seeding')
  .option('--mysql-port <n>', 'MySQL/MariaDB port (default 3307 = docker compose)', '3307')
  .option('--tsdb-port <n>', 'TimescaleDB/Postgres port (default 5433 = docker compose)', '5433')
  .action(async (opts) => {
    const dir = dataDir();
    initDataDir(dir);
    const res = await seedStockDemo(dir, {
      skipDb: opts.skipDb,
      mysqlPort: Number(opts.mysqlPort),
      timescalePort: Number(opts.tsdbPort),
      onProgress: (m) => console.log(`  ${m}`),
    });
    console.log(JSON.stringify(res, null, 2));
    console.log('\nnext: knode-os ingest && knode-os pack "宁德时代最近表现怎么样"');
  });

const bench = program.command('bench').description('evaluation & benchmarking (reports land in <data>/eval/reports)');
bench
  .command('build')
  .description('run the full build (tier-0 ingest → tier-1 drain → wiki) with per-stage timing and throughput')
  .option('--skip-wiki', 'skip wiki generate/refine stages')
  .option('--max-tier1-passes <n>', 'cap tier-1 passes instead of draining the queue')
  .action(async (opts) => {
    const ctx = await createContext(dataDir());
    const report = await benchBuild(ctx, {
      skipWiki: opts.skipWiki,
      maxTier1Passes: opts.maxTier1Passes ? Number(opts.maxTier1Passes) : undefined,
      onProgress: (m) => console.log(`  ${m}`),
    });
    console.log(`\nreport: ${report.reportPaths?.mdPath}`);
    await ctx.store.close();
  });
bench
  .command('qa-gen')
  .description('generate a QA evaluation set (stratified chunk sampling + LLM question generation) into eval/qa.jsonl')
  .option('--n <n>', 'number of QA pairs', '100')
  .option('--concurrency <n>', 'parallel LLM calls', '8')
  .action(async (opts) => {
    const ctx = await createContext(dataDir());
    const res = await benchQaGen(ctx, {
      n: Number(opts.n),
      concurrency: Number(opts.concurrency),
      onProgress: (m) => console.log(`  ${m}`),
    });
    console.log(`\n${res.items.length} QA pairs → ${res.file}`);
    await ctx.store.close();
  });
bench
  .command('retrieval')
  .description('replay the QA set against vector/keyword/hybrid/sag/graph retrieval; report recall@k, MRR, NDCG@10')
  .option('--k <list>', 'comma-separated cutoffs', '5,10')
  .option('--modes <list>', 'comma-separated modes', 'vector,keyword,hybrid,sag,graph')
  .action(async (opts) => {
    const ctx = await createContext(dataDir());
    const report = await benchRetrieval(ctx, {
      ks: String(opts.k).split(',').map(Number).filter((n) => n > 0),
      modes: String(opts.modes).split(',').filter(Boolean) as RetrievalMode[],
      onProgress: (m) => console.log(`  ${m}`),
    });
    for (const m of report.modes) {
      console.log(`  ${m.mode}: chunkR@10=${m.recallChunk['@10'] ?? '-'} docR@10=${m.recallDoc['@10'] ?? '-'} MRR=${m.mrrChunk} p50=${m.latency.p50}ms`);
    }
    console.log(`\nreport: ${report.reportPaths?.mdPath}`);
    await ctx.store.close();
  });
bench
  .command('answer')
  .description('end-to-end ask() quality over a QA sample, graded by an LLM judge')
  .option('--n <n>', 'sample size', '20')
  .option('--concurrency <n>', 'parallel asks', '4')
  .action(async (opts) => {
    const ctx = await createContext(dataDir());
    const report = await benchAnswer(ctx, {
      n: Number(opts.n),
      concurrency: Number(opts.concurrency),
      onProgress: (m) => console.log(`  ${m}`),
    });
    console.log(`\navg correctness ${report.avgCorrectness}/2, gold citation rate ${report.goldCitationRate}`);
    console.log(`report: ${report.reportPaths?.mdPath}`);
    await ctx.store.close();
  });
bench
  .command('extract-compare')
  .description('run tier-1 extraction with openai vs local agent CLIs over the same docs and judge quality')
  .option('--n <n>', 'documents to sample', '20')
  .option('--backends <list>', 'comma-separated: openai,codex-cli,claude-cli,cursor-cli', 'openai,codex-cli,claude-cli,cursor-cli')
  .action(async (opts) => {
    const ctx = await createContext(dataDir());
    const names = String(opts.backends).split(',').filter(Boolean);
    const backends = names.map((name) => name === 'openai'
      ? { name: `openai:${ctx.config.llm.model}`, provider: 'openai' as const, model: ctx.config.llm.model }
      : { name, provider: name as 'codex-cli' | 'claude-cli' | 'cursor-cli' });
    const report = await benchExtractCompare(ctx, {
      n: Number(opts.n),
      backends,
      onProgress: (m) => console.log(`  ${m}`),
    });
    for (const b of report.backends) {
      console.log(`  ${b.name}: ok=${b.docs - b.failed}/${b.docs} p50=${b.latency.p50}ms coverage=${b.avgCoverage} precision=${b.avgPrecision}`);
    }
    console.log(`\nreport: ${report.reportPaths?.mdPath}`);
    await ctx.store.close();
  });

const importCmd = program.command('import').description('import external corpora into raw/docs');
importCmd
  .command('archive <dir>')
  .description('import rookie-trade crawler archive (envelope NDJSON) into raw/docs/finance, grouped into per-month markdown volumes')
  .option('--since <YYYY-MM>', 'inclusive month lower bound')
  .option('--until <YYYY-MM>', 'inclusive month upper bound')
  .option('--platform <list>', 'comma-separated platform filter (e.g. fenchuan,xueqiu)')
  .option('--target <list>', 'comma-separated target id filter')
  .option('--relevant-only', 'drop posts marked investment_relevant=false')
  .option('--volume-chars <n>', 'max characters of content per volume')
  .action(async (dir, opts) => {
    const dataRoot = dataDir();
    initDataDir(dataRoot);
    const stats = importArchive(dataRoot, dir, {
      since: opts.since,
      until: opts.until,
      platforms: opts.platform ? String(opts.platform).split(',').filter(Boolean) : undefined,
      targets: opts.target ? String(opts.target).split(',').filter(Boolean) : undefined,
      relevantOnly: opts.relevantOnly,
      volumeChars: opts.volumeChars ? Number(opts.volumeChars) : undefined,
      onProgress: (m) => console.log(`  ${m}`),
    });
    console.log(JSON.stringify(stats, null, 2));
    console.log('\nnext: run `knode-os ingest` to index the imported volumes');
  });

const obsidian = program.command('obsidian').description('Obsidian Vault compatibility');
obsidian
  .command('init [directory]')
  .description('make a directory an Obsidian Vault (default: the native <data>/wiki knowledge bundle)')
  .action((directory) => {
    let vault: string;
    if (directory) {
      vault = path.resolve(directory);
    } else {
      const dir = dataDir();
      initDataDir(dir);
      vault = path.join(dir, 'wiki');
    }
    const result = initObsidianVault(vault);
    console.log(`Obsidian Vault: ${result.vaultDir}`);
    console.log(result.created.length ? `created:\n  ${result.created.join('\n  ')}` : 'already ready, nothing to do');
  });
obsidian
  .command('status [directory]')
  .description('check whether a directory is ready to open as an Obsidian Vault')
  .action((directory) => {
    const vault = directory ? path.resolve(directory) : path.join(dataDir(), 'wiki');
    const status = getObsidianVaultStatus(vault);
    console.log(JSON.stringify(status, null, 2));
    if (!status.ready) process.exitCode = 1;
  });

const okf = program.command('okf').description('Open Knowledge Format v0.1 validation, migration and exchange');
okf
  .command('validate [bundle]')
  .description('validate an OKF bundle (default: the native <data>/wiki bundle)')
  .option('--json', 'print the complete machine-readable report')
  .action((bundle, opts) => {
    const root = bundle ? path.resolve(bundle) : path.join(dataDir(), 'wiki');
    const result = validateOkfBundle(root);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`${result.valid ? 'valid' : 'invalid'} OKF bundle: ${result.root}`);
      console.log(`version=${result.version ?? 'undeclared'} files=${result.files} concepts=${result.concepts} errors=${result.errors} warnings=${result.warnings}`);
      for (const d of result.diagnostics) console.log(`  ${d.level.toUpperCase()} ${d.path} [${d.code}] ${d.message}`);
    }
    if (!result.valid) process.exitCode = 1;
  });
okf
  .command('migrate')
  .description('upgrade the native wiki structure to OKF v0.1 while preserving content and extension fields')
  .option('--dry-run', 'report files that would change without writing them')
  .action((opts) => {
    const dir = dataDir();
    const result = migrateWikiToOkf(dir, Boolean(opts.dryRun));
    console.log(`${opts.dryRun ? 'would change' : 'changed'}: ${result.changed.length}`);
    for (const file of result.changed) console.log(`  ${file}`);
    if (result.skipped.length) console.log(`skipped (manual YAML/log repair needed):\n  ${result.skipped.join('\n  ')}`);
    if (!opts.dryRun) console.log(`validation: ${result.validation.valid ? 'valid' : 'invalid'} (${result.validation.errors} errors, ${result.validation.warnings} warnings)`);
  });
okf
  .command('import <bundle>')
  .description('validate and copy an external OKF bundle into raw/docs/okf/<name>')
  .option('--name <name>', 'destination bundle name (default: source directory name)')
  .option('--allow-invalid', 'best-effort import of a non-conformant bundle')
  .action((bundle, opts) => {
    const dir = dataDir();
    initDataDir(dir);
    const result = importOkfBundle(dir, bundle, { name: opts.name, allowInvalid: Boolean(opts.allowInvalid) });
    console.log(JSON.stringify({
      source: result.source,
      destination: result.destination,
      files: result.files,
      concepts: result.concepts,
      assets: result.assets,
      valid: result.validation.valid,
      warnings: result.validation.warnings,
    }, null, 2));
    console.log('\nnext: run `knode-os ingest` to index the imported bundle and wire its OKF links');
  });
okf
  .command('export <directory>')
  .description('validate and export the native wiki as a portable OKF bundle')
  .action((directory) => {
    const dir = dataDir();
    const result = exportOkfBundle(dir, directory);
    console.log(JSON.stringify({ destination: result.destination, files: result.files, concepts: result.concepts, assets: result.assets }, null, 2));
  });

const wiki = program.command('wiki').description('wiki maintenance');
wiki
  .command('generate')
  .description('generate source summary pages + entity stubs from indexed docs (uses LLM when configured; cold docs are demoted to the sources index)')
  .action(async () => {
    const ctx = await createContext(dataDir());
    const created = await generateWiki(ctx.store, ctx.llm, { config: ctx.config, embedder: ctx.embedder, datasources: ctx.datasources, onProgress: (m) => console.log(`  ${m}`) });
    console.log(created.length ? `created:\n  ${created.join('\n  ')}` : 'nothing to generate');
    await ctx.datasources.closeAll();
    await ctx.store.close();
  });
wiki
  .command('refine')
  .description('tier-2 refinement: detect hot-subgraph communities, write concept cluster pages, refresh the hot-topics block in wiki/index.md')
  .action(async () => {
    const ctx = await createContext(dataDir());
    const res = await refineWiki(ctx.store, ctx.config, ctx.llm, { onProgress: (m) => console.log(`  ${m}`), embedder: ctx.embedder });
    const views = await reconcileViews(ctx, { actor: 'tier2', llm: true, onProgress: (m) => console.log(`  ${m}`) });
    console.log(JSON.stringify({ ...res, views }, null, 2));
    await ctx.store.close();
  });

const trace = program.command('trace').description('agent trace collection');
trace
  .command('sync')
  .description('copy new Claude Code / Codex session traces and used skills into raw/')
  .action(async () => {
    const ctx = await createContext(dataDir());
    const stats = await syncTraces(ctx.store, ctx.config);
    console.log(JSON.stringify(stats, null, 2));
    await ctx.store.close();
  });

program
  .command('dream')
  .description('analyze recent agent traces; write a report to wiki/dreams/ and queue skill/memory/knowledge suggestions')
  .option('--lookback <days>', 'analysis window in days')
  .action(async (opts) => {
    const ctx = await createContext(dataDir());
    const res = await runDream(ctx.store, ctx.config, ctx.llm, {
      lookbackDays: opts.lookback ? Number(opts.lookback) : undefined,
      onProgress: (m) => console.log(`  ${m}`),
    });
    console.log(`\nreport: ${res.reportPath}`);
    for (const s of res.suggestions) console.log(`  [${s.kind}] ${s.title}`);
    await ctx.store.close();
  });

const lineage = program.command('lineage').description('provenance: why the knowledge base believes something, and since when');
lineage
  .command('show <kind> <id>')
  .description('evidence behind an entity | relation | claim, inputs of a page, or scopes of a document (kind: entity|relation|claim|page|document)')
  .action(async (kind: string, id: string) => {
    const ctx = await createContext(dataDir());
    if (!['entity', 'relation', 'claim', 'page', 'document'].includes(kind)) {
      console.error('kind must be one of entity|relation|claim|page|document');
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify(await lineageOf(ctx.store, kind as 'entity', id), null, 2));
    }
    await ctx.store.close();
  });

program
  .command('history <path>')
  .description('apply / dispose / purge history of a source (document path, datasource id or page path)')
  .action(async (p: string) => {
    const ctx = await createContext(dataDir());
    const h = await historyOf(ctx.store, ctx.dataDir, p);
    console.log(`key: ${h.key}`);
    for (const s of h.scopes) console.log(`  scope ${s.id} [${s.kind}] ${s.status} applied ${s.applied_at}${s.disposed_at ? ` disposed ${s.disposed_at} (${String((s.meta as { reason?: string }).reason ?? '')})` : ''} sha ${s.sha.slice(0, 12)}`);
    for (const e of h.events) console.log(`  #${e.seq} ${e.ts} ${e.ev}${'reason' in e ? ` ${e.reason}` : ''} by ${e.actor}`);
    await ctx.store.close();
  });

program
  .command('forget <path>')
  .description('delete a source under raw/docs or wiki, dispose everything it produced and purge its history (irreversible; plain delete + sync keeps history queryable with --as-of)')
  .action(async (p: string) => {
    const ctx = await createContext(dataDir());
    console.log(JSON.stringify(await forgetSource(ctx, p), null, 2));
    await ctx.datasources.closeAll();
    await ctx.store.close();
  });

program
  .command('purge')
  .description('physically erase disposed history: every disposed scope (or only those disposed before --before), optionally archived wiki pages')
  .option('--before <iso>', 'only scopes disposed before this instant; also compacts closed evidence older than it')
  .option('--archived', 'delete wiki/.archive/**')
  .action(async (opts) => {
    const ctx = await createContext(dataDir());
    const out: Record<string, unknown> = {};
    if (opts.archived) out.archivedRemoved = purgeArchived(ctx.dataDir);
    if (opts.before || !opts.archived) out.disposed = await purgeDisposed(ctx.store, { before: opts.before, actor: 'cli' });
    console.log(JSON.stringify(out, null, 2));
    await ctx.store.close();
  });

program
  .command('rebuild')
  .description('drop .knode/db and reconstruct it from files + ledger (original apply times kept for unchanged sources)')
  .option('--history', 'also replay removed sources from attic sidecars so graph-layer --as-of answers match the original timeline')
  .action(async (opts) => {
    const ctx = await createContext(dataDir());
    const report = await rebuild(ctx, { history: Boolean(opts.history), onProgress: (m) => console.log(`  ${m}`) });
    console.log(JSON.stringify({ applied: report.sync.applied, unchanged: report.sync.unchanged, pages: report.sync.pagesRegenerated, feedbackReplayed: report.feedbackReplayed, historyReplayed: report.historyReplayed }, null, 2));
    await ctx.datasources.closeAll();
    await ctx.store.close();
  });

program
  .command('mcp')
  .description('run the MCP server on stdio (for Claude Code / Codex)')
  .action(async () => {
    const ctx = await createContext(dataDir());
    await startMcpServer(ctx);
  });

program
  .command('connect <client>')
  .description('register the MCP server with a client: claude | codex')
  .action(async (client: string) => {
    const dir = dataDir();
    initDataDir(dir);
    const cliPath = fileURLToPath(import.meta.url);
    const cmd = process.execPath;
    const args = [cliPath, 'mcp', '--data', dir];

    if (client === 'claude') {
      try {
        execFileSync('claude', ['mcp', 'add', '--scope', 'user', 'knode-os', '--', cmd, ...args], { stdio: 'inherit' });
        console.log('registered with Claude Code (user scope).');
      } catch {
        console.log('`claude` CLI not found or registration failed. Add manually:');
        console.log(`  claude mcp add --scope user knode-os -- ${cmd} ${args.join(' ')}`);
      }
    } else if (client === 'codex') {
      const tomlPath = path.join(os.homedir(), '.codex', 'config.toml');
      const block = `\n[mcp_servers.knode-os]\ncommand = ${JSON.stringify(cmd)}\nargs = ${JSON.stringify(args)}\n`;
      const existing = fs.existsSync(tomlPath) ? fs.readFileSync(tomlPath, 'utf8') : '';
      if (existing.includes('[mcp_servers.knode-os]')) {
        console.log(`already registered in ${tomlPath} — edit that file to change settings.`);
      } else {
        fs.mkdirSync(path.dirname(tomlPath), { recursive: true });
        fs.appendFileSync(tomlPath, block);
        console.log(`registered in ${tomlPath}`);
      }
    } else {
      console.error('unknown client; use `claude` or `codex`');
      process.exitCode = 1;
    }
  });

program
  .command('config')
  .description('show the active configuration (secrets redacted) and the config file path')
  .action(async () => {
    const dir = dataDir();
    initDataDir(dir);
    const { loadConfig } = await import('./config.js');
    console.log(`config file: ${path.join(dir, CONFIG_FILE)}\n`);
    console.log(JSON.stringify(redactConfig(loadConfig(dir)), null, 2));
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
