import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appendLog, initDataDir } from '../src/fs/datadir.js';
import { createContext } from '../src/context.js';
import { runIngest } from '../src/ingest/pipeline.js';
import { getObsidianVaultStatus } from '../src/obsidian/vault.js';
import {
  classifyOkfVersion,
  exportOkfBundle,
  extractMarkdownLinks,
  importOkfBundle,
  isGeneratedConcept,
  migrateWikiToOkf,
  readGeneratedAt,
  resolveOkfLink,
  validateOkfBundle,
} from '../src/okf/index.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-okf-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function minimalBundle(name: string): string {
  const root = path.join(tmp, name);
  write(root, 'index.md', '---\nokf_version: "0.1"\n---\n\n# Index\n\n* [Orders](tables/orders.md) - Orders table.\n');
  write(root, 'tables/orders.md', '---\ntype: Table\ntitle: Orders\ntags: [sales]\n---\n\n# Orders\n\nSee [Customers](/tables/customers.md).\n');
  write(root, 'tables/customers.md', '---\ntype: Table\ntitle: Customers\ncustom_extension: keep-me\n---\n\n# Customers\n');
  write(root, 'log.md', '# Directory Update Log\n\n## 2026-07-18\n\n* **Creation**: Created the bundle.\n');
  return root;
}

describe('OKF validation', () => {
  it('accepts a conformant bundle and reports its declared version', () => {
    const result = validateOkfBundle(minimalBundle('valid'));
    expect(result.valid).toBe(true);
    expect(result.version).toBe('0.1');
    expect(result).toMatchObject({ files: 4, concepts: 2, indexes: 1, logs: 1, errors: 0 });
    // a v0.1 bundle stays consumable; the older minor is a warning, not an error
    expect(result.diagnostics.map((d) => d.code)).toContain('legacy_version');
  });

  it('routes declared versions by major and minor (SPEC §12)', () => {
    expect(classifyOkfVersion(null)).toBe('undeclared');
    expect(classifyOkfVersion('0.2')).toBe('current');
    expect(classifyOkfVersion('0.1')).toBe('legacy-minor');
    expect(classifyOkfVersion('0.7')).toBe('newer-minor');
    expect(classifyOkfVersion('1.0')).toBe('unknown-major');
    expect(classifyOkfVersion('draft')).toBe('unknown-major');

    const root = path.join(tmp, 'future');
    write(root, 'index.md', '---\nokf_version: "9.0"\n---\n\n# Index\n');
    write(root, 'thing.md', '---\ntype: Concept\n---\n\n# Thing\n');
    const result = validateOkfBundle(root);
    expect(result.valid).toBe(true);
    expect(result.diagnostics.map((d) => d.code)).toContain('unknown_version');
  });

  it('warns on the v0.1 trust shapes it still accepts', () => {
    const root = path.join(tmp, 'trust');
    write(root, 'legacy.md', '---\ntype: Concept\ngenerated: true\ntimestamp: 2026-07-18T10:00:00Z\n---\n\n# Legacy\n');
    write(root, 'modern.md', '---\ntype: Concept\ngenerated: { at: 2026-07-18T10:00:00Z }\nstatus: retired\nverified: { by: human:me, at: nope }\n---\n\n# Modern\n');
    const result = validateOkfBundle(root);
    expect(result.valid).toBe(true);
    expect(result.diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining([
      'legacy_generated_flag', 'generated_by_missing', 'verified_at_not_iso8601', 'unknown_status',
    ]));
  });

  it('reads generated.at with a legacy timestamp fallback (SPEC §13.1)', () => {
    expect(readGeneratedAt({ generated: { by: 'knode-os/dream', at: '2026-09-01T00:00:00Z' } }))
      .toBe('2026-09-01T00:00:00Z');
    expect(readGeneratedAt({ timestamp: '2026-07-18T10:00:00Z' })).toBe('2026-07-18T10:00:00Z');
    expect(readGeneratedAt({ generated: true, timestamp: 'someday' })).toBeNull();
    expect(isGeneratedConcept({ generated: true })).toBe(true);
    expect(isGeneratedConcept({ generated: { by: 'human:me' } })).toBe(true);
    expect(isGeneratedConcept({ generated: { at: '2026-09-01T00:00:00Z' } })).toBe(false);
    expect(isGeneratedConcept({})).toBe(false);
  });

  it('rejects missing type/frontmatter and malformed reserved files', () => {
    const root = path.join(tmp, 'invalid');
    write(root, 'index.md', '---\ntitle: illegal below root\n---\n\nno heading\n');
    write(root, 'nested/index.md', '---\ntitle: Nested\n---\n\n# Nested\n');
    write(root, 'no-frontmatter.md', '# Plain\n');
    write(root, 'empty-type.md', '---\ntype: ""\n---\n\n# Empty\n');
    write(root, 'unterminated.md', '---\ntype: Concept\n# Missing closing delimiter\n');
    write(root, 'log.md', '# Log\n\n## July 18\n\n* entry\n');
    const result = validateOkfBundle(root);
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining([
      'index_structure', 'index_frontmatter', 'missing_frontmatter', 'missing_type', 'invalid_frontmatter', 'log_date',
    ]));
  });

  it('treats broken links and optional-field issues as soft warnings', () => {
    const root = path.join(tmp, 'warnings');
    write(root, 'thing.md', '---\ntype: Custom Future Type\ntags: not-a-list\ntimestamp: someday\nextra: preserved\n---\n\nSee [Future](/future.md).\n');
    const result = validateOkfBundle(root);
    expect(result.valid).toBe(true);
    expect(result.diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining([
      'tags_not_list', 'timestamp_not_iso8601', 'broken_link',
    ]));
  });
});

