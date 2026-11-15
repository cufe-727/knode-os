import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { MAX_FILE_BYTES, MAX_PREVIEW_BYTES } from '../constants.js';
import { GrepAnswer, grepAnswer, GrepMatch, grepSearch, isPrivatePath, listTree, TreeNode } from '../fs/files.js';
import { TREE_HIDDEN } from '../fs/layout.js';
import { readSourceTextCapped } from '../ingest/source.js';
import { originalType } from '../server/originals.js';
import { KnodeClient, ServerError } from './client.js';

/**
 * A filesystem view of a workspace: `ls`, `tree`, `read`, `stat` and `grep`
 * read a data directory here, or the server `knode-os login` made current;
 * `get`, `put`, `write`, `mkdir`, `mv` and `rm` reach a server's workspace
 * from another machine (here, the files are on disk already). Paths are the
 * workspace's own — raw/docs/…, wiki/… — exactly what search results cite.
 *
 * The server holds these to the same rules as the web UI: writes only under
 * wiki/ and raw/docs/, nothing private, nothing for a read-only account.
 */

interface FileDeps {
  /** The current server, or null for this machine. */
  server: () => KnodeClient | null;
  dataDir: () => string;
}

/** The file API's view of a file: its text, or the Markdown derived from a PDF or picture. */
interface FileText {
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
  derived: boolean;
}

const clean = (p = '.') => {
  const rel = p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return rel || '.';
};

export function humanBytes(n: number | undefined): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

const day = (iso?: string) => (iso ? iso.slice(0, 16).replace('T', ' ') : '');

/** Every node under a tree, depth first, the root left out. */
function flatten(node: TreeNode): TreeNode[] {
  return (node.children ?? []).flatMap((child) => [child, ...flatten(child)]);
}

export function formatTree(root: TreeNode): string {
  const lines = [root.path || '.'];
  const walk = (node: TreeNode, prefix: string) => {
    const kids = node.children ?? [];
    kids.forEach((child, i) => {
      const last = i === kids.length - 1;
      lines.push(`${prefix}${last ? '└── ' : '├── '}${child.name}${child.kind === 'dir' ? '/' : ''}`);
      if (child.kind === 'dir') walk(child, `${prefix}${last ? '    ' : '│   '}`);
    });
  };
  walk(root, '');
  return lines.join('\n');
}

export function formatListing(nodes: TreeNode[]): string {
  if (nodes.length === 0) return '(empty)';
  const width = Math.min(72, Math.max(...nodes.map((n) => n.path.length + (n.kind === 'dir' ? 1 : 0))));
  return nodes.map((n) => {
    const name = `${n.path}${n.kind === 'dir' ? '/' : ''}`.padEnd(width);
    const about = (n as TreeNode & { about?: string; linked?: string }).about;
    const linked = (n as TreeNode & { linked?: string }).linked;
    if (n.kind === 'dir') return `${name}  ${[about, linked ? `mirrors ${linked}` : ''].filter(Boolean).join(' · ')}`.trimEnd();
    return `${name}  ${humanBytes(n.bytes).padStart(8)}  ${day(n.mtime)}`;
  }).join('\n');
}

/**
 * What a server answered a grep with, as the answer shape: a server from
 * before that shape ignores `shape=answer` and sends the array of matches.
 * It stopped at the first `max` lines, in the order it met them, and does not
 * say whether more match — which the answer then says for it.
 */
export function grepAnswerFrom(body: GrepAnswer | GrepMatch[], max: number): GrepAnswer {
  if (!Array.isArray(body)) return body;
  if (body.length < max) return { matches: body, total: body.length };
  return {
    matches: body,
    total: body.length,
    cut: {
      shown: body.length,
      folders: [],
      note: `The server is an older version: it stopped at the first ${body.length} matching lines it met and does not say how many more match, or where.`,
    },
  };
}

/** The matches as `path:line: text`, and under a cut answer where the rest are: every folder that matches, with its count. */
export function formatGrep(answer: GrepAnswer): string {
  if (answer.matches.length === 0) return '(no matches)';
  const lines = answer.matches.map((m) => `${m.path}:${m.line}: ${m.text}`);
  if (!answer.cut) return lines.join('\n');
  // an older server's answer: no counts to give
  if (answer.cut.folders.length === 0) return [...lines, '', `-- ${answer.cut.note}`].join('\n');
  const lower = answer.cut.partial ? ` (at least: the scan stopped after ${answer.cut.partial.filesRead} of ${answer.cut.partial.files} files)` : '';
  const folders = answer.cut.folders.map((f) => `  ${f.path || '.'}${f.folders ? ` (+${f.folders} folders below)` : ''}: ${f.matches} in ${f.files} files, ${f.shown} shown`);
  return [...lines, '', `-- ${answer.cut.shown} of ${answer.total} matching lines shown${lower}, shared over the folders that hold them:`, ...folders, '-- search one folder to see its matches: knode grep <pattern> <folder>'].join('\n');
}

