import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadIntents } from '../src/compiler/intents.js';
import { loadRecipes } from '../src/compiler/recipes.js';
import { createContext } from '../src/context.js';
import { assertSupportedLayout, initDataDir, isSeedTemplate, LegacyLayoutError } from '../src/fs/datadir.js';
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

/** schema.md as knode-os seeded it from 2026-09-12 to 2026-10-27, which workspaces of that time still hold. */
const SCHEMA_2026_09_12 = `# Wiki schema

Structural rules the wiki follows. Edit freely — generators respect this file.

## Page types

| directory        | type    | what goes here                          |
| ---------------- | ------- | --------------------------------------- |
| wiki/entities/   | entity  | people, orgs, products, components      |
| wiki/concepts/   | concept | theories, methods, designs, conventions |
| wiki/sources/    | source  | one summary page per raw document       |
| wiki/dreams/     | dream   | nightly trace-analysis reports          |

## Conventions

- The \`wiki/\` directory is an OKF v0.2 knowledge bundle and a standalone
  Obsidian Vault. Open that folder directly in Obsidian; Vault settings live
  in \`wiki/.obsidian/\`, and attachments go to \`wiki/attachments/\`.
- Every concept page starts with YAML frontmatter; \`type\` is required, while
  \`title\`, \`description\`, \`resource\`, and \`tags\` are recommended.
- Provenance and trust are optional frontmatter families: \`sources\`,
  \`generated: { by, at }\`, \`verified\`, \`status\`, \`stale_after\`. \`by\` is an
  actor: \`human:<id>\`, \`process:<id>\`, or \`<producer>/<version>\`. Generated
  pages carry \`generated\`; v0.1's bare \`timestamp\` is still read as a fallback.
- \`index.md\` and \`log.md\` are reserved OKF files. Only the root index may
  carry frontmatter, where it declares \`okf_version: "0.2"\`.
- Cross-reference with ordinary markdown links (OKF + Obsidian) or Obsidian
  \`[[wikilinks]]\`, aliases, heading/block links and embeds; all are understood
  by the knowledge graph.
- Relation types: related_to, part_of, uses, depends_on, works_at, authored,
  mentions, links_to (OKF markdown links).
`;

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

describe('seed files', () => {
  it('bring an unedited schema.md up to the current template and leave an edited one alone', () => {
    const fresh = path.join(tmp, 'seeds-fresh');
    initDataDir(fresh);
    const current = fs.readFileSync(path.join(fresh, 'schema.md'), 'utf8');
    expect(current).toContain('wiki/timelines/');

    const old = path.join(tmp, 'seeds-old');
    write(old, 'schema.md', SCHEMA_2026_09_12.replace(/\n/g, '\r\n'));
    expect(isSeedTemplate('schema.md', SCHEMA_2026_09_12)).toBe(true);
    expect(initDataDir(old).upgraded).toEqual(['schema.md']);
    expect(fs.readFileSync(path.join(old, 'schema.md'), 'utf8')).toBe(current);
    expect(initDataDir(old).upgraded).toEqual([]);

    const edited = path.join(tmp, 'seeds-edited');
    write(edited, 'schema.md', `${SCHEMA_2026_09_12}\n- Tickers are written as SH600000.\n`);
    expect(initDataDir(edited).upgraded).toEqual([]);
    expect(fs.readFileSync(path.join(edited, 'schema.md'), 'utf8')).toContain('SH600000');
  });
});

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
