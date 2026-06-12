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
import { graphInsights, graphSearch } from './graph/query.js';
import { runIngest } from './ingest/pipeline.js';
import { startMcpServer } from './mcp/server.js';
import { ask } from './search/ask.js';
import { search, SearchMode } from './search/search.js';
import { startServer } from './server/serve.js';
import { syncTraces } from './traces/sync.js';
import { runDream } from './dream/dream.js';
import { generateWiki } from './wiki/generate.js';

const program = new Command();
program
  .name('knode-os')
  .description('Local-first knowledge OS for coding agents — wiki + knowledge graph + vector recall over your docs, traces and skills')
  .version('0.1.0')
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

program
  .command('ingest')
  .description('scan raw/docs, raw/skills and wiki; chunk + embed changed files; rewire the knowledge graph')
  .option('--no-llm', 'skip the LLM entity-extraction pass')
  .action(async (opts) => {
    const ctx = await createContext(dataDir());
    const stats = await runIngest(ctx.store, ctx.config, ctx.embedder, ctx.llm, {
      llmGraph: opts.llm,
      onProgress: (m) => console.log(`  ${m}`),
    });
    console.log(JSON.stringify(stats, null, 2));
    await ctx.store.close();
  });

program
  .command('search <query>')
  .description('hybrid search (vector + keyword + graph) over the knowledge base')
  .option('-k <n>', 'number of results', '8')
  .option('-m, --mode <mode>', 'hybrid | vector | keyword', 'hybrid')
  .option('--json', 'raw JSON output')
  .action(async (query, opts) => {
    const ctx = await createContext(dataDir());
    const results = await search(ctx.store, ctx.embedder, query, { k: Number(opts.k), mode: opts.mode as SearchMode });
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
  .action(async (question) => {
    const ctx = await createContext(dataDir());
    const res = await ask(ctx.store, ctx.config, ctx.embedder, ctx.llm, question);
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
  .description('search the knowledge graph (or --insights for graph health)')
  .option('--depth <n>', 'expansion hops', '2')
  .option('--insights', 'show hubs / isolated entities / type distribution')
  .option('--json', 'raw JSON output')
  .action(async (query, opts) => {
    const ctx = await createContext(dataDir());
    if (opts.insights || !query) {
      console.log(JSON.stringify(await graphInsights(ctx.store), null, 2));
    } else {
      const res = await graphSearch(ctx.store, query, { depth: Number(opts.depth) });
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

const wiki = program.command('wiki').description('wiki maintenance');
wiki
  .command('generate')
  .description('generate source summary pages + entity stubs from indexed docs (uses LLM when configured)')
  .action(async () => {
    const ctx = await createContext(dataDir());
    const created = await generateWiki(ctx.store, ctx.llm, { onProgress: (m) => console.log(`  ${m}`) });
    console.log(created.length ? `created:\n  ${created.join('\n  ')}` : 'nothing to generate');
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
    await syncTraces(ctx.store, ctx.config);
    const res = await runDream(ctx.store, ctx.config, ctx.llm, {
      lookbackDays: opts.lookback ? Number(opts.lookback) : undefined,
      onProgress: (m) => console.log(`  ${m}`),
    });
    console.log(`\nreport: ${res.reportPath}`);
    for (const s of res.suggestions) console.log(`  [${s.kind}] ${s.title}`);
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
