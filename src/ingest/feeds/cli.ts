import fs from 'node:fs';
import type { Command } from 'commander';
import type { KnodeClient } from '../../client/client.js';
import { parseYaml } from '../../compiler/intents.js';
import { createContext } from '../../context.js';
import { isValidFeedId, loadFeed, normalizeFeed, redactFeed, saveFeed } from './definitions.js';
import { checkFeed, deleteFeed, feedConnectorCatalog, FeedItemView, feedItems } from './manage.js';
import { FeedRunResult, previewFeed, pushToFeed, runFeed } from './run.js';
import { describeFeeds, FeedStatus } from './runner.js';
import type { FeedDefinition } from './types.js';

/**
 * `knode-os feeds …` (docs/design/25 §7). Each command talks to the server a
 * signed-in CLI points at, or works on a data directory here (--data) — the
 * same split as `conversations`.
 */

interface Deps {
  dataDir: () => string;
  server: () => KnodeClient | null;
}

async function withContext<T>(dataDir: string, fn: (ctx: Awaited<ReturnType<typeof createContext>>) => Promise<T>): Promise<T> {
  const ctx = await createContext(dataDir);
  try {
    return await fn(ctx);
  } finally {
    await ctx.datasources.closeAll();
    await ctx.store.close();
  }
}

/** An instant in this machine's local time, to the minute. */
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('sv-SE', { hour12: false }).slice(0, 16) : '—');

/** `k=v` pairs → params; a value that parses as JSON (numbers, arrays, objects, true) is taken as such. */
export function parseParams(pairs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at <= 0) throw new Error(`--param ${pair}: write name=value`);
    const key = pair.slice(0, at).trim();
    const raw = pair.slice(at + 1);
    let value: unknown = raw;
    if (/^[[{]|^(true|false|null|-?\d+(\.\d+)?)$/.test(raw.trim())) {
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
    }
    out[key] = value;
  }
  return out;
}

function readItems(file: string | undefined): unknown[] {
  const text = !file || file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) return JSON.parse(trimmed) as unknown[];
  if (trimmed.startsWith('{') && !trimmed.includes('\n{')) {
    const body = JSON.parse(trimmed) as { items?: unknown[] };
    return Array.isArray(body.items) ? body.items : [body];
  }
  return trimmed.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function printRun(r: FeedRunResult, preview = false): void {
  if (r.error) console.log(`pull failed: ${r.error}`);
  for (const n of r.notes) console.log(`  ${n}`);
  console.log(`${r.pulled} pulled${r.pushed ? `, ${r.pushed} pushed` : ''}: ${r.changed} new or changed, ${r.unchanged} already kept`);
  for (const d of r.decisions) console.log(`  ${d.status.padEnd(7)} ${d.title.slice(0, 70).padEnd(70)}  by ${d.by}${d.score !== undefined ? ` (${d.score.toFixed(2)})` : ''}${d.reason ? ` — ${d.reason}` : ''}`);
  if (r.decided) console.log(`${r.decided} decided: ${r.kept} kept, ${r.dropped} dropped, ${r.pending} pending`);
  for (const doc of r.documents) {
    if (preview && doc.content !== undefined) {
      console.log(`\n───── ${doc.path} (${doc.units} unit(s)) ─────`);
      console.log(doc.content.length > 4000 ? `${doc.content.slice(0, 4000)}\n… ${doc.content.length - 4000} more characters` : doc.content);
    } else {
      console.log(`  ${doc.written ? 'wrote ' : 'same  '} ${doc.path} (${doc.units} unit(s))`);
    }
  }
  for (const p of r.removed) console.log(`  removed ${p}`);
  if (r.more) console.log('more is waiting at the source: the next run continues');
  if (r.sync) console.log(`indexed: ${r.sync.indexed} applied, ${r.sync.unchanged} unchanged, ${r.sync.errors} errors`);
}

