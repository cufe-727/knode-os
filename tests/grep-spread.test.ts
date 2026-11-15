import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { formatGrep, grepAnswerFrom } from '../src/client/files.js';
import { defaultConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { foldGrepFolders, GREP_FOLDERS_MAX, grepAnswer, grepFiles, GrepFolder, grepSearch, shareEvenly } from '../src/fs/files.js';
import { grepCutNote, grepPaths, grepWithContext } from '../src/mcp/batch.js';
import { registerKnodeTools } from '../src/mcp/tools.js';

/**
 * A grep with more matches than it may return took them in the order the
 * walk met them, so the first folder filled the answer: on the 2026-11
 * separation benchmark /平台组/ over ten divisions' reports returned 39 of 40
 * matches from 七部平台组, and the agent answered for that division. The
 * matches are now shared over the folders and files that hold them, and the
 * answer names every folder that matches with its count.
 *
 * The fixture: ten divisions' platform teams, twelve weekly reports each that
 * name the team once (the first division's twice a report), one monthly
 * report naming it once, and a folder that never names it.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-grep-spread-'));
const DIVISIONS = ['一部', '七部', '三部', '九部', '二部', '五部', '八部', '六部', '十部', '四部'];
let ctx: AppContext;

const folderOf = (file: string) => file.slice(0, file.lastIndexOf('/'));
const perFolder = (matches: { path: string }[]) => {
  const out = new Map<string, number>();
  for (const m of matches) out.set(folderOf(m.path), (out.get(folderOf(m.path)) ?? 0) + 1);
  return out;
};

beforeAll(() => {
  const docs = path.join(tmp, 'raw', 'docs');
  for (const d of DIVISIONS) {
    const dir = path.join(docs, '周报', `${d}平台组`);
    fs.mkdirSync(dir, { recursive: true });
    for (let w = 1; w <= 12; w++) {
      const twice = d === '一部' ? `\n${d}平台组下周计划：压测。` : '';
      fs.writeFileSync(path.join(dir, `w${String(w).padStart(2, '0')}.md`), `# ${d}平台组周报 · 第${w}周\n服务可用性 99.9${w % 10}%${twice}\n`);
    }
  }
  fs.mkdirSync(path.join(docs, '月报'), { recursive: true });
  fs.writeFileSync(path.join(docs, '月报', 'pmo-01.md'), '# 月报\n各事业部平台组在岗人数不变。\n');
  fs.mkdirSync(path.join(docs, '周报', '一部增长组'), { recursive: true });
  fs.writeFileSync(path.join(docs, '周报', '一部增长组', 'w01.md'), '# 一部增长组周报\n拉新 1200 人。\n');
  ctx = { dataDir: tmp, config: defaultConfig() } as unknown as AppContext;
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a grep with more matches than it returns', () => {
  it('shares the matches over the folders that hold them, and names each with its count', () => {
    const r = grepSearch(tmp, '平台组', { paths: ['raw/docs'], maxMatches: 40 });
    expect(r.matches).toHaveLength(40);
    // 9 divisions × 12 reports × 1 line, the first division's 12 × 2, and the monthly report's line
    expect(r.total).toBe(9 * 12 + 24 + 1);
    expect(r.partial).toBeUndefined();
    const shown = perFolder(r.matches);
    // every folder that matches is in the answer: ten divisions and the monthly reports
    expect(shown.size).toBe(11);
    for (const d of DIVISIONS) expect(shown.get(`raw/docs/周报/${d}平台组`), d).toBeGreaterThanOrEqual(3);
    expect(shown.get('raw/docs/月报')).toBe(1);
    expect(Math.max(...shown.values())).toBeLessThanOrEqual(4);

    expect(r.folders).toHaveLength(11);
    const first = r.folders!.find((f) => f.path === 'raw/docs/周报/一部平台组')!;
    expect(first).toEqual({ path: 'raw/docs/周报/一部平台组', matches: 24, files: 12, shown: shown.get('raw/docs/周报/一部平台组') });
    expect(r.folders!.find((f) => f.path === 'raw/docs/月报')).toEqual({ path: 'raw/docs/月报', matches: 1, files: 1, shown: 1 });
    expect(r.folders!.reduce((n, f) => n + f.shown, 0)).toBe(40);
    expect(r.folders!.reduce((n, f) => n + f.matches, 0)).toBe(r.total);
  });

  it('shares a folder\'s places over its files, the earliest first, before taking a file\'s second line', () => {
    const r = grepSearch(tmp, '平台组', { paths: ['raw/docs/周报/一部平台组'], maxMatches: 8 });
    expect(r.total).toBe(24);
    expect(r.matches.map((m) => `${path.basename(m.path)}:${m.line}`)).toEqual(['w01.md:1', 'w02.md:1', 'w03.md:1', 'w04.md:1', 'w05.md:1', 'w06.md:1', 'w07.md:1', 'w08.md:1']);
    expect(r.folders).toEqual([{ path: 'raw/docs/周报/一部平台组', matches: 24, files: 12, shown: 8 }]);
  });

  it('with more folders than places gives the first searched one each, and still names every folder', () => {
    const r = grepSearch(tmp, '平台组', { paths: ['raw/docs'], maxMatches: 5 });
    expect(r.matches).toHaveLength(5);
    // one line each of the five folders searched first — not none for the folders that hold fewest
    expect([...perFolder(r.matches).entries()]).toEqual(DIVISIONS.slice(0, 5).map((d) => [`raw/docs/周报/${d}平台组`, 1]));
    // and all eleven are named with what they hold, the monthly reports' single line among them
    expect(r.folders!.map((f) => f.path)).toEqual([...DIVISIONS.map((d) => `raw/docs/周报/${d}平台组`), 'raw/docs/月报']);
    expect(r.folders!.filter((f) => f.shown === 0).map((f) => f.matches)).toEqual([12, 12, 12, 12, 12, 1]);
  });

  it('returns every match in the order searched when they fit, with nothing to add', () => {
    const r = grepSearch(tmp, '一部平台组', { paths: ['raw/docs'], maxMatches: 100 });
    expect(r.total).toBe(24);
    expect(r.folders).toBeUndefined();
    expect(r.matches.slice(0, 3)).toEqual([
      { path: 'raw/docs/周报/一部平台组/w01.md', line: 1, text: '# 一部平台组周报 · 第1周' },
      { path: 'raw/docs/周报/一部平台组/w01.md', line: 3, text: '一部平台组下周计划：压测。' },
      { path: 'raw/docs/周报/一部平台组/w02.md', line: 1, text: '# 一部平台组周报 · 第2周' },
    ]);
    expect(grepFiles(tmp, '一部平台组', { path: 'raw/docs' })).toEqual(r.matches);
    expect(grepSearch(tmp, '没有这个词', { paths: ['raw/docs'] })).toEqual({ matches: [], total: 0 });
  });

  it('counts a file once when the subtrees asked for overlap, and keeps a per-file cap', () => {
    const r = grepSearch(tmp, '平台组', { paths: ['raw/docs/周报/一部平台组', 'raw/docs/周报', 'raw/docs/月报'], maxMatches: 500 });
    expect(r.total).toBe(9 * 12 + 24 + 1);
    expect(r.matches).toHaveLength(r.total);
    // the subtree named first is searched first
    expect(folderOf(r.matches[0].path)).toBe('raw/docs/周报/一部平台组');
    expect(folderOf(r.matches[r.matches.length - 1].path)).toBe('raw/docs/月报');

    const capped = grepPaths(ctx, { pattern: '平台组', paths: ['raw/docs/周报/一部平台组'], maxPerFile: 1 });
    expect(capped).toHaveLength(12);
    expect(new Set(capped.map((m) => m.path)).size).toBe(12);
    // the lines a per-file cap leaves out are counted too
    expect(grepSearch(tmp, '平台组', { paths: ['raw/docs/周报/一部平台组'], maxPerFile: 1 }).folders).toEqual([{ path: 'raw/docs/周报/一部平台组', matches: 24, files: 12, shown: 12 }]);
  });
});

describe('how much a grep reads', () => {
  it('reads each file once', () => {
    const reads = new Map<string, number>();
    const real = fs.readFileSync;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof file === 'string' && file.startsWith(tmp)) reads.set(file, (reads.get(file) ?? 0) + 1);
      return (real as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync);
    try {
      const r = grepSearch(tmp, '平台组', { paths: ['raw/docs'], maxMatches: 40 });
      expect(r.matches).toHaveLength(40);
    } finally {
      spy.mockRestore();
    }
    // 121 report files and the growth team's: each read once, the 40 files shown not a second time
    expect(reads.size).toBe(122);
    expect(Math.max(...reads.values())).toBe(1);
  });

  it('stops with its answer full once it has read its fill, a folder in turn, and says the counts are lower bounds', () => {
    // a scan allowed no bytes past a full answer: it stops as soon as five lines match
    const r = grepSearch(tmp, '平台组', { paths: ['raw/docs'], maxMatches: 5, scanBytes: 0 });
    expect(r.matches).toHaveLength(5);
    // the first round: one file of each of four divisions (the first's holds two lines), not five lines of one folder
    // (and the growth team's first, which holds none)
    expect(r.partial).toEqual({ filesRead: 5, files: 122 });
    expect(perFolder(r.matches).size).toBe(4);
    expect(r.total).toBe(5);
    expect(r.folders!.map((f) => f.unread)).toEqual([11, 11, 11, 11]);
    const answer = grepAnswer(r);
    expect(answer.cut!.partial).toEqual({ filesRead: 5, files: 122 });
    expect(answer.cut!.note).toContain('at least: the scan stopped after 5 of 122 files');
    expect(grepCutNote(answer)).toContain('11 files not read');

    // a pattern in one file is looked for in every file, however small the fill
    const rare = grepSearch(tmp, '拉新', { paths: ['raw/docs'], maxMatches: 5, scanBytes: 0 });
    expect(rare).toEqual({ matches: [{ path: 'raw/docs/周报/一部增长组/w01.md', line: 2, text: '拉新 1200 人。' }], total: 1 });
    // and with the default fill this tree is read whole
    expect(grepSearch(tmp, '平台组', { paths: ['raw/docs'], maxMatches: 5 }).partial).toBeUndefined();
  });
});

describe('the folders a cut answer names', () => {
  it('folds a long list into parent folders, every match still counted', () => {
    const many: GrepFolder[] = [
      { path: 'wiki/entities', matches: 3, files: 2, shown: 1 },
      ...Array.from({ length: 70 }, (_, i) => ({ path: `raw/docs/feishu/person-${i}`, matches: 2, files: 1, shown: i < 30 ? 1 : 0 })),
      { path: 'raw/docs/feishu', matches: 1, files: 1, shown: 1 },
      { path: 'raw/docs/notes', matches: 4, files: 4, shown: 1, unread: 2 },
    ];
    expect(foldGrepFolders(many.slice(0, 5), GREP_FOLDERS_MAX)).toEqual(many.slice(0, 5));
    const folded = foldGrepFolders(many, GREP_FOLDERS_MAX);
    expect(folded).toEqual([
      { path: 'wiki/entities', matches: 3, files: 2, shown: 1 },
      { path: 'raw/docs/feishu', matches: 141, files: 71, shown: 31, folders: 70 },
      { path: 'raw/docs/notes', matches: 4, files: 4, shown: 1, unread: 2 },
    ]);
    expect(folded.reduce((n, f) => n + f.matches, 0)).toBe(many.reduce((n, f) => n + f.matches, 0));
  });

  it('names more folders than it has places for, in the text answer and the JSON one', () => {
    const answer = grepAnswer(grepSearch(tmp, '平台组', { paths: ['raw/docs'], maxMatches: 5 }));
    expect(answer.cut!.folders).toHaveLength(11);
    const note = grepCutNote(answer);
    expect(note.split('\n')[0]).toBe('(showing 5 of 133 matching lines, shared over the folders and files that hold them:');
    expect(note).toContain('  raw/docs/周报/一部平台组: 24 matches in 12 files, 1 shown');
    for (const d of DIVISIONS.slice(5)) expect(note).toContain(`  raw/docs/周报/${d}平台组: 12 matches in 12 files, 0 shown`);
    expect(note).toContain('  raw/docs/月报: 1 match in 1 file, 0 shown');
    expect(note).toContain('search it alone (`path`)');
    expect(grepCutNote(grepAnswer(grepSearch(tmp, '拉新', { paths: ['raw/docs'] })))).toBe('');
  });
});

describe('grep with context', () => {
  it('names the folders in a closing note, and none when the answer is complete', () => {
    const text = grepWithContext(ctx, { pattern: '平台组', paths: ['raw/docs'], context: 1, maxMatches: 40 });
    const note = text.slice(text.indexOf('(showing 40'));
    expect(note.split('\n')[0]).toBe('(showing 40 of 133 matching lines, shared over the folders and files that hold them:');
    expect(note.split('\n').filter((l) => l.startsWith('  raw/docs/'))).toHaveLength(11);
    expect(grepWithContext(ctx, { pattern: '拉新', paths: ['raw/docs'], context: 1 })).not.toContain('showing');
  });

  it('leaves files out a folder in turn when the answer is too long, and counts what it shows', () => {
    // six folders of four long files: a match with 20 lines of context is about 12,000 characters, and an answer holds 60,000
    const long = path.join(tmp, 'raw', 'docs', 'long');
    const filler = 'x'.repeat(280);
    for (let f = 1; f <= 6; f++) {
      fs.mkdirSync(path.join(long, `team-${f}`), { recursive: true });
      for (let n = 1; n <= 4; n++) {
        const lines = Array.from({ length: 41 }, (_, i) => (i === 20 ? `Zenith outage ${filler}` : `line ${i} ${filler}`));
        fs.writeFileSync(path.join(long, `team-${f}`, `r${n}.md`), lines.join('\n'));
      }
    }
    const text = grepWithContext(ctx, { pattern: 'Zenith outage', paths: ['raw/docs/long'], context: 20 });
    const shown = [...text.matchAll(/^== (raw\/docs\/long\/team-\d)\/r(\d)\.md \(1 match\)$/gm)].map((m) => `${m[1]}/r${m[2]}`);
    // cut in the order searched, the first folder's four files and one of the second filled the answer
    expect(shown).toEqual(['raw/docs/long/team-1/r1', 'raw/docs/long/team-2/r1', 'raw/docs/long/team-3/r1', 'raw/docs/long/team-4/r1', 'raw/docs/long/team-5/r1']);
    // and the note counts what the answer shows, not what the search picked
    expect(text).toContain('(showing 5 of 24 matching lines, shared over the folders and files that hold them:');
    for (let f = 1; f <= 5; f++) expect(text).toContain(`  raw/docs/long/team-${f}: 4 matches in 4 files, 1 shown`);
    expect(text).toContain('  raw/docs/long/team-6: 4 matches in 4 files, 0 shown');
    expect(text).toContain('(19 files with 19 matches left out by the answer\'s size, a folder in turn');
    fs.rmSync(long, { recursive: true, force: true });
  });
});

describe('the shape of a grep answer', () => {
  const call = async (args: Record<string, unknown>) => {
    const tools = new Map<string, { schema: Record<string, z.ZodTypeAny>; handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }>();
    const fake = {
      registerTool: (name: string, config: { inputSchema: Record<string, z.ZodTypeAny> }, handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>) => {
        tools.set(name, { schema: config.inputSchema, handler });
      },
    } as unknown as McpServer;
    registerKnodeTools(fake, ctx);
    const t = tools.get('knode_grep')!;
    return JSON.parse((await t.handler(z.object(t.schema).parse(args))).content[0].text);
  };

  it('is one object from the MCP tool, with `cut` when the matches are a sample', async () => {
    expect(await call({ pattern: '拉新', path: 'raw/docs' })).toEqual({ matches: [{ path: 'raw/docs/周报/一部增长组/w01.md', line: 2, text: '拉新 1200 人。' }], total: 1 });
    expect(await call({ pattern: '没有这个词', path: 'raw/docs' })).toEqual({ matches: [], total: 0 });

    const cut = await call({ pattern: '平台组', path: 'raw/docs', maxMatches: 40 });
    expect(Object.keys(cut)).toEqual(['matches', 'total', 'cut']);
    expect(cut.total).toBe(133);
    expect(cut.matches).toHaveLength(40);
    expect(cut.cut.shown).toBe(40);
    expect(cut.cut.folders).toHaveLength(11);
    expect(cut.cut.folders.at(-1)).toEqual({ path: 'raw/docs/月报', matches: 1, files: 1, shown: 1 });
    expect(cut.cut.note).toContain('Showing 40 of 133 matching lines');

    // cut by the per-file cap alone: the same shape
    const perFile = await call({ pattern: '平台组', path: 'raw/docs/周报/一部平台组', max_per_file: 1 });
    expect(Object.keys(perFile)).toEqual(['matches', 'total', 'cut']);
    expect(perFile.cut).toMatchObject({ shown: 12, folders: [{ path: 'raw/docs/周报/一部平台组', matches: 24, files: 12, shown: 12 }] });
    // and several paths
    expect(Object.keys(await call({ pattern: '拉新', paths: ['raw/docs/周报', 'raw/docs/月报'] }))).toEqual(['matches', 'total']);
  });

  it('is read by the command line from a server of either age', () => {
    const lines = [{ path: 'raw/docs/a.md', line: 3, text: 'copper' }, { path: 'raw/docs/b.md', line: 9, text: 'copper wire' }];
    // a server from before the answer shape sends the array, whatever the client asks for
    expect(grepAnswerFrom(lines, 100)).toEqual({ matches: lines, total: 2 });
    expect(formatGrep(grepAnswerFrom(lines, 100))).toBe('raw/docs/a.md:3: copper\nraw/docs/b.md:9: copper wire');
    expect(formatGrep(grepAnswerFrom([], 100))).toBe('(no matches)');
    // it stopped at the limit without saying whether more match: the command line says that for it
    const full = grepAnswerFrom(lines, 2);
    expect(full.cut?.shown).toBe(2);
    expect(formatGrep(full)).toBe('raw/docs/a.md:3: copper\nraw/docs/b.md:9: copper wire\n\n-- The server is an older version: it stopped at the first 2 matching lines it met and does not say how many more match, or where.');
    // a server of this version sends the answer
    const answer = grepAnswer(grepSearch(tmp, '拉新', { paths: ['raw/docs'] }));
    expect(grepAnswerFrom(answer, 100)).toBe(answer);
  });

  it('is said by the command line too', () => {
    const complete = grepAnswer(grepSearch(tmp, '拉新', { paths: ['raw/docs'] }));
    expect(formatGrep(complete)).toBe('raw/docs/周报/一部增长组/w01.md:2: 拉新 1200 人。');
    expect(formatGrep(grepAnswer(grepSearch(tmp, '没有这个词')))).toBe('(no matches)');
    const text = formatGrep(grepAnswer(grepSearch(tmp, '平台组', { paths: ['raw/docs'], maxMatches: 5 })));
    expect(text.split('\n').slice(0, 5).every((l) => /^raw\/docs\/.+:\d+: /.test(l))).toBe(true);
    expect(text).toContain('-- 5 of 133 matching lines shown, shared over the folders that hold them:');
    expect(text).toContain('  raw/docs/周报/十部平台组: 12 in 12 files, 0 shown');
    expect(text).toContain('knode grep <pattern> <folder>');
  });
});

describe('shareEvenly', () => {
  it('meets the small amounts whole, splits the rest, and gives what is left over to the earliest', () => {
    expect(shareEvenly([10, 1000, 1000], 1000)).toEqual([10, 495, 495]);
    expect(shareEvenly([3, 3, 3], 100)).toEqual([3, 3, 3]);
    expect(shareEvenly([5, 5, 5, 5], 2)).toEqual([1, 1, 0, 0]);
    expect(shareEvenly([1, 9, 9], 8)).toEqual([1, 4, 3]);
    expect(shareEvenly([9, 1, 9], 2)).toEqual([1, 1, 0]);
    expect(shareEvenly([], 10)).toEqual([]);
  });
});
