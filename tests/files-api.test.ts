import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { sanitizeRelativePath } from '../src/fs/files.js';
import { createApp } from '../src/server/app.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';

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

  it('rejects read-only roots and empty paths', async () => {
    expect((await mkdir('cooked/docs/mine')).status).toBe(400);
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

  it('refuses destinations outside raw/docs and wiki', async () => {
    const response = await upload('cooked/docs', [['x.md', 'x']]);
    expect(response.status).toBe(400);
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
    expect((await mv('raw/docs/clash.md', 'cooked/docs/clash.md')).status).toBe(400);
    expect((await mv('purpose.md', 'raw/docs/purpose.md')).status).toBe(400);
    expect(fs.existsSync(path.join(workspaceDir, 'raw', 'docs', 'clash.md'))).toBe(true);
  });

  it('keeps traversal inside the writable root instead of escaping it', async () => {
    const response = await mv('raw/docs/clash.md', 'raw/docs/../../escaped.md');
    expect(response.status).toBe(200);
    expect(fs.existsSync(path.join(workspaceDir, 'raw', 'docs', 'escaped.md'))).toBe(true);
    expect(fs.existsSync(path.join(workspaceDir, 'escaped.md'))).toBe(false);
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
