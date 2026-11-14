import { AppContext } from '../context.js';
import { MAX_FILE_BYTES } from '../constants.js';
import { GrepAnswer, GrepMatch, GrepResult, grepAnswer, grepSearch, shareEvenly } from '../fs/files.js';
import { readSourceTextCapped } from '../ingest/source.js';
import { isVirtualPath, readVirtual } from '../compiler/vfs.js';
import { readSection, ReadSlice } from '../research/read.js';

/**
 * Batched reading for agents (docs/design/30 §5).
 *
 * In the 2026-11 benchmark the knode agent read raw documents one per call,
 * 8.1 calls a question against grep's 3.7; a shell agent reads three files
 * with one `sed`. So `knode_read` takes several paths, each with an optional
 * section or line range, under one character budget shared fairly (a short
 * file is read whole, the long ones split what is left and say where to read
 * on), and `knode_grep` returns its matches with context lines, grouped by
 * file, across several subtrees in one call, as `grep -n -C` would.
 */

export interface ReadRequest extends ReadSlice {
  path: string;
}

/** Characters a batched read returns by default, and at most. */
export const READ_BUDGET = 60_000;
export const READ_BUDGET_MAX = 200_000;
/** Paths one batched read takes at most. */
export const READ_PATHS_MAX = 20;

const sliceOf = (r: ReadRequest): ReadSlice | null =>
  r.section === undefined && r.offset === undefined && r.limit === undefined && !r.outline ? null : { section: r.section, offset: r.offset, limit: r.limit, outline: r.outline };

