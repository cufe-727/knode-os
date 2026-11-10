import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityOf } from '../src/activity.js';
import { AppContext, createContext } from '../src/context.js';
import { grepFiles } from '../src/fs/files.js';
import { chunkCode } from '../src/ingest/chunker.js';
import { renderCard } from '../src/ingest/codebase/card.js';
import {
  addCodebase,
  assertFetchable,
  checkRef,
  codebaseCheckOwed,
  codebaseLinks,
  Codebases,
  describeCodebases,
  editCodebase,
  nextCodebaseCheck,
  planCodebase,
  removeCodebase,
  updateCodebases,
} from '../src/ingest/codebase/codebases.js';
import { codeLanguageOf, globToRegExp, isCodebaseFile, isRepoDoc, matchesAnyGlob, skipReason } from '../src/ingest/codebase/files.js';
import { parseRepoSpec } from '../src/ingest/codebase/git.js';
import { extractSymbols } from '../src/ingest/codebase/symbols.js';
import { assertNotLinked } from '../src/ingest/folders.js';
import { sync } from '../src/ingest/sync.js';
import { search } from '../src/search/search.js';
import { resolveScopeFilter } from '../src/store/resolver.js';
import { folderOf } from '../src/research/survey.js';
import { createApp, WorkspaceServices } from '../src/server/app.js';
import { tasksSnapshot } from '../src/server/tasks.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';