async function tree(deps: FileDeps, p: string, depth: number | undefined): Promise<TreeNode> {
  const srv = deps.server();
  if (srv) return srv.get<TreeNode>('/api/tree', { path: p, depth });
  return listTree(deps.dataDir(), p, depth, { hide: TREE_HIDDEN });
}

async function readText(deps: FileDeps, p: string, maxBytes: number, lang?: string): Promise<FileText> {
  const srv = deps.server();
  if (srv) return srv.get<FileText>('/api/file', { path: p, maxBytes, lang });
  if (lang) throw new Error('--lang reads a translation a server keeps: `knode-os login` first, or open the file under .sidecar/');
  if (isPrivatePath(p)) throw new Error(`${p} is not available through the file API`);
  const file = readSourceTextCapped(deps.dataDir(), p, maxBytes);
  if (!file) throw new Error(`no derived text for ${p} yet — run \`knode-os sync\` first`);
  return { path: p, ...file };
}

const needServer = (deps: FileDeps, what: string): KnodeClient => {
  const srv = deps.server();
  if (!srv) throw new Error(`\`knode-os ${what}\` works on a server's workspace — \`knode-os login <server>\` first. Here, the files are under ${deps.dataDir()}: change them there and run \`knode-os sync\``);
  return srv;
};

/** Index what changed. A sync already running on the server (its file watcher, or someone else's) takes the files along. */
async function syncPaths(srv: KnodeClient, only: string[]): Promise<string> {
  try {
    const stats = await srv.post<{ indexed?: number; unchanged?: number; disposed?: number; errors?: number }>('/api/sync', { only });
    return `indexed: ${stats.indexed ?? 0} applied, ${stats.unchanged ?? 0} unchanged${stats.disposed ? `, ${stats.disposed} disposed` : ''}${stats.errors ? `, ${stats.errors} errors` : ''}`;
  } catch (e) {
    if (e instanceof ServerError && e.status === 409) return 'the server is syncing already; it takes these files along';
    throw e;
  }
}

/** Where a downloaded file lands: into a directory that exists, or at the path given. */
function targetFor(out: string | undefined, rel: string, many: boolean): string {
  if (!out) return path.resolve(path.basename(rel));
  const abs = path.resolve(out);
  if (many || (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) || out.endsWith('/')) return path.join(abs, path.basename(rel));
  return abs;
}

/**
 * One file's bytes: a PDF, web page or picture as the original the server
 * keeps, anything else through the file API's text (at most 4 MB). A file
 * that is text only as knode-os derived it comes as that Markdown.
 */
export async function downloadFile(srv: KnodeClient, rel: string): Promise<{ bytes: Uint8Array; derived: boolean }> {
  if (originalType(rel)) {
    const { bytes } = await srv.download('/api/file/original', { path: rel });
    return { bytes, derived: false };
  }
  const file = await srv.get<FileText>('/api/file', { path: rel, maxBytes: MAX_FILE_BYTES });
  if (file.truncated) throw new Error(`${rel} is larger than the ${humanBytes(MAX_FILE_BYTES)} the file API hands out`);
  return { bytes: Buffer.from(file.content, 'utf8'), derived: file.derived };
}

/** Local files and folders → the entries of an upload: a folder keeps its tree, under its own name. */
export function uploadEntries(inputs: string[]): { abs: string; name: string }[] {
  const out: { abs: string; name: string }[] = [];
  for (const input of inputs) {
    const abs = path.resolve(input);
    const stat = fs.statSync(abs);
    if (stat.isFile()) {
      out.push({ abs, name: path.basename(abs) });
      continue;
    }
    const base = path.basename(abs);
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) out.push({ abs: full, name: `${base}/${path.relative(abs, full).split(path.sep).join('/')}` });
      }
    };
    walk(abs);
  }
  return out;
}

