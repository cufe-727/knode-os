#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { redactConfig, resolveDataDir, resolveRoutedLlmConfig, routeTargets, CONFIG_FILE, loadConfig, saveConfig } from './config.js';
import { contentLanguages, normalizeLanguage } from './lang/languages.js';
import { translateNow } from './lang/translate.js';
import { LlmClient } from './llm/client.js';
import type { DocumentRow } from './types.js';
import { createContext } from './context.js';
import { learnFrequentTerms, relinkTier0 } from './graph/concepts.js';
import { CONCEPT_FREQUENT_FILE, FREQUENT_MIN_CORPUS } from './graph/concept-stoplist.js';
import { configuredPluginSpecs, loadPlugins } from './plugins/loader.js';
import { pluginRegistry } from './plugins/registry.js';
import { initDataDir } from './fs/datadir.js';
import { benchAnswer } from './bench/answer.js';
import { benchBuild } from './bench/build.js';
import { benchExtractCompare } from './bench/extract-compare.js';
import { benchQaGen, benchRetrieval, RetrievalMode } from './bench/qa.js';
import { runSourceQuery } from './datasource/execute.js';
import { graphInsights, graphOverview, graphSearch } from './graph/query.js';
import { applyClaimMerge, listClaimMerges, unmergeClaim } from './graph/claim-merge.js';
import { auditDuplicateClaims } from './graph/claim-dedupe.js';
import { applyMerge, correctEntity, listMerges, unmergeEntity } from './graph/merge.js';
import { readEntityCorrections } from './graph/corrections.js';
import { auditDuplicateEntities } from './graph/dedupe.js';
import { reviewClaims } from './graph/claim-review.js';
import { resolveEntityId } from './graph/resolve.js';
import { cancelJob, getJob, listJobs, queueJob, retryJob, ResearchJob, ResearchStatus } from './research/jobs.js';
import { killAgentsFor } from './research/launch.js';
import { McpEndpoint } from './research/workspace.js';
import { runChatTurn } from './chat/runner.js';
import { createConversation, getConversation, listConversations } from './chat/store.js';
import { finalizeResearchJob, resolveResearchAgent, runResearchJob, workspaceFromJob } from './research/runner.js';
import { loadResearchTemplates, RESEARCH_KINDS, ResearchKind } from './research/templates.js';
import { prepareRunWorkspace, runsRoot } from './research/workspace.js';
import { recommendWikiTopics, refreshRecommendations } from './research/recommend.js';
import { launchArgs } from './research/launch.js';
import { loadProfile, loadProfiles, profileYaml } from './research/profile.js';
import { captureUrl } from './research/capture.js';
import { loadResearchSources, sourceProblem } from './research/sources.js';
import { continueStudies, createStudy, listStudies, refineStudy, startProblem, startStudy, cancelStudy, studyPayload, studyView, StudyRunner } from './research/study.js';
import type { StudyBrief } from './research/refine.js';
import { runDocumentPass } from './ingest/background.js';
import type { TaskEstimate } from './estimate/estimate.js';
import { formatEstimate } from './estimate/format.js';
import { CallLedger } from './estimate/ledger.js';
import { estimateProcessing } from './estimate/processing.js';
import { quotaSources } from './estimate/quota.js';
import { estimateStudy } from './estimate/study.js';
import { REMOTE_SCOPES, RemoteScope, RemoteTokenStore } from './remote/tokens.js';
import { WORK_KINDS } from './work/kinds.js';
import { registerAuthCommands } from './auth/cli.js';
import { describeLinkedFolders, importFolder, refreshLinkedFolders, unlinkFolder } from './ingest/folders.js';
import { describeFeishuLinks, feishuCheckTime, feishuClient, FeishuPlaced, FeishuSignIn, importFeishuBatch, lastFeishuCheck, refreshFeishuLinks, splitFeishuInputs, unlinkFeishuDocument } from './ingest/feishu/docs.js';
import { requeueFailedExtractions } from './graph/tier1.js';
import { sync } from './ingest/sync.js';
import { historyOf, lineageOf } from './lineage/inspect.js';
import { forgetSource, purgeArchived, purgeDisposed } from './lineage/purge.js';
import { rebuild } from './lineage/rebuild.js';
import { pruneShortSummaries, reconcileViews } from './wiki/pages.js';
import { buildContextPack } from './pack/pack.js';
import { applySuggestion, optimizePacks } from './pack/learn.js';
import { listSuggestions, setSuggestionStatus } from './store/queries.js';
import { seedStockDemo } from './demo/stock.js';
import { refineWiki } from './wiki/refine.js';
import { lintWiki } from './wiki/lint.js';
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