export function registerFeedCommands(program: Command, deps: Deps): void {
  const feeds = program.command('feeds').description('sources that keep producing items — chats, mail, accounts, arXiv, GitHub, RSS — pulled, filtered, transformed and written as documents (docs/design/25)');

  feeds
    .command('list')
    .description('the feeds of this workspace and how their runs went')
    .option('--json', 'raw JSON output')
    .action(async (opts: { json?: boolean }) => {
      const srv = deps.server();
      const list: FeedStatus[] = srv ? (await srv.get<{ feeds: FeedStatus[] }>('/api/feeds')).feeds : describeFeeds(deps.dataDir());
      if (opts.json) return console.log(JSON.stringify(list, null, 2));
      if (!list.length) return console.log('no feeds — `knode-os feeds connectors` lists the kinds, `knode-os feeds add` makes one');
      for (const f of list) {
        const sched = f.schedule.every ? `every ${f.schedule.every}` : f.schedule.at?.length ? `at ${f.schedule.at.join(', ')}` : 'manual';
        const st = f.state;
        console.log(`${f.id.padEnd(20)} ${f.connector.padEnd(12)} ${f.enabled ? sched.padEnd(14) : 'disabled'.padEnd(14)} ${String(f.items).padStart(6)} items  last ${when(st.lastRunAt)}  next ${when(f.nextRunAt)}  → ${f.dest}${f.running ? '  [running]' : ''}${st.lastError ? `\n${''.padEnd(21)}error: ${st.lastError}` : ''}${f.problem ? `\n${''.padEnd(21)}problem: ${f.problem}` : ''}`);
      }
    });

  feeds
    .command('connectors')
    .description('the kinds of source this server can follow, with their parameters, and the user-defined stages plugins registered')
    .option('--json', 'raw JSON output')
    .action(async (opts: { json?: boolean }) => {
      const srv = deps.server();
      const cat = srv ? await srv.get<ReturnType<typeof feedConnectorCatalog>>('/api/feeds/connectors') : feedConnectorCatalog();
      if (opts.json) return console.log(JSON.stringify(cat, null, 2));
      for (const c of cat.connectors) {
        console.log(`${c.id} — ${c.label}${c.plugin !== 'builtin' ? `  (plugin ${c.plugin})` : ''}\n  ${c.note}`);
        for (const p of c.params) console.log(`    ${p.name}${p.required ? '*' : ''}: ${p.label}${p.example !== undefined ? `  e.g. ${JSON.stringify(p.example)}` : ''}`);
      }
      if (cat.stages.length) {
        console.log('\nuser-defined stages:');
        for (const s of cat.stages) console.log(`  ${s.id} (${s.kind}) — ${s.label}  from ${s.plugin}`);
      }
    });

  feeds
    .command('show <id>')
    .description('a feed\'s definition (secrets masked) and state')
    .action(async (id: string) => {
      const srv = deps.server();
      const out = srv
        ? await srv.get<{ feed: FeedDefinition; status: FeedStatus | null }>(`/api/feeds/${encodeURIComponent(id)}`)
        : (() => {
          const feed = loadFeed(deps.dataDir(), id);
          if (!feed) throw new Error(`no feed "${id}"`);
          return { feed: redactFeed(feed), status: describeFeeds(deps.dataDir()).find((f) => f.id === id) ?? null };
        })();
      console.log(JSON.stringify(out, null, 2));
    });

  feeds
    .command('add <id>')
    .description('create or replace a feed: from a YAML file (--file), or a connector and its params; check, then preview it before it runs on its schedule')
    .option('--file <path>', 'the definition as YAML (the file under playbooks/feeds/ takes the same form)')
    .option('--connector <id>', 'rss, arxiv, github, feishu-chat, email, x, opencli, web, push, command, or a plugin\'s')
    .option('--title <title>')
    .option('-p, --param <name=value...>', 'a connector parameter (repeatable); JSON values allowed', (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option('--every <duration>', 'pull every so often: 15m, 2h, 1d')
    .option('--at <times>', 'pull at these local times, comma-separated HH:MM')
    .option('--manual', 'only pushes and runs by hand')
    .option('--dest <folder>', 'folder under raw/docs it writes in (default raw/docs/feeds/<id>)')
    .option('--period <period>', 'item, day, week or month: what one document holds')
    .option('--disabled', 'create it switched off')
    .action(async (id: string, opts: { file?: string; connector?: string; title?: string; param: string[]; every?: string; at?: string; manual?: boolean; dest?: string; period?: string; disabled?: boolean }) => {
      if (!isValidFeedId(id)) throw new Error('a feed id is lower-case letters, digits, - and _');
      const body: Record<string, unknown> = opts.file ? parseYaml(fs.readFileSync(opts.file, 'utf8')) : {};
      if (opts.connector) body.connector = opts.connector;
      if (opts.title) body.title = opts.title;
      if (opts.param.length) body.params = { ...((body.params as Record<string, unknown>) ?? {}), ...parseParams(opts.param) };
      if (opts.manual) body.schedule = 'manual';
      else if (opts.every || opts.at) body.schedule = { ...(opts.every ? { every: opts.every } : {}), ...(opts.at ? { at: opts.at.split(',').map((t) => t.trim()) } : {}) };
      if (opts.dest || opts.period) body.render = { ...((body.render as Record<string, unknown>) ?? {}), ...(opts.dest ? { dest: opts.dest } : {}), ...(opts.period ? { period: opts.period } : {}) };
      if (opts.disabled) body.enabled = false;
      if (!body.connector) throw new Error('name a connector (--connector) or a file that does (--file)');
      const srv = deps.server();
      const feed = srv ? (await srv.put<{ feed: FeedDefinition }>(`/api/feeds/${encodeURIComponent(id)}`, body)).feed : redactFeed(saveFeed(deps.dataDir(), id, body));
      console.log(`feed ${feed.id} saved (${feed.connector}${feed.enabled ? '' : ', disabled'}) — try it with \`knode-os feeds preview ${feed.id}\``);
    });

  feeds
    .command('check <id>')
    .description('can the feed reach its source with its params?')
    .action(async (id: string) => {
      const srv = deps.server();
      const out = srv
        ? await srv.post<{ ok: boolean; message: string }>('/api/feeds/check', { id })
        : await withContext(deps.dataDir(), async (ctx) => {
          const feed = loadFeed(ctx.dataDir, id);
          if (!feed) throw new Error(`no feed "${id}"`);
          return checkFeed(ctx, feed);
        });
      console.log(`${out.ok ? 'ok' : 'cannot'}: ${out.message}`);
      if (!out.ok) process.exitCode = 1;
    });

  feeds
    .command('preview <id>')
    .description('pull and decide without keeping or writing anything, and print the documents a run would write (model and command stages do run)')
    .option('--file <path>', 'preview this definition (YAML) instead of the stored one')
    .option('--items <file>', 'decide these items (JSON array, {items}, or NDJSON; - for stdin) instead of pulling')
    .action(async (id: string, opts: { file?: string; items?: string }) => {
      const def = opts.file ? parseYaml(fs.readFileSync(opts.file, 'utf8')) : undefined;
      const items = opts.items ? readItems(opts.items) : undefined;
      const srv = deps.server();
      const r = srv
        ? await srv.post<FeedRunResult>('/api/feeds/preview', { id, feed: def, items, pull: items ? false : undefined })
        : await withContext(deps.dataDir(), async (ctx) => {
          const feed = def ? normalizeFeed(def, id) : loadFeed(ctx.dataDir, id);
          if (!feed) throw new Error(`no feed "${id}"`);
          return previewFeed(ctx, feed, { items, pull: items ? false : undefined, onProgress: (m) => console.error(`  ${m}`) });
        });
      printRun(r, true);
    });

  feeds
    .command('run <id>')
    .description('pull now, decide what is new and write it')
    .action(async (id: string) => {
      const srv = deps.server();
      const r = srv
        ? (await srv.post<{ result: FeedRunResult }>(`/api/feeds/${encodeURIComponent(id)}/run`, { wait: true })).result
        : await withContext(deps.dataDir(), async (ctx) => {
          const feed = loadFeed(ctx.dataDir, id);
          if (!feed) throw new Error(`no feed "${id}"`);
          return runFeed(ctx, feed, { onProgress: (m) => console.error(`  ${m}`) });
        });
      printRun(r);
      if (r.error) process.exitCode = 1;
    });

  feeds
    .command('push <id> [file]')
    .description('push items into a feed: a JSON array, { "items": [...] }, or NDJSON, from a file or stdin')
    .action(async (id: string, file: string | undefined) => {
      const items = readItems(file);
      if (!items.length) throw new Error('no items read');
      const srv = deps.server();
      const r = srv
        ? (await srv.post<{ result: FeedRunResult }>(`/api/feeds/${encodeURIComponent(id)}/items`, { items })).result
        : await withContext(deps.dataDir(), async (ctx) => {
          const feed = loadFeed(ctx.dataDir, id);
          if (!feed) throw new Error(`no feed "${id}"`);
          return pushToFeed(ctx, feed, items, { onProgress: (m) => console.error(`  ${m}`) });
        });
      printRun(r);
    });

  feeds
    .command('items <id>')
    .description('what the feed kept, dropped or is waiting on, newest first, and why')
    .option('--status <status>', 'keep, drop or pending')
    .option('--limit <n>', 'at most this many', '30')
    .option('--json', 'raw JSON output')
    .action(async (id: string, opts: { status?: string; limit: string; json?: boolean }) => {
      const srv = deps.server();
      const status = opts.status === 'keep' || opts.status === 'drop' || opts.status === 'pending' ? opts.status : undefined;
      const list: FeedItemView[] = srv
        ? (await srv.get<{ items: FeedItemView[] }>(`/api/feeds/${encodeURIComponent(id)}/items`, { status, limit: opts.limit })).items
        : (() => {
          const feed = loadFeed(deps.dataDir(), id);
          if (!feed) throw new Error(`no feed "${id}"`);
          return feedItems(deps.dataDir(), feed, { status, limit: Number(opts.limit) || 30 });
        })();
      if (opts.json) return console.log(JSON.stringify(list, null, 2));
      for (const i of list) console.log(`${i.status.padEnd(7)} ${when(i.publishedAt)}  ${(i.title || i.excerpt).slice(0, 70)}\n        by ${i.by}${i.reason ? ` — ${i.reason}` : ''}${i.url ? `\n        ${i.url}` : ''}`);
    });

  feeds
    .command('rerender <id>')
    .description('write the feed\'s documents again from its ledger (after changing a template or the render settings); --redecide asks the filter and transform stages again, which may cost model calls')
    .option('--redecide', 'decide every unit again')
    .action(async (id: string, opts: { redecide?: boolean }) => {
      const srv = deps.server();
      const r = srv
        ? (await srv.post<{ result: FeedRunResult }>(`/api/feeds/${encodeURIComponent(id)}/rerender`, { redecide: Boolean(opts.redecide) })).result
        : await withContext(deps.dataDir(), async (ctx) => {
          const feed = loadFeed(ctx.dataDir, id);
          if (!feed) throw new Error(`no feed "${id}"`);
          return runFeed(ctx, feed, { pull: false, all: true, redecide: Boolean(opts.redecide), onProgress: (m) => console.error(`  ${m}`) });
        });
      printRun(r);
    });

  feeds
    .command('remove <id>')
    .description('delete a feed\'s definition; its documents and ledger stay unless asked')
    .option('--remove-files', 'also delete the documents it wrote and dispose their knowledge')
    .option('--forget', 'also delete its ledger (items, decisions, cursor)')
    .action(async (id: string, opts: { removeFiles?: boolean; forget?: boolean }) => {
      const srv = deps.server();
      const r = srv
        ? await srv.delete<{ removedFiles: string | null; forgotLedger: boolean }>(`/api/feeds/${encodeURIComponent(id)}`, { removeFiles: opts.removeFiles ? '1' : undefined, forget: opts.forget ? '1' : undefined })
        : await withContext(deps.dataDir(), (ctx) => deleteFeed(ctx, id, { removeFiles: opts.removeFiles, forgetLedger: opts.forget, onProgress: (m) => console.error(`  ${m}`) }));
      console.log(`removed feed ${id}${r.removedFiles ? `, its documents under ${r.removedFiles}` : ''}${r.forgotLedger ? ' and its ledger' : ''}`);
    });
}