/**
 * Code repositories as a source (src/ingest/codebase, docs/design/25): which
 * files travel, how code is cut and found, the card, and add → update →
 * remove against a git repository made here.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-codebase-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(root: string, rel: string, content: string | Buffer): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_NOSYSTEM: '1', HOME: tmp },
  }).toString();
}

describe('which files of a repository travel', () => {
  it('knows languages by extension and by whole name', () => {
    expect(codeLanguageOf('src/agent/loop.rs')?.name).toBe('Rust');
    expect(codeLanguageOf('pkg/a.tsx')?.name).toBe('TypeScript');
    expect(codeLanguageOf('Dockerfile')?.kind).toBe('code');
    expect(codeLanguageOf('docs/guide.mdx')?.kind).toBe('prose');
    expect(codeLanguageOf('LICENSE')?.kind).toBe('prose');
    expect(codeLanguageOf('logo.png')).toBeNull();
    expect(codeLanguageOf('model.onnx')).toBeNull();
  });

  it('leaves dependencies, build output, lockfiles and generated files behind', () => {
    expect(skipReason('src/index.ts')).toBeNull();
    expect(skipReason('node_modules/x/index.js')).toBe('dependencies');
    expect(skipReason('packages/a/dist/index.js')).toBe('dependencies');
    expect(skipReason('.github/workflows/ci.yml')).toBe('hidden');
    expect(skipReason('pnpm-lock.yaml')).toBe('lockfile');
    expect(skipReason('Cargo.lock')).toBe('lockfile');
    expect(skipReason('web/app.min.js')).toBe('generated');
    expect(skipReason('api/v1/service.pb.go')).toBe('generated');
    expect(skipReason('assets/icon.png')).toBe('type');
    expect(isCodebaseFile('raw/codebase/repo/src/a.py')).toBe(true);
    expect(isCodebaseFile('raw/codebase/repo/vendor/a.py')).toBe(false);
    expect(isCodebaseFile('raw/codebase/loose.py')).toBe(false);
    expect(isCodebaseFile('raw/docs/a.py')).toBe(false);
  });

  it('matches gitignore-flavoured globs against files and the folders they sit in', () => {
    const src = [globToRegExp('src/**')];
    expect(matchesAnyGlob('src/a/b.ts', src)).toBe(true);
    expect(matchesAnyGlob('lib/src/b.ts', src)).toBe(false);
    const anywhere = [globToRegExp('tests')];
    expect(matchesAnyGlob('pkg/tests/x.py', anywhere)).toBe(true);
    expect(matchesAnyGlob('pkg/testsuite/x.py', anywhere)).toBe(false);
    const ext = [globToRegExp('*.md')];
    expect(matchesAnyGlob('docs/a/b.md', ext)).toBe(true);
    expect(matchesAnyGlob('docs/a/b.mdx', ext)).toBe(false);
    const anchored = [globToRegExp('/README.md')];
    expect(matchesAnyGlob('README.md', anchored)).toBe(true);
    expect(matchesAnyGlob('docs/README.md', anchored)).toBe(false);
  });
});

describe('reading a repository specification', () => {
  it('takes owner/repo, URLs and folders, and refuses unsafe transports and refs', () => {
    expect(parseRepoSpec('openai/codex', tmp)).toEqual({ url: 'https://github.com/openai/codex.git', name: 'openai-codex', web: 'https://github.com/openai/codex' });
    expect(parseRepoSpec('https://github.com/langchain-ai/deepagents/tree/main/libs', tmp).name).toBe('langchain-ai-deepagents');
    expect(parseRepoSpec('git@github.com:sst/opencode.git', tmp).web).toBe('https://github.com/sst/opencode');
    expect(() => assertFetchable('/Users/x/repo', false)).toThrow(/https or ssh/);
    expect(() => assertFetchable('ext::sh -c touch% /tmp/pwned', true)).toThrow(/not allowed/);
    expect(() => assertFetchable('https://github.com/a/b.git', false)).not.toThrow();
    expect(checkRef('main')).toBe('main');
    expect(checkRef('')).toBeUndefined();
    expect(() => checkRef('--upload-pack=evil')).toThrow();
    expect(() => checkRef('a..b')).toThrow();
  });
});

describe('the code map', () => {
  it('lists top-level definitions with their lines', () => {
    const ts = 'import x from "y";\nexport async function runAgent(task: string) {\n  return 1;\n}\nexport class Loop {\n}\nexport const tool = (a: number) => a;\ninterface Opts { a: 1 }\n';
    expect(extractSymbols(ts, 'TypeScript').map((s) => [s.kind, s.name, s.line])).toEqual([
      ['function', 'runAgent', 2], ['class', 'Loop', 5], ['function', 'tool', 7], ['type', 'Opts', 8],
    ]);
    const py = 'class Agent:\n    def run(self):\n        pass\n    def _hidden(self):\n        pass\n\nasync def main():\n    pass\nMAX_TURNS = 40\n';
    expect(extractSymbols(py, 'Python').map((s) => s.name)).toEqual(['Agent', 'run', 'main', 'MAX_TURNS']);
    const rs = 'pub struct Session {}\nimpl Session {\n    pub async fn submit(&self) {}\n}\nimpl Drop for Session {}\npub(crate) fn spawn() {}\n';
    expect(extractSymbols(rs, 'Rust').map((s) => s.name)).toEqual(['Session', 'Session', 'submit', 'Session', 'spawn']);
    const go = 'func (s *Server) Serve() error {\n}\ntype Tool interface {\n}\n';
    expect(extractSymbols(go, 'Go').map((s) => s.name)).toEqual(['Serve', 'Tool']);
  });
});

describe('cutting code', () => {
  it('cuts along definitions and heads every chunk with its file and enclosing definition', async () => {
    const body = Array.from({ length: 12 }, (_, i) => `export function step${i}(input: string): string {\n${'  const v = input.trim();\n'.repeat(20)}  return v;\n}\n`).join('\n');
    const pieces = await chunkCode('raw/codebase/demo/src/steps.ts', body, { chunkSize: 1000, chunkOverlap: 100 });
    expect(pieces.length).toBeGreaterThan(3);
    for (const p of pieces) expect(p.content.startsWith('File: demo/src/steps.ts (TypeScript)')).toBe(true);
    // a piece that opens a definition says nothing more; a cut inside one names it
    expect(pieces.some((p) => /\n\nexport function step\d/.test(p.content))).toBe(true);
    const inside = pieces.find((p) => p.content.includes(' — in export function'));
    if (inside) expect(inside.content.split('\n')[0]).toMatch(/— in export function step\d+\(input: string\): string/);
  });
});

describe('a repository from add to remove', () => {
  const repo = path.join(tmp, 'agent-harness');
  const data = path.join(tmp, 'data');
  let ctx: AppContext;

  beforeAll(async () => {
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '--quiet', '-b', 'main');
    write(repo, 'README.md', '# Agent Harness\n\n[![ci](https://x/badge.svg)](https://x)\n\nA tiny harness that runs a **tool loop** for coding agents.\n\n## Usage\n\nRun `harness`.\n');
    write(repo, 'package.json', JSON.stringify({ name: 'agent-harness', version: '0.1.0', description: 'tool loop for agents', bin: { harness: 'bin/harness.js' }, dependencies: { zod: '^4' } }));
    write(repo, 'src/loop.ts', 'import { callTool } from "./tools";\n\nexport async function runLoop(task: string): Promise<string> {\n  // the zebracorn marker\n  return callTool(task);\n}\n');
    write(repo, 'src/tools.ts', 'export function callTool(name: string): string {\n  return `ran ${name}`;\n}\n\nexport class ToolRegistry {\n}\n');
    write(repo, 'src/tools.test.ts', 'import { callTool } from "./tools";\ntest("x", () => callTool("a"));\n');
    write(repo, 'docs/design.md', '# Design of the loop\n\nThe loop calls tools until done.\n');
    write(repo, 'node_modules/zod/index.js', 'module.exports = {};\n');
    write(repo, 'package-lock.json', '{}\n');
    write(repo, 'dist/bundle.js', 'var a=1;\n');
    write(repo, 'assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    write(repo, 'src/minified.js', `${'x'.repeat(9000)}\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '--quiet', '-m', 'first');
    ctx = await createContext(data);
  });

  afterAll(async () => {
    await ctx.store.close();
  });

  it('tells documentation from the rest', () => {
    expect(isRepoDoc('README.md')).toBe(true);
    expect(isRepoDoc('AGENTS.md')).toBe(true);
    expect(isRepoDoc('docs/guide/tools.mdx')).toBe(true);
    expect(isRepoDoc('packages/web/src/content/docs/agents.mdx')).toBe(true);
    expect(isRepoDoc('CHANGELOG.md')).toBe(false);
    expect(isRepoDoc('LICENSE.md')).toBe(false);
    expect(isRepoDoc('src/notes.md')).toBe(false);
    expect(isRepoDoc('docs/conf.py')).toBe(false);
  });

  it('plans only what a reader of the code needs', () => {
    const { plan, skipped } = planCodebase(repo);
    expect(plan.files.map((f) => f.rel).sort()).toEqual(['README.md', 'docs/design.md', 'package.json', 'src/loop.ts', 'src/tools.test.ts', 'src/tools.ts']);
    expect(skipped.lockfile).toBe(1);
    expect(skipped.type).toBe(1);
    expect(skipped.generated).toBe(1);
    const narrowed = planCodebase(repo, { include: ['src/**'], exclude: ['*.test.ts'] });
    expect(narrowed.plan.files.map((f) => f.rel).sort()).toEqual(['src/loop.ts', 'src/tools.ts']);
  });

  it('adds it: files under raw/codebase, a card under raw/docs/codebase, both indexed', async () => {
    const r = await addCodebase(ctx, repo, { allowLocal: true, llmGraph: false, follow: true });
    expect(r.name).toBe('agent-harness');
    expect(r.dir).toBe('raw/codebase/agent-harness');
    expect(fs.existsSync(path.join(data, 'raw/codebase/agent-harness/src/loop.ts'))).toBe(true);
    expect(fs.existsSync(path.join(data, 'raw/codebase/agent-harness/node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(data, '.knode/codebases/agent-harness/.git'))).toBe(true);
    const card = fs.readFileSync(path.join(data, r.card), 'utf8');
    expect(card).toMatch(/^---\ntitle: "agent-harness"\ntype: repository\n/);
    expect(card).toContain(`commit: ${r.commit}`);
    expect(card).toContain('## Languages');
    expect(card).toContain('name `agent-harness`');
    expect(card).toContain('commands: `harness`');
    expect(card).toContain('[Design of the loop](raw/codebase/agent-harness/docs/design.md)');
    expect(card).toContain('function `export async function runLoop(task: string): Promise<string>` (line 3)');
    expect(card).toContain('## README (`README.md`)');
    expect(card).not.toContain('badge.svg');
    // the README's own headings sit under the card's
    expect(card).toContain('#### Usage');

    const rows = await ctx.store.query<{ path: string; root: string; title: string }>(`SELECT path, root, title FROM documents WHERE status = 'indexed' ORDER BY path`);
    const code = rows.filter((d) => d.root === 'codebase');
    expect(code.map((d) => d.path)).toContain('raw/codebase/agent-harness/src/loop.ts');
    expect(code.find((d) => d.path.endsWith('loop.ts'))?.title).toBe('agent-harness/src/loop.ts');
    expect(rows.find((d) => d.path === r.card)?.root).toBe('docs');
    // the documentation, as documents too: the README and docs/, not package.json or code
    expect(r.docs).toBe(2);
    expect(rows.filter((d) => d.path.startsWith('raw/docs/codebase/agent-harness/')).map((d) => [d.path, d.root])).toEqual([
      ['raw/docs/codebase/agent-harness/README.md', 'docs'],
      ['raw/docs/codebase/agent-harness/docs/design.md', 'docs'],
    ]);
    expect(codebaseLinks(ctx.config)[0]).toMatchObject({ name: 'agent-harness', follow: true, commit: r.commit });
  });

  it('keeps code out of a plain search and finds it when asked', async () => {
    const plain = await search(ctx.store, ctx.embedder, 'zebracorn', { mode: 'keyword', track: false });
    expect(plain.some((h) => h.path.startsWith('raw/codebase/'))).toBe(false);
    const asked = await search(ctx.store, ctx.embedder, 'zebracorn', { mode: 'keyword', track: false, filter: resolveScopeFilter({ kinds: ['code'] }) });
    expect(asked[0]?.path).toBe('raw/codebase/agent-harness/src/loop.ts');
    expect(asked[0]?.content.startsWith('File: agent-harness/src/loop.ts (TypeScript)')).toBe(true);
    const bySource = await search(ctx.store, ctx.embedder, 'zebracorn', { mode: 'keyword', track: false, filter: resolveScopeFilter({ sources: ['raw/codebase/agent-harness'] }) });
    expect(bySource.length).toBeGreaterThan(0);
    expect(grepFiles(data, 'zebracorn').map((m) => m.path)).toEqual(['raw/codebase/agent-harness/src/loop.ts']);
    expect(folderOf('raw/codebase/agent-harness/src/loop.ts')).toBe('raw/codebase/agent-harness');
  });

  it('refuses writes into the mirror and the card', () => {
    expect(() => assertNotLinked(ctx.config, 'raw/docs/codebase/agent-harness.md')).toThrow(/mirrored/);
    expect(() => assertNotLinked(ctx.config, 'raw/codebase/agent-harness/src/loop.ts')).toThrow(/mirrored/);
    expect(() => assertNotLinked(ctx.config, 'raw/docs/codebase/agent-harness/README.md')).toThrow(/mirrored/);
    expect(() => assertNotLinked(ctx.config, 'raw/docs/codebase')).toThrow(/unlink/);
  });

  it('updates to a new commit: changed files re-indexed, deleted ones disposed, nothing else touched', async () => {
    const unchanged = await updateCodebases(ctx, 'agent-harness', { llmGraph: false });
    expect(unchanged[0]).toMatchObject({ changed: false, sync: null });

    write(repo, 'src/loop.ts', 'export async function runLoop(task: string): Promise<string> {\n  // the quokkasaurus marker\n  return task;\n}\n');
    fs.rmSync(path.join(repo, 'src/tools.test.ts'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '--quiet', '-m', 'second');
    const [r] = await updateCodebases(ctx, 'agent-harness', { llmGraph: false });
    if ('error' in r) throw new Error(r.error);
    expect(r.changed).toBe(true);
    expect(r.copied).toEqual(['raw/codebase/agent-harness/src/loop.ts']);
    expect(r.removed).toEqual(['raw/codebase/agent-harness/src/tools.test.ts']);
    const live = await ctx.store.query<{ path: string }>(`SELECT path FROM documents WHERE status = 'indexed' AND root = 'codebase'`);
    expect(live.map((d) => d.path)).not.toContain('raw/codebase/agent-harness/src/tools.test.ts');
    const hits = await search(ctx.store, ctx.embedder, 'quokkasaurus', { mode: 'keyword', track: false, filter: resolveScopeFilter({ kinds: ['code'] }) });
    expect(hits[0]?.path).toBe('raw/codebase/agent-harness/src/loop.ts');
    expect(codebaseLinks(ctx.config)[0].commit).toBe(r.commit);
  });

  it('survives a full sync unchanged', async () => {
    const stats = await sync(ctx, { llmGraph: false });
    expect(stats.errors).toBe(0);
    const live = await ctx.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM documents WHERE status = 'indexed' AND root = 'codebase'`);
    expect(live[0].n).toBe(5);
  });

  it('applies an edit on the next update, and says when a daily check is owed', async () => {
    editCodebase(ctx, 'agent-harness', { exclude: ['docs'] });
    const [r] = await updateCodebases(ctx, 'agent-harness', { llmGraph: false });
    if ('error' in r) throw new Error(r.error);
    expect(r.removed).toEqual(['raw/codebase/agent-harness/docs/design.md']);
    expect(fs.existsSync(path.join(data, 'raw/docs/codebase/agent-harness/docs/design.md'))).toBe(false);
    expect(describeCodebases(ctx)[0]).toMatchObject({ name: 'agent-harness', files: 4 });
    const now = new Date();
    expect(codebaseCheckOwed({ ...ctx.config, ingest: { ...ctx.config.ingest, codebases: [{ ...codebaseLinks(ctx.config)[0], checkedAt: new Date(now.getTime() - 3 * 86400_000).toISOString() }] } }, now)).toBe(true);
    expect(codebaseCheckOwed(ctx.config, now)).toBe(false);
  });

  it('shows what serve fetches as codebase activity, failed when nothing came through', async () => {
    const codebases = new Codebases(ctx);
    const progress: string[] = [];
    const [r] = await codebases.update('agent-harness', { onProgress: (m) => progress.push(m) });
    if ('error' in r) throw new Error(r.error);
    expect(progress[0]).toMatch(/^fetching /);
    const last = () => activityOf(ctx.dataDir).snapshot().recent.find((a) => a.kind === 'codebase');
    expect(last()).toMatchObject({ label: 'agent-harness: fetching again from its repository', ok: true, detail: `unchanged at ${r.commit.slice(0, 12)}` });

    // a ref the remote lacks: the result still says why, and the activity ends failed
    editCodebase(ctx, 'agent-harness', { ref: 'no-such-branch' });
    const [bad] = await codebases.update('agent-harness', { onProgress: () => {} });
    expect('error' in bad).toBe(true);
    expect(last()).toMatchObject({ ok: false });
    expect(last()?.detail).toMatch(/^agent-harness: /);
    expect(codebases.busy).toBe(false);
    editCodebase(ctx, 'agent-harness', { ref: '' });
    expect(codebaseLinks(ctx.config)[0].ref).toBeUndefined();
  });

  it('reports the daily check in Tasks → Schedule, and fetches the followed ones when asked', async () => {
    const codebases = new Codebases(ctx);
    const services = { codebases } as unknown as WorkspaceServices;
    const row = async (s: WorkspaceServices | null = services) => (await tasksSnapshot(ctx, s)).scheduled.find((x) => x.id === 'codebases')!;
    const link = codebaseLinks(ctx.config)[0];
    expect(link.follow).toBe(true);
    // looked at just now: the next run is the next 05:00, the last one the entry's
    expect(await row()).toEqual({
      id: 'codebases', at: '05:00', everyMinutes: null, next: nextCodebaseCheck(ctx.config, new Date())!.toISOString(),
      last: link.checkedAt, enabled: true, running: false,
    });
    // outside serve nothing runs on a clock, though when it last looked still shows
    expect(await row(null)).toMatchObject({ next: null, last: link.checkedAt, enabled: false });

    const saved = ctx.config.ingest.codebases;
    try {
      // owed since a check was missed: due at once
      ctx.config.ingest.codebases = [{ ...link, checkedAt: new Date(Date.now() - 3 * 86400_000).toISOString() }];
      expect(Date.parse((await row()).next!)).toBeLessThanOrEqual(Date.now());
      ctx.config.ingest.codebaseCheckAt = '7:30';
      expect(await row()).toMatchObject({ at: '07:30', enabled: true });
      ctx.config.ingest.codebaseCheckAt = 'off';
      expect(await row()).toMatchObject({ at: null, next: null, enabled: false });
      delete ctx.config.ingest.codebaseCheckAt;
      // nothing followed: off, and no followed repository was looked at
      ctx.config.ingest.codebases = [{ ...link, follow: false }];
      expect(await row()).toMatchObject({ at: '05:00', next: null, last: null, enabled: false });
    } finally {
      ctx.config.ingest.codebases = saved;
      delete ctx.config.ingest.codebaseCheckAt;
    }

    // Check now: every followed repository, in the background, running until it ends
    const registry = { exists: () => true, get: async () => ctx } as unknown as WorkspaceContextRegistry;
    const app = createApp(ctx, () => {}, registry, { services: () => services });
    const check = () => app.request('/api/codebases/update', {
      method: 'POST',
      headers: { 'x-knode-user': 'admin', 'x-knode-workspace-kind': 'personal', 'x-knode-workspace-id': 'default', 'content-type': 'application/json' },
      body: JSON.stringify({ followed: true, wait: false }),
    });
    const res = await check();
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ started: true, repositories: 1, queued: false });
    expect(await row()).toMatchObject({ running: true });
    for (let i = 0; i < 200 && codebases.busy; i++) await new Promise((r) => setTimeout(r, 25));
    expect(await row()).toMatchObject({ running: false });
    expect(activityOf(ctx.dataDir).snapshot().recent.find((a) => a.kind === 'codebase')).toMatchObject({ label: 'Followed repositories: fetching again', ok: true });
    expect(Date.parse((await row()).last!)).toBeGreaterThan(Date.parse(link.checkedAt!));

    editCodebase(ctx, 'agent-harness', { follow: false });
    const none = await check();
    expect(none.status).toBe(200);
    expect(await none.json()).toMatchObject({ started: false, repositories: 0 });
    editCodebase(ctx, 'agent-harness', { follow: true });
    await codebases.stop();
    expect(codebases.nextCheck()).toBeNull();
  });

  it('removes it with its files, card, clone and documents', async () => {
    const r = await removeCodebase(ctx, 'agent-harness');
    expect(r.removedFiles).toBe(true);
    expect(fs.existsSync(path.join(data, 'raw/codebase/agent-harness'))).toBe(false);
    expect(fs.existsSync(path.join(data, 'raw/docs/codebase/agent-harness.md'))).toBe(false);
    expect(fs.existsSync(path.join(data, 'raw/docs/codebase/agent-harness'))).toBe(false);
    expect(fs.existsSync(path.join(data, '.knode/codebases/agent-harness'))).toBe(false);
    const live = await ctx.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM documents WHERE status = 'indexed' AND (root = 'codebase' OR path LIKE 'raw/docs/codebase/%')`);
    expect(live[0].n).toBe(0);
    expect(codebaseLinks(ctx.config)).toEqual([]);
  });

  it('renders the same card for the same commit', () => {
    const files = [{ rel: 'README.md', abs: path.join(repo, 'README.md'), bytes: 10 }];
    const input = { name: 'x', title: 'x', url: repo, web: null, ref: null, commit: 'abc', committedAt: '2026-11-01T00:00:00Z', subject: 's', files, skipped: {}, include: [], exclude: [] };
    expect(renderCard(input)).toBe(renderCard(input));
  });
});
