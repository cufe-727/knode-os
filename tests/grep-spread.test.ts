import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defaultConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { grepFiles, grepSearch, shareEvenly } from '../src/fs/files.js';
import { grepCutNote, grepPaths, grepWithContext } from '../src/mcp/batch.js';
import { registerKnodeTools } from '../src/mcp/tools.js';

/**
 * A grep with more matches than it may return took them in the order the
 * walk met them, so the first folder filled the answer: on the 2026-11
 * separation benchmark /平台组/ over ten divisions' reports returned 39 of 40
 * matches from 七部平台组, and the agent answered for that division. The
 * matches are now shared over the folders and files that hold them, and the
 * answer says how many more each folder holds.
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
  it('shares the matches over the folders that hold them, and says how many each holds', () => {
    const r = grepSearch(tmp, '平台组', { paths: ['raw/docs'], maxMatches: 40 });
    expect(r.matches).toHaveLength(40);
    // 9 divisions × 12 reports × 1 line, the first division's 12 × 2, and the monthly report's line
    expect(r.total).toBe(9 * 12 + 24 + 1);
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

  it('shares a folder\'s places over its files before taking a file\'s second line', () => {
    const r = grepSearch(tmp, '平台组', { paths: ['raw/docs/周报/一部平台组'], maxMatches: 8 });
    expect(r.total).toBe(24);
    expect(r.matches.map((m) => `${path.basename(m.path)}:${m.line}`)).toEqual(['w05.md:1', 'w06.md:1', 'w07.md:1', 'w08.md:1', 'w09.md:1', 'w10.md:1', 'w11.md:1', 'w12.md:1']);
    expect(r.folders).toEqual([{ path: 'raw/docs/周报/一部平台组', matches: 24, files: 12, shown: 8 }]);
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

  it('gives a share to as many folders as there are places when there are more folders', () => {
    const r = grepSearch(tmp, '平台组', { paths: ['raw/docs'], maxMatches: 5 });
    expect(r.matches).toHaveLength(5);
    expect(perFolder(r.matches).size).toBe(5);
    expect(r.folders).toHaveLength(11);
  });

  it('names the folders with more in the text answer', () => {
    const text = grepWithContext(ctx, { pattern: '平台组', paths: ['raw/docs'], context: 1, maxMatches: 40 });
    expect(text).toContain('(showing 40 of 133 matching lines, shared over the 11 folders that hold them. Not shown:');
    // the folder holding the most unshown lines first
    const note = text.slice(text.indexOf('(showing 40'));
    expect(note.split('\n')[1]).toMatch(/^ {2}raw\/docs\/周报\/一部平台组: 2[01] more \(24 matches in 12 files\)$/);
    for (const d of DIVISIONS.slice(1)) expect(note).toMatch(new RegExp(`raw/docs/周报/${d}平台组: [89] more \\(12 matches in 12 files\\)`));
    // the monthly reports' one line is shown: nothing more to say of that folder
    expect(note).not.toContain('raw/docs/月报');
    expect(note).toContain('search it alone (`path`)');
    // a complete answer carries no note
    expect(grepWithContext(ctx, { pattern: '拉新', paths: ['raw/docs'], context: 1 })).not.toContain('showing');
    expect(grepCutNote(grepSearch(tmp, '拉新', { paths: ['raw/docs'] }))).toBe('');
  });

  it('answers the MCP tool with the matches alone when complete, and with where the rest are when cut', async () => {
    const tools = new Map<string, { schema: Record<string, z.ZodTypeAny>; handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }>();
    const fake = {
      registerTool: (name: string, config: { inputSchema: Record<string, z.ZodTypeAny> }, handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>) => {
        tools.set(name, { schema: config.inputSchema, handler });
      },
    } as unknown as McpServer;
    registerKnodeTools(fake, ctx);
    const call = async (args: Record<string, unknown>) => {
      const t = tools.get('knode_grep')!;
      return JSON.parse((await t.handler(z.object(t.schema).parse(args))).content[0].text);
    };
    expect(await call({ pattern: '拉新', path: 'raw/docs' })).toEqual([{ path: 'raw/docs/周报/一部增长组/w01.md', line: 2, text: '拉新 1200 人。' }]);

    const cut = await call({ pattern: '平台组', path: 'raw/docs', maxMatches: 40 });
    expect(cut.shown).toBe(40);
    expect(cut.total).toBe(133);
    expect(cut.matches).toHaveLength(40);
    expect(perFolder(cut.matches).size).toBe(11);
    expect(cut.more).toHaveLength(10);
    expect(cut.more[0]).toMatchObject({ folder: 'raw/docs/周报/一部平台组', matches: 24, files: 12 });
    expect(cut.more.reduce((n: number, f: { more: number }) => n + f.more, 0)).toBe(133 - 40);
    expect(cut.note).toContain('Search one folder alone');
  });
});

describe('shareEvenly', () => {
  it('meets the small amounts whole and splits the rest', () => {
    expect(shareEvenly([10, 1000, 1000], 1000)).toEqual([10, 495, 495]);
    expect(shareEvenly([3, 3, 3], 100)).toEqual([3, 3, 3]);
    expect(shareEvenly([5, 5, 5, 5], 2)).toEqual([0, 0, 1, 1]);
    expect(shareEvenly([], 10)).toEqual([]);
  });
});
