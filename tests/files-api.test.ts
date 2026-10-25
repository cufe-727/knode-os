import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { sanitizeRelativePath } from '../src/fs/files.js';
import { createApp } from '../src/server/app.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';
import { textPdf } from './helpers/pdf.js';

/** Folder creation and folder upload — the file-tree surface of the app. */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-files-api-'));
const root = path.join(tmp, 'data');
const workspaceDir = path.join(root, 'users', 'admin', 'workspaces', 'default');

const headers = {
  'x-knode-user': 'admin',
  'x-knode-workspace-kind': 'personal',
  'x-knode-workspace-id': 'default',
  'x-knode-workspace-name': 'Default',
};

const jsonHeaders = { ...headers, 'content-type': 'application/json' };

let rootCtx: AppContext;
let registry: WorkspaceContextRegistry;
let app: ReturnType<typeof createApp>;

const mkdir = (p: unknown) =>
  app.request('/api/mkdir', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ path: p }) });

const mv = (from: unknown, to: unknown) =>
  app.request('/api/mv', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ from, to }) });

const upload = (dir: string, files: [name: string, content: string][]) => {
  const form = new FormData();
  form.set('dir', dir);
  for (const [name, content] of files) form.append('files', new File([content], name));
  return app.request('/api/upload', { method: 'POST', headers, body: form });
};

beforeAll(async () => {
  rootCtx = await createContext(root);
  registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
  app = createApp(rootCtx, () => {}, registry);
  await app.request('/api/workspaces', { headers: { 'x-knode-user': 'admin' } });
});

afterAll(async () => {
  await registry.closeAll();
  await rootCtx.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('POST /api/mkdir', () => {
  it('creates a nested folder and lists it in the tree', async () => {
    const response = await mkdir('wiki/concepts/pricing/2026');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, path: 'wiki/concepts/pricing/2026' });
    expect(fs.existsSync(path.join(workspaceDir, 'wiki', 'concepts', 'pricing', '2026'))).toBe(true);

    const tree = await (await app.request('/api/tree?path=wiki/concepts', { headers })).json();
    expect(tree.children).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'pricing', kind: 'dir' })]),
    );
  });

  it('rejects read-only roots, the sidecar tree and empty paths', async () => {
    expect((await mkdir('ledger/mine')).status).toBe(400);
    expect((await mkdir('.sidecar/raw/docs/mine')).status).toBe(400);
    expect((await mkdir('raw/docs/.sidecar/mine')).status).toBe(400);
    expect((await mkdir('../escaped')).status).toBe(400);
    expect((await mkdir('  ')).status).toBe(400);
    expect((await mkdir(undefined)).status).toBe(400);
    expect(fs.existsSync(path.join(root, 'escaped'))).toBe(false);
    expect(fs.existsSync(path.join(workspaceDir, '..', 'escaped'))).toBe(false);
  });

  it('keeps traversal segments inside the writable root instead of escaping', async () => {
    const response = await mkdir('wiki/../../escaped');
    expect(await response.json()).toMatchObject({ path: 'wiki/escaped' });
    expect(fs.existsSync(path.join(workspaceDir, 'wiki', 'escaped'))).toBe(true);
    expect(fs.existsSync(path.join(workspaceDir, '..', 'escaped'))).toBe(false);
  });
});

