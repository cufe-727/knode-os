import { AppContext } from '../context.js';
import { MAX_FILE_BYTES } from '../constants.js';
import { grepFiles, GrepMatch } from '../fs/files.js';
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
  const out = new Array<number>(lengths.length).fill(0);
  let remaining = budget;
  let left = lengths.length;
  for (const i of lengths.map((_, i) => i).sort((a, b) => lengths[a] - lengths[b] || a - b)) {
    const share = Math.floor(remaining / left);
    out[i] = Math.min(lengths[i], share);
    remaining -= out[i];
    left--;
  }
  return out;
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

/** The matches of one or several subtrees, deduplicated, in file then line order of discovery. */
export function grepPaths(ctx: AppContext, req: GrepRequest): GrepMatch[] {
  const max = Math.min(req.maxMatches ?? 100, 500);
  const perFile = Math.max(1, req.maxPerFile ?? max);
  const out: GrepMatch[] = [];
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const root of req.paths?.length ? req.paths : [undefined]) {
    if (out.length >= max) break;
    // over-fetch so a file past its per-file cap does not starve the others
    for (const m of grepFiles(ctx.dataDir, req.pattern, { path: root, maxMatches: 500 })) {
      const key = `${m.path}:${m.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const n = counts.get(m.path) ?? 0;
      if (n >= perFile) continue;
      counts.set(m.path, n + 1);
      out.push(m);
      if (out.length >= max) break;
    }
  }
  return out;
}

/**
 * The matches with `context` lines around them, grouped by file:
 *
 *   == raw/docs/a.md (2 matches)
 *   11- line before
 *   12: the matching line
 *   13- line after
 *   --
 *   40: another match
 */
export function grepWithContext(ctx: AppContext, req: GrepRequest): string {
  const matches = grepPaths(ctx, req);
  if (matches.length === 0) return `no match for /${req.pattern}/${req.paths?.length ? ` under ${req.paths.join(', ')}` : ''}`;
  const context = Math.min(Math.max(req.context ?? 0, 0), 20);
  const byFile = new Map<string, number[]>();
  for (const m of matches) (byFile.get(m.path) ?? byFile.set(m.path, []).get(m.path)!).push(m.line);
  const blocks: string[] = [];
  let size = 0;
  const skipped: string[] = [];
  for (const [file, hits] of byFile) {
    if (size >= GREP_CHARS_MAX) {
      skipped.push(file);
      continue;
    }
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
    const block = out.join('\n');
    size += block.length;
    blocks.push(block);
  }
  const max = Math.min(req.maxMatches ?? 100, 500);
  const notes = [
    matches.length >= max ? `(stopped at ${max} matches: narrow the pattern or the paths, or raise maxMatches)` : '',
    skipped.length ? `(not shown, past the answer's size: ${skipped.join(', ')})` : '',
  ].filter(Boolean);
  return [...blocks, ...notes].join('\n\n');
}