/** The text one request reads, or why it could not. */
async function readOne(ctx: AppContext, r: ReadRequest): Promise<{ text: string; error?: undefined } | { text?: undefined; error: string }> {
  try {
    if (isVirtualPath(r.path)) return { text: await readVirtual(ctx, r.path) };
    const file = readSourceTextCapped(ctx.dataDir, r.path, MAX_FILE_BYTES);
    if (!file) return { error: `no derived text for ${r.path} yet — run knode_sync first (a capture is indexed within seconds)` };
    const slice = sliceOf(r);
    return { text: slice ? readSection(file.content, slice) : file.content };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Each request's share of `budget`: water-filling, so every text shorter
 * than an even share is read whole and the longer ones split the rest evenly.
 */
export function shareBudget(lengths: number[], budget: number): number[] {
  return shareEvenly(lengths, budget);
}

/** `text` cut to `chars` on a line, with where to read on. */
function cut(text: string, chars: number, r: ReadRequest): string {
  if (text.length <= chars) return text;
  const lines = text.split('\n');
  let size = 0;
  let n = 0;
  for (; n < lines.length && size + lines[n].length + 1 <= chars; n++) size += lines[n].length + 1;
  // a sliced read starts with a header naming its first line, then a blank line: line k of the text is file line first + k - 3
  const range = /^（第 (\d+)–\d+ 行/.exec(lines[0] ?? '');
  const next = range ? Number(range[1]) + Math.max(0, n - 2) : sliceOf(r) ? null : n + 1;
  const how = next ? ` read on with {"path": "${r.path}", "offset": ${next}}` : ' read it alone for the rest';
  return `${lines.slice(0, n).join('\n')}\n…(cut by the batch budget after ${n} of ${lines.length} lines;${how})`;
}

/** Several files in one answer, each under a `=== path ===` header, within `budget` characters of text. */
export async function readMany(ctx: AppContext, requests: ReadRequest[], budget = READ_BUDGET): Promise<string> {
  const reads = await Promise.all(requests.map((r) => readOne(ctx, r)));
  const shares = shareBudget(reads.map((x) => x.text?.length ?? 0), Math.min(Math.max(budget, 1000), READ_BUDGET_MAX));
  return requests
    .map((r, i) => {
      const x = reads[i];
      const where = r.section !== undefined ? ` § ${r.section}` : r.offset !== undefined || r.limit !== undefined ? ` lines ${r.offset ?? 1}+${r.limit ?? 400}` : r.outline ? ' (outline)' : '';
      const header = `=== ${r.path}${where} ===`;
      if (x.error !== undefined) return `${header}\n(error: ${x.error})`;
      return `${header}\n${cut(x.text, shares[i], r)}`;
    })
    .join('\n\n');
}

export interface GrepRequest {
  pattern: string;
  /** Subtrees or files to search; none = every searchable root. */
  paths?: string[];
  /** Lines of context before and after each match (`grep -C`). */
  context?: number;
  /** Matches returned at most, over every file. */
  maxMatches?: number;
  /** Matches returned per file at most. */
  maxPerFile?: number;
}

/** Characters of one grep answer at most: past it the remaining files are named, not shown. */
const GREP_CHARS_MAX = 60_000;
const LINE_CHARS = 300;

/**
 * The matches of one or several subtrees, each file once, in the order
 * searched. More matches than `maxMatches` are shared over the folders and
 * files that hold them (`grepSearch`), not taken from the first ones met.
 */
export function grepAcross(ctx: AppContext, req: GrepRequest): GrepResult {
  return grepSearch(ctx.dataDir, req.pattern, { paths: req.paths, maxMatches: req.maxMatches, maxPerFile: req.maxPerFile });
}

export function grepPaths(ctx: AppContext, req: GrepRequest): GrepMatch[] {
  return grepAcross(ctx, req).matches;
}

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * What a text answer says when it is a sample: how many lines match in all,
 * and every folder that matches with its count and how many of its lines
 * are shown, so the caller can ask for the one folder it means. Empty when
 * every match is shown.
 */
export function grepCutNote(answer: GrepAnswer): string {
  const cut = answer.cut;
  if (!cut) return '';
  const lower = cut.partial ? ` (at least: the scan stopped after ${cut.partial.filesRead.toLocaleString('en-US')} of ${count(cut.partial.files, 'file')}, a folder in turn)` : '';
  const lines = cut.folders.map((f) => {
    const below = f.folders ? ` and ${count(f.folders, 'folder')} below it` : '';
    const unread = f.unread ? `, ${count(f.unread, 'file')} not read` : '';
    return `  ${f.path || '.'}${below}: ${count(f.matches, 'match', 'matches')} in ${count(f.files, 'file')}, ${f.shown.toLocaleString('en-US')} shown${unread}`;
  });
  return [
    `(showing ${cut.shown.toLocaleString('en-US')} of ${count(answer.total, 'matching line')}${lower}, shared over the folders and files that hold them:`,
    ...lines,
    'To see a folder\'s matches, search it alone (`path`), or narrow the pattern.)',
  ].join('\n');
}

const folderOf = (file: string) => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '');

/**
 * The matches with `context` lines around them, grouped by file:
 *
 *   == raw/docs/a.md (2 matches)
 *   11- line before
 *   12: the matching line
 *   13- line after
 *   --
 *   40: another match
 *
 * An answer past `GREP_CHARS_MAX` leaves files out a folder in turn, as the
 * matches were chosen: the first file of every folder is in before any
 * folder's second. Cut in the order searched, the last folders fell out
 * whole, and the note still counted their lines as shown.
 */
export function grepWithContext(ctx: AppContext, req: GrepRequest): string {
  const result = grepAcross(ctx, req);
  const { matches } = result;
  if (matches.length === 0) return `no match for /${req.pattern}/${req.paths?.length ? ` under ${req.paths.join(', ')}` : ''}`;
  const context = Math.min(Math.max(req.context ?? 0, 0), 20);
  const byFile = new Map<string, number[]>();
  for (const m of matches) (byFile.get(m.path) ?? byFile.set(m.path, []).get(m.path)!).push(m.line);
  const blocks: { file: string; text: string; hits: number }[] = [];
  for (const [file, hits] of byFile) {
    let lines: string[];
    try {
      lines = context > 0 ? (readSourceTextCapped(ctx.dataDir, file, MAX_FILE_BYTES)?.content ?? '').split('\n') : [];
    } catch {
      lines = [];
    }
    const sorted = [...new Set(hits)].sort((a, b) => a - b);
    const text = new Map(matches.filter((m) => m.path === file).map((m) => [m.line, m.text]));
    const out: string[] = [`== ${file} (${sorted.length} match${sorted.length === 1 ? '' : 'es'})`];
    let last = 0;
    for (const line of sorted) {
      const from = Math.max(1, line - context, last + 1);
      const to = lines.length ? Math.min(lines.length, line + context) : line;
      if (context > 0 && last && from > last + 1) out.push('--');
      for (let n = from; n <= to; n++) {
        if (n <= last) continue;
        const body = n === line ? (lines[n - 1]?.trim() ?? text.get(n) ?? '') : (lines[n - 1] ?? '').trimEnd();
        out.push(`${n}${sorted.includes(n) ? ':' : '-'} ${body.slice(0, LINE_CHARS)}`);
      }
      last = Math.max(last, to);
    }
    blocks.push({ file, text: out.join('\n'), hits: sorted.length });
  }

  // what fits, a folder in turn
  const inFolder = new Map<string, number[]>();
  blocks.forEach((b, i) => (inFolder.get(folderOf(b.file)) ?? inFolder.set(folderOf(b.file), []).get(folderOf(b.file))!).push(i));
  const kept = new Set<number>();
  let size = 0;
  for (let round = 0; kept.size < blocks.length && size < GREP_CHARS_MAX; round++) {
    let any = false;
    for (const members of inFolder.values()) {
      const i = members[round];
      if (i === undefined) continue;
      any = true;
      if (size >= GREP_CHARS_MAX) break;
      kept.add(i);
      size += blocks[i].text.length;
    }
    if (!any) break;
  }
  const dropped = blocks.filter((_, i) => !kept.has(i));
  let shownResult = result;
  if (dropped.length > 0) {
    // the answer shows less than the search picked: its matches, and each folder's count of shown lines, say so
    const gone = new Set(dropped.map((b) => b.file));
    const lost = new Map<string, number>();
    for (const b of dropped) lost.set(folderOf(b.file), (lost.get(folderOf(b.file)) ?? 0) + b.hits);
    const folders = result.folders
      ?? [...inFolder.keys()].map((folder) => {
        const mine = blocks.filter((b) => folderOf(b.file) === folder);
        return { path: folder, matches: mine.reduce((n, b) => n + b.hits, 0), files: mine.length, shown: mine.reduce((n, b) => n + b.hits, 0) };
      });
    shownResult = {
      ...result,
      matches: matches.filter((m) => !gone.has(m.path)),
      folders: folders.map((f) => ({ ...f, shown: f.shown - (lost.get(f.path) ?? 0) })),
    };
  }
  const notes = [
    grepCutNote(grepAnswer(shownResult)),
    dropped.length ? `(${count(dropped.length, 'file')} with ${count(dropped.reduce((n, b) => n + b.hits, 0), 'match', 'matches')} left out by the answer's size, a folder in turn: ask for fewer matches or less context, or search a folder alone)` : '',
  ].filter(Boolean);
  return [...blocks.filter((_, i) => kept.has(i)).map((b) => b.text), ...notes].join('\n\n');
}
