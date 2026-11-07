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
  it('opens those that follow linked folders or start their processing on their own, and leaves the rest to be opened', async () => {
    workspace('users/ann/workspaces/notes', { ingest: { linkedFolders: [{ path: '/Users/ann/Notes' }] } }, 'Notes');
    workspace('users/ann/workspaces/shelf', { processing: { autoStart: true } }, 'Shelf');
    workspace('users/ann/workspaces/idle', { processing: { autoStart: false } }, 'Idle');
    workspace('users/bob/workspaces/default', {}, 'Default');
    workspace('teams/research', { processing: { autoStart: true } });
    workspace('teams/archive', { ingest: { linkedFolders: [] } });
    fs.mkdirSync(path.join(root, 'users/bob/workspaces/broken'), { recursive: true });
    fs.writeFileSync(path.join(root, 'users/bob/workspaces/broken/knode.config.json'), '{ not json');

    const opened: WorkspaceScope[] = [];
    const logs: string[] = [];
    autostartWorkspaces(root, { get: async (scope) => { opened.push(scope); return {} as never; } }, (msg) => logs.push(msg));
    await new Promise((resolve) => setImmediate(resolve));

    expect(opened.map((s) => s.relativeDir).sort()).toEqual(['teams/research', 'users/ann/workspaces/notes', 'users/ann/workspaces/shelf']);
    expect(logs).toContain('[users/ann/workspaces/shelf] opened at startup: its processing starts with the service');
    expect(logs).toContain('[users/ann/workspaces/notes] opened at startup: it follows linked folders, Feishu documents or agent conversations');
  });
});