export function registerFileCommands(program: Command, deps: FileDeps): void {
  program
    .command('ls [path]')
    .description('list a folder of the workspace (default: its root); on a server when signed in')
    .option('--depth <n>', 'levels to list', '1')
    .option('--json', 'raw JSON output')
    .action(async (p: string | undefined, opts: { depth: string; json?: boolean }) => {
      const node = await tree(deps, clean(p), Math.max(1, Number(opts.depth) || 1));
      if (opts.json) return console.log(JSON.stringify(node, null, 2));
      console.log(node.kind === 'file' ? formatListing([node]) : formatListing(flatten(node)));
    });

  program
    .command('tree [path]')
    .description('a folder and what is under it, drawn as a tree')
    .option('-L, --level <n>', 'levels to descend', '3')
    .option('--json', 'raw JSON output')
    .action(async (p: string | undefined, opts: { level: string; json?: boolean }) => {
      const node = await tree(deps, clean(p), Math.max(1, Number(opts.level) || 3));
      console.log(opts.json ? JSON.stringify(node, null, 2) : formatTree(node));
    });

  program
    .command('read <path>')
    .alias('cat')
    .description('print a file; a PDF or picture prints the Markdown knode-os derived from it')
    .option('--max-bytes <n>', `read at most this much (default ${humanBytes(MAX_PREVIEW_BYTES)}, up to ${humanBytes(MAX_FILE_BYTES)})`)
    .option('--lang <tag>', 'the translation into this content language, where the server has one')
    .option('--json', 'raw JSON output')
    .action(async (p: string, opts: { maxBytes?: string; lang?: string; json?: boolean }) => {
      const cap = Math.min(MAX_FILE_BYTES, Number(opts.maxBytes) || MAX_PREVIEW_BYTES);
      const file = await readText(deps, clean(p), cap, opts.lang);
      if (opts.json) return console.log(JSON.stringify(file, null, 2));
      process.stdout.write(file.content.endsWith('\n') ? file.content : `${file.content}\n`);
      if (file.truncated) console.error(`(cut at ${humanBytes(cap)} of ${humanBytes(file.bytes)} — --max-bytes reads more, \`knode-os get\` saves the file)`);
    });

  program
    .command('stat <path>')
    .description('what a path is: file or folder, its size, when it changed, how many entries')
    .option('--json', 'raw JSON output')
    .action(async (p: string, opts: { json?: boolean }) => {
      const node = await tree(deps, clean(p), 1);
      // the server's listing carries the workspace's linked folders along: not this path's business
      const { children, links: _links, ...rest } = node as TreeNode & { links?: unknown };
      const info = { ...rest, ...(node.kind === 'dir' ? { entries: children?.length ?? 0 } : {}), ...(node.kind === 'file' && originalType(node.path) ? { original: originalType(node.path) } : {}) };
      if (opts.json) return console.log(JSON.stringify(info, null, 2));
      for (const [key, value] of Object.entries(info)) console.log(`${key.padEnd(8)} ${key === 'bytes' ? `${value} (${humanBytes(value as number)})` : value}`);
    });

  program
    .command('grep <pattern> [path]')
    .description('search file contents with a regular expression (case-insensitive); PDFs and pictures by their derived Markdown')
    .option('-n, --max <n>', 'at most this many matches (up to 500)', '100')
    .option('--json', 'raw JSON output')
    .action(async (pattern: string, p: string | undefined, opts: { max: string; json?: boolean }) => {
      const srv = deps.server();
      const at = p ? clean(p) : undefined;
      const max = Number(opts.max);
      const answer = srv
        ? grepAnswerFrom(await srv.get<GrepAnswer | GrepMatch[]>('/api/grep', { pattern, path: at, maxMatches: max, shape: 'answer' }), max)
        : grepAnswer(grepSearch(deps.dataDir(), pattern, { paths: at ? [at] : undefined, maxMatches: max }));
      console.log(opts.json ? JSON.stringify(answer, null, 2) : formatGrep(answer));
    });

  program
    .command('get <paths...>')
    .alias('download')
    .description('download files or folders from the server\'s workspace: originals for PDFs, web pages and pictures, the text of the rest')
    .option('-o, --out <path>', 'where to save: a file name for one file, or a folder (default: here)')
    .option('-f, --force', 'replace files that exist already')
    .action(async (paths: string[], opts: { out?: string; force?: boolean }) => {
      const srv = needServer(deps, 'get');
      const plan: { rel: string; to: string }[] = [];
      for (const raw of paths) {
        const rel = clean(raw);
        const node = await srv.get<TreeNode>('/api/tree', { path: rel });
        if (node.kind === 'file') {
          plan.push({ rel, to: targetFor(opts.out, rel, paths.length > 1) });
          continue;
        }
        // a folder comes with its tree, under its own name
        const base = path.resolve(opts.out ?? '.', rel === '.' ? 'workspace' : path.basename(rel));
        for (const f of flatten(node).filter((n) => n.kind === 'file')) {
          plan.push({ rel: f.path, to: path.join(base, path.relative(rel === '.' ? '' : rel, f.path)) });
        }
      }
      let saved = 0;
      for (const item of plan) {
        if (fs.existsSync(item.to) && !opts.force) {
          console.error(`skipped ${item.rel}: ${item.to} exists (--force replaces it)`);
          continue;
        }
        const { bytes, derived } = await downloadFile(srv, item.rel);
        const to = derived ? `${item.to}.md` : item.to;
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(to, bytes);
        saved++;
        const near = path.relative(process.cwd(), to);
        console.log(`${item.rel} → ${near && !near.startsWith('..') ? near : to}  (${humanBytes(bytes.length)}${derived ? ', the Markdown derived from it' : ''})`);
      }
      if (plan.length > 1) console.log(`${saved} of ${plan.length} files saved`);
    });

  program
    .command('put <files...>')
    .alias('upload')
    .description('upload files or folders into the server\'s workspace (raw/docs or wiki) and index them')
    .option('--to <folder>', 'the folder to put them in, under raw/docs or wiki', 'raw/docs')
    .option('--no-sync', 'upload only; index later')
    .action(async (files: string[], opts: { to: string; sync: boolean }) => {
      const srv = needServer(deps, 'put');
      const entries = uploadEntries(files);
      if (entries.length === 0) throw new Error('nothing to upload');
      const form = new FormData();
      form.set('dir', clean(opts.to));
      for (const e of entries) form.append('file', new File([fs.readFileSync(e.abs)], e.name));
      const res = await srv.upload<{ saved: string[]; skipped?: string[] }>('/api/upload', form);
      for (const p of res.saved) console.log(`uploaded ${p}`);
      for (const p of res.skipped ?? []) console.log(`skipped ${p} (a sidecar entry is knode-os's own state)`);
      if (opts.sync && res.saved.length) console.log(await syncPaths(srv, res.saved));
    });

  program
    .command('write <path>')
    .description('write a text file in the server\'s workspace (wiki/ or raw/docs/) from --from or stdin, and index it')
    .option('--from <file>', 'the local file to send (default: stdin)')
    .option('--no-sync', 'write only; index later')
    .action(async (p: string, opts: { from?: string; sync: boolean }) => {
      const srv = needServer(deps, 'write');
      const rel = clean(p);
      let content: string;
      if (opts.from) content = fs.readFileSync(path.resolve(opts.from), 'utf8');
      else {
        if (process.stdin.isTTY) throw new Error('give the text on stdin, or --from <file>');
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
        content = Buffer.concat(chunks).toString('utf8');
      }
      await srv.put('/api/file', { path: rel, content });
      console.log(`wrote ${rel} (${humanBytes(Buffer.byteLength(content))})`);
      if (opts.sync) console.log(await syncPaths(srv, [rel]));
    });

  program
    .command('mkdir <path>')
    .description('make a folder in the server\'s workspace, under wiki/ or raw/docs/')
    .action(async (p: string) => {
      const res = await needServer(deps, 'mkdir').post<{ path: string }>('/api/mkdir', { path: clean(p) });
      console.log(`made ${res.path}/`);
    });

  program
    .command('mv <from> <to>')
    .description('move or rename a file or folder in the server\'s workspace; the knowledge follows on the next sync')
    .option('--no-sync', 'move only; index later')
    .action(async (from: string, to: string, opts: { sync: boolean }) => {
      const srv = needServer(deps, 'mv');
      const res = await srv.post<{ from: string; to: string }>('/api/mv', { from: clean(from), to: clean(to) });
      console.log(`moved ${res.from} → ${res.to}`);
      if (opts.sync) console.log(await syncPaths(srv, [res.from, res.to]));
    });

  program
    .command('rm <path>')
    .description('delete a file or folder from the server\'s workspace: what it produced is disposed, its history stays (`forget` purges that, on the server)')
    .action(async (p: string) => {
      const res = await needServer(deps, 'rm').delete<{ disposed?: number; pagesArchived?: number }>('/api/file', { path: clean(p) });
      console.log(`deleted ${clean(p)}${res.disposed ? `; ${res.disposed} source(s) disposed` : ''}${res.pagesArchived ? `, ${res.pagesArchived} page(s) archived` : ''}`);
    });
}
