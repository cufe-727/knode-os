import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { extractObsidianLinks } from '../src/graph/wire.js';
import { runIngest } from '../src/ingest/pipeline.js';
import { getObsidianVaultStatus, initObsidianVault, OBSIDIAN_APP_CONFIG } from '../src/obsidian/vault.js';
import { linkedName, resolveKnowledgeLink } from '../src/obsidian/links.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-obsidian-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('Obsidian Vault initialization', () => {
  it('makes every native wiki directly openable as a standalone vault', () => {
    const data = path.join(tmp, 'native');
    const result = initDataDir(data);
    expect(result.created).toContain('wiki/.obsidian/app.json');
    expect(result.created).toContain('wiki/attachments/');
    expect(fs.existsSync(path.join(data, '.obsidian'))).toBe(false); // one vault, never nested vaults

    const vault = path.join(data, 'wiki');
    expect(getObsidianVaultStatus(vault).ready).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(vault, '.obsidian/app.json'), 'utf8'))).toEqual(OBSIDIAN_APP_CONFIG);
  });

  it('is idempotent and never overwrites existing user vault settings', () => {
    const vault = path.join(tmp, 'custom');
    write(vault, '.obsidian/app.json', '{"useMarkdownLinks":false,"custom":"keep"}\n');
    const first = initObsidianVault(vault);
    expect(first.created).not.toContain('.obsidian/app.json');
    expect(fs.readFileSync(path.join(vault, '.obsidian/app.json'), 'utf8')).toBe('{"useMarkdownLinks":false,"custom":"keep"}\n');
    expect(initObsidianVault(vault).created).toHaveLength(0);
    expect(getObsidianVaultStatus(vault).ready).toBe(true);
  });
});

describe('Obsidian link compatibility', () => {
  it('parses note links, aliases, headings, block references and embeds', () => {
    expect(extractObsidianLinks([
      '[[concepts/Knowledge Graph#Schema|Graph]]',
      '[[entities/PGlite#^facts]]',
      '![[attachments/diagram.png]]',
      '[[#Local heading]]',
    ].join('\n'))).toEqual([
      { target: 'concepts/Knowledge Graph', label: 'Graph', embed: false },
      { target: 'entities/PGlite', label: 'PGlite', embed: false },
      { target: 'attachments/diagram.png', label: 'diagram.png', embed: true },
    ]);
  });

  it('resolves generated links by relative path, shortest filename, title and alias', () => {
    const data = path.join(tmp, 'links');
    initDataDir(data);
    write(data, 'wiki/entities/original-post.md', [
      '---',
      'title: 原帖',
      'aliases: [Original Post]',
      '---',
      '# 原帖',
    ].join('\n'));
    write(data, 'wiki/concepts/Market.md', '# 市场\n');

    expect(resolveKnowledgeLink(data, 'wiki/index.md', 'overview.md')).toEqual({ path: 'wiki/overview.md', fragment: null });
    expect(resolveKnowledgeLink(data, 'wiki/index.md', 'Market')).toEqual({ path: 'wiki/concepts/Market.md', fragment: null });
    expect(resolveKnowledgeLink(data, 'wiki/index.md', '原帖')).toEqual({ path: 'wiki/entities/original-post.md', fragment: null });
    expect(resolveKnowledgeLink(data, 'wiki/index.md', 'Original Post#Details')).toEqual({ path: 'wiki/entities/original-post.md', fragment: 'Details' });
    expect(resolveKnowledgeLink(data, 'wiki/index.md', 'https://example.com')).toBeNull();
    expect(resolveKnowledgeLink(data, '../outside.md', '原帖')).toBeNull();
  });

  it('reads the name a link with no note behind it stands for, which may be an entity', () => {
    expect(linkedName(' 英伟达 ')).toBe('英伟达');
    expect(linkedName('英伟达.md#估值')).toBe('英伟达');
    expect(linkedName('%E8%8B%B1%E4%BC%9F%E8%BE%BE')).toBe('英伟达');
    // a folder names a note, and an external link nothing in the graph
    expect(linkedName('entities/英伟达')).toBe('');
    expect(linkedName('https://example.com')).toBe('');
    expect(linkedName('#估值')).toBe('');
  });

  it('resolves vault-root wikilinks in bodies and Properties to real concept titles', async () => {
    const data = path.join(tmp, 'graph');
    initDataDir(data);
    write(data, 'wiki/entities/target.md', [
      '---',
      'type: component',
      'title: Actual Target',
      'aliases: [Target]',
      '---',
      '',
      '# Actual Target',
      '',
      'The target component used by the source concept.',
    ].join('\n'));
    write(data, 'wiki/concepts/source.md', [
      '---',
      'type: concept',
      'title: Source Concept',
      'related: "[[entities/target]]"',
      '---',
      '',
      '# Source Concept',
      '',
      'See [[entities/target#Details|the target]].',
    ].join('\n'));

    const ctx = await createContext(data);
    try {
      await runIngest(ctx.store, ctx.config, ctx.embedder, ctx.llm, { llmGraph: false });
      const edges = await ctx.store.query<{ source: string; target: string; type: string }>(
        `SELECT s.name AS source, t.name AS target, r.type
         FROM relations r
         JOIN entities s ON s.id = r.source_id
         JOIN entities t ON t.id = r.target_id
         WHERE r.type = 'links_to'`,
      );
      expect(edges).toContainEqual({ source: 'Source Concept', target: 'Actual Target', type: 'links_to' });
    } finally {
      await ctx.store.close();
    }
  });
});