describe('POST /api/upload', () => {
  it('recreates the folder subtree carried in the filenames', async () => {
    const response = await upload('raw/docs', [
      ['notes/2026/kickoff.md', '# Kickoff'],
      ['notes/assets/plan.txt', 'plan'],
    ]);
    expect(response.status).toBe(200);
    expect((await response.json()).saved).toEqual([
      'raw/docs/notes/2026/kickoff.md',
      'raw/docs/notes/assets/plan.txt',
    ]);
    expect(fs.readFileSync(path.join(workspaceDir, 'raw', 'docs', 'notes', '2026', 'kickoff.md'), 'utf8')).toBe('# Kickoff');
  });

  it('uploads into a nested destination directory', async () => {
    const response = await upload('wiki/concepts/pricing', [['tiers.md', '# Tiers']]);
    expect((await response.json()).saved).toEqual(['wiki/concepts/pricing/tiers.md']);
  });

  it('keeps traversal in names and destinations inside the writable root', async () => {
    const response = await upload('raw/docs/../..', [['../../purpose.md', 'overwritten']]);
    expect(response.status).toBe(200);
    expect((await response.json()).saved).toEqual(['raw/docs/purpose.md']);
    expect(fs.readFileSync(path.join(workspaceDir, 'purpose.md'), 'utf8')).not.toBe('overwritten');
  });

  it('refuses destinations outside raw/docs and wiki, and never lands inside the sidecar tree', async () => {
    expect((await upload('ledger', [['x.md', 'x']])).status).toBe(400);
    expect((await upload('.sidecar/raw/docs', [['x.md', 'x']])).status).toBe(400);
    expect((await upload('raw/docs/.sidecar', [['x.md', 'x']])).status).toBe(400);
    // a dropped folder that carries another workspace's sidecar tree: those entries are skipped, not written
    const response = await upload('raw/docs', [['.sidecar/raw/docs/a.md/tier1.json', '{}'], ['carried.md', '# Carried']]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, saved: ['raw/docs/carried.md'], skipped: ['.sidecar/raw/docs/a.md/tier1.json'] });
    expect(fs.existsSync(path.join(workspaceDir, 'raw', 'docs', '.sidecar'))).toBe(false);
  });

  it('never overwrites an existing file', async () => {
    const response = await upload('raw/docs', [['notes/2026/kickoff.md', '# Second']]);
    const [saved] = (await response.json()).saved;
    expect(saved).toMatch(/^raw\/docs\/notes\/2026\/kickoff-\d+\.md$/);
    expect(fs.readFileSync(path.join(workspaceDir, 'raw', 'docs', 'notes', '2026', 'kickoff.md'), 'utf8')).toBe('# Kickoff');
  });
});

describe('POST /api/mv', () => {
  it('moves a file into another writable folder, creating it on the way', async () => {
    await upload('raw/docs', [['loose.md', '# Loose']]);
    const response = await mv('raw/docs/loose.md', 'raw/docs/shujiu/loose.md');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, from: 'raw/docs/loose.md', to: 'raw/docs/shujiu/loose.md' });
    expect(fs.existsSync(path.join(workspaceDir, 'raw', 'docs', 'loose.md'))).toBe(false);
    expect(fs.readFileSync(path.join(workspaceDir, 'raw', 'docs', 'shujiu', 'loose.md'), 'utf8')).toBe('# Loose');
  });

  it('refuses to replace a file already sitting at the destination', async () => {
    await upload('raw/docs', [['clash.md', '# Newcomer']]);
    const response = await mv('raw/docs/clash.md', 'raw/docs/shujiu/loose.md');

    expect(response.status).toBe(409);
    // both sides survive: neither the mover nor the file it would have replaced
    expect(fs.readFileSync(path.join(workspaceDir, 'raw', 'docs', 'shujiu', 'loose.md'), 'utf8')).toBe('# Loose');
    expect(fs.existsSync(path.join(workspaceDir, 'raw', 'docs', 'clash.md'))).toBe(true);
  });

  it('reports a missing source instead of creating anything', async () => {
    const response = await mv('raw/docs/ghost.md', 'raw/docs/shujiu/ghost.md');
    expect(response.status).toBe(404);
    expect(fs.existsSync(path.join(workspaceDir, 'raw', 'docs', 'shujiu', 'ghost.md'))).toBe(false);
  });

  it('refuses read-only roots on either end', async () => {
    expect((await mv('raw/docs/clash.md', 'ledger/clash.md')).status).toBe(400);
    expect((await mv('raw/docs/clash.md', '.sidecar/raw/docs/clash.md')).status).toBe(400);
    expect((await mv('purpose.md', 'raw/docs/purpose.md')).status).toBe(400);
    expect(fs.existsSync(path.join(workspaceDir, 'raw', 'docs', 'clash.md'))).toBe(true);
  });

  it('refuses to move the writable roots themselves', async () => {
    // `wiki` and `raw/docs` pass the writable-path check, so only the root
    // guard keeps a rename from walking the whole tree away
    expect((await mv('wiki', 'raw/docs/wiki')).status).toBe(400);
    expect((await mv('raw/docs', 'wiki/docs')).status).toBe(400);
    expect((await mv('raw/docs/clash.md', 'purpose.md')).status).toBe(400);
    expect(fs.existsSync(path.join(workspaceDir, 'wiki'))).toBe(true);
    expect(fs.existsSync(path.join(workspaceDir, 'raw', 'docs'))).toBe(true);
  });

  it('keeps traversal inside the writable root instead of escaping it', async () => {
    const response = await mv('raw/docs/clash.md', 'raw/docs/../../escaped.md');
    expect(response.status).toBe(200);
    expect(fs.existsSync(path.join(workspaceDir, 'raw', 'docs', 'escaped.md'))).toBe(true);
    expect(fs.existsSync(path.join(workspaceDir, 'escaped.md'))).toBe(false);
  });
});