describe('OKF links', () => {
  it('extracts ordinary links but not images, wikilinks, code or external resolution', () => {
    const links = extractMarkdownLinks('[Orders](../tables/orders.md) ![img](x.png) [[Wiki]] `see [Code](code.md)`');
    expect(links).toEqual([{ label: 'Orders', href: '../tables/orders.md' }]);
    expect(resolveOkfLink('metrics/wau.md', '../tables/orders.md')).toBe('tables/orders.md');
    expect(resolveOkfLink('metrics/wau.md', '/tables/orders.md')).toBe('tables/orders.md');
    expect(resolveOkfLink('metrics/wau.md', 'https://example.com')).toBeNull();
  });
});

describe('native wiki OKF compatibility', () => {
  it('initializes a conformant native wiki and appends conformant logs', () => {
    const data = path.join(tmp, 'native');
    initDataDir(data);
    appendLog(data, 'wiki', 'created a concept');
    const result = validateOkfBundle(path.join(data, 'wiki'));
    expect(result.valid).toBe(true);
    expect(result.version).toBe('0.2');
    const log = fs.readFileSync(path.join(data, 'wiki/log.md'), 'utf8');
    expect(log).toMatch(/^## \d{4}-\d{2}-\d{2}$/m);
    expect(log).toContain('* **wiki**: created a concept');
  });

  it('migrates legacy knode-os anchors without dropping extension fields', () => {
    const data = path.join(tmp, 'legacy');
    initDataDir(data);
    write(data, 'wiki/index.md', '# Index\n\n- [Overview](overview.md)\n');
    write(data, 'wiki/overview.md', '# Overview\n\nLegacy text.\n');
    write(data, 'wiki/sources/index.md', '---\ntitle: Sources\ntype: source\ngenerated: true\n---\n\n# Sources\n');
    write(data, 'wiki/log.md', '# Operation log\n\n- 2026-07-18T10:00:00.000Z dream: kept detail\n');
    write(data, 'wiki/entities/acme.md', '---\ntype: entity\ntitle: Acme\ntimestamp: 2026-07-18T10:00:00.000Z\ngenerated: true\naliases: [acme-corp]\n---\n\n# Acme\n');
    write(data, 'wiki/entities/hand-written.md', '---\ntype: entity\ntimestamp: 2026-07-18T10:00:00.000Z\n---\n\n# Hand written\n');
    const migrated = migrateWikiToOkf(data);
    expect(migrated.changed).toEqual(expect.arrayContaining(['index.md', 'overview.md', 'sources/index.md', 'log.md', 'entities/acme.md']));
    expect(migrated.validation.valid).toBe(true);
    expect(fs.readFileSync(path.join(data, 'wiki/sources/index.md'), 'utf8')).not.toContain('generated: true');
    expect(fs.readFileSync(path.join(data, 'wiki/log.md'), 'utf8')).toContain('* **dream**: kept detail');

    // the root index moves to the version this build implements
    expect(fs.readFileSync(path.join(data, 'wiki/index.md'), 'utf8')).toContain('okf_version: "0.2"');
    // generated: true + timestamp folds into generated: { by, at }, extensions intact
    const acme = fs.readFileSync(path.join(data, 'wiki/entities/acme.md'), 'utf8');
    expect(acme).toContain('generated: { by: "knode-os/migrated", at: "2026-07-18T10:00:00.000Z" }');
    expect(acme).not.toContain('timestamp:');
    expect(acme).toContain('aliases: [acme-corp]');
    // a page nobody claimed to generate keeps its timestamp; we do not invent provenance
    expect(fs.readFileSync(path.join(data, 'wiki/entities/hand-written.md'), 'utf8')).toContain('timestamp: 2026-07-18T10:00:00.000Z');
    expect(migrated.changed).not.toContain('entities/hand-written.md');
  });
});

describe('OKF exchange', () => {
  it('imports without rewriting bundle files and refuses destination collisions', () => {
    const source = minimalBundle('exchange-source');
    write(source, 'attachments/diagram.png', 'not-a-real-png');
    const data = path.join(tmp, 'exchange-data');
    initDataDir(data);
    const result = importOkfBundle(data, source, { name: 'team' });
    expect(result).toMatchObject({ destination: 'raw/docs/okf/team', files: 5, concepts: 2, assets: 1 });
    expect(fs.readFileSync(path.join(data, 'raw/docs/okf/team/tables/customers.md'), 'utf8'))
      .toBe(fs.readFileSync(path.join(source, 'tables/customers.md'), 'utf8'));
    expect(getObsidianVaultStatus(path.join(data, 'raw/docs/okf/team')).ready).toBe(true);
    expect(fs.readFileSync(path.join(data, 'raw/docs/okf/team/attachments/diagram.png'), 'utf8')).toBe('not-a-real-png');
    expect(() => importOkfBundle(data, source, { name: 'team' })).toThrow(/already exists/);
  });

  it('exports only after validating the native wiki', () => {
    const data = path.join(tmp, 'export-data');
    initDataDir(data);
    write(data, 'wiki/attachments/diagram.png', 'not-a-real-png');
    const destination = path.join(tmp, 'exported');
    const result = exportOkfBundle(data, destination);
    expect(result.validation.valid).toBe(true);
    expect(validateOkfBundle(destination).valid).toBe(true);
    expect(getObsidianVaultStatus(destination).ready).toBe(true);
    expect(result.assets).toBe(1);
    expect(fs.readFileSync(path.join(destination, 'attachments/diagram.png'), 'utf8')).toBe('not-a-real-png');
    expect(fs.existsSync(path.join(destination, 'index.md'))).toBe(true);
  });

  it('ingests imported concepts and projects ordinary OKF links into the graph', async () => {
    const source = minimalBundle('graph-source');
    const data = path.join(tmp, 'graph-data');
    initDataDir(data);
    importOkfBundle(data, source, { name: 'graph' });
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
      expect(edges).toContainEqual({ source: 'Orders', target: 'Customers', type: 'links_to' });
    } finally {
      await ctx.store.close();
    }
  });
});