const syncCommand = async (opts: { llm?: boolean; datasources?: boolean; only?: string[]; verify?: boolean; reapply?: boolean; deferEmbeddings?: boolean }) => {
  const ctx = await createContext(dataDir());
  // deferred: chunks are written without vectors and the running server's
  // background embedder fills them in, so a CLI pass never competes with it
  // for the rate-limited pool — a re-apply of a whole workspace always defers
  const defer = Boolean(opts.reapply || opts.deferEmbeddings);
  const stats = await sync(defer ? { ...ctx, embeddings: { kick() {} } } : ctx, {
    llmGraph: opts.llm,
    datasources: opts.datasources === false ? false : undefined,
    only: opts.only && opts.only.length ? opts.only : undefined,
    verify: opts.verify,
    reapply: opts.reapply,
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
  .option('--reapply', 'also re-apply documents whose content is unchanged: tier-0 evidence recomputed, tier-1 replayed from the sidecar, chunks and vectors kept, nothing new queued where the sidecar tier-1 is done (implies --defer-embeddings)')
  .option('--defer-embeddings', 'write chunks without vectors and leave embedding to the running server, as `serve` does')
  .action(syncCommand);

const concepts = program.command('concepts').description('tier-0 concept mining: the stop terms learned from the corpus (playbooks/concepts/)');
concepts
  .command('learn')
  .description('scan the indexed documents and write playbooks/concepts/frequent.yaml — terms in more than 2% of them are never mined as concepts; run it before `sync --reapply`')
  .option('--ratio <share>', 'document share above which a term is frequent', '0.02')
  .option('--limit <n>', 'at most this many learned terms (default 20000)')
  .action(async (opts) => {
    const ctx = await createContext(dataDir());
    const r = await learnFrequentTerms(ctx.store, { ratio: Number(opts.ratio), limit: opts.limit ? Number(opts.limit) : undefined, onProgress: (m) => console.log(`  ${m}`) });
    console.log(JSON.stringify({
      docs: r.docs,
      threshold: r.threshold || null,
      terms: r.terms.length,
      file: r.threshold ? CONCEPT_FREQUENT_FILE : `nothing learned: fewer than ${FREQUENT_MIN_CORPUS} indexed documents`,
      top: r.terms.slice(0, 40).map((t) => `${t.term} (${t.docs})`),
    }, null, 2));
    await ctx.datasources.closeAll();
    await ctx.store.close();
  });

program
  .command('ingest')
  .description('alias of `sync`')
  .option('--no-llm', 'do not queue changed docs for tier-1 LLM extraction')
  .option('--no-datasources', 'skip live datasource schema sync')
  .action(syncCommand);

program
  .command('extract')
  .description('run one background document pass: extraction calls from the priority queue (heat × freshness × importance; long documents in segments), the duplicate audits over the entities and claims it wrote, summary pages')
  .option('--batch <n>', 'max extraction calls (and summaries) this pass')
  .option('--concurrency <n>', 'parallel LLM calls')
  .option('--retry-failed', 'first re-queue documents with segments that failed repeatedly, so they are tried again')
  .action(async (opts) => {
    const ctx = await createContext(dataDir());
    if (opts.retryFailed) console.log(`re-queued ${await requeueFailedExtractions(ctx.store, ctx.config)} document(s) with failed segments`);
    const { touched, touchedClaims, documents, resolve, claims, summaries, ...stats } = await runDocumentPass(ctx, {
      batchSize: opts.batch ? Number(opts.batch) : undefined,
      concurrency: opts.concurrency ? Number(opts.concurrency) : undefined,
      onProgress: (m) => console.log(`  ${m}`),
    });
    console.log(JSON.stringify({ ...stats, entitiesTouched: touched.length, claimsTouched: touchedClaims.length, documents, resolve, claims, summaries }, null, 2));
    await ctx.datasources.closeAll();
    await ctx.store.close();
  });

program
  .command('translate')
  .description('translate documents into a content language now, on the Translate stage\'s route, segment by segment (docs/design/17); --status: translations by language')
  .argument('[paths...]', 'documents under raw/docs')
  .option('--lang <code>', 'the language to translate into (default: the primary content language)')
  .option('--retries <n>', 'tries more per segment whose answer will not do', '1')
  .option('--status', 'print translations by language and status, translate nothing')
  .action(async (paths: string[], opts: { lang?: string; retries: string; status?: boolean }) => {
    const ctx = await createContext(dataDir());
    try {
      const languages = contentLanguages(ctx.config);
      if (opts.status || paths.length === 0) {
        const rows = await ctx.store.query<{ language: string; status: string; n: number; parts: number }>(
          `SELECT t.language, t.status, count(*)::int AS n, COALESCE(sum(t.parts), 0)::int AS parts
           FROM translations t JOIN documents d ON d.id = t.document_id AND d.sha256 = t.content_sha AND d.status = 'indexed'
           GROUP BY t.language, t.status ORDER BY t.language, t.status`,
        );
        const byLanguage = await ctx.store.query<{ language: string | null; n: number }>(
          `SELECT language, count(*)::int AS n FROM documents WHERE root = 'docs' AND status = 'indexed' AND kind = 'source' GROUP BY language ORDER BY n DESC`,
        );
        console.log(JSON.stringify({
          languages: { enabled: languages.on, primary: languages.primary, secondary: languages.secondary, maxChars: languages.maxChars },
          documents: Object.fromEntries(byLanguage.map((r) => [r.language === null ? 'unknown (not read yet)' : r.language || 'none', r.n])),
          translations: rows,
        }, null, 2));
        return;
      }
      const target = opts.lang ? normalizeLanguage(opts.lang) : languages.primary;
      if (!target) {
        console.error(opts.lang ? `unknown language "${opts.lang}"` : 'no --lang given and no primary content language configured (languages.primary)');
        process.exitCode = 1;
        return;
      }
      const llm = new LlmClient(resolveRoutedLlmConfig(ctx.config.llm, ctx.config.extraction.translateLlm, routeTargets(ctx.config)));
      if (!llm.enabled) {
        console.error('the Translate stage runs on nothing — pick a model or an agent for it (Settings → Ingest → Translate, extraction.translateLlm)');
        process.exitCode = 1;
        return;
      }
      for (const p of paths) {
        const [doc] = await ctx.store.query<DocumentRow>(`SELECT * FROM documents WHERE path = $1 AND status = 'indexed' AND root = 'docs'`, [p]);
        if (!doc) {
          console.error(`${p}: no indexed document under raw/docs`);
          process.exitCode = 1;
          continue;
        }
        const r = await translateNow(ctx.store, ctx.dataDir, doc, target, llm, { retries: Number(opts.retries) || 0, onProgress: (m) => console.log(`  ${m}`) });
        console.log(JSON.stringify({ path: p, language: target, ...r }));
        if (r.status === 'failed') process.exitCode = 1;
      }
    } finally {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });

program
  .command('estimate')
  .description('what a task would take before it starts: model calls, tokens, time, transfer, cost at API prices, and the share of each plan (Codex, Cursor, Claude Code) — `processing` (extraction, reviews, summaries) or `study <id>`')
  .argument('[task]', 'processing | study', 'processing')
  .argument('[id]', "a study's id")
  .option('--json', 'print the estimate as JSON')
  .action(async (task: string, id: string | undefined, opts) => {
    const ctx = await createContext(dataDir());
    try {
      const quota = quotaSources(ctx.config);
      let estimate: TaskEstimate;
      if (task === 'study') {
        const job = id ? await getJob(ctx.store, id) : null;
        if (!job || job.kind !== 'study') throw new Error(id ? `no study ${id}` : 'name the study: knode-os estimate study <id>');
        estimate = await estimateStudy({ store: ctx.store, config: ctx.config, job, quota, showBalance: true });
      } else if (task === 'processing') {
        // remote workers are known only to a running `serve`; from here the estimate counts this machine's slots
        estimate = await estimateProcessing({ store: ctx.store, config: ctx.config, ledger: CallLedger.forWorkspace(ctx.dataDir), workers: [], quota, showBalance: true });
      } else {
        throw new Error(`no such task: ${task} (processing | study)`);
      }
      console.log(opts.json ? JSON.stringify(estimate, null, 2) : formatEstimate(estimate));
    } finally {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });

/* ------------------------------ remote access ------------------------------ */

const remote = program
  .command('remote')
  .description('tokens for the remote API other machines use — extraction and summary workers, document reads/writes, read-only SQL (see src/remote)');

const remoteTokens = remote.command('token').description('create, list or revoke remote API tokens (stored hashed under <data>/.knode)');

const collect = (value: string, previous: string[] = []) => [...previous, ...value.split(',').map((v) => v.trim()).filter(Boolean)];

remoteTokens
  .command('create')
  .description('mint a token for one machine or application; the token is printed once')
  .requiredOption('--name <name>', 'who uses it, e.g. macbook-labeler or aliyun-sg')
  .option('--scope <scope...>', `what it may do: ${REMOTE_SCOPES.join(', ')} (repeat or comma-separate)`, collect, [] as string[])
  .option('--workspace <workspace...>', 'workspaces it may use: <user>/<workspace-id>, team/<name>, or * (repeat or comma-separate)', collect, [] as string[])
  .option('--kinds <kind...>', `the kinds of work "label" covers for it: ${WORK_KINDS.join(', ')} (default: all)`, collect, [] as string[])
  .action((opts: { name: string; scope: string[]; workspace: string[]; kinds: string[] }) => {
    const store = new RemoteTokenStore(dataDir());
    const { token, record } = store.create({ name: opts.name, scopes: opts.scope as RemoteScope[], workspaces: opts.workspace, kinds: opts.kinds });
    console.log(`token ${record.id} for ${record.name}: scopes ${record.scopes.join(', ')}${record.kinds ? ` (work: ${record.kinds.join(', ')})` : ''}; workspaces ${record.workspaces.join(', ')}`);
    console.log('');
    console.log(token);
    console.log('');
    console.log('This is the only time the token is shown. A running `serve` accepts it at once.');
  });

remoteTokens
  .command('list')
  .description('tokens with their scopes, workspaces and last use (never the secrets)')
  .option('--json', 'raw JSON output')
  .action((opts: { json?: boolean }) => {
    const tokens = new RemoteTokenStore(dataDir()).list().map(({ hash: _hash, ...t }) => t);
    if (opts.json) return console.log(JSON.stringify(tokens, null, 2));
    if (tokens.length === 0) return console.log('no remote tokens — `knode-os remote token create --name <machine> --scope label --workspace <user>/<workspace>`');
    for (const t of tokens) {
      console.log(`${t.id}  ${t.name}  [${t.scopes.join(',')}${t.kinds ? `; work: ${t.kinds.join(',')}` : ''}]  ${t.workspaces.join(',')}  created ${t.createdAt.slice(0, 10)}${t.lastUsedAt ? `, last used ${t.lastUsedAt.slice(0, 16)}` : ''}${t.revokedAt ? `  REVOKED ${t.revokedAt.slice(0, 10)}` : ''}`);
    }
  });

remoteTokens
  .command('revoke <idOrName>')
  .description('revoke a token; a running `serve` refuses it from the next request')
  .action((idOrName: string) => {
    const record = new RemoteTokenStore(dataDir()).revoke(idOrName);
    console.log(`revoked ${record.id} (${record.name})`);
  });

/* --------------------- accounts, gateways, certificate --------------------- */

registerAuthCommands(program, dataDir);

/* --------------------------- folders from this machine --------------------------- */

const folders = program
  .command('folders')
  .description('import a folder from this machine into raw/docs with its tree intact, once or kept in sync (see src/ingest/folders.ts)');

/** The numbers one import or refresh produced, as one line. */
const describeMirror = (r: { copied: string[]; removed: string[]; unchanged: number; tooLarge: number; skippedByType: number }) =>
  `${r.copied.length} copied, ${r.removed.length} removed, ${r.unchanged} unchanged${r.tooLarge ? `, ${r.tooLarge} above the index limit (copied, not indexed)` : ''}${r.skippedByType ? `, ${r.skippedByType} of unsupported types left behind` : ''}`;

const SERVE_HINT = 'note: a running `knode-os serve` keeps its own copy of the config — restart it, or link through the app, for it to watch this folder';

folders
  .command('list')
  .description('linked folders and the state of their mirrors')
  .option('--json', 'raw JSON output')
  .action(async (opts) => {
    const ctx = await createContext(dataDir());
    const links = describeLinkedFolders(ctx);
    if (opts.json) console.log(JSON.stringify(links, null, 2));
    else if (links.length === 0) console.log('no linked folders — `knode-os folders link <folder>` mirrors one under raw/docs and keeps it in sync');
    else for (const l of links) console.log(`${l.dest}  ←  ${l.source}${l.sourceExists ? '' : '  (source missing)'}  ${l.files} files, ${(l.bytes / 1e6).toFixed(1)} MB, linked ${l.createdAt.slice(0, 10)}`);
    await ctx.store.close();
  });

const importAction = (mode: 'copy' | 'link') => async (source: string, opts: { to?: string; replace?: boolean; llm?: boolean }) => {
  const ctx = await createContext(dataDir());
  try {
    const r = await importFolder(ctx, source, { dest: opts.to, mode, replace: Boolean(opts.replace), llmGraph: opts.llm, onProgress: (m) => console.log(`  ${m}`) });
    console.log(`${mode === 'link' ? 'linked' : 'imported'} ${r.source} → ${r.dest}: ${describeMirror(r)}`);
    if (r.sync) console.log(`indexed: ${r.sync.indexed} applied, ${r.sync.unchanged} unchanged, ${r.sync.skipped} skipped, ${r.sync.errors} errors`);
    if (mode === 'link') console.log(SERVE_HINT);
  } finally {
    await ctx.datasources.closeAll();
    await ctx.store.close();
  }
};

folders
  .command('import <source>')
  .description('copy a folder once into raw/docs/<name> (its tree intact) and index it')
  .option('--to <dest>', 'destination under raw/docs (default: the folder\'s own name)')
  .option('--replace', 'allow an existing destination: it becomes a mirror of the source')
  .option('--no-llm', 'do not queue the documents for tier-1 LLM extraction')
  .action(importAction('copy'));

folders
  .command('link <source>')
  .description('mirror a folder into raw/docs/<name> and keep it in sync: `serve` watches it and indexes every change')
  .option('--to <dest>', 'destination under raw/docs (default: the folder\'s own name)')
  .option('--replace', 'allow an existing destination: it becomes the mirror')
  .option('--no-llm', 'do not queue the documents for tier-1 LLM extraction')
  .action(importAction('link'));

folders
  .command('sync [dest]')
  .description('mirror the linked folders\' sources now and index what changed (one link with <dest>)')
  .action(async (dest?: string) => {
    const ctx = await createContext(dataDir());
    try {
      const results = await refreshLinkedFolders(ctx, dest, { onProgress: (m) => console.log(`  ${m}`) });
      for (const r of results) {
        console.log(r.sourceMissing ? `${r.dest}: source folder missing — mirror left alone` : `${r.dest}: ${describeMirror(r)}${r.sync ? `; ${r.sync.indexed} applied, ${r.sync.disposed} disposed` : ''}`);
      }
    } finally {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });

folders
  .command('unlink <dest>')
  .description('forget a link; the mirrored files stay as ordinary documents unless --remove-files')
  .option('--remove-files', 'also delete the mirror and dispose its documents')
  .action(async (dest: string, opts: { removeFiles?: boolean }) => {
    const ctx = await createContext(dataDir());
    try {
      const r = await unlinkFolder(ctx, dest, { removeFiles: Boolean(opts.removeFiles), onProgress: (m) => console.log(`  ${m}`) });
      console.log(r.removedFiles ? `unlinked ${r.dest} and removed its files (${r.sync?.disposed ?? 0} disposed)` : `unlinked ${r.dest}; its files stay as ordinary documents`);
      console.log(SERVE_HINT);
    } finally {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });

/* ------------------------------ Feishu documents ------------------------------ */

const feishu = program
  .command('feishu')
  .description('import Feishu (Lark) documents into raw/docs with their pictures, once or kept in sync — read through lark-cli as the signed-in Feishu user (see src/ingest/feishu/docs.ts)');

const FEISHU_SERVE_HINT = 'note: a running `knode-os serve` keeps its own copy of the config — restart it, or link through the app, for its daily check to include this';

feishu
  .command('status')
  .description('who lark-cli is signed in as, and whether it may read what knode-os needs')
  .option('--json', 'raw JSON output')
  .action(async (opts) => {
    const status = await feishuClient(loadConfig(dataDir())).status();
    if (opts.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    if (!status.installed) console.log(`lark-cli: not found (${status.cli}) — ${status.error}`);
    else if (!status.signedIn) console.log(`lark-cli ${status.cli}: no Feishu user signed in — run \`knode-os feishu login\``);
    else {
      console.log(`signed in to ${status.brand ?? 'feishu'} as ${status.user?.name} (${status.user?.openId}) through app ${status.appId}`);
      console.log(status.missingScopes.length ? `missing scopes: ${status.missingScopes.join(', ')} — run \`knode-os feishu login\`` : 'every scope knode-os needs is granted');
      if (status.refreshExpiresAt) console.log(`stays signed in while used before ${status.refreshExpiresAt} (each use renews it)`);
    }
    const config = loadConfig(dataDir());
    const at = feishuCheckTime(config);
    const last = lastFeishuCheck(dataDir());
    console.log(`${at ? `\`serve\` checks linked documents daily at ${at}` : 'the daily check is off (ingest.feishu.checkAt)'}; last checked ${last ?? 'never'}`);
  });

feishu
  .command('login')
  .description('authorize knode-os once: prints a Feishu link to open on any device, then waits until it is approved')
  .action(async () => {
    const client = feishuClient(loadConfig(dataDir()));
    const status = await client.status();
    if (!status.installed) throw new Error(status.error ?? 'lark-cli is not installed');
    const signIn = new FeishuSignIn(() => client);
    const state = await signIn.begin(status);
    console.log(`open this link and approve: ${state.verificationUrl}`);
    console.log(`(it expires ${state.expiresAt})`);
    await signIn.settled();
    const done = signIn.state();
    if (done.state !== 'done') throw new Error(done.error ?? 'sign-in did not finish');
    const after = await client.status();
    console.log(`signed in as ${after.user?.name ?? 'the approving user'}${after.missingScopes.length ? `; still missing ${after.missingScopes.join(', ')}` : ''}`);
  });

feishu
  .command('list')
  .description('linked Feishu documents and the revision each mirror holds')
  .option('--json', 'raw JSON output')
  .action(async (opts) => {
    const ctx = await createContext(dataDir());
    const links = describeFeishuLinks(ctx);
    if (opts.json) console.log(JSON.stringify(links, null, 2));
    else if (links.length === 0) console.log('no linked Feishu documents — `knode-os feishu link <url>` mirrors one under raw/docs and keeps it in sync');
    else {
      for (const l of links) {
        console.log(l.type === 'wiki-tree'
          ? `${l.dest}  ←  ${l.url}  "${l.title}", a wiki tree of ${l.pages ?? '?'} pages (${l.documents ?? '?'} documents)`
          : `${l.dest}  ←  ${l.url}  "${l.title}", revision ${l.revision ?? '?'}, edited ${l.modifiedAt ?? '?'}, ${l.images} pictures, ${l.attachments} attachments${l.failed ? `, ${l.failed} not downloaded yet` : ''}`);
      }
    }
    await ctx.store.close();
  });

const describePlaced = (r: FeishuPlaced, mode: 'copy' | 'link') => {
  const verb = r.refreshed ? 'refreshed' : mode === 'link' ? 'linked' : 'imported';
  const what = r.pages ? `a wiki tree of ${r.pages.total} pages (${r.pages.documents} documents, ${r.pages.fetched} fetched)` : `revision ${r.revision}`;
  return `${verb} "${r.title}" — ${what} → ${r.file ?? r.dest}\n  ${r.images} pictures, ${r.attachments} attachments${r.keptInFeishu ? `, ${r.keptInFeishu} kept in Feishu` : ''}; ${r.written.length} written, ${r.removed.length} removed`;
};

const feishuImportAction = (mode: 'copy' | 'link') => async (urls: string[], opts: { to?: string; llm?: boolean; subpages?: boolean }) => {
  const ctx = await createContext(dataDir());
  try {
    const inputs = splitFeishuInputs(urls);
    const out = await importFeishuBatch(ctx, feishuClient(ctx.config), inputs, { dest: opts.to, mode, subpages: opts.subpages, llmGraph: opts.llm, onProgress: (m) => console.log(`  ${m}`) });
    for (const item of out.items) {
      if (!item.ok) {
        console.log(`${item.input}: ${item.error}`);
        continue;
      }
      console.log(describePlaced(item.result!, mode));
      for (const w of item.result!.warnings) console.log(`  warning: ${w}`);
    }
    if (out.sync) console.log(`indexed: ${out.sync.indexed} applied, ${out.sync.unchanged} unchanged, ${out.sync.skipped} skipped, ${out.sync.errors} errors`);
    if (mode === 'link' && out.items.some((x) => x.ok)) console.log(FEISHU_SERVE_HINT);
    if (out.items.some((x) => !x.ok)) process.exitCode = 1;
  } finally {
    await ctx.datasources.closeAll();
    await ctx.store.close();
  }
};

feishu
  .command('import <url...>')
  .description('copy Feishu documents once into raw/docs/feishu/<title>__<token>/ (pictures and indexable attachments beside them) and index them; a wiki space comes with all its pages, a wiki page with --subpages with those under it, as folders that keep the wiki\'s structure')
  .option('--to <dest>', 'destination under raw/docs, for one link (default raw/docs/feishu/<title>__<token>)')
  .option('--subpages', 'bring a wiki page with the pages under it')
  .option('--no-llm', 'do not queue the documents for tier-1 LLM extraction')
  .action(feishuImportAction('copy'));

feishu
  .command('link <url...>')
  .description('mirror Feishu documents (or, with --subpages, wiki pages with the pages under them; a wiki space whole) and keep them in sync: `serve` asks Feishu once a day which were edited')
  .option('--to <dest>', 'destination under raw/docs, for one link (default raw/docs/feishu/<title>__<token>)')
  .option('--subpages', 'follow a wiki page with the pages under it')
  .option('--no-llm', 'do not queue the documents for tier-1 LLM extraction')
  .action(feishuImportAction('link'));

feishu
  .command('sync [dest]')
  .description('ask Feishu now which linked documents were edited and re-mirror those (one link with <dest>)')
  .option('--force', 'fetch every linked document, edited or not')
  .action(async (dest: string | undefined, opts: { force?: boolean }) => {
    const ctx = await createContext(dataDir());
    try {
      const results = await refreshFeishuLinks(ctx, feishuClient(ctx.config), { dest, force: Boolean(opts.force), onProgress: (m) => console.log(`  ${m}`) });
      if (results.length === 0) console.log('no linked Feishu documents');
      for (const r of results) {
        const pages = r.pages ? ` (${r.pages.fetched} of ${r.pages.total} pages fetched, ${r.pages.moved} moved, ${r.pages.removed} gone)` : '';
        console.log(r.error ? `${r.dest}: ${r.error}` : r.fetched ? `${r.dest}: fetched${pages} — ${r.written} written, ${r.removed} removed${r.sync ? `; ${r.sync.indexed} applied, ${r.sync.disposed} disposed` : ''}` : `${r.dest}: unchanged since ${r.modifiedAt ?? 'the last fetch'}`);
        for (const w of r.warnings) console.log(`  warning: ${w}`);
      }
    } finally {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });

feishu
  .command('unlink <dest>')
  .description('stop following a Feishu document; the mirror stays as ordinary documents unless --remove-files')
  .option('--remove-files', 'also delete the mirror and dispose its documents')
  .action(async (dest: string, opts: { removeFiles?: boolean }) => {
    const ctx = await createContext(dataDir());
    try {
      const r = await unlinkFeishuDocument(ctx, dest, { removeFiles: Boolean(opts.removeFiles), onProgress: (m) => console.log(`  ${m}`) });
      console.log(r.removedFiles ? `unlinked ${r.dest} and removed its files (${r.sync?.disposed ?? 0} disposed)` : `unlinked ${r.dest}; its files stay as ordinary documents`);
      console.log(FEISHU_SERVE_HINT);
    } finally {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });

program
  .command('search <query>')
  .description('search the knowledge base; sag adds query-time chunk/entity multi-hop expansion')
  .option('-k <n>', 'number of results', '8')
  .option('-m, --mode <mode>', 'hybrid | vector | keyword | sag', 'hybrid')
  .option('--as-of <iso>', 'system time: only documents that were live at that instant')
  .option('--kinds <list>', 'restrict to source kinds: doc,wiki,view,skill,trace')
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
  .description('answer a question from the knowledge base with citations (runs on the Judge stage, extraction.judgeLlm)')
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
  .option('--kinds <list>', 'restrict to source kinds: doc,wiki,view,skill,trace')
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
  .option('--kinds <list>', 'restrict to source kinds: doc,wiki,view,skill,trace')
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
  .option('--kind <list>', 'comma-separated: fact,opinion,prediction,rumor')
  .option('--text <substring>', 'substring of the statement')
  .option('-n, --limit <n>', 'max rows', '50')
  .option('--as-of <iso>', 'system time: what the knowledge base believed then')
  .option('--valid-at <iso>', 'world time: only claims valid at that instant')
  .option('--valid-range <window>', 'world time window: 2026-01-01..2026-06-30 | 2026-08 | 2026')
  .option('--kinds <list>', 'restrict to source kinds: doc,wiki,view,skill,trace')
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
      kinds: list(opts.kind),
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
  .option('--apply', 'immediately accept + write every proposed revision to playbooks/packs/')
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
  .option('--as-indexed', 'validate the view knode-os indexes (frontmatter normalizer applied in memory) — what a raw/docs subtree looks like to the pipeline')
  .action((bundle, opts) => {
    const root = bundle ? path.resolve(bundle) : path.join(dataDir(), 'wiki');
    const result = validateOkfBundle(root, { asIndexed: Boolean(opts.asIndexed) });
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
  .description('upgrade the native wiki structure to OKF v0.2 while preserving content and extension fields')
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
  .description('fill in summary pages for documents still missing one (the Summarize stage, up to 20) + entity stubs; the background document pass writes summaries as documents arrive')
  .action(async () => {
    const ctx = await createContext(dataDir());
    const created = await generateWiki(ctx.store, ctx.llm, { config: ctx.config, embedder: ctx.embedder, datasources: ctx.datasources, onProgress: (m) => console.log(`  ${m}`) });
    console.log(created.length ? `created:\n  ${created.join('\n  ')}` : 'nothing to generate');
    await ctx.datasources.closeAll();
    await ctx.store.close();
  });
wiki
  .command('refine')
  .description('the nightly tier-2 pass: claim audit, full duplicate-entity audit, claim review, hot topics in wiki/index.md, research recommendations (hot communities become concept research suggestions)')
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
wiki
  .command('lint')
  .description('health check of the wiki (orphans, broken links, stale / unreviewed research pages, expired and superseded text); writes wiki/lint/<date>.md and files refresh suggestions')
  .option('--no-report', 'print findings only, write nothing')
  .action(async (opts: { report: boolean }) => {
    const ctx = await createContext(dataDir());
    try {
      const r = await lintWiki(ctx, { report: opts.report, file: opts.report, onProgress: (m) => console.log(`  ${m}`) });
      for (const i of r.issues) console.log(`${i.kind.padEnd(16)} ${i.path}  ${i.detail}`);
      console.log(JSON.stringify({ pages: r.pages, counts: r.counts, entityLinks: { links: r.entityLinks.links, entities: r.entityLinks.entities }, report: r.reportPath, suggestions: r.suggestions }, null, 2));
    } finally {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });
wiki
  .command('prune-summaries')
  .description('archive the summary pages of documents under extraction.summaryMinChars (to wiki/.archive; the cached summaries stay, so lowering the threshold brings them back without a model call)')
  .option('--dry-run', 'list the pages without archiving them')
  .option('--min-chars <n>', 'apply this threshold instead of the configured one')
  .action(async (opts: { dryRun?: boolean; minChars?: string }) => {
    const minChars = opts.minChars === undefined ? undefined : Number(opts.minChars);
    if (minChars !== undefined && !(Number.isFinite(minChars) && minChars >= 0)) {
      console.error('--min-chars must be a number of characters');
      process.exitCode = 1;
      return;
    }
    const ctx = await createContext(dataDir());
    try {
      const r = await pruneShortSummaries(ctx, { minChars, dryRun: Boolean(opts.dryRun), actor: 'cli', onProgress: (m) => console.log(`  ${m}`) });
      console.log(JSON.stringify({ minChars: r.minChars, dryRun: Boolean(opts.dryRun), archived: r.archived.length, kept: r.kept }, null, 2));
    } finally {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
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
  .description('drop the derived index (the workspace\'s schema on PostgreSQL, or .knode/db with PGlite) and reconstruct it from files + ledger (original apply times kept for unchanged sources)')
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
  .description('register the MCP server with a client: claude | codex | cursor (the Streamable HTTP endpoint `knode-os serve` hosts; --stdio for a standalone process)')
  .option('--stdio', 'register a stdio process (`knode-os mcp`) instead of the HTTP endpoint — for use without a running serve')
  .option('--http', 'register the HTTP endpoint (the default; kept for scripts)')
  .option('--url <url>', 'MCP endpoint URL (default: http://<server.host>:<server.port><server.mcp.path>)')
  .option('--user <user>', 'workspace owner the agent acts as', 'admin')
  .option('--workspace <id>', 'workspace id under users/<user>/workspaces', 'default')
  .action(async (client: string, opts: { http?: boolean; stdio?: boolean; url?: string; user: string; workspace: string }) => {
    const dir = dataDir();
    initDataDir(dir);
    if (!opts.stdio) {
      const { loadConfig } = await import('./config.js');
      const { loadOrCreateMcpToken } = await import('./server/mcp-http.js');
      const config = loadConfig(dir);
      const token = loadOrCreateMcpToken(dir);
      const url = opts.url ?? `http://${config.server.host}:${config.server.port}${config.server.mcp?.path || '/mcp'}`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'x-knode-user': opts.user,
        'x-knode-workspace-kind': 'personal',
        'x-knode-workspace-id': opts.workspace,
        'x-knode-workspace-name': opts.workspace,
      };
      if (client === 'claude') {
        const args = ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'knode-os', url];
        for (const [k, v] of Object.entries(headers)) args.push('--header', `${k}: ${v}`);
        try {
          execFileSync('claude', args, { stdio: 'inherit' });
          console.log('registered with Claude Code (user scope, http).');
        } catch {
          console.log('`claude` CLI not found or registration failed. Add manually:');
          console.log(`  claude ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`);
        }
      } else if (client === 'codex') {
        // codex takes a URL and a bearer-token env var; the workspace rides in the query string
        const q = new URLSearchParams({ user: opts.user, kind: 'personal', id: opts.workspace, name: opts.workspace });
        const full = `${url}?${q.toString()}`;
        try {
          execFileSync('codex', ['mcp', 'add', 'knode-os', '--url', full, '--bearer-token-env-var', 'KNODE_MCP_TOKEN'], { stdio: 'inherit' });
          console.log('registered with Codex (http).');
        } catch {
          console.log('`codex` CLI not found or registration failed. Add to ~/.codex/config.toml:');
          console.log(`\n[mcp_servers.knode-os]\nurl = ${JSON.stringify(full)}\nbearer_token_env_var = "KNODE_MCP_TOKEN"\n`);
        }
        console.log(`export KNODE_MCP_TOKEN=${token}   # add to your shell profile; codex reads the token from this variable`);
      } else if (client === 'cursor') {
        const file = path.join(os.homedir(), '.cursor', 'mcp.json');
        let json: { mcpServers?: Record<string, unknown> } = {};
        try {
          json = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof json;
        } catch {
          json = {};
        }
        json.mcpServers = { ...(json.mcpServers ?? {}), 'knode-os': { url, headers } };
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
        console.log(`registered in ${file} (http).`);
      } else {
        console.error('unknown client; use `claude`, `codex` or `cursor`');
        process.exitCode = 1;
      }
      return;
    }

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
    } else if (client === 'cursor') {
      const file = path.join(os.homedir(), '.cursor', 'mcp.json');
      let json: { mcpServers?: Record<string, unknown> } = {};
      try {
        json = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof json;
      } catch {
        json = {};
      }
      json.mcpServers = { ...(json.mcpServers ?? {}), 'knode-os': { command: cmd, args } };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
      console.log(`registered in ${file}`);
    } else {
      console.error('unknown client; use `claude`, `codex` or `cursor`');
      process.exitCode = 1;
    }
  });

const entities = program.command('entities').description('entity resolution: merge duplicates, undo merges, run the duplicate audit');
entities
  .command('merge <entity> <into>')
  .description('record that <entity> is the same as <into>; reads redirect to <into>, evidence is untouched, reversible with unmerge')
  .option('--reason <text>', 'why (kept on the link and in the ledger)')
  .option('--actor <name>', 'who decided', 'user')
  .action(async (entity: string, into: string, opts: { reason?: string; actor: string }) => {
    const ctx = await createContext(dataDir());
    try {
      console.log(JSON.stringify(await applyMerge(ctx.store, { entityId: entity, canonicalId: into, reason: opts.reason, actor: opts.actor }), null, 2));
    } finally {
      await ctx.store.close();
    }
  });
entities
  .command('unmerge <entity>')
  .description('undo a merge (disposes the merge scope; the entity stands on its own again)')
  .option('--actor <name>', 'who decided', 'user')
  .action(async (entity: string, opts: { actor: string }) => {
    const ctx = await createContext(dataDir());
    try {
      console.log((await unmergeEntity(ctx.store, entity, { actor: opts.actor })) ? 'unmerged' : 'no live merge for that entity');
    } finally {
      await ctx.store.close();
    }
  });
entities
  .command('merges')
  .description('list live merges')
  .action(async () => {
    const ctx = await createContext(dataDir());
    try {
      for (const m of await listMerges(ctx.store)) console.log(`${m.entityId} → ${m.canonicalId}  (${m.entityName} → ${m.canonicalName}; ${m.actor ?? '?'}: ${m.reason || '-'})`);
    } finally {
      await ctx.store.close();
    }
  });
entities
  .command('correct <entity>')
  .description('correct one entity by hand — its type, spellings it does not answer to — in playbooks/entities/corrections.yaml; the fold applies it at once, evidence is untouched, --clear takes it back')
  .option('--type <type>', 'the type it is (an entity type of the ontology)')
  .option('--untype', 'take a corrected type back')
  .option('--not-alias <spelling...>', 'spellings it does not answer to: off its aliases and lookup keys, never resolved or linked onto it')
  .option('--allow-alias <spelling...>', 'spellings to take off that list again')
  .option('--clear', 'take the whole correction back')
  .option('--reason <text>', 'why (kept in the file and the ledger)')
  .option('--actor <name>', 'who decided', 'user')
  .action(async (entity: string, opts: { type?: string; untype?: boolean; notAlias?: string[]; allowAlias?: string[]; clear?: boolean; reason?: string; actor: string }) => {
    const ctx = await createContext(dataDir());
    try {
      const type = opts.untype ? null : opts.type;
      console.log(JSON.stringify(await correctEntity(ctx.store, { entity, type, notAliases: opts.notAlias, allowAliases: opts.allowAlias, clear: opts.clear, reason: opts.reason, actor: opts.actor }), null, 2));
    } finally {
      await ctx.store.close();
    }
  });
entities
  .command('corrections')
  .description('list the corrections made by hand (playbooks/entities/corrections.yaml)')
  .action(() => {
    for (const [id, c] of readEntityCorrections(dataDir())) {
      const what = [c.type ? `type ${c.type}` : null, c.notAliases?.length ? `not ${c.notAliases.join(', ')}` : null].filter(Boolean).join('; ');
      console.log(`${id}${c.name && c.name !== id ? ` (${c.name})` : ''}: ${what}${c.reason ? `  — ${c.reason}` : ''}`);
    }
  });
entities
  .command('dedupe')
  .description('find probable duplicate entities now and queue them as merge suggestions (normally nightly)')
  .action(async () => {
    const ctx = await createContext(dataDir());
    try {
      console.log(JSON.stringify(await auditDuplicateEntities(ctx, { onProgress: (m) => console.log(`  ${m}`) }), null, 2));
    } finally {
      await ctx.store.close();
    }
  });
entities
  .command('relink')
  .description('recompute every document\'s tier-0 links against the current link surfaces (after a stop-list edit or a rule change): mentions and counts follow, nothing is re-extracted')
  .option('--limit <n>', 'relink only the first n documents by path (a trial run)')
  .action(async (opts: { limit?: string }) => {
    const ctx = await createContext(dataDir());
    try {
      const limit = opts.limit !== undefined ? Number(opts.limit) : undefined;
      if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) throw new Error('--limit takes a non-negative integer');
      console.log(JSON.stringify(await relinkTier0(ctx.store, { limit, onProgress: (m) => console.log(`  ${m}`) }), null, 2));
    } finally {
      await ctx.store.close();
    }
  });
const reviewCmd = program.command('review').description('review passes normally run nightly: duplicate entities (LLM judge per review.llmJudge) and disputed / suspected claims');
reviewCmd
  .command('entities')
  .description('same as `entities dedupe`: score duplicate candidates, ask the LLM judge, file merge suggestions')
  .action(async () => {
    const ctx = await createContext(dataDir());
    try {
      console.log(JSON.stringify(await auditDuplicateEntities(ctx, { onProgress: (m) => console.log(`  ${m}`) }), null, 2));
    } finally {
      await ctx.store.close();
    }
  });
reviewCmd
  .command('claims')
  .description('LLM review of open disputes and suspected claims → knowledge suggestions with a verdict')
  .option('--limit <n>', 'claims per run', '20')
  .action(async (opts: { limit: string }) => {
    const ctx = await createContext(dataDir());
    try {
      console.log(JSON.stringify(await reviewClaims(ctx, { onProgress: (m) => console.log(`  ${m}`), limit: Number(opts.limit) }), null, 2));
    } finally {
      await ctx.store.close();
    }
  });

const claimCmd = program.command('claim').description('duplicate claims (docs/design/10): merge one wording into another, undo merges, run the duplicate-claim audit');
claimCmd
  .command('merge <claim> <into>')
  .description('record that <claim> states the same as <into>; reads show <into> with both sources, evidence is untouched, reversible with unmerge')
  .option('--reason <text>', 'why (kept on the link and in the ledger)')
  .option('--actor <name>', 'who decided', 'user')
  .action(async (claim: string, into: string, opts: { reason?: string; actor: string }) => {
    const ctx = await createContext(dataDir());
    try {
      console.log(JSON.stringify(await applyClaimMerge(ctx.store, { claimId: claim, canonicalId: into, reason: opts.reason, actor: opts.actor }), null, 2));
    } finally {
      await ctx.store.close();
    }
  });
claimCmd
  .command('unmerge <claim>')
  .description('undo a claim merge (disposes the claim-merge scope; the claim stands on its own again)')
  .option('--actor <name>', 'who decided', 'user')
  .action(async (claim: string, opts: { actor: string }) => {
    const ctx = await createContext(dataDir());
    try {
      console.log((await unmergeClaim(ctx.store, claim, { actor: opts.actor })) ? 'unmerged' : 'no live merge for that claim');
    } finally {
      await ctx.store.close();
    }
  });
claimCmd
  .command('merges')
  .description('list live claim merges')
  .action(async () => {
    const ctx = await createContext(dataDir());
    try {
      for (const m of await listClaimMerges(ctx.store)) {
        console.log(`${m.claimId} → ${m.canonicalId}  [${m.subject}] ${m.statement}  ⇒  ${m.canonicalStatement}  (${m.actor ?? '?'}${m.confidence !== null ? ` ${m.confidence.toFixed(2)}` : ''}: ${m.reason || '-'})`);
      }
    } finally {
      await ctx.store.close();
    }
  });
claimCmd
  .command('dedupe')
  .description('compare every claim with the other claims of its subject now and merge / suggest / flag (normally after each extraction pass and nightly)')
  .action(async () => {
    const ctx = await createContext(dataDir());
    try {
      console.log(JSON.stringify(await auditDuplicateClaims(ctx, { onProgress: (m) => console.log(`  ${m}`) }), null, 2));
    } finally {
      await ctx.store.close();
    }
  });

entities
  .command('resolve <name>')
  .description('show which entity a mention of <name> would land on')
  .option('--type <type>', 'entity type of the mention')
  .action(async (name: string, opts: { type?: string }) => {
    const ctx = await createContext(dataDir());
    try {
      console.log(JSON.stringify(await resolveEntityId(ctx.store, { name, type: opts.type }, undefined, { corrections: readEntityCorrections(ctx.dataDir) }), null, 2));
    } finally {
      await ctx.store.close();
    }
  });

/** Host a temporary MCP endpoint for this context (no `serve` needed) while `fn` runs an agent against it. */
export async function withTemporaryMcp<T>(ctx: Awaited<ReturnType<typeof createContext>>, fn: (mcp: McpEndpoint) => Promise<T>): Promise<T> {
  const { Hono } = await import('hono');
  const { serve } = await import('@hono/node-server');
  const { mountMcp, loadOrCreateMcpToken } = await import('./server/mcp-http.js');
  const token = loadOrCreateMcpToken(ctx.dataDir);
  const app = new Hono();
  mountMcp(app, { path: '/mcp', token, context: ctx });
  const server = await new Promise<{ close: () => void; port: number }>((resolve) => {
    const srv = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve({ close: () => srv.close(), port: info.port }));
  });
  try {
    return await fn({ url: `http://127.0.0.1:${server.port}/mcp`, token, headers: {} });
  } finally {
    server.close();
  }
}

/** Run one job right here: host a temporary MCP endpoint for this context, launch the agent, validate, sync. */
async function runResearchNow(ctx: Awaited<ReturnType<typeof createContext>>, job: ResearchJob, log: (m: string) => void): Promise<ResearchJob> {
  return withTemporaryMcp(ctx, (mcp) => runResearchJob(ctx, job, { mcp, log }));
}

const research = program.command('research').description('deep-research wiki pages written by a coding-agent CLI (claude / codex / cursor) through the knode MCP endpoint');
research
  .command('queue <kind> [target...]')
  .description(`queue a page: kind = ${RESEARCH_KINDS.join(' | ')}; target = entity / concept name, "A vs B", or a wiki path for refresh`)
  .option('--query <question>', 'for kind question: the question to answer and file')
  .option('--template <name>', 'template file stem under playbooks/research (default: the kind)')
  .option('--now', 'run it right now in this process instead of waiting for serve')
  .action(async (kind: string, targetParts: string[], opts: { query?: string; template?: string; now?: boolean }) => {
    if (!RESEARCH_KINDS.includes(kind as ResearchKind)) {
      console.error(`kind must be one of ${RESEARCH_KINDS.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    const ctx = await createContext(dataDir());
    try {
      const { job, created } = await queueJob(ctx.store, { kind: kind as ResearchKind, target: targetParts.join(' ') || null, query: opts.query ?? null, template: opts.template ?? null, requestedBy: 'cli' });
      console.log(`${created ? 'queued' : 'already queued'} ${job.id} (${job.kind} ${job.target ?? job.query ?? ''})`);
      if (opts.now) {
        const done = await runResearchNow(ctx, job, (m) => console.log(`  ${m}`));
        console.log(JSON.stringify({ id: done.id, status: done.status, outputPath: done.outputPath, error: done.error, turns: done.turns, warnings: done.payload.warnings }, null, 2));
      }
    } finally {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });
research
  .command('init')
  .description('initialize the knowledge base: sync + extraction, then the agent writes wiki/overview.md and the AGENTS.md / CLAUDE.md guide and queues topic pages')
  .option('--now', 'run it right now in this process instead of waiting for serve')
  .action(async (opts: { now?: boolean }) => {
    const ctx = await createContext(dataDir());
    try {
      const { job, created } = await queueJob(ctx.store, { kind: 'init', requestedBy: 'cli' });
      console.log(`${created ? 'queued' : 'already queued'} ${job.id} (init)`);
      if (opts.now) {
        const done = await runResearchNow(ctx, job, (m) => console.log(`  ${m}`));
        console.log(JSON.stringify({ id: done.id, status: done.status, outputPath: done.outputPath, error: done.error, turns: done.turns, steps: done.payload.steps, topics: done.payload.topics, followUps: done.payload.followUps, warnings: done.payload.warnings }, null, 2));
      }
    } finally {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });
research
  .command('ask <query...>')
  .description('answer a question and file the answer as wiki/questions/<slug>.md')
  .option('--now', 'run it right now in this process')
  .action(async (parts: string[], opts: { now?: boolean }) => {
    const ctx = await createContext(dataDir());
    try {
      const { job, created } = await queueJob(ctx.store, { kind: 'question', query: parts.join(' '), requestedBy: 'cli' });
      console.log(`${created ? 'queued' : 'already queued'} ${job.id}`);
      if (opts.now) {
        const done = await runResearchNow(ctx, job, (m) => console.log(`  ${m}`));
        console.log(JSON.stringify({ id: done.id, status: done.status, outputPath: done.outputPath, error: done.error }, null, 2));
      }
    } finally {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });
research
  .command('run <id>')
  .description('run a queued / failed job now (hosts a temporary MCP endpoint for this data dir)')
  .action(async (id: string) => {
    const ctx = await createContext(dataDir());
    try {
      const job = (await retryJob(ctx.store, id)) ?? (await getJob(ctx.store, id));
      if (!job) throw new Error(`no job ${id}`);
      const done = await runResearchNow(ctx, job, (m) => console.log(`  ${m}`));
      console.log(JSON.stringify({ id: done.id, status: done.status, outputPath: done.outputPath, error: done.error, turns: done.turns, warnings: done.payload.warnings }, null, 2));
    } finally {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });
research
  .command('list')
  .option('--status <status>', 'queued | running | validating | done | failed | cancelled (comma-separated)')
  .action(async (opts: { status?: string }) => {
    const ctx = await createContext(dataDir());
    try {
      const jobs = await listJobs(ctx.store, { status: opts.status ? (opts.status.split(',') as ResearchStatus[]) : undefined });
      for (const j of jobs) console.log(`${j.id}  ${j.status.padEnd(10)} ${j.kind.padEnd(10)} ${(j.target ?? j.query ?? '').slice(0, 40).padEnd(40)} ${j.outputPath ?? ''}${j.error ? `  ✗ ${j.error.slice(0, 80)}` : ''}`);
      if (jobs.length === 0) console.log('(no research jobs)');
    } finally {
      await ctx.store.close();
    }
  });
research
  .command('show <id>')
  .option('--log', 'also print the tail of the agent transcript')
  .action(async (id: string, opts: { log?: boolean }) => {
    const ctx = await createContext(dataDir());
    try {
      const job = await getJob(ctx.store, id);
      if (!job) throw new Error(`no job ${id}`);
      console.log(JSON.stringify(job, null, 2));
      if (opts.log) {
        const file = path.join(runsRoot(ctx.dataDir, ctx.config.research?.runsDir ?? '.runs'), job.id, 'transcript.jsonl');
        if (fs.existsSync(file)) console.log(fs.readFileSync(file, 'utf8').split('\n').slice(-200).join('\n'));
        else console.log('(no transcript yet)');
      }
    } finally {
      await ctx.store.close();
    }
  });
/** A brief as a person reads it in a terminal. */
function printBrief(id: string, status: string, brief: StudyBrief, problem: string | null): void {
  console.log(`\n${brief.title}   (${id}, ${status}, ${brief.language})`);
  console.log(`\n${brief.objective}`);
  if (brief.restatement) console.log(`\n${brief.restatement}`);
  if (brief.scope.timeframe || brief.scope.include.length) console.log(`\nscope: ${[brief.scope.include.join('; '), brief.scope.timeframe].filter(Boolean).join(' · ')}${brief.scope.exclude.length ? `  (not: ${brief.scope.exclude.join('; ')})` : ''}`);
  for (const page of brief.pages) {
    console.log(`\n  ${page.id}  ${page.title}  → wiki/research/${brief.slug}/${page.slug}.md`);
    for (const qid of page.questions) {
      const q = brief.questions.find((x) => x.id === qid);
      if (q) console.log(`        ${q.id} ${q.text}`);
    }
  }
  if (brief.seedUrls.length) console.log(`\nseed URLs:\n${brief.seedUrls.map((u) => `  ${u.url}${u.why ? `  — ${u.why}` : ''}`).join('\n')}`);
  if (brief.clarifications.length) {
    console.log('\nclarifications (answer with `research study refine <id> --answer "<question>=<answer>"`):');
    for (const c of brief.clarifications) console.log(`  ? ${c.question}${c.options.length ? `  [${c.options.join(' | ')}]` : ''}${c.answer ? `  → ${c.answer}` : ''}`);
  }
  if (problem) console.log(`\ncannot start yet: ${problem}`);
}

/**
 * A whole study, here: collect, every page, the report — what `serve`'s queue
 * would do over its ticks, one job at a time, against a temporary MCP endpoint.
 */
async function runStudyNow(ctx: Awaited<ReturnType<typeof createContext>>, id: string, log: (m: string) => void): Promise<void> {
  await withTemporaryMcp(ctx, async (mcp) => {
    for (let round = 0; round < 50; round++) {
      await continueStudies(ctx, log);
      const study = await getJob(ctx.store, id);
      if (!study) throw new Error(`no study ${id}`);
      if (study.status === 'queued') {
        const [claimed] = await ctx.store.query<{ id: string }>(`UPDATE research_jobs SET status = 'running', started_at = now(), attempts = attempts + 1 WHERE id = $1 AND status = 'queued' RETURNING id`, [id]);
        if (claimed) await runResearchJob(ctx, (await getJob(ctx.store, id))!, { mcp, log });
        continue;
      }
      if (study.status !== 'waiting') return;
      const pages = await listJobs(ctx.store, { study: id, status: 'queued', limit: 100 });
      if (pages.length === 0) return;
      for (const page of pages) {
        const [claimed] = await ctx.store.query<{ id: string }>(`UPDATE research_jobs SET status = 'running', started_at = now(), attempts = attempts + 1 WHERE id = $1 AND status = 'queued' RETURNING id`, [page.id]);
        if (claimed) await runResearchJob(ctx, (await getJob(ctx.store, page.id))!, { mcp, log });
      }
    }
  });
}

const study = research.command('study').description('studies: a topic researched into several wiki pages — refine the question, collect sources into raw/docs/research, write the pages and a report');
study
  .command('new <topic...>')
  .description('create a study from a topic and refine it into a brief (pages, questions, seed sources); --start queues it')
  .option('--agent <spec>', 'agent that runs it: an agent name, connection id or claude-cli / codex-cli / cursor-cli (default research.agent)')
  .option('--model <model>', 'model for that agent')
  .option('--profile <name>', 'research profile for its pages (default research.profile)')
  .option('--no-web', 'do not search the web: the knowledge base and the selected sources only')
  .option('--sources <ids>', 'research sources to use (comma-separated; default: the enabled ones)')
  .option('--deep-research <connection:model>', 'collect with a deep-research model on an OpenAI-compatible connection, e.g. openai:o3-deep-research')
  .option('--language <tag>', 'output language (default: the topic\'s)')
  .option('--no-refine', 'skip the refiner: a template brief to edit')
  .option('--start', 'queue it right away')
  .option('--now', 'run the whole study in this process (implies --start)')
  .action(async (parts: string[], opts: { agent?: string; model?: string; profile?: string; web: boolean; sources?: string; deepResearch?: string; language?: string; refine: boolean; start?: boolean; now?: boolean }) => {
    const ctx = await createContext(dataDir());
    try {
      const runner: Partial<StudyRunner> = { agent: opts.agent ?? '', model: opts.model ?? '', profile: opts.profile ?? '' };
      if (opts.deepResearch) {
        const at = opts.deepResearch.indexOf(':');
        if (at < 1) throw new Error('--deep-research takes <connection>:<model>');
        Object.assign(runner, { mode: 'deep-research', deepResearch: { connection: opts.deepResearch.slice(0, at), model: opts.deepResearch.slice(at + 1) } });
      }
      console.log('refining…');
      let job = await createStudy(ctx, {
        topic: parts.join(' '), runner, requestedBy: 'cli', language: opts.language, refine: opts.refine,
        sources: { web: opts.web, ...(opts.sources ? { ids: opts.sources.split(',').map((x) => x.trim()).filter(Boolean) } : {}) },
      });
      const p = studyPayload(job);
      const last = p.refinements[p.refinements.length - 1];
      if (last?.error) console.log(`refiner (${last.refiner}): ${last.error}`);
      printBrief(job.id, job.status, p.brief, startProblem(ctx, job));
      if (opts.start || opts.now) {
        job = await startStudy(ctx, job.id);
        console.log(`\nstarted ${job.id}`);
        if (opts.now) await runStudyNow(ctx, job.id, (m) => console.log(`  ${m}`));
      }
    } finally {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });
study
  .command('refine <id> [feedback...]')
  .description('refine a draft: what to change, and answers to its clarifications')
  .option('--answer <q=a...>', 'answer a clarification ("<question>=<answer>"; repeatable)', (v: string, all: string[] = []) => [...all, v])
  .action(async (id: string, parts: string[], opts: { answer?: string[] }) => {
    const ctx = await createContext(dataDir());
    try {
      const answers = Object.fromEntries((opts.answer ?? []).map((a) => {
        const at = a.indexOf('=');
        return at > 0 ? [a.slice(0, at).trim(), a.slice(at + 1).trim()] : [a.trim(), ''];
      }));
      console.log('refining…');
      const job = await refineStudy(ctx, id, { feedback: parts.join(' '), answers });
      const p = studyPayload(job);
      const last = p.refinements[p.refinements.length - 1];
      if (last?.error) console.log(`refiner (${last.refiner}): ${last.error}`);
      printBrief(job.id, job.status, p.brief, startProblem(ctx, job));
    } finally {
      await ctx.store.close();
    }
  });
study
  .command('start <id>')
  .description('queue a draft study (serve runs it); --now runs it here')
  .option('--now', 'run the whole study in this process')
  .action(async (id: string, opts: { now?: boolean }) => {
    const ctx = await createContext(dataDir());
    try {
      const job = await startStudy(ctx, id);
      console.log(`started ${job.id}`);
      if (opts.now) await runStudyNow(ctx, job.id, (m) => console.log(`  ${m}`));
    } finally {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });
study
  .command('run <id>')
  .description('go on with a started study in this process: whatever stage it is at, until it is done')
  .action(async (id: string) => {
    const ctx = await createContext(dataDir());
    try {
      await runStudyNow(ctx, id, (m) => console.log(`  ${m}`));
      const job = await getJob(ctx.store, id);
      console.log(job ? `${job.id}: ${job.status} (${studyPayload(job).stage})${job.outputPath ? ` → ${job.outputPath}` : ''}` : `no study ${id}`);
    } finally {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });
study
  .command('show <id>')
  .option('--json', 'the whole view as JSON')
  .action(async (id: string, opts: { json?: boolean }) => {
    const ctx = await createContext(dataDir());
    try {
      const job = await getJob(ctx.store, id);
      if (!job || job.kind !== 'study') throw new Error(`no study ${id}`);
      const view = await studyView(ctx, job);
      if (opts.json) {
        console.log(JSON.stringify(view, null, 2));
        return;
      }
      printBrief(job.id, job.status, view.payload.brief, job.status === 'draft' ? startProblem(ctx, job) : null);
      console.log(`\nstages: ${view.payload.steps.map((st) => `${st.name}=${st.status}${st.detail ? ` (${st.detail})` : ''}`).join('  ')}`);
      console.log(`\npages:${view.pages.map((pg) => `\n  ${pg.status.padEnd(10)} ${pg.path}${pg.trust ? `  [${pg.trust}]` : ''}${pg.error ? `  ✗ ${pg.error.slice(0, 100)}` : ''}`).join('')}`);
      console.log(`report: ${view.reportPath}${view.reportExists ? '' : ' (not yet)'}`);
      console.log(`sources: ${view.captures.length} captured — ${view.registerPath}`);
    } finally {
      await ctx.store.close();
    }
  });
study
  .command('list')
  .action(async () => {
    const ctx = await createContext(dataDir());
    try {
      const jobs = await listStudies(ctx, 50);
      for (const j of jobs) {
        const p = studyPayload(j);
        console.log(`${j.id}  ${j.status.padEnd(10)} ${p.stage.padEnd(8)} ${p.brief.title.slice(0, 70)}`);
      }
      if (jobs.length === 0) console.log('(no studies)');
    } finally {
      await ctx.store.close();
    }
  });
study
  .command('cancel <id>')
  .description('cancel a study and the pages it has not finished')
  .action(async (id: string) => {
    const ctx = await createContext(dataDir());
    try {
      console.log(JSON.stringify(await cancelStudy(ctx, id)));
    } finally {
      await ctx.store.close();
    }
  });
research
  .command('capture <url>')
  .description('save a web page or file (HTML, PDF, CSV / JSON, image) into raw/docs/research — fetched, converted and indexed like any document')
  .option('--study <id>', 'file it under a study')
  .option('--why <text>', 'what it is for')
  .action(async (url: string, opts: { study?: string; why?: string }) => {
    const ctx = await createContext(dataDir());
    try {
      let ref: { id: string; slug: string; title?: string } | null = null;
      if (opts.study) {
        const job = await getJob(ctx.store, opts.study);
        if (!job || job.kind !== 'study') throw new Error(`no study ${opts.study}`);
        ref = { id: job.id, slug: job.target ?? job.id, title: studyPayload(job).brief.title };
      }
      const r = await captureUrl(ctx, { url, study: ref, why: opts.why, actor: process.env.USER || 'cli', index: 'wait' });
      console.log(JSON.stringify({ path: r.path, title: r.title, kind: r.kind, published: r.published, reused: r.reused, bytes: r.bytes, chars: r.chars, warnings: r.warnings, outline: r.outline.slice(0, 15) }, null, 2));
    } finally {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });
research
  .command('sources')
  .description('the research sources under playbooks/research/sources (MCP servers, APIs, sites, datasources)')
  .action(async () => {
    const dir = dataDir();
    const config = loadConfig(dir);
    const sources = loadResearchSources(dir);
    for (const s of sources) {
      const problem = sourceProblem(s, config);
      console.log(`${s.enabled ? '●' : '○'} ${s.id.padEnd(20)} ${s.kind.padEnd(10)} ${s.title}${problem ? `  ✗ ${problem}` : ''}`);
    }
    if (sources.length === 0) console.log(`(no research sources — add YAML files under playbooks/research/sources/, or in the web UI: Research → Sources)`);
  });
research
  .command('cancel <id>')
  .action(async (id: string) => {
    const ctx = await createContext(dataDir());
    try {
      const cancelled = await cancelJob(ctx.store, id);
      if (cancelled) killAgentsFor(id);
      console.log(cancelled ? 'cancelled' : 'not cancellable');
    } finally {
      await ctx.store.close();
    }
  });
research
  .command('retry <id>')
  .action(async (id: string) => {
    const ctx = await createContext(dataDir());
    try {
      console.log((await retryJob(ctx.store, id)) ? 'queued again' : 'not retryable');
    } finally {
      await ctx.store.close();
    }
  });
research
  .command('recommend')
  .description('rank the pages worth researching next (hot / demanded entities without pages, stale research pages, recurring questions)')
  .option('--file', 'also file them as wiki suggestions (what the nightly pass does)')
  .action(async (opts: { file?: boolean }) => {
    const ctx = await createContext(dataDir());
    try {
      const recs = opts.file ? (await refreshRecommendations(ctx)).recommendations : await recommendWikiTopics(ctx);
      for (const r of recs) console.log(`${r.score.toFixed(2)}  ${r.kind.padEnd(9)} ${r.target}  — ${r.reasons.join('; ')}${r.suggestionId ? `  [suggestion ${r.suggestionId}]` : ''}`);
      if (recs.length === 0) console.log('(nothing to recommend yet)');
    } finally {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });
research
  .command('templates')
  .description('list the page templates under playbooks/research')
  .action(async () => {
    const dir = dataDir();
    initDataDir(dir);
    for (const t of loadResearchTemplates(dir).values()) console.log(`${t.name.padEnd(12)} kind=${t.kind.padEnd(11)} output=${t.output || '(target path)'}  sections=${t.requires.sections.length}  ${t.path}`);
  });
research
  .command('profiles')
  .description('list research profiles under playbooks/research/profiles (* = active, research.profile)')
  .action(async () => {
    const dir = dataDir();
    initDataDir(dir);
    const config = loadConfig(dir);
    const active = config.research?.profile || 'default';
    for (const p of loadProfiles(dir).values()) {
      const roles = p.roles.filter((r) => r.enabled).map((r) => r.id).join(',') || '(none)';
      console.log(`${p.name === active ? '*' : ' '} ${p.name.padEnd(12)} pipeline=${(p.pipeline || config.research.pipeline).padEnd(7)} effort=${p.reasoning.effort.padEnd(8)} web=${p.search.web.padEnd(8)} roles=${roles}  ${p.title}`);
    }
  });
research
  .command('profile <name>')
  .description('show a research profile as YAML; --use makes it the active one')
  .option('--use', 'set research.profile to this profile')
  .action(async (name: string, opts: { use?: boolean }) => {
    const dir = dataDir();
    initDataDir(dir);
    const profile = loadProfile(dir, name);
    if (!profile) {
      console.error(`no profile "${name}" — see \`knode-os research profiles\``);
      process.exitCode = 1;
      return;
    }
    if (opts.use) {
      const config = loadConfig(dir);
      config.research.profile = name;
      saveConfig(dir, config);
      console.log(`research.profile = ${name}`);
    }
    process.stdout.write(`# ${profile.path}\n${profileYaml(profile)}`);
  });
research
  .command('export <id>')
  .description('write the run workspace (brief, schema, MCP config) somewhere you can run the agent by hand; finish with `research reclaim <id>`')
  .requiredOption('--dir <path>', 'directory to write the workspace into')
  .option('--url <mcpUrl>', 'MCP endpoint of a running serve (default: from server config)')
  .option('--user <user>', 'workspace owner the agent acts as', 'admin')
  .option('--workspace <id>', 'workspace id under users/<user>/workspaces', 'default')
  .action(async (id: string, opts: { dir: string; url?: string; user: string; workspace: string }) => {
    const ctx = await createContext(dataDir());
    try {
      const job = await getJob(ctx.store, id);
      if (!job) throw new Error(`no job ${id}`);
      const { loadOrCreateMcpToken } = await import('./server/mcp-http.js');
      const { templateFor } = await import('./research/templates.js');
      const agent = resolveResearchAgent(ctx.config, ctx.dataDir) ?? { kind: 'cli' as const, provider: 'claude-cli' as const, cliPath: '', model: ctx.config.research?.model ?? '' };
      const token = loadOrCreateMcpToken(ctx.dataDir);
      const url = opts.url ?? `http://${ctx.config.server.host}:${ctx.config.server.port}${ctx.config.server.mcp?.path || '/mcp'}`;
      const mcp = { url, token, headers: { 'x-knode-user': opts.user, 'x-knode-workspace-kind': 'personal', 'x-knode-workspace-id': opts.workspace, 'x-knode-workspace-name': opts.workspace } };
      const dir = path.resolve(opts.dir);
      const template = templateFor(ctx.dataDir, job.kind, job.template);
      const readDirs = (ctx.config.research?.readDirs ?? ['raw/docs', 'wiki', '.sidecar']).map((d) => path.join(ctx.dataDir, d)).filter((d) => fs.existsSync(d));
      const ws = await prepareRunWorkspace(ctx, job, template, { runsDir: ctx.config.research?.runsDir ?? '.runs', provider: agent.provider, mcp, readDirs, dir });
      await (await import('./research/jobs.js')).updateJob(ctx.store, job.id, { worksetId: ws.worksetId, outputPath: ws.outputPath, payload: { ...job.payload, actor: ws.actor, research: ws.research, humanParagraphs: ws.humanParagraphs, exportedTo: dir } });
      const lines = [`# How to run research job ${job.id} by hand`, '', `Workspace: ${dir}`, `Output page: ${ws.outputPath} (write it with knode_write through the MCP server \`knode-os\` at ${url})`, ''];
      for (const provider of ['claude-cli', 'codex-cli', 'cursor-cli'] as const) {
        const { cmd, args } = launchArgs({ agent: { kind: 'cli', provider, cliPath: '', model: agent.model }, maxTurns: template.maxTurns ?? ctx.config.research?.maxTurns ?? 40, timeoutMs: 0, ws, mcp, readDirs, jobId: job.id });
        const shown = provider === 'cursor-cli' ? [...args.slice(0, -1), '"$(cat brief.md)"'] : args;
        lines.push(`## ${provider}`, '', '```bash', `cd ${JSON.stringify(dir)}`, provider === 'cursor-cli' ? '' : 'export KNODE_MCP_TOKEN=' + token, `${cmd} ${shown.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ')}${provider === 'cursor-cli' ? '' : ' < brief.md'}`, '```', '');
      }
      lines.push('When the agent has finished, validate and index the page:', '', '```bash', `knode-os research reclaim ${job.id}`, '```', '');
      fs.writeFileSync(path.join(dir, 'RUN.md'), lines.join('\n'));
      console.log(`exported to ${dir} — see RUN.md`);
    } finally {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });
research
  .command('reclaim <id>')
  .description('validate and index the page an exported (hand-run) job wrote')
  .action(async (id: string) => {
    const ctx = await createContext(dataDir());
    try {
      const job = await getJob(ctx.store, id);
      if (!job) throw new Error(`no job ${id}`);
      const agent = resolveResearchAgent(ctx.config, ctx.dataDir) ?? { kind: 'cli' as const, provider: 'claude-cli' as const, cliPath: '', model: '' };
      const ws = workspaceFromJob(ctx, job, agent);
      if (typeof job.payload.exportedTo === 'string') ws.dir = job.payload.exportedTo;
      const done = await finalizeResearchJob(ctx, job, ws, { exitCode: 0, turns: null, costUsd: null, resultText: '', error: null, transcriptPath: '' }, { mcp: { url: '', token: '', headers: {} }, agent, log: (m) => console.log(`  ${m}`) });
      console.log(JSON.stringify({ id: done.id, status: done.status, outputPath: done.outputPath, error: done.error, warnings: done.payload.warnings }, null, 2));
    } finally {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });

const chat = program.command('chat').description('talk to the configured coding-agent CLI about the knowledge base (it answers over MCP and may write what it is taught as quarantined notes)');
chat
  .command('send <message...>', { isDefault: true })
  .description('send one message (a new conversation unless --conversation) and print the reply; hosts a temporary MCP endpoint')
  .option('-c, --conversation <id>', 'continue an existing conversation')
  .option('--json', 'print the assistant message as JSON')
  .action(async (parts: string[], opts: { conversation?: string; json?: boolean }) => {
    const ctx = await createContext(dataDir());
    try {
      const text = parts.join(' ');
      const conversation = opts.conversation ? await getConversation(ctx.store, opts.conversation) : await createConversation(ctx.store, { createdBy: 'cli' });
      if (!conversation) throw new Error(`no conversation ${opts.conversation}`);
      const res = await withTemporaryMcp(ctx, (mcp) => runChatTurn(ctx, conversation.id, text, { mcp, log: (m) => console.error(`  ${m}`) }));
      if (opts.json) {
        console.log(JSON.stringify({ conversation: conversation.id, ...res.message }, null, 2));
      } else {
        console.log(res.message.content || (res.message.error ? `(no reply: ${res.message.error})` : '(empty reply)'));
        const tools = res.message.events.filter((e) => e.tool !== 'wrote');
        if (tools.length) console.error(`\n[${tools.map((e) => `${e.tool}${e.summary ? `: ${e.summary}` : ''}`).join(' · ')}]`);
        console.error(`conversation ${conversation.id} — continue with: knode-os chat -c ${conversation.id} "…"`);
      }
    } finally {
      await ctx.datasources.closeAll();
      await ctx.store.close();
    }
  });
chat
  .command('list')
  .description('recent conversations')
  .action(async () => {
    const ctx = await createContext(dataDir());
    try {
      const rows = await listConversations(ctx.store, { limit: 50 });
      for (const r of rows) console.log(`${r.id}  ${r.status.padEnd(8)} ${r.updatedAt.slice(0, 16)}  ${r.title || '(untitled)'}`);
      if (rows.length === 0) console.log('(no conversations)');
    } finally {
      await ctx.store.close();
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

program
  .command('plugins')
  .description('load the plugins this data directory names and list what they — and the built-ins — provide: LLM and embedding providers, storage backends, converters, hooks')
  .option('--json', 'machine-readable output')
  .action(async (opts) => {
    const dir = dataDir();
    initDataDir(dir);
    const config = loadConfig(dir);
    const specs = configuredPluginSpecs(config.plugins);
    await loadPlugins(dir, config.plugins, { log: opts.json ? undefined : (m) => console.log(`  ${m}`) });
    const registry = pluginRegistry();
    if (opts.json) {
      console.log(JSON.stringify({ configured: specs, plugins: registry.describe(), warnings: registry.warnings }, null, 2));
      return;
    }
    console.log(specs.length ? `configured: ${specs.map((s) => s.module).join(', ')}` : 'configured: none (add "plugins": [{ "module": "./plugins/x.mjs" }] to knode.config.json, or set KNODE_PLUGINS)');
    for (const p of registry.describe()) {
      const parts = [
        p.llmProviders.length ? `llm: ${p.llmProviders.join(', ')}` : '',
        p.embeddingProviders.length ? `embedding: ${p.embeddingProviders.join(', ')}` : '',
        p.storageBackends.length ? `storage: ${p.storageBackends.join(', ')}` : '',
        p.converters.length ? `converters: ${p.converters.join(', ')}` : '',
        p.hooks.length ? `hooks: ${p.hooks.join(', ')}` : '',
      ].filter(Boolean);
      console.log(`\n${p.name}${p.version ? ` ${p.version}` : ''}  (${p.source})${p.description ? `\n  ${p.description}` : ''}`);
      for (const line of parts) console.log(`  ${line}`);
    }
    for (const warning of registry.warnings) console.log(`\nnote: ${warning}`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