describe('derived text of converted originals', () => {
  const get = (url: string) => app.request(url, { headers });

  it('serves a PDF as the Markdown derived from it, keeps the sidecar tree out of the tree and grep', async () => {
    const form = new FormData();
    form.set('dir', 'raw/docs');
    form.append('files', new File([textPdf('Quarterly revenue increased by 42 percent.')], 'hello.pdf'));
    expect((await app.request('/api/upload', { method: 'POST', headers, body: form })).status).toBe(200);

    // nothing derived yet: the original is binary, so there is no text to show
    expect((await get('/api/file?path=raw/docs/hello.pdf')).status).toBe(404);

    const ingest = await app.request('/api/ingest', { method: 'POST', headers });
    expect(ingest.status).toBe(200);
    expect(fs.existsSync(path.join(workspaceDir, '.sidecar', 'raw', 'docs', 'hello.pdf', 'content.md'))).toBe(true);

    const file = await (await get('/api/file?path=raw/docs/hello.pdf')).json();
    expect(file).toMatchObject({ path: 'raw/docs/hello.pdf', derived: true });
    expect(file.content).toContain('Quarterly revenue increased by 42 percent.');
    const text = await (await get('/api/file?path=raw/docs/carried.md')).json();
    expect(text).toMatchObject({ derived: false, content: '# Carried' });

    const tree = await (await get('/api/tree')).json();
    expect(JSON.stringify(tree)).not.toContain('.sidecar');
    expect(JSON.stringify(tree)).not.toContain('cooked');

    const hits = await (await get('/api/grep?pattern=Quarterly')).json();
    expect(hits.map((h: { path: string }) => h.path)).toEqual(['raw/docs/hello.pdf']);
    expect(await (await get('/api/grep?pattern=contentSha256')).json()).toEqual([]);
    expect(await (await get('/api/grep?pattern=Quarterly&path=.sidecar')).json()).toEqual([]);
    expect((await (await get('/api/grep?pattern=Quarterly&path=raw/docs/hello.pdf')).json()).length).toBe(1);
  });

  it('refuses to write derived text back over the original, whatever the caller', async () => {
    const pdf = path.join(workspaceDir, 'raw', 'docs', 'hello.pdf');
    const before = fs.readFileSync(pdf);
    expect(before.subarray(0, 5).toString()).toBe('%PDF-');

    // the editor shows this file's derived Markdown; saving it would replace
    // the original's bytes with that text and lose the only copy
    const res = await app.request('/api/file', {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ path: 'raw/docs/hello.pdf', content: '# not a pdf\n' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/converted original/);
    expect(fs.readFileSync(pdf).equals(before)).toBe(true);

    // an ordinary text file under the same root is still writable
    const ok = await app.request('/api/file', {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ path: 'raw/docs/carried.md', content: '# Carried\n\nedited\n' }),
    });
    expect(ok.status).toBe(200);
  });
});

