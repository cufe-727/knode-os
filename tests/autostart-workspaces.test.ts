import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { autostartWorkspaces } from '../src/server/serve.js';
import type { WorkspaceScope } from '../src/server/workspaces.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-autostart-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function workspace(dir: string, config: unknown, name?: string): void {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, dir, 'knode.config.json'), JSON.stringify(config));
  if (name) fs.writeFileSync(path.join(root, dir, '.workspace.json'), JSON.stringify({ name }));
}

describe('workspaces opened at startup', () => {
  it('opens every workspace, since processing starts with the service in each one', async () => {
    workspace('users/ann/workspaces/notes', { ingest: { linkedFolders: [{ path: '/Users/ann/Notes' }] } }, 'Notes');
    // an old file's `autoStart: false` no longer keeps a workspace closed
    workspace('users/ann/workspaces/idle', { processing: { autoStart: false } }, 'Idle');
    workspace('users/bob/workspaces/default', {});
    workspace('teams/research', {});
    fs.symlinkSync('../users/ann/workspaces/notes', path.join(root, 'teams/shared-notes'));
    // a folder nothing made a workspace yet waits to be asked for
    fs.mkdirSync(path.join(root, 'users/bob/workspaces/empty'), { recursive: true });
    fs.mkdirSync(path.join(root, 'users/bob/workspaces/broken'), { recursive: true });
    fs.writeFileSync(path.join(root, 'users/bob/workspaces/broken/knode.config.json'), '{ not json');

    const opened: WorkspaceScope[] = [];
    const logs: string[] = [];
    autostartWorkspaces(root, { get: async (scope) => { opened.push(scope); return {} as never; } }, (msg) => logs.push(msg));
    await new Promise((resolve) => setImmediate(resolve));

    // a Team shared from a personal workspace is that workspace: it opens once, as the owner's
    expect(opened.map((s) => s.relativeDir).sort()).toEqual([
      'teams/research', 'users/ann/workspaces/idle', 'users/ann/workspaces/notes', 'users/bob/workspaces/broken', 'users/bob/workspaces/default',
    ]);
    expect(opened.find((s) => s.relativeDir === 'users/ann/workspaces/notes')).toMatchObject({ user: 'ann', kind: 'personal', id: 'notes', name: 'Notes' });
    // no manifest: named after its folder
    expect(opened.find((s) => s.relativeDir === 'users/bob/workspaces/default')).toMatchObject({ id: 'default' });
    expect(logs).toContain('[users/ann/workspaces/idle] opened at startup: processing starts with the service in every workspace');
  });
});
