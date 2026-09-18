import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadIntents } from '../src/compiler/intents.js';
import { loadRecipes } from '../src/compiler/recipes.js';
import { createContext } from '../src/context.js';
import { assertSupportedLayout, initDataDir, LegacyLayoutError } from '../src/fs/datadir.js';
import { assertSourcePath, cleanRelPath, isRootWritableFile, isWritablePath } from '../src/fs/files.js';
import { loadPlaybooks } from '../src/pack/playbook.js';

/** Data layout v3: playbooks/ holds the configuration, .sidecar/ the derived state, no cooked/ copies. */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-layout-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const PLAYBOOK = `---
type: playbook
appliesTo: organization
retrieval: { k: 4, mode: keyword }
---
Quote the latest close before anything else.
`;

const INTENT = `id: stock_analysis
title: 个股分析
match:
  keywords: ["分析"]
slots:
  - id: canonical_identity
    required: true
    fill: local
    from: [entity]
`;

describe('data layout v3', () => {
  it('refuses a pre-v3 data directory instead of mixing two layouts', async () => {
    for (const legacy of ['cooked', 'packs', 'capabilities', 'intents']) {
      const dir = path.join(tmp, `legacy-${legacy}`);
      fs.mkdirSync(path.join(dir, legacy), { recursive: true });
      expect(() => initDataDir(dir)).toThrow(LegacyLayoutError);
      expect(() => initDataDir(dir)).toThrow(`${legacy}/`);
      await expect(createContext(dir)).rejects.toThrow(LegacyLayoutError);
      // the guard fires before anything is created
      expect(fs.readdirSync(dir)).toEqual([legacy]);
    }
    const fresh = path.join(tmp, 'fresh');
    initDataDir(fresh);
    expect(() => assertSupportedLayout(fresh)).not.toThrow();
    expect(initDataDir(fresh).created).toHaveLength(0);
  });

  it('creates and discovers the merged playbooks/ configuration directory', () => {
    const dir = path.join(tmp, 'playbooks');
    const { created } = initDataDir(dir);
    expect(created).toEqual(expect.arrayContaining([
      'playbooks/packs/default.md',
      'playbooks/intents/entity-overview.yaml',
      'playbooks/capabilities/',
    ]));
    for (const legacy of ['cooked', 'packs', 'capabilities', 'intents']) expect(fs.existsSync(path.join(dir, legacy))).toBe(false);

    write(dir, 'playbooks/packs/organization.md', PLAYBOOK);
    write(dir, 'playbooks/intents/stock.yaml', INTENT);
    expect(loadPlaybooks(dir).map((p) => p.path)).toEqual(['playbooks/packs/default.md', 'playbooks/packs/organization.md']);
    expect(loadRecipes(dir).some((r) => JSON.stringify(r).includes('playbooks/packs/organization.md'))).toBe(true);
    expect(loadIntents(dir).map((i) => i.path)).toEqual(['playbooks/intents/entity-overview.yaml', 'playbooks/intents/stock.yaml']);
  });

  it('keeps external writes to wiki/, raw/docs/ and playbooks/packs/, never inside the sidecar tree', () => {
    expect(isWritablePath('wiki/concepts/x.md')).toBe(true);
    expect(isWritablePath('raw/docs/reports/a.pdf')).toBe(true);
    expect(isWritablePath('playbooks/packs/organization.md')).toBe(true);
    expect(isWritablePath('playbooks/capabilities/quotes.md')).toBe(false);
    expect(isWritablePath('playbooks/intents/stock.yaml')).toBe(false);
    expect(isWritablePath('.sidecar/raw/docs/a.md/content.md')).toBe(false);
    expect(isWritablePath('raw/docs/.sidecar/a.md')).toBe(false);
    expect(isWritablePath('cooked/docs/a.md')).toBe(false);
    expect(isWritablePath('ledger/events.jsonl')).toBe(false);
  });

  it('judges a path by where it lands, not how it is spelled', () => {
    // `wiki/../knode.config.json` stays inside the data dir, so safePath alone would allow it
    expect(isWritablePath('wiki/../knode.config.json')).toBe(false);
    expect(isWritablePath('wiki/../purpose.md')).toBe(false);
    expect(isWritablePath('raw/docs/../../ledger/events.jsonl')).toBe(false);
    expect(isWritablePath('wiki/concepts/../notes/x.md')).toBe(true);
    expect(isWritablePath('./wiki/x.md')).toBe(true);
    expect(isWritablePath('/wiki/x.md')).toBe(true);
    expect(isWritablePath('')).toBe(false);
    expect(isWritablePath('..')).toBe(false);
    // the guide is writable at the root, under any spelling, and is never a source
    expect(isWritablePath('AGENTS.md')).toBe(true);
    expect(isWritablePath('./CLAUDE.md')).toBe(true);
    expect(isRootWritableFile('wiki/../AGENTS.md')).toBe(true);
    expect(isRootWritableFile('wiki/AGENTS.md')).toBe(false);
    expect(() => assertSourcePath('wiki/../AGENTS.md')).toThrow(/guide, not a source/);
    expect(() => assertSourcePath('wiki/entities/x.md')).not.toThrow();
    expect(cleanRelPath('wiki/../AGENTS.md')).toBe('AGENTS.md');
    expect(cleanRelPath('wiki/')).toBe('wiki');
  });
});