describe('preview cap', () => {
  const get = (url: string) => app.request(url, { headers });
  const big = `# Big\n\n${'x'.repeat(300 * 1024)}\n`;

  it('caps an unqualified read and serves the whole file when asked', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'raw', 'docs', 'big.md'), big);
    const onDisk = Buffer.byteLength(big);

    // default read stops at the preview cap and says so, so a client knows not
    // to round-trip it through an editor
    const capped = await (await get('/api/file?path=raw/docs/big.md')).json();
    expect(capped.truncated).toBe(true);
    expect(capped.bytes).toBe(onDisk);
    expect(Buffer.byteLength(capped.content)).toBeLessThan(onDisk);

    // asking for the whole file is what makes editing safe
    const full = await (await get('/api/file?path=raw/docs/big.md&maxBytes=4194304')).json();
    expect(full.truncated).toBe(false);
    expect(Buffer.byteLength(full.content)).toBe(onDisk);
  });
});

describe('sanitizeRelativePath', () => {
  it('strips traversal, separators, and empty segments', () => {
    expect(sanitizeRelativePath('notes/2026/kickoff.md')).toBe('notes/2026/kickoff.md');
    expect(sanitizeRelativePath('/leading//double/./a.md')).toBe('leading/double/a.md');
    expect(sanitizeRelativePath('..\\..\\windows\\a.md')).toBe('windows/a.md');
    expect(sanitizeRelativePath('../../..')).toBe('');
  });
});

describe('GET /api/tree', () => {
  it('lists the tree a level at a time, or the folders alone', async () => {
    expect((await mkdir('wiki/levels/pricing/2026')).status).toBe(200);
    fs.writeFileSync(path.join(workspaceDir, 'wiki', 'levels', 'pricing', 'notes.md'), '# notes\n');
    type Node = { path: string; kind: string; children?: Node[] };
    const get = async (query: string): Promise<Node> => (await app.request(`/api/tree?${query}`, { headers })).json();

    // one level: a subfolder comes back without children — not listed, which is not empty
    const level = await get('path=wiki/levels&depth=1');
    const pricing = level.children?.find((c) => c.path === 'wiki/levels/pricing');
    expect(pricing).toEqual({ name: 'pricing', path: 'wiki/levels/pricing', kind: 'dir' });
    expect((await get('path=wiki/levels/pricing&depth=1')).children?.map((c) => c.path))
      .toEqual(['wiki/levels/pricing/2026', 'wiki/levels/pricing/notes.md']);
    expect((await get('path=wiki/levels&depth=2')).children?.find((c) => c.path === 'wiki/levels/pricing')?.children?.length).toBe(2);
    // the workspace root, as the file tree opens it
    expect((await get('path=.&depth=1')).children?.map((c) => c.path)).toEqual(expect.arrayContaining(['raw', 'wiki']));
    // the folders alone, all the way down: what a destination picker offers
    const dirs = await get('path=wiki/levels&dirs=1');
    const flat = (n: Node): Node[] => [n, ...(n.children ?? []).flatMap(flat)];
    expect(flat(dirs).every((n) => n.kind === 'dir')).toBe(true);
    expect(flat(dirs).map((n) => n.path)).toEqual(expect.arrayContaining(['wiki/levels/pricing', 'wiki/levels/pricing/2026']));
    // without a depth, the whole subtree as before
    expect((await get('path=wiki/levels')).children?.find((c) => c.path === 'wiki/levels/pricing')?.children?.length).toBe(2);
    for (const bad of ['0', '-1', '1.5', 'deep']) expect((await app.request(`/api/tree?path=wiki&depth=${bad}`, { headers })).status, bad).toBe(400);
  });
});
