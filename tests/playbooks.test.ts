import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { listPlaybooks, readPlaybook, resetPlaybook, savePlaybook } from '../src/fs/playbooks.js';
import { createApp } from '../src/server/app.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';

/** playbooks/ as Settings edits it, now that the file tree leaves the folder out. */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-playbooks-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('playbooks', () => {
  const dataDir = path.join(tmp, 'ws');
  beforeAll(() => {
    initDataDir(dataDir);
    fs.writeFileSync(path.join(dataDir, 'playbooks/concepts/frequent.yaml'), 'terms: []\n');
  });

  it('list every group, with the built-ins, the files edited elsewhere and the generated ones', () => {
    const groups = listPlaybooks(dataDir);
    expect(groups.map((g) => g.id)).toEqual(['research', 'phases', 'packs', 'intents', 'ontology', 'concepts', 'capabilities', 'chat', 'agents', 'profiles', 'sources']);
    const file = (rel: string) => groups.flatMap((g) => g.files).find((f) => f.path === rel);
    expect(file('playbooks/research/entity.md')).toMatchObject({ builtin: true, modified: false, readonly: false, managedIn: null });
    expect(file('playbooks/research/phases/plan.md')).toMatchObject({ builtin: true, modified: false });
    expect(file('playbooks/ontology/finance.yaml')).toMatchObject({ builtin: true });
    expect(file('playbooks/concepts/frequent.yaml')).toMatchObject({ builtin: false, readonly: true });
    expect(file('playbooks/chat/AGENTS.md')).toMatchObject({ managedIn: null, builtin: true });
    expect(file('playbooks/chat/turn.md')).toMatchObject({ managedIn: null, builtin: true });
    expect(groups.find((g) => g.id === 'agents')).toMatchObject({ managedIn: 'providers' });
    expect(groups.find((g) => g.id === 'agents')?.files.every((f) => f.managedIn === 'providers')).toBe(true);
    expect(groups.find((g) => g.id === 'capabilities')).toMatchObject({ managedIn: null, files: [] });
    // the research group is the folder's own files: its subfolders are groups of their own
    expect(groups.find((g) => g.id === 'research')?.files.some((f) => f.path.includes('/phases/') || f.path.includes('/profiles/'))).toBe(false);
  });

  it('save an edit, mark it modified, and reset it to the built-in', () => {
    const rel = 'playbooks/packs/default.md';
    const original = readPlaybook(dataDir, rel).text;
    const saved = savePlaybook(dataDir, rel, `${original}\n- Quote the latest close first.`);
    expect(saved).toMatchObject({ modified: true });
    expect(fs.readFileSync(path.join(dataDir, rel), 'utf8')).toMatch(/Quote the latest close first\.\n$/);
    const reset = resetPlaybook(dataDir, rel);
    expect(reset).toMatchObject({ modified: false });
    expect(reset.text).toBe(original);
  });

  it('refuse what would break a playbook, or is not one to edit here', () => {
    expect(() => savePlaybook(dataDir, 'playbooks/intents/entity-overview.yaml', 'slots: [unclosed\n')).toThrow(/does not parse as YAML/);
    expect(() => savePlaybook(dataDir, 'playbooks/research/entity.md', '# no frontmatter\n')).toThrow(/research-template/);
    expect(() => savePlaybook(dataDir, 'playbooks/agents/deep-agent.yaml', 'name: deep-agent\n')).toThrow(/own page/);
    expect(() => savePlaybook(dataDir, 'playbooks/concepts/frequent.yaml', 'terms: []\n')).toThrow(/regenerated/);
    expect(() => savePlaybook(dataDir, 'playbooks/packs/missing.md', '# x\n')).toThrow(/does not exist/);
    expect(() => resetPlaybook(dataDir, 'playbooks/concepts/frequent.yaml')).toThrow();
    for (const outside of ['wiki/index.md', 'playbooks/../knode.config.json', 'knode.config.json', 'playbooks/packs/.hidden.md']) {
      expect(() => readPlaybook(dataDir, outside), outside).toThrow(/not a playbook/);
    }
    // nothing was written by the refusals
    expect(readPlaybook(dataDir, 'playbooks/intents/entity-overview.yaml').modified).toBe(false);
  });
});

describe('/api/playbooks', () => {
  const root = path.join(tmp, 'server');
  const headers = { 'x-knode-user': 'admin', 'x-knode-workspace-kind': 'personal', 'x-knode-workspace-id': 'default', 'x-knode-workspace-name': 'Default' };
  const jsonHeaders = { ...headers, 'content-type': 'application/json' };
  let rootCtx: AppContext;
  let registry: WorkspaceContextRegistry;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    rootCtx = await createContext(root);
    registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
    app = createApp(rootCtx, () => {}, registry);
    await app.request('/api/workspaces', { headers: { 'x-knode-user': 'admin' } });
  });

  afterAll(async () => {
    await registry.closeAll();
    await rootCtx.store.close();
  });

  it('reads, saves and resets a playbook', async () => {
    const list = (await (await app.request('/api/playbooks', { headers })).json()) as { groups: { id: string; files: { path: string }[] }[] };
    expect(list.groups.find((g) => g.id === 'intents')?.files.map((f) => f.path)).toEqual(['playbooks/intents/entity-overview.yaml']);

    const rel = 'playbooks/chat/turn.md';
    const read = await app.request(`/api/playbooks/file?path=${encodeURIComponent(rel)}`, { headers });
    expect(read.status).toBe(200);
    const { text } = (await read.json()) as { text: string };
    const put = await app.request('/api/playbooks/file', { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ path: rel, text: `${text}\n<!-- house rule: answer in Chinese -->\n` }) });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ path: rel, modified: true });
    const bad = await app.request('/api/playbooks/file', { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ path: 'wiki/index.md', text: 'x' }) });
    expect(bad.status).toBe(400);
    const reset = await app.request(`/api/playbooks/file?path=${encodeURIComponent(rel)}`, { method: 'DELETE', headers });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ modified: false, text });
    expect((await app.request('/api/playbooks/file?path=wiki/index.md', { headers })).status).toBe(404);
  });
});
